#!/usr/bin/env node
/**
 * reconcile-ledger.js — Corrects the underlying-as-option-exit-price bug in
 * paper-ledger.json and recomputes all aggregates from the corrected trades.
 *
 * Bug: monitor-iwm.js / monitor-qqq.js executeSwingExit (fixed in
 * dfa9b03 2026-05-12) passed swingState.exitPrice — the UNDERLYING ETF
 * price — directly to closePosition. closePosition treats arg2 as an
 * option premium, producing phantom profits on the order of $20K+ when
 * underlying (~282) was multiplied against option entry (~$0.12).
 *
 * This script:
 *   1. Backs up paper-ledger.json to paper-ledger.{timestamp}.backup.json
 *   2. Detects buggy trades: engine=SWING AND exitPrice > 50 (option
 *      premiums for HANK's strategies never legitimately exceed $50;
 *      $50+ exit is unambiguous evidence of underlying-as-option)
 *   3. For each buggy trade, computes the corrected option exit price
 *      using the same SWING_DELTA=0.50 conversion the code fix applies:
 *        underlying_move    = buggy_exitPrice - underlying_entry
 *        dirMult            = signal === 'CALLS' ? +1 : -1
 *        corrected_option   = max(0.01, fillPrice + underlying_move × dirMult × 0.50)
 *        corrected_pnl      = (corrected_option - fillPrice) × contracts × 100
 *      Underlying entry source priority: trade.underlyingPrice →
 *      trade.entryUnderlying → trade.strike (last-resort for ATM
 *      0DTE/1DTE where strike ≈ underlying entry)
 *   4. Recomputes lg.balance / totalPnL / wins / losses / dailyPnL /
 *      engineStats from the corrected trades array (everything else
 *      stays untouched)
 *   5. Adds a `reconciled` audit field to each corrected trade
 *   6. Adds `lastReconciled` ISO timestamp to top-level ledger
 *   7. Writes corrected ledger atomically (temp file + rename)
 *   8. Prints a before/after diff
 *
 * Safe to re-run — corrected trades have `reconciled` field and are
 * skipped on subsequent runs.
 *
 * Run:  node reconcile-ledger.js              # ship the correction
 *       node reconcile-ledger.js --dry-run    # report only, don't write
 */

