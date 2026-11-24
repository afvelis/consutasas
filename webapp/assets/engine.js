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

  /* Busca la mejor tasa de un anuncio para fiat/side dado un amountUsd.
   * Filtra: min <= amountUsd*price <= max  y  available >= amountUsd.
   * mode='best' → compra = min(price), venta = max(price).
   * mode='average' → media FX de unitsPerUsdCompra/Venta del fiat.
   * mode='conservative' → compra = max(price), venta = min(price).
   * mode='max' → mayor price entre los anuncios ejecutables (en cualquier lado);
   *   mismo filtro min/max/available que best/conservative.
   * Fallback: ads vacías → media FX; filtrado vacío → null.
   * Devuelve {rate, ad, source, mode} o null si no hay ads y no hay fallback.
   * `rate` es en unitsPerUsd (compra) o (venta).
   * `ads` = array de {price, min, max, available, platform} o null (usa media FX).
   */
  function adRateAt(fx, fiat, side, amountUsd, mode, ads) {
    if (!fiat || !side || !amountUsd || !mode) return null;
    var origAds = Array.isArray(ads) ? ads : [];
    var adsArr = [];

    // Filtrar ads ejecutables para el monto dado
    for (var _i = 0; _i < origAds.length; _i++) {
      var a = origAds[_i];
      var _price = num(a.price);
      var _avail = finitePositive(a.available);
      var _min = num(a.min);
      var _max = num(a.max);
      if (_price == null || _avail == null) continue;
      var _cost = amountUsd * _price;
      if (_min != null && _cost < _min) continue;
      if (_max != null && _cost > _max) continue;
      if (_avail < amountUsd) continue;
      adsArr.push(a);
    }

    if (mode === 'best') {
      if (Array.isArray(adsArr) && adsArr.length) {
        var r = finitePositive(adsArr[0] && adsArr[0].price);
        if (r == null) return null;
        return { rate: r, ad: adsArr[0], source: 'ad_best_' + side, mode: mode };
      }
      // Si original era vacío → media FX; si se filtró todo → null
      if (origAds.length === 0) {
        var buyR = fx && fx.unitsPerUsdCompra && fx.unitsPerUsdCompra[fiat];
        var sellR = fx && fx.unitsPerUsdVenta && fx.unitsPerUsdVenta[fiat];
        if (side === 'compra') {
          var rB = finitePositive(buyR);
          if (rB == null) return null;
          return { rate: rB, ad: null, source: 'media(' + fiat + '/' + side + ')', mode: mode };
        } else {
          var rS = finitePositive(sellR);
          if (rS == null) return null;
          return { rate: rS, ad: null, source: 'media(' + fiat + '/' + side + ')', mode: mode };
        }
      }
      return null;
    }

    if (mode === 'max') {
      // Máximo: mayor price entre los ejecutables (independiente del orden del libro:
      // compra asc y venta desc dan la MISMA tasa si esa es la de mayor precio).
      if (Array.isArray(adsArr) && adsArr.length) {
        var maxAd = null;
        for (var _j = 0; _j < adsArr.length; _j++) {
          var _pMax = finitePositive(adsArr[_j] && adsArr[_j].price);
          if (_pMax == null) continue;
          if (maxAd == null || _pMax > finitePositive(maxAd.price)) maxAd = adsArr[_j];
        }
        if (maxAd != null) {
          return { rate: finitePositive(maxAd.price), ad: maxAd, source: 'ad_max_' + side, mode: mode };
        }
      }
      // Libro vacío → media FX; todo filtrado → null (el panel cae a la media).
      if (origAds.length === 0) {
        var buyRX = fx && fx.unitsPerUsdCompra && fx.unitsPerUsdCompra[fiat];
        var sellRX = fx && fx.unitsPerUsdVenta && fx.unitsPerUsdVenta[fiat];
        if (side === 'compra') {
          var rX = finitePositive(buyRX);
          if (rX == null) return null;
          return { rate: rX, ad: null, source: 'media(' + fiat + '/' + side + ')', mode: mode };
        } else {
          var rY = finitePositive(sellRX);
          if (rY == null) return null;
          return { rate: rY, ad: null, source: 'media(' + fiat + '/' + side + ')', mode: mode };
        }
      }
      return null;
    }

    if (mode === 'conservative') {
      if (Array.isArray(adsArr) && adsArr.length) {
        var r2 = finitePositive(adsArr[adsArr.length - 1] && adsArr[adsArr.length - 1].price);
        if (r2 == null) return null;
        return { rate: r2, ad: adsArr[adsArr.length - 1], source: 'ad_conservative_' + side, mode: mode };
      }
      if (origAds.length === 0) {
        var buyR = fx && fx.unitsPerUsdCompra && fx.unitsPerUsdCompra[fiat];
        var sellR = fx && fx.unitsPerUsdVenta && fx.unitsPerUsdVenta[fiat];
        if (side === 'compra') {
          var rC = finitePositive(buyR);
          if (rC == null) return null;
          return { rate: rC, ad: null, source: 'media(' + fiat + '/' + side + ')', mode: mode };
        } else {
          var rD = finitePositive(sellR);
          if (rD == null) return null;
          return { rate: rD, ad: null, source: 'media(' + fiat + '/' + side + ')', mode: mode };
        }
      }
      return null;
    }

    // average: media FX de unitsPerUsdCompra/Venta (spec)
    if (mode === 'average') {
      var buyRA = fx && fx.unitsPerUsdCompra && fx.unitsPerUsdCompra[fiat];
      var sellRA = fx && fx.unitsPerUsdVenta && fx.unitsPerUsdVenta[fiat];
      if (side === 'compra') {
        var rA = finitePositive(buyRA);
        if (rA != null) return { rate: rA, ad: null, source: 'media(' + fiat + '/' + side + ')', mode: 'average' };
      } else {
        var rB = finitePositive(sellRA);
        if (rB != null) return { rate: rB, ad: null, source: 'media(' + fiat + '/' + side + ')', mode: 'average' };
      }
    }
    // fallback final: media FX
    var buyR = fx && fx.unitsPerUsdCompra && fx.unitsPerUsdCompra[fiat];
    var sellR = fx && fx.unitsPerUsdVenta && fx.unitsPerUsdVenta[fiat];
    if (side === 'compra') {
      var rF = finitePositive(buyR);
      if (rF == null) return null;
      return { rate: rF, ad: null, source: 'media(' + fiat + '/' + side + ')', mode: mode };
    } else {
      var rG = finitePositive(sellR);
      if (rG == null) return null;
      return { rate: rG, ad: null, source: 'media(' + fiat + '/' + side + ')', mode: mode };
    }
  }

  /* Calcula los cuatro escenarios (best/average/conservative/max) para origen y destino.
   * Devuelve { best: { originRate, destRate, originAd, destAd }, average: {...},
   * conservative: {...}, max: {...} }.
   * `pair` = ['A','B'], `direction` = 'AB' | 'BA'.
   * `rateMode` indica qué side usar (compra/venta).
   * El 2% NO va aquí; es parámetro de cotización.
   */
  function rateScenarios(settings, fx, pair, direction, amount, rateMode, adsPair) {
    if (!pair || !direction || !rateMode) return { best: {}, average: {}, conservative: {}, max: {} };
    var dir = direction === 'BA' ? 'BA' : 'AB';
    var curA = dir === 'AB' ? pair[0] : pair[1];
    var curB = dir === 'AB' ? pair[1] : pair[0];
    // El origen siempre usa compra (se compra USD con la moneda origen),
    // el destino siempre usa venta (se vende USD por la moneda destino).
    // `rateMode` se pasa solo para coherencia de API pero siempre es 'compra'.
    var originSide = 'compra';
    var destSide = 'venta';
    var scenarios = { best: {}, average: {}, conservative: {}, max: {} };

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

    // best
    var aBestO = adRateAt(fx, curA, originSide, amount, 'best', adsA);
    var aBestD = adRateAt(fx, curB, destSide, amount, 'best', adsB);
    if (aBestO && aBestD) {
      scenarios.best.originRate = aBestO.rate;
      scenarios.best.destRate = aBestD.rate;
      scenarios.best.originAd = aBestO;
      scenarios.best.destAd = aBestD;
    }
    // average
    var aAvgO = adRateAt(fx, curA, originSide, amount, 'average', adsA);
    var aAvgD = adRateAt(fx, curB, destSide, amount, 'average', adsB);
    if (aAvgO && aAvgD) {
      scenarios.average.originRate = aAvgO.rate;
      scenarios.average.destRate = aAvgD.rate;
      scenarios.average.originAd = aAvgO;
      scenarios.average.destAd = aAvgD;
    }
    // conservative
    var aConsO = adRateAt(fx, curA, originSide, amount, 'conservative', adsA);
    var aConsD = adRateAt(fx, curB, destSide, amount, 'conservative', adsB);
    if (aConsO && aConsD) {
      scenarios.conservative.originRate = aConsO.rate;
      scenarios.conservative.destRate = aConsD.rate;
      scenarios.conservative.originAd = aConsO;
      scenarios.conservative.destAd = aConsD;
    }
    // max (Máximo: mayor price ejecutable en cada lado)
    var aMaxO = adRateAt(fx, curA, originSide, amount, 'max', adsA);
    var aMaxD = adRateAt(fx, curB, destSide, amount, 'max', adsB);
    if (aMaxO && aMaxD) {
      scenarios.max.originRate = aMaxO.rate;
      scenarios.max.destRate = aMaxD.rate;
      scenarios.max.originAd = aMaxO;
      scenarios.max.destAd = aMaxD;
    }
    return scenarios;
  }

  /* Cotización basada en escenarios del panel (motor de escenarios).
   * Nuevos parámetros en `req`:
   *   originMode   – 'best'|'average'|'conservative'|'max' (default: 'best')
   *   destMode     – igual (default: 'best')
   *   vesSafetyPct – safety sobre tasa VES (default: 0.02). 0 = sin 2%.
   *   destSafetyPct – safety sobre tasa destino (default: 0.02).
   *   commissionPct – reemplaza settings.commissionDefault/COP (default: undefined).
   *   terceroOn    – true/false (default: settings.tercero > 0).
   *
   * Fórmulas:
   *   PEN→VES:  USDT = PEN / compra_PEN · (1-5%);  net = USDT·(1-5%);
   *             destRate = venta_VES·(1-2%);  delivered = net·destRate.
   *   VES→otro: rateVES = compra_VES·(1+2%);
   *             USDT = VES/rateVES;  net = USDT·(1-5%);
   *             destRate = venta_dest·(1-2%);  delivered = net·destRate.
   *   2% configurable a 0; si VES no interviene, no aplica el 2% VES.
   *   El destino no-VES en VES→otro lleva destSafetyPct (resta).
   *   Profit al mercado (best venta) para exponer seguridad.
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
    var vesSafetyPct = req.vesSafetyPct != null ? req.vesSafetyPct : 0.02;
    var destSafetyPct = req.destSafetyPct != null ? req.destSafetyPct : 0.02;
    // Máximo cotiza SIN 2% en ambos lados (el safety es del modo 2%): aunque
    // llegue un pct o el default de 0.02, el modo 'max' lo anula.
    if (originMode === 'max') vesSafetyPct = 0;
    if (destMode === 'max') destSafetyPct = 0;
    var refAmount = req.referenceAmountUsd != null ? num(req.referenceAmountUsd) : 10;
    var useActual = !!req.useActualAmount;
    // Si deposit > 0, usar el monto real; si no, usar referenceAmountUsd (default 10)
    var depositVal = (num(req.deposit) || 0) > 0 ? num(req.deposit) : refAmount;
    if (useActual) depositVal = (req.deposit != null && num(req.deposit) != null) ? num(req.deposit) : depositVal;
    if (depositVal <= 0) return { ok: false, error: 'Monto inválido.' };
    var commissionPct = req.commissionPct != null ? num(req.commissionPct) : null;
    var terceroOn = req.terceroOn != null ? req.terceroOn : (settings.tercero > 0);

    // Bootstrap con media FX (sin filtro de ads) para derivar rates y amountUsd.
    // La segunda pasada en [reversed] refinará con ads reales.
    var rateOriginMedia = fx && fx.unitsPerUsdCompra && fx.unitsPerUsdCompra[origin] != null
      ? fx.unitsPerUsdCompra[origin] : null;
    var rateDestMedia = fx && fx.unitsPerUsdVenta && fx.unitsPerUsdVenta[dest] != null
      ? fx.unitsPerUsdVenta[dest] : null;
    if (!rateOriginMedia || !rateDestMedia) {
      return { ok: false, error: 'Sin tasas FX para las monedas del par.' };
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
      // Guardar media para el escenario elegido
      scenarios[om] = sOrig;
      scenarios[dm] = sDest;
    }

    // Effective rates con safety PCT VES
    var rateOrigin, rateDest;
    var isVESOrigin = origin === 'VES';
    var isVESDest = dest === 'VES';

    // vesSafetyPct solo si VES interviene (origen o destino)
    rateOrigin = isVESOrigin
      ? sOrig.originRate * (1 + vesSafetyPct)
      : sOrig.originRate;
    // destSafetyPct solo si VES interviene (origen o destino)
    rateDest = (isVESOrigin || isVESDest)
      ? sDest.destRate * (1 - destSafetyPct)
      : sDest.destRate;

    var commPct = (commissionPct != null && (typeof commissionPct === 'number') && commissionPct >= 0) ? commissionPct : commissionFor(settings, origin);
    var reversed = !!req.reversed;
    var target = reversed ? num(req.target) : null;

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
        rateOrigin = isVESOrigin
          ? sOrig.originRate * (1 + vesSafetyPct)
          : sOrig.originRate;
        rateDest = (isVESOrigin || isVESDest)
          ? sDest.destRate * (1 - destSafetyPct)
          : sDest.destRate;
      }
      var grossUsd = (target / rateDest) / (1 - commPct);
      var deposit = round2(grossUsd * rateOrigin);
      var delivered = round2(target);
      var netUsd2 = target / rateDest;
      var profit = round2(grossUsd - netUsd2);
      var base = Math.max(profit, 0);
      var diezmo = round2(base * settings.diezmo);
      var tercero = terceroOn ? round2(base * settings.tercero) : 0;

      // marketRate: cross (dest/origen) del mejor escenario
      var mBest = scenarios.best;
      var marketRate = (mBest && mBest.destRate && mBest.originRate)
        ? mBest.destRate / mBest.originRate : rateDest;
      var quotedRate = round2(rateDest / rateOrigin);

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
          vesSafetyPct: vesSafetyPct, destSafetyPct: destSafetyPct
        },
        rateInfo: {
          originScenarios: scenarios,
          destScenarios: scenarios,
          adUsed: sOrig.originAd,
          originRate: rateOrigin, destRate: rateDest,
          quotedRate: quotedRate,
          effectiveRate: round2(delivered / deposit),
          marketRate: marketRate,
          profitCommission: profit,
          profitSafety: round2(deposit * (marketRate - quotedRate)),
          safetyPct: (isVESOrigin ? vesSafetyPct : 0) + (isVESDest || isVESOrigin ? destSafetyPct : 0)
        }
      };
    }

    // FORWARD: deposit dado — segunda pasada con monto en USD (amountUsd)
    if (!depositVal || depositVal <= 0) return { ok: false, error: 'Monto inválido.' };
    var amountUsd2 = depositVal / rateOrigin;
    var sc2 = rateScenarios(settings, fx, pair, dir, amountUsd2, 'compra');
    var sO2 = sc2[om] || sc2['best'] || {}, sD2 = sc2[dm] || sc2['best'] || {};
    if (sO2.originRate && sD2.destRate) {
      scenarios = sc2;
      sOrig = sO2; sDest = sD2;
      rateOrigin = isVESOrigin
        ? sOrig.originRate * (1 + vesSafetyPct)
        : sOrig.originRate;
      rateDest = (isVESOrigin || isVESDest)
        ? sDest.destRate * (1 - destSafetyPct)
        : sDest.destRate;
    }
    var grossUsd = depositVal / rateOrigin;
    var netUsd = grossUsd * (1 - commPct);
    var delivered = round2(netUsd * rateDest);
    if (!(delivered > 0)) return { ok: false, error: 'Monto demasiado bajo.' };
    var profit = round2(grossUsd - netUsd);
    var base = Math.max(profit, 0);
    var diezmo = round2(base * settings.diezmo);
    var tercero = terceroOn ? round2(base * settings.tercero) : 0;

    // marketRate: cross (dest/origen) del mejor escenario
    var mBest = scenarios.best;
    var marketRate = (mBest && mBest.destRate && mBest.originRate)
      ? mBest.destRate / mBest.originRate : rateDest;
    var quotedRate = round2(rateDest / rateOrigin);

    return {
      ok: true, kind: 'scenario', pair: pair.slice(), direction: dir,
      currencyIn: origin, currencyOut: dest,
      deposit: depositVal, delivered: delivered, grossUsd: grossUsd,
      commission: commPct, commissionPct: round2(commPct * 100),
      overridden: false, reversed: false, referencial: (origin === 'EUR' || dest === 'EUR'),
      grossProfit: profit, profitUsd: profit, base: base, diezmo: diezmo, tercero: tercero,
      neto: round2(profit - diezmo - tercero),
      scenario: {
        originMode: originMode, destMode: destMode,
        vesSafetyPct: vesSafetyPct, destSafetyPct: destSafetyPct,
        referenceAmountUsd: refAmount, useActualAmount: useActual
      },
      rateInfo: {
        originScenarios: scenarios,
        destScenarios: scenarios,
        adUsed: sOrig.originAd,
        originRate: rateOrigin, destRate: rateDest,
        quotedRate: quotedRate,
        effectiveRate: round2(delivered / depositVal),
        marketRate: marketRate,
        profitCommission: profit,
        profitSafety: round2(depositVal * (marketRate - quotedRate)),
        safetyPct: (isVESOrigin ? vesSafetyPct : 0) + (isVESDest || isVESOrigin ? destSafetyPct : 0)
      }
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
      caseMeta.vesSafetyPct = q.scenario.vesSafetyPct;
      caseMeta.destSafetyPct = q.scenario.destSafetyPct;
      caseMeta.effectiveRate = q.rateInfo.effectiveRate;
      caseMeta.rateInfo = {
        originRate: q.rateInfo.originRate, destRate: q.rateInfo.destRate,
        quotedRate: q.rateInfo.quotedRate, effectiveRate: q.rateInfo.effectiveRate,
        marketRate: q.rateInfo.marketRate, safetyPct: q.rateInfo.safetyPct,
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
