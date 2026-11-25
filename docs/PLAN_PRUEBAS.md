# Plan de pruebas granular — ConsuTasas (rama `feat/ledger-casos`, HEAD `d70e41a`)

Objetivo: dar de alta la app solo cuando todos los casos P0/P1 pasen. Documento de ejecución; no requiere código nuevo salvo lo marcado como gap.

---

## 1. Convenciones

| Convención | Valor |
|---|---|
| **Ejecuta A** | Asistente (Linux): comandos curl/git/node reproducibles |
| **Ejecuta U** | Usuario (Windows): navegador real, interacción UI, móvil |
| **Ejecuta G** | GitHub: Actions, Pages, rama `data`, configuración repo |
| **Ritmo** | **Un ID por mensaje.** Se ejecuta, se registra evidencia, y recién después se pide el siguiente |
| **Evidencia obligatoria** | Cada caso adjunta al menos: captura de pantalla, salida de consola, panel Network, contenido de `localStorage` (`ct_*`), `generatedAt` de `rates.json`, hash de movimiento / `verifyChain`, o `git` sha. Citar cuál aplica |
| **Consola (filtro)** | Los warnings de `contentscript.js` u otros archivos ajenos son de **extensiones del navegador, no de la app**: al evaluar consola, **filtrar solo por `app.js` / `tasas.js` / `engine.js`** (y el HTML propio) |
| **Severidad** | `P0` bloqueante de alta · `P1` debe pasar antes del alta · `P2` deseable, no bloquea |
| **Rollback** | `R-STD` = restaurar backup del paso F0-00 + recargar con `localStorage` limpio (DevTools → Clear site data). Si el caso es de deploy: revertir a la versión previa de `gh-pages` |
| **Backup antes** | **Ningún caso destructivo (import, wipe, deploy, cierre de período) sin export JSON previo** (Histórico → Mes y respaldo → Exportar JSON) guardado fuera del navegador |
| **No deploy sin aprobación** | Los casos marcados ejecuta **G** que modifican `gh-pages`, `data` o `main` requieren aprobación explícita del usuario antes de ejecutarse. **No push** |
| **No inventar tasas** | Los valores esperados se **derivan** del `rates.json` activo (`generatedAt` + campos `sources.bcv.samples`, `pairs[c].ads`, `eurRef`). Prohibido hardcodear tasas: se calculan del snapshot vigente al inicio de la sesión |

## 2. Reglas de ejecución

- **Paso 0 = F0-00** (backup/baseline). Ningún otro caso antes de F0-00.
- **Paso 1 = F1-01 y F0-02** (raw vivo + rates frescos). La frescura se comprueba con el **badge de cabecera `#badge-frescura`** (Reciente/Desactualizado/Caché) y el timestamp **"Última publicación"** de Tasas (o "Snapshot:"/Comprobador → Momento), no con una etiqueta inexistente. Si el snapshot no está fresco, los resultados numéricos de F3/F4/F5 no son válidos: no se ejecutan, se registra.
- Después: **F2 → F3 → F4 → F5 → F6 → F7 → F8 → F9 → F10 → F11**.
- **Regla de parada:** si un caso **P0 o P1 falla (FAIL), SE PARA la secuencia**: no se continúa con más IDs; se registra el fallo con evidencia, se clasifica y se decide corrección antes de reanudar. Un fallo P2 se registra y se continúa. Un caso **BLOQUEADO NO dispara la parada**: se registra el bloqueo (feature/precondición ausente, con evidencia) y se continúa con el siguiente ID.
- Los valores esperados numéricos se escriben como **fórmulas sobre el snapshot** (ej.: `esperado = monto × unitsPerUsdCompra[VES]`), no como constantes.
- Estados por caso: `PENDIENTE / PASS / FAIL / BLOQUEADO` (BLOQUEADO = precondición no cumplida o feature no implementada; se registra y se continúa, ej. F9, F6-08/F6-09/F6-11/F6-12/F6-14).

---

## 3. Matriz de fases

| Fase | Ámbito | Casos |
|---|---|---|
| F0 | Alta / infraestructura crítica | F0-00…F0-06 |
| F1 | Infraestructura de datos | F1-01…F1-09 |
| F2 | Shell y seguridad | F2-01…F2-10 |
| F3 | Tasas | F3-01…F3-13 |
| F4 | Casos | F4-01…F4-12 |
| F5 | Matriz | F5-01…F5-05 |
| F6 | Libro | F6-01…F6-14 |
| F7 | Histórico / fiscal | F7-01…F7-08 |
| F8 | Auditoría / integridad | F8-01…F8-06 |
| F9 | Sync GitHub | F9-01…F9-05 |
| F10 | Resiliencia y entradas hostiles | F10-01…F10-11 |
| F11 | Alta final | F11-01…F11-11 |

> **Conteo de casos:** 111 totales (F0 7 · F1 9 · F2 10 · F3 13 · F4 12 · F5 5 · F6 14 · F7 8 · F8 6 · F9 5 · F10 11 · F11 11); 104 en F1–F11. Nota honesta: el conteo base verificado es **108 totales / 101 en F1–F11** (las estimaciones previas «96» y «97/98» no correspondían al documento); a los 108 se suman **F2-10** (migración v1→v2), **F3-13** (Comprobador) y **F6-14** (cuenta exchange), incorporados por auditoría. `F8-07` **no existe**: F8 = F8-01…F8-06 (no inventar IDs). De los 111, hoy **bloqueados por falta de feature**: F9-01…F9-05 (sync GitHub), F6-08/F6-09/F6-11/F6-12 (UI de aportes/retiros/transferencias, R-13) y F6-14 (UI exchange). Los BLOQUEADO se registran y no detienen la secuencia; solo un FAIL P0/P1 dispara la regla de parada.

