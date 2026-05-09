/**
 * analyze.js — Pure analysis functions for the three-timeframe funnel.
 *
 * NO side effects. NO file IO. NO journal calls. Bars in → object out.
 *
 *   analyze4H(bars)                       — macro direction (4H bars)
 *   analyze1H(bars, currentPrice)         — 1H positional context
 *   analyze5M(bars, currentPrice, vwap)   — 5M trigger context
 *
 * All three are tolerant of short / null inputs: they return best-effort
 * objects with null fields where data is missing, never throw. Strategy
 * engines must check the returned `valid` flag before acting.
 *
 * Math primitives (ema, rsi, atr, swings) are exported so chartStructure /
 * fvg / sweep can reuse the same conventions instead of forking.
 */

// ─── Math primitives ────────────────────────────────────

// EMA — standard 2/(N+1) smoothing seeded with SMA of first N.
export function ema(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

// EMA series — returns aligned array (null for index < period-1).
export function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = e;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

// Wilder RSI. period = 14 typical; 3 for fast scalp signals.
export function rsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

// Wilder ATR (matches monitor-qqq.js convention).
export function atr(bars, period = 14) {
  if (!bars || bars.length < 2) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low  - bars[i - 1].close),
    );
    trs.push(tr);
  }
  if (trs.length < period) return trs.reduce((a, b) => a + b, 0) / trs.length;
  let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

// Pivot-based swing detection. n bars on each side → strict.
export function swingPoints(bars, n = 3) {
  const highs = [], lows = [];
  if (!bars || bars.length < 2 * n + 1) return { highs, lows };
  for (let i = n; i < bars.length - n; i++) {
    const h = bars[i].high, l = bars[i].low;
    let isH = true, isL = true;
    for (let j = 1; j <= n; j++) {
      if (bars[i - j].high >= h || bars[i + j].high >= h) isH = false;
      if (bars[i - j].low  <= l || bars[i + j].low  <= l) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) highs.push({ idx: i, price: h, time: bars[i].time });
    if (isL) lows.push({ idx: i, price: l, time: bars[i].time });
  }
  return { highs, lows };
}

// Closed-only view — strategy engines must NOT trigger on the in-progress bar.
export function closedBars(bars) {
  if (!bars || !bars.length) return [];
  const last = bars[bars.length - 1];
  return last && last.incomplete ? bars.slice(0, -1) : bars;
}

