const fs = require('fs');
const file = 'C:\\Users\\tomav\\tradingview-mcp-jackson\\hank-electron-r2.html';

const s5 = `

<!-- ══════════════════ TAB 3: INTELLIGENCE (Screen 2) ═══════ -->
<div class="tab-panel" id="tab-intel">

  <!-- INFOBAR -->
  <div class="infobar">
    <span><span class="ib-lbl">ES Gap </span><span class="ib-good">+0.33% Up ↑</span></span>
    <span><span class="ib-lbl">Asia </span><span class="ib-val">5,645 / 5,601</span></span>
    <span><span class="ib-lbl">EU </span><span class="ib-val">5,648 / 5,618</span></span>
    <span style="color:#1a1a30;font-size:18px;">│</span>
    <span><span class="ib-lbl">P/C </span><span class="ib-good">0.68 bullish</span></span>
    <span><span class="ib-lbl">SPY Vol </span><span class="ib-warn">51% avg ⚠ LOW — FADE BIAS ON</span></span>
    <span style="color:#1a1a30;font-size:18px;">│</span>
    <span><span class="ib-lbl">PDH </span><span class="bear">$714.47</span></span>
    <span><span class="ib-lbl">PDL </span><span class="bull">$709.21</span></span>
    <span><span class="ib-lbl">PDC </span><span class="ib-val">$708.45</span></span>
  </div>

  <div class="intel-main">

    <!-- LEFT: BRIEFING + NEWS -->
    <div class="left-dual">

      <!-- MORNING BRIEFING -->
      <div class="panel">
        <div class="ph"><span class="pt">MORNING BRIEFING</span><span class="ps">08:30 ET · Mon Apr 28 · 🔊 TTS</span></div>
        <div class="pb">
          <div class="brief-cols">
            <div>
              <div class="bc-title">OVERNIGHT FUTURES</div>
              <div class="bc-row"><span class="bc-lbl">ES vs PDC</span><span class="bull">+0.33% Gap Up ↑</span></div>
              <div class="bc-row"><span class="bc-lbl">NQ vs PDC</span><span class="bull">+0.48% Gap Up ↑</span></div>
              <div class="bc-row"><span class="bc-lbl">Asia Hi/Lo</span><span>5,645 / 5,601</span></div>
              <div class="bc-row"><span class="bc-lbl">EU Hi/Lo</span><span>5,648 / 5,618</span></div>
              <div class="bc-row"><span class="bc-lbl">ES Support</span><span class="bull">5,600 held ✓</span></div>
            </div>
            <div>
              <div class="macro-badge mb-bull">MACRO BIAS: BULLISH</div>
              <div class="bc-title">KEY LEVELS — SPY</div>
              <div class="bc-row"><span class="bc-lbl">PDH</span><span class="bear">$714.47</span></div>
              <div class="bc-row"><span class="bc-lbl">PDL</span><span class="bull">$709.21</span></div>
              <div class="bc-row"><span class="bc-lbl">PDC</span><span>$708.45</span></div>
              <div class="bc-row"><span class="bc-lbl">PM Hi/Lo</span><span>$715.20 / $710.50</span></div>
              <div class="bc-row"><span class="bc-lbl">P/C Ratio</span><span class="bull">0.68 bullish ✓</span></div>
            </div>
            <div>
              <div class="bc-title">SESSION PLAN</div>
              <div class="plan-item">09:35 — B1 if $TICK +600 + MOO</div>
              <div class="plan-item">10:00 — Trend time, 9EMA watch</div>
              <div class="plan-item">11:20 — UK close scalp window</div>
              <div class="plan-item plan-alert">14:00 — ⚠ FOMC — reduce size</div>
              <div class="plan-item plan-alert">14:30 — ⚠ Powell presser</div>
              <div class="plan-item">15:50 — MOC SPX if GREEN</div>
              <div class="bc-title" style="margin-top:8px;">OVERNIGHT NEWS</div>
              <div class="nb-red">⚠ Iran: No framework — Reuters [HIGH]</div>
              <div class="nb-yellow">● Trump "deal close" [LOW · FADE]</div>
              <div class="nb-green">✓ ES held 5,600 overnight</div>
              <div class="nb-gray">○ Crude $63.42 below $85 ✓</div>
            </div>
          </div>
        </div>
      </div>

      <!-- NEWS TERMINAL -->
      <div class="panel">
        <div class="ph"><span class="pt">NEWS TERMINAL</span><span class="ps">FJ 30s · Reuters · AP · SEC 120s · 🔊 TTS</span></div>
        <div class="news-tabs">
          <div class="news-tab active" onclick="setNewsTab(this)">ALL</div>
          <div class="news-tab" onclick="setNewsTab(this)">⚠ HIGH</div>
          <div class="news-tab" onclick="setNewsTab(this)">🔄 FADE</div>
          <div class="news-tab" onclick="setNewsTab(this)">📋 SEC</div>
          <div class="news-tab" onclick="setNewsTab(this)">📊 MOC/MOO</div>
        </div>
        <div class="pb">
          <div class="ni">
            <div class="ni-top"><span class="nbadge nb-high">⚠ HIGH</span><span class="nsrc">Financial Juice</span><span class="ntime">09:38:14 ET</span></div>
            <div class="ntext">Trump: "Iran deal done, announcement within hours" — Truth Social</div>
            <div class="nmeta"><span class="cred-lo">TIER 2 · Vol 51% · LOW credibility</span><span class="fade-tag"> · 🔄 FADE — watch delta flip</span></div>
          </div>
          <div class="ni">
            <div class="ni-top"><span class="nbadge nb-high">⚠ HIGH</span><span class="nsrc">Reuters</span><span class="ntime">07:22:04 ET</span></div>
            <div class="ntext">Iran: No framework agreed, no announcement imminent — talks ongoing</div>
            <div class="nmeta"><span class="cred-hi">TIER 1 · HIGH credibility · Contradicts Trump</span><span class="fade-tag"> → FADE CONFIRMED on any pop</span></div>
          </div>
          <div class="ni">
            <div class="ni-top"><span class="nbadge nb-med">● MED</span><span class="nsrc">Financial Juice</span><span class="ntime">07:15:33 ET</span></div>
            <div class="ntext">NVDA: Analyst raises PT to $240 — Bernstein <span style="color:var(--blue);">[NVDA]</span></div>
            <div class="nmeta" style="color:#666;">TIER 3 · Sector bullish · Confirms NVDA BULL on monitor</div>
          </div>
          <div class="ni">
            <div class="ni-top"><span class="nbadge nb-med">● MED</span><span class="nsrc">AP Business</span><span class="ntime">06:58:11 ET</span></div>
            <div class="ntext">Goldman: Market rally on low volume suggests short covering not institutional buying</div>
            <div class="nmeta" style="color:#666;">TIER 3 · Confirms fade bias · Institutional money not participating</div>
          </div>
        </div>
      </div>

    </div><!-- end left-dual -->

    <!-- MIDDLE: CALENDAR -->
    <div class="panel">
      <div class="ph"><span class="pt">ECONOMIC CALENDAR</span><span class="ps">Click event → AI analysis</span></div>
      <div class="pb">
        <div class="pinned">
          <div class="pinned-title">📌 ACTIVE TRADE</div>
          <div class="pinned-row"><span class="pinned-lbl">Position</span><span class="bull">CAR 5/15 Puts</span></div>
          <div class="pinned-row"><span class="pinned-lbl">Return</span><span class="bull">+1,400%+</span></div>
          <div class="pinned-row"><span class="pinned-lbl">Expiry</span><span class="bear">May 15, 2026</span></div>
        </div>
        <div class="cal-grid">
          <div class="ci" onclick="openCalPopup('fomc')"><div class="ci-today">TODAY · ALL DAY</div><div class="ci-event ci-high">⚠ FOMC Day 1</div><span class="ci-click">→ ANALYZE</span></div>
          <div class="ci" onclick="openCalPopup('durable')"><div class="ci-today">TODAY · 08:30</div><div class="ci-event ci-high">⚠ Durable Goods</div><span class="ci-click">→ ANALYZE</span></div>
          <div class="ci" onclick="openCalPopup('gdp')"><div class="ci-date">Apr 28 · 08:30</div><div class="ci-event ci-high">⚠ GDP Q1 Advance</div><span class="ci-click">→ ANALYZE</span></div>
          <div class="ci" onclick="openCalPopup('pce')"><div class="ci-date">Apr 29 · 08:30</div><div class="ci-event ci-high">⚠ PCE Index</div><span class="ci-click">→ ANALYZE</span></div>
          <div class="ci" onclick="openCalPopup('fomc_dec')"><div class="ci-date">Apr 29 · 14:00</div><div class="ci-event ci-high">⚠ FOMC Decision</div><span class="ci-click">→ ANALYZE</span></div>
          <div class="ci" onclick="openCalPopup('powell')"><div class="ci-date">Apr 29 · 14:30</div><div class="ci-event ci-high">⚠ Powell Presser</div><span class="ci-click">→ ANALYZE</span></div>
          <div class="ci" onclick="openCalPopup('nfp')"><div class="ci-date">May 1 · 08:30</div><div class="ci-event ci-high">⚠ NFP + Unemp.</div><span class="ci-click">→ ANALYZE</span></div>
          <div class="ci" onclick="openCalPopup('cbrs')"><div class="ci-date">May 12 · TBD</div><div class="ci-event ci-high">⚠ CBRS IPO</div><span class="ci-click">→ ANALYZE</span></div>
        </div>
      </div>
    </div>

    <!-- RIGHT: EARNINGS -->
    <div class="panel">
      <div class="ph"><span class="pt">EARNINGS INTELLIGENCE</span><span class="ps">Polygon.io · Click → Options + AI</span></div>
      <div class="pb">
        <div class="ei" onclick="openOptionsChain('META','677.77','78','amc')">
          <div class="ei-top"><span class="ei-sym">META</span><span class="ei-tag ei-amc">AMC</span></div>
          <div style="font-size:10px;color:#444;margin-bottom:4px;">Wed Apr 29</div>
          <div class="ei-row"><span class="ei-lbl">EPS Est</span><span class="bull">$5.28</span></div>
          <div class="ei-row"><span class="ei-lbl">Avg Move</span><span class="divm">±8.2%</span></div>
          <div class="ei-row"><span class="ei-lbl">IV Rank</span><span class="bear">78 — expensive</span></div>
          <div class="ei-click">Click → Live options chain + AI analysis</div>
        </div>
        <div class="ei" onclick="openOptionsChain('MSFT','421.40','62','amc')">
          <div class="ei-top"><span class="ei-sym">MSFT</span><span class="ei-tag ei-amc">AMC</span></div>
          <div style="font-size:10px;color:#444;margin-bottom:4px;">Wed Apr 29</div>
          <div class="ei-row"><span class="ei-lbl">EPS Est</span><span class="bull">$3.22</span></div>
          <div class="ei-row"><span class="ei-lbl">Avg Move</span><span class="divm">±5.1%</span></div>
          <div class="ei-row"><span class="ei-lbl">IV Rank</span><span class="divm">62 — moderate</span></div>
          <div class="ei-click">Click → Live options chain + AI analysis</div>
        </div>
        <div class="ei" onclick="openOptionsChain('GOOGL','341.68','41','amc')">
          <div class="ei-top"><span class="ei-sym">GOOGL</span><span class="ei-tag ei-amc">AMC</span></div>
          <div style="font-size:10px;color:#444;margin-bottom:4px;">Thu Apr 30</div>
          <div class="ei-row"><span class="ei-lbl">EPS Est</span><span class="bull">$2.01</span></div>
          <div class="ei-row"><span class="ei-lbl">Avg Move</span><span class="divm">±6.4%</span></div>
          <div class="ei-row"><span class="ei-lbl">IV Rank</span><span class="bull">41 — cheap</span></div>
          <div class="ei-click">Click → Live options chain + AI analysis</div>
        </div>
        <div class="ei" onclick="openOptionsChain('AAPL','271.20','55','amc')">
          <div class="ei-top"><span class="ei-sym">AAPL</span><span class="ei-tag ei-amc">AMC</span></div>
          <div style="font-size:10px;color:#444;margin-bottom:4px;">Thu May 1</div>
          <div class="ei-row"><span class="ei-lbl">EPS Est</span><span class="bull">$1.61</span></div>
          <div class="ei-row"><span class="ei-lbl">Avg Move</span><span class="divm">±4.8%</span></div>
          <div class="ei-row"><span class="ei-lbl">IV Rank</span><span class="divm">55 — moderate</span></div>
          <div class="ei-click">Click → Live options chain + AI analysis</div>
        </div>
        <div class="ei" onclick="openOptionsChain('AMZN','264.40','71','amc')">
          <div class="ei-top"><span class="ei-sym">AMZN</span><span class="ei-tag ei-amc">AMC</span></div>
          <div style="font-size:10px;color:#444;margin-bottom:4px;">Thu May 1</div>
          <div class="ei-row"><span class="ei-lbl">EPS Est</span><span class="bull">$1.37</span></div>
          <div class="ei-row"><span class="ei-lbl">Avg Move</span><span class="divm">±7.9%</span></div>
          <div class="ei-row"><span class="ei-lbl">IV Rank</span><span class="bear">71 — expensive</span></div>
          <div class="ei-click">Click → Live options chain + AI analysis</div>
        </div>
      </div>
    </div>

  </div><!-- end intel-main -->
</div><!-- end tab-intel -->`;

fs.appendFileSync(file, s5);
console.log('S5 done:', s5.length);
