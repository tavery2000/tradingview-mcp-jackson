const fs = require('fs');
const file = 'C:\\Users\\tomav\\tradingview-mcp-jackson\\hank-electron-r3.html';

const s678 = `

<!-- ══════════════════ TAB 4: P&L DASHBOARD ════════════════ -->
<div class="tab-panel" id="tab-pnl">
  <div class="pnl-main">

    <div class="stat-row">
      <div class="stat-card">
        <div class="stat-lbl">BALANCE</div>
        <div class="stat-val bull" id="pnl-balance">$1,247.50</div>
      </div>
      <div class="stat-card">
        <div class="stat-lbl">TODAY P&amp;L</div>
        <div class="stat-val bull" id="pnl-today">+$247.50</div>
      </div>
      <div class="stat-card">
        <div class="stat-lbl">ALL-TIME P&amp;L</div>
        <div class="stat-val bull" id="pnl-alltime">+$247.50</div>
      </div>
      <div class="stat-card">
        <div class="stat-lbl">WIN RATE</div>
        <div class="stat-val bull" id="pnl-winrate">67%</div>
      </div>
      <div class="stat-card">
        <div class="stat-lbl">PROFIT FACTOR</div>
        <div class="stat-val bull" id="pnl-pf">2.4</div>
      </div>
    </div>

    <div class="levels-row">
      <div class="lvl-card">
        <div class="lvl-sym">SPY</div>
        <div class="lvl-row"><span class="lvl-lbl">PDH</span><span class="bear">$714.47</span></div>
        <div class="lvl-row"><span class="lvl-lbl">PDL</span><span class="bull">$709.21</span></div>
        <div class="lvl-row"><span class="lvl-lbl">PDC</span><span>$708.45</span></div>
        <div class="lvl-row"><span class="lvl-lbl">VWAP</span><span class="bull">$711.99</span></div>
        <div class="lvl-row"><span class="lvl-lbl">9EMA</span><span class="bull">$713.44</span></div>
      </div>
      <div class="lvl-card">
        <div class="lvl-sym">QQQ</div>
        <div class="lvl-row"><span class="lvl-lbl">PDH</span><span class="bear">$486.10</span></div>
        <div class="lvl-row"><span class="lvl-lbl">PDL</span><span class="bull">$481.33</span></div>
        <div class="lvl-row"><span class="lvl-lbl">VWAP</span><span class="bear">$484.42</span></div>
        <div class="lvl-row"><span class="lvl-lbl">9EMA</span><span class="bear">$484.80</span></div>
        <div class="lvl-row"><span class="lvl-lbl">SIGNAL</span><span style="color:var(--yellow);">WAIT</span></div>
      </div>
      <div class="lvl-card">
        <div class="lvl-sym">IWM</div>
        <div class="lvl-row"><span class="lvl-lbl">PDH</span><span class="bear">$199.22</span></div>
        <div class="lvl-row"><span class="lvl-lbl">PDL</span><span class="bull">$196.14</span></div>
        <div class="lvl-row"><span class="lvl-lbl">VWAP</span><span class="bull">$197.56</span></div>
        <div class="lvl-row"><span class="lvl-lbl">9EMA</span><span class="bull">$198.10</span></div>
        <div class="lvl-row"><span class="lvl-lbl">SIGNAL</span><span class="bull">CALLS</span></div>
      </div>
    </div>

    <div class="pnl-tables">
      <div class="panel">
        <div class="ph"><span class="pt">OPEN POSITIONS</span><span class="ps">Paper · Live P&amp;L</span></div>
        <div class="pb">
          <table class="pnl-table">
            <thead><tr><th>SYM</th><th>SIDE</th><th>QTY</th><th>ENTRY</th><th>CURR</th><th>P&amp;L</th><th>ACTION</th></tr></thead>
            <tbody id="open-pos-tbody">
              <tr>
                <td>SPY $716C</td><td class="bull">CALL</td><td>1</td>
                <td>$0.85</td><td class="bull">$1.27</td><td class="bull">+$42.00</td>
                <td><button class="pos-close-btn" onclick="closePosition('spy1')">✕</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel">
        <div class="ph"><span class="pt">CLOSED TRADES</span><span class="ps">Today · Paper</span></div>
        <div class="pb">
          <table class="pnl-table">
            <thead><tr><th>TIME</th><th>SYM</th><th>SIDE</th><th>P&amp;L</th><th>%</th></tr></thead>
            <tbody id="closed-tbody">
              <tr>
                <td style="font-size:13px;">09:42</td><td>SPY $714C</td><td class="bull">CALL</td>
                <td class="bull">+$127.00</td><td class="bull">+149%</td>
              </tr>
              <tr>
                <td style="font-size:13px;">10:05</td><td>IWM $199C</td><td class="bull">CALL</td>
                <td class="bull">+$78.00</td><td class="bull">+52%</td>
              </tr>
              <tr>
                <td style="font-size:13px;">10:18</td><td>QQQ $485C</td><td class="bull">CALL</td>
                <td class="bear">−$42.00</td><td class="bear">−28%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- MOO/MOC signal cards in P&L context -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
      <div class="imb-card imb-green">
        <div class="imb-type" style="color:var(--green);">📊 MOO · 09:25 ET</div>
        <div class="imb-row">
          <div class="imb-col"><div class="imb-lbl">S&amp;P NET</div><div class="imb-dollar">+$2.4B BUY</div></div>
          <div class="imb-col"><div class="imb-lbl">SIGNAL</div><div class="imb-val bull">TRADEABLE</div></div>
        </div>
        <div class="imb-signal">🟢 B1 entered 09:35 · +$127 realized</div>
      </div>
      <div class="imb-card imb-yellow">
        <div class="imb-type" style="color:var(--yellow);">📊 MOC · 15:50 ET</div>
        <div class="imb-row">
          <div class="imb-col"><div class="imb-lbl">S&amp;P NET</div><div class="imb-dollar">+$650M BUY</div></div>
          <div class="imb-col"><div class="imb-lbl">SIGNAL</div><div class="imb-val divm">CAUTION</div></div>
        </div>
        <div class="imb-signal">🟡 Wait for delta confirmation at 15:45</div>
      </div>
    </div>

  </div>
</div><!-- end tab-pnl -->

<!-- ══════════════════ TAB 5: TRADE ═════════════════════════ -->
<div class="tab-panel" id="tab-trade">
  <div class="trade-grid">

    <div class="trade-cmd">

      <!-- HANK SIGNAL BANNER -->
      <div class="panel">
        <div class="ph"><span class="pt">HANK SIGNAL</span><span class="ps">Live · Click APPLY to pre-fill</span></div>
        <div class="pb hank-signal-banner" id="hankSignalBanner">
          <div class="master-sig ms-calls" style="font-size:20px;padding:10px 16px;margin-bottom:8px;">⬡ TAKE CALLS — HIGH</div>
          <div style="font-size:14px;color:#aaa;">SPY 4/6 BULL · TICK +642 · VWAP +$2.02 · MOO $2.4B · W3 3/4</div>
          <button style="margin-top:10px;padding:8px 18px;background:#0a1a0a;border:1px solid var(--green);color:var(--green);font-family:var(--mono);font-size:14px;cursor:pointer;" onclick="applyHankSignal()">APPLY SIGNAL →</button>
        </div>
      </div>

      <!-- MODE + QUICK SYMBOLS -->
      <div class="panel">
        <div class="pb">
          <div style="font-size:13px;color:#333;letter-spacing:2px;margin-bottom:8px;">MODE</div>
          <div class="mode-row" style="margin-bottom:12px;">
            <button class="mode-btn active" onclick="setSettingMode('paper',this)">📋 PAPER</button>
            <button class="mode-btn" onclick="setSettingMode('live',this)">🔴 LIVE</button>
          </div>
          <div style="font-size:13px;color:#333;letter-spacing:2px;margin-bottom:8px;">QUICK SYMBOLS</div>
          <div class="quick-syms">
            <span class="qs-chip active" onclick="quickSym('SPY',this)">SPY</span>
            <span class="qs-chip" onclick="quickSym('QQQ',this)">QQQ</span>
            <span class="qs-chip" onclick="quickSym('IWM',this)">IWM</span>
            <span class="qs-chip" onclick="quickSym('NVDA',this)">NVDA</span>
            <span class="qs-chip" onclick="quickSym('META',this)">META</span>
            <span class="qs-chip" onclick="quickSym('AAPL',this)">AAPL</span>
          </div>
        </div>
      </div>

      <!-- SYMBOL FETCH + QUOTE -->
      <div class="panel">
        <div class="pb">
          <div class="sym-input-row" style="margin-bottom:10px;">
            <input class="sym-input" id="symInput" type="text" value="SPY" placeholder="TICKER" onkeydown="if(event.key==='Enter')fetchSymbol()">
            <button class="fetch-btn" onclick="fetchSymbol()">FETCH ▶</button>
          </div>
          <div class="quote-strip" id="quoteStrip">
            <span class="qs-sym">SPY</span>
            <span class="qs-price bull">714.01</span>
            <span class="bull">+5.56 (+0.79%)</span>
            <span class="qs-item"><span class="qs-lbl">Hi</span>715.20</span>
            <span class="qs-item"><span class="qs-lbl">Lo</span>709.21</span>
            <span class="qs-item"><span class="qs-lbl">Vol</span>48.2M</span>
          </div>
        </div>
      </div>

      <!-- SIDE + OPTIONS GRID -->
      <div class="panel">
        <div class="pb">
          <div style="font-size:13px;color:#333;letter-spacing:2px;margin-bottom:8px;">DIRECTION</div>
          <div class="side-row" style="margin-bottom:12px;">
            <button class="side-btn active" data-side="calls" onclick="setSide('calls',this)">CALLS ▲</button>
            <button class="side-btn" data-side="puts" onclick="setSide('puts',this)">PUTS ▼</button>
          </div>
          <div class="opts-grid">
            <div class="og-card">
              <div class="og-lbl">IV RANK</div>
              <div class="og-row"><span style="color:#888;">Current</span><span class="bull">38</span></div>
              <div class="og-row"><span style="color:#888;">Status</span><span class="bull">CHEAP</span></div>
            </div>
            <div class="og-card">
              <div class="og-lbl">EXPIRY</div>
              <div class="og-row"><span style="color:#888;">0DTE</span><span class="bull">Active</span></div>
              <div class="og-row"><span style="color:#888;">1DTE</span><span style="color:#444;">Alt</span></div>
            </div>
            <div class="og-card">
              <div class="og-lbl">LIQUIDITY</div>
              <div class="og-row"><span style="color:#888;">Volume</span><span class="bull">HIGH</span></div>
              <div class="og-row"><span style="color:#888;">Spread</span><span class="bull">$0.02</span></div>
            </div>
          </div>
        </div>
      </div>

      <!-- STRIKE + SIZE -->
      <div class="panel">
        <div class="pb">
          <div style="font-size:13px;color:#333;letter-spacing:2px;margin-bottom:8px;">STRIKE SELECTION</div>
          <div class="strike-display-row" style="margin-bottom:12px;">
            <span class="strike-lbl">STRIKE</span>
            <button class="strike-adj" onclick="adjustStrike(-1)">◀</button>
            <span class="strike-display" id="strikeDisplay">$715.0</span>
            <button class="strike-adj" onclick="adjustStrike(+1)">▶</button>
          </div>
          <div style="font-size:13px;color:#333;letter-spacing:2px;margin-bottom:8px;">CONTRACTS</div>
          <div class="size-grid">
            <button class="size-btn active" data-size="1" onclick="setSize(1,this)">1</button>
            <button class="size-btn" data-size="2" onclick="setSize(2,this)">2</button>
            <button class="size-btn" data-size="5" onclick="setSize(5,this)">5</button>
            <button class="size-btn" data-size="10" onclick="setSize(10,this)">10</button>
          </div>
        </div>
      </div>

      <!-- ORDER PREVIEW + EXECUTE -->
      <div class="panel">
        <div class="pb">
          <div style="font-size:13px;color:#333;letter-spacing:2px;margin-bottom:8px;">ORDER PREVIEW</div>
          <div class="order-preview" id="orderPreview">
            <div class="op-row"><span class="op-lbl">Symbol</span><span class="op-val">SPY</span></div>
            <div class="op-row"><span class="op-lbl">Action</span><span class="op-val bull">BUY CALL</span></div>
            <div class="op-row"><span class="op-lbl">Strike</span><span class="op-val">$715.0</span></div>
            <div class="op-row"><span class="op-lbl">Expiry</span><span class="op-val">0DTE</span></div>
            <div class="op-row"><span class="op-lbl">Qty</span><span class="op-val">1 contract</span></div>
            <div class="op-row"><span class="op-lbl">Est. Premium</span><span class="op-val">~$1.42</span></div>
          </div>
          <div class="exec-row" style="margin-top:10px;">
            <button class="exec-btn" onclick="handleConfirmOrder()">▶ CONFIRM &amp; EXECUTE</button>
            <button class="closeall-btn" onclick="closeAll()">✕ CLOSE ALL</button>
          </div>
          <div class="paper-note">📋 PAPER TRADE — simulated execution only</div>
          <div style="font-size:13px;color:#333;letter-spacing:2px;margin-top:10px;margin-bottom:6px;">TRADE LOG</div>
          <div class="trade-log" id="tradeLog">
            <div style="color:#2a2a3a;font-size:13px;padding:6px;">No trades this session.</div>
          </div>
        </div>
      </div>

    </div><!-- end trade-cmd -->

    <!-- POSITIONS PANEL -->
    <div class="pos-panel">
      <div class="panel" style="flex:1;min-height:0;">
        <div class="ph"><span class="pt">OPEN POSITIONS</span><span class="ps">Paper · Live P&amp;L</span></div>
        <div class="pb">
          <table class="pos-table">
            <thead><tr><th>SYM</th><th>QTY</th><th>ENTRY</th><th>P&amp;L</th><th>✕</th></tr></thead>
            <tbody id="posTable">
              <tr><td colspan="5" style="color:#2a2a3a;text-align:center;padding:14px;">No open positions</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <div class="ph"><span class="pt">ACCOUNT</span><span class="ps">Paper</span></div>
        <div class="pb">
          <div class="ar"><span class="al">Balance</span><span class="av bull">$1,247.50</span></div>
          <div class="ar"><span class="al">Today P&amp;L</span><span class="av bull">+$247.50</span></div>
          <div class="ar"><span class="al">PDT Status</span><span class="av bull">Cash — OK</span></div>
          <div class="ar"><span class="al">Risk/Trade</span><span class="av">10% max</span></div>
        </div>
      </div>
    </div>

  </div>
</div><!-- end tab-trade -->

<!-- ══════════════════ TAB 6: SETTINGS ══════════════════════ -->
<div class="tab-panel" id="tab-settings">
  <div class="settings-main">

    <!-- LAUNCH TRADINGVIEW — prominent top -->
    <div class="tv-launch-wrapper">
      <button id="tvLaunchBtn" onclick="launchTradingView()">
        ⬡ LAUNCH TRADINGVIEW + CDP
      </button>
    </div>

    <div class="settings-grid">

      <!-- TRADING MODE -->
      <div class="panel">
        <div class="ph"><span class="pt">TRADING MODE</span></div>
        <div class="pb">
          <div class="setting-card-lbl">ACCOUNT TYPE</div>
          <div class="mode-row" style="margin-bottom:14px;">
            <button class="mode-btn active" onclick="setSettingMode('paper',this)">📋 PAPER</button>
            <button class="mode-btn" onclick="setSettingMode('live',this)">🔴 LIVE</button>
          </div>
          <div class="s-row"><span class="s-lbl">Auto-execute signals</span><button class="s-toggle" onclick="setToggle(this)">OFF</button></div>
          <div class="s-row"><span class="s-lbl">Require confirmation</span><button class="s-toggle active" onclick="setToggle(this)">ON</button></div>
          <div class="s-row"><span class="s-lbl">Time stop (minutes)</span>
            <input class="risk-input" type="number" value="3" min="1" max="60">
          </div>
          <div class="s-row"><span class="s-lbl">Max contracts/trade</span>
            <input class="risk-input" type="number" value="1" min="1" max="20">
          </div>
        </div>
      </div>

      <!-- API CONNECTIONS -->
      <div class="panel">
        <div class="ph"><span class="pt">API CONNECTIONS</span></div>
        <div class="pb">
          <div class="setting-card-lbl">STATUS</div>
          <div class="api-row"><span class="api-lbl">CDP / TradingView</span><span class="api-stat ok">✓ Connected :9222</span></div>
          <div class="api-row"><span class="api-lbl">Yahoo Finance</span><span class="api-stat ok">✓ Live</span></div>
          <div class="api-row"><span class="api-lbl">Webull OpenAPI</span><span class="api-stat warn">⚠ Paper only</span></div>
          <div class="api-row"><span class="api-lbl">Polygon.io</span><span class="api-stat err">✗ No key</span></div>
          <div class="api-row"><span class="api-lbl">HANK WS Server</span><span class="api-stat ok">✓ :5001</span></div>
          <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
            <button class="set-btn" onclick="reAuthWebull()">Re-auth Webull</button>
            <button class="set-btn" onclick="testConnection('polygon')">Test Polygon</button>
            <button class="set-btn" onclick="testConnection('ws')">Test WS</button>
          </div>
        </div>
      </div>

      <!-- SERVICES CONTROL -->
      <div class="panel">
        <div class="ph"><span class="pt">SERVICES</span></div>
        <div class="pb">
          <div class="setting-card-lbl">PROCESS CONTROL</div>
          <div class="s-row">
            <span class="s-lbl">monitor.js (SPY)</span>
            <div style="display:flex;gap:6px;align-items:center;">
              <div class="svc-dot-sm run"></div>
              <button class="set-btn" onclick="svcToggle('monitor')">STOP</button>
            </div>
          </div>
          <div class="s-row">
            <span class="s-lbl">monitor-qqq.js</span>
            <div style="display:flex;gap:6px;align-items:center;">
              <div class="svc-dot-sm run"></div>
              <button class="set-btn" onclick="svcToggle('qqq')">STOP</button>
            </div>
          </div>
          <div class="s-row">
            <span class="s-lbl">monitor-iwm.js</span>
            <div style="display:flex;gap:6px;align-items:center;">
              <div class="svc-dot-sm run"></div>
              <button class="set-btn" onclick="svcToggle('iwm')">STOP</button>
            </div>
          </div>
          <div class="s-row">
            <span class="s-lbl">news.js</span>
            <div style="display:flex;gap:6px;align-items:center;">
              <div class="svc-dot-sm run"></div>
              <button class="set-btn" onclick="svcToggle('news')">STOP</button>
            </div>
          </div>
          <div class="s-row">
            <span class="s-lbl">moc.js</span>
            <div style="display:flex;gap:6px;align-items:center;">
              <div class="svc-dot-sm stop"></div>
              <button class="set-btn" onclick="svcToggle('moc')">START</button>
            </div>
          </div>
          <div class="s-row">
            <span class="s-lbl">wsServer.js</span>
            <div style="display:flex;gap:6px;align-items:center;">
              <div class="svc-dot-sm stop"></div>
              <button class="set-btn" onclick="svcToggle('ws')">START</button>
            </div>
          </div>
        </div>
      </div>

      <!-- RISK MANAGEMENT -->
      <div class="panel">
        <div class="ph"><span class="pt">RISK MANAGEMENT</span></div>
        <div class="pb">
          <div class="setting-card-lbl">LIMITS</div>
          <div class="s-row"><span class="s-lbl">Max daily loss</span><input class="risk-input" type="number" value="200" min="50"></div>
          <div class="s-row"><span class="s-lbl">Max loss per trade</span><input class="risk-input" type="number" value="50" min="10"></div>
          <div class="s-row"><span class="s-lbl">Hard stop % per contract</span><input class="risk-input" type="number" value="20" min="5" max="100"></div>
          <div class="s-row"><span class="s-lbl">Profit target %</span><input class="risk-input" type="number" value="30" min="10" max="200"></div>
          <div class="s-row"><span class="s-lbl">Pause after N losses</span><input class="risk-input" type="number" value="2" min="1" max="10"></div>
          <div style="margin-top:12px;">
            <button class="set-btn" style="width:100%;padding:10px;font-size:14px;" onclick="saveRiskSettings()">SAVE RISK SETTINGS</button>
          </div>
        </div>
      </div>

    </div><!-- end settings-grid -->
  </div>
</div><!-- end tab-settings -->

</div><!-- end content -->
</div><!-- end main-area -->
</div><!-- end shell -->`;

fs.appendFileSync(file, s678);
console.log('S678 done:', s678.length);
