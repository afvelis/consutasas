/* Pruebas del módulo Tasas + Comprobador (assets/tasas.js) — Node puro con DOM
 * simulado: `node webapp/test/tasas-tests.js`.
 * Carga engine.js + app.js + tasas.js en el mismo orden que index.html
 * (defer) y verifica: render de BCV, P2P (Binance/Bybit + variación vs BCV),
 * multi-par (spread/mejores/muestras/anuncios + top ad), detalle VES, EUR
 * referencial (incl. avisos por diffPct > 2 % y por eurRef ausente),
 * matriz de pares × Máximo/Mejor/Promedio/Mínimo a 40 US$ eq (3e, sin 2 %),
 * diagnóstico/avisos, Comprobador (hash SHA-256 del archivo descargado,
 * momento UTC/Caracas, cadena de hashes del ledger, fuentes/HTTP/muestras),
 * feedback del botón Actualizar vía CT.onRefreshClick, snapshot ausente
 * («—» + avisos, nunca inventa), snapshot real data/rates.json sin lanzar,
 * ausencia de inline y que los hooks del núcleo (renderTab → renderTasas +
 * renderComprobador) no se rompen.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const engine = require('../assets/engine.js');
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'assets', 'app.js'), 'utf8');
const tasasSrc = fs.readFileSync(path.join(__dirname, '..', 'assets', 'tasas.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const liveRates = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'rates.json'), 'utf8'));

let failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) console.log('  ✓ ' + name);
  else { failures++; console.error('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}

/* ================= fixture con la forma real del snapshot v2 ================= */
const RECENT = new Date(Date.now() - 3 * 60000).toISOString(); // hace 3 min: frescura verde
const FIXTURE = {
  fixture: true,
  schema: 'consutasas/rates.v1',
  generatedAt: RECENT,
  generatedAtCaracas: '2026-01-15T08:00:00-04:00',
  sources: {
    bcv: { status: 'ok', http: 200, samples: { usd: 919.8227, eur: 1011.179 }, url: 'https://www.bcv.org.ve/', actualizado: 'Martes, 24 Noviembre  2026' },
    binance: { status: 'ok', http: 200, samples: { ads: 406 }, url: 'https://p2p.binance.com/' },
    bybit: { status: 'ok', http: 200, samples: { ads: 381 }, url: 'https://api2.bybit.com/' }
  },
  pairs: {
    VES: {
      code: 'VES', status: 'ok', compra: 1095.935, venta: 1084.0342, spreadPct: -1.09,
      mejorCompra: 1087, mejorVenta: 1101.059, mejorSpreadPct: 1.29,
      muestras: { buy: 81, sell: 81, total: 162 },
      porPlataforma: {
        binance: { compra: 1092.3601, venta: 1088.8873, muestras: { compra: 41, venta: 41 } },
        bybit: { compra: 1099.5992, venta: 1079.0597, muestras: { compra: 40, venta: 40 } }
      },
      ads: {
        compra: [{ price: 1087, min: 450000, max: 500000, available: 1500, platform: 'binance', page: 1 }],
        venta: [{ price: 1101.059, min: 3000, max: 150000, available: 1157.75, platform: 'binance', page: 1 }]
      }
    },
    PEN: { code: 'PEN', status: 'ok', compra: 3.18, venta: 3.519, spreadPct: 10.66, mejorCompra: 3.18, mejorVenta: 3.519, mejorSpreadPct: 10.66, muestras: { buy: 20, sell: 20, total: 40 }, ads: { compra: [{ price: 3.18, min: 8, max: 20.316, available: 6.39, platform: 'bybit', page: 1 }], venta: [{ price: 3.519, min: 300, max: 730, available: 85.53, platform: 'binance', page: 1 }] } },
    CLP: { code: 'CLP', status: 'ok', compra: 876, venta: 1042.95, spreadPct: 19.06, mejorCompra: 876, mejorVenta: 1042.95, mejorSpreadPct: 19.06, muestras: { buy: 20, sell: 20, total: 40 }, ads: { compra: [], venta: [] } },
    COP: { code: 'COP', status: 'degradado', compra: 2999, venta: 3430, spreadPct: 14.37, mejorCompra: 2999, mejorVenta: 3430, mejorSpreadPct: 14.37, muestras: { buy: 20, sell: 20, total: 40 } },
    MXN: { code: 'MXN', status: 'ok', compra: 19.15, venta: 19.21, spreadPct: 0.31, mejorCompra: 19.15, mejorVenta: 19.21, mejorSpreadPct: 0.31, muestras: { buy: 20, sell: 20, total: 40 } }
  },
  vesDetail: {
    compraTotal: 1095.935, ventaTotal: 1084.0342, mejorPrecioCompra: 1087, mejorPrecioVenta: 1101.059,
    compraPromP1: 1093.9495, compraPromP2: 1097.9701, ventaPromP1: 1085.229, ventaPromP2: 1082.8094,
    spreadTotal: -1.09, spreadMejores: 1.29, muestras: { compra: 81, venta: 81 }, status: 'ok'
  },
  eurRef: { usd: 1.099, ves: 1011.1795, vesImplicito: 1010.8851, diffPct: 0.03, source: 'frankfurter', fetchedAt: RECENT, status: 'ok' },
  cross: {
    'BCV USD → Binance VES': { origen: 919.8227, destino: 1088.8873, pctVariacion: 18.38 },
    'BCV USD → Bybit VES': { origen: 919.8227, destino: 1079.0597, pctVariacion: 17.31 }
  },
  variations: [
    { name: 'BCV USD → Binance VES', pct: 18.38 },
    { name: 'BCV USD → Bybit VES', pct: 17.31 }
  ],
  purchasingPower: [
    { name: 'BCV USD → Binance VES', lossPct: 15.53, factor: 1.1838 }
  ],
  diagnostics: { binanceRequests: { requests: 20, ok: 20, fallos: 0 }, elapsedSeconds: 12.83 },
  warnings: ['aviso de prueba del bot'],
  meta: { pages: 2, rows: 20, fiats: ['VES', 'PEN', 'CLP', 'COP', 'MXN'], schemaVersion: '2' }
};

