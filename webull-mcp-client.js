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
// 2026-05-17 paper-mode verification state.
// Set after first successful connect via _verifyPaperMode().
//   _paperVerified === null  → not yet checked (allow operations)
//   _paperVerified === true  → confirmed paper (allow operations)
//   _paperVerified === false → confirmed LIVE while EXPECTED=paper (block orders)
let _paperVerified = null;
let _paperAccountId = null;        // Webull account_id of the paper account, if found
let _verifyLastResponse = null;    // raw response from getAccountList for diagnostics

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

// 2026-05-17: .env is the SINGLE SOURCE OF TRUTH for WEBULL_APP_KEY /
// WEBULL_APP_SECRET. The earlier "magic substitution" approach (swap
// in UAT shared creds at spawn time when env=uat) caused split-brain
// between webhook-server.js's MCP child and standalone subprocess
// invocations (operator's `uvx ... auth` was getting prod creds while
// the MCP child got UAT). Now both read .env directly.
//
// During sandbox week (5/17 - 5/31):  .env has UAT shared creds active,
//                                     prod values preserved as *_PROD
// On 2026-06-01 09:30 ET cutover:     swap names back in .env
//
// Shared UAT accounts (per developer.webull.com/apis/docs/sdk#test-accounts):
//   1. a88f2efed4dca02b9bc1a3cecbc35dba / c2895b3526cc7c7588758351ddf425d6
//   2. 6d9f1a0aa919a127697b567bb704369e / adb8931f708ea3d57ec1486f10abf58c
//   3. eecbf4489f460ad2f7aecef37b267618 / 8abf920a9cc3cb7af3ea5e9e03850692

