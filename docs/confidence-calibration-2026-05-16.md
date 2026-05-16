# Confidence Calibration — 2026-05-16

**Built by:** `analyze-calibration.js` (Phase 1 deliverable)
**Source:** `paper-ledger.json` + `futures-ledger.json`
**Generated:** 2026-05-16T15:33:48.860Z

---

## Section 1 — Methodology

Reads every closed trade from the canonical ledgers, applies the exclusion
filters below, derives missing dimensions (time bucket, session type, bias
proxy from `macro4H`), and aggregates across 5 fallback levels.

### Aggregation levels (revised per operator spec)
| Level | Granularity |
|---|---|
| L1 | engine × conf × bias × instrument × timeBucket × direction |
| L2 | engine × conf × bias × instrument × sessionType × direction |
| L3 | engine × conf × bias × instrument × direction |
| L4 | engine × conf × instrument |
| L5 | engine baseline |

Lookup priority for live use: most-specific cell with sample_size ≥ 20.
Fall back through levels until met.

### Bias proxy
`macro4H` field maps to bias as:
- UP → bullish
- DOWN → bearish
- RANGING → coiled
- UNKNOWN → neutral
- (missing) → unknown

A true `dailyBias` field is not recorded per trade; this is the closest available proxy.

### Block triggers (any one fires)
1. `profit_factor < 1.0`
2. `expectancy ≤ 0` with sample_size ≥ 30
3. `win_rate < 0.40`
4. `net_pnl < 0` with sample_size ≥ 30

### Sizing tiers (when not blocked)
| WR | Action | Multiplier |
|---|---|--:|
| ≥ 70% | max_allocation | 1.5× |
| 60–70% | increased | 1.25× |
| 50–60% | normal | 1.0× |
| 45–50% | reduced | 0.5× |
| 40–45% | minimum | 0.25× |

`sharpe_like = mean_pnl / std_pnl` recorded as a tie-breaker between cells with similar WR/PF — flags spiky setups.

---

## Section 2 — Sample size summary + exclusion audit

| Metric | Value |
|---|--:|
| Input trades (both ledgers) | 2161 |
| After exclusions | 420 |
| L1 cells with N ≥ 20 | 0 |
| L1 cells with N < 20 (fall back) | 266 |
| Fallback aggregates (L2-L5, N ≥ 20) | 12 |
| **Total sufficient cells (all levels)** | **12** |
| Date span | 2026-05-11 → 2026-05-12 → 2026-05-13 → 2026-05-14 |

### Exclusions applied
| Reason | Count |
|---|--:|
| not_closed | 18 |
| iwm_retired | 69 |
| duration_too_short | 1446 |
| dirty_5_15 | 208 |

**Critical exclusion — 2026-05-15 entire session:** the phantom `$49,757` corruption +
operator's 13:45 ET taskkill + Claude relaunch at 14:04 ET adding 32 more trades make this
a textbook dirty-session day. Per memory `feedback_dirty_session_no_calibration.md`,
analyzer output from infra-failure sessions is invalid for tuning. Skipped wholesale.

**BUY/SELL flip-flop pattern — read before interpreting:** of the 1446 trades
filtered by the <60s rule, the vast majority are `BUY` and `SELL` engines exiting with
`SIGNAL_REVERSAL` in <10 seconds. This is the high-frequency BUY↔SELL flip-flop where each
engine reverses the other on every tick. Per the operator's spec these are excluded as
test/error data, but **the practical effect is that BUY and SELL engines are largely absent
from this analysis.** L1 cells are sparse for that reason — the surviving sample is the
slower option-style engines (HL/HTF/ZONE/LH/SWING) + futures-direct. If operator wants the
BUY/SELL surface analyzed, drop the duration filter and re-run.



---

## Section 3 — Top 20 highest win-rate setups (any level, N ≥ 20)

L1 cells are scarce post-exclusion, so this table mixes levels. Read the `level`
column to know how granular each row is (1 = full specificity, 5 = engine baseline).

| eng | conf | bias | inst | time | dir | N | WR | PF | exp | level | sess | action |
|---|---|---|---|---|---|--:|--:|--:|--:|--:|---|---|
| HL | MEDIUM | — | QQQ | — | — | 20 | 60.0% | 1.53 | +$7.73 | 4 | — | increased 1.25× |
| BUY | MEDIUM | — | — | — | — | 63 | 50.8% | 1.62 | +$97.24 | 5 | — | normal 1× |
| HL | MEDIUM | — | — | — | — | 90 | 50.0% | 1.01 | +$1.86 | 5 | — | normal 1× |
| ZONE | MEDIUM | — | — | — | — | 60 | 50.0% | 1.69 | +$93.72 | 5 | — | normal 1× |
| BUY | MEDIUM | — | SPY | — | — | 22 | 50.0% | 2.37 | +$11.90 | 4 | — | normal 1× |
| HL | MEDIUM | — | SPY | — | — | 22 | 50.0% | 2.72 | +$8.32 | 4 | — | normal 1× |
| SELL | MEDIUM | — | SPY | — | — | 21 | 47.6% | 0.70 | -$4.31 | 4 | — | block (profit_factor_lt_1) 0× |
| HTF | HIGH | — | — | — | — | 50 | 44.0% | 0.79 | -$41.48 | 5 | — | block (profit_factor_lt_1) 0× |
| LH | MEDIUM | — | — | — | — | 75 | 42.7% | 0.38 | -$124.43 | 5 | — | block (profit_factor_lt_1) 0× |
| ZONE | MEDIUM | — | SPY | — | — | 22 | 40.9% | 0.46 | -$5.53 | 4 | — | block (profit_factor_lt_1) 0× |
| HTF | HIGH | — | SPY | — | — | 20 | 40.0% | 0.29 | -$11.26 | 4 | — | block (profit_factor_lt_1) 0× |
| SELL | MEDIUM | — | — | — | — | 67 | 32.8% | 0.28 | -$113.92 | 5 | — | block (profit_factor_lt_1) 0× |

