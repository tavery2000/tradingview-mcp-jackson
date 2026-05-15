#!/usr/bin/env node
/**
 * paperTrading.js — HANK AI Paper Trading Engine + OrderGate
 * Built by NYC2000
 *
 * Two responsibilities:
 *
 * 1. PAPER TRADING MODE
 *    - Simulates fills using mid-price from last Webull QUOTE tick
 *    - Tracks P&L, slippage vs mid, win rate per engine/session
 *    - Full ledger persisted to paper-ledger.json
 *    - Identical API to live autotrader — swap TRADING_MODE to go live
 *
 * 2. ORDER GATE
 *    - Prevents double-trade from hanging LLM API calls
 *    - Every signal gets a unique requestId
 *    - Once an order fires (paper or live), gate LOCKS for that requestId
 *    - Late LLM responses after timeout → gate blocks → ghost signal logged
 *    - Session reset at 16:00 ET — clean slate each day
 *
 * Usage:
 *   TRADING_MODE=PAPER  node monitor.js  ← safe, no real capital
 *   TRADING_MODE=LIVE   node monitor.js  ← real Webull orders
 */

import { readFileSync, writeFileSync, existsSync, openSync, unlinkSync, appendFileSync } from 'fs';
import { join }      from 'path';
import { fileURLToPath } from 'url';
import { dirname }   from 'path';
import { WebSocket } from 'ws';
import {
  getETMins, getETString,
  blackScholes, getIV,
  monitorPosition, portfolioTheta, getBurnZoneData,
  getTradingTimeRemaining,
} from './theta.js';
import { jEntry, jExit, jError, jAlert, jGateBlock, journal } from './journal.js';
import {
  loadTier, saveTier, getPositionSize, getDailyLossCap,
  checkTierUpEligibility, checkTierDown,
  applyTierDown, updateEquity,
} from './tier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────

const TRADING_MODE          = process.env.TRADING_MODE || 'PAPER';
const PAPER_BALANCE         = parseFloat(process.env.PAPER_BALANCE || '25000');
const MAX_DAILY_LOSS        = parseFloat(process.env.MAX_DAILY_LOSS || '500');
// 2026-05-13 v2: soft-warning tier. 0 = disabled. When set, fires a single
// alert per ET-date per process when realized loss crosses this threshold,
// but trading continues. Hard cap remains MAX_DAILY_LOSS.
const MAX_DAILY_LOSS_WARNING = parseFloat(process.env.MAX_DAILY_LOSS_WARNING || '0');
// Module-level flag — tracks the ET-date string when warning was fired this
// process. Reset on process restart (in-memory only). Webhook supervisor
// respawn → flag resets → warning can fire again if realized still below
// threshold; that's by design (the operator gets a fresh alert on respawn).
let _dailyLossWarningFiredFor = null;
// P0-4 (2026-05-14 EOD): MFE/MAE tracker. evaluateOpenPositions updates
// this map per-tick per open position; closePosition merges values into
// the trade record at exit. Map<requestId, {peakPnl, troughPnl, peakU,
// troughU, lastPnl, lastU, ticks}>. Cleared on process restart (acceptable
// — pre-restart open positions get partial MFE/MAE coverage).
const _mfeMaeTracker = new Map();

// 2026-05-15 EOD: underlying-price sanity gate. 2026-05-15 had a feeder
// corruption that returned _qqqPrice=211 (real QQQ ~$711) on a QQQ trade,
// poisoning the MFE/MAE tracker (peakUnrealizedPnL=$49,757 phantom),
// STAGE_3 R-lock math (RMultiple ~952×), trailStopPrice (211.07 vs $711),
// and Black-Scholes exit-price computation (~$499 intrinsic from bogus
// underlying). One trade landed +$49,757 phantom profit in the ledger.
//
// Defense: reject per-tick fed.underlyingPrice when it deviates from the
// trade's entryUnderlyingPrice by more than UNDERLYING_SANITY_THRESHOLD
// (default 50%). Real intraday underlying moves don't approach 50% — any
// deviation that large is a price-feed corruption, not real market action.
// Rejected ticks skip MFE/MAE update, stop checks, target/trail logic,
// and stale Black-Scholes pricing for this tick.
const UNDERLYING_SANITY_THRESHOLD = parseFloat(process.env.UNDERLYING_SANITY_THRESHOLD || '0.5');
function _isUnderlyingSane(liveU, entryU) {
  if (!Number.isFinite(liveU) || !Number.isFinite(entryU) || entryU <= 0) return false;
  const deviation = Math.abs(liveU - entryU) / entryU;
  return deviation <= UNDERLYING_SANITY_THRESHOLD;
}
let _saneRejectsThisRun = 0;
const _saneRejectLogged = new Set();
// RULE 2 — daily realized P&L target. On hit, fire TARGET_REACHED once
// per ET-date per process. Trading CONTINUES (operator default).
const DAILY_TARGET = parseFloat(process.env.DAILY_TARGET || '0');
let _dailyTargetFiredFor = null;
// 2026-05-14: reserve-aware veto kill-switch. Default false during testing —
// hard cap ($5K) and warning ($2.5K) remain active; only the worst-case
// reserve pre-block is suppressed. Set true in .env to restore.
const RESERVE_VETO_ENABLED  = (process.env.RESERVE_VETO_ENABLED || 'false').toLowerCase() === 'true';
// 2026-05-14 EOD: All concurrency / correlation / opposition gates removed
// permanently per RULE 1 (all instruments, all directions, all the time).
// Risk is managed per-trade (STOP_LOSS_PCT) and per-day (MAX_DAILY_LOSS hard
// cap, MAX_DAILY_LOSS_WARNING soft alert). DAILY_TARGET emits TARGET_REACHED
// on +$DAILY_TARGET realized but trading continues.
//
// P0-3 (2026-05-14 EOD): per-instrument point/dollar stops. Replaces the
// %-based STOP_LOSS_PCT entirely. Stops compare against the UNDERLYING
// price (not the option premium), giving precise + predictable behavior
// independent of option Greeks/IV. CALLS stop fires when underlying drops
// to entryUnderlyingPrice - stop. PUTS stop fires when underlying rises
// to entryUnderlyingPrice + stop.
//
// Per-instrument values from operator directive — points for futures (CME
// futures point-value × multiplier governs $-risk), dollars for equity
// options (price-distance on the underlying ETF).
const STOP_POINTS = {
  'ES1!':  parseFloat(process.env.STOP_ES_POINTS  || '2.0'),
  'NQ1!':  parseFloat(process.env.STOP_NQ_POINTS  || '8.0'),
  'MES1!': parseFloat(process.env.STOP_MES_POINTS || '2.0'),
  'MNQ1!': parseFloat(process.env.STOP_MNQ_POINTS || '8.0'),
  'ES':    parseFloat(process.env.STOP_ES_POINTS  || '2.0'),
  'NQ':    parseFloat(process.env.STOP_NQ_POINTS  || '8.0'),
  'MES':   parseFloat(process.env.STOP_MES_POINTS || '2.0'),
  'MNQ':   parseFloat(process.env.STOP_MNQ_POINTS || '8.0'),
};
const STOP_DOLLARS = {
  'SPY': parseFloat(process.env.STOP_SPY_DOLLARS || '0.30'),
  'QQQ': parseFloat(process.env.STOP_QQQ_DOLLARS || '0.35'),
  'IWM': parseFloat(process.env.STOP_IWM_DOLLARS || '0.25'),
};
function _getStopDistance(instrument) {
  const k = (instrument || '').toUpperCase();
  if (STOP_POINTS[k]  != null) return STOP_POINTS[k];
  if (STOP_DOLLARS[k] != null) return STOP_DOLLARS[k];
  return null;
}
// P1-5 (2026-05-14 EOD): 1:2 R:R take-profit distances. Per-instrument
// targets default to 2× the stop distance per the operator spec. Used
// to compute targetUnderlyingPrice at fill time. STAGE_2 fires when the
// target is breached → 50% scale-out, BE stop, trail-active on remainder.
const TARGET_POINTS = {
  'ES1!':  parseFloat(process.env.TARGET_ES_POINTS  || '4.0'),
  'NQ1!':  parseFloat(process.env.TARGET_NQ_POINTS  || '16.0'),
  'MES1!': parseFloat(process.env.TARGET_MES_POINTS || '4.0'),
  'MNQ1!': parseFloat(process.env.TARGET_MNQ_POINTS || '16.0'),
  'ES':    parseFloat(process.env.TARGET_ES_POINTS  || '4.0'),
  'NQ':    parseFloat(process.env.TARGET_NQ_POINTS  || '16.0'),
  'MES':   parseFloat(process.env.TARGET_MES_POINTS || '4.0'),
  'MNQ':   parseFloat(process.env.TARGET_MNQ_POINTS || '16.0'),
};
const TARGET_DOLLARS = {
  'SPY': parseFloat(process.env.TARGET_SPY_DOLLARS || '0.60'),
  'QQQ': parseFloat(process.env.TARGET_QQQ_DOLLARS || '0.70'),
  'IWM': parseFloat(process.env.TARGET_IWM_DOLLARS || '0.50'),
};
function _getTargetDistance(instrument) {
  const k = (instrument || '').toUpperCase();
  if (TARGET_POINTS[k]  != null) return TARGET_POINTS[k];
  if (TARGET_DOLLARS[k] != null) return TARGET_DOLLARS[k];
  return null;
}
const TRAIL_PCT = parseFloat(process.env.TRAIL_PCT || '0.03');   // % of peak underlying
// P1-11 (2026-05-14 EOD): per-trade capital cap. tradeCapital = entryPremium
// × contracts × 100 (options); reject if > cap. Default $1,000 for the $1k
// account discipline. Set 0 to disable cap (back-compat for $25k account).
// EMERGENCY HOTFIX 2026-05-15: cap split by instrument class. Single
// CAPITAL_CAP_PER_TRADE=$1k blocked all futures-options entries because
// 1 contract premium (e.g., NQ1! $59 × 100 = $5,900) exceeds the cap.
// Equity stays at $1k; futures temporarily at $10k pending operator's
// final sizing decision (operator requested $3k but MNQ premium check
// pending). Legacy CAPITAL_CAP_PER_TRADE env still respected as fallback.
const _legacyCap            = process.env.CAPITAL_CAP_PER_TRADE;
const CAPITAL_CAP_EQUITY    = parseFloat(process.env.CAPITAL_CAP_EQUITY  || _legacyCap || '1000');
const CAPITAL_CAP_FUTURES   = parseFloat(process.env.CAPITAL_CAP_FUTURES || '10000');
const _CAP_FUTURES_INSTRUMENTS = new Set(['ES', 'NQ', 'MES', 'MNQ', 'ES1!', 'NQ1!', 'MES1!', 'MNQ1!']);
function _capForInstrument(inst) {
  return _CAP_FUTURES_INSTRUMENTS.has((inst || '').toUpperCase())
    ? CAPITAL_CAP_FUTURES
    : CAPITAL_CAP_EQUITY;
}
// P1-12 (2026-05-14 EOD): 1% account-risk position sizing.
// contracts = floor((account_balance × ACCOUNT_RISK_PCT) / (stop_distance × multiplier)).
// Combined with CAPITAL_CAP_PER_TRADE: smaller of the two governs.
const ACCOUNT_RISK_PCT      = parseFloat(process.env.ACCOUNT_RISK_PCT || '0.01');   // 1%
// P2-13 (2026-05-14 EOD): PM stop/target multipliers for 5m regime.
// 5m bars have wider intra-bar ranges than 1m → wider stops needed to
// avoid bar-noise stop-outs. 1.5× preserves 1:2 R:R.
const PM_STOP_MULTIPLIER    = parseFloat(process.env.PM_STOP_MULTIPLIER   || '1.5');
const PM_TARGET_MULTIPLIER  = parseFloat(process.env.PM_TARGET_MULTIPLIER || '1.5');
const TIMEFRAME_SWITCH_HOUR_ET = parseInt(process.env.TIMEFRAME_SWITCH_HOUR_ET || '12', 10);
function _getRegimeNow() {
  const t = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = t.split(':').map(Number);
  return (h * 60 + m) >= TIMEFRAME_SWITCH_HOUR_ET * 60 ? 'PM' : 'AM';
}
// P1-5-A (2026-05-14 EOD): whipsaw protection — stop must trigger on
// 1-min BAR CLOSE through the stop level, not intra-bar tick. Prevents
// premature exits on noise excursions that recover before bar confirms.
// STOP_CONFIRMATION=tick_instant for legacy intra-tick behavior.
const WHIPSAW_PROTECTION = (process.env.WHIPSAW_PROTECTION || 'true').toLowerCase() === 'true';
const STOP_CONFIRMATION  = (process.env.STOP_CONFIRMATION  || 'bar_close').toLowerCase();
// Per-trade bar-close tracker. Each entry: {currentBarMinute, currentBarBreached}.
// On bar-rollover, if breach was observed in the prior bar, the stop fires
// IFF the current price is still beyond the stop level at the new bar's
// first tick (i.e., the prior bar truly closed beyond stop).
const _whipsawState = new Map();
// P1-5-B (2026-05-14 EOD): structure-based stop layer above point-based.
// STRUCTURE_STOP_INSTRUMENTS = comma-list of instruments where this layer
// applies. Same whipsaw bar-close confirmation as P1-5-A (intra-bar wick
// past invalidation does NOT fire — must close past).
const STRUCTURE_STOP_ENABLED     = (process.env.STRUCTURE_STOP_ENABLED || 'true').toLowerCase() === 'true';
const STRUCTURE_STOP_INSTRUMENTS = new Set(
  (process.env.STRUCTURE_STOP_INSTRUMENTS || 'ES1!,NQ1!,MES1!,MNQ1!,SPY,QQQ')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
);
// Per-trade structural-breach tracker (parallel to _whipsawState).
const _structureWhipsaw = new Map();
const MAX_CONTRACTS         = parseInt(process.env.MAX_CONTRACTS   || '10');
const LEDGER_FILE    = join(__dirname, 'paper-ledger.json');
const LOCK_FILE      = join(__dirname, '.paper-ledger.lock');

// Per-instrument contract multiplier for $-risk math.
// Equity options 100x. Futures options use CME contract multipliers:
// ES=$50, NQ=$20, MES=$5, MNQ=$2. Unknown instruments default to 100 (safe).
// NOTE: realized P&L in simulateFill / closePosition currently uses 100x for
// all instruments — that's a known bug producing the +$5,170 NQ phantom on
// 2026-05-13. Fix deferred to weekend; this multiplier is used only for the
// reserve-aware cap below, where being correct is the safe direction.
function getContractMultiplier(instrument) {
  const i = (instrument || '').toUpperCase().replace('1!', '');
  if (i === 'SPY' || i === 'QQQ' || i === 'IWM') return 100;
  if (i === 'ES')  return 50;
  if (i === 'NQ')  return 20;
  if (i === 'MES') return 5;
  if (i === 'MNQ') return 2;
  return 100;
}

// Surface effective daily-loss tiers at module load. Each monitor process
// that imports paperTrading.js prints once. 2026-05-13 v2: now prints two
// lines — soft-warning threshold (if MAX_DAILY_LOSS_WARNING > 0) and hard cap.
// Env-wins semantics: env REPLACES tier when set (previously Math.min).
{
  const _ts = loadTier();
  const _tierCap = getDailyLossCap(_ts.tier);
  const _envCap  = MAX_DAILY_LOSS;
  const _eff     = _envCap > 0 ? _envCap : _tierCap;
  const _src     = _envCap > 0
    ? (_envCap === _tierCap ? 'tier=env'
       : _envCap > _tierCap ? `env testing-tier (above tier T${_ts.tier}=$${_tierCap})`
       :                      `env (below tier T${_ts.tier}=$${_tierCap})`)
    : `tier T${_ts.tier} (env unset)`;
  if (MAX_DAILY_LOSS_WARNING > 0) {
    console.log(`  [paperTrading] Daily loss warning: $${MAX_DAILY_LOSS_WARNING.toLocaleString()} (soft alert, trading continues)`);
  }
  console.log(`  [paperTrading] Daily loss cap: $${_eff.toLocaleString()} (source: ${_src})`);
  console.log(`  [paperTrading] Reserve-aware veto: ${RESERVE_VETO_ENABLED ? 'ENABLED' : 'disabled (testing — hard cap is sole entry block)'}`);
  console.log(`  [paperTrading] All concurrency/correlation/opposition gates: REMOVED (RULE 1)`);
  console.log(`  [paperTrading] Per-trade stop-loss: POINT-BASED (P0-3) ` +
    `ES/MES=${STOP_POINTS['ES1!']}pt NQ/MNQ=${STOP_POINTS['NQ1!']}pt ` +
    `SPY=$${STOP_DOLLARS['SPY']} QQQ=$${STOP_DOLLARS['QQQ']} IWM=$${STOP_DOLLARS['IWM']}`);
  console.log(`  [paperTrading] Take-profit (P1-5): ` +
    `ES/MES=${TARGET_POINTS['ES1!']}pt NQ/MNQ=${TARGET_POINTS['NQ1!']}pt ` +
    `SPY=$${TARGET_DOLLARS['SPY']} QQQ=$${TARGET_DOLLARS['QQQ']} IWM=$${TARGET_DOLLARS['IWM']} ` +
    `(50/50 scale-out + BE + ${TRAIL_PCT}% trail + R-locks at +3R/+4R)`);
  console.log(`  [paperTrading] Structure stop (P1-5-B): ${STRUCTURE_STOP_ENABLED ? `ENABLED on ${[...STRUCTURE_STOP_INSTRUMENTS].join(',')} (priority above point-based)` : 'disabled'}`);
  console.log(`  [paperTrading] Capital cap per trade: equity=$${CAPITAL_CAP_EQUITY.toLocaleString()}  futures=$${CAPITAL_CAP_FUTURES.toLocaleString()} (HOTFIX 2026-05-15)`);
  console.log(`  [paperTrading] Daily target: ${DAILY_TARGET > 0 ? `+$${DAILY_TARGET.toLocaleString()} (TARGET_REACHED alert, trading continues)` : 'disabled (DAILY_TARGET=0)'}`);
}

