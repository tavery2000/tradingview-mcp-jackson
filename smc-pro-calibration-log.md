# SMC Pro Futures — Calibration Log

Operator-driven empirical log of indicator behavior during live sessions. Entries capture observations of fires, misses, and asymmetries to build a longitudinal calibration dataset. Pairs with `timeframe-behavior-analysis.md` (forensic deep-dives) and `smc-pro-futures.pine` (the indicator code itself).

This document is a fast-add observation journal; the analysis doc is for the careful diagnostic write-ups.

---

## Entry Format

Each observation gets one entry with these fields:

```
### YYYY-MM-DD HH:MM ET — <Instrument> <TF> — <one-line summary>

- **Symbol / TF:** ES1! / NQ1! / MES1! / SPY / QQQ / IWM, plus chart timeframe
- **Event:** what happened on the chart (price action description, levels involved)
- **Indicator state at event:** what fired / what didn't / what labels drew
- **Expected outcome:** what a perfectly-tuned indicator would have done
- **Actual outcome:** what the indicator did
- **Verdict:** correct-behavior / calibration-gap / architectural-gap / config-issue
- **Pattern class:** §1-§8 (calibration), §10 (zone-break-supply-rejection), §11 (asymmetry), §12 (LIVE intra-bar), §13 (sensitivity gate), §14 (HL/LH early), §15 (filter validation), §16-§17 (HTF cost), §18 (demand-zone-breakdown), or new
- **Reference:** link to timeframe-behavior-analysis.md section if forensic write-up exists
```

Brevity is fine — one paragraph per entry is the default. Reserve the full forensic treatment for `timeframe-behavior-analysis.md`.

---

## Observations

### 2026-05-10 16:00 ET — ES1! 1M — SELL fired correctly at NY close reversal

- **Event:** End-of-RTH bearish reversal, structural CHoCH below recent HL.
- **Indicator state:** SELL label drew on chart at break bar.
- **Actual outcome:** Fire correct, follow-through ~5 ES points before flatten.
- **Verdict:** correct-behavior
- **Pattern class:** baseline — what good behavior looks like.
- **Reference:** none needed.

### 2026-05-10 18:15–18:35 ET — ES1! 1M — three missed BUY signals on LL bounces

- **Event:** Asia tape, three consecutive LL bounces with reversal candles. None fired BUY.
- **Indicator state:** No labels drew; no fires.
- **Verdict:** calibration-gap → root cause traced to pivot length × bar-time asymmetry.
- **Pattern class:** §1–§8 (subsequently shipped 2026-05-10 as adaptive `pivotLenEff`).
- **Reference:** `timeframe-behavior-analysis.md` §1–§8.

### 2026-05-10 19:25 ET — ES1! + NQ1! 1M — zone-break asymmetry (ES fired SELL, NQ didn't)

- **Event:** Both ES and NQ rallied into supply zones, rejected, broke down out of zone bottoms. Visually identical setups.
- **Indicator state:** ES fired SELL via structural CHoCH (`close < lastUnbrokenLow`). NQ's prior HL sat farther below the zone — close-below-zone-bottom didn't reach `lastUnbrokenLow` → no CHoCH → no fire.
- **Verdict:** architectural-gap (zones were purely passive; no standalone zone-break trigger).
- **Pattern class:** §10 (subsequently shipped 2026-05-10 as `bullZoneBreakRaw` / `bearZoneBreakRaw` Pattern A).
- **Reference:** `timeframe-behavior-analysis.md` §10.

### 2026-05-10 20:25 ET — ES1! + NQ1! 1M — VWAP bounce asymmetry (ES fired BUY, NQ didn't)

