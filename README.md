# 💱 ConsuTasas — panel de tasas y registro de operaciones

Herramienta web (uso familiar) **phone-first** que consume el snapshot `rates.json` generado por el bot del repositorio (tasa P2P de **Binance** y **Bybit** contra **BCV**, en **VES, PEN, CLP, COP y MXN**), con calculadora de remesas y registro privado de operaciones.

- `webapp/index.html` = **solo maquetado** (sin `<script>`/`<style>` inline ni `onclick`).
- Lógica en `webapp/assets/app.js` y estilos en `webapp/assets/styles.css` (vanilla, `defer`).
- Producción minificada en `webapp/dist/` → se publica en la rama `gh-pages` (raíz).

**🌐 En vivo:** https://afvelis.github.io/consutasas/
**📦 Datos:** `https://raw.githubusercontent.com/afvelis/consutasas/data/rates.json` (CORS `*`)

---

## 1. Arquitectura

```
webapp/
├── index.html              # maquetado (HTML + <link>/<script defer src>)
├── assets/
│   ├── styles.css          # estilos mobile-first
│   └── app.js              # lógica completa (IIFE, sin dependencias)
├── dist/                   # PRODUCCIÓN (publicada en gh-pages)
│   ├── index.html          # apunta a *.min.*
│   └── assets/{app.min.js, styles.min.css}
├── build.sh                # regenera dist/ (npx terser + minificador CSS propio)
└── test/run-tests.js       # pruebas unitarias + smoke render con DOM simulado
```

- **Bot de tasas** (NO tocar): `.github/workflows/rates.yml` + `scripts/build_rates.py` — cada ~5 min consultan BCV/Binance/Bybit y publican `rates.json` en la rama `data`.
- **UI** (esto): 4 pestañas con navegación inferior; fondo oscuro; entradas grandes con `inputmode="decimal"`.

## 2. Seguridad y privacidad

| Medida | Detalle |
|---|---|
| HTML básico | `index.html` sin scripts/estilos inline ni manejadores inline |
| CSP (`<meta>`) | `script-src 'self'`; `connect-src` solo permite `raw.githubusercontent.com`; `object-src`, `base-uri`, `form-action` en `none` |
| `noindex` | `<meta name="robots" content="noindex, nofollow">` |
| Sanitización | Todo lo interpolado pasa por `esc()`; importación JSON validada (monedas en lista blanca, números finitos, fechas válidas) |
| Datos personales | Historial solo en `localStorage` (`consumo_operations`), por dispositivo; export/import manual |

La minificación no es cifrado; toda la lógica es inspeccionable por diseño y no hay secretos: las APIs del bot son públicas y sin claves.

## 3. Datos del snapshot (schema publicado)

Campos que consume la UI: `generatedAt`, `generatedAtCaracas`, `sources.{bcv,binance,bybit}` (estado/HTTP/`samples`), `pairs.{VES,PEN,CLP,COP,MXN}` (`compra`, `venta`, `spreadPct`, `mejorCompra/Venta`, `mejorSpreadPct`, `muestras`, `promediosPorPagina`, `porPlataforma`), `vesDetail`, `cross` (rutas con % de variación), `variations[]`, `purchasingPower[]`, `diagnostics`, `meta` (pages/rows/fiats), `warnings`.

- **Frescura**: verde **Reciente** < 10 min · amarillo ≥ 10 · rojo > 20 (**Desactualizado**), calculada con `generatedAt`.
- **Auto-refresh** cada 60 s solo si la pestaña está visible (no interrumpe el scroll), `?t=Date.now()` anti-caché.
- **Sin conexión**: usa la copia guardada (`consumo_rates`) e indica honestamente “datos guardados hace X”; nunca inventa tasas (`null` → `—`).

## 4. Pestañas

