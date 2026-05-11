#!/usr/bin/env node
/**
 * monitor-iwm.js — QQQ + W3 continuous market monitor
 * Built by NYC2000
 *
 * Standalone monitor — runs in its own CMD window.
 * Identical layout to monitor.js (SPY) but scoped to QQQ tab.
 *
 * Every 30s (7:00 AM – 4:00 PM ET):
 *   - Reads VWAP + Volume Delta + VRRS for QQQ, AMD, AVGO, TSLA, ARM, NVDA (W3)
 *   - Reads QQQ instrument: VWAP + Delta + VRRS + OHLCV + $TICK
 *   - Detects swing-high resistance + swing-low support + VWAP bands
 *   - Draws S/R lines on all panes
 *   - Fires CALLS/PUTS when 4+/5 W3 stocks agree + IWM confirms
 *   - HANK LIVE ANALYSIS every 30s via Claude API
 *   - Swing Engine: ATR-based entry at 09:30, 2.5:1 R:R
 *   - Paper trading: sendOrder() → paper-ledger.json
 *
 * Prerequisites:
 *   - TradingView running with --remote-debugging-port=9222
 *   - Claude QQQ tab open (QQQ, AMD, AVGO, TSLA, ARM, NVDA + VWAP + Volume Delta + VRRS + Tick)
 *
 * Usage: node monitor-iwm.js
 */

import CDP                        from 'chrome-remote-interface';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath }          from 'url';
import { dirname, join }          from 'path';
import { jPoll, jSignal, jGateBlock, jAlert, jError } from './journal.js';
import { createBarCache } from './bars.js';
import { chartStructureEngine } from './chartStructure.js';
import { analyze4H, analyze1H } from './analyze.js';
import {
  applyMultipliers, readDailyBiasRegime, gate1H,
  HIERARCHY_V2, CHART_ENGINE_SET,
  computeBoosterAdj, gateMacro4H, gateVwap,
} from './signalConfidence.js';
import { scanTriggers, runEntryEngines } from './triggerScans.js';
import { buildDrawJS }    from './chartDraws.js';
import { loadFVGState }   from './fvg.js';
import { loadSweepState } from './sweep.js';

// Paper trading — degrades gracefully if unavailable
let sendOrder = null, closePosition = null, orderGate = null, sessionReset = null, printScorecard = null;
try {
  const pt = await import('./paperTrading.js');
  sendOrder = pt.sendOrder; closePosition = pt.closePosition;
  orderGate = pt.orderGate; sessionReset = pt.sessionReset; printScorecard = pt.printScorecard;
  console.log(`  [TRADE] paperTrading.js loaded — mode: ${process.env.TRADING_MODE || 'PAPER'}`);
} catch (e) { console.log(`  [TRADE] not loaded — trading disabled`); }

let selectContract = null;
try {
  const wb = await import('./webull.js');
  selectContract = wb.selectContract;
} catch (e) { /* degrades gracefully — ATR pricing still works */ }

// Active swing position tracker
const activeSwing = { IWM: { requestId: null, status: null } };

// ─── Config ───────────────────────────────────────────────────────────────────

const __dirname    = dirname(fileURLToPath(import.meta.url));
const rules        = JSON.parse(readFileSync(join(__dirname, 'rules.json'), 'utf8'));
const cfg          = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));

const INSTRUMENT   = 'IWM';
const COMPONENTS   = ['BE', 'CRDO', 'FN'];  // Mag-3 stocks
const ALL_STOCKS   = ['IWM', ...COMPONENTS];
const CHART_ID     = cfg.iwmChartId ?? 'Jo9vWQ37';
const LEVELS_FILE  = join(__dirname, 'iwm-levels.json');

const POLL_MS      = 30_000;
const THRESHOLD    = 2          // 2/3 components + IWM confirms;          // 3/5 components + IWM confirms
const COOLDOWN     = POLL_MS * 3;
const NEAR_ZERO    = parseInt((rules.delta_thresholds?.near_zero ?? '50').toString().replace(/\D/g,''), 10) || 50;
const OHLCV_COUNT  = 120;
const SWING_PERIOD = 5;
const CLUSTER_PCT  = 0.15;
const VRRS_THRESH  = 0.15;

function parseNearZero(str) {
  if (!str) return null;
  const n = parseInt(str.toString().replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? null : n;
}

// ─── CDP client ───────────────────────────────────────────────────────────────

let client = null;

// Multi-TF bar cache — created after initClient(). Strategy engines call
// barCache.get('5'|'60'|'240') and refuse to trade when null is returned.
let barCache = null;

async function evalOn(expression) {
  const result = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: false });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'JS error');
  return result.result?.value;
}

async function initClient() {
  const resp    = await fetch('http://localhost:9222/json/list');
  const targets = await resp.json();
  const charts  = targets.filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));

  console.log(`  Found ${charts.length} TradingView tab(s) — looking for IWM tab (id=${CHART_ID})...`);

  let target = charts.find(t => t.url.includes(CHART_ID));
  if (!target) {
    // Fallback: probe each tab for QQQ symbol
    for (const t of charts) {
      try {
        const c   = await CDP({ host: 'localhost', port: 9222, target: t.id });
        await c.Runtime.enable();
        const sym = await c.Runtime.evaluate({ expression: `(function(){ try { return window.TradingViewApi._activeChartWidgetWV.value().symbol(); } catch(e){ return ''; } })()`, returnByValue: true });
        if (/iwm/i.test(sym.result?.value ?? '')) { target = t; await c.close(); break; }
        await c.close();
      } catch {}
    }
  }

  if (!target) throw new Error(`IWM tab not found. Open the Claude IWM tab in TradingView.`);

  client = await CDP({ host: 'localhost', port: 9222, target: target.id });
  await client.Runtime.enable();
  console.log(`  IWM tab connected: ${target.url.split('/chart/')[1]?.replace('/', '')}`);
}

