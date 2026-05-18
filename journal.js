/**
 * journal.js — Append-only session journal for HANK
 *
 * One JSONL file per ET trading day under logs/journal/.
 * Every monitor process writes to the same file via appendFileSync, which is
 * atomic for line-sized writes on Windows and Linux. No lock needed.
 *
 * Why: previous sessions left no signal trace. We could see entries/exits
 * but had no visibility into which signals fired, which were blocked, or
 * what the engine state was at any given poll. After Monday this becomes
 * the post-mortem source of truth.
 *
 * Record types:
 *   POLL        — once per poll cycle, full snapshot
 *   SIGNAL      — engine produced a signal (trend / fade / structure / moo / moc)
 *   GATE_BLOCK  — signal would have entered but a gate rejected it
 *   ENTRY       — paper fill recorded
 *   EXIT        — paper close recorded
 *   ALERT       — divergence / news / volume warning
 *   ERROR       — caught exception worth investigating later
 *
 * Failures are swallowed — journaling never throws upward.
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname }    from 'path';
import { fileURLToPath }    from 'url';
import { getETString }      from './theta.js';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const JOURNAL_DIR = join(__dirname, 'logs', 'journal');

try { if (!existsSync(JOURNAL_DIR)) mkdirSync(JOURNAL_DIR, { recursive: true }); } catch {}

function etDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

function journalPath() {
  return join(JOURNAL_DIR, `journal-${etDate()}.jsonl`);
}

export function journal(record) {
  try {
    const line = JSON.stringify({ ts: Date.now(), time: getETString(), ...record }) + '\n';
    appendFileSync(journalPath(), line);
  } catch { /* never throw */ }
}

export function jPoll(snapshot)                                  { journal({ type: 'POLL',       ...snapshot }); }
export function jSignal(engine, direction, confidence, reason, extra = {}) {
  journal({ type: 'SIGNAL', engine, direction, confidence, reason, ...extra });
}
export function jGateBlock(engine, instrument, signal, blockedBy, detail = {}) {
  journal({ type: 'GATE_BLOCK', engine, instrument, signal, blockedBy, ...detail });
  // 2026-05-18 pre-RTH: ALL gate blocks echo to console with 🛑 so operator
  // sees rejections in real-time. Prior to this every gate wrote only to
  // the journal, making rejections invisible in the live webhook stream
  // (operator perceived as "silent drops"). Detail keys are truncated to
  // keep console lines scannable.
  try {
    const ctx = [];
    if (detail.source)         ctx.push(`source=${detail.source}`);
    if (detail.macro4H)        ctx.push(`4H=${detail.macro4H}`);
    if (detail.macro1H) {
      const m1 = detail.macro1H;
      ctx.push(`1H={tb:${m1.trendBias},sp:${m1.structurePattern}}`);
    }
    if (detail.macro4HSrc)     ctx.push(`4Hsrc=${detail.macro4HSrc}`);
    if (detail.macro1HSrc)     ctx.push(`1Hsrc=${detail.macro1HSrc}`);
    if (detail.reason)         ctx.push(`reason=${detail.reason}`);
    if (detail.instrumentClass) ctx.push(`class=${detail.instrumentClass}`);
    if (detail.etTime)         ctx.push(`et=${detail.etTime}`);
    console.log(`  🛑 GATE_BLOCK ${blockedBy} ${instrument} ${signal} engine=${engine}${ctx.length ? '  [' + ctx.join(' · ') + ']' : ''}`);
  } catch {}
}
export function jEntry(trade) {
  journal({
    type:        'ENTRY',
    requestId:   trade.requestId,
    instrument:  trade.instrument,
    direction:   trade.signal ?? trade.direction ?? null,
    engine:      trade.engine,
    session:     trade.session ?? null,
    confidence:  trade.confidence ?? null,
    fillPrice:   trade.fillPrice ?? null,
    contracts:   trade.contracts ?? null,
    strike:      trade.strike ?? null,
    expiry:      trade.expiry ?? null,
    entryIV:     trade.entryIV ?? null,
    macro4H:     trade.macro4H ?? null,
    tag:         trade.tag ?? null,
  });
}
export function jExit(trade) {
  journal({
    type:        'EXIT',
    requestId:   trade.requestId,
    instrument:  trade.instrument,
    engine:      trade.engine ?? null,
    exitReason:  trade.exitReason,
    exitPrice:   trade.exitPrice,
    pnl:         trade.pnl,
    pnlPct:      trade.pnlPct,
    holdMins:    trade.holdMins,
    win:         trade.win,
    tag:         trade.tag ?? null,
  });
}
export function jAlert(level, message, detail = {}) { journal({ type: 'ALERT', level, message, ...detail }); }
export function jError(scope, message, detail = {}) { journal({ type: 'ERROR', scope, message, ...detail }); }

// Path 2 (2026-05-15): futures-direct journal subtypes. Distinct from
// jEntry/jExit so analytics can grep `"type":"FUT_ENTRY"` cleanly without
// having to inspect requestId prefixes. Schema includes the futures-specific
// fields (tier, stopPrice/targetPrice as underlying prices, stage, etc.).
export function jFutEntry(trade) {
  journal({
    type:        'FUT_ENTRY',
    requestId:   trade.requestId,
    instrument:  trade.instrument,
    direction:   trade.signal ?? trade.direction ?? null,
    engine:      trade.engine,
    confidence:  trade.confidence ?? null,
    tier:        trade.tier ?? null,
    contracts:   trade.contracts ?? null,
    originalContracts: trade.originalContracts ?? null,
    entryPrice:  trade.entryPrice ?? null,
    pointValue:  trade.pointValue ?? null,
    stage:       trade.stage ?? null,
    stopPrice:   trade.stopPrice ?? null,
    stopPoints:  trade.stopPoints ?? null,
    targetPrice: trade.targetPrice ?? null,
    targetPoints:trade.targetPoints ?? null,
    invalidationLevel: trade.invalidationLevel ?? null,
    structureType:     trade.structureType ?? null,
    macro4H:     trade.macro4H ?? null,
  });
}
export function jFutExit(trade) {
  journal({
    type:        'FUT_EXIT',
    requestId:   trade.requestId,
    instrument:  trade.instrument,
    direction:   trade.signal ?? trade.direction ?? null,
    engine:      trade.engine ?? null,
    tier:        trade.tier ?? null,
    contracts:   trade.contracts ?? null,
    exitReason:  trade.exitReason,
    entryPrice:  trade.entryPrice ?? null,
    exitPrice:   trade.exitPrice,
    pnl:         trade.pnl,
    pnlPoints:   trade.pnlPoints ?? null,
    pnlRemainingLeg: trade.pnlRemainingLeg ?? null,
    cumulativePartialPnL: trade.cumulativePartialPnL ?? null,
    holdMins:    trade.holdMins,
    win:         trade.win,
    stage:       trade.stage ?? null,
    lockedStopLevel: trade.lockedStopLevel ?? null,
  });
}

export function getJournalPath() { return journalPath(); }
