/**
 * webull-mcp-client.js — Node wrapper around webull-openapi-mcp (Python)
 *
 * 2026-05-17: spawn the official Webull MCP server (Python, stdio transport)
 * as a child of webhook-server.js. Exposes a thin async API for HANK code
 * paths (futures, equity options, account, kill/flatten).
 *
 * Lifecycle:
 *   - webhook-server.js startup → init(): spawn child + connect MCP client
 *   - long-lived single connection; auto-reconnect on death
 *   - heartbeat record written every 30s for dashboard /api/heartbeats
 *
 * Rollback flags (read live from env on every call, not cached):
 *   WEBULL_INTEGRATION_HALT=true  → tier 3 catastrophic, reject all
 *   WEBULL_MCP_DISABLED=true      → tier 1, reject new entries
 *
 * Sandbox-by-default: WEBULL_ENVIRONMENT=uat in .env. Production = explicit
 * flip to "prod" on 6/1 09:30 ET.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { jAlert, jError } from './journal.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HEARTBEAT_FILE = join(__dirname, 'logs', 'heartbeat-webull-mcp.json');
const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

// MCP command — uvx resolves the published package. Auto-detect uvx.exe
// since `pip install uv` lands it in a Scripts/ dir that isn't always on
// Windows PATH (and asking the operator to chase PATH is a non-starter).
// Override via WEBULL_MCP_COMMAND in .env if auto-detection misses.
function _findUvxPath() {
  if (process.env.WEBULL_MCP_COMMAND) return process.env.WEBULL_MCP_COMMAND;
  // Try `where uvx` (Windows) / `which uvx` (Unix). Most reliable when PATH is right.
  try {
    const cmd = process.platform === 'win32' ? 'where uvx' : 'which uvx';
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const first = out.split(/\r?\n/)[0].trim();
    if (first && existsSync(first)) return first;
  } catch {}
  // Fallback: walk known Windows install locations for the operator's machine
  // and any other plausible pythoncore-X.Y-64 install.
  if (process.platform === 'win32') {
    const home = homedir();
    const candidates = [
      join(home, '.local', 'bin', 'uvx.exe'),                      // uv's standard install
      join(home, 'AppData', 'Roaming', 'uv', 'bin', 'uvx.exe'),    // alt uv install
    ];
    // Probe AppData\Local\Python\pythoncore-*-64\Scripts\uvx.exe (operator's case)
    const localPython = join(home, 'AppData', 'Local', 'Python');
    if (existsSync(localPython)) {
      try {
        for (const dir of readdirSync(localPython)) {
          if (/^pythoncore-/.test(dir)) candidates.push(join(localPython, dir, 'Scripts', 'uvx.exe'));
        }
      } catch {}
    }
    // Probe AppData\Local\Programs\Python\Python*\Scripts\uvx.exe (python.org installer)
    const localPrograms = join(home, 'AppData', 'Local', 'Programs', 'Python');
    if (existsSync(localPrograms)) {
      try {
        for (const dir of readdirSync(localPrograms)) {
          if (/^Python\d+/.test(dir)) candidates.push(join(localPrograms, dir, 'Scripts', 'uvx.exe'));
        }
      } catch {}
    }
    for (const path of candidates) {
      if (existsSync(path)) return path;
    }
  }
  // Last resort — return the bare command and hope PATH is set
  return 'uvx';
}
const MCP_COMMAND = _findUvxPath();
// 2026-05-17 PATH A fix: pin to Python 3.12. Operator's system Python is
// 3.14 (cp314); grpcio==1.69.0 (transitive dep of webull-openapi-mcp) has
// no pre-built wheel for 3.14 and requires MSVC Build Tools to compile
// from source. uv's --python 3.12 auto-downloads a managed 3.12 interpreter
// (one-time ~30MB) and uses it for this MCP environment only — operator's
// system Python 3.14 untouched.
// Operator override: WEBULL_MCP_ARGS comma-separated list, OR UV_PYTHON env var.
const MCP_ARGS    = (process.env.WEBULL_MCP_ARGS || '--python,3.12,webull-openapi-mcp@0.1.1,serve').split(',');
console.log(`  [webull-mcp] command resolved: ${MCP_COMMAND}`);
console.log(`  [webull-mcp] args:             ${MCP_ARGS.join(' ')}`);

let _client = null;
let _transport = null;
let _connected = false;
let _connecting = false;
let _reconnectAttempts = 0;
let _heartbeatTimer = null;
let _availableTools = new Set();

export function isMCPDisabled() {
  return (process.env.WEBULL_MCP_DISABLED || 'false').toLowerCase() === 'true';
}
export function isIntegrationHalted() {
  return (process.env.WEBULL_INTEGRATION_HALT || 'false').toLowerCase() === 'true';
}

function _heartbeat(status, extra = {}) {
  try {
    if (!existsSync(dirname(HEARTBEAT_FILE))) mkdirSync(dirname(HEARTBEAT_FILE), { recursive: true });
    writeFileSync(HEARTBEAT_FILE, JSON.stringify({
      name: 'webull-mcp',
      pid: process.pid,
      ts: Date.now(),
      et: new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false }),
      status,
      reconnectAttempts: _reconnectAttempts,
      toolCount: _availableTools.size,
      ...extra,
    }, null, 2));
  } catch {}
}

// 2026-05-17: Webull provides 3 shared public UAT test accounts (per
// https://developer.webull.com/apis/docs/sdk#test-accounts). These work
// without app approval — necessary because operator's production AK/SK
// returns 401 against the UAT endpoint. On WEBULL_ENVIRONMENT=uat we
// SUBSTITUTE the UAT shared creds at spawn time; on =prod we use the
// operator's real production AK/SK from .env unchanged.
//
// Three accounts available — failover in order if one is rate-limited:
//   1. a88f2efed4dca02b9bc1a3cecbc35dba / c2895b3526cc7c7588758351ddf425d6  (default)
//   2. 6d9f1a0aa919a127697b567bb704369e / adb8931f708ea3d57ec1486f10abf58c
//   3. eecbf4489f460ad2f7aecef37b267618 / 8abf920a9cc3cb7af3ea5e9e03850692
//
// Override via WEBULL_UAT_APP_KEY / WEBULL_UAT_APP_SECRET if operator
// later obtains a dedicated test account from Webull support.
const _UAT_DEFAULT_APP_KEY    = process.env.WEBULL_UAT_APP_KEY    || 'a88f2efed4dca02b9bc1a3cecbc35dba';
const _UAT_DEFAULT_APP_SECRET = process.env.WEBULL_UAT_APP_SECRET || 'c2895b3526cc7c7588758351ddf425d6';

function _spawnEnv() {
  const env = { ...process.env };
  const wblEnv = (env.WEBULL_ENVIRONMENT || 'uat').toLowerCase();
  if (wblEnv === 'uat') {
    env.WEBULL_APP_KEY    = _UAT_DEFAULT_APP_KEY;
    env.WEBULL_APP_SECRET = _UAT_DEFAULT_APP_SECRET;
    // Hide operator's real prod creds from the child to prevent accidents
    // (also leaks them less if MCP server logs env on startup)
    delete env.WEBULL_APP_ID;
    console.log(`  [webull-mcp] UAT mode: using shared public test account (key ending ${_UAT_DEFAULT_APP_KEY.slice(-6)})`);
  } else {
    console.log(`  [webull-mcp] PROD mode: using operator's WEBULL_APP_KEY`);
  }
  return env;
}

function _checkUvxHealth() {
  // 2026-05-17: Windows Defender / antivirus has been observed truncating
  // uvx.exe to 0 bytes (seen 14:28 ET — file went from valid PE32 to empty
  // between two restarts of HANK). Surface this clearly instead of letting
  // node's spawn return cryptic EFTYPE.
  try {
    if (!MCP_COMMAND || MCP_COMMAND === 'uvx') return { ok: true, note: 'using bare uvx from PATH' };
    if (!existsSync(MCP_COMMAND)) {
      return { ok: false, reason: 'missing', msg: `uvx.exe not found at ${MCP_COMMAND} — reinstall with: pip install --force-reinstall uv` };
    }
    const st = statSync(MCP_COMMAND);
    if (st.size === 0) {
      return { ok: false, reason: 'empty', msg: `uvx.exe is 0 bytes at ${MCP_COMMAND} — likely quarantined by antivirus. Recover with: pip install --force-reinstall uv  (then add Defender exclusion for Scripts/ dir)` };
    }
    if (st.size < 1000) {
      return { ok: true, note: `uvx.exe is suspiciously small (${st.size} bytes) — may be a stub` };
    }
    return { ok: true, size: st.size };
  } catch (e) {
    return { ok: false, reason: 'stat-failed', msg: e.message };
  }
}

async function _connect() {
  if (_connecting || _connected) return;
  _connecting = true;
  // Pre-flight: check uvx.exe is alive before asking node to spawn it
  const health = _checkUvxHealth();
  if (!health.ok) {
    _connecting = false;
    _heartbeat('uvx-unhealthy', { reason: health.reason });
    try { jError('WEBULL_MCP', 'uvx-unhealthy', { reason: health.reason, msg: health.msg, path: MCP_COMMAND }); } catch {}
    console.error(`  [webull-mcp] ⚠ ${health.msg}`);
    _scheduleReconnect();
    return;
  }
  try {
    _transport = new StdioClientTransport({
      command: MCP_COMMAND,
      args: MCP_ARGS,
      env: _spawnEnv(),
    });
    _client = new Client({ name: 'hank-webhook', version: '1.0.0' }, { capabilities: {} });
    await _client.connect(_transport);
    const toolsResp = await _client.listTools();
    _availableTools = new Set((toolsResp.tools || []).map(t => t.name));
    _connected = true;
    _connecting = false;
    _reconnectAttempts = 0;
    _heartbeat('connected', { tools: [..._availableTools].slice(0, 20) });
    try { jAlert('info', 'WEBULL_MCP_CONNECTED', { toolCount: _availableTools.size, env: process.env.WEBULL_ENVIRONMENT || 'uat' }); } catch {}
    console.log(`  [webull-mcp] CONNECTED — ${_availableTools.size} tools available, env=${process.env.WEBULL_ENVIRONMENT || 'uat'}`);
    _transport.onclose = () => { _onDisconnect('transport-closed'); };
    _transport.onerror = (err) => { _onDisconnect('transport-error', err); };
  } catch (e) {
    _connecting = false;
    _connected = false;
    _heartbeat('connect-failed', { error: e.message });
    try { jError('WEBULL_MCP', 'connect-failed', { error: e.message, attempt: _reconnectAttempts }); } catch {}
    console.error(`  [webull-mcp] CONNECT FAILED — ${e.message}`);
    _scheduleReconnect();
  }
}

function _onDisconnect(reason, err) {
  if (!_connected) return;
  _connected = false;
  _client = null;
  _transport = null;
  _heartbeat('disconnected', { reason, error: err?.message });
  try { jError('WEBULL_MCP', 'disconnected', { reason, error: err?.message }); } catch {}
  console.warn(`  [webull-mcp] DISCONNECTED — ${reason}`);
  _scheduleReconnect();
}

function _scheduleReconnect() {
  const delay = RECONNECT_BACKOFF_MS[Math.min(_reconnectAttempts, RECONNECT_BACKOFF_MS.length - 1)];
  _reconnectAttempts++;
  setTimeout(() => _connect(), delay);
}

function _ensureTool(name) {
  if (!_connected) throw new Error('MCP not connected');
  if (!_availableTools.has(name)) throw new Error(`MCP tool not available: ${name}`);
}

// ─── Thin wrappers ───────────────────────────────────────────
// Names follow the MCP server's tool registry (verified Tue 5/19 against
// actual tool list). Argument shapes are best-effort from the README; will
// need adjustment after the first sandbox round-trip.

async function _callTool(name, args = {}) {
  _ensureTool(name);
  const start = Date.now();
  try {
    const result = await _client.callTool({ name, arguments: args });
    return result;
  } catch (e) {
    try { jError('WEBULL_MCP', 'tool-call-failed', { tool: name, args: _sanitize(args), error: e.message, durationMs: Date.now() - start }); } catch {}
    throw e;
  }
}
function _sanitize(args) {
  // Strip anything that smells like a secret before logging
  const out = { ...args };
  for (const k of Object.keys(out)) {
    if (/secret|token|password|key$/i.test(k)) out[k] = '***';
  }
  return out;
}

// Account
export async function getAccountList()        { return _callTool('get_account_list'); }
export async function getAccountBalance(opts) { return _callTool('get_account_balance', opts); }
export async function getAccountPositions(opts){ return _callTool('get_account_positions', opts); }

// Market data
export async function getStockSnapshot(opts)   { return _callTool('get_stock_snapshot',   opts); }
export async function getFuturesSnapshot(opts) { return _callTool('get_futures_snapshot', opts); }
export async function getInstruments(opts)     { return _callTool('get_instruments', opts); }
export async function getFuturesInstruments(opts){ return _callTool('get_futures_instruments', opts); }

// Order placement — Tuesday 5/19 sandbox-round-trip will firm up the
// exact argument shapes. For Sunday smoke test we just need the call to
// reach the MCP server and return a structured response (or rejection).
async function placeFuturesOrder(payload) {
  // payload from webhook-server.js: { instrument, direction, engine, confidence, price, macro4H, invalidationLevel, structureType }
  const requestId = `WMCP_FUT_${payload.direction}_${payload.engine}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  // Stub shape — refined Tue 5/19. We return a structured result so the
  // webhook can log/journal even before the full Webull schema is wired.
  try {
    const args = {
      instrument_symbol: payload.instrument,
      side: payload.direction === 'CALLS' ? 'BUY' : 'SELL',
      order_type: 'MARKET',
      quantity: 1,
      // OTOCO bracket (Q4 Day 1 capability) — stop + target legs
      // attached server-side. Schema to be finalized post round-trip.
      bracket: payload.invalidationLevel ? { stop_price: payload.invalidationLevel } : undefined,
    };
    const result = await _callTool('place_futures_order', args);
    try { jAlert('info', 'WEBULL_MCP_FUT_PLACED', { requestId, instrument: payload.instrument, direction: payload.direction, engine: payload.engine, mcp_result: result }); } catch {}
    return { requestId, orderId: result?.order_id ?? null, contracts: 1, raw: result };
  } catch (e) {
    return { vetoed: true, reason: 'MCP_FUTURES_REJECTED', error: e.message, requestId };
  }
}
async function placeOptionSingleOrder(payload) {
  const requestId = `WMCP_OPT_${payload.direction}_${payload.engine}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  try {
    const args = {
      symbol: payload.instrument,
      option_type: payload.direction === 'CALLS' ? 'CALL' : 'PUT',
      side: 'BUY_OPEN',
      order_type: 'MARKET',
      quantity: payload.contracts || 1,
      strike_price: payload.strike,
      expiry: payload.expiry,
    };
    const result = await _callTool('place_option_single_order', args);
    try { jAlert('info', 'WEBULL_MCP_OPT_PLACED', { requestId, instrument: payload.instrument, direction: payload.direction, engine: payload.engine, mcp_result: result }); } catch {}
    return { requestId, orderId: result?.order_id ?? null, contracts: args.quantity, raw: result };
  } catch (e) {
    return { vetoed: true, reason: 'MCP_OPT_REJECTED', error: e.message, requestId };
  }
}

// Order management
export async function cancelOrder(orderId)     { return _callTool('cancel_order', { order_id: orderId }); }
export async function getOpenOrders(opts)      { return _callTool('get_open_orders', opts); }
export async function getOrderDetail(orderId)  { return _callTool('get_order_detail', { order_id: orderId }); }

// Combo (OTOCO) — Day 1 enable per Q4
export async function placeStockComboOrder(opts) { return _callTool('place_stock_combo_order', opts); }

// Public getter for the connected client object (used by webhook for
// the futures order routing in this commit).
let _mcpHandle = null;
export function getWebullMCP() {
  if (!_mcpHandle) {
    _mcpHandle = {
      isConnected: () => _connected,
      placeFuturesOrder,
      placeOptionSingleOrder,
      getAccountList, getAccountBalance, getAccountPositions,
      getOpenOrders, getOrderDetail, cancelOrder,
      placeStockComboOrder,
      getStockSnapshot, getFuturesSnapshot, getInstruments, getFuturesInstruments,
      _callTool,             // escape hatch for tools without explicit wrappers
      availableTools: () => [..._availableTools],
    };
  }
  return _mcpHandle;
}

export async function initWebullMCP() {
  if (isMCPDisabled()) {
    console.log(`  [webull-mcp] DISABLED via WEBULL_MCP_DISABLED — skipping init`);
    _heartbeat('disabled');
    return false;
  }
  await _connect();
  if (_heartbeatTimer) clearInterval(_heartbeatTimer);
  _heartbeatTimer = setInterval(() => {
    _heartbeat(_connected ? 'alive' : 'disconnected');
  }, HEARTBEAT_INTERVAL_MS);
  if (_heartbeatTimer.unref) _heartbeatTimer.unref();
  return _connected;
}

export async function shutdownWebullMCP() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
  if (_client) {
    try { await _client.close(); } catch {}
  }
  _connected = false;
  _client = null;
  _transport = null;
}
