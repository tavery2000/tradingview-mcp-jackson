# Ledger Fix Plan — Task 2 Part A

**Status:** investigation complete, awaiting approval before code changes.

**Summary in one sentence:** Replace `moc.js`'s direct ledger write with calls to `paperTrading.sendOrder()` / `closePosition()`. No `paperTrading.js` changes needed — its schema already supports `engine: 'MOC'`.

---

## Investigation findings

### `paperTrading.js` — public API

| Export | Line | Role |
|---|---:|---|
| `orderGate`           | 282  | Singleton OrderGate (request-ID dedup) |
| **`sendOrder(consensus, requestId, lastQuote)`** | **314** | **Entry path. Builds the trade record, simulates fill, locks the ledger, writes, calls `jEntry(trade)`** |
| **`closePosition(requestId, exitPrice, exitReason)`** | **488** | **Exit path. Locks the ledger, computes P&L, updates wins/losses/balance/dailyPnL/engineStats/sessionStats, calls `jExit(trade)`, runs tier check** |
| `evaluateOpenPositions(priceFeeder)` | 654 | per-poll theta tracking |
| `getScorecard()` / `printScorecard()` / `assessGoLiveCriteria()` / `sessionReset()` / `logDecision()` / `generateDailyReport()` / `startLiveTrading()` | 799…1546 | reporting + admin |

### Trade-record schema — what `sendOrder` writes (line 430-447)

```js
{
  // From `consensus` arg
  requestId, signal, engine, session, instrument, strike, type, side,
  contracts, limitPrice, confidence, ts, timeET, mode,
  // From `simulateFill`
  fillPrice, fillTime, fillTimeET, slippage, slippagePct, bid, ask, mid, paper,
  // Lifecycle
  status: 'OPEN', exitPrice: null, exitTime: null, pnl: null,
  // Optional pass-through (consensus.* if present)
  tag, w3Score, tickVal, vwapDist, sessionWindow, context,
  // Auto-attached
  tier, finalConfidence, entryIV, entryUnderlying,
}
```

### Entry vs exit — single function call each

- **Entry:** `sendOrder()` is one call. It internally creates the trade, simulates fill, writes to the ledger under lock, and calls `jEntry(trade)` itself (line 472). Caller does NOT call `jEntry`.
- **Exit:** `closePosition()` is one call. It locks, finds the open trade by `requestId`, computes P&L, updates aggregates, writes, calls `jExit(trade)` itself (line 559), and runs tier-state updates. Caller does NOT call `jExit`.

### Engine='MOC' is already supported

`paperTrading.js:101` (in `initLedger()`):
```js
engineStats: {
  TREND:     { trades:0, wins:0, losses:0, pnl:0 },
  FADE:      { trades:0, wins:0, losses:0, pnl:0 },
  SWING:     { trades:0, wins:0, losses:0, pnl:0 },
  MOC:       { trades:0, wins:0, losses:0, pnl:0 },     // ← already here
  STRUCTURE: { trades:0, wins:0, losses:0, pnl:0 },
},
```

**No `paperTrading.js` schema changes required.** This is a one-side fix in `moc.js`.

### `moc.js` order-firing path (audit § 2.1 confirmed)

| Line | Function | What it does |
|---:|---|---|
| 314 | `buildOrder(strike, direction, conviction, contracts)` | Constructs the MOC-style order object (id, source, underlying='XSP', optionType, strike, action='BUY_TO_OPEN', conviction, hardExitAt, entrySpyPrice, entrySpyDelta, snapshotBias) |
| **337-348** | **`writeLedger(order)`** | **Reads `paper-ledger.json` as a bare array, `.push(order)`, writes back. `existsSync ? JSON.parse(...) : []` — assumes array, will silently corrupt the structured object that `paperTrading.js` writes** |
| 351-358 | `updateLedger(orderId, updates)` | Same bare-array assumption. Only used at hard-exit (line 536) to flip `status: 'CLOSED'` |
| 591 | `attemptEntry()` calls `writeLedger(order)` | The single entry call |
| 536 | `hardExit(reason)` calls `updateLedger(activeOrder.id, { status: 'CLOSED', closeTime, closeReason })` | The single exit call. **Does NOT compute or store P&L** — moc.js exits today produce zero accounting |

