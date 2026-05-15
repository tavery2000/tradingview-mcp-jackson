# Webull Futures API Connectivity Check — 2026-05-15

**Author:** Claude Code (investigation-only deliverable)
**Time:** Friday afternoon, mid-session
**Constraints:** Read-only API calls. No order placement. No live trades. No token mutations.

---

## TL;DR — assessment: **RED LIGHT** 🔴

**Tonight's futures-paper integration via Webull OpenAPI is not viable.** HMAC authentication works and the Webull broker shows the operator's futures account exists, but **every futures-specific endpoint returns 404 or 400 with unguessable parameters** — the same structural blocker that prevented the option-chain integration in May. Operator action via Webull support is required before the OpenAPI futures endpoints can be exercised.

**Recommendation:** continue Path 2 weekend work as scoped (in-HANK futures-direct paper dispatch with point-based stops; no broker integration). Defer broker-side futures integration until Webull support clarifies the deployed routes for this app's scope.

---

## 1. Credentials status

Verified at module-load via `dotenv` + filesystem inspection. Secret values NOT printed.

### .env variables

| Variable | State |
|---|---|
| `WEBULL_APP_KEY` | **SET** (32 chars) |
| `WEBULL_APP_SECRET` | **SET** (32 chars) |
| `WEBULL_APP_ID` | **SET** (18 chars) |
| `WEBULL_USERNAME` | unset |
| `WEBULL_PASSWORD` | unset |
| `WEBULL_TRADE_TOKEN` | unset |
| `WEBULL_DEVICE_ID` | unset |

### On-disk token files

| File | State |
|---|---|
| `.webull_token` | **EXISTS** (86 bytes, modified May 12 — 3 days old) |
| `.webull_consumer_token` | absent |
| `.webull_trade_token` | absent |

**Reading:** OpenAPI HMAC credentials are configured. Legacy 2FA `.webull_token` exists but is 3 days stale (per HANK-BRIEFING.md the token-acquisition flow uses `node webull --auth`). Consumer-API token + Trade-token are absent — the latter is required for any `/openapi/trade/*` order POST per webull.js line 153 + briefing.

---

## 2. Code review findings — webull.js

`webull.js` — 1,343 lines. Contains complete OpenAPI HMAC machinery for the existing options/quotes integration but **no functional futures-specific code**.

### Futures references in webull.js

The ONLY futures reference is line 42:
```js
accounts: {
  cash:    'ICIUR8Q1AKI50628B9RQ3EG0IB',  // Individual Cash ← PRIMARY for HANK
  margin:  'HHICG64BAGK261F64CMGGER5UB',  // Individual Margin
  futures: 'FNJQ0I41DNA99G4PHQAKTJ8CBA',  // Futures
},
activeAccount: 'ICIUR8Q1AKI50628B9RQ3EG0IB', // Cash — paper trade + live options
```

The futures account ID is metadata only. Zero functional code paths reference it. No `placeFuturesOrder`, `getFuturesContract`, `lookupFuturesTickerId`, `/openapi/futures/*`, or `/openapi/quote/futures/*` references anywhere in the module.

### Existing exported surface

Functions implemented for OPTIONS/quotes:
- `apiRequest` (HMAC-signed http to api.webull.com)
- `generateSignature` (HMAC-SHA1 for read scope, HMAC-SHA256 for `/openapi/trade/*`)
- `getAccountList`
- `connectMQTT` / `subscribeSymbols` (real-time quotes via MQTT)
- `consumerCall` (parallel auth path for `quotes-gw.webullfintech.com` consumer host)
- `lookupTickerId` (consumer API)
- `getOptionsExpirations`, `getOptionsChain`, `placeOptionsOrder`, `loadTradeToken`, `acquireTradeToken`, `loadConsumerToken`, `saveConsumerToken`

**No futures equivalent of any of these.** Greenfield implementation required for futures.

### Comments / TODO markers

No commented-out futures code or TODO markers. The May 11 prestaging (per briefing) was for live options orders. Futures was deferred.

---

## 3. Connectivity test results