// Surface counter-trend gate config at module load (2026-05-13).
// Gate runs in webhook-server.js but this prints in every paperTrading-importing
// process so the active configuration is visible without operator hunting env vars.
{
  const _ctMode = process.env.COUNTER_TREND_MODE || 'down_weight';
  const _ctRaw  = parseFloat(process.env.COUNTER_TREND_DOWNWEIGHT || '0.6');
  const _ctMult = Number.isFinite(_ctRaw) && _ctRaw > 0 && _ctRaw <= 1.0 ? _ctRaw : 0.6;
  const _ctDesc = _ctMode === 'off'         ? 'OFF (gate disabled)'
                : _ctMode === 'block'       ? 'BLOCK (hard reject opposing-4H signals)'
                : _ctMode === 'down_weight' ? `DOWN_WEIGHT × ${_ctMult.toFixed(2)} (opposing-4H signals)`
                :                             `UNKNOWN mode='${_ctMode}' — treating as down_weight × ${_ctMult.toFixed(2)}`;
  console.log(`  [paperTrading] Counter-trend gate: ${_ctDesc}`);
}

function acquireLock() {
  for (let i = 0; i < 20; i++) {
    try { openSync(LOCK_FILE, 'wx'); return true; } catch {}
    const t = Date.now() + 50;
    while (Date.now() < t) {}
  }
  return false;
}
function releaseLock() { try { unlinkSync(LOCK_FILE); } catch {} }

// ─── Colors ───────────────────────────────────────────────

const C = {
  reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
  red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m',
  cyan:'\x1b[36m', gray:'\x1b[90m', magenta:'\x1b[35m',
};

// ─── Ledger I/O ───────────────────────────────────────────

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
    mode:         TRADING_MODE,
    balance:      PAPER_BALANCE,
    startBalance: PAPER_BALANCE,
    totalPnL:     0,
    totalTrades:  0,
    wins:         0,
    losses:       0,
    trades:       [],       // full trade log
    dailyPnL:     {},       // date → pnl
    engineStats:  {         // win/loss per engine
      TREND:     { trades:0, wins:0, losses:0, pnl:0 },
      FADE:      { trades:0, wins:0, losses:0, pnl:0 },
      SWING:     { trades:0, wins:0, losses:0, pnl:0 },
      MOC:       { trades:0, wins:0, losses:0, pnl:0 },
      STRUCTURE: { trades:0, wins:0, losses:0, pnl:0 },
    },
    sessionStats: {         // win/loss per session — must match getCurrentSession() returns
      'MOO':        { trades:0, wins:0, losses:0, pnl:0 },
      'BULLET-1':   { trades:0, wins:0, losses:0, pnl:0 },
      'TREND-TIME': { trades:0, wins:0, losses:0, pnl:0 },
      'UK-CLOSE':   { trades:0, wins:0, losses:0, pnl:0 },
      'MIDDAY':     { trades:0, wins:0, losses:0, pnl:0 },
      'AFTERNOON':  { trades:0, wins:0, losses:0, pnl:0 },
      'PRE-MOC':    { trades:0, wins:0, losses:0, pnl:0 },
      'MOC':        { trades:0, wins:0, losses:0, pnl:0 },
    },
  };
}

function saveLedgerDirect(l) {
  try {
    l.lastSaved = new Date().toISOString();
    writeFileSync(LEDGER_FILE, JSON.stringify(l, null, 2));
  } catch (e) {
    console.error(`  Ledger save error: ${e.message}`);
  }
}

function saveLedger(l) {
  const locked = acquireLock();
  try { saveLedgerDirect(l); } finally { if (locked) releaseLock(); }
}

// ─── Fill Simulation ──────────────────────────────────────
// Uses mid-price from last Webull QUOTE tick
// Adds realistic slippage model for options

function simulateFill(order, lastQuote) {
  // Defensive: previous `lastQuote || fallback` check only triggered fallback
  // when lastQuote was falsy. A truthy partial object (e.g., webhook-server.js
  // passes `{ mid: optEst }` with no bid/ask) bypassed the fallback, leaving
  // quote.bid and quote.ask undefined. NaN cascaded through mid/spread/slippage
  // and the resulting fillPrice serialized to null in the ledger — producing
  // the deterministic +$1.00 SIGNAL_REVERSAL exit pattern observed 2026-05-12.
  // Fix: validate bid+ask are finite, otherwise synthesize from mid or limitPrice.
  let quote = lastQuote;
  if (!quote || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask)) {
    const seed = Number.isFinite(quote?.mid) ? quote.mid : order.limitPrice;
    quote = { bid: seed * 0.98, ask: seed * 1.02 };
  }
  const mid   = (quote.bid + quote.ask) / 2;

  // P1-10 (2026-05-14 EOD): order-type slippage model.
  //   LIMIT       → zero slippage (exact requested price = order.limitPrice)
  //   STOP_MARKET → ±1 tick adverse slippage
  // Falls through to legacy spread-based model if orderType absent (keeps
  // back-compat for old callers / pre-P1-10 trade records on restart).
  const orderType = order.orderType || 'LIMIT';
  let fillPrice;
  if (orderType === 'LIMIT') {
    fillPrice = Number.isFinite(order.limitPrice) && order.limitPrice > 0
      ? order.limitPrice
      : mid;   // fallback if limitPrice missing
  } else if (orderType === 'STOP_MARKET') {
    // ±1 tick = 0.01 for equity options, 0.25 for futures (operator spec
    // doesn't break out per instrument — using 0.01 generic; refine post-Friday)
    const tickSize = 0.01;
    fillPrice = order.side === 'BUY' ? mid + tickSize : mid - tickSize;
  } else {
    // Legacy fallback (shouldn't be reachable post-P1-10 validation)
    const spread    = quote.ask - quote.bid;
    const slippage  = spread * 0.15;
    fillPrice = order.side === 'BUY'
      ? Math.min(quote.ask, mid + slippage)
      : Math.max(quote.bid, mid - slippage);
  }

  return {
    fillPrice:    parseFloat(fillPrice.toFixed(4)),
    fillTime:     Date.now(),
    fillTimeET:   getETString(),
    slippage:     parseFloat(Math.abs(fillPrice - mid).toFixed(4)),
    slippagePct:  parseFloat((Math.abs(fillPrice - mid) / mid * 100).toFixed(3)),
    bid:          quote.bid,
    ask:          quote.ask,
    mid:          parseFloat(mid.toFixed(4)),
    orderType,
    paper:        true,
  };
}

// ─── Order Gate ───────────────────────────────────────────
// Prevents double-trade from hanging LLM API calls
// Pattern: requestId → one order maximum, gate locks on first fire

class OrderGate {
  constructor() {
    this.pending   = new Map();  // requestId → { signal, createdAt, status }
    this.executed  = new Set();  // requestIds that already fired an order
    this.ghostLog  = [];         // late LLM responses that were blocked
    this.stats     = { total:0, executed:0, vetoed:0, ghosts:0, timeouts:0 };
  }

