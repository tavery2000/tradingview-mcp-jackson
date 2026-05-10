# HANK AI — Autonomous Trading Bot

## What is Hank?
Hank is a fully autonomous AI trading bot. He trades SPY, QQQ, and IWM 
options (0DTE/weekly) on a $25,000 paper account using TradingView CDP 
signals, VWAP, Volume Delta, TICK, W3 confirmation, and MOC/MOO imbalance.

## File Locations
C:\Users\tomav\tradingview-mcp-jackson\
- monitor.js       — Mag6 + SPY signal engine (CDP via port 9222)
- news.js          — Financial Juice RSS, SEC EDGAR, TTS alerts
- moc-engine.js    — MOC trading engine (15:50 confirmation, 15:59 hard exit)
- moo-moc.js       — MOO/MOC FJ imbalance producer (writes moc-data.json)
- paperTrading.js  — Live paper trading execution
- webull.js        — Webull OpenAPI integration
- wsServer.js      — WebSocket server port 8765
- briefing.js      — 08:30 morning briefing
- mailer.js        — Email delivery
- flow.js          — Options flow MQTT
- theta.js         — Theta/IV engine

## Dashboard
http://localhost:3000

## How to Start
Window 1: node monitor.js
Window 2: node news.js
Window 3: node moc-engine.js
Window 4: node paperTrading.js
Window 5: node wsServer.js

## TradingView Setup
- CDP port 9222
- Stock tab: NVDA, AAPL, MSFT, META, AMZN, GOOGL (6 panes)
- Claude SPY tab: SPY only
- Indicators: VWAP Session + Volume Delta on all charts

## Signal Logic
- BULL = above VWAP + positive delta
- BEAR = below VWAP + negative delta
- DIV+ = below VWAP + positive delta
- DIV- = above VWAP + negative delta
- CHOP = 3+ stocks DIV- with delta < -1K
- Threshold: 4/6 stocks + SPY confirms
- W3 confirmation: TSLA, AVGO, JPM, QQQ

## Trading Rules
- Instruments: SPY, QQQ, IWM options only
- Account: $25,000 paper
- Max positions: 2 concurrent
- Max daily loss: $2,500
- No ODTE held past 15:45
- No trading during midday 11:30-13:00
- Wait for MOO imbalance before first trade
- 3 consecutive losses same instrument = 2hr suspend

## Webull API
- App key: ef4b4bc21d862c8f8d9f8d003713ed26
- Production: api.webull.com (OpenAPI for orders + account)
- Account: ICIUR8Q1AKI50628B9RQ3EG0IB
- 2FA: disabled
- Status: connected and authenticated
- Options chain: separate consumer endpoint (quotes-gw.webullfintech.com),
  needs consumer access_token, NOT OpenAPI HMAC. Setup: `WEBULL-SETUP.md`

## Build Roadmap
- Saturday May 9 — Electron desktop app build
  - Electron shell around hank-electron-r3.html
  - wsServer live data wiring
  - Webull options chain live data
  - flow.js MQTT schema confirmation
  - Voice Bridge (TTS/STT — Hank speaks, you respond by voice)

## Current Status (as of May 7, 2026)
- All 5 paper trading bugs fixed
- Webull API connected
- Morning briefing working (08:30)
- MOC/MOO engine working
- hank-electron-r3.html layout complete
- Electron app not built yet — Saturday May 9
