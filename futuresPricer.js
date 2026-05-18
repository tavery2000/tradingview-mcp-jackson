/**
 * futuresPricer.js — TradingView CDP futures price poller
 *
 * 2026-05-18 morning: switched data source Webull MCP → TV CDP watchlist
 * after Webull paper account lacked US_FUTURES quote entitlement.
 *
 * 2026-05-18 mid-RTH: stripped fail-counter/stale-flag layer (was causing
 * persistent disk-stale corruption); each tick stands alone.
 *
 * 2026-05-18 ~13:40 ET: added STALE DATA detection on top of the
 * stateless model. The CDP path doesn't throw when TV's subscription
 * silently pauses on the polled tab — DOM stays valid, prices freeze.
 * We watch for N consecutive identical values per instrument and force
 * a TV-tab re-probe on detection. K consecutive stale cycles → DEGRADED
 * (entries blocked via isFuturesPricerDegraded()).
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isMCPDisabled, isIntegrationHalted } from './webull-mcp-client.js';
import { getFuturesWatchlistPrices, disconnectTvPriceClient, nudgeWatchlist } from './tvPriceClient.js';
import { jAlert, journal } from './journal.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const PRICE_FILE = join(__dirname, 'latest-prices.json');
const POLL_MS    = parseInt(process.env.FUT_PRICER_POLL_MS || '3000', 10);
const INSTRUMENTS = (process.env.FUT_PRICER_SYMBOLS || 'ES1!,NQ1!,MES1!,MNQ1!')
  .split(',').map(s => s.trim()).filter(Boolean);
const INITIAL_DELAY_MS = parseInt(process.env.FUT_PRICER_INITIAL_DELAY_MS || '500', 10);
const KEEPALIVE_INTERVAL_S = parseInt(process.env.TV_KEEPALIVE_INTERVAL_S || '30', 10);

// Stale detection parameters — three-tier session bands (2026-05-18 evening).
// Refined from earlier binary RTH/overnight (commit e82a9d1) after operator
// confirmed 18:00 ET → 07:00 ET is structurally thin (Asia + early Europe),
// 07:00-09:30 + 16:00-18:00 are moderately active flanks, 09:30-16:00 is
// full-volume RTH. CME-closed windows (Mon-Thu 17:00-18:00, Fri 17:00 →
// Sun 18:00) are suspended entirely via isCMESessionOpen() (commit 53c5fb9).
const STALE_TICK_COUNT_RTH         = parseInt(process.env.FUT_PRICER_STALE_TICK_COUNT_RTH       || '5',  10);
const STALE_TICK_COUNT_FLANKS      = parseInt(process.env.FUT_PRICER_STALE_TICK_COUNT_FLANKS    || '7',  10);
const STALE_TICK_COUNT_OVERNIGHT   = parseInt(process.env.FUT_PRICER_STALE_TICK_COUNT_OVERNIGHT || '15', 10);
const DEGRADED_AFTER_CYCLES_RTH    = parseInt(process.env.FUT_PRICER_DEGRADED_AFTER_CYCLES_RTH       || '3', 10);
const DEGRADED_AFTER_CYCLES_FLANKS = parseInt(process.env.FUT_PRICER_DEGRADED_AFTER_CYCLES_FLANKS    || '4', 10);
const DEGRADED_AFTER_CYCLES_OVERNT = parseInt(process.env.FUT_PRICER_DEGRADED_AFTER_CYCLES_OVERNIGHT || '8', 10);
const STALE_HISTORY_SIZE = Math.max(
  parseInt(process.env.FUT_PRICER_STALE_HISTORY_SIZE || '15', 10),
  STALE_TICK_COUNT_RTH,
  STALE_TICK_COUNT_FLANKS,
  STALE_TICK_COUNT_OVERNIGHT,
);

// Session bands (ET):
//   RTH       — Mon-Fri 09:30-16:00          (full-volume tape)
//   FLANKS    — Mon-Fri 07:00-09:30 + 16:00-18:00  (pre/post moderate)
//   OVERNIGHT — Mon-Fri 18:00 → 07:00 + Sunday 18:00+ (Asia + Europe thin)
// Sat/Sun-pre-18:00 + CME maintenance: caller suspends via isCMESessionOpen.
function _currentSessionBand() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const dow = m.weekday;
  const totalMin = parseInt(m.hour, 10) * 60 + parseInt(m.minute, 10);
  if (dow === 'Sat') return 'OVERNIGHT';            // (closed anyway; safe default if asked)
  if (dow === 'Sun') return 'OVERNIGHT';            // Sun 18:00+ reopen = thin
  // Mon-Fri:
  if (totalMin >= 9 * 60 + 30 && totalMin < 16 * 60) return 'RTH';
  if (totalMin >= 7 * 60      && totalMin < 9 * 60 + 30) return 'FLANKS';
  if (totalMin >= 16 * 60     && totalMin < 18 * 60) return 'FLANKS';
  return 'OVERNIGHT';                               // 00:00-07:00, 18:00-23:59
}
function _currentStaleTickCount() {
  switch (_currentSessionBand()) {
    case 'RTH':    return STALE_TICK_COUNT_RTH;
    case 'FLANKS': return STALE_TICK_COUNT_FLANKS;
    default:       return STALE_TICK_COUNT_OVERNIGHT;
  }
}
function _currentDegradedAfterCycles() {
  switch (_currentSessionBand()) {
    case 'RTH':    return DEGRADED_AFTER_CYCLES_RTH;
    case 'FLANKS': return DEGRADED_AFTER_CYCLES_FLANKS;
    default:       return DEGRADED_AFTER_CYCLES_OVERNT;
  }
}

let _started = false;
let _timer   = null;
let _keepaliveTimer = null;

// Per-instrument tick history: instrument → [{last, ts}] (ring of STALE_HISTORY_SIZE)
const _tickHistory = new Map();
// Number of CONSECUTIVE ticks that detected stale-anywhere. Resets to 0 on a clean tick.
let _staleCyclesCount = 0;
let _degraded = false;
let _degradedAt = 0;
let _degradedLoggedOnce = false;
// Session-state cache for transition logging (null on first tick).
let _lastSessionOpen = null;

function _etTimeString() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
}

// 2026-05-18 — CME futures session schedule (ET):
//   Sun 18:00 → Fri 17:00 OPEN (with daily Mon-Thu 17:00-18:00 maintenance)
//   Fri 17:00 → Sun 18:00 weekend CLOSED
// Stale-detection is suspended during closed periods — prices legitimately
// don't move when the session is paused, and treating that as a feed
// failure would flood logs + trip DEGRADED needlessly. Holiday calendar
// (Memorial Day, July 4, Thanksgiving, Christmas, NYE) is a separate
// future enhancement; this version handles the recurring weekly schedule.
export function isCMESessionOpen() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date());
  const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const dow      = m.weekday;                   // 'Sun' | 'Mon' | ... | 'Sat'
  const totalMin = parseInt(m.hour, 10) * 60 + parseInt(m.minute, 10);
  if (dow === 'Sat') return false;
  if (dow === 'Sun') return totalMin >= 18 * 60;                    // reopens at 18:00 ET
  if (dow === 'Fri') return totalMin < 17 * 60;                     // closes at 17:00 ET
  // Mon-Thu: closed during 17:00-18:00 ET daily maintenance, otherwise open
  if (totalMin >= 17 * 60 && totalMin < 18 * 60) return false;
  return true;
}

function _readCache() {
  try {
    if (!existsSync(PRICE_FILE)) return {};
    return JSON.parse(readFileSync(PRICE_FILE, 'utf8')) || {};
  } catch { return {}; }
}

function _writeCache(cache) {
  try { writeFileSync(PRICE_FILE, JSON.stringify(cache, null, 2)); }
  catch (e) { console.error(`  [FUT_PRICER] write fail: ${e.message}`); }
}

function _freshEntry(last, now, et) {
  return { last, price: last, ts: now, et, src: 'tv-watchlist' };
}

// Push the tick into per-instrument history and return whether the last
// N entries are all identical. N is TF-adaptive (RTH 5, overnight 10).
function _pushAndCheckStale(sym, last, now) {
  const h = _tickHistory.get(sym) || [];
  h.push({ last, ts: now });
  if (h.length > STALE_HISTORY_SIZE) h.shift();
  _tickHistory.set(sym, h);
  const tickCount = _currentStaleTickCount();
  if (h.length < tickCount) return null;
  const lastN = h.slice(-tickCount);
  const v = lastN[0].last;
  const allSame = lastN.every(t => t.last === v);
  if (!allSame) return null;
  const durationS = Math.round((lastN[lastN.length - 1].ts - lastN[0].ts) / 1000);
  return { value: v, ticks: tickCount, durationS };
}

export function isFuturesPricerDegraded() { return _degraded; }
export function getFuturesPricerHealth() {
  const tickCounts = {};
  for (const [sym, h] of _tickHistory.entries()) tickCounts[sym] = h.length;
  return {
    degraded: _degraded,
    degradedAt: _degradedAt ? new Date(_degradedAt).toISOString() : null,
    staleCyclesCount: _staleCyclesCount,
    degradedThreshold: DEGRADED_AFTER_CYCLES,
    tickHistorySize: tickCounts,
    staleTickWindow: STALE_TICK_COUNT,
  };
}

export async function tickOnce() {
  if (isMCPDisabled() || isIntegrationHalted()) {
    return { skipped: true, reason: 'MCP_DISABLED_OR_INTEGRATION_HALT' };
  }
  const t0 = Date.now();
  let prices = null;
  let error = null;
  try {
    prices = await getFuturesWatchlistPrices();
  } catch (e) {
    error = (e.message || 'unknown').slice(0, 120);
  }
  const dur = Date.now() - t0;
  const et  = _etTimeString();

  if (error) {
    console.log(`  [FUT_PRICER] ${et}  ✗ ${error}  (${dur}ms)`);
    return { ok: false, error, durationMs: dur, et };
  }

  const cache = _readCache();
  const hits = [];
  const misses = [];
  const staleNow = [];
  for (const sym of INSTRUMENTS) {
    const last = prices?.[sym];
    if (Number.isFinite(last)) {
      cache[sym] = _freshEntry(last, t0, et);
      hits.push(`${sym}=${last}`);
      const stale = _pushAndCheckStale(sym, last, t0);
      if (stale) staleNow.push({ sym, ...stale });
    } else {
      misses.push(sym);
    }
  }
  _writeCache(cache);
  console.log(`  [FUT_PRICER] ${et}  ✓ ${hits.length}/${INSTRUMENTS.length}  ${hits.join(' ')}${misses.length ? '  miss:' + misses.join(',') : ''}  (${dur}ms)`);

  // Session-awareness: suspend stale-detect during CME closed periods so
  // legitimate price-pause (maintenance hour / weekend) doesn't flood
  // logs or trip DEGRADED state. Log once on each transition.
  const sessionOpen = isCMESessionOpen();
  if (sessionOpen !== _lastSessionOpen) {
    if (sessionOpen) {
      console.log(`  [FUT_PRICER] SESSION_OPEN — CME live, stale-detect resumed`);
    } else {
      console.log(`  [FUT_PRICER] OUT_OF_SESSION — CME closed (Mon-Thu 17:00-18:00 ET daily maintenance / Fri 17:00 → Sun 18:00 ET weekend) — stale-detect suspended`);
    }
    _lastSessionOpen = sessionOpen;
  }
  if (!sessionOpen) {
    // Reset the cycle counter so reopen starts fresh. Tick history keeps
    // accumulating per _pushAndCheckStale, but we ignore the result.
    _staleCyclesCount = 0;
    return { ok: true, hits: hits.length, misses, durationMs: dur, et, prices, sessionOpen: false };
  }

  // ── Stale-data detection ──────────────────────────────────────────────
  // Stale = N consecutive identical values for at least one instrument.
  // Recovery: drop the cached TV target so the next tick re-probes all
  // chart tabs — if TV's data stream paused on the previously-selected
  // tab, another tab may have fresh ticks.
  if (staleNow.length > 0) {
    _staleCyclesCount++;
    const summary = staleNow.map(s => `${s.sym}=${s.value} (${s.ticks} ticks, ${s.durationS}s)`).join(', ');
    console.log(`  ⚠ FUT_PRICER STALE DATA — ${summary} — TV subscription likely paused on cached tab; forcing re-probe`);
    try {
      journal({
        type:           'ALERT',
        level:          'warning',
        message:        'futures_pricer.stale_detected',
        instruments:    staleNow.map(s => s.sym),
        frozenValues:   Object.fromEntries(staleNow.map(s => [s.sym, s.value])),
        durationS:      Math.max(...staleNow.map(s => s.durationS)),
        recoveryAction: 'tv-target-disconnect',
        cycle:          _staleCyclesCount,
        et,
      });
    } catch {}
    // Recovery — drop cached TV CDP target; next tickOnce() re-probes.
    try { await disconnectTvPriceClient(); }
    catch (e) { console.error(`  [FUT_PRICER] disconnectTvPriceClient error: ${e.message}`); }

    if (_staleCyclesCount >= _currentDegradedAfterCycles() && !_degraded) {
      _degraded = true;
      _degradedAt = t0;
      _degradedLoggedOnce = false;
      console.log(`  ⛔ FUT_PRICER DEGRADED — ${_staleCyclesCount} consecutive stale cycles; new futures entries blocked until feed recovers`);
      try {
        jAlert('critical', 'futures_pricer.degraded', {
          staleCycles: _staleCyclesCount,
          threshold:   _currentDegradedAfterCycles(),
          band:        _currentSessionBand(),
          frozenInstruments: staleNow.map(s => s.sym),
          et,
        });
      } catch {}
    }
  } else {
    // Clean tick — clear the stale-cycle counter and exit degraded mode.
    if (_staleCyclesCount > 0 || _degraded) {
      if (_degraded) {
        console.log(`  ✓ FUT_PRICER RECOVERED — feed fresh after ${_staleCyclesCount} stale cycles; entries unblocked`);
        try {
          jAlert('info', 'futures_pricer.recovered', {
            staleCyclesBefore: _staleCyclesCount,
            degradedDurationS: _degradedAt ? Math.round((t0 - _degradedAt) / 1000) : null,
            et,
          });
        } catch {}
      }
      _staleCyclesCount = 0;
      _degraded = false;
      _degradedAt = 0;
      _degradedLoggedOnce = false;
    }
  }

  return { ok: true, hits: hits.length, misses, durationMs: dur, et, prices, staleDetected: staleNow.length > 0, degraded: _degraded };
}

export function startFuturesPricer() {
  if (_started) return;
  _started = true;
  console.log(`  [FUT_PRICER] starting — ${INSTRUMENTS.join(', ')} every ${POLL_MS}ms via TV CDP watchlist`);
  const _blocks = (process.env.STALE_DETECT_BLOCKS_ENTRIES || 'false').toLowerCase() === 'true';
  const _pollS  = POLL_MS / 1000;
  console.log(`  [FUT_PRICER] stale-detect: tiered windows`);
  console.log(`  [FUT_PRICER]   RTH (Mon-Fri 09:30-16:00):           ${STALE_TICK_COUNT_RTH} ticks/${(STALE_TICK_COUNT_RTH * _pollS).toFixed(0)}s · DEGRADED@${DEGRADED_AFTER_CYCLES_RTH}`);
  console.log(`  [FUT_PRICER]   FLANKS (Mon-Fri 07-09:30, 16-18):    ${STALE_TICK_COUNT_FLANKS} ticks/${(STALE_TICK_COUNT_FLANKS * _pollS).toFixed(0)}s · DEGRADED@${DEGRADED_AFTER_CYCLES_FLANKS}`);
  console.log(`  [FUT_PRICER]   OVERNIGHT (18:00→07:00 + Sun reopen): ${STALE_TICK_COUNT_OVERNIGHT} ticks/${(STALE_TICK_COUNT_OVERNIGHT * _pollS).toFixed(0)}s · DEGRADED@${DEGRADED_AFTER_CYCLES_OVERNT}`);
  console.log(`  [FUT_PRICER] stale state: ${_blocks ? 'BLOCKS ENTRIES (DEGRADED → veto)' : 'ALERT-ONLY (entries proceed with last-known price)'}`);
  console.log(`  [FUT_PRICER] session-aware: stale-detect suspended during CME closed periods (Mon-Thu 17:00-18:00 ET, Fri 17:00 → Sun 18:00 ET)`);
  setTimeout(() => {
    tickOnce().catch(e => console.error(`  [FUT_PRICER] initial tick uncaught: ${e.message}`));
  }, INITIAL_DELAY_MS);
  _timer = setInterval(() => {
    tickOnce().catch(e => console.error(`  [FUT_PRICER] tick uncaught: ${e.message}`));
  }, POLL_MS);

  // 2026-05-18 — TV watchlist keepalive. Oscillates scrollTop ±1px every
  // KEEPALIVE_INTERVAL_S to force TV's renderer to re-paint fresh prices.
  // Operator verified manually that a scroll breaks the watchlist DOM
  // cache when the panel sits unfocused. Primary defense; the
  // stale-detection ladder remains as the safety net.
  if (KEEPALIVE_INTERVAL_S > 0) {
    console.log(`  [FUT_PRICER] keepalive: nudging TV watchlist every ${KEEPALIVE_INTERVAL_S}s (scrollTop ±1px) to prevent renderer cache stall`);
    _keepaliveTimer = setInterval(async () => {
      if (isMCPDisabled() || isIntegrationHalted()) return;
      try {
        const r = await nudgeWatchlist();
        if (r.ok) {
          console.log(`  [tvPriceClient] keepalive nudge sent (scrollTop=${r.scrollTop})`);
        } else if (r.reason !== 'panel_closed') {
          // panel_closed already shows up loudly via the stale-detection
          // recovery path; don't double-log.
          console.log(`  [tvPriceClient] keepalive skipped — ${r.reason || r.error}`);
        }
      } catch (e) {
        console.error(`  [tvPriceClient] keepalive error: ${e.message}`);
      }
    }, KEEPALIVE_INTERVAL_S * 1000);
    if (_keepaliveTimer.unref) _keepaliveTimer.unref();
  }
}

export function stopFuturesPricer() {
  if (_timer) clearInterval(_timer);
  if (_keepaliveTimer) clearInterval(_keepaliveTimer);
  _timer = null;
  _keepaliveTimer = null;
  _started = false;
}
