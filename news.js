#!/usr/bin/env node
/**
 * news.js v3 — Hank News Terminal
 *
 * Sources: Financial Juice, Reuters, AP, CNBC, SEC EDGAR
 * v3 additions: Tier scoring, Claude auto-analysis (T1/T2), source credibility,
 *               contradiction detector, fade-bias tracker, overnight writer,
 *               live economic + earnings calendar
 *
 * Usage: node news.js
 */

import { startHeartbeat } from './heartbeat.js';
startHeartbeat('news.js');
import https    from 'https';
import http     from 'http';
import { exec } from 'child_process';
import { XMLParser } from 'fast-xml-parser';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Anthropic from '@anthropic-ai/sdk';

const __newsDir = dirname(fileURLToPath(import.meta.url));
const OVERNIGHT_NEWS_FILE     = join(__newsDir, 'overnight-news.json');
const REALTIME_NEWS_FILE      = join(__newsDir, 'realtime-news.json');
const ECONOMIC_CALENDAR_FILE  = join(__newsDir, 'economic-calendar.json');
const MAX_OVERNIGHT = 50;
const REALTIME_NEWS_WINDOW_MS = 5 * 60 * 1000;   // 5 minutes

// ─── Anthropic client ─────────────────────────────────────────────────────────

let anthropic = null;
try {
  anthropic = new Anthropic();  // reads ANTHROPIC_API_KEY from env
} catch {
  // Will warn in main()
}

// ─── Overnight writer ─────────────────────────────────────────────────────────

// 2026-05-18 — FADE engine real-time feed. Webhook reads this file on
// FADE_CANDIDATE alerts and joins with a 60s lookback against HIGH-impact
// events. 5-minute rolling window keeps the file small + immediate.
function saveRealtimeNews(title, sourceName, tier, tickers) {
  try {
    const existing = existsSync(REALTIME_NEWS_FILE)
      ? JSON.parse(readFileSync(REALTIME_NEWS_FILE, 'utf8'))
      : [];
    const cutoff = Date.now() - REALTIME_NEWS_WINDOW_MS;
    const fresh  = existing.filter(e => e.ts > cutoff);
    const impact = tier <= 2 ? 'HIGH' : tier <= 3 ? 'MEDIUM' : 'LOW';
    fresh.push({
      ts:    Date.now(),
      tsISO: new Date().toISOString(),
      et:    etNow(),
      source: sourceName,
      headline: title.slice(0, 240),
      impact,
      tier,
      type:  'NEWS',  // Phase 2: refine to GEO/FED/ECON/EARNINGS via classifier
      instruments_affected: (tickers && tickers.length)
        ? tickers
        : ['ES1!','NQ1!','MES1!','MNQ1!','SPY','QQQ'],
    });
    writeFileSync(REALTIME_NEWS_FILE, JSON.stringify(fresh, null, 2));
  } catch { /* silent */ }
}

// Snapshot the in-memory economicCalendar to disk so webhook can read it
// for FADE blackout checks (FOMC/CPI/NFP/GDP/PCE ±15min suppression).
// Earnings calendar intentionally excluded — FADE blackout is for macro
// regime-shift events only, not individual-stock earnings.
function saveEconomicCalendar() {
  try {
    writeFileSync(ECONOMIC_CALENDAR_FILE, JSON.stringify({
      ts: Date.now(),
      tsISO: new Date().toISOString(),
      events: economicCalendar,
    }, null, 2));
  } catch { /* silent */ }
}

function saveOvernightNews(title, tickers, tier) {
  try {
    const existing = existsSync(OVERNIGHT_NEWS_FILE)
      ? JSON.parse(readFileSync(OVERNIGHT_NEWS_FILE, 'utf8'))
      : [];
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const fresh  = existing.filter(e => e.ts > cutoff);
    fresh.push({
      ts:      Date.now(),
      time:    new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }),
      title:   title.slice(0, 200),
      tickers: tickers ?? [],
      tier,
    });
    writeFileSync(OVERNIGHT_NEWS_FILE, JSON.stringify(fresh.slice(-MAX_OVERNIGHT), null, 2));
  } catch { /* silent */ }
}

// ─── TTS Engine ───────────────────────────────────────────────────────────────

let ttsEnabled = true;

function speak(text) {
  if (!ttsEnabled) return;
  const clean = text
    .replace(/'/g, '')
    .replace(/"/g, '')
    .replace(/[^\w\s.,!?$%:@-]/g, ' ')
    .slice(0, 220);
  exec(`powershell -Command "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('Microsoft Hazel Desktop'); $s.Rate = 1; $s.Speak('${clean}')"`,
    err => { /* silent fail */ });
}

function listVoices() {
  exec(`powershell -Command "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }"`,
    (err, stdout) => {
      console.log(`\n  ${C.cyan}Available voices:${C.reset}`);
      stdout.trim().split('\n').forEach(v => console.log(`  - ${v.trim()}`));
      console.log('');
    });
}

function toggleTTS() {
  ttsEnabled = !ttsEnabled;
  const status = ttsEnabled ? `${C.green}ON${C.reset}` : `${C.gray}OFF${C.reset}`;
  console.log(`\n  [TTS] Voice ${status}  (press T to toggle)\n`);
  if (ttsEnabled) speak('Voice alerts enabled');
}

function initKeyboard() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', key => {
      if (key === 't' || key === 'T') toggleTTS();
      if (key === '') process.exit();
    });
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

