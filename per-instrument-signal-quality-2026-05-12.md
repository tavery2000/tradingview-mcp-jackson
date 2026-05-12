# Per-Instrument Signal Quality — 2026-05-12

> **⚠ DATA VALIDITY CAVEAT (added 2026-05-12 22:00 ET):**
>
> This report was generated during a session with multiple infrastructure
> failures: +$1.00 pricing bug (fixed 1cdf278), monitor.js crash + stale
> spy-levels.json early in session (fixed cfe6aa2), webhook-server.js
> crash + 4 deliberate restarts, misrouted SPY/MES alerts before per-chart
> Pine instrument override (fixed 12f5e50).
>
> **The per-instrument win rates, continuation rates, and engine
> breakdowns below MUST NOT be used to inform Decision 4 (per-engine
> gating) or per-instrument threshold tuning.** "IWM is laggard" /
> "QQQ leads" / engine-by-engine numbers are noise contaminated by
> the day's infrastructure issues. Re-measure under clean-session
> conditions (≥1 day with no mid-session code restarts) before treating
> these numbers as calibration input.
>
> The report is retained as historical record of today's session and
> as a reference for the analyzer's methodology, not as decision input.

**Run:** 2026-05-12T20:21:36.465Z
**Source journal:** `logs/journal/journal-2026-05-12.jsonl`
**Total records in journal:** 6217
**Pine signals during RTH (09:30-15:45 ET):** 392
**Evaluated signals (had numeric entry price):** 392

## Comparative Summary

| Instrument | Signals | T+5 cont% | T+15 cont% | T+30 cont% | T+5 win% (n) | Avg cont move (pts @ T+5) | Median t-to-reversal |
|---|---:|---:|---:|---:|---:|---:|---:|
| SPY | 114 | 57.6% (n=66) | 47.1% (n=68) | 43.1% (n=72) | 57.6% (n=66) | 0.22 | 15 min |
| QQQ | 59 | 57.9% (n=57) | 62.7% (n=59) | 56.1% (n=57) | 57.9% (n=57) | 0.79 | 5 min |
| IWM | 57 | 43.9% (n=57) | 50.9% (n=57) | 50.9% (n=55) | 43.9% (n=57) | 0.21 | 5 min |
| ES1! | 56 | 46.9% (n=32) | 44.7% (n=38) | 48.4% (n=31) | 46.9% (n=32) | 3.10 | 15 min |
| NQ1! | 52 | 46.2% (n=26) | 71.4% (n=21) | 52.4% (n=21) | 46.2% (n=26) | 38.00 | 5 min |
| MES1! | 54 | 46.9% (n=32) | 48.6% (n=37) | 43.5% (n=23) | 46.9% (n=32) | 3.78 | 5 min |
| MNQ1! | 0 | — | — | — | — | — | — |

## SPY

**Total signals:** 114 (51 CALLS, 63 PUTS)
**By engine:** BUY:19, HTF:16, SELL:15, LH:15, HL:19, TEST_PROBE:1, ZONE:27, TEST_FILLPRICE:1, LIVE:1

| Horizon | Sample | Cont rate | Cont count | Avg move (pts) | Avg cont move (pts) | Avg cont move % |
|---|---:|---:|---:|---:|---:|---:|
| T+5min | 66/114 | 57.6% | 38 | 0.01 | 0.22 | 0.03% |
| T+15min | 68/114 | 47.1% | 32 | -0.04 | 0.45 | 0.06% |
| T+30min | 72/114 | 43.1% | 31 | -0.37 | 0.82 | 0.11% |

> **Data gap:** 48/114 signals had no T+5 price (POLL records absent or stale).

## QQQ

**Total signals:** 59 (32 CALLS, 27 PUTS)
**By engine:** LH:14, SELL:8, HL:14, BUY:9, HTF:5, ZONE:6, VETO_PROBE:2, CAP_VERIFY:1

| Horizon | Sample | Cont rate | Cont count | Avg move (pts) | Avg cont move (pts) | Avg cont move % |
|---|---:|---:|---:|---:|---:|---:|
| T+5min | 57/59 | 57.9% | 33 | 0.29 | 0.79 | 0.11% |
| T+15min | 59/59 | 62.7% | 37 | 0.30 | 1.08 | 0.15% |
| T+30min | 57/59 | 56.1% | 32 | 0.13 | 1.57 | 0.22% |

> **Data gap:** 2/59 signals had no T+5 price (POLL records absent or stale).

## IWM

**Total signals:** 57 (33 CALLS, 24 PUTS)
**By engine:** LH:11, SELL:9, BUY:9, HTF:9, HL:14, ZONE:5