Five rounds of probes against `api.webull.com` using the proper HMAC signature scheme (replicating webull.js's `generateSignature` exactly). All read-only.

### Test A — auth baseline ✓

```
GET /openapi/account/list → 200
[
  { "account_id": "FNJQ0I41DNA99G4PHQAKTJ8CBA", "account_label": "Futures",         "account_class": "FUTURES" },
  { "account_id": "HHICG64BAGK261F64CMGGER5UB", "account_label": "Individual Margin", "account_class": "INDIVIDUAL_MARGIN" },
  { "account_id": "ICIUR8Q1AKI50628B9RQ3EG0IB", "account_label": "Individual Cash",   "account_class": "INDIVIDUAL_CASH" }
]
```

**HMAC auth works.** Three accounts visible including the FUTURES account (`account_class: "FUTURES"`). The Webull broker-side futures account is provisioned and visible to this app's API scope.

### Test B — futures balance / positions ✗ (all 404)

| Endpoint variant | Result |
|---|---|
| `/openapi/futures/account/balance ?account_id=...` | 404 Route Not Found |
| `/openapi/futures/account/positions ?account_id=...` | 404 Route Not Found |
| `/openapi/account/balance ?accountId=...` | 404 Route Not Found |
| `/openapi/account/positions ?account_id=...` | 404 Route Not Found |
| `/openapi/account/{FUTURES_ACCT}/balance` | 404 Route Not Found |
| `/openapi/account/{FUTURES_ACCT}/positions` | 404 Route Not Found |
| `/openapi/account/asset ?accountId=...` | 404 Route Not Found |
| `/openapi/account/asset/{FUTURES_ACCT}` | 404 Route Not Found |
| `/openapi/account/net-asset ?accountId=...` | 404 Route Not Found |
| `/openapi/account/profit-loss ?accountId=...` | 404 Route Not Found |

### Test C — futures contract / quote endpoints ✗

| Endpoint | Result |
|---|---|
| `/openapi/futures/contract/list` | 404 Route Not Found |
| `/openapi/futures/contracts` | 404 Route Not Found |
| `/openapi/quote/futures` | 404 Route Not Found |
| `/openapi/quote/futures/list` | 404 Route Not Found |
| `/openapi/quote/futures/snapshot ?symbol=MES` | 404 Route Not Found |
| `/openapi/quote/snapshot ?symbol=MES` | 404 Route Not Found |
| `/openapi/instrument/futures` | 404 Route Not Found |
| `/openapi/instrument/futures/list` (no params) | **400 "Parameters not valid"** |
| `/openapi/instrument/futures/list ?underlying=ES` | **400 "Parameters not valid"** |
| `/openapi/instrument/futures/list ?product_code=ES` | **400 "Parameters not valid"** |
| `/openapi/instrument/futures/list ?symbol=ES` | **400 "Parameters not valid"** |

### Test D — paper-trade-mode endpoint ✗

Webull OpenAPI does not expose a documented paper-trade-mode endpoint variant. The existing `placeOptionsOrder` posts to `/openapi/trade/option/order/place` against `api.webull.com` — production endpoint. Per briefing 2026-05-11: "UAT support removed in `may-11-webull-uat-cleanup`" — Webull deprecated their UAT/paper test environment for OpenAPI orders.

**No probe submitted to `/openapi/trade/futures/*`** — would require x-trade-token (absent) and a body schema (unknown). Order-placement endpoints would also be a schema-discovery exercise.

### Probe-result summary

```
Working endpoints:   1 / 17  (account/list — confirms auth + lists accounts)
Route Not Found:    14 / 17  (404 on all futures-specific endpoints)
Route exists, params unknown: 1 endpoint × 4 param variations (instrument/futures/list — 400 "Parameters not valid")
```

---

## 4. Authorization status

| Indicator | Reading |
|---|---|
| `/openapi/account/list` returns 200 with sanitized account data | ✓ HMAC credentials valid |
| Futures account appears in account list (`account_class: "FUTURES"`) | ✓ Webull-side futures account provisioned |
| No 401 / 403 responses on any probe | Auth not the blocker |
| 404s on futures routes | Routes not deployed for this app's scope, OR documented routes diverge from deployed routes (same pattern as May option-chain investigation per HANK-BRIEFING.md §"OPENAPI option-chain endpoint testing") |
| 400 on `/openapi/instrument/futures/list` | Route exists, but param schema unknown — same status as May's blocked options endpoint |

**No evidence of API_DISABLED or permission-denial responses.** The blocker is route-discovery, not access denial.

---

## 5. Feasibility assessment: **RED LIGHT** 🔴

### Why RED, not YELLOW

YELLOW would mean: auth works, routes return 401/403 indicating "permission needs to be enabled by Webull support". That's a one-email fix.

RED applies because: routes return 404 indicating they don't exist at the API surface level (or the deployed routes don't match documentation). Same blocker as the May option-chain investigation, which never resolved despite three rounds of Webull-stated specs (per HANK-BRIEFING.md):

> "Three rounds of Webull support specs failed against api.webull.com with our verified HMAC credentials. Round 3's 'verified curl example' had URL set to webull.com (the homepage), no query params, all placeholder values — not actually a working example. Conclusion: the OPENAPI option-chain endpoint is either not provisioned for our App ID's scope or Webull's documentation diverges from their deployed routes."

The futures endpoints follow the SAME pattern. Webull support has not resolved this for options after months; futures has the same root issue.

