/* Pruebas del motor ConsuTasas v2 — Node puro, sin DOM ni red: `node test/engine-tests.js`.
 * Cubre la especificación: fórmulas (7% / 8% COP, USD/USD 320→305, EUR referencial),
 * casos PEN→VES / VES→COP con fixture explícito (fixture:true), ledger Zelle
 * 320→305 (plusvalía 15, diezmo 1.5, tercero 3.75, neto 9.75), transferencia,
 * retiro, aporte, exchange, cadena de hashes con detección de alteración,
 * balance, import/export y cierre de periodo. Las aserciones de números EXACTOS
 * corren contra webapp/test/fixtures/rates-frozen.json (snapshot congelado);
 * el JSON vivo data/rates.json solo se usa como smoke ESTRUCTURAL en [12]. */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const engine = require('../assets/engine.js');

let failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) console.log('  ✓ ' + name);
  else { failures++; console.error('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}
function near(name, got, want, eps) {
  check(name, got != null && Math.abs(got - want) < eps, 'got=' + got + ' want=' + want);
}
function throws(fn, re, name) {
  try { fn(); check(name, false, 'no lanzó'); }
  catch (e) { check(name, re.test(e.message || String(e)), 'mensaje: ' + e.message); }
}

/* ==================== fixture explícito del test (fixture:true) ====================
 * Datos FICTIONALES de prueba, no de mercado: el motor jamás los confunde con
 * rates.json real (ese se carga aparte como smoke). Marca fixture:true en eurRef
 * y en el objeto raíz. */
const FIXTURE_RATES = {
  fixture: true,
  schema: 'consutasas/rates.v1',
  generatedAt: '2026-01-15T12:00:00Z',
  pairs: {
    VES: { code: 'VES', status: 'ok', compra: 1000, venta: 1100 },
    PEN: { code: 'PEN', status: 'ok', compra: 3.5, venta: 3.7 },
    COP: { code: 'COP', status: 'ok', compra: 4000, venta: 4200 },
    CLP: { code: 'CLP', status: 'ok', compra: 900, venta: 950 },
    MXN: { code: 'MXN', status: 'ok', compra: 18, venta: 20 }
  },
  eurRef: { fixture: true, source: 'frankfurter', date: '2026-01-14', usdToEur: 0.9, eurToUsd: 1.1111 }
};

const FX = engine.buildFx(FIXTURE_RATES);

console.log('\n[1] SHA-256 y JSON canónico');
check('sha256("abc") coincide con el estándar',
  engine.sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
const longText = 'ConsuTasas v2 — libro mayor con ñ, acentos y {"claves":"ordenadas"}';
check('sha256 coincide con crypto de Node (UTF-8, texto largo)',
  engine.sha256Hex(longText) === crypto.createHash('sha256').update(longText, 'utf8').digest('hex'));
const obj = { b: 1, a: [2, { z: null, y: 1 }], c: undefined };
check('canonicalJson ordena claves y omite undefined',
  engine.canonicalJson(obj) === engine.canonicalJson({ a: [2, { y: 1, z: null }], b: 1 }));

console.log('\n[2] FX desde el fixture (nunca inventar tasas)');
// SPEC: DOS lados por moneda — compra (cotiza el ORIGEN) y venta (cotiza el DESTINO).
near('unitsPerUsdCompra.VES = compra 1000 (lado origen)', FX.unitsPerUsdCompra.VES, 1000, 1e-12);
near('unitsPerUsdVenta.VES = venta 1100 (lado destino)', FX.unitsPerUsdVenta.VES, 1100, 1e-12);
near('unitsPerUsdCompra.PEN = compra 3.5', FX.unitsPerUsdCompra.PEN, 3.5, 1e-12);
near('unitsPerUsdVenta.PEN = venta 3.7', FX.unitsPerUsdVenta.PEN, 3.7, 1e-12);
near('unitsPerUsdCompra.EUR = eurRef 0.9', FX.unitsPerUsdCompra.EUR, 0.9, 1e-12);
near('unitsPerUsdVenta.EUR = eurRef 0.9', FX.unitsPerUsdVenta.EUR, 0.9, 1e-12);
near('unitsPerUsd.PEN sigue como alias de venta (compat)', FX.unitsPerUsd.PEN, 3.7, 1e-12);
check('mejor compra PEN disponible (3.5)', FX.best.PEN.compra === 3.5);
check('fixture sin warnings', engine.fxWarnings(FX).length === 0, JSON.stringify(engine.fxWarnings(FX)));

// Snapshot sin eurRef (como el fixture real actual): EUR → null + aviso.
const FXnoEur = engine.buildFx({ fixture: true, schema: 'consutasas/rates.v1', pairs: FIXTURE_RATES.pairs });
check('sin eurRef: unitsPerUsd.EUR = null', FXnoEur.unitsPerUsd.EUR === null);
check('sin eurRef: aviso EUR referencial', engine.fxWarnings(FXnoEur).some(w => /EUR referencial/.test(w)));
const qEurMissing = engine.caseQuote(engine.defaultSettings(), FXnoEur, { pair: ['EUR', 'USD'], deposit: 100 });
check('caso EUR sin tasa: ok=false, aviso explícito', qEurMissing.ok === false && /Sin tasa de compra para EUR/.test(qEurMissing.error));
const qFiatMissing = engine.caseQuote(engine.defaultSettings(), engine.buildFx({ fixture: true, pairs: {} }), { pair: ['VES', 'PEN'], deposit: 100 });
check('fiat sin tasa: ok=false (no se inventa)', qFiatMissing.ok === false);

console.log('\n[3] Fórmulas de casos (SPEC: origen con compra, destino con venta): 7% / 8% COP, USD/USD, EUR');
const S = engine.defaultSettings();
// PEN → VES, 3700 PEN @7%: SPEC grossUsd = 3700/compra(3.5) = 1057.1428… ;
// entrega = round2(gross × venta(VES)=1100 × 0.93) = 1.081.457,14.
const qA = engine.caseQuote(S, FX, { pair: ['VES', 'PEN'], direction: 'BA', deposit: 3700 });
check('direction BA: entra PEN, sale VES', qA.currencyIn === 'PEN' && qA.currencyOut === 'VES');
near('grossUsd = 3700/compra(PEN)=3.5 ≈ 1057.1429 (NO venta)', qA.grossUsd, 3700 / 3.5, 1e-9);
near('delivered VES = 1.081.457,14', qA.delivered, 1081457.14, 1e-9);
near('plusvalía = 7% de grossUsd = 74', qA.profitUsd, 74, 1e-9);
near('diezmo 10% = 7.4', qA.diezmo, 7.4, 1e-9);
near('tercero 25% = 18.5', qA.tercero, 18.5, 1e-9);
near('neto = 74 − 7.4 − 18.5 = 48.1', qA.neto, 48.1, 1e-9);
check('rateInfo.rateInPerOut con compra(A): venta(B)/compra(A) = 1100/3.5', Math.abs(qA.rateInfo.rateInPerOut - 1100 / 3.5) < 1e-12);
check('rateInfo.unitsPerUsdIn = compra(PEN)', qA.rateInfo.unitsPerUsdIn === 3.5 && qA.rateInfo.unitsPerUsdOut === 1100);
// VES → COP (AB) con depósito COP: comisión 8%. (AB de [COP,CLP] = cliente deposita COP)
const qCOPin = engine.caseQuote(S, FX, { pair: ['COP', 'CLP'], direction: 'AB', deposit: 4200 });
check('AB de COP/CLP: entra COP', qCOPin.currencyIn === 'COP');
check('comisión 8% si el cliente deposita COP', qCOPin.commission === 0.08 && qCOPin.commissionPct === 8);
const qCOPout = engine.caseQuote(S, FX, { pair: ['CLP', 'COP'], direction: 'AB', deposit: 9500 });
check('CLP→COP (sale COP): comisión 7%, no 8%', qCOPout.commission === 0.07);

// USD/USD (Zelle): 320→305 vía override → plusvalía 15/1.5/3.75/9.75.
const qZ = engine.caseQuote(S, FX, { pair: ['USD', 'USD'], deposit: 320, deliveredOverride: 305 });
check('Zelle override 320→305', qZ.ok && qZ.delivered === 305 && qZ.overridden === true);
check('Zelle: plusvalía 15', qZ.profitUsd === 15 && qZ.base === 15);
check('Zelle: diezmo 1.5, tercero 3.75, neto 9.75', qZ.diezmo === 1.5 && qZ.tercero === 3.75 && qZ.neto === 9.75);
const qZd = engine.caseQuote(S, FX, { pair: ['USD', 'USD'], deposit: 1000 });
check('Zelle margen 7% por defecto: 1000→930', qZd.delivered === 930 && qZd.profitUsd === 70);
check('Zelle override > depósito rechazado', engine.caseQuote(S, FX, { pair: ['USD', 'USD'], deposit: 100, deliveredOverride: 101 }).ok === false);
// EUR referencial marcado como tal.
const qEur = engine.caseQuote(S, FX, { pair: ['EUR', 'USD'], deposit: 90 });
check('EUR referencial: marcado referencial', qEur.ok === true && qEur.referencial === true);
near('EUR 90 = 100 USD → entrega 93 USD tras 7%', qEur.delivered, 93, 1e-9);

// Validaciones de par/monto (independiente de la implementación).
check('A===B rechazado (no Zelle)', engine.caseQuote(S, FX, { pair: ['PEN', 'PEN'], deposit: 100 }).ok === false);
check('par no registrado rechazado', engine.caseQuote(S, FX, { pair: ['MXN', 'CLP'], deposit: 100 }).ok === false);
check('monto <= 0 rechazado', engine.caseQuote(S, FX, { pair: ['VES', 'PEN'], deposit: 0 }).ok === false);
check('monto micro: entrega redondea a 0 → ok:false (no throw)', engine.caseQuote(S, FX, { pair: ['VES', 'PEN'], deposit: 0.0000001 }).ok === false);

console.log('\n[3b] Números EXACTOS de la especificación contra el fixture CONGELADO (rates-frozen.json)');
/* Snapshot congelado del sitio (commit 29cf6d7: PEN compra 3.5845, VES compra 1098.2057 / venta 1087.9581,
 * COP compra 3522.9472 / venta 3379.0956). Los literales exactos de abajo solo valen para ESTE snapshot;
 * el propio bot regenera webapp/data/rates.json a diario, así que nunca debe cargarse el JSON vivo aquí.
 */
const localRatesEarly = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'rates-frozen.json'), 'utf8'));
check('rates-frozen.json es el snapshot esperado (PEN 3.5845, VES 1098.2057/1087.9581, COP 3522.9472/3379.0956)',
  localRatesEarly.schema === 'consutasas/rates.v1' &&
  localRatesEarly.pairs.PEN.compra === 3.5845 &&
  localRatesEarly.pairs.VES.compra === 1098.2057 && localRatesEarly.pairs.VES.venta === 1087.9581 &&
  localRatesEarly.pairs.COP.compra === 3522.9472 && localRatesEarly.pairs.COP.venta === 3379.0956);
