@echo off
title HANK Trading Terminal — Launcher
echo.
echo  ============================================================
echo  HANK Trading Terminal — Startup Sequence
echo  ============================================================
echo  Window 1:  Webhook Supervisor (Pine alert receiver :9001 — auto-restart)
echo  Window 2:  ngrok Tunnel       (yiddish-composure-amusing → :9001)
echo  Window 3:  MOO/MOC Engine     (FJ imbalance — start first)
echo  Window 4:  SPY Monitor        (Mag-6 + SPY + wsServer :8080 in-process)
echo  Window 5:  QQQ Monitor        (W3 + QQQ standalone)
echo  Window 6:  IWM Monitor        (Mag-3 + IWM standalone)
echo  Window 7:  News Terminal      (RSS + SEC + TTS + MOC writer)
echo  Window 8:  MOC Engine         (15:50 confirmation + hard exit)
echo  Window 9:  Morning Briefing   (08:30 ET daily brief)
echo  Window 10: Dashboard Server   (http://localhost:3000)
echo  Window 11: Theta Monitor      (per-position greeks + burn zone → /api/theta)
echo  ============================================================
echo.
echo  Prerequisites:
echo  - TradingView running with --remote-debugging-port=9222
echo  - Claude 6-Chart tab open  (NVDA AAPL MSFT META AMZN GOOGL)
echo  - Claude SPY tab open      (SPY + VWAP + Volume Delta + VRRS + Tick)
echo  - Claude QQQ tab open      (QQQ AMD AVGO TSLA ARM NVDA + same stack)
echo  - Claude IWM tab open      (IWM BE CRDO FN + same stack)
echo  - Webull authenticated     (.webull_token present)
echo  ============================================================
echo.

timeout /t 2 /nobreak > nul

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

:: ── Window 3: MOO/MOC Engine ──────────────────────────────────────────────────
:: P0-2 (2026-05-14 EOD): all monitors now launched under supervise.js for
:: auto-restart on death. theta-monitor + monitor-iwm died silently mid-
:: session today; supervisor pattern catches future deaths within 2s.
start "HANK MOO/MOC" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK MOO/MOC ENGINE && echo  MOO window 09:20-09:29  MOC window 15:50-15:59 && echo. && node supervise.js moo-moc.js"

:: ── Window 4: SPY Monitor ─────────────────────────────────────────────────────
:: Hosts wsServer on :8080. QQQ + IWM monitors connect to it. Start before them.
start "HANK SPY" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK SPY MONITOR  ^|  Mag-6 + SPY && echo  wsServer broadcasting on ws://localhost:8080 && echo. && node supervise.js monitor.js"

timeout /t 6 /nobreak > nul

:: ── Window 5: QQQ Monitor ─────────────────────────────────────────────────────
start "HANK QQQ" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK QQQ MONITOR  ^|  W3 + QQQ && echo. && node supervise.js monitor-qqq.js"

timeout /t 2 /nobreak > nul

:: ── Window 6: IWM Monitor ─────────────────────────────────────────────────────
start "HANK IWM" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK IWM MONITOR  ^|  Mag-3 + IWM && echo. && node supervise.js monitor-iwm.js"

timeout /t 2 /nobreak > nul

:: ── Window 7: News Terminal ───────────────────────────────────────────────────
start "HANK News" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK NEWS TERMINAL && echo  RSS + SEC filings + TTS + MOC data writer && echo. && node supervise.js news.js"

timeout /t 2 /nobreak > nul

:: ── Window 8: MOC Engine ──────────────────────────────────────────────────────
:: Arms 15:45. Reads moc-data.json + wsServer TICK. Hard exit 15:59.
start "HANK MOC" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK MOC ENGINE && echo  Arms 15:45  Snapshot 15:50  Trigger 15:51  Exit 15:59 && echo. && node supervise.js moc-engine.js"

timeout /t 2 /nobreak > nul

:: ── Window 9: Morning Briefing ────────────────────────────────────────────────
start "HANK Briefing" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK BRIEFING ENGINE && echo  Daily brief at 08:30 ET && echo. && node supervise.js briefing.js"

timeout /t 2 /nobreak > nul

:: ── Window 10: Dashboard Server ──────────────────────────────────────────────
start "HANK Dashboard" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK DASHBOARD SERVER && echo  Open: http://localhost:3000 && echo. && node supervise.js dashboard-server.js"

timeout /t 2 /nobreak > nul

:: ── Window 11: Theta Monitor ─────────────────────────────────────────────────
:: Per-position greeks + burn zone — depends on wsServer (Window 4 monitor.js)
:: and CDP :9222 for futures. Writes portfolio-theta.json every 5s.
start "HANK Theta" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK THETA MONITOR && echo  Per-position greeks + burn zone  ^|  /api/theta + hank^>theta && echo. && node supervise.js theta-monitor.js"

echo.
echo  ============================================================
echo  All 11 HANK engines launched.
echo.
echo  Startup order:
echo    1.  Webhook   (supervisor wraps webhook-server.js on :9001)
echo    2.  ngrok     (yiddish-composure-amusing → :9001, 2s after webhook)
echo    3.  MOO/MOC   (FJ imbalance — MOO fires at 09:20, MOC at 15:50)
echo    4.  SPY       (wsServer :8080 in-process + Mag-6 CDP — 6s head start)
echo    5.  QQQ       (W3 standalone)
echo    6.  IWM       (Mag-3 standalone)
echo    7.  News      (RSS + MOC data writer)
echo    8.  MOC       (reads moc-data.json + wsServer)
echo    9.  Briefing  (ready for 08:30 ET)
echo    10. Dashboard (http://localhost:3000)
echo    11. Theta     (per-position greeks, depends on wsServer + CDP)
echo  ============================================================
echo.
pause
