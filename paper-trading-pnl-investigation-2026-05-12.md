# Paper Trading P&L Investigation — 2026-05-12

**Trigger:** Operator dashboard shows IWM paper P&L of **+$28,284** today on a single 1-contract IWM $282 PUT position closed at TARGET ~09:34 ET. Operator suspects calculation bug.

**Verdict at a glance:**

| Question | Answer |
|---|---|
| Is the $28,284 IWM P&L correct or a bug? | **BUG — confirmed.** Exit was recorded as the underlying ETF price (282.59) instead of the option premium. Real P&L should be ~$37 (per the second IWM trade fired 10s later through a different code path). |
| Is the 1437W / 2L SPY counter today-only or cumulative? | **Cumulative.** Across all sessions since the ledger was first created. Today's actual SPY result: 1 trade, -$12.08, 1L. |
| Which file / line is the bug? | **`monitor-iwm.js:956`** (and **`monitor-qqq.js:959`** — same bug). The SPY equivalent (`monitor.js:2287-2298`) was previously fixed; the fix was never propagated to the QQQ and IWM monitors. |

---

## 1. The actual IWM trade record (today's ledger)

Two IWM PUTS trades fired ~10 seconds apart on the same setup. Both labeled `engine: SWING`, both labeled `exitReason: TARGET`, both 1 contract, both `fillPrice: 0.1207`. Different exit prices:

| Trade | timeET | exitPrice | pnl | Math | Code path |
|---|---|---:|---:|---|---|
| #1 | 09:30:29 | **282.59** | **+$28,246.93** | (282.59 - 0.1207) × 1 × 100 = $28,247 | **BUG** — `monitor-iwm.js:956` passes `swingState.exitPrice` (= underlying price) directly to `closePosition` |
| #2 | 09:30:39 | 0.49 | +$36.93 | (0.49 - 0.1207) × 1 × 100 = $36.93 | Correct — went through a path that converted underlying → option (most likely `paperTrading.js:1281` `_evalLiveSignal` internal path that uses option-price math, since the IwmSwingEngine state was already reset after Trade #1 closed) |

Trade #1's exitPrice of **282.59 is the IWM underlying price at target hit**, not an option premium. Option premiums for an SPY/QQQ/IWM ATM put expiring same-day trade in the $0.05-$2.00 range, never $200+.

The "$28,247 phantom profit" is `(underlying_price - option_entry_premium) × 100`, treating the underlying ETF price as if it were an option premium.

---

## 2. The buggy code path

### `monitor-iwm.js:954-958` — BUGGY (and `monitor-qqq.js:957-961` is identical)

```js
function executeSwingExit(swingState) {
  if (!closePosition || !activeSwing.IWM.requestId || activeSwing.IWM.status !== 'OPEN') return;
  closePosition(activeSwing.IWM.requestId, swingState.exitPrice, swingState.exitReason);
  activeSwing.IWM = { requestId: null, status: null };
}
```

`swingState.exitPrice` is set elsewhere in the IwmSwingEngine state machine to `state.target` — the **underlying ETF price** at which the target triggers. It's never converted to an option premium before being passed to `closePosition`.

`closePosition` (`paperTrading.js:503`) treats the second argument as the option exit price and computes:

```
pnl = (exitPrice - fillPrice) × contracts × 100
```

When `exitPrice = 282.59` and `fillPrice = 0.1207`, the math produces $28,247.

### `monitor.js:2282-2298` — FIXED (SPY path, the template for the bug fix)

```js
function executeSwingExit(instrument, swingState) {
  if (!closePosition) return;
  const active = activeSwing[instrument];
  if (!active?.requestId || active.status !== 'OPEN') return;

  // swingState.exitPrice is the underlying ETF price — convert to option premium estimate
  // using delta approximation so closePosition gets an option price, not an underlying price
  const SWING_DELTA    = 0.50;
  const underlyingMove = (swingState.exitPrice ?? active.entry) - (active.entry ?? 0);
  const dirMult        = swingState.direction === 'LONG' ? 1 : -1;
  const optionEst      = Math.max(0.01, (active.optionEntry ?? 0.10) + underlyingMove * dirMult * SWING_DELTA);
  const optionExitPrice = parseFloat(optionEst.toFixed(4));

  closePosition(active.requestId, optionExitPrice, swingState.exitReason);
  ...
}
```

The SPY path converts underlying → option using a 0.50 delta approximation, then passes the option-space estimate to `closePosition`. The IWM and QQQ paths skip this conversion entirely.

---

## 3. Why didn't I notice this earlier?

- SPY rarely fires SWING trades during typical sessions, and the bug doesn't appear when fillPrice is the same order of magnitude as exitPrice (i.e., when both are option premiums). SPY's fix predates Path 2 simplification.
- Most of today's PnL exposure today is on the Pine-as-Primary path (Pine → webhook → paperTrading.sendOrder → exits via paperTrading internal logic), which uses option-price math throughout and doesn't share the SWING engine's underlying-price exit math.
- The SWING engine is ALIVE on monitor-iwm.js and monitor-qqq.js (per the executeSwingEntry pattern around line 916 of each file). It is NOT gated by `PINE_PRIMARY` because PINE_PRIMARY only blocked `executeScalpSignal` dispatch, not `executeSwingEntry`. SWING continues to fire trades and was never reviewed for the underlying-vs-option-price exit conversion when the SPY version was fixed.

---

## 4. The 1437W / 2L counter mystery

