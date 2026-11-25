# Auditoría ConsuTasas — rama `feat/ledger-casos`, HEAD `d70e41a`

Fecha de auditoría: verificación sobre el árbol local en `d70e41a` + fuentes remotas (GitHub Pages, rama `data`, DNS).
Alcance: solo lectura. No se modificó código ni se hizo deploy.

---

## 1. Resumen ejecutivo y veredicto de alta

**Veredicto: NO LISTO para alta.**

La aplicación (shell `webapp/dist/index.html` **v2**, motor, tasas, casos, libro) es funcional y está bien cubierta por pruebas unitarias locales (601/601 OK, exit 0). Sin embargo, la **cadena de publicación está rota en tres puntos independientes**:

1. **GitHub Pages sirve la versión v1** (`https://afvelis.github.io/consutasas/` responde 200 con el shell antiguo de 4 tabs), mientras que el artefacto actual es v2 (5 tabs). El usuario de producción no recibe los fixes de `feat/ledger-casos`.
2. **El snapshot de tasas está rancio**: `rates.json` remoto tiene `generatedAt 2026-11-24T22:15:15Z` (>2 h) y la copia local ~53 h; la API de GitHub Actions está rate-limited y **no hay evidencia de cron sano**. Sin tasas frescas, la app calcula con datos desactualizados o cae a caché.
3. **El dominio `consutasas.avelis.dev` no resuelve (NXDOMAIN)**; la única URL viva es la de Pages.

Adicionalmente: sin CI, sin monitor del bot, y el scraper BCV usa `verify=False`.

**Bloqueos de alta (P0):** Pages v1, rates stale sin cron demostrado, dominio NXDOMAIN.
**Condiciones (P1):** root `dist/` v1, sin CI, sin monitor, BCV `verify=False`, `?local=1` en prod, rates local co-deployado, backup solo manual, sin UI de movimientos de capital/transferencias (R-13), EUR referencial publicado pero ignorado por el motor (R-14).

---

## 2. Inventario de componentes

| Componente | Archivo:línea | Rol | Datos que consume | Fallo si… | Tests |
|---|---|---|---|---|---|
| Shell v2 (5 tabs) | `webapp/index.html:26-30` (`casos,cuentas,balance,historico,tasas`) | SPA estática, nav por `data-tab` | — | JS no carga / motor ausente | `ui-tests.js` (203) |
| Shell v1 (dist raíz) | `dist/index.html` | Artefacto viejo co-deployado | — | Se publica por error | ninguno |
| CSP + noindex | `webapp/dist/index.html:6-7` | `default-src 'self'`; `worker-src 'self' blob:`; `connect-src raw/api.github.com`; `script-src 'self'`; robots `noindex, nofollow` | — | CSP bloquea fetch a raw.githubusercontent | `ui-tests.js` (CSP/inline) |
| Motor / estado | `webapp/assets/engine.js:56` `STORAGE_KEYS`; `:202 load`; `:237 save`; `:246 wipe` | Persistencia localStorage (`ct_*`) | localStorage | storage corrupto / cuota llena | `engine-tests.js` (302) |
| Migración v1→v2 | `engine.js:258 migrateLegacyOperations`; `:282 loadAndMigrate` | Lee `consumo_operations` legacy | localStorage legacy | datos legacy mal convertidos | `engine-tests.js` |
| FX builder | `engine.js:304 buildFx` | `unitsPerUsd{,Compra,Venta}` + `warnings` | `rates.json` | snapshot nulo / moneda sin tasa / `eurRef` con claves no reconocidas (R-14) | `engine-tests.js` |
| Cotización escenario | `engine.js:551 rateScenarios`; `:417 adsExecutable`; `:455 adRateAt`; `:673 caseQuoteScenario` | BEST/MAX/AVG/MIN sobre libro de ads | `rates.pairs[c].ads` | ads no cubren monto → fallback media (con warning) | `engine-tests.js` |
| Ejecución de caso | `engine.js:873 commissionFor` (7 % default, 8 % COP); `:1024 executeCase` | Registro de operación, diezmo 10 %, tercero 25 % | ledger + fx | comisión/fiscal mal calculados | `engine-tests.js` |
| Hash chain | `engine.js:79 utf8Bytes`; `:96 sha256Hex`; `:142 canonicalJson`; `:1109 appendMovement`; `:1142 verifyChain` | Integridad del libro | movimientos | tamper / hash inválido | `engine-tests.js` |
| Cierre de período | `engine.js:1252 closePeriod` | Bloquea mes cerrado | periods | movimiento en mes cerrado | `engine-tests.js` |
| Export/Import | `engine.js:1311 exportState`; `:1338 importState`; `engine-tests.js` fixtures | Backup JSON / CSV | archivo local | import inválido aceptado | `engine-tests.js` |
| Carga de tasas | `webapp/assets/app.js:17 RATE_URL (raw…/data/rates.json)`; `:439-454 ratesUrl()` + `?local=1`; `:504 getRates` (caché `ct_rates` TTL 5 min); `:557 refreshRates` | Fetch + caché + fallback | raw.githubusercontent | rate-limit / red caída → banner "copia guardada hace X" | `ui-tests.js` |
| Override `?local=1` | `app.js:439-450` | Fuerza `./data/rates.json` (etiqueta "local (no publicado)") | local | accesible en prod silenciosamente | parcial |
| Estado del bot | `app.js:21 BOT_STATUS_URL (api.github.com …/rates.yml/runs)`; `:22 BOT_STATUS_TTL_MS 5 min`; `:143 refreshBotStatus` | Badge "Bot: Éxito/Fallo" | API Actions | 403 rate-limit → badge oculto, sin alarma | parcial |
| UI tasas | `webapp/assets/tasas.js:169 renderEurRef`; `:196 renderBcv`; `:249 renderP2p`; `:273 renderVariaciones`; `:299 renderMultiPares` | Paneles de tasas | rates.json | eurRef publicado pero ignorado por `buildFx` (R-14); comentario obsoleto en `app.js:324` | `tasas-tests.js` (96) |
| Casos (UI) | `webapp/assets/app.js` (pairKey/modos `modosFor`/`selectPair`, `quoteEscenario`, `registrarCaso`; los nombres minificados `Z()`/`Q()` solo existen en `webapp/dist/assets/app.min.js`) | Cotización y registro; persistencia en `ct_caso`/`ct_eur_manual` | fx + ledger | tasa manual excluida de cotización (fix d70e41a) | `ui-tests.js` + `verify-casos-playwright.py` (817 líneas) |
| Scraper de tasas | `scripts/build_rates.py:265-275` (BCV `verify=False`, fallback `ve.dolarapi.com`); `scripts/validate_rates.py` | Genera `rates.json` | bcv.org.ve, Binance/Bybit P2P | BCV cambia HTML / TLS | `validate_rates.py` |
| Bot GitHub Actions | `.github/workflows/rates.yml` (cron `*/5 * * * *`, push a rama `data`, force-push single commit) | Publica snapshot cada 5 min | — | rate-limit, cron deshabilitado, fallo de scraping | ninguno (sin CI) |
| Rama `data` | `origin/data`, commit `e14b169e` | rates.json publicado | — | force-push rompe caché esperado | — |

