#!/usr/bin/env node
/**
 * monitor.js — Mag-7 + SPY continuous market monitor
 *
 * Every 30s (8:00 AM–4:00 PM ET):
 *   - Reads VWAP + Volume Delta + VRRS for NVDA, AAPL, MSFT, META, AMZN, GOOGL
 *   - Reads VWAP + Volume Delta + VRRS + OHLCV for SPY (Claude SPY tab)
 *   - Detects swing-high resistance + swing-low support + VWAP bands per symbol
 *   - Clears old drawings and redraws: green = support, red = resistance
 *   - Prints SPY technical analysis summary (trend, levels, approach status)
 *   - Fires CALLS/PUTS alert when 4+ stocks agree + SPY confirms
 *   - VRRS confirmation: direction + Certainty % gates HIGH confidence signals
 *
 * VRRS key thresholds:
 *   >= +0.15 with Certainty >= 65% = bullish confirmation
 *   <= -0.15 with Certainty >= 65% = bearish confirmation
 *   Upgrades divergence reads to confirmed, overrides weak base bias
 *
 * Prerequisites:
 *   - TradingView running with --remote-debugging-port=9222
 *   - 6-chart tab open: NVDA, AAPL, MSFT, META, AMZN, GOOGL (VWAP + Volume Delta + VRRS)
 *   - "Claude SPY" tab open: SPY with VWAP + Volume Delta + VRRS
 *
 * Usage: node monitor.js
 *
 * VRRS DEBUG: On first run, check console for "[VRRS debug]" lines to confirm
 * exact key names TV returns. Hardcode and strip fallback chain once confirmed.
 */

import 'dotenv/config';   // 2026-05-14: load .env BEFORE paperTrading.js's module-load env reads (SWING entries call sendOrder)
import { startHeartbeat } from './heartbeat.js';
startHeartbeat('monitor.js');
import CDP             from 'chrome-remote-interface';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';
import { jPoll, jSignal, jGateBlock, jAlert, jError } from './journal.js';
import { createBarCache } from './bars.js';
import { chartStructureEngine } from './chartStructure.js';
import { analyze4H, analyze1H } from './analyze.js';
import {
  // Path 2 simplification 2026-05-11: gate1H / gateMacro4H / gateVwap /
  // computeBoosterAdj / computeSpyBoosters dropped — chart engines fire
  // through basic gates + tier sizing only. Helpers remain exported from
  // signalConfidence.js if we need to put any of them back.
  applyMultipliers, readDailyBiasRegime,
  HIERARCHY_V2, CHART_ENGINE_SET, PINE_PRIMARY,
} from './signalConfidence.js';
import { scanTriggers, runEntryEngines } from './triggerScans.js';
import { buildDrawJS } from './chartDraws.js';
import { loadFVGState }   from './fvg.js';
import { loadSweepState } from './sweep.js';

// L2 order book — imported from l2.js (starts its own MQTT connection)
// Degrades gracefully if l2.js unavailable — returns null from getL2Signal()
let getL2Signal   = () => null;
let getL2Snapshot = () => null;
try {
  const l2 = await import('./l2.js');
  getL2Signal   = l2.getL2Signal;
  getL2Snapshot = l2.getL2Snapshot;
  console.log('  [L2] order book engine loaded');
} catch (e) {
  console.log(`  [L2] not loaded (${e.message.slice(0, 60)}) — L2 panel will show awaiting data`);
}

// WebSocket broadcast server — hosts wsServer in-process so the TICK broadcast
// block downstream can set global.wsBroadcast. briefing.js / dashboard connect
// as clients on :8080. Graceful degrade: broadcast block no-ops if start fails.
try {
  const ws = await import('./wsServer.js');
  ws.start(8080);
  console.log('  [WS] wsServer hosted in-process on :8080');
} catch (e) {
  console.log(`  [WS] not started (${e.message.slice(0, 60)}) — broadcasts will no-op`);
}

// Paper trading engine — sendOrder() / closePosition() / OrderGate
// TRADING_MODE=PAPER (default) — simulated fills, no real capital
// TRADING_MODE=LIVE  — real Webull orders (when ready)
let sendOrder = null, closePosition = null, orderGate = null, sessionReset = null, printScorecard = null;
let evaluateOpenPositions = null;
let selectContract = null;
try {
  const pt = await import('./paperTrading.js');
  sendOrder = pt.sendOrder; closePosition = pt.closePosition;
  orderGate = pt.orderGate; sessionReset = pt.sessionReset; printScorecard = pt.printScorecard;
  evaluateOpenPositions = pt.evaluateOpenPositions;
  console.log(`  [TRADE] paperTrading.js loaded — mode: ${process.env.TRADING_MODE || 'PAPER'}`);
} catch (e) { console.log(`  [TRADE] not loaded — trading disabled`); }

// Greeks engine — for re-pricing open positions intra-poll
let _bs = null, _gtr = null;
try {
  const th = await import('./theta.js');
  _bs  = th.blackScholes;
  _gtr = th.getTradingTimeRemaining;
} catch {}

// Daily-bias classifier — evaluated at 09:45 + 12:30 ET
let _evaluateDailyBias = null, _getDailyBias = null;
try {
  const db = await import('./daily-bias.js');
  _evaluateDailyBias = db.evaluateDailyBias;
  _getDailyBias      = db.getDailyBias;
} catch {}

// Options flow — Webull chain analytics + signal confirmation
let _pollOptionsFlow = null, _confirmDirection = null;
try {
  const of = await import('./options-flow.js');
  _pollOptionsFlow  = of.pollOptionsFlow;
  _confirmDirection = of.confirmDirection;
} catch {}

try {
  const wb = await import('./webull.js');
  selectContract = wb.selectContract;
  console.log(`  [OPTIONS] webull.js loaded — strike/expiry selection active, ATR pricing`);
} catch (e) { console.log(`  [OPTIONS] webull.js not loaded — strike/expiry selection disabled`); }

// ─── Active swing position trackers ──────────────────────────────────────────
// One swing trade per instrument per day.
// requestId links entry → exit in the ledger.
const activeSwing = {
  SPY: { requestId: null, status: null },
  QQQ: { requestId: null, status: null },
  IWM: { requestId: null, status: null },
};

// ─── Config ───────────────────────────────────────────────────────────────────

const __dirname    = dirname(fileURLToPath(import.meta.url));
const rules        = JSON.parse(readFileSync(join(__dirname, 'rules.json'), 'utf8'));

// Chart IDs — loaded from config.json (update there, not here)
const cfg          = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));

const STOCKS       = ['NVDA', 'AAPL', 'MSFT', 'META', 'AMZN', 'GOOGL'];
const QQQ_STOCKS   = ['QQQ', 'AMD', 'AVGO', 'TSLA', 'ARM', 'NVDA'];  // QQQ watchlist tab
const QQQ_CHART_ID = cfg.qqqChartId   ?? 'f4zZcgs4';
// 2026-05-15 Task 6: IWM retired. IwmSwingEngine gated below; webhook-server.js
// rejects inbound IWM alerts with INSTRUMENT_RETIRED. IWM tab + price reads
// kept intact to avoid regressing the SPY/QQQ display paths that share helpers.
const IWM_RETIRED  = true;
const IWM_STOCKS   = ['IWM', 'BE', 'CRDO', 'FN'];
const IWM_CHART_ID = cfg.iwmChartId   ?? 'Jo9vWQ37';
const SPY_CHART_ID = cfg.spyChartId   ?? 'vjeNFMBX';
const STOCK_CHART_ID = cfg.stockChartId ?? 'CH1rZnXK';
const POLL_MS      = 30_000;
const THRESHOLD    = 4;
const COOLDOWN     = POLL_MS * 3;
const NEAR_ZERO    = parseNearZero(rules.delta_thresholds?.near_zero) || 50;
const OHLCV_COUNT  = 120;   // bars of history for swing detection (~60 min on 30S)
const SWING_PERIOD = 5;     // bars each side for swing high/low detection
const CLUSTER_PCT  = 0.15;  // cluster levels within 0.15% of each other

// VRRS signal thresholds
const VRRS_THRESH  = 0.15;  // min absolute value to be directionally meaningful
const CERT_THRESH  = 65;    // min Certainty % to act on VRRS reading

function parseNearZero(str) {
  if (!str) return null;
  const n = parseInt(str.toString().replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? null : n;
}

// ─── Dual CDP clients ─────────────────────────────────────────────────────────

let stockClient = null;
let spyClient   = null;
let qqqClient   = null;   // QQQ 6-pane tab (f4zZcgs4)
let iwmClient   = null;   // IWM 4-pane tab (Jo9vWQ37)

// Multi-TF bar caches — one per CDP-bound instrument tab.
// Created after initClients() once spyClient/qqqClient/iwmClient are live.
// Strategy engines call barCache.SPY.get('5'|'60'|'240') and refuse to
// trade when null is returned.
const barCache = { SPY: null, QQQ: null, IWM: null };

async function evalOn(client, expression) {
  const result = await client.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: false,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text || 'Unknown JS error';
    throw new Error(msg);
  }
  return result.result?.value;
}

async function connectToTarget(targetId) {
  const c = await CDP({ host: 'localhost', port: 9222, target: targetId });
  await c.Runtime.enable();
  return c;
}

async function initClients() {
  const resp    = await fetch('http://localhost:9222/json/list');
  const targets = await resp.json();
  const charts  = targets.filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));

  if (charts.length < 2) {
    throw new Error(
      `Need 2 TradingView chart tabs, found ${charts.length}.\n` +
      `  Open the 6-chart layout AND the "Claude SPY" tab first.`
    );
  }

  console.log(`  Found ${charts.length} chart tab(s) — probing for HANK tabs...`);
  const probed = [];

  for (const t of charts) {
    try {
      const c         = await connectToTarget(t.id);
      const paneCount = await evalOn(c, `window.TradingViewApi._chartWidgetCollection.getAll().length`);
      const symbol    = await evalOn(c, `(function(){ try { return window.TradingViewApi._activeChartWidgetWV.value().symbol(); } catch(e){ return ''; } })()`);
      // Extract chart ID from URL for reliable tab identification
      const chartId   = (t.url.match(/chart\/([^/?]+)/) ?? [])[1] ?? t.id;
      probed.push({ target: t, client: c, paneCount: Number(paneCount) || 1, symbol: symbol || '', chartId });
      console.log(`    tab: "${t.title}"  url: ${t.url}`);
      console.log(`      probed: symbol=${symbol}  panes=${Number(paneCount)||1}  id=${chartId}`);
    } catch (e) {
      console.warn(`  Warning: could not probe tab ${t.id}: ${e.message}`);
    }
  }

  // Identify tabs by chart ID first (reliable), fall back to symbol/pane heuristics
  const spyEntry   = probed.find(p => p.chartId === SPY_CHART_ID)
                  || probed.find(p => p.symbol.toUpperCase().includes('SPY'))
                  || probed.find(p => p.paneCount === 1);

  const qqqEntry   = probed.find(p => p.chartId === QQQ_CHART_ID)
                  || probed.find(p => p.symbol.toUpperCase().includes('QQQ') && p !== spyEntry);

  const iwmEntry   = probed.find(p => p.chartId === IWM_CHART_ID)
                  || probed.find(p => ['IWM','BE','CRDO','FN'].some(s => p.symbol.toUpperCase().includes(s)) && p !== spyEntry && p !== qqqEntry);

  const stockEntry = probed.find(p => p.chartId === STOCK_CHART_ID)
                  || probed.find(p => p.paneCount >= 5 && p !== spyEntry && p !== qqqEntry && p !== iwmEntry)
                  || probed.find(p => p !== spyEntry && p !== qqqEntry && p !== iwmEntry);

  if (!spyEntry)   throw new Error('Claude SPY tab not found. Is it open with SPY as the symbol?');
  if (!stockEntry) throw new Error('6-chart Mag-6 stock tab not found. Is the 6-chart layout open?');

  // Close any tabs we don't need (futures, etc.)
  for (const p of probed) {
    if (p !== spyEntry && p !== stockEntry && p !== qqqEntry && p !== iwmEntry) {
      try { await p.client.close(); } catch {}
    }
  }

  stockClient = stockEntry.client;
  spyClient   = spyEntry.client;
  qqqClient   = qqqEntry?.client ?? null;
  iwmClient   = iwmEntry?.client ?? null;

  console.log(`  Stock tab: NASDAQ:NVDA  ${stockEntry.paneCount} panes  id=${stockEntry.chartId}`);
  console.log(`  SPY tab:   ${spyEntry.symbol}  id=${spyEntry.chartId}`);
  if (qqqClient) {
    console.log(`  QQQ tab:   ${qqqEntry.symbol}  id=${qqqEntry.chartId}  (${qqqEntry.paneCount} panes)`);
  } else {
    console.log(`  ${C.yellow}QQQ tab:   not found (id=${QQQ_CHART_ID}) — QQQ monitor disabled${C.reset}`);
  }
  if (iwmClient) {
    console.log(`  IWM tab:   ${iwmEntry.symbol}  id=${iwmEntry.chartId}  (${iwmEntry.paneCount} panes)`);
  } else {
    console.log(`  ${C.yellow}IWM tab:   not found (id=${IWM_CHART_ID}) — IWM monitor disabled${C.reset}`);
  }
}

// ─── Inlined JS expressions ───────────────────────────────────────────────────

const JS_STUDY_VALUES = `
(function() {
  var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
  var sources = chart.model().model().dataSources();
  var results = [];
  for (var si = 0; si < sources.length; si++) {
    var s = sources[si];
    if (!s.metaInfo) continue;
    try {
      var meta    = s.metaInfo();
      var rawName = meta.description || meta.shortDescription || '';
      var name    = rawName.toUpperCase();

      // Tight filter — only pull HANK-critical indicators
      // VRRS / VWRS = Volume-Relative Relative Strength (both spellings covered)
      // VOLUME WEIGHTED / VWAP = VWAP Session + bands
      // VOLUME DELTA = Volume Delta (exact match, uppercase)
      var isTarget = name.includes('VRRS')
                  || name.includes('VWRS')
                  || name.includes('VOLUME WEIGHTED REAL')
                  || name.includes('VOLUME WEIGHTED AVERAGE')
                  || name.includes('VWAP')
                  || name === 'VOLUME DELTA'
                  || name.includes('NYSE')
                  || name.includes('NASDAQ TICK')
                  || name.includes('TICK');
      if (!isTarget) continue;

      var values = {};
      try {
        var dwv = s.dataWindowView ? s.dataWindowView() : null;
        if (dwv) {
          var items = dwv.items ? dwv.items() : [];
          for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (item._value && item._value !== '\u2205' && item._title) {
              // Sanitize key: replace non-alphanumeric with underscore
              var key = item._title.replace(/[^a-zA-Z0-9]/g, '_');
              values[key] = item._value;
            }
          }
          // VRRS fallback — if indicator exposes no named keys, capture indexed
          // raw values so parseValues() can extract by position/range matching
          if (Object.keys(values).length === 0 && items.length > 0) {
            for (var j = 0; j < items.length; j++) {
              if (items[j]._value && items[j]._value !== '\u2205') {
                values['_raw_' + j] = items[j]._value;
              }
            }
          }
        }
      } catch(e2) {}

      // Push rawName (original casing) so downstream parseValues() regex matching works
      if (Object.keys(values).length > 0) {
        results.push({ name: rawName, values: values });
      }
    } catch(e) {}
  }
  return results;
})()`;

const JS_QUOTE = `
(function() {
  try {
    var api  = window.TradingViewApi._activeChartWidgetWV.value();
    var sym  = '';
    try { sym = api.symbol(); } catch(e) {}
    var bars = api._chartWidget.model().mainSeries().bars();
    if (bars && typeof bars.lastIndex === 'function') {
      var last = bars.valueAt(bars.lastIndex());
      if (last) return { symbol: sym, last: last[4], open: last[1], high: last[2], low: last[3], close: last[4], volume: last[5] || 0 };
    }
    return { symbol: sym };
  } catch(e) { return { error: e.message }; }
})()`;

const JS_OHLCV = `
(function() {
  try {
    var bars = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
    if (!bars || typeof bars.lastIndex !== 'function') return null;
    var result = [];
    var end   = bars.lastIndex();
    var start = Math.max(bars.firstIndex(), end - ${OHLCV_COUNT} + 1);
    for (var i = start; i <= end; i++) {
      var v = bars.valueAt(i);
      if (v) result.push({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0 });
    }
    return result;
  } catch(e) { return null; }
})()`;

function JS_FOCUS_PANE(index) {
  return `
(function() {
  var all = window.TradingViewApi._chartWidgetCollection.getAll();
  if (!all[${index}]) return false;
  if (all[${index}]._mainDiv) all[${index}]._mainDiv.click();
  return true;
})()`;
}

const JS_PANE_LIST = `
(function() {
  var all = window.TradingViewApi._chartWidgetCollection.getAll();
  var result = [];
  for (var i = 0; i < all.length; i++) {
    try {
      var m  = all[i].model ? all[i].model() : null;
      var ms = m ? m.mainSeries() : null;
      result.push({ index: i, symbol: ms ? ms.symbol() : null });
    } catch(e) { result.push({ index: i, symbol: null }); }
  }
  return result;
})()`;

// Layered chart drawing — replaces the legacy single-purpose JS_DRAW_LEVELS.
// Pulls 5M/1H/4H bars from the cache, loads FVG/sweep state, runs swing
// detection, and emits one CDP eval that clears the chart and redraws:
// levels + FVG zones + 1H/4H supply/demand + active sweeps + displacement.
async function drawChartAnnotations(instrument, client, levels) {
  if (!client || !barCache[instrument]) return;
  try {
    const [bars5M, bars1H, bars4H] = await Promise.all([
      barCache[instrument].get('5'),
      barCache[instrument].get('60'),
      barCache[instrument].get('240'),
    ]);
    if (!bars5M || !bars5M.length) return;
    const fvgState   = loadFVGState(instrument);
    const sweepState = loadSweepState(instrument);
    const allLevels  = [...(levels?.support ?? []), ...(levels?.resistance ?? [])];
    const { js } = buildDrawJS({
      instrument, bars5M, bars1H, bars4H,
      levels: allLevels, fvgState, sweepState,
    });
    // awaitPromise:true so the async IIFE finishes (all createShape Promises
    // resolved + IDs persisted on window) before this call returns. Prevents
    // the next poll from racing this cycle's shape creation.
    if (js) await client.Runtime.evaluate({ expression: js, returnByValue: true, awaitPromise: true });
  } catch (e) {
    jError('chart-draw', e.message, { instrument });
  }
}

