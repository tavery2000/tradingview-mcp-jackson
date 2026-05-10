const fs = require('fs');
const file = 'C:\\Users\\tomav\\tradingview-mcp-jackson\\hank-electron-r3.html';

const s2 = `

<!-- CONFIRM OVERLAY -->
<div class="confirm-overlay" id="confirmOverlay">
  <div class="confirm-box">
    <div class="confirm-title">⬡ CONFIRM ORDER</div>
    <div class="confirm-order" id="confirmOrder">---</div>
    <div class="confirm-details" id="confirmDetails"></div>
    <div class="confirm-btns">
      <button class="yes-btn" onclick="executeOrder()">✓ EXECUTE</button>
      <button class="no-btn"  onclick="cancelOrder()">✕ CANCEL</button>
    </div>
    <div class="paper-note" id="paperNote"></div>
  </div>
</div>

<!-- FILL TOAST -->
<div class="fill-toast" id="fillToast">
  <div class="ft-title">✓ ORDER FILLED</div>
  <div class="ft-body" id="fillBody">---</div>
</div>

<div id="shell">

<!-- ══ TOP BAR ══════════════════════════════════════════════ -->
<div id="topbar">
  <span class="tb-logo">⬡ HANK</span>
  <span class="tb-div">│</span>
  <span class="tb-clock" id="tb-clock">--:--:-- ET</span>
  <span class="tb-div">│</span>
  <span class="tb-session" id="tb-session">◉ PRE-MARKET</span>
  <span class="tb-div">│</span>
  <span class="tb-screen" id="tb-screen">◈ AUTONOMOUS</span>
  <span class="tb-div">│</span>
  <span class="tb-fut"><span class="tb-fut-sym">ES</span>&nbsp;<span class="tb-up" id="es-val">5,642 +0.33%</span></span>
  <span class="tb-div">│</span>
  <span class="tb-fut"><span class="tb-fut-sym">NQ</span>&nbsp;<span class="tb-up" id="nq-val">19,821 +0.48%</span></span>
  <span class="tb-div">│</span>
  <span class="tb-fut"><span class="tb-fut-sym">CL</span>&nbsp;<span class="tb-dn" id="cl-val">$63.42 -0.59%</span></span>
  <span class="tb-div">│</span>
  <span class="tb-mkt" id="mkt-badge">CLOSED</span>
  <div class="tb-dots">
    <div class="tb-dot-group"><div class="tb-dot g" id="dot-mkt"></div><span class="tb-dot-lbl">MKT</span></div>
    <div class="tb-dot-group"><div class="tb-dot g" id="dot-news"></div><span class="tb-dot-lbl">NEWS</span></div>
    <div class="tb-dot-group"><div class="tb-dot g" id="dot-sec"></div><span class="tb-dot-lbl">SEC</span></div>
    <div class="tb-dot-group"><div class="tb-dot y" id="dot-wb"></div><span class="tb-dot-lbl">WB</span></div>
  </div>
</div>

<!-- ══ MAIN AREA ══════════════════════════════════════════════ -->
<div id="main-area">

<!-- ══ SIDEBAR ════════════════════════════════════════════════ -->
<div id="sidebar">
  <div class="nav-tabs">
    <div class="nav-tab active" data-tab="auto" onclick="switchTab('auto',this)">
      <span class="nav-icon">⬡</span> AUTONOMOUS
    </div>
    <div class="nav-tab" data-tab="monitor" onclick="switchTab('monitor',this)">
      <span class="nav-icon">◈</span> MONITOR
    </div>
    <div class="nav-tab" data-tab="intel" onclick="switchTab('intel',this)">
      <span class="nav-icon">◉</span> INTELLIGENCE
    </div>
    <div class="nav-tab" data-tab="pnl" onclick="switchTab('pnl',this)">
      <span class="nav-icon">$</span> P&amp;L
    </div>
    <div class="nav-tab" data-tab="trade" onclick="switchTab('trade',this)">
      <span class="nav-icon">▲</span> TRADE
    </div>
    <div class="nav-tab" data-tab="settings" onclick="switchTab('settings',this)">
      <span class="nav-icon">⚙</span> SETTINGS
    </div>
  </div>

  <div class="svc-panel">
    <div class="svc-title">SERVICES</div>
    <div class="svc-row">
      <div class="svc-dot-sm run" id="sd-monitor"></div>
      <span class="svc-name">monitor.js</span>
      <button class="svc-btn" onclick="svcToggle('monitor')">■</button>
    </div>
    <div class="svc-row">
      <div class="svc-dot-sm run" id="sd-news"></div>
      <span class="svc-name">news.js</span>
      <button class="svc-btn" onclick="svcToggle('news')">■</button>
    </div>
    <div class="svc-row">
      <div class="svc-dot-sm stop" id="sd-moc"></div>
      <span class="svc-name">moc.js</span>
      <button class="svc-btn" onclick="svcToggle('moc')">▶</button>
    </div>
    <div class="svc-row">
      <div class="svc-dot-sm stop" id="sd-mailer"></div>
      <span class="svc-name">mailer.js</span>
      <button class="svc-btn" onclick="svcToggle('mailer')">▶</button>
    </div>
    <div class="svc-row">
      <div class="svc-dot-sm stop" id="sd-theta"></div>
      <span class="svc-name">theta.js</span>
      <button class="svc-btn" onclick="svcToggle('theta')">▶</button>
    </div>
    <div class="svc-row">
      <div class="svc-dot-sm stop" id="sd-ws"></div>
      <span class="svc-name">wsServer.js</span>
      <button class="svc-btn" onclick="svcToggle('ws')">▶</button>
    </div>
  </div>

  <div class="log-mini" id="svcLog">
    <div class="ll g">[10:26] monitor.js started</div>
    <div class="ll g">[10:26] news.js connected</div>
    <div class="ll y">[10:25] Webull partial auth</div>
    <div class="ll">[10:24] CDP connected :9222</div>
    <div class="ll r">[10:23] moc.js offline</div>
  </div>
</div>

<!-- ══ CONTENT ════════════════════════════════════════════════ -->
<div id="content">`;

fs.appendFileSync(file, s2);
console.log('S2 done:', s2.length);
