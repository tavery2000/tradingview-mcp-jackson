/**
 * fvg.js — Fair Value Gap detection + lifecycle.
 *
 * 3-candle window on 5M closed bars:
 *
 *   Bullish FVG (BISI):  c3.low  > c1.high   → gap = [c1.high, c3.low]
 *   Bearish FVG (SIBI):  c3.high < c1.low    → gap = [c3.high, c1.low]
 *
 *   c1 = oldest, c2 = middle (the displacement candle), c3 = newest.
 *
 * Validation gate: gap size must exceed 1.2 × ATR(14) on 5M to avoid
 * cataloging micro-gaps that have no price-discovery weight.
 *
 * Lifecycle:
 *   'unfilled'     — gap exists, price hasn't returned to it
 *   'tested'       — price entered the gap range but did not fully traverse
 *   'filled'       — price fully traversed (closed beyond the opposite edge)
 *   'invalidated'  — bullish gap broken DOWN through bottom, or bearish
 *                    gap broken UP through top — gap is no longer respected
 *
 * Strategy engines consume getActiveFVGs() (unfilled + tested) and trigger
 * mean-reversion entries when a 5M close enters the gap and pivots back
 * out. Filled or invalidated gaps are kept in state for journaling but
 * never returned by getActiveFVGs.
 *
 * Per-instrument state lives in:  fvg-state-{SPY|QQQ|IWM}.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { atr, closedBars } from './analyze.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ATR_VALIDATION_MULTIPLE = 1.2;
const ATR_PERIOD              = 14;
const MAX_GAPS_RETAINED       = 200;          // keep last N gaps in state
const STATE_VERSION           = 1;

// ─── State IO ───────────────────────────────────────────
function statePath(instrument) {
  return join(__dirname, `fvg-state-${instrument}.json`);
}

export function loadFVGState(instrument) {
  const p = statePath(instrument);
  if (!existsSync(p)) {
    return { version: STATE_VERSION, instrument, gaps: [], lastScan: 0, lastBarTime: 0 };
  }
  try {
    const s = JSON.parse(readFileSync(p, 'utf8'));
    if (!Array.isArray(s.gaps)) s.gaps = [];
    s.instrument = instrument;
    s.version    = s.version ?? STATE_VERSION;
    return s;
  } catch {
    return { version: STATE_VERSION, instrument, gaps: [], lastScan: 0, lastBarTime: 0 };
  }
}

export function saveFVGState(instrument, state) {
  // Cap retention so the state file doesn't grow unbounded
  if (state.gaps.length > MAX_GAPS_RETAINED) {
    state.gaps = state.gaps.slice(-MAX_GAPS_RETAINED);
  }
  state.lastScan = Date.now();
  writeFileSync(statePath(instrument), JSON.stringify(state, null, 2));
}

// ─── Detection ──────────────────────────────────────────
// Inspect the last 3 closed bars and emit a new FVG if one just formed.
// Returns null if no gap or gap fails ATR validation.
export function detectNewFVG(barsIn, opts = {}) {
  const bars = closedBars(barsIn);
  if (bars.length < ATR_PERIOD + 3) return null;

  const c1 = bars[bars.length - 3];
  const c2 = bars[bars.length - 2];
  const c3 = bars[bars.length - 1];

  const a = atr(bars, ATR_PERIOD);
  if (!a || !Number.isFinite(a) || a <= 0) return null;
  const minSize = ATR_VALIDATION_MULTIPLE * a;

  // Bullish FVG
  if (c3.low > c1.high) {
    const top    = c3.low;
    const bottom = c1.high;
    const size   = top - bottom;
    if (size < minSize) return null;
    return {
      id:           `BULL_${c2.time}`,
      type:         'BULL',
      top, bottom, size,
      atrAtFormation: a,
      sizeAtr:      size / a,
      createdAt:    c2.time,
      status:       'unfilled',
      anchor: { c1: c1.time, c2: c2.time, c3: c3.time },
    };
  }

  // Bearish FVG
  if (c3.high < c1.low) {
    const top    = c1.low;
    const bottom = c3.high;
    const size   = top - bottom;
    if (size < minSize) return null;
    return {
      id:           `BEAR_${c2.time}`,
      type:         'BEAR',
      top, bottom, size,
      atrAtFormation: a,
      sizeAtr:      size / a,
      createdAt:    c2.time,
      status:       'unfilled',
      anchor: { c1: c1.time, c2: c2.time, c3: c3.time },
    };
  }

  return null;
}

// ─── Lifecycle update ───────────────────────────────────
// Walk recent bars and update each active gap's status.
//
// Bullish gap [bottom..top]:
//   Bar enters [bottom, top]                          → 'tested'
//   Bar closes BELOW bottom                           → 'invalidated'
//   Bar closes ABOVE top after having tested          → 'filled' iff price
//     traversed fully (low <= bottom and close > top)
//
// Bearish gap [bottom..top]:
//   Bar enters [bottom, top]                          → 'tested'
//   Bar closes ABOVE top                              → 'invalidated'
//   Bar closes BELOW bottom after having tested       → 'filled'
export function updateFVGLifecycle(state, barsIn) {
  const bars = closedBars(barsIn);
  if (!state || !Array.isArray(state.gaps) || !bars.length) return state;

  const recent = bars.slice(-50);   // walk a bounded recent window
  for (const g of state.gaps) {
    if (g.status === 'filled' || g.status === 'invalidated') continue;
    for (const b of recent) {
      // Skip bars that are part of the formation. c3 itself doesn't count as a test —
      // by definition it sits on the far side of the gap.
      if (b.time <= (g.anchor?.c3 ?? g.createdAt)) continue;

      if (g.type === 'BULL') {
        // 1. Invalidation (close below gap bottom — terminal)
        if (b.close < g.bottom) {
          g.status = 'invalidated';
          g.invalidatedAt = b.time;
          break;
        }
        // 2. Fill — bar's range encompasses the whole gap (terminal)
        if (b.low <= g.bottom && b.high >= g.bottom) {
          g.status = 'filled';
          g.filledAt = b.time;
          g.fillLow = b.low;
          break;
        }
        // 3. Test — bar overlaps the gap range without filling or invalidating
        const overlaps = b.low <= g.top && b.high >= g.bottom;
        if (overlaps && g.status === 'unfilled') {
          g.status = 'tested';
          g.testedAt = b.time;
          g.testedLow = b.low;
        }
      } else if (g.type === 'BEAR') {
        if (b.close > g.top) {
          g.status = 'invalidated';
          g.invalidatedAt = b.time;
          break;
        }
        if (b.high >= g.top && b.low <= g.top) {
          g.status = 'filled';
          g.filledAt = b.time;
          g.fillHigh = b.high;
          break;
        }
        const overlaps = b.high >= g.bottom && b.low <= g.top;
        if (overlaps && g.status === 'unfilled') {
          g.status = 'tested';
          g.testedAt = b.time;
          g.testedHigh = b.high;
        }
      }
    }
  }

  state.lastBarTime = bars[bars.length - 1].time;
  return state;
}

// ─── Public ─────────────────────────────────────────────
// Tradeable gaps: unfilled + tested. Filled/invalidated retained for journaling.
export function getActiveFVGs(state) {
  if (!state || !Array.isArray(state.gaps)) return [];
  return state.gaps.filter(g => g.status === 'unfilled' || g.status === 'tested');
}

// Add a newly-detected gap to state if not already present (id collision = same c2 time).
export function recordFVG(state, gap) {
  if (!state || !gap) return state;
  if (state.gaps.some(g => g.id === gap.id)) return state;
  state.gaps.push(gap);
  return state;
}

// One-call orchestration for the monitor poll loop.
//   - detectNewFVG against latest 3 closed bars
//   - record if found
//   - updateFVGLifecycle across recent window
//   - saveFVGState
// Returns { newGap, active }.
export function scanAndUpdate(instrument, bars5M) {
  const state  = loadFVGState(instrument);
  const newGap = detectNewFVG(bars5M);
  if (newGap) recordFVG(state, newGap);
  updateFVGLifecycle(state, bars5M);
  saveFVGState(instrument, state);
  return { newGap, active: getActiveFVGs(state), state };
}

// ─── Entry engine ───────────────────────────────────────
// Fires when the most recent closed 5M bar wicked into an active FVG
// and rejected back out — classic "gap retest, price rejects" entry.
//
//   Bull FVG  → c0.low ≤ top AND c0.close > top   → CALLS
//   Bear FVG  → c0.high ≥ bottom AND c0.close < bottom → PUTS
//
// Confidence:
//   HIGH    when wick penetrates >40% of gap AND gap was ≥1.5 × ATR at formation
//   MEDIUM  otherwise
//
// Already-fired gaps (g.firedAt set) are skipped — caller should call
// markFVGFired(instrument, gapId) immediately after the engine emits.
export function fvgEntryEngine(input) {
  const { activeFVGs, bars } = input || {};
  const fresh = (activeFVGs ?? []).filter(g => !g.firedAt);
  if (!fresh.length) return null;

  const closed = closedBars(bars);
  if (closed.length < 2) return null;
  const c0 = closed[closed.length - 1];

  // Walk newest gaps first so most recent setup wins if multiple are valid
  const sorted = [...fresh].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

  for (const gap of sorted) {
    if (c0.time <= gap.createdAt) continue;     // bar predates the gap

    if (gap.type === 'BULL') {
      const wickedIn   = c0.low <= gap.top && c0.low >= gap.bottom * 0.997;
      const closedBack = c0.close > gap.top;
      if (wickedIn && closedBack) {
        const wickPct = gap.size > 0 ? (gap.top - c0.low) / gap.size : 0;
        const isStrong = wickPct >= 0.40 && (gap.sizeAtr ?? 0) >= 1.5;
        return {
          action:     'CALLS',
          confidence: isStrong ? 'HIGH' : 'MEDIUM',
          engine:     'FVG',
          event:      'FVG_RETEST_BULL',
          reason:     `Bull FVG retest [${gap.bottom.toFixed(2)}–${gap.top.toFixed(2)}] · wick ${(wickPct*100).toFixed(0)}% · ${gap.sizeAtr?.toFixed(1) ?? '?'}× ATR`,
          gapId:      gap.id,
          meta:       { wickPct, sizeAtr: gap.sizeAtr, gapTop: gap.top, gapBottom: gap.bottom },
        };
      }
    } else if (gap.type === 'BEAR') {
      const wickedIn   = c0.high >= gap.bottom && c0.high <= gap.top * 1.003;
      const closedBack = c0.close < gap.bottom;
      if (wickedIn && closedBack) {
        const wickPct = gap.size > 0 ? (c0.high - gap.bottom) / gap.size : 0;
        const isStrong = wickPct >= 0.40 && (gap.sizeAtr ?? 0) >= 1.5;
        return {
          action:     'PUTS',
          confidence: isStrong ? 'HIGH' : 'MEDIUM',
          engine:     'FVG',
          event:      'FVG_RETEST_BEAR',
          reason:     `Bear FVG retest [${gap.bottom.toFixed(2)}–${gap.top.toFixed(2)}] · wick ${(wickPct*100).toFixed(0)}% · ${gap.sizeAtr?.toFixed(1) ?? '?'}× ATR`,
          gapId:      gap.id,
          meta:       { wickPct, sizeAtr: gap.sizeAtr, gapTop: gap.top, gapBottom: gap.bottom },
        };
      }
    }
  }
  return null;
}

// Mark a gap as fired so subsequent polls don't re-trigger on the same setup.
// Call this immediately after fvgEntryEngine emits, regardless of whether
// the downstream gates ultimately let the trade through — once the engine
// has decided "this is the moment", we don't want to revisit it.
export function markFVGFired(instrument, gapId) {
  if (!gapId) return false;
  const state = loadFVGState(instrument);
  const gap = state.gaps.find(g => g.id === gapId);
  if (!gap || gap.firedAt) return false;
  gap.firedAt = Math.floor(Date.now() / 1000);
  saveFVGState(instrument, state);
  return true;
}

export { ATR_VALIDATION_MULTIPLE, ATR_PERIOD, STATE_VERSION };