import { readFileSync, writeFileSync, copyFileSync, renameSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEDGER_FILE = join(__dirname, 'paper-ledger.json');

const DRY_RUN = process.argv.includes('--dry-run');
const SWING_DELTA = 0.50;
const BUG_DETECT_EXIT_PRICE_THRESHOLD = 50; // options never legitimately > $50 in HANK's strategy space

// ─── Helpers ──────────────────────────────────────────────────────────────────
function etDate(ts) {
  const d = new Date(ts);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
}

function dollars(v) { return v == null ? 'n/a' : `$${(+v).toFixed(2)}`; }

// ─── Load ─────────────────────────────────────────────────────────────────────
if (!existsSync(LEDGER_FILE)) {
  console.error(`No ledger found at ${LEDGER_FILE}`);
  process.exit(1);
}

const lg = JSON.parse(readFileSync(LEDGER_FILE, 'utf8'));

const snapshotBefore = {
  balance:     lg.balance,
  totalPnL:    lg.totalPnL,
  wins:        lg.wins,
  losses:      lg.losses,
  totalTrades: lg.totalTrades,
  dailyPnL:    { ...(lg.dailyPnL || {}) },
  engineStats: JSON.parse(JSON.stringify(lg.engineStats || {})),
};

// ─── Detect & correct buggy trades ────────────────────────────────────────────
const corrections = [];
const skippedAlreadyReconciled = [];

for (const t of (lg.trades || [])) {
  if (t.engine !== 'SWING')                                          continue;
  if (t.status !== 'CLOSED')                                         continue;
  if (!Number.isFinite(t.exitPrice) || !Number.isFinite(t.fillPrice)) continue;
  if (t.exitPrice <= BUG_DETECT_EXIT_PRICE_THRESHOLD)                continue;
  if (t.reconciled)                                                  { skippedAlreadyReconciled.push(t.requestId); continue; }

  // This trade matches the bug shape. Compute corrected option exit price.
  const underlyingEntry =
    Number.isFinite(t.underlyingPrice)   ? t.underlyingPrice   :
    Number.isFinite(t.entryUnderlying)   ? t.entryUnderlying   :
    Number.isFinite(t.strike)            ? t.strike            :
    null;

  if (!Number.isFinite(underlyingEntry)) {
    corrections.push({
      requestId: t.requestId,
      instrument: t.instrument,
      timeET: t.timeET,
      error: 'No underlying entry price available (underlyingPrice / entryUnderlying / strike all missing). Trade NOT corrected.',
      old: { exitPrice: t.exitPrice, pnl: t.pnl },
    });
    continue;
  }

  const dirMult           = t.signal === 'CALLS' ? 1 : t.signal === 'PUTS' ? -1 : 0;
  if (dirMult === 0) {
    corrections.push({
      requestId: t.requestId,
      instrument: t.instrument,
      timeET: t.timeET,
      error: `Unknown direction ${t.signal}; cannot determine dirMult. Trade NOT corrected.`,
      old: { exitPrice: t.exitPrice, pnl: t.pnl },
    });
    continue;
  }

  const buggyUnderlyingExit = t.exitPrice; // this is what was stored as if it were option price
  const underlyingMove      = buggyUnderlyingExit - underlyingEntry;
  const optionEst           = Math.max(0.01, t.fillPrice + underlyingMove * dirMult * SWING_DELTA);
  const correctedExitPrice  = parseFloat(optionEst.toFixed(4));
  const correctedPnl        = parseFloat(((correctedExitPrice - t.fillPrice) * (t.contracts ?? 1) * 100).toFixed(2));
  const correctedPnlPct     = parseFloat((((correctedExitPrice - t.fillPrice) / t.fillPrice) * 100).toFixed(2));

  corrections.push({
    requestId: t.requestId,
    instrument: t.instrument,
    timeET: t.timeET,
    signal: t.signal,
    contracts: t.contracts,
    fillPrice: t.fillPrice,
    underlyingEntry,
    underlyingExit: buggyUnderlyingExit,
    underlyingMove,
    old: { exitPrice: t.exitPrice, pnl: t.pnl, pnlPct: t.pnlPct },
    new: { exitPrice: correctedExitPrice, pnl: correctedPnl, pnlPct: correctedPnlPct },
    pnl_delta: parseFloat((correctedPnl - (t.pnl ?? 0)).toFixed(2)),
  });

  // Apply mutations in-memory always — dry-run skips only the file write below.
  // This lets the dry-run preview show accurate post-correction aggregates.
  const originalExitPrice = t.exitPrice;
  const originalPnl       = t.pnl;
  t.exitPrice = correctedExitPrice;
  t.pnl       = correctedPnl;
  t.pnlPct    = correctedPnlPct;
  t.win       = correctedPnl > 0;
  t.reconciled = {
    at:     new Date().toISOString(),
    reason: 'underlying-as-option exit-price bug (monitor-iwm.js / monitor-qqq.js executeSwingExit pre-dfa9b03)',
    original: { exitPrice: originalExitPrice, pnl: originalPnl },
  };
}

// ─── Recompute aggregates from corrected trades ──────────────────────────────
let recomputed_totalPnL = 0;
let recomputed_wins     = 0;
let recomputed_losses   = 0;
const recomputed_dailyPnL    = {};
const recomputed_engineStats = {};

for (const t of (lg.trades || [])) {
  if (t.status !== 'CLOSED')           continue;
  if (!Number.isFinite(t.pnl))         continue;

  recomputed_totalPnL += t.pnl;
  if (t.pnl > 0) recomputed_wins++;
  else           recomputed_losses++;

  const exitTs = t.exitTime || t.ts;
  if (Number.isFinite(exitTs)) {
    const d = etDate(exitTs);
    recomputed_dailyPnL[d] = (recomputed_dailyPnL[d] || 0) + t.pnl;
  }

  const eng = t.engine || 'UNKNOWN';
  recomputed_engineStats[eng] = recomputed_engineStats[eng] || { trades: 0, wins: 0, losses: 0, pnl: 0 };
  recomputed_engineStats[eng].trades++;
  if (t.pnl > 0) recomputed_engineStats[eng].wins++;
  else           recomputed_engineStats[eng].losses++;
  recomputed_engineStats[eng].pnl += t.pnl;
}

// Round per-day pnl
for (const k of Object.keys(recomputed_dailyPnL)) {
  recomputed_dailyPnL[k] = parseFloat(recomputed_dailyPnL[k].toFixed(2));
}
// Round per-engine pnl
for (const k of Object.keys(recomputed_engineStats)) {
  recomputed_engineStats[k].pnl = parseFloat(recomputed_engineStats[k].pnl.toFixed(2));
}

const startBalance     = Number.isFinite(lg.startBalance) ? lg.startBalance : 25000;
const recomputed_balance = parseFloat((startBalance + recomputed_totalPnL).toFixed(2));
const recomputed_totalPnL_rounded = parseFloat(recomputed_totalPnL.toFixed(2));

// ─── Audit print ──────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(72)}`);
console.log(`reconcile-ledger.js  ${DRY_RUN ? '(DRY RUN — no writes)' : ''}`);
console.log(`${'='.repeat(72)}\n`);

console.log(`Ledger: ${LEDGER_FILE}`);
console.log(`Trades total:               ${(lg.trades || []).length}`);
console.log(`Trades closed (recomputed): ${recomputed_wins + recomputed_losses}`);
console.log(`Buggy trades found:         ${corrections.length}`);
console.log(`Already-reconciled (skipped): ${skippedAlreadyReconciled.length}`);
console.log();

if (corrections.length === 0) {
  console.log(`No buggy trades to correct. Aggregates may still be off if the ledger\nwas hand-edited or missing fields — recomputing them anyway.\n`);
}

for (const c of corrections) {
  if (c.error) {
    console.log(`⚠  ${c.timeET} ${c.instrument} ${c.requestId}: ${c.error}`);
    continue;
  }
  console.log(`✓  ${c.timeET} ${c.instrument} ${c.signal} ${c.contracts}× ${c.requestId}`);
  console.log(`   underlying entry $${c.underlyingEntry?.toFixed(2)} → exit $${c.underlyingExit.toFixed(2)} (move ${c.underlyingMove > 0 ? '+' : ''}${c.underlyingMove.toFixed(2)})`);
  console.log(`   exitPrice  ${dollars(c.old.exitPrice).padStart(12)} → ${dollars(c.new.exitPrice).padEnd(10)}`);
  console.log(`   pnl        ${dollars(c.old.pnl).padStart(12)} → ${dollars(c.new.pnl).padEnd(10)}  (delta ${dollars(c.pnl_delta)})`);
}
console.log();

console.log('Aggregate before / after:');
console.log(`  balance:     ${dollars(snapshotBefore.balance).padStart(14)} → ${dollars(recomputed_balance)}`);
console.log(`  totalPnL:    ${dollars(snapshotBefore.totalPnL).padStart(14)} → ${dollars(recomputed_totalPnL_rounded)}`);
console.log(`  wins:        ${String(snapshotBefore.wins).padStart(14)} → ${recomputed_wins}`);
console.log(`  losses:      ${String(snapshotBefore.losses).padStart(14)} → ${recomputed_losses}`);
console.log();

console.log('dailyPnL diff:');
const allDays = new Set([...Object.keys(snapshotBefore.dailyPnL), ...Object.keys(recomputed_dailyPnL)]);
for (const d of [...allDays].sort()) {
  const oldV = snapshotBefore.dailyPnL[d];
  const newV = recomputed_dailyPnL[d];
  if ((oldV ?? 0) === (newV ?? 0)) continue;
  console.log(`  ${d}: ${dollars(oldV).padStart(14)} → ${dollars(newV)}  (delta ${dollars((newV ?? 0) - (oldV ?? 0))})`);
}
console.log();

console.log('engineStats diff:');
const allEng = new Set([...Object.keys(snapshotBefore.engineStats), ...Object.keys(recomputed_engineStats)]);
for (const e of [...allEng].sort()) {
  const oldS = snapshotBefore.engineStats[e] || {};
  const newS = recomputed_engineStats[e] || {};
  if (oldS.pnl === newS.pnl && oldS.trades === newS.trades) continue;
  console.log(`  ${e.padEnd(12)} trades ${(oldS.trades ?? 0)}→${(newS.trades ?? 0)}  W/L ${(oldS.wins ?? 0)}/${(oldS.losses ?? 0)}→${(newS.wins ?? 0)}/${(newS.losses ?? 0)}  pnl ${dollars(oldS.pnl).padStart(12)}→${dollars(newS.pnl)}`);
}
console.log();

// ─── Write (unless dry-run) ───────────────────────────────────────────────────
if (DRY_RUN) {
  console.log(`DRY RUN — no files modified. Re-run without --dry-run to apply.\n`);
  process.exit(0);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const BACKUP_FILE = join(__dirname, `paper-ledger.${timestamp}.backup.json`);
copyFileSync(LEDGER_FILE, BACKUP_FILE);
console.log(`Backup written: ${BACKUP_FILE}`);

lg.balance      = recomputed_balance;
lg.totalPnL     = recomputed_totalPnL_rounded;
lg.wins         = recomputed_wins;
lg.losses       = recomputed_losses;
lg.dailyPnL     = recomputed_dailyPnL;
lg.engineStats  = recomputed_engineStats;
lg.lastReconciled = {
  at:                 new Date().toISOString(),
  correctionsApplied: corrections.filter(c => !c.error).length,
  correctionsErrored: corrections.filter(c => c.error).length,
  bugFixCommit:       'dfa9b03',
};

// Atomic write: temp file then rename
const TEMP_FILE = LEDGER_FILE + '.reconcile.tmp';
writeFileSync(TEMP_FILE, JSON.stringify(lg, null, 2));
renameSync(TEMP_FILE, LEDGER_FILE);
console.log(`Ledger updated: ${LEDGER_FILE}`);
console.log(`\nReconciliation complete.\n`);
