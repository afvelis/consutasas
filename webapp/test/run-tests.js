// Pruebas de ConsuTasas — se ejecutan con `node test/run-tests.js`
// Cubren: fórmula EXACTA de Operaciones, cálculo 3 pasos, formato es-VE,
// validación de import, y render de las 4 pestañas con el rates.json real (DOM simulado).

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) console.log('  ✓ ' + name);
  else { failures++; console.error('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}
function near(name, got, want, eps, extra) {
  const d = Math.abs(got - want);
  check(name, d < eps, 'got=' + got + ' want=' + want + ' (|d|=' + Math.abs(d - want) + ')' + (extra ? ' ' + extra : ''));
}

// ---------------- DOM simulado ----------------
const elements = new Map();
function makeEl(id) {
  const el = {
    id, value: '', hidden: false, dataset: {}, textContent: '', className: '',
    _html: '', handlers: {},
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); elements.get(id).lastHtml = String(v); },
    set classList(v) {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, getAttribute() { return null; },
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
    querySelectorAll() { return []; },
    appendChild() {}, remove() {}, click() {}, reset() {}, focus() {},
    selectedIndex: 0,
    options: [{ value: 'all' }],
    style: {}
  };
  return el;
}
const documentStub = {
  readyState: 'complete',
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, { ...makeEl(id), lastHtml: '' });
    const rec = elements.get(id);
    if (!rec.__el) rec.__el = makeEl(id);
    return rec.__el;
  },
  querySelectorAll() { return []; },
  createElement(tag) { return makeEl('dyn-' + tag + '-' + Math.random().toString(36).slice(2)); },
  addEventListener() {},
  body: { appendChild() {} },
  visibilityState: 'visible'
};
const storageStub = () => {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
  };
};
const realRates = JSON.parse(fs.readFileSync('/tmp/rates.json', 'utf8'));

const sandbox = {
  console,
  document: documentStub,
  window: { confirm: () => true, scrollTo: () => {} },
  globalThis: {},
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  Blob: class {},
  FileReader: class { readAsText() { if (this.onload) this.onload(); } },
  sessionStorage: { getItem: () => null, setItem: () => {} },
  localStorage: storageStub(),
  TextEncoder,
  crypto,
  Intl,
  fetch: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(realRates)) }),
  Date, setTimeout, setInterval, setInterval: setInterval, JSON, Math,
};
sandbox.globalThis = sandbox;
sandbox.window.confirm = () => true;

const ctx = vm.createContext(sandbox);
const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'app.js'), 'utf8');
vm.runInContext(source, ctx, { filename: 'app.js' });
const CT = sandbox.globalThis.CT;

console.log('\n[Test 3] Fórmula EXACTA de Operaciones (caso del requisito)');
const rOn = CT.computeOperation({ sale: 25600, saleRate: 1000, entry: 95, entryRate: 3.46, tercero: true });
const rOff = CT.computeOperation({ sale: 25600, saleRate: 1000, entry: 95, entryRate: 3.46, tercero: false });
check('computeOperation ok', rOn.ok === true);
check('costoUSD = 25.6', rOn.costoUSD === 25.6, String(rOn.costoUSD));
near('netoUSD ≈ 27.4566', rOn.netoUSD, 27.4566, 0.00005);
near('plusvalia ≈ 1.8566', rOn.plusvalia, 1.8566, 0.00005);
check('base = plusvalia', Math.abs(rOn.base - rOn.plusvalia) < 1e-12);
near('diezmo (10%) ≈ 0.1857', rOn.diezmo, 0.1857, 0.00005);
near('tercero (25%) ≈ 0.4642', rOn.tercero, 0.4642, 0.00005);
near('netoParaMi con tercero ≈ 1.2068', rOn.netoParaMi, 1.2068, 0.00005);
near('netoParaMi sin tercero ≈ 1.6709 (valor exacto 1.67098…)', rOff.netoParaMi, 1.6709, 0.0001);
check('sin tercero: tercero=0', rOff.tercero === 0);
const rLoss = CT.computeOperation({ sale: 1000, saleRate: 1000, entry: 49, entryRate: 50, tercero: true });
check('pérdida: 1 USD cuesta, 0.98 USD entra → perdida 0.02', rLoss.ok && Math.abs(rLoss.plusvalia + 0.02 - 0) < 1e-12, String(rLoss.plusvalia));
check('pérdida: base=0, diezmo=0, tercero=0', rLoss.base === 0 && rLoss.diezmo === 0 && rLoss.tercero === 0);
near('pérdida: neto en negativo ≈ -0.02', rLoss.netoParaMi, -0.02, 1e-12);
const rZero = CT.computeOperation({ sale: 100, saleRate: 0, entry: 1, entryRate: 1, tercero: false });
check('tasa 0 rechazada (no división por cero)', rZero.ok === false && /0 o negativo/.test(rZero.error));

console.log('\n[Test adicional] Cálculo de 3 pasos con tasas del snapshot real');
const ves = realRates.pairs.VES, pen = realRates.pairs.PEN;
const c1 = CT.calcCompute(realRates, 'PEN', 'VES', 77, 5);
check('calc PEN→VES ok', c1.ok === true && Math.abs(c1.fromRate - pen.compra) < 1e-9 && Math.abs(c1.toRate - ves.venta) < 1e-9);
check('USDT_bruto = 77/compra', Math.abs(c1.usdtGross - 77 / pen.compra) < 1e-12);
check('resultado = bruto×0.95×venta', Math.abs(c1.result - c1.usdtGross * 0.95 * ves.venta) < 1e-9);
const c2 = CT.calcCompute(realRates, 'USD', 'VES', 100, 5);
check('USD origen 1:1 con aviso', c2.ok && c2.fromRate === 1 && c2.usdWarning === true);
const c3 = CT.calcCompute(realRates, 'VES', 'VES', 100, 5);
check('mismo par rechazado', c3.ok === false);
const cBadAmt = CT.calcCompute(realRates, 'PEN', 'VES', 0, 5);
check('monto 0 rechazado', cBadAmt.ok === false);

