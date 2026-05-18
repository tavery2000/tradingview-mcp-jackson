# Mon 5/18 Task #0 — Gate Chain Audit

> **STATUS:** TRADING HALTED via `WEBULL_INTEGRATION_HALT=true` + `PATH2_HALT=true`
> in `.env`. Both flags must stay `true` until every item in this doc is verified
> firing in a controlled test. **Operator does not resume futures trading until then.**

> This task supersedes the "Mon 5/18 — Observation day" entry in
> [`HANK_WEEKLY_PLAN_2026-05-18.md`](HANK_WEEKLY_PLAN_2026-05-18.md). The whole
> Monday is now reserved for this audit.

---

## Context

Sunday 5/17 20:04-20:06 ET: **5 simultaneous CALLS stop-outs on a $520 paper
futures account, combined -$19,173.** Documented hard caps failed to fire.
Full briefing context in the Sunday session chat transcript.

This isn't a code-quality issue. This is the difference between HANK being a
trading system and HANK being a random-number generator that occasionally
makes money. Until the gate chain is verified watertight, futures trading
stays halted.

---

## Required actions (in order)

### 1. Gate-chain audit

For **every** gate declared in startup banner (the `[paperTrading]` lines +
the `[futuresTrading]` lines + the `[*Scheduler]` lines), verify:

- **Where** in code it's checked (file:line)
- **Which ledger** it reads (`paper-ledger.json` vs `futures-ledger.json`
  vs MCP `get_account_balance`)
- **What it gates** — entry only, position evaluation only, or both?
- **Failure-mode test** — does it actually fire under the failure
  conditions it's supposed to catch?

Output: `docs/gate-chain-audit-2026-05-18.md` with a row per gate, columns
above, plus a "verified" status.

### 2. Specific bugs to fix

| # | Bug | Fix |
|---|---|---|
| (a) | `MAX_LOSS_PER_TRADE` not enforced on futures | Wire `futuresTrading.placeFuturesOrder` to check per-trade max-loss against tier's `contracts × stopPoints × pointValue` |
| (b) | Daily-loss cap only checked on entry, not on simultaneous stop-out | Add post-evaluation halt in `futuresTrading.evaluateOpenFutures` — after each closeFuturesPosition, re-check `dailyPnL` against caps and halt further evaluations if breached |
| (c) | `CAPITAL_CAP_PER_TRADE=$10K` — notional or margin? | Pick one explicitly. Document in `.env` comment + add to `docs/gate-chain-audit-2026-05-18.md`. Enforce consistently in `paperTrading._capForInstrument` and any futures path |
| (d) | Tier sizing has no balance check | Add `MIN_BALANCE_FOR_TIER` checks: Tier A requires $20K+ account balance, Tier B requires $10K+, Tier C only at <$10K. Hard cap at 1 contract if balance < $2K. Currently a $520 account spawning Tier B 3-contract trades — that's the root cause |
| (e) | Counter-trend gate depends on `monitor.js` writing bias files; futures run 23/5 but monitor only writes during RTH | Add fallback: if `macro4H` is `UNKNOWN` OR bias file mtime stale > 15min → **BLOCK** new entries (not downweight, BLOCK). Apply in both `paperTrading.sendOrder` and `futuresTrading.placeFuturesOrder` |
| (f) | Signal-reversal gate does not read `futures-ledger.json` | Make `signalConfidence.evaluateCounterTrend` (or the signal-reversal cousin) ledger-agnostic — fire on opposite-direction futures positions too, not just options |

### 3. NEW: Circuit breaker

Universal hard rule, no bypass, operator-clear required to reset:

- **Window:** 5 minutes rolling
- **Trigger A:** > 3 closed trades in the window
- **Trigger B:** > $500 cumulative loss in the window
- **Action on either:** auto-halt all dispatch (sets `PATH2_HALT=true` +
  `WEBULL_INTEGRATION_HALT=true` programmatically); emit `CIRCUIT_BREAKER_TRIPPED`
  jAlert; surface red banner on every dashboard tab; TTS announcement
- **Clear:** operator runs `ask> clear circuit breaker` (new REPL command)
  after manual review

Implementation: new `circuitBreaker.js` module mirroring `weeklyLoss.js`
pattern. Hooked into BOTH `sendOrder` entry chain AND `closePosition` /
`closeFuturesPosition` exit hook.

### 4. Live price feed for futures-status.js

Currently reads `latest-prices.json` which is populated by `webhook-server.js`
on every inbound Pine alert. Between alerts, prices go stale. Stops, targets,
and trail computations in `futuresTrading.evaluateOpenFutures` depend on
fresh prices — without them, position management is blind.

