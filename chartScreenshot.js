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

// 2026-05-19 20:42 ET — bound the CDP connect+capture. Operator's NQ1!
// tab repeatedly hangs Page.captureScreenshot long enough to blow the
// 8s outer Vision budget even with sub-1s discovery. Bail at this
// budget so captureChartImage can try the next chain candidate.
const _CDP_CAPTURE_TIMEOUT_MS = parseInt(process.env.CDP_CAPTURE_TIMEOUT_MS || '5500', 10);

// Returns ordered list of candidates from the fallback chain that
// resolved to a live tab. captureChartImage iterates this list and
// tries each one — letting us survive a single hung tab (e.g. frozen
// NQ1! renderer) by falling through to MNQ1!/QQQ.
async function _resolveChainCandidates(symbol) {
  const want = (symbol || '').toUpperCase();
  const targets = await _listChartTargets();
  if (!targets.length) throw new Error('NO_TV_CHART_TARGETS — is TradingView Desktop running?');

  const chain = _FALLBACK_CHAIN[want] || [want];

  // URL match (cheapest, ~0ms) — index by candidate
  const urlMatches = new Map();  // candidate → target
  for (const candidate of chain) {
    for (const t of targets) {
      const urlSym = (_extractSymbolFromUrl(t.url) || '').toUpperCase();
      if (urlSym === candidate && !urlMatches.has(candidate)) urlMatches.set(candidate, t);
    }
  }

  // DOM probe — parallelized via Promise.all; cache hits skip the probe.
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
  const currentIds = new Set(targets.map(t => t.id));
  for (const cachedId of _tabSymbolCache.keys()) {
    if (!currentIds.has(cachedId)) _tabSymbolCache.delete(cachedId);
  }
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

  // Build ordered candidate list: for each chain symbol, prefer URL match,
  // fall back to DOM match. Skip duplicates by target id.
  const seenIds = new Set();
  const candidates = [];
  for (const candidate of chain) {
    const viaFallback = candidate !== want;
    const urlT = urlMatches.get(candidate);
    if (urlT && !seenIds.has(urlT.id)) {
      candidates.push({ target: urlT, matchedSymbol: candidate, viaFallback });
      seenIds.add(urlT.id);
    }
    for (const t of targets) {
      if (seenIds.has(t.id)) continue;
      const sym = tabSymbols.get(t.id);
      if (sym && sym.includes(candidate)) {
        candidates.push({ target: t, matchedSymbol: candidate, viaFallback });
        seenIds.add(t.id);
      }
    }
  }
  return candidates;
}

// Wrap CDP connect + screenshot in a single timeout so a hung tab
// can't burn the entire Vision budget. Returns { buffer, dataUrl }
// or throws TIMEOUT_CAPTURE.
async function _captureFromTarget(target, fullPage) {
  let client;
  const work = (async () => {
    client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
    await client.Page.enable();
    const shot = await client.Page.captureScreenshot({
      format: 'png',
      captureBeyondViewport: !!fullPage,
    });
    if (!shot?.data) throw new Error('CDP_SCREENSHOT_FAILED');
    return {
      buffer:  Buffer.from(shot.data, 'base64'),
      dataUrl: `data:image/png;base64,${shot.data}`,
    };
  })();
  try {
    return await _withTimeout(work, _CDP_CAPTURE_TIMEOUT_MS, 'CAPTURE');
  } finally {
    try { await client?.close(); } catch {}
  }
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

  // Try cached target first — validates URL still matches.
  const cachedId = _targetCache.get(want);
  if (cachedId) {
    const all = await _listChartTargets();
    const t = all.find(t => t.id === cachedId);
    if (t && (_extractSymbolFromUrl(t.url) || '').toUpperCase() === want) {
      try {
        const { buffer, dataUrl } = await _captureFromTarget(t, fullPage);
        return _packageResult(buffer, dataUrl, t.id, want, want, false, persist, tag);
      } catch (e) {
        // Hung/dead tab — drop cache and fall through to chain discovery.
        _targetCache.delete(want);
      }
    } else {
      _targetCache.delete(want);
    }
  }

  // Resolve ordered chain candidates and try each until one captures.
  const candidates = await _resolveChainCandidates(want);
  if (!candidates.length) throw new Error(`NO_TV_TAB_FOR_${want}`);

  const failures = [];
  for (const c of candidates) {
    try {
      const { buffer, dataUrl } = await _captureFromTarget(c.target, fullPage);
      if (!c.viaFallback) _targetCache.set(want, c.target.id);
      return _packageResult(buffer, dataUrl, c.target.id, want, c.matchedSymbol, c.viaFallback, persist, tag);
    } catch (e) {
      failures.push(`${c.matchedSymbol}:${e.message}`);
      // Try next candidate.
    }
  }
  throw new Error(`CDP_SCREENSHOT_ALL_FAILED_${want} [${failures.join(', ')}]`);
}

function _packageResult(buffer, dataUrl, targetId, want, matchedSymbol, viaFallback, persist, tag) {
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
    targetId,
    symbol: want,
    matchedSymbol,
    viaFallback,
    ts,
  };
}
