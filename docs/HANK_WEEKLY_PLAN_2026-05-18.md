# HANK Weekly Plan — Week of 2026-05-18 (REVISED 2026-05-17 17:35 ET)

> Supersedes timeline in `webull-mcp-integration-plan-2026-05-16.md` §D.2 and
> `HANK_SESSION_HANDOFF_2026-05-17.md` §7. Three changes from prior version:
> (1) Calibration multiplier+block already LIVE per operator confirmation,
> (2) Vision Phase 5 moves Sat 5/23 → Fri 5/22 17:30 ET dry-run,
> (3) Webull market-data Phase 1 lands Fri 5/22 15:00 ET with extended
> validation through Fri 20:00 ET via SPY/QQQ after-hours data.

---

## State at handoff (Sun 5/17 EOD)

- ✅ MCP CONNECTED, 47 tools, paper account `FNJQ0I41DNA99G4PHQAKTJ8CBA` pinned
- ✅ Webhook log is source of truth (REPL `mcp paper` known cross-process bug; fix Monday)
- ✅ Calibration ENFORCEMENT LIVE — `CALIBRATION_APPLY_MULTIPLIER=true` +
      `CALIBRATION_BLOCK_ENABLED=true` per operator. **MUST VERIFY against
      live .env Monday before treating as gospel.** If `.env` still reads
      `false`, the handoff doc was right and Tuesday flip stands.
- ✅ CME Sunday open 18:00 ET — first MCP-routed Pine alerts going live tonight
- ⚠ Five secrets to rotate this week (handoff §6)
- ⚠ Cosmetic .bat banner fix pending one more pull+restart (functional, not blocking)
- ⚠ Webull paper futures correction: desktop-only via Webull Futures Desktop,
      NOT mobile app (handoff doc §1 and §5 wording stale — update Monday)

## Week-at-a-glance

| Date | Headline work |
|---|---|
| Mon 5/18 | Observation day. NO code changes. Verify calibration enforcement state. Cosmetic doc fixes only. |
| Tue 5/19 | NVDA earnings. `MAX_WEEKLY_LOSS` full tiered gate implementation. |
| Wed 5/20 | MCP-Calibration integration validation. Reconcile broker audit log vs HANK journal. |
| Thu 5/21 | Spread Guard + Roll Guard auto-exec. Webull data parallel-logger added (no behavior change). |
| Fri 5/22 | THREE STAGED DEPLOYS: Webull data Phase 1 (15:00) → footprint log-only (17:15) → Vision Phase 5 dry-run (17:30). |
| Sat-Sun 5/23-5/24 | Code review only. No deploys, no data. |
| Sun 5/24 18:00 ET | First live validation of full stack under real market data |

---

## Mon 5/18 — Observation day

**Rule: NO code changes. NO deploys.** Day 3 of streak; MCP-routed paper fills
under live CME + RTH equity. Pure observation.

### Tasks (all advisory / docs-only)
1. **Verify calibration state** — `grep CALIBRATION .env`. Confirm both flags
   read `true`. If they read `false`, halt and flag to operator immediately —
   Tuesday's "calibration goes live" is the real event, not stale doc.
2. **Update handoff doc §1, §5, §7** — correct mobile-app references to
   Webull Futures Desktop; update timeline section per this doc.
3. **Memory write candidates** (operator approval required before write):
   - `feedback_webull_paper_futures_desktop_only.md` (NEW)
   - Update `project_vision_phase5_spec.md` — deploy moves to Fri 5/22 17:30 ET
   - Update calibration entry if .env confirms multiplier+block already true
4. **Fix REPL `mcp paper` cross-process bug** — known issue from Sun handoff.
   This is a doc/output fix, not a behavior change. Commit + push; operator
   pulls+restarts at end-of-day Monday only if quiet session.

### What to journal at EOD
- Total fills, blocked entries (calibration), gate trip counts
- Any FADE pattern firings (post-bugfix observation)
- Schema mismatches between `placeFuturesOrder` wrapper and actual MCP tool

---

## Tue 5/19 — NVDA earnings + MAX_WEEKLY_LOSS

NVDA earnings day. Volatile environment. Single deploy stack tonight (post-close
only per `feedback_no_mid_session_deploys.md`).

### Single deploy: `weeklyLoss.js` full tiered implementation

Currently a stub (handoff §5). Implement full rolling-7d realized P&L gate per
plan §E.8:

| Threshold | Action |
|---|---|
| -$500 | Warning + TTS. No trading change. |
| -$750 | New entries blocked (`MAX_WEEKLY_LOSS_BLOCK` gate). Existing positions exit via stops. |
| -$1,000 | Hard halt. Auto-run `kill flatten`. Set `WEBULL_INTEGRATION_HALT=true`. Operator override required to resume. |