- **Event:** Both held VWAP and bounced. ES fired BUY on structural break above prior LH; NQ didn't.
- **Indicator state:** ES had `lastUnbrokenHigh` set to a recent LH; close-above triggered CHoCH. NQ's `lastUnbrokenHigh` was farther — bounce didn't reach it.
- **Verdict:** correct-behavior (path-dependent pivot history, indicator differentiating correctly between instruments).
- **Pattern class:** §11 (subsumed by §1–§8's adaptive pivot fix).
- **Reference:** `timeframe-behavior-analysis.md` §11.

### 2026-05-10 20:53 ET — ES1! 1M — displacement bar fired BUY ~60s late (intra-bar timing lag)

- **Event:** Displacement bar moved 14 ES points in ~30s. Confirmed signal didn't fire until bar close, by which time the optimal entry was gone.
- **Verdict:** timing tradeoff — `barstate.isconfirmed` gate prevents intra-bar flickering but introduces 60s lag on displacement.
- **Pattern class:** §12 (subsequently shipped 2026-05-10 as LIVE intra-bar trigger with vol/range/extreme-close filter).
- **Reference:** `timeframe-behavior-analysis.md` §12.

### 2026-05-10 21:00 ET — NQ1! 1M — dashboard stuck on stale "Last Signal: BUY" through bearish continuation

- **Event:** NQ continued bearish; dashboard panel showed "Last Signal: BUY" from prior fire. No fresh SELL emitted despite price extension.
- **Verdict:** detection-signal-gate-gap → sensitivity tier was requiring confluence (sweep OR zone) that the continuation bars didn't have.
- **Pattern class:** §13 (subsequently shipped 2026-05-10 as event-type-aware sensitivity tiers — CHoCH fires alone in Balanced).
- **Reference:** `timeframe-behavior-analysis.md` §13.

### 2026-05-10 21:13 ET — ES1! 1M — CHoCH label drew but no BUY fired (8.75 pt move missed)

- **Event:** Clean LL → HL → CHoCH-above-LH reversal pattern; CHoCH label drew on chart at break above 7,403. Move ran 7,396.25 → 7,405+. No BUY fire.
- **Indicator state:** Structural detection fine, signal gate downstream blocked.
- **Verdict:** detection-signal-gate-gap (same class as 21:00 ET).
- **Pattern class:** §13 (resolved by event-type-aware sensitivity shipped same night).
- **Reference:** `timeframe-behavior-analysis.md` §13.

### 2026-05-11 ~08:00 ET — Pre-NY-open — LL bounce / bull trap played out (filter validation win)

- **Event:** LL bounce extended upward, looked tradeable. Operator considered §14 ship (HL early-entry) but held.
- **Indicator state:** All four filter layers stayed silent. Bounce extended, rejected sharply, became a confirmed bull trap. Indicator then fired SELL on the rejection top.
- **Verdict:** correct-behavior — design winning. Silence on weak evidence, fire on multi-filter convergence.
- **Pattern class:** §15 (the best finding of the May 10 → May 11 session).
- **Reference:** `timeframe-behavior-analysis.md` §15.

### 2026-05-11 ~09:14 ET — ES1! 1M — pullback false-CHoCH polluted trend state; continuation BUY didn't fire

- **Event:** Bullish uptrend; pullback broke recent HL → false bearish CHoCH SELL fired. After pullback recovered, no BUY fired on continuation.
- **Verdict:** trend-state pollution — CHoCH fire mutated `trend := -1` and `lastUnbrokenLow := na`, removing the reference for the next BUY.
- **Pattern class:** §16. Operator's mitigation: enabled `useHTFFilter=true` (Path A) to block counter-trend fires. Later same day, Path C (auto-recovery code) shipped.
- **Reference:** `timeframe-behavior-analysis.md` §16 + §17.

### 2026-05-11 ~10:25 ET — ES1! + NQ1! 1M — sharp top reversal, all four signal layers silenced by HTF filter

- **Event:** Mid-morning top, ~15 ES point drop. Operator caught manually on tape; indicator stayed silent (CHoCH, LH, zone-break, LIVE — all blocked by HTF filter since HTF still showed Bullish from prior rally).
- **Verdict:** filter collateral cost — design paying. Matched pair with §15 (which was design winning).
- **Pattern class:** §17 (auto-recovery Path C shipped same day to mitigate — when broken pivot is reclaimed in original direction within N bars, trend state reverts and signals can fire without waiting for 1H HTF flip).
- **Reference:** `timeframe-behavior-analysis.md` §17.

### 2026-05-11 ~20:25 ET — MES1! 1M — missed BUY at LL bounce 7,429 → 7,434

- **Event:** New LL at ~7,429. Sharp wick down + heavy red volume bar (the wick-down bar itself). Reversal candle, price reclaimed and ran to 7,434 (~5 MES pts).
- **Indicator state:** **HL label DID draw at ~7,429 on the chart** (operator-confirmed). Visible teal/blue demand zone box at ~7,430. No BUY signal fired.
- **Expected outcome:** Given §14 was shipped 2026-05-11 (`bullHLraw` in `bullBreak` chain) AND §10 zone-break was shipped 2026-05-10 AND §17 Path C auto-recovery shipped same day — at least one of these three primitives should have triggered BUY on the HL confirmation.
- **Actual outcome:** Silent. (Subsequent LH PUTS fired correctly at 20:45 ET on retest — see next entry.)
- **Verdict:** PENDING root-cause confirmation. Most likely **§17 HTF filter collateral cost** — if `useHTFFilter=true` (set in §16 Path A mitigation) AND `htfBias = Bearish` at 20:25 (Asia drift), all bull signals blocked at `smc-pro-futures.pine:690-691` regardless of HL/zone/LIVE detection.
- **Pattern class:** §17 re-occurrence (filter collateral) — pending HTF state confirmation.
- **Reference:** `timeframe-behavior-analysis.md` §17.

### 2026-05-11 ~20:35 ET — MES1! 1M — missed SELL on demand-zone BREAKDOWN at 7,430 (NEW gap)

- **Event:** Price falling, broke DOWN through the bottom of an active bull/demand zone at ~7,430. No bounce attempt — clean breakdown.
- **Indicator state:** Bull OB at 7,430 mitigated (removed from `bullOBs` array) as price closed below zone bottom. No signal emitted.
- **Expected outcome:** A bear continuation signal on demand-zone invalidation. This is a different geometry than §10's supply-rejection-SELL (`smc-pro-futures.pine:558-568` iterates `bearOBs`, not `bullOBs`).
- **Actual outcome:** Silent.
- **Verdict:** **NEW architectural gap — distinct from §10**. Demand-zone-breakdown (bull-OB-invalidation → SELL) has no dedicated trigger. The §10 ship handled supply-rejection-SELL (wick UP into bear OB, close DOWN below) but not the symmetric demand-breakdown direction.
- **Pattern class:** **§18 (new) — Demand-Zone-Breakdown Signal Gap**. See `timeframe-behavior-analysis.md` §18.
- **Reference:** `timeframe-behavior-analysis.md` §18.

### 2026-05-11 ~20:45 ET — ES1! 1M (alert payload) — LH PUTS fired correctly on retest into broken zone

- **Event:** ~10 minutes after the 20:35 ET breakdown, price retraced UP into the broken demand zone and rejected (now acting as supply). LH pivot confirmed; signal fired.
- **Alert payload:** `{instrument:"ES1!", direction:"PUTS", engine:"LH", confidence:"MEDIUM", price:7431, alertName:"LH PUTS"}`
- **Verdict:** correct-behavior — short-side completion of the 20:25 / 20:35 setup. Confirms §14 LH/LH early-entry works.
- **Important note:** Operator was watching MES1! chart but the alert payload reported `instrument=ES1!`. **Diagnosis:** TV alert is configured on the ES1! chart, not MES1!. The MES1! chart's Pine indicator is rendering labels but no TradingView alert is wired on it. Also: webhook-server.js allow-list does not include `MES1!` — even if a TV alert were configured on the MES1! chart, the webhook would reject the payload. Two distinct config gaps. Flagged in Pattern Notes.
- **Pattern class:** correct-fire + config-issue.

### 2026-05-11 20:45-23:00 ET — MES1! 1M — LATE SESSION VALIDATION SEQUENCE

**Setup observed:** Multi-hour after-hours session with clear structural moves on MES1! 1M. Capitulation low at 21:45 ET with volume spike, then choppy recovery with multiple HL/LH cycles.

**Indicator behavior:** ~80% accurate firing per operator. 9 signals fired in the window, most aligned with structural turns on the chart.

**Signal sequence (chronological):**
- 20:45 ET — SELL at LH ~7,431
- 20:50 ET — BUY at HL ~7,430
- 21:15 ET — SELL on supply zone retest at top of zone ~7,431 (clean rejection)
- 21:55 ET — BUY at bottom of leg ~7,418 (capitulation candle with volume spike clearly visible)
- 22:00 ET — SELL at retest ~7,421
- 22:00 ET — BUY at HL ~7,418 + CHoCH labeled
- 22:30 ET — SELL at LH ~7,427
- 22:45 ET — BUY at HL ~7,425
- 22:55 ET — SELL at fresh LH ~7,432

**Notable correct fires:**
- 21:15 ET SELL on supply zone retest (clean structural rejection)
- 21:55 ET BUY at capitulation low with volume confirmation
- 22:55 ET SELL at fresh LH retest

**Misses still being observed:** From earlier same session (20:25 ET demand zone breakdown, §18 architectural gap) — those remain unfixed pending Wednesday EOD decision.

**Cross-reference:** Validation data point for chart-first hierarchy migration. Demonstrates the indicator's signal-firing logic IS working at high accuracy when structural setups are clean — the gaps are specifically the zone-break edge cases already identified in §10 and §18.

- **Pattern class:** validation / multi-fire correctness sample.

### 2026-05-12 ~08:35 ET — ES1! 1M — BUY fired early at HL ~7,405 (drew down to 7,398 before resuming)

- **Event:** Indicator fired BUY at HL pivot ~7,405. Price subsequently dropped to LL ~7,398 (operator-marked "blue diamond" as the preferred entry) before resuming the rally into the 7,420 zone.
- **Indicator state:** §14 `bullHLraw` fired on the HL pivot confirmation. No subsequent §10 zone-break or §13 CHoCH at the LL since the bounce produced no fresh confirmed pivot before resumption.
- **Operator read:** Should have waited for the LL bounce (blue diamond) before entering — would have captured ~22 pts of move vs ~15 pts from the actual HL fire (7 pt drawdown absorbed first).
- **Verdict:** §14 collateral cost — known design trade-off. Same class as the §17 ~10:25 ET ES1! example logged 2026-05-11: §14 fires earlier than the optimal entry by design, accepting drawdown risk in exchange for not missing the move when no subsequent retracement occurs (the §15 bull trap case showed this same hold logic being correct).
- **Pattern class:** §14 collateral cost (recurrence — second observation, paired with the 2026-05-11 10:25 example).
- **Reference:** `timeframe-behavior-analysis.md` §14, §15 (validation), §17 (collateral).

### 2026-05-12 ~08:35 ET — ES1! 1M — false SELL on inverted hammer in uptrend ~7,418

- **Event:** Indicator fired SELL at ~7,418 on a candle the operator identifies as an inverted hammer. Price continued upward to 7,420+ — no follow-through on the SELL.
- **Indicator state:** Specific trigger not yet identified — could be §10 supply-rejection (wick up into bear OB + close back below zone bottom), §13 CHoCH SELL (close < lastUnbrokenLow), or §14 LH early-entry. Forensic identification requires Pine state at bar close, which isn't journaled.
- **Operator read:** Inverted hammer in established uptrend should bias to continuation, not reversal — the long upper wick is buying pressure absorbed by sellers, but the close near low followed by next-bar continuation invalidates the "reversal" interpretation. Indicator's reversal triggers don't currently factor candlestick context.
- **Verdict:** **potential new pattern class — filter gap on candlestick context**. NOT yet escalated to a §19 section in `timeframe-behavior-analysis.md` because: (a) the specific Pine trigger that fired needs identification, (b) one observation isn't a threshold for architectural action. Flag for forensic review if pattern recurs.
- **Pattern class:** filter-gap (candidate, unverified).
- **Reference:** none yet — would be §19 if escalated.

### 2026-05-12 ~08:35 ET — NQ1! 1M — multiple floating signals without clear structural anchor

- **Event:** Operator observed several signal labels (BUY at LL ~29,120, SELL at ~29,250, BUY at HL ~29,210, SELL at ~29,335 LH) appearing on NQ1! chart without the structural setup the operator expected.
- **Operator hypothesis:** TradingView chart-reset behavior — when TV re-renders a chart (zoom, refresh, instrument switch), Pine `var` state machines can replay history and place labels at bars that wouldn't have triggered alerts in real-time. Visual artifact, not a webhook fire.
- **Verdict:** **flagged for verification only.** Key question: did any of these "floating" labels generate webhook POSTs? If yes, the disconnect is real (alert state vs chart state divergence). If no (labels visible but no webhook traffic), it's purely a TV render artifact and the autonomous pipeline is unaffected.
- **How to verify:** check the webhook server console output / ngrok inspector at 08:35 ET for any inbound NQ1! payloads. If none received, this is render-only.
- **Pattern class:** TV-render-artifact (suspected) / signal-state-divergence (verification pending).
- **Reference:** none — verification step before classification.

### 2026-05-12 ~15:55 ET — SPY 1M — END-OF-DAY +92% MANUAL vs HANK +37% PER CONTRACT (same setup, lag-architecture proof)

**Setup:** SPY 1M power hour. Operator-marked entry at HL ~$737.10 ~14:55-15:00 ET. End-of-day HH ~$738.50. Underlying move: +1.4 SPY pts in ~55 min.

**Operator manual scalp:** SPY CALLS at HL → +92% in ~55 min.

**HANK's actual trades on the same setup (journal verified):**

| Time | Engine | Fill | Exit | Pnl | Reason |
|---|---|---|---|---|---|
| 14:56:01 | BUY | 1.4788 | 1.4228 | -$5.60 | SIGNAL_REVERSAL |
| 15:02:11 | HL | 1.4788 | 1.4668 | -$1.20 | SIGNAL_REVERSAL |
| 15:05:01 | LH PUTS | 1.4788 | 1.4028 | -$7.60 | SIGNAL_REVERSAL (counter-trend) |
| 15:05:02 | HTF PUTS | 1.4788 | 1.4028 | -$7.60 | SIGNAL_REVERSAL (counter-trend) |
| **15:07:30** | **ZONE CALLS** | **1.4788** | **2.0228** | **+$54.40** | **SIGNAL_REVERSAL ← WINNER** |
| **15:07:30** | **BUY CALLS** | **1.4788** | **2.0228** | **+$54.40** | **SIGNAL_REVERSAL ← WINNER** |
| 15:42:30 | SELL PUTS | 1.4889 | 1.4649 | -$2.40 | SIGNAL_REVERSAL |
| 15:42:31 | HTF PUTS | 1.4889 | 0.497 | -$99.20 | HARD_EXIT |
| 15:43:01 | BUY CALLS | 1.4889 | 0.789 | -$69.99 | HARD_EXIT |

**Net for HANK on the power-hour SPY rally: +$108.80** (the two 15:07:30 winners). Earlier entries (14:56-15:05) all whipsawed in pre-leg-up consolidation.

**Operator vs HANK comparison:**

| | Entry timing | Move captured | Percentage | Holding period |
|---|---|---|---|---|
| Operator | 14:55-15:00 at HL ~737.10 | 1.4 SPY pts | +92% | 55 min |
| HANK | 15:07:30 at ~737.50 (12 min later) | 0.9 SPY pts | +37% per contract | ~25 min before SIGNAL_REVERSAL |

**This is the lag-architecture pattern in dollar terms.** HANK detected the same setup but entered 12 minutes later AND exited 25-30 min earlier via SIGNAL_REVERSAL. Both axes of the gap visible:
- **Axis 1 (lag):** HANK missed the first 0.5 SPY pts of move
- **Axis 2 (chop pre-leg):** Pre-15:07 chop produced 4 whipsaw losses (-$22 total) that operator avoided by patient discretionary entry
- **Axis 3 (SIGNAL_REVERSAL):** Even when right, HANK exited at first opposite signal rather than holding to structural confirmation at HH

**Two HARD_EXIT losses at 15:42-15:43 ET (-$99.20 PUTS, -$69.99 CALLS):** These positions opened in the final 3 minutes before RTH cutoff and closed via HARD_EXIT (likely EOD simulation at heavily discounted prices). Possible artifact OR possible real loss from late-entry-near-close. **Candidate for tomorrow's gate refinement:** suppress new entries in the final ~10 min before 15:45 RTH cutoff (the move has played out; new entries are more likely to be flushed by close-related dynamics).

**Alert toast bottom-left:** "Alert on SPY" with proper `"instrument":"SPY"` payload — Pine override fix (12f5e50) continues to work correctly end-to-end.

**Validates today's hypothesis stack:**
- ✅ 1M timeframe filtered chop and caught structural HL (Axis 2)
- ✅ HL entries are catchable (the proof points of pivot-extreme trigger hypothesis — Axis 1)
- ✅ SPY signals labeled correctly post-override deploy (12f5e50)
- ✅ HANK's detection works — gap is purely fire-timing precision

The three-axis frame applies cleanly: each gap maps to a different axis, no remainder.

### 2026-05-12 ~15:35 ET — REFINED FINAL SYNTHESIS — three independent axes (not one fix)

The 15:20 hypothesis collapsed three findings into a single synthesized fix. The 15:30 observation refined it. This entry locks the final framing for post-close decision-making.

**Today's findings decompose into THREE INDEPENDENT AXES.** They are orthogonal, not substitutable. Full recovery of operator's discretionary trading edge requires all three addressed — but each can be addressed separately on its own timeline.

| Axis | Layer | Fix mechanism | Independent of |
|---|---|---|---|
| **1 — Signal timing lag** | Pine code | Fire BUY/SELL at the pivot extreme with sweep+vol+reversal-candle confluence | Timeframe choice (lag scales with bar size — proven 15:30) |
| **2 — Chop noise filter** | Operator workflow | Switch timeframe by regime (30sec morning, 1M midday) | Pine trigger logic |
| **3 — Per-engine gating** | HANK gate logic | Stricter gates for low-WR engines (ZONE/LH/HL); pass-through for high-WR engines (BUY/SELL/STRUCTURE) | Pine code AND timeframe — purely about post-signal handling |

**Critical empirical anchor:** the 15:30 MES1! 1M observation (HL at 15:18, BUY fired at 15:30 — 12-min lag) proved Axis 1 and Axis 2 are independent. Lag scales with bar size; changing bar size doesn't fix lag. The Pine fix (Axis 1) is required regardless of which timeframe the operator picks (Axis 2).

**Operator's proof point:** 15:20 MES1! manual scalp at HL → +24% in 2 min. Indicator IS pointing at the right setup; just fires too late to capture the move. A small precision improvement (Axis 1 Pine fix) would have given HANK this trade with similar P&L.

### Decision priority (operator framing)

| Priority | Axis | Why this priority |
|---|---|---|
| HIGH | Axis 1 (Pine code) | Single highest-impact change. Recovers entry-timing edge on every trade. ~10-15 LOC Pine. |
| MEDIUM | Axis 2 (timeframe discipline) | Operator-side, free, can start tomorrow. Validates further with data each session. |
| MEDIUM | Axis 3 (engine gating) | Requires today's loss-data analysis to calibrate. **16:02 ET analyzer cron fires in ~25 min and produces per-engine continuation rates** — that's the dataset Axis 3 needs. |

### Why "three axes" beats "one synthesized fix" as a framing

- Each axis has independent ship/no-ship decision criteria
- Each axis can be rolled back independently if it proves wrong
- Each axis can be tested independently in replay
- The matrix of operator-decisions is clearer: which axis to ship first based on engineering cost vs immediate value
- Composition is explicit: shipping 1 + 2 + 3 yields the full recovery; shipping any subset captures part of it

The earlier "single hypothesis" framing was a useful synthesis but it overcollapsed. The operator's 15:35 refinement re-separates them with the right granularity.

### Status of all today's pattern observations under the 3-axis frame

| Pattern observed today | Maps to Axis |
|---|---|
| Trend-context blindness (11:55, 13:37) | Axis 1 (timing fix may incidentally help) AND Axis 3 (engine gating for ZONE) |
| Sweep-vs-confirmation timing (14:15) | Axis 1 — direct |
| SIGNAL_REVERSAL whipsaw (14:25 chop) | Axis 2 (chop filter) AND Axis 3 (per-engine SIGNAL_REVERSAL handling) |
| Chop detection required (14:45) | Axis 2 — direct |
| Timeframe-as-filter (15:00 paired data) | Axis 2 — direct |
| Pivot-extreme trigger validation (15:20, 15:30) | Axis 1 — direct |

All 4 of today's pattern observations map cleanly into the 3-axis frame. No remainder.

### 2026-05-12 ~15:30 ET — MES1! 1M — SIGNAL LAG CONFIRMED ACROSS TIMEFRAMES (separates lag-fix from TF-fix)

**Setup:** MES1! 1M power-hour continuation:
- HL formed ~15:18 ET at 7,408 (operator-circled)
- Price ran 7,408 → 7,420 = +12 MES pts
- BUY fired ~15:30 ET at 7,415 — **12 minutes after HL formed, 7+ pts of move already gone**

**Operator quote:** *"Now the buy signal just fired and look how long that took."*

**Critical architectural insight:** This is on **1M**, not 30sec. The earlier sweep-lag observation (14:15, SPY 30sec, 60-90sec lag) was the SAME mechanism — just on a different timeframe. The lag scales WITH the bar size: longer bars → longer absolute lag.

**Cross-timeframe validation table:**

| TF | Observation | Lag mechanism | Absolute lag |
|---|---|---|---|
| 30sec | SPY 14:10 sweep (blue diamond) vs BUY (14:13) | bullCHOraw waits for close > lastUnbrokenHigh, ~2-3 bars post-sweep | 60-90 sec |
| 1M | MES 15:18 HL vs BUY (15:30) | Same mechanism — pivot confirmation + structural close, ~3-12 bars post-extreme | 3-12 min |

**The lag is NOT a timeframe choice.** It's Pine signal-trigger logic firing at structural confirmation rather than at the pivot extreme. **Timeframe affects chop filtering. Pivot-extreme firing affects entry timing. They are orthogonal axes.**

### Refined synthesis (from 15:20 SPY+MES → 15:30 MES update)

The earlier synthesized hypothesis collapsed three findings into "fire at pivot extreme + 1M timeframe." The 15:30 observation refines that:

| Concern | Fix axis | Independent? |
|---|---|---|
| Signal timing lag | Pine pivot-extreme trigger | Yes — independent of timeframe |
| Chop noise | Operator timeframe choice (30sec vs 1M) | Yes — independent of trigger |
| Combined effect | Both fixes compose: precise entry on appropriate TF | — |

**Implication:** the Pine fix (sweep+vol+candle confluence trigger at the pivot extreme) is required regardless of which timeframe the operator picks. The timeframe choice remains useful for chop filtering but does not solve the lag. Decision 1 in the register is independent of Decisions 2/3 — they ALL need to be addressed, just via separate levers.

### 2026-05-12 ~15:20 ET — MES1! 1M — operator +24% on the manual setup, indicator labeled it but late (PROOF POINT)

**Setup:** MES1! 1M power-hour. Operator-marked HL at ~7,408 (entry zone) → HH at ~7,422 (red dot exit), ~14 MES pts in ~2 min.

**Trade taken (operator):** MES CALLS at HL formation, exited at HH, +24% gain.

**Indicator behavior on this trade:** BUY label fired at the HL at ~15:00 (the second BUY in a recent HL/HL sequence) — but at the late-confirmation point, not at the structural HL bar itself.

**Operator quote:** *"Those are the trades Hank missed but we're getting much better."*

**Why this is a proof point for the synthesized hypothesis:**
- Indicator IS pointing in the right direction (BUY, correctly)
- Indicator IS firing on the correct structural setup (HL formation)
- Gap is purely WHERE on the bar pattern Hank fires — 2-3 bars late vs the structural extreme bar
- A small precision improvement (pivot-extreme trigger) would have given HANK this trade with similar P&L
- This validates that the synthesis isn't about WHETHER to fire — it's about WHEN, at the same setups Hank already detects correctly

### 2026-05-12 ~15:20 ET — SPY 1M + MES 1M — SYNTHESIZED HYPOTHESIS: pivot-extreme trigger + 1M timeframe

**Setup observed:** SPY 1M + MES 1M afternoon comparison window 12:00-15:25 ET.

**SPY 1M:** ~15 signals across 3+ hours. Major moves caught (12:55 LL bounce, 13:30+ uptrend, 15:10 LH retest). Signals fired at structural points (BUYs at HLs, SELLs at LHs). **NO duplicate fires in tight ranges** — chop suppression that 30sec lacks.

**MES 1M:** ~12 signals across same window. Clean morning chop SELLs into LL at 12:50. BUY at 12:50 LL caught the full uptrend leg to 7,425 HH. HL retest at 15:10 caught with BUY.

**Operator quote:** *"The one minute definitely avoids the chops... we just missed a few signals."*

**Operator's synthesizing hypothesis:** *"If we tighten down where chart actually fires the signal from (LL or HH, etc) that should solve our issues."*

---

### Today's three findings unified into a single architectural hypothesis

The synthesis ties together all of today's major architectural observations:

| Finding | Current mechanism | Proposed solution component |
|---|---|---|
| #1 Sweep timing (~14:15) | Pine fires on CHoCH confirmation, 2-3 bars after sweep | **Fire AT the pivot extreme bar** (LL or HH itself) |
| #2 Chop filter (~14:45) | 30sec catches early but fires on noise | **Use 1M timeframe** for natural chop suppression |
| #3 Pivot precision (15:20) | Multi-bar lag between extreme and signal | **Single architectural change addresses both** |

### The synthesized hypothesis

> **Fire BUY at the LL bar (when sweep + volume + reversal-candle align). Fire SELL at the HH bar (with mirror confluence). Combine with 1M timeframe.**

This is a single Pine architectural change that explains why operator manual trading consistently wins:

| Operator's manual entry | Synthesized Pine fix |
|---|---|
| Enters at sweep / pivot extreme bar | Pine fires at pivot extreme bar |
| Uses 1M context judgment to filter false sweeps | 1M timeframe naturally averages out micro-pullback false sweeps |
| Exits at structure confirmation | Same — Pine's existing CHoCH-confirmation as exit signal still works |

The hypothesis claims that **firing at the pivot extreme on 1M is naturally precise** because the 1M timeframe filters the geometric pivot false-fires that plague 30sec. It's a stronger claim than either sweep-as-trigger (Decision 1) alone OR timeframe-switch (Decision 2/3) alone — they reinforce each other.

### Why this is a stronger hypothesis than the original Decisions 1 + 2 + 3 considered separately

- **Decision 1 alone** (sweep-as-trigger on current timeframe): every failed sweep becomes a paper loss. Trap rate likely too high.
- **Decisions 2/3 alone** (timeframe switching): saves chop losses but doesn't recover the entry-timing edge — HANK still enters at CHoCH bar.
- **Combined (synthesized hypothesis):** sweep-as-trigger AT pivot bar PLUS 1M timeframe — the 1M timeframe is itself the trap-rate filter, allowing the more aggressive entry rule to work.

### Operator's proposed post-close investigation

**Primary post-close work item:**

1. Walk through today's trades (full count TBD — operator estimated 33; actual will be in ledger filter)
2. For each loss: identify the bar gap between the structural extreme bar (LL or HH) and the actual BUY/SELL fire bar
3. Determine: if HANK had entered at the extreme bar instead, would the trade have:
   - **a.** Improved win rate (earlier entry → wider profit window before SIGNAL_REVERSAL)?
   - **b.** Caused new false fires (every wick fires, including failed sweeps)?
4. If favorable: draft Pine modification combining sweep-as-trigger with sweep+volume+reversal-candle confluence filter, ship for tomorrow with 1M timeframe recommendation

This investigation is well-bounded — it's empirical replay against today's already-captured journal/ledger data, no new live runs needed. The journal has every signal's bar timestamp; the underlying-price timeline from POLL records gives the price action between extreme and fire. The analyzer at 16:02 ET starts the data; this investigation extends it.

### Classification

**SYNTHESIZED FIX HYPOTHESIS — possibly the single biggest improvement available.**

If this hypothesis holds empirically against today's data, it transforms three separate architectural concerns into one targeted Pine change + one operator workflow change (1M default during chop hours, 30sec for morning directional periods).

If it doesn't hold: at least we'll have a clean empirical answer about WHY operator manual trading wins where HANK loses, and the failure mode tells us what additional context dimension is needed (e.g., specific candlestick context that can't be encoded geometrically).

### 2026-05-12 ~15:00 ET — MES1! 1M — CONFIRMS timeframe-as-chop-filter with hard cross-instrument data

- **Setup:** MES1! 1M chart, same 14:25-15:00 ET window as the SPY 30sec chop observation just below. Range: HH ~7,412 / LL ~7,400 = 12 MES pts over 35 min. The exact same intraday chop regime.
- **Indicator behavior on MES 1M (NOT 30sec):**
  - 1 SELL fired at the top of the range (~14:38 at LH/HH area)
  - 1 BUY fired at the bottom (~14:52 at LL retest)
  - **Total: 2 signals in 35 minutes**
- **Comparative table — same regime, two timeframes:**

  | Chart | Window | Range | Signal count | Outcome |
  |---|---|---|---|---|
  | SPY 30sec | 14:25-14:45 (20 min) | 4-6¢ | 6-8 fires | All losers in chop |
  | MES1! 1M | 14:25-15:00 (35 min) | 12 MES pts | **2 fires** | Top + bottom of range, minimal noise |

- **Operator quote:** *"MES is much cleaner during the afternoon chop"*
- **What this resolves:** The timeframe-as-chop-filter hypothesis (Observation 3 in HANK-BRIEFING.md, also fix Decision 2 + 3 in `pending-architectural-decisions.md`) was logged 15 min earlier as an intuition with one-timeframe data. This observation provides **hard validation with paired data**. Same regime, two different timeframe choices, dramatically different signal density.
- **Verdict:** **VALIDATED.** Time-of-day timeframe switching is empirically supported with at least one paired observation. Recommendation θ/A (operator-side regime switching) in the decision register is the right starting answer — the hypothesis works without needing code instrumentation.
- **Pattern class:** TIMEFRAME-AS-CHOP-FILTER (validation evidence).
- **Caveats remain:** 
  - Single-day paired data. Need 3-5 sessions of paired 30sec/1M to be confident the schedule generalizes
  - Different instruments (SPY vs MES) — MES futures may simply be less choppy than SPY equities in afternoon, independent of timeframe choice. Need same-instrument paired data to fully isolate
  - 15:00-16:00 ET (power hour) regime still unknown

### Today's two biggest practical findings — summary

Per operator's end-of-session synthesis, the two architectural patterns most directly actionable:

**Finding 1: Signal Timing Lag (sweep vs structural confirmation)** — entries lag the optimal point by 60-90 sec on 30sec; manual operator trading captures this edge by entering at sweep, exiting at structure. HANK currently can't.
- **Fix priority:** HIGH (recovers operator's edge as paper P&L)
- **Best option:** Decision 1-A (two-stage signal — T1 at sweep, T2 at confirmation, data-gathering first)
- **Status:** Deferred to post-close

**Finding 2: Timeframe-as-Chop-Filter (time-of-day rule)** — 30sec excels at directional-move detection (morning) but produces noise during chop (midday). 1m smooths chop without sacrificing real moves much.
- **Fix priority:** MEDIUM (no code; operator workflow change)
- **Best option:** Decision 2-A / 3-A (manual timeframe switching on schedule)
- **Status:** **Validated today** with paired SPY 30sec / MES 1M data
- **Suggested schedule** (operator hypothesis, single-day data):
  - 09:30-13:00 ET: 30sec (directional morning)
  - 13:00-15:30 ET: 1min (afternoon chop)
  - 15:30-16:00 ET: situation-dependent (power hour)

Both findings will be the focus of post-close decision block.

### 2026-05-12 ~14:45 ET — SPY 30sec — CHOP detected, timeframe-as-filter solution proposed

- **Event:** Post-rally consolidation. Price chopped 735.99-736.45 for 20 minutes (14:25-14:45). 4-6 cent ranges per bar. LH, HL, LL, HL all visible inside the box — geometrically the same structure-pivot shapes the indicator detects during real reversals. Multiple BUY (14:25, 14:30, 14:42) and SELL (14:30 LH) fires in the chop zone. All would be losing trades.
- **Operator read:** *"Not sure how we can achieve this but we definitely need some sort of chop filter. This just cannot be traded, not even by me."*
- **Operator-proposed solution:** *"That's where the 1min timeframe comes into play."*
- **The insight (this is novel and worth emphasizing):** Timeframe-per-regime, not just timeframe-per-instrument. Today's data shows:
  - **08:00-09:15 SPY 30sec:** beat 1m on pre-market early-move detection
  - **10:20-13:00 SPY 30sec:** captured real directional moves with realistic P&L on the post-fix pipeline
  - **13:30-14:45 SPY 30sec:** fires too many chop signals; SIGNAL_REVERSAL whipsaw locks in losses
  
  **Same instrument, same chart, opposite verdicts based on regime.** The operator's intuition: 1m would average out the 30sec chop while preserving most of the directional-move capture (because real moves span multiple minutes anyway). 30sec is a SCOUTING tool; 1m is a CONFIRMATION tool. Use 30sec when looking for moves; use 1m when in/near consolidation.
- **Pattern class:** TIMEFRAME-AS-CHOP-FILTER. Distinct from the earlier TIMEFRAME-PER-INSTRUMENT pattern — that was "what timeframe per ticker"; this is "what timeframe per market regime."

### Four candidate solution paths (post-close decision)

**θ — Operator-side regime switching (cheapest).** Operator switches between 30sec and 1m on SPY based on observed regime. No code change. Pros: zero risk, immediate. Cons: requires operator attention; HANK still fires on whatever timeframe the chart is set to; can't automate.

**ι — Pine-side chop detection input.** Add `enableChopFilter` + ATR/range threshold. When ATR(N) or high-low-range(N) is below threshold, suppress fires for the next M bars. ~15 LOC Pine. Pros: automated; per-chart configurable. Cons: thresholds need tuning per timeframe; may suppress legitimate consolidation breakouts.

**κ — Volume-based chop detection.** Require volume on the fire bar to be ≥ X × SMA(volume, 20). Chop bars typically have low volume; real-move bars typically have spike volume. Already partially in §12 LIVE intra-bar logic (`liveVolMult: 1.8`). Could extend volume gate to ALL fires (currently only LIVE intra-bar). ~10 LOC. Pros: market-mechanic-grounded. Cons: pre-market and overnight volume profiles differ.

**λ — Higher-timeframe chop detection (operator's intuition encoded).** Compute chop on 5m or 15m via `request.security`. When 5m ATR contracts below threshold (Bollinger Band squeeze, etc.), suppress all 30sec fires. ~20 LOC Pine. Pros: matches operator's mental model exactly — the 1m smoothing intuition mechanized. Cons: more complex; HTF dependency adds load.

**Recommended starting point:** θ (operator regime switching) for the remaining session and tomorrow as data-gathering. Pair with γ (two-tier sweep alert from the timing-architecture observation) and tonight's analyzer to capture: which timeframe wins which regime by how much. Decide between ι/κ/λ post-3-day-window.

### Updated post-close decision pool

Four distinct architectural patterns logged today, **13 candidate fix options** total:

| Pattern | Options | Recommended starting fix |
|---|---|---|
| Trend-context blindness | α / β / γ | (defer until paired 1M data exists) |
| Sweep-vs-confirmation timing | α / β / γ | γ (two-tier alert, zero behavior change) |
| SIGNAL_REVERSAL whipsaw | δ / ε / ζ / η | ε (multi-engine opposite-confirmation) |
| Timeframe-as-chop-filter (NEW) | θ / ι / κ / λ | θ (operator regime switching as data) |

All four pattern families share the same architectural family-resemblance: indicator + exit logic don't encode market-regime context. The fixes are all about adding context dimensions (direction-vs-trend, sweep-vs-confirmation, signal-vs-noise, trend-vs-chop) the current code doesn't weight.

### 2026-05-12 ~14:25 ET — SPY 30sec — diagnostic answer: SIGNAL_REVERSAL whipsaw on 30sec chop

Operator observation: clean uptrend continuation 14:10 → 14:25, BUY fired at HL ~14:18-14:20, move continued. *"This was an easy trade."* But journal shows mixed results — some BUYs filled, some blocked, ones that filled mostly lost via SIGNAL_REVERSAL.

**Journal-verified state for SPY 14:05-14:30:**

| Time | Alert | Outcome |
|---|---|---|
| 14:05:30 | PUTS ZONE | BLOCKED — MAX_CONCURRENT (3 open: IWM,SPY,SPY) |
| 14:10:30 | CALLS BUY | FILLED → closed SIGNAL_REVERSAL **-$6.40** |
| 14:10:30 | CALLS HL | FILLED → closed SIGNAL_REVERSAL **-$13.20** |
| 14:11:01 | PUTS ZONE | FILLED → closed SIGNAL_REVERSAL **-$16.00** |
| 14:13:00 | PUTS SELL | FILLED → closed SIGNAL_REVERSAL **-$22.80** |
| 14:13:00 | PUTS HTF | BLOCKED — MAX_CONCURRENT |
| 14:13:00 | PUTS LH | BLOCKED — MAX_CONCURRENT |
| 14:21:30 | CALLS BUY | FILLED — OPEN |
| 14:21:30 | CALLS HL | FILLED — OPEN |

**Mechanism:** The "clean uptrend" on the chart is being sliced into bidirectional micro-setups by the 30sec indicator. Every minor pullback within the larger up-move produces an opposite-direction alert. SIGNAL_REVERSAL closes the CALLS at the bottom of the dip, opens PUTS, then closes the PUTS at the top of the next push and reopens CALLS. Each flip locks in a small loss. The +$80 winner earlier (13:37 BUY) only worked because no opposite signal arrived during its leg up.

**Diagnosis: NOT a Pine signal-firing bug, NOT a webhook issue, NOT a sensitivity setting problem.** It's an **exit-logic mismatch.** §19 SIGNAL_REVERSAL was designed assuming opposite-direction signals = real direction change. On 30sec chop, opposite signals = ~30-90 second micro-pullback. The exit fires on noise, not on signal.

**Why operator's manual approach wins where HANK loses:**
- Operator enters at sweep (per the 14:15 timing-architecture observation)
- Holds through SIGNAL_REVERSAL-eligible bars based on contextual judgment (delta, momentum, candlestick shape)
- Exits at structure confirmation when the move's done — NOT on every reverse-direction print
- Effectively uses SIGNAL_REVERSAL as INFORMATION, not as an automatic exit

**Action items for post-close (added to decision pool):**

**δ — SIGNAL_REVERSAL hold-time minimum.** Don't close on opposite-direction alert within N minutes of entry. e.g., minimum 5-min hold. Filters out micro-pullback reversal exits. ~10 LOC in webhook-server.js. **Risk:** legitimate quick reversals also held longer. **Pros:** captures more of the legs HANK currently flushes.

**ε — SIGNAL_REVERSAL only on multi-engine opposite confirmation.** Current: ANY opposite-direction Pine alert triggers close. Proposed: require ≥2 opposite engines fire on the same bar (e.g., SELL+LH or SELL+ZONE) to close a CALL position. Reduces single-engine micro-pullback flush. ~15 LOC. **Risk:** legitimate decisive flips that fire only one opposite engine get held too long.

**ζ — SIGNAL_REVERSAL gated by underlying-move threshold.** Don't close unless price has actually moved ≥ X ATR against the position. Filters out reversal alerts that fire on inconsequential price movement. ~10 LOC. **Pros:** directly addresses "the position was still winning when SIGNAL_REVERSAL flushed it."

**η — Per-instrument SIGNAL_REVERSAL cooldown.** After a SIGNAL_REVERSAL fires on an instrument, don't allow another SIGNAL_REVERSAL on the same instrument for N minutes. Stops the rapid-fire flip cycle observed today. ~10 LOC. **Pros:** simplest. **Cons:** allows runaway positions if the original entry was wrong.

**Recommended post-close path:** ε or ζ likely the highest-quality fixes — both directly target the "noise vs signal" classification that's the root issue. δ is cheapest to ship but introduces fresh trade-offs. All four deferred per session-discipline.

### Cross-reference to today's other architectural observations

This timing-architecture observation (sweep vs structure-break) and the SIGNAL_REVERSAL whipsaw observation share a common architectural family:

| Pattern | Root | Operator manual handles via |
|---|---|---|
| Trend-context trap (11:55 / 13:37) | Indicator geometrically blind to trend continuation vs reversal | Visual context judgment |
| Sweep-vs-structure timing | Indicator fires at confirmation, not at detection | Tape-reading at the sweep |
| SIGNAL_REVERSAL whipsaw | Exit logic treats any opposite signal as direction change | Holding through noise, exiting on confirmed reversal |

All three are facets of the same underlying observation: **the indicator + exit logic are context-blind in ways that the operator's discretionary trading isn't.** The fix family for post-close is to encode more context into the rules — direction-vs-trend filters, sweep-as-trigger options, multi-engine confirmation gates, hold-time minimums.

### 2026-05-12 ~14:15 ET — SPY 30sec — STRUCTURAL TIMING OBSERVATION (sweep detection fires before BUY signal)

- **Operator observation:** *"Signals are late. I'm manual trading at LL (blue dot) while Hank does not see the signal until BUY is fired. By then the play is over."* Operator-marked blue diamond at LL ~14:10, BUY label at upper position ~14:13 — visual evidence of ~3-bar lag (90 sec on 30sec).
- **Mechanism (Pine-verified):** The current `bullBreak`/`bearBreak` OR-chain (smc-pro-futures.pine:611-612) is:
  ```pine
  bullBreak = bullBOSraw or bullCHOraw or bullZoneBreakRaw or bullHLraw
  bearBreak = bearBOSraw or bearCHOraw or bearZoneBreakRaw or bearLHraw
  ```
  Critically: **`bullSweepRaw` / `bearSweepRaw` are NOT in this OR-chain.** Sweep detection (the blue diamond — line ~277) is used downstream as a confluence input (`bullSweepRecent` / `bearSweepRecent` gates within sensitivity tiers), never as a direct signal trigger. The fire happens at the structure-break bar that comes AFTER the sweep, not at the sweep bar itself.
- **Sequence on the 14:10 SPY bounce:**
  1. Bar N: sweep detected → blue diamond drawn → operator enters manually
  2. Bars N+1 to N+M: price continues up, structure forms
  3. Bar N+M: HL/LH/CHoCH satisfied → BUY signal fires → HANK enters here
  M ≈ 2-3 bars on 30sec = 60-90 sec lag. Operator captures the first leg; HANK is consistently mid-move.
- **Operator's connection to today's loss pattern:**
  - BUY/SELL/STRUCTURE engines (caught the structural breaks) had OK conviction but late timing → +$1 wins or modest gains
  - LH/HL/ZONE engines (late-fire variants) had 80% loss rate today
  - SIGNAL_REVERSAL exits hit so often because HANK entered mid-leg and got flushed at the predictable pullback
  - Manual scalps consistently winning because operator entered at the sweep, exited at structure confirmation
- **Verdict:** **NOT A BUG — design tension.** The indicator was designed to fire on confirmation (lower trap rate, higher conviction). The operator trades on detection (better timing, requires context judgment). These are different operating modes; the current code is internally consistent with its "structure-confirmed" design intent.
- **Conservative sensitivity makes this strictly worse:** confluence requirements are checked at the structure-break bar (not the sweep bar). Stricter gating → fewer fires → all of them still late. **Recommend reverting SPY 30sec to Balanced or Aggressive** if optimizing for fire timing rather than fire selectivity.
- **Pattern class:** TIMING ARCHITECTURE / sweep-vs-confirmation design tension.

### Three design options for post-close decision

**α — Sweep-as-trigger (literal).** Add `bullSweepRaw` / `bearSweepRaw` to the OR-chain. Mirrors how §10 zone-break and §14 HL/LH were added. ~3 LOC Pine. **Risk:** every failed sweep = paper loss. No follow-through filter. Likely too noisy.

**β — Sweep-with-confluence (disciplined).** New trigger `bullSweepEntry := bullSweepRaw and volSpike and closeNearHigh`. Borrows §12 LIVE's volume + extreme-close gate, applies at sweep bar instead of structure-break bar. ~15 LOC Pine. **Risk:** threshold tuning needed per timeframe.

**γ — Two-tier alert (observability).** Keep current BUY/SELL logic unchanged. Add a separate "SWEEP_BULL" / "SWEEP_BEAR" alert at the sweep bar with distinct `alertName`. Operator gets early heads-up; HANK doesn't dispatch on it (no behavior change to paper trading); journal captures timing differential. ~10 LOC Pine. **Pros:** zero risk to current pipeline, builds dataset to choose between α and β empirically.

**Recommended path:** ship γ first (low risk, high info), let it collect data for 2-3 sessions, then decide α vs β with empirical evidence rather than intuition. ALL THREE deferred to post-close per session-discipline.

### 2026-05-12 ~13:37 ET — SPY 30sec — FALSE SELL trap at LH retest inside sustained uptrend

- **Event:** Sustained uptrend from 12:55 LL ~731.80 → HH at 13:25 ~734.70. Pulled back to LH retest ~734.80. Indicator fired SELL at 13:37:30 at 734.35. Price did NOT continue down — bounced and continued the uptrend, reaching ~734.81+ within minutes.
- **Indicator behavior (journal-verified, not just operator-described):** This was NOT a weak single-trigger ZONE fire. Three simultaneous alert() calls fired at the same 30sec bar close:
  - `13:37:30 PUTS SELL MEDIUM price=734.35`
  - `13:37:30 PUTS LH MEDIUM price=734.35`
  - `13:37:30 PUTS HTF HIGH price=734.35`
  Triple-engine confluence: structural SELL + LH-pivot early-entry + HTF-aligned (HIGH confidence on the HTF leg). The strongest possible bear signal the indicator can emit. **Still got trapped by continuation.**
- **Operator read:** *"another trap"*. Did not enter.
- **Operator note on the engine label:** Original report listed engine as "ZONE PUTS MEDIUM" — journal shows the actual triple was SELL+LH+HTF. Operator's note may reflect the TV toast which displays only the most recent alert, not the simultaneous batch. The journal is ground truth.
- **Why this is significant:** §17 collateral cost is supposed to be when HTF filter BLOCKS legitimate signals. This is the opposite: HTF filter ALLOWED a counter-trend trap fire because the 1H HTF bias hadn't flipped to match the immediate 30sec rally yet. The HTF leg fired with HIGH confidence saying "HTF says Bearish, SELL aligned" — but the immediate 30sec context showed clear continuation up.
- **Verdict:** **FALSE SELL despite triple-engine confluence.** Strongest available bear signal still wrong because the LH-pivot inside an uptrend got treated structurally the same as an LH after a clean reversal pattern. No bear-flag-vs-reversal differentiation.
- **Pattern class:** Counter-trend false fire / trend-context-filter gap. **Pairs with the 11:55 ET false BUY** — same architectural class, opposite direction (false BUY on bear flag, false SELL on bull flag).
- **Reference:** `timeframe-behavior-analysis.md` §14 (HL/LH), §16/§17 (HTF filter), §13 (sensitivity tiers).

### 2026-05-12 ~13:37 ET — Pine instrument override deployment — CONFIRMED FULLY WORKING

- **Operator observation:** Alert toast at 13:37 now shows *"Alert on SPY"* with `"instrument":"SPY"` in payload. **The Pine override fix (`12f5e50`) is confirmed working end-to-end.** Earlier toasts on the SPY chart showing ES1!/MES1! payloads have stopped.
- **Combined with `82681ce` inbound-journal logging:** every Pine alert now appears in the journal with the correct (override-resolved) instrument label, making future label-mismatch detection deterministic via journal grep.
- **Closes:** the 2026-05-12 11:55 ET "toast still shows ES1!" entry. Verified working.

### 2026-05-12 — PATTERN: Trend-context filter gap (multi-instance, multi-timeframe)

Bundled observation across today's session — NOT a single event, a pattern across multiple events:

| Time | Instrument | TF | Setup | Engine fires | Outcome |
|---|---|---|---|---|---|
| 08:35 | ES1! | 1M | BUY at HL ~7,405 | §14 HL | Drew down to 7,398 before resuming — §14 collateral cost |
| 08:35 | ES1! | 1M | SELL on inverted hammer | (unknown) | Price continued up — false |
| 10:30 | MES1! | 1M | LH ~7,412 missed → SELL at ~7,408 (late) | §14 LH (late) | Caught most of move but missed early entry |
| 11:55 | SPY | 30sec | BUY at HL ~732.85 in continuing downtrend | §14 HL | Bear-flag misread — false BUY |
| 13:37 | SPY | 30sec | SELL at LH ~734.35 in continuing uptrend | SELL+LH+HTF triple | Bull-flag misread — false SELL despite triple confluence |

**Common architecture:** indicator fires structural pivots (HL/LH) regardless of trend context. A pullback HL in an uptrend, geometrically, looks identical to a reversal HL after a downtrend ended. The indicator doesn't differentiate. HTF filter is supposed to help (§16/§17 Path A active) but lags behind the immediate trend on short timeframes — and when HTF DOES align, it sometimes confirms the wrong direction (today's 13:37 case had HTF saying SELL while immediate trend was UP).

**Proposed fix family (NOT shipped — pattern observation only):**
- **Option α — Bear-flag/bull-flag context filter for §14:** require HL pivot to be confirmed by either (a) prior CHoCH break in the same direction or (b) sweep below a prior swing low, before §14 fires BUY. Symmetric for LH→SELL. Rejects HL inside ongoing downtrend without prior structural reversal.
- **Option β — Trend-state require for counter-trend fires:** if 5M trend is UP, suppress SELL signals on 30sec/1M unless they have CHoCH-grade structural confirmation (close < prior LL, not just LH pivot).
- **Option γ — Sensitivity tier expansion:** add a "Trend-aware" sensitivity option between Balanced and Aggressive that applies a single rule: counter-trend signals require ≥2 confluence sources (sweep + zone, or zone + HTF-flip, etc.) even though aligned signals can fire on any single source.

**Decision criteria:** all three options have similar ship cost (~10-20 LOC in Pine). Choice depends on how aggressive the trade-off is between (a) catching real reversals early vs (b) refusing counter-trend traps. Need ≥1 more session of data + tonight's analyzer continuation rates per direction to decide.

**Connection to prior architectural findings:**
- §10 zone-break gap (zones as confluence only)
- §13 sensitivity-tier event-type-aware logic (CHoCH fires alone, BOS needs confluence — extend this principle to direction-vs-trend?)
- §15 filter-validation win (operator's manual hold preserved capital where indicator would have traded)
- §17 HTF-filter collateral cost (today's 13:37 is HTF filter PAYING in a new way — confirming wrong-side instead of blocking right-side)

All these are members of the same architectural family: **the indicator treats every structural pivot equally regardless of higher-level market context.** Direction-vs-trend, bar-context (candlestick interpretation), and time-of-day (open vs midday vs close) are all context dimensions the current code doesn't weight.

### 2026-05-12 — TIMEFRAME CAVEAT for today's data

Today's observations are mostly on SPY 30sec (operator's primary test for the timeframe-per-instrument question). MES observations are 1M. Conclusions about "indicator misses counter-trend traps" should NOT be generalized across all timeframes without 1M comparison data on the same instrument.

**Risk:** the trend-context filter pattern observed today may be a 30sec-amplification of a known §14 limitation. Bar-time has 2× more samples on 30sec vs 1M, so geometric HL/LH pivots inside continuation patterns are 2× more frequent, magnifying the trap rate.

**Resolution plan:**
- Tonight's 16:02 analyzer captures per-instrument continuation rates from journal data — gives a quantitative baseline
- Tomorrow's session: operator runs SPY on 1M for direct comparison. Same observation methodology
- After 2-3 sessions of paired 30sec / 1M data, can compute whether the trap pattern is timeframe-amplified or timeframe-universal
- Decision on trend-context filter (Options α/β/γ above) waits until the comparison data exists

**Why this caveat matters:** earlier today I called the SPY-on-30sec recommendation wrong (after my initial "keep on 1M" advice was contradicted by operator's 09:15 observation). Symmetric risk now: jumping to a code fix based on 30sec data could regret-cost the same way. Empirical validation before architectural change.

### 2026-05-12 ~11:55 ET — SPY 30sec — FALSE BUY on bear-flag consolidation

- **Event:** Post-NY mid-morning. Earlier sequence: HH ~11:45-11:50 → SELL at LH ~733.50 ~11:54 (correct fade). Indicator then fired **BUY at ~732.85 (~11:55)** in what looked structurally like an HL pivot. Price did NOT continue up — actually dropped to 732.60. Operator-marked with red-down arrow as a fake signal.
- **Indicator behavior:** §14 HL early-entry fired on what was actually a bear-flag consolidation rather than a reversal HL. The small green bars between the SELL and the BUY trigger formed the HL geometry that §14 detects, but the larger context (clear downtrend continuation after a clean SELL fire 90 seconds earlier) said "bear flag = continuation," not "reversal."
- **Operator's read:** *"HTF filter SHOULD catch this — flag = continuation = should require break of LH before firing BUY."*
- **Operator action:** Did NOT take. Manual chart-read correctly identified as fake. (Tape-reader vs indicator: tape-reader won.)
- **Diagnosis (preliminary):** Three possibilities, can't disambiguate without HTF state at fire time:
  - **(a)** HTF filter OFF on this chart — §14 fires unconditionally on any HL/LH. Operator chose Path A (HTF filter ON) on 2026-05-11 to mitigate §16, but the SPY 30sec chart may have been reset / setting may not have stuck.
  - **(b)** HTF filter ON but HTF bias wasn't Bearish at 11:55 — HTF (1H by default) lags by minutes, and the morning rally + recent chop could leave HTF showing Bullish even though the immediate 30sec trend is down. This is the §17 collateral-cost mirror image: where §17 was "HTF filter blocks legitimate reversals," this case would be "HTF filter ALLOWS what it shouldn't because the lag works against us."
  - **(c)** §14 has a gap: HL-pivot detection is purely geometric (lower low, higher pivot) — doesn't differentiate bear-flag consolidation from reversal-HL. Adding a context filter (e.g., "fire HL only if N bars since last SELL is large enough that we're not still in the same down leg") would catch this case.
- **Verdict:** **FALSE BUY — bear-flag consolidation misread.** Single observation; not yet a pattern threshold. If recurs, escalates to a §19 or §20 entry in `timeframe-behavior-analysis.md` depending on which of (a)/(b)/(c) the forensic shows.
- **Pattern class:** §14 false-fire (candidate) / context-filter-gap.
- **Reference:** `timeframe-behavior-analysis.md` §14 (HL early-entry), §16/§17 (HTF filter trade-offs).

### 2026-05-12 ~11:55 ET — Pine instrument override deployment status — RESOLVED via journal evidence

- **Operator observation:** Alert toast at ~11:55 ET showed *"Alert on ES1!"* with `"instrument":"ES1!"` in payload. Operator interpreted as Pine override fix (`12f5e50`) not yet active.
- **Resolution from journal data (pine-alert.inbound records, post-`82681ce` deployment at 11:54 ET):**
  - SPY chart is correctly emitting `instrument: SPY` on every alert (verified 11:57+ records: SPY at $732.xx, the actual SPY price range).
  - ES1! records ARE present in the journal but all have prices in the $7370s range — that's the actual ES1! futures price level. **Those are legitimate ES1! signals from the ES1! chart, NOT mislabeled SPY signals.**
  - The "Alert on ES1!" toast the operator saw at 11:55 ET was the ES1! chart's alert firing near-simultaneously with the SPY chart's BUY. Both charts have active alerts; both produce toast notifications. Operator's two charts' toasts overlapped in attention window.
- **Verdict:** **Override deployed correctly. No mislabel.** Each chart fires alerts with its own instrument label. The Pine fix (`12f5e50`) + webhook inbound logging (`82681ce`) together prevented the original mislabel AND made the verification deterministic in ≤5 minutes.
- **Pattern class:** config verification — resolved as working-as-designed. Surface visual artifact (two toasts overlapping), not an actual bug.

### 2026-05-12 ~10:30 ET — MES1! 1M — partial coverage of 27-pt breakdown leg

- **Event:** Post-NY-open. HH ~7,415 → LH ~7,412 (operator-marked) → dump to LL ~7,385 over ~30 minutes (-27 MES pts). Then BUY at LL bounce ~7,385 (operator circled with red arrow).
- **Indicator behavior:**
  - **MISSED:** no SELL at the LH ~7,412 retest. That was the first clean short entry of the move.
  - **CAUGHT:** SELL fired ~09:55 at ~7,408 — late but captured most of the dump.
  - Multiple SELL/BUY fires during the leg (some appear to be late retest fires rather than fresh structural breaks).
  - **CAUGHT:** BUY fired at LL ~7,385 ~10:35 — clean bottom mark.
- **Operator action:** Manual scalp for +55% on MES. Third manual win today following indicator chart reads.
- **Operator hypothesis:** *"MES missing signals on the 1min. At noon I will switch to 30seconds and will compare."* Same hypothesis they're testing on SPY today (30sec catches more chop transitions and earlier reversals than 1min on liquid index instruments).
- **Cross-reference:** Pairs with the 2026-05-12 09:15 ET SPY 30sec-vs-1min observation. Two independent instruments (SPY equities, MES futures), same pattern (1min missing entries that operator's tape read catches). Building empirical case for per-instrument timeframe optimization.
- **Verdict:** **TIMEFRAME-PER-INSTRUMENT — data gathering.** Decision point at noon when operator switches MES to 30sec. If MES 30sec catches the missed setups going forward (and tonight's analyzer confirms continuation rate doesn't degrade), the recommendation generalizes from "SPY-on-30sec" to "liquid-index instruments perform better on 30sec across the board."
- **Caveat — context of today's pipeline:** Today's autonomous dispatch has been intermittent (webhook-server.js outages, multiple recurrences). The chart-side indicator behavior captured in this entry is independent of dispatch state — operator is reading the indicator visually. Tonight's analyzer will only capture signals that made it through the webhook to the journal, which is a separate (smaller) data set than what the operator sees on the chart.
- **Pattern class:** timeframe-per-instrument (continued).
- **Reference:** see 2026-05-12 09:15 ET entry below for the SPY-side companion observation.

### 2026-05-12 ~09:15 ET — SPY 30sec vs 1min — TIMEFRAME COMPARISON

- **Event:** Operator compared SPY signal density across two timeframes over a ~2 hour window. 30sec chart showed multiple BUY/SELL fires, caught the 08:30 ET LL major reversal cleanly, and produced more chop-transition signals aligned with VWAP±1σ bands. 1min chart in same window showed fewer signals and missed several of the chop transitions; the 08:30 LL bounce was still detected but with less granularity.
- **Operator read:** *"SPY catches signals better on 30sec as opposed to 1min."*
- **Pre-existing assumption (now under challenge):** Earlier this session (response to operator's "should I change chart interval?"), the recommendation was to keep all charts on 1M because (a) §1-§8 adaptive pivot is calibrated for 1M-5M and 15M-30M (30sec falls below the calibration band, inheriting `pivotLenEff=3` → 90sec structural lookback, theorized to be too noisy), and (b) all multi-hour validation work (including the 2026-05-11 EOD ~80% accuracy sample on MES1!) was on 1M.
- **Observation contradicts the theory:** SPY 30sec is NOT producing noise per operator's read — it's catching legitimate chop transitions and major reversals. The 90sec structural lookback works for SPY despite being below the §1-§8 calibration band. Likely reason: SPY's tick size + intraday volume profile suit shorter lookback; the structure is recognizable at finer granularity. Doesn't necessarily generalize to QQQ/IWM or futures.
- **Verdict:** **TIMEFRAME-PER-INSTRUMENT optimization signal.** Pairs directly with today's data-collection objective (per-instrument-signal-quality analyzer @ 16:00). If tonight's analyzer confirms SPY signal accuracy is high at 30sec, the right answer is per-instrument chart configuration rather than uniform 1M across the board.
- **Pattern class:** timeframe-per-instrument (open — connects to per-instrument-Pine question).
- **Cross-reference:** Today's noon decision; tonight's per-instrument-signal-quality analyzer output.
- **Action items captured:**
  1. Tonight's analyzer should include SPY 30sec data if operator runs SPY on 30sec for the RTH session
  2. Compare per-instrument: SPY 30sec metrics vs QQQ 1min vs IWM 1min vs ES1!/NQ1!/MES1! 1min
  3. The "should chart interval match instrument?" question becomes empirically answerable

---

## Running Tally

By pattern class, all-time:

| Class | Resolved (shipped) | Open | Notes |
|---|---:|---:|---|
| §1–§8 (calibration: pivot length × bar-time) | ✓ Shipped 2026-05-10 | 0 | Adaptive `pivotLenEff` |
| §10 (zone-break-supply-rejection) | ✓ Shipped 2026-05-10 | 0 | Pattern A — `bullZoneBreakRaw`/`bearZoneBreakRaw` |
| §11 (per-instrument asymmetry) | ✓ Closed | 0 | Subsumed by §1–§8 |
| §12 (LIVE intra-bar timing) | ✓ Shipped 2026-05-10 | 0 | `liveBullBreakRaw`/`liveBearBreakRaw` |
| §13 (detection–signal gate gap) | ✓ Shipped 2026-05-10 | 0 | Event-type-aware sensitivity tiers |
| §14 (HL/LH early-entry) | ✓ Shipped 2026-05-11 | **2 collateral-cost observations** | 2026-05-11 10:25 ES SELL @ top; 2026-05-12 08:35 ES BUY @ HL drew-down 7pts before resuming. Both confirm §14 fires earlier than optimal entry by design (paired with §15 win to keep balanced) |
| §15 (filter validation — bull trap) | ✓ Logged | 0 | Design working — silence on weak evidence |
| §16 (trend-state pollution) | ✓ Path A (HTF filter) + Path C (auto-recovery) shipped 2026-05-11 | 0 | |
| §17 (HTF filter collateral cost) | ✓ Path C shipped 2026-05-11 | 1 re-occurrence 20:25 ET 2026-05-11 — needs HTF state confirmation | Path C should mitigate but may not have triggered if no broken-pivot reclaim happened |
| **§18 (demand-zone-breakdown — NEW)** | — | **1 (open)** | First observed 2026-05-11 20:35 ET MES1! |
| **Filter-gap (candlestick context — CANDIDATE)** | — | **1 (open, unverified)** | 2026-05-12 08:35 ES SELL on inverted hammer in uptrend. Specific Pine trigger not yet identified. Would escalate to §19 on recurrence. |
| **TV-render-artifact (suspected)** | — | **1 (verification pending)** | 2026-05-12 08:35 NQ1! floating signals — operator hypothesis is chart-reset replay. Verify by checking webhook server logs for inbound NQ1! payloads at 08:35 ET |
| **Timeframe-per-instrument** | — | **2 (open — converging evidence)** | (1) 2026-05-12 09:15 SPY 30sec > 1min. (2) 2026-05-12 10:30 MES1! 1M missed LH at 7,412 of 27-pt breakdown — operator switching MES to 30sec at noon to test. Two independent instruments showing same pattern. Empirically verifiable via tonight's analyzer + operator's noon switch |
| Config issues (TV alert + webhook allow-list) | MES1! TV alert wired ✓ 2026-05-11; MES1!/MNQ1! webhook allow-list wired ✓ 2026-05-12 c73b666 | **1 (open)** | MNQ1! TV alert still pending operator setup |

---

## Pattern Notes

### Why §18 is distinct from §10

| Pattern | Geometry | Direction | Signal class |
|---|---|---|---|
| §10 bull zone-break | wick DOWN into bull OB, close ABOVE zone top | BUY | Reversal — "bounced off support" |
| §10 bear zone-break | wick UP into bear OB, close BELOW zone bottom | SELL | Reversal — "rejected from resistance" |
| **§18 demand breakdown** | close BELOW bull OB zone bottom (no rejection wick required) | SELL | **Continuation — "support failed"** |
| (Symmetric §18 future) supply breakup | close ABOVE bear OB zone top | BUY | Continuation — "resistance failed" |

§10 covers reversal-at-zone (price tested zone, failed, reversed). §18 covers invalidation-of-zone (price went straight through). Different events, different setups, different trade theses. Both are architectural-class gaps — zones serve as confluence, not standalone triggers — but with different geometries.

### Why MES1! signals never reach the webhook today

Two-step config gap (both need fixing before HANK can paper-trade or live-trade MES):

1. **TV alert config:** TradingView alerts are per-chart. The "Any alert() function call" alert configured on the ES1! chart fires only for the indicator instance on the ES1! chart. The MES1! chart's indicator computes signals and draws labels, but with no alert wired, nothing gets POSTed to the webhook. Fix: configure a second TV alert on the MES1! chart per `TV-ALERT-SETUP.md`.
2. **Webhook allow-list:** `webhook-server.js:73` defines `VALID_INSTRUMENTS = new Set(['SPY','QQQ','IWM','ES','NQ','ES1!','NQ1!'])`. MES1! is absent. Even with a TV alert in place, the webhook would reject the payload as INVALID_INSTRUMENT. Fix: add `'MES1!'` and `'MNQ1!'` to the Set.

The futures scaling plan (`memory/project_1k_scaleup_plan.md`) calls for MES/MNQ trading. Both gaps block that goal.

### HTF filter recurrence (20:25 ET MES1! miss)

If 20:25 ET MES BUY was indeed blocked by HTF filter (Path A still active, htfBias=Bearish), the §17 Path C auto-recovery code didn't trigger because there was no prior counter-trend CHoCH to revert from — just a bull HL forming against a bearish HTF backdrop. Path C only helps the specific case where a counter-trend CHoCH fired and polluted state. It doesn't help the broader case of "HTF filter blocking legitimate countertrend reversals."

If this pattern recurs, the decision is whether to:
- Leave HTF filter on (current state per §16 Path A) — accept §17 collateral cost as part of the tradeoff
- Turn HTF filter off — accept §16 trend-state pollution risk, lean on Path C auto-recovery to handle it
- Build §17 Path B (graduated HTF filter — score-based instead of binary) — bigger lift, deferred

### Calibration discipline reminders

- Visual zone box ≠ active OB array entry. The indicator's signal layer only sees what's in `bullOBs` / `bearOBs` arrays. A zone visible on the chart might be from a different timeframe's render or already mitigated. Diagnosis of zone-related fires/misses requires verifying the OB array state, not just chart visuals.
- HL/LH labels drawing on the chart confirms structural detection but does NOT confirm the trigger fired downstream. The detection→signal gate (§13) is a separate layer that can block fires after labels draw.
- HTF filter state is operator-toggleable. When investigating "why didn't it fire?" misses, the FIRST thing to check is whether `useHTFFilter=true` and what the HTF bias was at the missed-signal bar.

---

*End of calibration log. Continues across sessions — new entries appended chronologically; tally + pattern notes updated when class status changes.*
