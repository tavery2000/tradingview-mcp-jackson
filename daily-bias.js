/**
 * daily-bias.js — HANK daily session classifier
 *
 * Runs at 09:40 ET (after 10-min open range completes) and writes
 * daily-bias.json. Re-evaluates at 12:30 ET to detect afternoon flips.
 *
 * Outputs a verdict the engines use to adjust:
 *   - position sizing (1 vs 2 contracts)
 *   - hold horizon (scalp vs swing)
 *   - stop tightness
 *   - target multiplier
 *   - midday policy (stand_down vs aggressive vs fade_only)
 *
 * Inputs come from spy-levels.json + a `bars` array (recent closed bars from
 * monitor.js). The classifier itself is pure — no I/O — so it can be unit
 * tested with synthetic bars.
 *
 * Verdict types:
 *   TRENDING_BULL   — directional day, ride
 *   TRENDING_BEAR   — directional day, ride
 *   CHOPPY          — range-bound, fade only
 *   REVERSAL_DAY    — gap that reverses, expect afternoon trend opposite to morning
 *   GAP_AND_GO      — large gap holding direction, momentum-only entries
 *   COILED          — pre-catalyst tight range, do not trade until it breaks
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getETMins, getETString } from './theta.js';
import { jAlert, jError } from './journal.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIAS_FILE = join(__dirname, 'daily-bias.json');

/**
 * Pure classifier — given session features, return a verdict.
 *
 * @param {object} feat
 * @param {number} feat.gapPct        — gap from prior close in %
 * @param {number} feat.openRangeHigh — high of first 15 min
 * @param {number} feat.openRangeLow  — low of first 15 min
 * @param {number} feat.openPrice     — open of session
 * @param {number} feat.currentPrice  — price right now
 * @param {number} feat.vwap          — current session VWAP
 * @param {number} feat.atr5d         — 5-day ATR (for normalization)
 * @param {number} feat.volumePct     — current volume vs average (1.0 = normal)
 * @param {string} feat.catalyst      — 'NFP' | 'FOMC' | 'earnings' | 'none'
 * @param {number} [feat.barsAbove]   — # bars above VWAP since open
 * @param {number} [feat.barsBelow]   — # bars below VWAP since open
 * @returns {object} verdict
 */