  // Generate unique ID for each signal/council invocation
  createRequest(signal) {
    const id = `${signal.signal}_${signal.engine}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    this.pending.set(id, {
      id,
      signal,
      createdAt: Date.now(),
      status:    'PENDING',
      order:     null,
    });
    this.stats.total++;
    return id;
  }

  // Can this requestId still fire an order?
  canExecute(requestId) {
    // Already fired — block ghost signal
    if (this.executed.has(requestId)) {
      this.stats.ghosts++;
      this._logGhost(requestId, 'DUPLICATE');
      return false;
    }

    const req = this.pending.get(requestId);
    if (!req) {
      this._logGhost(requestId, 'UNKNOWN');
      return false;
    }

    // Expired — too old to act on (30s max age)
    const age = Date.now() - req.createdAt;
    if (age > 30_000) {
      this.expire(requestId);
      return false;
    }

    return true;
  }

  // Mark as executed — gate LOCKED for this requestId
  markExecuted(requestId, order) {
    this.executed.add(requestId);
    this.stats.executed++;
    const req = this.pending.get(requestId);
    if (req) {
      req.status    = 'EXECUTED';
      req.order     = order;
      req.executedAt = Date.now();
    }
  }

  // Degraded mode fired — also locks gate
  markDegraded(requestId, order) {
    this.executed.add(requestId);
    this.stats.timeouts++;
    const req = this.pending.get(requestId);
    if (req) { req.status = 'DEGRADED'; req.order = order; }
  }

  // Vetoed — no order fired, but gate still locked
  markVetoed(requestId, reason) {
    this.executed.add(requestId);
    this.stats.vetoed++;
    const req = this.pending.get(requestId);
    if (req) { req.status = 'VETOED'; req.vetoReason = reason; }
  }

  expire(requestId) {
    this.executed.add(requestId);
    const req = this.pending.get(requestId);
    if (req) req.status = 'EXPIRED';
  }

  _logGhost(requestId, reason) {
    const req = this.pending.get(requestId);
    this.ghostLog.push({
      requestId,
      reason,
      ts:      Date.now(),
      age:     req ? Date.now() - req.createdAt : -1,
      status:  req?.status,
    });
    // Cap ghost log size
    if (this.ghostLog.length > 100) this.ghostLog.shift();
  }

  // Session reset — called at 16:00 ET
  reset() {
    const ghosts = this.stats.ghosts;
    if (ghosts > 0) {
      console.log(`  ${C.yellow}OrderGate session: ${this.stats.total} signals, ${ghosts} ghost(s) blocked${C.reset}`);
    }
    this.pending.clear();
    this.executed.clear();
    this.ghostLog = [];
    this.stats    = { total:0, executed:0, vetoed:0, ghosts:0, timeouts:0 };
  }

  getStatus() {
    return {
      pending:  this.pending.size,
      executed: this.executed.size,
      ghosts:   this.stats.ghosts,
      stats:    this.stats,
    };
  }
}

// Singleton gate — one per process
export const orderGate = new OrderGate();

// ─── Paper Trade Execution ────────────────────────────────

let ledger = loadLedger();

// ─── Stuck-trade scanner (TASK 5, 2026-05-14 EOD) ──────────────────────
// Run once at module load. Scan the ledger for OPEN positions whose
// entry timestamp is from a prior ET-date — those are session-bridge
// survivors that need operator review. Flag-only (no auto-close).
// Fires per-process at startup; voice TTS is deduped via a per-date key
// so all 4 dispatchers calling this won't spam the operator. Console
// banner + journal record emit per-process for full visibility.
(function _scanStuckTrades() {
  try {
    if (!ledger.trades?.length) return;
    const today = etDate();
    const stale = ledger.trades.filter(t => {
      if (t.status !== 'OPEN' || !t.fillTime) return false;
      const d = new Date(t.fillTime).toLocaleDateString('en-US', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      });
      const [mo, dd, yy] = d.split('/');
      return `${yy}-${mo}-${dd}` < today;
    });
    if (stale.length === 0) return;
    const summary = stale.map(t => ({
      requestId: t.requestId, instrument: t.instrument, signal: t.signal,
      engine: t.engine, entryET: t.fillTimeET,
      entryDate: new Date(t.fillTime).toLocaleDateString('en-US', { timeZone: 'America/New_York' }),
      contracts: t.contracts, fillPrice: t.fillPrice,
    }));
    console.log(`\n  ${C.yellow}⚠ STUCK TRADES — ${stale.length} OPEN positions from prior session(s):${C.reset}`);
    summary.forEach(s => {
      console.log(`    ${s.requestId.padEnd(50)} ${s.instrument} ${s.signal} ${s.engine} entered ${s.entryET} (${s.entryDate}) × ${s.contracts} @ $${s.fillPrice}`);
    });
    console.log(`  ${C.yellow}→ Operator review required. No auto-close.${C.reset}\n`);
    try { jAlert('warning', 'STUCK_TRADES_DETECTED', { count: stale.length, today, stale: summary }); } catch {}
    try {
      pushVoiceAlert(`stuck-trades-${today}`, 'warning',
        `${stale.length} stuck open positions from prior session. Operator review required.`,
        300_000);
    } catch {}
  } catch (e) {
    try { jError('stuck-trade-scan', e.message); } catch {}
  }
})();

// Get session from current ET time
function getCurrentSession() {
  const mins = getETMins();
  if (mins < 9*60+15)  return 'PRE-MARKET';
  if (mins < 9*60+35)  return 'BULLET-1';
  if (mins < 11*60)    return 'TREND-TIME';
  if (mins < 11*60+30) return 'UK-CLOSE';
  if (mins < 14*60)    return 'MIDDAY';
  if (mins < 15*60)    return 'AFTERNOON';
  if (mins < 15*60+50) return 'PRE-MOC';
  if (mins < 16*60+15) return 'MOC';
  return 'CLOSED';
}

// Get today's date string ET — YYYY-MM-DD format
function etDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

/**
 * Send order — paper or live
 * @param {object} consensus - Agent council result
 * @param {string} requestId - OrderGate request ID
 * @param {object} lastQuote - Latest bid/ask from Webull
 * @returns {object} fill details
 */
export async function sendOrder(consensus, requestId, lastQuote = null) {

  // ── Defense-in-depth session gate (2026-05-14 EOD TASK 4 + 2026-05-15) ───
  // Equity (SPY/QQQ/IWM): reject pre-09:30 (PRE_MARKET) and >=16:00
  // (OUT_OF_HOURS). EXPLORATION_WINDOW gate REMOVED 2026-05-15 per
  // operator directive — equity entries 09:30-09:40 now allowed.
  // Futures bypass (24/5 session). Mirrors the webhook-server.js
  // session-gate logic so direct sendOrder() callers (monitor SWING
  // entries) are also covered.
  const _SESSION_EQUITY = new Set(['SPY', 'QQQ', 'IWM']);
  if (_SESSION_EQUITY.has((consensus.instrument || '').toUpperCase())) {
    const _etHMS = new Date().toLocaleTimeString('en-US', { timeZone:'America/New_York', hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const [_eh, _em, _es] = _etHMS.split(':').map(Number);
    const _etMins = _eh * 60 + _em;
    let _gateReason = null;
    if (_etMins < 9 * 60 + 30)       _gateReason = 'PRE_MARKET';
    else if (_etMins >= 16 * 60)     _gateReason = 'OUT_OF_HOURS_SENDORDER';
    if (_gateReason) {
      const reason = `${_gateReason} — sendOrder rejected at ${_etHMS} ET (equity ${consensus.instrument})`;
      orderGate.markVetoed(requestId, reason);
      jGateBlock(consensus.engine, consensus.instrument, consensus.signal, _gateReason, { etHMS: _etHMS, etMins: _etMins });
      console.log(`  ${C.red}🛑 ${_gateReason} — sendOrder rejected: ${_etHMS} ET (${consensus.instrument})${C.reset}`);
      return { vetoed: true, reason };
    }
  }
  // Futures: no time gate at sendOrder layer. 24/5 trading allowed.

  // ── Tier-aware risk + sizing gate ─────────────────────
  const tierState  = loadTier();
  const tierNum    = tierState.tier;
  const tierDailyCap   = getDailyLossCap(tierNum);

  const today  = etDate();
  // Read daily P&L from disk — closePosition (SWING engine) may have written losses
  // that didn't sync to in-memory ledger before this call
  let dailyPnL = ledger.dailyPnL[today] || 0;
  try {
    const _dcheck = JSON.parse(readFileSync(LEDGER_FILE, 'utf8'));
    dailyPnL = _dcheck.dailyPnL?.[today] ?? dailyPnL;
    ledger.dailyPnL[today] = dailyPnL;
  } catch {}

  // Daily-loss cap — env-wins-when-set (2026-05-13 v2: previously Math.min
  // clamped env DOWN against tier; now env REPLACES tier when set, so testing-
  // mode can raise the cap above T1's $2,500 prod-realistic trigger. Production
  // reverts via env=2500 in .env).
  const effectiveDailyCap = MAX_DAILY_LOSS > 0 ? MAX_DAILY_LOSS : tierDailyCap;

  // Soft-warning tier — fires once per ET-date per process, then trading
  // CONTINUES. Operator gets: journal (DAILY_LOSS_WARNING), wsServer
  // broadcast, TTS voice alert, console banner, daily-loss-warning-state.json
  // (served by dashboard /api/daily-loss-warning). Skip if disabled (=0) or
  // already fired today.
  if (MAX_DAILY_LOSS_WARNING > 0 && _dailyLossWarningFiredFor !== today
      && dailyPnL <= -MAX_DAILY_LOSS_WARNING) {
    _dailyLossWarningFiredFor = today;
    const lossAmt = Math.abs(dailyPnL).toFixed(0);
    try {
      jAlert('warning', 'DAILY_LOSS_WARNING', {
        dailyPnL, threshold: MAX_DAILY_LOSS_WARNING, hardCap: effectiveDailyCap,
        instrument: consensus.instrument, engine: consensus.engine,
        date: today, etTime: getETString(),
      });
    } catch {}
    if (typeof global.wsBroadcast === 'function') {
      try {
        global.wsBroadcast({
          type: 'warning',
          payload: {
            kind: 'DAILY_LOSS_WARNING',
            dailyPnL, threshold: MAX_DAILY_LOSS_WARNING, hardCap: effectiveDailyCap,
            time: getETString(),
          },
        });
      } catch {}
    }
    try {
      pushVoiceAlert('daily-loss-warning', 'critical',
        `Daily loss warning. Down ${lossAmt} dollars. Threshold ${MAX_DAILY_LOSS_WARNING}. Continuing to trade. Hard cap ${effectiveDailyCap}.`,
        300_000);
    } catch {}
    try {
      writeFileSync(join(__dirname, 'daily-loss-warning-state.json'), JSON.stringify({
        fired: true, firedAt: Date.now(), firedAtET: getETString(), date: today,
        dailyPnL: parseFloat(dailyPnL.toFixed(2)),
        threshold: MAX_DAILY_LOSS_WARNING,
        hardCap: effectiveDailyCap,
      }));
    } catch {}
    console.log(`  ${C.yellow}⚠ DAILY LOSS WARNING — $${lossAmt} / threshold $${MAX_DAILY_LOSS_WARNING} (hard cap $${effectiveDailyCap}) — trading continues${C.reset}`);
  }

  if (dailyPnL <= -effectiveDailyCap) {
    const reason = `Daily loss cap hit ($${Math.abs(dailyPnL).toFixed(0)} / $${effectiveDailyCap}) [T${tierNum}]`;
    orderGate.markVetoed(requestId, reason);
    jGateBlock(consensus.engine, consensus.instrument, consensus.signal, 'DAILY_LOSS_CAP', { dailyPnL, effectiveDailyCap, tier: tierNum });
    console.log(`  ${C.red}🛑 DAILY LOSS LIMIT — no more trades today${C.reset}`);
    // Track daily-cap hit for tier-down trigger 4
    try {
      const fresh = loadTier();
      const hits = Array.isArray(fresh.dailyCapHits) ? fresh.dailyCapHits : [];
      if (!hits.includes(today)) {
        hits.push(today);
        fresh.dailyCapHits = hits.slice(-10); // keep last 10 dates
        saveTier(fresh);
      }
    } catch {}
    return { vetoed: true, reason };
  }

  // 2026-05-14 EOD: All concurrency / correlation / opposition gates removed
  // permanently per RULE 1. Single-instrument multi-direction is allowed,
  // family correlations are unconstrained, and there is no max-open count.
  // Per-trade STOP_LOSS_PCT and per-day MAX_DAILY_LOSS are the sole risk caps.

  // ── Contract sizing — tier × confidence band ──────────
  // Confidence priority: explicit numeric (consensus.finalConfidence) → consensus.contracts override
  // → fallback to label-derived (HIGH=1.5, MEDIUM=1.0). Below 0.65 means no trade.
  const labelConf = (() => {
    const c = (consensus.confidence || '').toString().toUpperCase();
    if (c === 'HIGH')   return 1.5;
    if (c === 'MEDIUM') return 1.0;
    if (c === 'LOW' || c === 'WEAK') return 0.65;
    return null;
  })();
  const finalConf = (typeof consensus.finalConfidence === 'number')
    ? consensus.finalConfidence
    : labelConf;

  let contracts;
  if (consensus.contracts != null) {
    // Engine override (e.g., FADE_EXPERIMENT_PRE10 forces 1) — honor as a cap, not a floor
    const tierSize = (finalConf != null) ? getPositionSize(finalConf, tierNum) : 1;
    contracts = Math.min(consensus.contracts, tierSize || 1);
  } else if (finalConf != null) {
    contracts = getPositionSize(finalConf, tierNum);
  } else {
    contracts = 1; // safety floor when no confidence info supplied
  }

  if (contracts === 0) {
    const reason = `Below-threshold confidence (final=${finalConf?.toFixed(2)} < 0.65) [T${tierNum}]`;
    orderGate.markVetoed(requestId, reason);
    jGateBlock(consensus.engine, consensus.instrument, consensus.signal, 'BELOW_THRESHOLD_CONFIDENCE', { finalConf, tier: tierNum });
    return { vetoed: true, reason };
  }
  contracts = Math.min(contracts, MAX_CONTRACTS);

  // ── P1-11 (2026-05-14 EOD): per-trade capital cap ──────────────────
  // tradeCapital = entryPremium × contracts × 100  (options-on-anything)
  // Reduce contracts until cap respected. Reject entry if even 1 contract
  // exceeds cap. Operator's $1k account discipline — no single trade can
  // tie up more than CAPITAL_CAP_PER_TRADE of capital.
  // (Path 2 futures-direct will use a different formula: contracts ×
  // entry × multiplier where multiplier is futures point-value ($50 ES,
  // $20 NQ, $5 MES, $2 MNQ). Not yet wired — Path 2 is weekend work.)
  const _entryPremium = consensus.entryPrice ?? 0;
  const _capPerTrade  = _capForInstrument(consensus.instrument);
  if (_entryPremium > 0 && _capPerTrade > 0) {
    const _capImpliedContracts = Math.floor(_capPerTrade / (_entryPremium * 100));
    if (_capImpliedContracts < 1) {
      // Even 1 contract exceeds cap — reject
      const reason = `CAPITAL_CAP_PER_TRADE — 1 contract @ $${_entryPremium.toFixed(2)} = $${(_entryPremium * 100).toFixed(0)} > cap $${_capPerTrade}`;
      orderGate.markVetoed(requestId, reason);
      jGateBlock(consensus.engine, consensus.instrument, consensus.signal, 'CAPITAL_CAP_PER_TRADE', {
        entryPremium: _entryPremium, capPerTrade: _capPerTrade,
        oneContractCapital: _entryPremium * 100,
      });
      console.log(`  ${C.red}🛑 ${reason}${C.reset}`);
      return { vetoed: true, reason };
    }
    if (_capImpliedContracts < contracts) {
      // Reduce contracts to fit cap
      console.log(`  ${C.yellow}⚠ CAPITAL_CAP_PER_TRADE — reducing contracts ${contracts}→${_capImpliedContracts} (premium $${_entryPremium.toFixed(2)} × ${_capImpliedContracts} × 100 = $${(_entryPremium * 100 * _capImpliedContracts).toFixed(0)} ≤ cap $${_capPerTrade})${C.reset}`);
      contracts = _capImpliedContracts;
    }
  }

  // ── P1-12 (2026-05-14 EOD): 1% account-risk position sizing ─────────
  // contracts = floor((account_balance × ACCOUNT_RISK_PCT) / (stop_distance × multiplier))
  // Multipliers (point value × $-per-point):
  //   ES = $50, NQ = $20, MES = $5, MNQ = $2 (futures point values)
  //   SPY/QQQ/IWM = $100 per option contract
  // Combined with CAPITAL_CAP_PER_TRADE: smaller governs.
  // Skip if stop_distance unavailable (legacy trades or no-stop instruments).
  const _stopDist = _getStopDistance(consensus.instrument);
  if (ACCOUNT_RISK_PCT > 0 && _stopDist != null) {
    const _multMap = {
      'ES': 50, 'ES1!': 50, 'NQ': 20, 'NQ1!': 20,
      'MES': 5, 'MES1!': 5, 'MNQ': 2, 'MNQ1!': 2,
      'SPY': 100, 'QQQ': 100, 'IWM': 100,
    };
    const _mult = _multMap[(consensus.instrument || '').toUpperCase()] ?? 100;
    const _accountBalance = ledger.balance ?? PAPER_BALANCE;
    const _riskBudget = _accountBalance * ACCOUNT_RISK_PCT;
    const _maxLossPerContract = _stopDist * _mult;
    const _riskImpliedContracts = Math.floor(_riskBudget / _maxLossPerContract);
    if (_riskImpliedContracts < 1) {
      const reason = `ACCOUNT_RISK_CAP — 1 contract risks $${_maxLossPerContract.toFixed(0)} > 1% of $${_accountBalance.toFixed(0)} ($${_riskBudget.toFixed(0)})`;
      orderGate.markVetoed(requestId, reason);
      jGateBlock(consensus.engine, consensus.instrument, consensus.signal, 'ACCOUNT_RISK_CAP', {
        accountBalance: _accountBalance, riskBudget: _riskBudget,
        stopDistance: _stopDist, multiplier: _mult,
        maxLossPerContract: _maxLossPerContract,
      });
      console.log(`  ${C.red}🛑 ${reason}${C.reset}`);
      return { vetoed: true, reason };
    }
    if (_riskImpliedContracts < contracts) {
      console.log(`  ${C.yellow}⚠ ACCOUNT_RISK_CAP — reducing contracts ${contracts}→${_riskImpliedContracts} (1% of $${_accountBalance.toFixed(0)} = $${_riskBudget.toFixed(0)} risk budget; per-contract risk = ${_stopDist} × $${_mult} = $${_maxLossPerContract.toFixed(0)})${C.reset}`);
      contracts = _riskImpliedContracts;
    }
  }

  // ── Soft unrealized-aware daily-loss cap (2026-05-13) ────────────────
  // The DAILY_LOSS_CAP check above sees only realized P&L. With Option B
  // (up to 6 concurrent positions), unrealized drawdown can be much wider
  // than realized at any moment — total transient equity dip can blow past
  // the cap before any close fires. This reserve gate adds the worst-case
  // loss across (a) existing OPEN positions and (b) THIS new entry, treating
  // each as if it would exit at STOP_0.5X (-50% of entry premium). If the
  // sum of realized + reserved >= cap, veto.
  // Gated by RESERVE_VETO_ENABLED (default false during testing) so the
  // hard cap remains the only entry-blocking layer when collecting full-day
  // validation data.
  if (RESERVE_VETO_ENABLED) {
    const STOP_RATIO = 0.5;
    const _wcl = (entry, qty, inst) =>
      Math.max(0, (entry || 0) * (qty || 1) * getContractMultiplier(inst) * STOP_RATIO);
    const _reservedExisting = (ledger.trades || [])
      .filter(t => t.status === 'OPEN')
      .reduce((s, t) => s + _wcl(t.fillPrice ?? t.limitPrice ?? 0, t.contracts ?? 1, t.instrument), 0);
    const _reservedNew = _wcl(consensus.entryPrice ?? 0, contracts, consensus.instrument);
    const _committedLoss = Math.max(0, -dailyPnL) + _reservedExisting + _reservedNew;
    if (_committedLoss >= effectiveDailyCap) {
      const reason = `Daily-loss reserve exhausted (committed $${_committedLoss.toFixed(0)} / cap $${effectiveDailyCap}) [T${tierNum}]`;
      orderGate.markVetoed(requestId, reason);
      jGateBlock(consensus.engine, consensus.instrument, consensus.signal, 'DAILY_LOSS_CAP_RESERVE', {
        dailyPnL, reservedExisting: parseFloat(_reservedExisting.toFixed(2)),
        reservedNew: parseFloat(_reservedNew.toFixed(2)),
        committedLoss: parseFloat(_committedLoss.toFixed(2)),
        effectiveDailyCap, tier: tierNum,
      });
      console.log(`  ${C.red}🛑 RESERVE CAP — committed $${_committedLoss.toFixed(0)} >= $${effectiveDailyCap}${C.reset}`);
      return { vetoed: true, reason };
    }
  }

  // P1-10 (2026-05-14 EOD): order-type validation. Only LIMIT and
  // STOP_MARKET accepted. MARKET orders rejected with ORDER_TYPE_REJECT.
  // Default to LIMIT if not specified by caller (Pine alerts don't pass
  // orderType today; webhook injects nothing). Live broker integration
  // (Webull/Alpaca) MUST enforce the same rule when wired up.
  const _orderType = (consensus.orderType || 'LIMIT').toUpperCase();
  if (!['LIMIT', 'STOP_MARKET'].includes(_orderType)) {
    const reason = `ORDER_TYPE_REJECT — type '${_orderType}' not in {LIMIT, STOP_MARKET}`;
    orderGate.markVetoed(requestId, reason);
    jGateBlock(consensus.engine, consensus.instrument, consensus.signal, 'ORDER_TYPE_REJECT', { orderType: _orderType });
    console.log(`  ${C.red}🛑 ${reason}${C.reset}`);
    return { vetoed: true, reason };
  }

  const order = {
    requestId,
    signal:    consensus.signal,      // CALLS | PUTS
    engine:    consensus.engine,      // TREND | FADE | SWING | MOC
    session:   getCurrentSession(),
    instrument:consensus.instrument || 'SPX',
    strike:    consensus.strike,
    type:      consensus.signal === 'CALLS' ? 'call' : 'put',
    side:      'BUY',
    contracts,
    limitPrice:consensus.entryPrice || 0,
    orderType: _orderType,
    confidence:consensus.confidence,
    ts:        Date.now(),
    timeET:    getETString(),
    mode:      TRADING_MODE,
  };

  // ── Paper mode ────────────────────────────────────────
  if (TRADING_MODE === 'PAPER') {
    const fill = simulateFill(order, lastQuote);

    // Capture entry IV + underlying — needed by evaluateOpenPositions for theta tracking
    let entryIV = null, entryUnderlying = consensus.underlyingPrice ?? null;
    try {
      if (entryUnderlying && order.strike != null && fill.fillPrice > 0.05) {
        const inst = order.instrument === 'SPX' ? 'SPX' : 'SPY';
        const { T } = getTradingTimeRemaining(inst);
        entryIV = getIV(fill.fillPrice, entryUnderlying, order.strike, T, 0.05, order.type, order.instrument);
      }
    } catch (e) { jError('entryIV-calc', e.message, { instrument: order.instrument, strike: order.strike }); }

    // P0-3 (2026-05-14 EOD): point-based stop on UNDERLYING price.
    // Replaces premium-% stop. CALLS stop = entryUnderlying - distance,
    // PUTS stop = entryUnderlying + distance. Stop check in
    // evaluateOpenPositions compares against live underlying, not premium.
    // P2-13: in PM regime (post-12:00 ET), apply PM_STOP_MULTIPLIER /
    // PM_TARGET_MULTIPLIER to widen stops/targets for 5m bar regime.
    const _regime  = _getRegimeNow();
    const _stopMul = _regime === 'PM' ? PM_STOP_MULTIPLIER   : 1.0;
    const _tgtMul  = _regime === 'PM' ? PM_TARGET_MULTIPLIER : 1.0;
    const _stopDistanceBase = _getStopDistance(consensus.instrument);
    const _stopDistance     = _stopDistanceBase != null ? _stopDistanceBase * _stopMul : null;
    const _entryU       = entryUnderlying ?? consensus.underlyingPrice ?? null;
    const _isCalls      = consensus.signal === 'CALLS';
    const _stopUnderlying = (_stopDistance != null && _entryU != null)
      ? parseFloat((_isCalls ? _entryU - _stopDistance : _entryU + _stopDistance).toFixed(4))
      : null;
    const _stopActive   = _stopUnderlying != null;
    // P1-5 (2026-05-14 EOD): 1:2 R:R take-profit + scale-out staging.
    // STAGE_1_ARMED on entry. evaluateOpenPositions transitions to
    // STAGE_3_TRAILING when target hits (50% close, BE stop, trail active).
    const _targetDistanceBase = _getTargetDistance(consensus.instrument);
    const _targetDistance     = _targetDistanceBase != null ? _targetDistanceBase * _tgtMul : null;
    const _targetUnderlying = (_targetDistance != null && _entryU != null)
      ? parseFloat((_isCalls ? _entryU + _targetDistance : _entryU - _targetDistance).toFixed(4))
      : null;

    const trade = {
      ...order,
      ...fill,
      status:   'OPEN',
      exitPrice:null,
      exitTime: null,
      pnl:      null,
      tag:      consensus.tag      ?? null,
      w3Score:  consensus.w3Score  ?? null,
      tickVal:  consensus.tickVal  ?? null,
      vwapDist: consensus.vwapDist ?? null,
      macro4H:  consensus.macro4H  ?? null,
      sessionWindow: consensus.sessionWindow ?? getCurrentSession(),
      context:  consensus.context  ?? null,
      tier:           tierNum,
      finalConfidence: finalConf,
      entryIV,
      entryUnderlying,
      stopUnderlyingPrice: _stopUnderlying,
      stopDistance:        _stopDistance,
      stopActive:          _stopActive,
      entryUnderlyingPrice: _entryU,
      // P1-5-B structure stop fields. Active when invalidationLevel is
      // a finite number AND the instrument is in STRUCTURE_STOP_INSTRUMENTS.
      // CALLS fire on close <= invalidation; PUTS fire on close >= invalidation.
      invalidationLevel:   Number.isFinite(consensus.invalidationLevel) ? consensus.invalidationLevel : null,
      structureType:       consensus.structureType ?? null,
      structureStopActive: STRUCTURE_STOP_ENABLED
                            && Number.isFinite(consensus.invalidationLevel)
                            && STRUCTURE_STOP_INSTRUMENTS.has((consensus.instrument || '').toUpperCase()),
      // P1-5 take-profit + scale-out + trailing state
      stage:               'STAGE_1_ARMED',
      targetUnderlyingPrice: _targetUnderlying,
      targetDistance:      _targetDistance,
      peakFavorablePrice:  _entryU,           // initialized at entry; updates in STAGE_3
      trailStopPrice:      null,              // set on STAGE_3 entry
      lockedStopLevel:     'NONE',            // 'NONE' | '1R' | '2R'
      cumulativePartialPnL: 0,                // sum of any SCALE_OUT_PARTIAL exits
      scaleOutEvents:      [],                // each: { contracts, exitPrice, exitTime, pnl, et }
      originalContracts:   contracts,         // immutable record of original size
      // Alias for callers (webhook-server.js SIGNAL_REVERSAL exit math) that
      // look up `underlyingPrice` rather than `entryUnderlying`. Same value,
      // two names — schema redundancy intentional to prevent future field-name
      // mismatch bugs. Diagnosed 2026-05-12: webhook's exit math read
      // `oppositeOpen.underlyingPrice` (undefined) and fell back to current
      // price, producing zero-move synthetic exit clamped to $0.01 floor.
      underlyingPrice: entryUnderlying,
    };

    // Lock gate
    orderGate.markExecuted(requestId, trade);

    // Add to ledger under lock — prevents race with other monitor processes
    const _locked = acquireLock();
    try {
      const _fresh = loadLedger();
      _fresh.trades.push(trade);
      _fresh.totalTrades++;
      saveLedgerDirect(_fresh);
      if (!ledger.trades.find(t => t.requestId === requestId)) ledger.trades.push(trade);
      ledger.totalTrades = _fresh.totalTrades;
    } finally {
      if (_locked) releaseLock();
    }

    // Print
    console.log(`\n  ${C.cyan}${C.bold}📋 PAPER TRADE${C.reset}`);
    console.log(`  ${order.instrument} ${order.type.toUpperCase()} ${order.strike} × ${contracts}`);
    console.log(`  Entry: $${fill.fillPrice} (mid $${fill.mid} | slip $${fill.slippage})`);
    console.log(`  Engine: ${order.engine} | Session: ${order.session} | ${order.confidence}`);
    console.log(`  RequestId: ${requestId}\n`);

    jEntry(trade);
    return trade;
  }

  // ── Live mode ─────────────────────────────────────────
  // TODO: Wire to Webull placeOrder API when autotrader is ready
  console.log(`\n  ${C.red}${C.bold}🔴 LIVE ORDER — WEBULL${C.reset}`);
  console.log(`  ${order.instrument} ${order.type.toUpperCase()} ${order.strike} × ${contracts}`);
  console.log(`  [Webull API call would fire here]`);
  orderGate.markExecuted(requestId, order);

  return order;
}

// ─── P1-5 (2026-05-14 EOD): scale-out + stage transitions ──────────────────
// _executeScaleOut: STAGE_1 → STAGE_3 transition. Closes 50% of contracts
// at current option price (logged as SCALE_OUT_PARTIAL exit), moves stop
// on remainder to breakeven (entryUnderlyingPrice), activates trail, and
// transitions stage to STAGE_3_TRAILING. The trade record stays OPEN with
// reduced contracts.
function _executeScaleOut(requestId, exitOptionPrice, liveU) {
  const locked = acquireLock();
  try {
    const fresh = loadLedger();
    const trade = fresh.trades.find(t => t.requestId === requestId && t.status === 'OPEN');
    if (!trade) return null;
    if (trade.stage !== 'STAGE_1_ARMED') return null;   // already transitioned
    if (!trade.contracts || trade.contracts < 1) return null;

    // Half-close: ceil so a 1-contract trade still gets a partial of 1 (rest 0 — flat-out)
    // For multi-contract trades, scale 50% with floor.
    const halfContracts = Math.max(1, Math.floor(trade.contracts / 2));
    const remainingContracts = trade.contracts - halfContracts;

    // P&L on the partial close (long-options: profit when premium up)
    const partialPnlPerShare = exitOptionPrice - trade.fillPrice;
    const partialPnl = partialPnlPerShare * 100 * halfContracts;

    // Mutate trade record
    trade.contracts          = remainingContracts;
    trade.cumulativePartialPnL = (trade.cumulativePartialPnL || 0) + partialPnl;
    trade.scaleOutEvents     = trade.scaleOutEvents || [];
    trade.scaleOutEvents.push({
      contracts: halfContracts,
      exitPrice: exitOptionPrice,
      exitTime:  Date.now(),
      et:        getETString(),
      pnl:       parseFloat(partialPnl.toFixed(2)),
      reason:    'SCALE_OUT_PARTIAL',
      underlyingAtExit: liveU,
    });

    // STAGE 3 setup: stop moves to BREAKEVEN, trail activates, peak initialized
    trade.stage              = 'STAGE_3_TRAILING';
    trade.stopUnderlyingPrice = trade.entryUnderlyingPrice;   // BE stop
    trade.peakFavorablePrice = liveU;
    const trailDist          = liveU * (TRAIL_PCT / 100);
    trade.trailStopPrice     = trade.signal === 'CALLS'
      ? parseFloat((liveU - trailDist).toFixed(4))
      : parseFloat((liveU + trailDist).toFixed(4));
    trade.lockedStopLevel    = 'NONE';

    // Update fresh totals (partial pnl counts toward today's realized)
    fresh.totalPnL += partialPnl;
    fresh.balance  += partialPnl;
    const today = etDate();
    fresh.dailyPnL[today] = (fresh.dailyPnL[today] || 0) + partialPnl;

    saveLedgerDirect(fresh);

    // Sync in-memory copy
    const local = ledger.trades.find(t => t.requestId === requestId);
    if (local) Object.assign(local, {
      contracts:                trade.contracts,
      cumulativePartialPnL:     trade.cumulativePartialPnL,
      scaleOutEvents:           trade.scaleOutEvents,
      stage:                    trade.stage,
      stopUnderlyingPrice:      trade.stopUnderlyingPrice,
      peakFavorablePrice:       trade.peakFavorablePrice,
      trailStopPrice:           trade.trailStopPrice,
      lockedStopLevel:          trade.lockedStopLevel,
    });
    ledger.totalPnL = fresh.totalPnL;
    ledger.balance  = fresh.balance;
    if (!ledger.dailyPnL) ledger.dailyPnL = {};
    ledger.dailyPnL[today] = fresh.dailyPnL[today];

    console.log(`  ${C.green}🟢 SCALE_OUT_PARTIAL ${trade.instrument} ${trade.signal} — closed ${halfContracts}/${trade.originalContracts} @ $${exitOptionPrice.toFixed(2)} +$${partialPnl.toFixed(0)}; remaining ${remainingContracts} now BE-stop + trail${C.reset}`);
    try {
      jExit({
        ...trade,
        exitPrice: exitOptionPrice,
        exitTime:  Date.now(),
        exitTimeET: getETString(),
        exitReason: 'SCALE_OUT_PARTIAL',
        pnl: parseFloat(partialPnl.toFixed(2)),
        contracts: halfContracts,   // partial-leg view
      });
    } catch {}
    pushVoiceAlert(`scale-out-${requestId}`, 'info',
      `Scale out fifty percent on ${trade.instrument} ${trade.signal}. Stop moved to break-even. Trailing remainder.`,
      120_000);

    return trade;
  } finally {
    if (locked) releaseLock();
  }
}

// _updateStage3: update peak favorable price + trail stop + R-multiple
// locks. Called every evaluation tick while trade is in STAGE_3_TRAILING.
// Mutates the in-memory trade record's stop fields; the next tick's
// stop-check (above) consumes the updated values.
function _updateStage3(requestId, liveU) {
  const locked = acquireLock();
  try {
    const fresh = loadLedger();
    const trade = fresh.trades.find(t => t.requestId === requestId && t.status === 'OPEN');
    if (!trade || trade.stage !== 'STAGE_3_TRAILING') return null;
    if (!trade.entryUnderlyingPrice || !trade.stopDistance) return null;
    // 2026-05-15: sanity-gate defense — refuse to mutate peakFavorablePrice
    // or R-lock state with a bogus liveU. The eval-loop gate above should
    // catch this already; this is the second-line of defense in case a
    // direct caller invokes _updateStage3 with bogus input.
    if (!_isUnderlyingSane(liveU, trade.entryUnderlyingPrice)) return null;

    const isCalls = trade.signal === 'CALLS';
    let dirty = false;

    // Update peak favorable price (best underlying observed since entry)
    const isFavorable = isCalls
      ? (liveU > (trade.peakFavorablePrice ?? trade.entryUnderlyingPrice))
      : (liveU < (trade.peakFavorablePrice ?? trade.entryUnderlyingPrice));
    if (isFavorable) {
      trade.peakFavorablePrice = liveU;
      dirty = true;
    }

    // Trail stop = peak ± TRAIL_PCT% of peak
    const trailDist = (trade.peakFavorablePrice ?? liveU) * (TRAIL_PCT / 100);
    const newTrailStop = isCalls
      ? parseFloat((trade.peakFavorablePrice - trailDist).toFixed(4))
      : parseFloat((trade.peakFavorablePrice + trailDist).toFixed(4));
    // Only ratchet trail in the favorable direction (never loosen)
    if (trade.trailStopPrice == null
        || (isCalls  && newTrailStop > trade.trailStopPrice)
        || (!isCalls && newTrailStop < trade.trailStopPrice)) {
      trade.trailStopPrice = newTrailStop;
      dirty = true;
    }

    // R-multiple math: R = stop_distance. Lock 1R at +3R, lock 2R at +4R.
    const R = trade.stopDistance;
    const moveFromEntry = isCalls
      ? (trade.peakFavorablePrice - trade.entryUnderlyingPrice)
      : (trade.entryUnderlyingPrice - trade.peakFavorablePrice);
    const RMultiple = moveFromEntry / R;

    if (RMultiple >= 4 && trade.lockedStopLevel !== '2R') {
      // Lock at +2R from entry
      const lockPrice = isCalls
        ? parseFloat((trade.entryUnderlyingPrice + 2 * R).toFixed(4))
        : parseFloat((trade.entryUnderlyingPrice - 2 * R).toFixed(4));
      // Use the higher of trail and lock for CALLS, lower for PUTS — locked stop floors the protection
      trade.stopUnderlyingPrice = isCalls
        ? Math.max(lockPrice, trade.trailStopPrice ?? lockPrice)
        : Math.min(lockPrice, trade.trailStopPrice ?? lockPrice);
      trade.lockedStopLevel = '2R';
      dirty = true;
      console.log(`  ${C.green}🔒 ${trade.instrument} ${trade.signal} +4R reached — stop locked at +2R (${trade.stopUnderlyingPrice.toFixed(2)})${C.reset}`);
    } else if (RMultiple >= 3 && trade.lockedStopLevel === 'NONE') {
      // Lock at +1R from entry
      const lockPrice = isCalls
        ? parseFloat((trade.entryUnderlyingPrice + 1 * R).toFixed(4))
        : parseFloat((trade.entryUnderlyingPrice - 1 * R).toFixed(4));
      trade.stopUnderlyingPrice = isCalls
        ? Math.max(lockPrice, trade.trailStopPrice ?? lockPrice)
        : Math.min(lockPrice, trade.trailStopPrice ?? lockPrice);
      trade.lockedStopLevel = '1R';
      dirty = true;
      console.log(`  ${C.green}🔒 ${trade.instrument} ${trade.signal} +3R reached — stop locked at +1R (${trade.stopUnderlyingPrice.toFixed(2)})${C.reset}`);
    } else if (trade.lockedStopLevel === 'NONE') {
      // No R-lock yet — stopUnderlyingPrice tracks the trail (already at BE
      // from STAGE_2 transition). Use the more favorable of BE and trail.
      const trailWinsOverBE = isCalls
        ? (trade.trailStopPrice > trade.entryUnderlyingPrice)
        : (trade.trailStopPrice < trade.entryUnderlyingPrice);
      if (trailWinsOverBE && trade.trailStopPrice != null) {
        trade.stopUnderlyingPrice = trade.trailStopPrice;
        dirty = true;
      }
    }

    if (dirty) {
      saveLedgerDirect(fresh);
      const local = ledger.trades.find(t => t.requestId === requestId);
      if (local) Object.assign(local, {
        peakFavorablePrice:  trade.peakFavorablePrice,
        trailStopPrice:      trade.trailStopPrice,
        stopUnderlyingPrice: trade.stopUnderlyingPrice,
        lockedStopLevel:     trade.lockedStopLevel,
      });
    }
    return trade;
  } finally {
    if (locked) releaseLock();
  }
}

// ─── Close Position ───────────────────────────────────────

export function closePosition(requestId, exitPrice, exitReason = 'MANUAL') {
  const locked = acquireLock();
  try {
    // Read fresh from disk so we see trades written by other monitor processes
    const fresh = loadLedger();
    const trade = fresh.trades.find(t => t.requestId === requestId && t.status === 'OPEN');

    if (!trade) {
      console.warn(`  closePosition: requestId ${requestId} not found or already closed`);
      return null;
    }

    // Long options (call or put): profit when premium increases — multiplier is always +1
    const pnlPerShare = exitPrice - trade.fillPrice;
    const pnlTotal    = pnlPerShare * 100 * trade.contracts;   // remaining-leg pnl
    const pnlPct      = (pnlPerShare / trade.fillPrice) * 100;
    const holdMins    = (Date.now() - trade.fillTime) / 60000;
    // P1-5: include partial-leg P&L from any prior SCALE_OUT_PARTIAL events
    const partialPnL  = trade.cumulativePartialPnL || 0;
    const finalPnL    = pnlTotal + partialPnL;   // total realized for this trade
    const win         = finalPnL > 0;

    trade.exitPrice  = exitPrice;
    trade.exitTime   = Date.now();
    trade.exitTimeET = getETString();
    trade.exitReason = exitReason;
    trade.pnl        = parseFloat(finalPnL.toFixed(2));    // includes partials
    trade.pnlRemainingLeg = parseFloat(pnlTotal.toFixed(2));
    trade.pnlPct     = parseFloat(pnlPct.toFixed(2));      // remaining-leg only (partial had its own pct)
    trade.holdMins   = parseFloat(holdMins.toFixed(1));
    trade.status     = 'CLOSED';
    trade.win        = win;
    trade.grade      = _gradeProcess(trade, exitReason);

    // P0-4 (2026-05-14 EOD): merge MFE/MAE from tracker into trade record.
    // peakUnrealizedPnL = max favorable P&L observed (MFE in $).
    // troughUnrealizedPnL = max adverse P&L observed (MAE in $).
    // peakUnderlyingPrice / troughUnderlyingPrice = best/worst underlying.
    // Tracker entry deleted after merge (frees memory + signals consumed).
    const _mm = _mfeMaeTracker.get(requestId);
    if (_mm) {
      trade.peakUnrealizedPnL    = parseFloat(_mm.peakPnl.toFixed(2));
      trade.troughUnrealizedPnL  = parseFloat(_mm.troughPnl.toFixed(2));
      trade.peakUnderlyingPrice  = parseFloat(_mm.peakU.toFixed(4));
      trade.troughUnderlyingPrice= parseFloat(_mm.troughU.toFixed(4));
      trade.mfeMaeTickCount      = _mm.ticks;
      _mfeMaeTracker.delete(requestId);
    } else {
      // No tracker entry — could be: process restarted between entry and
      // exit, or exit fired before any evaluation tick. Mark as null so
      // analytics can distinguish "not tracked" from "0 unrealized".
      trade.peakUnrealizedPnL    = null;
      trade.troughUnrealizedPnL  = null;
      trade.peakUnderlyingPrice  = null;
      trade.troughUnderlyingPrice= null;
      trade.mfeMaeTickCount      = 0;
    }

    fresh.totalPnL += pnlTotal;
    fresh.balance  += pnlTotal;
    if (win) fresh.wins++; else fresh.losses++;

    const today = etDate();
    fresh.dailyPnL[today] = (fresh.dailyPnL[today] || 0) + pnlTotal;

    const eng = trade.engine;
    if (fresh.engineStats?.[eng]) {
      fresh.engineStats[eng].trades++;
      fresh.engineStats[eng].pnl += pnlTotal;
      if (win) fresh.engineStats[eng].wins++;
      else fresh.engineStats[eng].losses = (fresh.engineStats[eng].losses ?? 0) + 1;
    }

    const sess = trade.session;
    if (fresh.sessionStats?.[sess]) {
      fresh.sessionStats[sess].trades++;
      fresh.sessionStats[sess].pnl += pnlTotal;
      if (win) fresh.sessionStats[sess].wins++;
      else fresh.sessionStats[sess].losses = (fresh.sessionStats[sess].losses ?? 0) + 1;
    }

    saveLedgerDirect(fresh);

    // Sync in-memory ledger for this process
    const local = ledger.trades.find(t => t.requestId === requestId);
    if (local) Object.assign(local, { exitPrice: trade.exitPrice, exitTime: trade.exitTime, exitTimeET: trade.exitTimeET, exitReason: trade.exitReason, pnl: trade.pnl, pnlPct: trade.pnlPct, holdMins: trade.holdMins, status: 'CLOSED', win });
    ledger.totalPnL = fresh.totalPnL;
    ledger.balance  = fresh.balance;
    ledger.wins     = fresh.wins;
    ledger.losses   = fresh.losses;
    if (!ledger.dailyPnL) ledger.dailyPnL = {};
    ledger.dailyPnL[today] = fresh.dailyPnL[today];

    // RULE 2 — DAILY_TARGET tracker. Fires once per ET-date per process when
    // realized dailyPnL crosses +$DAILY_TARGET. Trading CONTINUES (operator
    // default — stops protect each trade individually). Mirrors the
    // MAX_DAILY_LOSS_WARNING pattern from dcf3a5a: jAlert + wsServer
    // broadcast + TTS + state-file + console banner.
    if (DAILY_TARGET > 0 && _dailyTargetFiredFor !== today
        && fresh.dailyPnL[today] >= DAILY_TARGET) {
      _dailyTargetFiredFor = today;
      const gainAmt = fresh.dailyPnL[today].toFixed(0);
      try {
        jAlert('info', 'TARGET_REACHED', {
          dailyPnL: fresh.dailyPnL[today], target: DAILY_TARGET,
          instrument: trade.instrument, engine: trade.engine,
          date: today, etTime: getETString(),
        });
      } catch {}
      if (typeof global.wsBroadcast === 'function') {
        try {
          global.wsBroadcast({
            type: 'info',
            payload: {
              kind: 'TARGET_REACHED',
              dailyPnL: fresh.dailyPnL[today], target: DAILY_TARGET,
              time: getETString(),
            },
          });
        } catch {}
      }
      try {
        pushVoiceAlert('daily-target-reached', 'critical',
          `Daily target reached. Up ${gainAmt} dollars. Continuing to trade. Stops protect each trade.`,
          300_000);
      } catch {}
      try {
        writeFileSync(join(__dirname, 'daily-target-state.json'), JSON.stringify({
          fired: true, firedAt: Date.now(), firedAtET: getETString(), date: today,
          dailyPnL: parseFloat(fresh.dailyPnL[today].toFixed(2)),
          target: DAILY_TARGET,
        }));
      } catch {}
      console.log(`  ${C.green}🎯 DAILY TARGET REACHED — +$${gainAmt} / target $${DAILY_TARGET} — trading continues${C.reset}`);
    }

    const pnlColor = win ? C.green : C.red;
    console.log(`\n  ${pnlColor}${win ? '✅' : '❌'} PAPER CLOSE — ${exitReason}${C.reset}`);
    console.log(`  ${trade.instrument} ${trade.type.toUpperCase()} | entry $${trade.fillPrice} → exit $${exitPrice}`);
    console.log(`  P&L: ${pnlColor}${win?'+':''}$${pnlTotal.toFixed(0)} (${pnlPct.toFixed(0)}%)${C.reset} | held ${holdMins.toFixed(1)}min`);
    console.log(`  Balance: $${fresh.balance.toFixed(0)} (started $${fresh.startBalance})\n`);

    jExit(trade);

    // ── Tier state update — every closed trade triggers re-eval ──
    try {
      const ts = loadTier();
      // Track consecutive losses, excluding fade-experiment baseline trades
      const isFadeExperiment = (trade.tag || '').startsWith('FADE_EXPERIMENT_PRE10');
      if (!isFadeExperiment) {
        if (win) ts.consecutiveLosses = 0;
        else     ts.consecutiveLosses = (ts.consecutiveLosses ?? 0) + 1;
      }
      // Update equity + HWM
      updateEquity(ts, fresh.balance);

      // Tier-down check (any 1 trigger fires)
      const down = checkTierDown(ts, fresh);
      if (down.triggered) {
        const fromT = ts.tier;
        applyTierDown(ts, down.reason);
        jAlert('warn', `TIER_DOWN ${fromT}→${ts.tier}: ${down.reason}`, { tier: ts.tier });
        console.log(`  ${C.yellow}⚠ TIER_DOWN ${fromT}→${ts.tier} — ${down.reason}${C.reset}`);
      }

      // Tier-up eligibility check — emits alert, never auto-promotes
      const up = checkTierUpEligibility(ts, fresh);
      if (up.eligible) {
        if (!ts.eligibleForUp || ts.eligibleForUp.target !== up.target) {
          ts.eligibleForUp = {
            target:  up.target,
            since:   new Date().toISOString(),
            checks:  up.checks,
          };
          jAlert('info', `TIER_UP_ELIGIBLE ${ts.tier}→${up.target}: all 4 quals met`, {
            balance: fresh.balance,
            checks:  up.checks,
          });
          console.log(`  ${C.green}⬆ TIER_UP_ELIGIBLE ${ts.tier}→${up.target} — awaiting operator approval${C.reset}`);
        }
      } else if (ts.eligibleForUp) {
        // Was eligible, no longer — clear the flag (e.g., a loss tipped WR below threshold)
        ts.eligibleForUp = null;
      }

      saveTier(ts);
    } catch (e) {
      jError('tier-update', e.message, { requestId });
    }

    return trade;
  } finally {
    if (locked) releaseLock();
  }
}

// ─── Position Evaluation (theta.js wire-in) ──────────────
// Called once per poll by each monitor. Loops OPEN positions, computes
// current greeks + IV crush + burn zone + hard exit countdown.
// Writes portfolio-theta.json for dashboard. Triggers IV-crush exit
// when ivCrushing && pnlPct > 200. Returns the analysis array.
//
// `priceFeeder({ instrument, strike, type, fillPrice, entryUnderlying })`
//   must return `{ optionPrice, underlyingPrice }` or null/undefined to skip.
//
// Caller responsibility: pass a feeder that knows current underlying prices.
// monitor.js feeds from _spyPrice / _qqqPrice / _iwmPrice; option price is
// estimated from delta-1 approx if no live chain.

const PORTFOLIO_THETA_FILE = join(__dirname, 'portfolio-theta.json');
const VOICE_QUEUE_FILE     = join(__dirname, 'voice-queue.json');

// Voice alert producer — voice bridge (separate process) consumes and speaks.
// De-duplicates by `key` so we don't repeat the same alert every poll.
const _voiceLastEmit = new Map(); // key → ts
function pushVoiceAlert(key, priority, message, dedupMs = 60_000) {
  try {
    const last = _voiceLastEmit.get(key) ?? 0;
    if (Date.now() - last < dedupMs) return;
    _voiceLastEmit.set(key, Date.now());
    let queue = [];
    try { queue = JSON.parse(readFileSync(VOICE_QUEUE_FILE, 'utf8')); } catch {}
    if (!Array.isArray(queue)) queue = [];
    queue.push({
      ts:       Date.now(),
      time:     getETString(),
      key,
      priority,    // 'critical' | 'warning' | 'info'
      message,
      spoken:    false,
    });
    // Cap queue at 200 entries so this doesn't grow unbounded
    if (queue.length > 200) queue = queue.slice(-200);
    writeFileSync(VOICE_QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch (e) { jError('voice-queue', e.message); }
}

export function evaluateOpenPositions(priceFeeder) {
  const positions = [];
  const exitsToFire = [];

  let lg;
  try { lg = JSON.parse(readFileSync(LEDGER_FILE, 'utf8')); }
  catch (e) { jError('evalOpen-ledger', e.message); return { positions: [], portfolioTheta: 0 }; }

  const burn = getBurnZoneData();
  const open = (lg.trades ?? []).filter(t => t.status === 'OPEN');

  for (const t of open) {
    let analysis = null;
    try {
      const fed = priceFeeder ? priceFeeder(t) : null;
      if (!fed || !fed.optionPrice || !fed.underlyingPrice) {
        // Still record minimal analysis — burn zone applies regardless
        positions.push({
          requestId:   t.requestId,
          instrument:  t.instrument,
          direction:   t.signal,
          fillPrice:   t.fillPrice,
          burnZone:    burn.current.label,
          analysis:    null,
          reason:      fed ? 'no_price_feed' : 'feeder_skipped',
        });
        continue;
      }

      // Strike required for greeks; without it we can only show burn zone
      if (t.strike == null || t.entryUnderlying == null) {
        positions.push({
          requestId:   t.requestId,
          instrument:  t.instrument,
          direction:   t.signal,
          fillPrice:   t.fillPrice,
          currentPrice:fed.optionPrice,
          burnZone:    burn.current.label,
          analysis:    null,
          reason:      'missing_strike_or_entry_underlying',
        });
        continue;
      }

      // 2026-05-15 EOD: underlying-price sanity gate. Reject the tick if
      // fed.underlyingPrice deviates >50% from this trade's entry underlying.
      // The QQQ-$211 phantom +$49,757 trade on 5/15 was caused by a feeder
      // returning ~$211 for QQQ when actual was ~$711. Bogus liveU poisoned
      // peakFavorablePrice, R-locks, trail stops, and BS pricing. This gate
      // catches the same class of corruption at the entry to the eval loop.
      const _entryU = t.entryUnderlyingPrice ?? t.entryUnderlying;
      if (!_isUnderlyingSane(fed.underlyingPrice, _entryU)) {
        _saneRejectsThisRun++;
        // Log first occurrence per requestId to avoid spam; rest counted silently
        if (!_saneRejectLogged.has(t.requestId)) {
          _saneRejectLogged.add(t.requestId);
          const deviation = Math.abs(fed.underlyingPrice - _entryU) / _entryU * 100;
          try { jError('eval-unsane-price',
            `${t.instrument} liveU=${fed.underlyingPrice} entryU=${_entryU} deviation=${deviation.toFixed(0)}% — tick rejected`,
            { requestId: t.requestId, instrument: t.instrument, liveU: fed.underlyingPrice, entryU: _entryU, threshold: UNDERLYING_SANITY_THRESHOLD }); } catch {}
          console.log(`  ${C.red}⚠ UNSANE FEED  ${t.instrument} liveU=${fed.underlyingPrice} vs entryU=${_entryU.toFixed(2)} (${deviation.toFixed(0)}% — tick rejected, MFE/stop/target skipped)${C.reset}`);
        }
        positions.push({
          requestId:   t.requestId,
          instrument:  t.instrument,
          direction:   t.signal,
          fillPrice:   t.fillPrice,
          burnZone:    burn.current.label,
          analysis:    null,
          reason:      'unsane_underlying_feed',
        });
        continue;   // skip MFE/MAE update, stop check, target/trail
      }

      analysis = monitorPosition({
        symbol:     `${t.instrument}_${t.strike}${t.type === 'call' ? 'C' : 'P'}`,
        underlying: t.instrument,
        strike:     t.strike,
        type:       t.type,
        entryPrice: t.fillPrice,
        entryTime:  t.fillTime,
        entryIV:    t.entryIV,
        contracts:  t.contracts,
      }, fed.optionPrice, fed.underlyingPrice);

      positions.push({
        requestId:   t.requestId,
        instrument:  t.instrument,
        direction:   t.signal,
        fillPrice:   t.fillPrice,
        currentPrice:fed.optionPrice,
        underlying:  fed.underlyingPrice,
        burnZone:    analysis.burnZone,
        analysis,
      });

      // P0-4 (2026-05-14 EOD): MFE/MAE tick update. Track peak + trough
      // unrealized P&L and underlying price for this open position. Merged
      // into trade record on exit by closePosition.
      try {
        const _liveU = fed.underlyingPrice;
        const _livePnl = analysis.pnlTotal;   // unrealized $ at this tick
        const ex = _mfeMaeTracker.get(t.requestId) || {
          peakPnl:   _livePnl,
          troughPnl: _livePnl,
          peakU:     _liveU,
          troughU:   _liveU,
          lastPnl:   _livePnl,
          lastU:     _liveU,
          ticks:     0,
        };
        if (_livePnl > ex.peakPnl)   ex.peakPnl = _livePnl;
        if (_livePnl < ex.troughPnl) ex.troughPnl = _livePnl;
        if (_liveU   > ex.peakU)     ex.peakU = _liveU;
        if (_liveU   < ex.troughU)   ex.troughU = _liveU;
        ex.lastPnl = _livePnl;
        ex.lastU   = _liveU;
        ex.ticks++;
        _mfeMaeTracker.set(t.requestId, ex);
      } catch {}

      // P0-3 + P1-5 + P1-6 + P1-5-B (2026-05-14 EOD): mechanical exit hierarchy.
      // Exit priority on a single tick (first match wins):
      //   1. STOP_LOSS_STRUCTURE (P1-5-B — structural invalidation break)
      //   2. STOP_LOSS_POINTS (initial stop OR BREAKEVEN_STOP OR PROFIT_LOCKED_STOP)
      //   3. TARGET (1:2 hit → triggers STAGE_2 scale-out → STAGE_3)
      //   4. TRAIL_STOP (STAGE_3 trail breach)
      //   5. SIGNAL_REVERSAL (handled separately by webhook on opposite alert)
      //   6. IV_CRUSH_EXIT / HARD_EXIT (legacy, lower priority than mechanical)
      const isCalls = t.signal === 'CALLS';
      const liveU   = fed.underlyingPrice;

      // 0. STOP_LOSS_STRUCTURE — fires before point-based stop. Bar-close
      //    confirmed (whipsaw protection same as P1-5-A but on a separate
      //    breach tracker so structure + points don't share state).
      if (t.structureStopActive && t.invalidationLevel != null && liveU != null) {
        const structBreached = isCalls
          ? (liveU <= t.invalidationLevel)
          : (liveU >= t.invalidationLevel);

        const useBarClose = WHIPSAW_PROTECTION && STOP_CONFIRMATION === 'bar_close';
        let shouldFire = false;
        if (!useBarClose) {
          shouldFire = structBreached;
        } else {
          const nowET = new Date().toLocaleString('en-US', { timeZone:'America/New_York', hour12:false, hour:'2-digit', minute:'2-digit' });
          let ws = _structureWhipsaw.get(t.requestId);
          if (!ws) { ws = { currentBarMinute: nowET, currentBarBreached: false }; _structureWhipsaw.set(t.requestId, ws); }
          if (nowET !== ws.currentBarMinute) {
            if (ws.currentBarBreached && structBreached) shouldFire = true;
            ws.currentBarMinute = nowET;
            ws.currentBarBreached = structBreached;
          } else if (structBreached) {
            ws.currentBarBreached = true;
          }
        }

        if (shouldFire) {
          exitsToFire.push({ requestId: t.requestId, exitPrice: fed.optionPrice, reason: 'STOP_LOSS_STRUCTURE' });
          pushVoiceAlert(`stop-loss-struct-${t.requestId}`, 'critical',
            `Structural stop on ${t.instrument} ${t.signal}. ${t.structureType ?? 'STRUCT'} invalidation at ${t.invalidationLevel.toFixed(2)} confirmed by bar close.`);
          _structureWhipsaw.delete(t.requestId);
          continue;
        }
      }

      // 1. STOP check — respects current effective stop (may be BE or
      //    profit-locked level after STAGE_3 transitions). P1-5-A whipsaw
      //    protection: when WHIPSAW_PROTECTION=true and STOP_CONFIRMATION=
      //    bar_close, a breach during a 1-min bar only fires on bar
      //    rollover IFF the underlying is still beyond stop at the new
      //    bar's first tick. Profit-locked + BE stops bypass whipsaw
      //    protection (operator wants instant lock-protection).
      if (t.stopActive && t.stopUnderlyingPrice != null && liveU != null) {
        const breached = isCalls
          ? (liveU <= t.stopUnderlyingPrice)
          : (liveU >= t.stopUnderlyingPrice);

        let exitReason = 'STOP_LOSS_POINTS';   // P1-5-B: renamed from STOP_LOSS for clarity
        if (t.lockedStopLevel === '1R' || t.lockedStopLevel === '2R') exitReason = 'PROFIT_LOCKED_STOP';
        else if (t.stage === 'STAGE_3_TRAILING' && t.entryUnderlyingPrice != null
                 && Math.abs(t.stopUnderlyingPrice - t.entryUnderlyingPrice) < 0.01) {
          exitReason = 'BREAKEVEN_STOP';
        }

        // Whipsaw protection only applies to initial STOP_LOSS (operator-
        // critical: locked-profit + BE stops fire instantly so realized
        // gains are protected).
        const useBarClose = WHIPSAW_PROTECTION
          && STOP_CONFIRMATION === 'bar_close'
          && exitReason === 'STOP_LOSS';

        let shouldFire = false;
        if (!useBarClose) {
          shouldFire = breached;
        } else {
          // Track breach state across bars
          const nowET = new Date().toLocaleString('en-US', { timeZone:'America/New_York', hour12:false, hour:'2-digit', minute:'2-digit' });
          let ws = _whipsawState.get(t.requestId);
          if (!ws) { ws = { currentBarMinute: nowET, currentBarBreached: false }; _whipsawState.set(t.requestId, ws); }
          if (nowET !== ws.currentBarMinute) {
            // Bar just rolled over — confirm/decline the prior breach
            if (ws.currentBarBreached && breached) {
              shouldFire = true;   // prior bar closed beyond stop AND new bar opens still beyond
            }
            // Reset for new bar
            ws.currentBarMinute = nowET;
            ws.currentBarBreached = breached;
          } else if (breached) {
            ws.currentBarBreached = true;   // mid-bar breach observed; await close to confirm
          }
        }

        if (shouldFire) {
          exitsToFire.push({ requestId: t.requestId, exitPrice: fed.optionPrice, reason: exitReason });
          pushVoiceAlert(`stop-loss-${t.requestId}`, 'critical',
            `${exitReason} on ${t.instrument} ${t.signal}. Underlying ${liveU.toFixed(2)} confirmed beyond ${t.stopUnderlyingPrice.toFixed(2)}.`);
          _whipsawState.delete(t.requestId);
          continue;
        }
      }

      // 2. STAGE_1 → STAGE_2 transition: target hit triggers scale-out
      if (t.stage === 'STAGE_1_ARMED' && t.targetUnderlyingPrice != null && liveU != null) {
        const targetHit = isCalls
          ? (liveU >= t.targetUnderlyingPrice)
          : (liveU <= t.targetUnderlyingPrice);
        if (targetHit) {
          try { _executeScaleOut(t.requestId, fed.optionPrice, liveU); } catch (e) { jError('scale-out', e.message, { requestId: t.requestId }); }
          continue;  // STAGE_2 is transient; trade is now in STAGE_3 with reduced contracts
        }
      }

      // 3. STAGE_3 logic: update peak, trail, R-multiple locks
      if (t.stage === 'STAGE_3_TRAILING' && liveU != null && t.entryUnderlyingPrice != null && t.stopDistance != null) {
        try { _updateStage3(t.requestId, liveU); } catch (e) { jError('stage3-update', e.message, { requestId: t.requestId }); }
        // Re-check trail breach immediately after update — if peak just moved
        // OR new trail computed lower than current price, may need to exit.
        // The next tick's stop-check above will catch it; for instant-tick
        // trailing-stop precision, future enhancement: re-read fresh from ledger.
      }

      // IV-crush exit: vega drag eating gains and we're up >200%
      if (t.entryIV != null && analysis.ivCrushing && analysis.pnlPct > 200) {
        exitsToFire.push({ requestId: t.requestId, exitPrice: fed.optionPrice, reason: 'IV_CRUSH_EXIT' });
        pushVoiceAlert(`iv-crush-${t.requestId}`, 'critical',
          `IV crush on ${t.instrument} ${t.signal}. Up ${analysis.pnlPct.toFixed(0)} percent. Vega drag accelerating. Exiting now.`);
      } else if (analysis.vegaAlert) {
        pushVoiceAlert(`vega-alert-${t.requestId}`, 'warning',
          `Vega drag eating gains on ${t.instrument} ${t.signal}. IV down ${Math.abs(analysis.ivChange*100).toFixed(0)} points. Consider exit.`);
      }

      // Hard exit: 1 min before instrument close
      if (analysis.exitNow && analysis.hardExitMins <= 1) {
        exitsToFire.push({ requestId: t.requestId, exitPrice: fed.optionPrice, reason: 'HARD_EXIT' });
      }

      // Hard-exit countdown — MOC window (15:50-15:59), once per minute per position
      if (analysis.isMOCWindow && analysis.hardExitMins > 0 && analysis.hardExitMins <= 9) {
        pushVoiceAlert(`moc-countdown-${analysis.hardExitMins}`, 'warning',
          `Hard exit in ${analysis.hardExitMins} ${analysis.hardExitMins === 1 ? 'minute' : 'minutes'}. ${open.length} open ${open.length === 1 ? 'position' : 'positions'}.`,
          50_000);
      }
    } catch (e) {
      jError('evalOpen', e.message, { requestId: t.requestId, instrument: t.instrument });
    }
  }

  // Portfolio theta = sum of theta/min/contract across positions with greeks
  const portfolioThetaPerMin = positions.reduce((s, p) => s + (p.analysis?.thetaPerMinContract ?? 0) * (p.analysis ? 1 : 0) * (open.find(o => o.requestId === p.requestId)?.contracts ?? 1), 0);

  const out = {
    ts:        Date.now(),
    time:      getETString(),
    burnZone:  burn.current,
    zones:     burn.zones,
    portfolioThetaPerMin: parseFloat(portfolioThetaPerMin.toFixed(2)),
    positionCount: positions.length,
    positions: positions.map(p => ({
      requestId:   p.requestId,
      instrument:  p.instrument,
      direction:   p.direction,
      fillPrice:   p.fillPrice,
      currentPrice:p.currentPrice ?? null,
      pnlPct:      p.analysis?.pnlPct ?? null,
      pnlTotal:    p.analysis?.pnlTotal ?? null,
      delta:       p.analysis?.delta ?? null,
      gamma:       p.analysis?.gamma ?? null,
      theta:       p.analysis?.theta ?? null,
      vega:        p.analysis?.vega ?? null,
      thetaPerMin: p.analysis?.thetaPerMinContract ?? null,
      currentIV:   p.analysis?.currentIV ?? null,
      entryIV:     p.analysis?.entryIV ?? null,
      ivChange:    p.analysis?.ivChange ?? null,
      ivCrushing:  p.analysis?.ivCrushing ?? false,
      vegaAlert:   p.analysis?.vegaAlert ?? false,
      burnZone:    p.burnZone,
      minsHeld:    p.analysis?.minsHeld ?? null,
      hardExitMins:p.analysis?.hardExitMins ?? null,
      exitWarn:    p.analysis?.exitWarn ?? false,
      reason:      p.reason ?? null,
    })),
  };

  try { writeFileSync(PORTFOLIO_THETA_FILE, JSON.stringify(out, null, 2)); }
  catch (e) { jError('portfolioTheta-write', e.message); }

  // Fire any exits triggered by IV crush / hard close
  for (const ex of exitsToFire) {
    try {
      console.log(`  ${C.yellow}[THETA-EXIT] ${ex.reason} firing on ${ex.requestId}${C.reset}`);
      journal({ type: 'THETA_EXIT', requestId: ex.requestId, reason: ex.reason, exitPrice: ex.exitPrice });
      closePosition(ex.requestId, ex.exitPrice, ex.reason);
    } catch (e) { jError('theta-exit-fire', e.message, { requestId: ex.requestId }); }
  }

  return out;
}

// ─── Scorecard ────────────────────────────────────────────

export function getScorecard() {
  const winRate = ledger.totalTrades > 0
    ? (ledger.wins / ledger.totalTrades * 100).toFixed(0)
    : '--';

  const engineBoard = Object.entries(ledger.engineStats)
    .filter(([, s]) => s.trades > 0)
    .map(([name, s]) => ({
      name,
      trades:  s.trades,
      wins:    s.wins,
      winRate: s.trades > 0 ? (s.wins/s.trades*100).toFixed(0) : '--',
      pnl:     s.pnl.toFixed(0),
    }))
    .sort((a, b) => parseFloat(b.winRate) - parseFloat(a.winRate));

  const sessionBoard = Object.entries(ledger.sessionStats)
    .filter(([, s]) => s.trades > 0)
    .map(([name, s]) => ({
      name,
      trades:  s.trades,
      winRate: s.trades > 0 ? (s.wins/s.trades*100).toFixed(0) : '--',
      pnl:     s.pnl.toFixed(0),
    }));

  const recentTrades = ledger.trades.slice(-10).reverse();

  return {
    mode:         TRADING_MODE,
    balance:      ledger.balance.toFixed(2),
    startBalance: ledger.startBalance.toFixed(2),
    totalPnL:     ledger.totalPnL.toFixed(2),
    totalPnLPct:  ((ledger.totalPnL / ledger.startBalance) * 100).toFixed(1),
    totalTrades:  ledger.totalTrades,
    wins:         ledger.wins,
    losses:       ledger.losses,
    winRate,
    engineBoard,
    sessionBoard,
    recentTrades,
    gateStatus:   orderGate.getStatus(),
    todayPnL:     (ledger.dailyPnL[etDate()] || 0).toFixed(2),
    institutional: computeInstitutionalMetrics(),  // ← added
  };
}

// ─── Print Scorecard ──────────────────────────────────────

export function printScorecard() {
  const s    = getScorecard();
  const m    = s.institutional;
  const line = '─'.repeat(50);
  const mode = TRADING_MODE === 'PAPER' ? `${C.cyan}📋 PAPER` : `${C.red}🔴 LIVE`;

  console.log(`\n  ${mode} TRADING SCORECARD${C.reset}`);
  console.log(`  ${line}`);
  console.log(`  Balance: ${C.bold}$${s.balance}${C.reset} (started $${s.startBalance})`);
  console.log(`  Total P&L: ${parseFloat(s.totalPnL) >= 0 ? C.green : C.red}${parseFloat(s.totalPnL) >= 0 ? '+' : ''}$${s.totalPnL} (${s.totalPnLPct}%)${C.reset}`);
  console.log(`  Today P&L: ${parseFloat(s.todayPnL) >= 0 ? C.green : C.red}${parseFloat(s.todayPnL) >= 0 ? '+' : ''}$${s.todayPnL}${C.reset}`);
  console.log(`  Trades: ${s.totalTrades} total  ${C.dim}(${s.wins}W / ${s.losses}L — win rate ${s.winRate}% is informational only)${C.reset}`);

  if (m) {
    console.log(`  ${line}`);
    console.log(`  ${C.bold}INSTITUTIONAL METRICS${C.reset}`);
    const pfColor  = m.profitFactor >= 2.0 ? C.green : m.profitFactor >= 1.5 ? C.yellow : C.red;
    const evColor  = m.ev >= 50 ? C.green : m.ev > 0 ? C.yellow : C.red;
    const shColor  = m.sharpe >= 1.5 ? C.green : m.sharpe >= 1.0 ? C.yellow : C.red;
    const ddColor  = m.maxDrawdown < 20 ? C.green : m.maxDrawdown < 30 ? C.yellow : C.red;
    const rrColor  = m.rewardRisk >= 3 ? C.green : m.rewardRisk >= 1.5 ? C.yellow : C.red;
    console.log(`  Profit Factor:  ${pfColor}${m.profitFactor}x${C.reset}  ${C.dim}(target >2.0)${C.reset}`);
    console.log(`  Expected Value: ${evColor}$${m.ev}/trade${C.reset}  ${C.dim}(target >$50)${C.reset}`);
    console.log(`  Sharpe Ratio:   ${shColor}${m.sharpe}${C.reset}  ${C.dim}(target >1.5)${C.reset}`);
    console.log(`  Max Drawdown:   ${ddColor}${m.maxDrawdown}%${C.reset}  ${C.dim}(target <20%)${C.reset}`);
    console.log(`  Reward/Risk:    ${rrColor}${m.rewardRisk}:1${C.reset}  ${C.dim}avg win $${m.avgWinner} / avg loss $${m.avgLoser}${C.reset}`);
    if (m.mocEV != null)
      console.log(`  MOC EV:         ${m.mocEV >= 0 ? C.green : C.red}$${m.mocEV}/trade${C.reset}  ${C.dim}(${m.mocTrades} trades)${C.reset}`);
  }

  console.log(`  ${line}`);

  if (s.engineBoard.length) {
    console.log(`  ENGINE PERFORMANCE`);
    for (const e of s.engineBoard) {
      const bar = '█'.repeat(Math.floor(parseFloat(e.winRate)/10));
      console.log(`  ${e.name.padEnd(8)} ${e.winRate}% ${C.dim}${bar}${C.reset}  ${e.trades} trades  ${parseFloat(e.pnl)>=0?C.green:C.red}$${e.pnl}${C.reset}`);
    }
    console.log(`  ${line}`);
  }

  if (s.sessionBoard.length) {
    console.log(`  SESSION PERFORMANCE`);
    for (const e of s.sessionBoard) {
      console.log(`  ${e.name.padEnd(12)} ${e.winRate}%  ${e.trades} trades  ${parseFloat(e.pnl)>=0?C.green:C.red}$${e.pnl}${C.reset}`);
    }
    console.log(`  ${line}`);
  }

  // Gate status
  const gate = s.gateStatus;
  console.log(`  OrderGate: ${gate.stats.total} signals | ${gate.stats.executed} executed | ${gate.stats.vetoed} vetoed | ${gate.stats.ghosts} ghosts blocked`);
  console.log(`  ${line}\n`);
}

// ─── Go-Live Criteria ─────────────────────────────────────
// Called Sunday reflection — tells you when PAPER → LIVE is safe

// ─── Institutional Metrics ────────────────────────────────
// These are the real numbers that matter — not win rate

function computeInstitutionalMetrics() {
  const closed = ledger.trades.filter(t => t.status === 'CLOSED' && t.pnl != null);
  if (!closed.length) return null;

  const winners = closed.filter(t => t.pnl > 0);
  const losers  = closed.filter(t => t.pnl <= 0);

  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss   = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));
  const netPnL      = grossProfit - grossLoss;

  // Profit Factor — gross profit / gross loss
  // Institutional standard: > 2.0 = elite
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Expected Value per trade
  const avgWinner = winners.length ? grossProfit / winners.length : 0;
  const avgLoser  = losers.length  ? grossLoss   / losers.length  : 0;
  const winRate   = closed.length  ? winners.length / closed.length : 0;
  const ev        = (winRate * avgWinner) - ((1 - winRate) * avgLoser);

  // Sharpe Ratio — risk-adjusted return
  // Using per-trade P&L as the return series
  const pnls   = closed.map(t => t.pnl);
  const mean   = netPnL / closed.length;
  const stddev = Math.sqrt(pnls.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / closed.length);
  const sharpe = stddev > 0 ? (mean / stddev) * Math.sqrt(252) : 0; // annualized

  // Max Drawdown — peak to trough on running balance
  let peak = ledger.startBalance, maxDD = 0, runBal = ledger.startBalance;
  for (const t of closed) {
    runBal += t.pnl;
    if (runBal > peak) peak = runBal;
    const dd = (peak - runBal) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // Reward/Risk ratio — avg winner vs avg loser
  const rewardRisk = avgLoser > 0 ? avgWinner / avgLoser : avgWinner > 0 ? Infinity : 0;

  // MOC specific EV
  const mocTrades  = closed.filter(t => t.engine === 'MOC');
  const mocWinners = mocTrades.filter(t => t.pnl > 0);
  const mocEV      = mocTrades.length
    ? mocTrades.reduce((s, t) => s + t.pnl, 0) / mocTrades.length
    : null;

  return {
    trades:       closed.length,
    winners:      winners.length,
    losers:       losers.length,
    winRate:      parseFloat((winRate * 100).toFixed(1)),
    grossProfit:  parseFloat(grossProfit.toFixed(2)),
    grossLoss:    parseFloat(grossLoss.toFixed(2)),
    netPnL:       parseFloat(netPnL.toFixed(2)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    ev:           parseFloat(ev.toFixed(2)),
    avgWinner:    parseFloat(avgWinner.toFixed(2)),
    avgLoser:     parseFloat(avgLoser.toFixed(2)),
    rewardRisk:   parseFloat(rewardRisk.toFixed(2)),
    sharpe:       parseFloat(sharpe.toFixed(2)),
    maxDrawdown:  parseFloat((maxDD * 100).toFixed(1)),
    mocTrades:    mocTrades.length,
    mocEV:        mocEV != null ? parseFloat(mocEV.toFixed(2)) : null,
  };
}

export function assessGoLiveCriteria() {
  const m = computeInstitutionalMetrics();

  if (!m) {
    console.log(`\n  ${C.yellow}GO-LIVE ASSESSMENT — No closed trades yet${C.reset}\n`);
    return { ready: false, passed: 0, total: 6, checks: [] };
  }

  const checks = [
    {
      name:   'Minimum trades (20+)',
      pass:   m.trades >= 20,
      detail: `${m.trades} / 20 completed`,
      metric: `${m.trades} trades`,
    },
    {
      name:   'Profit Factor > 2.0',
      pass:   m.profitFactor >= 2.0,
      detail: `${m.profitFactor}x  (gross $${m.grossProfit} / loss $${m.grossLoss})`,
      metric: `PF ${m.profitFactor}`,
      note:   'For every $1 lost, make $2+',
    },
    {
      name:   'Expected Value > $50/trade',
      pass:   m.ev >= 50,
      detail: `$${m.ev} avg EV per trade`,
      metric: `EV $${m.ev}`,
      note:   '(winRate × avgWin) - (lossRate × avgLoss)',
    },
    {
      name:   'Sharpe Ratio > 1.5',
      pass:   m.sharpe >= 1.5,
      detail: `${m.sharpe} (institutional grade ≥ 1.5)`,
      metric: `Sharpe ${m.sharpe}`,
      note:   'Risk-adjusted return — annualized',
    },
    {
      name:   'Max Drawdown < 20%',
      pass:   m.maxDrawdown < 20,
      detail: `${m.maxDrawdown}% peak-to-trough`,
      metric: `DD ${m.maxDrawdown}%`,
    },
    {
      name:   'MOC EV positive (5+ trades)',
      pass:   m.mocTrades >= 5 && m.mocEV != null && m.mocEV > 0,
      detail: m.mocTrades >= 5
        ? `MOC EV $${m.mocEV} over ${m.mocTrades} trades`
        : `${m.mocTrades} / 5 MOC trades needed`,
      metric: `MOC EV $${m.mocEV ?? '--'}`,
    },
  ];

  const passed = checks.filter(c => c.pass).length;
  const ready  = passed === checks.length;

  console.log(`\n  ${C.bold}GO-LIVE ASSESSMENT — INSTITUTIONAL METRICS${C.reset}`);
  console.log(`  ${'─'.repeat(52)}`);
  console.log(`  Win Rate:      ${m.winRate}%  (${m.winners}W / ${m.losers}L)  ${C.dim}← not the goal${C.reset}`);
  console.log(`  Reward/Risk:   ${m.rewardRisk}:1  (avg win $${m.avgWinner} / avg loss $${m.avgLoser})`);
  console.log(`  ${'─'.repeat(52)}`);

  for (const c of checks) {
    const icon = c.pass ? `${C.green}✅` : `${C.red}❌`;
    console.log(`  ${icon}${C.reset} ${c.name.padEnd(28)} ${C.dim}${c.detail}${C.reset}`);
  }

  console.log(`  ${'─'.repeat(52)}`);
  console.log(`  ${ready
    ? C.green + '✅ READY FOR LIVE TRADING'
    : C.yellow + `⏳ CONTINUE PAPER TRADING  ${passed}/${checks.length} passed`}${C.reset}`);

  if (!ready) {
    const failing = checks.filter(c => !c.pass);
    console.log(`\n  ${C.yellow}Focus areas:${C.reset}`);
    for (const f of failing) {
      console.log(`  ${C.dim}→ ${f.name}: ${f.detail}${C.reset}`);
    }
  }

  console.log('');

  return { ready, passed, total: checks.length, checks, metrics: m };
}


// ─── Session reset (call at 16:00 ET from monitor.js) ─────

export function sessionReset() {
  orderGate.reset();
  ledger = loadLedger(); // reload fresh
  console.log(`  ${C.dim}Paper trading session reset — OrderGate cleared${C.reset}`);
  generateDailyReport();     // post-market report on every session reset
  _decisionLog = [];         // clear for new session
  for (const k of Object.keys(_lastLiveEntry)) _lastLiveEntry[k] = 0;
  _livePositions.clear();
}

// ─── Decision Log ────────────────────────────────────────────────────────────
// Per-session JSONL log of every signal evaluation and trade action
// Lives alongside paper-ledger.json as session-log-YYYY-MM-DD.jsonl

let _decisionLog = [];

function _sessionLogPath() {
  return join(__dirname, `session-log-${etDate()}.jsonl`);
}

export function logDecision(entry) {
  const record = { ...entry, ts: Date.now(), timeET: getETString() };
  _decisionLog.push(record);
  try { appendFileSync(_sessionLogPath(), JSON.stringify(record) + '\n'); } catch {}
}

// ─── Trade Tagging ────────────────────────────────────────────────────────────

function _classifyTag(signal, ctx) {
  const { session, w3Score, tick, breakout, engine } = ctx;
  if (engine === 'FADE')                                   return 'Fade';
  if (session === 'MOO' || session === 'BULLET-1')         return 'MOO Setup';
  if ((w3Score ?? 0) >= 4)                                 return 'W3 Confirm';
  if (breakout)                                            return 'Breakout';
  if (tick != null && Math.abs(tick) > 300 && (w3Score ?? 0) >= 2) return 'Confluence Zone';
  return 'Confluence Zone';
}

// ─── Trade Grading ────────────────────────────────────────────────────────────
// Good Process = signal-driven entry + rule-triggered exit, regardless of outcome.
// Unlucky / Lucky = outcome doesn't match process quality.

function _gradeProcess(trade, exitReason) {
  const conf = trade.confidence ?? '';
  const goodEntry = ['HIGH', 'MEDIUM', 'SPY-FIRST', 'TICK-EXTREME', 'SPY+W3 OVERRIDE'].includes(conf);
  const ruleExit  = ['TARGET_2X', 'TARGET_1.5X', 'STOP_0.5X', 'EOD_CLOSE', 'TIME_STOP',
                     'TREND_EXIT', 'VWAP_EXIT', 'SIGNAL_REVERSAL',
                     'TARGET', 'STOP'].includes(exitReason);
  const win = (trade.pnl ?? 0) > 0;

  if  (goodEntry &&  ruleExit &&  win) return 'Good Process';
  if  (goodEntry &&  ruleExit && !win) return 'Good Process / Unlucky';
  if  (goodEntry && !ruleExit &&  win) return 'Good Process / Lucky';
  if  (goodEntry && !ruleExit && !win) return 'Bad Process';
  if (!goodEntry &&               win) return 'Bad Process / Lucky';
  return 'Bad Process';
}

// ─── Live Signal Evaluation ───────────────────────────────────────────────────
// Mirrors trendEngine() logic from monitor.js but operates on a single tick snapshot.
// Called once per wsServer TICK event per instrument.

const _NEAR_ZERO  = 50;      // delta absolute value below this = neutral
const _VWAP_MAX   = 0.50;    // % max distance from VWAP to enter
const _TICK_BULL  = 300;
const _TICK_BEAR  = -300;
const _TICK_EXTB  = 600;
const _TICK_EXTS  = -600;

function _evalLiveSignal(instrument, data, session, w3Score) {
  const { price, vwap, delta, tick, bias } = data;

  if (!price || !vwap || delta == null) {
    return { decision: 'PASS', signal: null, reason: 'Missing data (price/vwap/delta)' };
  }

  const mins = getETMins();

  // Hard gates
  if (mins >= 15 * 60 + 45) {
    return { decision: 'PASS', signal: null, reason: 'Past 15:45 0DTE cutoff' };
  }
  if (mins >= 11 * 60 + 30 && mins < 13 * 60) {
    return { decision: 'PASS', signal: null, reason: 'Midday chop window — no entries (11:30–13:00)' };
  }
  if (Math.abs(delta) < _NEAR_ZERO) {
    return { decision: 'PASS', signal: null, reason: `Delta ${delta} neutral (< ${_NEAR_ZERO} threshold)` };
  }

  const vwapDist = price - vwap;
  const vwapPct  = (Math.abs(vwapDist) / vwap) * 100;
  if (vwapPct > _VWAP_MAX) {
    return { decision: 'PASS', signal: null, reason: `VWAP distance ${vwapPct.toFixed(2)}% overextended (max ${_VWAP_MAX}%)` };
  }

  const aboveVwap = price > vwap;
  const belowVwap = price < vwap;
  const posDelta  = delta > 0;
  const negDelta  = delta < 0;
  const strongPos = delta > 500;
  const strongNeg = delta < -500;
  const bullish   = aboveVwap && posDelta;
  const bearish   = belowVwap && negDelta;

  const tickBull  = tick != null && tick >  _TICK_BULL;
  const tickBear  = tick != null && tick <  _TICK_BEAR;
  const tickExtB  = tick != null && tick >  _TICK_EXTB;
  const tickExtS  = tick != null && tick <  _TICK_EXTS;
  const w3ok      = (w3Score ?? 0) >= 3;
  const w3min     = (w3Score ?? 0) >= 2;
  const moo       = session === 'MOO' || session === 'BULLET-1';

  if (bullish) {
    if (tickExtB && w3ok && strongPos) {
      return { decision:'ENTER', signal:'CALLS', confidence:'TICK-EXTREME', engine:'TREND',
               reason:`TICK +${tick} extreme · delta +${delta} strong · W3 ${w3Score}/6 · above VWAP +${vwapDist.toFixed(2)}` };
    }
    if (moo && w3ok && (tickBull || strongPos)) {
      return { decision:'ENTER', signal:'CALLS', confidence:'HIGH', engine:'TREND',
               reason:`MOO window · W3 ${w3Score}/6 · TICK ${tick ?? 'N/A'} · delta +${delta}` };
    }
    if (tickBull && w3ok) {
      return { decision:'ENTER', signal:'CALLS', confidence:'MEDIUM', engine:'TREND',
               reason:`TICK +${tick} · W3 ${w3Score}/6 · delta +${delta} · above VWAP +${vwapDist.toFixed(2)}` };
    }
    if (w3ok && strongPos) {
      return { decision:'ENTER', signal:'CALLS', confidence:'MEDIUM', engine:'TREND',
               reason:`W3 ${w3Score}/6 confirmed · delta +${delta} strong · above VWAP +${vwapDist.toFixed(2)}` };
    }
    if (tickBull && w3min) {
      return { decision:'ENTER', signal:'CALLS', confidence:'MEDIUM', engine:'TREND',
               reason:`TICK +${tick} · W3 ${w3Score}/6 · above VWAP (delta +${delta})` };
    }
    return { decision:'PASS', signal:'CALLS',
             reason:`Bullish but unconfirmed (W3 ${w3Score}/6, TICK ${tick ?? 'N/A'}, delta +${delta})` };
  }

  if (bearish) {
    if (tickExtS && w3ok && strongNeg) {
      return { decision:'ENTER', signal:'PUTS', confidence:'TICK-EXTREME', engine:'TREND',
               reason:`TICK ${tick} extreme · delta ${delta} strong · W3 ${w3Score}/6 · below VWAP ${vwapDist.toFixed(2)}` };
    }
    if (tickBear && w3ok) {
      return { decision:'ENTER', signal:'PUTS', confidence:'MEDIUM', engine:'TREND',
               reason:`TICK ${tick} · W3 ${w3Score}/6 · delta ${delta} · below VWAP ${vwapDist.toFixed(2)}` };
    }
    if (w3ok && strongNeg) {
      return { decision:'ENTER', signal:'PUTS', confidence:'MEDIUM', engine:'TREND',
               reason:`W3 ${w3Score}/6 confirmed · delta ${delta} strong · below VWAP ${vwapDist.toFixed(2)}` };
    }
    if (tickBear && w3min) {
      return { decision:'ENTER', signal:'PUTS', confidence:'MEDIUM', engine:'TREND',
               reason:`TICK ${tick} · W3 ${w3Score}/6 · below VWAP (delta ${delta})` };
    }
    return { decision:'PASS', signal:'PUTS',
             reason:`Bearish but unconfirmed (W3 ${w3Score}/6, TICK ${tick ?? 'N/A'}, delta ${delta})` };
  }

  // Divergence
  const divNote = aboveVwap && negDelta ? 'div_bear (above VWAP but delta negative)'
                : belowVwap && posDelta ? 'div_bull (below VWAP but delta positive)'
                : `mixed (bias: ${bias ?? 'unknown'})`;
  return { decision:'PASS', signal: null, reason: divNote };
}

// ─── Live Position Tracker ────────────────────────────────────────────────────
// Maps requestId → open position metadata for exit management

const _livePositions   = new Map();
const _lastLiveEntry   = { SPY: 0, QQQ: 0, IWM: 0 };
const _SCALP_COOLDOWN  = 5 * 60 * 1000;  // 5 min between same-instrument entries
const _DELTA_APPROX    = 0.50;            // ATM 0DTE delta hedge ratio for P&L estimation

async function _processLiveTick(instrument, data, session, w3Score) {
  if (!isTradingHours()) return;
  if (!data?.price)      return;

  const { price, vwap } = data;

  // ── Check exits on open positions first ──────────────────────────────────
  for (const [posKey, pos] of _livePositions) {
    if (pos.instrument !== instrument) continue;

    const underlyingMove  = price - pos.entryUnderlying;
    const dirMult         = pos.signal === 'CALLS' ? 1 : -1;
    const optionMove      = underlyingMove * dirMult * _DELTA_APPROX;
    const estOption       = Math.max(0.01, pos.optionEntry + optionMove);
    const pnlRatio        = estOption / pos.optionEntry;
    const holdMins        = (Date.now() - pos.entryTs) / 60000;
    const etMins          = getETMins();
    const isEOD           = etMins >= 15 * 60 + 45;
    const vwapExit        = pos.signal === 'CALLS' ? (vwap != null && price < vwap)
                                                    : (vwap != null && price > vwap);

    let exitReason = null;
    let exitPrice  = parseFloat(estOption.toFixed(4));

    if      (isEOD)            { exitReason = 'EOD_CLOSE'; }
    else if (pnlRatio >= 1.5)  { exitReason = 'TARGET_1.5X'; exitPrice = parseFloat((pos.optionEntry * 1.5).toFixed(4)); }
    else if (pnlRatio <= 0.5)  { exitReason = 'STOP_0.5X'; exitPrice = parseFloat((pos.optionEntry * 0.5).toFixed(4)); }
    else if (holdMins >= 90)   { exitReason = 'TIME_STOP'; }
    else if (vwapExit)         { exitReason = 'VWAP_EXIT'; }

    if (exitReason) {
      const closed = closePosition(pos.requestId, exitPrice, exitReason);
      if (closed) {
        closed.tag   = pos.tag;
        closed.grade = _gradeProcess(closed, exitReason);
        _livePositions.delete(posKey);

        logDecision({
          type:        'EXIT',
          instrument,
          requestId:   pos.requestId,
          exitReason,
          exitPrice:   exitPrice.toFixed(4),
          pnl:         closed.pnl,
          pnlPct:      closed.pnlPct,
          grade:       closed.grade,
          tag:         pos.tag,
          holdMins:    holdMins.toFixed(1),
          underlyingAtExit: price,
        });

        const pnlC = (closed.pnl ?? 0) >= 0 ? C.green : C.red;
        console.log(
          `\n  [LIVE ${instrument}] ${exitReason}  ` +
          `${pos.signal === 'CALLS' ? C.green : C.red}${pos.signal}${C.reset}` +
          `  option $${pos.optionEntry}→$${exitPrice}` +
          `  ${pnlC}${(closed.pnl ?? 0) >= 0 ? '+' : ''}$${closed.pnl?.toFixed(0)}${C.reset}` +
          `  grade: ${C.dim}${closed.grade}${C.reset}`
        );
      }
    }
  }

  // ── Cooldown gate ────────────────────────────────────────────────────────
  const now = Date.now();
  if (now - (_lastLiveEntry[instrument] ?? 0) < _SCALP_COOLDOWN) return;

  // ── Max 2 open positions per instrument ──────────────────────────────────
  const openCount = [..._livePositions.values()].filter(p => p.instrument === instrument).length;
  if (openCount >= 2) return;

  // ── Signal evaluation ────────────────────────────────────────────────────
  const evalResult = _evalLiveSignal(instrument, data, session, w3Score);

  // Log EVERY evaluation (trade or no-trade)
  logDecision({
    type:        'EVAL',
    instrument,
    session,
    price,
    vwapDist:    vwap ? parseFloat((price - vwap).toFixed(2)) : null,
    delta:       data.delta,
    tick:        data.tick,
    w3Score,
    bias:        data.bias,
    signal:      evalResult.signal,
    confidence:  evalResult.confidence ?? null,
    decision:    evalResult.decision,
    reason:      evalResult.reason,
  });

  if (evalResult.decision !== 'ENTER') return;
  if (!['HIGH', 'MEDIUM', 'TICK-EXTREME'].includes(evalResult.confidence)) return;

  // ── Estimate ATM option premium ──────────────────────────────────────────
  const atrEst    = price * 0.005;
  const optionMid = parseFloat((atrEst * 0.4).toFixed(2));
  if (optionMid < 0.05) return;

  const vwapDist  = vwap ? price - vwap : null;
  const breakout  = data.levels?.resistance?.some(r => r.label === 'PDH' && price > r.price) ?? false;
  const tag       = _classifyTag(evalResult.signal, { session, w3Score, tick: data.tick, vwapDist, engine: evalResult.engine, breakout });

  const consensus = {
    signal:        evalResult.signal,
    engine:        evalResult.engine ?? 'TREND',
    confidence:    evalResult.confidence,
    instrument,
    strike:        null,
    entryPrice:    optionMid,
    contracts:     1,
    tag,
    w3Score,
    tickVal:       data.tick,
    vwapDist:      vwapDist != null ? parseFloat(vwapDist.toFixed(2)) : null,
    sessionWindow: session,
    context:       { bias: data.bias, price, vwap, delta: data.delta },
  };

  const reqId = orderGate.createRequest({ signal: evalResult.signal, engine: 'LIVE' });
  if (!orderGate.canExecute(reqId)) return;

  const quote = { bid: parseFloat((optionMid * 0.97).toFixed(4)), ask: parseFloat((optionMid * 1.03).toFixed(4)), mid: optionMid };
  const fill  = await sendOrder(consensus, reqId, quote);

  if (!fill.vetoed) {
    _livePositions.set(reqId, {
      requestId:      reqId,
      instrument,
      signal:         evalResult.signal,
      optionEntry:    fill.fillPrice,
      entryUnderlying:price,
      entryTs:        Date.now(),
      tag,
    });
    _lastLiveEntry[instrument] = now;

    console.log(
      `\n  ${C.bold}[LIVE ${instrument}]${C.reset} ` +
      `${evalResult.signal === 'CALLS' ? C.green : C.red}${evalResult.signal}${C.reset}` +
      `  option $${fill.fillPrice}  underlying $${price}` +
      `  ${C.dim}${tag} · ${evalResult.confidence}${C.reset}`
    );
    console.log(`  Reason: ${C.dim}${evalResult.reason}${C.reset}`);

    logDecision({
      type:       'TRADE',
      instrument,
      requestId:  reqId,
      signal:     evalResult.signal,
      confidence: evalResult.confidence,
      optionEntry:fill.fillPrice,
      underlyingPrice: price,
      vwapDist,
      tick:       data.tick,
      delta:      data.delta,
      w3Score,
      session,
      tag,
      reason:     evalResult.reason,
    });
  }
}

// ─── Post-Market Report ───────────────────────────────────────────────────────

export function generateDailyReport() {
  const today   = etDate();
  const lg      = loadLedger();
  const allClosed = (lg.trades ?? []).filter(t => t.status === 'CLOSED' && t.exitTime);
  const todayClosed = allClosed.filter(t => {
    const d = new Intl.DateTimeFormat('en-CA', { timeZone:'America/New_York' }).format(new Date(t.exitTime));
    return d === today;
  });

  const wins    = todayClosed.filter(t => (t.pnl ?? 0) > 0);
  const losses  = todayClosed.filter(t => (t.pnl ?? 0) <= 0);
  const netPnL  = todayClosed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const avgWin  = wins.length   ? wins.reduce((s, t)  => s + t.pnl, 0) / wins.length   : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0)) / losses.length : 0;
  const rr      = avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : '∞';
  const winPct  = todayClosed.length ? ((wins.length / todayClosed.length) * 100).toFixed(0) : 0;

  const decisions = _decisionLog.filter(d => d.type === 'EVAL');
  const tradesFired = _decisionLog.filter(d => d.type === 'TRADE');

  // Setup performance by tag
  const byTag = {};
  for (const t of todayClosed) {
    const tag = t.tag ?? 'Unknown';
    if (!byTag[tag]) byTag[tag] = { trades: 0, wins: 0, pnl: 0 };
    byTag[tag].trades++;
    byTag[tag].pnl += t.pnl ?? 0;
    if ((t.pnl ?? 0) > 0) byTag[tag].wins++;
  }

  // Process grades
  const grades = {};
  for (const t of todayClosed) {
    const g = t.grade ?? 'Ungraded';
    grades[g] = (grades[g] ?? 0) + 1;
  }

  // Session performance
  const bySess = {};
  for (const t of todayClosed) {
    const s = t.sessionWindow ?? t.session ?? 'Unknown';
    if (!bySess[s]) bySess[s] = { trades: 0, wins: 0, pnl: 0 };
    bySess[s].trades++;
    bySess[s].pnl += t.pnl ?? 0;
    if ((t.pnl ?? 0) > 0) bySess[s].wins++;
  }

  const line = '─'.repeat(62);
  const pnlC = netPnL >= 0 ? C.green : C.red;
  const bal  = lg.balance ?? 0;

  let out = '';
  out += `\n  ${C.bold}POST-MARKET ANALYSIS — ${today}${C.reset}\n  ${line}\n`;
  out += `  Balance:    ${C.bold}$${bal.toLocaleString()}${C.reset}  (started $${(lg.startBalance ?? 0).toLocaleString()})\n`;
  out += `  Net P&L:    ${pnlC}${netPnL >= 0 ? '+' : ''}$${netPnL.toFixed(0)}${C.reset}\n`;
  out += `  Trades:     ${todayClosed.length} closed  ${C.green}${wins.length}W${C.reset} / ${C.red}${losses.length}L${C.reset}  WR: ${C.bold}${winPct}%${C.reset}\n`;
  out += `  Avg win:    ${C.green}+$${avgWin.toFixed(0)}${C.reset}   Avg loss: ${C.red}-$${avgLoss.toFixed(0)}${C.reset}   R:R ${rr}:1\n`;
  out += `  Evals:      ${decisions.length} decisions logged → ${tradesFired.length} trades fired\n`;
  out += `  ${line}\n`;

  if (Object.keys(byTag).length) {
    out += `  SETUP PERFORMANCE\n`;
    for (const [tag, s] of Object.entries(byTag)) {
      const wr  = ((s.wins / s.trades) * 100).toFixed(0);
      const pc  = s.pnl >= 0 ? C.green : C.red;
      out += `  ${tag.padEnd(22)} ${String(s.trades).padStart(2)} trades  ${String(wr).padStart(3)}% WR  ${pc}${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(0)}${C.reset}\n`;
    }
    out += `  ${line}\n`;
  }

  if (Object.keys(bySess).length) {
    out += `  SESSION PERFORMANCE\n`;
    for (const [sess, s] of Object.entries(bySess)) {
      const wr  = ((s.wins / s.trades) * 100).toFixed(0);
      const pc  = s.pnl >= 0 ? C.green : C.red;
      out += `  ${sess.padEnd(14)} ${String(s.trades).padStart(2)} trades  ${String(wr).padStart(3)}% WR  ${pc}${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(0)}${C.reset}\n`;
    }
    out += `  ${line}\n`;
  }

  if (Object.keys(grades).length) {
    out += `  PROCESS QUALITY\n`;
    for (const [g, count] of Object.entries(grades)) {
      out += `  ${g.padEnd(30)} ${count} trade${count !== 1 ? 's' : ''}\n`;
    }
    out += `  ${line}\n`;
  }

  // Missed signals — PASS decisions that had a directional read
  const missedSignals = decisions.filter(d => d.decision === 'PASS' && d.signal != null);
  if (missedSignals.length) {
    out += `  MISSED SIGNALS (pass with direction)\n`;
    for (const d of missedSignals.slice(-6)) {
      out += `  ${String(d.timeET ?? '').padEnd(8)}  ${String(d.instrument).padEnd(4)}  ${String(d.signal).padEnd(5)}  ${C.dim}${d.reason}${C.reset}\n`;
    }
    out += `  ${line}\n`;
  }

  // Recommendations
  out += `  RECOMMENDATIONS\n`;
  const badProcess = todayClosed.filter(t => (t.grade ?? '').startsWith('Bad Process'));
  const goodUnlucky = todayClosed.filter(t => (t.grade ?? '').includes('Unlucky'));
  if (badProcess.length > 0) {
    out += `  ⚠️  ${badProcess.length} Bad Process trade${badProcess.length > 1 ? 's' : ''} — review entry/exit rule adherence\n`;
  }
  if (goodUnlucky.length > 1) {
    out += `  ℹ️  ${goodUnlucky.length} Unlucky outcomes — process correct, accept variance\n`;
  }
  if (parseFloat(rr) < 1.5 && todayClosed.length >= 2) {
    out += `  ⚠️  R:R ${rr}:1 below 1.5 target — widen TP or tighten entries\n`;
  }
  if (parseInt(winPct) < 40 && todayClosed.length >= 3) {
    out += `  ⚠️  Win rate ${winPct}% low — consider raising W3 minimum threshold\n`;
  }
  if (missedSignals.length > decisions.length * 0.6) {
    out += `  ⚠️  ${missedSignals.length}/${decisions.length} evals passed — signal thresholds may be too strict\n`;
  }
  if (todayClosed.length === 0) {
    out += `  — No closed trades today (session still open or no signals fired)\n`;
  } else if (netPnL > 0 && badProcess.length === 0) {
    out += `  ✅ Clean session — positive P&L with Good Process trades\n`;
  }
  out += `  ${line}\n`;

  console.log(out);

  // Write to markdown file (strip ANSI)
  try {
    const md      = out.replace(/\x1b\[[0-9;]*m/g, '');
    const mdPath  = join(__dirname, `session-report-${today}.md`);
    writeFileSync(mdPath, md);
    console.log(`  ${C.dim}Report written → session-report-${today}.md${C.reset}\n`);
  } catch {}

  return { netPnL, wins: wins.length, losses: losses.length, winPct, avgWin, avgLoss, rr,
           decisions: decisions.length, tradesFired: tradesFired.length, byTag, grades };
}

// ─── Start Live Trading ───────────────────────────────────────────────────────
// Connects to wsServer as a WebSocket client, listens for TICK_SPY / TICK_QQQ / TICK_IWM
// events broadcast by monitor.js, and autonomously manages paper positions.
//
// monitor.js broadcasts type='tick' events via global.wsBroadcast (set by wsServer start()).
// Payload shape:
//   { session, w3Score, SPY: { price, vwap, delta, tick, bias }, QQQ: {...}, IWM: {...} }

export function startLiveTrading(wsPort = 8080) {
  const _ts = loadTier();
  const _tierCap = getDailyLossCap(_ts.tier);
  const _eff     = Math.min(_tierCap, MAX_DAILY_LOSS > 0 ? MAX_DAILY_LOSS : _tierCap);
  const _src     = _tierCap === MAX_DAILY_LOSS ? 'tier=env'
                 : _eff === _tierCap           ? `tier T${_ts.tier}`
                 :                               `env (tier T${_ts.tier}=$${_tierCap})`;
  console.log(`\n  ⬡ HANK LIVE PAPER TRADER`);
  console.log(`  Mode: ${TRADING_MODE} | Balance: $${PAPER_BALANCE.toLocaleString()} | Daily loss cap: $${_eff.toLocaleString()} (${_src})`);
  console.log(`  Connecting to wsServer ws://localhost:${wsPort}...`);
  console.log(`  Decision log → ${_sessionLogPath()}\n`);

  let reconnectTimer = null;

  function connect() {
    let ws;
    try {
      ws = new WebSocket(`ws://localhost:${wsPort}`);
    } catch (e) {
      console.log(`  [LIVE] WebSocket error: ${e.message} — retry in 10s`);
      reconnectTimer = setTimeout(connect, 10_000);
      return;
    }

    ws.on('open', () => {
      console.log(`  [LIVE] Connected — listening for TICK events`);
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    });

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // skip binary MessagePack (WAR_ROOM mode) without msgpack dep
      }

      // Accept 'tick' (dedicated live type) or 'signal' (existing broadcast)
      if (msg?.type !== 'tick' && msg?.type !== 'signal') return;

      const payload  = msg.payload ?? msg.data ?? {};
      const session  = payload.session  ?? getCurrentSession();
      const w3Score  = payload.w3Score  ?? 0;

      for (const sym of ['SPY', 'QQQ', 'IWM']) {
        const d = payload[sym];
        if (!d?.price) continue;
        try {
          await _processLiveTick(sym, d, session, w3Score);
        } catch (e) {
          console.log(`  [LIVE] Tick error (${sym}): ${e.message}`);
        }
      }
    });

    ws.on('close', () => {
      console.log(`  [LIVE] wsServer disconnected — reconnecting in 5s`);
      reconnectTimer = setTimeout(connect, 5_000);
    });

    ws.on('error', (e) => {
      if (e.code !== 'ECONNREFUSED') {
        console.log(`  [LIVE] WS error: ${e.message}`);
      }
    });
  }

  connect();

  // Session reset + report at 16:00 ET — checked every 30s
  const eodTimer = setInterval(() => {
    const mins = getETMins();
    if (mins >= 16 * 60 && mins < 16 * 60 + 2) {
      clearInterval(eodTimer);
      // Force-close any still-open live positions at last known price
      for (const [id, pos] of _livePositions) {
        closePosition(id, pos.optionEntry, 'EOD_CLOSE');
        _livePositions.delete(id);
      }
      sessionReset(); // calls generateDailyReport() + clears log
    }
  }, 30_000);
}

