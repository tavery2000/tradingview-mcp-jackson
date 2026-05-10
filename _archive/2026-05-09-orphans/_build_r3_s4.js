const fs = require('fs');
const file = 'C:\\Users\\tomav\\tradingview-mcp-jackson\\hank-electron-r3.html';

// Option B standalone panel — 7-strike ladder, SPY/QQQ/IWM tabs, 0DTE/1DTE
function optBPanel() {
  // SPY calls ladder, centered on $714 ATM, HANK pick at $715 OTM
  const strikes = [718, 717, 716, 715, 714, 713, 712];
  const hankIdx = 3; // $715
  const rows = strikes.map((s, i) => {
    const dist = Math.abs(s - 714);
    const prem = Math.max(0.02, (714 * 0.004 * Math.exp(-dist / 714 * 10))).toFixed(2);
    const bid  = (parseFloat(prem) - 0.01).toFixed(2);
    const ask  = (parseFloat(prem) + 0.01).toFixed(2);
    const delta = Math.max(0.05, Math.min(0.90, (0.5 - (s - 714) / 20))).toFixed(2);
    const iv  = (30 + dist * 0.8).toFixed(0) + '%';
    const oi  = Math.round(8000 * Math.exp(-dist * 0.3) / 1000).toFixed(1) + 'K';
    const isHank = i === hankIdx;
    const cls = isHank ? 'opt-b-pick' : '';
    const badge = isHank ? '<span style="font-size:13px;color:#1a3a1a;margin-right:3px;">⬡</span>' : '';
    return `<tr class="${cls}">
      <td>${badge}$${s}</td>
      <td>$${bid}</td><td>$${ask}</td><td>$${prem}</td>
      <td>${delta}</td><td>${iv}</td><td>${oi}</td>
    </tr>`;
  }).join('');
  return rows;
}

