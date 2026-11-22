# 💱 ConsuTasas — Calculadora P2P multi-moneda

Herramienta web (uso familiar) que calcula conversiones entre **VES, PEN, COP, CLP, MXN y USD** usando tasas reales de **Binance P2P** y **Bybit P2P**.

- `index.html` = **solo maquetado** (sin lógica ni estilos embebidos).
- Toda la lógica en `assets/app.js` y los estilos en `assets/styles.css`.
- Producción minificada en `dist/` (nombres internos ofuscados).

---

## 1. Seguridad y privacidad (leer)

Esta app se publica en un **repositorio público**, por lo que su código es inspeccionable por cualquiera. Eso es así por diseño y **no compromete datos**, porque:

- **No hay secretos**: las APIs P2P son públicas y no usan claves.
- **No hay backend ni base de datos**: no se envía ni se guarda información en servidores.
- **El historial vive solo en tu navegador** (`localStorage`), por dispositivo. Otros visitantes no lo ven.
- **No hay cookies, analytics ni tracking**.

Medidas implementadas:

| Medida | Detalle |
|---|---|
| HTML básico | `index.html` sin `<script>`/`<style>` inline ni `onclick` |
| Lógica interna | Todo en `assets/app.js`; en producción `dist/assets/app.min.js` (minificado + nombres ofuscados) |
| CSP | `Content-Security-Policy` meta: `script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'` |
| `noindex` | `<meta name="robots" content="noindex, nofollow">` |
| Sanitización | Importación JSON validada: monedas en lista blanca, números finitos, textos escapados (`esc()`) antes de `innerHTML` |
| Exportación segura | JSON/CSV generados localmente; no se suben a ningún sitio |

> ⚠️ **Honestidad técnica:** la minificación **no es cifrado**; solo dificulta la lectura. No existe “seguridad por ocultamiento” en código de cliente. Si necesitas **control de acceso real** (que solo tu familia pueda abrirla), eso requiere autenticación en servidor: GitHub Pages privado (plan Pro/Team), Cloudflare Access, o un hosting con contraseña (Netlify/Vercel). Esta versión **no** incluye login.

---

## 2. Estructura del proyecto

```
webapp/
├── index.html              # maquetado (solo HTML + <link>/<script src>)
├── assets/
│   ├── styles.css          # estilos (fuente legible)
│   └── app.js              # lógica (fuente legible)
├── dist/                   # PRODUCCIÓN (esto se publica)
│   ├── index.html          # apunta a *.min.*
│   └── assets/
│       ├── styles.min.css
│       └── app.min.js
├── build.sh                # regenera dist/ (terser + minificador CSS)
└── README.md
```

Regenerar producción: `./build.sh`

---

## 3. Stack y decisiones

| Componente | Elección | Motivo |
|---|---|---|
| Frontend | HTML + CSS + JS vanilla | Sin frameworks ni build obligatorio; rápido y portable |
| Deploy | GitHub Pages (sitio de usuario) | Gratis, HTTPS, publicado desde `main` |
| Tasas | Binance P2P + Bybit P2P | APIs públicas, 6 fiat, sin auth |
| Caché | `localStorage` (TTL 5 min) | Offline y arranque instantáneo |
| Historial | `localStorage` | Privado por dispositivo; export/import manual |
| PWA | Service Worker (Blob) | App shell offline |

---

## 4. Fuentes de datos

### Binance P2P
`POST https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search`
Body JSON: `asset=USDT`, `fiat=<MONEDA>`, `tradeType=BUY|SELL`, `rows=20`.
Campos: `data[].adv.price`, `minSingleTransAmount`, `maxSingleTransAmount`, `surplusAmount`.

### Bybit P2P
`POST https://api2.bybit.com/fiat/otc/item/online` (form-urlencoded).
Campos: `tokenId=USDT`, `currencyId=<MONEDA>`, `side=1` (comprar USDT) / `side=0` (vender USDT).
Respuesta: `result.items[].price`, `minAmount`, `maxAmount`, `lastQuantity`.

> Bybit puede no permitir CORS desde navegador. La app intenta **directo → corsproxy.io → allorigins.win**. Si todas fallan, usa Binance y marca la fuente como no disponible. No inventa tasas.

### Monedas
| Código | País | Símbolo |
|---|---|---|
| VES | Venezuela | Bs |
| PEN | Perú | S/ |
| COP | Colombia | $ |
| CLP | Chile | $ |
| MXN | México | $ |
| USD | EE.UU. | $ |

---

## 5. Lógica de cálculo

```
USDT_Bruto   = Monto_Origen / Tasa_Compra_Origen
USDT_Neto    = USDT_Bruto × (1 − Comisión%)
Monto_Destino = USDT_Neto × Tasa_Venta_Destino
```

- **Tasa origen** = mejor tasa **COMPRA** USDT (Binance o Bybit).
- **Tasa destino** = mejor tasa **VENTA** USDT (Binance o Bybit).
- **Comisión** = porcentual sobre USDT bruto; default 5% (8% si origen COP); editable 0–100%.

