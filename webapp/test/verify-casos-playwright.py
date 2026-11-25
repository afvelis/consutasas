import json, os, sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8000"
DIST = "http://localhost:8010"
os.environ.setdefault("LD_LIBRARY_PATH", "/home/avelis/lib-linux64/system-libs/")

HERE = os.path.dirname(os.path.abspath(__file__))
SNAP_DEV = os.path.normpath(os.path.join(HERE, os.pardir, "data", "rates.json"))
SNAP_DIST = os.path.normpath(os.path.join(HERE, os.pardir, "dist", "data", "rates.json"))

fails = []
def check(name, cond, detail=""):
    print(("  ✓ " if cond else "  ✗ ") + name + (f"  → {detail}" if (not cond and detail) else ""))
    if not cond: fails.append(name + (f" → {detail}" if detail else ""))

def chip_active(page):
    return page.eval_on_selector_all(
        "#casos-chips .chip-active", "els => els.map(e => e.dataset.pair)")

def mode_active(page):
    return page.eval_on_selector_all(
        "#casos-modos .mode-active", "els => els.map(e => e.dataset.modo)")

def result_text(page):
    return page.inner_text("#casos-resultado")

def esc_active(page, cont):
    return page.eval_on_selector_all(
        cont + " .mode-active", "els => els.map(e => e.dataset.scMode)")

def esc_buttons(page, cont):
    # 3f: cada botón de modo lleva SU tasa lateral dentro ("Máximo 3,50"):
    # devolvemos (nombre, texto completo, aria-label) para poder validar ambos.
    return page.eval_on_selector_all(
        cont + " [data-sc-mode]",
        "els => els.map(e => [e.textContent.trim(), e.getAttribute('aria-label') || ''])")

def panel_text(page):
    return page.inner_text("#casos-escenario")

def esc_modes_of(btns):
    return [b[0].split(' ')[0] for b in btns]

def esc_labels_of(btns, side, currency):
    return [b[1] for b in btns if side in b[1] and currency in b[1]]

def grid_cols(page, sel):
    col = page.eval_on_selector(sel, "e => getComputedStyle(e).gridTemplateColumns.trim()")
    return 0 if col == 'none' else len(col.split(' '))

def rect(page, sel):
    return page.eval_on_selector(sel, "e => { const r = e.getBoundingClientRect(); return { x: r.x, w: r.width, right: r.right, top: r.top }; }")

# ==================== modelo del snapshot (misma fórmula que el motor 3b) ====================
# Réplica en Python de CTEngine.caseQuoteScenario (assets/engine.js) con los ads que la
# app alimenta vía scenarioFx/adsArrOf (assets/app.js): el ORIGEN usa la lista `compra`
# (asc) y el DESTINO la lista `venta` (desc) de rates.json. Nada hardcodeado: el valor
# esperado se recalcula del snapshot vivo en cada corrida.

SYMBOLS = {"USD": "US$", "VES": "Bs", "PEN": "S/", "COP": "$", "CLP": "$", "MXN": "$", "EUR": "€"}

def _num(x):
    return x if isinstance(x, (int, float)) and not isinstance(x, bool) else None

def _fp(v):
    n = _num(v)
    return n if n is not None and n > 0 else None

def _r2(x):
    return round(x * 100) / 100

def fmt_app(v, code):
    """Réplica de fmtMoney (app.js): es-VE; 2 dec si |v|>=1000, si no 2..4 dec."""
    maxd = 2 if abs(float(v)) >= 1000 else 4
    s = f"{float(v):,.{maxd}f}"
    if "." in s:
        head, frac = s.split(".")
        frac = frac.rstrip("0") or "00"
        if len(frac) < 2: frac += "0"
        s = head.replace(",", ".") + "," + frac
    else:
        s = s.replace(",", ".") + ",00"
    return SYMBOLS.get(code, code) + " " + s

def fmt_rate4(v):
    """Réplica de fmt(v, 4) (app.js): es-VE, 2..4 decimales."""
    s = f"{float(v):,.4f}"
    head, frac = s.split(".")
    frac = frac.rstrip("0") or "00"
    if len(frac) < 2: frac += "0"
    return head.replace(",", ".") + "," + frac

def fmt_rate_btn(v):
    """Tasa lateral compacta del botón (3f): fmt(v, >=1000→2 dec, si no 4) —
    es-VE recorta ceros (mínimo 2 decimales)."""
    v = float(v)
    dec = 2 if abs(v) >= 1000 else 4
    s = f"{v:,.{dec}f}"
    head, frac = s.split(".")
    frac = frac.rstrip("0") or "00"
    if len(frac) < 2: frac += "0"
    return head.replace(",", ".") + "," + frac

def fmt2(v):
    """fmt(v, 2) (app.js): es-VE, 2 decimales fijos."""
    s = f"{float(v):,.2f}"
    return s.replace(",", "\x00").replace(".", ",").replace("\x00", ".")

def parse_cell(c):
    """Número es-VE ('1.235,2941') → float."""
    return float(str(c).replace(".", "").replace(",", "."))

class RatesModel:
    def __init__(self, rates):
        self.pairs = ((rates or {}).get("pairs")) or {}

    def media(self, code, side):
        p = self.pairs.get(code) or {}
        return _fp(p.get("compra")) if side == "compra" else _fp(p.get("venta"))

    def book(self, code, side):
        return [a for a in (((self.pairs.get(code) or {}).get("ads") or {}).get(side) or [])
                if _num(a.get("price")) is not None]

    BEST_REF_USD = 40.0

    def _executable(self, code, side, amount_usd):
        ads = self.book(code, side)
        ex = []
        for a in ads:
            price = _num(a.get("price"))
            avail = _fp(a.get("available"))
            if price is None or avail is None:
                continue
            cost = amount_usd * price
            lo, hi = _num(a.get("min")), _num(a.get("max"))
            if lo is not None and cost < lo: continue
            if hi is not None and cost > hi: continue
            if avail < amount_usd: continue
            ex.append(price)
        return ex

    def _ad_rate(self, code, side, amount_usd, mode):
        """adRateAt (3g): MAX/MIN/AVG sobre TODOS los anuncios del lado, SIN
        filtro de ejecutabilidad: max = mayor price; min = menor price;
        average = media aritmética de todos. best = mejor precio EJECUTABLE
        evaluado a 40 US$ equivalentes (compra min / venta max), independiente
        del monto del caso (queda entre MIN y MAX por construcción).
        Fallback: libro vacío → media FX; libro sin prices usables (acá no
        ocurre: book ya filtra price None) → media FX. MAX ≥ AVG ≥ MIN."""
        ads = self.book(code, side)
        media = self.media(code, side)
        if not ads:
            return media
        if mode == "best":
            # Criterio conservador (decisión del usuario tras 3g): compra = MAYOR
            # price ejecutable (pagar más); venta = MENOR (recibir menos). toca
            # cerca de MAX en compra y cerca de MIN en venta, dentro [MIN, MAX].
            ex = self._executable(code, side, self.BEST_REF_USD)
            if not ex:
                return None
            return max(ex) if side == "compra" else min(ex)
        if mode == "average":
            return sum(a["price"] for a in ads) / len(ads)
        if mode == "max":
            return max(a["price"] for a in ads)
        if mode == "min":
            return min(a["price"] for a in ads)
        raise AssertionError("modo desconocido: " + str(mode))


    def _rates(self, pair, direction, om, dm, amount_usd):
        """Pasada del motor: si un lado no tiene ad ejecutable el motor cae a la media
        en AMBOS lados (engine.js: if (!sOrig.originRate || !sDest.destRate))."""
        curA = pair[1] if direction == "BA" else pair[0]
        curB = pair[0] if direction == "BA" else pair[1]
        ro = self._ad_rate(curA, "compra", amount_usd, om) if curA != "USD" else 1.0
        rd = self._ad_rate(curB, "venta", amount_usd, dm) if curB != "USD" else 1.0
        if ro is None or rd is None:
            ro = self.media(curA, "compra") if curA != "USD" else 1.0
            rd = self.media(curB, "venta") if curB != "USD" else 1.0
        return ro, rd

    def quote(self, pair, direction, om, dm, deposit=None, target=None):
        """caseQuoteScenario (3e): om/dm = modo de la matriz (max/best/average/min,
        default best). Sin 2% en ningún lado (la seguridad ahora es la tasa
        manual). Dos pasadas de ads: pasada 1 con dep/rateOriginMedia y pasada 2
        con dep/rateOrigin (el motor solo sustituye si ambos lados dan tasa)."""
        origin = pair[1] if direction == "BA" else pair[0]
        dest = pair[0] if direction == "BA" else pair[1]
        comm = 0.08 if origin == "COP" else 0.07
        rate_origin_media = self.media(origin, "compra") if origin != "USD" else 1.0
        rate_dest_media = self.media(dest, "venta") if dest != "USD" else 1.0
        curA = pair[1] if direction == "BA" else pair[0]
        curB = pair[0] if direction == "BA" else pair[1]

        def raw_rates(base_usd):
            ro = self._ad_rate(curA, "compra", base_usd, om) if curA != "USD" else 1.0
            rd = self._ad_rate(curB, "venta", base_usd, dm) if curB != "USD" else 1.0
            return ro, rd

        def pass_rates(base_usd):
            ro, rd = raw_rates(base_usd)
            if ro is None or rd is None:
                ro = self.media(curA, "compra") if curA != "USD" else 1.0
                rd = self.media(curB, "venta") if curB != "USD" else 1.0
            return ro, rd

        dep = float(deposit) if (deposit is not None and float(deposit) > 0) else 10.0
        ro0, rd0 = pass_rates(dep / rate_origin_media)

        if target is not None:
            # INVERSO: pasada 1 con el monto de referencia, pasada 2 con el depósito derivado
            net_usd0 = target / rd0
            dep0 = _r2(net_usd0 / (1 - comm) * ro0)
            ro1, rd1 = raw_rates(dep0 / ro0)
            ro, rd = (ro1, rd1) if (ro1 is not None and rd1 is not None) else (ro0, rd0)
            gross_usd = (target / rd) / (1 - comm)
            return {"deposit": _r2(gross_usd * ro), "delivered": _r2(target),
                    "originRate": ro, "destRate": rd}

        # FORWARD: pasada 2 con el monto real (engine.js: amountUsd3 = deposit/rateOrigin);
        # si un lado no da tasa en la pasada 2 el motor conserva la pasada 1.
        ro2, rd2 = raw_rates(dep / ro0)
        ro, rd = (ro2, rd2) if (ro2 is not None and rd2 is not None) else (ro0, rd0)
        gross_usd = dep / ro
        net_usd = gross_usd * (1 - comm)
        delivered = _r2(net_usd * rd)
        return {"deposit": dep, "delivered": delivered, "originRate": ro, "destRate": rd}

