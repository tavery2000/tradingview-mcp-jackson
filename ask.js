/**
 * ask.js — Natural-language Q&A over HANK's local state files.
 *
 * Mostly read-only. Two exceptions added 2026-05-15 Task 5:
 *   - `kill [SYM]`  — close open positions matching SYM (or ALL if no arg)
 *   - `flatten`     — alias for `kill` (close ALL open positions)
 * These are the only WRITE paths. Everything else stays pure-read. Caller
 * (ask-cli.js) feeds raw text; this module routes it to one of ~12 handlers
 * and returns a formatted string.
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
    'HANK ASK — local-state Q&A (mostly read-only; kill/flatten WRITE)',
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
    '  kill [SYM] / flatten      ⚠ CLOSE all open positions (optional symbol filter)',
    '  calibrate / calibration   show calibration cache stats',
    '  reload calibration        ⚠ force-reload calibration-lookup.json from disk',
    '  rebuild calibration       ⚠ run analyze-calibration.js NOW (out of schedule)',
    '  mcp status                Webull MCP connection state + available tools',
    '  mcp accounts              list Webull accounts (read-only)',
    '  mcp positions             list current positions via MCP',
    '  mcp test order            ⚠ submit a TINY sandbox test order (1c MES1! market)',
    '  mcp paper / paper-check   inspect paper-mode verification result',
    '  webull                    combined status: MCP health + paper-mode check',
    '  webull auth               ⚠ interactive 2FA — approve push in Webull mobile app',
    '  webull reconnect          force MCP child reconnect (after auth succeeds)',
    '  webull paper              just the paper-mode verification dump',
    '  roll guard tick           run rollGuard once and show state',
    '  circuit breaker           show tripped state + state file',
    '  clear circuit breaker     ⚠ clear circuit breaker (restart required to fully reset)',
    '  help / ?                  this list',
    '  quit / exit               leave the REPL',
    '',
    '  combine: "why spy"  "spy flow"  "spy"  "flow qqq"  "kill iwm"',
  ].join('\n');
}

// ─── MCP handlers (Sunday 2026-05-17) ──────────────────────
async function answerMcpStatus() {
  try {
    const { getWebullMCP, isMCPDisabled, isIntegrationHalted, isPaperVerified, getPaperAccountId } = await import('./webull-mcp-client.js');
    const mcp = getWebullMCP();
    const pv = isPaperVerified();
    const pvStr = pv === true ? 'YES' : pv === false ? 'NO (orders blocked!)' : 'not yet checked';
    const out = [
      'WEBULL MCP STATUS',
      `  connected           ${mcp.isConnected() ? 'yes' : 'NO'}`,
      `  WEBULL_MCP_DISABLED ${isMCPDisabled() ? 'true (rollback active)' : 'false'}`,
      `  WEBULL_INTEGRATION_HALT ${isIntegrationHalted() ? 'TRUE (catastrophic halt)' : 'false'}`,
      `  WEBULL_ENVIRONMENT  ${process.env.WEBULL_ENVIRONMENT || 'uat (default)'}`,
      `  paper verified      ${pvStr}`,
      `  paper account_id    ${getPaperAccountId() || '(none)'}`,
      `  available tools     ${mcp.availableTools().length}`,
    ];
    if (mcp.availableTools().length) {
      out.push(`  tool list (first 12): ${mcp.availableTools().slice(0, 12).join(', ')}`);
    }
    return out.join('\n');
  } catch (e) { return `mcp status failed: ${e.message}`; }
}
async function answerMcpPaperCheck() {
  try {
    const { getLastVerifyResponse, isPaperVerified, getPaperAccountId } = await import('./webull-mcp-client.js');
    const resp = getLastVerifyResponse();
    const pv = isPaperVerified();
    const out = [
      'WEBULL PAPER-MODE CHECK',
      `  verified      ${pv === true ? 'YES' : pv === false ? 'NO' : 'not yet checked'}`,
      `  account_id    ${getPaperAccountId() || '(none)'}`,
      `  raw response  (last get_account_list):`,
      resp ? JSON.stringify(resp, null, 2).slice(0, 3000) : '  (no response captured yet)',
    ];
    return out.join('\n');
  } catch (e) { return `mcp paper-check failed: ${e.message}`; }
}
async function answerMcpAccounts() {
  try {
    const { getWebullMCP } = await import('./webull-mcp-client.js');
    const mcp = getWebullMCP();
    if (!mcp.isConnected()) return 'MCP not connected';
    const r = await mcp.getAccountList();
    return 'WEBULL ACCOUNTS\n' + JSON.stringify(r, null, 2).slice(0, 2000);
  } catch (e) { return `mcp accounts failed: ${e.message}`; }
}
async function answerMcpPositions() {
  try {
    const { getWebullMCP } = await import('./webull-mcp-client.js');
    const mcp = getWebullMCP();
    if (!mcp.isConnected()) return 'MCP not connected';
    const r = await mcp.getAccountPositions({});
    return 'WEBULL POSITIONS\n' + JSON.stringify(r, null, 2).slice(0, 2000);
  } catch (e) { return `mcp positions failed: ${e.message}`; }
}
async function answerMcpTestOrder() {
  try {
    const { getWebullMCP } = await import('./webull-mcp-client.js');
    const mcp = getWebullMCP();
    if (!mcp.isConnected()) return 'MCP not connected — cannot send test order';
    const env = (process.env.WEBULL_ENVIRONMENT || 'uat').toLowerCase();
    if (env !== 'uat') return `⚠ REFUSED — WEBULL_ENVIRONMENT=${env}; this command is sandbox-only by design`;
    const r = await mcp.placeFuturesOrder({
      instrument: 'MES1!', direction: 'CALLS', engine: 'TEST_ORDER',
      confidence: 'LOW', price: 0, macro4H: 'UNKNOWN',
    });
    return 'MCP TEST ORDER (sandbox)\n' + JSON.stringify(r, null, 2);
  } catch (e) { return `mcp test order failed: ${e.message}`; }
}
// 2026-05-17: interactive Webull 2FA. Spawns `uvx --python 3.12
// webull-openapi-mcp auth` from inside HANK — avoids the SmartScreen
// path operator hits with bare cmd launches. The auth subprocess sends
// a 2FA push to operator's Webull mobile app, blocks waiting for
// approval, writes token to ./webull-mcp-conf/ on success, exits.
// REPL stays blocked during the wait (typically 10-60 sec for operator
// to grab phone + tap approve).
async function answerWebullAuth() {
  const out = ['WEBULL AUTH (interactive 2FA)'];
  out.push('  → Spawning uvx ... auth');
  out.push('  → Webull mobile app will receive a 2FA push within ~5 sec');
  out.push('  → APPROVE on phone; this REPL will wait for completion');
  out.push('');
  let cfg;
  try {
    const m = await import('./webull-mcp-client.js');
    cfg = m.getMcpSpawnConfig();
  } catch (e) { return out.join('\n') + `\n  ✗ failed to import webull-mcp-client: ${e.message}`; }

  const { spawn } = await import('child_process');
  // Swap `serve` arg for `auth` (everything else: --python 3.12, package@version, identical)
  const authArgs = cfg.args.map(a => a === 'serve' ? 'auth' : a);
  out.push(`  command: ${cfg.command} ${authArgs.join(' ')}`);
  out.push('');

  return new Promise((resolve) => {
    const child = spawn(cfg.command, authArgs, { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdoutBuf = '', stderrBuf = '';
    child.stdout.on('data', d => { stdoutBuf += d.toString(); });
    child.stderr.on('data', d => { stderrBuf += d.toString(); });
    child.on('error', err => {
      resolve(out.join('\n') + `\n  ✗ spawn error: ${err.message}\n  (Possible causes: uvx.exe missing/quarantined, SmartScreen block, or Defender)`);
    });
    child.on('close', code => {
      out.push('--- stdout ---');
      out.push(stdoutBuf.trim() || '(empty)');
      if (stderrBuf.trim()) {
        out.push('--- stderr ---');
        out.push(stderrBuf.trim());
      }
      out.push('');
      if (code === 0) {
        out.push(`  ✓ auth subprocess exited 0 — token should be written to ${process.env.WEBULL_TOKEN_DIR || './webull-mcp-conf/'}`);
        out.push(`  Next: run \`webull reconnect\` to refresh MCP connection without restarting HANK`);
      } else {
        out.push(`  ✗ auth subprocess exited ${code} — token NOT written. Read stdout/stderr above for cause.`);
      }
      resolve(out.join('\n'));
    });
  });
}
// 2026-05-17: `webull` (bare) = combined status snapshot
async function answerWebullCombined() {
  const status = await answerMcpStatus();
  const paper  = await answerMcpPaperCheck();
  return [status, '', paper].join('\n');
}
async function answerWebullReconnect() {
  try {
    const { forceReconnect, isPaperVerified, getWebullMCP } = await import('./webull-mcp-client.js');
    const out = ['WEBULL RECONNECT — forcing MCP child restart'];
    const ok = await forceReconnect();
    const mcp = getWebullMCP();
    out.push(`  connected: ${ok ? 'yes' : 'NO (check Window 1 for spawn errors)'}`);
    out.push(`  tools:     ${mcp.availableTools().length}`);
    // Give paper-mode check ~3s to complete before reporting
    await new Promise(r => setTimeout(r, 3000));
    const pv = isPaperVerified();
    out.push(`  paper-mode verified: ${pv === true ? 'YES' : pv === false ? 'NO' : 'still checking…'}`);
    return out.join('\n');
  } catch (e) { return `webull reconnect failed: ${e.message}`; }
}

// 2026-05-18 pre-RTH: circuit breaker REPL controls
async function answerCircuitBreakerStatus() {
  try {
    const { isCircuitBreakerTripped, getCircuitBreakerReason } = await import('./futuresTrading.js');
    const tripped = isCircuitBreakerTripped();
    const reason = getCircuitBreakerReason();
    const out = ['CIRCUIT BREAKER STATUS'];
    out.push(`  tripped         ${tripped ? 'YES' : 'no'}`);
    if (tripped) out.push(`  reason          ${reason}`);
    // Also dump state file if present (cross-process visibility)
    const cbFile = readJsonSafe('circuit-breaker-state.json');
    if (cbFile) {
      out.push(`  state file:`);
      out.push(JSON.stringify(cbFile, null, 2).slice(0, 1500));
    } else {
      out.push(`  state file      (none)`);
    }
    return out.join('\n');
  } catch (e) { return `circuit breaker status failed: ${e.message}`; }
}
async function answerClearCircuitBreaker() {
  try {
    const { clearCircuitBreaker } = await import('./futuresTrading.js');
    clearCircuitBreaker();
    return [
      '✓ Circuit breaker cleared (in-process + state file deleted)',
      '  ⚠ Restart HANK to fully reset across all processes:',
      '     taskkill /F /FI "WINDOWTITLE eq HANK*" & start "" cmd /c start-hank.bat',
    ].join('\n');
  } catch (e) { return `clear circuit breaker failed: ${e.message}`; }
}

async function answerRollGuardTick() {
  try {
    const { tickNow } = await import('./rollGuard.js');
    const state = await tickNow();
    return 'ROLL GUARD STATE\n' + JSON.stringify(state, null, 2).slice(0, 2000);
  } catch (e) { return `roll guard tick failed: ${e.message}`; }
}

// ─── Calibration handlers ──────────────────────────────────
// `calibrate` / `calibration` — read-only stats (cache size, mtime, version).
// `reload calibration` — bypass mtime throttle, force re-read of JSON.
// `rebuild calibration` — spawn analyze-calibration.js NOW (out of schedule).
async function answerCalibration() {
  let getCacheStats;
  try { ({ getCacheStats } = await import('./calibrationCache.js')); }
  catch (e) { return `calibrationCache import failed: ${e.message}`; }
  const s = getCacheStats();
  const out = [
    'CALIBRATION CACHE',
    `  loaded       ${s.loaded ? 'yes' : 'no'}`,
    `  entries      ${s.entries}`,
    `  by level     L1=${s.by_level?.[1] ?? 0}  L2=${s.by_level?.[2] ?? 0}  L3=${s.by_level?.[3] ?? 0}  L4=${s.by_level?.[4] ?? 0}  L5=${s.by_level?.[5] ?? 0}`,
    `  file mtime   ${s.mtime || 'n/a'}`,
    `  last read    ${s.last_read_at || 'n/a'}`,
    `  version      ${s.meta?.version || 'n/a'}`,
    `  trades-in    ${s.meta?.total_trades_after_exclusions ?? 'n/a'}`,
    `  file         ${s.file}`,
  ];
  return out.join('\n');
}
async function answerReloadCalibration() {
  try {
    const { reloadCache, getCacheStats } = await import('./calibrationCache.js');
    const ok = reloadCache();
    const s = getCacheStats();
    return `RELOAD CALIBRATION ${ok ? '✓' : '✗ (file missing or invalid)'}\n  entries=${s.entries}  mtime=${s.mtime || 'n/a'}`;
  } catch (e) { return `reload failed: ${e.message}`; }
}
async function answerRebuildCalibration() {
  try {
    const { rebuildNow } = await import('./calibrationScheduler.js');
    const r = await rebuildNow();
    if (r.ok) return `REBUILD CALIBRATION ✓  cells=${r.cellsCount}  duration=${r.durationMs}ms`;
    return `REBUILD CALIBRATION ✗  code=${r.code}  duration=${r.durationMs}ms\n  ${r.stderr || ''}`;
  } catch (e) { return `rebuild failed: ${e.message}`; }
}

// ─── Kill / flatten handler ────────────────────────────────
// Writes to paper-ledger.json + futures-ledger.json via the canonical
// closePosition / closeFuturesPosition exports (which acquire LOCK_FILE).
// Safe to run concurrently with the live process — the lock serializes.
async function answerKill(symFilter) {
  const matchSym = symFilter ? symFilter.toUpperCase() : null;
  const out = [];
  out.push(matchSym ? `KILL — closing all open ${matchSym} positions` : 'FLATTEN — closing ALL open positions');
  // Late-imported to keep ask.js's cold start cheap when not killing
  let closePosition, blackScholes;
  try { ({ closePosition } = await import('./paperTrading.js')); } catch (e) { out.push(`  ✗ failed to import paperTrading: ${e.message}`); }
  // futuresTrading.js retired 2026-05-17 — futures now via MCP (handled below)
  try { ({ blackScholes } = await import('./theta.js')); } catch {}

  const prices  = readJsonSafe('latest-prices.json') || {};
  const theta   = readJsonSafe('portfolio-theta.json') || {};
  const thetaPos = Array.isArray(theta.positions) ? theta.positions : [];
  const thetaByReq = new Map();
  for (const p of thetaPos) if (p.requestId) thetaByReq.set(p.requestId, p);

  // ── Options leg (paper-ledger.json) ─────────────────────
  const paper = readJsonSafe('paper-ledger.json');
  const openPaper = paper?.trades?.filter(t => t.status === 'OPEN' && (!matchSym || t.instrument === matchSym)) ?? [];

  let killedPaper = 0, paperPnL = 0;
  for (const t of openPaper) {
    let exitPrice = null;
    const tp = thetaByReq.get(t.requestId);
    if (tp && Number.isFinite(tp.currentEstOption)) exitPrice = tp.currentEstOption;
    if (exitPrice == null && blackScholes && prices[t.instrument]?.last && t.strike && t.entryIV) {
      try {
        const T = Math.max(0.5/24/365, (t.expiry ? (new Date(t.expiry).getTime() - Date.now()) : 4*3600*1000) / (365*24*3600*1000));
        exitPrice = blackScholes(prices[t.instrument].last, t.strike, T, t.entryIV, 0.05, t.type === 'put' ? 'put' : 'call');
      } catch {}
    }
    if (exitPrice == null) exitPrice = t.fillPrice;  // last-resort: 0 P&L close
    if (!closePosition) { out.push(`  ✗ ${t.instrument} ${t.signal} ${t.engine} — closePosition unavailable`); continue; }
    try {
      const closed = closePosition(t.requestId, exitPrice, 'MANUAL_KILL');
      if (closed) {
        killedPaper++;
        paperPnL += closed.pnl ?? 0;
        out.push(`  ✓ ${pad(t.instrument, 4)} ${pad(t.signal, 5)} ${pad(t.engine, 9)} exit ${fmtPrice(exitPrice)}  pnl ${fmtMoney(closed.pnl ?? 0)}`);
      } else {
        out.push(`  · ${t.instrument} ${t.signal} ${t.engine} — already closed (race)`);
      }
    } catch (e) {
      out.push(`  ✗ ${t.instrument} ${t.signal} ${t.engine} — ${e.message}`);
    }
  }

  // ── Futures + MCP-side positions (post Path 2 retirement 2026-05-17) ──
  // Path 2 futures-ledger.json removed; futures (and any MCP-tracked
  // positions) now flow through Webull MCP. Enumerate via
  // get_account_positions + close via cancel_order / opposing market order.
  let killedMCP = 0, mcpPnL = 0;
  try {
    const { getWebullMCP } = await import('./webull-mcp-client.js');
    const mcp = getWebullMCP();
    if (!mcp || !mcp.isConnected()) {
      out.push('  ⚠ MCP not connected — skipping MCP-side kill');
    } else {
      // Cancel any working orders first
      try {
        const openOrders = await mcp.getOpenOrders({});
        const orders = openOrders?.orders || openOrders?.data || [];
        for (const ord of orders) {
          if (matchSym && ord.symbol && ord.symbol.toUpperCase() !== matchSym) continue;
          try {
            await mcp.cancelOrder(ord.order_id);
            out.push(`  ✓ MCP cancel order ${ord.order_id}  ${ord.symbol || '?'}`);
          } catch (e) {
            out.push(`  ✗ MCP cancel ${ord.order_id} — ${e.message}`);
          }
        }
      } catch (e) {
        out.push(`  ✗ getOpenOrders — ${e.message}`);
      }
      // Close open positions via opposing market order
      try {
        const posResp = await mcp.getAccountPositions({});
        const positions = posResp?.positions || posResp?.data || [];
        for (const p of positions) {
          const psym = (p.symbol || p.instrument || '').toUpperCase();
          if (matchSym && psym !== matchSym) continue;
          const qty = Math.abs(p.quantity || p.qty || 0);
          if (qty === 0) continue;
          const oppositeSide = (p.quantity || p.qty) > 0 ? 'SELL' : 'BUY';
          try {
            // For now use the futures/option order path; refined Tue 5/19
            const closeResult = await mcp._callTool('place_stock_order', {
              symbol: psym, side: oppositeSide, order_type: 'MARKET', quantity: qty,
            }).catch(() => null);
            if (closeResult) {
              killedMCP++;
              const realized = closeResult?.realized_pnl ?? 0;
              mcpPnL += realized;
              out.push(`  ✓ MCP close ${pad(psym, 6)} ${qty}c (${oppositeSide})  realized ${fmtMoney(realized)}`);
            } else {
              out.push(`  ⚠ MCP close ${psym} returned null — may need manual review`);
            }
          } catch (e) {
            out.push(`  ✗ MCP close ${psym} — ${e.message}`);
          }
        }
      } catch (e) {
        out.push(`  ✗ getAccountPositions — ${e.message}`);
      }
    }
  } catch (e) {
    out.push(`  ✗ webull-mcp-client import failed — ${e.message}`);
  }

  if (killedPaper === 0 && killedMCP === 0) {
    out.push('  No matching open positions.');
  } else {
    out.push('', `KILLED  ${killedPaper} paper-options + ${killedMCP} MCP-positions   realized ${fmtMoney(paperPnL + mcpPnL)}`);
  }
  return out.join('\n');
}

// ─── Public router ──────────────────────────────────────
// Async because `kill` / `flatten` mutate ledgers via dynamic imports. All
// non-kill handlers stay sync; the async wrapper just lets the router
// await answerKill when the command requires it.
export async function answerQuestion(text) {
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

  // Kill / flatten — WRITE commands, handled first so symbol-routing doesn't swallow them
  if (/^(kill|flatten)\b/.test(lo) || /\b(flatten)\b/.test(lo)) {
    return answerKill(sym);
  }
  // Calibration commands (must come before generic symbol-routing)
  if (/^rebuild\s+calibration\b/.test(lo))    return answerRebuildCalibration();
  if (/^reload\s+calibration\b/.test(lo))     return answerReloadCalibration();
  if (/^(calibrate|calibration)\b/.test(lo))  return answerCalibration();
  // MCP commands (also before symbol routing)
  if (/^mcp\s+test\s+order\b/.test(lo))       return answerMcpTestOrder();
  if (/^mcp\s+accounts?\b/.test(lo))          return answerMcpAccounts();
  if (/^mcp\s+positions?\b/.test(lo))         return answerMcpPositions();
  if (/^mcp\s+paper(-check)?\b/.test(lo))     return answerMcpPaperCheck();
  if (/^mcp\s+status\b/.test(lo))             return answerMcpStatus();
  if (/^webull\s+auth\b/.test(lo))            return answerWebullAuth();
  if (/^webull\s+reconnect\b/.test(lo))       return answerWebullReconnect();
  if (/^webull\s+paper\b/.test(lo))           return answerMcpPaperCheck();
  if (/^webull\b/.test(lo))                   return answerWebullCombined();
  if (/^roll\s+guard\s+tick\b/.test(lo))      return answerRollGuardTick();
  if (/^clear\s+circuit\s+breaker\b/.test(lo)) return answerClearCircuitBreaker();
  if (/^circuit\s+breaker\b/.test(lo))        return answerCircuitBreakerStatus();

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
