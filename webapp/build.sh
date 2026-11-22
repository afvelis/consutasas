#!/usr/bin/env bash
# ConsuTasas: genera dist/ (producción minificada) desde webapp/.
# Standalone: sirve todo con `python3 -m http.server --directory dist` (CSP
# script-src 'self', sin inline) → copia data/rates.json y el motor/módulo Tasas.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf dist
mkdir -p dist/assets dist/data

# JS del núcleo: minificar + ofuscar nombres internos
npx --yes terser assets/app.js -c -m -o dist/assets/app.min.js

# Motor y módulo Tasas: se copian tal cual (assets/engine.js define CTEngine;
# assets/tasas.js se engancha por CT.renderTasas) para mantenerlos auditables.
cp assets/engine.js assets/tasas.js dist/assets/

# Snapshot del bot: local igual que en webapp (./data/rates.json).
cp data/rates.json dist/data/

# CSS: quitar comentarios, espacios, saltos finales (gzip online no lo cambia)
node -e "
const fs = require('fs');
let css = fs.readFileSync('assets/styles.css', 'utf8');
css = css.replace(/\/\*[\s\S]*?\*\//g, '')
         .replace(/\s+/g, ' ')
         .replace(/: \K/g, '')
         .replace(/\s*([{};:,>])\s*/g, '\$1')
         .replace(/;}/g, '}')
         .trim() + '\n';
fs.writeFileSync('dist/assets/styles.min.css', css);
"

# HTML: mismo markup, apuntando a los *.min.* (engine.js / tasas.js conservan su nombre)
sed -e 's|assets/styles.css|assets/styles.min.css|' -e 's|assets/app.js|assets/app.min.js|' index.html > dist/index.html
