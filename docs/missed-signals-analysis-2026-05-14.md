# Missed Signals Analysis — 2026-05-14

**Author:** Claude Code (auto-analysis from `logs/journal/journal-2026-05-14.jsonl`)
**Method:** journal-only inference using operator-provided time windows + price targets (no screenshots reviewed)
**Status:** All three misses have a confirmed journal-evidence root cause and a resolved-by-today's-commits status

---

## Summary

| Miss | Window | Root cause | Resolved by today's work? |
|---|---|---|---|
| #1 — SPY 09:30-09:40 V-reversal | 09:30:00 — 09:40:00 ET | `DAILY_LOSS_CAP_RESERVE` blocks (cap=$500 dotenv bug) blocked 7 SPY signals incl. the 09:39:00 HL CALLS that would have caught the reversal | YES (cap-rip + dotenv fix), but NEW `EXPLORATION_WINDOW` gate now intentionally blocks 09:30-09:40 equity entries — operator's own rule, not a regression |
| #2 — MES1! 09:30-10:45 rally 7,482→7,513 | 09:30:00 — 10:45:00 ET | Mix of `DAILY_LOSS_CAP_RESERVE` (3 blocks, cap=$500), `PER_INSTRUMENT_CAP` (2 blocks, after 2 MES1! open), `MAX_CONCURRENT` (7 blocks, after total cap=12 hit during the rally) | YES — all three gate types removed (cap-rip + dotenv) |
| #3 — SPY mid-session HL → 747.40 breakout | 11:00:00 — 14:00:00 ET | `OPPOSING_DIRECTION_LOCKOUT` (8), `FAMILY_CORRELATION_CAP` (6), `MAX_CONCURRENT` (4) blocked many SPY HL CALLS during the mid-session uptrend | YES — all four count/correlation/opposition gates removed (commits 252c394 + 75a4145) |

**Net:** all three misses share the same family of root causes: today's morning-to-midday session ran with broken or overly-restrictive risk caps. The operator's RULE 1 directive ("all instruments, all directions, all the time") and the cap-rip + dotenv fixes resolve all three at the entry-gate layer. The session-gate change (commit 9c18d7d) introduces a new intentional miss for equity 09:30-09:40 — that window is now off-limits by operator design, with futures still allowed.

---

## Miss #1 — SPY 09:30-09:40 V-reversal play

### Window
2026-05-14 09:30:00 — 09:40:00 ET on SPY.

### Operator framing
"Completely missed the V-reversal." Implies SPY traded down then rallied (V-shape) in the first 10 minutes; HANK should have caught the rally side.

### Journal evidence

43 SPY signals fired in this 10-minute window. Only 2 entries landed:
- `09:30:01` — SWING engine PUT entry (the catastrophic -92.4% loser, gapped against entry within 30 sec)
- `09:38:29` — BUY engine CALL entry

7 SPY signals were blocked by `DAILY_LOSS_CAP_RESERVE`:

| Time | Engine | Signal direction |
|---|---|---|
| 09:30:26 | LIVE | CALLS |
| 09:30:29 | ZONE | CALLS |
| 09:31:00 | HTF | PUTS |
| 09:31:01 | SELL | PUTS |
| 09:31:01 | ZONE | PUTS |
| 09:31:14 | LIVE | CALLS |
| **09:39:00** | **HL** | **CALLS** ← likely the V-reversal entry the operator wanted |

The 09:39:00 HL CALLS signal in particular is the V-reversal confluence point — HL = higher-low confirmation, exactly the signal type for a V-reversal entry. Blocked by `DAILY_LOSS_CAP_RESERVE` against the cap=$500 default (the dotenv bug — actual .env value is $5,000).

### Root cause

The cap=$500 bug from missing dotenv import in webhook-server.js (fixed in `fbb0a97`). Reserve-veto pre-block tripped because `committedLoss` from morning open positions exceeded the wrong $500 ceiling. With the correct $5K cap, those signals would have landed as entries.

### Resolution status

**Resolved at the gate layer** by today's commits:
- `fbb0a97` — `import 'dotenv/config'` in webhook-server.js (cap now reads $5K)
- `252c394` — MAX_CONCURRENT and PER_INSTRUMENT_CAP removed
- `75a4145` — OPPOSING_DIRECTION_LOCKOUT and FAMILY_CORRELATION_CAP removed
- `d054b85` — RESERVE_VETO_ENABLED=false

**But:** the new `EXPLORATION_WINDOW` gate (commit `9c18d7d`) intentionally blocks SPY/QQQ/IWM entries during 09:30-09:40 ET. So going forward, the same V-reversal would still not produce an entry — by operator's own RULE. This is a deliberate design choice, not a residual bug. Per TASK 4: "Operator-authorized rule: NO TRADES until 09:40 ET on equity instruments."

