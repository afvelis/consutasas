(function () {
  'use strict';

  // ConsuTasas: interfaz sobre el snapshot rates.json publicado en la rama data.
  const CT = {};
  CT.parts = {}; // registro de render por pestaña

  const DATA_URL = 'https://raw.githubusercontent.com/afvelis/consutasas/data/rates.json';
  const WORKFLOW_URL = 'https://github.com/afvelis/consutasas/actions/workflows/rates.yml';
  const LS_RATES = 'consumo_rates';      // { data, fetchedAt }
  const LS_OPS = 'consumo_operations';   // [ operación, ... ]

  // Monedas soportadas por el bot (fiats en pairs). USD no viene del bot: cotiza 1:1.
  const CURRENCIES = {
    VES: { name: 'Bolívar',  symbol: 'Bs',  country: 'Venezuela' },
    PEN: { name: 'Sol',      symbol: 'S/',  country: 'Perú' },
    COP: { name: 'Peso',     symbol: '$',   country: 'Colombia' },
    CLP: { name: 'Peso',     symbol: '$',   country: 'Chile' },
    MXN: { name: 'Peso',     symbol: '$',   country: 'México' },
    USD: { name: 'Dólar',    symbol: 'US$', country: 'EE. UU.' }
  };
  const FIATS = ['VES', 'PEN', 'COP', 'CLP', 'MXN']; // pares publicados por el bot

  CT.const = { DATA_URL, WORKFLOW_URL, LS_RATES, LS_OPS, CURRENCIES, FIATS };

  // ================= 01 · CORE: estado, formato, fetch, caché =================
  const state = { rates: null, fetchedAt: null, fromCache: false, calcDraft: null };
  CT.state = state;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  CT.esc = esc;

  const nf = (min, max) => new Intl.NumberFormat('es-VE', { minimumFractionDigits: min, maximumFractionDigits: max });
  const NF0 = nf(0, 0), NF2 = nf(2, 2), NF4 = nf(2, 4);

  // fmt(v, dec): número con formato es-VE; null/undefined/NaN/Infinity → '—'. Nunca inventa datos.
  function fmt(v, dec) {
    if (v == null || typeof v !== 'number' || !Number.isFinite(v)) return '—';
    if (dec === 0) return NF0.format(v);
    if (dec === 4) return NF4.format(v);
    return NF2.format(v);
  }
  CT.fmt = fmt;

  function fmtMoney(v, code) {
    if (v == null || !Number.isFinite(v)) return '—';
    const c = CURRENCIES[code] || { symbol: code };
    return c.symbol + ' ' + fmt(v, Math.abs(v) >= 1000 ? 2 : 4);
  }
  CT.fmtMoney = fmtMoney;

  function fmtDate(iso, withTime) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('es-VE', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {})
    });
  }
  CT.fmtDate = fmtDate;

  function ageMin(generatedAt) {
    const t = new Date(generatedAt).getTime();
    if (isNaN(t)) return null;
    return Math.max(0, (Date.now() - t) / 60000);
  }
  CT.ageMin = ageMin;

  // freshness(): verde <10 min, amarillo 10–20, rojo >20; desconocido si no hay dato.
  function freshness(generatedAt) {
    const a = ageMin(generatedAt);
    if (a == null) return { cls: 'badge-wait', label: 'Sin datos', min: null };
    if (a < 10) return { cls: 'badge-ok', label: 'Reciente', min: a };
    if (a <= 20) return { cls: 'badge-warn', label: 'Desactualizado', min: a };
    return { cls: 'badge-bad', label: 'Desactualizado', min: a };
  }
  CT.freshness = freshness;

  async function sha256Hex(text) {
    const buf = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  CT.sha256Hex = sha256Hex;

  function banner(kind, msg) {
    const el = document.getElementById('banner');
    if (!msg) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.className = 'banner banner-' + (kind || 'warn');
    el.textContent = msg;
  }
  CT.banner = banner;

  // getRates(): snapshot publicado por el bot. Cache-busting con ?t=Date.now().
  // Guarda consumo_rates { data, fetchedAt }; si falla la red usa la caché indicando su antigüedad.
  async function getRates(opts) {
    const force = !!(opts && opts.force);
    const cached = readCachedRates();
    if (!force && cached && ageMin(cached.fetchedAt) < 5) {
      applyRates(cached);
      return state.rates;
    }
    try {
      const res = await fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      const data = JSON.parse(text);
      const rec = { data, fetchedAt: new Date().toISOString() };
      try { localStorage.setItem(LS_RATES, JSON.stringify(rec)); } catch (e) { /* almacenamiento lleno */ }
      applyRates(rec);
      state.fromCache = false;
      // texto crudo, base del SHA-256 que muestra el Comprobador
      state.rawText = text;
      banner();
    } catch (err) {
      if (cached) {
        applyRates(cached);
        state.rawText = null; // desde caché no hay texto crudo para hashear
        const mins = Math.floor(ageMin(cached.fetchedAt));
        state.fromCache = true;
        banner('bad', 'Sin conexión con GitHub. Mostrando datos guardados hace ' + (mins < 60 ? mins + ' min' : Math.floor(mins / 60) + ' h ' + (mins % 60) + ' min') + '.');
      } else {
        state.rates = null;
        state.fromCache = false;
        banner('bad', 'No se pudo descargar rates.json y no hay copia guardada en este dispositivo. Revisa tu conexión y pulsa Actualizar.');
        throw err;
      }
    }
    return state.rates;
  }
  CT.getRates = getRates;

  function readCachedRates() {
    try {
      const raw = localStorage.getItem(LS_RATES);
      if (!raw) return null;
      const rec = JSON.parse(raw);
      if (!rec || !rec.data) return null;
      return rec;
    } catch (e) { return null; }
  }
  CT.readCachedRates = readCachedRates;

  function applyRates(rec) {
    state.rates = rec.data;
    state.fetchedAt = rec.fetchedAt;
  }

  // ================= 02 · PESTAÑA TASAS (dashboard) =================
  function kvCard(title, kvs, bigKey) {
    return '<div class="card"><h2>' + esc(title) + '</h2>' +
      (kvs.map(function (kv) {
        return '<div class="kv"><span class="k">' + esc(kv[0]) + '</span>' +
          '<span class="v' + (kv[0] === bigKey ? ' big' : '') + (kv[2] ? ' ' + esc(kv[2]) : '') + '">' + kv[1] + '</span></div>';
      }).join('') || '<p class="muted hint">—</p>') + '</div>';
  }
  CT.kvCard = kvCard;

  function num(v, dec) { return '<span class="num">' + fmt(v, dec) + '</span>'; }

  function sign(pct) {
    if (pct == null || !Number.isFinite(pct)) return '';
    return pct > 0.0005 ? 'pos' : (pct < -0.0005 ? 'neg' : '');
  }

  function renderTasas(data) {
    const badge = document.getElementById('badge-frescura');
    const fr = freshness(data.generatedAt);
    badge.className = 'badge ' + fr.cls;
    badge.textContent = fr.label + (fr.min != null ? ' · ' + Math.round(fr.min) + ' min' : '');

    const horaEl = document.getElementById('hora-caracas');
    horaEl.textContent = data.generatedAtCaracas
      ? 'Caracas: ' + String(data.generatedAtCaracas).replace('T', ' ').slice(0, 16)
      : 'Caracas: —';

    // --- P2P USD→VES (porPlataforma: { binance, bybit } con {compra,venta,muestras}) + cross ---
    const plat = data.pairs && data.pairs.VES && (data.pairs.VES.porPlataforma || {});
    const crossVES = data.cross && data.cross['BCV USD → Binance VES'];
    const rows = [];
    ['binance', 'bybit'].forEach(function (p) {
      const d = plat[p] || {};
      const label = p === 'binance' ? 'Binance' : 'Bybit';
      rows.push(['Compra ' + label, num(d.compra, 4), 'num'],
                ['Venta ' + label, num(d.venta, 4), 'num']);
    });
    if (crossVES && crossVES.pctVariacion != null) {
      rows.push(['Paralelo vs BCV (USD→Binance VES)', num(crossVES.pctVariacion, 2) + ' %', sign(crossVES.pctVariacion)]);
    }
    document.getElementById('ta-p2p').innerHTML =
      '<div class="card"><h2>P2P USD→Bs (Binance/Bybit)</h2><div class="grid2">' +
      rows.map(function (r) {
        return '<div class="kv"><span class="k">' + esc(r[0]) + '</span><span class="v ' + (r[2] || '') + '">' + r[1] + '</span></div>';
      }).join('') + '</div></div>';

    // --- BCV USD/EUR: sources.bcv.samples.{usd,eur} ---
    const bcvSamples = data.sources && data.sources.bcv && data.sources.bcv.samples;
    document.getElementById('ta-bcv').innerHTML =
      '<div class="card"><h2>Oficial BCV</h2><div class="grid2">' +
      '<div class="kv"><span class="k">USD</span><span class="v big num">' + num(bcvSamples && bcvSamples.usd, 4) + '</span></div>' +
      '<div class="kv"><span class="k">EUR</span><span class="v big num">' + num(bcvSamples && bcvSamples.eur, 4) + '</span></div>' +
      '</div></div>';

    // --- Variaciones + poder adquisitivo (arrays del bot: [{name,pct}] / [{name,lossPct,factor}]) ---
    const vari = Array.isArray(data.variations) ? data.variations : [];
    const pp = Array.isArray(data.purchasingPower) ? data.purchasingPower : [];
    document.getElementById('ta-variaciones').innerHTML =
      kvCard('Variaciones', vari.map(function (v) {
        return [ v.name || '—', num(v.pct, 2) + ' %', sign(v.pct) ];
      })) +
      kvCard('Poder adquisitivo', pp.map(function (v) {
        return [ v.name || '—', num(v.lossPct, 2) + ' % · ×' + num(v.factor, 4), 'neg' ];
      }));

    // --- Multi-par: una tarjeta por fiat, rejilla de 2 columnas (no tabla) ---
    let boards = '';
    FIATS.forEach(function (code) {
      const p = data.pairs && data.pairs[code];
      if (!p) return;
      boards += '<div class="card"><h2>' + esc(code) + ' (USD→' + esc(code) + ')</h2><div class="grid2">' +
        [ [ 'Compra', num(p.compra, code === 'CLP' ? 2 : 4) ],
          [ 'Venta', num(p.venta, code === 'CLP' ? 2 : 4) ],
          [ 'Spread', num(p.spreadPct, 2) + ' %' ],
          [ 'Mejor compra', num(p.mejorCompra, code === 'CLP' ? 2 : 4) ],
          [ 'Mejor venta', num(p.mejorVenta, code === 'CLP' ? 2 : 4) ],
          [ 'Mejor spread', num(p.mejorSpreadPct, 2) + ' %' ]
        ].map(function (kv) {
          return '<div class="kv"><span class="k">' + kv[0] + '</span><span class="v">' + kv[1] + '</span></div>';
        }).join('') +
        '</div><p class="muted hint">' +
          fmt(p.muestras && p.muestras.total, 0) + ' muestras (buy ' + fmt(p.muestras && p.muestras.buy, 0) + ' / sell ' + fmt(p.muestras && p.muestras.sell, 0) + ')' +
          (p.promediosPorPagina && p.promediosPorPagina.compra
            ? ' · Promo pág.1/2: c ' + fmt(p.promediosPorPagina.compra.page1, 4) + '/' + fmt(p.promediosPorPagina.compra.page2, 4)
              + ' · v ' + fmt(p.promediosPorPagina.venta && p.promediosPorPagina.venta.page1, 4) + '/' + fmt(p.promediosPorPagina.venta && p.promediosPorPagina.venta.page2, 4)
            : '') + '</p></div>';
    });
    document.getElementById('ta-multipares').innerHTML = boards;

    // --- Detalle VES: compraTotal/ventaTotal, mejores precios, promedios P1/P2, spread, muestras ---
    const vd = data.vesDetail;
    document.getElementById('ta-vesdetalle').innerHTML = vd ?
      '<div class="card"><h2>Detalle P2P VES</h2><div class="grid2">' +
      [ [ 'Compra total', num(vd.compraTotal, 4) ],
        [ 'Venta total', num(vd.ventaTotal, 4) ],
        [ 'Mejor compra', num(vd.mejorPrecioCompra, 4) ],
        [ 'Mejor venta', num(vd.mejorPrecioVenta, 4) ],
        [ 'Prom. compra págs. 1/2', num(vd.compraPromP1, 4) + ' / ' + num(vd.compraPromP2, 4) ],
        [ 'Prom. venta págs. 1/2', num(vd.ventaPromP1, 4) + ' / ' + num(vd.ventaPromP2, 4) ],
        [ 'Spread total / mejores', num(vd.spreadTotal, 2) + ' % / ' + num(vd.spreadMejores, 2) + ' %' ],
        [ 'Muestras', fmt(vd.muestras && vd.muestras.compra, 0) + ' · ' + fmt(vd.muestras && vd.muestras.venta, 0) ]
      ].map(function (kv) {
        return '<div class="kv"><span class="k">' + kv[0] + '</span><span class="v">' + kv[1] + '</span></div>';
      }).join('') + '</div>' : '';

    renderDiagnosticsShared(data, 'ta-diagnostico');
  }
  CT.renderTasas = renderTasas;

  // Diagnóstico + warnings compartidos entre pestañas Tasas y Comprobador.
  function renderDiagnosticsShared(data, id) {
    const dg = data.diagnostics || {};
    const lines = [];
    Object.keys(dg).forEach(function (k) {
      let v = dg[k];
      if (v && typeof v === 'object') v = JSON.stringify(v);
      const txt = typeof v === 'boolean' ? (v ? 'sí' : 'no') : v;
      lines.push('<div class="rowline"><span class="name">' + esc(k) + '</span><span class="val">' + esc(String(txt)) + '</span></div>');
    });
    (data.warnings || []).forEach(function (w) {
      lines.push('<span class="warnline">⚠ ' + esc(typeof w === 'string' ? w : JSON.stringify(w)) + '</span>');
    });
    document.getElementById(id).innerHTML =
      '<div class="card"><h2>Diagnóstico y avisos del bot</h2>' +
      (lines.join('') || '<p class="muted hint">Sin diagnóstico publicado.</p>') + '</div>';
  }
  CT.renderDiagnosticsShared = renderDiagnosticsShared;

  // ================= 03 · PESTAÑA CÁLCULO =================
  // Modes: integrado (destino VES), combinado (origen VES), cruzada (sin VES).
  // Tasa origen = pairs[from].compra (cuánta moneda "from" por 1 USDT al comprar USDT).
  // Tasa destino = pairs[to].venta. USD no tiene par en el bot: 1:1 con aviso.

  function calcCompute(data, from, to, amount, commissionPct) {
    const out = { ok: false, error: null };
    if (!(amount > 0)) { out.error = 'Monto inválido'; return out; }
    if (from === to) { out.error = 'Origen y destino iguales'; return out; }
    const comm = Number(commissionPct);
    if (!Number.isFinite(comm) || comm < 0 || comm > 100) { out.error = 'Comisión inválida'; return out; }

    const pairFrom = data && data.pairs && data.pairs[from];
    const pairTo = data && data.pairs && data.pairs[to];
    const usdWarning = (from === 'USD' || to === 'USD') && !(from === 'USD' && to === 'USD');

    const fromRate = from === 'USD' ? 1 : (pairFrom ? pairFrom.compra : null);
    const toRate = to === 'USD' ? 1 : (pairTo ? pairTo.venta : null);
    if (!Number.isFinite(fromRate) || !(fromRate > 0) || !Number.isFinite(toRate) || !(toRate > 0)) {
      out.error = 'No hay tasa publicada para este par';
      return out;
    }

    const usdtGross = amount / fromRate;
    const usdtNet = usdtGross * (1 - comm / 100);
    const result = usdtNet * toRate;

    out.ok = true;
    Object.assign(out, { from, to, amount, commissionPct: comm, fromRate, toRate, usdtGross, usdtNet, result, usdWarning });
    return out;
  }
  CT.calcCompute = calcCompute;

  function renderCalc() {
    const data = state.rates;
    const form = document.getElementById('calc-form');
    if (!form || form.dataset.bound) return;
    form.dataset.bound = '1';

    const modo = document.getElementById('calc-modo');
    const ori = document.getElementById('calc-origen');
    const des = document.getElementById('calc-destino');
    const btnReg = document.getElementById('calc-registrar');

    modo.addEventListener('change', function () {
      if (modo.value === 'integrado') { des.value = 'VES'; if (ori.value === 'VES') ori.value = 'PEN'; }
      if (modo.value === 'combinado') { ori.value = 'VES'; if (des.value === 'VES') des.value = 'COP'; }
    });
    ori.addEventListener('change', function () {
      // comisión por defecto: 5 %, u 8 % si el origen es COP
      document.getElementById('calc-comision').value = (ori.value === 'COP') ? 8 : 5;
      if (ori.value === des.value) { des.selectedIndex = (des.selectedIndex + 1) % des.options.length; }
    });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      const d = state.rates;
      const out = document.getElementById('calc-out');
      if (!d) { banner('bad', 'Sin tasas: descarga primero, pulsa Actualizar.'); out.innerHTML = ''; return; }
      const r = calcCompute(d, ori.value, des.value, parseFloat(document.getElementById('calc-monto').value.replace(',', '.')), parseFloat(document.getElementById('calc-comision').value));
      if (!r.ok) {
        banner('warn', r.error);
        out.innerHTML = ''; btnReg.disabled = true; state.calcDraft = null;
        return;
      }
      banner();
      out.innerHTML = '<div class="card"><h2>Desglose</h2>' +
        '<div class="rowline"><span class="name">' + fmtMoney(r.amount, r.from) + ' → tasa compra ' + fmt(r.fromRate, 4) + '</span><span class="val">' + fmt(r.usdtGross, 4) + ' USDT</span></div>' +
        '<div class="rowline"><span class="name">USDT neto (−' + fmt(r.commissionPct, 2) + ' %)</span><span class="val">' + fmt(r.usdtNet, 4) + ' USDT</span></div>' +
        '<div class="kv"><span class="k">Entregas (venta ' + fmt(r.toRate, 4) + ')</span><span class="v big num">' + fmtMoney(r.result, r.to) + '</span></div>' +
        (r.usdWarning ? '<p class="warnline">Aviso: USD se asume 1:1 con USDT (sin par del bot para verificarlo).</p>' : '') +
        '</div>';
      state.calcDraft = { tipo: 'calculo', fecha: new Date().toISOString().slice(0, 10), origMoneda: ori.value, montoSale: r.amount, tasaOrigen: r.fromRate, destMoneda: des.value, montoEntrada: r.result, tasaDestino: r.toRate, comision: r.commissionPct };
      btnReg.disabled = false;
    });

    btnReg.addEventListener('click', function () {
      if (!state.calcDraft) return;
      switchTab('operaciones');
      preloadFromCalc(state.calcDraft);
    });
  }
  CT.renderCalc = renderCalc;

  function preloadFromCalc(draft) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('ops-fecha', draft.fecha);
    set('ops-origen', draft.origMoneda);
    set('ops-destino', draft.destMoneda);
    set('ops-sale', draft.montoSale);
    set('ops-entry', trimNum(draft.montoEntrada));
    set('ops-entry-rate', draft.tasaDestino);
    set('ops-obs', 'Cálculo ' + fmt(draft.tasaOrigen, 4));
    document.getElementById('ops-preview').innerHTML = '';
    banner('ok', 'Precargado desde Cálculo. Revisa la tasa de salida y guarda.');
  }
  CT.preloadFromCalc = preloadFromCalc;

  function trimNum(v) { return String(Number(v.toFixed ? v.toFixed(6) : v)); }

  // ================= 04 · PESTAÑA OPERACIONES: modelo exacto + formulario =================
  // Fórmula EXACTA (corrige bugs del TotalizadorRemesasV5):
  //   costoUSD   = sale   / saleRate
  //   netoUSD    = entry  / entryRate
  //   plusvalia  = netoUSD − costoUSD
  //   si plusvalia > 0: base=plusvalia; diezmo=plusvalia*0.10; tercero=check? plusvalia*0.25:0;
  //                     netoParaMi = plusvalia − diezmo − tercero
  //   si plusvalia <= 0: perdida=|plusvalia|; base=diezmo=tercero=netoParaMi=... (neto negativo)
  // Los totales se calculan SIEMPRE desde los valores crudos (sale/entry/tasas), nunca sumando netos redondeados.
  function computeOperation(o) {
    const out = { ok: false };
    const sale = Number(o.sale), saleRate = Number(o.saleRate);
    const entry = Number(o.entry), entryRate = Number(o.entryRate);
    if (!Number.isFinite(sale) || !Number.isFinite(saleRate) || !Number.isFinite(entry) || !Number.isFinite(entryRate)) { out.error = 'Todos los montos y tasas deben ser números.'; return out; }
    if (!(sale > 0) || !(saleRate > 0) || !(entry > 0) || !(entryRate > 0)) { out.error = 'Ningún monto o tasa puede ser 0 o negativo (evita divisiones por cero).'; return out; }
    const costoUSD = sale / saleRate;
    const netoUSD = entry / entryRate;
    const plusvalia = netoUSD - costoUSD;
    let base, diezmo, tercero, netoParaMi, perdida;
    if (plusvalia > 0) {
      base = plusvalia;
      diezmo = plusvalia * 0.10;
      tercero = o.tercero ? plusvalia * 0.25 : 0;
      netoParaMi = plusvalia - diezmo - tercero;
      perdida = 0;
    } else {
      base = 0; diezmo = 0; tercero = 0;
      perdida = Math.abs(plusvalia);
      netoParaMi = plusvalia; // pérdida en negativo
    }
    Object.assign(out, { ok: true, costoUSD, netoUSD, plusvalia, base, diezmo, tercero, netoParaMi, perdida });
    return out;
  }
  CT.computeOperation = computeOperation;

  function loadOps() {
    try {
      const raw = localStorage.getItem(LS_OPS);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  CT.loadOps = loadOps;

  function saveOps(arr) {
    try { localStorage.setItem(LS_OPS, JSON.stringify(arr)); return true; }
    catch (e) { banner('bad', 'No se pudo guardar en este dispositivo.'); return false; }
  }
  CT.saveOps = saveOps;

  function bindOpsForm() {
    const form = document.getElementById('ops-form');
    if (!form || form.dataset.bound) return;
    form.dataset.bound = '1';
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('ops-fecha', new Date().toISOString().slice(0, 10));
    set('ops-origen', 'PEN');

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      const g = id => document.getElementById(id).value.trim();
      const o = {
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        fecha: g('ops-fecha') || new Date().toISOString().slice(0, 10),
        origMoneda: g('ops-origen'), destMoneda: g('ops-destino'),
        sale: parseFloat(g('ops-sale')), saleRate: parseFloat(g('ops-sale-rate')),
        entry: parseFloat(g('ops-entry')), entryRate: parseFloat(g('ops-entry-rate')),
        obs: g('ops-obs'), tercero: document.getElementById('ops-tercero').checked,
        createdAt: new Date().toISOString()
      };
      const r = computeOperation(o);
      if (!r.ok) { banner('bad', r.error); return; }
      const fechaOk = /^\d{4}-\d{2}-\d{2}$/.test(o.fecha) && !isNaN(new Date(o.fecha + 'T12:00:00Z').getTime());
      if (!fechaOk) { banner('bad', 'Fecha inválida.'); return; }
      const dup = findDuplicate(o, loadOps());
      if (dup && !window.confirm('Ya existe una operación casi idéntica del ' + o.fecha + ' (' + o.origMoneda + '→' + o.destMoneda + '): ' + o.sale + ' / ' + o.entry + '.\n¿Registrarla igualmente?')) return;
      const arr = loadOps(); arr.push(o);
      if (saveOps(arr)) {
        banner('ok', 'Operación registrada.');
        form.reset();
        set('ops-fecha', new Date().toISOString().slice(0, 10));
        set('ops-origen', 'PEN');
        renderOpsList();
      }
    });

    fillMonthFilter();
    document.getElementById('ops-mes').addEventListener('change', renderOpsList);
    document.getElementById('ops-imp').addEventListener('click', function () { document.getElementById('ops-imp-file').click(); });
    document.getElementById('ops-imp-file').addEventListener('change', importOps);
    document.getElementById('ops-exp-csv').addEventListener('click', exportCsv);
    document.getElementById('ops-exp-json').addEventListener('click', exportJson);
    document.getElementById('ops-formato').textContent =
      '{ "version": "1.0", "exportedAt": "…", "operations": [ { "fecha", "origen", "destino", "sale", "saleRate", "entry", "entryRate", "obs", "tercero" } ] }';
    renderOpsList();
  }
  CT.bindOpsForm = bindOpsForm;

  // ================= 04b · OPERACIONES: lista, totales, export/import =================
  function opPair(o) { return o.origMoneda + '→' + o.destMoneda; }

  function findDuplicate(o, arr) {
    return arr.find(function (x) {
      return x.fecha === o.fecha && opPair(x) === opPair(o) &&
        Math.abs(Number(x.sale) - o.sale) < 0.01 && Math.abs(Number(x.entry) - o.entry) < 0.01;
    });
  }
  CT.findDuplicate = findDuplicate;

  function fillMonthFilter() {
    const sel = document.getElementById('ops-mes');
    const months = [];
    loadOps().forEach(function (o) { const m = (o.fecha || '').slice(0, 7); if (m && months.indexOf(m) < 0) months.push(m); });
    months.sort().reverse();
    const prev = sel.value;
    sel.innerHTML = '<option value="all">Todos</option>' + months.map(function (m) {
      return '<option value="' + esc(m) + '">' + esc(monthLabel(m)) + '</option>';
    }).join('');
    if (prev) sel.value = Array.prototype.some.call(sel.options, function (op) { return op.value === prev; }) ? prev : 'all';
  }

  function monthLabel(m) {
    const d = new Date(m + '-01T12:00:00Z');
    return isNaN(d.getTime()) ? m : d.toLocaleString('es-VE', { month: 'long', year: 'numeric' });
  }

  // Totales SIEMPRE desde valores crudos (otra vez los cálculos exactos; no se suman netos guardados).
  function computeTotals(arr) {
    const t = { n: 0, ganancia: 0, perdida: 0, base: 0, diezmo: 0, tercero: 0, neto: 0 };
    arr.forEach(function (o) {
      const r = computeOperation(o);
      if (!r.ok) return;
      t.n++;
      if (r.plusvalia > 0) { t.ganancia += r.plusvalia; t.base += r.base; t.diezmo += r.diezmo; t.tercero += r.tercero; }
      else t.perdida += r.perdida;
      t.neto += r.netoParaMi;
    });
    return t;
  }
  CT.computeTotals = computeTotals;

  function renderOpsList() {
    fillMonthFilter();
    const sel = document.getElementById('ops-mes');
    const all = loadOps().slice().sort(function (a, b) { return (b.fecha || '').localeCompare(a.fecha || '') || (b.createdAt || '').localeCompare(a.createdAt || ''); });
    const m = sel.value;
    const arr = m && m !== 'all' ? all.filter(function (o) { return (o.fecha || '').slice(0, 7) === m; }) : all;
    const t = computeTotals(arr);
    document.getElementById('ops-totales').innerHTML =
      '<div class="card"><h2>Totales ' + (m && m !== 'all' ? esc(monthLabel(m)) : 'histórico completo') + ' (' + t.n + ' op.)</h2><div class="grid2">' +
      [ [ 'Plusvalías positivas', '<span class="pos">+ ' + fmt(t.ganancia, 4) + '</span>' ],
        [ 'Pérdidas', '<span class="neg">− ' + fmt(t.perdida, 4) + '</span>' ],
        [ 'Base gravable', fmt(t.base, 4) ],
        [ 'Diezmo (10 %)', fmt(t.diezmo, 4) ],
        [ 'Tercero (25 %)', fmt(t.tercero, 4) ],
        [ 'Neto para mí', fmt(t.neto, 4) ]
      ].map(function (kv) { return '<div class="kv"><span class="k">' + kv[0] + '</span><span class="v num">' + kv[1] + '</span></div>'; }).join('') +
      '</div></div>';
    document.getElementById('ops-lista').innerHTML = arr.map(function (o) {
      const r = computeOperation(o);
      return '<div class="opcard"><div class="ophead">' +
        '<span class="pair num">' + esc(o.fecha || '—') + ' · ' + esc(opPair(o)) + '</span>' +
        '<span class="opbadge">' + (r.ok && r.plusvalia > 0 ? 'GANANCIA' : 'PÉRDIDA') + '</span></div>' +
        '<div class="rowline"><span class="name">Venta ' + fmt(o.sale, 4) + ' ' + esc(o.origMoneda) + ' @ ' + fmt(o.saleRate, 4) + '</span><span class="val num">' + (r.ok ? fmt(r.costoUSD, 4) : '—') + ' USD</span></div>' +
        '<div class="rowline"><span class="name">Entra ' + fmt(o.entry, 4) + ' ' + esc(o.destMoneda) + ' @ ' + fmt(o.entryRate, 4) + '</span><span class="val num">' + (r.ok ? fmt(r.netoUSD, 4) : '—') + ' USD</span></div>' +
        (r.ok ? '<div class="rowline"><span class="name">Plusvalía · diezmo · tercero</span><span class="val num">' + fmt(r.plusvalia, 4) + ' · ' + fmt(r.diezmo, 4) + ' · ' + fmt(r.tercero, 4) + '</span></div>' +
        '<div class="rowline"><span class="name">Neto para mí</span><span class="val num ' + (r.netoParaMi >= 0 ? 'pos' : 'neg') + '">' + fmt(r.netoParaMi, 4) + ' USD' + (o.tercero ? ' (tercero 25 %)' : '') + '</span></div>' : '') +
        (o.obs ? '<div class="opobs">' + esc(o.obs) + '</div>' : '') +
        '<button type="button" class="btn btn-small btn-danger" data-del="' + esc(o.id) + '">Eliminar</button></div>';
    }).join('') || '<p class="muted hint">Sin operaciones registradas' + (m && m !== 'all' ? ' en este mes' : '') + '.</p>';

    document.getElementById('ops-lista').querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!window.confirm('¿Eliminar esta operación?')) return;
        saveOps(loadOps().filter(function (o) { return o.id !== btn.dataset.del; }));
        renderOpsList();
      });
    });
  }
  CT.renderOpsList = renderOpsList;

  function exportJson() {
    const payload = { version: '1.0', exportedAt: new Date().toISOString(), operations: loadOps().map(function (o) {
      return { fecha: o.fecha, origen: o.origMoneda, destino: o.destMoneda, sale: o.sale, saleRate: o.saleRate, entry: o.entry, entryRate: o.entryRate, obs: o.obs || '', tercero: !!o.tercero };
    }) };
    download('consumo-operations-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(payload, null, 2), 'application/json');
  }
  CT.exportJson = exportJson;

  function exportCsv() {
    const head = 'fecha,origen,destino,sale,saleRate,entry,entryRate,costoUSD,netoUSD,plusvalia,diezmo,tercero,netoParaMi,obs';
    const rows = loadOps().map(function (o) {
      const r = computeOperation(o);
      return [ o.fecha, o.origMoneda, o.destMoneda, o.sale, o.saleRate, o.entry, o.entryRate,
        r.ok ? r.costoUSD : '', r.ok ? r.netoUSD : '', r.ok ? r.plusvalia : '',
        r.ok ? r.diezmo : '', r.ok ? r.tercero : '', r.ok ? r.netoParaMi : '', o.obs || '' ]
        .map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(',');
    });
    download('consumo-operations-' + new Date().toISOString().slice(0, 10) + '.csv', head + '\n' + rows.join('\n'), 'text/csv');
  }
  CT.exportCsv = exportCsv;

  function importOps(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    const fr = new FileReader();
    fr.onload = function () {
      let payload;
      try { payload = JSON.parse(String(fr.result)); }
      catch (e) { banner('bad', 'JSON inválido: no se pudo leer el archivo.'); return; }
      const res = validateOpsPayload(payload);
      if (res.errors.length) { banner('bad', 'Formato incompatible: ' + res.errors[0] + (res.errors.length > 1 ? ' (+' + (res.errors.length - 1) + ')' : '')); return; }
      // duplicados (fecha+par+sale+entry ±0,01) contra lo guardado y contra lo ya Importado en este lote
      const existente = loadOps();
      const nuevos = res.valid.filter(function (o) { return !findDuplicate(o, existente); });
      const duplicadas = res.valid.length - nuevos.length;
      let internas = 0;
      const aAgregar = nuevos.filter(function (o, i) {
        if (nuevos.findIndex(function (x) { return x.fecha === o.fecha && opPair(x) === opPair(o) && Math.abs(x.sale - o.sale) < 0.01 && Math.abs(x.entry - o.entry) < 0.01; }) !== i) { internas++; return false; }
        return true;
      });
      if (aAgregar.length && !window.confirm('Importar ' + aAgregar.length + ' operación(es) nueva(s)?' + (duplicadas + internas > 0 ? ' Se omitirán ' + (duplicadas + internas) + ' duplicada(s) (fecha+par+montos ±0,01).' : ''))) return;
      aAgregar.forEach(function (o) { existente.push(o); });
      if (saveOps(existente)) renderOpsList();
      banner('ok', 'Importadas ' + aAgregar.length + ' operación(es); omitidas ' + (duplicadas + internas) + ' duplicada(s); ' + res.errors.length + ' inválida(s).');
    };
    fr.readAsText(file);
  }
  CT.importOps = importOps;

  function validateOpsPayload(payload) {
    const errors = [], valid = [], C = CURRENCIES;
    const arr = payload && Array.isArray(payload.operations) ? payload.operations : (Array.isArray(payload) ? payload : null);
    if (!arr) { errors.push('Falta el array "operations" (o el raíz debe ser un array).'); return { errors, valid }; }
    arr.forEach(function (o, i) {
      const prob = [];
      const curOk = v => v && Object.prototype.hasOwnProperty.call(C, v);
      if (!curOk(o.origen)) prob.push('origen');
      if (!curOk(o.destino)) prob.push('destino');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(o.fecha || '')) || isNaN(new Date(o.fecha + 'T12:00:00Z').getTime())) prob.push('fecha');
      ['sale', 'saleRate', 'entry', 'entryRate'].forEach(function (k) {
        if (typeof o[k] !== 'number' || !Number.isFinite(o[k]) || o[k] <= 0) prob.push(k);
      });
      if (prob.length) errors.push('op #' + (i + 1) + ': campos inválidos (' + prob.join(', ') + ')');
      else valid.push({ id: Date.now() + '-' + i + '-' + Math.random().toString(36).slice(2, 8), fecha: o.fecha, origMoneda: o.origen, destMoneda: o.destino, sale: o.sale, saleRate: o.saleRate, entry: o.entry, entryRate: o.entryRate, obs: String(o.obs == null ? '' : o.obs).slice(0, 200), tercero: !!o.tercero, createdAt: new Date().toISOString() });
    });
    return { errors, valid };
  }
  CT.validateOpsPayload = validateOpsPayload;

  function download(name, content, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: mime + ';charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  // ================= 05 · PESTAÑA COMPROBADOR =================
  // Transparencia: de dónde salen los datos, cuándo se generaron, hash del snapshot,
  // estado de cada fuente del bot y mensaje honesto si lo que ves viene de caché.
  function renderComprobador(data, fetchInfo) {
    state.chkRawText = fetchInfo && fetchInfo.rawText;
    state.chkFetch = fetchInfo || {};

    const gen = new Date(data.generatedAt);
    const ageM = ageMin(data.generatedAt);
    const proxy = txn => { const d = new Date(gen.getTime() + txn); return d; };

    document.getElementById('chk-fuegonacional').innerHTML =
      '<div class="rowline"><span class="name">Archivo del snapshot</span><span class="val mono">data/rates.json</span></div>' +
      '<div class="rowline"><span class="name">Integridad (SHA-256, calculado en tu navegador)</span><span class="val mono" id="chk-hash">' + (state.chkFetch.hash ? esc(state.chkFetch.hash) : 'calculando…') + '</span></div>';

    // Próximo run: el workflow corre cada 5 min; Pages añade su propio retraso de publicación.
    const nextRun = proxy(5 * 60000);
    document.getElementById('chk-momento').innerHTML =
      '<div class="rowline"><span class="name">Generado (UTC)</span><span class="val num">' + esc(String(data.generatedAt).replace('T', ' ').slice(0, 19) + 'Z') + '</span></div>' +
      '<div class="rowline"><span class="name">Generado (Caracas)</span><span class="val num">' + esc(String(data.generatedAtCaracas || '—').replace('T', ' ').slice(0, 19)) + '</span></div>' +
      '<div class="rowline"><span class="name">Antigüedad del snapshot</span><span class="val num">' + (ageM != null ? fmt(ageM, 1) + ' min' : '—') + '</span></div>' +
      '<div class="rowline"><span class="name">Proximo run estimado del bot</span><span class="val num">' + esc(hhmmZ(nextRun)) + ' UTC</span></div>' +
      (state.fromCache && state.fetchedAt ? '<div class="rowline"><span class="name">Origen de lo que ves</span><span class="val neg">copia guardada hace ' + fmt(Math.floor(ageMin(state.fetchedAt)), 0) + ' min</span></div>' : '');

    const meta = data.meta || {};
    const sources = data.sources || {};
    const srcHtml = Object.keys(sources).map(function (k) {
      const s = sources[k] || {};
      let muestra = '—';
      if (s.samples) {
        muestra = Object.keys(s.samples).map(function (kk) { return kk + ' ' + fmt(s.samples[kk], 0); }).join(' · ');
      }
      return '<div class="rowline"><span class="name">' + esc(k) + ' · estado ' + esc(s.status || '—') + ' · HTTP ' + esc(s.http != null ? s.http : '—') + '</span><span class="val num">' + esc(muestra) + '</span></div>';
    }).join('');
    document.getElementById('chk-fuentes').innerHTML =
      '<div class="card"><h2>Fuentes y estructura</h2>' +
      '<div class="rowline"><span class="name">Schema</span><span class="val mono">' + esc(data.schema || '—') + '</span></div>' +
      '<div class="rowline"><span class="name">Pares publicados (meta.fiats)</span><span class="val num">' + esc((meta.fiats || FIATS).join(' · ')) + '</span></div>' +
      '<div class="rowline"><span class="name">Páginas P2P / filas por página (meta)</span><span class="val mono">' + esc(meta.pages != null ? meta.pages + ' págs. × ' + (meta.rows || '—') + ' filas' : '—') + '</span></div>' +
      (srcHtml || '<p class="muted hint">Sin detalle de fuentes.</p>') +
      '</div>';

    renderDiagnosticsShared(data, 'chk-diagnostico');

    // "Ver insumos": muestra en crudo (prettificado) lo que el bot interpretó.
    const insumosBtn = document.getElementById('chk-insumos-btn');
    if (!insumosBtn.dataset.bound) {
      insumosBtn.dataset.bound = '1';
      insumosBtn.addEventListener('click', function () {
        const pre = document.getElementById('chk-insumos');
        pre.hidden = !pre.hidden;
        if (!pre.hidden) { pre.textContent = buildInsumos(state.rates); }
      });
    }

    // Hash del texto crudo tal como lo descargó este navegador.
    const hashEl = document.getElementById('chk-hash');
    if (state.chkRawText != null) {
      hashEl.textContent = 'calculando…';
      sha256Hex(state.chkRawText).then(function (h) { hashEl.textContent = h; })
        .catch(function () { hashEl.textContent = '—'; });
    } else {
      hashEl.textContent = 'pulsa "Actualizar" en Tasas para calcularlo';
    }
  }
  CT.renderComprobador = renderComprobador;

  function buildInsumos(data) {
    return JSON.stringify({
      cross: data.cross || null,
      variations: data.variations || null,
      purchasingPower: data.purchasingPower || null,
      promediosPorPagina: Object.fromEntries(FIATS.map(function (c) { const p = data.pairs && data.pairs[c]; return [c, p && p.promediosPorPagina]; }))
    }, null, 2);
  }
  CT.buildInsumos = buildInsumos;

  function hhmmZ(d) {
    return isNaN(d.getTime()) ? '—' : String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  }
  CT.hhmmZ = hhmmZ;

  // ================= 06 · INIT: pestañas, navegación, auto-refresh =================
  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(function (sec) {
      const on = sec.id === 'tab-' + name;
      sec.classList.toggle('active', on);
      sec.hidden = !on;
    });
    document.querySelectorAll('.navbtn').forEach(function (btn) {
      const on = btn.dataset.tab === name;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    state.currentTab = name;
    sessionStorage.setItem('consumo_tab', name);
    window.scrollTo(0, 0);
  }
  CT.switchTab = switchTab;

  function renderAll() {
    if (!state.rates) { banner('bad', 'No hay datos del bot disponibles todavía.'); return; }
    renderTasas(state.rates);
    renderDiagnosticsShared(state.rates, 'ta-diagnostico');
  }

  const TABS = ['tasas', 'calculo', 'operaciones', 'comprobador'];

  async function init() {
    document.querySelectorAll('.navbtn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        switchTab(btn.dataset.tab);
        if (btn.dataset.tab === 'comprobador' && state.rates) {
          renderComprobador(state.rates, { rawText: state.rawText });
        }
      });
    });

    document.getElementById('btn-refresh').addEventListener('click', function () {
      refreshAll(true);
    });

    bindOpsForm();

    // restaurar pestaña
    const saved = sessionStorage.getItem('consumo_tab');
    switchTab(TABS.indexOf(saved) >= 0 ? saved : 'tasas');

    // primer render con lo que ya exista en caché para no ver pantalla vacía
    const cached = readCachedRates();
    if (cached) { applyRates(cached); renderAll(); }
    renderCalc();
    await refreshAll(false);
  }
  CT.init = init;

  async function refreshAll(force) {
    const data = await getRates({ force });
    if (data) {
      renderAll();
      if (state.currentTab === 'comprobador') renderComprobador(data, { rawText: state.rawText });
    }
  }
  CT.refreshAll = refreshAll;

  // Auto-refresh cada 60 s SOLO si la pestaña está visible (no interrumpe el scroll).
  setInterval(function () {
    if (document.visibilityState === 'visible') refreshAll(false);
  }, 60000);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  globalThis.CT = CT;
})();
