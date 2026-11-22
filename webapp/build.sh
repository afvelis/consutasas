#!/usr/bin/env bash
# ConsuTasas: genera dist/ (producción minificada) desde webapp/.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf dist
mkdir -p dist/assets

# JS: minificar + ofuscar nombres internos
npx --yes terser assets/app.js -c -m -o dist/assets/app.min.js

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

# HTML: mismo markup, apuntando a los *.min.*
sed -e 's|assets/styles.css|assets/styles.min.css|' -e 's|assets/app.js|assets/app.min.js|' index.html > dist/index.html
