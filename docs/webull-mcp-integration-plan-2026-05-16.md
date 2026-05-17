# Webull OpenAPI MCP Integration Plan — 2026-05-16

**Author:** Claude Code (Phase 1: complete — A through E plus locked decisions per operator)
**Status:** No code changes. Pure analysis. Implementation starts Monday 5/18.
**Source repos:**
- [webull-inc/webull-mcp-server](https://github.com/webull-inc/webull-mcp-server) — **PRIMARY target** (last release v0.1.1 dated 2026-04-18; 2 releases, 3 commits visible — newly published)
- [webull-inc/webull-openapi-python-sdk](https://github.com/webull-inc/webull-openapi-python-sdk) — pinned dependency of MCP server (v2.0.5)
- [webull-inc/webull-agent-skills](https://github.com/webull-inc/webull-agent-skills) — **NOT REQUIRED** (independent CLI for AI agents to use the Python SDK; not a dependency of MCP server). Listed in directive for completeness; out of scope for HANK.

**Operator framing:** Webull is the brokerage pipe, HANK is the engine. June 1 production-flip target stands. This plan implements migration via the official MCP server.

---

## Section A — MCP Server Setup

### A.1 — Runtime + install

The MCP server is **Python 3.10+** (we will spawn it as a child process from `webhook-server.js` over MCP stdio). Three install methods, recommended order for HANK:

```bash
# Recommended — uvx runs without persistent install (clean for service workers)
uvx webull-openapi-mcp serve

# Or persistent install
pip install webull-openapi-mcp
webull-openapi-mcp serve

# Or local clone (only if we need to patch)
git clone https://github.com/webull-inc/webull-mcp-server.git
cd webull-mcp-server
uv sync
uv run python -m webull_openapi_mcp serve
```

**Prereq install on operator's machine (Q1 answered):**
1. Python 3.14 — **ALREADY INSTALLED** ✓
2. `uv` package manager — `pip install uv` (operator-confirmed install path)
3. Then `uvx webull-openapi-mcp --help` to verify the MCP server resolves
4. Then `uvx webull-openapi-mcp auth` for the one-time 2FA dance

Document this in Section D, Mon 5/18 task list.

### A.2 — Authentication flow

Credentials needed:
- **AK / SK** (App Key + App Secret) from your Webull Developer Account at https://developer.webull.com (US region; same as current HANK's `WEBULL_APP_KEY` / `WEBULL_APP_SECRET`)
- Existing AK/SK from current `webull.js` config **should work directly** — same OpenAPI surface, same credential model

2FA flow (one-time per ~15 days):
1. `webull-openapi-mcp auth` from operator's machine
2. Webull mobile app receives 2FA request — operator approves
3. Token written to `./conf/token.txt`
4. Server reads token on startup, auto-refreshes during runtime
5. Token validity = 15 days; expiry → re-run `webull-openapi-mcp auth`

**Critical for HANK ops:** the `./conf/` directory MUST be writable by whichever process runs the MCP server (likely the supervisor under `webhook-server.js`). Recommend `WEBULL_TOKEN_DIR=C:\Users\tomav\tradingview-mcp-jackson\webull-mcp-conf` so the token lives next to the rest of HANK's state.

### A.3 — Configuration (.env additions)

Add to HANK's `.env`:

```env
# 2026-05-17 Webull MCP migration
WEBULL_APP_KEY=<reuse current value>
WEBULL_APP_SECRET=<reuse current value>
WEBULL_ENVIRONMENT=uat                # default; flip to "prod" on 6/1
WEBULL_REGION_ID=us
WEBULL_TOOLSETS=                      # blank = all enabled
WEBULL_MAX_ORDER_NOTIONAL_USD=10000   # server-side guardrail; HANK's caps stay smaller
WEBULL_MAX_ORDER_QUANTITY=1000        # ditto
WEBULL_TOKEN_DIR=./webull-mcp-conf
WEBULL_AUDIT_LOG_FILE=./logs/webull-mcp-audit.log
```

The server's max-order guardrails are coarse safety nets — HANK's existing `CAPITAL_CAP_*` + `STOP_*_POINTS` caps still bind first.

### A.4 — Sandbox vs production

| Setting | Sandbox (default) | Production |
|---|---|---|
| `WEBULL_ENVIRONMENT` | `uat` | `prod` |
| Effect | Orders simulated server-side; no live execution | Real orders, real capital |
| Same MCP tool surface | yes | yes |
| Recommended posture | All of Sunday-through-5/31 sandbox; flip 6/1 morning | One-line .env change + MCP server restart |

**Operator override mechanism (Section E pending):** the `WEBULL_ENVIRONMENT` flag is read at MCP server startup. To rollback from prod → sandbox mid-day, edit `.env` + restart only the MCP server child process; HANK webhook stays up.

### A.5 — Transport: how `webhook-server.js` calls MCP tools

HANK already has `@modelcontextprotocol/sdk ^1.12.1` in `package.json`. The integration pattern:

```javascript
// webull-mcp-client.js (new file)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'uvx',
  args: ['webull-openapi-mcp', 'serve'],
  env: { ...process.env },  // .env vars flow through
});

const client = new Client({ name: 'hank-webhook', version: '1.0' });
await client.connect(transport);

// Tool call from anywhere in HANK
const result = await client.callTool({
  name: 'place_stock_order',
  arguments: { /* per MCP tool schema */ },
});
```

Single long-lived connection from `webhook-server.js` startup → MCP server child. All other HANK files (`paperTrading.js`, `futuresTrading.js`, `monitor.js`) call into a thin `webull-mcp-client.js` wrapper module.

**Failure modes to handle in the wrapper:**
- MCP child process dies → respawn + reconnect + journal `WEBULL_MCP_RESTART`
- Tool call timeout (default no timeout from SDK; set our own ~5s)
- Auth token expired mid-day → surface `WEBULL_AUTH_EXPIRED` to operator (prompts mobile-app reauth)

### A.6 — start-hank.bat additions

**Q2 answered: EMBEDDED CHILD PROCESS.** `webhook-server.js` spawns the MCP server via `StdioClientTransport` at startup. No new window in the morning routine. Webhook dies → MCP child dies → supervise.js restarts the pair together. Cleaner process tree for `kill` / `flatten` commands too.

Reserve "separate Window 11" mode for debugging only — add a `--debug-mcp` flag to webhook-server.js that suppresses the embedded spawn so operator can run the MCP server manually in a console to read its logs raw.

Add a `webull-mcp` heartbeat (mirror of `monitor-spy.js` heartbeats) so `/api/heartbeats` knows the embedded child is alive. Stale > 60s → dashboard alerts operator.

---

## Section B — Migration Mapping

### B.1 — Current `webull.js` surface (1,343 lines)

35 exported / internal functions across these categories:

| Category | Current functions | Pattern |
|---|---|---|
| **Auth machinery** | `generateSignature`, `apiRequest`, `loadStoredToken`, `saveToken`, `createToken`, `checkTokenStatus`, `getVerifiedToken` | HMAC-SHA1/256 hand-rolled |
| **Account** | `getAccountList` | OpenAPI HMAC path |
| **Market data (MQTT stream)** | `connectMQTT`, `subscribeSymbols`, `processTick`, `processQuote`, `updateQuote`, `classifySide`, `trackSweep`, `purgeSweeps` | Push subscription via `wss://api.webull.com/mqtt` |
| **Consumer-token paths** | `consumerRequest`, `consumerCall`, `loadConsumerToken`, `saveConsumerToken`, `consumerHeaders` | `ustrade.webullfinance.com` / `quotes-gw.webullfintech.com` — separate auth |
| **Trade token (consumer)** | `loadTradeToken`, `saveTradeToken`, `acquireTradeToken` | Consumer-API login flow |
| **Options chain** | `lookupTickerId`, `getOptionsExpirations`, `getOptionsChain`, `getOptionsQuote`, `normalizeContract`, `lookupOptionContractTickerId` | Consumer API |
| **Order placement** | `placeOptionsOrder`, `selectContract` | Consumer API (current trading-permissions blocker per memory `project_webull_api.md`) |

### B.2 — Per-function migration mapping

Direct replacements (delete current code, call MCP tool instead):

| Current `webull.js` function | MCP tool | Notes |
|---|---|---|
| `generateSignature`, `apiRequest` | (gone — handled inside MCP server) | Hand-rolled HMAC dies with the migration |
| `loadStoredToken`, `saveToken`, `createToken`, `checkTokenStatus`, `getVerifiedToken` | (gone — `webull-openapi-mcp auth` CLI flow) | Token lifecycle owned by MCP server |
| `getAccountList()` | `get_account_list` | Returns the 3 accounts (cash/margin/futures) — same shape |
| account balance (none currently) | `get_account_balance` | NEW capability — wire into dashboard |
| account positions (none currently) | `get_account_positions`, `get_account_position_details` | NEW; can replace some of the paper-ledger views once live |
| `lookupTickerId`, `lookupOptionContractTickerId` | `get_instruments` | Unified instruments endpoint |
| `getOptionsExpirations`, `getOptionsChain`, `normalizeContract` | (covered by `get_instruments` + market data tools) | Verify granularity matches our needs in sandbox |
| `getOptionsQuote` | `get_stock_snapshot` (option as instrument) or dedicated option quote | Confirm in Tuesday's first MCP call |
| `placeOptionsOrder` | `place_option_single_order` | Most current trading endpoint maps cleanly |
| `selectContract` | (KEEP — HANK-side selection logic) | Filters by ATM/Δ/IV; only the broker call inside it migrates |

MQTT path:

| Current | MCP equivalent | Decision |
|---|---|---|
| `connectMQTT`, `subscribeSymbols`, `processTick`, `processQuote` | (MCP server is request/response, no native MQTT bridge) | **KEEP MQTT in `webull.js` for now** — the streaming surface isn't exposed via MCP yet. Migrating later when MCP server adds streaming. Worth confirming on Sunday by reading the python-sdk source. |
| `trackSweep`, `purgeSweeps`, `classifySide`, `updateQuote` | (HANK-side classification logic; broker-agnostic) | KEEP unchanged |

### B.3 — Consumer-token paths to deprecate vs keep

**DEPRECATE entirely** (functionality covered by official MCP):
- `consumerRequest`, `consumerCall`, `consumerHeaders`
- `loadConsumerToken`, `saveConsumerToken`
- `loadTradeToken`, `saveTradeToken`, `acquireTradeToken`
- Memory `feedback_webull_consumer_api.md` ("ustrade.webullfinance.com needs separate consumer login token") becomes obsolete — single MCP-managed auth replaces both paths

**KEEP** (no MCP equivalent yet, or fundamentally HANK-side):
- `connectMQTT` + downstream tick/quote processing — streaming surface
- `selectContract` — strike/expiry/Δ filtering logic
- `processTick`, `classifySide`, `trackSweep`, `purgeSweeps` — block/sweep classification (broker-agnostic)
- `getCachedToken` — convenience getter (irrelevant post-migration but harmless)

### B.4 — Net code delta estimate

| Bucket | Lines today | Post-migration |
|---|--:|--:|
| Auth machinery (HMAC, token lifecycle) | ~250 | 0 (gone) |
| Account / instruments / options chain | ~330 | ~50 (thin MCP wrapper) |
| Consumer-token paths | ~200 | 0 (gone) |
| Order placement | ~100 | ~30 (thin MCP wrapper) |
| MQTT streaming (kept) | ~310 | ~310 (unchanged) |
| Trace / utilities | ~155 | ~50 (slim down) |
| **Total** | **1,343** | **~440** |

Net: roughly two-thirds of `webull.js` deleted. Most of what remains is the streaming path that MCP doesn't cover.

### B.5 — Path 2 futures-direct (`futuresTrading.js`)

**Q3 answered: KEEP AS PAPER HARNESS.** Path 2 stays in place and gains a new role as the parity check against MCP futures execution. Implementation:

- Live futures route through new MCP `place_futures_order` tool in a parallel `futuresLive.js` module
- Path 2 keeps writing to `futures-ledger.json` in parallel as a shadow ledger
- New `futures-parity-monitor.js` compares Path 2 vs MCP fills tick-for-tick; logs `FUTURES_PARITY_DIVERGENCE` when they diverge
- Roll Guard + Spread Guard (Thu 5/21 work) route through MCP, validate against Path 2
- Retire Path 2 only after **30+ consecutive days** of live MCP futures with zero divergence
- Instant fallback path: if MCP futures has bugs, operator flips `WEBULL_MCP_FUTURES_DISABLED=true` → futures fall back to Path 2 — paper-only, zero P&L impact while issue is fixed

Cost of maintaining parallel: ~minimal — Path 2 already runs whether or not Webull is wired in.

---

## Section C — New Capabilities (Day 1 scope locked per Q4)

### C.1 — Day 1 enables (ship with the migration, Tue-Wed 5/19-20)

**1. Native combo orders — OTO / OCO / OTOCO (`place_stock_combo_order`, US only)**

Replaces HANK's current bracket-order custom logic. Today every futures + options trade requires:
- Place entry order
- Watch fill
- Place stop + target as separate orders after fill confirmation
- Manage if-X-then-cancel-Y logic in HANK code

With native OTOCO, single MCP call submits entry + OCO bracket (stop + target). Broker manages the relationship server-side. Critical simplification for `futuresTrading.js` — the entire `_executeScaleOut` + `_updateStage3` + `monitorPosition` orchestration shrinks significantly. Operator's stop/target on every futures trade becomes a single atomic submission.

Mapping plan: `futuresTrading.placeFuturesOrder` and `paperTrading.sendOrder` both shift to combo-order shape. Existing `stopPrice` + `targetPrice` per trade record stay (used for combo construction); existing scale-out logic adapts (the 50% scale-out becomes an OCO leg).

**2. Audit logging integration (`WEBULL_AUDIT_LOG_FILE`)**

MCP server has built-in audit log support. Configure to write `./logs/webull-mcp-audit.log`. Every order submission, modification, cancellation, fill, and error logged in append-only format. Critical for the 7-year retention requirement (Section E.6).

HANK keeps its own `journal.js` records in parallel — MCP audit log is the broker-side truth; HANK journal is engine-side truth. Reconcile both on EOD to catch discrepancies.

**3. Real-time MQTT order status subscriptions**

MCP server exposes (need to verify on Tue exactly which tool — likely a streaming subscription resource) an MQTT-based order status feed. Replaces current pattern of polling order status after each `placeOptionsOrder`. Direct improvement:

- Today: place order → poll `/openapi/trade/order-status?orderId=X` every 1s until filled
- Tomorrow: subscribe once to order updates topic → receive `fill` / `partial fill` / `rejected` push events
- Latency improvement: ~1s polling jitter → ~100-300ms push
- Network: drops hundreds of poll calls per session

Replaces a `webhook-polling` pattern that doesn't exist by that exact name but is functionally the same loop in current code paths.

### C.2 — Deferred to post-June 1 (per Q4)

**Multi-leg options strategies (`place_option_strategy_order`)** — verticals, butterflies, iron condors. Powerful but:
- New ground for HANK engines (signal logic only knows single-leg directional today)
- $2K live cap is too small for defined-risk spreads — commission drag eats edge
- Roadmap target: July review after first $2K live week validates basics

**Algo orders (TWAP / VWAP / POV via `place_algo_order`)** — not needed at current position sizes (1-5 contracts). Revisit when sizing scales past 5 contracts per trade.

### C.3 — Pulled in opportunistically (no Day 1 commitment)

- `get_futures_depth` — DOM data, potential signal-quality boost for futures
- `get_account_position_details` — could replace parts of paper-ledger position views once live
- `get_event_*` (event series, market events) — unclear use case yet; surface only

---

## Section D — Integration Schedule

| Date | Work |
|---|---|
| **Sun 5/17 (today)** | Investigation doc complete ✓ (this file, commit 8b7c253 + this update) |
| **Mon 5/18** | `pip install uv` on operator machine · `uvx webull-openapi-mcp --help` · `uvx webull-openapi-mcp auth` (one-time 2FA via mobile app) · `.env` additions per A.3 · sandbox connectivity smoke test |
| **Tue 5/19** | New `webull-mcp-client.js` Node wrapper using `@modelcontextprotocol/sdk` · embedded child process spawned from `webhook-server.js` startup · first sandbox order placed via MCP from a webhook flow · verify order shape + error codes |
| **Wed 5/20** | Re-route all current Webull paths through MCP wrapper (sandbox) · Vision Phase 5 deploy in PARALLEL — see ⚠ below |
| **Thu 5/21** | Roll Guard (auto-rolls expiring contracts via `get_instruments` + `place_*_order`) + Spread Guard (rejects entries when bid/ask spread > threshold via `get_*_snapshot`) — both ship via MCP |
| **Fri 5/22** | Full sandbox validation · paper trading paths retired EXCEPT Path 2 (kept as parity harness per Q3) · `webull.js` legacy code archived to `_archive/2026-05-22-webull-legacy/` (one-line config flip can revert) |
| **Sat-Sun 5/23-24** | Stress testing · edge cases · weekend stability check (CME futures Sun open 17:00 ET) · error-handling drills |
| **Mon-Fri 5/26-30** | Full sandbox week with all architecture · real broker fills · no real money · all guards active |
| **Sun 5/31 PM** | Operator review of sandbox week data — go/no-go for 6/1 flip |
| **Mon 6/1 09:30 ET** | Production flip: `.env` WEBULL_ENVIRONMENT=prod + MCP restart → first live trade |

### D.1 — ⚠ Vision Phase 5 timing conflict (Wed 5/20)

Operator's saved Phase 5 spec (`project_vision_phase5_spec.md`) says vision builds "after calibration validates ≥1 week" with target weekend 5/23-24. The 5/20 directive line pulls Vision deploy in 3 days earlier, parallel to MCP re-routing.

Implications:
- Calibration will have only ~3 sessions (Mon-Wed) validated by 5/20 vs 5+ originally planned
- Vision + MCP both deploy same day = two big surfaces changing at once
- Risk: a Wed regression is harder to attribute (Vision? MCP? Both?)

**Recommend:** push Vision deploy to Fri 5/22 OR Sat 5/23 to keep one big surface per day. Operator decides.

### D.2 — Production cap structure (per Q5)

| Limit | Value | Mechanism |
|---|---|---|
| Total live capital allocated | $2,000 | Account-level segregation |
| Daily loss cap | $500 | `MAX_DAILY_LOSS=500` already in .env; auto-veto entries past this |
| Per-trade loss cap | $200 | Combined cal/sizing/stop logic — operator may need new `MAX_LOSS_PER_TRADE=200` env enforcement |
| Auto-kill threshold | -$500 daily | Existing daily-loss-cap gate in `paperTrading.sendOrder` (line ~702) |
| Auto-halt threshold | -$1,000 weekly | NEW gate needed — `MAX_WEEKLY_LOSS=1000` with rolling-7d window |

Weekly-loss enforcement is a new code path not currently present. Add it during Tue-Wed 5/19-20 work.

---

## Section E — Risk Assessment

### E.1 — MCP server bug surface (newly published, official-but-fresh)

**Risk:** v0.1.1 dated 2026-04-18 with only 2 releases and 3 commits visible. Webull's official MCP server is brand new. Any bug in their code lives in our brokerage pipe.

**Mitigations:**
- Pin to exact version in install: `uvx webull-openapi-mcp@0.1.1 serve` (not floating)
- Watch the repo for releases — manual check Sundays during sandbox week
- Keep `webull.js` archived as `_archive/2026-05-22-webull-legacy/webull.js` not deleted; one-line config flip reverts the path
- Sandbox week (5/26-5/30) is the deliberate burn-in window — bugs surface against real broker before real money

### E.2 — 2FA token refresh failure (15-day cycle)

**Risk:** Token expires every 15 days. If auto-refresh fails (network glitch, Webull-side service hiccup, or mobile-app session timeout), order submissions silently fail until operator runs `webull-openapi-mcp auth` again.

**Mitigations:**
- Heartbeat check: every 60 minutes, MCP client calls `get_account_list` (cheapest token-checking call). On 401, fire `WEBULL_AUTH_EXPIRED` jAlert + TTS warning to operator
- Refresh-ahead: at day 12 of token life, MCP wrapper proactively attempts refresh + alerts operator if it requires mobile-app approval (gives 3-day buffer for the next 2FA)
- Calendar reminder: operator gets calendar event 7 days before token expiry as belt-and-suspenders

### E.3 — Sandbox vs production fill parity

**Risk:** Sandbox fills (UAT) commonly diverge from production in slippage modeling, partial-fill behavior, and rejection codes. A clean sandbox week ≠ a clean production day.

**Mitigations:**
- Day 1 of sandbox: place 5-10 identical orders to a single instrument; compare fill shapes / latencies / rejection codes against documented production behavior
- Build a small `sandbox-prod-parity.json` baseline doc
- Production Day 1 (6/1): first 5 live trades go through a "shadow mode" where MCP submits but HANK ALSO logs what its expected behavior was; reconcile after each trade
- If parity drift > 2% on fill price, halt + investigate

### E.4 — MQTT stream disconnection

**Risk:** Order-status MQTT stream (Section C.1 item 3) can drop. If we miss a `fill` event, HANK thinks the order is still pending — could double-submit on retry, or fail to manage the open position.

**Mitigations:**
- Auto-reconnect with exponential backoff in the MCP wrapper
- On reconnect, immediately call `get_open_orders` to reconcile what we missed
- Fallback to polling `get_order_detail` every 5s during reconnect attempts (degraded but functional)
- Surface `MQTT_DISCONNECTED` on dashboard with elapsed-since timer

### E.5 — Order rejection retry logic

**Risk:** Webull rejection codes are not all created equal. "Insufficient buying power" is permanent; "Market closed" is transient; "Invalid limit price" is recoverable with adjustment.

**Mitigations:**
- Categorize MCP error responses into PERMANENT / TRANSIENT / RECOVERABLE buckets
- TRANSIENT (rate limit, brief market suspension): retry up to 3× with 500ms backoff
- RECOVERABLE (price adjustment needed): one retry with adjusted parameter, then escalate
- PERMANENT (cap exceeded, account locked): no retry, journal + alert operator
- Add `WEBULL_REJECTION` jError logging with the full original payload for post-session analysis

### E.6 — Audit log retention (7-year compliance)

**Risk:** Webull audit log (`WEBULL_AUDIT_LOG_FILE`) must persist 7 years for regulatory compliance. Disk + file rotation strategy must not lose records.

**Mitigations:**
- Configure log rotation: daily file rollover (e.g., `webull-mcp-audit-YYYY-MM-DD.log`)
- Compressed archive: rotated files gzipped and moved to `./logs/archive/`
- Off-machine backup: weekly rsync to backup location (operator's existing backup-repo path?)
- Append-only file permissions where the OS supports it
- Quarterly verification: random sample of rotated files vs broker statement reconciliation

### E.7 — Operator override mechanisms (tiered rollback per Q6)

Three tiers of rollback, in order of severity:

**Tier 1 — MCP bug, non-critical:**
- Operator flips `WEBULL_MCP_DISABLED=true` in `.env` + restart webhook-server
- HANK routes futures through Path 2 (paper) + equity options through legacy consumer-token paths in `webull.js`
- Trading continues as paper; live capital safe
- Effect: zero real-money trading until issue resolved

*Note: operator's Q6 answer wrote `CALIBRATION_MCP_DISABLED` — using `WEBULL_MCP_DISABLED` here for clarity. Flag if you intended a calibration-specific flag.*

**Tier 2 — MCP auth failure:**
- Webhook-server rejects all NEW entries with `WEBULL_MCP_AUTH_FAILED` gate reason
- Existing open positions continue to be managed via Path 2 stops (futures) and HANK-side time/price-based exits (options)
- Operator alerted via dashboard banner + TTS critical alert
- Operator runs `webull-openapi-mcp auth` to recover

**Tier 3 — Catastrophic (data corruption, wrong-account routing, etc.):**
- Operator runs `kill flatten` from the HANK Ask REPL (Window 10) → all positions closed
- Set `WEBULL_INTEGRATION_HALT=true` global flag → every MCP call short-circuits to reject
- Full investigation required before any further trades — operator manual approval to clear the halt flag
- Add `HALT` red banner across every dashboard tab + persistent TTS until cleared

All three tiers should be independently testable Sat-Sun 5/23-24 stress-testing window.

---

## Locked decisions (Q1-Q6 answered)

| # | Decision | Implementation note |
|---|---|---|
| Q1 | Python 3.14 already installed; install `uv` via `pip install uv` | Mon 5/18 task |
| Q2 | Embedded child process under `webhook-server.js` (no separate window) | Heartbeat record needed |
| Q3 | Keep Path 2 futures-direct as parity harness; retire after 30+ days zero-divergence | New `futures-parity-monitor.js` Wed 5/20 |
| Q4 | Day 1: OTO/OCO/OTOCO + audit log + MQTT order status. Defer: multi-leg, algo orders | Section C |
| Q5 | Cutover Mon 6/1 09:30 ET. $2K total, $500 daily cap, $200/trade, $1K weekly | New `MAX_WEEKLY_LOSS` env gate needed |
| Q6 | Three-tier rollback: `WEBULL_MCP_DISABLED` → reject new entries → `WEBULL_INTEGRATION_HALT` + kill flatten | Tested Sat-Sun 5/23-24 |

## Memory hygiene

After Wed 5/20 (Webull paths re-routed):
- `feedback_webull_consumer_api.md` becomes obsolete — recommend KEEP as historical with appended note "obsoleted by MCP migration 2026-05-22; consumer-token paths archived to `_archive/2026-05-22-webull-legacy/`". Future-Claude reading old commit messages benefits from the breadcrumb.
- `project_webull_api.md` (trading-permissions blocker as of 2026-05-05) — recommend KEEP with similar appended note.

---

*Phase 1 complete. Sections A-E locked. Code changes start Mon 5/18.*
