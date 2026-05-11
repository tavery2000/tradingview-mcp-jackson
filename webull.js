#!/usr/bin/env node
/**
 * webull.js — HANK AI Webull OpenAPI Connection v2
 * Built by NYC2000
 *
 * Auth: HMAC-SHA1 signature per official Webull OpenAPI docs
 * Endpoint: us-openapi-alb.webullbroker.com (US production)
 */

import mqtt    from 'mqtt';
import https   from 'https';
import crypto  from 'crypto';
import dotenv  from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────

// Prod-only as of 2026-05-11. The --test flag still triggers a connection
// test below, but routing always goes to api.webull.com. UAT path removed:
// app credentials were registered on the production developer portal,
// never on UAT, so /openapi/account/list returned 401 UNAUTHORIZED. See
// webull-401-investigation-2026-05-11.md for the full audit.
const HOST      = 'api.webull.com';
const MQTT_HOST = 'api.webull.com';  // data-api.webull.com (52.20.72.130) is blocked — use CloudFront host
const BASE_URL  = `https://${HOST}`;

const CONFIG = {
  appKey:    process.env.WEBULL_APP_KEY,
  appSecret: process.env.WEBULL_APP_SECRET,
  appId:     process.env.WEBULL_APP_ID,
  host:      HOST,

  // Account IDs — confirmed 2026-05-03
  accounts: {
    cash:    'ICIUR8Q1AKI50628B9RQ3EG0IB',  // Individual Cash ← PRIMARY for HANK
    margin:  'HHICG64BAGK261F64CMGGER5UB',  // Individual Margin
    futures: 'FNJQ0I41DNA99G4PHQAKTJ8CBA',  // Futures
  },
  activeAccount: 'ICIUR8Q1AKI50628B9RQ3EG0IB', // Cash — paper trade + live options

  // MQTT
  mqttHost:     `wss://${MQTT_HOST}/mqtt`,
  keepalive:    60,
  reconnectMs:  3000,

  // Flow thresholds
  blockThreshold: 500,
  sweepWindowMs:  100,
  sweepMinVolume: 300,
  sweepMinCount:  3,

  // SPY options
  spyStrikeCount: 5,
  spyOTMPercent:  0.02,
  refreshMins:    30,
};

// ─── Colors ───────────────────────────────────────────────

const C = {
  reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
  red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m',
  cyan:'\x1b[36m', gray:'\x1b[90m', magenta:'\x1b[35m',
};

// ─── Signature Generation ────────────────────────────────
// Per official Webull docs: HMAC-SHA1 with specific header signing

// Per Webull support (2026-05-11): trade-scope endpoints (/openapi/trade/*)
// are transitioning to HMAC-SHA256 as the security standard for write
// operations. Backend is currently algorithm-aware via the
// `x-signature-algorithm` header — SHA1 still works for read/account endpoints,
// SHA256 is the recommended path for trade endpoints. Auto-select by path.
function generateSignature(path, queryParams={}, body=null) {
  const useSHA256 = path.startsWith('/openapi/trade/');
  const algorithm = useSHA256 ? 'HMAC-SHA256' : 'HMAC-SHA1';
  const hashAlgo  = useSHA256 ? 'sha256' : 'sha1';

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nonce     = crypto.randomUUID().replace(/-/g, '');

  // Signing headers (x-signature and x-version NOT included)
  const signingHeaders = {
    'x-app-key':             CONFIG.appKey,
    'x-timestamp':           timestamp,
    'x-signature-algorithm': algorithm,
    'x-signature-version':   '1.0',
    'x-signature-nonce':     nonce,
    'host':                  CONFIG.host,
  };

  // Step 1: Merge query params + signing headers, sort alphabetically
  const allParams = { ...queryParams, ...signingHeaders };
  const str1 = Object.keys(allParams)
    .sort()
    .map(k => `${k}=${allParams[k]}`)
    .join('&');

  // Step 2: MD5 of body if present (uppercase hex)
  let str3;
  if(body) {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body, null, 0).replace(/,\s+/g, ',').replace(/:\s+/g, ':');
    const str2    = crypto.createHash('md5').update(bodyStr, 'utf8').digest('hex').toUpperCase();
    str3 = `${path}&${str1}&${str2}`;
  } else {
    str3 = `${path}&${str1}`;
  }

  // Step 3: URL-encode str3
  const encodedString = encodeURIComponent(str3);

  // Step 4: HMAC with appSecret + '&' as key (SHA1 or SHA256 per algorithm above)
  const signingKey  = `${CONFIG.appSecret}&`;
  const signature   = crypto
    .createHmac(hashAlgo, signingKey)
    .update(encodedString)
    .digest('base64');

  return { signature, timestamp, nonce, algorithm };
}

// ─── HTTP Request ─────────────────────────────────────────

function apiRequest(method, path, queryParams={}, body=null, extraHeaders={}) {
  return new Promise((resolve, reject) => {
    const { signature, timestamp, nonce, algorithm } = generateSignature(path, queryParams, body);

    const headers = {
      'x-app-key':             CONFIG.appKey,
      'x-timestamp':           timestamp,
      'x-signature':           signature,
      'x-signature-algorithm': algorithm,
      'x-signature-version':   '1.0',
      'x-signature-nonce':     nonce,
      'x-version':             'v2',
      'Content-Type':          'application/json',
      'Host':                  CONFIG.host,
      ...extraHeaders,
    };

    // Include 2FA token if available
    if(cachedToken) headers['x-access-token'] = cachedToken;

    // Trade-scope endpoints require x-trade-token (obtained via 6-digit
    // trading password — see acquireTradeToken / --trade-token-login).
    // Auto-inject when calling /openapi/trade/* paths; skip the token-issuance
    // endpoint itself (which is how you get the token in the first place).
    if (path.startsWith('/openapi/trade/') && !path.includes('/token')) {
      const tt = loadTradeToken();
      if (tt) headers['x-trade-token'] = tt;
    }

    // Build query string
    const qs = Object.keys(queryParams).length
      ? '?' + Object.keys(queryParams).map(k => `${k}=${encodeURIComponent(queryParams[k])}`).join('&')
      : '';

    const options = {
      hostname: CONFIG.host,
      path:     path + qs,
      method:   method.toUpperCase(),
      headers,
      timeout:  12000,
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });

    if(body) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      req.write(bodyStr);
    }
    req.end();
  });
}

// ─── Quote Store (fixed size) ─────────────────────────────

const lastQuotes   = new Map();
const MAX_QUOTES   = 150;

function updateQuote(symbol, bid, ask) {
  if(!lastQuotes.has(symbol) && lastQuotes.size >= MAX_QUOTES) {
    lastQuotes.delete(lastQuotes.keys().next().value);
  }
  lastQuotes.set(symbol, {
    bid: parseFloat(bid || 0),
    ask: parseFloat(ask || 0),
    mid: (parseFloat(bid||0) + parseFloat(ask||0)) / 2,
    ts:  Date.now(),
  });
}

function classifySide(symbol, tickPrice) {
  const q = lastQuotes.get(symbol);
  if(!q) return 'UNKNOWN';
  if(tickPrice >= q.ask) return 'ASK';  // aggressive buy
  if(tickPrice <= q.bid) return 'BID';  // aggressive sell
  return 'MID';
}

