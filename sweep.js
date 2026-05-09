/**
 * sweep.js — Liquidity sweep detection + cooldown.
 *
 * Two regimes — both watch the same level set, fire on different cadences:
 *
 *   Regime A: closed-bar (5M)
 *     - Upper wick:  bar.high > level && bar.close < level && wickPct > 50%
 *                    → PUT setup (bull stops swept, reversal lower)
 *     - Lower wick:  bar.low  < level && bar.close > level && wickPct > 50%
 *                    → CALL setup (bear stops swept, reversal higher)
 *
 *   Regime B: intrabar (30s tick)
 *     - price crosses level by >0.10 × ATR(5M) AND ticks back through within
 *       a small window → fast scalp signal before the 5M bar closes
 *
 * Levels watched (passed in by caller, source from levels JSON files):
 *   PDH, PDL, ONH (overnight high), ONL (overnight low),
 *   OR_HIGH, OR_LOW (opening range), HOD, LOD, NEWS_HIGH, NEWS_LOW
 *
 * Cooldown: 15 min per (level price ± tolerance) to prevent re-firing on
 * the same wick. State persisted per-instrument:
 *   sweep-state-{SPY|QQQ|IWM}.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { atr, closedBars } from './analyze.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Tunables ───────────────────────────────────────────
const COOLDOWN_MS         = 15 * 60_000;
const WICK_PCT_THRESHOLD  = 0.50;             // wick must be >50% of bar range (Regime A)
const INTRABAR_ATR_MULT   = 0.10;             // tick must penetrate level by >= 0.10 × ATR (Regime B)
const PRICE_TOLERANCE_PCT = 0.0005;            // 0.05% — ~$0.35 on SPY at $700; cooldown bucket size
const MAX_SWEEPS_RETAINED = 200;
const STATE_VERSION       = 1;

// Level types we track for sweeps. Anything else passed in `levels` is
// ignored. This keeps the sweep engine deliberately scoped.
const SWEEP_LEVEL_LABELS = new Set([
  'PDH', 'PDL', 'ONH', 'ONL', 'OR_HIGH', 'OR_LOW',
  'HOD', 'LOD', 'NEWS_HIGH', 'NEWS_LOW',
]);

// ─── State IO ───────────────────────────────────────────
function statePath(instrument) {
  return join(__dirname, `sweep-state-${instrument}.json`);
}

export function loadSweepState(instrument) {
  const p = statePath(instrument);
  if (!existsSync(p)) {
    return { version: STATE_VERSION, instrument, sweeps: [], cooldowns: {}, lastScan: 0 };
  }
  try {
    const s = JSON.parse(readFileSync(p, 'utf8'));
    if (!Array.isArray(s.sweeps)) s.sweeps = [];
    if (!s.cooldowns || typeof s.cooldowns !== 'object') s.cooldowns = {};
    s.instrument = instrument;
    s.version    = s.version ?? STATE_VERSION;
    return s;
  } catch {
    return { version: STATE_VERSION, instrument, sweeps: [], cooldowns: {}, lastScan: 0 };
  }
}

export function saveSweepState(instrument, state) {
  if (state.sweeps.length > MAX_SWEEPS_RETAINED) {
    state.sweeps = state.sweeps.slice(-MAX_SWEEPS_RETAINED);
  }
  // Prune stale cooldowns so the file doesn't grow unbounded
  const now = Date.now();
  for (const k of Object.keys(state.cooldowns)) {
    if (now - state.cooldowns[k] > COOLDOWN_MS * 4) delete state.cooldowns[k];
  }
  state.lastScan = now;
  writeFileSync(statePath(instrument), JSON.stringify(state, null, 2));
}

// ─── Helpers ────────────────────────────────────────────
// Cooldown key buckets nearby prices together — within PRICE_TOLERANCE_PCT.
function cooldownKey(level, price) {
  const bucketed = Math.round(price / (price * PRICE_TOLERANCE_PCT)) * (price * PRICE_TOLERANCE_PCT);
  return `${level.label}:${bucketed.toFixed(2)}`;
}

export function inCooldown(state, level, price, now = Date.now()) {
  const key = cooldownKey(level, price);
  const last = state?.cooldowns?.[key];
  return last != null && (now - last) < COOLDOWN_MS;
}

function setCooldown(state, level, price, now = Date.now()) {
  state.cooldowns ||= {};
  state.cooldowns[cooldownKey(level, price)] = now;
}

function eligibleLevels(levels) {
  if (!levels) return [];
  const all = [
    ...(levels.resistance ?? []),
    ...(levels.support    ?? []),
  ];
  return all.filter(l => SWEEP_LEVEL_LABELS.has(l.label));
}

// ─── Regime A: closed-bar (5M) ──────────────────────────
export function detectSweepClosed(barsIn, levels) {
  const bars = closedBars(barsIn);
  if (bars.length < 2) return null;
  const b = bars[bars.length - 1];
  const range = b.high - b.low;
  if (range <= 0) return null;

  const upperWick = b.high - Math.max(b.open, b.close);
  const lowerWick = Math.min(b.open, b.close) - b.low;
  const upperPct  = upperWick / range;
  const lowerPct  = lowerWick / range;

  for (const lvl of eligibleLevels(levels)) {
    // Bullish-side liquidity grab: wick above resistance, close back below
    if (b.high > lvl.price && b.close < lvl.price && upperPct >= WICK_PCT_THRESHOLD) {
      return {
        id:        `SWEEP_A_${b.time}_${lvl.label}`,
        regime:    'A',
        type:      'UPPER_WICK',
        signal:    'PUTS',
        level:     lvl,
        wickPenetration: b.high - lvl.price,
        wickPct:   upperPct,
        bar:       { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close },
        time:      b.time,
        status:    'fresh',
      };
    }
    // Bearish-side liquidity grab: wick below support, close back above
    if (b.low < lvl.price && b.close > lvl.price && lowerPct >= WICK_PCT_THRESHOLD) {
      return {
        id:        `SWEEP_A_${b.time}_${lvl.label}`,
        regime:    'A',
        type:      'LOWER_WICK',
        signal:    'CALLS',
        level:     lvl,
        wickPenetration: lvl.price - b.low,
        wickPct:   lowerPct,
        bar:       { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close },
        time:      b.time,
        status:    'fresh',
      };
    }
  }
  return null;
}

// ─── Regime B: intrabar (30s tick) ──────────────────────
// Caller passes the previous tick price plus current price. A sweep fires
// when price penetrated a level beyond INTRABAR_ATR_MULT × ATR and then
// reversed back through within the same poll.
export function detectSweepIntrabar({ price, prevPrice, prevExtremeHigh, prevExtremeLow, levels, atr5M }) {
  if (price == null || prevPrice == null || !atr5M) return null;
  const buffer = atr5M * INTRABAR_ATR_MULT;
  if (!(buffer > 0)) return null;

  for (const lvl of eligibleLevels(levels)) {
    // Upper-wick sweep: high in this poll exceeded level by buffer, current price below level
    if (prevExtremeHigh != null && prevExtremeHigh > lvl.price + buffer && price < lvl.price) {
      return {
        id:        `SWEEP_B_${Date.now()}_${lvl.label}`,
        regime:    'B',
        type:      'UPPER_WICK',
        signal:    'PUTS',
        level:     lvl,
        wickPenetration: prevExtremeHigh - lvl.price,
        atrAtSignal: atr5M,
        time:      Math.floor(Date.now() / 1000),
        status:    'fresh',
      };
    }
    // Lower-wick sweep
    if (prevExtremeLow != null && prevExtremeLow < lvl.price - buffer && price > lvl.price) {
      return {
        id:        `SWEEP_B_${Date.now()}_${lvl.label}`,
        regime:    'B',
        type:      'LOWER_WICK',
        signal:    'CALLS',
        level:     lvl,
        wickPenetration: lvl.price - prevExtremeLow,
        atrAtSignal: atr5M,
        time:      Math.floor(Date.now() / 1000),
        status:    'fresh',
      };
    }
  }
  return null;
}

// ─── Recording + cooldown gate ──────────────────────────
// Returns true if the sweep was recorded; false if blocked by cooldown.
export function recordSweep(state, sweep) {
  if (!state || !sweep) return false;
  if (state.sweeps.some(s => s.id === sweep.id)) return false;     // dedup
  if (inCooldown(state, sweep.level, sweep.level.price)) {
    sweep.status = 'cooldown_blocked';
    return false;
  }
  state.sweeps.push(sweep);
  setCooldown(state, sweep.level, sweep.level.price);
  return true;
}

// ─── Public orchestration ───────────────────────────────
export function scanClosedBar(instrument, bars5M, levels) {
  const state = loadSweepState(instrument);
  const sweep = detectSweepClosed(bars5M, levels);
  let fired = false;
  if (sweep) fired = recordSweep(state, sweep);
  saveSweepState(instrument, state);
  return { sweep: fired ? sweep : null, blocked: !!sweep && !fired, state };
}

export function scanIntrabar(instrument, args) {
  const state = loadSweepState(instrument);
  const sweep = detectSweepIntrabar(args);
  let fired = false;
  if (sweep) fired = recordSweep(state, sweep);
  saveSweepState(instrument, state);
  return { sweep: fired ? sweep : null, blocked: !!sweep && !fired, state };
}

// Recent sweeps within the lookback window — used by strategies that want
// to confirm "we just swept liquidity" before firing a follow-through entry.
export function getRecentSweeps(state, lookbackMs = 30 * 60_000) {
  if (!state || !Array.isArray(state.sweeps)) return [];
  const cutoff = Math.floor((Date.now() - lookbackMs) / 1000);
  return state.sweeps.filter(s => s.time >= cutoff);
}

// ─── Entry engine ───────────────────────────────────────
// Fires when a recent sweep is followed by a confirming bar in the
// reversal direction. Sweep direction already encodes which side took
// liquidity — we just need bar-level confirmation that the reversal stuck.
//
//   Lower-wick sweep (signal CALLS):
//     c0.close > c0.open AND c0.close > sweep.bar.close (or c1.close)
//     → CALLS follow-through
//
//   Upper-wick sweep (signal PUTS):
//     c0.close < c0.open AND c0.close < sweep.bar.close (or c1.close)
//     → PUTS follow-through
//
// Confidence:
//   HIGH    when wick penetration >= ATR(5M) (deep stop-run)
//   MEDIUM  otherwise
const ENTRY_LOOKBACK_MS = 10 * 60_000;   // only act on sweeps in the last 10 min

export function sweepEntryEngine(input) {
  const { recentSweeps, bars, atr5M } = input || {};
  const fresh = (recentSweeps ?? []).filter(s => !s.firedAt);
  if (!fresh.length) return null;

  const closed = closedBars(bars);
  if (closed.length < 2) return null;
  const c0 = closed[closed.length - 1];
  const c1 = closed[closed.length - 2];

  const cutoff = Math.floor((Date.now() - ENTRY_LOOKBACK_MS) / 1000);
  const candidates = fresh.filter(s => s.time >= cutoff)
                          .sort((a, b) => b.time - a.time);   // newest first

  for (const sweep of candidates) {
    if (c0.time <= sweep.time) continue;     // bar must be after the sweep

    const sweepCloseRef = sweep.bar?.close ?? c1.close;
    const atrRef = atr5M ?? sweep.atrAtSignal ?? 0;
    const isStrong = atrRef > 0 && (sweep.wickPenetration ?? 0) >= atrRef;

    if (sweep.signal === 'CALLS') {
      const greenBar = c0.close > c0.open;
      const aboveSweep = c0.close > sweepCloseRef;
      const higherClose = c0.close > c1.close;
      if (greenBar && aboveSweep && higherClose) {
        return {
          action:     'CALLS',
          confidence: isStrong ? 'HIGH' : 'MEDIUM',
          engine:     'SWEEP',
          event:      'SWEEP_FOLLOWTHROUGH_BULL',
          reason:     `${sweep.regime}-regime sweep ↓ ${sweep.level.label} $${sweep.level.price.toFixed(2)} reclaimed · pen ${sweep.wickPenetration?.toFixed(2)}`,
          sweepId:    sweep.id,
          meta:       { sweepRegime: sweep.regime, level: sweep.level, wickPenetration: sweep.wickPenetration },
        };
      }
    } else if (sweep.signal === 'PUTS') {
      const redBar = c0.close < c0.open;
      const belowSweep = c0.close < sweepCloseRef;
      const lowerClose = c0.close < c1.close;
      if (redBar && belowSweep && lowerClose) {
        return {
          action:     'PUTS',
          confidence: isStrong ? 'HIGH' : 'MEDIUM',
          engine:     'SWEEP',
          event:      'SWEEP_FOLLOWTHROUGH_BEAR',
          reason:     `${sweep.regime}-regime sweep ↑ ${sweep.level.label} $${sweep.level.price.toFixed(2)} rejected · pen ${sweep.wickPenetration?.toFixed(2)}`,
          sweepId:    sweep.id,
          meta:       { sweepRegime: sweep.regime, level: sweep.level, wickPenetration: sweep.wickPenetration },
        };
      }
    }
  }
  return null;
}

// Mark a sweep as fired so subsequent polls don't re-trigger on the same setup.
export function markSweepFired(instrument, sweepId) {
  if (!sweepId) return false;
  const state = loadSweepState(instrument);
  const sweep = state.sweeps.find(s => s.id === sweepId);
  if (!sweep || sweep.firedAt) return false;
  sweep.firedAt = Math.floor(Date.now() / 1000);
  saveSweepState(instrument, state);
  return true;
}

export {
  COOLDOWN_MS, WICK_PCT_THRESHOLD, INTRABAR_ATR_MULT,
  PRICE_TOLERANCE_PCT, SWEEP_LEVEL_LABELS, STATE_VERSION,
};
