# HANK AI — Autonomous Trading Bot

## What is Hank?
Hank is a fully autonomous AI trading bot. He trades SPY, QQQ, IWM, ES1!, NQ1!
options/futures (0DTE/weekly) on a $25,000 paper account.

**Architecture (as of 2026-05-11):** Pine-as-Primary. The `smc-pro-futures.pine`
indicator running on TradingView Desktop fires `alert()` function calls when
chart-engine signals trigger (BUY/SELL/HTF/ZONE/HL/LH/LIVE). TradingView
forwards the alert as a webhook POST to `webhook-server.js`, which validates
the payload (instrument allow-list, RTH gate) and hands the consensus to
`paperTrading.sendOrder` for execution. The HANK monitors (`monitor.js`,
`monitor-qqq.js`, `monitor-iwm.js`) still compute their own chart-engine
signals for audit / dashboard / mag6-state but **no longer dispatch trades** —
that's the webhook's job now.

## File Locations
C:\Users\tomav\tradingview-mcp-jackson\
- **smc-pro-futures.pine**  — Pine v5 SMC indicator (BOS, CHoCH, sweeps, HL/LH, FVG, alerts) + per-chart instrument override
- **webhook-server.js**     — Pine alert receiver (port 9001, POST /pine-alert). Hardened 2026-05-12: uncaughtException + unhandledRejection handlers, inbound-alert journaling, sendOrder try/catch
- **webhook-supervisor.js** — Auto-restart wrapper for webhook-server.js. **Run this instead of webhook-server.js directly** — catches deaths, logs cause, respawns within 2s
- **monitor.js**            — Mag6 + SPY context refresher (CDP via port 9222)
- **monitor-qqq.js**        — QQQ standalone monitor (W3 components + chart engines)
- **monitor-iwm.js**        — IWM standalone monitor (Mag-3 components + chart engines)
- **paperTrading.js**       — sendOrder / closePosition / exits / tier sizing. Hardened 2026-05-12: defensive simulateFill (handles partial quote objects), underlyingPrice trade-record alias, every sendOrder veto path emits jGateBlock
- **signalConfidence.js**   — applyMultipliers + gate helpers + booster math
- **multipliers.js**        — stackConfidence (base × time × bias × macro4H)
- **journal.js**            — jSignal/jGateBlock/jEntry/jExit/jAlert/jError append-only audit log
- **tier.js**               — Tier sizing + dailyLossCap + maxConcurrent (T1 bumped 2→3 on 2026-05-12)
- **news.js**               — Financial Juice RSS, SEC EDGAR, TTS alerts
- **moc-engine.js**         — MOC trading engine (15:50 confirmation, 15:59 hard exit)
- **moo-moc.js**            — MOO/MOC FJ imbalance producer (writes moc-data.json)
- **webull.js**             — Webull OpenAPI integration + selectContract
- **wsServer.js**           — WebSocket server port 8765
- **briefing.js**           — 08:30 morning briefing
- **mailer.js**             — Email delivery
- **flow.js**               — Options flow MQTT
- **theta.js**              — Theta/IV engine
- **dashboard-server.js**   — Web UI server (port 3000)

Ops tooling (added 2026-05-12):
- **reconcile-ledger.js**   — Read/write tool that detects and corrects underlying-as-option-exit-price bug in paper-ledger.json. Idempotent (skips already-reconciled trades). Writes timestamped backup before mutating
- **analyze-signals.js**    — Per-instrument signal-quality EOD analyzer (16:02 cron). Reads journal + ledger, emits `per-instrument-signal-quality-{YYYY-MM-DD}.md`
- **_test_hierarchy.js**    — 65 assertions covering chart-engine set, boosters, gates

Setup / reference docs:
- **TV-ALERT-SETUP.md**     — One-time per-chart TV alert configuration checklist
- **signal-hierarchy-plan.md** — Original Tuesday chart-first migration plan (pre-Path 2)
- **signal-hierarchy-current-state.md** — Live audit + E.5/E.6 decisions
- **smc-pro-calibration-log.md** — Operator-driven empirical calibration journal (one entry per session observation)
- **paper-trading-pnl-investigation-2026-05-12.md** — Forensic on the IWM +$28K phantom (fixed dfa9b03 + fabdc14)
- **options-pricing-pnl-investigation-2026-05-12.md** — Forensic on the +$1.00 SIGNAL_REVERSAL pattern (fixed 1cdf278)

## Dashboard
http://localhost:3000

## How to Start

**Pine-as-Primary pipeline (required):**
- Window A: `node webhook-supervisor.js`     — Auto-restarting Pine alert receiver wrapper (NOT `webhook-server.js` directly). Supervises a child webhook-server.js process, respawns within 2s on any death, logs cause to `logs/webhook-supervisor.log`. Use this — `webhook-server.js` directly is operationally fragile (died 3x during 2026-05-12 session, each time costing ~30 min of dispatch outage before manual restart)
- Window B: `ngrok http 9001`                — public HTTPS tunnel to webhook
- TV alerts must be configured per `TV-ALERT-SETUP.md` (one alert per chart, 
  condition = "Any alert() function call", webhook URL = current ngrok URL)
- Per-chart Pine override: indicator settings → "Webhook Payload" → "Instrument override" — set explicitly per chart (SPY chart → SPY, ES1! chart → ES1!, etc.) to prevent syminfo.ticker mislabel observed 2026-05-12 ~11:40 ET

