/**
 * options-flow.js — HANK options chain analyzer
 *
 * Goal: confirm SPY/QQQ/IWM directional signals using live options data.
 * When the Webull options-chain API is enabled, this pulls real greeks +
 * IV + OI per strike. Until then, it computes greeks via Black-Scholes
 * using the underlying price + an ATR-derived IV estimate, so the
 * downstream consumers (executeScalpSignal, dashboard) get a working
 * `options-flow.json` shape today.
 *
 * Output (options-flow.json):
 *   {
 *     ts, time,
 *     SPY: {
 *       underlying, atr,
 *       chains: {
 *         '0DTE': {
 *           expiry,
 *           atmCall: { strike, price, delta, gamma, vega, theta, iv, oi, vol },
 *           atmPut:  { ... },
 *           putCallVolRatio, putCallOIRatio,
 *           skew: 'flat'|'bullish'|'bearish'|'fearful',
 *           verdict: { direction: 'CALLS'|'PUTS'|'NEUTRAL', confidence: 0..100 }
 *         },
 *         '1DTE': {...},
 *         'weekly': {...}
 *       }
 *     },
 *     QQQ: {...},
 *     IWM: {...},
 *   }
 *
 * Confirmation API:
 *   confirmDirection(instrument, direction) → { confirms: bool, confidence: 0..100, reason }
 *
 * Used by monitor.js to upgrade MEDIUM signals to HIGH when chain confirms.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { blackScholes, getTradingTimeRemaining, getETString } from './theta.js';
import { jAlert, jError } from './journal.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLOW_FILE = join(__dirname, 'options-flow.json');

let _getOptionsExpirations = null, _loadConsumerToken = null;
try {
  const wb = await import('./webull.js');
  _getOptionsExpirations = wb.getOptionsExpirations;
  _loadConsumerToken     = wb.loadConsumerToken;
} catch {}

const INSTRUMENTS = ['SPY', 'QQQ', 'IWM'];

/**
 * Compute synthetic chain when Webull API is unavailable.
 * Uses BS with an ATR-derived IV proxy. Output is internally consistent —
 * delta/gamma/theta/vega all from the same model — but IV and OI are stubs.
 *
 * @param {object} ctx { instrument, underlying, atr, expiry, T }
 * @returns chain analytics
 */
function syntheticChain({ instrument, underlying, atr, expiry, T }) {
  const ivProxy = atr > 0 ? Math.min(2.0, Math.max(0.10, (atr / underlying) * Math.sqrt(252) * 16)) : 0.30;
  const stepPct = instrument === 'SPY' ? 0.001 : instrument === 'QQQ' ? 0.0015 : 0.003;

  // Strike grid: ATM ± 5 steps (rounded to nearest dollar)
  const grid = [];
  for (let i = -5; i <= 5; i++) {
    const k = Math.round(underlying * (1 + i * stepPct));
    grid.push(k);
  }

  const strikes = grid.map(k => {
    const callBs = blackScholes(underlying, k, T, 0.05, ivProxy, 'call');
    const putBs  = blackScholes(underlying, k, T, 0.05, ivProxy, 'put');
    return {
      strike: k,
      call: { ...callBs, iv: ivProxy, oi: null, vol: null },
      put:  { ...putBs,  iv: ivProxy, oi: null, vol: null },
    };
  });

  const atmIdx = grid.findIndex(k => k === Math.round(underlying));
  const atm = atmIdx >= 0 ? strikes[atmIdx] : strikes[Math.floor(strikes.length / 2)];

  // Synthetic skew = flat. With real chain we'd compute IV skew ATM vs OTM.
  return {
    expiry, T,
    ivProxy: parseFloat(ivProxy.toFixed(3)),
    strikes,
    atmCall: atm.call,
    atmPut:  atm.put,
    putCallVolRatio: null,
    putCallOIRatio:  null,
    skew: 'flat',
    source: 'synthetic',
    verdict: { direction: 'NEUTRAL', confidence: 30, reason: 'synthetic-only — no live chain' },
  };
}

// Cache full chains for ~30s — Webull rate-limits aggressively and we have
// 3 instruments × 3 expirations to fetch each poll. One call per instrument
// per ~30s is plenty.
const _chainCache = new Map(); // key `${instrument}` → { data, ts }
const CHAIN_TTL_MS = 25_000;

