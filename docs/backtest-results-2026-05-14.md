# Backtest Results — 2026-05-14

**Author:** Claude Code (P2-14 backtest framework)
**Method:** journal Pine-alert prices as underlying-path proxy; delta=0.5 approximation for option premium reconstruction
**Trades simulated:** 341

## Methodology limitations

- **Underlying path resolution: ~30-60 seconds** between Pine alerts. Trades that breached and recovered between alerts will be missed by the simulator. Underestimates STOP_LOSS firing rate.
- **Option premium reconstruction: delta=0.5** (ATM 0DTE assumption). Under-estimates premium swings on deep-OTM or near-ATM options where delta deviates significantly.
- **Whipsaw bar-close confirmation NOT modeled** — simulator uses instant-tick semantics. Real P1-5-A protection would defer some stops by 1-2 minutes.
- **Scale-out (50/50 + BE + trail) NOT modeled** — only single-target outcome simulated. Underestimates upside capture (real STAGE_3 trail can ride above 1:2 target).
- **Per-instrument trade counts vary widely** — IWM has only 38 trades; less statistical power.

Treat results as **directional** for tuning, not authoritative. Confirm with Friday-Monday session data + per-trade MFE/MAE instrumentation (P0-4 already shipped).

## Optimal config per instrument (max simulated PnL)

| Instrument | Trades | Actual PnL | Optimal Stop× | Optimal Target× | Sim PnL | Stops/Targets/Natural |
|---|---:|---:|---:|---:|---:|---|
| ES1! | 54 | $1190 | 0.5× | 1.5× | $1860 | 30 / 8 / 11 |
| IWM | 38 | $-973 | 0.5× | 0.75× | $-900 | 11 / 1 / 9 |
| MES1! | 58 | $1150 | 0.75× | 1.5× | $403 | 35 / 9 / 12 |
| NQ1! | 56 | $-16720 | 0.5× | 1.5× | $5100 | 35 / 11 / 5 |
| QQQ | 50 | $-175 | 1× | 1.5× | $172 | 19 / 13 / 10 |
| SPY | 85 | $-455 | 0.5× | 1× | $387 | 28 / 27 / 20 |

## Full sweep — all (stop, target) combos by instrument

### ES1!

Base stop = 3, base target = 6

| Stop× | Target× | Sim PnL | Stop / Target / Natural |
|---:|---:|---:|---|
| 0.5 | 1.5 | $1860 | 30 / 8 / 11 |
| 0.75 | 1.25 | $1725 | 26 / 12 / 11 |
| 0.75 | 1 | $1695 | 26 / 16 / 7 |
| 0.5 | 1 | $1550 | 30 / 13 / 6 |
| 0.75 | 1.5 | $1485 | 26 / 8 / 15 |
| 0.5 | 1.25 | $1355 | 30 / 9 / 10 |
| 0.5 | 0.75 | $1040 | 29 / 15 / 5 |
| 0.75 | 0.75 | $998 | 25 / 18 / 6 |
| 1 | 1.25 | $750 | 26 / 12 / 11 |
| 1 | 1 | $720 | 26 / 16 / 7 |

Data quality: insufficient=5, no-base-distance=0, no-entry-underlying=0

### IWM

Base stop = 0.25, base target = 0.5

| Stop× | Target× | Sim PnL | Stop / Target / Natural |
|---:|---:|---:|---|
| 0.5 | 0.75 | $-900 | 11 / 1 / 9 |
| 0.5 | 1 | $-911 | 11 / 0 / 10 |
| 0.5 | 1.25 | $-911 | 11 / 0 / 10 |
| 0.5 | 1.5 | $-911 | 11 / 0 / 10 |
| 0.75 | 0.75 | $-921 | 8 / 1 / 12 |
| 0.75 | 1 | $-932 | 8 / 0 / 13 |
| 0.75 | 1.25 | $-932 | 8 / 0 / 13 |
| 0.75 | 1.5 | $-932 | 8 / 0 / 13 |
| 1 | 0.75 | $-946 | 8 / 1 / 12 |
| 1 | 1 | $-957 | 8 / 0 / 13 |

Data quality: insufficient=17, no-base-distance=0, no-entry-underlying=0

### MES1!

Base stop = 3, base target = 6

| Stop× | Target× | Sim PnL | Stop / Target / Natural |
|---:|---:|---:|---|
| 0.75 | 1.5 | $403 | 35 / 9 / 12 |
| 1 | 1.5 | $240 | 32 / 9 / 15 |
| 0.5 | 1.5 | $25 | 41 / 6 / 9 |
| 1 | 1.25 | $-10 | 32 / 12 / 12 |
| 0.5 | 0.75 | $-95 | 39 / 12 / 5 |
| 0.5 | 1 | $-205 | 41 / 9 / 6 |
| 1 | 1 | $-240 | 32 / 15 / 9 |
| 0.75 | 1.25 | $-272 | 35 / 9 / 12 |
| 0.75 | 1 | $-277 | 35 / 12 / 9 |
| 0.75 | 0.75 | $-317 | 33 / 15 / 8 |