---

## F0 — Alta / infraestructura crítica

| ID | Fase | Ejecuta | Precondición | Datos | Pasos | Esperado | Evidencia | Sev | Rollback |
|---|---|---|---|---|---|---|---|---|---|
| F0-00 | F0 | U | App abierta en navegador con libro real | Libro del usuario | Histórico → **Mes y respaldo** → **Exportar JSON** → guardar `consutasas-backup-YYYY-MM-DD.json` fuera del navegador; anotar `verifyChain`=íntegra, nº movimientos, hash de cabeza | Archivo descargado; cadena íntegra | Archivo + captura de cadena | P0 | — (este ES el backup) |
| F0-01 | F0 | G+A | Aprobación de deploy | — | Publicar `webapp/dist` (v2) en `gh-pages`; luego `curl -s https://afvelis.github.io/consutasas/ \| grep -o 'data-tab="[a-z]*"' \| sort -u` | 5 tabs: casos/cuentas/balance/historico/tasas | Salida curl + captura | P0 | Revert `gh-pages` a commit previo |
| F0-02 | F0 | G+A | Aprobación de ejecución de workflow | — | `workflow_dispatch` de `rates.yml`; verificar commit nuevo en rama `data` y `curl raw…/data/rates.json \| grep generatedAt` | `generatedAt` con edad <30 min; commit nuevo en `origin/data` | SHA del commit + salida curl | P0 | — (no destruye nada) |
| F0-03 | F0 | U+A | Decisión de producto sobre dominio | — | Configurar DNS de `consutasas.avelis.dev` (CNAME → `afvelis.github.io`) o retirarlo del alcance; `nslookup` | Resolución OK + Pages 200 con el dominio, o dominio fuera de alcance documentado | nslookup + curl | P0 | Quitar CNAME |
| F0-04 | F0 | G | Repo accesible | — | Crear workflow CI que corra `node webapp/test/{engine,ui,tasas}-tests.js` y `python scripts/validate_rates.py` en push/PR | CI verde en `feat/ledger-casos` | URL de run | P1 | Deshabilitar workflow |
| F0-05 | F0 | U | Backup F0-00 disponible | Archivo backup | Borrar localStorage; importar backup F0-00; verificar movimientos, balances y `verifyChain` | Libro idéntico; cadena íntegra | Capturas antes/después | P1 | R-STD |
| F0-06 | F0 | G+A | F0-02 pasado | — | Definir umbral (ej. >30 min sin `generatedAt` nuevo = alarma) e implementar monitor (workflow chequeador o badge/banner visible persistente) | Alarma dispara en simulación de retraso | Log del monitor | P1 | Deshabilitar monitor |

> **Nota F0-01 vs F11-03 / CI:** F0-01 y F11-03 son el mismo deploy de `webapp/dist` → `gh-pages`; si F0-01 ya terminó en PASS, F11-03 se verifica por referencia (re-chequeo de la URL pública con F11-04). El CI es **F0-04** y no requiere deploy.

## F1 — Infraestructura de datos

| ID | Fase | Ejecuta | Precondición | Datos | Pasos | Esperado | Evidencia | Sev | Rollback |
|---|---|---|---|---|---|---|---|---|---|
| F1-01 | F1 | A | — | — | `curl -sI https://raw.githubusercontent.com/afvelis/consutasas/data/rates.json` | HTTP 200, `content-type` JSON | Salida curl | P0 | — |
| F1-02 | F1 | A | F1-01 | rates.json | `curl -s … \| python -m json.tool \| head` + `validate_rates.py` | `schema=consutasas/rates.v1`; `sources.bcv.status=ok`; pares con `ads` | Salida validator | P0 | — |
| F1-03 | F1 | U | F0-02 | App + Network | Abrir app; Network → petición a `raw…/data/rates.json`; comparar con el `generatedAt` del snapshot: **badge de cabecera `#badge-frescura`** (`webapp/index.html:18`; Reciente <10 min / Desactualizado 10–20 warn, >20 bad / Caché sin red — `app.js` `freshness`+`updateBadge`), **"Última publicación"** (Tasas, `#refresh-label-info`) y **"Snapshot:"** del desglose de Casos | Badge coherente con la edad de `generatedAt` (umbral 10/20 min, fuente bot/cache/local); "Última publicación" = hh:mm UTC de `generatedAt`; "Snapshot:" = fecha/hora UTC + Caracas + fuente | Captura badge + etiqueta + Network | P1 | — |
| F1-04 | F1 | A | F1-02 | rates.json | Inspeccionar `pairs[c].ads` para al menos USD/VES compra y venta | arrays `ads` no vacíos, `available>0` en ≥1 anuncio por lado | Extracto de rates.json | P1 | — |
| F1-05 | F1 | U | F1-02 | rates.json | Pestaña Tasas → bloque EUR ref; si `eurRef` ausente verificar que aparece panel EUR manual | EUR muestra tasa derivada del snapshot o panel manual; sin números inventados | Captura | P2 | — |
| F1-06 | F1 | A | — | — | `curl -sI` al raw (verificar CORS `access-control-allow-origin: *`) | CORS permite fetch desde Pages | Salida curl headers | P1 | — |
| F1-07 | F1 | U | App cargada con tasas | localStorage `ct_rates` | Offline (DevTools) → recargar | Banner "copia guardada hace X"; valores de caché con badge "Caché" | Captura banner | P1 | R-STD |
| F1-08 | F1 | U | F0-02 | Badge bot | Observar badge "Bot: Éxito · hh:mm UTC" tras refresh | Badge visible y con `updated_at` reciente; si API 403 → oculto sin crash (verificar consola) | Captura + consola | P2 | — |
| F1-09 | F1 | U | Tasas cargadas | — | Botón Actualizar con red activa | Re-fetch (Network), sin duplicación de banner; si no hay cambios → "Sin cambios (último HH:MM UTC)" | Network + captura | P2 | — |

