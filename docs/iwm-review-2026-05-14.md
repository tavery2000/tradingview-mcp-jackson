# IWM Logic Deep-Dive — 2026-05-14

**Author:** Claude Code (P2-15 weekend operator-review prep)
**Status:** ANALYSIS-ONLY for operator review. IWM is currently SUSPENDED at the webhook layer (commit `069edb4`, P1-8). Re-enable decision deferred to operator weekend review.

---

## Headline numbers (today)

| Metric | Value |
|---|---|
| Total IWM trades | 38 |
| Win rate | 13.2% |
| Net P&L | -$973.01 |
| Average per trade | -$25.61 |
| Largest single loss | -$57 (multiple PUTS @ $0.57 → $0.00) |
| Largest single win | +$32 (SWING CALL at 09:30:06) |

For context, today's profitable instruments:
- ES1!: 47.9% WR, +$1,870
- MES1!: 47.1% WR, +$1,580

IWM's WR is 28pp below the next-worst (NQ1! 34%) and 35pp below the best.

---

## Performance by engine (IWM-only)

| Engine | n | W | WR | Net P&L | Note |
|---|---:|---:|---:|---:|---|
| HL | 10 | 1 | 10% | -$56 | Higher-low signals not converting |
| **LH** | 10 | 0 | **0%** | -$410 | Counter-trend on trending day; 100% loss rate |
| **SELL** | 7 | 0 | **0%** | -$302 | Counter-trend; same pattern |
| BUY | 5 | 3 | 60% | -$2 | Worked but small dollar amounts |
| ZONE | 5 | 0 | 0% | -$235 | All losers |
| SWING | 1 | 1 | 100% | +$32 | Lone winner — 09:30 V-reversal entry |

**Pattern:** all bearish-direction engines (LH, SELL) had 0% WR. ZONE was also all losers. Only directional CALLS engines (BUY, SWING) showed any wins, and even BUY netted ~zero despite 60% WR (wins too small to outpace small losses).

---

## Performance by direction

| Dir | n | W | Net P&L |
|---|---:|---:|---:|
| CALLS | 17 | 5 | -$32 |
| **PUTS** | **21** | **0** | **-$941** |

PUTS were the killer. Today's macro-4H direction was UP for IWM family (per the COUNTER_TREND gate not triggering them — they bypassed and bled). 21 PUTS trades, ZERO winners. -$941 of a -$973 total.

---

## Performance by hour

| Hour ET | n | Net P&L |
|---|---:|---:|
| 09 | 1 | +$32 |
| 11 | 9 | -$76 |
| 12 | 4 | -$37 |
| 13 | 8 | -$265 |
| 14 | 9 | -$332 |
| 15 | 7 | -$295 |

Bleed accelerated through the afternoon. 13:00-15:59 = -$892 of the -$973 total.

---

## Worst trades — pattern

5 worst IWM trades all share these features:
- All PUTS
- Engines: LH, SELL (mostly)
- Fill price: $0.57 (suggests far-OTM 0DTE PUT entry that never recovered)
- Exit price: $0.00 (option went worthless)
- Exit reason: STOP_LOSS (after 13:15 — when the new stop-loss code activated)

These are 0DTE PUT positions where the underlying moved AGAINST the trade and the option premium decayed to the price floor. STOP_LOSS_PCT=30 fired but caught them after they'd already lost most of their value.

---

## Volume / liquidity profile (vs SPY/QQQ)

(Operator domain knowledge — confirmation requested)

IWM is generally:
- Lower options volume than SPY/QQQ
- Wider bid-ask spreads (proportionally)
- More susceptible to single-stock moves in the Russell 2000 components
- Less consistent intraday trend behavior than SPY/QQQ

Today's IWM premium of $0.57 for ATM 0DTE suggests:
- IV percentile likely elevated (premium is rich vs underlying-distance)
- Or operator-flagged "structurally broken" Pine logic puts entries at fixed-fill regardless of liquidity context

---

## Hypothesis space — why IWM specifically

1. **Liquidity-driven slippage.** IWM 0DTE has wider spreads → fills are worse vs displayed mid → losses larger than SPY/QQQ on equivalent setups.
2. **Russell 2000 component noise.** 2000 stocks vs SPY's 500. Single-stock surprises (earnings, micro-caps) move IWM differently than SPY's mega-cap-driven moves. Pine's mag-3 signal logic (BE, CRDO, FN) may not capture this.
3. **Pine engine logic may not be tuned for IWM specifically.** The chart-engine framework was designed for SPY tape; IWM's tape behavior (lower volume, wider ranges, single-stock moves) may not fit the same engine triggers.
4. **5m timeframe might suit IWM better than 1m.** IWM 1m has more noise relative to true signal vs SPY 1m. Operator's question about 5m-from-open is well-founded.
5. **Counter-trend exposure.** 21 PUTS / 0 wins on a UP-trending day shows the system was systematically wrong-side on IWM. Counter-trend down_weight didn't suppress them; equity counter-trend remains at 0.6× (P1-7 didn't escalate equity to block).

---

## Operator weekend-review questions

1. **Is 13.2% WR consistent with IWM history, or anomalous?** Need 5-day rolling WR for IWM to know if today is the bottom of normal variance or a structural break. Pull from prior session-report files or query journal across ledger history.

2. **Should IWM use 5m from market open?** Today's 1m data drove many high-frequency entries that lost small. 5m would cut entry frequency by ~5× and reduce noise. Could test by setting AM_RESOLUTION=5 specifically for IWM (would require per-instrument timeframe override — not currently in code).

3. **Should IWM counter-trend escalate to BLOCK?** P1-7 set futures to BLOCK; equity stayed at down_weight. IWM today: 21 PUTS, 0 wins on UP day — block would have prevented all of them. Tradeoff: IWM bullish-bias days would also block CALLS (asymmetric loss).

4. **Should IWM signal threshold tighten?** Current thresholds work for SPY/QQQ. IWM may need higher confidence cutoff (e.g., HIGH only, no MEDIUM) to weed out noise.

5. **Should IWM be permanently suspended pending Pine logic redesign?** Would simplify the system — operator focuses on SPY/QQQ + futures Path 2. Re-enable later if/when IWM-specific logic is built.

---

## Recommendations (priority-ranked, deferred to operator)

| Priority | Action | Effort |
|---|---|---|
| P1 | Pull 5-day IWM history to confirm 13.2% WR is structural vs anomaly | 30 min analysis |
| P1 | If structural: add IWM-specific counter-trend mode (`COUNTER_TREND_IWM_MODE=block`) | 30 min |
| P2 | Test 5m-from-open for IWM via per-instrument timeframe override | 1-2 hr build |
| P2 | Tighten IWM confidence threshold (HIGH-only) via signalConfidence.js | 30 min |
| P3 | Operator review of Pine engine logic for IWM-specific tuning | weekend session |
| P3 | If consistently broken, suspend permanently → focus on SPY/QQQ + Path 2 futures | config change |

---

## Friday morning state

**IWM trading is CURRENTLY SUSPENDED.** Webhook rejects all IWM alerts with `INSTRUMENT_DISABLED` (commit `069edb4`). 

To re-enable: edit .env, remove `IWM` from `INSTRUMENT_DISABLED=` list (or empty the value), restart webhook.

Recommendation: keep suspended through Monday. Make re-enable decision after weekend review of the questions above + observation of IWM's 5-day historical pattern.
