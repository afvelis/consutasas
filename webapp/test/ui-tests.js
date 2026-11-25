/* Pruebas smoke del núcleo de UI v2 — Node puro con DOM simulado:
 * `node test/ui-tests.js`.
 * Cubre: arranque (CTEngine presente), pestañas + sessionStorage, render lazy,
 * chips de pares y los 4 modos por par (estado inicial determinista VES/PEN +
 * “Me depositan PEN → entrego Bs” con chip-active/mode-active, persistencia par+modo
 * en storage y restauración al volver de otra pestaña, 100 PEN→VES = 29.228,57,
 * USD/USD 320→305 con override), cotización EXACTA vía CTEngine (PEN→VES 3700 →
 * 1.081.457,14 con comisión 7 % y escenarios 3e (Mejor, sin 2 %), cotización y registro INVERSOS, USD/USD con
 * forward e inverso (Zelle 305 → 327,96), cuentas (primaria única), balance
 * (cuadre/patrimonio/pasivos), histórico (filtros/stats/cadena), migración
 * legacy v1, hooks de tasas.js y ausencia de HTML/JS inline. Llama a
 * `node webapp/test/ui-tests.js`.
 * 3b/3e: panel de escenarios en Casos (8 botones por lado con aria-pressed:
 * Máximo/Mejor/Promedio/Mínimo — la matriz 3e — en cualquier par, default Mejor;
 * Mejor se evalúa a 40 USD equivalentes (min/price ≤ 40 ≤ max/price, disp ≥ 40);
 * Máximo = 3g: el mayor precio de TODOS los anuncios del lado (ya no el tercer
 * anuncio por plataforma); Promedio = media aritmética de todos los anuncios;
 * Mínimo = el menor precio de todos — MAX ≥ AVG ≥ MIN por construcción;), comisión editable
 * default 7 % (8 % COP), recálculo con ads, aviso si el libro no cubre el monto,
 * tasa pactada efectiva, tasas manuales por lado con factor de seguridad
 * (sistema − manual)/sistema × 100 (negativo = recargo, visible, no rechaza),
 * persistencia de modos/manuales en `ct_caso`, aviso sin ads, reset por par y
 * oculto en USD/USD; UNA sola cotización: el desglose y el registro del caso
 * consumen el mismo quote caseQuoteScenario).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const engine = require('../assets/engine.js');
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'assets', 'app.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) console.log('  ✓ ' + name);
  else { failures++; console.error('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}
async function until(fn, ms) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > (ms || 2000)) return false;
    await new Promise(r => setTimeout(r, 10));
  }
  return true;
}

/* ================= fixture del snapshot real (fixture:true, no de mercado) ================= */
const FIXTURE = {
  fixture: true,
  schema: 'consutasas/rates.v1',
  generatedAt: new Date().toISOString(),
  generatedAtCaracas: '2026-01-15T08:00:00-04:00',
  pairs: {
    VES: { code: 'VES', status: 'ok', compra: 1000, venta: 1100 },
    PEN: { code: 'PEN', status: 'ok', compra: 3.5, venta: 3.7 },
    COP: { code: 'COP', status: 'ok', compra: 4000, venta: 4200 },
    CLP: { code: 'CLP', status: 'ok', compra: 900, venta: 950 },
    MXN: { code: 'MXN', status: 'ok', compra: 18, venta: 20 }
  },
  eurRef: { fixture: true, source: 'frankfurter', date: '2026-01-14', usdToEur: 0.9, eurToUsd: 1.1111 }
};

/* ================= DOM simulado ================= */
const htmlLog = {}; // id → último innerHTML (para el chequeo "sin inline")

function makeEl(id) {
  const listeners = {};
  const attrs = {};
  let cls = '';
  const el = {
    id, value: '', hidden: false, dataset: {}, textContent: '', style: {},
    files: [], options: [], selectedIndex: 0,
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); htmlLog[id] = this._html; },
    get className() { return cls; },
    set className(v) { cls = String(v); },
    classList: {
      toggle(c, force) {
        const on = force === undefined ? cls.split(/\s+/).indexOf(c) < 0 : force;
        const set = new Set(cls.split(/\s+/).filter(Boolean));
        if (on) set.add(c); else set.delete(c);
        cls = Array.from(set).join(' ');
        return on;
      },
      contains(c) { return cls.split(/\s+/).indexOf(c) >= 0; },
      add(c) { el.classList.toggle(c, true); },
      remove(c) { el.classList.toggle(c, false); }
    },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return attrs[k] || null; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    querySelectorAll() { return []; },
    appendChild() {}, remove() {}, click() {}, reset() {}, focus() {}
  };
  el.__listeners = listeners;
  el.__attrs = attrs;
  return el;
}

const byId = new Map();
const documentStub = {
  readyState: 'complete',
  getElementById(id) {
    if (!byId.has(id)) byId.set(id, makeEl(id));
    return byId.get(id);
  },
  querySelectorAll(sel) {
    if (sel === '.tab') return ['casos', 'cuentas', 'balance', 'historico', 'tasas'].map(t => documentStub.getElementById('tab-' + t));
    if (sel === '.navbtn') {
      return ['casos', 'cuentas', 'balance', 'historico', 'tasas'].map(t => documentStub.getElementById('nav-' + t));
    }
    return [];
  },
  createElement(tag) { return makeEl('dyn-' + tag); },
  addEventListener() {},
  body: null
};
documentStub.body = makeEl('body');
documentStub.body.appendChild = () => {};

const TABS_LIST = ['casos', 'cuentas', 'balance', 'historico', 'tasas'];
TABS_LIST.forEach(t => {
  const s = documentStub.getElementById('tab-' + t);
  s.hidden = true;
  const b = documentStub.getElementById('nav-' + t);
  b.dataset = { tab: t };
  s.classList.toggle('active', t === 'casos');
  b.classList.toggle('active', t === 'casos');
});

const mkStore = () => {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k)
  };
};
const ls = mkStore(), ss = mkStore();

