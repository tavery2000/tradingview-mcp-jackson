#!/usr/bin/env node
/**
 * theta-monitor.js — Per-position theta / greeks / burn-zone monitor
 * Built by HANK 2026-05-13 (Saturday integration task brought into the
 * weeknight queue — see feedback_one_validation_day_per_deploy memory).
 *
 * Responsibilities (per the spec):
 *   1. Every POLL_MS, read paper-ledger.json
 *   2. For each OPEN position regardless of instrument:
 *        - Build a theta.js position object from the trade record
 *        - Pull current underlying:
 *            * SPY/QQQ/IWM → wsServer ws://localhost:8080 tick cache
 *            * ES1!/NQ1!/MES1!/MNQ1! → CDP query on :9222 chart's last bar
 *            * Any failure → synthetic=true, fall back to entryUnderlying
 *        - Estimate current option price via ATM-delta approximation
 *        - Call theta.monitorPosition() — full greeks + burn zone + exit flags
 *   3. Write portfolio-theta.json with portfolio total + per-position cards.
 *      Dashboard /api/theta consumes this. ask.js `hank> theta` consumes this.
 *
 * Architecture choice (per 2026-05-13 discussion):
 *   - WS client for equities = real-time tick, no extra latency
 *   - CDP poll for futures = one Runtime.evaluate per ticker per cycle (~100ms)
 *   - Single-process design (vs adding to monitor.js) for isolation: theta
 *     compute can fail without taking down signal generation
 *
 * Synthetic flag:
 *   - true when live price feed unavailable (WS not connected, CDP unreachable,
 *     unknown ticker family). The position still gets greeks + burn-zone via
 *     entryUnderlying decay estimate, but downstream consumers (dashboard,
 *     ask.js) should display the synthetic marker so the operator knows the
 *     numbers are estimates, not live.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname }       from 'path';
import { fileURLToPath }       from 'url';
import { WebSocket }           from 'ws';
import CDP                     from 'chrome-remote-interface';
import {
  monitorPosition, portfolioTheta, getBurnZoneData, getETString,
} from './theta.js';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const LEDGER_FILE = join(__dirname, 'paper-ledger.json');
const OUTPUT_FILE = join(__dirname, 'portfolio-theta.json');
const POLL_MS     = parseInt(process.env.THETA_POLL_MS || '5000', 10);
const WS_PORT     = parseInt(process.env.WS_PORT       || '8080', 10);
const CDP_PORT    = parseInt(process.env.CDP_PORT      || '9222', 10);

// ATM 0DTE delta hedge ratio for synthetic option-price estimation when no
// live chain quote is available. Matches paperTrading.js _DELTA_APPROX.
const DELTA_APPROX = 0.50;

// Future instruments and their family mapping. ETFs are served from the
// wsServer tick cache; futures from CDP.
const ETF_INSTRUMENTS     = new Set(['SPY', 'QQQ', 'IWM']);
const FUTURES_INSTRUMENTS = new Set(['ES1!', 'NQ1!', 'MES1!', 'MNQ1!']);

// ─── Terminal colors ─────────────────────────────────────
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red:   '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan:  '\x1b[36m', gray:  '\x1b[90m',
};

// ─── In-memory price cache from wsServer ticks ───────────
// instrument → { price, ts }
const livePrices = new Map();

// Synthetic-state telemetry — for the operator to see when feeds are degraded
const stats = {
  pollCount: 0,
  wsConnected: false,
  cdpAvailable: null,
  lastWriteAt: null,
};

// ─── wsServer client ─────────────────────────────────────
let ws = null;
let wsReconnectTimer = null;

function connectWsServer() {
  try {
    ws = new WebSocket(`ws://localhost:${WS_PORT}`);
  } catch (e) {
    console.log(`  ${C.yellow}[WS]${C.reset} init error: ${e.message} — retry in 10s`);
    wsReconnectTimer = setTimeout(connectWsServer, 10_000);
    return;
  }

  ws.on('open', () => {
    stats.wsConnected = true;
    console.log(`  ${C.green}[WS]${C.reset} connected to wsServer on :${WS_PORT}`);
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }   // skip binary MessagePack
    if (msg?.type !== 'tick') return;
    const p = msg.payload ?? {};
    const now = Date.now();
    for (const sym of ['SPY', 'QQQ', 'IWM']) {
      if (p[sym]?.price) livePrices.set(sym, { price: p[sym].price, ts: now });
    }
  });

  ws.on('close', () => {
    stats.wsConnected = false;
    console.log(`  ${C.yellow}[WS]${C.reset} disconnected — reconnect in 5s`);
    wsReconnectTimer = setTimeout(connectWsServer, 5_000);
  });

  ws.on('error', (e) => {
    if (e.code !== 'ECONNREFUSED') {
      console.log(`  ${C.red}[WS]${C.reset} error: ${e.message}`);
    }
  });
}

// ─── CDP query — last bar close per ticker ───────────────
async function fetchCdpPrice(ticker) {
  let client;
  try {
    const targets = await CDP.List({ port: CDP_PORT });
    // Match TV chart tab by title or URL. Tab titles like
    // "ES1!, 1m — TradingView" are common.
    const base = ticker.toUpperCase().replace('1!', '');
    const target = targets.find(t => {
      const haystack = `${t.title || ''} ${t.url || ''}`.toUpperCase();
      return haystack.includes(ticker.toUpperCase()) || haystack.includes(base);
    });
    if (!target) {
      stats.cdpAvailable = false;
      return null;
    }
    client = await CDP({ target, port: CDP_PORT });
    const { Runtime } = client;
    await Runtime.enable();
    const expr = `(function(){try{
      var api = window.TradingViewApi._activeChartWidgetWV.value();
      var series = api._chartWidget.model().mainSeries();
      var bars = series.bars();
      if (!bars || typeof bars.lastIndex !== 'function') return null;
      var v = bars.valueAt(bars.lastIndex());
      return v ? v[4] : null;
    } catch(e) { return null; } })()`;
    const result = await Runtime.evaluate({ expression: expr });
    stats.cdpAvailable = true;
    return result?.result?.value ?? null;
  } catch (e) {
    stats.cdpAvailable = false;
    return null;
  } finally {
    if (client) try { await client.close(); } catch {}
  }
}

// ─── Lookup current underlying for an instrument ─────────
async function getCurrentUnderlying(instrument) {
  if (ETF_INSTRUMENTS.has(instrument)) {
    const cached = livePrices.get(instrument);
    if (cached && (Date.now() - cached.ts) < 60_000) return cached.price;
    return null;
  }
  if (FUTURES_INSTRUMENTS.has(instrument)) {
    return await fetchCdpPrice(instrument);
  }
  return null;
}

// ─── Build a theta.js position object from a ledger trade ─
function buildPosition(trade) {
  const underlyingEntry = trade.underlyingPrice ?? trade.entryUnderlying ?? null;
  // Strike fallback — many ledger entries have empty strike ('') from the
  // chart-engine path. ATM 0DTE assumption: strike ≈ entry-time underlying.
  let strike = trade.strike;
  if (strike == null || strike === '' || !Number.isFinite(parseFloat(strike))) {
    strike = underlyingEntry ?? trade.fillPrice * 100;
  } else {
    strike = parseFloat(strike);
  }
  return {
    symbol:     trade.requestId,
    underlying: trade.instrument,
    strike,
    type:       trade.type ?? (trade.signal === 'CALLS' ? 'call' : 'put'),
    entryPrice: trade.fillPrice,
    entryTime:  trade.ts ?? trade.fillTime ?? Date.now(),
    entryIV:    trade.entryIV ?? 1.0,        // fallback 100% IV
    contracts:  trade.contracts ?? 1,
  };
}

// ─── Estimate current option price from underlying move ──
function estimateCurrentOption(trade, currentUnderlying) {
  const entryUnder = trade.underlyingPrice ?? trade.entryUnderlying;
  if (currentUnderlying == null || entryUnder == null) return trade.fillPrice;
  const dirMult = trade.signal === 'CALLS' ? 1 : -1;
  const move    = (currentUnderlying - entryUnder) * dirMult * DELTA_APPROX;
  return Math.max(0.01, trade.fillPrice + move);
}

// ─── Main poll cycle ─────────────────────────────────────
async function pollCycle() {
  stats.pollCount++;

  let ledger;
  try {
    ledger = JSON.parse(readFileSync(LEDGER_FILE, 'utf8'));
  } catch (e) {
    console.log(`  ${C.red}[POLL]${C.reset} ledger read error: ${e.message}`);
    return;
  }

  const open = (ledger.trades || []).filter(t => t.status === 'OPEN');
  const positions = [];
  let totalThetaPerMin = 0;

  for (const trade of open) {
    let currentUnderlying = null;
    try {
      currentUnderlying = await getCurrentUnderlying(trade.instrument);
    } catch {} // individual failures degrade to synthetic

    const synthetic    = currentUnderlying == null;
    const underlying   = currentUnderlying ?? trade.underlyingPrice ?? trade.entryUnderlying ?? 0;
    const currentOption = estimateCurrentOption(trade, currentUnderlying);
    const position     = buildPosition(trade);

    if (!underlying || !position.strike) {
      // Can't compute greeks without underlying/strike — skip but record stub
      positions.push({
        requestId:    trade.requestId,
        instrument:   trade.instrument,
        signal:       trade.signal,
        engine:       trade.engine,
        contracts:    position.contracts,
        entryPrice:   position.entryPrice,
        synthetic:    true,
        error:        'no_underlying_or_strike',
      });
      continue;
    }

    let result;
    try {
      result = monitorPosition(position, currentOption, underlying);
    } catch (e) {
      console.log(`  ${C.yellow}[CALC]${C.reset} ${trade.instrument} ${trade.requestId}: ${e.message}`);
      continue;
    }

    // Schema aligned to hank-electron-r3.html:pollTheta / renderPositionCards
    // — greeks nested in .greeks, IV decimal not percent, burnZone object
    // not string, pnl not pnlTotal, thetaPerMin not thetaPerMinContract.
    positions.push({
      // Identity
      requestId:         trade.requestId,
      instrument:        trade.instrument,
      symbol:            trade.requestId,             // dashboard fallback
      signal:            trade.signal,
      engine:            trade.engine,
      strike:            position.strike,
      type:              position.type,
      expiry:            trade.expiry ?? null,
      contracts:         position.contracts,
      // Prices
      entryPrice:        parseFloat(position.entryPrice.toFixed(4)),
      currentEstOption:  parseFloat(currentOption.toFixed(4)),
      entryUnderlying:   trade.underlyingPrice ?? trade.entryUnderlying ?? null,
      currentUnderlying: currentUnderlying,
      // P&L (renamed: pnl is the dashboard-expected field name)
      pnl:               parseFloat(result.pnlTotal.toFixed(2)),
      pnlPct:            parseFloat(result.pnlPct.toFixed(2)),
      thetaBurned:       parseFloat(result.thetaBurned.toFixed(2)),
      // Greeks (nested — dashboard reads p.greeks.{delta,gamma,theta,vega})
      greeks: {
        delta: parseFloat(result.delta.toFixed(4)),
        gamma: parseFloat(result.gamma.toFixed(6)),
        theta: parseFloat(result.theta.toFixed(4)),
        vega:  parseFloat(result.vega.toFixed(4)),
      },
      thetaPerMin:       parseFloat(result.thetaPerMinContract.toFixed(4)),
      // IV — decimal form (dashboard multiplies by 100 for display: 1.42 -> 142%)
      currentIV:         parseFloat(result.currentIV.toFixed(4)),
      entryIV:           parseFloat(result.entryIV.toFixed(4)),
      ivChange:          parseFloat(result.ivChange.toFixed(4)),
      ivCrushing:        result.ivCrushing,
      vegaAlert:         result.vegaAlert,
      // Time
      minsHeld:          parseFloat(result.minsHeld.toFixed(1)),
      hardExitMins:      parseFloat(result.hardExitMins.toFixed(1)),
      // Burn zone — dashboard expects {label, color}; portfolio zone applies
      // to all positions since burn is time-of-day, not per-position.
      burnZone:          burn.current,
      burnRate:          result.burnZone,             // SLOW/MEDIUM/FAST/CRITICAL per theta.js
      // Exit signals
      exitNow:           result.exitNow,
      exitWarn:          result.exitWarn,
      // Telemetry
      synthetic,
    });

    totalThetaPerMin += result.thetaPerMinContract * (position.contracts || 1);
  }

  const burn = getBurnZoneData();

  const output = {
    ts:                   Date.now(),
    time:                 getETString(),
    burnZone:             burn,
    portfolioThetaPerMin: parseFloat(totalThetaPerMin.toFixed(2)),
    positionCount:        positions.length,
    positions,
    feeds: {
      ws:  stats.wsConnected,
      cdp: stats.cdpAvailable,
    },
  };

  try {
    writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
    stats.lastWriteAt = Date.now();
  } catch (e) {
    console.log(`  ${C.red}[WRITE]${C.reset} portfolio-theta.json error: ${e.message}`);
  }

  // Brief status line — only if positions are active
  if (positions.length > 0) {
    const synthCount = positions.filter(p => p.synthetic).length;
    const synthMark  = synthCount > 0 ? `  ${C.dim}(${synthCount} synthetic)${C.reset}` : '';
    const thetaC     = totalThetaPerMin < -5 ? C.red : totalThetaPerMin < 0 ? C.yellow : C.gray;
    console.log(
      `  ${C.gray}[${getETString()}]${C.reset} ${positions.length} positions  ` +
      `${thetaC}theta/min ${totalThetaPerMin.toFixed(2)}${C.reset}  ` +
      `${C.cyan}${burn.current.label}${C.reset}${synthMark}`
    );
  }
}

// ─── Startup banner ──────────────────────────────────────
function startBanner() {
  const t = getETString();
  console.log('');
  console.log(`  ${C.bold}${C.cyan}╔══════════════════════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`  ${C.bold}${C.cyan}║${C.reset}  ${C.bold}HANK Theta Monitor — Per-position 0DTE risk surface${C.reset}                 ${C.bold}${C.cyan}║${C.reset}`);
  console.log(`  ${C.bold}${C.cyan}║${C.reset}                                                                      ${C.bold}${C.cyan}║${C.reset}`);
  console.log(`  ${C.bold}${C.cyan}║${C.reset}  Poll cycle:  ${String(POLL_MS / 1000).padEnd(54)}  ${C.bold}${C.cyan}║${C.reset}`);
  console.log(`  ${C.bold}${C.cyan}║${C.reset}  Output:      portfolio-theta.json (consumed by /api/theta + hank>theta) ${C.bold}${C.cyan}║${C.reset}`);
  console.log(`  ${C.bold}${C.cyan}║${C.reset}  Equity feed: ws://localhost:${String(WS_PORT).padEnd(40)}  ${C.bold}${C.cyan}║${C.reset}`);
  console.log(`  ${C.bold}${C.cyan}║${C.reset}  Futures feed: CDP :${String(CDP_PORT).padEnd(48)}  ${C.bold}${C.cyan}║${C.reset}`);
  console.log(`  ${C.bold}${C.cyan}║${C.reset}  Started:     ${t.padEnd(54)}  ${C.bold}${C.cyan}║${C.reset}`);
  console.log(`  ${C.bold}${C.cyan}╚══════════════════════════════════════════════════════════════════════╝${C.reset}`);
  console.log('');
}

// ─── Main ────────────────────────────────────────────────
startBanner();
connectWsServer();
setInterval(() => {
  pollCycle().catch(e => console.log(`  ${C.red}[POLL]${C.reset} cycle error: ${e.message}`));
}, POLL_MS);

// First cycle immediately so portfolio-theta.json exists within seconds
pollCycle().catch(e => console.log(`  ${C.red}[INIT]${C.reset} first poll error: ${e.message}`));
