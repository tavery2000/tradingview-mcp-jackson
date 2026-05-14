# Scope — Path 2: MES Futures-Direct Dispatch

**Date:** 2026-05-14 (scoping)
**Target deploy:** Monday 2026-05-18 (paper-mode test, RTH session)
**Author:** Claude Code (scoping deliverable per operator request)
**Status:** SCOPE DOC. Implementation begins per operator authorization (working window: weekend 2026-05-16/17, no signal-affecting changes to existing options-dispatch path).

---

## 1. Goal

Add a parallel dispatch path for MES1! / ES1! / NQ1! / MNQ1! Pine alerts that:

1. Treats the position as a **futures contract directly** (not as an option on the future)
2. Sizes in contracts per the `mes-1k-300-daily-plan.md` tier matrix (A=5, B=3, C=1)
3. Stops in **MES index points** (3 pts Tier A/B, 2 pts Tier C) — not in % of premium
4. Targets in **MES index points** (6 pts A, 5 pts B, 3 pts C) — fixed-distance from entry
5. Records P&L as `(exit - entry) × $5/point × contracts × directionMult`
6. Operates on a **separate ledger** (`futures-ledger.json`) so it doesn't pollute the existing options ledger or its sizing/tier accounting
7. Does NOT disrupt existing options dispatch — equity (SPY/QQQ/IWM) continues unchanged

**Non-goals (out of scope for this iteration):**
- Live Webull futures order routing (paper-only initially)
- Multi-leg / spread / IRA-equivalent products
- Equity ETFs (SPY/QQQ/IWM) — those stay on options dispatch
- Replacing the existing options dispatch for futures (parallel, not replacement — operator can run both A/B if desired)

---

## 2. Architecture

```
                                            ┌─────────────────────────┐
                                            │  paperTrading.js        │
                                            │  (existing options path) │
                                  ┌──────►   │  - SPY/QQQ/IWM           │
                                  │         │  - paper-ledger.json     │
                                  │         │  - STOP_LOSS_PCT (%)     │
                                  │         └─────────────────────────┘
                                  │
TradingView Pine alert ───►  webhook-server.js
                                  │
                                  │         ┌─────────────────────────┐
                                  │         │  futuresTrading.js NEW   │
                                  └──────►   │  - MES1!/ES1!/NQ1!/MNQ1! │
                                            │  - futures-ledger.json   │
                                            │  - stop in points        │
                                            │  - P&L = pts × $5/contr  │
                                            └─────────────────────────┘

                wsServer (broadcast 'tick') ───►  futuresStopMonitor (new)
                                                  fires STOP_HIT / TARGET_HIT
                                                  → futuresTrading.closeFuturesPosition
```

**Routing decision (in webhook-server.js):**
- Instrument in `FUTURES_DIRECT_INSTRUMENTS` set (`MES1!`, `ES1!`, `NQ1!`, `MNQ1!` and bare forms) → `futuresTrading.placeFuturesOrder`
- Everything else → existing `paperTrading.sendOrder`

A single env flag controls the split: `FUTURES_DIRECT_ENABLED=true` enables the new path; if false, all instruments fall through to existing options dispatch (clean rollback).

---

## 3. File-by-file change list

### NEW: `futuresTrading.js` (~400-500 lines)

Core module. Mirrors paperTrading.js shape but sized for futures math.

```js
// Public API:
export function placeFuturesOrder(consensus, requestId)  // entry + journal
export function closeFuturesPosition(requestId, exitPrice, exitReason)  // exit + P&L + journal
export function evaluateOpenFutures(currentPriceFor)  // periodic stop/target check
export function getFuturesLedger()  // read-only accessor
export const futuresOrderGate  // dedup/serialization (matches existing orderGate pattern)
```

