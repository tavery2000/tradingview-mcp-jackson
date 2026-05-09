/**
 * bars.js — Multi-timeframe bar cache for HANK monitors.
 *
 * Each monitor (monitor.js / monitor-qqq.js / monitor-iwm.js) owns its
 * own CDP connection; this factory creates a per-monitor cache that uses
 * the host's evalOn() to talk to TradingView Desktop.
 *
 * Resolutions:
 *   '30S'  — native pull, no flip. Used by existing tick-level reads.
 *   '5'    — aggregated from 30S buffer in JS. Cheap.
 *   '60'   — setResolution('60') flip + fetch + restore. Cached 5 min.
 *   '240'  — setResolution('240') flip + fetch + restore. Cached 30 min.
 *
 * Why aggregate 5M from 30S instead of flipping?
 *   The 5M cache TTL is short (matches the 30s poll cadence). Flipping
 *   the chart on every poll would visibly flicker for users. Aggregation
 *   from the existing 30S native pull avoids that. 1H and 4H flip once
 *   per cache window, so they're tolerable.
 *
 * Bootstrap behavior:
 *   On startup, prime cache with one fetch per resolution. If the 4H or
 *   1H bootstrap fails (e.g., TV chart not yet loaded enough history),
 *   the monitor surfaces the error to the journal and the next signal
 *   evaluation will see null bars and refuse to trade.
 *
 * Caller contract:
 *   - get(instrument, resolution) returns Promise<Array<bar>|null>
 *   - null = fetch failed → caller MUST refuse to trade on this signal
 *   - Bar shape: { time, open, high, low, close, volume, incomplete? }
 *   - Last bar may have incomplete:true when it's the in-progress candle.
 *     Strategy engines should ignore the incomplete bar for triggers,
 *     use it only for intra-bar watchers.
 */

import { jError, jAlert } from './journal.js';

// ─── Resolution config ────────────────────────────────
// secondsPerBar — used for aggregation grouping
// ttlMs        — cache freshness window
// flipFetch    — true when we need to setResolution to fetch this TF
const RES = {
  '30S': { secondsPerBar:    30,  ttlMs:        0, flipFetch: false },
  '5':   { secondsPerBar:   300,  ttlMs:    5_000, flipFetch: false },
  '60':  { secondsPerBar:  3600,  ttlMs:  5*60_000, flipFetch: true  },
  '240': { secondsPerBar: 14_400, ttlMs: 30*60_000, flipFetch: true  },
};

// Bootstrap counts — how many bars to pull on first fetch.
// 30S 600 = 5 hours; 5M aggregation only needs 500 30S bars for 50 5M bars.
const BOOTSTRAP_COUNTS = {
  '30S': 600,
  '5':   60,
  '60':  60,    // need >= 50 for ema50 on 1H
  '240': 30,    // need >= 21 for ema21 on 4H
};

// Time spent waiting for TV chart to load bars after a setResolution flip.
// Empirical — TradingView's data feed completes async; ~1.2-1.5s is reliable.
const FLIP_LOAD_DELAY_MS = 1500;

// ─── JS payloads (run inside TradingView Desktop's renderer) ───
const JS_GET_BARS = (count) => `
(function(){
  try {
    var bars = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
    if (!bars || typeof bars.lastIndex !== 'function') return null;
    var out = [];
    var end   = bars.lastIndex();
    var start = Math.max(bars.firstIndex(), end - ${count} + 1);
    for (var i = start; i <= end; i++) {
      var v = bars.valueAt(i);
      if (v) out.push({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0 });
    }
    return out;
  } catch(e) { return { error: e.message }; }
})()`;

const JS_GET_RESOLUTION = `
(function(){
  try { return window.TradingViewApi._activeChartWidgetWV.value().resolution(); }
  catch(e) { return null; }
})()`;

const JS_SET_RESOLUTION = (res) => `
(function(){
  try { window.TradingViewApi._activeChartWidgetWV.value().setResolution('${res}'); return true; }
  catch(e) { return false; }
})()`;

