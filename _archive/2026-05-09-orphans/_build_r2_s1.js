const fs = require('fs');
const file = 'C:\\Users\\tomav\\tradingview-mcp-jackson\\hank-electron-r2.html';
fs.writeFileSync(file, '');

const s1 = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>HANK AI — R2</title>
<style>
/* ═══ DESIGN SYSTEM — Screen 1 / Screen 2 exact match ══════════ */
* { margin:0; padding:0; box-sizing:border-box; }
:root {
  --bg:     #080810;
  --bg1:    #06060f;
  --bg2:    #0b0b16;
  --bg3:    #0e1822;
  --bg4:    #0a0a18;
  --border: #111;
  --border2:#181828;
  --green:  #00ff88;
  --red:    #ff4444;
  --yellow: #ffaa00;
  --blue:   #00aaff;
  --purple: #aa88ff;
  --dim:    #444;
  --mid:    #555;
  --text:   #e0e0e0;
  --white:  #ffffff;
  --mono:   'Consolas','Courier New',monospace;
}
html, body { width:100%; height:100%; overflow:hidden; background:var(--bg); color:var(--text); font-family:var(--mono); font-size:13px; }

/* ═══ SHELL ════════════════════════════════════════════════════ */
#shell { display:grid; grid-template-rows:52px 1fr; height:100vh; width:100vw; }
#main-area { display:grid; grid-template-columns:200px 1fr; overflow:hidden; }

