# MES Trading Plan — $1,000 Capital → $300/day Target

**Date:** 2026-05-14
**Author:** Claude Code (plan-only deliverable per operator request)
**Status:** PLAN DOCUMENT. Implementation deferred — current paperTrading.js routes MES1! through the options chain logic; a $1k MES-direct strategy needs a separate dispatch path (see §9).

---

## 1. The math, stated plainly

| Item | Value |
|---|---|
| Capital | $1,000 |
| Daily target (gross) | +$300 |
| Daily return required | **30%** |
| Annualized (252 days, no compounding) | 7,560% |
| Annualized (compounded) | physically meaningless in practice — drawdowns + capital constraints break the model long before then |

**Read this honestly:** $300/day on $1k is a stretch target, not an average. Markets that produce 30%-day setups happen frequently enough to make it *achievable per session*, but the long-run average will be lower. The discipline this plan enforces is: hit $300, stop. Hit -$150, stop. Don't average up the loss.

The plan below structures the trade so that $300 is reachable with a realistic combination of contract size and per-trade move, but it does NOT promise that every session will hit it. The annual P&L of this strategy depends on hit rate, drawdown control, and your own discretion to stand down on bad days — not on the structure of the plan.

---

## 2. CME MES spec recap

| Spec | Value |
|---|---|
| Contract size | $5 × S&P 500 index |
| Notional at SPX ~5,400 | ~$27,000 per contract |
| Tick size | 0.25 index points |
| Tick value | $1.25 per contract |
| Point value | $5.00 per contract |
| Day-trade margin (Webull / IBKR) | ~$40-50 per contract |
| Overnight margin (CME initial) | ~$1,386 per contract |

Implication for $1k account:
- **Intraday:** can hold up to ~20 contracts theoretically (margin only; risk caps will be tighter)
- **Overnight:** zero contracts. Plan is **day-only, flat by close**.

---

## 3. Position-sizing matrix

Three sizing tiers map to Pine signal conviction. The cap-rip from today (RULE 1) allows multiple concurrent MES1! positions, so the system can run multiple sizing tiers in parallel during trending periods.

| Tier | Contracts | Trigger | Per-tick $ | 1-pt move = | 5-pt move = |
|---|---:|---|---:|---:|---:|
| **A — Trend conviction** | 5 | HTF + BUY/SELL + ZONE confluence | $6.25 | $25 | $125 |
| **B — Standard signal** | 3 | HL / LH / single ZONE / single BUY | $3.75 | $15 | $75 |
| **C — Scalp** | 1 | LIVE engine, chop-period entries | $1.25 | $5 | $25 |

Maximum simultaneous MES1! exposure: **15 contracts** if all three tiers hit at once (3 trades × 5+3+1 each, or two A-tier + one B-tier). Day margin still under $750 — safely within $1k.

**Why these specific contract counts:**
- Tier A 5 contracts × 6-pt target = $150 per winner (one good Tier A = 50% of daily target)
- Tier B 3 contracts × 5-pt target = $75 per winner
- Tier C 1 contract × 3-pt target = $15 per winner (frequency play during chop)

Two Tier A winners ≈ daily target. Or one Tier A + two Tier B + one or two Tier C scalps.

---

## 4. Stop-loss structure (per tier)

Stops in MES points. Per-trade max risk capped at 5% of capital ($50). The system's existing `STOP_LOSS_PCT=30` (per-trade option premium stop) does NOT apply directly to futures-equivalent trading — see §9 for the implementation gap. This plan assumes a futures-side fixed-point stop.

| Tier | Contracts | Stop (points) | $ at stop | % of capital | R:R target |
|---|---:|---:|---:|---:|---:|
| A — Trend | 5 | 3 pts | $75 | 7.5% | 2:1 |
| B — Standard | 3 | 3 pts | $45 | 4.5% | 2:1 |
| C — Scalp | 1 | 2 pts | $10 | 1.0% | 1.5:1 |

