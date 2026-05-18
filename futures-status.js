/**
 * futures-status.js — Window 8 read-only futures dashboard
 *
 * 2026-05-15 Task: thin status window for futures positions. Pure-read:
 * reads futures-ledger.json + latest-prices.json on a timer and renders an
 * always-current table to stdout. Does NOT import futuresTrading.js (that
 * module's setInterval lives inside webhook-server.js); double-importing
 * here would spin up a duplicate eval loop on a separate ledger snapshot.
 *
 * Mirrors the FUTURES dashboard tab panel built in hank-electron-r3.html —
 * gives the operator a terminal-side view that's separate from the busy
 * webhook console.
 *
 * Run:   node supervise.js futures-status.js
 *        (or:  node futures-status.js  for one-off)
 *
 * Env:
 *   FUT_STATUS_REFRESH_MS  refresh interval (default 2000ms)
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEDGER  = join(__dirname, 'futures-ledger.json');
const PRICES  = join(__dirname, 'latest-prices.json');
const REFRESH_MS = parseInt(process.env.FUT_STATUS_REFRESH_MS || '2000', 10);

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', gray: '\x1b[90m', white: '\x1b[97m',
};

function safeJson(file) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; }
  catch { return null; }
}

function getETString() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
}
function getETDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function pad(s, n, side = 'right') {
  s = String(s ?? '');
  if (s.length >= n) return s.slice(0, n);
  const fill = ' '.repeat(n - s.length);
  return side === 'left' ? fill + s : s + fill;
}

function fmtMoney(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function colorMoney(n) {
  if (!Number.isFinite(n)) return C.gray + '—' + C.reset;
  return (n >= 0 ? C.green : C.red) + fmtMoney(n) + C.reset;
}

function render() {
  // Clear screen + move cursor home
  process.stdout.write('\x1b[2J\x1b[H');

  const ledger = safeJson(LEDGER);
  const prices = safeJson(PRICES) || {};
  const today  = getETDate();
  const etTime = getETString();

  console.log(`${C.bold}${C.cyan}◆ HANK FUTURES STATUS${C.reset}   ${C.gray}${etTime} ET · refresh ${REFRESH_MS}ms${C.reset}`);
  // 2026-05-18: circuit breaker cooldown banner
  const cb = safeJson(join(__dirname, 'circuit-breaker-state.json'));
  if (cb && cb.tripped) {
    if (cb.hardHalt) {
      console.log(`${C.red}${C.bold}  ⛔ CIRCUIT BREAKER HARD HALT${C.reset}  ${C.gray}${cb.reason} · ${cb.tripsInWindow} trips · operator REPL clear required${C.reset}`);
    } else {
      const trippedTs = cb.trippedAt ? new Date(cb.trippedAt).getTime() : 0;
      const elapsedMin = trippedTs ? (Date.now() - trippedTs) / 60_000 : 0;
      const remainingMin = Math.max(0, Math.ceil((cb.cooldownMin || 30) - elapsedMin));
      console.log(`${C.yellow}  ⏱ CIRCUIT BREAKER COOLDOWN${C.reset}  ${C.gray}${cb.reason} · resume in ${remainingMin}min${C.reset}`);
    }
  }
  console.log(C.gray + '─'.repeat(110) + C.reset);

  if (!ledger) {
    console.log(`${C.yellow}futures-ledger.json not found — webhook-server.js may not have started yet${C.reset}`);
    return;
  }

  // ── Header line: balance / day P&L / total stats ──
  const dayPnL = ledger.dailyPnL?.[today] || 0;
  const dayPnLStr = (dayPnL >= 0 ? C.green : C.red) + fmtMoney(dayPnL) + C.reset;
  console.log(
    `  ${C.dim}BALANCE${C.reset} ${C.white}$${(ledger.balance || 0).toFixed(2)}${C.reset}` +
    `   ${C.dim}DAY${C.reset} ${dayPnLStr}` +
    `   ${C.dim}TOTAL${C.reset} ${colorMoney(ledger.totalPnL || 0)}` +
    `   ${C.dim}TRADES${C.reset} ${ledger.totalTrades ?? (ledger.trades?.length ?? 0)}` +
    `   ${C.dim}W/L${C.reset} ${ledger.wins ?? 0}/${ledger.losses ?? 0}`
  );

  // ── Live prices line ──
  const priceCells = ['ES1!', 'NQ1!', 'MES1!', 'MNQ1!'].map(sym => {
    const p = prices[sym]?.last;
    const ageS = prices[sym]?.ts ? Math.floor((Date.now() - prices[sym].ts) / 1000) : null;
    if (!Number.isFinite(p)) return `${C.dim}${sym}=—${C.reset}`;
    const ageMark = ageS == null ? '' : ageS > 60 ? C.red + `(${ageS}s)` + C.reset : C.gray + `(${ageS}s)` + C.reset;
    return `${C.dim}${sym}${C.reset} ${C.cyan}${p.toLocaleString()}${C.reset} ${ageMark}`;
  });
  console.log('  ' + priceCells.join('   '));
  console.log(C.gray + '─'.repeat(110) + C.reset);

  // ── Open positions ──
  const open = (ledger.trades || []).filter(t => t.status === 'OPEN');
  if (!open.length) {
    console.log(`  ${C.gray}No open futures positions.${C.reset}`);
  } else {
    console.log(
      `  ${C.bold}${pad('TIME', 8)} ${pad('INST', 6)} ${pad('DIR', 5)} ${pad('ENG', 5)} ${pad('TIER', 4)} ` +
      `${pad('Cs', 3, 'left')} ${pad('ENTRY', 10, 'left')} ${pad('LIVE', 10, 'left')} ` +
      `${pad('STOP', 10, 'left')} ${pad('TARGET', 10, 'left')} ${pad('uPnL', 12, 'left')} ${pad('STAGE', 18)}${C.reset}`
    );
    for (const t of open) {
      const live = prices[t.instrument]?.last;
      const dirMult = t.signal === 'CALLS' ? 1 : -1;
      const uPnL = Number.isFinite(live)
        ? (live - t.entryPrice) * dirMult * (t.pointValue || 0) * (t.contracts || 0)
        : null;
      const dirColor = t.signal === 'CALLS' ? C.green : C.red;
      console.log(
        `  ${pad(t.fillTimeET || '—', 8)} ${pad(t.instrument, 6)} ${dirColor}${pad(t.signal, 5)}${C.reset} ` +
        `${pad(t.engine || '—', 5)} ${pad(t.tier || '—', 4)} ${pad(t.contracts ?? '—', 3, 'left')} ` +
        `${pad((t.entryPrice ?? 0).toLocaleString(), 10, 'left')} ` +
        `${pad(Number.isFinite(live) ? live.toLocaleString() : '—', 10, 'left')} ` +
        `${pad((t.stopPrice ?? 0).toLocaleString(), 10, 'left')} ` +
        `${pad((t.targetPrice ?? 0).toLocaleString(), 10, 'left')} ` +
        `${pad(uPnL == null ? '—' : (uPnL >= 0 ? C.green : C.red) + fmtMoney(uPnL) + C.reset, 12, 'left')} ` +
        `${pad(t.stage || '—', 18)}`
      );
    }
  }
  console.log(C.gray + '─'.repeat(110) + C.reset);

  // ── Recent closes today ──
  const closedToday = (ledger.trades || [])
    .filter(t => t.status === 'CLOSED' && t.exitTimeET && t.fillTime
      && new Date(t.fillTime).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === today)
    .slice(-5);
  if (closedToday.length) {
    console.log(`  ${C.dim}Last ${closedToday.length} closed today:${C.reset}`);
    for (const t of closedToday) {
      const pnl = t.pnl ?? 0;
      console.log(
        `    ${C.gray}[${t.exitTimeET}]${C.reset} ${pad(t.instrument, 6)} ${pad(t.signal, 5)} ` +
        `${pad(t.engine || '—', 5)} ${pad(t.exitReason || '—', 18)} ${colorMoney(pnl)}`
      );
    }
  } else {
    console.log(`  ${C.gray}No closed futures trades today.${C.reset}`);
  }

  console.log(C.gray + '\n  (read-only — Ctrl+C to exit)' + C.reset);
}

console.log(`${C.cyan}◆ HANK FUTURES STATUS${C.reset} starting · ledger=${LEDGER} · prices=${PRICES}\n`);
render();
const _t = setInterval(render, REFRESH_MS);

process.on('SIGINT', () => {
  clearInterval(_t);
  process.stdout.write('\x1b[2J\x1b[H');
  console.log(`${C.gray}futures-status stopped.${C.reset}`);
  process.exit(0);
});
