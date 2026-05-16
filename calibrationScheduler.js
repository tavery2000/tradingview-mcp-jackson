/**
 * calibrationScheduler.js — daily rebuild of calibration-lookup.json
 *
 * Phase 1 Additional A (2026-05-16): cron-like trigger at 16:30 ET Mon-Fri.
 * Spawns `node analyze-calibration.js` as a child process so the analyzer
 * runs in isolation (separate memory, separate failure domain). On success,
 * writes a CALIBRATION_REBUILT journal record + bumps the in-memory cache
 * via calibrationCache.reloadCache().
 *
 * Idempotent — tracks last-fired ET date in calibration-scheduler-state.json
 * so multiple ticks within the trigger minute don't re-run.
 *
 * Started from webhook-server.js at server.listen() (parallel to
 * preSwitchKill scheduler). Polls every 30s; cheap because the only
 * per-tick work is an ET-time compare.
 *
 * Env:
 *   CALIBRATION_REBUILD_ENABLED   (default true)
 *   CALIBRATION_REBUILD_ET        HH:MM, default 16:30
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { jAlert, jError } from './journal.js';
import { reloadCache } from './calibrationCache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE   = join(__dirname, 'calibration-scheduler-state.json');
const ANALYZER     = join(__dirname, 'analyze-calibration.js');

const ENABLED = (process.env.CALIBRATION_REBUILD_ENABLED || 'true').toLowerCase() === 'true';
function _parseHHMM(s, fallback) {
  if (!s) return fallback;
  const [h, m] = String(s).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return fallback;
  return h * 60 + m;
}
const REBUILD_MINS = _parseHHMM(process.env.CALIBRATION_REBUILD_ET, 16 * 60 + 30);

function _getETDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}
function _getETMins() {
  const t = new Date().toLocaleTimeString('en-US', { timeZone:'America/New_York', hour12:false, hour:'2-digit', minute:'2-digit' });
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function _getDOW() {
  const s = new Date().toLocaleDateString('en-US', { timeZone:'America/New_York', weekday: 'short' });
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[s];
}

function _loadState() {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {}
  return { lastFired: null, lastFiredAt: null };
}
function _saveState(s) { try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {} }

let _started = false;

function _runAnalyzer() {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(process.execPath, [ANALYZER], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      resolve({ code, durationMs: Date.now() - start, stdout, stderr });
    });
    child.on('error', err => {
      resolve({ code: -1, durationMs: Date.now() - start, stdout, stderr: err.message });
    });
  });
}

async function _tick() {
  if (!ENABLED) return;
  const today = _getETDate();
  const mins  = _getETMins();
  const dow   = _getDOW();

  // Mon-Fri only
  if (dow < 1 || dow > 5) return;
  // Within the trigger minute
  if (mins < REBUILD_MINS || mins >= REBUILD_MINS + 5) return;

  const s = _loadState();
  if (s.lastFired === today) return;            // already fired today

  s.lastFired = today;
  s.lastFiredAt = new Date().toISOString();
  s.running = true;
  _saveState(s);

  console.log(`  [calibrationScheduler] FIRE — running analyzer at ${new Date().toISOString()}`);
  const result = await _runAnalyzer();

  // Pull cells_count from the new JSON if it exists
  let cellsCount = null;
  try {
    const json = JSON.parse(readFileSync(join(__dirname, 'data', 'calibration-lookup.json'), 'utf8'));
    cellsCount = (json.cells || []).length;
  } catch {}

  s.running = false;
  s.lastResult = { code: result.code, durationMs: result.durationMs, cellsCount };
  _saveState(s);

  if (result.code === 0) {
    try { reloadCache(); } catch {}
    try { jAlert('info', 'CALIBRATION_REBUILT', { date: today, cellsCount, durationMs: result.durationMs }); } catch {}
    console.log(`  [calibrationScheduler] OK — cells=${cellsCount}, ${result.durationMs}ms`);
  } else {
    try { jError('CALIBRATION', 'rebuild-failed', { date: today, code: result.code, stderr: result.stderr.slice(0, 500) }); } catch {}
    console.log(`  [calibrationScheduler] FAILED code=${result.code} — ${result.stderr.slice(0, 200)}`);
  }
}

export function startCalibrationScheduler() {
  if (!ENABLED || _started) return false;
  _started = true;
  const hh = String(Math.floor(REBUILD_MINS / 60)).padStart(2, '0');
  const mm = String(REBUILD_MINS % 60).padStart(2, '0');
  console.log(`  [calibrationScheduler] ARMED — daily rebuild at ${hh}:${mm} ET Mon-Fri`);
  const TICK_MS = 30_000;
  const interval = setInterval(_tick, TICK_MS);
  if (interval.unref) interval.unref();
  _tick();
  return true;
}

/** Test hook — run the analyzer immediately, bypassing schedule. */
export async function rebuildNow() {
  console.log(`  [calibrationScheduler] manual rebuild requested`);
  const result = await _runAnalyzer();
  if (result.code === 0) {
    try { reloadCache(); } catch {}
    let cellsCount = null;
    try {
      const json = JSON.parse(readFileSync(join(__dirname, 'data', 'calibration-lookup.json'), 'utf8'));
      cellsCount = (json.cells || []).length;
    } catch {}
    try { jAlert('info', 'CALIBRATION_REBUILT', { manual: true, cellsCount, durationMs: result.durationMs }); } catch {}
    return { ok: true, cellsCount, durationMs: result.durationMs };
  }
  try { jError('CALIBRATION', 'rebuild-failed', { manual: true, code: result.code, stderr: result.stderr.slice(0, 500) }); } catch {}
  return { ok: false, code: result.code, stderr: result.stderr.slice(0, 500), durationMs: result.durationMs };
}