function JS_DRAW_LEVELS(lastBarTime, levels) {
  const api   = `window.TradingViewApi._activeChartWidgetWV.value()`;
  const draws = levels.map(l => {
    const color = l.type === 'support' ? '#00BB44' : '#CC2200';
    const label = l.label.replace(/'/g, '');
    return `  try { api.createShape({ time: ${lastBarTime}, price: ${l.price.toFixed(6)} }, ` +
           `{ shape: 'horizontal_line', overrides: { linecolor: '${color}', linewidth: 1, linestyle: 0, showLabel: true, text: '${label}' } }); } catch(e) {}`;
  }).join('\n');
  return `
(function() {
  try {
    var api = ${api};
    api.removeAllShapes();
  } catch(e) {}
${draws}
})()`;
}

// ─── S/R level detection ──────────────────────────────────────────────────────

function clusterLevels(prices) {
  const sorted = [...prices].sort((a, b) => b - a);
  const result = [];
  for (const p of sorted) {
    if (!result.some(r => Math.abs(r - p) / p < CLUSTER_PCT / 100)) result.push(p);
  }
  return result;
}

function detectLevels(bars, currentPrice, vwap, upperBand, lowerBand, isSpy = false) {
  const support    = [];
  const resistance = [];

  // VWAP as a key level
  if (vwap != null) {
    if (currentPrice > vwap) support.push({ price: vwap, label: 'VWAP', type: 'support' });
    else resistance.push({ price: vwap, label: 'VWAP', type: 'resistance' });
  }

  // VWAP bands
  if (upperBand != null) resistance.push({ price: upperBand, label: 'VWAP+1σ', type: 'resistance' });
  if (lowerBand != null) support.push({ price: lowerBand, label: 'VWAP-1σ', type: 'support' });

  // Swing high / low detection
  if (bars && bars.length >= SWING_PERIOD * 2 + 1) {
    const swingHighs = [], swingLows = [];

    for (let i = SWING_PERIOD; i < bars.length - SWING_PERIOD; i++) {
      let isHigh = true, isLow = true;
      for (let j = i - SWING_PERIOD; j <= i + SWING_PERIOD; j++) {
        if (j === i) continue;
        if (bars[j].high >= bars[i].high) isHigh = false;
        if (bars[j].low  <= bars[i].low)  isLow  = false;
        if (!isHigh && !isLow) break;
      }
      if (isHigh) swingHighs.push(bars[i].high);
      if (isLow)  swingLows.push(bars[i].low);
    }

    clusterLevels(swingHighs)
      .filter(p => p > currentPrice)
      .sort((a, b) => a - b)
      .slice(0, 3)
      .forEach(p => resistance.push({ price: p, label: 'SH', type: 'resistance' }));

    clusterLevels(swingLows)
      .filter(p => p < currentPrice)
      .sort((a, b) => b - a)
      .slice(0, 3)
      .forEach(p => support.push({ price: p, label: 'SL', type: 'support' }));
  }

  // Pre-market levels — SPY only
  if (global.preMarketLevels && isSpy) {
    const { pdHigh, pdLow, todayOpen } = global.preMarketLevels;
    if (pdHigh != null) resistance.push({ price: pdHigh,   label: 'PDH', type: 'resistance' });
    if (pdLow  != null) support.push(   { price: pdLow,    label: 'PDL', type: 'support'    });
    if (todayOpen != null) {
      if (currentPrice > todayOpen) support.push(   { price: todayOpen, label: 'Open', type: 'support'    });
      else                          resistance.push( { price: todayOpen, label: 'Open', type: 'resistance' });
    }
  }

  // Round-number fallback — guarantees floor/ceiling always exist
  const roundFloor = Math.floor(currentPrice);
  if (!support.some(s => s.price < currentPrice)) {
    for (let i = 0; i >= -5; i--) {
      const level = roundFloor + i;
      if (level < currentPrice) { support.push({ price: level, label: 'R#', type: 'support' }); break; }
    }
  }
  if (!resistance.some(r => r.price > currentPrice)) {
    for (let i = 1; i <= 5; i++) {
      const level = roundFloor + i;
      if (level > currentPrice) { resistance.push({ price: level, label: 'R#', type: 'resistance' }); break; }
    }
  }

  support.sort((a, b) => b.price - a.price);
  resistance.sort((a, b) => a.price - b.price);

  return {
    support:    support.slice(0, 4),
    resistance: resistance.slice(0, 4),
  };
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function parseDelta(str) {
  if (str == null) return null;
  let s    = str.toString().replace(/,/g, '').replace(/\u2212/g, '-').trim();
  let mult = 1;
  if (/K$/i.test(s)) { mult = 1_000;     s = s.slice(0, -1); }
  if (/M$/i.test(s)) { mult = 1_000_000; s = s.slice(0, -1); }
  const n  = parseFloat(s);
  return isNaN(n) ? null : n * mult;
}

function parsePrice(str) {
  if (str == null) return null;
  const n = parseFloat(str.toString().replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

// Parse percentage strings like "88.33%" → 88.33
function parsePct(str) {
  if (str == null) return null;
  const n = parseFloat(str.toString().replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? null : n;
}

// ─── Reading helpers ──────────────────────────────────────────────────────────

function parseValues(studies) {
  let vwap = null, delta = null, upperBand = null, lowerBand = null;
  let vrrs = null, vrrsSector = null, vrrsChangeRate = null;
  let tick = null;

  for (const s of (studies || [])) {
    const n = (s.name ?? '').toUpperCase();

    if (n.includes('VOLUME WEIGHTED AVERAGE') || n.includes('VWAP')) {
      vwap      = parsePrice(s.values?.VWAP);
      upperBand = parsePrice(s.values?.Upper_Band__1);
      lowerBand = parsePrice(s.values?.Lower_Band__1);
    }

    if (n === 'VOLUME DELTA') {
      delta = parseDelta(s.values?.Volume_Delta);
    }

    // VRRS — confirmed keys: VRRS_vs_Market, VRRS_vs_Sector, Reference_Change
    if (n.includes('VOLUME WEIGHTED REAL RELATIVE')) {
      vrrs          = parsePrice(s.values?.VRRS_vs_Market);
      vrrsSector    = parsePrice(s.values?.VRRS_vs_Sector);
      vrrsChangeRate = parsePrice(s.values?.Reference_Change);
    }

    // NYSE / NASDAQ Tick — confirmed keys: Plot, PlotCandle
    if (n.includes('NYSE') || n.includes('NASDAQ TICK') || n.includes('NY/NQ')) {
      tick = parsePrice(s.values?.Plot ?? s.values?.PlotCandle);
    }
  }

  return { vwap, delta, upperBand, lowerBand, vrrs, vrrsSector, vrrsChangeRate, tick };
}

async function buildPaneMap() {
  const panes = await evalOn(stockClient, JS_PANE_LIST);
  const map   = {};
  for (const p of (panes || [])) {
    if (!p.symbol) continue;
    const base = p.symbol.split(':').pop().replace(/[0-9!]+$/, '').toUpperCase();
    if (base) map[base] = p.index;
  }
  return map;
}

async function readAndDrawPane(client, isSpy = false) {
  const [studies, quote, bars] = await Promise.all([
    evalOn(client, JS_STUDY_VALUES),
    evalOn(client, JS_QUOTE),
    evalOn(client, JS_OHLCV),
  ]);

  const price = quote?.last ?? quote?.close ?? null;
  const { vwap, delta, upperBand, lowerBand, vrrs, vrrsSector, vrrsChangeRate, tick } = parseValues(studies);

  const levels = (price != null && bars?.length)
    ? detectLevels(bars, price, vwap, upperBand, lowerBand, isSpy)
    : { support: [], resistance: [] };

  // Note: chart drawing moved to poll() so we can layer FVG zones, supply/
  // demand, sweeps, and displacement arrows on top of levels in one CDP
  // round-trip. See drawChartAnnotations() below.

  return { price, vwap, delta, vrrs, vrrsSector, vrrsChangeRate, tick, levels, bars };
}

async function readStockPane(paneIndex) {
  await evalOn(stockClient, JS_FOCUS_PANE(paneIndex));
  await sleep(350);
  return readAndDrawPane(stockClient, false);
}

async function readSPY() {
  return readAndDrawPane(spyClient, true);
}

// ─── QQQ tab readers ──────────────────────────────────────────────────────────

async function buildQqqPaneMap() {
  if (!qqqClient) return {};
  const panes = await evalOn(qqqClient, JS_PANE_LIST);
  const map   = {};
  for (const p of (panes || [])) {
    if (!p.symbol) continue;
    const base = p.symbol.split(':').pop().replace(/[0-9!]+$/, '').toUpperCase();
    if (base) map[base] = p.index;
  }
  return map;
}

async function readQqqPane(paneIndex) {
  await evalOn(qqqClient, JS_FOCUS_PANE(paneIndex));
  await sleep(350);
  return readAndDrawPane(qqqClient, false);
}

async function readQQQInstrument() {
  await evalOn(qqqClient, JS_FOCUS_PANE(0));
  await sleep(350);
  return readAndDrawPane(qqqClient, false);  // false — uses qqqPreMarketLevels separately
}

async function readIWMInstrument() {
  await evalOn(iwmClient, JS_FOCUS_PANE(0));
  await sleep(350);
  return readAndDrawPane(iwmClient, false);  // false — uses iwmPreMarketLevels separately
}

// ─── IWM tab readers ──────────────────────────────────────────────────────────

async function buildIwmPaneMap() {
  if (!iwmClient) return {};
  const panes = await evalOn(iwmClient, JS_PANE_LIST);
  const map   = {};
  for (const p of (panes || [])) {
    if (!p.symbol) continue;
    const base = p.symbol.split(':').pop().replace(/[0-9!]+$/, '').toUpperCase();
    if (base) map[base] = p.index;
  }
  return map;
}

async function readIwmPane(paneIndex) {
  await evalOn(iwmClient, JS_FOCUS_PANE(paneIndex));
  await sleep(350);
  return readAndDrawPane(iwmClient, false);
}

// ─── Bias classification ──────────────────────────────────────────────────────

function classify(price, vwap, delta, vrrs, vrrsSector) {
  if (price == null || vwap == null || delta == null) return 'unknown';
  if (Math.abs(delta) < NEAR_ZERO) return 'neutral';

  const up  = price > vwap;
  const pos = delta > 0;

  let bias;
  if      (up  && pos)  bias = 'bullish';
  else if (!up && !pos) bias = 'bearish';
  else if (up  && !pos) bias = 'div_bear';
  else                  bias = 'div_bull';

  // VRRS confirmation layer
  // vrrs = VRRS_vs_Market (-1 to +1): stock strength vs broad market
  // vrrsSector = VRRS_vs_Sector (-1 to +1): stock strength vs sector ETF
  // Both must agree directionally for a strong override
  if (vrrs != null) {
    const sectorAgrees = vrrsSector == null || Math.sign(vrrs) === Math.sign(vrrsSector);

    if (vrrs >= VRRS_THRESH && sectorAgrees && bias === 'div_bull') return 'bullish';
    if (vrrs <= -VRRS_THRESH && sectorAgrees && bias === 'div_bear') return 'bearish';
    if (vrrs <= -VRRS_THRESH && sectorAgrees && bias === 'bullish')  return 'div_bear';
    if (vrrs >= VRRS_THRESH  && sectorAgrees && bias === 'bearish')  return 'div_bull';
  }

  return bias;
}

// ─── SPY technical summary ────────────────────────────────────────────────────

function buildSpySummary(spy) {
  const { price, vwap, delta, bias, levels } = spy;
  if (!price || !levels) return null;

  const { support, resistance } = levels;

  const trendDir    = price > (vwap ?? price) ? 'Bullish' : 'Bearish';
  const vwapDist    = vwap != null ? (price - vwap).toFixed(2) : null;
  const trendDetail = vwap != null
    ? `${trendDir === 'Bullish' ? 'above' : 'below'} VWAP $${vwap.toFixed(2)} (${vwapDist > 0 ? '+' : ''}${vwapDist})`
    : trendDir;

  const nearRes = resistance.find(r => r.price > price);
  const nearSup = support.find(s => s.price < price);

  const distRes = nearRes ? ((nearRes.price - price) / price * 100) : null;
  const distSup = nearSup ? ((price - nearSup.price) / price * 100) : null;

  let status;
  if      (nearRes && distRes != null && distRes < 0.05) status = `Approaching resistance $${nearRes.price.toFixed(2)} (${nearRes.label})`;
  else if (nearSup && distSup != null && distSup < 0.05) status = `Approaching support $${nearSup.price.toFixed(2)} (${nearSup.label})`;
  else if (nearRes && nearSup) {
    status = `Mid-range between support $${nearSup.price.toFixed(2)} and resistance $${nearRes.price.toFixed(2)}`;
  } else if (!nearSup && nearRes) {
    status = `⚠️  BELOW SUPPORT — next resistance $${nearRes.price.toFixed(2)} (${nearRes.label})`;
  } else if (nearSup && !nearRes) {
    status = `⚠️  ABOVE RESISTANCE — next support $${nearSup.price.toFixed(2)} (${nearSup.label})`;
  } else {
    status = 'Insufficient level data';
  }

  return { trendDir, trendDetail, nearRes, nearSup, distRes, distSup, status };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const C = {
  reset:    '\x1b[0m',  bold:     '\x1b[1m',  dim:      '\x1b[2m',
  green:    '\x1b[32m', red:      '\x1b[31m',  yellow:   '\x1b[33m',
  cyan:     '\x1b[36m', gray:     '\x1b[90m',  white:    '\x1b[97m',
  bgGreen:  '\x1b[42m\x1b[30m',
  bgRed:    '\x1b[41m\x1b[97m',
  bgYellow: '\x1b[43m\x1b[30m',
};

function biasTag(b) {
  switch (b) {
    case 'bullish':  return C.green  + ' BULL ' + C.reset;
    case 'bearish':  return C.red    + ' BEAR ' + C.reset;
    case 'neutral':  return C.gray   + ' NTRL ' + C.reset;
    case 'div_bear': return C.yellow + ' DIV- ' + C.reset;
    case 'div_bull': return C.cyan   + ' DIV+ ' + C.reset;
    default:         return C.gray   + '  ?   ' + C.reset;
  }
}

let _lastGoodLedgerSPY = null;

function printPaperPanel(divLine) {
  try {
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(join(__dirname, 'paper-ledger.json'), 'utf8'));
    _lastGoodLedgerSPY = ledger;
  } catch {
    ledger = _lastGoodLedgerSPY;
    if (!ledger) {
      console.log(divLine);
      console.log(`  ${C.bold}PAPER TRADING${C.reset}  ${C.gray}ledger unavailable${C.reset}`);
      return;
    }
  }

  const today   = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const fmtET   = ts => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ts));

  // Filter to SPY trades only
  const myTrades = (ledger.trades ?? []).filter(t => t.instrument === 'SPY');
  const myClosed = myTrades.filter(t => t.status === 'CLOSED');
  const myOpen   = myTrades.filter(t => t.status === 'OPEN').slice(0, 5);

  const myWins   = myClosed.filter(t => (t.pnl ?? 0) > 0).length;
  const myLosses = myClosed.filter(t => (t.pnl ?? 0) <= 0).length;
  const myTotal  = myWins + myLosses;
  const winRate  = myTotal > 0 ? ((myWins / myTotal) * 100).toFixed(0) : '--';
  const myTodayPnL = myClosed.filter(t => t.exitTime && fmtET(t.exitTime) === today).reduce((s, t) => s + (t.pnl ?? 0), 0);
  const myAllPnL   = myClosed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const myWinPnl   = myClosed.reduce((s, t) => s + ((t.pnl ?? 0) > 0 ? (t.pnl ?? 0) : 0), 0);
  const myLosPnl   = myClosed.reduce((s, t) => s + ((t.pnl ?? 0) < 0 ? Math.abs(t.pnl ?? 0) : 0), 0);
  const pf         = myLosPnl > 0 ? (myWinPnl / myLosPnl).toFixed(2) : '∞';

  const todayCol = myTodayPnL >= 0 ? C.green : C.red;
  const totalCol = myAllPnL   >= 0 ? C.green : C.red;
  const pfNum    = parseFloat(pf);
  const pfCol    = pfNum >= 2 ? C.green : pfNum >= 1 ? C.yellow : C.red;

  console.log(divLine);
  console.log(`  ${C.bold}PAPER TRADING${C.reset}  ${C.dim}balance $${(ledger.balance ?? 0).toLocaleString()}  start $${(ledger.startBalance ?? 0).toLocaleString()}${C.reset}`);
  console.log(
    `  SPY Today: ${todayCol}${myTodayPnL >= 0 ? '+' : ''}$${myTodayPnL.toFixed(0)}${C.reset}` +
    `  SPY P&L: ${totalCol}${myAllPnL >= 0 ? '+' : ''}$${myAllPnL.toFixed(0)}${C.reset}` +
    `  WR: ${C.bold}${winRate}%${C.reset} (${myWins}W/${myLosses}L)` +
    `  PF: ${pfCol}${pf}${C.reset}`
  );

  if (myOpen.length > 0) {
    const nowMs = Date.now();
    for (const t of myOpen) {
      const holdMins = Math.round((nowMs - (t.fillTime ?? t.ts ?? nowMs)) / 60000);
      const typeTag  = (t.type ?? '').toUpperCase() === 'PUT' ? `${C.red}PUT${C.reset}` : `${C.green}CALL${C.reset}`;
      const eng      = t.engine ?? t.signal ?? '?';
      const strikeStr = t.strike ? ` $${t.strike}` : '';
      console.log(
        `  ${C.bold}OPEN${C.reset}  ${typeTag} ${C.bold}${t.instrument ?? '?'}${strikeStr}${C.reset}` +
        `  entry $${(t.fillPrice ?? 0).toFixed(2)}` +
        `  ${holdMins}m  ${C.dim}${eng}${C.reset}`
      );
    }
  } else {
    console.log(`  ${C.dim}No open SPY positions${C.reset}`);
  }

  const todayClosed = myClosed
    .filter(t => t.exitTime && fmtET(t.exitTime) === today)
    .slice(-5).reverse();
  for (const t of todayClosed) {
    const pnl     = t.pnl ?? 0;
    const pnlCol  = pnl >= 0 ? C.green : C.red;
    const icon    = pnl >= 0 ? '✓' : '✗';
    const typeStr = (t.type ?? '').toUpperCase();
    const strikeStr = t.strike ? ` $${t.strike}` : '';
    const exitStr = t.exitReason ? ` ${C.dim}${t.exitReason}${C.reset}` : '';
    const exitTime = t.exitTimeET ? ` ${C.dim}${t.exitTimeET.slice(0, 5)}${C.reset}` : '';
    console.log(
      `  ${pnlCol}${icon}${C.reset} ${typeStr} ${t.instrument ?? '?'}${strikeStr}` +
      `  ${pnlCol}${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}${C.reset}${exitStr}${exitTime}`
    );
  }
  } catch(e) { console.log(`  ${C.gray}[PAPER] panel error: ${e.message}${C.reset}`); }
}

function fmtPrice(n)  { return n != null ? n.toFixed(2).padStart(9)  : '      N/A'; }
function fmtVwap(n)   { return n != null ? n.toFixed(2).padStart(9)  : '      N/A'; }
function fmtVol(n) {
  if (n == null || n <= 0) return 'N/A';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(0) + 'K';
  return Math.round(n).toString();
}
function fmtDelta(n)  {
  if (n == null) return '      N/A';
  const sign = n >= 0 ? '+' : '-';
  const abs  = Math.abs(n);
  let s;
  if (abs >= 1_000_000) s = (abs / 1_000_000).toFixed(2) + 'M';
  else if (abs >= 1_000) s = (abs / 1_000).toFixed(1) + 'K';
  else s = Math.round(abs).toString();
  return (sign + s).padStart(9);
}

function fmtVrrs(vrrs, vrrsSector) {
  if (vrrs == null) return C.gray + '   N/A' + C.reset;
  const col = vrrs >= VRRS_THRESH  ? C.green
            : vrrs <= -VRRS_THRESH ? C.red
            : C.gray;
  const sectorStr = vrrsSector != null
    ? (Math.sign(vrrs) === Math.sign(vrrsSector) ? C.dim + '✓' : C.yellow + '÷') + C.reset
    : C.gray + ' ' + C.reset;
  return col + vrrs.toFixed(2).padStart(6) + C.reset + sectorStr;
}

function getETString() {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function isMarketHours() {
  const t = new Date().toLocaleTimeString('en-US', { timeZone:'America/New_York', hour12:false, hour:'2-digit', minute:'2-digit' });
  const [h, m] = t.split(':').map(Number);
  return (h * 60 + m) >= 7 * 60 && (h * 60 + m) < 16 * 60;
}

function isTradingHours() {
  const t = new Date().toLocaleTimeString('en-US', { timeZone:'America/New_York', hour12:false, hour:'2-digit', minute:'2-digit' });
  const [h, m] = t.split(':').map(Number);
  return (h * 60 + m) >= 9 * 60 + 30 && (h * 60 + m) < 15 * 60 + 45;
}

// Throttle "outside market hours" message — print once per hour max
let lastOutsideMsg = 0;
function printOutsideHours() {
  const now = Date.now();
  if (now - lastOutsideMsg < 60 * 60 * 1000) return; // once per hour
  lastOutsideMsg = now;
  console.log(`  ${C.gray}Outside market hours (${getETString()} ET) — next session at 07:00 ET${C.reset}`);
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

const SESSIONS = [
  { name:'PRE-FLIGHT',   start: 7*60,     end: 9*60+25,  color:'\x1b[90m', trade:false },
  { name:'MOO',          start: 9*60+25,  end: 9*60+35,  color:'\x1b[33m', trade:true  },
  { name:'BULLET-1',     start: 9*60+35,  end: 9*60+50,  color:'\x1b[32m', trade:true  },
  { name:'TREND-TIME',   start: 9*60+50,  end:10*60+45,  color:'\x1b[32m', trade:true  },
  { name:'LATE-MORNING', start:10*60+45,  end:11*60+20,  color:'\x1b[32m', trade:true  },
  { name:'UK-CLOSE',     start:11*60+20,  end:11*60+50,  color:'\x1b[33m', trade:true  },
  { name:'MIDDAY',       start:11*60+50,  end:14*60+30,  color:'\x1b[33m', trade:true  },
  { name:'AFTERNOON',    start:14*60+30,  end:15*60,     color:'\x1b[32m', trade:true  },
  { name:'PRE-MOC',      start:15*60,     end:15*60+30,  color:'\x1b[32m', trade:true  },
  { name:'SPX-ONLY',     start:15*60+30,  end:15*60+50,  color:'\x1b[34m', trade:true  },
  { name:'MOC',          start:15*60+50,  end:16*60,     color:'\x1b[34m', trade:true  },
  { name:'AFTER-HOURS',  start:16*60,     end:24*60,     color:'\x1b[90m', trade:false },
];

function getETMins() {
  const t = new Date().toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:false,hour:'2-digit',minute:'2-digit'});
  const [h,m] = t.split(':').map(Number); return h*60+m;
}
function getSession() { const m=getETMins(); return SESSIONS.find(s=>m>=s.start&&m<s.end)||SESSIONS[0]; }
function isOpeningWindow() { const m=getETMins(); return m>=9*60+30&&m<9*60+55; }

const OPEN_THRESH  = 3;
const VWAP_NEUTRAL = 0.05;

// ─── News Context Engine ──────────────────────────────────────────────────────
// Reads overnight-news.json written by news.js terminal (runs in separate window).
// Scores rolling 30-min headline bias → gates counter-trend entries + boosts aligned ones.

const BULL_NEWS_WORDS = ['rate cut','guidance raised','ceasefire','deal signed','upgrade','recovery','stimulus','lower inflation','fed cut','beat','truce'];
const BEAR_NEWS_WORDS = ['rate hike','guidance cut','miss','war','attack','blockade','tariff','inflation high','record low','hawkish','sanctions','conflict','clashes','struck','seized','disabled','blockade'];

let _newsBias  = 0;   // positive = bull news, negative = bear news
let _newsTitle = '';  // most recent headline (for display)
let _newsTime  = '';  // ET time of most recent headline
let _w3Score   = 0;   // Mag-7 bull count (0–5) — updated each poll, used by news gate override
let _isChop    = false; // updated each poll — MIDDAY chop filter
let _spyPrice  = 0;     // underlying prices for Webull contract selection in executeScalpSignal
let _qqqPrice  = 0;
let _iwmPrice  = 0;

// §18 — Direction conflict tracker (first-fired-wins, 10 min window).
// Prevents same-instrument opposite-direction whipsaw (e.g. FADE PUTS + STRUCTURE
// CALLS firing in same poll). Per-instrument because monitor.js handles SPY/QQQ/IWM.
const _lastFire = { SPY: { ms: 0, dir: null }, QQQ: { ms: 0, dir: null }, IWM: { ms: 0, dir: null } };
const DIRECTION_CONFLICT_MS = 10 * 60 * 1000;
// HIERARCHY_V2 booster + gate context — set each poll() before dispatch
let _spyVwap   = 0;
let _qqqVwap   = 0;
let _iwmVwap   = 0;
let _spyBulls  = 0;     // Mag-6 bull count (0–6)
let _spyBears  = 0;     // Mag-6 bear count (0–6)
let _spyTick   = 0;     // $TICK
let _spyDelta  = 0;     // SPY volume delta

function refreshNewsBias() {
  try {
    const raw  = readFileSync(join(__dirname, 'overnight-news.json'), 'utf8');
    const list = JSON.parse(raw);
    const cut  = Date.now() - 30 * 60 * 1000;  // last 30 min
    let score  = 0;
    for (const h of list.filter(h => h.ts > cut)) {
      const lo    = h.title.toLowerCase();
      const bulls = BULL_NEWS_WORDS.filter(w => lo.includes(w)).length;
      const bears = BEAR_NEWS_WORDS.filter(w => lo.includes(w)).length;
      const wt    = h.tier === 1 ? 2 : h.tier === 2 ? 1.5 : 1;
      score      += (bulls - bears) * wt;
    }
    _newsBias = score;
    if (list.length) { const last = list[list.length-1]; _newsTitle = last.title; _newsTime = last.time; }
  } catch { /* news.js not running — bias stays at 0, no gating */ }
}

// ─── TREND ENGINE (Friday version) ────────────────────────────────────────────

function trendEngine(bulls, bears, spy, spySummary, isChop, w3Score, tick) {
  const spyPrice  = spy.price  ?? 0;
  const spyVwap   = spy.vwap   ?? 0;
  const spyDelta  = spy.delta  ?? 0;
  const spyEma9   = spy.ema9   ?? null;
  const spyUpper  = spy.levels?.resistance?.find(r=>r.label==='VWAP+1\u03c3')?.price ?? null;
  const spyLower  = spy.levels?.support?.find(s=>s.label==='VWAP-1\u03c3')?.price   ?? null;

  const spyBelowVwap = spyVwap>0 && spyPrice<spyVwap;
  const spyAboveVwap = spyVwap>0 && spyPrice>spyVwap;
  const spyBelowEma9 = spyEma9!=null && spyPrice<spyEma9;
  const spyAboveEma9 = spyEma9!=null && spyPrice>spyEma9;
  const spyNegDelta  = spyDelta < -500;
  const spyPosDelta  = spyDelta >  500;

  const isAfternoon = getETMins() >= 14*60+30;
  const tickThresh  = isAfternoon ? 200 : 300;
  const tickBull    = tick!=null && tick >  tickThresh;
  const tickBear    = tick!=null && tick < -tickThresh;
  const tickExtBull = tick!=null && tick >  600;
  const tickExtBear = tick!=null && tick < -600;

  const approachSup = spySummary?.distSup!=null && spySummary.distSup<0.10;
  const approachRes = spySummary?.distRes!=null && spySummary.distRes<0.10;
  const breakdown   = spySummary?.status?.includes('BELOW SUPPORT');
  const breakout    = spySummary?.status?.includes('ABOVE RESISTANCE');
  const thresh      = isOpeningWindow() ? OPEN_THRESH : THRESHOLD;
  const w3ok        = w3Score >= 3;

  const recentBars = (spy.bars??[]).slice(-8);
  let isConsolidating = false;
  if(recentBars.length>=4) {
    const rH=Math.max(...recentBars.map(b=>b.high)), rL=Math.min(...recentBars.map(b=>b.low));
    isConsolidating = (rH-rL)/rL*100 < 0.12;
  }

  const spyStructBear = spyBelowVwap && spyBelowEma9;
  const spyStructBull = spyAboveVwap && spyAboveEma9;
  const spyStructBearWeak = spyBelowVwap || spyBelowEma9;
  const spyStructBullWeak = spyAboveVwap || spyAboveEma9;
  const spyDivPlus  = spyBelowVwap && spyPosDelta;
  const spyDivMinus = spyAboveVwap && spyNegDelta;
  const spyBearFactors = [spyBelowVwap,spyBelowEma9,spyNegDelta,tickBear].filter(Boolean).length;
  const spyBullFactors = [spyAboveVwap,spyAboveEma9,spyPosDelta,tickBull].filter(Boolean).length;
  const spyStrongBear = spyBearFactors>=3 && !spyDivPlus;
  const spyStrongBull = spyBullFactors>=3 && !spyDivMinus;

  // PRIORITY 1: EXTREME TICK
  if(tickExtBear && (spyBelowVwap||spyBelowEma9) && spyNegDelta)
    return{action:'TAKE PUTS \ud83d\udd34',confidence:'TICK-EXTREME',
      reason:`$TICK ${tick} extreme · SPY below ${spyBelowVwap?'VWAP':'9EMA'} · delta ${(spyDelta/1000).toFixed(1)}K`,engine:'TREND'};
  if(tickExtBull && (spyAboveVwap||spyAboveEma9) && spyPosDelta)
    return{action:'TAKE CALLS \ud83d\udfe2',confidence:'TICK-EXTREME',
      reason:`$TICK +${tick} extreme · SPY above ${spyAboveVwap?'VWAP':'9EMA'} · delta +${(spyDelta/1000).toFixed(1)}K`,engine:'TREND'};

  // VWAP-1σ bounce in chop
  if(isChop && spyLower!=null && spyPrice<=spyLower*1.003 && spyDelta>-2000 && tick!=null&&tick>0)
    return{action:'VWAP-1\u03c3 BOUNCE \ud83d\udfe2',confidence:'MEDIUM',
      reason:`Price at VWAP-1\u03c3 $${spyLower.toFixed(2)} · delta recovering · $TICK +${tick}`,engine:'BOUNCE'};
  if(isChop) return{action:'CHOP — STAY OUT \ud83d\udfe1',confidence:'NONE',reason:'Heavy DIV- flow — no clear direction',engine:'TREND'};

  // PRIORITY 3: SPY-FIRST
  if(spyStrongBear && !isConsolidating) {
    const m=bears>0?` · ${bears}/6 confirm`:'';
    return{action:'TAKE PUTS \ud83d\udd34',confidence:'SPY-FIRST',
      reason:`SPY ${spyBearFactors}/4 bear · VWAP:${spyBelowVwap?'✓':'✗'} EMA:${spyBelowEma9?'✓':'✗'} Delta:${spyNegDelta?'✓':'✗'} TICK:${tickBear?'✓':'✗'}${m}`,engine:'TREND'};
  }
  if(spyStrongBull) {
    const m=bulls>0?` · ${bulls}/6 confirm`:'';
    return{action:'TAKE CALLS \ud83d\udfe2',confidence:'SPY-FIRST',
      reason:`SPY ${spyBullFactors}/4 bull · VWAP:${spyAboveVwap?'✓':'✗'} EMA:${spyAboveEma9?'✓':'✗'} Delta:${spyPosDelta?'✓':'✗'} TICK:${tickBull?'✓':'✗'}${m}`,engine:'TREND'};
  }

  // W3 override
  if(spyStructBull && w3Score>=4 && tickBull && bulls<thresh)
    return{action:'TAKE CALLS \ud83d\udfe2',confidence:'SPY+W3 OVERRIDE',reason:`SPY bull + W3 ${w3Score}/6 + $TICK +${tick}`,engine:'TREND'};
  if(spyStructBear && w3Score>=4 && tickBear && bears<thresh)
    return{action:'TAKE PUTS \ud83d\udd34',confidence:'SPY+W3 OVERRIDE',reason:`SPY bear + W3 ${w3Score}/6 + $TICK ${tick}`,engine:'TREND'};

  // HIGH \u2014 3/4 conditions sufficient; TICK is advisory only (Issue 4)
  const highBullScore = [bulls>=thresh, !!spyStructBullWeak, !!tickBull, w3ok].filter(Boolean).length;
  if(highBullScore >= 3 && (approachSup||breakout))
    return{action:'TAKE CALLS \ud83d\udfe2',confidence:'HIGH',
      reason:`${bulls}/6 BULL + SPY bull + ${tickBull?'$TICK +'+tick:'TICK advisory'} + W3 ${w3Score}/6`,engine:'TREND'};
  const highBearScore = [bears>=thresh, !!spyStructBearWeak, !!tickBear, w3ok].filter(Boolean).length;
  if(highBearScore >= 3 && (approachRes||breakdown))
    return{action:'TAKE PUTS \ud83d\udd34',confidence:'HIGH',
      reason:`${bears}/6 BEAR + SPY bear + ${tickBear?'$TICK '+tick:'TICK advisory'} + W3 ${w3Score}/6`,engine:'TREND'};

  // MEDIUM
  if(bulls>=thresh && spyStructBull)
    return{action:'TAKE CALLS \ud83d\udfe2',confidence:'MEDIUM',reason:`${bulls}/6 BULL + SPY bull structure`,engine:'TREND'};
  if(bears>=thresh && spyStructBear)
    return{action:'TAKE PUTS \ud83d\udd34',confidence:'MEDIUM',reason:`${bears}/6 BEAR + SPY bear structure`,engine:'TREND'};

  // WEAK
  if(bulls>=thresh) return{action:'CALLS — WAIT \u26a0\ufe0f',confidence:'WEAK',reason:`${bulls}/6 BULL but SPY not confirming`,engine:'TREND'};
  if(bears>=thresh) return{action:'PUTS — WAIT \u26a0\ufe0f',confidence:'WEAK',reason:`${bears}/6 BEAR but SPY not confirming`,engine:'TREND'};

  return{action:'NEUTRAL — WAIT \u2b1c',confidence:'NONE',reason:`Mixed (BULL ${bulls}/6  BEAR ${bears}/6)`,engine:'TREND'};
}

// ─── FADE ENGINE (Friday version) ─────────────────────────────────────────────

function fadeEngine(spy) {
  const{price,vwap,delta,tick}=spy;
  if(!price||!vwap||delta==null) return null;
  const upper = spy.levels?.resistance?.find(r=>r.label==='VWAP+1\u03c3')?.price ?? null;
  const lower = spy.levels?.support?.find(s=>s.label==='VWAP-1\u03c3')?.price   ?? null;
  const pdh   = global.preMarketLevels?.pdHigh;
  const pdl   = global.preMarketLevels?.pdLow;
  const tickBullish = tick!=null && tick>300;
  const tickBearish = tick!=null && tick<-300;
  const tickExtreme = tick!=null && Math.abs(tick)>600;

  if(pdh!=null && Math.abs(price-pdh)/pdh*100<0.05 && delta<-2000) {
    if(tickBullish&&!tickExtreme) return null;
    return{action:'PDH REJECTION — TAKE PUTS \ud83d\udd34',confidence:'MEDIUM',
      reason:`Price at PDH $${pdh.toFixed(2)} · delta ${(delta/1000).toFixed(1)}K negative${tick!=null?' · $TICK '+tick:''}`,engine:'FADE'};
  }
  if(upper!=null && Math.abs(price-upper)/upper*100<0.08 && delta<-3000) {
    if(tickBullish&&!tickExtreme) return null;
    return{action:'ALGO POP FADE — TAKE PUTS \u26a1\ud83d\udd34',confidence:'MEDIUM',
      reason:`Price at VWAP+1\u03c3 $${upper.toFixed(2)} · delta ${(delta/1000).toFixed(1)}K flipping negative${tick!=null?' · $TICK '+tick:''}`,engine:'FADE'};
  }
  if(price<vwap && Math.abs(price-vwap)/vwap*100<0.05 && delta<-2000) {
    if(tickBullish&&!tickExtreme) return null;
    return{action:'VWAP REJECTION — TAKE PUTS \u26a1\ud83d\udd34',confidence:'MEDIUM',
      reason:`Price rejected at VWAP $${vwap.toFixed(2)} from below · delta ${(delta/1000).toFixed(1)}K negative${tick!=null?' · $TICK '+tick:''}`,engine:'FADE'};
  }
  if(pdl!=null && Math.abs(price-pdl)/pdl*100<0.05 && delta>2000) {
    if(tickBearish) return null;
    return{action:'PDL BOUNCE — TAKE CALLS \ud83d\udfe2',confidence:'MEDIUM',
      reason:`Price at PDL $${pdl.toFixed(2)} · delta +${(delta/1000).toFixed(1)}K positive${tick!=null?' · $TICK '+tick:''}`,engine:'FADE'};
  }
  if(lower!=null && Math.abs(price-lower)/lower*100<0.08 && delta>2000) {
    if(tickBearish) return null;
    return{action:'VWAP-1\u03c3 BOUNCE — TAKE CALLS \u26a1\ud83d\udfe2',confidence:'MEDIUM',
      reason:`Price at VWAP-1\u03c3 $${lower.toFixed(2)} · delta +${(delta/1000).toFixed(1)}K positive${tick!=null?' · $TICK '+tick:''}`,engine:'FADE'};
  }
  return null;
}

// ─── Generalized signal builder for QQQ and IWM ───────────────────────────────
// Same logic as buildSignal() but instrument-scoped.
// threshold: QQQ uses 4/6, IWM uses 2/3 (fewer components)

function buildSignalForInstrument(instrument, rows, etf, etfSummary, threshold) {
  const bullish = etf?.bias === 'bullish';
  const bearish = etf?.bias === 'bearish';
  const approachingSup = etfSummary?.distSup != null && etfSummary.distSup < 0.10;
  const approachingRes = etfSummary?.distRes != null && etfSummary.distRes < 0.10;
  const breakdown = etfSummary?.status?.includes('BELOW SUPPORT');
  const breakout  = etfSummary?.status?.includes('ABOVE RESISTANCE');

  const etfVrrsConfirmsBull = etf?.vrrs != null && etf.vrrs >= VRRS_THRESH
                           && (etf.vrrsSector == null || etf.vrrsSector >= 0);
  const etfVrrsConfirmsBear = etf?.vrrs != null && etf.vrrs <= -VRRS_THRESH
                           && (etf.vrrsSector == null || etf.vrrsSector <= 0);

  const etfL2          = getL2Signal(instrument);
  const l2ConfirmsBull = etfL2?.bias === 'BULLISH' && (etfL2?.strength ?? 0) >= 2;
  const l2ConfirmsBear = etfL2?.bias === 'BEARISH' && (etfL2?.strength ?? 0) >= 2;
  const l2Note         = etfL2 ? ` | L2 ${(etfL2.imbalance*100).toFixed(0)}% bid (str ${etfL2.strength})` : '';

  const compRows  = rows.filter(r => r.symbol !== instrument);
  const bulls     = compRows.filter(r => r.bias === 'bullish' || (r.bias==='div_bear' && r.delta > -1000)).length;
  const bears     = compRows.filter(r => r.bias === 'bearish' || (r.bias==='div_bull' && r.delta <  1000)).length;
  const total     = compRows.length;
  const heavyDiv  = compRows.filter(r => r.bias==='div_bear' && r.delta < -1000).length;
  const isChop    = heavyDiv >= Math.ceil(total * 0.5) && bulls < 2 && bears < 2;

  const vrrsNote  = etf?.vrrs != null ? ` | VRRS ${etf.vrrs.toFixed(2)}${etf.vrrsSector!=null?(Math.sign(etf.vrrs)===Math.sign(etf.vrrsSector)?' ✓':' ÷'):''}` : '';

  if (isChop) return { action:'CHOP — STAY OUT 🟡', confidence:'NONE', reason:`Heavy DIV- flow — no clear direction`, bulls, bears, total };

  if (bulls >= threshold && bullish && etfVrrsConfirmsBull && (approachingSup || breakout)) {
    return { action:'TAKE CALLS 🟢', confidence:'HIGH',
             reason:`${bulls}/${total} BULL + ${instrument} bullish + VRRS${etf.vrrs.toFixed(2)}${l2ConfirmsBull?l2Note:''} + ${breakout?'breakout':'near support'}`, bulls, bears, total };
  }
  if (bears >= threshold && bearish && etfVrrsConfirmsBear && (approachingRes || breakdown)) {
    return { action:'TAKE PUTS 🔴', confidence:'HIGH',
             reason:`${bears}/${total} BEAR + ${instrument} bearish + VRRS${etf.vrrs.toFixed(2)}${l2ConfirmsBear?l2Note:''} + ${breakdown?'breakdown':'near resistance'}`, bulls, bears, total };
  }
  if (bulls >= threshold && bullish) {
    return { action:'TAKE CALLS 🟢', confidence:'MEDIUM', reason:`${bulls}/${total} BULL + ${instrument} bullish${vrrsNote}${l2Note}`, bulls, bears, total };
  }
  if (bears >= threshold && bearish) {
    return { action:'TAKE PUTS 🔴', confidence:'MEDIUM', reason:`${bears}/${total} BEAR + ${instrument} bearish${vrrsNote}${l2Note}`, bulls, bears, total };
  }
  if (bulls >= threshold) {
    return { action:'CALLS — WAIT ⚠️', confidence:'WEAK', reason:`${bulls}/${total} BULL but ${instrument} not confirming (${etf?.bias})${vrrsNote}`, bulls, bears, total };
  }
  if (bears >= threshold) {
    return { action:'PUTS — WAIT ⚠️', confidence:'WEAK', reason:`${bears}/${total} BEAR but ${instrument} not confirming (${etf?.bias})${vrrsNote}`, bulls, bears, total };
  }
  return { action:'NEUTRAL — WAIT ⬜', confidence:'NONE', reason:`Mixed (BULL ${bulls}/${total}  BEAR ${bears}/${total})${vrrsNote}`, bulls, bears, total };
}

// ─── Print summary ────────────────────────────────────────────────────────────

function printSummary(rows, spy, bulls, bears, spySummary, isChop, swingState, spyAnalysis, trendSig, fadeSig, w3Rows, session, structureSig) {
  const line = '  ' + '─'.repeat(72);
  console.log('\n' + line);

  console.log(C.bold + '  ╔══════════════════════════════════════════════════════════════════════╗' + C.reset);
  const sesDisplay = session ? `${session.color}${session.name}${C.reset}${C.bold}` : 'HANK';
  console.log(C.bold + `  ║  HANK AI v3  │  ${getETString()} ET  │  ${sesDisplay}  │  BULL ${bulls}/6  BEAR ${bears}/6  ║` + C.reset);
  console.log(C.bold + '  ╠══════════════════════════════════════════════════════════════════════╣' + C.reset);
  console.log(C.dim  + '  SYM      PRICE       VWAP      DELTA    BIAS    LEVELS' + C.reset);
  console.log(line);

  for (const r of rows) {
    const supLabel = r.levels?.support[0]    ? C.green + r.levels.support[0].price.toFixed(2)    + C.reset : '';
    const resLabel = r.levels?.resistance[0] ? C.red   + r.levels.resistance[0].price.toFixed(2) + C.reset : '';
    const srStr    = [supLabel && `S:${supLabel}`, resLabel && `R:${resLabel}`].filter(Boolean).join(' ');
    const err      = r.error ? C.gray + ` (${r.error})` + C.reset : '';
    const vp       = r.volPct;
    const vCol     = vp == null ? C.gray : vp < 0.50 ? C.red : vp < 0.80 ? C.yellow : C.green;
    const volStr   = vp != null
      ? ` ${vCol}${(vp * 100).toFixed(0)}% (${fmtVol(r.barVol)})${C.reset}`
      : ` ${C.gray}vol N/A${C.reset}`;
    console.log(
      `  ${C.bold}${r.symbol.padEnd(6)}${C.reset}` +
      `  ${fmtPrice(r.price)}  ${fmtVwap(r.vwap)}  ${fmtDelta(r.delta)}` +
      `  ${biasTag(r.bias)}  ${fmtVrrs(r.vrrs, r.vrrsSector)}  ${srStr}${volStr}${err}`
    );
  }

  console.log(line);

  // SPY row
  const spySupLabel = spy.levels?.support[0]    ? C.green + spy.levels.support[0].price.toFixed(2)    + C.reset : '';
  const spyResLabel = spy.levels?.resistance[0] ? C.red   + spy.levels.resistance[0].price.toFixed(2) + C.reset : '';
  const spySrStr    = [spySupLabel && `S:${spySupLabel}`, spyResLabel && `R:${spyResLabel}`].filter(Boolean).join(' ');
  console.log(
    `  ${'SPY'.padEnd(6)}` +
    `  ${fmtPrice(spy.price)}  ${fmtVwap(spy.vwap)}  ${fmtDelta(spy.delta)}` +
    `  ${biasTag(spy.bias)}  ${fmtVrrs(spy.vrrs, spy.vrrsSector)}  ${spySrStr}` +
    ` ${C.dim}← Claude SPY tab${C.reset}`
  );

  // SPY technical analysis block
  if (spySummary) {
    const tC = spySummary.trendDir === 'Bullish' ? C.green : C.red;
    console.log(line);
    console.log(`  ${C.bold}SPY ANALYSIS${C.reset}`);
    console.log(`  Trend:      ${tC}${spySummary.trendDir}${C.reset} — ${spySummary.trendDetail}`);
    if (spySummary.nearRes) {
      console.log(`  Resistance: ${C.red}$${spySummary.nearRes.price.toFixed(2)}${C.reset}  ${C.dim}+${spySummary.distRes?.toFixed(2)}% away  [${spySummary.nearRes.label}]${C.reset}`);
    }
    if (spySummary.nearSup) {
      console.log(`  Support:    ${C.green}$${spySummary.nearSup.price.toFixed(2)}${C.reset}  ${C.dim}-${spySummary.distSup?.toFixed(2)}% away  [${spySummary.nearSup.label}]${C.reset}`);
    }
    console.log(`  Status:     ${spySummary.status}`);
    console.log(`  Flow:       ${spy.delta != null ? fmtDelta(spy.delta) + (spy.delta < 0 ? C.red + '  sellers' : C.green + '  buyers') + C.reset : 'N/A'}`);
    if (spy.vrrs != null) {
      const vrrsCol = spy.vrrs >= VRRS_THRESH ? C.green : spy.vrrs <= -VRRS_THRESH ? C.red : C.gray;
      const sectorStr = spy.vrrsSector != null
        ? ` | Sector ${spy.vrrsSector.toFixed(2)} (${Math.sign(spy.vrrs) === Math.sign(spy.vrrsSector) ? '✓ confirms' : '÷ diverges'})`
        : '';
      const crDisp = spy.vrrsChangeRate != null ? ` | ChgRate ${spy.vrrsChangeRate.toFixed(2)}%/bar` : '';
      console.log(`  VRRS:       ${vrrsCol}${spy.vrrs.toFixed(3)}${C.reset}${sectorStr}${crDisp}`);
    }
    const _vp    = _spyVolPct;
    const _vVol  = (spy.bars ?? []).reduce((s, b) => s + (b.volume ?? 0), 0);
    const _vCol  = _vp < 0.50 ? C.red : _vp < 0.80 ? C.yellow : C.green;
    const _vIcon = _vp < 0.50 ? '🔴' : _vp < 0.80 ? '🟡' : '🟢';
    console.log(`  Volume:     ${_vCol}${(_vp * 100).toFixed(0)}% of avg (${fmtVol(_vVol)})${C.reset}  ${_vIcon}`);
  }

  // ── PAPER TRADING panel ───────────────────────────────────────────────────
  printPaperPanel(line);

  // ── TREND ENGINE ──────────────────────────────────────────────────────────
  // Path 2 simplification 2026-05-11: silenced under HIERARCHY_V2 so the
  // console reflects only what actually dispatches (chart engines).
  if (trendSig && !HIERARCHY_V2) {
    const sc = trendSig.action.includes('CALLS')?C.green:trendSig.action.includes('PUTS')?C.red:trendSig.action.includes('CHOP')?C.yellow:C.gray;
    const cc = ['HIGH','SPY+W3 OVERRIDE','TICK-EXTREME','SPY-FIRST'].includes(trendSig.confidence)?C.green:['MEDIUM','WEAK','W3-EARLY'].includes(trendSig.confidence)?C.yellow:C.gray;
    console.log(line);
    console.log(`  ${C.bold}TREND ENGINE${C.reset}`);
    console.log(`  Action:     ${sc}${C.bold}${trendSig.action}${C.reset}`);
    console.log(`  Confidence: ${cc}${trendSig.confidence}${C.reset}`);
    console.log(`  Reason:     ${trendSig.reason}`);
    if(['HIGH','TICK-EXTREME','SPY-FIRST','SPY+W3 OVERRIDE'].includes(trendSig.confidence)) process.stdout.write('\x07');
    // Session guidance
    const guidance = {
      'MOO':'MOO — Wait for opening candle · fade engine for VWAP reactions',
      'BULLET-1':'Fast scalp — 30% target — exit quickly',
      'TREND-TIME':'Higher conviction — extend 100%+ if VWAP holds',
      'UK-CLOSE':'UK close volume surge — FADE engine VWAP band touches',
      'MIDDAY':'Midday · Reduce size · Both engines active · Watch VWAP reclaim/rejection',
      'AFTERNOON':'Afternoon · Follow momentum · SPY-FIRST active',
      'PRE-MOC':'Pre-MOC — SPY 0DTE only — watch imbalance',
      'SPX-ONLY':'SPX only — fade engine VWAP touches',
      'MOC':'Second pop 15:54 — exit 15:59 HARD',
    };
    if(session && guidance[session.name]) console.log(`  Session:    ${session.color}${guidance[session.name]}${C.reset}`);
  }

  // ── FADE ENGINE ────────────────────────────────────────────────────────────
  if (fadeSig) {
    const fc = fadeSig.action.includes('CALLS')?C.green:C.red;
    console.log(line);
    console.log(`  ${C.bold}FADE ENGINE ⚡${C.reset}`);
    console.log(`  Action:     ${fc}${C.bold}${fadeSig.action}${C.reset}`);
    console.log(`  Confidence: ${C.yellow}${fadeSig.confidence}${C.reset}`);
    console.log(`  Reason:     ${fadeSig.reason}`);
    process.stdout.write('\x07');
  }

  // ── STRUCTURE ENGINE ───────────────────────────────────────────────────────
  if (structureSig) {
    const sc = structureSig.action === 'CALLS' ? C.green : C.red;
    const cc = structureSig.confidence === 'HIGH' ? C.green : C.yellow;
    console.log(line);
    console.log(`  ${C.bold}STRUCTURE ENGINE 📊${C.reset}`);
    console.log(`  Action:     ${sc}${C.bold}${structureSig.action}${C.reset}`);
    console.log(`  Confidence: ${cc}${structureSig.confidence}${C.reset}`);
    console.log(`  Pattern:    ${C.dim}${structureSig.event}${C.reset}`);
    console.log(`  Reason:     ${structureSig.reason}`);
    if (structureSig.confidence === 'HIGH') process.stdout.write('\x07');
  }

  // ── NEWS BIAS panel ───────────────────────────────────────────────────────
  if (_newsBias !== 0 && _newsTitle) {
    const strong = Math.abs(_newsBias) >= 5;
    const bc = _newsBias < 0 ? C.red : C.green;
    const bl = _newsBias < 0 ? 'BEAR' : 'BULL';
    const badge = strong ? `${bc}${C.bold}● ${bl} (${_newsBias.toFixed(0)}) STRONG${C.reset}` : `${bc}${bl} (${_newsBias.toFixed(0)})${C.reset}`;
    console.log(line);
    console.log(`  ${C.bold}NEWS BIAS${C.reset}  ${badge}  ${C.dim}${_newsTime} · ${_newsTitle.slice(0, 60)}${C.reset}`);
    if (strong && _newsBias < 0) console.log(`  ${C.dim}→ CALLS blocked | PUTS confidence boosted${C.reset}`);
    if (strong && _newsBias > 0) console.log(`  ${C.dim}→ PUTS blocked | CALLS confidence boosted${C.reset}`);
  }

  // ── SWING ENGINE panel ─────────────────────────────────────────────────────
  if (swingState) {
    console.log(line);
    console.log(`  ${C.bold}SWING ENGINE${C.reset}  ${C.dim}SPY · ATR-based · 2.5:1 R:R${C.reset}`);

    const sw = swingState;
    const etMins = new Date().toLocaleTimeString('en-US', {
      timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
    }).split(':').reduce((h, m) => Number(h) * 60 + Number(m), 0);

    if (sw.status === 'WAITING') {
      const waitMsg = etMins < (9 * 60 + 29)
        ? `Waiting for 09:29:30 opening candle...`
        : `Watching for EMA9/VWAP bias confirmation...`;
      console.log(`  ${C.gray}${waitMsg}${C.reset}`);

    } else if (sw.status === 'LONG' || sw.status === 'SHORT') {
      const dirCol   = sw.status === 'LONG' ? C.green : C.red;
      const dirLabel = sw.status === 'LONG' ? '📈 LONG' : '📉 SHORT';
      const curPrice = spy.price;
      const floatPnl = curPrice != null
        ? (sw.status === 'LONG' ? curPrice - sw.entry : sw.entry - curPrice)
        : null;
      const floatPct = floatPnl != null ? (floatPnl / sw.entry * 100) : null;
      const toTarget = curPrice != null
        ? (sw.status === 'LONG' ? sw.target - curPrice : curPrice - sw.target)
        : null;
      const toStop   = curPrice != null
        ? (sw.status === 'LONG' ? curPrice - sw.stop : sw.stop - curPrice)
        : null;

      console.log(
        `  ${dirCol}${C.bold}${dirLabel}${C.reset}` +
        `  Entry $${sw.entry.toFixed(2)}` +
        `  Stop ${C.red}$${sw.stop}${C.reset}` +
        `  Target ${C.green}$${sw.target}${C.reset}` +
        `  ATR $${sw.atr?.toFixed(2) ?? '--'}` +
        `  ${C.dim}entered ${sw.entryTime} ET${C.reset}`
      );

      if (floatPnl != null) {
        const fpCol = floatPnl >= 0 ? C.green : C.red;
        console.log(
          `  Float P&L: ${fpCol}${floatPnl >= 0 ? '+' : ''}$${floatPnl.toFixed(2)} (${floatPct >= 0 ? '+' : ''}${floatPct?.toFixed(2)}%)${C.reset}` +
          `  ${C.dim}→ target in $${toTarget?.toFixed(2) ?? '--'}  stop in $${toStop?.toFixed(2) ?? '--'}${C.reset}`
        );
      }

    } else if (sw.status === 'CLOSED') {
      const pnlCol = (sw.pnl ?? 0) >= 0 ? C.green : C.red;
      const exitLabel = sw.exitReason === 'TARGET'     ? '✅ TARGET'
                      : sw.exitReason === 'STOP'       ? '🛑 STOP'
                      : sw.exitReason === 'TREND_EXIT' ? '⚠️  TREND EXIT'
                      : '⏰ EOD';
      console.log(
        `  ${pnlCol}${exitLabel}${C.reset}` +
        `  ${sw.direction} $${sw.entry?.toFixed(2)} → $${sw.exitPrice?.toFixed(2)}` +
        `  ${pnlCol}${(sw.pnl ?? 0) >= 0 ? '+' : ''}$${sw.pnl?.toFixed(2)} (${sw.pnlPct?.toFixed(2)}%)${C.reset}` +
        `  ${C.dim}No more swings today${C.reset}`
      );
    }
  }

  console.log(C.bold + '  ╚══════════════════════════════════════════════════════════════════════╝' + C.reset);
  console.log(`  ${C.dim}Threshold: ${THRESHOLD}/6 + SPY  │  VRRS: ±${VRRS_THRESH} @ ${CERT_THRESH}%  │  Poll: ${POLL_MS / 1000}s  │  Ctrl+C to quit${C.reset}\n`);

  // HANK LIVE ANALYSIS — SPY
  printLiveAnalysis('SPY', spyAnalysis, getETString());
}

// ─── Swing Engine ─────────────────────────────────────────────────────────────
//
// Runs from 09:30 ET. Locks opening candle bias at first poll after open.
// Uses SPY 30s bars to build synthetic 5-min candles for ATR-based stops.
// Holds position until ATR stop, ATR target, or 15:45 forced close.
//
// Entry logic (first candle at 09:30):
//   price > VWAP && price > EMA9 → LONG
//   price < VWAP && price < EMA9 → SHORT
//
// Stop / Target:
//   ATR(14) computed from synthetic 5-min candles (6 × 30s bars each)
//   Stop:   entry ± 1.0 × ATR
//   Target: entry ± 2.5 × ATR  (2.5:1 R:R — keeps you in +$4 SPY days)
//
// Exits:
//   1. Price hits target   → TAKE PROFIT
//   2. Price hits stop     → STOP LOSS
//   3. VWAP cross wrong way → TREND EXIT (early warning)
//   4. 15:45 ET hard close → EOD EXIT
//
// Integration:
//   poll() passes spy.bars + spy.vwap + spy.price each cycle
//   SwingEngine.update() returns current state for printSummary()
//   State is broadcast via wsServer in SIGNAL payload

const SwingEngine = (() => {
  // ── Constants ──────────────────────────────────────────────────────────────
  const SYNTH_BARS    = 6;    // 30s bars per synthetic 5-min candle
  const ATR_PERIOD    = 14;   // ATR lookback on synthetic 5-min candles
  const ATR_STOP_MULT = 1.0;  // stop loss = entry ± ATR × 1.0
  const ATR_TGT_MULT  = 2.5;  // target    = entry ± ATR × 2.5
  const CLOSE_HOUR    = 15;
  const CLOSE_MIN     = 45;   // hard close at 15:45 ET

  // ── State ──────────────────────────────────────────────────────────────────
  let state = {
    status:     'WAITING',   // WAITING | ARMED | LONG | SHORT | CLOSED
    direction:  null,        // 'LONG' | 'SHORT' | null
    entry:      null,        // entry price
    stop:       null,        // stop loss price
    target:     null,        // profit target price
    atr:        null,        // ATR at entry
    entryTime:  null,        // ET string at entry
    exitPrice:  null,        // filled exit price
    exitReason: null,        // 'TARGET' | 'STOP' | 'TREND_EXIT' | 'EOD'
    pnl:        null,        // $ P&L per share (× 100 for SPY contracts)
    pnlPct:     null,        // % return
    openedToday: false,      // only one swing trade per day
    lastUpdate:  null,
  };

  let openingBarsConsumed = false;  // lock once first candle is processed
  let barsBuffer          = [];     // accumulates 30s bars for EMA9 calc

  // ── Helpers ────────────────────────────────────────────────────────────────

  function getETMinsNow() {
    const t = new Date().toLocaleTimeString('en-US', {
      timeZone: 'America/New_York', hour12: false,
      hour: '2-digit', minute: '2-digit',
    });
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }

  function isHardCloseTime() {
    const mins = getETMinsNow();
    return mins >= CLOSE_HOUR * 60 + CLOSE_MIN;
  }

  function isOpeningWindow() {
    const mins = getETMinsNow();
    return mins >= 9 * 60 + 29 && mins <= 9 * 60 + 55; // 09:29–09:55 extended window
  }

  // EMA9 on close prices
  function calcEMA9(closes) {
    if (!closes.length) return null;
    const k = 2 / (9 + 1);
    let ema = closes[0];
    for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
    return ema;
  }

  // Build synthetic 5-min candles from 30s bars array
  function buildSynthCandles(bars30s) {
    const synth = [];
    for (let i = 0; i + SYNTH_BARS <= bars30s.length; i += SYNTH_BARS) {
      const chunk = bars30s.slice(i, i + SYNTH_BARS);
      synth.push({
        open:  chunk[0].open,
        high:  Math.max(...chunk.map(b => b.high)),
        low:   Math.min(...chunk.map(b => b.low)),
        close: chunk[chunk.length - 1].close,
      });
    }
    return synth;
  }

  // ATR(14) — Wilder's smoothed
  function calcATR(candles) {
    if (candles.length < 2) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const hl   = candles[i].high  - candles[i].low;
      const hpc  = Math.abs(candles[i].high  - candles[i - 1].close);
      const lpc  = Math.abs(candles[i].low   - candles[i - 1].close);
      trs.push(Math.max(hl, hpc, lpc));
    }
    if (trs.length < ATR_PERIOD) return trs.reduce((a, b) => a + b, 0) / trs.length;
    // Wilder smoothing
    let atr = trs.slice(0, ATR_PERIOD).reduce((a, b) => a + b, 0) / ATR_PERIOD;
    for (let i = ATR_PERIOD; i < trs.length; i++) {
      atr = (atr * (ATR_PERIOD - 1) + trs[i]) / ATR_PERIOD;
    }
    return atr;
  }

  // ── Core update — called every poll() ──────────────────────────────────────

  function update(spyPrice, spyVwap, spyEma9, bars30s) {
    if (!spyPrice || !bars30s?.length) return state;

    state.lastUpdate = getETString();

    // ── Hard close ────────────────────────────────────────────────────────────
    if ((state.status === 'LONG' || state.status === 'SHORT') && isHardCloseTime()) {
      const dir = state.status;
      state.exitPrice  = spyPrice;
      state.exitReason = 'EOD';
      state.pnl        = dir === 'LONG' ? spyPrice - state.entry : state.entry - spyPrice;
      state.pnlPct     = (state.pnl / state.entry) * 100;
      state.status     = 'CLOSED';
      process.stdout.write('\x07\x07');
      console.log(`\n  ${C.bgYellow}  ⏰ SWING EOD CLOSE  ${C.reset}  ${dir} closed at $${spyPrice.toFixed(2)}  P&L: ${state.pnl >= 0 ? C.green : C.red}${state.pnl >= 0 ? '+' : ''}$${state.pnl.toFixed(2)} (${state.pnlPct.toFixed(2)}%)${C.reset}`);
      return state;
    }

    // ── In-trade exit checks ──────────────────────────────────────────────────
    if (state.status === 'LONG') {
      // Target hit
      if (spyPrice >= state.target) {
        state.exitPrice  = state.target;
        state.exitReason = 'TARGET';
        state.pnl        = state.target - state.entry;
        state.pnlPct     = (state.pnl / state.entry) * 100;
        state.status     = 'CLOSED';
        process.stdout.write('\x07\x07\x07');
        console.log(`\n  ${C.bgGreen}  ✅ SWING TARGET HIT  ${C.reset}  LONG $${state.entry.toFixed(2)} → $${state.target.toFixed(2)}  ${C.green}+$${state.pnl.toFixed(2)} (+${state.pnlPct.toFixed(2)}%)${C.reset}`);
        return state;
      }
      // Stop hit
      if (spyPrice <= state.stop) {
        state.exitPrice  = state.stop;
        state.exitReason = 'STOP';
        state.pnl        = state.stop - state.entry;
        state.pnlPct     = (state.pnl / state.entry) * 100;
        state.status     = 'CLOSED';
        process.stdout.write('\x07\x07');
        console.log(`\n  ${C.bgRed}  🛑 SWING STOP HIT  ${C.reset}  LONG stopped at $${state.stop.toFixed(2)}  ${C.red}$${state.pnl.toFixed(2)} (${state.pnlPct.toFixed(2)}%)${C.reset}`);
        return state;
      }
      // VWAP cross exit (trend reversal warning)
      if (spyVwap != null && spyPrice < spyVwap) {
        state.exitPrice  = spyPrice;
        state.exitReason = 'TREND_EXIT';
        state.pnl        = spyPrice - state.entry;
        state.pnlPct     = (state.pnl / state.entry) * 100;
        state.status     = 'CLOSED';
        console.log(`\n  ${C.bgYellow}  ⚠️  SWING TREND EXIT  ${C.reset}  LONG — price crossed below VWAP  P&L: ${state.pnl >= 0 ? C.green : C.red}${state.pnl >= 0 ? '+' : ''}$${state.pnl.toFixed(2)}${C.reset}`);
        return state;
      }
    }

    if (state.status === 'SHORT') {
      // Target hit
      if (spyPrice <= state.target) {
        state.exitPrice  = state.target;
        state.exitReason = 'TARGET';
        state.pnl        = state.entry - state.target;
        state.pnlPct     = (state.pnl / state.entry) * 100;
        state.status     = 'CLOSED';
        process.stdout.write('\x07\x07\x07');
        console.log(`\n  ${C.bgGreen}  ✅ SWING TARGET HIT  ${C.reset}  SHORT $${state.entry.toFixed(2)} → $${state.target.toFixed(2)}  ${C.green}+$${state.pnl.toFixed(2)} (+${state.pnlPct.toFixed(2)}%)${C.reset}`);
        return state;
      }
      // Stop hit
      if (spyPrice >= state.stop) {
        state.exitPrice  = state.stop;
        state.exitReason = 'STOP';
        state.pnl        = state.entry - state.stop;
        state.pnlPct     = (state.pnl / state.entry) * 100;
        state.status     = 'CLOSED';
        process.stdout.write('\x07\x07');
        console.log(`\n  ${C.bgRed}  🛑 SWING STOP HIT  ${C.reset}  SHORT stopped at $${state.stop.toFixed(2)}  ${C.red}$${state.pnl.toFixed(2)} (${state.pnlPct.toFixed(2)}%)${C.reset}`);
        return state;
      }
      // VWAP cross exit
      if (spyVwap != null && spyPrice > spyVwap) {
        state.exitPrice  = spyPrice;
        state.exitReason = 'TREND_EXIT';
        state.pnl        = state.entry - spyPrice;
        state.pnlPct     = (state.pnl / state.entry) * 100;
        state.status     = 'CLOSED';
        console.log(`\n  ${C.bgYellow}  ⚠️  SWING TREND EXIT  ${C.reset}  SHORT — price crossed above VWAP  P&L: ${state.pnl >= 0 ? C.green : C.red}${state.pnl >= 0 ? '+' : ''}$${state.pnl.toFixed(2)}${C.reset}`);
        return state;
      }
    }

    // ── Opening entry — fires once at 09:30 ──────────────────────────────────
    if (state.status === 'WAITING' && !state.openedToday && isOpeningWindow()) {
      if (!openingBarsConsumed && bars30s.length > 0 && spyVwap != null && spyEma9 != null) {
        openingBarsConsumed = true;

        // Compute ATR from synthetic 5-min candles
        const synthCandles = buildSynthCandles(bars30s);
        const atr          = calcATR(synthCandles) ?? (spyPrice * 0.001); // fallback 0.1%
        const atrScaled    = Math.max(atr, 0.10); // floor at $0.10 to avoid micro-stops

        let bullBias = spyPrice > spyVwap && spyPrice > spyEma9;
        let bearBias = spyPrice < spyVwap && spyPrice < spyEma9;

        // MOO signal override — read moo-signal.json from moo-moc.js
        // GREEN MOO resolves ambiguity when price is between VWAP and EMA9
        // GREEN MOO also prints confirmation when it agrees with VWAP/EMA9 bias
        let mooSignal = null;
        try {
          const mooPath = join(__dirname, 'moo-signal.json');
          if (existsSync(mooPath)) {
            const moo = JSON.parse(readFileSync(mooPath, 'utf8'));
            const ageMs = Date.now() - (moo.ts ?? 0);
            if (ageMs < 40 * 60 * 1000 && moo.threshold === 'GREEN') mooSignal = moo.direction;
          }
        } catch { /* non-fatal */ }

        if (mooSignal && !bullBias && !bearBias) {
          // MOO override: no clear VWAP/EMA9 bias → use MOO direction
          if (mooSignal === 'BUY')  bullBias = true;
          if (mooSignal === 'SELL') bearBias = true;
          console.log(`  ${C.cyan}[SWING] MOO GREEN override → ${mooSignal === 'BUY' ? 'LONG' : 'SHORT'} (VWAP/EMA9 unclear)${C.reset}`);
        } else if (mooSignal) {
          const agrees = (mooSignal === 'BUY' && bullBias) || (mooSignal === 'SELL' && bearBias);
          const col    = agrees ? C.green : C.yellow;
          console.log(`  ${col}[SWING] MOO GREEN ${mooSignal} — ${agrees ? '✓ confirms bias' : '÷ diverges from VWAP/EMA9'}${C.reset}`);
        }

        if (bullBias) {
          state.status     = 'LONG';
          state.direction  = 'LONG';
          state.entry      = spyPrice;
          state.atr        = atrScaled;
          state.stop       = parseFloat((spyPrice - atrScaled * ATR_STOP_MULT).toFixed(2));
          state.target     = parseFloat((spyPrice + atrScaled * ATR_TGT_MULT).toFixed(2));
          state.entryTime  = getETString();
          state.openedToday = true;
          process.stdout.write('\x07');
          console.log(`\n  ${C.bgGreen}  📈 SWING LONG ENTRY  ${C.reset}  SPY $${spyPrice.toFixed(2)}  ATR $${atrScaled.toFixed(2)}  Stop $${state.stop}  Target $${state.target}  ${C.dim}${state.entryTime} ET${C.reset}`);
        } else if (bearBias) {
          state.status     = 'SHORT';
          state.direction  = 'SHORT';
          state.entry      = spyPrice;
          state.atr        = atrScaled;
          state.stop       = parseFloat((spyPrice + atrScaled * ATR_STOP_MULT).toFixed(2));
          state.target     = parseFloat((spyPrice - atrScaled * ATR_TGT_MULT).toFixed(2));
          state.entryTime  = getETString();
          state.openedToday = true;
          process.stdout.write('\x07');
          console.log(`\n  ${C.bgRed}  📉 SWING SHORT ENTRY  ${C.reset}  SPY $${spyPrice.toFixed(2)}  ATR $${atrScaled.toFixed(2)}  Stop $${state.stop}  Target $${state.target}  ${C.dim}${state.entryTime} ET${C.reset}`);
        } else {
          // No clear bias at open — stay WAITING, will retry next poll
          openingBarsConsumed = false;
          state.status = 'WAITING';
          console.log(`  ${C.gray}[SWING] No clear bias at open (price between VWAP and EMA9) — watching...${C.reset}`);
        }
      }
    }

    // ── Reset at midnight for next session ────────────────────────────────────
    if (getETMinsNow() < 30) {
      // Before 00:30 ET — reset for new day if we closed yesterday
      if (state.status === 'CLOSED' || (state.openedToday && getETMinsNow() < 5)) {
        state           = { ...state, status: 'WAITING', direction: null, entry: null,
                            stop: null, target: null, atr: null, entryTime: null,
                            exitPrice: null, exitReason: null, pnl: null, pnlPct: null,
                            openedToday: false };
        openingBarsConsumed = false;
      }
    }

    return state;
  }

  function getState() { return state; }

  return { update, getState };
})();

// ─── QQQ Swing Engine instance ────────────────────────────────────────────────
// Same logic as SPY SwingEngine — scoped to QQQ instrument price

const QqqSwingEngine = (() => {
  const SYNTH_BARS    = 6;
  const ATR_PERIOD    = 14;
  const ATR_STOP_MULT = 1.0;
  const ATR_TGT_MULT  = 2.5;
  const CLOSE_HOUR    = 15;
  const CLOSE_MIN     = 45;

  let state = {
    status: 'WAITING', direction: null, entry: null, stop: null, target: null,
    atr: null, entryTime: null, exitPrice: null, exitReason: null,
    pnl: null, pnlPct: null, openedToday: false, lastUpdate: null,
  };
  let openingBarsConsumed = false;

  function getETMinsNow() {
    const t = new Date().toLocaleTimeString('en-US', {
      timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
    });
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }
  function isHardCloseTime() { return getETMinsNow() >= CLOSE_HOUR * 60 + CLOSE_MIN; }
  function isOpeningWindow()  { const m = getETMinsNow(); return m >= 9*60+29 && m <= 9*60+55; }

  function buildSynthCandles(bars30s) {
    const synth = [];
    for (let i = 0; i + SYNTH_BARS <= bars30s.length; i += SYNTH_BARS) {
      const chunk = bars30s.slice(i, i + SYNTH_BARS);
      synth.push({ open: chunk[0].open, high: Math.max(...chunk.map(b=>b.high)),
                   low: Math.min(...chunk.map(b=>b.low)), close: chunk[chunk.length-1].close });
    }
    return synth;
  }

  function calcATR(candles) {
    if (candles.length < 2) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      trs.push(Math.max(candles[i].high-candles[i].low,
        Math.abs(candles[i].high-candles[i-1].close), Math.abs(candles[i].low-candles[i-1].close)));
    }
    if (trs.length < ATR_PERIOD) return trs.reduce((a,b)=>a+b,0)/trs.length;
    let atr = trs.slice(0,ATR_PERIOD).reduce((a,b)=>a+b,0)/ATR_PERIOD;
    for (let i = ATR_PERIOD; i < trs.length; i++) atr=(atr*(ATR_PERIOD-1)+trs[i])/ATR_PERIOD;
    return atr;
  }

  function update(price, vwap, ema9, bars30s) {
    if (!price || !bars30s?.length) return state;
    state.lastUpdate = getETString();

    // Hard close
    if ((state.status==='LONG'||state.status==='SHORT') && isHardCloseTime()) {
      const dir=state.status;
      state.exitPrice=price; state.exitReason='EOD';
      state.pnl=dir==='LONG'?price-state.entry:state.entry-price;
      state.pnlPct=(state.pnl/state.entry)*100; state.status='CLOSED';
      console.log(`\n  ${C.bgYellow}  ⏰ QQQ SWING EOD  ${C.reset}  ${dir} closed $${price.toFixed(2)}  P&L: ${state.pnl>=0?C.green:C.red}${state.pnl>=0?'+':''}$${state.pnl.toFixed(2)}${C.reset}`);
      return state;
    }

    // In-trade exits
    if (state.status==='LONG') {
      if (price>=state.target) {
        state.exitPrice=state.target; state.exitReason='TARGET';
        state.pnl=state.target-state.entry; state.pnlPct=(state.pnl/state.entry)*100; state.status='CLOSED';
        process.stdout.write('\x07\x07\x07');
        console.log(`\n  ${C.bgGreen}  ✅ QQQ SWING TARGET  ${C.reset}  ${C.green}+$${state.pnl.toFixed(2)}${C.reset}`);
        return state;
      }
      if (price<=state.stop) {
        state.exitPrice=state.stop; state.exitReason='STOP';
        state.pnl=state.stop-state.entry; state.pnlPct=(state.pnl/state.entry)*100; state.status='CLOSED';
        process.stdout.write('\x07\x07');
        console.log(`\n  ${C.bgRed}  🛑 QQQ SWING STOP  ${C.reset}  ${C.red}$${state.pnl.toFixed(2)}${C.reset}`);
        return state;
      }
      if (vwap!=null && price<vwap) {
        state.exitPrice=price; state.exitReason='TREND_EXIT';
        state.pnl=price-state.entry; state.pnlPct=(state.pnl/state.entry)*100; state.status='CLOSED';
        console.log(`\n  ${C.bgYellow}  ⚠️  QQQ TREND EXIT  ${C.reset}  LONG below VWAP  ${state.pnl>=0?C.green:C.red}${state.pnl>=0?'+':''}$${state.pnl.toFixed(2)}${C.reset}`);
        return state;
      }
    }
    if (state.status==='SHORT') {
      if (price<=state.target) {
        state.exitPrice=state.target; state.exitReason='TARGET';
        state.pnl=state.entry-state.target; state.pnlPct=(state.pnl/state.entry)*100; state.status='CLOSED';
        process.stdout.write('\x07\x07\x07');
        console.log(`\n  ${C.bgGreen}  ✅ QQQ SWING TARGET  ${C.reset}  ${C.green}+$${state.pnl.toFixed(2)}${C.reset}`);
        return state;
      }
      if (price>=state.stop) {
        state.exitPrice=state.stop; state.exitReason='STOP';
        state.pnl=state.entry-state.stop; state.pnlPct=(state.pnl/state.entry)*100; state.status='CLOSED';
        process.stdout.write('\x07\x07');
        console.log(`\n  ${C.bgRed}  🛑 QQQ SWING STOP  ${C.reset}  ${C.red}$${state.pnl.toFixed(2)}${C.reset}`);
        return state;
      }
      if (vwap!=null && price>vwap) {
        state.exitPrice=price; state.exitReason='TREND_EXIT';
        state.pnl=state.entry-price; state.pnlPct=(state.pnl/state.entry)*100; state.status='CLOSED';
        console.log(`\n  ${C.bgYellow}  ⚠️  QQQ TREND EXIT  ${C.reset}  SHORT above VWAP  ${state.pnl>=0?C.green:C.red}${state.pnl>=0?'+':''}$${state.pnl.toFixed(2)}${C.reset}`);
        return state;
      }
    }

    // Opening entry
    if (state.status==='WAITING' && !state.openedToday && isOpeningWindow()) {
      if (!openingBarsConsumed && bars30s.length>0 && vwap!=null && ema9!=null) {
        openingBarsConsumed = true;
        const synth = buildSynthCandles(bars30s);
        const atr   = calcATR(synth) ?? (price*0.001);
        const atrS  = Math.max(atr, 0.10);
        const bull  = price>vwap && price>ema9;
        const bear  = price<vwap && price<ema9;
        if (bull) {
          state = { ...state, status:'LONG', direction:'LONG', entry:price, atr:atrS,
            stop:parseFloat((price-atrS*ATR_STOP_MULT).toFixed(2)),
            target:parseFloat((price+atrS*ATR_TGT_MULT).toFixed(2)),
            entryTime:getETString(), openedToday:true };
          process.stdout.write('\x07');
          console.log(`\n  ${C.bgGreen}  📈 QQQ SWING LONG  ${C.reset}  $${price.toFixed(2)}  Stop $${state.stop}  Target $${state.target}`);
        } else if (bear) {
          state = { ...state, status:'SHORT', direction:'SHORT', entry:price, atr:atrS,
            stop:parseFloat((price+atrS*ATR_STOP_MULT).toFixed(2)),
            target:parseFloat((price-atrS*ATR_TGT_MULT).toFixed(2)),
            entryTime:getETString(), openedToday:true };
          process.stdout.write('\x07');
          console.log(`\n  ${C.bgRed}  📉 QQQ SWING SHORT  ${C.reset}  $${price.toFixed(2)}  Stop $${state.stop}  Target $${state.target}`);
        } else {
          openingBarsConsumed = false;
          console.log(`  ${C.gray}[QQQ SWING] No clear bias at open — watching...${C.reset}`);
        }
      }
    }

    if (getETMinsNow() < 5 && state.openedToday && state.status==='CLOSED') {
      state = { status:'WAITING', direction:null, entry:null, stop:null, target:null,
                atr:null, entryTime:null, exitPrice:null, exitReason:null,
                pnl:null, pnlPct:null, openedToday:false, lastUpdate:null };
      openingBarsConsumed = false;
    }
    return state;
  }

  function getState() { return state; }
  return { update, getState };
})();