Data quality: insufficient=2, no-base-distance=0, no-entry-underlying=0

### NQ1!

Base stop = 10, base target = 20

| Stop× | Target× | Sim PnL | Stop / Target / Natural |
|---:|---:|---:|---|
| 0.5 | 1.5 | $5100 | 35 / 11 / 5 |
| 0.5 | 1.25 | $3850 | 34 / 12 / 5 |
| 0.5 | 1 | $1980 | 34 / 13 / 4 |
| 0.75 | 1.5 | $820 | 34 / 11 / 6 |
| 0.75 | 1.25 | $-305 | 33 / 12 / 6 |
| 0.5 | 0.75 | $-480 | 34 / 14 / 3 |
| 0.75 | 1 | $-2175 | 33 / 13 / 5 |
| 1 | 1.5 | $-3320 | 33 / 11 / 7 |
| 1 | 1.25 | $-4320 | 32 / 12 / 7 |
| 0.75 | 0.75 | $-4635 | 33 / 14 / 4 |

Data quality: insufficient=5, no-base-distance=0, no-entry-underlying=0

### QQQ

Base stop = 0.35, base target = 0.7

| Stop× | Target× | Sim PnL | Stop / Target / Natural |
|---:|---:|---:|---|
| 1 | 1.5 | $172 | 19 / 13 / 10 |
| 0.5 | 1.5 | $151 | 25 / 10 / 7 |
| 0.5 | 1.25 | $134 | 25 / 12 / 5 |
| 1 | 1.25 | $129 | 19 / 15 / 8 |
| 0.75 | 1.5 | $111 | 23 / 11 / 8 |
| 0.75 | 1.25 | $86 | 23 / 13 / 6 |
| 0.5 | 1 | $81 | 24 / 14 / 4 |
| 1 | 1 | $58 | 18 / 17 / 7 |
| 1.25 | 1.5 | $30 | 10 / 13 / 19 |
| 0.75 | 1 | $28 | 22 / 15 / 5 |

Data quality: insufficient=8, no-base-distance=0, no-entry-underlying=0

### SPY

Base stop = 0.3, base target = 0.6

| Stop× | Target× | Sim PnL | Stop / Target / Natural |
|---:|---:|---:|---|
| 0.5 | 1 | $387 | 28 / 27 / 20 |
| 0.5 | 1.25 | $359 | 28 / 20 / 27 |
| 0.75 | 1 | $221 | 24 / 27 / 24 |
| 0.5 | 0.75 | $205 | 28 / 28 / 19 |
| 0.75 | 1.25 | $193 | 24 / 20 / 31 |
| 1 | 1 | $138 | 23 / 27 / 25 |
| 0.5 | 1.5 | $122 | 28 / 9 / 38 |
| 1 | 1.25 | $110 | 23 / 20 / 32 |
| 1.25 | 1 | $86 | 19 / 27 / 29 |
| 1.25 | 1.25 | $58 | 19 / 20 / 36 |

Data quality: insufficient=10, no-base-distance=0, no-entry-underlying=0

## Aggregate insight (across all instruments)

Total actual realized PnL: $-15983

| Stop× | Target× | Total Sim PnL | vs Actual |
|---:|---:|---:|---:|
| 0.5 | 1.5 | $6348 | +$22331 |
| 0.5 | 1.25 | $4363 | +$20346 |
| 0.5 | 1 | $2882 | +$18865 |
| 0.75 | 1.5 | $1844 | +$17827 |
| 0.75 | 1.25 | $495 | +$16478 |
| 0.5 | 0.75 | $-272 | +$15711 |
| 0.75 | 1 | $-1440 | +$14543 |
| 1 | 1.5 | $-3481 | +$12502 |
| 1 | 1.25 | $-4298 | +$11686 |
| 0.75 | 0.75 | $-4940 | +$11043 |
| 1 | 1 | $-6470 | +$9513 |
| 1.25 | 1.5 | $-9593 | +$6390 |

## Recommendation

**Best overall (max total simulated PnL):** stop 0.5× base, target 1.5× base = $6348 simulated.

Per-instrument splits (per the table above) outperform a single overall config because instruments have different volatility profiles. If the operator wants per-instrument env-config, take the optimal stop× / target× from the per-instrument sweep and update STOP_*_POINTS / TARGET_*_POINTS accordingly.

**Caveat:** today (2026-05-14) is a single-session sample with extreme PnL skew toward NQ1! catastrophe. Don't recalibrate purely on this — wait for 3-5 sessions of data + MFE/MAE instrumentation before locking new defaults.

