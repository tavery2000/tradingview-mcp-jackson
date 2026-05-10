#!/usr/bin/env node
/**
 * moo-moc.js — MOO + MOC Imbalance Engine
 *
 * Source: Financial Juice RSS (free, ~60s lag from NYSE/NASDAQ publication)
 *
 * What's available:
 *   NYSE/NASDAQ real-time imbalance feeds require paid subscriptions (Databento,
 *   NASDAQ TotalView, NYSE TAQ). Both official free endpoints are deprecated/404.
 *   Financial Juice RSS is the only no-cost source — it republishes the 09:20 MOO
 *   and 15:50 MOC publications with ~60s latency. Same source used by moc-engine.js.
 *
 * Windows:
 *   MOO: 09:20–09:29 ET  (NYSE/NASDAQ publish MOO imbalances at 09:20)
 *   MOC: 15:50–15:59 ET  (NYSE/NASDAQ publish MOC imbalances at 15:50)
 *
 * Output files (read by monitor.js / moc-engine.js):
 *   moo-signal.json  — written when MOO imbalance detected
 *   moc-signal.json  — written when MOC imbalance detected
 *   moc-data.json    — MOC data in format moc-engine.js expects (for compatibility)
 *
 * Thresholds (S&P 500 net imbalance):
 *   GREEN  ≥ $1B absolute — strong directional signal
 *   YELLOW ≥ $300M         — moderate signal
 *   GRAY   < $300M         — noise, do not trade
 *
 * Direction:
 *   spNet > 0 → more buys than sells → direction BUY → signal CALLS (price up at open/close)
 *   spNet < 0 → more sells than buys → direction SELL → signal PUTS  (price down at open/close)
 *
 * Usage: node moo-moc.js   (standalone — no monitor.js or wsServer required)
 */

import https    from 'https';
import http     from 'http';
import { exec } from 'child_process';
import { XMLParser } from 'fast-xml-parser';
import { writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MOO_SIGNAL_PATH = join(__dirname, 'moo-signal.json');
const MOC_SIGNAL_PATH = join(__dirname, 'moc-signal.json');
const MOC_DATA_PATH   = join(__dirname, 'moc-data.json');
const FJ_RSS_URL      = 'https://www.financialjuice.com/feed.ashx?xy=rss';

// ─── Colors ───────────────────────────────────────────────────────────────────

const C = {
  reset:    '\x1b[0m',  bold:     '\x1b[1m',  dim:      '\x1b[2m',
  green:    '\x1b[32m', red:      '\x1b[31m',  yellow:   '\x1b[33m',
  cyan:     '\x1b[36m', gray:     '\x1b[90m',  white:    '\x1b[97m',
  bgGreen:  '\x1b[42m\x1b[30m',
  bgRed:    '\x1b[41m\x1b[97m',
  bgYellow: '\x1b[43m\x1b[30m',
  bgCyan:   '\x1b[46m\x1b[30m',
};

// ─── ET helpers ───────────────────────────────────────────────────────────────

function etMins() {
  const t = new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
  });
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function etNow() {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// ─── TTS ──────────────────────────────────────────────────────────────────────

let ttsEnabled = true;

function speak(text) {
  if (!ttsEnabled) return;
  const clean = text.replace(/'/g, '').replace(/"/g, '').replace(/[^\w\s.,!?$%:@-]/g, ' ').slice(0, 200);
  exec(`powershell -Command "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('Microsoft Hazel Desktop'); $s.Rate = 1; $s.Speak('${clean}')"`,
    () => {});
}

// ─── RSS fetch ────────────────────────────────────────────────────────────────

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HankMooMoc/1.0)',
        'Accept':     'application/rss+xml, application/xml, text/xml, */*',
      },
      timeout: 12000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end',  () => resolve(data));
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function parseRSS(xml) {
  try {
    const obj     = xmlParser.parse(xml);
    const channel = obj?.rss?.channel || obj?.feed;
    if (!channel) return [];
    const items = channel.item || channel.entry || [];
    const arr   = Array.isArray(items) ? items : [items];
    return arr.map(item => ({
      title:   item.title?.['#text'] || item.title || '',
      guid:    item.guid?.['#text']  || item.guid  || item.id || '',
      summary: item.description || item.summary?.['#text'] || item.summary || '',
    })).filter(i => i.title);
  } catch { return []; }
}