| Horizon | Sample | Cont rate | Cont count | Avg move (pts) | Avg cont move (pts) | Avg cont move % |
|---|---:|---:|---:|---:|---:|---:|
| T+5min | 57/57 | 43.9% | 25 | 0.01 | 0.21 | 0.08% |
| T+15min | 57/57 | 50.9% | 29 | -0.03 | 0.32 | 0.11% |
| T+30min | 55/57 | 50.9% | 28 | -0.05 | 0.53 | 0.19% |

## ES1!

**Total signals:** 56 (32 CALLS, 24 PUTS)
**By engine:** LH:11, SELL:8, HTF:5, BUY:9, HL:16, ZONE:7

| Horizon | Sample | Cont rate | Cont count | Avg move (pts) | Avg cont move (pts) | Avg cont move % |
|---|---:|---:|---:|---:|---:|---:|
| T+5min | 32/56 | 46.9% | 15 | 0.18 | 3.10 | 0.04% |
| T+15min | 38/56 | 44.7% | 17 | -0.43 | 5.01 | 0.07% |
| T+30min | 31/56 | 48.4% | 15 | 1.37 | 9.30 | 0.13% |

> **Data gap:** 24/56 signals had no T+5 price (no monitor for this instrument — futures rely on later-signal proxies which weren't available within tolerance window).

## NQ1!

**Total signals:** 52 (31 CALLS, 21 PUTS)
**By engine:** LH:13, SELL:7, BUY:9, HL:16, HTF:5, ZONE:2

| Horizon | Sample | Cont rate | Cont count | Avg move (pts) | Avg cont move (pts) | Avg cont move % |
|---|---:|---:|---:|---:|---:|---:|
| T+5min | 26/52 | 46.2% | 12 | 14.60 | 38.00 | 0.13% |
| T+15min | 21/52 | 71.4% | 15 | 8.48 | 36.33 | 0.13% |
| T+30min | 21/52 | 52.4% | 11 | 11.29 | 64.77 | 0.22% |

> **Data gap:** 26/52 signals had no T+5 price (no monitor for this instrument — futures rely on later-signal proxies which weren't available within tolerance window).

## MES1!

**Total signals:** 54 (29 CALLS, 25 PUTS)
**By engine:** LH:11, SELL:8, HTF:5, BUY:9, HL:15, ZONE:6

| Horizon | Sample | Cont rate | Cont count | Avg move (pts) | Avg cont move (pts) | Avg cont move % |
|---|---:|---:|---:|---:|---:|---:|
| T+5min | 32/54 | 46.9% | 15 | 0.59 | 3.78 | 0.05% |
| T+15min | 37/54 | 48.6% | 18 | -0.39 | 4.75 | 0.06% |
| T+30min | 23/54 | 43.5% | 10 | 0.60 | 8.47 | 0.11% |

> **Data gap:** 22/54 signals had no T+5 price (no monitor for this instrument — futures rely on later-signal proxies which weren't available within tolerance window).

## MNQ1!

No signals fired during RTH today.

---

## Methodology

**Signal selection:** SIGNAL records in the day's journal with `pineAlert: true` (webhook-originated Pine alerts), filtered to RTH window 09:30:00–15:45:00 ET.

**Price-at-horizon for SPY/QQQ/IWM:** scan POLL records (each monitor writes one per 30s poll) for the first record at or after `signal_ts + horizon * 60s`. Tolerance: 60s drift before declaring "no data."

**Price-at-horizon for futures (ES1!/NQ1!/MES1!/MNQ1!):** no monitor polls futures. Forward prices are sparse — taken from any later Pine signal payload on the same instrument within 5-minute drift tolerance. Most futures signals will show `n/a` at one or more horizons because subsequent signals didn't arrive in window.

**Continuation:** move in the signal's direction at the horizon is positive (`(P_horizon - P_entry) * dirMult > 0`).

**5-min trade win rate:** simplistic — counts signals where T+5 continuation is true. Does NOT simulate stops, slippage, or commission. Use as a relative comparison metric across instruments, not an absolute P&L estimate.

**Outlier flag:** any instrument whose T+5 continuation rate differs from SPY by ≥ 20 percentage points.

**Limitations:**
- 5-min win rate ignores intra-bar stop-outs; a signal that ran +10pts then reversed -15pts shows as "win" if T+5 close is positive.
- Futures data is sparse — comparisons including futures are weaker.
- ATR-based stop simulation NOT implemented in this version (requires 1m OHLC bars per instrument; future enhancement if needed).