**Tier A stop is intentionally larger in absolute $.** Trend setups need wider stops to avoid noise; the higher $ risk is justified by the higher target. If 7.5% per-trade risk feels too aggressive, drop Tier A to 4 contracts (stop = $60 = 6% of capital).

**Trailing stop behavior:**
- Tier A: trail to breakeven once +3 points, trail to +50% of target once +5 points
- Tier B: trail to breakeven once +2 points
- Tier C: no trail; either hit TP or hit stop

---

## 5. Take-profit structure (per tier)

| Tier | Contracts | TP (points) | $ at TP | R:R |
|---|---:|---:|---:|---:|
| A — Trend | 5 | 6 pts | $150 | 2:1 |
| B — Standard | 3 | 5 pts | $75 | 1.7:1 |
| C — Scalp | 1 | 3 pts | $15 | 1.5:1 |

**Optional scale-out** (advanced; hold off until baseline plan is validated):
- Tier A: 50% off at +4 pts ($60), 50% off at +8 pts ($120) — banks half early, lets runner trail
- Tier B: same logic at +3 pts / +6 pts

Recommend running flat single-target for the first 5 sessions to establish baseline win rate before adding scale-out complexity.

---

## 6. Daily envelope (the discipline layer)

This is the most important section. Without these caps, $300/day becomes "hope for $300/day, lose $1,000 on a bad day." With them, you get bounded outcomes and a sustainable strategy.

| Cap | Value | Action on hit |
|---|---|---|
| **Daily target (soft)** | +$300 realized | TARGET_REACHED alert (already wired). Operator decision: continue or stop. Recommended: **stop after +$300 + one optional Tier C scalp**. Trying to push to $500 on a $300 day frequently gives back to $200. |
| **Daily hard stop** | -$150 realized | All MES trading suspended for the session. Walk away. -$150 = 15% of capital — recoverable, but only if you stop. |
| **Per-trade max risk** | $75 (Tier A) / $45 (Tier B) / $10 (Tier C) | Hard stop fires. No averaging down. No "letting it work itself out." |
| **Max trades per day** | 10 | After 10 entries, stop scanning. Forces selectivity. |
| **Max consecutive losers** | 3 | After 3 losers in a row, stand down for 60 minutes. The market is telling you something. |
| **Friday-specific cap** | -$100 | Tighter Friday stop because weekend gap risk + lower-conviction fades. |

The relationship between target and stop:
- Target $300 / Stop $150 = 2:1 daily R:R
- This means even at 50% win rate on individual days, the strategy is positive expectancy
- But you must EXIT at -$150 — the discipline is the strategy

---

## 7. Time-window filter

Per HANK's existing time-of-day observations (briefing has the data), MES trends best in specific windows.

