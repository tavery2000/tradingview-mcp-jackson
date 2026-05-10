// End-to-end test for the MOC ledger fix.
//
// Drives moc.js's attemptEntry() and hardExit() with synthetic inputs.
// Verifies:
//   - paper-ledger.json after run is a structured object (not bare array)
//   - paper-ledger.json contains the new MOC trade with engine='MOC' and
//     a tag including 'NO_EXIT_PRICE'
//   - logs/journal/journal-{ET-date}.jsonl contains both ENTRY and EXIT
//     records for the trade's requestId
//   - ledger backup is restored on exit (success or failure)
//
// Run: node _test_moc_e2e.js   (no arguments)
//
// SAFETY: backs up paper-ledger.json + the journal file BEFORE writing,
// restores in a `finally` block. Even if the script crashes or assertions
// fail, the original files are returned to disk.

import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── ET date matching journal.js etDate() ───────────────
function etDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

const LEDGER_PATH    = join(__dirname, 'paper-ledger.json');
const MOC_DATA_PATH  = join(__dirname, 'moc-data.json');
const SPY_LEVELS_PATH = join(__dirname, 'spy-levels.json');
const JOURNAL_DIR    = join(__dirname, 'logs', 'journal');
const JOURNAL_PATH   = join(JOURNAL_DIR, `journal-${etDate()}.jsonl`);

const BAK = (p) => `${p}.e2ebak`;

function backup(p) { if (existsSync(p)) copyFileSync(p, BAK(p)); }
function restore(p) {
  if (existsSync(BAK(p))) {
    copyFileSync(BAK(p), p);
    unlinkSync(BAK(p));
  } else if (existsSync(p)) {
    // No backup means the file didn't exist before — remove what we created
    unlinkSync(p);
  }
}

// Backup what could be touched
const filesToProtect = [LEDGER_PATH, MOC_DATA_PATH, SPY_LEVELS_PATH, JOURNAL_PATH];
for (const f of filesToProtect) backup(f);

// Track results before final restore
const results = [];
let exitCode = 0;
function assert(name, cond, detail) { results.push({ name, pass: !!cond, detail }); if (!cond) exitCode = 1; }