// ─── Sweep Tracker (fixed size, auto-purge) ───────────────

const sweepTracker = new Map();

function purgeSweeps() {
  const cutoff = Date.now() - 5000;
  for(const [k, v] of sweepTracker) {
    if(v.ts < cutoff) sweepTracker.delete(k);
  }
}

function trackSweep(symbol, timestamp, volume) {
  if(sweepTracker.size > 1000) purgeSweeps();
  const key = `${symbol}_${timestamp}`;
  const ex  = sweepTracker.get(key);
  if(ex) {
    ex.volume += volume;
    ex.count  += 1;
  } else {
    sweepTracker.set(key, { volume, count:1, ts:Date.now() });
  }
  return sweepTracker.get(key);
}

// ─── Flow Processing ──────────────────────────────────────

const callbacks = {
  onBlock:   null,
  onSweep:   null,
  onQuote:   null,
  onTick:    null,
  onConnect: null,
  onMessage: null,
  onError:   null,
};

function processTick(data) {
  const symbol = data.ticker || data.symbol;
  const price  = parseFloat(data.price || 0);
  const volume = parseInt(data.volume  || 0);
  const ts     = data.time || Date.now();
  if(!symbol || !price || !volume) return;

  const side     = classifySide(symbol, price);
  const notional = price * volume * 100;

  // Block detection
  if(volume >= CONFIG.blockThreshold) {
    const block = { type:'BLOCK', symbol, price, volume, notional, side, ts,
      label:`📦 BLOCK: ${symbol} | ${volume} contracts @ $${price} | ${side} | $${(notional/1000).toFixed(0)}K` };
    console.log(`\n  ${C.magenta}${block.label}${C.reset}`);
    callbacks.onBlock?.(block);
    return;
  }

  // Sweep detection
  const cluster = trackSweep(symbol, ts, volume);
  if(cluster.count >= CONFIG.sweepMinCount && cluster.volume >= CONFIG.sweepMinVolume) {
    const firedKey = `fired_${symbol}_${ts}`;
    if(!sweepTracker.has(firedKey)) {
      sweepTracker.set(firedKey, { ts:Date.now(), volume:0, count:0 });
      const sweep = { type:'SWEEP', symbol, price, volume:cluster.volume, count:cluster.count,
        notional: cluster.volume*price*100, side, ts,
        label:`🧹 SWEEP: ${symbol} | ${cluster.volume} contracts (${cluster.count} trades) @ $${price} | ${side}` };
      console.log(`\n  ${C.yellow}${sweep.label}${C.reset}`);
      callbacks.onSweep?.(sweep);
    }
  }

  callbacks.onTick?.({ symbol, price, volume, side, notional, ts });
}

function processQuote(data) {
  const symbol = data.ticker || data.symbol;
  const bid    = parseFloat(data.bidPrice || data.bid || 0);
  const ask    = parseFloat(data.askPrice || data.ask || 0);
  if(!symbol) return;
  updateQuote(symbol, bid, ask);
  callbacks.onQuote?.({ symbol, bid, ask, mid:(bid+ask)/2 });
}

// ─── Token Management (2FA) ───────────────────────────────
// Token is created once, verified via Webull App, then stored
// Valid for 15 days of activity — reuse across sessions

import { readFileSync, writeFileSync, existsSync } from 'fs';

const TOKEN_FILE = join(__dirname, '.webull_token');
let cachedToken  = null;

function loadStoredToken() {
  try {
    console.log(`  [TOKEN] Checking: ${TOKEN_FILE}`);
    if (!existsSync(TOKEN_FILE)) {
      console.log(`  [TOKEN] File not found`);
      return null;
    }
    const buf  = readFileSync(TOKEN_FILE);
    console.log(`  [TOKEN] File hex (first 20 bytes): ${buf.slice(0, 20).toString('hex')}`);
    const raw  = buf.toString('utf8').replace(/^﻿/, '').trim();
    console.log(`  [TOKEN] Raw (first 80): ${raw.slice(0, 80)}`);
    const data = JSON.parse(raw);
    const statusHex = Buffer.from(String(data.status ?? '')).toString('hex');
    console.log(`  [TOKEN] Parsed — token: ${data.token ? data.token.slice(0,8)+'...' : 'MISSING'}, status: ${JSON.stringify(data.status)} (hex: ${statusHex}), savedAt: ${data.savedAt}`);
    if (!data.token) { console.log(`  [TOKEN] No token field`); return null; }
    if ((data.status ?? '').toString().trim() !== 'NORMAL') { console.log(`  [TOKEN] Status not NORMAL — got: ${JSON.stringify(data.status)}`); return null; }
    const age = Date.now() - (data.savedAt ?? 0);
    if (age > 6 * 60 * 60 * 1000) {
      console.log(`  [TOKEN] Expired (${Math.floor(age / 3600000)}h old)`);
      return null;
    }
    console.log(`  [TOKEN] Valid — returning ${data.token.slice(0, 8)}...`);
    return data.token;
  } catch(e) {
    console.log(`  [TOKEN] Exception: ${e.message}`);
    return null;
  }
}

function saveToken(token, status='NORMAL') {
  try {
    writeFileSync(TOKEN_FILE, JSON.stringify({ token, status, savedAt:Date.now() }));
  } catch(e) { console.warn(`  Could not save token: ${e.message}`); }
}

async function createToken() {
  try {
    const res = await apiRequest('POST', '/openapi/auth/token/create', {}, {});
    console.log(`  Create token raw response: ${JSON.stringify(res.data)}`);
    if(res.status === 200) {
      // Try multiple possible field names
      const token = res.data?.token || res.data?.accessToken || res.data?.data?.token;
      const status = res.data?.status || res.data?.data?.status || 'PENDING';
      if(token) {
        console.log(`  Token created: ${token.slice(0,8)}... (status: ${status})`);
        return token;
      }
    }
    console.error(`  Token creation failed (${res.status}): ${JSON.stringify(res.data)}`);
    return null;
  } catch(e) {
    console.error(`  Token create error: ${e.message}`);
    return null;
  }
}

async function checkTokenStatus(token) {
  try {
    // Check token is POST with token in body
    const res = await apiRequest('POST', '/openapi/auth/token/check', {}, { token });
    // Log raw response on first check to debug field names
    if(!checkTokenStatus._logged) {
      console.log(`\n  Check token raw: ${JSON.stringify(res.data)}`);
      checkTokenStatus._logged = true;
    }
    return res.data?.status || res.data?.data?.status || 'UNKNOWN';
  } catch(e) {
    return 'ERROR';
  }
}

