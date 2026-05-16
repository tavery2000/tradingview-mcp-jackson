#!/usr/bin/env node
/**
 * analyze-calibration.js — historical win-rate lookup table builder
 *
 * Phase 1 of the confidence-calibration system (2026-05-16). Reads
 * paper-ledger.json + futures-ledger.json, applies exclusions, aggregates
 * trades across 5 fallback levels (most-specific → engine baseline), computes
 * expectancy-driven block flags + WR-tier sizing multipliers, and writes:
 *
 *   - docs/confidence-calibration-2026-05-16.md   (operator review)
 *   - data/calibration-lookup.json                (Phase 3 wiring input)
 *
 * Plus a console summary for quick-read.
 *
 * Re-runnable. Re-run anytime to fold in new days of data; today's date
 * goes into the output filenames + JSON version string.
 *
 * Run: node analyze-calibration.js
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TODAY_DATE = '2026-05-16';

const PAPER_LEDGER   = join(__dirname, 'paper-ledger.json');
const FUTURES_LEDGER = join(__dirname, 'futures-ledger.json');
const DOC_OUT        = join(__dirname, 'docs', `confidence-calibration-${TODAY_DATE}.md`);
const JSON_OUT       = join(__dirname, 'data', `calibration-lookup.json`);
const SAMPLE_THRESHOLD = 20;
const WARN_THRESHOLD   = 40;

// ───────────────────────── Helpers ─────────────────────────
function getETDateFromMs(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));
}
function getDOWFromMs(ms) {
  const dayShort = new Date(ms).toLocaleDateString('en-US', { timeZone:'America/New_York', weekday: 'short' });
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[dayShort];
}
function getETMinsFromMs(ms) {
  const t = new Date(ms).toLocaleTimeString('en-US', { timeZone:'America/New_York', hour12:false, hour:'2-digit', minute:'2-digit' });
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function timeBucket(etMins) {
  if (etMins < 9 * 60 + 30)         return '04:00-09:30';   // pre-market / overnight late
  if (etMins < 10 * 60)             return '09:30-10:00';
  if (etMins < 11 * 60)             return '10:00-11:00';
  if (etMins < 12 * 60)             return '11:00-12:00';
  if (etMins < 13 * 60)             return '12:00-13:00';
  if (etMins < 14 * 60)             return '13:00-14:00';
  if (etMins < 15 * 60)             return '14:00-15:00';
  if (etMins < 15 * 60 + 30)        return '15:00-15:30';
  if (etMins < 16 * 60)             return '15:30-16:00';
  if (etMins < 18 * 60)             return '16:00-18:00';
  if (etMins < 22 * 60)             return '18:00-22:00';
  return '22:00-04:00';
}
function sessionType(ms) {
  const mins = getETMinsFromMs(ms);
  const dow  = getDOWFromMs(ms);
  if (dow === 0 || dow === 6) return 'GLOBEX_NIGHT';
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return 'REGULAR';
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return 'PREMARKET';
  if (mins >= 16 * 60 && mins < 22 * 60) return 'GLOBEX_EVENING';
  return 'GLOBEX_NIGHT';
}
function macroToBias(macro4H) {
  switch ((macro4H || '').toUpperCase()) {
    case 'UP':      return 'bullish';
    case 'DOWN':    return 'bearish';
    case 'RANGING': return 'coiled';
    case 'UNKNOWN': return 'neutral';
    default:        return 'unknown';
  }
}
function safeJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }

// ───────────────────────── Load + normalize ─────────────────────────
const auditExclusions = {
  not_closed: 0, voided_corrupted: 0, iwm_retired: 0, moo_moc_retired: 0,
  duration_too_short: 0, duration_too_long: 0, dirty_5_15: 0,
  scale_out_partial: 0, no_fill_time: 0, no_pnl: 0,
};
const auditAnomalies = [];

function normalizeTrade(t, source) {
  if (!t.fillTime) { auditExclusions.no_fill_time++; return null; }
  if (t.status !== 'CLOSED') { auditExclusions.not_closed++; return null; }
  if (t.status === 'VOIDED_CORRUPTED' || t.corrupted_phantom) { auditExclusions.voided_corrupted++; return null; }
  if (t.exitReason === 'SCALE_OUT_PARTIAL') { auditExclusions.scale_out_partial++; return null; }
  if (t.pnl == null) { auditExclusions.no_pnl++; return null; }

  const inst = (t.instrument || '').toUpperCase();
  if (inst === 'IWM') { auditExclusions.iwm_retired++; return null; }
  if (['MOO','MOC'].includes((t.engine||'').toUpperCase())) { auditExclusions.moo_moc_retired++; return null; }

  const dateKey = getETDateFromMs(t.fillTime);
  if (dateKey === '2026-05-15') { auditExclusions.dirty_5_15++; return null; }

  // Duration filters
  const holdMins = t.holdMins ?? ((t.exitTime - t.fillTime) / 60000);
  if (holdMins < 1) { auditExclusions.duration_too_short++; return null; }
  if (holdMins > 2 * 24 * 60) {                  // > 2 trading days
    auditExclusions.duration_too_long++;
    auditAnomalies.push({ kind: 'duration_too_long', requestId: t.requestId, holdMins });
    return null;
  }

  // Derive fields not always present
  const fillMs = t.fillTime;
  const etMins = getETMinsFromMs(fillMs);
  const tBucket = timeBucket(etMins);
  const sType   = sessionType(fillMs);

  // Direction: prefer explicit signal, else parse from requestId prefix
  let direction = (t.signal || '').toUpperCase();
  if (!direction && t.requestId) {
    if (t.requestId.startsWith('CALLS_')) direction = 'CALLS';
    else if (t.requestId.startsWith('PUTS_')) direction = 'PUTS';
    else if (t.requestId.startsWith('FUT_CALLS_')) direction = 'CALLS';
    else if (t.requestId.startsWith('FUT_PUTS_'))  direction = 'PUTS';
  }

  return {
    requestId:  t.requestId,
    source,                                          // 'options' | 'futures'
    instrument: inst,
    engine:     (t.engine || 'UNKNOWN').toUpperCase(),
    direction:  direction || 'UNKNOWN',
    conf:       (t.confidence || 'UNKNOWN').toUpperCase(),
    bias:       macroToBias(t.macro4H),
    timeBucket: tBucket,
    sessionType: sType,
    pnl:        t.pnl,
    win:        t.win === true || (t.win == null && t.pnl > 0),
    exitReason: t.exitReason || 'UNKNOWN',
    holdMins,
    fillTimeET: t.fillTimeET,
    exitTimeET: t.exitTimeET,
    fillDate:   dateKey,
  };
}

const paper   = safeJson(PAPER_LEDGER);
const futures = safeJson(FUTURES_LEDGER);

const rawTrades = [];
if (paper?.trades)   rawTrades.push(...paper.trades.map(t => ({ ...t, _source: 'options' })));
if (futures?.trades) rawTrades.push(...futures.trades.map(t => ({ ...t, _source: 'futures' })));

const trades = rawTrades.map(t => normalizeTrade(t, t._source)).filter(Boolean);
const totalIn = rawTrades.length;
const totalOut = trades.length;

console.log(`\n📊 Calibration analyzer — ${TODAY_DATE}`);
console.log(`   input trades:    ${totalIn}`);
console.log(`   after exclusions:${totalOut}`);
console.log(`   excluded breakdown:`);
for (const [k, v] of Object.entries(auditExclusions)) if (v) console.log(`     ${k.padEnd(22)} ${v}`);

// ───────────────────────── Aggregation ─────────────────────────
function newBucket() {
  return { count: 0, wins: 0, losses: 0, sumPnl: 0, sumWinPnl: 0, sumLossPnl: 0, sumSq: 0, members: [] };
}
function accumulate(b, t) {
  b.count++;
  if (t.win) { b.wins++;   b.sumWinPnl  += t.pnl; }
  else       { b.losses++; b.sumLossPnl += t.pnl; }
  b.sumPnl += t.pnl;
  b.sumSq  += t.pnl * t.pnl;
  b.members.push(t.requestId);
}
function finalize(b) {
  if (!b.count) return null;
  const wr     = b.wins / b.count;
  const avgWin = b.wins > 0 ? b.sumWinPnl / b.wins : 0;
  const avgLoss = b.losses > 0 ? b.sumLossPnl / b.losses : 0;     // negative
  const grossWin  = b.sumWinPnl;
  const grossLoss = Math.abs(b.sumLossPnl);
  const pf  = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const mean = b.sumPnl / b.count;
  const variance = (b.sumSq / b.count) - (mean * mean);
  const std = variance > 0 ? Math.sqrt(variance) : 0;
  const sharpeLike = std > 0 ? mean / std : 0;
  const expectancy = (wr * avgWin) + ((1 - wr) * avgLoss);
  return {
    sample_size: b.count,
    wins: b.wins, losses: b.losses,
    win_rate: round(wr, 4),
    avg_win:  round(avgWin, 2),
    avg_loss: round(avgLoss, 2),
    net_pnl:  round(b.sumPnl, 2),
    profit_factor: pf === Infinity ? null : round(pf, 3),
    profit_factor_infinite: pf === Infinity,
    expectancy: round(expectancy, 2),
    sharpe_like: round(sharpeLike, 3),
  };
}
function round(n, dp) { const f = Math.pow(10, dp); return Math.round(n * f) / f; }

// 5-level keys per the revised spec
function makeKeys(t) {
  const L1 = `${t.engine}_${t.conf}_${t.bias}_${t.instrument}_${t.timeBucket}_${t.direction}`;
  const L2 = `${t.engine}_${t.conf}_${t.bias}_${t.instrument}_${t.sessionType}_${t.direction}`;
  const L3 = `${t.engine}_${t.conf}_${t.bias}_${t.instrument}_${t.direction}`;
  const L4 = `${t.engine}_${t.conf}_${t.instrument}`;
  const L5 = `${t.engine}`;
  return { L1, L2, L3, L4, L5 };
}

const levelBuckets = { 1: new Map(), 2: new Map(), 3: new Map(), 4: new Map(), 5: new Map() };
const keyMeta = new Map();    // key → { level, attrs }
for (const t of trades) {
  const keys = makeKeys(t);
  for (const L of [1, 2, 3, 4, 5]) {
    const k = keys[`L${L}`];
    if (!levelBuckets[L].has(k)) {
      levelBuckets[L].set(k, newBucket());
      keyMeta.set(k, {
        level: L,
        engine: t.engine,
        conf:   L >= 2 ? t.conf : undefined,
        bias:   L === 1 || L === 2 || L === 3 ? t.bias : undefined,
        instrument: L <= 4 ? t.instrument : undefined,
        time_bucket: L === 1 ? t.timeBucket : undefined,
        session_type: L === 2 ? t.sessionType : undefined,
        direction: L <= 3 ? t.direction : undefined,
      });
    }
    accumulate(levelBuckets[L].get(k), t);
  }
}

// ───────────────────────── Sizing + block logic ─────────────────────────
function decide(metrics) {
  let action, multiplier, blocked_reason = null;
  // Block triggers (any one fires)
  if (metrics.profit_factor != null && metrics.profit_factor < 1.0) {
    action = 'block'; multiplier = 0; blocked_reason = 'profit_factor_lt_1';
  } else if (metrics.expectancy <= 0 && metrics.sample_size >= 30) {
    action = 'block'; multiplier = 0; blocked_reason = 'expectancy_negative';
  } else if (metrics.win_rate < 0.40) {
    action = 'block'; multiplier = 0; blocked_reason = 'wr_lt_40';
  } else if (metrics.net_pnl < 0 && metrics.sample_size >= 30) {
    action = 'block'; multiplier = 0; blocked_reason = 'net_pnl_negative_30plus';
  } else if (metrics.win_rate >= 0.70) {
    action = 'max_allocation'; multiplier = 1.5;
  } else if (metrics.win_rate >= 0.60) {
    action = 'increased'; multiplier = 1.25;
  } else if (metrics.win_rate >= 0.50) {
    action = 'normal'; multiplier = 1.0;
  } else if (metrics.win_rate >= 0.45) {
    action = 'reduced'; multiplier = 0.5;
  } else {
    action = 'minimum'; multiplier = 0.25;
  }
  return { action, size_multiplier: multiplier, blocked_reason };
}

// ───────────────────────── Build cells + fallbacks ─────────────────────────
const allCells = [];
for (const L of [1, 2, 3, 4, 5]) {
  for (const [key, bucket] of levelBuckets[L].entries()) {
    const m = finalize(bucket);
    if (!m) continue;
    const meta = keyMeta.get(key);
    const decision = decide(m);
    allCells.push({
      key, level: L,
      ...meta,
      ...m,
      sample_warning: m.sample_size < WARN_THRESHOLD,
      sufficient_sample: m.sample_size >= SAMPLE_THRESHOLD,
      ...decision,
    });
  }
}

// All sufficient cells across every level. Phase 3 lookup will walk
// level 1 → 5 finding the most-specific match with N >= 20.
const allSufficient = allCells.filter(c => c.sufficient_sample).sort((a, b) => a.level - b.level || b.sample_size - a.sample_size);
const lookupCellsL1 = allSufficient.filter(c => c.level === 1);
const fallbackCells = allSufficient.filter(c => c.level !== 1);
const insufficient  = allCells.filter(c => !c.sufficient_sample);

// ───────────────────────── Roll-ups for the doc ─────────────────────────
function summarize(predicate, label) {
  const matching = trades.filter(predicate);
  const b = newBucket();
  for (const t of matching) accumulate(b, t);
  const m = finalize(b);
  return { label, ...m };
}

const engines = [...new Set(trades.map(t => t.engine))].sort();
const engineSummary = engines.map(e => {
  const m = summarize(t => t.engine === e, e);
  const eTrades = trades.filter(t => t.engine === e);
  const high = eTrades.filter(t => t.conf === 'HIGH').length;
  const med  = eTrades.filter(t => t.conf === 'MEDIUM').length;
  // % blocked: fraction of cells at any level (involving this engine) that fall under block actions
  const eCells = allCells.filter(c => c.engine === e && c.sufficient_sample);
  const blocked = eCells.filter(c => c.action === 'block').length;
  return { engine: e, ...m, pct_high: high / (high + med + (eTrades.length - high - med) || 1), high, medium: med, total_cells: eCells.length, blocked_cells: blocked };
});

const timeBuckets = ['04:00-09:30','09:30-10:00','10:00-11:00','11:00-12:00','12:00-13:00','13:00-14:00','14:00-15:00','15:00-15:30','15:30-16:00','16:00-18:00','18:00-22:00','22:00-04:00'];
const timeHeatmap = timeBuckets.map(tb => {
  const m = summarize(t => t.timeBucket === tb, tb);
  if (!m.sample_size) return { time: tb, ...m, classification: 'empty' };
  const pf = m.profit_factor;
  let cls;
  if (pf == null || m.profit_factor_infinite) cls = 'incomplete';
  else if (pf > 1.5) cls = 'alpha';
  else if (pf > 1.0) cls = 'neutral';
  else if (m.sample_size > 100) cls = 'toxic_unavoidable';
  else cls = 'toxic_avoidable';
  return { time: tb, ...m, classification: cls };
});

const instruments = [...new Set(trades.map(t => t.instrument))].sort();
const instrumentSummary = instruments.map(i => ({ instrument: i, ...summarize(t => t.instrument === i, i) }));

const biases = ['bullish', 'bearish', 'coiled', 'neutral', 'unknown'];
const biasSummary = biases.map(b => ({ bias: b, ...summarize(t => t.bias === b, b) }));

const directionSummary = ['CALLS', 'PUTS', 'UNKNOWN'].map(d => ({ direction: d, ...summarize(t => t.direction === d, d) }));
const dirByInstrument = instruments.flatMap(i => ['CALLS','PUTS'].map(d => ({
  instrument: i, direction: d, ...summarize(t => t.instrument === i && t.direction === d, `${i}/${d}`),
})));

// ───────────────────────── Top tables ─────────────────────────
// Draw from ALL sufficient cells, not just L1 — sparse data after exclusions
// means L1 may have zero cells with N ≥ 20.
const top20High = [...allSufficient].sort((a, b) => b.win_rate - a.win_rate || b.sample_size - a.sample_size).slice(0, 20);
const top20Low  = [...allSufficient].sort((a, b) => a.win_rate - b.win_rate || b.sample_size - a.sample_size).slice(0, 20);

// ───────────────────────── Write JSON ─────────────────────────
const jsonOut = {
  version: `${TODAY_DATE}-v1`,
  generated: new Date().toISOString(),
  sample_size_threshold: SAMPLE_THRESHOLD,
  warn_threshold: WARN_THRESHOLD,
  total_trades_input: totalIn,
  total_trades_after_exclusions: totalOut,
  exclusions_applied: auditExclusions,
  date_span: [...new Set(trades.map(t => t.fillDate))].sort(),
  cells: allSufficient,                                // all sufficient (any level), L1 first
  l1_lookup_count: lookupCellsL1.length,
  fallback_aggregates_count: fallbackCells.length,
  insufficient_cells_count: insufficient.length,
};
writeFileSync(JSON_OUT, JSON.stringify(jsonOut, null, 2));

// ───────────────────────── Write Markdown ─────────────────────────
function mdEscape(s) { return String(s ?? '').replace(/\|/g, '\\|'); }
function fmtPct(n) { return n == null ? '—' : `${(n * 100).toFixed(1)}%`; }
function fmtMoney(n) { if (n == null || !Number.isFinite(n)) return '—'; const s = n >= 0 ? '+' : '-'; return `${s}$${Math.abs(n).toFixed(2)}`; }
function fmtPF(c) { if (c.profit_factor_infinite) return '∞'; return c.profit_factor != null ? c.profit_factor.toFixed(2) : '—'; }

function topTable(cells) {
  const lines = [];
  lines.push('| eng | conf | bias | inst | time | dir | N | WR | PF | exp | level | sess | action |');
  lines.push('|---|---|---|---|---|---|--:|--:|--:|--:|--:|---|---|');
  for (const c of cells) {
    lines.push(`| ${mdEscape(c.engine)} | ${mdEscape(c.conf || '—')} | ${mdEscape(c.bias || '—')} | ${mdEscape(c.instrument || '—')} | ${mdEscape(c.time_bucket || '—')} | ${mdEscape(c.direction || '—')} | ${c.sample_size} | ${fmtPct(c.win_rate)} | ${fmtPF(c)} | ${fmtMoney(c.expectancy)} | ${c.level} | ${mdEscape(c.session_type || '—')} | ${c.action}${c.blocked_reason ? ` (${c.blocked_reason})` : ''} ${c.size_multiplier}× |`);
  }
  return lines.join('\n');
}

const md = `# Confidence Calibration — ${TODAY_DATE}

**Built by:** \`analyze-calibration.js\` (Phase 1 deliverable)
**Source:** \`paper-ledger.json\` + \`futures-ledger.json\`
**Generated:** ${new Date().toISOString()}

---

## Section 1 — Methodology

Reads every closed trade from the canonical ledgers, applies the exclusion
filters below, derives missing dimensions (time bucket, session type, bias
proxy from \`macro4H\`), and aggregates across 5 fallback levels.

### Aggregation levels (revised per operator spec)
| Level | Granularity |
|---|---|
| L1 | engine × conf × bias × instrument × timeBucket × direction |
| L2 | engine × conf × bias × instrument × sessionType × direction |
| L3 | engine × conf × bias × instrument × direction |
| L4 | engine × conf × instrument |
| L5 | engine baseline |

Lookup priority for live use: most-specific cell with sample_size ≥ ${SAMPLE_THRESHOLD}.
Fall back through levels until met.

### Bias proxy
\`macro4H\` field maps to bias as:
- UP → bullish
- DOWN → bearish
- RANGING → coiled
- UNKNOWN → neutral
- (missing) → unknown

A true \`dailyBias\` field is not recorded per trade; this is the closest available proxy.

### Block triggers (any one fires)
1. \`profit_factor < 1.0\`
2. \`expectancy ≤ 0\` with sample_size ≥ 30
3. \`win_rate < 0.40\`
4. \`net_pnl < 0\` with sample_size ≥ 30

### Sizing tiers (when not blocked)
| WR | Action | Multiplier |
|---|---|--:|
| ≥ 70% | max_allocation | 1.5× |
| 60–70% | increased | 1.25× |
| 50–60% | normal | 1.0× |
| 45–50% | reduced | 0.5× |
| 40–45% | minimum | 0.25× |

\`sharpe_like = mean_pnl / std_pnl\` recorded as a tie-breaker between cells with similar WR/PF — flags spiky setups.

---

## Section 2 — Sample size summary + exclusion audit

| Metric | Value |
|---|--:|
| Input trades (both ledgers) | ${totalIn} |
| After exclusions | ${totalOut} |
| L1 cells with N ≥ ${SAMPLE_THRESHOLD} | ${lookupCellsL1.length} |
| L1 cells with N < ${SAMPLE_THRESHOLD} (fall back) | ${insufficient.filter(c => c.level === 1).length} |
| Fallback aggregates (L2-L5, N ≥ ${SAMPLE_THRESHOLD}) | ${fallbackCells.length} |
| **Total sufficient cells (all levels)** | **${allSufficient.length}** |
| Date span | ${jsonOut.date_span.join(' → ') || '—'} |

### Exclusions applied
| Reason | Count |
|---|--:|
${Object.entries(auditExclusions).filter(([, v]) => v).map(([k, v]) => `| ${k} | ${v} |`).join('\n')}

**Critical exclusion — 2026-05-15 entire session:** the phantom \`$49,757\` corruption +
operator's 13:45 ET taskkill + Claude relaunch at 14:04 ET adding 32 more trades make this
a textbook dirty-session day. Per memory \`feedback_dirty_session_no_calibration.md\`,
analyzer output from infra-failure sessions is invalid for tuning. Skipped wholesale.

**BUY/SELL flip-flop pattern — read before interpreting:** of the ${auditExclusions.duration_too_short} trades
filtered by the <60s rule, the vast majority are \`BUY\` and \`SELL\` engines exiting with
\`SIGNAL_REVERSAL\` in <10 seconds. This is the high-frequency BUY↔SELL flip-flop where each
engine reverses the other on every tick. Per the operator's spec these are excluded as
test/error data, but **the practical effect is that BUY and SELL engines are largely absent
from this analysis.** L1 cells are sparse for that reason — the surviving sample is the
slower option-style engines (HL/HTF/ZONE/LH/SWING) + futures-direct. If operator wants the
BUY/SELL surface analyzed, drop the duration filter and re-run.

${auditAnomalies.length ? `\n### Logged anomalies\n` + auditAnomalies.map(a => `- ${a.kind}: ${a.requestId} (${a.holdMins?.toFixed(1)} min)`).join('\n') : ''}

---

## Section 3 — Top 20 highest win-rate setups (any level, N ≥ ${SAMPLE_THRESHOLD})

L1 cells are scarce post-exclusion, so this table mixes levels. Read the \`level\`
column to know how granular each row is (1 = full specificity, 5 = engine baseline).

${topTable(top20High)}

---

## Section 4 — Top 20 lowest win-rate setups (any level, N ≥ ${SAMPLE_THRESHOLD}) — BLOCK candidates

${topTable(top20Low)}

---

## Section 5 — Engine-level summary

| Engine | N | WR | PF | netPnL | exp/trade | %HIGH | %MEDIUM | cells | blocked |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
${engineSummary.map(e => `| ${e.engine} | ${e.sample_size || 0} | ${fmtPct(e.win_rate)} | ${e.profit_factor_infinite ? '∞' : e.profit_factor?.toFixed(2) ?? '—'} | ${fmtMoney(e.net_pnl)} | ${fmtMoney(e.expectancy)} | ${(e.high / (e.high + e.medium || 1) * 100).toFixed(0)}% | ${(e.medium / (e.high + e.medium || 1) * 100).toFixed(0)}% | ${e.total_cells} | ${e.blocked_cells} |`).join('\n')}

---

## Section 6 — Time-of-day heatmap

| Window | N | WR | PF | exp/trade | netPnL | Class |
|---|--:|--:|--:|--:|--:|---|
${timeHeatmap.map(t => `| ${t.time} | ${t.sample_size || 0} | ${fmtPct(t.win_rate)} | ${t.profit_factor_infinite ? '∞' : t.profit_factor?.toFixed(2) ?? '—'} | ${fmtMoney(t.expectancy)} | ${fmtMoney(t.net_pnl)} | ${t.classification} |`).join('\n')}

**Classification rules:**
- **alpha** — PF > 1.5
- **neutral** — 1.0 < PF ≤ 1.5
- **toxic_unavoidable** — PF ≤ 1.0 but N > 100 (e.g., open session can't be skipped)
- **toxic_avoidable** — PF ≤ 1.0 and lower N (candidate to gate via env)

---

## Section 7 — Instrument breakdowns

| Instrument | N | WR | PF | netPnL | exp/trade | avgWin | avgLoss |
|---|--:|--:|--:|--:|--:|--:|--:|
${instrumentSummary.map(i => `| ${i.instrument} | ${i.sample_size || 0} | ${fmtPct(i.win_rate)} | ${i.profit_factor_infinite ? '∞' : i.profit_factor?.toFixed(2) ?? '—'} | ${fmtMoney(i.net_pnl)} | ${fmtMoney(i.expectancy)} | ${fmtMoney(i.avg_win)} | ${fmtMoney(i.avg_loss)} |`).join('\n')}

---

## Section 8 — Bias-state effectiveness

| Bias | N | WR | PF | netPnL | exp/trade |
|---|--:|--:|--:|--:|--:|
${biasSummary.map(b => `| ${b.bias} | ${b.sample_size || 0} | ${fmtPct(b.win_rate)} | ${b.profit_factor_infinite ? '∞' : b.profit_factor?.toFixed(2) ?? '—'} | ${fmtMoney(b.net_pnl)} | ${fmtMoney(b.expectancy)} |`).join('\n')}

---

## Section 9 — Direction asymmetry

### Aggregate
| Direction | N | WR | PF | netPnL | exp/trade |
|---|--:|--:|--:|--:|--:|
${directionSummary.map(d => `| ${d.direction} | ${d.sample_size || 0} | ${fmtPct(d.win_rate)} | ${d.profit_factor_infinite ? '∞' : d.profit_factor?.toFixed(2) ?? '—'} | ${fmtMoney(d.net_pnl)} | ${fmtMoney(d.expectancy)} |`).join('\n')}

### Per instrument
| Inst/Dir | N | WR | PF | netPnL | exp/trade |
|---|--:|--:|--:|--:|--:|
${dirByInstrument.filter(d => d.sample_size).map(d => `| ${d.instrument}/${d.direction} | ${d.sample_size} | ${fmtPct(d.win_rate)} | ${d.profit_factor_infinite ? '∞' : d.profit_factor?.toFixed(2) ?? '—'} | ${fmtMoney(d.net_pnl)} | ${fmtMoney(d.expectancy)} |`).join('\n')}

---

## Phase 3 wiring notes

When \`paperTrading.sendOrder\` adopts this calibration table, log on every entry:
- \`calibration_key_used\`
- \`calibration_level\` (1-5)
- \`calibration_multiplier\` (0, 0.25, 0.5, 1, 1.25, 1.5)
- \`calibration_action\` (max_allocation / increased / normal / reduced / minimum / block)

Then post-session diagnostics can answer: are we over-using L4/L5 fallbacks? Which
engines are blocking most? What's the average multiplier per day? The Sunday futures
session is the first live validation window for the calibrated sizing path.

---

*Re-run anytime with* \`node analyze-calibration.js\` *— output filenames re-use today's date.*
`;

if (!existsSync(dirname(DOC_OUT))) mkdirSync(dirname(DOC_OUT), { recursive: true });
writeFileSync(DOC_OUT, md);

// ───────────────────────── Console summary ─────────────────────────
console.log(`\n   wrote: ${DOC_OUT}`);
console.log(`   wrote: ${JSON_OUT}`);
console.log(`\n📌 Sufficient cells (N ≥ ${SAMPLE_THRESHOLD}): ${allSufficient.length}  [L1: ${lookupCellsL1.length}, L2-5: ${fallbackCells.length}]`);

function describeCell(c) {
  const parts = [];
  parts.push(c.engine);
  if (c.conf)        parts.push(c.conf);
  if (c.bias)        parts.push(c.bias);
  if (c.instrument)  parts.push(c.instrument);
  if (c.time_bucket) parts.push(c.time_bucket);
  if (c.session_type)parts.push(c.session_type);
  if (c.direction)   parts.push(c.direction);
  return parts.join('/') + ` [L${c.level}]`;
}

console.log(`\n🏆 TOP 5 HIGHEST WR:`);
for (const c of top20High.slice(0, 5)) {
  console.log(`   ${describeCell(c)}  N=${c.sample_size} WR=${(c.win_rate*100).toFixed(1)}% PF=${c.profit_factor_infinite ? '∞' : c.profit_factor?.toFixed(2)} exp=${c.expectancy >= 0 ? '+' : ''}$${c.expectancy.toFixed(2)} → ${c.action} ${c.size_multiplier}×`);
}

console.log(`\n⚠️  TOP 5 LOWEST WR / BLOCK CANDIDATES:`);
for (const c of top20Low.slice(0, 5)) {
  console.log(`   ${describeCell(c)}  N=${c.sample_size} WR=${(c.win_rate*100).toFixed(1)}% PF=${c.profit_factor_infinite ? '∞' : c.profit_factor?.toFixed(2)} → ${c.action}${c.blocked_reason ? ` (${c.blocked_reason})` : ''}`);
}

// Most surprising finding heuristic — biggest gap between WR and PF
const surprising = [...allSufficient].filter(c => c.sample_size >= 30).sort((a, b) => {
  // High WR but low PF, or low WR but high PF
  const surpriseA = Math.abs((a.win_rate - 0.5) * 2 - Math.tanh((a.profit_factor || 1) - 1));
  const surpriseB = Math.abs((b.win_rate - 0.5) * 2 - Math.tanh((b.profit_factor || 1) - 1));
  return surpriseB - surpriseA;
})[0];
if (surprising) {
  console.log(`\n🔍 MOST SURPRISING FINDING:`);
  console.log(`   ${describeCell(surprising)}`);
  console.log(`   N=${surprising.sample_size}, WR=${(surprising.win_rate*100).toFixed(1)}%, PF=${surprising.profit_factor_infinite ? '∞' : surprising.profit_factor?.toFixed(2)}, exp=${fmtMoney(surprising.expectancy)}`);
  console.log(`   → ${surprising.action} ${surprising.size_multiplier}×`);
}

console.log(`\n💡 IMPLEMENTATION RECOMMENDATION FOR PHASE 3:`);
console.log(`   - Wire data/calibration-lookup.json into paperTrading.sendOrder`);
console.log(`   - Add a CONFIDENCE_CALIBRATION_BLOCK gate (parallel to PROFIT_PROTECTION)`);
console.log(`   - Multiply existing contract count by calibration multiplier`);
console.log(`   - Log calibration_key_used / level / multiplier / action on every entry`);
console.log(`   - Validate Sunday 17:00 ET on futures, full Monday session for equity options`);
console.log(``);
