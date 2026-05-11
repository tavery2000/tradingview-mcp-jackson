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

export function getJournalPath() { return journalPath(); }
