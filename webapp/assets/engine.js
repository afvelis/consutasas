/* ConsuTasas v2 — motor contable (ledger) y de casos, sin dependencias.
 *
 * IIFE/UMD: expone `globalThis.CTEngine` y `module.exports`. No usa DOM:
 * testeable en Node (`node webapp/test/engine-tests.js`).
 *
 * Responsabilidades:
 *  - settings / cuentas / movimientos / periodos con persistencia (`ct_*` localStorage
 *    o adaptador inyectado) y migración de `consumo_operations` (app v1) sin pérdida.
 *  - FX desde rates.json real: `unitsPerUsd` (venta media por fiat), libro de anuncios
 *    (`walkBook`), EUR referencial (`eurRef` de Frankfurter). Nunca inventa tasas:
 *    si falta un dato es `null` + aviso.
 *  - Casos: pares A↔B en ambas direcciones (forward/reverse), USD/USD (Zelle) con
 *    margen 7% por defecto u override del monto entregado. Comisión 7% por defecto,
 *    8% si el cliente deposita COP. Diezmo 10%, tercero 25%, base = plusvalía.
 *  - Libro mayor: movimientos append-only con cadena SHA-256 (prevHash="GENESIS",
 *    JSON canónico sin campos hash), periodos mensuales con cierre/bloqueo,
 *    balance nativo por moneda, valoración USD, pasivos, capital, fxDiff
 *    ("revalorización FX"), export/import JSON/CSV y manifiesto.
 */
