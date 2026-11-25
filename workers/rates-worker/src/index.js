/**
 * Cloudflare Worker para consutasas-rates (v0.1.0).
 * Sin secretos y sin KV/cron; revisa /debug/sources para el estado de las fuentes externas.
 */

/**
 * Publicación oficial del BCV (comprueba TLS/geobloqueo desde el Worker).
 * UA calcada de _UA_CHROME en scripts/build_rates.py.
 */
const BCV_URL = 'https://www.bcv.org.ve/';
const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Endpoints públicos de dolarapi.com y frankfurter.app (sin parámetros de usuario). */
const SOURCE_URLS = {
  'dolarapi-dolares': 'https://ve.dolarapi.com/v1/dolares',
  'dolarapi-euros': 'https://ve.dolarapi.com/v1/euros',
  'frankfurter-eur-usd': 'https://api.frankfurter.app/latest?from=EUR&to=USD',
};

/** URL fija del libro P2P de Binance (calcada de BINANCE_URL en scripts/build_rates.py). */
const BINANCE_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
/** URL fija del libro P2P de Bybit (calcada de BYBIT_URL en scripts/build_rates.py). */
const BYBIT_URL = 'https://api2.bybit.com/fiat/otc/item/online';

/** Headers calcados de HEADERS_BINANCE en scripts/build_rates.py. */
const HEADERS_BINANCE = { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' };
/** Headers calcados de HEADERS_BYBIT en scripts/build_rates.py. */
const HEADERS_BYBIT = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Encoding': 'gzip, deflate',
  'Accept-Language': 'es-ES,es;q=0.9',
  'Origin': 'https://www.bybit.com',
  'Referer': 'https://www.bybit.com/es-ES/p2p/buy/USDT/VES',
  'User-Agent': UA_CHROME,
};

/** Fiat fijo del diagnóstico P2P (FIATS[0] en scripts/build_rates.py) y página/rows calcadas (PAGES[1], ROWS). */
const P2P_FIAT = 'VES';
const P2P_PAGE = 1;
const P2P_ROWS = 20;

/** Payload calcado de _peticion_binance en scripts/build_rates.py; tradeType BUY/SELL según el lado. */
function binancePayload(tradeType) {
  return {
    asset: 'USDT',
    fiat: P2P_FIAT,
    tradeType,
    page: P2P_PAGE,
    rows: P2P_ROWS,
    payTypes: [],
    proMerchantAds: false,
    shieldMerchantAds: false,
    publisherType: null,
    classifies: ['mass', 'profession', 'fiat_trade'],
  };
}

/** Payload calcado de _peticion_bybit en scripts/build_rates.py; side "1"=compra, "0"=vende (form-urlencoded). */
function bybitPayload(side) {
  return {
    userId: '',
    tokenId: 'USDT',
    currencyId: P2P_FIAT,
    side,
    size: String(P2P_ROWS),
    page: String(P2P_PAGE),
    amount: '',
    authMaker: 'false',
    canTrade: 'false',
    itemRegion: '2',
  };
}

/**
 * 4 pruebas fijas de /debug/p2p (sin URLs ni parámetros de usuario).
 * Bybit usa form-urlencoded (requests data= en build_rates.py), por eso URLSearchParams;
 * el content-type lo añade fetch al serializar, pero lo fijamos explícito porque
 * el body se pasa como string (requests añade application/x-www-form-urlencoded).
 */