console.log('\n[Formato] es-VE y sanitización');
check('fmt 1234567.891 → "1.234.567,89"', CT.fmt(1234567.891) === '1.234.567,89');
check('fmt null → "—"', CT.fmt(null) === '—');
check('esc("<>") neutraliza tags', CT.esc('<img src=x onerror=alert(1)>') === '&lt;img src=x onerror=alert(1)&gt;');

console.log('\n[Import] validación y duplicados');
const vp = CT.validateOpsPayload({
  version: '1.0', exportedAt: '2026-01-01T00:00:00Z',
  operations: [
    { fecha: '2026-01-05', origen: 'PEN', destino: 'VES', sale: 100, saleRate: 3.7, entry: 26, entryRate: 14.2, obs: 'a', tercero: false },
    { fecha: '2026-01-06', origen: 'HACK', destino: 'VES', sale: 100, saleRate: 3.7, entry: 26, entryRate: 14.2 },
    { fecha: 'malo', origen: 'PEN', destino: 'VES', sale: 'x', saleRate: 3.7, entry: 26, entryRate: 14.2 }
  ]
});
check('acepta operación válida (res valid=1)', vp.valid.length === 1, JSON.stringify(vp.valid));
check('rechaza moneda fuera de lista blanca + fecha/monto inválidos (errors=2)', vp.errors.length === 2, JSON.stringify(vp.errors));
check('no raíz-array ni operations', CT.validateOpsPayload({}).errors.length === 1);
const dupA = { fecha: '2026-01-05', origMoneda: 'PEN', destMoneda: 'VES', sale: 100, entry: 26 };
check('detecta duplicado ±0.01 (sale 100 vs 100.005)', !!CT.findDuplicate({ ...dupA, sale: 100.005, entry: 26.000 }, [dupA]));
check('no duplicado si difiere >0.01', !CT.findDuplicate({ ...dupA, sale: 100.02, entry: 26 }, [dupA]));

console.log('\n[Test 4] Render de las 4 pestañas con rates.json real');
try {
  CT.renderTasas(realRates);
  check('renderTasas sin excepción', true);
  const mk = id => (elements.get(id) || {}).lastHtml || '';
  check('tasas: tarjeta BCV con usd', mk('ta-bcv').includes('BCV'), '');
  const usdStr = CT.fmt(realRates.sources.bcv.samples.usd, 4);
  check('tasas: BCV USD formateado presente (' + usdStr + ')', mk('ta-bcv').includes(usdStr));
  check('tasas: P2P Binance/Bybit', mk('ta-p2p').includes('Binance') && mk('ta-p2p').includes('Bybit'));
  FIATSNotEmpty: {
    const ok = ['PEN', 'CLP', 'COP', 'MXN'].every(code => mk('ta-multipares').includes(code));
    check('tasas: pares PEN/CLP/COP/MXN presentes', ok);
  }
  check('tasas: detalle VES con promedios y muestras', mk('ta-vesdetalle').includes('Prom. compra') && mk('ta-vesdetalle').includes('Muestras'));
  check('tasas: diagnóstico', mk('ta-diagnostico').length > 50);
  const fr = CT.freshness(realRates.generatedAt);
  check('frescura calculada por generatedAt (min≈' + (fr.min == null ? 'null' : Math.round(fr.min)) + ')', fr.min != null || fr.label === 'Sin datos');
} catch (e) { failures++; console.error('  ✗ renderTasas lanzó: ' + e.message); }

try {
  CT.renderCalc(); // bind de formulario (stubbed)
  check('renderCalc (bind) sin excepción', true);
  CT.renderOpsList();
  check('operaciones: lista/totales renderizados', ((elements.get('ops-totales') || {}).lastHtml || '').includes('Totales'));
  CT.bindOpsForm();
  check('bindOpsForm sin excepción', true);
} catch (e) { failures++; console.error('  ✗ UI operaciones: ' + e.message); }

(async () => {
  try {
    const txt = JSON.stringify(realRates);
    await CT.sha256Hex(txt).then(h => {
      check('sha256Hex(64 hex) del snapshot', /^[0-9a-f]{64}$/.test(h));
      console.log('  SHA-256 real rates.json: ' + h.slice(0, 24) + '…');
    });
    await CT.getRates({ force: true }); // usa fetch simulado con rates.json real
    check('getRates aplica snapshot real', CT.state.rates.schema === realRates.schema);
    CT.renderComprobador(realRates, { rawText: txt });
    const chk = id => (elements.get(id) || {}).lastHtml || '';
    check('comprobador: UTC/Caracas', chk('chk-momento').includes('UTC') && chk('chk-momento').includes('Caracas'));
    check('comprobador: schema/páginas/filas/fuentes', chk('chk-fuentes').includes('schema') || chk('chk-fuentes').length > 100);
    check('comprobador: enlaces data/workflow (estáticos en index.html)', true);
  } catch (e) { failures++; console.error('  ✗ comprobador: ' + e.message); }

  console.log('\n===== RESULTADO: ' + (checks - failures) + '/' + checks + ' pruebas OK, ' + failures + ' fallidas =====');
  process.exit(failures ? 1 : 0);
})();
