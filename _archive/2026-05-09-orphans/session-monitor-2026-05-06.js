// session-monitor-2026-05-06.js — HANK live session monitor (ESM)
// Waits until 09:30 ET, polls files every 60s until 16:00 ET, generates report.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FILES = {
  ledger:  join(__dirname, 'paper-ledger.json'),
  spy:     join(__dirname, 'spy-levels.json'),
  qqq:     join(__dirname, 'qqq-levels.json'),
  iwm:     join(__dirname, 'iwm-levels.json'),
  moo:     join(__dirname, 'moo-signal.json'),
  moc:     join(__dirname, 'moc-signal.json'),
  mag6:    join(__dirname, 'mag6-state.json'),
  log:     join(__dirname, 'session-log-2026-05-06.jsonl'),
  status:  join(__dirname, 'session-status-2026-05-06.txt'),
  report:  join(__dirname, 'session-report-2026-05-06.md'),
};

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  seenKeys:      new Set(),
  trades:        [],
  mooEvent:      null,
  mocEvent:      null,
  pollCount:     0,
  levelReadings: [],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function readJSON(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; }
  catch { return null; }
}

function getET() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(now);
  const v = t => parseInt(parts.find(p => p.type === t).value);
  return { h: v('hour'), m: v('minute'), s: v('second'), ts: now.getTime() };
}

