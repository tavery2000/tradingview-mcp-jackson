/**
 * webhook-server.js — TradingView Pine alert receiver
 *
 * Pine-as-Primary architecture (rebuilt 2026-05-11):
 *   The Pine indicator (smc-pro-futures.pine) is the sole signal source.
 *   TradingView fires alertcondition events as webhook POSTs to this server.
 *   This server validates, sizes via tier, and routes to paperTrading.sendOrder.
 *
 * Endpoints:
 *   POST /pine-alert  — receives a Pine alertcondition payload, opens a paper trade
 *   POST /pine-close  — receives a Pine close signal, closes opposite-direction position
 *   GET  /health      — sanity check
 *
 * Payload format (from TradingView alert message JSON):
 *   {
 *     "instrument": "SPY",
 *     "direction":  "PUTS" | "CALLS",
 *     "engine":     "FADE" | "STRUCTURE" | "FVG" | "SWEEP" | "BUY" | "SELL" | "HTF" | "ZONE" | "LIVE" | "HL" | "LH",
 *     "confidence": "HIGH" | "MEDIUM",
 *     "price":      739.50,
 *     "vwap":       738.95,         // optional, journal context
 *     "alertName":  "Bullish Zone Break"
 *   }
 *
 * Defenses retained:
 *   - RTH gate (09:30:00-15:45:00 ET) at request time + paperTrading.sendOrder defense
 *   - Tier-based sizing via paperTrading.getPositionSize
 *   - Daily-loss cap, per-instrument cap, concurrent cap (all in sendOrder)
 *   - ATR-based option price fallback when chain quote unavailable (API_DISABLED)
 *   - §19 SIGNAL_REVERSAL exit: if opposite-direction position open, close it first
 *
 * Run:  node webhook-server.js
 *       PORT=9001 node webhook-server.js  (env override)
 *
 * Pattern: matches dashboard-server.js — uses Node built-in http module, no Express.
 */

