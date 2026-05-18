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
import { getFuturesWatchlistPrices, disconnectTvPriceClient } from './tvPriceClient.js';
import { jAlert, journal } from './journal.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const PRICE_FILE = join(__dirname, 'latest-prices.json');
const POLL_MS    = parseInt(process.env.FUT_PRICER_POLL_MS || '3000', 10);
const INSTRUMENTS = (process.env.FUT_PRICER_SYMBOLS || 'ES1!,NQ1!,MES1!,MNQ1!')
  .split(',').map(s => s.trim()).filter(Boolean);
const INITIAL_DELAY_MS = parseInt(process.env.FUT_PRICER_INITIAL_DELAY_MS || '500', 10);

// Stale detection parameters (env-tunable for operator runtime experimentation)
const STALE_TICK_COUNT      = parseInt(process.env.FUT_PRICER_STALE_TICK_COUNT      || '5',  10);
const STALE_HISTORY_SIZE    = parseInt(process.env.FUT_PRICER_STALE_HISTORY_SIZE    || '10', 10);
const DEGRADED_AFTER_CYCLES = parseInt(process.env.FUT_PRICER_DEGRADED_AFTER_CYCLES || '3',  10);

let _started = false;
let _timer   = null;

// Per-instrument tick history: instrument → [{last, ts}] (ring of STALE_HISTORY_SIZE)
const _tickHistory = new Map();
// Number of CONSECUTIVE ticks that detected stale-anywhere. Resets to 0 on a clean tick.
let _staleCyclesCount = 0;
let _degraded = false;
let _degradedAt = 0;
let _degradedLoggedOnce = false;

function _etTimeString() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
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
// STALE_TICK_COUNT entries are all identical.
function _pushAndCheckStale(sym, last, now) {
  const h = _tickHistory.get(sym) || [];
  h.push({ last, ts: now });
  if (h.length > STALE_HISTORY_SIZE) h.shift();
  _tickHistory.set(sym, h);
  if (h.length < STALE_TICK_COUNT) return null;
  const lastN = h.slice(-STALE_TICK_COUNT);
  const v = lastN[0].last;
  const allSame = lastN.every(t => t.last === v);
  if (!allSame) return null;
  const durationS = Math.round((lastN[lastN.length - 1].ts - lastN[0].ts) / 1000);
  return { value: v, ticks: STALE_TICK_COUNT, durationS };
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

    if (_staleCyclesCount >= DEGRADED_AFTER_CYCLES && !_degraded) {
      _degraded = true;
      _degradedAt = t0;
      _degradedLoggedOnce = false;
      console.log(`  ⛔ FUT_PRICER DEGRADED — ${_staleCyclesCount} consecutive stale cycles; new futures entries blocked until feed recovers`);
      try {
        jAlert('critical', 'futures_pricer.degraded', {
          staleCycles: _staleCyclesCount,
          threshold:   DEGRADED_AFTER_CYCLES,
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
  console.log(`  [FUT_PRICER] stale-detect: ${STALE_TICK_COUNT} identical ticks → re-probe; ${DEGRADED_AFTER_CYCLES} cycles → DEGRADED (entries blocked)`);
  setTimeout(() => {
    tickOnce().catch(e => console.error(`  [FUT_PRICER] initial tick uncaught: ${e.message}`));
  }, INITIAL_DELAY_MS);
  _timer = setInterval(() => {
    tickOnce().catch(e => console.error(`  [FUT_PRICER] tick uncaught: ${e.message}`));
  }, POLL_MS);
}

export function stopFuturesPricer() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _started = false;
}
