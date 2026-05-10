const fs = require('fs');
const file = 'C:\\Users\\tomav\\tradingview-mcp-jackson\\hank-electron-r3.html';

// Helper: Option C mini options chain card for each instrument
// side: 'calls'|'puts'|'wait', atm: ATM strike, step: strike step
function miniChain(sym, side, atm, step, id) {
  const strikes = [];
  for (let i = -2; i <= 2; i++) strikes.push((atm + i * step).toFixed(1));
  const hankIdx = side === 'calls' ? 3 : side === 'puts' ? 1 : -1; // pick OTM for calls, ITM for puts

  const rows = strikes.map((s, i) => {
    const dist = Math.abs(parseFloat(s) - atm);
    const prem = Math.max(0.04, (atm * 0.004 * Math.exp(-dist / atm * 10))).toFixed(2);
    const delta = (0.5 - (parseFloat(s) - atm) / (atm * 0.03)).toFixed(2);
    const isHank = (i === hankIdx && side !== 'wait');
    const cls = isHank ? 'om-hank-pick' : (side === 'wait' ? 'om-wait-row' : '');
    const symBadge = isHank ? `<span style="color:#1a3a1a;font-size:11px;">⬡</span> ` : '';
    return `<tr class="${cls}"><td>${symBadge}$${s}</td><td>${prem}</td><td>${Math.max(0.05,Math.min(0.95,parseFloat(delta))).toFixed(2)}</td></tr>`;
  }).join('');

  const execLabel = side === 'calls' ? `▶ EXECUTE $${strikes[hankIdx]}C 0DTE` :
                    side === 'puts'  ? `▶ EXECUTE $${strikes[hankIdx]}P 0DTE` :
                    '— WAIT — NO SIGNAL';
  const execCls = side === 'calls' ? '' : side === 'puts' ? 'puts' : 'wait';

  return `
      <!-- OPTION C MINI CHAIN -->
      <div class="opt-mini">
        <div class="opt-mini-title">
          <span style="color:#333;font-size:13px;letter-spacing:2px;">OPTIONS</span>
          <div class="opt-mini-tabs">
            <button class="om-tab active" onclick="setOptTab(this,'0DTE','${id}')">0DTE</button>
            <button class="om-tab" onclick="setOptTab(this,'1DTE','${id}')">1DTE</button>
            <span class="om-refresh">⟳ 60s</span>
          </div>
        </div>
        <table class="om-table">
          <thead><tr><th>STRIKE</th><th>MID</th><th>Δ</th></tr></thead>
          <tbody id="${id}-rows">${rows}</tbody>
        </table>
        <button class="om-exec-btn ${execCls}" onclick="handleMiniExec('${sym}','${side}','${side !== 'wait' ? strikes[hankIdx] : ''}')">
          ${execLabel}
        </button>
      </div>`;
}

const spyChain  = miniChain('SPY',  'calls', 714, 1,   'spy-opt');
const qqqChain  = miniChain('QQQ',  'wait',  484, 1,   'qqq-opt');
const iwmChain  = miniChain('IWM',  'calls', 198, 0.5, 'iwm-opt');