**Monitors (context + exits, no dispatch under PINE_PRIMARY):**
- Window 1: `node monitor.js`
- Window 2: `node monitor-qqq.js`
- Window 3: `node monitor-iwm.js`
- Window 4: `node news.js`
- Window 5: `node moc-engine.js`
- Window 6: `node wsServer.js`
- Window 7: `node dashboard-server.js`

**Validation that PINE_PRIMARY is active:** each monitor prints at startup:

```
Dispatch:   PINE_PRIMARY — chart-engine signals computed for audit only;
            Pine→webhook owns trade dispatch
```

## Environment Flags

| Flag | Default | Off behavior |
|---|---|---|
| `PINE_PRIMARY` | `true` | Monitor dispatches chart-engine signals (Pine fallback if webhook down) |
| `HIERARCHY_V2` | `true` | Restores legacy `trendSig` dispatch + drops chart-engine-only gate |
| `TRADING_MODE` | `PAPER` | `LIVE` runs real Webull orders (gated behind WEBULL-SETUP.md) |

Both `PINE_PRIMARY` and `HIERARCHY_V2` are independent kill-switches. Either
restores a layer of the legacy pipeline.

## TradingView Setup
- CDP port 9222
- Stock tab: NVDA, AAPL, MSFT, META, AMZN, GOOGL (Mag-6 panes)
- Claude SPY tab: SPY only
- QQQ tab: AMD, AVGO, TSLA, ARM, NVDA (W3 components)
- IWM tab: BE, CRDO, FN (Mag-3 components)
- Futures tab: ES1!, NQ1!, MES1! (TV alert wired 2026-05-11), MNQ1! (TV alert pending)
- Indicator: **SMC Pro** (`smc-pro-futures.pine`) — visible on every tradable chart
- VWAP Session + Volume Delta on all charts

## Pine Indicator → Signal Mapping

`smc-pro-futures.pine` emits 10 `alert()` function calls. Each builds a JSON
payload Pine → webhook → paperTrading.sendOrder consumes directly:

| Signal | Direction | Engine | Confidence |
|---|---|---|---|
| BUY              | CALLS | BUY  | MEDIUM |
| SELL             | PUTS  | SELL | MEDIUM |
| HTF-aligned BUY  | CALLS | HTF  | HIGH   |
| HTF-aligned SELL | PUTS  | HTF  | HIGH   |
| Bullish Zone Break | CALLS | ZONE | MEDIUM |
| Bearish Zone Break | PUTS  | ZONE | MEDIUM |
| Bullish HL       | CALLS | HL   | MEDIUM |
| Bearish LH       | PUTS  | LH   | MEDIUM |
| LIVE Bullish     | CALLS | LIVE | MEDIUM |
| LIVE Bearish     | PUTS  | LIVE | MEDIUM |

LIVE signals use `alert.freq_once_per_bar` (intra-bar fires); all others use
`alert.freq_once_per_bar_close`.

## Trading Rules
- Instruments: SPY, QQQ, IWM, ES1!, NQ1!, MES1!, MNQ1! (full allow-list in `webhook-server.js:73`: SPY/QQQ/IWM/ES/NQ/ES1!/NQ1!/MES/MNQ/MES1!/MNQ1! — both bare and continuous-front-month forms accepted)
- Account: $25,000 paper (T1 Foundation tier)
- **Max positions: 3 concurrent (T1, bumped from 2 on 2026-05-12 — allows SPY+QQQ+IWM to run in parallel)**
- Max per instrument: 2 open
- Max daily loss: $2,500
- RTH gate: trades only between 09:30 and 15:45 ET (defense-in-depth in
  paperTrading.sendOrder + webhook-server.js)
- TARGET_1.5X chart-engine exit
- §19 SIGNAL_REVERSAL: opposite-direction chart fire closes the open position
- ATR-based option price fallback (0.5% of underlying × 0.4) when chain quotes
  unavailable — keeps signals from PRICE_TOO_LOW blocking en masse
- MOC engine still runs separately (15:50 confirmation, 15:59 hard exit)
- 3 consecutive losses same instrument = 2hr suspend (tier system)

**Removed in Path 2 (2026-05-11):**
- MIDDAY_CHOP gate (was over-filtering chart signals)
- §18 direction-conflict gate (counter-direction trades now allowed; SIGNAL_REVERSAL handles flip)
- gateMacro4H + gateVwap booster stack on top of executeScalpSignal (chart engines 
  flow straight from basic gates to tier sizing — helpers still exist in 
  `signalConfidence.js`, just unwired)

## Webull API
- App key: ef4b4bc21d862c8f8d9f8d003713ed26
- Production: api.webull.com (sole endpoint — UAT support removed in `may-11-webull-uat-cleanup`)
- Account: ICIUR8Q1AKI50628B9RQ3EG0IB
- 2FA: disabled
- Status: connected and authenticated (`/openapi/account/list` returns 200 OK)

**Signature algorithm (per Webull spec 2026-05-11):**
- HMAC-SHA1 for read endpoints (account list, etc.)
- HMAC-SHA256 for trade-scope endpoints (`/openapi/trade/*`) — auto-detected by path in `generateSignature()`

