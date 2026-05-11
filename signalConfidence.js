/**
 * signalConfidence.js — Glue between strategy signals and the multiplier engine.
 *
 * Each monitor's poll loop computes one analysis context (4H direction +
 * market-bias regime) and reuses it for every signal that fires that poll.
 * `applyMultipliers(signal, ctx)` converts the legacy string confidence
 * (HIGH/MEDIUM/LOW) into a numeric `finalConfidence` via stackConfidence,
 * which paperTrading.sendOrder reads to size positions through tier.js.
 *
 * Kept tiny on purpose — three monitors and two sendOrder sites each call
 * this; the alternative is duplicating the base-mapping + bias-normalization
 * + direction-extraction logic six times.
 *
 * ─── Path 2 simplification 2026-05-11 ───────────────────────────────────
 * Operator call after 2h live (3 trades, +$56.24, missed morning rally):
 * the Pine chart's HL/LH/SELL labels are reliable; the HANK monitor's
 * gates were over-filtering them. Chart-engine signals now fire with
 * minimal gating (basic gates + tier sizing only). The gate helpers
 * below — gate1H, gateMacro4H, gateVwap, computeBoosterAdj,
 * computeSpyBoosters — remain exported but are no longer called from
 * monitor.js / monitor-qqq.js / monitor-iwm.js. Kept available so the
 * filters can be re-enabled without restoring deleted logic. See git log
 * for the strip commit.
 */

import { stackConfidence } from './multipliers.js';
import { getDailyBias }    from './daily-bias.js';

// ─── Chart-first hierarchy v2 (2026-05-12) ──────────────────────────────
// Master toggle for the chart-first signal architecture. Defaults ON;
// `HIERARCHY_V2=false` in env restores the legacy dispatch (trendSig/
// buildSignal fires orders directly, no MACRO4H block, no VWAP gate, no
// chart-engine-set check). Every new gate in this file consults this
// constant and falls back to a passthrough when it is false.
export const HIERARCHY_V2 = process.env.HIERARCHY_V2 !== 'false';

// Engines allowed to dispatch when HIERARCHY_V2 is on. SWING is intentionally
// excluded for v1 (see plan § E sub-question 5); SWING continues to fire via
// its own swing-entry path, not executeScalpSignal. TREND/BOUNCE are
// confidence inputs only — they do not appear here.
export const CHART_ENGINE_SET = new Set(['STRUCTURE', 'FVG', 'SWEEP', 'FADE']);

// String → numeric base. TICK-EXTREME/SPY+W3 OVERRIDE are above-HIGH cases
// the trend engine emits; map those to a slight boost over plain HIGH.
const BASE_FOR_CONFIDENCE = {
  'HIGH':                1.0,
  'MEDIUM':              0.7,
  'LOW':                 0.5,
  'NONE':                0.0,
  'TICK-EXTREME':        1.2,
  'SPY+W3 OVERRIDE':     1.2,
};

function baseForConfidence(c) {
  if (typeof c === 'number') return c;
  if (!c) return 0.5;
  return BASE_FOR_CONFIDENCE[c.toString().toUpperCase()] ?? 0.5;
}

// daily-bias.js emits TRENDING_BULL / TRENDING_BEAR / CHOPPY / REVERSAL_DAY /
// COILED. Some legacy strings in monitor.js (GAP_AND_GO_BULL, GAP_AND_GO_BEAR)
// collapse to GAP_AND_GO. Anything else falls back to CHOPPY (neutral).
function normalizeBias(verdictBias) {
  if (!verdictBias) return 'CHOPPY';
  const s = verdictBias.toString();
  if (s === 'TRENDING_BULL' || s === 'TRENDING_BEAR' ||
      s === 'CHOPPY' || s === 'REVERSAL_DAY' || s === 'COILED') return s;
  if (s.startsWith('GAP_AND_GO')) return 'GAP_AND_GO';
  return 'CHOPPY';
}