// ─── QQQ Summary Printer ──────────────────────────────────────────────────────

function printQqqSummary(qqqRows, qqq, qqqSummary, qqqSwingState, qqqAnalysis) {
  if (!qqqClient) return;
  const line = '  ' + '─'.repeat(72);

  // W3 header row
  const w3Biases = qqqRows.map(r => {
    const col = r.bias==='bullish'?C.green:r.bias==='bearish'?C.red:
                r.bias==='div_bear'?C.yellow:r.bias==='div_bull'?C.cyan:C.gray;
    const tag = r.bias==='bullish'?'BULL':r.bias==='bearish'?'BEAR':
                r.bias==='div_bear'?'DIV-':r.bias==='div_bull'?'DIV+':'NTRL';
    return `${C.bold}${r.symbol}${C.reset} ${col}${tag}${C.reset}`;
  }).join('  ');

  // Build signal
  const qqqSignal = buildSignalForInstrument('QQQ', qqqRows, qqq, qqqSummary, 3);
  const sigCol    = qqqSignal.action.includes('CALLS')?C.green:qqqSignal.action.includes('PUTS')?C.red:
                    qqqSignal.action.includes('CHOP')?C.yellow:C.gray;
  const confCol   = qqqSignal.confidence==='HIGH'?C.green:qqqSignal.confidence==='MEDIUM'?C.yellow:
                    qqqSignal.confidence==='WEAK'?C.yellow:C.gray;

  console.log(line);
  console.log(`  ${C.bold}W3${C.reset}  ${w3Biases}`);
  if (qqq?.tick != null) {
    const tCol = qqq.tick > 200?C.green:qqq.tick < -200?C.red:C.gray;
    console.log(`  ${C.dim}$TICK: ${tCol}${qqq.tick}${C.reset}  ${C.dim}← QQQ tab${C.reset}`);
  }
  {
    const _qVol  = (qqq?.bars ?? []).reduce((s, b) => s + (b.volume ?? 0), 0);
    const _qPct  = (qqq?.bars?.length ?? 0) > 0 ? _qVol / (QQQ_AVG_VOL_PER_BAR * qqq.bars.length) : null;
    const _qCol  = _qPct == null ? C.gray : _qPct < 0.50 ? C.red : _qPct < 0.80 ? C.yellow : C.green;
    const _qIcon = _qPct == null ? '' : _qPct < 0.50 ? ' 🔴' : _qPct < 0.80 ? ' 🟡' : ' 🟢';
    if (_qPct != null)
      console.log(`  ${C.dim}Volume: ${_qCol}${(_qPct * 100).toFixed(0)}% of avg (${fmtVol(_qVol)})${C.reset}${_qIcon}  ${C.dim}← QQQ${C.reset}`);
  }

  // QQQ instrument row
  if (qqq?.price) {
    const supLabel=qqq.levels?.support[0]    ?C.green+qqq.levels.support[0].price.toFixed(2)+C.reset:'';
    const resLabel=qqq.levels?.resistance[0] ?C.red+qqq.levels.resistance[0].price.toFixed(2)+C.reset:'';
    const srStr=[supLabel&&`S:${supLabel}`,resLabel&&`R:${resLabel}`].filter(Boolean).join(' ');
    console.log(
      `  ${C.bold}${'QQQ'.padEnd(6)}${C.reset}` +
      `  ${fmtPrice(qqq.price)}  ${fmtVwap(qqq.vwap)}  ${fmtDelta(qqq.delta)}` +
      `  ${biasTag(qqq.bias)}  ${fmtVrrs(qqq.vrrs, qqq.vrrsSector)}  ${srStr}`
    );
  }

  // Pre-market levels
  if (global.qqqPreMarketLevels && qqq?.price) {
    const L = global.qqqPreMarketLevels;
    const fmt = p => p!=null?`$${p.toFixed(2)}`:'N/A';
    const sid = (p,c) => p!=null?(c>p?C.green+'▲'+C.reset:C.red+'▼'+C.reset):'';
    console.log(`  ${C.dim}PDH ${C.red}${fmt(L.pdHigh)}${C.reset}${sid(L.pdHigh,qqq.price)}  PDL ${C.green}${fmt(L.pdLow)}${C.reset}${sid(L.pdLow,qqq.price)}  PDC ${fmt(L.pdClose)}${sid(L.pdClose,qqq.price)}  Open ${fmt(L.todayOpen)}${sid(L.todayOpen,qqq.price)}${C.reset}`);
  }

  // QQQ Analysis
  if (qqqSummary) {
    const tC=qqqSummary.trendDir==='Bullish'?C.green:C.red;
    console.log(line);
    console.log(`  ${C.bold}QQQ ANALYSIS${C.reset}`);
    console.log(`  Trend:      ${tC}${qqqSummary.trendDir}${C.reset} — ${qqqSummary.trendDetail}`);
    if (qqqSummary.nearRes) console.log(`  Resistance: ${C.red}$${qqqSummary.nearRes.price.toFixed(2)}${C.reset}  ${C.dim}+${qqqSummary.distRes?.toFixed(2)}% away  [${qqqSummary.nearRes.label}]${C.reset}`);
    if (qqqSummary.nearSup) console.log(`  Support:    ${C.green}$${qqqSummary.nearSup.price.toFixed(2)}${C.reset}  ${C.dim}-${qqqSummary.distSup?.toFixed(2)}% away  [${qqqSummary.nearSup.label}]${C.reset}`);
    console.log(`  Status:     ${qqqSummary.status}`);
    console.log(`  Flow:       ${qqq?.delta!=null?fmtDelta(qqq.delta)+(qqq.delta<0?C.red+'  sellers':C.green+'  buyers')+C.reset:'N/A'}`);
    if (qqq?.vrrs!=null) {
      const vC=qqq.vrrs>=VRRS_THRESH?C.green:qqq.vrrs<=-VRRS_THRESH?C.red:C.gray;
      const cert=qqq.vrrsSector!=null?`${qqq.vrrsSector!=null?(Math.sign(qqq.vrrs)===Math.sign(qqq.vrrsSector)?" ✓":" ÷"):""}`:'';
      console.log(`  VRRS:       ${vC}${qqq.vrrs.toFixed(3)}${C.reset}${cert}`);
    }
  }

  // Signal
  console.log(line);
  console.log(`  ${C.bold}QQQ SIGNAL${C.reset}`);
  console.log(`  Action:     ${sigCol}${C.bold}${qqqSignal.action}${C.reset}`);
  console.log(`  Confidence: ${confCol}${qqqSignal.confidence}${C.reset}`);
  console.log(`  Reason:     ${qqqSignal.reason}`);
  if (qqqSignal.confidence === 'HIGH') process.stdout.write('\x07');

  // Swing
  console.log(line);
  console.log(`  ${C.bold}QQQ SWING:${C.reset}  ` + (() => {
    const sw=qqqSwingState;
    if (!sw||sw.status==='WAITING') return C.gray+'Waiting for 09:29:30 opening candle...'+C.reset;
    if (sw.status==='LONG'||sw.status==='SHORT') {
      const dCol=sw.status==='LONG'?C.green:C.red;
      const floatPnl=qqq?.price?(sw.status==='LONG'?qqq.price-sw.entry:sw.entry-qqq.price):null;
      return `${dCol}${C.bold}${sw.status}${C.reset} $${sw.entry?.toFixed(2)}  Stop ${C.red}$${sw.stop}${C.reset}  Target ${C.green}$${sw.target}${C.reset}` +
        (floatPnl!=null?`  Float: ${floatPnl>=0?C.green:C.red}${floatPnl>=0?'+':''}$${floatPnl.toFixed(2)}${C.reset}`:'');
    }
    const pCol=(sw.pnl??0)>=0?C.green:C.red;
    return `${pCol}${sw.exitReason} ${sw.direction} → ${(sw.pnl??0)>=0?'+':''}$${sw.pnl?.toFixed(2)}${C.reset}`;
  })());

  // Live analysis
  printLiveAnalysis('QQQ', qqqAnalysis, getETString());
}
// TV's EMA 9 close is visible in data window — but bars alone let us compute it
// independently so Swing Engine works even if EMA9 indicator isn't in data window.

