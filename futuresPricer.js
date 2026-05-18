/**
 * futuresPricer.js — TradingView CDP futures price poller
 *
 * 2026-05-18 morning: was Webull MCP get_futures_snapshot. Webull paper
 * account returned 401 Unauthorized on every call (missing US_FUTURES
 * quote entitlement), so we switched data source to the TV Desktop
 * watchlist via CDP (port 9222). Webull MCP stays parked for the June 1
 * order-placement flip; this module no longer talks to it.
 *
 * Data flow:
 *   1. tvPriceClient.getFuturesWatchlistPrices() — one CDP evaluate, all
 *      four contracts at once, no chart change
 *   2. read latest-prices.json (preserve other instruments' entries)
 *   3. for each ES1!/NQ1!/MES1!/MNQ1!: write fresh entry on hit,
 *      increment fail counter on miss
 *   4. flush
 *
 * Failure handling:
 *   - Whole-tick failure (TV closed, CDP down, scraper error like
 *     "panel_closed") → increment fail counter for ALL instruments
 *   - Per-symbol miss (symbol not in watchlist or no numeric cell) →
 *     increment fail counter for that symbol only
 *   - 3 consecutive fails per instrument → write { stale: true,
 *     staleSince, lastFailReason } for futures-status.js to render
 *
 * Skip entirely when MCP-disabled or integration-halted — those are
 * Webull-side knobs but they remain a coarse "stop background load"
 * signal for any external feed work.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isMCPDisabled, isIntegrationHalted } from './webull-mcp-client.js';
import { getFuturesWatchlistPrices } from './tvPriceClient.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const PRICE_FILE = join(__dirname, 'latest-prices.json');
const POLL_MS    = parseInt(process.env.FUT_PRICER_POLL_MS || '3000', 10);
const INSTRUMENTS = (process.env.FUT_PRICER_SYMBOLS || 'ES1!,NQ1!,MES1!,MNQ1!')
  .split(',').map(s => s.trim()).filter(Boolean);
const STALE_AFTER_FAILS = parseInt(process.env.FUT_PRICER_STALE_FAILS || '3', 10);
const INITIAL_DELAY_MS  = parseInt(process.env.FUT_PRICER_INITIAL_DELAY_MS || '3000', 10);

const _failCount = new Map();
let _started = false;
let _timer   = null;
const _loggedStale = new Set();

function _etTimeString() {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour12: false,
  });
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

function _markFresh(cache, sym, last, now, et) {
  _failCount.set(sym, 0);
  _loggedStale.delete(sym);
  cache[sym] = {
    ...(cache[sym] || {}),
    last,
    price: last,
    ts: now,
    et,
    src: 'tv-watchlist',
    stale: false,
    staleSince: null,
    lastFailReason: null,
  };
}

function _markFailed(cache, sym, reason, now) {
  const next = (_failCount.get(sym) || 0) + 1;
  _failCount.set(sym, next);
  if (next >= STALE_AFTER_FAILS) {
    const prev = cache[sym] || {};
    cache[sym] = {
      ...prev,
      stale: true,
      staleSince: prev.staleSince || now,
      lastFailReason: reason,
      failCount: next,
    };
    if (!_loggedStale.has(sym)) {
      console.log(`  [FUT_PRICER] ${sym} → STALE (${next} consecutive fails, reason: ${reason})`);
      _loggedStale.add(sym);
    }
  }
}

async function _tick() {
  if (isMCPDisabled() || isIntegrationHalted()) return;

  let prices = null;
  let tickError = null;
  try {
    prices = await getFuturesWatchlistPrices();
  } catch (e) {
    tickError = (e.message || 'unknown').slice(0, 80);
  }

  const cache = _readCache();
  const now = Date.now();
  const et  = _etTimeString();

  if (tickError) {
    // Whole-tick failure — every target instrument counts as a fail this tick
    for (const sym of INSTRUMENTS) _markFailed(cache, sym, tickError, now);
  } else {
    for (const sym of INSTRUMENTS) {
      const last = prices?.[sym];
      if (Number.isFinite(last)) {
        _markFresh(cache, sym, last, now, et);
      } else {
        _markFailed(cache, sym, 'NOT_IN_WATCHLIST_OR_NO_PRICE', now);
      }
    }
  }

  _writeCache(cache);
}

export function startFuturesPricer() {
  if (_started) return;
  _started = true;
  console.log(`  [FUT_PRICER] starting — ${INSTRUMENTS.join(', ')} every ${POLL_MS}ms via TV CDP watchlist`);
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