### Other side effects fired around moc.js's order

| Side effect | Location | After fix |
|---|---|---|
| Console banner ("ORDER SUBMITTED TO PAPER LEDGER") | `printDecision` line 494 | Keep — pure display |
| Beep `\x07\x07` | line 495 | Keep — pure display |
| `logStat('trade', ...)` to `hank_stats.json` | line 595 | Keep for now — separate stats file used by MOC dashboard. Audit § 2.5 lists `hank_stats.json` as single-writer, no race |
| `logStat('exit', ...)` to `hank_stats.json` | line 537 | Keep — same |
| Active re-score loop (`rescoreTimer`) | line 601 | Keep — pure logic, no ledger writes |
| TTS / wsServer broadcasts at the order moment | none found in moc.js | n/a |

### `moc.js` journal calls today (audit confirmed)

```
42:import { journal, jAlert, jError } from './journal.js';
562:  jAlert('moc-ivr-block', ...)
566:  jAlert('moc-ivr-missing', ...)
568:  jError('moc-ivr', ...)
```

- **Zero** calls to `jEntry`, `jExit`, `jSignal`, `jPoll`, `jGateBlock`.
- The `journal` raw export is imported but never used — orphan import (will leave as-is to keep diff scoped).

### Audit § 2.1 recommendation

> **Option 1.** Have `moc.js` import `sendOrder` / `closePosition` from `paperTrading.js` (the same way the three monitors already do) so all writes go through the locked writer.

This plan implements Option 1 verbatim.

---

## A) Routing approach

### A.1 Entry — `moc.js` `attemptEntry()` will replace `writeLedger(order)` with `sendOrder()`

**Inside `moc.js` (somewhere around line 591), replace:**
```js
if (order && writeLedger(order)) {
  activeOrder = order;
  ...
```
**with:**
```js
if (order) {
  const consensus = mocOrderToConsensus(order, expectedDir, conviction);
  const requestId = orderGate.createRequest({ signal: consensus.signal, engine: 'MOC' });
  const trade     = await sendOrder(consensus, requestId, /* lastQuote */ null);
  if (trade && !trade.vetoed) {
    activeOrder = { ...order, requestId, fillPrice: trade.fillPrice };
    ...
```

The rest of `attemptEntry` (set state, schedule rescore timer, logStat) stays identical. Only the ledger write is rerouted.

### A.2 `mocOrderToConsensus` field-by-field mapping

| `consensus` field (paperTrading) | Source from `moc.js` `order` | Notes |
|---|---|---|
| `signal`             | `expectedDir` (`'CALLS'` \| `'PUTS'`) | direct |
| `engine`             | literal `'MOC'`                       | matches initLedger key |
| `instrument`         | `order.underlying` (`'XSP'`)           | sendOrder defaults to `'SPX'` if missing — must pass explicitly |
| `strike`             | `order.strike`                         | direct |
| `entryPrice`         | `order.limitPrice` (≈0.25)             | used by `simulateFill` |
| `confidence`         | derived: `score >= 4 ? 'HIGH' : 'MEDIUM'` | string label |
| `finalConfidence`    | derived: `conviction.score / 5` (so a 3 → 0.60, 5 → 1.00) | numeric, used by `getPositionSize` for tier sizing |
| `contracts`          | `order.contracts` (CONTRACTS lookup, 0–6) | passed as override; `sendOrder` will cap by `Math.min(contracts, tierSize)` |
| `underlyingPrice`    | `live.spyPrice`                        | used for `entryIV` calc |
| `tag`                | `'MOC_ENGINE'`                         | analogous to `'FADE_EXPERIMENT_PRE10'` |
| `context`            | `{ conviction: order.conviction, snapshotBias: order.snapshotBias, entrySpyPrice: order.entrySpyPrice, entrySpyDelta: order.entrySpyDelta, mocSource: order.source }` | catch-all for MOC-specific data — preserved on the trade record |
| `sessionWindow`      | `'MOC'`                                | matches sessionStats key |
| `w3Score, tickVal, vwapDist` | not set (n/a for MOC)         | sendOrder accepts undefined, stores as null |