const FXreal = engine.buildFx(localRatesEarly);
// PEN→VES, 100 PEN @7% → 28.227,12 VES (compra PEN 3.5845, venta VES 1087.9581)
const spec1 = engine.caseQuote(S, FXreal, { pair: ['VES', 'PEN'], direction: 'BA', deposit: 100 });
check('PEN→VES 100 PEN @7% → 28227.12 VES', spec1.ok && spec1.delivered === 28227.12, String(spec1.delivered));
// COP→VES, 100.000 COP @8% → 28.411,48 VES (compra COP 3522.9472, venta VES 1087.9581)
const spec2 = engine.caseQuote(S, FXreal, { pair: ['VES', 'COP'], direction: 'BA', deposit: 100000 });
check('COP→VES 100.000 COP @8% → 28411.48 VES', spec2.ok && spec2.delivered === 28411.48 && spec2.commission === 0.08, String(spec2.delivered));
// VES→COP, 25.000 Bs @7% → 71.538,49 COP (compra VES 1098.2057, venta COP 3379.0956)
const spec3 = engine.caseQuote(S, FXreal, { pair: ['VES', 'COP'], direction: 'AB', deposit: 25000 });
check('VES→COP 25.000 Bs @7% → 71538.49 COP', spec3.ok && spec3.delivered === 71538.49 && spec3.commission === 0.07, String(spec3.delivered));
check('USD/USD 320→305 se mantiene con 15/1.5/3.75/9.75', (() => {
  const q = engine.caseQuote(S, FXreal, { pair: ['USD', 'USD'], deposit: 320, deliveredOverride: 305 });
  return q.delivered === 305 && q.profitUsd === 15 && q.diezmo === 1.5 && q.tercero === 3.75 && q.neto === 9.75;
})());

console.log('\n[3c] Modo INVERSO: target fijado, depósito deducido (fixture congelado)');
// PEN→VES inverso: target 28.227,12 VES @7% → depósito ≈ 100,00 PEN (compra PEN 3.5845, venta VES 1087.9581).
const revPEN = engine.caseQuote(S, FXreal, { pair: ['VES', 'PEN'], direction: 'BA', target: 28227.12 });
check('PEN→VES inverso: ok, kind pair, reversed', revPEN.ok && revPEN.kind === 'pair' && revPEN.reversed === true);
near('PEN→VES inverso: depósito 100,00 PEN (±0,01)', revPEN.deposit, 100, 0.01);
check('PEN→VES inverso: delivered = 28227.12', revPEN.delivered === 28227.12);
near('PEN→VES inverso: plusvalía ≈ 7% de grossUsd', revPEN.profitUsd, revPEN.grossUsd * 0.07, 0.01);
check('PEN→VES inverso: comisión 7% (deposita PEN)', revPEN.commission === 0.07);
// COP→VES inverso: target 28.411,48 VES @8% → depósito ≈ 100.000 COP.
const revCOP = engine.caseQuote(S, FXreal, { pair: ['VES', 'COP'], direction: 'BA', target: 28411.48 });
near('COP→VES inverso: depósito 100.000,00 COP (±0,01)', revCOP.deposit, 100000, 0.01);
check('COP→VES inverso: comisión 8% (deposita COP)', revCOP.ok && revCOP.commission === 0.08);
// VES→COP inverso: target 71.538,49 COP @7% → depósito ≈ 25.000 Bs.
const revVES = engine.caseQuote(S, FXreal, { pair: ['VES', 'COP'], direction: 'AB', target: 71538.49 });
near('VES→COP inverso: depósito 25.000,00 Bs (±0,01)', revVES.deposit, 25000, 0.01);
check('VES→COP inverso: comisión 7%', revVES.ok && revVES.commission === 0.07);
// Zelle inverso: entregar 305 USD @margen 7% → recibir 327,96 USD, plus ≈ 22,96.
const revZ = engine.caseQuote(S, FXreal, { pair: ['USD', 'USD'], target: 305 });
check('Zelle inverso: ok, usd-usd, reversed', revZ.ok && revZ.kind === 'usd-usd' && revZ.reversed === true);
near('Zelle inverso: depósito 327,96 USD (±0,01)', revZ.deposit, 327.96, 0.01);
near('Zelle inverso: plusvalía ≈ 22,96', revZ.profitUsd, 22.96, 0.01);
near('Zelle inverso: diezmo 10% de 22,96', revZ.diezmo, 2.3, 0.01);
near('Zelle inverso: tercero 25% de 22,96', revZ.tercero, 5.74, 0.01);
near('Zelle inverso: neto', revZ.neto, 22.96 - 2.3 - 5.74, 0.01);
// Validaciones del modo inverso.
check('inverso: target 0 rechazado', engine.caseQuote(S, FXreal, { pair: ['VES', 'PEN'], target: 0 }).ok === false);
check('inverso: target negativo rechazado', engine.caseQuote(S, FXreal, { pair: ['VES', 'PEN'], target: -5 }).ok === false);
check('inverso micro: depósito redondea a 0 → ok:false', engine.caseQuote(S, FXreal, { pair: ['VES', 'PEN'], target: 0.0000001 }).ok === false);
check('Zelle inverso + deliveredOverride distinto → rechazo (no ignora)', engine.caseQuote(S, FXreal, { pair: ['USD', 'USD'], target: 305, deliveredOverride: 300 }).ok === false);
check('inverso respeta override si coincide', engine.caseQuote(S, FXreal, { pair: ['USD', 'USD'], target: 305, deliveredOverride: 305 }).ok === true);
// Inverso contra el fixture ficticio (mismo marco que [3]).
const revFx = engine.caseQuote(S, FX, { pair: ['VES', 'PEN'], direction: 'BA', target: 1081457.14 });
near('inverso fixture: target 1.081.457,14 VES → 3700 PEN', revFx.deposit, 3700, 0.01);

console.log('\n[3d] executeCase en modo inverso registra el movimiento con los montos calculados');
const stRev = engine.createInitialState();
const execRev = engine.executeCase(stRev, FXreal, {
  pair: ['VES', 'PEN'], direction: 'BA', target: 28227.12,
  date: '2026-02-06', depositAccount: 'peru', deliverAccount: 'efectivo-ves'
});
check('executeCase inverso: ok y movimiento operation', execRev.ok && execRev.movement.type === 'operation');
check('executeCase inverso: in PEN 100 en cuenta del depósito, out VES 28227.12 en cuenta de entrega',
  execRev.movement.in.currency === 'PEN' && Math.abs(execRev.movement.in.amount - 100) < 0.01 &&
  execRev.movement.out.currency === 'VES' && Math.abs(execRev.movement.out.amount - 28227.12) < 0.01 &&
  execRev.movement.in.account === 'peru' && execRev.movement.out.account === 'efectivo-ves');
check('executeCase inverso: meta.case.reversed y desglose fiscal',
  execRev.movement.meta.case.reversed === true && execRev.movement.meta.case.base > 0);
near('saldo Perú tras inverso: +100 PEN', engine.accountBalance(stRev, 'peru').native, 100, 0.01);
near('saldo efectivo-ves tras inverso: −28227.12', engine.accountBalance(stRev, 'efectivo-ves').native, -28227.12, 0.01);
check('cadena válida tras executeCase inverso', engine.verifyChain(stRev.movements));

console.log('\n[4] Libro de anuncios (walkBook) con fixture de ads (fixture:true)');
const adsCompra = [ // asc, como los entrega el bot
  { fixture: true, rate: 3.18, min: 10, max: 5000, available: 20 },
  { fixture: true, rate: 3.30, min: 10, max: 9000, available: 100 },
  { fixture: true, rate: 3.45, min: 15, max: 20000, available: 500 }
];
const wb = engine.walkBook(adsCompra, 50);
check('compra 50 USD: llena 50', wb.ok && Math.abs(wb.filled - 50) < 1e-9);
near('tasa efectiva = (20·3.18 + 30·3.30)/50', wb.rate, (20 * 3.18 + 30 * 3.30) / 50, 1e-9);
const wbSmall = engine.walkBook(adsCompra, 10);
near('10 USD sale del mejor anuncio (3.18)', wbSmall.rate, 3.18, 1e-9);
const adsThickMin = [{ rate: 3.18, min: 25, max: 5000, available: 1000 }];
const wbFb = engine.walkBook(adsThickMin, 10);
check('respaldo 10→20 USD cuando el mínimo del anuncio es mayor: llena el objetivo 10', wbFb.ok && Math.abs(wbFb.filled - 10) < 1e-9, JSON.stringify(wbFb));
near('respaldo usa la tasa del anuncio disponible (3.18)', wbFb.rate, 3.18, 1e-9);
check('objeto mayor que el libro: aviso y llenado parcial (nunca inventa)', (() => {
  const r = engine.walkBook([{ rate: 3.3, min: 10, max: 100, available: 5 }], 10);
  return r.ok === true && Math.abs(r.filled - 5) < 1e-9 && r.warnings.some(w => /sin cubrir|No hay anuncios/i.test(w));
})());
// Guard dinámico: objetivo grande con libro sano debe completarse sin techo oculto.
const adsBig = [{ fixture: true, rate: 3520, min: 10, max: 20000, available: 20000 }];
const wbBig = engine.walkBook(adsBig, 5000);
check('objetivo 5.000 USD: se completa (guard dinámico, sin techo de 2.000)', wbBig.ok && Math.abs(wbBig.filled - 5000) < 1e-9 && wbBig.warnings.length === 0, JSON.stringify(wbBig.warnings));
near('tasa efectiva del gran objetivo = 3520', wbBig.rate, 3520, 1e-9);
check('ads vacíos: ok=false + aviso, nunca tasa inventada', engine.walkBook(null, 10).ok === false && engine.walkBook(null, 10).rate === null);
check('monto 0 rechazado', engine.walkBook(adsCompra, 0).ok === false);

console.log('\n[5] Ledger: Zelle 320→305 registrado en el libro + cadena de hashes');
const state = engine.createInitialState();
check('10 cuentas iniciales, una primary por moneda', state.accounts.length === 10);
const primaries = {};
state.accounts.forEach(a => { if (a.primary) primaries[a.currency] = (primaries[a.currency] || 0) + 1; });
check('primary única en USD/VES/PEN/COP/CLP/MXN/EUR',
  Object.keys(primaries).length === 7 && Object.values(primaries).every(n => n === 1));

const zelle = engine.executeCase(state, FX, {
  pair: ['USD', 'USD'], deposit: 320, deliveredOverride: 305,
  date: '2026-01-20', depositAccount: 'zelle', deliverAccount: 'zelle'
});
check('caso Zelle ejecutado y registrado', zelle.ok === true && zelle.movement.type === 'operation');
const zBalance = engine.accountBalance(state, 'zelle');
check('saldo Zelle: 320 entra, 305 sale → +15', zBalance.native === 15 && zBalance.credits === 320 && zBalance.debits === 305);

const mv0 = state.movements[0];
check('primer movimiento: prevHash = GENESIS', mv0.prevHash === engine.GENESIS);
check('hash de 64 hex determinista', /^[0-9a-f]{64}$/.test(mv0.hash) && mv0.hash === engine.sha256Hex(engine.canonicalJson({ seq: 1, date: mv0.date, type: 'operation', in: mv0.in, out: mv0.out, note: mv0.note, meta: mv0.meta, prevHash: engine.GENESIS })));
check('verifyChain ok al inicio', engine.verifyChain(state.movements) === true);
check('chainHead = hash del último', engine.chainHead(state.movements) === mv0.hash);

console.log('\n[6] Transferencia, retiro, aporte, exchange');
engine.appendMovement(state, { date: '2026-01-21', type: 'transfer', in: { account: 'panama', currency: 'USD', amount: 100, rateAt: 1 }, out: { account: 'zelle', currency: 'USD', amount: 100, rateAt: 1 }, note: 'mover a Panamá' });
check('transferencia: zelle −100, panamá +100',
  engine.accountBalance(state, 'zelle').native === -85 && engine.accountBalance(state, 'panama').native === 100);