## F2 — Shell y seguridad

| ID | Fase | Ejecuta | Precondición | Datos | Pasos | Esperado | Evidencia | Sev | Rollback |
|---|---|---|---|---|---|---|---|---|---|
| F2-01 | F2 | U | URL pública (F0-01) | — | Abrir URL; DevTools consola (filtrar por `app.js`/`tasas.js`/`engine.js`; ignorar `contentscript.js` de extensiones) | Sin errores de la app; motor inicializado | Captura consola filtrada | P0 | — |
| F2-02 | F2 | U | F2-01 | — | Recorrer las 5 tabs: Casos, Cuentas, Balance, Histórico, Tasas | Cada tab renderiza contenido (sin "pendiente"); estado en `sessionStorage ct_tab` se conserva al recargar | Capturas por tab | P0 | — |
| F2-03 | F2 | A+U | URL pública | — | Ver meta CSP del HTML servido; intentar fetch bloqueado (ej. fetch a dominio no listado en consola) | CSP `default-src 'self'`, `connect-src` solo raw+api.github, `worker-src 'self' blob:`; fetch externo bloqueado | Consola con bloqueo CSP | P1 | — |
| F2-04 | F2 | A | — | dist | `grep -c "<script" webapp/dist/index.html` y revisar `app.js/tasas.js` | Sin scripts inline; todo `script-src 'self'` | Salida grep | P1 | — |
| F2-05 | F2 | U | F2-01 | — | Usar la app 5 min (tabs, casos, refresh) | **Sin ningún `console.error`** de la app (filtrar consola por `app.js`/`tasas.js`/`engine.js`; los warnings de `contentscript.js` son de extensiones del navegador y no cuentan) | Consola filtrada limpia | P1 | — |
| F2-06 | F2 | U | URL pública | Móvil real o DevTools 375 px | Recorrer 5 tabs en viewport móvil | Sin overflow horizontal; botones navegables | Capturas móviles | P1 | — |
| F2-07 | F2 | A+U | URL pública | — | `curl -s URL \| grep robots`; inspeccionar meta en navegador | `noindex, nofollow` presente | Salida grep | P2 | — |
| F2-08 | F2 | U | F2-01 | localStorage | Inspeccionar `ct_settings/ct_accounts/ct_movements/ct_periods/ct_rates/ct_caso` | Claves presentes y JSON válido; sin PII inesperada | Volcado localStorage | P2 | — |
| F2-09 | F2 | A | — | dist | `grep -rn "token\|secret\|api_key" webapp/dist/assets/` | Sin secretos embebidos (token solo si usuario lo ingresa en runtime, nunca en código) | Salida grep vacía | P1 | — |
| F2-10 | F2 | U+A | localStorage con `consumo_operations` v1 (fixture o datos reales) + backup F0-00 | `consumo_operations` | Abrir la app (`engine.js loadAndMigrate` → `migrateLegacyOperations`): verificar que cada operación v1 aparece como movimiento `legacy` con `meta.legacyKey` y `meta.original` (original íntegro); recargar sin limpiar y verificar que **no se duplica** (idempotencia por `legacyKey`); `verifyChain` íntegra; claves nuevas `ct_settings/ct_accounts/ct_movements/ct_periods` creadas y pobladas | Migración 1:1 sin pérdida; recarga idempotente (0 migraciones nuevas, contador de movimientos estable); cadena de hashes íntegra; `ct_*` nuevos poblados | localStorage antes/después + `verifyChain` + nº de movimientos por recarga | P1 | R-STD |

## F3 — Tasas

Precondición global de fase: F0-02 (snapshot fresco). Todos los valores esperados se derivan del snapshot vigente (`generatedAt` anotado en cada evidencia).