---

## Section 4 — Top 20 lowest win-rate setups (any level, N ≥ 20) — BLOCK candidates

| eng | conf | bias | inst | time | dir | N | WR | PF | exp | level | sess | action |
|---|---|---|---|---|---|--:|--:|--:|--:|--:|---|---|
| SELL | MEDIUM | — | — | — | — | 67 | 32.8% | 0.28 | -$113.92 | 5 | — | block (profit_factor_lt_1) 0× |
| HTF | HIGH | — | SPY | — | — | 20 | 40.0% | 0.29 | -$11.26 | 4 | — | block (profit_factor_lt_1) 0× |
| ZONE | MEDIUM | — | SPY | — | — | 22 | 40.9% | 0.46 | -$5.53 | 4 | — | block (profit_factor_lt_1) 0× |
| LH | MEDIUM | — | — | — | — | 75 | 42.7% | 0.38 | -$124.43 | 5 | — | block (profit_factor_lt_1) 0× |
| HTF | HIGH | — | — | — | — | 50 | 44.0% | 0.79 | -$41.48 | 5 | — | block (profit_factor_lt_1) 0× |
| SELL | MEDIUM | — | SPY | — | — | 21 | 47.6% | 0.70 | -$4.31 | 4 | — | block (profit_factor_lt_1) 0× |
| HL | MEDIUM | — | — | — | — | 90 | 50.0% | 1.01 | +$1.86 | 5 | — | normal 1× |
| ZONE | MEDIUM | — | — | — | — | 60 | 50.0% | 1.69 | +$93.72 | 5 | — | normal 1× |
| BUY | MEDIUM | — | SPY | — | — | 22 | 50.0% | 2.37 | +$11.90 | 4 | — | normal 1× |
| HL | MEDIUM | — | SPY | — | — | 22 | 50.0% | 2.72 | +$8.32 | 4 | — | normal 1× |
| BUY | MEDIUM | — | — | — | — | 63 | 50.8% | 1.62 | +$97.24 | 5 | — | normal 1× |
| HL | MEDIUM | — | QQQ | — | — | 20 | 60.0% | 1.53 | +$7.73 | 4 | — | increased 1.25× |

---

## Section 5 — Engine-level summary

| Engine | N | WR | PF | netPnL | exp/trade | %HIGH | %MEDIUM | cells | blocked |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| BUY | 63 | 50.8% | 1.62 | +$6126.20 | +$97.24 | 0% | 100% | 2 | 0 |
| CAP_VERIFY | 1 | 0.0% | 0.00 | +$0.00 | +$0.00 | 0% | 100% | 0 | 0 |
| FADE | 1 | 100.0% | ∞ | +$6.11 | +$6.11 | 0% | 100% | 0 | 0 |
| HL | 90 | 50.0% | 1.01 | +$167.66 | +$1.86 | 0% | 100% | 3 | 0 |
| HTF | 50 | 44.0% | 0.79 | -$2073.75 | -$41.48 | 100% | 0% | 2 | 2 |
| LH | 75 | 42.7% | 0.38 | -$9332.53 | -$124.43 | 0% | 100% | 1 | 1 |
| LIVE | 7 | 42.9% | 8.79 | +$4626.80 | +$660.97 | 0% | 100% | 0 | 0 |
| SELL | 67 | 32.8% | 0.28 | -$7632.34 | -$113.92 | 0% | 100% | 2 | 2 |
| STRUCTURE | 2 | 50.0% | ∞ | +$26.11 | +$13.06 | 50% | 50% | 0 | 0 |
| SWING | 4 | 50.0% | 1.97 | +$80.42 | +$20.10 | 100% | 0% | 0 | 0 |
| ZONE | 60 | 50.0% | 1.69 | +$5623.31 | +$93.72 | 0% | 100% | 2 | 1 |

---

## Section 6 — Time-of-day heatmap

