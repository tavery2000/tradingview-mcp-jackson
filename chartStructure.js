/**
 * chartStructure.js — Shared chart-structure engine.
 *
 * Refactored from monitor.js / monitor-qqq.js / monitor-iwm.js — those
 * three had drifted (SPY had 10 patterns, QQQ/IWM only had 7). This
 * module is the single source of truth used by all three monitors.
 *
 * Two public functions:
 *
 *   chartStructureEngine(input)   — 5M bars, fires HIGH/MEDIUM signals
 *   chartStructure1H(input)       — 1H bars, returns macro context (no fires)
 *
 * The 5M engine is the firing path (10 patterns). The 1H function returns
 * context that the multiplier engine and strategy gates use to decide
 * whether the trigger is happening in a favorable structural environment.
 */

import { closedBars } from './analyze.js';

// Tolerance: ~0.15% of price (about $1 on SPY at $700).
const PROX = 0.0015;

// ─── 5M chart structure ─────────────────────────────────
// Required input shape:
//   price   — current quote price
//   vwap    — session VWAP for the instrument
//   delta   — cumulative delta (signed contracts/dollars)
//   levels  — { resistance: [{price,label}...], support: [{price,label}...] }
//   bars    — closed 5M bars (NOT including the in-progress bar). Min 5.
export function chartStructureEngine(input) {
  const { price, vwap, delta, levels } = input || {};
  const bars = closedBars(input?.bars);
  if (!price || !vwap || delta == null || !levels || bars.length < 5) return null;

  const len = bars.length;
  const c0  = bars[len - 1];
  const c1  = bars[len - 2];
  const c2  = bars[len - 3];
  if (!c0 || !c1 || !c2) return null;

  const allRes  = (levels.resistance ?? []).filter(r => r.price > price).sort((a, b) => a.price - b.price);
  const allSup  = (levels.support    ?? []).filter(s => s.price < price).sort((a, b) => b.price - a.price);
  const nearRes = allRes[0];
  const nearSup = allSup[0];

  // 1. VWAP Reclaim
  if (c2.close < vwap && c1.close < vwap && c0.close > vwap && delta > 0) {
    return {
      action: 'CALLS', confidence: 'HIGH', engine: 'STRUCTURE',
      reason: `VWAP reclaim ↑ $${vwap.toFixed(2)} — two bars below, now holding above · delta +${(delta/1000).toFixed(1)}K`,
      event:  'VWAP_RECLAIM',
    };
  }

  // 2. VWAP Breakdown
  if (c2.close > vwap && c1.close > vwap && c0.close < vwap && delta < 0) {
    return {
      action: 'PUTS', confidence: 'HIGH', engine: 'STRUCTURE',
      reason: `VWAP breakdown ↓ $${vwap.toFixed(2)} — two bars above, now holding below · delta ${(delta/1000).toFixed(1)}K`,
      event:  'VWAP_BREAKDOWN',
    };
  }

  // 3. Swing High / PDH Breakout
  for (const lvl of (levels.resistance ?? []).filter(r => r.label === 'SH' || r.label === 'PDH')) {
    if (c2.close < lvl.price && c0.close > lvl.price &&
        (c0.close - lvl.price) / lvl.price < 0.004 && delta > 0) {
      return {
        action: 'CALLS', confidence: 'HIGH', engine: 'STRUCTURE',
        reason: `${lvl.label} breakout ↑ $${lvl.price.toFixed(2)} — close $${c0.close.toFixed(2)} · delta +${(delta/1000).toFixed(1)}K`,
        event:  'SH_BREAKOUT',
      };
    }
  }

  // 4. Swing Low / PDL Breakdown
  for (const lvl of (levels.support ?? []).filter(s => s.label === 'SL' || s.label === 'PDL')) {
    if (c2.close > lvl.price && c0.close < lvl.price &&
        (lvl.price - c0.close) / lvl.price < 0.004 && delta < 0) {
      return {
        action: 'PUTS', confidence: 'HIGH', engine: 'STRUCTURE',
        reason: `${lvl.label} breakdown ↓ $${lvl.price.toFixed(2)} — close $${c0.close.toFixed(2)} · delta ${(delta/1000).toFixed(1)}K`,
        event:  'SL_BREAKDOWN',
      };
    }
  }

  // 5 & 6. Level Move Up / Down (in midrange between sup and res)
  if (nearSup && nearRes) {
    const range = nearRes.price - nearSup.price;
    const pos   = range > 0.01 ? (price - nearSup.price) / range : 0.5;
    const twoUp = c0.close > c1.close && c1.close > c2.close;
    const twoDn = c0.close < c1.close && c1.close < c2.close;
    if (pos < 0.40 && twoUp && delta > 0 && price > vwap) {
      return {
        action: 'CALLS', confidence: 'MEDIUM', engine: 'STRUCTURE',
        reason: `Level move ↑ off ${nearSup.label} $${nearSup.price.toFixed(2)} → ${nearRes.label} $${nearRes.price.toFixed(2)} · 2 green bars · delta +${(delta/1000).toFixed(1)}K`,
        event:  'LEVEL_MOVE_UP',
      };
    }
    if (pos > 0.60 && twoDn && delta < 0 && price < vwap) {
      return {
        action: 'PUTS', confidence: 'MEDIUM', engine: 'STRUCTURE',
        reason: `Level move ↓ off ${nearRes.label} $${nearRes.price.toFixed(2)} → ${nearSup.label} $${nearSup.price.toFixed(2)} · 2 red bars · delta ${(delta/1000).toFixed(1)}K`,
        event:  'LEVEL_MOVE_DOWN',
      };
    }
  }

  // 7. VWAP Bounce — wick tagged VWAP, bar closed above, currently holding
  const vwapWick = c1.low <= vwap * (1 + PROX) && c1.low >= vwap * (1 - PROX * 3);
  if (vwapWick && c1.close > vwap && c0.close > vwap && delta > 0) {
    return {
      action: 'CALLS', confidence: 'MEDIUM', engine: 'STRUCTURE',
      reason: `VWAP bounce — wick $${c1.low.toFixed(2)} tagged $${vwap.toFixed(2)}, bar closed above, holding · delta +${(delta/1000).toFixed(1)}K`,
      event:  'VWAP_BOUNCE',
    };
  }

  // 8. Resistance Rejection — above VWAP, wick tagged level, 2 lower closes
  if (price > vwap && nearRes) {
    const prevHigh  = Math.max(c1.high, c2.high);
    const tagged    = prevHigh >= nearRes.price * (1 - PROX);
    const nearLevel = (nearRes.price - price) / nearRes.price < 0.005;
    const twoDown   = c0.close < c1.close && c1.close < c2.close;
    if ((tagged || nearLevel) && twoDown && delta < 0) {
      return {
        action: 'PUTS', confidence: 'HIGH', engine: 'STRUCTURE',
        reason: `Resistance rejection ↓ ${nearRes.label} $${nearRes.price.toFixed(2)} — 2 lower closes above VWAP $${vwap.toFixed(2)} · delta ${(delta/1000).toFixed(1)}K`,
        event:  'RESISTANCE_REJECTION',
      };
    }
  }

  // 9. Support Reclaim — below VWAP, wick tagged level, 2 higher closes
  if (price < vwap && nearSup) {
    const prevLow   = Math.min(c1.low, c2.low);
    const tagged    = prevLow <= nearSup.price * (1 + PROX);
    const nearLevel = (price - nearSup.price) / nearSup.price < 0.005;
    const twoUp     = c0.close > c1.close && c1.close > c2.close;
    if ((tagged || nearLevel) && twoUp && delta > 0) {
      return {
        action: 'CALLS', confidence: 'HIGH', engine: 'STRUCTURE',
        reason: `Support reclaim ↑ ${nearSup.label} $${nearSup.price.toFixed(2)} — 2 higher closes below VWAP $${vwap.toFixed(2)} · delta +${(delta/1000).toFixed(1)}K`,
        event:  'SUPPORT_RECLAIM',
      };
    }
  }

  // 10. Trend Continuation — 5 bars HH+HL above VWAP (or LH+LL below)
  if (bars.length >= 5) {
    const last5 = bars.slice(-5);
    const hh = last5.every((b, i) => i === 0 || b.high >= last5[i - 1].high * 0.9999);
    const hl = last5.every((b, i) => i === 0 || b.low  >= last5[i - 1].low  * 0.9999);
    const closesUp = last5[4].close > last5[0].close;
    if (hh && hl && closesUp && price > vwap && delta > 0) {
      const move = ((last5[4].close - last5[0].open) / last5[0].open) * 100;
      return {
        action: 'CALLS', confidence: 'MEDIUM', engine: 'STRUCTURE',
        reason: `Trend continuation ↑ — 5 bars HH+HL · move +${move.toFixed(2)}% · above VWAP $${vwap.toFixed(2)} · delta +${(delta/1000).toFixed(1)}K`,
        event:  'TREND_CONTINUATION_BULL',
      };
    }
    const lh = last5.every((b, i) => i === 0 || b.high <= last5[i - 1].high * 1.0001);
    const ll = last5.every((b, i) => i === 0 || b.low  <= last5[i - 1].low  * 1.0001);
    const closesDown = last5[4].close < last5[0].close;
    if (lh && ll && closesDown && price < vwap && delta < 0) {
      const move = ((last5[4].close - last5[0].open) / last5[0].open) * 100;
      return {
        action: 'PUTS', confidence: 'MEDIUM', engine: 'STRUCTURE',
        reason: `Trend continuation ↓ — 5 bars LH+LL · move ${move.toFixed(2)}% · below VWAP $${vwap.toFixed(2)} · delta ${(delta/1000).toFixed(1)}K`,
        event:  'TREND_CONTINUATION_BEAR',
      };
    }
  }

  return null;
}