**Three independent tokens:**
| File | Purpose | Acquire via |
|---|---|---|
| `.webull_token` | OpenAPI 2FA token (legacy, 2FA disabled) | `node webull.js --auth` |
| `.webull_consumer_token` | Consumer session token — needed for options chain reads (separate from OpenAPI scope) | `node webull.js --consumer-login` (paste from web.webull.com DevTools) |
| `.webull_trade_token` | Trade token (`x-trade-token` header) — required for `/openapi/trade/*` order POSTs | `node webull.js --trade-token-login` (6-digit trading password) |

**Live order placement (pre-staged in `may-11-webull-live-prestage`, untested):**
- Body schema migrated to Webull's 2026-05-11 spec: flat camelCase (`orderId`, `tickerId`, `action`, `orderType`, `lmtPrice`, `quantity`, `timeInForce`, `orderSide`, `category`)
- `lookupOptionContractTickerId(symbol, strike, expiry, type)` resolves the Webull-internal numeric tickerId from the consumer-API option chain (Webull requires this — OSI strings no longer accepted by order endpoint)
- `x-trade-token` header auto-injected by `apiRequest()` on `/openapi/trade/*` calls
- `placeOptionsOrder` fails fast with actionable error messages if either token or tickerId is missing
- First live order attempt is the empirical validation: one 1-contract test trade after `--consumer-login` + `--trade-token-login`, with `TRADING_MODE=LIVE`. Failure mode (if any) returns specific error from `placeOptionsOrder` for targeted iteration

**Trading permissions:** NOT a separate gate. Webull's app approval includes trading. The May 5 `OAUTH_OPENAPI_PARAM_ERR "invalid client_order_id"` was misdiagnosed at the time as a permissions issue — actually a parameter-validation rejection of the legacy schema. Resolved in `may-11-webull-live-prestage`.

**Options chain (separate from order placement):** Consumer endpoint (`quotes-gw.webullfintech.com`) with consumer token. Until `.webull_consumer_token` is populated, monitors use ATR fallback (`underlying × 0.005 × 0.4`) for option entry prices — sufficient for paper P&L modeling.

**OPENAPI option-chain endpoint testing (2026-05-11, 3 rounds, all failed):**
| Round | Webull-stated path | Result |
|---|---|---|
| 1 | `/openapi/quote/option/strategy/list` | 404 across 8 variants |
| 2 | `/openapi/quote/option/list` | 404 across 3 variants |
| 2 | `/openapi/instrument/option/list` (route exists but param schema unguessable) | 400 "Parameters not valid" across 21 param combinations |
| 3 | `/openapi/quote/option/chain/list` | 404 across 10 variants (including empty) |

Three rounds of Webull support specs failed against `api.webull.com` with our verified HMAC credentials. Round 3's "verified curl example" had URL set to `https://webull.com` (the homepage), no query params, all placeholder values — not actually a working example. Conclusion: **the OPENAPI option-chain endpoint is either not provisioned for our App ID's scope or Webull's documentation diverges from their deployed routes**. The consumer-API path (`quotes-gw.webullfintech.com`) is the documented and proven alternative; no blocker for live trading.

## Git State
- Local origin → `https://github.com/tavery2000/tradingview-mcp-jackson` (fork)
- Upstream → `LewisWJackson/tradingview-mcp-jackson` (no write access — fork required)
- Backup remote → `file:///C:/Users/tomav/hank-backup.git` (autonomous backup)
- Today's work lives on branch `pine-primary` on the fork (25 commits ahead of fork's main, which still tracks Lewis's upstream)

**Tags (chronological, newest last):**
- `pre-task-7` — rollback before hierarchy work
- `may-9-hygiene` — prior week
- `may-11-hierarchy` — Path 2 dispatch strip + macro4H plumbing
- `may-11-pine-primary` — Pine-as-Primary, webhook owns dispatch
- `may-11-webull-uat-cleanup` — drop UAT endpoint, prod-only
- `may-11-webull-live-prestage` — live order placement scaffolding per Webull spec
- `may-12-spy-levels-write-fix` — `_spyVolumePct` typo fix (file never wrote since first commit)
- `may-12-emergency-dispatch-fix` — webhook-supervisor.js auto-restart wrapper
- `may-12-webhook-server-crash-fix` — three webhook-server.js hardenings (uncaught handlers, inbound journal, sendOrder try/catch)
- `may-12-pine-instrument-override` — per-chart instrument override input (prevents syminfo.ticker mislabel)
- `may-12-signal-reversal-pnl-fix` — defensive simulateFill + underlyingPrice trade alias (fixes deterministic +$1.00 exits)
- `may-12-veto-journaling` — jGateBlock on every sendOrder veto path (visibility into MAX_CONCURRENT / DAILY_LOSS_CAP / etc.)
- `may-12-tier1-maxconcur-3` — T1 maxConcurrent bumped 2 → 3 (HEAD)

## Today's Commits (2026-05-12)

Thirteen commits today, all addressing pipeline stability / observability / P&L accuracy / late-day gating. None are "feature work" — all are hardening, bug fixes, or post-session synthesis from live trading hours.