Internal:
- Tier resolver: maps `consensus.confidence` + `consensus.engine` + Pine signal-stacking (60-sec window) to A/B/C tier, then to contract count
- Stop/target calculator: takes entry price + tier + signal direction → `stopPrice`, `targetPrice`, `stopPoints`, `targetPoints`
- Position record schema (see §4)
- P&L calc: `(exit - entry) × INSTRUMENT_POINT_VALUE × contracts × directionMult` where MES=$5, ES=$50, MNQ=$2, NQ=$20
- Daily P&L tracking (separate from paperTrading's options dailyPnL)
- Daily target tracker (mirrors RULE 2 pattern, separate state file `futures-daily-target-state.json`)

### NEW: `futuresStopMonitor.js` (~100-150 lines)

Standalone stop-loss / take-profit monitoring loop.
- Subscribes to wsServer 'tick' broadcasts (price feed for each futures instrument)
- For each open futures position, checks current price vs stopPrice / targetPrice
- On hit: calls `futuresTrading.closeFuturesPosition` with appropriate reason
- Runs in-process with the futures dispatch (same node process as webhook-server.js — keeps state-coherent)

### MODIFIED: `webhook-server.js` (~30 lines added)

Add routing branch after existing gate checks but before paperTrading.sendOrder:
```js
const FUTURES_DIRECT_INSTRUMENTS = new Set(['MES', 'ES', 'NQ', 'MNQ', 'MES1!', 'ES1!', 'NQ1!', 'MNQ1!']);
const FUTURES_DIRECT_ENABLED = (process.env.FUTURES_DIRECT_ENABLED || 'false').toLowerCase() === 'true';

if (FUTURES_DIRECT_ENABLED && FUTURES_DIRECT_INSTRUMENTS.has(instrument)) {
  return futuresTrading.placeFuturesOrder(consensus, requestId);
}
// else: fall through to existing paperTrading.sendOrder
```

### NEW: `futures-ledger.json` schema

Independent ledger file. Same shape pattern as `paper-ledger.json` but futures-specific fields:
```json
{
  "version": "1.0",
  "created": "2026-05-18T13:30:00.000Z",
  "mode": "PAPER",
  "instruments": ["MES1!", "ES1!", "NQ1!", "MNQ1!"],
  "balance": 1000,                    // starting capital (separate from $25k options paper)
  "startBalance": 1000,
  "totalPnL": 0,
  "totalTrades": 0,
  "wins": 0,
  "losses": 0,
  "trades": [],
  "dailyPnL": {},
  "tierStats": {
    "A": { "trades": 0, "wins": 0, "losses": 0, "pnl": 0 },
    "B": { "trades": 0, "wins": 0, "losses": 0, "pnl": 0 },
    "C": { "trades": 0, "wins": 0, "losses": 0, "pnl": 0 }
  }
}
```

Per-trade record:
```json
{
  "requestId": "FUT_MES1!_BUY_177...",
  "instrument": "MES1!",
  "direction": "LONG",        // or SHORT (futures-direct, not CALLS/PUTS)
  "engine": "HTF",
  "tier": "A",                // A | B | C from sizing matrix
  "contracts": 5,
  "entryPrice": 7490.00,      // MES index points
  "entryTime": 1778773800000,
  "entryTimeET": "09:42:00",
  "stopPrice": 7487.00,       // entryPrice - 3 pts (long) or +3 (short)
  "stopPoints": 3,
  "targetPrice": 7496.00,
  "targetPoints": 6,
  "status": "OPEN",
  "exitPrice": null,
  "exitTime": null,
  "exitReason": null,         // STOP_HIT | TARGET_HIT | SIGNAL_REVERSAL | EOD_FLAT | MANUAL
  "pnl": null,                // (exit - entry) × $5/point × contracts × directionMult
  "pnlPoints": null,
  "holdMins": null,
  "win": null
}
```

### MODIFIED: `dashboard-server.js` (~30 lines added)

New endpoints:
- `GET /api/futures-positions` — open futures positions with live unrealized P&L
- `GET /api/futures-ledger` — ledger snapshot (totalPnL, dailyPnL[today], tierStats)
- `GET /api/futures-daily-target` — TARGET_REACHED state (if hit)

### MODIFIED: `journal.js` (~20 lines added)

Extend with futures-specific subtypes (or reuse existing event types with instrument-aware tagging):
- `FUT_ENTRY` (mirrors jEntry but with futures-specific fields)
- `FUT_EXIT` (mirrors jExit)
- `FUT_STOP_HIT` (distinct from FUT_EXIT for analytics — easy grep)
- `FUT_TARGET_HIT`

Choice: extend existing event types with `assetClass: 'futures'` field, OR add new event type prefixes. Recommend new prefixes for clean grep separation; estimated 4 new export functions.

### MODIFIED: `monitor.js` (~15 lines added)

Already broadcasts SPY ticks via wsServer. Need to add MES1! / ES1! / NQ1! / MNQ1! tick broadcasts so `futuresStopMonitor` has a price feed:

```js
// In monitor.js's existing CDP read loop, for each futures instrument:
if (global.wsBroadcast) {
  global.wsBroadcast('tick', { instrument: 'MES1!', price: mesPrice, ts: Date.now() });
}
```

Alternative: have `futuresStopMonitor` poll CDP directly (avoids monitor.js coupling but adds a second CDP consumer). Recommend wsServer route — single source of truth.

### MODIFIED: `.env`

```bash
# 2026-05-18: futures-direct dispatch (Path 2). When true, MES1!/ES1!/NQ1!/MNQ1!
# Pine alerts route to futuresTrading.placeFuturesOrder instead of the options
# chain. Equity (SPY/QQQ/IWM) unaffected. Default false for safe rollout.
FUTURES_DIRECT_ENABLED=false           # flip to true on Monday 5/18 startup

# Tier sizing per docs/mes-1k-300-daily-plan.md
FUT_TIER_A_CONTRACTS=5
FUT_TIER_B_CONTRACTS=3
FUT_TIER_C_CONTRACTS=1

FUT_TIER_A_STOP_POINTS=3
FUT_TIER_B_STOP_POINTS=3
FUT_TIER_C_STOP_POINTS=2

FUT_TIER_A_TARGET_POINTS=6
FUT_TIER_B_TARGET_POINTS=5
FUT_TIER_C_TARGET_POINTS=3

# Stacking-window for tier upgrades (LIVE → C; HL alone → B; HTF + 2nd same-direction
# alert within window → A)
FUT_STACKING_WINDOW_MS=60000

# $1,000 paper account
FUT_STARTING_BALANCE=1000

# Daily envelope (mirrors options-side caps but tighter for $1k account)
FUT_DAILY_TARGET=300
FUT_MAX_DAILY_LOSS=150
FUT_MAX_TRADES_PER_DAY=10
FUT_MAX_CONSECUTIVE_LOSSES=3       # → 60-min cooldown
FUT_FRIDAY_LOSS_CAP=100
```

### Optional: `tier.js` (untouched)

Existing tier.js handles the equity options account ($25k). Don't co-mingle. Futures tier sizing is .env-driven, not tier.js-driven, because the $1k account doesn't progress through Foundation/Growth/Mature tiers — it's a fixed-size strategy slot.

---

## 4. Stop/target logic — point-based math

For long entries (CALLS-equivalent):
```
stopPrice   = entryPrice - stopPoints
targetPrice = entryPrice + targetPoints
HIT_STOP    when currentPrice <= stopPrice
HIT_TARGET  when currentPrice >= targetPrice
```

For short entries (PUTS-equivalent):
```
stopPrice   = entryPrice + stopPoints
targetPrice = entryPrice - targetPoints
HIT_STOP    when currentPrice >= stopPrice
HIT_TARGET  when currentPrice <= targetPrice
```

P&L on close:
```
const dirMult = direction === 'LONG' ? 1 : -1;
const pnlPoints = (exitPrice - entryPrice) * dirMult;
const pnl = pnlPoints * INSTRUMENT_POINT_VALUE * contracts;
// MES=$5, ES=$50, MNQ=$2, NQ=$20 per index point
```

**Trailing stop** (deferred to v2; baseline is fixed stop):
- Tier A: trail to breakeven once +3 pts, trail to +50% of target once +5 pts
- Tier B: trail to breakeven once +2 pts
- Tier C: no trail
- Recommend ship without trailing in v1; add in week 2 after baseline data

---

## 5. Tier resolution (Pine signal → tier mapping)

In `futuresTrading.placeFuturesOrder`, before sizing:

```js
function resolveTier(consensus, recentSignals) {
  const engine = consensus.engine;
  const direction = consensus.signal === 'CALLS' ? 'LONG' : 'SHORT';
  
  // Check for stacking — same instrument, same direction, within FUT_STACKING_WINDOW_MS
  const cutoff = Date.now() - FUT_STACKING_WINDOW_MS;
  const sameDirectionRecent = recentSignals.filter(s =>
    s.instrument === consensus.instrument
    && s.direction === direction
    && s.ts >= cutoff
    && s.requestId !== consensus.requestId
  );
  const oppositeDirectionRecent = recentSignals.filter(s =>
    s.instrument === consensus.instrument
    && s.direction !== direction
    && s.ts >= cutoff
  );
  
  // Conflict — block (chop indicator)
  if (oppositeDirectionRecent.length > 0) {
    return { tier: null, reason: 'CONFLICT_BOTH_DIRECTIONS_WITHIN_WINDOW' };
  }
  
  // Base tier from engine
  let tier;
  if (engine === 'LIVE')                          tier = 'C';
  else if (['HL', 'LH', 'BUY', 'SELL', 'ZONE'].includes(engine)) tier = 'B';
  else if (engine === 'HTF')                       tier = 'A';
  else                                             tier = 'B';  // default
  
  // Stacking upgrade: 1 prior same-direction signal in window upgrades tier by one
  if (sameDirectionRecent.length >= 1 && tier === 'B') tier = 'A';
  if (sameDirectionRecent.length >= 1 && tier === 'C') tier = 'B';
  // Triple-stack stays at A (no SS+ tier — operator capped sizing at 5 contracts max)
  
  return { tier, contracts: TIER_CONTRACTS[tier], stopPoints: TIER_STOP[tier], targetPoints: TIER_TARGET[tier] };
}
```

Maintain a sliding-window in-memory recent-signals buffer (last 5 minutes per instrument). Persists across alerts within the same process.

---

## 6. Daily envelope enforcement

Mirror the existing options-side enforcement pattern:

| Cap | Behavior |
|---|---|
| Daily target +$300 | TARGET_REACHED alert (jAlert + TTS + state file). Trading **continues** (operator default — same as options-side RULE 2). |
| Daily hard stop -$150 | Block all new futures entries until next ET-date. Existing positions can still close via STOP/TARGET/SIGNAL_REVERSAL. Journal: `FUT_DAILY_LOSS_CAP`. |
| Max 10 trades/day | Counter increments per `FUT_ENTRY`. Block #11 with `FUT_MAX_TRADES_REACHED`. |
| Max 3 consecutive losses | After 3 losing closes in a row, set `_futCooldownUntil = now + 3600000`. Block entries with `FUT_COOLDOWN_ACTIVE` until cooldown elapses. Reset counter on next win. |
| Friday cap -$100 | If `getETDay() === 'Fri'` and `dailyPnL <= -100`, block as `FUT_FRIDAY_LOSS_CAP`. |

All caps env-tunable (FUT_*). All cap fires journal as `GATE_BLOCK` records with the corresponding `blockedBy` field.

---

## 7. Live price feed (the dependency)

Stop/target monitoring requires real-time MES1! / ES1! / NQ1! / MNQ1! prices. Two viable paths:

**Path A — wsServer subscriber (recommended):**
- monitor.js already polls TradingView CDP for SPY (and could trivially extend to other instruments)
- Add monitor.js code to read MES1! / ES1! / NQ1! / MNQ1! current prices each polling cycle (1-2 sec)
- Broadcast via `global.wsBroadcast('tick', { instrument, price, ts })`
- futuresStopMonitor subscribes to wsServer ws://localhost:8080 and processes ticks
- Latency: 1-2 sec from chart price → stop check

**Path B — direct CDP poll:**
- futuresStopMonitor opens its own CDP connection on port 9222
- Polls MES1! chart directly each second
- More independent (decouples from monitor.js) but adds a second CDP consumer (CDP allows it but adds load)

**Recommend Path A** for v1 — single CDP consumer, leverages existing infrastructure. If latency becomes an issue (1-2 sec is acceptable for 3-pt stops on MES which moves at ~0.5-2 pts/sec), upgrade to Path B in v2.

Failure mode: if wsServer feed dies, futuresStopMonitor stops receiving ticks → stops won't fire → positions ride against unbounded. Mitigation:
- Heartbeat check: if no tick received for >30 sec, log critical alert + dashboard banner
- Operator manual close via Webull as fallback
- Future: integrate stop fallback to Pine SIGNAL_REVERSAL (existing webhook path — opposite signal closes position)

---

## 8. Journal extensions

New event subtypes (or extend existing with `assetClass`):

```
FUT_ENTRY           — new futures position opened
FUT_EXIT            — closed (any reason)
FUT_STOP_HIT        — closed via stop trigger
FUT_TARGET_HIT      — closed via target trigger
FUT_DAILY_TARGET    — TARGET_REACHED (mirrors options-side TARGET_REACHED)
FUT_GATE_BLOCK      — entry rejected (cap hit, cooldown, conflict, etc.)
```

Each record includes: `instrument`, `direction (LONG|SHORT)`, `tier (A|B|C)`, `contracts`, `entryPrice`, `stopPrice`, `targetPrice`, `pnl`, `pnlPoints`, `holdMins`, `exitReason`. Operator can grep by `FUT_*` prefix for futures-only analysis.

---

## 9. Risk separation

Critical: the futures sub-account has its own:
- Ledger file (`futures-ledger.json`)
- Daily P&L tracking
- Daily target / hard-stop counters
- Tier sizing
- TTS alert namespace (`fut-target-reached-{date}`, `fut-stop-loss-{requestId}`)
- Dashboard state files

The options-side $25k account is unaffected. If futures blows up to -$150/day, options trading continues. If options has a great day, futures cap is independent.

This is the "strategy slot" model — each strategy has bounded capital and independent risk envelope. Operator can enable/disable each independently.

---

## 10. Testing & validation plan

### Pre-Monday smoke tests (run during weekend):
1. `node -e "import('./futuresTrading.js').then(...)"` → loads cleanly, banners print
2. Probe POST to webhook with MES1! payload + `FUTURES_DIRECT_ENABLED=true` → verify routes to futures path, journal records `FUT_ENTRY`
3. Probe stop hit: manually edit a test trade's stopPrice in futures-ledger.json, broadcast a tick below stop via test script, verify `FUT_STOP_HIT` fires
4. Probe target hit: same pattern, broadcast tick above target
5. Probe tier resolution: send 3 sequential signals (HTF + BUY + ZONE on MES1! within 60 sec), verify single Tier A entry (not 3 separate) — actually, verify each signal becomes its own entry but the FIRST is tier A and subsequent are tier A or B per stacking rules. (Stacking rule may need refinement based on operator preference.)
6. Probe conflict: send LONG then SHORT within 60 sec → second is rejected as `CONFLICT`
7. Daily-stop test: simulate -$150 dailyPnL via ledger edit, send new entry, verify `FUT_DAILY_LOSS_CAP` block

### Monday 5/18 RTH validation:
- Start with `FUTURES_DIRECT_ENABLED=false` (default) — verify nothing changes from Friday's behavior
- After 09:40 ET (post-EXPLORATION_WINDOW), set `FUTURES_DIRECT_ENABLED=true` and restart webhook child
- Watch for first MES1! Pine alert → verify FUT_ENTRY in journal (not options ENTRY)
- Operator monitors first 1-3 entries closely; checks stop/target prices in journal match plan
- If anything anomalous: revert FUTURES_DIRECT_ENABLED=false, kill webhook child, supervisor respawns with options-only behavior. Total rollback time: ~5 sec.

### Validation criteria (end of Monday session):
- [ ] All MES1! entries journal as `FUT_ENTRY` (not regular ENTRY)
- [ ] Each FUT_ENTRY has stopPrice, targetPrice, tier, contracts populated
- [ ] At least one stop or target hit fires `FUT_STOP_HIT` or `FUT_TARGET_HIT` correctly
- [ ] Daily P&L in `futures-ledger.json` accumulates correctly
- [ ] Equity (SPY/QQQ/IWM) signals continue routing to existing options dispatch
- [ ] Zero crashes / unhandled exceptions
- [ ] If +$300 hit: TARGET_REACHED alert fires once, trading continues
- [ ] If -$150 hit: hard stop activates, new entries blocked

---

## 11. Rollback plan

Three-layer rollback per failure severity:

**Soft rollback (config-only):**
- Set `FUTURES_DIRECT_ENABLED=false` in .env, kill webhook child
- Supervisor respawns within 2s with futures dispatch disabled
- All MES1!/ES1!/etc. signals route to existing options dispatch
- Total downtime: ~5 sec
- Existing futures positions stay open in `futures-ledger.json`; operator manually closes via Webull

**Mid rollback (revert tier mapping):**
- If tier resolution misbehaves, set all `FUT_TIER_*_CONTRACTS=1` in .env
- All entries become 1-contract scalps until proper fix ships
- Restart webhook

**Hard rollback (revert commit):**
- `git revert <commit-sha>` for the futuresTrading.js commit
- Push, restart webhook
- Total time: ~2 minutes
- Existing FUT_ENTRY records remain in journal but no new ones can be created

The futures-ledger.json file persists across rollbacks — closing existing positions remains possible via manual Webull intervention OR by re-enabling FUTURES_DIRECT_ENABLED briefly to let stops fire.

---

## 12. Estimated timeline

| Phase | Estimate | Window |
|---|---|---|
| Day 1 — futuresTrading.js skeleton (place/close/eval, ledger schema, tier resolver, daily caps) | 4-5 hrs | Saturday 5/16 morning |
| Day 1 — webhook-server.js routing + .env config + journal subtypes | 1-2 hrs | Saturday 5/16 afternoon |
| Day 2 — futuresStopMonitor.js (wsServer subscriber, stop/target check loop) | 3-4 hrs | Sunday 5/17 morning |
| Day 2 — monitor.js tick broadcast extension for futures instruments | 1 hr | Sunday 5/17 afternoon |
| Day 2 — dashboard endpoints + state files | 1-2 hrs | Sunday 5/17 afternoon |
| Day 2 — Smoke tests + dry-run validation | 2-3 hrs | Sunday 5/17 evening |
| Day 3 — Monday morning startup with FUTURES_DIRECT_ENABLED=false, manual flip after 09:40 ET | n/a (operator action) | Monday 5/18 |
| Day 3 — Monitor first session, validate, course-correct | full RTH | Monday 5/18 |

**Total dev time: ~12-17 hrs across weekend.** Conservative estimate; could compress to 8-10 hrs if no surprises.

> Per `feedback_one_validation_day_per_deploy` memory: weekend code work that lands as a Monday deploy IS validated by Monday's RTH session. This satisfies the operator's deploy-discipline rule. Working over the weekend is acceptable because nothing ships during weekend (markets closed); the Monday RTH session is the real validation event.

---

## 13. Open questions for operator

1. **Direction naming:** futures use LONG/SHORT, options use CALLS/PUTS. Do you want futures journal records to map CALLS→LONG and PUTS→SHORT (operator-readable), or preserve CALLS/PUTS (consistent with Pine alert payload format)?
2. **Webull live trading:** Path 2 ships paper-only (matches existing options paper-mode). When do you want live Webull futures order routing? Same gate pattern as options (TRADING_MODE=LIVE), or separate (FUTURES_TRADING_MODE=LIVE)?
3. **Multiple futures instruments:** plan focuses on MES1!. Do you want ES1!/NQ1!/MNQ1! enabled from day 1 with different contract counts (NQ has different point-value than MES; sizing matrix would need to scale differently), or MES1!-only for v1 with others added in v2?
4. **Alert volume:** the cap-rip means MES1! can have unlimited concurrent positions. Combined with 5 contracts/Tier A entry, an active session could see 5+ simultaneous Tier A entries = 25 contracts × $5/pt = $125/pt of exposure. Do you want a per-strategy CONCURRENT cap (e.g., max 3 open futures positions at once) or fully unlimited?
5. **Stacking rule strictness:** plan upgrades B→A on a single same-direction signal within 60 sec. Aggressive. Want stricter (require 2 same-direction within window for upgrade)?
6. **Trailing stops:** plan v1 ships with fixed stops only. Want trailing logic in v1, or wait until baseline win-rate established?

---

## 14. Summary

| Item | Value |
|---|---|
| Goal | Futures-direct dispatch path, point-based stops/targets, $1k sub-account |
| Files: new | futuresTrading.js, futuresStopMonitor.js, futures-ledger.json |
| Files: modified | webhook-server.js, monitor.js, dashboard-server.js, journal.js, .env |
| Lines of code estimate | 600-800 added, ~50 modified |
| Dev time | 12-17 hours over weekend 2026-05-16/17 |
| Test deploy | Monday 2026-05-18 RTH (paper-mode, FUTURES_DIRECT_ENABLED flip after 09:40 ET) |
| Rollback | Soft (config flag, ~5 sec), Mid (tier=1), Hard (git revert) |
| Affects existing options dispatch | NO — parallel paths, separate ledger |
| Affects equity (SPY/QQQ/IWM) | NO — those stay on options dispatch |
| Pre-deploy validation | 7-step smoke-test checklist, full validation on Monday RTH |

**Authorization confirmed**: operator-approved scoping per current-turn message. Implementation begins weekend 2026-05-16/17. No code changes in this turn — scope-only deliverable. Awaiting operator answers to §13 open questions before starting Saturday's work block.
