/**
 * pine-poll.js — CDP-based Pine signal poller (v4 — cumulative counters)
 *
 * Reads monotonically-increasing fire counters from the SMC Pro Futures
 * Pine indicator. Each fire-type has a `var int` counter that increments
 * on every signal fire. CDP poller reads counters every 2s. When a
 * counter increases by N, N new fires happened since last poll.
 *
 * Robust to: label-id rotation, bar_index normalization, flag-plot
 * 0→1→0 race conditions. Counters never decrease, always reflect total
 * fires from session start, and are readable on any live bar.
 *
 * Pine-side requirement: smc-pro-futures.pine must have the v2 counter
 * block (see "CDP POLLER COUNTERS — 2026-05-11 (v2 cumulative)").
 *
 * Run:
 *   SYMBOL=SPY node pine-poll.js                    # log-only (default)
 *   LOG_ONLY=false SYMBOL=SPY node pine-poll.js     # enable webhook posts
 *   POLL_MS=1000 SYMBOL=SPY node pine-poll.js       # 1-second polling
 */

import CDP from 'chrome-remote-interface';

const POLL_INTERVAL_MS = parseInt(process.env.POLL_MS ?? '2000', 10);
const WEBHOOK_URL      = process.env.WEBHOOK_URL ?? 'http://localhost:9001/pine-alert';
const SYMBOL_FILTER    = (process.env.SYMBOL ?? 'SPY').toUpperCase();
const STUDY_FILTER     = 'SMC Pro Futures';
const LOG_ONLY         = (process.env.LOG_ONLY ?? 'true').toLowerCase() !== 'false';
const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

// Counter definitions — Pine title → direction + engine
const COUNTERS = [
  { key: 'BuyFireCount',       direction: 'CALLS', engine: 'BUY'  },
  { key: 'SellFireCount',      direction: 'PUTS',  engine: 'SELL' },
  { key: 'BullZoneBreakCount', direction: 'CALLS', engine: 'ZONE' },
  { key: 'BearZoneBreakCount', direction: 'PUTS',  engine: 'ZONE' },
  { key: 'BullHLCount',        direction: 'CALLS', engine: 'HL'   },
  { key: 'BearLHCount',        direction: 'PUTS',  engine: 'LH'   },
  { key: 'LiveBuyCount',       direction: 'CALLS', engine: 'LIVE' },
  { key: 'LiveSellCount',      direction: 'PUTS',  engine: 'LIVE' },
];

// ─── State ────────────────────────────────────────────────────────────────────

let pollClient    = null;
let activeSymbol  = null;
const prevCounts  = {};
let pollCount     = 0;
let pollInFlight  = false;
let firstPollDone = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function etTime() {
  return new Date().toLocaleTimeString('en-US', { timeZone:'America/New_York', hour12:false });
}

function inferInstrument(symbol) {
  if (!symbol) return null;
  const s = symbol.toUpperCase();
  if (s.includes('SPY')) return 'SPY';
  if (s.includes('QQQ')) return 'QQQ';
  if (s.includes('IWM')) return 'IWM';
  if (s.includes('ES1!') || s === 'ES') return 'ES';
  if (s.includes('NQ1!') || s === 'NQ') return 'NQ';
  return null;
}

function parseCount(raw) {
  if (raw == null || raw === '' || raw === '∅') return 0;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

async function evaluateOnTab(client, expression) {
  const res = await client.Runtime.evaluate({ expression, returnByValue: true });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'eval err');
  }
  return res.result?.value;
}

async function getSymbolOnTab(client) {
  try {
    return await evaluateOnTab(client, `window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().symbol()`);
  } catch { return null; }
}

async function getLastPriceOnTab(client) {
  try {
    return await evaluateOnTab(client, `(function(){
      var bars = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
      var last = bars.lastIndex();
      var v = bars.valueAt(last);
      return v ? v[4] : null;
    })()`);
  } catch { return null; }
}