export function readDailyBiasRegime() {
  try {
    const v = getDailyBias();
    return normalizeBias(v?.verdict?.bias);
  } catch { return 'CHOPPY'; }
}

// Pull the trade direction out of the various signal shapes the engines emit.
// Some engines set `signal: 'CALLS'`, some set `action: 'TAKE CALLS …'`, etc.
function directionFor(signal) {
  if (!signal) return null;
  if (signal.signal === 'CALLS' || signal.signal === 'PUTS') return signal.signal;
  const a = signal.action || '';
  if (a.includes('CALLS')) return 'CALLS';
  if (a.includes('PUTS'))  return 'PUTS';
  return null;
}

/**
 * Stack a signal's confidence using the current poll's analysis context.
 *
 * @param {object} signal           — engine output {action|signal, confidence, engine, ...}
 * @param {object} ctx
 * @param {string} ctx.macro4H      — analyze4H().direction ('UP'|'DOWN'|'RANGING'|'UNKNOWN')
 * @param {string} [ctx.marketBias] — bias regime (defaults to readDailyBiasRegime())
 * @param {Date}   [ctx.now]
 * @returns {{
 *   finalConfidence: number, breakdown: object, capped: boolean,
 *   marketBias: string, macro4H: string, direction: 'CALLS'|'PUTS'|null, engine: string,
 * }}
 */
export function applyMultipliers(signal, ctx = {}) {
  const direction  = directionFor(signal);
  const engine     = signal?.engine || 'TREND';
  const baseRaw    = baseForConfidence(signal?.confidence);
  const baseAdjust = Number.isFinite(ctx.baseAdjust) ? ctx.baseAdjust : 0;
  const base       = Math.max(0, baseRaw + baseAdjust);
  const marketBias = ctx.marketBias ?? readDailyBiasRegime();
  const macro4H    = ctx.macro4H    ?? 'UNKNOWN';
  if (!direction) {
    return { finalConfidence: 0, breakdown: null, capped: false, marketBias, macro4H, direction: null, engine };
  }
  const stack = stackConfidence({ base, engine, marketBias, macro4H, direction, now: ctx.now });
  return {
    finalConfidence: stack.final,
    breakdown:       { ...stack.breakdown, baseRaw, baseAdjust },
    capped:          stack.capped,
    marketBias, macro4H, direction, engine,
  };
}

// ─── 1H positional gate ─────────────────────────────────
// Examines the 1H landscape relative to the signal direction and emits one of:
//   { block: false, baseAdjust:  0.00, reason: null }                — pass
//   { block: false, baseAdjust: -0.15, reason: 'CHASING_EXTENDED' }  — buying near 1H high (or selling near 1H low)
//   { block: false, baseAdjust: +0.10, reason: 'PULLBACK_WITH_TREND' } — buying the dip in TRENDING_BULL (or vice versa)
//   { block: true,                     reason: 'COUNTER_1H_STRUCTURE' } — taking CALLS into LH_LL (or PUTS into HH_HL)
//
// EXTENDED for CALLS = pctOfRange ≥ 0.85 (price is at 1H high — chasing).
// EXTENDED for PUTS  = pctOfRange ≤ 0.15 (price is at 1H low  — chasing).
// PULLBACK for CALLS = pctOfRange in [0.30, 0.65] AND marketBias === TRENDING_BULL.
// PULLBACK for PUTS  = pctOfRange in [0.35, 0.70] AND marketBias === TRENDING_BEAR.
// LH_LL counters CALLS; HH_HL counters PUTS — both block outright.
export function gate1H(signal, analysis1H, marketBias) {
  const direction = directionFor(signal);
  const noop = { block: false, baseAdjust: 0, reason: null, direction };
  if (!direction || !analysis1H || !analysis1H.valid) return noop;

  const sp = analysis1H.structurePattern;
  if (direction === 'CALLS' && sp === 'LH_LL') {
    return { block: true, baseAdjust: 0, reason: 'COUNTER_1H_STRUCTURE_LH_LL', direction };
  }
  if (direction === 'PUTS'  && sp === 'HH_HL') {
    return { block: true, baseAdjust: 0, reason: 'COUNTER_1H_STRUCTURE_HH_HL', direction };
  }

  const p = analysis1H.pctOfRange;
  if (p == null) return noop;

  if (direction === 'CALLS') {
    if (p >= 0.85) return { block: false, baseAdjust: -0.15, reason: 'CHASING_EXTENDED', direction };
    if (p >= 0.30 && p <= 0.65 && marketBias === 'TRENDING_BULL') {
      return { block: false, baseAdjust: 0.10, reason: 'PULLBACK_WITH_TREND', direction };
    }
  } else {
    if (p <= 0.15) return { block: false, baseAdjust: -0.15, reason: 'CHASING_EXTENDED', direction };
    if (p >= 0.35 && p <= 0.70 && marketBias === 'TRENDING_BEAR') {
      return { block: false, baseAdjust: 0.10, reason: 'PULLBACK_WITH_TREND', direction };
    }
  }
  return noop;
}

