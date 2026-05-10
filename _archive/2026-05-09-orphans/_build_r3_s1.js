const fs = require('fs');
const file = 'C:\\Users\\tomav\\tradingview-mcp-jackson\\hank-electron-r3.html';

// Start fresh
fs.writeFileSync(file, '');

const s1 = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>⬡ HANK — Autonomous Trading Terminal R3</title>
<style>
:root {
  --bg:   #080810;
  --bg2:  #0b0b16;
  --bg3:  #0e1822;
  --bg4:  #0a0a14;
  --green:  #00ff88;
  --red:    #ff4444;
  --yellow: #ffaa00;
  --blue:   #00aaff;
  --mid:    #888;
  --dim:    #444;
  --mono: 'Consolas','Courier New',monospace;
  /* Font scale — nothing below 13px */
  --fs-xs:   13px;
  --fs-sm:   14px;
  --fs-base: 14px;
  --fs-hdr:  16px;
  --fs-lbl:  14px;
  --fs-price: 20px;
  --fs-sig:  18px;
  --fs-major: 24px;
  --fs-xl:   28px;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--bg);
  color: #e0e0e0;
  font-family: var(--mono);
  font-size: var(--fs-base);
  height: 100vh;
  overflow: hidden;
  user-select: none;
}

/* ── SHELL ─────────────────────────────────────────────────── */
#shell {
  display: grid;
  grid-template-rows: 48px 1fr;
  height: 100vh;
}