---

## 3. Servicios y flujos

| Flujo | Descripción | Estado |
|---|---|---|
| **App estática** | 5 tabs v2 (`webapp/dist`), sin backend, todo en cliente | OK en código; **producción sirve v1** (P0) |
| **Engine** | Estado + ledger en localStorage; engine.js UMD sin dependencias | OK (302 tests) |
| **Tasas** | Fetch raw `data/rates.json`, caché 5 min, fallback caché local con banner | OK lógica; **datos stale** (P0) |
| **Bot GH Actions** | Cron `*/5` en `rates.yml`; badge vía API Actions | **Sin evidencia de ejecuciones sanas**; API rate-limited (P0/P1) |
| **Data branch / raw** | `raw.githubusercontent.com/afvelis/consutasas/data/rates.json` | Vive; commit `e14b169e`; generado `2026-11-24T22:15:15Z` |
| **Túnel** | `?local=1` o `localhost` fuerzan snapshot local; etiqueta "local (no publicado)" | Funcional; riesgo si se filtra a prod (P1) |
| **localStorage** | `ct_settings/ct_accounts/ct_movements/ct_periods` + `ct_rates` + `ct_bot_status` + `ct_caso`/`ct_eur_manual` | OK; sin export automático (backup manual, P1) |
| **Export/Import** | JSON backup + CSV en Histórico; import valida con `importState` | OK (tests) |
| **Sync GitHub** | **No existe** en `app.js` (no hay publish/pull/conflicto/token) | Gap: F9 no ejecutable hasta implementarlo |
| **Hash chain** | SHA-256 propio (`sha256Hex` + `canonicalJson`), `verifyChain` en Histórico | OK (tests) |
| **Monitor** | No hay monitor/alertas del bot ni uptime | Gap (P1) |

---

## 4. Riesgos con evidencia

