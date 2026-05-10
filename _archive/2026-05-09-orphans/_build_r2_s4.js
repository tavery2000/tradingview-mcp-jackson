const fs = require('fs');
const file = 'C:\\Users\\tomav\\tradingview-mcp-jackson\\hank-electron-r2.html';

const s4 = `

<!-- ══════════════════ TAB 2: MONITOR (Screen 1) ════════════ -->
<div class="tab-panel" id="tab-monitor">

  <!-- INFOBAR -->
  <div class="infobar">
    <span><span class="ib-lbl">ES Gap </span><span class="ib-good">+0.33% Up ↑</span></span>
    <span><span class="ib-lbl">P/C </span><span class="ib-good">0.68 bullish</span></span>
    <span><span class="ib-lbl">SPY Vol </span><span class="ib-warn">51% avg ⚠ LOW — FADE BIAS ON</span></span>
    <span style="color:#1a1a30;font-size:18px;">│</span>
    <span><span class="ib-lbl">PDH </span><span class="bear">$714.47</span></span>
    <span><span class="ib-lbl">PDL </span><span class="bull">$709.21</span></span>
    <span><span class="ib-lbl">PDC </span><span class="ib-val">$708.45</span></span>
    <span style="color:#1a1a30;font-size:18px;">│</span>
    <span><span class="ib-lbl">Strikes </span><span class="ib-good">0/2 clear ✓</span></span>
    <span><span class="ib-lbl">Balance </span><span class="ib-good">$1,247.50</span></span>
    <span><span class="ib-lbl">P&amp;L </span><span class="ib-good">+$247.50 +24.7%</span></span>
  </div>

  <div class="monitor-main">

    <!-- LEFT: MONITOR + ANALYSIS FEED -->
    <div class="panel">
      <div class="ph">
        <span class="pt">MARKET MONITOR</span>
        <span class="ps">BULL 3/6 · BEAR 2/6 · DIV+ 1 · 30s poll</span>
      </div>
      <div class="pb">

        <table class="mon-table">
          <thead>
            <tr>
              <th>SYM</th><th>PRICE</th><th>VWAP</th><th>9EMA</th>
              <th>DELTA</th><th>BIAS</th><th>SUPPORT</th><th>RESIST</th>
            </tr>
          </thead>
          <tbody id="mon-tbody">
            <tr>
              <td class="sym">NVDA</td><td class="bull">209.14</td><td class="bull">207.35</td>
              <td class="bull">↑ 208.10</td><td class="bull">+23.7K</td>
              <td><span class="badge bb">BULL</span></td>
              <td class="bull">207.35</td><td class="bear">210.00</td>
            </tr>
            <tr>
              <td class="sym">MSFT</td><td class="bear">421.40</td><td class="bear">423.94</td>
              <td class="bear">↓ 422.80</td><td class="bear">-345</td>
              <td><span class="badge br">BEAR</span></td>
              <td class="bull">419.00</td><td class="bear">423.94</td>
            </tr>
            <tr>
              <td class="sym">AAPL</td><td class="bull">271.20</td><td class="bull">270.91</td>
              <td class="bull">↑ 271.00</td><td class="divp">+308</td>
              <td><span class="badge bp">DIV+</span></td>
              <td class="bull">270.91</td><td class="bear">272.50</td>
            </tr>
            <tr>
              <td class="sym">AMZN</td><td class="bull">264.40</td><td class="bull">261.83</td>
              <td class="bull">↑ 263.10</td><td class="bull">+789</td>
              <td><span class="badge bb">BULL</span></td>
              <td class="bull">261.83</td><td class="bear">265.00</td>
            </tr>
            <tr>
              <td class="sym">META</td><td class="bull">677.77</td><td class="bull">672.22</td>
              <td class="bull">↑ 675.00</td><td class="bull">+100</td>
              <td><span class="badge bb">BULL</span></td>
              <td class="bull">672.22</td><td class="bear">680.00</td>
            </tr>
            <tr>
              <td class="sym">GOOGL</td><td class="bear">341.68</td><td class="bear">341.96</td>
              <td class="bear">↓ 342.10</td><td class="bear">-300</td>
              <td><span class="badge br">BEAR</span></td>
              <td class="bull">340.00</td><td class="bear">341.96</td>
            </tr>
          </tbody>
        </table>

        <!-- SPY BLOCK -->
        <div class="spy-block">
          <div class="spy-header">
            <div>
              <div class="spy-lbl-sm">SPY — LIVE FEED</div>
              <div class="spy-price">714.01</div>
            </div>
            <div class="spy-grid">
              <div class="spy-row"><span class="spy-lbl">VWAP</span><span class="bull">711.99</span></div>
              <div class="spy-row"><span class="spy-lbl">9EMA</span><span class="bull">713.44 ↑</span></div>
              <div class="spy-row"><span class="spy-lbl">$TICK</span><span class="bull">+642 bullish ✓</span></div>
              <div class="spy-row"><span class="spy-lbl">Delta</span><span class="bull">+2.1K buyers</span></div>
              <div class="spy-row"><span class="spy-lbl">Resistance</span><span class="bear">$713.66 +0.08%</span></div>
              <div class="spy-row"><span class="spy-lbl">Support</span><span class="bull">$711.99 -0.28%</span></div>
            </div>
            <div><span class="badge bb" style="font-size:16px;padding:10px 16px;">BULL</span></div>
          </div>
          <div class="spy-row"><span class="spy-lbl">Trend</span><span class="bull">Bullish — above VWAP +$2.02 · 9EMA rising ✓</span></div>
          <div class="spy-row"><span class="spy-lbl">Status</span><span>Mid-range · room to run toward $713.66 resistance</span></div>
          <div class="confluence">⚠ CONFLUENCE ALERT: NVDA S/R within 0.05% — high probability zone</div>
        </div>

        <!-- SIGNAL -->
        <div class="signal-box sig-calls">
          <div class="sig-action bull">TAKE CALLS 🟢</div>
          <div class="sig-conf" style="color:var(--green);">Confidence: HIGH</div>
          <div class="sig-reason">4/6 BULL + SPY bullish + $TICK +642 + 9EMA above VWAP + MOO $2.4B buy-side · W3 confirms 3/4</div>
          <div class="sig-strike">→ SPY $716C 0DTE · ~$0.85 · 1 contract · Time stop: 3 min · Hard stop: -20%</div>
        </div>

        <!-- ANALYSIS FEED -->
        <div class="analysis-feed">
          <div class="af-header">
            <span class="af-title">⬡ HANK LIVE ANALYSIS</span>
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="color:#333;font-size:10px;">30s update</span>
              <div class="af-pulse"></div>
            </div>
          </div>
          <div class="af-body">
            <div class="af-entry af-latest">
              <span class="af-time">10:26:47</span>
              <span class="af-text">
                <span class="af-bull">SPY holding above VWAP $711.99</span>, 9EMA rising at $713.44.
                $TICK +642 confirms broad bullish participation. Approaching
                <span class="af-warn">$713.66 VWAP+1σ resistance</span> — watching for clean break.
                <span class="af-bull">Calls thesis intact.</span>
              </span>
            </div>
            <div class="af-entry">
              <span class="af-time">10:26:17</span>
              <span class="af-text">
                Volume still <span class="af-warn">51% of average</span> — institutional money not
                participating. Trump Iran headline pop not confirmed by delta.
                <span class="af-warn">Fade bias remains ON.</span>
              </span>
            </div>
            <div class="af-entry">
              <span class="af-time">10:25:47</span>
              <span class="af-text">
                NVDA confluence zone flagged — S/R within 0.05%.
                <span class="af-bull">High probability setup</span> on $210 breakout.
                Net score: <span class="af-bull">BULL 3 / BEAR 2 / DIV 1.</span>
              </span>
            </div>
            <div class="af-entry">
              <span class="af-time">10:25:17</span>
              <span class="af-text">
                <span class="af-blue">Trend time window 10:00–10:45 active.</span>
                MOO buy imbalance $2.4B aligned with current bullish bias.
                <span class="af-bull">Conditions favorable for Bullet 2 entry.</span>
              </span>
            </div>
          </div>
        </div>

        <!-- WIN3 -->
        <div class="win3">
          <div class="win3-lbl">WINDOW 3 — SECONDARY CONFIRMATION</div>
          <div class="win3-row">
            <div class="win3-item"><span class="win3-sym">TSLA</span><span class="bull">+1.2%</span><span class="badge bb">BULL</span></div>
            <div class="win3-item"><span class="win3-sym">AVGO</span><span class="bull">+0.8%</span><span class="badge bb">BULL</span></div>
            <div class="win3-item"><span class="win3-sym">JPM</span><span class="bear">-0.3%</span><span class="badge br">BEAR</span></div>
            <div class="win3-item"><span class="win3-sym">QQQ</span><span class="bull">+0.5%</span><span class="badge bb">BULL</span></div>
          </div>
          <div class="win3-conf">✓ W3: 3/4 aligned bullish → HIGH confidence upgrade confirmed</div>
        </div>

      </div>
    </div>

    <!-- RIGHT: ACCOUNT + MOC/MOO -->
    <div class="right-col">

      <!-- ACCOUNT -->
      <div class="panel">
        <div class="ph">
          <span class="pt">ACCOUNT</span>
          <span class="ps">Cash · Paper Trading</span>
        </div>
        <div class="pb">
          <div class="ar"><span class="al">Start Balance</span><span class="av">$1,000.00</span></div>
          <div class="ar"><span class="al">Current</span><span class="av bull">$1,247.50</span></div>
          <div class="ar"><span class="al">Today P&amp;L</span><span class="av bull">+$247.50 · +24.7%</span></div>
          <div class="ar"><span class="al">Contracts</span><span class="av">1 (auto)</span></div>
          <div class="ar"><span class="al">Strikes</span><span class="av bull">0 / 2 clear ✓</span></div>
          <div class="ar"><span class="al">PDT</span><span class="av bull">Cash — OK</span></div>
          <div style="margin-top:12px;font-size:11px;color:var(--dim);letter-spacing:1px;margin-bottom:6px;">BULLETS</div>
          <div class="bullets">
            <div class="blt blt-used">B1 ✓</div>
            <div class="blt blt-avail">B2</div>
            <div class="blt blt-avail">B3</div>
            <div class="blt blt-avail">B4</div>
            <div class="blt blt-avail">MOC</div>
          </div>
          <div class="ov-row">
            <span class="ov-lbl">CONTRACTS:</span>
            <input class="ov-input" type="number" value="1" min="1" max="20">
            <button class="ov-btn">SET</button>
          </div>
        </div>
      </div>

      <!-- MOC/MOO -->
      <div class="panel">
        <div class="ph">
          <span class="pt">MOC / MOO</span>
          <span class="ps">🟢 ±$1B · 🟡 ±$300M</span>
        </div>
        <div class="pb">
          <div class="imb-card imb-green">
            <div class="imb-type" style="color:var(--green);">📊 MOO · 09:25:02 ET</div>
            <div class="imb-row">
              <div class="imb-col">
                <div class="imb-lbl">S&amp;P NET</div>
                <div class="imb-dollar">+$2.4B BUY</div>
              </div>
              <div class="imb-col">
                <div class="imb-lbl">MAG7</div>
                <div class="imb-val bull">+$680M</div>
              </div>
              <div class="imb-col">
                <div class="imb-lbl">INDICES</div>
                <div class="imb-val bull">ALIGNED ✓</div>
              </div>
            </div>
            <div class="imb-signal">🟢 GREEN — TRADEABLE · B1 entered at 09:35</div>
          </div>
          <div class="imb-card imb-yellow">
            <div class="imb-type" style="color:var(--yellow);">📊 MOC · 15:50 ET</div>
            <div class="imb-row">
              <div class="imb-col">
                <div class="imb-lbl">S&amp;P NET</div>
                <div class="imb-dollar">+$650M BUY</div>
              </div>
              <div class="imb-col">
                <div class="imb-lbl">MAG7</div>
                <div class="imb-val divm">+$180M</div>
              </div>
              <div class="imb-col">
                <div class="imb-lbl">INDICES</div>
                <div class="imb-val divm">MIXED ⚠</div>
              </div>
            </div>
            <div class="imb-signal">🟡 CAUTION — Wait for delta confirmation</div>
          </div>
          <div style="margin-top:8px;font-size:12px;color:#333;text-align:center;padding:7px;border:1px solid #111;border-radius:3px;">
            Next MOC window · <span style="color:var(--mid);">15:45 ET</span>
          </div>
        </div>
      </div>

    </div>
  </div><!-- end monitor-main -->
</div><!-- end tab-monitor -->`;

fs.appendFileSync(file, s4);
console.log('S4 done:', s4.length);
