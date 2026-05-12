#!/usr/bin/env node
/**
 * analyze-signals.js — Per-instrument signal-quality analyzer (read-only)
 *
 * Reads today's journal + paper-ledger and produces a markdown report
 * comparing signal accuracy across SPY/QQQ/IWM/ES1!/NQ1!/MES1!.
 *
 * Pure observability — does not touch the trading engine, monitors, Pine,
 * or webhook server. Read-only against:
 *   - logs/journal/journal-{YYYY-MM-DD}.jsonl
 *   - paper-ledger.json
 *
 * Run:  node analyze-signals.js                 # today
 *       node analyze-signals.js 2026-05-12      # specific date
 *
 * Output: per-instrument-signal-quality-{YYYY-MM-DD}.md (project root)
 *
 * Data sources per instrument:
 *   SPY/QQQ/IWM: per-instrument POLL records (every 30s, price+vwap+delta)
 *                provide full T+5/T+15/T+30 timelines.
 *   ES1!/NQ1!/MES1!: NO POLL data (no monitor polls futures). Post-signal
 *                    prices are inferred from later Pine alert payloads on
 *                    the same instrument (sparse). Sections marked
 *                    "insufficient data" when no later signal exists within
 *                    horizon window.
 *
 * Signal filter:
 *   Pine-originated signals (webhook-server jSignal with pineAlert:true) are
 *   the primary target. Monitor-originated SIGNAL records (legacy TREND
 *   engine output, no longer dispatching under PINE_PRIMARY) are excluded
 *   by default. Pass --include-monitor to override.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname }                            from 'path';
import { fileURLToPath }                            from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(f => [f.slice(2).split('=')[0], f.slice(2).split('=')[1] ?? true]));

function etDate() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date());
  return `${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}-${parts.find(p=>p.type==='day').value}`;
}

const TARGET_DATE = args[0] || etDate();
const INCLUDE_MONITOR = !!flags['include-monitor'];

// ─── Load journal + ledger ────────────────────────────────────────────────────
const JOURNAL_PATH = join(__dirname, 'logs', 'journal', `journal-${TARGET_DATE}.jsonl`);
const LEDGER_PATH  = join(__dirname, 'paper-ledger.json');
const OUTPUT_PATH  = join(__dirname, `per-instrument-signal-quality-${TARGET_DATE}.md`);

if (!existsSync(JOURNAL_PATH)) {
  console.error(`No journal found at ${JOURNAL_PATH}`);
  process.exit(1);
}

const journalLines = readFileSync(JOURNAL_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
const records = [];
for (const line of journalLines) {
  try { records.push(JSON.parse(line)); } catch {}
}

let ledger = null;
if (existsSync(LEDGER_PATH)) {
  try { ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8')); } catch {}
}

// ─── RTH window helpers ───────────────────────────────────────────────────────
// 09:30 ET = 13:30 UTC during DST. We rely on the journal's `time` field (ET
// HH:MM:SS) where present, falling back to ts (epoch ms) converted to ET.
function tsToETMins(ts) {
  const d = new Date(ts);
  const et = new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', hour12:false, hour:'2-digit', minute:'2-digit' }).format(d);
  const [h, m] = et.split(':').map(Number);
  return h * 60 + m;
}
const RTH_START_MIN = 9 * 60 + 30;
const RTH_END_MIN   = 15 * 60 + 45;
function isRTH(ts) {
  const m = tsToETMins(ts);
  return m >= RTH_START_MIN && m < RTH_END_MIN;
}

// ─── Extract Pine signals during RTH ──────────────────────────────────────────
function isPineSignal(r) {
  if (r.type !== 'SIGNAL') return false;
  if (r.pineAlert === true) return true;
  if (INCLUDE_MONITOR) return true;
  return false;
}

const signals = records.filter(r => isPineSignal(r) && isRTH(r.ts));

// ─── Build per-instrument POLL price timeline ─────────────────────────────────
// SPY/QQQ/IWM: POLL records have instrument-keyed nested objects with .price
const pollTimelines = { SPY: [], QQQ: [], IWM: [] };
for (const r of records) {
  if (r.type !== 'POLL') continue;
  for (const inst of ['SPY','QQQ','IWM']) {
    const ko = inst.toLowerCase();
    const node = r[ko];
    if (node && Number.isFinite(node.price)) {
      pollTimelines[inst].push({ ts: r.ts, price: node.price, vwap: node.vwap ?? null });
    }
  }
}
// Sort timelines by ts ascending
for (const inst of Object.keys(pollTimelines)) pollTimelines[inst].sort((a,b) => a.ts - b.ts);

// For futures, build sparse timeline from Pine signals (each carries price)
const futuresSignalPrices = { 'ES1!': [], 'NQ1!': [], 'MES1!': [], 'MNQ1!': [] };
for (const s of records.filter(r => isPineSignal(r))) {
  const inst = s.instrument;
  if (futuresSignalPrices[inst] && Number.isFinite(s.price)) {
    futuresSignalPrices[inst].push({ ts: s.ts, price: s.price });
  }
}
for (const inst of Object.keys(futuresSignalPrices)) futuresSignalPrices[inst].sort((a,b) => a.ts - b.ts);

// ─── Price-at-horizon lookup ──────────────────────────────────────────────────
function priceAtHorizon(instrument, signalTs, horizonMin) {
  const targetTs = signalTs + horizonMin * 60_000;
  // SPY/QQQ/IWM: scan POLL timeline for nearest bar ≥ targetTs
  if (pollTimelines[instrument]) {
    const tl = pollTimelines[instrument];
    for (let i = 0; i < tl.length; i++) {
      if (tl[i].ts >= targetTs) {
        // Use this bar if within 60s tolerance; else null
        const drift = (tl[i].ts - targetTs) / 1000;
        return drift <= 60 ? { price: tl[i].price, ts: tl[i].ts, source: 'POLL', driftSec: drift } : null;
      }
    }
    return null;
  }
  // Futures: use later signal-payload prices as sparse proxy
  if (futuresSignalPrices[instrument]) {
    const sl = futuresSignalPrices[instrument];
    for (let i = 0; i < sl.length; i++) {
      if (sl[i].ts >= targetTs) {
        const drift = (sl[i].ts - targetTs) / 1000;
        return drift <= 5 * 60 ? { price: sl[i].price, ts: sl[i].ts, source: 'SIGNAL_PROXY', driftSec: drift } : null;
      }
    }
    return null;
  }
  return null;
}

// ─── Compute per-signal outcomes ──────────────────────────────────────────────
function evaluateSignal(s) {
  const inst = s.instrument;
  const entry = s.price;
  if (!Number.isFinite(entry)) return null;
  const dirMult = s.direction === 'CALLS' ? 1 : s.direction === 'PUTS' ? -1 : 0;
  if (dirMult === 0) return null;

  const horizons = [5, 15, 30];
  const out = {
    ts: s.ts,
    time: s.time,
    instrument: inst,
    direction: s.direction,
    engine: s.engine,
    confidence: s.confidence,
    entry,
    horizons: {},
  };
  for (const h of horizons) {
    const r = priceAtHorizon(inst, s.ts, h);
    if (r === null) {
      out.horizons[h] = { price: null, move: null, movePct: null, continuation: null, source: null };
    } else {
      const move = (r.price - entry) * dirMult;
      const movePct = (move / entry) * 100;
      out.horizons[h] = {
        price: r.price, move, movePct,
        continuation: move > 0,
        source: r.source,
        driftSec: r.driftSec,
      };
    }
  }
  // Time to first reversal (first horizon where move ≤ 0)
  let firstReversalMin = null;
  for (const h of horizons) {
    if (out.horizons[h].continuation === false) { firstReversalMin = h; break; }
  }
  out.firstReversalMin = firstReversalMin;
  // 5-min trade simulation: win = positive move at T+5
  out.fiveMinTradeWin = out.horizons[5].continuation;
  return out;
}

const evaluated = signals.map(evaluateSignal).filter(Boolean);

// ─── Aggregates per instrument ────────────────────────────────────────────────
const INSTRUMENTS = ['SPY','QQQ','IWM','ES1!','NQ1!','MES1!','MNQ1!'];

function summarizeInstrument(inst) {
  const evs = evaluated.filter(e => e.instrument === inst);
  if (evs.length === 0) return { instrument: inst, count: 0 };

  const horizons = [5, 15, 30];
  const summary = { instrument: inst, count: evs.length, byDirection: {}, byEngine: {}, horizons: {} };

  for (const dir of ['CALLS','PUTS']) {
    summary.byDirection[dir] = evs.filter(e => e.direction === dir).length;
  }
  for (const e of evs) {
    summary.byEngine[e.engine] = (summary.byEngine[e.engine] || 0) + 1;
  }

  for (const h of horizons) {
    const withData = evs.filter(e => e.horizons[h].continuation !== null);
    const cont     = withData.filter(e => e.horizons[h].continuation === true);
    const moves    = withData.map(e => e.horizons[h].move);
    const contMoves = cont.map(e => e.horizons[h].move);
    summary.horizons[h] = {
      sampleCount:       withData.length,
      missingCount:      evs.length - withData.length,
      continuationRate:  withData.length ? (cont.length / withData.length) : null,
      continuationCount: cont.length,
      avgMove:           moves.length ? moves.reduce((s,v)=>s+v,0)/moves.length : null,
      avgContinuationMove: contMoves.length ? contMoves.reduce((s,v)=>s+v,0)/contMoves.length : null,
      avgContinuationMovePct: cont.length
        ? cont.reduce((s,e)=>s+(e.horizons[h].movePct ?? 0),0)/cont.length
        : null,
    };
  }

  // Median time to first reversal (in min). null entries (no reversal in window) treated as 30+.
  const reversals = evs
    .map(e => e.firstReversalMin == null ? null : e.firstReversalMin)
    .filter(v => v !== null)
    .sort((a,b) => a - b);
  summary.medianTimeToReversal = reversals.length ? reversals[Math.floor(reversals.length/2)] : null;
  summary.noReversalWithin30Count = evs.filter(e => e.firstReversalMin === null && evs[0].horizons[30].continuation !== null).length;

  // 5-min trade win rate (continuation at T+5 = win)
  const fiveWithData = evs.filter(e => e.fiveMinTradeWin !== null);
  const fiveWins     = fiveWithData.filter(e => e.fiveMinTradeWin === true);
  summary.fiveMinTradeWinRate = fiveWithData.length ? fiveWins.length / fiveWithData.length : null;
  summary.fiveMinTradeSample  = fiveWithData.length;

  return summary;
}

const summaries = INSTRUMENTS.map(summarizeInstrument);

// ─── Outlier detection — flag instruments whose T+5 continuation rate differs ─
// ─── from SPY by ≥ 20% ────────────────────────────────────────────────────────
const spy = summaries.find(s => s.instrument === 'SPY');
const spyRate = spy?.horizons?.[5]?.continuationRate;
const outliers = [];
if (spyRate != null) {
  for (const s of summaries) {
    if (s.instrument === 'SPY') continue;
    const r = s.horizons?.[5]?.continuationRate;
    if (r != null && Math.abs(r - spyRate) >= 0.20) {
      outliers.push({ instrument: s.instrument, rate: r, deltaFromSpy: r - spyRate });
    }
  }
}

// ─── Render markdown report ───────────────────────────────────────────────────
function pct(v)   { return v == null ? 'n/a' : `${(v*100).toFixed(1)}%`; }
function num(v,d=2) { return v == null ? 'n/a' : (typeof v === 'number' ? v.toFixed(d) : String(v)); }

const lines = [];
lines.push(`# Per-Instrument Signal Quality — ${TARGET_DATE}`);
lines.push('');
lines.push(`**Run:** ${new Date().toISOString()}`);
lines.push(`**Source journal:** \`${JOURNAL_PATH.replace(__dirname + '\\', '').replace(/\\/g,'/')}\``);
lines.push(`**Total records in journal:** ${records.length}`);
lines.push(`**Pine signals during RTH (09:30-15:45 ET):** ${signals.length}`);
lines.push(`**Evaluated signals (had numeric entry price):** ${evaluated.length}`);
if (INCLUDE_MONITOR) lines.push(`**Note:** --include-monitor active — monitor-originated SIGNAL records also included.`);
lines.push('');

lines.push('## Comparative Summary');
lines.push('');
lines.push('| Instrument | Signals | T+5 cont% | T+15 cont% | T+30 cont% | T+5 win% (n) | Avg cont move (pts @ T+5) | Median t-to-reversal |');
lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
for (const s of summaries) {
  if (s.count === 0) {
    lines.push(`| ${s.instrument} | 0 | — | — | — | — | — | — |`);
    continue;
  }
  const h5  = s.horizons?.[5]  ?? {};
  const h15 = s.horizons?.[15] ?? {};
  const h30 = s.horizons?.[30] ?? {};
  lines.push(`| ${s.instrument} | ${s.count} | ${pct(h5.continuationRate)} (n=${h5.sampleCount}) | ${pct(h15.continuationRate)} (n=${h15.sampleCount}) | ${pct(h30.continuationRate)} (n=${h30.sampleCount}) | ${pct(s.fiveMinTradeWinRate)} (n=${s.fiveMinTradeSample}) | ${num(h5.avgContinuationMove)} | ${s.medianTimeToReversal == null ? 'n/a' : s.medianTimeToReversal + ' min'} |`);
}
lines.push('');

if (outliers.length) {
  lines.push('## ⚠ Outliers (T+5 continuation rate ≥ 20% off SPY baseline)');
  lines.push('');
  for (const o of outliers) {
    lines.push(`- **${o.instrument}**: ${pct(o.rate)} continuation rate at T+5, **${o.deltaFromSpy > 0 ? '+' : ''}${(o.deltaFromSpy*100).toFixed(1)}%** vs SPY baseline (${pct(spyRate)})`);
  }
  lines.push('');
  lines.push('This is the signal that motivates parameter divergence per instrument. Review the per-instrument detail below for engine-mix and direction-mix context before committing to Pine changes.');
  lines.push('');
}

// Per-instrument detail
for (const s of summaries) {
  lines.push(`## ${s.instrument}`);
  if (s.count === 0) {
    lines.push('');
    lines.push('No signals fired during RTH today.');
    lines.push('');
    continue;
  }
  lines.push('');
  lines.push(`**Total signals:** ${s.count} (${s.byDirection.CALLS ?? 0} CALLS, ${s.byDirection.PUTS ?? 0} PUTS)`);
  const engBreak = Object.entries(s.byEngine).map(([k,v]) => `${k}:${v}`).join(', ');
  lines.push(`**By engine:** ${engBreak}`);
  lines.push('');
  lines.push('| Horizon | Sample | Cont rate | Cont count | Avg move (pts) | Avg cont move (pts) | Avg cont move % |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const h of [5,15,30]) {
    const hh = s.horizons[h];
    lines.push(`| T+${h}min | ${hh.sampleCount}/${s.count} | ${pct(hh.continuationRate)} | ${hh.continuationCount} | ${num(hh.avgMove)} | ${num(hh.avgContinuationMove)} | ${num(hh.avgContinuationMovePct)}% |`);
  }
  lines.push('');
  if (s.horizons[5].missingCount > 0) {
    const src = pollTimelines[s.instrument] ? 'POLL records absent or stale' : 'no monitor for this instrument — futures rely on later-signal proxies which weren\'t available within tolerance window';
    lines.push(`> **Data gap:** ${s.horizons[5].missingCount}/${s.count} signals had no T+5 price (${src}).`);
    lines.push('');
  }
}

// Footer — methodology
lines.push('---');
lines.push('');
lines.push('## Methodology');
lines.push('');
lines.push('**Signal selection:** SIGNAL records in the day\'s journal with `pineAlert: true` (webhook-originated Pine alerts), filtered to RTH window 09:30:00–15:45:00 ET.');
lines.push('');
lines.push('**Price-at-horizon for SPY/QQQ/IWM:** scan POLL records (each monitor writes one per 30s poll) for the first record at or after `signal_ts + horizon * 60s`. Tolerance: 60s drift before declaring "no data."');
lines.push('');
lines.push('**Price-at-horizon for futures (ES1!/NQ1!/MES1!/MNQ1!):** no monitor polls futures. Forward prices are sparse — taken from any later Pine signal payload on the same instrument within 5-minute drift tolerance. Most futures signals will show `n/a` at one or more horizons because subsequent signals didn\'t arrive in window.');
lines.push('');
lines.push('**Continuation:** move in the signal\'s direction at the horizon is positive (`(P_horizon - P_entry) * dirMult > 0`).');
lines.push('');
lines.push('**5-min trade win rate:** simplistic — counts signals where T+5 continuation is true. Does NOT simulate stops, slippage, or commission. Use as a relative comparison metric across instruments, not an absolute P&L estimate.');
lines.push('');
lines.push('**Outlier flag:** any instrument whose T+5 continuation rate differs from SPY by ≥ 20 percentage points.');
lines.push('');
lines.push('**Limitations:**');
lines.push('- 5-min win rate ignores intra-bar stop-outs; a signal that ran +10pts then reversed -15pts shows as "win" if T+5 close is positive.');
lines.push('- Futures data is sparse — comparisons including futures are weaker.');
lines.push('- ATR-based stop simulation NOT implemented in this version (requires 1m OHLC bars per instrument; future enhancement if needed).');
lines.push('');

// Write report
writeFileSync(OUTPUT_PATH, lines.join('\n'));
console.log(`\nWrote ${OUTPUT_PATH}`);
console.log(`Pine signals during RTH: ${signals.length}`);
console.log(`Evaluated: ${evaluated.length}`);
console.log(`Outliers (T+5 ≥ 20% off SPY): ${outliers.length}`);
if (outliers.length) {
  for (const o of outliers) console.log(`  ⚠ ${o.instrument}: ${pct(o.rate)} cont (${(o.deltaFromSpy*100).toFixed(1)}% vs SPY)`);
}
