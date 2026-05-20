/**
 * chartScreenshot.js — Capture a screenshot of a specific TradingView chart
 * via Chrome DevTools Protocol (CDP).
 *
 * 2026-05-19: Built for Vision Phase 5. Sibling to tvPriceClient.js which
 * scrapes the watchlist; this module captures the chart area.
 *
 * Discovery: each TV chart tab has its active symbol in the URL query
 * string (e.g. `?symbol=NASDAQ:SPY`) AND in the in-page `pane-legend`
 * element. We match by URL first (cheaper, no Runtime.evaluate), then
 * fall back to DOM probe when the URL doesn't include the symbol param.
 *
 * Output: { buffer: Buffer, dataUrl: string, path: string, targetId, symbol, ts }
 *
 * Saves to screenshots/vision/{YYYY-MM-DD}/{ts}-{symbol}-{tag}.png by
 * default so the operator can audit which image the model saw.
 */

import CDP from 'chrome-remote-interface';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CDP_HOST = 'localhost';
const CDP_PORT = parseInt(process.env.TV_CDP_PORT || '9222', 10);

// Per-symbol cached target ID — chart tabs are stable per browser session.
const _targetCache = new Map();   // symbol → targetId

function _etDateStr() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

async function _listChartTargets() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const all  = await resp.json();
  return all.filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
}

// Returns the symbol the chart is currently showing. TV's DOM has the
// active chart symbol in [class*="value-XXXXXX"] elements (status bar +
// chart legend + small badge — typically 3 occurrences on a single-chart
// tab). The watchlist panel uses [class*="symbolNameText"] which lists
// ALL symbols on every tab — useless for identifying THIS chart.
//
// We frequency-count occurrences of known instrument names in value-
// elements and return the dominant one. Filters out incidental matches
// in nav menus, search results, etc.
const _SYMBOL_PROBE_JS = `
(function() {
  var instruments = ['SPY','QQQ','IWM','MES1!','MNQ1!','ES1!','NQ1!','GOOGL','AAPL','MSFT','NVDA','META','AMZN','TSLA'];
  var counts = {};
  var nodes = document.querySelectorAll('[class*="value-"]');
  for (var i = 0; i < nodes.length; i++) {
    var t = (nodes[i].textContent || '').trim();
    if (instruments.indexOf(t) === -1) continue;
    counts[t] = (counts[t] || 0) + 1;
  }
  var best = null, max = 0;
  for (var k in counts) { if (counts[k] > max) { max = counts[k]; best = k; } }
  return { symbol: best };
})()
`;

function _extractSymbolFromUrl(url) {
  try {
    const u = new URL(url);
    const s = u.searchParams.get('symbol');
    if (!s) return null;
    // Strip exchange prefix: NASDAQ:SPY → SPY, CME_MINI:MES1! → MES1!
    return s.includes(':') ? s.split(':').pop() : s;
  } catch { return null; }
}

// Per-CDP-operation timeout. Without this, a single hung tab probe blocks
// the whole captureChartImage. 2026-05-19 18:36 — operator's futures
// alerts saw 8s VISION_TIMEOUT on every call because chartScreenshot
// iterated 6 tabs with no per-tab budget.
const _CDP_PROBE_TIMEOUT_MS = parseInt(process.env.CDP_PROBE_TIMEOUT_MS || '1500', 10);