const PRIMARY_POLL_MS = 15_000;   // Financial Juice — every 15s
const POLL_MS         = 60_000;   // Secondary feeds — every 60s
const EDGAR_POLL_MS   = 120_000;  // SEC EDGAR — every 2 min
const MAX_AGE_MS      = 10 * 60 * 1000;
const SHOWN_GUIDS     = new Set();

// IWM retired 2026-05-15 (Task 6). BE/CRDO/FN correlation watchers dropped
// with it — they were IWM-cluster proxies and have no value for SPY/QQQ.
const WATCHLIST = ['SPY', 'NVDA', 'AAPL', 'MSFT', 'META', 'AMZN', 'GOOGL',
                   'QQQ', 'SOXX', 'CAR', 'CRWV', 'CBRS', 'TSLA', 'IBM'];

// ─── Tier Keyword System ──────────────────────────────────────────────────────
//
// T1 — macro/systemic. Auto-analysis always fires.
// T2 — high impact corporate/geopolitical. Auto-analysis fires.
// T3 — sector/moderate. No auto-analysis, beep only for watchlist hits.
// T4 — low signal. Display only.

const TIER1 = [
  'federal reserve', 'fomc', 'rate decision', 'emergency rate', 'rate cut', 'rate hike',
  'cpi', 'core cpi', 'pce', 'core pce', 'nonfarm payroll', 'jobs report', 'payrolls',
  'gdp', 'recession', 'depression',
  'market halt', 'circuit breaker', 'trading halt', 'exchange halt',
  'nuclear', 'war declared', 'invasion',
  'market crash', 'flash crash', 'meltdown', 'bank run', 'bank failure',
  'debt ceiling', 'government shutdown', 'default',
];

const TIER2 = [
  'tariff', 'trade war', 'trade deal', 'sanction', 'export ban',
  'treasury yield', '10-year yield', 'yield curve', 'yield inversion',
  'merger', 'acquisition', 'buyout', 'takeover',
  'bankruptcy', 'chapter 11',
  'sec charges', 'sec investigation', 'sec enforcement', 'fraud',
  'earnings beat', 'earnings miss', 'guidance raised', 'guidance cut', 'guidance withdrawn',
  'iran', 'hormuz', 'blockade', 'opec',
  'powell', 'fed chair', 'yellen', 'treasury secretary',
  'trump', 'executive order',
  'attack', 'ceasefire', 'seized',
];

const TIER3 = [
  'fed', 'inflation', 'interest rate',
  'earnings', 'revenue', 'eps', 'beat', 'miss',
  'downgrade', 'upgrade', 'price target', 'overweight', 'underweight',
  'layoff', 'ipo', 'dividend', 'buyback', 'offering',
  'oil', 'crude', 'opec', 'supply',
  'chip', 'semiconductor', 'datacenter',
  'china', 'russia', 'middle east', 'conflict', 'war',
  'sec', 'investigation', 'lawsuit',
  'guidance', 'outlook', 'forecast',
];

const TIER4 = [
  'ai', 'artificial intelligence', 'cloud', 'software', 'hardware',
  'ceo', 'cfo', 'executive', 'hire', 'resign',
  'partnership', 'collaboration',
  'patent', 'product launch', 'launch',
  'iphone', 'android',
];

// ─── Source Credibility ───────────────────────────────────────────────────────

const SOURCE_CRED = {
  'Financial Juice': 0.95,
  'Reuters Business': 0.90,
  'AP Business':     0.85,
  'CNBC Top News':   0.75,
  'SEC Form 4':      0.99,
  'SEC 8-K':         0.99,
};

// ─── RSS Feeds ────────────────────────────────────────────────────────────────

