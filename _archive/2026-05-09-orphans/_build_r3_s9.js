const fs = require('fs');
const file = 'C:\\Users\\tomav\\tradingview-mcp-jackson\\hank-electron-r3.html';

const s9 = `

<!-- ══ DRAGGABLE WINDOWS ══════════════════════════════════════ -->
<button class="ask-hank-btn" id="askHankBtn" onclick="toggleChat()">⬡ ASK HANK</button>

<!-- CHAT WINDOW -->
<div class="drag-win" id="chatWin" style="display:none;width:420px;height:500px;right:20px;bottom:65px;top:auto;left:auto;">
  <div class="dw-header" id="chatWinHdr">
    <span>⬡ HANK AI ASSISTANT</span>
    <button class="dw-close" onclick="toggleChat()">✕</button>
  </div>
  <div class="dw-body" style="display:flex;flex-direction:column;height:calc(100% - 44px);">
    <div class="chat-msgs" id="chatMsgs" style="flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;">
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

<!-- OPTIONS CHAIN WINDOW (floating, from INTELLIGENCE/EARNINGS click) -->
<div class="drag-win" id="optWin" style="display:none;width:580px;height:540px;left:50%;top:50%;transform:translate(-50%,-50%);">
  <div class="dw-header" id="optWinHdr">
    <span id="opt-title">OPTIONS CHAIN — —</span>
    <div style="display:flex;gap:8px;align-items:center;">
      <select id="optExpiry" style="background:#0b0b16;border:1px solid #1a1a2a;color:#ccc;padding:4px 8px;font-family:var(--mono);font-size:14px;" onchange="buildChain(this.value)">
        <option>0DTE</option><option>1DTE</option><option>Weekly</option><option>Monthly</option>
      </select>
      <button class="dw-close" onclick="closeOptions()">✕</button>
    </div>
  </div>
  <div class="dw-body" style="padding:12px;overflow-y:auto;height:calc(100% - 44px);">
    <div id="opt-chain-body"><div style="color:#333;text-align:center;padding:40px;font-size:14px;">Loading chain...</div></div>
  </div>
</div>

<!-- CALENDAR POPUP -->
<div class="drag-win" id="calWin" style="display:none;width:460px;height:380px;left:50%;top:50%;transform:translate(-50%,-50%);">
  <div class="dw-header" id="calWinHdr">
    <span id="cal-title">ECONOMIC EVENT</span>
    <button class="dw-close" onclick="closeCalPopup()">✕</button>
  </div>
  <div class="dw-body" style="padding:18px;overflow-y:auto;height:calc(100% - 44px);" id="cal-body">
    <div style="color:#333;font-size:14px;">Select an event to analyze.</div>
  </div>
</div>

<!-- ══ JAVASCRIPT ══════════════════════════════════════════════ -->
<script>

// ── CLOCK ────────────────────────────────────────────────────
function tick() {
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date());
  const el = document.getElementById('tb-clock');
  if (el) el.textContent = et + ' ET';
  updateSession();
}
setInterval(tick, 1000); tick();

// ── SESSION ───────────────────────────────────────────────────
function updateSession() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const m = et.getHours() * 60 + et.getMinutes();
  let s = 'PRE-MARKET', color = 'var(--yellow)', badge = 'PRE';
  if (m < 570)       { s = 'PRE-MARKET';  color = 'var(--yellow)'; badge = 'PRE'; }
  else if (m < 575)  { s = 'MOO WINDOW';  color = 'var(--green)';  badge = 'MOO'; }
  else if (m < 585)  { s = 'BULLET 1';    color = 'var(--green)';  badge = 'OPEN'; }
  else if (m < 640)  { s = 'TREND TIME';  color = 'var(--green)';  badge = 'OPEN'; }
  else if (m < 680)  { s = 'UK CLOSE';    color = 'var(--green)';  badge = 'OPEN'; }
  else if (m < 750)  { s = 'MIDDAY';      color = 'var(--yellow)'; badge = 'OPEN'; }
  else if (m < 870)  { s = 'AFTERNOON';   color = 'var(--green)';  badge = 'OPEN'; }
  else if (m < 950)  { s = 'PRE-MOC';     color = 'var(--yellow)'; badge = 'OPEN'; }
  else if (m < 960)  { s = 'MOC WINDOW';  color = 'var(--green)';  badge = 'MOC'; }
  else               { s = 'AFTER-HOURS'; color = 'var(--yellow)'; badge = 'CLOSED'; }
  const se = document.getElementById('tb-session');
  const mb = document.getElementById('mkt-badge');
  const ab = document.getElementById('ab-sess');
  if (se) { se.textContent = '◉ ' + s; se.style.color = color; }
  if (mb) { mb.textContent = badge; mb.style.color = badge === 'OPEN' || badge === 'MOO' || badge === 'MOC' ? 'var(--green)' : ''; }
  if (ab) ab.textContent = s;
}

// ── TAB SWITCHING ─────────────────────────────────────────────
function switchTab(id, el) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  const panel = document.getElementById('tab-' + id);
  if (panel) panel.classList.add('active');
  if (el) el.classList.add('active');
  const labels = { auto: '◈ AUTONOMOUS', monitor: '◈ MONITOR', intel: '◉ INTELLIGENCE', pnl: '$ P&L', trade: '▲ TRADE', settings: '⚙ SETTINGS' };
  const sc = document.getElementById('tb-screen');
  if (sc) sc.textContent = labels[id] || id.toUpperCase();
  if (id === 'trade') loadHankSignal();
}

// ── NEWS TABS ─────────────────────────────────────────────────
function setNewsTab(el) {
  document.querySelectorAll('.news-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
}

// ── OPTION C MINI CHAIN (AUTONOMOUS tab) ─────────────────────
function setOptTab(el, exp, id) {
  el.parentElement.querySelectorAll('.om-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  // In real implementation, refetch chain data for this expiry
}

function handleMiniExec(sym, side, strike) {
  if (side === 'wait' || !strike) return;
  const label = sym + ' $' + strike + (side === 'calls' ? 'C' : 'P') + ' 0DTE';
  confirmOrder({ label: label, details: 'Mini-chain execution · ' + side.toUpperCase() });
}

// ── OPTION B (MONITOR tab) ───────────────────────────────────
const optBData = {
  SPY:  { signal: 'TAKE CALLS', pick: 'SPY $715C 0DTE · ~$1.42 · Δ 0.41 · IV 32%', atm: 714, step: 1,   side: 'calls' },
  QQQ:  { signal: 'WAIT',       pick: 'QQQ — No signal · ATM $484 · Δ 0.50',        atm: 484, step: 1,   side: 'wait'  },
  IWM:  { signal: 'TAKE CALLS', pick: 'IWM $199C 0DTE · ~$0.82 · Δ 0.38 · IV 29%', atm: 198, step: 0.5, side: 'calls' }
};

function buildOptBLadder(sym) {
  const d = optBData[sym];
  if (!d) return;
  const banner = document.getElementById('opt-b-banner');
  const pickEl = document.getElementById('opt-b-pick');
  const tbody  = document.getElementById('opt-b-tbody');
  const execBtn= document.getElementById('opt-b-exec');
  if (banner) {
    banner.className = 'opt-b-banner' + (d.side === 'puts' ? ' puts' : '');
    banner.querySelector('.ob-action').className = 'ob-action ' + (d.side === 'calls' ? 'bull' : d.side === 'puts' ? 'bear' : 'divm');
    banner.querySelector('.ob-action').textContent = '⬡ ' + d.signal;
  }
  if (pickEl) pickEl.textContent = d.pick;
  const hankOTM = 1; // 1 step OTM
  const strikes = [];
  for (let i = -3; i <= 3; i++) strikes.push(parseFloat((d.atm + i * d.step).toFixed(2)));
  const hankStrike = d.side === 'calls' ? d.atm + hankOTM * d.step : d.side === 'puts' ? d.atm - hankOTM * d.step : null;
  let rows = '';
  // For calls: show strikes from highest (most OTM) to lowest (ITM)
  const displayStrikes = d.side === 'calls' ? [...strikes].reverse() : strikes;
  displayStrikes.forEach(s => {
    const dist = Math.abs(s - d.atm);
    const prem = Math.max(0.02, (d.atm * 0.004 * Math.exp(-dist / d.atm * 10))).toFixed(2);
    const bid  = (parseFloat(prem) - 0.01).toFixed(2);
    const ask  = (parseFloat(prem) + 0.01).toFixed(2);
    const delta = Math.max(0.05, Math.min(0.92, 0.5 - (s - d.atm) / (d.atm * 0.04))).toFixed(2);
    const iv   = (28 + dist * 1.2).toFixed(0) + '%';
    const oi   = Math.max(0.1, (8 * Math.exp(-dist * 0.3))).toFixed(1) + 'K';
    const isHank = hankStrike !== null && Math.abs(s - hankStrike) < 0.01;
    const cls  = isHank ? 'opt-b-pick' : '';
    const badge = isHank ? '<span style="color:#1a3a1a;">⬡ </span>' : '';
    rows += \`<tr class="\${cls}"><td>\${badge}$\${s}</td><td>$\${bid}</td><td>$\${ask}</td><td>$\${prem}</td><td>\${delta}</td><td>\${iv}</td><td>\${oi}</td></tr>\`;
  });
  if (tbody) tbody.innerHTML = rows;
  if (execBtn) {
    if (d.side === 'wait') {
      execBtn.textContent = '— WAIT — NO HANK SIGNAL';
      execBtn.style.opacity = '0.4';
      execBtn.onclick = null;
    } else {
      const label = sym + ' $' + hankStrike + (d.side === 'calls' ? 'C' : 'P') + ' 0DTE';
      execBtn.textContent = '▶ EXECUTE HANK PICK — ' + label;
      execBtn.style.opacity = '1';
      execBtn.onclick = () => confirmOrder({ label: label, details: 'Option B execution · ' + d.side.toUpperCase() });
    }
  }
}

let currentOptBSym = 'SPY', currentOptBExp = '0DTE';

function setOptBSym(sym, el) {
  currentOptBSym = sym;
  document.querySelectorAll('.ob-sym').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  buildOptBLadder(sym);
}

function setOptBExp(exp, el) {
  currentOptBExp = exp;
  document.querySelectorAll('.ob-exp').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  buildOptBLadder(currentOptBSym);
}

function execOptB() {
  const d = optBData[currentOptBSym];
  if (!d || d.side === 'wait') return;
  const step = d.step;
  const hankStrike = d.side === 'calls' ? (d.atm + step) : (d.atm - step);
  const label = currentOptBSym + ' $' + hankStrike + (d.side === 'calls' ? 'C' : 'P') + ' ' + currentOptBExp;
  confirmOrder({ label: label, details: 'Option B · HANK pick · ' + d.side.toUpperCase() });
}

// ── CONFIRM / EXECUTE ─────────────────────────────────────────
let pendingOrder = null;
function confirmOrder(order) {
  pendingOrder = order;
  const overlay = document.getElementById('confirmOverlay');
  document.getElementById('confirmOrder').textContent = order.label || '---';
  document.getElementById('confirmDetails').textContent = order.details || '';
  document.getElementById('paperNote').textContent = '📋 PAPER TRADE — simulated only';
  if (overlay) overlay.style.display = 'flex';
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

// ── TOAST / LOG ───────────────────────────────────────────────
function showFill(label, detail) {
  const t = document.getElementById('fillToast');
  const b = document.getElementById('fillBody');
  if (b) b.textContent = label + (detail ? ' · ' + detail : '');
  if (t) { t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 4000); }
}
const tradeLog = [];
function logTrade(order) {
  const now = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
  tradeLog.unshift({ time: now, label: order.label || '' });
  renderLog();
}
function renderLog() {
  const el = document.getElementById('tradeLog');
  if (!el) return;
  if (!tradeLog.length) { el.innerHTML = '<div style="color:#2a2a3a;font-size:13px;padding:6px;">No trades this session.</div>'; return; }
  el.innerHTML = tradeLog.slice(0,20).map(t => \`<div class="tl-row"><span class="tl-time">\${t.time}</span><span class="tl-text">\${t.label}</span></div>\`).join('');
}

// ── POSITIONS ─────────────────────────────────────────────────
const positions = [];
function renderPositions() {
  const el = document.getElementById('posTable');
  if (!el) return;
  if (!positions.length) { el.innerHTML = '<tr><td colspan="5" style="color:#2a2a3a;text-align:center;padding:14px;font-size:14px;">No open positions</td></tr>'; return; }
  el.innerHTML = positions.map(p => \`<tr><td>\${p.sym}</td><td>\${p.qty}</td><td>\${p.entry}</td><td class="\${p.pnl>=0?'bull':'bear'}">\${p.pnl>=0?'+':''}\${p.pnl.toFixed(2)}</td><td><button class="pos-close-btn" onclick="closePosition('\${p.id}')">✕</button></td></tr>\`).join('');
}
function closePosition(id) {
  const i = positions.findIndex(p => p.id === id);
  if (i === -1) return;
  const p = positions.splice(i, 1)[0];
  showFill('CLOSED ' + p.sym, 'P&L: ' + (p.pnl >= 0 ? '+' : '') + p.pnl.toFixed(2));
  renderPositions();
}
function closeAll() {
  positions.forEach(p => showFill('CLOSED ' + p.sym, ''));
  positions.length = 0;
  renderPositions();
}

// ── TRADE TAB ─────────────────────────────────────────────────
let currentSym = 'SPY', currentPrice = 714.01, currentSide = 'calls', strikeOffset = 1, currentSize = 1;

function quickSym(sym, el) {
  document.querySelectorAll('.qs-chip').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  const inp = document.getElementById('symInput');
  if (inp) inp.value = sym;
  currentSym = sym;
  fetchSymbol();
}

async function fetchSymbol() {
  const inp = document.getElementById('symInput');
  const sym = inp ? inp.value.toUpperCase().trim() : currentSym;
  if (!sym) return;
  currentSym = sym;
  const qs = document.getElementById('quoteStrip');
  if (qs) qs.innerHTML = '<span style="color:#333;font-size:14px;">Fetching ' + sym + '...</span>';
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + sym + '?interval=1m&range=1d');
    const j = await r.json();
    const meta = j?.chart?.result?.[0]?.meta;
    if (!meta) throw new Error('No data');
    const price = meta.regularMarketPrice || meta.previousClose;
    currentPrice = price;
    const prev = meta.chartPreviousClose || meta.previousClose;
    const chg = price - prev, pct = ((chg / prev) * 100).toFixed(2);
    const bull = chg >= 0;
    const hi = meta.regularMarketDayHigh?.toFixed(2) || '—';
    const lo = meta.regularMarketDayLow?.toFixed(2)  || '—';
    const vol = meta.regularMarketVolume ? (meta.regularMarketVolume / 1e6).toFixed(1) + 'M' : '—';
    if (qs) qs.innerHTML = \`<span class="qs-sym">\${sym}</span><span class="qs-price \${bull?'bull':'bear'}">\${price.toFixed(2)}</span><span class="\${bull?'bull':'bear'}">\${bull?'+':''}\${chg.toFixed(2)} (\${bull?'+':''}\${pct}%)</span><span class="qs-item"><span class="qs-lbl">Hi</span>\${hi}</span><span class="qs-item"><span class="qs-lbl">Lo</span>\${lo}</span><span class="qs-item"><span class="qs-lbl">Vol</span>\${vol}</span>\`;
    calcStrike(); updateOrder();
  } catch(e) {
    if (qs) qs.innerHTML = '<span style="color:var(--red);font-size:14px;">Error: ' + e.message + '</span>';
  }
}

function setSide(side, el) {
  currentSide = side;
  document.querySelectorAll('.side-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  calcStrike(); updateOrder();
}

function getStrikeStep(p) {
  if (p < 25) return 0.5; if (p < 100) return 1; if (p < 200) return 2; if (p < 500) return 5; return 10;
}

function calcStrike() {
  const step = getStrikeStep(currentPrice);
  const atm   = Math.round(currentPrice / step) * step;
  const strike = (atm + strikeOffset * step * (currentSide === 'puts' ? -1 : 1)).toFixed(1);
  const el = document.getElementById('strikeDisplay');
  if (el) el.textContent = '$' + strike;
  return parseFloat(strike);
}

function adjustStrike(dir) {
  strikeOffset = Math.max(-10, Math.min(10, strikeOffset + dir));
  calcStrike(); updateOrder();
}

function setSize(n, el) {
  currentSize = n;
  document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  updateOrder();
}

function updateOrder() {
  const preview = document.getElementById('orderPreview');
  if (!preview) return;
  const strike = calcStrike();
  const est = (currentPrice * 0.004 * (currentSide === 'puts' ? 1.15 : 1)).toFixed(2);
  preview.innerHTML = \`
    <div class="op-row"><span class="op-lbl">Symbol</span><span class="op-val">\${currentSym}</span></div>
    <div class="op-row"><span class="op-lbl">Action</span><span class="op-val \${currentSide==='calls'?'bull':'bear'}">\${currentSide==='calls'?'BUY CALL':'BUY PUT'}</span></div>
    <div class="op-row"><span class="op-lbl">Strike</span><span class="op-val">$\${strike}</span></div>
    <div class="op-row"><span class="op-lbl">Expiry</span><span class="op-val">0DTE</span></div>
    <div class="op-row"><span class="op-lbl">Qty</span><span class="op-val">\${currentSize} contract\${currentSize>1?'s':''}</span></div>
    <div class="op-row"><span class="op-lbl">Est. Premium</span><span class="op-val">~$\${est}</span></div>
    <div class="op-row"><span class="op-lbl">Est. Cost</span><span class="op-val">~$\${(parseFloat(est)*100*currentSize).toFixed(0)}</span></div>
  \`;
}

function handleConfirmOrder() {
  const strike = calcStrike();
  const est = (currentPrice * 0.004).toFixed(2);
  confirmOrder({ label: currentSym + ' $' + strike + (currentSide==='calls'?'C':'P') + ' 0DTE x' + currentSize, details: '~$' + est + '/contract' });
}

function loadHankSignal() {
  const b = document.getElementById('hankSignalBanner');
  if (!b) return;
  b.innerHTML = \`
    <div class="master-sig ms-calls" style="font-size:20px;padding:10px 16px;margin-bottom:8px;">⬡ TAKE CALLS — HIGH</div>
    <div style="font-size:14px;color:#aaa;">SPY 4/6 BULL · TICK +642 · VWAP +$2.02 · MOO $2.4B · W3 3/4</div>
    <button style="margin-top:10px;padding:8px 18px;background:#0a1a0a;border:1px solid var(--green);color:var(--green);font-family:var(--mono);font-size:14px;cursor:pointer;" onclick="applyHankSignal()">APPLY SIGNAL →</button>
  \`;
}

function applyHankSignal() {
  const inp = document.getElementById('symInput');
  if (inp) inp.value = 'SPY';
  currentSym = 'SPY'; currentSide = 'calls'; strikeOffset = 1;
  document.querySelectorAll('.side-btn').forEach(b => b.classList.toggle('active', b.dataset.side === 'calls'));
  fetchSymbol();
}

// ── AUTO-TRADE ENGINE ─────────────────────────────────────────
let autoArmed = false, autoTimer = null;
function toggleAutoArm() {
  autoArmed = !autoArmed;
  const btn = document.getElementById('armBtn');
  const st  = document.getElementById('auto-status-mini');
  if (autoArmed) {
    if (btn) { btn.textContent = '⬡ ARMED — CLICK TO DISARM'; btn.style.color = 'var(--green)'; btn.style.borderColor = 'var(--green)'; }
    if (st) st.textContent = 'ARMED · Monitoring for HIGH conf signals';
  } else {
    if (btn) { btn.textContent = '⬡ ARM AUTO-TRADE'; btn.style.color = ''; btn.style.borderColor = ''; }
    if (st) st.textContent = 'OFF · Manual confirmation required';
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
  }
}
function haltAll() {
  autoArmed = false; closeAll();
  const btn = document.getElementById('armBtn');
  const st  = document.getElementById('auto-status-mini');
  if (btn) { btn.textContent = '⬡ ARM AUTO-TRADE'; btn.style.color = ''; }
  if (st) st.textContent = 'HALTED';
}

// ── SERVICES ──────────────────────────────────────────────────
const svcState = { monitor:true, qqq:true, iwm:true, news:true, moc:false, mailer:false, theta:false, ws:false };
function svcToggle(name) {
  svcState[name] = !svcState[name];
  const dot = document.getElementById('sd-' + name);
  const btn = dot?.parentElement?.querySelector('.svc-btn');
  if (dot) dot.className = 'svc-dot-sm ' + (svcState[name] ? 'run' : 'stop');
  if (btn) btn.textContent = svcState[name] ? '■' : '▶';
  const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
  const log = document.getElementById('svcLog');
  if (log) {
    const d = document.createElement('div');
    d.className = 'll ' + (svcState[name] ? 'g' : 'r');
    d.textContent = '[' + now + '] ' + name + (svcState[name] ? ' started' : ' stopped');
    log.prepend(d);
    while (log.children.length > 8) log.removeChild(log.lastChild);
  }
}

// ── SETTINGS ──────────────────────────────────────────────────
function setSettingMode(mode, el) {
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
}
function setToggle(el) { el.classList.toggle('active'); el.textContent = el.classList.contains('active') ? 'ON' : 'OFF'; }
function saveRiskSettings() { showFill('Risk settings saved', 'Applied to session'); }
function testConnection(svc) { showFill('Testing ' + svc + '...', 'Check terminal for result'); }
function launchTradingView() {
  const btn = document.getElementById('tvLaunchBtn');
  if (btn) { btn.textContent = '⏳ LAUNCHING…'; btn.disabled = true; }
  fetch('http://localhost:5001/launch-tv', { method: 'POST' })
    .then(r => r.json())
    .then(d => { if (btn) { btn.textContent = d.success ? '✓ TRADINGVIEW OPEN' : '⚠ LAUNCH FAILED'; btn.disabled = false; } })
    .catch(() => { if (btn) { btn.textContent = '⚠ SERVER OFFLINE — run node wsServer.js'; btn.disabled = false; } });
}
function reAuthWebull() { alert('Open terminal and run: node webull.js --login'); }

// ── CHAT ──────────────────────────────────────────────────────
let chatOpen = false;
function toggleChat() {
  chatOpen = !chatOpen;
  const win = document.getElementById('chatWin');
  const btn = document.getElementById('askHankBtn');
  if (win) win.style.display = chatOpen ? 'flex' : 'none';
  if (btn) btn.textContent = chatOpen ? '✕ CLOSE' : '⬡ ASK HANK';
  if (chatOpen) setTimeout(() => document.getElementById('chatInput')?.focus(), 50);
}
async function sendChat() {
  const inp  = document.getElementById('chatInput');
  const msgs = document.getElementById('chatMsgs');
  if (!inp || !msgs) return;
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  const u = document.createElement('div'); u.className = 'chat-msg user-msg';
  u.innerHTML = '<span class="cm-who">YOU</span><span class="cm-text">' + text + '</span>';
  msgs.appendChild(u); msgs.scrollTop = msgs.scrollHeight;
  const map = { signal:'Current: TAKE CALLS HIGH. SPY 4/6 BULL, TICK +642, VWAP +$2.02. Entry: SPY $715C 0DTE.', spy:'SPY 714.01 — above VWAP $711.99 and 9EMA $713.44. Resistance $714.47 PDH. Trend time active.', qqq:'QQQ 484.20 — below VWAP $484.42. NQ lagging ES. WAIT signal. No position.', iwm:'IWM 198.44 — above VWAP $197.56, 9EMA rising. CALLS signal, B2 pending $199 breakout.' };
  const lower = text.toLowerCase();
  let reply = 'Analyzing: SPY bullish above VWAP. Fade bias active on low volume. FOMC risk today. Size down near $714.47 PDH.';
  for (const [k,v] of Object.entries(map)) if (lower.includes(k)) { reply = v; break; }
  await new Promise(r => setTimeout(r, 500));
  const h = document.createElement('div'); h.className = 'chat-msg hank-msg';
  h.innerHTML = '<span class="cm-who">⬡ HANK</span><span class="cm-text">' + reply + '</span>';
  msgs.appendChild(h); msgs.scrollTop = msgs.scrollHeight;
}

// ── OPTIONS CHAIN (from INTELLIGENCE/EARNINGS) ────────────────
let optSym = '', optPrice = 0, optIV = 50;
function openOptionsChain(sym, price, iv) {
  optSym = sym; optPrice = parseFloat(price); optIV = parseInt(iv);
  const win = document.getElementById('optWin');
  document.getElementById('opt-title').textContent = 'OPTIONS CHAIN — ' + sym + ' $' + price;
  if (win) win.style.display = 'flex';
  buildChain('0DTE');
}
function closeOptions() { const w = document.getElementById('optWin'); if (w) w.style.display = 'none'; }
function buildChain(exp) {
  const body = document.getElementById('opt-chain-body');
  if (!body) return;
  const step = getStrikeStep(optPrice);
  const atm  = Math.round(optPrice / step) * step;
  const stks = []; for (let i = -5; i <= 5; i++) stks.push((atm + i * step).toFixed(2));
  let html = \`<div style="font-size:13px;color:#555;margin-bottom:10px;">IV Rank: \${optIV} · Expiry: \${exp}</div>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <thead><tr style="color:#333;border-bottom:1px solid #111;">
      <th style="padding:5px;text-align:left;">CALLS</th><th style="padding:5px;text-align:center;">BID</th><th style="padding:5px;text-align:center;">ASK</th>
      <th style="padding:5px;text-align:center;color:var(--yellow);">STRIKE</th>
      <th style="padding:5px;text-align:center;">BID</th><th style="padding:5px;text-align:center;">ASK</th><th style="padding:5px;text-align:right;">PUTS</th>
    </tr></thead><tbody>\`;
  stks.forEach(s => {
    const sf = parseFloat(s), dist = Math.abs(sf - atm);
    const cp = Math.max(0.01, (optPrice * (optIV/100) * 0.1 * Math.exp(-dist/optPrice*15)*(sf<optPrice?1+(optPrice-sf)/optPrice:1))).toFixed(2);
    const pp = Math.max(0.01, (optPrice * (optIV/100) * 0.1 * Math.exp(-dist/optPrice*15)*(sf>optPrice?1+(sf-optPrice)/optPrice:1))).toFixed(2);
    const atms = sf === atm ? 'color:var(--yellow);font-weight:bold;' : 'color:#666;';
    html += \`<tr style="cursor:pointer;" onclick="closeOptions()">
      <td style="padding:5px;color:\${sf<=optPrice?'var(--green)':'#444'};">\${sf<=optPrice?'ITM':'OTM'}</td>
      <td style="padding:5px;text-align:center;color:var(--green);">$\${cp}</td><td style="padding:5px;text-align:center;color:var(--green);">$\${(parseFloat(cp)+0.01).toFixed(2)}</td>
      <td style="padding:5px;text-align:center;\${atms}">$\${s}</td>
      <td style="padding:5px;text-align:center;color:var(--red);">$\${pp}</td><td style="padding:5px;text-align:center;color:var(--red);">$\${(parseFloat(pp)+0.01).toFixed(2)}</td>
      <td style="padding:5px;text-align:right;color:\${sf>=optPrice?'var(--red)':'#444'};">\${sf>=optPrice?'ITM':'OTM'}</td>
    </tr>\`;
  });
  html += '</tbody></table>';
  body.innerHTML = html;
}

// ── CALENDAR POPUP ────────────────────────────────────────────
const calData = {
  fomc:    { title:'FOMC Day 1', date:'TODAY · ALL DAY', impact:'HIGH', body:'<div class="cal-section"><div class="cal-lbl">TRADING RULES</div><div class="cal-text">Reduce size 50% going into 14:00. No new positions after 13:30. Fade the initial knee-jerk reaction. Real direction comes after Powell.</div></div><div class="cal-section"><div class="cal-lbl">HANK PLAN</div><div class="cal-text bear">SIZE DOWN. Exit B1 by 13:00 regardless of P&L.</div></div>' },
  durable: { title:'Durable Goods', date:'TODAY · 08:30', impact:'HIGH', body:'<div class="cal-section"><div class="cal-lbl">EXPECTED</div><div class="cal-text">+0.1% MoM · Ex-transport: +0.3%</div></div><div class="cal-section"><div class="cal-lbl">PLAN</div><div class="cal-text">>+1.0% beat → calls on SPY. <0.5% miss → FOMC dampens move, be careful.</div></div>' },
  gdp:     { title:'GDP Q1 Advance', date:'Apr 28 · 08:30', impact:'HIGH', body:'<div class="cal-section"><div class="cal-lbl">EXPECTED</div><div class="cal-text">+0.3% annualized</div></div><div class="cal-section"><div class="cal-lbl">RISK</div><div class="cal-text bear">Negative print = recession fears. Wait 3min before entering.</div></div>' },
  pce:     { title:'PCE Price Index', date:'Apr 29 · 08:30', impact:'HIGH', body:'<div class="cal-section"><div class="cal-lbl">EXPECTED</div><div class="cal-text">Core PCE 2.6% YoY</div></div><div class="cal-section"><div class="cal-lbl">FED IMPLICATIONS</div><div class="cal-text">Hot print delays cuts. Cool print → rally into FOMC.</div></div>' },
  fomc_dec:{ title:'FOMC Decision', date:'Apr 29 · 14:00', impact:'HIGH', body:'<div class="cal-section"><div class="cal-lbl">CONSENSUS</div><div class="cal-text">HOLD. Focus on statement language.</div></div><div class="cal-section"><div class="cal-lbl">PLAN</div><div class="cal-text bear">Be flat going in. Fade initial move. Real direction after Powell 14:30.</div></div>' },
  powell:  { title:'Powell Presser', date:'Apr 29 · 14:30', impact:'HIGH', body:'<div class="cal-section"><div class="cal-lbl">PATTERN</div><div class="cal-text">First 5min = spike. 10-20min = real direction. 30min = fade exhaustion.</div></div><div class="cal-section"><div class="cal-lbl">PLAN</div><div class="cal-text bull">Bullish tone → MOC calls by 15:45. Hawkish → flat or small puts.</div></div>' },
  nfp:     { title:'NFP + Unemployment', date:'May 1 · 08:30', impact:'HIGH', body:'<div class="cal-section"><div class="cal-lbl">EXPECTED</div><div class="cal-text">+185K jobs · Unemp 3.8%</div></div><div class="cal-section"><div class="cal-lbl">RULES</div><div class="cal-text">Wait 3min. Hot >250K + low unemp → fade rally. Weak <100K → puts. Goldilocks → calls.</div></div>' }
};
function openCalPopup(key) {
  const d = calData[key]; if (!d) return;
  const win = document.getElementById('calWin');
  document.getElementById('cal-title').textContent = d.title + ' · ' + d.date;
  document.getElementById('cal-body').innerHTML = '<div style="display:inline-block;padding:4px 12px;border:1px solid var(--red);color:var(--red);font-size:13px;letter-spacing:2px;margin-bottom:14px;">⚠ ' + d.impact + ' IMPACT</div>' + d.body;
  if (win) win.style.display = 'flex';
}
function closeCalPopup() { const w = document.getElementById('calWin'); if (w) w.style.display = 'none'; }

// ── DRAGGABLE WINDOWS ─────────────────────────────────────────
function makeDraggable(win, hdr) {
  if (!win || !hdr) return;
  let ox=0, oy=0, sx=0, sy=0;
  hdr.onmousedown = e => {
    e.preventDefault(); sx=e.clientX; sy=e.clientY; ox=win.offsetLeft; oy=win.offsetTop;
    document.onmousemove = ev => { win.style.left=(ox+ev.clientX-sx)+'px'; win.style.top=(oy+ev.clientY-sy)+'px'; win.style.transform='none'; win.style.right='auto'; win.style.bottom='auto'; };
    document.onmouseup = () => { document.onmousemove=null; document.onmouseup=null; };
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
  buildOptBLadder('SPY');
})();

</script>
</body>
</html>`;

fs.appendFileSync(file, s9);
console.log('S9 done:', s9.length);
