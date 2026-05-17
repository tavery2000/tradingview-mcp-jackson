# Webull OpenAPI MCP Integration Plan — 2026-05-16

**Author:** Claude Code (Phase 1: investigation + sections A+B drafted; C/D/E pending operator review)
**Status:** No code changes. Pure analysis.
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

**Prereq install on operator's machine (Saturday/Sunday task):**
1. Python 3.10+ (Windows: `winget install python` or python.org installer)
2. `uv` package manager (`pipx install uv` or `winget install astral-sh.uv`)
3. Then `uvx webull-openapi-mcp --help` to verify

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

Two options:

1. **Embedded (recommended):** `webhook-server.js` spawns the MCP server as a child via `StdioClientTransport`. No new window. Cleaner failure-domain pairing (webhook dies → MCP dies → both restart together via supervise.js).

2. **Separate window:** Add Window 11 (`HANK Webull MCP`) running `uvx webull-openapi-mcp serve` directly. Operator gets a console view of MCP server logs. But then `webhook-server.js` would need to connect via SSE/HTTP transport, which `webull-mcp-server` defaults to stdio — would need a wrapper.

**Recommend (1) for the migration.** Add a `webull-mcp` heartbeat record so the dashboard's `/api/heartbeats` knows the child is alive.

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

Not actually broker-connected today — Path 2 is in-HANK paper dispatch with no Webull dependency. Two options for migration:

1. **Leave Path 2 in place** as the paper-trading harness. Live futures route through new MCP `place_futures_order` tool in a parallel `futuresLive.js` module.
2. **Replace Path 2** with MCP futures tools entirely; paper trading becomes MCP `WEBULL_ENVIRONMENT=uat`.

Option 1 is safer for the 6/1 flip (paper environment unchanged; live flips one variable). Option 2 unifies the codebase. **Recommend option 1 for the initial migration**, revisit unifying later. Pending operator decision in Section D.

---

## Section C — New Capabilities Worth Adding

**[PENDING operator review of A+B before writing C.]** Draft list of candidate items to keep on the radar:

- `place_option_strategy_order` — multi-leg verticals / butterflies / iron condors
- `place_stock_combo_order` — native OTO / OCO / OTOCO (US only)
- `get_futures_depth` — DOM data for futures (potential signal-quality boost)
- `get_account_position_details` — could replace parts of paper-ledger.json reporting once live
- Real-time order status updates — MCP server may expose subscription (need to verify in source; might still require MQTT)

---

## Section D — Integration Schedule

**[PENDING operator review of A+B.]** Direct restatement of operator-stated schedule for reference:

```
Monday      MCP server installed, sandbox auth working
Tuesday     First sandbox order placed via MCP from webhook-server.js
Wednesday   All current Webull paths re-routed through MCP (sandbox)
Thursday    Roll Guard implemented via official contract endpoints
Thursday    Spread Guard implemented via official market data
Friday      Full sandbox validation, paper trading completely retired
Sat-Sun     Stress testing, edge cases, error handling
Mon 5/26+   Sandbox week with full architecture
Mon 6/1     Flip to production, $2K live cap
```

Items I'd flag for refinement after C is written:
- "Paper trading completely retired" by Friday — depends on Section B.5 Path 2 decision
- "Roll Guard" + "Spread Guard" — need definitions in Section C before scheduling

---

## Section E — Risk Assessment

**[PENDING operator review of A+B.]** Draft headlines:

- MCP server is **newly published** (v0.1.1, 3 commits visible). Any bug in their code lives in our brokerage pipe. Mitigations: pin to specific version in install; subscribe to release notifications; keep current `webull.js` archived as `webull-legacy.js` for emergency rollback.
- Sandbox/prod parity — verify on Tuesday that order shapes / error codes / fill behavior match production behavior.
- Rollback: until 5/30, the legacy `webull.js` stays alongside the MCP wrapper. One-line config flip can revert.
- Operator override: `WEBULL_ENVIRONMENT=uat` + MCP restart at any moment if production behavior surprises.

---

## Open questions for operator (Sunday session)

1. **MCP server install location** — operator's machine or a dedicated container? (Recommend: operator's machine for v1; container later.)
2. **Embedded vs separate-window** (Section A.6) — embedded recommended; confirm.
3. **`WEBULL_TOKEN_DIR`** — confirm `./webull-mcp-conf/` relative to HANK root.
4. **Path 2 futures keep-or-replace** (Section B.5) — recommend keep; confirm.
5. **OK to install Python 3.10 + uv on operator's machine Sunday?** (Required prereq.)
6. **Memory `feedback_webull_consumer_api.md`** becomes obsolete after this migration. Want me to delete the memory record when the consumer paths are deprecated, or keep as historical?

---

*Sections C, D, E will land after operator reviews A+B. Code changes start Monday.*
