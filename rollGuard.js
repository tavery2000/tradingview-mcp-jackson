/**
 * rollGuard.js — futures contract expiry monitor (Day 1 scaffolding)
 *
 * 2026-05-17 SCAFFOLDING. Operator's Thu 5/21 spec wires the full
 * Roll Guard (auto-rolls expiring contracts via place_*_order). For
 * Sunday's GO/NO-GO checkpoint we need the detection layer in place —
 * a periodic check that surfaces "contract X expires in N days,
 * consider rolling" without yet executing the roll.
 *
 * Calls Webull MCP `get_futures_instruments` to find current front-month
 * contracts for our allowlist (ES1!, NQ1!, MES1!, MNQ1!), compares
 * against the expiry date of the contracts in any current open
 * positions, and warns when expiry is within ROLL_GUARD_WARN_DAYS.
 *
 * Schedule: setInterval every 1h (configurable). State persists to
 * roll-guard-state.json (gitignored) so we don't spam alerts on every
 * tick of a 1h interval.
 *
 * Tue 5/19+ extensions land in this file:
 *   - Auto-roll execution (Thu 5/21 spec)
 *   - Per-instrument override (allow operator to defer rolls)
 *   - Cost-aware roll (skip if bid/ask spread on new contract > threshold)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { jAlert, jError } from './journal.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, 'roll-guard-state.json');

const ENABLED = (process.env.ROLL_GUARD_ENABLED || 'true').toLowerCase() === 'true';
const WARN_DAYS = parseInt(process.env.ROLL_GUARD_WARN_DAYS || '5', 10);
const TICK_MS = parseInt(process.env.ROLL_GUARD_TICK_MS || String(60 * 60 * 1000), 10);   // default hourly
const ALLOWLIST = (process.env.ROLL_GUARD_INSTRUMENTS || 'ES,NQ,MES,MNQ').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

let _started = false;
let _interval = null;

function _loadState() {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {}
  return { lastTick: null, warnings: {} };
}
function _saveState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

async function _tick() {
  if (!ENABLED) return;
  let mcp = null;
  try {
    const m = await import('./webull-mcp-client.js');
    mcp = m.getWebullMCP();
  } catch (e) {
    try { jError('ROLL_GUARD', 'mcp-import-failed', { error: e.message }); } catch {}
    return;
  }
  if (!mcp || !mcp.isConnected()) return;

  const state = _loadState();
  state.lastTick = new Date().toISOString();

  // Pull current futures instruments for the allowlist. Webull MCP requires
  // `symbols` param — pass the allowlist (ES, NQ, MES, MNQ).
  let instruments = [];
  try {
    const resp = await mcp.getFuturesInstruments({ symbols: ALLOWLIST.join(',') });
    instruments = resp?.instruments || resp?.data || [];
  } catch (e) {
    try { jError('ROLL_GUARD', 'get_futures_instruments-failed', { error: e.message }); } catch {}
    _saveState(state);
    return;
  }

  // Pull open positions to see which contracts we actually hold
  let positions = [];
  try {
    const posResp = await mcp.getAccountPositions({});
    positions = posResp?.positions || posResp?.data || [];
  } catch (e) {
    try { jError('ROLL_GUARD', 'get_account_positions-failed', { error: e.message }); } catch {}
  }

  const today = new Date();
  for (const p of positions) {
    const symbol = (p.symbol || p.instrument || '').toUpperCase();
    const base = ALLOWLIST.find(b => symbol.startsWith(b));
    if (!base) continue;

    const expiry = p.expiry || p.expiration_date;
    if (!expiry) continue;
    const expDate = new Date(expiry);
    if (Number.isNaN(expDate.getTime())) continue;
    const daysToExpiry = Math.ceil((expDate - today) / (24 * 60 * 60 * 1000));

    if (daysToExpiry <= WARN_DAYS && daysToExpiry >= 0) {
      // Dedupe: warn once per (symbol, expiry) per day
      const key = `${symbol}_${expiry}_${today.toISOString().slice(0,10)}`;
      if (state.warnings[key]) continue;
      state.warnings[key] = { ts: Date.now(), daysToExpiry };
      try { jAlert('warning', 'ROLL_GUARD_EXPIRY_WARN', {
        symbol, expiry, daysToExpiry, qty: p.quantity || p.qty,
        action: 'consider rolling (auto-roll lands Thu 5/21)',
      }); } catch {}
      console.log(`  [rollGuard] ⚠ ${symbol} expires in ${daysToExpiry}d (${expiry}) — manual roll recommended`);
    }
  }

  // Garbage-collect old warning records (>14 days)
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  for (const k of Object.keys(state.warnings)) {
    if (state.warnings[k].ts < cutoff) delete state.warnings[k];
  }
  _saveState(state);
}

export function startRollGuard() {
  if (!ENABLED || _started) return false;
  _started = true;
  console.log(`  [rollGuard] ARMED — warn ${WARN_DAYS}d before expiry, tick ${TICK_MS/1000/60}min, instruments=${ALLOWLIST.join(',')}`);
  _interval = setInterval(_tick, TICK_MS);
  if (_interval.unref) _interval.unref();
  // Defer first tick by 30s — gives MCP client time to connect on startup
  setTimeout(_tick, 30_000);
  return true;
}

/** Manual test trigger (callable from ask.js REPL) */
export async function tickNow() {
  await _tick();
  return _loadState();
}