// Full token flow — create + poll for app verification
async function getVerifiedToken(maxWaitSecs=300) {
  // Try stored token first
  const stored = loadStoredToken();
  if(stored) {
    cachedToken = stored;
    return stored;
  }

  console.log(`\n  ${C.cyan}2FA Token required — creating...${C.reset}`);
  const token = await createToken();
  if(!token) return null;

  console.log(`\n  ${C.yellow}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ACTION REQUIRED:`);
  console.log(`  Open Webull App → Menu → Messages → OpenAPI Notifications`);
  console.log(`  Tap the verification message → Check Now → Enter SMS code`);
  console.log(`  Waiting up to ${maxWaitSecs} seconds...`);
  console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}\n`);

  // Poll every 5 seconds
  const start    = Date.now();
  let   attempts = 0;

  while(Date.now() - start < maxWaitSecs * 1000) {
    await new Promise(r => setTimeout(r, 5000));
    attempts++;
    const status = await checkTokenStatus(token);
    const elapsed = Math.floor((Date.now()-start)/1000);
    process.stdout.write(`\r  Checking token status: ${status} (${elapsed}s elapsed / ${maxWaitSecs}s max)   `);

    if(status === 'NORMAL') {
      console.log(`\n\n  ${C.green}✓ Token verified! Saving for future use.${C.reset}`);
      saveToken(token);
      cachedToken = token;
      return token;
    }

    if(status === 'EXPIRED') {
      console.log(`\n\n  ${C.red}Token expired — restart to try again${C.reset}`);
      return null;
    }
  }

  console.log(`\n\n  ${C.red}Timeout — verification not completed in ${maxWaitSecs}s${C.reset}`);
  return null;
}

// ─── Account List (test endpoint) ────────────────────────

async function getAccountList() {
  try {
    const res = await apiRequest('GET', '/openapi/account/list');
    return res;
  } catch(e) {
    return { status:0, error: e.message };
  }
}

// ─── MQTT Connection ──────────────────────────────────────

let mqttClient   = null;
let isConnected  = false;

async function connectMQTT(symbols=[], opts={}) {
  console.log(`  Connecting MQTT: ${CONFIG.mqttHost}`);

  const { signature, timestamp, nonce } = generateSignature('/mqtt', {});

  // Load stored token — Webull MQTT broker expects token as password
  let token = null;
  try {
    if (existsSync(TOKEN_FILE)) {
      const stored = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
      token = stored.token ?? null;
    }
  } catch {}

  const mqttPassword = token ?? signature;
  console.log(`  MQTT auth: ${token ? 'token' : 'signature'} (${mqttPassword?.slice(0,8)}...)`);
  console.log(`  MQTT host: ${CONFIG.mqttHost}`);
  // Auth headers in WebSocket handshake + token/signature as MQTT password
  mqttClient = mqtt.connect(CONFIG.mqttHost, {
    username:        CONFIG.appKey,
    password:        mqttPassword,
    keepalive:       CONFIG.keepalive,
    reconnectPeriod: CONFIG.reconnectMs,
    connectTimeout:  15000,
    clientId:        `hank_${Date.now()}`,
    clean:           true,
    wsOptions: {
      headers: {
        'x-api-key':             CONFIG.appKey,
        'x-timestamp':           timestamp,
        'x-signature-nonce':     nonce,
        'x-signature-algorithm': 'HMAC-SHA1',
        'x-signature-version':   '1.0',
        'x-version':             'v2',
        'User-Agent':            'Mozilla/5.0 (compatible; HankBot/1.0)',
      }
    }
  });

  // Store callbacks for l2.js and flow.js
  if (opts.onMessage) callbacks.onMessage = opts.onMessage;
  if (opts.onConnect) callbacks.onConnect = opts.onConnect;
  if (opts.onError)   callbacks.onError   = opts.onError;

  mqttClient.on('connect', async () => {
    isConnected = true;
    console.log(`  ${C.green}✓ Webull MQTT connected${C.reset}`);
    if(symbols.length) await subscribeSymbols(symbols);
    callbacks.onConnect?.();
  });

  mqttClient.on('reconnect', () => { isConnected = false; console.log(`  ${C.yellow}MQTT reconnecting...${C.reset}`); });
  mqttClient.on('disconnect', () => { isConnected = false; });
  mqttClient.on('offline',    () => { isConnected = false; console.log(`  ${C.red}MQTT offline${C.reset}`); });
  mqttClient.on('error', err  => { console.error(`  MQTT error: ${err.message}`); callbacks.onError?.(err); });

  mqttClient.on('message', (topic, payload) => {
    try {
      // Fire raw onMessage callback first — used by l2.js and flow.js
      callbacks.onMessage?.(topic, payload);

      const data    = JSON.parse(payload.toString());
      const msgType = data.msgType || data.msg_type || '';
      if(msgType === 'QUOTE' || data.bidPrice || data.askPrice) processQuote(data);
      else if(msgType === 'TICK' || data.price)                 processTick(data);
    } catch {}
  });

  return true;
}

async function subscribeSymbols(symbols, subTypes=['TICK','QUOTE']) {
  if(!mqttClient || !isConnected) return false;
  try {
    const body = { appId:CONFIG.appId, symbols, category:'US_OPTION', subTypes };
    const res  = await apiRequest('POST', '/openapi/quotes/stream/subscribe', {}, body);
    if(res.status === 200) {
      console.log(`  ${C.green}✓ Subscribed: ${symbols.length} symbols${C.reset}`);
      return true;
    }
    console.error(`  Subscribe failed (${res.status}): ${JSON.stringify(res.data)}`);
    return false;
  } catch(e) {
    console.error(`  Subscribe error: ${e.message}`);
    return false;
  }
}

function getStatus() {
  return { connected:isConnected, quoteStore:lastQuotes.size, sweepKeys:sweepTracker.size };
}

function disconnect() {
  if(mqttClient) { mqttClient.end(true); mqttClient=null; isConnected=false; }
}

// ─── Consumer API (quotes-gw.webullfintech.com) ───────────────────────────────
// Webull's app uses this separate host for market data including options chains
// Auth: did (device ID) + access_token in headers

const CONSUMER_HOST    = 'quotes-gw.webullfintech.com';
const TRADE_HOST       = 'ustrade.webullfinance.com';
const CONSUMER_DID     = `hank_${CONFIG.appId}`;  // device ID

function consumerRequest(hostname, path, queryParams={}) {
  // Lazy-load token from disk on every call if in-memory cache is empty
  if (!cachedToken) {
    const loaded = loadStoredToken();
    if (loaded) cachedToken = loaded;
  }

  return new Promise((resolve, reject) => {
    const qs = Object.keys(queryParams).length
      ? '?' + Object.keys(queryParams).map(k => `${k}=${encodeURIComponent(queryParams[k])}`).join('&')
      : '';

    const headers = {
      'did':            CONSUMER_DID,
      'access_token':   cachedToken ?? '',
      'Content-Type':   'application/json',
      'User-Agent':     'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept':         'application/json',
    };

    const options = {
      hostname,
      path: path + qs,
      method: 'GET',
      headers,
      timeout: 12000,
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ─── Consumer Options Chain (quotes-gw / quoteapi) ────────
//
// CRITICAL CONTEXT: The Webull OpenAPI (api.webull.com) explicitly does NOT
// support options market data — Webull's docs show "US Options ✗" in the
// market-data compatibility matrix. Options chain calls require the
// CONSUMER quotes-gw API, which uses a different host AND a different auth
// scheme (consumer session token, not OpenAPI HMAC).
//
// The previous "API_DISABLED" comment was wrong — it was not a permissions
// issue. The code was hitting consumer endpoints with OpenAPI HMAC tokens,
// which Webull rejects as 404/API_DISABLED. Fix: separate consumer-token
// path with the correct endpoints and headers.
//
// Token acquisition (one-time setup before Monday):
//   Option A — login script: node webull.js --consumer-login
//              prompts for email/password/MFA and saves .webull_consumer_token
//   Option B — manual capture: log into webull.com, open DevTools → Network,
//              copy `access_token` header value from any /api/quote/* call,
//              paste into .webull_consumer_token as JSON: {"token":"...","savedAt":...}
//   Option C — env var: export WEBULL_CONSUMER_TOKEN="..." before running monitors
//
// Endpoints (all consumer, NOT OpenAPI):
//   POST https://quotes-gw.webullfintech.com/api/quote/option/strategy/list
//        body: { tickerId, count: -1, direction: 'all' }
//        response: { expireDateList: [{ from: { date, days, weekly }, data: [{ strikePrice, direction, tickerId, ... greeks }]}] }
//   GET  https://quotes-gw.webullbroker.com/api/quote/option/query/list?tickerId=X&derivativeIds=Y,Z
//        response: array of full quotes with delta/gamma/theta/vega/impVol/bid/ask/oi/vol
//   GET  https://quotes-gw.webullfintech.com/api/search/pc/tickers?keyword=SPY&pageIndex=1&pageSize=10&regionId=6
//        response: tickerId lookup (public, no auth required)

const CONSUMER_TOKEN_FILE = join(__dirname, '.webull_consumer_token');
let cachedConsumerToken   = null;

// ─── Trade Token (for order placement) ────────────────────────────────────
// Per Webull support (2026-05-11): order POSTs to /openapi/trade/* require
// an `x-trade-token` header. Acquire it once per session by POSTing the
// 6-digit trading password to /openapi/trade/v2/token. Token cache lives in
// .webull_trade_token (same pattern as .webull_token and .webull_consumer_token).
// Token expires on inactivity — refresh with `node webull.js --trade-token-login`.
const TRADE_TOKEN_FILE = join(__dirname, '.webull_trade_token');
let cachedTradeToken   = null;

function loadTradeToken() {
  if (cachedTradeToken) return cachedTradeToken;
  if (process.env.WEBULL_TRADE_TOKEN) {
    cachedTradeToken = process.env.WEBULL_TRADE_TOKEN.trim();
    return cachedTradeToken;
  }
  try {
    if (!existsSync(TRADE_TOKEN_FILE)) return null;
    const data = JSON.parse(readFileSync(TRADE_TOKEN_FILE, 'utf8'));
    if (!data.token) return null;
    cachedTradeToken = data.token;
    return cachedTradeToken;
  } catch { return null; }
}

function saveTradeToken(token, extra={}) {
  writeFileSync(TRADE_TOKEN_FILE, JSON.stringify({ token, savedAt: Date.now(), ...extra }, null, 2));
  cachedTradeToken = token;
}

// Trade an OpenAPI 6-digit trading password for a trade_token.
// Endpoint per Webull: POST /openapi/trade/v2/token
// Response shape (per spec): { trade_token: "...", expire_in: <seconds> } — adapt
// in error handler if Webull returns a different field name.
async function acquireTradeToken(password) {
  if (!password || !/^\d{6}$/.test(password)) {
    return { error: 'trading password must be 6 digits', status: 0 };
  }
  const res = await apiRequest('POST', '/openapi/trade/v2/token', {}, { password });
  if (res.status !== 200) return { error: res.data, status: res.status };
  const token = res.data?.trade_token ?? res.data?.tradeToken ?? res.data?.data?.trade_token;
  if (!token) return { error: `no trade_token field in response: ${JSON.stringify(res.data)?.slice(0,200)}`, status: res.status };
  saveTradeToken(token, { source: 'acquireTradeToken' });
  return { token, status: res.status };
}

// Well-known tickerIds for our trading instruments — verified vs Webull search.
// Search the public endpoint if a symbol isn't here.
const TICKER_ID = {
  SPY: '913243251',
  QQQ: '913243083',
  IWM: '913243089',
};
const tickerIdCache = { ...TICKER_ID };

function loadConsumerToken() {
  if (cachedConsumerToken) return cachedConsumerToken;
  // Env var takes precedence — easy override for testing
  if (process.env.WEBULL_CONSUMER_TOKEN) {
    cachedConsumerToken = process.env.WEBULL_CONSUMER_TOKEN.trim();
    return cachedConsumerToken;
  }
  try {
    if (!existsSync(CONSUMER_TOKEN_FILE)) return null;
    const data = JSON.parse(readFileSync(CONSUMER_TOKEN_FILE, 'utf8'));
    if (!data.token) return null;
    // Consumer tokens last ~15 days but we re-check each session
    cachedConsumerToken = data.token;
    return cachedConsumerToken;
  } catch { return null; }
}

function saveConsumerToken(token, extra = {}) {
  try {
    writeFileSync(CONSUMER_TOKEN_FILE, JSON.stringify({ token, savedAt: Date.now(), ...extra }, null, 2));
    cachedConsumerToken = token;
  } catch (e) { console.warn(`  [CONSUMER-TOKEN] save failed: ${e.message}`); }
}

// Full header set the consumer API expects. Missing headers (especially
// app/appid/platform) trigger silent rejections. Mirror the web-app client
// so we look like a normal browser session.
function consumerHeaders(extra = {}) {
  const reqid = crypto.randomUUID();
  const tok   = loadConsumerToken();
  return {
    'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':           'application/json, text/plain, */*',
    'Accept-Language':  'en-US,en;q=0.9',
    'Accept-Encoding':  'identity',
    'Content-Type':     'application/json',
    'Origin':           'https://www.webull.com',
    'Referer':          'https://www.webull.com/',
    'app':              'global',
    'appid':            'wb_web_app',
    'ver':              '4.0.0',
    'platform':         'web',
    'os':               'web',
    'osv':              'i9zh',
    'hl':               'en',
    'locale':           'eng',
    'lzone':            'dc_core_r001',
    'device-type':      'Web',
    'did':              CONSUMER_DID,
    'reqid':            reqid,
    ...(tok ? { 'access_token': tok } : {}),
    ...extra,
  };
}

// Generic consumer GET/POST — supersedes the older consumerRequest for
// options data. Uses full headers and accepts arbitrary host.
function consumerCall(method, hostname, path, { query = null, body = null, extraHeaders = {} } = {}) {
  return new Promise((resolve, reject) => {
    const qs = query && Object.keys(query).length
      ? '?' + Object.keys(query).map(k => `${k}=${encodeURIComponent(query[k])}`).join('&')
      : '';
    const opts = {
      hostname, path: path + qs,
      method: method.toUpperCase(),
      headers: consumerHeaders(extraHeaders),
      timeout: 12000,
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body != null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

/**
 * Look up Webull tickerId for a symbol. Public search endpoint — no auth.
 * Caches results per process. Pre-seeded with SPY/QQQ/IWM (well-known IDs).
 */
async function lookupTickerId(symbol) {
  const sym = symbol.toUpperCase();
  if (tickerIdCache[sym]) return tickerIdCache[sym];
  try {
    const res = await consumerCall('GET', 'quotes-gw.webullfintech.com', '/api/search/pc/tickers', {
      query: { keyword: sym, pageIndex: 1, pageSize: 10, regionId: 6 },
    });
    if (res.status !== 200 || !res.data?.data?.length) return null;
    // Prefer exact symbol match
    const hit = res.data.data.find(t => (t.symbol === sym || t.disSymbol === sym)) ?? res.data.data[0];
    if (hit?.tickerId) tickerIdCache[sym] = String(hit.tickerId);
    return tickerIdCache[sym] ?? null;
  } catch { return null; }
}

/**
 * Fetch options expirations + full chain for a symbol.
 * One call returns ALL strikes for ALL expirations (paginated by Webull,
 * but `count: -1` means "give me everything").
 *
 * Returns: { expirations: [{ date, days, weekly }], chains: { 'YYYY-MM-DD': [strikes] } }
 *   each strike row: { strikePrice, call: {tickerId, delta, gamma, theta, vega, impVol, oi, volume, bid, ask, ...}, put: {...} }
 */
async function getOptionsExpirations(symbol) {
  const tickerId = await lookupTickerId(symbol);
  if (!tickerId) return { error: `no tickerId for ${symbol}`, expirations: [], chains: {} };
  if (!loadConsumerToken()) return { error: 'no consumer token — run `node webull.js --consumer-login`', expirations: [], chains: {} };

  try {
    const res = await consumerCall('POST', 'quotes-gw.webullfintech.com', '/api/quote/option/strategy/list', {
      body: { tickerId, count: -1, direction: 'all' },
    });
    if (res.status !== 200 || !res.data?.expireDateList) {
      return { error: `status ${res.status}: ${typeof res.data === 'string' ? res.data.slice(0,200) : JSON.stringify(res.data).slice(0,200)}`, expirations: [], chains: {} };
    }

    const expirations = [];
    const chains      = {};
    for (const block of res.data.expireDateList) {
      const date    = block?.from?.date;
      const days    = block?.from?.days ?? null;
      const weekly  = block?.from?.weekly ?? false;
      if (!date) continue;
      expirations.push({ date, days, weekly });

      // Group by strike
      const byStrike = new Map();
      for (const row of block.data ?? []) {
        const k = row.strikePrice;
        if (!byStrike.has(k)) byStrike.set(k, { strikePrice: parseFloat(k), call: null, put: null });
        const side = (row.direction || '').toLowerCase();
        if (side === 'call' || side === 'put') byStrike.get(k)[side] = normalizeContract(row);
      }
      chains[date] = [...byStrike.values()].sort((a, b) => a.strikePrice - b.strikePrice);
    }
    return { tickerId, symbol, expirations, chains };
  } catch (e) {
    return { error: e.message, expirations: [], chains: {} };
  }
}

// Map Webull's contract record to our normalized shape.
function normalizeContract(row) {
  return {
    derivativeId: String(row.tickerId ?? row.derivativeId ?? ''),
    symbol:       row.symbol ?? null,
    type:         (row.direction || '').toLowerCase(),       // 'call' | 'put'
    strike:       parseFloat(row.strikePrice ?? 0),
    expireDate:   row.expireDate ?? null,
    bid:          parseFloat(row.bid?.price ?? row.bid ?? 0) || null,
    ask:          parseFloat(row.ask?.price ?? row.ask ?? 0) || null,
    last:         parseFloat(row.close ?? row.latestPrice ?? 0) || null,
    volume:       parseInt(row.volume ?? row.totalVolume ?? 0) || 0,
    oi:           parseInt(row.openInterest ?? 0) || 0,
    delta:        row.delta != null ? parseFloat(row.delta) : null,
    gamma:        row.gamma != null ? parseFloat(row.gamma) : null,
    theta:        row.theta != null ? parseFloat(row.theta) : null,
    vega:         row.vega  != null ? parseFloat(row.vega)  : null,
    iv:           row.impVol != null ? parseFloat(row.impVol) : null,
    raw:          row,
  };
}

/**
 * Get the chain for a single expiration. Convenience wrapper around
 * getOptionsExpirations that filters to one date.
 */
async function getOptionsChain(symbol, expireDate) {
  const all = await getOptionsExpirations(symbol);
  if (all.error) return { error: all.error, strikes: [] };
  const strikes = all.chains[expireDate] ?? [];
  if (!strikes.length) return { error: `no chain for ${expireDate}`, available: Object.keys(all.chains), strikes: [] };
  return { tickerId: all.tickerId, symbol, expireDate, strikes };
}

/**
 * Fetch a single option's live quote + greeks given the underlying tickerId
 * and one or more derivativeIds (returned in chain rows).
 */
async function getOptionsQuote(tickerIdOrSymbol, derivativeIds) {
  let tickerId = tickerIdOrSymbol;
  if (typeof tickerId === 'string' && /^[A-Z]+$/i.test(tickerId)) {
    tickerId = await lookupTickerId(tickerId);
  }
  if (!tickerId) return { error: 'no tickerId' };
  if (!loadConsumerToken()) return { error: 'no consumer token' };

  const ids = Array.isArray(derivativeIds) ? derivativeIds.join(',') : String(derivativeIds);
  try {
    const res = await consumerCall('GET', 'quotes-gw.webullbroker.com', '/api/quote/option/query/list', {
      query: { tickerId, derivativeIds: ids },
    });
    if (res.status !== 200) return { error: `status ${res.status}` };
    const list = Array.isArray(res.data) ? res.data : (res.data?.data ?? []);
    return { contracts: list.map(normalizeContract) };
  } catch (e) { return { error: e.message }; }
}

/**
 * Select the best contract for a directional trade.
 *
 * Expiry logic (HANK rules — small account optimized):
 *   - 0DTE: during active market 09:30–15:30 ET when today has an expiry
 *   - 1DTE: before open, after 15:30, or no 0DTE today — buy next day expiry
 *   - Never weekly — too expensive for small account
 *   - SPY expires Mon/Wed/Fri — QQQ/IWM expire every weekday
 *
 * Strike logic:
 *   - CALLS: ATM +1 strike (slightly OTM)
 *   - PUTS:  ATM -1 strike
 *   - Strong ATR (>0.5% of price) → 2 strikes OTM for more leverage
 */
function selectContract(symbol, price, direction, atr = null) {
  const type = direction === 'CALLS' ? 'CALL' : 'PUT';

  // ── Strike selection ──────────────────────────────────────────────────────
  const rounded = Math.round(price);
  const otmStrikes = (atr && atr / price > 0.005) ? 2 : 1;
  const strike = type === 'CALL' ? rounded + otmStrikes : rounded - otmStrikes;

  // ── Expiry selection ───────────────────────────────────────────────────────
  const now     = new Date();
  const etTime  = now.toLocaleTimeString('en-US', { timeZone:'America/New_York', hour12:false, hour:'2-digit', minute:'2-digit' });
  const [h, m]  = etTime.split(':').map(Number);
  const etMins  = h * 60 + m;
  const etDateStr = now.toLocaleDateString('en-US', { timeZone:'America/New_York' });
  const [mo, d, y] = etDateStr.split('/');
  const todayStr  = `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;
  // §DTE fix 2026-05-11: numeric-args Date constructor uses local TZ, avoiding the
  // UTC-midnight parsing trap that made today (a weekday) read as Sunday in ET.
  const dayOfWeek = new Date(+y, +mo - 1, +d).getDay();

  // All three instruments expire every weekday — SPY now Mon-Fri daily
  const allWeekdays = [1, 2, 3, 4, 5];
  const todayHasExpiry = allWeekdays.includes(dayOfWeek);

  // Options trade 09:30–16:00 ET only — isTradingHours() gates execution
  // 0DTE: 09:30–15:30 ET when today has an expiry
  // 1DTE: 15:30–16:00 ET — too close to close, buy next day expiry
  // Only use 0DTE during active market hours on a trading day
  // Outside market hours (evening/weekend) → always 1DTE (next trading day)
  const duringMarket = etMins >= 9 * 60 + 30 && etMins < 15 * 60 + 30;
  const use0DTE = duringMarket && todayHasExpiry;

  function nextTradingExpiry(daysAhead) {
    for (let i = daysAhead; i <= daysAhead + 4; i++) {
      // §DTE fix 2026-05-11: numeric-args constructor uses local TZ; mirrors the
      // line-846 fix. Self-corrects today via the toLocaleDateString round-trip
      // below but is fragile if that round-trip is ever removed.
      const next = new Date(+y, +mo - 1, +d);
      next.setDate(next.getDate() + i);
      const dow = next.getDay();
      if (dow === 0 || dow === 6) continue; // skip weekends
      const [nm, nd, ny] = next.toLocaleDateString('en-US', { timeZone:'America/New_York' }).split('/');
      return `${ny}-${nm.padStart(2,'0')}-${nd.padStart(2,'0')}`;
    }
    return todayStr;
  }

  const expiry      = use0DTE ? todayStr : nextTradingExpiry(1);
  const expiryLabel = use0DTE ? '0DTE' : '1DTE';

  // Build OCC standard option symbol — universal across all brokers
  // Format: SPY260505C00719000
  // = symbol + YYMMDD + C/P + strike*1000 padded to 8 digits
  const ymd     = expiry.slice(2).replace(/-/g, ''); // 260505
  const cp      = type === 'CALL' ? 'C' : 'P';
  const strikePadded = Math.round(strike * 1000).toString().padStart(8, '0');
  const occSymbol = `${symbol}${ymd}${cp}${strikePadded}`;

  console.log(`  [OPTIONS] ${symbol} ${type} $${strike} exp ${expiry} (${expiryLabel} · ${otmStrikes} OTM) → ${occSymbol}`);
  return { strike, expiry, type, use0DTE, expiryLabel, otmStrikes, occSymbol };
}

