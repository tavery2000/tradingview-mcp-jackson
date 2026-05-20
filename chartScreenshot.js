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

// Operator's TV layouts — primary path for tab→symbol resolution.
// Each chart tab in TV is one named layout (dropdown top-right of the
// chart). Layout names are stable across sessions/reboots, unlike the
// layout-hash URLs and the brittle DOM symbol scrape. Maintain this
// list when layouts are added or renamed.
const _LAYOUT_TO_SYMBOLS = {
  'Claude SPY':     ['SPY'],
  'Claude 5M':      ['SPY','MES1!','ES1!','QQQ','NQ1!','MNQ1!'],
  'Claude 6 Chart': ['NVDA','MSFT','AAPL','AMZN','META','GOOGL'],
  'Claude QQQ':     ['QQQ','AMD','AVGO','TSLA','ARM','NVDA'],
  'Claude Futures': ['ES1!','NQ1!','MNQ1!'],
  'Cluade MES':     ['MES1!'],   // typo in TV layout name — match exactly
};
const _LAYOUT_NAMES_JSON = JSON.stringify(Object.keys(_LAYOUT_TO_SYMBOLS));

// Combined probe — returns both the layout name (primary) and the
// status-bar symbol scrape (fallback) in a single CDP roundtrip.
const _SYMBOL_PROBE_JS = `
(function() {
  var layoutNames = ${_LAYOUT_NAMES_JSON};
  var instruments = ['SPY','QQQ','IWM','MES1!','MNQ1!','ES1!','NQ1!','GOOGL','AAPL','MSFT','NVDA','META','AMZN','TSLA'];

  // === Layout name probe (primary) ===
  var layout = null;
  function checkLayout(s) {
    if (!s) return null;
    s = String(s).trim();
    for (var i = 0; i < layoutNames.length; i++) if (s === layoutNames[i]) return layoutNames[i];
    return null;
  }
  try {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      layout = checkLayout(node.nodeValue);
      if (layout) break;
    }
  } catch (e) {}
  if (!layout) {
    try {
      var els = document.querySelectorAll('[title], [aria-label]');
      for (var i = 0; i < els.length; i++) {
        layout = checkLayout(els[i].getAttribute('title')) || checkLayout(els[i].getAttribute('aria-label'));
        if (layout) break;
      }
    } catch (e) {}
  }

  // === Symbol probe (status bar — fallback) ===
  var counts = {};
  var nodes = document.querySelectorAll('[class*="value-"]');
  for (var i = 0; i < nodes.length; i++) {
    var t = (nodes[i].textContent || '').trim();
    if (instruments.indexOf(t) === -1) continue;
    counts[t] = (counts[t] || 0) + 1;
  }
  var best = null, max = 0;
  for (var k in counts) { if (counts[k] > max) { max = counts[k]; best = k; } }

  return { layout: layout, symbol: best };
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

// 2026-05-19 20:30 ET — tab-info cache. Now caches {layout, symbol}
// per tab to support both layout-name primary matching and the
// legacy DOM symbol scrape. Layouts rarely change so we can hold for
// longer; bump TTL accordingly.
const _tabInfoCache = new Map();  // targetId → {info: {layout, symbol}, ts}
const _TAB_INFO_CACHE_TTL_MS = parseInt(process.env.TAB_INFO_CACHE_TTL_MS || '300000', 10); // 5 min

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

  // Combined probe — parallelized via Promise.all; cache hits skip the probe.
  const now = Date.now();
  const tabInfo = new Map();    // targetId → {layout, symbol}
  const toProbe = [];
  for (const t of targets) {
    const cached = _tabInfoCache.get(t.id);
    if (cached && (now - cached.ts) < _TAB_INFO_CACHE_TTL_MS) {
      tabInfo.set(t.id, cached.info);
    } else {
      toProbe.push(t);
    }
  }
  const currentIds = new Set(targets.map(t => t.id));
  for (const cachedId of [..._tabInfoCache.keys()]) {
    if (!currentIds.has(cachedId)) _tabInfoCache.delete(cachedId);
  }
  await Promise.all(toProbe.map(async (t) => {
    let client;
    try {
      const work = (async () => {
        client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: t.id });
        await client.Runtime.enable();
        const r = await client.Runtime.evaluate({ expression: _SYMBOL_PROBE_JS, returnByValue: true });
        const v = r.result?.value || {};
        return {
          layout: v.layout || null,
          symbol: (v.symbol || '').toUpperCase() || null,
        };
      })();
      const info = await _withTimeout(work, _CDP_PROBE_TIMEOUT_MS, 'PROBE');
      tabInfo.set(t.id, info);
      _tabInfoCache.set(t.id, { info, ts: Date.now() });
    } catch {
      // Probe failed/timed out — move on; cache nothing for retry next call.
    } finally {
      try { await client?.close(); } catch {}
    }
  }));

  // Build ordered candidate list. Priority per chain symbol:
  //   1. URL match (exact ?symbol=… — rare in operator's TV setup)
  //   2. Layout match — pick smallest layout (most focused chart) first
  //   3. DOM symbol exact match (status-bar scrape)
  //   4. DOM symbol substring match (legacy fallback)
  const seenIds = new Set();
  const candidates = [];
  for (const candidate of chain) {
    const viaFallback = candidate !== want;

    // 1. URL
    const urlT = urlMatches.get(candidate);
    if (urlT && !seenIds.has(urlT.id)) {
      candidates.push({ target: urlT, matchedSymbol: candidate, viaFallback });
      seenIds.add(urlT.id);
    }

    // 2. Layout — ordered by fewest symbols (most focused)
    const layoutMatches = [];
    for (const t of targets) {
      if (seenIds.has(t.id)) continue;
      const layout = tabInfo.get(t.id)?.layout;
      const syms = layout ? (_LAYOUT_TO_SYMBOLS[layout] || []) : null;
      if (syms && syms.includes(candidate)) {
        layoutMatches.push({ target: t, precision: syms.length });
      }
    }
    layoutMatches.sort((a, b) => a.precision - b.precision);
    for (const m of layoutMatches) {
      candidates.push({ target: m.target, matchedSymbol: candidate, viaFallback });
      seenIds.add(m.target.id);
    }

    // 3. DOM symbol — exact match
    for (const t of targets) {
      if (seenIds.has(t.id)) continue;
      const sym = tabInfo.get(t.id)?.symbol;
      if (sym && sym === candidate) {
        candidates.push({ target: t, matchedSymbol: candidate, viaFallback });
        seenIds.add(t.id);
      }
    }

    // 4. DOM symbol — substring fallback (legacy)
    for (const t of targets) {
      if (seenIds.has(t.id)) continue;
      const sym = tabInfo.get(t.id)?.symbol;
      if (sym && sym.includes(candidate)) {
        candidates.push({ target: t, matchedSymbol: candidate, viaFallback });
        seenIds.add(t.id);
      }
    }
  }
  return candidates;
}

// Per-tab screenshot cache + in-flight dedup. 2026-05-19 21:52 ET —
// operator saw 4 alerts (ES1! BUY+ZONE, NQ1! BUY+ZONE) all routing to
// the "Claude Futures" tab at 21:50:11 simultaneously time out. Same
// TV renderer can't service parallel Page.captureScreenshot calls;
// they queue and overflow the 12s outer budget. Coalescing collapses
// the burst to a single capture and lets the other 3 reuse the buffer.
const _screenshotCache = new Map();    // targetId → {buffer, dataUrl, ts}
const _inflightCaptures = new Map();   // targetId → Promise<{buffer, dataUrl}>
const _SCREENSHOT_CACHE_TTL_MS = parseInt(process.env.SCREENSHOT_CACHE_TTL_MS || '5000', 10);

async function _captureFromTarget(target, fullPage) {
  const now = Date.now();

  // Cache hit — burst of alerts on the same tab within TTL share the buffer.
  const cached = _screenshotCache.get(target.id);
  if (cached && (now - cached.ts) < _SCREENSHOT_CACHE_TTL_MS) {
    return { buffer: cached.buffer, dataUrl: cached.dataUrl };
  }

  // Coalesce concurrent captures for the same tab.
  const inflight = _inflightCaptures.get(target.id);
  if (inflight) return inflight;

  const capture = (async () => {
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
      const result = await _withTimeout(work, _CDP_CAPTURE_TIMEOUT_MS, 'CAPTURE');
      _screenshotCache.set(target.id, { ...result, ts: Date.now() });
      return result;
    } finally {
      try { await client?.close(); } catch {}
    }
  })();

  _inflightCaptures.set(target.id, capture);
  try {
    return await capture;
  } finally {
    _inflightCaptures.delete(target.id);
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