| ID | Fase | Ejecuta | Precondición | Datos | Pasos | Esperado | Evidencia | Sev | Rollback |
|---|---|---|---|---|---|---|---|---|---|
| F3-01 | F3 | U | F0-02 | rates.json | Tasas → panel BCV; comparar USD/EUR con `sources.bcv.samples.{usd,eur}` del snapshot | Números idénticos al snapshot; formato es-VE | Captura + extracto rates.json | P1 | — |
| F3-02 | F3 | U | F0-02 | rates.json | Panel P2P Binance/Bybit; comparar con `pairs.VES.ads` y los nº de anuncios `sources.binance.samples.ads`/`sources.bybit.samples.ads` del snapshot (no existe clave `pairs.USD` ni `p2p` en el snapshot: FIATS = VES/PEN/CLP/COP/MXN) | Mejores compra/venta coinciden con top del libro | Captura + rates.json | P1 | — |
| F3-03 | F3 | U | F0-02 | rates.json | Panel Variaciones; comparar con `variations`/prev snapshot (caché `ct_rates_prev`) | Variaciones ±% coherentes con los dos snapshots; sin NaN | Captura | P2 | — |
| F3-04 | F3 | U | F1-02 | rates.json `purchasingPower`/poder compra | Panel poder de compra | Valores derivados del snapshot; sin datos hardcodeados | Captura + cálculo manual | P2 | — |
| F3-05 | F3 | U | F0-02 | rates.json | Panel Multi-pares para cada `meta.fiats` | Solo monedas con tasa en snapshot; filas con compra/venta/mejor de rates.json | Captura | P1 | — |
| F3-06 | F3 | U | F0-02 | rates.json | Panel VES detalle | USD y VES desglosados según snapshot | Captura | P2 | — |
| F3-07 | F3 | U | F0-02 | rates.json `diagnostics` | Panel Diagnóstico | Estado de fuentes (BCV/Binance/Bybit) coincide con `sources.bcv`/`sources.binance`/`sources.bybit` del snapshot; nº de peticiones con `diagnostics` (`binanceRequests`/`bybitRequests`) | Captura | P2 | — |
| F3-08 | F3 | U | F1-04 | rates.json ads | Mejores compra/venta por par vs `pairs[c].ads.compra/venta` ordenados | Best buy/sell = extremos reales del libro, no promedio | Captura + rates.json | P1 | — |
| F3-09 | F3 | U | F1-05 | rates.json `eurRef` | Bloque EUR ref | Si hay `eurRef` → mostrado; si no → panel EUR manual funcional (guardar en `ct_eur_manual`, warning visible) | Captura + localStorage | P1 | R-STD |
| F3-10 | F3 | U | F0-02 | rates.json | Comparar con `generatedAt`: **badge de cabecera `#badge-frescura`** (clase + minutos + fuente), **"Última publicación"** (Tasas, `#refresh-label-info`) y **"Snapshot:"** en Casos / **Comprobador → Momento** (`chk-momento`: Generado UTC/Caracas, antigüedad, origen). El **"Actualizado"** del panel EUR referencial muestra `eurRef.fetchedAt` (tasas.js:188). **Verificar campo/procedencia, no diferencia de valor**: en el snapshot `eurRef.fetchedAt` y `generatedAt` son el **mismo instante UTC** (`build_rates.py:645,360,651`: ambos se sellan con el mismo `generated = datetime.now(timezone.utc)`); la diferencia en pantalla es solo de **zona horaria**: "Actualizado" usa `fmtDate` (app.js:97-104) = hora **LOCAL** del navegador, mientras "Última publicación"/"Snapshot" muestran **UTC** | Badge y timestamps muestran `generatedAt` UTC + `generatedAtCaracas` + fuente (bot/cache/local) exacta; "Actualizado" del EUR = `eurRef.fetchedAt` (fuente real según `eurRef.source`, no es siempre Frankfurter), que **coincide** con `generatedAt` como instante: comparar ambos ISO del extracto rates.json (iguales al segundo); la hora distinta en pantalla solo se explica por local vs UTC | Captura badge + Tasas + Comprobador + extracto rates.json | P1 | — |
| F3-11 | F3 | U | Snapshot con edad 10–20 min y luego >20 min (esperar o simulado); offline para Caché | — | Observar el badge de cabecera `#badge-frescura` con edad 10–20 min, >20 min y en offline | 10–20 min → "Desactualizado" (warn); >20 min → "Desactualizado" (bad); offline → "Caché · X min". Los timestamps ("Última publicación", "Snapshot:") siguen mostrando la hora de publicación real: **solo el badge cambia de estado**; nunca se muestran datos como frescos | Capturas ×3 del badge | P2 | — |
| F3-12 | F3 | U+A | F0-02 + par con ads (ej. PEN) | rates.json | Comparar para el mismo par: **"Mejor compra" del panel Multi-pares de Tasas** (top del libro: `pairs.<X>.mejorCompra`) y las **celdas de la Matriz** (`adRateAt(..., 40, 'best')`, tasas.js:634 — **misma semántica ejecutable a 40 USD eq que Casos**, pero sin comisión) vs **BEST de Casos** (derivado del mismo snapshot: anuncio **ejecutable a 40 USD eq** — filtro min/max/available, criterio conservador: compra = mayor precio ejecutable — **no** el top ad). Cotizar un caso en Casos y comparar | Semántica distinta y verificada: **Tasas (Multi-pares) = mercado sin comisión = lo que tú obtienes** (top del libro); **Matriz = `adRateAt` mejor ejecutable a 40 USD eq, sin comisión** (igual que BEST de Casos, la **única** diferencia con Casos es la comisión); **Casos = cliente, con comisión aplicada**. `securityFactor` solo aparece con tasa manual (factor = (sistema − manual)/sistema × 100); BEST sin manual no muestra factor. Derivar los tres del snapshot (`pairs.<X>.mejorCompra` para Multi-pares; `adRateAt` a 40 USD para Matriz y BEST de Casos); **prohibido hardcodear cifras**. Si el top ad difiere del BEST ejecutable a 40 USD, explicar la diferencia en la evidencia (no es inconsistencia: filtro de ejecutabilidad) | Capturas Tasas/Matriz vs Casos + extracto `pairs.<X>` + cálculo BEST a 40 USD | P2 | — |
| F3-13 | F3 | U | F0-02 | rates.json | Panel **Comprobador**: abrir `chk-momento` (Generado UTC/Caracas, antigüedad del snapshot, origen de lo que ves, fuente), `chk-fuegonacional` e `chk-integridad`; comparar con `generatedAt`/`generatedAtCaracas` del snapshot y con el badge de cabecera | Valores del Comprobador coherentes con el snapshot y con `#badge-frescura` (misma edad/fuente); sin datos inventados; con caché el origen lo indica | Captura Comprobador + extracto rates.json | P2 | — |

## F4 — Casos

Precondición: F2-02, F0-02. Valores esperados derivados del snapshot; cada evidencia anota `generatedAt` y las tasas usadas.

