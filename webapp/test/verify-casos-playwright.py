import json, os, sys, time
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8000"
DIST = "http://localhost:8010"
os.environ.setdefault("LD_LIBRARY_PATH", "/home/avelis/lib-linux64/system-libs/")

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

    # ---------- 2) PEN→Bs, 100 PEN ----------
    page.fill("#casos-monto", "100")
    page.wait_for_timeout(400)
    txt = result_text(page).upper()
    check("PEN→Bs 100: cliente deposita PEN 100,00", "CLIENTE DEPOSITA: PEN" in txt and "100,00" in txt, txt[:220].replace("\n", " | "))
    check("PEN→Bs 100: TÚ ENTREGAS Bs ≈ 28.147 (no inverso S/ 0,29)",
          ("TÚ ENTREGAS: VES" in txt) and ("28.147" in txt) and ("S/ 0,29" not in txt),
          txt[:400].replace("\n", " | | "))
    check("desglose: nunca Bs como depósito en modo PEN→Bs",
          "CLIENTE DEPOSITA: PEN" in txt and "CLIENTE DEPOSITA: VES" not in txt and "CLIENTE DEPOSITA: BS" not in txt,
          txt[:220].replace("\n", " | "))
    check("tasa pactada presente", "TASA PACTADA" in txt)

    # ---------- 3) Tasas → volver a Casos: selección conservada ----------
    page.click("button[data-tab='tasas']")
    page.wait_for_timeout(300)
    page.click("button[data-tab='casos']")
    page.wait_for_timeout(300)
    check("vuelta de Tasas: chip sigue activo", chip_active(page) == ["VES/PEN"], f"chips={chip_active(page)}")
    check("vuelta de Tasas: modo sigue activo", mode_active(page) == ["ba-fwd"], f"modos={mode_active(page)}")
    txt2 = result_text(page).upper()
    check("vuelta de Tasas: el resultado recalcula el mismo caso (~28.147 Bs)", "28.147" in txt2 and "CLIENTE DEPOSITA: PEN" in txt2)

    # ---------- 4) “Necesito Bs” (inverso BA, target en VES) ----------
    page.click("#casos-modos [data-modo='ba-rev']")
    check("modo Necesito VES→me depositan PEN activo", mode_active(page) == ["ba-rev"])
    lab = page.inner_text("#casos-monto-label")
    check("label inverso: Tú entregas: VES (objetivo a entregar)", lab.startswith("Tú entregas: VES"), lab)
    page.fill("#casos-monto", "28147.30")
    page.wait_for_timeout(400)
    txt3 = result_text(page).upper()
    check("inverso: cliente deposita PEN 100,00 (target 28.147,30 Bs)",
          "CLIENTE DEPOSITA: PEN" in txt3 and "100,00" in txt3 and "28.147,30" in txt3 and "TÚ ENTREGAS: VES" in txt3,
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
    page2.fill("#casos-monto", "100")
    page2.wait_for_timeout(400)
    txtD = page2.inner_text("#casos-resultado").upper()
    check("dist: 100 PEN→Bs ≈ 28.147 Bs (standalone igual que dev)",
          "TÚ ENTREGAS: VES" in txtD and "28.147" in txtD and "CLIENTE DEPOSITA: PEN" in txtD and "S/ 0,29" not in txtD,
          txtD[:300].replace("\n", " | | "))
    check("dist: sin 404/requests fallidos", failed_reqs == [], str(failed_reqs[:5]))
    check("dist: sin errores de consola", console_errors == [], str(console_errors[:3]))
    check("dist: sin pageerror", page_errors == [], str(page_errors[:3]))

    # persistencia real en sessionStorage/localStorage del navegador
    stored = page2.evaluate("() => ({ l: localStorage.getItem('ct_caso'), s: sessionStorage.getItem('ct_caso') })")
    check("dist: par+modo persistidos en storage", (stored["l"] or stored["s"] or "") .find('"modoId":"ba-fwd"') >= 0, str(stored))

    browser.close()

print("\n==== " + ("TODAS OK" if not fails else f"{len(fails)} FALLAS") + " ====")
if fails:
    for f in fails: print("FALLA:", f)
    sys.exit(1)
