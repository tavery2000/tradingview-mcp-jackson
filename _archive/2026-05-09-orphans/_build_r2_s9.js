const fs = require('fs');
const file = 'C:\\Users\\tomav\\tradingview-mcp-jackson\\hank-electron-r2.html';

const s9 = `

<!-- ══════════════════ DRAGGABLE WINDOWS ════════════════════ -->

<!-- ASK HANK BUTTON (fixed) -->
<button class="ask-hank-btn" id="askHankBtn" onclick="toggleChat()">⬡ ASK HANK</button>

<!-- CHAT WINDOW -->
<div class="drag-win" id="chatWin" style="display:none;width:400px;height:480px;right:20px;bottom:60px;top:auto;left:auto;">
  <div class="dw-header" id="chatWinHdr">
    <span>⬡ HANK AI ASSISTANT</span>
    <button class="dw-close" onclick="toggleChat()">✕</button>
  </div>
  <div class="dw-body" style="display:flex;flex-direction:column;height:calc(100% - 36px);">
    <div class="chat-msgs" id="chatMsgs" style="flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;">
      <div class="chat-msg hank-msg">
        <span class="cm-who">⬡ HANK</span>
        <span class="cm-text">Ready. Ask me about current signals, levels, or trade ideas.</span>
      </div>
    </div>
    <div style="padding:10px;border-top:1px solid #111;display:flex;gap:8px;">
      <input class="chat-input" id="chatInput" type="text" placeholder="Ask HANK..." onkeydown="if(event.key==='Enter')sendChat()">
      <button class="chat-send" onclick="sendChat()">▶</button>
    </div>
  </div>
</div>

<!-- OPTIONS CHAIN WINDOW -->
<div class="drag-win" id="optWin" style="display:none;width:560px;height:520px;left:50%;top:50%;transform:translate(-50%,-50%);">
  <div class="dw-header" id="optWinHdr">
    <span id="opt-title">OPTIONS CHAIN — —</span>
    <div style="display:flex;gap:6px;align-items:center;">
      <select id="optExpiry" style="background:#0b0b16;border:1px solid #1a1a2a;color:#ccc;padding:3px 6px;font-family:var(--mono);font-size:10px;" onchange="setExpiry(this.value)">
        <option>0DTE</option><option>1DTE</option><option>Weekly</option><option>Monthly</option>
      </select>
      <button class="dw-close" onclick="closeOptions()">✕</button>
    </div>
  </div>
  <div class="dw-body" style="padding:10px;overflow-y:auto;height:calc(100% - 36px);">
    <div id="opt-chain-body">
      <div style="color:#333;text-align:center;padding:40px;">Loading chain...</div>
    </div>
  </div>
</div>

<!-- CALENDAR POPUP WINDOW -->
<div class="drag-win" id="calWin" style="display:none;width:440px;height:360px;left:50%;top:50%;transform:translate(-50%,-50%);">
  <div class="dw-header" id="calWinHdr">
    <span id="cal-title">ECONOMIC EVENT</span>
    <button class="dw-close" onclick="closeCalPopup()">✕</button>
  </div>
  <div class="dw-body" style="padding:16px;overflow-y:auto;height:calc(100% - 36px);" id="cal-body">
    <div style="color:#333;">Select an event to analyze.</div>
  </div>
</div>

<!-- ══════════════════ JAVASCRIPT ════════════════════════════ -->
<script>

// ── CLOCK ────────────────────────────────────────────────────
function tick() {
  const now = new Date();
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).format(now);
  const el = document.getElementById('tb-clock');
  if (el) el.textContent = et + ' ET';
  updateSession(now);
}
setInterval(tick, 1000);
tick();

// ── SESSION DETECTION ────────────────────────────────────────
function updateSession(now) {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const h = et.getHours(), m = et.getMinutes();
  const mins = h * 60 + m;

  let session = 'PRE-MARKET', dot = 'y', badge = 'CLOSED';
  if (mins < 570)        { session = 'PRE-MARKET';  dot = 'y'; badge = 'PRE'; }
  else if (mins < 575)   { session = 'MOO WINDOW';  dot = 'g'; badge = 'MOO'; }
  else if (mins < 585)   { session = 'BULLET 1';    dot = 'g'; badge = 'OPEN'; }
  else if (mins < 640)   { session = 'TREND TIME';  dot = 'g'; badge = 'OPEN'; }
  else if (mins < 680)   { session = 'UK CLOSE';    dot = 'g'; badge = 'OPEN'; }
  else if (mins < 750)   { session = 'MIDDAY';      dot = 'y'; badge = 'OPEN'; }
  else if (mins < 870)   { session = 'AFTERNOON';   dot = 'g'; badge = 'OPEN'; }
  else if (mins < 950)   { session = 'PRE-MOC';     dot = 'y'; badge = 'OPEN'; }
  else if (mins < 960)   { session = 'MOC WINDOW';  dot = 'g'; badge = 'MOC'; }
  else                   { session = 'AFTER-HOURS'; dot = 'y'; badge = 'CLOSED'; }

  const sess = document.getElementById('tb-session');
  const mkt = document.getElementById('mkt-badge');
  const abSess = document.getElementById('ab-sess');
  if (sess) sess.textContent = '◉ ' + session;
  if (mkt)  { mkt.textContent = badge; mkt.className = 'tb-mkt'; if (badge === 'OPEN') mkt.style.color = 'var(--green)'; else mkt.style.color = ''; }
  if (abSess) abSess.textContent = session;
}

// ── TAB SWITCHING ────────────────────────────────────────────
function switchTab(tabId, el) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  const panel = document.getElementById('tab-' + tabId);
  if (panel) panel.classList.add('active');
  if (el) el.classList.add('active');

  const labels = { auto: '◈ AUTONOMOUS', monitor: '◈ MONITOR', intel: '◉ INTELLIGENCE', pnl: '$ P&L', trade: '▲ TRADE', settings: '⚙ SETTINGS' };
  const sc = document.getElementById('tb-screen');
  if (sc) sc.textContent = labels[tabId] || tabId.toUpperCase();

  if (tabId === 'pnl') fetchPnL();
  if (tabId === 'trade') loadHankSignal();
}

// ── NEWS TABS ────────────────────────────────────────────────
function setNewsTab(el) {
  document.querySelectorAll('.news-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
}

// ── CONFIRM / EXECUTE OVERLAY ────────────────────────────────
let pendingOrder = null;

function confirmOrder(orderObj) {
  pendingOrder = orderObj;
  const overlay = document.getElementById('confirmOverlay');
  const orderEl = document.getElementById('confirmOrder');
  const detEl   = document.getElementById('confirmDetails');
  const noteEl  = document.getElementById('paperNote');
  if (!overlay) return;
  orderEl.textContent = orderObj.label || '---';
  detEl.textContent   = orderObj.details || '';
  noteEl.textContent  = '📋 PAPER TRADE — simulated only, no real money';
  overlay.style.display = 'flex';
}

function cancelOrder() {
  pendingOrder = null;
  const overlay = document.getElementById('confirmOverlay');
  if (overlay) overlay.style.display = 'none';
}

function executeOrder() {
  const overlay = document.getElementById('confirmOverlay');
  if (overlay) overlay.style.display = 'none';
  if (!pendingOrder) return;
  showFill(pendingOrder.label, pendingOrder.details);
  logTrade(pendingOrder);
  pendingOrder = null;
}

function showFill(label, details) {
  const toast = document.getElementById('fillToast');
  const body  = document.getElementById('fillBody');
  if (!toast) return;
  if (body) body.textContent = label + (details ? ' · ' + details : '');
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 4000);
}

// ── TRADE LOG ────────────────────────────────────────────────
const tradeLog = [];
function logTrade(order) {
  const now = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
  tradeLog.unshift({ time: now, ...order });
  renderLog();
}

function renderLog() {
  const el = document.getElementById('tradeLog');
  if (!el) return;
  if (!tradeLog.length) { el.innerHTML = '<div style="color:#2a2a3a;font-size:10px;padding:8px;">No trades this session.</div>'; return; }
  el.innerHTML = tradeLog.slice(0, 20).map(t =>
    \`<div class="tl-row"><span class="tl-time">\${t.time}</span><span class="tl-text">\${t.label || ''}</span></div>\`
  ).join('');
}

// ── POSITIONS ────────────────────────────────────────────────
const positions = [];

function renderPositions() {
  const el = document.getElementById('posTable');
  if (!el) return;
  if (!positions.length) { el.innerHTML = '<tr><td colspan="6" style="color:#2a2a3a;text-align:center;padding:12px;">No open positions</td></tr>'; return; }
  el.innerHTML = positions.map(p => \`
    <tr>
      <td>\${p.sym}</td><td>\${p.side}</td><td>\${p.qty}</td>
      <td>\${p.entry}</td><td class="\${p.pnl>=0?'bull':'bear'}">\${p.pnl>=0?'+':''}\${p.pnl.toFixed(2)}</td>
      <td><button class="pos-close-btn" onclick="closePosition('\${p.id}')">✕</button></td>
    </tr>\`).join('');
}

function closePosition(id) {
  const idx = positions.findIndex(p => p.id === id);
  if (idx === -1) return;
  const p = positions.splice(idx, 1)[0];
  showFill('CLOSED ' + p.sym, 'P&L: ' + (p.pnl >= 0 ? '+' : '') + p.pnl.toFixed(2));
  renderPositions();
}

function closeAll() {
  if (!positions.length) return;
  positions.forEach(p => showFill('CLOSED ' + p.sym, ''));
  positions.length = 0;
  renderPositions();
}

// ── SYMBOL FETCH (Yahoo Finance) ──────────────────────────────
let currentSym = 'SPY', currentPrice = 714.01, currentSide = 'calls';

async function fetchSymbol() {
  const inp = document.getElementById('symInput');
  const sym = inp ? inp.value.toUpperCase().trim() : currentSym;
  if (!sym) return;
  currentSym = sym;

  const qstrip = document.getElementById('quoteStrip');
  if (qstrip) qstrip.innerHTML = \`<span style="color:#333;">Fetching \${sym}...</span>\`;

  try {
    const url = \`https://query1.finance.yahoo.com/v8/finance/chart/\${sym}?interval=1m&range=1d\`;
    const r = await fetch(url);
    const j = await r.json();
    const result = j?.chart?.result?.[0];
    if (!result) throw new Error('No data');
    const meta = result.meta;
    const price = meta.regularMarketPrice || meta.previousClose;
    currentPrice = price;
    const prev  = meta.chartPreviousClose || meta.previousClose;
    const chg   = price - prev;
    const pct   = ((chg / prev) * 100).toFixed(2);
    const bull  = chg >= 0;
    const hi    = meta.regularMarketDayHigh?.toFixed(2) || '—';
    const lo    = meta.regularMarketDayLow?.toFixed(2)  || '—';
    const vol   = (meta.regularMarketVolume / 1e6)?.toFixed(1) + 'M' || '—';

    if (qstrip) qstrip.innerHTML = \`
      <span class="qs-sym">\${sym}</span>
      <span class="qs-price \${bull?'bull':'bear'}">\${price.toFixed(2)}</span>
      <span class="\${bull?'bull':'bear'}">\${bull?'+':''}\${chg.toFixed(2)} (\${bull?'+':''}\${pct}%)</span>
      <span class="qs-item"><span class="qs-lbl">Hi</span>\${hi}</span>
      <span class="qs-item"><span class="qs-lbl">Lo</span>\${lo}</span>
      <span class="qs-item"><span class="qs-lbl">Vol</span>\${vol}</span>
    \`;
    calcStrike();
    updateOrder();
  } catch(e) {
    if (qstrip) qstrip.innerHTML = \`<span style="color:var(--red);">Error: \${e.message}</span>\`;
  }
}

function setSide(side, el) {
  currentSide = side;
  document.querySelectorAll('.side-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  calcStrike();
  updateOrder();
}

function getStrikeStep(price) {
  if (price < 5)   return 0.5;
  if (price < 25)  return 1;
  if (price < 100) return 1;
  if (price < 200) return 2;
  if (price < 500) return 5;
  return 10;
}

let strikeOffset = 1;

function calcStrike() {
  const step   = getStrikeStep(currentPrice);
  const atm    = Math.round(currentPrice / step) * step;
  const offset = currentSide === 'calls' ? strikeOffset : -strikeOffset;
  const strike = (atm + offset * step).toFixed(1);
  const el = document.getElementById('strikeDisplay');
  if (el) el.textContent = '$' + strike;
  updateOrder();
  return parseFloat(strike);
}

function adjustStrike(dir) {
  strikeOffset = Math.max(-10, Math.min(10, strikeOffset + dir));
  calcStrike();
}

let currentSize = 1, currentExpiry = '0DTE';

function setSize(n) {
  currentSize = n;
  document.querySelectorAll('.size-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.size) === n);
  });
  updateOrder();
}

function setExpiry(exp) {
  currentExpiry = exp;
  updateOrder();
}

function updateOrder() {
  const preview = document.getElementById('orderPreview');
  if (!preview) return;
  const strike = calcStrike();
  const est = (currentPrice * 0.004 * (currentSide === 'puts' ? 1.2 : 1)).toFixed(2);
  preview.innerHTML = \`
    <div class="op-row"><span class="op-lbl">Symbol</span><span class="op-val">\${currentSym}</span></div>
    <div class="op-row"><span class="op-lbl">Action</span><span class="op-val \${currentSide==='calls'?'bull':'bear'}">\${currentSide==='calls'?'BUY CALL':'BUY PUT'}</span></div>
    <div class="op-row"><span class="op-lbl">Strike</span><span class="op-val">$\${strike}</span></div>
    <div class="op-row"><span class="op-lbl">Expiry</span><span class="op-val">\${currentExpiry}</span></div>
    <div class="op-row"><span class="op-lbl">Qty</span><span class="op-val">\${currentSize} contract\${currentSize>1?'s':''}</span></div>
    <div class="op-row"><span class="op-lbl">Est. Premium</span><span class="op-val">~$\${est}</span></div>
    <div class="op-row"><span class="op-lbl">Est. Cost</span><span class="op-val">~$\${(parseFloat(est)*100*currentSize).toFixed(0)}</span></div>
  \`;
}

function handleConfirmOrder() {
  const strike = calcStrike();
  const est = (currentPrice * 0.004).toFixed(2);
  confirmOrder({
    label: \`\${currentSym} $\${strike}\${currentSide==='calls'?'C':'P'} \${currentExpiry} x\${currentSize}\`,
    details: \`~$\${est}/contract · \${currentSide.toUpperCase()}\`
  });
}

// ── HANK SIGNAL LOADER ────────────────────────────────────────
function loadHankSignal() {
  const banner = document.getElementById('hankSignalBanner');
  if (!banner) return;
  banner.innerHTML = \`
    <div style="font-size:10px;color:#333;letter-spacing:2px;margin-bottom:5px;">HANK SIGNAL</div>
    <div class="master-sig ms-calls" style="font-size:13px;padding:6px 12px;margin-bottom:5px;">⬡ TAKE CALLS — HIGH</div>
    <div style="font-size:10px;color:#aaa;">SPY 4/6 BULL · TICK +642 · VWAP +$2.02 · MOO $2.4B · W3 3/4</div>
    <button style="margin-top:8px;padding:4px 12px;background:#0a1a0a;border:1px solid var(--green);color:var(--green);font-family:var(--mono);font-size:10px;cursor:pointer;" onclick="applyHankSignal()">APPLY SIGNAL</button>
  \`;
}

function applyHankSignal() {
  const inp = document.getElementById('symInput');
  if (inp) inp.value = 'SPY';
  currentSym = 'SPY'; currentSide = 'calls'; strikeOffset = 1;
  document.querySelectorAll('.side-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.side === 'calls');
  });
  fetchSymbol();
}

// ── AUTO-TRADE ENGINE ─────────────────────────────────────────
let autoArmed = false, autoStopTimer = null;

function toggleAutoArm() {
  autoArmed = !autoArmed;
  const btn = document.getElementById('armBtn');
  const status = document.getElementById('auto-status-mini');
  if (autoArmed) {
    if (btn) { btn.textContent = '⬡ ARMED — CLICK TO DISARM'; btn.style.color = 'var(--green)'; btn.style.borderColor = 'var(--green)'; }
    if (status) status.textContent = 'ARMED · Monitoring for HIGH conf signals';
    checkAutoTradeSignal();
  } else {
    if (btn) { btn.textContent = '⬡ ARM AUTO-TRADE'; btn.style.color = ''; btn.style.borderColor = ''; }
    if (status) status.textContent = 'OFF · Manual confirmation required';
    if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
  }
}

function haltAll() {
  autoArmed = false;
  const btn = document.getElementById('armBtn');
  const status = document.getElementById('auto-status-mini');
  if (btn) { btn.textContent = '⬡ ARM AUTO-TRADE'; btn.style.color = ''; btn.style.borderColor = ''; }
  if (status) status.textContent = 'HALTED · All engines stopped';
  closeAll();
}

function checkAutoTradeSignal() {
  if (!autoArmed) return;
  const conf = document.getElementById('auto-conf')?.value || 'HIGH conf only';
  const syms = document.getElementById('auto-syms')?.value || 'SPY only';
  autoExecute({ sym: 'SPY', side: 'calls', strike: 716, expiry: '0DTE', size: 1, conf: 'HIGH' });
}

function autoExecute(order) {
  if (!autoArmed) return;
  showFill(\`AUTO: \${order.sym} $\${order.strike}\${order.side==='calls'?'C':'P'} \${order.expiry}\`, 'Auto-entered · 3min stop armed');
  logTrade({ label: \`AUTO \${order.sym} $\${order.strike}\${order.side==='calls'?'C':'P'}\`, details: 'auto-trade engine' });
  autoStopTimer = setTimeout(() => {
    showFill('AUTO TIME STOP', order.sym + ' position closed at 3min');
    autoArmed = false;
    const btn = document.getElementById('armBtn');
    if (btn) { btn.textContent = '⬡ ARM AUTO-TRADE'; btn.style.color = ''; }
  }, 3 * 60 * 1000);
}

// ── SERVICES ──────────────────────────────────────────────────
const svcState = { monitor: true, news: true, moc: false, mailer: false, theta: false, ws: false };

function svcToggle(name) {
  svcState[name] = !svcState[name];
  const dot = document.getElementById('sd-' + name);
  const btn = dot?.parentElement?.querySelector('.svc-btn');
  if (dot) { dot.className = 'svc-dot-sm ' + (svcState[name] ? 'run' : 'stop'); }
  if (btn) btn.textContent = svcState[name] ? '■' : '▶';
  addSvcLog(name + (svcState[name] ? ' started' : ' stopped'), svcState[name] ? 'g' : 'r');
}

function addSvcLog(msg, cls) {
  const log = document.getElementById('svcLog');
  if (!log) return;
  const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
  const div = document.createElement('div');
  div.className = 'll ' + (cls || '');
  div.textContent = '[' + now + '] ' + msg;
  log.prepend(div);
  while (log.children.length > 8) log.removeChild(log.lastChild);
}

// ── SETTINGS ──────────────────────────────────────────────────
function setSettingMode(mode, el) {
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
}

function setToggle(el, key) {
  el.classList.toggle('active');
}

function launchTradingView() {
  const btn = document.getElementById('tvLaunchBtn');
  if (btn) { btn.textContent = '⏳ LAUNCHING…'; btn.disabled = true; }
  fetch('http://localhost:5001/launch-tv', { method: 'POST' })
    .then(r => r.json())
    .then(d => {
      if (btn) { btn.textContent = d.success ? '✓ TRADINGVIEW OPEN' : '⚠ LAUNCH FAILED'; btn.disabled = false; }
    })
    .catch(() => {
      if (btn) { btn.textContent = '⚠ SERVER OFFLINE'; btn.disabled = false; }
    });
}

function reAuthWebull() {
  alert('Open terminal and run: node webull.js --login');
}

// ── ASK HANK CHAT ─────────────────────────────────────────────
let chatOpen = false;

function toggleChat() {
  chatOpen = !chatOpen;
  const win = document.getElementById('chatWin');
  const btn = document.getElementById('askHankBtn');
  if (win) win.style.display = chatOpen ? 'flex' : 'none';
  if (btn) btn.textContent = chatOpen ? '✕ CLOSE HANK' : '⬡ ASK HANK';
  if (chatOpen) {
    const inp = document.getElementById('chatInput');
    if (inp) inp.focus();
  }
}

async function sendChat() {
  const inp = document.getElementById('chatInput');
  const msgs = document.getElementById('chatMsgs');
  if (!inp || !msgs) return;
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';

  const userDiv = document.createElement('div');
  userDiv.className = 'chat-msg user-msg';
  userDiv.innerHTML = '<span class="cm-who">YOU</span><span class="cm-text">' + text + '</span>';
  msgs.appendChild(userDiv);
  msgs.scrollTop = msgs.scrollHeight;

  const responses = {
    'signal': 'Current signal: TAKE CALLS HIGH. SPY 4/6 BULL, TICK +642, VWAP +$2.02, MOO $2.4B buy-side. Entry: SPY $716C 0DTE ~$0.85.',
    'spy':    'SPY 714.01 — above VWAP $711.99 and 9EMA $713.44. Resistance $713.66 (+0.08%). Trend time active. Calls thesis intact.',
    'iwm':    'IWM 198.44 — above VWAP $197.56, 9EMA rising. B2 pending on $199 breakout. IV Rank 29 — cheap options.',
    'qqq':    'QQQ 484.20 — below VWAP $484.42. NQ lagging ES. Skip signal — choppy. Fade risk elevated.',
    'default': 'Analyzing current conditions. SPY bullish above VWAP. Fade bias active on low volume (51%). FOMC risk this afternoon. Size down near $714.47 PDH resistance.'
  };
  const lower = text.toLowerCase();
  let reply = responses.default;
  for (const [k, v] of Object.entries(responses)) {
    if (k !== 'default' && lower.includes(k)) { reply = v; break; }
  }

  await new Promise(r => setTimeout(r, 600));
  const hankDiv = document.createElement('div');
  hankDiv.className = 'chat-msg hank-msg';
  hankDiv.innerHTML = '<span class="cm-who">⬡ HANK</span><span class="cm-text">' + reply + '</span>';
  msgs.appendChild(hankDiv);
  msgs.scrollTop = msgs.scrollHeight;
}

// ── OPTIONS CHAIN ─────────────────────────────────────────────
let optSym = '', optPrice = 0, optIV = 50, optSide = 'amc';

function openOptionsChain(sym, price, iv, side) {
  optSym = sym; optPrice = parseFloat(price); optIV = parseInt(iv); optSide = side;
  const win = document.getElementById('optWin');
  const title = document.getElementById('opt-title');
  if (title) title.textContent = 'OPTIONS CHAIN — ' + sym + ' $' + price;
  if (win) win.style.display = 'flex';
  buildChain('0DTE');
}

function closeOptions() {
  const win = document.getElementById('optWin');
  if (win) win.style.display = 'none';
}

function setExpiry(exp) {
  currentExpiry = exp;
  buildChain(exp);
}

function buildChain(expiry) {
  const body = document.getElementById('opt-chain-body');
  if (!body) return;
  const step = getStrikeStep(optPrice);
  const atm = Math.round(optPrice / step) * step;
  const strikes = [];
  for (let i = -5; i <= 5; i++) strikes.push(parseFloat((atm + i * step).toFixed(2)));

  let html = \`
    <div style="font-size:10px;color:#555;letter-spacing:1px;margin-bottom:8px;">IV RANK: \${optIV} · Expiry: \${expiry} · \${optSide.toUpperCase()}</div>
    <table style="width:100%;border-collapse:collapse;font-size:10px;">
      <thead>
        <tr style="color:#333;border-bottom:1px solid #111;">
          <th style="padding:4px;text-align:left;">CALLS</th>
          <th style="padding:4px;text-align:center;">BID</th>
          <th style="padding:4px;text-align:center;">ASK</th>
          <th style="padding:4px;text-align:center;">STRIKE</th>
          <th style="padding:4px;text-align:center;">BID</th>
          <th style="padding:4px;text-align:center;">ASK</th>
          <th style="padding:4px;text-align:right;">PUTS</th>
        </tr>
      </thead>
      <tbody>
  \`;

  strikes.forEach(strike => {
    const dist = Math.abs(strike - optPrice);
    const otmFactor = dist / optPrice;
    const ivFrac = optIV / 100;
    const callPrem = Math.max(0.01, (optPrice * ivFrac * 0.1 * Math.exp(-otmFactor * 15) * (strike < optPrice ? 1 + (optPrice - strike) / optPrice : 1))).toFixed(2);
    const putPrem  = Math.max(0.01, (optPrice * ivFrac * 0.1 * Math.exp(-otmFactor * 15) * (strike > optPrice ? 1 + (strike - optPrice) / optPrice : 1))).toFixed(2);
    const isATM    = strike === atm;
    const rowStyle = isATM ? 'background:#0d1a0d;border-top:1px solid #1a3a1a;border-bottom:1px solid #1a3a1a;' : '';
    html += \`
      <tr style="\${rowStyle}cursor:pointer;" onclick="selectStrike(\${strike},'calls')">
        <td style="padding:5px 4px;color:\${strike<=optPrice?'var(--green)':'#555'};">\${strike<=optPrice?'ITM':'OTM'}</td>
        <td style="padding:5px 4px;text-align:center;color:var(--green);">$\${callPrem}</td>
        <td style="padding:5px 4px;text-align:center;color:var(--green);">$\${(parseFloat(callPrem)+0.02).toFixed(2)}</td>
        <td style="padding:5px 4px;text-align:center;\${isATM?'color:var(--yellow);font-weight:bold;':'color:#888;'}">$\${strike}</td>
        <td style="padding:5px 4px;text-align:center;color:var(--red);">$\${putPrem}</td>
        <td style="padding:5px 4px;text-align:center;color:var(--red);">$\${(parseFloat(putPrem)+0.02).toFixed(2)}</td>
        <td style="padding:5px 4px;text-align:right;color:\${strike>=optPrice?'var(--red)':'#555'};">\${strike>=optPrice?'ITM':'OTM'}</td>
      </tr>
    \`;
  });

  html += '</tbody></table>';
  body.innerHTML = html;
}

function selectStrike(strike, side) {
  const inp = document.getElementById('symInput');
  if (inp) inp.value = optSym;
  currentSym = optSym; currentPrice = optPrice;
  currentSide = side; strikeOffset = 0;
  switchTab('trade', document.querySelector('[data-tab="trade"]'));
  setTimeout(() => {
    const el = document.getElementById('strikeDisplay');
    if (el) el.textContent = '$' + strike.toFixed(1);
    updateOrder();
  }, 100);
  closeOptions();
}

// ── CALENDAR POPUP ────────────────────────────────────────────
const calData = {
  fomc: {
    title: 'FOMC Day 1',
    date: 'TODAY · ALL DAY',
    impact: 'HIGH',
    body: \`<div class="cal-section"><div class="cal-lbl">Market Impact</div><div class="cal-text bull">Typically suppresses vol until decision. Range-bound AM, expansion PM.</div></div>
    <div class="cal-section"><div class="cal-lbl">Trading Rules</div>
    <div class="cal-text">• Reduce size 50% going into 14:00<br>• No new positions after 13:30<br>• Hold through only if strong thesis<br>• Fade initial knee-jerk reaction</div></div>
    <div class="cal-section"><div class="cal-lbl">HANK Plan</div><div class="cal-text bear">SIZE DOWN. Exit B1 by 13:00 regardless of P&L.</div></div>\`
  },
  durable: {
    title: 'Durable Goods Orders',
    date: 'TODAY · 08:30 ET',
    impact: 'HIGH',
    body: \`<div class="cal-section"><div class="cal-lbl">Expected</div><div class="cal-text">0.1% MoM · Ex-transport: 0.3%</div></div>
    <div class="cal-section"><div class="cal-lbl">Trading Rules</div><div class="cal-text">• Wait 2min after release<br>• > +1.0% beat → calls on SPY<br>• < -0.5% miss → consider puts but FOMC dampens move</div></div>\`
  },
  gdp: {
    title: 'GDP Q1 Advance',
    date: 'Apr 28 · 08:30 ET',
    impact: 'HIGH',
    body: \`<div class="cal-section"><div class="cal-lbl">Expected</div><div class="cal-text">+0.3% annualized (vs +2.4% Q4)</div></div>
    <div class="cal-section"><div class="cal-lbl">Risk</div><div class="cal-text bear">Negative print = recession fears. Market can drop 1–2% fast.</div></div>
    <div class="cal-section"><div class="cal-lbl">Plan</div><div class="cal-text">Beat > +0.5% → open calls. Miss < 0% → wait 5min, then puts if TICK confirms.</div></div>\`
  },
  pce: {
    title: 'PCE Price Index',
    date: 'Apr 29 · 08:30 ET',
    impact: 'HIGH',
    body: \`<div class="cal-section"><div class="cal-lbl">Expected</div><div class="cal-text">Core PCE 2.6% YoY · MoM 0.3%</div></div>
    <div class="cal-section"><div class="cal-lbl">Fed Implications</div><div class="cal-text">Hot print delays cuts. Market sells. Cool print → rally into FOMC.</div></div>\`
  },
  fomc_dec: {
    title: 'FOMC Decision',
    date: 'Apr 29 · 14:00 ET',
    impact: 'HIGH',
    body: \`<div class="cal-section"><div class="cal-lbl">Consensus</div><div class="cal-text">HOLD — no cut expected. Focus on statement language.</div></div>
    <div class="cal-section"><div class="cal-lbl">Key Phrases to Watch</div><div class="cal-text">• "Data dependent" = neutral<br>• "Further tightening" = bear<br>• "Rate cuts in scope" = bull spike</div></div>
    <div class="cal-section"><div class="cal-lbl">Plan</div><div class="cal-text bear">Be flat going in. Fade the initial move. Real direction comes after Powell at 14:30.</div></div>\`
  },
  powell: {
    title: 'Powell Press Conference',
    date: 'Apr 29 · 14:30 ET',
    impact: 'HIGH',
    body: \`<div class="cal-section"><div class="cal-lbl">Pattern</div><div class="cal-text">First 5min = vol spike. 10–20min = real direction emerges. 30min = fade exhaustion.</div></div>
    <div class="cal-section"><div class="cal-lbl">Plan</div><div class="cal-text bull">If bullish tone → enter MOC calls by 15:45. If hawkish → flat or small puts into close.</div></div>\`
  },
  nfp: {
    title: 'NFP + Unemployment',
    date: 'May 1 · 08:30 ET',
    impact: 'HIGH',
    body: \`<div class="cal-section"><div class="cal-lbl">Expected</div><div class="cal-text">+185K jobs · Unemployment 3.8%</div></div>
    <div class="cal-section"><div class="cal-lbl">Trading Rules</div><div class="cal-text">• Wait 3min for initial volatility to settle<br>• Hot (>250K) + low unemp → fade rally (Fed stays hawkish)<br>• Weak (<100K) → puts, recession narrative<br>• Goldilocks (150-200K) → calls</div></div>\`
  },
  cbrs: {
    title: 'CBRS IPO',
    date: 'May 12 · TBD',
    impact: 'HIGH',
    body: \`<div class="cal-section"><div class="cal-lbl">Note</div><div class="cal-text">IPO date tentative. Watch for lock-up expiry trades. Sector: fintech.</div></div>
    <div class="cal-section"><div class="cal-lbl">Plan</div><div class="cal-text">Monitor pre-market. No position day-of unless clear thesis.</div></div>\`
  }
};

function openCalPopup(key) {
  const data = calData[key];
  if (!data) return;
  const win = document.getElementById('calWin');
  const title = document.getElementById('cal-title');
  const body = document.getElementById('cal-body');
  if (title) title.textContent = data.title + ' · ' + data.date;
  if (body) body.innerHTML = \`
    <div style="display:inline-block;padding:3px 10px;border:1px solid var(--red);color:var(--red);font-size:10px;letter-spacing:2px;margin-bottom:12px;">⚠ \${data.impact} IMPACT</div>
    \${data.body}
  \`;
  if (win) win.style.display = 'flex';
}

function closeCalPopup() {
  const win = document.getElementById('calWin');
  if (win) win.style.display = 'none';
}

// ── P&L DASHBOARD ─────────────────────────────────────────────
async function fetchPnL() {
  try {
    const r = await fetch('http://localhost:5001/ledger');
    const d = await r.json();
    renderPnLStats(d);
  } catch(e) {
    // server offline — use static display
  }
}

function renderPnLStats(data) {
  if (!data) return;
}

// ── DRAGGABLE WINDOWS ─────────────────────────────────────────
function makeDraggable(win, hdr) {
  if (!win || !hdr) return;
  let ox = 0, oy = 0, startX = 0, startY = 0;
  hdr.onmousedown = e => {
    e.preventDefault();
    startX = e.clientX; startY = e.clientY;
    ox = win.offsetLeft; oy = win.offsetTop;
    document.onmousemove = ev => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      win.style.left = (ox + dx) + 'px';
      win.style.top  = (oy + dy) + 'px';
      win.style.transform = 'none';
      win.style.right = 'auto'; win.style.bottom = 'auto';
    };
    document.onmouseup = () => { document.onmousemove = null; document.onmouseup = null; };
  };
}

// ── INIT ──────────────────────────────────────────────────────
(function init() {
  makeDraggable(document.getElementById('chatWin'), document.getElementById('chatWinHdr'));
  makeDraggable(document.getElementById('optWin'),  document.getElementById('optWinHdr'));
  makeDraggable(document.getElementById('calWin'),  document.getElementById('calWinHdr'));

  renderPositions();
  renderLog();
  loadHankSignal();
  updateOrder();

  document.querySelectorAll('.size-btn').forEach(b => {
    b.addEventListener('click', function() { setSize(parseInt(this.dataset.size)); });
  });
  document.querySelectorAll('.side-btn').forEach(b => {
    b.addEventListener('click', function() { setSide(this.dataset.side, this); });
  });
})();

</script>
</div><!-- end content -->
</div><!-- end main-area -->
</div><!-- end shell -->
</body>
</html>`;

fs.appendFileSync(file, s9);
console.log('S9 done:', s9.length);
