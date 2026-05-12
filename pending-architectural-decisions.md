# Pending Architectural Decisions

Decisions surfaced during 2026-05-12 live trading. **None decided today**, all deferred to a dedicated post-session work block. This document is the canonical decision register — when a fix is shipped, mark it here with the commit hash.

Each decision frames the choice (not just the fix). Pick implementation A/B/C deliberately; understand the trade-offs.

Cross-references:
- Forensic evidence per observation: `smc-pro-calibration-log.md` (2026-05-12 entries)
- Architectural context: `HANK-BRIEFING.md` § "Architectural Observations — Live Trading 2026-05-12"

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

## Status of all today's pattern observations

| # | Pattern | Decision register | Recommended starting fix |
|---|---|---|---|
| 1 | Trend-context blindness (false BUY/SELL on bull/bear flags) | Not formalized in this doc — see `smc-pro-calibration-log.md` and pattern entry there | Defer until ≥1 paired 1M/30sec session of data exists |
| 2 | Signal timing lag (sweep vs confirmation) | **Decision 1 above** | A (two-stage signal) |
| 3 | SIGNAL_REVERSAL whipsaw on chop | Not formalized — see calibration log | ε (multi-engine opposite confirmation) — entangled with Decision 2 |
| 4 | Chop detection | **Decision 2 above** | A (operator-side timeframe switch) |
| 5 | Time-of-day timeframe | **Decision 3 above** | A (manual switching as data-gathering) |

Patterns 1 and 3 are not in this doc yet because they're either entangled with Decisions 1-3 (3 with 1) or premature without more data (1 needs paired-TF data).

---

## How to use this document

Operator: read at the start of any post-session decision block. Each decision can be made independently. The recommended fix is conservative — pick A if you're not sure.

After a decision: 
1. Update the relevant section with the chosen path
2. Reference the commit hash that implements it
3. Mark the decision "shipped" with date

If a fix proves wrong: this doc captures the original alternatives, making rollback or pivot to B/C low-effort.

*Created 2026-05-12 EOD pending post-close review.*
