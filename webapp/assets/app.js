/* ConsuTasas v2 — núcleo de UI: pestañas, fetch/caché de rates.json, casos,
 * cuentas, balance e histórico con init. Sin dependencias: todo sobre CTEngine
 * (engine.js, commit 29cf6d7) y el snapshot rates.json del bot.
 *
 * Regras del snapshot: localhost/127.0.0.1 → ./data/rates.json; con el override
 * ?local=1 el mismo origen se fuerza aunque el host sea remoto (túnel);
 * producción → raw.githubusercontent.com (rama data). Caché `ct_rates` con TTL 5 min; si la
 * red falla se muestra la copia guardada indicando su antigüedad — nunca se
 * presenta caché como dato en vivo y nunca se inventa una tasa (null + aviso).
 */
(function () {
  'use strict';

  const CT = globalThis.CT = globalThis.CT || {};
  CT.parts = {}; // registro de render por pestaña (render lazy)

  const RATE_URL = 'https://raw.githubusercontent.com/afvelis/consutasas/data/rates.json';
  const LS_RATES = 'ct_rates';      // { data, fetchedAt }
  const LS_RATES_PREV = 'ct_rates_prev'; // { data, fetchedAt }
  const RATES_TTL_MS = 5 * 60 * 1000;
  const BOT_STATUS_URL = 'https://api.github.com/repos/afvelis/consutasas/actions/workflows/rates.yml/runs?per_page=1';
  const BOT_STATUS_TTL_MS = 5 * 60 * 1000; // ≥ 5 min para no saturar el rate limit de GitHub (60/h sin token)
  const LS_BOT_STATUS = 'ct_bot_status'; // { data, fetchedAt }

  const CURRENCY_LABEL = {
    USD: { name: 'Dólar', symbol: 'US$' },
    VES: { name: 'Bolívar', symbol: 'Bs' },
    PEN: { name: 'Sol', symbol: 'S/' },
    COP: { name: 'Peso colombiano', symbol: '$' },
    CLP: { name: 'Peso chileno', symbol: '$' },
    MXN: { name: 'Peso mexicano', symbol: '$' },
    EUR: { name: 'Euro', symbol: '€' }
  };

  // Estado de la app (snapshot de tasas + libro del motor + caso en curso).
  const S = {
    tab: null,
    rates: null,        // snapshot rates.json crudo
    fx: null,           // CTEngine.buildFx(rates) (+ EUR manual si aplica)
    fetchedAt: null,    // cuándo se descargó el snapshot (ISO)
    fromCache: false,   // lo que se muestra viene de la copia guardada
    rawText: null,      // texto crudo descargado (para el hash SHA-256 del Comprobador)
    ledger: null,       // estado del libro mayor (CTEngine.load)
    pairKey: null,      // par activo, ej. 'VES/PEN' o 'USD/USD'
    modo: null,         // modo activo del par
    scOriginMode: 'best',         // panel 3e: matriz origen × MAX/BEST/AVG/MIN; default Mejor
    scDestMode: 'best',           // panel 3e: matriz destino × MAX/BEST/AVG/MIN; default Mejor
    scOriginManual: null,         // tasa manual origen (3e); si está, manda sobre la del sistema
    scDestManual: null,           // tasa manual destino (3e)
    updateSource: null, // 'manual'|'auto'|'bot'|'cache'|'local'
    botStatus: null     // { status, conclusion, updated_at, html_url } del último run
  };
  CT.S = S;

  // ==================== Utilidades ====================

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  CT.esc = esc;

  const nf = (min, max) => new Intl.NumberFormat('es-VE', { minimumFractionDigits: min, maximumFractionDigits: max });
  const NF0 = nf(0, 0), NF2 = nf(2, 2), NF4 = nf(2, 4);

  // fmt(v, dec): es-VE; null/NaN/Infinity → '—'. Nunca inventa datos.
  function fmt(v, dec) {
    if (v == null || typeof v !== 'number' || !Number.isFinite(v)) return '—';
    if (dec === 0) return NF0.format(v);
    if (dec === 4) return NF4.format(v);
    return NF2.format(v);
  }
  CT.fmt = fmt;

  function codeSymbol(code) {
    const m = CURRENCY_LABEL[code];
    return m ? m.symbol : String(code || '—');
  }

  function fmtMoney(v, code) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return codeSymbol(code) + ' ' + fmt(n, Math.abs(n) >= 1000 ? 2 : 4);
  }
  CT.fmtMoney = fmtMoney;

  function fmtUsd(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return 'US$ ' + nf(2, Math.abs(n) < 1000 ? 4 : 2).format(n);
  }
  CT.fmtUsd = fmtUsd;

  function fmtDate(iso, withTime) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('es-VE', Object.assign({
      day: '2-digit', month: '2-digit', year: 'numeric'
    }, withTime ? { hour: '2-digit', minute: '2-digit' } : {}));
  }
  CT.fmtDate = fmtDate;

  // Fecha local de hoy en YYYY-MM-DD (para registrar operaciones).
  function todayISO() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  CT.todayISO = todayISO;

  function ageMin(iso) {
    const t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    return Math.max(0, (Date.now() - t) / 60000);
  }

  function hhmmFromIso(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  }
  CT.hhmmFromIso = hhmmFromIso;

  function isNewerThan(prevIso, currIso) {
    if (!prevIso || !currIso) return true;
    return new Date(currIso).getTime() > new Date(prevIso).getTime();
  }

  // Bot status: último run del workflow rates.yml
  function readCachedBotStatus() {
    try {
      const raw = localStorage.getItem(LS_BOT_STATUS);
      if (!raw) return null;
      const rec = JSON.parse(raw);
      return (rec && rec.data) ? rec : null;
    } catch (e) { return null; }
  }
  CT.readCachedBotStatus = readCachedBotStatus;

  async function refreshBotStatus() {
    const cached = readCachedBotStatus();
    if (cached && (Date.now() - new Date(cached.fetchedAt).getTime()) < BOT_STATUS_TTL_MS) {
      S.botStatus = cached.data;
      try { localStorage.setItem(LS_BOT_STATUS, JSON.stringify(cached)); } catch (e) {}
      return S.botStatus;
    }
    try {
      const res = await fetch(BOT_STATUS_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      if (j.total_count && j.workflow_runs && j.workflow_runs.length) {
        const run = j.workflow_runs[0];
        const data = {
          status: run.status,
          conclusion: run.conclusion,
          updated_at: run.updated_at,
          html_url: run.html_url
        };
        S.botStatus = data;
        try { localStorage.setItem(LS_BOT_STATUS, JSON.stringify({ data: data, fetchedAt: new Date().toISOString() })); } catch (e) {}
        return data;
      }
    } catch (err) { /* 403/error → limpiar y ocultar */
      S.botStatus = null;
      try { localStorage.removeItem(LS_BOT_STATUS); } catch (e) {}
    }
    return null;
  }
  CT.refreshBotStatus = refreshBotStatus;

  function renderBotStatus() {
    const cont = el('bot-status-container');
    if (!cont) return;
    if (!S.botStatus) {
      cont.hidden = true;
      return;
    }
    cont.hidden = false;
    const bs = S.botStatus;
    const statusCls = (bs.conclusion === 'success') ? 'badge-ok' : (bs.conclusion === 'failure' ? 'badge-bad' : 'badge-warn');
    const statusLabel = (bs.conclusion === 'success') ? 'Éxito' : (bs.conclusion === 'failure' ? 'Fallo' : (bs.status || bs.conclusion || '—'));
    cont.innerHTML = '<span class="badge ' + statusCls + '">Bot: ' + esc(statusLabel) + '</span>' +
      (bs.updated_at ? ' · ' + esc(hhmmFromIso(bs.updated_at)) + ' UTC' : '') +
      (bs.html_url ? ' · <a href="' + esc(bs.html_url) + '" target="_blank" rel="noopener">ver</a>' : '');
  }
  CT.renderBotStatus = renderBotStatus;
  CT.botStatusContainer = 'bot-status-container';

  // freshness(): verde <10 min, amarillo 10–20, rojo >20 (sobre generatedAt del bot).
  function freshness(generatedAt) {
    const a = ageMin(generatedAt);
    if (a == null) return { cls: 'badge-wait', label: 'Sin datos', min: null };
    if (a < 10) return { cls: 'badge-ok', label: 'Reciente', min: a };
    if (a <= 20) return { cls: 'badge-warn', label: 'Desactualizado', min: a };
    return { cls: 'badge-bad', label: 'Desactualizado', min: a };
  }
  CT.freshness = freshness;

  function banner(kind, msg) {
    const b = el('banner');
    if (!b) return;
    if (!msg) { b.hidden = true; b.innerHTML = ''; b.textContent = ''; return; }
    b.hidden = false;
    b.className = 'banner banner-' + (kind || 'warn');
    b.textContent = msg;
  }
  CT.banner = banner;

  // Aviso flotante corto (crea su nodo; sin inline en el HTML).
  // P2: bottom depende del modo (24px web; 84px phone, sobre la barra fija).
  let toastEl = null, toastTimer = null;
  function toastBottomPx() {
    return document.body && document.body.classList.contains('phone-mode') ? 84 : 24;
  }
  function placeToast() {
    if (toastEl) toastEl.style.bottom = toastBottomPx() + 'px';
  }
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'toast';
      toastEl.setAttribute('role', 'status');
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:' + toastBottomPx() + 'px;transform:translateX(-50%);' +
        'background:#1d2333;color:#e8ecf8;border:1px solid #3a4358;border-radius:10px;' +
        'padding:10px 14px;font-size:14px;max-width:88vw;z-index:99;box-shadow:0 4px 16px rgba(0,0,0,.5)';
      (document.body || document.documentElement).appendChild(toastEl);
    }
    placeToast();
    toastEl.textContent = msg;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 3200);
  }
  CT.toast = toast;

  function kvCard(title, kvs, bigKey) {
    return '<div class="card"><h2>' + esc(title) + '</h2>' +
      (kvs.map(function (kv) {
        return '<div class="kv"><span class="k">' + esc(kv[0]) + '</span>' +
          '<span class="v' + (kv[0] === bigKey ? ' big' : '') + (kv[2] ? ' ' + esc(kv[2]) : '') + '">' + kv[1] + '</span></div>';
      }).join('') || '<p class="muted hint">—</p>') + '</div>';
  }
  CT.kvCard = kvCard;

  // ==================== Pestañas ====================

  function switchTab(name) {
    if (!el('tab-' + name)) return;
    document.querySelectorAll('.tab').forEach(function (sec) {
      const on = sec.id === 'tab-' + name;
      sec.hidden = !on;
      sec.classList.toggle('active', on);
    });
    document.querySelectorAll('.navbtn').forEach(function (b) {
      const on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    S.tab = name;
    try { sessionStorage.setItem('ct_tab', name); } catch (e) { /* almacenamiento no disponible */ }
    try { window.scrollTo(0, 0); } catch (e) { /* sin scroll en tests */ }
    renderTab(name);
  }
  CT.switchTab = switchTab;

  function renderTab(name) {
    const fn = CT.parts[name];
    if (typeof fn === 'function') { try { fn(); } catch (e) { banner('bad', 'Error al renderizar ' + name + ': ' + e.message); } }
  }
  CT.renderTab = renderTab;

  function bindTabs() {
    document.querySelectorAll('.navbtn').forEach(function (b) {
      if (b.dataset.bound) return;
      b.dataset.bound = '1';
      b.addEventListener('click', function () { switchTab(b.dataset.tab); });
    });
  }

  // ==================== Modo UI (web-first con botón "Modo Phone") ====================
  // La base visual es web (main 1280, nav superior estática, inputs anchos, sin
  // barra inferior); body.phone-mode reactiva el layout telefónico histórico
  // (nav fija abajo, main 760, inputs 220, padding de barra). Persistido en
  // `ct_ui_mode` ('web' | 'phone'); default **web**. Restaurado al init; el
  // botón sin inline (CSP script-src 'self').
  const LS_UI_MODE = 'ct_ui_mode';

  function readUiMode() {
    try { return localStorage.getItem(LS_UI_MODE) === 'phone' ? 'phone' : 'web'; }
    catch (e) { return 'web'; }
  }
  CT.readUiMode = readUiMode;

  function applyUiMode(mode) {
    const phone = mode === 'phone';
    document.body.classList.toggle('phone-mode', phone);
    const btn = el('btn-ui-mode');
    if (btn) {
      btn.textContent = phone ? 'Modo Web' : 'Modo Phone';
      btn.setAttribute('aria-pressed', phone ? 'true' : 'false');
      // P2: el nombre accesible declara la ACCIÓN (a qué modo se salta),
      // coherente con lo que ocurre al pulsar; aria-pressed indica el estado.
      btn.setAttribute('aria-label', phone ? 'Cambiar a modo Web' : 'Cambiar a modo Phone');
    }
    placeToast();
  }
  CT.applyUiMode = applyUiMode;

  function bindUiMode() {
    const btn = el('btn-ui-mode');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', function () {
      const next = readUiMode() === 'phone' ? 'web' : 'phone';
      try { localStorage.setItem(LS_UI_MODE, next); } catch (e) { /* sin persistencia */ }
      applyUiMode(next);
    });
  }
  CT.bindUiMode = bindUiMode;

  // Hook para el módulo Tasas/Comprobador (otro worker en assets/tasas.js):
  // si tasas.js define CT.renderTasas / CT.renderComprobador, se usan tal cual;
  // mientras falte, se muestra un placeholder honesto en la pestaña Tasas.
  CT.renderTasas = CT.renderTasas || function () {
    ['ta-bcv', 'ta-p2p', 'ta-variaciones', 'ta-multipares', 'ta-vesdetalle', 'ta-diagnostico'].forEach(function (id) {
      const e = el(id);
      if (e && !e.innerHTML) e.innerHTML = '<div class="card"><p class="muted hint">Panel de tasas pendiente: lo carga <code>assets/tasas.js</code>.</p></div>';
    });
  };
  CT.renderComprobador = CT.renderComprobador || function () {
    const e = el('chk-fuegonacional');
    if (e && !e.innerHTML) e.innerHTML = '<p class="muted hint">Comprobador pendiente: lo carga <code>assets/tasas.js</code>.</p>';
  };

  CT.parts.tasas = function () { CT.renderTasas(); CT.renderComprobador(); };

  // ==================== Botón Actualizar + frescura ====================

  function updateBadge() {
    const badge = el('badge-frescura');
    if (!badge) return;
    if (S.fromCache) {
      const mins = Math.floor(ageMin(S.fetchedAt) || 0);
      badge.className = 'badge badge-warn';
      badge.textContent = 'Caché · ' + (mins < 60 ? mins + ' min' : Math.floor(mins / 60) + ' h ' + mins % 60 + ' min');
    } else {
      const fr = freshness(S.rates && S.rates.generatedAt);
      badge.className = 'badge ' + fr.cls;
      const srcLabel = S.updateSource ? ' · ' + esc(S.updateSource) : '';
      badge.textContent = fr.label + (fr.min != null ? ' · ' + Math.round(fr.min) + ' min' : '') + srcLabel;
    }
    const hora = el('hora-caracas');
    if (hora) {
      hora.textContent = S.rates && S.rates.generatedAtCaracas
        ? 'Caracas: ' + String(S.rates.generatedAtCaracas).replace('T', ' ').slice(0, 16)
        : 'Caracas: —';
    }
  }
  CT.updateBadge = updateBadge;

  function bindRefresh() {
    const btn = el('btn-refresh');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', function () { onRefreshClick(); });
    }
  }

  // ==================== EUR manual (permite eurManualUsd / eurManualVes) ====================
  // El fixture actual del bot no publica eurRef: si falta, EUR queda deshabilitado
  // con aviso. El usuario puede llenar el hueco manualmente (nunca se inventa: si
  // el campo está vacío no hay tasa). Persistido en `ct_eur_manual`.

  const LS_EUR = 'ct_eur_manual';
  const LS_CASO = 'ct_caso';        // { pairKey, modoId } selección del caso en curso

  // Modo por defecto al elegir un par sin selección guardada: el cliente deposita
  // la segunda moneda del chip (ba-fwd; zelle-fwd en USD/USD).
  function defaultModoIdOf(pair) {
    if (pair && pair[0] === 'USD' && pair[1] === 'USD') return 'zelle-fwd';
    return 'ba-fwd';
  }

  // ==================== Panel de escenarios (3b/3e) ====================
  // Cada lado (Compra = origen con tasa de compra, Venta = destino con tasa de
  // venta) elige un modo de la misma matriz MAX/BEST/AVG/MIN:
  //  - Máximo (max): 3g — el MAYOR price de TODOS los anuncios del lado, sin
  //    filtro (ya no el tercer anuncio por plataforma).
  //  - Mínimo (min): 3g — el MENOR price de TODOS los anuncios del lado.
  //  - Promedio (average): 3g — media aritmética de TODOS los anuncios del lado
  //    (MAX ≥ AVG ≥ MIN por construcción).
  //  - Mejor (best): precio EJECUTABLE conservador del libro a 40 USD
  //    equivalentes (mayor en compra / menor en venta); queda entre Mínimo y
  //    Máximo (cerca de MAX en compra, cerca de MIN en venta).
  // 2% VES eliminado (3e): sin descuento de seguridad por modo. La seguridad
  // ahora es la tasa manual: si el usuario la activa, manda y se muestra el
  // factor de seguridad = (sistema − manual)/sistema × 100.

  function saveCasoSel() {
    const rec = {
      pairKey: S.pairKey || null,
      modoId: S.modo ? S.modo.id : null,
      // 3e: modos de la matriz y tasas manuales del panel viven en el mismo
      // registro (sin clave nueva de storage).
      scOriginMode: S.scOriginMode || null,
      scDestMode: S.scDestMode || null,
      scOriginManual: S.scOriginManual,
      scDestManual: S.scDestManual
    };
    try { localStorage.setItem(LS_CASO, JSON.stringify(rec)); } catch (e) { /* sin persistencia */ }
    try { sessionStorage.setItem(LS_CASO, JSON.stringify(rec)); } catch (e) { /* sin persistencia */ }
  }

  // Selección guardada válida { pairKey, modoId, sc* } o null (par/modo desconocidos → descarta).
  function readCasoSel() {
    let raw = null;
    try { raw = localStorage.getItem(LS_CASO) || sessionStorage.getItem(LS_CASO); } catch (e) { return null; }
    if (!raw) return null;
    try {
      const rec = JSON.parse(String(raw));
      if (!rec || typeof rec !== 'object') return null;
      const pairKey = String(rec.pairKey || '');
      const pair = pairOfKey(pairKey);
      if (!pair) return null;
      const modoId = String(rec.modoId || '');
      const modos = modosFor(pair).filter(function (m) { return m.enabled && m.id === modoId; });
      // 3e: modos de la matriz + tasas manuales persisten en el mismo registro
      // ct_caso; se validan contra los modos existentes.
      const modes = scModesFor(pair);
      const om = modes.some(function (m) { return m.id === rec.scOriginMode; }) ? rec.scOriginMode : null;
      const dm = modes.some(function (m) { return m.id === rec.scDestMode; }) ? rec.scDestMode : null;
      const omNum = Number(rec.scOriginManual);
      const dmNum = Number(rec.scDestManual);
      return {
        pairKey: pairKey,
        modoId: modos[0] ? modos[0].id : null,
        scOriginMode: om,
        scDestMode: dm,
        scOriginManual: Number.isFinite(omNum) && omNum > 0 ? omNum : null,
        scDestManual: Number.isFinite(dmNum) && dmNum > 0 ? dmNum : null
      };
    } catch (e) { return null; }
  }

  function readManualEur() {
    try {
      const raw = localStorage.getItem(LS_EUR);
      const m = raw ? JSON.parse(raw) : null;
      if (!m || typeof m !== 'object') return { eurUsd: null, eurVes: null };
      const eurUsd = Number(m.eurUsd);
      const eurVes = Number(m.eurVes);
      return {
        eurUsd: Number.isFinite(eurUsd) && eurUsd > 0 ? eurUsd : null,
        eurVes: Number.isFinite(eurVes) && eurVes > 0 ? eurVes : null
      };
    } catch (e) { return { eurUsd: null, eurVes: null }; }
  }
  CT.readManualEur = readManualEur;

  function saveManualEur(eurUsd, eurVes) {
    try {
      localStorage.setItem(LS_EUR, JSON.stringify({ eurUsd: eurUsd || null, eurVes: eurVes || null }));
    } catch (e) { /* sin persistencia */ }
    applyEurManual();
    renderTab('tasas');
    renderTab('casos');
  }
  CT.saveManualEur = saveManualEur;

  // Si el snapshot no trae eurRef, llena unitsPerUsd.EUR con la tasa manual
  // (misma convención que buildFx: 1 EUR = eurUsd USD). Informativa eurVes.
  function applyEurManual() {
    if (!S.fx || !globalThis.CTEngine) return;
    const m = readManualEur();
    S.fx.eurManual = null;
    if (S.fx.unitsPerUsd.EUR == null && m.eurUsd != null) {
      S.fx.unitsPerUsd.EUR = S.fx.unitsPerUsdCompra.EUR = S.fx.unitsPerUsdVenta.EUR = m.eurUsd;
      S.fx.eurManual = { eurUsd: m.eurUsd, eurVes: m.eurVes };
      S.fx.warnings.push('EUR usa tasa manual ingresada por el usuario (' + m.eurUsd + ' USD por 1 EUR): no proviene del snapshot.');
    }
  }

  // ==================== Fetch / caché del snapshot ====================

  // Override manual ?local=1: fuerza el snapshot local ./data/rates.json (mismo
  // origen) aunque el host sea remoto; útil cuando la app se sirve por túnel con
  // ./data montado en el servidor del túnel. Sin flag, nada cambia.
  function wantsLocalSnapshot() {
    const search = (globalThis.location && globalThis.location.search) || '';
    if (!search) return false;
    try {
      if (typeof URLSearchParams === 'function') {
        return new URLSearchParams(search).get('local') === '1';
      }
    } catch (e) { /* navegador sin URLSearchParams */ }
    return /(^|[?&])local=1(&|$)/.test(search);
  }

  function ratesUrl() {
    // GitHub siempre (data branch). ?local=1 fuerza ./data/ como fallback dev (etiquetado "local (no publicado)").
    const host = (globalThis.location && globalThis.location.hostname) || '';
    if (host === 'localhost' || host === '127.0.0.1' || wantsLocalSnapshot()) {
      return './data/rates.json?t=' + Date.now();
    }
    return RATE_URL + '?t=' + Date.now();
  }
  CT.ratesUrl = ratesUrl;

  function readCachedRates() {
    try {
      const raw = localStorage.getItem(LS_RATES);
      if (!raw) return null;
      const rec = JSON.parse(raw);
      return (rec && rec.data) ? rec : null;
    } catch (e) { return null; }
  }
  CT.readCachedRates = readCachedRates;

  function readCachedRatesPrev() {
    try {
      const raw = localStorage.getItem(LS_RATES_PREV);
      if (!raw) return null;
      const rec = JSON.parse(raw);
      return (rec && rec.data) ? rec : null;
    } catch (e) { return null; }
  }
  CT.readCachedRatesPrev = readCachedRatesPrev;

  function applyRates(rec, source) {
    // Guardar snapshot anterior solo si el generatedAt es distinto (evita autodestrucción del prev)
    if (S.rates && S.rates.generatedAt !== rec.data.generatedAt) {
      try { localStorage.setItem(LS_RATES_PREV, JSON.stringify({ data: S.rates, fetchedAt: S.fetchedAt })); } catch (e) { /* sin almacenamiento */ }
    }
    S.rates = rec.data;
    S.fetchedAt = rec.fetchedAt;
    S.rawText = typeof rec.rawText === 'string' ? rec.rawText : null;
    S.updateSource = source || (S.fromCache ? 'cache' : null);
    S.fx = globalThis.CTEngine ? CTEngineBuild(rec.data) : null;
    if (S.fx) applyEurManual();
    updateBadge();
  }

  function CTEngineBuild(rates) {
    if (!globalThis.CTEngine) return null;
    return globalThis.CTEngine.buildFx(rates);
  }

  // getRates(opts): TTL 5 min en `ct_rates`. Con red caída usa la copia guardada y
  // lo dice en el banner y en el badge (nunca caché presentada como en vivo).
  async function getRates(opts) {
    const force = !!(opts && opts.force);
    const source = opts && opts.source ? opts.source : null;
    const cached = readCachedRates();
    if (!force && cached && (Date.now() - new Date(cached.fetchedAt).getTime()) < RATES_TTL_MS) {
      // No re-aplicar si ya tenemos este mismo snapshot (evita ciclos de 60 s)
      if (S.rates && S.rates.generatedAt === cached.data.generatedAt) {
        return S.rates;
      }
      S.updateSource = source || 'cache';
      S.fromCache = false;
      applyRates(cached, source || 'cache');
      return S.rates;
    }
    try {
      const url = ratesUrl();
      const isLocal = url.indexOf('./data/rates.json') >= 0;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      const rec = { data: JSON.parse(text), fetchedAt: new Date().toISOString(), rawText: text };
      try { localStorage.setItem(LS_RATES, JSON.stringify(rec)); } catch (e) { /* almacenamiento lleno */ }
      const prevGen = S.rates && S.rates.generatedAt;
      if (prevGen && !isNewerThan(prevGen, rec.data.generatedAt)) {
        // Solo banner "Sin cambios" con force; auto-refresh no spam
        if (force) banner('warn', 'Sin cambios (último ' + hhmmFromIso(rec.data.generatedAt) + ' UTC).');
        S.fromCache = false;
        S.updateSource = source || (isLocal ? 'local' : 'bot');
        return S.rates;
      }
      S.fromCache = false;
      const src = source || (isLocal ? 'local' : 'bot');
      applyRates(rec, src);
      banner();
    } catch (err) {
      if (cached) {
        applyRates(cached, 'cache');
        S.fromCache = true;
        const mins = Math.floor(ageMin(cached.fetchedAt) || 0);
        banner('bad', 'Sin conexión con la fuente de tasas. Mostrando datos guardados hace ' +
          (mins < 60 ? mins + ' min' : Math.floor(mins / 60) + ' h ' + mins % 60 + ' min') + '.');
      } else {
        S.rates = null;
        S.fx = null;
        S.updateSource = null;
        S.fromCache = false;
        banner('bad', 'No se pudo descargar rates.json y no hay copia guardada en este dispositivo. Pulsa Actualizar.');
      }
    }
    return S.rates;
  }
  CT.getRates = getRates;

  async function refreshRates(force, source) {
    await getRates({ force: force, source: source });
    renderTab(S.tab);
  }
  CT.refreshRates = refreshRates;

  // Hook del botón Actualizar: si el módulo Tasas (assets/tasas.js) define
  // CT.onRefreshClick, el click se le delega (spinner + feedback); mientras
  // falte, se usa el refresco simple (manual).
  function onRefreshClick() {
    if (typeof CT.onRefreshClick === 'function') CT.onRefreshClick();
    else {
      refreshRates(true, 'manual');
    }
  }

  // ==================== CASOS ====================

  function pairCodigos(pair) { return pair[0] + '/' + pair[1]; }

  function todasLasPares() {
    const st = S.ledger.settings;
    return (st.pairs || []).concat(st.customPairs || []);
  }
  CT.todasLasPares = todasLasPares;

  // Cotiza con CTEngine.caseQuoteScenario y comisión editable con el default de
  // la config (7 %; 8 % si el cliente deposita COP). Es la ÚNICA fuente de
  // cotización: desglose y registro consumen este quote. Nunca inventa tasas:
  // sin ads el motor usa la media y el panel lo avisa (estilo warnline).
  // Matriz origen/destino × MAX/BEST/AVG/MIN (3e): la MISMA fila de 4 modos por
  // lado en cualquier par (el 2% ya no existe).
  function scModesFor(pair) {
    return [
      { id: 'max', label: 'Máximo' },
      { id: 'best', label: 'Mejor' },
      { id: 'average', label: 'Promedio' },
      { id: 'min', label: 'Mínimo' }
    ];
  }
  // Default por lado: Mejor (precio conservador a 40 USD eq). Máximo/Promedio/Mínimo elegibles.
  function scDefaultMode(pair) {
    return 'best';
  }
  CT.scModesFor = scModesFor;
  CT.scDefaultMode = scDefaultMode;

  // Chips de pares: settings.pairs + customPairs + el caso USD/USD (Zelle).
  function renderChips() {
    const cont = el('casos-chips');
    if (!cont) return;
    const chips = [];
    todasLasPares().forEach(function (p) {
      const on = pairKey(p) === S.pairKey;
      chips.push('<button type="button" class="btn btn-small' + (on ? ' btn-primary chip-active' : '') +
        '" data-pair="' + esc(pairKey(p)) + '">' + esc(pairCodigos(p)) + '</button>');
    });
    const zOn = S.pairKey === 'USD/USD';
    const z = '<button type="button" class="btn btn-small' + (zOn ? ' btn-primary chip-active' : '') +
      '" data-pair="USD/USD">USD/USD (Zelle)</button>';
    if (zOn) chips.push(z); else chips.unshift(z);
    cont.innerHTML = chips.join(' ');
    cont.querySelectorAll('[data-pair]').forEach(function (b) {
      b.addEventListener('click', function () { selectPair(b.dataset.pair); });
    });
  }

  function pairOfKey(key) {
    if (key === 'USD/USD') return ['USD', 'USD'];
    const parts = String(key || '').split('/');
    if (parts.length !== 2) return null;
    return todasLasPares().filter(function (p) {
      return (p[0] === parts[0] && p[1] === parts[1]) || (p[0] === parts[1] && p[1] === parts[0]);
    })[0] || null;
  }
  CT.pairOfKey = pairOfKey;

  function pairKey(pair) { return pair ? pair[0] + '/' + pair[1] : ''; }
  CT.pairKey = pairKey;

  // 4 modos por par = 2 direcciones (AB/BA) × 2 formas (forward "me depositan" /
  // reverse "necesito entregar", todos activos vía CTEngine.caseQuote con target).
  // USD/USD: forward (margen + override de entrega) e inverso (target => depósito).
  function modosFor(pair) {
    if (!pair) return [];
    if (pair[0] === 'USD' && pair[1] === 'USD') {
      return [
        { id: 'zelle-fwd', label: 'Recibo USD → entrego USD (Zelle)', dir: 'AB', _fwd: true, enabled: true },
        { id: 'zelle-rev', label: 'Necesito entregar USD, recibo USD (Zelle inverso)', dir: 'BA', _fwd: false, enabled: true }
      ];
    }
    const a = pair[0], b = pair[1];
    return [
      { id: 'ab-fwd', label: 'Me depositan ' + a + ' → entrego ' + b, dir: 'AB', _fwd: true, enabled: true },
      { id: 'ab-rev', label: 'Necesito ' + b + ' → me depositan ' + a, dir: 'AB', _fwd: false, enabled: true },
      { id: 'ba-fwd', label: 'Me depositan ' + b + ' → entrego ' + a, dir: 'BA', _fwd: true, enabled: true },
      { id: 'ba-rev', label: 'Necesito ' + a + ' → me depositan ' + b, dir: 'BA', _fwd: false, enabled: true }
    ];
  }
  CT.modosFor = modosFor;

  function selectPair(key) {
    S.pairKey = pairOfKey(key) ? key : 'USD/USD';
    const modos = modosFor(pairOfKey(S.pairKey)).filter(function (m) { return m.enabled; });
    // Modo por defecto coherente con el chip: el cliente deposita B del par (ba-fwd).
    const defId = defaultModoIdOf(pairOfKey(S.pairKey));
    S.modo = modos.filter(function (m) { return m.id === defId; })[0] || modos[0] || null;
    // Reset del panel de escenarios (3b/3c/3e) ANTES de saveCasoSel (P1: si el
    // reset va después, ct_caso guarda los modos/manuales del par ANTERIOR bajo
    // la clave del par nuevo y al recargar la manual de un par se aplica a otro).
    // Vuelve al default del par (Mejor) y a la comisión default de la config
    // (7 %; 8 % si el cliente deposita COP). Las tasas manuales son del par: se
    // limpian al cambiar.
    const scPair = pairOfKey(S.pairKey);
    S.scOriginMode = scDefaultMode(scPair);
    S.scDestMode = scDefaultMode(scPair);
    S.scOriginManual = null;
    S.scDestManual = null;
    const escOriginManual = el('casos-esc-origin-manual');
    if (escOriginManual) escOriginManual.value = '';
    const escDestManual = el('casos-esc-dest-manual');
    if (escDestManual) escDestManual.value = '';
    saveCasoSel();
    // Reset del formulario al cambiar par
    const montoEl = el('casos-monto');
    if (montoEl) montoEl.value = '';
    const resultEl = el('casos-resultado');
    if (resultEl) resultEl.innerHTML = '';
    const escCom = el('casos-esc-comision');
    if (escCom) {
      escCom.value = String(defaultCommissionPct(currenciesInPlay().currencyIn));
      // P2: el default del nuevo par manda: una edición previa (dataset.touched)
      // no debe sobrevivir al cambio de par.
      delete escCom.dataset.touched;
    }
    const obsEl = el('casos-obs');
    if (obsEl) obsEl.value = '';
    // Limpiar selects de cuenta para que no persista la selección del par anterior
    const inSel = el('casos-cuenta-in');
    if (inSel) inSel.value = '';
    const outSel = el('casos-cuenta-out');
    if (outSel) outSel.value = '';
    // Limpiar casilla de tercero (tercero off por defecto)
    const tercero = el('casos-tercero');
    if (tercero) tercero.checked = false;
    // Limpiar margen Zelle
    const marginEl = el('casos-margin');
    if (marginEl) marginEl.value = '';
    // Limpiar warnings previos del banner
    banner();
    renderCasos();
  }
  CT.selectPair = selectPair;

  function renderModos() {
    const cont = el('casos-modos');
    if (!cont) return;
    const pair = pairOfKey(S.pairKey);
    const modos = modosFor(pair);
    cont.innerHTML = modos.map(function (m) {
      const active = S.modo && S.modo.id === m.id;
      return '<button type="button" class="btn btn-small' + (active ? ' btn-primary mode-active' : '') +
        '" data-modo="' + esc(m.id) + '">' + esc(m.label) + '</button>';
    }).join(' ');
    cont.querySelectorAll('[data-modo]').forEach(function (b) {
      b.addEventListener('click', function () {
        const m = modos.filter(function (mm) { return mm.id === b.dataset.modo; })[0];
        if (m) { S.modo = m; saveCasoSel(); renderCasos(); }
      });
    });
  }

  function currenciesInPlay() {
    const pair = pairOfKey(S.pairKey);
    if (!pair) return null;
    if (pair[0] === 'USD' && pair[1] === 'USD') return { currencyIn: 'USD', currencyOut: 'USD' };
    const dir = S.modo && S.modo.dir === 'BA' ? 'BA' : 'AB';
    return dir === 'AB' ? { currencyIn: pair[0], currencyOut: pair[1] } : { currencyIn: pair[1], currencyOut: pair[0] };
  }

  function defaultCommissionPct(id) {
    const s = S.ledger.settings;
    // Redondeo a 2 decimales: evita artefactos binarios (0.07 × 100 = 7.000…1).
    const v = id === 'COP' ? (s.commissionCop || 0.08) * 100 : (s.commissionDefault || 0.07) * 100;
    return Math.round(v * 100) / 100;
  }

  function primaryOf(code) {
    const list = S.ledger.accounts.filter(function (a) { return a.currency === code && !a.archived; });
    return list.filter(function (a) { return a.primary; })[0] || list[0] || null;
  }

  function accountOptions(code, selectedId, includeExternal) {
    const opts = [];
    if (includeExternal) opts.push('<option value=""' + (!selectedId ? ' selected' : '') + '>— externo (sin cuenta) —</option>');
    S.ledger.accounts.filter(function (a) { return a.currency === code && !a.archived; }).forEach(function (a) {
      opts.push('<option value="' + esc(a.id) + '"' + (a.id === selectedId ? ' selected' : '') + '>' +
        esc(a.name) + (a.primary ? ' · primaria' : '') + '</option>');
    });
    return opts.join('');
  }

  function renderCuentaSelects() {
    const c = currenciesInPlay();
    if (!c) return;
    const inSel = el('casos-cuenta-in'), outSel = el('casos-cuenta-out');
    if (!inSel || !outSel) return;
    // No preservar selección previa: al cambiar par, las cuentas del par anterior
    // pueden no corresponder al nuevo par (p. ej. VES/PEN → VES/COP).
    const defIn = primaryOf(c.currencyIn), defOut = primaryOf(c.currencyOut);
    const selIn = defIn ? defIn.id : '';
    const hasOutAccounts = S.ledger.accounts.some(function (a) { return a.currency === c.currencyOut && !a.archived; });
    const selOut = hasOutAccounts ? (defOut ? defOut.id : '') : '';
    inSel.innerHTML = accountOptions(c.currencyIn, selIn, false);
    outSel.innerHTML = accountOptions(c.currencyOut, selOut, true);
    inSel.value = selIn;
    outSel.value = selOut;
  }

  // Panel EUR manual: solo visible si el caso involucra EUR y el snapshot no trae eurRef.
  function renderEurPanel() {
    const holder = el('casos-resultado');
    let panel = el('casos-eur-panel');
    const c = currenciesInPlay();
    const needsEur = !!(c && (c.currencyIn === 'EUR' || c.currencyOut === 'EUR'));
    const missing = needsEur && S.fx && S.fx.unitsPerUsd.EUR == null;
    if (!missing) { if (panel) panel.remove(); return; }
    if (panel) { panel.hidden = false; return; }
    panel = document.createElement('div');
    panel.id = 'casos-eur-panel';
    panel.className = 'card';
    panel.innerHTML =
      '<h2>EUR manual (el snapshot no trae eurRef)</h2>' +
      '<label for="eur-manual-usd">EUR por 1 USD (referencial)</label>' +
      '<input id="eur-manual-usd" type="number" inputmode="decimal" step="any" min="0" autocomplete="off" placeholder="Ej: 0,92">' +
      '<label for="eur-manual-ves">Bs por 1 EUR (informativo)</label>' +
      '<input id="eur-manual-ves" type="number" inputmode="decimal" step="any" min="0" autocomplete="off">' +
      '<button type="button" id="eur-manual-ok" class="btn btn-primary btn-big">Usar esta tasa EUR</button>';
    holder.appendChild(panel);
    const saved = readManualEur();
    el('eur-manual-usd').value = saved.eurUsd != null ? String(saved.eurUsd) : '';
    el('eur-manual-ves').value = saved.eurVes != null ? String(saved.eurVes) : '';
    el('eur-manual-ok').addEventListener('click', function () {
      const u = parseFloat(el('eur-manual-usd').value);
      const v = parseFloat(el('eur-manual-ves').value);
      if (!Number.isFinite(u) || u <= 0) { toast('La tasa EUR/USD manual debe ser un número > 0.'); return; }
      saveManualEur(u, Number.isFinite(v) && v > 0 ? v : null);
      toast('Tasa EUR manual aplicada.');
    });
  }

  function renderForm() {
    const c = currenciesInPlay();
    if (!c) return;
    const title = el('casos-titulo');
    if (title) title.textContent = 'Caso ' + (S.pairKey === 'USD/USD' ? 'USD/USD (Zelle)' : pairCodigos(pairOfKey(S.pairKey)));
    const montoLabel = el('casos-monto-label');
    if (montoLabel) {
      montoLabel.textContent = S.modo && !S.modo._fwd
        ? 'Tú entregas: ' + c.currencyOut + ' (monto objetivo a entregar)'
        : 'Cliente deposita: ' + c.currencyIn;
    }
    const zelleExtra = el('casos-zelle-extra');
    if (zelleExtra) zelleExtra.hidden = S.pairKey !== 'USD/USD';
    // En inverso la entrega la fija el monto: el override no aplica.
    const ovr = el('casos-override');
    if (ovr) ovr.disabled = !!(S.modo && !S.modo._fwd);
    // La comisión del caso es la del panel (casos-esc-comision): UNA sola fuente.
    // Init desde defaultCommissionPct (7 %; 8 % si el cliente deposita COP);
    // editable por operación: una vez tocada, los renders no la pisan.
    const escCom = el('casos-esc-comision');
    if (escCom && escCom.dataset.touched !== '1') {
      escCom.value = String(defaultCommissionPct(c.currencyIn));
    }
    renderModos();
    renderCuentaSelects();
  }

  // Cotización legacy del caso Zelle (USD/USD): solo se usa ahí (desglose y
  // registro). Los pares fiat cotizan con quoteEscenario (caseQuoteScenario);
  // la comisión editable vive única en casos-esc-comision.
  function quoteCase() {
    const qSettings = Object.assign({}, S.ledger.settings);
    const monto = parseFloat(el('casos-monto') && el('casos-monto').value);
    const reverse = !!(S.modo && !S.modo._fwd);
    const marginRaw = parseFloat(el('casos-margin') && el('casos-margin').value);
    if (Number.isFinite(marginRaw) && marginRaw >= 0 && marginRaw < 100) qSettings.zelleMargin = marginRaw / 100;
    const reqZ = { pair: ['USD', 'USD'] };
    if (reverse) {
      reqZ.target = Number.isFinite(monto) ? monto : undefined; // inverso: la entrega queda fijada
    } else {
      reqZ.deposit = Number.isFinite(monto) ? monto : undefined;
      const overrideRaw = parseFloat(el('casos-override') && el('casos-override').value);
      reqZ.deliveredOverride = Number.isFinite(overrideRaw) && overrideRaw > 0 ? overrideRaw : undefined;
    }
    return globalThis.CTEngine.caseQuote(qSettings, S.fx, reqZ);
  }
  CT.quoteCase = quoteCase;

  // ==================== Cotización del panel de escenarios (3b) ====================

  /* ads del snapshot → motor: rateScenarios lee fx.pairs[cur].ads como un array
   * plano de {price,min,max,available} (adRateAt filtra min/max/available y usa
   * ad.price). El ORIGEN siempre usa la lista `compra` (asc) y el DESTINO la
   * lista `venta` (desc): se arma fx.pairs por cotización para no mezclar lados.
   * Sin ads para una moneda → la clave no va y el motor cae a la media FX. */
  function adsArrOf(code, side) {
    const p = S.rates && S.rates.pairs && S.rates.pairs[code];
    const arr = p && p.ads && p.ads[side];
    return Array.isArray(arr) ? arr : null;
  }

  function scenarioFx(origin, dest) {
    if (!S.fx) return null;
    if (!S.rates) return S.fx;
    const buy = adsArrOf(origin, 'compra');
    const sell = adsArrOf(dest, 'venta');
    if (!buy && !sell) return S.fx;
    const fx = Object.assign({}, S.fx);
    fx.pairs = {};
    if (buy) fx.pairs[origin] = { ads: buy };
    if (sell) fx.pairs[dest] = { ads: sell };
    return fx;
  }

  // req compartido del motor de escenarios: lo usan quoteEscenario (panel/desglose)
  // y registrarCaso (registro) — UNA sola cotización para ambos. Pasos:
  //   - modos de la matriz del panel: originMode/destMode (max/best/average/min);
  //   - tasas manuales del panel (3e): si el usuario activa una, manda sobre la
  //     del sistema (originManualRate/destManualRate);
  //   - comisión editable del panel en fracción (req.commissionPct);
  //   - monto compartido con el caso (forward = deposit, inverso = target +
  //     reversed:true, como exige el motor de escenarios).
  function scenarioReq() {
    syncManualRates();
    const reverse = !!(S.modo && !S.modo._fwd);
    const monto = parseFloat(el('casos-monto') && el('casos-monto').value);
    const req = {
      pair: pairOfKey(S.pairKey).slice(),
      direction: S.modo && S.modo.dir === 'BA' ? 'BA' : 'AB',
      originMode: S.scOriginMode,
      destMode: S.scDestMode,
      originManualRate: S.scOriginManual || undefined,
      destManualRate: S.scDestManual || undefined
    };
    const comision = parseFloat(el('casos-esc-comision') && el('casos-esc-comision').value);
    if (Number.isFinite(comision) && comision >= 0 && comision <= 100) req.commissionPct = comision / 100;
    if (reverse) {
      req.target = monto;
      req.reversed = true;
    } else {
      req.deposit = monto;
    }
    return req;
  }

  // P2: parseo de las manuales del panel (mismo criterio que scenarioReq)
  // compartido por la cotización y el listener de persistencia: con #casos-monto
  // vacío la cotización aborta antes de scenarioReq, así que la persistencia debe
  // fijar S.scOriginManual/S.scDestManual por sí misma.
  function syncManualRates() {
    const omManual = parseFloat(el('casos-esc-origin-manual') && el('casos-esc-origin-manual').value);
    const dmManual = parseFloat(el('casos-esc-dest-manual') && el('casos-esc-dest-manual').value);
    S.scOriginManual = Number.isFinite(omManual) && omManual > 0 ? omManual : null;
    S.scDestManual = Number.isFinite(dmManual) && dmManual > 0 ? dmManual : null;
  }

  // Cotización del panel (y del desglose/registro): delega en
  // CTEngine.caseQuoteScenario.
  function quoteEscenario() {
    const pair = pairOfKey(S.pairKey);
    if (!globalThis.CTEngine || !S.fx || !S.ledger || !pair) {
      return { ok: false, error: 'Sin tasas del snapshot: no se puede cotizar. Pulsa Actualizar.' };
    }
    const c = currenciesInPlay();
    if (!c) return { ok: false, error: 'Par inválido.' };
    const reverse = !!(S.modo && !S.modo._fwd);
    const monto = parseFloat(el('casos-monto') && el('casos-monto').value);
    if (!Number.isFinite(monto) || monto <= 0) {
      return { ok: false, error: reverse ? 'Monto objetivo (a entregar) inválido.' : 'Monto a depositar inválido.' };
    }
    return globalThis.CTEngine.caseQuoteScenario(S.ledger.settings, scenarioFx(c.currencyIn, c.currencyOut), scenarioReq());
  }
  CT.quoteEscenario = quoteEscenario;

  function setEscenarioModo(side, mode) {
    if (side !== 'origin' && side !== 'dest') return false;
    // Matriz 3e: la misma fila de 4 modos (max/best/average/min) en cualquier par;
    // el 2% (conservative) ya no existe.
    if (!scModesFor(pairOfKey(S.pairKey)).some(function (m) { return m.id === mode; })) return false;
    // 3h exclusión mutua: elegir un modo limpia la tasa manual de ESE lado
    // (input vacío + S.*Manual=null): el modo vuelve a mandar, se recalcula y
    // se persiste la manual null en ct_caso. El otro lado no se toca.
    const manualIn = el(side === 'origin' ? 'casos-esc-origin-manual' : 'casos-esc-dest-manual');
    if (manualIn) manualIn.value = '';
    if (side === 'origin') {
      S.scOriginMode = mode;
      S.scOriginManual = null;
    } else {
      S.scDestMode = mode;
      S.scDestManual = null;
    }
    // P1: el cambio de modo del panel se persiste aquí (sin depender de que el
    // usuario toque después otro control que llame a saveCasoSel).
    saveCasoSel();
    renderEscenario();
    // P0: el desglose (#casos-resultado) cotiza con quoteEscenario, que depende de
    // los modos: repintarlo para que panel y desglose muestren la MISMA cifra y
    // registrarCaso no registre un quote distinto del que el usuario vio.
    if (S.pairKey) renderResultado();
    return true;
  }
  CT.setEscenarioModo = setEscenarioModo;

  // Tasa lateral por modo para los botones del panel (3f): la MISMA matriz
  // Máximo/Mejor/Promedio/Mínimo de la pestaña Tasas evaluada a 40 US$ eq
  // (compra origen / venta destino). Cae a la media FX cuando no hay tasa
  // (nunca inventa); null → el botón muestra solo el nombre.
  function escLateralRates(pair, origin, dest) {
    if (!pair || !globalThis.CTEngine || !S.fx || !S.ledger) return null;
    const scn = globalThis.CTEngine.rateScenarios(
      S.ledger.settings, scenarioFx(origin, dest), [origin, dest], 'AB', 40, 'compra');
    const out = {};
    scModesFor(pair).forEach(function (m) {
      const s = scn && scn[m.id];
      const ro = (s && s.originRate != null) ? s.originRate : (S.fx.unitsPerUsdCompra && S.fx.unitsPerUsdCompra[origin]);
      const rd = (s && s.destRate != null) ? s.destRate : (S.fx.unitsPerUsdVenta && S.fx.unitsPerUsdVenta[dest]);
      out[m.id] = {
        origin: (typeof ro === 'number' && Number.isFinite(ro)) ? fmt(ro, Math.abs(ro) >= 1000 ? 2 : 4) : null,
        dest: (typeof rd === 'number' && Number.isFinite(rd)) ? fmt(rd, Math.abs(rd) >= 1000 ? 2 : 4) : null
      };
    });
    return out;
  }

  function renderEscenarioButtons() {
    const scPair = pairOfKey(S.pairKey);
    const modes = scModesFor(scPair);
    const c = currenciesInPlay();
    const rates = (c && scPair) ? escLateralRates(scPair, c.currencyIn, c.currencyOut) : null;
    [['origin', 'casos-esc-origin'], ['dest', 'casos-esc-dest']].forEach(function (row) {
      const side = row[0], cont = el(row[1]);
      if (!cont) return;
      const active = side === 'origin' ? S.scOriginMode : S.scDestMode;
      // 3h exclusión mutua: con tasa manual activa en el lado, NINGÚN botón de
      // modo aparece seleccionado (aria-pressed=false, sin mode-active) — la
      // manual manda. El modo último/default sigue guardado en S.*Mode y
      // vuelve a seleccionarse solo cuando el usuario borra la manual
      // (renderEscenarioButtons se repinta en cada evento input).
      const manualActive = (side === 'origin' ? S.scOriginManual : S.scDestManual) != null;
      cont.innerHTML = modes.map(function (m) {
        const on = !manualActive && m.id === active;
        const lr = (rates && rates[m.id]) ? rates[m.id][side] : null;
        // 3f: la tasa lateral (compra origen / venta destino) va DENTRO del
        // botón (compacto) y completa en el aria-label.
        const aria = lr
          ? (m.label + ' — ' + (side === 'origin' ? 'compra ' + c.currencyIn + ' ' + lr + ' ' + c.currencyIn + '/US$' : 'venta ' + c.currencyOut + ' ' + lr + ' ' + c.currencyOut + '/US$'))
          : null;
        return '<button type="button" class="btn btn-small btn-sc' + (on ? ' mode-active' : '') +
          '" data-sc-side="' + side + '" data-sc-mode="' + m.id + '" aria-pressed="' + (on ? 'true' : 'false') + '"' +
          (aria ? ' aria-label="' + esc(aria) + '"' : '') + '>' +
          esc(m.label) + (lr ? ' <span class="sc-rate">' + esc(lr) + '</span>' : '') + '</button>';
      }).join(' ');
      cont.querySelectorAll('[data-sc-side]').forEach(function (b) {
        b.addEventListener('click', function () {
          setEscenarioModo(b.dataset.scSide, b.dataset.scMode);
        });
      });
    });
  }

  // Panel 3b: dos filas de escenario + desglose con aria-live="polite" (el
  // resultado se recalcula en el sitio, sin recargar).
  function renderEscenario() {
    const card = el('casos-escenario-card');
    const out = el('casos-escenario');
    if (!card || !out) return;
    // Zelle (USD/USD) no tiene tasas FX: el panel no aplica. Sin snapshot tampoco.
    if (!S.pairKey || S.pairKey === 'USD/USD' || !S.fx || !S.ledger) {
      card.hidden = true;
      out.innerHTML = '';
      return;
    }
    card.hidden = false;
    // Normaliza los modos al par actual: un modo sin botón (p. ej. un 2% activo
    // guardado por una build anterior, o un modo desconocido) vuelve al default
    // del lado. Va antes de cotizar para que el desglose que
    // sigue use el modo normalizado.
    const scPair = pairOfKey(S.pairKey);
    if (!scModesFor(scPair).some(function (m) { return m.id === S.scOriginMode; })) S.scOriginMode = scDefaultMode(scPair);
    if (!scModesFor(scPair).some(function (m) { return m.id === S.scDestMode; })) S.scDestMode = scDefaultMode(scPair);
    const c = currenciesInPlay();
    const oLabel = el('casos-esc-origin-label'), dLabel = el('casos-esc-dest-label');
    if (c && oLabel) oLabel.textContent = 'Compra (origen): ' + c.currencyIn;
    if (c && dLabel) dLabel.textContent = 'Venta (destino): ' + c.currencyOut;
    renderEscenarioButtons();
    const monto = parseFloat(el('casos-monto') && el('casos-monto').value);
    if (!Number.isFinite(monto) || monto <= 0) {
      out.innerHTML = '<p class="muted hint">Ingresa el monto para cotizar el escenario.</p>';
      return;
    }
    const q = quoteEscenario();
    if (!q || !q.ok) {
      out.innerHTML = '<p class="warnline">⚠ ' + esc((q && q.error) || 'No se pudo cotizar el escenario: faltan tasas o ads.') + '</p>';
      return;
    }
    // Etiqueta de fuente de la tasa (bug 3d + 3e): el Promedio puede venir de la
    // media de los anuncios o del fallback a media FX; con tasa manual, manda la
    // que ingresó el usuario.
    const compraAds = adsArrOf(c.currencyIn, 'compra');
    const ventaAds = adsArrOf(c.currencyOut, 'venta');
    const destScn = q.rateInfo && q.rateInfo.destScenarios && q.rateInfo.destScenarios[S.scDestMode];
    const usdtNeto = q.grossUsd * (1 - q.commission);
    const rateSourceLabel = function (src) {
      if (!src) return '';
      if (src === 'manual') return ' · manual (manda la tasa ingresada)';
      if (src.indexOf('ad_average_') === 0) return ' · Promedio de anuncios';
      if (src.indexOf('media(') === 0) return ' · media FX (sin anuncios)';
      return '';
    };
    // Factor de seguridad por lado (3e): % aplicado vs la tasa del sistema;
    // positivo = descuento manual, negativo = recargo. Sin manual → sistema.
    const factorLabel = function (side) {
      if (q.rateInfo[side + 'ManualRate'] == null) return 'Tasa del sistema (sin manual)';
      return fmt(q.rateInfo[side + 'SecurityFactor'], 2) + ' % (sistema ' +
        fmt(q.rateInfo[side + 'SystemRate'], 4) + ' → manual ' + fmt(q.rateInfo[side + 'ManualRate'], 4) + ')';
    };
    const rows = [
      ['Tasa compra usada (origen)', fmt(q.rateInfo.originRate, 4) + ' ' + esc(c.currencyIn) + ' / US$' + rateSourceLabel(q.rateInfo.originSource)],
      ['Tasa venta usada (destino)', fmt(q.rateInfo.destRate, 4) + ' ' + esc(c.currencyOut) + ' / US$' + rateSourceLabel(q.rateInfo.destSource)],
      ['Factor de seguridad (origen)', factorLabel('origin')],
      ['Factor de seguridad (destino)', factorLabel('dest')],
      ['Comisión', fmt(q.commissionPct, 2) + ' %'],
      ['USDT bruto', fmtUsd(q.grossUsd)],
      ['USDT neto', fmtUsd(usdtNeto)],
      ['Moneda destino', esc(q.currencyOut)],
      ['Tasa pactada (efectiva)', fmt(q.rateInfo.effectiveRate, 4) + ' ' + esc(q.currencyOut) + ' / ' + esc(q.currencyIn)],
      ['Monto final', fmtMoney(q.delivered, q.currencyOut)]
    ];
    let html = '<div class="grid2">' + rows.map(function (row) {
      return '<div class="kv"><span class="k">' + esc(row[0]) + '</span><span class="v' +
        (row[0] === 'Monto final' ? ' big' : ' num') + '">' + row[1] + '</span></div>';
    }).join('') + '</div>';
    // Avisos del panel (3g): el motor ya no emite warnings por modo (el Máximo
    // no es el tercer anuncio por plataforma), así que la lista llega vacía y
    // aquí solo se agregan los avisos de fallback a media FX del snapshot.
    const avisos = (q.rateInfo && Array.isArray(q.rateInfo.warnings)) ? q.rateInfo.warnings.slice() : [];
    // “No cubre el monto” SOLO cuando la tasa usada viene del fallback a media FX
    // (bug 3d): el Promedio usa adUsed=null por diseño (no es un anuncio único);
    // si su source es ad_average_*, hay anuncios promediados y no hay aviso.
    const origenMedia = !q.rateInfo.originSource || q.rateInfo.originSource.indexOf('media(') === 0;
    const destMedia = !destScn || !destScn.destSource || destScn.destSource.indexOf('media(') === 0;
    // P2: la manual manda — si la tasa del lado viene del input manual, los
    // avisos de “sin libro / promedio del snapshot” no aplican a ese lado.
    const originManualWin = q.rateInfo.originManualRate != null;
    const destManualWin = q.rateInfo.destManualRate != null;
    if (!originManualWin && !compraAds) {
      avisos.push('Sin libro de anuncios para compra de ' + c.currencyIn + ': el escenario calcula con el promedio del snapshot (no se inventan datos).');
    } else if (!originManualWin && !q.rateInfo.adUsed && origenMedia) {
      avisos.push('El libro de anuncios de ' + c.currencyIn + ' no cubre el monto: se usa el promedio del snapshot.');
    }
    if (!destManualWin && !ventaAds) {
      avisos.push('Sin libro de anuncios para venta de ' + c.currencyOut + ': el escenario calcula con el promedio del snapshot (no se inventan datos).');
    } else if (!destManualWin && destScn && destScn.destAd == null && destMedia) {
      // P2: el libro existe pero ninguna ad cubre el monto → el motor cae a la
      // media del snapshot; se avisa en lugar de mostrar la tasa sin contexto.
      // Con Promedio de anuncios (destAd null + source ad_average_*) NO hay aviso.
      avisos.push('El libro de venta de ' + c.currencyOut + ' no cubre el monto: se usa el promedio del snapshot.');
    }
    if (avisos.length) html += avisos.map(function (a) { return '<p class="warnline">⚠ ' + esc(a) + '</p>'; }).join('');
    out.innerHTML = html;
  }
  CT.renderEscenario = renderEscenario;

  // Utilidades orientadas a prueba/eventos: fijan modo y ejecutan registro.
  CT.setModo = function (id) {
    const modos = modosFor(pairOfKey(S.pairKey));
    const m = modos.filter(function (x) { return x.id === id && x.enabled; })[0];
    if (!m) return false;
    S.modo = m;
    saveCasoSel();
    renderForm();
    renderEscenario();
    renderResultado();
    return true;
 };
  CT.registrarCaso = registrarCaso;

  function adsFor(code) {
    const pairs = S.rates && S.rates.pairs;
    const pairObj = pairs && pairs[code];
    return pairObj && pairObj.ads ? pairObj.ads : null;
  }

  function snapshotLine() {
    const g = S.rates && S.rates.generatedAt ? formatUTC(S.rates.generatedAt) : '—';
    const c = S.rates && S.rates.generatedAtCaracas ? String(S.rates.generatedAtCaracas).replace('T', ' ').slice(0, 16) : '—';
    let origen;
    if (S.updateSource === 'local') origen = 'local (no publicado)';
    else if (S.updateSource === 'cache') origen = 'copia reciente ≤5 min';
    else if (S.fromCache) {
      const mins = Math.floor(ageMin(S.fetchedAt) || 0);
      origen = 'copia guardada hace ' + mins + ' min';
    } else if (S.updateSource) origen = S.updateSource;
    else origen = 'en vivo';
    return esc('Snapshot: ' + g + ' UTC · Caracas ' + (c === '—' ? '—' : c) + ' · fuente: ' + origen);
  }

  function formatUTC(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return String(d.getUTCFullYear()) + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0') + ' ' + String(d.getUTCHours()).padStart(2, '0') + ':' +
      String(d.getUTCMinutes()).padStart(2, '0') + ' UTC';
  }

  function relevantWarnings(q, c) {
    const av = [];
    const w = S.fx ? S.fx.warnings : [];
    w.forEach(function (x) {
      if (x.indexOf(c.currencyIn) >= 0 || x.indexOf(c.currencyOut) >= 0) av.push(x);
    });
    if (q.ok && !q.referencial) {
      // P2: la manual manda (igual que el panel) — si la tasa de un lado viene
      // del input manual (originManualRate/destManualRate), no se muestra el
      // aviso de “promedio del snapshot” de la entrega.
      const originManualWin = q.rateInfo && q.rateInfo.originManualRate != null;
      const destManualWin = q.rateInfo && q.rateInfo.destManualRate != null;
      if (!originManualWin && !destManualWin) {
        const ads = adsFor(c.currencyOut);
        const book = ads && ((ads.venta && ads.venta.length) || (ads.compra && ads.compra.length));
        if (!book) av.push('La entrega calcula con el promedio del snapshot: sin libro de anuncios disponible para ' + c.currencyOut + '.');
      }
    }
    const tercero = el('casos-tercero');
    if (q.ok && q.tercero > 0 && tercero && !tercero.checked) {
      av.push('La casilla de tercero está desmarcada, pero el motor registra el tercero (25 %) en cada operación por defecto.');
    }
    return av;
  }

  const CASE_KEYS = { deposit: 'Cliente deposita', delivered: 'Tú entregas' };

  function casoRows(q, c) {
    const isZelle = S.pairKey === 'USD/USD';
    const usdtNet = q.ok && !isZelle && Number.isFinite(q.grossUsd)
      ? q.grossUsd * (1 - (q.commission || 0)) : null;
    // Tasa pactada: en el quote del escenario (única fuente) es la efectiva; en
    // Zelle la fuente es el margen/override y en el legacy caseQuote el cross.
    const rate = q.ok && q.rateInfo && q.rateInfo.rateInPerOut != null
      ? fmt(q.rateInfo.rateInPerOut, 4) + ' ' + esc(c.currencyOut) + ' por ' + esc(c.currencyIn) + (q.referencial ? ' (referencial)' : '')
      : (q.ok && q.kind === 'scenario' && q.rateInfo && q.rateInfo.effectiveRate != null
        ? fmt(q.rateInfo.effectiveRate, 4) + ' ' + esc(c.currencyOut) + ' / ' + esc(c.currencyIn) + (q.referencial ? ' (referencial)' : '')
        : (q.ok && q.rateInfo && q.rateInfo.source ? esc(q.rateInfo.source) : '—'));
    return [
      // El desglose nombra la moneda explícitamente: nunca se presta a confusión
      // de dirección (el depósito siempre es currencyIn, la entrega currencyOut).
      [CASE_KEYS.deposit + ': ' + c.currencyIn, fmtMoney(q.deposit, c.currencyIn)],
      [CASE_KEYS.delivered + ': ' + c.currencyOut, fmtMoney(q.delivered, c.currencyOut)],
      ['Tasa pactada', rate],
      ['USDT bruto', isZelle ? fmtUsd(q.deposit) : fmtUsd(q.grossUsd)],
      ['USDT neto', isZelle ? fmtUsd(q.delivered) : fmtUsd(usdtNet)],
      ['Plusvalía', fmtUsd(q.profitUsd)],
      ['Diezmo (10 %)', fmtUsd(q.diezmo)],
      ['Tercero (25 %)', fmtUsd(q.tercero)],
      ['Neto para mí', fmtUsd(q.neto)],
      ['Cuenta del depósito', nameOf(el('casos-cuenta-in') && el('casos-cuenta-in').value)],
      ['Cuenta de la entrega', nameOf(el('casos-cuenta-out') && el('casos-cuenta-out').value)]
    ];
  }

  function nameOf(id) {
    const a = id && CTEngineAccount(id);
    return a ? a.name : '— externo —';
  }

  function CTEngineAccount(id) {
    const list = S.ledger ? S.ledger.accounts : [];
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function renderResultado() {
    const holder = el('casos-resultado');
    if (!holder) return;
    const c = currenciesInPlay();
    if (!c) { holder.innerHTML = ''; return; }
    if (!S.fx) {
      holder.innerHTML = '<div class="card"><p class="warnline">Sin tasas del snapshot: no se puede cotizar. Pulsa Actualizar.</p></div>';
      return;
    }
    // Una sola cotización: pares fiat usan el quote del panel de escenarios
    // (caseQuoteScenario, misma comisión/modos que ve el usuario); Zelle no
    // tiene tasas FX y mantiene su quoteCase legacy.
    const q = S.pairKey === 'USD/USD' ? quoteCase() : quoteEscenario();
    const reverse = !!(S.modo && !S.modo._fwd);
    const bigKey = reverse
      ? CASE_KEYS.deposit + ': ' + c.currencyIn
      : CASE_KEYS.delivered + ': ' + c.currencyOut;
    let html = '';
    if (!q.ok) {
      html = '<div class="card"><p class="warnline">⚠ ' + esc(q.error || 'No se pudo cotizar el caso.') + '</p></div>';
    } else {
      html = '<div class="card"><h2>Desglose del caso</h2>' +
        '<div class="grid2">' + casoRows(q, c).map(function (row) {
          return '<div class="kv"><span class="k">' + esc(row[0]) + '</span><span class="v' +
            (row[0] === bigKey ? ' big' : ' num') + '">' + row[1] + '</span></div>';
        }).join('') + '</div>' +
        '<p class="muted hint">' + snapshotLine() + '</p>';
      const avisos = relevantWarnings(q, c);
      if (avisos.length) html += avisos.map(function (a) { return '<p class="warnline">⚠ ' + esc(a) + '</p>'; }).join('');
      html += '<button type="button" class="btn btn-primary btn-big" data-action="registrar">Registrar operación</button>' +
        '</div>';
    }
    holder.innerHTML = html;
    renderEurPanel();
  }

  function registrarCaso() {
    const c = currenciesInPlay();
    if (!c) return;
    const obs = (el('casos-obs') && el('casos-obs').value) || '';
    const inAcc = (el('casos-cuenta-in') && el('casos-cuenta-in').value) || null;
    const outRaw = el('casos-cuenta-out') ? el('casos-cuenta-out').value : '';
    const outAcc = outRaw === '' ? null : outRaw;
    const execState = Object.assign({}, S.ledger, { settings: Object.assign({}, S.ledger.settings) });
    let req, fx;
    if (S.pairKey === 'USD/USD') {
      // Zelle: cotización legacy (el panel de escenarios no aplica, sin tasas FX).
      const q = quoteCase();
      if (!q.ok) { toast(q.error || 'No se puede registrar: caso inválido.'); return; }
      const reverse = !!(S.modo && !S.modo._fwd);
      // El margen Zelle se transfiere por copia: en inverso determina el depósito registrado.
      const marginRaw2 = parseFloat(el('casos-margin') && el('casos-margin').value);
      if (Number.isFinite(marginRaw2) && marginRaw2 >= 0 && marginRaw2 < 100) execState.settings.zelleMargin = marginRaw2 / 100;
      req = reverse
        ? { pair: ['USD', 'USD'], target: q.delivered, date: todayISO(), depositAccount: inAcc, deliverAccount: outAcc, note: (obs || undefined) }
        : {
            pair: ['USD', 'USD'], deposit: q.deposit,
            deliveredOverride: q.overridden ? q.delivered : undefined,
            date: todayISO(), depositAccount: inAcc, deliverAccount: outAcc, note: (obs || undefined)
          };
      fx = S.fx;
    } else {
      // P0 — UNA sola cotización: se registra el MISMO quote que muestra el
      // desglose (caseQuoteScenario con los modos/comisión/monto del panel).
      // executeCase lo delega al motor de escenarios vía originMode/destMode.
      const q = quoteEscenario();
      if (!q.ok) { toast(q.error || 'No se puede registrar: caso inválido.'); return; }
      req = scenarioReq();
      req.date = todayISO();
      req.depositAccount = inAcc;
      req.deliverAccount = outAcc;
      req.note = obs || undefined;
      fx = scenarioFx(c.currencyIn, c.currencyOut);
    }
    try {
      const r = globalThis.CTEngine.executeCase(execState, fx, req);
      // movements comparte el array con S.ledger: persistimos el ledger real.
      globalThis.CTEngine.save(S.ledger);
      toast('Operación registrada (movimiento #' + r.movement.seq + ').');
      renderCuentas();
      renderBalance();
      renderHistorico();
      renderResultado();
    } catch (e) {
      toast('No se pudo registrar: ' + e.message);
    }
  }

  function bindCasos() {
    const addBtn = el('casos-addpair');
    if (addBtn && !addBtn.dataset.bound) {
      addBtn.dataset.bound = '1';
      addBtn.addEventListener('click', function () {
        const panel = el('casos-addpanel');
        if (!panel) return;
        panel.hidden = !panel.hidden;
        if (!panel.hidden) renderPairSelects();
      });
    }
    const addOk = el('casos-addpair-ok');
    if (addOk && !addOk.dataset.bound) {
      addOk.dataset.bound = '1';
      addOk.addEventListener('click', addCustomPair);
    }
    const addCancel = el('casos-addpair-cancel');
    if (addCancel && !addCancel.dataset.bound) {
      addCancel.dataset.bound = '1';
      addCancel.addEventListener('click', function () {
        const panel = el('casos-addpanel');
        if (panel) panel.hidden = true;
        const msg = el('casos-addpair-msg');
        if (msg) msg.textContent = '';
      });
    }
    ['casos-monto', 'casos-margin', 'casos-override', 'casos-esc-comision',
     'casos-esc-origin-manual', 'casos-esc-dest-manual'].forEach(function (id) {
      const f = el(id);
      if (f && !f.dataset.bound) {
        f.dataset.bound = '1';
        f.addEventListener('input', renderResultadoSafe);
      }
    });
    ['casos-esc-origin-manual', 'casos-esc-dest-manual'].forEach(function (id) {
      const f = el(id);
      if (f && !f.dataset.persistBound) {
        f.dataset.persistBound = '1';
        // P2: persiste ct_caso en el mismo evento input, pero parseando aquí
        // las manuales (syncManualRates): con #casos-monto vacío renderResultado
        // aborta sin llegar a scenarioReq y la manual quedaría sin guardar.
        f.addEventListener('input', function () {
          if (!S.pairKey) return;
          syncManualRates();
          saveCasoSel();
        });
      }
    });
    const escComInput = el('casos-esc-comision');
    if (escComInput && !escComInput.dataset.touchBound) {
      escComInput.dataset.touchBound = '1';
      escComInput.addEventListener('input', function () { escComInput.dataset.touched = '1'; });
    }
    const tercero = el('casos-tercero');
    if (tercero && !tercero.dataset.bound) {
      tercero.dataset.bound = '1';
      tercero.addEventListener('change', renderResultadoSafe);
    }
    const obs = el('casos-obs');
    if (obs && !obs.dataset.bound) {
      obs.dataset.bound = '1';
    }
    ['casos-cuenta-in', 'casos-cuenta-out'].forEach(function (id) {
      const s = el(id);
      if (s && !s.dataset.bound) {
        s.dataset.bound = '1';
        s.addEventListener('change', renderResultadoSafe);
      }
    });
    const holder = el('casos-resultado');
    if (holder && !holder.dataset.bound) {
      holder.dataset.bound = '1';
      holder.addEventListener('click', function (ev) {
        const t = ev.target && ev.target.closest ? ev.target.closest('[data-action="registrar"]') : null;
        if (t) registrarCaso();
      });
    }
  }

  // P1-fix (revisión 3h): syncManualRates ANTES de repintar — con #casos-monto
  // vacío quoteEscenario aborta sin llegar a scenarioReq y el listener de
  // persistencia corre después de este: sin el sync aquí, los botones de modo
  // quedarían repintados con la manual vieja (preset no deseleccionado).
  function renderResultadoSafe() { if (S.pairKey) { syncManualRates(); renderResultado(); renderEscenario(); } }
  CT.renderResultado = renderResultado;

  function renderPairSelects() {
    const a = el('casos-pair-a'), b = el('casos-pair-b');
    if (!a || !b) return;
    const codes = globalThis.CTEngine ? globalThis.CTEngine.CURRENCIES : [];
    const opts = codes.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
    a.innerHTML = opts; b.innerHTML = opts;
    a.value = 'VES'; b.value = 'EUR';
  }

  function addCustomPair() {
    const a = el('casos-pair-a'), b = el('casos-pair-b');
    const msg = el('casos-addpair-msg');
    if (!a || !b) return;
    const ca = a.value, cb = b.value;
    if (!ca || !cb) return;
    if (ca === cb) { if (msg) msg.textContent = 'Elegí dos monedas distintas.'; return; }
    if (todasLasPares().some(function (p) { return (p[0] === ca && p[1] === cb) || (p[0] === cb && p[1] === ca); })) {
      if (msg) msg.textContent = 'El par ya está en tu lista.';
      return;
    }
    S.ledger.settings.customPairs.push([ca, cb]);
    globalThis.CTEngine.save(S.ledger);
    if (msg) msg.textContent = 'Par ' + ca + '/' + cb + ' agregado.';
    const panel = el('casos-addpanel');
    if (panel) panel.hidden = true;
    renderChips();
  }

  // Render principal de la pestaña Casos (lazy + en cada actualización de tasas).
  function renderCasos() {
    if (!S.pairKey) {
      // Estado inicial determinista: si hay selección guardada (par+modo) se
      // restaura; si no, VES/PEN con “Me depositan PEN → entrego Bs” (ba-fwd).
      const saved = readCasoSel();
      if (saved && saved.modoId) {
        S.pairKey = saved.pairKey;
        S.modo = modosFor(pairOfKey(S.pairKey)).filter(function (m) { return m.enabled && m.id === saved.modoId; })[0] || null;
      }
      // 3e: restaurar modos de la matriz + tasas manuales del panel (mismo ct_caso).
      if (saved) {
        if (saved.scOriginMode) S.scOriginMode = saved.scOriginMode;
        if (saved.scDestMode) S.scDestMode = saved.scDestMode;
        S.scOriginManual = saved.scOriginManual || null;
        S.scDestManual = saved.scDestManual || null;
      }
      const omIn = el('casos-esc-origin-manual');
      if (omIn) omIn.value = S.scOriginManual != null ? String(S.scOriginManual) : '';
      const dmIn = el('casos-esc-dest-manual');
      if (dmIn) dmIn.value = S.scDestManual != null ? String(S.scDestManual) : '';
      if (!S.pairKey) S.pairKey = pairKey(todasLasPares()[0]) || 'USD/USD';
      if (!S.modo) {
        const defId = defaultModoIdOf(pairOfKey(S.pairKey));
        const modos = modosFor(pairOfKey(S.pairKey)).filter(function (m) { return m.enabled; });
        S.modo = modos.filter(function (m) { return m.id === defId; })[0] || modos[0] || null;
      }
      saveCasoSel();
    }
    if (!S.fx) { // sin snapshot todavía: chips visibles, resultado vacío
      renderChips();
      const holder = el('casos-resultado');
      if (holder) holder.innerHTML = '<div class="card"><p class="muted hint">Cargando tasas…</p></div>';
      return;
    }
    renderChips();
    renderForm();
    renderEscenario();
    renderResultado();
  }
  CT.renderCasos = renderCasos;
  CT.parts.casos = renderCasos;
  // ==================== CUENTAS ====================

  function renderCuentas() {
    if (!S.ledger) return;
    const avisos = el('cuentas-avisos');
    if (avisos) {
      avisos.innerHTML = S.ledger.accounts
        .map(function (a) { return a.currency; })
        .filter(function (c, i, arr) { return arr.indexOf(c) === i; })
        .filter(function (c) { return S.fx && S.fx.unitsPerUsd[c] == null && globalThis.CTEngine.CURRENCIES.indexOf(c) >= 0 && c !== 'USD'; })
        .map(function (c) { return '<p class="warnline">⚠ Sin tasa publicada para ' + esc(c) + ': su balance no se valora en USD (saldo nativo intacto).</p>'; })
        .join('');
    }
    const cont = el('cuentas-lista');
    if (!cont) return;
    const eng = globalThis.CTEngine;
    cont.innerHTML = S.ledger.accounts.map(function (a) {
      const b = eng.accountBalance(S.ledger, a.id);
      const usd = S.fx && S.fx.unitsPerUsd[a.currency] != null ? b.native / S.fx.unitsPerUsd[a.currency] : null;
      return '<div class="card"><h2>' + esc(a.name) +
        (a.archived ? ' (archivada)' : '') + '</h2>' +
        '<div class="rowline"><span class="name">' + esc(a.currency) + ' · ' + esc(kindLabel(a.kind)) +
        (a.country ? ' · ' + esc(a.country) : '') + '</span><span class="val num">' + esc(fmtMoney(b.native, a.currency)) + '</span></div>' +
        '<div class="rowline"><span class="name">Valor USD</span><span class="val num">' + esc(usd != null ? fmtUsd(usd) : '—') + '</span></div>' +
        '<div class="rowline"><span class="name">Apertura · créditos · débitos</span><span class="val num">' +
        esc(fmtMoney(b.opening, a.currency) + ' · +' + fmt(b.credits, 2) + ' · −' + fmt(b.debits, 2)) + '</span></div>' +
        (a.primary && !a.archived ? '<p class="muted hint">Primaria de ' + esc(a.currency) + '.</p>' : '') +
        (a.archived
          ? '<button type="button" class="btn btn-small" data-act="unarchive" data-id="' + esc(a.id) + '">Reactivar</button>'
          : (a.primary
              ? '<button type="button" class="btn btn-small" data-act="unprimary" data-id="' + esc(a.id) + '">Quitar primaria</button>'
              : '<button type="button" class="btn btn-small" data-act="primary" data-id="' + esc(a.id) + '">Hacer primaria</button>') +
            '<button type="button" class="btn btn-small btn-danger" data-act="archive" data-id="' + esc(a.id) + '">Archivar</button>') +
        '</div>';
    }).join('') || '<p class="muted hint">Sin cuentas.</p>';
    cont.querySelectorAll('[data-act]').forEach(function (b) {
      if (b.dataset.boundAcc) return;
      b.dataset.boundAcc = '1';
      b.addEventListener('click', function () { accountAction(b.dataset.act, b.dataset.id); });
    });
    renderEditSelect();
  }

  CT.renderCuentas = renderCuentas;
  CT.parts.cuentas = renderCuentas;

  function kindLabel(k) {
    return { bank: 'banco', cash: 'efectivo', exchange: 'exchange', wallet: 'billetera' }[k] || (k || '—');
  }

  function renderEditSelect() {
    const sel = el('cuentas-edit-id');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = S.ledger.accounts
      .filter(function (a) { return !a.archived; })
      .map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.name) + ' (' + esc(a.currency) + ')</option>'; })
      .join('') || '<option value="">—</option>';
    if (prev && S.ledger.accounts.some(function (a) { return a.id === prev && !a.archived; })) sel.value = prev;
    const inp = el('cuentas-edit-apertura');
    if (inp && sel.value) {
      const a = S.ledger.accounts.filter(function (x) { return x.id === sel.value; })[0];
      inp.value = a && a.opening != null ? String(a.opening) : '';
    }
  }

  function accountAction(act, id) {
    const eng = globalThis.CTEngine;
    const acc = S.ledger.accounts.filter(function (a) { return a.id === id; })[0];
    if (!acc) return;
    if (act === 'archive') {
      acc.archived = true;
      if (acc.primary) acc.primary = false;
    } else if (act === 'unarchive') {
      acc.archived = false;
    } else if (act === 'primary') {
      // Exactamente una primaria por moneda.
      S.ledger.accounts.forEach(function (a) { if (a.currency === acc.currency) a.primary = false; });
      acc.primary = true;
    } else if (act === 'unprimary') {
      acc.primary = false;
    }
    eng.save(S.ledger);
    renderCuentas();
    renderResultadoSafe();
  }
  CT.accountAction = accountAction;

  function bindCuentas() {
    const editId = el('cuentas-edit-id');
    if (editId && !editId.dataset.bound) {
      editId.dataset.bound = '1';
      editId.addEventListener('change', function () {
        const a = S.ledger.accounts.filter(function (x) { return x.id === editId.value; })[0];
        const inp = el('cuentas-edit-apertura');
        if (inp) inp.value = a && a.opening != null ? String(a.opening) : '';
      });
    }
    const editOk = el('cuentas-edit-ok');
    if (editOk && !editOk.dataset.bound) {
      editOk.dataset.bound = '1';
      editOk.addEventListener('click', function () {
        const v = parseFloat(el('cuentas-edit-apertura') && el('cuentas-edit-apertura').value);
        if (!Number.isFinite(v)) { toast('Apertura inválida.'); return; }
        const acc = S.ledger.accounts.filter(function (x) { return x.id === (editId && editId.value); })[0];
        if (!acc) { toast('Elegí una cuenta.'); return; }
        acc.opening = v;
        globalThis.CTEngine.save(S.ledger);
        toast('Apertura de ' + acc.name + ' actualizada.');
        renderCuentas();
        renderBalance();
        renderResultadoSafe();
      });
    }
    const form = el('cuentas-form');
    if (form && !form.dataset.bound) {
      form.dataset.bound = '1';
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        addAccount();
      });
    }
  }

  function addAccount() {
    const eng = globalThis.CTEngine;
    const name = (el('cu-nombre') && el('cu-nombre').value.trim()) || '';
    const currency = (el('cu-moneda') && el('cu-moneda').value) || '';
    const kind = (el('cu-tipo') && el('cu-tipo').value) || 'bank';
    const countryVal = (el('cu-pais') && el('cu-pais').value.trim().toUpperCase()) || '';
    const opening = parseFloat(el('cu-apertura') && el('cu-apertura').value);
    const primary = !!(el('cu-primaria') && el('cu-primaria').checked);
    const msg = el('cu-msg');
    if (!name) { if (msg) msg.textContent = 'Ponle un nombre a la cuenta.'; return; }
    if (eng.CURRENCIES.indexOf(currency) < 0) { if (msg) msg.textContent = 'Moneda inválida.'; return; }
    if (Number.isFinite(opening) && opening < 0) { if (msg) msg.textContent = 'La apertura no puede ser negativa.'; return; }
    const acc = {
      id: 'acc-' + Date.now() + '-' + Math.floor(Math.random() * 1e4),
      name: name, currency: currency, kind: kind,
      country: countryVal || null,
      opening: Number.isFinite(opening) ? opening : 0
    };
    if (primary) {
      S.ledger.accounts.forEach(function (a) { if (a.currency === currency) a.primary = false; });
      acc.primary = true;
    }
    S.ledger.accounts.push(acc);
    eng.save(S.ledger);
    if (msg) msg.textContent = 'Cuenta ' + name + ' agregada.';
    const form = el('cuentas-form');
    if (form && form.reset) form.reset();
    renderCuentas();
    renderResultadoSafe();
  }
  CT.addAccount = addAccount;

  function fillCurrencySelects() {
    const eng = globalThis.CTEngine;
    const sel = el('cu-moneda');
    if (sel && !sel.dataset.filled) {
      sel.dataset.filled = '1';
      sel.innerHTML = eng.CURRENCIES.map(function (c) {
        return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
      }).join('');
    }
  }

  // ==================== BALANCE ====================

  function renderBalance() {
    const holder = el('balance-out');
    if (!holder || !S.ledger) return;
    if (!S.fx) {
      holder.innerHTML = '<div class="card"><p class="muted hint">Cargando tasas para la valoración USD…</p></div>';
      return;
    }
    const eng = globalThis.CTEngine;
    const b = eng.balance(S.ledger, S.fx);
    const cuadreBadge = b.cuadre
      ? '<span class="badge badge-ok">Cuadre</span>'
      : '<span class="badge badge-bad">Descuadre</span>';
    let html = '<div class="card"><h2>Resumen ' + cuadreBadge + '</h2>' +
      '<div class="grid2">' +
      '<div class="kv"><span class="k">Activos</span><span class="v num">' + esc(fmtUsd(b.assetsUsd)) + '</span></div>' +
      '<div class="kv"><span class="k">Pasivos (diezmo + tercero)</span><span class="v num">' + esc(fmtUsd(b.liabilities.total)) + '</span></div>' +
      '<div class="kv"><span class="k">Patrimonio</span><span class="v big num">' + esc(fmtUsd(b.equityUsd)) + '</span></div>' +
      '<div class="kv"><span class="k">Revalorización FX</span><span class="v num">' + esc(fmtUsd(b.fxDiffUsd)) + '</span></div>' +
      '</div><p class="muted hint">' + esc(b.fxNote || '') + '</p></div>';

    html += '<div class="card"><h2>Activos por moneda</h2>';
    Object.keys(b.currencies).forEach(function (code) {
      const slot = b.currencies[code];
      html += '<div class="rowline"><span class="name">' + esc(code) + '</span><span class="val num">' +
        esc(fmtMoney(slot.native, code) + ' ≈ ' + (slot.usdNow != null ? fmtUsd(slot.usdNow) : '— sin tasa —')) + '</span></div>';
      slot.accounts.forEach(function (acc) {
        html += '<div class="rowline"><span class="name muted">· ' + esc(acc.name) + '</span><span class="val num">' +
          esc(fmtMoney(acc.native, code)) + '</span></div>';
      });
      if (slot.fxDiff != null) {
        html += '<div class="rowline"><span class="name muted">· FX vs tasas de movim.</span><span class="val num">' +
          esc(fmtUsd(slot.fxDiff)) + '</span></div>';
      }
    });
    html += '</div>';

    html += '<div class="card"><h2>Pasivos (USD crudos)</h2><div class="grid2">' +
      '<div class="kv"><span class="k">Diezmo acumulado</span><span class="v num">' + esc(fmtUsd(b.liabilities.diezmo)) + '</span></div>' +
      '<div class="kv"><span class="k">Tercero acumulado</span><span class="v num">' + esc(fmtUsd(b.liabilities.tercero)) + '</span></div>' +
      '<div class="kv"><span class="k">Total</span><span class="v big num">' + esc(fmtUsd(b.liabilities.total)) + '</span></div>' +
      '</div></div>';

    if (b.warnings.length) {
      html += '<div class="card"><h2>Avisos</h2>' + b.warnings.map(function (w) {
        return '<p class="warnline">⚠ ' + esc(w) + '</p>';
      }).join('') + '</div>';
    }

    html += '<div class="card"><h2>Distribución por país</h2>';
    const byCountry = {};
    S.ledger.accounts.forEach(function (acc) {
      if (acc.archived) return;
      const bb = eng.accountBalance(S.ledger, acc.id);
      const key = (acc.country || 'sin país') + ' · ' + acc.currency;
      byCountry[key] = (byCountry[key] || 0) + bb.native;
    });
    const keys = Object.keys(byCountry).sort();
    html += keys.map(function (k) {
      const parts = k.split(' · ');
      const usd = S.fx && S.fx.unitsPerUsd[parts[1]] != null ? byCountry[k] / S.fx.unitsPerUsd[parts[1]] : null;
      return '<div class="rowline"><span class="name">' + esc(k) + '</span><span class="val num">' +
        esc(fmtMoney(byCountry[k], parts[1]) + ' ≈ ' + (usd != null ? fmtUsd(usd) : '—')) + '</span></div>';
    }).join('') || '<p class="muted hint">—</p>';
    html += '</div>';

    holder.innerHTML = html;
  }
  CT.renderBalance = renderBalance;
  CT.parts.balance = renderBalance;

  // ==================== HISTÓRICO ====================

  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

  function monthLabel(periodId) {
    const parts = String(periodId).split('-');
    const m = Number(parts[1]);
    return parts[0] + ' · ' + (MESES[m - 1] || '?');
  }

  function fillFilters() {
    const eng = globalThis.CTEngine;
    const meses = [], anos = [], paises = [];
    S.ledger.movements.forEach(function (m) {
      const p = /^\d{4}-\d{2}/.test(m.date || '') ? m.date.slice(0, 7) : null;
      if (p && meses.indexOf(p) < 0) meses.push(p);
      const y = /^\d{4}/.test(m.date || '') ? m.date.slice(0, 4) : null;
      if (y && anos.indexOf(y) < 0) anos.push(y);
      [[m.in, +1], [m.out, -1]].forEach(function (lado) {
        const leg = lado[0];
        if (!leg || leg.account == null) return;
        const acc = eng.accountById(S.ledger, leg.account);
        if (acc && acc.country && paises.indexOf(acc.country) < 0) paises.push(acc.country);
      });
    });
    Object.keys(S.ledger.periods).forEach(function (p) {
      if (meses.indexOf(p) < 0) meses.push(p);
    });
    meses.sort().reverse(); anos.sort().reverse(); paises.sort();

    const mes = el('hist-mes');
    if (mes) {
      const prev = mes.value;
      mes.innerHTML = '<option value="all">Todos</option>' + meses.map(function (m2) {
        const closed = S.ledger.periods[m2] && S.ledger.periods[m2].closedAt ? ' (cerrado)' : '';
        return '<option value="' + esc(m2) + '">' + esc(monthLabel(m2) + closed) + '</option>';
      }).join('');
      if (meses.indexOf(prev) >= 0) mes.value = prev; else mes.value = 'all';
    }
    const ano = el('hist-ano');
    if (ano) {
      const prev = ano.value;
      ano.innerHTML = '<option value="all">Todos</option>' + anos.map(function (y2) {
        return '<option value="' + esc(y2) + '">' + esc(y2) + '</option>';
      }).join('');
      if (anos.indexOf(prev) >= 0) ano.value = prev; else ano.value = 'all';
    }
    const pais = el('hist-pais');
    if (pais) {
      const prev = pais.value;
      pais.innerHTML = '<option value="all">Todos</option>' + paises.map(function (p2) {
        return '<option value="' + esc(p2) + '">' + esc(p2) + '</option>';
      }).join('');
      if (paises.indexOf(prev) >= 0) pais.value = prev; else pais.value = 'all';
    }
    const cierre = el('hist-cierre-mes');
    if (cierre) {
      const prev = cierre.value;
      if (!meses.length) cierre.innerHTML = '<option value="">—</option>';
      else cierre.innerHTML = meses.map(function (m2) {
        const closed = S.ledger.periods[m2] && S.ledger.periods[m2].closedAt;
        return '<option value="' + esc(m2) + '"' + (closed ? ' data-closed="1"' : '') + '>' + esc(monthLabel(m2) + (closed ? ' · cerrado' : '')) + '</option>';
      }).join('');
      if (meses.indexOf(prev) >= 0) cierre.value = prev;
    }
  }

  function filteredMovements() {
    const eng = globalThis.CTEngine;
    const mes = (el('hist-mes') && el('hist-mes').value) || 'all';
    const ano = (el('hist-ano') && el('hist-ano').value) || 'all';
    const pais = (el('hist-pais') && el('hist-pais').value) || 'all';
    const tipo = (el('hist-tipo') && el('hist-tipo').value) || 'all';
    return S.ledger.movements.slice().reverse().filter(function (m) {
      const date = m.date || '';
      if (mes !== 'all' && date.slice(0, 7) !== mes) return false;
      if (ano !== 'all' && date.slice(0, 4) !== ano) return false;
      if (tipo !== 'all' && m.type !== tipo) return false;
      if (pais !== 'all') {
        let match = false;
        [[m.in, 0], [m.out, 1]].forEach(function (lado) {
          const leg = lado[0];
          if (!leg || leg.account == null) return;
          const acc = eng.accountById(S.ledger, leg.account);
          if (acc && acc.country === pais) match = true;
        });
        if (!match) return false;
      }
      return true;
    });
  }

  function histStats(movs) {
    const eng = globalThis.CTEngine;
    const t = { n: movs.length, ops: 0, base: 0, diezmo: 0, tercero: 0, neto: 0 };
    movs.forEach(function (m) {
      if (m.type === 'operation' && m.meta && m.meta.case) {
        const c = m.meta.case;
        t.ops++;
        t.base += c.base || 0;
        t.diezmo += c.diezmo || 0;
        t.tercero += c.tercero || 0;
        t.neto += c.neto || 0;
      }
    });
    // Capital por país: saldo nativo de cuentas activas agrupado y valorado con tasas actuales.
    const capital = {};
    const fxUsed = S.fx || eng.buildFx(S.rates);
    S.ledger.accounts.forEach(function (acc) {
      if (acc.archived) return;
      const b = eng.accountBalance(S.ledger, acc.id);
      const key = acc.country || 'sin país';
      capital[key] = (capital[key] || 0) + b.native;
    });
    const capitalUsd = {};
    Object.keys(capital).forEach(function (k) {
      // mezcla de monedas por país se lista en USD cuando hay tasa; sin tasa → excluida con aviso del buildFx
      let sum = 0, complete = true;
      S.ledger.accounts.forEach(function (acc) {
        if (acc.archived || (acc.country || 'sin país') !== k) return;
        const b = eng.accountBalance(S.ledger, acc.id);
        const rate = fxUsed ? fxUsed.unitsPerUsd[acc.currency] : null;
        if (rate == null) { complete = false; return; }
        sum += b.native / rate;
      });
      capitalUsd[k] = complete ? sum : null;
    });
    return { t: t, capitalUsd: capitalUsd };
  }

  function renderHistorico() {
    if (!S.ledger || !globalThis.CTEngine) return;
    const eng = globalThis.CTEngine;
    fillFilters();
    const movs = filteredMovements();
    const st = histStats(movs);
    const statsEl = el('hist-estadisticas');
    if (statsEl) {
      let rows = [
        ['Movimientos', fmt(st.t.n, 0)],
        ['Operaciones', fmt(st.t.ops, 0)],
        ['Base (plusvalía)', fmtUsd(st.t.base)],
        ['Diezmo (10 %)', fmtUsd(st.t.diezmo)],
        ['Tercero (25 %)', fmtUsd(st.t.tercero)],
        ['Neto para mí', fmtUsd(st.t.neto)]
      ];
      Object.keys(st.capitalUsd).sort().forEach(function (k) {
        rows.push(['Capital ' + k, st.capitalUsd[k] != null ? fmtUsd(st.capitalUsd[k]) : '— sin tasa']);
      });
      statsEl.innerHTML = '<div class="card"><h2>Estadísticas</h2><div class="grid2">' + rows.map(function (r) {
        return '<div class="kv"><span class="k">' + esc(r[0]) + '</span><span class="v num">' + r[1] + '</span></div>';
      }).join('') + '</div></div>';
    }
    const list = el('hist-lista');
    if (list) {
      list.innerHTML = movs.map(function (m) {
        const leg = function (side, verb) {
          if (!m[side]) return '';
          const acc = m[side].account != null ? eng.accountById(S.ledger, m[side].account) : null;
          return '<div class="rowline"><span class="name">' + esc(verb + ' ' + fmt(m[side].amount, m[side].amount >= 1000 || Number.isInteger(m[side].amount) ? 0 : 2) + ' ' + esc(m[side].currency)) +
            (acc ? ' · ' + esc(acc.name) : ' · externo') + '</span><span class="val num">' +
            esc(m[side].rateAt != null ? '@ ' + fmt(m[side].rateAt, 4) : 'sin valoración') + '</span></div>';
        };
        const caseInfo = m.meta && m.meta.case
          ? '<div class="rowline"><span class="name">Caso</span><span class="val num">' +
            esc((m.meta.case.pair || []).join('/') + ' ' + (m.meta.case.direction || '') +
              ' · plusvalía ' + fmt(m.meta.case.profitUsd, 2) + ' · neto ' + fmt(m.meta.case.neto, 2)) + '</span></div>'
          : '';
        return '<div class="opcard"><div class="ophead">' +
          '<span class="pair num">#' + esc(m.seq) + ' · ' + esc(m.date || 'sin fecha') + ' · ' + esc(m.type) + '</span>' +
          '</div>' + leg('in', 'Entra') + leg('out', 'Sale') + caseInfo +
          (m.note ? '<p class="opobs">' + esc(m.note) + '</p>' : '') +
          '<p class="muted hint mono">hash ' + esc(String(m.hash).slice(0, 12)) + '… · prev ' + esc(String(m.prevHash).slice(0, 8)) + '…</p>' +
          '</div>';
      }).join('') || '<p class="muted hint">Sin movimientos con estos filtros.</p>';
    }
    renderChainStatus();
    renderMigrateButton();
  }
  CT.renderHistorico = renderHistorico;
  CT.parts.historico = renderHistorico;

  function renderChainStatus() {
    const eng = globalThis.CTEngine;
    const cont = el('hist-cadena');
    if (!cont) return;
    const ok = eng.verifyChain(S.ledger.movements);
    const head = eng.chainHead(S.ledger.movements);
    cont.innerHTML = '<p class="' + (ok ? 'hint muted' : 'warnline') + '">' +
      (ok ? '✔' : '⚠') + ' Cadena de hashes: ' + (ok ? 'íntegra' : 'ALTERADA') +
      ' · ' + fmt(S.ledger.movements.length, 0) + ' movimientos' +
      (head ? ' · cabeza ' + esc(String(head).slice(0, 12)) + '…' : '') + '</p>';
  }

  function bindHistorico() {
    ['hist-mes', 'hist-ano', 'hist-pais', 'hist-tipo'].forEach(function (id) {
      const f = el(id);
      if (f && !f.dataset.bound) {
        f.dataset.bound = '1';
        f.addEventListener('change', renderHistorico);
      }
    });
    const cerrar = el('hist-cerrar');
    if (cerrar && !cerrar.dataset.bound) {
      cerrar.dataset.bound = '1';
      cerrar.addEventListener('click', function () {
        const periodo = (el('hist-cierre-mes') && el('hist-cierre-mes').value) || '';
        if (!periodo) { toast('No hay mes para cerrar.'); return; }
        if (!globalThis.confirm || !window.confirm('¿Cerrar ' + monthLabel(periodo) + '? No se aceptarán más movimientos de ese mes.')) return;
        try {
          globalThis.CTEngine.closePeriod(S.ledger, periodo, S.fx);
          globalThis.CTEngine.save(S.ledger);
          toast('Periodo ' + monthLabel(periodo) + ' cerrado.');
          renderHistorico();
        } catch (e) { toast('No se pudo cerrar: ' + e.message); }
      });
    }
    const expJ = el('hist-exp-json');
    if (expJ && !expJ.dataset.bound) {
      expJ.dataset.bound = '1';
      expJ.addEventListener('click', function () {
        downloadFile('consutasas-backup-' + todayISO() + '.json',
          JSON.stringify(globalThis.CTEngine.exportState(S.ledger), null, 2), 'application/json');
      });
    }
    const expC = el('hist-exp-csv');
    if (expC && !expC.dataset.bound) {
      expC.dataset.bound = '1';
      expC.addEventListener('click', function () {
        downloadFile('consutasas-movimientos-' + todayISO() + '.csv',
          globalThis.CTEngine.exportCsv(S.ledger), 'text/csv');
      });
    }
    const imp = el('hist-imp');
    const file = el('hist-imp-file');
    if (imp && file && !imp.dataset.bound) {
      imp.dataset.bound = '1';
      imp.addEventListener('click', function () { file.click(); });
      file.addEventListener('change', importLedger);
    }
    const man = el('hist-manifiesto');
    if (man && !man.dataset.bound) {
      man.dataset.bound = '1';
      man.addEventListener('click', function () {
        const pre = el('hist-manifiesto-pre');
        if (!pre) return;
        pre.hidden = !pre.hidden;
        pre.textContent = pre.hidden ? '' : JSON.stringify(globalThis.CTEngine.manifest(S.ledger), null, 2);
      });
    }
    const mig = el('hist-migrar');
    if (mig && !mig.dataset.bound) {
      mig.dataset.bound = '1';
      mig.addEventListener('click', migrateLegacy);
    }
  }

  function downloadFile(name, content, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: mime + ';charset=utf-8' }));
    a.download = name;
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast('Descarga: ' + name);
  }

  function importLedger(ev) {
    const input = ev.target;
    const file = input.files && input.files[0];
    input.value = ''; // permite reintentar el mismo archivo
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      let payload;
      try { payload = JSON.parse(String(reader.result)); }
      catch (e) { toast('JSON inválido: no se pudo leer el archivo.'); return; }
      try {
        const state = globalThis.CTEngine.importState(payload);
        S.ledger = state;
        globalThis.CTEngine.save(S.ledger);
        toast('Respaldo importado: ' + state.movements.length + ' movimientos.');
        afterLedgerMutation();
      } catch (e) { toast('Respaldo rechazado: ' + e.message); }
    };
    reader.readAsText(file);
  }

  function afterLedgerMutation() {
    renderCuentas();
    renderBalance();
    renderHistorico();
    renderCasos();
  }
  CT.afterLedgerMutation = afterLedgerMutation;

  function renderMigrateButton() {
    const btn = el('hist-migrar');
    if (!btn) return;
    const legacy = readLegacyOps();
    btn.hidden = !(Array.isArray(legacy) && legacy.length);
  }

  function readLegacyOps() {
    try {
      const raw = localStorage.getItem('consumo_operations');
      const arr = raw ? JSON.parse(raw) : null;
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function migrateLegacy() {
    const eng = globalThis.CTEngine;    const legacy = readLegacyOps();
    if (!legacy.length) { toast('No hay operaciones v1 en este dispositivo.'); return; }
    const migrated = eng.migrateLegacyOperations(legacy, S.ledger.movements);
    const res = el('hist-migrar-result');
    if (!migrated.length) {
      if (res) res.textContent = 'Ya estaban migradas (nada por añadir).';
      toast('Nada por migrar (ya están en el libro).');
      renderMigrateButton();
      return;
    }
    try {
      migrated.forEach(function (mv) { eng.appendMovement(S.ledger, mv); });
      eng.save(S.ledger);
      if (res) res.textContent = 'Migradas ' + migrated.length + ' operación(es) v1 como movimientos legacy (sin cuentas: null = externo).';
      toast('Migradas ' + migrated.length + ' operación(es) v1.');
      afterLedgerMutation();
      renderMigrateButton();
    } catch (e) { toast('No se pudo migrar: ' + e.message); }
  }

  CT.migrateLegacy = migrateLegacy;

  // ==================== INIT ====================

  const TABS = ['casos', 'cuentas', 'balance', 'historico', 'tasas'];

  function requireEngine() {
    if (!globalThis.CTEngine) {
      banner('bad', 'Error grave: no se cargó el motor (assets/engine.js). La app no puede funcionar sin él.');
      return false;
    }
    return true;
  }

  async function init() {
    // P2: el modo UI se restaura AUNQUE el motor falte (antes del return),
    // para que el layout (web/phone) sea correcto también en ese error grave.
    bindUiMode();
    applyUiMode(readUiMode());
    if (!requireEngine()) return;
    // Load del libro; si hay operaciones v1 pendientes, loadAndMigrate migra
    // idempotentemente y persiste antes de seguir.
    S.ledger = readLegacyOps().length
      ? globalThis.CTEngine.loadAndMigrate()
      : globalThis.CTEngine.load();
    bindTabs();
    bindRefresh();
    bindCasos();
    bindCuentas();
    bindHistorico();
    fillCurrencySelects();

    let tab = null;
    try { tab = sessionStorage.getItem('ct_tab'); } catch (e) { /* sin sessionStorage */ }
    switchTab(TABS.indexOf(tab) >= 0 ? tab : 'casos');

    const cached = readCachedRates();
    if (cached) { S.fromCache = false; S.updateSource = 'cache'; applyRates(cached, 'cache'); }
    await refreshRates(false);
    afterLedgerMutation();
    // Auto-refresh: 60 s con pestaña visible
    let autoTimer = null;
    function startAutoRefresh() {
      stopAutoRefresh();
      autoTimer = setInterval(function () {
        if (document.visibilityState === 'visible') refreshRates(false, 'auto');
      }, 60000);
    }
    function stopAutoRefresh() {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    }
    startAutoRefresh();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') startAutoRefresh();
      else stopAutoRefresh();
    });
    window.addEventListener('online', function () { refreshRates(false, 'auto'); });
    window.addEventListener('offline', function () { refreshRates(false, 'auto'); });
    // Bot status inicial y re-render en cada tick (badge no debe quedar hidden)
    refreshBotStatus().then(function () { if (typeof CT.renderBotStatus === 'function') CT.renderBotStatus(); });
    setInterval(function () {
      if (document.visibilityState === 'visible') {
        refreshBotStatus().then(function () { if (typeof CT.renderBotStatus === 'function') CT.renderBotStatus(); });
      }
    }, BOT_STATUS_TTL_MS);
  }
  CT.init = init;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); });
  } else {
    init();
  }
})();