(function (root, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.CTEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '2.0.0';

  var CURRENCIES = ['USD', 'VES', 'PEN', 'COP', 'CLP', 'MXN', 'EUR'];
  var FIATS = ['VES', 'PEN', 'COP', 'CLP', 'MXN']; // pares con P2P (rates.json)

  // Pares predeterminados (no dirigidos; cada caso se ejecuta en ambas direcciones).
  var DEFAULT_PAIRS = [
    ['VES', 'PEN'], ['VES', 'COP'], ['VES', 'CLP'], ['VES', 'MXN'],
    ['PEN', 'COP'], ['PEN', 'CLP'], ['COP', 'CLP']
  ];

  var MOVEMENT_TYPES = ['operation', 'transfer', 'withdrawal', 'contribution', 'exchange', 'legacy'];

  // 10 cuentas iniciales; exactamente una `primary` por moneda.
  var INITIAL_ACCOUNTS = [
    { id: 'zelle',         name: 'Zelle',       currency: 'USD', country: 'US', kind: 'bank',     primary: true },
    { id: 'panama',        name: 'Panamá',      currency: 'USD', country: 'PA', kind: 'bank' },
    { id: 'binance',       name: 'Binance',     currency: 'USD', country: null, kind: 'exchange' },
    { id: 'efectivo-usd',  name: 'Efectivo USD', currency: 'USD', country: null, kind: 'cash' },
    { id: 'efectivo-ves',  name: 'Efectivo VES', currency: 'VES', country: 'VE', kind: 'cash', primary: true },
    { id: 'peru',          name: 'Perú',        currency: 'PEN', country: 'PE', kind: 'bank',     primary: true },
    { id: 'colombia',      name: 'Colombia',    currency: 'COP', country: 'CO', kind: 'bank',     primary: true },
    { id: 'chile',         name: 'Chile',       currency: 'CLP', country: 'CL', kind: 'bank',     primary: true },
    { id: 'mexico',        name: 'México',      currency: 'MXN', country: 'MX', kind: 'bank',     primary: true },
    { id: 'eur',           name: 'EUR',         currency: 'EUR', country: 'EU', kind: 'bank',     primary: true }
  ];

  var STORAGE_KEYS = {
    settings: 'ct_settings',
    accounts: 'ct_accounts',
    movements: 'ct_movements',
    periods: 'ct_periods',
    legacyOperations: 'consumo_operations' // app v1 (lectura para migrar)
  };

  var GENESIS = 'GENESIS';

  // ==================== SHA-256 (pure JS, síncrono) ====================

  var SHA_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    // Respaldo sin TextEncoder (navegadores viejos).
    var out = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.codePointAt(i);
      if (c > 0xffff) i++;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  var _rotr = function (x, n) { return (x >>> n) | (x << (32 - n)); };

  function sha256Hex(text) {
    var bytes = utf8Bytes(String(text));
    var l = bytes.length;
    var total = Math.ceil((l + 9) / 64) * 64;
    var buf = new Uint8Array(total);
    buf.set(bytes);
    buf[l] = 0x80;
    var dv = new DataView(buf.buffer);
    var bitLen = l * 8;
    dv.setUint32(total - 8, Math.floor(bitLen / 4294967296));
    dv.setUint32(total - 4, bitLen >>> 0);

    var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    var h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    var w = new Int32Array(64), i, t1, t2;

    for (var off = 0; off < total; off += 64) {
      for (i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4);
      for (i = 16; i < 64; i++) {
        var s0 = _rotr(w[i - 15], 7) ^ _rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = _rotr(w[i - 2], 17) ^ _rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h0, b = h1, c2 = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
      for (i = 0; i < 64; i++) {
        var S1 = _rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        t1 = (hh + S1 + ch + SHA_K[i] + w[i]) | 0;
        var S0 = _rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22);
        var maj = (a & b) ^ (a & c2) ^ (b & c2);
        t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0;
        d = c2; c2 = b; b = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c2) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + hh) | 0;
    }
    var out = '';
    [h0, h1, h2, h3, h4, h5, h6, h7].forEach(function (x) {
      out += ('00000000' + (x >>> 0).toString(16)).slice(-8);
    });
    return out;
  }

  // ==================== JSON canónico ====================

  function canonicalJson(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) === false && value instanceof Date) {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    var keys = Object.keys(value).filter(function (k) { return value[k] !== undefined; }).sort();
    return '{' + keys.map(function (k) {
      return JSON.stringify(k) + ':' + canonicalJson(value[k]);
    }).join(',') + '}';
  }

  // ==================== Settings / estado ====================

  function defaultSettings() {
    return {
      version: VERSION,
      commissionDefault: 0.07,  // 7% por defecto
      commissionCop: 0.08,      // 8% si el cliente deposita COP
      zelleMargin: 0.07,        // margen USD/USD (Zelle) por defecto
      diezmo: 0.10,
      tercero: 0.25,
      pairs: DEFAULT_PAIRS.map(function (p) { return p.slice(); }), // pares dirigibles A↔B
      customPairs: []            // pares que agrega el usuario
    };
  }

  function createInitialState() {
    return {
      settings: defaultSettings(),
      accounts: JSON.parse(JSON.stringify(INITIAL_ACCOUNTS)),
      movements: [],
      periods: {}
    };
  }

  function accountById(stateOrAccounts, id) {
    var accounts = Array.isArray(stateOrAccounts) ? stateOrAccounts : stateOrAccounts.accounts;
    for (var i = 0; i < accounts.length; i++) if (accounts[i].id === id) return accounts[i];
    return null;
  }

  // ==================== Persistencia (ct_*) ====================

  function defaultStorage() {
    // localStorage en navegador; sin persistencia fuera de él.
    var ls = (typeof localStorage !== 'undefined') ? localStorage : null;
    if (!ls) return { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
    return {
      getItem: function (k) { return ls.getItem(k); },
      setItem: function (k, v) { ls.setItem(k, v); },
      removeItem: function (k) { ls.removeItem(k); }
    };
  }

  function _readJson(storage, key) {
    var raw = storage.getItem(key);
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function load(storage) {
    storage = storage || defaultStorage();
    var settings = _readJson(storage, STORAGE_KEYS.settings);
    var accounts = _readJson(storage, STORAGE_KEYS.accounts);
    var movements = _readJson(storage, STORAGE_KEYS.movements);
    var periods = _readJson(storage, STORAGE_KEYS.periods);
    var state = createInitialState();
    state.settings = mergeSettings(settings); // merge con defaults: claves ausentes no quedan undefined
    if (Array.isArray(accounts)) state.accounts = accounts;
    if (Array.isArray(movements)) state.movements = movements;
    if (periods && typeof periods === 'object') state.periods = periods;
    return state;
  }

  /* Fusiona el settings guardado con los defaults: si falta una clave (build
   * anterior o edición manual), comisiones/márgenes no quedan undefined/NaN. */
  function mergeSettings(saved) {
    var base = defaultSettings();
    if (!saved || typeof saved !== 'object') return base;
    var merged = Object.assign({}, base);
    Object.keys(base).forEach(function (k) {
      var v = saved[k];
      if (k === 'pairs' || k === 'customPairs') {
        if (Array.isArray(v)) {
          var clean = v.filter(function (p) { return Array.isArray(p) && p.length === 2 && p[0] !== p[1]; });
          if (k === 'pairs' && clean.length) merged.pairs = clean;
          if (k === 'customPairs') merged.customPairs = clean;
        }
        return;
      }
      if (typeof v === 'number' && isFinite(v) && v >= 0) merged[k] = v;
    });
    return merged;
  }

  function save(state, storage) {
    storage = storage || defaultStorage();
    storage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings));
    storage.setItem(STORAGE_KEYS.accounts, JSON.stringify(state.accounts));
    storage.setItem(STORAGE_KEYS.movements, JSON.stringify(state.movements));
    storage.setItem(STORAGE_KEYS.periods, JSON.stringify(state.periods));
    return state;
  }

  function wipe(storage) {
    storage = storage || defaultStorage();
    Object.keys(STORAGE_KEYS).forEach(function (k) { storage.removeItem(STORAGE_KEYS[k]); });
  }

  // ==================== Migración de `consumo_operations` (v1) ====================

  /* Cada operación v1: {fecha, origen, destino, sale, saleRate, entry, entryRate, obs, tercero}.
   * Dirección correcta: lo que SALE es `sale` en `origen` (out) y lo que ENTRA es
   * `entry` en `destino` (in). Se migra 1:1 como
   * un movimiento `legacy` con in/out sin cuentas (null = externo) y el objeto
   * original íntegro en `meta.original` — sin pérdida de datos. */
  function migrateLegacyOperations(ops, existingMovements) {
    var list = Array.isArray(ops) ? ops : [];
    var existing = existingMovements || [];
    var migratedIds = {};
    existing.forEach(function (m) {
      if (m.type === 'legacy' && m.meta && m.meta.legacyKey != null) migratedIds[m.meta.legacyKey] = true;
    });
    var out = [];
    list.forEach(function (op, idx) {
      if (!op || typeof op !== 'object') return;
      var key = (op.fecha || '') + '|' + (op.origen || '') + '|' + (op.sale == null ? '' : String(op.sale)) + '|' + idx;
      if (migratedIds[key]) return; // idempotente
      var date = /^\d{4}-\d{2}-\d{2}$/.test(op.fecha || '') ? op.fecha : null;
      out.push({
        id: null, seq: null, date: date, type: 'legacy',
        out: num(op.sale) > 0 ? { account: null, currency: CURRENCIES.indexOf(op.origen) >= 0 ? op.origen : null, amount: num(op.sale) } : null,
        in: num(op.entry) > 0 ? { account: null, currency: CURRENCIES.indexOf(op.destino) >= 0 ? op.destino : null, amount: num(op.entry) } : null,
        note: op.obs || '',
        meta: { legacyKey: key, original: JSON.parse(JSON.stringify(op)) }
      });
    });
    return out;
  }

  function loadAndMigrate(storage) {
    var state = load(storage);
    storage = storage || defaultStorage();
    var legacy = _readJson(storage, STORAGE_KEYS.legacyOperations);
    if (Array.isArray(legacy) && legacy.length) {
      migrateLegacyOperations(legacy, state.movements).forEach(function (mv) {
        appendMovement(state, mv);
      });
      save(state, storage);
    }
    return state;
  }

  // ==================== FX desde rates.json (nunca inventar) ====================

  /* rates: snapshot real (`pairs[F].compra/venta`, opcionalmente `eurRef`).
   * Convención de la especificación: el ORIGEN se cotiza con la media COMPRA
   * (cuántos fiat cuestan comprar 1 USD en esa moneda: grossUsd = monto/compra)
   * y el DESTINO con la media VENTA (lo que se paga por un USDT al entregar).
   * Se exponen ambos lados: `unitsPerUsdCompra[F]` y `unitsPerUsdVenta[F]`;
   * `unitsPerUsd` queda como alias de venta por compatibilidad. Lo ausente
   * = null + aviso; nunca se inventan tasas. */
  function buildFx(rates) {
    var fx = { unitsPerUsd: {}, unitsPerUsdCompra: {}, unitsPerUsdVenta: {}, best: {}, eurRef: null, asOf: null, warnings: [] };
    if (!rates || typeof rates !== 'object') {
      fx.warnings.push('Snapshot de tasas no disponible: sin tasas de referencia.');
      return fx;
    }
    fx.asOf = rates.generatedAt || null;
    var pairs = (rates && rates.pairs) || {};
    FIATS.forEach(function (code) {
      var p = pairs[code] || {};
      fx.unitsPerUsdCompra[code] = finitePositive(p.compra);
      fx.unitsPerUsdVenta[code] = finitePositive(p.venta);
      fx.unitsPerUsd[code] = fx.unitsPerUsdVenta[code];
      fx.best[code] = { compra: finitePositive(p.compra), venta: finitePositive(p.venta) };
      if (fx.unitsPerUsdCompra[code] == null) {
        fx.warnings.push('Sin tasa de compra para ' + code + ' en el snapshot: no se inventan datos.');
      }
      if (fx.unitsPerUsdVenta[code] == null) {
        fx.warnings.push('Sin tasa de venta para ' + code + ' en el snapshot: no se inventan datos.');
      }
    });
    fx.unitsPerUsd.USD = fx.unitsPerUsdCompra.USD = fx.unitsPerUsdVenta.USD = 1;
    if (rates.eurRef && typeof rates.eurRef === 'object') {
      fx.eurRef = {
        usdToEur: finitePositive(rates.eurRef.usdToEur),
        eurToUsd: finitePositive(rates.eurRef.eurToUsd),
        source: rates.eurRef.source || null,
        date: rates.eurRef.date || null,
        fixture: rates.eurRef.fixture === true
      };
      fx.unitsPerUsd.EUR = fx.unitsPerUsdCompra.EUR = fx.unitsPerUsdVenta.EUR =
        fx.eurRef.usdToEur != null ? fx.eurRef.usdToEur : null;
      if (fx.unitsPerUsd.EUR == null) {
        fx.warnings.push('eurRef presente pero sin tasa EUR/USD utilizable: EUR referencial no disponible.');
      }
    } else {
      fx.unitsPerUsd.EUR = fx.unitsPerUsdCompra.EUR = fx.unitsPerUsdVenta.EUR = null;
      fx.warnings.push('Tasa EUR referencial (Frankfurter/ECB) no disponible en el snapshot: casos EUR deshabilitados.');
    }
    return fx;
  }

  function finitePositive(v) {
    return (typeof v === 'number' && isFinite(v) && v > 0) ? v : null;
  }

  function num(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }

  function fxWarnings(fx) { return (fx && fx.warnings) ? fx.warnings.slice() : []; }

  /* Libro de anuncios: los ads del bot (`pairs[F].ads.compra` asc / `ads.venta` desc,
   * {rate, min, max, available}). Consume el objetivo en bloques: primero 10 USD,
   * si ningún anuncio puede absorber el bloque escala una vez a 20 USD. Nunca
   * rellena más allá del disponible. Tasa efectiva = media ponderada por monto. */
  function walkBook(ads, targetUsd) {
    var res = { ok: false, filled: 0, rate: null, steps: [], warnings: [] };
    var target = num(targetUsd);
    if (!Array.isArray(ads) || !ads.length) { res.warnings.push('Libro de anuncios vacío o no disponible.'); return res; }
    if (target == null || target <= 0) { res.warnings.push('Monto objetivo inválido.'); return res; }
    var remaining = target, chunk = 10, escalated = false;
    var totalCost = 0;
    var guardMax = Math.ceil(target / 5) + 64; // dinámico: ya no techo objetivo grandes (antes: 200 pasos fijos)
    var guard = 0;
    var capacity = ads.map(function (ad) { return num(ad.available); });
    while (remaining > 1e-9) {
      if (guard++ >= guardMax) {
        res.warnings.push('Límite interno de pasos alcanzado (guard agotado, no el libro): faltan ' + remaining.toFixed(2) + ' USD.');
        break;
      }
      var placed = null;
      for (var i = 0; i < ads.length && !placed; i++) {
        var ad = ads[i];
        var rate = finitePositive(ad.rate), min = num(ad.min), max = num(ad.max);
        var avail = capacity[i];
        if (rate == null || avail == null || avail <= 1e-9) continue;
        var want = Math.min(remaining, chunk);
        var take = Math.min(want, avail, max != null ? max : want);
        if (take <= 1e-9) continue;
        // Con el respaldo (10→20 USD) se ignora el mínimo del anuncio para no bloquear montos pequeños.
        if (!escalated && min != null && take < min) continue;
        placed = { idx: i, take: take, rate: rate };
      }
      if (!placed) {
        if (!escalated && chunk < 20) { chunk = 20; escalated = true; continue; } // respaldo 10→20 USD
        res.warnings.push('Libro de anuncios agotado: no hay anuncios suficientes para cubrir el objetivo (faltan ' + remaining.toFixed(2) + ' USD).');
        break;
      }
      capacity[placed.idx] -= placed.take;
      totalCost += placed.take * placed.rate;
      remaining -= placed.take;
      res.filled += placed.take;
      res.steps.push({ rate: placed.rate, amount: placed.take });
    }
    if (res.filled > 0) res.rate = totalCost / res.filled;
    res.ok = res.filled > 1e-9;
    if (res.ok && remaining > 1e-9) res.warnings.push('Libro consumido sin cubrir el objetivo completo.');
    return res;
  }

  // ==================== Motor de escenarios de tasa (panel) ====================

  // ==================== Motor de escenarios de tasa (panel) ====================

  /* BEST se evalúa a un monto de referencia fijo de 40 USD equivalentes (3e,
   * decisión supervisada): min/price ≤ 40 ≤ max/price y available ≥ 40. La tasa
   * BEST queda estable e independiente del monto del caso, igual para la matriz. */
  var BEST_REF_USD = 40;

  /* Anuncios ejecutables para un monto USD dado: min ≤ amt·price ≤ max y
   * available ≥ amt. Mismo filtro para best(40)/average/min. */
  function adsExecutable(origAds, amtUsd) {
    var out = [];
    for (var i = 0; i < origAds.length; i++) {
      var a = origAds[i];
      var price = num(a.price);
      var avail = finitePositive(a.available);
      var min = num(a.min);
      var max = num(a.max);
      if (price == null || avail == null) continue;
      var cost = amtUsd * price;
      if (min != null && cost < min) continue;
      if (max != null && cost > max) continue;
      if (avail < amtUsd) continue;
      out.push(a);
    }
    return out;
  }

  /* Busca la tasa de un anuncio para fiat/side dado un amountUsd.
   * Filtro ejecutable: min ≤ amountUsd·price ≤ max y available ≥ amountUsd.
   * mode='best' → compra = min(price), venta = max(price) entre ejecutables
   *   evaluados a BEST_REF_USD = 40 USD equivalentes (min/price ≤ 40 ≤ max/price);
   *   monto del caso no afecta (decisión 3e).
   * mode='average' → media aritmética de los price de los anuncios ejecutables
   *   (mismo filtro con el monto real del caso); sin ejecutables → media FX de
   *   unitsPerUsdCompra/Venta del fiat (fallback con source 'media(...)').
   * mode='min' → menor price entre los ejecutables (monto real del caso).
   * mode='max' → MÁXIMO por plataforma (3e): tercer anuncio de la lista por
   *   defecto de cada plataforma (campo `platform`, Binance/Bybit); el MAX del
   *   lado = mayor de los terceros. Sin cálculos extra: sin filtro min/max/
   *   available; si una plataforma tiene <3 anuncios se usa su último y avisa
   *   (warnings en el resultado). Libro vacío → media FX.
   * Fallback: ads vacías → media FX; filtrado vacío → null (el panel cae a la media).
   * Devuelve {rate, ad, source, mode, adsCount?, warnings?} o null.
   * `rate` es en unitsPerUsd (compra) o (venta).
   * `ads` = array de {price, min, max, available, platform} o null (usa media FX). */
  function adRateAt(fx, fiat, side, amountUsd, mode, ads) {
    if (!fiat || !side || !amountUsd || !mode) return null;
    var origAds = Array.isArray(ads) ? ads : [];
    var amt = finitePositive(mode === 'best' ? BEST_REF_USD : num(amountUsd));
    if (amt == null) return null;
    var adsArr = adsExecutable(origAds, amt);

    // Fallback a la media FX del snapshot (solo con libro vacío; con libro sin
    // ejecutables el resultado es null y caseQuoteScenario cae a la media con aviso).
    function mediaFx() {
      var buyR = fx && fx.unitsPerUsdCompra && fx.unitsPerUsdCompra[fiat];
      var sellR = fx && fx.unitsPerUsdVenta && fx.unitsPerUsdVenta[fiat];
      var r = finitePositive(side === 'compra' ? buyR : sellR);
      if (r == null) return null;
      return { rate: r, ad: null, source: 'media(' + fiat + '/' + side + ')', mode: mode, adsCount: 0 };
    }

    if (mode === 'best') {
      if (adsArr.length) {
        var bestAd = null, bestRate = null;
        for (var i = 0; i < adsArr.length; i++) {
          var p = finitePositive(adsArr[i] && adsArr[i].price);
          if (p == null) continue;
          var better = bestAd == null || (side === 'compra' ? p < bestRate : p > bestRate);
          if (better) { bestAd = adsArr[i]; bestRate = p; }
        }
        if (bestAd != null) return { rate: bestRate, ad: bestAd, source: 'ad_best_' + side, mode: mode };
      }
      if (origAds.length === 0) return mediaFx();
      return null;
    }

    if (mode === 'min') {
      // Mínimo: el menor price entre los ejecutables (monto real del caso).
      if (adsArr.length) {
        var minAd = null, minRate = null;
        for (var j = 0; j < adsArr.length; j++) {
          var pMin = finitePositive(adsArr[j] && adsArr[j].price);
          if (pMin == null) continue;
          if (minAd == null || pMin < minRate) { minAd = adsArr[j]; minRate = pMin; }
        }
        if (minAd != null) return { rate: minRate, ad: minAd, source: 'ad_min_' + side, mode: mode };
      }
      if (origAds.length === 0) return mediaFx();
      return null;
    }

    if (mode === 'max') {
      // Máximo (3e): tercer anuncio de la lista por defecto de cada plataforma
      // (campo `platform`); el MAX del lado = mayor de los dos terceros. Sin
      // filtro min/max/available ni cálculos extra. Plataforma con <3 anuncios:
      // se usa su último y se avisa en `warnings`.
      if (origAds.length === 0) return mediaFx();
      var order = [], groups = {}, warnings = [];
      for (var k = 0; k < origAds.length; k++) {
        var aMax = origAds[k];
        var plat = aMax && typeof aMax.platform === 'string' && aMax.platform ? aMax.platform : '(sin plataforma)';
        if (!groups[plat]) { groups[plat] = []; order.push(plat); }
        var pPlat = finitePositive(aMax && aMax.price);
        if (pPlat != null) groups[plat].push({ price: pPlat, ad: aMax });
      }
      var maxAd = null, maxRate = null;
      for (var gi = 0; gi < order.length; gi++) {
        var list = groups[order[gi]];
        if (!list.length) {
          warnings.push('Máximo ' + fiat + '/' + side + ': plataforma ' + order[gi] + ' sin anuncios útiles; se excluye del Máximo.');
          continue;
        }
        var pick = list.length >= 3 ? list[2] : list[list.length - 1];
        if (list.length < 3) {
          warnings.push('Máximo ' + fiat + '/' + side + ': plataforma ' + order[gi] + ' con ' + list.length + ' anuncios (<3): se usa su último anuncio.');
        }
        if (maxRate == null || pick.price > maxRate) { maxRate = pick.price; maxAd = pick.ad; }
      }
      if (maxAd == null) return null;
      var resMax = { rate: maxRate, ad: maxAd, source: 'ad_max_' + side, mode: mode };
      if (warnings.length) resMax.warnings = warnings;
      return resMax;
    }

    // average: media aritmética de los anuncios ejecutables (bug 3d: antes usaba
    // la media FX y el Promedio podía superar al Máximo). Mismo filtro min/max/
    // available que best/min con el monto real del caso; el promedio no es un
    // anuncio único → ad=null y adsCount = nº de anuncios promediados.
    if (mode === 'average') {
      if (adsArr.length) {
        var sumA = 0, cntA = 0;
        for (var m = 0; m < adsArr.length; m++) {
          var pAvg = finitePositive(adsArr[m] && adsArr[m].price);
          if (pAvg == null) continue;
          sumA += pAvg;
          cntA++;
        }
        if (cntA > 0) {
          return { rate: sumA / cntA, ad: null, source: 'ad_average_' + side, mode: 'average', adsCount: cntA };
        }
      }
      // Fallback: media FX (sin anuncios o sin ejecutables → aviso “no cubre” en la UI).
      return mediaFx();
    }

    return null;
  }

  /* Calcula los cuatro escenarios (max/best/average/min) para origen y destino.
   * Devuelve { best: { originRate, destRate, originAd, destAd }, average: {...},
   * min: {...}, max: {...} }.
   * `average` además propaga originSource/destSource ('ad_average_<side>' o
   * 'media(<fiat>/<side>)') y originAdsCount/destAdsCount; su originAd/destAd
   * es null (el promedio no es un anuncio único).
   * `max` propaga los avisos de plataforma con <3 anuncios en `warnings`.
   * `pair` = ['A','B'], `direction` = 'AB' | 'BA'.
   * `rateMode` indica qué side usar (compra/venta).
   * El 2% VES ya no existe (3e): sin safety por modo en ningún lado.
   */
  function rateScenarios(settings, fx, pair, direction, amount, rateMode, adsPair) {
    if (!pair || !direction || !rateMode) return { best: {}, average: {}, min: {}, max: {} };
    var dir = direction === 'BA' ? 'BA' : 'AB';
    var curA = dir === 'AB' ? pair[0] : pair[1];
    var curB = dir === 'AB' ? pair[1] : pair[0];
    // El origen siempre usa compra (se compra USD con la moneda origen),
    // el destino siempre usa venta (se vende USD por la moneda destino).
    // `rateMode` se pasa solo para coherencia de API pero siempre es 'compra'.
    var originSide = 'compra';
    var destSide = 'venta';
    var scenarios = { best: {}, average: {}, min: {}, max: {} };

    // Obtener ads desde fx.pairs si están disponibles
    var adsA, adsB;
    if (fx && fx.pairs && fx.pairs[curA] && fx.pairs[curA].ads) {
      adsA = fx.pairs[curA].ads;
      adsB = (fx.pairs[curB] && fx.pairs[curB].ads) || [];
    } else if (fx && fx.pairs) {
      adsA = (fx.pairs[curA] && fx.pairs[curA].ads) || [];
      adsB = (fx.pairs[curB] && fx.pairs[curB].ads) || [];
    } else if (adsPair && adsPair[curA] && adsPair[curB]) {
      // ads explícitos: { currency: { side: [ads] } } o { currency: [flatAds] } side=originSide
      var aSideObj = adsPair[curA];
      if (Array.isArray(aSideObj)) {
        adsA = aSideObj;
      } else if (aSideObj && aSideObj[originSide]) {
        adsA = aSideObj[originSide];
      } else {
        adsA = [];
      }
      var bSideObj = adsPair[curB];
      if (Array.isArray(bSideObj)) {
        adsB = bSideObj;
      } else if (bSideObj && bSideObj[destSide]) {
        adsB = bSideObj[destSide];
      } else {
        adsB = [];
      }
    } else {
      // fx no tiene pairs (buildFx estándar) → fallback media
      adsA = adsB = [];
    }

    // best (evaluado a 40 USD equivalentes: ver BEST_REF_USD en adRateAt)
    var aBestO = adRateAt(fx, curA, originSide, amount, 'best', adsA);
    var aBestD = adRateAt(fx, curB, destSide, amount, 'best', adsB);
    if (aBestO && aBestD) {
      scenarios.best.originRate = aBestO.rate;
      scenarios.best.destRate = aBestD.rate;
      scenarios.best.originAd = aBestO;
      scenarios.best.destAd = aBestD;
    }
    // average (media de anuncios ejecutables con el monto real)
    var aAvgO = adRateAt(fx, curA, originSide, amount, 'average', adsA);
    var aAvgD = adRateAt(fx, curB, destSide, amount, 'average', adsB);
    if (aAvgO && aAvgD) {
      scenarios.average.originRate = aAvgO.rate;
      scenarios.average.destRate = aAvgD.rate;
      scenarios.average.originAd = aAvgO.ad; // null: el promedio no es un anuncio único
      scenarios.average.destAd = aAvgD.ad;
      scenarios.average.originSource = aAvgO.source;
      scenarios.average.destSource = aAvgD.source;
      scenarios.average.originAdsCount = aAvgO.adsCount;
      scenarios.average.destAdsCount = aAvgD.adsCount;
    }
    // min (menor price ejecutable con el monto real)
    var aMinO = adRateAt(fx, curA, originSide, amount, 'min', adsA);
    var aMinD = adRateAt(fx, curB, destSide, amount, 'min', adsB);
    if (aMinO && aMinD) {
      scenarios.min.originRate = aMinO.rate;
      scenarios.min.destRate = aMinD.rate;
      scenarios.min.originAd = aMinO;
      scenarios.min.destAd = aMinD;
    }
    // max (Máximo por plataforma: tercer anuncio, mayor de los dos terceros)
    var aMaxO = adRateAt(fx, curA, originSide, amount, 'max', adsA);
    var aMaxD = adRateAt(fx, curB, destSide, amount, 'max', adsB);
    var maxWarn = [].concat((aMaxO && aMaxO.warnings) || [], (aMaxD && aMaxD.warnings) || []);
    // Avisos por lado: rateInfo los expone solo si el modo activo de ese lado es
    // max (caseQuoteScenario); el array unido `warnings` se mantiene para API/tests.
    scenarios.max.originWarn = (aMaxO && aMaxO.warnings) ? aMaxO.warnings.slice() : [];
    scenarios.max.destWarn = (aMaxD && aMaxD.warnings) ? aMaxD.warnings.slice() : [];
    if (aMaxO && aMaxD) {
      scenarios.max.originRate = aMaxO.rate;
      scenarios.max.destRate = aMaxD.rate;
      scenarios.max.originAd = aMaxO;
      scenarios.max.destAd = aMaxD;
      if (maxWarn.length) scenarios.max.warnings = maxWarn;
    } else if (maxWarn.length) {
      scenarios.max.warnings = maxWarn;
    }
    return scenarios;
  }

  /* Fuente de tasa del escenario usado (rateInfo.originSource/destSource):
   * `average` la expone directa (originSource/destSource → 'ad_average_<side>'
   * o 'media(<fiat>/<side>)' del fallback); los demás modos la exponen en el
   * resultado de adRateAt guardado en originAd/destAd. */
  function scenarioSource(scn, side) {
    if (!scn) return null;
    var explicit = scn[side + 'Source'];
    if (explicit != null) return explicit;
    var usedAd = scn[side === 'origin' ? 'originAd' : 'destAd'];
    return (usedAd && usedAd.source) || null;
  }

  function scenarioAdsCount(scn, side) {
    return scn && scn[side + 'AdsCount'] != null ? scn[side + 'AdsCount'] : null;
  }

  /* Cotización basada en escenarios del panel (motor de escenarios).
   * Nuevos parámetros en `req`:
   *   originMode   – 'max'|'best'|'average'|'min' (default: 'best')
   *   destMode     – igual (default: 'best')
   *   originManualRate – tasa manual origen; si llega (>0), esa es la base del lado.
   *   destManualRate   – tasa manual destino; si llega (>0), esa es la base del lado.
   *   commissionPct – reemplaza settings.commissionDefault/COP (default: undefined).
   *   terceroOn    – true/false (default: settings.tercero > 0).
   *
   * Fórmulas (3e): SIN 2% VES — el safety por modo desapareció; la seguridad
   * ahora es la tasa manual. Tasa base = escenario del sistema por modo;
   * si hay tasa manual, esa manda y se calcula el factor de seguridad:
   *   securityFactor = (sistema − manual) / sistema × 100  (por lado)
   * Manual < sistema → factor positivo (descuento); manual > sistema → negativo
   * (recargo visible). rateInfo guarda manual/factor/source por lado, y
   * executeCase los lleva al movimiento (auditoría).
   *
   *   PEN→VES:  USDT = PEN / compra_PEN;  net = USDT·(1-5%);
   *             delivered = net·venta_VES (manual si hay, si no sistema).
   */
  function caseQuoteScenario(settings, fx, req) {
    var pair = req && req.pair;
    if (!Array.isArray(pair) || pair.length !== 2) return { ok: false, error: 'Par inválido.' };
    if (pair[0] === pair[1]) return { ok: false, error: 'Origen y destino iguales.' };

    var dir = req.direction === 'BA' ? 'BA' : 'AB';
    var origin = dir === 'AB' ? pair[0] : pair[1];
    var dest = dir === 'AB' ? pair[1] : pair[0];

    // Parámetros con defaults
    var originMode = req.originMode || 'best';
    var destMode = req.destMode || 'best';
    var originManual = finitePositive(req.originManualRate);
    var destManual = finitePositive(req.destManualRate);
    var refAmount = req.referenceAmountUsd != null ? num(req.referenceAmountUsd) : 10;
    var useActual = !!req.useActualAmount;
    // Si deposit > 0, usar el monto real; si no, usar referenceAmountUsd (default 10)
    var depositVal = (num(req.deposit) || 0) > 0 ? num(req.deposit) : refAmount;
    if (useActual) depositVal = (req.deposit != null && num(req.deposit) != null) ? num(req.deposit) : depositVal;
    if (depositVal <= 0) return { ok: false, error: 'Monto inválido.' };
    var commissionPct = req.commissionPct != null ? num(req.commissionPct) : null;
    var terceroOn = req.terceroOn != null ? req.terceroOn : (settings.tercero > 0);

    // Bootstrap con media FX (sin filtro de ads) para derivar rates y amountUsd.
    // La segunda pasada en [reversed/forward] refinará con ads reales.
    var rateOriginMedia = fx && fx.unitsPerUsdCompra && fx.unitsPerUsdCompra[origin] != null
      ? fx.unitsPerUsdCompra[origin] : null;
    var rateDestMedia = fx && fx.unitsPerUsdVenta && fx.unitsPerUsdVenta[dest] != null
      ? fx.unitsPerUsdVenta[dest] : null;
    if (!rateOriginMedia || !rateDestMedia) {
      return { ok: false, error: 'Sin tasas FX para las monedas del par.' };
    }

    // Tasa efectiva por lado: sistema (modo) o manual si el usuario la activó;
    // factor de seguridad = (sistema − manual)/sistema × 100 (positivo = descuento).
    var rateOrigin, rateDest, sysOrigin, sysDest, factorOrigin, factorDest;
    function applyRates(sO, sD) {
      sysOrigin = sO.originRate;
      sysDest = sD.destRate;
      rateOrigin = (originManual != null && sysOrigin > 0) ? originManual : sysOrigin;
      rateDest = (destManual != null && sysDest > 0) ? destManual : sysDest;
      factorOrigin = (originManual != null && sysOrigin > 0 && rateOrigin !== sysOrigin)
        ? (sysOrigin - rateOrigin) / sysOrigin * 100 : 0;
      factorDest = (destManual != null && sysDest > 0 && rateDest !== sysDest)
        ? (sysDest - rateDest) / sysDest * 100 : 0;
    }
    function srcOf(scn, side, manual) {
      return (manual != null) ? 'manual' : scenarioSource(scn, side);
    }

    // amountUsd: USD equivalente para rateScenarios (si depositVal es fiat origen, derivar USD).
    var amountUsd = depositVal / rateOriginMedia;

    // Obtener escenario de tasa con amountUsd (USD) — fallback a media cuando ads están filtrados.
    var scenarios = rateScenarios(settings, fx, pair, dir, amountUsd, 'compra');
    var om = originMode || 'best';
    var dm = destMode || 'best';
    var sOrig = scenarios[om] || scenarios['best'] || {};
    var sDest = scenarios[dm] || scenarios['best'] || {};

    // Si el escenario elegido no tiene rates (ads filtrados), usar media FX como base.
    if (!sOrig.originRate || !sDest.destRate) {
      sOrig.originRate = rateOriginMedia;
      sOrig.originAd = null;
      sDest.destRate = rateDestMedia;
      sDest.destAd = null;
      // Fuente explícita del fallback (la UI etiqueta “media FX (sin anuncios)”).
      sOrig.originSource = 'media(' + origin + '/compra)';
      sDest.destSource = 'media(' + dest + '/venta)';
      // Guardar media para el escenario elegido
      scenarios[om] = sOrig;
      scenarios[dm] = sDest;
    }
    applyRates(sOrig, sDest);

    var commPct = (commissionPct != null && (typeof commissionPct === 'number') && commissionPct >= 0) ? commissionPct : commissionFor(settings, origin);
    var reversed = !!req.reversed;
    var target = reversed ? num(req.target) : null;

    function rateInfo(collect) {
      return {
        originScenarios: scenarios,
        destScenarios: scenarios,
        adUsed: originManual != null ? null : sOrig.originAd,
        originSource: srcOf(sOrig, 'origin', originManual != null ? originManual : null),
        destSource: srcOf(sDest, 'dest', destManual != null ? destManual : null),
        originAdsCount: originManual != null ? null : scenarioAdsCount(sOrig, 'origin'),
        destAdsCount: destManual != null ? null : scenarioAdsCount(sDest, 'dest'),
        originSystemRate: sysOrigin, destSystemRate: sysDest,
        originManualRate: originManual, destManualRate: destManual,
        originSecurityFactor: originManual != null ? factorOrigin : null,
        destSecurityFactor: destManual != null ? factorDest : null,
        // Aviso de plataforma <3 (Máximo) solo cuando el modo activo del lado
        // correspondiente es max; en Mejor/Promedio/Mínimo el aviso no aplica.
        warnings: [].concat(
          (om === 'max' && scenarios.max && scenarios.max.originWarn)
            ? scenarios.max.originWarn.slice() : [],
          (dm === 'max' && scenarios.max && scenarios.max.destWarn)
            ? scenarios.max.destWarn.slice() : []
        ),
        originRate: rateOrigin, destRate: rateDest,
        quotedRate: collect.quotedRate,
        effectiveRate: collect.effectiveRate,
        marketRate: collect.marketRate,
        profitCommission: collect.profit,
        profitSafety: collect.profitSafety
      };
    }

    // marketRate: cross (dest/origen) del mejor escenario (siempre sistema)
    var mBest = scenarios.best;
    var marketRate = (mBest && mBest.destRate && mBest.originRate)
      ? mBest.destRate / mBest.originRate : rateDest;

    if (reversed && target != null && target > 0) {
      // INVERSO: target fijado — primera pasada (con depositVal = referenceAmountUsd)
      var netUsd = target / rateDest;
      var grossUsd0 = netUsd / (1 - commPct);
      var deposit0 = round2(grossUsd0 * rateOrigin);
      var amountUsd2 = deposit0 / rateOrigin;
      // Segunda pasada con el depósito calculado
      var sc2 = rateScenarios(settings, fx, pair, dir, amountUsd2, 'compra');
      var sO2 = sc2[om] || sc2['best'] || {}, sD2 = sc2[dm] || sc2['best'] || {};
      if (sO2.originRate && sD2.destRate) {
        scenarios = sc2;
        sOrig = sO2; sDest = sD2;
        applyRates(sOrig, sDest);
      }
      var grossUsd = (target / rateDest) / (1 - commPct);
      var deposit = round2(grossUsd * rateOrigin);
      var delivered = round2(target);
      var netUsd2 = target / rateDest;
      var profit = round2(grossUsd - netUsd2);
      var base = Math.max(profit, 0);
      var diezmo = round2(base * settings.diezmo);
      var tercero = terceroOn ? round2(base * settings.tercero) : 0;
      var quotedRateRev = round2(rateDest / rateOrigin);

      return {
        ok: true, kind: 'scenario', pair: pair.slice(), direction: dir,
        currencyIn: origin, currencyOut: dest,
        deposit: deposit, delivered: delivered, grossUsd: grossUsd,
        commission: commPct, commissionPct: round2(commPct * 100),
        overridden: false, reversed: true, referencial: (origin === 'EUR' || dest === 'EUR'),
        grossProfit: profit, profitUsd: profit, base: base, diezmo: diezmo, tercero: tercero,
        neto: round2(profit - diezmo - tercero),
        scenario: {
          originMode: originMode, destMode: destMode,
          originManualRate: originManual, destManualRate: destManual
        },
        rateInfo: rateInfo({
          quotedRate: quotedRateRev,
          effectiveRate: round2(delivered / deposit),
          marketRate: marketRate,
          profit: profit,
          profitSafety: round2(deposit * (marketRate - quotedRateRev))
        })
      };
    }

    // FORWARD: deposit dado — segunda pasada con monto en USD (amountUsd)
    if (!depositVal || depositVal <= 0) return { ok: false, error: 'Monto inválido.' };
    var amountUsd3 = depositVal / rateOrigin;
    var sc3 = rateScenarios(settings, fx, pair, dir, amountUsd3, 'compra');
    var sO3 = sc3[om] || sc3['best'] || {}, sD3 = sc3[dm] || sc3['best'] || {};
    if (sO3.originRate && sD3.destRate) {
      scenarios = sc3;
      sOrig = sO3; sDest = sD3;
      applyRates(sOrig, sDest);
    }
    var grossUsdF = depositVal / rateOrigin;
    var netUsdF = grossUsdF * (1 - commPct);
    var deliveredF = round2(netUsdF * rateDest);
    if (!(deliveredF > 0)) return { ok: false, error: 'Monto demasiado bajo.' };
    var profitF = round2(grossUsdF - netUsdF);
    var baseF = Math.max(profitF, 0);
    var diezmoF = round2(baseF * settings.diezmo);
    var terceroF = terceroOn ? round2(baseF * settings.tercero) : 0;
    var quotedRateF = round2(rateDest / rateOrigin);

    return {
      ok: true, kind: 'scenario', pair: pair.slice(), direction: dir,
      currencyIn: origin, currencyOut: dest,
      deposit: depositVal, delivered: deliveredF, grossUsd: grossUsdF,
      commission: commPct, commissionPct: round2(commPct * 100),
      overridden: false, reversed: false, referencial: (origin === 'EUR' || dest === 'EUR'),
      grossProfit: profitF, profitUsd: profitF, base: baseF, diezmo: diezmoF, tercero: terceroF,
      neto: round2(profitF - diezmoF - terceroF),
      scenario: {
        originMode: originMode, destMode: destMode,
        originManualRate: originManual, destManualRate: destManual,
        referenceAmountUsd: refAmount, useActualAmount: useActual
      },
      rateInfo: rateInfo({
        quotedRate: quotedRateF,
        effectiveRate: round2(deliveredF / depositVal),
        marketRate: marketRate,
        profit: profitF,
        profitSafety: round2(depositVal * (marketRate - quotedRateF))
      })
    };
  }

  // ==================== Casos (comisión 7%/8%, USD/USD, EUR referencial) ====================

  function commissionFor(settings, currencyIn) {
    var v = currencyIn === 'COP' ? settings.commissionCop : settings.commissionDefault;
    return (typeof v === 'number' && isFinite(v) && v > 0 && v < 1) ? v : (currencyIn === 'COP' ? 0.08 : 0.07); // nunca undefined/NaN
  }

  function round2(x) { return Math.round(x * 100) / 100; }

  /* El par debe estar en settings.pairs o settings.customPairs (no dirigido:
   * sirve en ambas direcciones). Los pares con EUR son casos referenciales
   * (EUR↔USD, EUR↔VES) y se aceptan siempre que la tasa exista. */
  function pairRegistered(settings, pair) {
    if (pair[0] === 'EUR' || pair[1] === 'EUR') return true;
    var all = (settings.pairs || []).concat(settings.customPairs || []);
    for (var i = 0; i < all.length; i++) {
      if (all[i][0] === pair[0] && all[i][1] === pair[1]) return true;
      if (all[i][0] === pair[1] && all[i][1] === pair[0]) return true;
    }
    return false;
  }

  /* req: { pair: ['VES','PEN'], direction: 'AB'|'BA', deposit }
   *      | { pair: ['VES','PEN'], direction: 'AB'|'BA', target }   (inverso)
   *      | { pair: ['USD','USD'], deposit, deliveredOverride }     (Zelle forward)
   *      | { pair: ['USD','USD'], target }                          (Zelle inverso)
   * Modo inverso: la ENTREGA (target) queda fijada y el depósito se deduce:
   *   usdtCost  = target / unitsPerUsdVenta(destino)
   *   usdtGross = usdtCost / (1 - comisión)
   *   deposit   = usdtGross × unitsPerUsdCompra(origen)
   * USD/USD inverso: deposit = delivered / (1 - margen). En inverso el
   * deliveredOverride no aplica (la entrega la fija target): si llega distinto,
   * se rechaza en lugar de ignorarse.
   * Devuelve cotización completa con desglose fiscal. Sin tasa -> ok:false. */
  function caseQuote(settings, fx, req) {
    var pair = req && req.pair;
    if (!Array.isArray(pair) || pair.length !== 2) return { ok: false, error: 'Par inválido.' };
    var target = num(req.target); // presente => modo inverso
    var reverse = target != null;
    var deposit = reverse ? null : num(req.deposit);
    if (!reverse && (deposit == null || deposit <= 0)) return { ok: false, error: 'Monto a depositar inválido.' };
    if (reverse && target <= 0) return { ok: false, error: 'Monto objetivo (a entregar) inválido.' };
    var usd1, usd2, currencyIn, currencyOut, referencial = false;

    if (pair[0] === 'USD' && pair[1] === 'USD') {
      currencyIn = currencyOut = 'USD';
      usd1 = usd2 = 1;
      var override = num(req.deliveredOverride);
      var margin = settings.zelleMargin != null ? settings.zelleMargin : 0.07;
      var delivered, overridden;
      if (reverse) {
        delivered = round2(target);
        if (override != null && override !== delivered) {
          return { ok: false, error: 'En modo inverso la entrega la fija target; deliveredOverride no aplica.' };
        }
        deposit = round2(delivered / (1 - margin));
        if (!(deposit > 0)) return { ok: false, error: 'Monto demasiado bajo: el depósito redondea a 0.' };
        overridden = false;
      } else {
        delivered = override != null
          ? override
          : round2(deposit * (1 - margin));
        if (override != null && (override <= 0 || override > deposit)) {
          return { ok: false, error: 'Override de entrega inválido (0 < entrega ≤ depósito).' };
        }
        overridden = override != null;
      }
      var profit = round2(deposit - delivered);
      var base = Math.max(profit, 0);
      var diezmo = round2(base * settings.diezmo);
      var tercero = round2(base * settings.tercero);
      return {
        ok: true, kind: 'usd-usd', pair: ['USD', 'USD'], direction: 'AB',
        currencyIn: 'USD', currencyOut: 'USD',
        deposit: deposit, delivered: delivered, grossUsd: deposit,
        commission: 0, commissionPct: 0, marginPct: deposit > 0 ? round2(profit / deposit * 100) : null,
        overridden: overridden, reversed: reverse, referencial: false,
        grossProfit: profit, profitUsd: profit, base: base, diezmo: diezmo, tercero: tercero,
        neto: round2(profit - diezmo - tercero),
        raw: { profit: deposit - delivered, diezmo: Math.max(deposit - delivered, 0) * settings.diezmo, tercero: Math.max(deposit - delivered, 0) * settings.tercero },
        rateInfo: { source: 'override/margen Zelle' }
      };
    }

    if (pair[0] === pair[1]) return { ok: false, error: 'Origen y destino iguales.' };
    if (!pairRegistered(settings, pair)) {
      return { ok: false, error: 'Par no registrado: agrégalo en pares personalizados.', unregistered: pair.slice() };
    }

    var dir = req.direction === 'BA' ? 'BA' : 'AB';
    currencyIn = dir === 'AB' ? pair[0] : pair[1];
    currencyOut = dir === 'AB' ? pair[1] : pair[0];
    if (currencyIn === 'EUR' || currencyOut === 'EUR') referencial = true;
    // SPEC: ORIGEN con compra(A) (cuántos fiat por USD al comprar) y DESTINO con venta(B).
    usd1 = unitPerUsdOf(fx, currencyIn, 'compra');
    usd2 = unitPerUsdOf(fx, currencyOut, 'venta');
    if (usd1 == null) return { ok: false, error: 'Sin tasa de compra para ' + currencyIn + ': no se inventan datos.', missing: currencyIn, referencial: referencial };
    if (usd2 == null) return { ok: false, error: 'Sin tasa de venta para ' + currencyOut + ': no se inventan datos.', missing: currencyOut, referencial: referencial };

    var commission = commissionFor(settings, currencyIn);
    var delivered, grossUsd, usdtCost, profitUnrounded, baseRaw;
    if (reverse) {
      delivered = round2(target);
      usdtCost = delivered / usd2;                        // USDT que cuesta cubrir el target (lado venta del destino)
      grossUsd = usdtCost / (1 - commission);             // USDT bruto a vender
      deposit = round2(grossUsd * usd1);                  // depósito del cliente (lado compra del origen)
      if (!(deposit > 0)) {
        return { ok: false, error: 'Monto demasiado bajo: el depósito redondea a 0.' };
      }
    } else {
      grossUsd = deposit / usd1;                          // valor del depósito en USD (lado compra del origen)
      delivered = round2(grossUsd * usd2 * (1 - commission));
      if (delivered == null || !(delivered > 0)) {
        return { ok: false, error: 'Monto demasiado bajo: la entrega redondea a 0.' };
      }
      usdtCost = delivered / usd2;
    }
    var usdOut = usdtCost;
    profitUnrounded = grossUsd - usdOut;                 // ≈ grossUsd × comisión (valor crudo)
    baseRaw = Math.max(profitUnrounded, 0);
    var profit = round2(profitUnrounded);
    var base = Math.max(profit, 0);
    var diezmo = round2(base * settings.diezmo);
    var tercero = round2(base * settings.tercero);
    return {
      ok: true, kind: 'pair', pair: pair.slice(), direction: dir,
      currencyIn: currencyIn, currencyOut: currencyOut,
      deposit: deposit, delivered: delivered, grossUsd: grossUsd,
      commission: commission, commissionPct: round2(commission * 100),
      overridden: false, reversed: reverse, referencial: referencial,
      grossProfit: profit, profitUsd: profit, base: base, diezmo: diezmo, tercero: tercero,
      neto: round2(profit - diezmo - tercero),
      raw: { profit: profitUnrounded, diezmo: baseRaw * settings.diezmo, tercero: baseRaw * settings.tercero },
      rateInfo: {
        unitsPerUsdIn: usd1, unitsPerUsdOut: usd2,
        rateInPerOut: usd2 / usd1
      }
    };
  }

  function unitPerUsdOf(fx, code, side) {
    if (code === 'USD') return 1;
    var bag = fx && (side === 'compra' ? fx.unitsPerUsdCompra : fx.unitsPerUsdVenta);
    return bag ? finitePositive(bag[code]) : null;
  }

  /* Ejecuta un caso: registra el movimiento en el libro ("auto-registering").
   * depositAccount = cuenta donde entra el depósito del cliente;
   * deliverAccount = cuenta desde la que sale lo entregado (null = externo).
   * Si `req` trae originMode/destMode (panel de escenarios), la cotización se
   * delega en caseQuoteScenario: UNA sola cotización para desglose y registro
   * (comisión por req.commissionPct; depósito/entrega/effectiveRate/commissionPct/
   * modos/rateInfo del escenario quedan en el movimiento). */
  function executeCase(state, fx, req) {
    var scenario = !!(req && (req.originMode != null || req.destMode != null));
    var q = scenario ? caseQuoteScenario(state.settings, fx, req) : caseQuote(state.settings, fx, req);
    if (!q.ok) return q;
    var rateIn = scenario
      ? q.rateInfo.originRate
      : (q.rateInfo.unitsPerUsdIn != null ? q.rateInfo.unitsPerUsdIn : 1);
    var rateOut = scenario
      ? q.rateInfo.destRate
      : (q.rateInfo.unitsPerUsdOut != null ? q.rateInfo.unitsPerUsdOut : 1);
    var caseMeta = {
      kind: q.kind, pair: q.pair, direction: q.direction,
      commission: q.commission, commissionPct: q.commissionPct,
      marginPct: q.marginPct || null, overridden: q.overridden, reversed: q.reversed === true, referencial: q.referencial,
      grossUsd: q.grossUsd, profitUsd: q.profitUsd,
      base: q.base, diezmo: q.diezmo, tercero: q.tercero, neto: q.neto,
      raw: q.raw,
      rateAtIn: rateIn, rateAtOut: rateOut
    };
    if (scenario) {
      // Registro guiado por el quote del panel: modos elegidos, tasa efectiva y
      // rateInfo del escenario quedan en el movimiento (deposit/delivered son
      // los montos in/out; nunca se re-cotiza con caseQuote).
      caseMeta.originMode = q.scenario.originMode;
      caseMeta.destMode = q.scenario.destMode;
      // 3e: la seguridad es la tasa manual (factor de seguridad por lado);
      // el 2% por modo ya no existe. rateInfo guarda manual/factor/source.
      caseMeta.originManualRate = q.scenario.originManualRate;
      caseMeta.destManualRate = q.scenario.destManualRate;
      caseMeta.effectiveRate = q.rateInfo.effectiveRate;
      caseMeta.rateInfo = {
        originRate: q.rateInfo.originRate, destRate: q.rateInfo.destRate,
        quotedRate: q.rateInfo.quotedRate, effectiveRate: q.rateInfo.effectiveRate,
        marketRate: q.rateInfo.marketRate,
        originSource: q.rateInfo.originSource, destSource: q.rateInfo.destSource,
        originSystemRate: q.rateInfo.originSystemRate, destSystemRate: q.rateInfo.destSystemRate,
        originManualRate: q.rateInfo.originManualRate, destManualRate: q.rateInfo.destManualRate,
        originSecurityFactor: q.rateInfo.originSecurityFactor, destSecurityFactor: q.rateInfo.destSecurityFactor,
        adUsed: q.rateInfo.adUsed
      };
    }
    var mv = {
      date: req.date, type: 'operation',
      in: { account: req.depositAccount || null, currency: q.currencyIn, amount: q.deposit, rateAt: rateIn },
      out: { account: req.deliverAccount === undefined ? req.depositAccount : req.deliverAccount, currency: q.currencyOut, amount: q.delivered, rateAt: rateOut },
      note: req.note || ('Caso ' + q.currencyIn + '→' + q.currencyOut + (q.referencial ? ' (referencial)' : '')),
      meta: { case: caseMeta }
    };
    var saved = appendMovement(state, mv);
    return { ok: true, quote: q, movement: saved };
  }

  // ==================== Libro mayor (ledger) con cadena de hashes ====================

  function periodOfDate(date) {
    return /^\d{4}-\d{2}/.test(date || '') ? date.slice(0, 7) : null;
  }

  /* Fecha YYYY-MM-DD real (regex anclada + calendario válido): evita que una
   * fecha malformada eluda el bloqueo de periodo (periodId = null). */
  function isValidDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
    var t = Date.parse(s + 'T00:00:00Z');
    if (!isFinite(t)) return false;
    var d = new Date(t);
    return d.getUTCFullYear() === +s.slice(0, 4) && d.getUTCMonth() === +s.slice(5, 7) - 1 && d.getUTCDate() === +s.slice(8, 10);
  }

  function _assertEntry(mv, field, state) {
    var e = mv[field];
    if (e == null) return null;
    if (typeof e !== 'object') throw new Error('Entrada ' + field + ' inválida.');
    var amount = num(e.amount);
    if (amount == null || amount <= 0) throw new Error('Monto de ' + field + ' debe ser > 0.');
    if (CURRENCIES.indexOf(e.currency) < 0) throw new Error('Moneda inválida en ' + field + ': ' + e.currency);
    if (e.account != null && !accountById(state, e.account)) throw new Error('Cuenta desconocida en ' + field + ': ' + e.account);
    if (e.account != null && accountById(state, e.account).currency !== e.currency) {
      throw new Error('La cuenta ' + e.account + ' no opera ' + e.currency + '.');
    }
    return { account: e.account || null, currency: e.currency, amount: amount, rateAt: num(e.rateAt) };
  }

  /* Movimiento: {id, seq, date, type, in, out, note, meta:{}, prevHash, hash}.
   * Append-only: nunca se edita ni borra; el hash se calcula sobre el JSON canónico
   * SIN los campos hash (prevHash incluido vía encadenamiento explícito). */
  function appendMovement(state, mv) {
    if (!mv || typeof mv !== 'object') throw new Error('Movimiento inválido.');
    if (MOVEMENT_TYPES.indexOf(mv.type) < 0) throw new Error('Tipo de movimiento inválido: ' + mv.type);
    if (mv.type === 'legacy' && mv.date == null) {
      // El legado v1 puede traer fechas inválidas: se acepta date=null en legacy sin perder el dato.
    } else if (!isValidDate(mv.date)) {
      throw new Error('Fecha inválida (YYYY-MM-DD real): ' + mv.date);
    }
    var periodId = periodOfDate(mv.date);
    if (state.periods[periodId] && state.periods[periodId].closedAt) {
      throw new Error('El periodo ' + periodId + ' está cerrado; no se aceptan movimientos de ' + mv.date + '.');
    }
    var entry = _assertEntry(mv, 'in', state);
    var exit = _assertEntry(mv, 'out', state);
    if (!entry && !exit) throw new Error('El movimiento no tiene ni entrada ni salida.');
    if (mv.type === 'withdrawal' && entry) throw new Error('Un retiro solo tiene salida.');
    if (mv.type === 'contribution' && exit) throw new Error('Un aporte solo tiene entrada.');

    var prev = state.movements[state.movements.length - 1];
    var seq = state.movements.length + 1;
    var clean = {
      seq: seq, date: mv.date, type: mv.type,
      in: entry, out: exit,
      note: mv.note || '',
      meta: mv.meta && typeof mv.meta === 'object' ? mv.meta : {},
      prevHash: prev ? prev.hash : GENESIS
    };
    clean.hash = sha256Hex(canonicalJson(clean));
    clean.id = 'mv-' + seq;
    state.movements.push(clean);
    return clean;
  }

  function verifyChain(movements) {
    if (!Array.isArray(movements)) return false;
    for (var i = 0; i < movements.length; i++) {
      var m = movements[i];
      var clean = {
        seq: m.seq, date: m.date, type: m.type, in: m.in, out: m.out,
        note: m.note || '', meta: m.meta || {},
        prevHash: i === 0 ? GENESIS : movements[i - 1].hash
      };
      if (m.prevHash !== clean.prevHash) return false;
      if (m.hash !== sha256Hex(canonicalJson(clean))) return false;
    }
    return true;
  }

  function chainHead(movements) {
    return movements && movements.length ? movements[movements.length - 1].hash : null;
  }

  // ==================== Saldos por cuenta ====================

  function accountBalance(state, accountId) {
    var acc = accountById(state, accountId);
    if (!acc) return null;
    var opening = num(acc.opening) || 0, credits = 0, debits = 0;
    state.movements.forEach(function (m) {
      if (m.in && m.in.account === accountId) credits += m.in.amount;
      if (m.out && m.out.account === accountId) debits += m.out.amount;
    });
    return { account: accountId, currency: acc.currency, opening: opening, credits: credits, debits: debits, native: opening + credits - debits };
  }

  // ==================== Balance general ====================

  /* Balance nativo por moneda (apertura + créditos − débitos, exacto), valoración en
   * USD con unitsPerUsd actual, pasivos (diezmo/tercero acumulados de operaciones:
   * ya están expresados en USD, se suman crudos sin dividir por tasa), capital =
   * activos − pasivos y fxDiff = "revalorización FX" (valor actual menos el valor a
   * la tasa de cada movimiento). Reglas: (1) una moneda con flujos SIN `rateAt`
   * queda sin fxDiff (null + aviso): aportes/retiros sin valor histórico no se
   * presentan como revalorización; (2) `cuadre` compara la suma de saldos por cuenta
   * contra una agregación independiente en una pasada sobre los movimientos
   * (aperturas + créditos − débitos por moneda); (3) la valoración USD de una moneda
   * sin tasa se excluye con aviso (el saldo nativo se conserva; no se cuenta como 0). */
  function balance(state, fx) {
    var res = { currencies: {}, assetsUsd: 0, liabilities: { diezmo: 0, tercero: 0, total: 0, byCurrency: {} }, equityUsd: 0, fxDiffUsd: 0, cuadre: true, warnings: [], fxNote: 'El cuadre exacto es el nativo por moneda; el total USD es valoración a tasas actuales (FX).' };
    var byCurrency = {};
    var openings = {}, credits = {}, debits = {};
    state.accounts.forEach(function (acc) {
      var b = accountBalance(state, acc.id);
      var slot = byCurrency[acc.currency] = byCurrency[acc.currency] || { native: 0, usdNow: null, usdAtMovs: 0, fxDiff: null, cuadre: true, accounts: [] };
      slot.native += b.native;
      slot.accounts.push({ id: acc.id, name: acc.name, native: b.native });
      openings[acc.currency] = (openings[acc.currency] || 0) + (num(acc.opening) || 0);
    });
    // Agregación independiente (cuadre) + valoración histórica por movimiento (fxDiff).
    var atMovs = {}, unvalued = {};
    state.movements.forEach(function (m) {
      [['in', +1], ['out', -1]].forEach(function (lado) {
        var leg = m[lado[0]];
        if (!leg) return;
        if (leg.account != null) {
          var bucket = lado[0] === 'in' ? credits : debits;
          bucket[leg.currency] = (bucket[leg.currency] || 0) + leg.amount;
        }
        var rateAt = finitePositive(leg.rateAt);
        var slotA = atMovs[leg.currency] = atMovs[leg.currency] || { sum: 0 };
        if (rateAt == null) { unvalued[leg.currency] = (unvalued[leg.currency] || 0) + 1; return; }
        slotA.sum += lado[1] * (leg.amount / rateAt);
      });
      if (m.type === 'operation' && m.meta && m.meta.case) {
        // El diezmo/tercero del caso se acumulan EN USD: se suman los valores crudos
        // (meta.case.raw cuando existe), nunca divididos por la tasa del movimiento.
        var c = m.meta.case;
        var raw = c.raw || { diezmo: c.diezmo, tercero: c.tercero };
        var slotL = res.liabilities.byCurrency.USD = res.liabilities.byCurrency.USD || { diezmo: 0, tercero: 0, usd: 0 };
        slotL.diezmo += raw.diezmo || 0;
        slotL.tercero += raw.tercero || 0;
        res.liabilities.diezmo += raw.diezmo || 0;
        res.liabilities.tercero += raw.tercero || 0;
      }
    });
    Object.keys(byCurrency).forEach(function (code) {
      var rate = unitPerUsdOf(fx, code);
      var slot = byCurrency[code];
      slot.usdNow = rate != null ? slot.native / rate : null;
      slot.usdAtMovs = atMovs[code] ? atMovs[code].sum : 0; // ya valorado a la tasa de cada movimiento
      var recomputed = (openings[code] || 0) + (credits[code] || 0) - (debits[code] || 0);
      slot.cuadre = Math.abs(recomputed - slot.native) <= 1e-9;
      if (!slot.cuadre) res.cuadre = false;
      if (unvalued[code]) {
        slot.fxDiff = null;
        res.warnings.push('fxDiff no disponible para ' + code + ': hay ' + unvalued[code] + ' flujo(s) sin valoración histórica (rateAt).');
      } else if (rate != null) {
        slot.fxDiff = (slot.native / rate) - slot.usdAtMovs;
      }
      if (slot.usdNow != null) res.assetsUsd += slot.usdNow;
      else if (slot.native !== 0) res.warnings.push('Balance USD incompleto: sin tasa para ' + code + ' (saldo nativo ' + slot.native + ' excluido de la valoración, no contado como 0).');
      if (slot.fxDiff != null) res.fxDiffUsd += slot.fxDiff;
      res.currencies[code] = slot;
    });
    res.liabilities.total = res.liabilities.diezmo + res.liabilities.tercero; // USD crudos, sin conversión
    res.liabilities.byCurrency.USD = res.liabilities.byCurrency.USD || { diezmo: 0, tercero: 0, usd: 0 };
    res.liabilities.byCurrency.USD.usd = res.liabilities.total;
    res.equityUsd = res.assetsUsd - res.liabilities.total;
    return res;
  }

  // ==================== Periodos mensuales (cierre / bloqueo) ====================

  function closePeriod(state, periodId, fx) {
    if (!/^\d{4}-\d{2}$/.test(periodId || '')) throw new Error('Periodo inválido (YYYY-MM): ' + periodId);
    var p = state.periods[periodId];
    if (p && p.closedAt) throw new Error('El periodo ' + periodId + ' ya está cerrado.');
    var balances = {};
    var perCurrency = {};
    state.accounts.forEach(function (acc) {
      var b = accountBalance(state, acc.id);
      perCurrency[acc.currency] = (perCurrency[acc.currency] || 0) + b.native;
      balances[acc.id] = b.native;
    });
    var missingRates = [], warnings = fx ? fxWarnings(fx) : [];
    var usd = null;
    if (fx) {
      usd = 0;
      Object.keys(perCurrency).forEach(function (code) {
        var rate = unitPerUsdOf(fx, code);
        if (rate == null) {
          if (perCurrency[code] !== 0) missingRates.push(code); // sin tasa: no se cuenta como 0 silencioso
          return;
        }
        usd += perCurrency[code] / rate;
      });
      if (missingRates.length) {
        warnings.push('Valoración USD del cierre incompleta: sin tasa para ' + missingRates.join(', ') + ' (saldos nativos conservados; faltantes excluidos de la valoración).');
      }
    }
    var snapshot = { periodId: periodId, closedAt: new Date().toISOString(), balances: balances, byCurrency: perCurrency, usdValuation: usd, usdComplete: fx ? missingRates.length === 0 : null, missingRates: missingRates, warnings: warnings, chainHead: chainHead(state.movements) };
    state.periods[periodId] = Object.assign({}, p || {}, snapshot);
    return state.periods[periodId];
  }

  function isPeriodClosed(state, periodId) {
    return !!(state.periods[periodId] && state.periods[periodId].closedAt);
  }

  // ==================== Export / import (JSON/CSV) + manifiesto ====================

  function manifest(state) {
    var liab = { diezmo: 0, tercero: 0 };
    state.movements.forEach(function (m) {
      if (m.type === 'operation' && m.meta && m.meta.case) {
        var c = m.meta.case;
        var raw = c.raw || { diezmo: c.diezmo, tercero: c.tercero }; // totales desde valores crudos
        liab.diezmo += raw.diezmo || 0;
        liab.tercero += raw.tercero || 0;
      }
    });
    var closed = Object.keys(state.periods).filter(function (k) { return state.periods[k].closedAt; });
    return {
      engine: 'consutasas/engine', version: VERSION, generatedAt: new Date().toISOString(),
      counts: { accounts: state.accounts.length, movements: state.movements.length, periods: closed.length },
      chainOk: verifyChain(state.movements),
      chainHead: chainHead(state.movements),
      periodsClosed: closed,
      liabilitiesAccrued: liab
    };
  }

  function exportState(state) {
    return {
      format: 'consutasas/v2', version: VERSION, exportedAt: new Date().toISOString(),
      settings: JSON.parse(JSON.stringify(state.settings)),
      accounts: JSON.parse(JSON.stringify(state.accounts)),
      movements: JSON.parse(JSON.stringify(state.movements)),
      periods: JSON.parse(JSON.stringify(state.periods)),
      manifest: manifest(state)
    };
  }

  function exportCsv(state) {
    var esc2 = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
    var head = ['seq', 'date', 'type', 'inAccount', 'inCurrency', 'inAmount', 'outAccount', 'outCurrency', 'outAmount', 'note', 'hash'];
    var nameOf = function (stateInner, id) { var a = id && accountById(stateInner, id); return a ? a.name : (id || ''); };
    var lines = [head.join(',')];
    state.movements.forEach(function (m) {
      lines.push([
        m.seq, m.date, m.type,
        esc2(nameOf(state, m.in && m.in.account)), esc2(m.in ? m.in.currency : ''),
        m.in ? m.in.amount : '', esc2(nameOf(state, m.out && m.out.account)), esc2(m.out ? m.out.currency : ''),
        m.out ? m.out.amount : '', esc2(m.note || ''), m.hash
      ].join(','));
    });
    return lines.join('\n') + '\n';
  }

  function importState(payload) {
    if (!payload || payload.format !== 'consutasas/v2' || !Array.isArray(payload.movements)) {
      throw new Error('Respaldo inválido: se espera `consutasas/v2` con movimientos.');
    }
    var state = {
      settings: payload.settings && typeof payload.settings === 'object' ? payload.settings : defaultSettings(),
      accounts: Array.isArray(payload.accounts) && payload.accounts.length ? payload.accounts : INITIAL_ACCOUNTS,
      movements: payload.movements,
      periods: payload.periods && typeof payload.periods === 'object' ? payload.periods : {}
    };
    if (!verifyChain(state.movements)) throw new Error('Cadena de hashes inválida: el respaldo fue alterado.');
    if (state.movements.some(function (m) { return m.seq !== state.movements.indexOf(m) + 1; })) {
      throw new Error('Numeración de movimientos inconsistente en el respaldo.');
    }
    if (payload.accounts && payload.accounts.some(function (a) {
      return !a.id || !a.name || CURRENCIES.indexOf(a.currency) < 0;
    })) throw new Error('Cuentas inválidas en el respaldo.');
    return state;
  }

  // ==================== API pública ====================

  return {
    VERSION: VERSION,
    CURRENCIES: CURRENCIES,
    FIATS: FIATS,
    DEFAULT_PAIRS: DEFAULT_PAIRS,
    INITIAL_ACCOUNTS: INITIAL_ACCOUNTS,
    MOVEMENT_TYPES: MOVEMENT_TYPES,
    STORAGE_KEYS: STORAGE_KEYS,
    GENESIS: GENESIS,
    sha256Hex: sha256Hex,
    canonicalJson: canonicalJson,
    defaultSettings: defaultSettings,
    createInitialState: createInitialState,
    accountById: accountById,
    load: load,
    save: save,
    wipe: wipe,
    migrateLegacyOperations: migrateLegacyOperations,
    loadAndMigrate: loadAndMigrate,
    buildFx: buildFx,
    fxWarnings: fxWarnings,
    walkBook: walkBook,
    adRateAt: adRateAt,
    rateScenarios: rateScenarios,
    caseQuoteScenario: caseQuoteScenario,
    commissionFor: commissionFor,
    caseQuote: caseQuote,
    executeCase: executeCase,
    appendMovement: appendMovement,
    verifyChain: verifyChain,
    chainHead: chainHead,
    accountBalance: accountBalance,
    balance: balance,
    closePeriod: closePeriod,
    isPeriodClosed: isPeriodClosed,
    manifest: manifest,
    exportState: exportState,
    importState: importState,
    exportCsv: exportCsv
  };
});