// ─── Imbalance parser ─────────────────────────────────────────────────────────

/**
 * Parse a Financial Juice MOO/MOC imbalance item.
 *
 * FJ format (title + summary joined, HTML stripped):
 *   "FinancialJuice: MOC Imbalance S&P 500: -2027 mln\nNasdaq 100: -1351 mln\n..."
 *   or for MOO:
 *   "FinancialJuice: MOO Imbalance S&P 500: +850 mln\nNasdaq 100: +520 mln\n..."
 *
 * Returns null if text is not a MOO/MOC item.
 */
function parseImbalance(text) {
  if (!/MOC Imbalance|MOO Imbalance/i.test(text)) return null;

  const type  = /MOO/i.test(text) ? 'MOO' : 'MOC';
  const clean = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();

  const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);

  // Extract S&P 500 net (mandatory)
  const spMatch = clean.match(/S&?P\s*500[:\s]+([-+]?\s*[\d,]+)\s*mln/i);
  if (!spMatch) return null;
  const spNetM = parseFloat(spMatch[1].replace(/[\s,]/g, ''));
  if (isNaN(spNetM)) return null;

  // Extract NDX net (optional)
  const ndxMatch  = clean.match(/Nasdaq\s*100[:\s]+([-+]?\s*[\d,]+)\s*mln/i);
  const ndxNetM   = ndxMatch ? parseFloat(ndxMatch[1].replace(/[\s,]/g, '')) : null;

  // Extract DJI net (optional)
  const djiMatch  = clean.match(/Dow\s*30[:\s]+([-+]?\s*[\d,]+)\s*mln/i);
  const djiNetM   = djiMatch ? parseFloat(djiMatch[1].replace(/[\s,]/g, '')) : null;

  // Mag 7 (optional)
  const magMatch  = clean.match(/Mag\s*7[:\s]+([-+]?\s*[\d,]+)\s*mln/i);
  const magNetM   = magMatch ? parseFloat(magMatch[1].replace(/[\s,]/g, '')) : null;

  // Direction: positive spNet = more buys = BUY; negative = more sells = SELL
  const direction  = spNetM >= 0 ? 'BUY' : 'SELL';
  const signal     = direction === 'BUY' ? 'CALLS' : 'PUTS';

  // Threshold by absolute S&P net
  const absM = Math.abs(spNetM);
  const threshold = absM >= 1000 ? 'GREEN' : absM >= 300 ? 'YELLOW' : 'GRAY';

  // Approx share count (SPY ~$500 reference) — used by moc-engine.js scoreConviction
  const netShares = Math.round(Math.abs(spNetM) * 1e6 / 500);

  return {
    type,
    direction,
    signal,
    threshold,
    spNetM,
    ndxNetM,
    djiNetM,
    magNetM,
    spNet:     spNetM * 1e6,
    netShares,
    lines,
    ts:        Date.now(),
    time:      etNow(),
  };
}

// ─── Signal writers ───────────────────────────────────────────────────────────

function writeSignal(imb) {
  const payload = JSON.stringify(imb, null, 2);
  const path    = imb.type === 'MOO' ? MOO_SIGNAL_PATH : MOC_SIGNAL_PATH;
  writeFileSync(path, payload);

  // Also write moc-data.json for moc-engine.js compatibility
  if (imb.type === 'MOC') {
    writeFileSync(MOC_DATA_PATH, payload);
  }
}

// ─── Display ──────────────────────────────────────────────────────────────────

function fmtNetM(m) {
  if (m == null) return null;
  const sign = m >= 0 ? '+' : '';
  const col  = m > 0 ? C.green : m < 0 ? C.red : C.gray;
  return `${col}${sign}${m.toLocaleString()} mln${C.reset}`;
}

