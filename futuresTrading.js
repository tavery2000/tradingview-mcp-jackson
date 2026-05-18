/**
 * futuresTrading.js — Path 2 futures-direct paper dispatch
 *
 * Operator directive (2026-05-15 EOD compress): in-HANK paper-direct
 * futures dispatch with point-based stops, scale-out, and trailing —
 * no Webull broker dependency. Today's connectivity check confirmed
 * Webull OpenAPI futures endpoints return 404 for our app scope; this
 * module operates entirely against futures-ledger.json + latest-prices.json
 * (P0-1 cache populated by webhook-server.js on every Pine alert).
 *
 * Locked decisions (operator-confirmed in
 * docs/mes-futures-direct-path2-scope.md §0):
 *   1. CALLS/PUTS preserved end-to-end (not LONG/SHORT)
 *   2. FUTURES_TRADING_MODE separate from options TRADING_MODE
 *   3. v1 = MES1! ONLY; ES1!/NQ1!/MNQ1! gated by graduation watcher
 *      (account balance > $2,500 triggers operator-explicit unlock)
 *   4. Concurrent positions: UNLIMITED (per RULE 1)
 *   5. Stacking rule AGGRESSIVE — B→A on 1 same-direction signal in 60s
 *   6. Trailing stops at v1 launch (Tier A: BE @ +3pt, +50%-target @ +5pt)
 *
 * Public API:
 *   placeFuturesOrder(consensus, requestId)  — entry + journal + ledger
 *   closeFuturesPosition(requestId, exitPrice, exitReason)
 *   evaluateOpenFutures()                    — periodic stop/target/trail
 *                                              check (called from internal
 *                                              setInterval, also exposed
 *                                              for webhook test harness)
 *   getFuturesLedger()                       — read-only accessor
 *   futuresOrderGate                         — request dedup (matches
 *                                              paperTrading.orderGate shape)
 *
 * Internal poll: setInterval reads latest-prices.json every 1.5s and
 * fires stop/target/trail checks against open positions. Single-process,
 * single-ledger, single-source-of-truth — much cleaner than the options
 * dispatch's webhook+monitor+evaluator multi-process choreography.
 */