engine.appendMovement(state, { date: '2026-01-22', type: 'withdrawal', out: { account: 'binance', currency: 'USD', amount: 40, rateAt: 1 }, note: 'retiro a banco' });
check('retiro: cuenta solo sale', engine.accountBalance(state, 'binance').native === -40);
engine.appendMovement(state, { date: '2026-01-23', type: 'contribution', in: { account: 'efectivo-ves', currency: 'VES', amount: 5000, rateAt: 1100 }, note: 'aporte inicial' });
check('aporte: cuenta solo entra', engine.accountBalance(state, 'efectivo-ves').native === 5000);
engine.appendMovement(state, { date: '2026-01-24', type: 'exchange', in: { account: 'zelle', currency: 'USD', amount: 1, rateAt: 1 }, out: { account: 'efectivo-ves', currency: 'VES', amount: 1100, rateAt: 1100 }, note: 'VES→USD interno' });
check('exchange intercuéntas', engine.accountBalance(state, 'efectivo-ves').native === 3900 && engine.accountBalance(state, 'zelle').native === -84);
throws(() => engine.appendMovement(state, { date: '2026-01-25', type: 'withdrawal', in: { account: 'zelle', currency: 'USD', amount: 5 }, out: { account: 'zelle', currency: 'USD', amount: 5 } }), /solo tiene salida/, 'retiro con entrada rechazado');
throws(() => engine.appendMovement(state, { date: '2026-01-25', type: 'transfer', in: { account: 'zelle', currency: 'VES', amount: 5 }, out: { account: 'zelle', currency: 'USD', amount: 1 } }), /no opera VES/, 'moneda ajena a la cuenta rechazada');
check('cadena sigue válida tras operaciones', engine.verifyChain(state.movements));

console.log('\n[7] Detección de alteración (tamper) de la cadena');
const copy = JSON.parse(JSON.stringify(state.movements));
copy[1].in.amount = 999999; // monto de la transferencia alterado
check('monto alterado → verifyChain = false', engine.verifyChain(copy) === false);
const copy2 = JSON.parse(JSON.stringify(state.movements));
copy2[1].prevHash = 'TAMPER';
check('prevHash alterado → verifyChain = false', engine.verifyChain(copy2) === false);

console.log('\n[8] Balance: nativo exacto, valoración USD, pasivos EN USD, capital, fxDiff');
const bal = engine.balance(state, FX);
// Cuadre real: suma de saldos por cuenta vs agregación independiente (aperturas + créditos − débitos por moneda).
check('cuadre nativo por agregación independiente', bal.cuadre === true && bal.currencies.USD.cuadre === true && bal.currencies.VES.cuadre === true);
check('USD: activos totales = zelle −84 + panamá 100 + binance −40 = −24 usd', Math.abs(bal.currencies.USD.usdNow - (-24)) < 1e-9);
near('VES nativo 3900 → 3900/1100 usd', bal.currencies.VES.usdNow, 3900 / 1100, 1e-9);
// Pasivos EN USD: se suman crudos (raw), nunca divididos por la tasa del movimiento.
near('pasivo diezmo acumulado = 1.5 (USD crudo)', bal.liabilities.diezmo, 1.5, 1e-9);
near('pasivo tercero acumulado = 3.75 (USD crudo)', bal.liabilities.tercero, 3.75, 1e-9);
check('byCurrency de pasivos bajo USD (no bajo la moneda del movimiento)', bal.liabilities.byCurrency.USD != null && bal.liabilities.byCurrency.USD.usd === bal.liabilities.total);
near('capital = activos − pasivos', bal.equityUsd, bal.assetsUsd - bal.liabilities.total, 1e-9);
// PASIVOS con operación no-USD (spec: ≈0.68 USD, no ~0.0006): PEN→VES 100 PEN @7%.
const stPen = engine.createInitialState();
engine.executeCase(stPen, FXreal, { pair: ['VES', 'PEN'], direction: 'BA', deposit: 100, date: '2026-02-05', depositAccount: 'peru', deliverAccount: 'efectivo-ves' });
const balPen = engine.balance(stPen, FXreal);
const liabPen = balPen.liabilities.diezmo + balPen.liabilities.tercero;
near('pasivos PEN→VES ≈ 0.6835 USD (crudos, no divididos por 1087)', liabPen, 0.6835, 0.01);
check('pasivos PEN→VES no colapsados por la tasa del movimiento', liabPen > 0.1 && liabPen < 1);
// fxDiff: SOLO monedas con todos sus flujos valorados (rateAt).
const FXmoved = JSON.parse(JSON.stringify(FX)); FXmoved.unitsPerUsd.VES = 1000; FXmoved.unitsPerUsdVenta.VES = 1000; FXmoved.unitsPerUsdCompra.VES = 1000;
const balMoved = engine.balance(state, FXmoved);
check('revalorización FX ≠ 0 tras mover la tasa (todos los flujos valorados)', balMoved.currencies.VES.fxDiff !== 0);
// fxDiff VES = native/1000 − Σ(flujos/rateAt) = 3900/1000 − (5000/1100 − 1100/1100).
near('fxDiff VES = 3.9 − 3.5454… = 0.35454…', balMoved.currencies.VES.fxDiff, 3900 / 1000 - (5000 / 1100 - 1), 1e-9);
near('usdAtMovs VES = 5000/1100 − 1100/1100', balMoved.currencies.VES.usdAtMovs, 5000 / 1100 - 1, 1e-9);
near('fxDiff USD = 0 (todos los flujos valorados, tasa sin cambios)', balMoved.currencies.USD.fxDiff, 0, 1e-9);
// Aporte SIN rateAt: esa moneda queda sin fxDiff (null + aviso); nunca como "revalorización" falsa.
engine.appendMovement(state, { date: '2026-01-25', type: 'contribution', in: { account: 'chile', currency: 'CLP', amount: 1000 }, note: 'aporte sin valoración histórica' });
const balUnrated = engine.balance(state, FX);
check('CLP con flujo sin rateAt: fxDiff = null (no número)', balUnrated.currencies.CLP.fxDiff === null);
check('aviso fxDiff excluido para CLP', balUnrated.warnings.some(w => /fxDiff no disponible para CLP/.test(w)));

console.log('\n[9] Cierre de periodo (locking)');
check('periodo abierto inicialmente', engine.isPeriodClosed(state, '2026-01') === false);
const snapshot = engine.closePeriod(state, '2026-01', FX);
check('snapshot guarda saldos por cuenta', snapshot.balances.zelle === -84 && snapshot.balances['efectivo-ves'] === 3900 && snapshot.balances.chile === 1000);
near('valoración USD del cierre', snapshot.usdValuation, -24 + 3900 / 1100 + 1000 / 950, 1e-9);
check('snapshot conservó avisos del fx', Array.isArray(snapshot.warnings) && snapshot.usdComplete === true);
check('periodo cerrado', engine.isPeriodClosed(state, '2026-01') === true);
throws(() => engine.appendMovement(state, { date: '2026-01-31', type: 'transfer', in: { account: 'zelle', currency: 'USD', amount: 1 }, out: { account: 'panama', currency: 'USD', amount: 1 } }), /cerrado/, 'movimiento en periodo cerrado rechazado');
check('movimiento de febrero sí se acepta', (() => {
  try {
    engine.appendMovement(state, { date: '2026-02-01', type: 'contribution', in: { account: 'chile', currency: 'CLP', amount: 1000 } });
    return true;
  } catch (e) { return false; }
})());
throws(() => engine.closePeriod(state, '2026-01'), /ya está cerrado/, 'doble cierre rechazado');

console.log('\n[9b] Cierre con tasa faltante: aviso conservado, saldo nativo no contado como 0 silencioso');
// Fecha anclada + válida: una fecha malformada ya no eluda el bloqueo de periodo.
const stLock = engine.createInitialState();
engine.closePeriod(stLock, '2026-01', FX);
throws(() => engine.appendMovement(stLock, { date: 'xx2026-01-02', type: 'withdrawal', out: { account: 'zelle', currency: 'USD', amount: 1, rateAt: 1 } }), /Fecha inválida/, 'fecha malformada “xx2026-01-02” no eluda el cierre');
throws(() => engine.appendMovement(stLock, { date: '2026-13-99', type: 'withdrawal', out: { account: 'zelle', currency: 'USD', amount: 1, rateAt: 1 } }), /Fecha inválida/, '“2026-13-99” rechazada (calendario real)');
check(' Settings merge: falta de clave no produce NaN en comisión', (() => {
  const st2 = engine.load({ getItem: () => JSON.stringify({ commissionDefault: 0.07 }), setItem: () => {}, removeItem: () => {} });
  const q = engine.caseQuote(st2.settings, FX, { pair: ['COP', 'CLP'], direction: 'AB', deposit: 4200 });
  return st2.settings.commissionCop === 0.08 && q.ok === true && q.delivered > 0;
})());
const stEur = engine.createInitialState();
engine.appendMovement(stEur, { date: '2026-02-10', type: 'contribution', in: { account: 'eur', currency: 'EUR', amount: 50 } });
const snapEur = engine.closePeriod(stEur, '2026-02', FXnoEur);
check('cierre sin tasa EUR: aviso conservado en el snapshot', snapEur.warnings.some(w => /sin tasa para EUR/.test(w)), JSON.stringify(snapEur.warnings));
check('missingRates registra EUR y usdComplete=false', snapEur.missingRates.indexOf('EUR') >= 0 && snapEur.usdComplete === false);
near('usdValuation excluye lo sin tasa (no lo cuenta como 0 silencioso)', snapEur.usdValuation, 0, 1e-9);
check('balance() también avisa por moneda sin tasa', engine.balance(stEur, FXnoEur).warnings.some(w => /sin tasa para EUR/.test(w)));

console.log('\n[10] Export/import JSON/CSV + manifiesto');
const dump = engine.exportState(state);
check('manifiesto: cadena ok y conteos', dump.manifest.chainOk === true && dump.manifest.counts.movements === state.movements.length && dump.manifest.counts.accounts === 10);
check('manifiesto lista el periodo cerrado', dump.manifest.periodsClosed.indexOf('2026-01') >= 0);
const restored = engine.importState(dump);
check('import restaura saldo y cadena', engine.accountBalance(restored, 'zelle').native === -84 && engine.verifyChain(restored.movements));
const tamperedDump = JSON.parse(JSON.stringify(dump)); tamperedDump.movements[0].amountHack = true; tamperedDump.movements[0].out.amount = 1;
throws(() => engine.importState(tamperedDump), /alterado|inválida/i, 'import rechaza respaldo alterado');
const badFormat = { format: 'otro' };
throws(() => engine.importState(badFormat), /consutasas\/v2/, 'import rechaza formato ajeno');
const csv = engine.exportCsv(state);
check('CSV: cabecera + una fila por movimiento', csv.startsWith('seq,date,type,') && csv.trim().split('\n').length === state.movements.length + 1);
check('CSV escapa comillas', engine.exportCsv({ movements: [{ seq: 1, date: '2026-01-01', type: 'transfer', in: { account: 'a', currency: 'USD', amount: 1 }, out: { account: 'b', currency: 'USD', amount: 1 }, note: 'di "hola"', hash: 'x' }], accounts: [{ id: 'a', name: 'X', currency: 'USD' }, { id: 'b', name: 'Y', currency: 'USD' }] }).includes('"di ""hola"""'));
const reImportedButCsvNo = true; // CSV solo exportación (gap documentado)

