# HANK Session Handoff — 2026-05-17 EOD

> **For a new Claude Code session.** This doc captures everything an incoming session
> needs to pick up where 2026-05-17's marathon ended. Read top-to-bottom; the
> "Immediate Next Action" section tells you exactly what's pending operator validation
> right now.

---

## 1. TL;DR — Current State at Handoff

- **MCP integration shipped** — Webull OpenAPI MCP server embedded in `webhook-server.js`, all futures execution routed through it
- **MCP CONNECTED** — 47 tools available, env=prod, operator's real AK/SK
- **Paper mode strategy** — operator's Webull mobile app toggled to PAPER; the API hits whichever account the app is currently set to. Operator confirmed Futures account (`FNJQ0I41DNA99G4PHQAKTJ8CBA`) shows virtual balance → paper-via-toggle works
- **Path 2 retired** — `futuresTrading.js` + `futures-status.js` archived to `_archive/2026-05-17-futures-direct-retirement/`
- **Last commit:** `6cb8a45` — fix(webull-mcp): parse text account list + pin account_id in tool calls
- **Operator pending action:** pull + restart, then verify in Window 1: `[webull-mcp] ✓ paper account PINNED by WEBULL_PAPER_ACCOUNT_ID=FNJQ0...`
- **CME opens 18:00 ET** (operator-confirmed time, NOT 17:00) — Sunday 5/17 futures session is the first MCP validation

---

## 2. Immediate Next Action

Operator has the latest code (`6cb8a45`). They need to:

1. **Pull + restart:**
   ```
   ! cd C:\Users\tomav\tradingview-mcp-jackson && git pull && taskkill /F /FI "WINDOWTITLE eq HANK*" & timeout /t 2 /nobreak >nul & taskkill /F /IM ngrok.exe & start "" cmd /c start-hank.bat
   ```

2. **Verify Window 1 (HANK Webhook) shows:**
   ```
   [webull-mcp] CONNECTED — 47 tools available, env=prod
   [webull-mcp] paper-mode check: found 3 account(s)        ← parser now works
   [webull-mcp] ✓ paper account PINNED by WEBULL_PAPER_ACCOUNT_ID=FNJQ0I41DNA99G4PHQAKTJ8CBA
   ```

3. **In Window 9 (HANK Ask REPL), smoke-test:**
   ```
   webull                  # combined status — should show paper verified: YES
   mcp positions           # should now succeed (account_id auto-pinned)
   roll guard tick         # should succeed (symbols param now passed)
   mcp test order          # ⚠ this WILL submit a real test order to paper futures
   ```

4. **CME opens 18:00 ET** — Pine alerts for ES/NQ/MES/MNQ will route through MCP starting then.

If `mcp test order` succeeds with a valid order ID → Sunday session is GO.

---

## 3. What the New Claude Needs to Know (Memory Context)

**Auto-loaded from `~/.claude/projects/.../memory/MEMORY.md`** — these will be in your context automatically. Brief reminders:

- **`user_background.md`** — User has 20 years professional trading experience. Frame technical discussions at expert level.
- **`project_hank_briefing.md`** — READ HANK-BRIEFING.md at session start for full system context.
- **`project_hank_vision.md`** — Long-term goal: outperform institutional algos via 20yr discretionary edge encoded into signal engines.
- **`project_mnq_june1.md`** — MNQ1! activates 2026-06-01. Until then, 0 MNQ signals is normal.
- **`project_vision_phase5_spec.md`** *(NEW today)* — Vision layer locked design: structured numeric prompts + Claude Sonnet 4.6 + multiplier tiers matching calibration. Built after calibration validates ≥1 week. Target weekend 5/23-24.
- **`feedback_no_devtools.md`** — Operator CANNOT use Chrome DevTools / F12 / Network tab. Never propose token-capture workflows requiring browser dev tools.
- **`feedback_dirty_session_no_calibration.md`** — Analyzer output from infra-failure sessions (restarts, crashes, data-write bugs) is invalid for per-engine tuning.
- **`feedback_no_mid_session_deploys.md`** — During RTH (09:30-16:00 ET), default is "commit now, deploy post-close." Restart actions need explicit authorization in the current turn.
- **`feedback_one_validation_day_per_deploy.md`** — One architectural-deploy stack per night. Next RTH = validation day. No weekend work for signal-related changes.