// ─── Booster math (chart-first v2) ──────────────────────────────────────
// Consensus inputs (Mag-6, W3, TICK, delta, vwap-alignment, volume) feed
// numeric bonuses added to baseConfidence before the multiplier stack runs.
// Caps and direction-direction wiring per plan § C / § E.2.
//
// Inputs are pre-normalized by the monitor that owns them — this function
// is the same shape regardless of instrument. SPY callers stack mag6 + w3
// (different stock universes); QQQ / IWM callers populate only their own
// w3-equivalent slot. Hard cap on additive total: +0.15.
//
// Schema (all fields optional, undefined → 0 contribution):
//   tick         numeric, +0.05 when in correct zone for direction
//   delta        numeric, +0.05 when confirming direction (±$1000 thresh)
//   mag6         numeric, +0.05 when |bulls-bears| ≥ 3 (SPY only)
//   w3           numeric, +0.05 at ≥3 alignment, +0.10 at ≥4 alignment
//   vwap_align   bool,    +0.03 when price on correct side of VWAP
//   vol_burst    bool,    +0.03 when session volPct > 0.50
export function computeBoosterAdj(boosters) {
  if (!boosters) return 0;
  let adj = 0;
  if (Number.isFinite(boosters.tick))    adj += boosters.tick;
  if (Number.isFinite(boosters.delta))   adj += boosters.delta;
  if (Number.isFinite(boosters.mag6))    adj += boosters.mag6;
  if (Number.isFinite(boosters.w3))      adj += boosters.w3;
  if (boosters.vwap_align)               adj += 0.03;
  if (boosters.vol_burst)                adj += 0.03;
  return Math.min(0.15, Math.max(0, adj));
}