export function classifyBias(feat) {
  const {
    gapPct, openRangeHigh, openRangeLow, openPrice, currentPrice,
    vwap, atr5d, volumePct = 1.0, catalyst = 'none',
    barsAbove = 0, barsBelow = 0,
  } = feat;

  const orRange = openRangeHigh - openRangeLow;
  const orPctOfATR = atr5d > 0 ? orRange / atr5d : 1.0;

  // Position within the OR (0 = at low, 1 = at high). Values > 1 mean price
  // has extended above the OR high — that's the breakout case.
  const orPos = orRange > 0 ? (currentPrice - openRangeLow) / orRange : 0.5;
  const aboveVwap = currentPrice > vwap;
  const vwapDist  = vwap > 0 ? Math.abs(currentPrice - vwap) / vwap : 0;

  // Breakout magnitude — how far has price extended past the OR boundary,
  // normalized by ATR? > 0.10 means a meaningful breakout (10% of avg daily range).
  const breakoutAbove = atr5d > 0 ? Math.max(0, currentPrice - openRangeHigh) / atr5d : 0;
  const breakoutBelow = atr5d > 0 ? Math.max(0, openRangeLow  - currentPrice) / atr5d : 0;

  // ── 1. COILED — tight OR, low volume, pre-catalyst ──────────────────────
  if (orPctOfATR < 0.30 && volumePct < 0.6) {
    return {
      bias: 'COILED', confidence: 70,
      midDayPolicy: 'stand_down',
      recommendedSize: 0,
      recommendedHold: 'no_trade',
      stopMult: 0.4, targetMult: 1.5, holdMins: 30,
      note: `Tight OR (${(orPctOfATR*100).toFixed(0)}% of ATR), low vol — wait for break`,
    };
  }

  // ── 2. GAP_AND_GO — large gap holding direction ─────────────────────────
  if (Math.abs(gapPct) > 0.50 && (
        (gapPct > 0 && currentPrice >= openPrice) ||
        (gapPct < 0 && currentPrice <= openPrice)
      )) {
    const dir = gapPct > 0 ? 'BULL' : 'BEAR';
    return {
      bias: `GAP_AND_GO_${dir}`, confidence: 80,
      midDayPolicy: 'aggressive',
      recommendedSize: 2,
      recommendedHold: 'swing',
      stopMult: 0.5, targetMult: 2.5, holdMins: 90,
      note: `Gap ${gapPct.toFixed(2)}% holding — momentum continuation`,
    };
  }

  // ── 3. REVERSAL_DAY — gap fading already at 09:45 ───────────────────────
  if (Math.abs(gapPct) > 0.40 && (
        (gapPct > 0 && currentPrice < openPrice && !aboveVwap) ||
        (gapPct < 0 && currentPrice > openPrice && aboveVwap)
      )) {
    return {
      bias: 'REVERSAL_DAY', confidence: 70,
      midDayPolicy: 'fade_only',
      recommendedSize: 1,
      recommendedHold: 'scalp',
      stopMult: 0.4, targetMult: 2.0, holdMins: 30,
      note: `Gap ${gapPct.toFixed(2)}% fading — expect counter-trend afternoon`,
    };
  }

  // ── 4. TRENDING_BULL — above VWAP, broken out above OR, directional bars
  // The right discriminator is BREAKOUT MAGNITUDE (how far past OR_high relative
  // to ATR), not OR width. A narrow OR followed by a clean breakout is the
  // textbook trending day. Two paths in: (a) clear breakout, or (b) OR-internal
  // grind with strong directional bias and a wide-enough OR to matter.
  if (aboveVwap && barsAbove > barsBelow * 1.5 && (
        breakoutAbove > 0.10 ||                       // path (a) — broke out
        (orPos > 0.75 && orPctOfATR > 0.30)           // path (b) — riding upper OR
      )) {
    return {
      bias: 'TRENDING_BULL', confidence: 75,
      midDayPolicy: 'aggressive',
      recommendedSize: 2,
      recommendedHold: 'swing',
      stopMult: 0.5, targetMult: 3.0, holdMins: 120,
      note: breakoutAbove > 0.10
        ? `Above VWAP, broke OR_high by ${(breakoutAbove*100).toFixed(0)}% of ATR · ${barsAbove} bars above`
        : `Above VWAP, riding upper OR (pos ${(orPos*100).toFixed(0)}%) · ${barsAbove} bars above`,
    };
  }

  // ── 5. TRENDING_BEAR — mirror ───────────────────────────────────────────
  if (!aboveVwap && barsBelow > barsAbove * 1.5 && (
        breakoutBelow > 0.10 ||
        (orPos < 0.25 && orPctOfATR > 0.30)
      )) {
    return {
      bias: 'TRENDING_BEAR', confidence: 75,
      midDayPolicy: 'aggressive',
      recommendedSize: 2,
      recommendedHold: 'swing',
      stopMult: 0.5, targetMult: 3.0, holdMins: 120,
      note: breakoutBelow > 0.10
        ? `Below VWAP, broke OR_low by ${(breakoutBelow*100).toFixed(0)}% of ATR · ${barsBelow} bars below`
        : `Below VWAP, riding lower OR (pos ${(orPos*100).toFixed(0)}%) · ${barsBelow} bars below`,
    };
  }

  // ── 6. CHOPPY — default. Tight inside OR, mixed bars, no clean side ─────
  return {
    bias: 'CHOPPY', confidence: 60,
    midDayPolicy: 'stand_down',
    recommendedSize: 1,
    recommendedHold: 'scalp',
    stopMult: 0.6, targetMult: 1.5, holdMins: 45,
    note: `Mixed signals — bars +${barsAbove}/-${barsBelow}, OR pos ${(orPos*100).toFixed(0)}%`,
  };
}

