/* ConsuTasas v2 — módulo Tasas + Comprobador (assets/tasas.js).
 *
 * Sobrescribe los placeholders `CT.renderTasas` / `CT.renderComprobador` del
 * núcleo (app.js) y renderiza la pestaña "tasas" con el snapshot rates.json
 * que app.js ya descargó y guardó en CT.S. Se ejecuta después de app.js
 * (orden de <script defer> en index.html) y, si el snapshot ya está cargado,
 * renderiza de inmediato; si no, la pestaña renderiza al abrirse/actualizar
 * vía CT.parts.tasas.
 *
 * Regla dura: nunca se inventa una tasa. Valor ausente → '—' (CT.fmt) + aviso.
 * Sin inline (CSP): todo el HTML pasa por esc(), los handlers van por
 * addEventListener y el botón Actualizar se conecta vía el hook
 * CT.onRefreshClick del núcleo.
 */
(function () {
  'use strict';

  const CT = globalThis.CT || (globalThis.CT = {});
  const S = CT.S; // estado del núcleo (rates, fx, ledger, fetchedAt, fromCache, rawText)

  function el(id) { return document.getElementById(id); }
  const esc = CT.esc;
  const fmt = CT.fmt;

  const FIATS = (globalThis.CTEngine && globalThis.CTEngine.FIATS) || ['VES', 'PEN', 'COP', 'CLP', 'MXN'];

  // Decimales por fiat (CLP sin centavos útiles).
  function dec(code) { return code === 'CLP' ? 2 : 4; }

  function num(v, d) { return '<span class="num">' + esc(fmt(v, d == null ? 2 : d)) + '</span>'; }

  function signCls(pct) {
    if (pct == null || !Number.isFinite(pct)) return '';
    return pct > 0.0005 ? 'pos' : (pct < -0.0005 ? 'neg' : '');
  }

  function kvRow(k, vHtml, extraCls) {
    return '<div class="kv"><span class="k">' + esc(k) + '</span>' +
      '<span class="v' + (extraCls ? ' ' + esc(extraCls) : '') + '">' + vHtml + '</span></div>';
  }

  function kvGrid(rows) {
    return '<div class="grid2">' + rows.join('') + '</div>';
  }

  function ageMin(iso) {
    const t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    return Math.max(0, (Date.now() - t) / 60000);
  }

  function formatUTC(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso == null ? '—' : iso);
    const p = function (n) { return String(n).padStart(2, '0'); };
    return String(d.getUTCFullYear()) + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
      ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' UTC';
  }

  function hhmm(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  }

  // diffRates: compara campo por campo prev → curr, devuelve array de diffs
  function diffRates(prev, curr) {
    if (!prev || !curr) return [];
    const diffs = [];
    // BCV USD/EUR (guard a!=0, igual que pares y eurRef)
    const bcvPrev = prev.sources && prev.sources.bcv;
    const bcvCurr = curr.sources && curr.sources.bcv;
    if (bcvPrev && bcvCurr) {
      ['usd', 'eur'].forEach(function (k) {
        const a = bcvPrev.samples && bcvPrev.samples[k];
        const b = bcvCurr.samples && bcvCurr.samples[k];
        if (a != null && b != null && a !== b && a !== 0) {
          const pct = ((b - a) / Math.abs(a)) * 100;
          diffs.push({ field: 'BCV ' + k.toUpperCase(), prev: a, curr: b, pct: pct });
        }
      });
    }
    // Pares multi-fiat: compra, venta, mejorCompra, mejorVenta
    Object.keys(curr.pairs || {}).forEach(function (code) {
      const pPrev = (prev.pairs || {})[code];
      const pCurr = curr.pairs[code];
      if (!pPrev) return;
      ['compra', 'venta', 'mejorCompra', 'mejorVenta'].forEach(function (k) {
        const a = pPrev[k], b = pCurr[k];
        if (a != null && b != null && a !== b) {
          const pct = Math.abs(a) > 0 ? ((b - a) / Math.abs(a)) * 100 : 0;
          diffs.push({ field: code + ' ' + k, prev: a, curr: b, pct: pct });
        }
      });
      // porPlataforma: por plataforma y lado
      const pPrevPPP = pPrev.porPlataforma;
      const pCurrPPP = pCurr.porPlataforma;
      if (pPrevPPP && pCurrPPP && typeof pPrevPPP === 'object' && typeof pCurrPPP === 'object') {
        Object.keys(pCurrPPP).forEach(function (plat) {
          const pp = pPrevPPP[plat], cp = pCurrPPP[plat];
          if (!pp || !cp) return;
          ['compra', 'venta'].forEach(function (k) {
            const a = pp[k], b = cp[k];
            if (a != null && b != null && a !== b && a !== 0) {
              const pct = ((b - a) / Math.abs(a)) * 100;
              diffs.push({ field: code + '/' + plat + '/' + k, prev: a, curr: b, pct: pct });
            }
          });
        });
      }
    });
    // vesDetail: totales, mejores, promedios P1/P2, spread
    const vdCurr = curr.vesDetail;
    const vdPrev = prev.vesDetail;
    if (vdCurr && vdPrev && typeof vdCurr === 'object') {
      ['compraTotal', 'ventaTotal', 'mejorPrecioCompra', 'mejorPrecioVenta',
       'compraPromP1', 'compraPromP2', 'ventaPromP1', 'ventaPromP2',
       'spreadTotal', 'spreadMejores'].forEach(function (k) {
        const a = vdPrev[k], b = vdCurr[k];
        if (a != null && b != null && a !== b && a !== 0) {
          const pct = ((b - a) / Math.abs(a)) * 100;
          diffs.push({ field: 'VES detail ' + k, prev: a, curr: b, pct: pct });
        }
      });
    }
    // EUR ref
    if (curr.eurRef && prev.eurRef) {
      ['usd', 'ves'].forEach(function (k) {
        const a = prev.eurRef[k], b = curr.eurRef[k];
        if (a != null && b != null && a !== b) {
          const pct = Math.abs(a) > 0 ? ((b - a) / Math.abs(a)) * 100 : 0;
          diffs.push({ field: 'EUR ' + k, prev: a, curr: b, pct: pct });
        }
      });
    }
    return diffs;
  }
  CT.diffRates = diffRates;

  function rateChangeHtml(pct) {
    if (pct == null || !Number.isFinite(pct)) return '';
    if (Math.abs(pct) < 0.001) return '';
    const up = pct > 0;
    const arrow = up ? '\u25B2' : '\u25BC'; // ▲ ▼
    const cls = up ? 'rate-up rate-flash' : 'rate-down rate-flash';
    const direction = up ? 'sube' : 'baja';
    return '<span class="' + cls + '" aria-label="' + direction + ' ' + fmt(Math.abs(pct), 2) + '%">' + arrow + ' ' + fmt(Math.abs(pct), 2) + '%</span>';
  }

  // flashClass: aplica brevemente la clase de destello para cambios visibles
  function flash(el, cls, ms) {
    if (!el) return;
    el.classList.add(cls);
    // Respetar prefers-reduced-motion
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setTimeout(function () { el.classList.remove(cls); }, 50);
      return;
    }
    setTimeout(function () { el.classList.remove(cls); }, 600);
  }

  function emptyCard(msg) {
    return '<div class="card"><p class="warnline">⚠ ' + esc(msg || 'Sin snapshot de tasas. Pulsa Actualizar.') + '</p></div>';
  }

  // ==================== EUR referencial ====================

  function renderEurRef(data) {
    const holder = el('ta-eurref');
    if (!holder) return;
    const r = data && data.eurRef;
    let aviso = '';
    if (!r || typeof r !== 'object') {
      aviso = '<p class="warnline">⚠ EUR referencial no publicado en este snapshot: EUR queda deshabilitado salvo tasa manual (card de config).</p>';
    } else if (r.diffPct != null && Number.isFinite(r.diffPct) && r.diffPct > 2) {
      aviso = '<p class="warnline">⚠ Diferencia del EUR referencial vs implícito (' + esc(fmt(r.diffPct, 2)) +
        ' %) supera el 2 %: usar con cuidado.</p>';
    }
    holder.innerHTML = '<div class="card"><h2>EUR referencial</h2>' +
      kvGrid([
        kvRow('EUR por 1 USD', num(r && r.usd, 4), 'big'),
        kvRow('Bs por 1 EUR', num(r && r.ves, 4), 'big'),
        kvRow('Bs por 1 EUR (implícito)', num(r && r.vesImplicito, 4), 'num'),
        kvRow('Dif. vs implícito', num(r && r.diffPct, 2) + ' %', signCls(r && r.diffPct) || 'num'),
        kvRow('Fuente', esc((r && r.source) || '—')),
        kvRow('Estado', esc((r && r.status) || '—')),
        kvRow('Actualizado', esc(CT.fmtDate(r && r.fetchedAt, true)))
      ]) +
      '<p class="muted hint">Referencial oficial (Frankfurter/ECB). No se usan EUR de Binance/Bybit.</p>' +
      aviso + '</div>';
  }

  // ==================== BCV ====================

  function renderBcv(data) {
    const holder = el('ta-bcv');
    if (!holder) return;
    if (!data) { holder.innerHTML = emptyCard(); return; }
    const bcv = data.sources && data.sources.bcv;
    const samples = bcv && bcv.samples;
    // Leer prev rates solo si S.rates está presente y NO vino de caché (dato en vivo)
    // Cuando fromCache=false, el dato es reciente y podemos comparar con el anterior
    let prevData = null;
    if (CT.S && CT.S.rates && !CT.S.fromCache) {
      prevData = readPrevRates();
    }
    const prevSamples = (prevData && prevData.sources && prevData.sources.bcv && prevData.sources.bcv.samples) || null;
    let changeHtml = '';
    if (prevSamples && samples) {
      ['usd', 'eur'].forEach(function (k) {
        const a = prevSamples[k], b = samples[k];
        if (a != null && b != null && a !== b) {
          const pct = ((b - a) / a) * 100;
          const change = rateChangeHtml(pct);
          if (change) {
            changeHtml += '<div class="kv"><span class="k">' + esc('Variación BCV ' + k.toUpperCase()) + '</span><span class="v">' + change + '</span></div>';
          }
        }
      });
    }
    holder.innerHTML = '<div class="card"><h2>Oficial BCV</h2>' +
      kvGrid([
        kvRow('USD', num(samples && samples.usd, 4), 'big'),
        kvRow('EUR', num(samples && samples.eur, 4), 'big'),
        kvRow('Estado de la fuente', esc((bcv && bcv.status) || '—')),
        kvRow('Publicación BCV', esc((bcv && bcv.actualizado) || '—'))
      ]) +
      changeHtml +
      (samples && samples.usd != null && samples.eur != null
        ? ''
        : '<p class="warnline">⚠ BCV no publicó USD/EUR en este snapshot: se muestra «—», no se inventan tasas.</p>') +
      '</div>';
    // Flash las filas de variación tras renderizar
    holder.querySelectorAll('.rate-flash').forEach(function (el) { flash(el, 'rate-flash', 600); });
  }

  function readPrevRates() {
    try {
      const raw = localStorage.getItem('ct_rates_prev');
      if (!raw) return null;
      const rec = JSON.parse(raw);
      return (rec && rec.data) ? rec.data : null;
    } catch (e) { return null; }
  }

  // ==================== P2P USD→VES ====================

  function renderP2p(data) {
    const holder = el('ta-p2p');
    if (!holder) return;
    if (!data) { holder.innerHTML = emptyCard(); return; }
    const plat = data.pairs && data.pairs.VES && (data.pairs.VES.porPlataforma || {});
    const cross = (data.cross || {});
    const rows = [];
    [['binance', 'Binance', 'BCV USD → Binance VES'], ['bybit', 'Bybit', 'BCV USD → Bybit VES']]
      .forEach(function (it) {
        const d = plat[it[0]] || {};
        const varPct = cross[it[2]] && cross[it[2]].pctVariacion;
        rows.push(kvRow('Compra ' + it[1], num(d.compra, 4), 'num'));
        rows.push(kvRow('Venta ' + it[1], num(d.venta, 4), 'num'));
        rows.push(kvRow('Paralelo vs BCV (' + it[1] + ')', num(varPct, 2) + ' %', signCls(varPct) || 'num'));
      });
    holder.innerHTML = '<div class="card"><h2>P2P USD→Bs (Binance/Bybit)</h2>' + kvGrid(rows) +
      (!plat.binance && !plat.bybit
        ? '<p class="warnline">⚠ El snapshot no trae promedios por plataforma para VES.</p>'
        : '') +
      '</div>';
  }

  // ==================== Variaciones + poder adquisitivo ====================

  function renderVariaciones(data) {
    const holder = el('ta-variaciones');
    if (!holder) return;
    if (!data) { holder.innerHTML = emptyCard(); return; }
    const vari = Array.isArray(data.variations) ? data.variations : [];
    const pp = Array.isArray(data.purchasingPower) ? data.purchasingPower : [];
    holder.innerHTML =
      '<div class="card"><h2>Variaciones</h2>' +
      (vari.length ? kvGrid(vari.map(function (v) {
        return kvRow(v.name || '—', num(v.pct, 2) + ' %', signCls(v.pct) || 'num');
      })) : '<p class="muted hint">—</p>') + '</div>' +
      '<div class="card"><h2>Poder adquisitivo</h2>' +
      (pp.length ? kvGrid(pp.map(function (v) {
        return kvRow(v.name || '—', num(v.lossPct, 2) + ' % · ×' + num(v.factor, 4), 'neg');
      })) : '<p class="muted hint">—</p>') + '</div>';
  }

  // ==================== Multi-par (VES/PEN/CLP/COP/MXN) ====================

  function topAdLine(ads, code) {
    if (!Array.isArray(ads) || !ads.length) return '—';
    const a = ads[0]; // el bot ordena los ads: el primero es el mejor precio
    return esc(fmt(a.price, dec(code)) + ' · min ' + fmt(a.min, 2) + ' · max ' + fmt(a.max, 2) +
      ' · disp. ' + fmt(a.available, 2) + ' (' + esc(a.platform || '—') + ')');
  }

  function renderMultiPares(data) {
    const holder = el('ta-multipares');
    if (!holder) return;
    if (!data) { holder.innerHTML = emptyCard(); return; }
    const pairs = data.pairs || {};
    const codes = (data.meta && Array.isArray(data.meta.fiats) && data.meta.fiats.length
      ? data.meta.fiats : FIATS).filter(function (c) { return !!pairs[c]; });
    // Mismo gate que renderBcv: no leer prev si vino de caché
    let prevData = null;
    if (CT.S && CT.S.rates && !CT.S.fromCache) {
      prevData = readPrevRates();
    }
    let boards = '';
    codes.forEach(function (code) {
      const p = pairs[code] || {};
      const ads = p.ads || {};
      const nC = Array.isArray(ads.compra) ? ads.compra.length : 0;
      const nV = Array.isArray(ads.venta) ? ads.venta.length : 0;
      const m = p.muestras || {};
      // Cambios vs snapshot anterior
      let changeRows = '';
      if (prevData && prevData.pairs && prevData.pairs[code]) {
        const pp = prevData.pairs[code];
        ['compra', 'venta', 'mejorCompra', 'mejorVenta'].forEach(function (k) {
          const a = pp[k], b = p[k];
          if (a != null && b != null && a !== b) {
            const pct = Math.abs(a) > 0 ? ((b - a) / Math.abs(a)) * 100 : 0;
            const change = rateChangeHtml(pct);
            if (change) {
              changeRows += '<div class="kv"><span class="k">Variación ' + k + '</span><span class="v">' + change + '</span></div>';
            }
          }
        });
      }
      let html = '<div class="card"><h2>' + esc(code) + ' (USD→' + esc(code) + ')</h2>' +
        kvGrid([
          kvRow('Compra', num(p.compra, dec(code)), 'big'),
          kvRow('Venta', num(p.venta, dec(code)), 'big'),
          kvRow('Spread', num(p.spreadPct, 2) + ' %', signCls(p.spreadPct) || 'num'),
          kvRow('Mejor compra', num(p.mejorCompra, dec(code)), 'num'),
          kvRow('Mejor venta', num(p.mejorVenta, dec(code)), 'num'),
          kvRow('Mejor spread', num(p.mejorSpreadPct, 2) + ' %', signCls(p.mejorSpreadPct) || 'num'),
          kvRow('Muestras (total)', num(m.total != null ? m.total : (m.buy != null || m.sell != null ? (m.buy || 0) + (m.sell || 0) : null), 0), 'num'),
          kvRow('Anuncios (compra/venta)', fmt(nC, 0) + ' / ' + fmt(nV, 0), 'num')
        ]) +
        changeRows +
        '<div class="rowline"><span class="name">Mejor anuncio compra (top)</span><span class="val num">' + topAdLine(ads.compra, code) + '</span></div>' +
        '<div class="rowline"><span class="name">Mejor anuncio venta (top)</span><span class="val num">' + topAdLine(ads.venta, code) + '</span></div>' +
        '<p class="muted hint">' +
        esc('muestras buy ' + fmt(m.buy, 0) + ' · sell ' + fmt(m.sell, 0)) +
        '</p>' +
        (p.status && p.status !== 'ok'
          ? '<p class="warnline">⚠ Par ' + esc(code) + ' con estado «' + esc(p.status) + '».</p>'
          : '') +
        '</div>';
      boards += html;
    });
    holder.innerHTML = boards || '<div class="card"><p class="warnline">⚠ El snapshot no trae pares multi-fiat.</p></div>';
    // Flash las filas de variación tras renderizar
    holder.querySelectorAll('.rate-flash').forEach(function (el) { flash(el, 'rate-flash', 600); });
  }

  // ==================== Detalle VES ====================

  function renderVesDetalle(data) {
    const holder = el('ta-vesdetalle');
    if (!holder) return;
    if (!data) { holder.innerHTML = ''; return; }
    const vd = data.vesDetail;
    if (!vd || typeof vd !== 'object') { holder.innerHTML = ''; return; }
    const m = vd.muestras || {};
    holder.innerHTML = '<div class="card"><h2>Detalle P2P VES</h2>' +
      kvGrid([
        kvRow('Compra total', num(vd.compraTotal, 4), 'num'),
        kvRow('Venta total', num(vd.ventaTotal, 4), 'num'),
        kvRow('Mejor compra', num(vd.mejorPrecioCompra, 4), 'num'),
        kvRow('Mejor venta', num(vd.mejorPrecioVenta, 4), 'num'),
        kvRow('Prom. compra págs. 1/2', num(vd.compraPromP1, 4) + ' / ' + num(vd.compraPromP2, 4), 'num'),
        kvRow('Prom. venta págs. 1/2', num(vd.ventaPromP1, 4) + ' / ' + num(vd.ventaPromP2, 4), 'num'),
        kvRow('Spread total / mejores', num(vd.spreadTotal, 2) + ' % / ' + num(vd.spreadMejores, 2) + ' %', 'num'),
        kvRow('Muestras (compra · venta)', fmt(m.compra, 0) + ' · ' + fmt(m.venta, 0), 'num')
      ]) + '</div>';
  }

  // ==================== Diagnóstico + avisos (compartido) ====================

  function renderDiagnosticsShared(data, id) {
    const holder = el(id);
    if (!holder) return;
    if (!data) { holder.innerHTML = emptyCard(); return; }
    const dg = data.diagnostics || {};
    const lines = Object.keys(dg).map(function (k) {
      let v = dg[k];
      if (v && typeof v === 'object') v = JSON.stringify(v);
      const txt = typeof v === 'boolean' ? (v ? 'sí' : 'no') : v;
      return '<div class="rowline"><span class="name">' + esc(k) + '</span><span class="val num">' +
        esc(String(txt == null ? '—' : txt)) + '</span></div>';
    });
    const warns = (data.warnings || []).map(function (w) {
      return '<p class="warnline">⚠ ' + esc(typeof w === 'string' ? w : JSON.stringify(w)) + '</p>';
    });
    holder.innerHTML = '<div class="card"><h2>Diagnóstico y avisos del bot</h2>' +
      (lines.join('') || '<p class="muted hint">Sin diagnóstico publicado.</p>') +
      warns.join('') + '</div>';
  }

  // ==================== Comprobador ====================

  function renderComprobador() {
    const data = S && S.rates;
    if (!data) {
      ['chk-fuegonacional', 'chk-momento', 'chk-integridad'].forEach(function (id) {
        const e = el(id);
        if (e) e.innerHTML = emptyCard('Comprobador sin snapshot: pulsa Actualizar.');
      });
      renderDiagnosticsShared(null, 'chk-diagnostico');
      return;
    }

    // Origen + hash SHA-256 del archivo descargado (calculado con CTEngine.sha256Hex).
    const fuego = el('chk-fuegonacional');
    if (fuego) {
      let hashTxt;
      if (S.rawText && globalThis.CTEngine && typeof globalThis.CTEngine.sha256Hex === 'function') {
        hashTxt = esc(globalThis.CTEngine.sha256Hex(S.rawText));
      } else {
        hashTxt = '— pulsa «Actualizar» para descargar y calcularlo (la copia de caché no conserva el texto crudo)';
      }
      fuego.innerHTML =
        '<div class="rowline"><span class="name">Archivo del snapshot</span><span class="val mono">data/rates.json</span></div>' +
        '<div class="rowline"><span class="name">Schema</span><span class="val mono">' + esc(data.schema || '—') + '</span></div>' +
        '<div class="rowline"><span class="name">Integridad (SHA-256 del archivo descargado)</span><span class="val mono">' + hashTxt + '</span></div>';
    }

    // Momento + origen + eurRef + fuente.
    const momento = el('chk-momento');
    if (momento) {
      const age = ageMin(data.generatedAt);
      const cacheMin = S.fromCache && S.fetchedAt ? Math.floor(ageMin(S.fetchedAt) || 0) : null;
      const eur = data.eurRef;
      const sourceLabel = S.updateSource ? esc(S.updateSource) : '—';
      // Origen de lo que ves: usar updateSource para etiquetar correctamente
      let origenTexto;
      if (S.updateSource === 'local') origenTexto = 'local (no publicado)';
      else if (S.updateSource === 'cache') origenTexto = 'copia reciente ≤5 min';
      else if (S.fromCache) origenTexto = 'copia guardada hace ' + fmt(cacheMin, 0) + ' min';
      else origenTexto = 'en vivo';
      momento.innerHTML =
        '<div class="rowline"><span class="name">Generado (UTC)</span><span class="val num">' + esc(formatUTC(data.generatedAt)) + '</span></div>' +
        '<div class="rowline"><span class="name">Generado (Caracas)</span><span class="val num">' +
        esc(data.generatedAtCaracas ? String(data.generatedAtCaracas).replace('T', ' ').slice(0, 19) : '—') + '</span></div>' +
        '<div class="rowline"><span class="name">Antigüedad del snapshot</span><span class="val num">' +
        esc(age != null ? fmt(age, 1) + ' min' : '—') + '</span></div>' +
        '<div class="rowline"><span class="name">Origen de lo que ves</span><span class="v' +
        (S.fromCache ? ' neg' : '') + '">' +
        esc(origenTexto) + '</span></div>' +
        '<div class="rowline"><span class="name">Fuente del snapshot</span><span class="val">' + sourceLabel + '</span></div>' +
        '<div class="rowline"><span class="name">EUR referencial</span><span class="val num">' +
        esc((eur && eur.source ? eur.source : '—') + ' · estado ' + (eur && eur.status ? eur.status : '—') +
          ' · dif. ' + (eur && eur.diffPct != null ? fmt(eur.diffPct, 2) + ' %' : '—')) + '</span></div>';
    }

    // Integridad del libro mayor (cadena de hashes).
    const integ = el('chk-integridad');
    if (integ) {
      const eng = globalThis.CTEngine;
      if (S.ledger && eng && typeof eng.verifyChain === 'function') {
        const ok = eng.verifyChain(S.ledger.movements);
        const head = typeof eng.chainHead === 'function' ? eng.chainHead(S.ledger.movements) : null;
        integ.innerHTML = '<p class="' + (ok ? 'hint muted' : 'warnline') + '">' +
          (ok ? '✔' : '⚠') + ' Cadena de hashes del libro mayor: ' + (ok ? 'íntegra' : 'ALTERADA') +
          ' · ' + esc(fmt(S.ledger.movements.length, 0)) + ' movimientos' +
          (head ? ' · cabeza ' + esc(String(head).slice(0, 12)) + '…' : '') + '</p>';
      } else {
        integ.innerHTML = '<p class="hint muted">Libro mayor no disponible en este estado.</p>';
      }
    }

    // Fuentes: estado, HTTP y muestras por fuente + estructura del snapshot.
    const fuentes = el('chk-fuentes');
    if (fuentes) {
      const meta = data.meta || {};
      const sources = data.sources || {};
      const srcHtml = Object.keys(sources).map(function (k) {
        const s = sources[k] || {};
        let muestra = '—';
        if (s.samples && typeof s.samples === 'object') {
          muestra = Object.keys(s.samples).map(function (kk) {
            return esc(kk + ' ' + fmt(s.samples[kk], 0));
          }).join(' · ');
        }
        return '<div class="rowline"><span class="name">' + esc(k) + ' · estado ' + esc(s.status || '—') +
          ' · HTTP ' + esc(s.http != null ? String(s.http) : '—') + '</span><span class="val num">' + muestra + '</span></div>';
      }).join('');
      fuentes.innerHTML = '<div class="card"><h2>Fuentes y estructura</h2>' +
        '<div class="rowline"><span class="name">Pares publicados (meta.fiats)</span><span class="val num">' +
        esc((meta.fiats || FIATS).join(' · ')) + '</span></div>' +
        '<div class="rowline"><span class="name">Páginas P2P / filas por página (meta)</span><span class="val mono">' +
        esc(meta.pages != null ? meta.pages + ' págs. × ' + (meta.rows != null ? meta.rows : '—') + ' filas' : '—') +
        '</span></div>' +
        (srcHtml || '<p class="muted hint">Sin detalle de fuentes.</p>') +
        '</div>';
    }

    renderDiagnosticsShared(data, 'chk-diagnostico');
  }

  // ==================== Botón Actualizar (spinner + feedback) ====================

  // Conectado desde app.js vía el hook CT.onRefreshClick (bindRefresh delega aquí).
  // Deshabilita el botón 8 s, muestra spinner y un feedback honesto del resultado.
  CT.onRefreshClick = async function () {
    const btn = el('btn-refresh');
    const label = el('btn-refresh-label');
    if (!btn || btn.disabled) return;
    const prevGen = S && S.rates && S.rates.generatedAt;
    btn.disabled = true;
    if (btn.classList.add) btn.classList.add('is-busy');
    if (label) label.textContent = 'Actualizando…';
    try {
      await CT.refreshRates(true, 'manual');
      const gen = S && S.rates && S.rates.generatedAt;
      const source = S && S.updateSource;
      if (S && S.fromCache) {
        CT.toast('Error al actualizar: usando copia guardada (último ' + hhmm(prevGen) + ').');
      } else if (gen && gen !== prevGen) {
        CT.toast('Nuevo snapshot ' + hhmm(gen) + ' UTC' + (source ? ' [' + esc(source) + ']' : '') + '.');
        updateRefreshLabel('Actualizado ' + (source || 'automáticamente') + ' a las ' + hhmm(gen) + ' UTC');
      } else {
        CT.toast('Sin cambios (último ' + hhmm(gen || prevGen) + ' UTC).');
        updateRefreshLabel('Sin cambios desde ' + hhmm(gen || prevGen) + ' UTC');
      }
    } catch (e) {
      CT.toast('Error al actualizar: usando copia guardada.');
      updateRefreshLabel('Error: no se pudo actualizar');
    } finally {
      // El botón queda deshabilitado 8 s aunque la red responda antes (anti-spam).
      setTimeout(function () {
        btn.disabled = false;
        if (btn.classList.remove) btn.classList.remove('is-busy');
        if (label) label.textContent = 'Actualizar';
      }, 8000);
    }
  };

  let refreshLabelTimer = null;
  function updateRefreshLabel(msg) {
    const lbl = el('refresh-label-info');
    if (!lbl) return;
    lbl.textContent = msg;
    lbl.hidden = false;
    if (refreshLabelTimer) clearTimeout(refreshLabelTimer);
    refreshLabelTimer = setTimeout(function () { lbl.hidden = true; }, 5000);
  }

  // ==================== Panel Comprobador: toggle ====================

  function bindChkToggle() {
    const btn = el('chk-toggle');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', function () {
      const panel = el('tab-comprobador-panel');
      if (!panel) return;
      panel.hidden = !panel.hidden;
      btn.textContent = panel.hidden ? 'Comprobador' : 'Ocultar comprobador';
    });
  }

  // ==================== Config de la pestaña Tasas ====================

  function pctFrom(input) {
    const v = parseFloat(input && input.value);
    return Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
  }

  function loadConfig() {
    if (!S.ledger) return;
    const st = S.ledger.settings;
    const fill = function (id, val) {
      const e = el(id);
      if (e && e.dataset.filled !== '1') { e.dataset.filled = '1'; e.value = val != null ? String(val) : ''; }
    };
    fill('cfg-comision', st.commissionDefault != null ? st.commissionDefault * 100 : '');
    fill('cfg-comision-cop', st.commissionCop != null ? st.commissionCop * 100 : '');
    fill('cfg-zelle', st.zelleMargin != null ? st.zelleMargin * 100 : '');
    const m = CT.readManualEur ? CT.readManualEur() : { eurUsd: null, eurVes: null };
    fill('cfg-eur-usd', m.eurUsd);
    fill('cfg-eur-ves', m.eurVes);
  }

  function saveConfig() {
    const eng = globalThis.CTEngine;
    if (!S.ledger || !eng) { CT.toast('Config no disponible sin libro cargado.'); return; }
    const st = S.ledger.settings;
    const def = pctFrom(el('cfg-comision'));
    const cop = pctFrom(el('cfg-comision-cop'));
    const zelle = pctFrom(el('cfg-zelle'));
    if (def != null) st.commissionDefault = def / 100;
    if (cop != null) st.commissionCop = cop / 100;
    if (zelle != null) st.zelleMargin = zelle / 100;
    const eu = parseFloat(el('cfg-eur-usd') && el('cfg-eur-usd').value);
    const ev = parseFloat(el('cfg-eur-ves') && el('cfg-eur-ves').value);
    CT.saveManualEur(Number.isFinite(eu) && eu > 0 ? eu : null, Number.isFinite(ev) && ev > 0 ? ev : null);
    eng.save(S.ledger);
    CT.toast('Config guardada.');
  }

  function bindConfig() {
    const btn = el('cfg-guardar');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', saveConfig);
  }

  // ==================== Matriz de pares × MAX/BEST/AVG/MIN (3e/3f) ====================
  // Botón «Matriz» junto a «Forzar bot»: tabla de pares en dirección del usuario
  // (A/B) con los 4 modos a 40 USD equivalentes. La celda SIEMPRE es la tasa
  // cruzada B por A (cotiza A→B: VES por PEN, VES por COP…), NUNCA la inversa:
  // cada par no dirigido se normaliza con RANK (fuerza PEN>COP>CLP>MXN como
  // origen, siempre con VES como destino=B/último) y orden de filas: X/VES
  // primero y luego PEN/COP, PEN/CLP, COP/CLP. Solo valores; la explicación
  // vive dentro de «Detalle» (discreto). Sin inline (CSP).
  var RANK = { PEN: 0, COP: 1, CLP: 2, MXN: 3, VES: 4 }; // resto de monedas (USD/EUR) al final
  function rankOf(code) { return RANK[code] != null ? RANK[code] : 5; }
  function canonDir(pair) {
    return rankOf(pair[0]) > rankOf(pair[1]) ? [pair[1], pair[0]] : [pair[0], pair[1]];
  }
  function matrizFx(origin, dest) {
    if (!S.fx) return null;
    if (!S.rates) return S.fx;
    const fx = Object.assign({}, S.fx);
    fx.pairs = {};
    const buyAds = S.rates.pairs && S.rates.pairs[origin] && S.rates.pairs[origin].ads;
    const sellAds = S.rates.pairs && S.rates.pairs[dest] && S.rates.pairs[dest].ads;
    if (buyAds && Array.isArray(buyAds.compra)) fx.pairs[origin] = { ads: buyAds.compra };
    if (sellAds && Array.isArray(sellAds.venta)) fx.pairs[dest] = { ads: sellAds.venta };
    return fx;
  }

  function renderMatriz(data) {
    const holder = el('ta-matriz');
    if (!holder) return;
    if (!data || !S.fx || !globalThis.CTEngine || !S.ledger) {
      holder.innerHTML = emptyCard('Matriz sin snapshot o libro: pulsa Actualizar.');
      return;
    }
    const eng = globalThis.CTEngine;
    const st = S.ledger.settings;
    const all = (st.pairs || []).concat(st.customPairs || []);
    const modes = [
      { id: 'max', label: 'Máximo' },
      { id: 'best', label: 'Mejor' },
      { id: 'average', label: 'Promedio' },
      { id: 'min', label: 'Mínimo' }
    ];
    const cell = function (scn, mode) {
      const s = scn && scn[mode];
      if (s && s.originRate != null && s.destRate != null) return num(s.destRate / s.originRate, 4);
      return '<span class="muted">—</span>';
    };
    // Dirección del usuario: el par no dirigido se normaliza (celda = B por A)
    // y las filas se ordenan PEN/VES, COP/VES, CLP/VES, MXN/VES, PEN/COP,
    // PEN/CLP, COP/CLP (cota del RANK; los pares del usuario quedan al final).
    const rows = all.map(canonDir)
      .sort(function (x, y) {
        // X/VES primero (grupo 0), luego el resto por fuerza (PEN>COP>CLP>MXN).
        var gx = rankOf(x[1]) === 4 && rankOf(x[0]) < 4 ? 0 : 1;
        var gy = rankOf(y[1]) === 4 && rankOf(y[0]) < 4 ? 0 : 1;
        if (gx !== gy) return gx - gy;
        if (x[0] !== y[0]) return rankOf(x[0]) - rankOf(y[0]);
        return rankOf(x[1]) - rankOf(y[1]);
      })
      .map(function (pair) {
        const fxPair = matrizFx(pair[0], pair[1]);
        const scn = eng.rateScenarios(st, fxPair, pair, 'AB', 40, 'compra');
        return '<tr><td>' + esc(pair[0] + '/' + pair[1]) + '</td>' +
          modes.map(function (m) { return '<td>' + cell(scn, m.id) + '</td>'; }).join('') + '</tr>';
      }).join('');
    // P2: nota visible (fuera del Detalle) — los chips de Casos mantienen el
    // orden de depósito (el modo por defecto deposita B del par), la matriz
    // usa el orden canónico A/B; no se reetiquetan los chips para no romper
    // la semántica de depósito ni ct_caso.
    holder.innerHTML = '<div class="card"><h2>Matriz de tasas</h2>' +
      '<p class="muted hint">Casos: orden de depósito; Matriz: A/B (la celda es B por A).</p>' +
      '<div class="matriz-scroll"><table class="matriz-table"><thead><tr><th scope="col">Par (A→B)</th>' +
      modes.map(function (m) { return '<th scope="col">' + esc(m.label) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<details class="hint-details"><summary>Detalle</summary>' +
      '<p class="muted hint">Celda = unidades de B por 1 A (cotiza A→B: PEN/VES entrega VES por PEN). ' +
      'Matriz Máximo/Mejor/Promedio/Mínimo a 40 US$ equivalentes: en la matriz, Promedio y Mínimo usan ese mismo monto de referencia de 40 US$, no el monto real del caso (el panel Casos sí usa el monto real). Máximo (tercer anuncio) = tercer anuncio de la lista por defecto de Binance y Bybit (mayor de los dos): como no pasa por el filtro de ejecutabilidad, puede quedar por debajo del Mejor (el mejor anuncio ejecutable a 40 US$).</p>' +
      '</details></div>';
  }

  function bindMatriz() {
    const btn = el('btn-matriz');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', function () {
      const holder = el('ta-matriz');
      if (!holder) return;
      holder.hidden = !holder.hidden;
      btn.setAttribute('aria-expanded', holder.hidden ? 'false' : 'true');
      btn.textContent = holder.hidden ? 'Matriz' : 'Ocultar matriz';
      if (!holder.hidden) renderMatriz(S && S.rates);
    });
  }

  // ==================== Render principal ====================

  function renderTasas() {
    const data = S && S.rates;
    loadConfig();
    renderEurRef(data);
    renderBcv(data);
    renderP2p(data);
    renderVariaciones(data);
    renderMultiPares(data);
    renderVesDetalle(data);
    renderDiagnosticsShared(data, 'ta-diagnostico');
    bindChkToggle();
    bindConfig();
    bindMatriz();
    const matrizHolder = el('ta-matriz');
    if (matrizHolder && !matrizHolder.hidden) renderMatriz(data); // re-render al refrescar tasas
    if (typeof CT.renderBotStatus === 'function') CT.renderBotStatus();
    renderLastPublished(data);
  }

  // Última publicación: label con hora de generatedAt
  function renderLastPublished(data) {
    if (!data || !data.generatedAt) return;
    const cont = el('refresh-label-info');
    if (!cont) return;
    // Mostrar hora de última publicación (activado tras un refresh exitoso)
    cont.textContent = 'Última publicación: ' + hhmm(data.generatedAt) + ' UTC';
    cont.hidden = false;
  }

  function renderAll() {
    renderTasas();
    renderComprobador();
  }

  CT.renderTasas = renderTasas;
  CT.renderComprobador = renderComprobador;

  // Si el snapshot ya está cargado (app.js corrió antes), renderiza de inmediato;
  // si no, la pestaña renderiza al abrirse o al actualizar (CT.parts.tasas).
  if (S && S.rates) {
    try { renderAll(); } catch (e) { /* app.js mostrará el error vía renderTab */ }
  }
})();