// ─── JS expressions ───────────────────────────────────────────────────────────

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
      var isTarget = name.includes('VRRS') || name.includes('VWRS')
                  || name.includes('VOLUME WEIGHTED REAL')
                  || name.includes('VOLUME WEIGHTED AVERAGE')
                  || name.includes('VWAP')
                  || name === 'VOLUME DELTA'
                  || name.includes('NYSE') || name.includes('NASDAQ TICK') || name.includes('NY/NQ');
      if (!isTarget) continue;
      var values = {};
      try {
        var dwv = s.dataWindowView ? s.dataWindowView() : null;
        if (dwv) {
          var items = dwv.items ? dwv.items() : [];
          for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (item._value && item._value !== '\u2205' && item._title)
              values[item._title.replace(/[^a-zA-Z0-9]/g, '_')] = item._value;
          }
        }
      } catch(e2) {}
      if (Object.keys(values).length > 0) results.push({ name: rawName, values: values });
    } catch(e) {}
  }
  return results;
})()`;

const JS_QUOTE = `
(function() {
  try {
    var api = window.TradingViewApi._activeChartWidgetWV.value();
    var sym = ''; try { sym = api.symbol(); } catch(e) {}
    var bars = api._chartWidget.model().mainSeries().bars();
    if (bars && typeof bars.lastIndex === 'function') {
      var last = bars.valueAt(bars.lastIndex());
      if (last) return { symbol: sym, last: last[4], open: last[1], high: last[2], low: last[3], close: last[4] };
    }
    return { symbol: sym };
  } catch(e) { return { error: e.message }; }
})()`;

const JS_OHLCV = `
(function() {
  try {
    var bars = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
    if (!bars || typeof bars.lastIndex !== 'function') return null;
    var result = [], end = bars.lastIndex(), start = Math.max(bars.firstIndex(), end - ${OHLCV_COUNT} + 1);
    for (var i = start; i <= end; i++) {
      var v = bars.valueAt(i);
      if (v) result.push({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0 });
    }
    return result;
  } catch(e) { return null; }
})()`;

const JS_PANE_LIST = `
(function() {
  var all = window.TradingViewApi._chartWidgetCollection.getAll();
  var result = [];
  for (var i = 0; i < all.length; i++) {
    try {
      var m = all[i].model ? all[i].model() : null;
      var ms = m ? m.mainSeries() : null;
      result.push({ index: i, symbol: ms ? ms.symbol() : null });
    } catch(e) { result.push({ index: i, symbol: null }); }
  }
  return result;
})()`;

function JS_FOCUS_PANE(index) {
  return `(function(){ var all=window.TradingViewApi._chartWidgetCollection.getAll(); if(!all[${index}]) return false; if(all[${index}]._mainDiv) all[${index}]._mainDiv.click(); return true; })()`;
}

function JS_DRAW_LEVELS(lastBarTime, levels) {
  const api   = `window.TradingViewApi._activeChartWidgetWV.value()`;
  const draws = levels.map(l => {
    const color = l.type === 'support' ? '#00BB44' : '#CC2200';
    const label = l.label.replace(/'/g, '');
    return `  try { api.createShape({ time: ${lastBarTime}, price: ${l.price.toFixed(6)} }, { shape: 'horizontal_line', overrides: { linecolor: '${color}', linewidth: 1, linestyle: 0, showLabel: true, text: '${label}' } }); } catch(e) {}`;
  }).join('\n');
  return `(function(){ try { var api=${api}; api.removeAllShapes(); } catch(e) {}\n${draws}\n})()`;
}

const JS_DAILY_BARS = `
(function() {
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var bars  = chart.model().mainSeries().bars();
    if (!bars || typeof bars.lastIndex !== 'function') return null;
    var result = [], end = bars.lastIndex(), start = Math.max(bars.firstIndex(), end - 3);
    for (var i = start; i <= end; i++) {
      var v = bars.valueAt(i);
      if (v) result.push({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4] });
    }
    return result;
  } catch(e) { return null; }
})()`;

// ─── S/R detection ────────────────────────────────────────────────────────────

function clusterLevels(prices) {
  const sorted = [...prices].sort((a, b) => b - a);
  const result = [];
  for (const p of sorted) {
    if (!result.some(r => Math.abs(r - p) / p < CLUSTER_PCT / 100)) result.push(p);
  }
  return result;
}

function detectLevels(bars, currentPrice, vwap, upperBand, lowerBand, isEtf = false) {
  const support = [], resistance = [];

  if (vwap != null) {
    if (currentPrice > vwap) support.push({ price: vwap, label: 'VWAP', type: 'support' });
    else resistance.push({ price: vwap, label: 'VWAP', type: 'resistance' });
  }
  if (upperBand != null) resistance.push({ price: upperBand, label: 'VWAP+1σ', type: 'resistance' });
  if (lowerBand != null) support.push({ price: lowerBand, label: 'VWAP-1σ', type: 'support' });

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
    clusterLevels(swingHighs).filter(p => p > currentPrice).sort((a,b)=>a-b).slice(0,3)
      .forEach(p => resistance.push({ price: p, label: 'SH', type: 'resistance' }));
    clusterLevels(swingLows).filter(p => p < currentPrice).sort((a,b)=>b-a).slice(0,3)
      .forEach(p => support.push({ price: p, label: 'SL', type: 'support' }));
  }

  // Pre-market levels — ETF pane only, not components
  if (isEtf && global.preMarketLevels) {
    const { pdHigh, pdLow, todayOpen } = global.preMarketLevels;
    if (pdHigh != null)    resistance.push({ price: pdHigh, label: 'PDH', type: 'resistance' });
    if (pdLow  != null)    support.push(   { price: pdLow,  label: 'PDL', type: 'support' });
    if (todayOpen != null) {
      if (currentPrice > todayOpen) support.push({ price: todayOpen, label: 'Open', type: 'support' });
      else resistance.push({ price: todayOpen, label: 'Open', type: 'resistance' });
    }
  }

  const roundFloor = Math.floor(currentPrice);
  if (!support.some(s => s.price < currentPrice)) {
    for (let i = 0; i >= -5; i--) { const l = roundFloor + i; if (l < currentPrice) { support.push({ price: l, label: 'R#', type: 'support' }); break; } }
  }
  if (!resistance.some(r => r.price > currentPrice)) {
    for (let i = 1; i <= 5; i++) { const l = roundFloor + i; if (l > currentPrice) { resistance.push({ price: l, label: 'R#', type: 'resistance' }); break; } }
  }

  support.sort((a,b) => b.price - a.price);
  resistance.sort((a,b) => a.price - b.price);
  return { support: support.slice(0,4), resistance: resistance.slice(0,4) };
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function parseDelta(str) {
  if (str == null) return null;
  let s = str.toString().replace(/,/g,'').replace(/\u2212/g,'-').trim();
  let mult = 1;
  if (/K$/i.test(s)) { mult = 1_000;     s = s.slice(0,-1); }
  if (/M$/i.test(s)) { mult = 1_000_000; s = s.slice(0,-1); }
  const n = parseFloat(s);
  return isNaN(n) ? null : n * mult;
}

function parsePrice(str) {
  if (str == null) return null;
  const n = parseFloat(str.toString().replace(/,/g,''));
  return isNaN(n) ? null : n;
}

function parseValues(studies) {
  let vwap = null, delta = null, upperBand = null, lowerBand = null;
  let vrrs = null, vrrsSector = null, vrrsChangeRate = null, tick = null;

  for (const s of (studies || [])) {
    const n = (s.name ?? '').toUpperCase();
    if (n.includes('VOLUME WEIGHTED AVERAGE') || n.includes('VWAP')) {
      vwap      = parsePrice(s.values?.VWAP);
      upperBand = parsePrice(s.values?.Upper_Band__1);
      lowerBand = parsePrice(s.values?.Lower_Band__1);
    }
    if (n === 'VOLUME DELTA') delta = parseDelta(s.values?.Volume_Delta);
    if (n.includes('VOLUME WEIGHTED REAL RELATIVE')) {
      vrrs          = parsePrice(s.values?.VRRS_vs_Market);
      vrrsSector    = parsePrice(s.values?.VRRS_vs_Sector);
      vrrsChangeRate = parsePrice(s.values?.Reference_Change);
    }
    if (n.includes('NYSE') || n.includes('NASDAQ TICK') || n.includes('NY/NQ')) {
      tick = parsePrice(s.values?.Plot ?? s.values?.PlotCandle);
    }
  }
  return { vwap, delta, upperBand, lowerBand, vrrs, vrrsSector, vrrsChangeRate, tick };
}

// ─── Bias classification ──────────────────────────────────────────────────────

function classify(price, vwap, delta, vrrs, vrrsSector) {
  if (price == null || vwap == null || delta == null) return 'unknown';
  if (Math.abs(delta) < NEAR_ZERO) return 'neutral';
  const up = price > vwap, pos = delta > 0;
  let bias = up && pos ? 'bullish' : !up && !pos ? 'bearish' : up && !pos ? 'div_bear' : 'div_bull';
  if (vrrs != null) {
    const sectorOk = vrrsSector == null || Math.sign(vrrs) === Math.sign(vrrsSector);
    if (vrrs >= VRRS_THRESH  && sectorOk && bias === 'div_bull') return 'bullish';
    if (vrrs <= -VRRS_THRESH && sectorOk && bias === 'div_bear') return 'bearish';
    if (vrrs <= -VRRS_THRESH && sectorOk && bias === 'bullish')  return 'div_bear';
    if (vrrs >= VRRS_THRESH  && sectorOk && bias === 'bearish')  return 'div_bull';
  }
  return bias;
}

// ─── Read + Draw ──────────────────────────────────────────────────────────────

async function readAndDrawPane(isEtf = false) {
  const [studies, quote, bars] = await Promise.all([
    evalOn(JS_STUDY_VALUES), evalOn(JS_QUOTE), evalOn(JS_OHLCV),
  ]);
  const price = quote?.last ?? quote?.close ?? null;
  const { vwap, delta, upperBand, lowerBand, vrrs, vrrsSector, vrrsChangeRate, tick } = parseValues(studies);
  const levels = (price != null && bars?.length)
    ? detectLevels(bars, price, vwap, upperBand, lowerBand, isEtf)
    : { support: [], resistance: [] };
  // Chart drawing moved to poll() — see drawChartAnnotations() so the
  // call layers FVG/S-D/sweeps/displacement on top of levels in one shot.
  return { price, vwap, delta, vrrs, vrrsSector, vrrsChangeRate, tick, levels, bars };
}

async function drawChartAnnotations(levels) {
  if (!barCache || !client) return;
  try {
    const [bars5M, bars1H, bars4H] = await Promise.all([
      barCache.get('5'), barCache.get('60'), barCache.get('240'),
    ]);
    if (!bars5M || !bars5M.length) return;
    const fvgState   = loadFVGState('IWM');
    const sweepState = loadSweepState('IWM');
    const allLevels  = [...(levels?.support ?? []), ...(levels?.resistance ?? [])];
    const { js } = buildDrawJS({
      instrument: 'IWM', bars5M, bars1H, bars4H,
      levels: allLevels, fvgState, sweepState,
    });
    // awaitPromise:true: see chartDraws.js for rationale.
    if (js) await client.Runtime.evaluate({ expression: js, returnByValue: true, awaitPromise: true });
  } catch (e) {
    jError('chart-draw', e.message, { instrument: 'IWM' });
  }
}

async function buildPaneMap() {
  const panes = await evalOn(JS_PANE_LIST);
  const map = {};
  for (const p of (panes || [])) {
    if (!p.symbol) continue;
    const base = p.symbol.split(':').pop().replace(/[0-9!]+$/, '').toUpperCase();
    if (base) map[base] = p.index;
  }
  return map;
}

async function readPane(paneIndex) {
  await evalOn(JS_FOCUS_PANE(paneIndex));
  await sleep(350);
  return readAndDrawPane(false);
}

async function readEtf() {
  await evalOn(JS_FOCUS_PANE(0));
  await sleep(350);
  return readAndDrawPane(true);
}

// ─── Colors ───────────────────────────────────────────────────────────────────

const C = {
  reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
  red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m',
  cyan:'\x1b[36m', gray:'\x1b[90m', white:'\x1b[97m',
  bgGreen:'\x1b[42m\x1b[30m', bgRed:'\x1b[41m\x1b[97m', bgYellow:'\x1b[43m\x1b[30m',
};

function biasTag(b) {
  switch(b) {
    case 'bullish':  return C.green  + ' BULL ' + C.reset;
    case 'bearish':  return C.red    + ' BEAR ' + C.reset;
    case 'neutral':  return C.gray   + ' NTRL ' + C.reset;
    case 'div_bear': return C.yellow + ' DIV- ' + C.reset;
    case 'div_bull': return C.cyan   + ' DIV+ ' + C.reset;
    default:         return C.gray   + '  ?   ' + C.reset;
  }
}

let _lastGoodLedgerIWM = null;

function printPaperPanel(divLine) {
  try {
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(join(__dirname, 'paper-ledger.json'), 'utf8'));
    _lastGoodLedgerIWM = ledger;
  } catch {
    ledger = _lastGoodLedgerIWM;
    if (!ledger) {
      console.log(divLine);
      console.log(`  ${C.bold}PAPER TRADING${C.reset}  ${C.gray}ledger unavailable${C.reset}`);
      return;
    }
  }

  const today   = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const fmtET   = ts => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ts));

  // Filter to this monitor's instrument only
  const myTrades = (ledger.trades ?? []).filter(t => t.instrument === INSTRUMENT);
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
    `  ${INSTRUMENT} Today: ${todayCol}${myTodayPnL >= 0 ? '+' : ''}$${myTodayPnL.toFixed(0)}${C.reset}` +
    `  ${INSTRUMENT} P&L: ${totalCol}${myAllPnL >= 0 ? '+' : ''}$${myAllPnL.toFixed(0)}${C.reset}` +
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
    console.log(`  ${C.dim}No open ${INSTRUMENT} positions${C.reset}`);
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

function fmtPrice(n)  { return n != null ? n.toFixed(2).padStart(9) : '      N/A'; }
function fmtDelta(n)  {
  if (n == null) return '      N/A';
  const sign = n >= 0 ? '+' : '-';
  const abs  = Math.abs(n);
  let s = abs >= 1_000_000 ? (abs/1_000_000).toFixed(2)+'M' : abs >= 1_000 ? (abs/1_000).toFixed(1)+'K' : Math.round(abs).toString();
  return (sign + s).padStart(9);
}
function fmtVrrs(vrrs, sect) {
  if (vrrs == null) return C.gray + '   N/A' + C.reset;
  const col = vrrs >= VRRS_THRESH ? C.green : vrrs <= -VRRS_THRESH ? C.red : C.gray;
  const sym = sect != null ? (Math.sign(vrrs) === Math.sign(sect) ? C.dim+'✓' : C.yellow+'÷') + C.reset : ' ';
  return col + vrrs.toFixed(2).padStart(6) + C.reset + sym;
}

function getETString() {
  return new Date().toLocaleTimeString('en-US', { timeZone:'America/New_York', hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
}

function isMarketHours() {
  const t = new Date().toLocaleTimeString("en-US", { timeZone:"America/New_York", hour12:false, hour:"2-digit", minute:"2-digit" });
  const [h, m] = t.split(":").map(Number);
  return (h * 60 + m) >= 7 * 60 && (h * 60 + m) < 16 * 60;
}

function isTradingHours() {
  const t = new Date().toLocaleTimeString("en-US", { timeZone:"America/New_York", hour12:false, hour:"2-digit", minute:"2-digit" });
  const [h, m] = t.split(":").map(Number);
  return (h * 60 + m) >= 9 * 60 + 30 && (h * 60 + m) < 15 * 60 + 45;
}

let lastOutsideMsg = 0;
function printOutsideHours() {
  if (Date.now() - lastOutsideMsg < 60 * 60 * 1000) return;
  lastOutsideMsg = Date.now();
  console.log(`  ${C.gray}Outside market hours (${getETString()} ET) — next session at 07:00 ET${C.reset}`);
}

// ─── EMA9 ─────────────────────────────────────────────────────────────────────

function computeEMA9(bars) {
  if (!bars?.length) return null;
  const closes = bars.map(b => b.close);
  const k = 2 / 10;
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

// ─── Swing Engine ─────────────────────────────────────────────────────────────

const SwingEngine = (() => {
  const SYNTH=6, ATR_P=14, STOP_M=1.0, TGT_M=2.5;
  let state = { status:'WAITING', direction:null, entry:null, stop:null, target:null, atr:null, entryTime:null, exitPrice:null, exitReason:null, pnl:null, pnlPct:null, openedToday:false };
  let consumed = false;

  function etMins() {
    const t = new Date().toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:false,hour:'2-digit',minute:'2-digit'});
    const [h,m] = t.split(':').map(Number); return h*60+m;
  }
  function isClose()   { return etMins() >= 15*60+45; }
  function isOpening() { const m=etMins(); return m>=9*60+29&&m<=9*60+55; }

  function synthCandles(bars) {
    const r=[];
    for(let i=0;i+SYNTH<=bars.length;i+=SYNTH){
      const c=bars.slice(i,i+SYNTH);
      r.push({open:c[0].open,high:Math.max(...c.map(b=>b.high)),low:Math.min(...c.map(b=>b.low)),close:c[c.length-1].close});
    }
    return r;
  }

  function atr(candles) {
    if(candles.length<2) return null;
    const trs=[];
    for(let i=1;i<candles.length;i++) trs.push(Math.max(candles[i].high-candles[i].low,Math.abs(candles[i].high-candles[i-1].close),Math.abs(candles[i].low-candles[i-1].close)));
    if(trs.length<ATR_P) return trs.reduce((a,b)=>a+b,0)/trs.length;
    let a_=trs.slice(0,ATR_P).reduce((a,b)=>a+b,0)/ATR_P;
    for(let i=ATR_P;i<trs.length;i++) a_=(a_*(ATR_P-1)+trs[i])/ATR_P;
    return a_;
  }

  function update(price, vwap, ema9, bars) {
    if(!price||!bars?.length) return state;
    if((state.status==='LONG'||state.status==='SHORT')&&isClose()) {
      state.exitPrice=price; state.exitReason='EOD';
      state.pnl=state.status==='LONG'?price-state.entry:state.entry-price;
      state.pnlPct=(state.pnl/state.entry)*100; state.status='CLOSED';
      console.log(`\n  ${C.bgYellow}  ⏰ IWM SWING EOD  ${C.reset}  ${state.direction} $${price.toFixed(2)}  ${state.pnl>=0?C.green:C.red}${state.pnl>=0?'+':''}$${state.pnl.toFixed(2)}${C.reset}`);
      return state;
    }
    if(state.status==='LONG') {
      if(price>=state.target){state.exitPrice=state.target;state.exitReason='TARGET';state.pnl=state.target-state.entry;state.pnlPct=(state.pnl/state.entry)*100;state.status='CLOSED';process.stdout.write('\x07\x07\x07');console.log(`\n  ${C.bgGreen}  ✅ IWM TARGET  ${C.reset}  ${C.green}+$${state.pnl.toFixed(2)}${C.reset}`);return state;}
      if(price<=state.stop){state.exitPrice=state.stop;state.exitReason='STOP';state.pnl=state.stop-state.entry;state.pnlPct=(state.pnl/state.entry)*100;state.status='CLOSED';process.stdout.write('\x07\x07');console.log(`\n  ${C.bgRed}  🛑 IWM STOP  ${C.reset}  ${C.red}$${state.pnl.toFixed(2)}${C.reset}`);return state;}
      if(vwap!=null&&price<vwap){state.exitPrice=price;state.exitReason='TREND_EXIT';state.pnl=price-state.entry;state.pnlPct=(state.pnl/state.entry)*100;state.status='CLOSED';console.log(`\n  ${C.bgYellow}  ⚠️  IWM TREND EXIT  ${C.reset}  ${state.pnl>=0?C.green:C.red}${state.pnl>=0?'+':''}$${state.pnl.toFixed(2)}${C.reset}`);return state;}
    }
    if(state.status==='SHORT') {
      if(price<=state.target){state.exitPrice=state.target;state.exitReason='TARGET';state.pnl=state.entry-state.target;state.pnlPct=(state.pnl/state.entry)*100;state.status='CLOSED';process.stdout.write('\x07\x07\x07');console.log(`\n  ${C.bgGreen}  ✅ IWM TARGET  ${C.reset}  ${C.green}+$${state.pnl.toFixed(2)}${C.reset}`);return state;}
      if(price>=state.stop){state.exitPrice=state.stop;state.exitReason='STOP';state.pnl=state.entry-state.stop;state.pnlPct=(state.pnl/state.entry)*100;state.status='CLOSED';process.stdout.write('\x07\x07');console.log(`\n  ${C.bgRed}  🛑 IWM STOP  ${C.reset}  ${C.red}$${state.pnl.toFixed(2)}${C.reset}`);return state;}
      if(vwap!=null&&price>vwap){state.exitPrice=price;state.exitReason='TREND_EXIT';state.pnl=state.entry-price;state.pnlPct=(state.pnl/state.entry)*100;state.status='CLOSED';console.log(`\n  ${C.bgYellow}  ⚠️  IWM TREND EXIT  ${C.reset}  ${state.pnl>=0?C.green:C.red}${state.pnl>=0?'+':''}$${state.pnl.toFixed(2)}${C.reset}`);return state;}
    }
    if(state.status==='WAITING'&&!state.openedToday&&isOpening()&&!consumed&&bars.length>0&&vwap!=null&&ema9!=null) {
      consumed=true;
      const sc=synthCandles(bars), a_=Math.max(atr(sc)??(price*0.001),0.10);
      const bull=price>vwap&&price>ema9, bear=price<vwap&&price<ema9;
      if(bull){state={...state,status:'LONG',direction:'LONG',entry:price,atr:a_,stop:parseFloat((price-a_*STOP_M).toFixed(2)),target:parseFloat((price+a_*TGT_M).toFixed(2)),entryTime:getETString(),openedToday:true};process.stdout.write('\x07');console.log(`\n  ${C.bgGreen}  📈 IWM SWING LONG  ${C.reset}  $${price.toFixed(2)}  Stop $${state.stop}  Target $${state.target}`);}
      else if(bear){state={...state,status:'SHORT',direction:'SHORT',entry:price,atr:a_,stop:parseFloat((price+a_*STOP_M).toFixed(2)),target:parseFloat((price-a_*TGT_M).toFixed(2)),entryTime:getETString(),openedToday:true};process.stdout.write('\x07');console.log(`\n  ${C.bgRed}  📉 IWM SWING SHORT  ${C.reset}  $${price.toFixed(2)}  Stop $${state.stop}  Target $${state.target}`);}
      else{consumed=false;console.log(`  ${C.gray}[IWM SWING] No clear bias at open — watching...${C.reset}`);}
    }
    if(etMins()<5&&state.openedToday&&state.status==='CLOSED'){state={status:'WAITING',direction:null,entry:null,stop:null,target:null,atr:null,entryTime:null,exitPrice:null,exitReason:null,pnl:null,pnlPct:null,openedToday:false};consumed=false;}
    return state;
  }
  return { update, getState: ()=>state };
})();

// ─── Signal builder ───────────────────────────────────────────────────────────

function buildSignal(compRows, etf, summary) {
  const bullish = etf?.bias === 'bullish', bearish = etf?.bias === 'bearish';
  const approachingSup = summary?.distSup != null && summary.distSup < 0.10;
  const approachingRes = summary?.distRes != null && summary.distRes < 0.10;
  const breakdown = summary?.status?.includes('BELOW SUPPORT');
  const breakout  = summary?.status?.includes('ABOVE RESISTANCE');

  const etfVrrsBull = etf?.vrrs != null && etf.vrrs >= VRRS_THRESH && (etf.vrrsSector==null||etf.vrrsSector>=0);
  const etfVrrsBear = etf?.vrrs != null && etf.vrrs <= -VRRS_THRESH && (etf.vrrsSector==null||etf.vrrsSector<=0);

  const compBulls = compRows.filter(r=>r.bias==='bullish'||(r.bias==='div_bear'&&r.delta>-1000)).length;
  const compBears = compRows.filter(r=>r.bias==='bearish'||(r.bias==='div_bull'&&r.delta<1000)).length;
  const total     = compRows.length;
  const heavyDiv  = compRows.filter(r=>r.bias==='div_bear'&&r.delta<-1000).length;
  const isChop    = heavyDiv >= Math.ceil(total*0.5) && compBulls < 2 && compBears < 2;
  const vrrsNote  = etf?.vrrs != null ? ` | VRRS ${etf.vrrs.toFixed(2)}` : '';

  if (isChop) return { action:'CHOP — STAY OUT 🟡', confidence:'NONE', reason:'Heavy DIV- flow', bulls:compBulls, bears:compBears, total };
  if (compBulls >= THRESHOLD && bullish && etfVrrsBull && (approachingSup||breakout))
    return { action:'TAKE CALLS 🟢', confidence:'HIGH', reason:`${compBulls}/${total} BULL + IWM bullish${vrrsNote} + ${breakout?'breakout':'near support'}`, bulls:compBulls, bears:compBears, total };
  if (compBears >= THRESHOLD && bearish && etfVrrsBear && (approachingRes||breakdown))
    return { action:'TAKE PUTS 🔴', confidence:'HIGH', reason:`${compBears}/${total} BEAR + IWM bearish${vrrsNote} + ${breakdown?'breakdown':'near resistance'}`, bulls:compBulls, bears:compBears, total };
  if (compBulls >= THRESHOLD && bullish) return { action:'TAKE CALLS 🟢', confidence:'MEDIUM', reason:`${compBulls}/${total} BULL + IWM bullish${vrrsNote}`, bulls:compBulls, bears:compBears, total };
  if (compBears >= THRESHOLD && bearish) return { action:'TAKE PUTS 🔴', confidence:'MEDIUM', reason:`${compBears}/${total} BEAR + IWM bearish${vrrsNote}`, bulls:compBulls, bears:compBears, total };
  if (compBulls >= THRESHOLD) return { action:'CALLS — WAIT ⚠️', confidence:'WEAK', reason:`${compBulls}/${total} BULL but IWM not confirming (${etf?.bias})`, bulls:compBulls, bears:compBears, total };
  if (compBears >= THRESHOLD) return { action:'PUTS — WAIT ⚠️', confidence:'WEAK', reason:`${compBears}/${total} BEAR but IWM not confirming (${etf?.bias})`, bulls:compBulls, bears:compBears, total };
  return { action:'NEUTRAL — WAIT ⬜', confidence:'NONE', reason:`Mixed (BULL ${compBulls}/${total}  BEAR ${compBears}/${total})`, bulls:compBulls, bears:compBears, total };
}

// ─── SPY-style summary builder ────────────────────────────────────────────────

function buildSummary(etf) {
  if (!etf?.price || !etf?.levels) return null;
  const { support, resistance } = etf.levels;
  const trendDir  = etf.price > (etf.vwap ?? etf.price) ? 'Bullish' : 'Bearish';
  const vwapDist  = etf.vwap != null ? (etf.price - etf.vwap).toFixed(2) : null;
  const trendDetail = etf.vwap != null
    ? `${trendDir==='Bullish'?'above':'below'} VWAP $${etf.vwap.toFixed(2)} (${vwapDist>0?'+':''}${vwapDist})`
    : trendDir;
  const nearRes = resistance.find(r => r.price > etf.price);
  const nearSup = support.find(s => s.price < etf.price);
  const distRes = nearRes ? ((nearRes.price - etf.price) / etf.price * 100) : null;
  const distSup = nearSup ? ((etf.price - nearSup.price) / etf.price * 100) : null;
  let status;
  if      (nearRes && distRes != null && distRes < 0.05) status = `Approaching resistance $${nearRes.price.toFixed(2)} (${nearRes.label})`;
  else if (nearSup && distSup != null && distSup < 0.05) status = `Approaching support $${nearSup.price.toFixed(2)} (${nearSup.label})`;
  else if (nearRes && nearSup) status = `Mid-range between support $${nearSup.price.toFixed(2)} and resistance $${nearRes.price.toFixed(2)}`;
  else if (!nearSup && nearRes) status = `⚠️  BELOW SUPPORT — next resistance $${nearRes.price.toFixed(2)} (${nearRes.label})`;
  else if (nearSup && !nearRes) status = `⚠️  ABOVE RESISTANCE — next support $${nearSup.price.toFixed(2)} (${nearSup.label})`;
  else status = 'Insufficient level data';
  return { trendDir, trendDetail, nearRes, nearSup, distRes, distSup, status };
}

// ─── HANK LIVE ANALYSIS ───────────────────────────────────────────────────────

const analysisCache = new Map();
const ANALYSIS_STALE = 60_000;

async function fetchAnalysis(etf, compRows, swingState, summary) {
  const hash = `${etf.price?.toFixed(0)}_${etf.bias}_${compRows.filter(r=>r.bias==='bullish').length}_${compRows.filter(r=>r.bias==='bearish').length}`;
  const cached = analysisCache.get('IWM');
  if (cached && cached.hash === hash && Date.now() - cached.ts < ANALYSIS_STALE) return cached.text;

  const comps   = compRows.map(r=>`${r.symbol}(${r.bias})`).join(', ');
  const swingL  = swingState?.status==='LONG'  ? `Swing LONG $${swingState.entry?.toFixed(2)}, target $${swingState.target}, stop $${swingState.stop}.`
                : swingState?.status==='SHORT' ? `Swing SHORT $${swingState.entry?.toFixed(2)}, target $${swingState.target}, stop $${swingState.stop}.`
                : swingState?.status==='CLOSED'? `Swing closed ${swingState.exitReason} P&L $${swingState.pnl?.toFixed(2)}.`
                : 'Swing waiting for 09:30.';
  const prompt = `You are HANK, an AI trading assistant. Provide a concise 2-3 sentence market analysis for IWM right now. Be direct and actionable. No preamble.