import { readFileSync, writeFileSync, existsSync, openSync, unlinkSync, closeSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { jFutEntry, jFutExit, jError, jAlert, jGateBlock } from './journal.js';
import { evaluate as profitProtectionEvaluate } from './profitProtection.js';
import { isTradingPaused } from './preSwitchKill.js';
// 2026-05-18 13:40 ET: futuresPricer DEGRADED state gates new entries.
// Lazy-loaded so a circular import surface doesn't bite during startup
// (futuresPricer is otherwise dynamically imported by webhook-server).
let _isFuturesPricerDegraded = () => false;
import('./futuresPricer.js').then(m => {
  if (typeof m.isFuturesPricerDegraded === 'function') _isFuturesPricerDegraded = m.isFuturesPricerDegraded;
}).catch(() => { /* pricer not present in test contexts — leave shim */ });

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEDGER_FILE  = join(__dirname, 'futures-ledger.json');
const LOCK_FILE    = join(__dirname, '.futures-ledger.lock');
const PRICES_FILE  = join(__dirname, 'latest-prices.json');
const TARGET_STATE = join(__dirname, 'futures-daily-target-state.json');
const CIRCUIT_BREAKER_FILE = join(__dirname, 'circuit-breaker-state.json');

// ─── Config (per locked decisions + operator's daily envelope) ─────────

const FUTURES_TRADING_MODE = (process.env.FUTURES_TRADING_MODE || 'PAPER').toUpperCase();
const FUT_STARTING_BALANCE = parseFloat(process.env.FUT_STARTING_BALANCE || '1000');
const FUT_GRADUATION_THRESHOLD = parseFloat(process.env.FUT_GRADUATION_THRESHOLD || '2500');

// Tier sizing per docs/mes-1k-300-daily-plan.md
const TIER = {
  A: {
    contracts: parseInt(process.env.FUT_TIER_A_CONTRACTS || '5', 10),
    stopPoints: parseFloat(process.env.FUT_TIER_A_STOP_POINTS || '3'),
    targetPoints: parseFloat(process.env.FUT_TIER_A_TARGET_POINTS || '6'),
    trailBE: parseFloat(process.env.FUT_TIER_A_TRAIL_BE_POINTS || '3'),
    trailLockTrigger: parseFloat(process.env.FUT_TIER_A_TRAIL_LOCK_POINTS || '5'),
    trailLockTargetPct: parseFloat(process.env.FUT_TIER_A_TRAIL_LOCK_TARGET_PCT || '50'),
  },
  B: {
    contracts: parseInt(process.env.FUT_TIER_B_CONTRACTS || '3', 10),
    stopPoints: parseFloat(process.env.FUT_TIER_B_STOP_POINTS || '3'),
    targetPoints: parseFloat(process.env.FUT_TIER_B_TARGET_POINTS || '5'),
    trailBE: parseFloat(process.env.FUT_TIER_B_TRAIL_BE_POINTS || '2'),
  },
  C: {
    contracts: parseInt(process.env.FUT_TIER_C_CONTRACTS || '1', 10),
    stopPoints: parseFloat(process.env.FUT_TIER_C_STOP_POINTS || '2'),
    targetPoints: parseFloat(process.env.FUT_TIER_C_TARGET_POINTS || '3'),
  },
};
const STACKING_WINDOW_MS = parseInt(process.env.FUT_STACKING_WINDOW_MS || '60000', 10);

// Daily envelope
const DAILY_TARGET           = parseFloat(process.env.FUT_DAILY_TARGET || '300');
const MAX_DAILY_LOSS         = parseFloat(process.env.FUT_MAX_DAILY_LOSS || '150');
const MAX_TRADES_PER_DAY     = parseInt(process.env.FUT_MAX_TRADES_PER_DAY || '10', 10);
const MAX_CONSECUTIVE_LOSSES = parseInt(process.env.FUT_MAX_CONSECUTIVE_LOSSES || '3', 10);
const COOLDOWN_MS            = parseInt(process.env.FUT_COOLDOWN_MS || '3600000', 10);
const FRIDAY_LOSS_CAP        = parseFloat(process.env.FUT_FRIDAY_LOSS_CAP || '100');

// v1: MES1! only. Set FUT_INSTRUMENTS=MES1!,ES1!,NQ1!,MNQ1! after graduation.
const ALLOWED_INSTRUMENTS = new Set(
  (process.env.FUT_INSTRUMENTS || 'MES1!')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
);

// Per-instrument multipliers (CME spec — point value × $/point)
const POINT_VALUE = {
  'MES1!': 5, 'MES': 5,
  'ES1!': 50, 'ES': 50,
  'MNQ1!': 2, 'MNQ': 2,
  'NQ1!': 20, 'NQ': 20,
};

// 2026-05-18 pre-RTH (Mon 5/18 Task #0 partial): per-instrument capital
// cap. Operator policy: cap = broker minimum overnight margin + $1K buffer.
// Formula: capital used per contract = MARGIN_PER_CONTRACT (NOT notional).
// allowed_contracts = floor(cap / margin_per_contract).
//
// Defaults below: Webull overnight margin estimates as of mid-2026 + $1K.
// Operator overrides via .env per-instrument:
//   CAPITAL_CAP_ES=15000   FUT_OVERNIGHT_MARGIN_ES=14000
//   CAPITAL_CAP_NQ=23000   FUT_OVERNIGHT_MARGIN_NQ=22000
//   CAPITAL_CAP_MES=2500   FUT_OVERNIGHT_MARGIN_MES=1500
//   CAPITAL_CAP_MNQ=3200   FUT_OVERNIGHT_MARGIN_MNQ=2200
const FUT_OVERNIGHT_MARGIN = {
  'ES':    parseFloat(process.env.FUT_OVERNIGHT_MARGIN_ES  || '14000'),
  'NQ':    parseFloat(process.env.FUT_OVERNIGHT_MARGIN_NQ  || '22000'),
  'MES':   parseFloat(process.env.FUT_OVERNIGHT_MARGIN_MES || '1500'),
  'MNQ':   parseFloat(process.env.FUT_OVERNIGHT_MARGIN_MNQ || '2200'),
  'ES1!':  parseFloat(process.env.FUT_OVERNIGHT_MARGIN_ES  || '14000'),
  'NQ1!':  parseFloat(process.env.FUT_OVERNIGHT_MARGIN_NQ  || '22000'),
  'MES1!': parseFloat(process.env.FUT_OVERNIGHT_MARGIN_MES || '1500'),
  'MNQ1!': parseFloat(process.env.FUT_OVERNIGHT_MARGIN_MNQ || '2200'),
};
const FUT_CAPITAL_CAP_PER_INSTRUMENT = {
  'ES':    parseFloat(process.env.CAPITAL_CAP_ES  || '15000'),   // 14K margin + 1K
  'NQ':    parseFloat(process.env.CAPITAL_CAP_NQ  || '23000'),   // 22K margin + 1K
  'MES':   parseFloat(process.env.CAPITAL_CAP_MES || '2500'),    // 1.5K margin + 1K
  'MNQ':   parseFloat(process.env.CAPITAL_CAP_MNQ || '3200'),    // 2.2K margin + 1K
  'ES1!':  parseFloat(process.env.CAPITAL_CAP_ES  || '15000'),
  'NQ1!':  parseFloat(process.env.CAPITAL_CAP_NQ  || '23000'),
  'MES1!': parseFloat(process.env.CAPITAL_CAP_MES || '2500'),
  'MNQ1!': parseFloat(process.env.CAPITAL_CAP_MNQ || '3200'),
};
function _futCapForInstrument(inst) {
  const k = (inst || '').toUpperCase();
  return FUT_CAPITAL_CAP_PER_INSTRUMENT[k] ?? null;
}
function _futMarginForInstrument(inst) {
  const k = (inst || '').toUpperCase();
  return FUT_OVERNIGHT_MARGIN[k] ?? null;
}

// 2026-05-18 pre-RTH: MAX_LOSS_PER_TRADE gate. Risk-based per-contract
// loss = stopPoints × pointValue. Orthogonal to capital cap (notional).
// Default $200 per env. Set 0 to disable.
const FUT_MAX_LOSS_PER_TRADE = parseFloat(process.env.MAX_LOSS_PER_TRADE || '200');

// Whipsaw inheritance from P1-5-A
const WHIPSAW_PROTECTION = (process.env.WHIPSAW_PROTECTION || 'true').toLowerCase() === 'true';
// 2026-05-18 15:05 ET — default flipped 'bar_close' → 'tick' after a 5M
// catastrophic-slippage event: MES1! PUTS stop 7382 → exit 7413 (34pt
// past, -$170 × 2 trades). bar_close confirmation waited a full minute
// + used the polling-delayed liveU as exit price; fast moves blew right
// past. tick mode fires on first observed breach and uses stopPrice
// adjusted by FUT_STOP_SLIPPAGE_POINTS (simulates real broker fill
// after STOP→MARKET conversion, ~1 tick slippage).
const STOP_CONFIRMATION  = (process.env.STOP_CONFIRMATION  || 'tick').toLowerCase();
const FUT_STOP_SLIPPAGE_POINTS = parseFloat(process.env.FUT_STOP_SLIPPAGE_POINTS || '0.25');
const TRAIL_PCT          = parseFloat(process.env.TRAIL_PCT || '0.03');

// Eval poll interval
const EVAL_POLL_MS       = parseInt(process.env.FUT_EVAL_POLL_MS || '1500', 10);

// ─── Module state ──────────────────────────────────────────────────────

const _recentSignals = [];   // [{instrument, direction, ts, requestId}] — sliding 5min
const _whipsawState  = new Map();    // requestId → {currentBarMinute, currentBarBreached}
const _consecutiveLosses = { count: 0, cooldownUntil: 0 };
let _dailyTargetFiredFor = null;     // ET-date string when target fired
let _graduationFiredFor  = null;     // ET-date string when graduation alert fired
let _evalTimer = null;

// 2026-05-18: circuit breaker with 30min auto-resume + hard-halt-after-3-trips.
// Rolling 5-min window detects cascades (>= 3 closes OR cumulative loss <= -$500).
// On trip:
//   - Records trippedAt timestamp + pushes to _circuitBreakerTrips history
//   - Writes circuit-breaker-state.json
// On every subsequent entry attempt:
//   - If hard halt (>= TRIPS_BEFORE_HARD_HALT in HARD_HALT_WINDOW_MIN): reject,
//     requires explicit operator clear via REPL
//   - Else if cooldown elapsed (now - trippedAt >= COOLDOWN_MIN): auto-clear,
//     log resume, allow entry
//   - Else: reject with remaining cooldown minutes in the reason
// Pattern matches profit-protection LIGHT/MEDIUM breach (30/60min halts).
const CB_WINDOW_MS                = 5 * 60_000;
const CB_MAX_CLOSES               = parseInt(process.env.CIRCUIT_BREAKER_MAX_CLOSES || '3', 10);
const CB_MAX_CUM_LOSS             = parseFloat(process.env.CIRCUIT_BREAKER_MAX_CUM_LOSS || '500');   // absolute, positive
const CB_COOLDOWN_MIN             = parseInt(process.env.CIRCUIT_BREAKER_COOLDOWN_MIN || '30', 10);
const CB_TRIPS_BEFORE_HARD_HALT   = parseInt(process.env.CIRCUIT_BREAKER_TRIPS_BEFORE_HARD_HALT || '3', 10);
const CB_HARD_HALT_WINDOW_MIN     = parseInt(process.env.CIRCUIT_BREAKER_HARD_HALT_WINDOW_MIN || '120', 10);
let _circuitBreakerTripped   = false;
let _circuitBreakerReason    = null;
let _circuitBreakerTrippedAt = 0;
let _circuitBreakerHardHalt  = false;
let _circuitBreakerTrips     = [];   // history of trip timestamps (rolling window for hard-halt detection)
const _recentCloses = [];   // [{ts, pnl}]

function _persistCircuitBreakerState() {
  try {
    writeFileSync(CIRCUIT_BREAKER_FILE, JSON.stringify({
      tripped:        _circuitBreakerTripped,
      hardHalt:       _circuitBreakerHardHalt,
      reason:         _circuitBreakerReason,
      trippedAt:      _circuitBreakerTrippedAt ? new Date(_circuitBreakerTrippedAt).toISOString() : null,
      trippedAtET:    _circuitBreakerTrippedAt ? new Date(_circuitBreakerTrippedAt).toLocaleString('en-US', { timeZone: 'America/New_York' }) : null,
      cooldownMin:    CB_COOLDOWN_MIN,
      tripsInWindow:  _circuitBreakerTrips.length,
      hardHaltThreshold: CB_TRIPS_BEFORE_HARD_HALT,
      hardHaltWindowMin: CB_HARD_HALT_WINDOW_MIN,
      tripHistoryET:  _circuitBreakerTrips.map(ts => new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York' })),
      recentCloses:   _recentCloses.map(c => ({ ts: c.ts, et: new Date(c.ts).toLocaleString('en-US', { timeZone: 'America/New_York' }), pnl: c.pnl })),
    }, null, 2));
  } catch {}
}

// On startup, restore tripped state from disk if present
try {
  if (existsSync(CIRCUIT_BREAKER_FILE)) {
    const s = JSON.parse(readFileSync(CIRCUIT_BREAKER_FILE, 'utf8'));
    if (s && s.tripped) {
      _circuitBreakerTripped   = true;
      _circuitBreakerReason    = s.reason || 'unknown (restored from state file)';
      _circuitBreakerTrippedAt = s.trippedAt ? new Date(s.trippedAt).getTime() : Date.now();
      _circuitBreakerHardHalt  = !!s.hardHalt;
      console.log(`  ⛔ CIRCUIT BREAKER restored from disk: ${_circuitBreakerReason}${_circuitBreakerHardHalt ? ' [HARD HALT]' : ''}`);
    }
  }
} catch {}

/**
 * Called on every entry attempt. Returns:
 *   { blocked: false }                       — proceed (or auto-resumed)
 *   { blocked: true, reason: '...', autoResume: false }  — cooldown active
 *   { blocked: true, reason: '...', hardHalt: true }     — requires operator clear
 */
export function circuitBreakerEntryCheck() {
  if (!_circuitBreakerTripped) return { blocked: false };
  if (_circuitBreakerHardHalt) {
    return {
      blocked: true, hardHalt: true,
      reason: `CIRCUIT_BREAKER_HARD_HALT — ${_circuitBreakerTrips.length} trips in ${CB_HARD_HALT_WINDOW_MIN}min, operator REPL clear required`,
    };
  }
  const now = Date.now();
  const cooldownMs = CB_COOLDOWN_MIN * 60_000;
  const elapsedMs  = now - _circuitBreakerTrippedAt;
  if (elapsedMs >= cooldownMs) {
    // Auto-resume
    console.log(`  [CIRCUIT_BREAKER] auto-resume after ${(elapsedMs/60000).toFixed(1)}min cooldown (>= ${CB_COOLDOWN_MIN}min)`);
    try { jAlert('info', 'CIRCUIT_BREAKER_AUTO_RESUME', { elapsedMin: parseFloat((elapsedMs/60000).toFixed(2)), cooldownMin: CB_COOLDOWN_MIN, previousReason: _circuitBreakerReason }); } catch {}
    _circuitBreakerTripped = false;
    _circuitBreakerReason  = null;
    _circuitBreakerTrippedAt = 0;
    // Keep _circuitBreakerTrips history for hard-halt detection across cycles
    _persistCircuitBreakerState();
    return { blocked: false };
  }
  const remainingMin = Math.ceil((cooldownMs - elapsedMs) / 60_000);
  return {
    blocked: true, autoResume: true, remainingMin,
    reason: `CIRCUIT_BREAKER (auto-resume in ${remainingMin}min)`,
  };
}

function _circuitBreakerCheck(closePnl) {
  if (_circuitBreakerTripped) return;   // already tripped
  const now = Date.now();
  _recentCloses.push({ ts: now, pnl: closePnl });
  // Prune entries older than window
  while (_recentCloses.length && now - _recentCloses[0].ts > CB_WINDOW_MS) {
    _recentCloses.shift();
  }
  const count   = _recentCloses.length;
  const cumPnl  = _recentCloses.reduce((s, c) => s + c.pnl, 0);
  let trip = null;
  if (count >= CB_MAX_CLOSES)          trip = `COUNT (${count} closes in ${CB_WINDOW_MS/60000}min)`;
  else if (cumPnl <= -CB_MAX_CUM_LOSS) trip = `CUMULATIVE_LOSS ($${cumPnl.toFixed(0)} in ${CB_WINDOW_MS/60000}min)`;
  if (trip) {
    _circuitBreakerTripped   = true;
    _circuitBreakerReason    = trip;
    _circuitBreakerTrippedAt = now;
    // Track trip in hard-halt rolling window
    _circuitBreakerTrips.push(now);
    const hardHaltWindowMs = CB_HARD_HALT_WINDOW_MIN * 60_000;
    _circuitBreakerTrips = _circuitBreakerTrips.filter(ts => now - ts <= hardHaltWindowMs);
    if (_circuitBreakerTrips.length >= CB_TRIPS_BEFORE_HARD_HALT) {
      _circuitBreakerHardHalt = true;
    }
    _persistCircuitBreakerState();
    try { jAlert('critical', 'CIRCUIT_BREAKER_TRIPPED', { reason: trip, closeCount: count, cumulativeLoss: cumPnl, tripsInWindow: _circuitBreakerTrips.length, hardHalt: _circuitBreakerHardHalt }); } catch {}
    if (_circuitBreakerHardHalt) {
      console.log(`\n  ⛔⛔⛔ CIRCUIT BREAKER HARD HALT — ${trip}`);
      console.log(`  ⛔ ${_circuitBreakerTrips.length} trips in ${CB_HARD_HALT_WINDOW_MIN}min — operator REPL clear required (no auto-resume)`);
    } else {
      console.log(`\n  ⛔⛔⛔ CIRCUIT BREAKER TRIPPED — ${trip}`);
      console.log(`  ⛔ Futures entries BLOCKED — auto-resume in ${CB_COOLDOWN_MIN}min OR operator REPL clear`);
    }
    if (typeof global.pushVoiceAlert === 'function') {
      try { global.pushVoiceAlert('circuit-breaker', 'critical',
        _circuitBreakerHardHalt
          ? `Circuit breaker hard halt. ${_circuitBreakerTrips.length} trips. Operator clear required.`
          : `Circuit breaker tripped. Auto resume in ${CB_COOLDOWN_MIN} minutes.`,
        0); } catch {}
    }
  }
}

export function isCircuitBreakerTripped() { return _circuitBreakerTripped; }
export function isCircuitBreakerHardHalt() { return _circuitBreakerHardHalt; }
export function getCircuitBreakerReason() { return _circuitBreakerReason; }
export function getCircuitBreakerStatus() {
  if (!_circuitBreakerTripped) return { tripped: false };
  const now = Date.now();
  const cooldownMs = CB_COOLDOWN_MIN * 60_000;
  const elapsedMs  = now - _circuitBreakerTrippedAt;
  const remainingMin = Math.max(0, Math.ceil((cooldownMs - elapsedMs) / 60_000));
  return {
    tripped: true,
    hardHalt: _circuitBreakerHardHalt,
    reason: _circuitBreakerReason,
    trippedAt: _circuitBreakerTrippedAt ? new Date(_circuitBreakerTrippedAt).toISOString() : null,
    cooldownMin: CB_COOLDOWN_MIN,
    remainingMin,
    tripsInWindow: _circuitBreakerTrips.length,
    hardHaltThreshold: CB_TRIPS_BEFORE_HARD_HALT,
  };
}
export function clearCircuitBreaker() {
  _circuitBreakerTripped   = false;
  _circuitBreakerReason    = null;
  _circuitBreakerTrippedAt = 0;
  _circuitBreakerHardHalt  = false;
  _circuitBreakerTrips.length = 0;
  _recentCloses.length     = 0;
  // 2026-05-18: persist a clean state snapshot rather than unlinking. Readers
  // (futures-status.js) see {tripped:false} immediately and the banner
  // disappears; restart-on-clear is no longer required.
  try { _persistCircuitBreakerState(); } catch {}
  try { jAlert('info', 'CIRCUIT_BREAKER_CLEARED', { clearedAt: new Date().toISOString() }); } catch {}
  return true;
}

// 2026-05-18 — Operator flatten. Closes every OPEN futures position using
// the latest cached underlying price. Called from webhook-server's
// /control/flatten endpoint. Skips positions that lack a fresh price
// rather than guessing (operator can rerun once the pricer is healthy).
export function flattenAllFutures(reason = 'OPERATOR_FLATTEN') {
  let lg;
  try { lg = JSON.parse(readFileSync(LEDGER_FILE, 'utf8')); } catch { lg = { trades: [] }; }
  const open = (lg.trades ?? []).filter(t => t.status === 'OPEN');
  const results = [];
  let closed = 0, failed = 0;
  for (const t of open) {
    const live = readLatestPrice(t.instrument);
    if (live == null) {
      results.push({ requestId: t.requestId, instrument: t.instrument, ok: false, reason: 'NO_LIVE_PRICE' });
      failed++;
      continue;
    }
    const r = closePosition(t.requestId, live, reason);
    if (r) {
      results.push({ requestId: t.requestId, instrument: t.instrument, ok: true, exit: live, pnl: r.pnl });
      closed++;
    } else {
      results.push({ requestId: t.requestId, instrument: t.instrument, ok: false, reason: 'CLOSE_FAILED' });
      failed++;
    }
  }
  try { jAlert('info', 'OPERATOR_FLATTEN_FUTURES', { reason, closed, failed, ts: new Date().toISOString() }); } catch {}
  return { closed, failed, results };
}

// Snapshot of operator-facing flags for the /control/status endpoint.
export function getFuturesGateStatus() {
  return {
    path2Halt: (process.env.PATH2_HALT || 'false').toLowerCase() === 'true',
    circuitBreaker: getCircuitBreakerStatus(),
    sizing: {
      maxLossPerTrade: parseFloat(process.env.MAX_LOSS_PER_TRADE || '0') || null,
      sizingFloorBalance: parseFloat(process.env.FUT_SIZING_FLOOR_BALANCE || '10000'),
    },
  };
}

// 2026-05-18 — Eager auto-resume probe. Called by webhook-server.js at the
// top of every Pine alert (before any gate evaluation) so the breaker
// clears as soon as cooldown has elapsed, regardless of whether a futures
// entry attempt would reach the per-instrument check inside placeFuturesOrder.
//
// Fixes the deadlock case: breaker tripped overnight, no entry attempts
// during the cooldown window, then in-window alerts that DID arrive late
// were silently rejected because the entry-side check only clears state
// when called — and it's only called from the futures dispatch path.
//
// Returns one of:
//   { didResume: true, elapsedMin }                — was tripped, cooldown elapsed, cleared
//   { didResume: false, wasNotTripped: true }      — not tripped, no-op
//   { didResume: false, hardHalt: true }           — hard-halt mode, manual REPL clear required
//   { didResume: false, remainingMin }             — still in cooldown
export function tryAutoResumeCircuitBreaker() {
  if (!_circuitBreakerTripped) return { didResume: false, wasNotTripped: true };
  if (_circuitBreakerHardHalt) return { didResume: false, hardHalt: true };
  const now = Date.now();
  const cooldownMs = CB_COOLDOWN_MIN * 60_000;
  const elapsedMs  = now - _circuitBreakerTrippedAt;
  if (elapsedMs >= cooldownMs) {
    const elapsedMin = parseFloat((elapsedMs / 60_000).toFixed(2));
    const previousReason = _circuitBreakerReason;
    console.log(`  [CIRCUIT_BREAKER] eager auto-resume after ${elapsedMin}min cooldown (>= ${CB_COOLDOWN_MIN}min) — was: ${previousReason}`);
    try {
      jAlert('info', 'CIRCUIT_BREAKER_AUTO_RESUMED_AFTER_COOLDOWN', {
        trippedForMin: elapsedMin, cooldownMin: CB_COOLDOWN_MIN, previousReason,
      });
    } catch {}
    _circuitBreakerTripped   = false;
    _circuitBreakerReason    = null;
    _circuitBreakerTrippedAt = 0;
    // Keep _circuitBreakerTrips history for hard-halt detection across cycles.
    try { _persistCircuitBreakerState(); } catch {}
    return { didResume: true, elapsedMin };
  }
  return { didResume: false, remainingMin: Math.ceil((cooldownMs - elapsedMs) / 60_000) };
}

// ─── Ledger I/O ────────────────────────────────────────────────────────

function loadLedger() {
  try {
    if (!existsSync(LEDGER_FILE)) return initLedger();
    return JSON.parse(readFileSync(LEDGER_FILE, 'utf8'));
  } catch {
    return initLedger();
  }
}
function initLedger() {
  return {
    version:      '1.0',
    created:      new Date().toISOString(),
    mode:         FUTURES_TRADING_MODE,
    instruments:  [...ALLOWED_INSTRUMENTS],
    balance:      FUT_STARTING_BALANCE,
    startBalance: FUT_STARTING_BALANCE,
    totalPnL:     0,
    totalTrades:  0,
    wins:         0,
    losses:       0,
    trades:       [],
    dailyPnL:     {},
    tierStats:    { A:{trades:0,wins:0,losses:0,pnl:0}, B:{trades:0,wins:0,losses:0,pnl:0}, C:{trades:0,wins:0,losses:0,pnl:0} },
  };
}
function saveLedger(lg) {
  writeFileSync(LEDGER_FILE, JSON.stringify(lg, null, 2));
}
function acquireLock() {
  try { closeSync(openSync(LOCK_FILE, 'wx')); return true; } catch { return false; }
}
function releaseLock() { try { unlinkSync(LOCK_FILE); } catch {} }

let ledger = loadLedger();
// Persist initial ledger to disk if file doesn't exist (first-load seed)
if (!existsSync(LEDGER_FILE)) saveLedger(ledger);

// ─── Helpers ───────────────────────────────────────────────────────────

function getETString() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
}
function getETDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}
function getETMins() {
  const t = new Date().toLocaleTimeString('en-US', { timeZone:'America/New_York', hour12:false, hour:'2-digit', minute:'2-digit' });
  const [h,m] = t.split(':').map(Number);
  return h * 60 + m;
}
function isFriday() {
  const d = new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', weekday:'short' }).format(new Date());
  return d === 'Fri';
}
function getPointValue(instrument) {
  return POINT_VALUE[(instrument || '').toUpperCase()] ?? 0;
}
function readLatestPrice(instrument) {
  try {
    if (!existsSync(PRICES_FILE)) return null;
    const cache = JSON.parse(readFileSync(PRICES_FILE, 'utf8'));
    const k = (instrument || '').toUpperCase();
    const entry = cache[k] || cache[k.replace('1!','')] || cache[k + '1!'];
    if (!entry || !Number.isFinite(entry.price)) return null;
    // Stale-tolerance: 60s
    if (Date.now() - (entry.ts || 0) > 60_000) return null;
    return entry.price;
  } catch { return null; }
}