// ─── Order Placement ──────────────────────────────────────────────────────────

/**
 * Look up the Webull-internal numeric tickerId for a specific option contract.
 * Per Webull support (2026-05-11): the order endpoint requires this numeric ID,
 * NOT the OSI symbol string. tickerIds live in the consumer-API option chain
 * response (s.call.tickerId / s.put.tickerId from getOptionsChain).
 *
 * Requires consumer token (.webull_consumer_token) — same as options-chain reads.
 * Returns string tickerId on success, or null on miss/error.
 */
async function lookupOptionContractTickerId(symbol, strike, expiry, type) {
  if (!loadConsumerToken()) return null;
  try {
    const all = await getOptionsExpirations(symbol);
    if (all.error || !all.chains) return null;
    const chain = all.chains[expiry];
    if (!chain) return null;
    const slot = chain.find(s => Math.abs(s.strikePrice - parseFloat(strike)) < 0.005);
    if (!slot) return null;
    const leg  = type === 'CALL' ? slot.call : slot.put;
    return leg?.tickerId ? String(leg.tickerId) : null;
  } catch { return null; }
}

/**
 * Place an options order via Webull REST API.
 * In PAPER mode — simulates fill at mid price.
 * In LIVE mode  — sends real order to Webull.
 *
 * LIVE-mode prerequisites (2026-05-11 spec from Webull support):
 *   1. .webull_trade_token loaded (run `node webull.js --trade-token-login`)
 *   2. .webull_consumer_token loaded (run `node webull.js --consumer-login`) —
 *      needed for tickerId lookup on the option contract
 *   3. contract.tickerId pre-populated, OR symbol/strike/expiry/type provided
 *      so lookupOptionContractTickerId can resolve it
 */