Dashboard reads `lg.trades` directly and computes wins/losses across the whole array. Quick check:

```
SPY closed trades in ledger:  1439
  wins:                       1437
  losses:                     2
```

These numbers come from the entire history of `paper-ledger.json` (created weeks ago, persists across sessions). There is no date filter applied. The 1437W is the cumulative SPY result since paper trading began.

For today only, the SPY result is:
- 1 SWING trade (SPY $738 CALLS, entry $0.1308, exit $0.01, **STOP**, -$12.08).

The dashboard is conflating cumulative SPY all-time with today's per-instrument display — that's the visual issue. The data underneath is real; only the labeling/filtering is wrong.

---

## 5. Sanity check — the $28,284 against realistic options pricing

Operator's mental check: "IWM ATM ODTE put on a 1-2 point move = $50-300/contract typical."

- IWM 282 PUT at 09:30 was trading at ~$0.12 (per the ATR fallback estimate)
- IWM moved from ~283 down to ~282.59 (a ~$0.40 underlying drop)
- A 0.50-delta put would gain roughly $0.20 in option premium ($0.40 × 0.50 delta)
- Expected option exit: ~$0.32 (0.12 + 0.20)
- Expected per-contract P&L: ($0.32 - $0.12) × 100 = **$20** per contract
- With 1 contract: ~$20 P&L would be the realistic number

The second IWM trade in the ledger (exitPrice $0.49, pnl $36.93) is within sanity-check range — it represents about $0.37 of option premium gain, which is consistent with a 1-point underlying drop and a 0.40-0.50 delta put.

**Math sanity confirms Trade #1's $28,247 is impossible; Trade #2's $36.93 is plausible.**

---

## 6. Tier-cap audit (was sizing the bug, or just the exit math?)

Sizing was correct:

- Tier: T1 (Foundation, $25k account)
- Contracts: 1 (matches Tier 1 cap: `contracts.low/mid/high = 1/2/3`)
- finalConfidence: 0.425 → maps to "low" band (below 0.65 actually returns 0; this should have vetoed but didn't because SWING engine uses its own sizing path that bypasses `confidenceBand`)

The contract count is fine. The bug is purely in the exit-price math, not the entry sizing.

(Side note: SWING engine bypassing the `confidenceBand` gate at finalConfidence 0.425 is a separate issue — `tier.js:94` says `if (finalConfidence < 0.65) return null; // below gate`. SWING shouldn't be firing at 0.425. Flag for follow-up, not today's bug.)

---

## 7. Impact assessment

**Today's contaminated numbers** (all are wrong because of the bug):

- IWM today P&L: **+$28,283.86** (actual ~$57 across both IWM trades; one buggy, one correct)
- Account balance: **$55,002.78** (should be ~$26,775 — close to the $26,753 start)
- SWING engineStats.pnl: **+$28,182.84** (mostly contaminated by today's bug)
- Today's `dailyPnL`: **+$28,249.64**

**Ledger keeps the contamination** until either:
1. The bug is fixed AND the ledger is manually corrected to back out the phantom $28,247
2. The trade is deleted from the ledger and replayed correctly

**Tier-up risk:** at $55k balance, this would normally signal eligibility for T1→T2 promotion. Don't promote — equity is fake.

---

## 8. Open questions / follow-ups

1. **Why did Trade #2 hit the correct exit path?** Both are labeled engine=SWING, exitReason=TARGET, but only Trade #1 went through the buggy `monitor-iwm.js:956` path. Most likely: after Trade #1 closed, `activeSwing.IWM.requestId` was reset to null at line 957, so when Trade #2's exit fired, `executeSwingExit`'s guard returned early. Trade #2 then closed via `paperTrading.js:1281` `_evalLiveSignal` internal path, which uses option-price math correctly. Worth confirming this hypothesis but not load-bearing for the bug fix.

2. **Should SWING engine fire at finalConfidence 0.425?** `tier.js:94` says no. SWING is bypassing this gate. Separate bug, much lower magnitude (would just prevent the trade from existing).

3. **Are there other unfixed sister-file divergences?** The pattern (SPY fixed, QQQ/IWM not) suggests other fixes may have the same problem. Worth a sweep for `monitor.js` → `monitor-qqq.js`/`monitor-iwm.js` parity audits.

---

## 9. Recommended fix scope (NOT shipped here — investigation only)

The fix is a one-time copy-paste of the `monitor.js:2282-2298` `executeSwingExit` logic into `monitor-iwm.js:954-958` and `monitor-qqq.js:957-961`. Each file needs:

- Read `active.entry` (or equivalent — the underlying entry price stored on the activeSwing record) — note `activeSwing.IWM` and `activeSwing.QQQ` only store `optionEntry`, NOT the underlying `entry`. The fix needs to also persist `entry` (underlying) to the activeSwing record at entry time.
- Convert underlying move to option-space via delta approximation
- Pass the option-space exit price to `closePosition`

Estimated: ~15 LOC per monitor file, plus 1-2 LOC to capture `entry` in `activeSwing` at entry time. Total ~30-35 LOC across both files.

**Operator decision needed:**
1. Disable SWING dispatch on QQQ and IWM (set a flag) until the fix ships
2. Manually correct the ledger to back out the phantom $28,247 from today
3. Ship the fix now (would require restarting monitor-iwm.js / monitor-qqq.js during market hours)
4. All of the above

Pure investigation per task spec — no fix shipped here.
