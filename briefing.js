#!/usr/bin/env node
/**
 * briefing.js — HANK AI Morning Briefing Engine v5
 * Built by NYC2000
 *
 * ZERO CDP — no TradingView connection, never hangs, never conflicts with monitor.js
 *
 * Data sources:
 *   spy/qqq/iwm-levels.json  — written by monitor.js every poll
 *   mag6-state.json          — written by monitor.js every poll
 *   overnight-news.json      — written by news.js
 *   Yahoo Finance API        — ES/NQ futures (free, no auth)
 *   NASDAQ API               — live earnings calendar
 *   Financial Juice RSS      — overnight news fallback
 *   Claude API               — AI briefing generation
 */

import { startHeartbeat } from './heartbeat.js';
startHeartbeat('briefing.js');
import Anthropic from '@anthropic-ai/sdk';
import https     from 'https';
import http      from 'http';
import { WebSocket } from 'ws';
import { exec }  from 'child_process';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { XMLParser } from 'fast-xml-parser';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const anthropic = new Anthropic();

let mailer = null;
async function getMailer() {
  if (!mailer) {
    try { mailer = (await import('./mailer.js')).default; }
    catch (e) { console.log(`  Mailer unavailable: ${e.message}`); }
  }
  return mailer;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', gray: '\x1b[90m', white: '\x1b[97m',
};

const WATCHLIST = ['SPY', 'NVDA', 'AAPL', 'MSFT', 'META', 'AMZN', 'GOOGL', 'IWM', 'QQQ', 'TSLA', 'IBM'];

function speak(text) {
  const clean = text.replace(/'/g, '').replace(/"/g, '').replace(/[^\w\s.,!?$%:-]/g, ' ').slice(0, 500);
  exec(`powershell -Command "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('Microsoft David Desktop'); $s.Rate = 1; $s.Speak('${clean}')"`, () => {});
}

function etNow() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function etDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function etMins() {
  const t = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function fmt(n, d = 2) { return n != null ? `$${n.toFixed(d)}` : 'N/A'; }
function fmtPct(n) { return n != null ? `${n > 0 ? '+' : ''}${n.toFixed(2)}%` : 'N/A'; }

function extractBias(text) {
  return text?.match(/MACRO BIAS[:\s]+([A-Z_]+)/i)?.[1]?.trim() || 'NEUTRAL';
}

function extractBiasLine(text) {
  const m = text?.match(/MACRO BIAS[:\s]+[A-Z_]+\s*[—\-–]\s*(.+?)(?:\n|$)/i);
  return m ? m[1].trim() : '';
}

// ─── HTTP Fetch ───────────────────────────────────────────────────────────────

function fetchUrl(url, asJson = false, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HankAI/5.0)', ...extraHeaders },
      timeout: 12000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchUrl(res.headers.location, asJson, extraHeaders).then(resolve).catch(reject);
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(asJson ? JSON.parse(data) : data); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── File Reads ───────────────────────────────────────────────────────────────

// Sanity check shared by all ETF level readers.
// pdHigh vs current diverging > 20% means the file is from a completely different price era
// (e.g. stale file from months ago, or wrong instrument). Flag as corrupt so briefing
// excludes the bad levels rather than printing them.
function _checkLevelSanity(symbol, d) {
  if (d.pdHigh == null || d.current == null || d.current <= 0) return null;
  const divergence = Math.abs(d.pdHigh - d.current) / d.current;
  if (divergence > 0.20) {
    const msg = `PDH $${d.pdHigh?.toFixed(2)} vs current $${d.current?.toFixed(2)} — ${(divergence * 100).toFixed(0)}% divergence`;
    console.log(`  ${C.red}⚠  ${symbol} CORRUPT LEVELS — ${msg} — excluding from briefing${C.reset}`);
    return msg;
  }
  return null;
}

// ─── Live data layer — wsServer override ──────────────────────────────────────
// Briefing should reflect TV chart state THIS MORNING, not yesterday's snapshot.
// Strategy:
//   1. At runBriefing() start, fetch one live tick from monitor.js via wsServer
//      (broadcasts SPY/QQQ/IWM price+vwap+bias every 30s poll).
//   2. Level readers below overlay the live current/vwap/bias on top of the
//      file's pdHigh/pdLow/pdClose/todayOpen (which are legitimately snapshot —
//      they don't change intraday, only at 07:00 ET pre-market open).
//   3. If wsServer is unreachable: fall back to pure file, with a smarter STALE
//      check that asks "did monitor.js write AFTER today's 07:00 ET pre-market
//      open?" instead of the calendar-date check.

let _liveTick = null;          // populated by ensureLiveSnapshot()
let _liveFetchAttempted = false;

function fetchLiveTick(timeoutMs = 5000, port = 8080) {
  return new Promise((resolve) => {
    let ws, timer, resolved = false;
    const cleanup = (val) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { ws?.close(); } catch {}
      resolve(val);
    };
    try { ws = new WebSocket(`ws://localhost:${port}`); }
    catch { return cleanup(null); }
    timer = setTimeout(() => cleanup(null), timeoutMs);
    ws.on('error', () => cleanup(null));
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'tick' && msg.payload && (msg.payload.SPY || msg.payload.QQQ || msg.payload.IWM)) {
          cleanup(msg.payload);
        }
      } catch { /* non-JSON / binary frame — ignore */ }
    });
  });
}

