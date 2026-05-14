/**
 * heartbeat.js — per-process liveness signal
 *
 * Each long-running monitor calls startHeartbeat(name) at startup. The
 * heartbeat writes logs/heartbeat-{name}.json every 30s with timestamp
 * + pid. dashboard-server.js polls these files via /api/heartbeats and
 * the dashboard alerts the operator if any heartbeat is stale > 60s
 * (configurable via HEARTBEAT_STALE_MS env var).
 *
 * Background: 2026-05-14 — theta-monitor.js and monitor-iwm.js died
 * silently mid-session with zero operator visibility. Heartbeats give
 * the operator + dashboard a way to detect process death even when the
 * supervisor's restart hasn't completed yet OR the supervisor itself
 * isn't running (legacy launch via raw `node monitor.js`).
 *
 * Usage:
 *   import { startHeartbeat } from './heartbeat.js';
 *   startHeartbeat('monitor.js');   // or monitor-qqq.js, theta-monitor.js, etc.
 *
 * Stop:
 *   The heartbeat keeps writing while the process is alive. On clean
 *   exit, optional stopHeartbeat() removes the file so the dashboard
 *   doesn't show a phantom-stale signal.
 */

import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const HEARTBEAT_INTERVAL_MS = 30_000;
const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, 'logs');

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

const _activeHeartbeats = new Map();   // name -> { interval, file }

export function startHeartbeat(name, intervalMs = HEARTBEAT_INTERVAL_MS) {
  if (_activeHeartbeats.has(name)) return;   // idempotent — guard against double-start

  const file = join(LOG_DIR, `heartbeat-${name}.json`);

  const writeBeat = () => {
    try {
      writeFileSync(file, JSON.stringify({
        name,
        pid: process.pid,
        ts: Date.now(),
        et: new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false }),
        intervalMs,
      }));
    } catch {}
  };

  // First beat immediately at startup
  writeBeat();

  const interval = setInterval(writeBeat, intervalMs);
  // Don't keep the event loop alive solely on the heartbeat
  if (interval.unref) interval.unref();

  _activeHeartbeats.set(name, { interval, file });

  // Clean up on exit
  process.on('exit', () => {
    try { if (existsSync(file)) unlinkSync(file); } catch {}
  });
}

export function stopHeartbeat(name) {
  const h = _activeHeartbeats.get(name);
  if (!h) return;
  clearInterval(h.interval);
  try { if (existsSync(h.file)) unlinkSync(h.file); } catch {}
  _activeHeartbeats.delete(name);
}