function _withTimeout(promise, ms, label) {
  let handle;
  const timeout = new Promise((_, reject) => {
    handle = setTimeout(() => reject(new Error(`TIMEOUT_${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (handle) clearTimeout(handle);
  });
}

// 2026-05-19 18:36 — fallback chains so vision can score futures even
// when the operator's TV layout has the futures charts in a different
// debug-target window. Falls back to the correlated equity chart for
// the same market (Nasdaq → QQQ, S&P → SPY) — same price-action shape,
// vision can still read structural extremes / exhaustion.
const _FALLBACK_CHAIN = {
  'NQ1!':  ['NQ1!',  'MNQ1!', 'QQQ'],
  'MNQ1!': ['MNQ1!', 'NQ1!',  'QQQ'],
  'ES1!':  ['ES1!',  'MES1!', 'SPY'],
  'MES1!': ['MES1!', 'ES1!',  'SPY'],
};

// 2026-05-19 20:30 ET — tab-symbol cache. Operator's 8 NQ-family alerts
// at 20:27:07-09 all hit VISION_TIMEOUT because sequential CDP probe of
// 6 tabs (~1-2s each) exceeded the 8s outer Vision budget BEFORE
// discovery completed. Cache the tab→symbol mapping for 30s so repeat
// calls are sub-ms.
const _tabSymbolCache = new Map();  // targetId → {symbol, ts}
const _TAB_SYMBOL_CACHE_TTL_MS = parseInt(process.env.TAB_SYMBOL_CACHE_TTL_MS || '30000', 10);

async function _findTargetForSymbol(symbol) {
  const want = (symbol || '').toUpperCase();
  const targets = await _listChartTargets();
  if (!targets.length) throw new Error('NO_TV_CHART_TARGETS — is TradingView Desktop running?');

  // Build the chain of acceptable symbols (primary + fallbacks).
  const chain = _FALLBACK_CHAIN[want] || [want];

  // Phase 1 — URL match against each chain symbol (cheapest, ~0ms)
  for (const candidate of chain) {
    for (const t of targets) {
      const urlSym = (_extractSymbolFromUrl(t.url) || '').toUpperCase();
      if (urlSym === candidate) return { target: t, matchedSymbol: candidate, viaFallback: candidate !== want };
    }
  }

  // Phase 2 — DOM probe each target. Parallelized via Promise.all so
  // 6 tabs probe in ~1.5s total instead of ~9s sequential. Cache hits
  // skip the probe entirely.
  const now = Date.now();
  const tabSymbols = new Map();
  const toProbe = [];
  for (const t of targets) {
    const cached = _tabSymbolCache.get(t.id);
    if (cached && (now - cached.ts) < _TAB_SYMBOL_CACHE_TTL_MS) {
      tabSymbols.set(t.id, cached.symbol);
    } else {
      toProbe.push(t);
    }
  }
  // GC stale cache entries (targets that no longer exist)
  const currentIds = new Set(targets.map(t => t.id));
  for (const cachedId of _tabSymbolCache.keys()) {
    if (!currentIds.has(cachedId)) _tabSymbolCache.delete(cachedId);
  }
  // Parallel probe of uncached tabs
  await Promise.all(toProbe.map(async (t) => {
    let client;
    try {
      const work = (async () => {
        client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: t.id });
        await client.Runtime.enable();
        const r = await client.Runtime.evaluate({ expression: _SYMBOL_PROBE_JS, returnByValue: true });
        return (r.result?.value?.symbol || '').toUpperCase();
      })();
      const sym = await _withTimeout(work, _CDP_PROBE_TIMEOUT_MS, 'PROBE');
      tabSymbols.set(t.id, sym);
      _tabSymbolCache.set(t.id, { symbol: sym, ts: Date.now() });
    } catch {
      // Probe failed/timed out — move on; cache nothing for retry next call.
    } finally {
      try { await client?.close(); } catch {}
    }
  }));

  // Now walk chain in priority order
  for (const candidate of chain) {
    for (const t of targets) {
      const sym = tabSymbols.get(t.id);
      if (sym && sym.includes(candidate)) return { target: t, matchedSymbol: candidate, viaFallback: candidate !== want };
    }
  }

  return null;
}

/**
 * Capture a PNG screenshot of the TV chart for the given symbol.
 *
 * @param {string} symbol e.g. "SPY", "MES1!", "NQ1!"
 * @param {object} opts  { tag?: string, persist?: boolean, fullPage?: boolean }
 * @returns {Promise<{ buffer: Buffer, dataUrl: string, path?: string, targetId: string, symbol: string, ts: number }>}
 *
 * Throws on:
 *   NO_TV_CHART_TARGETS — TV Desktop not running
 *   NO_TV_TAB_FOR_<SYM> — no tab matches the requested symbol
 *   CDP_SCREENSHOT_FAILED — Page.captureScreenshot returned no data
 */
export async function captureChartImage(symbol, opts = {}) {
  const { tag = 'manual', persist = true, fullPage = false } = opts;
  const want = (symbol || '').toUpperCase();
  if (!want) throw new Error('captureChartImage: symbol required');

  // Cache check — but always re-validate URL contains symbol (tab could
  // have been navigated away in between calls).
  const cachedId = _targetCache.get(want);
  let target = null;
  let matchedSymbol = want;
  let viaFallback = false;
  if (cachedId) {
    const all = await _listChartTargets();
    const t = all.find(t => t.id === cachedId);
    if (t && (_extractSymbolFromUrl(t.url) || '').toUpperCase() === want) target = t;
  }
  if (!target) {
    const found = await _findTargetForSymbol(want);
    if (!found) throw new Error(`NO_TV_TAB_FOR_${want}`);
    target = found.target;
    matchedSymbol = found.matchedSymbol;
    viaFallback = found.viaFallback;
    if (!viaFallback) _targetCache.set(want, target.id);
    // Don't cache fallback matches under the requested symbol —
    // could prevent future direct matches if the primary tab opens later.
  }

  // Connect + enable Page domain + capture.
  let client;
  let dataUrl, buffer;
  try {
    client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
    await client.Page.enable();
    // Brief settle in case the tab was just navigated.
    const shot = await client.Page.captureScreenshot({
      format: 'png',
      captureBeyondViewport: !!fullPage,
    });
    if (!shot?.data) throw new Error('CDP_SCREENSHOT_FAILED');
    buffer  = Buffer.from(shot.data, 'base64');
    dataUrl = `data:image/png;base64,${shot.data}`;
  } finally {
    try { await client?.close(); } catch {}
  }

  const ts = Date.now();
  let outPath = null;
  if (persist) {
    const dir = join(__dirname, 'screenshots', 'vision', _etDateStr());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const safeSym = want.replace(/[^A-Z0-9]/g, '');
    outPath = join(dir, `${ts}-${safeSym}-${tag}.png`);
    writeFileSync(outPath, buffer);
  }

  return {
    buffer, dataUrl, path: outPath,
    targetId: target.id,
    symbol: want,           // what was requested
    matchedSymbol,          // what we actually captured (may differ from `symbol` if fallback)
    viaFallback,            // true if we captured a related chart (e.g. NQ1!→QQQ)
    ts,
  };
}