function _spawnEnv() {
  const env = { ...process.env };
  const wblEnv  = (env.WEBULL_ENVIRONMENT || 'uat').toLowerCase();
  const akTail  = (env.WEBULL_APP_KEY || '').slice(-6) || '(unset)';
  console.log(`  [webull-mcp] ${wblEnv.toUpperCase()} mode: WEBULL_APP_KEY ending ...${akTail}`);
  // Sanity-warn if prod-looking AK is in use while env=uat (catches the
  // case where operator forgot to swap .env for sandbox week)
  if (wblEnv === 'uat') {
    const knownUat = new Set([
      'a88f2efed4dca02b9bc1a3cecbc35dba',
      '6d9f1a0aa919a127697b567bb704369e',
      'eecbf4489f460ad2f7aecef37b267618',
    ]);
    if (env.WEBULL_APP_KEY && !knownUat.has(env.WEBULL_APP_KEY)) {
      console.warn(`  [webull-mcp] ⚠ WEBULL_ENVIRONMENT=uat but WEBULL_APP_KEY is not one of the 3 shared UAT accounts — UAT endpoint will likely 401`);
    }
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
    // Fire paper-mode verification in the background — don't block connect on it
    _verifyPaperMode().catch(e => console.error(`  [webull-mcp] paper-mode verify threw: ${e.message}`));
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
  _paperVerified = null;          // re-verify on next connect
  _paperAccountId = null;
  _heartbeat('disconnected', { reason, error: err?.message });
  try { jError('WEBULL_MCP', 'disconnected', { reason, error: err?.message }); } catch {}
  console.warn(`  [webull-mcp] DISCONNECTED — ${reason}`);
  _scheduleReconnect();
}

// 2026-05-17 paper-mode verification.
// Operator's strategy: prod endpoint + prod AK/SK, with paper mode toggled
// in the Webull mobile app (account is a real Webull paper account, accessible
// via the same OpenAPI surface). We call get_account_list immediately after
// connect and inspect the response for paper indicators.
//
// Schema is unknown until first real response — we log the raw response so
// operator can see the available fields. Defensive heuristics check common
// field names ("paper", "virtual", "simulation", "practice") and account
// names containing those keywords.
//
// Behavior:
//   WEBULL_PAPER_MODE_EXPECTED=true  (default) → must find paper account, else BLOCK
//   WEBULL_PAPER_MODE_EXPECTED=false (6/1 cutover) → skip the check entirely
//
// Operator can pin an explicit account_id via WEBULL_PAPER_ACCOUNT_ID once
// they see the actual response shape.
async function _verifyPaperMode() {
  const expectPaper = (process.env.WEBULL_PAPER_MODE_EXPECTED || 'true').toLowerCase() === 'true';
  if (!expectPaper) {
    _paperVerified = true;
    console.log(`  [webull-mcp] paper-mode check SKIPPED (WEBULL_PAPER_MODE_EXPECTED=false; production-live mode)`);
    return;
  }
  let resp;
  try {
    resp = await _callTool('get_account_list');
  } catch (e) {
    _paperVerified = false;
    console.error(`  [webull-mcp] ⚠ paper-mode check FAILED — get_account_list threw: ${e.message}`);
    try { jError('WEBULL_MCP', 'paper-verify-failed', { error: e.message }); } catch {}
    return;
  }
  _verifyLastResponse = resp;
  // Walk the response looking for accounts. Webull returns slightly different
  // shapes depending on tool version; check the common ones.
  let accounts = [];
  if (Array.isArray(resp)) accounts = resp;
  else if (resp?.accounts) accounts = resp.accounts;
  else if (resp?.data) accounts = Array.isArray(resp.data) ? resp.data : (resp.data.accounts || []);
  else if (resp?.content || resp?.structuredContent) {
    // MCP tool responses wrap result in content[].text OR structuredContent.result.
    // Webull's MCP returns a HUMAN-READABLE text block, not JSON. Parse it:
    //   === Account List ===
    //   1. ID: FNJQ...  Number: CUZ54272  Type: MARGIN  Class: FUTURES  Label: Futures
    //   2. ID: HHIC...  ...
    const text = resp.structuredContent?.result || resp.content?.[0]?.text || '';
    // Try JSON first (some tools might switch)
    try {
      const parsed = JSON.parse(text);
      accounts = parsed.accounts || parsed.data?.accounts || (Array.isArray(parsed) ? parsed : []);
    } catch {}
    // Fall back to regex on the line format
    if (accounts.length === 0 && text) {
      const lineRe = /\d+\.\s*ID:\s*(\S+)\s+Number:\s*(\S+)\s+Type:\s*(\S+)\s+Class:\s*(\S+)\s+Label:\s*([^\r\n]+)/g;
      let m;
      while ((m = lineRe.exec(text)) !== null) {
        accounts.push({
          account_id: m[1], account_number: m[2],
          account_type: m[3], account_class: m[4],
          account_name: m[5].trim(),
        });
      }
    }
  }
  console.log(`  [webull-mcp] paper-mode check: found ${accounts.length} account(s)`);
  if (process.env.WEBULL_DEBUG_ACCOUNT_DUMP === 'true') {
    console.log(`  [webull-mcp] raw get_account_list response:\n${JSON.stringify(resp, null, 2).slice(0, 2000)}`);
  }

  // Operator can pin the paper account explicitly once schema is known
  const pinnedId = process.env.WEBULL_PAPER_ACCOUNT_ID;
  if (pinnedId) {
    const pinned = accounts.find(a => String(a.account_id || a.id || a.accountId) === String(pinnedId));
    if (pinned) {
      _paperAccountId = pinnedId;
      _paperVerified = true;
      console.log(`  [webull-mcp] ✓ paper account PINNED by WEBULL_PAPER_ACCOUNT_ID=${pinnedId}`);
      try { jAlert('info', 'WEBULL_PAPER_VERIFIED', { accountId: pinnedId, mode: 'pinned' }); } catch {}
      return;
    }
    console.warn(`  [webull-mcp] ⚠ WEBULL_PAPER_ACCOUNT_ID=${pinnedId} but no matching account in response — falling back to heuristic`);
  }

  // Heuristic detection — check each account for paper indicators
  const paperHits = [];
  for (const a of accounts) {
    const flat = JSON.stringify(a).toLowerCase();
    const isPaper =
         a.paper_account === true || a.paperAccount === true
      || a.is_virtual === true   || a.isVirtual === true
      || a.simulation === true   || a.is_simulation === true
      || a.practice_account === true
      || (typeof a.account_type === 'string' && /paper|virtual|practice|simulation/i.test(a.account_type))
      || (typeof a.account_name === 'string' && /paper|virtual|practice/i.test(a.account_name))
      || /"(paper|virtual|simulation|practice)"\s*:\s*true/.test(flat);
    if (isPaper) {
      paperHits.push({ account_id: a.account_id || a.id || a.accountId, account_type: a.account_type, account_name: a.account_name });
    }
  }

  if (paperHits.length === 0) {
    _paperVerified = false;
    const msg = `⚠ PAPER MODE NOT DETECTED — no account in get_account_list response matches paper indicators. Order placement will be BLOCKED. Toggle Webull mobile app to Paper Trading mode, OR set WEBULL_PAPER_ACCOUNT_ID to pin the right account, OR set WEBULL_PAPER_MODE_EXPECTED=false to bypass.`;
    console.error(`  [webull-mcp] ${msg}`);
    try { jAlert('critical', 'WEBULL_PAPER_MODE_NOT_DETECTED', { accountCount: accounts.length, expectPaper: true }); } catch {}
    return;
  }
  if (paperHits.length > 1) {
    console.warn(`  [webull-mcp] ⚠ multiple paper-like accounts (${paperHits.length}) — using first; pin via WEBULL_PAPER_ACCOUNT_ID for explicit selection`);
  }
  _paperAccountId = paperHits[0].account_id;
  _paperVerified = true;
  console.log(`  [webull-mcp] ✓ paper account detected: ${JSON.stringify(paperHits[0])}`);
  try { jAlert('info', 'WEBULL_PAPER_VERIFIED', { ...paperHits[0], mode: 'heuristic', alternatives: paperHits.length - 1 }); } catch {}
}

export function isPaperVerified() { return _paperVerified; }
export function getPaperAccountId() { return _paperAccountId; }
export function getLastVerifyResponse() { return _verifyLastResponse; }

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

// Account — getAccountBalance + getAccountPositions auto-pin the pinned/
// detected account_id when caller doesn't supply one (Webull MCP requires it).
export async function getAccountList()        { return _callTool('get_account_list'); }
export async function getAccountBalance(opts = {}) {
  if (!opts.account_id) opts.account_id = _paperAccountId || process.env.WEBULL_PAPER_ACCOUNT_ID;
  return _callTool('get_account_balance', opts);
}
export async function getAccountPositions(opts = {}) {
  if (!opts.account_id) opts.account_id = _paperAccountId || process.env.WEBULL_PAPER_ACCOUNT_ID;
  return _callTool('get_account_positions', opts);
}

// Market data
export async function getStockSnapshot(opts)   { return _callTool('get_stock_snapshot',   opts); }
export async function getFuturesSnapshot(opts) { return _callTool('get_futures_snapshot', opts); }
export async function getInstruments(opts)     { return _callTool('get_instruments', opts); }
export async function getFuturesInstruments(opts = {}) {
  // Webull requires `symbols` — caller must pass; we don't have a sensible default
  return _callTool('get_futures_instruments', opts);
}

// Order placement — Tuesday 5/19 sandbox-round-trip will firm up the
// exact argument shapes. For Sunday smoke test we just need the call to
// reach the MCP server and return a structured response (or rejection).
async function placeFuturesOrder(payload) {
  // 2026-05-17: hard-block if paper-mode verification failed (operator
  // intends paper but account-list inspection didn't find a paper account).
  if (_paperVerified === false) {
    return { vetoed: true, reason: 'WEBULL_PAPER_MODE_NOT_DETECTED', requestId: null };
  }
  // payload from webhook-server.js: { instrument, direction, engine, confidence, price, macro4H, invalidationLevel, structureType }
  const requestId = `WMCP_FUT_${payload.direction}_${payload.engine}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  // Stub shape — refined Tue 5/19. We return a structured result so the
  // webhook can log/journal even before the full Webull schema is wired.
  try {
    const args = {
      account_id: _paperAccountId || process.env.WEBULL_PAPER_ACCOUNT_ID,
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
  if (_paperVerified === false) {
    return { vetoed: true, reason: 'WEBULL_PAPER_MODE_NOT_DETECTED', requestId: null };
  }
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

// 2026-05-17: expose spawn config so ask.js can run `webull auth` with
// the same uvx + python-3.12 args as the embedded serve invocation.
export function getMcpSpawnConfig() {
  return { command: MCP_COMMAND, args: MCP_ARGS };
}

// Force-reconnect from ask.js after operator finishes 2FA. Closes the
// current transport (if any) and re-runs the connect path.
export async function forceReconnect() {
  if (_transport) {
    try { _transport.onclose = null; } catch {}
    try { await _client?.close(); } catch {}
  }
  _connected = false;
  _client = null;
  _transport = null;
  _paperVerified = null;
  _paperAccountId = null;
  _reconnectAttempts = 0;
  await _connect();
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
