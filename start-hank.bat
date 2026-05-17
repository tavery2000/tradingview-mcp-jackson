@echo off
title HANK Trading Terminal — Launcher
echo.
echo  ============================================================
echo  HANK Trading Terminal — Startup Sequence
echo  ============================================================
echo  Window 1:  Webhook Supervisor (Pine alert receiver :9001 — auto-restart)
echo  Window 2:  ngrok Tunnel       (yiddish-composure-amusing → :9001)
echo  Window 3:  SPY Monitor        (Mag-6 + SPY + wsServer :8080 in-process)
echo  Window 4:  QQQ Monitor        (W3 + QQQ standalone)
echo  Window 5:  News Terminal      (RSS + SEC + TTS + MOC data writer)
echo  Window 6:  Morning Briefing   (08:30 ET daily brief)
echo  Window 7:  Dashboard Server   (http://localhost:3000)
echo  Window 8:  Theta Monitor      (per-position greeks + burn zone → /api/theta)
echo  Window 9:  Ask HANK REPL      (natural-language Q^&A + kill/flatten WRITE commands)
echo  (IWM retired 2026-05-15)
echo  (MOO/MOC + MOC engines retired 2026-05-15 — NYSE feed too delayed without subscription)
echo  (Path 2 futures-direct retired 2026-05-17 — all futures via Webull MCP, embedded in Window 1)
echo  ============================================================
echo.
echo  Prerequisites:
echo  - TradingView running with --remote-debugging-port=9222
echo  - Claude 6-Chart tab open  (NVDA AAPL MSFT META AMZN GOOGL)
echo  - Claude SPY tab open      (SPY + VWAP + Volume Delta + VRRS + Tick)
echo  - Claude QQQ tab open      (QQQ AMD AVGO TSLA ARM NVDA + same stack)
echo  - Webull authenticated     (.webull_token present)
echo  ============================================================
echo.

:: ── 2026-05-17 PREFLIGHT ─────────────────────────────────────────────────────
:: Validates bootstrap state before spawning HANK windows. Codifies the manual
:: Sunday 5/17 workarounds (uvx quarantine guard, Defender exclusion check,
:: stale Webull token cleanup, .env / dotenv sanity).
:: To skip (debug): set HANK_SKIP_PREFLIGHT=1 then re-run
::
:: Uses goto labels (not parenthesized blocks) because cmd errorlevel inside
:: parens is unreliable without setlocal enabledelayedexpansion.
echo  [stage 1/4] cd to project root
cd /d C:\Users\tomav\tradingview-mcp-jackson
if errorlevel 1 goto :PREFLIGHT_CD_FAIL

echo  [stage 2/4] running preflight checks (set HANK_SKIP_PREFLIGHT=1 to bypass)
if defined HANK_SKIP_PREFLIGHT goto :PREFLIGHT_SKIPPED
node hank-preflight.js
if errorlevel 1 goto :PREFLIGHT_BLOCKED
goto :PREFLIGHT_OK

:PREFLIGHT_SKIPPED
echo  [stage 2/4] preflight SKIPPED via HANK_SKIP_PREFLIGHT

:PREFLIGHT_OK
echo.
echo  ============================================================
echo  OPERATOR PRE-LAUNCH NOTES
echo  ============================================================
echo   - Webull mobile app should be OPEN and toggled to PAPER mode
echo   - Phone unlocked + Webull app foreground (for 2FA push)
echo   - If preflight deleted a stale token: be ready to approve 2FA
echo     on phone within ~5 sec of running `ask^> webull auth`
echo  ============================================================
echo.
echo  [stage 3/4] launching in 5 seconds (Ctrl+C to abort)...
timeout /t 5 /nobreak > nul

echo  [stage 4/4] spawning HANK windows
timeout /t 1 /nobreak > nul

:: ── Window 1: Webhook Supervisor ─────────────────────────────────────────────
:: Pine alert receiver wrapper (port 9001). Auto-restart on crash, logs cause
:: to logs/webhook-supervisor.log. Must be up before ngrok forwards to it.
start "HANK Webhook" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK WEBHOOK SUPERVISOR && echo  Pine alert receiver on :9001  ^|  Auto-restart on crash && echo. && node webhook-supervisor.js"

timeout /t 2 /nobreak > nul

:: ── Window 2: ngrok Tunnel ───────────────────────────────────────────────────
:: Reserved domain → :9001. NOT supervise-restarted (would loop on domain conflict).
:: stderr visible in window; ngrok inspector at http://localhost:4040.
start "HANK ngrok" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK NGROK TUNNEL && echo  yiddish-composure-amusing.ngrok-free.dev → :9001 && echo  Inspector: http://localhost:4040 && echo. && ngrok http --domain=yiddish-composure-amusing.ngrok-free.dev 9001"

timeout /t 2 /nobreak > nul

:: ── Window 3 RETIRED 2026-05-15: MOO/MOC engine removed — NYSE imbalance
::    feed is too delayed without a paid NYSE subscription. moo-moc.js +
::    moc-engine.js archived under _archive/. news.js still writes
::    moc-data.json for downstream consumers; revisit once NYSE feed lands.

:: ── Window 3: SPY Monitor ─────────────────────────────────────────────────────
:: Hosts wsServer on :8080. QQQ + IWM monitors connect to it. Start before them.
start "HANK SPY" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK SPY MONITOR  ^|  Mag-6 + SPY && echo  wsServer broadcasting on ws://localhost:8080 && echo. && node supervise.js monitor.js"

timeout /t 6 /nobreak > nul

:: ── Window 4: QQQ Monitor ─────────────────────────────────────────────────────
start "HANK QQQ" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK QQQ MONITOR  ^|  W3 + QQQ && echo. && node supervise.js monitor-qqq.js"

timeout /t 2 /nobreak > nul

:: ── Window 6 RETIRED 2026-05-15: IWM Monitor removed per operator directive.
::    monitor-iwm.js + hank-iwm.pine archived under _archive/. Webhook server
::    rejects inbound IWM alerts with INSTRUMENT_RETIRED.

:: ── Window 5: News Terminal ───────────────────────────────────────────────────
start "HANK News" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK NEWS TERMINAL && echo  RSS + SEC filings + TTS + MOC data writer && echo. && node supervise.js news.js"

timeout /t 2 /nobreak > nul

:: ── Window 7 RETIRED 2026-05-15: MOC Engine removed alongside MOO/MOC.
::    Same NYSE-feed-too-delayed rationale.

:: ── Window 6: Morning Briefing ────────────────────────────────────────────────
start "HANK Briefing" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK BRIEFING ENGINE && echo  Daily brief at 08:30 ET && echo. && node supervise.js briefing.js"

timeout /t 2 /nobreak > nul

:: ── Window 7: Dashboard Server ──────────────────────────────────────────────
start "HANK Dashboard" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK DASHBOARD SERVER && echo  Open: http://localhost:3000 && echo. && node supervise.js dashboard-server.js"

timeout /t 2 /nobreak > nul

:: ── Window 8: Theta Monitor ─────────────────────────────────────────────────
:: Per-position greeks + burn zone — depends on wsServer (Window 4 monitor.js)
:: and CDP :9222 for futures. Writes portfolio-theta.json every 5s.
start "HANK Theta" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK THETA MONITOR && echo  Per-position greeks + burn zone  ^|  /api/theta + hank^>theta && echo. && node supervise.js theta-monitor.js"

timeout /t 2 /nobreak > nul

:: ── Window 9 RETIRED 2026-05-17: Futures Status removed alongside Path 2.
::    futuresTrading.js + futures-status.js archived under
::    _archive/2026-05-17-futures-direct-retirement/. All futures execution
::    now via Webull MCP (embedded in webhook-server.js). MCP-side position
::    visibility lands in a future dashboard widget.

:: ── Window 9: Ask HANK REPL ─────────────────────────────────────────────────
:: 2026-05-15: interactive Q&A REPL. Mostly read-only (snapshot SPY/QQQ price,
:: signals, positions, pnl, tier, flow, theta) plus two WRITE commands:
::   kill [SYM]   — close all open positions (optional symbol filter)
::   flatten      — alias for `kill` (no filter, close ALL)
:: NOT wrapped in supervise.js — readline-driven interactive shell; supervisor
:: respawn on Ctrl-C / clean exit would break the terminal session. Just run
:: it again manually if it dies.
start "HANK Ask" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK ASK REPL && echo  Type 'help' for commands. kill/flatten WRITE; everything else read-only. && echo. && node ask-cli.js"

echo.
echo  ============================================================
echo  All 9 HANK engines launched. (IWM + MOO/MOC retired 5/15; Path 2 retired 5/17)
echo.
echo  Startup order:
echo    1.  Webhook   (supervisor wraps webhook-server.js on :9001)
echo    2.  ngrok     (yiddish-composure-amusing → :9001, 2s after webhook)
echo    3.  SPY       (wsServer :8080 in-process + Mag-6 CDP)
echo    4.  QQQ       (W3 standalone)
echo    5.  News      (RSS + MOC data writer — kept for future re-enable)
echo    6.  Briefing  (ready for 08:30 ET)
echo    7.  Dashboard (http://localhost:3000)
echo    8.  Theta     (per-position greeks, depends on wsServer + CDP)
echo    9.  Ask       (interactive Q^&A REPL — type 'help')
echo  ============================================================
echo.
pause
goto :EOF

:: ── Preflight failure labels (kept at end so normal flow skips past them) ───
:PREFLIGHT_CD_FAIL
echo.
echo  ============================================================
echo  FAILED to cd into project root C:\Users\tomav\tradingview-mcp-jackson
echo  Check path exists. Halting.
echo  ============================================================
pause
exit /b 1

:PREFLIGHT_BLOCKED
echo.
echo  ============================================================
echo  PREFLIGHT BLOCKED. Resolve failures above then re-run.
echo  (To bypass for debug: set HANK_SKIP_PREFLIGHT=1 first.)
echo  ============================================================
pause
exit /b 1