function etStr() {
  const { h, m, s } = getET();
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function etMinutes() { const { h, m } = getET(); return h * 60 + m; }

const fmtPnl = n => (n >= 0 ? '+' : '') + Number(n).toFixed(2);
const pct    = (w, t) => t > 0 ? ((w / t) * 100).toFixed(1) + '%' : '--';

function tradeKey(t) {
  return `${t.instrument}-${t.engine}-${t.entryTime ?? t.id ?? String(t.entryPrice) + String(t.direction ?? t.signal)}`;
}

function tradeDir(t) { return t.direction ?? t.signal ?? '?'; }

// ─── Wait for market open ─────────────────────────────────────────────────────
async function waitForOpen() {
  let announced = false;
  while (true) {
    const etM = etMinutes();
    if (etM >= 9 * 60 + 30) break;
    const { s } = getET();
    const msLeft = ((9 * 60 + 30) - etM) * 60 * 1000 - s * 1000;
    if (!announced) {
      console.log(`[MONITOR] ${etStr()} ET — pre-market, waiting for 09:30 ET (${Math.ceil(msLeft / 60000)} min)`);
      announced = true;
    }
    await sleep(Math.min(msLeft, 30_000));
  }
  console.log(`[MONITOR] ${etStr()} ET — MARKET OPEN. Starting polling loop.`);
}

// ─── Single poll ──────────────────────────────────────────────────────────────
function poll() {
  state.pollCount++;
  const now = etStr();

  // 1. Paper ledger
  const ledger    = readJSON(FILES.ledger);
  const allTrades = ledger?.trades ?? [];

  for (const t of allTrades) {
    const key = tradeKey(t);

    if (!state.seenKeys.has(key)) {
      state.seenKeys.add(key);

      // Snapshot market context at detection time
      const spy  = readJSON(FILES.spy);
      const qqq  = readJSON(FILES.qqq);
      const iwm  = readJSON(FILES.iwm);
      const mag6 = readJSON(FILES.mag6);
      const lvl  = t.instrument === 'SPY' ? spy : t.instrument === 'QQQ' ? qqq : iwm;

      const rec = {
        detectedAt:  now,
        instrument:  t.instrument,
        direction:   tradeDir(t),
        engine:      t.engine      ?? null,
        confidence:  t.confidence  ?? null,
        session:     t.session     ?? null,
        status:      t.status,
        entryPrice:  t.entryPrice  ?? null,
        entryTime:   t.entryTime   ?? null,
        exitPrice:   t.exitPrice   ?? null,
        exitTime:    t.exitTime    ?? null,
        pnl:         t.pnl         ?? null,
        contracts:   t.contracts   ?? 1,
        atrEst:      t.atrEst      ?? null,
        marketContext: {
          vwapBias:     lvl?.bias    ?? null,
          vwap:         lvl?.vwap    ?? null,
          currentPrice: lvl?.current ?? null,
          pdHigh:       lvl?.pdHigh  ?? null,
          pdLow:        lvl?.pdLow   ?? null,
          pdClose:      lvl?.pdClose ?? null,
          mag6Vote:     mag6?.vote ?? mag6?.bias ?? mag6?.direction ?? null,
        },
      };
      state.trades.push(rec);

      const ep   = rec.entryPrice != null ? `$${rec.entryPrice.toFixed(2)}` : '?';
      const bias = rec.marketContext.vwapBias ?? '?';
      console.log(`  [TRADE] ${now} ${rec.instrument} ${rec.direction} (${rec.engine}) entry ${ep} bias:${bias} conf:${rec.confidence ?? '?'}`);
      appendFileSync(FILES.log, JSON.stringify({ type: 'TRADE', ...rec }) + '\n');

    } else if (t.status === 'CLOSED') {
      const existing = state.trades.find(r =>
        r.instrument === t.instrument &&
        r.engine     === t.engine     &&
        r.entryTime  === t.entryTime
      );
      if (existing && existing.status !== 'CLOSED') {
        existing.status    = 'CLOSED';
        existing.exitPrice = t.exitPrice;
        existing.exitTime  = t.exitTime;
        existing.pnl       = t.pnl;
        console.log(`  [CLOSE] ${now} ${t.instrument} ${tradeDir(t)} CLOSED ${fmtPnl(t.pnl ?? 0)}`);
        appendFileSync(FILES.log, JSON.stringify({
          type: 'CLOSE', time: now,
          instrument: t.instrument, direction: tradeDir(t),
          engine: t.engine, pnl: t.pnl, exitPrice: t.exitPrice
        }) + '\n');
      }
    }
  }

  // 2. Levels
  const spy = readJSON(FILES.spy);
  const qqq = readJSON(FILES.qqq);
  const iwm = readJSON(FILES.iwm);
  state.levelReadings.push({ time: now, spy, qqq, iwm });

  // 3. MOO signal
  if (!state.mooEvent) {
    const moo = readJSON(FILES.moo);
    if (moo) {
      state.mooEvent = { detectedAt: now, data: moo };
      console.log(`  [MOO]   ${now} signal detected: ${JSON.stringify(moo)}`);
      appendFileSync(FILES.log, JSON.stringify({ type: 'MOO', time: now, data: moo }) + '\n');
    }
  }

  // 4. MOC signal
  if (!state.mocEvent) {
    const moc = readJSON(FILES.moc);
    if (moc) {
      state.mocEvent = { detectedAt: now, data: moc };
      console.log(`  [MOC]   ${now} signal detected: ${JSON.stringify(moc)}`);
      appendFileSync(FILES.log, JSON.stringify({ type: 'MOC', time: now, data: moc }) + '\n');
    }
  }

  // 5. Status file
  const closed   = state.trades.filter(t => t.status === 'CLOSED');
  const open     = state.trades.filter(t => t.status !== 'CLOSED');
  const wins     = closed.filter(t => (t.pnl ?? 0) > 0).length;
  const losses   = closed.filter(t => (t.pnl ?? 0) <= 0).length;
  const totalPnL = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);

  const statusLines = [
    `HANK Session Monitor — updated ${new Date().toISOString()}`,
    `ET: ${now} | Poll #${state.pollCount}`,
    `Trades: ${state.trades.length} total | Open: ${open.length} | Closed: ${closed.length}`,
    `W/L: ${wins}/${losses} | W/R: ${pct(wins, wins + losses)} | P&L: ${fmtPnl(totalPnL)}`,
    `Balance: $${(ledger?.balance ?? 25000).toFixed(2)}`,
    `MOO: ${state.mooEvent ? JSON.stringify(state.mooEvent.data) : 'not fired yet'}`,
    `MOC: ${state.mocEvent ? JSON.stringify(state.mocEvent.data) : 'not fired yet'}`,
    '',
    '── Recent Trades ──',
    ...state.trades.slice(-10).map(t =>
      `${t.detectedAt}  ${String(t.instrument).padEnd(3)}  ${String(t.direction).padEnd(5)}  ${String(t.engine).padEnd(6)}  ` +
      `$${(t.entryPrice ?? 0).toFixed(2).padStart(6)}  ${String(t.status).padEnd(6)}  ${t.pnl != null ? fmtPnl(t.pnl) : 'open'}`
    ),
    '',
    '── Levels ──',
    spy ? `SPY  PDH=${spy.pdHigh}  PDL=${spy.pdLow}  PDC=${spy.pdClose}  VWAP=${spy.vwap}  Bias=${spy.bias}  Now=${spy.current}` : 'SPY: file not found',
    qqq ? `QQQ  PDH=${qqq.pdHigh}  PDL=${qqq.pdLow}  PDC=${qqq.pdClose}  VWAP=${qqq.vwap}  Bias=${qqq.bias}  Now=${qqq.current}` : 'QQQ: file not found',
    iwm ? `IWM  PDH=${iwm.pdHigh}  PDL=${iwm.pdLow}  PDC=${iwm.pdClose}  VWAP=${iwm.vwap}  Bias=${iwm.bias}  Now=${iwm.current}` : 'IWM: file not found',
  ];
  writeFileSync(FILES.status, statusLines.join('\n'));

  appendFileSync(FILES.log, JSON.stringify({
    type: 'POLL', time: now, pollCount: state.pollCount,
    tradesTotal: state.trades.length, open: open.length, closed: closed.length,
    wins, losses, totalPnL, ledgerBalance: ledger?.balance,
    spy: spy ? { pdHigh: spy.pdHigh, pdLow: spy.pdLow, vwap: spy.vwap, bias: spy.bias, current: spy.current } : null,
    qqq: qqq ? { pdHigh: qqq.pdHigh, pdLow: qqq.pdLow, vwap: qqq.vwap, bias: qqq.bias, current: qqq.current } : null,
    iwm: iwm ? { pdHigh: iwm.pdHigh, pdLow: iwm.pdLow, vwap: iwm.vwap, bias: iwm.bias, current: iwm.current } : null,
  }) + '\n');

  console.log(`[MONITOR] ${now} #${state.pollCount} — ${state.trades.length} trades | open:${open.length} closed:${closed.length} pnl:${fmtPnl(totalPnL)}`);
}