// ─── IWM Swing Engine instance ────────────────────────────────────────────────

const IwmSwingEngine = (() => {
  const SYNTH_BARS=6, ATR_PERIOD=14, ATR_STOP_MULT=1.0, ATR_TGT_MULT=2.5;
  const CLOSE_HOUR=15, CLOSE_MIN=45;

  let state = {
    status:'WAITING', direction:null, entry:null, stop:null, target:null,
    atr:null, entryTime:null, exitPrice:null, exitReason:null,
    pnl:null, pnlPct:null, openedToday:false, lastUpdate:null,
  };
  let openingBarsConsumed = false;

  function getETMinsNow() {
    const t = new Date().toLocaleTimeString('en-US', {
      timeZone:'America/New_York', hour12:false, hour:'2-digit', minute:'2-digit' });
    const [h,m] = t.split(':').map(Number); return h*60+m;
  }
  function isHardCloseTime() { return getETMinsNow() >= CLOSE_HOUR*60+CLOSE_MIN; }
  function isOpeningWindow()  { const m=getETMinsNow(); return m>=9*60+29&&m<=9*60+55; }

  function buildSynthCandles(bars30s) {
    const synth=[];
    for (let i=0; i+SYNTH_BARS<=bars30s.length; i+=SYNTH_BARS) {
      const c=bars30s.slice(i,i+SYNTH_BARS);
      synth.push({ open:c[0].open, high:Math.max(...c.map(b=>b.high)),
                   low:Math.min(...c.map(b=>b.low)), close:c[c.length-1].close });
    }
    return synth;
  }

  function calcATR(candles) {
    if (candles.length<2) return null;
    const trs=[];
    for (let i=1;i<candles.length;i++) trs.push(Math.max(
      candles[i].high-candles[i].low,
      Math.abs(candles[i].high-candles[i-1].close),
      Math.abs(candles[i].low-candles[i-1].close)));
    if (trs.length<ATR_PERIOD) return trs.reduce((a,b)=>a+b,0)/trs.length;
    let atr=trs.slice(0,ATR_PERIOD).reduce((a,b)=>a+b,0)/ATR_PERIOD;
    for (let i=ATR_PERIOD;i<trs.length;i++) atr=(atr*(ATR_PERIOD-1)+trs[i])/ATR_PERIOD;
    return atr;
  }

  function update(price, vwap, ema9, bars30s) {
    if (!price||!bars30s?.length) return state;
    state.lastUpdate=getETString();

    if ((state.status==='LONG'||state.status==='SHORT') && isHardCloseTime()) {
      const dir=state.status;
      state.exitPrice=price; state.exitReason='EOD';
      state.pnl=dir==='LONG'?price-state.entry:state.entry-price;
      state.pnlPct=(state.pnl/state.entry)*100; state.status='CLOSED';
      console.log(`\n  ${C.bgYellow}  ⏰ IWM SWING EOD  ${C.reset}  ${dir} $${price.toFixed(2)}  ${state.pnl>=0?C.green:C.red}${state.pnl>=0?'+':''}$${state.pnl.toFixed(2)}${C.reset}`);
      return state;
    }

    if (state.status==='LONG') {
      if (price>=state.target) {
        state.exitPrice=state.target; state.exitReason='TARGET';
        state.pnl=state.target-state.entry; state.pnlPct=(state.pnl/state.entry)*100; state.status='CLOSED';
        process.stdout.write('\x07\x07\x07');
        console.log(`\n  ${C.bgGreen}  ✅ IWM SWING TARGET  ${C.reset}  ${C.green}+$${state.pnl.toFixed(2)}${C.reset}`);
        return state;
      }
      if (price<=state.stop) {
        state.exitPrice=state.stop; state.exitReason='STOP';
        state.pnl=state.stop-state.entry; state.pnlPct=(state.pnl/state.entry)*100; state.status='CLOSED';
        process.stdout.write('\x07\x07');
        console.log(`\n  ${C.bgRed}  🛑 IWM SWING STOP  ${C.reset}  ${C.red}$${state.pnl.toFixed(2)}${C.reset}`);
        return state;
      }
      if (vwap!=null&&price<vwap) {
        state.exitPrice=price; state.exitReason='TREND_EXIT';
        state.pnl=price-state.entry; state.pnlPct=(state.pnl/state.entry)*100; state.status='CLOSED';
        console.log(`\n  ${C.bgYellow}  ⚠️  IWM TREND EXIT  ${C.reset}  LONG below VWAP  ${state.pnl>=0?C.green:C.red}${state.pnl>=0?'+':''}$${state.pnl.toFixed(2)}${C.reset}`);
        return state;
      }
    }

    if (state.status==='SHORT') {
      if (price<=state.target) {
        state.exitPrice=state.target; state.exitReason='TARGET';
        state.pnl=state.entry-state.target; state.pnlPct=(state.pnl/state.entry)*100; state.status='CLOSED';
        process.stdout.write('\x07\x07\x07');
        console.log(`\n  ${C.bgGreen}  ✅ IWM SWING TARGET  ${C.reset}  ${C.green}+$${state.pnl.toFixed(2)}${C.reset}`);
        return state;
      }
      if (price>=state.stop) {
        state.exitPrice=state.stop; state.exitReason='STOP';
        state.pnl=state.entry-state.stop; state.pnlPct=(state.pnl/state.entry)*100; state.status='CLOSED';
        process.stdout.write('\x07\x07');
        console.log(`\n  ${C.bgRed}  🛑 IWM SWING STOP  ${C.reset}  ${C.red}$${state.pnl.toFixed(2)}${C.reset}`);
        return state;
      }
      if (vwap!=null&&price>vwap) {
        state.exitPrice=price; state.exitReason='TREND_EXIT';
        state.pnl=state.entry-price; state.pnlPct=(state.pnl/state.entry)*100; state.status='CLOSED';
        console.log(`\n  ${C.bgYellow}  ⚠️  IWM TREND EXIT  ${C.reset}  SHORT above VWAP  ${state.pnl>=0?C.green:C.red}${state.pnl>=0?'+':''}$${state.pnl.toFixed(2)}${C.reset}`);
        return state;
      }
    }

    if (state.status==='WAITING'&&!state.openedToday&&isOpeningWindow()) {
      if (!openingBarsConsumed&&bars30s.length>0&&vwap!=null&&ema9!=null) {
        openingBarsConsumed=true;
        const synth=buildSynthCandles(bars30s);
        const atr=calcATR(synth)??(price*0.001);
        const atrS=Math.max(atr,0.05); // IWM smaller ATR floor than SPY/QQQ
        const bull=price>vwap&&price>ema9;
        const bear=price<vwap&&price<ema9;
        if (bull) {
          state={...state, status:'LONG', direction:'LONG', entry:price, atr:atrS,
            stop:parseFloat((price-atrS*ATR_STOP_MULT).toFixed(2)),
            target:parseFloat((price+atrS*ATR_TGT_MULT).toFixed(2)),
            entryTime:getETString(), openedToday:true};
          process.stdout.write('\x07');
          console.log(`\n  ${C.bgGreen}  📈 IWM SWING LONG  ${C.reset}  $${price.toFixed(2)}  Stop $${state.stop}  Target $${state.target}`);
        } else if (bear) {
          state={...state, status:'SHORT', direction:'SHORT', entry:price, atr:atrS,
            stop:parseFloat((price+atrS*ATR_STOP_MULT).toFixed(2)),
            target:parseFloat((price-atrS*ATR_TGT_MULT).toFixed(2)),
            entryTime:getETString(), openedToday:true};
          process.stdout.write('\x07');
          console.log(`\n  ${C.bgRed}  📉 IWM SWING SHORT  ${C.reset}  $${price.toFixed(2)}  Stop $${state.stop}  Target $${state.target}`);
        } else {
          openingBarsConsumed=false;
          console.log(`  ${C.gray}[IWM SWING] No clear bias at open — watching...${C.reset}`);
        }
      }
    }

    if (getETMinsNow()<5&&state.openedToday&&state.status==='CLOSED') {
      state={status:'WAITING',direction:null,entry:null,stop:null,target:null,
             atr:null,entryTime:null,exitPrice:null,exitReason:null,
             pnl:null,pnlPct:null,openedToday:false,lastUpdate:null};
      openingBarsConsumed=false;
    }
    return state;
  }

  function getState() { return state; }
  return { update, getState };
})();

