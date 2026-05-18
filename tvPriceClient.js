/**
 * tvPriceClient.js — TradingView CDP watchlist price feed
 *
 * 2026-05-18: replacement data source for futuresPricer.js after Webull paper
 * account proved to lack US_FUTURES quote entitlement (401 Unauthorized on
 * every get_futures_snapshot call). TV Desktop is already running with CDP
 * on port 9222 and the operator has added ES1!/NQ1!/MES1!/MNQ1! to the
 * watchlist (confirmed 2026-05-18 ~08:30 ET — all four present with prices).
 *
 * Self-contained CDP client — does NOT import src/connection.js. The MCP
 * server's CDP client is for the agent layer; this one is for the
 * webhook-server price feed. Both can attach to the same TV page
 * simultaneously (CDP supports multiple clients per target).
 *
 * Scraper mirrors src/core/watchlist.js (data-symbol-full attributes +
 * first-numeric-cell extraction). One CDP evaluate per tick returns all 4
 * prices in a single round-trip — no per-symbol MCP calls.
 *
 * Symbol matching uses exact colon-suffix form (`endsWith(':ES1!')`) so
 * `CME_MINI:MES1!` doesn't false-positive when looking for `ES1!`.
 */

import CDP from 'chrome-remote-interface';

const CDP_HOST = 'localhost';
const CDP_PORT = parseInt(process.env.TV_CDP_PORT || '9222', 10);

let _client   = null;
let _targetId = null;

async function _findTvTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  return targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
      || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url))
      || null;
}

async function _connect() {
  const target = await _findTvTarget();
  if (!target) throw new Error(`No TradingView chart target on CDP port ${CDP_PORT} — is TV Desktop running?`);
  const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
  await client.Runtime.enable();
  _client = client;
  _targetId = target.id;
  return client;
}

async function _getClient() {
  if (_client) {
    try {
      await _client.Runtime.evaluate({ expression: '1', returnByValue: true });
      return _client;
    } catch {
      try { await _client.close(); } catch {}
      _client = null;
      _targetId = null;
    }
  }
  return _connect();
}

// Watchlist scraper — runs in TV page context. Returns either { prices: {...} }
// keyed by full TV symbol (e.g. "CME_MINI:ES1!") or { error: '<reason>' }.
// First numeric cell per row is treated as `last`; subsequent cells (change,
// pct) are not consumed here since the consumer only needs last-price.
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
      // First cell that's a pure number (no % suffix) is the last-price column
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

const _TARGET_SYMBOLS = ['ES1!', 'NQ1!', 'MES1!', 'MNQ1!'];

/**
 * Fetch the latest last-prices for ES1!/NQ1!/MES1!/MNQ1! from the TV
 * watchlist. Returns a partial map — symbols not in the watchlist (or
 * without a valid numeric `last` cell) are omitted; caller handles
 * missing entries as per-symbol failures.
 *
 * Throws on CDP unavailability, TV not running, or scraper-level errors
 * (panel_closed / no_symbol_rows) so the caller's tick-level fail
 * counter increments uniformly across all symbols.
 */
export async function getFuturesWatchlistPrices() {
  const client = await _getClient();
  const result = await client.Runtime.evaluate({
    expression: _SCRAPER_JS,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
             || result.exceptionDetails.text
             || 'unknown CDP eval error';
    throw new Error(`CDP_EVAL_ERROR: ${msg}`);
  }
  const data = result.result?.value;
  if (data?.error) throw new Error(`SCRAPER_${String(data.error).toUpperCase()}`);
  const all = data?.prices || {};

  // Exact-match the suffix to avoid MES1!↔ES1! confusion. Accept both the
  // exchange-prefixed form ("CME_MINI:ES1!") and the bare form ("ES1!").
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

export async function disconnectTvPriceClient() {
  if (_client) {
    try { await _client.close(); } catch {}
    _client = null;
    _targetId = null;
  }
}
