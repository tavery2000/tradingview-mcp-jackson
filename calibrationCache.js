/**
 * calibrationCache.js — in-memory lookup cache for confidence calibration
 *
 * Phase 1 Additional (2026-05-16): runtime architecture for the analyzer
 * output (data/calibration-lookup.json). Reads on first use, caches as a
 * Map keyed by cell-key, throttle-watches the file mtime so re-runs of
 * analyze-calibration.js are picked up automatically.
 *
 * Exports:
 *   lookupCalibration(attrs)  — sync; walks L1→L5 fallback, returns the
 *                               first hit with sample_size ≥ threshold.
 *   reloadCache()             — force re-read of the JSON file.
 *   getCacheStats()           — { entries, mtime, lastReadAt }.
 *
 * Cache invalidation: on each lookup, IF time-since-last-stat > 10s, run
 * fs.statSync on the file; reload if mtime changed. Keeps hot-path I/O at
 * roughly one stat per 10 seconds regardless of trade frequency.
 *
 * Fallback default when all 5 levels miss: { multiplier: 1.0, action:
 * 'default', level: null, key: null, blocked_reason: null, fallback: true }.
 * Caller is expected to log this — see paperTrading.sendOrder.
 */

import { readFileSync, statSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOOKUP_FILE = join(__dirname, 'data', 'calibration-lookup.json');
const STAT_THROTTLE_MS = 10_000;

let _cache = new Map();              // key (string) → cell (object)
let _byLevel = { 1: [], 2: [], 3: [], 4: [], 5: [] };
let _mtimeMs = 0;
let _lastReadAt = null;
let _lastStatAt = 0;
let _loaded = false;
let _meta = { version: null, sample_size_threshold: 20 };

function _macroToBias(macro4H) {
  switch ((macro4H || '').toUpperCase()) {
    case 'UP':      return 'bullish';
    case 'DOWN':    return 'bearish';
    case 'RANGING': return 'coiled';
    case 'UNKNOWN': return 'neutral';
    default:        return 'unknown';
  }
}

function _doLoad() {
  if (!existsSync(LOOKUP_FILE)) {
    _cache = new Map();
    _byLevel = { 1: [], 2: [], 3: [], 4: [], 5: [] };
    _mtimeMs = 0;
    _loaded = false;
    return false;
  }
  try {
    const stat = statSync(LOOKUP_FILE);
    const data = JSON.parse(readFileSync(LOOKUP_FILE, 'utf8'));
    _cache = new Map();
    _byLevel = { 1: [], 2: [], 3: [], 4: [], 5: [] };
    for (const cell of data.cells || []) {
      _cache.set(cell.key, cell);
      if (_byLevel[cell.level]) _byLevel[cell.level].push(cell.key);
    }
    _mtimeMs = stat.mtimeMs;
    _lastReadAt = new Date().toISOString();
    _meta = {
      version: data.version,
      sample_size_threshold: data.sample_size_threshold ?? 20,
      generated: data.generated,
      total_trades_after_exclusions: data.total_trades_after_exclusions,
    };
    _loaded = true;
    return true;
  } catch {
    return false;
  }
}

function _maybeReloadFromMtime() {
  const now = Date.now();
  if (now - _lastStatAt < STAT_THROTTLE_MS) return;
  _lastStatAt = now;
  if (!existsSync(LOOKUP_FILE)) return;
  try {
    const stat = statSync(LOOKUP_FILE);
    if (stat.mtimeMs !== _mtimeMs) _doLoad();
  } catch {}
}

export function reloadCache() {
  _lastStatAt = 0;   // bypass throttle
  return _doLoad();
}

export function getCacheStats() {
  if (!_loaded) _doLoad();
  return {
    loaded: _loaded,
    entries: _cache.size,
    by_level: Object.fromEntries(Object.entries(_byLevel).map(([k, v]) => [k, v.length])),
    mtime: _mtimeMs ? new Date(_mtimeMs).toISOString() : null,
    last_read_at: _lastReadAt,
    file: LOOKUP_FILE,
    meta: _meta,
  };
}

/**
 * Look up calibration for a candidate trade.
 *
 * @param {Object} attrs
 * @param {string} attrs.engine
 * @param {string} attrs.conf            HIGH | MEDIUM
 * @param {string} attrs.macro4H         raw macro4H (mapped to bias internally)
 * @param {string} attrs.instrument
 * @param {string} attrs.timeBucket      e.g. '10:00-11:00'
 * @param {string} attrs.sessionType     REGULAR | GLOBEX_EVENING | GLOBEX_NIGHT | PREMARKET
 * @param {string} attrs.direction       CALLS | PUTS
 *
 * @returns {Object} {
 *   key, level, multiplier, action, blocked_reason,
 *   sample_size, win_rate, profit_factor, expectancy,
 *   fallback (true if defaulted)
 * }
 */
export function lookupCalibration(attrs = {}) {
  if (!_loaded) _doLoad();
  _maybeReloadFromMtime();

  const engine     = (attrs.engine || 'UNKNOWN').toUpperCase();
  const conf       = (attrs.conf || 'UNKNOWN').toUpperCase();
  const bias       = _macroToBias(attrs.macro4H);
  const instrument = (attrs.instrument || 'UNKNOWN').toUpperCase();
  const timeBucket = attrs.timeBucket || 'UNKNOWN';
  const sessionType = attrs.sessionType || 'UNKNOWN';
  const direction  = (attrs.direction || 'UNKNOWN').toUpperCase();

  // Walk L1 → L5
  const keys = [
    `${engine}_${conf}_${bias}_${instrument}_${timeBucket}_${direction}`,    // L1
    `${engine}_${conf}_${bias}_${instrument}_${sessionType}_${direction}`,   // L2
    `${engine}_${conf}_${bias}_${instrument}_${direction}`,                  // L3
    `${engine}_${conf}_${instrument}`,                                       // L4
    `${engine}`,                                                             // L5
  ];

  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const cell = _cache.get(k);
    if (cell) {
      return {
        key: k,
        level: i + 1,
        multiplier: cell.size_multiplier,
        action: cell.action,
        blocked_reason: cell.blocked_reason || null,
        sample_size: cell.sample_size,
        win_rate: cell.win_rate,
        profit_factor: cell.profit_factor,
        expectancy: cell.expectancy,
        fallback: false,
      };
    }
  }

  // All levels missed — default no-change multiplier
  return {
    key: null,
    level: null,
    multiplier: 1.0,
    action: 'default',
    blocked_reason: null,
    sample_size: 0,
    fallback: true,
  };
}
