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
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { orderGate, sendOrder, closePosition } from './paperTrading.js';
import { jSignal, jGateBlock, jAlert, jError } from './journal.js';
import { evaluateCounterTrend }               from './signalConfidence.js';

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

  console.log(`  [PINE-ALERT] ${instrument} ${direction} | engine ${engine} | conf ${confidence} | price ${price} | ${etTimeString()} ET`);

  // Journal every inbound Pine alert at receipt — BEFORE any gate or
  // downstream code path. Prevents the "[PINE-ALERT] logged to console but
  // no journal record" gap that hid today's webhook outages from the
  // post-mortem dataset. Subsequent records (GATE_BLOCK / SIGNAL / ERROR /
  // ENTRY) then narrate what happened to this specific alert.
  try {
    jAlert('INFO', 'pine-alert.inbound', { instrument, direction, engine, confidence, price, vwap, alertName, et: etTimeString() });
  } catch {}

  // RTH gate
  if (!isTradingHours()) {
    jGateBlock(engine, instrument, direction, 'OUT_OF_HOURS', { etTime: etTimeString() });
    return send(res, 200, { ok: false, reason: 'OUT_OF_HOURS', et: etTimeString() });
  }

  // ATR-based option price fallback (Webull chain API_DISABLED)
  const optEst = parseFloat((price * 0.005 * 0.4).toFixed(2));
  if (optEst <= 0.05) {
    jGateBlock(engine, instrument, direction, 'PRICE_TOO_LOW', { optEst, price });
    return send(res, 200, { ok: false, reason: 'PRICE_TOO_LOW', optEst });
  }

  // §19 — Signal reversal exit
  try {
    const lg = JSON.parse(readFileSync(LEDGER_FILE, 'utf8'));
    const oppositeOpen = (lg.trades ?? []).find(t =>
      t.instrument === instrument && t.status === 'OPEN' &&
      t.signal !== direction && t.engine !== 'SWING'
    );
    if (oppositeOpen) {
      const entryU = oppositeOpen.underlyingPrice ?? price;
      const dirMult = oppositeOpen.signal === 'CALLS' ? 1 : -1;
      const optMove = (price - entryU) * dirMult * 0.4;
      const synthExit = Math.max(0.01, parseFloat((oppositeOpen.fillPrice + optMove).toFixed(4)));
      const closed = closePosition(oppositeOpen.requestId, synthExit, 'SIGNAL_REVERSAL');
      if (closed) {
        console.log(`  [SIGNAL_REVERSAL] Closed ${instrument} ${oppositeOpen.signal} at $${synthExit.toFixed(2)} (entry $${oppositeOpen.fillPrice}) — ${engine} flipped to ${direction}`);
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
    } else {
      _macro4HSrc = `no-family-mapping:${instrument}`;
    }
  } catch (e) {
    _macro4HSrc = `read-fail:${(e.message || '').slice(0, 40)}`;
  }

  const ctGate = evaluateCounterTrend(_macro4H, direction, engine);
  if (ctGate.action === 'block') {
    jGateBlock(engine, instrument, direction, 'COUNTER_TREND_BLOCK', {
      macro4H: _macro4H, macro4HSrc: _macro4HSrc, mode: 'block',
    });
    return send(res, 200, { ok: false, reason: 'COUNTER_TREND_BLOCK', macro4H: _macro4H });
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
  };

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