async function ensureLiveSnapshot() {
  if (_liveFetchAttempted) return;
  _liveFetchAttempted = true;
  console.log(`  Fetching live SPY/QQQ/IWM from wsServer (timeout 5s)...`);
  const tick = await fetchLiveTick(5000);
  if (tick) {
    _liveTick = tick;
    const parts = [];
    if (tick.SPY?.price) parts.push(`SPY ${tick.SPY.price.toFixed(2)}`);
    if (tick.QQQ?.price) parts.push(`QQQ ${tick.QQQ.price.toFixed(2)}`);
    if (tick.IWM?.price) parts.push(`IWM ${tick.IWM.price.toFixed(2)}`);
    console.log(`  ${C.green}✓  Live tick via wsServer: ${parts.join(' | ')}${C.reset}`);
  } else {
    console.log(`  ${C.yellow}⚠  wsServer unreachable or no tick in 5s — falling back to snapshot files${C.reset}`);
  }
}

// Today's 07:00 ET (pre-market open) as epoch ms.
// Files written before this point are STALE for today's briefing — they're
// reflecting yesterday's market state, not today's pre-market.
function todayPreMarketOpenET() {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  // ET DST handling — May is EDT (UTC-4). Standard time would be UTC-5.
  // Determine ET offset by comparing UTC-rendered hour to ET-rendered hour right now.
  const now = new Date();
  const utcH = now.getUTCHours();
  const etH = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit' }).format(now), 10);
  const offsetH = ((utcH - etH) + 24) % 24;  // 4 in EDT, 5 in EST
  const offsetStr = `-${String(offsetH).padStart(2, '0')}:00`;
  return new Date(`${ymd}T07:00:00${offsetStr}`).getTime();
}

function readSPYLevels() {
  try {
    const p = join(__dirname, 'spy-levels.json');
    if (!existsSync(p)) {
      // No file — try pure live snapshot
      if (_liveTick?.SPY?.price) {
        console.log(`  ${C.green}✓  SPY via live tick (no snapshot file): ${_liveTick.SPY.price.toFixed(2)}${C.reset}`);
        return { current: _liveTick.SPY.price, vwap: _liveTick.SPY.vwap, bias: _liveTick.SPY.bias, ts: Date.now(), source: 'live-ws-only' };
      }
      console.log(`  ${C.yellow}⚠  spy-levels.json not found AND wsServer unreachable — monitor.js must run before briefing${C.reset}`);
      return null;
    }
    const d = JSON.parse(readFileSync(p, 'utf8'));
    const fileAgeMin = (Date.now() - d.ts) / 60000;
    const preMarketOpen = todayPreMarketOpenET();

    // Layer live tick over snapshot fields when available — gives live current/vwap/bias
    // while keeping pdHigh/pdLow/pdClose/todayOpen from the file (legitimately snapshot).
    let merged = d;
    let source = 'file';
    if (_liveTick?.SPY?.price) {
      merged = {
        ...d,
        current: _liveTick.SPY.price,
        vwap: _liveTick.SPY.vwap ?? d.vwap,
        bias: _liveTick.SPY.bias ?? d.bias,
        ts: Date.now(),
        time: etNow(),
        source: 'live-ws+file-snapshot',
      };
      source = 'live-ws';
      const corruptReason = _checkLevelSanity('SPY', merged);
      if (corruptReason) return { ...merged, corrupt: true, corruptReason };
      console.log(`  ${C.green}✓  SPY (live ws override): PDH=${merged.pdHigh?.toFixed(2)} PDL=${merged.pdLow?.toFixed(2)} Current=${merged.current.toFixed(2)} (file pdHigh/pdLow, live current/vwap)${C.reset}`);
      return merged;
    }

    // Pure-file path (live unreachable) — use smart STALE check.
    if (d.ts < preMarketOpen) {
      console.log(`  ${C.red}⚠  spy-levels.json last write was BEFORE today's 07:00 ET pre-market open — STALE (live data not refreshed today)${C.reset}`);
      const corruptReason = _checkLevelSanity('SPY', d);
      return { ...d, stale: true, staleReason: 'pre-market-write', ...(corruptReason ? { corrupt: true, corruptReason } : {}) };
    }
    const corruptReason = _checkLevelSanity('SPY', d);
    if (corruptReason) return { ...d, corrupt: true, corruptReason };
    if (fileAgeMin > 90) console.log(`  ${C.yellow}⚠  spy-levels.json is ${fileAgeMin.toFixed(0)} min old (wsServer fallback)${C.reset}`);
    else console.log(`  ${C.green}✓  SPY (file fallback): PDH=${d.pdHigh?.toFixed(2)} PDL=${d.pdLow?.toFixed(2)} Current=${d.current?.toFixed(2)}${C.reset}`);
    return d;
  } catch (e) { console.log(`  spy-levels.json error: ${e.message}`); return null; }
}