// ─── IWM Summary Printer ──────────────────────────────────────────────────────

function printIwmSummary(iwmRows, iwm, iwmSummary, iwmSwingState, iwmAnalysis) {
  if (!iwmClient) return;
  const line = '  ' + '─'.repeat(72);

  const magBiases = iwmRows
    .filter(r=>r.symbol!=='IWM')
    .map(r => {
      const col=r.bias==='bullish'?C.green:r.bias==='bearish'?C.red:
                r.bias==='div_bear'?C.yellow:r.bias==='div_bull'?C.cyan:C.gray;
      const tag=r.bias==='bullish'?'BULL':r.bias==='bearish'?'BEAR':
                r.bias==='div_bear'?'DIV-':r.bias==='div_bull'?'DIV+':'NTRL';
      return `${C.bold}${r.symbol}${C.reset} ${col}${tag}${C.reset}`;
    }).join('  ');

  const iwmSignal = buildSignalForInstrument('IWM', iwmRows, iwm, iwmSummary, 2);
  const sigCol    = iwmSignal.action.includes('CALLS')?C.green:iwmSignal.action.includes('PUTS')?C.red:
                    iwmSignal.action.includes('CHOP')?C.yellow:C.gray;
  const confCol   = iwmSignal.confidence==='HIGH'?C.green:iwmSignal.confidence==='MEDIUM'?C.yellow:
                    iwmSignal.confidence==='WEAK'?C.yellow:C.gray;

  console.log(line);
  console.log(`  ${C.bold}IWM Mag-3${C.reset}  ${magBiases}`);
  if (iwm?.tick!=null) {
    const tCol=iwm.tick>200?C.green:iwm.tick<-200?C.red:C.gray;
    console.log(`  ${C.dim}$TICK: ${tCol}${iwm.tick}${C.reset}  ${C.dim}← IWM tab${C.reset}`);
  }
  {
    const _iVol  = (iwm?.bars ?? []).reduce((s, b) => s + (b.volume ?? 0), 0);
    const _iPct  = (iwm?.bars?.length ?? 0) > 0 ? _iVol / (IWM_AVG_VOL_PER_BAR * iwm.bars.length) : null;
    const _iCol  = _iPct == null ? C.gray : _iPct < 0.50 ? C.red : _iPct < 0.80 ? C.yellow : C.green;
    const _iIcon = _iPct == null ? '' : _iPct < 0.50 ? ' 🔴' : _iPct < 0.80 ? ' 🟡' : ' 🟢';
    if (_iPct != null)
      console.log(`  ${C.dim}Volume: ${_iCol}${(_iPct * 100).toFixed(0)}% of avg (${fmtVol(_iVol)})${C.reset}${_iIcon}  ${C.dim}← IWM${C.reset}`);
  }

  if (iwm?.price) {
    const supLabel=iwm.levels?.support[0]    ?C.green+iwm.levels.support[0].price.toFixed(2)+C.reset:'';
    const resLabel=iwm.levels?.resistance[0] ?C.red+iwm.levels.resistance[0].price.toFixed(2)+C.reset:'';
    const srStr=[supLabel&&`S:${supLabel}`,resLabel&&`R:${resLabel}`].filter(Boolean).join(' ');
    console.log(
      `  ${C.bold}${'IWM'.padEnd(6)}${C.reset}` +
      `  ${fmtPrice(iwm.price)}  ${fmtVwap(iwm.vwap)}  ${fmtDelta(iwm.delta)}` +
      `  ${biasTag(iwm.bias)}  ${fmtVrrs(iwm.vrrs, iwm.vrrsSector)}  ${srStr}`
    );
  }

  if (global.iwmPreMarketLevels && iwm?.price) {
    const L=global.iwmPreMarketLevels;
    const fmt=p=>p!=null?`$${p.toFixed(2)}`:'N/A';
    const sid=(p,c)=>p!=null?(c>p?C.green+'▲'+C.reset:C.red+'▼'+C.reset):'';
    console.log(`  ${C.dim}PDH ${C.red}${fmt(L.pdHigh)}${C.reset}${sid(L.pdHigh,iwm.price)}  PDL ${C.green}${fmt(L.pdLow)}${C.reset}${sid(L.pdLow,iwm.price)}  PDC ${fmt(L.pdClose)}${sid(L.pdClose,iwm.price)}  Open ${fmt(L.todayOpen)}${sid(L.todayOpen,iwm.price)}${C.reset}`);
  }

  if (iwmSummary) {
    const tC=iwmSummary.trendDir==='Bullish'?C.green:C.red;
    console.log(line);
    console.log(`  ${C.bold}IWM ANALYSIS${C.reset}`);
    console.log(`  Trend:      ${tC}${iwmSummary.trendDir}${C.reset} — ${iwmSummary.trendDetail}`);
    if (iwmSummary.nearRes) console.log(`  Resistance: ${C.red}$${iwmSummary.nearRes.price.toFixed(2)}${C.reset}  ${C.dim}+${iwmSummary.distRes?.toFixed(2)}% away  [${iwmSummary.nearRes.label}]${C.reset}`);
    if (iwmSummary.nearSup) console.log(`  Support:    ${C.green}$${iwmSummary.nearSup.price.toFixed(2)}${C.reset}  ${C.dim}-${iwmSummary.distSup?.toFixed(2)}% away  [${iwmSummary.nearSup.label}]${C.reset}`);
    console.log(`  Status:     ${iwmSummary.status}`);
    console.log(`  Flow:       ${iwm?.delta!=null?fmtDelta(iwm.delta)+(iwm.delta<0?C.red+'  sellers':C.green+'  buyers')+C.reset:'N/A'}`);
    if (iwm?.vrrs!=null) {
      const vC=iwm.vrrs>=VRRS_THRESH?C.green:iwm.vrrs<=-VRRS_THRESH?C.red:C.gray;
      const cert=iwm.vrrsSector!=null?`${iwm.vrrsSector!=null?(Math.sign(iwm.vrrs)===Math.sign(iwm.vrrsSector)?" ✓":" ÷"):""}`:'';
      console.log(`  VRRS:       ${vC}${iwm.vrrs.toFixed(3)}${C.reset}${cert}`);
    }
  }

  console.log(line);
  console.log(`  ${C.bold}IWM SIGNAL${C.reset}`);
  console.log(`  Action:     ${sigCol}${C.bold}${iwmSignal.action}${C.reset}`);
  console.log(`  Confidence: ${confCol}${iwmSignal.confidence}${C.reset}`);
  console.log(`  Reason:     ${iwmSignal.reason}`);
  if (iwmSignal.confidence === 'HIGH') process.stdout.write('\x07');

  console.log(line);
  console.log(`  ${C.bold}IWM SWING:${C.reset}  ` + (() => {
    const sw=iwmSwingState;
    if (!sw||sw.status==='WAITING') return C.gray+'Waiting for 09:29:30 opening candle...'+C.reset;
    if (sw.status==='LONG'||sw.status==='SHORT') {
      const dCol=sw.status==='LONG'?C.green:C.red;
      const floatPnl=iwm?.price?(sw.status==='LONG'?iwm.price-sw.entry:sw.entry-iwm.price):null;
      return `${dCol}${C.bold}${sw.status}${C.reset} $${sw.entry?.toFixed(2)}  Stop ${C.red}$${sw.stop}${C.reset}  Target ${C.green}$${sw.target}${C.reset}` +
        (floatPnl!=null?`  Float: ${floatPnl>=0?C.green:C.red}${floatPnl>=0?'+':''}$${floatPnl.toFixed(2)}${C.reset}`:'');
    }
    const pCol=(sw.pnl??0)>=0?C.green:C.red;
    return `${pCol}${sw.exitReason} ${sw.direction} → ${(sw.pnl??0)>=0?'+':''}$${sw.pnl?.toFixed(2)}${C.reset}`;
  })());

  printLiveAnalysis('IWM', iwmAnalysis, getETString());
}


