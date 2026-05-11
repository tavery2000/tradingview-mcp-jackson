/**
 * pine-poll.js — CDP-based Pine alert poller
 *
 * Pine-as-Primary architecture, alternative to TradingView webhook alerts.
 * Connects to TradingView Desktop via CDP (port 9222), reads the Pine
 * indicator's BUY/SELL labels every POLL_INTERVAL_MS, detects newly-printed
 * labels (by label ID), and POSTs them to the local webhook server.
 *
 *   TradingView Pine indicator → labels drawn on chart
 *                              ↓ (CDP poll every 15s)
 *   pine-poll.js               → diffs label IDs, detects new BUY/SELL
 *                              ↓ HTTP POST
 *   webhook-server.js (:9001)  → tier sizing + sendOrder → paper-ledger
 *
 * Why this exists instead of TradingView webhook alerts:
 *   - No 2FA / paid-plan friction
 *   - No ngrok tunnel
 *   - Works for any TradingView account tier
 *   - Direct read of the Pine indicator's actual on-chart labels
 *
 * Cost: ~15s polling latency between Pine label fire and HANK trade.
 * Suitable for chart-engine signals that fire on barstate.isconfirmed
 * (the labels are already a confirmed-close event, so 15s delay on top
 * of that is acceptable for swing/scalp trades on 1M+ timeframes).
 *
 * Run: node pine-poll.js
 *      POLL_MS=10000 node pine-poll.js       (override interval)
 *      WEBHOOK_URL=http://localhost:9001/pine-alert node pine-poll.js
 *
 * Prerequisites:
 *   - TradingView Desktop running with --remote-debugging-port=9222
 *   - smc-pro-futures Pine indicator loaded on the active chart
 *   - webhook-server.js running on :9001
 */

import { connect, evaluate } from './src/connection.js';
import { getPineLabels } from './src/core/data.js';

const POLL_INTERVAL_MS = parseInt(process.env.POLL_MS ?? '15000', 10);
const WEBHOOK_URL      = process.env.WEBHOOK_URL ?? 'http://localhost:9001/pine-alert';
const STUDY_FILTER     = 'SMC Pro Futures'; // Pine indicator's title substring
const MAX_SEEN_PER_STUDY = 200;             // cap memory growth on label ID set

// ─── State ────────────────────────────────────────────────────────────────────

// study_name → Set of label IDs already seen (and skipped or already traded)
const seenLabels = new Map();
let pollCount = 0;
let lastSymbol = null;

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

/**
 * Parse a Pine label's text into a tradeable signal payload.
 * Returns null for structural labels (HH/HL/LH/LL/CHoCH/BOS/◆/L) we don't trade.
 *
 * Labels from smc-pro-futures.pine that we DO trade:
 *   "BUY"  → CALLS (filled-style confirmed signal label)
 *   "SELL" → PUTS  (filled-style confirmed signal label)
 *
 * Labels we IGNORE:
 *   HH/HL/LH/LL  — structure markers (just visual)
 *   CHoCH/BOS    — structural event markers (already absorbed into BUY/SELL fires)
 *   ◆            — liquidity sweep markers
 *   L            — §12 LIVE intra-bar markers (would need separate handling)
 *   h/l/Z        — §14 HL/LH and §10 zone-break (would need separate handling)
 */
function parseLabelToSignal(label) {
  const text = (label.text || '').trim();
  if (text === 'BUY')  return { direction: 'CALLS', engine: 'BUY',  confidence: 'MEDIUM' };
  if (text === 'SELL') return { direction: 'PUTS',  engine: 'SELL', confidence: 'MEDIUM' };
  return null;
}

async function getActiveSymbol() {
  try {
    // Probed 2026-05-11 — `activeChart()` is not a method on the widget.
    // mainSeries().symbol() returns e.g. "AMEX:SPY", "NASDAQ:QQQ", "AMEX:IWM".
    return await evaluate(`window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().symbol()`);
  } catch { return null; }
}

async function getLastPrice() {
  try {
    return await evaluate(`
      (function() {
        var bars = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
        var last = bars.lastIndex();
        var v = bars.valueAt(last);
        return v ? v[4] : null;
      })()
    `);
  } catch { return null; }
}