- `2f28ab3` config(tier): T1 maxConcurrent 2 → 3 (allow SPY+QQQ+IWM parallel)
- `4881865` fix(paperTrading): journal every sendOrder veto via jGateBlock (visibility)
- `1cdf278` fix(paperTrading): defensive simulateFill + underlyingPrice trade alias (fixes +$1.00 deterministic exits)
- `c11a38a` docs(calibration): SPY false BUY at 11:55 + override-toast resolved
- `12f5e50` feat(pine): per-chart instrument override input (prevents syminfo.ticker mislabel)
- `82681ce` fix(webhook): three hardenings (uncaughtException, inbound journal, sendOrder try/catch)
- `d012e47` feat(ops): webhook-supervisor.js auto-restart wrapper
- `cfe6aa2` fix(monitor): spy-levels.json `_spyVolumePct` typo (file silent for weeks)
- `fabdc14` tools: reconcile-ledger.js + paper-trading P&L investigation
- `dfa9b03` fix(swing): underlying→option conversion in monitor-iwm.js/monitor-qqq.js executeSwingExit (fixes IWM +$28K phantom)
- `1c801bd` docs(eod): SPY 1M +92% operator vs HANK +37% comparison; Decision 5 added
- `fa7afc2` docs(analysis): per-instrument signal quality 2026-05-12 (392 RTH signals)
- `3ad575a` feat(webhook): **LATE_DAY_ENTRY_0DTE gate at 15:30 ET — closes Decision 5**

### Bugs uncovered and fixed today

| # | Bug | Symptom | Root cause | Fix |
|---|---|---|---|---|
| 1 | IWM SWING exit underlying-as-option | +$28,246.93 phantom on a 1-contract paper trade | `monitor-iwm.js:956` passed `swingState.exitPrice` (underlying price) to `closePosition` which treats it as option premium. monitor.js had the SPY fix at line 2287-2298; never propagated to QQQ/IWM | `dfa9b03` ports the SWING_DELTA=0.50 conversion. `fabdc14` reconciles the ledger |
| 2 | spy-levels.json never updates | Briefing/dashboard/ASK-HANK reading 5-day-stale SPY data | `_spyVolumePct` (extra "ume") typo at `monitor.js:2943-2944`; ReferenceError silently swallowed by wrapping try/catch | `cfe6aa2` — use the correct `_spyVolPct` |
| 3 | webhook-server.js silently dies | Multi-minute dispatch outages, manual restart required each time | Process exits with no journal trail (terminal-close, OS event, or silent throw) | `d012e47` adds webhook-supervisor.js (auto-restart). `82681ce` adds uncaughtException/unhandledRejection/sendOrder-try-catch handlers so future deaths log to journal |
| 4 | TV alert payload mislabel | SPY chart emitted `"instrument":"ES1!"` in webhook payload | `syminfo.ticker` resolution between chart and alert context | `12f5e50` adds per-chart override input (defaults to AUTO, operator sets explicitly per chart) |
| 5 | +$1.00 deterministic SIGNAL_REVERSAL exits | Every webhook SIGNAL_REVERSAL exit closed at exactly +$1.00, regardless of underlying direction | Two compounding: simulateFill produced NaN→null fillPrice from partial `{mid}` quote object; SIGNAL_REVERSAL read `oppositeOpen.underlyingPrice` which didn't exist (actual field is `entryUnderlying`) | `1cdf278` — defensive simulateFill + underlyingPrice alias on trade record |
| 6 | sendOrder vetoes invisible | "Why didn't QQQ fire?" took probe-and-guess to answer | sendOrder veto paths returned `{vetoed:true, reason}` to caller but didn't journal | `4881865` — jGateBlock on all 5 veto paths with structured detail (open instruments, caps, tier) |

### Today's operational pattern — Code-fix → child-restart cycle

Most fixes to paperTrading.js / webhook-server.js required restarting the webhook child process (which has the JS modules in memory) for the fix to activate. Pattern:
1. Make code change, commit, push
2. `Stop-Process` the webhook-server.js child (find via `Get-Process node`)
3. Supervisor catches the death within 2s, respawns with fresh module imports = fix loaded
4. Verify with a probe POST to `/pine-alert` or wait for next real signal

This cycle happened 4 times today. Each restart created ~2-5s of dispatch downtime. No alternative — Node modules don't hot-reload.

### Today's recurring blind spot — operator over-attribution

Three "EMERGENCY: fix N stacked bugs" tasks today contained bugs that were already fixed or weren't bugs:
- IWM +$28K bug was real (fix held)
- spy-levels.json was real (one-line typo)
- The +$1.00 was real and got fixed
- BUT "QQQ DEAD," "SPY position stuck," "fixes were too aggressive" — all journal-verifiable as NOT-bugs before code changes were attempted

Pattern: stress-bundling 3 things, two of which need verification not fixing. Resolution: run journal diagnostics first, push back on misattributions, fix what's actually real. The veto-journaling hardening (`4881865`) is largely about preventing this in the future — "why didn't this fire?" should resolve via `grep GATE_BLOCK` not via 30 minutes of cross-instrument investigation.

## Architectural Observations — Live Trading 2026-05-12

Three distinct architectural concerns surfaced from today's live SPY 30sec data. These add a new dimension to the calibration picture: the May 11 chart-first hierarchy migration was about **WHAT** signals fire (engine set, gates, boosters); these observations are about **WHEN** signals fire and **WHEN to listen to them**.

Yesterday's hierarchy work is NOT invalidated. These are an additional layer.

Forensic detail per observation is in `smc-pro-calibration-log.md`. Implementation options for each are in `pending-architectural-decisions.md`.

