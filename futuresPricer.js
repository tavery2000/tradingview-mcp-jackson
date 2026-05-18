/**
 * futuresPricer.js — TradingView CDP futures price poller (stateless)
 *
 * 2026-05-18 morning: switched data source Webull MCP → TV CDP watchlist
 * after Webull paper account lacked US_FUTURES quote entitlement.
 *
 * 2026-05-18 mid-RTH: stripped the fail-counter / stale-flag layer that
 * caused a persistent "STALE" display state operator couldn't clear even
 * with restart. The fail counter lived in-memory, but the `stale: true`
 * flag it wrote to latest-prices.json persisted on disk — new webhook
 * boots, futures-status reads the file BEFORE first successful tick,
 * renders STALE. Now: each tick stands alone. Success → overwrite last+ts
 * with no stale fields. Failure → log + leave cache untouched (preserves
 * last-known prices for futures-status to render with age coloring).
 *
 * Auto-recovery is implicit: every tick re-attempts CDP fetch regardless
 * of prior outcome. No counters, no persistence, no boot-time stale read.
 *
 * Skip entirely when MCP-disabled or integration-halted (coarse "stop
 * background load" knob — these are Webull flags but the spirit applies).
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
const INITIAL_DELAY_MS = parseInt(process.env.FUT_PRICER_INITIAL_DELAY_MS || '500', 10);

let _started = false;
let _timer   = null;

function _etTimeString() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
}

function _readCache() {
  try {
    if (!existsSync(PRICE_FILE)) return {};
    return JSON.parse(readFileSync(PRICE_FILE, 'utf8')) || {};
  } catch { return {}; }
}

function _writeCache(cache) {
  try { writeFileSync(PRICE_FILE, JSON.stringify(cache, null, 2)); }
  catch (e) { console.error(`  [FUT_PRICER] write fail: ${e.message}`); }
}

// Clean the cache entry of any vestigial stale-era fields. Used on every
// successful tick so latest-prices.json doesn't keep old stale/failCount
// fields around forever after the schema simplification.
function _freshEntry(last, now, et) {
  return { last, price: last, ts: now, et, src: 'tv-watchlist' };
}

// Single tick. Caller (interval OR /control/repoll-futures) handles
// scheduling. Returns a summary suitable for HTTP responses.
export async function tickOnce() {
  if (isMCPDisabled() || isIntegrationHalted()) {
    return { skipped: true, reason: 'MCP_DISABLED_OR_INTEGRATION_HALT' };
  }
  const t0 = Date.now();
  let prices = null;
  let error = null;
  try {
    prices = await getFuturesWatchlistPrices();
  } catch (e) {
    error = (e.message || 'unknown').slice(0, 120);
  }
  const dur = Date.now() - t0;
  const et  = _etTimeString();

  if (error) {
    console.log(`  [FUT_PRICER] ${et}  ✗ ${error}  (${dur}ms)`);
    return { ok: false, error, durationMs: dur, et };
  }

  const cache = _readCache();
  const hits = [];
  const misses = [];
  for (const sym of INSTRUMENTS) {
    const last = prices?.[sym];
    if (Number.isFinite(last)) {
      cache[sym] = _freshEntry(last, t0, et);
      hits.push(`${sym}=${last}`);
    } else {
      misses.push(sym);
    }
  }
  _writeCache(cache);
  console.log(`  [FUT_PRICER] ${et}  ✓ ${hits.length}/${INSTRUMENTS.length}  ${hits.join(' ')}${misses.length ? '  miss:' + misses.join(',') : ''}  (${dur}ms)`);
  return { ok: true, hits: hits.length, misses, durationMs: dur, et, prices };
}

export function startFuturesPricer() {
  if (_started) return;
  _started = true;
  console.log(`  [FUT_PRICER] starting — ${INSTRUMENTS.join(', ')} every ${POLL_MS}ms via TV CDP watchlist (stateless per-tick)`);
  setTimeout(() => {
    tickOnce().catch(e => console.error(`  [FUT_PRICER] initial tick uncaught: ${e.message}`));
  }, INITIAL_DELAY_MS);
  _timer = setInterval(() => {
    tickOnce().catch(e => console.error(`  [FUT_PRICER] tick uncaught: ${e.message}`));
  }, POLL_MS);
}

export function stopFuturesPricer() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _started = false;
}
