/**
 * futuresPricer.js — Webull MCP futures snapshot poller (Window 9 LIVE feed)
 *
 * 2026-05-18: Operator was blind on futures activity overnight. futures-status.js
 * already had the LIVE column and uPnL math wired (lines 107-141), but
 * latest-prices.json was only ever written by webhook-server.js's Pine-alert
 * handler — between alerts, the cache held a single stale snapshot per
 * instrument. Result: empty LIVE column, no uPnL, no awareness of how close
 * price was running to stops/targets.
 *
 * Why webhook-server, not futures-status:
 *   futures-status.js is explicitly a pure file-reader (see file header) and
 *   warns against module-state duplication. webhook-server already owns the
 *   parked-warm Webull MCP client; spawning a second uvx subprocess inside
 *   futures-status would double the auth surface and contend with the
 *   primary client. Single MCP client → multiple file readers is the
 *   existing architecture; this module preserves it.
 *
 * Flow per tick (default 3s):
 *   1. for each ES1!/NQ1!/MES1!/MNQ1! → resolveFuturesSymbol → broker code
 *      (e.g. ESM6, MESM6) via existing webull-mcp-client resolver
 *   2. parallel getFuturesSnapshot({ symbol: brokerCode })
 *   3. defensive _extractLast() — handles MCP text envelope + JSON + raw
 *      (response shape unverified pre-RTH; falls through known fields)
 *   4. read-modify-write latest-prices.json — merges with Pine-alert writes
 *
 * Failure handling per operator spec:
 *   3 consecutive failures per instrument → write { stale: true,
 *   staleSince, lastFailReason } so futures-status renders the
 *   "LIVE=STALE" warning in red.
 *
 * Skip when MCP is disabled or integration-halted — no background load.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  isMCPDisabled, isIntegrationHalted,
  getFuturesSnapshot, resolveFuturesSymbol,
} from './webull-mcp-client.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const PRICE_FILE = join(__dirname, 'latest-prices.json');
const POLL_MS    = parseInt(process.env.FUT_PRICER_POLL_MS || '3000', 10);
const INSTRUMENTS = (process.env.FUT_PRICER_SYMBOLS || 'ES1!,NQ1!,MES1!,MNQ1!')
  .split(',').map(s => s.trim()).filter(Boolean);
const STALE_AFTER_FAILS = parseInt(process.env.FUT_PRICER_STALE_FAILS || '3', 10);
const INITIAL_DELAY_MS  = parseInt(process.env.FUT_PRICER_INITIAL_DELAY_MS || '5000', 10);

const _failCount = new Map();
let _started = false;
let _timer   = null;
let _loggedStale = new Set();
let _entitlementBlocked = false;  // set once we see Webull 401/Insufficient permission

function _etTimeString() {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour12: false,
  });
}

// Defensive last-price extractor. MCP responses across the Webull server's
// tools have come back in three shapes during integration: JSON object,
// text-wrapped JSON in content[0].text, and plain text with embedded
// key:value pairs. Try all three before giving up. Returns null on miss.
function _extractLast(resp) {
  if (!resp) return null;

  // Shape A — MCP text envelope
  const text = resp?.content?.[0]?.text;
  if (typeof text === 'string') {
    try {
      const j = JSON.parse(text);
      const cands = [
        j.last, j.lastPrice, j.last_price, j.price, j.tradePrice, j.close,
        j?.data?.last, j?.data?.lastPrice, j?.data?.last_price, j?.data?.price,
        j?.snapshot?.last, j?.snapshot?.lastPrice,
      ];
      for (const c of cands) if (Number.isFinite(c)) return c;
    } catch { /* fall through to text scrape */ }

    const m = text.match(/(?:^|\s)(?:last(?:_?price)?|price|trade(?:_?price)?)\s*[:=]\s*\$?([\d,]+(?:\.\d+)?)/i);
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (Number.isFinite(n)) return n;
    }
  }

  // Shape B — direct object
  const direct = [resp.last, resp.lastPrice, resp.last_price, resp.price];
  for (const c of direct) if (Number.isFinite(c)) return c;

  return null;
}

function _readCache() {
  try {
    if (!existsSync(PRICE_FILE)) return {};
    return JSON.parse(readFileSync(PRICE_FILE, 'utf8')) || {};
  } catch { return {}; }
}