console.log('\n[11] Migración de `consumo_operations` (v1) sin pérdida de datos');
const legacyOps = [
  { fecha: '2025-12-05', origen: 'PEN', destino: 'VES', sale: 100, saleRate: 3.7, entry: 360, entryRate: 1080, obs: 'yape', tercero: true },
  { fecha: 'malo', origen: 'PEN', destino: 'VES', sale: 50, entry: 180 },
  { fecha: '2025-12-06', origen: 'USD', destino: 'VES', sale: 20, entry: 21000 }
];
const store = (() => {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k)
  };
})();
store.setItem('consumo_operations', JSON.stringify(legacyOps));
const migratedState = engine.loadAndMigrate(store);
const legacyMv = migratedState.movements.filter(mm => mm.type === 'legacy');
check('3 operaciones legacy migradas (sin cuentas, null = externo)', legacyMv.length === 3);
check('DIRECCIÓN correcta: sale 100 PEN (out), entra 360 VES (in)',
  legacyMv[0].out && legacyMv[0].out.currency === 'PEN' && legacyMv[0].out.amount === 100 &&
  legacyMv[0].in && legacyMv[0].in.currency === 'VES' && legacyMv[0].in.amount === 360,
  JSON.stringify(legacyMv[0]));
check('objeto original íntegro en meta.original', legacyMv[0].meta.original.sale === 100 && legacyMv[0].meta.original.tercero === true);
check('fecha inválida se preserva como null sin romper', legacyMv[1].date === null);
check('cadena válida tras migración', engine.verifyChain(migratedState.movements));
check('migración idempotente (no duplica)', engine.loadAndMigrate(store).movements.filter(mm => mm.type === 'legacy').length === 3);
check('migrada persiste en ct_movements', JSON.parse(store.getItem(engine.STORAGE_KEYS.movements)).length === 3);

console.log('\n[12] Smoke ESTRUCTURAL de webapp/data/rates.json vivo (sin asertar tasas exactas)');
/* El bot regenera este archivo a diario: aquí solo se valida la ESTRUCTURA del snapshot,
 * nunca literales de tasas (esas se asertan en [3b]/[3c]/[3d] contra el fixture congelado). */
const localRates = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'rates.json'), 'utf8'));
check('rates.json vivo parsea con schema v1', localRates.schema === 'consutasas/rates.v1');
const siteFiats = ['VES', 'PEN', 'COP', 'CLP', 'MXN'];
check('todas las fiat del sitio registran pares', siteFiats.every(f => localRates.pairs && localRates.pairs[f] != null));
const adsProblem = (() => {
  for (const f of siteFiats) {
    const ads = localRates.pairs[f].ads || {};
    const cmp = ads.compra || [], vta = ads.venta || [];
    if (cmp.length !== 20 || vta.length !== 20) return f + ': compra=' + cmp.length + ' venta=' + vta.length;
    const okFields = a => a.price > 0 && a.min > 0 && a.max >= a.min && a.available > 0 &&
      typeof a.platform === 'string' && a.platform.length > 0 && Number.isFinite(a.page);
    for (const a of cmp.concat(vta)) { if (!okFields(a)) return f + ': ' + JSON.stringify(a); }
    for (let i = 1; i < cmp.length; i++) { if (cmp[i - 1].price > cmp[i].price) return f + ': compra no ascendente'; }
    for (let i = 1; i < vta.length; i++) { if (vta[i - 1].price < vta[i].price) return f + ': venta no descendente'; }
  }
  return null;
})();
check('cada fiat trae ads compra/venta 20/20 con orden asc/desc y campos completos', adsProblem === null, adsProblem || '');
check('eurRef con usd finito y status', localRates.eurRef != null &&
  Number.isFinite(localRates.eurRef.usd) && typeof localRates.eurRef.status === 'string' && localRates.eurRef.status.length > 0);

console.log('\n[13] Pares del usuario y cotización de pares personalizados');
const s2 = engine.defaultSettings();
s2.customPairs = [['VES', 'EUR']];
check('par personalizado agregado al settings', s2.customPairs.length === 1);
const qCustom = engine.caseQuote(s2, FX, { pair: ['VES', 'EUR'], direction: 'BA', deposit: 9 }); // 9 EUR → 10 USD → 11000 VES×0.93
check('par personalizado VES/EUR cotiza (referencial)', qCustom.ok && qCustom.referencial === true && Math.abs(qCustom.delivered - 11000 * 0.93) < 1e-6);

/* ==================== TAREA 3a: Motor de escenarios de tasa (panel) ==================== */

console.log('\n[14] adRateAt — max/best/average/min (3e) con ads inline');
// Fixture de ads para pruebas: compra asc, venta desc, con plataforma (Binance/Bybit)
var adsCompraInline = [
  { price: 3.50, min: 5, max: 500, available: 50, platform: 'binance' },
  { price: 3.60, min: 10, max: 2000, available: 200, platform: 'binance' },
  { price: 3.75, min: 15, max: 5000, available: 500, platform: 'binance' },
  { price: 3.52, min: 8, max: 8000, available: 800, platform: 'bybit' },
  { price: 3.55, min: 8, max: 8000, available: 800, platform: 'bybit' },
  { price: 3.65, min: 8, max: 8000, available: 800, platform: 'bybit' }
];
var adsVentaInline = [
  { price: 3.90, min: 10, max: 3000, available: 300, platform: 'binance' },
  { price: 3.80, min: 5, max: 2000, available: 200, platform: 'binance' },
  { price: 3.70, min: 8, max: 5000, available: 500, platform: 'binance' },
  { price: 3.88, min: 8, max: 8000, available: 800, platform: 'bybit' },
  { price: 3.86, min: 8, max: 8000, available: 800, platform: 'bybit' },
  { price: 3.84, min: 8, max: 8000, available: 800, platform: 'bybit' }
];

// best (criterio conservador): precio ejecutable a 40 USD equivalentes —
// compra = MAYOR price ejecutable (pagar más, conservador); venta = MENOR (recibir menos)
var arB = engine.adRateAt(FX, 'PEN', 'compra', 10, 'best', adsCompraInline);
check('adRateAt best compra: rate = 3.75 (MAYOR price ejecutable, criterio conservador; = MAX aquí)', arB.rate === 3.75);
check('adRateAt best compra: source ad_best_compra', arB.source === 'ad_best_compra');
check('adRateAt best compra: ad price 3.75', arB.ad && arB.ad.price === 3.75);
var arV = engine.adRateAt(FX, 'PEN', 'venta', 10, 'best', adsVentaInline);
check('adRateAt best venta: rate = 3.70 (MENOR price ejecutable, criterio conservador; = MIN aquí)', arV.rate === 3.70);
check('adRateAt best venta: source ad_best_venta', arV.source === 'ad_best_venta');
// BEST ≠ extremo cuando el ad extremo no es ejecutable a 40 US$ eq:
// compra con top 3.80 de min 200 (40×3.80 = 152 < 200) → best = 3.75, sin filtro MAX = 3.80.
var arBNear = engine.adRateAt(FX, 'PEN', 'compra', 10, 'best', adsCompraInline.concat([
  { price: 3.80, min: 200, max: 999999, available: 999999, platform: 'bybit' }
]));
check('adRateAt best compra cerca de MAX (no igual): top no ejecutable → best 3.75 < MAX sin filtro 3.80',
  arBNear.rate === 3.75 && engine.adRateAt(FX, 'PEN', 'compra', 10, 'max', adsCompraInline.concat([{ price: 3.80, min: 200, max: 999999, available: 999999, platform: 'bybit' }])).rate === 3.80);

// 3e: BEST usa un monto de referencia FIJO de 40 USD equivalentes (min/price…max/price):
// un ad con min 100 es ejecutable a 40 USD (40×3.60 = 144 ≥ 100) aunque a 10 no lo sería.
check('adRateAt best: min 100 sigue fuera a 10 USD pero entra a 40 USD (decisión 3e)',
  engine.adRateAt(FX, 'PEN', 'compra', 10, 'best', [{ price: 3.60, min: 100, max: 500000, available: 5000 }]) == null ||
  engine.adRateAt(FX, 'PEN', 'compra', 10, 'best', [{ price: 3.60, min: 100, max: 500000, available: 5000 }]).rate === 3.60);
var arB40 = engine.adRateAt(FX, 'PEN', 'compra', 10, 'best', [{ price: 3.60, min: 100, max: 500000, available: 5000 }]);
check('adRateAt best: monto fijo 40 USD eq → min 100 es ejecutable (rate 3.60)', arB40 != null && arB40.rate === 3.60);
check('adRateAt best: min 200 fuera incluso a 40 USD (40×3.60 = 144 < 200)',
  engine.adRateAt(FX, 'PEN', 'compra', 10, 'best', [{ price: 3.60, min: 200, max: 500000, available: 5000 }]) === null);

// average (3g): media aritmética de TODOS los anuncios del lado (ya NO media FX)
var arA = engine.adRateAt(FX, 'PEN', 'compra', 10, 'average', adsCompraInline);
check('adRateAt average: rate = media de los prices de TODOS los anuncios (3.595 con 6 anuncios)',
  typeof arA.rate === 'number' && Math.abs(arA.rate - (3.50 + 3.60 + 3.75 + 3.52 + 3.55 + 3.65) / 6) < 1e-9);
check('adRateAt average: source ad_average_compra', arA.source === 'ad_average_compra');
check('adRateAt average: ad null (no es un anuncio único) y adsCount 6', arA.ad === null && arA.adsCount === 6);
check('adRateAt average: NO es la media FX 3.5', arA.rate !== 3.5);

// min (3g): el menor price de TODOS los anuncios del lado (los 4 son ejecutables aquí)
var arMin = engine.adRateAt(FX, 'PEN', 'compra', 10, 'min', adsCompraInline);
check('adRateAt min compra: rate = 3.50 (menor price)', arMin.rate === 3.50);
check('adRateAt min compra: source ad_min_compra', arMin.source === 'ad_min_compra');
var arMinV = engine.adRateAt(FX, 'PEN', 'venta', 10, 'min', adsVentaInline);
check('adRateAt min venta: rate = 3.70 (menor price de la lista desc)', arMinV.rate === 3.70);
check('adRateAt min venta: source ad_min_venta y ad price 3.70', arMinV.source === 'ad_min_venta' && arMinV.ad && arMinV.ad.price === 3.70);

// max (3g): el MAYOR price de TODOS los anuncios del lado, sin filtro
var arMaxC = engine.adRateAt(FX, 'PEN', 'compra', 10, 'max', adsCompraInline);
check('adRateAt max compra: mayor price de todos = 3.75', arMaxC.rate === 3.75);
check('adRateAt max compra: source ad_max_compra y ad.price 3.75', arMaxC.source === 'ad_max_compra' && arMaxC.ad && arMaxC.ad.price === 3.75 && arMaxC.mode === 'max');
var arMaxV = engine.adRateAt(FX, 'PEN', 'venta', 10, 'max', adsVentaInline);
check('adRateAt max venta: mayor price de todos = 3.90 (antes 3e: tercer anuncio 3.84)', arMaxV.rate === 3.90);
check('adRateAt max venta: source ad_max_venta', arMaxV.source === 'ad_max_venta');
check('adRateAt max: sin avisos de plataforma (3g: la lógica del tercer anuncio existe YA NO)',
  arMaxC.warnings === undefined && arMaxV.warnings === undefined);
