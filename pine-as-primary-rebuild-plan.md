# Pine-as-Primary Rebuild Plan

**Drafted:** 2026-05-11 (EOD)
**Operator:** Tom Avery
**Trigger:** Today's afternoon data conclusively showed: Pine indicator's chart signals capture the edge (operator manual: 60% + 90% gains on consecutive trades). HANK's auto-trading engines (STRUCTURE / FADE / FVG / SWEEP) underperformed because they reinvent what the Pine indicator already shows. Decision: **the Pine indicator is the signal source. HANK becomes a pure executor.**

---

## Current architecture (what's getting replaced)

```
TradingView (Pine indicator on chart) ─── displays HL/LH/SELL/BUY/zones/sweeps
                                          (operator reads visually)

monitor.js poll loop (every 30s):
  ├── chartStructure.js  → computes STRUCTURE engine signals
  ├── fvg.js             → computes FVG engine signals
  ├── sweep.js           → computes SWEEP engine signals
  ├── (FADE engine logic inline)
  ├── (TREND engine — already deleted/wrapped today)
  └── all signals → executeScalpSignal → sendOrder → paper-ledger
```

**Problem:** the JS engines reinvent the technical analysis the Pine indicator has already done — and they disagree with what the operator sees on the chart. Today proved this with paper-vs-manual P&L delta.

---

## Target architecture

```
TradingView (Pine indicator with alertcondition outputs)
  │
  ├── alert fires when condition triggers (BOS, CHoCH, SWEEP, ZONE_BREAK, LIVE, HL/LH, BUY/SELL)
  │
  ▼
  TradingView webhook (POST JSON to URL)
  │
  ▼
HANK webhook-server.js (new) — Express endpoint /pine-alert
  │
  ├── validates payload (instrument, direction, engine, confidence, price)
  ├── tier-aware sizing via paperTrading.getPositionSize
  ├── calls paperTrading.sendOrder
  ▼
paper-ledger.json + journal-XXXX.jsonl
```

---

## What's kept

| File | Role | Why kept |
|---|---|---|
| `paperTrading.js` | Position management, sendOrder, closePosition, exits (TARGET_1.5X, STOP_0.5X, TIME_STOP, VWAP_EXIT, SIGNAL_REVERSAL, EOD_CLOSE) | Core executor — does the actual paper trading |
| `journal.js` | Decision logging | Persistent audit trail |
| `tier.js` | Tier-based position sizing + risk caps | Risk management |
| `webull.js` | Option contract selection (`selectContract`) | Strike/expiry math |
| `moc-engine.js` | MOC trades at 15:50–16:00 ET | Separate concern, still useful |
| `daily-bias.js` | Daily bias verdict for journal context | Optional context flag, no longer gates trades |
| `bars.js` | Bar cache (for journal context only) | Used by dashboard, not signal gen |
| `dashboard-server.js` | Web UI | Position/P&L display |
| `news.js` | News headline display | Operator awareness only |
| `briefing.js` | Morning brief generation | Standalone utility |
| `ask-cli.js` | CLI tool | Operator helper |
| `smc-pro-futures.pine` | THE signal source | Now load-bearing |

---

## What's deleted

| File | Why deleted |
|---|---|
| `chartStructure.js` | Pine indicator computes structure (HH/HL/LH/LL/BOS/CHoCH). JS duplicate is redundant. |
| `fvg.js` | Pine indicator computes FVGs and draws them on chart. JS duplicate is redundant. |
| `sweep.js` | Pine indicator detects liquidity sweeps. JS duplicate is redundant. |
| `triggerScans.js` (engine-running portion) | Was orchestrating the JS engines. No engines = no orchestration. |
| `analyze.js` (gate-related portions) | gate1H, analyze1H, analyze4H were for the gates we already stripped in Path 2. Keep the parts journal references. |
| `signalConfidence.js` (most of it) | Strip booster math, gate functions. Keep just `applyMultipliers` for confidence→numeric and `readDailyBiasRegime` for context logging. |

---

## What's restructured

### `monitor.js` / `monitor-qqq.js` / `monitor-iwm.js`

Current shape: poll loop running engines, calling `executeScalpSignal`.

New shape:
- **Optional process** — only needed if you want active CDP integration with TradingView for chart-state reads (display), bar caches (journal context), or news pulls
- The signal-generation poll loop is **deleted**
- `executeScalpSignal` becomes `executePineAlert(alertPayload)` — much simpler

Actually: if Pine alerts handle 100% of trade dispatch via webhook, the monitor processes may be reducible to "context refreshers" (bar caches, news, levels files) for the dashboard. Or removable entirely.

**Decision:** keep one minimal monitor.js for SPY context refresh (price, vwap, delta tracking for the dashboard). Strip everything else.

---

## Webhook receiver — `webhook-server.js` (new, ~150 LOC)

### POST `/pine-alert` — accepts Pine alert JSON

```json
{
  "instrument": "SPY",
  "direction": "PUTS",
  "engine": "FADE",
  "confidence": "MEDIUM",
  "price": 739.50,
  "vwap": 738.95,
  "alertName": "Bullish Zone Break",
  "ts": "2026-05-11T19:45:00Z"
}
```

### Flow