**Fields dropped (MOC-only, not preserved on the new trade record):**
- `id` (`'MOC-<ts>'`) — replaced by `requestId` (paperTrading-style)
- `action` (`'BUY_TO_OPEN'`) — paperTrading uses `side: 'BUY'` (auto-set)
- `optionType` (`'CALL'`/`'PUT'`) — paperTrading uses `type: 'call'/'put'` (auto-derived from signal)
- `expiry` — **not currently in paperTrading's trade schema**. Acceptable loss because MOC is always 0DTE (the audit doesn't flag this). If desired, can be tucked into `context.expiry`.
- `hardExitAt: '15:59 ET'` — engine-internal knowledge, not needed on trade record
- `entryTime` (etNow string) — replaced by `fillTimeET` (auto-set by `simulateFill`)
- `deltaEst` — not in paperTrading schema. Tucked into `context.deltaEst`.

**Fields gained (newly populated on every MOC trade):**
- `requestId, fillPrice (real, from simulateFill), fillTime, slippage, bid, ask, mid, paper, tier, finalConfidence, entryIV, entryUnderlying, lastSaved` (from paperTrading's full schema)

### A.3 Exit — `moc.js` `hardExit()` will replace `updateLedger(...)` with `closePosition()`

**Inside `moc.js` `hardExit()`, replace:**
```js
if (activeOrder) {
  updateLedger(activeOrder.id, { status: 'CLOSED', closeTime: etNow(), closeReason: reason });
  logStat('exit', { orderId: activeOrder.id, reason, time: etNow(), date: etDate() });
  activeOrder = null;
}
```
**with:**
```js
if (activeOrder?.requestId) {
  // Exit price: best available is the entry fill price (zero P&L) — moc.js
  // doesn't track live option premium today. Computing real exit pricing is
  // a follow-up task; this fix gets the lifecycle recorded correctly.
  const exitPrice = activeOrder.fillPrice ?? 0;
  closePosition(activeOrder.requestId, exitPrice, `MOC_${reason.replace(/\s+/g, '_').toUpperCase().slice(0, 30)}`);
  logStat('exit', { orderId: activeOrder.requestId, reason, time: etNow(), date: etDate() });
  activeOrder = null;
}
```

### A.4 Imports in `moc.js`

Add to the existing imports:
```js
import { sendOrder, closePosition, orderGate } from './paperTrading.js';
```

(Plus noting: `paperTrading.js` already imports `tier.js`, `theta.js`, `journal.js` — no transitive surprises.)

---

## B) `moc.js` changes — diff summary

| Action | Lines | Code |
|---|---|---|
| **Add** import | 1 line near line 42 | `import { sendOrder, closePosition, orderGate } from './paperTrading.js';` |
| **Add** helper `mocOrderToConsensus(order, expectedDir, conviction)` | ~15 lines | Pure mapping function, placed below `buildOrder` (line 335) |
| **Replace** the body of `writeLedger(order)` (lines 337-348) | -11 / +0 | **Delete the function entirely.** No callers remain after the next change. |
| **Delete** `updateLedger(orderId, updates)` (lines 351-358) | -7 / +0 | No callers remain after the hardExit change. |
| **Modify** `attemptEntry()` ledger-write block (line 591 region) | -3 / +9 | Replace `if (order && writeLedger(order)) { activeOrder = order;` with the `sendOrder(consensus, requestId, null)` block from § A.1 |
| **Modify** `hardExit()` exit block (lines 535-541) | -4 / +6 | Replace `updateLedger(...)` with `closePosition(activeOrder.requestId, exitPrice, reason)` per § A.3 |
| **Make `attemptEntry` async** | +1 char (`async`) | Required because `sendOrder` is async |
| **Add `await`** at the call site of `attemptEntry()` | +1 word | Find the caller (probably in `tick()` near line 616) and add `await` |

**Total expected diff:** roughly **-25 / +30 lines** in `moc.js`. Net delta around +5 lines, scope contained to the order-firing path.

---

## C) `paperTrading.js` changes

**NONE.**

- `engine: 'MOC'` already in the initLedger schema (line 101).
- `sendOrder` already accepts arbitrary `instrument` strings (e.g. `'XSP'`) without modification.
- The default `lastQuote` parameter already handles the null case (line 314 signature, line 136 fallback).
- `consensus.context` is preserved through to the trade record (line 442).
- `closePosition` already handles arbitrary `exitReason` strings.
- All journal hooks (`jEntry`, `jExit`) and tier hooks already fire from inside paperTrading.js without caller involvement.

This is a single-file change in `moc.js`.

---

## D) Journal changes

After the fix:

- **`jEntry` will fire** automatically when `sendOrder()` records the MOC trade (paperTrading.js:472).
- **`jExit` will fire** automatically when `closePosition()` records the MOC close (paperTrading.js:559).
- **No double-journaling risk** — `moc.js` does not call `jEntry`/`jExit` today and won't be adding any. The fix only adds calls *into* `paperTrading.js`, which has the journal calls baked in.
- The existing `jAlert`/`jError` calls in `moc.js` (IVR gating, errors) remain — they're orthogonal to the trade lifecycle.

ASK HANK side effect: `pnl` and `signals` commands will start showing MOC trades immediately because they read `paper-ledger.json` (now correctly structured) and `journal-{ET-date}.jsonl` (now containing the ENTRY/EXIT records).

---

## E) Risk assessment

### E.1 Things that won't survive the routing (acceptable)

- **`order.id`** of form `'MOC-<ts>'` — replaced by paperTrading's `requestId`. `logStat` previously used `order.id` to track the order in `hank_stats.json`; we now use `requestId` instead. ASK HANK's `moc` command reads `hank_stats.moc.{trades,exits}` so the orderId field name shows up there. Cosmetic only.
- **`order.expiry`** (date string) — not a field in paperTrading's trade record. Tuck into `context.expiry` so it isn't lost.
- **`order.deltaEst`** — same. Tuck into `context.deltaEst`.

### E.2 Existing data integrity

- The MOC engine **fires at most once per day** (`tradeToday` flag, line 522 + 545). One entry, one exit. No multi-position rollups to worry about.
- `paper-ledger.json` is currently in **structured-object form** (paperTrading.js wrote it). After the fix, MOC trades will be appended to `.trades[]` — schema-correct. No data migration needed.
- The lock file (`acquireLock`/`releaseLock` in paperTrading.js) is process-shared via the filesystem — moc.js will use the same lock automatically through the imported functions.

### E.3 Real exit pricing — known follow-up

- `closePosition` computes P&L as `(exitPrice - fillPrice) × 100 × contracts`. Today, moc.js doesn't track a live exit option price.
- The plan passes `exitPrice = activeOrder.fillPrice` (zero P&L). **This is intentionally lossy** — better to record the lifecycle correctly with $0 P&L than to leave the ledger schema-broken.
- A real exit price would require either (a) a live Webull chain pull at exit, or (b) a delta-1 estimate from the live SPY price vs entry SPY price. Both are follow-up work, not part of this fix.

### E.4 Order-of-operations during the edit

The fix is one-shot — no intermediate broken state because:
- Test data: any pre-existing `paper-ledger.json` written as a bare array would already be broken; the audit notes the file currently appears in structured form (since paperTrading.js wrote it last). If a stale bare-array file existed, `loadLedger()` would fail JSON-parse and fall back to `initLedger()` — which is also a structured object. So even pathological starting state recovers cleanly.
- Single-engine fire-once-a-day scope means no interleaving of old + new code paths during the same day.

### E.5 Async propagation

- `sendOrder()` is `async`. `attemptEntry` (currently sync) becomes async.
- `attemptEntry`'s caller is `tick()` (around line 616). `tick` is already async.
- The `setInterval`'s rescore handler (line 601) calls `evaluateExit` (sync) and `hardExit` (sync). `hardExit` will now call `closePosition` which is **synchronous** (line 488 `export function closePosition(...)` — no async). No await needed there.

---

## F) Test plan

Three layers, in increasing fidelity:

### F.1 Smoke test of the routing helper (offline, fastest)

After Task 2-B lands, write `_test_moc_route.js`:
```js
import { mocOrderToConsensus } from './moc.js';   // export added by the fix
const order = {
  underlying: 'XSP', optionType: 'CALL', strike: 5847,
  limitPrice: 0.25, contracts: 3,
  conviction: 4, entrySpyPrice: 5840, entrySpyDelta: 1500,
  snapshotBias: 'bullish', source: 'MOC_ENGINE',
};
const consensus = mocOrderToConsensus(order, 'CALLS', { score: 4 });
console.log(consensus);
// Expected: { signal:'CALLS', engine:'MOC', instrument:'XSP', strike:5847,
//             entryPrice:0.25, contracts:3, confidence:'HIGH',
//             finalConfidence:0.8, underlyingPrice:5840, tag:'MOC_ENGINE',
//             sessionWindow:'MOC', context:{conviction:4, snapshotBias:'bullish', ...} }
```
Asserts the field mapping is correct.

### F.2 End-to-end with mocked state (medium, no real time travel needed)

Add `_test_moc_e2e.js`:
1. Backup current `paper-ledger.json` to `.bak`.
2. Write a minimal structured `paper-ledger.json` (pristine `initLedger()` shape).
3. Write a minimal `moc-data.json` with a strong BUY imbalance.
4. Write a minimal `spy-levels.json` snapshot.
5. Call moc.js's `attemptEntry()` directly (requires the function to be exported; small additional change in 2-B if not already).
6. Read the resulting `paper-ledger.json` — assert `trades[0].engine === 'MOC'`, `trades[0].status === 'OPEN'`, `trades[0].requestId` non-null.
7. Read today's journal — assert at least one `type: 'ENTRY'` record with `engine: 'MOC'`.
8. Call `hardExit('test')`.
9. Re-read ledger — assert `trades[0].status === 'CLOSED'`, `pnl === 0`, `exitReason` starts with `'MOC_'`.
10. Re-read journal — assert at least one `type: 'EXIT'` record with the same `requestId`.
11. Restore `.bak`.

This validates the entire round-trip without waiting for 15:50 ET.

### F.3 Live dry-run (highest fidelity, best for Sunday/Monday)

Run moc.js on Monday 2026-05-11 between 15:45-15:59 ET with `TRADING_MODE=PAPER`. Verify in real-time:
- Entry banner prints
- `paper-ledger.json` gains a structured MOC entry (no array corruption)
- `logs/journal/journal-2026-05-11.jsonl` contains both ENTRY and EXIT records for the requestId
- ASK HANK's `pnl` and `signals` commands surface the MOC trade

If any of those checks fail, `git revert <task-2-hash>` rolls back cleanly to today's state.

---

## Summary

- **One file changes:** `moc.js` (~25 lines deleted, ~30 added).
- **Zero changes:** `paperTrading.js`, `journal.js`, `tier.js`, schema, ledger format.
- **Two functions added/modified in moc.js:** new `mocOrderToConsensus` mapper; existing `attemptEntry` becomes async with new sendOrder call; existing `hardExit` calls closePosition.
- **Two functions deleted in moc.js:** `writeLedger`, `updateLedger` (no callers after the fix).
- **One import added:** `{ sendOrder, closePosition, orderGate } from './paperTrading.js'`.
- **Side benefit:** MOC trades start producing ENTRY/EXIT journal records automatically — fixes the audit's secondary finding without additional code.
- **Known scope-out:** real exit-price computation. Initial fix uses entry fillPrice (zero P&L). Follow-up task can wire a live chain or delta-1 estimate.

Awaiting approval before any code changes.