**Webull-API memories that became OBSOLETE today** (operator may want them deleted):
- `feedback_webull_consumer_api.md` (consumer-token paths archived)
- `project_webull_api.md` (HMAC-from-scratch retired; MCP server handles auth)

---

## 4. Today's Work (2026-05-17) — Commit-by-Commit

In chronological order. Pull any of these to understand context:

| Commit | What |
|---|---|
| `4a0bf2e` | Sunday MCP integration — Path 2 retired, MCP client wired, webhook-server routes futures via MCP, ask.js kill/flatten rewired through MCP, weeklyLoss.js stub hooked into sendOrder |
| `7f4bd22` | Auto-detect uvx absolute path (Windows PATH-independent) — operator's uvx.exe at `C:\Users\tomav\AppData\Local\Python\pythoncore-3.14-64\Scripts\uvx.exe` not on PATH; `_findUvxPath()` resolves via `where uvx` + walks known install locations |
| `d292bc2` | Pin uvx to Python 3.12 (`--python 3.12`) — system Python is 3.14, grpcio 1.69.0 has no cp314 wheel and requires MSVC Build Tools to compile from source. uv auto-downloads managed 3.12 (~30MB one-time) |
| `0356730` | Tried Webull's public UAT shared test creds (default account #1) — turned out my WebFetch mis-parsed the table columns, used App ID `J6HA...` (26 chars) as App Key instead of `a88f...` (32 chars). Server returned 401 |
| `f13adf8` | Corrected the UAT AK after re-fetching the docs — still didn't authenticate cleanly. Eventually operator decided to abandon UAT (see commits 9ab4875 / 525e66e below) |
| `27b1ffc` | `_checkUvxHealth()` pre-flight — detects 0-byte uvx.exe (Defender quarantined it once during testing) and gives clear recovery instructions |
| `9ab4875` | Drop spawn-time UAT credential substitution — `.env` becomes single source of truth. Earlier "magic substitution" caused split-brain between webhook MCP child (got UAT creds) and standalone `uvx ... auth` (saw prod creds in .env) |
| `525e66e` | **Course correction** — abandon UAT shared accounts entirely. Use operator's prod AK/SK against prod endpoint with paper mode toggled in Webull mobile app. Added paper-mode safety gate (`_verifyPaperMode`) that checks `get_account_list` response after connect |
| `991e0e0` | `ask> webull auth` — interactive 2FA from inside HANK Ask REPL. Avoids the SmartScreen path that blocks operator from running `uvx ... auth` directly from a fresh cmd shell |
| `25fe9a3` | `hank-preflight.js` bootstrap validator + start-hank.bat preflight wiring. Codifies operator's 9-step manual debugging sequence: uvx health check + auto-reinstall on 0-byte, Defender exclusion advisory, stale token (>14d OR <100 bytes) detection + delete, dotenv sanity, operator checklist banner |
| `8cf8dec` | Fix start-hank.bat — replaced parenthesized preflight blocks (cmd `errorlevel`-in-parens unreliable) with goto labels, removed Y/N choice gate (was blocking launch when operator hit anything but Y), added `[stage N/4]` trace prints |
| `6cb8a45` | **Last commit** — Webull `get_account_list` returns plain TEXT (not JSON), parser updated with regex. `get_account_positions` and `get_futures_instruments` need required params (`account_id` and `symbols`) — wrappers auto-pin from `_paperAccountId` or env. `.env` pins `WEBULL_PAPER_ACCOUNT_ID=FNJQ0I41DNA99G4PHQAKTJ8CBA` |

---

## 5. Architecture — File & Service Map

### Active windows after `start-hank.bat`

