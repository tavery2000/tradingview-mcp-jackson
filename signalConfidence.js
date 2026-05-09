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
 */

import { stackConfidence } from './multipliers.js';
import { getDailyBias }    from './daily-bias.js';

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

export { BASE_FOR_CONFIDENCE };
