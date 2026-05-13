# Pending Architectural Decisions

Decisions surfaced during 2026-05-12 live trading. **None decided today**, all deferred to a dedicated post-session work block. This document is the canonical decision register — when a fix is shipped, mark it here with the commit hash.

Each decision frames the choice (not just the fix). Pick implementation A/B/C deliberately; understand the trade-offs.

Cross-references:
- Forensic evidence per observation: `smc-pro-calibration-log.md` (2026-05-12 entries)
- Architectural context: `HANK-BRIEFING.md` § "Architectural Observations — Live Trading 2026-05-12"

---

## **FINAL FRAMING — THREE INDEPENDENT AXES (locked 2026-05-12 ~15:35 ET)**

Today's findings decompose into THREE ORTHOGONAL axes. They are independent fixes that compose. Each maps to one or more of the four decisions below.

| Axis | Layer | Maps to Decision | Priority |
|---|---|---|---|
| **1 — Signal timing lag** | Pine code | Decision 1 | **HIGH** — single highest-impact change |
| **2 — Chop noise filter** | Operator workflow | Decisions 2 + 3 | MEDIUM — free, validates further with data |
| **3 — Per-engine gating** | HANK gate logic | **Decision 4 (NEW)** | MEDIUM — requires analyzer output to calibrate |

**Critical:** the 15:30 MES1! 1M observation (12-min lag on 1M, same mechanism as 30sec 60-90sec lag) proved Axes 1 and 2 are independent. Lag scales with bar size — changing bar size doesn't fix lag. Each axis must be addressed separately.

Earlier framing (15:20) collapsed Axes 1+2 into "one synthesized hypothesis"; that was wrong. The 15:35 refinement re-separates them with correct granularity.

---

## **PRIMARY POST-CLOSE INVESTIGATION** — Pivot-Extreme Trigger Hypothesis (Axis 1 → Decision 1-D)

Logged 2026-05-12 ~15:20 ET; refined 15:35. The synthesis-as-single-fix framing was wrong, but the **specific Pine fix** (sweep+vol+candle confluence trigger at pivot extreme) is still the highest-value engineering change available — it just addresses Axis 1 only, not all three.

### The hypothesis

> **Fire BUY at the LL bar itself (when sweep + volume + reversal-candle align). Fire SELL at the HH bar (with mirror confluence). Combine with 1M timeframe as default.**

Single Pine architectural change that simultaneously addresses:
- Signal timing lag (Decision 1) — entries happen at the pivot, not at CHoCH confirmation
- Chop filtering (Decision 2) — 1M timeframe naturally averages out micro-pullback false sweeps
- Time-of-day timeframe rule (Decision 3) — same change