| ID | Severidad | Riesgo | Evidencia |
|---|---|---|---|
| R-01 | **P0** | **Pages sirve v1**: producción desactualizada, sin fixes de `feat/ledger-casos` | `https://afvelis.github.io/consutasas/` → HTTP 200; HTML = shell v1; rama `gh-pages` no sincronizada con `webapp/dist` |
| R-02 | **P0** | **Rates stale**: cálculos con tasas viejas; cron `*/5` del bot sin ejecuciones demostradas | Remoto `generatedAt 2026-11-24T22:15:15Z` (age >2 h al auditar); local ~53 h; API Actions 403 rate-limited; no evidencia de cron sano |
| R-03 | **P0** | **Dominio NXDOMAIN**: la URL canónica prometida no resuelve | `nslookup consutasas.avelis.dev` → NXDOMAIN; Pages `https://afvelis.github.io/consutasas/` = 200 |
| R-04 | P1 | **Root `dist/index.html` = v1** coexistiendo con `webapp/dist` v2: riesgo de publicar el artefacto equivocado | `dist/index.html` contiene shell v1; `webapp/dist/index.html` = v2 (5 tabs) |
| R-05 | P1 | **Sin CI**: 601 tests solo corren manualmente; regresiones pueden llegar a `main` sin detección | No existe `.github/workflows` de CI (solo `rates.yml`) |
| R-06 | P1 | **Sin monitor**: fallos del bot invisibles para el usuario (badge se oculta en error, no alarma) | `app.js:143 refreshBotStatus` → `r.botStatus=null` y oculta contenedor en fallo |
| R-07 | P1 | **BCV `verify=False`**: scraping sin verificación TLS, expuesto a MitM en la fuente de verdad de USD/EUR | `scripts/build_rates.py:271-275` |
| R-08 | P1 | **`?local=1` en prod**: cualquier visitante remoto puede forzar snapshot local del repo, etiquetado "local (no publicado)" pero con datos posiblemente viejos | `app.js:439-454` |
| R-09 | P1 | **`webapp/data/rates.json` local co-deployado** (~53 h) puede servirse junto al dist si el deploy copia `webapp/` completo | `webapp/data/rates.json:3` `generatedAt 2026-11-22T19:33:39Z` |
| R-10 | P1 | **Backup solo manual**: pérdida de dispositivo = pérdida total del libro; no hay sync GitHub ni auto-backup | Solo `hist-exp-json` manual (`app.js`, botón Histórico) |
| R-11 | P2 | **Sin cobertura visual/rendimiento**: E2E Playwright existe (`verify-casos-playwright.py`) pero no cubre layout móvil, LCP, ni cargas grandes | Sin tests de rendimiento/visual en repo |
| R-12 | P2 | **Preflight con timeout 30 s**: el chequeo previo de la suite tasas abortaba por timeout y dio la falsa impresión de hang; la suite real pasa 96/96 en exit 0 | Ejecución local: `node webapp/test/tasas-tests.js` → `96/96 OK, 0 fallidas`, exit 0 |
| R-13 | P1 | **Sin UI para aportes/retiros/transferencias de capital**: no se puede agregar ni quitar capital (ni transferir entre cuentas) desde la app; las únicas vías son editar la apertura (no deja rastro en el libro ni en la cadena de hashes) o importar un JSON externo | El motor ya soporta los tres tipos: `webapp/assets/engine.js:40` (`MOVEMENT_TYPES` incluye `withdrawal`/`contribution`/`transfer`), `engine.js:1124-1125` (validación: aporte = solo entrada, retiro = solo salida) y `accountBalance`/`balance` los procesan. La UI no ofrece control: `webapp/dist/index.html:201-202` solo tiene el filtro de visualización `hist-tipo`; `index.html:120` y `:135-172` solo permiten **Editar apertura** / **Agregar cuenta** (campo `opening`, no movimiento); `app.js` sin ocurrencias de `contribution`/`withdrawal`/`transfer`/aporte/retiro/transferencia; el único `appendMovement` desde la UI es la migración v1 (`app.js:2046`). Tests del motor sí cubren los tipos (8 refs en `engine-tests.js`); tests de UI no (0 en `ui-tests.js`) **Qué falta para alta:** formulario/acción en Cuentas (o Histórico) para registrar movimientos `contribution`/`withdrawal`/`transfer` (cuenta, fecha, monto, contraparte «— externo —», validación de saldo suficiente en retiros) y casos UI F6-08/F6-09/F6-11/F6-12 (PLAN_PRUEBAS.md) en PASS |
| R-14 | P1 | **EUR referencial publicado pero ignorado por el motor**: `buildFx` lee `eurRef.usdToEur`/`eurToUsd` (`engine.js:328-329`), pero el snapshot publica `eurRef.usd`/`eurRef.ves` (`rates.json`) → `fx.eurRef` queda sin tasa utilizable y EUR no entra en `unitsPerUsd` (cuentas EUR "— sin tasa —" pese a que Tasas muestra el bloque EUR referencial). El comentario de `app.js:324` («el fixture actual del bot no publica eurRef») es obsoleto: el bot sí lo publica, con otras claves | `webapp/data/rates.json` (`eurRef: {usd, ves, vesImplicito, source: frankfurter, …}`); `engine.js:326-337` (descarta el eurRef si `usdToEur`/`eurToUsd` no son finitos positivos); `app.js:324`; hallazgo F6-10 (PLAN_PRUEBAS.md) **Qué falta para alta:** alinear `buildFx` con las claves reales (`usd`/`ves`) o publicar `usdToEur`/`eurToUsd` en el snapshot; retirar/actualizar el comentario obsoleto de `app.js:324`; F6-10 en PASS |