async function postToWebhook(payload) {
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

function trimSeenSet(set) {
  if (set.size <= MAX_SEEN_PER_STUDY) return;
  // Drop oldest half (Set preserves insertion order)
  const items = [...set];
  const dropCount = items.length - Math.floor(MAX_SEEN_PER_STUDY / 2);
  set.clear();
  for (let i = dropCount; i < items.length; i++) set.add(items[i]);
}

// ─── Poll cycle ───────────────────────────────────────────────────────────────

async function pollOnce() {
  pollCount++;
  const sym = await getActiveSymbol();
  if (sym !== lastSymbol) {
    if (lastSymbol !== null) console.log(`  [POLL] chart switched: ${lastSymbol} → ${sym}`);
    lastSymbol = sym;
  }

  const instrument = inferInstrument(sym);
  if (!instrument) {
    if (pollCount % 12 === 1) console.log(`  [POLL] ${etTime()} ET — active symbol "${sym}" not in tradeable set (SPY/QQQ/IWM/ES/NQ), skipping`);
    return;
  }

  const price = await getLastPrice();
  if (!price || price <= 0) {
    console.log(`  [POLL] ${etTime()} ET — no price for ${sym}, skipping`);
    return;
  }

  const labelsResp = await getPineLabels({ study_filter: STUDY_FILTER, verbose: true, max_labels: 100 });
  if (!labelsResp?.success || labelsResp.studies.length === 0) {
    if (pollCount % 12 === 1) console.log(`  [POLL] ${etTime()} ET — Pine indicator "${STUDY_FILTER}" not found on ${sym}. Is it loaded?`);
    return;
  }

  const study = labelsResp.studies[0];
  let seen = seenLabels.get(study.name);
  if (!seen) { seen = new Set(); seenLabels.set(study.name, seen); }

  let newCount = 0, newBuy = 0, newSell = 0;
  for (const label of study.labels) {
    if (!label.id) continue;
    if (seen.has(label.id)) continue;

    // New label — mark seen
    seen.add(label.id);
    newCount++;

    const sig = parseLabelToSignal(label);
    if (!sig) continue; // structural label (HH/HL/...) — ignored
    if (sig.direction === 'CALLS') newBuy++; else newSell++;

    const payload = {
      instrument,
      direction:  sig.direction,
      engine:     sig.engine,
      confidence: sig.confidence,
      price,
      alertName:  `${sig.engine} signal (CDP poll, label ${label.id})`,
    };

    console.log(`  [PINE-POLL] NEW ${sig.direction} on ${instrument} — label="${label.text}" id=${label.id} price=${price}`);

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

  trimSeenSet(seen);

  if (pollCount % 4 === 0 || newCount > 0) {
    console.log(`  [POLL] #${pollCount} ${etTime()} ET ${sym} $${price} | total seen ${seen.size} | new this poll: ${newCount} (BUY ${newBuy}, SELL ${newSell})`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function seedExistingLabels() {
  console.log('[PINE-POLL] seeding existing labels (will not be traded as "new")...');
  const labelsResp = await getPineLabels({ study_filter: STUDY_FILTER, verbose: true, max_labels: 100 });
  if (!labelsResp?.success || labelsResp.studies.length === 0) {
    console.log('[PINE-POLL] no existing labels to seed');
    return;
  }
  for (const study of labelsResp.studies) {
    const ids = new Set(study.labels.filter(l => l.id).map(l => l.id));
    seenLabels.set(study.name, ids);
    console.log(`[PINE-POLL] seeded ${ids.size} labels in "${study.name}"`);
  }
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  HANK Pine CDP Poller                                                ║');
  console.log('║                                                                      ║');
  console.log(`║  Poll interval: ${String(POLL_INTERVAL_MS).padEnd(8)} ms                                          ║`);
  console.log(`║  Webhook URL:   ${WEBHOOK_URL.padEnd(54)}║`);
  console.log(`║  Study filter:  "${STUDY_FILTER.padEnd(53)}"║`);
  console.log('║                                                                      ║');
  console.log(`║  Started ${etTime()} ET                                                 ║`);
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log('');

  await connect();
  console.log('[PINE-POLL] connected to TradingView via CDP');

  const sym = await getActiveSymbol();
  const price = await getLastPrice();
  console.log(`[PINE-POLL] active chart: ${sym} @ $${price}`);

  await seedExistingLabels();

  console.log('[PINE-POLL] entering poll loop...');
  setInterval(pollOnce, POLL_INTERVAL_MS);
}

main().catch(err => {
  console.error('[PINE-POLL] fatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
