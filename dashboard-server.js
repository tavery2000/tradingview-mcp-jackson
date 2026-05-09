import http from 'http';
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

function readJson(file) {
  const p = join(__dirname, file);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function readText(file) {
  const p = join(__dirname, file);
  if (!existsSync(p)) return null;
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
}

function sendJson(res, data) {
  cors(res);
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify(data));
}

function sendError(res, code, msg) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

// ─── Journal helpers ──────────────────────────────────────
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

function readJournal(opts = {}) {
  const file = join(__dirname, 'logs', 'journal', `journal-${etDate()}.jsonl`);
  if (!existsSync(file)) return [];
  let lines = [];
  try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const records = [];
  for (let i = lines.length - 1; i >= 0 && records.length < (opts.max ?? 500); i--) {
    try {
      const r = JSON.parse(lines[i]);
      if (opts.type && r.type !== opts.type) continue;
      if (opts.types && !opts.types.includes(r.type)) continue;
      records.push(r);
    } catch {}
  }
  return records;
}

// ─── Webull token status ──────────────────────────────────
function readWebullStatus() {
  const main = readJson('.webull_token');
  const consumer = readJson('.webull_consumer_token');
  const out = {
    main: { status: 'CLEARED', token: null, savedAt: null },
    consumer: { status: 'CLEARED', token: null, savedAt: null },
  };
  if (main) {
    out.main.status = main.status || 'NORMAL';
    out.main.token = main.token ? main.token.slice(0, 8) + '…' : null;
    out.main.savedAt = main.savedAt ?? null;
  }
  if (consumer && consumer.token) {
    // Consumer token has no native PENDING/NORMAL state — derive from age
    const ageMs = Date.now() - (consumer.savedAt ?? 0);
    const age15d = ageMs > 15 * 24 * 3600 * 1000;
    out.consumer.status = age15d ? 'CLEARED' : 'NORMAL';
    out.consumer.token = consumer.token.slice(0, 8) + '…';
    out.consumer.savedAt = consumer.savedAt;
  }
  return out;
}

// In-flight auth child processes
const authJobs = { main: null, consumer: null };