/* ── TOPBAR ────────────────────────────────────────────────── */
#topbar {
  background: #0b0b18;
  border-bottom: 2px solid #00ff8844;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px;
  font-size: var(--fs-hdr);
  overflow: hidden;
}
.tb-logo { color: var(--green); font-size: 20px; font-weight: bold; letter-spacing: 2px; }
.tb-div  { color: #1a1a30; font-size: 20px; }
.tb-clock { color: var(--green); font-size: var(--fs-hdr); letter-spacing: 1px; }
.tb-session { color: var(--yellow); font-size: var(--fs-sm); letter-spacing: 1px; }
.tb-screen  { color: var(--blue);   font-size: var(--fs-sm); }
.tb-fut { display: flex; align-items: center; gap: 5px; font-size: var(--fs-sm); }
.tb-fut-sym { color: #555; font-size: 13px; }
.tb-up  { color: var(--green); }
.tb-dn  { color: var(--red); }
.tb-mkt { color: var(--mid); font-size: 13px; letter-spacing: 2px; border: 1px solid #1a1a30; padding: 2px 8px; }
.tb-dots { display: flex; gap: 10px; margin-left: auto; align-items: center; }
.tb-dot-group { display: flex; align-items: center; gap: 4px; }
.tb-dot { width: 8px; height: 8px; border-radius: 50%; }
.tb-dot.g { background: var(--green); box-shadow: 0 0 6px var(--green); }
.tb-dot.y { background: var(--yellow); }
.tb-dot.r { background: var(--red); }
.tb-dot-lbl { font-size: 13px; color: #333; }

/* ── MAIN AREA ─────────────────────────────────────────────── */
#main-area {
  display: grid;
  grid-template-columns: 220px 1fr;
  overflow: hidden;
}

/* ── SIDEBAR ───────────────────────────────────────────────── */
#sidebar {
  background: #07070f;
  border-right: 1px solid #0e0e1e;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.nav-tabs { display: flex; flex-direction: column; padding: 10px 0; flex-shrink: 0; }
.nav-tab {
  display: flex; align-items: center; gap: 10px;
  padding: 11px 18px;
  font-size: var(--fs-sm);
  color: #444;
  cursor: pointer;
  letter-spacing: 1px;
  border-left: 3px solid transparent;
  transition: all 0.15s;
}
.nav-tab:hover { color: #888; background: #0a0a14; }
.nav-tab.active { color: var(--green); border-left-color: var(--green); background: #0a0f0a; }
.nav-icon { font-size: 16px; width: 20px; text-align: center; }

.svc-panel { padding: 10px 14px; border-top: 1px solid #0e0e1e; flex-shrink: 0; }
.svc-title { font-size: 13px; color: #222; letter-spacing: 2px; margin-bottom: 8px; }
.svc-row { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; }
.svc-dot-sm { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.svc-dot-sm.run  { background: var(--green); box-shadow: 0 0 5px var(--green); }
.svc-dot-sm.stop { background: #222; }
.svc-name { flex: 1; font-size: 13px; color: #555; }
.svc-btn { background: #0a0a14; border: 1px solid #1a1a2a; color: #444; font-size: 13px; padding: 2px 7px; cursor: pointer; font-family: var(--mono); }
.svc-btn:hover { color: var(--green); }

.log-mini { flex: 1; overflow-y: auto; padding: 8px 14px; font-size: 13px; }
.ll   { color: #2a2a3a; margin-bottom: 3px; }
.ll.g { color: #1a3a1a; }
.ll.y { color: #3a3010; }
.ll.r { color: #3a1010; }

/* ── CONTENT ───────────────────────────────────────────────── */
#content { display: flex; flex-direction: column; overflow: hidden; }
.tab-panel { display: none; flex-direction: column; overflow: hidden; height: 100%; }
.tab-panel.active { display: flex; }

/* ── INFOBAR ───────────────────────────────────────────────── */
.infobar {
  background: #090912;
  border-bottom: 1px solid #0e0e1e;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 0 16px;
  height: 38px;
  flex-shrink: 0;
  font-size: var(--fs-sm);
  overflow-x: auto;
}
.ib-lbl  { color: #333; margin-right: 4px; font-size: 13px; }
.ib-good { color: var(--green); }
.ib-warn { color: var(--yellow); }
.ib-val  { color: #888; }

/* ── PANELS ────────────────────────────────────────────────── */
.panel {
  background: var(--bg2);
  border: 1px solid #0e0e1e;
  border-radius: 2px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ph {
  background: var(--bg3);
  border-bottom: 2px solid #0d2818;
  padding: 9px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}
.pt { color: var(--green); font-size: var(--fs-hdr); letter-spacing: 2px; }
.ps { color: #333; font-size: 13px; }
.pb { flex: 1; overflow-y: auto; padding: 10px; }

/* ── BADGES ────────────────────────────────────────────────── */
.badge { display: inline-block; padding: 3px 8px; font-size: 13px; border-radius: 2px; font-weight: bold; letter-spacing: 1px; }
.bb { background: #0a1a0a; color: var(--green); border: 1px solid #1a3a1a; }
.br { background: #1a0a0a; color: var(--red);   border: 1px solid #3a1a1a; }
.bp { background: #0a0a1a; color: var(--blue);  border: 1px solid #1a1a3a; }
.bull { color: var(--green); }
.bear { color: var(--red); }
.divm { color: var(--yellow); }

/* ══════════════════════════════════════════════════════════
   AUTONOMOUS TAB
══════════════════════════════════════════════════════════ */
.auto-layout {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr 320px;
  gap: 8px;
  padding: 8px;
  flex: 1;
  overflow: hidden;
  min-height: 0;
}

.inst-col {
  background: var(--bg2);
  border: 1px solid #0e0e1e;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overflow-x: hidden;
}

.sig-card {
  padding: 12px 14px;
  border-bottom: 1px solid #0e0e1e;
  flex-shrink: 0;
}
.sc-sym    { font-size: 22px; color: #888; letter-spacing: 3px; margin-bottom: 4px; }
.sc-price  { font-size: var(--fs-xl); font-weight: bold; margin-bottom: 8px; }
.sc-action {
  font-size: var(--fs-major);
  font-weight: bold;
  letter-spacing: 2px;
  padding: 8px 12px;
  margin-bottom: 8px;
  border: 2px solid;
}
.sca-calls { color: var(--green); border-color: #0d3a1a; background: #050f07; }
.sca-puts  { color: var(--red);   border-color: #3a0d0d; background: #0f0505; }
.sca-wait  { color: var(--yellow);border-color: #3a2a0d; background: #0f0d05; }
.sc-conf   { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.conf-hi   { color: var(--green); font-size: var(--fs-hdr); font-weight: bold; }
.conf-md   { color: var(--yellow); font-size: var(--fs-hdr); font-weight: bold; }
.conf-wk   { color: #555; font-size: var(--fs-hdr); font-weight: bold; }
.sc-reason { font-size: 13px; color: #555; line-height: 1.5; }

.mkt-state { padding: 10px 14px; border-bottom: 1px solid #0e0e1e; flex-shrink: 0; }
.mkt-row   { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; border-bottom: 1px solid #0c0c18; }
.mkt-k     { color: #333; font-size: 13px; letter-spacing: 1px; }
.mkt-v     { font-size: var(--fs-sm); font-weight: bold; }
.mkt-v.pos { color: var(--green); }
.mkt-v.neg { color: var(--red); }
.mkt-v.neu { color: var(--yellow); }

/* ── OPTION C MINI CHAIN (embedded in inst-col) ────────────── */
.opt-mini {
  padding: 10px 12px;
  border-bottom: 1px solid #0e0e1e;
  flex-shrink: 0;
}
.opt-mini-title {
  font-size: 13px;
  color: #333;
  letter-spacing: 2px;
  margin-bottom: 7px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.opt-mini-tabs { display: flex; gap: 4px; }
.om-tab {
  font-size: 13px;
  color: #333;
  padding: 2px 8px;
  border: 1px solid #111;
  cursor: pointer;
  background: transparent;
  font-family: var(--mono);
}
.om-tab.active { color: var(--green); border-color: #1a3a1a; background: #050f07; }
.om-refresh { font-size: 13px; color: #222; }

.om-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 8px;
  font-size: var(--fs-sm);
}
.om-table th {
  color: #333;
  font-size: 13px;
  text-align: right;
  padding: 3px 5px;
  border-bottom: 1px solid #0e0e1e;
}
.om-table th:first-child { text-align: left; }
.om-table td {
  padding: 5px 5px;
  text-align: right;
  color: #888;
  border-bottom: 1px solid #0a0a14;
  font-size: var(--fs-sm);
}
.om-table td:first-child { text-align: left; color: #666; }
.om-table tr:hover td { background: #0a0a14; }
.om-hank-pick td {
  color: var(--green) !important;
  background: #050f07 !important;
  font-weight: bold;
}
.om-hank-pick td:first-child::before { content: '▶ '; }
.om-wait-row td { color: #444 !important; }
.om-exec-btn {
  width: 100%;
  padding: 8px;
  background: #050f07;
  border: 1px solid #1a3a1a;
  color: var(--green);
  font-family: var(--mono);
  font-size: var(--fs-sm);
  cursor: pointer;
  letter-spacing: 1px;
  text-align: center;
}
.om-exec-btn:hover { background: #0a1a0a; }
.om-exec-btn.puts {
  background: #0f0505;
  border-color: #3a1a1a;
  color: var(--red);
}
.om-exec-btn.wait {
  background: #0a0a0a;
  border-color: #1a1a1a;
  color: #333;
  cursor: default;
}

/* ── ANALYSIS COLUMN ───────────────────────────────────────── */
.analysis-col {
  background: var(--bg4);
  border: 1px solid #0e0e1e;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ac-header {
  padding: 10px 14px;
  border-bottom: 1px solid #111;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}
.ac-title { color: var(--green); font-size: var(--fs-hdr); letter-spacing: 2px; }
.ac-time  { color: #333; font-size: 13px; }
.ac-body  { flex: 1; overflow-y: auto; padding: 12px; }
.ac-para  { font-size: var(--fs-sm); color: #888; line-height: 1.7; margin-bottom: 10px; }
.ac-entry { background: #0a0a12; border-left: 2px solid #1a3a1a; padding: 9px 12px; margin-bottom: 10px; }
.ae-row   { display: flex; justify-content: space-between; padding: 3px 0; font-size: var(--fs-sm); }
.ae-lbl   { color: #333; font-size: 13px; letter-spacing: 1px; }
.ae-val   { color: #888; }
.ae-val.r { color: var(--red); }
.hl-bull  { color: var(--green); }
.hl-warn  { color: var(--yellow); }
.hl-blue  { color: var(--blue); }
.pdot::before { content: '▶ '; color: var(--green); }

.master-sig {
  display: block;
  padding: 10px 16px;
  font-size: var(--fs-major);
  font-weight: bold;
  letter-spacing: 2px;
  text-align: center;
  border: 2px solid;
  margin-bottom: 8px;
}
.ms-calls { color: var(--green); border-color: #1a3a1a; background: #050f07; }
.ms-puts  { color: var(--red);   border-color: #3a1a1a; background: #0f0505; }
.ms-wait  { color: var(--yellow);border-color: #3a2a0d; background: #0f0d05; }

.auto-arm-btn {
  background: #0a0a12;
  border: 1px solid #1a1a2a;
  color: #555;
  font-family: var(--mono);
  font-size: var(--fs-sm);
  padding: 10px;
  cursor: pointer;
  letter-spacing: 1px;
  width: 100%;
}
.auto-arm-btn:hover { color: var(--green); border-color: #1a3a1a; }
.halt-btn {
  background: #1a0505;
  border: 1px solid #3a1010;
  color: var(--red);
  font-family: var(--mono);
  font-size: var(--fs-sm);
  padding: 10px 14px;
  cursor: pointer;
  letter-spacing: 1px;
}

/* ── BOTTOM BAR ────────────────────────────────────────────── */
.auto-bottom {
  background: #080810;
  border-top: 2px solid #0e0e1e;
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 0 16px;
  height: 44px;
  flex-shrink: 0;
  overflow-x: auto;
}
.bottom-stat { display: flex; flex-direction: column; }
.bs-lbl { font-size: 13px; color: #333; letter-spacing: 1px; }
.bs-val { font-size: var(--fs-sm); font-weight: bold; }

/* ══════════════════════════════════════════════════════════
   MONITOR TAB
══════════════════════════════════════════════════════════ */
.monitor-main {
  display: grid;
  grid-template-columns: 1fr 340px;
  gap: 8px;
  padding: 8px;
  flex: 1;
  overflow: hidden;
  min-height: 0;
}
.right-col { display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }

.mon-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.mon-table th {
  color: #333;
  font-size: 13px;
  letter-spacing: 1px;
  padding: 7px 8px;
  text-align: left;
  border-bottom: 1px solid #0e0e1e;
  background: #090912;
}
.mon-table td {
  padding: 8px 8px;
  border-bottom: 1px solid #0a0a14;
  font-size: var(--fs-sm);
}
.mon-table .sym { color: #888; font-size: var(--fs-hdr); letter-spacing: 2px; }
.mon-table tr:hover td { background: #0a0a14; }

.spy-block {
  background: #090912;
  border: 1px solid #0e0e1e;
  border-left: 3px solid var(--green);
  padding: 12px 14px;
  margin: 8px 0;
}
.spy-header { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 10px; }
.spy-lbl-sm { font-size: 13px; color: #444; letter-spacing: 2px; }
.spy-price  { font-size: 32px; color: var(--green); font-weight: bold; }
.spy-grid   { flex: 1; }
.spy-row    { display: flex; justify-content: space-between; padding: 3px 0; font-size: var(--fs-sm); }
.spy-lbl    { color: #444; font-size: 13px; }
.confluence {
  background: #1a1005;
  border: 1px solid #3a2005;
  color: var(--yellow);
  font-size: var(--fs-sm);
  padding: 7px 10px;
  margin-top: 8px;
}

.signal-box {
  padding: 12px 14px;
  margin: 8px 0;
  border-left: 4px solid;
}
.sig-calls { border-color: var(--green); background: #050f07; }
.sig-puts  { border-color: var(--red);   background: #0f0505; }
.sig-action { font-size: var(--fs-major); font-weight: bold; letter-spacing: 2px; margin-bottom: 6px; }
.sig-conf   { font-size: var(--fs-hdr); margin-bottom: 6px; }
.sig-reason { font-size: var(--fs-sm); color: #666; line-height: 1.6; margin-bottom: 6px; }
.sig-strike { font-size: var(--fs-sm); color: #888; }

/* Analysis Feed */
.analysis-feed { margin-top: 8px; background: #090912; border: 1px solid #0e0e1e; }
.af-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 9px 14px; border-bottom: 1px solid #111; background: #0a0a14;
}
.af-title { color: var(--green); font-size: var(--fs-hdr); letter-spacing: 2px; }
.af-pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 6px var(--green); animation: blink 1.4s infinite; }
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:.3} }
.af-body { padding: 10px 14px; }
.af-entry { padding: 8px 0; border-bottom: 1px solid #0a0a14; font-size: var(--fs-sm); display: flex; gap: 10px; }
.af-latest { color: #aaa; }
.af-time { color: #333; font-size: 13px; flex-shrink: 0; }
.af-text { line-height: 1.6; }
.af-bull { color: var(--green); }
.af-warn { color: var(--yellow); }
.af-blue { color: var(--blue); }

/* WIN3 */
.win3 { padding: 10px 14px; background: #090912; border: 1px solid #0e0e1e; margin-top: 8px; }
.win3-lbl { font-size: 13px; color: #333; letter-spacing: 2px; margin-bottom: 8px; }
.win3-row { display: flex; gap: 8px; margin-bottom: 8px; }
.win3-item { flex: 1; background: #0a0a14; padding: 7px 8px; display: flex; flex-direction: column; gap: 4px; align-items: center; }
.win3-sym  { color: #666; font-size: 13px; }
.win3-conf { font-size: var(--fs-sm); color: var(--green); }

/* Account panel */
.ar { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #0a0a14; font-size: var(--fs-sm); }
.al { color: #444; font-size: 13px; }
.av { color: #888; font-weight: bold; }

/* ── OPTION B STANDALONE PANEL (in MONITOR right col) ──────── */
.opt-b-banner {
  background: #050f07;
  border: 1px solid #1a3a1a;
  border-left: 4px solid var(--green);
  padding: 12px 14px;
  margin-bottom: 10px;
}
.opt-b-banner.puts {
  background: #0f0505;
  border-color: #3a1a1a;
  border-left-color: var(--red);
}
.ob-action { font-size: var(--fs-major); font-weight: bold; letter-spacing: 2px; margin-bottom: 5px; }
.ob-pick   { font-size: var(--fs-sm); color: #888; }

.opt-b-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
  align-items: center;
}
.ob-sym, .ob-exp {
  font-size: 13px;
  padding: 4px 10px;
  border: 1px solid #111;
  color: #333;
  cursor: pointer;
  background: transparent;
  font-family: var(--mono);
}
.ob-sym.active { color: var(--green); border-color: #1a3a1a; background: #050f07; }
.ob-exp.active { color: var(--blue);  border-color: #1a1a3a; background: #05050f; }

.opt-b-ladder {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-sm);
  margin-bottom: 10px;
}
.opt-b-ladder th {
  color: #333;
  font-size: 13px;
  padding: 5px 6px;
  text-align: right;
  border-bottom: 1px solid #0e0e1e;
}
.opt-b-ladder th:first-child { text-align: left; }
.opt-b-ladder td {
  padding: 6px 6px;
  text-align: right;
  color: #666;
  border-bottom: 1px solid #0a0a14;
  font-size: var(--fs-sm);
}
.opt-b-ladder td:first-child { text-align: left; color: #555; }
.opt-b-pick td {
  color: var(--green) !important;
  background: #050f07 !important;
  font-weight: bold;
  font-size: var(--fs-hdr) !important;
}
.opt-b-pick td:first-child::before { content: '▶ '; }
.opt-b-exec {
  width: 100%;
  padding: 10px;
  background: #050f07;
  border: 2px solid #1a3a1a;
  color: var(--green);
  font-family: var(--mono);
  font-size: var(--fs-hdr);
  cursor: pointer;
  letter-spacing: 1px;
  font-weight: bold;
}
.opt-b-exec:hover { background: #0a1a0a; }

/* ══════════════════════════════════════════════════════════
   INTELLIGENCE TAB
══════════════════════════════════════════════════════════ */
.intel-main {
  display: grid;
  grid-template-columns: 1fr 290px 330px;
  gap: 8px;
  padding: 8px;
  flex: 1;
  overflow: hidden;
  min-height: 0;
}
.left-dual { display: flex; flex-direction: column; gap: 8px; overflow-y: auto; min-height: 0; }

/* Briefing */
.brief-cols { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
.bc-title { font-size: 13px; color: #333; letter-spacing: 2px; margin-bottom: 8px; }
.bc-row   { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #0a0a14; font-size: var(--fs-sm); }
.bc-lbl   { color: #444; font-size: 13px; }
.macro-badge {
  display: inline-block;
  padding: 4px 10px;
  font-size: 13px;
  letter-spacing: 2px;
  margin-bottom: 10px;
}
.mb-bull { color: var(--green); border: 1px solid #1a3a1a; background: #050f07; }
.mb-bear { color: var(--red);   border: 1px solid #3a1a1a; background: #0f0505; }
.plan-item { font-size: var(--fs-sm); color: #666; padding: 3px 0; border-bottom: 1px solid #0a0a14; }
.plan-alert { color: var(--yellow); }
.nb-red    { color: var(--red);    font-size: var(--fs-sm); padding: 3px 0; }
.nb-yellow { color: var(--yellow); font-size: var(--fs-sm); padding: 3px 0; }
.nb-green  { color: var(--green);  font-size: var(--fs-sm); padding: 3px 0; }
.nb-gray   { color: #444;          font-size: var(--fs-sm); padding: 3px 0; }

/* News */
.news-tabs { display: flex; gap: 4px; padding: 8px 10px; background: #090912; border-bottom: 1px solid #0e0e1e; }
.news-tab  { font-size: 13px; color: #333; padding: 4px 10px; border: 1px solid #111; cursor: pointer; font-family: var(--mono); }
.news-tab.active { color: var(--green); border-color: #1a3a1a; background: #050f07; }
.ni { padding: 10px 0; border-bottom: 1px solid #0a0a14; }
.ni-top  { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.nbadge  { font-size: 13px; padding: 2px 7px; border: 1px solid; }
.nb-high { color: var(--red);    border-color: #3a1a1a; background: #0f0505; }
.nb-med  { color: var(--yellow); border-color: #3a2a0d; background: #0f0d05; }
.nsrc    { color: #333; font-size: 13px; }
.ntime   { color: #222; font-size: 13px; margin-left: auto; }
.ntext   { font-size: var(--fs-sm); color: #aaa; margin-bottom: 4px; line-height: 1.5; }
.nmeta   { font-size: 13px; line-height: 1.5; }
.cred-hi { color: var(--green); }
.cred-lo { color: #555; }
.fade-tag{ color: var(--yellow); }

/* Calendar */
.pinned { background: #090912; border: 1px solid #1a3a1a; padding: 10px 12px; margin-bottom: 10px; }
.pinned-title { font-size: 13px; color: #1a3a1a; letter-spacing: 2px; margin-bottom: 7px; }
.pinned-row   { display: flex; justify-content: space-between; padding: 4px 0; font-size: var(--fs-sm); }
.pinned-lbl   { color: #444; font-size: 13px; }
.cal-grid { display: flex; flex-direction: column; gap: 6px; }
.ci {
  background: #090912;
  border: 1px solid #111;
  padding: 9px 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ci:hover { border-color: #1a2a1a; background: #0a0a14; }
.ci-today { font-size: 13px; color: #333; flex-shrink: 0; }
.ci-date  { font-size: 13px; color: #222; flex-shrink: 0; }
.ci-event { font-size: var(--fs-sm); flex: 1; }
.ci-high  { color: var(--yellow); }
.ci-click { font-size: 13px; color: #1a3a1a; flex-shrink: 0; }

/* Earnings */
.ei {
  background: #090912;
  border: 1px solid #0e0e1e;
  padding: 10px 12px;
  margin-bottom: 8px;
  cursor: pointer;
}
.ei:hover { border-color: #1a2a1a; }
.ei-top  { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.ei-sym  { font-size: var(--fs-hdr); color: #888; letter-spacing: 2px; }
.ei-tag  { font-size: 13px; padding: 2px 6px; border: 1px solid; }
.ei-amc  { color: var(--blue); border-color: #1a1a3a; background: #05050f; }
.ei-bmo  { color: var(--yellow); border-color: #3a2a0d; background: #0f0d05; }
.ei-row  { display: flex; justify-content: space-between; padding: 3px 0; font-size: var(--fs-sm); }
.ei-lbl  { color: #444; font-size: 13px; }
.ei-click{ font-size: 13px; color: #1a1a3a; margin-top: 5px; }

/* MOC/MOO (now in Intelligence tab) */
.imb-card {
  border: 1px solid #111;
  padding: 10px 12px;
  margin-bottom: 8px;
}
.imb-green { border-color: #1a3a1a; background: #050f07; }
.imb-yellow{ border-color: #3a2a0d; background: #0f0d05; }
.imb-red   { border-color: #3a1a1a; background: #0f0505; }
.imb-type  { font-size: 13px; letter-spacing: 1px; margin-bottom: 7px; }
.imb-row   { display: flex; gap: 10px; margin-bottom: 8px; }
.imb-col   { flex: 1; }
.imb-lbl   { font-size: 13px; color: #333; margin-bottom: 4px; }
.imb-dollar{ font-size: var(--fs-hdr); font-weight: bold; color: var(--green); }
.imb-val   { font-size: var(--fs-sm); font-weight: bold; }
.imb-signal{ font-size: var(--fs-sm); padding: 5px 8px; background: #090912; border: 1px solid #111; }

/* ══════════════════════════════════════════════════════════
   P&L DASHBOARD TAB
══════════════════════════════════════════════════════════ */
.pnl-main {
  padding: 8px;
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.stat-row { display: grid; grid-template-columns: repeat(5,1fr); gap: 8px; }
.stat-card { background: var(--bg2); border: 1px solid #0e0e1e; padding: 14px 16px; }
.stat-lbl  { font-size: 13px; color: #333; letter-spacing: 2px; margin-bottom: 8px; }
.stat-val  { font-size: 24px; font-weight: bold; }

.levels-row { display: grid; grid-template-columns: repeat(3,1fr); gap: 8px; }
.lvl-card   { background: var(--bg2); border: 1px solid #0e0e1e; padding: 12px 14px; }
.lvl-sym    { font-size: var(--fs-hdr); color: #888; letter-spacing: 2px; margin-bottom: 10px; }
.lvl-row    { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid #0a0a14; font-size: var(--fs-sm); }
.lvl-lbl    { color: #444; font-size: 13px; }

.pnl-tables { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.pnl-table  { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.pnl-table th { color: #333; font-size: 13px; letter-spacing: 1px; padding: 7px 8px; text-align: left; border-bottom: 1px solid #0e0e1e; background: #090912; }
.pnl-table td { padding: 7px 8px; border-bottom: 1px solid #0a0a14; font-size: var(--fs-sm); }

/* ══════════════════════════════════════════════════════════
   TRADE TAB
══════════════════════════════════════════════════════════ */
.trade-grid {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 8px;
  padding: 8px;
  flex: 1;
  overflow: hidden;
  min-height: 0;
}
.trade-cmd { display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
.pos-panel { display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }

.hank-signal-banner { padding: 12px 14px; border-bottom: 1px solid #0e0e1e; flex-shrink: 0; }

.mode-row  { display: flex; gap: 6px; }
.mode-btn  { flex: 1; padding: 9px; background: #0a0a14; border: 1px solid #111; color: #333; font-family: var(--mono); font-size: var(--fs-sm); cursor: pointer; letter-spacing: 1px; }
.mode-btn.active { color: var(--green); border-color: #1a3a1a; background: #050f07; }

.quick-syms { display: flex; gap: 6px; flex-wrap: wrap; }
.qs-chip { padding: 6px 14px; background: #0a0a14; border: 1px solid #111; color: #555; font-family: var(--mono); font-size: var(--fs-sm); cursor: pointer; }
.qs-chip:hover { color: var(--green); border-color: #1a3a1a; }
.qs-chip.active { color: var(--green); border-color: #1a3a1a; background: #050f07; }

.sym-input-row { display: flex; gap: 8px; }
.sym-input {
  flex: 1; background: var(--bg2); border: 1px solid #1a1a2a; color: #e0e0e0;
  padding: 9px 12px; font-family: var(--mono); font-size: var(--fs-hdr); outline: none;
  text-transform: uppercase; letter-spacing: 2px;
}
.sym-input:focus { border-color: var(--green); }
.fetch-btn { padding: 9px 18px; background: #050f07; border: 1px solid #1a3a1a; color: var(--green); font-family: var(--mono); font-size: var(--fs-sm); cursor: pointer; }

.quote-strip {
  display: flex; align-items: center; gap: 14px; padding: 8px 12px;
  background: #090912; border: 1px solid #0e0e1e; font-size: var(--fs-sm);
  flex-wrap: wrap;
}
.qs-sym   { color: #888; font-size: var(--fs-hdr); letter-spacing: 2px; }
.qs-price { font-size: var(--fs-price); font-weight: bold; }
.qs-item  { display: flex; align-items: center; gap: 5px; }
.qs-lbl   { color: #333; font-size: 13px; }

.side-row { display: flex; gap: 8px; }
.side-btn { flex: 1; padding: 11px; font-family: var(--mono); font-size: var(--fs-hdr); font-weight: bold; cursor: pointer; border: 2px solid; letter-spacing: 2px; }
.side-btn[data-side=calls] { background: #0a0a0a; border-color: #1a1a1a; color: #333; }
.side-btn[data-side=calls].active { background: #050f07; border-color: var(--green); color: var(--green); }
.side-btn[data-side=puts]  { background: #0a0a0a; border-color: #1a1a1a; color: #333; }
.side-btn[data-side=puts].active  { background: #0f0505; border-color: var(--red);   color: var(--red); }

.opts-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
.og-card { background: #090912; border: 1px solid #0e0e1e; padding: 10px 12px; }
.og-lbl  { font-size: 13px; color: #333; letter-spacing: 2px; margin-bottom: 8px; }
.og-row  { display: flex; justify-content: space-between; padding: 3px 0; font-size: var(--fs-sm); }

.strike-display-row {
  display: flex; align-items: center; gap: 10px;
  background: #090912; border: 1px solid #0e0e1e; padding: 12px 14px;
}
.strike-lbl { color: #333; font-size: 13px; letter-spacing: 2px; flex: 1; }
.strike-display { font-size: 28px; font-weight: bold; color: var(--green); flex: 1; text-align: center; }
.strike-adj { padding: 8px 14px; background: #0a0a14; border: 1px solid #111; color: #888; font-size: var(--fs-hdr); cursor: pointer; font-family: var(--mono); }
.strike-adj:hover { color: var(--green); }

.size-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 6px; }
.size-btn { padding: 10px 8px; background: #0a0a14; border: 1px solid #111; color: #555; font-family: var(--mono); font-size: var(--fs-hdr); cursor: pointer; text-align: center; }
.size-btn.active { color: var(--green); border-color: #1a3a1a; background: #050f07; }

.order-preview { background: #090912; border: 1px solid #0e0e1e; padding: 12px 14px; }
.op-row { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid #0a0a14; font-size: var(--fs-sm); }
.op-lbl { color: #333; font-size: 13px; letter-spacing: 1px; }
.op-val { color: #aaa; font-weight: bold; }

.exec-row { display: flex; gap: 8px; }
.exec-btn {
  flex: 1; padding: 14px; background: #050f07; border: 2px solid var(--green);
  color: var(--green); font-family: var(--mono); font-size: var(--fs-hdr);
  cursor: pointer; letter-spacing: 2px; font-weight: bold;
}
.exec-btn:hover { background: #0a1a0a; }
.closeall-btn {
  padding: 14px 16px; background: #0f0505; border: 2px solid var(--red);
  color: var(--red); font-family: var(--mono); font-size: var(--fs-sm); cursor: pointer; letter-spacing: 1px;
}
.paper-note { font-size: 13px; color: #1a1a3a; padding: 6px; text-align: center; }

.trade-log { max-height: 160px; overflow-y: auto; }
.tl-row   { display: flex; gap: 10px; padding: 5px 0; border-bottom: 1px solid #0a0a14; font-size: var(--fs-sm); }
.tl-time  { color: #333; flex-shrink: 0; font-size: 13px; }
.tl-text  { color: #666; }

.pos-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.pos-table th { color: #333; font-size: 13px; padding: 7px 8px; text-align: left; border-bottom: 1px solid #0e0e1e; background: #090912; }
.pos-table td { padding: 7px 8px; border-bottom: 1px solid #0a0a14; }
.pos-close-btn { background: #1a0505; border: 1px solid #3a1010; color: var(--red); font-family: var(--mono); font-size: 13px; padding: 3px 8px; cursor: pointer; }

/* ══════════════════════════════════════════════════════════
   SETTINGS TAB
══════════════════════════════════════════════════════════ */
.settings-main { padding: 8px; flex: 1; overflow-y: auto; }
.tv-launch-wrapper {
  padding: 0 0 16px 0;
}
#tvLaunchBtn {
  width: 100%;
  padding: 20px;
  background: #050f07;
  border: 2px solid var(--green);
  color: var(--green);
  font-family: var(--mono);
  font-size: var(--fs-major);
  font-weight: bold;
  letter-spacing: 3px;
  cursor: pointer;
}
#tvLaunchBtn:hover { background: #0a1a0a; box-shadow: 0 0 20px #00ff8822; }
.settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.setting-card-lbl { font-size: 13px; color: #333; letter-spacing: 2px; margin-bottom: 12px; }
.s-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #0a0a14; font-size: var(--fs-sm); }
.s-lbl { color: #666; font-size: var(--fs-sm); }
.s-toggle { padding: 5px 14px; background: #0a0a14; border: 1px solid #111; color: #444; font-family: var(--mono); font-size: 13px; cursor: pointer; }
.s-toggle.active { color: var(--green); border-color: #1a3a1a; background: #050f07; }
.api-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #0a0a14; font-size: var(--fs-sm); }
.api-lbl  { color: #666; font-size: var(--fs-sm); }
.api-stat.ok  { color: var(--green); font-size: 13px; }
.api-stat.err { color: var(--red); font-size: 13px; }
.api-stat.warn{ color: var(--yellow); font-size: 13px; }
.set-btn { padding: 7px 14px; background: #0a0a14; border: 1px solid #1a1a2a; color: #666; font-family: var(--mono); font-size: 13px; cursor: pointer; }
.set-btn:hover { color: var(--green); }
.risk-input {
  background: var(--bg2); border: 1px solid #1a1a2a; color: #e0e0e0;
  padding: 6px 10px; font-family: var(--mono); font-size: var(--fs-sm);
  width: 70px; text-align: right; outline: none;
}

/* ══════════════════════════════════════════════════════════
   DRAGGABLE WINDOWS
══════════════════════════════════════════════════════════ */
.drag-win {
  position: fixed;
  background: var(--bg2);
  border: 1px solid #1a1a2a;
  box-shadow: 0 8px 40px #00000088;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  min-width: 300px;
  min-height: 200px;
  resize: both;
  overflow: auto;
}
.dw-header {
  background: var(--bg3);
  border-bottom: 1px solid #111;
  padding: 9px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: grab;
  flex-shrink: 0;
  font-size: var(--fs-sm);
  color: var(--green);
  letter-spacing: 1px;
}
.dw-header:active { cursor: grabbing; }
.dw-close {
  background: none; border: none; color: #444; font-size: var(--fs-hdr);
  cursor: pointer; padding: 0 4px; font-family: var(--mono);
}
.dw-close:hover { color: var(--red); }
.dw-body { flex: 1; overflow-y: auto; }

/* Chat */
.chat-msg { display: flex; gap: 8px; padding: 6px 0; font-size: var(--fs-sm); }
.cm-who  { color: #333; font-size: 13px; flex-shrink: 0; width: 60px; }
.cm-text { color: #aaa; line-height: 1.6; }
.hank-msg .cm-who { color: var(--green); }
.user-msg .cm-who { color: var(--blue); }
.chat-input {
  flex: 1; background: var(--bg2); border: 1px solid #1a1a2a; color: #e0e0e0;
  padding: 8px 10px; font-family: var(--mono); font-size: var(--fs-sm); outline: none;
}
.chat-input:focus { border-color: var(--green); }
.chat-send { padding: 8px 14px; background: #050f07; border: 1px solid #1a3a1a; color: var(--green); font-family: var(--mono); font-size: var(--fs-sm); cursor: pointer; }

/* Calendar popup content */
.cal-section { margin-bottom: 14px; }
.cal-lbl  { font-size: 13px; color: #333; letter-spacing: 2px; margin-bottom: 6px; }
.cal-text { font-size: var(--fs-sm); color: #888; line-height: 1.7; }

/* ASK HANK button */
.ask-hank-btn {
  position: fixed;
  bottom: 16px;
  right: 16px;
  padding: 11px 20px;
  background: #050f07;
  border: 1px solid var(--green);
  color: var(--green);
  font-family: var(--mono);
  font-size: var(--fs-sm);
  cursor: pointer;
  letter-spacing: 2px;
  z-index: 999;
  box-shadow: 0 4px 20px #00ff8822;
}
.ask-hank-btn:hover { background: #0a1a0a; }

/* Confirm overlay */
.confirm-overlay {
  position: fixed; inset: 0;
  background: #000000cc;
  z-index: 2000;
  display: none;
  align-items: center;
  justify-content: center;
}
.confirm-box {
  background: var(--bg2);
  border: 1px solid #1a3a1a;
  padding: 28px;
  min-width: 360px;
  text-align: center;
}
.confirm-title   { color: var(--green); font-size: var(--fs-major); letter-spacing: 2px; margin-bottom: 14px; }
.confirm-order   { color: #e0e0e0; font-size: var(--fs-hdr); margin-bottom: 8px; }
.confirm-details { color: #888; font-size: var(--fs-sm); margin-bottom: 20px; }
.confirm-btns    { display: flex; gap: 10px; justify-content: center; }
.yes-btn { padding: 12px 28px; background: #050f07; border: 2px solid var(--green); color: var(--green); font-family: var(--mono); font-size: var(--fs-hdr); cursor: pointer; font-weight: bold; }
.no-btn  { padding: 12px 28px; background: #0f0505; border: 2px solid var(--red);   color: var(--red);   font-family: var(--mono); font-size: var(--fs-hdr); cursor: pointer; }
.paper-note { color: #1a1a3a; font-size: 13px; margin-top: 12px; }

/* Fill toast */
.fill-toast {
  position: fixed;
  bottom: 70px;
  right: 16px;
  background: #050f07;
  border: 1px solid var(--green);
  padding: 14px 20px;
  z-index: 1500;
  font-size: var(--fs-sm);
  transform: translateX(120%);
  transition: transform 0.3s;
  max-width: 340px;
}
.fill-toast.show { transform: translateX(0); }
.ft-title { color: var(--green); font-size: var(--fs-hdr); letter-spacing: 2px; margin-bottom: 5px; }
.ft-body  { color: #888; }

/* Scrollbars */
::-webkit-scrollbar       { width: 4px; height: 4px; }
::-webkit-scrollbar-track { background: #0a0a14; }
::-webkit-scrollbar-thumb { background: #1a1a2a; }
::-webkit-scrollbar-thumb:hover { background: #2a2a3a; }

/* Utility */
select { color: #ccc; }
button:disabled { opacity: 0.4; cursor: default; }
</style>
</head>
<body>`;

fs.appendFileSync(file, s1);
console.log('S1 done:', s1.length);