const s3 = `

<!-- ══════════════════ TAB 1: AUTONOMOUS ════════════════════ -->
<div class="tab-panel active" id="tab-auto">

  <!-- INFOBAR -->
  <div class="infobar">
    <span><span class="ib-lbl">ES Gap </span><span class="ib-good" id="auto-gap">+0.33% ↑</span></span>
    <span><span class="ib-lbl">P/C </span><span class="ib-good">0.68 bull</span></span>
    <span><span class="ib-lbl">SPY Vol </span><span class="ib-warn">51% ⚠ FADE ON</span></span>
    <span style="color:#1a1a30;font-size:18px;">│</span>
    <span><span class="ib-lbl">Balance </span><span class="ib-good" id="auto-bal">$1,247.50</span></span>
    <span><span class="ib-lbl">P&amp;L </span><span class="ib-good" id="auto-pnl">+$247.50 +24.7%</span></span>
    <span style="color:#1a1a30;font-size:18px;">│</span>
    <span><span class="ib-lbl">PDH </span><span class="bear">$714.47</span></span>
    <span><span class="ib-lbl">PDL </span><span class="bull">$709.21</span></span>
  </div>

  <!-- INSTRUMENT GRID: 3 columns + analysis -->
  <div class="auto-layout">

    <!-- ── SPY COLUMN (monitor.js) ──────────────────────────── -->
    <div class="inst-col" id="spy-col">
      <div class="sig-card">
        <div class="sc-sym">SPY</div>
        <div class="sc-price bull" id="spy-price">714.01</div>
        <div class="sc-action sca-calls">⬡ TAKE CALLS</div>
        <div class="sc-conf">
          <span class="conf-hi">HIGH</span>
          <span style="font-size:13px;color:#555;">4/6 BULL</span>
        </div>
        <div class="sc-reason">$TICK +642 · VWAP +$2.02 · 9EMA rising · MOO $2.4B · W3 3/4</div>
      </div>

      <div class="mkt-state">
        <div class="mkt-row"><span class="mkt-k">PRICE</span><span class="mkt-v pos">714.01</span></div>
        <div class="mkt-row"><span class="mkt-k">VWAP</span><span class="mkt-v pos">711.99 ↑</span></div>
        <div class="mkt-row"><span class="mkt-k">9EMA</span><span class="mkt-v pos">713.44 ↑</span></div>
        <div class="mkt-row"><span class="mkt-k">$TICK</span><span class="mkt-v pos">+642 bull ✓</span></div>
        <div class="mkt-row"><span class="mkt-k">DELTA</span><span class="mkt-v pos">+2.1K buyers</span></div>
        <div class="mkt-row"><span class="mkt-k">RESIST</span><span class="mkt-v neg">$714.47 PDH</span></div>
        <div class="mkt-row"><span class="mkt-k">SUPPORT</span><span class="mkt-v pos">$711.99 VWAP</span></div>
        <div class="mkt-row"><span class="mkt-k">VOL</span><span class="mkt-v neu">51% avg ⚠</span></div>
        <div class="mkt-row"><span class="mkt-k">IV RANK</span><span class="mkt-v pos">38 — cheap</span></div>
        <div class="mkt-row"><span class="mkt-k">SOURCE</span><span class="mkt-v" style="color:#333;font-size:13px;">monitor.js</span></div>
      </div>

      ${spyChain}
    </div>

    <!-- ── QQQ COLUMN (monitor-qqq.js) ─────────────────────── -->
    <div class="inst-col" id="qqq-col">
      <div class="sig-card">
        <div class="sc-sym">QQQ</div>
        <div class="sc-price" style="color:var(--yellow);" id="qqq-price">484.20</div>
        <div class="sc-action sca-wait">⚠ WAIT — VWAP TEST</div>
        <div class="sc-conf">
          <span class="conf-wk">WEAK</span>
          <span style="font-size:13px;color:#555;">2/5 BULL</span>
        </div>
        <div class="sc-reason">VWAP −$0.22 choppy · NQ lagging ES · delta mixed · fade risk</div>
      </div>

      <div class="mkt-state">
        <div class="mkt-row"><span class="mkt-k">PRICE</span><span class="mkt-v neg">484.20</span></div>
        <div class="mkt-row"><span class="mkt-k">VWAP</span><span class="mkt-v neg">484.42 ↓</span></div>
        <div class="mkt-row"><span class="mkt-k">9EMA</span><span class="mkt-v neg">484.80 ↓</span></div>
        <div class="mkt-row"><span class="mkt-k">$TICK</span><span class="mkt-v neu">+280 weak</span></div>
        <div class="mkt-row"><span class="mkt-k">DELTA</span><span class="mkt-v neg">−340 mixed</span></div>
        <div class="mkt-row"><span class="mkt-k">RESIST</span><span class="mkt-v neg">$485.00</span></div>
        <div class="mkt-row"><span class="mkt-k">SUPPORT</span><span class="mkt-v pos">$483.20</span></div>
        <div class="mkt-row"><span class="mkt-k">VOL</span><span class="mkt-v neg">45% avg ⚠</span></div>
        <div class="mkt-row"><span class="mkt-k">IV RANK</span><span class="mkt-v neu">44 — mid</span></div>
        <div class="mkt-row"><span class="mkt-k">SOURCE</span><span class="mkt-v" style="color:#333;font-size:13px;">monitor-qqq.js</span></div>
      </div>

      ${qqqChain}
    </div>

    <!-- ── IWM COLUMN (monitor-iwm.js) ─────────────────────── -->
    <div class="inst-col" id="iwm-col">
      <div class="sig-card">
        <div class="sc-sym">IWM</div>
        <div class="sc-price bull" id="iwm-price">198.44</div>
        <div class="sc-action sca-calls">⬡ CALLS — B2 READY</div>
        <div class="sc-conf">
          <span class="conf-md">MEDIUM</span>
          <span style="font-size:13px;color:#555;">3/5 BULL</span>
        </div>
        <div class="sc-reason">VWAP +$0.88 · 9EMA rising · TICK +380 · small-cap aligned</div>
      </div>

      <div class="mkt-state">
        <div class="mkt-row"><span class="mkt-k">PRICE</span><span class="mkt-v pos">198.44</span></div>
        <div class="mkt-row"><span class="mkt-k">VWAP</span><span class="mkt-v pos">197.56 ↑</span></div>
        <div class="mkt-row"><span class="mkt-k">9EMA</span><span class="mkt-v pos">198.10 ↑</span></div>
        <div class="mkt-row"><span class="mkt-k">$TICK</span><span class="mkt-v pos">+380</span></div>
        <div class="mkt-row"><span class="mkt-k">DELTA</span><span class="mkt-v pos">+890 buyers</span></div>
        <div class="mkt-row"><span class="mkt-k">RESIST</span><span class="mkt-v neg">$199.00 PDH</span></div>
        <div class="mkt-row"><span class="mkt-k">SUPPORT</span><span class="mkt-v pos">$197.56 VWAP</span></div>
        <div class="mkt-row"><span class="mkt-k">VOL</span><span class="mkt-v neg">48% avg ⚠</span></div>
        <div class="mkt-row"><span class="mkt-k">IV RANK</span><span class="mkt-v pos">29 — cheap</span></div>
        <div class="mkt-row"><span class="mkt-k">SOURCE</span><span class="mkt-v" style="color:#333;font-size:13px;">monitor-iwm.js</span></div>
      </div>

      ${iwmChain}
    </div>

    <!-- ── ANALYSIS COLUMN ──────────────────────────────────── -->
    <div class="analysis-col">
      <div class="ac-header">
        <span class="ac-title">⬡ HANK LIVE ANALYSIS</span>
        <span class="ac-time" id="ac-time">30s update</span>
      </div>

      <!-- MASTER SIGNAL -->
      <div style="padding:12px 14px;border-bottom:1px solid #111;flex-shrink:0;">
        <div style="font-size:13px;color:#555;letter-spacing:2px;margin-bottom:7px;">MASTER SIGNAL</div>
        <div class="master-sig ms-calls" id="master-sig">⬡ TAKE CALLS — HIGH</div>
        <div style="font-size:14px;color:#aaa;line-height:1.7;">
          SPY thesis: 4/6 BULL + TICK +642 + VWAP +$2.02 + MOO $2.4B + W3 3/4.
          <span style="color:var(--yellow);">Vol 51% — fade bias on headline pops.</span>
        </div>
      </div>

      <div class="ac-body" id="hank-feed">
        <div class="ac-para">
          <span class="pdot"></span>
          <span class="hl-bull">SPY holding above VWAP $711.99</span>, 9EMA rising at $713.44.
          $TICK +642 confirms broad bullish participation. Approaching
          <span class="hl-warn">$714.47 PDH resistance</span> — watching for clean break.
          <span class="hl-bull">Calls thesis intact.</span>
        </div>
        <div class="ac-entry">
          <div class="ae-row"><span class="ae-lbl">ENTRY</span><span class="ae-val">SPY $715C 0DTE @ ~$1.42</span></div>
          <div class="ae-row"><span class="ae-lbl">TARGET</span><span class="ae-val">+30–50% → $1.84–$2.13</span></div>
          <div class="ae-row"><span class="ae-lbl">STOP</span><span class="ae-val r">TICK &lt;+200 OR SPY &lt;$711.99</span></div>
          <div class="ae-row"><span class="ae-lbl">TIME STOP</span><span class="ae-val r">3 min hard</span></div>
        </div>
        <div class="ac-para">
          Volume still <span class="hl-warn">51% of average</span> — institutional money not participating.
          <span class="hl-warn">Fade bias ON.</span> Any pop above $714.47 PDH on thin volume = fade candidate.
        </div>
        <div class="ac-para">
          IWM above VWAP, 9EMA rising — secondary confirmation for call bias.
          QQQ lagging — NQ divergence noted. Weight SPY and IWM signals over QQQ today.
          <span class="hl-bull">Net: CALLS with discipline.</span>
        </div>
        <div class="ac-para">
          <span style="color:var(--blue);">Trend time window 10:00–10:45 active.</span>
          W3 secondary confirms 3/4. <span class="hl-bull">Conditions favorable.</span>
        </div>
      </div>

      <!-- AUTO-TRADE CONTROLS -->
      <div style="padding:12px 14px;border-top:1px solid #111;flex-shrink:0;background:var(--bg3);">
        <div style="font-size:13px;color:#333;letter-spacing:2px;margin-bottom:9px;">AUTO-TRADE ENGINE</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:8px;">
          <select style="background:var(--bg2);border:1px solid #1a1a2a;color:#ccc;padding:7px 10px;font-family:var(--mono);font-size:14px;outline:none;" id="auto-conf">
            <option>HIGH conf only</option>
            <option>MEDIUM+</option>
            <option>SPY+W3 override</option>
          </select>
          <select style="background:var(--bg2);border:1px solid #1a1a2a;color:#ccc;padding:7px 10px;font-family:var(--mono);font-size:14px;outline:none;" id="auto-syms">
            <option>SPY only</option>
            <option>SPY + IWM</option>
            <option>All monitored</option>
          </select>
        </div>
        <div style="display:flex;gap:7px;">
          <button class="auto-arm-btn" id="armBtn" onclick="toggleAutoArm()" style="flex:1;">
            ⬡ ARM AUTO-TRADE
          </button>
          <button class="halt-btn" onclick="haltAll()">⚠ HALT</button>
        </div>
        <div style="margin-top:7px;font-size:13px;color:#2a2a3a;text-align:center;letter-spacing:1px;" id="auto-status-mini">
          OFF · Manual confirmation required
        </div>
      </div>
    </div>

  </div><!-- end auto-layout -->

  <!-- BOTTOM BAR -->
  <div class="auto-bottom">
    <div class="master-sig ms-calls" style="font-size:16px;padding:6px 14px;margin-bottom:0;">⬡ TAKE CALLS — HIGH</div>
    <div class="bottom-stat">
      <span class="bs-lbl">BALANCE</span>
      <span class="bs-val bull" id="ab-bal">$1,247.50</span>
    </div>
    <div class="bottom-stat">
      <span class="bs-lbl">TODAY P&amp;L</span>
      <span class="bs-val bull" id="ab-pnl">+$247.50</span>
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