function _writeCache(cache) {
  try {
    writeFileSync(PRICE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error(`  [FUT_PRICER] write fail: ${e.message}`);
  }
}

async function _pollOne(tvSymbol) {
  const brokerCode = resolveFuturesSymbol(tvSymbol);
  if (!brokerCode) return { tvSymbol, ok: false, reason: 'NO_BROKER_CODE' };
  try {
    // Webull MCP convention (verified 2026-05-18 from server pydantic error):
    // get_futures_snapshot wants `symbols` (CSV string), NOT `symbol`. Same
    // shape as get_futures_instruments from Sunday's resolver work. A single
    // symbol is passed as a one-element CSV.
    const resp = await getFuturesSnapshot({ symbols: brokerCode });
    const last = _extractLast(resp);
    if (!Number.isFinite(last)) {
      return { tvSymbol, ok: false, reason: 'NO_PRICE_IN_RESPONSE', brokerCode };
    }
    return { tvSymbol, ok: true, last, brokerCode };
  } catch (e) {
    return { tvSymbol, ok: false, reason: (e.message || 'unknown').slice(0, 80), brokerCode };
  }
}

// Recognise the Webull-account-doesn't-have-US-futures-quotes case so we can
// stop hammering MCP (80 req/min of guaranteed 401s) and surface a useful
// message instead of a generic STALE. Matches the substrings the upstream
// Webull SDK includes verbatim: "Unauthorized", "Insufficient permission",
// "US_FUTURES". Per-process flag — restart will re-probe once.
function _isEntitlementError(reason) {
  if (!reason) return false;
  return /unauthorized|insufficient permission|us_futures/i.test(reason);
}

async function _tick() {
  if (isMCPDisabled() || isIntegrationHalted()) return;
  if (_entitlementBlocked) return;
  const results = await Promise.allSettled(INSTRUMENTS.map(s => _pollOne(s)));
  const cache = _readCache();
  const now = Date.now();
  const et  = _etTimeString();

  // If any tick comes back with an entitlement error, it's an account-level
  // problem (not per-symbol) — disable the poller and mark all instruments
  // STALE with the actionable reason.
  const entitlementHit = results.find(r =>
    r.status === 'fulfilled' && _isEntitlementError(r.value?.reason)
  );
  if (entitlementHit) {
    _entitlementBlocked = true;
    if (_timer) { clearInterval(_timer); _timer = null; }
    console.log(`  [FUT_PRICER] DISABLED — Webull account lacks US_FUTURES quote entitlement`);
    console.log(`  [FUT_PRICER] reason: ${entitlementHit.value.reason}`);
    console.log(`  [FUT_PRICER] options: (a) subscribe to US_FUTURES quotes via Webull, (b) switch price source to TradingView CDP, (c) accept Pine-alert-only price updates`);
    for (const sym of INSTRUMENTS) {
      const prev = cache[sym] || {};
      cache[sym] = {
        ...prev,
        stale: true,
        staleSince: prev.staleSince || now,
        lastFailReason: 'WEBULL_US_FUTURES_NOT_SUBSCRIBED',
      };
    }
    _writeCache(cache);
    return;
  }

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const v = r.value;
    if (v.ok) {
      _failCount.set(v.tvSymbol, 0);
      _loggedStale.delete(v.tvSymbol);
      cache[v.tvSymbol] = {
        ...(cache[v.tvSymbol] || {}),
        last: v.last,
        price: v.last,            // back-compat for old readers
        ts: now,
        et,
        src: 'webull-snapshot',
        brokerCode: v.brokerCode,
        stale: false,
        staleSince: null,
        lastFailReason: null,
      };
    } else {
      const next = (_failCount.get(v.tvSymbol) || 0) + 1;
      _failCount.set(v.tvSymbol, next);
      if (next >= STALE_AFTER_FAILS) {
        const prev = cache[v.tvSymbol] || {};
        cache[v.tvSymbol] = {
          ...prev,
          stale: true,
          staleSince: prev.staleSince || now,
          lastFailReason: v.reason,
          failCount: next,
        };
        if (!_loggedStale.has(v.tvSymbol)) {
          console.log(`  [FUT_PRICER] ${v.tvSymbol} → STALE (${next} consecutive fails, reason: ${v.reason})`);
          _loggedStale.add(v.tvSymbol);
        }
      }
    }
  }

  _writeCache(cache);
}

export function startFuturesPricer() {
  if (_started) return;
  if (isMCPDisabled() || isIntegrationHalted()) {
    console.log(`  [FUT_PRICER] skipped — MCP disabled or integration halted`);
    return;
  }
  _started = true;
  console.log(`  [FUT_PRICER] starting — ${INSTRUMENTS.join(', ')} every ${POLL_MS}ms via Webull MCP get_futures_snapshot`);
  setTimeout(() => {
    _tick().catch(e => console.error(`  [FUT_PRICER] initial tick error: ${e.message}`));
  }, INITIAL_DELAY_MS);
  _timer = setInterval(() => {
    _tick().catch(e => console.error(`  [FUT_PRICER] tick error: ${e.message}`));
  }, POLL_MS);
}

export function stopFuturesPricer() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _started = false;
}