function buildGetCountersJS(studyFilter) {
  const filter = String(studyFilter || '').replace(/'/g, "\\'");
  return `
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
        var sources = chart.model().model().dataSources();
        for (var si = 0; si < sources.length; si++) {
          var s = sources[si];
          if (!s.metaInfo) continue;
          try {
            var meta = s.metaInfo();
            var name = meta.description || meta.shortDescription || '';
            if (!name) continue;
            if ('${filter}' && name.indexOf('${filter}') === -1) continue;
            var values = {};
            var dwv = s.dataWindowView();
            if (dwv) {
              var items = dwv.items();
              if (items) {
                for (var i = 0; i < items.length; i++) {
                  var item = items[i];
                  if (item._title) values[item._title] = item._value;
                }
              }
            }
            return { name: name, values: values };
          } catch(e) {}
        }
        return null;
      } catch(e) { return { error: e.message }; }
    })()
  `;
}

async function getCountersOnTab(client, studyFilter) {
  return await evaluateOnTab(client, buildGetCountersJS(studyFilter));
}

async function postToWebhook(payload) {
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

// ─── Target selection ─────────────────────────────────────────────────────────

async function listChartTabs() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  return targets.filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
}

async function findTabForSymbol(symbolSubstring) {
  const tabs = await listChartTabs();
  console.log(`[PINE-POLL] enumerating ${tabs.length} TradingView chart tabs (looking for "${symbolSubstring}")...`);
  for (const tab of tabs) {
    let testClient = null;
    try {
      testClient = await CDP({ host: CDP_HOST, port: CDP_PORT, target: tab.id });
      await testClient.Runtime.enable();
      const symbol = await getSymbolOnTab(testClient);
      console.log(`  - tab ${tab.id.substring(0, 8)}: symbol=${symbol}`);
      if (symbol && symbol.toUpperCase().includes(symbolSubstring)) {
        await testClient.Page.enable();
        await testClient.DOM.enable();
        return { tab, client: testClient, symbol };
      }
      await testClient.close().catch(() => {});
    } catch (e) {
      console.log(`  - tab ${tab.id.substring(0, 8)}: ERROR ${e.message}`);
      if (testClient) await testClient.close().catch(() => {});
    }
  }
  return null;
}

// ─── Fire handler ─────────────────────────────────────────────────────────────

async function fireSignal(counter, instrument, price, delta) {
  console.log(`  [PINE-POLL] ${etTime()} ${counter.key} +${delta} → ${counter.direction} on ${instrument} @ $${price}`);

  if (LOG_ONLY) {
    console.log(`  [PINE-POLL]   (LOG_ONLY=true — webhook not called)`);
    return;
  }

  const payload = {
    instrument,
    direction:  counter.direction,
    engine:     counter.engine,
    confidence: counter.engine === 'BUY' || counter.engine === 'SELL' ? 'MEDIUM' : 'MEDIUM',
    price,
    alertName:  `${counter.engine} ${counter.direction} (counter+${delta})`,
  };
  try {
    const resp = await postToWebhook(payload);
    if (resp.ok) {
      console.log(`  [PINE-POLL]   → webhook FILLED reqId=${resp.reqId}`);
    } else {
      console.log(`  [PINE-POLL]   → webhook BLOCKED reason=${resp.reason ?? 'unknown'}`);
    }
  } catch (e) {
    console.error(`  [PINE-POLL]   → webhook ERROR: ${e.message}`);
  }
}

// ─── Poll cycle ───────────────────────────────────────────────────────────────

async function pollOnce() {
  if (!pollClient) return;
  pollCount++;
  const instrument = inferInstrument(activeSymbol);
  if (!instrument) return;

  const study = await getCountersOnTab(pollClient, STUDY_FILTER);
  if (!study || study.error) {
    if (pollCount % 30 === 1) console.log(`  [POLL] ${etTime()} — read error: ${study?.error}`);
    return;
  }

  const price = await getLastPriceOnTab(pollClient);

  // First poll: seed prev counts, don't fire
  if (!firstPollDone) {
    const seedSummary = {};
    for (const c of COUNTERS) {
      const v = parseCount(study.values[c.key]);
      prevCounts[c.key] = v;
      seedSummary[c.key] = v;
    }
    console.log(`[PINE-POLL] seeded counters:`, JSON.stringify(seedSummary));
    const missing = COUNTERS.filter(c => study.values[c.key] === undefined);
    if (missing.length > 0) {
      console.error(`[PINE-POLL] WARNING — missing counters: ${missing.map(m => m.key).join(', ')}`);
      console.error(`[PINE-POLL] Pine indicator may not be the v2 cumulative-counter version. Re-paste?`);
    }
    firstPollDone = true;
    return;
  }

  // Detect counter increases
  let totalFires = 0;
  for (const c of COUNTERS) {
    const prev = prevCounts[c.key] ?? 0;
    const curr = parseCount(study.values[c.key]);
    if (curr > prev) {
      const delta = curr - prev;
      await fireSignal(c, instrument, price, delta);
      totalFires += delta;
    }
    prevCounts[c.key] = curr;
  }

  // Heartbeat every 30 polls (= 60s @ 2s) or when fires happen
  if (pollCount % 30 === 0 || totalFires > 0) {
    const summary = COUNTERS.map(c => `${c.key}=${prevCounts[c.key]}`).join(' ');
    console.log(`  [POLL] #${pollCount} ${etTime()} ET ${activeSymbol} $${price} | fires this poll=${totalFires} | ${summary}`);
  }
}

async function pollSerial() {
  if (pollInFlight) return;
  pollInFlight = true;
  try { await pollOnce(); }
  catch (e) { console.error(`  [POLL] error: ${e.message}`); }
  finally { pollInFlight = false; }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  HANK Pine CDP Poller (v4 — cumulative counters)                    ║');
  console.log(`║  SYMBOL filter:  ${SYMBOL_FILTER.padEnd(53)}║`);
  console.log(`║  Poll interval:  ${String(POLL_INTERVAL_MS).padEnd(53)}║`);
  console.log(`║  Webhook URL:    ${WEBHOOK_URL.padEnd(53)}║`);
  console.log(`║  LOG_ONLY:       ${String(LOG_ONLY).padEnd(53)}║`);
  console.log(`║  Started ${etTime()} ET                                                 ║`);
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log('');

  if (LOG_ONLY) {
    console.log('[PINE-POLL] LOG_ONLY mode: detections logged, webhook NOT called.');
    console.log('[PINE-POLL] To enable webhook posts, restart with LOG_ONLY=false');
    console.log('');
  }

  const result = await findTabForSymbol(SYMBOL_FILTER);
  if (!result) {
    console.error(`[PINE-POLL] could not find chart tab matching "${SYMBOL_FILTER}"`);
    process.exit(1);
  }
  pollClient   = result.client;
  activeSymbol = result.symbol;
  console.log(`[PINE-POLL] locked onto tab — symbol ${activeSymbol}`);

  console.log(`[PINE-POLL] entering poll loop (every ${POLL_INTERVAL_MS}ms)...`);
  setInterval(pollSerial, POLL_INTERVAL_MS);
}

main().catch(err => {
  console.error('[PINE-POLL] fatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