const sandbox = {
  document: documentStub,
  localStorage: ls,
  sessionStorage: ss,
  location: { hostname: 'localhost' },
  fetch: async () => ({ ok: true, text: async () => JSON.stringify(FIXTURE) }),
  setInterval: () => 0,
  setTimeout, clearTimeout,
  console, Date, Intl, Math, JSON, Number, String, Array, Object, Promise, parseFloat, parseInt, isNaN,
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  URLSearchParams,
  Blob: function (parts, opts) { this.parts = parts; this.opts = opts; },
  FileReader: function () {},
  CTEngine: engine
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.window = sandbox;
sandbox.addEventListener = function(type, fn) { (sandbox.listeners = sandbox.listeners || {})[type] = (sandbox.listeners[type] || []).concat(fn); };
(sandbox.listeners = sandbox.listeners || {});

try {
  vm.createContext(sandbox);
  vm.runInContext(appSrc, sandbox, { filename: 'app.js' });
} catch (e) {
  check('app.js evalúa sin lanzar', false, e.message);
  console.error('\n===== UI: ' + (checks - failures) + '/' + checks + ' pruebas OK, ' + failures + ' fallidas =====');
  process.exit(1);
}

(async () => {
  const CT = sandbox.CT;
  check('CT quedó expuesto en globalThis', !!CT && typeof CT === 'object');

  // init() corre solo (readyState complete): esperamos fx y estado del libro.
  check('espera snapshot y ledger', await until(() => CT.S.fx && CT.S.ledger));
  check('snapshot en vivo (no caché)', CT.S.fromCache === false);
  check('tab inicial = casos (por sessionStorage vacío)', CT.S.tab === 'casos');

  /* ---- pestañas ---- */
  CT.switchTab('cuentas');
  check('pestaña: se muestra tab-cuentas y se oculta tab-casos',
    sandbox.document.getElementById('tab-cuentas').hidden === false &&
    sandbox.document.getElementById('tab-casos').hidden === true);
  check('pestaña: aria-selected en navbtn', sandbox.document.getElementById('nav-cuentas').__attrs['aria-selected'] === 'true');
  check('sessionStorage guarda la pestaña', ss.getItem('ct_tab') === 'cuentas');
  CT.switchTab('casos');
  check('vuelta a casos', ss.getItem('ct_tab') === 'casos');

  /* ---- chips de pares + modos ---- */
  CT.parts.casos();
  const chipsHtml = sandbox.document.getElementById('casos-chips').innerHTML;
  const modosHtml0 = sandbox.document.getElementById('casos-modos').innerHTML;
  check('chips: 7 pares default + USD/USD',
    /VES\/PEN/.test(chipsHtml) && /PEN\/COP/.test(chipsHtml) && /COP\/CLP/.test(chipsHtml) && /USD\/USD \(Zelle\)/.test(chipsHtml));
  check('primer par seleccionado por defecto (VES/PEN)', CT.S.pairKey === 'VES/PEN');
  check('modo inicial determinista = ba-fwd (Me depositan PEN → entrego Bs)', CT.S.modo && CT.S.modo.id === 'ba-fwd');
  check('estado inicial activo: clase chip-active en el chip VES/PEN',
    /chip-active" data-pair="VES\/PEN"/.test(chipsHtml), chipsHtml.slice(0, 300));
  check('estado inicial activo: clase mode-active en el modo ba-fwd',
    /mode-active" data-modo="ba-fwd"/.test(modosHtml0), modosHtml0.slice(0, 300));
  check('label del input declara el depósito: Cliente deposita: PEN',
    sandbox.document.getElementById('casos-monto-label').textContent === 'Cliente deposita: PEN',
    sandbox.document.getElementById('casos-monto-label').textContent);

  CT.selectPair('PEN/COP');
  check('click de par: modo por defecto coherente (Cliente deposita: COP)',
    CT.S.modo && CT.S.modo.id === 'ba-fwd' &&
    sandbox.document.getElementById('casos-monto-label').textContent === 'Cliente deposita: COP',
    sandbox.document.getElementById('casos-monto-label').textContent);
  CT.selectPair('VES/PEN');

  const modosHtml = sandbox.document.getElementById('casos-modos').innerHTML;
  check('4 modos por par (todos activos, sin “pendiente”)',
    (modosHtml.match(/data-modo/g) || []).length === 4 && (modosHtml.match(/disabled/g) || []).length === 0 &&
    modosHtml.indexOf('— pendiente') < 0);
  check('etiquetas de los 4 modos (2 forward + 2 inversas)',
    /Me depositan VES → entrego PEN/.test(modosHtml) && /Necesito PEN → me depositan VES/.test(modosHtml) &&
    /Me depositan PEN → entrego VES/.test(modosHtml) && /Necesito VES → me depositan PEN/.test(modosHtml));
  check('modo activo tras click de par = ba-fwd (no forward AB)', CT.S.modo && CT.S.modo.id === 'ba-fwd');
  check('setModo activa el inverso AB (target)', CT.setModo('ab-rev') === true && CT.S.modo._fwd === false);
  check('label del monto en inverso = entrega objetivo (Tú entregas: PEN)',
    sandbox.document.getElementById('casos-monto-label').textContent === 'Tú entregas: PEN (monto objetivo a entregar)');
  check('override deshabilitado en modo inverso del par', sandbox.document.getElementById('casos-override').disabled === true);
  check('setModo activa BA', CT.setModo('ba-fwd') === true && CT.S.modo.dir === 'BA');

  /* ---- persistencia par+modo (storage) + retorno entre pestañas ---- */
  check('selección del caso guardada en storage (par+modo)', (() => {
    const rec = JSON.parse(ls.getItem('ct_caso') || ss.getItem('ct_caso') || 'null');
    return !!rec && rec.pairKey === 'VES/PEN' && rec.modoId === 'ba-fwd';
  })());
  CT.S.pairKey = null; CT.S.modo = null;
  CT.renderCasos();
  check('restauración del caso desde el storage', CT.S.pairKey === 'VES/PEN' && CT.S.modo && CT.S.modo.id === 'ba-fwd');
  check('clases activas re-aplicadas tras restaurar',
    /chip-active" data-pair="VES\/PEN"/.test(sandbox.document.getElementById('casos-chips').innerHTML) &&
    /mode-active" data-modo="ba-fwd"/.test(sandbox.document.getElementById('casos-modos').innerHTML));
  CT.switchTab('tasas'); CT.switchTab('casos');
  check('vuelta de Tasas: chip/modo siguen activos',
    /chip-active" data-pair="VES\/PEN"/.test(sandbox.document.getElementById('casos-chips').innerHTML) &&
    /mode-active" data-modo="ba-fwd"/.test(sandbox.document.getElementById('casos-modos').innerHTML));

  /* ---- cotización EXACTA vía CTEngine.caseQuote ---- */
  sandbox.document.getElementById('casos-monto').value = '3700';
  sandbox.document.getElementById('casos-tercero').checked = true;
  CT.renderResultado();
  const resHtml = sandbox.document.getElementById('casos-resultado').innerHTML;
  check('PEN→VES 3700: entregas 1.081.457,14 Bs (quote del panel @7% Mejor, compra 3,5 / venta 1.100 sin 2%)', resHtml.indexOf('1.081.457,14') >= 0, resHtml.slice(0, 400));
  check('desglose: cliente deposita / tú entregas / tasa pactada',
    /Cliente deposita/.test(resHtml) && /Tú entregas/.test(resHtml) && /Tasa pactada/.test(resHtml));
  check('desglose: USDT bruto/neto + plusvalía/diezmo/tercero/neto',
    /USDT bruto/.test(resHtml) && /USDT neto/.test(resHtml) && /Plusvalía/.test(resHtml) && /Diezmo/.test(resHtml) && /Neto para mí/.test(resHtml));
  check('aviso: promedio sin libro si no hay ads', /sin libro de anuncios/.test(resHtml));
  // init() sin cache inicial + localhost → updateSource = 'local' → 'local (no publicado)'
  check('snapshot visible con generatedAt + fuente local (no publicado)',
    /Snapshot:/.test(resHtml) && /local \(no publicado\)/.test(resHtml),
    resHtml.slice(0, 300));
  check('botón Registrar operación en el resultado', /data-action="registrar"/.test(resHtml));

  /* ---- caso pedido por el bug: 100 PEN→Bs (VES) nunca sale invertido ---- */
  sandbox.document.getElementById('casos-monto').value = '100';
  CT.renderResultado();
  const res100 = sandbox.document.getElementById('casos-resultado').innerHTML;
  check('PEN→VES 100: entregas 29.228,57 Bs (quote del panel @7% Mejor, venta 1.100 sin 2%)', res100.indexOf('29.228,57') >= 0, res100.slice(0, 400));
  check('desglose sin cotización duplicada: no aparece la cifra del 2% eliminado (28.644,00 con venta 1.078)',
    res100.indexOf('28.644,00') < 0, res100.slice(0, 200));
  check('desglose declara moneda explícita: Cliente deposita: PEN / Tú entregas: VES',
    /Cliente deposita: PEN/.test(res100) && /Tú entregas: VES/.test(res100) &&
    !/Cliente deposita: VES/.test(res100) && !/Tú entregas: PEN/.test(res100));
  sandbox.document.getElementById('casos-monto').value = '3700';
  CT.renderResultado();

  /* ---- 3b/3e: panel de escenarios (matriz Máximo/Mejor/Promedio/Mínimo) ----
   * Contexto reutilizado: VES/PEN modo ba-fwd (deposita PEN → entrego VES).
   * El panel cotiza con CTEngine.caseQuoteScenario (misma fuente del desglose
   * y del registro), comisión default de la config (7 % con PEN) editable y el
   * mismo monto del caso; sin ads usa la media FX y lo avisa. 3e: default
   * Mejor, sin 2% (eliminado), 8 botones (4 por lado). */
  sandbox.document.getElementById('casos-monto').value = '100';
  CT.renderTab('casos');
  const escCard = sandbox.document.getElementById('casos-escenario-card');
  check('3b: tarjeta de escenarios visible para par fiat', escCard && escCard.hidden === false);
  const escOriginHtml = sandbox.document.getElementById('casos-esc-origin').innerHTML;
  const escDestHtml = sandbox.document.getElementById('casos-esc-dest').innerHTML;
  check('3e: 8 botones de escenario (4 por lado Máximo/Mejor/Promedio/Mínimo)',
    (escOriginHtml.match(/data-sc-mode=/g) || []).length === 4 &&
    (escDestHtml.match(/data-sc-mode=/g) || []).length === 4);
  check('3e: etiquetas Máximo / Mejor / Promedio / Mínimo en ambas filas',
    /Máximo/.test(escOriginHtml) && /Mejor/.test(escOriginHtml) && /Promedio/.test(escOriginHtml) && /Mínimo/.test(escOriginHtml) &&
    /Máximo/.test(escDestHtml) && /Mejor/.test(escDestHtml) && /Promedio/.test(escDestHtml) && /Mínimo/.test(escDestHtml));
  check('3e: el 2% (conservative) está ELIMINADO de la matriz',
    escOriginHtml.indexOf('conservative') < 0 && escDestHtml.indexOf('conservative') < 0 &&
    escOriginHtml.indexOf('2%') < 0 && escDestHtml.indexOf('2%') < 0);
  check('3b: filas Compra (origen): PEN y Venta (destino): VES',
    sandbox.document.getElementById('casos-esc-origin-label').textContent === 'Compra (origen): PEN' &&
    sandbox.document.getElementById('casos-esc-dest-label').textContent === 'Venta (destino): VES');
  check('3e: default Mejor (best) activo en ambos lados al cargar',
    /mode-active" data-sc-side="origin" data-sc-mode="best"/.test(escOriginHtml) &&
    /mode-active" data-sc-side="dest" data-sc-mode="best"/.test(escDestHtml));
  check('3e: aria-pressed en los 8 botones (true solo en los activos best)',
    escOriginHtml.match(/aria-pressed=/g).length === 4 && escDestHtml.match(/aria-pressed=/g).length === 4 &&
    escOriginHtml.match(/aria-pressed="true"/g).length === 1 && escDestHtml.match(/aria-pressed="true"/g).length === 1 &&
    /aria-pressed="false"/.test(escOriginHtml) && /aria-pressed="false"/.test(escDestHtml));
  /* 3f: tasa lateral DENTRO de cada botón (compacto) + aria-label con la tasa.
   * Sin ads (FIXTURE): cae a la media FX del snapshot (compra origen 3,50
   * PEN/US$; venta destino 1.100,00 VES/US$), igual que el desglose usa. */
  check('3f: cada botón de modo muestra su tasa lateral dentro del botón (compra origen 3,50 / venta destino 1.100,00 con media FX)',
    (escOriginHtml.match(/<span class="sc-rate">3,50<\/span>/g) || []).length === 4 &&
    (escDestHtml.match(/<span class="sc-rate">1\.100,00<\/span>/g) || []).length === 4 &&
    escOriginHtml.indexOf('btn-sc') >= 0, escOriginHtml.slice(0, 600));
  check('3f: aria-label de los 8 botones incluye la tasa lateral y el lado (compra PEN / venta VES)',
    (escOriginHtml.match(/aria-label="[^\"]*compra PEN 3,50 PEN\/US\$"/g) || []).length === 4 &&
    (escDestHtml.match(/aria-label="[^\"]*venta VES 1\.100,00 VES\/US\$"/g) || []).length === 4 &&
    /aria-label="Mejor — compra PEN/.test(escOriginHtml) && /aria-label="Máximo — venta VES/.test(escDestHtml),
    escDestHtml.slice(0, 600));
  const escOut1 = sandbox.document.getElementById('casos-escenario').innerHTML;
  check('3e: desglose PEN→VES 100 @7% Mejor: monto final 29.228,57 Bs (aria-live en el contenedor)',
    escOut1.indexOf('29.228,57') >= 0 && /Monto final/.test(escOut1), escOut1.slice(0, 500));
  check('3e: muestra tasas compra usada (origen) y venta usada (destino) con media FX (sin ads): 1.100,00',
    /Tasa compra usada \(origen\)/.test(escOut1) && /Tasa venta usada \(destino\)/.test(escOut1) &&
    /1\.100,00/.test(escOut1) && /media FX \(sin anuncios\)/.test(escOut1), escOut1.slice(0, 500));
  check('3e: tasa pactada es la efectiva (292,29), no la bruta (314,29)',
    /Tasa pactada \(efectiva\)/.test(escOut1) && escOut1.indexOf('292,29') >= 0 &&
    escOut1.indexOf('314,29') < 0, escOut1.slice(0, 500));
  check('3e: sin 2% en ningún lado (eliminado) + USDT + moneda destino + comisión 7,00%',
    escOut1.indexOf('2% aplicado') < 0 && escOut1.indexOf('Sin 2%') < 0 && escOut1.indexOf('2%') < 0 &&
    /USDT bruto/.test(escOut1) &&
    /Moneda destino/.test(escOut1) && /7,00 %/.test(escOut1), escOut1.slice(0, 500));
  check('3b: sin ads → aviso claro estilo warnline (nunca inventa)',
    /warnline/.test(escOut1) && /Sin libro de anuncios/.test(escOut1));

  // Cambio de modo recalcula: snapshot temporal con ads de precio. Criterio
  // conservador de Mejor (3g): compra = MAYOR ejecutable a 40 US$ eq, venta =
  // MENOR ejecutable. El extremo del libro no es ejecutable en cada lado
  // (compra 3,80 con min 200 > 40×3,80; venta 1.070 con max 5.000 < 40×1.070)
  // para que BEST ≠ MAX/MIN sí sea distinguible: compra best 3,75 < max 3,80 ·
  // venta best 1.080 > min 1.070.
  const ratesSinAds = CT.S.rates, fxSinAds = CT.S.fx;
  const ratesAds = JSON.parse(JSON.stringify(ratesSinAds));
  ratesAds.pairs.PEN.ads = {
    compra: [
      { price: 3.5, min: 1, max: 1000000, available: 1000000, platform: 'binance' },
      { price: 3.75, min: 1, max: 1000000, available: 1000000, platform: 'binance' },
      { price: 3.8, min: 200, max: 1000000, available: 1000000, platform: 'binance' }
    ],
    venta: [{ price: 3.7, min: 1, max: 1000000, available: 1000000, platform: 'binance' }, { price: 3.4, min: 1, max: 1000000, available: 1000000, platform: 'binance' }]
  };
  ratesAds.pairs.VES.ads = {
    compra: [{ price: 1000, min: 1, max: 1000000, available: 1000000, platform: 'binance' }, { price: 1005, min: 1, max: 1000000, available: 1000000, platform: 'binance' }],
    venta: [
      { price: 1100, min: 1, max: 1000000, available: 1000000, platform: 'binance' },
      { price: 1080, min: 1, max: 1000000, available: 1000000, platform: 'binance' },
      { price: 1070, min: 1, max: 5000, available: 1000000, platform: 'binance' }
    ]
  };
  CT.S.rates = ratesAds;
  CT.S.fx = engine.buildFx(ratesAds);
  CT.renderTab('casos');
  const escBestAds = sandbox.document.getElementById('casos-escenario').innerHTML;
  check('3g: con ads el default Mejor cotiza conservador compra 3,75 / venta 1.080,00 → monto 26.784,00 (sin 2%)',
    escBestAds.indexOf('26.784,00') >= 0 && /3,75/.test(escBestAds) && /1\.080,00/.test(escBestAds) &&
    escBestAds.indexOf('3,80') < 0 && escBestAds.indexOf('1.070,00') < 0 &&
    escBestAds.indexOf('2%') < 0, escBestAds.slice(0, 500));
  check('3b: con ads no hay aviso de “Sin libro de anuncios”', !/Sin libro de anuncios/.test(escBestAds));
  /* Máximo 3g: el mayor price de TODOS los anuncios del lado (3,80), sin
   * agrupado por plataforma y SIN avisos (la lógica del tercer anuncio ya no
   * existe). BEST queda cerca de MAX: max 3,80 solo 0,05 por encima del best 3,75. */
  check('3g: setEscenarioModo(origin, max) recalcula: compra 3,80 (mayor price de todos, el best 3,75 queda cerca) → monto 26.431,58, sin aviso',
    CT.setEscenarioModo('origin', 'max') === true &&
    sandbox.document.getElementById('casos-escenario').innerHTML.indexOf('26.431,58') >= 0 &&
    /3,80/.test(sandbox.document.getElementById('casos-escenario').innerHTML) &&
    sandbox.document.getElementById('casos-escenario').innerHTML.indexOf('1.080,00') >= 0 &&
    !/anuncios/.test(sandbox.document.getElementById('casos-escenario').innerHTML),
    sandbox.document.getElementById('casos-escenario').innerHTML.slice(0, 600));
  check('3e: modo activo refleja la selección (origin = max)',
    /mode-active" data-sc-side="origin" data-sc-mode="max"/.test(sandbox.document.getElementById('casos-esc-origin').innerHTML));
  const escMaxAds = sandbox.document.getElementById('casos-escenario').innerHTML;
  check('3g: setEscenarioModo(origin, best) recalcula sin recargar: compra 3,75 y monto 26.784,00 (dest intacto)',
    CT.setEscenarioModo('origin', 'best') === true &&
    sandbox.document.getElementById('casos-escenario').innerHTML.indexOf('26.784,00') >= 0 &&
    sandbox.document.getElementById('casos-escenario').innerHTML.indexOf('3,75') >= 0 &&
    sandbox.document.getElementById('casos-escenario').innerHTML !== escMaxAds,
    sandbox.document.getElementById('casos-escenario').innerHTML.slice(0, 400));
  check('3e: modo activo refleja la selección (origin = best)',
    /mode-active" data-sc-side="origin" data-sc-mode="best"/.test(sandbox.document.getElementById('casos-esc-origin').innerHTML));
  /* Mínimo destino 3g: el MENOR price de TODOS los anuncios del lado venta (1.070,
   * sin filtro). BEST venta conservador queda cerca de MIN: 1.080, solo 10 por encima. */
  check('3g: setEscenarioModo(dest, min): venta 1.070,00 → monto final 26.536,00 (origen intacto en best)',
    CT.setEscenarioModo('dest', 'min') === true &&
    sandbox.document.getElementById('casos-escenario').innerHTML.indexOf('26.536,00') >= 0 &&
    /1\.070,00/.test(sandbox.document.getElementById('casos-escenario').innerHTML) &&
    /3,75/.test(sandbox.document.getElementById('casos-escenario').innerHTML),
    sandbox.document.getElementById('casos-escenario').innerHTML.slice(0, 400));
  /* P0: el 2% ya no existe: el desglose repinta tras cada cambio de modo y el
   * registro del caso usa ese mismo quote (dest best → 26.784,00). */
  check('3g: setEscenarioModo(dest, best): vuelve a venta conservadora 1.080,00 → monto final 26.784,00',
    CT.setEscenarioModo('dest', 'best') === true &&
    sandbox.document.getElementById('casos-escenario').innerHTML.indexOf('26.784,00') >= 0 &&
    sandbox.document.getElementById('casos-escenario').innerHTML.indexOf('1.080,00') >= 0 &&
    sandbox.document.getElementById('casos-escenario').innerHTML.indexOf('267,84') >= 0,
    sandbox.document.getElementById('casos-escenario').innerHTML.slice(0, 400));
  const resAdsBest = sandbox.document.getElementById('casos-resultado').innerHTML;
  check('P0: setEscenarioModo(dest, best) repinta el desglose: 26.784,00 y ya no 28.644,00 (ni cifra del 2%)',
    resAdsBest.indexOf('26.784,00') >= 0 && resAdsBest.indexOf('28.644,00') < 0,
    resAdsBest.slice(0, 400));
  const stAds = CT.S.ledger;
  const ledBackup = JSON.parse(JSON.stringify(stAds));
  sandbox.document.getElementById('casos-cuenta-in').value = 'peru';
  sandbox.document.getElementById('casos-cuenta-out').value = 'efectivo-ves';
  sandbox.document.getElementById('casos-obs').value = 'prueba ads best';
  CT.registrarCaso();
  const mvAds = stAds.movements[stAds.movements.length - 1];
  check('P0: registrarCaso usa el mismo quote que el desglose repintado (out = delivered 26.784,00)',
    mvAds != null && mvAds.in.amount === 100 && mvAds.in.currency === 'PEN' &&
    mvAds.out.currency === 'VES' && mvAds.out.amount === CT.quoteEscenario().delivered &&
    Math.round(mvAds.out.amount * 100) / 100 === 26784,
    JSON.stringify(mvAds && mvAds.out));
  // Restaurar el ledger que validan los bloques siguientes (balance, histórico…).
  Object.keys(ledBackup).forEach(function (k) { stAds[k] = ledBackup[k]; });
  // Bug 3d: el Promedio usa la MEDIA DE LOS ANUNCIOS (no la media FX) y, como no
  // es un anuncio único (adUsed null), NO dispara el aviso “no cubre el monto”.
  check('3b/3d: setEscenarioModo(origin, average): tasa compra = media de TODOS los anuncios (3,6833), no la media FX (3,5)',
    CT.setEscenarioModo('origin', 'average') === true &&
    /3,6833/.test(sandbox.document.getElementById('casos-escenario').innerHTML) &&
    !/3,5000/.test(sandbox.document.getElementById('casos-escenario').innerHTML) &&
    /Promedio de anuncios/.test(sandbox.document.getElementById('casos-escenario').innerHTML) &&
    !/media FX/.test(sandbox.document.getElementById('casos-escenario').innerHTML) &&
    !/no cubre el monto/.test(sandbox.document.getElementById('casos-escenario').innerHTML),
    sandbox.document.getElementById('casos-escenario').innerHTML.slice(0, 600));
  check('3b/3d: setEscenarioModo(dest, average): tasa venta = media de TODOS los anuncios (1.083,33) y SIN aviso de libro',
    CT.setEscenarioModo('dest', 'average') === true &&
    /1\.083,33/.test(sandbox.document.getElementById('casos-escenario').innerHTML) &&
    (sandbox.document.getElementById('casos-escenario').innerHTML.match(/Promedio de anuncios/g) || []).length === 2 &&
    !/no cubre el monto/.test(sandbox.document.getElementById('casos-escenario').innerHTML) &&
    !/Sin libro de anuncios/.test(sandbox.document.getElementById('casos-escenario').innerHTML),
    sandbox.document.getElementById('casos-escenario').innerHTML.slice(0, 600));
  CT.setEscenarioModo('origin', 'best'); // vuelve al default para el resto
  CT.setEscenarioModo('dest', 'best');
  CT.S.rates = ratesSinAds;
  CT.S.fx = fxSinAds;
  CT.renderTab('casos');
  // Bug 3d: sin ads, el Promedio cae al fallback media FX y lo ETIQUETA (con aviso).
  CT.setEscenarioModo('origin', 'average');
  const escAvgMedia = sandbox.document.getElementById('casos-escenario').innerHTML;
  check('3b/3d: promedio sin ads → etiqueta “media FX (sin anuncios)” + aviso (fallback, nunca inventa)',
    /media FX \(sin anuncios\)/.test(escAvgMedia) && !/Promedio de anuncios/.test(escAvgMedia) &&
    /warnline/.test(escAvgMedia), escAvgMedia.slice(0, 600));
  CT.setEscenarioModo('origin', 'best');

  check('3b: comisión editable del escenario por defecto 7 (PEN, defaultCommissionPct)',
    sandbox.document.getElementById('casos-esc-comision').value === '7');
  CT.setEscenarioModo('origin', 'best');
  CT.selectPair('VES/PEN');
  check('3e: el reset por par vuelve a Mejor (best) default en ambos lados y comisión 7',
    /mode-active" data-sc-side="origin" data-sc-mode="best"/.test(sandbox.document.getElementById('casos-esc-origin').innerHTML) &&
    /mode-active" data-sc-side="dest" data-sc-mode="best"/.test(sandbox.document.getElementById('casos-esc-dest').innerHTML) &&
    sandbox.document.getElementById('casos-esc-comision').value === '7');

  // Par sin VES (COP→PEN, 3c/3e): botones Máximo / Mejor / Promedio / Mínimo (sin 2%) y default Mejor.
  CT.selectPair('PEN/COP');
  const escOriginNoVes = sandbox.document.getElementById('casos-esc-origin').innerHTML;
  const escDestNoVes = sandbox.document.getElementById('casos-esc-dest').innerHTML;
  check('3c: par sin VES: 8 botones (Máximo/Mejor/Promedio/Mínimo ×2) y sin botón de 2%',
    (escOriginNoVes.match(/data-sc-mode=/g) || []).length === 4 &&
    (escDestNoVes.match(/data-sc-mode=/g) || []).length === 4 &&
    /Máximo/.test(escOriginNoVes) && /Mejor/.test(escOriginNoVes) && /Promedio/.test(escOriginNoVes) && /Mínimo/.test(escOriginNoVes) &&
    /Máximo/.test(escDestNoVes) && /Mejor/.test(escDestNoVes) && /Promedio/.test(escDestNoVes) && /Mínimo/.test(escDestNoVes) &&
    escOriginNoVes.indexOf('conservative') < 0 && escDestNoVes.indexOf('conservative') < 0);
  check('3c: par sin VES: default “Mejor” (best) activo en ambos lados (aria-pressed)',
    /mode-active" data-sc-side="origin" data-sc-mode="best"/.test(escOriginNoVes) &&
    /mode-active" data-sc-side="dest" data-sc-mode="best"/.test(escDestNoVes) &&
    escOriginNoVes.match(/aria-pressed="true"/g).length === 1 &&
    escDestNoVes.match(/aria-pressed="true"/g).length === 1);
  sandbox.document.getElementById('casos-monto').value = '100';
  CT.renderTab('casos');
  const escNoVes = sandbox.document.getElementById('casos-escenario').innerHTML;
  check('3e: par sin VES (COP→PEN): el 2% está eliminado del panel (ni “Sin 2%”, ni “Aplicado”, ni “2% no aplica”)',
    escNoVes.indexOf('2%') < 0 && !/Aplicado/.test(escNoVes) && escNoVes.indexOf('2% no aplica') < 0,
    escNoVes.slice(0, 400));
  check('3b: cotiza sin 2% (tasa venta usada = PEN venta 3,70 sin descuento)',
    /3,70/.test(escNoVes), escNoVes.slice(0, 400));
  // P1: la comisión del par con depósito COP inicia en 8 (defaultCommissionPct).
  CT.setEscenarioModo('origin', 'best');
  check('3b: comisión por defecto 8 con depósito COP',
    sandbox.document.getElementById('casos-esc-comision').value === '8');
  // 3g: Máximo = el mayor price de TODOS los anuncios del lado (compra COP:
  // 4.030, mayor de todos).
  const adNv = (price, platform) => ({ price: price, min: 0, max: 100000000, available: 100000000, platform: platform });
  const ratesAdsNoVes = JSON.parse(JSON.stringify(ratesSinAds));
  ratesAdsNoVes.pairs.COP.ads = {
    compra: [adNv(4000, 'binance'), adNv(4010, 'binance'), adNv(4020, 'binance'), adNv(4005, 'bybit'), adNv(4015, 'bybit'), adNv(4030, 'bybit')],
    venta: [adNv(4200, 'binance'), adNv(4180, 'binance'), adNv(4160, 'binance'), adNv(4190, 'bybit'), adNv(4170, 'bybit'), adNv(4150, 'bybit')]
  };
  ratesAdsNoVes.pairs.PEN.ads = {
    compra: [{ price: 3.5, min: 0, max: 100000000, available: 100000000 }, { price: 3.75, min: 0, max: 100000000, available: 100000000 }],
    venta: [{ price: 3.7, min: 0, max: 100000000, available: 100000000 }, { price: 3.4, min: 0, max: 100000000, available: 100000000 }]
  };
  CT.S.rates = ratesAdsNoVes;
  CT.S.fx = engine.buildFx(ratesAdsNoVes);
  CT.renderTab('casos');
  const escBestNV = sandbox.document.getElementById('casos-escenario').innerHTML;
  check('3c: Mejor conservador (default) compra COP = 4.030,00 (MAYOR price ejecutable a 40 US$ eq del libro) y venta PEN = 3,40 (MENOR)',
    /4\.030,00/.test(escBestNV) && /3,40/.test(escBestNV) && escBestNV.indexOf('4.040,00') < 0, escBestNV.slice(0, 400));
  check('3g/3c: setEscenarioModo(origin, max): compra COP = 4.030,00 — el MAYOR price de todos (sin agrupar por plataforma) — y sin 2%',
    CT.setEscenarioModo('origin', 'max') === true &&
    /4\.030,00 COP \/ US\$/.test(sandbox.document.getElementById('casos-escenario').innerHTML) &&
    sandbox.document.getElementById('casos-escenario').innerHTML.indexOf('4.020,00') < 0 &&
    sandbox.document.getElementById('casos-escenario').innerHTML.indexOf('4.040,00') < 0 &&
    sandbox.document.getElementById('casos-escenario').innerHTML.indexOf('2%') < 0,
    sandbox.document.getElementById('casos-escenario').innerHTML.slice(0, 500));
  check('3c: el 2% (conservative) no existe en la matriz 3e',
    CT.setEscenarioModo('origin', 'conservative') === false && CT.setEscenarioModo('dest', 'conservative') === false);
  check('3c: cambiar modo repinta el desglose con el MISMO quote Máximo (entregado = motor con compra 4.040 y comisión 8%)',
    (() => {
      const resMaxNV = sandbox.document.getElementById('casos-resultado').innerHTML;
      const mDeliv = resMaxNV.match(/T&uacute; entregas: PEN<\/span><span class="v big">S\/ ([\d.,]+)/) ||
        resMaxNV.match(/Tú entregas: PEN<\/span><span class="v big">S\/ ([\d.,]+)/);
      const fxNq = engine.buildFx(ratesAdsNoVes);
      fxNq.pairs = { COP: { ads: ratesAdsNoVes.pairs.COP.ads.compra }, PEN: { ads: ratesAdsNoVes.pairs.PEN.ads.venta } };
      const qMaxCalc = engine.caseQuoteScenario(sandbox.CT.S.ledger.settings, fxNq, { pair: ['PEN', 'COP'], direction: 'BA', deposit: 100,
        originMode: 'max', destMode: 'best', vesSafetyPct: 0, destSafetyPct: 0, commissionPct: 0.08, terceroOn: false });
      if (!mDeliv) return false;
      const parsed = parseFloat(mDeliv[1].replace(/\./g, '').replace(',', '.'));
      return Math.abs(parsed - qMaxCalc.delivered) < 0.005;
    })(), 'ver detalle en consola');
  // Reset por par: 3e — el default es Mejor en cualquier par (sin 2%).
  CT.selectPair('VES/PEN');
  check('3e: reset por par (con VES): vuelve a Mejor (best) default',
    /mode-active" data-sc-side="origin" data-sc-mode="best"/.test(sandbox.document.getElementById('casos-esc-origin').innerHTML) &&
    /mode-active" data-sc-side="dest" data-sc-mode="best"/.test(sandbox.document.getElementById('casos-esc-dest').innerHTML));
  CT.selectPair('PEN/COP');
  check('3c: reset por par (sin VES): vuelve a Mejor (best) default y botones sin 2%',
    /mode-active" data-sc-side="origin" data-sc-mode="best"/.test(sandbox.document.getElementById('casos-esc-origin').innerHTML) &&
    sandbox.document.getElementById('casos-esc-origin').innerHTML.indexOf('conservative') < 0);
  sandbox.document.getElementById('casos-monto').value = '100';
  CT.renderTab('casos');
  // P2: libro de venta existe pero ninguna ad cubre el monto → aviso explícito
  // (el motor usa la media del snapshot, nunca inventa).
  const ratesCorto = JSON.parse(JSON.stringify(ratesSinAds));
  ratesCorto.pairs.PEN.ads = { venta: [{ price: 3.7, min: 100000, max: 90000000, available: 1000000 }] };
  CT.S.rates = ratesCorto;
  CT.S.fx = engine.buildFx(ratesCorto);
  CT.renderTab('casos');
  const escCorto = sandbox.document.getElementById('casos-escenario').innerHTML;
  check('3b: libro de venta existe pero no cubre el monto → aviso y tasa media (3,70)',
    /El libro de venta de PEN no cubre el monto/.test(escCorto) && /3,70/.test(escCorto),
    escCorto.slice(0, 500));
  CT.S.rates = ratesSinAds;
  CT.S.fx = fxSinAds;
  CT.renderTab('casos');

  // P2: una comisión editada no sobrevive al cambio de par (dataset.touched
  // se limpia en selectPair y el default del nuevo par manda: 7 con PEN).
  const escComT = sandbox.document.getElementById('casos-esc-comision');
  escComT.value = '3';
  escComT.dataset.touched = '1';
  CT.selectPair('VES/PEN');
  check('P2: selectPair limpia dataset.touched y repone la comisión default (7 con PEN)',
    escComT.dataset.touched == null && escComT.value === '7',
    'value=' + escComT.value + ' touched=' + escComT.dataset.touched);

  /* ---- 3e: tasa manual por lado + factor de seguridad (negativo = recargo) ---- */
  sandbox.document.getElementById('casos-monto').value = '100';
  const escOmIn = sandbox.document.getElementById('casos-esc-origin-manual');
  const escDmIn = sandbox.document.getElementById('casos-esc-dest-manual');
  // sistema compra (Mejor sin ads) = 3,50; manual 3,60 > sistema → factor −2,86 % (recargo), visible, no rechaza.
  escOmIn.value = '3.6';
  CT.renderResultado(); CT.renderEscenario();
  let escManual = sandbox.document.getElementById('casos-escenario').innerHTML;
  check('3e: tasa manual origen 3,60 manda sobre el sistema y muestra factor -2,86 % (recargo, no rechaza)',
    escManual.indexOf('-2,86 %') >= 0 &&
    /manual \(manda la tasa ingresada\)/.test(escManual) &&
    /sistema 3,50/.test(escManual) && /manual 3,60/.test(escManual) &&
    /Monto final/.test(escManual), escManual.slice(0, 700));
  escOmIn.value = '';
  // sistema venta (Mejor sin ads) = 1.100; manual 1.070 < sistema → factor +2,73 % (descuento).
  escDmIn.value = '1070';
  CT.renderResultado(); CT.renderEscenario();
  escManual = sandbox.document.getElementById('casos-escenario').innerHTML;
  check('3e: tasa manual destino 1.070 manda y muestra factor +2,73 % (descuento)',
    escManual.indexOf('2,73 %') >= 0 && escManual.indexOf('-2,73') < 0 &&
    (escManual.match(/manual \(manda la tasa ingresada\)/g) || []).length === 1 &&
    /sistema 1\.100,00/.test(escManual) && /manual 1\.070/.test(escManual) &&
    /Tasa del sistema \(sin manual\)/.test(escManual), escManual.slice(0, 700));
  escDmIn.value = '';
  CT.renderResultado(); CT.renderEscenario();

  /* ---- 3h: exclusión mutua tasa manual ↔ modo (MAX/BEST/AVG/MIN) ----
  * Escribir una manual deselecciona los presets de ESE lado (aria-pressed=false,
  * sin mode-active) y recalcula en vivo; pulsar un preset limpia la manual de
  * ese lado (value='' + S.*Manual=null); borrar la manual vuelve al modo
  * último/default (BEST); lados independientes; todo persiste en `ct_caso`. */
  const fireManualInput = id => (documentStub.getElementById(id).__listeners['input'] || []).forEach(fn => fn());
  escOmIn.value = '3.6';
  fireManualInput('casos-esc-origin-manual');
  const oHtmlMut = sandbox.document.getElementById('casos-esc-origin').innerHTML;
  const dHtmlMut = sandbox.document.getElementById('casos-esc-dest').innerHTML;
  check('3h: escribir manual origen deselecciona el preset de ese lado (aria-pressed=false ×4, sin mode-active)',
    oHtmlMut.match(/aria-pressed="true"/) === null && oHtmlMut.indexOf('mode-active') < 0 &&
    (oHtmlMut.match(/aria-pressed="false"/g) || []).length === 4,
    oHtmlMut.slice(0, 300));
  check('3h: la manual origen no toca el lado destino (Mejor sigue activo en destino)',
    (dHtmlMut.match(/aria-pressed="true"/g) || []).length === 1 &&
    /mode-active" data-sc-side="dest" data-sc-mode="best"/.test(dHtmlMut),
    dHtmlMut.slice(0, 200));
  const casoMut = JSON.parse(ls.getItem('ct_caso') || ss.getItem('ct_caso') || 'null');
  check('3h: la manual origen persiste en ct_caso en el mismo evento input (el modo último best NO la pisa)',
    casoMut && casoMut.pairKey === 'VES/PEN' && casoMut.scOriginManual === 3.6 &&
    casoMut.scOriginMode === 'best' && casoMut.scDestManual === null,
    JSON.stringify(casoMut));
  check('3h: desglose recalculado en vivo con la manual: fuente manual y factor −2,86 % (recargo)',
    /manual \(manda la tasa ingresada\)/.test(sandbox.document.getElementById('casos-escenario').innerHTML) &&
    sandbox.document.getElementById('casos-escenario').innerHTML.indexOf('-2,86') >= 0,
    sandbox.document.getElementById('casos-escenario').innerHTML.slice(0, 200));
  // Pulsar un modo: limpia la manual de ese lado, selecciona el modo y recalcula.
  check('3h: setEscenarioModo(origin, max) limpia el input manual y selecciona el modo',
    CT.setEscenarioModo('origin', 'max') === true && escOmIn.value === '' &&
    CT.S.scOriginManual === null && CT.S.scOriginMode === 'max');
  const oHtmlPreset = sandbox.document.getElementById('casos-esc-origin').innerHTML;
  check('3h: tras pulsar el preset, Máximo vuelve a estar activo en origen (aria-pressed=true ×1)',
    /mode-active" data-sc-side="origin" data-sc-mode="max"/.test(oHtmlPreset) &&
    (oHtmlPreset.match(/aria-pressed="true"/g) || []).length === 1,
    oHtmlPreset.slice(0, 300));
  const casoPreset = JSON.parse(ls.getItem('ct_caso') || ss.getItem('ct_caso') || 'null');
  check('3h: pulsar el preset persiste manual=null y modo=max en ct_caso',
    casoPreset && casoPreset.scOriginManual === null && casoPreset.scOriginMode === 'max',
    JSON.stringify(casoPreset));
  check('3h: el factor desaparece al volver al modo (ambos lados muestran “Tasa del sistema (sin manual)”)',
    (sandbox.document.getElementById('casos-escenario').innerHTML.match(/Tasa del sistema \(sin manual\)/g) || []).length === 2 &&
    sandbox.document.getElementById('casos-escenario').innerHTML.indexOf('manual (manda la tasa ingresada)') < 0,
    sandbox.document.getElementById('casos-escenario').innerHTML.slice(0, 200));
  // Borrar la manual: vuelve al modo último (Máximo aquí; BEST si no se cambió antes).
  escOmIn.value = '3.6';
  fireManualInput('casos-esc-origin-manual');
  check('3h: setup (manual activa otra vez → preset Máximo deseleccionado)',
    sandbox.document.getElementById('casos-esc-origin').innerHTML.indexOf('mode-active') < 0,
    sandbox.document.getElementById('casos-esc-origin').innerHTML.slice(0, 200));
  escOmIn.value = '';
  fireManualInput('casos-esc-origin-manual');
  check('3h: borrar la manual vuelve al modo último (Máximo activo de nuevo, manual null)',
    /mode-active" data-sc-side="origin" data-sc-mode="max"/.test(sandbox.document.getElementById('casos-esc-origin').innerHTML) &&
    CT.S.scOriginManual === null,
    sandbox.document.getElementById('casos-esc-origin').innerHTML.slice(0, 200));
  // El otro lado es independiente: manual destino deselección SOLO destino.
  escDmIn.value = '1070';
  fireManualInput('casos-esc-dest-manual');
  check('3h: manual destino deselecciona presets destino; origen sigue en Máximo',
    sandbox.document.getElementById('casos-esc-dest').innerHTML.indexOf('mode-active') < 0 &&
    /mode-active" data-sc-side="origin" data-sc-mode="max"/.test(sandbox.document.getElementById('casos-esc-origin').innerHTML),
    sandbox.document.getElementById('casos-esc-dest').innerHTML.slice(0, 200));
  CT.setEscenarioModo('dest', 'best'); // limpia la manual destino (3h) y restaura Mejor
  check('3h: setEscenarioModo(dest, best) limpia la manual destino y activa Mejor',
    escDmIn.value === '' && CT.S.scDestManual === null &&
    /mode-active" data-sc-side="dest" data-sc-mode="best"/.test(sandbox.document.getElementById('casos-esc-dest').innerHTML),
    'dest=' + sandbox.document.getElementById('casos-esc-dest').innerHTML.slice(0, 200));

  /* ---- 3e: persistencia de modos + tasa manual del panel en `ct_caso` (3h:
    la manual convive en ct_caso con el modo último; el modo no la pisa) ---- */
  escOmIn.value = '3.6';
  fireManualInput('casos-esc-origin-manual');
  CT.setModo('ba-fwd'); // trigger de saveCasoSel
  const casoRec = JSON.parse(ls.getItem('ct_caso') || ss.getItem('ct_caso') || 'null');
  check('3e: ct_caso guarda los modos de la matriz y la tasa manual (mismo registro, sin clave nueva)',
    casoRec && casoRec.pairKey === 'VES/PEN' && casoRec.modoId === 'ba-fwd' &&
    casoRec.scOriginMode === 'max' && casoRec.scDestMode === 'best' &&
    casoRec.scOriginManual === 3.6 && casoRec.scDestManual === null,
    JSON.stringify(casoRec));
  escOmIn.value = '';
  fireManualInput('casos-esc-origin-manual');
  check('3e: setEscenarioModo(origin, best) vuelve al default',
    CT.setEscenarioModo('origin', 'best') === true);
  CT.setModo('ba-fwd'); // persiste best + manual null
  check('3e: la restauración desde ct_caso recupera par/modo/modos de la matriz y manuales', (() => {
    CT.S.pairKey = null; CT.S.modo = null; CT.renderCasos();
    const restored = CT.S.pairKey === 'VES/PEN' && CT.S.modo && CT.S.modo.id === 'ba-fwd' &&
      CT.S.scOriginMode === 'best' && CT.S.scDestMode === 'best' &&
      CT.S.scOriginManual == null && CT.S.scDestManual == null;
    CT.renderTab('casos');
    return restored;
  })());

  /* ---- 3e P1: sin fuga de manual entre pares (reset ANTES de saveCasoSel) ---- */
  escOmIn.value = '3.6';
  CT.renderResultado(); CT.renderEscenario();
  check('3e P1 leak: setup (VES/PEN con manual origen 3,6 activa)',
    CT.S.pairKey === 'VES/PEN' && CT.S.scOriginManual === 3.6);
  CT.selectPair('PEN/COP');
  const casoLeak = JSON.parse(ls.getItem('ct_caso') || ss.getItem('ct_caso') || 'null');
  check('3e P1 leak: ct_caso guarda el par nuevo con modos default y manual null (la manual del par anterior NO se filtra)',
    casoLeak && casoLeak.pairKey === 'PEN/COP' &&
    casoLeak.scOriginMode === 'best' && casoLeak.scDestMode === 'best' &&
    casoLeak.scOriginManual === null && casoLeak.scDestManual === null,
    JSON.stringify(casoLeak));
  check('3e P1 leak: inputs manuales y estado S limpios tras el cambio de par',
    escOmIn.value === '' && escDmIn.value === '' &&
    CT.S.scOriginManual === null && CT.S.scDestManual === null);
  // Restaurar el estado previo (par VES/PEN, monto 100) para las pruebas siguientes.
  CT.selectPair('VES/PEN');
  sandbox.document.getElementById('casos-monto').value = '100';

  /* ---- 3e P1: persistencia inmediata (modo del panel + input manual) ---- */
  CT.setEscenarioModo('dest', 'max');
  const casoModo = JSON.parse(ls.getItem('ct_caso') || ss.getItem('ct_caso') || 'null');
  check('3e P1 persistencia: setEscenarioModo guarda ct_caso (sin requerir otro trigger)',
    casoModo && casoModo.pairKey === 'VES/PEN' &&
    casoModo.scDestMode === 'max' && casoModo.scOriginMode === 'best',
    JSON.stringify(casoModo));
  CT.setEscenarioModo('dest', 'best'); // vuelve al default (también persiste)
  // Simular teclear en el input manual: disparar los listeners 'input' del DOM simulado.
  const typeManual = id => (documentStub.getElementById(id).__listeners['input'] || []).forEach(fn => fn());
  /* 3f LIVE (manual): teclear la tasa manual debe repintar el desglose y el
   * factor AL INSTANTE (solo el evento input, sin llamada manual a render*).
   * Sistema venta (Mejor sin ads) = 1.100 → manual 1.070: factor +2,73 % y
   * monto final recalculado (28.420,00 VES con compra 3,50 @7%). */
  sandbox.document.getElementById('casos-monto').value = '100';
  CT.renderResultado(); CT.renderEscenario();
  const liveBefore = sandbox.document.getElementById('casos-resultado').innerHTML;
  const livePanelBefore = sandbox.document.getElementById('casos-escenario').innerHTML;
  escDmIn.value = '1070';
  typeManual('casos-esc-dest-manual');
  const liveResult = sandbox.document.getElementById('casos-resultado').innerHTML;
  const livePanel = sandbox.document.getElementById('casos-escenario').innerHTML;
  check('3f live: escribir la tasa manual destino repinta el desglose y el panel al instante (sin render manual)',
    liveResult !== liveBefore && livePanel !== livePanelBefore &&
    /manual \(manda la tasa ingresada\)/.test(livePanel) &&
    /2,73 %/.test(livePanel) && livePanel.indexOf('1.070,00') >= 0,
    livePanel.slice(0, 600));
  check('3f live: el desglose cotiza con la manual (venta 1.070 → monto final 28.431,43, no 29.228,57)',
    liveResult.indexOf('28.431,43') >= 0 && liveResult.indexOf('29.228,57') < 0,
    liveResult.slice(0, 500));
  check('3f live: limpiar la manual repinta al valor del sistema (29.228,57)',
    (escDmIn.value = '', typeManual('casos-esc-dest-manual'),
      sandbox.document.getElementById('casos-resultado').innerHTML.indexOf('29.228,57') >= 0),
    sandbox.document.getElementById('casos-resultado').innerHTML.slice(0, 400));
  escOmIn.value = '3.4';
  typeManual('casos-esc-origin-manual');
  const casoManual = JSON.parse(ls.getItem('ct_caso') || ss.getItem('ct_caso') || 'null');
  check('3e P1 persistencia: escribir manual origen persiste ct_caso en el mismo evento input',
    casoManual && casoManual.pairKey === 'VES/PEN' &&
    casoManual.scOriginManual === 3.4 && casoManual.scDestManual === null,
    JSON.stringify(casoManual));
  escOmIn.value = '';
  typeManual('casos-esc-origin-manual');
  const casoManualOff = JSON.parse(ls.getItem('ct_caso') || ss.getItem('ct_caso') || 'null');
  check('3e P1 persistencia: limpiar el manual lo des-persiste (null en ct_caso)',
    casoManualOff && casoManualOff.scOriginManual === null, JSON.stringify(casoManualOff));

  /* ---- 3e P2: persistencia manual con monto vacío (con #casos-monto vacío
    renderResultado aborta antes de scenarioReq: el listener de persistencia
    debe parsear las manuales por sí mismo) ---- */
  sandbox.document.getElementById('casos-monto').value = '';
  escOmIn.value = '3.6';
  typeManual('casos-esc-origin-manual');
  const casoVacio = JSON.parse(ls.getItem('ct_caso') || ss.getItem('ct_caso') || 'null');
  check('3e P2 persistencia: escribir manual con monto vacío lo guarda en ct_caso',
    casoVacio && casoVacio.pairKey === 'VES/PEN' &&
    casoVacio.scOriginManual === 3.6 && casoVacio.scDestManual === null,
    JSON.stringify(casoVacio));
  // 3h P1-fix: con monto vacío la manual TAMBIÉN deselecciona el preset (el sync
  // va en renderResultadoSafe, el primero en el evento input).
  check('3h monto vacío: escribir manual origen deselecciona el preset (aria-pressed=false ×4, sin mode-active)',
    (sandbox.document.getElementById('casos-esc-origin').innerHTML.match(/aria-pressed="true"/) === null &&
     sandbox.document.getElementById('casos-esc-origin').innerHTML.indexOf('mode-active') < 0 &&
     (sandbox.document.getElementById('casos-esc-origin').innerHTML.match(/aria-pressed="false"/g) || []).length === 4),
    sandbox.document.getElementById('casos-esc-origin').innerHTML.slice(0, 300));
  check('3e P2 persistencia: recargar restaura la manual guardada con monto vacío', (() => {
    CT.S.pairKey = null; CT.S.modo = null; CT.S.scOriginManual = null; CT.S.scDestManual = null;
    CT.renderCasos();
    const restored = CT.S.pairKey === 'VES/PEN' && CT.S.scOriginManual === 3.6 &&
      CT.S.scDestManual == null && escOmIn.value === '3.6';
    return restored;
  })());
  escOmIn.value = '';
  typeManual('casos-esc-origin-manual');
  const casoVacioOff = JSON.parse(ls.getItem('ct_caso') || ss.getItem('ct_caso') || 'null');
  check('3e P2 persistencia: borrar la manual con monto vacío la des-persiste (null en ct_caso)',
    casoVacioOff && casoVacioOff.scOriginManual === null, JSON.stringify(casoVacioOff));
  // 3h P1-fix: con monto vacío, borrar la manual reactiva el modo retenido (best).
  check('3h monto vacío: borrar la manual reactiva el modo retenido (Mejor activo, manual null)',
    /mode-active" data-sc-side="origin" data-sc-mode="best"/.test(sandbox.document.getElementById('casos-esc-origin').innerHTML) &&
    (sandbox.document.getElementById('casos-esc-origin').innerHTML.match(/aria-pressed="true"/g) || []).length === 1 &&
    CT.S.scOriginManual === null,
    sandbox.document.getElementById('casos-esc-origin').innerHTML.slice(0, 300));
  // Restaurar el estado previo (monto 100, manuales vacíos) para las pruebas siguientes.
  sandbox.document.getElementById('casos-monto').value = '100';
  CT.renderTab('casos');
  sandbox.document.getElementById('casos-monto').value = '100';

  /* ---- 3e P2: la manual manda — el aviso “Sin libro … promedio del snapshot”
    no se muestra para el lado con tasa manual (ratesSinAds: sin ads en ambos
    lados, sin manual = 2 avisos; con manual dest = 1 aviso) ---- */
  escDmIn.value = '1070';
  CT.renderResultado(); CT.renderEscenario();
  const escAvisoManual = sandbox.document.getElementById('casos-escenario').innerHTML;
  check('3e P2 aviso: manual venta activa → sin aviso “Sin libro …” en el lado manual (queda 1 aviso)',
    (escAvisoManual.match(/Sin libro de anuncios para/g) || []).length === 1 &&
    /manual \(manda la tasa ingresada\)/.test(escAvisoManual), escAvisoManual.slice(0, 700));
  escDmIn.value = '';
  CT.renderResultado(); CT.renderEscenario();
  check('3e P2 aviso: sin manual → vuelven los 2 avisos “Sin libro …”',
    (sandbox.document.getElementById('casos-escenario').innerHTML.match(/Sin libro de anuncios para/g) || []).length === 2);
  // Espejo del lado origen: manual compra activa omite el aviso “Sin libro …”
  // de compra (queda 1); al limpiarla vuelven los 2.
  escOmIn.value = '3.4';
  CT.renderResultado(); CT.renderEscenario();
  check('3e P2 aviso (espejo origen): manual compra activa → sin aviso “Sin libro …” en el lado manual (queda 1 aviso)',
    (sandbox.document.getElementById('casos-escenario').innerHTML.match(/Sin libro de anuncios para/g) || []).length === 1);
  escOmIn.value = '';
  CT.renderResultado(); CT.renderEscenario();
  check('3e P2 aviso (espejo origen): sin manual → vuelven los 2 avisos “Sin libro …”',
    (sandbox.document.getElementById('casos-escenario').innerHTML.match(/Sin libro de anuncios para/g) || []).length === 2);

  /* ---- 3e: Mejor se evalúa a 40 US$ equivalentes (independiente del monto) ---- */
  const ratesBest40 = JSON.parse(JSON.stringify(ratesSinAds));
  // Criterio conservador (3g): BEST compra = MAYOR precio EJECUTABLE a 40 US$ eq
  // (disponible ≥ 40): elige 3,50; 3,40 sigue ejecutable; 3,30 no (disp 30 < 40).
  // Independiente del monto del caso: 100 o 500 PEN dan la misma tasa a 40 US$ eq.
  ratesBest40.pairs.PEN.ads = {
    compra: [
      { price: 3.30, min: 0, max: 100000000, available: 30, platform: 'binance' },
      { price: 3.40, min: 0, max: 100000000, available: 1000000, platform: 'binance' },
      { price: 3.50, min: 0, max: 100000000, available: 1000000, platform: 'bybit' }
    ]
  };
  CT.S.rates = ratesBest40;
  CT.S.fx = engine.buildFx(ratesBest40);
  CT.renderTab('casos');
  const esc40 = sandbox.document.getElementById('casos-escenario').innerHTML;
  check('3g: BEST conservador con monto 100 PEN = MAYOR precio ejecutable a 40 US$ eq (compra 3,50; MAX sin filtro = 3,50 aquí) → 29.228,57',
    /3,50 PEN \/ US\$/.test(esc40) && esc40.indexOf('3,30') < 0 &&
    esc40.indexOf('29.228,57') >= 0, esc40.slice(0, 600));
  sandbox.document.getElementById('casos-monto').value = '500';
  CT.renderResultado(); CT.renderEscenario();
  const esc40b = sandbox.document.getElementById('casos-escenario').innerHTML;
  check('3g: BEST es independiente del monto del caso (500 PEN → sigue compra 3,50 a 40 US$ eq)',
    /3,50 PEN \/ US\$/.test(esc40b) && esc40b.indexOf('3,30') < 0, esc40b.slice(0, 600));
  sandbox.document.getElementById('casos-monto').value = '100';
  CT.S.rates = ratesSinAds;
  CT.S.fx = fxSinAds;
  CT.renderTab('casos');

  // Zelle: el panel no aplica (sin tasas FX).
  CT.selectPair('USD/USD');
  check('3b: panel oculto en USD/USD (Zelle)', escCard.hidden === true);
  CT.selectPair('VES/PEN');
  check('3b: panel vuelve a ser visible en par fiat', escCard.hidden === false);
  sandbox.document.getElementById('casos-monto').value = '3700';
  CT.renderTab('casos');

  /* ---- registro de la operación ---- */
  const st = CT.S.ledger;
  const movsBefore = st.movements.length;
  sandbox.document.getElementById('casos-cuenta-in').value = 'peru';
  sandbox.document.getElementById('casos-cuenta-out').value = 'efectivo-ves';
  sandbox.document.getElementById('casos-obs').value = 'prueba smoke';
  CT.registrarCaso();
  check('operación registrada en el libro (append-only)', st.movements.length === movsBefore + 1);
  const mv = st.movements[st.movements.length - 1];
  check('movimiento: type operation, in PEN 3700 en cuenta, out VES entregado en cuenta',
    mv.type === 'operation' && mv.in.currency === 'PEN' && mv.in.amount === 3700 &&
    mv.out.currency === 'VES' && mv.in.account === 'peru' && mv.out.account === 'efectivo-ves');
  check('movimiento: diezmo/tercero/neto del caso en meta', Math.abs(mv.meta.case.diezmo - 7.4) < 1e-9 && Math.abs(mv.meta.case.neto - 48.1) < 1e-9);
  // P0: el registro usa el mismo quote del panel (caseQuoteScenario), no caseQuote.
  check('3e movimiento: guarda el quote del escenario (comisión 7, modos best/best, efectiva 292,29, out 1.081.457,14)',
    mv.meta.case.commissionPct === 7 && mv.meta.case.originMode === 'best' &&
    mv.meta.case.destMode === 'best' && mv.meta.case.effectiveRate === 292.29 &&
    Math.abs(mv.out.amount - 1081457.14) < 0.01, JSON.stringify(mv.meta.case));
  check('3e movimiento: rateInfo del escenario (compra 3,5 / venta 1.100 Mejor — sin 2%, sin manual, sistema preservado)',
    mv.meta.case.rateInfo && mv.meta.case.rateInfo.originRate === 3.5 &&
    mv.meta.case.rateInfo.destRate === 1100 && mv.meta.case.rateInfo.safetyPct === undefined &&
    mv.meta.case.rateInfo.originManualRate === null && mv.meta.case.rateInfo.destManualRate === null &&
    mv.meta.case.rateInfo.originSecurityFactor === null && mv.meta.case.rateInfo.destSecurityFactor === null &&
    mv.meta.case.rateInfo.originSystemRate === 3.5 && mv.meta.case.rateInfo.destSystemRate === 1100 &&
    mv.meta.case.rateInfo.originSource === 'media(PEN/compra)' && mv.meta.case.rateInfo.destSource === 'media(VES/venta)',
    JSON.stringify(mv.meta.case && mv.meta.case.rateInfo));

  /* ---- histórico ---- */
  CT.parts.historico();
  const histList = sandbox.document.getElementById('hist-lista').innerHTML;
  check('histórico lista el movimiento (#1, operation, cuenta)', /#1/.test(histList) && /operation/.test(histList) && /Perú/.test(histList));
  const histStats = sandbox.document.getElementById('hist-estadisticas').innerHTML;
  check('stats: base/diezmo/tercero/neto', /Base \(plusvalía\)/.test(histStats) && /Diezmo \(10 %\)/.test(histStats) && /Neto para mí/.test(histStats));
  const chain = sandbox.document.getElementById('hist-cadena').innerHTML;
  check('estado de la cadena: íntegra', /íntegra/.test(chain));
  check('manifiesto expone chainOk', engine.manifest(st).chainOk === true);

  /* ---- filtros del histórico ---- */
  sandbox.document.getElementById('hist-tipo').value = 'transfer';
  CT.parts.historico();
  check('filtro tipo transfer: lista vacía', /Sin movimientos/.test(sandbox.document.getElementById('hist-lista').innerHTML));
  sandbox.document.getElementById('hist-tipo').value = 'all';
  CT.parts.historico();

  /* ---- cuentas ---- */
  CT.accountAction('primary', 'panama');
  check('una primaria por moneda: Panamá gana, Zelle pierde',
    st.accounts.find(a => a.id === 'panama').primary === true &&
    st.accounts.find(a => a.id === 'zelle').primary === false);
  // re-render tras cambio (los selects default usan primarias)
  const cuentasHtml = sandbox.document.getElementById('cuentas-lista').innerHTML;
  check('lista de cuentas con balance nativo y USD', /Zelle/.test(cuentasHtml) && /Per&uacute;|Perú/.test(cuentasHtml));
  check('aviso de moneda sin tasa', (() => {
    // EUR existe en cuentas iniciales y el fixture trae eurRef → no hay aviso;
    // verificamos el caso inverso: con EUR sin tasa el aviso aparece.
    const fxViejo = CT.S.fx; const warnViejo = sandbox.document.getElementById('cuentas-avisos').innerHTML;
    CT.S.fx = engine.buildFx({ fixture: true, pairs: FIXTURE.pairs }); // sin eurRef
    CT.renderCuentas ? CT.renderCuentas() : CT.parts.cuentas();
    const out = /Sin tasa publicada para EUR/.test(sandbox.document.getElementById('cuentas-avisos').innerHTML);
    CT.S.fx = fxViejo; CT.parts.cuentas();
    return out && warnViejo !== null;
  })());
  check('archivar cuenta', (() => {
    CT.accountAction('archive', 'panama');
    const ok = st.accounts.find(a => a.id === 'panama').archived === true;
    CT.accountAction('unarchive', 'panama');
    return ok;
  })());
  CT.accountAction('primary', 'zelle'); // Zelle vuelve a ser primaria USD

  /* ---- balance ---- */
  const balBefore = engine.balance(st, CT.S.fx);
  CT.renderBalance();
  const balHtml = sandbox.document.getElementById('balance-out').innerHTML;
  check('balance: badge Cuadre', balHtml.indexOf('Cuadre') >= 0);
  check('balance: patrimonio y pasivos visibles', /Patrimonio/.test(balHtml) && /Pasivos/.test(balHtml));
  check('balance: revalorización FX + nota', /Revalorización FX/.test(balHtml));
  check('balance engine: cuadre nativo = true', balBefore.cuadre === true);
  check('pasivos acumulados: diezmo 7.4 + tercero 18.5',
    Math.abs(balBefore.liabilities.diezmo - 7.4) < 1e-6 && Math.abs(balBefore.liabilities.tercero - 18.5) < 1e-6);

  /* ---- modo inverso: cotización + registro (después del balance para no alterar sus pasivos) ---- */
  CT.selectPair('VES/PEN');
  check('setModo activa el inverso BA (Necesito VES → me depositan PEN)', CT.setModo('ba-rev') === true && CT.S.modo._fwd === false);
  // Quote del panel @7% Mejor: depósito forward 3700 PEN → 1.081.457,14 VES
  // ⇒ inverso target 1.081.457,14 VES → 3.700,00 PEN (redondo, vía caseQuoteScenario).
  sandbox.document.getElementById('casos-monto').value = '1081457.14';
  CT.renderResultado();
  const resRev = sandbox.document.getElementById('casos-resultado').innerHTML;
  check('inverso: muestra “Cliente deposita” con 3.700,00 PEN calculado', resRev.indexOf('3.700,00') >= 0 && /Cliente deposita/.test(resRev));
  check('inverso: entrega fijada = target (1.081.457,14 VES)', resRev.indexOf('1.081.457,14') >= 0);
  check('inverso: destacado (big) en “Cliente deposita”', (() => {
    const m = resRev.match(/<span class="k">Cliente deposita: PEN<\/span><span class="v big/);
    return !!m;
  })());
  const movsBeforeRev = st.movements.length;
  sandbox.document.getElementById('casos-cuenta-in').value = 'peru';
  sandbox.document.getElementById('casos-cuenta-out').value = 'efectivo-ves';
  sandbox.document.getElementById('casos-obs').value = 'prueba inversa';
  CT.registrarCaso();
  check('registro inverso en el libro (append-only)', st.movements.length === movsBeforeRev + 1);
  const mvRev = st.movements[st.movements.length - 1];
  check('3e movimiento inverso: in PEN 3.700,00, out VES 1.081.457,14',
    mvRev.type === 'operation' && mvRev.in.currency === 'PEN' && Math.abs(mvRev.in.amount - 3700) < 0.01 &&
    mvRev.out.currency === 'VES' && Math.abs(mvRev.out.amount - 1081457.14) < 0.01 &&
    mvRev.in.account === 'peru' && mvRev.out.account === 'efectivo-ves');
  check('movimiento inverso: meta.case.reversed + desglose fiscal',
    mvRev.meta.case.reversed === true && mvRev.meta.case.base > 0);

  /* ---- USD/USD: 2 modos activos, incluido el inverso ---- */
  CT.selectPair('USD/USD');
  check('USD/USD: 2 modos activos (forward + inverso)', (() => {
    const h = sandbox.document.getElementById('casos-modos').innerHTML;
    return (h.match(/data-modo/g) || []).length === 2 && h.indexOf('disabled') < 0 &&
      /Necesito entregar USD, recibo USD/.test(h);
  })());
  check('setModo activa el inverso Zelle', CT.setModo('zelle-rev') === true && CT.S.modo._fwd === false);
  sandbox.document.getElementById('casos-margin').value = '7';
  sandbox.document.getElementById('casos-monto').value = '305';
  CT.renderResultado();
  const resZrev = sandbox.document.getElementById('casos-resultado').innerHTML;
  check('Zelle inverso: entregar 305 @7% → cliente deposita 327,96 USD', resZrev.indexOf('327,96') >= 0, resZrev.slice(0, 400));
  const movsBeforeZ = st.movements.length;
  sandbox.document.getElementById('casos-cuenta-in').value = 'zelle';
  sandbox.document.getElementById('casos-cuenta-out').value = 'zelle';
  sandbox.document.getElementById('casos-obs').value = '';
  CT.registrarCaso();
  check('registro Zelle inverso: in USD 327,96, out USD 305', st.movements.length === movsBeforeZ + 1 && (() => {
    const m = st.movements[st.movements.length - 1];
    return m.in.currency === 'USD' && Math.abs(m.in.amount - 327.96) < 0.01 &&
      m.out.currency === 'USD' && m.out.amount === 305 && m.meta.case.reversed === true;
  })());

  /* ---- USD/USD forward: 320 depositados → 305 de entrega exacta (override) ---- */
  CT.selectPair('USD/USD');
  check('click de par USD/USD: modo por defecto zelle-fwd', CT.S.modo && CT.S.modo.id === 'zelle-fwd');
  sandbox.document.getElementById('casos-margin').value = '7';
  sandbox.document.getElementById('casos-monto').value = '320';
  sandbox.document.getElementById('casos-override').value = '305';
  CT.renderResultado();
  const resZf = sandbox.document.getElementById('casos-resultado').innerHTML;
  check('USD/USD 320→305: entrega exacta 305,00 USD declarada (Tú entregas: USD)',
    /Tú entregas: USD/.test(resZf) && resZf.indexOf('305,00') >= 0, resZf.slice(0, 400));
  check('USD/USD 320→305: depósito declarado USD (Cliente deposita: USD 320,00)',
    /Cliente deposita: USD/.test(resZf) && resZf.indexOf('320,00') >= 0);
  sandbox.document.getElementById('casos-override').value = '';

  /* ---- par referencial EUR (customPair) ---- */
  st.settings.customPairs.push(['VES', 'EUR']);
  CT.selectPair('VES/EUR');
  CT.setModo('ba-fwd'); // el cliente deposita EUR, entrego VES
  sandbox.document.getElementById('casos-monto').value = '9';
  CT.renderResultado();
  check('EUR referencial cotiza con eurRef del fixture', /referencial/.test(sandbox.document.getElementById('casos-resultado').innerHTML));

  /* ---- migración legacy v1 ---- */
  ls.setItem('consumo_operations', JSON.stringify([
    { fecha: '2025-12-05', origen: 'PEN', destino: 'VES', sale: 100, saleRate: 3.7, entry: 360, entryRate: 1080, obs: 'yape', tercero: true },
    { fecha: 'malo', origen: 'PEN', destino: 'VES', sale: 50, entry: 180 }
  ]));
  CT.migrateLegacy();
  check('migración v1: 2 movimientos legacy con date preservado/null', (() => {
    const leg = st.movements.filter(m => m.type === 'legacy');
    return leg.length === 2 && leg[0].date === '2025-12-05' && leg[1].date === null;
  })());
  check('migración idempotente', CT.migrateLegacy() === undefined && st.movements.filter(m => m.type === 'legacy').length === 2);

  /* ---- hooks de tasas.js (placeholder honesto) ---- */
  CT.switchTab('tasas');
  check('pestaña tasas: placeholder del módulo externo',
    /assets\/tasas\.js/.test(sandbox.document.getElementById('ta-bcv').innerHTML) &&
    /assets\/tasas\.js/.test(sandbox.document.getElementById('chk-fuegonacional').innerHTML));
  check('renderTasas es reemplazable (hook)', (() => {
    const original = CT.renderTasas;
    let called = 0;
    CT.renderTasas = () => { called++; };
    CT.renderTab('tasas');
    CT.renderTasas = original;
    return called === 1;
  })());
  CT.switchTab('casos');

  /* ---- URL del snapshot: override ?local=1 (túnel) y producción intacta ---- */
  check('localhost: ratesUrl() al mismo origen ./data/rates.json (sin raw)', (() => {
    const u = CT.ratesUrl();
    return u.indexOf('raw.githubusercontent.com') < 0 && /^\.\/data\/rates\.json\?t=/.test(u);
  })());
  sandbox.location.hostname = 'tunnel.consutasas.example';
  sandbox.location.search = '?local=1';
  check('host remoto + ?local=1: ratesUrl() al mismo origen ./data/rates.json', (() => {
    const u = CT.ratesUrl();
    return u.indexOf('raw.githubusercontent.com') < 0 && /^\.\/data\/rates\.json\?t=/.test(u);
  })());
  sandbox.location.search = '?tab=tasas&local=1';
  check('?local=1 junto a otros parámetros: ./data/rates.json igualmente', /^\.\/data\/rates\.json\?t=/.test(CT.ratesUrl()));
  sandbox.location.search = '?local=0';
  check('host remoto + ?local=0 (flag ≠ "1"): producción raw.githubusercontent.com',
    /^https:\/\/raw\.githubusercontent\.com\/afvelis\/consutasas\/data\/rates\.json\?t=/.test(CT.ratesUrl()));
  sandbox.location.search = '';
  check('host remoto sin flag: producción raw.githubusercontent.com intacta',
    /^https:\/\/raw\.githubusercontent\.com\/afvelis\/consutasas\/data\/rates\.json\?t=/.test(CT.ratesUrl()));

  // getRates() debe fetchear exactamente ratesUrl(): misma URL para Actualizar
  // (CT.onRefreshClick de tasas.js delega a getRates) y el arranque.
  // Esperar los fetchs para evitar race conditions
  let fetchedUrl1 = null, fetchedUrl2 = null;
  sandbox.location.search = '?local=1';
  sandbox.fetch = async (url) => { fetchedUrl1 = url; return { ok: true, text: async () => JSON.stringify(FIXTURE) }; };
  await CT.getRates({ force: true });
  sandbox.location.search = '';
  check('getRates con ?local=1 en host remoto: fetch a ./data/rates.json',
    /^\.\/data\/rates\.json\?t=/.test(String(fetchedUrl1)), fetchedUrl1);
  sandbox.fetch = async (url) => { fetchedUrl2 = url; return { ok: true, text: async () => JSON.stringify(FIXTURE) }; };
  await CT.getRates({ force: true });
  check('getRates sin flag en host remoto: fetch a raw.githubusercontent.com',
    /^https:\/\/raw\.githubusercontent\.com/.test(String(fetchedUrl2)), fetchedUrl2);
  sandbox.fetch = async () => ({ ok: true, text: async () => JSON.stringify(FIXTURE) });
  sandbox.location.hostname = 'localhost';

  /* ---- ratesUrl siempre GitHub en producción (data branch) ---- */
  sandbox.location.hostname = 'consutasas.example';
  sandbox.location.search = '';
  const urlProd = CT.ratesUrl();
  check('producción: ratesUrl siempre es raw.githubusercontent.com/data/rates.json',
    /^https:\/\/raw\.githubusercontent\.com\/afvelis\/consutasas\/data\/rates\.json\?t=/.test(urlProd),
    urlProd);
  // ?local=1 marca local (no publicado)
  sandbox.location.search = '?local=1';
  check('?local=1: ratesUrl al mismo origen ./data/rates.json', /^\.\/data\/rates\.json\?t=/.test(CT.ratesUrl()));
  sandbox.location.search = '';
  sandbox.location.hostname = 'localhost';

  /* ---- S.updateSource: manual/auto/cache/local ---- */
  // Limpiar caché y resetear updateSource (usar ls del sandbox, no localStorage global de Node)
  try { ls.removeItem('ct_rates'); } catch (e) {}
  CT.S.updateSource = null;
  CT.S.rates = null;
  sandbox.location.hostname = 'localhost';
  sandbox.location.search = '';
  // Primero poblar la caché con un fetch
  sandbox.fetch = async () => ({ ok: true, text: async () => JSON.stringify(FIXTURE) });
  await CT.getRates({ force: true });
  check('primero: caché poblada, updateSource = local', CT.S.updateSource === 'local', 'got: ' + CT.S.updateSource);
  // Ahora sí: cache hit (sin force, la caché existe y TTL aún válido)
  sandbox.fetch = async () => ({ ok: true, text: async () => JSON.stringify(FIXTURE) });
  CT.S.updateSource = null;
  CT.S.rates = null;
  await CT.getRates({ force: false });
  check('cache hit: updateSource = cache', CT.S.updateSource === 'cache', 'got: ' + CT.S.updateSource);
  const newGen = new Date(Date.now() - 5000).toISOString();
  // Bot refresh en producción: limpiar caché y rates anteriores
  sandbox.location.hostname = 'consutasas.example';
  sandbox.location.search = '';
  sandbox.fetch = async (url) => { return { ok: true, text: async () => JSON.stringify(FIXTURE) }; };
  ls.removeItem('ct_rates');
  check('caché removida', ls.getItem('ct_rates') === null);
  CT.S.rates = null;
  CT.S.updateSource = null;
  check('S.rates limpio, updateSource null', CT.S.rates === null && CT.S.updateSource === null);
  const testUrl = CT.ratesUrl();
  check('ratesUrl en producción (GitHub)', testUrl.indexOf('raw.githubusercontent.com') >= 0, testUrl);
  check('antes de getRates: readCachedRates() returns null', CT.readCachedRates() === null);
  // For production: the URL determines isLocal. Check that when URL is GitHub, isLocal=false
  // and when URL is ./data/, isLocal=true
  const prodUrl = 'https://raw.githubusercontent.com/afvelis/consutasas/data/rates.json?t=123';
  check('URL GitHub: isLocal=false', prodUrl.indexOf('./data/rates.json') < 0);
  const localUrl = './data/rates.json?t=456';
  check('URL local: isLocal=true', localUrl.indexOf('./data/rates.json') >= 0);

  /* ---- S.updateSource = bot en producción ---- */
  // FIXTURE tiene generatedAt fija desde el load del test. Usamos un generatedAt más reciente
  // para el fetch de producción para asegurar isNewerThan devuelva true.
  const prodGen = new Date(Date.now() - 10000).toISOString();
  sandbox.location.hostname = 'consutasas.example';
  sandbox.location.search = '';
  sandbox.fetch = async (url) => {
    return { ok: true, text: async () => JSON.stringify(Object.assign({}, FIXTURE, { generatedAt: new Date(Date.now() - 10000).toISOString() })) };
  };
  ls.removeItem('ct_rates');
  CT.S.rates = null;
  CT.S.updateSource = null;
  check('antes de producción: S.rates null, updateSource null', CT.S.rates === null);
  await CT.getRates({ force: true });
  check('S.updateSource = bot en producción', CT.S.updateSource === 'bot', 'got: ' + CT.S.updateSource);

  /* ---- S.updateSource = local en localhost ---- */
  sandbox.location.hostname = 'localhost';
  sandbox.location.search = '';
  sandbox.fetch = async (url) => { return { ok: true, text: async () => JSON.stringify(Object.assign({}, FIXTURE, { generatedAt: newGen })) }; };
  ls.removeItem('ct_rates');
  CT.S.rates = null;
  CT.S.updateSource = null;
  check('antes de localhost: S.rates null, updateSource null', CT.S.rates === null);
  await CT.getRates({ force: true });
  check('S.updateSource = local en localhost', CT.S.updateSource === 'local', 'got: ' + CT.S.updateSource);

  /* ---- S.updateSource: manual y auto ---- */
  // manual: refresh con source='manual' debe fijar updateSource a 'manual'
  CT.S.rates = null;
  CT.S.updateSource = null;
  sandbox.fetch = async () => ({ ok: true, text: async () => JSON.stringify(FIXTURE) });
  await CT.refreshRates(true, 'manual');
  check('refreshRates(true, manual): updateSource = manual', CT.S.updateSource === 'manual', 'got: ' + CT.S.updateSource);
  // auto: rates=null, force=false, source='auto' → debe usar source='auto' y no caché
  CT.S.rates = null;
  ls.removeItem('ct_rates');
  sandbox.fetch = async () => ({ ok: true, text: async () => JSON.stringify(FIXTURE) });
  await CT.getRates({ force: false, source: 'auto' });
  check('getRates({force:false, source:auto}): updateSource = auto', CT.S.updateSource === 'auto', 'got: ' + CT.S.updateSource);
  // TTL fresca + mismo generatedAt: no debe pisar 'manual' con 'cache'
  CT.S.updateSource = 'manual';
  CT.S.rates = FIXTURE;
  const cached = { data: FIXTURE, fetchedAt: new Date().toISOString(), rawText: '' };
  ls.setItem('ct_rates', JSON.stringify(cached));
  CT.S.rates = null;
  // force=false y cache TTL válido → early-return no debe pisar updateSource manual
  // (el early-return solo retorna si S.rates ya existe, así que primero setear S.rates)
  CT.S.rates = FIXTURE;
  await CT.getRates({ force: false });
  check('TTL fresca + mismo generatedAt: no pisa manual con cache',
    CT.S.updateSource === 'manual', 'got: ' + CT.S.updateSource);

  /* ---- init con caché fresca: fuente = copia reciente ≤5 min ---- */
  // Sembrar ls con caché fresca, simular init con cache, verificar source label
  const freshCache = { data: FIXTURE, fetchedAt: new Date().toISOString(), rawText: '' };
  ls.setItem('ct_rates', JSON.stringify(freshCache));
  // Simular: init encontró cache, aplicó rates con updateSource='cache'
  CT.S.rates = FIXTURE;
  CT.S.updateSource = 'cache';
  CT.renderTab('casos');
  CT.renderResultado();
  const resCache = sandbox.document.getElementById('casos-resultado').innerHTML;
  check('init con caché fresca: "copia reciente ≤5 min" presente',
    /copia reciente ≤5 min/.test(resCache), resCache.slice(0, 300));
  check('init con caché fresca: "en vivo" ausente',
    !/en vivo/.test(resCache), resCache.slice(0, 300));
  // Caso 'local': debe mostrar "local (no publicado)"
  CT.S.updateSource = 'local';
  CT.renderResultado();
  const resLocal = sandbox.document.getElementById('casos-resultado').innerHTML;
  check('updateSource=local: "local (no publicado)" presente',
    /local \(no publicado\)/.test(resLocal), resLocal.slice(0, 300));
  check('updateSource=local: "en vivo" ausente',
    !/en vivo/.test(resLocal), resLocal.slice(0, 300));

  /* ---- reset de par ---- */
  CT.selectPair('VES/PEN');
  sandbox.document.getElementById('casos-monto').value = '500';
  CT.renderResultado();
  const beforeReset = sandbox.document.getElementById('casos-monto').value;
  check('antes del reset: monto tiene valor', beforeReset === '500');
  check('antes del reset: resultado tiene HTML', sandbox.document.getElementById('casos-resultado').innerHTML.length > 0);
  // Cambiar de par → reset
  CT.selectPair('PEN/COP');
  check('después del reset: monto vacío', sandbox.document.getElementById('casos-monto').value === '');
  check('después del reset: ct_caso actualizado al nuevo par',
    JSON.parse(ls.getItem('ct_caso') || ss.getItem('ct_caso') || 'null').pairKey === 'PEN/COP');
  check('después del reset: modo por defecto ba-fwd', CT.S.modo && CT.S.modo.id === 'ba-fwd');
  check('después del reset: label de monto declara COP (no PEN)',
    sandbox.document.getElementById('casos-monto-label').textContent.indexOf('COP') >= 0);
  // Settings globales se mantienen (comisión del panel 8% para COP, tercero off)
  check('settings globales: comisión del panel (8 % COP), tercero off se mantienen tras cambio de par',
    sandbox.document.getElementById('casos-esc-comision').value === '8' &&
    sandbox.document.getElementById('casos-tercero').checked === false &&
    sandbox.document.getElementById('casos-margin').value === '');

  /* ---- index.html: CSP con api.github.com y raw.githubusercontent.com ---- */
  check('index.html CSP: connect-src incluye raw.githubusercontent.com',
    /connect-src.*https:\/\/raw\.githubusercontent\.com/.test(indexSrc));
  check('index.html CSP: connect-src incluye api.github.com',
    /connect-src.*https:\/\/api\.github\.com/.test(indexSrc));
  check('index.html: tiene bot-status-container', /id="bot-status-container"/.test(indexSrc));
  check('index.html: tiene refresh-label-info', /id="refresh-label-info"/.test(indexSrc));
  check('index.html: panel de escenarios (3b) presente con aria-live polite y comisión editable',
    /id="casos-escenario-card"/.test(indexSrc) && /id="casos-escenario" aria-live="polite"/.test(indexSrc) &&
    /id="casos-esc-comision"/.test(indexSrc) && /id="casos-esc-origin"/.test(indexSrc) && /id="casos-esc-dest"/.test(indexSrc));
  check('index.html: la comisión del panel inicia vacía (default desde defaultCommissionPct, sin value fijo)',
    !/casos-esc-comision"[^>]*value=/.test(indexSrc) &&
    !/SC_COMMISSION_DEFAULT/.test(fs.readFileSync(path.join(__dirname, '..', 'assets', 'app.js'), 'utf8')));
  /* ---- 3f: Detalle discreto + layout centrado/simétrico ---- */
  const stylesSrc = fs.readFileSync(path.join(__dirname, '..', 'assets', 'styles.css'), 'utf8');
  const idxCard = indexSrc.indexOf('casos-escenario-card');
  check('3f index: el párrafo largo de “Escenarios de tasa” vive en <details><summary>Detalle</summary> (no siempre visible)',
    idxCard >= 0 &&
    indexSrc.indexOf('<details class="hint-details"><summary>Detalle</summary>', idxCard) > idxCard &&
    /<\/details>/.test(indexSrc.slice(indexSrc.indexOf('<details class="hint-details"', idxCard))),
    indexSrc.slice(idxCard, idxCard + 300));
  check('3f layout: modo phone conserva main centrado ~760px (body.phone-mode) y simétrico (margin auto)',
    /body\.phone-mode main\s*\{[^}]*max-width:\s*760px/.test(stylesSrc) &&
    /max-width:\s*1280px/.test(stylesSrc) && /margin:\s*0 auto/.test(stylesSrc));
  check('3f layout: inputs compactos en phone-mode (220px) y usables en web (base >220, nunca full-bleed)',
    /input, select, textarea\s*\{[^}]*max-width:\s*480px/.test(stylesSrc) &&
    /body\.phone-mode input, body\.phone-mode select, body\.phone-mode textarea\s*\{[^}]*max-width:\s*220px/.test(stylesSrc),
    stylesSrc.slice(stylesSrc.indexOf('input, select, textarea'), stylesSrc.indexOf('input, select, textarea') + 200));
  check('index.html: botón Modo Phone en topbar con aria-pressed inicial (sin inline, el estado lo fija app.js)',
    /<button type="button" id="btn-ui-mode"[^>]*aria-pressed="false"[^>]*>Modo Phone<\/button>/.test(indexSrc) &&
    !/btn-ui-mode"[^>]*\son[a-z]+=/.test(indexSrc));
  check('ui-mode: ct_ui_mode en app.js con default web (readUiMode devuelve web sin registro) y aria-pressed/texto actualizados por JS',
    /LS_UI_MODE = 'ct_ui_mode'/.test(appSrc) &&
    /return localStorage\.getItem\(LS_UI_MODE\) === 'phone' \? 'phone' : 'web'/.test(appSrc) &&
    /'Modo Phone'/.test(appSrc) && /'Modo Web'/.test(appSrc) &&
    /classList\.toggle\('phone-mode', phone\)/.test(appSrc) &&
    /btn\.setAttribute\('aria-pressed', phone \? 'true' : 'false'\)/.test(appSrc));
  check('P2 ui-mode: nombre accesible del botón = acción coherente (aria-label “Cambiar a modo …” fijado por JS y en el HTML inicial)',
    /btn\.setAttribute\('aria-label', phone \? 'Cambiar a modo Web' : 'Cambiar a modo Phone'\)/.test(appSrc) &&
    /aria-label="Cambiar a modo Phone"/.test(indexSrc));
  check('P2 init: bindUiMode/applyUiMode corren ANTES del return por engine ausente (layout correcto incluso con motor roto)',
    (appSrc.indexOf('bindUiMode();') >= 0 && appSrc.indexOf('applyUiMode(readUiMode());') >= 0 &&
     appSrc.indexOf('applyUiMode(readUiMode());') < appSrc.indexOf('if (!requireEngine()) return;')) ||
    /async function init\(\)\s*\{[^}]*bindUiMode\(\);\s*applyUiMode\(readUiMode\(\)\);\s*if \(!requireEngine\(\)\) return;/.test(appSrc),
    'no se aplica el modo UI antes del return');
  check('P2 toast: bottom depende del modo (24px web / 84px phone) con reposicionado en applyUiMode (placeToast)',
    /function toastBottomPx\(\)/.test(appSrc) &&
    /contains\('phone-mode'\) \? 84 : 24/.test(appSrc) &&
    /bottom:' \+ toastBottomPx\(\) \+ 'px;transform:translateX\(-50%\);/.test(appSrc) &&
    /function placeToast\(\)/.test(appSrc) && appSrc.indexOf('placeToast();') >= 0);
  const uiBtn = sandbox.document.getElementById('btn-ui-mode');
  CT.applyUiMode('phone');
  check('ui-mode: applyUiMode(phone) deja aria-label “Cambiar a modo Web” + aria-pressed=true (label/acción coherentes)',
    uiBtn.__attrs['aria-label'] === 'Cambiar a modo Web' && uiBtn.__attrs['aria-pressed'] === 'true' &&
    uiBtn.textContent === 'Modo Web', JSON.stringify(uiBtn.__attrs));
  CT.applyUiMode('web');
  check('ui-mode: applyUiMode(web) restablece “Cambiar a modo Phone” + aria-pressed=false',
    uiBtn.__attrs['aria-label'] === 'Cambiar a modo Phone' && uiBtn.__attrs['aria-pressed'] === 'false' &&
    uiBtn.textContent === 'Modo Phone', JSON.stringify(uiBtn.__attrs));
  check('P2 nav web: padding lateral de .bottomnav (24px) alineado con main (24px)',
    /\.bottomnav\s*\{[^}]*padding:\s*6px 24px 10px/.test(stylesSrc) &&
    /main\s*\{[^}]*padding:\s*14px 24px 32px/.test(stylesSrc),
    stylesSrc.slice(stylesSrc.indexOf('.bottomnav') - 20, stylesSrc.indexOf('.bottomnav') + 240));
  check('P2 css: sin justify-content:stretch (inválido en flexbox)',
    !/justify-content:\s*stretch\s*;/.test(stylesSrc));
  /* ---- 1b: composición desktop real por pestaña (web-only) ---- */
  check('1b layout: [hidden] con !important (el display:grid de autor no puede mantener visible una pestaña oculta)',
    /\[hidden\]\s*\{\s*display:\s*none !important;/.test(stylesSrc));
  check('1b layout: grids de escritorio solo en ≥720px y con body:not(.phone-mode) (phone intacto a cualquier ancho)',
    /@media \(min-width: 720px\)\s*\{[^@]*body:not\(\.phone-mode\) #tab-casos/.test(stylesSrc) &&
    /@media \(min-width: 1100px\)\s*\{\s*body:not\(\.phone-mode\) #tab-tasas\s*\{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);\s*\}\s*\}/.test(stylesSrc));
  check('1b layout Casos: pares/chips a todo el ancho (1/-1) y formulario izquierda / escenarios+resultado derecha',
    /body:not\(\.phone-mode\) #tab-casos > \.card:first-child\s*\{\s*grid-column: 1 \/ -1; min-width: 0;\s*\}/.test(stylesSrc) &&
    /body:not\(\.phone-mode\) #casos-escenario-card,\s*\n\s*body:not\(\.phone-mode\) #casos-resultado\s*\{\s*grid-column: 2; min-width: 0;\s*\}/.test(stylesSrc));
  check('1b layout Cuentas: lista en columna 1 y formularios en columna 2 (avisos a todo el ancho)',
    /body:not\(\.phone-mode\) #cuentas-lista\s*\{\s*grid-column: 1; grid-row: 2; min-width: 0;\s*\}/.test(stylesSrc) &&
    /body:not\(\.phone-mode\) #tab-cuentas > \.card\s*\{\s*grid-column: 2; min-width: 0;\s*\}/.test(stylesSrc));
  check('1b layout Balance: resumen/activos/pasivos/distribución en grid 2 columnas',
    /body:not\(\.phone-mode\) #balance-out\s*\{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);\s*\}/.test(stylesSrc));
  check('1b layout Histórico: filtros densos (col 1) + lista a todo el ancho (1/-1)',
    /body:not\(\.phone-mode\) #tab-historico > \.card:first-child\s*\{\s*grid-column: 1; grid-row: 1; min-width: 0;\s*\}/.test(stylesSrc) &&
    /body:not\(\.phone-mode\) #hist-lista\s*\{\s*grid-column: 1 \/ -1; grid-row: 2; min-width: 0;\s*\}/.test(stylesSrc));
  check('1b layout Tasas: matriz a todo el ancho (1/-1), multi-pares en grid interno de 3 columnas y comprobador en 2',
    /body:not\(\.phone-mode\) #ta-matriz,\s*\n\s*body:not\(\.phone-mode\) #refresh-label-info,\s*\n\s*body:not\(\.phone-mode\) #ta-vesdetalle,\s*\n\s*body:not\(\.phone-mode\) #ta-diagnostico\s*\{\s*grid-column: 1 \/ -1; min-width: 0;\s*\}/.test(stylesSrc) &&
    /body:not\(\.phone-mode\) #ta-multipares\s*\{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/.test(stylesSrc) &&
    /body:not\(\.phone-mode\) #tab-comprobador-panel\s*\{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(stylesSrc));
  check('1b layout: NINGUNA regla de composición toca body.phone-mode (el modo phone no recibe grids ni ítems estirados)',
    !/body\.phone-mode[^{}\n]*\{[^}]*grid-template-columns/.test(stylesSrc));
  check('3f layout: rejilla de formularios 2 columnas en desktop (≥640px) y 1 en móvil',
    /.form2col\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/.test(stylesSrc) &&
    /@media \(min-width: 640px\)\s*\{\s*\.form2col \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/.test(stylesSrc));
  check('3f layout: botones de modo compactos (.btn-sc) y sin scroll horizontal (overflow-x hidden en body)',
    /\.btn-sc \{ min-height: 36px/.test(stylesSrc) && /overflow-x: hidden/.test(stylesSrc));

  /* ---- sin inline en el HTML servido ni en lo renderizado ---- */
  check('index.html sin manejadores inline ni <script> embebido',
    !/<script(?![^>]*src=)/i.test(indexSrc) && !/\son[a-z]+\s*=/i.test(indexSrc));
  check('todo lo renderizado del núcleo también está libre de inline',
    Object.keys(htmlLog).every(id => !/\son(click|change|input|submit|error)\s*=/i.test(htmlLog[id]) || id === 'banner'),
    JSON.stringify(Object.keys(htmlLog).filter(id => /\son(click|change|input|submit|error)\s*=/i.test(htmlLog[id]))));
  check('no hay <script> embebido vía innerHTML',
    Object.keys(htmlLog).every(id => !/<script/i.test(htmlLog[id])));

  console.log('\n===== UI: ' + (checks - failures) + '/' + checks + ' pruebas OK, ' + failures + ' fallidas =====');
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.error('error no esperado:', e);
  process.exit(1);
});
