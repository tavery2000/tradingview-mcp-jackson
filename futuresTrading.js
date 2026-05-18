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

// Whipsaw inheritance from P1-5-A
const WHIPSAW_PROTECTION = (process.env.WHIPSAW_PROTECTION || 'true').toLowerCase() === 'true';
const STOP_CONFIRMATION  = (process.env.STOP_CONFIRMATION  || 'bar_close').toLowerCase();
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

// 2026-05-18 pre-RTH hot-fix (Mon 5/18 Task #0 partial): circuit breaker.
// Rolling 5-min window. Trips on >= 3 closes OR cumulative loss <= -$500.
// On trip: writes circuit-breaker-state.json + sets in-process halt flag.
// Operator clears via `ask> clear circuit breaker` (deletes state file)
// then restarts. Until cleared, all entries reject with CIRCUIT_BREAKER_TRIPPED.
const CB_WINDOW_MS         = 5 * 60_000;
const CB_MAX_CLOSES        = parseInt(process.env.CIRCUIT_BREAKER_MAX_CLOSES || '3', 10);
const CB_MAX_CUM_LOSS      = parseFloat(process.env.CIRCUIT_BREAKER_MAX_CUM_LOSS || '500');   // absolute, positive
let _circuitBreakerTripped = false;
let _circuitBreakerReason  = null;
const _recentCloses = [];   // [{ts, pnl}]

// On startup, restore tripped state from disk if present
try {
  if (existsSync(CIRCUIT_BREAKER_FILE)) {
    const s = JSON.parse(readFileSync(CIRCUIT_BREAKER_FILE, 'utf8'));
    if (s && s.tripped && !s.cleared) {
      _circuitBreakerTripped = true;
      _circuitBreakerReason  = s.reason || 'unknown (restored from state file)';
      console.log(`  ⛔ CIRCUIT BREAKER restored from disk: ${_circuitBreakerReason}`);
    }
  }
} catch {}

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
    _circuitBreakerTripped = true;
    _circuitBreakerReason  = trip;
    try {
      writeFileSync(CIRCUIT_BREAKER_FILE, JSON.stringify({
        tripped: true, cleared: false, reason: trip,
        trippedAt: new Date().toISOString(),
        trippedAtET: getETString(),
        windowMs: CB_WINDOW_MS,
        closeCount: count,
        cumulativeLoss: parseFloat(cumPnl.toFixed(2)),
        closes: _recentCloses.map(c => ({ ts: c.ts, et: new Date(c.ts).toLocaleString('en-US', { timeZone: 'America/New_York' }), pnl: c.pnl })),
      }, null, 2));
    } catch {}
    try { jAlert('critical', 'CIRCUIT_BREAKER_TRIPPED', { reason: trip, closeCount: count, cumulativeLoss: cumPnl }); } catch {}
    console.log(`\n  ⛔⛔⛔ CIRCUIT BREAKER TRIPPED — ${trip}`);
    console.log(`  ⛔ All futures entries BLOCKED until operator runs \`ask> clear circuit breaker\` + restart`);
    // Best-effort TTS via global hook if available
    if (typeof global.pushVoiceAlert === 'function') {
      try { global.pushVoiceAlert('circuit-breaker', 'critical', `Circuit breaker tripped. ${trip}. Futures trading halted.`, 0); } catch {}
    }
  }
}

export function isCircuitBreakerTripped() { return _circuitBreakerTripped; }
export function getCircuitBreakerReason() { return _circuitBreakerReason; }
export function clearCircuitBreaker() {
  _circuitBreakerTripped = false;
  _circuitBreakerReason  = null;
  _recentCloses.length   = 0;
  try { if (existsSync(CIRCUIT_BREAKER_FILE)) unlinkSync(CIRCUIT_BREAKER_FILE); } catch {}
  try { jAlert('info', 'CIRCUIT_BREAKER_CLEARED', { clearedAt: new Date().toISOString() }); } catch {}
  return true;
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

  // Same-direction stacking
  const stacked = _recentSignals.filter(s =>
    s.instrument === inst && s.direction === direction && s.ts >= cutoff
  );

  // Base tier from engine
  let tier;
  if (engine === 'LIVE')                                        tier = 'C';
  else if (engine === 'HTF')                                    tier = 'A';
  else if (['HL','LH','BUY','SELL','ZONE'].includes(engine))    tier = 'B';
  else                                                          tier = 'B';

  // Aggressive stacking upgrade: 1 same-direction in 60s window upgrades by one
  if (stacked.length >= 1) {
    if (tier === 'C') tier = 'B';
    else if (tier === 'B') tier = 'A';
    // A stays at A (max)
  }

  return { tier, stacked: stacked.length };
}

// ─── Place order (entry path) ──────────────────────────────────────────