| ID | Fase | Ejecuta | Precondición | Datos | Pasos | Esperado | Evidencia | Sev | Rollback |
|---|---|---|---|---|---|---|---|---|---|
| F4-01 | F4 | U | Tasas cargadas | Par USD/VES | Ejecutar los 4 modos/direcciones del par (me depositan X → entrego Y, y reversos) | Cada dirección cotiza con su tasa correcta (compra en origen, venta en destino según dirección); sin dirección invertida | Capturas ×4 + tasas del snapshot | P0 | R-STD |
| F4-02 | F4 | U | F1-04 | Par con ads | Cambiar escenario origin/dest entre BEST/MAX/AVG/MIN | Cada modo usa la tasa correcta del libro (best conservador, max = mejor para mí, avg = promedio, min = peor); botón muestra tasa al lado | Capturas ×4 | P1 | — |
| F4-03 | F4 | U | F4-02 | Par con ads | Ingresar tasa manual en escenario (origin/dest) | Tasa manual manda (label "manual"); al deseleccionar/preset el manual se limpia (fix d70e41a); sin mezclar manual+sistema | Captura + estado | P1 | — |
| F4-04 | F4 | U | F4-02 | Par USD/VES | Comparar `Factor de seguridad` mostrado vs `securityFactor` del motor (factor = (sistema − manual)/sistema × 100, por lado) | **Solo con tasa manual** se muestra el factor (2 dec) junto al par sistema → manual; sin manual se muestra "Tasa del sistema (sin manual)" y **el BEST no lleva factor** | Captura | P1 | — |
| F4-05 | F4 | U | F4-01 | Comisión | Par en COP → comisión default 8 %; otros pares → 7 %; editar comisión manual (override en el caso; el default se cambia en **Config, al final de Tasas**) | `commissionFor` aplicado: 7 % general, 8 % COP; override respeta rango 0–100; cambio en Config afecta casos nuevos | Captura | P1 | — |
| F4-06 | F4 | U | F4-01 | USD/USD | Par USD/USD (Zelle): forward e inverso, margin `casos-margin` | USDT bruto/neto con margin aplicado; sin tasas FX involucradas | Captura | P1 | — |
| F4-07 | F4 | U | F4-01 | — | Cambiar par/modo tras un caso cotizado | Reset completo: monto, comisión (default del par), manual, resultado limpio; estado persistido en `ct_caso` se restaura al recargar | Capturas antes/después + localStorage | P2 | — |
| F4-08 | F4 | U | F4-01 | — | Cotizar con la app recién abierta (en vivo) y comparar con cotización tras refresh | Consistente con el snapshot activo; etiqueta de fuente correcta ("en vivo"/"bot"/"cache") | Capturas ×2 | P1 | — |
| F4-09 | F4 | U | F4-01 | — | Cotizar caso; recargar página | Par, modo, modos de escenario y tasas manuales restaurados desde `ct_caso` | Captura + localStorage | P2 | — |
| F4-10 | F4 | U | Backup F0-00 | Caso válido | Registrar operación; verificar movimiento en Histórico, cuentas y balance actualizados | Movimiento `#seq` creado con toast; ledger guardado en localStorage | Captura + hash del movimiento | P0 | R-STD |
| F4-11 | F4 | U | F1-02 | Par sin ads (o ads insuficientes) | Cotizar con libro de anuncios vacío/no cubriente | Warning explícito "se usa el promedio del snapshot (no se inventan datos)"; nunca tasa fabricada | Captura warning | P1 | — |
| F4-12 | F4 | A+U | F4-10 | Caso con monto M | Recalcular a mano: `esperado = f(monto, tasas snapshot, comisión, securityFactor)` y comparar con la UI; repetir con `verify-casos-playwright.py` | Diferencia = 0 (redondeo a 2 dec) | Script + captura | P0 | — |

## F5 — Matriz

| ID | Fase | Ejecuta | Precondición | Datos | Pasos | Esperado | Evidencia | Sev | Rollback |
|---|---|---|---|---|---|---|---|---|---|
| F5-01 | F5 | U | Tasas cargadas | Par USD/VES | Ver filas laterales de la matriz (pares listados) | Todas las filas corresponden a `settings.pairs`+`customPairs`; sin pares duplicados | Captura + localStorage | P1 | — |
| F5-02 | F5 | U | F5-01 | Matriz | Verificar columnas compra/venta por fila vs snapshot | Cada celda = tasa del snapshot (mejores), sin comisión aplicada a celdas laterales | Captura + rates.json | P1 | — |
| F5-03 | F5 | U | F5-01 | Matriz | Conmutar los 4 modos de escenario afectando la matriz | Modos BEST/MAX/AVG/MIN recalculan celdas de forma consistente con F4-02 | Capturas ×4 | P1 | — |
| F5-04 | F5 | U | F5-02 | Comisión 0 % | Comparar celdas de matriz con comisión default vs sin comisión | Filas laterales SIN comisión (fix 938c5e2); números exactos del libro | Captura | P1 | — |
| F5-05 | F5 | U | F5-01 | Móvil 375 px | Matriz en viewport móvil | Scroll horizontal controlado; celdas legibles; sin solapamiento | Captura móvil | P2 | — |

## F6 — Libro

> **Nota de auditoría (AUDITORIA.md R-13):** el motor ya soporta `contribution`/`withdrawal`/`transfer` (`engine.js:40`, `:1124-1125`), pero la UI **no tiene control** para crear ninguno de los tres (solo filtro de visualización `hist-tipo` en Histórico; Cuentas solo permite Agregar cuenta / Editar apertura). Los casos F6-08, F6-09, F6-11 y F6-12 quedan **BLOQUEADO** hasta implementar el formulario de movimientos de capital/transferencias. Un caso **BLOQUEADO se registra y NO dispara la regla de parada** (se continúa con el siguiente ID); solo un FAIL P0/P1 la detiene. La edición de apertura no deja rastro en el libro (ver F6-13).

