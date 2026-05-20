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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { orderGate, sendOrder, closePosition } from './paperTrading.js';
import { jSignal, jGateBlock, jAlert, jError } from './journal.js';
import { evaluateCounterTrend }               from './signalConfidence.js';
import { startPreSwitchScheduler }            from './preSwitchKill.js';
import { startCalibrationScheduler }          from './calibrationScheduler.js';
// 2026-05-17 EOD: Path 2 RESTORED for paper futures simulation.
// MCP wrapper stays loaded + connected (47 tools available for snapshots,
// account queries, June 1 production flip) but futures execution flows
// through futuresTrading.js → futures-ledger.json instead of MCP.
// See webull-mcp-client.js header for MCP "parked" notes.
import { placeFuturesOrder as placeFuturesPath2, futuresOrderGate, tryAutoResumeCircuitBreaker, clearCircuitBreaker, flattenAllFutures, getFuturesGateStatus, isCircuitBreakerTripped } from './futuresTrading.js';
import { flattenAllEquity } from './paperTrading.js';
import { getWebullMCP, isMCPDisabled, isIntegrationHalted }        from './webull-mcp-client.js';
// 2026-05-19 — Vision Phase 5: fire-and-forget DRY-RUN scoring on every
// successful entry. Loaded lazily via dynamic import in the scoring
// helper so a missing module / API-key issue doesn't crash webhook boot.
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
  let   engine     = body.engine     ?? 'PINE';   // mutable: FADE_CANDIDATE promotes to FADE
  const confidence = body.confidence ?? 'MEDIUM';
  // P1-5-B (2026-05-14 EOD): structure-based stop fields from Pine.
  // CALLS: invalidation_level = prevSwingLow (HL pivot low).
  // PUTS:  invalidation_level = prevSwingHigh (LH pivot high).
  // null when Pine has no recent pivot (early in session, or no struct).
  const invalidation_level = (body.invalidation_level == null || body.invalidation_level === 'null')
    ? null : Number(body.invalidation_level);
  const structure_type     = body.structure_type || null;

  // 2026-05-18: Pine now emits `timeframe` (e.g. "5", "1", "15") so we can
  // gate by TF. Older Pine versions without the field log as "—".
  // 2026-05-19: Pine `payloadJSON` switched to emitting `tf` (minutes int) —
  // prefer that, fall back to legacy `timeframe` field for back-compat with
  // any TV alerts still using the older Pine version.
  const timeframe = body.tf != null ? String(body.tf)
                  : body.timeframe != null ? String(body.timeframe)
                  : '—';
  console.log(`  [PINE-ALERT] ${instrument} ${direction} | engine ${engine} | conf ${confidence} | price ${price} | tf ${timeframe} | ${etTimeString()} ET`);

  // §FIX12 (Pine 2026-05-19 EOD) — parse zone coords if Pine emitted them
  function _numOrNullField(v) {
    if (v == null || v === 'null' || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : null;
  }
  const pineSupLower = _numOrNullField(body.nearest_supply_lower);
  const pineSupUpper = _numOrNullField(body.nearest_supply_upper);
  const pineDemLower = _numOrNullField(body.nearest_demand_lower);
  const pineDemUpper = _numOrNullField(body.nearest_demand_upper);

  // Journal every inbound Pine alert at receipt — BEFORE any gate or
  // downstream code path. Prevents the "[PINE-ALERT] logged to console but
  // no journal record" gap that hid today's webhook outages from the
  // post-mortem dataset. Subsequent records (GATE_BLOCK / SIGNAL / ERROR /
  // ENTRY) then narrate what happened to this specific alert.
  try {
    jAlert('INFO', 'pine-alert.inbound', { instrument, direction, engine, confidence, price, vwap, alertName, timeframe,
      nearest_supply_lower: pineSupLower, nearest_supply_upper: pineSupUpper,
      nearest_demand_lower: pineDemLower, nearest_demand_upper: pineDemUpper,
      et: etTimeString() });
  } catch {}

  // 2026-05-19 20:02 ET — Pine-only zone math gate.
  // Operator's 20:01:18 MES1! PUTS LIVE -$11.25 was LIVE-engine-bypass
  // through Vision (intra-bar, no time for 2s API call). Vision protection
  // missed it entirely. Now: when Pine §FIX12 emits nearest_supply/demand
  // coords, run a mechanical R:R check FIRST — works on EVERY engine
  // including LIVE, costs zero latency, no Vision dependency.
  //
  // Applies same toxic-proximity + negative-RR rules as Vision's
  // zoneMathFilter, just sourced from Pine's box objects instead of
  // model-extracted Y-axis labels. Pine is ground-truth.
  //
  // No-op when Pine coords absent (old Pine version OR zones not yet
  // formed in the session). Operator must paste Pine §FIX12 for this
  // gate to activate.
  const pineZoneGateEnabled = (process.env.PINE_ZONE_MATH_FILTER_ENABLED || 'true').toLowerCase() === 'true';
  if (pineZoneGateEnabled && price != null && (pineSupLower != null || pineDemUpper != null)) {
    const toxicPts = parseFloat(process.env.PINE_ZONE_TOXIC_POINTS || '2.0');
    const dir = (direction || '').toUpperCase();
    let block = null;
    if (dir === 'CALLS' && pineSupLower != null) {
      const upside = pineSupLower - price;
      const downside = pineDemUpper != null ? (price - pineDemUpper) : null;
      if (upside <= 0) block = { reason: 'PINE_INSIDE_OR_ABOVE_SUPPLY', upside, downside };
      else if (upside < toxicPts) block = { reason: 'PINE_TOXIC_PROXIMITY_SUPPLY', upside, downside, toxicPts };
      else if (downside != null && downside > upside) block = { reason: 'PINE_NEGATIVE_RR_TO_DEMAND', upside, downside, rr: +(upside/downside).toFixed(2) };
    } else if (dir === 'PUTS' && pineDemUpper != null) {
      const downside = price - pineDemUpper;
      const upside   = pineSupLower != null ? (pineSupLower - price) : null;
      if (downside <= 0) block = { reason: 'PINE_INSIDE_OR_BELOW_DEMAND', upside, downside };
      else if (downside < toxicPts) block = { reason: 'PINE_TOXIC_PROXIMITY_DEMAND', upside, downside, toxicPts };
      else if (upside != null && upside > downside) block = { reason: 'PINE_NEGATIVE_RR_TO_SUPPLY', upside, downside, rr: +(downside/upside).toFixed(2) };
    }
    if (block) {
      jGateBlock(engine, instrument, direction, 'PINE_ZONE_MATH_BLOCK', {
        ...block,
        pineSupLower, pineSupUpper, pineDemLower, pineDemUpper,
        price, etTime: etTimeString(),
        note: `Pine-emitted zone coords show ${block.reason} — entry blocked without Vision call (works on LIVE engine too).`,
      });
      console.log(`  🛑 PINE_ZONE_MATH_BLOCK  ${instrument} ${direction} ${engine}  ${block.reason}  upside=${block.upside?.toFixed(2)} downside=${block.downside?.toFixed(2)}`);
      return send(res, 200, { ok: false, reason: 'PINE_ZONE_MATH_BLOCK', detail: block });
    }
  }

  // 2026-05-18 — FADE engine Phase 1. Pine emits engine=FADE_CANDIDATE on
  // vol/range/VWAP-extension reversal candles. Webhook joins with
  // realtime-news.json (60s lookback, HIGH-impact) and either:
  //   - drops [FADE_DROPPED_NO_NEWS]   if no qualifying news
  //   - drops [FADE_BLACKOUT]          if inside FOMC/CPI/NFP ±15min
  //   - drops [FADE_DEDUP]             if same news_event already has active FADE
  //   - promotes engine='FADE' and falls through to gate chain. The
  //     counter-trend gate already exempts FADE engine (signalConfidence
  //     line 311: `if (engine === 'FADE') return pass;`). Sizing-floor
  //     bypass + 15min time-decay live in futuresTrading/paperTrading.
  if (engine === 'FADE_CANDIDATE') {
    const newsEvent = _findFadeNewsEvent();
    if (!newsEvent) {
      jGateBlock(engine, instrument, direction, 'FADE_DROPPED_NO_NEWS', {
        etTime: etTimeString(), note: 'No HIGH-impact news within 60s of FADE_CANDIDATE',
      });
      return send(res, 200, { ok: false, reason: 'FADE_DROPPED_NO_NEWS' });
    }
    const blackout = _checkFadeBlackout();
    if (blackout) {
      jGateBlock(engine, instrument, direction, 'FADE_BLACKOUT', {
        etTime: etTimeString(), event: blackout.event, minutesUntil: blackout.minutesUntil,
        note: 'Macro event ±15min — true regime shift, not algo pop',
      });
      return send(res, 200, { ok: false, reason: 'FADE_BLACKOUT', event: blackout.event });
    }
    const newsEventId = _fadeNewsEventId(newsEvent);
    if (_fadeEventActive(newsEventId)) {
      jGateBlock(engine, instrument, direction, 'FADE_DEDUP', {
        etTime: etTimeString(), newsEventId, headline: newsEvent.headline.slice(0, 80),
      });
      return send(res, 200, { ok: false, reason: 'FADE_DEDUP', newsEventId });
    }
    _fadeMarkEventActive(newsEventId);
    // Promote in-place. `engine` local + body.engine both flip so all
    // downstream paths (gate eval, dispatch, journal) see 'FADE'.
    engine               = 'FADE';
    body.engine          = 'FADE';
    body.fadeNewsEventId = newsEventId;
    body.fadeHeadline    = newsEvent.headline.slice(0, 200);
    body.fadeEventAgeS   = Math.floor((Date.now() - newsEvent.ts) / 1000);
    // body.high and body.low already present from Pine's alertcondition template
    console.log(`  ⚡ FADE_PROMOTED ${instrument} ${direction} @ ${price} — news age=${body.fadeEventAgeS}s "${newsEvent.headline.slice(0,80)}"`);
    try { jAlert('INFO', 'FADE_PROMOTED', { instrument, direction, price, newsEventId, headline: body.fadeHeadline, eventAgeS: body.fadeEventAgeS }); } catch {}
  }

  // 2026-05-19 — Multi-TF divergence detection (Commit B).
  // Always records this alert in the multi-TF state map BEFORE any gate
  // that might short-circuit return — divergence detection needs to see
  // every alert across both timeframes. Logging-only, no gate.
  const _tfDiv = _checkTfDivergence(instrument, direction, timeframe);
  if (_tfDiv) {
    try {
      jAlert('INFO', 'TF_' + _tfDiv.kind, {
        instrument, direction, tf: timeframe,
        otherTf: _tfDiv.otherTf, otherDirection: _tfDiv.otherDirection,
        ageMs: _tfDiv.ageMs, engine, confidence, etTime: etTimeString(),
        note: _tfDiv.kind === 'DIVERGENCE'
          ? 'Multi-TF disagreement — signals on different TFs oppose each other within 5min window.'
          : 'Multi-TF agreement — both timeframes show same direction.',
      });
      if (_tfDiv.kind === 'DIVERGENCE') {
        console.log(`  ⚠ TF_DIVERGENCE  ${instrument} ${direction}@${timeframe}m  vs  ${_tfDiv.otherDirection}@${_tfDiv.otherTf}m  (${Math.round(_tfDiv.ageMs/1000)}s ago)`);
      }
    } catch {}
  }

  // 2026-05-19 — Chop-mode bias-flip suppression (Item #10).
  // Pairs with the 3M-primary deploy as the safety net for whipsaw tape.
  // Reads monitor.js TREND-engine SIGNAL history for this instrument;
  // if direction flipped >N times in 15min, suppress until 10min of
  // stable bias. Validated this morning's 10:32-10:37 SPY whipsaw
  // episode would have triggered (3 flips inside 5 min).
  const _chop = _checkChopMode(instrument);
  if (_chop.chop) {
    jGateBlock(engine, instrument, direction, 'CHOP_MODE_ACTIVE', {
      flips: _chop.flips, signalsInWindow: _chop.signalsInWindow,
      flipsWindowMs: _chop.flipsWindowMs, stableHoldMs: _chop.stableHoldMs,
      sinceLastFlipMs: _chop.sinceLastFlipMs, lastFlipAt: _chop.lastFlipAt,
      etTime: etTimeString(),
      note: `Bias whipsawed ${_chop.flips} times in ${Math.round(_chop.flipsWindowMs/60000)} min; require ${Math.round(_chop.stableHoldMs/60000)} min of stable bias before re-enabling alerts.`,
    });
    console.log(`  🛑 CHOP_MODE_ACTIVE  ${instrument}  flips=${_chop.flips}  sinceLastFlip=${Math.round(_chop.sinceLastFlipMs/1000)}s`);
    return send(res, 200, { ok: false, reason: 'CHOP_MODE_ACTIVE', flips: _chop.flips, sinceLastFlipMs: _chop.sinceLastFlipMs });
  }

  // 2026-05-19 — Stretched-from-extreme gate (interim until Vision live).
  // Pattern: pivot engines fire SELL/BUY at bottom/top of completed move and
  // lose -$15-25 on the natural mean-revert bounce. Today's example: SPY LH
  // PUTS fired at 733.16 (below PDL 733.39) after a 738→732 move was already
  // done. Two legs: VWAP-stretch (price too far from VWAP for the signal
  // direction) and PD-stretch (selling below PDL / buying above PDH).
  // Runs BEFORE existing gates per operator spec. Applies to SPY/QQQ/IWM
  // (instruments with a {sym}-levels.json on disk); futures fall through.
  const _stretched = _checkStretchedFromExtreme(instrument, direction, price);
  if (_stretched.block) {
    jGateBlock(engine, instrument, direction, _stretched.reason, {
      ..._stretched.details,
      etTime: etTimeString(),
      note: 'Interim late-fire mitigation — Vision API replaces this gate when live.',
    });
    return send(res, 200, { ok: false, reason: _stretched.reason, ..._stretched.details });
  }

  // 2026-05-18 — Stacked-entry dedup. {instrument|direction|5m-bar-floor}
  // bucket; first engine wins. Multiple engines firing on the same Pine
  // bar are confluence on ONE setup, not N independent positions.
  //
  // 2026-05-19 14:54 ET split: PEEK here (no claim) — catches obvious
  // duplicates early without wasting compute on the gate stack. CLAIM is
  // deferred until right before dispatch (after counter-trend, Vision,
  // and all other gates pass). Prevents the bug where a SELL blocked by
  // counter-trend was registered as "first engine" and dedup-blocked the
  // subsequent HTF + ZONE alerts that would have been valid.
  const _dedup = _peekStackedDedup(instrument, direction, engine);
  if (_dedup.duplicate) {
    jGateBlock(engine, instrument, direction, 'STACKED_ENTRY_DEDUP', {
      firstEngine:  _dedup.firstEngine,
      ageMs:        _dedup.ageMs,
      bucketKey:    _dedup.key,
      etTime:       etTimeString(),
      note:         _dedup.reason === 'OPEN_POSITION_EXISTS'
        ? 'Open position already exists for instrument+direction (incl. futures micro-fallback target).'
        : 'Same instrument+direction within same 5m bar bucket — first engine opened the position; this is logged as confluence-only.',
    });
    return send(res, 200, { ok: false, reason: 'STACKED_ENTRY_DEDUP', firstEngine: _dedup.firstEngine });
  }

  // 2026-05-18 — Timeframe gate. Operator switched HANK signal source from 1M
  // → 5M after side-by-side comparison; the 6-fix tuning package (commit
  // c41384b) was insufficient to overcome 1M noise. ACCEPTED_TIMEFRAMES is
  // a comma-separated env list (default "5"). Alerts arriving with any other
  // timeframe value are rejected with a LOUD gate-block — operator needs to
  // know if old 1M alerts are still firing in TradingView. Missing timeframe
  // (older Pine without the field) is allowed for backward compat.
  const _acceptedTfs = (process.env.ACCEPTED_TIMEFRAMES || '5')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (timeframe !== '—' && !_acceptedTfs.includes(timeframe)) {
    jGateBlock(engine, instrument, direction, 'IGNORED_TIMEFRAME', {
      timeframe, accepted: _acceptedTfs, etTime: etTimeString(),
      note: 'Disable this alert in TradingView — HANK only listens to the configured TFs.',
    });
    return send(res, 200, { ok: false, reason: 'IGNORED_TIMEFRAME', timeframe, accepted: _acceptedTfs });
  }

  // 2026-05-18 — Eager circuit-breaker auto-resume probe.
  // Runs BEFORE any gate evaluation so an alert arriving after the cooldown
  // window has elapsed clears the breaker even if no in-window entry
  // attempts had reached the futures-side entry check. Idempotent: no-op
  // when not tripped. Fixes the 2026-05-18 deadlock where the breaker
  // stayed tripped 9h post-cooldown because no entries had been attempted
  // during the cooldown window to trigger the lazy clear path.
  try { tryAutoResumeCircuitBreaker(); }
  catch (e) { console.error(`  [WEBHOOK] eager CB auto-resume probe error: ${e.message}`); }

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
    // 2026-05-18: write `last` alongside `price` so futures-status.js (which
    // reads .last) and the futuresPricer-fed readers see a consistent shape.
    // Pine-alert is authoritative — clear any prior stale flag from the poller.
    cache[instrument] = {
      ...(cache[instrument] || {}),
      last: price,
      price,
      ts: Date.now(),
      et: etTimeString(),
      src: 'pine-alert',
      stale: false,
      staleSince: null,
      lastFailReason: null,
    };
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

  // LATE_DAY_ENTRY_0DTE gate moved to AFTER selectContract (2026-05-18) so
  // we can read the resolved option expiry and only block when exp = today.
  // 1DTE+ entries after 15:30 ET pass — no theta-burn catastrophe risk on
  // a contract that doesn't expire for another 24+ hours.

  // ── Counter-trend gate (2026-05-13) ─────────────────────────────────────
  // Reads macro4h-{spy|qqq|iwm}.json (per-monitor poll cycle) for the
  // instrument's family. SPY/ES1!/MES1! → spy, QQQ/NQ1!/MNQ1! → qqq, IWM → iwm.
  // Stale files (>5 min old) fall back to UNKNOWN which never trips the gate.
  // Mode = off | down_weight (default) | block — set via COUNTER_TREND_MODE env.
  let _macro4H      = 'UNKNOWN';
  let _macro4HSrc   = 'no-lookup';
  let _macro4HFresh = false;
  let _macro1H      = { trendBias: 'NEUTRAL', structurePattern: 'NEUTRAL' };
  let _macro1HSrc   = 'no-lookup';
  let _macro1HFresh = false;
  try {
    const family =
      instrument === 'SPY'  || instrument === 'ES1!' || instrument === 'MES1!' ? 'spy' :
      instrument === 'QQQ'  || instrument === 'NQ1!' || instrument === 'MNQ1!' ? 'qqq' :
      instrument === 'IWM'                                                       ? 'iwm' : null;
    // 2026-05-19 14:54 ET: stale threshold widened 5min → 15min after operator
    // hit COUNTER_TREND_STALE_BOTH_FUTURES with bias 10.6min stale during RTH.
    // monitor.js write cadence is variable (especially during the 14:00-15:00
    // mid-afternoon lull); a 5min window was too tight. Env-tunable.
    const _macroStaleMaxMin = parseFloat(process.env.MACRO_BIAS_MAX_STALE_MIN || '15');
    if (family) {
      const file = join(__dirname, `macro4h-${family}.json`);
      const data = JSON.parse(readFileSync(file, 'utf8'));
      const ageMin = (Date.now() - (data.ts ?? 0)) / 60000;
      if (ageMin > _macroStaleMaxMin) {
        _macro4HSrc = `stale:${ageMin.toFixed(1)}min`;
      } else {
        _macro4H      = data.macro4H ?? 'UNKNOWN';
        _macro4HSrc   = `${family}:${ageMin.toFixed(1)}min`;
        _macro4HFresh = true;
      }
      // P0 (2026-05-15 EOD): read 1H bias for the structural gate
      try {
        const f1H = join(__dirname, `macro1h-${family}.json`);
        const d1H = JSON.parse(readFileSync(f1H, 'utf8'));
        const age1H = (Date.now() - (d1H.ts ?? 0)) / 60000;
        if (age1H > _macroStaleMaxMin) {
          _macro1HSrc = `stale:${age1H.toFixed(1)}min`;
        } else {
          _macro1H      = { trendBias: d1H.trendBias ?? 'NEUTRAL', structurePattern: d1H.structurePattern ?? 'NEUTRAL' };
          _macro1HSrc   = `${family}:${age1H.toFixed(1)}min`;
          _macro1HFresh = true;
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

  // 2026-05-18 (audit D): futures fail-closed when BOTH 1H and 4H bias are stale.
  // monitor.js writes macro{1h,4h}-spy.json only inside isMarketHours() (07:00-16:00 ET),
  // so during the CME 23/5 overnight window the gate's data source is dark and
  // evaluateCounterTrend silently falls back to NEUTRAL/UNKNOWN — letting counter-trend
  // futures alerts through unfiltered. Audit confirmed via overnight 5/17→5/18 diagnostic
  // (4 HL/ZONE/BUY CALLS lost $101 into a downtrend the PUTS engines correctly traded).
  // Conservative fail-closed: block futures-instrument entries when both biases are stale.
  // Proper fix (audit B) is a futures-1H monitor; tracked for post-close 5/18.
  const _FUT_INSTRUMENTS_FOR_GATE = new Set(['ES1!', 'NQ1!', 'MES1!', 'MNQ1!']);
  const _isFuturesInst = _FUT_INSTRUMENTS_FOR_GATE.has(instrument);

  // 2026-05-18 OVERNIGHT FUTURES BYPASS (operator decision):
  // Futures trade 23/5 but bias is RTH-only. Block during overnight would
  // zero out signal collection. Trading without bias confirmation is the
  // accepted trade-off for data flow until Webull MCP US_FUTURES quote
  // subscription activates 2026-06-01 (broker-grade overnight bias source).
  // Bypass ONLY for futures (ES1!/NQ1!/MES1!/MNQ1!) outside 09:30-16:00 ET
  // Mon-Fri. Equity options don't trade overnight; no bypass for them.
  const _isRTH = (() => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
    if (m.weekday === 'Sat' || m.weekday === 'Sun') return false;
    const totalMin = parseInt(m.hour, 10) * 60 + parseInt(m.minute, 10);
    return totalMin >= 9 * 60 + 30 && totalMin < 16 * 60;
  })();
  const _ctBypassOvernightFutures = _isFuturesInst && !_isRTH;

  // Default pass — overridden by evaluateCounterTrend below when gate runs.
  // When bypass fires, this default flows downstream (finalConfidence math).
  let ctGate = { action: 'pass', multiplier: 1.0 };

  if (_ctBypassOvernightFutures) {
    console.log(`  ✓ COUNTER_TREND_BYPASSED_OVERNIGHT  ${instrument} ${direction} engine=${engine} — RTH bias stale, futures overnight session unblocked for data collection`);
    try { jAlert('INFO', 'COUNTER_TREND_BYPASSED_OVERNIGHT', { instrument, direction, engine, macro4HSrc: _macro4HSrc, macro1HSrc: _macro1HSrc, etTime: etTimeString() }); } catch {}
  } else {
    if (_isFuturesInst && !_macro1HFresh && !_macro4HFresh) {
      jGateBlock(engine, instrument, direction, 'COUNTER_TREND_STALE_BOTH_FUTURES', {
        macro4H: _macro4H, macro4HSrc: _macro4HSrc,
        macro1H: _macro1H, macro1HSrc: _macro1HSrc,
        instrumentClass: 'futures',
        note: 'Both 1H and 4H bias files stale; futures fail-closed pending macro1h-futures monitor (audit B, due 2026-05-18 post-close).',
      });
      return send(res, 200, {
        ok: false, reason: 'COUNTER_TREND_STALE_BOTH_FUTURES',
        macro4HSrc: _macro4HSrc, macro1HSrc: _macro1HSrc,
      });
    }

    // P1-7 (2026-05-14) + P0 (2026-05-15): pass instrument AND macro1H so
    // evaluateCounterTrend can apply instrument-class mode AND block on
    // opposing 1H trendBias / structurePattern (today's 14:15 MES1! bug).
    ctGate = evaluateCounterTrend(_macro4H, direction, engine, instrument, _macro1H);
    if (ctGate.action === 'block') {
      jGateBlock(engine, instrument, direction, 'COUNTER_TREND_BLOCK', {
        macro4H: _macro4H, macro4HSrc: _macro4HSrc,
        macro1H: _macro1H, macro1HSrc: _macro1HSrc,
        mode: 'block', source: ctGate.source ?? '4H',
        instrumentClass: ctGate.instrumentClass ?? null,
      });
      return send(res, 200, { ok: false, reason: 'COUNTER_TREND_BLOCK', macro4H: _macro4H, macro1H: _macro1H, source: ctGate.source ?? '4H' });
    }
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

  // LATE_DAY_ENTRY_0DTE gate (2026-05-18 exp-aware). Was: block ALL SPY/
  // QQQ/IWM entries after 15:30 ET. Operator clarified that the theta-burn
  // risk only applies to 0DTE contracts (expiry = today); 1DTE+ contracts
  // have ~24hr of value left and shouldn't be blocked.
  // Toggle off via LATE_DAY_ENTRY_0DTE_EXP_CHECK=false (restores original
  // block-all behavior — useful for fast revert).
  const ZERO_DTE_INSTRUMENTS = new Set(['SPY', 'QQQ', 'IWM']);
  if (ZERO_DTE_INSTRUMENTS.has(instrument)) {
    const t = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
    const [h, m] = t.split(':').map(Number);
    const etMins = h * 60 + m;
    if (etMins >= 15 * 60 + 30) {
      const _expCheck = (process.env.LATE_DAY_ENTRY_0DTE_EXP_CHECK || 'false').toLowerCase() === 'true';
      const _todayET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
      const _isZeroDte = !expiry || expiry === _todayET;   // if no expiry resolved, treat as 0DTE for safety
      if (!_expCheck || _isZeroDte) {
        jGateBlock(engine, instrument, direction, 'LATE_DAY_ENTRY_0DTE', {
          etTime: etTimeString(), etMins, cutoffMins: 15 * 60 + 30,
          expiry, todayET: _todayET, expCheckEnabled: _expCheck,
          note: _expCheck ? '0DTE detected (exp = today); theta-burn risk' : 'exp-check disabled — blocking all SPY/QQQ/IWM',
        });
        return send(res, 200, { ok: false, reason: 'LATE_DAY_ENTRY_0DTE', et: etTimeString(), expiry });
      }
      // 1DTE+ passes — log once for visibility
      console.log(`  ✓ LATE_DAY_PASS_1DTE+  ${instrument} ${direction}  exp=${expiry} (today=${_todayET})  — past 15:30 ET but contract not expiring today`);
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
    // 2026-05-18 FADE engine context (only populated when engine='FADE'):
    fadeBarHigh:            body.high  ?? null,    // entry candle high — for PUTS stop calc
    fadeBarLow:             body.low   ?? null,    // entry candle low  — for CALLS stop calc
    fadeNewsEventId:        body.fadeNewsEventId ?? null,
    fadeHeadline:           body.fadeHeadline ?? null,
    fadeEventAgeS:          body.fadeEventAgeS ?? null,
  };

  // 2026-05-17 EOD: WEBULL_INTEGRATION_HALT remains a global circuit-breaker
  // for ALL trading (Path 2 included). Operator's tier-3 rollback flag.
  if (isIntegrationHalted()) {
    jGateBlock(engine, instrument, direction, 'WEBULL_INTEGRATION_HALT', { etTime: etTimeString() });
    return send(res, 200, { ok: false, reason: 'WEBULL_INTEGRATION_HALT' });
  }

  // 2026-05-19 — Vision Phase 5 sync gate. Last gate before dispatch.
  // Awaits screenshot + Haiku 4.5 score (~2s). REJECT below threshold
  // (default 3.0). LIVE engine bypasses (intra-bar). API error fails open
  // by default (don't block trade on infra hiccup).
  const _vis = await _evaluateVisionGate(consensus);
  if (_vis.action === 'reject') {
    const blockReason = _vis.reason === 'zone_math_block'    ? 'VISION_REJECT_ZONE_MATH'
                      : _vis.reason === 'action_mult_zero'   ? 'VISION_REJECT_ACTION_ZERO'
                      : _vis.reason === 'zone_invalid_setup' ? 'VISION_REJECT_ZONE_INVALID'
                      : _vis.reason === 'late_fire_veto'     ? 'VISION_REJECT_VETO'
                      : 'VISION_REJECT_LOW_SCORE';
    jGateBlock(engine, instrument, direction, blockReason, {
      composite: _vis.score?.composite,
      tier: _vis.score?.tier,
      lateFireVeto: _vis.score?.lateFireVeto,
      zoneSetupQuality: _vis.score?.zoneSetupQuality,
      actionMultiplier: _vis.score?.actionMultiplier,
      structureState: _vis.score?.structureState,
      detectedSupplyZone: _vis.score?.detectedSupplyZone,
      detectedDemandZone: _vis.score?.detectedDemandZone,
      currentPriceVision: _vis.score?.currentPriceVision,
      zoneMathBlock: _vis.zoneMathBlock,
      rejectThreshold: _vis.rejectThreshold,
      rejectCause: _vis.rejectCause,
      reasoning: _vis.score?.reasoning,
      latencyMs: _vis.totalLatencyMs,
      etTime: etTimeString(),
      note: `${_vis.rejectCause}. Reasoning: ${_vis.score?.reasoning || '(none)'}`,
    });
    return send(res, 200, {
      ok: false, reason: blockReason,
      composite: _vis.score?.composite, tier: _vis.score?.tier,
      lateFireVeto: _vis.score?.lateFireVeto,
      rejectThreshold: _vis.rejectThreshold,
    });
  }

  // 2026-05-19 14:54 ET — FINAL dedup claim (split from the early peek).
  // All gates passed; claim the bucket NOW so subsequent same-bar engines
  // dedup against THIS engine (which actually opens a position) rather
  // than some earlier gate-blocked alert that never reached dispatch.
  // Re-checks position-open + bucket atomically in case the 2s Vision
  // wait window had another alert squeeze in.
  const _dedupClaim = _claimStackedDedup(instrument, direction, engine);
  if (_dedupClaim.duplicate) {
    jGateBlock(engine, instrument, direction, 'STACKED_ENTRY_DEDUP', {
      firstEngine: _dedupClaim.firstEngine,
      ageMs: _dedupClaim.ageMs,
      bucketKey: _dedupClaim.key,
      etTime: etTimeString(),
      note: 'Race-window block: another alert claimed the bucket while this one was in the gate stack (Vision wait, etc).',
    });
    return send(res, 200, { ok: false, reason: 'STACKED_ENTRY_DEDUP', firstEngine: _dedupClaim.firstEngine });
  }
  // WEBULL_MCP_DISABLED check intentionally removed from the dispatch chain
  // — MCP is parked, Path 2 doesn't depend on it. Re-add when MCP becomes
  // primary again at the 6/1 production flip.

  if (_FUTURES_INSTRUMENTS.has(instrument.toUpperCase())) {
    // 2026-05-17 EOD: futures route to Path 2 (futuresTrading.js).
    // MCP wrapper stays warm but isn't on the execution path.
    let futReqId, futTrade;
    try {
      futReqId = futuresOrderGate.createRequest({ signal: direction, engine });
      futTrade = placeFuturesPath2(consensus, futReqId);
    } catch (e) {
      jError('WEBHOOK', 'PATH2_FUTURES_THREW', { message: e.message, stack: e.stack?.slice(0,600), instrument, direction, engine, futReqId });
      return send(res, 500, { ok: false, reason: 'PATH2_FUTURES_THREW', error: e.message });
    }
    if (futTrade && futTrade.vetoed) {
      return send(res, 200, { ok: false, reason: 'FUT_VETOED', detail: futTrade.reason });
    }
    console.log(`  [PATH2] futures entry ${instrument} ${direction} ${engine}  tier=${futTrade?.tier}  ${futTrade?.contracts}c`);
    return send(res, 200, { ok: true, dispatch: 'futures-path2', requestId: futReqId, tier: futTrade?.tier, contracts: futTrade?.contracts });
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

// ─── Stacked-entry dedup (2026-05-18) ────────────────────────────────────────
// Multiple engines firing on the same Pine bar are CONFIRMATION of one
// setup, not N independent positions. Buckets by {instrument|direction|
// 5m-bar-floor} — first engine to land in the bucket opens the trade;
// subsequent ones get gate-blocked as STACKED_ENTRY_DEDUP and logged
// with the first-engine reference for post-session confluence analysis.
// Applies to BOTH futures and equity paths (webhook-level — earlier than
// the futuresTrading-internal FUT_DUPLICATE_CONFLUENCE which only covered
// Path 2 via 60s rolling window).
const _STACK_DEDUP_BUCKET_MS = 5 * 60 * 1000;
const _STACK_DEDUP_GC_AFTER_MS = 6 * 60 * 1000;
const _stackDedupMap = new Map();   // key → { firstEngine, ts }

function _stackedDedupKey(instrument, direction, nowMs) {
  const bar5m = Math.floor(nowMs / _STACK_DEDUP_BUCKET_MS) * _STACK_DEDUP_BUCKET_MS;
  return `${instrument}|${direction}|${bar5m}`;
}

// ─── Multi-TF divergence detection (2026-05-19, Commit B) ──────────────────
// Operator deploys 3M primary + 5M context per Tuesday afternoon spec.
// When alerts arrive on BOTH timeframes for the same instrument within a
// short window, check whether they AGREE or DISAGREE. We don't block on
// divergence here — just journal it so operator can correlate divergence
// frequency with downstream outcomes. If validation says divergence
// predicts losers, a future deploy can turn TF_DIVERGENCE into a gate.
//
// State: per-(instrument, tf) → { direction, ts }. Lookup the OTHER tf's
// recent direction on each inbound; classify.
const _recentTfAlerts = new Map();   // key=`${inst}|${tf}` → {direction, ts}
const _TF_DIVERGENCE_WINDOW_MS = 5 * 60 * 1000;  // 5 min

function _checkTfDivergence(instrument, direction, tf) {
  if (!tf || tf === '—') return null;
  const now = Date.now();
  const acceptedTfs = (process.env.ACCEPTED_TIMEFRAMES || '3,5')
    .split(',').map(s => s.trim()).filter(Boolean);
  // Only meaningful when ≥2 TFs are accepted
  if (acceptedTfs.length < 2) return null;

  // Record this alert
  _recentTfAlerts.set(`${instrument}|${tf}`, { direction, ts: now });

  // Check every OTHER accepted TF for a recent alert
  for (const otherTf of acceptedTfs) {
    if (otherTf === tf) continue;
    const other = _recentTfAlerts.get(`${instrument}|${otherTf}`);
    if (!other) continue;
    if (now - other.ts > _TF_DIVERGENCE_WINDOW_MS) continue;
    const ageMs = now - other.ts;
    if (other.direction === direction) {
      return { kind: 'CONFLUENCE', otherTf, otherDirection: other.direction, ageMs };
    } else {
      return { kind: 'DIVERGENCE', otherTf, otherDirection: other.direction, ageMs };
    }
  }
  return null;
}

// ─── Chop-mode bias-flip suppression (2026-05-19, Item #10) ────────────────
// Pairs with the 3M-primary deploy as the safety net for whipsaw tape.
// monitor.js emits SIGNAL events with engine='TREND' and a direction read.
// When TREND direction flips >N times in M minutes for a given instrument,
// mark that instrument as CHOP_MODE and suppress engine alerts until the
// direction holds steady for K minutes.
//
// IMPORTANT: only count flips on the TREND engine subtype. monitor.js
// emits multiple SIGNAL records per tick (TREND/STRUCTURE/MAG6/RATIO/FADE)
// with independent direction reads. Counting all of them produces 8-12
// "flips" per minute even when actual bias is steady (validated this
// morning during 10:32-10:37 SPY whipsaw episode).
function _checkChopMode(instrument) {
  if ((process.env.CHOP_MODE_ENABLED || 'true').toLowerCase() === 'false') {
    return { chop: false };
  }
  const flipsWindowMs = parseInt(process.env.CHOP_FLIPS_WINDOW_MS || '900000', 10);  // 15 min
  const stableHoldMs  = parseInt(process.env.CHOP_STABLE_HOLD_MS  || '600000', 10);  // 10 min
  const flipThreshold = parseInt(process.env.CHOP_FLIP_THRESHOLD  || '2', 10);
  const trendEngine   = process.env.CHOP_TREND_ENGINE || 'TREND';

  const file = join(__dirname, 'logs', 'journal', `journal-${etDateString()}.jsonl`);
  if (!existsSync(file)) return { chop: false };
  const cutoff = Date.now() - flipsWindowMs;

  let trendDirs = [];
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    // Walk newest→oldest, stop early once we're past the window
    for (let i = lines.length - 1; i >= 0; i--) {
      let j;
      try { j = JSON.parse(lines[i]); } catch { continue; }
      if (!j.ts || j.ts < cutoff) break;
      if (j.type !== 'SIGNAL') continue;
      if (j.engine !== trendEngine) continue;
      if (j.instrument !== instrument) continue;
      if (!j.direction) continue;
      trendDirs.push({ ts: j.ts, dir: j.direction });
    }
  } catch { return { chop: false }; }

  if (trendDirs.length < 2) return { chop: false };
  // Reverse to chronological (we walked backward)
  trendDirs.reverse();

  // Count direction CHANGES (flips, not raw signal count)
  let flips = 0;
  let lastDir = trendDirs[0].dir;
  let lastFlipTs = trendDirs[0].ts;
  for (let i = 1; i < trendDirs.length; i++) {
    if (trendDirs[i].dir !== lastDir) {
      flips++;
      lastFlipTs = trendDirs[i].ts;
      lastDir = trendDirs[i].dir;
    }
  }

  if (flips > flipThreshold) {
    // Check stability: only suppress if last flip was recent (less than stableHold ago).
    // Once we have stableHoldMs of quiet, bias is stable again → release suppression.
    const sinceLastFlip = Date.now() - lastFlipTs;
    if (sinceLastFlip < stableHoldMs) {
      return {
        chop: true, flips,
        flipsWindowMs, stableHoldMs,
        sinceLastFlipMs: sinceLastFlip,
        firstSampleAt: trendDirs[0].ts,
        lastFlipAt:    lastFlipTs,
        signalsInWindow: trendDirs.length,
      };
    }
  }
  return { chop: false, flips, signalsInWindow: trendDirs.length };
}

function etDateString() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  return `${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}-${parts.find(p=>p.type==='day').value}`;
}

// ─── Stretched-from-extreme gate (2026-05-19, interim until Vision live) ───
// Operator pattern observed today: pivot engines (LH/HL/SELL/BUY/ZONE) fire
// SELL/BUY at the bottom/top of a completed move and lose -$15-25 on the
// natural mean-revert bounce. Example: 11:00:06 SPY PUTS LH @733.16 fired
// AFTER a 738→732 move had already completed; trade stopped out within
// minutes when price reverted toward VWAP/PDL.
//
// Two interim gates run BEFORE existing gates (operator spec 2026-05-19):
//   (1) STRETCHED_FROM_VWAP — abs(price - vwap) > N × ATR_estimate
//   (2) STRETCHED_FROM_PD   — PUTS below PDL OR CALLS above PDH
//
// Both gates apply only to instruments with a {sym}-levels.json on disk
// (SPY/QQQ/IWM today). Futures (MES1!/ES1!/etc) have no levels file → gate
// is a no-op for them and they fall through to PATH2_HALT/CB/etc as before.
//
// Env knobs:
//   STRETCHED_GATE_ENABLED        (master toggle, default true)
//   STRETCHED_VWAP_ENABLED        (vwap-leg toggle, default true)
//   STRETCHED_PD_ENABLED          (pd-leg toggle, default true)
//   STRETCHED_VWAP_ATR_MULT       (default 2.0)
//   STRETCHED_ATR_FALLBACK_SPY    (default 1.5 — until monitor.js writes live ATR)
//   STRETCHED_ATR_FALLBACK_QQQ    (default 1.8)
//   STRETCHED_ATR_FALLBACK_IWM    (default 1.0)
//
// Replaced by Vision API continuous stretch-score when Phase 5 ships.
const _STRETCHED_ATR_FALLBACK = { SPY: 1.5, QQQ: 1.8, IWM: 1.0 };

function _readLevelsForGate(instrument) {
  const sym = (instrument || '').toUpperCase();
  if (!['SPY', 'QQQ', 'IWM'].includes(sym)) return null;
  try {
    const file = join(__dirname, sym.toLowerCase() + '-levels.json');
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch { return null; }
}

function _checkStretchedFromExtreme(instrument, direction, price) {
  if ((process.env.STRETCHED_GATE_ENABLED || 'true').toLowerCase() === 'false') {
    return { block: false };
  }
  if (price == null || !isFinite(price)) return { block: false };
  const sym = (instrument || '').toUpperCase();
  const levels = _readLevelsForGate(sym);
  if (!levels) return { block: false };
  const vwap   = (typeof levels.vwap   === 'number') ? levels.vwap   : null;
  const pdHigh = (typeof levels.pdHigh === 'number') ? levels.pdHigh : null;
  const pdLow  = (typeof levels.pdLow  === 'number') ? levels.pdLow  : null;

  // Leg 1 — VWAP stretch
  const vwapEnabled = (process.env.STRETCHED_VWAP_ENABLED || 'true').toLowerCase() === 'true';
  if (vwapEnabled && vwap != null) {
    const atrEnv  = parseFloat(process.env['STRETCHED_ATR_FALLBACK_' + sym]);
    const atrEst  = isFinite(atrEnv) && atrEnv > 0 ? atrEnv : (_STRETCHED_ATR_FALLBACK[sym] || 0);
    const atrMult = parseFloat(process.env.STRETCHED_VWAP_ATR_MULT || '2.0');
    if (atrEst > 0 && isFinite(atrMult) && atrMult > 0) {
      const stretch = price - vwap;                       // +above / -below
      const cutoff  = atrMult * atrEst;
      if (direction === 'PUTS' && stretch < -cutoff) {
        return {
          block: true,
          reason: 'STRETCHED_FROM_VWAP',
          details: { side: 'BELOW_VWAP', price, vwap, stretch: +stretch.toFixed(3), cutoff: +cutoff.toFixed(3), atrEst, atrMult },
        };
      }
      if (direction === 'CALLS' && stretch > cutoff) {
        return {
          block: true,
          reason: 'STRETCHED_FROM_VWAP',
          details: { side: 'ABOVE_VWAP', price, vwap, stretch: +stretch.toFixed(3), cutoff: +cutoff.toFixed(3), atrEst, atrMult },
        };
      }
    }
  }

  // Leg 2 — PDH/PDL
  const pdEnabled = (process.env.STRETCHED_PD_ENABLED || 'true').toLowerCase() === 'true';
  if (pdEnabled) {
    if (direction === 'PUTS' && pdLow != null && price < pdLow) {
      return {
        block: true,
        reason: 'STRETCHED_FROM_PD',
        details: { side: 'BELOW_PDL', price, pdLow, distance: +(pdLow - price).toFixed(3) },
      };
    }
    if (direction === 'CALLS' && pdHigh != null && price > pdHigh) {
      return {
        block: true,
        reason: 'STRETCHED_FROM_PD',
        details: { side: 'ABOVE_PDH', price, pdHigh, distance: +(price - pdHigh).toFixed(3) },
      };
    }
  }

  return { block: false };
}

// ─── Session-band helper (2026-05-19 EOD) ────────────────────────────────
// Operator's session-volume map (saved in memory project_overnight_session_map).
// Returns one of: RTH | PRE_MARKET | ASIA_OPEN | ASIA_MID | DEAD_ZONE
//                 | EUROPE_OPEN | FLANKS_PM
// Used by Vision threshold tuning (DEAD_ZONE stricter, ASIA_OPEN current),
// and available for future stale-detect / RBO band tuning.
function _sessionBand(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
  if (m.weekday === 'Sat' || m.weekday === 'Sun') return 'WEEKEND';
  const totalMin = parseInt(m.hour, 10) * 60 + parseInt(m.minute, 10);
  // ET minute-of-day bands
  if (totalMin >= 9*60+30 && totalMin < 16*60)   return 'RTH';
  if (totalMin >= 7*60    && totalMin < 9*60+30) return 'PRE_MARKET';
  if (totalMin >= 16*60   && totalMin < 18*60)   return 'FLANKS_PM';
  if (totalMin >= 18*60   && totalMin < 21*60+30) return 'ASIA_OPEN';   // 18:00-21:30
  if (totalMin >= 21*60+30 && totalMin < 23*60)  return 'ASIA_MID';     // 21:30-23:00
  if (totalMin >= 23*60   || totalMin < 2*60)    return 'DEAD_ZONE';    // 23:00-02:00
  if (totalMin >= 2*60    && totalMin < 7*60)    return 'EUROPE_OPEN';  // 02:00-07:00
  return 'UNKNOWN';
}

// ─── Vision sibling-consistency cache (2026-05-19 EOD) ────────────────────
// Operator flagged: 19:12 ET NQ1! veto'd correctly but MES1! sibling
// silently passed with no Vision record. Inconsistent verdicts on
// correlated instruments.
//
// Cache: family|direction|barBucket → { verdict, ts, primary }
//   family: 'ES_FAM' for ES1!/MES1!  |  'NQ_FAM' for NQ1!/MNQ1!
//   verdict: full result object (composite, veto, zone, action, etc)
//   ts: when scored
//   primary: which instrument actually called Vision
// TTL: 60s (within same bar typically)
const _visionFamilyCache = new Map();
const _VISION_CACHE_TTL_MS = 60 * 1000;
function _visionFamilyKey(instrument, direction) {
  const inst = (instrument || '').toUpperCase();
  let fam = inst;
  if (inst === 'ES1!' || inst === 'MES1!') fam = 'ES_FAM';
  else if (inst === 'NQ1!' || inst === 'MNQ1!') fam = 'NQ_FAM';
  const barBucket = Math.floor(Date.now() / 60000);  // per-minute bucket
  return `${fam}|${(direction||'').toUpperCase()}|${barBucket}`;
}

// ─── Vision Phase 5 — sync gate (2026-05-19, post-validation refactor) ─────
// 2026-05-19 13:48-13:51 validation: 3 SPY PUTS trades scored composite
// 2.8-3.4 by Haiku 4.5; all 3 lost (-$13.87, -$31.34, -$26.71). Reasoning
// independently identified PDL proximity, exhausted move, counter-trend
// structure. Reject threshold 3.5 would have saved -$71.92 today.
//
// Architecture: SYNCHRONOUS gate. Webhook awaits screenshot + scoring
// BEFORE dispatch. If composite < VISION_REJECT_THRESHOLD → block as
// GATE_BLOCK reason=VISION_REJECT_LOW_SCORE. Otherwise pass through to
// dispatch with the score journaled.
//
// Latency: ~2s per entry (screenshot ~200ms + Haiku 1.8s). Acceptable for
// bar-close engines (BUY/SELL/HTF/ZONE/HL/LH/RBO/FADE). LIVE engine
// bypasses entirely — intra-bar trigger, can't afford the lag, and the
// chart at LIVE trigger time isn't bar-confirmed anyway (vision works
// best on completed bars).
//
// Env knobs (defaults baked in):
//   VISION_ENABLED                  true     master toggle
//   VISION_GATE_ENABLED             true     enables hard REJECT (set false
//                                            to log-only without blocking)
//   VISION_REJECT_THRESHOLD         3.5      composite below this → REJECT
//   VISION_BYPASS_ENGINES           LIVE     comma-sep engines to skip
//   VISION_MODEL                    claude-haiku-4-5-20251001
//   VISION_FAIL_OPEN                true     vision API error → pass through
//                                            (don't block trade on infra hiccup)
const _VISION_SCORES_FILE = join(__dirname, 'data', 'vision-scores.json');

function _readLevelsForVision(instrument) {
  const sym = (instrument || '').toUpperCase();
  if (!['SPY', 'QQQ', 'IWM'].includes(sym)) return null;
  try {
    const file = join(__dirname, sym.toLowerCase() + '-levels.json');
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch { return null; }
}

async function _evaluateVisionGate(consensus) {
  // Returns {action, score?, reason?}
  //   action = 'pass'       — vision disabled / bypass engine / passed gate
  //   action = 'reject'     — composite below REJECT_THRESHOLD
  //   action = 'fail_open'  — vision errored, fail-open enabled, pass with no score

  // Read fields off consensus (note: consensus uses `signal` for direction,
  // not `direction` — older fire-and-forget code had a bug here).
  const instrument = consensus.instrument;
  const direction  = consensus.signal || consensus.direction;
  const engine     = consensus.engine;
  const price      = consensus.underlyingPrice || consensus.price;

  // 2026-05-19 EOD — DEFENSIVE: always journal the verdict, even on early
  // returns (disabled, bypass, cache-hit). Catches the 19:12 MES1! silent-
  // bypass anomaly where Vision had no journal record despite trade entering.
  const _journalVerdict = (action, reason, extra = {}) => {
    try {
      jAlert('INFO', 'VISION_VERDICT_FOR_ENTRY', {
        instrument, direction, engine, price,
        action, reason,
        sessionBand: _sessionBand(),
        ...extra,
        etTime: etTimeString(),
      });
    } catch {}
  };

  if ((process.env.VISION_ENABLED || 'true').toLowerCase() === 'false') {
    _journalVerdict('pass', 'disabled');
    return { action: 'pass', reason: 'disabled' };
  }

  // Engine bypass list — LIVE by default (intra-bar, no time for vision)
  const bypassList = (process.env.VISION_BYPASS_ENGINES || 'LIVE')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (bypassList.includes((engine || '').toUpperCase())) {
    _journalVerdict('pass', `engine_bypass(${engine})`);
    return { action: 'pass', reason: `engine_bypass(${engine})` };
  }

  // 2026-05-19 EOD — Sibling-consistency cache lookup. If a sibling (ES1!↔
  // MES1!, NQ1!↔MNQ1!) already scored in the last 60s for same direction,
  // reuse that verdict. Eliminates the 19:12 MES1! gap where NQ1! veto'd
  // but MES1! silently passed. Also halves API costs on confluence bars.
  const siblingCacheEnabled = (process.env.VISION_SIBLING_CACHE_ENABLED || 'true').toLowerCase() === 'true';
  if (siblingCacheEnabled) {
    const famKey = _visionFamilyKey(instrument, direction);
    const cached = _visionFamilyCache.get(famKey);
    if (cached && (Date.now() - cached.ts) < _VISION_CACHE_TTL_MS) {
      // GC any stale entries while we're here
      for (const [k, v] of _visionFamilyCache.entries()) {
        if (Date.now() - v.ts > _VISION_CACHE_TTL_MS * 2) _visionFamilyCache.delete(k);
      }
      _journalVerdict(cached.verdict.action, `sibling_cache_hit (primary=${cached.primary})`, {
        composite: cached.verdict.score?.composite,
        lateFireVeto: cached.verdict.score?.lateFireVeto,
        zoneSetupQuality: cached.verdict.score?.zoneSetupQuality,
        rejectCause: cached.verdict.rejectCause,
        cacheAgeMs: Date.now() - cached.ts,
      });
      console.log(`  ♻ VISION_SIBLING_CACHE_HIT  ${instrument} ${direction} ${engine}  → ${cached.verdict.action} (from ${cached.primary})`);
      return cached.verdict;
    }
  }

  const t0 = Date.now();
  let shot, result;
  // 2026-05-19 18:04 ET — hard timeout on Vision pipeline. Pre-timeout,
  // a single hung CDP probe (chartScreenshot tab discovery) would block
  // the trade indefinitely with no error log. Two MES1!/ES1! CALLS BUY
  // alerts at 18:02:59-03:00 sat in limbo for 90+ sec post-CME-resume.
  // Now bounded — anything beyond VISION_TIMEOUT_MS throws and fails open.
  const visionTimeoutMs = parseInt(process.env.VISION_TIMEOUT_MS || '8000', 10);
  try {
    const visionPipeline = (async () => {
      const [{ captureChartImage }, { scoreChart }] = await Promise.all([
        import('./chartScreenshot.js'),
        import('./visionScorer.js'),
      ]);
      const tag = `entry-${(engine || 'X').toUpperCase()}-${(direction || 'X').toUpperCase()}`;
      shot = await captureChartImage(instrument, { tag, persist: true });
      const levels = _readLevelsForVision(instrument);
      result = await scoreChart(
        { instrument, direction, engine, price, levels: levels || undefined },
        shot.buffer
      );
    })();
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`VISION_TIMEOUT (>${visionTimeoutMs}ms)`)), visionTimeoutMs);
    });
    try {
      await Promise.race([visionPipeline, timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  } catch (e) {
    try { jError('WEBHOOK', 'VISION_SCORE_ERROR', { message: e.message, instrument, direction, engine, latencyMs: Date.now() - t0 }); } catch {}
    console.error(`  [VISION] error: ${e.message}`);
    const failOpen = (process.env.VISION_FAIL_OPEN || 'true').toLowerCase() === 'true';
    _journalVerdict(failOpen ? 'fail_open' : 'reject', 'api_error', { error: e.message, latencyMs: Date.now() - t0 });
    return { action: failOpen ? 'fail_open' : 'reject', reason: 'api_error', error: e.message };
  }

  const totalLatencyMs = Date.now() - t0;
  const composite = result.composite;
  // 2026-05-19 15:32 ET: tuned 3.0 → 4.0 after two more losses passed.
  // 15:27 MES1! PUTS RBO @ comp=3.8 (3.8 > 3.0 → passed) → lost -$16.25.
  // The 3.8 reasoning explicitly called "limited downside room, stretched
  // conditions" but composite math is too forgiving. Threshold lifted to
  // 4.0 (top of WEAK band; anything below NEUTRAL is rejected).
  //
  // 2026-05-19 EOD — DEAD_ZONE band override. 23:00-02:00 ET is Tokyo
  // lunch + pre-London gap — thinnest tape, most setups bad. Tighten
  // threshold to 5.0 (mid-NEUTRAL). Other bands keep 4.0 default.
  const _band = _sessionBand();
  const _deadZoneThr = parseFloat(process.env.VISION_REJECT_THRESHOLD_DEAD_ZONE || '5.0');
  const _defaultThr  = parseFloat(process.env.VISION_REJECT_THRESHOLD || '4.0');
  const rejectThr = _band === 'DEAD_ZONE' ? _deadZoneThr : _defaultThr;
  const gateEnabled = (process.env.VISION_GATE_ENABLED || 'true').toLowerCase() === 'true';

  // 2026-05-19 — late_fire_veto: binary model override. Catches the
  // textbook late-fire pattern that scores above composite threshold but
  // reads bearish in the model's reasoning. 15:30 MES1! CALLS ZONE @
  // comp=4.8 NEUTRAL passed despite reasoning "exhaustion and late-entry
  // risk" — exactly what the veto is meant to catch.
  const vetoEnabled = (process.env.VISION_VETO_ENABLED || 'true').toLowerCase() === 'true';
  const wouldRejectByComposite = gateEnabled && composite != null && composite < rejectThr;
  const wouldRejectByVeto      = vetoEnabled && result.lateFireVeto === true;

  // 2026-05-19 19:35 ET — zone_setup_quality reject for ZONE engine.
  // Operator priority: "Vision must learn supply/demand trades." When
  // Pine's ZONE engine fires but model says zone quality is poor (price
  // already through the zone, signal opposed to nearby zone, chasing
  // breakout from wrong side), reject.
  const zoneRejectEnabled = (process.env.VISION_ZONE_REJECT_ENABLED || 'true').toLowerCase() === 'true';
  const zoneRejectThr     = parseFloat(process.env.VISION_ZONE_REJECT_THRESHOLD || '4');
  const isZoneEngine      = (engine || '').toUpperCase() === 'ZONE';
  const wouldRejectByZone = zoneRejectEnabled && isZoneEngine && typeof result.zoneSetupQuality === 'number' && result.zoneSetupQuality < zoneRejectThr;

  // 2026-05-19 EOD — Action multiplier hard block (operator spec).
  // Model returns one of {0.0, 0.25, 0.7, 1.0, 1.2} as holistic edge.
  // 0.0 means HARD BLOCK (toxic proximity, zone disrespect, inside-zone wrong side).
  const actionMultRejectEnabled = (process.env.VISION_ACTION_MULT_REJECT_ENABLED || 'true').toLowerCase() === 'true';
  const wouldRejectByActionMult = actionMultRejectEnabled && result.actionMultiplier === 0.0;

  // 2026-05-19 EOD — zoneMathFilter: mechanical R:R check using model's
  // extracted spatial coordinates. Catches "late entry at the top of a
  // move into supply" (operator's 19:48 ES1! SELL @7388 example).
  // Rules (per operator spec):
  //   CALLS:
  //     upside    = supply_lower - current  (room to target)
  //     downside  = current - demand_upper  (room before stop area)
  //     if upside <= 0           → INSIDE_OR_ABOVE_SUPPLY
  //     if upside < 2.0          → TOXIC_PROXIMITY_SUPPLY
  //     if downside > upside     → NEGATIVE_RR_TO_DEMAND
  //   PUTS: mirror.
  function _zoneMathBlock() {
    if ((process.env.VISION_ZONE_MATH_FILTER_ENABLED || 'true').toLowerCase() !== 'true') return null;
    const cur = result.currentPriceVision ?? price;
    const supLower = result.detectedSupplyZone?.lower;
    const demUpper = result.detectedDemandZone?.upper;
    if (cur == null || supLower == null || demUpper == null) return null;
    const toxicPts = parseFloat(process.env.VISION_ZONE_TOXIC_POINTS || '2.0');
    const dir = (direction || '').toUpperCase();
    if (dir === 'CALLS') {
      const upside = supLower - cur;
      const downside = cur - demUpper;
      if (upside <= 0) return { reason: 'INSIDE_OR_ABOVE_SUPPLY', upside, downside };
      if (upside < toxicPts) return { reason: 'TOXIC_PROXIMITY_SUPPLY', upside, downside, toxicPts };
      if (downside > upside) return { reason: 'NEGATIVE_RR_TO_DEMAND', upside, downside, rr: +(upside/downside).toFixed(2) };
    } else if (dir === 'PUTS') {
      const downside = cur - demUpper;
      const upside   = supLower - cur;
      if (downside <= 0) return { reason: 'INSIDE_OR_BELOW_DEMAND', upside, downside };
      if (downside < toxicPts) return { reason: 'TOXIC_PROXIMITY_DEMAND', upside, downside, toxicPts };
      if (upside > downside) return { reason: 'NEGATIVE_RR_TO_SUPPLY', upside, downside, rr: +(downside/upside).toFixed(2) };
    }
    return null;
  }
  const zoneMathBlock = _zoneMathBlock();
  const wouldRejectByZoneMath = zoneMathBlock !== null;

  const wouldReject = wouldRejectByComposite || wouldRejectByVeto || wouldRejectByZone || wouldRejectByActionMult || wouldRejectByZoneMath;

  // 2026-05-19 18:05 ET — off-RTH bypass. Operator data-collection mode
  // through June 1 (MNQ futures activate). Outside 09:30-16:00 ET Mon-Fri,
  // Vision STILL scores + journals (data for future calibration) but
  // does NOT reject — every overnight trade dispatches regardless of
  // composite or veto. RTH stays under full gating.
  //
  // 2026-05-19 18:14 ET refinement — operator hit MNQ1! comp=2.2+veto=yes
  // overnight that lost -$0.50 (BE_EARLY saved 91%, but the trade was a
  // textbook late-fire model flagged correctly). VISION_OFFRTH_RESPECT_VETO
  // keeps the veto reject path active even overnight; only composite-only
  // rejects bypass to log-only. Binary model judgment is high-signal —
  // respect it.
  const bypassOffRth   = (process.env.VISION_BYPASS_OFFRTH         || 'true').toLowerCase() === 'true';
  const respectVetoOff = (process.env.VISION_OFFRTH_RESPECT_VETO   || 'true').toLowerCase() === 'true';
  const _isRTH = (() => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
    if (m.weekday === 'Sat' || m.weekday === 'Sun') return false;
    const totalMin = parseInt(m.hour, 10) * 60 + parseInt(m.minute, 10);
    return totalMin >= 9 * 60 + 30 && totalMin < 16 * 60;
  })();
  // off-RTH bypass fires when: bypass is enabled, we're off-RTH, would-reject
  // is true, AND the would-reject reason is composite-only.
  // Veto, zone-quality, action_multiplier=0, and zone-math all PUNCH THROUGH
  // bypass overnight — these are high-signal binary judgments worth respecting
  // even in data-collection mode.
  const _vetoBreaksBypass     = respectVetoOff && wouldRejectByVeto;
  const _zoneBreaksBypass     = wouldRejectByZone;
  const _actionMultBreaksBypass = wouldRejectByActionMult;
  const _zoneMathBreaksBypass = wouldRejectByZoneMath;
  const offRthBypass = bypassOffRth && !_isRTH && wouldReject &&
                       !_vetoBreaksBypass && !_zoneBreaksBypass &&
                       !_actionMultBreaksBypass && !_zoneMathBreaksBypass;
  const shouldReject = wouldReject && !offRthBypass;
  const shouldRejectByComposite  = shouldReject && wouldRejectByComposite;
  const shouldRejectByVeto       = shouldReject && wouldRejectByVeto;
  const shouldRejectByZone       = shouldReject && wouldRejectByZone;
  const shouldRejectByActionMult = shouldReject && wouldRejectByActionMult;
  const shouldRejectByZoneMath   = shouldReject && wouldRejectByZoneMath;
  // Precedence (most specific → least): zone_math > action_mult > zone_quality > veto > composite
  const rejectCause = offRthBypass ? `off_rth_bypass (would_reject: composite ${composite} < ${rejectThr})`
                    : shouldRejectByZoneMath ? `zone_math: ${zoneMathBlock.reason} (upside=${zoneMathBlock.upside?.toFixed(2)} downside=${zoneMathBlock.downside?.toFixed(2)})`
                    : shouldRejectByActionMult ? `action_multiplier=0.0 (model HARD BLOCK; structure=${result.structureState})`
                    : shouldRejectByZone ? `zone_setup_quality ${result.zoneSetupQuality} < ${zoneRejectThr} (ZONE engine)`
                    : shouldRejectByVeto ? 'late_fire_veto'
                    : shouldRejectByComposite ? `composite ${composite} < ${rejectThr}`
                    : null;

  // Journal the score (success path)
  try {
    jAlert('INFO', 'VISION_SCORE', {
      instrument, direction, engine, price,
      capturedSymbol: shot.matchedSymbol,
      capturedViaFallback: shot.viaFallback,
      composite, multiplier: result.multiplier, tier: result.tier,
      lateFireVeto: result.lateFireVeto,
      zoneSetupQuality: result.zoneSetupQuality,
      detectedSupplyZone: result.detectedSupplyZone,
      detectedDemandZone: result.detectedDemandZone,
      currentPriceVision: result.currentPriceVision,
      structureState: result.structureState,
      actionMultiplier: result.actionMultiplier,
      zoneMathBlock,
      dims: {
        trend_alignment:   result.trend_alignment,
        momentum:          result.momentum,
        sr_headroom:       result.sr_headroom,
        volume_confirm:    result.volume_confirm,
        exhaustion_safety: result.exhaustion_safety,
      },
      reasoning: result.reasoning,
      screenshotPath: shot.path,
      modelLatencyMs: result.modelLatencyMs,
      totalLatencyMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costEstimateUsd: result.costEstimateUsd,
      rejectThreshold: rejectThr,
      action: shouldReject ? 'reject' : 'pass',
      rejectCause,
      offRthBypass,
      isRTH: _isRTH,
      etTime: etTimeString(),
    });
  } catch {}

  // Append to vision-scores.json cache
  try {
    const dir = dirname(_VISION_SCORES_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    let cache = { version: 1, entries: [] };
    if (existsSync(_VISION_SCORES_FILE)) {
      try { cache = JSON.parse(readFileSync(_VISION_SCORES_FILE, 'utf8')); } catch {}
    }
    cache.entries = cache.entries || [];
    cache.entries.push({
      ts: t0, etTime: etTimeString(),
      instrument, direction, engine, price,
      composite, multiplier: result.multiplier, tier: result.tier,
      dims: {
        trend_alignment:   result.trend_alignment,
        momentum:          result.momentum,
        sr_headroom:       result.sr_headroom,
        volume_confirm:    result.volume_confirm,
        exhaustion_safety: result.exhaustion_safety,
      },
      reasoning: result.reasoning,
      screenshotPath: shot.path,
      costEstimateUsd: result.costEstimateUsd,
      rejectThreshold: rejectThr,
      action: shouldReject ? 'reject' : 'pass',
    });
    if (cache.entries.length > 5000) cache.entries = cache.entries.slice(-5000);
    writeFileSync(_VISION_SCORES_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    try { jError('WEBHOOK', 'VISION_CACHE_WRITE_ERR', { message: e.message }); } catch {}
  }

  let verdict;
  if (shouldReject) {
    console.log(`  🛑 VISION_REJECT  ${instrument} ${direction} ${engine}  comp=${composite}  veto=${result.lateFireVeto}  zoneQ=${result.zoneSetupQuality}  mult=${result.actionMultiplier}  struct=${result.structureState}  cause=${rejectCause}  band=${_band}  (${totalLatencyMs}ms, $${result.costEstimateUsd})`);
    const reason = shouldRejectByZoneMath   ? 'zone_math_block'
                 : shouldRejectByActionMult ? 'action_mult_zero'
                 : shouldRejectByZone       ? 'zone_invalid_setup'
                 : shouldRejectByVeto       ? 'late_fire_veto'
                 : 'low_score';
    verdict = { action: 'reject', reason, score: result, rejectThreshold: rejectThr, rejectCause, totalLatencyMs, zoneMathBlock };
  } else {
    if (offRthBypass) {
      console.log(`  ⏰ VISION_OFFRTH_PASS  ${instrument} ${direction} ${engine}  composite=${composite}  tier=${result.tier}  (would-reject: ${rejectCause}, but off-RTH bypass — data-collection mode)  band=${_band}  (${totalLatencyMs}ms)`);
    } else {
      console.log(`  ✓ VISION_PASS  ${instrument} ${direction} ${engine}  composite=${composite}  tier=${result.tier}  veto=${result.lateFireVeto}  zoneQ=${result.zoneSetupQuality}  band=${_band}  (${totalLatencyMs}ms, $${result.costEstimateUsd})`);
    }
    verdict = { action: 'pass', score: result, totalLatencyMs, offRthBypass };
  }

  // Cache the verdict for siblings + always journal it.
  if ((process.env.VISION_SIBLING_CACHE_ENABLED || 'true').toLowerCase() === 'true') {
    const famKey = _visionFamilyKey(instrument, direction);
    _visionFamilyCache.set(famKey, { verdict, ts: Date.now(), primary: instrument });
  }
  _journalVerdict(verdict.action, verdict.reason || (offRthBypass ? 'off_rth_bypass' : 'scored'), {
    composite, lateFireVeto: result.lateFireVeto, zoneSetupQuality: result.zoneSetupQuality,
    rejectThreshold: rejectThr, rejectCause, sessionBand: _band, totalLatencyMs,
  });
  return verdict;
}

// 2026-05-19 — PASSTHROUGH fix for STACKED_ENTRY_DEDUP.
// When a bucket is already claimed and the new alert arrives, check whether
// the first engine's resulting position is STILL OPEN. If yes → legit
// confluence dedup (block). If no (already closed/stopped) → release the
// bucket to the new engine. The first engine had its shot, the position
// is gone, this is a fresh opportunity not a stacked duplicate.
//
// Today's evidence (audit of 84 dedup blocks): 2 eaten signals followed
// the same pattern — first engine (ZONE) opened, won, closed, then
// subsequent engines in the same 5m bucket were blocked despite the
// position being long gone.
//
// Reads paper-ledger.json + futures-ledger.json on each call (small JSON
// files, sub-ms read; paperTrading/futuresTrading write atomically after
// each open/close so the read sees consistent state).
// Futures micro-fallback pairs — ES1!↔MES1! and NQ1!↔MNQ1!. When operator
// sends an ES1! alert and margin > cap, dispatch routes to MES1!. So an
// open MES1! position should block subsequent ES1! alerts (and vice versa)
// — they represent the same setup, dispatched to the smaller contract.
const _RELATED_FUT = {
  'ES1!':  ['MES1!'],
  'MES1!': ['ES1!'],
  'NQ1!':  ['MNQ1!'],
  'MNQ1!': ['NQ1!'],
};

function _isAnyOpenPositionFor(instrument, direction) {
  const inst = (instrument || '').toUpperCase();
  const dir  = (direction  || '').toUpperCase();
  const allSyms = new Set([inst, ...(_RELATED_FUT[inst] || [])]);
  try {
    const eqFile = join(__dirname, 'paper-ledger.json');
    if (existsSync(eqFile)) {
      const eq = JSON.parse(readFileSync(eqFile, 'utf8'));
      if ((eq.trades || []).some(t => t.status === 'OPEN' && allSyms.has((t.instrument || '').toUpperCase()) && (t.signal || '').toUpperCase() === dir)) {
        return true;
      }
    }
  } catch {}
  try {
    const fuFile = join(__dirname, 'futures-ledger.json');
    if (existsSync(fuFile)) {
      const fu = JSON.parse(readFileSync(fuFile, 'utf8'));
      if ((fu.trades || []).some(t => t.status === 'OPEN' && allSyms.has((t.instrument || '').toUpperCase()) && (t.signal || '').toUpperCase() === dir)) {
        return true;
      }
    }
  } catch {}
  return false;
}

// 2026-05-19 14:54 ET — split into peek (early-check, doesn't claim) and
// claim (called right before dispatch, after all gates pass). Operator
// evidence: SELL was blocked by counter-trend gate, but the bucket-claim
// already happened in the top-of-handler dedup check. Subsequent HTF +
// ZONE alerts saw the bucket as occupied and got blocked. The claim
// should only happen if the alert actually goes through to dispatch.
//
// PRIMARY check (position-based) stays at top — pure read, no state change.
// BUCKET peek stays at top too — pure read.
// BUCKET claim moves to right before dispatch.
function _peekStackedDedup(instrument, direction, engine) {
  const now = Date.now();
  // GC old buckets (state mutation but safe — only removes stale entries)
  for (const [k, v] of _stackDedupMap.entries()) {
    if (now - v.ts > _STACK_DEDUP_GC_AFTER_MS) _stackDedupMap.delete(k);
  }

  // PRIMARY: position-based dedup (pure read)
  const positionOpenCheckEnabled = (process.env.STACKED_DEDUP_POSITION_CHECK_ENABLED || 'true').toLowerCase() === 'true';
  if (positionOpenCheckEnabled && _isAnyOpenPositionFor(instrument, direction)) {
    return {
      duplicate: true,
      firstEngine: 'OPEN_POSITION',
      reason: 'OPEN_POSITION_EXISTS',
      key: `${(instrument||'').toUpperCase()}|${(direction||'').toUpperCase()}|OPEN`,
      ageMs: 0,
    };
  }

  // SECONDARY: bucket-based peek (no claim)
  const key = _stackedDedupKey(instrument, direction, now);
  const existing = _stackDedupMap.get(key);
  if (existing) {
    const passthroughEnabled = (process.env.STACKED_DEDUP_PASSTHROUGH_ENABLED || 'true').toLowerCase() === 'true';
    const minAgeMs = parseInt(process.env.STACKED_DEDUP_PASSTHROUGH_MIN_AGE_MS || '5000', 10);
    const bucketAgeMs = now - existing.ts;
    if (passthroughEnabled && bucketAgeMs >= minAgeMs) {
      const stillOpen = _isAnyOpenPositionFor(instrument, direction);
      if (!stillOpen) {
        // Bucket is stale + prior position closed — peek says pass.
        // The claim step at dispatch time will RECLAIM the bucket with this engine.
        return { duplicate: false, key, passthroughExpected: true };
      }
    }
    return { duplicate: true, firstEngine: existing.firstEngine, ageMs: bucketAgeMs, key };
  }
  return { duplicate: false, key };
}

// Called right before dispatch (after all gates pass). Re-validates +
// commits the claim atomically. Returns the same shape as _peekStackedDedup
// — if a different alert claimed the bucket during the gate-wait window
// (e.g., 2s Vision wait), this catches it.
function _claimStackedDedup(instrument, direction, engine) {
  const now = Date.now();
  // Re-check position-based first (fastest fail)
  const positionOpenCheckEnabled = (process.env.STACKED_DEDUP_POSITION_CHECK_ENABLED || 'true').toLowerCase() === 'true';
  if (positionOpenCheckEnabled && _isAnyOpenPositionFor(instrument, direction)) {
    return {
      duplicate: true,
      firstEngine: 'OPEN_POSITION',
      reason: 'OPEN_POSITION_EXISTS',
      key: `${(instrument||'').toUpperCase()}|${(direction||'').toUpperCase()}|OPEN`,
      ageMs: 0,
    };
  }
  const key = _stackedDedupKey(instrument, direction, now);
  const existing = _stackDedupMap.get(key);
  if (existing) {
    const passthroughEnabled = (process.env.STACKED_DEDUP_PASSTHROUGH_ENABLED || 'true').toLowerCase() === 'true';
    const minAgeMs = parseInt(process.env.STACKED_DEDUP_PASSTHROUGH_MIN_AGE_MS || '5000', 10);
    const bucketAgeMs = now - existing.ts;
    if (passthroughEnabled && bucketAgeMs >= minAgeMs) {
      const stillOpen = _isAnyOpenPositionFor(instrument, direction);
      if (!stillOpen) {
        // Release and re-claim with new engine
        _stackDedupMap.set(key, { firstEngine: engine, ts: now });
        try {
          jAlert('INFO', 'STACKED_ENTRY_DEDUP_PASSTHROUGH', {
            instrument, direction, newEngine: engine,
            priorFirstEngine: existing.firstEngine, priorClaimedAgeMs: bucketAgeMs,
            etTime: etTimeString(),
            note: 'Prior position closed — bucket released to new engine (not a stacked duplicate).',
          });
        } catch {}
        return { duplicate: false, key, passthrough: true, claimed: true };
      }
    }
    return { duplicate: true, firstEngine: existing.firstEngine, ageMs: bucketAgeMs, key };
  }
  // Fresh claim
  _stackDedupMap.set(key, { firstEngine: engine, ts: now });
  return { duplicate: false, key, claimed: true };
}

// Legacy wrapper — preserves the old call signature for any unconverted call sites.
function _checkStackedDedup(instrument, direction, engine) {
  const now = Date.now();
  // Garbage-collect old buckets.
  for (const [k, v] of _stackDedupMap.entries()) {
    if (now - v.ts > _STACK_DEDUP_GC_AFTER_MS) _stackDedupMap.delete(k);
  }

  // 2026-05-19 — PRIMARY check: position-based dedup. Catches bar-boundary
  // straddles where two engines fire 2-3 seconds apart across a 5m bar
  // close (e.g., 14:09:59 HL + 14:10:01 BUY produced two MES1! CALLS
  // positions despite being one setup; bucket math put them in different
  // 5m buckets). If ANY open position matches (instrument, direction) —
  // including the futures micro-fallback target — block immediately.
  const positionOpenCheckEnabled = (process.env.STACKED_DEDUP_POSITION_CHECK_ENABLED || 'true').toLowerCase() === 'true';
  if (positionOpenCheckEnabled && _isAnyOpenPositionFor(instrument, direction)) {
    return {
      duplicate: true,
      firstEngine: 'OPEN_POSITION',
      reason: 'OPEN_POSITION_EXISTS',
      key: `${(instrument||'').toUpperCase()}|${(direction||'').toUpperCase()}|OPEN`,
      ageMs: 0,
    };
  }

  const key = _stackedDedupKey(instrument, direction, now);
  const existing = _stackDedupMap.get(key);
  if (existing) {
    // 2026-05-19 PASSTHROUGH: if the first engine's position has already
    // closed, this is a fresh opportunity — release the bucket.
    // Safety: require the bucket to be at least N ms old before evaluating
    // open-position state. Protects against race where first sendOrder is
    // still in flight (ledger write hasn't landed yet) — a 0-age bucket
    // means the first alert just arrived; assume it's still becoming a
    // trade. Default 5s, well past typical sendOrder roundtrip.
    const passthroughEnabled = (process.env.STACKED_DEDUP_PASSTHROUGH_ENABLED || 'true').toLowerCase() === 'true';
    const minAgeMs = parseInt(process.env.STACKED_DEDUP_PASSTHROUGH_MIN_AGE_MS || '5000', 10);
    const bucketAgeMs = now - existing.ts;
    if (passthroughEnabled && bucketAgeMs >= minAgeMs) {
      const stillOpen = _isAnyOpenPositionFor(instrument, direction);
      if (!stillOpen) {
        // Free the bucket → record the new engine as the bucket owner.
        _stackDedupMap.set(key, { firstEngine: engine, ts: now });
        try {
          jAlert('INFO', 'STACKED_ENTRY_DEDUP_PASSTHROUGH', {
            instrument, direction, newEngine: engine,
            priorFirstEngine: existing.firstEngine,
            priorClaimedAgeMs: now - existing.ts,
            etTime: etTimeString(),
            note: 'Prior position closed — bucket released to new engine (not a stacked duplicate).',
          });
        } catch {}
        return { duplicate: false, key, passthrough: true };
      }
    }
    return { duplicate: true, firstEngine: existing.firstEngine, ageMs: now - existing.ts, key };
  }
  _stackDedupMap.set(key, { firstEngine: engine, ts: now });
  return { duplicate: false, key };
}

// ─── FADE engine helpers (Phase 1, 2026-05-18) ───────────────────────────────
// Pine emits engine='FADE_CANDIDATE' on vol/range/VWAP-extension reversal
// candles. Webhook joins with realtime-news.json (60s lookback, HIGH impact
// required) and either promotes to engine='FADE' or drops with a loud reason.
// Blackout check suppresses FADE inside FOMC/CPI/NFP/GDP/PCE ±15min — those
// are regime shifts, not algo pops, so the "fade the pop" thesis breaks down.
const _REALTIME_NEWS_FILE = join(__dirname, 'realtime-news.json');
const _ECON_CAL_FILE      = join(__dirname, 'economic-calendar.json');
const _FADE_NEWS_LOOKBACK_MS    = 60 * 1000;
const _FADE_BLACKOUT_WINDOW_MS  = 15 * 60 * 1000;
const _FADE_BLACKOUT_KEYWORDS   = ['FOMC', 'FED', 'CPI', 'NFP', 'PAYROLL', 'GDP', 'PCE'];
const _FADE_DEDUP_WINDOW_MS     = 5 * 60 * 1000;
const _fadeActiveEvents = new Map();   // newsEventId → timestamp

function _findFadeNewsEvent() {
  try {
    const events = JSON.parse(readFileSync(_REALTIME_NEWS_FILE, 'utf8')) || [];
    const cutoff = Date.now() - _FADE_NEWS_LOOKBACK_MS;
    const hits = events.filter(e => e.impact === 'HIGH' && e.ts >= cutoff);
    if (!hits.length) return null;
    hits.sort((a, b) => b.ts - a.ts);
    return hits[0];
  } catch { return null; }
}

function _eventToMs(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  try {
    const [y, m, d]  = dateStr.split('-').map(Number);
    const [hh, mm]   = timeStr.split(':').map(Number);
    // Naive ET→UTC: assume EDT (UTC-4) for May–Oct, EST (UTC-5) Nov–Mar.
    // Phase 2 can swap for a proper tz library; for ±15min blackout window
    // a 1hr DST edge case is far inside the noise floor.
    const isDst = m >= 3 && m <= 11;   // approximate
    return Date.UTC(y, m - 1, d, hh + (isDst ? 4 : 5), mm);
  } catch { return null; }
}

function _checkFadeBlackout() {
  try {
    const data = JSON.parse(readFileSync(_ECON_CAL_FILE, 'utf8')) || {};
    const events = data.events || [];
    const now = Date.now();
    for (const evt of events) {
      if ((evt.impact || '').toUpperCase() !== 'HIGH') continue;
      const evtType = (evt.event || '').toUpperCase();
      const matches = _FADE_BLACKOUT_KEYWORDS.some(k => evtType.includes(k));
      if (!matches) continue;
      const evtMs = _eventToMs(evt.date, evt.time);
      if (evtMs == null) continue;
      if (Math.abs(now - evtMs) <= _FADE_BLACKOUT_WINDOW_MS) {
        return { event: evt.event, minutesUntil: Math.round((evtMs - now) / 60000) };
      }
    }
    return null;
  } catch { return null; }
}

function _fadeNewsEventId(newsEvent) {
  const s = `${newsEvent.headline}|${newsEvent.ts}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function _fadeEventActive(id) {
  const t = _fadeActiveEvents.get(id);
  if (!t) return false;
  if (Date.now() - t > _FADE_DEDUP_WINDOW_MS) {
    _fadeActiveEvents.delete(id);
    return false;
  }
  return true;
}

function _fadeMarkEventActive(id) {
  _fadeActiveEvents.set(id, Date.now());
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

// ─── /control/* — operator REPL overrides (added 2026-05-18) ─────────────────
// All mutation endpoints emit jAlert 'operator.manual_override' with action +
// timestamp. State changes that affect downstream gate behavior take effect
// IMMEDIATELY in this webhook process (no restart needed). For env-var-style
// knobs we mutate process.env in-process — the .env file is unchanged, so a
// future restart re-asserts the .env baseline (operator-intended behavior:
// runtime overrides are session-scoped; durable changes still go via .env).

function _opAlert(action, detail = {}) {
  try {
    jAlert('info', 'operator.manual_override', { action, detail, et: etTimeString(), ts: new Date().toISOString() });
  } catch {}
  console.log(`  🟦 OPERATOR ${action}${Object.keys(detail).length ? ' ' + JSON.stringify(detail) : ''}`);
}

function handleControlHaltPath2(_req, res) {
  process.env.PATH2_HALT = 'true';
  _opAlert('halt-path2', { previous: 'inactive' });
  send(res, 200, { ok: true, action: 'halt-path2', state: { path2Halt: true }, ts: new Date().toISOString() });
}

function handleControlResumePath2(_req, res) {
  process.env.PATH2_HALT = 'false';
  _opAlert('resume-path2');
  send(res, 200, { ok: true, action: 'resume-path2', state: { path2Halt: false }, ts: new Date().toISOString() });
}

function handleControlHaltEntries(_req, res) {
  process.env.WEBULL_INTEGRATION_HALT = 'true';
  _opAlert('halt-entries');
  send(res, 200, { ok: true, action: 'halt-entries', state: { webullIntegrationHalt: true }, ts: new Date().toISOString() });
}

function handleControlResumeEntries(_req, res) {
  process.env.WEBULL_INTEGRATION_HALT = 'false';
  _opAlert('resume-entries');
  send(res, 200, { ok: true, action: 'resume-entries', state: { webullIntegrationHalt: false }, ts: new Date().toISOString() });
}

function handleControlToggle1H(_req, res) {
  const cur = (process.env.COUNTER_TREND_1H_ENABLED || 'true').toLowerCase() === 'true';
  const next = !cur;
  process.env.COUNTER_TREND_1H_ENABLED = next ? 'true' : 'false';
  _opAlert('toggle-1h-gate', { from: cur, to: next });
  send(res, 200, { ok: true, action: 'toggle-1h-gate', state: { counterTrend1HEnabled: next }, ts: new Date().toISOString() });
}

function handleControlClearCircuitBreaker(_req, res) {
  const before = isCircuitBreakerTripped();
  clearCircuitBreaker();
  _opAlert('clear-circuit-breaker', { wasTripped: before });
  send(res, 200, { ok: true, action: 'clear-circuit-breaker', state: { cbTripped: false, wasTripped: before }, ts: new Date().toISOString() });
}

async function handleControlFlatten(req, res) {
  let body = {};
  try { body = JSON.parse(await readBody(req) || '{}'); } catch {}
  const scope = (body.scope || 'all').toLowerCase();
  const out = { ok: true, action: 'flatten', scope, ts: new Date().toISOString() };
  if (scope === 'all' || scope === 'futures') {
    try { out.futures = flattenAllFutures('OPERATOR_FLATTEN'); } catch (e) { out.futures = { error: e.message }; }
  }
  if (scope === 'all' || scope === 'equity') {
    try { out.equity = flattenAllEquity('OPERATOR_FLATTEN'); } catch (e) { out.equity = { error: e.message }; }
  }
  _opAlert('flatten', { scope, futuresClosed: out.futures?.closed, equityClosed: out.equity?.closed });
  send(res, 200, out);
}

async function handleControlRepollFutures(_req, res) {
  let result;
  try {
    const m = await import('./futuresPricer.js');
    result = await m.tickOnce();
  } catch (e) {
    result = { ok: false, error: e.message };
  }
  _opAlert('repoll-futures', { ok: result.ok, hits: result.hits, error: result.error });
  send(res, 200, { action: 'repoll-futures', ...result, ts: new Date().toISOString() });
}

async function handleControlMcpRestart(_req, res) {
  let result = { ok: false };
  try {
    const m = await import('./webull-mcp-client.js');
    if (typeof m.forceReconnect === 'function') {
      await m.forceReconnect();
      result = { ok: true, method: 'forceReconnect' };
    } else {
      await m.shutdownWebullMCP?.();
      await m.initWebullMCP?.();
      result = { ok: true, method: 'shutdown+init' };
    }
    const mcp = m.getWebullMCP?.();
    result.connected = mcp?.isConnected?.() ?? null;
  } catch (e) {
    result = { ok: false, error: e.message };
  }
  _opAlert('mcp-restart', result);
  send(res, result.ok ? 200 : 500, { action: 'mcp-restart', ...result, ts: new Date().toISOString() });
}

async function handleControlStatus(_req, res) {
  let mcpStatus = null;
  let pricerHealth = null;
  try {
    const fp = await import('./futuresPricer.js');
    if (typeof fp.getFuturesPricerHealth === 'function') pricerHealth = fp.getFuturesPricerHealth();
  } catch {}
  // Read state files (cross-process truth) so /status doesn't depend on
  // in-memory caches that may differ between processes.
  let cbFile = null;
  try { cbFile = JSON.parse(readFileSync(join(__dirname, 'circuit-breaker-state.json'), 'utf8')); } catch {}
  let openFut = 0, openEq = 0;
  try {
    const fut = JSON.parse(readFileSync(join(__dirname, 'futures-ledger.json'), 'utf8'));
    openFut = (fut.trades ?? []).filter(t => t.status === 'OPEN').length;
  } catch {}
  try {
    const eq = JSON.parse(readFileSync(join(__dirname, 'paper-ledger.json'), 'utf8'));
    openEq = (eq.trades ?? []).filter(t => t.status === 'OPEN').length;
  } catch {}
  const status = {
    ok: true,
    et: etTimeString(),
    halts: {
      path2Halt:               (process.env.PATH2_HALT || 'false').toLowerCase() === 'true',
      webullIntegrationHalt:   (process.env.WEBULL_INTEGRATION_HALT || 'false').toLowerCase() === 'true',
      webullMcpDisabled:       (process.env.WEBULL_MCP_DISABLED || 'false').toLowerCase() === 'true',
    },
    gates: {
      counterTrend1HEnabled:   (process.env.COUNTER_TREND_1H_ENABLED || 'true').toLowerCase() === 'true',
      counterTrendFuturesMode: process.env.COUNTER_TREND_FUTURES_MODE || process.env.COUNTER_TREND_MODE || 'down_weight',
      counterTrendEquityMode:  process.env.COUNTER_TREND_EQUITY_MODE  || process.env.COUNTER_TREND_MODE || 'down_weight',
      counterTrendDownweight:  parseFloat(process.env.COUNTER_TREND_DOWNWEIGHT || '0.6'),
    },
    futures: getFuturesGateStatus(),
    circuitBreakerFile: cbFile,
    openPositions: { futures: openFut, equity: openEq },
    pricer: pricerHealth,
    ts: new Date().toISOString(),
  };
  send(res, 200, status);
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  if (method === 'GET' && url === '/health')          return handleHealth(req, res);
  if (method === 'POST' && url === '/pine-alert')     return handlePineAlert(req, res);
  if (method === 'POST' && url === '/pine-close')     return handlePineClose(req, res);

  // ─── /control/* — operator REPL overrides ────────────────
  if (method === 'GET'  && url === '/control/status')                  return handleControlStatus(req, res);
  if (method === 'POST' && url === '/control/halt-path2')              return handleControlHaltPath2(req, res);
  if (method === 'POST' && url === '/control/resume-path2')            return handleControlResumePath2(req, res);
  if (method === 'POST' && url === '/control/halt-entries')            return handleControlHaltEntries(req, res);
  if (method === 'POST' && url === '/control/resume-entries')          return handleControlResumeEntries(req, res);
  if (method === 'POST' && url === '/control/toggle-1h-gate')          return handleControlToggle1H(req, res);
  if (method === 'POST' && url === '/control/clear-circuit-breaker')   return handleControlClearCircuitBreaker(req, res);
  if (method === 'POST' && url === '/control/flatten')                 return handleControlFlatten(req, res);
  if (method === 'POST' && url === '/control/repoll-futures')          return handleControlRepollFutures(req, res);
  if (method === 'POST' && url === '/control/mcp-restart')             return handleControlMcpRestart(req, res);

  send(res, 404, { ok: false, reason: 'NOT_FOUND', method, url });
});

server.listen(PORT, () => {
  const _ctMode = process.env.COUNTER_TREND_MODE || 'down_weight';
  const _ctMult = parseFloat(process.env.COUNTER_TREND_DOWNWEIGHT || '0.6');
  const _ctFut  = process.env.COUNTER_TREND_FUTURES_MODE || _ctMode;
  const _ctEq   = process.env.COUNTER_TREND_EQUITY_MODE  || _ctMode;
  const _ct1H   = (process.env.COUNTER_TREND_1H_ENABLED || 'true').toLowerCase() === 'true';
  // 2026-05-18: format multiplier inline per side; only show `× <mult>` when
  // mode is down_weight (block / off don't use it).
  const _ctFmt = (m) => m === 'down_weight' ? `${m} × ${_ctMult}` : m;
  console.log(`  [WEBHOOK] Counter-trend gates: futures=${_ctFmt(_ctFut)}`);
  console.log(`  [WEBHOOK]                      equity=${_ctFmt(_ctEq)}`);
  console.log(`  [WEBHOOK]                      1H-structural=${_ct1H ? 'ENABLED' : 'disabled'}`);
  const _acceptedTfsBanner = (process.env.ACCEPTED_TIMEFRAMES || '5').split(',').map(s => s.trim()).filter(Boolean);
  console.log(`  [WEBHOOK] Signal timeframe: ${_acceptedTfsBanner.join('/')} (other TFs → IGNORED_TIMEFRAME)`);
  console.log(`  [WEBHOOK] FADE_ENGINE PHASE 1 ENABLED — vol/range/VWAP triggers; news join 60s HIGH-impact; FOMC/CPI/NFP/GDP/PCE ±15min blackout; per-event dedup 5min`);
  console.log(`  [WEBHOOK] stacked-entry dedup: ENABLED (5m bar window, first-engine wins) — applies to futures + equity`);
  {
    const _pzm = (process.env.PINE_ZONE_MATH_FILTER_ENABLED || 'true').toLowerCase() === 'true';
    const _tx = parseFloat(process.env.PINE_ZONE_TOXIC_POINTS || '2.0');
    console.log(`  [WEBHOOK] Pine zone-math gate: ${_pzm ? `ENABLED (toxic<${_tx}pt — runs on EVERY engine incl. LIVE, no Vision needed, requires Pine §FIX12)` : 'disabled'}`);
  }
  {
    const _ptOn = (process.env.STACKED_DEDUP_PASSTHROUGH_ENABLED || 'true').toLowerCase() === 'true';
    const _ptAge = parseInt(process.env.STACKED_DEDUP_PASSTHROUGH_MIN_AGE_MS || '5000', 10);
    console.log(`  [WEBHOOK] dedup passthrough: ${_ptOn ? `ENABLED (release bucket when prior position CLOSED, min-age=${_ptAge}ms)` : 'disabled'}`);
  }
  {
    const _sgOn = (process.env.STRETCHED_GATE_ENABLED || 'true').toLowerCase() === 'true';
    const _sgVwap = (process.env.STRETCHED_VWAP_ENABLED || 'true').toLowerCase() === 'true';
    const _sgPd   = (process.env.STRETCHED_PD_ENABLED   || 'true').toLowerCase() === 'true';
    const _mult   = parseFloat(process.env.STRETCHED_VWAP_ATR_MULT || '2.0');
    console.log(`  [WEBHOOK] stretched-from-extreme gate: ${_sgOn ? `ENABLED (VWAP=${_sgVwap}@${_mult}×ATR, PD=${_sgPd}) — blocks late-fire pivots at PDL/PDH/VWAP extremes (SPY/QQQ/IWM only)` : 'disabled'}`);
  }
  {
    const _acceptedTfs = (process.env.ACCEPTED_TIMEFRAMES || '3,5').split(',').map(s=>s.trim()).filter(Boolean);
    if (_acceptedTfs.length >= 2) {
      console.log(`  [WEBHOOK] multi-TF Commit B: ENABLED — primary=${_acceptedTfs[0]}m, context=${_acceptedTfs.slice(1).join('+')}m; TF_DIVERGENCE/CONFLUENCE logged (5min window)`);
    } else {
      console.log(`  [WEBHOOK] multi-TF: single-TF mode (ACCEPTED_TIMEFRAMES=${_acceptedTfs[0] || '5'})`);
    }
  }
  {
    const _chopOn = (process.env.CHOP_MODE_ENABLED || 'true').toLowerCase() === 'true';
    const _flipWin = parseInt(process.env.CHOP_FLIPS_WINDOW_MS || '900000', 10);
    const _stable  = parseInt(process.env.CHOP_STABLE_HOLD_MS  || '600000', 10);
    const _thresh  = parseInt(process.env.CHOP_FLIP_THRESHOLD  || '2', 10);
    const _eng     = process.env.CHOP_TREND_ENGINE || 'TREND';
    console.log(`  [WEBHOOK] chop-mode suppression: ${_chopOn ? `ENABLED (>${_thresh} ${_eng}-flips in ${Math.round(_flipWin/60000)}min → suppress until ${Math.round(_stable/60000)}min stable)` : 'disabled'}`);
  }
  {
    const _vOn    = (process.env.VISION_ENABLED || 'true').toLowerCase() === 'true';
    const _vGate  = (process.env.VISION_GATE_ENABLED || 'true').toLowerCase() === 'true';
    const _vThr   = parseFloat(process.env.VISION_REJECT_THRESHOLD || '3.5');
    const _vBypass= (process.env.VISION_BYPASS_ENGINES || 'LIVE');
    const _vModel = process.env.VISION_MODEL || 'claude-haiku-4-5-20251001';
    const _vFO    = (process.env.VISION_FAIL_OPEN || 'true').toLowerCase() === 'true';
    if (_vOn) {
      const _veto = (process.env.VISION_VETO_ENABLED || 'true').toLowerCase() === 'true';
      const _offRth = (process.env.VISION_BYPASS_OFFRTH || 'true').toLowerCase() === 'true';
      const _respVeto = (process.env.VISION_OFFRTH_RESPECT_VETO || 'true').toLowerCase() === 'true';
      const _zoneRej = (process.env.VISION_ZONE_REJECT_ENABLED || 'true').toLowerCase() === 'true';
      const _zoneThr = parseFloat(process.env.VISION_ZONE_REJECT_THRESHOLD || '4');
      const _actMult = (process.env.VISION_ACTION_MULT_REJECT_ENABLED || 'true').toLowerCase() === 'true';
      const _zoneMath = (process.env.VISION_ZONE_MATH_FILTER_ENABLED || 'true').toLowerCase() === 'true';
      const _toxic = parseFloat(process.env.VISION_ZONE_TOXIC_POINTS || '2.0');
      const _sibCache = (process.env.VISION_SIBLING_CACHE_ENABLED || 'true').toLowerCase() === 'true';
      const _dzThr   = parseFloat(process.env.VISION_REJECT_THRESHOLD_DEAD_ZONE || '5.0');
      console.log(`  [WEBHOOK] VISION Phase 5: ENABLED — model=${_vModel}, session=${_sessionBand()}`);
      console.log(`  [WEBHOOK]   reject ladder: composite<${_vThr} [DEAD_ZONE<${_dzThr}]${_veto?' | veto=yes':''}${_zoneRej?` | ZONE-engine zone_setup_quality<${_zoneThr}`:''}${_actMult?' | action_mult=0.0':''}${_zoneMath?` | zone_math (toxic<${_toxic}pt)`:''}`);
      console.log(`  [WEBHOOK]   OFF-RTH bypass: ${_offRth ? `composite-only (veto+zone+action+math punch through)` : 'disabled'}`);
      console.log(`  [WEBHOOK]   bypass-engines=[${_vBypass}], fail-open=${_vFO}, sibling-cache=${_sibCache ? 'on' : 'off'}`);
    } else {
      console.log(`  [WEBHOOK] VISION Phase 5: disabled`);
    }
  }
  console.log(`  [WEBHOOK] Counter-trend gate: overnight-futures bypass ENABLED (RTH-stale bias allowed for ES1!/NQ1!/MES1!/MNQ1! outside 09:30-16:00 ET Mon-Fri) — operator data-collection mode through 2026-06-01`);
  {
    const _expCheckOn = (process.env.LATE_DAY_ENTRY_0DTE_EXP_CHECK || 'false').toLowerCase() === 'true';
    console.log(`  [paperTrading] Late-day 0DTE gate: ${_expCheckOn ? 'exp-aware (today-exp only, 1DTE+ pass)' : 'block-all SPY/QQQ/IWM after 15:30 ET (legacy)'}`);
  }
  // 2026-05-18: surface fresh calibration state at startup. If the lookup
  // file doesn't exist, calibrationCache returns the fallback {multiplier:1.0}
  // until analyze-calibration.js builds a new one. Operator-visible signal
  // that we're flying without calibration for the moment.
  try {
    const _calibFile = join(__dirname, 'data', 'calibration-lookup.json');
    if (!existsSync(_calibFile)) {
      console.log(`  [calibration] Cache reset — fallback multiplier=1.0 until next analyze-calibration build`);
    }
  } catch {}
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
  // 2026-05-18 Futures pricer — polls Webull MCP get_futures_snapshot every
  // 3s and writes latest-prices.json so futures-status.js (Window 9) renders
  // LIVE / uPnL columns. Starts after a brief grace period to let the MCP
  // child process connect; tolerates MCP being unavailable (silent no-op).
  import('./futuresPricer.js').then(m => m.startFuturesPricer()).catch(e => console.error(`  [WEBHOOK] Futures pricer init failed: ${e.message}`));
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