| Window | N | WR | PF | exp/trade | netPnL | Class |
|---|--:|--:|--:|--:|--:|---|
| 04:00-09:30 | 0 | — | — | — | — | empty |
| 09:30-10:00 | 25 | 60.0% | 7.06 | +$265.49 | +$6637.22 | alpha |
| 10:00-11:00 | 46 | 54.4% | 3.13 | +$195.24 | +$8981.20 | alpha |
| 11:00-12:00 | 38 | 60.5% | 0.61 | -$73.32 | -$2786.00 | toxic_avoidable |
| 12:00-13:00 | 45 | 57.8% | 1.30 | +$32.64 | +$1468.82 | neutral |
| 13:00-14:00 | 97 | 44.3% | 0.80 | -$48.18 | -$4673.12 | toxic_avoidable |
| 14:00-15:00 | 94 | 42.5% | 1.39 | +$34.64 | +$3255.81 | neutral |
| 15:00-15:30 | 43 | 25.6% | 0.17 | -$148.76 | -$6396.75 | toxic_avoidable |
| 15:30-16:00 | 31 | 19.4% | 0.15 | -$295.14 | -$9149.19 | toxic_avoidable |
| 16:00-18:00 | 1 | 100.0% | ∞ | +$280.00 | +$280.00 | incomplete |
| 18:00-22:00 | 0 | — | — | — | — | empty |
| 22:00-04:00 | 0 | — | — | — | — | empty |

**Classification rules:**
- **alpha** — PF > 1.5
- **neutral** — 1.0 < PF ≤ 1.5
- **toxic_unavoidable** — PF ≤ 1.0 but N > 100 (e.g., open session can't be skipped)
- **toxic_avoidable** — PF ≤ 1.0 and lower N (candidate to gate via env)

---

## Section 7 — Instrument breakdowns

| Instrument | N | WR | PF | netPnL | exp/trade | avgWin | avgLoss |
|---|--:|--:|--:|--:|--:|--:|--:|
| ES1! | 55 | 45.5% | 1.15 | +$810.00 | +$14.73 | +$244.80 | -$177.00 |
| MES1! | 57 | 47.4% | 1.25 | +$1330.00 | +$23.33 | +$243.33 | -$174.67 |
| NQ1! | 84 | 39.3% | 0.91 | -$4850.00 | -$57.74 | +$1481.82 | -$1053.92 |
| QQQ | 98 | 48.0% | 1.33 | +$435.59 | +$4.44 | +$37.70 | -$26.20 |
| SPY | 126 | 46.0% | 0.92 | -$107.60 | -$0.85 | +$22.61 | -$20.87 |

---

## Section 8 — Bias-state effectiveness

| Bias | N | WR | PF | netPnL | exp/trade |
|---|--:|--:|--:|--:|--:|
| bullish | 284 | 41.9% | 0.75 | -$11528.95 | -$40.59 |
| bearish | 8 | 50.0% | 0.75 | -$2244.11 | -$280.51 |
| coiled | 0 | — | — | — | — |
| neutral | 2 | 50.0% | 0.03 | -$1004.40 | -$502.20 |
| unknown | 126 | 52.4% | 2.18 | +$12395.45 | +$98.38 |

---

## Section 9 — Direction asymmetry

### Aggregate
| Direction | N | WR | PF | netPnL | exp/trade |
|---|--:|--:|--:|--:|--:|
| CALLS | 217 | 51.6% | 1.30 | +$10298.57 | +$47.46 |
| PUTS | 203 | 38.4% | 0.62 | -$12680.58 | -$62.47 |
| UNKNOWN | 0 | — | — | — | — |

### Per instrument
| Inst/Dir | N | WR | PF | netPnL | exp/trade |
|---|--:|--:|--:|--:|--:|
| ES1!/CALLS | 34 | 50.0% | 1.77 | +$2360.00 | +$69.41 |
| ES1!/PUTS | 21 | 38.1% | 0.31 | -$1550.00 | -$73.81 |
| MES1!/CALLS | 33 | 54.5% | 2.25 | +$3340.00 | +$101.21 |
| MES1!/PUTS | 24 | 37.5% | 0.21 | -$2010.00 | -$83.75 |
| NQ1!/CALLS | 45 | 46.7% | 1.13 | +$3610.00 | +$80.22 |
| NQ1!/PUTS | 39 | 30.8% | 0.68 | -$8460.00 | -$216.92 |
| QQQ/CALLS | 53 | 54.7% | 1.82 | +$536.40 | +$10.12 |
| QQQ/PUTS | 45 | 40.0% | 0.85 | -$100.81 | -$2.24 |
| SPY/CALLS | 52 | 51.9% | 2.29 | +$452.17 | +$8.70 |
| SPY/PUTS | 74 | 41.9% | 0.48 | -$559.77 | -$7.56 |

---

## Phase 3 wiring notes

When `paperTrading.sendOrder` adopts this calibration table, log on every entry:
- `calibration_key_used`
- `calibration_level` (1-5)
- `calibration_multiplier` (0, 0.25, 0.5, 1, 1.25, 1.5)
- `calibration_action` (max_allocation / increased / normal / reduced / minimum / block)

Then post-session diagnostics can answer: are we over-using L4/L5 fallbacks? Which
engines are blocking most? What's the average multiplier per day? The Sunday futures
session is the first live validation window for the calibrated sizing path.

---

*Re-run anytime with* `node analyze-calibration.js` *— output filenames re-use today's date.*
