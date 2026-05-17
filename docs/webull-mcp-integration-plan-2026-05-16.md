# Webull OpenAPI MCP Integration Plan — 2026-05-16

**Author:** Claude Code (Phase 1: complete — A through E plus locked decisions per operator)
**Status:** No code changes. Pure analysis. Implementation starts Monday 5/18.

> **⚠ §D.2 TIMELINE SUPERSEDED:** The week-ahead schedule in §D.2 is replaced by
> [`docs/HANK_WEEKLY_PLAN_2026-05-18.md`](HANK_WEEKLY_PLAN_2026-05-18.md)
> (locked 2026-05-17 17:35 ET). Three material changes: calibration multiplier+block
> reported LIVE (verify Monday), Vision Phase 5 moves Sat 5/23 → Fri 5/22 17:30 ET,
> Webull market-data Phase 1 lands Fri 5/22 15:00 ET. Sections A-C, B.5, D.1, D.3,
> D.4, E.1-E.9 of this doc remain authoritative for ARCHITECTURE; only §D.2's
> day-by-day timeline is superseded.
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

### B.5 — Path 2 futures-direct (`futuresTrading.js`) — RETIRED

**Final correction:** Path 2 is **retired entirely**, not kept as parity harness. Single source of truth = MCP. Implementation Sunday 5/17:

- Remove `futuresTrading.js` import from `webhook-server.js`
- Remove futures routing branch (`_FUTURES_DIRECT_INSTRUMENTS` block) from webhook handler
- Archive `futuresTrading.js` → `_archive/2026-05-17-futures-direct-retirement/futuresTrading.js`
- Archive `futures-status.js` (the Window 9 read-only tail) — re-wire it later to read MCP-side futures state, or replace with MCP-fed dashboard widget
- All futures execution flows: Pine alert → `webhook-server.js` → MCP `place_futures_order`
- No parallel harness, no divergence logging, no fallback to Path 2
- Single ledger going forward: MCP's account state via `get_account_positions` (no more `futures-ledger.json`)

Implications for `start-hank.bat`:
- Window 9 (Futures Status) — re-source from MCP after retirement; one-line change to point at MCP-fed cache instead of `futures-ledger.json`
- No new window needed (MCP embedded in webhook per Q2)

Implications for `ask.js`:
- `kill IWM` → `flatten` already work against `futures-ledger.json`; will need rewiring through MCP `cancel_order` + `place_*_order` (close at market)
- Critical constraint: kill/flatten MUST work through MCP path before Sunday 17:00 ET CME open

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

### C.2 — Permanently out of scope

**Multi-leg options strategies (`place_option_strategy_order`)** — verticals, butterflies, condors, strangles. **DEFER INDEFINITELY.** HANK trades single-direction CALLS and PUTS only. No multi-leg infrastructure built; MCP order routing layer stays simple.

**Algo orders (TWAP / VWAP / POV via `place_algo_order`)** — **OUT OF SCOPE. Do not install.**

**webull-agent-skills CLI** — **OUT OF SCOPE. Do not install.**

### C.3 — Pulled in opportunistically (no commitment)

- `get_futures_depth` — DOM data, potential signal-quality boost for futures
- `get_account_position_details` — replaces some current paper-ledger position views post-migration

---

## Section D — Final Integration Timeline

### D.1 — Sunday 5/17 master execution window (10:00-17:00 ET)

All install + integration + retirement work compressed into one day. CME futures reopen 17:00 ET; sandbox-MCP-paper-futures must be live by then.

```
10:00 ET  Python uv install (pip install uv)
          webull-mcp-server install (uvx webull-openapi-mcp --help)
11:00 ET  .env additions (existing AK/SK reused, WEBULL_ENVIRONMENT=uat)
          2FA mobile approval (uvx webull-openapi-mcp auth)
          Sandbox auth smoke test
12:00 ET  New webull-mcp-client.js Node wrapper (embedded stdio child)
          Wire into webhook-server.js startup; heartbeat record added
13:00 ET  First sandbox order tests:
            - market / limit / stop  single-leg options
            - OTOCO combo on a futures contract
            - cancel_order round-trip
14:00 ET  futuresTrading.js retirement:
            - remove import from webhook-server.js
            - remove futures routing branch
            - archive to _archive/2026-05-17-futures-direct-retirement/
          Roll Guard wired (get_instruments + place_*_order on expiry rotation)
15:00 ET  Smoke test full pipeline (Pine alert → webhook → MCP → MQTT confirm)
          kill/flatten command rewired through MCP cancel/close path
          MAX_WEEKLY_LOSS gate stubbed (full implementation Tue 5/19)
16:00 ET  GO/NO-GO checkpoint — see D.4 below
16:30 ET  Calibration auto-rebuild fires (existing 16:30 ET scheduler)
16:45 ET  Operator manual validation:
            ask> calibration
            ask> reload calibration
            ask> kill IWM   (no-op; verifies MCP cancel path)
17:00 ET  CME opens — Webull paper futures live via MCP
```