const P2P_PROBES = [
  {
    name: 'binance-buy',
    url: BINANCE_URL,
    method: 'POST',
    headers: HEADERS_BINANCE,
    body: JSON.stringify(binancePayload('BUY')),
  },
  {
    name: 'binance-sell',
    url: BINANCE_URL,
    method: 'POST',
    headers: HEADERS_BINANCE,
    body: JSON.stringify(binancePayload('SELL')),
  },
  {
    name: 'bybit-buy',
    url: BYBIT_URL,
    method: 'POST',
    headers: { ...HEADERS_BYBIT, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(bybitPayload('1')).toString(),
  },
  {
    name: 'bybit-sell',
    url: BYBIT_URL,
    method: 'POST',
    headers: { ...HEADERS_BYBIT, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(bybitPayload('0')).toString(),
  },
];

const DEBUG_TIMEOUT_MS = 8000;
const DEBUG_PREVIEW_CHARS = 300;

/** AbortController + setTimeout (APIs web estándar, sin APIs de Node); el llamador debe invocar cancelTimeout tras leer el body o en finally. */
function createTimeoutSignal() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout 8s')), DEBUG_TIMEOUT_MS);
  return { signal: controller.signal, cancelTimeout: () => { clearTimeout(timer); } };
}

/**
 * Modelo de resultados de /debug/sources y /debug/p2p (fuentes del Worker, salida de diagnóstico;
 * no contiene secretos ni URLs controladas por el usuario).
 */
/** @typedef {{name: string, url: string, method: string, ok: boolean|null, status: number|null, ms: number, contentType: string|null, error: string|null, preview: string|null}} SourceResult */

/** @returns {Promise<SourceResult>} */
async function probeSource(name, url, { headers, method = 'GET', body } = {}) {
  const startedAt = Date.now();
  const { signal, cancelTimeout } = createTimeoutSignal();
  try {
    const response = await fetch(url, {
      method,
      signal,
      redirect: 'follow',
      ...(headers ? { headers } : {}),
      ...(body ? { body } : {}),
    });
    let preview = null;
    let previewError = null;
    try {
      // El timeout de 8s cubre también la lectura del body (response.text()).
      const bodyText = await response.text();
      preview = bodyText.slice(0, DEBUG_PREVIEW_CHARS);
    } catch (err) {
      previewError = `preview_no_disponible: ${shortError(err)}`;
    }
    // ms mide el ciclo completo fetch+lectura del body (no solo TTFB).
    const ms = Date.now() - startedAt;
    return {
      name,
      url,
      method,
      ok: response.ok,
      status: response.status,
      ms,
      contentType: response.headers.get('content-type'),
      error: previewError,
      preview,
    };
  } catch (err) {
    return {
      name,
      url,
      method,
      ok: null,
      status: null,
      ms: Date.now() - startedAt,
      contentType: null,
      error: shortError(err),
      preview: null,
    };
  } finally {
    cancelTimeout();
  }
}

/** Mensaje corto y sin secretos a partir de un error desconocido. */
function shortError(err) {
  const base = (err && err.message) || String(err);
  const causeMessage = err && err.cause && err.cause.message;
  const message = causeMessage ? `${base} (${causeMessage})` : base;
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

const VERSION = '0.1.0';

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Preflight CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          'Cache-Control': 'no-store',
        },
      });
    }

    if (request.method === 'GET' && (pathname === '/health' || pathname === '/health/')) {
      return jsonResponse({
        ok: true,
        service: 'consutasas-rates',
        version: VERSION,
        now: new Date().toISOString(),
      });
    }

    if (request.method === 'GET' && (pathname === '/rates.json' || pathname === '/rates.json/')) {
      return jsonResponse({
        schema: 'consutasas/rates.v1',
        generatedAt: null,
        meta: {
          schemaVersion: 2,
          source: 'worker-scaffold',
        },
        message: 'scaffold sin datos reales',
      });
    }

    if (request.method === 'GET' && (pathname === '/debug/sources' || pathname === '/debug/sources/')) {
      // Sin URLs controladas por el usuario: 4 destinos fijos, en paralelo, 8s c/u.
      const results = /** @type {SourceResult[]} */ (
        await Promise.all([
          probeSource('bcv', BCV_URL, { headers: { 'User-Agent': UA_CHROME } }),
          ...Object.entries(SOURCE_URLS).map(([name, sourceUrl]) => probeSource(name, sourceUrl)),
        ])
      );
      return jsonResponse({
        generatedAt: new Date().toISOString(),
        results,
      });
    }

    if (request.method === 'GET' && (pathname === '/debug/p2p' || pathname === '/debug/p2p/')) {
      // Sin URLs controladas por el usuario: 4 pruebas fijas VES (Binance/Bybit x BUY/SELL),
      // en paralelo, 8s c/u, patrón de timeout/preview/errores de /debug/sources.
      const results = /** @type {SourceResult[]} */ (
        await Promise.all(P2P_PROBES.map((probe) => probeSource(probe.name, probe.url, probe)))
      );
      return jsonResponse({
        generatedAt: new Date().toISOString(),
        results,
      });
    }

    return jsonResponse(
      { error: 'not_found', path: pathname },
      { status: 404 }
    );
  },
};
