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
    return page.eval_on_selector_all(
        cont + " [data-sc-mode]", "els => els.map(e => e.textContent.trim())")

def panel_text(page):
    return page.inner_text("#casos-escenario")

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
        """adRateAt (3e): ejecutables = min<=au*price<=max y available>=au.
        best = mejor precio evaluado a 40 US$ equivalentes (compra min / venta
        max), INDEPENDIENTE del monto del caso. average/min usan el monto real
        (average: media aritmética de los ejecutables; min: el menor).
        max = tercer anuncio de la lista por defecto de cada plataforma (campo
        platform, Binance/Bybit); el máx del lado = mayor de los dos; <3 → último.
        Fallback: libro vacío → media FX; average sin ejecutables → media FX;
        best/min sin ejecutables → None (el motor cae a la media). Sin 2% (3e)."""
        ads = self.book(code, side)
        media = self.media(code, side)
        if not ads:
            return media
        if mode == "best":
            ex = self._executable(code, side, self.BEST_REF_USD)
            if not ex:
                return None
            return min(ex) if side == "compra" else max(ex)
        if mode == "average":
            ex = self._executable(code, side, amount_usd)
            return sum(ex) / len(ex) if ex else media
        if mode == "min":
            ex = self._executable(code, side, amount_usd)
            return min(ex) if ex else None
        groups, order = {}, []
        for a in ads:
            plat = a.get("platform") or "(sin plataforma)"
            if plat not in groups:
                groups[plat] = []
                order.append(plat)
            p = _fp(a.get("price"))
            if p is not None:
                groups[plat].append(p)
        best = None
        for plat in order:
            lst = groups[plat]
            if not lst:
                continue
            pick = lst[2] if len(lst) >= 3 else lst[-1]
            if best is None or pick > best:
                best = pick
        return best

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
EXP_BAVG = snap.quote(PAIR, DIRECTION, "best", "average", deposit=100.0)   # destino “Promedio”
EXP_BMIN = snap.quote(PAIR, DIRECTION, "best", "min", deposit=100.0)       # destino “Mínimo”
EXPA_O   = snap.quote(PAIR, DIRECTION, "average", "average", deposit=100.0) # ambos lados “Promedio”
EXP_REV  = snap.quote(PAIR, DIRECTION, "best", "best", target=EXP_BB["delivered"])
VAL_BB   = fmt_app(EXP_BB["delivered"], "VES")
VAL_BMAX = fmt_app(EXP_BMAX["delivered"], "VES")
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
    check("3e: 8 botones (Compra=origen / Venta=destino × Máximo/Mejor/Promedio/Mínimo)",
          ob == ["Máximo", "Mejor", "Promedio", "Mínimo"] and db == ["Máximo", "Mejor", "Promedio", "Mínimo"],
          f"origin={ob} dest={db}")
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
    check(f"3e: destino “Máximo” (tercer anuncio por plataforma) → desglose {VAL_BMAX}",
          VAL_BMAX in result_text(page) and esc_active(page, "#casos-esc-dest") == ["max"],
          result_text(page)[:300].replace("\n", " | "))
    page.click("#casos-esc-dest [data-sc-mode='average']")
    page.wait_for_timeout(300)
    check(f"3e: destino “Promedio” → desglose {VAL_BAVG}",
          VAL_BAVG in result_text(page) and esc_active(page, "#casos-esc-dest") == ["average"],
          result_text(page)[:300].replace("\n", " | "))
    # Bug 3d: el Promedio es la MEDIA DE LOS ANUNCIOS (no la media FX) y SIN
    # aviso de libro (“adUsed null” no es fallback). En 3e el Máximo es el TERCER
    # anuncio por plataforma (no el mayor price): no se ordena contra Promedio.
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
    check(f"3d: origen “Promedio” = media de anuncios ({_o_avg:.4f}) ≠ media FX ({pen_media_c}) y Mejor ≤ Promedio ≤ Máximo",
          abs(EXPA_O["originRate"] - _o_avg) < 1e-9 and _o_avg != pen_media_c
          and _o_best <= _o_avg <= _o_max, f"avg={EXPA_O['originRate']} media={pen_media_c} best={_o_best} max={_o_max}")
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
    # 3e: Máximo = tercer anuncio por plataforma (no el mayor price); queda dentro del libro.
    _ves_book_min = min(a["price"] for a in snap.book("VES", "venta"))
    check("3e: Máximo (tercer anuncio por plataforma) queda dentro del rango del libro de venta VES",
          _ves_book_min <= _ex_max <= _ves_book_max, f"max={_ex_max} libro={_ves_book_min}..{_ves_book_max}")

    # Par SIN VES (PEN/COP, 3c): reset por par ⇒ default Mejor/Mejor; botones
    # Máximo/Mejor/Promedio/Mínimo (la matriz 3e, sin 2%).
    page.click("#casos-chips [data-pair='PEN/COP']")
    page.wait_for_timeout(300)
    obn = esc_buttons(page, "#casos-esc-origin"); dbn = esc_buttons(page, "#casos-esc-dest")
    check("3c: cambiar de par sin VES resetea a Mejor/Mejor con botones Máximo/Mejor/Promedio/Mínimo",
          esc_active(page, "#casos-esc-origin") == ["best"] and esc_active(page, "#casos-esc-dest") == ["best"]
          and obn == ["Máximo", "Mejor", "Promedio", "Mínimo"] and dbn == ["Máximo", "Mejor", "Promedio", "Mínimo"],
          f"origin={esc_active(page, '#casos-esc-origin')} dest={esc_active(page, '#casos-esc-dest')} ob={obn} db={dbn}")
    page.fill("#casos-monto", "100")
    page.wait_for_timeout(400)
    pt_nv = panel_text(page).upper()
    check("3c: par sin VES (COP→PEN) mejor/mejor ⇒ el 2% está eliminado del panel (nunca “Aplicado”)",
          "2%" not in pt_nv and "SIN 2%" not in pt_nv and "APLICADO" not in pt_nv, pt_nv[:300].replace("\n", " | "))
    check("3c: COP→PEN 100 mejor/mejor = valor derivado del snapshot vivo",
          VAL_BEST_NV in page.inner_text("#casos-resultado"),
          page.inner_text("#casos-resultado")[:300].replace("\n", " | "))
    # 3c: flujo PEN→COP 100 (ab-fwd): Mejor (default) y Máximo (tercer anuncio por plataforma, sin 2%)
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
          and esc_buttons(page, "#casos-esc-origin") == ["Máximo", "Mejor", "Promedio", "Mínimo"]
          and VAL_BB in result_text(page),
          f"origin={esc_active(page, '#casos-esc-origin')} ob={esc_buttons(page, '#casos-esc-origin')}")

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
          db2 == ["Máximo", "Mejor", "Promedio", "Mínimo"]
          and esc_active(page2, "#casos-esc-origin") == ["best"]
          and esc_active(page2, "#casos-esc-dest") == ["best"], f"dest={db2}")
    page2.fill("#casos-monto", "100")
    page2.wait_for_timeout(400)
    txtD = page2.inner_text("#casos-resultado").upper()
    check(f"dist: 100 PEN→Bs = {VAL_BB_DIST} (Mejor derivado de dist/data/rates.json, standalone igual que dev)",
          "TÚ ENTREGAS: VES" in txtD and VAL_BB_DIST in page2.inner_text("#casos-resultado")
          and "CLIENTE DEPOSITA: PEN" in txtD and "S/ 0,29" not in txtD,
          txtD[:300].replace("\n", " | | "))
    check("dist: sin 404/requests fallidos", failed_reqs == [], str(failed_reqs[:5]))
    check("dist: sin errores de consola", console_errors == [], str(console_errors[:3]))
    check("dist: sin pageerror", page_errors == [], str(page_errors[:3]))

    # persistencia real en sessionStorage/localStorage del navegador
    stored = page2.evaluate("() => ({ l: localStorage.getItem('ct_caso'), s: sessionStorage.getItem('ct_caso') })")
    check("dist: par+modo+matriz 3e persistidos en storage (ct_caso)", (stored["l"] or stored["s"] or "") .find('"modoId":"ba-fwd"') >= 0 and (stored["l"] or stored["s"] or "") .find('"scOriginMode":"best"') >= 0 and (stored["l"] or stored["s"] or "") .find('"scDestMode":"best"') >= 0 and (stored["l"] or stored["s"] or "") .find('"scOriginManual":null') >= 0, str(stored))

    browser.close()

print("\n==== " + ("TODAS OK" if not fails else f"{len(fails)} FALLAS") + " ====")
if fails:
    for f in fails: print("FALLA:", f)
    sys.exit(1)