```js
app.post('/pine-alert', async (req, res) => {
  const { instrument, direction, engine, confidence, price } = req.body;

  // Validate
  if (!instrument || !direction || !price) {
    return res.status(400).json({ error: 'missing required fields' });
  }
  if (!isTradingHours()) {
    journal.jGateBlock(engine, instrument, direction, 'OUT_OF_HOURS', {});
    return res.json({ ok: false, reason: 'OUT_OF_HOURS' });
  }

  // Compute synthetic option price via ATR fallback (Webull chain API_DISABLED)
  const optEst = parseFloat((price * 0.005 * 0.4).toFixed(2));
  if (optEst <= 0.05) {
    journal.jGateBlock(engine, instrument, direction, 'PRICE_TOO_LOW', { optEst });
    return res.json({ ok: false, reason: 'PRICE_TOO_LOW' });
  }

  // Select contract
  const contract = webull.selectContract(instrument, price, direction);

  // Build consensus payload
  const consensus = {
    signal: direction, engine, confidence,
    finalConfidence: confidence === 'HIGH' ? 1.5 : 1.0,
    instrument,
    strike: contract.strike,
    expiry: contract.expiry,
    entryPrice: optEst,
    underlyingPrice: price,
    contracts: 1
  };

  const reqId = orderGate.createRequest({ signal: direction, engine });
  const fill = await paperTrading.sendOrder(consensus, reqId, { mid: optEst });

  if (fill.vetoed) {
    return res.json({ ok: false, reason: fill.reason });
  }

  journal.jSignal({ type: 'PINE_ALERT', engine, direction, confidence, instrument, price });
  return res.json({ ok: true, reqId, fill });
});
```

### Defense-in-depth

- RTH gate (already in sendOrder defense-in-depth — fires)
- Tier caps (in sendOrder)
- Daily-loss cap (in sendOrder)
- Per-instrument cap (in sendOrder)
- SIGNAL_REVERSAL exit (when opposite-direction alert arrives on instrument with open position — webhook can call closePosition before opening new)

---

## Pine alert configuration (operator-side)

For each `alertcondition` you want to trade, set up a TradingView alert with:

- **Trigger:** the alertcondition by name
- **Frequency:** Once Per Bar Close (matches `barstate.isconfirmed`)
- **Notification:** Webhook URL → `http://localhost:9001/pine-alert` (or whatever port you choose)
- **Message:** JSON string like:

```json
{"instrument":"SPY","direction":"PUTS","engine":"FADE","confidence":"MEDIUM","price":{{close}},"vwap":{{plot("vwap")}},"alertName":"FADE PUTS"}
```

TradingView substitutes `{{close}}`, `{{volume}}`, etc. when firing the alert.

### Which Pine alerts to wire

Recommended set for v1:

| Alert | Direction | Engine | Confidence |
|---|---|---|---|
| BUY signal | CALLS | (varies — pulled from alert text) | MEDIUM |
| SELL signal | PUTS | (varies) | MEDIUM |
| HTF-aligned BUY | CALLS | HTF | HIGH |
| HTF-aligned SELL | PUTS | HTF | HIGH |
| Bullish Zone Break | CALLS | ZONE | MEDIUM |
| Bearish Zone Break | PUTS | ZONE | MEDIUM |
| LIVE Bullish Break | CALLS | LIVE | MEDIUM |
| LIVE Bearish Break | PUTS | LIVE | MEDIUM |
| Bullish HL early-entry | CALLS | HL | MEDIUM |
| Bearish LH early-entry | PUTS | LH | MEDIUM |

Skip for v1: raw BOS / CHoCH / Sweep alerts (already aggregated by BUY/SELL signal).

---

## Phased rollout

### Phase 1 — TONIGHT (Foundation)

- ✅ This plan document
- Build `webhook-server.js`
- Test end-to-end with curl/Invoke-RestMethod (no Pine needed)
- At end of Phase 1: webhook live, takes JSON, opens paper trade

### Phase 2 — TONIGHT or TOMORROW AM (Configuration)

- Operator: configure TradingView Pine alerts on SPY/QQQ/IWM 1M
- Test with real Pine alert firing during off-hours / after open
- Validate: real alert → webhook → paper position

### Phase 3 — TOMORROW (Strip old code)

- Delete `chartStructure.js`, `fvg.js`, `sweep.js`, `triggerScans.js` engine portions
- Strip the engine-running loops from `monitor.js` / `monitor-qqq.js` / `monitor-iwm.js`
- Reduce monitors to "context refreshers" if needed, or remove entirely
- Net: ~70% LOC reduction, HANK shrinks dramatically

### Phase 4 — TOMORROW NY OPEN (Live test)

- Pine indicator firing real alerts during market hours
- Webhook receiving + paper-trading
- Validate against operator's manual reads — should match closely now

---

## Risk / rollback

- New webhook listener runs in parallel with existing monitors initially (Phase 1 + 2)
- Old engines still active until Phase 3 — gives clean rollback path
- Each phase is its own commit / revert unit
- If Phase 4 reveals webhook issues, revert Phase 3 (restore engines) and debug webhook in parallel

---

## What today's commits already give us

The morning's Pine indicator work + afternoon JS strip + risk fixes mean:

- Pine indicator has 10+ alertcondition outputs ready to webhook from
- HANK's executor layer (paperTrading.sendOrder) has working tier caps, RTH gate, ATR fallback, TARGET_1.5X, SIGNAL_REVERSAL exit
- Most of what Phase 3 deletes is already inert (HIERARCHY_V2=true makes chart engines the only dispatch path)
- The rebuild is removing dead code, not changing behavior

This means **the rebuild's user-visible behavior change is small** — chart-engine logic stays the same, just relocated from JS into Pine.

---

## Estimated effort

| Phase | Time | Files touched |
|---|---|---|
| Phase 1 (foundation) | 30–45 min | +1 new file (`webhook-server.js`), +1 doc (this) |
| Phase 2 (config) | 15 min operator-side | TradingView alerts config only |
| Phase 3 (strip) | 45–60 min | Delete 4+ files, edit 3 monitors |
| Phase 4 (live test) | 30 min monitoring | Zero code |

**Total: ~2 hours of development + 30 min live validation.**

---

*Plan locked. Phase 1 starting now.*