var arMax2 = engine.adRateAt(FX, 'PEN', 'compra', 10, 'max', [
  { price: 3.55, min: 5, max: 5000, available: 500, platform: 'binance' },
  { price: 3.90, min: 5, max: 100000, available: 500, platform: 'binance' },
  { price: 3.52, min: 8, max: 8000, available: 800, platform: 'bybit' },
  { price: 3.55, min: 8, max: 8000, available: 800, platform: 'bybit' }
]);
check('adRateAt max compra: SIN agrupado por plataforma — el mayor de todos (3.90) aunque su ad sea poco disponible',
  arMax2.rate === 3.90 && arMax2.ad && arMax2.ad.price === 3.90);
check('adRateAt max compra: sin warnings aunque ninguna plataforma tenga 3 anuncios',
  arMax2.warnings === undefined, JSON.stringify(arMax2));

// 3g — INVARIANTE fundamental: MAX ≥ AVG ≥ MIN en ambos lados, y BEST queda
// entre Mínimo y Máximo (BEST compra = menor ejecutable a 40 US$ eq; BEST
// venta = mayor ejecutable).
var minC = engine.adRateAt(FX, 'PEN', 'compra', 10, 'min', adsCompraInline).rate;
var avgC = engine.adRateAt(FX, 'PEN', 'compra', 10, 'average', adsCompraInline).rate;
var maxC = engine.adRateAt(FX, 'PEN', 'compra', 10, 'max', adsCompraInline).rate;
var bestC = engine.adRateAt(FX, 'PEN', 'compra', 10, 'best', adsCompraInline).rate;
var minV = engine.adRateAt(FX, 'PEN', 'venta', 10, 'min', adsVentaInline).rate;
var avgV = engine.adRateAt(FX, 'PEN', 'venta', 10, 'average', adsVentaInline).rate;
var maxV = engine.adRateAt(FX, 'PEN', 'venta', 10, 'max', adsVentaInline).rate;
var bestV = engine.adRateAt(FX, 'PEN', 'venta', 10, 'best', adsVentaInline).rate;
check('3g compra: MAX ≥ AVG ≥ MIN (3.75 ≥ 3.595 ≥ 3.50)', maxC >= avgC && avgC >= minC && maxC === 3.75 && Math.abs(avgC - 3.595) < 1e-9 && minC === 3.50);
check('3g venta: MAX ≥ AVG ≥ MIN (3.90 ≥ 3.83 ≥ 3.70)', maxV >= avgV && avgV >= minV && maxV === 3.90 && Math.abs(avgV - 3.83) < 1e-9 && minV === 3.70);
check('3g: BEST entre MIN y MAX en compra (3.50 ≤ 3.75 ≤ 3.75) y en venta (3.70 ≤ 3.70 ≤ 3.90; BEST = MIN venta aquí)',
  minC <= bestC && bestC <= maxC && bestC === 3.75 && minV <= bestV && bestV <= maxV && bestV === 3.70);

// 3g: min/max/average SIN filtro de ejecutabilidad (antes filtraban por
// min/max/available con el monto real; ahora toman todos los anuncios del lado).
check('adRateAt min: SIN filtro — incluye el ad aunque cost < min (antes: null)',
  engine.adRateAt(FX, 'PEN', 'compra', 10, 'min', [{ price: 3.60, min: 50, max: 500, available: 100 }]).rate === 3.60);
check('adRateAt min: SIN filtro — incluye el ad aunque cost > max',
  engine.adRateAt(FX, 'PEN', 'compra', 10, 'min', [{ price: 3.60, min: 1, max: 30, available: 100 }]).rate === 3.60);
check('adRateAt min: SIN filtro — incluye el ad aunque available < amount',
  engine.adRateAt(FX, 'PEN', 'compra', 100, 'min', [{ price: 3.60, min: 1, max: 500, available: 10 }]).rate === 3.60);
check('adRateAt average: media de TODOS los anuncios aunque ninguno sea ejecutable (3.60, antes: fallback media FX 3.5)',
  Math.abs(engine.adRateAt(FX, 'PEN', 'compra', 10, 'average', [{ price: 3.60, min: 50, max: 500, available: 100 }]).rate - 3.6) < 1e-9);
check('adRateAt average: admite montos de ad fuera de rango (no filtra disponible)',
  engine.adRateAt(FX, 'PEN', 'compra', 100, 'average', [{ price: 3.60, min: 1, max: 500, available: 10 }]).rate === 3.60);

// ads variadas: la media incluye TODOS los ads del lado (el no ejecutable con
// min 60, cost 33 < 60, no filtra: antes caía a media FX).
var adsThick = [{ price: 3.30, min: 25, max: 5000, available: 100 }];
var arF = engine.adRateAt(FX, 'PEN', 'compra', 10, 'average', adsThick);
check('adRateAt average: media de TODOS los anuncios del lado (3.30), no media FX', arF != null && arF.rate === 3.30 && arF.source === 'ad_average_compra' && arF.adsCount === 1);
var arFb = engine.adRateAt(FX, 'PEN', 'compra', 10, 'average', [{ price: 3.30, min: 60, max: 5000, available: 100 }]);
check('adRateAt average: incluye el ad NO ejecutable (3.30 con min 60; antes: fallback media FX 3.5, media(PEN/compra))',
  arFb != null && arFb.rate === 3.30 && arFb.source === 'ad_average_compra' && arFb.adsCount === 1);
// ads vacías → fallback a media FX (en los cuatro modos)
check('adRateAt average ads vacías: fallback media FX compra (1000)', engine.adRateAt(FX, 'VES', 'compra', 10, 'average', []).rate === 1000);
check('adRateAt best ads vacías: fallback media FX compra', engine.adRateAt(FX, 'VES', 'compra', 10, 'best', []).rate === 1000);
check('adRateAt min ads vacías: fallback media FX venta', engine.adRateAt(FX, 'VES', 'venta', 10, 'min', []).rate === 1100);
check('adRateAt max ads vacías: fallback media FX compra', engine.adRateAt(FX, 'VES', 'compra', 10, 'max', []).rate === 1000);
// Fiat no existente → null
check('adRateAt fiat sin tasa: null', engine.adRateAt(FX, 'XXX', 'compra', 10, 'best', []) === null);

console.log('\n[14b] rateScenarios — devuelve los 4 por lado (max/best/average/min, 3e)');
var scenarios = engine.rateScenarios(S, FX, ['VES', 'PEN'], 'BA', 10, 'compra');
check('rateScenarios: best existe', scenarios.best && scenarios.best.originRate && scenarios.best.destRate);
check('rateScenarios: average existe', scenarios.average && scenarios.average.originRate && scenarios.average.destRate);
check('rateScenarios: min existe', scenarios.min && scenarios.min.originRate && scenarios.min.destRate);
check('rateScenarios: max existe', scenarios.max && scenarios.max.originRate && scenarios.max.destRate);
check('rateScenarios: el escenario 2% (conservative) ya no existe (3e)', scenarios.conservative === undefined);
check('rateScenarios sin ads: best = average = min = max = media FX',
  scenarios.best.originRate === scenarios.average.originRate && scenarios.average.originRate === scenarios.min.originRate &&
  scenarios.min.originRate === scenarios.max.originRate && scenarios.best.destRate === scenarios.max.destRate);
// con ads inline
var fxAds = engine.buildFx({
  fixture: true,
  pairs: { VES: { compra: 1000, venta: 1100 } },
  eurRef: { fixture: true, source: 'frankfurter', usdToEur: 0.9 }
});
// ads explícitos para rateScenarios: { currency: { side: [ads] } } — side = compra/venta
var scAds = engine.rateScenarios(S, fxAds, ['VES', 'PEN'], 'BA', 10, 'compra', {
  PEN: { compra: adsCompraInline, venta: adsVentaInline },  // origin usa compra, dest usa venta
  VES: { compra: [], venta: [] }                            // sin ads → media FX
});
// Para BA: origin = PEN (compra), dest = VES (venta)
check('rateScenarios con ads: best originRate (PEN compra, MAYOR ejecutable) = 3.75', scAds.best.originRate === 3.75);
check('rateScenarios con ads: best destRate (VES sin ads) = media 1100', scAds.best.destRate === 1100);
check('rateScenarios con ads: max originRate (mayor price de todos) = 3.75',
  scAds.max.originRate === 3.75);
check('rateScenarios con ads: max destRate (VES sin ads) = media 1100', scAds.max.destRate === 1100);
// average usa la media de los anuncios y propaga source/adsCount (adUsed null)
check('rateScenarios con ads: average originRate = media de los 6 anuncios (3.595), no media FX 3.5',
  Math.abs(scAds.average.originRate - (3.50 + 3.60 + 3.75 + 3.52 + 3.55 + 3.65) / 6) < 1e-9 && scAds.average.originRate !== 3.5);
check('rateScenarios con ads: average destRate (VES sin ads) = media FX 1100', scAds.average.destRate === 1100);
check('rateScenarios con ads: average propaga originSource/destSource, adsCount y originAd/destAd null',
  scAds.average.originSource === 'ad_average_compra' && scAds.average.destSource === 'media(VES/venta)' &&
  scAds.average.originAdsCount === 6 && scAds.average.destAdsCount === 0 &&
  scAds.average.originAd == null && scAds.average.destAd == null);
check('rateScenarios con ads: MIN ≤ BEST ≤ MAX en compra (3.50 ≤ 3.75 ≤ 3.75) y en venta',
  scAds.min.originRate === 3.50 && scAds.min.originRate <= scAds.best.originRate && scAds.best.originRate <= scAds.max.originRate);
check('rateScenarios con ads: MAX ≥ AVG ≥ MIN en venta (dest side, invariante 3g)',
  scAds.max.destRate >= scAds.average.destRate && scAds.average.destRate >= scAds.min.destRate);
check('rateScenarios 3g: sin warnings/originWarn/destWarn en ningún escenario',
  scAds.max.warnings === undefined && scAds.max.originWarn === undefined && scAds.max.destWarn === undefined,
  JSON.stringify(scAds.max));

console.log('\n[14c] Máximo/mínimo/promedio sobre TODOS los anuncios (3g) — sin lógica de tercer anuncio');
var scAdsMax2 = engine.rateScenarios(S, fxAds, ['VES', 'PEN'], 'BA', 10, 'compra', {
  PEN: {
    compra: [
      { price: 3.90, min: 5, max: 5000, available: 500, platform: 'binance' },
      { price: 3.55, min: 5, max: 5000, available: 500, platform: 'binance' },
      { price: 3.52, min: 8, max: 8000, available: 800, platform: 'bybit' },
      { price: 3.55, min: 8, max: 8000, available: 800, platform: 'bybit' }
    ], venta: []
  }, VES: { compra: [], venta: [] }
});
check('rateScenarios max: SIN agrupado por plataforma — el mayor de todos (3.90), sin avisos',
  scAdsMax2.max.originRate === 3.90 && scAdsMax2.max.warnings === undefined &&
  scAdsMax2.max.originWarn === undefined, JSON.stringify(scAdsMax2.max));
var minAll = engine.adRateAt(fxAds, 'PEN', 'compra', 10, 'min', [
  { price: 3.90, min: 5, max: 5000, available: 500, platform: 'binance' },
  { price: 3.55, min: 350000, max: 500000, available: 500, platform: 'binance' }, // NO ejecutable: cost 355000 > max
  { price: 3.40, min: 8, max: 8000, available: 800, platform: 'bybit' }
]);
check('rateScenarios sources 3g: min incluye TODOS los ads (3.40 aunque el de 3.55 no sea ejecutable)',
  minAll != null && minAll.rate === 3.40 && minAll.source === 'ad_min_compra');