// ─── EMA9 helper for swing (computed from bars, not TV indicator) ─────────────

function computeEMA9fromBars(bars) {
  if (!bars?.length) return null;
  const closes = bars.map(b => b.close);
  const k = 2 / (9 + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

// ─── Alerts ───────────────────────────────────────────────────────────────────

function fireAlert(direction, reason) {
  const badge = direction === 'CALLS' ? C.bgGreen : C.bgRed;
  process.stdout.write('\x07');
  console.log('\n' + badge + `  *** ${direction} ***  ` + C.reset);
  console.log(`  ${C.bold}Reason:${C.reset} ${reason}`);
  console.log(`  ${C.bold}Time:${C.reset}   ${getETString()} ET\n`);
}

function fireDivergence(msg) {
  process.stdout.write('\x07');
  console.log('\n' + C.bgYellow + '  *** DIVERGENCE WARNING ***  ' + C.reset);
  console.log(`  ${msg}`);
  console.log(`  ${C.bold}Time:${C.reset} ${getETString()} ET\n`);
}

// ─── Order execution helpers ──────────────────────────────────────────────────

/**
 * Called when SwingEngine enters LONG or SHORT.
 * Creates a paper order and stores requestId for later close.
 */
async function executeSwingEntry(instrument, swingState, lastQuote) {
  if (!sendOrder || !orderGate) return;
  if (!isTradingHours()) return;
  if (activeSwing[instrument]?.requestId) return;

  const signal   = swingState.direction === 'LONG' ? 'CALLS' : 'PUTS';
  const price    = swingState.entry;

  // Select contract — strike + expiry based on price and time of day
  // Options pricing — ATR estimate (Webull chain API_DISABLED, pending scope grant)
  let strike = null, expiry = null, optionMid = null;
  try {
    const contract = selectContract(instrument, price, signal);
    strike   = contract.strike;
    expiry   = contract.expiry;
    const atr = swingState.atr ?? price * 0.005;
    optionMid = parseFloat((atr * 0.4).toFixed(2));
  } catch(e) {
    console.log(`  [OPTIONS] Strike selection error: ${e.message}`);
    const atr = swingState.atr ?? price * 0.005;
    optionMid = parseFloat((atr * 0.4).toFixed(2));
  }

  // Stack confidence with the 4H macro for this instrument so position
  // sizing reflects whether the swing aligns with the bigger picture.
  let macro4H = 'UNKNOWN';
  if (barCache[instrument]) {
    try {
      const bars4H = await barCache[instrument].get('240');
      if (bars4H && bars4H.length) macro4H = analyze4H(bars4H).direction;
    } catch {}
  }
  const stack = applyMultipliers({ signal, engine: 'SWING', confidence: 'HIGH' },
                                 { macro4H, marketBias: readDailyBiasRegime() });

  const consensus = {
    signal,
    engine:     'SWING',
    confidence: 'HIGH',
    finalConfidence: stack.finalConfidence,
    multipliers: stack.breakdown,
    instrument,
    strike,
    expiry,
    entryPrice: optionMid ?? swingState.entry,
    underlyingPrice: price,
    contracts:  1,
  };

  const reqId = orderGate.createRequest({ signal, engine: 'SWING' });
  const fill  = await sendOrder(consensus, reqId, lastQuote);

  if (!fill.vetoed) {
    activeSwing[instrument] = {
      requestId: reqId,
      status:    'OPEN',
      entry:     swingState.entry,
      strike,
      expiry,
      optionEntry: optionMid,
    };
    console.log(`  [SWING] ${instrument} ${signal} $${strike} ${expiry} — paper entry $${optionMid?.toFixed(2)} — reqId: ${reqId}`);
  }
}

/**
 * Called when SwingEngine exits (TARGET / STOP / TREND_EXIT / EOD).
 * Closes the open paper position.
 */
function executeSwingExit(instrument, swingState) {
  if (!closePosition) return;
  const active = activeSwing[instrument];
  if (!active?.requestId || active.status !== 'OPEN') return;

  // swingState.exitPrice is the underlying ETF price — convert to option premium estimate
  // using delta approximation so closePosition gets an option price, not an underlying price
  const SWING_DELTA    = 0.50;
  const underlyingMove = (swingState.exitPrice ?? active.entry) - (active.entry ?? 0);
  const dirMult        = swingState.direction === 'LONG' ? 1 : -1;
  const optionEst      = Math.max(0.01, (active.optionEntry ?? 0.10) + underlyingMove * dirMult * SWING_DELTA);
  const optionExitPrice = parseFloat(optionEst.toFixed(4));

  closePosition(active.requestId, optionExitPrice, swingState.exitReason);
  activeSwing[instrument] = { requestId: null, status: null };
  console.log(`  [SWING] ${instrument} closed — ${swingState.exitReason} | underlying $${swingState.exitPrice?.toFixed(2)} → option est $${optionExitPrice}`);
}

// Exit open TREND positions: 2x target, 0.5x stop, 90-min time stop, 15:45 EOD
// Burn-zone aware: in FAST/CRITICAL zones (afternoon/PRE-MOC), tighten target to 1.5x
// because theta decay accelerates and 2x is increasingly unrealistic.
function checkTrendExits(instrument, currentEst) {
  if (!closePosition) return;
  let lg;
  try { lg = JSON.parse(readFileSync(join(__dirname, 'paper-ledger.json'), 'utf8')); } catch { return; }
  const openTrend = (lg.trades ?? []).filter(t => t.instrument === instrument && t.engine === 'TREND' && t.status === 'OPEN');
  if (!openTrend.length) return;
  const nowMs  = Date.now();
  const etMins = new Date().toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:false,hour:'2-digit',minute:'2-digit'}).split(':').reduce((h,m)=>+h*60+ +m,0);
  const isEOD  = etMins >= 15*60+45;
  // Wider stop during opening volatility (09:30–10:00) and thin close (15:30+)
  let stopThresh = etMins < 10*60 ? 0.30 : etMins >= 15*60+30 ? 0.40 : 0.45;
  // Burn-zone target tightening — FAST (14:00+) → 1.7x, CRITICAL (15:45+) handled by EOD
  let targetMult = etMins >= 14*60 ? 1.7 : 2.0;
  // Daily-bias overrides — TRENDING raises targets, CHOPPY tightens stops
  try {
    const _b = _getDailyBias?.();
    if (_b?.verdict) {
      if (_b.verdict.bias?.startsWith('TRENDING') && etMins < 14*60) targetMult = 2.5;
      if (_b.verdict.bias === 'CHOPPY')                              { targetMult = 1.5; stopThresh = Math.min(stopThresh + 0.10, 0.60); }
      if (_b.verdict.bias === 'GAP_AND_GO_BULL' || _b.verdict.bias === 'GAP_AND_GO_BEAR') targetMult = 2.5;
    }
  } catch {}
  for (const t of openTrend) {
    const fill = t.fillPrice ?? 0;
    if (fill <= 0) continue;
    const holdMs = nowMs - (t.fillTime ?? nowMs);
    if (isEOD) {
      closePosition(t.requestId, currentEst || fill, 'EOD_CLOSE');
    } else if (currentEst >= fill * targetMult) {
      if (holdMs < MIN_HOLD_EXIT_MS) continue;  // 3-min minimum before target exit
      closePosition(t.requestId, parseFloat((fill * targetMult).toFixed(4)), targetMult < 2.0 ? 'TARGET_BURN' : 'TARGET_2X');
    } else if (currentEst > 0 && currentEst <= fill * stopThresh) {
      if (holdMs < MIN_HOLD_STOP_MS) continue;  // 90s minimum before stop fires
      closePosition(t.requestId, parseFloat((fill * stopThresh).toFixed(4)), 'STOP_0.5X');
    } else if (holdMs >= 90 * 60 * 1000) {
      closePosition(t.requestId, currentEst || fill, 'TIME_STOP');
    }
  }
}

const SPY_AVG_VOL_PER_BAR = 78_800_000 / 780; // 100-day avg / (390 min * 2 bars/min)
const QQQ_AVG_VOL_PER_BAR = 60_000_000 / 780;
const IWM_AVG_VOL_PER_BAR = 35_000_000 / 780;
const STOCK_AVG_VOL_PER_BAR = {
  NVDA: 350_000_000 / 780,
  AAPL:  80_000_000 / 780,
  MSFT:  25_000_000 / 780,
  META:  25_000_000 / 780,
  AMZN:  50_000_000 / 780,
  GOOGL: 25_000_000 / 780,
};

/**
 * Called when buildSignal() fires HIGH or MEDIUM confidence.
 * Scalp trade — short duration, tighter sizing.
 * COOLDOWN prevents re-entry within 90s of last scalp on same instrument.
 */
const lastScalpOrder  = { SPY: 0, QQQ: 0, IWM: 0 };
const SCALP_COOLDOWN  = 300_000;  // 5 minutes between scalp orders same instrument
const QQQ_SUSPENDED   = false;    // QQQ re-enabled — monitor.js owns QQQ with all bug fixes applied
const MIN_HOLD_STOP_MS = 90_000;  // 90s minimum before stop loss fires
const MIN_HOLD_EXIT_MS = 180_000; // 3-min minimum before profit/time exits

async function executeScalpSignal(instrument, signal, lastQuote, volumePct = 1.0) {
  const sigEngine = signal?.engine ?? 'TREND';
  const sigDir    = signal?.action?.includes('CALLS') ? 'CALLS' : signal?.action?.includes('PUTS') ? 'PUTS' : 'WAIT';

  // HIERARCHY_V2: compute macro4H up-front so every GATE_BLOCK record can
  // include it. Per-instrument bars; failure → 'UNKNOWN' (non-blocking).
  let macro4H = 'UNKNOWN';
  if (barCache[instrument]) {
    try {
      const bars4H = await barCache[instrument].get('240');
      if (bars4H && bars4H.length) macro4H = analyze4H(bars4H).direction;
    } catch {}
  }

  if (!sendOrder || !orderGate) { jGateBlock(sigEngine, instrument, sigDir, 'TRADE_DISABLED', { macro4H }); return; }
  if (!isTradingHours())        { jGateBlock(sigEngine, instrument, sigDir, 'OUT_OF_HOURS',   { macro4H }); return; }
  // Chart-first hierarchy v2: only STRUCTURE/FVG/SWEEP/FADE may dispatch.
  // TREND consensus signals are downgraded to confidence inputs (boosters).
  if (HIERARCHY_V2 && !CHART_ENGINE_SET.has(sigEngine)) {
    jGateBlock(sigEngine, instrument, sigDir, 'NOT_CHART_ENGINE', { engine: sigEngine, macro4H });
    return;
  }
  // §18 — Direction conflict gate stripped 2026-05-11 (Path 2 simplification).
  // Trackers (_lastFire / DIRECTION_CONFLICT_MS) preserved at module scope so
  // the gate can be restored without retracing the data flow.
  if (signal.confidence !== 'HIGH' && signal.confidence !== 'MEDIUM') {
    jGateBlock(sigEngine, instrument, sigDir, 'LOW_CONFIDENCE', { confidence: signal.confidence, macro4H });
    return;
  }

  // Open-range observation window — no SPY/QQQ entries 09:30-09:40.
  // IWM allowed earlier (handled by monitor-iwm.js gates) since Mag-3 consensus is stricter.
  // Exempt: STRUCTURE-HIGH (major level breaks) and SWEEP-HIGH (opening-drive
  // stop-runs that wick a level then reverse — often the cleanest open setup).
  const _etMins = getETMins();
  if (_etMins < 9*60+40 && (instrument === 'SPY' || instrument === 'QQQ')) {
    const openRangeExempt =
      (sigEngine === 'STRUCTURE' && signal.confidence === 'HIGH') ||
      (sigEngine === 'SWEEP'     && (signal.confidence === 'HIGH' || signal.confidence === 'MEDIUM'));
    if (!openRangeExempt) {
      jGateBlock(sigEngine, instrument, sigDir, 'OPEN_RANGE_OBSERVATION', { etMins: _etMins, macro4H });
      return;
    }
  }

  // Session gate — pre/after-hours blocked. MIDDAY_CHOP stripped 2026-05-11
  // (Path 2 simplification): reliable chart-engine signals should not be
  // suppressed by a midday-chop heuristic.
  if (!getSession().trade) { jGateBlock(sigEngine, instrument, sigDir, 'SESSION_NO_TRADE', { session: getSession().name, macro4H }); return; }

  // Daily-bias gate — block midday entries on CHOPPY/COILED unless STRUCTURE HIGH
  const _bias = _getDailyBias ? _getDailyBias() : null;
  if (_bias && getSession().name === 'MIDDAY' && _bias.verdict.midDayPolicy === 'stand_down') {
    if (!(sigEngine === 'STRUCTURE' && signal.confidence === 'HIGH')) {
      jGateBlock(sigEngine, instrument, sigDir, 'BIAS_STAND_DOWN', { bias: _bias.verdict.bias, macro4H });
      return;
    }
  }

  const direction = signal.action.includes('CALLS') ? 'CALLS' : 'PUTS';
  if (!signal.action.includes('CALLS') && !signal.action.includes('PUTS')) {
    jGateBlock(sigEngine, instrument, sigDir, 'NO_DIRECTION', { action: signal.action, macro4H });
    return; // WAIT/CHOP/NEUTRAL
  }

  // Options pricing — ATR estimate (Webull chain API_DISABLED, pending scope grant)
  const priceMap = { SPY: _spyPrice, QQQ: _qqqPrice, IWM: _iwmPrice };
  const underlyingPrice = priceMap[instrument] ?? 0;
  let estimatedPrice = lastQuote?.mid ?? lastQuote?.ask;
  // ATR-based fallback when chain quote is unavailable (mirrors executeSwingEntry pattern).
  // Without this, every chart-engine signal was hitting PRICE_TOO_LOW=0 all day.
  if ((!estimatedPrice || estimatedPrice <= 0.05) && underlyingPrice > 0) {
    const atrEst = underlyingPrice * 0.005;
    estimatedPrice = parseFloat((atrEst * 0.4).toFixed(2));
  }
  let liveStrike = null, liveExpiry = null;
  if (selectContract && underlyingPrice > 0) {
    const contract = selectContract(instrument, underlyingPrice, direction);
    liveStrike = contract.strike;
    liveExpiry = contract.expiry;
  }
  if (estimatedPrice <= 0.05) { jGateBlock(sigEngine, instrument, direction, 'PRICE_TOO_LOW', { estimatedPrice, macro4H }); return; }

  const now = Date.now();
  if (now - (lastScalpOrder[instrument] ?? 0) < SCALP_COOLDOWN) {
    jGateBlock(sigEngine, instrument, direction, 'COOLDOWN', { sinceLastMs: now - (lastScalpOrder[instrument] ?? 0), macro4H });
    return;
  }

  // §19 — Signal reversal exit. If a chart engine fires the opposite direction
  // while an opposite-direction position is open on this instrument, close it.
  // Prevents holding through clear chart-thesis reversals (mean-reversion
  // bounces erasing gains, etc.). SWING positions exempt — they have their own
  // exit logic via EMA9/VWAP confirmation.
  try {
    const lgRev = JSON.parse(readFileSync(join(__dirname, 'paper-ledger.json'), 'utf8'));
    const oppositeOpen = (lgRev.trades ?? []).find(t =>
      t.instrument === instrument && t.status === 'OPEN' &&
      t.signal !== direction && t.engine !== 'SWING'
    );
    if (oppositeOpen && closePosition && underlyingPrice > 0) {
      const entryU = oppositeOpen.underlyingPrice ?? underlyingPrice;
      const dirMult = oppositeOpen.signal === 'CALLS' ? 1 : -1;
      const optMove = (underlyingPrice - entryU) * dirMult * 0.4;
      const synthExit = Math.max(0.01, parseFloat((oppositeOpen.fillPrice + optMove).toFixed(4)));
      const closed = closePosition(oppositeOpen.requestId, synthExit, 'SIGNAL_REVERSAL');
      if (closed) {
        console.log(`  [SIGNAL_REVERSAL] Closed ${instrument} ${oppositeOpen.signal} at $${synthExit.toFixed(2)} (entry $${oppositeOpen.fillPrice}) — ${sigEngine} flipped to ${direction}`);
      }
    }
  } catch {}

  // Global cap: 3 positions when W3 ≥ 4 (strong Mag-7 trend), 2 otherwise; max 1 per instrument
  try {
    const lg = JSON.parse(readFileSync(join(__dirname, 'paper-ledger.json'), 'utf8'));
    const allOpen = (lg.trades ?? []).filter(t => t.status === 'OPEN');
    const globalCap = _w3Score >= 4 ? 3 : 2;
    if (allOpen.length >= globalCap) {
      jGateBlock(sigEngine, instrument, direction, 'GLOBAL_CAP', { open: allOpen.length, cap: globalCap, macro4H });
      return;
    }
    if (allOpen.filter(t => t.instrument === instrument).length >= 1) {
      jGateBlock(sigEngine, instrument, direction, 'INSTRUMENT_CAP', { open: allOpen.filter(t => t.instrument === instrument).length, macro4H });
      return;
    }
  } catch {}

  // News bias gate — block counter-directional trades when news is strongly one-sided
  // Exception: 4+/5 Mag-7 stocks in momentum consensus overrides stale news bias
  const NEWS_BLOCK_THRESH = 5;
  const momentumOverride  = _w3Score >= 4;
  if (_newsBias <= -NEWS_BLOCK_THRESH && direction === 'CALLS') {
    if (momentumOverride) {
      console.log(`  [NEWS GATE] W3 ${_w3Score}/5 override — CALLS allowed despite BEAR news (${_newsBias.toFixed(0)})`);
    } else {
      console.log(`  [NEWS GATE] CALLS blocked — bear news (${_newsBias.toFixed(0)}) · ${_newsTitle.slice(0,55)}`);
      jGateBlock(sigEngine, instrument, direction, 'NEWS_BIAS_BEAR', { newsBias: _newsBias, macro4H });
      return;
    }
  }
  if (_newsBias >= NEWS_BLOCK_THRESH && direction === 'PUTS') {
    if (momentumOverride) {
      console.log(`  [NEWS GATE] W3 ${_w3Score}/5 override — PUTS allowed despite BULL news (+${_newsBias.toFixed(0)})`);
    } else {
      console.log(`  [NEWS GATE] PUTS blocked — bull news (+${_newsBias.toFixed(0)}) · ${_newsTitle.slice(0,55)}`);
      jGateBlock(sigEngine, instrument, direction, 'NEWS_BIAS_BULL', { newsBias: _newsBias, macro4H });
      return;
    }
  }
  // Confidence boost when news aligns — MEDIUM → HIGH
  let boostedSignal = signal;
  if (_newsBias <= -2 && direction === 'PUTS' && signal.confidence === 'MEDIUM')
    boostedSignal = { ...signal, confidence: 'HIGH', reason: signal.reason + ` · news BEAR (${_newsBias.toFixed(0)})` };
  if (_newsBias >= 2 && direction === 'CALLS' && signal.confidence === 'MEDIUM')
    boostedSignal = { ...signal, confidence: 'HIGH', reason: signal.reason + ` · news BULL (+${_newsBias.toFixed(0)})` };

  // FADE engine baseline — first 10 fade trades capped at 1 contract and tagged
  // FADE_EXPERIMENT_PRE10 so post-session analysis can isolate fade performance.
  // After 10 closed fade trades we lift the cap and tag changes to FADE_LIVE.
  let contractCount = 1;
  let tradeTag      = null;
  if (sigEngine === 'FADE') {
    let fadeTrades = 0;
    try {
      const _lg = JSON.parse(readFileSync(join(__dirname, 'paper-ledger.json'), 'utf8'));
      fadeTrades = _lg.engineStats?.FADE?.trades ?? 0;
    } catch {}
    if (fadeTrades < 10) {
      contractCount = 1;
      tradeTag      = `FADE_EXPERIMENT_PRE10:${fadeTrades + 1}_of_10`;
    } else {
      tradeTag      = 'FADE_LIVE';
    }
  }

  // Options-flow confirmation — when chain confirms, MEDIUM → HIGH; when chain
  // disagrees, MEDIUM → block. Synthetic-chain returns null → no effect.
  if (_confirmDirection) {
    try {
      const cf = _confirmDirection(instrument, direction);
      if (cf.confirms === false && boostedSignal.confidence !== 'HIGH') {
        jGateBlock(sigEngine, instrument, direction, 'OPTIONS_FLOW_DISAGREES', { reason: cf.reason, macro4H });
        return;
      }
      if (cf.confirms === true && boostedSignal.confidence === 'MEDIUM') {
        boostedSignal = { ...boostedSignal, confidence: 'HIGH', reason: boostedSignal.reason + ` · flow ${cf.reason}` };
      }
    } catch {}
  }

  // Path 2 simplification 2026-05-11: gate1H, gateMacro4H, gateVwap, and the
  // SPY booster stack were stripped here. Reliable Pine chart-engine signals
  // (STRUCTURE/FVG/SWEEP/FADE) now flow straight from basic-gate pass to tier
  // sizing. macro4H is still recorded on the journal entry below for logging.
  const marketBias = readDailyBiasRegime();

  const stack = applyMultipliers(boostedSignal, { macro4H, marketBias });

  const consensus = {
    signal:     direction,
    engine:     signal.engine ?? 'TREND',
    confidence: boostedSignal.confidence,
    finalConfidence: stack.finalConfidence,
    multipliers: stack.breakdown,
    instrument,
    strike:     liveStrike,
    expiry:     liveExpiry,
    entryPrice: estimatedPrice,
    underlyingPrice: underlyingPrice,
    contracts:  contractCount,
    tag:        tradeTag,
    macro4H,
  };

  const reqId = orderGate.createRequest({ signal: direction, engine: sigEngine });
  const fill  = await sendOrder(consensus, reqId, lastQuote);

  if (!fill.vetoed) {
    // §18 tracker still updated so the gate can be restored without code changes.
    if (_lastFire[instrument]) {
      _lastFire[instrument] = { ms: Date.now(), dir: direction };
    }
    lastScalpOrder[instrument] = now;
    const newsTag = _newsBias !== 0 ? ` · news ${_newsBias > 0 ? 'BULL +' : 'BEAR '}${_newsBias.toFixed(0)}` : '';
    const tagNote = tradeTag ? ` · ${tradeTag}` : '';
    console.log(`  [SCALP] ${instrument} ${direction} paper entry $${estimatedPrice.toFixed(2)} — ${boostedSignal.confidence} confidence${newsTag}${tagNote}`);
  }
}

// ─── Poll cycle ───────────────────────────────────────────────────────────────

let lastAlert     = null;
let lastAlertTime = 0;
let lastFadeAlert     = null;
let lastFadeAlertTime = 0;
let levelsRefreshed = false;
let _spyVolPct = 1.0; // set each poll, read by printSummary
let _biasEvaluatedAt = 0; // ET minutes — last bias evaluation

