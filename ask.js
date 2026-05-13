/**
 * ask.js — Natural-language Q&A over HANK's local state files.
 *
 * Pure additive module. Reads only — never writes, never imports from
 * monitors. Caller (ask-cli.js) feeds raw text; this module routes it
 * to one of ~10 read-only handlers and returns a formatted string.
 *
 * Schemas verified against the actual files on disk before shipping:
 *   {sym}-levels.json   — { pdHigh, pdLow, pdClose, todayOpen, current,
 *                            vwap, bias, ts, time }
 *   paper-ledger.json   — { version, balance, totalPnL, totalTrades, wins,
 *                            losses, trades: [{requestId, signal, engine,
 *                            instrument, status, fillPrice, exitPrice,
 *                            pnl, exitReason, win, ...}, ...] }
 *   hank_stats.json     — { moc: { trades, exits, noTrades: [{date,
 *                            time, reason}] } }
 *   daily-bias.json     — { ts, time, verdict: { bias, confidence,
 *                            ... }, features: { gapPct, ... } }
 *   options-flow.json   — { ts, time, SPY: { chains: { '0DTE':
 *                            { putCallVolRatio, skew, verdict: { direction,
 *                            confidence, reason } }, ... } }, QQQ: {...},
 *                            IWM: {...} }
 *   account-tier.json   — { tier, tierName, equity, tierUpHWM,
 *                            eligibleForUp, consecutiveLosses, ... }
 *   logs/journal/journal-{ET-date}.jsonl — one JSON record per line, fields
 *                            { ts, time, type, ... } where type is one of
 *                            SIGNAL, GATE_BLOCK, ENTRY, EXIT, ALERT, ERROR.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── ET date (matches journal.js etDate()) ──────────────
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

// ─── Safe file readers (return null on any failure) ─────
function readJsonSafe(file) {
  const p = join(__dirname, file);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function readJournal(opts = {}) {
  const file = join(__dirname, 'logs', 'journal', `journal-${etDate()}.jsonl`);
  if (!existsSync(file)) return [];
  let lines = [];
  try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean); }
  catch { return []; }
  const out = [];
  // Walk newest → oldest
  for (let i = lines.length - 1; i >= 0 && out.length < (opts.max ?? 200); i--) {
    let r;
    try { r = JSON.parse(lines[i]); } catch { continue; }
    if (opts.type   && r.type !== opts.type)         continue;
    if (opts.types  && !opts.types.includes(r.type)) continue;
    if (opts.filter && !opts.filter(r))              continue;
    out.push(r);
  }
  return out;
}

// ─── Formatting helpers ─────────────────────────────────
function fmtMoney(n)  { if (n == null || isNaN(n)) return '—'; const s = n >= 0 ? '+' : ''; return `${s}$${Math.abs(n).toFixed(2)}`.replace('+-', '-'); }
function fmtPrice(n)  { if (n == null || isNaN(n)) return '—';  return `$${n.toFixed(2)}`; }
function fmtPct(n)    { if (n == null || isNaN(n)) return '—';  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function ageStr(ts)   {
  if (!ts) return 'never';
  const ageS = Math.floor((Date.now() - ts) / 1000);
  if (ageS < 60)    return `${ageS}s ago`;
  if (ageS < 3600)  return `${Math.floor(ageS / 60)}m ago`;
  if (ageS < 86400) return `${Math.floor(ageS / 3600)}h ago`;
  return `${Math.floor(ageS / 86400)}d ago`;
}
function pad(s, n)   { s = String(s ?? ''); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

// ─── Handlers ───────────────────────────────────────────
function answerInstrument(sym) {
  const j = readJsonSafe(`${sym.toLowerCase()}-levels.json`);
  if (!j) return `No data for ${sym}. Is monitor.js running? (looked for ${sym.toLowerCase()}-levels.json)`;
  const pxRel = (j.current != null && j.vwap != null)
    ? (j.current > j.vwap ? `above VWAP` : j.current < j.vwap ? `below VWAP` : `at VWAP`)
    : '';
  const lines = [
    `${sym}  ${fmtPrice(j.current)}  ${pxRel}  (vwap ${fmtPrice(j.vwap)})`,
    `  PDH ${fmtPrice(j.pdHigh)}   PDL ${fmtPrice(j.pdLow)}   PDC ${fmtPrice(j.pdClose)}`,
    `  Open ${fmtPrice(j.todayOpen)}   Bias ${j.bias ?? '—'}`,
    `  Last update ${j.time ?? '—'} ET (${ageStr(j.ts)})`,
  ];
  return lines.join('\n');
}

function answerMaster() {
  const out = ['MASTER OVERVIEW'];
  for (const sym of ['SPY', 'QQQ', 'IWM']) {
    const j = readJsonSafe(`${sym.toLowerCase()}-levels.json`);
    if (!j) { out.push(`  ${pad(sym, 4)} —  no data`); continue; }
    const arrow = (j.current != null && j.vwap != null)
      ? (j.current > j.vwap ? '↑' : j.current < j.vwap ? '↓' : '·') : '·';
    out.push(`  ${pad(sym, 4)} ${pad(fmtPrice(j.current), 9)}  ${arrow} vwap ${pad(fmtPrice(j.vwap), 9)}  ${pad(j.bias ?? '—', 12)}  ${ageStr(j.ts)}`);
  }
  // Daily bias verdict
  const b = readJsonSafe('daily-bias.json');
  if (!b || !b.verdict) {
    out.push('', 'DAILY BIAS — not yet evaluated (fires at 09:40 ET)');
  } else {
    const v = b.verdict;
    out.push('', `DAILY BIAS — ${v.bias ?? '—'}  conf ${v.confidence ?? '—'}  ${b.time ?? ''} ET`);
    if (b.features) {
      const f = b.features;
      out.push(`  gap ${fmtPct(f.gapPct)}   OR ${fmtPrice(f.orLow)}–${fmtPrice(f.orHigh)}   ATR5d ${fmtPrice(f.atr5d)}`);
    }
  }
  return out.join('\n');
}

function answerSignals() {
  const recs = readJournal({ type: 'SIGNAL', max: 10 });
  if (!recs.length) return 'No SIGNAL events in today\'s journal.';
  const out = ['LAST 10 SIGNALS (newest first)'];
  for (const r of recs) {
    const dir = r.direction || r.signal || '—';
    const eng = r.engine || '—';
    const conf = r.confidence ? ` ${r.confidence}` : '';
    const reason = r.reason ? ` — ${r.reason}` : '';
    out.push(`  [${r.time ?? '--:--:--'}] ${pad(eng, 9)} ${pad(dir, 5)}${conf}${reason}`);
  }
  return out.join('\n');
}

function answerBias() {
  const j = readJsonSafe('daily-bias.json');
  if (!j) return 'No daily bias yet — fires at 09:40 ET.';
  const v = j.verdict ?? {};
  const f = j.features ?? {};
  const out = [
    `DAILY BIAS — ${v.bias ?? '—'}   confidence ${v.confidence ?? '—'}`,
    `  evaluated ${j.time ?? '—'} ET (${ageStr(j.ts)})`,
  ];
  if (Object.keys(f).length) {
    out.push('  features:');
    out.push(`    gap        ${fmtPct(f.gapPct)}`);
    out.push(`    OR range   ${fmtPrice(f.orLow)} – ${fmtPrice(f.orHigh)}  (width ${fmtPrice(f.orRange)})`);
    out.push(`    open       ${fmtPrice(f.openPrice)}    current ${fmtPrice(f.currentPrice)}`);
    out.push(`    vwap       ${fmtPrice(f.vwap)}     pdClose ${fmtPrice(f.pdClose)}`);
    out.push(`    ATR(5d)    ${fmtPrice(f.atr5d)}`);
    if (f.barsAbove != null || f.barsBelow != null) {
      out.push(`    bars       above vwap ${f.barsAbove ?? '—'}  below ${f.barsBelow ?? '—'}`);
    }
    if (f.catalyst && f.catalyst !== 'none') out.push(`    catalyst   ${f.catalyst}`);
  }
  return out.join('\n');
}

function answerWhy(sym) {
  const recs = readJournal({
    type: 'GATE_BLOCK',
    max: 5,
    filter: r => sym ? r.instrument === sym : true,
  });
  if (!recs.length) {
    return sym
      ? `No GATE_BLOCK events for ${sym} in today's journal.`
      : 'No gate blocks logged today.';
  }
  const out = [sym ? `LAST 5 GATE BLOCKS — ${sym}` : 'LAST 5 GATE BLOCKS'];
  for (const r of recs) {
    const eng = r.engine || '—';
    const inst = r.instrument || '—';
    const dir  = r.signal || '—';
    const why  = r.blockedBy || '—';
    out.push(`  [${r.time ?? '--:--:--'}] ${pad(eng, 9)} ${pad(inst, 4)} ${pad(dir, 5)} blocked by ${why}`);
  }
  return out.join('\n');
}

function answerPositions() {
  const j = readJsonSafe('paper-ledger.json');
  if (!j) return 'paper-ledger.json not found. Has any trade run yet?';
  const open = (j.trades ?? []).filter(t => t.status === 'OPEN');
  if (!open.length) return 'No open positions.';
  const out = [`${open.length} OPEN POSITION${open.length === 1 ? '' : 'S'}`];
  for (const t of open) {
    const strike = t.strike ? `$${t.strike}` : (t.type ?? '—');
    const fill   = t.fillPrice != null ? fmtPrice(t.fillPrice) : '—';
    const since  = ageStr(t.fillTime ?? t.ts);
    out.push(`  ${pad(t.instrument ?? '—', 4)} ${pad(t.signal ?? '—', 5)} ${pad(t.engine ?? '—', 9)} ${pad(strike, 8)}  fill ${fill}  ${since}  conf ${t.confidence ?? '—'}`);
  }
  return out.join('\n');
}

function answerPnL() {
  const j = readJsonSafe('paper-ledger.json');
  if (!j) return 'paper-ledger.json not found.';
  // Today's exits — read EXIT journal entries for today
  const exits = readJournal({ type: 'EXIT', max: 50 });
  const out = [];
  out.push(`BALANCE        ${fmtMoney(j.balance)}    (start ${fmtMoney(j.startBalance)})`);
  out.push(`TOTAL PNL      ${fmtMoney(j.totalPnL)}    ${j.totalTrades ?? 0} trades  ${j.wins ?? 0}W ${j.losses ?? 0}L`);

  if (!exits.length) {
    out.push('', 'No exits today.');
  } else {
    out.push('', `TODAY'S EXITS (${exits.length})`);
    let dayPnL = 0;
    for (const e of exits) {
      dayPnL += (e.pnl ?? 0);
      const sign = (e.win === true) ? 'W' : (e.win === false) ? 'L' : '·';
      out.push(`  [${e.time ?? '--:--:--'}] ${pad(e.instrument ?? '—', 4)} ${pad(e.engine ?? '—', 9)} ${pad(e.exitReason ?? '—', 14)} ${pad(fmtMoney(e.pnl), 9)} ${sign}`);
    }
    out.push('', `DAY PNL        ${fmtMoney(dayPnL)}`);
  }
  return out.join('\n');
}

function answerTier() {
  const j = readJsonSafe('account-tier.json');
  if (!j) return 'account-tier.json not found.';
  const out = [
    `TIER  T${j.tier ?? '?'}  ${j.tierName ?? ''}`,
    `  equity      ${fmtMoney(j.equity)}`,
    `  HWM         ${fmtMoney(j.tierUpHWM)}`,
    `  consec L    ${j.consecutiveLosses ?? 0}`,
  ];
  if (j.eligibleForUp != null) {
    out.push(`  tier-up     ${j.eligibleForUp ? 'ELIGIBLE — operator approval pending' : 'not eligible'}`);
  }
  if (j.lastChangeAt) {
    out.push(`  last change ${j.lastChangeReason ?? '—'}  ${ageStr(j.lastChangeAt)}`);
  }
  if (Array.isArray(j.dailyCapHits) && j.dailyCapHits.length) {
    out.push(`  daily-cap hits in last 5 days: ${j.dailyCapHits.length}`);
  }
  return out.join('\n');
}

function answerFlow(sym) {
  sym = (sym || 'SPY').toUpperCase();
  const j = readJsonSafe('options-flow.json');
  if (!j) return 'options-flow.json not found.';
  const symData = j[sym];
  if (!symData) return `options-flow.json has no entry for ${sym}.`;
  const ch = symData.chains?.['0DTE'];
  if (!ch) return `No 0DTE chain data for ${sym}.`;
  const v = ch.verdict ?? {};
  const out = [
    `OPTIONS FLOW — ${sym} 0DTE  (${j.time ?? '—'} ET, ${ageStr(j.ts)})`,
    `  verdict     ${v.direction ?? '—'}   confidence ${v.confidence ?? '—'}`,
    `  reason      ${v.reason ?? '—'}`,
    `  P/C vol     ${ch.putCallVolRatio ?? '—'}    skew  ${ch.skew ?? '—'}    source ${ch.source ?? symData.source ?? '—'}`,
    `  underlying  ${fmtPrice(symData.underlying)}    atr ${fmtPrice(symData.atr)}    expiry ${ch.expiry ?? '—'}`,
  ];
  return out.join('\n');
}

function answerMoc() {
  // Recent MOC alerts — type=ALERT, level contains 'moc'
  const recs = readJournal({
    type: 'ALERT',
    max: 10,
    filter: r => /moc/i.test(String(r.level ?? '')) || /moc/i.test(String(r.message ?? '')),
  });
  const out = [];
  // Also surface any MOC stats from hank_stats.json
  const stats = readJsonSafe('hank_stats.json');
  if (stats?.moc) {
    const m = stats.moc;
    out.push(`MOC HISTORY (hank_stats.json)`);
    out.push(`  trades ${m.trades?.length ?? 0}   exits ${m.exits?.length ?? 0}   no-trade days ${m.noTrades?.length ?? 0}`);
    if (Array.isArray(m.noTrades) && m.noTrades.length) {
      const last3 = m.noTrades.slice(-3);
      for (const n of last3) out.push(`    ${n.date} ${n.time}  no-trade — ${n.reason}`);
    }
    out.push('');
  }
  if (!recs.length) {
    out.push('No MOC ALERT events in today\'s journal.');
  } else {
    out.push(`LAST ${recs.length} MOC ALERTS`);
    for (const r of recs) {
      const lvl = r.level ?? '—';
      const msg = r.message ?? '—';
      out.push(`  [${r.time ?? '--:--:--'}] ${pad(lvl, 22)} ${msg}`);
    }
  }
  return out.join('\n');
}

function answerTheta() {
  const t = readJsonSafe('portfolio-theta.json');
  if (!t) return 'portfolio-theta.json not found — is theta-monitor.js running?';
  const out = [];
  const burnLabel = t.burnZone?.current?.label ?? '—';
  const thetaMin = t.portfolioThetaPerMin ?? 0;
  const thetaPerHour = thetaMin * 60;
  const feeds = t.feeds || {};
  const wsMark = feeds.ws === true ? 'on' : 'OFF';
  const cdpMark = feeds.cdp === true ? 'on' : feeds.cdp === false ? 'OFF' : '—';
  out.push(`PORTFOLIO THETA  (${t.time ?? '—'} ET, ${ageStr(t.ts)})`);
  out.push(`  burn zone     ${burnLabel}    paying ${fmtMoney(thetaMin)}/min  (~${fmtMoney(thetaPerHour)}/hr)`);
  out.push(`  positions     ${t.positionCount ?? 0}    feeds  ws=${wsMark} cdp=${cdpMark}`);

  if (!t.positions || !t.positions.length) {
    out.push('', 'No open positions.');
    return out.join('\n');
  }

  out.push('', 'POSITION CARDS');
  for (const p of t.positions) {
    if (p.error) {
      out.push(`  [${p.instrument} ${p.engine ?? '—'} ${p.signal}]  ${p.contracts ?? 1} contract — ${p.error} (synthetic)`);
      continue;
    }
    const synthMark = p.synthetic ? '  ⚠ synthetic' : '';
    const ivMark    = p.ivCrushing ? '  ⚠ IV CRUSH' : '';
    const exitMark  = p.exitNow ? '  ⚠ EXIT NOW' : p.exitWarn ? '  ⚠ exit warn' : '';
    const pnl       = p.pnl ?? 0;
    const pnlSign   = pnl >= 0 ? '+' : '';
    const g         = p.greeks || {};
    const ivCurPct  = (p.currentIV ?? 0) * 100;
    const ivEntPct  = (p.entryIV   ?? 0) * 100;
    const ivChPct   = (p.ivChange  ?? 0) * 100;
    out.push('');
    out.push(`  [${p.instrument} ${p.engine ?? '—'} ${p.signal}]  ${p.contracts} contract  strike ${fmtPrice(p.strike)}${synthMark}`);
    out.push(`    entry ${fmtPrice(p.entryPrice)}  →  est ${fmtPrice(p.currentEstOption)}  (${pnlSign}${(p.pnlPct ?? 0).toFixed(1)}%, ${fmtMoney(pnl)})${ivMark}`);
    out.push(`    delta ${(g.delta ?? 0).toFixed(3)}    theta/min ${(p.thetaPerMin ?? 0).toFixed(3)}    IV ${ivCurPct.toFixed(1)}% (entry ${ivEntPct.toFixed(1)}%, ${ivChPct >= 0 ? '+' : ''}${ivChPct.toFixed(1)})`);
    out.push(`    held ${(p.minsHeld ?? 0).toFixed(0)} min    hardExit in ${(p.hardExitMins ?? 0).toFixed(0)} min    burn ${p.burnZone?.label ?? p.burnRate ?? '—'}${exitMark}`);
  }
  return out.join('\n');
}

function helpText() {
  return [
    'HANK ASK — local-state Q&A (no internet, no LLM, file reads only)',
    '',
    '  spy / qqq / iwm           per-instrument snapshot (price, vwap, levels)',
    '  signal / master / overview master view + daily-bias verdict',
    '  signals                   last 10 SIGNAL journal entries',
    '  bias                      daily-bias verdict + features',
    '  why [sym]                 last 5 GATE_BLOCK entries (optional sym filter)',
    '  position / open           open positions from paper-ledger.json',
    '  pnl / today               today\'s exits + balance',
    '  tier                      account tier state + eligibility',
    '  flow [sym]                options-flow 0DTE verdict (default SPY)',
    '  moc                       MOC ALERT entries + hank_stats.moc summary',
    '  theta / greeks / burn     portfolio theta + per-position greeks/burn-zone',
    '  help / ?                  this list',
    '  quit / exit               leave the REPL',
    '',
    '  combine: "why spy"  "spy flow"  "spy"  "flow qqq"',
  ].join('\n');
}

// ─── Public router ──────────────────────────────────────
export function answerQuestion(text) {
  if (text == null) return helpText();
  const q = String(text).trim();
  if (!q) return helpText();
  const lo = q.toLowerCase();

  // Detect symbol mention (word-bounded so "spyder" doesn't match)
  const sym =
      /\bspy\b/i.test(q) ? 'SPY'
    : /\bqqq\b/i.test(q) ? 'QQQ'
    : /\biwm\b/i.test(q) ? 'IWM'
    : null;

  // Symbol-bound topic combinations come first
  if (sym && /\b(why|block|gate)\b/.test(lo))      return answerWhy(sym);
  if (sym && /\b(flow|chain|option)/.test(lo))     return answerFlow(sym);

  // Help / quit aliases
  if (/^help$|^\?$/.test(lo))                      return helpText();

  // Plural-anchored before singular (per spec)
  if (/^signals$/.test(lo))                        return answerSignals();

  // Topic-only (order matters per spec)
  if (/^bias$/.test(lo) || /daily.*bias/.test(lo)) return answerBias();
  if (/\b(signal|master|overview)\b/.test(lo))     return answerMaster();
  if (/\b(why|block|gate)\b/.test(lo))             return answerWhy(null);
  if (/\b(position|open|holding)\b/.test(lo))      return answerPositions();
  if (/\b(pnl|p&l|profit|today)\b/.test(lo))       return answerPnL();
  if (/\b(tier|equity|hwm)\b/.test(lo))            return answerTier();
  if (/\b(flow|chain|option)/.test(lo))            return answerFlow('SPY');
  if (/\b(moc|imbalance|close)\b/.test(lo))        return answerMoc();
  if (/\b(theta|greeks|burn)\b/.test(lo))          return answerTheta();

  // Symbol-only fallback
  if (sym) return answerInstrument(sym);

  return `Unknown command: "${q}". Type 'help' for the list.`;
}

// Exposed for tests
export { etDate, readJsonSafe, readJournal, helpText };