console.log('\n[14d] caseQuoteScenario PEN→COP (3e): matriz max/best/average/min sin 2%');
var fxCopAds = engine.buildFx({
  fixture: true,
  pairs: { PEN: { compra: 3.5, venta: 3.7 }, COP: { compra: 4000, venta: 4200 } },
  eurRef: { fixture: true, source: 'frankfurter', usdToEur: 0.9 }
});
fxCopAds.pairs = {
  PEN: { ads: adsCompraInline }, // compra: best = MAYOR ejecutable (3.75) … min 3.50
  COP: { ads: [                  // venta: best = MENOR ejecutable 4190 … max 4250
    { price: 4250, min: 5, max: 999999, available: 999999, platform: 'bybit' },
    { price: 4245, min: 5, max: 999999, available: 999999, platform: 'bybit' },
    { price: 4240, min: 5, max: 999999, available: 999999, platform: 'bybit' },
    { price: 4200, min: 5, max: 999999, available: 999999, platform: 'binance' },
    { price: 4195, min: 5, max: 999999, available: 999999, platform: 'binance' },
    { price: 4190, min: 5, max: 999999, available: 999999, platform: 'binance' }
  ] }
};
var qMaxCop = engine.caseQuoteScenario(S, fxCopAds, {
  pair: ['PEN', 'COP'], direction: 'AB', deposit: 100,
  originMode: 'max', destMode: 'max',
  commissionPct: 0.05, terceroOn: false
});
check('caseQuoteScenario Máximo PEN→COP: ok', qMaxCop.ok === true);
check('caseQuoteScenario PEN→COP máx compra: originRate = 3.75 (mayor price de todos)',
  Math.abs(qMaxCop.rateInfo.originRate - 3.75) < 1e-9);
check('caseQuoteScenario PEN→COP máx venta: destRate = 4250 (mayor price de todos, antes tercer anuncio 4240)',
  Math.abs(qMaxCop.rateInfo.destRate - 4250) < 1e-9);
check('caseQuoteScenario PEN→COP Máximo: sin 2% y sin safetyPct (3e lo elimina)',
  qMaxCop.rateInfo.safetyPct === undefined && qMaxCop.scenario.vesSafetyPct === undefined);
check('caseQuoteScenario PEN→COP Máximo: adUsed = ad del mayor price (3.75)',
  qMaxCop.rateInfo.adUsed != null && qMaxCop.rateInfo.adUsed.ad.price === 3.75 && qMaxCop.rateInfo.adUsed.mode === 'max');
check('caseQuoteScenario PEN→COP Máximo: rateInfo coherente (efectiva = delivered/deposit, pactada bruta, mercado, profitSafety)',
  qMaxCop.rateInfo.effectiveRate != null && Math.abs(qMaxCop.rateInfo.effectiveRate - Math.round(qMaxCop.delivered / qMaxCop.deposit * 100) / 100) < 1e-9 &&
  Math.abs(qMaxCop.rateInfo.quotedRate - Math.round(4250 / 3.75 * 100) / 100) < 1e-9 &&
  typeof qMaxCop.rateInfo.marketRate === 'number' && typeof qMaxCop.rateInfo.profitSafety === 'number');
var destMax = qMaxCop.rateInfo.destScenarios.max;
check('caseQuoteScenario PEN→COP Máximo: destScenarios.max.destRate = 4250 y destAd.price = 4250',
  destMax && Math.abs(destMax.destRate - 4250) < 1e-9 && destMax.destAd && destMax.destAd.rate === 4250);
check('caseQuoteScenario PEN→COP Máximo: delivered = 107.666,67 (5%, máximo/máximo con venta 4250)',
  qMaxCop.delivered === 107666.67, String(qMaxCop.delivered));

// Best/Best: criterio conservador a 40 USD eq — compra = MAYOR ejecutable (3.75),
// venta = MENOR ejecutable (4190): BEST queda cerca de MAX (compra) y cerca de MIN (venta).
var qBestCop = engine.caseQuoteScenario(S, fxCopAds, {
  pair: ['PEN', 'COP'], direction: 'AB', deposit: 100,
  originMode: 'best', destMode: 'best', commissionPct: 0.05, terceroOn: false
});
check('caseQuoteScenario Mejor PEN→COP: originRate 3.75 (mayor compra ejecutable) y destRate 4190 (menor venta ejecutable)',
  Math.abs(qBestCop.rateInfo.originRate - 3.75) < 1e-9 && Math.abs(qBestCop.rateInfo.destRate - 4190) < 1e-9);
check('caseQuoteScenario Mejor PEN→COP: delivered = 106.146,67', qBestCop.delivered === 106146.67, String(qBestCop.delivered));
check('caseQuoteScenario Mejor PEN→COP: adUsed = ad del mayor compra ejecutable (3.75) y destAd 4190',
  qBestCop.rateInfo.adUsed != null && qBestCop.rateInfo.adUsed.ad.price === 3.75 &&
  qBestCop.rateInfo.originScenarios.best.destAd && qBestCop.rateInfo.originScenarios.best.destAd.ad.price === 4190);

// average/average: media de ejecutables (monto real)
var qAvgCop = engine.caseQuoteScenario(S, fxCopAds, {
  pair: ['PEN', 'COP'], direction: 'AB', deposit: 100,
  originMode: 'average', destMode: 'average', commissionPct: 0.05, terceroOn: false
});
check('caseQuoteScenario average PEN→COP: ok y adUsed null', qAvgCop.ok === true && qAvgCop.rateInfo.adUsed == null);
check('caseQuoteScenario average PEN→COP: originRate (3.595) ≠ media FX 3.5 y destRate 4220 (media de 6)',
  Math.abs(qAvgCop.rateInfo.originRate - 3.595) < 1e-9 && Math.abs(qAvgCop.rateInfo.destRate - 4220) < 1e-9);
check('caseQuoteScenario average PEN→COP: source ad_average_* y adsCount 6',
  qAvgCop.rateInfo.originSource === 'ad_average_compra' && qAvgCop.rateInfo.destSource === 'ad_average_venta' &&
  qAvgCop.rateInfo.originAdsCount === 6 && qAvgCop.rateInfo.destAdsCount === 6);
check('caseQuoteScenario average PEN→COP: delivered = 111.515,99', qAvgCop.delivered === 111515.99, String(qAvgCop.delivered));

// min/min: menor price ejecutable (monto real)
var qMinCop = engine.caseQuoteScenario(S, fxCopAds, {
  pair: ['PEN', 'COP'], direction: 'AB', deposit: 100,
  originMode: 'min', destMode: 'min', commissionPct: 0.05, terceroOn: false
});
check('caseQuoteScenario min PEN→COP: originRate 3.50 y destRate 4190 (menor price venta)',
  Math.abs(qMinCop.rateInfo.originRate - 3.5) < 1e-9 && Math.abs(qMinCop.rateInfo.destRate - 4190) < 1e-9);
check('caseQuoteScenario min PEN→COP: delivered = 113.728,57', qMinCop.delivered === 113728.57, String(qMinCop.delivered));
check('caseQuoteScenario matriz: MIN ≤ AVG ≤ MAX y BEST entre MIN y MAX en ambos lados (criterio conservador)',
  qMinCop.rateInfo.originRate <= qAvgCop.rateInfo.originRate && qAvgCop.rateInfo.originRate <= qMaxCop.rateInfo.originRate &&
  qMinCop.rateInfo.originRate <= qBestCop.rateInfo.originRate && qBestCop.rateInfo.originRate <= qMaxCop.rateInfo.originRate &&
  qMinCop.rateInfo.destRate <= qAvgCop.rateInfo.destRate && qAvgCop.rateInfo.destRate <= qMaxCop.rateInfo.destRate &&
  qMinCop.rateInfo.destRate <= qBestCop.rateInfo.destRate && qBestCop.rateInfo.destRate <= qMaxCop.rateInfo.destRate);
check('caseQuoteScenario: BEST compra cerca de MAX (3.75 = MAX) y BEST venta cerca de MIN (4190 = MIN)',
  qBestCop.rateInfo.originRate === qMaxCop.rateInfo.originRate && qBestCop.rateInfo.destRate === qMinCop.rateInfo.destRate);

console.log('\n[14e] caseQuoteScenario: sin avisos de plataforma (3g; el Máximo es el mayor price)');
// Binance PEN/compra con 2 anuncios (<3): y con 3g eso ya NO genera avisos.
var fxWarnQ = engine.buildFx({
  fixture: true,
  pairs: { PEN: { compra: 3.5, venta: 3.7 }, COP: { compra: 4000, venta: 4200 } },
  eurRef: { fixture: true, source: 'frankfurter', usdToEur: 0.9 }
});
fxWarnQ.pairs = {
  PEN: { ads: [
    { price: 3.50, min: 5, max: 500, available: 50, platform: 'binance' },
    { price: 3.60, min: 10, max: 2000, available: 200, platform: 'binance' },
    { price: 3.52, min: 8, max: 8000, available: 800, platform: 'bybit' },
    { price: 3.55, min: 8, max: 8000, available: 800, platform: 'bybit' },
    { price: 3.65, min: 8, max: 8000, available: 800, platform: 'bybit' }
  ] },
  COP: { ads: [
    { price: 4250, min: 5, max: 999999, available: 999999, platform: 'bybit' },
    { price: 4245, min: 5, max: 999999, available: 999999, platform: 'bybit' },
    { price: 4240, min: 5, max: 999999, available: 999999, platform: 'bybit' },
    { price: 4200, min: 5, max: 999999, available: 999999, platform: 'binance' },
    { price: 4195, min: 5, max: 999999, available: 999999, platform: 'binance' },
    { price: 4190, min: 5, max: 999999, available: 999999, platform: 'binance' }
  ] }
};
var qBestWarn = engine.caseQuoteScenario(S, fxWarnQ, {
  pair: ['PEN', 'COP'], direction: 'AB', deposit: 100,
  originMode: 'best', destMode: 'best', commissionPct: 0.05, terceroOn: false
});
check('caseQuoteScenario best PEN→COP (binance <3): ok', qBestWarn.ok === true, JSON.stringify(qBestWarn.error || qBestWarn.delivered));
check('caseQuoteScenario best: rateInfo.warnings = [] (3g: sin avisos por modo)',
  Array.isArray(qBestWarn.rateInfo.warnings) && qBestWarn.rateInfo.warnings.length === 0,
  JSON.stringify(qBestWarn.rateInfo.warnings));
check('caseQuoteScenario best: scenarios.max SIN warnings (3g retiró la lógica del tercer anuncio)',
  qBestWarn.rateInfo.originScenarios.max.warnings === undefined,
  JSON.stringify(qBestWarn.rateInfo.originScenarios.max));
var qMaxWarn = engine.caseQuoteScenario(S, fxWarnQ, {
  pair: ['PEN', 'COP'], direction: 'AB', deposit: 100,
  originMode: 'max', destMode: 'max', commissionPct: 0.05, terceroOn: false
});
check('caseQuoteScenario max: rateInfo.warnings = [] aunque ninguna plataforma tenga 3 anuncios',
  Array.isArray(qMaxWarn.rateInfo.warnings) && qMaxWarn.rateInfo.warnings.length === 0,
  JSON.stringify(qMaxWarn.rateInfo.warnings));
check('caseQuoteScenario max PEN→COP (compra): originRate = mayor price de todos = 3.65',
  Math.abs(qMaxWarn.rateInfo.originRate - 3.65) < 1e-9);