// SPY-specific booster builder — stacks Mag-6 + W3 contributions per E.2.
// `consensus` shape: { bulls, bears, w3Score, tick, delta, volPct, price, vwap }.
// Returns the boosters object computeBoosterAdj consumes.
//
// Direction is derived from the signal upstream; the caller passes the
// consensus and signal direction separately. mag6 / w3 are mapped to the
// direction-aware bonus (a bullish Mag-6 majority boosts CALLS, not PUTS).
export function computeSpyBoosters(consensus, direction) {
  if (!consensus) return {};
  const b = {};
  // TICK ±400 (SPY only — QQQ/IWM never populate this slot)
  if (Number.isFinite(consensus.tick)) {
    if (direction === 'CALLS' && consensus.tick >  400) b.tick = 0.05;
    if (direction === 'PUTS'  && consensus.tick < -400) b.tick = 0.05;
  }
  // Delta ±$1000 confirms direction
  if (Number.isFinite(consensus.delta)) {
    if (direction === 'CALLS' && consensus.delta >  1000) b.delta = 0.05;
    if (direction === 'PUTS'  && consensus.delta < -1000) b.delta = 0.05;
  }
  // Mag-6 alignment — +0.05 when 3+ of 6 lean in signal direction
  const bulls = consensus.bulls ?? 0;
  const bears = consensus.bears ?? 0;
  if (direction === 'CALLS' && bulls >= 3 && bulls > bears) b.mag6 = 0.05;
  if (direction === 'PUTS'  && bears >= 3 && bears > bulls) b.mag6 = 0.05;
  // W3 alignment — +0.05 at ≥3, +0.10 at ≥4 (out of 5)
  const w3 = consensus.w3Score ?? 0;
  if (direction === 'CALLS') {
    if (w3 >= 4) b.w3 = 0.10;
    else if (w3 >= 3) b.w3 = 0.05;
  }
  if (direction === 'PUTS') {
    // Bearish W3 = (5 - w3Score) bullish components, so ≥4 bears means w3 ≤ 1
    if (w3 <= 1) b.w3 = 0.10;
    else if (w3 <= 2) b.w3 = 0.05;
  }
  // Volume burst — session > 50% of average bar
  if (Number.isFinite(consensus.volPct) && consensus.volPct > 0.50) b.vol_burst = true;
  // VWAP alignment — correct side
  if (Number.isFinite(consensus.price) && Number.isFinite(consensus.vwap)) {
    if (direction === 'CALLS' && consensus.price > consensus.vwap) b.vwap_align = true;
    if (direction === 'PUTS'  && consensus.price < consensus.vwap) b.vwap_align = true;
  }
  return b;
}

// ─── Macro-4H counter-direction gate ────────────────────────────────────
// HIERARCHY_V2 promotes the legacy 0.6× dampener in multipliers.js to a
// hard block. FADE is exempted (counter-trend by design). RANGING and
// UNKNOWN are non-blocking. The 0.6× dampener stays in multipliers.js as
// forward-compat fallback when HIERARCHY_V2 is false.
export function gateMacro4H(signal, ctx) {
  const noop = { block: false, reason: null };
  if (!HIERARCHY_V2) return noop;
  if (!signal || !ctx) return noop;
  if (signal.engine === 'FADE') return noop;
  const direction = directionFor(signal);
  if (!direction) return noop;
  const m = ctx.macro4H;
  if (direction === 'CALLS' && m === 'DOWN') return { block: true, reason: 'MACRO4H_COUNTER' };
  if (direction === 'PUTS'  && m === 'UP'  ) return { block: true, reason: 'MACRO4H_COUNTER' };
  return noop;
}

// ─── VWAP wrong-side gate ───────────────────────────────────────────────
// Unified ±0.15% tolerance band per E.6. Block when price is on the wrong
// side of VWAP by more than the tolerance; pivots through VWAP at bar-flip
// timing remain allowed. FADE is exempted because the FADE engine fires
// in zones (PDH/PDL, VWAP-1σ, VWAP+1σ) where price is intentionally on the
// "wrong" side relative to a naïve trend interpretation.
export function gateVwap(signal, currentPrice, vwap, tolerancePct = 0.0015) {
  const noop = { block: false, reason: null };
  if (!HIERARCHY_V2) return noop;
  if (!signal) return noop;
  if (signal.engine === 'FADE') return noop;
  if (!Number.isFinite(currentPrice) || !Number.isFinite(vwap) || vwap <= 0) return noop;
  const direction = directionFor(signal);
  if (!direction) return noop;
  if (direction === 'CALLS' && currentPrice < vwap * (1 - tolerancePct)) {
    return { block: true, reason: 'VWAP_WRONG_SIDE' };
  }
  if (direction === 'PUTS' && currentPrice > vwap * (1 + tolerancePct)) {
    return { block: true, reason: 'VWAP_WRONG_SIDE' };
  }
  return noop;
}

export { BASE_FOR_CONFIDENCE };