| Window (ET) | MES regime | Plan |
|---|---|---|
| 06:00-09:30 | Pre-market — futures-only window | Tier B/C only, no Tier A. Lower volume, wider spreads. |
| 09:30-09:40 | Equity exploration window | MES futures still allowed (24/5 — futures aren't subject to EXPLORATION_WINDOW gate). Tier B preferred — opening volatility favors quick scalps. |
| **09:40-11:00** | **NY morning trend — prime window** | **Tier A primary. Most aggressive sizing.** Best directional setups. |
| 11:00-13:00 | Midday chop | Tier C scalps only. Tighten stops. |
| 13:00-14:30 | European-close lull | Tier B/C. Watch for late-morning trend continuation. |
| **14:30-15:30** | **Afternoon trend** | **Tier A on confirmed reversals or trend continuation.** |
| 15:30-15:45 | MOC engine territory | Stop opening new MES trades. Let MOC engine handle close. |
| 15:45-16:00 | Closing range | Flat. No new entries. |
| 16:00+ | Overnight margin would kick in | Hard rule: flat by 15:45. No exceptions. |

---

## 8. Pine signal mapping

Mapping today's Pine alert engines (per `HANK-BRIEFING.md`) to the MES tier structure:

| Pine Signal | Engine | Tier | Notes |
|---|---|---|---|
| HTF-aligned BUY/SELL | HTF | A (with confluence) | If alone, drop to B. If stacked with BUY/ZONE same direction within 60 sec, A. |
| BUY / SELL | BUY/SELL | B (default), A (with HTF) | The chart engine's primary directional signal. |
| Bullish/Bearish Zone Break | ZONE | B (default), A (with HTF) | Breaks of structural levels. Strong trigger. |
| Bullish HL / Bearish LH | HL/LH | B | Pullback confirmations. Standard sizing. |
| LIVE Bullish/Bearish | LIVE | C | Intra-bar fires. Scalp-only — too noisy for trend size. |

**Stacking rule:** Multiple alerts on same direction within 60 seconds = upgrade tier by one level (B → A, C → B). Multiple alerts opposite direction within 60 seconds = HOLD; conflict suggests chop, no entry.

---

## 9. Implementation considerations (the gap)

**The current `paperTrading.js` routes MES1! Pine alerts through the options-chain pipeline.** Each entry buys an MES option contract priced from the option chain (or from the ATR fallback at `underlying × 0.005 × 0.4`). Stops, targets, and exit logic all operate on **option premium**, not on the underlying MES futures price.

This plan is designed for **futures-direct trading** — sizing in MES contracts (1 contract = $5/point), stops/targets in MES index points. The arithmetic is cleaner, the Greeks don't matter, and the per-trade math is predictable.

**Three implementation paths:**

**Path 1 — Plan-only, manual execution.** You read the Pine alerts on the dashboard, you place MES futures orders manually in Webull. The plan is your discipline framework. No code change required. Slowest execution but lowest implementation risk.

**Path 2 — Add a futures-direct dispatch path.** New code in webhook-server.js that detects MES1!/ES1! payloads and routes them to a new `placeFuturesOrder()` function in paperTrading.js. New ledger schema for futures (point-based P&L, not premium-based). Stops/targets in points, not %. Significant code change — estimate 2-3 days of work plus 1-2 sessions of validation.

**Path 3 — Hybrid: keep options dispatch, add point-based stops on top.** Wrap existing option fills with a parallel "underlying stop monitor" that closes the option position when the underlying hits the index-point stop level, regardless of premium %. Simpler than Path 2 (~1 day's work) but inherits the option premium pricing volatility (a 3-point underlying move can be a 50%+ premium move on near-ATM 0DTE).

**Recommendation:** Start with **Path 1**. Use the existing options dispatch for HANK's automated trades, but you place the discretionary MES futures orders manually at Webull using this plan's tier/stop/target structure. Run for 5 sessions. If the plan produces consistent results, then build Path 2.

If the operator wants to ship Path 2 or Path 3, that's a separate authorization — I can scope and estimate it as a follow-up.

---

## 10. Validation checklist (5-session baseline)

Run this plan for 5 sessions before evaluating. Track per session:

- [ ] Realized P&L vs. $300 target (hit / under / hard-stopped)
- [ ] Total trades vs. 10 cap
- [ ] Win rate (target ≥ 50% with 2:1 R:R = positive expectancy)
- [ ] Average win $ vs. average loss $ (target avg-win ≥ 2× avg-loss)
- [ ] Number of -$150 hard-stop days (target: ≤ 1 per 5 sessions)
- [ ] Tier distribution (target: A 30%, B 50%, C 20% — too much C means chop dominated; too much A means over-sizing)
- [ ] Time-window distribution (target: 60% of P&L from 09:40-11:00 + 14:30-15:30 windows)

After 5 sessions, recalibrate:
- If hitting +$300 consistently, consider raising target to $400 (don't change stop — preserve R:R)
- If averaging $100-200, plan is working but expectations were high — accept the lower number as the realistic average
- If hitting -$150 multiple times, the plan or execution needs adjustment (likely sizing too aggressive or time-window discipline weak)

---

## 11. Worst-case math (the kill scenarios)

Operator with 20 years experience knows this; documenting for completeness.

| Scenario | Outcome |
|---|---|
| 5 consecutive max-loss days (-$150 each) | Account at $250 (-75%). Strategy dead. |
| 1 catastrophic day (-$500 from over-sizing) | Account at $500 (-50%). Need 60%+ recovery in subsequent days; multi-week rebuild. |
| Average -$50/day for 20 days | Account at $0. Fully blown. |
| **Discipline failure: averaging down a Tier A loser to Tier A+B size** | Single trade can take account from $1,000 to $700. Most common kill scenario for $1k accounts. |

Mitigation: every entry is sized at decision time. Once a trade is open, **no adds, no averaging down**. The position ratchets DOWN with trailing stop, not UP.

---

## 12. Summary card (print this)

```
MES $1k PLAN — $300/DAY TARGET
─────────────────────────────────
TIER A (HTF + confluence):
  5 contracts | stop 3pt ($75) | target 6pt ($150)

TIER B (standard signal):
  3 contracts | stop 3pt ($45) | target 5pt ($75)

TIER C (LIVE / chop scalp):
  1 contract  | stop 2pt ($10) | target 3pt ($15)

DAILY:
  Target +$300  →  TARGET_REACHED, consider stop
  Hard stop -$150 → all MES trading suspended
  Max trades 10  |  Max consec losses 3 = 60min pause
  Friday cap: -$100

TIME WINDOWS:
  09:40-11:00 ET  →  Tier A primary
  14:30-15:30 ET  →  Tier A primary
  11:00-13:00 ET  →  Tier C only (chop)
  15:30+         →  no new entries
  Always: flat by 15:45

EXECUTION (Path 1):
  Manual Webull order entry from Pine alerts
  Plan = discipline framework, not auto-executor
─────────────────────────────────
```

---

## Appendix A — How $300 actually gets earned (worked example)

A typical successful session might look like:

```
09:42 ET  HTF+BUY confluence on MES1! → Tier A entry @ 7,490
          5 contracts long, stop 7,487, target 7,496
10:08 ET  +6 pts hit → +$150 realized | running total +$150

10:34 ET  ZONE break standalone → Tier B entry @ 7,494  
          3 contracts long, stop 7,491, target 7,499
10:51 ET  +5 pts hit → +$75 realized | running total +$225

11:23 ET  LIVE chop, sideways tape → Tier C entry @ 7,496
          1 contract, stop 7,494, target 7,499
11:31 ET  +3 pts hit → +$15 realized | running total +$240

13:18 ET  HL pullback confirms uptrend → Tier B entry @ 7,498
          3 contracts long, stop 7,495, target 7,503
13:42 ET  -3 pts hit (stop) → -$45 realized | running total +$195

14:47 ET  HTF+ZONE confluence → Tier A entry @ 7,501
          5 contracts long, stop 7,498, target 7,507
15:22 ET  +6 pts hit → +$150 realized | running total +$345

15:23 ET  TARGET_REACHED alert fires → STOP TRADING per plan

Session: 5 trades, 4 wins, 1 loss, +$345 realized, ~3.4 hours active.
```

This is a *good* session, not the average. A more typical session lands +$50 to +$200, with occasional -$50 to -$150 days. The +$300 days happen — they're not myth — but they require discipline AND favorable conditions on the same day.

---

## Appendix B — Pine signal stacking examples

**Tier A trigger (HTF + confluence within 60 sec):**
- 09:42:11 — `HTF CALLS` engine fires on MES1!
- 09:42:14 — `BUY CALLS` same instrument fires
- → Stacking rule promotes B to A. Enter 5-contract long.

**Tier B trigger (single signal, no stacking):**
- 10:34:03 — `ZONE CALLS` fires on MES1!
- No other CALLS signal within 60 sec
- → Tier B. Enter 3-contract long.

**Conflict — no entry:**
- 11:08:22 — `HL CALLS` fires on MES1!
- 11:08:34 — `LH PUTS` fires on MES1!
- → Conflict (chop indicator). HOLD. No entry.

**Tier upgrade by stacking:**
- 14:47:09 — `HTF CALLS`
- 14:47:11 — `ZONE CALLS`  
- 14:47:14 — `BUY CALLS` (third signal in 5 sec)
- → Triple-stacked confluence. Stay at Tier A (max). Strong conviction trade.