console.log('\n[15] caseQuoteScenario — tasas manuales (3e): factor de seguridad por lado');
// Manual origen 3.60 vs sistema (Máximo) 3.75 → factor = (3.75 − 3.60)/3.75 × 100 = 4 % (descuento)
var qMan = engine.caseQuoteScenario(S, fxCopAds, {
  pair: ['PEN', 'COP'], direction: 'AB', deposit: 100,
  originMode: 'max', destMode: 'max', originManualRate: 3.6,
  commissionPct: 0.05, terceroOn: false
});
check('caseQuoteScenario manual origen: ok', qMan.ok === true);
check('caseQuoteScenario manual origen: originRate = manual 3.60 (la manual manda)',
  Math.abs(qMan.rateInfo.originRate - 3.6) < 1e-9);
check('caseQuoteScenario manual origen: originSystemRate = 3.75 (tasa del sistema)',
  Math.abs(qMan.rateInfo.originSystemRate - 3.75) < 1e-9);
check('caseQuoteScenario manual origen: originSecurityFactor = 4 % ((sistema − manual)/sistema × 100)',
  Math.abs(qMan.rateInfo.originSecurityFactor - 4) < 1e-6);
check('caseQuoteScenario manual origen: originSource = manual y adUsed null',
  qMan.rateInfo.originSource === 'manual' && qMan.rateInfo.adUsed == null);
check('caseQuoteScenario manual origen: delivered = 112.152,78 (base manual 3.60 con sistema max/max 3.75/4250)',
  qMan.delivered === 112152.78, String(qMan.delivered));
check('caseQuoteScenario manual origen: destino sin manual → destManualRate null y factor null',
  qMan.rateInfo.destManualRate == null && qMan.rateInfo.destSecurityFactor == null && qMan.rateInfo.destSource === 'ad_max_venta');
// Manual destino mayor que el sistema (4250) → factor NEGATIVO (recargo), se muestra tal cual
var qManNeg = engine.caseQuoteScenario(S, fxCopAds, {
  pair: ['PEN', 'COP'], direction: 'AB', deposit: 100,
  originMode: 'max', destMode: 'max', destManualRate: 4260,
  commissionPct: 0.05, terceroOn: false
});
check('caseQuoteScenario manual destino: destRate = 4260 (manual manda aunque recargue)',
  Math.abs(qManNeg.rateInfo.destRate - 4260) < 1e-9);
check('caseQuoteScenario manual destino: destSecurityFactor NEGATIVO ≈ −0.23529 % (recargo vs sistema 4250)',
  Math.abs(qManNeg.rateInfo.destSecurityFactor - ((4250 - 4260) / 4250 * 100)) < 1e-9, String(qManNeg.rateInfo.destSecurityFactor));
check('caseQuoteScenario manual destino: destSource = manual y delivered = 107.920,00',
  qManNeg.rateInfo.destSource === 'manual' && qManNeg.delivered === 107920, String(qManNeg.delivered));
// Manual en modo inverso también manda
var qManRev = engine.caseQuoteScenario(S, fxCopAds, {
  pair: ['PEN', 'COP'], direction: 'AB', originMode: 'max', destMode: 'max',
  originManualRate: 3.6, target: 100000, reversed: true,
  commissionPct: 0.05, terceroOn: false
});
check('caseQuoteScenario manual inverso: ok y originRate = 3.60 (manual)',
  qManRev.ok === true && Math.abs(qManRev.rateInfo.originRate - 3.6) < 1e-9);
check('caseQuoteScenario manual inverso: revSecurityFactor = 4 %',
  Math.abs(qManRev.rateInfo.originSecurityFactor - 4) < 1e-6);

console.log('\n[15b] caseQuoteScenario con fixture congelado sin 2% (3e): los 2% ya no existen');
var Spen = engine.defaultSettings();
// PEN→VES 160 PEN, 5% com: SIN 2% → destRate = venta_VES 1087.9581 (antes ×0.98)
var qPenVes = engine.caseQuoteScenario(Spen, FXreal, {
  pair: ['VES', 'PEN'], direction: 'BA', deposit: 160,
  originMode: 'best', destMode: 'best',
  commissionPct: 0.05, terceroOn: false
});
check('caseQuoteScenario PEN→VES: ok', qPenVes.ok === true);
check('caseQuoteScenario PEN→VES: currencyIn PEN / currencyOut VES', qPenVes.currencyIn === 'PEN' && qPenVes.currencyOut === 'VES');
check('caseQuoteScenario PEN→VES: deposit 160 PEN', qPenVes.deposit === 160);
check('caseQuoteScenario PEN→VES: commission 5%, tercero 0 (off)', qPenVes.commission === 0.05 && qPenVes.commissionPct === 5 && qPenVes.tercero === 0);
check('caseQuoteScenario PEN→VES: originRate = 3.5845 (compra_PEN, sin 2%)',
  Math.abs(qPenVes.rateInfo.originRate - 3.5845) < 0.001);
check('caseQuoteScenario PEN→VES: destRate = 1087.9581 (venta_VES, SIN ×0,98)',
  Math.abs(qPenVes.rateInfo.destRate - 1087.9581) < 0.001);
check('caseQuoteScenario PEN→VES: grossUsd ≈ 44.6366', Math.abs(qPenVes.grossUsd - 160 / 3.5845) < 0.001);
check('caseQuoteScenario PEN→VES: delivered = 46.134,64', qPenVes.delivered === 46134.64, String(qPenVes.delivered));
check('caseQuoteScenario PEN→VES: profit ≈ 2.23', Math.abs(qPenVes.profitUsd - 2.23) < 0.01);
check('caseQuoteScenario PEN→VES: rateInfo.originScenarios/destScenarios con best',
  qPenVes.rateInfo.originScenarios && qPenVes.rateInfo.originScenarios.best && qPenVes.rateInfo.destScenarios && qPenVes.rateInfo.destScenarios.best);
check('caseQuoteScenario PEN→VES: rateInfo.effectiveRate/quotedRate/marketRate numéricos y desacoplados',
  typeof qPenVes.rateInfo.effectiveRate === 'number' && typeof qPenVes.rateInfo.quotedRate === 'number' &&
  Math.abs(qPenVes.rateInfo.effectiveRate - qPenVes.rateInfo.quotedRate) > 0.01 &&
  Math.abs(qPenVes.rateInfo.marketRate - 303.52) < 0.01);
check('caseQuoteScenario PEN→VES: sin 2% → sin safetyPct y sin цены de safety en scenario',
  qPenVes.rateInfo.safetyPct === undefined && qPenVes.scenario.vesSafetyPct === undefined);
check('caseQuoteScenario PEN→VES: sin manual → manual/factor null y source media(...)',
  qPenVes.rateInfo.originManualRate == null && qPenVes.rateInfo.originSecurityFactor == null &&
  qPenVes.rateInfo.destSource === 'media(VES/venta)');
// VES→PEN 10000: originRate = compra_VES 1098.2057 (sin ×1,02), destRate = venta_PEN 3.4462
var qVesPen = engine.caseQuoteScenario(Spen, FXreal, {
  pair: ['VES', 'PEN'], direction: 'AB', deposit: 10000,
  originMode: 'best', destMode: 'best', commissionPct: 0.05, terceroOn: false
});
check('caseQuoteScenario VES→PEN: originRate = 1098.2057 (sin 2%)', Math.abs(qVesPen.rateInfo.originRate - 1098.2057) < 0.001);
check('caseQuoteScenario VES→PEN: destRate = 3.4462 (sin 2%)', Math.abs(qVesPen.rateInfo.destRate - 3.4462) < 0.001);
check('caseQuoteScenario VES→PEN: delivered = 29,81', qVesPen.delivered === 29.81, String(qVesPen.delivered));
// VES→COP 10000: destRate = venta_COP 3379.0956 sin 2%
var qVesCop = engine.caseQuoteScenario(Spen, FXreal, {
  pair: ['VES', 'COP'], direction: 'AB', deposit: 10000,
  originMode: 'best', destMode: 'best', commissionPct: 0.05, terceroOn: false
});
check('caseQuoteScenario VES→COP: originRate = 1098.2057 y destRate = 3379.0956 (sin 2%, ambos lados)',
  Math.abs(qVesCop.rateInfo.originRate - 1098.2057) < 0.001 && Math.abs(qVesCop.rateInfo.destRate - 3379.0956) < 0.001);
check('caseQuoteScenario VES→COP: delivered = 29.230,78', qVesCop.delivered === 29230.78, String(qVesCop.delivered));
// COP→PEN (BA): 100.000 COP
var qNoVesBA = engine.caseQuoteScenario(Spen, FXreal, {
  pair: ['PEN', 'COP'], direction: 'BA', deposit: 100000,
  originMode: 'best', destMode: 'best', commissionPct: 0.05, terceroOn: false
});
check('caseQuoteScenario COP→PEN: originRate = 3522.9472 y destRate = 3.4462 (sin 2%)',
  Math.abs(qNoVesBA.rateInfo.originRate - 3522.9472) < 0.001 && Math.abs(qNoVesBA.rateInfo.destRate - 3.4462) < 0.001);

console.log('\n[15d] Reverse simétrico (PEN→VES inverso) sin 2%');
var qRev = engine.caseQuoteScenario(Spen, FXreal, {
  pair: ['VES', 'PEN'], direction: 'BA', target: 47771.43,
  originMode: 'best', destMode: 'best',
  commissionPct: 0.05, terceroOn: false, reversed: true
});
check('caseQuoteScenario reverse: ok/reversed/monedas', qRev.ok === true && qRev.reversed === true && qRev.currencyIn === 'PEN' && qRev.currencyOut === 'VES');
check('caseQuoteScenario reverse: delivered = target 47771.43', qRev.delivered === 47771.43);
var revGrossUsd = 47771.43 / 1087.9581 / 0.95;
var revDeposit = Math.round(revGrossUsd * 3.5845 * 100) / 100;
check('caseQuoteScenario reverse: deposit ≈ ' + revDeposit + ' PEN (destRate sin 2%)', Math.abs(qRev.deposit - revDeposit) < 0.5, String(qRev.deposit));
check('caseQuoteScenario reverse: profit > 0', qRev.profitUsd > 0);
check('caseQuoteScenario reverse: rateInfo.originScenarios', qRev.rateInfo.originScenarios && qRev.rateInfo.originScenarios.best);
check('caseQuoteScenario reverse: marketRate cross ≈ 303.52 (raw best scenario)', Math.abs(qRev.rateInfo.marketRate - 303.52) < 0.01);
check('caseQuoteScenario reverse: profitSafety = deposit × (marketRate − quotedRate)',
  Math.abs(qRev.rateInfo.profitSafety - (qRev.deposit * (qRev.rateInfo.marketRate - qRev.rateInfo.quotedRate))) < 0.01);
check('caseQuoteScenario reverse: effectiveRate = delivered / deposit calculado',
  Math.abs(qRev.rateInfo.effectiveRate - (qRev.delivered / qRev.deposit)) < 0.01);