// ─── 1H structural context (no fires) ───────────────────
// Returns context the multiplier/strategy gates can use to confirm or
// reject 5M triggers. The 5M trigger is the entry; this just answers
// "is the 1H structure on our side?"
//
// Required input shape:
//   price       — current quote
//   bars1H      — closed 1H bars (use barCache.SYM.get('60'))
//   levels      — { resistance, support } same shape as 5M
//   ema21, ema50 — from analyze1H()
export function chartStructure1H(input) {
  const { price, levels, ema21, ema50 } = input || {};
  const bars = closedBars(input?.bars1H);
  const out = {
    valid: false,
    trend: 'NEUTRAL',           // 'UP' | 'DOWN' | 'NEUTRAL'
    nearestResistance: null,
    nearestSupport: null,
    pctOfRange: null,
    recentBreak: null,          // 'UP_BROKE_RES' | 'DOWN_BROKE_SUP' | null
    emaStack: 'NEUTRAL',        // 'BULL' (ema21>ema50) | 'BEAR' | 'NEUTRAL'
  };
  if (!price || bars.length < 4) return out;

  const last5 = bars.slice(-5);
  const hh = last5.every((b, i) => i === 0 || b.high >= last5[i - 1].high * 0.9995);
  const ll = last5.every((b, i) => i === 0 || b.low  <= last5[i - 1].low  * 1.0005);
  if      (hh) out.trend = 'UP';
  else if (ll) out.trend = 'DOWN';
  else         out.trend = 'NEUTRAL';

  if (ema21 != null && ema50 != null) {
    if      (ema21 > ema50 * 1.0005) out.emaStack = 'BULL';
    else if (ema21 < ema50 * 0.9995) out.emaStack = 'BEAR';
    else                              out.emaStack = 'NEUTRAL';
  }

  if (levels) {
    const res = (levels.resistance ?? []).filter(r => r.price > price).sort((a, b) => a.price - b.price)[0];
    const sup = (levels.support    ?? []).filter(s => s.price < price).sort((a, b) => b.price - a.price)[0];
    out.nearestResistance = res ?? null;
    out.nearestSupport    = sup ?? null;
    if (res && sup) {
      const span = res.price - sup.price;
      out.pctOfRange = span > 0 ? Math.max(0, Math.min(1, (price - sup.price) / span)) : 0.5;
    }

    // Recent break detection — last 2 bars closed beyond a level
    const c0 = bars[bars.length - 1], c1 = bars[bars.length - 2];
    if (c0 && c1) {
      for (const r of (levels.resistance ?? [])) {
        if (c1.close < r.price && c0.close > r.price * 1.001) { out.recentBreak = 'UP_BROKE_RES'; break; }
      }
      if (!out.recentBreak) {
        for (const s of (levels.support ?? [])) {
          if (c1.close > s.price && c0.close < s.price * 0.999) { out.recentBreak = 'DOWN_BROKE_SUP'; break; }
        }
      }
    }
  }

  out.valid = true;
  return out;
}

export { PROX };