import 'dotenv/config';   // 2026-05-14: load .env BEFORE paperTrading.js's module-load env reads
import http from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { orderGate, sendOrder, closePosition } from './paperTrading.js';
import { jSignal, jGateBlock, jAlert, jError } from './journal.js';
import { evaluateCounterTrend }               from './signalConfidence.js';
import { startPreSwitchScheduler }            from './preSwitchKill.js';
import { startCalibrationScheduler }          from './calibrationScheduler.js';
// 2026-05-17 Path 2 (futuresTrading.js) RETIRED. Archived to
// _archive/2026-05-17-futures-direct-retirement/. All futures execution
// now flows through Webull MCP. webull-mcp-client.js is the new wrapper.
import { getWebullMCP, isMCPDisabled, isIntegrationHalted } from './webull-mcp-client.js';
const _FUTURES_INSTRUMENTS = new Set(
  (process.env.FUT_INSTRUMENTS || 'ES1!,NQ1!,MES1!,MNQ1!')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
);

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ─── Last-gasp crash logging ──────────────────────────────────────────────────
// If anything in the request pipeline throws unexpectedly, we want to know
// WHY in the journal before the process dies (so the supervisor's restart
// record + this journal entry together explain the death). These handlers
// MUST be registered before any other code runs.
process.on('uncaughtException', (err) => {
  try { jError('WEBHOOK', 'UNCAUGHT_EXCEPTION', { message: err.message, stack: err.stack?.slice(0, 800) }); } catch {}
  console.error(`\n[WEBHOOK] FATAL uncaughtException: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack?.slice(0, 800) : null;
  try { jError('WEBHOOK', 'UNHANDLED_REJECTION', { message: msg, stack }); } catch {}
  console.error(`\n[WEBHOOK] FATAL unhandledRejection: ${msg}`);
  if (stack) console.error(stack);
  process.exit(1);
});

// Lazy-load webull so the webhook runs even if Webull module errors
let selectContract = null;
try {
  const wb = await import('./webull.js');
  selectContract = wb.selectContract;
  console.log('  [WEBHOOK] webull.js loaded — strike/expiry selection active');
} catch (e) {
  console.log('  [WEBHOOK] webull.js not loaded — selectContract disabled:', e.message);
}

const PORT        = parseInt(process.env.PORT ?? '9001', 10);
const LEDGER_FILE = join(__dirname, 'paper-ledger.json');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isTradingHours() {
  const t = new Date().toLocaleTimeString('en-US', { timeZone:'America/New_York', hour12:false, hour:'2-digit', minute:'2-digit' });
  const [h, m] = t.split(':').map(Number);
  return (h * 60 + m) >= 9 * 60 + 30 && (h * 60 + m) < 15 * 60 + 45;
}

function etTimeString() {
  return new Date().toLocaleTimeString('en-US', { timeZone:'America/New_York', hour12:false });
}

const VALID_INSTRUMENTS = new Set(['SPY','QQQ','IWM','ES','NQ','ES1!','NQ1!','MES','MNQ','MES1!','MNQ1!']);
const VALID_DIRECTIONS  = new Set(['CALLS','PUTS']);
const VALID_CONFIDENCES = new Set(['HIGH','MEDIUM','LOW']);

function validatePayload(body) {
  if (!body || typeof body !== 'object')                                 return 'body must be JSON object';
  if (!body.instrument || !VALID_INSTRUMENTS.has(body.instrument))       return `instrument must be one of ${[...VALID_INSTRUMENTS].join(',')}`;
  if (!body.direction || !VALID_DIRECTIONS.has(body.direction))          return `direction must be CALLS or PUTS`;
  if (typeof body.price !== 'number' || !Number.isFinite(body.price) || body.price <= 0) return 'price must be positive number';
  if (body.confidence && !VALID_CONFIDENCES.has(body.confidence))        return 'confidence must be HIGH/MEDIUM/LOW';
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 64 * 1024) { req.destroy(); reject(new Error('payload too large')); return; }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error(`invalid JSON: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handlePineAlert(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) {
    jError('WEBHOOK', 'BODY_READ_FAIL', { error: e.message });
    return send(res, 400, { ok: false, reason: 'BAD_BODY', error: e.message });
  }

  const validationError = validatePayload(body);
  if (validationError) {
    jError('WEBHOOK', 'INVALID_PAYLOAD', { body, error: validationError });
    return send(res, 400, { ok: false, reason: 'INVALID_PAYLOAD', error: validationError });
  }

  const { instrument, direction, price, vwap = null, alertName = null } = body;
  const engine     = body.engine     ?? 'PINE';
  const confidence = body.confidence ?? 'MEDIUM';
  // P1-5-B (2026-05-14 EOD): structure-based stop fields from Pine.
  // CALLS: invalidation_level = prevSwingLow (HL pivot low).
  // PUTS:  invalidation_level = prevSwingHigh (LH pivot high).
  // null when Pine has no recent pivot (early in session, or no struct).
  const invalidation_level = (body.invalidation_level == null || body.invalidation_level === 'null')
    ? null : Number(body.invalidation_level);
  const structure_type     = body.structure_type || null;

  console.log(`  [PINE-ALERT] ${instrument} ${direction} | engine ${engine} | conf ${confidence} | price ${price} | ${etTimeString()} ET`);

  // Journal every inbound Pine alert at receipt — BEFORE any gate or
  // downstream code path. Prevents the "[PINE-ALERT] logged to console but
  // no journal record" gap that hid today's webhook outages from the
  // post-mortem dataset. Subsequent records (GATE_BLOCK / SIGNAL / ERROR /
  // ENTRY) then narrate what happened to this specific alert.
  try {
    jAlert('INFO', 'pine-alert.inbound', { instrument, direction, engine, confidence, price, vwap, alertName, et: etTimeString() });
  } catch {}

  // 2026-05-15 Task 6: hardcoded retired-instrument list (permanent). Distinct
  // from INSTRUMENT_DISABLED below (env-driven, temporary). Retired = removed
  // from system, won't come back without explicit code change. IWM retired
  // 2026-05-15 per operator directive: post-Pine-republish IWM still showed
  // structurally weak edge despite 4H/1H gates; capital reallocated to futures.
  const RETIRED_INSTRUMENTS = new Set(['IWM']);
  if (RETIRED_INSTRUMENTS.has((instrument || '').toUpperCase())) {
    jGateBlock(engine, instrument, direction, 'INSTRUMENT_RETIRED', {
      etTime: etTimeString(), retiredAt: '2026-05-15',
    });
    return send(res, 200, { ok: false, reason: 'INSTRUMENT_RETIRED', et: etTimeString() });
  }

  // P1-8 (2026-05-14 EOD): instrument suspension. Comma-separated env var
  // INSTRUMENT_DISABLED rejects all alerts on listed instruments. Temporary —
  // use RETIRED_INSTRUMENTS above for permanent removal.
  const _disabledList = (process.env.INSTRUMENT_DISABLED || '')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (_disabledList.includes((instrument || '').toUpperCase())) {
    jGateBlock(engine, instrument, direction, 'INSTRUMENT_DISABLED', {
      etTime: etTimeString(), disabledList: _disabledList,
    });
    return send(res, 200, { ok: false, reason: 'INSTRUMENT_DISABLED', et: etTimeString() });
  }

  // P0-1 (2026-05-14 EOD): write latest underlying price per instrument so
  // monitor.js's evaluateOpenPositions feeder can resolve futures (ES1!/NQ1!/
  // MES1!/MNQ1!) prices. Today's catastrophe: futures stops never fired
  // because monitor.js's underlyingMap only had SPY/QQQ/IWM. Pine alerts
  // arrive with `price` (instrument underlying); cache it on disk so the
  // monitor process can read it at evaluation time. Writes are atomic-ish
  // — single small JSON file, infrequent enough that race risk is minimal.
  try {
    const PRICE_CACHE_FILE = join(__dirname, 'latest-prices.json');
    let cache = {};
    if (existsSync(PRICE_CACHE_FILE)) {
      try { cache = JSON.parse(readFileSync(PRICE_CACHE_FILE, 'utf8')) || {}; } catch {}
    }
    cache[instrument] = { price, ts: Date.now(), et: etTimeString() };
    writeFileSync(PRICE_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    try { jError('WEBHOOK', 'PRICE_CACHE_WRITE_FAIL', { instrument, error: e.message }); } catch {}
  }

  // ── Session gate (2026-05-14 EOD TASK 4 + EXPLORATION_WINDOW removal 2026-05-15) ─
  // EXPLORATION_WINDOW gate REMOVED per operator directive 2026-05-15:
  // 09:30-09:40 equity entries no longer blocked. PRE_MARKET (pre-09:30)
  // and OUT_OF_HOURS (post-16:00) gates remain for equity. Futures
  // (ES/NQ/MES/MNQ + 1!) bypass all time gates — 24/5 session.
  const SESSION_GATE_EQUITY = new Set(['SPY', 'QQQ', 'IWM']);
  const _gateETMins = (() => {
    const t = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  })();
  if (SESSION_GATE_EQUITY.has(instrument)) {
    if (_gateETMins < 9 * 60 + 30) {
      jGateBlock(engine, instrument, direction, 'PRE_MARKET', { etTime: etTimeString(), etMins: _gateETMins, openMins: 9 * 60 + 30 });
      return send(res, 200, { ok: false, reason: 'PRE_MARKET', et: etTimeString() });
    }
    // EXPLORATION_WINDOW gate REMOVED 2026-05-15 per operator directive.
    // Equity entries 09:30-09:40 now allowed (previously blocked).
    if (_gateETMins >= 16 * 60) {
      jGateBlock(engine, instrument, direction, 'OUT_OF_HOURS', { etTime: etTimeString(), etMins: _gateETMins, closeMins: 16 * 60 });
      return send(res, 200, { ok: false, reason: 'OUT_OF_HOURS', et: etTimeString() });
    }
  }
  // Futures: no time gate. ES1!/NQ1!/MES1!/MNQ1! and bare forms trade 24/5.

  // ATR-based option price fallback (Webull chain API_DISABLED)
  const optEst = parseFloat((price * 0.005 * 0.4).toFixed(2));
  if (optEst <= 0.05) {
    jGateBlock(engine, instrument, direction, 'PRICE_TOO_LOW', { optEst, price });
    return send(res, 200, { ok: false, reason: 'PRICE_TOO_LOW', optEst });
  }

  // §19 — Signal reversal exit
  // P1-6 (2026-05-14 EOD) exit hierarchy: SIGNAL_REVERSAL is the LAST-RESORT
  // exit reason. Mechanical exits (STOP_LOSS / TARGET / TRAIL / BE / locked)
  // ALWAYS win on the same tick by virtue of running in evaluateOpenPositions
  // which closes synchronously before processing the next pine alert.
  // Additional precedence: trades that have transitioned to STAGE_3_TRAILING
  // are protected by their trail+R-locks — operator wants the trail to run,
  // not the next opposite Pine signal to short-circuit it. Skip SIGNAL_REVERSAL
  // when the candidate has stage=STAGE_3_TRAILING.
  try {
    const lg = JSON.parse(readFileSync(LEDGER_FILE, 'utf8'));
    const oppositeOpen = (lg.trades ?? []).find(t =>
      t.instrument === instrument && t.status === 'OPEN' &&
      t.signal !== direction && t.engine !== 'SWING'
    );
    if (oppositeOpen) {
      if (oppositeOpen.stage === 'STAGE_3_TRAILING') {
        jAlert('INFO', 'signal-reversal.skipped.stage3', {
          instrument, requestId: oppositeOpen.requestId,
          openSignal: oppositeOpen.signal, newSignal: direction,
          reason: 'STAGE_3_TRAILING — trail/R-lock owns the close, not signal-reversal',
        });
        console.log(`  [SIGNAL_REVERSAL] SKIPPED — ${instrument} ${oppositeOpen.signal} in STAGE_3_TRAILING; trail/R-locks own close`);
      } else {
        const entryU = oppositeOpen.underlyingPrice ?? price;
        const dirMult = oppositeOpen.signal === 'CALLS' ? 1 : -1;
        const optMove = (price - entryU) * dirMult * 0.4;
        const synthExit = Math.max(0.01, parseFloat((oppositeOpen.fillPrice + optMove).toFixed(4)));
        const closed = closePosition(oppositeOpen.requestId, synthExit, 'SIGNAL_REVERSAL');
        if (closed) {
          console.log(`  [SIGNAL_REVERSAL] Closed ${instrument} ${oppositeOpen.signal} at $${synthExit.toFixed(2)} (entry $${oppositeOpen.fillPrice}) — ${engine} flipped to ${direction}`);
        }
      }
    }
  } catch (e) {
    jError('WEBHOOK', 'SIGNAL_REVERSAL_LEDGER_READ', { error: e.message });
  }

  // LATE_DAY_ENTRY_0DTE gate — block new entries on 0DTE ETF options after 15:30 ET.
  // Why: theta burn on near-ATM 0DTE in the final 30 min produces deterministic
  // HARD_EXIT losses (see 2026-05-12 15:42-15:43 -$169.19, BS math verified correct).
  // Placed AFTER SIGNAL_REVERSAL so opposite-direction alerts can still close
  // existing positions through this window; only new entries are blocked.
  const ZERO_DTE_INSTRUMENTS = new Set(['SPY', 'QQQ', 'IWM']);
  if (ZERO_DTE_INSTRUMENTS.has(instrument)) {
    const t = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
    const [h, m] = t.split(':').map(Number);
    const etMins = h * 60 + m;
    if (etMins >= 15 * 60 + 30) {
      jGateBlock(engine, instrument, direction, 'LATE_DAY_ENTRY_0DTE', { etTime: etTimeString(), etMins, cutoffMins: 15 * 60 + 30 });
      return send(res, 200, { ok: false, reason: 'LATE_DAY_ENTRY_0DTE', et: etTimeString() });
    }
  }

  // ── Counter-trend gate (2026-05-13) ─────────────────────────────────────
  // Reads macro4h-{spy|qqq|iwm}.json (per-monitor poll cycle) for the
  // instrument's family. SPY/ES1!/MES1! → spy, QQQ/NQ1!/MNQ1! → qqq, IWM → iwm.
  // Stale files (>5 min old) fall back to UNKNOWN which never trips the gate.
  // Mode = off | down_weight (default) | block — set via COUNTER_TREND_MODE env.
  let _macro4H    = 'UNKNOWN';
  let _macro4HSrc = 'no-lookup';
  let _macro1H    = { trendBias: 'NEUTRAL', structurePattern: 'NEUTRAL' };
  let _macro1HSrc = 'no-lookup';
  try {
    const family =
      instrument === 'SPY'  || instrument === 'ES1!' || instrument === 'MES1!' ? 'spy' :
      instrument === 'QQQ'  || instrument === 'NQ1!' || instrument === 'MNQ1!' ? 'qqq' :
      instrument === 'IWM'                                                       ? 'iwm' : null;
    if (family) {
      const file = join(__dirname, `macro4h-${family}.json`);
      const data = JSON.parse(readFileSync(file, 'utf8'));
      const ageMin = (Date.now() - (data.ts ?? 0)) / 60000;
      if (ageMin > 5) {
        _macro4HSrc = `stale:${ageMin.toFixed(1)}min`;
      } else {
        _macro4H    = data.macro4H ?? 'UNKNOWN';
        _macro4HSrc = `${family}:${ageMin.toFixed(1)}min`;
      }
      // P0 (2026-05-15 EOD): read 1H bias for the structural gate
      try {
        const f1H = join(__dirname, `macro1h-${family}.json`);
        const d1H = JSON.parse(readFileSync(f1H, 'utf8'));
        const age1H = (Date.now() - (d1H.ts ?? 0)) / 60000;
        if (age1H > 5) {
          _macro1HSrc = `stale:${age1H.toFixed(1)}min`;
        } else {
          _macro1H = { trendBias: d1H.trendBias ?? 'NEUTRAL', structurePattern: d1H.structurePattern ?? 'NEUTRAL' };
          _macro1HSrc = `${family}:${age1H.toFixed(1)}min`;
        }
      } catch (e) {
        _macro1HSrc = `read-fail:${(e.message || '').slice(0, 40)}`;
      }
    } else {
      _macro4HSrc = `no-family-mapping:${instrument}`;
    }
  } catch (e) {
    _macro4HSrc = `read-fail:${(e.message || '').slice(0, 40)}`;
  }

  // P1-7 (2026-05-14) + P0 (2026-05-15): pass instrument AND macro1H so
  // evaluateCounterTrend can apply instrument-class mode AND block on
  // opposing 1H trendBias / structurePattern (today's 14:15 MES1! bug).
  const ctGate = evaluateCounterTrend(_macro4H, direction, engine, instrument, _macro1H);
  if (ctGate.action === 'block') {
    jGateBlock(engine, instrument, direction, 'COUNTER_TREND_BLOCK', {
      macro4H: _macro4H, macro4HSrc: _macro4HSrc,
      macro1H: _macro1H, macro1HSrc: _macro1HSrc,
      mode: 'block', source: ctGate.source ?? '4H',
      instrumentClass: ctGate.instrumentClass ?? null,
    });
    return send(res, 200, { ok: false, reason: 'COUNTER_TREND_BLOCK', macro4H: _macro4H, macro1H: _macro1H, source: ctGate.source ?? '4H' });
  }

  // Select contract (strike + expiry)
  let strike = null, expiry = null;
  if (selectContract) {
    try {
      const contract = selectContract(instrument, price, direction);
      strike = contract.strike;
      expiry = contract.expiry;
    } catch (e) {
      jError('WEBHOOK', 'CONTRACT_SELECT_FAIL', { error: e.message, instrument, price, direction });
      return send(res, 500, { ok: false, reason: 'CONTRACT_SELECT_FAIL', error: e.message });
    }
  }

  // Build consensus — Pine-driven, minimal. finalConfidence baked with
  // counter-trend multiplier so paperTrading.sendOrder tier sizing sees the
  // adjusted band naturally. action='down_weight' typically takes MEDIUM
  // (1.0 × 0.6 = 0.6) below the 0.65 threshold → BELOW_THRESHOLD_CONFIDENCE
  // veto; HIGH (1.5 × 0.6 = 0.9) survives as low-band 1-contract sizing.
  const _baseConf = confidence === 'HIGH' ? 1.5 : 1.0;
  const consensus = {
    signal:                 direction,
    engine,
    confidence,
    finalConfidence:        _baseConf * ctGate.multiplier,
    instrument,
    strike,
    expiry,
    entryPrice:             optEst,
    underlyingPrice:        price,
    contracts:              1,
    pineAlert:              true,
    alertName,
    vwap,
    macro4H:                _macro4H,
    counterTrendAction:     ctGate.action,
    counterTrendMultiplier: ctGate.multiplier,
    invalidationLevel:      invalidation_level,
    structureType:          structure_type,
  };

  // 2026-05-17: futures + equity-options dispatch via Webull MCP.
  // Path 2 (futuresTrading.js) retired. Equity options used to flow
  // through paperTrading.sendOrder → webull.js; now flow through MCP.
  // Global rollback flags:
  //   WEBULL_INTEGRATION_HALT=true  → reject ALL (tier 3 catastrophic)
  //   WEBULL_MCP_DISABLED=true      → reject all new entries (tier 1)
  if (isIntegrationHalted()) {
    jGateBlock(engine, instrument, direction, 'WEBULL_INTEGRATION_HALT', { etTime: etTimeString() });
    return send(res, 200, { ok: false, reason: 'WEBULL_INTEGRATION_HALT' });
  }
  if (isMCPDisabled()) {
    jGateBlock(engine, instrument, direction, 'WEBULL_MCP_DISABLED', { etTime: etTimeString() });
    return send(res, 200, { ok: false, reason: 'WEBULL_MCP_DISABLED' });
  }

  if (_FUTURES_INSTRUMENTS.has(instrument.toUpperCase())) {
    // 2026-05-17 18:15 ET hot-fix: micro-fallback.
    // Full-contract NQ1!/ES1! margin exceeds CAPITAL_CAP_PER_TRADE (NQ
    // day-margin ~$22K vs $3K cap; ES ~$14K vs $1K cap). Auto-downgrade
    // to MNQ1!/MES1! which fit within caps. Operator can disable via
    // MICRO_FALLBACK_ENABLED=false in .env if testing full-contract sizing.
    const _MICRO_FALLBACK = (process.env.MICRO_FALLBACK_ENABLED || 'true').toLowerCase() === 'true';
    let routedInstrument = instrument.toUpperCase();
    let microDowngrade = null;
    if (_MICRO_FALLBACK) {
      if (routedInstrument === 'NQ1!')      { microDowngrade = { from: 'NQ1!', to: 'MNQ1!' }; routedInstrument = 'MNQ1!'; }
      else if (routedInstrument === 'ES1!') { microDowngrade = { from: 'ES1!', to: 'MES1!' }; routedInstrument = 'MES1!'; }
    }
    if (microDowngrade) {
      console.log(`  [FUTURES] micro-fallback ${microDowngrade.from} → ${microDowngrade.to}`);
      try { jAlert('info', 'FUTURES_MICRO_FALLBACK', { ...microDowngrade, direction, engine, price }); } catch {}
    }
    const mcp = getWebullMCP();
    if (!mcp || !mcp.isConnected()) {
      jError('WEBHOOK', 'MCP_NOT_CONNECTED', { instrument: routedInstrument, direction, engine });
      return send(res, 503, { ok: false, reason: 'MCP_NOT_CONNECTED' });
    }
    console.log(`  [FUTURES] route → place_futures_order ${routedInstrument}${microDowngrade ? ` (micro from ${microDowngrade.from})` : ''}`);
    try {
      const result = await mcp.placeFuturesOrder({
        instrument: routedInstrument, direction, engine, confidence, price,
        macro4H: _macro4H, invalidationLevel: invalidation_level,
        structureType: structure_type,
      });
      if (result.vetoed) {
        return send(res, 200, { ok: false, reason: result.reason || 'MCP_VETOED', detail: result });
      }
      return send(res, 200, { ok: true, dispatch: 'webull-mcp-futures', requestId: result.requestId, orderId: result.orderId, contracts: result.contracts, micro_downgrade: microDowngrade });
    } catch (e) {
      jError('WEBHOOK', 'MCP_FUTURES_ORDER_THREW', { message: e.message, stack: e.stack?.slice(0,600), instrument: routedInstrument, direction, engine });
      return send(res, 500, { ok: false, reason: 'MCP_FUTURES_ORDER_THREW', error: e.message });
    }
  }

  // Wrap orderGate + sendOrder + jSignal in try/catch. Previously an
  // uncaught throw here (e.g., paper-ledger.json lock contention,
  // sendOrder internal error) would propagate up through the async
  // request handler and either crash the process or leave the TV client
  // hanging until ngrok timed out with 502. With this wrap, the journal
  // captures the failure and TV gets a clean 500 response.
  let reqId, fill;
  try {
    reqId = orderGate.createRequest({ signal: direction, engine });
    fill  = await sendOrder(consensus, reqId, { mid: optEst });
  } catch (e) {
    jError('WEBHOOK', 'SEND_ORDER_THREW', {
      message: e.message,
      stack: e.stack?.slice(0, 600),
      instrument, direction, engine, price, reqId,
    });
    console.error(`  [WEBHOOK] sendOrder threw: ${e.message}`);
    return send(res, 500, { ok: false, reason: 'SEND_ORDER_THREW', error: e.message });
  }

  jSignal(engine, direction, confidence, alertName ?? `${engine} ${direction}`, {
    instrument, price, vwap, optEst, pineAlert: true, reqId,
  });

  if (fill.vetoed) {
    return send(res, 200, { ok: false, vetoed: true, reason: fill.reason, reqId });
  }

  console.log(`  [PINE-FILL] ${instrument} ${direction} @ $${optEst} — reqId ${reqId}`);
  return send(res, 200, { ok: true, reqId, fill });
}

async function handlePineClose(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return send(res, 400, { ok: false, reason: 'BAD_BODY', error: e.message }); }

  const { instrument, direction, reason = 'PINE_CLOSE', price = null } = body;
  if (!instrument || !direction) return send(res, 400, { ok: false, reason: 'INVALID_PAYLOAD' });

  try {
    const lg = JSON.parse(readFileSync(LEDGER_FILE, 'utf8'));
    const open = (lg.trades ?? []).find(t =>
      t.instrument === instrument && t.status === 'OPEN' && t.signal === direction && t.engine !== 'SWING'
    );
    if (!open) return send(res, 200, { ok: false, reason: 'NO_MATCHING_POSITION' });

    const entryU = open.underlyingPrice ?? price ?? 0;
    const currentU = price ?? entryU;
    const dirMult = direction === 'CALLS' ? 1 : -1;
    const optMove = (currentU - entryU) * dirMult * 0.4;
    const synthExit = Math.max(0.01, parseFloat((open.fillPrice + optMove).toFixed(4)));
    const closed = closePosition(open.requestId, synthExit, reason);
    if (closed) {
      console.log(`  [PINE-CLOSE] ${instrument} ${direction} closed at $${synthExit} | reason ${reason}`);
      return send(res, 200, { ok: true, closed: { exitPrice: synthExit, pnl: closed.pnl, pnlPct: closed.pnlPct } });
    }
    return send(res, 200, { ok: false, reason: 'CLOSE_FAILED' });
  } catch (e) {
    return send(res, 500, { ok: false, reason: 'EXCEPTION', error: e.message });
  }
}

function handleHealth(_req, res) {
  send(res, 200, {
    ok: true,
    et: etTimeString(),
    tradingHours: isTradingHours(),
    selectContract: !!selectContract,
    port: PORT,
  });
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  if (method === 'GET' && url === '/health')          return handleHealth(req, res);
  if (method === 'POST' && url === '/pine-alert')     return handlePineAlert(req, res);
  if (method === 'POST' && url === '/pine-close')     return handlePineClose(req, res);

  send(res, 404, { ok: false, reason: 'NOT_FOUND', method, url });
});

server.listen(PORT, () => {
  const _ctMode = process.env.COUNTER_TREND_MODE || 'down_weight';
  const _ctMult = parseFloat(process.env.COUNTER_TREND_DOWNWEIGHT || '0.6');
  const _ctFut  = process.env.COUNTER_TREND_FUTURES_MODE || _ctMode;
  const _ctEq   = process.env.COUNTER_TREND_EQUITY_MODE  || _ctMode;
  console.log(`  [WEBHOOK] Counter-trend gates: futures=${_ctFut}  equity=${_ctEq}  downweight×${_ctMult}`);
  // 2026-05-15 Task 7: arm the pre-12:00-ET kill scheduler. Idempotent.
  startPreSwitchScheduler();
  // 2026-05-16 Phase 1 Additional: arm the daily calibration rebuild.
  startCalibrationScheduler();
  // 2026-05-17: spawn embedded Webull MCP child process + connect.
  // Failure to connect does NOT kill the webhook — MCP client auto-retries
  // with exponential backoff; webhook will reject new entries with
  // MCP_NOT_CONNECTED until the child comes up.
  import('./webull-mcp-client.js').then(m => {
    m.initWebullMCP().then(ok => {
      if (!ok) console.log(`  [WEBHOOK] Webull MCP not connected at startup — retrying in background`);
    });
  }).catch(e => console.error(`  [WEBHOOK] Webull MCP init failed: ${e.message}`));
  // 2026-05-17 Roll Guard scaffolding (detection only; auto-roll Thu 5/21).
  import('./rollGuard.js').then(m => m.startRollGuard()).catch(e => console.error(`  [WEBHOOK] Roll Guard init failed: ${e.message}`));
  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║  HANK Pine Webhook Server                                            ║
║                                                                      ║
║  Listening on http://localhost:${String(PORT).padEnd(38)}║
║  TradingView webhook URL: http://YOUR_HOST:${String(PORT)}/pine-alert         ║
║                                                                      ║
║  Endpoints:                                                          ║
║    POST /pine-alert  — open paper trade from Pine alert              ║
║    POST /pine-close  — close paper trade from Pine alert             ║
║    GET  /health      — sanity check                                  ║
║                                                                      ║
║  Counter-trend gate: ${String(_ctMode + (_ctMode === 'down_weight' ? ` × ${_ctMult}` : '')).padEnd(48)}║
║  Started ${etTimeString()} ET                                                 ║
╚══════════════════════════════════════════════════════════════════════╝
`);
  jAlert('INFO', 'Pine webhook server started', { port: PORT, counterTrendMode: _ctMode, counterTrendDownweight: _ctMult });
});