// ─── Aggregation ──────────────────────────────────────
// Group fine-grained bars into target-resolution buckets aligned to UTC.
// TradingView times come back as either seconds (typical) or ms; normalize.
function aggregate(srcBars, tgtSec) {
  if (!srcBars || !srcBars.length) return [];
  const bucketSec = tgtSec;
  const groups    = new Map();

  for (const b of srcBars) {
    const tSec = b.time < 1e12 ? b.time : Math.floor(b.time / 1000);
    const key  = Math.floor(tSec / bucketSec) * bucketSec;
    const g    = groups.get(key);
    if (!g) {
      groups.set(key, { time: key, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    } else {
      g.high   = Math.max(g.high, b.high);
      g.low    = Math.min(g.low,  b.low);
      g.close  = b.close;
      g.volume += b.volume;
    }
  }

  const arr = [...groups.values()].sort((a, b) => a.time - b.time);

  // Mark last bucket as incomplete if its window hasn't closed yet
  if (arr.length) {
    const last = arr[arr.length - 1];
    if ((last.time + bucketSec) > Math.floor(Date.now() / 1000)) {
      last.incomplete = true;
    }
  }
  return arr;
}

// ─── Factory ──────────────────────────────────────────
export function createBarCache({ evalOn, instrumentLabel }) {
  if (typeof evalOn !== 'function') throw new Error('createBarCache requires evalOn');
  const inst = instrumentLabel || 'UNKNOWN';

  // cache shape: { resolution: { bars, fetchedAt } }
  const cache    = {};
  const inflight = new Map();
  let lastBootstrapAt = 0;

  // Native pull at chart's current displayed resolution
  async function fetchNative(count) {
    const res = await evalOn(JS_GET_BARS(count));
    if (!res) return null;
    if (res && res.error) {
      jError('bars-native', res.error, { instrument: inst, count });
      return null;
    }
    if (!Array.isArray(res) || !res.length) return null;
    return res;
  }

  // Resolution-flip pull. Returns to original resolution before resolving.
  async function fetchWithFlip(targetRes, count) {
    const original = await evalOn(JS_GET_RESOLUTION);
    let bars = null;

    try {
      const setOK = await evalOn(JS_SET_RESOLUTION(targetRes));
      if (setOK !== true) {
        jError('bars-flip-set', `setResolution(${targetRes}) returned ${setOK}`, { instrument: inst });
        return null;
      }
      // Wait for the chart's data feed to populate at the new resolution
      await new Promise(r => setTimeout(r, FLIP_LOAD_DELAY_MS));
      const result = await evalOn(JS_GET_BARS(count));
      if (Array.isArray(result) && result.length) bars = result;
      else if (result && result.error) jError('bars-flip-fetch', result.error, { instrument: inst, targetRes });
    } catch (e) {
      jError('bars-flip-exception', e.message, { instrument: inst, targetRes });
    } finally {
      // Always restore — even if fetch failed, never leave the chart stranded
      if (original) {
        try { await evalOn(JS_SET_RESOLUTION(original)); } catch {}
      }
    }
    return bars;
  }

  // Public: get bars for a resolution, using cache if fresh.
  // Returns null on failure — caller MUST refuse to trade.
  async function get(resolution) {
    const cfg = RES[resolution];
    if (!cfg) throw new Error(`bars.get: unknown resolution ${resolution}`);

    const c = cache[resolution];
    if (c && Date.now() - c.fetchedAt < cfg.ttlMs) return c.bars;

    // Dedup concurrent calls for the same TF
    const key = resolution;
    if (inflight.has(key)) return inflight.get(key);

    const promise = (async () => {
      try {
        let bars = null;

        if (resolution === '30S') {
          bars = await fetchNative(BOOTSTRAP_COUNTS['30S']);
        } else if (resolution === '5') {
          // Aggregate from the existing 30S buffer
          const src = await get('30S');
          if (!src || !src.length) {
            jError('bars-aggregate', '30S source unavailable for 5M aggregation', { instrument: inst });
            return null;
          }
          bars = aggregate(src, RES['5'].secondsPerBar);
          // Verify we got enough closed bars
          const closed = bars.filter(b => !b.incomplete);
          if (closed.length < 10) {
            jAlert('warn', `5M cache thin (${closed.length} closed bars)`, { instrument: inst });
          }
        } else if (resolution === '60' || resolution === '240') {
          bars = await fetchWithFlip(resolution, BOOTSTRAP_COUNTS[resolution]);
        }

        if (!bars) {
          // Don't cache failures — next call will retry
          return null;
        }
        cache[resolution] = { bars, fetchedAt: Date.now() };
        return bars;
      } finally {
        inflight.delete(key);
      }
    })();

    inflight.set(key, promise);
    return promise;
  }

  // Bootstrap — prime cache with one fetch per resolution.
  // Returns { ok, missing[] } so the monitor can decide whether to start.
  async function bootstrap() {
    const missing = [];
    for (const res of ['30S', '5', '60', '240']) {
      const bars = await get(res);
      const closed = (bars || []).filter(b => !b.incomplete);
      const need = res === '240' ? 5 : res === '60' ? 8 : res === '5' ? 10 : 30;
      if (!bars || closed.length < need) {
        missing.push(res);
        jError('bars-bootstrap', `${res}: ${closed.length} closed bars (need ${need})`, { instrument: inst });
      }
    }
    lastBootstrapAt = Date.now();
    return { ok: missing.length === 0, missing };
  }

  // Inspect cache without triggering refetch — used by status/diagnostics
  function getCacheStatus() {
    const out = {};
    for (const res of Object.keys(RES)) {
      const c = cache[res];
      out[res] = c
        ? { bars: c.bars.length, fetchedAt: c.fetchedAt, ageSec: Math.round((Date.now() - c.fetchedAt) / 1000) }
        : null;
    }
    return out;
  }

  return { get, bootstrap, getCacheStatus, aggregate };
}

// ─── Pure aggregation export — useful for tests + cross-monitor reuse ──
export { aggregate };
