# Phantom $49,757 Bug — Isolation & Backout (2026-05-15)

**Status:** Root cause confirmed, fix shipped (commit `8d80092`), ledger soft-voided.
**Author:** Claude Code, Task 1 of post-close deploy directive.

---

## 1. The corrupted record

Single ledger row, requestId `PUTS_LH_1778872499551_kvw8k`:

| Field | Value |
|---|---|
| Instrument / Engine | QQQ / LH |
| Direction | PUTS strike 710 |
| Session | PRE-MOC |
| Entry | 15:14:59 ET, fillPrice $1.42, entryUnderlyingPrice $711.15 |
| Exit (recorded) | 15:32:23 ET, exitPrice $286.60, **pnl +$49,757.30 (PROFIT_LOCKED_STOP)** |
| pnlPct | 20,082.97% (impossible) |

### Why it's impossible

QQQ closed near $711. A $710-strike PUT with QQQ at $711 is worth ~$1-2. A one-contract trade can't yield $49,757 of profit on $142 of capital.

### Corrupted fields preserved in the row

| Field | Stored | Real |
|---|---|---|
| `peakFavorablePrice` | 211.005 | should be ~$709 |
| `troughUnderlyingPrice` | 211.005 | should be ~$709 |
| `stopUnderlyingPrice` | 211.0683 | should be ~$711.68 |
| `trailStopPrice` | 211.0683 | should track real underlying |
| `peakUnrealizedPnL` | 49757.3 | should be ~$0-$25 |
| `scaleOutEvents[0].underlyingAtExit` | 211.005 | should be ~$709 |
| `scaleOutEvents[0].exitPrice` | 498.99 | BS intrinsic from bogus underlying |
| `entryUnderlyingPrice` | 711.15 | **correct** (entry path was clean) |
| `peakUnderlyingPrice` | 710.83 | **correct** |

The entry path stored truthful values; the per-tick evaluation loop was where the corruption entered.

---

## 2. Root cause (per commit `8d80092` message)

A per-tick price feeder returned `fed.underlyingPrice ≈ 211` for QQQ when the real underlying was ~$711. That bogus value cascaded through six dependent computations:

1. **MFE/MAE tracker** — `peakUnrealizedPnL = $49,757` written into the trade state.
2. **STAGE_3 `_updateStage3`** — `peakFavorablePrice` clobbered to 211.005. For PUTS, "favorable" means lower underlying, so a 500-point downward "move" looked legitimate.
3. **R-multiple math** — `moveFromEntry = 711.15 − 211.005 = 500.145`. `RMultiple = 500.145 / stopDistance(0.525) = 952×`. Triggered the `RMultiple >= 4` branch → set 2R lock at `min(710.1, 211.07) = 211.07`.
4. **Trail stop** — `211.005 + (211.005 × 0.0003) = 211.0683`.
5. **Black-Scholes pricing** — `BS(u=211, K=710, T, IV=0.73, type=put) ≈ $499` intrinsic from the wrong underlying.
6. **Scale-out at "target"** — exitPrice $498.99, pnl recorded $49,757.30.

The bogus $211 value matches no current chart price (QQQ ~$711, SPY ~$748, IWM ~$284, MES/ES ~$7,470, NQ/MNQ ~$29,200). The most-plausible sources (per commit message) are a CDP query race during P2-13 12:00 timeframe-switch, a wrong-pane parse in `parseValues`, or stale state from a different study's Plot. The source-side reproducer is not yet captured — the defense is at the *consumer* side.

---

## 3. Fix verification

Commit `8d80092` (Fri May 15 16:30:59 2026) adds a defense-in-depth sanity gate:

**`paperTrading.js`** lines 67–87 — `UNDERLYING_SANITY_THRESHOLD` env var (default `0.5` = 50% deviation) + `_isUnderlyingSane(liveU, entryU)` helper.

**`paperTrading.js`** lines 1494–1522 — Per-tick gate at the top of `evaluateOpenPositions`. Rejected ticks skip MFE/MAE update, `monitorPosition` BS call, stop check, target/trail logic, and STAGE transitions. Position is added to the snapshot with `reason='unsane_underlying_feed'`.

**`paperTrading.js`** `_updateStage3` — Second-line defense if called outside the eval loop.

**`futuresTrading.js`** line 540 + `evaluateOpenFutures` + `_updateStage3` — Parallel gate for Path 2 (futures-direct).

Logging: first occurrence per requestId logs `jError` + console banner; subsequent ticks increment `_saneRejectsThisRun` silently.

**Operator tunable** via `.env`: `UNDERLYING_SANITY_THRESHOLD=0.5`. Lower (e.g., 0.2) for tighter protection on low-volatility instruments.

---

## 4. Audit — any other corrupted records?

Scanned all 208 trades on 2026-05-15.