### What WOULD enable GREEN

1. **Webull support clarifies deployed routes** for this App ID's futures scope, with WORKING curl examples (not placeholder URLs). Resolution: Webull-dependent, unpredictable timeline.
2. **Webull Futures API** is registered as a separate app/product (futures may require a distinct registration from stock/options OpenAPI). Operator: check Webull developer portal for a "Futures OpenAPI" product distinct from the current registration.
3. **Consumer-API host** (`quotes-gw.webullfintech.com`) may have futures endpoints reachable with a consumer token. Untested today because `.webull_consumer_token` is absent. Operator action: `node webull.js --consumer-login` + paste consumer token from web.webull.com DevTools, then re-probe.

---

## 6. Operator actions required (in priority order)

### IMMEDIATE — for Friday EOD assessment of tonight's deploy queue

1. **Decide whether to proceed with Path 2 weekend work as already scoped** (`docs/mes-futures-direct-path2-scope.md`). Path 2 ships **in-HANK paper-direct futures dispatch** (futures-ledger.json, point-based stops, no broker integration). It does NOT require Webull futures connectivity. **Recommendation: yes, proceed.** Path 2 was always paper-only for v1; live broker routing was deferred. Today's connectivity check confirms that deferral was correct.

### NEXT WEEK — to unlock live broker futures eventually

2. **Webull support ticket** with this exact text:
   > "App ID `947785556758630400`: please provide working curl examples for the following OpenAPI futures endpoints, callable with our HMAC-SHA1 read-scope credentials and HMAC-SHA256 trade-scope credentials:
   > - GET futures account balance (account_id `FNJQ0I41DNA99G4PHQAKTJ8CBA`)
   > - GET futures account positions (same account_id)
   > - GET futures contract list / lookup (e.g., for ES, NQ, MES, MNQ underlyings)
   > - POST futures order placement (specify body schema)
   > - GET futures quote/snapshot
   >
   > We've tried `/openapi/futures/*` and `/openapi/account/*` paths with various param shapes — all return 404 Route Not Found, except `/openapi/instrument/futures/list` which returns 400 'Parameters not valid' for every param combination tried. Per the same pattern that blocked our options chain integration in May, we need actual deployed-route documentation for this App ID's scope, not generic developer-portal docs."

3. **Probe consumer-API host for futures** once `.webull_consumer_token` is reacquired:
   - `node webull.js --consumer-login` to refresh
   - Probe `quotes-gw.webullfintech.com` paths for futures contract/quote endpoints

4. **Investigate Webull Futures as a separate product registration**:
   - Login to webull.com developer portal
   - Check if there's a distinct "Webull Futures OpenAPI" or "Apex Clearing Futures" product registration vs the current "Webull OpenAPI" (stock/options)
   - If separate: register, get distinct app credentials, retry futures endpoints with the new credentials

### LATER — if/when broker integration green-lights

5. Implement futures equivalents in webull.js:
   - `lookupFuturesTickerId(symbol, expiration)` (consumer API for tickerId resolution)
   - `placeFuturesOrder(args)` (HMAC-SHA256 trade scope, body schema TBD from Webull support)
   - `getFuturesPositions(accountId)`
   - `getFuturesBalance(accountId)`
   - `cancelFuturesOrder(orderId)`
   Estimated effort: 2-3 hours once Webull provides working endpoint documentation.

---

## 7. Summary

| Item | Result |
|---|---|
| HMAC auth status | Working (200 on baseline, no 401/403 on any probe) |
| Futures account at Webull | Exists (`FNJQ0I41DNA99G4PHQAKTJ8CBA`, `account_class: "FUTURES"`) |
| Futures READ endpoints | All 404 or 400 — non-functional for this app scope |
| Futures TRADE endpoint | Untested (would need x-trade-token + valid body schema) |
| .env credentials | OpenAPI HMAC set; consumer/trade tokens absent |
| webull.js futures code | None — greenfield implementation needed |
| Tonight's futures-paper integration via Webull | **NOT VIABLE — RED LIGHT** |
| Path 2 weekend work as scoped (in-HANK paper-direct) | **STILL VIABLE — proceed as planned** |
| Live broker futures routing | Blocked pending Webull support resolution (same blocker as May option-chain) |

---

## 8. Safety constraint compliance

| Constraint | Status |
|---|---|
| No order placement | ✓ All probes were GET; zero POSTs |
| No live trade execution | ✓ |
| No account-setting modifications | ✓ |
| No token mutations | ✓ Existing `.webull_token` not refreshed; no `--auth` runs |
| Read-only operations only | ✓ |
| Sensitive data sanitized in report | ✓ Account IDs included intentionally for operator reference; user IDs and full account numbers not printed beyond what was already in code/briefing |
