# rates-worker (scaffold)

Scaffold de Cloudflare Worker para `consutasas-rates` (v0.1.0).
**No es producción**: endpoints informativos sin datos reales, sin secretos. Las peticiones de `/debug/sources` hacen fetch a 4 URLs fijas externas (BCV, dolarapi, frankfurter) con fines de diagnóstico, sin usar esos datos como fuente productiva.

## Endpoints

- `GET /health` → `{ok:true, service:'consutasas-rates', version:'0.1.0', now:<ISO>}`
- `GET /rates.json` → scaffold `{schema:'consutasas/rates.v1', meta:{schemaVersion:2, source:'worker-scaffold'}, ...}`
- `GET /debug/sources` → diagnóstico de las 4 fuentes fijas (`bcv`, `dolarapi-dolares`, `dolarapi-euros`, `frankfurter-eur-usd`), con `ok`, `status`, `ms`, `preview` (primeros 300 chars) y error por cada una. Timeout de 8s por fuente (incluye la lectura del body). No expone secretos ni URLs controladas por el usuario.
- `GET /debug/p2p` → diagnóstico de 4 pruebas fijas P2P en VES (`binance-buy`, `binance-sell`, `bybit-buy`, `bybit-sell`), mismas métricas y timeout de 8s que `/debug/sources`. Payloads cablados desde `scripts/build_rates.py` (Binance: POST JSON `tradeType` BUY/SELL; Bybit: POST form-urlencoded `side` "1"/"0", page 1, rows/size 20). Sin parámetros de usuario.
- `OPTIONS *` → 204 (CORS preflight)
- Cualquier otra ruta → 404 JSON

Todos los responses incluyen `Access-Control-Allow-Origin: *`, `Cache-Control: no-store` y content-type JSON.

## Deploy opción A — desde el Dashboard (sin tools)

1. Entra al dashboard de Cloudflare → **Workers & Pages**.
2. **Create** → **Worker** (Hello World).
3. Ponle el nombre `consutasas-rates-test` (o el que prefieras para pruebas) y **Deploy**.
4. **Edit code**: borra el código de ejemplo y pega el contenido de [`src/index.js`](./src/index.js).
5. **Deploy** de nuevo.
6. URL de prueba: `https://<tu-subdominio>.workers.dev/health` y `/rates.json`.

## Deploy opción B — con Wrangler (CLI)

Requiere Node 18+ y wrangler (`npx wrangler` funciona sin instalar nada global):

```bash
cd workers/rates-worker
npx wrangler login        # abre el navegador para autenticar tu cuenta
npx wrangler deploy       # usa wrangler.toml: name, main, compatibility_date, workers_dev
```

Tras el deploy, wrangler imprime la URL `https://consutasas-rates-test.<tu-subdominio>.workers.dev`.
Prueba:

```bash
curl -s https://consutasas-rates-test.<tu-subdominio>.workers.dev/health
curl -s https://consutasas-rates-test.<tu-subdominio>.workers.dev/rates.json
```

## Seguridad

⚠️ **Nunca pegues API tokens ni secretos en chats, issues o PRs.** Si usas `CLOUDFLARE_API_TOKEN` localmente, mantenlo en tu entorno y revoca cualquier token expuesto de inmediato.

Este worker **no debe considerarse producción**: no sirve datos reales de tasas y su única conexión externa es diagnóstica vía `/debug/sources` y `/debug/p2p` (URLs fijas calcadas de `scripts/build_rates.py`), sin integrar esas respuestas como datos productivos, y sin estar conectado a KV ni cron.