| # | Window | Process | Purpose |
|---|---|---|---|
| 1 | HANK Webhook | `webhook-supervisor.js` → `webhook-server.js` | Pine alert receiver on `:9001`. Embeds Webull MCP child via stdio. Hosts calibration scheduler, preSwitchKill scheduler, roll guard. |
| 2 | HANK ngrok | `ngrok` | `yiddish-composure-amusing.ngrok-free.dev` → `:9001` |
| 3 | HANK SPY | `supervise.js monitor.js` | SPY + Mag-6 CDP reads + wsServer `:8080` |
| 4 | HANK QQQ | `supervise.js monitor-qqq.js` | QQQ standalone tab reads |
| 5 | HANK News | `supervise.js news.js` | RSS + SEC + TTS + MOC data writer |
| 6 | HANK Briefing | `supervise.js briefing.js` | 08:30 ET daily brief (weekend-suppressed) |
| 7 | HANK Dashboard | `supervise.js dashboard-server.js` | http://localhost:3000 |
| 8 | HANK Theta | `supervise.js theta-monitor.js` | Per-position greeks + burn-zone tracker |
| 9 | HANK Ask | `node ask-cli.js` | Interactive Q&A REPL + WRITE commands (kill/flatten/webull/calibrate) |

### Key files (Node-side)