| ID | Fase | Ejecuta | Precondición | Datos | Pasos | Esperado | Evidencia | Sev | Rollback |
|---|---|---|---|---|---|---|---|---|---|
| F6-01 | F6 | U | Backup F0-00 | Cuenta nueva | Crear cuenta (nombre, moneda USD, tipo bank, país) | Aparece en Cuentas con balance 0; persiste en `ct_accounts` | Captura + localStorage | P1 | R-STD |
| F6-02 | F6 | U | F6-01 | Apertura 1000 | Editar apertura de la cuenta | Balance nativo = apertura; Valor USD = apertura / `unitsPerUsd` del snapshot | Captura + cálculo | P1 | — |
| F6-03 | F6 | U | F4-10 | Caso con cuentas in/out | Registrar caso con cuenta de depósito y de entrega | Movimiento acredita en cuenta in y debita en cuenta out; balances actualizados | Captura balances | P0 | R-STD |
| F6-04 | F6 | U | F6-03 | — | Balance → cuadre global | Activos − Pasivos = Patrimonio; badge "Cuadre" | Captura + números | P0 | — |
| F6-05 | F6 | U | F4-10 | Caso con diezmo/tercero | Balance → Pasivos | Diezmo + tercero acumulados = suma de `meta.case.{diezmo,tercero}` de movimientos | Captura | P1 | — |
| F6-06 | F6 | U | Tasas de dos momentos | Balance por moneda | Comparar valoración de movimientos vs tasas actuales por moneda | `fxDiff` por moneda explicado; sin fxDiff cuando las tasas no cambiaron | Captura | P2 | — |
| F6-07 | F6 | U | Cuentas con países | Balance → Distribución | Agrupación por país+moneda con valor USD cuando hay tasa | Sumas correctas; "— sin tasa —" si falta la moneda | Captura | P2 | — |
| F6-08 | F6 | U | F6-01 | Aporte externo | Registrar aporte/retiro externo (contraparte "— externo —") | Balance del libro cambia sin crear pasivo ni plusvalía. **Actual: sin UI para aportes/retiros → BLOQUEADO** (R-13; ver nota de fase y F6-11/F6-12); se registra y se continúa | Captura | P1 | — |
| F6-09 | F6 | U | Dos cuentas misma moneda | Transferencia | Registrar transferencia entre cuentas | Entra y sale simétricos; suma total inalterada. **Actual: sin UI para crear transferencias → BLOQUEADO** (R-13; el filtro `hist-tipo: transfer` existe pero nada genera movimientos de ese tipo desde la UI); se registra y se continúa | Captura | P1 | R-STD |
| F6-10 | F6 | U+A | F1-05 (eurRef presente en Tasas) | Cuenta EUR con saldo | Cuentas → cuenta en EUR con saldo >0; comparar su "Valor USD" con `eurRef` del snapshot usado en Tasas | **Hallazgo observado por el usuario:** EUR aparece "— sin tasa —" en Cuentas pese a que Tasas muestra eurRef. Verificar valoración EUR: si `buildFx` no propaga `eurRef` a `unitsPerUsd.EUR`, es bug (P1); si es comportamiento intencional (solo eurRef informativo), documentar la semántica y al menos mostrar el valor derivado de eurRef como informativo. No debe haber inconsistencia entre lo que Tasas dice y lo que Cuentas valora | Capturas Tasas (eurRef) vs Cuentas (sin tasa) + extracto rates.json `eurRef` | P1 | R-STD |
| F6-11 | F6 | U | Cuenta existente con saldo conocido (F6-01) | Aporte de capital | Cuentas → acción/formulario de aporte de capital: cuenta, fecha, monto y contraparte "— externo —" | Se crea movimiento tipo `contribution` (solo entrada); saldo y equity de la cuenta aumentan el monto sin crear pasivo ni plusvalía; movimiento nuevo con `hash` encadenado a `prevHash` y `verifyChain` íntegra. **Actual: no existe control en la UI → BLOQUEADO** (R-13) hasta implementar el formulario de aportes/retiros; se registra y se continúa | Captura + hash del movimiento | P1 | R-STD |
| F6-12 | F6 | U | Cuenta con saldo ≥ monto (F6-01/F6-11 tras darse de alta la feature) | Retiro de capital | Cuentas → acción/formulario de retiro de capital: cuenta, fecha, monto ≤ saldo y contraparte "— externo —"; además, intentar un retiro mayor al saldo | Se crea movimiento tipo `withdrawal` (solo salida); saldo y equity de la cuenta disminuyen el monto; retiro con monto > saldo rechazado con mensaje claro (validación de saldo suficiente); `hash` encadenado y `verifyChain` íntegra. **Actual: BLOQUEADO** (R-13) hasta implementar el formulario de aportes/retiros; se registra y se continúa | Captura + hash del movimiento + captura del rechazo | P1 | R-STD |
| F6-13 | F6 | U | Cuenta con apertura y saldo (F6-02) | Cuenta existente | Anotar número de movimientos, hash de cabeza y saldo; editar la apertura de la cuenta; revisar Cuentas, Balance e Histórico | Cambia solo el campo `opening` de la cuenta (saldo derivado); **no** se crea ningún movimiento (contador y cadena de hashes sin cambios); la edición de apertura **no** debe usarse como sustituto de aporte/retiro de capital (no deja rastro en el libro, ver R-13); si el flujo de capital depende de editar apertura, es el gap R-13 | Capturas antes/después + localStorage `ct_accounts` + hash de cabeza | P2 | R-STD |
| F6-14 | F6 | U | Cuenta existente (F6-01) | Cuenta tipo `exchange` | Crear/editar cuenta con tipo **exchange** (`webapp/index.html:150` y `:206` solo lo ofrecen como opción del formulario/etiqueta) y operar con ella (caso + balance) | El `kind: exchange` existe solo como opción del formulario y su etiqueta; **no hay UI ni flujo específico de exchange** (p. ej. conversión propia de la casa). **Actual: BLOQUEADO** (feature exchange sin UI; mismo patrón de gaps de UI que R-13); se registra y se continúa | Captura cuenta + localStorage | P2 | — |