const s4 = `

<!-- ══════════════════ TAB 2: MONITOR ═══════════════════════ -->
<div class="tab-panel" id="tab-monitor">

  <!-- INFOBAR -->
  <div class="infobar">
    <span><span class="ib-lbl">ES Gap </span><span class="ib-good">+0.33% ↑</span></span>
    <span><span class="ib-lbl">P/C </span><span class="ib-good">0.68 bull</span></span>
    <span><span class="ib-lbl">SPY Vol </span><span class="ib-warn">51% ⚠ FADE BIAS ON</span></span>
    <span style="color:#1a1a30;font-size:18px;">│</span>
    <span><span class="ib-lbl">PDH </span><span class="bear">$714.47</span></span>
    <span><span class="ib-lbl">PDL </span><span class="bull">$709.21</span></span>
    <span><span class="ib-lbl">PDC </span><span class="ib-val">$708.45</span></span>
    <span style="color:#1a1a30;font-size:18px;">│</span>
    <span><span class="ib-lbl">Balance </span><span class="ib-good">$1,247.50</span></span>
    <span><span class="ib-lbl">P&amp;L </span><span class="ib-good">+$247.50 +24.7%</span></span>
  </div>

  <div class="monitor-main">

    <!-- LEFT: MONITOR TABLE + SPY BLOCK + SIGNAL + FEED + WIN3 -->
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
              <td class="bear">↓ 422.80</td><td class="bear">−345</td>
              <td><span class="badge br">BEAR</span></td>
              <td class="bull">419.00</td><td class="bear">423.94</td>
            </tr>
            <tr>
              <td class="sym">AAPL</td><td class="bull">271.20</td><td class="bull">270.91</td>
              <td class="bull">↑ 271.00</td><td class="divm">+308</td>
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
              <td class="bear">↓ 342.10</td><td class="bear">−300</td>
              <td><span class="badge br">BEAR</span></td>
              <td class="bull">340.00</td><td class="bear">341.96</td>
            </tr>
          </tbody>
        </table>

        <!-- SPY BLOCK -->
        <div class="spy-block">
          <div class="spy-header">
            <div>
              <div class="spy-lbl-sm">SPY — LIVE</div>
              <div class="spy-price">714.01</div>
            </div>
            <div class="spy-grid">
              <div class="spy-row"><span class="spy-lbl">VWAP</span><span class="bull">711.99</span></div>
              <div class="spy-row"><span class="spy-lbl">9EMA</span><span class="bull">713.44 ↑</span></div>
              <div class="spy-row"><span class="spy-lbl">$TICK</span><span class="bull">+642 bull ✓</span></div>
              <div class="spy-row"><span class="spy-lbl">Delta</span><span class="bull">+2.1K buyers</span></div>
              <div class="spy-row"><span class="spy-lbl">Resist</span><span class="bear">$714.47 PDH</span></div>
              <div class="spy-row"><span class="spy-lbl">Support</span><span class="bull">$711.99 VWAP</span></div>
            </div>
            <div><span class="badge bb" style="font-size:18px;padding:10px 16px;">BULL</span></div>
          </div>
          <div class="spy-row"><span class="spy-lbl">Trend</span><span class="bull">Bullish — above VWAP +$2.02 · 9EMA rising ✓</span></div>
          <div class="confluence">⚠ CONFLUENCE ALERT: NVDA S/R within 0.05% — high probability zone</div>
        </div>

        <!-- SIGNAL -->
        <div class="signal-box sig-calls">
          <div class="sig-action bull">TAKE CALLS 🟢</div>
          <div class="sig-conf" style="color:var(--green);">Confidence: HIGH</div>
          <div class="sig-reason">4/6 BULL + SPY bull + $TICK +642 + 9EMA above VWAP + MOO $2.4B + W3 3/4</div>
          <div class="sig-strike">→ SPY $715C 0DTE · ~$1.42 · 1 contract · Time stop: 3 min · Hard stop: −20%</div>
        </div>

        <!-- ANALYSIS FEED -->
        <div class="analysis-feed">
          <div class="af-header">
            <span class="af-title">⬡ HANK LIVE ANALYSIS</span>
            <div style="display:flex;align-items:center;gap:7px;">
              <span style="color:#333;font-size:13px;">30s update</span>
              <div class="af-pulse"></div>
            </div>
          </div>
          <div class="af-body">
            <div class="af-entry af-latest">
              <span class="af-time">10:26:47</span>
              <span class="af-text">
                <span class="af-bull">SPY holding above VWAP $711.99</span>, 9EMA rising at $713.44.
                $TICK +642 confirms bullish participation. Approaching
                <span class="af-warn">$714.47 PDH resistance</span> — watching for break.
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
                <span class="af-bull">High probability breakout setup</span> above $210.
                Net score: <span class="af-bull">BULL 3 / BEAR 2 / DIV 1.</span>
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
            <div class="win3-item"><span class="win3-sym">JPM</span><span class="bear">−0.3%</span><span class="badge br">BEAR</span></div>
            <div class="win3-item"><span class="win3-sym">QQQ</span><span class="bull">+0.5%</span><span class="badge bb">BULL</span></div>
          </div>
          <div class="win3-conf">✓ W3: 3/4 aligned bullish → HIGH confidence upgrade confirmed</div>
        </div>

      </div>
    </div>

    <!-- RIGHT: ACCOUNT + OPTION B OPTIONS PANEL -->
    <div class="right-col">

      <!-- ACCOUNT -->
      <div class="panel">
        <div class="ph">
          <span class="pt">ACCOUNT</span>
          <span class="ps">Cash · Paper</span>
        </div>
        <div class="pb">
          <div class="ar"><span class="al">Start Balance</span><span class="av">$1,000.00</span></div>
          <div class="ar"><span class="al">Current</span><span class="av bull">$1,247.50</span></div>
          <div class="ar"><span class="al">Today P&amp;L</span><span class="av bull">+$247.50 · +24.7%</span></div>
          <div class="ar"><span class="al">Contracts</span><span class="av">1 (auto)</span></div>
          <div class="ar"><span class="al">PDT Status</span><span class="av bull">Cash — OK</span></div>
          <div class="ov-row" style="display:flex;gap:8px;align-items:center;margin-top:12px;">
            <span style="font-size:13px;color:#333;letter-spacing:1px;">CONTRACTS:</span>
            <input style="background:var(--bg2);border:1px solid #1a1a2a;color:#ccc;padding:5px 8px;font-family:var(--mono);font-size:14px;width:60px;outline:none;" type="number" value="1" min="1" max="20" id="contractCount">
            <button style="padding:5px 12px;background:#050f07;border:1px solid #1a3a1a;color:var(--green);font-family:var(--mono);font-size:13px;cursor:pointer;">SET</button>
          </div>
        </div>
      </div>

      <!-- OPTION B: OPTIONS CHAIN PANEL -->
      <div class="panel" style="flex:1;min-height:0;">
        <div class="ph">
          <span class="pt">OPTIONS CHAIN</span>
          <span class="ps">Yahoo · 60s · ⬡ = HANK pick</span>
        </div>
        <div class="pb" style="overflow-y:auto;">

          <!-- Signal banner -->
          <div class="opt-b-banner" id="opt-b-banner">
            <div class="ob-action bull">⬡ TAKE CALLS</div>
            <div class="ob-pick" id="opt-b-pick">SPY $715C 0DTE · ~$1.42 · Δ 0.41 · IV 32%</div>
          </div>

          <!-- Sym + Expiry tabs -->
          <div class="opt-b-tabs">
            <span class="ob-sym active" onclick="setOptBSym('SPY',this)">SPY</span>
            <span class="ob-sym" onclick="setOptBSym('QQQ',this)">QQQ</span>
            <span class="ob-sym" onclick="setOptBSym('IWM',this)">IWM</span>
            <div style="flex:1;"></div>
            <span class="ob-exp active" onclick="setOptBExp('0DTE',this)">0DTE</span>
            <span class="ob-exp" onclick="setOptBExp('1DTE',this)">1DTE</span>
          </div>

          <!-- Strike ladder -->
          <table class="opt-b-ladder">
            <thead>
              <tr>
                <th style="text-align:left;">STRIKE</th>
                <th>BID</th><th>ASK</th><th>MID</th>
                <th>Δ</th><th>IV</th><th>OI</th>
              </tr>
            </thead>
            <tbody id="opt-b-tbody">
              ${optBPanel()}
            </tbody>
          </table>

          <!-- Execute button -->
          <button class="opt-b-exec" id="opt-b-exec" onclick="execOptB()">
            ▶ EXECUTE HANK PICK — $715C 0DTE
          </button>

          <div style="font-size:13px;color:#1a1a3a;text-align:center;padding:6px;">
            📋 PAPER TRADE · Yahoo Finance data · Updates every 60s
          </div>
        </div>
      </div>

    </div><!-- end right-col -->
  </div><!-- end monitor-main -->
</div><!-- end tab-monitor -->`;

fs.appendFileSync(file, s4);
console.log('S4 done:', s4.length);
