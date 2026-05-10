const fs = require('fs');
const file = 'C:\\Users\\tomav\\tradingview-mcp-jackson\\hank-electron-r2.html';

const s3 = `

<!-- ══════════════════ TAB 1: AUTONOMOUS TRADING ════════════ -->
<div class="tab-panel active" id="tab-auto">

  <!-- INFOBAR -->
  <div class="infobar">
    <span><span class="ib-lbl">ES Gap </span><span class="ib-good" id="auto-gap">+0.33% Up ↑</span></span>
    <span><span class="ib-lbl">P/C </span><span class="ib-good">0.68 bullish</span></span>
    <span><span class="ib-lbl">SPY Vol </span><span class="ib-warn">51% avg ⚠ FADE BIAS ON</span></span>
    <span style="color:#1a1a30;font-size:18px;">│</span>
    <span><span class="ib-lbl">Balance </span><span class="ib-good" id="auto-bal">$1,247.50</span></span>
    <span><span class="ib-lbl">P&amp;L </span><span class="ib-good" id="auto-pnl">+$247.50 +24.7%</span></span>
    <span><span class="ib-lbl">Strikes </span><span class="ib-good">0/2 ✓</span></span>
  </div>

  <!-- INSTRUMENT GRID -->
  <div class="auto-layout">

    <!-- SPY COLUMN -->
    <div class="inst-col">
      <div class="sig-card">
        <div class="sc-sym">SPY</div>
        <div class="sc-price bull" id="spy-price">714.01</div>
        <div class="sc-action sca-calls">⬡ TAKE CALLS</div>
        <div class="sc-conf">
          <span class="conf-hi">HIGH</span>
          <span style="font-size:10px;color:#555;">4/6 BULL</span>
        </div>
        <div class="sc-reason">$TICK +642 · VWAP +$2.02 · 9EMA rising · MOO $2.4B buy · W3 3/4</div>
      </div>
      <div class="mkt-state">
        <div class="mkt-row"><span class="mkt-k">PRICE</span><span class="mkt-v pos">714.01</span></div>
        <div class="mkt-row"><span class="mkt-k">VWAP</span><span class="mkt-v pos">711.99 ↑</span></div>
        <div class="mkt-row"><span class="mkt-k">9EMA</span><span class="mkt-v pos">713.44 ↑</span></div>
        <div class="mkt-row"><span class="mkt-k">$TICK</span><span class="mkt-v pos">+642 bull ✓</span></div>
        <div class="mkt-row"><span class="mkt-k">DELTA</span><span class="mkt-v pos">+2.1K buyers</span></div>
        <div class="mkt-row"><span class="mkt-k">RESIST</span><span class="mkt-v neg">$713.66 +0.08%</span></div>
        <div class="mkt-row"><span class="mkt-k">SUPPORT</span><span class="mkt-v pos">$711.99 -0.28%</span></div>
        <div class="mkt-row"><span class="mkt-k">PDH</span><span class="mkt-v neg">$714.47</span></div>
        <div class="mkt-row"><span class="mkt-k">PDL</span><span class="mkt-v pos">$709.21</span></div>
        <div class="mkt-row"><span class="mkt-k">VOL</span><span class="mkt-v neu">51% avg ⚠</span></div>
        <div class="mkt-row"><span class="mkt-k">IV RANK</span><span class="mkt-v neu">38 — cheap</span></div>
        <div class="mkt-row"><span class="mkt-k">SESSION</span><span class="mkt-v pos">TREND TIME</span></div>
      </div>
      <div class="trade-card">
        <div class="tc-hdr">ACTIVE POSITION</div>
        <div class="tc-pos">
          <div class="tct">B1 — SPY $716C 0DTE</div>
          <div>Entry $0.85 · 1 contract · 09:38 ET</div>
          <div class="tc-pnl-p">+$42.50 · +50% · Time stop 3min</div>
        </div>
      </div>
    </div>

    <!-- IWM COLUMN -->
    <div class="inst-col">
      <div class="sig-card">
        <div class="sc-sym">IWM</div>
        <div class="sc-price bull">198.44</div>
        <div class="sc-action sca-calls">⬡ CALLS — B2 READY</div>
        <div class="sc-conf">
          <span class="conf-md">MEDIUM</span>
          <span style="font-size:10px;color:#555;">3/5 BULL</span>
        </div>
        <div class="sc-reason">VWAP +$0.88 · 9EMA rising · TICK +380 · Vol 48% low</div>
      </div>
      <div class="mkt-state">
        <div class="mkt-row"><span class="mkt-k">PRICE</span><span class="mkt-v pos">198.44</span></div>
        <div class="mkt-row"><span class="mkt-k">VWAP</span><span class="mkt-v pos">197.56 ↑</span></div>
        <div class="mkt-row"><span class="mkt-k">9EMA</span><span class="mkt-v pos">198.10 ↑</span></div>
        <div class="mkt-row"><span class="mkt-k">$TICK</span><span class="mkt-v pos">+380</span></div>
        <div class="mkt-row"><span class="mkt-k">DELTA</span><span class="mkt-v pos">+890 buyers</span></div>
        <div class="mkt-row"><span class="mkt-k">RESIST</span><span class="mkt-v neg">$199.00</span></div>
        <div class="mkt-row"><span class="mkt-k">SUPPORT</span><span class="mkt-v pos">$197.56</span></div>
        <div class="mkt-row"><span class="mkt-k">PDH</span><span class="mkt-v neg">$199.22</span></div>
        <div class="mkt-row"><span class="mkt-k">PDL</span><span class="mkt-v pos">$196.14</span></div>
        <div class="mkt-row"><span class="mkt-k">VOL</span><span class="mkt-v neg">48% avg ⚠</span></div>
        <div class="mkt-row"><span class="mkt-k">IV RANK</span><span class="mkt-v pos">29 — cheap</span></div>
        <div class="mkt-row"><span class="mkt-k">SIGNAL</span><span class="mkt-v pos">B2 PENDING</span></div>
      </div>
      <div class="trade-card">
        <div class="tc-hdr">ACTIVE POSITION</div>
        <div class="tc-none">No IWM position · B2 ready on breakout</div>
      </div>
    </div>

    <!-- QQQ COLUMN -->
    <div class="inst-col">
      <div class="sig-card">
        <div class="sc-sym">QQQ</div>
        <div class="sc-price bull">484.20</div>
        <div class="sc-action sca-wait">⚠ WAIT — VWAP TEST</div>
        <div class="sc-conf">
          <span class="conf-wk">WEAK</span>
          <span style="font-size:10px;color:#555;">2/5 BULL</span>
        </div>
        <div class="sc-reason">VWAP -$0.22 choppy · NQ lagging ES · fade risk</div>
      </div>
      <div class="mkt-state">
        <div class="mkt-row"><span class="mkt-k">PRICE</span><span class="mkt-v neg">484.20</span></div>
        <div class="mkt-row"><span class="mkt-k">VWAP</span><span class="mkt-v neg">484.42 ↓</span></div>
        <div class="mkt-row"><span class="mkt-k">9EMA</span><span class="mkt-v neg">484.80 ↓</span></div>
        <div class="mkt-row"><span class="mkt-k">$TICK</span><span class="mkt-v pos">+280 weak</span></div>
        <div class="mkt-row"><span class="mkt-k">DELTA</span><span class="mkt-v neg">-340 mixed</span></div>
        <div class="mkt-row"><span class="mkt-k">RESIST</span><span class="mkt-v neg">$485.00</span></div>
        <div class="mkt-row"><span class="mkt-k">SUPPORT</span><span class="mkt-v pos">$483.20</span></div>
        <div class="mkt-row"><span class="mkt-k">PDH</span><span class="mkt-v neg">$486.10</span></div>
        <div class="mkt-row"><span class="mkt-k">PDL</span><span class="mkt-v pos">$481.33</span></div>
        <div class="mkt-row"><span class="mkt-k">VOL</span><span class="mkt-v neg">45% avg ⚠</span></div>
        <div class="mkt-row"><span class="mkt-k">STATUS</span><span class="mkt-v neu">SKIP · NQ lag</span></div>
      </div>
      <div class="trade-card">
        <div class="tc-hdr">ACTIVE POSITION</div>
        <div class="tc-none">No QQQ position · skip signal today</div>
      </div>
    </div>

    <!-- ANALYSIS COLUMN -->
    <div class="inst-col analysis-col">
      <div class="ac-header">
        <span class="ac-title">⬡ HANK LIVE ANALYSIS</span>
        <span class="ac-time" id="ac-time">30s update</span>
      </div>

      <!-- MASTER SIGNAL BOX -->
      <div style="padding:10px 12px;border-bottom:1px solid #111;flex-shrink:0;">
        <div style="font-size:10px;color:#555;letter-spacing:2px;margin-bottom:5px;">MASTER SIGNAL</div>
        <div class="master-sig ms-calls" style="font-size:16px;padding:8px 14px;margin-bottom:6px;">
          ⬡ TAKE CALLS — HIGH
        </div>
        <div style="font-size:11px;color:#aaa;line-height:1.6;">
          SPY thesis: 4/6 BULL + TICK +642 + VWAP +$2.02 + MOO $2.4B buy-side + W3 3/4.
          <span style="color:var(--yellow);">Vol 51% — fade bias on headline pops.</span>
          Entry: SPY $716C 0DTE · $0.85 · 1 contract.
        </div>
      </div>

      <div class="ac-body" id="hank-feed">
        <div class="ac-para">
          <span class="pdot"></span>
          <span class="hl-bull">SPY holding above VWAP $711.99</span>, 9EMA rising at $713.44.
          $TICK +642 confirms broad bullish participation.
          Approaching <span class="hl-warn">$713.66 VWAP+1σ resistance</span> — watching for clean break or rejection.
          <span class="hl-bull">Calls thesis intact.</span>
        </div>
        <div class="ac-entry">
          <div class="ae-row"><span class="ae-lbl">ENTRY</span><span class="ae-val">SPY $716C 0DTE @ $0.85</span></div>
          <div class="ae-row"><span class="ae-lbl">TARGET</span><span class="ae-val">+30–50% → $1.10–$1.27</span></div>
          <div class="ae-row"><span class="ae-lbl">STOP</span><span class="ae-val r">TICK &lt;+200 OR SPY &lt;$711.99</span></div>
          <div class="ae-row"><span class="ae-lbl">TIME STOP</span><span class="ae-val r">3 min hard · exit by 11:45</span></div>
        </div>
        <div class="ac-para" style="margin-top:8px;">
          Volume still <span class="hl-warn">51% of average</span> — institutional money not
          participating. Trump Iran headline pop not confirmed by delta.
          <span class="hl-warn">Fade bias remains ON.</span> Any pop above $714.47 PDH
          on thin volume = fade candidate.
        </div>
        <div class="ac-para">
          NVDA confluence zone flagged — S/R within 0.05%.
          <span class="hl-bull">High probability setup</span> if breaks $210 cleanly.
          MSFT bearish divergence — selling into VWAP.
          Net score: <span class="hl-bull">BULL 3 / BEAR 2 / DIV 1.</span>
        </div>
        <div class="ac-para">
          <span style="color:var(--blue);">Trend time window 10:00–10:45 active.</span>
          Market making directional decision. MOO buy imbalance $2.4B
          aligned with current bullish bias. W3 secondary confirms 3/4.
          <span class="hl-bull">Conditions favorable for Bullet 2 entry.</span>
        </div>
      </div>

      <!-- AUTO TRADE CONTROLS -->
      <div style="padding:10px 12px;border-top:1px solid #111;flex-shrink:0;background:var(--bg3);">
        <div style="font-size:10px;color:#333;letter-spacing:2px;margin-bottom:7px;">AUTO-TRADE ENGINE</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;">
          <select style="background:var(--bg2);border:1px solid #1a1a2a;color:#ccc;padding:5px 8px;font-family:var(--mono);font-size:10px;outline:none;" id="auto-conf">
            <option>HIGH conf only</option>
            <option>MEDIUM+</option>
            <option>SPY+W3 override</option>
          </select>
          <select style="background:var(--bg2);border:1px solid #1a1a2a;color:#ccc;padding:5px 8px;font-family:var(--mono);font-size:10px;outline:none;" id="auto-syms">
            <option>SPY only</option>
            <option>SPY + IWM</option>
            <option>All monitored</option>
          </select>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="auto-arm-btn" id="armBtn" onclick="toggleAutoArm()" style="flex:1;text-align:center;">
            ⬡ ARM AUTO-TRADE
          </button>
          <button class="halt-btn" onclick="haltAll()" style="margin-left:0;">⚠ HALT</button>
        </div>
        <div style="margin-top:6px;font-size:10px;color:#2a2a3a;text-align:center;letter-spacing:1px;" id="auto-status-mini">
          OFF · Manual confirmation required
        </div>
      </div>
    </div>

  </div><!-- end auto-layout -->

  <!-- BOTTOM BAR -->
  <div class="auto-bottom">
    <div class="master-sig ms-calls">⬡ TAKE CALLS — HIGH</div>
    <div class="bottom-stat">
      <span class="bs-lbl">BALANCE</span>
      <span class="bs-val bull" id="ab-bal">$1,247.50</span>
    </div>
    <div class="bottom-stat">
      <span class="bs-lbl">TODAY P&amp;L</span>
      <span class="bs-val bull" id="ab-pnl">+$247.50</span>
    </div>
    <div class="bottom-stat">
      <span class="bs-lbl">BULLETS</span>
      <span class="bs-val" id="ab-bullets">B1✓ B2 B3 B4 MOC</span>
    </div>
    <div class="bottom-stat">
      <span class="bs-lbl">STRIKES</span>
      <span class="bs-val bull">0 / 2 clear ✓</span>
    </div>
    <div class="bottom-stat">
      <span class="bs-lbl">SESSION</span>
      <span class="bs-val" style="color:var(--blue);" id="ab-sess">TREND TIME</span>
    </div>
  </div>

</div><!-- end tab-auto -->`;

fs.appendFileSync(file, s3);
console.log('S3 done:', s3.length);