IWM price: $${etf.price?.toFixed(2)} | VWAP: $${etf.vwap?.toFixed(2)} | Delta: ${etf.delta!=null?(etf.delta/1000).toFixed(1)+'K':'N/A'} | Bias: ${etf.bias}
TICK: ${etf.tick ?? 'N/A'}
Mag-3 components: ${comps}
${summary ? `Trend: ${summary.trendDir} — ${summary.trendDetail}. Status: ${summary.status}.` : ''}
${swingL}

Write as if speaking to a trader watching the screen. Focus on what matters right now.`;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { if (!analysisCache.has('_warned')) { console.log(`  [HANK AI] ANTHROPIC_API_KEY not set in .env`); analysisCache.set('_warned', true); } return null; }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': apiKey },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 150, messages: [{ role:'user', content:prompt }] }),
    });
    if (!res.ok) { const e = await res.json().catch(()=>({})); console.log(`  [HANK AI] ${res.status}: ${e?.error?.message??''}`); return cached?.text ?? null; }
    const data = await res.json();
    const text = data.content?.[0]?.text?.trim() ?? null;
    if (text) analysisCache.set('IWM', { text, hash, ts: Date.now() });
    return text ?? cached?.text ?? null;
  } catch (e) { console.log(`  [HANK AI] error: ${e.message}`); return cached?.text ?? null; }
}

// ─── Print summary ────────────────────────────────────────────────────────────

let _lastVolumePct = 1.0;

function printSummary(compRows, etf, summary, swingState, signal, analysis, structureSig) {
  const line = '  ' + '─'.repeat(68);
  const pureBulls = compRows.filter(r=>r.bias==='bullish').length;
  const pureBears = compRows.filter(r=>r.bias==='bearish').length;

  console.log('\n' + line);
  console.log(C.bold + `  ╔══════════════════════════════════════════════════════════════════╗` + C.reset);
  console.log(C.bold + `  ║  IWM MONITOR  │  ${getETString()} ET  │  BULL ${pureBulls}/3  BEAR ${pureBears}/3        ║` + C.reset);
  console.log(C.bold + `  ╠══════════════════════════════════════════════════════════════════╣` + C.reset);
  console.log(C.dim  + '  SYM      PRICE       VWAP      DELTA    BIAS    LEVELS' + C.reset);
  console.log(line);

  // Mag-3 component rows
  for (const r of compRows) {
    const sup = r.levels?.support[0]    ? C.green + r.levels.support[0].price.toFixed(2)    + C.reset : '';
    const res = r.levels?.resistance[0] ? C.red   + r.levels.resistance[0].price.toFixed(2) + C.reset : '';
    const sr  = [sup&&`S:${sup}`, res&&`R:${res}`].filter(Boolean).join(' ');
    const err = r.error ? C.gray+` (${r.error})`+C.reset : '';
    console.log(
      `  ${C.bold}${r.symbol.padEnd(6)}${C.reset}` +
      `  ${fmtPrice(r.price)}  ${fmtPrice(r.vwap)}  ${fmtDelta(r.delta)}` +
      `  ${biasTag(r.bias)}  ${fmtVrrs(r.vrrs, r.vrrsSector)}  ${sr}${err}`
    );
  }

  console.log(line);

  // QQQ ETF row
  if (etf?.price) {
    const sup = etf.levels?.support[0]    ? C.green + etf.levels.support[0].price.toFixed(2)    + C.reset : '';
    const res = etf.levels?.resistance[0] ? C.red   + etf.levels.resistance[0].price.toFixed(2) + C.reset : '';
    const sr  = [sup&&`S:${sup}`, res&&`R:${res}`].filter(Boolean).join(' ');
    console.log(
      `  ${C.bold}${'IWM'.padEnd(6)}${C.reset}` +
      `  ${fmtPrice(etf.price)}  ${fmtPrice(etf.vwap)}  ${fmtDelta(etf.delta)}` +
      `  ${biasTag(etf.bias)}  ${fmtVrrs(etf.vrrs, etf.vrrsSector)}  ${sr}` +
      `  ${etf.tick!=null ? C.dim+'$TICK:'+C.reset+' '+(etf.tick>200?C.green:etf.tick<-200?C.red:C.gray)+etf.tick+C.reset : ''}`
    );
  }

  // Pre-market levels
  if (global.preMarketLevels && etf?.price) {
    const L = global.preMarketLevels;
    const fmt = p => p!=null?`$${p.toFixed(2)}`:'N/A';
    const sid = (p,c) => p!=null?(c>p?C.green+'▲'+C.reset:C.red+'▼'+C.reset):'';
    console.log(`  ${C.dim}PDH ${C.red}${fmt(L.pdHigh)}${C.reset}${sid(L.pdHigh,etf.price)}  PDL ${C.green}${fmt(L.pdLow)}${C.reset}${sid(L.pdLow,etf.price)}  PDC ${fmt(L.pdClose)}${sid(L.pdClose,etf.price)}  Open ${fmt(L.todayOpen)}${sid(L.todayOpen,etf.price)}${C.reset}`);
  }

  // QQQ Analysis
  if (summary) {
    const tC = summary.trendDir==='Bullish' ? C.green : C.red;
    console.log(line);
    console.log(`  ${C.bold}IWM ANALYSIS${C.reset}`);
    console.log(`  Trend:      ${tC}${summary.trendDir}${C.reset} — ${summary.trendDetail}`);
    if (summary.nearRes) console.log(`  Resistance: ${C.red}$${summary.nearRes.price.toFixed(2)}${C.reset}  ${C.dim}+${summary.distRes?.toFixed(2)}% away  [${summary.nearRes.label}]${C.reset}`);
    if (summary.nearSup) console.log(`  Support:    ${C.green}$${summary.nearSup.price.toFixed(2)}${C.reset}  ${C.dim}-${summary.distSup?.toFixed(2)}% away  [${summary.nearSup.label}]${C.reset}`);
    console.log(`  Status:     ${summary.status}`);
    console.log(`  Flow:   ${fmtDelta(etf?.delta)}  ${etf?.delta!=null?(etf.delta<0?C.red+'sellers':C.green+'buyers')+C.reset:''}`);
    if (etf?.vrrs!=null) {
      const vC = etf.vrrs>=VRRS_THRESH?C.green:etf.vrrs<=-VRRS_THRESH?C.red:C.gray;
      const sect = etf.vrrsSector!=null?` | Sector ${etf.vrrsSector.toFixed(2)} (${Math.sign(etf.vrrs)===Math.sign(etf.vrrsSector)?'✓ confirms':'÷ diverges'})`:'';
      console.log(`  VRRS:       ${vC}${etf.vrrs.toFixed(3)}${C.reset}${sect}`);
    }
    const _vPct = _lastVolumePct;
    const _vCol = _vPct < 0.50 ? C.red : _vPct < 0.80 ? C.yellow : C.green;
    const _vIcon = _vPct < 0.50 ? '🔴' : _vPct < 0.80 ? '🟡' : '🟢';
    console.log(`  Volume:     ${_vCol}${(_vPct * 100).toFixed(0)}% of avg${C.reset}  ${_vIcon}`);
  }

  // Signal
  const sigCol  = signal.action.includes('CALLS')?C.green:signal.action.includes('PUTS')?C.red:signal.action.includes('CHOP')?C.yellow:C.gray;
  const confCol = signal.confidence==='HIGH'?C.green:signal.confidence==='MEDIUM'?C.yellow:signal.confidence==='WEAK'?C.yellow:C.gray;
  console.log(line);
  console.log(`  ${C.bold}IWM SIGNAL${C.reset}`);
  console.log(`  Action:     ${sigCol}${C.bold}${signal.action}${C.reset}`);
  console.log(`  Confidence: ${confCol}${signal.confidence}${C.reset}`);
  console.log(`  Reason:     ${signal.reason}`);
  if (signal.confidence === 'HIGH') process.stdout.write('\x07');

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

  printPaperPanel(line);

  // Swing Engine
  console.log(line);
  console.log(`  ${C.bold}IWM SWING ENGINE${C.reset}  ${C.dim}ATR-based · 2.5:1 R:R${C.reset}`);
  const sw = swingState;
  if (!sw || sw.status==='WAITING') {
    const etMinsNow = new Date().toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:false,hour:'2-digit',minute:'2-digit'}).split(':').reduce((h,m)=>Number(h)*60+Number(m),0);
    console.log(`  ${C.gray}${etMinsNow<9*60+29?'Waiting for 09:29:30 opening candle...':'Watching for EMA9/VWAP bias confirmation...'}${C.reset}`);
  } else if (sw.status==='LONG'||sw.status==='SHORT') {
    const dCol = sw.status==='LONG'?C.green:C.red;
    const floatPnl = etf?.price ? (sw.status==='LONG'?etf.price-sw.entry:sw.entry-etf.price) : null;
    console.log(`  ${dCol}${C.bold}${sw.status}${C.reset}  Entry $${sw.entry?.toFixed(2)}  Stop ${C.red}$${sw.stop}${C.reset}  Target ${C.green}$${sw.target}${C.reset}  ATR $${sw.atr?.toFixed(2)}  ${C.dim}${sw.entryTime} ET${C.reset}`);
    if (floatPnl!=null) {
      const fpCol = floatPnl>=0?C.green:C.red;
      const toTgt = sw.status==='LONG'?sw.target-etf.price:etf.price-sw.target;
      const toStp = sw.status==='LONG'?etf.price-sw.stop:sw.stop-etf.price;
      console.log(`  Float P&L: ${fpCol}${floatPnl>=0?'+':''}$${floatPnl.toFixed(2)}${C.reset}  ${C.dim}→ target $${toTgt?.toFixed(2)}  stop $${toStp?.toFixed(2)}${C.reset}`);
    }
  } else if (sw.status==='CLOSED') {
    const pCol = (sw.pnl??0)>=0?C.green:C.red;
    const label = sw.exitReason==='TARGET'?'✅ TARGET':sw.exitReason==='STOP'?'🛑 STOP':sw.exitReason==='TREND_EXIT'?'⚠️  TREND EXIT':'⏰ EOD';
    console.log(`  ${pCol}${label}${C.reset}  ${sw.direction} $${sw.entry?.toFixed(2)} → $${sw.exitPrice?.toFixed(2)}  ${pCol}${(sw.pnl??0)>=0?'+':''}$${sw.pnl?.toFixed(2)} (${sw.pnlPct?.toFixed(2)}%)${C.reset}  ${C.dim}No more swings today${C.reset}`);
  }

  console.log(C.bold + `  ╚══════════════════════════════════════════════════════════════════╝` + C.reset);
  console.log(`  ${C.dim}Threshold: ${THRESHOLD}/3 + IWM  │  VRRS: ±${VRRS_THRESH}  │  Poll: ${POLL_MS/1000}s  │  Ctrl+C to quit${C.reset}\n`);

  // HANK LIVE ANALYSIS
  if (analysis) {
    console.log(`  ${C.bold}${C.cyan}◉ HANK LIVE ANALYSIS${C.reset}  ${C.dim}IWM · 30s · ${getETString()} ET${C.reset}`);
    const words = analysis.split(' ');
    let ln = '  ';
    for (const w of words) { if (ln.length + w.length > 70) { console.log(ln); ln = '  '; } ln += w + ' '; }
    if (ln.trim()) console.log(ln);
    console.log('');
  }
}

// ─── Pre-market levels ────────────────────────────────────────────────────────

async function calcPreMarketLevels() {
  try {
    await evalOn(JS_FOCUS_PANE(0));
    await sleep(300);
    await evalOn(`(function(){try{window.TradingViewApi._activeChartWidgetWV.value().setResolution('1D');}catch(e){}})()`);
    await sleep(2000);
    const bars = await evalOn(JS_DAILY_BARS);
    await evalOn(`(function(){try{window.TradingViewApi._activeChartWidgetWV.value().setResolution('30S');}catch(e){}})()`);
    await sleep(1500);
    if (!bars || bars.length < 2) return null;
    // Detect whether today's daily bar exists — TradingView may not create it until 09:30 ET.
    const fmt = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
    const lastBarDate = fmt(new Date(bars[bars.length-1].time * 1000));
    const todayDate   = fmt(new Date());
    let prev, todayOpen;
    if (lastBarDate === todayDate) {
      // Today's bar already exists — bars[-2] is yesterday
      prev = bars[bars.length-2];
      todayOpen = bars[bars.length-1].open;
    } else {
      // No today bar yet (pre-09:30). bars[-1] IS yesterday; bars[-2] would be the day before.
      prev = bars[bars.length-1];
      todayOpen = null;   // unknown until market opens — re-fetched at 09:31
    }
    return { pdHigh: prev.high, pdLow: prev.low, pdClose: prev.close, todayOpen };
  } catch { return null; }
}

// ─── Paper trading helpers ────────────────────────────────────────────────────

const lastScalpOrder = { IWM: 0 };
const SCALP_COOLDOWN = 300_000;  // 5 minutes between scalp orders

async function executeSwingEntry(swingState) {
  if (!sendOrder || !orderGate || activeSwing.IWM.requestId) return;
  if (!isTradingHours()) return;
  const signal = swingState.direction === 'LONG' ? 'CALLS' : 'PUTS';
  const price  = swingState.entry;

  // Options pricing — ATR estimate (Webull chain API_DISABLED, pending scope grant)
  let strike = null, expiry = null, optionMid = null;
  try {
    if (selectContract) {
      const c   = selectContract('IWM', price, signal);
      strike    = c.strike;
      expiry    = c.expiry;
      const atr = swingState.atr ?? price * 0.005;
      optionMid = parseFloat((atr * 0.4).toFixed(2));
    }
  } catch {}
  if (!optionMid) {
    const atr = swingState.atr ?? price * 0.005;
    optionMid = parseFloat((atr * 0.4).toFixed(2));
  }

  // Stack confidence with IWM's 4H macro + today's bias regime.
  let macro4H = 'UNKNOWN';
  if (barCache) {
    try {
      const bars4H = await barCache.get('240');
      if (bars4H && bars4H.length) macro4H = analyze4H(bars4H).direction;
    } catch {}
  }
  const stack = applyMultipliers({ signal, engine: 'SWING', confidence: 'HIGH' },
                                 { macro4H, marketBias: readDailyBiasRegime() });

  const reqId = orderGate.createRequest({ signal, engine: 'SWING' });
  const fill  = await sendOrder({ signal, engine:'SWING', confidence:'HIGH', finalConfidence: stack.finalConfidence, multipliers: stack.breakdown, instrument:'IWM', strike, expiry, entryPrice:optionMid, contracts:1 }, reqId, null);
  if (!fill.vetoed) {
    activeSwing.IWM = { requestId: reqId, status: 'OPEN', strike, expiry, optionEntry: optionMid };
    console.log(`  [SWING] IWM ${signal} $${strike} ${expiry} — paper entry $${optionMid?.toFixed(2)}`);
  }
}

function executeSwingExit(swingState) {
  if (!closePosition || !activeSwing.IWM.requestId || activeSwing.IWM.status !== 'OPEN') return;
  closePosition(activeSwing.IWM.requestId, swingState.exitPrice, swingState.exitReason);
  activeSwing.IWM = { requestId: null, status: null };
}

// Exit open TREND positions: 2x target, 0.5x stop, 90-min time stop, 15:45 EOD
function checkTrendExits(currentEst) {
  if (!closePosition) return;
  let lg;
  try { lg = JSON.parse(readFileSync(join(__dirname, 'paper-ledger.json'), 'utf8')); } catch { return; }
  const openTrend = (lg.trades ?? []).filter(t => t.instrument === 'IWM' && t.engine === 'TREND' && t.status === 'OPEN');
  if (!openTrend.length) return;
  const nowMs  = Date.now();
  const etMins = new Date().toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:false,hour:'2-digit',minute:'2-digit'}).split(':').reduce((h,m)=>+h*60+ +m,0);
  const isEOD  = etMins >= 15*60+45;
  const stopThresh = etMins < 10*60 ? 0.30 : etMins >= 15*60+30 ? 0.40 : 0.45;
  for (const t of openTrend) {
    const fill = t.fillPrice ?? 0;
    if (fill <= 0) continue;
    const holdMs = nowMs - (t.fillTime ?? nowMs);
    if (isEOD) {
      closePosition(t.requestId, currentEst || fill, 'EOD_CLOSE');
    } else if (currentEst >= fill * 2) {
      if (holdMs < 180_000) continue;  // 3-min minimum before target exit
      closePosition(t.requestId, parseFloat((fill * 2).toFixed(4)), 'TARGET_2X');
    } else if (currentEst > 0 && currentEst <= fill * stopThresh) {
      if (holdMs < 90_000) continue;  // 90s minimum before stop fires
      closePosition(t.requestId, parseFloat((fill * stopThresh).toFixed(4)), 'STOP_0.5X');
    } else if (holdMs >= 90 * 60 * 1000) {
      closePosition(t.requestId, currentEst || fill, 'TIME_STOP');
    }
  }
}

const IWM_AVG_VOL_PER_BAR = 25_000_000 / 780; // 100-day avg volume / (390 min * 2 bars/min)

async function executeScalpSignal(signal, optPriceEst = 0, volumePct = 1.0, underlyingPrice = 0, etfCtx = null) {
  const sigEngine = signal?.engine ?? 'TREND';
  const sigDir    = signal?.action?.includes('CALLS') ? 'CALLS' : signal?.action?.includes('PUTS') ? 'PUTS' : 'WAIT';

  // HIERARCHY_V2: compute macro4H up-front so every GATE_BLOCK record includes it.
  let macro4H = 'UNKNOWN';
  if (barCache) {
    try {
      const bars4H = await barCache.get('240');
      if (bars4H && bars4H.length) macro4H = analyze4H(bars4H).direction;
    } catch {}
  }

  if (!sendOrder || !orderGate) { jGateBlock(sigEngine, 'IWM', sigDir, 'TRADE_DISABLED', { macro4H }); return; }
  if (!isTradingHours())        { jGateBlock(sigEngine, 'IWM', sigDir, 'OUT_OF_HOURS',   { macro4H }); return; }
  // Chart-first hierarchy v2 — only chart engines dispatch; TREND becomes context.
  if (HIERARCHY_V2 && !CHART_ENGINE_SET.has(sigEngine)) {
    jGateBlock(sigEngine, 'IWM', sigDir, 'NOT_CHART_ENGINE', { engine: sigEngine, macro4H });
    return;
  }
  if (signal.confidence !== 'HIGH' && signal.confidence !== 'MEDIUM') {
    jGateBlock(sigEngine, 'IWM', sigDir, 'LOW_CONFIDENCE', { confidence: signal.confidence, macro4H }); return;
  }
  const dir = signal.action.includes('CALLS') ? 'CALLS' : signal.action.includes('PUTS') ? 'PUTS' : null;
  if (!dir) { jGateBlock(sigEngine, 'IWM', sigDir, 'NO_DIRECTION', { action: signal.action, macro4H }); return; }
  const now = Date.now();
  if (now - (lastScalpOrder.IWM ?? 0) < SCALP_COOLDOWN) {
    jGateBlock(sigEngine, 'IWM', dir, 'COOLDOWN', { sinceLastMs: now - (lastScalpOrder.IWM ?? 0), macro4H }); return;
  }

  // Options pricing — ATR estimate (Webull chain API_DISABLED, pending scope grant)
  let entryPrice = optPriceEst;
  let liveStrike = null, liveExpiry = null;
  if (selectContract && underlyingPrice > 0) {
    try {
      const contract = selectContract('IWM', underlyingPrice, dir);
      liveStrike = contract.strike;
      liveExpiry = contract.expiry;
    } catch(e) {
      console.log(`  [OPTIONS] IWM strike selection error: ${e.message}`);
    }
  }
  if (entryPrice <= 0.05) { jGateBlock(sigEngine, 'IWM', dir, 'PRICE_TOO_LOW', { entryPrice, macro4H }); return; }

  // Global cap: 3 when Mag-6 ≥ 4 bull (strong trend), 2 otherwise; max 1 IWM
  try {
    const lg = JSON.parse(readFileSync(join(__dirname, 'paper-ledger.json'), 'utf8'));
    const allOpen = (lg.trades ?? []).filter(t => t.status === 'OPEN');
    let mag6Bulls = 0;
    try { mag6Bulls = JSON.parse(readFileSync(join(__dirname, 'mag6-state.json'), 'utf8')).bulls ?? 0; } catch {}
    const globalCap = mag6Bulls >= 4 ? 3 : 2;
    if (allOpen.length >= globalCap) { jGateBlock(sigEngine, 'IWM', dir, 'GLOBAL_CAP', { open: allOpen.length, cap: globalCap, macro4H }); return; }
    if (allOpen.filter(t => t.instrument === 'IWM').length >= 1) { jGateBlock(sigEngine, 'IWM', dir, 'INSTRUMENT_CAP', { macro4H }); return; }
  } catch {}

  const marketBias = readDailyBiasRegime();
  let ana1H = null;
  if (barCache) {
    try {
      const bars1H = await barCache.get('60');
      if (bars1H && bars1H.length) ana1H = analyze1H(bars1H, underlyingPrice);
    } catch {}
  }

  const gate = gate1H({ ...signal, engine: signal.engine ?? 'TREND' }, ana1H, marketBias);
  if (gate.block) {
    jGateBlock(sigEngine, 'IWM', dir, gate.reason, {
      structurePattern: ana1H?.structurePattern, pctOfRange: ana1H?.pctOfRange, macro4H,
    });
    return;
  }

  // MACRO4H BLOCK — chart-first hierarchy v2 hard gate. FADE exempt.
  const macro4HGate = gateMacro4H({ ...signal, engine: signal.engine ?? 'TREND' }, { macro4H });
  if (macro4HGate.block) {
    jGateBlock(sigEngine, 'IWM', dir, macro4HGate.reason, { macro4H, signalEngine: sigEngine });
    return;
  }

  // VWAP wrong-side gate — unified ±0.15%, FADE exempt. etfCtx supplies vwap.
  const _vwap = Number.isFinite(etfCtx?.vwap) ? etfCtx.vwap : 0;
  const vwapGate = gateVwap({ ...signal, engine: signal.engine ?? 'TREND' }, underlyingPrice, _vwap);
  if (vwapGate.block) {
    jGateBlock(sigEngine, 'IWM', dir, vwapGate.reason, { price: underlyingPrice, vwap: _vwap, macro4H });
    return;
  }

  const stack = applyMultipliers({ ...signal, engine: signal.engine ?? 'TREND' },
                                 { macro4H, marketBias, baseAdjust: gate.baseAdjust });

  const reqId = orderGate.createRequest({ signal: dir, engine: 'TREND' });
  const fill  = await sendOrder({
    signal: dir, engine:'TREND', confidence:signal.confidence,
    finalConfidence: stack.finalConfidence, multipliers: stack.breakdown,
    gate1H: { reason: gate.reason, baseAdjust: gate.baseAdjust,
              structurePattern: ana1H?.structurePattern ?? null,
              pctOfRange:       ana1H?.pctOfRange       ?? null },
    instrument:'IWM', strike: liveStrike, expiry: liveExpiry, entryPrice, underlyingPrice, contracts:1,
  }, reqId, null);
  if (!fill.vetoed) { lastScalpOrder.IWM = now; console.log(`  [SCALP] IWM ${dir} paper entry $${entryPrice.toFixed(2)} — ${signal.confidence} → final ${stack.finalConfidence.toFixed(2)}`); }
}

// ─── Poll ─────────────────────────────────────────────────────────────────────

let lastAlert = null, lastAlertTime = 0;
let levelsRefreshed = false;

async function poll() {
  if (!isMarketHours()) { printOutsideHours(); return; }

  // Re-fetch pre-market levels at 09:31 ET if todayOpen was unknown at startup
  if (!levelsRefreshed && global.preMarketLevels?.todayOpen == null) {
    const etM = new Date().toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:false,hour:'2-digit',minute:'2-digit'}).split(':').reduce((h,m)=>+h*60+ +m, 0);
    if (etM >= 9*60+31) {
      levelsRefreshed = true;
      const refreshed = await calcPreMarketLevels();
      if (refreshed) {
        global.preMarketLevels = refreshed;
        console.log(`  [LEVELS] Re-fetched at 09:31 — PDH $${refreshed.pdHigh.toFixed(2)}  PDL $${refreshed.pdLow.toFixed(2)}  PDC $${refreshed.pdClose.toFixed(2)}  Open ${refreshed.todayOpen != null ? '$'+refreshed.todayOpen.toFixed(2) : 'N/A'}`);
      }
    }
  }

  const paneMap = await buildPaneMap();

  // Read Mag-3 components
  const compRows = [];
  for (const sym of COMPONENTS) {
    const idx = paneMap[sym];
    if (idx == null) { compRows.push({ symbol:sym, price:null, vwap:null, delta:null, vrrs:null, vrrsSector:null, bias:'unknown', levels:null, error:'not on chart' }); continue; }
    try {
      const d = await readPane(idx);
      compRows.push({ symbol:sym, ...d, bias: classify(d.price, d.vwap, d.delta, d.vrrs, d.vrrsSector) });
    } catch(e) {
      compRows.push({ symbol:sym, price:null, vwap:null, delta:null, vrrs:null, vrrsSector:null, bias:'unknown', levels:null, error:e.message.slice(0,40) });
    }
  }

  // Read IWM ETF
  let etf = null;
  try {
    const d = await readEtf();
    etf = { ...d, bias: classify(d.price, d.vwap, d.delta, d.vrrs, d.vrrsSector) };
  } catch(e) { etf = { price:null, vwap:null, delta:null, bias:'unknown', levels:null, error:e.message.slice(0,40) }; }

  // FVG + sweep scanners — state persists in fvg-state-IWM.json / sweep-state-IWM.json
  const triggers = await scanTriggers('IWM', barCache, etf?.levels);
  const { fvgSig, sweepSig } = runEntryEngines('IWM', triggers);

  // Chart annotations: layered draw runs after scanners so FVG state is fresh.
  await drawChartAnnotations(etf?.levels);

  const summary   = buildSummary(etf);
  const ema9      = computeEMA9(etf?.bars);
  const swingState = SwingEngine.update(etf?.price, etf?.vwap, ema9, etf?.bars);
  const signal       = buildSignal(compRows, etf, summary);

  // STRUCTURE consumes 5M bars from the shared bar cache. Refuse to fire
  // when the cache isn't ready or the fetch failed — never fall back to
  // the 30S bars in `etf.bars`, which the shared engine doesn't expect.
  let structureSig = null;
  if (isTradingHours() && barCache) {
    const bars5M = await barCache.get('5');
    if (bars5M && bars5M.length >= 5) {
      structureSig = chartStructureEngine({ ...etf, bars: bars5M });
    }
  }
  const analysis     = await fetchAnalysis(etf, compRows, swingState, summary);

  printSummary(compRows, etf, summary, swingState, signal, analysis, structureSig);

  // Per-poll IWM macro4H — for SIGNAL journal records under HIERARCHY_V2.
  let _iwmMacro4H = 'UNKNOWN';
  if (barCache) {
    try {
      const bars4H = await barCache.get('240');
      if (bars4H && bars4H.length) _iwmMacro4H = analyze4H(bars4H).direction;
    } catch {}
  }

  // Journal — IWM-scoped poll snapshot + actionable signal records
  try {
    jPoll({
      monitor:  'iwm',
      iwm:      etf ? { price: etf.price ?? null, vwap: etf.vwap ?? null, delta: etf.delta ?? null, bias: etf.bias ?? null, bars: (etf.bars?.length ?? 0) } : null,
      mag3:     compRows.map(r => ({ sym: r.symbol, bias: r.bias, delta: r.delta })),
      consensus:{ bulls: signal.bulls, bears: signal.bears, total: signal.total },
      signal:   signal ? { action: signal.action, confidence: signal.confidence, reason: signal.reason } : null,
      structure:structureSig ? { action: structureSig.action, confidence: structureSig.confidence, event: structureSig.event, reason: structureSig.reason } : null,
      swing:    swingState ? { status: swingState.status, direction: swingState.direction, entry: swingState.entry, atr: swingState.atr } : null,
      macro4H:  _iwmMacro4H,
    });
    if (signal && (signal.action.includes('CALLS') || signal.action.includes('PUTS')))
      jSignal('TREND', signal.action.includes('CALLS') ? 'CALLS' : 'PUTS', signal.confidence, signal.reason, { instrument: 'IWM', macro4H: _iwmMacro4H });
    if (structureSig)
      jSignal('STRUCTURE', structureSig.action, structureSig.confidence, structureSig.reason, { instrument: 'IWM', event: structureSig.event, macro4H: _iwmMacro4H });
  } catch (e) { jError('iwm-poll-journal', e.message); }

  // Swing order wiring
  if (swingState.status === 'LONG' || swingState.status === 'SHORT') {
    if (!activeSwing.IWM.requestId) await executeSwingEntry(swingState);
  }
  if (swingState.status === 'CLOSED' && activeSwing.IWM.requestId) executeSwingExit(swingState);

  // Volume calculation — compare session bars vs 100-day average per bar
  const _bars       = etf?.bars ?? [];
  const _sessionVol = _bars.reduce((s, b) => s + (b.volume ?? 0), 0);
  const _volumePct  = _bars.length > 0 ? _sessionVol / (IWM_AVG_VOL_PER_BAR * _bars.length) : 1.0;
  _lastVolumePct    = _volumePct;

  // Scalp signal — compute ATR-based premium estimate (40% of ATR, min from price)
  const _swAtr  = SwingEngine.getState().atr ?? (etf?.price != null ? etf.price * 0.005 : 0);
  const _optEst = parseFloat((_swAtr * 0.4).toFixed(2));

  // Exit open TREND positions before entering new ones.
  // HIERARCHY_V2: buildSignal output (TREND consensus) no longer dispatches —
  // it becomes a confidence input. Chart engines (STRUCTURE/FVG/SWEEP) are
  // the only paths that fire orders.
  checkTrendExits(_optEst);
  if (!HIERARCHY_V2) {
    await executeScalpSignal(signal, _optEst, _volumePct, etf?.price ?? 0, etf);
  }
  if (structureSig) await executeScalpSignal(structureSig, _optEst, _volumePct, etf?.price ?? 0, etf);
  if (fvgSig)       await executeScalpSignal(fvgSig,       _optEst, _volumePct, etf?.price ?? 0, etf);
  if (sweepSig)     await executeScalpSignal(sweepSig,     _optEst, _volumePct, etf?.price ?? 0, etf);

  // Alerts
  const now = Date.now();
  if (signal.confidence === 'HIGH' || signal.confidence === 'MEDIUM') {
    const dir = signal.action.includes('CALLS') ? 'CALLS' : signal.action.includes('PUTS') ? 'PUTS' : null;
    if (dir && (lastAlert !== dir || now - lastAlertTime > COOLDOWN)) {
      process.stdout.write('\x07');
      console.log(`\n  ${dir==='CALLS'?C.bgGreen:C.bgRed}  *** IWM ${dir} ***  ${C.reset}  ${signal.reason}\n`);
      lastAlert = dir; lastAlertTime = now;
    }
  }

  // Write iwm-levels.json for briefing
  try {
    const _volColor = _volumePct < 0.50 ? 'red' : _volumePct < 0.80 ? 'yellow' : 'green';
    writeFileSync(LEVELS_FILE, JSON.stringify({
      pdHigh: global.preMarketLevels?.pdHigh ?? null,
      pdLow:  global.preMarketLevels?.pdLow  ?? null,
      pdClose: global.preMarketLevels?.pdClose ?? null,
      todayOpen: global.preMarketLevels?.todayOpen ?? null,
      current: etf?.price ?? null, vwap: etf?.vwap ?? null, bias: etf?.bias ?? null,
      volumePct: parseFloat(_volumePct.toFixed(2)),
      volumeColor: _volColor,
      ts: Date.now(), time: getETString(),
    }, null, 2));
  } catch {}

  // Session reset at 16:00
  const etMinsNow = new Date().toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:false,hour:'2-digit',minute:'2-digit'}).split(':').reduce((h,m)=>Number(h)*60+Number(m),0);
  if (etMinsNow >= 16*60 && etMinsNow < 16*60+1) {
    if (sessionReset) sessionReset();
    activeSwing.IWM = { requestId:null, status:null };
    if (printScorecard) printScorecard();
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function shutdown() {
  console.log('\n\n  IWM Monitor shutting down...');
  try { if (client) await client.close(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold + '\n  IWM Market Monitor — Starting up...' + C.reset);
  console.log(`  Instrument: IWM`);
  console.log(`  Mag-3 stocks:  ${COMPONENTS.join(', ')}`);
  console.log(`  Chart ID:   ${CHART_ID}`);
  console.log(`  Hours:      7:00 AM – 4:00 PM ET  |  Poll: ${POLL_MS/1000}s`);
  console.log(`  Threshold:  ${THRESHOLD}/3 components + IWM confirms`);
  console.log(`  VRRS:       ±${VRRS_THRESH} — VRRS_vs_Market + VRRS_vs_Sector`);
  console.log(`  Trading:    ${process.env.TRADING_MODE || 'PAPER'} mode\n`);

  await initClient();

  // Build multi-TF bar cache now that CDP is connected. Bootstrap pulls
  // one fetch per resolution (30S/5/60/240); the 4H flip adds ~1.5s.
  barCache = createBarCache({ evalOn, instrumentLabel: 'IWM' });
  console.log('  Bootstrapping multi-TF bar cache (30S / 5M / 1H / 4H)...');
  try {
    const r = await barCache.bootstrap();
    const status  = barCache.getCacheStatus();
    const summary = ['30S','5','60','240'].map(res => `${res}=${status[res]?.bars ?? '–'}`).join(' ');
    if (r.ok) {
      console.log(`  ${C.green}✓${C.reset} IWM: ${summary}`);
    } else {
      console.log(`  ${C.yellow}⚠${C.reset} IWM: ${summary} — missing: ${r.missing.join(',')}`);
      jAlert('warn', 'IWM bar bootstrap incomplete', { missing: r.missing, status });
    }
  } catch (e) {
    console.error(`  ${C.red}✗${C.reset} IWM bar bootstrap failed: ${e.message}`);
    jError('bars-bootstrap-fatal', e.message, { instrument: 'IWM' });
  }
  console.log('');

  // Re-hydrate activeSwing from ledger in case of restart mid-session
  try {
    const _lg = JSON.parse(readFileSync(join(__dirname, 'paper-ledger.json'), 'utf8'));
    const _sw = _lg.trades?.find(t => t.instrument === 'IWM' && t.engine === 'SWING' && t.status === 'OPEN');
    if (_sw) { activeSwing.IWM = { requestId: _sw.requestId, status: 'OPEN' }; console.log(`  [SWING] Re-hydrated open IWM swing — reqId ${_sw.requestId}`); }
  } catch {}

  console.log('\n  Calculating pre-market levels...');
  const levels = await calcPreMarketLevels();
  if (levels) {
    global.preMarketLevels = levels;
    const openStr = levels.todayOpen != null ? `$${levels.todayOpen.toFixed(2)}` : '(pending 09:31)';
    console.log(`  PDH $${levels.pdHigh.toFixed(2)}  PDL $${levels.pdLow.toFixed(2)}  PDC $${levels.pdClose.toFixed(2)}  Open ${openStr}\n`);
  } else {
    console.log('  Pre-market levels unavailable\n');
  }

  await poll();
  setInterval(async () => {
    try { await poll(); } catch(e) { console.error(`  Poll error: ${e.message}`); }
  }, POLL_MS);
}

main().catch(async e => {
  console.error('\n  Fatal:', e.message);
  await shutdown();
});
