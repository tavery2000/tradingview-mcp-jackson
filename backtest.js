#!/usr/bin/env node
/**
 * backtest.js — replay engine for P2-14
 *
 * Reads paper-ledger.json + journal records to reconstruct each trade's
 * approximate underlying-price path during its [entry, exit] window.
 * Pine alerts include the instrument's underlying price at alert time —
 * these provide proxy data points (typical resolution: 30-60 sec).
 *
 * For each trade, simulate stops/targets/trails at multiple sizings and
 * report the alternative-outcome P&L. Aggregate per-instrument to find
 * the optimal config.
 *
 * Limitations:
 *   - Pine alerts don't fire continuously; gaps between observations
 *     may miss true stop/target hits. Underestimates stop-trigger rate
 *     (trades that breached and recovered between alerts won't show).
 *   - Option premium reconstruction uses delta=0.5 approximation for
 *     ATM 0DTE. Underestimates premium swings on near-ATM option.
 *   - Whipsaw bar-close confirmation NOT modeled (just instant-tick).
 *   - Scale-out logic NOT modeled (single-target version only).
 *
 * Trust-but-verify: results suggest direction for stop/target tuning;
 * empirical Friday-Monday session data still required for confirmation.
 *
 * Usage:  node backtest.js [output-md-path]
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEDGER  = join(__dirname, 'paper-ledger.json');
const JOURNAL = join(__dirname, 'logs/journal/journal-2026-05-14.jsonl');
const OUTPUT  = process.argv[2] || join(__dirname, 'docs/backtest-results-2026-05-14.md');

const STOP_BASE = {
  'ES1!': 3.0, 'NQ1!': 10.0, 'MES1!': 3.0, 'MNQ1!': 10.0,
  'SPY': 0.30, 'QQQ': 0.35, 'IWM': 0.25,
};
const TARGET_BASE = {
  'ES1!': 6.0, 'NQ1!': 20.0, 'MES1!': 6.0, 'MNQ1!': 20.0,
  'SPY': 0.60, 'QQQ': 0.70, 'IWM': 0.50,
};

function loadJournalAlerts() {
  const lines = readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean);
  // Pine alerts include `price` (instrument underlying); ALERT.event=
  // 'pine-alert.inbound' has all of {instrument, price, ts}
  const alerts = [];
  for (const ln of lines) {
    let o; try { o = JSON.parse(ln); } catch { continue; }
    if (o.type === 'ALERT' && o.message === 'pine-alert.inbound' && o.instrument && Number.isFinite(o.price)) {
      alerts.push({ instrument: o.instrument, price: o.price, ts: o.ts, time: o.time });
    }
  }
  return alerts;
}

function buildInstrumentTimeSeries(alerts) {
  const byInst = {};
  for (const a of alerts) {
    if (!byInst[a.instrument]) byInst[a.instrument] = [];
    byInst[a.instrument].push({ ts: a.ts, price: a.price });
  }
  for (const k of Object.keys(byInst)) byInst[k].sort((a,b) => a.ts - b.ts);
  return byInst;
}

function getPriceWindow(series, fromTs, toTs) {
  if (!series) return [];
  return series.filter(p => p.ts >= fromTs && p.ts <= toTs);
}

function simulateTrade(trade, priceSeries, stopMultiplier, targetMultiplier) {
  const inst = trade.instrument;
  const baseStop = STOP_BASE[inst];
  const baseTgt  = TARGET_BASE[inst];
  if (baseStop == null || baseTgt == null) {
    return { outcome: 'NO_BASE_DISTANCE', simulatedPnl: trade.pnl };
  }
  const stopDist = baseStop * stopMultiplier;
  const tgtDist  = baseTgt  * targetMultiplier;
  const isCalls = trade.signal === 'CALLS';
  const entryU  = trade.entryUnderlyingPrice ?? trade.underlyingPrice ?? null;
  if (entryU == null) return { outcome: 'NO_ENTRY_UNDERLYING', simulatedPnl: trade.pnl };

  const stopU   = isCalls ? entryU - stopDist : entryU + stopDist;
  const tgtU    = isCalls ? entryU + tgtDist  : entryU - tgtDist;

  const window = getPriceWindow(priceSeries, trade.fillTime, trade.exitTime);
  if (window.length < 2) return { outcome: 'INSUFFICIENT_PROXY_DATA', simulatedPnl: trade.pnl };

  // First-touch wins: scan forward in time, see if stop or target hit first.
  let outcome = 'NATURAL_EXIT', simulatedExitU = null;
  for (const p of window) {
    const stopHit = isCalls ? p.price <= stopU : p.price >= stopU;
    const tgtHit  = isCalls ? p.price >= tgtU  : p.price <= tgtU;
    if (stopHit) { outcome = 'STOP_LOSS'; simulatedExitU = stopU; break; }
    if (tgtHit)  { outcome = 'TARGET';    simulatedExitU = tgtU;  break; }
  }

  // Translate underlying outcome → option premium outcome via delta=0.5
  let simulatedPremium = trade.exitPrice;
  if (outcome === 'STOP_LOSS') {
    const move = isCalls ? (stopU - entryU) : (entryU - stopU);   // negative move
    simulatedPremium = Math.max(0.01, trade.fillPrice + move * 0.5);
  } else if (outcome === 'TARGET') {
    const move = isCalls ? (tgtU - entryU) : (entryU - tgtU);     // positive move
    simulatedPremium = trade.fillPrice + move * 0.5;
  }
  const simulatedPnl = (simulatedPremium - trade.fillPrice) * 100 * trade.contracts;
  return { outcome, simulatedPnl, simulatedExitU, stopU, tgtU, dataPoints: window.length };
}

function pct(n, total) { return total ? (n / total * 100).toFixed(1) + '%' : '-'; }

function main() {
  console.log('Loading ledger + journal...');
  const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
  const dayStart = new Date('2026-05-14T04:00:00Z').getTime();
  const dayEnd   = dayStart + 86400_000;
  const trades = ledger.trades.filter(t => t.ts >= dayStart && t.ts < dayEnd && t.status === 'CLOSED');
  const alerts = loadJournalAlerts();
  const series = buildInstrumentTimeSeries(alerts);

  console.log(`Trades to backtest: ${trades.length}`);
  console.log(`Instruments with proxy data: ${Object.keys(series).join(', ')}`);
  console.log();

  // Sweep
  const STOP_MULTS = [0.50, 0.75, 1.00, 1.25, 1.50];
  const TARGET_MULTS = [0.75, 1.00, 1.25, 1.50];   // 1:1.5, 1:2, 1:2.5, 1:3 vs base stop
  // Note: target multipliers are relative to BASE target (which is 2× base stop = 1:2 R:R baseline).
  // 0.75 → 1.5× stop, 1.00 → 2× stop (1:2), 1.25 → 2.5× stop, 1.50 → 3× stop.

  const results = [];   // {stopMult, tgtMult, instrument, n, pnl, breakdown}

  // Per-instrument sweep
  const instruments = [...new Set(trades.map(t => t.instrument))];
  for (const inst of instruments) {
    const instTrades = trades.filter(t => t.instrument === inst);
    if (instTrades.length === 0) continue;
    const instSeries = series[inst] || [];

    for (const sm of STOP_MULTS) {
      for (const tm of TARGET_MULTS) {
        let pnl = 0, stopCount = 0, targetCount = 0, naturalCount = 0, insufficientCount = 0, noBaseCount = 0, noEntryCount = 0;
        for (const t of instTrades) {
          const sim = simulateTrade(t, instSeries, sm, tm);
          pnl += sim.simulatedPnl;
          if (sim.outcome === 'STOP_LOSS') stopCount++;
          else if (sim.outcome === 'TARGET') targetCount++;
          else if (sim.outcome === 'NATURAL_EXIT') naturalCount++;
          else if (sim.outcome === 'INSUFFICIENT_PROXY_DATA') insufficientCount++;
          else if (sim.outcome === 'NO_BASE_DISTANCE') noBaseCount++;
          else if (sim.outcome === 'NO_ENTRY_UNDERLYING') noEntryCount++;
        }
        results.push({
          instrument: inst, stopMult: sm, targetMult: tm,
          n: instTrades.length, pnl,
          stopCount, targetCount, naturalCount,
          insufficientCount, noBaseCount, noEntryCount,
          actualPnl: instTrades.reduce((s,t) => s + (t.pnl||0), 0),
        });
      }
    }
  }

  // Find optimal per-instrument
  const optimalPerInst = {};
  for (const inst of instruments) {
    const instResults = results.filter(r => r.instrument === inst);
    if (instResults.length === 0) continue;
    const best = instResults.reduce((a,b) => b.pnl > a.pnl ? b : a);
    optimalPerInst[inst] = best;
  }

  // Build markdown
  let md = `# Backtest Results — 2026-05-14\n\n`;
  md += `**Author:** Claude Code (P2-14 backtest framework)\n`;
  md += `**Method:** journal Pine-alert prices as underlying-path proxy; delta=0.5 approximation for option premium reconstruction\n`;
  md += `**Trades simulated:** ${trades.length}\n\n`;

  md += `## Methodology limitations\n\n`;
  md += `- **Underlying path resolution: ~30-60 seconds** between Pine alerts. Trades that breached and recovered between alerts will be missed by the simulator. Underestimates STOP_LOSS firing rate.\n`;
  md += `- **Option premium reconstruction: delta=0.5** (ATM 0DTE assumption). Under-estimates premium swings on deep-OTM or near-ATM options where delta deviates significantly.\n`;
  md += `- **Whipsaw bar-close confirmation NOT modeled** — simulator uses instant-tick semantics. Real P1-5-A protection would defer some stops by 1-2 minutes.\n`;
  md += `- **Scale-out (50/50 + BE + trail) NOT modeled** — only single-target outcome simulated. Underestimates upside capture (real STAGE_3 trail can ride above 1:2 target).\n`;
  md += `- **Per-instrument trade counts vary widely** — IWM has only ${trades.filter(t=>t.instrument==='IWM').length} trades; less statistical power.\n\n`;
  md += `Treat results as **directional** for tuning, not authoritative. Confirm with Friday-Monday session data + per-trade MFE/MAE instrumentation (P0-4 already shipped).\n\n`;

  md += `## Optimal config per instrument (max simulated PnL)\n\n`;
  md += `| Instrument | Trades | Actual PnL | Optimal Stop× | Optimal Target× | Sim PnL | Stops/Targets/Natural |\n`;
  md += `|---|---:|---:|---:|---:|---:|---|\n`;
  for (const inst of Object.keys(optimalPerInst).sort()) {
    const o = optimalPerInst[inst];
    md += `| ${inst} | ${o.n} | $${o.actualPnl.toFixed(0)} | ${o.stopMult}× | ${o.targetMult}× | $${o.pnl.toFixed(0)} | ${o.stopCount} / ${o.targetCount} / ${o.naturalCount} |\n`;
  }
  md += `\n`;

  md += `## Full sweep — all (stop, target) combos by instrument\n\n`;
  for (const inst of Object.keys(optimalPerInst).sort()) {
    const instResults = results.filter(r => r.instrument === inst).sort((a,b) => b.pnl - a.pnl);
    md += `### ${inst}\n\n`;
    md += `Base stop = ${STOP_BASE[inst] ?? 'N/A'}, base target = ${TARGET_BASE[inst] ?? 'N/A'}\n\n`;
    md += `| Stop× | Target× | Sim PnL | Stop / Target / Natural |\n`;
    md += `|---:|---:|---:|---|\n`;
    for (const r of instResults.slice(0, 10)) {
      md += `| ${r.stopMult} | ${r.targetMult} | $${r.pnl.toFixed(0)} | ${r.stopCount} / ${r.targetCount} / ${r.naturalCount} |\n`;
    }
    md += `\nData quality: insufficient=${instResults[0].insufficientCount}, no-base-distance=${instResults[0].noBaseCount}, no-entry-underlying=${instResults[0].noEntryCount}\n\n`;
  }

  md += `## Aggregate insight (across all instruments)\n\n`;
  // Sum sim PnL across all instruments per (stop, target) combo
  const aggMap = {};
  for (const r of results) {
    const key = `${r.stopMult}|${r.targetMult}`;
    if (!aggMap[key]) aggMap[key] = { stopMult: r.stopMult, targetMult: r.targetMult, pnl: 0, n: 0 };
    aggMap[key].pnl += r.pnl;
    aggMap[key].n   += r.n;
  }
  const agg = Object.values(aggMap).sort((a,b) => b.pnl - a.pnl);
  md += `Total actual realized PnL: $${trades.reduce((s,t)=>s+(t.pnl||0),0).toFixed(0)}\n\n`;
  md += `| Stop× | Target× | Total Sim PnL | vs Actual |\n`;
  md += `|---:|---:|---:|---:|\n`;
  for (const r of agg.slice(0, 12)) {
    const actual = trades.reduce((s,t)=>s+(t.pnl||0),0);
    const delta  = r.pnl - actual;
    md += `| ${r.stopMult} | ${r.targetMult} | $${r.pnl.toFixed(0)} | ${delta >= 0 ? '+' : ''}$${delta.toFixed(0)} |\n`;
  }
  md += `\n`;

  md += `## Recommendation\n\n`;
  // Pick the BEST single config across all instruments
  const overallBest = agg[0];
  md += `**Best overall (max total simulated PnL):** stop ${overallBest.stopMult}× base, target ${overallBest.targetMult}× base = $${overallBest.pnl.toFixed(0)} simulated.\n\n`;
  md += `Per-instrument splits (per the table above) outperform a single overall config because instruments have different volatility profiles. If the operator wants per-instrument env-config, take the optimal stop× / target× from the per-instrument sweep and update STOP_*_POINTS / TARGET_*_POINTS accordingly.\n\n`;
  md += `**Caveat:** today (2026-05-14) is a single-session sample with extreme PnL skew toward NQ1! catastrophe. Don't recalibrate purely on this — wait for 3-5 sessions of data + MFE/MAE instrumentation before locking new defaults.\n\n`;

  writeFileSync(OUTPUT, md);
  console.log(`Wrote: ${OUTPUT}`);
  console.log();
  console.log('Optimal per-instrument:');
  for (const inst of Object.keys(optimalPerInst).sort()) {
    const o = optimalPerInst[inst];
    console.log(`  ${inst.padEnd(8)} stop=${o.stopMult}× target=${o.targetMult}× simPnl=$${o.pnl.toFixed(0)} (actual $${o.actualPnl.toFixed(0)})`);
  }
}

main();