**Fix BEFORE allowing any futures trading to resume:**
- Add periodic price refresh to `futures-status.js` OR
- New `futures-pricer.js` that polls MCP `get_futures_snapshot` every 5s
  and writes to `latest-prices.json`
- Verify via `futures-status.js` Window 9: live prices update independently
  of alert traffic

### 5. Ledger reset to clean state

Sunday's $-19,173 catastrophic loss has corrupted `futures-ledger.json`.
Reset to fresh state with operator-chosen starting balance.

**Recommendation:** $25K starting balance — matches realistic per-tier
sizing requirements after item (d) lands. Operator confirms before execution.

Implementation: backup current `futures-ledger.json` →
`futures-ledger.2026-05-17T-audit-reset.backup.json`, then write fresh
ledger with new balance via `initLedger()`.

### 6. Halt flags stay TRUE until done

- `.env` `WEBULL_INTEGRATION_HALT=true` ✓ (set 2026-05-17 EOD)
- `.env` `PATH2_HALT=true` ✓ (set 2026-05-17 EOD)
- `futuresTrading.placeFuturesOrder` rejects with `PATH2_HALT` reason ✓
  (wired in commit immediately after this doc lands)
- `webhook-server.js` rejects with `WEBULL_INTEGRATION_HALT` ✓ (existing
  global circuit-breaker)

Both flags get flipped to `false` by operator **only after item 7 below
passes**.

### 7. Replay Sunday's 9 Pine alerts in dry-run

Capture the 9 alert payloads that fired Sun 20:04-20:06 ET from the
journal. Construct a test harness that submits each payload to a
dry-run version of the dispatch chain. **Every single one must be BLOCKED.**

If even one passes — the audit isn't complete. Iterate.

Harness location: `tools/replay-sunday-alerts.js` (new file). Reads alert
payloads from `logs/journal/journal-2026-05-17.jsonl`, replays via
direct call into `placeFuturesOrder` with dry-run flag, asserts veto on
every one.

---

## Acceptance criteria

Before flipping halt flags off, all six items below must be true:

| # | Criteria | Verified by |
|---|---|---|
| 1 | Gate chain audit complete; doc filed | `docs/gate-chain-audit-2026-05-18.md` exists with every gate row populated |
| 2 | All six bugs (a-f) fixed | Per-bug fix commits + test cases in `docs/gate-chain-audit-2026-05-18.md` |
| 3 | Circuit breaker live and tested | Trigger A (4 trades in 5min) and Trigger B ($600 loss in 5min) both verified halting dispatch in a controlled test |
| 4 | Live price feed working | `futures-status.js` Window 9 shows price age < 10s consistently for at least 5 minutes |
| 5 | Ledger reset done | `futures-ledger.json` shows clean balance + 0 trades; backup file in place |
| 6 | Replay test passes | All 9 Sunday alerts rejected by dry-run harness; output captured |

Only after ALL six → `.env` flips `WEBULL_INTEGRATION_HALT=false` +
`PATH2_HALT=false` → operator authorizes resume → restart.

---

## What this work does NOT touch

- Calibration code (calibrationCache.js, calibrationScheduler.js,
  analyze-calibration.js)
- SPY/QQQ paper-options path via `paperTrading.sendOrder` (continues
  trading per its own gate chain, which the audit will verify separately
  but doesn't halt)
- IWM `RETIRED_INSTRUMENTS` gate (working)
- MOO/MOC retirement (working)
- Webull MCP wrapper internals (parked; will need attention at June 1
  flip but not for this audit)

---

## Estimated time

This is a full day's work. Operator's Mon 5/18 was scheduled as
"observation day, no code changes." That schedule is OVERRIDDEN by
this Task #0. Tuesday's `MAX_WEEKLY_LOSS` work (per weekly plan) may
slip to Wednesday if audit takes the full day.

---

## June 1 production-flip spec (operator clarification, Sun 5/17 EOD)

**MES intraday-only**, market hours 09:00-16:00 ET, **$1,000 budget**.
Avoids overnight margin entirely.

| Item | Value |
|---|---|
| Instrument | MES (only) |
| Trading window | 09:00-16:00 ET (broader than equity RTH on the AM end) |
| Account budget | $1,000 |
| Webull MES **day** margin | $267 |
| Webull MES **overnight** margin | $1,500 (avoided by hard 16:00 close) |
| Cap (margin + $1K buffer) | ~$1,267 |
| Allowed contracts under cap | floor($1267/$267) = 4 |
| Allowed contracts under sizing floor (<$10K → 1c) | 1 |
| **Effective sizing** | **1 contract per signal** |

**Code changes needed before 6/1:**

1. **Day-margin config** — current code uses overnight values
   (`FUT_OVERNIGHT_MARGIN_MES=$1500`). For 6/1 either rename to
   neutral `FUT_MARGIN_MES` or add a parallel `FUT_DAY_MARGIN_MES=$267`
   with a `FUT_MARGIN_MODE=day|overnight` selector. Recommend the
   neutral rename + operator sets per session intent.

2. **Hard intraday close gate** — currently no enforcement of "close
   all futures by 16:00 ET." Need a new module (mirror `preSwitchKill.js`
   pattern): scheduler that auto-runs `closeFuturesPosition` against
   every open MES at 15:55 ET. Plus an entry-side gate that rejects
   new entries past `FUT_INTRADAY_NO_ENTRY_AFTER_ET=15:30` to give
   stops + targets time to fire before forced close.