function readMag6State() {
  try {
    const p = join(__dirname, 'mag6-state.json');
    if (!existsSync(p)) { console.log('  mag6-state.json not found'); return null; }
    const d = JSON.parse(readFileSync(p, 'utf8'));
    const ageMin = (Date.now() - d.ts) / 60000;
    if (ageMin > 120) console.log(`  mag6-state.json is ${ageMin.toFixed(0)} min old`);
    else console.log(`  Mag-6: ${d.bulls} bull / ${d.bears} bear (${d.time} ET)`);
    return d;
  } catch (e) { console.log(`  mag6-state.json error: ${e.message}`); return null; }
}

function readETFLevels(symbol) {
  try {
    const p = join(__dirname, `${symbol.toLowerCase()}-levels.json`);
    const liveSym = _liveTick?.[symbol];

    if (!existsSync(p)) {
      if (liveSym?.price) {
        console.log(`  ${C.green}✓  ${symbol} via live tick (no snapshot file): ${liveSym.price.toFixed(2)}${C.reset}`);
        return { current: liveSym.price, vwap: liveSym.vwap, bias: liveSym.bias, ts: Date.now(), source: 'live-ws-only' };
      }
      console.log(`  ${C.yellow}⚠  ${symbol}-levels.json not found AND wsServer unreachable — monitor.js must run before briefing${C.reset}`);
      return null;
    }
    const d = JSON.parse(readFileSync(p, 'utf8'));
    const fileAgeMin = (Date.now() - d.ts) / 60000;
    const preMarketOpen = todayPreMarketOpenET();

    if (liveSym?.price) {
      const merged = {
        ...d,
        current: liveSym.price,
        vwap: liveSym.vwap ?? d.vwap,
        bias: liveSym.bias ?? d.bias,
        ts: Date.now(),
        time: etNow(),
        source: 'live-ws+file-snapshot',
      };
      const corruptReason = _checkLevelSanity(symbol, merged);
      if (corruptReason) return { ...merged, corrupt: true, corruptReason };
      console.log(`  ${C.green}✓  ${symbol} (live ws override): PDH=${merged.pdHigh?.toFixed(2)} PDL=${merged.pdLow?.toFixed(2)} Current=${merged.current.toFixed(2)} (file pdHigh/pdLow, live current/vwap)${C.reset}`);
      return merged;
    }

    if (d.ts < preMarketOpen) {
      console.log(`  ${C.red}⚠  ${symbol}-levels.json last write was BEFORE today's 07:00 ET pre-market open — STALE (live data not refreshed today)${C.reset}`);
      const corruptReason = _checkLevelSanity(symbol, d);
      return { ...d, stale: true, staleReason: 'pre-market-write', ...(corruptReason ? { corrupt: true, corruptReason } : {}) };
    }
    const corruptReason = _checkLevelSanity(symbol, d);
    if (corruptReason) return { ...d, corrupt: true, corruptReason };
    if (fileAgeMin > 90) console.log(`  ${C.yellow}⚠  ${symbol}-levels.json is ${fileAgeMin.toFixed(0)} min old (wsServer fallback)${C.reset}`);
    else console.log(`  ${C.green}✓  ${symbol} (file fallback): PDH=${d.pdHigh?.toFixed(2)} PDL=${d.pdLow?.toFixed(2)} Current=${d.current?.toFixed(2) ?? 'N/A'}${C.reset}`);
    return d;
  } catch (e) { console.log(`  ${symbol}-levels.json error: ${e.message}`); return null; }
}

// ─── Futures via Yahoo Finance ────────────────────────────────────────────────

