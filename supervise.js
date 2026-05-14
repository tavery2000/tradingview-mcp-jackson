#!/usr/bin/env node
/**
 * supervise.js — generic auto-restart wrapper for any node script
 *
 * Usage:  node supervise.js <script.js> [name-tag]
 *
 * Background: today (2026-05-14) theta-monitor.js and monitor-iwm.js
 * died silently mid-session with no restart. The webhook-supervisor.js
 * pattern works well for the webhook; this generalizes it so every
 * monitor process can run under supervision.
 *
 * Behavior:
 *   - Spawns the target script as a child process
 *   - Pipes stdout + stderr to this terminal (operator sees output)
 *   - On child death: logs cause to logs/supervise-<name>.log, restarts
 *     after BACKOFF_MS (default 2s)
 *   - SIGINT to supervisor → kills child cleanly, exits
 *
 * Heartbeat support: target scripts can call startHeartbeat() from
 * heartbeat.js to publish a per-process liveness signal. The supervisor
 * itself doesn't enforce heartbeats — that's the dashboard's job to alert
 * on. Supervisor's job is restart-on-exit only.
 *
 * Stop:
 *   Ctrl+C in supervisor terminal. Child receives SIGTERM, then exit.
 */

import { spawn }                                          from 'child_process';
import { existsSync, mkdirSync, appendFileSync }         from 'fs';
import { join, dirname, basename }                        from 'path';
import { fileURLToPath }                                  from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR   = join(__dirname, 'logs');
const BACKOFF_MS = 2000;
const STDERR_RING_SIZE = 20;

const targetScript = process.argv[2];
if (!targetScript) {
  console.error('Usage: node supervise.js <script.js> [name-tag]');
  process.exit(1);
}
const nameTag = process.argv[3] || basename(targetScript, '.js');
const LOG_FILE = join(LOG_DIR, `supervise-${nameTag}.log`);

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

function nowET() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function log(msg) {
  const line = `[${nowET()} ET] ${msg}\n`;
  process.stdout.write(line);
  try { appendFileSync(LOG_FILE, line); } catch {}
}

let restartCount        = 0;
let lastDeathTs         = null;
let stoppingDueToSignal = false;
let currentChild        = null;

function spawnChild() {
  const child = spawn('node', [targetScript], {
    cwd:    __dirname,
    stdio:  ['ignore', 'pipe', 'pipe'],
    env:    { ...process.env, FORCE_COLOR: '1' },
  });

  currentChild = child;
  const stderrRing = [];

  child.stdout.on('data', chunk => process.stdout.write(chunk));

  child.stderr.on('data', chunk => {
    process.stderr.write(chunk);
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      stderrRing.push(line);
      if (stderrRing.length > STDERR_RING_SIZE) stderrRing.shift();
    }
  });

  child.on('exit', (code, signal) => {
    currentChild = null;

    if (stoppingDueToSignal) {
      log(`${targetScript} stopped by supervisor — clean exit.`);
      process.exit(0);
    }

    restartCount++;
    const sinceLast = lastDeathTs
      ? `${Math.round((Date.now() - lastDeathTs) / 1000)}s since last death`
      : 'first death this session';
    lastDeathTs = Date.now();

    log(`⚠ ${targetScript} DIED — exit_code=${code} signal=${signal} restart#${restartCount} (${sinceLast})`);
    if (stderrRing.length) {
      log(`  Last stderr captured before death:`);
      for (const l of stderrRing) log(`    ${l}`);
    } else {
      log(`  No stderr captured — process exited without writing to stderr.`);
    }

    log(`  Restarting in ${BACKOFF_MS}ms...`);
    setTimeout(spawnChild, BACKOFF_MS);
  });

  child.on('error', err => {
    log(`⚠ Failed to spawn child: ${err.message}`);
  });
}

function shutdown(signal) {
  if (stoppingDueToSignal) return;
  stoppingDueToSignal = true;
  log(`Supervisor received ${signal} — shutting down child gracefully...`);
  if (currentChild) {
    try { currentChild.kill('SIGTERM'); }
    catch (e) { log(`  Could not kill child: ${e.message}`); }
  }
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

log(`supervise.js started — supervising ${targetScript} (tag: ${nameTag})`);
log(`  Log file: ${LOG_FILE}`);
log(`  Backoff:  ${BACKOFF_MS}ms between restarts`);
log(`  Stop:     Ctrl+C (child shut down cleanly first)`);
log('');
spawnChild();