function printImbalance(imb) {
  const line  = '  ' + '─'.repeat(60);
  const isGrn = imb.threshold === 'GREEN';
  const isYlw = imb.threshold === 'YELLOW';
  const dirCol    = imb.direction === 'BUY'  ? C.green : C.red;
  const sigBadge  = imb.direction === 'BUY'
    ? `${C.bgGreen}  📈 CALLS — BUY BIAS  ${C.reset}`
    : `${C.bgRed}  📉 PUTS — SELL BIAS  ${C.reset}`;
  const threshBadge = isGrn
    ? `${C.bgGreen}  GREEN ≥$1B  ${C.reset}`
    : isYlw
    ? `${C.bgYellow}  YELLOW $300M+  ${C.reset}`
    : `${C.gray}  GRAY <$300M  ${C.reset}`;

  console.log('\n' + line);
  console.log(`  ${C.bold}${imb.type} IMBALANCE${C.reset}  ${threshBadge}  ${C.dim}${imb.time} ET${C.reset}`);
  console.log(line);
  console.log(`  S&P 500:   ${fmtNetM(imb.spNetM)}`);
  if (imb.ndxNetM != null) console.log(`  NDX 100:   ${fmtNetM(imb.ndxNetM)}`);
  if (imb.djiNetM != null) console.log(`  Dow 30:    ${fmtNetM(imb.djiNetM)}`);
  if (imb.magNetM != null) console.log(`  Mag 7:     ${fmtNetM(imb.magNetM)}`);
  console.log(line);

  if (imb.threshold !== 'GRAY') {
    process.stdout.write('\x07');
    console.log(`\n  ${sigBadge}`);
    if (imb.type === 'MOO') {
      console.log(`  ${C.dim}Opening candle bias → ${dirCol}${imb.direction}${C.reset}${C.dim} (monitor.js will read moo-signal.json)${C.reset}`);
    } else {
      console.log(`  ${C.dim}MOC direction → ${dirCol}${imb.signal}${C.reset}${C.dim} (moc-engine.js will read moc-data.json)${C.reset}`);
    }
    if (isGrn) {
      speak(`${imb.type} imbalance. ${imb.direction === 'BUY' ? 'Green buy' : 'Green sell'} signal. $${Math.abs(imb.spNetM / 1000).toFixed(1)} billion S&P 500.`);
    }
  } else {
    console.log(`  ${C.gray}Below threshold — no trade signal${C.reset}`);
  }

  console.log('');
}

// ─── Status display ───────────────────────────────────────────────────────────

let lastStatusPrint = 0;

function printStatus(mins) {
  const now = Date.now();
  if (now - lastStatusPrint < 60_000) return;
  lastStatusPrint = now;

  const isMooWindow = mins >= 9 * 60 + 20 && mins <= 9 * 60 + 29;
  const isMocWindow = mins >= 15 * 60 + 50 && mins <= 15 * 60 + 59;

  if (isMooWindow) {
    console.log(`  ${C.cyan}[MOO]${C.reset} ${C.bold}ACTIVE WINDOW${C.reset} 09:20–09:29 ET — polling FJ RSS  ${C.dim}${etNow()}${C.reset}`);
  } else if (isMocWindow) {
    console.log(`  ${C.cyan}[MOC]${C.reset} ${C.bold}ACTIVE WINDOW${C.reset} 15:50–15:59 ET — polling FJ RSS  ${C.dim}${etNow()}${C.reset}`);
  } else if (mins < 9 * 60 + 20) {
    const rem = 9 * 60 + 20 - mins;
    console.log(`  ${C.gray}[MOO/MOC] Idle — MOO window opens in ${rem}m (09:20 ET)${C.reset}`);
  } else if (mins > 9 * 60 + 29 && mins < 15 * 60 + 50) {
    const rem = 15 * 60 + 50 - mins;
    console.log(`  ${C.gray}[MOO/MOC] Idle — MOC window opens in ${rem}m (15:50 ET)${C.reset}`);
  } else {
    console.log(`  ${C.gray}[MOO/MOC] Idle — market closed${C.reset}`);
  }
}

