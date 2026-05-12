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
