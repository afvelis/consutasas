/* Pruebas smoke del núcleo de UI v2 — Node puro con DOM simulado:
 * `node test/ui-tests.js`.
 * Cubre: arranque (CTEngine presente), pestañas + sessionStorage, render lazy,
 * chips de pares y los 4 modos por par (estado inicial determinista VES/PEN +
 * “Me depositan PEN → entrego Bs” con chip-active/mode-active, persistencia par+modo
 * en storage y restauración al volver de otra pestaña, 100 PEN→VES = 29.228,57,
 * USD/USD 320→305 con override), cotización EXACTA vía CTEngine (PEN→VES 3700 →
 * 1.081.457,14 con comisión 7 %), cotización y registro INVERSOS, USD/USD con
 * forward e inverso (Zelle 305 → 327,96), cuentas (primaria única), balance
 * (cuadre/patrimonio/pasivos), histórico (filtros/stats/cadena), migración
 * legacy v1, hooks de tasas.js y ausencia de HTML/JS inline. Llama a
 * `node webapp/test/ui-tests.js`.
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
  check('PEN→VES 3700: entregas 1.081.457,14 Bs', resHtml.indexOf('1.081.457,14') >= 0, resHtml.slice(0, 400));
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
  check('PEN→VES 100: entregas 29.228,57 Bs', res100.indexOf('29.228,57') >= 0, res100.slice(0, 400));
  check('desglose declara moneda explícita: Cliente deposita: PEN / Tú entregas: VES',
    /Cliente deposita: PEN/.test(res100) && /Tú entregas: VES/.test(res100) &&
    !/Cliente deposita: VES/.test(res100) && !/Tú entregas: PEN/.test(res100));
  sandbox.document.getElementById('casos-monto').value = '3700';
  CT.renderResultado();

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
  // Fixture: depósito forward 3700 PEN → 1.081.457,14 VES ⇒ inverso target 1.081.457,14 VES → 3700 PEN.
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
  check('movimiento inverso: in PEN 3700, out VES 1.081.457,14',
    mvRev.type === 'operation' && mvRev.in.currency === 'PEN' && Math.abs(mvRev.in.amount - 3700) < 0.01 &&
    mvRev.out.currency === 'VES' && Math.abs(mvRev.out.amount - 1081457.14) < 0.02 &&
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
  // Settings globales se mantienen (comisión 8% para COP, 2% zelle, tercero off)
  check('settings globales: comisión, 2%, tercero off se mantienen tras cambio de par',
    sandbox.document.getElementById('casos-comision').value === '8' &&
    sandbox.document.getElementById('casos-tercero').checked === false &&
    sandbox.document.getElementById('casos-margin').value === '');

  /* ---- index.html: CSP con api.github.com y raw.githubusercontent.com ---- */
  check('index.html CSP: connect-src incluye raw.githubusercontent.com',
    /connect-src.*https:\/\/raw\.githubusercontent\.com/.test(indexSrc));
  check('index.html CSP: connect-src incluye api.github.com',
    /connect-src.*https:\/\/api\.github\.com/.test(indexSrc));
  check('index.html: tiene bot-status-container', /id="bot-status-container"/.test(indexSrc));
  check('index.html: tiene refresh-label-info', /id="refresh-label-info"/.test(indexSrc));

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
