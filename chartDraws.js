/**
 * chartDraws.js — Builds a single CDP-ready JS payload that draws all
 * HANK chart annotations on a TradingView chart in one round-trip.
 *
 * Replaces the per-monitor JS_DRAW_LEVELS pattern. One unified call:
 *   1. removeAllShapes()       — clears the chart
 *   2. horizontal_lines        — VWAP / VWAP±σ / SH / SL / PDH / PDL etc.
 *   3. rectangles  — FVG zones (issue 1)
 *   4. rectangles  — 1H + 4H supply/demand (issue 2)
 *   5. dashed lines — active sweep levels (issue 3)
 *   6. arrows      — recent displacement candles (issue 4)
 *
 * Pure string builder. Does no IO and never reads from disk — the caller
 * passes loaded fvg/sweep state and bar arrays so this module stays
 * mockable for tests.
 */

import { atr, swingPoints, detectDisplacement } from './analyze.js';
import { getActiveFVGs }   from './fvg.js';
import { getRecentSweeps } from './sweep.js';

// ─── Color palette ──────────────────────────────────────
// Important: TradingView's rectangle backgroundColor accepts ONLY 6-char
// hex (#RRGGBB). 8-char (#RRGGBBAA) is silently rejected — the entire
// shape fails to render. Use the `transparency` override (0-100) for
// alpha control on filled shapes.
const COLOR = {
  // Levels (matches existing JS_DRAW_LEVELS palette)
  support:        '#00BB44',
  resistance:     '#CC2200',
  // FVG zones — fill + edge in 6-char; transparency applied per-call
  fvgBullFill:    '#00CC44',
  fvgBullEdge:    '#00CC44',
  fvgBearFill:    '#CC2200',
  fvgBearEdge:    '#CC2200',
  // 1H supply / demand
  supply1HFill:   '#CC2200',
  supply1HEdge:   '#CC2200',
  demand1HFill:   '#00CC44',
  demand1HEdge:   '#00CC44',
  // 4H supply / demand — darker, thicker border for distinction
  supply4HFill:   '#880000',
  supply4HEdge:   '#660000',
  demand4HFill:   '#008800',
  demand4HEdge:   '#005500',
  // Sweep level dashed lines — orange/yellow/white per level type
  sweepPDX:       '#FF8800',
  sweepONX:       '#FFDD00',
  sweepORX:       '#FFFFFF',
  sweepNEWS:      '#FF00FF',
  sweepHODLOD:    '#88AAFF',
  sweepDefault:   '#AAAAAA',
  // Displacement arrows
  dispBull:       '#00CC44',
  dispBear:       '#CC2200',
};

// Transparency presets (0 = opaque, 100 = invisible)
const ALPHA = {
  fvg:        70,    // ~30% opacity
  zone1H:     85,    // very faint
  zone4H:     75,    // slightly darker
};

// linestyle: 0=solid, 1=dotted, 2=dashed, 3=large_dashed
const STYLE_DASHED = 2;

// Sweep cooldown: 15 min (matches sweep.js). Drawings auto-prune past this.
const SWEEP_DISPLAY_MS = 15 * 60_000;

// Displacement arrow lifetime: 5 closed bars (per spec).
const DISPLACEMENT_RECENT_N = 5;

// ─── Helpers ────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/['\\]/g, '');

// Single-point shape (horizontal line, arrow, etc.) — awaits the Promise
// that createShape returns so we can capture the EntityId string.
function shapeAt(time, price, shape, overrides) {
  const o = JSON.stringify(overrides);
  return `  try { var id = await api.createShape({ time: ${time}, price: ${price.toFixed(6)} }, { shape: '${shape}', overrides: ${o} }); if (id) ours.push(id); } catch(e) {}`;
}

// Two-point shape (rectangle, trend line) — top-left, bottom-right
function rectShape(t1, p1, t2, p2, overrides) {
  const o = JSON.stringify(overrides);
  return `  try { var id = await api.createMultipointShape([{ time: ${t1}, price: ${p1.toFixed(6)} }, { time: ${t2}, price: ${p2.toFixed(6)} }], { shape: 'rectangle', overrides: ${o} }); if (id) ours.push(id); } catch(e) {}`;
}

// Look-forward time buffer past the latest bar so zones extend to the right
// of "now" instead of stopping at the last closed candle.
const LOOK_FORWARD_S = 30 * 60;     // 30 minutes