---

## 5. Qué falta para alta

1. **Deploy v2 a Pages** (R-01): publicar `webapp/dist` en `gh-pages` y verificar 5 tabs + CSP en la URL pública.
2. **Rates frescos demostrados** (R-02): correr `rates.yml` manualmente (`workflow_dispatch`), verificar commit nuevo en rama `data` y `generatedAt` reciente; demostrar cron sano durante ≥1 h.
3. **Dominio** (R-03): configurar DNS de `consutasas.avelis.dev` (CNAME a `afvelis.github.io`) **o** retirar el dominio del alcance y comunicar la URL de Pages.
4. **CI** (R-05): workflow que ejecute engine/ui/tasas tests + `validate_rates.py` en cada push/PR.
5. **Monitor del bot** (R-06): alarma (otro workflow o badge visible + banner persistente) cuando `generatedAt` supere un umbral (p. ej. 30 min).
6. **BCV TLS** (R-07): intentar `verify=True` con fallback controlado, o al menos documentar el riesgo aceptado.
7. **`?local=1`** (R-08): desactivar en build de producción (compilado por flag) o limitar a `localhost` real.
8. **No co-deployar rates local** (R-09): excluir `webapp/data/` del artefacto de Pages.
9. **Backup** (R-10): procedimiento documentado + verificado (F0-05) antes del alta.
10. **UI de movimientos de capital/transferencias** (R-13): formulario para `contribution`/`withdrawal`/`transfer`; sin él, F6-08/F6-09/F6-11/F6-12 (PLAN_PRUEBAS.md) quedan BLOQUEADOS.
11. **EUR referencial** (R-14): alinear `buildFx` con `eurRef.usd/ves` del snapshot (o publicar `usdToEur`/`eurToUsd`) y limpiar el comentario obsoleto de `app.js:324`; F6-10 en PASS.
12. **Ejecutar PLAN_PRUEBAS.md** completo; regla de parada ante fallo P0/P1 (un BLOQUEADO se registra y se continúa).

---

## 6. Evidencia y comandos

```bash
# Versión de Pages (v1 = 4 tabs, v2 = 5 tabs)
curl -s https://afvelis.github.io/consutasas/ | grep -o 'data-tab="[a-z]*"' | sort -u
curl -sI https://afvelis.github.io/consutasas/ | head -1          # → HTTP/2 200

# Snapshot remoto y local
curl -s https://raw.githubusercontent.com/afvelis/consutasas/data/rates.json | grep generatedAt
#   → "generatedAt": "2026-11-24T22:15:15Z"
grep '"generatedAt"' webapp/data/rates.json                        # → 2026-11-22T19:33:39Z (~53 h)

# Bot / rama data
gh api repos/afvelis/consutasas/actions/workflows/rates.yml/runs?per_page=1   # → 403 rate-limited
git fetch origin data && git log origin/data --oneline -1          # → e14b169e

# Dominio
nslookup consutasas.avelis.dev                                     # → NXDOMAIN

# Versiones locales
grep -o 'data-tab="[a-z]*"' webapp/dist/index.html | sort -u       # → 5 tabs (v2)
grep -o 'data-tab="[a-z]*"' dist/index.html | sort -u              # → 4 tabs (v1)
grep -o "worker-src[^;]*" webapp/dist/index.html                   # → worker-src 'self' blob:
grep -n 'robots' webapp/dist/index.html                            # → noindex, nofollow

# Pruebas (exit 0 en las tres)
node webapp/test/engine-tests.js   # → ENGINE: 302/302 OK
node webapp/test/ui-tests.js       # → UI: 203/203 OK
node webapp/test/tasas-tests.js    # → TASAS: 96/96 OK
```

Datos verificados: 601 pruebas totales (302+203+96); CSP con `worker-src 'self' blob:`; noindex; sin scripts inline; sin `console.error` en producción; `rates.yml` con cron `*/5 * * * *`.