async function fetchFuturesYahoo() {
  const tickers = { ES: 'ES=F', NQ: 'NQ=F' };
  const results  = {};
  for (const [key, ticker] of Object.entries(tickers)) {
    try {
      const json = await fetchUrl(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=5m&range=1d`, true);
      const meta = json?.chart?.result?.[0]?.meta;
      const q    = json?.chart?.result?.[0]?.indicators?.quote?.[0];
      if (!meta || !q) { results[key] = null; continue; }

      const current   = meta.regularMarketPrice ?? meta.previousClose;
      const prevClose = meta.chartPreviousClose  ?? meta.previousClose;
      const gapPct    = prevClose ? ((current - prevClose) / prevClose * 100) : null;
      const gapDir    = gapPct != null ? (gapPct > 0.05 ? 'Gap Up' : gapPct < -0.05 ? 'Gap Down' : 'Flat') : 'Unknown';

      const highs = (q.high ?? []).filter(v => v != null);
      const lows  = (q.low  ?? []).filter(v => v != null);
      const n     = highs.length;

      const overnightHigh  = n ? Math.max(...highs) : null;
      const overnightLow   = n ? Math.min(...lows)  : null;
      const overnightRange = (overnightHigh != null && overnightLow != null) ? overnightHigh - overnightLow : null;

      const asianHigh = n > 4 ? Math.max(...highs.slice(0, Math.floor(n * 0.4))) : null;
      const asianLow  = n > 4 ? Math.min(...lows.slice(0, Math.floor(n * 0.4)))  : null;
      const euHigh    = n > 4 ? Math.max(...highs.slice(Math.floor(n * 0.4), Math.floor(n * 0.8))) : null;
      const euLow     = n > 4 ? Math.min(...lows.slice(Math.floor(n * 0.4), Math.floor(n * 0.8)))  : null;

      results[key] = { symbol: ticker, current, prevClose, gapPct, gapDir,
        overnightHigh, overnightLow, overnightRange,
        asianHigh, asianLow, euHigh, euLow };

      console.log(`  ${key}: ${current?.toFixed(2)} gap=${gapPct?.toFixed(2)}% Asian=${asianHigh?.toFixed(0)}/${asianLow?.toFixed(0)} EU=${euHigh?.toFixed(0)}/${euLow?.toFixed(0)}`);
    } catch (e) {
      console.log(`  ${key}: Yahoo error — ${e.message}`);
      results[key] = null;
    }
  }
  return results;
}

// ─── P/C Ratio ────────────────────────────────────────────────────────────────

async function fetchPCRatio() {
  try {
    const html  = await fetchUrl('https://www.cboe.com/us/options/market_statistics/daily/');
    const match = html.match(/Total P\/C Ratio[^>]*>([0-9.]+)/i);
    if (match) return parseFloat(match[1]);
  } catch {}
  return null;
}

// ─── Earnings Calendar (live from NASDAQ) ─────────────────────────────────────

function parseMarketCap(s) {
  if (!s) return 0;
  const m = s.replace(/[$,\s]/g, '').match(/^([\d.]+)([TBM])?/i);
  if (!m) return 0;
  const mult = { T: 1e12, B: 1e9, M: 1e6 }[m[2]?.toUpperCase()] ?? 1;
  return parseFloat(m[1]) * mult;
}

function normalizeEarningsTime(t) {
  if (!t) return 'TBD';
  if (/pre.?market|before.?market|bmo/i.test(t)) return 'BMO';
  if (/after.?hours|after.?market|amc/i.test(t)) return 'AMC';
  return 'TBD';
}

function getWeekDates(offsetWeeks = 0) {
  const now    = new Date();
  const day    = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1) + offsetWeeks * 7);
  monday.setHours(12, 0, 0, 0);
  return Array.from({ length: 5 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
  });
}

async function fetchEarningsCalendar() {
  const dates   = [...getWeekDates(0), ...getWeekDates(1)];
  const headers = { 'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9' };

  const results = await Promise.allSettled(dates.map(async date => {
    const raw  = await fetchUrl(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, true, headers);
    return (raw?.data?.rows ?? [])
      .filter(r => {
        if (!r?.symbol) return false;
        if (WATCHLIST.includes(r.symbol.trim().toUpperCase())) return true;
        return parseMarketCap(r.marketCap) >= 50e9;
      })
      .map(r => ({
        date,
        sym:    r.symbol.trim().toUpperCase(),
        name:   r.name ?? '',
        time:   normalizeEarningsTime(r.time),
        mktCap: r.marketCap ?? '',
        eps:    r.epsForecast ?? '',
        impact: WATCHLIST.includes(r.symbol.trim().toUpperCase()) ? 'HIGH' : 'MEDIUM',
      }));
  }));

  const all  = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  const seen = new Set();
  return all.filter(e => {
    const key = `${e.sym}|${e.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Overnight News ───────────────────────────────────────────────────────────

const KEY_TERMS = ['fed', 'fomc', 'iran', 'trump', 'tariff', 'crude', 'cpi', 'gdp',
                   'nvda', 'aapl', 'msft', 'meta', 'amzn', 'earnings', 'recession', 'china', 'openai'];

async function fetchOvernightNews() {
  const headlines = [];
  const cutoff    = Date.now() - 18 * 60 * 60 * 1000;

  try {
    const p = join(__dirname, 'overnight-news.json');
    if (existsSync(p)) {
      const stored = JSON.parse(readFileSync(p, 'utf8'));
      const seen   = new Set();
      for (const e of stored) {
        if (e.ts < cutoff || seen.has(e.title)) continue;
        seen.add(e.title);
        const t = e.tickers?.length ? ` [${e.tickers.join(', ')}]` : '';
        headlines.push(`${e.time} ET — ${e.title}${t}`);
      }
      console.log(`  Overnight news from news.js: ${headlines.length} headlines`);
    }
  } catch (e) { console.log(`  overnight-news.json error: ${e.message}`); }

  try {
    const xml     = await fetchUrl('https://www.financialjuice.com/feed.ashx?xy=rss');
    const obj     = parser.parse(xml);
    const channel = obj?.rss?.channel || {};
    const items   = Array.isArray(channel.item) ? channel.item : [channel.item].filter(Boolean);
    for (const item of items) {
      const title   = item.title?.['#text'] || item.title || '';
      if (!title) continue;
      const pubDate = new Date(item.pubDate || 0).getTime();
      if (pubDate < cutoff) continue;
      const clean = title.replace(/^FinancialJuice:\s*/i, '').trim();
      if (headlines.some(h => h.includes(clean.slice(0, 40)))) continue;
      if (KEY_TERMS.some(t => clean.toLowerCase().includes(t))) headlines.push(clean);
    }
  } catch (e) { console.log(`  Financial Juice fallback error: ${e.message}`); }

  const timed   = headlines.filter(h => /^\d{2}:\d{2} ET/.test(h)).sort().reverse();
  const untimed = headlines.filter(h => !/^\d{2}:\d{2} ET/.test(h));
  return [...timed, ...untimed].slice(0, 12);
}

// ─── Claude API Briefing ──────────────────────────────────────────────────────

async function generateBriefing(data) {
  const { futures, spy, qqq, iwm, pcRatio, overnightNews, mag6, todayDate, todayCalendar, todayEarnings } = data;
  const es = futures?.ES;
  const nq = futures?.NQ;

  const fmtETF = (name, d) => {
    if (!d) return `${name}: Data unavailable`;
    if (d.corrupt) return `${name}: CORRUPT LEVELS — do NOT reference ${name} PDH/PDL/PDC in this briefing. Reason: ${d.corruptReason ?? 'price divergence > 20%'}. Omit ${name} key levels entirely or note data unavailable.`;
    return `${name} Pre-Market Data${d.stale ? ' ⚠ STALE' : ''}:
  Pre-Market: $${d.current?.toFixed(2) ?? 'N/A'} | PDH: $${d.pdHigh?.toFixed(2)} | PDL: $${d.pdLow?.toFixed(2)} | PDC: $${d.pdClose?.toFixed(2)}
  Gap vs PDC: ${d.current && d.pdClose ? ((d.current - d.pdClose) / d.pdClose * 100).toFixed(2) + '%' : 'N/A'}
  VWAP: $${d.vwap?.toFixed(2) ?? 'N/A'} | Bias: ${d.bias ?? 'N/A'} | Volume: ${d.volumePct != null ? (d.volumePct * 100).toFixed(0) + '% of avg' : 'N/A'}`;
  };

  const esSection = es ? `
ES (S&P Futures):
  Current: ${es.current?.toFixed(2)} | Gap: ${es.gapPct?.toFixed(2)}% (${es.gapDir})
  O/N High: ${es.overnightHigh?.toFixed(2)} | O/N Low: ${es.overnightLow?.toFixed(2)} | Range: ${es.overnightRange?.toFixed(0)} pts
  Asian: ${es.asianHigh?.toFixed(0)} / ${es.asianLow?.toFixed(0)}  EU: ${es.euHigh?.toFixed(0)} / ${es.euLow?.toFixed(0)}` : 'ES: Data unavailable';

  const nqSection = nq ? `
NQ (Nasdaq Futures):
  Current: ${nq.current?.toFixed(2)} | Gap: ${nq.gapPct?.toFixed(2)}% (${nq.gapDir})
  O/N High: ${nq.overnightHigh?.toFixed(0)} | O/N Low: ${nq.overnightLow?.toFixed(0)} | Asian: ${nq.asianHigh?.toFixed(0)} / ${nq.asianLow?.toFixed(0)}` : 'NQ: Data unavailable';

  const mag6Section = mag6?.stocks?.length ? `
MAG-6 PRE-MARKET BIAS (snapshot at ${mag6.time} ET):
${mag6.stocks.map(s => {
    const d = s.delta != null ? (s.delta > 0 ? '+' : '') + (s.delta / 1000).toFixed(1) + 'K' : 'N/A';
    return `  ${s.sym}: $${s.price?.toFixed(2)} VWAP:$${s.vwap?.toFixed(2) || 'N/A'} Δ${d} ${s.bias}`;
  }).join('\n')}
MAG-6 VOTE: BULL ${mag6.bulls}/6  BEAR ${mag6.bears}/6` : 'MAG-6: No snapshot';

  const eventsStr = todayCalendar.length
    ? todayCalendar.map(e => `- ${e.time} ET: ${e.event} [${e.impact}]`).join('\n')
    : 'No major economic events today';

  const earningsStr = todayEarnings.length
    ? todayEarnings.map(e => `- ${e.sym} (${e.time}) ${e.name} ${e.mktCap ? `[${e.mktCap}]` : ''}`).join('\n')
    : 'No major earnings today';

  const prompt = `You are HANK AI, a professional trading terminal built by NYC2000. Generate a morning briefing for an options day trader using ONLY the real data provided. Do NOT invent prices or levels.

Date: ${todayDate} | Time: ${etNow()} ET
${esSection}
${nqSection}
${fmtETF('SPY', spy)}
${fmtETF('QQQ', qqq)}
${fmtETF('IWM', iwm)}
${mag6Section}
P/C Ratio: ${pcRatio ? pcRatio + (pcRatio < 0.70 ? ' (bullish)' : pcRatio > 1.0 ? ' (fearful)' : ' — neutral') : 'Unavailable'}

TODAY'S ECONOMIC EVENTS:
${eventsStr}

TODAY'S EARNINGS:
${earningsStr}

OVERNIGHT & MORNING NEWS:
${overnightNews.length ? overnightNews.map((h, i) => `${i + 1}. ${h}`).join('\n') : 'No headlines captured.'}

Write in exactly this format. Use ONLY real numbers above:

1. MACRO BIAS: [BULLISH/BEARISH/NEUTRAL] — [one sentence why, max 20 words]
2. OVERNIGHT SUMMARY: [2-3 sentences using real high/low/range data from ES/NQ]
3. KEY LEVELS TO WATCH: List specific real price levels for SPY, QQQ, and IWM — support and resistance
4. TODAY'S CATALYSTS: Events, earnings, and relevant news headlines that could move markets today
5. RISK FACTORS: Specific risks from overnight action, news, and today's calendar
6. DAILY PREDICTION: [CALLS BIAS / PUTS BIAS / NEUTRAL] — Key levels: [list 3-4 specific prices] — Entry trigger: [one specific setup description] — Risk: [one main risk]

If a number is unavailable, say "data unavailable" — never invent a price.`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content[0]?.text || null;
  } catch (e) {
    return `[Briefing generation failed: ${e.message}]`;
  }
}

// ─── Economic Calendar ────────────────────────────────────────────────────────

const CALENDAR = [
  { date: '2026-05-08', time: '08:30', event: 'Nonfarm Payrolls',     impact: 'HIGH' },
  { date: '2026-05-08', time: '08:30', event: 'Unemployment Rate',    impact: 'HIGH' },
  { date: '2026-05-12', time: 'TBD',   event: 'CBRS IPO — Cerebras', impact: 'HIGH' },
];

// ─── Print Briefing ───────────────────────────────────────────────────────────

function printBriefing(briefingText, data) {
  const { futures, spy, qqq, iwm, pcRatio, mag6, todayCalendar, todayEarnings } = data;
  const es   = futures?.ES;
  const nq   = futures?.NQ;
  const line = '─'.repeat(72);

  console.log(`\n${C.bold}${C.cyan}╔${'═'.repeat(72)}╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║${C.reset}${C.bold}  ⬡ HANK AI MORNING BRIEFING  │  ${etNow()} ET  │  ${etDate()}${' '.repeat(Math.max(0, 14 - etDate().length))}${C.cyan}║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚${'═'.repeat(72)}╝${C.reset}`);

  console.log(`\n  ${C.bold}OVERNIGHT FUTURES${C.reset}  ${C.dim}(Yahoo Finance ES=F / NQ=F)${C.reset}`);
  console.log(`  ${line}`);
  if (es) {
    const gc = es.gapPct > 0 ? C.green : es.gapPct < 0 ? C.red : C.gray;
    console.log(`  ES   Current: ${C.bold}${es.current?.toFixed(2)}${C.reset}  Gap: ${gc}${fmtPct(es.gapPct)} ${es.gapDir}${C.reset}`);
    console.log(`       O/N High: ${C.red}${es.overnightHigh?.toFixed(2)}${C.reset}  O/N Low: ${C.green}${es.overnightLow?.toFixed(2)}${C.reset}  Range: ${es.overnightRange?.toFixed(0)} pts`);
    console.log(`       Asian: ${es.asianHigh?.toFixed(0)} / ${es.asianLow?.toFixed(0)}  EU: ${es.euHigh?.toFixed(0)} / ${es.euLow?.toFixed(0)}`);
  } else {
    console.log(`  ES   ${C.gray}Unavailable${C.reset}`);
  }
  if (nq) {
    const gc = nq.gapPct > 0 ? C.green : nq.gapPct < 0 ? C.red : C.gray;
    console.log(`  NQ   Current: ${C.bold}${nq.current?.toFixed(2)}${C.reset}  Gap: ${gc}${fmtPct(nq.gapPct)} ${nq.gapDir}${C.reset}`);
    console.log(`       O/N High: ${C.red}${nq.overnightHigh?.toFixed(2)}${C.reset}  O/N Low: ${C.green}${nq.overnightLow?.toFixed(2)}${C.reset}`);
    console.log(`       Asian: ${nq.asianHigh?.toFixed(0)} / ${nq.asianLow?.toFixed(0)}  EU: ${nq.euHigh?.toFixed(0)} / ${nq.euLow?.toFixed(0)}`);
  } else {
    console.log(`  NQ   ${C.gray}Unavailable${C.reset}`);
  }

  console.log(`\n  ${C.bold}PRE-MARKET LEVELS${C.reset}  ${C.dim}(spy/qqq/iwm-levels.json · current = live pre-mkt price)${C.reset}`);
  console.log(`  ${line}`);
  for (const [name, d] of [['SPY', spy], ['QQQ', qqq], ['IWM', iwm]]) {
    if (d?.corrupt) {
      const staleTag = d.stale ? `${C.yellow}STALE + ` : '';
      console.log(`  ${C.bold}${name}${C.reset}  ${C.red}⚠ ${staleTag}CORRUPT LEVELS EXCLUDED${C.reset}  ${C.dim}${d.corruptReason}${C.reset}`);
    } else if (d) {
      const gap = d.current && d.pdClose ? ((d.current - d.pdClose) / d.pdClose * 100) : null;
      const gc  = gap != null ? (gap > 0 ? C.green : C.red) : C.gray;
      const staleFlag = d.stale ? C.red + '⚠ STALE ' + C.reset : '';
      console.log(`  ${C.bold}${name}${C.reset}  ${staleFlag}Pre-Mkt:${C.bold}${fmt(d.current)}${C.reset} ${gc}${gap != null ? (gap > 0 ? '+' : '') + gap.toFixed(2) + '%' : ''}${C.reset}  PDH:${C.red}${fmt(d.pdHigh)}${C.reset}  PDL:${C.green}${fmt(d.pdLow)}${C.reset}  PDC:${fmt(d.pdClose)}  ${d.bias ? d.bias.toUpperCase() : ''}`);
    } else {
      console.log(`  ${C.bold}${name}${C.reset}  ${C.gray}unavailable — monitor must run first${C.reset}`);
    }
  }

  if (mag6?.stocks?.length) {
    console.log(`\n  ${C.bold}MAG-6 PRE-MARKET BIAS${C.reset}  ${C.dim}(${mag6.time} ET snapshot)${C.reset}`);
    for (const s of mag6.stocks) {
      const bc  = s.bias === 'bullish' ? C.green : s.bias === 'bearish' ? C.red : s.bias === 'div_bear' ? C.yellow : C.cyan;
      const dStr = s.delta != null ? (s.delta > 0 ? C.green : C.red) + (s.delta > 0 ? '+' : '') + (s.delta / 1000).toFixed(1) + 'K' + C.reset : 'N/A';
      console.log(`  ${C.bold}${s.sym.padEnd(6)}${C.reset}  $${s.price?.toFixed(2) || 'N/A'}  VWAP:$${s.vwap?.toFixed(2) || 'N/A'}  Δ${dStr}  ${bc}${s.bias}${C.reset}`);
    }
    console.log(`  Vote: BULL ${mag6.bulls}/6  BEAR ${mag6.bears}/6`);
  }

  console.log(`\n  ${C.bold}TODAY'S CATALYSTS${C.reset}`);
  console.log(`  ${line}`);
  if (todayCalendar.length) {
    for (const e of todayCalendar)
      console.log(`  ${e.impact === 'HIGH' ? C.red : C.yellow}${e.impact === 'HIGH' ? '⚠' : '●'} ${e.time} — ${e.event}${C.reset}`);
  } else {
    console.log(`  ${C.gray}No major economic events today${C.reset}`);
  }
  if (todayEarnings.length) {
    console.log(`  ${C.cyan}Earnings today:${C.reset}`);
    for (const e of todayEarnings)
      console.log(`  ${C.cyan}  ${e.sym} (${e.time}) — ${e.name}${e.mktCap ? ' ' + e.mktCap : ''}${C.reset}`);
  }

  console.log(`\n  ${C.bold}MARKET CONTEXT${C.reset}`);
  console.log(`  ${line}`);
  console.log(`  P/C Ratio: ${pcRatio ? (pcRatio < 0.70 ? C.green : pcRatio > 1.0 ? C.red : C.gray) + pcRatio + C.reset + (pcRatio < 0.70 ? ' — bullish' : pcRatio > 1.0 ? ' — fearful' : ' — neutral') : C.gray + 'Unavailable' + C.reset}`);

  if (briefingText) {
    console.log(`\n  ${C.bold}${C.cyan}⬡ HANK BRIEFING${C.reset}`);
    console.log(`  ${line}`);
    for (const l of briefingText.split('\n')) {
      if (!l.trim()) continue;
      const isHeader = /^\d\./.test(l.trim());
      console.log(`  ${isHeader ? C.cyan + C.bold : C.dim}${l}${C.reset}`);
    }
  }

  console.log(`\n  ${line}`);
  console.log(`  ${C.gray}Next briefing: tomorrow 08:30 ET${C.reset}\n`);
}

// ─── Save + TTS ───────────────────────────────────────────────────────────────

function saveBriefing(data, briefingText) {
  try {
    writeFileSync(join(__dirname, 'briefing.json'), JSON.stringify({
      date: etDate(), time: etNow(),
      futures: data.futures, spy: data.spy, qqq: data.qqq, iwm: data.iwm,
      pcRatio: data.pcRatio, overnightNews: data.overnightNews,
      mag6: data.mag6, briefingText,
      macrobias: extractBias(briefingText),
      macrobiasLine: extractBiasLine(briefingText),
    }, null, 2));
  } catch {}
}

function deliverTTS(briefingText, data) {
  if (!briefingText) return;
  const bias = briefingText.match(/MACRO BIAS[:\s]+(.+?)(?:\n|$)/i)?.[1] || '';
  const summ = briefingText.match(/OVERNIGHT SUMMARY[:\s]+(.+?)(?:\n\d|$)/is)?.[1]?.slice(0, 200) || '';
  const es   = data.futures?.ES;
  const esLine = es ? `E.S. at ${es.current?.toFixed(0)}, gap ${es.gapPct?.toFixed(1)} percent.` : '';
  speak(`Good morning. HANK AI morning briefing for ${etDate()}. ${esLine} Macro bias is ${bias}. ${summ}`);
}

// ─── Main Briefing Run ────────────────────────────────────────────────────────

let briefingDelivered = false;
let lastBriefingDate  = '';

async function runBriefing({ skipEmail = false } = {}) {
  console.log(`\n  ${C.cyan}${C.bold}⬡ Building morning briefing...${C.reset}`);
  console.log(`  ${C.dim}Live data via wsServer (port 8080) + file fallback + Yahoo Finance${skipEmail ? ' · TEST MODE — no email' : ''}${C.reset}\n`);

  // Parallel fetches (including live tick from monitor.js via wsServer)
  const [futures, pcRatio, overnightNews, allEarnings] = await Promise.all([
    fetchFuturesYahoo(),
    fetchPCRatio(),
    fetchOvernightNews(),
    fetchEarningsCalendar().catch(() => []),
    ensureLiveSnapshot(),
  ]);

  const todayStr    = etDate();
  const todayCalendar = CALENDAR.filter(e => e.date === todayStr);
  const todayEarnings = allEarnings.filter(e => e.date === todayStr);

  // File reads
  const spy  = readSPYLevels();
  const qqq  = readETFLevels('QQQ');
  const iwm  = readETFLevels('IWM');
  const mag6 = readMag6State();

  const data = { futures, spy, qqq, iwm, pcRatio, overnightNews, mag6,
                 todayDate: todayStr, todayCalendar, todayEarnings };

  console.log(`\n  Generating AI briefing...`);
  const briefingText = await generateBriefing(data);

  printBriefing(briefingText, data);
  saveBriefing(data, briefingText);
  deliverTTS(briefingText, data);

  if (skipEmail) {
    console.log(`  ${C.yellow}TEST MODE — email skipped${C.reset}`);
  } else {
    try {
      const m = await getMailer();
      if (m) {
        // DEV MODE — locked to tom.avery only until briefing approved for all subscribers
        const devRecipient = 'tom.avery@avery-tech.com';
        await m.sendBriefing({
          briefingText,
          futures:          data.futures,
          spy:              data.spy,
          qqq:              data.qqq,
          iwm:              data.iwm,
          calendar:         CALENDAR,
          todayCalendar,
          todayEarnings,
          overnightNews:    data.overnightNews,
          macrobias:        extractBias(briefingText),
          macrobiasLine:    extractBiasLine(briefingText),
          date:             todayStr,
          overrideRecipients: [devRecipient],
        });
        console.log(`  📧 Briefing emailed to ${devRecipient} (dev mode).`);
      }
    } catch (e) { console.log(`  Email error: ${e.message}`); }
  }

  briefingDelivered = true;
  lastBriefingDate  = todayStr;
  console.log(`  ${C.green}✓ Morning briefing complete.${C.reset}\n`);
}

// ─── Overnight Status ─────────────────────────────────────────────────────────

async function logOvernightStatus() {
  try {
    const json = await fetchUrl('https://query1.finance.yahoo.com/v8/finance/chart/ES=F?interval=5m&range=1d', true);
    const meta = json?.chart?.result?.[0]?.meta;
    if (meta) console.log(`  ${C.gray}${etNow()}${C.reset}  ES=F: ${C.bold}${meta.regularMarketPrice?.toFixed(2)}${C.reset}`);
  } catch {}
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold + '\n  ⬡ HANK AI Briefing Engine v5 — Starting up...' + C.reset);
  console.log(`  ZERO CDP — no TradingView connection — never hangs`);
  console.log(`  Data: spy/qqq/iwm-levels.json + mag6-state.json + Yahoo Finance + NASDAQ earnings`);
  console.log(`  Briefing: 08:30 ET daily  |  Futures monitor: every 30min 07:00–08:30\n`);

  const isTest  = process.argv.includes('--test');
  const isNow   = process.argv.includes('--now');
  const isProbe = process.argv.includes('--probe');

  if (isProbe) {
    console.log(`  ${C.yellow}PROBE MODE — data fetch only, no AI/email/TTS${C.reset}\n`);
    await ensureLiveSnapshot();
    const spy = readSPYLevels();
    const qqq = readETFLevels('QQQ');
    const iwm = readETFLevels('IWM');
    console.log(`\n  ${C.cyan}Probe result:${C.reset}`);
    console.log(`  SPY: ${JSON.stringify(spy, null, 0)?.slice(0, 200)}`);
    console.log(`  QQQ: ${JSON.stringify(qqq, null, 0)?.slice(0, 200)}`);
    console.log(`  IWM: ${JSON.stringify(iwm, null, 0)?.slice(0, 200)}`);
    return;
  }

  if (isTest) {
    console.log(`  ${C.yellow}TEST MODE — full briefing run, no email sent${C.reset}\n`);
    await runBriefing({ skipEmail: true });
    return;
  }

  if (isNow) {
    console.log(`  ${C.yellow}Manual briefing requested — email WILL send${C.reset}\n`);
    await runBriefing({ skipEmail: false });
    return;
  }

  setInterval(async () => {
    const mins  = etMins();
    const today = etDate();
    if (lastBriefingDate !== today) briefingDelivered = false;
    if (mins === 8 * 60 + 30 && !briefingDelivered) await runBriefing();
    if (mins >= 7 * 60 && mins < 8 * 60 + 30 && mins % 30 === 0) await logOvernightStatus();
  }, 30_000);

  process.on('SIGINT', () => {
    console.log(`\n\n  ${C.gray}Briefing engine stopped.${C.reset}\n`);
    process.exit(0);
  });
}

main().catch(err => {
  console.error(`\n  ${C.red}Fatal: ${err.message}${C.reset}\n`);
  process.exit(1);
});