async function fetchInstrumentChains(instrument) {
  const cached = _chainCache.get(instrument);
  if (cached && Date.now() - cached.ts < CHAIN_TTL_MS) return cached.data;
  const data = await _getOptionsExpirations(instrument);
  _chainCache.set(instrument, { data, ts: Date.now() });
  return data;
}

// Build live chain analytics from a single expiration's strike list.
function buildLiveChain(instrument, expiry, T, strikes, underlying) {
  // Find ATM by strike-vs-underlying distance
  const atm = strikes.reduce((best, s) =>
    Math.abs(s.strikePrice - underlying) < Math.abs((best?.strikePrice ?? 1e9) - underlying) ? s : best, null);
  if (!atm) return null;

  const atmCall = atm.call;
  const atmPut  = atm.put;

  // Aggregate volume + OI for the put/call ratio
  let callVol = 0, putVol = 0, callOI = 0, putOI = 0;
  for (const s of strikes) {
    callVol += s.call?.volume ?? 0;
    putVol  += s.put?.volume  ?? 0;
    callOI  += s.call?.oi     ?? 0;
    putOI   += s.put?.oi      ?? 0;
  }
  const putCallVolRatio = callVol > 0 ? putVol / callVol : null;
  const putCallOIRatio  = callOI > 0 ? putOI / callOI : null;

  // IV skew — compare ATM IV to a 5-strike OTM put vs 5-strike OTM call.
  // bullish skew: OTM call IV > OTM put IV; bearish: opposite.
  const idx = strikes.findIndex(s => s === atm);
  const otmPut  = strikes[Math.max(0, idx - 5)]?.put;
  const otmCall = strikes[Math.min(strikes.length - 1, idx + 5)]?.call;
  let skew = 'flat';
  if (otmPut?.iv && otmCall?.iv) {
    const diff = otmCall.iv - otmPut.iv;
    if (diff > 0.02) skew = 'bullish';
    else if (diff < -0.04) skew = 'fearful';   // pronounced put bid
    else if (diff < -0.02) skew = 'bearish';
  }

  // Verdict — combines skew + P/C ratio
  let direction = 'NEUTRAL', confidence = 40, reason = 'live chain — neutral';
  if (skew === 'bullish' && putCallVolRatio != null && putCallVolRatio < 0.7) {
    direction = 'CALLS'; confidence = 70; reason = `bullish skew, P/C vol ${putCallVolRatio.toFixed(2)}`;
  } else if ((skew === 'bearish' || skew === 'fearful') && putCallVolRatio != null && putCallVolRatio > 1.3) {
    direction = 'PUTS'; confidence = skew === 'fearful' ? 80 : 70; reason = `${skew} skew, P/C vol ${putCallVolRatio.toFixed(2)}`;
  }

  return {
    expiry, T,
    ivProxy: atmCall?.iv ?? atmPut?.iv ?? null,
    atmCall, atmPut,
    putCallVolRatio: putCallVolRatio != null ? parseFloat(putCallVolRatio.toFixed(3)) : null,
    putCallOIRatio:  putCallOIRatio  != null ? parseFloat(putCallOIRatio.toFixed(3))  : null,
    skew,
    source: 'live',
    verdict: { direction, confidence, reason },
  };
}

/**
 * Build chain analytics for one expiry.
 * Tries Webull live data first, falls back to synthetic on failure.
 */
async function buildChain(instrument, underlying, atr, expiry, daysAhead, liveData = null) {
  const T = getTradingTimeRemaining(instrument === 'SPX' ? 'SPX' : 'SPY').T + daysAhead / 365;

  // ── Live path: requires consumer token + successful chain fetch ────────
  if (liveData && !liveData.error) {
    const strikes = liveData.chains[expiry] ?? null;
    if (strikes?.length) {
      const live = buildLiveChain(instrument, expiry, T, strikes, underlying);
      if (live) return live;
    }
  }

  // ── Synthetic fallback ─────────────────────────────────────────────────
  return syntheticChain({ instrument, underlying, atr, expiry, T });
}