1. **Tasas**: BCV USD/EUR, P2P Binance/Bybit USD→VES con variación vs BCV (`cross`), `variations` y `purchasingPower`, tarjetas multi-par en rejilla de 2 columnas (VE/PE/CL/COP/MXN), detalle VES (totales, mejores precios, promedios P1/P2, muestras), diagnóstico y avisos del bot; botones **Actualizar** y **Forzar bot** (workflow).
2. **Cálculo**: modos **Integrado** (hacia VES), **Combinado** (desde VES), **Cruzada** (sin VES); monedas VES/PEN/COP/CLP/MXN/USD (sin pares iguales); comisión 5 % (8 % si origen COP); tasa origen = `pairs[from].compra`, destino = `pairs[to].venta`; **USD se asume 1:1 con USDT** (aviso visible). `USDT_bruto = monto/compra`, `USDT_neto = bruto×(1−comisión)`, `resultado = neto×venta`; botón **Registrar en Operaciones** precarga esa pestaña.
3. **Operaciones** (reemplaza TotalizadorRemesasV5): fecha, origen/destino, “lo que sale” + tasa, “lo que entra” + tasa, observación, casilla **Tercero (25 %)**. Cálculo exacto en USD: `costoUSD = sale/saleRate`, `netoUSD = entry/entryRate`, `plusvalia = netoUSD − costoUSD`; si es positiva: base = plusvalía, **diezmo 10 %**, tercero 25 % opcional, neto para mí = plusvalía − diezmo − tercero; si es negativa: base/diezmo/tercero = 0 y el neto para mí es la pérdida en negativo. Filtro por mes, totales separados (ganancias/pérdidas/base/diezmo/tercero/neto), eliminar, exportar CSV/JSON e importar JSON validado sin duplicar. Corrige los bugs del V5: totales desde valores crudos, tasa 0/∞ (divisiones por cero), fechas reales y persistencia por dispositivo.
4. **Comprobador**: `generatedAt` (UTC + Caracas), antigüedad, próximo run estimado (~5 min; Pages añade su propia demora), **SHA-256** del texto crudo (Web Crypto, local), enlaces (JSON crudo, commits de `data`, workflow), estado por fuente (HTTP + muestras), `diagnostics`, `meta`/`warnings` y **Ver insumos** (cross/variations/purchasingPower/promedios prettificados).

La app consulta **únicamente** `raw.githubusercontent.com`; ni Binance, ni Bybit, ni el BCV son llamados desde el navegador.

## 5. Formato de respaldo de operaciones

```json
{
  "version": "1.0",
  "exportedAt": "2026-11-25T10:00:00Z",
  "operations": [
    {
      "fecha": "2026-11-25", "origen": "PEN", "destino": "VES",
      "sale": 25600, "saleRate": 1000, "entry": 95, "entryRate": 3.46,
      "obs": "nombre/tope/nota", "tercero": false
    }
  ]
}
```

Importación: monedas en lista blanca (`VES/PEN/COP/CLP/MXN/USD`), números finitos > 0, fechas `YYYY-MM-DD` válidas; duplicados (fecha + par + montos con ±0,01) se omiten tras confirmación.

## 6. Regenerar producción / probar

```bash
cd webapp && ./build.sh          # genera dist/ (terser + CSS min)
node test/run-tests.js           # pruebas: fórmula exacta, import, render 4 pestañas
python3 -m http.server 8080 --directory dist   # http://localhost:8080
```

## 7. Despliegue

- **gh-pages** = contenido raíz de `webapp/dist/` (Source: gh-pages / (root)).
- **main** = código fuente (`webapp/`, `README.md`) + bot (`scripts/`, `.github/`) + `rates.yml` corre contra `data`/`gh-pages` según su configuración.

## 8. Limitaciones

- Tasas indicativas (P2P); no garantizan ejecución ni disponibilidad de anuncios.
- El workflow corre ~cada 5 min, pero las Pages de GitHub pueden tardar unos minutos en refrescar.
- Historial local, sin autenticación (URL pública por diseño — ver §2).