def fmt_matriz(v, code):
    """fmt(v, dec(code)) del app (es-VE): max 4 decimales (2 para CLP), mínimo 2."""
    d = 2 if code == "CLP" else 4
    s = f"{float(v):,.{d}f}"
    head, frac = s.split(".")
    frac = frac.rstrip("0") or "00"
    if len(frac) < 2: frac += "0"
    return head.replace(",", ".") + "," + frac

def matriz_cell(model, code, side, mode):
    """Celda de la matriz 3g = TASA LATERAL del fiat/side elegido (sin comisión):
    réplica de matrizRate (tasas.js) = _ad_rate con fallback a la media FX."""
    r = model._ad_rate(code, side, 40.0, mode)
    if r is None:
        r = model.media(code, side)
    return fmt_matriz(r, code) if r is not None else None

MATRIZ_ROWS_3G = ["PEN/USD", "COP/USD", "CLP/USD", "MXN/USD"]
MATRIZ_MODES = ("max", "best", "average", "min")

def load_snapshot(path):
    with open(path, encoding="utf-8") as fh:
        return RatesModel(json.load(fh))

snap = load_snapshot(SNAP_DEV)
snap_dist = load_snapshot(SNAP_DIST)
PAIR = ["VES", "PEN"]            # chip VES/PEN + modo ba-fwd ⇒ el cliente deposita PEN
DIRECTION = "BA"

# Escenarios derivados del snapshot vivo (dev) — 3e: default Mejor/Mejor, sin 2%
EXP_BB   = snap.quote(PAIR, DIRECTION, "best", "best", deposit=100.0)      # default (Mejor/Mejor)
EXP_BMAX = snap.quote(PAIR, DIRECTION, "best", "max", deposit=100.0)       # destino “Máximo”
EXP_OMAX = snap.quote(PAIR, DIRECTION, "max", "best", deposit=100.0)       # origen “Máximo” (3h)
EXP_BAVG = snap.quote(PAIR, DIRECTION, "best", "average", deposit=100.0)   # destino “Promedio”
EXP_BMIN = snap.quote(PAIR, DIRECTION, "best", "min", deposit=100.0)       # destino “Mínimo”
EXPA_O   = snap.quote(PAIR, DIRECTION, "average", "average", deposit=100.0) # ambos lados “Promedio”
EXP_REV  = snap.quote(PAIR, DIRECTION, "best", "best", target=EXP_BB["delivered"])
VAL_BB   = fmt_app(EXP_BB["delivered"], "VES")
VAL_BMAX = fmt_app(EXP_BMAX["delivered"], "VES")
VAL_OMAX = fmt_app(EXP_OMAX["delivered"], "VES")
VAL_BAVG = fmt_app(EXP_BAVG["delivered"], "VES")
VAL_BMIN = fmt_app(EXP_BMIN["delivered"], "VES")
VAL_AVG_O = fmt_app(EXPA_O["delivered"], "VES")
VAL_REV_DEP = fmt_app(EXP_REV["deposit"], "PEN")
RATE4_O = fmt_rate4(EXP_BB["originRate"])
RATE4_D = fmt_rate4(EXP_BB["destRate"])
print(f"[snapshot] derived (dev, 100 PEN→VES best/best 3e): "
      f"delivered={EXP_BB['delivered']!r} → '{VAL_BB}' · ro={EXP_BB['originRate']} · rd={EXP_BB['destRate']}")
print(f"[snapshot] dest max={EXP_BMAX['delivered']!r} · dest avg={EXP_BAVG['delivered']!r} · "
      f"dest min={EXP_BMIN['delivered']!r} · avg/avg={EXPA_O['delivered']!r} · inverso target={EXP_BB['delivered']} → deposit={EXP_REV['deposit']!r} ('{VAL_REV_DEP}')")
# 3c: par SIN VES (PEN/COP, ba-fwd = COP→PEN): matriz Máximo/Mejor/Promedio/Mínimo, default Mejor, sin 2%
PAIR_NV = ["PEN", "COP"]
DIRECTION_NV = "BA"
EXP_MAX_NV = snap.quote(PAIR_NV, DIRECTION_NV, "max", "max", deposit=100.0)
VAL_MAX_NV = fmt_app(EXP_MAX_NV["delivered"], "PEN")
EXP_BEST_NV = snap.quote(PAIR_NV, DIRECTION_NV, "best", "best", deposit=100.0)
VAL_BEST_NV = fmt_app(EXP_BEST_NV["delivered"], "PEN")
# PEN→COP 100 (ab-fwd, el flujo del check 3c): cambiando a ab-fwd se cotiza en esa dirección
EXP_PC_BEST = snap.quote(["PEN", "COP"], "AB", "best", "best", deposit=100.0)
VAL_PC_BEST = fmt_app(EXP_PC_BEST["delivered"], "COP")
EXP_PC_MAX = snap.quote(["PEN", "COP"], "AB", "max", "max", deposit=100.0)
VAL_PC_MAX = fmt_app(EXP_PC_MAX["delivered"], "COP")
print(f"[snapshot] derived (dev, 100 COP→PEN max/max): delivered={EXP_MAX_NV['delivered']!r} → '{VAL_MAX_NV}' · "
      f"ro={EXP_MAX_NV['originRate']} · rd={EXP_MAX_NV['destRate']} · best/best='{VAL_BEST_NV}'")
# Reporte 3c: PEN→COP 100 (ab-fwd, compra PEN / venta COP) Mejor/Promedio/Máximo desde el snapshot vivo
EXP_PC = {}
for m in ("best", "average", "max"):
    EXP_PC[m] = snap.quote(["PEN", "COP"], "AB", m, m, deposit=100.0)
print("[snapshot] PEN→COP 100 (vivo): " + " · ".join(
    f"{m}: entregado={EXP_PC[m]['delivered']!r} ro={EXP_PC[m]['originRate']} rd={EXP_PC[m]['destRate']}"
    for m in ("best", "average", "max")))
NUM_BB = VAL_BB.split(" ", 1)[1]      # parte numérica (txt del desglose llega en MAYÚSCULAS vía CSS)
EXPC_D = snap_dist.quote(PAIR, DIRECTION, "best", "best", deposit=100.0)
VAL_BB_DIST = fmt_app(EXPC_D["delivered"], "VES")
print(f"[snapshot] derived (dist, 100 PEN→VES best/best): delivered={EXPC_D['delivered']!r} → '{VAL_BB_DIST}'")

