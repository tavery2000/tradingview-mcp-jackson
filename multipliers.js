/**
 * multipliers.js — Confidence stacking engine.
 *
 * Composes the four factors that scale a strategy's base confidence into
 * its final confidence score:
 *
 *   final = base × time_mult × bias_mult × macro4H_alignment   (capped 2.5)
 *
 *   base               from the strategy itself (numeric, typically 0.5–1.0)
 *   time_mult          from session window (PRE_MARKET..MOC), per engine
 *   bias_mult          from market bias regime × signal direction
 *   macro4H_alignment  1.0 (aligned), 0.85 (RANGING/UNKNOWN), 0.6 (counter)
 *
 * Time weights are loaded from strategy-time-weights.json so the user can
 * tune live without restarting monitors. If the file is missing, sane
 * defaults are used.
 *
 * stackConfidence() is the only public function intended for engines —
 * everything else is exported for inspection / tests / dashboard surfacing.
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Hard ceiling — even a perfect alignment shouldn't 5× our base position.
const FINAL_CAP = 2.5;

// ─── Sessions (US/ET) ───────────────────────────────────
// Returned by getSession(date). Strategies look up their time multiplier
// keyed on this string. Hours are inclusive-start, exclusive-end.
const SESSIONS = [
  { name: 'PRE_MARKET',  startMin:  4*60,        endMin:  9*60+25 },
  { name: 'MOO',         startMin:  9*60+25,     endMin:  9*60+35 },
  { name: 'OPEN',        startMin:  9*60+35,     endMin: 10*60     },
  { name: 'TREND_TIME',  startMin: 10*60,         endMin: 11*60+30 },
  { name: 'UK_CLOSE',    startMin: 11*60+30,     endMin: 12*60     },
  { name: 'MIDDAY',      startMin: 12*60,         endMin: 14*60     },
  { name: 'AFTERNOON',   startMin: 14*60,         endMin: 15*60+30 },
  { name: 'PRE_MOC',     startMin: 15*60+30,     endMin: 15*60+50 },
  { name: 'MOC',         startMin: 15*60+50,     endMin: 16*60     },
  // Anything else falls through to AH (after-hours / overnight)
];

export function getSession(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const h = parseInt(parts.find(p => p.type === 'hour').value,   10);
  const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
  const min = h * 60 + m;
  for (const s of SESSIONS) {
    if (min >= s.startMin && min < s.endMin) return s.name;
  }
  return 'AH';
}

// ─── Default time weights ───────────────────────────────
// engine → session → multiplier. Missing entries default to 1.0.
// Tuned from 20yr discretionary edge: TREND wants TREND_TIME, FADE wants
// OPEN, SWEEP wants OPEN/PRE_MOC stop-runs, etc.
const DEFAULT_TIME_WEIGHTS = {
  TREND: {
    PRE_MARKET: 0.0, MOO: 0.5, OPEN: 1.3, TREND_TIME: 1.5,
    UK_CLOSE: 1.0, MIDDAY: 0.7, AFTERNOON: 1.1, PRE_MOC: 1.0, MOC: 0.8, AH: 0.0,
  },
  BOUNCE: {
    OPEN: 0.9, TREND_TIME: 1.2, UK_CLOSE: 1.1, MIDDAY: 1.3,
    AFTERNOON: 1.0, PRE_MOC: 0.8, MOC: 0.5,
  },
  STRUCTURE: {
    PRE_MARKET: 0.5, MOO: 0.7, OPEN: 1.0, TREND_TIME: 1.3,
    MIDDAY: 1.0, AFTERNOON: 1.2, PRE_MOC: 1.0, MOC: 0.7,
  },
  SWING: {
    OPEN: 0.8, TREND_TIME: 1.4, MIDDAY: 1.0, AFTERNOON: 1.2, PRE_MOC: 0.7, MOC: 0.4,
  },
  FADE: {
    PRE_MARKET: 0.0, MOO: 0.6, OPEN: 1.5, TREND_TIME: 0.9,
    MIDDAY: 1.0, AFTERNOON: 0.8, PRE_MOC: 0.7, MOC: 0.5,
  },
  FVG: {
    OPEN: 1.0, TREND_TIME: 1.3, UK_CLOSE: 1.0, MIDDAY: 1.1,
    AFTERNOON: 1.1, PRE_MOC: 0.9, MOC: 0.5,
  },
  SWEEP: {
    OPEN: 1.4, TREND_TIME: 1.2, UK_CLOSE: 1.0, MIDDAY: 0.9,
    AFTERNOON: 1.1, PRE_MOC: 1.3, MOC: 0.6,
  },
};

let _weightsCache = null;
let _weightsCacheAt = 0;
const WEIGHTS_TTL_MS = 30_000;   // re-read every 30s so live edits apply quickly

export function loadWeights() {
  if (_weightsCache && Date.now() - _weightsCacheAt < WEIGHTS_TTL_MS) return _weightsCache;
  const file = join(__dirname, 'strategy-time-weights.json');
  let user = {};
  if (existsSync(file)) {
    try { user = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  }
  // Merge user overrides on top of defaults — engine-by-engine
  const merged = {};
  for (const eng of Object.keys(DEFAULT_TIME_WEIGHTS)) {
    merged[eng] = { ...DEFAULT_TIME_WEIGHTS[eng], ...(user[eng] || {}) };
  }
  for (const eng of Object.keys(user)) {
    if (!merged[eng]) merged[eng] = user[eng];
  }
  _weightsCache   = merged;
  _weightsCacheAt = Date.now();
  return merged;
}

export function getTimeMultiplier(engine, session) {
  const w = loadWeights();
  const eng = w[engine];
  if (!eng) return 1.0;
  const v = eng[session];
  return Number.isFinite(v) ? v : 1.0;
}

// ─── Bias multiplier matrix ─────────────────────────────
// Six regimes × seven engines × {long, short}. CALLS = long, PUTS = short.
// All multipliers gravitate to 1.0 = neutral, with edge cases pushing up
// (favored) or down (penalized) depending on regime/direction alignment.
const BIAS_MATRIX = {
  TRENDING_BULL: {
    TREND:     { long: 1.4, short: 0.5 },
    BOUNCE:    { long: 1.3, short: 0.6 },
    STRUCTURE: { long: 1.2, short: 0.7 },
    SWING:     { long: 1.3, short: 0.5 },
    FADE:      { long: 0.7, short: 1.2 },
    FVG:       { long: 1.2, short: 0.7 },
    SWEEP:     { long: 1.3, short: 0.6 },
  },
  TRENDING_BEAR: {
    TREND:     { long: 0.5, short: 1.4 },
    BOUNCE:    { long: 0.6, short: 1.3 },
    STRUCTURE: { long: 0.7, short: 1.2 },
    SWING:     { long: 0.5, short: 1.3 },
    FADE:      { long: 1.2, short: 0.7 },
    FVG:       { long: 0.7, short: 1.2 },
    SWEEP:     { long: 0.6, short: 1.3 },
  },
  CHOPPY: {
    TREND:     { long: 0.6, short: 0.6 },
    BOUNCE:    { long: 1.1, short: 1.1 },
    STRUCTURE: { long: 0.9, short: 0.9 },
    SWING:     { long: 0.5, short: 0.5 },
    FADE:      { long: 1.2, short: 1.2 },
    FVG:       { long: 0.9, short: 0.9 },
    SWEEP:     { long: 1.0, short: 1.0 },
  },
  REVERSAL_DAY: {
    TREND:     { long: 0.5, short: 0.5 },
    BOUNCE:    { long: 1.2, short: 1.2 },
    STRUCTURE: { long: 0.8, short: 0.8 },
    SWING:     { long: 0.6, short: 0.6 },
    FADE:      { long: 1.4, short: 1.4 },
    FVG:       { long: 1.0, short: 1.0 },
    SWEEP:     { long: 1.3, short: 1.3 },
  },
  GAP_AND_GO: {
    TREND:     { long: 1.5, short: 1.5 },
    BOUNCE:    { long: 0.8, short: 0.8 },
    STRUCTURE: { long: 1.2, short: 1.2 },
    SWING:     { long: 1.0, short: 1.0 },
    FADE:      { long: 0.5, short: 0.5 },
    FVG:       { long: 1.3, short: 1.3 },
    SWEEP:     { long: 1.0, short: 1.0 },
  },
  COILED: {
    TREND:     { long: 1.1, short: 1.1 },
    BOUNCE:    { long: 0.7, short: 0.7 },
    STRUCTURE: { long: 1.3, short: 1.3 },
    SWING:     { long: 1.0, short: 1.0 },
    FADE:      { long: 0.6, short: 0.6 },
    FVG:       { long: 1.0, short: 1.0 },
    SWEEP:     { long: 0.9, short: 0.9 },
  },
};

export function getBiasMultiplier(engine, marketBias, direction) {
  const regime = BIAS_MATRIX[marketBias];
  if (!regime) return 1.0;                  // unknown bias → neutral
  const slot = regime[engine];
  if (!slot) return 1.0;
  return direction === 'CALLS' ? slot.long : direction === 'PUTS' ? slot.short : 1.0;
}

// ─── Macro 4H alignment ─────────────────────────────────
// macroDir from analyze4H().direction: 'UP' | 'DOWN' | 'RANGING' | 'UNKNOWN'
// direction: 'CALLS' | 'PUTS'
export function getMacro4HAlignment(macroDir, direction) {
  if (macroDir === 'UP'   && direction === 'CALLS') return 1.0;
  if (macroDir === 'DOWN' && direction === 'PUTS')  return 1.0;
  if (macroDir === 'UP'   && direction === 'PUTS')  return 0.6;
  if (macroDir === 'DOWN' && direction === 'CALLS') return 0.6;
  return 0.85;   // RANGING / UNKNOWN — slight dampener, not a kill
}

// ─── Public: stack confidence ───────────────────────────
// Returns { final, breakdown } so callers can journal exactly why a
// signal got the weight it did. Never throws — bad inputs degrade to 1.0.
export function stackConfidence({ base, engine, marketBias, macro4H, direction, now }) {
  const session = getSession(now);
  const time    = getTimeMultiplier(engine, session);
  const bias    = getBiasMultiplier(engine, marketBias, direction);
  const macro   = getMacro4HAlignment(macro4H, direction);
  const baseN   = Number.isFinite(base) ? base : 1.0;
  const raw     = baseN * time * bias * macro;
  const final   = Math.min(FINAL_CAP, Math.max(0, raw));
  return {
    final,
    capped: raw > FINAL_CAP,
    breakdown: { base: baseN, time, bias, macro4H: macro, session, raw, final },
  };
}

// ─── Helpers used by the dashboard / journal ────────────
export function describeStack(s) {
  const b = s.breakdown;
  return `${b.base.toFixed(2)} × t${b.time.toFixed(2)}@${b.session} × bias${b.bias.toFixed(2)} × m4H${b.macro4H.toFixed(2)} = ${b.final.toFixed(2)}${s.capped ? ' (capped)' : ''}`;
}

export { BIAS_MATRIX, DEFAULT_TIME_WEIGHTS, FINAL_CAP, SESSIONS };