**Implementation:**
- Reads `paper-ledger.json` + MCP `get_account_balance` for realized 7d P&L
- New state file `weekly-loss-state.json` (gitignored)
- Hook into `sendOrder` gate chain AFTER `PROFIT_PROTECTION` gate (per existing
  chain ordering in `paperTrading.js`)
- Add `journal.js` entry: `gateReason: 'MAX_WEEKLY_LOSS_*'` per tier
- Default state for fresh `.env`: warn/block/halt enforcement ON

### Validation before deploy
- Run synthetic ledger entries simulating each tier crossing
- Confirm `kill flatten` path executes through MCP `cancel_order` (not legacy)
- Verify dashboard surfaces weekly-P&L counter at top of every tab

### Deploy window
Post-close 16:15 ET. Pull + restart sequence per `start-hank.bat`. Watch
Window 1 for clean banner. Smoke test via REPL: `weekly loss state`.

---

## Wed 5/20 — Integration validation

No new layers. Verify Tue's deploys interact cleanly with calibration.

### Validation checklist
1. **Reconcile broker audit log vs HANK journal** — for every trade Tue,
   confirm:
   - Calibration decision logged in journal (`calibration_key_used`,
     `calibration_level`, `calibration_multiplier`, `calibration_action`)
   - Order submission logged in `webull-mcp-audit.log`
   - MCP fill confirmation matches journal close record
   - `weeklyLoss` gate state matches realized P&L
2. **L4/L5 fallback audit** — per calibration doc Section 3, currently 0 L1
   cells. Confirm Tue's trades still mostly hitting L4/L5. If L1 cells now
   exist (sample sizes growing), document which engines reached granularity.
3. **NVDA earnings post-mortem** — was the volatility spike captured by
   calibration's block list? Did SELL engine block (L5 PF 0.28) actually
   prevent any losing trades?

### NO code changes Wed.

---

## Thu 5/21 — Spread Guard + Roll Guard + Webull data parallel logger

Two deploys, but Webull parallel logger is purely additive (logs only, no
behavior change). Both go in same evening post-close.

### Deploy 1: Spread Guard via MCP market data
Per plan §D.2. New gate in `paperTrading.sendOrder`:
- Pre-entry: call `get_stock_snapshot(symbol)` (equity) or
  `get_futures_snapshot(symbol)` (futures)
- Compute bid-ask spread in basis points or absolute ticks
- Threshold: reject if spread > 5 bps on SPY/QQQ, > 2 ticks on ES/MES,
  > 4 ticks on NQ/MNQ (tune from journal after first week)
- Gate reason: `SPREAD_TOO_WIDE`
- Bypass flag: `SPREAD_GUARD_ENABLED=true` in .env

### Deploy 2: Roll Guard auto-execution
Currently warn-only per handoff §5. Promote to auto-execute:
- Detects futures expiry within 5 trading days
- Closes open positions in expiring contract via MCP
- Opens equivalent in front contract
- Logs `roll_event` to journal

### Deploy 3 (additive only): Webull data parallel logger
Add `--data-source=webull` flag to `monitor.js` and `monitor-qqq.js`. When
flag set:
- Continue reading CDP (TradingView) every 30s as today
- ALSO call `get_stock_snapshot(['SPY'])` (monitor.js) and
  `get_stock_snapshot(['QQQ'])` (monitor-qqq.js) every 30s in parallel
- Write paired records to `data/parallel-logger/YYYY-MM-DD.jsonl`:
  `{ts, symbol, cdp_price, cdp_vwap, webull_price, webull_vwap, delta}`
- No behavior change. CDP remains primary data source.

This sets up Friday's Phase 1 cutover with 1 day of paired data to validate
against. Flag stays OFF in committed .env; operator enables manually Thu evening.

### Deploy window
Spread Guard + Roll Guard deploy 16:15 ET. Parallel logger flag enabled
17:00 ET (after equity close — runs against AH ticks until 20:00).

---

## Fri 5/22 — THE BIG DEPLOY DAY

Three staged deploys, increasing isolation as the day progresses. Each
validates before the next deploys.

### 09:30-15:00 ET: RTH pipeline stress test
Per plan §D.2. Exercise three-tier rollback drills:
- Tier 1: `WEBULL_MCP_DISABLED=true` → confirm new entries reject, existing
  positions managed via broker-side stops
- Tier 2: Simulated 401 → confirm dashboard banner + TTS alert fires
- Tier 3: `WEBULL_INTEGRATION_HALT=true` + `kill flatten` from REPL →
  confirm all positions close via MCP, halt banner persists

Drills run on paper account only. No real Pine signals acted on during drill
windows. Drills complete by 14:30 to leave 30-min buffer to 15:00 deploy.

### 14:55 ET: Pre-deploy checkpoint
Operator review:
- Did Thu's parallel logger produce clean diff data? Outliers? Any sustained
  divergence > 0.5%?