function nextTradingDate(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  // Skip weekends
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Main entry — polls all three instruments, writes options-flow.json.
 *
 * @param {object} state — { SPY: {price, atr}, QQQ: {price, atr}, IWM: {price, atr} }
 * @returns the snapshot object that was written
 */
export async function pollOptionsFlow(state) {
  try {
    const out      = { ts: Date.now(), time: getETString() };
    const haveTok  = _loadConsumerToken && _loadConsumerToken();
    out.source     = haveTok && _getOptionsExpirations ? 'live' : 'synthetic';

    for (const inst of INSTRUMENTS) {
      const s = state?.[inst];
      if (!s?.price) { out[inst] = null; continue; }

      // Fetch live chain ONCE per instrument; reuse for 0DTE/1DTE/weekly.
      // Webull's strategy/list returns ALL expirations in one call.
      let live = null;
      if (haveTok && _getOptionsExpirations) {
        try { live = await fetchInstrumentChains(inst); }
        catch (e) { jError('options-flow-live', e.message, { instrument: inst }); }
      }

      // Pick actual expiration dates from the live response when available;
      // fall back to date math otherwise.
      const liveDates = (live?.expirations ?? []).map(e => e.date);
      const today     = liveDates[0] ?? nextTradingDate(0);
      const tomorrow  = liveDates[1] ?? nextTradingDate(1);
      const weekly    = liveDates.find(d => d > tomorrow) ?? nextTradingDate(5);

      const [d0, d1, dw] = await Promise.all([
        buildChain(inst, s.price, s.atr ?? s.price * 0.005, today,    0, live),
        buildChain(inst, s.price, s.atr ?? s.price * 0.005, tomorrow, 1, live),
        buildChain(inst, s.price, s.atr ?? s.price * 0.005, weekly,   5, live),
      ]);

      out[inst] = {
        underlying: s.price,
        atr:        s.atr ?? null,
        source:     live && !live.error ? 'live' : (live?.error ?? 'synthetic'),
        chains: { '0DTE': d0, '1DTE': d1, 'weekly': dw },
      };
    }
    writeFileSync(FLOW_FILE, JSON.stringify(out, null, 2));
    return out;
  } catch (e) { jError('options-flow', e.message); return null; }
}

/**
 * Read latest options-flow.json — used by gates.
 */
export function getOptionsFlow() {
  try {
    if (!existsSync(FLOW_FILE)) return null;
    const data = JSON.parse(readFileSync(FLOW_FILE, 'utf8'));
    if (Date.now() - (data.ts ?? 0) > 5 * 60 * 1000) return null; // stale > 5 min
    return data;
  } catch { return null; }
}

/**
 * Confirm a direction against the latest 0DTE chain.
 * Returns { confirms, confidence, reason }.
 *
 * Today's logic (synthetic-only): always returns confirms=null because we
 * don't have live OI/volume/skew data. When Webull options chain API is
 * enabled, this becomes a real confirmation gate.
 */
export function confirmDirection(instrument, direction) {
  const flow = getOptionsFlow();
  if (!flow?.[instrument]?.chains?.['0DTE']) {
    return { confirms: null, confidence: 0, reason: 'no-flow-data' };
  }
  const ch = flow[instrument].chains['0DTE'];
  if (ch.source === 'synthetic') {
    return { confirms: null, confidence: 0, reason: 'synthetic-chain' };
  }

  // Real chain logic (placeholder until live data wires in)
  const want = direction === 'CALLS';
  const skew = ch.skew;
  const pcRatio = ch.putCallVolRatio ?? 1.0;

  if (want && skew === 'bullish' && pcRatio < 0.7) {
    return { confirms: true, confidence: 70, reason: `bullish skew, P/C vol ${pcRatio.toFixed(2)}` };
  }
  if (!want && skew === 'bearish' && pcRatio > 1.3) {
    return { confirms: true, confidence: 70, reason: `bearish skew, P/C vol ${pcRatio.toFixed(2)}` };
  }
  if ((want && skew === 'bearish') || (!want && skew === 'bullish')) {
    return { confirms: false, confidence: 60, reason: `chain disagrees (skew ${skew})` };
  }
  return { confirms: null, confidence: 30, reason: `chain neutral (skew ${skew}, P/C ${pcRatio.toFixed(2)})` };
}
