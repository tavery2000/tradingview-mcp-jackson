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

import http from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { orderGate, sendOrder, closePosition } from './paperTrading.js';
import { jSignal, jGateBlock, jAlert, jError } from './journal.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

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

  // Build consensus — Pine-driven, minimal
  const consensus = {
    signal:           direction,
    engine,
    confidence,
    finalConfidence:  confidence === 'HIGH' ? 1.5 : 1.0,
    instrument,
    strike,
    expiry,
    entryPrice:       optEst,
    underlyingPrice:  price,
    contracts:        1,
    pineAlert:        true,
    alertName,
    vwap,
  };

  const reqId = orderGate.createRequest({ signal: direction, engine });
  const fill  = await sendOrder(consensus, reqId, { mid: optEst });

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
║  Started ${etTimeString()} ET                                                 ║
╚══════════════════════════════════════════════════════════════════════╝
`);
  jAlert('INFO', 'Pine webhook server started', { port: PORT });
});