### Modos
| Modo | Descripción |
|---|---|
| 🟢 Integrado | Hacia Venezuela (VES destino) |
| 🔵 Combinado | Desde Venezuela (VES origen) |
| 🟣 Cruzada | Entre países sin VES |

### Casos de referencia (tasas de contexto, no cotización real)
| Caso | Origen→Destino | Monto | Resultado |
|---|---|---|---|
| 1 | PEN→VES | 77 | 21.457,10 Bs |
| 2 | VES→COP | 10.000 | 33.250 COP |
| 3 | PEN→COP | 241 | 200.085,24 COP |

---

## 6. Pantallas

1. **Tasas**: compra/venta por moneda, fuente (Binance/Bybit), frescura (En vivo/Caché/Sin conexión), botón actualizar.
2. **Calculadora**: modo, origen/destino (6 monedas), monto, comisión + auto, desglose completo y frase *“Con X … entregas Y …”*.
3. **Historial**: registros (máx. 100), totales por moneda, export JSON/CSV, import JSON con validación y anti-duplicados, limpiar.

---

## 7. Caché y offline

- Política de caducidad: **5 minutos** (tasa P2P cambia rápido; 5 min equilibra frescura y carga).
- Al volver la conexión se refresca automáticamente (`online` event).
- Offline: se usan datos guardados y se **etiquetan** como caché con su hora; nunca se muestran como “en vivo”.
- Sin datos utilizables: se informa que no puede calcularse; **no se genera un resultado falso**.

---

## 8. Formato export/import

```json
{
  "version": "1.0",
  "exportedAt": "2026-01-01T10:00:00Z",
  "calculations": [
    {
      "fromCurrency": "VES", "toCurrency": "COP",
      "amount": 10000, "commissionPct": 5,
      "rateBuy": { "price": 1136.0, "source": "Binance" },
      "rateSell": { "price": 3269.89, "source": "Bybit" },
      "usdtGross": 8.8028, "usdtNet": 8.3627,
      "resultAmount": 27345.03, "mode": "combined",
      "timestamp": "2026-01-01T10:00:00Z"
    }
  ]
}
```

Import: valida esquema, monedas en lista blanca, números finitos, escapa textos, ignora duplicados (±0,1 %) y pide confirmación antes de combinar.

---

## 9. Rendimiento

- Obtención de tasas: 24 llamadas en paralelo (6 monedas × 2 APIs × 2 lados) → ~3–6 s en red normal.
- Cálculo local: < 1 ms.
- Con caché válida: respuesta < 100 ms.
- Objetivo de cálculo completo < 10 s: **cumplido** (medido por separado).

---

## 10. Despliegue

### Opción A — Sitio de usuario (recomendado, sin tocar Settings)
1. Crear repo **público y vacío** llamado `afvelis.github.io`.
2. Publicar el contenido de `dist/` en la raíz de `main`:
   ```bash
   cd webapp/dist
   git init && git add . && git commit -m "ConsuTasas"
   git branch -M main
   git remote add origin git@github.com:afvelis/afvelis.github.io.git
   git push -u origin main
   ```
3. URL: `https://afvelis.github.io/` (el sitio de usuario publica automáticamente).

### Opción B — Proyecto
1. Crear repo público vacío `consultas-tasas`.
2. Push de `dist/` a la rama `gh-pages`.
3. Settings → Pages → Source: `gh-pages`, `/ (root)`.
4. URL: `https://afvelis.github.io/consultas-tasas/`.

### Local
```bash
cd webapp/dist && python3 -m http.server 8080   # http://localhost:8080
# desarrollo con fuentes legibles:
cd webapp && python3 -m http.server 8080         # http://localhost:8080
```

---

## 11. Evidencia de pruebas

| Prueba | Resultado |
|---|---|
| Fórmula 3 pasos y 3 casos de contexto | ✅ (2 exactos; caso 1 difiere 1,64 Bs por redondeo intermedio del ejemplo) |
| 30 rutas entre 6 monedas | ✅ |
| Casos borde (monto 0/negativo, comisión 0/100, mismo par) | ✅ |
| Sintaxis JS fuente y minificada (`node --check`) | ✅ |
| HTML sin inline script/style/onclick | ✅ |
| CSP aplicada | ✅ |
| Export/Import JSON con validación y duplicados | ✅ |
| Formato es-VE (miles/decimales) | ✅ |
| API Binance/Bybit con datos reales | ✅ (sondeo en vivo de las 6 monedas) |

---

## 12. Limitaciones

- Tasas P2P son **indicativas**; no garantizan disponibilidad ni ejecución.
- CORS de Bybit puede requerir proxy; si no hay fuente, se informa y no se calcula.
- Datos históricos: máx. 100 registros por navegador.
- Sin autenticación: la URL es pública (ver §1).