// ─── 4H macro analysis ──────────────────────────────────
// Purpose: tell the strategies which way the macro tide is flowing.
// Engines that try to fade this direction get a 0.6x dampener; engines
// aligned with it get full weight.
export function analyze4H(barsIn) {
  const bars = closedBars(barsIn);
  const out = {
    valid: false,
    direction: 'UNKNOWN',     // 'UP' | 'DOWN' | 'RANGING' | 'UNKNOWN'
    structure: 'UNKNOWN',     // 'TRENDING' | 'CHOP' | 'EXTENDED'
    ema21: null,
    atr14: null,
    last: null,
    rangeHigh: null,
    rangeLow:  null,
    fromHigh:  null,          // % below 4H high of the lookback
    fromLow:   null,          // % above 4H low of the lookback
    consecutive: { up: 0, down: 0 },
  };
  if (bars.length < 6) return out;

  const closes = bars.map(b => b.close);
  out.ema21 = ema(closes, 21);
  out.atr14 = atr(bars, 14);
  out.last  = bars[bars.length - 1];

  const lookback = bars.slice(-20);
  const highs = lookback.map(b => b.high);
  const lows  = lookback.map(b => b.low);
  out.rangeHigh = Math.max(...highs);
  out.rangeLow  = Math.min(...lows);
  const px       = out.last.close;
  out.fromHigh   = (out.rangeHigh - px) / out.rangeHigh;
  out.fromLow    = (px - out.rangeLow)  / out.rangeLow;

  // Consecutive directional closes from the tail
  for (let i = bars.length - 1; i > 0; i--) {
    if (bars[i].close > bars[i - 1].close) {
      if (out.consecutive.down) break;
      out.consecutive.up++;
    } else if (bars[i].close < bars[i - 1].close) {
      if (out.consecutive.up) break;
      out.consecutive.down++;
    } else break;
  }

  // Direction: price vs EMA21 + structural higher-highs/lower-lows
  const swings = swingPoints(bars, 3);
  const recentHighs = swings.highs.slice(-3).map(s => s.price);
  const recentLows  = swings.lows.slice(-3).map(s => s.price);
  const HH = recentHighs.length >= 2 && recentHighs.every((v, i, a) => i === 0 || v > a[i - 1]);
  const LL = recentLows.length  >= 2 && recentLows.every((v, i, a) => i === 0 || v < a[i - 1]);
  const aboveEma = out.ema21 != null && px > out.ema21;
  const belowEma = out.ema21 != null && px < out.ema21;

  if      (HH && aboveEma) out.direction = 'UP';
  else if (LL && belowEma) out.direction = 'DOWN';
  else if (out.ema21 != null && Math.abs(px - out.ema21) / out.ema21 < 0.003) out.direction = 'RANGING';
  else if (aboveEma) out.direction = 'UP';
  else if (belowEma) out.direction = 'DOWN';
  else               out.direction = 'RANGING';

  // Structure tag
  const rangePct = (out.rangeHigh - out.rangeLow) / out.rangeLow;
  if (out.consecutive.up >= 4 || out.consecutive.down >= 4) out.structure = 'EXTENDED';
  else if (rangePct < 0.015)                                out.structure = 'CHOP';
  else                                                       out.structure = 'TRENDING';

  out.valid = true;
  return out;
}

// ─── 1H positional analysis ─────────────────────────────
// Purpose: tell the strategies WHERE in the 1H landscape we are.
// Mean-reversion plays prefer NEAR_HIGH/NEAR_LOW; continuation plays
// prefer MIDRANGE breakouts.
export function analyze1H(barsIn, currentPrice) {
  const bars = closedBars(barsIn);
  const out = {
    valid: false,
    position: 'UNKNOWN',     // 'NEAR_HIGH' | 'NEAR_LOW' | 'MIDRANGE' | 'UNKNOWN'
    range1H: { high: null, low: null, mid: null },
    pctOfRange: null,        // 0..1 (0 = at low, 1 = at high)
    ema21: null,
    ema50: null,
    trendBias: 'NEUTRAL',    // 'UP' | 'DOWN' | 'NEUTRAL' (EMA stack)
    structurePattern: 'NEUTRAL',  // 'HH_HL' | 'LH_LL' | 'HH_LL' | 'LH_HL' | 'NEUTRAL'
    swingHighs: [],
    swingLows:  [],
    atr14: null,
    last: null,
  };
  if (bars.length < 6) return out;

  const closes = bars.map(b => b.close);
  out.ema21 = ema(closes, 21);
  out.ema50 = ema(closes, 50);
  out.atr14 = atr(bars, 14);
  out.last  = bars[bars.length - 1];

  const lookback = bars.slice(-12);   // ~12 hours
  const high = Math.max(...lookback.map(b => b.high));
  const low  = Math.min(...lookback.map(b => b.low));
  const mid  = (high + low) / 2;
  out.range1H = { high, low, mid };

  const px = currentPrice ?? out.last.close;
  const span = high - low;
  out.pctOfRange = span > 0 ? Math.max(0, Math.min(1, (px - low) / span)) : 0.5;

  if      (out.pctOfRange >= 0.85) out.position = 'NEAR_HIGH';
  else if (out.pctOfRange <= 0.15) out.position = 'NEAR_LOW';
  else                              out.position = 'MIDRANGE';

  if (out.ema21 != null && out.ema50 != null) {
    if      (out.ema21 > out.ema50 && px > out.ema21) out.trendBias = 'UP';
    else if (out.ema21 < out.ema50 && px < out.ema21) out.trendBias = 'DOWN';
    else                                              out.trendBias = 'NEUTRAL';
  }

  // Structure pattern — last 2 swing highs and last 2 swing lows.
  // HH_HL = uptrend, LH_LL = downtrend, mixed = no clear structure.
  const sw = swingPoints(bars, 2);
  out.swingHighs = sw.highs.slice(-3).map(s => s.price);
  out.swingLows  = sw.lows.slice(-3).map(s => s.price);
  if (out.swingHighs.length >= 2 && out.swingLows.length >= 2) {
    const hh = out.swingHighs[out.swingHighs.length - 1] > out.swingHighs[out.swingHighs.length - 2];
    const lh = out.swingHighs[out.swingHighs.length - 1] < out.swingHighs[out.swingHighs.length - 2];
    const hl = out.swingLows[out.swingLows.length - 1]   > out.swingLows[out.swingLows.length - 2];
    const ll = out.swingLows[out.swingLows.length - 1]   < out.swingLows[out.swingLows.length - 2];
    if      (hh && hl) out.structurePattern = 'HH_HL';
    else if (lh && ll) out.structurePattern = 'LH_LL';
    else if (hh && ll) out.structurePattern = 'HH_LL';   // expansion
    else if (lh && hl) out.structurePattern = 'LH_HL';   // contraction
    else               out.structurePattern = 'NEUTRAL';
  }

  out.valid = true;
  return out;
}