export function placeFuturesOrder(consensus, requestId) {
  const inst = (consensus.instrument || '').toUpperCase();
  const direction = consensus.signal;   // CALLS | PUTS

  // 2026-05-17 EOD: PATH2_HALT global circuit-breaker (manual env flag).
  if ((process.env.PATH2_HALT || 'false').toLowerCase() === 'true') {
    const reason = 'PATH2_HALT — futures execution halted by operator; see Mon 5/18 Task #0 gate audit';
    futuresOrderGate.markVetoed(requestId, reason);
    jGateBlock(consensus.engine, inst, direction, 'PATH2_HALT', { instrument: inst, direction, engine: consensus.engine });
    console.log(`  🛑 PATH2_HALT — rejecting ${inst} ${direction} ${consensus.engine}`);
    return { vetoed: true, reason };
  }
  // 2026-05-18 pre-RTH hot-fix: auto-halt when circuit breaker tripped
  if (_circuitBreakerTripped) {
    const reason = `CIRCUIT_BREAKER_TRIPPED — ${_circuitBreakerReason}`;
    futuresOrderGate.markVetoed(requestId, reason);
    jGateBlock(consensus.engine, inst, direction, 'CIRCUIT_BREAKER_TRIPPED', { reason: _circuitBreakerReason });
    console.log(`  ⛔ CIRCUIT_BREAKER — rejecting ${inst} ${direction} ${consensus.engine}`);
    return { vetoed: true, reason };
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
  const { tier, reason: tierReason, opposite, stacked } = _resolveTier(consensus);
  if (tier === null) {
    futuresOrderGate.markVetoed(requestId, tierReason);
    jGateBlock(consensus.engine, inst, direction, 'FUT_CONFLICT_BLOCKED', { opposite });
    return { vetoed: true, reason: tierReason };
  }
  const tierCfg = TIER[tier];
  // 2026-05-18 pre-RTH hot-fix (Mon 5/18 Task #0 partial): hardcoded
  // sizing floor. Sub-$5K accounts get 1 contract regardless of tier,
  // bypassing the cascade-vulnerable tier sizing. Root cause of Sun 5/17
  // 20:04-20:06 ET catastrophic failure was Tier B 3-contract entries
  // on a $520 account. Full audit per docs/MONDAY_5_18_TASK_ZERO_GATE_AUDIT.md.
  const _balanceForSizing = ledger.balance || 0;
  let contracts = tierCfg.contracts;
  let sizingFloorApplied = false;
  if (_balanceForSizing < 5000 && contracts > 1) {
    sizingFloorApplied = true;
    console.log(`  ⚠ SIZE_FLOOR_1_CONTRACT — balance $${_balanceForSizing.toFixed(0)} < $5K, overriding tier ${tier} (${tierCfg.contracts}c → 1c)`);
    try { jAlert('warning', 'SIZE_FLOOR_1_CONTRACT', { balance: _balanceForSizing, tierAttempted: tier, tierContracts: tierCfg.contracts, override: 1 }); } catch {}
    contracts = 1;
  }
  const stopPoints = tierCfg.stopPoints;
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

    // 1. Stop check (with whipsaw bar-close confirmation)
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
        try { closeFuturesPosition(t.requestId, liveU, exitReason); } catch (e) { jError('FUT_EXIT_FIRE', e.message); }
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

console.log(`  [futuresTrading] mode=${FUTURES_TRADING_MODE} balance=$${ledger.balance.toFixed(0)} instruments=${[...ALLOWED_INSTRUMENTS].join(',')}`);
console.log(`  [futuresTrading] tiers A=${TIER.A.contracts}c stop${TIER.A.stopPoints}pt tgt${TIER.A.targetPoints}pt | B=${TIER.B.contracts}c ${TIER.B.stopPoints}pt ${TIER.B.targetPoints}pt | C=${TIER.C.contracts}c ${TIER.C.stopPoints}pt ${TIER.C.targetPoints}pt`);
console.log(`  [futuresTrading] daily target +$${DAILY_TARGET} / hard stop -$${MAX_DAILY_LOSS} / Friday cap -$${FRIDAY_LOSS_CAP} / max ${MAX_TRADES_PER_DAY} trades/day`);
console.log(`  [futuresTrading] stacking ${STACKING_WINDOW_MS/1000}s window (aggressive) | trail ${TRAIL_PCT}% | R-locks at +3R/+4R | whipsaw=${WHIPSAW_PROTECTION}`);
console.log(`  [futuresTrading] graduation threshold $${FUT_GRADUATION_THRESHOLD} (operator-explicit unlock for ES1!/NQ1!/MNQ1! when crossed)`);

if (!_evalTimer) {
  _evalTimer = setInterval(() => { try { evaluateOpenFutures(); } catch (e) { jError('FUT_EVAL_LOOP', e.message); } }, EVAL_POLL_MS);
  if (_evalTimer.unref) _evalTimer.unref();
}