- **`webull-mcp-client.js`** *(254→440 LOC, today's central addition)* — Node wrapper around the Python Webull MCP server. Spawns `uvx --python 3.12 webull-openapi-mcp@0.1.1 serve` as stdio child of webhook-server. Auto-reconnect, heartbeat, paper-mode verification, sanitized logging.
- **`hank-preflight.js`** *(today)* — Bootstrap validator. Runs before any window spawns. Auto-recovers uvx quarantine, deletes stale tokens, prints operator checklist.
- **`webhook-server.js`** — Pine alert receiver. Routes futures to `mcp.placeFuturesOrder`; equity options continue through `paperTrading.sendOrder` for now (MCP equity routing lands Tue 5/19).
- **`ask.js` / `ask-cli.js`** — Window 9 REPL. Today added: `webull`, `webull auth`, `webull reconnect`, `webull paper`, `mcp status`, `mcp accounts`, `mcp positions`, `mcp test order`, `mcp paper`, `roll guard tick`.
- **`paperTrading.js`** — Entry gate, sizing, gate chain (counter-trend → daily-loss → profit-protection → pre-switch-pause → calibration → weekly-loss).
- **`calibrationCache.js`** *(5/16)* — In-memory L1→L5 fallback lookup, mtime-watched. 12 cells active (mostly L4/L5 baseline).
- **`calibrationScheduler.js`** *(5/16)* — Daily 16:30 ET Mon-Fri rebuild via spawned `analyze-calibration.js`.
- **`preSwitchKill.js`** *(5/15)* — 11:55 warn / 11:58 kill / 12:02 resume.
- **`profitProtection.js`** *(5/15)* — Tiered: LIGHT@$5K (5K trail, 30min pause) / MEDIUM@$10K (3.5K trail, 60min) / HARD@$15K (2K trail, day-end lock).
- **`rollGuard.js`** *(today)* — Futures expiry detection (auto-roll lands Thu 5/21).
- **`weeklyLoss.js`** *(today, STUB)* — Rolling 7d realized P&L gate. Full impl Tue 5/19 with tiers: -$500 warn / -$750 block / -$1000 halt+flatten.
- **`webull.js`** *(legacy, 1343 LOC)* — Hand-rolled HMAC client. Mostly bypassed now that MCP handles auth + tools; kept for the MQTT streaming path (MCP doesn't expose streaming yet).

### Archived (don't touch)
- `_archive/2026-05-15-iwm-retirement/` — IWM monitor + Pine
- `_archive/2026-05-15-moo-moc-retirement/` — MOO/MOC engines (NYSE feed too delayed)
- `_archive/2026-05-17-futures-direct-retirement/` — Path 2 futures-direct + status tail

### `.env` highlights *(gitignored — values won't be in your git pull)*

Operator's `.env` currently has:
- `WEBULL_APP_KEY` / `WEBULL_APP_SECRET` / `WEBULL_APP_ID` — operator's prod credentials
- `WEBULL_ENVIRONMENT=prod`
- `WEBULL_PAPER_ACCOUNT_ID=FNJQ0I41DNA99G4PHQAKTJ8CBA` — pinned futures paper account
- `WEBULL_PAPER_MODE_EXPECTED=true` — verification gate active
- `WEBULL_DEBUG_ACCOUNT_DUMP=true` — logs raw get_account_list response on connect
- `WEBULL_MCP_DISABLED=false`, `WEBULL_INTEGRATION_HALT=false` — rollback flags
- `MAX_WEEKLY_LOSS=1000`, `MAX_WEEKLY_LOSS_WARN=500`, `MAX_WEEKLY_LOSS_BLOCK=750`
- `MAX_LOSS_PER_TRADE=200`
- `MAX_DAILY_LOSS=5000` (testing tier)
- `CALIBRATION_ENABLED=true`, `CALIBRATION_BLOCK_ENABLED=false`, `CALIBRATION_APPLY_MULTIPLIER=false` (flip both to true Tue 5/19)
- `WEBULL_APP_KEY_PROD` etc. — UNUSED legacy (was the UAT swap pattern, now reverted)

---

## 6. Known Issues / Tech Debt

### Security (operator action needed)
- **Five secrets leaked into conversation transcripts during today's debugging.** Operator should rotate these this week:
  - `WEBULL_APP_KEY` / `WEBULL_APP_SECRET` / `WEBULL_APP_ID`
  - `ALPACA_KEY` / `ALPACA_SECRET`
  - `ANTHROPIC_API_KEY`
  - None landed in git (.env is gitignored) but the transcripts are local artifacts.

### Operator UX
- **Defender exclusions** for `C:\Users\tomav\AppData\Local\Python\pythoncore-3.14-64\Scripts` and `C:\Users\tomav\AppData\Local\uv` need to be added via admin PowerShell. `hank-preflight.js` advises but doesn't auto-run (admin required).
- **Webull 2FA token** is valid 15 days; refresh via `ask> webull auth` then `ask> webull reconnect` when expired. Preflight auto-detects stale and prompts.

### Schema gaps
- **`placeFuturesOrder` argument shape** is a best-effort stub. Refine after first real Tuesday round-trip. Currently passes `{ account_id, instrument_symbol, side, order_type, quantity, bracket }` — likely needs adjustment to match actual `place_futures_order` MCP tool schema.
- **`placeOptionSingleOrder` argument shape** similarly stubbed. Refine when MCP equity-options routing wires Tue 5/19.
- **Webull OpenAPI doesn't label paper-vs-live accounts.** Operator's mobile-app toggle determines whether the API hits paper. Our paper-mode verification relies on operator pinning `WEBULL_PAPER_ACCOUNT_ID` to the right account.

### Cosmetic
- **`◇ injected env (0) from .env`** Python-side message in webhook log is a Python dotenv cosmetic message (means "0 NEW vars added beyond what spawn passed via process.env"). NOT a bug. Don't waste time debugging it.
- **Webhook supervisor timestamps drift** — saw `[16:28:20 ET]` when real time was ~14:45 ET earlier. Worth checking machine clock at some point but not blocking; HMAC tolerance is 5 min.

---

## 7. Upcoming Timeline (locked, per `docs/webull-mcp-integration-plan-2026-05-16.md`)

| Date | Work |
|---|---|
| **Sun 5/17 17:00-18:00 ET** | Final smoke tests, CME open at 18:00 ET, first Pine alerts route through MCP |
| **Mon 5/18** | Day 3 of streak — MCP-routed paper fills (RTH equity + 23/5 futures). Observation day; calibration LOOKUP telemetry continues; no code changes |
| **Tue 5/19** | **Calibration LIVE** — flip `CALIBRATION_APPLY_MULTIPLIER=true` + `CALIBRATION_BLOCK_ENABLED=true`. Implement full `MAX_WEEKLY_LOSS` tiered gate (currently stub). NVDA earnings day |
| **Wed 5/20** | MCP-Calibration full integration validation. No new layers; verify clean journal + ledger reconciliation |
| **Thu 5/21** | Spread Guard via MCP market data. Roll Guard auto-execution (currently scaffolded as warn-only) |
| **Fri 5/22** | Full pipeline stress test. Exercise three-tier rollback drills (`WEBULL_MCP_DISABLED` → reject new entries → `WEBULL_INTEGRATION_HALT` + auto-flatten) |
| **Sat 5/23** | Vision Phase 5 deploy DRY-RUN. `vision-monitor.js` + `visionCache.js` per `project_vision_phase5_spec.md` (structured numeric, Sonnet 4.6, calibration-matching tiers) |
| **Sun 5/24 - Fri 5/29** | Vision telemetry + full sandbox week — real broker fills (paper), no real money, all guards active |
| **Sun 5/31 PM** | Operator pre-live review |
| **Mon 6/1 09:30 ET** | **Production flip** — toggle Webull mobile app to Live, set `WEBULL_PAPER_MODE_EXPECTED=false`, `WEBULL_ENVIRONMENT=prod` (unchanged), first live trade. $2K total cap, $500 daily, $200/trade, $1K weekly halt. Vision stays dry-run through first live week |

---

## 8. Critical "Do Not" Lessons From Today

These are mistakes the outgoing Claude made. Don't repeat them.

1. **Don't trust WebFetch on tabular data without a second pass.** First fetch of Webull's UAT test accounts mis-parsed the columns (used App ID where App Key belonged). Wasted ~30 min + an authentication-failure debug spiral. Always re-fetch and compare when WebFetch result will be committed into code.

2. **Don't use parenthesized `if errorlevel N (...)` blocks in cmd batch.** Reliable only with `setlocal enabledelayedexpansion` + `!errorlevel!`. Use `goto :LABEL` patterns instead. Today's failure: preflight succeeded but the `if errorlevel 1` inside parens fired anyway, halting the launcher.

3. **Don't add a Y/N choice gate to operator workflows without testing it.** Today's `choice /c YN /n` blocked the bat when operator pressed N (or nothing). Use 5-sec countdowns + ctrl-C abort instead.

4. **Don't read `.env` to print values.** Use `grep -nE "^WEBULL_" .env | sed 's/=.*/=<redacted>/'` patterns. Today three secret-leak incidents because I `Read` the file or `cat`-grepped without sanitizing.

5. **Don't assume sandbox/UAT environments work without explicit operator confirmation.** Webull's UAT requires app approval AND shared-account creds AND special endpoint config. We burned an hour assuming the docs were accurate.

6. **Don't trust webhook log timestamps as authoritative.** Operator's machine clock or webhook process clock can drift — saw timestamps ~50 min ahead of real time. Use `date` shell command for ground truth.

7. **The "injected env (0) from .env" python-side log is NOT a bug.** It means python-dotenv added 0 NEW vars beyond what spawn passed via `process.env`. Don't waste time on it.

8. **Operator's contract:** *"Operator role is approval and validation, not manual PATH debugging."* If something can be auto-recovered, auto-recover it. If something requires operator action, surface clear actionable instructions, not error stack traces. Codify manual workarounds into `hank-preflight.js`.

---

## 9. Hand-Off Recommendations for the New Session

When the new Claude starts:

1. **Read this doc first.** Skip prefacing every action with "let me explore the codebase" — the file map in §5 covers it.

2. **Don't auto-spawn agents.** Today was a marathon session with very specific operator-driven decisions. The new Claude should match this velocity — direct edits + commits + push, NOT delegated multi-agent investigations.

3. **Respect the bootstrap.** `hank-preflight.js` is the source of truth for what's needed before launch. If a new issue arises that recurs, ADD a check to preflight instead of writing a one-off recovery script.

4. **Memory writes:** Today added `project_vision_phase5_spec.md`. Don't duplicate that. If operator confirms new decisions, save to memory only after explicit operator validation (not just answered AskUserQuestion).

5. **Commit cadence:** Operator strongly prefers small atomic commits + immediate push after operator approval. Pattern: edit → syntax check → commit → push → wait for operator to pull + restart + report → next change.

6. **Time zones:** Operator is ET. All scheduling references in code (preSwitchKill, calibration, etc.) are ET-based. CME futures session is 18:00 ET Sun open / 17:00 ET Mon-Fri reopen / Friday 17:00 ET close (operator-confirmed, may differ from generic CME schedule documentation).

7. **The marathon's last 8 commits all addressed Webull MCP issues.** If the new session's first message from operator is "Sunday session is GO" or "everything works" — celebrate, lock it in memory, and pivot to the Tue 5/19 calibration-LIVE work. If it's "still broken" — start with `webull` REPL output, then `mcp paper`, then Window 1 startup banner.

---

*End of handoff. Last commit at handoff time: `6cb8a45`. CME opens 18:00 ET. Good luck.*