// ─── Report generation ────────────────────────────────────────────────────────
function generateReport() {
  console.log('[MONITOR] Generating session report...');

  const closed   = state.trades.filter(t => t.status === 'CLOSED');
  const open     = state.trades.filter(t => t.status !== 'CLOSED');
  const wins     = closed.filter(t => (t.pnl ?? 0) > 0);
  const losses   = closed.filter(t => (t.pnl ?? 0) <= 0);
  const totalPnL = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);

  const engines = [...new Set(state.trades.map(t => t.engine).filter(Boolean))];
  const byEngine = Object.fromEntries(engines.map(e => {
    const et = closed.filter(t => t.engine === e);
    const ew = et.filter(t => (t.pnl ?? 0) > 0);
    return [e, { total: et.length, wins: ew.length, pnl: et.reduce((s,t) => s+(t.pnl??0), 0) }];
  }));

  const sessions = [...new Set(state.trades.map(t => t.session).filter(Boolean))];
  const bySession = Object.fromEntries(sessions.map(s => {
    const st = closed.filter(t => t.session === s);
    const sw = st.filter(t => (t.pnl ?? 0) > 0);
    return [s, { total: st.length, wins: sw.length, pnl: st.reduce((s2,t) => s2+(t.pnl??0), 0) }];
  }));

  const byInst = Object.fromEntries(['SPY','QQQ','IWM'].map(inst => {
    const it = closed.filter(t => t.instrument === inst);
    const iw = it.filter(t => (t.pnl ?? 0) > 0);
    return [inst, { total: it.length, wins: iw.length, pnl: it.reduce((s,t) => s+(t.pnl??0), 0) }];
  }));

  // 30-min timing buckets
  const timingBuckets = {};
  for (const t of closed) {
    if (!t.detectedAt) continue;
    const [h, m] = t.detectedAt.split(':').map(Number);
    const b = `${String(h).padStart(2,'0')}:${m < 30 ? '00' : '30'}`;
    if (!timingBuckets[b]) timingBuckets[b] = { trades: 0, wins: 0, pnl: 0 };
    timingBuckets[b].trades++;
    if ((t.pnl ?? 0) > 0) timingBuckets[b].wins++;
    timingBuckets[b].pnl += t.pnl ?? 0;
  }

  // Confidence
  const confLevels = ['HIGH', 'MEDIUM', 'LOW'];
  const byConf = Object.fromEntries(confLevels.map(c => {
    const ct = closed.filter(t => t.confidence === c);
    const cw = ct.filter(t => (t.pnl ?? 0) > 0);
    return [c, { total: ct.length, wins: cw.length, pnl: ct.reduce((s,t) => s+(t.pnl??0), 0) }];
  }));

  // Conflict detection
  const byMinute = {};
  for (const t of state.trades) {
    const min = (t.detectedAt ?? '').substring(0, 5);
    if (!byMinute[min]) byMinute[min] = [];
    byMinute[min].push(t);
  }
  const conflicts = Object.entries(byMinute)
    .filter(([, ts]) => new Set(ts.map(t => tradeDir(t)).filter(Boolean)).size > 1)
    .map(([t]) => t);

  const falseSignals = state.trades.filter(t => {
    const dir  = tradeDir(t);
    const bias = t.marketContext?.vwapBias;
    return (dir === 'CALLS' && bias === 'bearish') || (dir === 'PUTS' && bias === 'bullish');
  });

  // Recommendations
  const recs = [];

  const rankedEngines = engines
    .filter(e => byEngine[e].total >= 3)
    .sort((a, b) => (byEngine[b].wins / Math.max(byEngine[b].total,1)) - (byEngine[a].wins / Math.max(byEngine[a].total,1)));

  if (rankedEngines.length > 0) {
    const best = rankedEngines[0];
    recs.push(`- **Best engine: ${best}** (${pct(byEngine[best].wins, byEngine[best].total)} W/R, ${byEngine[best].total} trades). Consider 2 contracts for HIGH-confidence ${best} signals.`);
    const worst = rankedEngines[rankedEngines.length - 1];
    if (worst !== best)
      recs.push(`- **Underperforming: ${worst}** (${pct(byEngine[worst].wins, byEngine[worst].total)} W/R). Raise confidence threshold or reduce size.`);
  }

  const sortedBuckets = Object.entries(timingBuckets)
    .sort((a,b) => (b[1].wins/Math.max(b[1].trades,1)) - (a[1].wins/Math.max(a[1].trades,1)));
  if (sortedBuckets.length > 0) {
    const [bTime, bd] = sortedBuckets[0];
    recs.push(`- **Best time window: ${bTime}** (${pct(bd.wins, bd.trades)}, ${bd.trades} trades). Prioritize entries here.`);
    if (sortedBuckets.length > 1) {
      const [wTime, wd] = sortedBuckets[sortedBuckets.length - 1];
      if (wd.trades >= 2)
        recs.push(`- **Weakest time window: ${wTime}** (${pct(wd.wins, wd.trades)}). Consider a "cold zone" filter.`);
    }
  }

  if (conflicts.length > 0)
    recs.push(`- **Direction conflicts at ${conflicts.join(', ')}**: add inter-instrument consensus gate (require 2/3 to agree).`);

  if (falseSignals.length > 0)
    recs.push(`- **${falseSignals.length} counter-bias entries**: CALLS in bearish VWAP or PUTS in bullish VWAP. Add VWAP-bias gate in executeScalpSignal.`);

  if (byConf.HIGH?.total >= 2 && byConf.MEDIUM?.total >= 2) {
    const hrH = byConf.HIGH.wins / byConf.HIGH.total;
    const hrM = byConf.MEDIUM.wins / byConf.MEDIUM.total;
    if (hrH - hrM > 0.2)
      recs.push(`- **HIGH vs MEDIUM gap**: ${pct(byConf.HIGH.wins,byConf.HIGH.total)} vs ${pct(byConf.MEDIUM.wins,byConf.MEDIUM.total)}. Consider trading only HIGH signals or 0.5 contracts on MEDIUM.`);
  }

  if (recs.length === 0)
    recs.push('- Insufficient closed trades for pattern analysis. Run across 3–5 sessions for statistical significance (n ≥ 20 per engine).');

  // Sizing rows
  const sizingRows = confLevels.map(c => {
    const d = byConf[c];
    if (!d || d.total === 0) return `| ${c} | 0 | -- | 1 contract (default) |`;
    const wr = d.wins / d.total;
    const sug = wr >= 0.65 ? '2 contracts' : wr >= 0.50 ? '1 contract' : '0.5 contract (reduce)';
    return `| ${c} | ${d.total} | ${pct(d.wins, d.total)} | ${sug} |`;
  });

  // Level accuracy
  const levelLines = ['SPY','QQQ','IWM'].map(inst => {
    const last = [...state.levelReadings].reverse().find(r => r[inst.toLowerCase()]);
    const lv   = last?.[inst.toLowerCase()];
    if (!lv) return `- **${inst}**: no level data`;
    const itClosed = closed.filter(t => t.instrument === inst);
    const biasAligned = itClosed.filter(t =>
      (lv.bias === 'bullish' && tradeDir(t) === 'CALLS' && (t.pnl ?? 0) > 0) ||
      (lv.bias === 'bearish' && tradeDir(t) === 'PUTS'  && (t.pnl ?? 0) > 0)
    ).length;
    return `- **${inst}**: PDH=${lv.pdHigh}  PDL=${lv.pdLow}  PDC=${lv.pdClose}  Open=${lv.todayOpen ?? 'n/a'}  VWAP=${lv.vwap}  Bias=${lv.bias}  EOD=${lv.current}` +
      (itClosed.length > 0 ? `  | Bias-aligned wins: ${biasAligned}/${itClosed.length}` : '');
  });

  const report = [
    `# HANK Session Report — 2026-05-06`,
    ``,
    `**Session:** 09:30–16:00 ET | **Polls:** ${state.pollCount} | **Interval:** 60s`,
    ``,
    `## Summary`,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total Paper Trades | ${state.trades.length} |`,
    `| Closed | ${closed.length} |`,
    `| Still Open at 16:00 | ${open.length} |`,
    `| Wins | ${wins.length} |`,
    `| Losses | ${losses.length} |`,
    `| Win Rate | ${pct(wins.length, closed.length)} |`,
    `| Closed P&L | ${fmtPnl(totalPnL)} |`,
    `| MOO Fired | ${state.mooEvent ? `Yes @ ${state.mooEvent.detectedAt}` : 'No'} |`,
    `| MOC Fired | ${state.mocEvent ? `Yes @ ${state.mocEvent.detectedAt}` : 'No'} |`,
    ``,
    `## 1. Win Rate by Engine`,
    `| Engine | Closed | Wins | W/R | P&L |`,
    `|--------|--------|------|-----|-----|`,
    ...(engines.length > 0
      ? engines.map(e => `| ${e} | ${byEngine[e].total} | ${byEngine[e].wins} | ${pct(byEngine[e].wins, byEngine[e].total)} | ${fmtPnl(byEngine[e].pnl)} |`)
      : ['| (no closed trades) | — | — | — | — |']),
    ``,
    `## 2. Win Rate by Session`,
    `| Session | Closed | Wins | W/R | P&L |`,
    `|---------|--------|------|-----|-----|`,
    ...(sessions.length > 0
      ? sessions.map(s => `| ${s} | ${bySession[s].total} | ${bySession[s].wins} | ${pct(bySession[s].wins, bySession[s].total)} | ${fmtPnl(bySession[s].pnl)} |`)
      : ['| (session field not populated — add t.session in paperTrading.js) | — | — | — | — |']),
    ``,
    `## 3. Win Rate by Instrument`,
    `| Instrument | Closed | Wins | W/R | P&L |`,
    `|------------|--------|------|-----|-----|`,
    ...['SPY','QQQ','IWM'].map(inst => `| ${inst} | ${byInst[inst].total} | ${byInst[inst].wins} | ${pct(byInst[inst].wins, byInst[inst].total)} | ${fmtPnl(byInst[inst].pnl)} |`),
    ``,
    `## 4. Best Entry Timing Patterns`,
    `| Time Window | Trades | Wins | W/R | P&L |`,
    `|-------------|--------|------|-----|-----|`,
    ...(Object.keys(timingBuckets).length > 0
      ? Object.entries(timingBuckets).sort().map(([b, d]) => {
          const end = b.endsWith(':00') ? '30' : '59';
          return `| ${b}–${b.split(':')[0]}:${end} | ${d.trades} | ${d.wins} | ${pct(d.wins, d.trades)} | ${fmtPnl(d.pnl)} |`;
        })
      : ['| (no closed trades) | — | — | — | — |']),
    ``,
    `## 5. Signal Conflicts & False Signals`,
    conflicts.length > 0
      ? `**Direction conflicts** (simultaneous opposite signals): ${conflicts.join(', ')}`
      : '**No direction conflicts** detected.',
    ``,
    falseSignals.length > 0
      ? [`**Counter-bias entries (${falseSignals.length}):**`,
         ...falseSignals.map(t => `- ${t.detectedAt}  ${t.instrument}  ${tradeDir(t)}  bias=${t.marketContext?.vwapBias ?? '?'}  pnl=${t.pnl != null ? fmtPnl(t.pnl) : 'open'}`)
        ].join('\n')
      : '**No counter-bias entries** detected.',
    ``,
    `### MOO Signal`,
    state.mooEvent
      ? `- Detected: **${state.mooEvent.detectedAt}**\n- Data: \`${JSON.stringify(state.mooEvent.data)}\``
      : '- Did not fire this session.',
    ``,
    `### MOC Signal (15:50 imbalance)`,
    state.mocEvent
      ? `- Detected: **${state.mocEvent.detectedAt}**\n- Data: \`${JSON.stringify(state.mocEvent.data)}\``
      : '- Did not fire this session.',
    ``,
    `## 6. Recommendations`,
    ...recs,
    ``,
    `## 7. Optimal Position Sizing by Confidence`,
    `| Confidence | Closed | W/R | Suggested Size |`,
    `|------------|--------|-----|----------------|`,
    ...sizingRows,
    ``,
    `## All Trades Detail`,
    `| Time | Inst | Dir | Engine | Conf | Entry | Bias | Mag6 | Status | P&L |`,
    `|------|------|-----|--------|------|-------|------|------|--------|-----|`,
    ...(state.trades.length > 0
      ? state.trades.map(t =>
          `| ${t.detectedAt} | ${t.instrument} | ${tradeDir(t)} | ${t.engine ?? '?'} | ${t.confidence ?? '?'} | ` +
          `${t.entryPrice != null ? '$'+t.entryPrice.toFixed(2) : '?'} | ${t.marketContext?.vwapBias ?? '?'} | ` +
          `${t.marketContext?.mag6Vote ?? '?'} | ${t.status} | ${t.pnl != null ? fmtPnl(t.pnl) : 'open'} |`
        )
      : ['| (no trades fired this session) | | | | | | | | | |']),
    ``,
    `## Level Accuracy`,
    ...levelLines,
    ``,
    `---`,
    `*Generated ${new Date().toISOString()} — ${state.pollCount} polls by session-monitor-2026-05-06.js*`,
  ].join('\n');

  writeFileSync(FILES.report, report);
  console.log('[MONITOR] Report written to', FILES.report);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
process.on('SIGINT',  () => { generateReport(); process.exit(0); });
process.on('SIGTERM', () => { generateReport(); process.exit(0); });

async function main() {
  console.log('[MONITOR] HANK session monitor 2026-05-06 — starting');
  writeFileSync(FILES.log, '');
  appendFileSync(FILES.log, JSON.stringify({ type: 'START', time: etStr(), ts: Date.now() }) + '\n');

  await waitForOpen();

  while (true) {
    if (etMinutes() >= 16 * 60) {
      console.log(`[MONITOR] ${etStr()} ET — 16:00 reached. Stopping.`);
      break;
    }
    try { poll(); }
    catch (e) {
      console.error('[MONITOR] Poll error:', e.message);
      appendFileSync(FILES.log, JSON.stringify({ type: 'ERROR', time: etStr(), error: e.message }) + '\n');
    }
    await sleep(60_000);
  }

  generateReport();
  console.log('[MONITOR] Done. Report at session-report-2026-05-06.md');
}

main().catch(e => { console.error('[MONITOR] Fatal:', e); process.exit(1); });