async function placeOptionsOrder(contract, action, quantity=1) {
  const mode = process.env.TRADING_MODE ?? 'PAPER';

  if (mode === 'PAPER') {
    const price     = contract.mid || contract.ask || 1.0;
    const fillPrice = action === 'BUY_TO_OPEN'
      ? parseFloat((price + 0.01).toFixed(2))
      : parseFloat((price - 0.01).toFixed(2));
    return {
      success: true, paper: true,
      orderId: `PAPER_${Date.now()}`,
      action, quantity, fillPrice,
      symbol:    contract.symbol,
      strike:    contract.strike,
      expiry:    contract.expiry,
      type:      contract.type,
      occSymbol: contract.occSymbol,
      mid:       price,
    };
  }

  // LIVE — Webull OpenAPI US options order
  // Endpoint: POST /openapi/trade/option/order/place
  // Schema per Webull support (2026-05-11): flat camelCase body keyed on
  // numeric `tickerId` (not OSI symbol). x-trade-token header auto-injected
  // by apiRequest when path starts with /openapi/trade/. HMAC-SHA256 used
  // for trade-scope signing per generateSignature path-detection.
  //
  // Prior schema (nested new_orders[].legs[], snake_case, client_order_id)
  // returned OAUTH_OPENAPI_PARAM_ERR "invalid client_order_id" on 2026-05-05.
  // That was a parameter-validation rejection of unknown field names, NOT
  // a permission gate (Webull confirmed 2026-05-11). Migrated to current spec.

  // Verify trade_token is present — fail fast with actionable message
  if (!loadTradeToken()) {
    const msg = 'no trade_token loaded — run `node webull.js --trade-token-login`';
    console.log(`  [ORDER] ${C.red}${msg}${C.reset}`);
    return { success: false, error: msg };
  }

  // Resolve tickerId — required by new schema. Use pre-populated if caller
  // provided it; otherwise look up via consumer-API option chain.
  let tickerId = contract.tickerId;
  if (!tickerId) {
    tickerId = await lookupOptionContractTickerId(
      contract.symbol, contract.strike, contract.expiry, contract.type
    );
  }
  if (!tickerId) {
    const msg = `tickerId lookup failed for ${contract.occSymbol} — consumer token loaded? chain available?`;
    console.log(`  [ORDER] ${C.red}${msg}${C.reset}`);
    return { success: false, error: msg };
  }

  try {
    const limitPrice = (contract.mid || contract.ask || 1.0).toFixed(2);
    const body = {
      orderId:     crypto.randomUUID(),
      tickerId:    String(tickerId),
      action:      action === 'BUY_TO_OPEN' ? 'BUY' : 'SELL',
      orderType:   'LMT',
      lmtPrice:    limitPrice,
      quantity:    quantity.toString(),
      timeInForce: 'DAY',
      orderSide:   action === 'BUY_TO_OPEN' ? 'OPEN' : 'CLOSE',
      category:    'OPTION',
    };

    const res = await apiRequest(
      'POST',
      '/openapi/trade/option/order/place',
      { account_id: CONFIG.activeAccount },
      body
    );

    if (res.status === 200 || res.status === 201) {
      const orderId = res.data?.orderId ?? res.data?.[0]?.orderId ?? body.orderId;
      console.log(`  [ORDER] ✓ ${contract.occSymbol} ${body.action} × ${quantity} @ $${limitPrice} | id: ${orderId}`);
      return {
        success: true, paper: false,
        orderId, action, quantity,
        symbol:    contract.symbol,
        strike:    contract.strike,
        expiry:    contract.expiry,
        type:      contract.type,
        tickerId:  body.tickerId,
        fillPrice: parseFloat(limitPrice),
        occSymbol: contract.occSymbol,
      };
    }

    console.log(`  [ORDER] Failed ${res.status}: ${JSON.stringify(res.data)?.slice(0,200)}`);
    return { success: false, error: res.data, status: res.status };

  } catch(e) {
    console.log(`  [ORDER] Error: ${e.message}`);
    return { success: false, error: e.message };
  }
}