### Observation 1 — Signal Timing Lag (Sweep vs Confirmation)

**Time:** ~14:15 ET, SPY 30sec
**Mechanic:** The `bullBreak` / `bearBreak` OR-chain (smc-pro-futures.pine:611-612) does NOT include `bullSweepRaw` / `bearSweepRaw`. Sweep detection (blue diamond) is downstream confluence, never a trigger. Fire happens at the structure-break bar AFTER the sweep — typically 2-3 bars later on 30sec = 60-90 second timing lag.
**Operator observation:** *"Signals are late. I'm manual trading at LL (blue dot) while Hank does not see the signal until BUY is fired. By then the play is over."*
**Result:**
- HANK enters at structure-confirmation bar, exits via SIGNAL_REVERSAL on next opposite alert → $1 to small gains
- Operator enters at sweep, exits at structure confirmation → 25-80% gains on same setups
- The +$80 SPY winner at 13:37 was the exception (no opposite signal arrived during the run); the median outcome is "entered late, flushed by next opposite alert"

**Architectural fix candidates** (full sketch in `pending-architectural-decisions.md`):
- **A. Two-stage signal** — Tier 1 alert at sweep, Tier 2 at confirmation
- **B. Trail-the-sweep** — arm entry state on sweep, fire if structural confirmation within N bars
- **C. Different signal threshold per timeframe** — sweep-as-trigger only on ≤1M timeframes

### Observation 2 — Chop Detection Required

**Time:** ~14:45 ET, SPY 30sec (after preceding rally completed)
**Mechanic:** Indicator fires every structural pivot regardless of whether the broader market regime is trending or ranging. Inside a tight 4-6¢ chop range (735.99-736.45 for 20 minutes), the LH/HL/LL geometric shapes are identical to those produced by reversal entries — current code can't distinguish.
**Operator quote:** *"This just cannot be traded, not even by me."*
**Result:** Multiple BUY/SELL fires inside the chop box, every one a losing trade after SIGNAL_REVERSAL whipsaw closes it for a small loss before the next opposite alert.

**Architectural fix candidates:**
- **A. Operator-side** — manual timeframe switch at fixed time of day (cheapest, no code)
- **B. Pine-side** — ATR-based or range-based chop detection input that suspends BUY/SELL fires when chop conditions met
- **C. HANK-side** — chop detection in `monitor.js` or `webhook-server.js` that ignores incoming Pine signals when range-bound bars exceed N

### Observation 3 — Time-of-Day Timeframe Rule

**Pattern emerged across today's data:**

| Time window | Regime | 30sec verdict |
|---|---|---|
| 08:00-09:15 ET (pre-market) | Low-volume directional moves | 30sec wins — catches early entries |
| 09:30-13:00 ET (NY morning) | Real directional moves | 30sec captures cleanly, realistic P&L on post-fix pipeline |
| 13:00-15:00 ET (midday) | Chop / consolidation | 30sec loses — too many fake signals, SIGNAL_REVERSAL whipsaw |
| 15:00-16:00 ET (power hour) | Mixed | TBD — need more data |

**Operator hypothesis:** A simple time-of-day rule for timeframe selection beats trying to detect regime algorithmically. SPY 30sec is a SCOUTING tool best deployed during directional periods; SPY 1min is a CONFIRMATION tool that averages out the chop.

