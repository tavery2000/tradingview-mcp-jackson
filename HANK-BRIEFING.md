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
- **smc-pro-futures.pine**  — Pine v5 SMC indicator (BOS, CHoCH, sweeps, HL/LH, FVG, alerts)
- **webhook-server.js**     — Pine alert receiver (port 9001, POST /pine-alert)
- **monitor.js**            — Mag6 + SPY context refresher (CDP via port 9222)
- **monitor-qqq.js**        — QQQ standalone monitor (W3 components + chart engines)
- **monitor-iwm.js**        — IWM standalone monitor (Mag-3 components + chart engines)
- **paperTrading.js**       — sendOrder / closePosition / exits / tier sizing
- **signalConfidence.js**   — applyMultipliers + gate helpers + booster math
- **multipliers.js**        — stackConfidence (base × time × bias × macro4H)
- **journal.js**            — jSignal/jGateBlock/jEntry/jExit append-only audit log
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

Setup / reference docs:
- **TV-ALERT-SETUP.md**     — One-time per-chart TV alert configuration checklist
- **signal-hierarchy-plan.md** — Original Tuesday chart-first migration plan (pre-Path 2)
- **signal-hierarchy-current-state.md** — Live audit + E.5/E.6 decisions
- **_test_hierarchy.js**    — 65 assertions covering chart-engine set, boosters, gates

## Dashboard
http://localhost:3000

## How to Start

**Pine-as-Primary pipeline (required):**
- Window A: `node webhook-server.js`         — Pine alert receiver (port 9001)
- Window B: `ngrok http 9001`                — public HTTPS tunnel to webhook
- TV alerts must be configured per `TV-ALERT-SETUP.md` (one alert per chart, 
  condition = "Any alert() function call", webhook URL = current ngrok URL)

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
- Account: $25,000 paper
- Max positions: 2 concurrent (3 when W3 ≥ 4)
- Max per instrument: 1 open
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

**Tags:**
- `pre-task-7` — rollback point before today's hierarchy work
- `may-9-hygiene` — prior week
- `may-11-hierarchy` — finish Path 2 dispatch strip + macro4H journal plumbing
- `may-11-pine-primary` — Pine-as-Primary, webhook owns all chart-engine dispatch
- `may-11-webull-uat-cleanup` — drop UAT endpoint, prod-only
- `may-11-webull-live-prestage` — live order placement scaffolding per 2026-05-11 Webull spec (HEAD)

## Today's Commits (2026-05-11)
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

**Webhook validated end-of-day.** Pine alert → ngrok → webhook-server → paperTrading.sendOrder path proven.

**Tomorrow morning checklist (operator):**
1. Confirm 6 TV alerts configured (SPY/QQQ/IWM/ES1!/NQ1!/MES1!) per `TV-ALERT-SETUP.md` — MNQ1! still pending operator setup, code-side ready when you're ready
2. Confirm ngrok URL hasn't rotated (paste current URL into the 5 alerts if it has)
3. Start `webhook-server.js`, start `ngrok http 9001`
4. Start `monitor.js` — verify the `PINE_PRIMARY` startup line prints
5. First Pine signal → ngrok inspector shows `POST /pine-alert 200`
6. Paper-ledger gets entry; verify `engine` field matches Pine's emitted engine
7. If webhook down: `set PINE_PRIMARY=false`, restart monitor.js — back on monitor dispatch within 30s

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