- Are Window 1 + Window 9 healthy?
- Calibration cells refreshed at 16:30 Thu — any unexpected block additions?
- GO/NO-GO decision. Abort = postpone Phase 1 to next Friday.

### 15:00 ET: PHASE 1 DEPLOY — Webull market data primary

**Scope:** `monitor.js` (SPY) and `monitor-qqq.js` (QQQ) flip primary data
source from CDP to Webull snapshots. CDP stays as warm fallback.

**Implementation:**
- New module `webull-marketdata.js` — thin wrapper around MCP client,
  caches snapshot responses with 5s TTL to stay under 600 req/min ceiling
- `monitor.js` reads SPY via `get_stock_snapshot(['SPY'])` every 30s
- `monitor-qqq.js` reads QQQ via `get_stock_snapshot(['QQQ'])` every 30s
- VWAP + Volume Delta computed locally from `get_stock_bars` (5min) +
  `get_stock_tick` aggression-side counts
- If Webull call fails or returns stale data (> 30s old), fall back to CDP
  read transparently; log `WEBULL_DATA_FALLBACK` event
- `--data-source` flag stays accessible: `=webull` (default Fri post-deploy),
  `=cdp` (manual revert), `=parallel` (both running, Webull primary)

**Live validation window: 15:00-17:00 ET**
- 1 hour RTH equity (15:00-16:00) — highest volume validation
- 1 hour after-hours equity + live ES/NQ (16:00-17:00) — overlap window
- Watch for: snapshot latency, price drift between CDP and Webull, VWAP
  computation accuracy

### 17:00 ET: GO/NO-GO checkpoint
Operator review:
- Were CDP and Webull prices within 1 tick on every 30s read?
- Any `WEBULL_DATA_FALLBACK` events fired?
- Did locally-computed VWAP track CDP VWAP within $0.05 on SPY/QQQ?

**NO-GO action:** Set `--data-source=cdp` via env, restart monitors. Phase 1
postponed to next Friday. Investigate over weekend.

**GO action:** Proceed to Track B deploy at 17:15.

### 17:00-20:00 ET: Extended validation — SPY/QQQ AH ticks only
Futures dead during maintenance break (17:00-18:00) and through CME close
(17:00 ET Friday) until Sun 18:00. SPY/QQQ AH session runs to 20:00.
This is the lowest-volume window of the week — good stress test for
edge cases (thin orderbook, gappy ticks, no-print intervals).

If Webull snapshot returns null/stale for SPY or QQQ for > 60s during this
window, fallback fires, log it, but don't auto-revert. Operator decides at
20:00 close whether to roll back overnight.

### 17:15 ET: TRACK B DEPLOY — Futures footprint log-only

**Scope:** `monitor-es.js` and `monitor-nq.js` get
`get_futures_footprint(symbol, granularity='1m')` calls every 60s.
Writes to `data/footprint/{symbol}_YYYY-MM-DD.jsonl`. **NO signal wiring.
NO behavior change.** Pure data capture.

**Why log-only:** Footprint data has never been in HANK before. Need
minimum 2 weeks paper observation before promoting to a confidence-stacking
multiplier. Treats it with same discipline as Vision Phase 5.

**Catch:** Futures dead at 17:00 ET Friday. So the deploy ships, gets a
"connection OK" smoke test against the closed market, and first real data
arrives Sun 5/24 18:00 ET CME reopen. That's intentional — gives 2 days of
zero-traffic to discover any spawn / connection / log-rotation bugs before
real data flows.

### 17:30 ET: VISION PHASE 5 DEPLOY — DRY-RUN

**Scope:** Per `project_vision_phase5_spec.md`:
- `vision-monitor.js` — reads calibration cells + open positions +
  market structure inputs
- `visionCache.js` — L1 in-memory cache mirroring `calibrationCache.js`
  pattern, mtime-watched
- Six Vision functions per architecture deck Slide 6:
  1. Market Structure Analysis — STUBBED (constant value 0.5) until Webull
     data Phase 1 validates a week. Real wiring via `get_*_snapshot` +
     `get_futures_depth` lands Fri 5/29 if Phase 1 holds.
  2. Drawdown Governor — live, reads from paper-ledger 5d + 20d rolling
  3. Correlation Filter — live, reads open positions list from MCP
     `get_account_positions`
  4. Volatility-Normalized Sizing — live, ATR computed from `get_stock_bars`
  5. Opportunity Score — composite, logged not applied
  6. Position Size Output — DRY-RUN: writes recommendation to journal,
     does NOT override calibration's sizing decision

**Critical:** Vision opportunity scores are LOGGED ONLY. Calibration's
multiplier remains the authoritative sizing decision through at least
Fri 6/5. After 2 weeks of paired data (calibrated_size vs
vision_recommended_size), promote one or more Vision functions to live
per separate review.