# Coherencia del modelo con unitsPerUsdCompra/Venta del snapshot (sin hardcode):
# Mejor compra ≤ media compra y Mejor venta ≥ media venta (top del libro), sin 2%.
pen_media_c = snap.media("PEN", "compra")
ves_media_v = snap.media("VES", "venta")
pen_book_c = [a["price"] for a in snap.book("PEN", "compra")]
ves_book_v = [a["price"] for a in snap.book("VES", "venta")]
check("snapshot: PEN.ads.compra y VES.ads.venta vivos y cubriendo 100 PEN (~28 USDT)",
      bool(pen_book_c) and bool(ves_book_v) and _fp(pen_media_c) and _fp(ves_media_v),
      f"book_pen={len(pen_book_c)} book_ves={len(ves_book_v)}")

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context()
    page = ctx.new_page()
    console_errors, page_errors, failed_reqs = [], [], []
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: page_errors.append(str(e)))
    page.on("requestfailed", lambda r: failed_reqs.append(r.url + " " + str(r.failure)))
    page.on("response", lambda r: failed_reqs.append(f"{r.status} {r.url}") if r.status >= 400 else None)

    # ---------- 1) app completa, pestaña Casos ----------
    # ---------- 0) Modo UI: default web + toggle “Modo Phone” + persistencia ----------
    # web-first: sin localStorage ct_ui_mode la app arranca en modo web
    # (sin body.phone-mode); el botón #btn-ui-mode intercambia y persiste.
    page.goto(BASE + "/", wait_until="networkidle")
    check("ui-mode: default web (sin body.phone-mode, botón “Modo Phone”, aria-pressed=false, ct_ui_mode ausente)",
          page.evaluate("() => !document.body.classList.contains('phone-mode')") and
          page.eval_on_selector("#btn-ui-mode", "e => e.textContent") == "Modo Phone" and
          page.eval_on_selector("#btn-ui-mode", "e => e.getAttribute('aria-pressed')") == "false" and
          page.evaluate("() => localStorage.getItem('ct_ui_mode')") is None, "")
    # P2 ARIA del botón: nombre accesible = ACCIÓN coherente (a qué modo se salta).
    check("ui-mode: ARIA del botón coherente (aria-label = acción 'Cambiar a modo Phone' en web)",
          page.eval_on_selector("#btn-ui-mode", "e => e.getAttribute('aria-label')") == "Cambiar a modo Phone", "")
    check("ui-mode web: nav superior estática (no fixed-bottom) y sin padding de barra inferior en body",
          page.evaluate("getComputedStyle(document.querySelector('.bottomnav')).position") != "fixed" and
          page.evaluate("parseFloat(getComputedStyle(document.body).paddingBottom)") < 30,
          page.evaluate("getComputedStyle(document.querySelector('.bottomnav')).position"))
    page.click("#btn-ui-mode")
    page.wait_for_timeout(100)
    check("ui-mode: toggle → body.phone-mode, botón “Modo Web”, aria-pressed=true, ct_ui_mode='phone'",
          page.evaluate("() => document.body.classList.contains('phone-mode')") and
          page.eval_on_selector("#btn-ui-mode", "e => e.textContent") == "Modo Web" and
          page.eval_on_selector("#btn-ui-mode", "e => e.getAttribute('aria-pressed')") == "true" and
          page.eval_on_selector("#btn-ui-mode", "e => e.getAttribute('aria-label')") == "Cambiar a modo Web" and
          page.evaluate("() => localStorage.getItem('ct_ui_mode')") == "phone", "")
    page.reload(wait_until="networkidle")
    check("ui-mode: phone-mode persiste tras recargar (restaurado al init desde ct_ui_mode)",
          page.evaluate("() => document.body.classList.contains('phone-mode')") and
          page.eval_on_selector("#btn-ui-mode", "e => e.getAttribute('aria-pressed')") == "true", "")
    page.click("#btn-ui-mode")
    page.wait_for_timeout(100)
    check("ui-mode: segunda pulsación vuelve a web (clase fuera, botón “Modo Phone”, aria-pressed=false, ct_ui_mode='web')",
          page.evaluate("() => !document.body.classList.contains('phone-mode')") and
          page.eval_on_selector("#btn-ui-mode", "e => e.textContent") == "Modo Phone" and
          page.eval_on_selector("#btn-ui-mode", "e => e.getAttribute('aria-pressed')") == "false" and
          page.eval_on_selector("#btn-ui-mode", "e => e.getAttribute('aria-label')") == "Cambiar a modo Phone" and
          page.evaluate("() => localStorage.getItem('ct_ui_mode')") == "web", "")

    # P2: el toast se separa de la barra (24px web / 84px phone, sobre la nav fija).
    page.evaluate("() => CT.toast('prueba toast')")
    page.wait_for_timeout(100)
    check("toast: bottom 24px en modo web (separado de la barra, sin nav fija)",
          page.eval_on_selector("#toast", "e => getComputedStyle(e).bottom") == "24px",
          page.eval_on_selector("#toast", "e => getComputedStyle(e).bottom") if page.eval_on_selector("#toast", "e => !e.hidden") else "toast oculto/ausente")

    # ---------- 1) app completa, pestaña Casos ----------
    page.goto(BASE + "/", wait_until="networkidle")
    page.click("button[data-tab='casos']")
    page.wait_for_selector("#casos-chips .chip-active", timeout=10000)
    chips = chip_active(page); modos = mode_active(page)
    check("Casos: chip activo presente", chips == ["VES/PEN"], f"chips={chips}")
    check("Casos: modo activo presente (ba-fwd)", modos == ["ba-fwd"], f"modos={modos}")
    label = page.inner_text("#casos-monto-label")
    check("Casos: input dice 'Cliente deposita: PEN'", "Cliente deposita: PEN" in label, label)

    # click de par → modo por defecto coherente; click de modo → activo + recálculo
    page.click("#casos-chips [data-pair='PEN/COP']")
    check("click par PEN/COP → ba-fwd activo (Cliente deposita: COP)", mode_active(page) == ["ba-fwd"] and "Cliente deposita: COP" in page.inner_text("#casos-monto-label"))
    page.click("#casos-chips [data-pair='VES/PEN']")
    check("click par VES/PEN → ba-fwd por defecto", mode_active(page) == ["ba-fwd"])
    page.click("#casos-modos [data-modo='ba-fwd']")
    check("click modo ba-fwd → mode-active", mode_active(page) == ["ba-fwd"])

    # ---------- 1b) panel 3e: 8 botones (matriz), default “Mejor” ----------
    check("3e: panel de escenarios visible para VES/PEN", page.eval_on_selector("#casos-escenario-card", "e => !e.hidden"))
    ob = esc_buttons(page, "#casos-esc-origin"); db = esc_buttons(page, "#casos-esc-dest")
    check("3e: 8 botones (Compra=origen / Venta=destino × Máximo/Mejor/Promedio/Mínimo) — 3f compactos con tasa",
          esc_modes_of(ob) == ["Máximo", "Mejor", "Promedio", "Mínimo"] and esc_modes_of(db) == ["Máximo", "Mejor", "Promedio", "Mínimo"],
          f"origin={esc_modes_of(ob)} dest={esc_modes_of(db)}")
    # 3f: cada botón de modo lleva SU tasa lateral (compra origen / venta destino)
    # a 40 US$ eq (con fallback media FX si el modo no da tasa — nunca inventa).
    def lateral(model, code, side, mode):
        r = model._ad_rate(code, side, 40.0, mode)
        if r is None:
            r = model.media(code, side)
        return fmt_rate_btn(r) if r else None
    PEN_O = {m: lateral(snap, "PEN", "compra", m) for m in ("max", "best", "average", "min")}
    VES_D = {m: lateral(snap, "VES", "venta", m) for m in ("max", "best", "average", "min")}
    MODE_LBL = {"max": "Máximo", "best": "Mejor", "average": "Promedio", "min": "Mínimo"}
    def btn_texts(btns):
        return [b[0].replace("\n", " ").strip() for b in btns]
    check("3f: tasa lateral dentro de cada botón (compra origen PEN / venta destino VES, 40 US$ eq)",
          btn_texts(ob) == [f"{MODE_LBL[m]} {PEN_O[m]}" for m in ("max", "best", "average", "min")] and
          btn_texts(db) == [f"{MODE_LBL[m]} {VES_D[m]}" for m in ("max", "best", "average", "min")],
          f"origin={btn_texts(ob)} esperado={[f'{MODE_LBL[m]} {PEN_O[m]}' for m in ('max','best','average','min')]}")
    check("3f: aria-label de los botones declara el lado y la tasa (compra PEN … PEN/US$ · venta VES … VES/US$)",
          all(f"compra PEN {PEN_O[m]} PEN/US$" in b[1] for m, b in zip(("max", "best", "average", "min"), ob)) and
          all(f"venta VES {VES_D[m]} VES/US$" in b[1] for m, b in zip(("max", "best", "average", "min"), db)),
          str(ob[1][1] + " | " + db[0][1]))
    check("3e: default “Mejor” activo en ambos lados",
          esc_active(page, "#casos-esc-origin") == ["best"] and esc_active(page, "#casos-esc-dest") == ["best"],
          f"origin={esc_active(page, '#casos-esc-origin')} dest={esc_active(page, '#casos-esc-dest')}")
    check("3e: botones activos con aria-pressed=true (solo best)",
          page.eval_on_selector_all("#casos-esc-origin .mode-active, #casos-esc-dest .mode-active",
                                    "els => els.length === 2 && els.every(e => e.getAttribute('aria-pressed') === 'true' && e.dataset.scMode === 'best')"))

    # ---------- 2) PEN→Bs, 100 PEN ----------
    page.fill("#casos-monto", "100")
    page.wait_for_timeout(400)
    txt = result_text(page).upper()
    check("PEN→Bs 100: cliente deposita PEN 100,00", "CLIENTE DEPOSITA: PEN" in txt and "100,00" in txt, txt[:220].replace("\n", " | "))
    check(f"PEN→Bs 100: TÚ ENTREGAS Bs = {VAL_BB} (Mejor derivado del snapshot vivo, no inverso S/ 0,29)",
          ("TÚ ENTREGAS: VES" in txt) and (VAL_BB in page.inner_text("#casos-resultado")) and ("S/ 0,29" not in txt),
          txt[:400].replace("\n", " | | "))
    pt = panel_text(page)
    check(f"3e: panel muestra el Mejor derivado ({VAL_BB}) y tasa coherente ({RATE4_O} PEN / {RATE4_D} VES)",
          ("MONTO FINAL" in pt.upper()) and (VAL_BB in pt) and (fmt_rate4(EXP_BB["originRate"]) + " PEN / US$" in pt) and (fmt_rate4(EXP_BB["destRate"]) + " VES / US$" in pt),
          pt[:300].replace("\n", " | "))
    # coherencia del valor derivado con unitsPerUsdCompra/Venta del snapshot (sin 2%):
    check("3e: Mejor coherente con unitsPerUsdCompra[PEN]/unitsPerUsdVenta[VES] y el libro",
          EXP_BB["originRate"] <= pen_media_c + 1e-9 and EXP_BB["originRate"] >= min(pen_book_c) - 1e-9
          and EXP_BB["destRate"] >= ves_media_v - 1e-9 and EXP_BB["destRate"] <= max(ves_book_v) + 1e-9,
          f"ro={EXP_BB['originRate']} vs media {pen_media_c} (libro {min(pen_book_c)}..{max(pen_book_c)}) · "
          f"rd={EXP_BB['destRate']} vs media {ves_media_v} (libro {min(ves_book_v)}..{max(ves_book_v)})")
    check("3e: el 2% VES está eliminado del panel (ni “2% aplicado” ni “Sin 2%”)",
          "2%" not in pt.upper() and "APLICADO" not in pt.upper() and "SIN 2%" not in pt.upper(),
          pt[:300].replace("\n", " | "))
    check("desglose: nunca Bs como depósito en modo PEN→Bs",
          "CLIENTE DEPOSITA: PEN" in txt and "CLIENTE DEPOSITA: VES" not in txt and "CLIENTE DEPOSITA: BS" not in txt,
          txt[:220].replace("\n", " | "))
    check("tasa pactada presente", "TASA PACTADA" in txt)

    # ---------- 2b) 3e: cambiar destino/origen de la matriz recalcula desglose + panel ----------
    page.click("#casos-esc-dest [data-sc-mode='max']")
    page.wait_for_timeout(300)
    check(f"3g: destino “Máximo” (mayor price de todos los anuncios) → desglose {VAL_BMAX}",
          VAL_BMAX in result_text(page) and esc_active(page, "#casos-esc-dest") == ["max"],
          result_text(page)[:300].replace("\n", " | "))
    page.click("#casos-esc-dest [data-sc-mode='average']")
    page.wait_for_timeout(300)
    check(f"3e: destino “Promedio” → desglose {VAL_BAVG}",
          VAL_BAVG in result_text(page) and esc_active(page, "#casos-esc-dest") == ["average"],
          result_text(page)[:300].replace("\n", " | "))
    # Bug 3d + 3g: el Promedio es la MEDIA DE TODOS LOS ANUNCIOS (no la media FX)
    # y SIN aviso de libro (“adUsed null” no es fallback). En 3g el Máximo es el
    # MAYOR price de todos, así que MAX ≥ AVG por construcción.
    _amt = 100.0 / EXP_BB["originRate"]  # monto USD de la pasada 2 del motor (dep/ro0)
    _ex_avg = snap._ad_rate("VES", "venta", _amt, "average")
    _ex_max = snap._ad_rate("VES", "venta", _amt, "max")
    _ves_book_max = max(a["price"] for a in snap.book("VES", "venta"))
    check(f"3d: destino “Promedio” = media de anuncios ({_ex_avg:.4f}) ≠ media FX ({ves_media_v}) y Promedio ≤ max del libro",
          abs(EXP_BAVG["destRate"] - _ex_avg) < 1e-9
          and _ex_avg <= _ves_book_max, f"avg={EXP_BAVG['destRate']} media={ves_media_v} book_max={_ves_book_max}")
    check("3d: destino “Promedio” etiqueta “Promedio de anuncios” y SIN aviso de “no cubre el monto”",
          "PROMEDIO DE ANUNCIOS" in panel_text(page).upper()
          and "NO CUBRE EL MONTO" not in panel_text(page).upper(), panel_text(page)[:300].replace("\n", " | "))
    # 3d lado origen (PEN compra): Promedio = media de anuncios, coherente con
    # Mejor/Máximo y NO la media FX (que podía superar al Máximo).
    _o_best = snap._ad_rate("PEN", "compra", _amt, "best")
    _o_avg = snap._ad_rate("PEN", "compra", _amt, "average")
    _o_max = snap._ad_rate("PEN", "compra", _amt, "max")
    _o_min = snap._ad_rate("PEN", "compra", _amt, "min")
    check(f"3g: origen “Promedio” = media de TODOS los anuncios ({_o_avg:.4f}) ≠ media FX ({pen_media_c}) y MIN ≤ AVG ≤ MAX",
          abs(EXPA_O["originRate"] - _o_avg) < 1e-9 and _o_avg != pen_media_c
          and _o_min <= _o_avg <= _o_max, f"avg={EXPA_O['originRate']} media={pen_media_c} min={_o_min} max={_o_max}")
    check("3g: origen BEST independiente (40 US$ eq) queda entre MIN y MAX del libro (puede superar al Promedio de todos los ads: los más baratos pueden no ser ejecutables a 40 US$)",
          _o_min <= _o_best <= _o_max, f"min={_o_min} best={_o_best} max={_o_max}")
    page.click("#casos-esc-origin [data-sc-mode='average']")
    page.wait_for_timeout(300)
    check(f"3d: origen+destino “Promedio” → desglose {VAL_AVG_O}, dos etiquetas “Promedio de anuncios” y sin aviso de libro",
          VAL_AVG_O in result_text(page)
          and (panel_text(page).upper().count("PROMEDIO DE ANUNCIOS") == 2)
          and "NO CUBRE EL MONTO" not in panel_text(page).upper()
          and "SIN LIBRO" not in panel_text(page).upper(),
          (result_text(page) + " | " + panel_text(page))[:350].replace("\n", " | "))
    page.click("#casos-esc-origin [data-sc-mode='best']")
    page.wait_for_timeout(300)
    check(f"3e: origen “Mejor” de nuevo → desglose {VAL_BAVG} (dest sigue en Promedio)",
          VAL_BAVG in result_text(page) and esc_active(page, "#casos-esc-origin") == ["best"],
          result_text(page)[:300].replace("\n", " | "))
    page.click("#casos-esc-dest [data-sc-mode='min']")
    page.wait_for_timeout(300)
    check(f"3e: destino “Mínimo” → desglose {VAL_BMIN}",
          VAL_BMIN in result_text(page) and esc_active(page, "#casos-esc-dest") == ["min"],
          result_text(page)[:300].replace("\n", " | "))
    page.click("#casos-esc-dest [data-sc-mode='best']")
    page.wait_for_timeout(300)
    check(f"3e: vuelta al default Mejor/Mejor → desglose {VAL_BB}",
          VAL_BB in result_text(page) and esc_active(page, "#casos-esc-origin") == ["best"]
          and esc_active(page, "#casos-esc-dest") == ["best"])
    # 3g: Máximo = mayor price de todos los anuncios del lado; dentro del libro por definición.
    _ves_book_min = min(a["price"] for a in snap.book("VES", "venta"))
    check("3g: Máximo (mayor price de todos) queda dentro del rango del libro de venta VES",
          _ves_book_min <= _ex_max <= _ves_book_max, f"max={_ex_max} libro={_ves_book_min}..{_ves_book_max}")

    # Par SIN VES (PEN/COP, 3c): reset por par ⇒ default Mejor/Mejor; botones
    # Máximo/Mejor/Promedio/Mínimo (la matriz 3e, sin 2%).
    page.click("#casos-chips [data-pair='PEN/COP']")
    page.wait_for_timeout(300)
    obn = esc_buttons(page, "#casos-esc-origin"); dbn = esc_buttons(page, "#casos-esc-dest")
    check("3c: cambiar de par sin VES resetea a Mejor/Mejor con botones Máximo/Mejor/Promedio/Mínimo",
          esc_active(page, "#casos-esc-origin") == ["best"] and esc_active(page, "#casos-esc-dest") == ["best"]
          and esc_modes_of(obn) == ["Máximo", "Mejor", "Promedio", "Mínimo"] and esc_modes_of(dbn) == ["Máximo", "Mejor", "Promedio", "Mínimo"],
          f"origin={esc_active(page, '#casos-esc-origin')} dest={esc_active(page, '#casos-esc-dest')} ob={obn} db={dbn}")
    page.fill("#casos-monto", "100")
    page.wait_for_timeout(400)
    pt_nv = panel_text(page).upper()
    check("3c: par sin VES (COP→PEN) mejor/mejor ⇒ el 2% está eliminado del panel (nunca “Aplicado”)",
          "2%" not in pt_nv and "SIN 2%" not in pt_nv and "APLICADO" not in pt_nv, pt_nv[:300].replace("\n", " | "))
    check("3c: COP→PEN 100 mejor/mejor = valor derivado del snapshot vivo",
          VAL_BEST_NV in page.inner_text("#casos-resultado"),
          page.inner_text("#casos-resultado")[:300].replace("\n", " | "))
    # 3c: flujo PEN→COP 100 (ab-fwd): Mejor (default) y Máximo (mayor price, sin 2%)
    page.click("#casos-modos [data-modo='ab-fwd']")
    page.wait_for_timeout(300)
    check("3c: modo ab-fwd activo (PEN→COP) conservando Mejor/Mejor por defecto",
          mode_active(page) == ["ab-fwd"] and esc_active(page, "#casos-esc-origin") == ["best"]
          and esc_active(page, "#casos-esc-dest") == ["best"])
    page.wait_for_timeout(300)
    check(f"3c: PEN→COP 100 Mejor/Mejor = {VAL_PC_BEST} (derivado del snapshot vivo)",
          VAL_PC_BEST in page.inner_text("#casos-resultado"),
          page.inner_text("#casos-resultado")[:300].replace("\n", " | "))
    page.click("#casos-esc-origin [data-sc-mode='max']")
    page.click("#casos-esc-dest [data-sc-mode='max']")
    page.wait_for_timeout(400)
    RATE4_O_PC = fmt_rate4(EXP_PC_MAX["originRate"])
    RATE4_D_PC = fmt_rate4(EXP_PC_MAX["destRate"])
    check(f"3c: PEN→COP 100 Máximo/Máximo = {VAL_PC_MAX} y tasas {RATE4_O_PC} PEN/US$ × {RATE4_D_PC} COP/US$ (derivado, sin 2%)",
          esc_active(page, "#casos-esc-origin") == ["max"] and esc_active(page, "#casos-esc-dest") == ["max"]
          and VAL_PC_MAX in page.inner_text("#casos-resultado")
          and RATE4_O_PC + " PEN / US$" in panel_text(page)
          and RATE4_D_PC + " COP / US$" in panel_text(page)
          and "2%" not in panel_text(page).upper(),
          (result_text(page) + panel_text(page))[:350].replace("\n", " | "))
    check("3c: el anuncio Máximo de compra supera al Mejor en el snapshot vivo (escenario distinguible)",
          EXP_PC_MAX["originRate"] > EXP_PC_BEST["originRate"],
          f"max={EXP_PC_MAX['originRate']} best={EXP_PC_BEST['originRate']}")
    page.click("#casos-chips [data-pair='VES/PEN']")
    page.wait_for_timeout(300)
    page.fill("#casos-monto", "100")
    page.wait_for_timeout(400)
    check("3e: volver a VES/PEN restaura Mejor/Mejor (8 botones) y el valor derivado",
          esc_active(page, "#casos-esc-origin") == ["best"] and esc_active(page, "#casos-esc-dest") == ["best"]
          and esc_modes_of(esc_buttons(page, "#casos-esc-origin")) == ["Máximo", "Mejor", "Promedio", "Mínimo"]
          and VAL_BB in result_text(page),
          f"origin={esc_active(page, '#casos-esc-origin')} ob={esc_modes_of(esc_buttons(page, '#casos-esc-origin'))}")

    # ---------- 2b-3f) LIVE manual: escribir la tasa manual repinta al instante ----------
    _sysO = snap._ad_rate("PEN", "compra", 40.0, "best")
    _destBest = snap._ad_rate("VES", "venta", 40.0, "best")
    _manual_rate = round(_sysO * 0.98, 2)  # manual < sistema → factor positivo (descuento)
    _manual_delivered = fmt_app(_r2((100 / _manual_rate) * (1 - 0.07) * _destBest), "VES")
    res_before_manual = page.inner_text("#casos-resultado")
    page.fill("#casos-esc-origin-manual", str(_manual_rate))
    page.wait_for_timeout(250)
    _factor = ((_sysO - _manual_rate) / _sysO) * 100
    check(f"3f live: escribir manual compra {_manual_rate} repinta desglose y factor al instante (sin pulsar nada)",
          page.inner_text("#casos-resultado") != res_before_manual and
          VAL_BB not in page.inner_text("#casos-resultado") and
          _manual_delivered in page.inner_text("#casos-resultado") and
          "manual (manda la tasa ingresada)" in panel_text(page) and
          fmt2(_factor) in panel_text(page),
          (result_text(page)[:260] + " || " + panel_text(page)[:260]).replace("\n", " | "))
    page.fill("#casos-esc-origin-manual", "")
    page.wait_for_timeout(250)
    check("3f live: limpiar la manual repinta el desglose al valor del sistema al instante",
          VAL_BB in result_text(page) and "manual (manda la tasa ingresada)" not in panel_text(page),
          result_text(page)[:200].replace("\n", " | "))

    # ---------- 3h) exclusión mutua: tasa manual ↔ modo (MAX/BEST/AVG/MIN) ----------
    page.fill("#casos-esc-origin-manual", str(_manual_rate))
    page.wait_for_timeout(300)
    check("3h: escribir manual origen deselecciona los presets de ese lado (0 activos, aria-pressed=false ×4)",
          page.eval_on_selector_all("#casos-esc-origin .mode-active", "els => els.map(e => e.dataset.scMode)") == [] and
          page.eval_on_selector_all("#casos-esc-origin [data-sc-mode]", "els => els.map(e => e.getAttribute('aria-pressed'))") == ["false"] * 4,
          str(page.eval_on_selector_all("#casos-esc-origin [data-sc-mode]", "els => els.map(e => e.getAttribute('aria-pressed'))")))
    check("3h: la manual origen no toca el lado destino (Mejor sigue activo) y el factor sigue visible",
          esc_active(page, "#casos-esc-dest") == ["best"] and fmt2(_factor) in panel_text(page),
          panel_text(page)[:200])
    stored_3h = page.evaluate("() => ({ l: localStorage.getItem('ct_caso'), s: sessionStorage.getItem('ct_caso') })")
    caso_3h = json.loads(stored_3h["l"] or stored_3h["s"] or "null") or {}
    check("3h: la manual persiste en ct_caso sin que el modo la pise (modo último " + "best retenido)",
          caso_3h.get("scOriginManual") == _manual_rate and caso_3h.get("scOriginMode") == "best" and
          caso_3h.get("scDestManual") is None, json.dumps(caso_3h)[:160])
    page.click("#casos-esc-origin [data-sc-mode='max']")
    page.wait_for_timeout(300)
    check("3h: click en Máximo limpia el input manual, selecciona el modo y recalcula el desglose (valor Máximo)",
          page.input_value("#casos-esc-origin-manual") == "" and esc_active(page, "#casos-esc-origin") == ["max"] and
          VAL_OMAX in result_text(page) and "manual (manda la tasa ingresada)" not in panel_text(page),
          (result_text(page)[:200] + " || " + panel_text(page)[:200]).replace("\n", " | "))
    stored_3h2 = page.evaluate("() => ({ l: localStorage.getItem('ct_caso'), s: sessionStorage.getItem('ct_caso') })")
    caso_3h2 = json.loads(stored_3h2["l"] or stored_3h2["s"] or "null") or {}
    check("3h: el click en el preset persiste manual=null y modo=max en ct_caso",
          caso_3h2.get("scOriginManual") is None and caso_3h2.get("scOriginMode") == "max",
          json.dumps(caso_3h2)[:160])
    page.fill("#casos-esc-origin-manual", str(_manual_rate))
    page.wait_for_timeout(300)
    check("3h: manual de nuevo → Máximo deseleccionado otra vez (el modo guardado no se pisa)",
          page.eval_on_selector_all("#casos-esc-origin .mode-active", "els => els.map(e => e.dataset.scMode)") == [])
    page.fill("#casos-esc-origin-manual", "")
    page.wait_for_timeout(300)
    check("3h: borrar la manual vuelve al modo último (Máximo activo) y al valor Máximo del desglose",
          esc_active(page, "#casos-esc-origin") == ["max"] and VAL_OMAX in result_text(page),
          result_text(page)[:200])
    # Lado destino independiente: manual destino deselección SOLO destino.
    page.fill("#casos-esc-dest-manual", "1070")
    page.wait_for_timeout(300)
    check("3h: manual destino deselecciona presets destino; origen sigue en Máximo",
          page.eval_on_selector_all("#casos-esc-dest .mode-active", "els => els.map(e => e.dataset.scMode)") == [] and
          esc_active(page, "#casos-esc-origin") == ["max"], "")
    page.click("#casos-esc-dest [data-sc-mode='best']")
    page.wait_for_timeout(300)
    check("3h: click en Mejor destino limpia la manual destino y activa Mejor (origen intacto en Máximo)",
          page.input_value("#casos-esc-dest-manual") == "" and esc_active(page, "#casos-esc-dest") == ["best"] and
          esc_active(page, "#casos-esc-origin") == ["max"] and VAL_OMAX in result_text(page),
          result_text(page)[:200])
    page.click("#casos-esc-origin [data-sc-mode='best']")
    page.wait_for_timeout(300)
    check("3h: vuelta a Mejor/Mejor restaura el desglose base",
          esc_active(page, "#casos-esc-origin") == ["best"] and esc_active(page, "#casos-esc-dest") == ["best"] and
          VAL_BB in result_text(page), result_text(page)[:200])
    # 3h P1-fix: con #casos-monto vacío la exclusión mutua sigue operando
    # (el sync manual va en renderResultadoSafe, que corre con monto vacío).
    page.fill("#casos-monto", "")
    page.wait_for_timeout(200)
    page.fill("#casos-esc-origin-manual", str(_manual_rate))
    page.wait_for_timeout(300)
    check("3h monto vacío: escribir manual deselecciona presets (0 activos) y persiste la manual",
          page.eval_on_selector_all("#casos-esc-origin .mode-active", "els => els.map(e => e.dataset.scMode)") == [] and
          (lambda s: (json.loads(s or "null") or {}).get("scOriginManual") == _manual_rate)(page.evaluate("() => localStorage.getItem('ct_caso') || sessionStorage.getItem('ct_caso')")), "")
    page.fill("#casos-esc-origin-manual", "")
    page.wait_for_timeout(300)
    check("3h monto vacío: borrar la manual reactiva el modo retenido (Mejor activo, manual null)",
          esc_active(page, "#casos-esc-origin") == ["best"] and
          '"scOriginManual":null' in (page.evaluate("() => localStorage.getItem('ct_caso') || sessionStorage.getItem('ct_caso')") or ""), "")
    page.fill("#casos-monto", "100")
    page.wait_for_timeout(300)

    # ---------- 2b-3f) Detalle discreto + layout ----------
    # ---------- 2b-3f) Detalle discreto + layout (WEB es la base; 1280 default) ----------
    check("3f: el párrafo largo va dentro de <details><summary>Detalle</summary> (no siempre visible)",
          page.eval_on_selector_all("#casos-escenario-card details.hint-details",
                                    "els => els.map(e => e.querySelector('summary').textContent.trim())") == ["Detalle"] and
          "Matriz por lado" in page.eval_on_selector("#casos-escenario-card details.hint-details", "e => e.textContent"), "")
    # WEB (modo default, sin phone-mode): main ancho 1280, nav superior y inputs
    # usables; sin scroll horizontal de página.
    check("3f layout web@1280: main centrado max-width 1280px y sin scroll horizontal",
          page.evaluate("getComputedStyle(document.querySelector('main')).maxWidth") == "1280px" and
          page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"),
          page.evaluate("getComputedStyle(document.querySelector('main')).maxWidth"))
    check("3f layout web@1280: inputs del caso usables (max-width 480px, no los 220 del modo phone)",
          page.evaluate("getComputedStyle(document.getElementById('casos-monto')).maxWidth") == "480px" and
          page.evaluate("getComputedStyle(document.getElementById('casos-obs')).maxWidth") == "480px",
          page.evaluate("getComputedStyle(document.getElementById('casos-monto')).maxWidth"))
    check("3f layout web@1280: nav superior estática (no fixed-bottom) y sin padding de barra en body",
          page.evaluate("getComputedStyle(document.querySelector('.bottomnav')).position") != "fixed" and
          page.evaluate("parseFloat(getComputedStyle(document.body).paddingBottom)") < 30, "")

    # ---------- 1b) composición desktop real en web@1280 (Casos + nav alineada) ----------
    check("1b web@1280: nav alineada al contenido (padding lateral 24px igual a main)",
          page.evaluate("getComputedStyle(document.querySelector('.bottomnav')).paddingLeft") == "24px" and
          page.evaluate("getComputedStyle(document.querySelector('main')).paddingLeft") == "24px", "")
    check("1b web@1280: #tab-casos en grid de 2 columnas (no columna estirada)",
          grid_cols(page, "#tab-casos") == 2,
          page.eval_on_selector("#tab-casos", "e => getComputedStyle(e).gridTemplateColumns"))
    chips_rect = rect(page, "#tab-casos > .card:first-child")
    form_rect = rect(page, "#tab-casos > .card:nth-child(2)")
    esc_rect = rect(page, "#casos-escenario-card")
    res_rect = rect(page, "#casos-resultado")
    check("1b web@1280: pares/chips a todo el ancho (fila 1) y formulario a la izquierda, escenarios/resultado a la derecha",
          chips_rect["w"] > 1100 and form_rect["w"] < 700 and
          form_rect["x"] < esc_rect["x"] and res_rect["right"] <= chips_rect["right"] + 2 and
          res_rect["w"] < 700,
          f"chips={chips_rect} form={form_rect} esc={esc_rect} res={res_rect}")
    page.screenshot(path="/tmp/shot-1b-casos-1280.png", full_page=True)

    # ---------- 1b) composición desktop: Cuentas / Balance / Histórico / Tasas ----------
    page.click("button[data-tab='cuentas']")
    page.wait_for_timeout(300)
    cu_list = rect(page, "#cuentas-lista"); cu_form = rect(page, "#tab-cuentas > .card")
    check("1b web@1280: #tab-cuentas en grid de 2 columnas (lista izquierda, formularios derecha, avisos a todo el ancho)",
          grid_cols(page, "#tab-cuentas") == 2 and
          page.eval_on_selector("#cuentas-avisos", "e => getComputedStyle(e).gridColumnStart") == "1" and
          cu_list["x"] < cu_form["x"] and cu_form["w"] < 700,
          f"cols={grid_cols(page, '#tab-cuentas')} lista={cu_list} form={cu_form}")
    page.screenshot(path="/tmp/shot-1b-cuentas-1280.png", full_page=True)
    page.click("button[data-tab='balance']")
    page.wait_for_timeout(300)
    bal_cards = page.eval_on_selector_all("#balance-out > .card",
        "els => els.map(e => { const r = e.getBoundingClientRect(); return { x: r.x, w: r.width, top: r.top }; })")
    check("1b web@1280: #balance-out en grid de 2 columnas (resumen arriba-izquierda, distribución a la derecha)",
          grid_cols(page, "#balance-out") == 2 and len(bal_cards) >= 2 and
          bal_cards[0]["x"] < bal_cards[1]["x"] and all(c["w"] < 700 for c in bal_cards),
          f"cols={grid_cols(page, '#balance-out')} cards={bal_cards}")
    page.screenshot(path="/tmp/shot-1b-balance-1280.png", full_page=True)
    page.click("button[data-tab='historico']")
    page.wait_for_timeout(300)
    hf = rect(page, "#tab-historico > .card:first-child"); hl = rect(page, "#hist-lista")
    check("1b web@1280: histórico con filtros densos (mitad) y lista a todo el ancho",
          grid_cols(page, "#tab-historico") == 2 and hf["w"] < 700 and hl["w"] > 1100,
          f"cols={grid_cols(page, '#tab-historico')} filtros={hf} lista={hl}")
    page.screenshot(path="/tmp/shot-1b-historico-1280.png", full_page=True)
    page.click("button[data-tab='tasas']")
    page.wait_for_timeout(500)
    mlt = rect(page, "#ta-multipares")
    tcols = grid_cols(page, "#tab-tasas")
    check("1b web@1280: #tab-tasas en grid de 2–3 columnas con multi-pares a todo el ancho (scroll interno intacto)",
          2 <= tcols <= 3 and mlt["w"] > 1100,
          f"cols={tcols} multi={mlt}")
    check("1b web@1280: pares multi-fiat en grid interno de 3 columnas y comprobador en 2",
          grid_cols(page, "#ta-multipares") == 3, str(grid_cols(page, "#ta-multipares")))

    # ---------- 2c) Tasas: Matriz 3g (tasas laterales por US$, sin comisión) ----------
    page.click("button[data-tab='tasas']")
    page.click("#btn-matriz")
    page.wait_for_timeout(300)
    # 1b: matriz a todo el ancho del contenido, con scroll interno (.matriz-scroll).
    mtz = rect(page, "#ta-matriz")
    check("1b web@1280: matriz a todo el ancho (> 1100px) con scroll interno en .matriz-scroll",
          mtz["w"] > 1100 and
          page.eval_on_selector("#ta-matriz .matriz-scroll", "e => getComputedStyle(e).overflowX") == "auto",
          f"matriz={mtz}")
    mrows = page.eval_on_selector_all(
        "#ta-matriz .matriz-table tbody tr",
        "trs => trs.map(tr => Array.from(tr.children).map(td => td.textContent.trim()))")
    check("3g matriz: filas exactas PEN/USD, COP/USD, CLP/USD, MXN/USD (sin cruces PEN/COP ni VES)",
          [r[0] for r in mrows] == MATRIZ_ROWS_3G and
          all("VES" not in r[0] and "/" == r[0][-4] for r in mrows), str([r[0] for r in mrows]))
    mtxt = page.inner_text("#ta-matriz")
    check("3g matriz: nota «Mercado (sin comisión). Casos incluye comisión del cliente.» visible y toggle Compra default",
          "Mercado (sin comisión). Casos incluye comisión del cliente." in mtxt and
          page.eval_on_selector("#ta-matriz [data-matriz-side='compra']", "e => e.getAttribute('aria-pressed')") == "true" and
          page.eval_on_selector("#ta-matriz [data-matriz-side='venta']", "e => e.getAttribute('aria-pressed')") == "false", "")
    for side_lbl, side in (("compra", "compra"), ):
        for code in ("PEN", "COP", "CLP", "MXN"):
            exp = [matriz_cell(snap, code, side, m) for m in MATRIZ_MODES]
            row = next((r for r in mrows if r[0] == code + "/USD"), None)
            check(f"3g matriz compra {code}/USD — MAX {exp[0]} BEST {exp[1]} AVG {exp[2]} MIN {exp[3]} (= rateScenarios crudo, sin comisión)",
                  row is not None and row[1:] == exp,
                  f"got={(row or [None, ''])[1:]} exp={exp}")
            vals = [parse_cell(c) for c in (row or [None])[1:] if c != "—"]
            check(f"3g matriz compra {code}/USD: MAX ≥ AVG ≥ MIN (invariante 3g)",
                  len(vals) == 4 and vals[0] >= vals[2] >= vals[3], str(vals))
    def vals_of(rows, code):
        row = next((r for r in rows if r[0] == code + "/USD"), None)
        return [parse_cell(c) for c in (row or [None])[1:] if c != "—"]
    check("3g matriz compra: rangos PEN>1 y <10 · COP>1000 · CLP>100 · MXN>10",
          all(1 < v < 10 for v in vals_of(mrows, "PEN")) and
          all(v > 1000 for v in vals_of(mrows, "COP")) and
          all(v > 100 for v in vals_of(mrows, "CLP")) and
          all(v > 10 for v in vals_of(mrows, "MXN")),
          str([vals_of(mrows, c) for c in ("PEN", "COP", "CLP", "MXN")]))
    print("[snapshot] tasas laterales 3g COMPRA (MAX/BEST/AVG/MIN): " + "; ".join(
        f"{code} {matriz_cell(snap, code, 'compra', 'max')}/{matriz_cell(snap, code, 'compra', 'best')}/{matriz_cell(snap, code, 'compra', 'average')}/{matriz_cell(snap, code, 'compra', 'min')}"
        for code in ("PEN", "COP", "CLP", "MXN")))
    print("[snapshot] tasas laterales 3g VENTA (MAX/BEST/AVG/MIN): " + "; ".join(
        f"{code} {matriz_cell(snap, code, 'venta', 'max')}/{matriz_cell(snap, code, 'venta', 'best')}/{matriz_cell(snap, code, 'venta', 'average')}/{matriz_cell(snap, code, 'venta', 'min')}"
        for code in ("PEN", "COP", "CLP", "MXN")))
    # Toggle a Venta
    page.click("#ta-matriz [data-matriz-side='venta']")
    page.wait_for_timeout(250)
    mrowsV = page.eval_on_selector_all(
        "#ta-matriz .matriz-table tbody tr",
        "trs => trs.map(tr => Array.from(tr.children).map(td => td.textContent.trim()))")
    check("3g matriz venta: toggle activo (aria-pressed Venta=true, Compra=false)",
          page.eval_on_selector("#ta-matriz [data-matriz-side='venta']", "e => e.getAttribute('aria-pressed')") == "true" and
          page.eval_on_selector("#ta-matriz [data-matriz-side='compra']", "e => e.getAttribute('aria-pressed')") == "false", "")
    for code in ("PEN", "COP", "CLP", "MXN"):
        expV = [matriz_cell(snap, code, "venta", m) for m in MATRIZ_MODES]
        row = next((r for r in mrowsV if r[0] == code + "/USD"), None)
        check(f"3g matriz venta {code}/USD — MAX {expV[0]} BEST {expV[1]} AVG {expV[2]} MIN {expV[3]} (= rateScenarios crudo lado venta)",
              row is not None and row[1:] == expV,
              f"got={(row or [None, ''])[1:]} exp={expV}")
        valsV = [parse_cell(c) for c in (row or [None])[1:] if c != "—"]
        check(f"3g matriz venta {code}/USD: MAX ≥ AVG ≥ MIN", len(valsV) == 4 and valsV[0] >= valsV[2] >= valsV[3], str(valsV))
    check("3g matriz venta: rangos PEN>1 y <10 · COP>1000 · CLP>100 · MXN>10",
          all(1 < v < 10 for v in vals_of(mrowsV, "PEN")) and
          all(v > 1000 for v in vals_of(mrowsV, "COP")) and
          all(v > 100 for v in vals_of(mrowsV, "CLP")) and
          all(v > 10 for v in vals_of(mrowsV, "MXN")),
          str([vals_of(mrowsV, c) for c in ("PEN", "COP", "CLP", "MXN")]))
    page.click("#ta-matriz [data-matriz-side='compra']")
    page.wait_for_timeout(250)
    check("3g matriz: toggle de vuelta a Compra",
          page.eval_on_selector("#ta-matriz [data-matriz-side='compra']", "e => e.getAttribute('aria-pressed')") == "true", "")
    check("3g matriz: hint dentro de <details><summary>Detalle</summary> en la tabla",
          page.eval_on_selector_all("#ta-matriz details.hint-details",
                                    "els => els.map(e => e.querySelector('summary').textContent.trim())") == ["Detalle"] and
          "Tasa lateral por 1 US$" in page.eval_on_selector("#ta-matriz details.hint-details", "e => e.textContent"), "")
    page.screenshot(path="/tmp/shot-matriz.png", full_page=True)

    # ---------- 2c-3f) WEB amplio: 1440px sigue acotado a 1280 y sin scroll horizontal ----------
    page.set_viewport_size({"width": 1440, "height": 900})
    page.wait_for_timeout(200)
    sc1440 = page.evaluate("""() => {
      const d = document.documentElement;
      const box = document.querySelector('#ta-matriz .matriz-scroll');
      const cell = document.querySelector('#ta-matriz .matriz-table tbody tr:last-child td:last-child');
      return { scrollWidth: d.scrollWidth, innerWidth: window.innerWidth,
               mainMax: getComputedStyle(document.querySelector('main')).maxWidth,
               navPos: getComputedStyle(document.querySelector('.bottomnav')).position,
               boxOverflowX: box ? getComputedStyle(box).overflowX : null,
               boxScrollable: box ? (box.scrollWidth > box.clientWidth) : null,
               lastRight: cell ? cell.getBoundingClientRect().right : null };
    }""")
    MATRIZ_1440 = json.dumps(sc1440)
    print(f"[matriz 1440 web] {MATRIZ_1440}")
    page.screenshot(path="/tmp/shot-matriz-1440.png", full_page=True)
    # WEB 1440: base visual (main 1280, nav superior), matriz NO desborda la
    # página (scrollea dentro de .matriz-scroll si no cabe) — en 1440 la tabla
    # cabe sin scroll interno pero la caja debe seguir definida con overflow auto.
    check("3f web 1440: main acotado a 1280px, nav superior (no fixed-bottom) y sin scroll horizontal de página",
          sc1440["mainMax"] == "1280px" and sc1440["navPos"] != "fixed" and
          sc1440["scrollWidth"] <= sc1440["innerWidth"] + 1, MATRIZ_1440)
    check("3f web 1440: matriz en su caja (overflow-x auto y última columna dentro del viewport)",
          sc1440["boxOverflowX"] == "auto" and sc1440["lastRight"] is not None and
          sc1440["lastRight"] <= sc1440["innerWidth"] + 1, MATRIZ_1440)

    # ---------- P2: 375px en modo WEB (antes de forzar phone) ----------
    # La vista web también debe funcionar en ventana estrecha: nav superior,
    # sin scroll horizontal y grids de escritorio desactivados (< 720px).
    page.set_viewport_size({"width": 375, "height": 800})
    page.wait_for_timeout(200)
    page.click("button[data-tab='casos']")
    page.wait_for_timeout(300)
    sc375w = page.evaluate("""() => ({
      phone: document.body.classList.contains('phone-mode'),
      navPos: getComputedStyle(document.querySelector('.bottomnav')).position,
      mainMax: getComputedStyle(document.querySelector('main')).maxWidth,
      scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
      casosDisplay: getComputedStyle(document.getElementById('tab-casos')).display,
      casosCols: getComputedStyle(document.getElementById('tab-casos')).gridTemplateColumns.trim(),
      montoMax: getComputedStyle(document.getElementById('casos-monto')).maxWidth }) """)
    check("1b web@375 (antes de forzar phone): sigue en modo web (sin phone-mode, nav superior, main 1280) y sin scroll horizontal",
          not sc375w["phone"] and sc375w["navPos"] != "fixed" and sc375w["mainMax"] == "1280px" and
          sc375w["scrollWidth"] <= sc375w["innerWidth"] + 1,
          json.dumps(sc375w))
    check("1b web@375: grids de escritorio desactivados bajo 720px (columna única) e inputs ≤ 480px",
          sc375w["casosDisplay"] == "block" and (sc375w["casosCols"] == "none" or " " not in sc375w["casosCols"]) and
          sc375w["montoMax"] == "480px", json.dumps(sc375w))
    page.click("button[data-tab='tasas']")
    page.wait_for_timeout(500)

    # ---------- 2c-3f) P1 móvil (phone-mode): la matriz scrollea dentro de su caja (375px) ----------
    # PRUEBA del modo phone en teléfono real: 375px + body.phone-mode (botón
    # “Modo Phone”). El documento sigue sin scroll horizontal; la matriz solo
    # scrollea dentro de .matriz-scroll.
    page.set_viewport_size({"width": 375, "height": 800})
    if not page.evaluate("() => document.body.classList.contains('phone-mode')"):
        page.click("#btn-ui-mode")
    page.wait_for_timeout(200)
    check("3f phone-mode 375px: main 760px, inputs 220px, nav fija abajo y padding de barra en body",
          page.evaluate("getComputedStyle(document.querySelector('main')).maxWidth") == "760px" and
          page.evaluate("getComputedStyle(document.getElementById('casos-monto')).maxWidth") == "220px" and
          page.evaluate("getComputedStyle(document.querySelector('.bottomnav')).position") == "fixed" and
          page.evaluate("(getComputedStyle(document.querySelector('.bottomnav')).bottom == '0px')") and
          page.evaluate("parseFloat(getComputedStyle(document.body).paddingBottom)") >= 76,
          page.evaluate("getComputedStyle(document.querySelector('main')).maxWidth"))
    # 1b: en phone-mode los grids de escritorio NO aplican a ningún ancho.
    check("1b phone-mode 375px: composición desktop apagada (#tab-casos en columna, sin grid)",
          page.evaluate("getComputedStyle(document.getElementById('tab-casos')).display") != "grid" and
          page.evaluate("getComputedStyle(document.getElementById('tab-casos')).gridTemplateColumns.trim()") in ("none", "") and
          page.evaluate("getComputedStyle(document.getElementById('balance-out')).display") != "grid", "")
    sc375 = page.evaluate("""() => {
      const d = document.documentElement;
      const box = document.querySelector('#ta-matriz .matriz-scroll');
      const cell = document.querySelector('#ta-matriz .matriz-table tbody tr:last-child td:last-child');
      if (!box || !cell) return { missing: true };
      box.scrollLeft = box.scrollWidth;
      const r = cell.getBoundingClientRect();
      return { scrollWidth: d.scrollWidth, innerWidth: window.innerWidth,
               boxOverflowX: getComputedStyle(box).overflowX,
               boxScrollable: box.scrollWidth > box.clientWidth, lastRight: r.right };
    }""")
    MATRIZ_375 = json.dumps(sc375)
    print(f"[matriz 375px] {MATRIZ_375}")
    page.screenshot(path="/tmp/shot-matriz-375.png", full_page=True)
    check("3f matriz 375px: documento sin scroll horizontal (scrollWidth <= innerWidth+1) y columna Mínimo alcanzable (scrollea solo dentro de .matriz-scroll)",
          not sc375.get("missing") and
          sc375["scrollWidth"] <= sc375["innerWidth"] + 1 and
          sc375["boxOverflowX"] == "auto" and
          sc375["lastRight"] <= sc375["innerWidth"] + 1,
          MATRIZ_375)
    page.set_viewport_size({"width": 1280, "height": 720})
    page.click("#btn-ui-mode")  # volver al modo web base para el resto de las pruebas
    page.wait_for_timeout(200)
    check("ui-mode: restaurado web@1280 tras el bloque phone 375 (sin body.phone-mode, ct_ui_mode='web')",
          page.evaluate("() => !document.body.classList.contains('phone-mode')") and
          page.evaluate("() => localStorage.getItem('ct_ui_mode')") == "web", "")
    # P2: toast phone → separado de la barra fija (84px); web → 24px.
    page.evaluate("() => CT.toast('prueba toast')")
    page.wait_for_timeout(50)
    tb_web = page.eval_on_selector("#toast", "e => getComputedStyle(e).bottom")
    page.click("#btn-ui-mode")
    page.evaluate("() => CT.toast('prueba toast')")
    page.wait_for_timeout(50)
    tb_phone = page.eval_on_selector("#toast", "e => getComputedStyle(e).bottom")
    page.click("#btn-ui-mode")  # volver a web para el resto de las pruebas
    page.wait_for_timeout(100)
    check("toast: bottom 24px web / 84px phone (sobre la barra fija sin taparla)",
          tb_web == "24px" and tb_phone == "84px", f"web={tb_web} phone={tb_phone}")

    page.click("#btn-matriz")  # cierra la matriz

    # ---------- 3) Tasas → volver a Casos: selección conservada ----------
    page.click("button[data-tab='tasas']")
    page.wait_for_timeout(300)
    page.click("button[data-tab='casos']")
    page.wait_for_timeout(300)
    check("vuelta de Tasas: chip sigue activo", chip_active(page) == ["VES/PEN"], f"chips={chip_active(page)}")
    check("vuelta de Tasas: modo sigue activo", mode_active(page) == ["ba-fwd"], f"modos={mode_active(page)}")
    txt2 = result_text(page).upper()
    check(f"vuelta de Tasas: el resultado recalcula el mismo caso ({VAL_BB})", NUM_BB in txt2 and "CLIENTE DEPOSITA: PEN" in txt2)

    # ---------- 4) “Necesito Bs” (inverso BA, target en VES) ----------
    page.click("#casos-modos [data-modo='ba-rev']")
    check("modo Necesito VES→me depositan PEN activo", mode_active(page) == ["ba-rev"])
    lab = page.inner_text("#casos-monto-label")
    check("label inverso: Tú entregas: VES (objetivo a entregar)", lab.startswith("Tú entregas: VES"), lab)
    page.fill("#casos-monto", str(EXP_BB["delivered"]))
    page.wait_for_timeout(400)
    txt3 = result_text(page).upper()
    check(f"inverso: cliente deposita PEN {VAL_REV_DEP} (target derivado {EXP_BB['delivered']} Bs)",
          "CLIENTE DEPOSITA: PEN" in txt3 and VAL_REV_DEP in page.inner_text("#casos-resultado")
          and VAL_BB in page.inner_text("#casos-resultado") and "TÚ ENTREGAS: VES" in txt3,
          txt3[:400].replace("\n", " | | "))
    m = page.query_selector("#casos-resultado span.v.big")
    big_label = m.evaluate("e => e.previousSibling ? e.previousSibling.textContent : ''") if m else None
    check("inverso: “Cliente deposita” es la fila destacada (big)", m is not None and "CLIENTE DEPOSITA" in str(big_label).upper(), str(big_label))

    # ---------- 4b) USD/USD 320→305 ----------
    page.click("#casos-chips [data-pair='USD/USD']")
    check("chip USD/USD activo", chip_active(page) == ["USD/USD"] and page.eval_on_selector("[data-pair='USD/USD']", "e => e.className"), chip_active(page))
    check("modo por defecto Zelle = zelle-fwd", mode_active(page) == ["zelle-fwd"], f"modos={mode_active(page)}")
    page.fill("#casos-margin", "7")
    page.fill("#casos-monto", "320")
    page.fill("#casos-override", "305")
    page.wait_for_timeout(400)
    txt4 = result_text(page).upper()
    check("USD/USD 320→305: entrega 305,00 USD / depósito 320,00 USD",
          "TÚ ENTREGAS: USD" in txt4 and "305,00" in txt4 and "CLIENTE DEPOSITA: USD" in txt4 and "320,00" in txt4,
          txt4[:330].replace("\n", " | | "))

    check("sin errores de consola (app)", console_errors == [], str(console_errors[:3]))
    check("sin pageerror (app)", page_errors == [], str(page_errors[:3]))
    check("sin peticiones fallidas/404 (app)", failed_reqs == [], str(failed_reqs[:4]))
    page.screenshot(path="/tmp/shot-casos.png", full_page=True)

    # ---------- 5) dist standalone ----------
    console_errors.clear(); page_errors.clear(); failed_reqs.clear()
    page2 = ctx.new_page()
    page2.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    page2.on("pageerror", lambda e: page_errors.append(str(e)))
    page2.on("requestfailed", lambda r: failed_reqs.append(r.url + " " + str(r.failure)))
    page2.on("response", lambda r: failed_reqs.append(f"{r.status} {r.url}") if r.status >= 400 else None)
    page2.goto(DIST + "/", wait_until="networkidle")
    page2.wait_for_timeout(800)
    check("dist: carga con navegación de pestañas", page2.eval_on_selector("button[data-tab='casos']", "e => e.textContent") == "Casos")
    chips2 = chip_active(page2) or []
    page2.click("button[data-tab='casos']")
    page2.wait_for_timeout(500)
    chips2 = chip_active(page2); modos2 = mode_active(page2)
    check("dist: chip activo presente", chips2 == ["VES/PEN"], f"chips={chips2}")
    check("dist: modo activo presente", modos2 == ["ba-fwd"], f"modos={modos2}")
    db2 = esc_buttons(page2, "#casos-esc-dest")
    check("dist: 3e presente con 8 botones y default “Mejor” en ambos lados",
          esc_modes_of(db2) == ["Máximo", "Mejor", "Promedio", "Mínimo"]
          and esc_active(page2, "#casos-esc-origin") == ["best"]
          and esc_active(page2, "#casos-esc-dest") == ["best"], f"dest={esc_modes_of(db2)}")
    page2.fill("#casos-monto", "100")
    page2.wait_for_timeout(400)
    txtD = page2.inner_text("#casos-resultado").upper()
    check(f"dist: 100 PEN→Bs = {VAL_BB_DIST} (Mejor derivado de dist/data/rates.json, standalone igual que dev)",
          "TÚ ENTREGAS: VES" in txtD and VAL_BB_DIST in page2.inner_text("#casos-resultado")
          and "CLIENTE DEPOSITA: PEN" in txtD and "S/ 0,29" not in txtD,
          txtD[:300].replace("\n", " | | "))
    check("dist: sin 404/requests fallidos", failed_reqs == [], str(failed_reqs[:5]))

    page2.fill("#casos-esc-origin-manual", "3.6")
    page2.wait_for_timeout(300)
    check("dist: 3h escribir manual deselecciona presets de origen y persiste la manual",
          page2.eval_on_selector_all("#casos-esc-origin .mode-active", "els => els.map(e => e.dataset.scMode)") == [] and
          (lambda s: (json.loads(s or "null") or {}).get("scOriginManual") == 3.6)(page2.evaluate("() => localStorage.getItem('ct_caso') || sessionStorage.getItem('ct_caso')")), "")
    page2.click("#casos-esc-origin [data-sc-mode='best']")
    page2.wait_for_timeout(300)
    check("dist: 3h click en Mejor limpia la manual y la des-persiste (null)",
          page2.input_value("#casos-esc-origin-manual") == "" and esc_active(page2, "#casos-esc-origin") == ["best"] and
          '"scOriginManual":null' in (page2.evaluate("() => localStorage.getItem('ct_caso') || sessionStorage.getItem('ct_caso')") or ""), "")
    # P2: los errores de consola/pageerror se validan DESPUÉS de las interacciones
    # 3h (stronger: cubre también los eventos input/click del fix de exclusión mutua).
    check("dist: sin errores de consola (tras interacciones 3h)", console_errors == [], str(console_errors[:3]))
    check("dist: sin pageerror (tras interacciones 3h)", page_errors == [], str(page_errors[:3]))

    # persistencia real en sessionStorage/localStorage del navegador
    stored = page2.evaluate("() => ({ l: localStorage.getItem('ct_caso'), s: sessionStorage.getItem('ct_caso') })")
    check("dist: par+modo+matriz 3e persistidos en storage (ct_caso)", (stored["l"] or stored["s"] or "") .find('"modoId":"ba-fwd"') >= 0 and (stored["l"] or stored["s"] or "") .find('"scOriginMode":"best"') >= 0 and (stored["l"] or stored["s"] or "") .find('"scDestMode":"best"') >= 0 and (stored["l"] or stored["s"] or "") .find('"scOriginManual":null') >= 0, str(stored))

    browser.close()

print("\n==== " + ("TODAS OK" if not fails else f"{len(fails)} FALLAS") + " ====")
if fails:
    for f in fails: print("FALLA:", f)
    sys.exit(1)