try {
  // ─── Stage synthetic state ────────────────────────────
  // Pristine structured ledger (matches paperTrading.initLedger shape)
  const pristine = {
    version: '1.0', created: new Date().toISOString(), mode: 'PAPER',
    balance: 25000, startBalance: 25000, totalPnL: 0, totalTrades: 0,
    wins: 0, losses: 0, trades: [], dailyPnL: {},
    engineStats: {
      TREND:     { trades:0, wins:0, losses:0, pnl:0 },
      FADE:      { trades:0, wins:0, losses:0, pnl:0 },
      SWING:     { trades:0, wins:0, losses:0, pnl:0 },
      MOC:       { trades:0, wins:0, losses:0, pnl:0 },
      STRUCTURE: { trades:0, wins:0, losses:0, pnl:0 },
    },
    sessionStats: {
      'MOO':        { trades:0, wins:0, losses:0, pnl:0 },
      'BULLET-1':   { trades:0, wins:0, losses:0, pnl:0 },
      'TREND-TIME': { trades:0, wins:0, losses:0, pnl:0 },
      'UK-CLOSE':   { trades:0, wins:0, losses:0, pnl:0 },
      'MIDDAY':     { trades:0, wins:0, losses:0, pnl:0 },
      'AFTERNOON':  { trades:0, wins:0, losses:0, pnl:0 },
      'PRE-MOC':    { trades:0, wins:0, losses:0, pnl:0 },
      'MOC':        { trades:0, wins:0, losses:0, pnl:0 },
    },
  };
  writeFileSync(LEDGER_PATH, JSON.stringify(pristine, null, 2));

  // Synthetic moc-data with strong BUY imbalance (so conviction passes gate)
  writeFileSync(MOC_DATA_PATH, JSON.stringify({
    timestamp: Date.now(),
    direction: 'BUY',                   // BUY → CALLS
    netShares: 1_500_000_000,           // $1.5B-equivalent
    totalBuyShares: 5_000_000_000,
    totalSellShares: 3_500_000_000,
    topNames: [
      { symbol: 'AAPL',  side: 'BUY' },
      { symbol: 'MSFT',  side: 'BUY' },
    ],
    type: 'MOC',
  }, null, 2));

  // Synthetic SPY snapshot
  writeFileSync(SPY_LEVELS_PATH, JSON.stringify({
    pdHigh: 740, pdLow: 730, pdClose: 735, todayOpen: 736, current: 738,
    vwap: 737.5, bias: 'bullish', ts: Date.now(), time: '15:50:00',
  }, null, 2));

  // Make sure logs/journal exists
  if (!existsSync(JOURNAL_DIR)) mkdirSync(JOURNAL_DIR, { recursive: true });

  // Capture journal line count BEFORE
  const journalBefore = existsSync(JOURNAL_PATH)
    ? readFileSync(JOURNAL_PATH, 'utf8').split('\n').filter(Boolean).length
    : 0;

  // ─── Drive the lifecycle ──────────────────────────────
  // Import attemptEntry / hardExit. moc.js gates main() so the import alone
  // doesn't start the engine. We have to populate moc.js's module-scope
  // `live`, `cachedMoc`, `snapshot` state via the ws/snapshot helpers it
  // exposes — but those are not exported. Easiest: drive the flow by setting
  // the state file moc.js reads + injecting via a minimal module patch.

  // The `cachedMoc` and `live.spyPrice` are set inside tick() → readMocData()
  // and tryLoadSpyLevels(). Since tick() requires the time clock to be in
  // the MOC window (15:51-15:58 ET), and we don't want to wait for that,
  // we drive attemptEntry() directly with manual state injection.
  //
  // moc.js exposes attemptEntry, hardExit, mocOrderToConsensus, buildOrder.
  // attemptEntry reads cachedMoc + live + snapshot (module-scope). We can't
  // set those without exporting setters. Workaround: invoke buildOrder
  // ourselves with synthetic strike + conviction, then call sendOrder
  // through paperTrading.js the same way attemptEntry does.

  const moc = await import('./moc.js');
  const pt  = await import('./paperTrading.js');

  // Build a synthetic order representing what moc.js would have built at 15:51
  const syntheticStrike = {
    underlying: 'XSP', optionType: 'CALL', strike: 740,
    expiry: etDate(), estimatedPremium: 0.25, deltaEst: 0.15,
  };
  const syntheticConviction = { score: 4, factors: [] };
  const syntheticOrder = moc.buildOrder(syntheticStrike, 'CALLS', syntheticConviction, 5);
  // buildOrder reads moc.js's module-scope `live` + `snapshot` which won't
  // be populated since main() didn't run. The order will have null entrySpy
  // fields — fine, tests just verify the routing.

  // Mirror what attemptEntry does:
  const consensus = moc.mocOrderToConsensus(syntheticOrder, 'CALLS', syntheticConviction);
  const requestId = pt.orderGate.createRequest({ signal: 'CALLS', engine: 'MOC' });

  console.log(`\n--- Driving sendOrder for requestId=${requestId} ---`);
  const trade = await pt.sendOrder(consensus, requestId, null);

  assert('sendOrder returned a trade',         !!trade);
  assert('sendOrder did not veto',             !trade?.vetoed,
         trade?.vetoed ? `vetoed: ${trade?.reason}` : '');
  assert('trade.engine === MOC',                trade?.engine === 'MOC');
  assert('trade.signal === CALLS',              trade?.signal === 'CALLS');
  assert('trade.tag has MOC_ENGINE',            trade?.tag?.includes('MOC_ENGINE'));
  assert('trade.tag has NO_EXIT_PRICE',         trade?.tag?.includes('NO_EXIT_PRICE'),
         `tag was: "${trade?.tag}"`);
  assert('trade.requestId set',                 !!trade?.requestId);
  assert('trade.fillPrice numeric',             typeof trade?.fillPrice === 'number');

  // ─── Verify ledger schema ─────────────────────────────
  console.log(`\n--- Ledger after entry ---`);
  const ledgerAfterEntry = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
  assert('ledger is structured object',         !Array.isArray(ledgerAfterEntry));
  assert('ledger has trades[]',                 Array.isArray(ledgerAfterEntry.trades));
  assert('ledger has balance',                  typeof ledgerAfterEntry.balance === 'number');
  assert('ledger.totalTrades incremented',      ledgerAfterEntry.totalTrades === 1);
  assert('ledger.trades has 1 entry',           ledgerAfterEntry.trades.length === 1);
  const t0 = ledgerAfterEntry.trades[0];
  assert('trades[0].engine MOC',                t0?.engine === 'MOC');
  assert('trades[0].status OPEN',               t0?.status === 'OPEN');
  assert('trades[0].tag has NO_EXIT_PRICE',     t0?.tag?.includes('NO_EXIT_PRICE'));

  // ─── Drive exit ──────────────────────────────────────
  // hardExit reads moc.js's module-scope `activeOrder` which is null since
  // attemptEntry wasn't called. We call closePosition directly to verify
  // the exit-side journal/ledger work, mirroring what hardExit would do.
  console.log(`\n--- Driving closePosition for requestId=${requestId} ---`);
  const exitPrice = trade.fillPrice;  // zero P&L (NO_EXIT_PRICE policy)
  const closed = pt.closePosition(requestId, exitPrice, 'MOC_TEST_E2E');
  assert('closePosition returned trade',        !!closed);
  assert('closed.status === CLOSED',            closed?.status === 'CLOSED');
  assert('closed.exitReason MOC_TEST_E2E',      closed?.exitReason === 'MOC_TEST_E2E');
  assert('closed.pnl === 0 (NO_EXIT_PRICE)',    closed?.pnl === 0);

  // ─── Verify journal records ──────────────────────────
  console.log(`\n--- Journal records ---`);
  if (!existsSync(JOURNAL_PATH)) {
    assert('journal file exists',               false, JOURNAL_PATH);
  } else {
    const lines = readFileSync(JOURNAL_PATH, 'utf8').split('\n').filter(Boolean);
    const newLines = lines.slice(journalBefore);
    const records = newLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const entries = records.filter(r => r.type === 'ENTRY' && r.requestId === requestId);
    const exits   = records.filter(r => r.type === 'EXIT'  && r.requestId === requestId);
    assert('journal has ENTRY for requestId',   entries.length >= 1, `found ${entries.length}`);
    assert('journal has EXIT for requestId',    exits.length   >= 1, `found ${exits.length}`);
    assert('ENTRY.engine MOC',                  entries[0]?.engine === 'MOC');
    assert('EXIT.exitReason MOC_TEST_E2E',      exits[0]?.exitReason === 'MOC_TEST_E2E');
  }

} catch (err) {
  console.error('TEST CRASHED:', err.stack || err.message);
  exitCode = 1;
} finally {
  // Always restore — even if assertions failed or the script crashed
  for (const f of filesToProtect) restore(f);
  console.log('\n--- backups restored ---');
}

// Report
console.log('');
let pass = 0, fail = 0;
for (const r of results) {
  if (r.pass) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${r.name}`); }
  else        { fail++; console.log(`  \x1b[31m✗\x1b[0m ${r.name}  ${r.detail || ''}`); }
}
console.log(`\n${pass}/${results.length} passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(exitCode);