**Architectural fix candidates:**
- **A. Manual operator switch** — 30sec → 1min at 13:00 ET → 30sec at 15:00 ET (or some variation)
- **B. Adaptive timeframe** based on chop detection (composes with Observation 2's fix)
- **C. Parallel 30sec + 1min alerts** — HANK picks based on chop state

### Common architectural family

All three observations share the same root: **the indicator + exit logic are context-blind in ways the operator's discretionary trading isn't.** Yesterday's hierarchy migration encoded direction and macro alignment. Today's observations reveal three more context dimensions that current code doesn't weight: signal-vs-noise (timing), trend-vs-chop (regime), time-of-day-vs-timeframe (matching the tool to the moment).

Post-close decision pool consolidated to `pending-architectural-decisions.md`. None decided today — all deferred per session-discipline (operator's own log entry framing: "no architectural Pine change with N min to close").

## Session-End Summary — 2026-05-12 EOD

### Headline numbers
- **First full RTH day under Pine-as-Primary architecture.** 392 inbound Pine signals across 6 active instruments (SPY/QQQ/IWM/ES1!/NQ1!/MES1!). MNQ1! intentionally not active until 2026-06-01.
- **Daily P&L: -$187.70** (vs +$1,706.64 on 2026-05-11 paper baseline). Account balance post-reconcile: $26,744.78.
- **Three concurrent positions allowed (T1 bumped 2→3 this morning).** SPY/QQQ/IWM ran in parallel.
- **Operator manual +92% SPY 1M power-hour scalp** (entry HL ~737.10 at 14:55-15:00, exit ~738.50 at HH). HANK detected the same setup at 15:07:30 (~12 min late) and captured +$108.80 across CALLS ZONE + CALLS BUY at +37% each — proof detection works; gap is fire-timing precision.

### Per-instrument signal quality (16:02 ET analyzer, full table in `per-instrument-signal-quality-2026-05-12.md`)

| Instrument | Signals | T+5 cont% | 5-min WR |
|---|---:|---:|---:|
| SPY (30sec) | 114 | 57.6% | 57.6% |
| QQQ (1m) | 59 | 57.9% | 57.9% (best) |
| IWM (1m) | 57 | 43.9% | 43.9% (worst — 13.7pp below SPY) |
| ES1! (1m) | 56 | 46.9% | 46.9% |
| NQ1! (1m) | 52 | 46.2% | 46.2% |
| MES1! (1m) | 54 | 46.9% | 46.9% |

**Empirical answer to "should SPY stay on 30sec?":** YES at HANK's current SIGNAL_REVERSAL exit horizon (T+5 cont rate ties QQQ at 57.6%/57.9% on 2x the signal volume). The T+5→T+30 decay (57.6 → 43.1) confirms 30sec is a scouting tool, not a hold tool — pairs naturally with operator-side timeframe switch for chop periods (Decision 2-A / 3-A).

### Bugs uncovered + fixed today (six surgical commits during market hours)
See "Bugs uncovered and fixed today" table above (rows 1-6). All fixed and pushed. Webhook child restarted 5 times today; 4 were deliberate fix-load restarts, 1 was the post-close gate restart at 16:39. **Zero silent crashes** since supervisor took over at 11:07 ET.

### Three-axis architectural frame (locked 15:35 ET)

Today's findings decompose into THREE INDEPENDENT axes — not one fix. The 15:30 MES1! 1M observation (12-min lag on 1M, same mechanism as 30sec 60-90s lag) proved lag and chop are orthogonal:

| Axis | Layer | Status |
|---|---|---|
| 1 — Signal timing lag (sweep vs structure-break) | Pine code | Decision 1 — recommended A (two-stage signal); pending |
| 2 — Chop noise filter | Operator workflow | Decision 2 — recommended A (TF switch); validated 1 day |
| 3 — Per-engine gating + late-day cutoff | HANK gate logic | Decision 4 pending; **Decision 5 SHIPPED today** |

### Decisions shipped today
- **Decision 5 — LATE_DAY_ENTRY_0DTE gate** (commit `3ad575a`): Block new SPY/QQQ/IWM entries after 15:30 ET. Investigated the HARD_EXIT pricing math (BS chain in monitor.js:3013 + theta.js:98 verified correct, frozen entryIV mildly punitive vs real-market vol ramp). The 15:42/15:43 -$169.19 was real theta-burn from entering near-ATM 0DTE 15-16 min before close, not a pricing artifact. Gate placed after SIGNAL_REVERSAL so late-day opposite alerts still close existing positions; only new entries blocked. **Webhook child restarted 16:39 ET, gate live.**

### Decisions pending (post-close work block)
- **Decision 1** — Pine timing-lag fix (pivot-extreme trigger with confluence). Primary post-close engineering work. Bounded investigation: replay today's 392 signals against hypothetical sweep-as-trigger before shipping.
- **Decision 2** — Chop detection (recommended A: operator-side TF switch). Validated 1 day; needs 3-5 more sessions before judging A sufficient vs graduating to B/C.
- **Decision 3** — Time-of-day TF rule (recommended A: 30sec→1m at 13:00→30sec at 15:00). Same status as Decision 2; validate as workflow before automating.
- **Decision 4** — Per-engine gating. IWM flagged as candidate by today's analyzer (13.7pp below SPY at T+5); needs 3-5 sessions of by-engine data before tuning thresholds.

### Tomorrow morning checklist (operator) — UPDATED 2026-05-12 EOD

1. **Decide SPY chart timeframe** before open. Today's analyzer empirically supports keeping SPY on **30sec at open** (57.6% T+5 cont on 2x volume). Plan to switch to **1m around 13:00 ET** if chop pattern repeats. Both via TV chart settings — no code change.
2. Confirm 6 TV alerts configured (SPY/QQQ/IWM/ES1!/NQ1!/MES1!) per `TV-ALERT-SETUP.md`. **MNQ1! not active until 2026-06-01 — do NOT investigate "0 MNQ signals" before that date.**
3. Confirm ngrok URL hasn't rotated.
4. Start `webhook-supervisor.js` (auto-restart wrapper) + `ngrok http 9001`. Verify `/health` returns ok=true.
5. Start monitors (`monitor.js` / `monitor-qqq.js` / `monitor-iwm.js`) — verify `PINE_PRIMARY` startup line on each.
6. First Pine signal: ngrok inspector → `POST /pine-alert 200`, journal contains `pine-alert.inbound` ALERT record.
7. Paper-ledger entry: verify `engine` matches Pine's emitted engine, `fillPrice` non-null, `underlyingPrice` present.
8. **NEW: After 15:30 ET, expect SPY/QQQ/IWM Pine alerts to journal as `GATE_BLOCK reason=LATE_DAY_ENTRY_0DTE` instead of opening positions.** SIGNAL_REVERSAL still closes existing positions through 15:30-15:45 window. Confirm pattern in journal during first late-day signal.
9. If webhook down: `set PINE_PRIMARY=false`, restart monitor.js → back on monitor dispatch within 30s.
10. **First chop period observed** (4-6¢ sustained 10+ min): consider TV-side SPY 30sec→1m switch per Decision 2-A; log to `smc-pro-calibration-log.md`.
11. Watch SIGNAL_REVERSAL whipsaw pattern; log if observed.

### Operator collaboration pattern (from today)

- Stress-bundled "EMERGENCY: fix N bugs" tasks frequently contain 1-2 not-actually-bugs. Verify journal/ledger evidence BEFORE code change.
- Architectural-observation logging during live trading was high-value — produced the three-axis frame and Decision 5 cleanly.
- Pricing-math investigations should run first when symptoms are extreme (-$99 / -$70 in 2 min); often the math is right and the strategy needs adjusting (today's case).

## Yesterday's Commits (2026-05-11)
- `c73b666` chore(webhook): add MES/MNQ to instrument allow-list (enables Micro E-mini futures payloads per project_1k_scaleup_plan)
- `ffd0d8d` docs(briefing): May 11 EOD update — Webull intel + 3-stage testing ladder
- `b5d4443` feat(webull): pre-stage live order placement per 2026-05-11 spec (HMAC-SHA256 for trade scope, trade-token flow, body schema migration to flat camelCase with tickerId, lookupOptionContractTickerId helper, --trade-token-login CLI)
- `89b16fd` chore(webull): drop UAT endpoint, run prod-only
- `8238f77` feat(hierarchy): Pine-as-Primary — webhook owns all chart-engine dispatch
- `c363bfb` feat(hierarchy): finish Path 2 dispatch strip + macro4H journal plumbing
- `b298ddd` pine-poll v4: cumulative counters — kept as experimental fallback
- `111961e` Phase 2 alt: CDP-based Pine alert poller (replaces TV webhook path)
- `3d90bd3` Phase 1: Pine-as-Primary architecture — webhook receiver
- `705dab2` Add §19 signal-reversal exit
- `01a8eed` Tighten profit target — TARGET_2X to TARGET_1.5X
- `6a62c78` Add ATR-based option price fallback
- `1910eac` Strip bias machinery — Path 2 simplification
- `1655627` Add §18 direction conflict suppression
- `1fea67a` Ship signal hierarchy v2 — chart-first dispatch with HIERARCHY_V2 toggle
- `f86ebfb` Add RTH gate to paperTrading.sendOrder
- `ad936db` Fix DTE label off-by-one in webull.js

## Build Roadmap
- Saturday May 9 — Electron desktop app build (deferred)
  - Electron shell around hank-electron-r3.html
  - wsServer live data wiring
  - Webull options chain live data
  - flow.js MQTT schema confirmation
  - Voice Bridge (TTS/STT — Hank speaks, you respond by voice)
- Tomorrow May 12 — first live RTH session under Pine-as-Primary
  - Validate webhook receiving real signals during market hours
  - Watch GATE_BLOCK rates (per sub-question #6 sunset metric)
  - Confirm tier sizing handles MEDIUM chart signals correctly without booster stack

## Current Status (2026-05-11 EOD)

**Architecture pivots shipped:**
1. Path 2 simplification — stripped over-filtering gates from monitors after morning data showed signals being suppressed (3 trades, +$56.24, missed rally)
2. Pine `alert()` function calls in `smc-pro-futures.pine` — autonomous webhook dispatch
3. webhook-server.js + ngrok tunnel — Pine→webhook→paperTrading pipeline operational
4. Pine-as-Primary commit (Option C) — monitors deprecated from signal dispatch under `PINE_PRIMARY=true`
5. macro4H field plumbed through consensus → trade → ENTRY journal
6. 65/65 hierarchy unit tests passing
7. GitHub fork created (`tavery2000/tradingview-mcp-jackson`)
8. Webull UAT endpoint removed — prod-only signing (`api.webull.com`), `--test` flag retained as a connection test against prod (Step 2 returns 200 OK)
9. Webull live order placement pre-staged per 2026-05-11 spec — HMAC-SHA256 for trade-scope, `x-trade-token` auto-injection, flat camelCase body schema with tickerId, `--trade-token-login` CLI, fail-fast guards in `placeOptionsOrder`. Untested in LIVE mode (paper-only throughout codebase); first live order is a deliberate operator-driven event with both tokens loaded.
10. Webhook allow-list extended to MES/MNQ (both bare and `1!` forms) per `project_1k_scaleup_plan.md` futures scaling. MES1! TV alert configured by operator 2026-05-11 EOD — MES paper trades will route end-to-end starting next session. MNQ1! TV alert still pending operator setup; code-side ready.
11. §18 architectural gap logged (`timeframe-behavior-analysis.md` §18 + `smc-pro-calibration-log.md`) — demand-zone-breakdown SELL trigger missing, distinct from §10's supply-rejection-SELL geometry. Not shipped; threshold criterion needs 1–2 more observations Tue–Wed before implementation.
12. Late-session 5/11 validation: MES1! 1M indicator ~80% accurate across 9 signals over 2.25 hours of after-hours tape. Confirms chart-first hierarchy decision was right; remaining gaps are zone-break-specific (§10, §18), not structural fire logic.

**Webhook validated end-of-day.** Pine alert → ngrok → webhook-server → paperTrading.sendOrder path proven.

**Tomorrow morning checklist (operator):**
1. **Decide SPY chart timeframe** before open (operator architectural-observation 3 from 2026-05-12): start on **30sec** (catches early NY-morning directional moves better) OR start on **1min** (chop-safer if midday chop expected). Default recommended: **start 30sec, plan to switch to 1min around 13:00 ET** if previous day's pattern holds. Both choices are operator-side via TV chart settings — no code change. Same question for MES1!.
2. Confirm 6 TV alerts configured (SPY/QQQ/IWM/ES1!/NQ1!/MES1!) per `TV-ALERT-SETUP.md` — MNQ1! still pending operator setup, code-side ready when you're ready
3. Confirm ngrok URL hasn't rotated (paste current URL into the 6 alerts if it has)
4. Start `webhook-supervisor.js` (NOT `webhook-server.js` directly — supervisor auto-restarts on death, logs cause to `logs/webhook-supervisor.log`), start `ngrok http 9001`
5. Start `monitor.js` — verify the `PINE_PRIMARY` startup line prints
6. First Pine signal → ngrok inspector shows `POST /pine-alert 200`, journal contains a `pine-alert.inbound` ALERT record (hardening 82681ce)
7. Paper-ledger gets entry; verify `engine` field matches Pine's emitted engine, `fillPrice` is non-null (verifies simulateFill fix 1cdf278), `underlyingPrice` present (verifies alias from same commit)
8. If webhook down: `set PINE_PRIMARY=false`, restart monitor.js — back on monitor dispatch within 30s
9. **First chop period observed** (4-6¢ ranges sustained for 10+ min, especially mid-day): consider TV-side switch to 1min on SPY and/or MES per Observation 3, OR bump `Signal cooldown (bars)` in Pine indicator settings dialog from 20 → 40
10. Watch for SIGNAL_REVERSAL whipsaw pattern (multiple opposite-direction flips per chart within 5min): if observed, log to `smc-pro-calibration-log.md` for post-session review and confirm Observation 1's mechanic still applies

## Webull-Routed Testing Ladder

Three distinct test stages, in order. Each gates the next. Operator vocabulary
in parentheses.

| Stage | What it tests | Where the fills come from | Capital at risk |
|---|---|---|---|
| 1. Local paper (active today) | HANK signal logic + exits | `paperTrading.js` simulates fills locally | $0 — no Webull calls |
| 2. **Live paper-trade via Webull** ("live paper test") | The full Webull pipeline: auth, trade-token, schema, endpoint, idempotency — but with an order priced to never fill (e.g., $0.01 bid on an option worth $5+) | Webull's real production API accepts the order into the book; it sits unfilled; we cancel it | $0 — order never fills |
| 3. Real-money LIVE trading | Pine signals firing through Webull for real | Webull executes at market | Real capital — only after stages 1 and 2 are clean |

Stage 1 starts tomorrow morning (09:30 ET) — no action needed beyond the daily
checklist above.

### Stage 2 — Live paper-trade via Webull (the "live test")

Validates the entire Webull pipeline at zero capital risk. Run during market
hours so the order can sit in the book briefly before cancellation.

**One-time per session:**

1. `node webull.js --consumer-login` — paste consumer token from web.webull.com DevTools (15-day expiry, needed for tickerId lookup)
2. `node webull.js --trade-token-login` — enter 6-digit trading password (session expiry, needed for x-trade-token header)
3. `node webull.js --test SPY` — confirms Step 3 ✓ consumer + Step 4 ✓ trade-token both green

**The validation order itself (one deliberate event during market hours):**

Place ONE 1-contract bid at $0.01 on an SPY option that's actually worth $5+:
- Order POSTs to `/openapi/trade/option/order/place` with the new flat camelCase body
- Webull accepts the order into the book (since bid is structurally valid)
- Order sits unfilled (no one's selling at $0.01)
- You cancel it manually via Webull mobile app or `--cancel-order` (CLI not yet added)
- A 200 OK on the POST validates the entire pre-staged pipeline:
  - HMAC-SHA256 signing for trade-scope ✓
  - `x-trade-token` header injection ✓
  - Flat camelCase body (`orderId`/`tickerId`/`action`/`orderType`/`lmtPrice`/`quantity`/`timeInForce`/`orderSide`/`category`) ✓
  - tickerId lookup via consumer-API chain ✓
- If non-200 → capture exact error from Webull, iterate one field at a time

**Why this test exists:** every component in `may-11-webull-live-prestage` is
mechanically reasonable but empirically untested. A $0.01 bid validates the
full Webull pipeline (auth, tokens, schema, endpoint, idempotency) at zero
capital risk. Treating the first real signal-driven live order as the
validation event would conflate "Webull schema issue" with "trading-edge bad"
— wasteful and hard to debug.

### Stage 3 — Real-money LIVE trading

Only after Stage 1 (paper) shows 5 clean trading days AND Stage 2 (live
paper-trade) returns 200 OK on the validation order.

**Stage 1 gating criteria (5-day paper validation):**
- Pine signals firing as expected (cross-reference with manual chart reads)
- No mystery GATE_BLOCKs in journal
- Tier sizing producing reasonable contract counts
- §19 SIGNAL_REVERSAL closing opposite-direction positions
- EOD_CLOSE flattening all positions at 15:45 ET
- No `PRICE_TOO_LOW`, `NEWS_BIAS_*`, or similar gates firing more than expected

**Activation:** Set `TRADING_MODE=LIVE`, restart `webhook-server.js`. Pine signals
now route to Webull for real fills. Both tokens must remain loaded.

**Kill switches if Stage 3 misbehaves:** Set `TRADING_MODE=PAPER` and restart →
back on local paper fills within 30s. Pine continues firing signals; only the
dispatch destination changes.