/**
 * Read inputs from disk + bars[] and write daily-bias.json.
 * Called by monitor.js at 09:45 and again at 12:30 if `force=true`.
 *
 * @param {Array} bars — recent closed bars (open/high/low/close/volume) from session
 * @param {object} [overrides] — optional manual override of catalyst etc.
 */
export function evaluateDailyBias(bars = [], overrides = {}) {
  try {
    let spyLevels = {};
    try { spyLevels = JSON.parse(readFileSync(join(__dirname, 'spy-levels.json'), 'utf8')); } catch {}

    const sessionMins   = getETMins() - (9 * 60 + 30);
    if (sessionMins < 10) {
      jAlert('daily-bias', 'Called before OR completes (need 10+ min)', { sessionMins });
      return null;
    }

    // Filter bars to first 10 minutes of session (open range)
    const orStartTs = (() => {
      const d = new Date();
      const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      et.setHours(9, 30, 0, 0);
      return et.getTime();
    })();
    const orEndTs = orStartTs + 10 * 60 * 1000;

    const orBars = bars.filter(b => b.time != null && b.time >= orStartTs && b.time <= orEndTs);
    const recentBars = bars.slice(-Math.min(bars.length, 30));

    const orHigh = orBars.length ? Math.max(...orBars.map(b => b.high)) : (spyLevels.current ?? 0);
    const orLow  = orBars.length ? Math.min(...orBars.map(b => b.low))  : (spyLevels.current ?? 0);

    const openPrice    = spyLevels.todayOpen ?? orBars[0]?.open ?? spyLevels.current ?? 0;
    const currentPrice = spyLevels.current   ?? recentBars[recentBars.length - 1]?.close ?? 0;
    const vwap         = spyLevels.vwap      ?? currentPrice;
    const pdClose      = spyLevels.pdClose   ?? openPrice;

    const gapPct = pdClose > 0 ? ((openPrice - pdClose) / pdClose) * 100 : 0;

    // Bars above/below VWAP since session open
    const sessBars = bars.filter(b => b.time != null && b.time >= orStartTs);
    const barsAbove = sessBars.filter(b => b.close > vwap).length;
    const barsBelow = sessBars.filter(b => b.close < vwap).length;

    // ATR(5d) — if we don't have it, estimate from session range
    const atr5d = overrides.atr5d ?? Math.max((orHigh - orLow) * 4, currentPrice * 0.005);

    const verdict = classifyBias({
      gapPct, openRangeHigh: orHigh, openRangeLow: orLow,
      openPrice, currentPrice, vwap, atr5d,
      volumePct: spyLevels.volumePct ?? 1.0,
      catalyst:  overrides.catalyst ?? 'none',
      barsAbove, barsBelow,
    });

    const out = {
      ts:        Date.now(),
      time:      getETString(),
      verdict,
      features:  {
        gapPct: parseFloat(gapPct.toFixed(2)),
        orHigh, orLow, orRange: parseFloat((orHigh - orLow).toFixed(2)),
        openPrice, currentPrice, vwap, pdClose,
        atr5d: parseFloat(atr5d.toFixed(2)),
        barsAbove, barsBelow,
        sessionMins,
        catalyst: overrides.catalyst ?? 'none',
      },
    };

    writeFileSync(BIAS_FILE, JSON.stringify(out, null, 2));
    return out;
  } catch (e) {
    jError('daily-bias', e.message);
    return null;
  }
}

/**
 * Read the current daily bias verdict — used by gates/exits.
 * Returns null if not yet evaluated this session.
 */
export function getDailyBias() {
  try {
    if (!existsSync(BIAS_FILE)) return null;
    const data = JSON.parse(readFileSync(BIAS_FILE, 'utf8'));
    // Stale check — same calendar day required
    const ageMs = Date.now() - (data.ts ?? 0);
    if (ageMs > 8 * 60 * 60 * 1000) return null;
    return data;
  } catch { return null; }
}
