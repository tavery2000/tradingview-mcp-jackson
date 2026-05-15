#!/usr/bin/env node
/**
 * moc-engine.js — MOC (Market-On-Close) Engine v2
 *
 * Latency-aware MOC engine. Financial Juice MOC data arrives ~60s after the
 * actual 15:50 NYSE publication. HANK treats this as CONFIRMATION, not lead.
 *
 * Architecture:
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │  15:45  ENGINE ARMS — begins watching SPY tick baseline             │
 *   │  15:50  SPY trend snapshot locked (price, delta, vwap, bias)        │
 *   │  15:51  FJ MOC data arrives → chase gate + conviction scoring       │
 *   │  15:52–15:58  Active — re-score every 30s, early exit if needed     │
 *   │  15:59  HARD EXIT — no exceptions                                   │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * Entry gates (all must pass):
 *   1. Chase gate   — SPY has NOT moved >CHASE_PCT since 15:50 snapshot
 *   2. Trend agrees — SPY bias at 15:50 matches imbalance direction
 *   3. Delta confirms — live delta still shows sellers/buyers active
 *   4. Momentum     — price trending toward expected direction
 *   5. Conviction   — score >= MIN_CONVICTION (0–5)
 *
 * Active re-score loop (15:52–15:58, every 30s):
 *   - Delta flipped?          → early exit
 *   - Price at S/R?           → early exit
 *   - Conviction collapsed?   → early exit
 *
 * Data:
 *   moc-data.json  written by moo-moc.js when FJ MOC alert fires
 *   wsServer :8765 monitor.js SIGNAL+TICK (spyPrice, spyDelta, spyVwap, spyBias, spyLevels)
 *   paper-ledger.json  paperTrading.js order log
 *
 * Usage: node moc-engine.js   (Window 6, alongside monitor.js + moo-moc.js)
 */

import { startHeartbeat } from './heartbeat.js';
startHeartbeat('moc-engine.js');
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { fileURLToPath }  from 'url';
import { dirname, join }  from 'path';
import WebSocket          from 'ws';
import { interpretIVR }   from './theta.js';
import { journal, jAlert, jError } from './journal.js';
import { sendOrder, closePosition, orderGate } from './paperTrading.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────

const MOC_DATA_PATH  = join(__dirname, 'moc-data.json');
const SPY_LEVELS_PATH = join(__dirname, 'spy-levels.json');
const PAPER_LEDGER   = join(__dirname, 'paper-ledger.json');
const HANK_STATS     = join(__dirname, 'hank_stats.json');
const WS_PORT        = 8765;

// Time gates (ET, in total minutes from midnight)
const ARM_MINUTE      = 15 * 60 + 45;   // 15:45 — arm
const SNAPSHOT_MINUTE = 15 * 60 + 50;   // 15:50 — lock SPY snapshot
const CONFIRM_MINUTE  = 15 * 60 + 51;   // 15:51 — earliest FJ data expected
const EXIT_MINUTE     = 15 * 60 + 59;   // 15:59 — hard exit

// Entry thresholds
const CHASE_PCT      = 0.15;            // % — abort if SPY already moved this far
const MIN_CONVICTION = 2;               // minimum score to enter (0–5)
const STALE_MS       = 6 * 60 * 60 * 1000;

// Active loop
const RESCORE_MS     = 30_000;

// Strike targeting
const PREMIUM_MIN    = 0.20;
const PREMIUM_MAX    = 0.30;

// Contract sizing by conviction score
const CONTRACTS = { 5: 6, 4: 5, 3: 3, 2: 2, 1: 1, 0: 0 };

// ─── Colors ───────────────────────────────────────────────────────────────────

const C = {
  reset:    '\x1b[0m',  bold:     '\x1b[1m',  dim:      '\x1b[2m',
  green:    '\x1b[32m', red:      '\x1b[31m',  yellow:   '\x1b[33m',
  cyan:     '\x1b[36m', gray:     '\x1b[90m',  white:    '\x1b[97m',
  bgGreen:  '\x1b[42m\x1b[30m',
  bgRed:    '\x1b[41m\x1b[97m',
  bgYellow: '\x1b[43m\x1b[30m',
  bgCyan:   '\x1b[46m\x1b[30m',
};

// ─── ET helpers ───────────────────────────────────────────────────────────────