// ─── Main: build the unified draw payload ───────────────
// Returns { js, counts } where js is the full CDP expression. js is null
// when there is nothing to draw (e.g., bars5M empty).
//
// Inputs are passive — this function never mutates state; the caller is
// responsible for refreshing fvgState/sweepState/levels each poll cycle.
//
// opts.levels    — array of { price, label, type:'support'|'resistance' }
// opts.fvgState  — loadFVGState(instrument) result
// opts.sweepState — loadSweepState(instrument) result
// opts.bars5M    — closed 5M bars (cached)
// opts.bars1H    — closed 1H bars (cached)
// opts.bars4H    — closed 4H bars (cached)
// opts.instrument — 'SPY'|'QQQ'|'IWM'|'ES'|'NQ'  (used in labels only)
export function buildDrawJS(opts) {
  const { instrument, bars5M, bars1H, bars4H, levels = [], fvgState, sweepState } = opts || {};
  if (!Array.isArray(bars5M) || !bars5M.length) return { js: null, counts: { total: 0 } };

  const last5 = bars5M[bars5M.length - 1];
  const lastBarTime = last5.time;
  const endTime = lastBarTime + LOOK_FORWARD_S;

  const lines = [];
  const counts = { levels: 0, fvg: 0, supply1H: 0, demand1H: 0, supply4H: 0, demand4H: 0, sweep: 0, displacement: 0 };

  // 1. LEVELS — same shape as the legacy JS_DRAW_LEVELS for backward visual parity
  for (const lvl of levels) {
    if (lvl?.price == null || !Number.isFinite(lvl.price)) continue;
    const color = lvl.type === 'support' ? COLOR.support : COLOR.resistance;
    lines.push(shapeAt(lastBarTime, lvl.price, 'horizontal_line', {
      linecolor: color, linewidth: 1, linestyle: 0, showLabel: true, text: esc(lvl.label),
    }));
    counts.levels++;
  }

  // 2. FVG ZONES — boxes for active gaps (unfilled / tested, not yet fired/filled/invalidated)
  const activeGaps = getActiveFVGs(fvgState);
  for (const g of activeGaps) {
    if (!Number.isFinite(g.top) || !Number.isFinite(g.bottom)) continue;
    const isBull = g.type === 'BULL';
    const fill = isBull ? COLOR.fvgBullFill : COLOR.fvgBearFill;
    const edge = isBull ? COLOR.fvgBullEdge : COLOR.fvgBearEdge;
    const arrow = isBull ? '▲' : '▼';
    const sizeAtr = Number.isFinite(g.sizeAtr) ? g.sizeAtr.toFixed(1) : '?';
    const text = `FVG ${arrow} ${sizeAtr}xATR`;
    const startT = g.createdAt || lastBarTime;
    lines.push(rectShape(startT, g.top, endTime, g.bottom, {
      backgroundColor: fill, linecolor: edge, linewidth: 1, transparency: 70,
      showLabel: true, text,
    }));
    counts.fvg++;
  }

  // 3. 1H SUPPLY / DEMAND ZONES — swings on 1H bars
  if (Array.isArray(bars1H) && bars1H.length >= 7) {
    const sw1 = swingPoints(bars1H, 2);
    const a1H = atr(bars1H, 14) || 0;
    // Zone width — narrow enough to not dominate the chart
    const w = a1H > 0 ? a1H * 0.35 : (last5.close * 0.0015);
    for (const h of sw1.highs.slice(-3)) {
      lines.push(rectShape(h.time, h.price, endTime, h.price - w, {
        backgroundColor: COLOR.supply1HFill, linecolor: COLOR.supply1HEdge,
        linewidth: 1, transparency: 80, showLabel: true, text: 'Supply 1H',
      }));
      counts.supply1H++;
    }
    for (const l of sw1.lows.slice(-3)) {
      lines.push(rectShape(l.time, l.price + w, endTime, l.price, {
        backgroundColor: COLOR.demand1HFill, linecolor: COLOR.demand1HEdge,
        linewidth: 1, transparency: 80, showLabel: true, text: 'Demand 1H',
      }));
      counts.demand1H++;
    }
  }

  // 4. 4H SUPPLY / DEMAND ZONES — darker fill + thicker border per spec
  if (Array.isArray(bars4H) && bars4H.length >= 7) {
    const sw4 = swingPoints(bars4H, 3);
    const a4H = atr(bars4H, 14) || 0;
    const w = a4H > 0 ? a4H * 0.4 : (last5.close * 0.004);
    for (const h of sw4.highs.slice(-2)) {
      lines.push(rectShape(h.time, h.price, endTime, h.price - w, {
        backgroundColor: COLOR.supply4HFill, linecolor: COLOR.supply4HEdge,
        linewidth: 2, transparency: 70, showLabel: true, text: 'Supply 4H',
      }));
      counts.supply4H++;
    }
    for (const l of sw4.lows.slice(-2)) {
      lines.push(rectShape(l.time, l.price + w, endTime, l.price, {
        backgroundColor: COLOR.demand4HFill, linecolor: COLOR.demand4HEdge,
        linewidth: 2, transparency: 70, showLabel: true, text: 'Demand 4H',
      }));
      counts.demand4H++;
    }
  }

  // 5. SWEEP LEVELS — dashed horizontal lines for sweeps inside the cooldown window
  const recentSweeps = getRecentSweeps(sweepState, SWEEP_DISPLAY_MS);
  for (const s of recentSweeps) {
    const lvlPrice = s?.level?.price;
    if (!Number.isFinite(lvlPrice)) continue;
    const lblName = s.level.label || '';
    const color =
      (lblName === 'PDH' || lblName === 'PDL')               ? COLOR.sweepPDX
    : (lblName === 'ONH' || lblName === 'ONL')               ? COLOR.sweepONX
    : (lblName === 'OR_HIGH' || lblName === 'OR_LOW')        ? COLOR.sweepORX
    : (lblName === 'NEWS_HIGH' || lblName === 'NEWS_LOW')    ? COLOR.sweepNEWS
    : (lblName === 'HOD' || lblName === 'LOD')               ? COLOR.sweepHODLOD
    : COLOR.sweepDefault;
    const text = `Swept ${lblName} ${s.signal === 'CALLS' ? '↑' : '↓'}`;
    lines.push(shapeAt(s.time, lvlPrice, 'horizontal_line', {
      linecolor: color, linewidth: 1, linestyle: STYLE_DASHED,
      showLabel: true, text,
    }));
    counts.sweep++;
  }

  // 6. DISPLACEMENT ARROWS — last 5 bars, one arrow per displacement
  const disps = detectDisplacement(bars5M, 14, DISPLACEMENT_RECENT_N);
  for (const d of disps) {
    const isBull = d.type === 'BULL';
    const shape = isBull ? 'arrow_up' : 'arrow_down';
    const color = isBull ? COLOR.dispBull : COLOR.dispBear;
    // Place arrow just outside the candle range so it doesn't overlap the wick
    const offset = (d.high - d.low) * 0.35 || (last5.close * 0.0008);
    const price  = isBull ? d.low - offset : d.high + offset;
    lines.push(shapeAt(d.time, price, shape, {
      color, linewidth: 2,
    }));
    counts.displacement++;
  }

  counts.total = lines.length;

  // Async IIFE per draw cycle. Each shape-create call resolves to the
  // EntityId string; we collect them as we go and persist on window for
  // the next cycle's removal pass.
  //
  //   1. Remove ONLY the shape IDs we created last cycle (kept on
  //      window.__hankShapes_<INSTR>). Manual drawings stay put.
  //   2. await every createShape — capture the resolved EntityId.
  //   3. Persist the new ID list on window for the next removal pass.
  //
  // CALLER MUST USE awaitPromise: true on the CDP eval, otherwise consecutive
  // polls can race and leak shapes (cycle N+1 reads window before cycle N
  // finished writing it).
  //
  // Caveat: if TradingView's autosave restores our shapes on reload,
  // window.__hankShapes_<INSTR> resets to empty and the restored shapes
  // are treated as "manual" (no longer cleared). One-time leak per reload.
  const apiPath = 'window.TradingViewApi._activeChartWidgetWV.value()';
  const stateKey = `__hankShapes_${(instrument || 'DEFAULT').toUpperCase()}`;
  const js = `
(async function() {
  var api;
  try { api = ${apiPath}; } catch(e) { return { error: 'no api' }; }
  // 1. Remove our previous shapes (no-op if first run or after page reload)
  try {
    var prev = window['${stateKey}'] || [];
    for (var i = 0; i < prev.length; i++) {
      try { api.removeEntity(prev[i]); } catch(e) {}
    }
  } catch(e) {}
  // 2. Create new shapes — each call awaited so we capture the EntityId
  var ours = [];
${lines.join('\n')}
  // 3. Persist for next cycle
  window['${stateKey}'] = ours;
  return { drew: ours.length };
})()`;

  return { js, counts, stateKey };
}

// Clear all of HANK's shapes for an instrument without touching manual
// drawings. Called explicitly (e.g., from a dashboard "clear" button) or
// at shutdown. Returns a JS payload string for evalOn.
export function clearOursJS(instrument) {
  const apiPath = 'window.TradingViewApi._activeChartWidgetWV.value()';
  const stateKey = `__hankShapes_${(instrument || 'DEFAULT').toUpperCase()}`;
  return `
(function() {
  try {
    var api = ${apiPath};
    var prev = window['${stateKey}'] || [];
    for (var i = 0; i < prev.length; i++) { try { api.removeEntity(prev[i]); } catch(e) {} }
    window['${stateKey}'] = [];
    return { cleared: prev.length };
  } catch(e) { return { error: e.message }; }
})()`;
}

export { COLOR, SWEEP_DISPLAY_MS, DISPLACEMENT_RECENT_N };
