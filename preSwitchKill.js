/**
 * preSwitchKill.js — Task 7 (2026-05-15)
 *
 * Pre-12:00-ET-timeframe-switch defense. Operator's hypothesis: positions
 * opened on 1m structure get disrupted by the 5m bar regime change at noon.
 * Mechanism:
 *
 *   11:55 ET  → fire WARNING (banner + TTS): "Time interval switch in 5min.
 *               Auto-kill at 11:58 ET."
 *   11:58 ET  → fire KILL_ALL (close every open paper + futures position)
 *   11:58–12:02 ET → trading PAUSED (new entries blocked)
 *   12:00 ET  → (Task 8) auto-timeframe switch fires on charts
 *   12:02 ET  → trading resumes
 *
 * Two surfaces:
 *
 *   startPreSwitchScheduler() — call once at startup from a long-running
 *       process (webhook-server.js, monitor.js). Polls every 30s and fires
 *       warning/kill/resume on first crossing of each threshold per ET day.
 *
 *   isTradingPaused() — sync helper for entry-gate callers (paperTrading.
 *       sendOrder, futuresTrading.placeFuturesOrder). Returns
 *       { paused: bool, reason: string|null }.
 *
 * State persists in pre-switch-kill-state.json — date + which transitions
 * have fired today + active pause window. Resets per ET-date.
 *
 * .env (defaults match operator directive):
 *   AUTO_KILL_BEFORE_SWITCH=true
 *   AUTO_KILL_WARNING_ET=11:55
 *   AUTO_KILL_EXECUTE_ET=11:58
 *   TRADING_RESUME_ET=12:02
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { jAlert } from './journal.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, 'pre-switch-kill-state.json');

const ENABLED = (process.env.AUTO_KILL_BEFORE_SWITCH || 'true').toLowerCase() === 'true';

function _parseHHMM(s, fallback) {
  if (!s) return fallback;
  const [h, m] = String(s).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return fallback;
  return h * 60 + m;
}
const WARNING_MINS = _parseHHMM(process.env.AUTO_KILL_WARNING_ET, 11 * 60 + 55);
const EXECUTE_MINS = _parseHHMM(process.env.AUTO_KILL_EXECUTE_ET, 11 * 60 + 58);
const RESUME_MINS  = _parseHHMM(process.env.TRADING_RESUME_ET,   12 * 60 +  2);

function getETDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}
function getETMins() {
  const t = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function getETString() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
}

function _emptyState(date) {
  return {
    date,
    warningFired: false,
    killFired: false,
    pauseUntilMins: null,
    killSummary: null,
  };
}

function _loadState() {
  const today = getETDate();
  try {
    if (!existsSync(STATE_FILE)) return _emptyState(today);
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (s.date !== today) return _emptyState(today);
    return s;
  } catch {
    return _emptyState(today);
  }
}

function _saveState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

function _wsBroadcast(payload) {
  if (typeof global.wsBroadcast === 'function') {
    try { global.wsBroadcast(payload); } catch {}
  }
}

async function _killAllPositions() {
  // Late-imported so this module is loadable from contexts that don't have
  // paperTrading.js bootstrapped (e.g., bare unit tests).
  let closePosition = null, closeFuturesPosition = null;
  try { ({ closePosition } = await import('./paperTrading.js')); } catch {}
  try { ({ closeFuturesPosition } = await import('./futuresTrading.js')); } catch {}

  const prices = (() => {
    try { return JSON.parse(readFileSync(join(__dirname, 'latest-prices.json'), 'utf8')); } catch { return {}; }
  })();

  let killedPaper = 0, killedFut = 0, totalPnL = 0;
  const errors = [];

  // ── Options leg ──
  try {
    const p = JSON.parse(readFileSync(join(__dirname, 'paper-ledger.json'), 'utf8'));
    const open = (p.trades || []).filter(t => t.status === 'OPEN');
    for (const t of open) {
      let exitPrice = t.fillPrice;  // safe fallback
      const live = prices[t.instrument]?.last;
      // Crude BS-free fallback: assume premium ≈ fillPrice if no theta cached.
      // The kill-at-fillPrice ≈ $0 P&L is acceptable for a defensive close.
      if (Number.isFinite(live)) {
        // For deep ITM puts/calls a better estimate exists in theta cache, but
        // we don't reach for blackScholes here to keep the module self-contained.
      }
      if (!closePosition) { errors.push(`paperTrading import failed`); break; }
      try {
        const closed = closePosition(t.requestId, exitPrice, 'PRE_SWITCH_KILL');
        if (closed) { killedPaper++; totalPnL += closed.pnl ?? 0; }
      } catch (e) { errors.push(`${t.instrument} ${t.signal}: ${e.message}`); }
    }
  } catch (e) { errors.push(`paper-ledger read: ${e.message}`); }

  // ── Futures leg ──
  try {
    const f = JSON.parse(readFileSync(join(__dirname, 'futures-ledger.json'), 'utf8'));
    const open = (f.trades || []).filter(t => t.status === 'OPEN');
    for (const t of open) {
      const live = prices[t.instrument]?.last;
      const exitPrice = Number.isFinite(live) ? live : t.entryPrice;
      if (!closeFuturesPosition) { errors.push(`futuresTrading import failed`); break; }
      try {
        const closed = closeFuturesPosition(t.requestId, exitPrice, 'PRE_SWITCH_KILL');
        if (closed) { killedFut++; totalPnL += closed.pnl ?? 0; }
      } catch (e) { errors.push(`${t.instrument} ${t.signal}: ${e.message}`); }
    }
  } catch (e) { errors.push(`futures-ledger read: ${e.message}`); }

  return { killedPaper, killedFut, totalPnL, errors };
}

function _fireWarning() {
  const message = `PRE_SWITCH_WARNING — auto-kill at ${Math.floor(EXECUTE_MINS/60)}:${String(EXECUTE_MINS%60).padStart(2,'0')} ET, ${EXECUTE_MINS - WARNING_MINS} min from now`;
  try { jAlert('warning', 'PRE_SWITCH_WARNING', { warningET: `${Math.floor(WARNING_MINS/60)}:${String(WARNING_MINS%60).padStart(2,'0')}`, executeET: `${Math.floor(EXECUTE_MINS/60)}:${String(EXECUTE_MINS%60).padStart(2,'0')}` }); } catch {}
  _wsBroadcast({ type: 'warning', payload: { kind: 'PRE_SWITCH_WARNING', message, executeMins: EXECUTE_MINS, resumeMins: RESUME_MINS } });
  console.log(`\n  ⚠ ${message}`);
}

async function _fireKill() {
  const result = await _killAllPositions();
  const message = `PRE_SWITCH_KILL — closed ${result.killedPaper} options + ${result.killedFut} futures, realized $${result.totalPnL.toFixed(2)}; trading paused until ${Math.floor(RESUME_MINS/60)}:${String(RESUME_MINS%60).padStart(2,'0')} ET`;
  try { jAlert('critical', 'PRE_SWITCH_KILL', { ...result, executedAtET: getETString() }); } catch {}
  _wsBroadcast({ type: 'critical', payload: { kind: 'PRE_SWITCH_KILL', ...result, message } });
  console.log(`\n  🛑 ${message}`);
  if (result.errors.length) console.log(`     errors: ${result.errors.join(' | ')}`);
  return result;
}

let _schedulerStarted = false;

/**
 * Start the 30s scheduler. Idempotent — safe to call multiple times.
 * Returns true if started, false if already running or disabled.
 */