3. **Trading window narrowed** — current 23/5 gates allow Globex
   sessions. For 6/1 MES-only intraday, add `FUT_SESSION_START_ET=09:00`
   + `FUT_SESSION_END_ET=16:00` env vars. Operator may want to keep
   23/5 active for paper sandbox week and narrow only on 6/1 flip.

4. **Account balance reflects budget** — currently `futures-ledger.json`
   has $10,000 starting balance (Sunday reset). For 6/1, reset to $1,000
   to match real live-account budget. Backup the paper-sandbox-week
   ledger to `futures-ledger.2026-05-31-PRE-LIVE.backup.json` before
   the reset.

5. **Live-mode flag** — currently `FUTURES_TRADING_MODE=PAPER`. For
   6/1 flip to `LIVE`. The paper/live distinction in code currently
   just affects ledger labeling; need to verify it actually routes to
   real broker execution path (likely via MCP or Path 2 + Webull
   live endpoint depending on what survives the week).

**Why this matters for the audit:** items 1-2 are PREREQUISITE for
6/1 trading even being possible at $1K budget. Without day-margin
config + hard intraday close, broker rejects at $1K (under $1.5K
overnight) AND positions could carry overnight by accident. Get
these into the Tue-Thu deploy queue alongside the gate fixes.

**Operator-confirmed test premise:** *"I'm going to test your (Hank)
abilities. June 1st you will trade MES during market hours 09:00 to
16:00 (avoid margin) with a $1k budget."*

### June 1 day-to-overnight graduation criterion

**Operator addendum Sun 5/17 EOD:** *"If Hank gets over $1.5k June 1st
before close, Hank will continue trading MES overnight hours."*

Logic to wire:

- During RTH (09:00-16:00 ET): MES intraday-only with day margin $267,
  hard close at 15:55 ET
- Balance check at any close: if `ledger.balance >= 1500` → flip mode
  to overnight-eligible
- Overnight-eligible mode: cap recomputes to overnight margin ($1500)
  + $1K buffer = $2500; intraday-close gate disables; 23/5 trading
  enabled (subject to existing CME 16:59-18:00 maintenance gate)
- Once flipped, mode persists for the rest of the trading day; resets
  to intraday-only at next 09:00 ET if balance fell back below $1500
  overnight (e.g., overnight stop-out)

Implementation pattern: new module `intradayGraduation.js` (mirror
`profitProtection.js`); writes `intraday-graduation-state.json`;
exposes `isOvernightEligible()` for futuresTrading.js cap + close-gate
checks. Operator-clearable + restart-resilient.

### Head-to-head comparison context

**Operator:** *"I will be taking the same trade 'manually' alongside
Hank."* — On 6/1, operator mirrors HANK's signals manually in their
own Webull session. Goal is per-signal comparable performance:
operator's discretionary execution vs HANK's automated execution on
identical Pine alerts. Implication for instrumentation:

- Every HANK fill needs timestamp + entry price + exit price + reason
  captured cleanly for post-session reconciliation
- Operator's manual fills tracked in a separate sheet/log; reconciled
  EOD against HANK's journal
- Variance attribution: latency, slippage, calibration multiplier
  adjustments, vision overrides (when promoted), discretionary skip
  decisions (operator side)

Build a `docs/head-to-head-2026-06-01.md` template Friday 5/29 with
columns ready for operator to fill alongside HANK's auto-populated
side.

### Operator's framing

*"Hank has all the tools to accomplish this... Time to prove everyone
wrong."* — This is not a feature ship. It's a proof point. Calibrate
all decisions this week (audit fixes, deploys, sandbox validation)
against: does this make HANK more likely to win the 6/1 head-to-head?

---

*Drafted 2026-05-17 EOD after catastrophic failure observation. Halt
flags wired immediately to prevent further damage. Full audit + fixes
land Monday morning.*