**.env additions:**

```
VISION_ENABLED=true
VISION_APPLY_SIZING=false      # CRITICAL — must stay false through 6/5
VISION_LOG_OPPORTUNITY=true
VISION_DRAWDOWN_5D_LIMIT=0.08
VISION_DRAWDOWN_20D_LIMIT=0.15
VISION_CORRELATION_THRESHOLD=0.7
```

### 17:30-20:00 ET: Vision smoke validation
Vision runs alongside Phase 1 data. SPY/QQQ AH ticks feed snapshot inputs.
Confirm:
- `vision_opportunity_score` written to journal on every would-be entry
- `vision_recommended_size` differs from `calibrated_size` (sanity — if
  identical, something is wrong)
- No exceptions thrown; vision-monitor heartbeat appears in dashboard
- Cache hit rate > 80% after warmup

### 20:00 ET: Friday EOD
- Equity AH closes
- Markets fully dead until Sun 18:00 ET
- Final GO/NO-GO on Vision deploy. Two clean hours of dry-run data =
  Vision stays in for Sun reopen.
- Update memory: `project_vision_phase5_spec.md` with "deployed dry-run
  2026-05-22 17:30 ET, validation through 2026-06-05" pointer

---

## Sat 5/23 — Sun 5/24 — Quiet weekend

- NO deploys, NO data, NO code changes
- Code review only — read through week's commits, surface concerns for
  Monday handoff
- Honor `feedback_one_validation_day_per_deploy.md`: no weekend signal work

---

## Sun 5/24 18:00 ET — First live full-stack validation

CME reopens. First live data flowing through:
- Webull snapshots primary on SPY/QQQ (carries from Friday)
- ES/NQ Pine alerts route through MCP `place_futures_order` (Sunday's stack)
- Calibration enforcing multiplier+block on every entry
- Spread Guard + Roll Guard auto-active
- MAX_WEEKLY_LOSS gate live
- Vision dry-run logging opportunity scores alongside calibrated sizing
- Footprint log capturing first real ES/NQ data

**This is the highest-load validation moment of the week.** If anything
breaks, it breaks here.

### Sunday evening watch checklist
- Window 1 banner shows all stages green
- First futures Pine alert routes through MCP successfully (schema test)
- First snapshot call returns within 2s
- First footprint file appears in `data/footprint/`
- First Vision opportunity score appears in journal entry
- Cross-asset reconciliation: MCP `get_account_positions` matches HANK's
  internal open-position view

### Failure modes pre-thought
- Webull MCP child dies overnight → respawn auto-recovery, fall through to
  CDP for monitors (Phase 1 has fallback); futures execution requires MCP
  restart, no fallback
- Calibration block fires on every entry → likely a cache stale issue,
  `reload calibration` from REPL clears
- Vision throws → `VISION_ENABLED=false` env flip + restart, isolated
  to Vision module
- Footprint logging fails → non-critical, log file rotation issue;
  fix Monday post-close

---

## Hard rules for the week

1. **No mid-RTH deploys.** Friday 15:00 is RTH+1hr (RTH closes 16:00 equity),
   not mid-session. Only exception: tier-3 rollback if catastrophe.
2. **One architectural deploy per night.** Tue = weeklyLoss, Wed = none,
   Thu = spread+roll+logger (logger is additive so still one stack),
   Fri = three deploys but staggered with validation between each.
3. **Calibration is canonical sizing.** Vision is dry-run. Anyone proposing
   to flip `VISION_APPLY_SIZING=true` before Fri 6/5 needs to write a
   separate proposal doc and get operator approval.
4. **Webull paper futures = Webull Futures Desktop toggle**, not mobile app.
   Update doc references where wrong.
5. **Memory writes only after operator validation** of the decision being
   memorialized — not after AskUserQuestion alone.
6. **Rotate the 5 leaked secrets** this week (handoff §6) — operator-only
   action, separate from code work.

---

## Watch items / known issues

- REPL `mcp paper` cross-process bug — fix Monday, low priority
- Cosmetic .bat banner needs one more pull+restart — operator does at
  earliest convenience, functionally identical now
- `placeFuturesOrder` arg shape is best-effort stub — first live Pine alert
  Sunday night will tell us if it works; expect possible Monday patch
- `placeOptionSingleOrder` stub similar — wires Tue 5/19 alongside
  weeklyLoss
- Webhook supervisor timestamp drift (~50min ahead earlier today) — check
  machine clock Monday; HMAC tolerance is 5min so this could become a problem
- Defender exclusions for uvx + Python paths not yet added — operator-side
  admin task, advisory in `hank-preflight.js`

---

*Plan locked 2026-05-17 17:35 ET. Supersedes prior weekly timelines.
Pull + execute in order. Operator validation gate at each deploy boundary.*
