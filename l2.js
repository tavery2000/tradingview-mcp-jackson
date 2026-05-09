#!/usr/bin/env node
/**
 * l2.js — HANK L2 Order Flow Engine (Volume Delta proxy)
 * Built by NYC2000
 *
 * Derives order flow signals from Volume Delta already read by monitor.js.
 * Reads spy-levels.json, qqq-levels.json, iwm-levels.json every 5s.
 * No external subscriptions needed — zero additional cost.
 *
 * Volume Delta as L2 proxy:
 *   Positive delta = net buyer aggression (like heavy bid stack)
 *   Negative delta = net seller aggression (like heavy ask stack)
 *   This is more accurate than resting L2 for options flow decisions
 *   because it shows EXECUTED flow, not just quotes.
 *
 * When Unusual Whales ($150/mo) is ready, replace this file.
 *
 * Usage:
 *   Standalone: node l2.js
 *   Imported:   import { getL2Signal, getL2Snapshot } from './l2.js'
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath }            from 'url';
import { dirname, join }            from 'path';
import { config }                   from 'dotenv';

config({ path: join(dirname(fileURLToPath(import.meta.url)), '.env') });

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────

const INSTRUMENTS  = ['SPY', 'QQQ', 'IWM'];
const POLL_MS      = 5_000;   // read state files every 5s
const DISPLAY_MS   = 10_000;  // terminal refresh every 10s
const STALE_MS     = 60_000;  // signal stale after 60s

// Delta thresholds for bias classification
// SPY: larger absolute values — use higher thresholds
// QQQ/IWM: smaller — use lower thresholds
const THRESHOLDS = {
  SPY: { strong: 5000, mild: 1000 },
  QQQ: { strong: 3000, mild:  500 },
  IWM: { strong: 2000, mild:  300 },
};

const STATE_FILES = {
  SPY: join(__dirname, 'spy-levels.json'),
  QQQ: join(__dirname, 'qqq-levels.json'),
  IWM: join(__dirname, 'iwm-levels.json'),
};

// ─── Colors ───────────────────────────────────────────────────────────────────

const C = {
  reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
  red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m',
  cyan:'\x1b[36m', gray:'\x1b[90m',
};

// ─── Signal Store ─────────────────────────────────────────────────────────────

const l2Store = new Map();

function emptySnapshot(symbol) {
  return { symbol, delta:null, bias:'NEUTRAL', strength:0, imbalance:null, ts:0 };
}

function parseDelta(str) {
  if (str == null) return null;
  let s = str.toString().replace(/,/g,'').replace(/\u2212/g,'-').trim();
  let mult = 1;
  if (/K$/i.test(s)) { mult=1_000;     s=s.slice(0,-1); }
  if (/M$/i.test(s)) { mult=1_000_000; s=s.slice(0,-1); }
  const n = parseFloat(s);
  return isNaN(n) ? null : n * mult;
}

function classifyDelta(symbol, delta) {
  if (delta == null) return { bias:'NEUTRAL', strength:0, imbalance:null };
  const t = THRESHOLDS[symbol] ?? THRESHOLDS.IWM;

  // Convert delta to imbalance-like 0–1 scale for compatibility
  // Clamp delta to [-strong*3, strong*3] range then normalize
  const clamp  = t.strong * 3;
  const clamped = Math.max(-clamp, Math.min(clamp, delta));
  const imbalance = (clamped / (clamp * 2)) + 0.5; // 0 to 1

  let bias, strength;
  if (delta >= t.strong)       { bias='BULLISH'; strength=3; }
  else if (delta >= t.mild)    { bias='BULLISH'; strength=2; }
  else if (delta > 0)          { bias='BULLISH'; strength=1; }
  else if (delta <= -t.strong) { bias='BEARISH'; strength=3; }
  else if (delta <= -t.mild)   { bias='BEARISH'; strength=2; }
  else if (delta < 0)          { bias='BEARISH'; strength=1; }
  else                         { bias='NEUTRAL'; strength=0; }

  return { bias, strength, imbalance };
}

function readStateFile(symbol) {
  const file = STATE_FILES[symbol];
  if (!file || !existsSync(file)) return null;
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    if (!d.ts || Date.now() - d.ts > STALE_MS) return null;
    return d;
  } catch { return null; }
}

function updateAll() {
  for (const sym of INSTRUMENTS) {
    const state = readStateFile(sym);
    if (!state) {
      // Keep last known if available, just mark potentially stale
      if (!l2Store.has(sym)) l2Store.set(sym, emptySnapshot(sym));
      continue;
    }

    const delta  = typeof state.delta === 'number' ? state.delta : parseDelta(state.delta);
    const { bias, strength, imbalance } = classifyDelta(sym, delta);

    l2Store.set(sym, {
      symbol:    sym,
      delta,
      bias,
      strength,
      imbalance,
      price:     state.current ?? state.price ?? null,
      vwap:      state.vwap ?? null,
      ts:        state.ts ?? Date.now(),
    });
  }
}

// ─── Exports (same interface as original l2.js) ────────────────────────────────

export function getL2Signal(symbol) {
  const s = l2Store.get(symbol?.toUpperCase());
  if (!s || !s.ts || Date.now() - s.ts > STALE_MS) return null;
  return { imbalance: s.imbalance, bias: s.bias, strength: s.strength };
}

export function getL2Snapshot(symbol) {
  return l2Store.get(symbol?.toUpperCase()) ?? emptySnapshot(symbol?.toUpperCase());
}

// ─── Display ──────────────────────────────────────────────────────────────────

function fmtDelta(n) {
  if (n == null) return '     N/A';
  const sign = n >= 0 ? '+' : '-';
  const abs  = Math.abs(n);
  let s = abs >= 1_000_000 ? (abs/1_000_000).toFixed(2)+'M'
        : abs >= 1_000     ? (abs/1_000).toFixed(1)+'K'
        : Math.round(abs).toString();
  return (sign+s).padStart(9);
}

function fmtBias(bias, strength) {
  const stars = '●'.repeat(strength) + '○'.repeat(3-strength);
  if (bias==='BULLISH') return C.green+C.bold+'BUY  '+C.reset+C.green+stars+C.reset;
  if (bias==='BEARISH') return C.red  +C.bold+'SELL '+C.reset+C.red  +stars+C.reset;
  return C.gray+'NTRL '+stars+C.reset;
}

function getETString() {
  return new Date().toLocaleTimeString('en-US',{
    timeZone:'America/New_York',hour12:false,
    hour:'2-digit',minute:'2-digit',second:'2-digit'
  });
}

function printL2Panel() {
  const line = '  ' + '─'.repeat(62);
  console.log(`\n${line}`);
  console.log(`  ${C.bold}L2 ORDER FLOW${C.reset}  ${C.dim}Volume Delta proxy · ${getETString()} ET${C.reset}`);
  console.log(line);
  console.log(`  ${C.dim}SYM    DELTA         PRICE     VWAP      BIAS      STR${C.reset}`);
  console.log(line);

  for (const sym of INSTRUMENTS) {
    const s = l2Store.get(sym);
    if (!s || !s.ts) {
      console.log(`  ${C.bold}${sym.padEnd(6)}${C.reset} ${C.gray}awaiting monitor.js data...${C.reset}`);
      continue;
    }
    const stale = Date.now() - s.ts > STALE_MS;
    if (stale) {
      console.log(`  ${C.bold}${sym.padEnd(6)}${C.reset} ${C.yellow}stale — monitor.js may be stopped${C.reset}`);
      continue;
    }

    const dCol = s.delta > 0 ? C.green : s.delta < 0 ? C.red : C.gray;
    console.log(
      `  ${C.bold}${sym.padEnd(6)}${C.reset}` +
      ` ${dCol}${fmtDelta(s.delta)}${C.reset}` +
      `  ${s.price?.toFixed(2).padStart(8) ?? '     N/A'}` +
      `  ${s.vwap?.toFixed(2).padStart(8)  ?? '     N/A'}` +
      `  ${fmtBias(s.bias, s.strength)}`
    );
  }
  console.log(line);
  console.log(`  ${C.dim}Source: spy/qqq/iwm-levels.json  |  Written by monitor.js every 30s${C.reset}`);
  console.log(`  ${C.dim}Upgrade: Unusual Whales API ($150/mo) for real options flow${C.reset}`);
  console.log(line);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold+'\n  HANK L2 ORDER FLOW — Volume Delta Proxy'+C.reset);
  console.log(`  Instruments: ${INSTRUMENTS.join(', ')}`);
  console.log(`  Source:      spy/qqq/iwm-levels.json (written by monitor.js)`);
  console.log(`  Poll:        every ${POLL_MS/1000}s`);
  console.log(`  ${C.dim}Upgrade to Unusual Whales ($150/mo) for real options flow${C.reset}\n`);

  // Initial read
  updateAll();

  // Poll state files
  setInterval(updateAll, POLL_MS);

  // Display
  setInterval(printL2Panel, DISPLAY_MS);
  printL2Panel();

  process.on('SIGINT', () => {
    console.log(`\n\n  ${C.gray}L2 stopped.${C.reset}\n`);
    process.exit(0);
  });
}

const isMain = process.argv[1] &&
  (process.argv[1].endsWith('l2.js') || process.argv[1].endsWith('l2'));
if (isMain) main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