// reverse+ads: bootstrap media FX → primera/segunda pasada; BEST a 40 USD eq hace
// ejecutable el ad (40×3.5845 = 143.38 ≥ min 100) incluso en la primera pasada.
var fxAd = engine.buildFx({
  fixture: true,
  pairs: { VES: { compra: 1098.2057, venta: 1087.9581 }, PEN: { compra: 3.5845, venta: 3.4462 } },
  eurRef: { fixture: true, source: 'frankfurter', usdToEur: 0.9 }
});
fxAd.pairs = { PEN: { ads: [{ price: 3.5845, min: 100, max: 5000, available: 100 }] }, VES: { ads: [] } };
var qRevAd = engine.caseQuoteScenario(Spen, fxAd, {
  pair: ['VES', 'PEN'], direction: 'BA',
  originMode: 'best', destMode: 'best',
  commissionPct: 0.05, terceroOn: false, reversed: true,
  target: 47771.43
});
check('caseQuoteScenario reverse+ads: ok === true', qRevAd.ok === true);
check('caseQuoteScenario reverse+ads: rateInfo.adUsed.ad.price === 3.5845 (BEST a 40 USD eq, 3e)',
  qRevAd.rateInfo.adUsed != null && qRevAd.rateInfo.adUsed.ad.price === 3.5845);
check('caseQuoteScenario reverse+ads: deposit ≈ 165,68 PEN', Math.abs(qRevAd.deposit - 165.68) < 0.5, String(qRevAd.deposit));
check('caseQuoteScenario reverse+ads: effectiveRate = delivered/deposit',
  Math.abs(qRevAd.rateInfo.effectiveRate - (qRevAd.delivered / qRevAd.deposit)) < 0.01);

console.log('\n[15e] Tercero on (25%)');
var qTerc = engine.caseQuoteScenario(Spen, FX, {
  pair: ['VES', 'PEN'], direction: 'BA', deposit: 160,
  originMode: 'best', destMode: 'best', commissionPct: 0.05, terceroOn: true
});
check('caseQuoteScenario terceroOn: tercero > 0', qTerc.tercero > 0);
check('caseQuoteScenario terceroOn: neto = profit − diezmo − tercero',
  Math.abs(qTerc.neto - (qTerc.profitUsd - qTerc.diezmo - qTerc.tercero)) < 0.01);
check('caseQuoteScenario terceroOn: profitSafety = deposit × (market − quoted)',
  Math.abs(qTerc.rateInfo.profitSafety - (160 * (qTerc.rateInfo.marketRate - qTerc.rateInfo.quotedRate))) < 0.01);

console.log('\n[16] caseQuoteScenario con modo average/min/max');
var qAvg = engine.caseQuoteScenario(Spen, FXreal, {
  pair: ['VES', 'PEN'], direction: 'BA', deposit: 160,
  originMode: 'average', destMode: 'average', commissionPct: 0.05, terceroOn: false
});
check('caseQuoteScenario average: ok y originMode = average', qAvg.ok === true && qAvg.scenario.originMode === 'average');
var qBest = engine.caseQuoteScenario(Spen, FXreal, {
  pair: ['VES', 'PEN'], direction: 'BA', deposit: 160,
  originMode: 'best', destMode: 'best', commissionPct: 0.05, terceroOn: false
});
var qMax = engine.caseQuoteScenario(Spen, FXreal, {
  pair: ['VES', 'PEN'], direction: 'BA', deposit: 160,
  originMode: 'max', destMode: 'max', commissionPct: 0.05, terceroOn: false
});
// Sin ads, best ≈ average ≈ min ≈ max (todas media FX)
check('caseQuoteScenario: sin ads, best ≈ average ≈ max',
  Math.abs(qBest.delivered - qAvg.delivered) < 0.01 && Math.abs(qAvg.delivered - qMax.delivered) < 0.01);
check('caseQuoteScenario average sin ads: rateInfo source media(...) y adsCount 0',
  qAvg.rateInfo.originSource === 'media(PEN/compra)' && qAvg.rateInfo.destSource === 'media(VES/venta)' &&
  qAvg.rateInfo.originAdsCount === 0 && qAvg.rateInfo.destAdsCount === 0 && qAvg.rateInfo.adUsed == null);

console.log('\n[16b] caseQuoteScenario: error cases');
check('caseQuoteScenario: par inválido', engine.caseQuoteScenario(Spen, FX, { pair: null }).ok === false);
check('caseQuoteScenario: origen === destino', engine.caseQuoteScenario(Spen, FX, { pair: ['VES', 'VES'], deposit: 100 }).ok === false);
check('caseQuoteScenario: monto 0 rechazado', engine.caseQuoteScenario(Spen, FX, { pair: ['VES', 'PEN'], deposit: 0, useActualAmount: true, direction: 'AB' }).ok === false);
// P2-1: commissionPct=0 debe resultar commission=0
var qZeroComm = engine.caseQuoteScenario(Spen, FXreal, {
  pair: ['VES', 'PEN'], direction: 'BA', deposit: 160,
  originMode: 'best', destMode: 'best', commissionPct: 0, terceroOn: false
});
check('caseQuoteScenario: commissionPct=0 -> commission=0', qZeroComm.ok === true && qZeroComm.commission === 0 && qZeroComm.commissionPct === 0);
check('caseQuoteScenario: commissionPct=0 -> delivered = round2(grossUsd * rateDest)',
  qZeroComm.delivered === Math.round(qZeroComm.grossUsd * qZeroComm.rateInfo.destRate * 100) / 100);

console.log('\n[17] executeCase: registra el MISMO quote del escenario (modos/iliteral/manual en meta)');
var stSc = engine.createInitialState();
var execSc = engine.executeCase(stSc, FX, {
  pair: ['VES', 'PEN'], direction: 'BA', deposit: 100,
  originMode: 'best', destMode: 'best', commissionPct: 0.07,
  date: '2026-02-07', depositAccount: 'peru', deliverAccount: 'efectivo-ves'
});
check('executeCase escenario: ok y movimiento operation', execSc.ok === true && execSc.movement.type === 'operation');
check('executeCase escenario: quote.kind scenario con mismo desglose que caseQuoteScenario',
  execSc.quote.kind === 'scenario' && execSc.quote.commission === 0.07 && execSc.quote.scenario.destMode === 'best');
check('executeCase escenario: in PEN 100, out VES = delivered del quote en cuentas',
  execSc.movement.in.currency === 'PEN' && execSc.movement.in.amount === 100 &&
  execSc.movement.out.currency === 'VES' && execSc.movement.out.amount === execSc.quote.delivered &&
  execSc.movement.in.account === 'peru' && execSc.movement.out.account === 'efectivo-ves');
check('executeCase escenario: rateAt = tasas del escenario (compra origen 3.5 / venta destino 1100 sin 2%)',
  Math.abs(execSc.movement.in.rateAt - FX.unitsPerUsdCompra.PEN) < 1e-9 &&
  Math.abs(execSc.movement.out.rateAt - FX.unitsPerUsdVenta.VES) < 1e-9);
var scMeta = execSc.movement.meta.case;
check('executeCase escenario: meta guarda commissionPct/modos/effectiveRate',
  scMeta.commissionPct === 7 && scMeta.originMode === 'best' && scMeta.destMode === 'best' &&
  scMeta.effectiveRate === execSc.quote.rateInfo.effectiveRate, JSON.stringify(scMeta));
check('executeCase escenario: meta guarda rateInfo (originRate 3.5 / destRate 1100, quoted/market, source media(...))',
  scMeta.rateInfo && Math.abs(scMeta.rateInfo.originRate - 3.5) < 1e-9 &&
  Math.abs(scMeta.rateInfo.destRate - 1100) < 1e-9 &&
  scMeta.rateInfo.quotedRate != null && scMeta.rateInfo.marketRate != null &&
  scMeta.rateInfo.destSource === 'media(VES/venta)');
check('executeCase escenario: desglose fiscal en meta', scMeta.base > 0 && scMeta.diezmo === Math.round(scMeta.base * 0.1 * 100) / 100);
near('saldo Perú tras escenario: +100 PEN', engine.accountBalance(stSc, 'peru').native, 100, 0.01);
check('cadena válida tras executeCase escenario', engine.verifyChain(stSc.movements));
check('executeCase sin originMode/destMode sigue con caseQuote legacy (kind pair)',
  engine.executeCase(engine.createInitialState(), FX, { pair: ['VES', 'PEN'], direction: 'BA', deposit: 100, date: '2026-02-07', depositAccount: 'peru', deliverAccount: 'efectivo-ves' }).quote.kind === 'pair');

// 3e: executeCase con tasa manual → meta guarda manual/factor/source y rateAt = manual
var stScM = engine.createInitialState();
var execM = engine.executeCase(stScM, FX, {
  pair: ['VES', 'PEN'], direction: 'BA', deposit: 100,
  originMode: 'best', destMode: 'best', destManualRate: 1075, commissionPct: 0.07,
  date: '2026-02-08', depositAccount: 'peru', deliverAccount: 'efectivo-ves'
});
check('executeCase manual: out = 28.564,29 (base manual 1075)', Math.abs(execM.movement.out.amount - 28564.29) < 0.005, String(execM.movement.out.amount));
check('executeCase manual: rateAt out = 1075 (la manual manda en la valoración)',
  Math.abs(execM.movement.out.rateAt - 1075) < 1e-9);
check('executeCase manual: meta guarda destManualRate 1075, destSecurityFactor ≈ 2.2727 % y destSource manual',
  execM.movement.meta.case.destManualRate === 1075 &&
  Math.abs(execM.movement.meta.case.rateInfo.destSecurityFactor - ((1100 - 1075) / 1100 * 100)) < 1e-9 &&
  execM.movement.meta.case.rateInfo.destSource === 'manual', JSON.stringify(execM.movement.meta.case.rateInfo));
check('executeCase manual: meta guarda originManualRate null y originSecurityFactor null',
  execM.movement.meta.case.originManualRate == null && execM.movement.meta.case.rateInfo.originSecurityFactor == null);
check('executeCase manual: sistema preservado (destSystemRate 1100) para auditoría',
  Math.abs(execM.movement.meta.case.rateInfo.destSystemRate - 1100) < 1e-9);

// P1 comisión default 7 % / 8 % COP (vals del fixture, sin 2%).
var qComm7 = engine.caseQuoteScenario(engine.defaultSettings(), FX, {
  pair: ['VES', 'PEN'], direction: 'BA', deposit: 100,
  originMode: 'best', destMode: 'best'
});
check('caseQuoteScenario sin commissionPct: comisión default 7 % (PEN)', qComm7.commission === 0.07 && qComm7.commissionPct === 7);
check('P1 sin 2%: best PEN→VES venta 1100 → 29.228,57', Math.abs(qComm7.rateInfo.destRate - 1100) < 1e-9 && qComm7.delivered === 29228.57, String(qComm7.delivered));
var qComm8 = engine.caseQuoteScenario(engine.defaultSettings(), FX, {
  pair: ['VES', 'COP'], direction: 'BA', deposit: 100,
  originMode: 'best', destMode: 'best'
});
check('caseQuoteScenario sin commissionPct: comisión default 8 % (COP)', qComm8.commission === 0.08 && qComm8.commissionPct === 8);
var execDef = engine.executeCase(engine.createInitialState(), FX, {
  pair: ['VES', 'PEN'], direction: 'BA', deposit: 100,
  originMode: 'best', destMode: 'best',
  date: '2026-02-07', depositAccount: 'peru', deliverAccount: 'efectivo-ves'
});
check('executeCase escenario sin commissionPct: comisión default 7 % en el movimiento',
  execDef.ok && execDef.movement.meta.case.commissionPct === 7);

console.log('\n===== ENGINE: ' + (checks - failures) + '/' + checks + ' pruebas OK, ' + failures + ' fallidas =====');
process.exit(failures ? 1 : 0);