// ─── 5M trigger analysis ────────────────────────────────
// Purpose: trigger-quality signals. Engines combine these with FVG/sweep
// detection to fire entries.
export function analyze5M(barsIn, currentPrice, vwap) {
  const all    = barsIn || [];
  const bars   = closedBars(all);
  const last   = all.length ? all[all.length - 1] : null;   // may be incomplete
  const out = {
    valid: false,
    ema8: null,
    ema21: null,
    stack: 'MIXED',          // 'BULL' | 'BEAR' | 'MIXED'
    rsi3: null,
    rsi3State: 'NEUTRAL',    // 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL'
    rsi14: null,
    vwapSide: 'AT',          // 'ABOVE' | 'BELOW' | 'AT'
    vwapDistPct: null,
    swingHighs: [],
    swingLows:  [],
    atr14: null,
    last,                    // includes incomplete bar if present
    lastClosed: null,        // strict closed bar — engines trigger on this
    barsClosed: bars.length,
  };
  if (bars.length < 6) return out;

  const closes = bars.map(b => b.close);
  out.ema8       = ema(closes, 8);
  out.ema21      = ema(closes, 21);
  out.rsi3       = rsi(closes, 3);
  out.rsi14      = rsi(closes, 14);
  out.atr14      = atr(bars, 14);
  out.lastClosed = bars[bars.length - 1];

  const px = currentPrice ?? out.lastClosed.close;
  if (out.ema8 != null && out.ema21 != null) {
    if      (px > out.ema8 && out.ema8 > out.ema21) out.stack = 'BULL';
    else if (px < out.ema8 && out.ema8 < out.ema21) out.stack = 'BEAR';
    else                                            out.stack = 'MIXED';
  }
  if (out.rsi3 != null) {
    if      (out.rsi3 >= 90) out.rsi3State = 'OVERBOUGHT';
    else if (out.rsi3 <= 10) out.rsi3State = 'OVERSOLD';
    else                     out.rsi3State = 'NEUTRAL';
  }
  if (vwap != null && Number.isFinite(vwap) && vwap > 0) {
    const d = (px - vwap) / vwap;
    out.vwapDistPct = d;
    if      (d >  0.0005) out.vwapSide = 'ABOVE';
    else if (d < -0.0005) out.vwapSide = 'BELOW';
    else                  out.vwapSide = 'AT';
  }

  const sw = swingPoints(bars, 3);
  out.swingHighs = sw.highs.slice(-5).map(s => s.price);
  out.swingLows  = sw.lows.slice(-5).map(s => s.price);

  out.valid = true;
  return out;
}