function getCachedToken() { return cachedToken; }

export { connectMQTT, subscribeSymbols, getAccountList, getVerifiedToken, getStatus,
         disconnect, callbacks, CONFIG, apiRequest, consumerRequest,
         getOptionsQuote, selectContract, placeOptionsOrder,
         getCachedToken,
         // Options chain (consumer API)
         getOptionsExpirations, getOptionsChain, lookupTickerId,
         lookupOptionContractTickerId,
         loadConsumerToken, saveConsumerToken,
         consumerCall, consumerHeaders,
         // Trade token (live order placement)
         loadTradeToken, saveTradeToken, acquireTradeToken };

// ─── Trade token login ────────────────────────────────────
// Usage: node webull.js --trade-token-login
// Prompts for the 6-digit trading password, calls /openapi/trade/v2/token,
// saves the returned trade_token to .webull_trade_token. Run this before
// any LIVE order placement. Token expires on inactivity; re-run to refresh.

if (process.argv.includes('--trade-token-login')) {
  console.log(C.bold + '\n  ⬡ HANK Webull — Trade Token Login\n' + C.reset);

  if (!CONFIG.appKey || !CONFIG.appSecret) {
    console.error(`  ${C.red}✗ Missing WEBULL_APP_KEY or WEBULL_APP_SECRET in .env${C.reset}`);
    process.exit(1);
  }

  const readline = await import('readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('  Enter your Webull 6-digit trading password (NOT account password):');
  const pw = (await rl.question('  > ')).trim();
  rl.close();

  if (!/^\d{6}$/.test(pw)) {
    console.error(`  ${C.red}✗ Password must be exactly 6 digits.${C.reset}\n`);
    process.exit(1);
  }

  console.log('\n  Requesting trade_token from /openapi/trade/v2/token...');
  const res = await acquireTradeToken(pw);
  if (res.error) {
    console.error(`  ${C.red}✗ ${typeof res.error === 'string' ? res.error : JSON.stringify(res.error)}${C.reset}\n`);
    process.exit(1);
  }
  console.log(`  ${C.green}✓ Saved to .webull_trade_token (${res.token.slice(0, 8)}...)${C.reset}`);
  console.log(`  ${C.green}  Verify by attempting a live order test (when ready).${C.reset}\n`);
  process.exit(0);
}

// ─── Auth mode ────────────────────────────────────────────
// Usage: node webull.js --auth
// Runs the Webull 2FA token flow and exits. Refreshes .webull_token.

if (process.argv.includes('--auth')) {
  console.log(C.bold + '\n  ⬡ HANK Webull — Token Refresh\n' + C.reset);

  if (!CONFIG.appKey || !CONFIG.appSecret) {
    console.error('  ✗ Missing WEBULL_APP_KEY or WEBULL_APP_SECRET in .env');
    process.exit(1);
  }

  // If a valid token already exists, confirm and exit
  const existing = loadStoredToken();
  if (existing) {
    console.log(`  ${C.green}✓ Token already valid — no refresh needed.${C.reset}`);
    console.log(`  Token: ${existing.slice(0, 8)}...`);
    process.exit(0);
  }

  // Show what we're clearing
  try {
    const stale = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
    if (stale.status && stale.status !== 'NORMAL') {
      console.log(`  Stale token status: ${stale.status} — starting fresh flow...\n`);
    }
  } catch { /* no token file — first run */ }

  const token = await getVerifiedToken(300);

  if (token) {
    console.log(`\n  ${C.green}✓ Token verified and saved to .webull_token${C.reset}`);
    console.log(`  ${C.green}  Live options pricing will activate on next monitor.js restart.${C.reset}\n`);
    process.exit(0);
  } else {
    console.error(`\n  ${C.red}✗ Auth failed — open Webull app → Menu → Messages → OpenAPI Notifications${C.reset}`);
    console.error(`  ${C.red}  Tap the verification message, then re-run: node webull.js --auth${C.reset}\n`);
    process.exit(1);
  }
}

// ─── Consumer-token login helper ──────────────────────────
// Run on Monday morning before market open:
//   node webull.js --consumer-login
// Prompts for email/password/MFA via stdin and saves .webull_consumer_token.
// Alternative: capture access_token from webull.com DevTools (Network tab,
// any /api/quote/* call) and write it manually:
//   echo '{"token":"YOUR_TOKEN","savedAt":'$(date +%s000)'}' > .webull_consumer_token

if (process.argv.includes('--consumer-login')) {
  console.log(C.bold + '\n  ⬡ HANK Webull — Consumer Token Setup\n' + C.reset);
  console.log('  This uses Webull\'s consumer login (the same auth path as');
  console.log('  webull.com / mobile app), separate from the OpenAPI HMAC token.');
  console.log('  Required for options chain data.\n');

  const existing = loadConsumerToken();
  if (existing) {
    console.log(`  ${C.green}✓ Consumer token present (${existing.slice(0, 8)}...)${C.reset}`);
    console.log('  Run with --force to re-login.\n');
    if (!process.argv.includes('--force')) process.exit(0);
  }

  console.log('  Recommended path: capture from browser DevTools.');
  console.log('   1. Log in at https://www.webull.com');
  console.log('   2. Open DevTools (F12) → Network tab');
  console.log('   3. Click any quote/chart request to a /api/quote/* URL');
  console.log('   4. Copy the `access_token` request header value');
  console.log('   5. Paste it below.\n');

  const readline = await import('readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const tok = (await rl.question('  Paste access_token: ')).trim();
  rl.close();

  if (!tok || tok.length < 10) {
    console.error(`  ${C.red}✗ Token looks invalid — aborting.${C.reset}\n`);
    process.exit(1);
  }
  saveConsumerToken(tok, { source: 'manual-paste' });
  console.log(`\n  ${C.green}✓ Saved to .webull_consumer_token${C.reset}`);
  console.log(`  ${C.green}  Verify with: node webull.js --test-options SPY${C.reset}\n`);
  process.exit(0);
}

// ─── Options chain test mode ──────────────────────────────
// Smoke-tests the new consumer endpoints end-to-end:
//   node webull.js --test-options SPY
// Prints expirations, then dumps the 0DTE chain ATM ± 5 strikes with greeks.
// Run Monday at/after 09:30 when 0DTE is live.

if (process.argv.includes('--test-options')) {
  const sym = (process.argv[process.argv.indexOf('--test-options') + 1] ?? 'SPY').toUpperCase();
  console.log(C.bold + `\n  ⬡ HANK Webull — Options Chain Test (${sym})\n` + C.reset);

  const tok = loadConsumerToken();
  if (!tok) {
    console.error(`  ${C.red}✗ No consumer token. Run: node webull.js --consumer-login${C.reset}\n`);
    process.exit(1);
  }
  console.log(`  Consumer token: ${tok.slice(0, 12)}...`);

  console.log('\n  Step 1: Looking up tickerId...');
  const tid = await lookupTickerId(sym);
  if (!tid) { console.error(`  ${C.red}✗ tickerId lookup failed${C.reset}\n`); process.exit(1); }
  console.log(`  ${C.green}✓ tickerId: ${tid}${C.reset}`);

  console.log('\n  Step 2: Fetching expirations + chains...');
  const all = await getOptionsExpirations(sym);
  if (all.error) { console.error(`  ${C.red}✗ ${all.error}${C.reset}\n`); process.exit(1); }
  console.log(`  ${C.green}✓ ${all.expirations.length} expirations:${C.reset}`);
  for (const e of all.expirations.slice(0, 6)) {
    console.log(`    ${e.date}  ${e.weekly ? 'weekly' : 'monthly'}  (${e.days} days)`);
  }

  console.log('\n  Step 3: Inspecting nearest expiration...');
  const nearest = all.expirations[0];
  if (!nearest) { console.error(`  ${C.red}✗ no expirations returned${C.reset}\n`); process.exit(1); }
  const chain = all.chains[nearest.date] ?? [];
  console.log(`  ${nearest.date}: ${chain.length} strikes`);

  // Find ATM (strike closest to 0.5 delta call)
  const calls = chain.filter(s => s.call?.delta != null);
  const atm = calls.reduce((best, s) => {
    const d = Math.abs((s.call?.delta ?? 0) - 0.5);
    return d < Math.abs((best?.call?.delta ?? 0) - 0.5) ? s : best;
  }, calls[0]);
  if (!atm) { console.error(`  ${C.red}✗ no calls with delta — chain may be empty${C.reset}\n`); process.exit(1); }

  const atmIdx = chain.findIndex(s => s.strikePrice === atm.strikePrice);
  const window = chain.slice(Math.max(0, atmIdx - 5), atmIdx + 6);

  console.log(`\n  ATM strike: $${atm.strikePrice} (call delta ${atm.call.delta?.toFixed(3)})`);
  console.log('\n  Strike    | Call (Δ/Γ/Θ/V/IV) bid/ask  vol/oi   | Put  (Δ/Γ/Θ/V/IV) bid/ask  vol/oi');
  console.log('  ─────────┼────────────────────────────────────────┼──────────────────────────────────');
  for (const s of window) {
    const c = s.call, p = s.put;
    const cs = c ? `${c.delta?.toFixed(2)}/${c.gamma?.toFixed(3)}/${c.theta?.toFixed(2)}/${c.vega?.toFixed(2)}/${(c.iv*100)?.toFixed(0)}%  ${c.bid}/${c.ask}  ${c.volume}/${c.oi}` : 'no data';
    const ps = p ? `${p.delta?.toFixed(2)}/${p.gamma?.toFixed(3)}/${p.theta?.toFixed(2)}/${p.vega?.toFixed(2)}/${(p.iv*100)?.toFixed(0)}%  ${p.bid}/${p.ask}  ${p.volume}/${p.oi}` : 'no data';
    const marker = s.strikePrice === atm.strikePrice ? '●' : ' ';
    console.log(`  ${marker} $${s.strikePrice.toString().padStart(6)} | ${cs.padEnd(38)} | ${ps}`);
  }

  console.log(`\n  ${C.green}✓ Options chain integration working${C.reset}\n`);
  process.exit(0);
}

// ─── Test mode ────────────────────────────────────────────

if(process.argv.includes('--test')) {
  console.log(C.bold + '\n  ⬡ HANK Webull Connection Test v2\n' + C.reset);

  if(!CONFIG.appKey || !CONFIG.appSecret) {
    console.error('  ❌ Missing WEBULL_APP_KEY or WEBULL_APP_SECRET in .env');
    process.exit(1);
  }

  console.log(`  App Key:  ${CONFIG.appKey.slice(0,8)}...`);
  console.log(`  App ID:   ${CONFIG.appId}`);
  console.log(`  Endpoint: ${HOST} (production)\n`);

  // Test signature generation
  console.log('  Step 1: Testing signature generation...');
  const { signature, timestamp, nonce } = generateSignature('/openapi/account/list', {});
  console.log(`  Timestamp: ${timestamp}`);
  console.log(`  Nonce:     ${nonce.slice(0,8)}...`);
  console.log(`  Signature: ${signature.slice(0,16)}...`);
  console.log(`  ${C.green}✓ Signature generated${C.reset}\n`);

  // Step 2: Test account list (2FA disabled — pure HMAC auth)
  console.log('  Step 2: Testing REST API (account list)...');
  const res = await getAccountList();
  console.log(`  Status: ${res.status}`);
  console.log(`  Response: ${JSON.stringify(res.data)?.slice(0,200)}`);

  if(res.status === 200) {
    console.log(`  ${C.green}✓ REST API working — Webull connection complete${C.reset}\n`);
  } else {
    console.log(`  ${C.yellow}⚠  Status ${res.status}: ${JSON.stringify(res.data)}${C.reset}\n`);
  }

  // Step 3: Options chain — needs consumer token, not OpenAPI HMAC.
  // OpenAPI scope excludes options market data by design; consumer endpoint
  // (quotes-gw.webullfintech.com) is the intended path. Not a permissions issue.
  if (loadConsumerToken()) {
    console.log(`  ${C.green}✓ Step 3: Consumer token loaded — options chain available via getOptionsExpirations${C.reset}`);
  } else {
    console.log(`  ${C.yellow}⚠  Step 3: No consumer token — run \`node webull.js --consumer-login\` to enable options chain reads${C.reset}`);
  }

  // Step 4: Trade token status
  if (loadTradeToken()) {
    console.log(`  ${C.green}✓ Step 4: Trade token loaded — live order placement ready${C.reset}`);
  } else {
    console.log(`  ${C.yellow}⚠  Step 4: No trade token — run \`node webull.js --trade-token-login\` before LIVE order placement${C.reset}`);
  }

  console.log('\n  Test complete.');
  process.exit(0);
}