### D.2 — Week of 5/18

| Date | Work |
|---|---|
| **Mon 5/18** | Day 3 of streak — MCP-routed paper fills (RTH equity + 23/5 futures). Pure observation day; CALIBRATION_LOOKUP telemetry continues; no code changes. |
| **Tue 5/19** | **Calibration goes LIVE:** flip `CALIBRATION_APPLY_MULTIPLIER=true` + `CALIBRATION_BLOCK_ENABLED=true`. Also implement `MAX_WEEKLY_LOSS` tiered gate (see E.8). NVDA earnings day — meaningful real test of layered defenses. |
| **Wed 5/20** | MCP + Calibration full integration validation. No new layers; only verify both interact cleanly in journal + ledger reconciliation. |
| **Thu 5/21** | Spread Guard via MCP market data (`get_stock_snapshot` / `get_futures_snapshot` bid-ask spread check; reject when > threshold). |
| **Fri 5/22** | Full pipeline stress test. No new layers. Exercise three-tier rollback drills. |
| **Sat 5/23** | Vision Phase 5 deploy in DRY-RUN. Cache + `vision-monitor.js` + structured-numeric prompts wired; multiplier not applied yet. (Aligns with operator's saved spec target of weekend 5/23-24.) |
| **Sun 5/24 – Fri 5/29** | Vision telemetry accumulates + sandbox week of real broker fills, no real money, all guards active. |
| **Sun 5/31 PM** | Operator pre-live review — go/no-go for production flip. |
| **Mon 6/1 09:30 ET** | Production flip: `.env` `WEBULL_ENVIRONMENT=prod` + MCP restart → first live trade. Vision stays in dry-run through first live week. |

### D.3 — Production cap structure (per Q5)

| Limit | Value | Mechanism |
|---|---|---|
| Total live capital allocated | $2,000 | Account-level segregation |
| Daily loss cap | $500 | Existing `MAX_DAILY_LOSS` in `.env` |
| Per-trade loss cap | $200 | NEW `MAX_LOSS_PER_TRADE=200` env gate needed (combined with stop/calibration sizing) |
| Auto-kill threshold | -$500 daily | Existing daily-loss-cap in `paperTrading.sendOrder` |
| Auto-halt threshold | -$1,000 weekly | NEW `MAX_WEEKLY_LOSS` tiered gate (Tue 5/19) — see E.8 |

### D.4 — Sunday 16:00 ET GO/NO-GO criteria

Before 17:00 ET CME open, operator decides go/no-go based on:

| Check | Pass condition |
|---|---|
| MCP auth | `uvx webull-openapi-mcp auth` completed; token written to `./webull-mcp-conf/` |
| MCP child spawn | `webhook-server.js` startup log shows `[webull-mcp] ARMED` + heartbeat |
| Order placement | At least one OTOCO combo successfully submitted + filled + closed in sandbox |
| kill/flatten | `ask> flatten` returns clean (no exception) against MCP `cancel_order` |
| MAX_WEEKLY_LOSS stub | Reading correct value from .env, even if enforcement is Tue |
| Roll Guard | Single test rotation against an expiring sandbox contract succeeds |

**If ANY check fails by 16:00 ET:** skip Sunday session, resume Monday morning with extended install window. Operator's call — fallback documented but not assumed.

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

`WEBULL_MCP_DISABLED` name **confirmed** by operator.

Three tiers of rollback, in order of severity:

**Tier 1 — MCP bug, non-critical:**
- Operator flips `WEBULL_MCP_DISABLED=true` in `.env` + restart webhook-server
- Webhook-server rejects all NEW entries with `WEBULL_MCP_DISABLED` gate reason
- Existing open positions continue to be managed via stops (broker-side OCO legs already submitted at entry)
- Trading paused; live capital safe
- Effect: zero new trades until operator clears the flag

**Tier 2 — MCP auth failure:**
- MCP heartbeat detects 401 / token-expired
- Existing positions exit via broker-side stops (already in OCO; broker fills them autonomously)
- Operator alerted via dashboard banner + TTS critical alert
- Operator runs `uvx webull-openapi-mcp auth` to recover

**Tier 3 — Catastrophic (data corruption, wrong-account routing, etc.):**
- Operator runs `kill flatten` from the HANK Ask REPL (Window 10) → all positions closed via MCP `cancel_order` + market-close
- Set `WEBULL_INTEGRATION_HALT=true` global flag → every MCP call short-circuits to reject
- Full investigation required before any further trades — operator manual approval to clear the halt flag
- Add `HALT` red banner across every dashboard tab + persistent TTS until cleared

All three tiers tested Fri 5/22 stress-test window.

### E.8 — MAX_WEEKLY_LOSS tiered enforcement (new gate, Tue 5/19)

Rolling 7-day window of realized P&L. Three tiers:

| Threshold | Action |
|---|---|
| -$500 | Warning + TTS announcement to operator. No trading change. |
| -$750 | New entries blocked (`MAX_WEEKLY_LOSS_BLOCK` gate reason). Existing positions exit via stops only. Operator informed. |
| -$1,000 | Hard halt. Run `kill flatten` automatically. Set `WEBULL_INTEGRATION_HALT=true`. Operator override required to resume. |

Implementation: new module `weeklyLoss.js` mirroring `profitProtection.js` pattern. State file `weekly-loss-state.json` (gitignored). Reads paper-ledger + MCP `get_account_balance` to compute realized 7d P&L. Hooked into `sendOrder` after `PROFIT_PROTECTION` gate.

### E.9 — kill/flatten must work via MCP before 5/17 17:00 ET

Critical Sunday-window constraint. Operator's tier-3 rollback depends on it. Implementation:

- `ask.js answerKill()` currently routes through `closePosition` (paper-ledger) + `closeFuturesPosition` (futures-ledger Path 2)
- Path 2 retiring Sunday means `closeFuturesPosition` must be replaced with MCP-mediated close BEFORE Sunday 17:00 ET
- New pattern: `kill` enumerates open positions via MCP `get_account_positions` → for each open position, submits `cancel_order` (if working) or `place_*_order` (market-close direction) → confirms via MQTT order-status push
- Smoke-tested in Sunday 15:00 ET checkpoint (D.1)

---

## Locked decisions (final)

| # | Decision | Implementation note |
|---|---|---|
| Q1 | Python 3.14 already installed; install `uv` via `pip install uv` | Sun 5/17 10:00 ET task |
| Q2 | Embedded child process under `webhook-server.js` (no separate window) | Heartbeat record + `--debug-mcp` flag |
| Q3 | **Path 2 RETIRED entirely** — single source of truth via MCP. No parallel harness | Sun 5/17 14:00 ET: archive `futuresTrading.js` to `_archive/2026-05-17-futures-direct-retirement/` |
| Q4 | Day 1: OTOCO combo + audit log + MQTT order status. **Multi-leg, algo orders, agent-skills CLI: out of scope (do not install).** Options = single-direction CALLS/PUTS only | Section C |
| Q5 | Cutover Mon 6/1 09:30 ET. $2K total, $500 daily cap, $200/trade, $1K weekly (tiered: -$500 warn / -$750 block / -$1000 halt) | New `MAX_WEEKLY_LOSS` gate Tue 5/19 — see E.8 |
| Q6 | Three-tier rollback: `WEBULL_MCP_DISABLED` (confirmed name) → reject new entries → `WEBULL_INTEGRATION_HALT` + auto-kill-flatten | All three tiers tested Fri 5/22 |

## Memory hygiene

After Sun 5/17 (Webull paths re-routed + Path 2 archived):
- `feedback_webull_consumer_api.md` — KEEP as historical with appended note "obsoleted by MCP migration 2026-05-17; consumer-token paths archived to `_archive/2026-05-17-futures-direct-retirement/`"
- `project_webull_api.md` (trading-permissions blocker as of 2026-05-05) — KEEP with similar appended note

After Sat 5/23 (Vision Phase 5 dry-run deployed):
- `project_vision_phase5_spec.md` — KEEP and update with implementation pointers (`vision-monitor.js`, `visionCache.js`)

---

*Phase 1 final. Sections A-E locked. Sunday 5/17 execution starts 10:00 ET; Production flip Mon 6/1 09:30 ET.*