/* ================= DOM simulado (mismo patrón que ui-tests) ================= */
const htmlLog = {};

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
const dynEls = []; // elementos creados vía createElement (p. ej. el toast)
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
  createElement(tag) { const e = makeEl('dyn-' + tag); dynEls.push(e); return e; },
  addEventListener() {},
  body: null
};
documentStub.body = makeEl('body');
documentStub.body.appendChild = () => {};

['casos', 'cuentas', 'balance', 'historico', 'tasas'].forEach(t => {
  documentStub.getElementById('tab-' + t).classList.toggle('active', t === 'casos');
  documentStub.getElementById('nav-' + t).dataset = { tab: t };
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

function makeSandbox(payload) {
  const sandbox = {
    document: documentStub,
    localStorage: ls,
    sessionStorage: ss,
    location: { hostname: 'localhost' },
    fetch: async () => ({ ok: true, text: async () => JSON.stringify(payload) }),
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
  sandbox.listeners = {};
  vm.createContext(sandbox);
  return sandbox;
}

(async () => {
  /* ---- carga en el orden de index.html: app.js → tasas.js ---- */
  const sandbox = makeSandbox(FIXTURE);
  try {
    vm.runInContext(appSrc, sandbox, { filename: 'app.js' });
    vm.runInContext(tasasSrc, sandbox, { filename: 'tasas.js' });
  } catch (e) {
    check('app.js + tasas.js evalúan sin lanzar', false, e.message);
    process.exit(1);
  }
  const CT = sandbox.CT;
  check('tasas.js sobrescribe los placeholders del núcleo',
    typeof CT.renderTasas === 'function' && typeof CT.renderComprobador === 'function' &&
    !/assets\/tasas\.js/.test(String(CT.renderTasas)));
  check('espera snapshot cargado (init de app.js corrió antes)', await (async () => {
    const t0 = Date.now();
    while (!(CT.S && CT.S.rates && CT.S.ledger) && Date.now() - t0 < 2000) await new Promise(r => setTimeout(r, 10));
    return !!(CT.S && CT.S.rates && CT.S.ledger);
  })());
  // Rama "render inmediato": con el snapshot ya en CT.S, re-cargar tasas.js
  // debe pintar la pestaña en el mismo tick (sin esperar al primer switchTab).
  htmlLog['ta-bcv'] = ''; htmlLog['ta-eurref'] = '';
  CT.S.rates = FIXTURE;
  vm.runInContext(tasasSrc, sandbox, { filename: 'tasas.js' });
  check('render inmediato al cargar con snapshot ya presente',
    /Oficial BCV/.test(htmlLog['ta-bcv'] || '') && /EUR referencial/.test(htmlLog['ta-eurref'] || ''));

  /* ---- pestaña tasas vía el hook del núcleo ---- */
  CT.S.rates = null; // fuerza re-render completo desde el hook
  CT.switchTab('tasas');
  check('switchTab(tasas) renderiza sin lanzar (snapshot vacío → avisos)', /Pulsa Actualizar/.test(htmlLog['ta-bcv'] || ''));
  CT.S.rates = FIXTURE;
  CT.renderTab('tasas');
  check('renderTab(tasas) vuelve a pintar BCV + P2P', /Oficial BCV/.test(htmlLog['ta-bcv']) && /P2P USD→Bs/.test(htmlLog['ta-p2p']));

  /* ---- BCV ---- */
  const bcv = htmlLog['ta-bcv'];
  check('BCV: USD 919,8227 y EUR 1.011,179 con formato es-VE',
    bcv.indexOf('919,8227') >= 0 && bcv.indexOf('1.011,179') >= 0);
  check('BCV: estado de la fuente y publicación', /estado de la fuente/i.test(bcv) && /Martes, 24 Noviembre/.test(bcv));

  /* ---- P2P ---- */
  const p2p = htmlLog['ta-p2p'];
  check('P2P: Binance compra/venta + Bybit compra/venta',
    /Compra Binance/.test(p2p) && /Venta Binance/.test(p2p) && /Compra Bybit/.test(p2p) && /Venta Bybit/.test(p2p));
  check('P2P: variación vs BCV (18,38 %) con clase pos', p2p.indexOf('18,38') >= 0 && /class="v pos"/.test(p2p));

  /* ---- variaciones + poder adquisitivo ---- */
  const vari = htmlLog['ta-variaciones'];
  check('variaciones: BCV USD → Binance VES 18,38 %', /BCV USD → Binance VES/.test(vari) && vari.indexOf('18,38') >= 0);
  check('poder adquisitivo: pérdida 15,53 % · ×1,1838', /Poder adquisitivo/.test(vari) && vari.indexOf('15,53') >= 0 && vari.indexOf('1,1838') >= 0);

  /* ---- multi-par ---- */
  const multi = htmlLog['ta-multipares'];
  check('multi-par: una tarjeta por fiat del meta.fiats',
    (multi.match(/USD→/g) || []).length === 5 && /VES \(USD→VES\)/.test(multi) && /MXN \(USD→MXN\)/.test(multi));
  check('multi-par: compra/venta/spread/mejores',
    /Compra/.test(multi) && /Venta/.test(multi) && /Spread/.test(multi) && /Mejor compra/.test(multi) && /Mejor venta/.test(multi) && /Mejor spread/.test(multi));
  check('multi-par: muestras y conteo de anuncios (1 / 1)',
    /Muestras \(total\)/.test(multi) && /Anuncios \(compra\/venta\)/.test(multi) && multi.indexOf('1 / 1') >= 0);
  check('multi-par: top ad con min/max/disponible/plataforma',
    /Mejor anuncio compra \(top\)/.test(multi) && multi.indexOf('450.000,00') >= 0 && multi.indexOf('1.500,00') >= 0 && /binance/.test(multi));
  check('multi-par: ads vacíos → «—» sin inventar (CLP) y estado degradado avisado (COP)',
    /Mejor anuncio compra \(top\)/.test(multi) && /degradado/.test(multi));
  check('multi-par: sin scroll horizontal mental — no hay <table', !/<table/i.test(multi));

  /* ---- detalle VES ---- */
  const vd = htmlLog['ta-vesdetalle'];
  check('detalle VES: totales, mejores, promedios P1/P2, spread, muestras',
    /Detalle P2P VES/.test(vd) && vd.indexOf('1.095,935') >= 0 && vd.indexOf('1.084,0342') >= 0 &&
    /Prom. compra p\u00e1gs\. 1\/2/.test(vd) && vd.indexOf('81 · 81') >= 0);

  /* ---- 3g: Matriz de tasas laterales por US$ (PEN/COP/CLP/MXN ×
   * Máximo/Mejor/Promedio/Mínimo, toggle Compra/Venta, sin comisión) ---- */
  const matrizAd = (price, platform) => ({ price: price, min: 0, max: 100000000, available: 1000000, platform: platform });
  const matrizAdCorto = (price, platform, available) => ({ price: price, min: 0, max: 100000000, available: available, platform: platform });
  const MATFIX = {
    fixture: true,
    schema: 'consutasas/rates.v1',
    generatedAt: RECENT,
    generatedAtCaracas: '2026-01-15T08:00:00-04:00',
    pairs: {
      VES: { code: 'VES', status: 'ok', compra: 1000, venta: 1100, ads: {
        compra: [matrizAd(1080, 'binance'), matrizAd(1085, 'binance'), matrizAd(1090, 'binance'), matrizAd(1082, 'bybit'), matrizAd(1086, 'bybit'), matrizAd(1092, 'bybit')],
        venta: [matrizAd(1101, 'binance'), matrizAd(1100, 'binance'), matrizAd(1099, 'binance'), matrizAd(1098, 'bybit'), matrizAd(1097, 'bybit'), matrizAd(1096, 'bybit')]
      } },
      PEN: { code: 'PEN', status: 'ok', compra: 3.5, venta: 3.7, ads: {
        compra: [matrizAdCorto(3.00, 'binance', 30), matrizAd(3.40, 'binance'), matrizAd(3.42, 'binance'), matrizAd(3.44, 'binance'), matrizAd(3.41, 'bybit'), matrizAd(3.43, 'bybit'), matrizAd(3.46, 'bybit')],
        venta: [matrizAd(3.70, 'binance'), matrizAd(3.68, 'binance'), matrizAd(3.66, 'binance'), matrizAd(3.72, 'bybit'), matrizAd(3.69, 'bybit'), matrizAd(3.67, 'bybit')]
      } },
      COP: { code: 'COP', status: 'ok', compra: 4000, venta: 4200, ads: {
        compra: [matrizAd(4000, 'binance'), matrizAd(4010, 'binance'), matrizAd(4020, 'binance'), matrizAd(4005, 'bybit'), matrizAd(4015, 'bybit'), matrizAd(4030, 'bybit')],
        venta: [matrizAd(4200, 'binance'), matrizAd(4180, 'binance'), matrizAd(4160, 'binance'), matrizAd(4190, 'bybit'), matrizAd(4170, 'bybit'), matrizAd(4150, 'bybit')]
      } },
      CLP: { code: 'CLP', status: 'ok', compra: 900, venta: 950, ads: { compra: [], venta: [] } },
      MXN: { code: 'MXN', status: 'ok', compra: 18, venta: 20, ads: { compra: [], venta: [] } }
    },
    eurRef: FIXTURE.eurRef
  };
  const savedRatesMatriz = CT.S.rates, savedFxMatriz = CT.S.fx;
  CT.S.rates = MATFIX;
  CT.S.fx = engine.buildFx(MATFIX);
  CT.renderTab('tasas');
  const matrizBtn = documentStub.getElementById('btn-matriz');
  documentStub.getElementById('ta-matriz').hidden = true; // estado inicial del HTML servido
  (matrizBtn.__listeners['click'] || []).forEach(fn => fn());
  const matrizHtml = htmlLog['ta-matriz'];

  // Valores esperados derivados del motor CRUDO (rateScenarios sin comisión =
  // tasas laterales de mercado: la matriz es "lo que tú obtienes"; Casos es
  // "lo que obtiene el cliente" con comisión). El ORIGEN de rateScenarios usa
  // compra y el DESTINO venta: pair [code,'VES'] da la lateral compra; pair
  // ['VES',code] da la lateral venta.
  const fxLat = (code, side) => {
    const fx = engine.buildFx(MATFIX);
    fx.pairs = { [code]: { ads: MATFIX.pairs[code].ads[side] } };
    return fx;
  };
  // Misma tasa vía rateScenarios crudo (independiente de matrizRate/adRateAt directo):
  const latScn = (code, side, mode) => {
    const fx = fxLat(code, side);
    if (side === 'compra') {
      const scn = engine.rateScenarios(engine.defaultSettings(), fx, [code, 'VES'], 'AB', 40, 'compra');
      return (scn[mode] && scn[mode].originRate != null) ? scn[mode].originRate : MATFIX.pairs[code].compra;
    }
    const scn = engine.rateScenarios(engine.defaultSettings(), fx, ['VES', code], 'AB', 40, 'compra');
    return (scn[mode] && scn[mode].destRate != null) ? scn[mode].destRate : MATFIX.pairs[code].venta;
  };
  function fmtMatriz(v, code) { // réplica de es-VE en CT.fmt (4 dec; CLP 2; recorta ceros a 2)
    const d = code === 'CLP' ? 2 : 4;
    const parts = v.toFixed(d).split('.');
    const ent = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    let d2 = parts[1].replace(/0+$/, '') || '00';
    if (d2.length < 2) d2 += '0';
    return ent + ',' + d2;
  }
  const parseVE = s => parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
  const cellsOf = fila => (fila.match(/<span class="num">([\d.,]+)<\/span>/g) || [])
    .map(s => parseVE(s.replace(/<span class="num">|<\/span>/g, '')));

  check('3g matriz: nota «Mercado (sin comisión). Casos incluye comisión del cliente.» visible (fuera del Detalle)',
    /Mercado \(sin comisión\)\. Casos incluye comisión del cliente\./.test(matrizHtml) &&
    matrizHtml.indexOf('Mercado (sin comisión)') < matrizHtml.indexOf('<details class="hint-details"'),
    matrizHtml.slice(0, 500));
  check('3g matriz: toggle Compra/Venta con Compra por defecto (aria-pressed=true en Compra)',
    /matriz-side btn-primary" data-matriz-side="compra" aria-pressed="true">Compra<\/button>/.test(matrizHtml) &&
    /matriz-side" data-matriz-side="venta" aria-pressed="false">Venta<\/button>/.test(matrizHtml),
    matrizHtml.slice(0, 800));
  check('3g matriz: filas exactas PEN/USD, COP/USD, CLP/USD, MXN/USD (4 filas, orden lateral, sin cruces)',
    (matrizHtml.match(/<tr><td>/g) || []).length === 4 &&
    matrizHtml.indexOf('<tr><td>PEN/USD</td>') >= 0 && matrizHtml.indexOf('<tr><td>COP/USD</td>') >= 0 &&
    matrizHtml.indexOf('<tr><td>CLP/USD</td>') >= 0 && matrizHtml.indexOf('<tr><td>MXN/USD</td>') >= 0 &&
    matrizHtml.indexOf('<tr><td>PEN/USD</td>') < matrizHtml.indexOf('<tr><td>COP/USD</td>') &&
    matrizHtml.indexOf('<tr><td>COP/USD</td>') < matrizHtml.indexOf('<tr><td>CLP/USD</td>') &&
    matrizHtml.indexOf('<tr><td>CLP/USD</td>') < matrizHtml.indexOf('<tr><td>MXN/USD</td>') &&
    matrizHtml.indexOf('PEN/COP') < 0 && matrizHtml.indexOf('/VES') < 0,
    matrizHtml.slice(0, 900));

  const filaDe = code => (matrizHtml.match(new RegExp('<tr><td>' + code + '/USD</td>([\\s\\S]*?)</tr>')) || [])[1] || '';
  const filaPEN = filaDe('PEN'), filaCOP = filaDe('COP'), filaCLP = filaDe('CLP'), filaMXN = filaDe('MXN');

  // Compra (default): celda = la MISMA tasa que rateScenario crudo (sin comisión).
  ['PEN', 'COP', 'CLP', 'MXN'].forEach(function (code) {
    const fila = filaDe(code);
    const got = cellsOf(fila);
    const exp = ['max', 'best', 'average', 'min'].map(m => fmtMatriz(latScn(code, 'compra', m), code));
    check('3g matriz compra ' + code + ': celdas = ' + exp.join('/') + ' = rateScenarios crudo (sin comisión)',
      JSON.stringify(got) === JSON.stringify(exp.map(parseVE)),
      'got=' + JSON.stringify(got) + ' exp=' + JSON.stringify(exp));
    check('3g matriz compra ' + code + ': MAX ≥ AVG ≥ MIN',
      got[0] >= got[2] && got[2] >= got[3], JSON.stringify(got));
  });
  // Rangos por fiat (compra): PEN 1..10; COP > 1000; CLP > 100; MXN > 10.
  check('3g matriz compra: rangos PEN>1 y <10 · COP>1000 · CLP>100 · MXN>10',
    cellsOf(filaPEN).every(v => v > 1 && v < 10) &&
    cellsOf(filaCOP).every(v => v > 1000) &&
    cellsOf(filaCLP).every(v => v > 100) &&
    cellsOf(filaMXN).every(v => v > 10),
    JSON.stringify([cellsOf(filaPEN), cellsOf(filaCOP), cellsOf(filaCLP), cellsOf(filaMXN)]));
  // SEMÁTICA 3g en PEN/compra: MAX = mayor (3,46) · MIN = menor (3,00, sin
  // filtro: el ad de 3,00 con disp 30 < 40 SE INCLUYE) · AVG = media de los 7
  // ads (23.56/7 ≈ 3,3657) · BEST conservador = MAYOR ejecutable a 40 US$ eq
  // (3,46 — aquí coincide con MAX: el top del libro es ejecutable).
  // CT.fmt es-VE (NF4) recorta: min 2 / max 4 decimales.
  check('3g matriz compra PEN: valores exactos MAX 3,46 · BEST 3,46 (conservador: mayor ejecutable) · AVG 3,3657 · MIN 3,00 (sin filtro)',
    (() => { const c = cellsOf(filaPEN); return c[0] === 3.46 && c[1] === 3.46 &&
      Math.abs(c[2] - 23.56 / 7) < 5e-5 && c[3] === 3; })(),
    'got=' + JSON.stringify(cellsOf(filaPEN)));
  // BEST compra entre MIN y MAX (relación establecida 3g).
  check('3g matriz compra PEN: MIN ≤ BEST ≤ MAX',
    (() => { const c = cellsOf(filaPEN); return c[3] <= c[1] && c[1] <= c[0]; })(), JSON.stringify(cellsOf(filaPEN)));

  // Toggle a VENTA: delegación en el holder (addEventListener del DOM simulado).
  const mtxHolder = documentStub.getElementById('ta-matriz');
  (mtxHolder.__listeners['click'] || []).forEach(fn => fn({
    target: { closest: sel => ({ dataset: { matrizSide: 'venta' } }) }
  }));
  const matrizVenta = htmlLog['ta-matriz'];
  check('3g matriz venta: toggle cambia el lado activo (aria-pressed: Venta=true, Compra=false)',
    /data-matriz-side="compra" aria-pressed="false">Compra<\/button>/.test(matrizVenta) &&
    /data-matriz-side="venta" aria-pressed="true">Venta<\/button>/.test(matrizVenta),
    matrizVenta.slice(0, 800));
  ['PEN', 'COP', 'CLP', 'MXN'].forEach(function (code) {
    const fila = (matrizVenta.match(new RegExp('<tr><td>' + code + '/USD</td>([\\s\\S]*?)</tr>')) || [])[1] || '';
    const got = cellsOf(fila);
    const exp = ['max', 'best', 'average', 'min'].map(m => fmtMatriz(latScn(code, 'venta', m), code));
    check('3g matriz venta ' + code + ': celdas = ' + exp.join('/') + ' = rateScenarios crudo lado venta',
      JSON.stringify(got) === JSON.stringify(exp.map(parseVE)),
      'got=' + JSON.stringify(got) + ' exp=' + JSON.stringify(exp));
    check('3g matriz venta ' + code + ': MAX ≥ AVG ≥ MIN', got[0] >= got[2] && got[2] >= got[3], JSON.stringify(got));
  });
  // Venta PEN: MAX 3,72 (= BEST venta aquí) · AVG ≈ 3,6867 (22.12/6) · MIN 3,66.
  const filaPENV = (matrizVenta.match(new RegExp('<tr><td>PEN/USD</td>([\\s\\S]*?)</tr>')) || [])[1] || '';
  check('3g matriz venta PEN: MAX 3,72 (= BEST venta aquí) · AVG 3,6867 · MIN 3,66',
    (() => { const c = cellsOf(filaPENV); return c[0] === 3.72 && Math.abs(c[2] - 22.12 / 6) < 5e-5 && c[3] === 3.66; })(),
    JSON.stringify(cellsOf(filaPENV)));
  // Volver a Compra (segundo click no cambia si el lado no difiere; click en Compra sí).
  (mtxHolder.__listeners['click'] || []).forEach(fn => fn({
    target: { closest: sel => ({ dataset: { matrizSide: 'compra' } }) }
  }));
  check('3g matriz: toggle de vuelta a Compra repinta las tasas laterales de compra',
    /btn-primary" data-matriz-side="compra" aria-pressed="true"/.test(htmlLog['ta-matriz']) &&
    (htmlLog['ta-matriz'].match(/3,46<\/span>/g) || []).length >= 1, htmlLog['ta-matriz'].slice(0, 600));

  check('3g matriz: la explicación vive en «Detalle» (<details><summary>) discreto',
    /<details class="hint-details"><summary>Detalle<\/summary>/.test(matrizHtml) &&
    /Tasa lateral por 1 US\$/.test(matrizHtml) &&
    matrizHtml.indexOf('Matriz de tasas') < matrizHtml.indexOf('<details class="hint-details"'),
    matrizHtml.slice(-600));
  check('3g matriz P1: tabla envuelta en .matriz-scroll (scroll interno móvil) y cabecera Moneda (por 1 US$)',
    /<div class="matriz-scroll"><table class="matriz-table"/.test(matrizHtml) &&
    matrizHtml.indexOf('</table></div>') > matrizHtml.indexOf('<div class="matriz-scroll"') &&
    /Moneda \(por 1 US\$\)/.test(matrizHtml),
    matrizHtml.slice(0, 500));
  (matrizBtn.__listeners['click'] || []).forEach(fn => fn());
  check('3g matriz: toggle oculta y el botón vuelve a «Matriz»',
    documentStub.getElementById('ta-matriz').hidden === true && matrizBtn.textContent === 'Matriz');
  CT.S.rates = savedRatesMatriz;
  CT.S.fx = savedFxMatriz;
  CT.renderTab('tasas');

  /* ---- EUR referencial ---- */
  const eur = htmlLog['ta-eurref'];
  check('EUR referencial: usd/ves/implícito/dif/fuente/estado',
    eur.indexOf('1,099') >= 0 && eur.indexOf('1.011,1795') >= 0 && eur.indexOf('1.010,8851') >= 0 &&
    eur.indexOf('0,03') >= 0 && /frankfurter/.test(eur) && /ok/.test(eur));
  check('EUR referencial: sin filas de compra/venta de Binance/Bybit',
    !/Compra Binance/.test(eur) && !/Venta Bybit/.test(eur) && !/Compra Bybit/.test(eur) && !/Venta Binance/.test(eur));
  // diffPct > 2 % → aviso
  const CT2 = CT;
  CT2.S.rates = Object.assign({}, FIXTURE, { eurRef: Object.assign({}, FIXTURE.eurRef, { diffPct: 3.5 }) });
  CT.renderTasas();
  check('EUR referencial: aviso si diffPct > 2 %', /supera el 2 %/.test(htmlLog['ta-eurref']));
  // sin eurRef → aviso
  const sinEur = Object.assign({}, FIXTURE); delete sinEur.eurRef;
  CT2.S.rates = sinEur;
  CT.renderTasas();
  check('EUR referencial: aviso si falta eurRef', /no publicado en este snapshot/.test(htmlLog['ta-eurref']));
  CT2.S.rates = FIXTURE;

  /* ---- diagnóstico + avisos ---- */
  const diag = htmlLog['ta-diagnostico'];
  check('diagnóstico: claves + avisos del bot', /binanceRequests/.test(diag) && /elapsedSeconds/.test(diag) && /aviso de prueba del bot/.test(diag));

  /* ---- comprobador ---- */
  CT.renderComprobador();
  const fuego = htmlLog['chk-fuegonacional'];
  check('comprobador: archivo + schema + hash SHA-256 del archivo descargado',
    /data\/rates\.json/.test(fuego) && /consutasas\/rates\.v1/.test(fuego) && /^[0-9a-f]{64}$/.test((fuego.match(/<span class="val mono">([0-9a-f]{64})<\/span>/) || [])[1] || ''));
  const momento = htmlLog['chk-momento'];
  check('comprobador: generado UTC + Caracas + antigüedad',
    /Generado \(UTC\)/.test(momento) && /Generado \(Caracas\)/.test(momento) && /Antigüedad del snapshot/.test(momento) && momento.indexOf('2026') >= 0);
  // En tasas-tests.js init con localhost sin caché → updateSource = 'local'
  check('comprobador: origen local (no publicado) + eurRef resumido',
    /Origen de lo que ves/.test(momento) && /local \(no publicado\)/.test(momento) && /EUR referencial/.test(momento) && /frankfurter/.test(momento));
  const integ = htmlLog['chk-integridad'];
  check('comprobador: cadena de hashes del ledger íntegra', /Cadena de hashes del libro mayor: íntegra/.test(integ));
  const fuentes = htmlLog['chk-fuentes'];
  check('comprobador: fuentes con estado/HTTP/muestras (bcv 200, ads 406/381)',
    /bcv · estado ok · HTTP 200/.test(fuentes) && /binance/.test(fuentes) && fuentes.indexOf('406') >= 0 && fuentes.indexOf('381') >= 0);
  check('comprobador: estructura (meta.fiats, 2 págs. × 20 filas)',
    /Pares publicados \(meta\.fiats\)/.test(fuentes) && /2 p\u00e1gs\. \u00d7 20 filas/.test(fuentes));
  const chkDiag = htmlLog['chk-diagnostico'];
  check('comprobador: diagnóstico del snapshot', /binanceRequests/.test(chkDiag));

  /* ---- hash honesto: sin rawText (caché) → no inventa ---- */
  const rawText = CT.S.rawText;
  CT.S.rawText = null;
  CT.renderComprobador();
  check('comprobador: sin rawText muestra pista en lugar de hash', /pulsa \u00abActualizar\u00bb/.test(htmlLog['chk-fuegonacional']));
  CT.S.rawText = rawText;

  /* ---- toggle del comprobador + config ---- */
  const toggle = documentStub.getElementById('chk-toggle');
  documentStub.getElementById('tab-comprobador-panel').hidden = true; // estado inicial del HTML
  (toggle.__listeners['click'] || []).forEach(fn => fn());
  check('chk-toggle muestra el panel del comprobador', documentStub.getElementById('tab-comprobador-panel').hidden === false);
  (toggle.__listeners['click'] || []).forEach(fn => fn());
  check('chk-toggle lo vuelve a ocultar', documentStub.getElementById('tab-comprobador-panel').hidden === true);
  const cfgBtn = documentStub.getElementById('cfg-guardar');
  documentStub.getElementById('cfg-comision').value = '7.5';
  documentStub.getElementById('cfg-eur-usd').value = '0.95';
  (cfgBtn.__listeners['click'] || []).forEach(fn => fn());
  check('cfg-guardar persiste comisión por defecto en el ledger',
    Math.abs(CT.S.ledger.settings.commissionDefault - 0.075) < 1e-9);
  check('cfg-guardar persiste EUR manual (readManualEur)', CT.readManualEur().eurUsd === 0.95);

  /* ---- botón Actualizar: hook + feedback + 8 s ---- */
  const refreshBtn = documentStub.getElementById('btn-refresh');
  check('bindRefresh delega el click en CT.onRefreshClick (hook)',
    (refreshBtn.__listeners['click'] || []).length === 1 && typeof CT.onRefreshClick === 'function');
  const prevGen = CT.S.rates.generatedAt;
  documentStub.getElementById('btn-refresh-label').textContent = '';
  await CT.onRefreshClick();
  check('onRefreshClick: spinner activo y botón deshabilitado mientras dura', refreshBtn.disabled === true && /is-busy/.test(refreshBtn.className) && documentStub.getElementById('btn-refresh-label').textContent === 'Actualizando…');
  await new Promise(r => setTimeout(r, 8100));
  check('onRefreshClick: tras 8 s el botón se reactiva sin clase busy',
    refreshBtn.disabled === false && !/is-busy/.test(refreshBtn.className) && documentStub.getElementById('btn-refresh-label').textContent === 'Actualizar');
  // feedback "nuevo snapshot HH:MM": mock fetch retorna generatedAt más reciente
  CT.S.rates = Object.assign({}, FIXTURE, { generatedAt: new Date(Date.now() - 60000).toISOString() });
  const futureGen = new Date(Date.now() - 10000).toISOString();
  sandbox.fetch = async () => ({ ok: true, text: async () => JSON.stringify(Object.assign({}, FIXTURE, { generatedAt: futureGen })) });
  const getToast = () => dynEls.filter(e => e.id === 'toast')[0] || { textContent: '' };
  await CT.onRefreshClick();
  await new Promise(r => setTimeout(r, 8100));
  check('feedback: «nuevo snapshot HH:MM» cuando generado es más reciente', /Nuevo snapshot \d{2}:\d{2} UTC/.test(getToast().textContent || ''), getToast().textContent);
  // Restaurar mock original
  sandbox.fetch = async () => ({ ok: true, text: async () => JSON.stringify(FIXTURE) });
  // feedback "sin cambios": mismo generatedAt
  await CT.onRefreshClick();
  await new Promise(r => setTimeout(r, 8100));
  check('feedback: «sin cambios (último HH:MM)» cuando no cambia', /Sin cambios \(último \d{2}:\d{2} UTC\)/.test(getToast().textContent || ''), getToast().textContent);
  // feedback "error, usando guardado": red caída con copia en caché disponible
  sandbox.fetch = async () => { throw new Error('red caída'); };
  await CT.onRefreshClick();
  check('onRefreshClick: caché usada al fallar la red', CT.S.fromCache === true);
  await new Promise(r => setTimeout(r, 8100));
  check('feedback: «error, usando guardado» al fallar la red con caché', /usando copia guardada/.test(getToast().textContent || ''), getToast().textContent);
  sandbox.fetch = async () => ({ ok: true, text: async () => JSON.stringify(FIXTURE) });

  /* ---- snapshot ausente: «—» + avisos, nunca inventa ---- */
  CT.S.rates = null;
  CT.renderTab('tasas');
  check('sin snapshot: BCV/eurRef/multipares con aviso y sin números inventados',
    /Pulsa Actualizar/.test(htmlLog['ta-bcv']) && /no publicado/.test(htmlLog['ta-eurref']) &&
    !/\d{1,3}\.\d{3},\d{2}/.test(htmlLog['ta-multipares']));
  CT.renderComprobador();
  check('sin snapshot: comprobador pide Actualizar y no calcula hash',
    /sin snapshot/i.test(htmlLog['chk-fuegonacional']) && !/^[0-9a-f]{64}$/.test(htmlLog['chk-fuegonacional']));
  CT.S.rates = FIXTURE;
  CT.renderTab('tasas');

  /* ---- snapshot real data/rates.json: render sin lanzar ---- */
  CT.S.rates = liveRates;
  let liveOk = true, liveErr = null;
  try { CT.renderTab('tasas'); CT.renderComprobador(); } catch (e) { liveOk = false; liveErr = e; }
  check('snapshot real data/rates.json: render de tasas + comprobador sin lanzar', liveOk, liveErr && liveErr.message);
  check('snapshot real: EUR referencial con frankfurter y diffPct', /frankfurter/.test(htmlLog['ta-eurref']) && htmlLog['ta-eurref'].indexOf('0,03') >= 0);
  check('snapshot real: multi-par con 20/20 anuncios por lado (VES)',
    /Anuncios \(compra\/venta\)/.test(htmlLog['ta-multipares']) && htmlLog['ta-multipares'].indexOf('20 / 20') >= 0);
  check('snapshot real: BCV con valores publicados', htmlLog['ta-bcv'].indexOf('919,8227') >= 0);
  CT.S.rates = FIXTURE;

  /* ---- hooks del núcleo intactos ---- */
  check('renderTasas sigue siendo reemplazable (hook del núcleo)', (() => {
    const original = CT.renderTasas;
    let called = 0;
    CT.renderTasas = () => { called++; };
    CT.renderTab('tasas');
    CT.renderTasas = original;
    return called === 1;
  })());
  check('pestañas anteriores siguen funcionando (casos renderiza)',
    (() => { CT.switchTab('casos'); return CT.S.tab === 'casos'; })());

  /* ---- diffRates (expuesto por tasas.js) ---- */
  check('CT.diffRates es función', typeof CT.diffRates === 'function');
  const d0 = CT.diffRates(null, FIXTURE);
  check('diffRates con prev=null: []', Array.isArray(d0) && d0.length === 0);
  const d1 = CT.diffRates(FIXTURE, FIXTURE);
  check('diffRates con mismo dato: []', Array.isArray(d1) && d1.length === 0);
  const prevSimple = Object.assign({}, FIXTURE, { pairs: { VES: { compra: 1000, venta: 1000 } } });
  const d2 = CT.diffRates(prevSimple, FIXTURE);
  check('diffRates detecta cambio en compra VES', Array.isArray(d2) && d2.length > 0);
  check('diffRates: campo tiene prev/curr/pct', d2[0] && d2[0].prev != null && d2[0].curr != null && d2[0].pct != null);
  /* ---- diffRates: porPlataforma ---- */
  // Copia profunda de FIXTURE con porPlataforma.binance.compra alterado
  const FIXTURE_PPP = JSON.parse(JSON.stringify(FIXTURE));
  FIXTURE_PPP.pairs.VES.porPlataforma.binance.compra = 9999;
  const d3 = CT.diffRates(FIXTURE, FIXTURE_PPP);
  check('diffRates: porPlataforma detecta cambio en VES/binance/compra',
    Array.isArray(d3) && d3.length > 0 && d3.some(d => /VES\//.test(d.field)),
    JSON.stringify(d3));
  check('diffRates porPlataforma: campo contiene la ruta completa del path',
    d3.some(d => /VES\/binance\/compra/.test(d.field)) ||
    d3.some(d => d.field.indexOf('VES') >= 0 && d.field.indexOf('binance') >= 0 && d.field.indexOf('compra') >= 0),
    JSON.stringify(d3));

  /* ---- indicadores de cambio (▲▼) ---- */
  // fromCache puede seguir true tras el test de "caché usada al fallar la red";
  // resetear para permitir la lectura de prev-rates.
  CT.S.fromCache = false;
  // Limpiar cualquier dato previo de ct_rates_prev
  ls.removeItem('ct_rates_prev');
  // Simular snapshot anterior con valores diferentes
  const prevFixture = Object.assign({}, FIXTURE, {
    sources: { bcv: { status: 'ok', http: 200, samples: { usd: 900, eur: 1000 }, url: 'https://www.bcv.org.ve/', actualizado: 'Antes' } },
    pairs: {
      VES: Object.assign({}, FIXTURE.pairs.VES, { compra: 1000, venta: 1000, mejorCompra: 1000, mejorVenta: 1000 }),
      PEN: Object.assign({}, FIXTURE.pairs.PEN, { compra: 3.0, venta: 3.0, mejorCompra: 3.0, mejorVenta: 3.0 }),
      CLP: Object.assign({}, FIXTURE.pairs.CLP, { compra: 800, venta: 800, mejorCompra: 800, mejorVenta: 800 }),
      COP: Object.assign({}, FIXTURE.pairs.COP, { compra: 2800, venta: 3200, mejorCompra: 2800, mejorVenta: 3200 }),
      MXN: Object.assign({}, FIXTURE.pairs.MXN, { compra: 18, venta: 18, mejorCompra: 18, mejorVenta: 18 })
    }
  });
  prevFixture.eurRef = Object.assign({}, FIXTURE.eurRef, { usd: 1.05, ves: 980 });
  ls.setItem('ct_rates_prev', JSON.stringify({ data: prevFixture, fetchedAt: new Date().toISOString() }));
  CT.S.rates = FIXTURE;
  CT.renderTab('tasas');
  const bcVhtml = htmlLog['ta-bcv'];
  check('BCV: indicador ▲ para USD subiendo (900→919,82)', /Variación BCV USD/.test(bcVhtml) && /\u25B2/.test(bcVhtml));
  const multiHtml = htmlLog['ta-multipares'];
  check('Multi-par: indicador ▲ para VES compra subiendo (1000→1095,9)', /Variación compra/.test(multiHtml) && /\u25B2/.test(multiHtml));
  // Same data: sin flecha
  const sameData = Object.assign({}, FIXTURE);
  ls.setItem('ct_rates_prev', JSON.stringify({ data: sameData, fetchedAt: new Date().toISOString() }));
  CT.S.rates = sameData;
  CT.renderTab('tasas');
  const multiSame = htmlLog['ta-multipares'];
  check('Multi-par: sin cambios → sin flecha ▲ ni ▼', !/\u25B2/.test(multiSame) && !/\u25BC/.test(multiSame));
  // Down indicator
  const prevDown = Object.assign({}, FIXTURE, {
    sources: { bcv: { status: 'ok', http: 200, samples: { usd: 930, eur: 1020 }, url: 'https://www.bcv.org.ve/', actualizado: 'Antes' } },
    pairs: { VES: Object.assign({}, FIXTURE.pairs.VES, { compra: 1150, venta: 1150, mejorCompra: 1150, mejorVenta: 1150 }) }
  });
  ls.setItem('ct_rates_prev', JSON.stringify({ data: prevDown, fetchedAt: new Date().toISOString() }));
  CT.S.rates = FIXTURE;
  CT.renderTab('tasas');
  const bcVdown = htmlLog['ta-bcv'];
  check('BCV: indicador ▼ para USD bajando (930→919,82)', /Variación BCV USD/.test(bcVdown) && /\u25BC/.test(bcVdown));
  // Clean up
  ls.removeItem('ct_rates_prev');
  CT.S.rates = FIXTURE;

  /* ---- source label en Comprobador ---- */
  CT.S.updateSource = 'bot';
  CT.renderComprobador();
  check('Comprobador: muestra fuente del snapshot (bot)', /Fuente del snapshot/.test(htmlLog['chk-momento']) && /bot/.test(htmlLog['chk-momento']));
  CT.S.updateSource = 'manual';
  CT.renderComprobador();
  check('Comprobador: muestra fuente manual', /manual/.test(htmlLog['chk-momento']));
  CT.S.updateSource = 'cache';
  CT.renderComprobador();
  check('Comprobador: muestra fuente cache', /cache/.test(htmlLog['chk-momento']));
  CT.S.updateSource = null;

  /* ---- sin inline en el HTML servido ni en lo renderizado ---- */
  check('index.html sin manejadores inline ni <script> embebido',
    !/<script(?![^>]*src=)/i.test(indexSrc) && !/\son[a-z]+\s*=/i.test(indexSrc));
  check('index.html carga assets/tasas.js', /<script defer src="assets\/tasas\.js"><\/script>/.test(indexSrc));
  check('todo lo renderizado por tasas.js está libre de inline',
    Object.keys(htmlLog).every(id => !/\son(click|change|input|submit|error)\s*=/i.test(htmlLog[id]) || id === 'banner'),
    JSON.stringify(Object.keys(htmlLog).filter(id => /\son(click|change|input|submit|error)\s*=/i.test(htmlLog[id]))));
  check('no hay <script> embebido vía innerHTML en tasas.js',
    Object.keys(htmlLog).every(id => !/<script/i.test(htmlLog[id])));

  console.log('\n===== TASAS: ' + (checks - failures) + '/' + checks + ' pruebas OK, ' + failures + ' fallidas =====');
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.error('error no esperado:', e);
  process.exit(1);
});
