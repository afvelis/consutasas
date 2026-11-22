/* Pruebas del motor ConsuTasas v2 — Node puro, sin DOM ni red: `node test/engine-tests.js`.
 * Cubre la especificación: fórmulas (7% / 8% COP, USD/USD 320→305, EUR referencial),
 * casos PEN→VES / VES→COP con fixture explícito (fixture:true), ledger Zelle
 * 320→305 (plusvalía 15, diezmo 1.5, tercero 3.75, neto 9.75), transferencia,
 * retiro, aporte, exchange, cadena de hashes con detección de alteración,
 * balance, import/export y cierre de periodo. */

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

console.log('\n[3b] Números EXACTOS de la especificación contra rates.json real (fixture del sitio)');
const localRatesEarly = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'rates.json'), 'utf8'));
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

console.log('\n[3c] Modo INVERSO: target fijado, depósito deducido (rates.json real)');
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

console.log('\n[12] Smoke: webapp/data/rates.json local (fixture del sitio, sin inventar)');
const localRates = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'rates.json'), 'utf8'));
check('rates.json local parsea con schema v1', localRates.schema === 'consutasas/rates.v1');
const localFx = engine.buildFx(localRates);
const missingFiats = ['VES', 'PEN', 'COP', 'CLP', 'MXN'].filter(f => localFx.unitsPerUsd[f] == null);
check('todas las fiat del sitio tienen tasa', missingFiats.length === 0, 'faltan: ' + missingFiats.join(','));
check('ambos lados presentes en el snapshot real (compra/venta)',
  localFx.unitsPerUsdCompra.PEN === localRates.pairs.PEN.compra && localFx.unitsPerUsdVenta.PEN === localRates.pairs.PEN.venta);
check('snapshot local aún sin eurRef → null + aviso (no inventa)',
  localFx.unitsPerUsd.EUR === null && engine.fxWarnings(localFx).some(w => /EUR referencial/.test(w)));

console.log('\n[13] Pares del usuario y cotización de pares personalizados');
const s2 = engine.defaultSettings();
s2.customPairs = [['VES', 'EUR']];
check('par personalizado agregado al settings', s2.customPairs.length === 1);
const qCustom = engine.caseQuote(s2, FX, { pair: ['VES', 'EUR'], direction: 'BA', deposit: 9 }); // 9 EUR → 10 USD → 11000 VES×0.93
check('par personalizado VES/EUR cotiza (referencial)', qCustom.ok && qCustom.referencial === true && Math.abs(qCustom.delivered - 11000 * 0.93) < 1e-6);

console.log('\n===== ENGINE: ' + (checks - failures) + '/' + checks + ' pruebas OK, ' + failures + ' fallidas =====');
process.exit(failures ? 1 : 0);
