#!/usr/bin/env node
/**
 * webhook-supervisor.js — auto-restart wrapper for webhook-server.js
 *
 * Background: webhook-server.js has died twice on 2026-05-12, each time
 * causing multi-minute outages of the autonomous trade pipeline. This
 * supervisor watches the process and restarts it within seconds of any
 * death, capturing exit code / signal / last stderr lines for diagnosis.
 *
 * Usage:  node webhook-supervisor.js
 *
 * Run THIS instead of `node webhook-server.js` directly. The child
 * process inherits the same port (9001 default) and behaves identically
 * — operators don't need to change anything else.
 *
 * Logs:
 *   - All child stdout/stderr passed through to this terminal in real time
 *   - Every death (exit code, signal, last 20 stderr lines, restart count,
 *     time since previous death) appended to logs/webhook-supervisor.log
 *
 * Stop:
 *   Ctrl+C in the supervisor terminal. The supervisor traps SIGINT,
 *   signals the child for clean shutdown, then exits.
 *
 * Safety:
 *   - Refuses to start if port 9001 is already in use (prevents conflict
 *     with a manually-started webhook-server.js process)
 *   - Backoff between restarts (default 2s) prevents tight crash loops
 */

import { spawn }                                          from 'child_process';
import { existsSync, mkdirSync, appendFileSync }         from 'fs';
import { join, dirname }                                  from 'path';
import { fileURLToPath }                                  from 'url';
import net                                                from 'net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR   = join(__dirname, 'logs');
const LOG_FILE  = join(LOG_DIR, 'webhook-supervisor.log');
const PORT      = parseInt(process.env.PORT ?? '9001', 10);
const BACKOFF_MS = 2000;
const STDERR_RING_SIZE = 20;

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

// Refuse to start if port is already taken
function checkPortFree(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port);
  });
}

const portFree = await checkPortFree(PORT);
if (!portFree) {
  log(`⚠ Port ${PORT} is already in use — webhook-server.js may already be running.`);
  log(`  Either stop the existing process first or supervise that one manually.`);
  log(`  This supervisor will not start while the port is occupied.`);
  process.exit(1);
}

let restartCount        = 0;
let lastDeathTs         = null;
let stoppingDueToSignal = false;
let currentChild        = null;

function spawnChild() {
  const child = spawn('node', ['webhook-server.js'], {
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
      log(`webhook-server.js stopped by supervisor — clean exit.`);
      process.exit(0);
    }

    restartCount++;
    const sinceLast = lastDeathTs
      ? `${Math.round((Date.now() - lastDeathTs) / 1000)}s since last death`
      : 'first death this session';
    lastDeathTs = Date.now();

    log(`⚠ webhook-server.js DIED — exit_code=${code} signal=${signal} restart#${restartCount} (${sinceLast})`);
    if (stderrRing.length) {
      log(`  Last stderr captured before death:`);
      for (const l of stderrRing) log(`    ${l}`);
    } else {
      log(`  No stderr captured — process exited without writing to stderr.`);
      log(`  This pattern often means: terminal window closed, OS sent SIGTERM,`);
      log(`  or graceful exit. Less likely: silent crash in v8.`);
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
  // Force-exit after 1s if child doesn't terminate
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

log(`webhook-supervisor.js started`);
log(`  Wrapping: webhook-server.js on port ${PORT}`);
log(`  Log file: ${LOG_FILE}`);
log(`  Backoff:  ${BACKOFF_MS}ms between restarts`);
log(`  Stop:     Ctrl+C (child will be shut down cleanly first)`);
log('');
spawnChild();