## F7 — Histórico / fiscal

| ID | Fase | Ejecuta | Precondición | Datos | Pasos | Esperado | Evidencia | Sev | Rollback |
|---|---|---|---|---|---|---|---|---|---|
| F7-01 | F7 | U | Operaciones registradas | Varias ops | Histórico → base (plusvalía) por filtros mes/año/país/tipo | Suma `meta.case.base` = base mostrada; filtros combinables | Captura | P1 | — |
| F7-02 | F7 | U | F7-01 | — | Verificar diezmo = 10 % de base | Diezmo acumulado = 0.10 × base (tolerancia redondeo por op) | Captura + cálculo | P0 | — |
| F7-03 | F7 | U | F7-01 | — | Verificar tercero = 25 % | Tercero acumulado = 0.25 × base; casilla tercero afecta registro | Captura + cálculo | P0 | — |
| F7-04 | F7 | U | F7-01 | — | Neto para mí = base − diezmo − tercero | Identidad se cumple en estadísticas | Captura | P1 | — |
| F7-05 | F7 | U | Cuentas con países | Estadísticas | Capital por país valorado con tasas del snapshot | Capital USD por país = suma saldos / `unitsPerUsd`; "— sin tasa —" donde falte | Captura | P2 | — |
| F7-06 | F7 | U | Movimientos de ≥2 meses | Cierre | Cerrar un mes con confirm | Período queda "cerrado" en selector; movimiento posterior de ese mes es rechazado | Captura + toast error | P1 | R-STD |
| F7-07 | F7 | U | Backup F0-00 | Export JSON + CSV | Histórico → **Mes y respaldo** → Exportar JSON y Exportar CSV; borrar localStorage; **Importar JSON** (mismo bloque) | CSV legible; import restaura libro íntegro (ver F0-05); cadena íntegra tras import | Archivos + capturas | P1 | R-STD |
| F7-08 | F7 | U | Período cerrado (F7-06) | Mov. en mes cerrado | Intentar registrar caso con fecha en mes cerrado | Bloqueado con mensaje claro; libro sin cambios | Captura | P1 | — |

## F8 — Auditoría / integridad

| ID | Fase | Ejecuta | Precondición | Datos | Pasos | Esperado | Evidencia | Sev | Rollback |
|---|---|---|---|---|---|---|---|---|---|
| F8-01 | F8 | U | Movimientos ≥2 | — | Histórico → cadena de hashes | "✔ Cadena de hashes: íntegra"; `prevHash[n] = hash[n−1]` verificable en UI | Captura + hash de cabeza | P0 | — |
| F8-02 | F8 | U | Backup F0-00 | Tamper | Editar un movimiento en localStorage (DevTools, import monto alterado) → recargar | "⚠ Cadena ALTERADA" detectada | Captura antes/después | P0 | R-STD |
| F8-03 | F8 | U | F8-01 restaurado | — | Reimportar backup F0-00; verificar cadena | Íntegra de nuevo | Captura | P0 | — |
| F8-04 | F8 | U | F8-01 | — | Botón Manifiesto | JSON con cabezas por período/nº movimientos coherente con el libro | Captura + JSON | P1 | — |
| F8-05 | F8 | U | F7-06 | Período cerrado | Manifiesto + cadena tras cierre | El cierre queda sellado en la cadena; movimientos del período cerrado inmutables (no editables) | Captura | P1 | — |
| F8-06 | F8 | A | — | localStorage | Intentar editar `hash` de un movimiento directamente | Al recargar, `verifyChain` falla visiblemente (inmutabilidad efectiva) | Volcado + captura | P1 | R-STD |

## F9 — Sync GitHub

> **Nota de auditoría (AUDITORIA.md §3):** `webapp/assets/app.js` **no implementa** publish/pull/conflicto con GitHub hoy. Los casos F9 quedan **BLOQUEADO** hasta que la feature exista. Registrar el gap y decidir si es requisito de alta o post-alta.

| ID | Fase | Ejecuta | Precondición | Datos | Pasos | Esperado | Evidencia | Sev | Rollback |
|---|---|---|---|---|---|---|---|---|---|
| F9-01 | F9 | U | Feature implementada + backup | Libro local | Publish del libro a GitHub (rama/gist) con token del usuario | Libro publicado; commit visible; token **no** persistido en claro | Commit sha + localStorage | P1 | Borrar artefacto remoto |
| F9-02 | F9 | U | F9-01 | Otro dispositivo | Pull del libro en dispositivo limpio | Libro descargado = publicado; cadena íntegra | Captura | P1 | R-STD |
| F9-03 | F9 | U | F9-01 en 2 dispositivos | Cambios divergentes | Editar en ambos; pull en uno | Conflicto detectado y resuelto sin pérdida silenciosa (elegir versión / merge rechazado con aviso) | Capturas | P1 | R-STD |
| F9-04 | F9 | U | F9-01 | Token inválido | Publicar con token revocado | Error claro, sin crash, sin datos parciales remotos | Captura | P1 | — |
| F9-05 | F9 | U | F9-01 | Remoto más nuevo | Editar local viejo; pull | Aviso "remoto más nuevo" (comparación por `newer`); no sobrescribe sin confirmación | Captura | P1 | R-STD |

## F10 — Resiliencia y entradas hostiles

