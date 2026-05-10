@echo off
title HANK Trading Terminal — Launcher
echo.
echo  ============================================================
echo  HANK Trading Terminal — Startup Sequence
echo  ============================================================
echo  Window 1: MOO/MOC Engine     (FJ imbalance — start first)
echo  Window 2: SPY Monitor        (Mag-6 + SPY + wsServer :8765)
echo  Window 3: QQQ Monitor        (W3 + QQQ standalone)
echo  Window 4: IWM Monitor        (Mag-3 + IWM standalone)
echo  Window 5: News Terminal       (RSS + SEC + TTS + MOC writer)
echo  Window 6: MOC Engine          (15:50 confirmation + hard exit)
echo  Window 7: Morning Briefing    (08:30 ET daily brief)
echo  Window 8: Dashboard Server    (http://localhost:3000)
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

:: ── Window 1: MOO/MOC Engine ──────────────────────────────────────────────────
:: Start first — must be up before 09:20 ET to capture MOO imbalance
start "HANK MOO/MOC" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK MOO/MOC ENGINE && echo  MOO window 09:20-09:29  MOC window 15:50-15:59 && echo. && node moo-moc.js"

:: ── Window 2: SPY Monitor ─────────────────────────────────────────────────────
:: Hosts wsServer on :8765. QQQ + IWM monitors connect to it. Start before them.
start "HANK SPY" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK SPY MONITOR  ^|  Mag-6 + SPY && echo  wsServer broadcasting on ws://localhost:8765 && echo. && node monitor.js"

timeout /t 6 /nobreak > nul

:: ── Window 3: QQQ Monitor ─────────────────────────────────────────────────────
start "HANK QQQ" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK QQQ MONITOR  ^|  W3 + QQQ && echo. && node monitor-qqq.js"

timeout /t 2 /nobreak > nul

:: ── Window 4: IWM Monitor ─────────────────────────────────────────────────────
start "HANK IWM" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK IWM MONITOR  ^|  Mag-3 + IWM && echo. && node monitor-iwm.js"

timeout /t 2 /nobreak > nul

:: ── Window 5: News Terminal ───────────────────────────────────────────────────
start "HANK News" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK NEWS TERMINAL && echo  RSS + SEC filings + TTS + MOC data writer && echo. && node news.js"

timeout /t 2 /nobreak > nul

:: ── Window 6: MOC Engine ──────────────────────────────────────────────────────
:: Arms 15:45. Reads moc-data.json + wsServer TICK. Hard exit 15:59.
start "HANK MOC" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK MOC ENGINE && echo  Arms 15:45  Snapshot 15:50  Trigger 15:51  Exit 15:59 && echo. && node moc-engine.js"

timeout /t 2 /nobreak > nul

:: ── Window 7: Morning Briefing ────────────────────────────────────────────────
start "HANK Briefing" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK BRIEFING ENGINE && echo  Daily brief at 08:30 ET && echo. && node briefing.js"

timeout /t 2 /nobreak > nul

:: ── Window 8: Dashboard Server ──────────────────────────────────────────────
start "HANK Dashboard" cmd /k "cd C:\Users\tomav\tradingview-mcp-jackson && echo. && echo  HANK DASHBOARD SERVER && echo  Open: http://localhost:3000 && echo. && node dashboard-server.js"

echo.
echo  ============================================================
echo  All 8 HANK engines launched.
echo.
echo  Startup order:
echo    1. MOO/MOC   (FJ imbalance — MOO fires at 09:20, MOC at 15:50)
echo    2. SPY        (wsServer :8765 + Mag-6 CDP — 6s head start)
echo    3. QQQ        (W3 standalone)
echo    4. IWM        (Mag-3 standalone)
echo    5. News       (RSS + MOC data writer)
echo    6. MOC        (reads moc-data.json + wsServer)
echo    7. Briefing   (ready for 08:30 ET)
echo    8. Dashboard  (http://localhost:3000)
echo  ============================================================
echo.
pause