The trap-rate problem of "sweep-as-trigger" (Decision 1-A's main risk) is mitigated by the 1M timeframe (Decision 2/3-A). They reinforce each other.

### Empirical investigation plan (post-close)

The investigation IS bounded — uses today's already-captured data, no new live runs needed.

1. **Count today's signal-driven trades** (engine ≠ SWING, not test probes). Operator estimated ~33; actual will be in ledger filter.
2. **For each trade**: find the bar timestamp of the structural extreme (LL or HH) preceding the entry. The extreme bar = where bullSweepRaw / bearSweepRaw fired most recently before the actual fire bar.
3. **For each trade**: identify the bar gap between extreme and entry. On 30sec that's typically 2-3 bars (60-90s). On 1M typically 1-2 bars.
4. **Replay**: assume entry had happened at the extreme bar instead. Compute hypothetical:
   - Hypothetical fillPrice = synthesized from underlying price at extreme bar
   - Hypothetical exitPrice = same as actual (exit logic unchanged in hypothesis)
   - Hypothetical pnl
5. **Categorize**: did the replay improve, neutral, or worsen the outcome? Tabulate by:
   - Engine (BUY/SELL/HL/LH/ZONE/HTF)
   - Instrument
   - Timeframe (30sec on SPY today, 1M on other instruments)
6. **Decision criterion**: if replay shows ≥60% of losing trades become wins or breakeven (and <10% of winning trades become losses), proceed to ship sweep-as-trigger with sweep+volume+reversal-candle filter, recommend 1M-by-default for SPY/MES.

### Pine change sketch (if investigation favorable)

```pine
// New synthesized trigger — fires at pivot extreme with confluence
bullPivotEntry = bullSweepRaw and volSpike and closeNearHigh
bearPivotEntry = bearSweepRaw and volSpike and closeNearLow

// Add to bullBreak / bearBreak OR-chain
bullBreak := bullBOSraw or bullCHOraw or bullZoneBreakRaw or bullHLraw or bullPivotEntry
bearBreak := bearBOSraw or bearCHOraw or bearZoneBreakRaw or bearLHraw or bearPivotEntry
```

Estimate ~10-15 LOC including the new input toggle (`enablePivotEntry`, default true once vetted), threshold inputs (already exist as `liveVolMult` and `liveExtremeRatio`).

### Why this should be Investigation #1 post-close

If favorable: collapses 3 decisions into 1 implementation. Largest possible improvement-per-LOC.
If unfavorable: rules out the dominant hypothesis cleanly, refocuses Decisions 1/2/3 as separate problems.
Either way: empirical answer using today's data, no risk of premature implementation.

**Failure modes the investigation must distinguish:**
- Pivot-extreme entry fires at every wick (high trap rate even on 1M) → hypothesis fails, Decision 1 needs a different solve
- Pivot-extreme entry on 30sec gets trapped but on 1M works → confirms timeframe-as-trap-filter, hypothesis valid with TF caveat
- Pivot-extreme entry works on both timeframes → strongest result, ship the change and update default TF guidance

### Refinement from 15:30 ET MES1! 1M observation

The 15:30 observation (MES1! HL at 15:18, BUY fired at 15:30 — 12-minute gap on **1M**) refines the synthesis:

**The lag is NOT a timeframe choice.** Same lag mechanism, different absolute time:
- 30sec: 60-90 sec lag (2-3 bars from sweep to CHoCH fire)
- 1M: 3-12 min lag (3-12 bars from pivot to CHoCH fire — scales with bar size)

**Implication:** Decisions 1, 2, 3 are **orthogonal**, not substitutable:

| Decision | Axis | Composes with others? |
|---|---|---|
| 1 (timing lag) | Pine pivot-extreme trigger | Yes — independent of timeframe |
| 2 (chop filter) | Operator workflow / Pine input | Yes — independent of trigger |
| 3 (time-of-day) | Operator workflow | Composes with 2 |

The synthesis collapses **WHERE the change is made** (Pine code + operator workflow), not **WHETHER each axis needs addressing**. The Pine fix (sweep + volume + reversal-candle confluence trigger at the pivot extreme) is required regardless of timeframe choice. The 1M timeframe is useful for chop filtering but does NOT solve the lag.

**Updated recommendation:**
- Ship Decision 1 fix (pivot-extreme trigger with confluence) as a Pine code change — primary post-close engineering work
- Adopt Decision 2-A + 3-A (operator-side timeframe switching by schedule) as a workflow — no code, validates today's chop-filter hypothesis with more data
- Together they recover both the entry-timing edge AND the chop-noise filter

---

## Decision 1 — Signal Timing Lag (Sweep vs Confirmation)

### The choice

**Should the indicator fire BUY/SELL on sweep detection (operator's manual entry point) or on structural confirmation (current behavior — adds 2-3 bar lag on 30sec)?**

These are not equivalent settings of the same dial. They reflect different trading philosophies:

| Approach | Entry timing | Trap rate | Operator-context required |
|---|---|---|---|
| Structure-confirmed (current) | Late (post-sweep) | Low | None — system is self-sufficient but slow |
| Sweep-triggered | Optimal | High — many failed sweeps | None at code, but high implicit context (every sweep is a bet) |
| Hybrid (sweep + confluence) | Near-optimal | Medium | Filter quality depends on confluence rules |

### Implementation options

**A. Two-stage signal: Tier 1 alert at sweep, Tier 2 alert at confirmation**
- Pine emits TWO distinct alert() calls per setup: `SWEEP_BULL_T1` at `bullSweepRaw` fire, `BUY_T2` at structural break
- Webhook receives both, operator/HANK decides what to do with each
- Default behavior: HANK trades only on T2 (preserves current safety); T1 alerts surface in webhook journal for analysis
- After 1-2 weeks of T1-vs-T2 win-rate data, decide whether to enable T1 dispatch
- ~15-20 LOC Pine + ~5 LOC webhook routing
- **Pros:** Zero behavior change to HANK initially. Empirical decision basis. Operator gets early alerts for manual entries.
- **Cons:** Two alerts per setup increases TV-side configuration overhead. Need a way to flag T1 vs T2 in payload.

**B. Trail-the-sweep: arm entry state on sweep, fire if structural confirmation within N bars**
- Pine internal state machine: when `bullSweepRaw` fires, enter "armed" state for next N bars (e.g., 3 on 30sec)
- If structural confirmation arrives within N bars, fire BUY with `armed=true` flag → HANK enters at confirmation as today, BUT with a flag indicating it was a sweep-confirmed setup
- If N bars elapse with no confirmation, drop the armed state (reset to normal)
- ~25 LOC Pine
- **Pros:** No new alert type. Preserves current safety (still fires at confirmation). Adds metadata about quality.
- **Cons:** Doesn't actually solve the timing lag — entries still happen at confirmation bar. The `armed=true` flag is observability, not earlier entry. May not satisfy the operator's stated need.

**C. Different signal threshold per timeframe**
- Add `enableSweepEntry` input that fires BUY/SELL at sweep on timeframes ≤ 1M (where the lag matters most), keeps structure-confirmed on higher timeframes
- ~10 LOC Pine
- **Pros:** Matches the empirical observation that lag is timeframe-dependent.
- **Cons:** Different behaviors per chart confuses the mental model. Operator has to remember which chart fires when.

### Recommendation

**Ship A first** as observability play (T1 alerts in journal, HANK still dispatches only T2 today). After 5+ sessions of paired T1/T2 data, the win-rate delta tells us empirically whether to graduate to T1 dispatch. This is the lowest-risk path with the highest-quality decision basis.

If timing pressure (we WANT this to work tomorrow), **C** is the fastest ship — but accept that we're committing to sweep-as-trigger on 30sec/1M without data to validate it.

**Operator decision required:** A / B / C / defer.

---

## Decision 2 — Chop Detection

### The choice

**Should HANK trade through chop periods, suppress fires during chop, or rely on operator-side regime switching?**

Operator's quote frames the constraint: *"This just cannot be traded, not even by me."* A discretionary trader can sit out 20 minutes of midday chop trivially. HANK currently can't recognize the chop, so it fires every structural pivot anyway — and each fire becomes a SIGNAL_REVERSAL whipsaw loss.

### Implementation options

**A. Operator-side: manual timeframe switch at fixed time of day**
- No code change. Operator switches SPY chart timeframe at predictable times (e.g., 30sec → 1m at 13:00 ET → 30sec at 15:00 ET)
- 1m chart smooths the chop bars; same Pine indicator, fewer alerts during chop, similar capture during real moves
- 0 LOC
- **Pros:** Free. Reversible. Aligns with operator's stated intuition. No new failure modes.
- **Cons:** Requires operator attention. Doesn't help other instruments. Wrong timing of the switch costs the morning's 30sec advantage.

**B. Pine-side: ATR-based chop detection that suspends BUY/SELL fires**
- New Pine inputs: `enableChopSuppression` (bool), `chopATRThreshold` (% of recent ATR — default 0.5), `chopBarLookback` (default 10)
- Logic: compute high-low range over last N bars. If max range < threshold × ATR(14), set `inChop = true`. Suppress `buyTrigger` and `sellTrigger` (but keep `bullBreak` / `bearBreak` raw for visual indicators).
- ~20 LOC Pine
- **Pros:** Automated. Per-chart configurable. Operator can override via input toggle.
- **Cons:** Threshold needs tuning per timeframe and instrument. May suppress legitimate quiet-coil-before-breakout setups.

**C. HANK-side: chop detection in monitor.js or webhook-server.js**
- Detect chop from the live POLL data stream (price range over N polls) and reject incoming Pine alerts when chop is active
- ~15 LOC across webhook-server.js + a chop-state file or in-memory cache
- **Pros:** Doesn't require Pine code paste (no chart reconfig). Operator-toggleable via env flag. Centralized — one chop detector covers all charts.
- **Cons:** HANK becomes a second gatekeeper layer; complicates "what gets dispatched and why" debugging. Pine still fires alerts internally; HANK silently drops them.

### Recommendation

**A first**, as a 2-3 session experiment. Cheap, fast, validates the operator's timeframe-as-filter hypothesis with zero code risk. If A works empirically (chop losses drop, directional capture preserved), the question becomes "is automation worth the complexity" — that's when B or C becomes valuable.

**If A is insufficient (operator doesn't want to manage timing manually), B is the cleaner second step.** Pine-side keeps the logic close to the signal source.

**C is the right answer if** future cross-instrument chop coordination becomes a requirement (e.g., "suppress all signals when SPY 5m bands are tight, regardless of which instrument fires").

**Operator decision required:** A / B / C / defer.

### Empirical update (2026-05-12 ~15:00 ET)

Same afternoon-chop window (14:25-15:00 ET) compared across timeframes:
- SPY 30sec: 6-8 fires in 20 min within a 4-6¢ range — all losing trades
- MES1! 1M: 2 fires in 35 min within a 12-pt range — top and bottom of range only, minimal noise

Operator-validated, paired-timeframe data supports **option A** as effective without code changes. Promotes A from "recommended starting fix" to "empirically validated starting fix." Caveats: single-day data, different instruments (SPY vs MES) — need 3-5 sessions of same-instrument paired observations before confident generalization.

---

## Decision 3 — Time-of-Day Timeframe Rule

### The choice

**Should HANK formalize the time-of-day timeframe pattern (30sec for directional periods, 1m for chop periods) into code, or keep it as an operator-side play?**

This is partially the same decision as #2 but framed by time-of-day rather than chop detection. Different decision-tree leaves but related.

Today's empirical pattern (single data point — needs 3-5 sessions confirmation):

```
08:00-09:15 ET (pre-market):  30sec wins (catches early moves)
09:30-13:00 ET (morning):     30sec wins (directional moves)
13:00-15:00 ET (midday):      30sec loses (chop)
15:00-16:00 ET (power hour):  TBD
```

### Implementation options

**A. Manual operator switch on the chart timeframe at fixed times**
- Pure operator workflow. No code.
- Schedule: 30sec → 1m at 13:00 ET → 30sec at 15:00 ET (or some refinement)
- 0 LOC
- **Pros:** Free. Easiest to roll back if pattern doesn't hold. Composable with operator's discretionary judgment.
- **Cons:** Operator attention required. Schedule may not generalize across calendar (option-expiration Fridays differ, news days differ).

**B. Adaptive timeframe based on chop detection (composes with Decision 2)**
- If Decision 2 ships B or C, an additional logic layer can dynamically request a different Pine indicator instance (or different alert behavior) when chop state is detected
- Significant complexity (Pine doesn't easily support timeframe-aware behavior — would need separate alerts per timeframe with HANK-side routing)
- ~50+ LOC across Pine + HANK
- **Cons:** Largest implementation cost in this document. Probably not worth shipping unless A and B both fail.

**C. Parallel 30sec + 1min alerts — HANK picks based on chop state**
- Run TWO TV alerts per instrument (one on the 30sec chart, one on the 1min chart) sending both to the webhook
- HANK decides which to honor based on the inbound chop signal (could be Pine-emitted via Decision 2-B/C, OR HANK-detected via Decision 2-C)
- ~30 LOC HANK + 2x TV alert config overhead
- **Pros:** Both timeframes' data available to HANK simultaneously. Switching is internal logic, not chart reconfiguration.
- **Cons:** Operator-side TV alert config grows 2x. Both alert subscriptions need to stay valid.

### Recommendation

**A**, full stop. The pattern is one day's data. Operator-side manual switching costs nothing and IS the experiment we need to run to validate the time-of-day hypothesis.

Decisions 2 and 3 are entangled — both speak to "the indicator is wrong for the current regime." If the post-close decision is to ship Decision 2-B (Pine chop detection), Decision 3-B becomes natural composition. Until then, A on both makes sense.

**Operator decision required:** A / B / C / defer.

### Empirical update (2026-05-12 ~15:00 ET) — schedule hypothesis

Operator end-of-session proposed schedule (1-day empirical basis):

| Time | Timeframe | Regime expected |
|---|---|---|
| 09:30-13:00 ET | 30sec | Directional morning moves |
| 13:00-15:30 ET | 1m | Afternoon chop |
| 15:30-16:00 ET | TBD | Power hour — operator judgment |

This is the **starting schedule** to test in option A. Validation criteria after 3-5 sessions:
- Did the 30sec window catch real morning moves? (Expected yes, observed today)
- Did the 1m window avoid chop losses? (Today's MES 1M data says yes — 2 fires vs SPY 30sec's 6-8 in same window)
- Did the power-hour window need a default or stay operator-judgment? (Today doesn't fully cover yet)

If 5 sessions all show clean separation: A is validated, no need to ship B/C.
If results are mixed (some chop periods missed): graduate to B (Pine-side detection) or C (parallel alerts).

---

## Decision 4 — Per-Engine Gating (Axis 3, NEW — added 2026-05-12 ~15:35 ET)

### The choice

**Should HANK apply different gate strictness to different engines based on their empirical win rate?**

Today's data suggests asymmetric engine performance:

| Engine | Today's observed pattern |
|---|---|
| BUY | When it wins, wins big (+$80 on the 13:37 SPY example). Mixed in chop. |
| SELL | Similar to BUY — structural breaks pay when right |
| STRUCTURE | Consistent with BUY/SELL, similar reliability |
| HL / LH | High loss rate today (especially in chop/trend-context-blind scenarios) |
| ZONE | Highest loss rate today on counter-trend / chop fires |
| HTF | Single HIGH-confidence fire today; outcome mixed |

Hypothesis: gates should be permissive for high-WR engines (BUY/SELL/STRUCTURE), strict for low-WR engines (ZONE/HL/LH). Could manifest as:
- Different concurrent-position caps per engine (e.g., HL/LH limited to 1 open, BUY/SELL allowed 2)
- Different confidence thresholds per engine (e.g., HL needs finalConfidence ≥ 1.2, BUY just ≥ 0.65)
- Different SIGNAL_REVERSAL behavior per engine (HL/LH positions close faster, BUY positions hold longer)

### Implementation options

**A. Per-engine concurrent-position cap.** Add `engineCaps` map in `tier.js`. ZONE/HL/LH limited to 1; BUY/SELL/STRUCTURE limited to tier.perInstrumentCap. ~15 LOC `tier.js` + `paperTrading.js`.
- **Pros:** Simple. Per-tier configurable. Composes with existing cap system.
- **Cons:** Doesn't address quality of individual signals — just bounds them.

**B. Per-engine confidence threshold.** Add `engineMinConfidence` map. ZONE/HL/LH require finalConfidence ≥ 1.2 (HIGH-band only); BUY/SELL ≥ 0.65 (LOW band). ~10 LOC.
- **Pros:** Directly targets low-WR engines without blocking entirely. Operator can tune per-engine.
- **Cons:** Confidence in webhook payload is just "HIGH"/"MEDIUM" labels — would need to map to numeric ranges in webhook-server.js.

**C. Per-engine SIGNAL_REVERSAL handling.** ZONE/HL/LH positions auto-close on any opposite signal (current behavior). BUY/SELL/STRUCTURE positions require multi-engine opposite confirmation. ~20 LOC webhook-server.js.
- **Pros:** Addresses the SIGNAL_REVERSAL whipsaw pattern directly. Matches operator's observation that BUY signals are reliable.
- **Cons:** More complex. Per-engine policy logic.

### Recommendation

**B first** (per-engine confidence threshold). Lowest implementation cost, directly leverages the existing confidence-band system from `tier.js`, easy to roll back per-engine.

**Calibration data status (updated 2026-05-12 22:00 ET):** Today's analyzer output (`per-instrument-signal-quality-2026-05-12.md`) is **INVALID for calibration** — see the caveat at the top of that file. The session had multiple infrastructure failures (pricing bug, monitor crash, webhook crashes, misrouted alerts) that contaminate the per-engine and per-instrument metrics. **Wait for a clean-infrastructure session** (≥1 day with zero mid-session code restarts and no data-write bugs) before tuning per-engine thresholds. "IWM laggard" / "QQQ leader" framings from 2026-05-12 are noise contaminated by infra issues, not signal-quality signal.

**Operator decision required:** A / B / C / defer.

---

## Status of all today's pattern observations

| # | Pattern | Axis | Decision register | Recommended starting fix |
|---|---|---|---|---|
| 1 | Trend-context blindness | Axis 1 / Axis 3 | Decision 1 + Decision 4 | A on each |
| 2 | Signal timing lag (sweep vs confirmation) | Axis 1 | **Decision 1** | A (two-stage signal) — primary engineering work post-close |
| 3 | SIGNAL_REVERSAL whipsaw on chop | Axis 2 / Axis 3 | Decision 2 + Decision 4 | Axis 2 via Decision 2-A; Axis 3 via Decision 4 |
| 4 | Chop detection | Axis 2 | **Decision 2** | A (operator-side timeframe switch) — validated today |
| 5 | Time-of-day timeframe | Axis 2 | **Decision 3** | A (manual switching) — validated today |
| 6 | Pivot-extreme trigger validation (15:20 + 15:30) | Axis 1 | **Decision 1** | Primary investigation #1 |
| 7 | Per-engine WR asymmetry (15:35 frame) | Axis 3 | **Decision 4** | B (per-engine confidence threshold) — needs 16:02 analyzer output to calibrate |
| 8 | HARD_EXIT near-close losses (15:42-15:43) | Axis 3 (HANK gate) | **Decision 5** | B then A — investigate pricing math first, then ship time-window gate if real |

All 8 patterns map cleanly into the 3-axis frame. No remainder.

---

## Decision 5 — HARD_EXIT Near-Close Behavior (NEW — added 2026-05-12 ~16:00 ET — **SHIPPED 2026-05-12 ~16:35 ET**)

### Resolution

**Investigated (Option B) and shipped (Option A) in same session.**

- **Pricing math investigation:** Black-Scholes pricing chain in `monitor.js:3013-3026` → `theta.js:98` verified correct. Frozen entryIV used as σ (slightly punitive vs real-market vol ramp into close, but qualitatively right). Manual BS calc for the PUTS HTF trade (S=737.81, K=737, T=2min, σ=1.08) returned ~$0.35; simulator returned $0.497 — same ballpark, consistent with slight underlying movement at exit. **No bug.** Losses are real theta-burn on near-ATM 0DTE entered 15-16 min before close. Hypothesis 1 (artifact) REJECTED; Hypothesis 2 (real-loss-from-late-entry) CONFIRMED.

- **Gate shipped (Option A):** `webhook-server.js` — LATE_DAY_ENTRY_0DTE gate at 15:30 ET cutoff for SPY/QQQ/IWM. Placed AFTER SIGNAL_REVERSAL block so opposite-direction alerts can still close existing positions through the window. Futures (ES/NQ/MES/MNQ) excluded — different expiry mechanics, no daily theta-to-zero collapse.

Commit hash: (filled by commit) — `feat(webhook): LATE_DAY_ENTRY_0DTE gate at 15:30 ET — close Decision 5`

### The choice

**Should HANK suppress new entries in the final ~10 minutes before the 15:45 RTH cutoff?**

Today's end-of-day pair (15:42:31 PUTS HTF -$99.20, 15:43:01 CALLS BUY -$69.99 — both exited via `HARD_EXIT` at heavily discounted prices) is a **new pattern not seen earlier in the session**. The 15:07:30 power-hour winners exited cleanly via SIGNAL_REVERSAL; the 15:42-15:43 entries hit HARD_EXIT minutes later.

Hypotheses (mutually non-exclusive):
1. **EOD pricing artifact** — `HARD_EXIT` simulation prices options at a heavy theta-adjusted discount; the realized loss isn't representative of how a live broker would mark/close those positions
2. **Real loss from late entry** — positions opened 3 min before RTH cutoff don't have time to play out; the move is over and entries near close are systematically lower-edge
3. **Compound of 1 + 2** — both contribute

### Implementation options

**A. Time-window entry suppression in webhook-server.js.** Reject inbound Pine alerts between 15:35 and 15:45 ET with a `jGateBlock('LATE_DAY_ENTRY')`. ~10 LOC.
- **Pros:** Free. Trivial to roll back. Aligns with operator-discretionary practice ("don't open new trades 10 min before close").
- **Cons:** Cuts off legitimate late-day setups (today's 15:07:30 winner would NOT be affected — that's outside the window).

**B. HARD_EXIT pricing investigation only.** No code change. Read paperTrading.js's HARD_EXIT branch, determine if the exit price computation is artifact-prone. Decide A/C from forensic understanding rather than reflexive gate.
- **Pros:** Distinguishes hypothesis 1 from hypothesis 2 before adding gate logic.
- **Cons:** Defers the operational fix; tomorrow could see the same pattern again.

**C. Per-engine late-day handling.** BUY/SELL allowed until 15:40, HL/LH/ZONE/HTF cut off at 15:35. Composes with Decision 4.
- **Pros:** Surgical, leverages today's per-engine asymmetry observation.
- **Cons:** Adds another tier of per-engine policy state. Slightly more complex than A.

### Recommendation

**B then A.** Read the HARD_EXIT code path FIRST to determine whether the loss is artifact or real. If artifact: fix the pricing math; A becomes unnecessary. If real: ship A as the conservative default; revisit C after Decision 4 lands.

**Operator decision required:** A / B / C / defer.

---

## How to use this document

Operator: read at the start of any post-session decision block. Each decision can be made independently. The recommended fix is conservative — pick A if you're not sure.

After a decision: 
1. Update the relevant section with the chosen path
2. Reference the commit hash that implements it
3. Mark the decision "shipped" with date

If a fix proves wrong: this doc captures the original alternatives, making rollback or pivot to B/C low-effort.

*Created 2026-05-12 EOD pending post-close review.*

---

## Open Hypothesis — Pine Configuration Drift Across Charts (logged 2026-05-13)

**Not a decision yet.** Observation worth investigating during the weekend Electron session.

### Pattern

Across multiple sessions (Tuesday + Wednesday confirmed), Pine signal-firing latency is **consistently asymmetric across instruments on identical setups**:

| Pair | Leader (fires earlier) | Lagger (fires later) |
|---|---|---|
| ES vs NQ | **NQ** | ES |
| SPY vs QQQ | **QQQ** | SPY |

The lagging instruments are consistent (ES, SPY). The leaders are consistent (NQ, QQQ). Today's 09:47 SPY LL → 09:55 BUY (8-min gap, entire bounce missed by HANK while operator captured it manually) is one concrete example; ES vs NQ on the same structural break events the same pattern.

### Hypothesis

The 6 instrument charts may have **drifted apart in their Pine configurations** over weeks of per-chart tweaks. Lagging charts may have:
- Stricter zone-confluence requirements (more overlay scripts needing to align)
- Tighter volume thresholds (fewer bars qualify as "volume confirmation")
- Larger minimum-displacement thresholds (smaller moves don't trigger)
- Denser overlay scripts (Supply 1H/4H + Demand 1H + VWAP±1σ + PDH/PDL/PDC + FVG on SPY vs leaner stack on QQQ)
- Different `Signal cooldown (bars)` settings
- Per-chart instrument override (committed `12f5e50` 2026-05-12) potentially overriding signal logic, not just labels

### Action

**Saturday weekend Electron session: side-by-side Pine settings audit of all 6 charts.** Dump every input value for SMC Pro on SPY / QQQ / IWM / ES1! / NQ1! / MES1!, compare column-by-column. Any differences = drift to either reconcile or document as intentional.

### Why not tonight

Diagnosing requires chart-by-chart screen capture and Pine settings dialog inspection — that's MCP-tool-with-chart-access work or operator visual work, not log analysis. Better as a focused 30-min audit Saturday than ad-hoc investigation during RTH.

### Connection to other decisions

- Independent of Decisions 1-5 (those are all post-Pine fixes). This is upstream — a configuration drift, not an architecture flaw.
- If drift is found and reconciled, the SPY-late-fire pattern from today's per-instrument investigation may resolve without any HANK-side code change.
- Composes with Decision 1 (timing-lag fix): even if Pine settings are reconciled, the structure-confirmation-vs-sweep timing lag is still real and Decision 1 still applies.

*Logged 2026-05-13 EOD pending weekend audit.*