async function poll() {
  // P2-13 (2026-05-14 EOD): auto-timeframe switch. Fires once per day at
  // 09:30 ET (→1m) and 12:00 ET (→5m). Idempotent — won't re-issue if
  // already switched today. Skips silently if AUTO_TIMEFRAME_SWITCH=false.
  // 2026-05-15 Task 8: extended to QQQ + futures-chart hint. CDP-driven
  // switch covers whichever client is connected to that tab. Futures
  // chart (single tab cycling ES/NQ/MES/MNQ) gets switched too if its
  // client is wired; if not, the maybeBroadcastFuturesSwitchHint helper
  // fires a wsBroadcast prompting the operator to verify manually.
  try {
    const { maybeSwitchTimeframe, maybeBroadcastFuturesSwitchHint } = await import('./timeframeSwitcher.js');
    if (spyClient) await maybeSwitchTimeframe(spyClient, { name: 'monitor.js[SPY]' });
    if (qqqClient) await maybeSwitchTimeframe(qqqClient, { name: 'monitor.js[QQQ]' });
    if (typeof maybeBroadcastFuturesSwitchHint === 'function') {
      maybeBroadcastFuturesSwitchHint();
    }
  } catch {}

  if (!isMarketHours()) {
    // Off-hours: still run FVG scanners against cached 5M bars so the
    // dashboard panels show the last session's gaps. Sweep needs live
    // levels (HOD/LOD/etc) so it skips. Trading paths stay gated.
    // Chart drawings also redraw each cycle — they don't need live data,
    // just the cached bars + state files. Levels are pulled from the
    // pre-market calc rather than the live read.
    const offHourLevels = global.preMarketLevels ? {
      support:    [
        { price: global.preMarketLevels.pdLow,   label: 'PDL',  type: 'support'    },
        { price: global.preMarketLevels.pdClose, label: 'PDC',  type: 'support'    },
      ].filter(l => Number.isFinite(l.price)),
      resistance: [
        { price: global.preMarketLevels.pdHigh,  label: 'PDH',  type: 'resistance' },
      ].filter(l => Number.isFinite(l.price)),
    } : { support: [], resistance: [] };
    const clientForInst = { SPY: spyClient, QQQ: qqqClient, IWM: iwmClient };
    for (const inst of ['SPY', 'QQQ', 'IWM']) {
      if (barCache[inst]) {
        try { await scanTriggers(inst, barCache[inst], null); } catch {}
        try { await drawChartAnnotations(inst, clientForInst[inst], offHourLevels); } catch {}
      }
    }
    printOutsideHours();
    return;
  }

  // Re-fetch pre-market levels at 09:31 ET if todayOpen was unknown at startup
  if (!levelsRefreshed && global.preMarketLevels?.todayOpen == null) {
    const etM = new Date().toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:false,hour:'2-digit',minute:'2-digit'}).split(':').reduce((h,m)=>+h*60+ +m, 0);
    if (etM >= 9*60+31) {
      levelsRefreshed = true;
      const refreshed = await calcPreMarketLevels();
      if (refreshed) {
        global.preMarketLevels = refreshed;
        console.log(`  [LEVELS] SPY re-fetched at 09:31 — PDH $${refreshed.pdHigh.toFixed(2)}  PDL $${refreshed.pdLow.toFixed(2)}  PDC $${refreshed.pdClose.toFixed(2)}  Open ${refreshed.todayOpen != null ? '$'+refreshed.todayOpen.toFixed(2) : 'N/A'}`);
      }
    }
  }

  const paneMap = await buildPaneMap();

  // Read 6 stocks (sequential — each requires a pane focus)
  const rows = [];
  for (const sym of STOCKS) {
    const idx = paneMap[sym];
    if (idx == null) {
      rows.push({ symbol: sym, price: null, vwap: null, delta: null, vrrs: null,
                  vrrsSector: null, bias: 'unknown', levels: null, error: 'not on chart' });
      continue;
    }
    try {
      const d    = await readStockPane(idx);
      const bias = classify(d.price, d.vwap, d.delta, d.vrrs, d.vrrsSector);
      const _barVol  = (d.bars ?? []).reduce((s, b) => s + (b.volume ?? 0), 0);
      const _avgPBar = STOCK_AVG_VOL_PER_BAR[sym] ?? 50_000;
      const _volPct  = (d.bars?.length ?? 0) > 0 ? _barVol / (_avgPBar * d.bars.length) : null;
      rows.push({ symbol: sym, ...d, bias, barVol: _barVol, volPct: _volPct });
    } catch (e) {
      rows.push({ symbol: sym, price: null, vwap: null, delta: null, vrrs: null,
                  vrrsSector: null, bias: 'unknown', levels: null, error: e.message.slice(0, 40) });
    }
  }

  // Read SPY from its dedicated tab
  let spy = { price: null, vwap: null, delta: null, vrrs: null, vrrsSector: null,
              vrrsChangeRate: null, bias: 'unknown', levels: null, bars: null };
  try {
    const d = await readSPY();
    spy = { ...d, bias: classify(d.price, d.vwap, d.delta, d.vrrs, d.vrrsSector) };
  } catch (e) {
    spy.error = e.message.slice(0, 40);
  }

  // FVG + sweep scanners — run once per poll, state persists in
  // fvg-state-SPY.json / sweep-state-SPY.json. Strategies that consume
  // active gaps or recent sweeps read those files directly.
  const spyTriggers = await scanTriggers('SPY', barCache.SPY, spy.levels);
  const { fvgSig: spyFvgSig, sweepSig: spySweepSig } = runEntryEngines('SPY', spyTriggers);

  // Chart annotations: layered draw for levels + FVG + S/D + sweeps + arrows.
  // Runs after the scanners so the FVG state file is fresh.
  await drawChartAnnotations('SPY', spyClient, spy.levels);

  // ── Swing Engine update ───────────────────────────────────────────────────
  const spyEma9      = computeEMA9fromBars(spy.bars);
  spy.ema9           = spyEma9;  // attach so trendEngine/fadeEngine can use it
  const swingState   = SwingEngine.update(spy.price, spy.vwap, spyEma9, spy.bars);

  // ── SPY Swing order wiring ────────────────────────────────────────────────
  if (swingState) {
    const spyL2Quote = getL2Signal('SPY');
    if ((swingState.status === 'LONG' || swingState.status === 'SHORT') && !activeSwing.SPY.requestId) {
      await executeSwingEntry('SPY', swingState, spyL2Quote);
    }
    if (swingState.status === 'CLOSED' && activeSwing.SPY.requestId) {
      executeSwingExit('SPY', swingState);
    }
  }

  // ── QQQ tab — read watchlist + instrument ────────────────────────────────
  let qqqRows = [], qqq = null, qqqSummary = null, qqqSwingState = null;
  let qqqFvgSig = null, qqqSweepSig = null;
  if (qqqClient) {
    const qqqPaneMap = await buildQqqPaneMap();
    for (const sym of QQQ_STOCKS) {
      const idx = qqqPaneMap[sym];
      if (idx == null) {
        qqqRows.push({ symbol: sym, price: null, vwap: null, delta: null, vrrs: null,
                       vrrsSector: null, bias: 'unknown', levels: null, error: 'not on chart' });
        continue;
      }
      try {
        const d    = await readQqqPane(idx);
        const bias = classify(d.price, d.vwap, d.delta, d.vrrs, d.vrrsSector);
        qqqRows.push({ symbol: sym, ...d, bias });
      } catch (e) {
        qqqRows.push({ symbol: sym, price: null, vwap: null, delta: null, vrrs: null,
                       vrrsSector: null, bias: 'unknown', levels: null, error: e.message.slice(0,40) });
      }
    }
    // Read QQQ instrument itself (pane 0)
    try {
      const d = await readQQQInstrument();
      qqq = { ...d, bias: classify(d.price, d.vwap, d.delta, d.vrrs, d.vrrsSector) };
      qqqSummary = buildSpySummary(qqq);   // reuse same summary builder
    } catch (e) {
      qqq = { price: null, vwap: null, delta: null, bias: 'unknown', levels: null, error: e.message.slice(0,40) };
    }

    // FVG + sweep scanners for QQQ
    const qqqTriggers = await scanTriggers('QQQ', barCache.QQQ, qqq.levels);
    ({ fvgSig: qqqFvgSig, sweepSig: qqqSweepSig } = runEntryEngines('QQQ', qqqTriggers));

    await drawChartAnnotations('QQQ', qqqClient, qqq.levels);

    const qqqEma9 = computeEMA9fromBars(qqq?.bars);
    qqqSwingState = QqqSwingEngine.update(qqq?.price, qqq?.vwap, qqqEma9, qqq?.bars);

    // QQQ Swing order wiring — suspended until QQQ_SUSPENDED = false
    if (qqqSwingState && !QQQ_SUSPENDED) {
      const qqqL2Quote = getL2Signal('QQQ');
      if ((qqqSwingState.status === 'LONG' || qqqSwingState.status === 'SHORT') && !activeSwing.QQQ.requestId) {
        await executeSwingEntry('QQQ', qqqSwingState, qqqL2Quote);
      }
      if (qqqSwingState.status === 'CLOSED' && activeSwing.QQQ.requestId) {
        executeSwingExit('QQQ', qqqSwingState);
      }
    }
  }

  // ── IWM tab — read watchlist + instrument ────────────────────────────────
  let iwmRows = [], iwm = null, iwmSummary = null, iwmSwingState = null;
  let iwmFvgSig = null, iwmSweepSig = null;
  if (iwmClient) {
    const iwmPaneMap = await buildIwmPaneMap();
    for (const sym of IWM_STOCKS) {
      const idx = iwmPaneMap[sym];
      if (idx == null) {
        iwmRows.push({ symbol: sym, price: null, vwap: null, delta: null, vrrs: null,
                       vrrsSector: null, bias: 'unknown', levels: null, error: 'not on chart' });
        continue;
      }
      try {
        const d    = await readIwmPane(idx);
        const bias = classify(d.price, d.vwap, d.delta, d.vrrs, d.vrrsSector);
        iwmRows.push({ symbol: sym, ...d, bias });
      } catch (e) {
        iwmRows.push({ symbol: sym, price: null, vwap: null, delta: null, vrrs: null,
                       vrrsSector: null, bias: 'unknown', levels: null, error: e.message.slice(0,40) });
      }
    }
    try {
      const d = await readIWMInstrument();
      iwm = { ...d, bias: classify(d.price, d.vwap, d.delta, d.vrrs, d.vrrsSector) };
      iwmSummary = buildSpySummary(iwm);
    } catch (e) {
      iwm = { price: null, vwap: null, delta: null, bias: 'unknown', levels: null, error: e.message.slice(0,40) };
    }

    // FVG + sweep scanners for IWM
    const iwmTriggers = await scanTriggers('IWM', barCache.IWM, iwm.levels);
    ({ fvgSig: iwmFvgSig, sweepSig: iwmSweepSig } = runEntryEngines('IWM', iwmTriggers));

    await drawChartAnnotations('IWM', iwmClient, iwm.levels);

    const iwmEma9 = computeEMA9fromBars(iwm?.bars);
    // 2026-05-15 Task 6: IWM_RETIRED — swing engine update gated so no new
    // IWM SWING entries fire. Reading IwmSwingEngine.getState() elsewhere
    // still returns the cleared state object.
    iwmSwingState = IWM_RETIRED ? null : IwmSwingEngine.update(iwm?.price, iwm?.vwap, iwmEma9, iwm?.bars);

    // IWM Swing order wiring
    if (iwmSwingState) {
      const iwmL2Quote = getL2Signal('IWM');
      if ((iwmSwingState.status === 'LONG' || iwmSwingState.status === 'SHORT') && !activeSwing.IWM.requestId) {
        await executeSwingEntry('IWM', iwmSwingState, iwmL2Quote);
      }
      if (iwmSwingState.status === 'CLOSED' && activeSwing.IWM.requestId) {
        executeSwingExit('IWM', iwmSwingState);
      }
    }
  }

  const spySummary = buildSpySummary(spy);

  // ── HANK LIVE ANALYSIS — Claude API (non-blocking, cached) ──────────────
  const [spyAnalysis, qqqAnalysis, iwmAnalysis] = await Promise.all([
    fetchHankAnalysis('SPY',  spy.price,  spy.vwap,  spy.delta,  spy.bias,  spy.tick,  rows,      swingState,   spySummary),
    qqqClient ? fetchHankAnalysis('QQQ', qqq?.price, qqq?.vwap, qqq?.delta, qqq?.bias, qqq?.tick, qqqRows,      qqqSwingState, qqqSummary) : Promise.resolve(null),
    iwmClient ? fetchHankAnalysis('IWM', iwm?.price, iwm?.vwap, iwm?.delta, iwm?.bias, iwm?.tick, iwmRows,      iwmSwingState, iwmSummary) : Promise.resolve(null),
  ]);

  // Vote counts — pure for display
  const pureBulls = rows.filter(r => r.bias === 'bullish').length;
  const pureBears = rows.filter(r => r.bias === 'bearish').length;

  // Lean counts for signal
  const bullRows = rows.filter(r => r.bias === 'bullish' || (r.bias === 'div_bear' && r.delta > -1000));
  const bearRows = rows.filter(r => r.bias === 'bearish' || (r.bias === 'div_bull' && r.delta <  1000));
  const bulls    = bullRows.length;
  const bears    = bearRows.length;

  // Chop detection
  const heavyDivBear = rows.filter(r => r.bias === 'div_bear' && r.delta < -1000).length;
  const isChop       = heavyDivBear >= 3 && pureBulls < 2 && pureBears < 2;

  // W3 score — use QQQ rows as W3 proxy
  const w3Rows  = qqqRows.filter(r => r.symbol !== 'QQQ');
  const w3Score = w3Rows.filter(r => r.bias === 'bullish' || r.bias === 'div_bull').length;
  _w3Score  = w3Score;      // expose to news gate momentum override
  _isChop   = isChop;       // expose to MIDDAY chop filter
  _spyPrice = spy?.price  ?? 0;
  _qqqPrice = qqq?.price  ?? 0;
  _iwmPrice = iwm?.price  ?? 0;
  // HIERARCHY_V2 — expose VWAP + Mag-6 + TICK + delta for the new gates & boosters
  _spyVwap  = Number.isFinite(spy?.vwap) ? spy.vwap : 0;
  _qqqVwap  = Number.isFinite(qqq?.vwap) ? qqq.vwap : 0;
  _iwmVwap  = Number.isFinite(iwm?.vwap) ? iwm.vwap : 0;
  _spyBulls = pureBulls;
  _spyBears = pureBears;
  _spyTick  = Number.isFinite(spy?.tick)  ? spy.tick  : 0;
  _spyDelta = Number.isFinite(spy?.delta) ? spy.delta : 0;

  // Session
  const session = getSession();

  // Per-poll SPY macro4H — computed once and threaded into SIGNAL/GATE
  // journal records so post-session review can correlate fires/blocks with
  // 4H regime. Per-instrument; QQQ/IWM compute their own inside their
  // monitors. Failure → 'UNKNOWN' (non-blocking under gateMacro4H).
  let _spyMacro4H = 'UNKNOWN';
  if (barCache.SPY) {
    try {
      const bars4H = await barCache.SPY.get('240');
      if (bars4H && bars4H.length) _spyMacro4H = analyze4H(bars4H).direction;
    } catch {}
  }

  // 2026-05-13: write macro4H to shared state file for webhook-server.js
  // counter-trend gate. SPY family (SPY/ES1!/MES1!) reads from macro4h-spy.json.
  try {
    writeFileSync(join(__dirname, 'macro4h-spy.json'), JSON.stringify({
      instrument: 'SPY', macro4H: _spyMacro4H, ts: Date.now(), time: getETString(),
    }));
  } catch {}

  // P0 (2026-05-15 EOD): 1H structural bias for counter-trend gate v2.
  // Catches today's bug: macro4H=UP but 1H structurePattern was bearish
  // (LH_LL), and an HL CALLS print inside that downtrend was a liquidity
  // sweep, not a real continuation. 1H gate blocks when trendBias or
  // structurePattern opposes signal direction.
  let _spy1H = { trendBias: 'NEUTRAL', structurePattern: 'NEUTRAL' };
  if (barCache.SPY) {
    try {
      const bars1H = await barCache.SPY.get('60');
      if (bars1H && bars1H.length) {
        const a = analyze1H(bars1H, spy?.price);
        _spy1H = { trendBias: a.trendBias, structurePattern: a.structurePattern };
      }
    } catch {}
  }
  try {
    writeFileSync(join(__dirname, 'macro1h-spy.json'), JSON.stringify({
      instrument: 'SPY', ..._spy1H, ts: Date.now(), time: getETString(),
    }));
  } catch {}

  // Triple engine: TREND + FADE + STRUCTURE
  const trendSig     = trendEngine(bulls, bears, spy, spySummary, isChop, w3Score, spy.tick);
  const fadeSig      = isTradingHours() ? fadeEngine(spy) : null;

  // STRUCTURE consumes 5M bars from the shared bar cache. If the cache isn't
  // ready (pre-bootstrap, fetch failure), refuse to fire — the shared engine's
  // contract is "null bars → no trade", never fall back to coarser data.
  let structureSig = null;
  if (isTradingHours() && barCache.SPY) {
    const bars5M = await barCache.SPY.get('5');
    if (bars5M && bars5M.length >= 5) {
      structureSig = chartStructureEngine({ ...spy, bars: bars5M });
    }
  }

  // Volume calculation for SPY — must be before printSummary so the panel can display it
  {
    const _bars = spy.bars ?? [];
    const _vol  = _bars.reduce((s, b) => s + (b.volume ?? 0), 0);
    _spyVolPct  = _bars.length > 0 ? _vol / (SPY_AVG_VOL_PER_BAR * _bars.length) : 1.0;
  }

  // Daily bias — evaluate at 09:40 (initial, 10-min OR) + 12:30 (re-eval for afternoon flip).
  // Uses the same SPY bars the engines see; verdict is consumed by gates + exits.
  if (_evaluateDailyBias) {
    const _etM = getETMins();
    const _shouldEval =
      (_etM >= 9*60+40 && _biasEvaluatedAt < 9*60+40) ||
      (_etM >= 12*60+30 && _biasEvaluatedAt < 12*60+30);
    if (_shouldEval && (spy.bars?.length ?? 0) >= 5) {
      try {
        const v = _evaluateDailyBias(spy.bars, {});
        if (v) {
          _biasEvaluatedAt = _etM;
          console.log(`  ${C.cyan}[BIAS] ${v.verdict.bias} (conf ${v.verdict.confidence}) — ${v.verdict.note}${C.reset}`);
        }
      } catch (e) { console.log(`  [BIAS] eval error: ${e.message}`); }
    }
  }

  // Journal — full snapshot once per poll, plus any actionable signal records
  try {
    jPoll({
      session:   session.name,
      spy:       { price: spy.price ?? null, vwap: spy.vwap ?? null, delta: spy.delta ?? null, bias: spy.bias ?? null, bars: (spy.bars?.length ?? 0), tick: spy.tick ?? null, volPct: parseFloat(_spyVolPct.toFixed(2)) },
      qqq:       qqq ? { price: qqq.price ?? null, vwap: qqq.vwap ?? null, delta: qqq.delta ?? null, bias: qqq.bias ?? null } : null,
      iwm:       iwm ? { price: iwm.price ?? null, vwap: iwm.vwap ?? null, delta: iwm.delta ?? null, bias: iwm.bias ?? null } : null,
      mag6:      { bulls: pureBulls, bears: pureBears, w3Score, isChop },
      gates:     { newsBias: _newsBias, sessionTrade: session.trade },
      signals:   {
        trend:     trendSig     ? { action: trendSig.action,     confidence: trendSig.confidence,     engine: trendSig.engine ?? 'TREND',     reason: trendSig.reason }     : null,
        fade:      fadeSig      ? { action: fadeSig.action,      confidence: fadeSig.confidence,      engine: fadeSig.engine ?? 'FADE',       reason: fadeSig.reason }      : null,
        structure: structureSig ? { action: structureSig.action, confidence: structureSig.confidence, engine: 'STRUCTURE', event: structureSig.event, reason: structureSig.reason } : null,
      },
    });
    if (trendSig && (trendSig.action.includes('CALLS') || trendSig.action.includes('PUTS')))
      jSignal('TREND',     trendSig.action.includes('CALLS') ? 'CALLS' : 'PUTS',     trendSig.confidence,     trendSig.reason,     { macro4H: _spyMacro4H, instrument: 'SPY' });
    if (fadeSig)
      jSignal('FADE',      fadeSig.action.includes('CALLS') ? 'CALLS' : 'PUTS',      fadeSig.confidence,      fadeSig.reason,      { macro4H: _spyMacro4H, instrument: 'SPY' });
    if (structureSig)
      jSignal('STRUCTURE', structureSig.action,                                       structureSig.confidence, structureSig.reason, { event: structureSig.event, macro4H: _spyMacro4H, instrument: 'SPY' });
  } catch (e) { jError('poll-journal', e.message); }

  printSummary(rows, spy, pureBulls, pureBears, spySummary, isChop, swingState, spyAnalysis, trendSig, fadeSig, w3Rows, session, structureSig);
  // QQQ and IWM now have standalone monitors (monitor-qqq.js / monitor-iwm.js)
  // Removed from this window to keep SPY monitor clean

  // ── Write JSON state files for briefing.js ───────────────────────────────
  // spy-levels.json — SPY pre-market levels + live price
  // CRITICAL: todayOpen must reflect TODAY's open, not yesterday's close.
  // calcPreMarketLevels() runs at 07:00 and sets global.preMarketLevels.
  // This writer stamps the file every poll so briefing always has fresh data.
  try {
    const spyLevels = {
      pdHigh:    global.preMarketLevels?.pdHigh    ?? null,
      pdLow:     global.preMarketLevels?.pdLow     ?? null,
      pdClose:   global.preMarketLevels?.pdClose   ?? null,
      todayOpen: global.preMarketLevels?.todayOpen ?? null,
      current:   spy.price ?? null,
      vwap:      spy.vwap  ?? null,
      bias:      spy.bias  ?? null,
      volumePct: parseFloat(_spyVolPct.toFixed(2)),
      volumeColor: _spyVolPct < 0.50 ? 'red' : _spyVolPct < 0.80 ? 'yellow' : 'green',
      ts:        Date.now(),
      time:      getETString(),
    };
    writeFileSync(join(__dirname, 'spy-levels.json'), JSON.stringify(spyLevels, null, 2));
  } catch { /* non-fatal */ }

  // mag6-state.json — Mag-6 snapshot for briefing pre-market bias section
  try {
    const mag6State = {
      ts:     Date.now(),
      time:   getETString(),
      stocks: rows.map(r => ({
        sym:   r.symbol,
        price: r.price,
        vwap:  r.vwap,
        delta: r.delta,
        ema9:  computeEMA9fromBars(r.bars) ?? null,
        bias:  r.bias,
      })),
      spy: {
        price: spy.price,
        vwap:  spy.vwap,
        delta: spy.delta,
        ema9:  computeEMA9fromBars(spy.bars) ?? null,
        tick:  spy.tick ?? null,
        bias:  spy.bias,
      },
      bulls: pureBulls,
      bears: pureBears,
    };
    writeFileSync(join(__dirname, 'mag6-state.json'), JSON.stringify(mag6State, null, 2));
  } catch { /* non-fatal */ }

  // qqq-levels.json + iwm-levels.json writes removed in Task 3 (May 9 audit § 2.4).
  // monitor-qqq.js and monitor-iwm.js are now the sole writers for their own
  // levels files — no race, fresher todayOpen (those monitors refresh at 09:31).

  // Refresh news bias once per poll cycle — used by executeScalpSignal gating
  refreshNewsBias();

  // Exit open TREND positions before entering new ones
  const _spyVolumePct = _spyVolPct; // already set above before printSummary
  const _spyAtrEst = parseFloat(((SwingEngine.getState().atr ?? (spy.price ?? 500) * 0.005) * 0.4).toFixed(2));
  checkTrendExits('SPY', _spyAtrEst);
  if (qqqClient && qqq && !QQQ_SUSPENDED) {
    const _qqqAtrEst = parseFloat(((QqqSwingEngine.getState().atr ?? (qqq?.price ?? 680) * 0.005) * 0.4).toFixed(2));
    checkTrendExits('QQQ', _qqqAtrEst);
  }
  if (iwmClient && iwm) {
    const _iwmAtrEst = parseFloat(((IwmSwingEngine.getState().atr ?? (iwm?.price ?? 280) * 0.005) * 0.4).toFixed(2));
    checkTrendExits('IWM', _iwmAtrEst);
  }

  // Options flow — pull SPY/QQQ/IWM 0DTE/1DTE/weekly chains once per poll
  if (_pollOptionsFlow) {
    try {
      _pollOptionsFlow({
        SPY: { price: _spyPrice, atr: SwingEngine.getState().atr ?? null },
        QQQ: { price: _qqqPrice, atr: QqqSwingEngine.getState().atr ?? null },
        IWM: { price: _iwmPrice, atr: IwmSwingEngine.getState().atr ?? null },
      });
    } catch (e) { console.log(`  [FLOW] poll error: ${e.message}`); }
  }

  // theta.js evaluation — per-position greeks, IV crush, hard-exit, portfolio theta
  // monitor.js is the canonical writer of portfolio-theta.json (knows SPY/QQQ/IWM).
  // P0-1 (2026-05-14 EOD): underlyingMap extended with futures via
  // latest-prices.json cache (webhook writes on each Pine alert). Futures
  // stops were silently broken before — feeder returned null for ES1!/NQ1!/
  // MES1!/MNQ1!, so STOP_LOSS never fired on futures. Now resolved.
  if (evaluateOpenPositions && _bs && _gtr) {
    let _futuresCache = {};
    try {
      const _pcf = join(__dirname, 'latest-prices.json');
      if (existsSync(_pcf)) {
        const raw = JSON.parse(readFileSync(_pcf, 'utf8'));
        // Stale-tolerance: accept any cached price <60s old. Older = futures
        // chart hasn't ticked recently, treat as no-feed (don't risk stale stop).
        const cutoff = Date.now() - 60_000;
        for (const [k, v] of Object.entries(raw || {})) {
          if (v?.price != null && v.ts >= cutoff) _futuresCache[k] = v.price;
        }
      }
    } catch {}
    const underlyingMap = {
      SPY: _spyPrice, QQQ: _qqqPrice, IWM: _iwmPrice,
      'ES1!': _futuresCache['ES1!'] ?? _futuresCache['ES'],
      'NQ1!': _futuresCache['NQ1!'] ?? _futuresCache['NQ'],
      'MES1!': _futuresCache['MES1!'] ?? _futuresCache['MES'],
      'MNQ1!': _futuresCache['MNQ1!'] ?? _futuresCache['MNQ'],
      ES: _futuresCache['ES'] ?? _futuresCache['ES1!'],
      NQ: _futuresCache['NQ'] ?? _futuresCache['NQ1!'],
      MES: _futuresCache['MES'] ?? _futuresCache['MES1!'],
      MNQ: _futuresCache['MNQ'] ?? _futuresCache['MNQ1!'],
    };
    const feeder = (trade) => {
      const u = underlyingMap[trade.instrument];
      if (!u) return null;
      // No strike → can't BS-reprice; pass underlying only, evaluator records burn zone
      if (trade.strike == null || trade.entryIV == null) return { optionPrice: trade.fillPrice, underlyingPrice: u };
      try {
        const inst = trade.instrument === 'SPX' ? 'SPX' : 'SPY';
        const { T } = _gtr(inst);
        const greeks = _bs(u, trade.strike, T, 0.05, trade.entryIV, trade.type);
        return { optionPrice: greeks.price, underlyingPrice: u };
      } catch {
        return { optionPrice: trade.fillPrice, underlyingPrice: u };
      }
    };
    try { evaluateOpenPositions(feeder); }
    catch (e) { console.log(`  [THETA] evaluation error: ${e.message}`); }
  }

  // ── Alert + scalp order logic ─────────────────────────────────────────────
  const now = Date.now();

  // trendSig dispatch + alert removed 2026-05-11 (Path 2 simplification).
  // Under HIERARCHY_V2 the TREND consensus signal is dead context here —
  // no order dispatch, no console alert. Pine chart engines are the brain.
  // (trendSig is still computed upstream so the printSummary trend panel
  // and the WS broadcast can read it; the dispatch + alert sites are gone.)

  // Fire on fadeSig with cooldown — structural signals but still gated
  if (fadeSig && isTradingHours()) {
    const dir = fadeSig.action.includes('CALLS') ? 'CALLS' : 'PUTS';
    if (lastFadeAlert !== dir || now - lastFadeAlertTime > COOLDOWN) {
      const badge = dir === 'CALLS' ? C.bgGreen : C.bgRed;
      process.stdout.write('\x07');
      console.log(`\n  ${badge}  *** FADE: ${dir} ***  ${C.reset}`);
      console.log(`  ${C.bold}Reason:${C.reset} ${fadeSig.reason}`);
      console.log(`  ${C.bold}Time:${C.reset}   ${getETString()} ET\n`);
      lastFadeAlert = dir; lastFadeAlertTime = now;
    }
    if (!PINE_PRIMARY) await executeScalpSignal('SPY', fadeSig, getL2Signal('SPY'), _spyVolumePct);
  }

  // Fire on structureSig — chart pattern signals, independent of consensus.
  // PINE_PRIMARY: computation still runs (printSummary, jSignal); dispatch
  // is owned by Pine→webhook→paperTrading.sendOrder.
  if (structureSig && isTradingHours() && !PINE_PRIMARY) {
    await executeScalpSignal('SPY', structureSig, getL2Signal('SPY'), _spyVolumePct);
  }

  // Fire FVG + SWEEP entries — same gate stack as TREND/STRUCTURE.
  // PINE_PRIMARY: dispatch deferred to webhook.
  if (spyFvgSig && isTradingHours() && !PINE_PRIMARY) {
    await executeScalpSignal('SPY', spyFvgSig, getL2Signal('SPY'), _spyVolumePct);
  }
  if (spySweepSig && isTradingHours() && !PINE_PRIMARY) {
    await executeScalpSignal('SPY', spySweepSig, getL2Signal('SPY'), _spyVolumePct);
  }

  // Divergence warnings
  if (bulls >= THRESHOLD && (spy.bias === 'bearish' || spy.bias === 'div_bear'))
    fireDivergence(`${bulls}/6 stocks bullish but SPY tab diverging (SPY: ${spy.bias})`);
  if (bears >= THRESHOLD && (spy.bias === 'bullish' || spy.bias === 'div_bull'))
    fireDivergence(`${bears}/6 stocks bearish but SPY tab diverging (SPY: ${spy.bias})`);

  // QQQ + IWM chart-engine dispatch. TREND consensus (buildSignalForInstrument)
  // no longer dispatched from monitor.js — completes Path 2 simplification +
  // chart-first hierarchy v2 (the NOT_CHART_ENGINE gate at line 2384 would
  // have caught it anyway; this removes the dead pathway entirely).
  if (qqqClient && qqq && !QQQ_SUSPENDED) {
    if (qqqFvgSig   && isTradingHours() && !PINE_PRIMARY) await executeScalpSignal('QQQ', qqqFvgSig,   getL2Signal('QQQ'));
    if (qqqSweepSig && isTradingHours() && !PINE_PRIMARY) await executeScalpSignal('QQQ', qqqSweepSig, getL2Signal('QQQ'));
  }
  if (iwmClient && iwm) {
    if (iwmFvgSig   && isTradingHours() && !PINE_PRIMARY) await executeScalpSignal('IWM', iwmFvgSig,   getL2Signal('IWM'));
    if (iwmSweepSig && isTradingHours() && !PINE_PRIMARY) await executeScalpSignal('IWM', iwmSweepSig, getL2Signal('IWM'));
  }

  // Session reset at 16:00 ET
  const etMinsNow = new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
  }).split(':').reduce((h, m) => Number(h) * 60 + Number(m), 0);

  if (etMinsNow >= 16 * 60 && etMinsNow < 16 * 60 + 1) {
    if (sessionReset) sessionReset();
    // Reset active swing trackers for new day
    for (const k of Object.keys(activeSwing)) activeSwing[k] = { requestId: null, status: null };
    if (printScorecard) printScorecard();
  }

  // ── Broadcast TICK_SPY / TICK_QQQ / TICK_IWM to wsServer ─────────────────
  // paperTrading.js connects as a WS client and processes these for autonomous trading.
  // Uses global.wsBroadcast set by wsServer.start() — no-op if wsServer not running.
  if (typeof global.wsBroadcast === 'function') {
    const trendSignal = trendSig?.action?.includes('CALLS') ? 'CALLS'
                      : trendSig?.action?.includes('PUTS')  ? 'PUTS' : null;
    global.wsBroadcast({
      type: 'tick',
      payload: {
        session:  session.name,
        w3Score,
        SPY: spy.price ? {
          price:      spy.price,
          vwap:       spy.vwap,
          delta:      spy.delta,
          tick:       spy.tick,
          bias:       spy.bias,
          levels:     spy.levels,
          signal:     trendSignal,
          confidence: trendSig?.confidence,
          reason:     trendSig?.reason,
        } : null,
        QQQ: (qqqClient && qqq?.price) ? {
          price:  qqq.price,
          vwap:   qqq.vwap,
          delta:  qqq.delta,
          tick:   qqq.tick,
          bias:   qqq.bias,
          levels: qqq.levels,
        } : null,
        IWM: (iwmClient && iwm?.price) ? {
          price:  iwm.price,
          vwap:   iwm.vwap,
          delta:  iwm.delta,
          tick:   iwm.tick,
          bias:   iwm.bias,
          levels: iwm.levels,
        } : null,
      },
    });
  }
}