// ─── Order gate (request dedup, mirrors paperTrading.orderGate shape) ──

let _reqCounter = 0;
const _gateRequests = new Map();
export const futuresOrderGate = {
  createRequest(meta = {}) {
    const id = `FUT_${meta.signal || '?'}_${meta.engine || '?'}_${Date.now()}_${(_reqCounter++).toString(36)}`;
    _gateRequests.set(id, { ...meta, ts: Date.now(), state: 'created' });
    return id;
  },
  markExecuted(id, trade) { const r = _gateRequests.get(id); if (r) { r.state = 'executed'; r.trade = trade; } },
  markVetoed(id, reason)  { const r = _gateRequests.get(id); if (r) { r.state = 'vetoed'; r.reason = reason; } },
};

// ─── Tier resolution (with stacking) ───────────────────────────────────

function _pruneRecentSignals() {
  const cutoff = Date.now() - 5 * 60_000;
  while (_recentSignals.length && _recentSignals[0].ts < cutoff) _recentSignals.shift();
}
function _resolveTier(consensus) {
  _pruneRecentSignals();
  const direction = consensus.signal;   // CALLS | PUTS
  const inst = (consensus.instrument || '').toUpperCase();
  const engine = consensus.engine;
  const cutoff = Date.now() - STACKING_WINDOW_MS;

  // Conflict check — opposite direction within window blocks entry
  const opposite = _recentSignals.filter(s =>
    s.instrument === inst && s.direction !== direction && s.ts >= cutoff
  );
  if (opposite.length > 0) {
    return { tier: null, reason: 'CONFLICT_BOTH_DIRECTIONS_IN_60S', opposite: opposite.length };
  }

  // Same-direction within window
  const stacked = _recentSignals.filter(s =>
    s.instrument === inst && s.direction === direction && s.ts >= cutoff
  );

  // 2026-05-18 ~14:00 ET — design flip: same-direction multi-engine fires
  // on the same Pine bar are CONFLUENCE on one trade, NOT separate positions.
  // Previous behavior opened 3 trades on triple-engine fires (e.g. today's
  // 13:50:01-13:50:02 MNQ1! SELL/HTF/ZONE → 3 × 1c → 3 × -$32 → circuit
  // breaker trip on what was structurally one signal). Operator policy:
  // first engine in the window opens the position; subsequent same-direction
  // engines get gate-blocked with DUPLICATE_CONFLUENCE_WITHIN_WINDOW. The
  // confluence engines are captured on the journal so post-session analysis
  // can audit which combos co-fired.
  if (stacked.length >= 1) {
    const first = stacked.reduce((a, b) => (a.ts <= b.ts ? a : b));
    const ageMs = Date.now() - first.ts;
    return {
      tier: null,
      reason: 'DUPLICATE_CONFLUENCE_WITHIN_WINDOW',
      firstEngine: first.engine,
      firstAgeMs: ageMs,
      windowMs: STACKING_WINDOW_MS,
      confluenceCount: stacked.length,
    };
  }

  // Base tier from engine — first signal in window picks tier normally.
  let tier;
  if (engine === 'LIVE')                                        tier = 'C';
  else if (engine === 'HTF')                                    tier = 'A';
  else if (['HL','LH','BUY','SELL','ZONE'].includes(engine))    tier = 'B';
  else                                                          tier = 'B';

  return { tier, stacked: 0 };
}