// ─── Dedup state ──────────────────────────────────────────────────────────────

const seenGuids  = new Set();
let mooFiredToday = false;
let mocFiredToday = false;
let lastDate      = '';

function resetIfNewDay() {
  const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  if (today !== lastDate) {
    lastDate      = today;
    mooFiredToday = false;
    mocFiredToday = false;
    seenGuids.clear();
    console.log(`\n  ${C.gray}[MOO/MOC] Daily reset — ${today} ET${C.reset}\n`);
  }
}

// ─── Main poll ────────────────────────────────────────────────────────────────

async function poll() {
  resetIfNewDay();
  const mins = etMins();

  const isMooWindow = mins >= 9 * 60 + 20 && mins <= 9 * 60 + 29;
  const isMocWindow = mins >= 15 * 60 + 50 && mins <= 15 * 60 + 59;
  const activeWindow = isMooWindow || isMocWindow;

  printStatus(mins);

  if (!activeWindow) return;

  let xml;
  try { xml = await fetchUrl(FJ_RSS_URL); }
  catch (e) {
    console.log(`  ${C.yellow}[MOO/MOC] FJ fetch failed: ${e.message}${C.reset}`);
    return;
  }

  const items = parseRSS(xml);
  for (const item of items) {
    const id = item.guid || item.title;
    if (seenGuids.has(id)) continue;
    seenGuids.add(id);

    const fullText = item.title + ' ' + (item.summary || '');
    const imb = parseImbalance(fullText);
    if (!imb) continue;

    // Enforce window: only fire MOO in MOO window, MOC in MOC window
    if (imb.type === 'MOO' && !isMooWindow) continue;
    if (imb.type === 'MOC' && !isMocWindow) continue;

    // One signal per type per day
    if (imb.type === 'MOO' && mooFiredToday) continue;
    if (imb.type === 'MOC' && mocFiredToday) continue;

    writeSignal(imb);
    printImbalance(imb);

    if (imb.type === 'MOO') mooFiredToday = true;
    if (imb.type === 'MOC') mocFiredToday = true;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.clear();
  const line = '═'.repeat(64);
  console.log(`\n${C.bold}${C.cyan}╔${line}╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║${C.reset}${C.bold}  HANK MOO/MOC ENGINE  │  Imbalance Monitor             ${C.cyan}║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚${line}╝${C.reset}\n`);
  console.log(`  Source:    Financial Juice RSS (${C.dim}~60s lag from NYSE/NASDAQ${C.reset})`);
  console.log(`  ${C.bold}Note:${C.reset}     Real-time imbalance feeds (NYSE TAQ, NASDAQ NOII) require`);
  console.log(`             paid subscriptions. FJ is the only free source.`);
  console.log('');
  console.log(`  MOO window: ${C.bold}09:20–09:29 ET${C.reset}  → writes moo-signal.json`);
  console.log(`  MOC window: ${C.bold}15:50–15:59 ET${C.reset}  → writes moc-signal.json + moc-data.json`);
  console.log('');
  console.log(`  ${C.bgGreen}  GREEN  ${C.reset} S&P 500 net ≥ $1B  — strong signal + TTS`);
  console.log(`  ${C.bgYellow}  YELLOW ${C.reset} S&P 500 net ≥ $300M — moderate signal`);
  console.log(`  ${C.gray}  GRAY   ${C.reset} S&P 500 net < $300M — noise, skip`);
  console.log('');
  console.log(`  Poll: 30s   Ctrl+C to quit\n`);

  await poll();

  setInterval(async () => {
    try { await poll(); }
    catch (e) { console.log(`  ${C.red}[MOO/MOC] Error: ${e.message}${C.reset}`); }
  }, 30_000);

  process.on('SIGINT', () => {
    console.log(`\n  ${C.gray}[MOO/MOC] Stopped.${C.reset}\n`);
    process.exit(0);
  });
}

main().catch(e => {
  console.error(`\n  ${C.red}Fatal: ${e.message}${C.reset}\n`);
  process.exit(1);
});
