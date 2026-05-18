/**
 * tvPriceClient.js — TradingView CDP watchlist price feed
 *
 * 2026-05-18: replacement data source for futuresPricer.js after Webull
 * paper account proved to lack US_FUTURES quote entitlement.
 *
 * 2026-05-18 11:05 ET: when operator has multiple TV chart tabs open (12
 * CDP targets observed today, 5 of them chart pages), the watchlist panel
 * is open on SOME tabs and collapsed on others. Earlier _findTvTarget()
 * grabbed whichever chart target came back first from /json/list and
 * stuck with it — non-deterministic, and after restart it landed on a
 * 45px-wide tab with zero symbols, producing perpetual
 * SCRAPER_PANEL_CLOSED despite operator's "watchlist is still active".
 *
 * Fix: probe every chart target on first connect (and on miss), pick the
 * one where our target futures (ES1!/NQ1!/MES1!/MNQ1!) are actually
 * present. Cache the winning target ID; re-probe only when it goes bad.
 *
 * Symbol matching uses exact colon-suffix form (`endsWith(':ES1!')`) so
 * `CME_MINI:MES1!` doesn't false-positive when looking for `ES1!`.
 */

import CDP from 'chrome-remote-interface';

const CDP_HOST = 'localhost';
const CDP_PORT = parseInt(process.env.TV_CDP_PORT || '9222', 10);

const _TARGET_SYMBOLS = ['ES1!', 'NQ1!', 'MES1!', 'MNQ1!'];

let _client   = null;
let _targetId = null;

async function _listChartTargets() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const all  = await resp.json();
  return all.filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
}

async function _connectTo(targetId) {
  if (_client) { try { await _client.close(); } catch {} }
  const c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
  await c.Runtime.enable();
  _client = c;
  _targetId = targetId;
  return c;
}

// Light-weight probe: count how many of our target futures are visible in
// the right-panel watchlist. Returns { matchCount, totalRows, panelWidth }.
// Doesn't extract prices — just confirms the right tab.
const _PROBE_JS = `
(function() {
  var ra = document.querySelector('[class*="layout__area--right"]');
  var panelWidth = ra ? ra.offsetWidth : 0;
  if (!ra || panelWidth < 50) return { matchCount: 0, totalRows: 0, panelWidth: panelWidth, matchedSymbols: [] };
  var rows = ra.querySelectorAll('[data-symbol-full]');
  var targets = ${JSON.stringify(_TARGET_SYMBOLS)};
  var matched = [];
  for (var i = 0; i < rows.length; i++) {
    var sym = rows[i].getAttribute('data-symbol-full') || '';
    for (var j = 0; j < targets.length; j++) {
      if (sym === targets[j] || sym.endsWith(':' + targets[j])) {
        if (matched.indexOf(targets[j]) === -1) matched.push(targets[j]);
        break;
      }
    }
  }
  return { matchCount: matched.length, totalRows: rows.length, panelWidth: panelWidth, matchedSymbols: matched };
})()
`;

async function _probeClient(client) {
  try {
    const r = await client.Runtime.evaluate({ expression: _PROBE_JS, returnByValue: true });
    return r.result?.value || { matchCount: 0, totalRows: 0, panelWidth: 0 };
  } catch { return { matchCount: 0, totalRows: 0, panelWidth: 0 }; }
}

async function _ensureGoodClient() {
  const targets = await _listChartTargets();
  if (!targets.length) throw new Error('NO_TV_CHART_TARGETS — is TradingView Desktop running?');

  // 1. Try cached target first (fast path)
  if (_client && _targetId && targets.find(t => t.id === _targetId)) {
    try {
      const v = await _probeClient(_client);
      if (v.matchCount === _TARGET_SYMBOLS.length) return _client;
    } catch {
      _client = null; _targetId = null;
    }
  }

  // 2. Probe every chart target, pick the one with all 4 target futures
  let bestTarget = null;
  let bestMatch  = -1;
  for (const t of targets) {
    try {
      const c = await _connectTo(t.id);
      const v = await _probeClient(c);
      if (v.matchCount > bestMatch) {
        bestMatch = v.matchCount;
        bestTarget = { target: t, probe: v };
      }
      if (v.matchCount === _TARGET_SYMBOLS.length) {
        console.log(`  [tvPriceClient] using TV target ${t.id.slice(0, 8)}  (${v.matchCount}/${_TARGET_SYMBOLS.length} target symbols, ${v.totalRows} rows, ${v.panelWidth}px)`);
        return c;
      }
    } catch {}
  }

  // 3. No tab has all 4 — surface the best partial we found, fail loudly
  if (bestTarget && bestMatch > 0) {
    // Reconnect to best partial; surface what's missing
    const c = await _connectTo(bestTarget.target.id);
    const missing = _TARGET_SYMBOLS.filter(s => !bestTarget.probe.matchedSymbols.includes(s));
    console.log(`  [tvPriceClient] PARTIAL — best TV target ${bestTarget.target.id.slice(0, 8)} has ${bestMatch}/${_TARGET_SYMBOLS.length}; missing: ${missing.join(',')}`);
    return c;
  }
  _client = null; _targetId = null;
  throw new Error(`NO_TV_TAB_WITH_TARGET_SYMBOLS — probed ${targets.length} chart tab(s), none have any of ${_TARGET_SYMBOLS.join('/')} in a visible watchlist (≥50px panel width)`);
}