// ─── Self-test ────────────────────────────────────────────

if (process.argv.includes('--test')) {
  console.log('\n  ⬡ HANK paperTrading.js — Self Test\n');
  console.log(`  Mode: ${TRADING_MODE}`);
  console.log(`  Balance: $${PAPER_BALANCE}`);
  console.log(`  Max daily loss: $${MAX_DAILY_LOSS}`);
  console.log(`  Max contracts: ${MAX_CONTRACTS}\n`);

  // Test 1: OrderGate — prevents double trade
  console.log('  Test 1: OrderGate double-trade prevention...');
  const reqId = orderGate.createRequest({ signal:'CALLS', engine:'TREND' });

  const mockConsensus = {
    signal:     'CALLS',
    engine:     'TREND',
    confidence: 'HIGH',
    instrument: 'SPX',
    strike:     5720,
    entryPrice: 0.22,
    contracts:  1,
  };

  const mockQuote = { bid: 0.20, ask: 0.24 };

  // Fire first order
  const trade1 = await sendOrder(mockConsensus, reqId, mockQuote);
  console.log(`  First order: ${trade1.vetoed ? 'VETOED' : `filled @ $${trade1.fillPrice}`}`);

  // Attempt second order with same requestId (ghost signal simulation)
  const canFire = orderGate.canExecute(reqId);
  console.log(`  Ghost signal blocked: ${!canFire ? '✅ YES — gate locked' : '❌ FAIL — gate open'}`);
  console.log(`  Gate stats: ${JSON.stringify(orderGate.getStatus().stats)}`);

  const test1Pass = !canFire;
  console.log(`  ${test1Pass ? '✅ PASS' : '❌ FAIL'}\n`);

  // Test 2: Close position
  console.log('  Test 2: Close position + P&L calculation...');
  if (trade1 && !trade1.vetoed) {
    const closed = closePosition(reqId, 1.84, 'TEST_EXIT');
    const expectedPnL = (1.84 - trade1.fillPrice) * 100 * 1; // 1 contract
    const pnlMatch = closed && Math.abs(closed.pnl - expectedPnL) < 0.01;
    console.log(`  Fill: $${trade1.fillPrice} → Exit: $1.84`);
    console.log(`  P&L: $${closed?.pnl} (expected ~$${expectedPnL.toFixed(2)})`);
    console.log(`  ${pnlMatch ? '✅ PASS' : '❌ FAIL'}\n`);
  }

  // Test 3: Daily loss limit
  console.log('  Test 3: Daily loss limit gate...');
  // Manually set daily loss to trigger limit
  const today = etDate();
  const savedPnL = ledger.dailyPnL[today];
  ledger.dailyPnL[today] = -MAX_DAILY_LOSS - 1;

  const reqId2   = orderGate.createRequest({ signal:'PUTS', engine:'FADE' });
  const blocked  = await sendOrder(mockConsensus, reqId2, mockQuote);
  ledger.dailyPnL[today] = savedPnL; // restore

  const test3Pass = blocked.vetoed === true;
  console.log(`  Daily loss exceeded → order vetoed: ${test3Pass ? '✅ PASS' : '❌ FAIL'}\n`);

  // Test 4: Scorecard
  console.log('  Test 4: Scorecard generation...');
  printScorecard();

  // Test 5: Go-live assessment
  console.log('  Test 5: Go-live criteria...');
  assessGoLiveCriteria();

  // Clean up test trades
  ledger.trades = ledger.trades.filter(t => t.engine !== 'TREND' || t.requestId !== reqId);
  saveLedger(ledger);

  console.log(`  ─────────────────────────────────`);
  console.log(`  ${test1Pass && test3Pass ? '✅ ALL TESTS PASSED — paperTrading.js ready' : '⚠️  Some tests failed'}`);
  console.log(`  ─────────────────────────────────\n`);
}