function startWebullAuth() {
  if (authJobs.main && !authJobs.main.killed) {
    return { ok: false, error: 'auth already in progress', startedAt: authJobs.main.startedAt };
  }
  const child = spawn(process.execPath, [join(__dirname, 'webull.js'), '--auth'], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  authJobs.main = child;
  child.startedAt = Date.now();
  child.output = '';
  child.stdout.on('data', b => child.output += b.toString());
  child.stderr.on('data', b => child.output += b.toString());
  child.on('exit', code => { child.exitCode = code; });
  return { ok: true, startedAt: child.startedAt };
}

function getWebullAuthJob() {
  const j = authJobs.main;
  if (!j) return { running: false };
  return {
    running: j.exitCode == null,
    startedAt: j.startedAt,
    exitCode: j.exitCode ?? null,
    elapsedSec: Math.floor((Date.now() - j.startedAt) / 1000),
    tail: (j.output || '').slice(-2000),
  };
}

function saveConsumerTokenFromBody(token) {
  if (!token || typeof token !== 'string' || token.length < 10) {
    return { ok: false, error: 'token too short' };
  }
  const file = join(__dirname, '.webull_consumer_token');
  writeFileSync(file, JSON.stringify({ token: token.trim(), savedAt: Date.now(), source: 'dashboard-paste' }, null, 2));
  return { ok: true };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e6) reject(new Error('body too big')); });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'OPTIONS') {
    cors(res);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.writeHead(204); res.end(); return;
  }

  if (req.method === 'GET' && url === '/') {
    const html = join(__dirname, 'hank-electron-r3.html');
    if (!existsSync(html)) return sendError(res, 404, 'hank-electron-r3.html not found');
    cors(res);
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end(readFileSync(html));
    return;
  }

  if (req.method === 'GET' && url === '/api/ledger') {
    const data = readJson('paper-ledger.json');
    if (!data) return sendError(res, 404, 'paper-ledger.json not found');
    return sendJson(res, data);
  }

  if (req.method === 'GET' && url === '/api/levels') {
    const spy = readJson('spy-levels.json') ?? {};
    const qqq = readJson('qqq-levels.json') ?? {};
    const iwm = readJson('iwm-levels.json') ?? {};
    return sendJson(res, { SPY: spy, QQQ: qqq, IWM: iwm });
  }

  if (req.method === 'GET' && url === '/api/signals') {
    const moo = readJson('moo-signal.json') ?? null;
    const moc = readJson('moc-signal.json') ?? null;
    return sendJson(res, { moo, moc });
  }

  if (req.method === 'GET' && url === '/api/bias') {
    return sendJson(res, readJson('daily-bias.json') ?? {});
  }

  if (req.method === 'GET' && url === '/api/theta') {
    return sendJson(res, readJson('portfolio-theta.json') ?? { positions: [] });
  }

  if (req.method === 'GET' && url === '/api/options-flow') {
    return sendJson(res, readJson('options-flow.json') ?? {});
  }

  if (req.method === 'GET' && url === '/api/voice-queue') {
    return sendJson(res, readJson('voice-queue.json') ?? { queue: [] });
  }

  if (req.method === 'GET' && url === '/api/journal/gates') {
    return sendJson(res, { records: readJournal({ type: 'GATE_BLOCK', max: 20 }) });
  }
  if (req.method === 'GET' && url === '/api/journal/signals') {
    return sendJson(res, { records: readJournal({ type: 'SIGNAL', max: 50 }) });
  }
  if (req.method === 'GET' && url === '/api/journal/alerts') {
    return sendJson(res, { records: readJournal({ types: ['ALERT', 'ERROR'], max: 30 }) });
  }
  if (req.method === 'GET' && url === '/api/journal/all') {
    return sendJson(res, { records: readJournal({ max: 500 }) });
  }

  // ─── Account tier ────────────────────────────────────
  if (req.method === 'GET' && url === '/api/tier') {
    try {
      const mod = await import('./tier.js');
      const state  = mod.loadTier();
      const ledger = readJson('paper-ledger.json') || { trades: [], balance: state.equity };
      const up = mod.checkTierUpEligibility(state, ledger);
      return sendJson(res, {
        ...state,
        eligibility: up,
        caps: {
          dailyLossCap:    mod.getDailyLossCap(state.tier),
          maxConcurrent:   mod.getMaxConcurrent(state.tier),
          perInstrument:   mod.getPerInstrumentCap(state.tier),
        },
        contracts: mod.TIERS[state.tier]?.contracts ?? null,
      });
    } catch (e) { return sendError(res, 500, e.message); }
  }
  if (req.method === 'POST' && url === '/api/tier/promote') {
    try {
      const mod = await import('./tier.js');
      const state  = mod.loadTier();
      const ledger = readJson('paper-ledger.json') || { balance: state.equity };
      const up = mod.checkTierUpEligibility(state, ledger);
      if (!up.eligible) return sendJson(res, { ok: false, error: 'not eligible', checks: up.checks });
      mod.applyTierUp(state, ledger.balance ?? state.equity);
      mod.saveTier(state);
      return sendJson(res, { ok: true, newTier: state.tier, tierName: state.tierName });
    } catch (e) { return sendError(res, 500, e.message); }
  }

  // ─── Webull token endpoints ─────────────────────────────
  if (req.method === 'GET' && url === '/api/webull/status') {
    const status = readWebullStatus();
    const job = getWebullAuthJob();
    return sendJson(res, { ...status, authJob: job });
  }
  if (req.method === 'POST' && url === '/api/webull/refresh') {
    return sendJson(res, startWebullAuth());
  }
  if (req.method === 'POST' && url === '/api/webull/consumer-token') {
    try {
      const body = await readBody(req);
      const obj = JSON.parse(body || '{}');
      return sendJson(res, saveConsumerTokenFromBody(obj.token));
    } catch (e) { return sendError(res, 400, e.message); }
  }
  if (req.method === 'POST' && url === '/api/webull/clear-consumer') {
    try {
      const file = join(__dirname, '.webull_consumer_token');
      if (existsSync(file)) writeFileSync(file, '{}');
      return sendJson(res, { ok: true });
    } catch (e) { return sendError(res, 500, e.message); }
  }

  if (req.method === 'POST' && url === '/launch-tv') {
    // Stub kept for Electron parity — wsServer or main process handles real launch
    return sendJson(res, { success: false, msg: 'use Electron main process for tv-launch' });
  }

  // ─── FVG / sweep state surfacing ─────────────────────────
  // Reads the per-instrument state files written by the monitor scanners.
  // Caller filters/buckets here so the frontend doesn't reimplement the
  // unfilled/tested/filled split or the cooldown math.
  const SUPPORTED_INSTRUMENTS = ['SPY', 'QQQ', 'IWM'];
  const SWEEP_COOLDOWN_MS     = 15 * 60_000;
  const SWEEP_RECENT_WINDOW_S = 30 * 60;

  if (req.method === 'GET' && url.startsWith('/api/fvg/')) {
    const inst = url.slice('/api/fvg/'.length).toUpperCase();
    if (!SUPPORTED_INSTRUMENTS.includes(inst)) return sendError(res, 400, 'unknown instrument');
    const state = readJson(`fvg-state-${inst}.json`) || { gaps: [], lastScan: 0 };
    const gaps  = Array.isArray(state.gaps) ? state.gaps : [];
    const active = gaps.filter(g => (g.status === 'unfilled' || g.status === 'tested') && !g.firedAt);
    const recent = gaps.filter(g => g.status === 'filled' || g.status === 'invalidated' || g.firedAt).slice(-20);
    return sendJson(res, {
      instrument: inst,
      active, recent,
      counts: { active: active.length, recent: recent.length, total: gaps.length },
      lastScan: state.lastScan ?? 0,
    });
  }

  if (req.method === 'GET' && url.startsWith('/api/sweep/')) {
    const inst = url.slice('/api/sweep/'.length).toUpperCase();
    if (!SUPPORTED_INSTRUMENTS.includes(inst)) return sendError(res, 400, 'unknown instrument');
    const state  = readJson(`sweep-state-${inst}.json`) || { sweeps: [], cooldowns: {}, lastScan: 0 };
    const sweeps = Array.isArray(state.sweeps) ? state.sweeps : [];
    const cutoff = Math.floor((Date.now() - SWEEP_RECENT_WINDOW_S * 1000) / 1000);
    const recent = sweeps.filter(s => s.time >= cutoff);

    const now = Date.now();
    const activeCooldowns = [];
    for (const [key, lastFiredMs] of Object.entries(state.cooldowns || {})) {
      const elapsedMs = now - lastFiredMs;
      if (elapsedMs < SWEEP_COOLDOWN_MS) {
        activeCooldowns.push({ key, lastFired: lastFiredMs, remainingMs: SWEEP_COOLDOWN_MS - elapsedMs });
      }
    }
    return sendJson(res, {
      instrument: inst,
      recent,
      cooldowns: activeCooldowns,
      counts: { recent: recent.length, totalCooldowns: activeCooldowns.length, totalSweeps: sweeps.length },
      lastScan: state.lastScan ?? 0,
    });
  }

  if (req.method === 'GET' && url === '/api/triggers') {
    const out = {};
    const cutoff = Math.floor((Date.now() - SWEEP_RECENT_WINDOW_S * 1000) / 1000);
    for (const inst of SUPPORTED_INSTRUMENTS) {
      const fvg   = readJson(`fvg-state-${inst}.json`)   || { gaps: [], lastScan: 0 };
      const sweep = readJson(`sweep-state-${inst}.json`) || { sweeps: [], cooldowns: {}, lastScan: 0 };
      const gaps  = Array.isArray(fvg.gaps) ? fvg.gaps : [];
      const swArr = Array.isArray(sweep.sweeps) ? sweep.sweeps : [];
      const active = gaps.filter(g => (g.status === 'unfilled' || g.status === 'tested') && !g.firedAt);
      const recentSweeps = swArr.filter(s => s.time >= cutoff);
      out[inst] = {
        fvg: {
          activeCount: active.length,
          latest:      active[active.length - 1] ?? null,
          lastScan:    fvg.lastScan ?? 0,
        },
        sweep: {
          recentCount: recentSweeps.length,
          latest:      recentSweeps[recentSweeps.length - 1] ?? null,
          lastScan:    sweep.lastScan ?? 0,
        },
      };
    }
    return sendJson(res, out);
  }

  sendError(res, 404, 'Not found');
});

server.listen(PORT, () => {
  console.log(`HANK Dashboard → http://localhost:${PORT}`);
  console.log(`  Endpoints: /api/ledger /api/levels /api/signals /api/bias /api/theta`);
  console.log(`             /api/options-flow /api/voice-queue /api/journal/{gates,signals,alerts,all}`);
  console.log(`             /api/webull/{status,refresh,consumer-token,clear-consumer}`);
  console.log(`             /api/fvg/{SPY,QQQ,IWM}  /api/sweep/{SPY,QQQ,IWM}  /api/triggers`);
});