// Full scraper — pulls last-price for every symbol in the right panel.
// Called only after _ensureGoodClient confirms we're on the right tab.
const _SCRAPER_JS = `
(function() {
  var container = document.querySelector('[class*="layout__area--right"]');
  if (!container || container.offsetWidth < 50) return { error: 'panel_closed' };
  var rows = container.querySelectorAll('[data-symbol-full]');
  if (!rows.length) return { error: 'no_symbol_rows' };
  var out = {};
  var seen = {};
  for (var i = 0; i < rows.length; i++) {
    var sym = rows[i].getAttribute('data-symbol-full');
    if (!sym || seen[sym]) continue;
    seen[sym] = true;
    var row = rows[i].closest('[class*="row"]') || rows[i].parentElement;
    if (!row) continue;
    var cells = row.querySelectorAll('[class*="cell"], [class*="column"]');
    for (var j = 0; j < cells.length; j++) {
      var t = cells[j].textContent.trim();
      if (!t) continue;
      var stripped = t.replace(/[\\s,]/g, '');
      if (/^[\\-+]?\\d+\\.?\\d*$/.test(stripped)) {
        var n = parseFloat(stripped);
        if (isFinite(n)) out[sym] = n;
        break;
      }
    }
  }
  return { prices: out };
})()
`;

/**
 * Fetch the latest last-prices for ES1!/NQ1!/MES1!/MNQ1! from the TV
 * watchlist. Auto-discovers the correct TV tab when multiple are open.
 *
 * Throws on:
 *   NO_TV_CHART_TARGETS         — TV Desktop not running
 *   NO_TV_TAB_WITH_TARGET_SYMBOLS — no tab has the target futures visible
 *   CDP_EVAL_ERROR              — runtime exception during scrape
 *   SCRAPER_*                   — page-side scraper detected stale state
 */
export async function getFuturesWatchlistPrices() {
  const client = await _ensureGoodClient();
  const result = await client.Runtime.evaluate({
    expression: _SCRAPER_JS,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
             || result.exceptionDetails.text
             || 'unknown CDP eval error';
    // Drop the cached client — next call re-probes.
    try { await _client?.close(); } catch {}
    _client = null; _targetId = null;
    throw new Error(`CDP_EVAL_ERROR: ${msg}`);
  }
  const data = result.result?.value;
  if (data?.error) {
    // Likely the operator collapsed the watchlist on the cached tab;
    // drop the cached client so next call re-probes other tabs.
    try { await _client?.close(); } catch {}
    _client = null; _targetId = null;
    throw new Error(`SCRAPER_${String(data.error).toUpperCase()}`);
  }
  const all = data?.prices || {};

  const out = {};
  for (const sym of _TARGET_SYMBOLS) {
    for (const key of Object.keys(all)) {
      if (key === sym || key.endsWith(':' + sym)) {
        out[sym] = all[key];
        break;
      }
    }
  }
  return out;
}

// 2026-05-18 — TV watchlist keepalive. Chrome background-tab throttling +
// TV's internal pause-on-inactive cause the watchlist DOM to freeze on
// unfocused tabs. Operator verified that a manual scroll on the panel
// breaks the cache and triggers fresh price renders. This nudge
// oscillates scrollTop by 1px (then resets on the next frame), causing
// TV's renderer to re-paint without any visual change for the operator.
// Stays as a primary defense; stale-detection in futuresPricer becomes
// the safety net for the residual case where the panel renderer is
// fully paused.
const _NUDGE_JS = `
(function() {
  try {
    var panel = document.querySelector('[class*="layout__area--right"]');
    if (!panel || panel.offsetWidth < 50) return { ok: false, reason: 'panel_closed' };
    var scrollable = panel.querySelector('[class*="list-"]')
                  || panel.querySelector('[class*="watchlist"]')
                  || panel;
    var origScroll = scrollable.scrollTop;
    scrollable.scrollTop = origScroll + 1;
    // Restore on next frame so the visible scroll position doesn't drift.
    requestAnimationFrame(function() { scrollable.scrollTop = origScroll; });
    return { ok: true, scrollTop: origScroll };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || 'unknown' };
  }
})()
`;

export async function nudgeWatchlist() {
  let client;
  try {
    client = await _ensureGoodClient();
  } catch (e) {
    return { ok: false, error: 'no-client: ' + (e.message || 'unknown').slice(0, 80) };
  }
  try {
    const r = await client.Runtime.evaluate({ expression: _NUDGE_JS, returnByValue: true });
    if (r.exceptionDetails) {
      return { ok: false, error: 'cdp-eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'unknown').slice(0, 80) };
    }
    return r.result?.value || { ok: false, reason: 'no_result' };
  } catch (e) {
    return { ok: false, error: (e.message || 'unknown').slice(0, 80) };
  }
}

export async function disconnectTvPriceClient() {
  if (_client) {
    try { await _client.close(); } catch {}
    _client = null;
    _targetId = null;
  }
}