| ID | Fase | Ejecuta | Precondición | Datos | Pasos | Esperado | Evidencia | Sev | Rollback |
|---|---|---|---|---|---|---|---|---|---|
| F10-01 | F10 | U | Tasas cargadas | — | Offline → operar casos y recargar | App funciona con caché `ct_rates` + banner de antigüedad; sin crash | Captura | P1 | R-STD |
| F10-02 | F10 | U | `ct_rates` viejo (forzar `fetchedAt` antiguo) | — | Recargar sin red | Banner "Sin conexión… datos guardados hace X"; badge Caché; nunca "Reciente" | Captura | P1 | R-STD |
| F10-03 | F10 | U | F10-01 | — | Reconectar (online event) | Auto-refresh al volver la red; banner desaparece; `updateSource` actualizado | Captura + Network | P1 | — |
| F10-04 | F10 | U | `ct_rates` corrupto (JSON roto) | — | Recargar sin red | Fallback a `ct_rates_prev` o mensaje claro; sin valores inventados | Captura + consola | P1 | R-STD |
| F10-05 | F10 | U | Backup | localStorage corrupto (`ct_movements` inválido) | Recargar | Estado inicial o error controlado; sin datos mezclados; recuperación vía import | Captura | P1 | R-STD |
| F10-06 | F10 | U | Backup | Import JSON inválido / de otra app | Histórico → Importar | "JSON inválido" o "Respaldo rechazado"; libro sin cambios | Captura | P1 | R-STD |
| F10-07 | F10 | U | localStorage lleno (cuota simulada) | Libro grande | Registrar operación con cuota excedida | Error capturado y mostrado; sin pérdida silenciosa del libro | Captura | P2 | R-STD |
| F10-08 | F10 | U | — | Cambiar timezone del SO | Operar y revisar fechas/mes | Fechas en fecha local correcta; períodos agrupan según fecha de movimiento, no UTC desplazado | Captura | P2 | — |
| F10-09 | F10 | U | Tasas cargadas | Montos con muchos decimales (0.00001, 1.999999) | Cotizar y registrar | Redondeos consistentes (2 dec en entregas; 4 en tasas); sin flotación visible | Captura | P2 | — |
| F10-10 | F10 | U | Backup | Montos: 999999999, −100, 0, NaN (`"abc"`) | Cotizar/registrar cada uno | Negativos/0/NaN/inválidos rechazados con mensaje; grande no rompe formato | Capturas ×4 | P1 | R-STD |
| F10-11 | F10 | U | — | XSS: nombre de cuenta `<img src=x onerror=alert(1)>`, obs con `<script>` | Crear cuenta/nota y recorrer tabs | Renderizado como texto (escapado); sin ejecución; consola filtrada por `app.js`/`tasas.js`/`engine.js` limpia (warnings de `contentscript.js` = extensión, no cuentan); CSP como segunda barrera | Captura + consola filtrada | P1 | R-STD |

## F11 — Alta final

| ID | Fase | Ejecuta | Precondición | Datos | Pasos | Esperado | Evidencia | Sev | Rollback |
|---|---|---|---|---|---|---|---|---|---|
| F11-01 | F11 | A | Árbol limpio | — | `webapp/build.sh` (build de v2) | Build exit 0; artefacto en `webapp/dist` | Log | P0 | — |
| F11-02 | F11 | A | F11-01 | dist | Verificar `webapp/dist/index.html` = v2 (5 tabs, CSP, noindex) y **sin** `webapp/data/` co-deployado | Artefacto correcto; sin rates local dentro | grep + listing | P1 | — |
| F11-03 | F11 | G | Aprobación del usuario | — | Deploy de `webapp/dist` → `gh-pages` (sin push sin aprobación) | Pages 200 con v2 | curl + captura | P0 | Revert gh-pages |
| F11-04 | F11 | U+A | F11-03 | — | Verificar URL pública `https://afvelis.github.io/consutasas/` (y dominio si F0-03 ok) | 200 HTTPS; contenido v2; cert válido | curl -sI + navegador | P0 | — |
| F11-05 | F11 | U | F11-03 | — | Sesión completa en la URL pública (todas las fases críticas spot-check) | Sin errores; tasas cargan del raw | Consola limpia | P0 | — |
| F11-06 | F11 | A | F11-03 | — | Cache headers de Pages: recarga con cache-bust y verifica `generatedAt` actualizado tras refresh | Recursos servidos con caché razonable; rates siempre frescos vía `cache:"no-store"` | Network | P1 | — |
| F11-07 | F11 | A | F11-03 | — | `curl -s URL \| grep robots` | `noindex, nofollow` en producción | Salida | P2 | — |
| F11-08 | F11 | U | — | Backup final | Export JSON post-alta y guardarlo | Backup vigente de producción | Archivo | P0 | — |
| F11-09 | F11 | G | Aprobación | — | Procedimiento de rollback documentado y probado (revert de gh-pages una vez) | Rollback ejecutable en <10 min | Log | P1 | — |
| F11-10 | F11 | G+A | F0-06 | — | Monitor activo sobre producción | Monitor reporta estado OK del bot en la URL pública | Log/captura | P1 | — |
| F11-11 | F11 | A | Todo lo anterior | — | Actualizar `docs/AUDITORIA.md` (re-auditoría post-fixes) y marcar veredicto | Auditoría actualizada con veredicto LISTO solo si P0/P1 = PASS | Doc | P0 | — |

---

## 4. Registro de ejecución

| ID | Estado | Fecha | Ejecutado por | Evidencia | Notas |
|---|---|---|---|---|---|
| F0-00 | PENDIENTE | — | — | — | Paso 0 obligatorio |
| F1-01 | PENDIENTE | — | — | — | Paso 1 (junto a F0-02) |
| F0-02 | PENDIENTE | — | — | — | Paso 1 (junto a F1-01) |
| (resto) | PENDIENTE | — | — | — | Tras F2 en orden de fase |

> Mantener esta tabla actualizada: **un ID por mensaje**, estado + evidencia enlazada. Si un P0/P1 = FAIL → parar y registrar antes de continuar.