export function startPreSwitchScheduler() {
  if (!ENABLED) return false;
  if (_schedulerStarted) return false;
  _schedulerStarted = true;
  console.log(`  [preSwitchKill] scheduler ARMED — warning ${Math.floor(WARNING_MINS/60)}:${String(WARNING_MINS%60).padStart(2,'0')} ET, kill ${Math.floor(EXECUTE_MINS/60)}:${String(EXECUTE_MINS%60).padStart(2,'0')} ET, resume ${Math.floor(RESUME_MINS/60)}:${String(RESUME_MINS%60).padStart(2,'0')} ET`);
  const TICK_MS = 30_000;
  const interval = setInterval(_tick, TICK_MS);
  if (interval.unref) interval.unref();
  _tick();  // immediate tick at startup
  return true;
}

async function _tick() {
  if (!ENABLED) return;
  const s = _loadState();
  const mins = getETMins();

  if (!s.warningFired && mins >= WARNING_MINS && mins < EXECUTE_MINS) {
    _fireWarning();
    s.warningFired = true;
    _saveState(s);
  }
  if (!s.killFired && mins >= EXECUTE_MINS && mins < RESUME_MINS) {
    s.killFired = true;
    s.pauseUntilMins = RESUME_MINS;
    _saveState(s);   // save BEFORE the async kill so isTradingPaused() sees the pause
    const result = await _fireKill();
    s.killSummary = { ...result, executedAtET: getETString() };
    _saveState(s);
  }
  if (s.pauseUntilMins != null && mins >= s.pauseUntilMins) {
    s.pauseUntilMins = null;
    _saveState(s);
    console.log(`  [preSwitchKill] trading RESUMED at ${getETString()} ET`);
    _wsBroadcast({ type: 'info', payload: { kind: 'PRE_SWITCH_RESUME', resumeAtET: getETString() } });
  }
}

/**
 * Sync check for entry gates. Returns {paused, reason}. Reads state file
 * each call (cheap — small JSON), so it reflects the most recent scheduler
 * tick even if isTradingPaused is called from a different process.
 */
export function isTradingPaused() {
  if (!ENABLED) return { paused: false, reason: null };
  const s = _loadState();
  if (s.pauseUntilMins == null) return { paused: false, reason: null };
  const mins = getETMins();
  if (mins >= s.pauseUntilMins) return { paused: false, reason: null };
  const remaining = s.pauseUntilMins - mins;
  return {
    paused: true,
    reason: `PRE_SWITCH_PAUSE (auto-kill at ${Math.floor(EXECUTE_MINS/60)}:${String(EXECUTE_MINS%60).padStart(2,'0')}, resumes in ${remaining}min)`,
  };
}