// ─── Place order (entry path) ──────────────────────────────────────────

export function placeFuturesOrder(consensus, requestId) {
  let inst = (consensus.instrument || '').toUpperCase();   // mutable: micro-fallback may re-route
  const direction = consensus.signal;   // CALLS | PUTS

  // 2026-05-18 13:40 ET: pricer DEGRADED gate. When futuresPricer detects
  // N consecutive stale cycles (TV CDP feed frozen / data stream paused
  // silently), block new entries — managing existing positions on
  // last-known prices is still safe via the eval loop, but opening a new
  // position on a frozen quote is not.
  if (_isFuturesPricerDegraded()) {
    const reason = 'FUT_PRICER_DEGRADED — price feed stale; new entries blocked until recovery';
    futuresOrderGate.markVetoed(requestId, reason);
    jGateBlock(consensus.engine, inst, direction, 'FUT_PRICER_DEGRADED', { instrument: inst, direction });
    return { vetoed: true, reason };
  }

  // 2026-05-17 EOD: PATH2_HALT global circuit-breaker (manual env flag).
  if ((process.env.PATH2_HALT || 'false').toLowerCase() === 'true') {
    const reason = 'PATH2_HALT — futures execution halted by operator; see Mon 5/18 Task #0 gate audit';
    futuresOrderGate.markVetoed(requestId, reason);
    jGateBlock(consensus.engine, inst, direction, 'PATH2_HALT', { instrument: inst, direction, engine: consensus.engine });
    console.log(`  🛑 PATH2_HALT — rejecting ${inst} ${direction} ${consensus.engine}`);
    return { vetoed: true, reason };
  }
  // 2026-05-18: circuit breaker with 30min auto-resume + hard-halt-after-3
  const _cb = circuitBreakerEntryCheck();
  if (_cb.blocked) {
    futuresOrderGate.markVetoed(requestId, _cb.reason);
    jGateBlock(consensus.engine, inst, direction, _cb.hardHalt ? 'CIRCUIT_BREAKER_HARD_HALT' : 'CIRCUIT_BREAKER', { reason: _cb.reason, hardHalt: !!_cb.hardHalt, remainingMin: _cb.remainingMin });
    console.log(`  ⛔ CIRCUIT_BREAKER — rejecting ${inst} ${direction} ${consensus.engine} (${_cb.hardHalt ? 'HARD HALT' : `auto-resume in ${_cb.remainingMin}min`})`);
    return { vetoed: true, reason: _cb.reason };
  }

  // Instrument allowlist
  if (!ALLOWED_INSTRUMENTS.has(inst)) {
    const reason = `Instrument ${inst} not in FUT_INSTRUMENTS allowlist (graduation gates ES1!/NQ1!/MNQ1! at $${FUT_GRADUATION_THRESHOLD} balance)`;
    futuresOrderGate.markVetoed(requestId, reason);
    jGateBlock(consensus.engine, inst, direction, 'FUT_INSTRUMENT_NOT_ALLOWED', { allowed: [...ALLOWED_INSTRUMENTS] });
    return { vetoed: true, reason };
  }

  // 2026-05-15 Task 9: CME 23/5 schedule. Daily maintenance 16:59-18:00 ET.
  // Friday close 16:59 → Sunday reopen 17:00. Saturday fully blocked.
  {
    const _etHMS = new Date().toLocaleTimeString('en-US', { timeZone:'America/New_York', hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const [_eh, _em] = _etHMS.split(':').map(Number);
    const _etMins = _eh * 60 + _em;
    const _dayShort = new Date().toLocaleDateString('en-US', { timeZone:'America/New_York', weekday: 'short' });
    const _dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[_dayShort] ?? new Date().getDay();
    let _gateReason = null;
    if (_dow === 6)                                            _gateReason = 'FUTURES_WEEKEND';
    else if (_dow === 0 && _etMins < 17 * 60)                  _gateReason = 'FUTURES_WEEKEND';
    else if (_dow === 5 && _etMins >= 16 * 60 + 59)            _gateReason = 'FUTURES_WEEKEND';
    else if (_dow >= 1 && _dow <= 4
      && _etMins >= 16 * 60 + 59
      && _etMins <  18 * 60)                                   _gateReason = 'FUTURES_MAINTENANCE';
    if (_gateReason) {
      const reason = `${_gateReason} — futures sendOrder rejected at ${_etHMS} ET (${inst})`;
      futuresOrderGate.markVetoed(requestId, reason);
      jGateBlock(consensus.engine, inst, direction, _gateReason, { etHMS: _etHMS, etMins: _etMins, dow: _dow });
      return { vetoed: true, reason };
    }
  }

  // Daily envelope
  const today = getETDate();
  const todayPnL = ledger.dailyPnL[today] || 0;
  const todayTrades = ledger.trades.filter(t => t.entryTimeET && t.fillTime && new Date(t.fillTime).toLocaleDateString('en-CA',{timeZone:'America/New_York'}) === today).length;

  if (Date.now() < _consecutiveLosses.cooldownUntil) {
    const reason = `Cooldown — ${MAX_CONSECUTIVE_LOSSES} consecutive losses, until ${new Date(_consecutiveLosses.cooldownUntil).toISOString()}`;
    futuresOrderGate.markVetoed(requestId, reason);
    jGateBlock(consensus.engine, inst, direction, 'FUT_COOLDOWN_ACTIVE', { cooldownUntil: _consecutiveLosses.cooldownUntil });
    return { vetoed: true, reason };
  }
  if (MAX_DAILY_LOSS > 0 && todayPnL <= -MAX_DAILY_LOSS) {
    const reason = `Daily loss cap hit ($${todayPnL.toFixed(0)} / -$${MAX_DAILY_LOSS})`;
    futuresOrderGate.markVetoed(requestId, reason);
    jGateBlock(consensus.engine, inst, direction, 'FUT_DAILY_LOSS_CAP', { dailyPnL: todayPnL, cap: MAX_DAILY_LOSS });
    return { vetoed: true, reason };
  }
  if (isFriday() && FRIDAY_LOSS_CAP > 0 && todayPnL <= -FRIDAY_LOSS_CAP) {
    const reason = `Friday loss cap hit ($${todayPnL.toFixed(0)} / -$${FRIDAY_LOSS_CAP})`;
    futuresOrderGate.markVetoed(requestId, reason);
    jGateBlock(consensus.engine, inst, direction, 'FUT_FRIDAY_LOSS_CAP', { dailyPnL: todayPnL, cap: FRIDAY_LOSS_CAP });
    return { vetoed: true, reason };
  }
  // 2026-05-15 Task 3: multi-tier profit-protection gate (combined P&L).
  // Mirrors the gate in paperTrading.sendOrder so futures-direct entries are
  // suppressed under the same tier/pause/lock conditions. Module reads both
  // ledgers internally; disabled by default until PROFIT_PROTECTION_ENABLED=true.
  const _pp = profitProtectionEvaluate({ today });
  if (_pp.blocked) {
    futuresOrderGate.markVetoed(requestId, _pp.reason);
    jGateBlock(consensus.engine, inst, direction, 'FUT_PROFIT_PROTECTION',
      { tier: _pp.tier, dailyPnL: _pp.dailyPnL, peakDailyPnL: _pp.peakDailyPnL, reason: _pp.reason });
    return { vetoed: true, reason: _pp.reason };
  }
  // 2026-05-15 Task 7: pre-12:00 pause for futures (mirrors paperTrading).
  const _psk = isTradingPaused();
  if (_psk.paused) {
    futuresOrderGate.markVetoed(requestId, _psk.reason);
    jGateBlock(consensus.engine, inst, direction, 'FUT_PRE_SWITCH_PAUSE', { reason: _psk.reason });
    return { vetoed: true, reason: _psk.reason };
  }
  if (MAX_TRADES_PER_DAY > 0 && todayTrades >= MAX_TRADES_PER_DAY) {
    const reason = `Max trades per day (${todayTrades}/${MAX_TRADES_PER_DAY})`;
    futuresOrderGate.markVetoed(requestId, reason);
    jGateBlock(consensus.engine, inst, direction, 'FUT_MAX_TRADES_REACHED', { todayTrades, cap: MAX_TRADES_PER_DAY });
    return { vetoed: true, reason };
  }

  // Tier resolution + stacking
  const resolveRes = _resolveTier(consensus);
  const { tier, reason: tierReason } = resolveRes;
  if (tier === null) {
    futuresOrderGate.markVetoed(requestId, tierReason);
    if (tierReason === 'DUPLICATE_CONFLUENCE_WITHIN_WINDOW') {
      jGateBlock(consensus.engine, inst, direction, 'FUT_DUPLICATE_CONFLUENCE', {
        firstEngine:     resolveRes.firstEngine,
        firstAgeMs:      resolveRes.firstAgeMs,
        windowMs:        resolveRes.windowMs,
        confluenceCount: resolveRes.confluenceCount,
        note:            'First engine in the 60s window opened the position; this duplicate same-direction engine is recorded as confluence-only.',
      });
    } else {
      jGateBlock(consensus.engine, inst, direction, 'FUT_CONFLICT_BLOCKED', { opposite: resolveRes.opposite });
    }
    return { vetoed: true, reason: tierReason };
  }
  const tierCfg = TIER[tier];
  // 2026-05-18 pre-RTH hot-fix (Mon 5/18 Task #0 partial): hardcoded
  // sizing floor. Sub-$10K accounts get 1 contract regardless of tier,
  // bypassing the cascade-vulnerable tier sizing. Root cause of Sun 5/17
  // 20:04-20:06 ET catastrophic failure was Tier B 3-contract entries
  // on a $520 account. Operator bumped floor to $10K so the fresh
  // $10K-reset account starts at 1c per signal until balance grows.
  // Full audit per docs/MONDAY_5_18_TASK_ZERO_GATE_AUDIT.md.
  const SIZING_FLOOR_THRESHOLD = parseFloat(process.env.FUT_SIZING_FLOOR_BALANCE || '10000');
  const _balanceForSizing = ledger.balance || 0;
  let contracts = tierCfg.contracts;
  let sizingFloorApplied = false;
  if (_balanceForSizing < SIZING_FLOOR_THRESHOLD && contracts > 1) {
    sizingFloorApplied = true;
    console.log(`  ⚠ SIZE_FLOOR_1_CONTRACT — balance $${_balanceForSizing.toFixed(0)} < $${SIZING_FLOOR_THRESHOLD.toFixed(0)}, overriding tier ${tier} (${tierCfg.contracts}c → 1c)`);
    try { jAlert('warning', 'SIZE_FLOOR_1_CONTRACT', { balance: _balanceForSizing, threshold: SIZING_FLOOR_THRESHOLD, tierAttempted: tier, tierContracts: tierCfg.contracts, override: 1 }); } catch {}
    contracts = 1;
  }
  const stopPoints = tierCfg.stopPoints;

  // 2026-05-18 13:05 ET — micro-fallback (operator-restored).
  // When a full-contract Pine alert (ES1!/NQ1!) can't fit its overnight
  // margin within its per-instrument cap, auto-route to the corresponding
  // micro (MES1!/MNQ1!) at 1c. Catches setups that fire on the full chart
  // when only the micro fits the cap. Symmetric to the original 2026-05-17
  // logic that got removed when Path 2 was restored. Mutates `inst` and
  // `consensus.instrument` so the downstream cap / max-loss / ledger paths
  // all see the routed symbol.
  const MICRO_FALLBACK_MAP = { 'ES1!': 'MES1!', 'NQ1!': 'MNQ1!' };
  if (MICRO_FALLBACK_MAP[inst]) {
    const _fullCap    = _futCapForInstrument(inst);
    const _fullMargin = _futMarginForInstrument(inst);
    if (_fullCap > 0 && _fullMargin > 0 && _fullMargin > _fullCap) {
      const _micro       = MICRO_FALLBACK_MAP[inst];
      const _microCap    = _futCapForInstrument(_micro);
      const _microMargin = _futMarginForInstrument(_micro);
      if (_microCap > 0 && _microMargin > 0 && _microCap >= _microMargin) {
        console.log(`  ⚠ MICRO_FALLBACK ${inst}→${_micro}  full margin $${_fullMargin} > cap $${_fullCap}; routing to micro (cap $${_microCap}, margin $${_microMargin})`);
        try { jAlert('info', 'MICRO_FALLBACK', { from: inst, to: _micro, fullCap: _fullCap, fullMargin: _fullMargin, microCap: _microCap, microMargin: _microMargin, requestId }); } catch {}
        inst = _micro;
        consensus.instrument = _micro;
      } else {
        console.log(`  ⚠ MICRO_FALLBACK ${inst}→${_micro} UNAVAILABLE — micro margin $${_microMargin} > micro cap $${_microCap}. Raise CAPITAL_CAP_${_micro.replace('1!','')} ≥ $${_microMargin}.`);
        try { jAlert('warning', 'MICRO_FALLBACK_UNAVAILABLE', { from: inst, to: _micro, microCap: _microCap, microMargin: _microMargin, requestId }); } catch {}
      }
    }
  }

  // 2026-05-18 pre-RTH (Mon 5/18 Task #0 partial): per-instrument capital cap.
  // Formula: per-contract MARGIN (broker overnight initial margin, NOT notional).
  // cap = margin + $1K buffer per operator policy.
  // allowed_contracts = floor(cap / margin_per_contract).
  // Default 1-contract sizing for typical accounts: each cap allows exactly 1c
  // because cap ≈ margin + $1K and 2c × margin > cap.
  const _futPointValue   = getPointValue(inst);
  const _futCapPerTrade  = _futCapForInstrument(inst);
  const _futMarginPerC   = _futMarginForInstrument(inst);
  if (_futCapPerTrade > 0 && _futMarginPerC > 0) {
    const _capImpliedContracts = Math.floor(_futCapPerTrade / _futMarginPerC);
    if (_capImpliedContracts < 1) {
      const reason = `FUT_CAPITAL_CAP_PER_TRADE — 1 contract margin $${_futMarginPerC.toFixed(0)} > cap $${_futCapPerTrade} (${inst})`;
      futuresOrderGate.markVetoed(requestId, reason);
      jGateBlock(consensus.engine, inst, direction, 'FUT_CAPITAL_CAP_PER_TRADE', {
        instrument: inst, marginPerContract: _futMarginPerC, capPerTrade: _futCapPerTrade,
      });
      console.log(`  🛑 ${reason}`);
      return { vetoed: true, reason };
    }
    if (_capImpliedContracts < contracts) {
      console.log(`  ⚠ FUT_CAPITAL_CAP_PER_TRADE — reducing contracts ${contracts}→${_capImpliedContracts} (${_capImpliedContracts}c × $${_futMarginPerC} margin = $${(_futMarginPerC * _capImpliedContracts).toFixed(0)} ≤ cap $${_futCapPerTrade})`);
      contracts = _capImpliedContracts;
    }
  }

  // 2026-05-18 pre-RTH: MAX_LOSS_PER_TRADE gate. Per-contract stop loss =
  // stopPoints × pointValue. If contracts × per-contract-loss > cap, reduce
  // contracts until it fits. If even 1c exceeds, reject. Default $200.
  if (FUT_MAX_LOSS_PER_TRADE > 0 && _futPointValue > 0 && stopPoints > 0) {
    const _perContractMaxLoss = stopPoints * _futPointValue;
    const _maxLossImpliedContracts = Math.floor(FUT_MAX_LOSS_PER_TRADE / _perContractMaxLoss);
    if (_maxLossImpliedContracts < 1) {
      const reason = `FUT_MAX_LOSS_PER_TRADE — 1 contract risk $${_perContractMaxLoss.toFixed(0)} > cap $${FUT_MAX_LOSS_PER_TRADE} (${inst} ${stopPoints}pt × $${_futPointValue}/pt)`;
      futuresOrderGate.markVetoed(requestId, reason);
      jGateBlock(consensus.engine, inst, direction, 'FUT_MAX_LOSS_PER_TRADE', {
        instrument: inst, stopPoints, pointValue: _futPointValue,
        oneContractMaxLoss: _perContractMaxLoss, cap: FUT_MAX_LOSS_PER_TRADE,
      });
      console.log(`  🛑 ${reason}`);
      return { vetoed: true, reason };
    }
    if (_maxLossImpliedContracts < contracts) {
      console.log(`  ⚠ FUT_MAX_LOSS_PER_TRADE — reducing contracts ${contracts}→${_maxLossImpliedContracts} (risk $${(_perContractMaxLoss * _maxLossImpliedContracts).toFixed(0)} ≤ cap $${FUT_MAX_LOSS_PER_TRADE})`);
      contracts = _maxLossImpliedContracts;
    }
  }
  const targetPoints = tierCfg.targetPoints;

  // Underlying entry price — Pine alert provides it via consensus.underlyingPrice
  // (or consensus.entryPrice if caller passed underlying directly)
  const entryUnderlying = consensus.underlyingPrice ?? consensus.entryPrice ?? null;
  if (!Number.isFinite(entryUnderlying) || entryUnderlying <= 0) {
    const reason = `No valid entry underlying price (${entryUnderlying})`;
    futuresOrderGate.markVetoed(requestId, reason);
    jGateBlock(consensus.engine, inst, direction, 'FUT_NO_UNDERLYING', { underlying: entryUnderlying });
    return { vetoed: true, reason };
  }
  const isCalls = direction === 'CALLS';
  const stopPrice   = parseFloat((isCalls ? entryUnderlying - stopPoints : entryUnderlying + stopPoints).toFixed(4));
  const targetPrice = parseFloat((isCalls ? entryUnderlying + targetPoints : entryUnderlying - targetPoints).toFixed(4));

  const fillTime = Date.now();
  const trade = {
    requestId,
    instrument: inst,
    signal:     direction,    // CALLS/PUTS preserved (locked decision #1)
    engine:     consensus.engine,
    confidence: consensus.confidence,
    tier,
    contracts,
    originalContracts: contracts,
    entryPrice: entryUnderlying,         // futures-direct: entry IS the underlying
    fillPrice:  entryUnderlying,         // alias for journal compatibility
    fillTime,
    fillTimeET: getETString(),
    entryTimeET: getETString(),
    pointValue: getPointValue(inst),
    stage:      'STAGE_1_ARMED',
    stopPrice,
    stopPoints,
    targetPrice,
    targetPoints,
    peakFavorablePrice: entryUnderlying,
    trailStopPrice: null,
    lockedStopLevel: 'NONE',
    cumulativePartialPnL: 0,
    scaleOutEvents: [],
    macro4H: consensus.macro4H ?? null,
    invalidationLevel: Number.isFinite(consensus.invalidationLevel) ? consensus.invalidationLevel : null,
    structureType:     consensus.structureType ?? null,
    status:     'OPEN',
    exitPrice:  null,
    exitTime:   null,
    pnl:        null,
    paper:      true,
    mode:       FUTURES_TRADING_MODE,
  };

  // Record in ledger under lock
  const locked = acquireLock();
  try {
    const fresh = loadLedger();
    fresh.trades.push(trade);
    fresh.totalTrades++;
    saveLedger(fresh);
    if (!ledger.trades.find(t => t.requestId === requestId)) ledger.trades.push(trade);
    ledger.totalTrades = fresh.totalTrades;
  } finally {
    if (locked) releaseLock();
  }

  // Track signal for stacking window
  _recentSignals.push({ instrument: inst, direction, ts: fillTime, requestId });

  futuresOrderGate.markExecuted(requestId, trade);
  try { jFutEntry(trade); } catch {}
  console.log(`\n  🟦 FUT_ENTRY  ${inst} ${direction} ${consensus.engine}  tier=${tier}  ${contracts}c @ ${entryUnderlying} | stop=${stopPrice} target=${targetPrice} (stacked=${stacked})`);
  return trade;
}

// ─── Close position (full exit) ────────────────────────────────────────

export function closeFuturesPosition(requestId, exitPrice, exitReason = 'MANUAL') {
  const locked = acquireLock();
  try {
    const fresh = loadLedger();
    const trade = fresh.trades.find(t => t.requestId === requestId && t.status === 'OPEN');
    if (!trade) return null;

    const dirMult = trade.signal === 'CALLS' ? 1 : -1;
    const pnlPoints = (exitPrice - trade.entryPrice) * dirMult;
    const pnlRemaining = pnlPoints * trade.pointValue * trade.contracts;
    const partialPnL = trade.cumulativePartialPnL || 0;
    const finalPnL = pnlRemaining + partialPnL;
    const win = finalPnL > 0;
    const holdMins = (Date.now() - trade.fillTime) / 60000;

    trade.exitPrice = exitPrice;
    trade.exitTime  = Date.now();
    trade.exitTimeET = getETString();
    trade.exitReason = exitReason;
    trade.pnl = parseFloat(finalPnL.toFixed(2));
    trade.pnlPoints = parseFloat(pnlPoints.toFixed(4));
    trade.pnlRemainingLeg = parseFloat(pnlRemaining.toFixed(2));
    trade.holdMins = parseFloat(holdMins.toFixed(1));
    trade.status = 'CLOSED';
    trade.win = win;

    fresh.totalPnL += pnlRemaining;     // partial pnl was added at scale-out time
    fresh.balance  += pnlRemaining;
    if (win) fresh.wins++; else fresh.losses++;
    const today = getETDate();
    fresh.dailyPnL[today] = (fresh.dailyPnL[today] || 0) + pnlRemaining;
    if (fresh.tierStats?.[trade.tier]) {
      fresh.tierStats[trade.tier].trades++;
      fresh.tierStats[trade.tier].pnl += finalPnL;
      if (win) fresh.tierStats[trade.tier].wins++; else fresh.tierStats[trade.tier].losses++;
    }

    saveLedger(fresh);

    // Sync in-memory
    const local = ledger.trades.find(t => t.requestId === requestId);
    if (local) Object.assign(local, trade);
    ledger.totalPnL = fresh.totalPnL;
    ledger.balance  = fresh.balance;
    ledger.dailyPnL[today] = fresh.dailyPnL[today];

    // Consecutive-loss tracking
    if (win) _consecutiveLosses.count = 0;
    else {
      _consecutiveLosses.count++;
      if (_consecutiveLosses.count >= MAX_CONSECUTIVE_LOSSES) {
        _consecutiveLosses.cooldownUntil = Date.now() + COOLDOWN_MS;
        try { jAlert('warning', 'FUT_COOLDOWN_TRIGGERED', { count: _consecutiveLosses.count, until: _consecutiveLosses.cooldownUntil }); } catch {}
      }
    }

    // 2026-05-18 pre-RTH hot-fix: feed close P&L to circuit breaker.
    // Trips on >= 3 closes or cumulative -$500 in rolling 5-min window.
    try { _circuitBreakerCheck(finalPnL); } catch {}

    // Daily target
    if (DAILY_TARGET > 0 && _dailyTargetFiredFor !== today
        && fresh.dailyPnL[today] >= DAILY_TARGET) {
      _dailyTargetFiredFor = today;
      try {
        jAlert('info', 'FUT_TARGET_REACHED', {
          dailyPnL: fresh.dailyPnL[today], target: DAILY_TARGET,
          instrument: trade.instrument, engine: trade.engine,
        });
        writeFileSync(TARGET_STATE, JSON.stringify({
          fired: true, firedAt: Date.now(), firedAtET: getETString(),
          date: today, dailyPnL: fresh.dailyPnL[today], target: DAILY_TARGET,
        }));
      } catch {}
      console.log(`  🎯 FUT_TARGET_REACHED — +$${fresh.dailyPnL[today].toFixed(0)} / target $${DAILY_TARGET}`);
    }

    // Graduation watcher
    if (FUT_GRADUATION_THRESHOLD > 0 && _graduationFiredFor !== today
        && fresh.balance >= FUT_GRADUATION_THRESHOLD
        && fresh.startBalance < FUT_GRADUATION_THRESHOLD) {
      _graduationFiredFor = today;
      try {
        jAlert('info', 'FUT_GRADUATION_REACHED', {
          balance: fresh.balance, threshold: FUT_GRADUATION_THRESHOLD,
          message: 'Account crossed graduation threshold. Operator-explicit unlock required to enable additional instruments (ES1!/NQ1!/MNQ1!).',
        });
      } catch {}
      console.log(`  🎓 FUT_GRADUATION_REACHED — balance $${fresh.balance.toFixed(0)} crossed $${FUT_GRADUATION_THRESHOLD}. Operator review required to enable ES1!/NQ1!/MNQ1!.`);
    }

    const sign = win ? '+' : '';
    console.log(`  🟦 FUT_EXIT ${exitReason}  ${trade.instrument} ${trade.signal}  ${trade.contracts}c  ${trade.entryPrice}→${exitPrice}  ${sign}${pnlPoints.toFixed(2)}pt  ${sign}$${finalPnL.toFixed(0)}  held ${holdMins.toFixed(1)}m`);
    try { jFutExit(trade); } catch {}

    _whipsawState.delete(requestId);
    return trade;
  } finally {
    if (locked) releaseLock();
  }
}

// ─── Partial close (50/50 scale-out at STAGE_2 transition) ─────────────

function _executeScaleOut(requestId, exitPrice, liveU) {
  const locked = acquireLock();
  try {
    const fresh = loadLedger();
    const trade = fresh.trades.find(t => t.requestId === requestId && t.status === 'OPEN');
    if (!trade || trade.stage !== 'STAGE_1_ARMED') return null;
    if (!trade.contracts || trade.contracts < 1) return null;

    const halfContracts = Math.max(1, Math.floor(trade.contracts / 2));
    const remainingContracts = trade.contracts - halfContracts;

    const dirMult = trade.signal === 'CALLS' ? 1 : -1;
    const partialPnlPoints = (exitPrice - trade.entryPrice) * dirMult;
    const partialPnl = partialPnlPoints * trade.pointValue * halfContracts;

    trade.contracts = remainingContracts;
    trade.cumulativePartialPnL = (trade.cumulativePartialPnL || 0) + partialPnl;
    trade.scaleOutEvents.push({
      contracts: halfContracts, exitPrice, exitTime: Date.now(),
      et: getETString(), pnl: parseFloat(partialPnl.toFixed(2)),
      reason: 'FUT_SCALE_OUT_PARTIAL', underlyingAtExit: liveU,
    });

    // STAGE 3 setup: BE stop, trail active (Tier-A specific BE rules per locked decisions)
    trade.stage = 'STAGE_3_TRAILING';
    trade.stopPrice = trade.entryPrice;     // BE
    trade.peakFavorablePrice = liveU;
    const trailDist = liveU * (TRAIL_PCT / 100);
    trade.trailStopPrice = trade.signal === 'CALLS'
      ? parseFloat((liveU - trailDist).toFixed(4))
      : parseFloat((liveU + trailDist).toFixed(4));
    trade.lockedStopLevel = 'NONE';

    fresh.totalPnL += partialPnl;
    fresh.balance  += partialPnl;
    const today = getETDate();
    fresh.dailyPnL[today] = (fresh.dailyPnL[today] || 0) + partialPnl;

    saveLedger(fresh);

    const local = ledger.trades.find(t => t.requestId === requestId);
    if (local) Object.assign(local, trade);
    ledger.totalPnL = fresh.totalPnL;
    ledger.balance  = fresh.balance;
    ledger.dailyPnL[today] = fresh.dailyPnL[today];

    console.log(`  🟢 FUT_SCALE_OUT  ${trade.instrument} ${trade.signal}  closed ${halfContracts}/${trade.originalContracts} @ ${exitPrice}  +$${partialPnl.toFixed(0)}  remainder ${remainingContracts}c → BE@${trade.entryPrice} + trail`);
    try { jFutExit({ ...trade, exitPrice, exitTime: Date.now(), exitTimeET: getETString(), exitReason: 'FUT_SCALE_OUT_PARTIAL', pnl: parseFloat(partialPnl.toFixed(2)), contracts: halfContracts }); } catch {}

    return trade;
  } finally {
    if (locked) releaseLock();
  }
}

// ─── STAGE_3 update (peak + trail + R-locks) ───────────────────────────

// 2026-05-15: underlying-price sanity threshold (defaults to 50% from .env)
// Mirrors paperTrading.js gate. Prevents bogus feeder values from poisoning
// peakFavorablePrice / R-lock state in Path 2 (futures-direct) trades.
const _FUT_SANITY_THRESHOLD = parseFloat(process.env.UNDERLYING_SANITY_THRESHOLD || '0.5');
function _futIsSane(liveU, entryU) {
  if (!Number.isFinite(liveU) || !Number.isFinite(entryU) || entryU <= 0) return false;
  return Math.abs(liveU - entryU) / entryU <= _FUT_SANITY_THRESHOLD;
}

function _updateStage3(requestId, liveU) {
  const locked = acquireLock();
  try {
    const fresh = loadLedger();
    const trade = fresh.trades.find(t => t.requestId === requestId && t.status === 'OPEN');
    if (!trade || trade.stage !== 'STAGE_3_TRAILING') return null;
    if (!_futIsSane(liveU, trade.entryPrice)) return null;

    const isCalls = trade.signal === 'CALLS';
    const isFavorable = isCalls
      ? liveU > (trade.peakFavorablePrice ?? trade.entryPrice)
      : liveU < (trade.peakFavorablePrice ?? trade.entryPrice);
    let dirty = false;
    if (isFavorable) {
      trade.peakFavorablePrice = liveU;
      dirty = true;
    }

    // Trail
    const trailDist = (trade.peakFavorablePrice ?? liveU) * (TRAIL_PCT / 100);
    const newTrailStop = isCalls
      ? parseFloat((trade.peakFavorablePrice - trailDist).toFixed(4))
      : parseFloat((trade.peakFavorablePrice + trailDist).toFixed(4));
    if (trade.trailStopPrice == null
        || (isCalls && newTrailStop > trade.trailStopPrice)
        || (!isCalls && newTrailStop < trade.trailStopPrice)) {
      trade.trailStopPrice = newTrailStop;
      dirty = true;
    }

    // R-locks (R = stopPoints)
    const R = trade.stopPoints;
    const moveFromEntry = isCalls
      ? (trade.peakFavorablePrice - trade.entryPrice)
      : (trade.entryPrice - trade.peakFavorablePrice);
    const RMultiple = R > 0 ? moveFromEntry / R : 0;
    if (RMultiple >= 4 && trade.lockedStopLevel !== '2R') {
      const lockPrice = isCalls
        ? parseFloat((trade.entryPrice + 2 * R).toFixed(4))
        : parseFloat((trade.entryPrice - 2 * R).toFixed(4));
      trade.stopPrice = isCalls
        ? Math.max(lockPrice, trade.trailStopPrice ?? lockPrice)
        : Math.min(lockPrice, trade.trailStopPrice ?? lockPrice);
      trade.lockedStopLevel = '2R';
      dirty = true;
      console.log(`  🔒 FUT ${trade.instrument} ${trade.signal} +4R → stop locked at +2R (${trade.stopPrice})`);
    } else if (RMultiple >= 3 && trade.lockedStopLevel === 'NONE') {
      const lockPrice = isCalls
        ? parseFloat((trade.entryPrice + 1 * R).toFixed(4))
        : parseFloat((trade.entryPrice - 1 * R).toFixed(4));
      trade.stopPrice = isCalls
        ? Math.max(lockPrice, trade.trailStopPrice ?? lockPrice)
        : Math.min(lockPrice, trade.trailStopPrice ?? lockPrice);
      trade.lockedStopLevel = '1R';
      dirty = true;
      console.log(`  🔒 FUT ${trade.instrument} ${trade.signal} +3R → stop locked at +1R (${trade.stopPrice})`);
    } else if (trade.lockedStopLevel === 'NONE') {
      // No lock yet — stop tracks the better of BE and trail
      const trailWinsOverBE = isCalls
        ? trade.trailStopPrice > trade.entryPrice
        : trade.trailStopPrice < trade.entryPrice;
      if (trailWinsOverBE && trade.trailStopPrice != null) {
        trade.stopPrice = trade.trailStopPrice;
        dirty = true;
      }
    }

    if (dirty) {
      saveLedger(fresh);
      const local = ledger.trades.find(t => t.requestId === requestId);
      if (local) Object.assign(local, trade);
    }
    return trade;
  } finally {
    if (locked) releaseLock();
  }
}

// ─── Eval loop (stop/target/trail check) ───────────────────────────────

export function evaluateOpenFutures() {
  let lg;
  try { lg = JSON.parse(readFileSync(LEDGER_FILE, 'utf8')); } catch { return; }
  const open = (lg.trades ?? []).filter(t => t.status === 'OPEN');
  for (const t of open) {
    const liveU = readLatestPrice(t.instrument);
    if (liveU == null) continue;   // no fresh price
    // 2026-05-15: sanity gate. Reject ticks that deviate >50% from entry.
    if (!_futIsSane(liveU, t.entryPrice)) {
      try { jError('fut-eval-unsane',
        `${t.instrument} liveU=${liveU} entryPrice=${t.entryPrice} — tick rejected`,
        { requestId: t.requestId, liveU, entryPrice: t.entryPrice }); } catch {}
      continue;
    }

    const isCalls = t.signal === 'CALLS';

    // 1. Stop check — tick-based by default (was bar_close; flipped 2026-05-18
    // after 34pt slippage event). Exit price simulates real broker behavior:
    // STOP order converts to MARKET on first tick at/past trigger, fills
    // ~1 tick beyond the level. Using stopPrice ± FUT_STOP_SLIPPAGE_POINTS
    // avoids the polling-delayed-liveU pricing that produced -$170 fills
    // on 3pt stops.
    const stopBreached = isCalls ? liveU <= t.stopPrice : liveU >= t.stopPrice;
    if (stopBreached) {
      let exitReason = 'FUT_STOP_HIT';
      if (t.lockedStopLevel === '1R' || t.lockedStopLevel === '2R') exitReason = 'FUT_PROFIT_LOCKED_STOP';
      else if (t.stage === 'STAGE_3_TRAILING' && Math.abs(t.stopPrice - t.entryPrice) < 0.01) exitReason = 'FUT_BREAKEVEN_STOP';

      const useBarClose = WHIPSAW_PROTECTION && STOP_CONFIRMATION === 'bar_close' && exitReason === 'FUT_STOP_HIT';
      let shouldFire = !useBarClose;
      if (useBarClose) {
        const nowET = new Date().toLocaleString('en-US', { timeZone:'America/New_York', hour12:false, hour:'2-digit', minute:'2-digit' });
        let ws = _whipsawState.get(t.requestId);
        if (!ws) { ws = { currentBarMinute: nowET, currentBarBreached: false }; _whipsawState.set(t.requestId, ws); }
        if (nowET !== ws.currentBarMinute) {
          if (ws.currentBarBreached && stopBreached) shouldFire = true;
          ws.currentBarMinute = nowET;
          ws.currentBarBreached = stopBreached;
        } else if (stopBreached) {
          ws.currentBarBreached = true;
        }
      }
      if (shouldFire) {
        // Tick mode: simulate broker STOP→MARKET fill ~1 tick beyond level.
        // bar_close mode (legacy): use the delayed liveU (preserves prior behavior).
        const slip = FUT_STOP_SLIPPAGE_POINTS;
        const fillPrice = (STOP_CONFIRMATION === 'tick')
          ? parseFloat((t.stopPrice + (isCalls ? -slip : slip)).toFixed(4))
          : liveU;
        try { closeFuturesPosition(t.requestId, fillPrice, exitReason); } catch (e) { jError('FUT_EXIT_FIRE', e.message); }
        continue;
      }
    }

    // 2. STAGE_1 target hit → STAGE_2 scale-out → STAGE_3
    if (t.stage === 'STAGE_1_ARMED' && t.targetPrice != null) {
      const tgtHit = isCalls ? liveU >= t.targetPrice : liveU <= t.targetPrice;
      if (tgtHit) {
        try { _executeScaleOut(t.requestId, liveU, liveU); } catch (e) { jError('FUT_SCALE_OUT', e.message); }
        continue;
      }
    }

    // 3. STAGE_3 trail/lock update
    if (t.stage === 'STAGE_3_TRAILING') {
      try { _updateStage3(t.requestId, liveU); } catch (e) { jError('FUT_STAGE3', e.message); }
    }
  }
}

export function getFuturesLedger() {
  try { return JSON.parse(readFileSync(LEDGER_FILE, 'utf8')); } catch { return null; }
}

// ─── Startup banner + eval timer ───────────────────────────────────────

// 2026-05-18: detect freshly-reset ledger and surface a one-shot banner.
// Condition: reset_reason set AND zero trades — naturally one-shot since
// the first fill bumps totalTrades and the line stops printing on restart.
if (ledger.reset_reason && (ledger.trades?.length ?? 0) === 0 && (ledger.totalTrades ?? 0) === 0) {
  console.log(`  [futuresTrading] LEDGER RESET — fresh start $${ledger.balance.toFixed(0)} balance`);
  console.log(`  [futuresTrading] reset_reason: ${ledger.reset_reason.slice(0, 140)}${ledger.reset_reason.length > 140 ? '...' : ''}`);
}
console.log(`  [futuresTrading] mode=${FUTURES_TRADING_MODE} balance=$${ledger.balance.toFixed(0)} instruments=${[...ALLOWED_INSTRUMENTS].join(',')}`);
console.log(`  [futuresTrading] Per-instrument caps (margin + $1K): ES=$${FUT_CAPITAL_CAP_PER_INSTRUMENT['ES']} NQ=$${FUT_CAPITAL_CAP_PER_INSTRUMENT['NQ']} MES=$${FUT_CAPITAL_CAP_PER_INSTRUMENT['MES']} MNQ=$${FUT_CAPITAL_CAP_PER_INSTRUMENT['MNQ']}`);
console.log(`  [futuresTrading] Micro-fallback: ES1!→MES1!, NQ1!→MNQ1! (auto-route when full margin > cap)`);
console.log(`  [futuresTrading] Overnight margins:  ES=$${FUT_OVERNIGHT_MARGIN['ES']} NQ=$${FUT_OVERNIGHT_MARGIN['NQ']} MES=$${FUT_OVERNIGHT_MARGIN['MES']} MNQ=$${FUT_OVERNIGHT_MARGIN['MNQ']} (allowed contracts = floor(cap / margin))`);
console.log(`  [futuresTrading] Max loss per trade: $${FUT_MAX_LOSS_PER_TRADE} (stop × pointValue × contracts)`);
console.log(`  [futuresTrading] Sizing floor: balance < $${parseFloat(process.env.FUT_SIZING_FLOOR_BALANCE || '10000').toFixed(0)} → 1 contract regardless of tier`);
console.log(`  [futuresTrading] Circuit breaker: ${CB_MAX_CLOSES}+ closes OR -$${CB_MAX_CUM_LOSS} cumulative in ${CB_WINDOW_MS/60000}min → ${CB_COOLDOWN_MIN}min auto-resume (${CB_TRIPS_BEFORE_HARD_HALT}+ trips in ${CB_HARD_HALT_WINDOW_MIN}min → hard halt)`);
console.log(`  [futuresTrading] tiers A=${TIER.A.contracts}c stop${TIER.A.stopPoints}pt tgt${TIER.A.targetPoints}pt | B=${TIER.B.contracts}c ${TIER.B.stopPoints}pt ${TIER.B.targetPoints}pt | C=${TIER.C.contracts}c ${TIER.C.stopPoints}pt ${TIER.C.targetPoints}pt`);
console.log(`  [futuresTrading] daily target +$${DAILY_TARGET} / hard stop -$${MAX_DAILY_LOSS} / Friday cap -$${FRIDAY_LOSS_CAP} / max ${MAX_TRADES_PER_DAY} trades/day`);
console.log(`  [futuresTrading] confluence window ${STACKING_WINDOW_MS/1000}s (same-dir 2nd+ → FUT_DUPLICATE_CONFLUENCE) | trail ${TRAIL_PCT}% | R-locks at +3R/+4R | whipsaw=${WHIPSAW_PROTECTION}`);
console.log(`  [futuresTrading] stop confirmation: ${STOP_CONFIRMATION.toUpperCase()} (slippage ±${FUT_STOP_SLIPPAGE_POINTS}pt on fire)`);
console.log(`  [futuresTrading] graduation threshold $${FUT_GRADUATION_THRESHOLD} (operator-explicit unlock for ES1!/NQ1!/MNQ1! when crossed)`);

if (!_evalTimer) {
  _evalTimer = setInterval(() => { try { evaluateOpenFutures(); } catch (e) { jError('FUT_EVAL_LOOP', e.message); } }, EVAL_POLL_MS);
  if (_evalTimer.unref) _evalTimer.unref();
}