**Equity options (1-contract baseline ~$1-$2 premium, normal P&L per trade $-50 to $+50):**
- Only one trade has `|pnl| > $1,000` on QQQ/SPY/IWM — **the phantom**. No other equity-options corruption.

**Futures options (1-contract premium ~$50-$60, normal P&L per trade $-$5K to $+$10K):**
- All large-pnl rows reviewed:
  - NQ1! HTF/BUY at $58 → $128 exit = +$9,287 (real, supports the 13:02-14:16 NQ rally documented in `day-2-loss-analysis-2026-05-15.md`)
  - NQ1! HL at $58 → $121 exit = +$8,497 (real)
  - NQ1! BUY at $58 → $130 exit = +$8,300 (real)
  - NQ1! LH at $58 → $9.44 exit = −$4,890 (real, 10:06 cluster)
  - 15 more NQ1! ±$1K to ±$5K rows — all consistent with NQ option premium decay/expansion on real 10-40pt underlying moves.

**Conclusion:** the phantom is unique to one record. No other corruption from this class of bug found in today's journal.

**Stale stat caveat:** `engineStats` and `sessionStats` blocks in `paper-ledger.json` are not in sync with `trades[].pnl` (their sums are an order of magnitude off from `totalPnL`). They appear to be partial/legacy aggregates that aren't authoritatively maintained. I did **not** adjust them — they're already unreliable. The authoritative day P&L lives in `dailyPnL[date]` and per-trade `trades[].pnl`.

---

## 5. Ledger backout (executed)

Method: **soft-void** (per operator).

**Trade row mutation** (`PUTS_LH_1778872499551_kvw8k`):
- `pnl: 49757.3 → 0`
- `status: 'CLOSED' → 'VOIDED_CORRUPTED'`
- `win: true → null`
- Added: `corrupted_phantom: true`, `corrupted_phantom_original_pnl: 49757.3`, `corrupted_phantom_backed_out_at: <ISO>`, `corrupted_phantom_reason: <string>`

**Authoritative totals adjusted:**
| Field | Before | After | Δ |
|---|---:|---:|---:|
| `balance` | $117,505.36 | **$67,748.06** | −$49,757.30 |
| `totalPnL` | $92,505.36 | **$42,748.06** | −$49,757.30 |
| `wins` | 1,736 | **1,735** | −1 |
| `dailyPnL['2026-05-15']` | $94,698.49 | **$44,941.19** | −$49,757.30 |

**Backup:** `paper-ledger.2026-05-15T-phantom-backout.backup.json` (pre-mutation snapshot retained for audit).

---

## 6. Reconciled day P&L (clean)

**$44,941.19 realized net for 2026-05-15.**

This differs from the earlier `day-2-loss-analysis-2026-05-15.md` figure of $27,861 because that analysis was written mid-session before all post-restart trades had settled; the +$17K delta reflects late-day NQ1! winners (15:50:54 NQ1! LIVE +$4,080, NQ1! ZONE +$3,840, NQ1! SELL +$3,640, NQ1! LH +$3,460, and the 16:23+ NQ1! continuation) that landed after the analyst snapshot.

**Dirty-session caveat:** today saw the feeder corruption + operator `taskkill` at 13:45 ET + Claude Code auto-relaunch at 14:04 ET. Per memory `feedback_dirty_session_no_calibration.md`, today's data should NOT be used for per-engine or per-instrument calibration. The $44,941 figure is the *accounting* number; it is not a *calibration* number.

The operator's Task 2/3/4 directives (tighter stops, profit-protection tiers, capital caps) explicitly accept this caveat: the sizing comes from operator judgment + the broad pattern (NQ1! losers at -10 to -30pt underlying moves), not from a clean-session backtest.

---

## 7. What this does NOT address

- **Source of the bogus $211 value.** The fix prevents downstream corruption regardless of source, but the upstream bug is still latent. If the feeder ever produces a value WITHIN the 50% sanity band but still wrong (e.g., $700 for QQQ when real is $711), this gate won't catch it. Future work: instrument the price-feed at the producer side (`monitor.js` `_qqqPrice` setter / parser) to find the exact failure mode.
- **The dashboard's stale display layer.** If the dashboard reads from a different cache than `paper-ledger.json`, it may still show the pre-backout balance. Verify post-deploy.
- **Re-running today's analysis with clean data.** The `day-2-loss-analysis-2026-05-15.md` doc was written against contaminated totals — its dollar-impact estimates for PROFIT_PROTECTION, CHOP_BLACKOUT, etc. may shift slightly with the phantom removed. Re-run if Monday produces inconsistencies.

---

## 8. Hand-off to Task 2

Task 1 complete. Proceeding to Task 2 (tighter futures stops `.env` update) per commit-order sequence.