// ─── Pre-market level calculator ─────────────────────────────────────────────

// ─── HANK LIVE ANALYSIS — Claude API narrative block ─────────────────────────
//
// Fires every poll during market hours. Generates a 2-3 sentence narrative
// summarising current market state for SPY, QQQ, and IWM.
// Cached per instrument — only re-calls API if data changed meaningfully.
// Uses claude-sonnet-4-20250514 via Anthropic API (no key needed — proxied).

const analysisCache = new Map();  // instrument → { text, ts, hash }
const ANALYSIS_STALE_MS = 60_000; // refresh every 60s max (2 polls)

function buildAnalysisHash(price, vwap, delta, bias, bulls, bears) {
  // Simple hash — only re-call API if something meaningful changed
  return `${price?.toFixed(0)}_${vwap?.toFixed(0)}_${bias}_${bulls}_${bears}`;
}

async function fetchHankAnalysis(instrument, price, vwap, delta, bias, tick, rows, swingState, summary) {
  const hash = buildAnalysisHash(price, vwap, delta, bias,
    rows.filter(r=>r.bias==='bullish').length,
    rows.filter(r=>r.bias==='bearish').length);

  const cached = analysisCache.get(instrument);
  if (cached && cached.hash === hash && Date.now() - cached.ts < ANALYSIS_STALE_MS) {
    return cached.text;
  }

  const stockList = rows.map(r => `${r.symbol}(${r.bias})`).join(', ');
  const swingLine = swingState?.status === 'LONG'  ? `Swing LONG entry $${swingState.entry?.toFixed(2)}, target $${swingState.target}, stop $${swingState.stop}.`
                  : swingState?.status === 'SHORT' ? `Swing SHORT entry $${swingState.entry?.toFixed(2)}, target $${swingState.target}, stop $${swingState.stop}.`
                  : swingState?.status === 'CLOSED'? `Swing closed ${swingState.exitReason} P&L ${swingState.pnl?.toFixed(2)}.`
                  : 'Swing waiting for 09:30 entry.';
  const trendLine = summary ? `${summary.trendDir} — ${summary.trendDetail}. Status: ${summary.status}.` : '';
  const tickLine  = tick != null ? `$TICK: ${tick}.` : '';

  const prompt = `You are HANK, an AI trading assistant. Provide a concise 2-3 sentence market analysis for ${instrument} right now. Be direct and actionable. No preamble.

${instrument} price: $${price?.toFixed(2)} | VWAP: $${vwap?.toFixed(2)} | Delta: ${delta != null ? (delta/1000).toFixed(1)+'K' : 'N/A'} | Bias: ${bias}
${tickLine}
Components: ${stockList}
${trendLine}
${swingLine}

Write as if speaking to a trader watching the screen. Focus on what matters right now.`;

  // Require API key — set ANTHROPIC_API_KEY in .env
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    if (!analysisCache.has(`_warned_${instrument}`)) {
      console.log(`  ${C.yellow}[HANK AI] ANTHROPIC_API_KEY not set in .env — live analysis disabled${C.reset}`);
      analysisCache.set(`_warned_${instrument}`, true);
    }
    return null;
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.log(`  ${C.yellow}[HANK AI] API error ${res.status}: ${err?.error?.message ?? 'unknown'}${C.reset}`);
      return cached?.text ?? null;
    }
    const data = await res.json();
    const text = data.content?.[0]?.text?.trim() ?? null;
    if (text) analysisCache.set(instrument, { text, hash, ts: Date.now() });
    return text ?? cached?.text ?? null;
  } catch (e) {
    console.log(`  ${C.yellow}[HANK AI] fetch error: ${e.message}${C.reset}`);
    return cached?.text ?? null;
  }
}

function printLiveAnalysis(instrument, text, timestamp) {
  if (!text) return;
  const line = '  ' + '─'.repeat(72);
  console.log(line);
  console.log(`  ${C.bold}${C.cyan}◉ HANK LIVE ANALYSIS${C.reset}  ${C.dim}${instrument} · 30s · ${timestamp} ET${C.reset}`);
  // Word-wrap at 70 chars
  const words = text.split(' ');
  let line_ = '  ';
  for (const w of words) {
    if (line_.length + w.length > 72) { console.log(line_); line_ = '  '; }
    line_ += w + ' ';
  }
  if (line_.trim()) console.log(line_);
}

// ─── Pre-market level calculators for QQQ and IWM ────────────────────────────

async function calcPreMarketLevelsForClient(client) {
  if (!client) return null;
  try {
    // Focus pane 0 (the ETF itself — IWM or QQQ) before switching timeframe
    // Without this, the active pane may be a component stock (FN, AMD etc.)
    await evalOn(client, JS_FOCUS_PANE(0));
    await sleep(300);
    await evalOn(client, `(function(){try{window.TradingViewApi._activeChartWidgetWV.value().setResolution('1D');}catch(e){}})()`);
    await sleep(2000);
    const dailyBars = await evalOn(client, JS_DAILY_BARS);
    await evalOn(client, `(function(){try{window.TradingViewApi._activeChartWidgetWV.value().setResolution('1');}catch(e){}})()`);
    await sleep(1500);
    if (!dailyBars || dailyBars.length < 2) return null;
    const fmt = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
    const lastBarDate = fmt(new Date(dailyBars[dailyBars.length - 1].time * 1000));
    const todayDate   = fmt(new Date());
    let prev, todayOpen;
    if (lastBarDate === todayDate) {
      prev      = dailyBars[dailyBars.length - 2];
      todayOpen = dailyBars[dailyBars.length - 1].open;
    } else {
      prev      = dailyBars[dailyBars.length - 1];
      todayOpen = null;
    }
    return { pdHigh: prev.high, pdLow: prev.low, pdClose: prev.close, todayOpen };
  } catch { return null; }
}

const JS_DAILY_BARS = `
(function() {
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var series = chart.model().mainSeries();
    var bars = series.bars();
    if (!bars || typeof bars.lastIndex !== 'function') return null;
    var result = [];
    var end   = bars.lastIndex();
    var start = Math.max(bars.firstIndex(), end - 3);
    for (var i = start; i <= end; i++) {
      var v = bars.valueAt(i);
      if (v) result.push({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4] });
    }
    return result;
  } catch(e) { return null; }
})()`;

async function calcPreMarketLevels() {
  try {
    await evalOn(spyClient, `
      (function() {
        try {
          var api = window.TradingViewApi._activeChartWidgetWV.value();
          api.setResolution('1D');
        } catch(e) {}
      })()`);

    await new Promise(r => setTimeout(r, 2000));

    const dailyBars = await evalOn(spyClient, JS_DAILY_BARS);

    await evalOn(spyClient, `
      (function() {
        try {
          var api = window.TradingViewApi._activeChartWidgetWV.value();
          api.setResolution('1');
        } catch(e) {}
      })()`);

    await new Promise(r => setTimeout(r, 1500));

    if (!dailyBars || dailyBars.length < 2) return null;

    // Detect whether today's daily bar exists — TradingView may not create it until 09:30 ET.
    // Bar times are Unix seconds; compare to today's date in ET.
    const fmt = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
    const lastBarDate = fmt(new Date(dailyBars[dailyBars.length - 1].time * 1000));
    const todayDate   = fmt(new Date());
    let prev, todayOpen;
    if (lastBarDate === todayDate) {
      // Today's bar already exists — bars[-2] is yesterday
      prev      = dailyBars[dailyBars.length - 2];
      todayOpen = dailyBars[dailyBars.length - 1].open;
    } else {
      // No today bar yet (pre-09:30). bars[-1] IS yesterday; bars[-2] would be the day before.
      prev      = dailyBars[dailyBars.length - 1];
      todayOpen = null;   // unknown until market opens — re-fetched at 09:31
    }

    return {
      pdHigh:    prev.high,
      pdLow:     prev.low,
      pdClose:   prev.close,
      todayOpen,
    };
  } catch(e) {
    return null;
  }
}

function printPreMarketLevels(levels, currentPrice) {
  if (!levels) return;
  const line = '  ' + '─'.repeat(72);
  console.log(line);
  console.log(`  ${C.bold}PRE-MARKET LEVELS${C.reset}  (SPY)`);

  const fmt  = p => p != null ? `$${p.toFixed(2)}` : 'N/A';
  const side = (p, cur) => p != null ? (cur > p ? C.green + '  above' + C.reset : C.red + '  below' + C.reset) : '';

  console.log(`  PDH:        ${C.red}${fmt(levels.pdHigh)}${C.reset}${side(levels.pdHigh, currentPrice)}`);
  console.log(`  PDL:        ${C.green}${fmt(levels.pdLow)}${C.reset}${side(levels.pdLow, currentPrice)}`);
  console.log(`  PDC:        ${fmt(levels.pdClose)}${side(levels.pdClose, currentPrice)}`);
  console.log(`  Today Open: ${fmt(levels.todayOpen)}${side(levels.todayOpen, currentPrice)}`);
  console.log(line);
  console.log('');
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function shutdown() {
  console.log('\n\n  Shutting down...');
  try { if (stockClient) await stockClient.close(); } catch {}
  try { if (spyClient)   await spyClient.close();   } catch {}
  try { if (qqqClient)   await qqqClient.close();   } catch {}
  try { if (iwmClient)   await iwmClient.close();   } catch {}
  process.exit(0);
}

process.on('SIGINT', shutdown);

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold + '\n  Market Monitor — Starting up...' + C.reset);
  console.log(`  Watchlist:  ${STOCKS.join(', ')}`);
  console.log(`  QQQ tab:    ${QQQ_STOCKS.join(', ')}  (id=${QQQ_CHART_ID})`);
  console.log(`  IWM tab:    ${IWM_STOCKS.join(', ')}  (id=${IWM_CHART_ID})`);
  console.log(`  SPY:        read from separate "Claude SPY" tab`);
  console.log(`  Hours:      7:00 AM – 4:00 PM ET  |  Poll: ${POLL_MS / 1000}s`);
  console.log(`  Threshold:  ${THRESHOLD}/6 stocks + SPY  |  Near-zero delta: < ${NEAR_ZERO}`);
  console.log(`  S/R:        swing highs/lows over ${OHLCV_COUNT} bars + VWAP bands`);
  console.log(`  VRRS:       ±${VRRS_THRESH} threshold  |  Keys: VRRS_vs_Market + VRRS_vs_Sector  ✓ confirmed`);
  console.log(`  L2:         SPY · QQQ · IWM — order book imbalance (4th conviction factor)`);
  console.log(`  Trading:    ${process.env.TRADING_MODE || 'PAPER'} mode  |  Swing + Scalp engines wired → paperTrading.js`);
  if (PINE_PRIMARY) {
    console.log(`  ${C.cyan}Dispatch:   PINE_PRIMARY — chart-engine signals computed for audit only; Pine→webhook owns trade dispatch${C.reset}`);
    console.log(`  ${C.dim}            (SWING entries unaffected. Toggle: PINE_PRIMARY=false in env restores monitor dispatch.)${C.reset}\n`);
  } else {
    console.log(`  ${C.yellow}Dispatch:   PINE_PRIMARY=false — monitor dispatches chart-engine signals (legacy mode)${C.reset}\n`);
  }

  await initClients();
  console.log('');

  // Build per-instrument bar caches now that CDP clients are connected.
  // Each cache uses its own evalOn-bound client. Bootstrap pulls one fetch
  // per resolution (30S/5/60/240). 4H bootstrap takes ~1.5s due to flip.
  if (spyClient) barCache.SPY = createBarCache({ evalOn: (js) => evalOn(spyClient, js), instrumentLabel: 'SPY' });
  if (qqqClient) barCache.QQQ = createBarCache({ evalOn: (js) => evalOn(qqqClient, js), instrumentLabel: 'QQQ' });
  if (iwmClient) barCache.IWM = createBarCache({ evalOn: (js) => evalOn(iwmClient, js), instrumentLabel: 'IWM' });

  console.log('  Bootstrapping multi-TF bar caches (30S / 5M / 1H / 4H)...');
  for (const [sym, cache] of Object.entries(barCache)) {
    if (!cache) continue;
    try {
      const r = await cache.bootstrap();
      const status = cache.getCacheStatus();
      const summary = ['30S','5','60','240'].map(res => `${res}=${status[res]?.bars ?? '–'}`).join(' ');
      if (r.ok) {
        console.log(`  ${C.green}✓${C.reset} ${sym}: ${summary}`);
      } else {
        console.log(`  ${C.yellow}⚠${C.reset} ${sym}: ${summary} — missing: ${r.missing.join(',')}`);
        jAlert('warn', `${sym} bar bootstrap incomplete`, { missing: r.missing, status });
      }
    } catch (e) {
      console.error(`  ${C.red}✗${C.reset} ${sym} bar bootstrap failed: ${e.message}`);
      jError('bars-bootstrap-fatal', e.message, { instrument: sym });
    }
  }
  console.log('');

  // Re-hydrate activeSwing from ledger in case of restart mid-session
  try {
    const _lg = JSON.parse(readFileSync(join(__dirname, 'paper-ledger.json'), 'utf8'));
    for (const inst of ['SPY', 'QQQ', 'IWM']) {
      const _sw = _lg.trades?.find(t => t.instrument === inst && t.engine === 'SWING' && t.status === 'OPEN');
      if (_sw) { activeSwing[inst] = { requestId: _sw.requestId, status: 'OPEN' }; console.log(`  [SWING] Re-hydrated open ${inst} swing — reqId ${_sw.requestId}`); }
    }
  } catch {}

  console.log('  Calculating pre-market levels...');
  const preMarketLevels = await calcPreMarketLevels();
  if (preMarketLevels) {
    global.preMarketLevels = preMarketLevels;
    const spyQuote = await evalOn(spyClient, JS_QUOTE).catch(() => null);
    const curPrice = spyQuote?.close ?? spyQuote?.last ?? null;
    printPreMarketLevels(preMarketLevels, curPrice);
  } else {
    console.log('  Pre-market levels unavailable — will use live S/R only\n');
  }

  // Pre-market levels for QQQ and IWM (parallel — don't block SPY)
  if (qqqClient) {
    calcPreMarketLevelsForClient(qqqClient).then(levels => {
      if (levels) {
        global.qqqPreMarketLevels = levels;
        const openStr = levels.todayOpen != null ? `$${levels.todayOpen.toFixed(2)}` : '(pending 09:31)';
        console.log(`  ${C.dim}QQQ pre-market: PDH $${levels.pdHigh.toFixed(2)}  PDL $${levels.pdLow.toFixed(2)}  Open ${openStr}${C.reset}`);
      }
    }).catch(() => {});
  }
  if (iwmClient) {
    calcPreMarketLevelsForClient(iwmClient).then(levels => {
      if (levels) {
        global.iwmPreMarketLevels = levels;
        const openStr = levels.todayOpen != null ? `$${levels.todayOpen.toFixed(2)}` : '(pending 09:31)';
        console.log(`  ${C.dim}IWM pre-market: PDH $${levels.pdHigh.toFixed(2)}  PDL $${levels.pdLow.toFixed(2)}  Open ${openStr}${C.reset}`);
      }
    }).catch(() => {});
  }

  await poll();
  setInterval(async () => {
    try { await poll(); }
    catch (e) { console.error(`\n  Poll error: ${e.message}`); }
  }, POLL_MS);
}

main().catch(async e => {
  console.error('\n  Fatal:', e.message);
  console.error('  Stack:', e.stack);
  await shutdown();
});