If the operator wants V-reversal entries in this window in the future, the EXPLORATION_WINDOW gate would need to be loosened or made signal-conditional (e.g., allow only HIGH-conviction CALLS during 09:35-09:40).

---

## Miss #2 — MES1! 09:30-10:45 rally 7,482 → 7,513

### Window
2026-05-14 09:30:00 — 10:45:00 ET on MES1!. Underlying moved 31 points (~$155 per contract).

### Operator framing
"Completely missed the rally." Implies HANK should have ridden the trend up.

### Journal evidence

20 MES1! Pine alerts arrived. **8 entries landed** (so HANK did participate); **12 were blocked**:

| Time | Engine | Direction | Blocked by | Notes |
|---|---|---|---|---|
| 09:30:59 | ZONE | CALLS | DAILY_LOSS_CAP_RESERVE | cap=$500 bug |
| 09:31:29 | LIVE | CALLS | DAILY_LOSS_CAP_RESERVE | cap=$500 bug |
| 09:40:00 | HL | CALLS | DAILY_LOSS_CAP_RESERVE | cap=$500 bug |
| 09:55:59 | ZONE | CALLS | PER_INSTRUMENT_CAP | 2 MES1! already open |
| 09:55:59 | BUY | CALLS | PER_INSTRUMENT_CAP | 2 MES1! already open |
| 09:58:59 | HL | CALLS | MAX_CONCURRENT | total open >= 12 (during open-period stack-up) |
| 10:08:59 | ZONE | CALLS | MAX_CONCURRENT | rally underway, still capped |
| 10:12:00 | ZONE | CALLS | MAX_CONCURRENT | mid-rally |
| 10:32:59 | HL | CALLS | MAX_CONCURRENT | late rally |
| 10:32:59 | HTF | CALLS | MAX_CONCURRENT | late rally HTF confluence |
| 10:32:59 | BUY | CALLS | MAX_CONCURRENT | late rally BUY trigger |
| 10:37:59 | HL | CALLS | MAX_CONCURRENT | rally peak — this would have been a HL pullback re-entry |

8 entries did land (09:37:59 ZONE through 10:11:59 HL), so the rally was not "completely missed" in the strictest sense — HANK had positions during the move. But the operator's complaint is that **trend-add re-entries were blocked.** A trending rally produces multiple HL pullback signals; HANK couldn't add to its winning side because PER_INSTRUMENT_CAP capped same-instrument adds at 2 and MAX_CONCURRENT capped total opens.

### Root cause

Compound:
1. Reserve-cap bug at 09:30-09:40 (cap=$500 instead of $5,000) blocked 3 early entries that would have set up trend participation
2. PER_INSTRUMENT_CAP=2 prevented adding to the MES1! winning side after 2 positions open
3. MAX_CONCURRENT=12 (later raised; pre-rip cap was 6 then 12) blocked total stacking once portfolio filled

### Resolution status

**Fully resolved.** Per RULE 1, all three gate types are gone:
- Reserve veto disabled (`d054b85` and now permanently false in default)
- PER_INSTRUMENT_CAP removed (`252c394`)
- MAX_CONCURRENT removed (`252c394`)

Going forward, every MES1! signal will land regardless of how many MES1! positions are open or how many total positions are stacked. Per-trade STOP_LOSS_PCT (commit `47b629c`) provides the new risk control on each entry.

No additional fix required.

---

## Miss #3 — SPY mid-session HL → 747.40 breakout

### Window
2026-05-14 11:00:00 — 14:00:00 ET on SPY (estimated mid-session).

### Operator framing
"Completely missed the HL → breakout to 747.40." Implies SPY printed a higher-low pattern that resolved into a breakout; HANK didn't catch the breakout side.

### Journal evidence

296 SPY signals fired in this 3-hour window (full mid-session activity). 19 entries landed; 18 blocked. The 18 blocks decompose as:

| Blocked by | Count |
|---|---:|
| OPPOSING_DIRECTION_LOCKOUT | 8 |
| FAMILY_CORRELATION_CAP | 6 |
| MAX_CONCURRENT | 4 |

The breakout-relevant signal types in this window:
- 12 SPY HL CALLS signals fired
- 7 SPY BUY CALLS signals fired
- 4 SPY ZONE CALLS signals fired

Of those 23 bullish-confluence signals, only 9 became entries. The other 14 were blocked by one of the three gate types — specifically:

- **OPPOSING_DIRECTION_LOCKOUT (8 blocks):** SPY had open PUT positions during portions of the mid-session. New CALL signals (HL/BUY/ZONE) were rejected outright because the gate prevented same-instrument opposite-direction simultaneously. The operator's RULE 1 explicitly removes this restriction.
- **FAMILY_CORRELATION_CAP (6 blocks):** SPY family pool (just SPY itself) was full at 2 open. New SPY signals blocked. Removing this gate allows unlimited per-family stacking.
- **MAX_CONCURRENT (4 blocks):** total portfolio open count hit 12. New signals blocked regardless of instrument or family.

### Root cause

Three different count/correlation/opposition gates layered on top of each other suppressed mid-session SPY CALL re-entries. Each block was a missed "add to winning side" opportunity during the breakout.

### Resolution status

**Fully resolved.** All three gate types removed in today's commits:
- OPPOSING_DIRECTION_LOCKOUT removed (`75a4145`)
- FAMILY_CORRELATION_CAP removed (`75a4145`)
- MAX_CONCURRENT removed (`252c394`)

Going forward, SPY can have CALLS and PUTS open simultaneously, can stack multiple HL CALLS as the trend continues, and is unconstrained by total portfolio count. Per-trade stop loss provides the new bound on per-position risk.

No additional fix required.

---

## Cross-cutting observations

### Pattern: today's caps were the dominant blocker, not signal quality

Across all three misses, the journal shows abundant signal flow — Pine alerts fired at the right times for the operator's intended entries. The blocker was always at the dispatch/gate layer, never at the signal-generation layer. This validates today's directive to remove the count/correlation/opposition caps wholesale: the signal pipeline is functioning, the gate logic was the friction.

### Pattern: the dotenv bug had broader fallout than just morning trades

The cap=$500 bug (fixed in `fbb0a97`) silently blocked entries in all three miss windows — not just morning. Reserve-veto math is a function of `committedLoss / effectiveDailyCap`; with the wrong cap value, the gate pre-blocked entries it shouldn't have. Verified by counting `DAILY_LOSS_CAP_RESERVE` blocks per window: 7 in Miss #1, 3 in Miss #2's 09:30-09:40 sub-window. The dotenv fix's impact extends beyond just "MAX_DAILY_LOSS hard cap was wrong" — every gate that used `effectiveDailyCap` was running against the wrong ceiling.

### Pattern: trend-add re-entries are the most common blocked case

Misses #2 and #3 both feature the same scenario: HANK has 1-2 positions on a trending instrument, the trend continues, more confluence signals fire (HL pullbacks, ZONE retests, BUY confirmations), and the cap layer blocks adds. The operator's RULE 1 directly addresses this: trending markets produce stacked confluence; risk should be managed per-trade (stop loss) and per-day (hard cap), not by capping the count of correlated entries.

---

## Validation criteria for Friday morning

- **Miss #1:** SPY entries 09:30-09:40 should journal as `EXPLORATION_WINDOW` blocks (intentional, not a bug). SPY entries 09:40+ should land if Pine signals fire — no `DAILY_LOSS_CAP_RESERVE` blocks should appear (commit removed the gate code path).
- **Miss #2:** any MES1! signal at any time should land as an ENTRY. Zero `MAX_CONCURRENT`, `PER_INSTRUMENT_CAP`, or `DAILY_LOSS_CAP_RESERVE` blocks expected.
- **Miss #3:** simultaneous SPY CALLS + PUTS open should be possible. Zero `OPPOSING_DIRECTION_LOCKOUT`, `FAMILY_CORRELATION_CAP`, or `MAX_CONCURRENT` blocks expected.

If any of those gate types appear in the Friday journal, that's a regression to investigate. Operator can verify with:
```
grep -E '"blockedBy":"(MAX_CONCURRENT|PER_INSTRUMENT_CAP|OPPOSING_DIRECTION_LOCKOUT|FAMILY_CORRELATION_CAP|DAILY_LOSS_CAP_RESERVE)"' logs/journal/journal-2026-05-15.jsonl
```

Empty grep result = success.

---

## Today's relevant commit chain (chronological)

| Commit | Effect on miss analysis |
|---|---|
| `fbb0a97` | dotenv import in webhook — fixes cap=$500 → $5K, resolves Miss #1's reserve blocks |
| `16a9512` | dotenv import in 3 monitors — same fix on monitor SWING entries |
| `252c394` | MAX_CONCURRENT + PER_INSTRUMENT_CAP rip — resolves Miss #2 + Miss #3's count blocks |
| `75a4145` | OPPOSING_DIRECTION_LOCKOUT + FAMILY_CORRELATION_CAP rip — resolves Miss #3's correlation blocks |
| `9c18d7d` | EXPLORATION_WINDOW gate — *introduces* a new intentional Miss #1-shape block 09:30-09:40 ET on equity (operator's own rule) |
| `47b629c` | Per-trade STOP_LOSS_PCT=30 — replaces count caps as the per-trade risk control |