/* ═══ TOPBAR — exact Screen 1 ══════════════════════════════════ */
#topbar {
  background:#0b0b18;
  border-bottom:2px solid #00ff8844;
  display:flex; align-items:center;
  padding:0 16px; gap:12px; overflow:hidden; flex-shrink:0;
}
.tb-logo { color:var(--green); font-weight:bold; font-size:20px; letter-spacing:3px; white-space:nowrap; }
.tb-div  { color:#1a1a30; font-size:20px; flex-shrink:0; }
.tb-clock { color:var(--green); font-size:17px; font-weight:bold; min-width:120px; }
.tb-session {
  background:#001a00; border:1px solid #00ff8855;
  color:var(--green); font-size:12px;
  padding:3px 10px; border-radius:2px; letter-spacing:1px; white-space:nowrap;
}
.tb-screen {
  background:#0a0a20; border:1px solid #3333ff44;
  color:#6666ff; font-size:11px;
  padding:3px 8px; border-radius:2px; letter-spacing:1px; white-space:nowrap;
  transition:all 0.2s;
}
.tb-fut { display:flex; gap:5px; align-items:center; }
.tb-fut-sym { color:var(--mid); font-size:12px; }
.tb-up  { color:var(--green); font-size:13px; font-weight:bold; }
.tb-dn  { color:var(--red);   font-size:13px; font-weight:bold; }
.tb-dots { margin-left:auto; display:flex; gap:10px; align-items:center; flex-shrink:0; }
.tb-dot-group { display:flex; align-items:center; gap:4px; }
.tb-dot { width:9px; height:9px; border-radius:50%; }
.tb-dot.g { background:var(--green); box-shadow:0 0 6px var(--green); }
.tb-dot.y { background:var(--yellow); box-shadow:0 0 4px var(--yellow); }
.tb-dot.r { background:var(--red); }
.tb-dot-lbl { font-size:10px; color:var(--mid); }
.tb-mkt { font-size:11px; font-weight:bold; padding:2px 8px; letter-spacing:1px; flex-shrink:0; }
.mkt-open   { color:var(--green); border:1px solid var(--green); background:rgba(0,255,136,0.07); }
.mkt-closed { color:var(--mid);   border:1px solid #1a1a2a;      background:var(--bg2); }
.mkt-ext    { color:var(--yellow);border:1px solid var(--yellow); background:rgba(255,170,0,0.07); }

/* ═══ SIDEBAR ═══════════════════════════════════════════════════ */
#sidebar {
  background:#08080f;
  border-right:1px solid #111;
  display:flex; flex-direction:column; overflow:hidden;
}
.nav-tabs { display:flex; flex-direction:column; padding:6px 0; border-bottom:1px solid #111; }
.nav-tab {
  display:flex; align-items:center; gap:8px;
  padding:9px 12px;
  color:var(--mid); font-size:11px; letter-spacing:1px;
  cursor:pointer; border-left:3px solid transparent;
  transition:all 0.12s; user-select:none; white-space:nowrap;
}
.nav-tab:hover { background:var(--bg2); color:var(--text); }
.nav-tab.active { color:var(--green); border-left-color:var(--green); background:rgba(0,255,136,0.04); }
.nav-icon { font-size:13px; width:16px; text-align:center; flex-shrink:0; }
.svc-panel { flex:1; overflow-y:auto; padding:8px 0; border-bottom:1px solid #111; }
.svc-title { color:#1a1a2a; font-size:10px; letter-spacing:2px; padding:4px 12px 4px; text-transform:uppercase; }
.svc-row {
  display:flex; align-items:center; gap:6px;
  padding:5px 10px; border-bottom:1px solid rgba(17,17,17,0.8);
}
.svc-dot-sm { width:6px; height:6px; border-radius:50%; flex-shrink:0; background:var(--border2); }
.svc-dot-sm.run { background:var(--green); box-shadow:0 0 4px rgba(0,255,136,0.5); animation:pdot 2s ease-in-out infinite; }
.svc-dot-sm.stop { background:var(--red); }
.svc-dot-sm.init { background:var(--yellow); animation:pdot 0.5s ease-in-out infinite; }
.svc-name { flex:1; color:var(--text); font-size:10px; }
.svc-btn {
  font-size:9px; padding:2px 6px; cursor:pointer;
  background:var(--bg2); color:var(--mid); border:1px solid #1a1a2a;
  font-family:var(--mono);
}
.svc-btn:hover { color:var(--green); border-color:rgba(0,255,136,0.3); }
.log-mini {
  height:90px; border-top:1px solid #111;
  background:var(--bg1); overflow-y:auto; padding:4px 8px;
  font-size:10px; color:#2a2a3a; flex-shrink:0;
}
.log-mini .ll { line-height:1.7; }
.log-mini .ll.g { color:rgba(0,255,136,0.5); }
.log-mini .ll.r { color:rgba(255,68,68,0.5); }
.log-mini .ll.y { color:rgba(255,170,0,0.5); }
@keyframes pdot { 0%,100%{opacity:1}50%{opacity:0.3} }

/* ═══ CONTENT ═══════════════════════════════════════════════════ */
#content { overflow:hidden; position:relative; background:var(--bg); }
.tab-panel { display:none; width:100%; height:100%; flex-direction:column; overflow:hidden; }
.tab-panel.active { display:flex; }

/* ═══ SHARED PANEL COMPONENTS — Screen 1/2 exact ═══════════════ */
.panel { background:var(--bg2); display:flex; flex-direction:column; overflow:hidden; }
.ph {
  background:var(--bg3); padding:7px 14px;
  border-bottom:2px solid #0d2818;
  display:flex; justify-content:space-between; align-items:center;
  flex-shrink:0;
}
.pt { color:var(--green); font-size:13px; font-weight:bold; letter-spacing:2px; }
.ps { color:var(--dim); font-size:11px; }
.pb { flex:1; padding:12px 16px; overflow-y:auto; }
.pb::-webkit-scrollbar { width:3px; }
.pb::-webkit-scrollbar-thumb { background:var(--border2); }

/* ═══ BADGES ═══════════════════════════════════════════════════ */
.badge { font-size:12px; padding:3px 9px; border-radius:2px; font-weight:bold; }
.bb { background:#001f00; color:var(--green); border:1px solid #00ff8844; }
.br { background:#1f0000; color:var(--red);   border:1px solid #ff444444; }
.bp { background:#00111f; color:var(--blue);  border:1px solid #00aaff44; }
.bm { background:#1f1000; color:var(--yellow);border:1px solid #ffaa0044; }
.bull { color:var(--green); }
.bear { color:var(--red); }
.divp { color:var(--blue); }
.divm { color:var(--yellow); }

/* ═══ MONITOR TABLE — Screen 1 exact ═══════════════════════════ */
.mon-table { width:100%; border-collapse:collapse; }
.mon-table th {
  color:#00cc66; font-size:12px; font-weight:bold;
  text-align:left; padding:5px 9px;
  border-bottom:2px solid #0d2818;
  letter-spacing:1px; background:#0a1018;
}
.mon-table td { padding:9px 9px; font-size:15px; border-bottom:1px solid #0c0c1c; }
.mon-table .sym { color:#fff; font-weight:bold; font-size:17px; letter-spacing:1px; }

/* ═══ SPY BLOCK ═════════════════════════════════════════════════ */
.spy-block {
  margin-top:10px; padding:12px;
  background:#080814; border:1px solid var(--border2); border-radius:4px;
}
.spy-header  { display:flex; align-items:center; gap:14px; margin-bottom:8px; }
.spy-lbl-sm  { color:var(--dim); font-size:12px; margin-bottom:3px; }
.spy-price   { font-size:40px; font-weight:bold; color:var(--green); line-height:1; }
.spy-grid    { flex:1; margin-left:14px; display:grid; grid-template-columns:1fr 1fr; gap:2px; }
.spy-row     { display:flex; justify-content:space-between; font-size:13px; padding:3px 0; border-bottom:1px solid #0f0f1c; }
.spy-lbl     { color:var(--dim); }
.confluence  {
  margin-top:8px; color:var(--yellow); font-size:12px;
  padding:6px 10px; background:#181000;
  border:1px solid #ffaa0033; border-radius:3px;
}

/* ═══ SIGNAL BOX ════════════════════════════════════════════════ */
.signal-box  { margin-top:10px; padding:16px; border-radius:4px; }
.sig-calls   { border:2px solid var(--green); background:#001800; }
.sig-puts    { border:2px solid var(--red);   background:#180000; }
.sig-wait    { border:2px solid var(--yellow);background:#181000; }
.sig-chop    { border:2px solid #333;         background:#0f0f0f; }
.sig-action  { font-size:28px; font-weight:bold; letter-spacing:2px; }
.sig-conf    { font-size:14px; margin-top:4px; }
.sig-reason  { font-size:13px; color:#777; margin-top:4px; line-height:1.5; }
.sig-strike  { font-size:14px; color:var(--blue); margin-top:8px; padding-top:8px; border-top:1px solid #1a1a2a; }

/* ═══ ANALYSIS FEED ═════════════════════════════════════════════ */
.analysis-feed {
  margin-top:10px; background:#060610;
  border:1px solid #1a1a2a; border-left:3px solid #00ff8844;
  border-radius:4px; overflow:hidden;
}
.af-header {
  display:flex; justify-content:space-between; align-items:center;
  padding:6px 10px; background:#0a0a18; border-bottom:1px solid #111;
}
.af-title { color:var(--green); font-size:10px; font-weight:bold; letter-spacing:2px; }
.af-pulse { width:7px; height:7px; border-radius:50%; background:var(--green); box-shadow:0 0 5px var(--green); animation:apulse 2s infinite; }
@keyframes apulse { 0%,100%{opacity:1;box-shadow:0 0 5px var(--green)}50%{opacity:0.4;box-shadow:none} }
.af-body { padding:6px 10px; max-height:140px; overflow-y:auto; }
.af-body::-webkit-scrollbar { width:2px; }
.af-body::-webkit-scrollbar-thumb { background:var(--border2); }
.af-entry { padding:5px 0; border-bottom:1px solid #0f0f18; display:flex; gap:8px; }
.af-entry:last-child { border-bottom:none; }
.af-time  { color:#333; font-size:10px; min-width:52px; padding-top:2px; flex-shrink:0; }
.af-text  { font-size:12px; color:#aaa; line-height:1.5; }
.af-text .af-bull { color:var(--green); }
.af-text .af-bear { color:var(--red); }
.af-text .af-warn { color:var(--yellow); }
.af-text .af-blue { color:var(--blue); }
.af-latest .af-text { color:#ccc; }

/* ═══ ACCOUNT + BULLETS ═════════════════════════════════════════ */
.ar { display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid #0c0c1c; font-size:14px; }
.al { color:var(--mid); }
.av { font-weight:bold; }
.bullets { display:flex; gap:4px; margin-top:10px; }
.blt { flex:1; padding:9px 0; border-radius:3px; text-align:center; font-size:13px; font-weight:bold; }
.blt-used  { background:#002200; color:var(--green); border:1px solid #00ff8866; }
.blt-avail { background:#0f0f18; color:var(--dim);   border:1px solid #1a1a2a; }
.ov-row { margin-top:10px; display:flex; gap:6px; align-items:center; }
.ov-lbl { font-size:12px; color:var(--mid); }
.ov-input {
  flex:1; background:#0f0f18; border:1px solid #1a1a2a;
  border-radius:3px; padding:7px; text-align:center;
  font-size:16px; color:#fff; font-family:var(--mono); outline:none;
}
.ov-btn {
  background:#001800; border:1px solid #00ff8866; border-radius:3px;
  padding:7px 14px; font-size:13px; color:var(--green);
  cursor:pointer; font-family:var(--mono); letter-spacing:1px;
}
.ov-btn:hover { background:#002800; }

/* ═══ IMB CARDS ══════════════════════════════════════════════════ */
.imb-card { margin:8px 0; padding:10px 12px; border-radius:5px; border-left:5px solid; }
.imb-green  { background:#001f00; border-color:var(--green); box-shadow:0 0 12px #00ff8818; }
.imb-yellow { background:#1a1200; border-color:var(--yellow); box-shadow:0 0 10px #ffaa0012; }
.imb-gray   { background:#0f0f12; border-color:#333; }
.imb-dollar { font-size:18px; font-weight:bold; }
.imb-green  .imb-dollar { color:var(--green); }
.imb-yellow .imb-dollar { color:var(--yellow); }
.imb-gray   .imb-dollar { color:var(--dim); }
.imb-signal { margin-top:7px; padding:5px 9px; border-radius:3px; font-size:13px; font-weight:bold; }
.imb-green  .imb-signal { background:#002800; border:1px solid #00ff8866; color:var(--green); }
.imb-yellow .imb-signal { background:#1f1500; border:1px solid #ffaa0055; color:var(--yellow); }
.imb-row { display:flex; gap:14px; align-items:flex-end; margin-top:5px; flex-wrap:wrap; }
.imb-col { display:flex; flex-direction:column; gap:2px; }
.imb-lbl  { font-size:10px; color:var(--mid); letter-spacing:1px; }
.imb-val  { font-size:12px; }
.imb-type { font-size:11px; font-weight:bold; letter-spacing:1px; margin-bottom:2px; }

/* ═══ WIN3 ══════════════════════════════════════════════════════ */
.win3     { margin-top:8px; padding:9px 12px; background:#080814; border:1px solid var(--border2); border-radius:4px; }
.win3-lbl { color:var(--dim); font-size:11px; letter-spacing:1px; margin-bottom:6px; }
.win3-row { display:flex; gap:14px; flex-wrap:wrap; }
.win3-item { display:flex; gap:5px; align-items:center; font-size:13px; }
.win3-sym  { color:#fff; font-weight:bold; }
.win3-conf { font-size:12px; color:var(--green); margin-top:5px; }

/* ═══ INFOBAR ════════════════════════════════════════════════════ */
.infobar {
  background:#06060f; border-bottom:1px solid #111;
  display:flex; align-items:center;
  padding:0 16px; gap:16px; font-size:12px; flex-shrink:0; min-height:30px; overflow:hidden;
}
.ib-lbl  { color:var(--dim); }
.ib-good { color:var(--green); }
.ib-warn { color:var(--yellow); }
.ib-val  { color:#777; }

/* ═══ AUTONOMOUS TAB ════════════════════════════════════════════ */
.auto-layout {
  display:grid;
  grid-template-columns:1fr 1fr 1fr 340px;
  flex:1; min-height:0;
  height:calc(100% - 52px);
}
.inst-col {
  display:flex; flex-direction:column;
  border-right:1px solid #111; min-height:0; overflow:hidden;
}
.inst-col:last-child { border-right:none; }
.sig-card { padding:10px 12px 8px; border-bottom:1px solid #111; flex-shrink:0; }
.sc-sym   { font-size:16px; font-weight:bold; color:#fff; letter-spacing:2px; margin-bottom:2px; }
.sc-price { font-size:22px; letter-spacing:1px; margin-bottom:6px; }
.sc-action {
  font-size:13px; font-weight:bold; letter-spacing:1px;
  padding:7px 10px; margin-bottom:5px;
  display:flex; align-items:center; gap:6px;
}
.sca-calls { background:rgba(0,255,136,0.1); border:1px solid rgba(0,255,136,0.35); color:var(--green); }
.sca-puts  { background:rgba(255,68,68,0.1); border:1px solid rgba(255,68,68,0.35); color:var(--red); }
.sca-wait  { background:rgba(255,170,0,0.07); border:1px solid rgba(255,170,0,0.25); color:var(--yellow); }
.sca-chop  { background:var(--bg2); border:1px solid #1a1a2a; color:var(--dim); }
.sc-conf { display:flex; gap:6px; align-items:center; margin-bottom:3px; }
.conf-hi { font-size:10px; font-weight:bold; letter-spacing:1px; padding:1px 6px; color:var(--green); background:rgba(0,255,136,0.1); border:1px solid rgba(0,255,136,0.3); }
.conf-md { font-size:10px; font-weight:bold; letter-spacing:1px; padding:1px 6px; color:var(--yellow); background:rgba(255,170,0,0.1); border:1px solid rgba(255,170,0,0.25); }
.conf-wk { font-size:10px; font-weight:bold; letter-spacing:1px; padding:1px 6px; color:var(--mid); background:var(--bg2); border:1px solid #1a1a2a; }
.sc-reason { font-size:10px; color:var(--text); line-height:1.5; }
.mkt-state { flex:1; padding:8px 12px; border-bottom:1px solid #111; overflow-y:auto; min-height:0; }
.mkt-row {
  display:flex; justify-content:space-between; align-items:center;
  padding:3px 0; border-bottom:1px solid rgba(17,17,17,0.6); font-size:11px;
}
.mkt-row:last-child { border-bottom:none; }
.mkt-k { color:var(--mid); letter-spacing:0.5px; font-size:10px; }
.mkt-v { color:#fff; font-weight:bold; }
.mkt-v.pos { color:var(--green); }
.mkt-v.neg { color:var(--red); }
.mkt-v.neu { color:var(--yellow); }
.trade-card { padding:8px 12px; flex-shrink:0; background:var(--bg3); border-top:1px solid #111; }
.tc-hdr { font-size:10px; color:var(--dim); letter-spacing:1.5px; margin-bottom:5px; }
.tc-pos {
  padding:6px 8px; margin-bottom:5px;
  background:rgba(0,212,255,0.04); border:1px solid rgba(0,212,255,0.2);
  font-size:10px; line-height:1.7;
}
.tc-pos .tct { color:var(--blue); font-weight:bold; font-size:11px; margin-bottom:1px; }
.tc-none { padding:5px 8px; background:var(--bg2); border:1px solid #111; font-size:10px; color:var(--dim); }
.tc-pnl-p { color:var(--green); font-weight:bold; }
.tc-pnl-n { color:var(--red); font-weight:bold; }
.analysis-col {
  display:flex; flex-direction:column;
  background:var(--bg1); min-height:0; overflow:hidden;
}
.ac-header {
  padding:8px 12px; border-bottom:1px solid #111;
  display:flex; justify-content:space-between; align-items:center; flex-shrink:0;
}
.ac-title { color:var(--green); font-size:11px; font-weight:bold; letter-spacing:2px; }
.ac-time  { color:var(--dim); font-size:10px; }
.ac-body  { flex:1; overflow-y:auto; padding:10px 12px; min-height:0; }
.ac-para  { font-size:11px; color:var(--text); line-height:1.8; margin-bottom:8px; }
.ac-para .hl-bull { color:var(--green); font-weight:bold; }
.ac-para .hl-bear { color:var(--red); font-weight:bold; }
.ac-para .hl-num  { color:var(--blue); }
.ac-para .hl-warn { color:var(--yellow); }
.ac-entry {
  margin-top:6px; padding:7px 9px;
  background:rgba(0,255,136,0.05); border:1px solid rgba(0,255,136,0.2);
  font-size:11px; line-height:1.7;
}
.ae-row { display:flex; justify-content:space-between; }
.ae-lbl { color:var(--mid); }
.ae-val { color:var(--green); font-weight:bold; }
.ae-val.r { color:var(--red); }
.pdot { width:6px; height:6px; border-radius:50%; background:var(--green); display:inline-block; animation:pdot 1.5s ease-in-out infinite; margin-right:5px; }
.auto-bottom {
  height:52px; background:#0b0b18;
  border-top:2px solid #1a1a30;
  display:flex; align-items:center;
  padding:0 14px; gap:20px; flex-shrink:0;
}
.master-sig {
  display:flex; align-items:center; gap:8px;
  padding:5px 14px; font-size:13px; font-weight:bold; letter-spacing:2px;
}
.ms-calls { color:var(--green); background:rgba(0,255,136,0.1); border:1px solid rgba(0,255,136,0.35); }
.ms-puts  { color:var(--red);   background:rgba(255,68,68,0.1);  border:1px solid rgba(255,68,68,0.35); }
.ms-none  { color:var(--mid);   background:var(--bg2);           border:1px solid #1a1a2a; }
.bottom-stat { display:flex; flex-direction:column; align-items:center; }
.bs-lbl { font-size:10px; color:var(--mid); letter-spacing:1px; }
.bs-val { font-size:14px; font-weight:bold; }
.halt-btn {
  margin-left:auto; padding:7px 18px;
  background:rgba(255,68,68,0.12); border:2px solid var(--red);
  color:var(--red); font-size:12px; font-weight:bold; letter-spacing:2px;
  cursor:pointer; font-family:var(--mono);
}
.halt-btn:hover { background:rgba(255,68,68,0.25); }
.auto-arm-btn {
  padding:7px 14px;
  background:rgba(170,136,255,0.1); border:1px solid rgba(170,136,255,0.4);
  color:var(--purple); font-size:12px; font-weight:bold; letter-spacing:1px;
  cursor:pointer; font-family:var(--mono);
}
.auto-arm-btn:hover { background:rgba(170,136,255,0.2); }
.auto-arm-btn.armed { background:rgba(170,136,255,0.2); animation:pdot 2s ease-in-out infinite; }

/* ═══ MONITOR TAB — Screen 1 layout ════════════════════════════ */
.monitor-main {
  display:grid;
  grid-template-columns:1fr 320px;
  height:100%; gap:2px; background:#050508;
}
.right-col { display:grid; grid-template-rows:1fr auto; gap:2px; overflow:hidden; }

/* ═══ INTELLIGENCE TAB — Screen 2 layout ═══════════════════════ */
.intel-main {
  display:grid;
  grid-template-columns:1fr 270px 310px;
  height:100%; gap:2px; background:#050508;
}
.left-dual { display:grid; grid-template-rows:210px 1fr; gap:2px; overflow:hidden; }
.brief-cols { display:grid; grid-template-columns:1fr 1fr 1fr; gap:14px; height:100%; }
.bc-title {
  color:var(--green); font-size:13px; font-weight:bold;
  letter-spacing:1px; border-bottom:1px solid #0d2818;
  padding-bottom:4px; margin-bottom:6px;
}
.bc-row  { display:flex; justify-content:space-between; font-size:13px; padding:4px 0; border-bottom:1px solid #0c0c1c; }
.bc-lbl  { color:var(--mid); }
.macro-badge {
  text-align:center; padding:8px; border-radius:3px;
  font-weight:bold; font-size:15px; margin-bottom:10px; letter-spacing:1px;
}
.mb-bull { background:#001500; color:var(--green); border:1px solid #00ff8866; }
.plan-item  { font-size:13px; color:#666; padding:3px 0; border-bottom:1px solid #0c0c1c; }
.plan-alert { color:var(--red); }
.nb-red    { color:var(--red);    font-size:13px; padding:3px 0; }
.nb-yellow { color:var(--yellow); font-size:13px; padding:3px 0; }
.nb-green  { color:var(--green);  font-size:13px; padding:3px 0; }
.nb-gray   { color:var(--mid);    font-size:13px; padding:3px 0; }
.news-tabs { display:flex; background:#08080f; border-bottom:1px solid #111; flex-shrink:0; }
.news-tab  { padding:7px 14px; font-size:12px; color:var(--dim); cursor:pointer; border-bottom:2px solid transparent; }
.news-tab.active { color:var(--green); border-bottom-color:var(--green); }
.ni      { padding:11px 0; border-bottom:1px solid #0c0c1c; }
.ni-top  { display:flex; align-items:center; gap:7px; margin-bottom:5px; }
.nbadge  { font-size:12px; padding:2px 7px; border-radius:2px; font-weight:bold; }
.nb-high { background:#990000; color:#fff; }
.nb-med  { background:#443300; color:var(--yellow); }
.nb-low  { background:#111; color:var(--mid); }
.nsrc    { color:var(--mid); font-size:12px; }
.ntime   { color:#333; font-size:12px; margin-left:auto; }
.ntext   { color:#ccc; font-size:14px; line-height:1.5; }
.nmeta   { font-size:12px; margin-top:6px; line-height:1.4; }
.fade-tag  { color:#ff6600; }
.cred-hi { color:var(--green); }
.cred-lo { color:var(--red); }
.pinned {
  margin-bottom:8px; padding:10px 12px;
  background:#0a0a20; border:1px solid #3333ff44;
  border-left:4px solid #6666ff; border-radius:4px;
}
.pinned-title { color:#6666ff; font-size:11px; letter-spacing:1px; margin-bottom:5px; }
.pinned-row   { display:flex; justify-content:space-between; font-size:13px; padding:2px 0; }
.pinned-lbl   { color:var(--mid); }
.cal-grid { display:grid; grid-template-columns:1fr; gap:5px; }
.ci {
  background:#080814; border:1px solid #141428;
  border-radius:4px; padding:9px 12px;
  cursor:pointer; transition:border-color 0.15s,background 0.15s;
  position:relative;
}
.ci:hover { border-color:#00ff8855; background:#0a1210; }
.ci:hover .ci-click { opacity:1; }
.ci-click { position:absolute; right:8px; top:50%; transform:translateY(-50%); font-size:10px; color:#00ff8888; opacity:0; transition:opacity 0.15s; }
.ci-date  { font-size:11px; color:var(--dim); margin-bottom:3px; }
.ci-today { font-size:12px; color:var(--yellow); font-weight:bold; margin-bottom:3px; }
.ci-event { font-size:13px; font-weight:bold; }
.ci-high  { color:var(--red); }
.ci-med   { color:var(--yellow); }
.ci-blue  { color:var(--blue); }
.ei {
  background:#080814; border:1px solid #141428;
  border-radius:4px; padding:10px 12px; margin-bottom:5px;
  cursor:pointer; transition:border-color 0.15s;
}
.ei:hover { border-color:#00aaff55; background:#080a14; }
.ei-top  { display:flex; justify-content:space-between; align-items:center; margin-bottom:5px; }
.ei-sym  { color:#fff; font-weight:bold; font-size:16px; }
.ei-tag  { font-size:10px; padding:2px 6px; border-radius:2px; font-weight:bold; }
.ei-bmo  { background:#1a1000; color:var(--yellow); border:1px solid #ffaa0044; }
.ei-amc  { background:#00001a; color:var(--blue); border:1px solid #00aaff44; }
.ei-row  { display:flex; justify-content:space-between; font-size:12px; padding:2px 0; }
.ei-lbl  { color:var(--dim); }
.ei-click { margin-top:5px; font-size:11px; color:#00aaff55; text-align:center; padding-top:4px; border-top:1px solid #111; }
.ei:hover .ei-click { color:var(--blue); }

/* ═══ P&L TAB ════════════════════════════════════════════════ */
#tab-pnl { overflow-y:auto; padding:12px; }
.pnl-stats { display:grid; grid-template-columns:repeat(5,1fr); gap:6px; margin-bottom:10px; }
.pnl-sc { background:var(--bg2); border:1px solid #1a1a2a; padding:9px 12px; }
.pnl-sc-lbl { color:var(--dim); font-size:10px; letter-spacing:1px; margin-bottom:3px; }
.pnl-sc-val { font-size:20px; font-weight:bold; }
.pnl-tbl-wrap { background:var(--bg2); border:1px solid #1a1a2a; margin-bottom:10px; }
.pnl-tbl-title { padding:6px 10px; font-size:10px; color:var(--dim); letter-spacing:2px; background:var(--bg3); border-bottom:1px solid #111; }
.pnl-tbl { width:100%; border-collapse:collapse; }
.pnl-tbl th { color:var(--blue); font-size:11px; padding:7px 9px; text-align:left; border-bottom:1px solid #111; font-weight:bold; letter-spacing:1px; }
.pnl-tbl td { padding:7px 9px; font-size:12px; border-bottom:1px solid rgba(17,17,17,0.6); }
.pnl-tbl tr:last-child td { border-bottom:none; }
.pnl-tbl tbody tr:hover { background:rgba(255,255,255,0.015); }
.tag { font-size:10px; padding:1px 5px; font-weight:bold; }
.tag-call { color:var(--green); background:rgba(0,255,136,0.1); border:1px solid rgba(0,255,136,0.2); }
.tag-put  { color:var(--red);   background:rgba(255,68,68,0.1); border:1px solid rgba(255,68,68,0.2); }
.tag-eng  { color:var(--mid);   background:var(--bg3); border:1px solid #1a1a2a; }
.tag-open { color:var(--blue);  background:rgba(0,170,255,0.08); border:1px solid rgba(0,170,255,0.2); }
.tag-win  { color:var(--green); background:rgba(0,255,136,0.08); border:1px solid rgba(0,255,136,0.2); }
.tag-loss { color:var(--red);   background:rgba(255,68,68,0.08); border:1px solid rgba(255,68,68,0.2); }
.pnl-sig-row { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:10px; }
.pnl-sig-card { background:var(--bg2); border:1px solid #1a1a2a; padding:10px 14px; }
.pnl-sig-type { font-size:11px; font-weight:bold; color:var(--blue); letter-spacing:2px; margin-bottom:5px; }
.pnl-sig-dir  { font-size:17px; font-weight:bold; margin-bottom:4px; }
.pnl-sig-none { color:var(--mid); font-style:italic; font-size:13px; }
.pnl-sig-det  { color:#aaa; font-size:12px; line-height:1.7; }
.pnl-sig-meta { font-size:11px; color:#444; margin-top:3px; }

/* ═══ TRADE TAB ══════════════════════════════════════════════ */
#tab-trade { overflow:hidden; }
.trade-grid { display:grid; grid-template-columns:460px 1fr; height:100%; gap:1px; background:var(--border); }
.trade-cmd { background:var(--bg1); padding:16px 20px; overflow-y:auto; }
.trade-cmd::-webkit-scrollbar { width:3px; }
.trade-cmd::-webkit-scrollbar-thumb { background:var(--border2); }
.tc2-logo { color:var(--green); font-size:13px; letter-spacing:3px; font-weight:bold; margin-bottom:3px; }
.tc2-sub  { color:var(--mid); font-size:10px; letter-spacing:1px; margin-bottom:14px; }
.mode-row { display:flex; gap:6px; margin-bottom:14px; }
.mode-btn2 { padding:6px 16px; font-size:11px; font-weight:bold; letter-spacing:2px; cursor:pointer; border:none; font-family:var(--mono); }
.mode-calls { background:rgba(0,255,136,0.12); color:var(--green); border:1px solid rgba(0,255,136,0.35); }
.mode-puts  { background:rgba(255,68,68,0.12);  color:var(--red);   border:1px solid rgba(255,68,68,0.35); }
.mode-paper { background:var(--bg3); color:var(--mid); border:1px solid #1a1a2a; }
.mode-btn2.active.mode-calls { background:rgba(0,255,136,0.25); box-shadow:0 0 10px rgba(0,255,136,0.15); }
.mode-btn2.active.mode-puts  { background:rgba(255,68,68,0.25);  box-shadow:0 0 10px rgba(255,68,68,0.15); }
.tc2-field { margin-bottom:11px; }
.tc2-field label { display:block; color:var(--mid); font-size:10px; letter-spacing:2px; margin-bottom:4px; }
.tc2-input,.tc2-select {
  width:100%; background:var(--bg3); border:1px solid #1a1a2a;
  color:#fff; padding:8px 10px; font-size:13px; font-family:var(--mono); outline:none;
}
.tc2-input:focus,.tc2-select:focus { border-color:rgba(0,255,136,0.35); }
.tc2-field-row { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; margin-bottom:11px; }
.tc2-sizing {
  padding:10px; background:var(--bg3); border:1px solid #1a1a2a;
  margin-bottom:12px; font-size:11px; line-height:2;
}
.ts-row { display:flex; justify-content:space-between; }
.ts-lbl { color:var(--mid); }
.ts-val { color:var(--blue); font-weight:bold; }
.sig-banner {
  background:var(--bg2); border:1px solid #1a1a2a;
  padding:9px 12px; margin-bottom:12px;
  display:flex; justify-content:space-between; align-items:center; font-size:11px;
}
.sb-badge { padding:3px 10px; font-weight:bold; font-size:11px; letter-spacing:2px; }
.sb-calls { background:rgba(0,255,136,0.12); color:var(--green); border:1px solid rgba(0,255,136,0.3); }
.sb-puts  { background:rgba(255,68,68,0.12);  color:var(--red);  border:1px solid rgba(255,68,68,0.3); }
.sb-wait  { background:rgba(255,255,255,0.04); color:var(--dim); border:1px solid #1a1a2a; }
.sb-load { font-size:10px; padding:4px 10px; border:1px solid var(--green); color:var(--green); background:transparent; cursor:pointer; font-family:var(--mono); letter-spacing:1px; }
.sb-load:hover { background:rgba(0,255,136,0.08); }
.quick-row { display:flex; gap:5px; flex-wrap:wrap; margin-bottom:12px; }
.qsym { font-size:10px; padding:4px 8px; border:1px solid #1a1a2a; color:var(--mid); cursor:pointer; transition:all 0.15s; letter-spacing:1px; }
.qsym:hover { border-color:var(--green); color:var(--green); }
.qsym.mon { border-color:rgba(0,255,136,0.25); color:rgba(0,255,136,0.6); }
.sym-row { display:flex; gap:0; margin-bottom:6px; }
.sym-input {
  flex:1; background:#050510; border:1px solid #1a1a2a; border-right:none;
  padding:10px 12px; font-family:var(--mono); font-size:20px; color:#fff;
  letter-spacing:3px; text-transform:uppercase; outline:none;
}
.sym-input:focus { border-color:rgba(0,255,136,0.35); }
.sym-input::placeholder { color:#1a1a2a; font-size:15px; }
.sym-fetch { background:#1a1a2a; border:1px solid #1a1a2a; padding:10px 12px; font-family:var(--mono); font-size:11px; color:var(--mid); cursor:pointer; white-space:nowrap; }
.sym-fetch:hover { background:var(--green); color:#000; border-color:var(--green); }
.quote-strip {
  background:#050510; border:1px solid #1a1a2a; padding:8px 12px;
  margin-bottom:12px; display:none; align-items:center; gap:14px; font-size:11px;
}
.quote-strip.show { display:flex; }
.qs-price { font-size:19px; font-weight:bold; }
.qs-item { display:flex; flex-direction:column; gap:1px; }
.qs-lbl { font-size:9px; color:var(--mid); letter-spacing:1px; }
.qs-val { font-size:12px; font-weight:bold; }
.side-row { display:grid; grid-template-columns:1fr 1fr; gap:2px; margin-bottom:12px; }
.side-btn {
  padding:12px; font-family:var(--mono); font-size:13px; letter-spacing:3px; font-weight:bold;
  border:1px solid #1a1a2a; background:transparent; cursor:pointer; transition:all 0.15s;
}
.side-btn.calls { color:#2a4a2a; border-color:#0a1a0a; }
.side-btn.puts  { color:#4a2a2a; border-color:#1a0a0a; }
.side-btn.calls.active { background:rgba(0,255,136,0.1); border-color:var(--green); color:var(--green); box-shadow:0 0 15px rgba(0,255,136,0.08); }
.side-btn.puts.active  { background:rgba(255,68,68,0.1); border-color:var(--red); color:var(--red); box-shadow:0 0 15px rgba(255,68,68,0.08); }
.strike-display { background:#050510; border:1px solid #1a1a2a; padding:8px 12px; display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; font-size:12px; }
.strike-val { font-size:16px; font-weight:bold; color:#fff; }
.adj-btn { background:#1a1a2a; border:none; width:24px; height:24px; font-family:var(--mono); font-size:13px; color:var(--mid); cursor:pointer; transition:all 0.15s; }
.adj-btn:hover { background:rgba(0,255,136,0.2); color:var(--green); }
.size-grid { display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:6px; margin-bottom:12px; }
.size-opt { background:#050510; border:1px solid #1a1a2a; padding:8px; cursor:pointer; text-align:center; transition:all 0.15s; font-size:11px; color:var(--mid); }
.size-opt.active { border-color:rgba(0,255,136,0.35); color:var(--green); background:rgba(0,255,136,0.04); }
.size-opt-num { font-size:17px; font-weight:bold; color:#fff; margin-bottom:3px; }
.size-opt.active .size-opt-num { color:var(--green); }
.order-preview { background:#030308; border:1px solid #1a1a2a; padding:12px; margin-bottom:12px; min-height:70px; }
.order-line { font-size:14px; color:#fff; margin-bottom:6px; font-weight:bold; letter-spacing:1px; }
.order-meta { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; font-size:10px; }
.om { display:flex; flex-direction:column; gap:2px; }
.om-lbl { color:var(--mid); letter-spacing:1px; }
.om-val { color:#ccc; }
.exec-row { display:grid; grid-template-columns:1fr 1fr; gap:2px; margin-bottom:8px; }
.exec-btn { padding:13px; font-family:var(--mono); font-size:13px; letter-spacing:2px; font-weight:bold; border:none; cursor:pointer; transition:all 0.15s; }
.exec-live  { background:var(--green); color:#000; }
.exec-live:hover { background:#00cc66; transform:translateY(-1px); }
.exec-live:disabled { background:#111; color:#333; cursor:not-allowed; transform:none; }
.exec-paper { background:transparent; border:1px solid var(--yellow); color:var(--yellow); }
.exec-paper:hover { background:rgba(255,170,0,0.08); }
.close-all { width:100%; padding:9px; background:rgba(255,68,68,0.08); border:1px solid rgba(255,68,68,0.25); color:var(--red); font-family:var(--mono); font-size:11px; letter-spacing:2px; cursor:pointer; transition:all 0.15s; margin-bottom:2px; }
.close-all:hover { background:rgba(255,68,68,0.15); }
.pos-panel { background:var(--bg2); display:flex; flex-direction:column; overflow:hidden; }
.pos-ph { background:var(--bg3); padding:8px 12px; border-bottom:1px solid #111; display:flex; justify-content:space-between; }
.pos-ptitle { color:var(--blue); font-size:11px; letter-spacing:2px; font-weight:bold; }
.pos-cnt { color:var(--mid); font-size:10px; }
.pos-body { padding:10px; flex:1; overflow-y:auto; }
.pos-empty { text-align:center; padding:30px 16px; color:var(--mid); font-size:11px; line-height:2; }
.pos-card { background:#050510; border:1px solid #1a1a2a; padding:10px; margin-bottom:6px; }
.pos-card:hover { border-color:var(--blue); }
.pos-top { display:flex; justify-content:space-between; margin-bottom:6px; }
.pos-sym { font-size:14px; font-weight:bold; color:#fff; }
.pos-det { font-size:10px; color:var(--mid); margin-bottom:6px; }
.pos-pl-row { display:flex; justify-content:space-between; align-items:center; }
.pos-pl-val { font-size:16px; font-weight:bold; }
.pos-pl-pct { font-size:12px; }
.pos-close-btn { font-size:9px; padding:3px 8px; border:1px solid #1a1a2a; background:transparent; color:var(--mid); cursor:pointer; font-family:var(--mono); letter-spacing:1px; }
.pos-close-btn:hover { border-color:var(--red); color:var(--red); }
.trade-log-wrap { background:var(--bg2); border:1px solid #1a1a2a; margin-top:10px; }
.tl-hdr { background:var(--bg3); padding:6px 10px; border-bottom:1px solid #111; font-size:10px; color:var(--dim); letter-spacing:2px; }
.tl-body { max-height:140px; overflow-y:auto; }
.tl-body::-webkit-scrollbar { width:2px; }
.tl-body::-webkit-scrollbar-thumb { background:var(--border2); }
.tl-row { display:grid; grid-template-columns:65px 50px 65px 1fr 65px 60px; padding:7px 10px; border-bottom:1px solid rgba(17,17,17,0.7); font-size:11px; align-items:center; }
.tl-hdr-row { display:grid; grid-template-columns:65px 50px 65px 1fr 65px 60px; padding:5px 10px; border-bottom:1px solid #1a1a2a; font-size:9px; color:var(--mid); letter-spacing:1px; background:#050510; }
.tl-empty { padding:14px 10px; color:#1a1a2a; font-size:11px; }
.confirm-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.88); z-index:1000; justify-content:center; align-items:center; }
.confirm-overlay.show { display:flex; }
.confirm-box { background:var(--bg2); border:1px solid var(--green); border-top:3px solid var(--green); padding:28px; width:400px; box-shadow:0 0 50px rgba(0,255,136,0.12); }
.confirm-title { color:var(--green); font-size:12px; letter-spacing:3px; margin-bottom:16px; }
.confirm-order { font-size:18px; color:#fff; font-weight:bold; margin-bottom:16px; line-height:1.4; }
.confirm-row { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #1a1a2a; font-size:12px; }
.confirm-lbl { color:var(--mid); }
.confirm-btns { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-top:16px; }
.yes-btn { padding:12px; background:var(--green); border:none; color:#000; font-family:var(--mono); font-size:13px; font-weight:bold; letter-spacing:2px; cursor:pointer; }
.no-btn  { padding:12px; background:transparent; border:1px solid var(--red); color:var(--red); font-family:var(--mono); font-size:13px; letter-spacing:2px; cursor:pointer; }
.no-btn:hover { background:rgba(255,68,68,0.08); }
.paper-note { font-size:10px; color:var(--yellow); text-align:center; margin-top:10px; letter-spacing:1px; }
.fill-toast { display:none; position:fixed; bottom:24px; right:24px; background:var(--bg2); border:1px solid var(--green); border-left:4px solid var(--green); padding:14px 20px; z-index:2000; animation:slideUp 0.3s ease; }
.fill-toast.show { display:block; }
@keyframes slideUp { from{transform:translateY(16px);opacity:0}to{transform:none;opacity:1} }
.ft-title { color:var(--green); font-size:10px; letter-spacing:2px; margin-bottom:4px; }
.ft-body  { font-size:13px; font-weight:bold; color:#fff; }

/* ═══ SETTINGS TAB ════════════════════════════════════════════ */
#tab-settings { overflow-y:auto; padding:18px 20px; }
.settings-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; max-width:900px; }
.sc { background:var(--bg2); border:1px solid #1a1a2a; }
.sc-title { padding:8px 12px; font-size:10px; color:var(--dim); letter-spacing:2px; background:var(--bg3); border-bottom:1px solid #111; }
.sc-body  { padding:14px 12px; }
.setting-row { display:flex; justify-content:space-between; align-items:center; padding:7px 0; border-bottom:1px solid rgba(17,17,17,0.6); }
.setting-row:last-child { border-bottom:none; }
.sr-label { color:var(--text); font-size:11px; }
.sr-sub   { color:var(--mid); font-size:10px; margin-top:1px; }
.toggle-g { display:flex; gap:0; }
.tgl-btn { padding:4px 12px; font-size:10px; font-weight:bold; letter-spacing:1px; cursor:pointer; border:1px solid #1a1a2a; background:var(--bg3); color:var(--mid); font-family:var(--mono); }
.tgl-btn.active.paper  { background:rgba(255,170,0,0.1); color:var(--yellow); border-color:rgba(255,170,0,0.35); }
.tgl-btn.active.live   { background:rgba(255,68,68,0.12); color:var(--red); border-color:rgba(255,68,68,0.4); }
.tgl-btn.active.on     { background:rgba(0,255,136,0.1);  color:var(--green); border-color:rgba(0,255,136,0.35); }
.tgl-btn.active.off    { background:rgba(255,68,68,0.08);  color:var(--red); border-color:rgba(255,68,68,0.25); }
.api-status { display:flex; align-items:center; gap:5px; font-size:10px; }
.api-dot { width:7px; height:7px; border-radius:50%; }
.api-ok  { background:var(--green); box-shadow:0 0 4px rgba(0,255,136,0.5); }
.api-bad { background:var(--red); }
.api-lbl { color:var(--text); }
.sa-btn { padding:4px 10px; font-size:10px; cursor:pointer; border:none; font-family:var(--mono); background:var(--bg3); color:var(--blue); border:1px solid rgba(0,170,255,0.25); }
.sa-btn:hover { background:rgba(0,170,255,0.08); }
.launch-tv-btn {
  width:100%; padding:16px; margin-top:16px;
  background:rgba(0,255,136,0.12); border:2px solid var(--green);
  color:var(--green); font-size:15px; font-weight:bold; letter-spacing:3px;
  cursor:pointer; font-family:var(--mono); transition:all 0.2s;
  box-shadow:0 0 20px rgba(0,255,136,0.08);
}
.launch-tv-btn:hover { background:rgba(0,255,136,0.22); box-shadow:0 0 30px rgba(0,255,136,0.15); }

/* ═══ DRAGGABLE / CHAT ═══════════════════════════════════════ */
.drag-window {
  position:fixed; background:#0d0d1a; border:1px solid #00ff8833; border-radius:6px;
  display:none; flex-direction:column; z-index:1000;
  box-shadow:0 8px 40px rgba(0,0,0,0.8); overflow:hidden; resize:both;
}
.drag-window.open { display:flex; }
.drag-header {
  background:var(--bg3); border-bottom:2px solid #0d2818;
  padding:8px 14px; display:flex; justify-content:space-between; align-items:center;
  cursor:grab; flex-shrink:0; user-select:none;
}
.drag-header:active { cursor:grabbing; }
.drag-title { color:var(--green); font-size:13px; font-weight:bold; letter-spacing:1px; }
.drag-close { color:var(--mid); font-size:16px; cursor:pointer; line-height:1; padding:0 3px; transition:color 0.1s; }
.drag-close:hover { color:var(--red); }
.drag-body { flex:1; overflow:hidden; display:flex; flex-direction:column; }
#chatWindow { width:560px; height:580px; top:80px; right:80px; border-top:3px solid var(--green); }
.chat-messages { flex:1; padding:12px 14px; overflow-y:auto; display:flex; flex-direction:column; gap:10px; }
.chat-messages::-webkit-scrollbar { width:3px; }
.chat-messages::-webkit-scrollbar-thumb { background:var(--border2); }
.msg { display:flex; flex-direction:column; gap:3px; }
.msg-you  { align-items:flex-end; }
.msg-hank { align-items:flex-start; }
.msg-bubble { max-width:88%; padding:9px 13px; border-radius:4px; font-size:13px; line-height:1.6; user-select:text; }
.msg-you  .msg-bubble { background:#001a00; border:1px solid #00ff8833; color:#ccc; }
.msg-hank .msg-bubble { background:#0a0a22; border:1px solid #3333ff33; color:#ddd; }
.msg-label { font-size:10px; color:#333; padding:0 3px; }
.msg-hank .msg-label { color:#6666ff88; }
.msg-you  .msg-label  { color:#00ff8844; }
.chat-ctx-bar { padding:5px 14px; background:#08080f; border-top:1px solid #0f0f18; font-size:10px; color:#2a2a3a; flex-shrink:0; }
.chat-input-row { display:flex; gap:6px; padding:10px 14px; border-top:1px solid #111; background:#080810; flex-shrink:0; }
.chat-input { flex:1; background:#0f0f18; border:1px solid #1a1a2a; border-radius:3px; padding:9px 12px; font-size:13px; color:#fff; font-family:var(--mono); outline:none; user-select:text; }
.chat-input:focus { border-color:#00ff8844; }
.chat-input::placeholder { color:#2a2a3a; }
.chat-send { background:#001800; border:1px solid #00ff8866; border-radius:3px; padding:9px 16px; font-size:13px; color:var(--green); cursor:pointer; font-family:var(--mono); letter-spacing:1px; flex-shrink:0; }
.chat-send:hover { background:#002800; }
.loading-dots { display:inline-block; animation:blink 1s infinite; }
@keyframes blink { 0%,100%{opacity:1}50%{opacity:0.2} }

/* ═══ ASK HANK BUTTON ════════════════════════════════════════ */
.ask-hank-btn {
  position:fixed; bottom:20px; right:20px;
  background:#001800; border:2px solid var(--green);
  border-radius:4px; padding:10px 18px;
  font-size:14px; color:var(--green); font-family:var(--mono); font-weight:bold;
  letter-spacing:1px; cursor:pointer; z-index:500;
  box-shadow:0 0 18px #00ff8828; transition:all 0.15s;
}
.ask-hank-btn:hover { background:#002800; box-shadow:0 0 28px #00ff8850; }

/* Util */
.pos  { color:var(--green); }
.neg  { color:var(--red); }
.neu  { color:#fff; }
.no-data { text-align:center; color:#1a1a2a; padding:16px; font-size:11px; }
</style>
</head>
<body>`;

fs.appendFileSync(file, s1);
console.log('S1 done:', s1.length, 'chars');