const RSS_FEEDS = [
  { name: 'Financial Juice', url: 'https://www.financialjuice.com/feed.ashx?xy=rss', color: '\x1b[32m', primary: true },
  { name: 'Reuters Business', url: 'https://feeds.reuters.com/reuters/businessNews', color: '\x1b[36m' },
  { name: 'AP Business',      url: 'https://feeds.apnews.com/rss/apf-business',      color: '\x1b[33m' },
  { name: 'CNBC Top News',    url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', color: '\x1b[34m' },
];

const EDGAR_FEEDS = [
  { name: 'SEC Form 4', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=10&search_text=&output=atom',   color: '\x1b[31m' },
  { name: 'SEC 8-K',    url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&dateb=&owner=include&count=10&search_text=&output=atom', color: '\x1b[31m' },
];

// ─── Colors ───────────────────────────────────────────────────────────────────

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  gray:    '\x1b[90m',
  white:   '\x1b[97m',
  bgRed:   '\x1b[41m',
  bgMag:   '\x1b[45m',
};

// ─── Live Calendars ───────────────────────────────────────────────────────────

const FALLBACK_ECON = [
  { date: '2026-05-08', time: '08:30', event: 'Jobless Claims',          impact: 'HIGH'   },
  { date: '2026-05-08', time: '08:30', event: 'PPI',                     impact: 'HIGH'   },
  { date: '2026-05-09', time: '10:00', event: 'UMich Consumer Sentiment', impact: 'MEDIUM' },
  { date: '2026-05-13', time: '08:30', event: 'CPI',                     impact: 'HIGH'   },
  { date: '2026-05-15', time: '08:30', event: 'Retail Sales',            impact: 'HIGH'   },
  { date: '2026-05-15', time: '08:30', event: 'Jobless Claims',          impact: 'MEDIUM' },
];

let economicCalendar = [...FALLBACK_ECON];
let earningsCalendar = [];
let calendarFetched  = false;

function parseICalEvents(ical) {
  const text   = ical.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const blocks = text.split('BEGIN:VEVENT');
  const events = [];

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const get   = key => {
      const m = block.match(new RegExp(`^${key}[^:\\r\\n]*:(.+)$`, 'im'));
      return m ? m[1].trim() : null;
    };
    const dtRaw   = get('DTSTART');
    const summary = get('SUMMARY');
    if (!dtRaw || !summary) continue;

    const isUTC = dtRaw.endsWith('Z');
    const dm    = dtRaw.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
    if (!dm) continue;
    const [, y, mo, d, h, mi] = dm;

    let dateET, timeET;
    if (isUTC) {
      const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:00Z`);
      dateET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(dt);
      timeET = dt.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
    } else {
      dateET = `${y}-${mo}-${d}`;
      timeET = `${h}:${mi}`;
    }

    const desc = get('DESCRIPTION') || '';
    const loc  = get('LOCATION')    || '';
    if (!/USD|United States/i.test(desc + ' ' + loc)) continue;

    const impact = /Impact:High/i.test(desc) ? 'HIGH' : /Impact:Medium/i.test(desc) ? 'MEDIUM' : null;
    if (!impact) continue;

    events.push({ date: dateET, time: timeET, event: summary, impact, source: 'econ' });
  }
  return events.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
}

function toETDateStr(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
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
    return toETDateStr(d);
  });
}

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

async function fetchEconomicCalendar() {
  const urls = [
    'https://nfs.faireconomy.media/ff_calendar_thisweek.xml',
    'https://nfs.faireconomy.media/ff_calendar_nextweek.xml',
  ];
  const results = await Promise.allSettled(urls.map(u => fetchUrl(u).then(parseICalEvents)));
  const events  = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  if (events.length > 0) economicCalendar = events;
  return events.length;
}

async function fetchEarningsCalendar() {
  const dates   = [...getWeekDates(0), ...getWeekDates(1)];
  const headers = { 'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9' };

  const results = await Promise.allSettled(dates.map(async date => {
    const raw  = await fetchUrl(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, headers);
    const json = JSON.parse(raw);
    return (json?.data?.rows ?? [])
      .filter(r => {
        if (!r?.symbol) return false;
        if (WATCHLIST.includes(r.symbol.trim().toUpperCase())) return true;
        return parseMarketCap(r.marketCap) >= 50e9;
      })
      .map(r => ({
        date, time: normalizeEarningsTime(r.time),
        event:  `${r.symbol.trim()} Earnings`,
        detail: r.name ?? '',
        eps:    r.epsForecast ?? '',
        mktCap: r.marketCap ?? '',
        impact: WATCHLIST.includes(r.symbol.trim().toUpperCase()) ? 'HIGH' : 'MEDIUM',
        source: 'earnings',
      }));
  }));

  const all = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  const seen = new Set();
  const deduped = all.filter(e => {
    const key = `${e.event}|${e.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.date.localeCompare(b.date));

  if (deduped.length > 0) earningsCalendar = deduped;
  return deduped.length;
}

async function refreshCalendars() {
  try {
    const results = await Promise.allSettled([fetchEconomicCalendar(), fetchEarningsCalendar()]);
    const [econN, earnN] = results.map(r => r.status === 'fulfilled' ? r.value : 0);
    calendarFetched = econN > 0 || earnN > 0;
    const src = calendarFetched ? `${C.green}live${C.reset}` : `${C.yellow}fallback${C.reset}`;
    console.log(`  ${C.gray}Calendar: ${econN} econ events, ${earnN} earnings  [${src}${C.gray}]${C.reset}`);
    // 2026-05-18: snapshot calendar for FADE blackout reads
    saveEconomicCalendar();
  } catch {
    console.log(`  ${C.gray}Calendar fetch failed — using fallback${C.reset}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fetchUrl(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HankNewsBot/3.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        ...extraHeaders,
      },
      timeout: 10000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchUrl(res.headers.location, extraHeaders).then(resolve).catch(reject);
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function etNow() {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function etDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function truncate(str, len = 100) {
  return str?.length > len ? str.slice(0, len) + '…' : str ?? '';
}

function extractTickers(text) {
  return WATCHLIST.filter(t => new RegExp(`\\b${t}\\b`, 'i').test(text));
}

// ─── Tier Scorer ──────────────────────────────────────────────────────────────

function scoreTier(text) {
  const lower = text.toLowerCase();

  const tickerHit = WATCHLIST.find(t => new RegExp(`\\b${t}\\b`, 'i').test(text));
  const t1 = TIER1.filter(k => lower.includes(k)).length;
  const t2 = TIER2.filter(k => lower.includes(k)).length;
  const t3 = TIER3.filter(k => lower.includes(k)).length;
  const t4 = TIER4.filter(k => lower.includes(k)).length;

  if (t1 >= 1)                               return { tier: 1, score: t1 * 20 + (tickerHit ? 10 : 0), tickers: extractTickers(text) };
  if (t2 >= 1 || (t3 >= 2 && tickerHit))    return { tier: 2, score: t2 * 10 + t3 * 3 + (tickerHit ? 8 : 0), tickers: extractTickers(text) };
  if (t3 >= 1 || tickerHit)                 return { tier: 3, score: t3 * 3 + (tickerHit ? 5 : 0), tickers: extractTickers(text) };
  if (t4 >= 1)                               return { tier: 4, score: t4, tickers: [] };
  return null;
}

function tierColor(tier) {
  if (tier === 1) return C.red + C.bold;
  if (tier === 2) return C.yellow;
  if (tier === 3) return C.cyan;
  return C.gray;
}

function tierBadge(tier) {
  if (tier === 1) return `${C.bgRed}${C.white}${C.bold} ⚠  T1   ${C.reset}`;
  if (tier === 2) return `${C.yellow}${C.bold}  ●  T2   ${C.reset}`;
  if (tier === 3) return `${C.cyan}  ○  T3   ${C.reset}`;
  return `${C.gray}  ·  T4   ${C.reset}`;
}

// ─── Contradiction Detector ───────────────────────────────────────────────────

const RECENT_HEADLINES = [];  // rolling 15-min buffer for contradiction detection
const CONTRADICTION_WINDOW_MS = 15 * 60 * 1000;

const BULL_WORDS = ['rate cut', 'beat', 'guidance raised', 'ceasefire', 'deal', 'buy', 'upgrade', 'surge', 'recovery', 'stimulus'];
const BEAR_WORDS = ['rate hike', 'miss', 'guidance cut', 'war', 'sanction', 'sell', 'downgrade', 'crash', 'default', 'tariff', 'inflation'];

function inferDirection(text) {
  const lower = text.toLowerCase();
  const bullHits = BULL_WORDS.filter(w => lower.includes(w)).length;
  const bearHits = BEAR_WORDS.filter(w => lower.includes(w)).length;
  if (bullHits > bearHits) return 'BULL';
  if (bearHits > bullHits) return 'BEAR';
  return 'NEUTRAL';
}

function detectContradiction(title) {
  const now = Date.now();
  // Prune stale entries
  while (RECENT_HEADLINES.length && RECENT_HEADLINES[0].ts < now - CONTRADICTION_WINDOW_MS)
    RECENT_HEADLINES.shift();

  const dir = inferDirection(title);
  if (dir === 'NEUTRAL') return null;

  // Look for a recent headline on the same topic pointing the other way
  for (const h of RECENT_HEADLINES) {
    if (h.dir === 'NEUTRAL' || h.dir === dir) continue;
    // Check topic overlap: at least one shared tier keyword
    const lower = title.toLowerCase();
    const shared = [...TIER1, ...TIER2].find(k => lower.includes(k) && h.lower.includes(k));
    if (shared) return { against: h.title, keyword: shared };
  }

  RECENT_HEADLINES.push({ ts: now, title, dir, lower: title.toLowerCase() });
  return null;
}

// ─── Fade Bias Tracker ────────────────────────────────────────────────────────

let fadeBiasOn = false;
const FADE_BIAS_WINDOW = 10;        // last N scored headlines
const FADE_BIAS_THRESHOLD = 0.75;   // 75% same direction triggers fade
const fadeBiasHistory = [];         // { dir: 'BULL'|'BEAR', ts: ms }

function updateFadeBias(dir) {
  if (dir === 'NEUTRAL') return;
  const now = Date.now();
  fadeBiasHistory.push({ dir, ts: now });
  // Keep last 10 entries within 30 minutes
  const cutoff = now - 30 * 60 * 1000;
  while (fadeBiasHistory.length > FADE_BIAS_WINDOW || (fadeBiasHistory[0]?.ts ?? now) < cutoff)
    fadeBiasHistory.shift();

  if (fadeBiasHistory.length < 5) { fadeBiasOn = false; return; }

  const bulls = fadeBiasHistory.filter(h => h.dir === 'BULL').length;
  const bears = fadeBiasHistory.filter(h => h.dir === 'BEAR').length;
  const ratio = Math.max(bulls, bears) / fadeBiasHistory.length;
  const prevOn = fadeBiasOn;
  fadeBiasOn = ratio >= FADE_BIAS_THRESHOLD;

  if (fadeBiasOn !== prevOn) {
    const dom = bulls > bears ? 'BULL' : 'BEAR';
    const fade = dom === 'BULL' ? `${C.red}FADE BULLS → lean PUTS${C.reset}` : `${C.green}FADE BEARS → lean CALLS${C.reset}`;
    console.log(`\n  ${C.bgMag}${C.white}${C.bold} ↕ FADE BIAS ${C.reset}  ${fade}  ${C.dim}(${fadeBiasHistory.length} signals, ${(ratio*100).toFixed(0)}% ${dom})${C.reset}`);
  }
}

// ─── Claude Auto-Analysis ─────────────────────────────────────────────────────

let lastAnalysisTs = 0;
const ANALYSIS_COOLDOWN_MS = 45_000;
let analysisQueue = [];
let analysisRunning = false;

async function fullAutoAnalysis(title, tier, tickers, sourceCred, contradiction) {
  if (!anthropic) return null;

  const now = Date.now();
  if (now - lastAnalysisTs < ANALYSIS_COOLDOWN_MS) {
    // Queue it — will fire after cooldown clears
    if (analysisQueue.length < 3) analysisQueue.push({ title, tier, tickers, sourceCred, contradiction, ts: now });
    return null;
  }

  lastAnalysisTs = now;

  const instrContext = 'HANK trades SPY/QQQ 0DTE options + ES/NQ/MES/MNQ futures intraday.';
  const contString = contradiction
    ? `\nWARNING: Contradicts recent headline "${truncate(contradiction.against, 80)}" on topic "${contradiction.keyword}". Note the contradiction.`
    : '';
  const fadeBiasStr = fadeBiasOn
    ? `\nFADE BIAS ACTIVE: Recent headlines skewed one-sided. Weight your analysis accordingly.`
    : '';
  const credStr = sourceCred < 0.80 ? ` (Source credibility: ${(sourceCred*100).toFixed(0)}% — treat with caution)` : '';

  const prompt = `${instrContext}
Headline (Tier ${tier}${credStr}): "${title}"
Affected tickers: ${tickers.length ? tickers.join(', ') : 'none/macro'}${contString}${fadeBiasStr}

Respond in exactly this format (one line each, no extra text):
DIRECTION: [BULLISH|BEARISH|NEUTRAL|MIXED]
INSTRUMENTS: [which of SPY/QQQ are most affected and why, max 15 words]
TRADE: [CALLS|PUTS|HOLD|WATCH] on [instrument], [entry note max 10 words]
CONFIDENCE: [HIGH|MEDIUM|LOW]
REASONING: [one sentence, max 25 words]`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content[0]?.text ?? null;
  } catch (e) {
    return null;
  }
}

function printAutoAnalysis(rawText, tier) {
  if (!rawText) return;
  const lines = rawText.trim().split('\n').filter(Boolean);
  const parsed = {};
  for (const line of lines) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) parsed[m[1].toUpperCase()] = m[2].trim();
  }

  const dir  = parsed.DIRECTION ?? 'NEUTRAL';
  const dirCol = dir === 'BULLISH' ? C.green : dir === 'BEARISH' ? C.red : dir === 'MIXED' ? C.yellow : C.gray;
  const trade = parsed.TRADE ?? '';
  const tradeCol = /CALLS/i.test(trade) ? C.green : /PUTS/i.test(trade) ? C.red : C.yellow;
  const conf = parsed.CONFIDENCE ?? 'LOW';
  const confCol = conf === 'HIGH' ? C.green : conf === 'MEDIUM' ? C.yellow : C.gray;

  console.log(`  ${C.bgMag}${C.white}${C.bold} 🤖 CLAUDE T${tier} ${C.reset}`);
  if (parsed.DIRECTION)   console.log(`  ${C.dim}Direction:${C.reset}   ${dirCol}${C.bold}${dir}${C.reset}`);
  if (parsed.INSTRUMENTS) console.log(`  ${C.dim}Instruments:${C.reset} ${C.cyan}${parsed.INSTRUMENTS}${C.reset}`);
  if (parsed.TRADE)       console.log(`  ${C.dim}Trade:${C.reset}       ${tradeCol}${C.bold}${trade}${C.reset}`);
  if (parsed.CONFIDENCE)  console.log(`  ${C.dim}Confidence:${C.reset}  ${confCol}${conf}${C.reset}`);
  if (parsed.REASONING)   console.log(`  ${C.dim}Reasoning:${C.reset}   ${C.white}${parsed.REASONING}${C.reset}`);
}

async function drainAnalysisQueue() {
  if (analysisRunning || !analysisQueue.length) return;
  const now = Date.now();
  if (now - lastAnalysisTs < ANALYSIS_COOLDOWN_MS) return;

  analysisRunning = true;
  const item = analysisQueue.shift();
  if (item) {
    const result = await fullAutoAnalysis(item.title, item.tier, item.tickers, item.sourceCred, item.contradiction);
    if (result) {
      console.log(`\n  ${C.gray}[queued analysis — ${item.title.slice(0, 60)}]${C.reset}`);
      printAutoAnalysis(result, item.tier);
    }
  }
  analysisRunning = false;
}

// ─── RSS Parser ───────────────────────────────────────────────────────────────

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function parseRSS(xml) {
  try {
    const obj     = parser.parse(xml);
    const channel = obj?.rss?.channel || obj?.feed;
    if (!channel) return [];
    const items = channel.item || channel.entry || [];
    const arr   = Array.isArray(items) ? items : [items];
    return arr.map(item => ({
      title:   item.title?.['#text'] || item.title || '',
      link:    item.link?.['@_href'] || item.link || '',
      pubDate: item.pubDate || item.published || item.updated || '',
      guid:    item.guid?.['#text'] || item.guid || item.id || item.link || '',
      summary: item.description || item.summary?.['#text'] || item.summary || '',
    })).filter(i => i.title);
  } catch {
    return [];
  }
}

// ─── Special Detectors ────────────────────────────────────────────────────────

function parseMOC(text) {
  if (!/MOC Imbalance|MOO Imbalance/i.test(text)) return null;
  const type  = /MOO/i.test(text) ? 'MOO' : 'MOC';
  const lines = text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').split('\n').filter(Boolean);
  return { type, lines };
}

function parseCrude(title) {
  const m = title.match(/WTI Crude.*?settle[sd]? at \$?([\d.]+)/i);
  return m ? parseFloat(m[1]) : null;
}

const FLOW_CALL_PATTERNS    = [/call sweep/i, /call block/i, /bullish flow/i, /bullish sweep/i, /unusual call/i, /large call/i, /opening call/i, /bought calls/i, /call buyer/i, /call volume/i];
const FLOW_PUT_PATTERNS     = [/put sweep/i, /put block/i, /bearish flow/i, /bearish sweep/i, /unusual put/i, /large put/i, /opening put/i, /bought puts/i, /put buyer/i, /put volume/i];
const FLOW_NEUTRAL_PATTERNS = [/unusual options/i, /unusual activity/i, /block trade/i, /options sweep/i, /large options/i, /notable flow/i];

function parseFlowAlert(text) {
  const full = text.toLowerCase();
  if (!/\boptions?\b|calls?\b|puts?\b|sweep|block trade|flow/i.test(full)) return null;
  const isCall = FLOW_CALL_PATTERNS.some(p => p.test(full));
  const isPut  = FLOW_PUT_PATTERNS.some(p => p.test(full));
  const isFlow = FLOW_NEUTRAL_PATTERNS.some(p => p.test(full));
  if (!isCall && !isPut && !isFlow) return null;

  const tickerHit = WATCHLIST.find(t => new RegExp(`\\b${t}\\b`, 'i').test(text));
  const sizeMatch = text.match(/([\d,]+\.?\d*)\s*[Kk]\s*contracts?/) ||
                    text.match(/([\d,]+)\s*contracts?/i) ||
                    text.match(/([\d,]+\.?\d*)\s*[Kk]\s*(?:calls?|puts?)/i);
  const size = sizeMatch ? sizeMatch[1].replace(/,/g, '') + (sizeMatch[0].match(/[Kk]/) ? 'K' : '') : null;
  return { direction: isCall ? 'CALLS' : isPut ? 'PUTS' : 'FLOW', ticker: tickerHit ?? null, size };
}

function writeFlowSignal(direction, ticker, title) {
  try {
    writeFileSync(join(__newsDir, 'flow-signal.json'), JSON.stringify({ direction, ticker, title, ts: Date.now(), time: etNow() }, null, 2));
  } catch {}
}

// ─── Print News Item ──────────────────────────────────────────────────────────

async function printNewsItem(item, sourceName, sourceColor) {
  const fullText = item.title + ' ' + (item.summary || '');
  const cred = SOURCE_CRED[sourceName] ?? 0.70;

  // MOC/MOO imbalance
  const moc = parseMOC(fullText);
  if (moc) {
    const badge = `${C.bgRed}${C.white}${C.bold} 📊 ${moc.type}  ${C.reset}`;
    console.log(`\n  ${badge} ${sourceColor}${sourceName}${C.reset}  ${C.gray}${etNow()} ET${C.reset}`);
    for (const line of moc.lines) {
      const col = line.includes('+') ? C.green : line.includes('-') && !line.includes('Mag') ? C.red : C.white;
      console.log(`  ${col}${line}${C.reset}`);
    }
    process.stdout.write('\x07');
    speak(`${moc.type} imbalance alert`);
    return true;
  }

  // Options flow
  const flow = parseFlowAlert(fullText);
  if (flow) {
    const col   = flow.direction === 'CALLS' ? C.green : flow.direction === 'PUTS' ? C.red : C.yellow;
    const emoji = flow.direction === 'CALLS' ? '📈' : flow.direction === 'PUTS' ? '📉' : '⚡';
    const title = item.title.replace(/^FinancialJuice:\s*/i, '').trim();
    console.log(`\n  ${col}${C.bold} ${emoji} FLOW ${flow.direction} ${C.reset} ${sourceColor}${sourceName}${C.reset}  ${C.gray}${etNow()} ET${C.reset}`);
    console.log(`  ${col}${truncate(title, 120)}${C.reset}${flow.ticker ? ` ${C.cyan}[${flow.ticker}]${C.reset}` : ''}${flow.size ? ` ${C.dim}${flow.size} contracts${C.reset}` : ''}`);
    process.stdout.write('\x07');
    speak(`Options flow alert. ${flow.direction}. ${flow.ticker ?? ''}. ${truncate(title, 80)}`);
    writeFlowSignal(flow.direction, flow.ticker, title);
    return true;
  }

  // Crude oil
  const crude = parseCrude(item.title);
  if (crude != null) {
    const col = crude > 90 ? C.red + C.bold : crude > 80 ? C.yellow : C.green;
    console.log(`\n  ${col} 🛢  OIL  ${C.reset} ${sourceColor}${sourceName}${C.reset}  ${C.gray}${etNow()} ET${C.reset}`);
    console.log(`  ${col}WTI Crude settled at $${crude.toFixed(2)}/bbl${C.reset}`);
    if (crude > 90) { process.stdout.write('\x07'); speak(`Warning. WTI Crude above 90 dollars.`); }
    return true;
  }

  // Tier scoring
  const scored = scoreTier(fullText);
  if (!scored) return false;

  const { tier, tickers } = scored;
  const title = item.title.replace(/^FinancialJuice:\s*/i, '').trim();
  const tickerStr = tickers.length ? ` ${C.cyan}[${tickers.join(', ')}]${C.reset}` : '';

  // Contradiction check
  const contradiction = detectContradiction(title);

  // Credibility warning for low-cred sources
  const credWarn = cred < 0.80 ? ` ${C.dim}[cred:${(cred*100).toFixed(0)}%]${C.reset}` : '';

  console.log(`\n  ${tierBadge(tier)} ${sourceColor}${sourceName}${C.reset}  ${C.gray}${etNow()} ET${C.reset}${credWarn}`);
  console.log(`  ${tierColor(tier)}${truncate(title, 120)}${C.reset}${tickerStr}`);

  // Contradiction warning
  if (contradiction) {
    console.log(`  ${C.yellow}⚡ CONTRADICTS: "${truncate(contradiction.against, 70)}" [${contradiction.keyword}]${C.reset}`);
  }

  // Fade bias update
  updateFadeBias(inferDirection(title));

  // Beep on T1/T2
  if (tier <= 2) {
    process.stdout.write('\x07');
    speak(`Tier ${tier} alert. ${truncate(title, 120)}`);
  }

  // Save T1/T2/T3 to overnight-news.json
  if (tier <= 3) saveOvernightNews(title, tickers, tier);
  // 2026-05-18: realtime-news.json for FADE engine join (5min rolling)
  if (tier <= 3) saveRealtimeNews(title, sourceName, tier, tickers);

  // Auto-analysis for T1 and T2
  if (tier <= 2) {
    const result = await fullAutoAnalysis(title, tier, tickers, cred, contradiction);
    if (result) printAutoAnalysis(result, tier);
  }

  return true;
}

// ─── Calendar Display ─────────────────────────────────────────────────────────

function printCalendar() {
  const today  = etDate();
  const cutoff = toETDateStr(new Date(Date.now() + 14 * 24 * 60 * 60 * 1000));
  const combined = [...economicCalendar, ...earningsCalendar]
    .filter(e => e.date >= today && e.date <= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  if (!combined.length) return;

  const srcTag = calendarFetched
    ? `${C.dim}(live — ForexFactory + NASDAQ)${C.reset}`
    : `${C.yellow}(fallback — update failed)${C.reset}`;
  console.log(`\n  ${C.bold}ECONOMIC & EARNINGS CALENDAR${C.reset}  ${srcTag}`);
  console.log(`  ${'─'.repeat(78)}`);

  for (const e of combined.slice(0, 18)) {
    const isToday  = e.date === today;
    const dateLabel = isToday ? `${C.yellow}${C.bold}TODAY    ${C.reset}` : `${C.gray}${e.date}${C.reset}`;
    const impCol   = e.impact === 'HIGH' ? C.red + C.bold : C.yellow;
    const badge    = e.impact === 'HIGH' ? '⚠ ' : '● ';
    const typeTag  = e.source === 'earnings' ? `${C.cyan}[ERN]${C.reset} ` : `${C.gray}[ECO]${C.reset} `;
    const extra    = e.source === 'earnings' && e.mktCap ? `  ${C.dim}${e.mktCap}${C.reset}` : '';
    console.log(`  ${dateLabel}  ${e.time.padEnd(5)}  ${typeTag}${impCol}${badge}${e.event}${C.reset}${extra}`);
  }
  console.log(`  ${'─'.repeat(78)}`);
}

// ─── News Fetcher ─────────────────────────────────────────────────────────────

async function fetchNews(isStartup = false) {
  let anyNews = false;
  for (const feed of RSS_FEEDS) {
    try {
      const items = parseRSS(await fetchUrl(feed.url));
      for (const item of items) {
        if (SHOWN_GUIDS.has(item.guid)) continue;
        if (isStartup && item.pubDate) {
          if (Date.now() - new Date(item.pubDate).getTime() > MAX_AGE_MS) {
            SHOWN_GUIDS.add(item.guid); continue;
          }
        }
        SHOWN_GUIDS.add(item.guid);
        const shown = await printNewsItem(item, feed.name, feed.color);
        if (shown) anyNews = true;
      }
    } catch { /* silent */ }
  }
  return anyNews;
}

// ─── SEC EDGAR Fetcher ────────────────────────────────────────────────────────

async function fetchEdgar() {
  for (const feed of EDGAR_FEEDS) {
    try {
      const items = parseRSS(await fetchUrl(feed.url));
      for (const item of items) {
        if (SHOWN_GUIDS.has(item.guid)) continue;
        SHOWN_GUIDS.add(item.guid);
        const tickers = extractTickers(item.title + ' ' + item.summary);
        if (!tickers.length) continue;
        const badge = `${C.bgRed}${C.white}${C.bold} 📋 SEC  ${C.reset}`;
        console.log(`\n  ${badge} ${feed.color}${feed.name}${C.reset}  ${C.gray}${etNow()} ET${C.reset}`);
        console.log(`  ${C.red}${C.bold}${truncate(item.title, 110)}${C.reset} ${C.cyan}[${tickers.join(', ')}]${C.reset}`);
        console.log(`  ${C.gray}${item.link}${C.reset}`);
        process.stdout.write('\x07');
        speak(`S E C filing alert. ${tickers.join(', ')}. ${truncate(item.title, 80)}`);
      }
    } catch { /* silent */ }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.clear();

  try { await import('fast-xml-parser'); }
  catch {
    console.log(`\n  ${C.red}Missing: fast-xml-parser${C.reset}  →  npm install fast-xml-parser`);
    process.exit(1);
  }

  const apiOk = !!process.env.ANTHROPIC_API_KEY;
  if (!apiOk) {
    console.log(`  ${C.yellow}⚠  ANTHROPIC_API_KEY not set — auto-analysis disabled${C.reset}`);
    anthropic = null;
  }

  console.log(`\n  ${C.bold}${C.cyan}HANK NEWS TERMINAL v3${C.reset}`);
  console.log(`  Primary:       Financial Juice (${PRIMARY_POLL_MS/1000}s poll)`);
  console.log(`  Secondary:     Reuters, AP, CNBC (${POLL_MS/1000}s poll)`);
  console.log(`  SEC:           Form 4, 8-K (${EDGAR_POLL_MS/1000}s poll)`);
  console.log(`  Tier system:   T1 (macro) → T2 (corporate) → T3 (sector) → T4 (low)`);
  console.log(`  Auto-analysis: ${apiOk ? `${C.green}ON${C.reset} — Claude fires on T1/T2, cooldown ${ANALYSIS_COOLDOWN_MS/1000}s` : `${C.gray}OFF (no API key)${C.reset}`}`);
  console.log(`  Fade bias:     ON — contradictions flagged, bias tracked`);
  console.log(`  Watchlist:     ${WATCHLIST.join(', ')}`);
  console.log(`  Voice:         ${ttsEnabled ? C.green + 'ON' : C.gray + 'OFF'}${C.reset}  (press T to toggle)\n`);

  initKeyboard();
  listVoices();

  await refreshCalendars();
  printCalendar();
  setInterval(refreshCalendars, 24 * 60 * 60 * 1000);

  console.log(`\n  ${C.gray}Fetching latest headlines...${C.reset}`);
  await fetchNews(true);
  await fetchEdgar();

  console.log(`\n  ${C.gray}Live monitoring active. Headlines appear below.${C.reset}`);
  console.log(`  ${'─'.repeat(78)}`);

  // Primary feed — Financial Juice every 15s
  setInterval(async () => {
    for (const feed of RSS_FEEDS.filter(f => f.primary)) {
      try {
        const items = parseRSS(await fetchUrl(feed.url));
        for (const item of items) {
          if (SHOWN_GUIDS.has(item.guid)) continue;
          SHOWN_GUIDS.add(item.guid);
          await printNewsItem(item, feed.name, feed.color);
        }
      } catch { /* silent */ }
    }
    await drainAnalysisQueue();
  }, PRIMARY_POLL_MS);

  // Secondary feeds — every 60s
  setInterval(async () => {
    for (const feed of RSS_FEEDS.filter(f => !f.primary)) {
      try {
        const items = parseRSS(await fetchUrl(feed.url));
        for (const item of items) {
          if (SHOWN_GUIDS.has(item.guid)) continue;
          SHOWN_GUIDS.add(item.guid);
          await printNewsItem(item, feed.name, feed.color);
        }
      } catch { /* silent */ }
    }
  }, POLL_MS);

  // SEC EDGAR — every 2 min
  setInterval(fetchEdgar, EDGAR_POLL_MS);

  // Calendar reminders — every minute
  setInterval(() => {
    const etStr   = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
    const todayET = etDate();
    for (const e of economicCalendar) {
      if (e.date !== todayET) continue;
      const [h, m] = e.time.split(':').map(Number);
      const [ch, cm] = etStr.split(':').map(Number);
      const diff = h * 60 + m - (ch * 60 + cm);
      if (diff === 0) {
        console.log(`\n  ${C.bgRed}${C.white}${C.bold} 📅 ECON ${C.reset}  ${C.red}${C.bold}NOW: ${e.event}${C.reset}`);
        process.stdout.write('\x07\x07');
        speak(`Economic event now. ${e.event}`);
      } else if (diff === 5) {
        console.log(`\n  ${C.yellow}${C.bold} ⏰ 5MIN ${C.reset}  ${C.yellow}5 min: ${e.event} at ${e.time} ET${C.reset}`);
        process.stdout.write('\x07');
        speak(`5 minute warning. ${e.event} at ${e.time} Eastern`);
      }
    }
  }, 60_000);

  process.on('SIGINT', () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    console.log(`\n\n  ${C.gray}News terminal stopped.${C.reset}\n`);
    process.exit(0);
  });
}

main().catch(err => {
  console.error(`\n  ${C.red}Fatal: ${err.message}${C.reset}\n`);
  process.exit(1);
});