function etMinutes() {
  const t = new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour12: false,
    hour: '2-digit', minute: '2-digit',
  });
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function etNow() {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function etDate() {
  return new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2');
}

// ─── Live state (populated by wsServer) ──────────────────────────────────────

/**
 * wsServer message contract (monitor.js broadcasts this every 30s):
 *
 * { type: 'SIGNAL', data: {
 *     action, confidence, reason,
 *     spyPrice, spyDelta, spyVwap, spyBias,
 *     spyLevels: { support: [{price,label}], resistance: [{price,label}] },
 *     bulls, bears, timestamp
 * }}
 *
 * { type: 'TICK', data: { spyPrice, spyDelta, spyVwap, spyBias, timestamp }}
 */
let live = {
  spyPrice:  null,
  spyDelta:  null,
  spyVwap:   null,
  spyBias:   null,
  spyLevels: null,
  lastTick:  0,
};

// ─── 15:50 snapshot ──────────────────────────────────────────────────────────

let snapshot       = null;   // locked at 15:50
let snapshotLocked = false;

function tryLoadSpyLevels() {
  // Fallback: read spy-levels.json written by monitor.js
  if (!existsSync(SPY_LEVELS_PATH)) return;
  try {
    const sl = JSON.parse(readFileSync(SPY_LEVELS_PATH, 'utf8'));
    const ageMs = Date.now() - (sl.ts ?? 0);
    if (ageMs > 10 * 60 * 1000) return; // stale > 10 min
    if (sl.current   != null && live.spyPrice == null) live.spyPrice = sl.current;
    if (sl.vwap      != null && live.spyVwap  == null) live.spyVwap  = sl.vwap;
    if (sl.bias      != null && live.spyBias  == null) live.spyBias  = sl.bias;
    live.lastTick = sl.ts ?? Date.now();
    console.log(`  ${C.cyan}[MOC] spy-levels.json loaded — SPY $${sl.current?.toFixed(2)} ${sl.bias}${C.reset}`);
  } catch { /* non-fatal */ }
}

function lockSnapshot() {
  // Try wsServer first, fall back to spy-levels.json
  if (!live.spyPrice) tryLoadSpyLevels();

  if (!live.spyPrice) {
    console.log(`  ${C.yellow}[MOC] Cannot lock snapshot — no SPY price from wsServer or spy-levels.json${C.reset}`);
    return;
  }
  snapshot = { ...live, lockedAt: etNow() };
  const tC = live.spyBias?.includes('bull') ? C.green : C.red;
  console.log(`\n  ${C.bold}[MOC] 15:50 SNAPSHOT LOCKED${C.reset}`);
  console.log(`  SPY:    $${snapshot.spyPrice.toFixed(2)}`);
  console.log(`  Bias:   ${tC}${snapshot.spyBias}${C.reset}`);
  console.log(`  Delta:  ${fmtDelta(snapshot.spyDelta)}`);
  console.log(`  VWAP:   $${snapshot.spyVwap?.toFixed(2)}`);
  console.log(`  ${C.dim}Waiting for Financial Juice MOC data...${C.reset}\n`);
}

// ─── MOC data ─────────────────────────────────────────────────────────────────

function readMocData() {
  if (!existsSync(MOC_DATA_PATH)) return null;
  try {
    const d = JSON.parse(readFileSync(MOC_DATA_PATH, 'utf8'));
    const age = Date.now() - (d.ts ?? d.timestamp ?? 0);
    if (age > STALE_MS) return null;
    if (d.type !== 'MOC') return null;
    // Derive direction from spNet/spNetM — ground truth, beats any stored signal/direction field
    if (d.spNet  != null) d.direction = d.spNet  >= 0 ? 'BUY' : 'SELL';
    else if (d.spNetM != null) d.direction = d.spNetM >= 0 ? 'BUY' : 'SELL';
    else if (!d.direction && d.signal === 'CALLS') d.direction = 'BUY';
    else if (!d.direction && d.signal === 'PUTS')  d.direction = 'SELL';
    // Derive netShares from dollar amount (share-equivalent at SPY ~$500)
    if (!d.netShares && d.spNetM) d.netShares = Math.round(Math.abs(d.spNetM) * 1e6 / 500);
    if (!d.netShares && d.spNet)  d.netShares = Math.round(Math.abs(d.spNet) / 500);
    return d;
  } catch { return null; }
}

// ─── Chase gate ───────────────────────────────────────────────────────────────

/**
 * Returns how far SPY has moved (%) in the expected direction since snapshot.
 * If > CHASE_PCT, the MOC move is already priced in — no trade.
 */
function chaseCheck(expectedDir) {
  if (!snapshot?.spyPrice || !live.spyPrice) {
    return { pass: true, pct: null, reason: 'no snapshot — skipping chase check' };
  }
  const rawMove     = (live.spyPrice - snapshot.spyPrice) / snapshot.spyPrice * 100;
  const directedPct = expectedDir === 'PUTS' ? -rawMove : rawMove;

  if (directedPct > CHASE_PCT) {
    return {
      pass:   false,
      pct:    directedPct,
      reason: `SPY already +${directedPct.toFixed(3)}% in ${expectedDir} direction — chased (limit ${CHASE_PCT}%)`,
    };
  }
  return {
    pass:   true,
    pct:    directedPct,
    reason: `SPY ${directedPct >= 0 ? '+' : ''}${directedPct.toFixed(3)}% — within chase limit ✓`,
  };
}

// ─── Conviction scoring ───────────────────────────────────────────────────────

/**
 * 0–5 score across 4 weighted factors.
 *
 * Factor                   Max   Logic
 * ────────────────────────────────────────────────────────────────
 * Imbalance size            2    net shares vs thresholds
 * SPY trend at 15:50 agrees 1    snapshot bias vs imbalance direction
 * Live delta confirms       1    current sellers/buyers still active
 * Momentum active           1    price moving in direction, not chased
 */
function scoreConviction(mocData, expectedDir) {
  const factors = [];
  let total = 0;

  // ── 1. Imbalance size (0–2) ──────────────────────────────────────────────
  const net = Math.abs(mocData.netShares);
  const sz  = net >= 5_000_000 ? 2 : net >= 1_500_000 ? 1 : 0;
  total += sz;
  factors.push({
    name:   'Imbalance size',
    score:  sz, max: 2,
    detail: `${(net/1e6).toFixed(2)}M net ${mocData.direction}`,
  });

  // ── 2. SPY trend at 15:50 agrees (0–1) ──────────────────────────────────
  let trendScore = 0, trendDetail = 'no snapshot';
  if (snapshot?.spyBias) {
    const snapBull = snapshot.spyBias.includes('bull');
    const wantBull = expectedDir === 'CALLS';
    trendScore  = (wantBull === snapBull) ? 1 : 0;
    trendDetail = trendScore
      ? `SPY was ${snapshot.spyBias} at 15:50 ✓`
      : `SPY was ${snapshot.spyBias} at 15:50 — diverges`;
  }
  total += trendScore;
  factors.push({ name: 'Trend at 15:50', score: trendScore, max: 1, detail: trendDetail });

  // ── 3. Live delta confirms (0–1) ─────────────────────────────────────────
  let deltaScore = 0, deltaDetail = 'no delta';
  if (live.spyDelta != null) {
    const wantNeg  = expectedDir === 'PUTS';
    const confirms = wantNeg ? live.spyDelta < -500 : live.spyDelta > 500;
    deltaScore     = confirms ? 1 : 0;
    deltaDetail    = confirms
      ? `delta ${fmtDelta(live.spyDelta)} confirms ${expectedDir} ✓`
      : `delta ${fmtDelta(live.spyDelta)} not confirming`;
  }
  total += deltaScore;
  factors.push({ name: 'Delta confirms', score: deltaScore, max: 1, detail: deltaDetail });

  // ── 4. Momentum active — not chased, but moving (0–1) ────────────────────
  let momScore = 0, momDetail = 'no data';
  if (snapshot?.spyPrice && live.spyPrice) {
    const raw  = (live.spyPrice - snapshot.spyPrice) / snapshot.spyPrice * 100;
    const dir  = expectedDir === 'PUTS' ? -raw : raw;
    if (dir > 0 && dir <= CHASE_PCT) {
      momScore  = 1;
      momDetail = `+${dir.toFixed(3)}% in direction, not chased ✓`;
    } else if (dir <= 0) {
      momDetail = `price hasn't moved in expected direction (${raw.toFixed(3)}%)`;
    } else {
      momDetail = `${dir.toFixed(3)}% — chased territory`;
    }
  }
  total += momScore;
  factors.push({ name: 'Momentum active', score: momScore, max: 1, detail: momDetail });

  return { score: total, factors };
}

// ─── Strike selection ─────────────────────────────────────────────────────────

function selectStrike(spyPrice, direction, score) {
  if (!spyPrice) return null;
  const otmPct = score >= 4 ? 0.005 : score >= 3 ? 0.006 : 0.008;
  const otmPts = spyPrice * otmPct;
  const type   = direction === 'CALLS' ? 'CALL' : 'PUT';
  const raw    = direction === 'CALLS' ? spyPrice + otmPts : spyPrice - otmPts;
  return {
    underlying: 'XSP',
    optionType: type,
    strike:     Math.round(raw * 2) / 2,
    estimatedPremium: 0.25,
    deltaEst:   direction === 'CALLS' ? 0.15 : -0.15,
    expiry:     etDate(),
    note:       'Estimated — live chain pending Webull approval',
  };
}

// ─── Order + ledger ───────────────────────────────────────────────────────────

export function buildOrder(strike, direction, conviction, contracts) {
  return {
    id:          `MOC-${Date.now()}`,
    source:      'MOC_ENGINE',
    timestamp:   Date.now(),
    underlying:  strike.underlying,
    optionType:  strike.optionType,
    strike:      strike.strike,
    expiry:      strike.expiry,
    action:      'BUY_TO_OPEN',
    contracts,
    limitPrice:  strike.estimatedPremium,
    deltaEst:    strike.deltaEst,
    conviction:  conviction.score,
    hardExitAt:  '15:59 ET',
    status:      'OPEN',
    entrySpyPrice: live.spyPrice,
    entrySpyDelta: live.spyDelta,
    entryTime:   etNow(),
    snapshotBias: snapshot?.spyBias,
  };
}

// Map a moc-engine.js-style `order` to the `consensus` object paperTrading.sendOrder
// expects. paperTrading.js owns the ledger I/O — moc-engine.js stops touching the file
// directly. See ledger-fix-plan.md for the full mapping rationale.
//
// Tag carries 'NO_EXIT_PRICE' so consumers (ASK HANK pnl, tier rolling-100 stats)
// can filter MOC trades out of P&L aggregates until live exit-chain pricing
// lands. Today closePosition() will compute $0 P&L for these trades because
// moc-engine.js doesn't yet track live option premium at exit.
export function mocOrderToConsensus(order, expectedDir, conviction) {
  const score = conviction?.score ?? 0;
  return {
    signal:           expectedDir,                                  // 'CALLS' | 'PUTS'
    engine:           'MOC',
    instrument:       order.underlying,                             // 'XSP'
    strike:           order.strike,
    entryPrice:       order.limitPrice,
    confidence:       score >= 4 ? 'HIGH' : 'MEDIUM',
    finalConfidence:  Math.max(0, Math.min(1, score / 5)),
    contracts:        order.contracts,
    underlyingPrice:  order.entrySpyPrice,
    sessionWindow:    'MOC',
    tag:              'MOC_ENGINE|NO_EXIT_PRICE',
    context: {
      conviction:    score,
      snapshotBias:  order.snapshotBias ?? null,
      entrySpyPrice: order.entrySpyPrice ?? null,
      entrySpyDelta: order.entrySpyDelta ?? null,
      mocSource:     order.source ?? 'MOC_ENGINE',
      expiry:        order.expiry ?? null,
      deltaEst:      order.deltaEst ?? null,
      hardExitAt:    order.hardExitAt ?? '15:59 ET',
    },
  };
}

// ─── Active re-scorer ────────────────────────────────────────────────────────

/**
 * Called every 30s while a position is open.
 * Three early-exit triggers:
 *   1. Delta flipped — the crowd reversed
 *   2. Price within 0.05% of S/R — reversal risk
 *   3. Conviction collapsed to 0
 */
function evaluateExit(order, mocData) {
  const expectedDir = order.optionType === 'CALL' ? 'CALLS' : 'PUTS';
  const exitReasons = [];

  // 1 — Delta flip
  if (live.spyDelta != null) {
    const wantNeg = expectedDir === 'PUTS';
    const flipped = wantNeg ? live.spyDelta > 1000 : live.spyDelta < -1000;
    if (flipped) exitReasons.push(`Delta flipped → ${fmtDelta(live.spyDelta)} (crowd reversed)`);
  }

  // 2 — Near S/R
  if (live.spyLevels && live.spyPrice) {
    if (expectedDir === 'PUTS') {
      const sup = live.spyLevels.support?.[0];
      if (sup) {
        const dist = (live.spyPrice - sup.price) / live.spyPrice * 100;
        if (dist < 0.05) exitReasons.push(`Near support $${sup.price.toFixed(2)} [${sup.label}] — reversal risk`);
      }
    } else {
      const res = live.spyLevels.resistance?.[0];
      if (res) {
        const dist = (res.price - live.spyPrice) / live.spyPrice * 100;
        if (dist < 0.05) exitReasons.push(`Near resistance $${res.price.toFixed(2)} [${res.label}] — reversal risk`);
      }
    }
  }

  // 3 — Conviction collapse
  const reScore = scoreConviction(mocData, expectedDir);
  if (reScore.score === 0) exitReasons.push('Conviction collapsed to 0');

  // SPY move since entry
  const entryPx  = order.entrySpyPrice;
  const movePct  = entryPx && live.spyPrice
    ? (live.spyPrice - entryPx) / entryPx * 100 * (expectedDir === 'PUTS' ? -1 : 1)
    : null;

  return { exit: exitReasons.length > 0, exitReasons, reScore, movePct };
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function logStat(event, data) {
  try {
    const stats = existsSync(HANK_STATS) ? JSON.parse(readFileSync(HANK_STATS, 'utf8')) : {};
    if (!stats.moc) stats.moc = { trades: [], exits: [], noTrades: [] };
    stats.moc[event === 'trade' ? 'trades' : event === 'exit' ? 'exits' : 'noTrades'].push(data);
    writeFileSync(HANK_STATS, JSON.stringify(stats, null, 2));
  } catch { /* non-fatal */ }
}

// ─── Display ──────────────────────────────────────────────────────────────────

function fmtDelta(n) {
  if (n == null) return 'N/A';
  const s = n >= 0 ? '+' : '-', a = Math.abs(n);
  if (a >= 1e6) return s + (a/1e6).toFixed(2) + 'M';
  if (a >= 1e3) return s + (a/1e3).toFixed(1) + 'K';
  return s + Math.round(a);
}

function fmtConviction(score, max = 5) {
  const bar = '█'.repeat(score) + '░'.repeat(max - score);
  const col = score >= 4 ? C.green : score >= 2 ? C.yellow : C.red;
  return `${col}${bar}${C.reset} ${score}/${max}`;
}

function printFactors(factors) {
  for (const f of factors) {
    const col = f.score > 0 ? C.green : C.gray;
    console.log(`  ${col}${f.score > 0 ? '✓' : '✗'}${C.reset} ${f.name.padEnd(22)} ${col}${f.score}/${f.max}${C.reset}  ${C.dim}${f.detail}${C.reset}`);
  }
}

function printDecision(mocData, dir, chase, conviction, strike, order) {
  const line   = '  ' + '─'.repeat(62);
  const dirCol = dir === 'CALLS' ? C.green : C.red;

  console.log(`\n${C.bold}${C.bgCyan}  *** MOC CONFIRMATION ${etNow()} ET ***  ${C.reset}`);
  console.log(line);

  console.log(`  ${C.bold}FJ IMBALANCE  ${C.dim}(tagged T-60 — ~15:50 actual)${C.reset}`);
  console.log(`  Direction:  ${dirCol}${C.bold}${mocData.direction}${C.reset}  net ${(mocData.netShares/1e6).toFixed(2)}M shares`);
  console.log(`  Buy: ${(mocData.totalBuyShares/1e6).toFixed(2)}M   Sell: ${(mocData.totalSellShares/1e6).toFixed(2)}M`);
  if (mocData.topNames?.length) {
    console.log(`  Names: ${mocData.topNames.slice(0,5).map(n=>`${n.symbol}(${n.side[0]})`).join(' ')}`);
  }

  console.log(line);
  console.log(`  ${C.bold}15:50 SNAPSHOT vs LIVE${C.reset}`);
  if (snapshot) {
    console.log(`  Snap:  $${snapshot.spyPrice.toFixed(2)}  ${snapshot.spyBias}  ${fmtDelta(snapshot.spyDelta)}`);
  } else {
    console.log(`  ${C.yellow}Snapshot not available${C.reset}`);
  }
  console.log(`  Live:  $${live.spyPrice?.toFixed(2)}  ${live.spyBias}  ${fmtDelta(live.spyDelta)}`);

  console.log(line);
  console.log(`  ${C.bold}CHASE GATE${C.reset}`);
  const gateCol = chase.pass ? C.green : C.red;
  console.log(`  ${gateCol}${chase.pass ? '✓ PASS' : '✗ FAIL — NO TRADE'}${C.reset}  ${chase.reason}`);
  if (!chase.pass) { console.log(''); return; }

  console.log(line);
  console.log(`  ${C.bold}CONVICTION${C.reset}  ${fmtConviction(conviction.score)}`);
  printFactors(conviction.factors);

  if (conviction.score < MIN_CONVICTION) {
    console.log(`\n  ${C.bgYellow}  NO TRADE — conviction ${conviction.score} < min ${MIN_CONVICTION}  ${C.reset}\n`);
    return;
  }

  console.log(line);
  console.log(`  ${C.bold}STRIKE${C.reset}  ${strike ? `${strike.underlying} ${dirCol}${C.bold}${strike.strike} ${strike.optionType}${C.reset} 0DTE` : C.red + 'unavailable' + C.reset}`);
  if (strike) {
    console.log(`  Est. prem: $${strike.estimatedPremium.toFixed(2)}  (target $${PREMIUM_MIN}–$${PREMIUM_MAX})  delta ~${strike.deltaEst}`);
    console.log(`  ${C.dim}${strike.note}${C.reset}`);
  }

  if (order) {
    console.log(line);
    console.log(`  ${C.bold}ORDER${C.reset}`);
    console.log(`  ${dirCol}${C.bold}BUY ${order.contracts}x ${order.underlying} ${order.strike} ${order.optionType} @ $${order.limitPrice.toFixed(2)}${C.reset}`);
    console.log(`  Conviction: ${order.conviction}/5   Hard exit: ${C.red}${C.bold}15:59 ET${C.reset}`);
    console.log(`\n  ${C.bgGreen}  ✓ ORDER SUBMITTED TO PAPER LEDGER  ${C.reset}`);
    process.stdout.write('\x07\x07');
  }

  console.log(line);
  console.log(`  ${C.red}${C.bold}⏰  ACTIVE — Re-scoring every 30s until 15:59${C.reset}\n`);
}

function printRescore(result, time) {
  const { exit, exitReasons, reScore, movePct } = result;
  const statusCol = exit ? C.red : C.green;
  console.log(`\n  ${C.bold}[RESCORE]${C.reset} ${time}  ${statusCol}${C.bold}${exit ? '⚡ EARLY EXIT' : '✓ HOLDING'}${C.reset}  ${fmtConviction(reScore.score)}`);
  if (movePct != null) {
    const mc = movePct >= 0 ? C.green : C.red;
    console.log(`  SPY vs entry: ${mc}${movePct >= 0 ? '+' : ''}${movePct.toFixed(3)}%${C.reset}`);
  }
  for (const r of exitReasons) console.log(`  ${C.red}⚡ ${r}${C.reset}`);
}

// ─── State machine ────────────────────────────────────────────────────────────

const States = { WAITING: 0, ARMED: 1, CONFIRMING: 2, ACTIVE: 3, NO_TRADE: 4, EXITED: 5 };

let state        = States.WAITING;
let activeOrder  = null;
let cachedMoc    = null;
let rescoreTimer = null;
let exitFired    = false;
let tradeToday   = false;

export function hardExit(reason = '15:59 ET scheduled') {
  if (exitFired) return;
  exitFired = true;
  state     = States.EXITED;

  console.log(`\n  ${C.bgRed}  *** MOC HARD EXIT — ${etNow()} ET ***  ${C.reset}`);
  console.log(`  ${C.red}${C.bold}${reason}${C.reset}`);
  process.stdout.write('\x07\x07\x07');

  if (rescoreTimer) { clearInterval(rescoreTimer); rescoreTimer = null; }

  if (activeOrder?.requestId) {
    // Exit price degraded: moc-engine.js doesn't yet pull live option premium at exit,
    // so closePosition computes $0 P&L for MOC trades. The 'NO_EXIT_PRICE' tag
    // attached at entry lets downstream consumers filter accordingly.
    const exitPrice  = activeOrder.fillPrice ?? 0;
    const exitReason = `MOC_${String(reason).replace(/\s+/g, '_').toUpperCase().slice(0, 40)}`;
    closePosition(activeOrder.requestId, exitPrice, exitReason);
    logStat('exit', { requestId: activeOrder.requestId, reason, time: etNow(), date: etDate() });
    activeOrder = null;
  } else {
    console.log(`  ${C.gray}No open position to close.${C.reset}`);
  }
}

export async function attemptEntry() {
  if (tradeToday) { console.log(`  ${C.gray}[MOC] Already traded today — skip${C.reset}`); return; }

  const mocData    = cachedMoc;
  const expectedDir = mocData.direction === 'BUY' ? 'CALLS' : 'PUTS';

  // IVR gate — only enter when premium is reasonable. Reads iv-rank.json
  // (populated by a separate Webull pull). When file is absent, log and proceed.
  let ivrBlock = null;
  try {
    const IVR_PATH = join(__dirname, 'iv-rank.json');
    if (existsSync(IVR_PATH)) {
      const ivData = JSON.parse(readFileSync(IVR_PATH, 'utf8'));
      const ivr    = ivData?.SPY?.ivr ?? ivData?.ivr ?? null;
      if (ivr != null) {
        const verdict = interpretIVR(ivr);
        if (!verdict.trade) {
          ivrBlock = `IVR ${ivr.toFixed(0)} — ${verdict.label}: ${verdict.note}`;
          jAlert('moc-ivr-block', ivrBlock, { ivr, label: verdict.label });
        }
      }
    } else {
      jAlert('moc-ivr-missing', 'iv-rank.json not present — IVR gate not enforced', {});
    }
  } catch (e) { jError('moc-ivr', e.message); }

  if (ivrBlock) {
    console.log(`  ${C.yellow}[MOC] Entry blocked — ${ivrBlock}${C.reset}`);
    state = States.NO_TRADE;
    logStat('no_trade', { date: etDate(), time: etNow(), reason: 'IVR_GATE', detail: ivrBlock });
    return;
  }

  const chase      = chaseCheck(expectedDir);
  const conviction = scoreConviction(mocData, expectedDir);
  const contracts  = CONTRACTS[Math.min(conviction.score, 5)] ?? 0;

  const strike = (chase.pass && conviction.score >= MIN_CONVICTION && live.spyPrice)
    ? selectStrike(live.spyPrice, expectedDir, conviction.score)
    : null;

  const order = (chase.pass && conviction.score >= MIN_CONVICTION && strike && contracts > 0)
    ? buildOrder(strike, expectedDir, conviction, contracts)
    : null;

  printDecision(mocData, expectedDir, chase, conviction, strike, order);

  if (order) {
    // Route through paperTrading.sendOrder() — single writer, structured
    // ledger schema, automatic jEntry journaling. Ledger lock is held inside
    // paperTrading; moc-engine.js no longer writes paper-ledger.json directly.
    const consensus = mocOrderToConsensus(order, expectedDir, conviction);
    const requestId = orderGate.createRequest({ signal: consensus.signal, engine: 'MOC' });
    let trade = null;
    try {
      trade = await sendOrder(consensus, requestId, /* lastQuote */ null);
    } catch (e) {
      jError('moc-sendOrder', e.message, { requestId });
    }
    if (trade && !trade.vetoed) {
      activeOrder = {
        ...order,
        requestId,
        fillPrice: trade.fillPrice ?? order.limitPrice,
      };
      tradeToday  = true;
      state       = States.ACTIVE;
      logStat('trade', {
        date: etDate(), time: etNow(),
        dir: expectedDir, score: conviction.score, contracts,
        strike: strike.strike, requestId,
        chaseMove: chase.pct,
      });
      rescoreTimer = setInterval(() => {
        if (state !== States.ACTIVE || !activeOrder) return;
        const result = evaluateExit(activeOrder, cachedMoc);
        printRescore(result, etNow());
        if (result.exit) hardExit(`Early: ${result.exitReasons[0]}`);
      }, RESCORE_MS);
    } else {
      state = States.NO_TRADE;
      const reason = trade?.reason || 'sendOrder-failed';
      console.log(`  ${C.yellow}[MOC] Order vetoed by paperTrading: ${reason}${C.reset}`);
      logStat('no_trade', {
        date: etDate(), time: etNow(),
        reason: `paperTrading_veto: ${reason}`,
      });
    }
  } else {
    state = States.NO_TRADE;
    logStat('no_trade', {
      date: etDate(), time: etNow(),
      reason: !chase.pass ? chase.reason : `conviction ${conviction.score}`,
    });
  }
}

async function tick() {
  const mins = etMinutes();

  if (mins >= EXIT_MINUTE && !exitFired) { hardExit(); return; }
  if (state === States.EXITED) return;

  // WAITING
  if (mins < ARM_MINUTE) {
    const rem = ARM_MINUTE - mins;
    if (rem === 15 || rem === 5 || rem === 1) {
      console.log(`  ${C.gray}[MOC] Waiting — arms in ${rem} min (15:45 ET)${C.reset}`);
    }
    return;
  }

  // ARMED
  if (mins >= ARM_MINUTE && mins < SNAPSHOT_MINUTE && state === States.WAITING) {
    state = States.ARMED;
    console.log(`\n  ${C.bold}${C.yellow}[MOC] ENGINE ARMED — 15:45 ET${C.reset}`);
    console.log(`  SPY source: wsServer (primary) / spy-levels.json (fallback). Snapshot locks at 15:50.\n`);
    // Pre-load spy-levels.json now so it's ready at 15:50 if wsServer isn't up
    tryLoadSpyLevels();
  }

  // Lock snapshot at 15:50
  if (mins >= SNAPSHOT_MINUTE && !snapshotLocked) {
    snapshotLocked = true;
    lockSnapshot();
  }

  // CONFIRMING — 15:51+
  if (mins >= CONFIRM_MINUTE && state === States.ARMED) {
    state = States.CONFIRMING;
  }

  if (state === States.CONFIRMING && !tradeToday) {
    if (!cachedMoc) cachedMoc = readMocData();
    if (cachedMoc) {
      console.log(`  ${C.green}[MOC] FJ data ready — running confirmation gates${C.reset}`);
      await attemptEntry();
    } else {
      // Print once per minute to avoid spam
      const sec = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', second: '2-digit' });
      if (parseInt(sec) < 10) {
        console.log(`  ${C.yellow}[MOC] Waiting for FJ MOC data (moc-data.json)...${C.reset}`);
      }
    }
  }
}

// ─── wsServer connection ──────────────────────────────────────────────────────

function connectWs() {
  try {
    const ws = new WebSocket(`ws://localhost:${WS_PORT}`);
    ws.on('open', () => console.log(`  ${C.cyan}[MOC] wsServer connected${C.reset}`));
    ws.on('message', raw => {
      try {
        const { type, data } = JSON.parse(raw);
        if (type === 'SIGNAL' || type === 'TICK') {
          if (data.spyPrice  != null) live.spyPrice  = data.spyPrice;
          if (data.spyDelta  != null) live.spyDelta  = data.spyDelta;
          if (data.spyVwap   != null) live.spyVwap   = data.spyVwap;
          if (data.spyBias   != null) live.spyBias   = data.spyBias;
          if (data.spyLevels)         live.spyLevels = data.spyLevels;
          live.lastTick = Date.now();
        }
      } catch { /* ignore */ }
    });
    ws.on('error', () => {});
    ws.on('close', () => setTimeout(connectWs, 15_000));
  } catch { /* degraded — no wsServer boost */ }
}

// ─── Daily reset ──────────────────────────────────────────────────────────────

function scheduleReset() {
  const now     = new Date();
  const nextET  = new Date(now.toLocaleDateString('en-US', { timeZone: 'America/New_York' }));
  nextET.setDate(nextET.getDate() + 1);
  setTimeout(() => {
    Object.assign({ state: States.WAITING, activeOrder: null, cachedMoc: null,
      tradeToday: false, exitFired: false, snapshotLocked: false, snapshot: null });
    live = { spyPrice: null, spyDelta: null, spyVwap: null, spyBias: null, spyLevels: null, lastTick: 0 };
    if (rescoreTimer) { clearInterval(rescoreTimer); rescoreTimer = null; }
    console.log(`\n  ${C.gray}[MOC] Daily reset${C.reset}\n`);
    scheduleReset();
  }, nextET - now);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.clear();

  const line = '═'.repeat(64);
  console.log(`\n${C.bold}${C.cyan}╔${line}╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║${C.reset}${C.bold}  HANK MOC ENGINE v2  │  Latency-Aware Confirmation        ${C.cyan}║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚${line}╝${C.reset}\n`);
  console.log(`  ${C.bold}Strategy:${C.reset}   FJ ~60s delayed → treat as CONFIRMATION, not lead`);
  console.log(`  15:45    Engine arms — monitoring SPY via wsServer`);
  console.log(`  15:50    ${C.bold}Snapshot locked${C.reset} — SPY price/bias/delta frozen`);
  console.log(`  15:51    FJ arrives → chase gate + 4-factor conviction score`);
  console.log(`  15:52–58 ${C.bold}Active loop${C.reset} — rescore every 30s, early exit if triggered`);
  console.log(`  15:59    ${C.red}${C.bold}HARD EXIT${C.reset}`);
  console.log('');
  console.log(`  Entry gates:`);
  console.log(`    Chase      SPY must not have moved >${CHASE_PCT}% in direction already`);
  console.log(`    Trend      SPY bias at 15:50 must match imbalance`);
  console.log(`    Delta      Live sellers/buyers must still be active`);
  console.log(`    Momentum   Price moving in direction, not stalled`);
  console.log(`    Min score  ${MIN_CONVICTION}/5`);
  console.log('');
  console.log(`  Early exit: delta flip | near S/R | conviction=0`);
  console.log(`  Sizing:     ${Object.entries(CONTRACTS).filter(([k])=>+k>0).map(([k,v])=>`${k}→${v}c`).join('  ')}`);
  console.log(`  Target:     XSP 0DTE  $${PREMIUM_MIN}–$${PREMIUM_MAX} premium\n`);

  connectWs();
  scheduleReset();

  setInterval(async () => {
    try { await tick(); }
    catch (e) { console.error(`  ${C.red}[MOC] ${e.message}${C.reset}`); }
  }, 10_000);

  await tick();

  process.on('SIGINT', () => {
    if (rescoreTimer) clearInterval(rescoreTimer);
    console.log(`\n  ${C.gray}[MOC] Stopped.${C.reset}\n`);
    process.exit(0);
  });
}

// Run main() only when invoked directly (`node moc-engine.js`) — not when imported
// (e.g. by the e2e test which drives attemptEntry / hardExit explicitly).
const isMain = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const meta = new URL(import.meta.url).pathname.toLowerCase();
    const arg  = (argv1.startsWith('file:') ? new URL(argv1).pathname : argv1)
      .replace(/\\/g, '/').toLowerCase();
    return meta.endsWith(arg) || arg.endsWith(meta) || meta === arg;
  } catch { return false; }
})();

if (isMain) {
  main().catch(e => {
    console.error(`\n  ${C.red}Fatal: ${e.message}${C.reset}\n`);
    process.exit(1);
  });
}
