const fs = require('fs');
const file = 'C:\\Users\\tomav\\tradingview-mcp-jackson\\hank-electron-r3.html';
let h = fs.readFileSync(file, 'utf8');

// ─── FONT SIZE: update CSS custom properties (+12%) ──────────
h = h.replace(
  /--fs-xs:\s*13px;/g,
  '--fs-xs:   13px;'   // keep: body text minimum
);
h = h.replace(
  /--fs-sm:\s*14px;/,
  '--fs-sm:   16px;'   // 14 * 1.12 = 15.68 → 16
);
h = h.replace(
  /--fs-base:\s*14px;/,
  '--fs-base: 16px;'
);
h = h.replace(
  /--fs-hdr:\s*16px;/,
  '--fs-hdr:  18px;'   // 16 * 1.12 = 17.92 → 18 (header minimum)
);
h = h.replace(
  /--fs-lbl:\s*14px;/,
  '--fs-lbl:  16px;'
);
h = h.replace(
  /--fs-price:\s*20px;/,
  '--fs-price: 22px;'  // 20 * 1.12 = 22.4 → 22
);
h = h.replace(
  /--fs-sig:\s*18px;/,
  '--fs-sig:  20px;'   // 18 * 1.12 = 20.16 → 20
);
h = h.replace(
  /--fs-major:\s*24px;/,
  '--fs-major: 27px;'  // 24 * 1.12 = 26.88 → 27
);
h = h.replace(
  /--fs-xl:\s*28px;/,
  '--fs-xl:   32px;'   // 28 * 1.12 = 31.36 → 32
);

// ─── FONT SIZE: hardcoded sizes in CSS classes (+12%) ────────
// 13px stays 13px (body min) unless explicitly data label/value
// spy-price: 32px → 36px
h = h.replace(/\.spy-price\s*\{[^}]*font-size:\s*32px/, (m) => m.replace('32px', '36px'));
// sc-sym: 22px → 25px
h = h.replace(/\.sc-sym\s*\{[^}]*font-size:\s*22px/, (m) => m.replace('22px', '25px'));
// tb-logo: 20px → 22px
h = h.replace(/\.tb-logo\s*\{[^}]*font-size:\s*20px/, (m) => m.replace('20px', '22px'));
// tb-div: 20px → 22px
h = h.replace(/\.tb-div\s*\{[^}]*font-size:\s*20px/, (m) => m.replace('20px', '22px'));
// nav-icon: 16px → 18px
h = h.replace(/\.nav-icon\s*\{[^}]*font-size:\s*16px/, (m) => m.replace('16px', '18px'));
// stat-val: 24px → 27px
h = h.replace(/\.stat-val\s*\{[^}]*font-size:\s*24px/, (m) => m.replace('24px', '27px'));
// mon-table th: 13px → 14px (table header = data label min)
h = h.replace(/\.mon-table th\s*\{([^}]*)font-size:\s*13px/, (m, p1) => m.replace('13px', '14px'));
// om-table th: 13px → 14px
h = h.replace(/\.om-table th\s*\{([^}]*)font-size:\s*13px/, (m) => m.replace('13px', '14px'));
// opt-b-ladder th: 13px → 14px
h = h.replace(/\.opt-b-ladder th\s*\{([^}]*)font-size:\s*13px/, (m) => m.replace('13px', '14px'));
// ob-sym, ob-exp: 13px → 14px
h = h.replace(/\.ob-sym, \.ob-exp\s*\{([^}]*)font-size:\s*13px/, (m) => m.replace('13px', '14px'));
// al (account labels): 13px → 14px
h = h.replace(/\.al\s*\{[^}]*font-size:\s*13px/, (m) => m.replace('13px', '14px'));
// mkt-k (AUTONOMOUS column labels): 13px → 14px
h = h.replace(/\.mkt-k\s*\{[^}]*font-size:\s*13px/, (m) => m.replace('13px', '14px'));

// ─── COLORS: labels → #aaaaaa ────────────────────────────────

// .mkt-k (AUTONOMOUS column labels: PRICE, VWAP, 9EMA, etc.)
h = h.replace(
  '.mkt-k     { color: #333; font-size: 13px; letter-spacing: 1px; }',
  '.mkt-k     { color: #aaaaaa; font-size: 14px; letter-spacing: 1px; }'
);

// .ib-lbl (infobar labels)
h = h.replace(
  '.ib-lbl  { color: #333; margin-right: 4px; font-size: 13px; }',
  '.ib-lbl  { color: #aaaaaa; margin-right: 4px; font-size: 13px; }'
);

// .ps (panel subtitle)
h = h.replace(
  '.ps { color: #333; font-size: 13px; }',
  '.ps { color: #aaaaaa; font-size: 13px; }'
);

// .tb-dot-lbl
h = h.replace(
  '.tb-dot-lbl { font-size: 13px; color: #333; }',
  '.tb-dot-lbl { font-size: 13px; color: #888; }'
);

// .svc-title
h = h.replace(
  '.svc-title { font-size: 13px; color: #222; letter-spacing: 2px; margin-bottom: 8px; }',
  '.svc-title { font-size: 13px; color: #777; letter-spacing: 2px; margin-bottom: 8px; }'
);

// .svc-name
h = h.replace(
  '.svc-name { flex: 1; font-size: 13px; color: #555; }',
  '.svc-name { flex: 1; font-size: 13px; color: #aaaaaa; }'
);

// .svc-btn
h = h.replace(
  '.svc-btn { background: #0a0a14; border: 1px solid #1a1a2a; color: #444; font-size: 13px; padding: 2px 7px; cursor: pointer; font-family: var(--mono); }',
  '.svc-btn { background: #0a0a14; border: 1px solid #1a1a2a; color: #888; font-size: 13px; padding: 2px 7px; cursor: pointer; font-family: var(--mono); }'
);

// sidebar log entries — make them readable but still dim (intentional log style)
h = h.replace(
  '.ll   { color: #2a2a3a; margin-bottom: 3px; }',
  '.ll   { color: #555; margin-bottom: 3px; }'
);
h = h.replace(
  '.ll.g { color: #1a3a1a; }',
  '.ll.g { color: #447744; }'
);
h = h.replace(
  '.ll.y { color: #3a3010; }',
  '.ll.y { color: #776622; }'
);
h = h.replace(
  '.ll.r { color: #3a1010; }',
  '.ll.r { color: #774422; }'
);

// .nav-tab inactive
h = h.replace(
  /\.nav-tab \{\s*\n(.*\n)*?.*color: #444;/,
  (m) => m.replace('color: #444;', 'color: #888;')
);

// .ac-time
h = h.replace(
  '.ac-time  { color: #333; font-size: 13px; }',
  '.ac-time  { color: #aaaaaa; font-size: 13px; }'
);

// .ac-para — body text HANK LIVE ANALYSIS
h = h.replace(
  '.ac-para  { font-size: var(--fs-sm); color: #888; line-height: 1.7; margin-bottom: 10px; }',
  '.ac-para  { font-size: var(--fs-sm); color: #dddddd; line-height: 1.7; margin-bottom: 10px; }'
);

// .ae-lbl (entry label)
h = h.replace(
  '.ae-lbl   { color: #333; font-size: 13px; letter-spacing: 1px; }',
  '.ae-lbl   { color: #aaaaaa; font-size: 13px; letter-spacing: 1px; }'
);

// .ae-val — primary data values
h = h.replace(
  '.ae-val   { color: #888; }',
  '.ae-val   { color: #ffffff; }'
);

// .auto-arm-btn
h = h.replace(
  '.auto-arm-btn {\n  background: #0a0a12;\n  border: 1px solid #1a1a2a;\n  color: #555;',
  '.auto-arm-btn {\n  background: #0a0a12;\n  border: 1px solid #1a1a2a;\n  color: #aaaaaa;'
);

// .bs-lbl (bottom bar labels)
h = h.replace(
  '.bs-lbl { font-size: 13px; color: #333; letter-spacing: 1px; }',
  '.bs-lbl { font-size: 13px; color: #aaaaaa; letter-spacing: 1px; }'
);

// .mon-table th (MONITOR table headers)
h = h.replace(
  '.mon-table th {\n  color: #333;',
  '.mon-table th {\n  color: #aaaaaa;'
);

// .mon-table .sym
h = h.replace(
  '.mon-table .sym { color: #888; font-size: var(--fs-hdr); letter-spacing: 2px; }',
  '.mon-table .sym { color: #cccccc; font-size: var(--fs-hdr); letter-spacing: 2px; }'
);

// .spy-lbl-sm
h = h.replace(
  '.spy-lbl-sm { font-size: 13px; color: #444; letter-spacing: 2px; }',
  '.spy-lbl-sm { font-size: 13px; color: #aaaaaa; letter-spacing: 2px; }'
);

// .spy-lbl
h = h.replace(
  '.spy-lbl    { color: #444; font-size: 13px; }',
  '.spy-lbl    { color: #aaaaaa; font-size: 13px; }'
);

// .sig-reason
h = h.replace(
  '.sig-reason { font-size: var(--fs-sm); color: #666; line-height: 1.6; margin-bottom: 6px; }',
  '.sig-reason { font-size: var(--fs-sm); color: #bbbbbb; line-height: 1.6; margin-bottom: 6px; }'
);

// .sig-strike
h = h.replace(
  '.sig-strike { font-size: var(--fs-sm); color: #888; }',
  '.sig-strike { font-size: var(--fs-sm); color: #cccccc; }'
);

// .af-latest (analysis feed entries)
h = h.replace(
  '.af-latest { color: #aaa; }',
  '.af-latest { color: #dddddd; }'
);

// .af-time
h = h.replace(
  '.af-time { color: #333; font-size: 13px; flex-shrink: 0; }',
  '.af-time { color: #aaaaaa; font-size: 13px; flex-shrink: 0; }'
);

// .af-text (give it an explicit readable color)
h = h.replace(
  '.af-text { line-height: 1.6; }',
  '.af-text { line-height: 1.6; color: #cccccc; }'
);

// .win3-lbl
h = h.replace(
  '.win3-lbl { font-size: 13px; color: #333; letter-spacing: 2px; margin-bottom: 8px; }',
  '.win3-lbl { font-size: 13px; color: #aaaaaa; letter-spacing: 2px; margin-bottom: 8px; }'
);

// .win3-sym
h = h.replace(
  '.win3-sym  { color: #666; font-size: 13px; }',
  '.win3-sym  { color: #aaaaaa; font-size: 13px; }'
);

// .al (account labels)
h = h.replace(
  '.al { color: #444; font-size: 13px; }',
  '.al { color: #aaaaaa; font-size: 14px; }'
);

// .av (account values) — primary data
h = h.replace(
  '.av { color: #888; font-weight: bold; }',
  '.av { color: #ffffff; font-weight: bold; }'
);

// .ob-pick (option B selected pick description)
h = h.replace(
  '.ob-pick   { font-size: var(--fs-sm); color: #888; }',
  '.ob-pick   { font-size: var(--fs-sm); color: #cccccc; }'
);

// .ob-sym, .ob-exp (inactive tabs)
h = h.replace(
  '.ob-sym, .ob-exp {\n  font-size: 13px;\n  padding: 4px 10px;\n  border: 1px solid #111;\n  color: #333;',
  '.ob-sym, .ob-exp {\n  font-size: 14px;\n  padding: 4px 10px;\n  border: 1px solid #111;\n  color: #aaaaaa;'
);

// Option B ladder: th headers
h = h.replace(
  '.opt-b-ladder th {\n  color: #333;',
  '.opt-b-ladder th {\n  color: #aaaaaa;'
);

// Option B ladder: td values → #ffffff
h = h.replace(
  '.opt-b-ladder td {\n  padding: 6px 6px;\n  text-align: right;\n  color: #666;',
  '.opt-b-ladder td {\n  padding: 6px 6px;\n  text-align: right;\n  color: #ffffff;'
);
h = h.replace(
  '.opt-b-ladder td:first-child { text-align: left; color: #555; }',
  '.opt-b-ladder td:first-child { text-align: left; color: #ffffff; }'
);

// Option C mini table: th headers
h = h.replace(
  '.om-table th {\n  color: #333;',
  '.om-table th {\n  color: #aaaaaa;'
);

// Option C mini table: td values → #ffffff
h = h.replace(
  '.om-table td {\n  padding: 5px 5px;\n  text-align: right;\n  color: #888;',
  '.om-table td {\n  padding: 5px 5px;\n  text-align: right;\n  color: #ffffff;'
);
h = h.replace(
  '.om-table td:first-child { text-align: left; color: #666; }',
  '.om-table td:first-child { text-align: left; color: #ffffff; }'
);

// wait rows — slightly dimmer but still visible
h = h.replace(
  '.om-wait-row td { color: #444 !important; }',
  '.om-wait-row td { color: #666 !important; }'
);

// wait exec btn
h = h.replace(
  '.om-exec-btn.wait {\n  background: #0a0a0a;\n  border-color: #1a1a1a;\n  color: #333;',
  '.om-exec-btn.wait {\n  background: #0a0a0a;\n  border-color: #1a1a1a;\n  color: #666;'
);

// opt-mini-title
h = h.replace(
  '.opt-mini-title {\n  font-size: 13px;\n  color: #333;',
  '.opt-mini-title {\n  font-size: 13px;\n  color: #aaaaaa;'
);

// om-tab inactive
h = h.replace(
  '.om-tab {\n  font-size: 13px;\n  color: #333;',
  '.om-tab {\n  font-size: 13px;\n  color: #aaaaaa;'
);

// om-refresh
h = h.replace(
  '.om-refresh { font-size: 13px; color: #222; }',
  '.om-refresh { font-size: 13px; color: #888; }'
);

// .sc-reason
h = h.replace(
  '.sc-reason { font-size: 13px; color: #555; line-height: 1.5; }',
  '.sc-reason { font-size: 13px; color: #aaaaaa; line-height: 1.5; }'
);

// .conf-wk (weak confidence label)
h = h.replace(
  '.conf-wk   { color: #555; font-size: var(--fs-hdr); font-weight: bold; }',
  '.conf-wk   { color: #aaaaaa; font-size: var(--fs-hdr); font-weight: bold; }'
);

// .bc-title (briefing section titles)
h = h.replace(
  '.bc-title { font-size: 13px; color: #333; letter-spacing: 2px; margin-bottom: 8px; }',
  '.bc-title { font-size: 13px; color: #aaaaaa; letter-spacing: 2px; margin-bottom: 8px; }'
);

// .bc-lbl (briefing row labels)
h = h.replace(
  '.bc-lbl   { color: #444; font-size: 13px; }',
  '.bc-lbl   { color: #aaaaaa; font-size: 13px; }'
);

// .plan-item
h = h.replace(
  '.plan-item { font-size: var(--fs-sm); color: #666; padding: 3px 0; border-bottom: 1px solid #0a0a14; }',
  '.plan-item { font-size: var(--fs-sm); color: #cccccc; padding: 3px 0; border-bottom: 1px solid #0a0a14; }'
);

// .nb-gray
h = h.replace(
  '.nb-gray   { color: #444;          font-size: var(--fs-sm); padding: 3px 0; }',
  '.nb-gray   { color: #aaaaaa;       font-size: var(--fs-sm); padding: 3px 0; }'
);

// .nsrc
h = h.replace(
  '.nsrc    { color: #333; font-size: 13px; }',
  '.nsrc    { color: #aaaaaa; font-size: 13px; }'
);

// .ntime
h = h.replace(
  '.ntime   { color: #222; font-size: 13px; margin-left: auto; }',
  '.ntime   { color: #888; font-size: 13px; margin-left: auto; }'
);

// .ntext (news body text)
h = h.replace(
  '.ntext   { font-size: var(--fs-sm); color: #aaa; margin-bottom: 4px; line-height: 1.5; }',
  '.ntext   { font-size: var(--fs-sm); color: #dddddd; margin-bottom: 4px; line-height: 1.5; }'
);

// .cred-lo
h = h.replace(
  '.cred-lo { color: #555; }',
  '.cred-lo { color: #aaaaaa; }'
);

// .pinned-lbl
h = h.replace(
  '.pinned-lbl   { color: #444; font-size: 13px; }',
  '.pinned-lbl   { color: #aaaaaa; font-size: 13px; }'
);

// .ci-today
h = h.replace(
  '.ci-today { font-size: 13px; color: #333; flex-shrink: 0; }',
  '.ci-today { font-size: 13px; color: #aaaaaa; flex-shrink: 0; }'
);

// .ci-date
h = h.replace(
  '.ci-date  { font-size: 13px; color: #222; flex-shrink: 0; }',
  '.ci-date  { font-size: 13px; color: #888; flex-shrink: 0; }'
);

// .ci-click
h = h.replace(
  '.ci-click { font-size: 13px; color: #1a3a1a; flex-shrink: 0; }',
  '.ci-click { font-size: 13px; color: #336633; flex-shrink: 0; }'
);

// .ei-sym
h = h.replace(
  '.ei-sym  { font-size: var(--fs-hdr); color: #888; letter-spacing: 2px; }',
  '.ei-sym  { font-size: var(--fs-hdr); color: #cccccc; letter-spacing: 2px; }'
);

// .ei-lbl
h = h.replace(
  '.ei-lbl  { color: #444; font-size: 13px; }',
  '.ei-lbl  { color: #aaaaaa; font-size: 13px; }'
);

// .ei-click
h = h.replace(
  '.ei-click{ font-size: 13px; color: #1a1a3a; margin-top: 5px; }',
  '.ei-click{ font-size: 13px; color: #334466; margin-top: 5px; }'
);

// .imb-lbl
h = h.replace(
  '.imb-lbl   { font-size: 13px; color: #333; margin-bottom: 4px; }',
  '.imb-lbl   { font-size: 13px; color: #aaaaaa; margin-bottom: 4px; }'
);

// .imb-signal
h = h.replace(
  '.imb-signal{ font-size: var(--fs-sm); padding: 5px 8px; background: #090912; border: 1px solid #111; }',
  '.imb-signal{ font-size: var(--fs-sm); color: #cccccc; padding: 5px 8px; background: #090912; border: 1px solid #111; }'
);

// .stat-lbl
h = h.replace(
  '.stat-lbl  { font-size: 13px; color: #333; letter-spacing: 2px; margin-bottom: 8px; }',
  '.stat-lbl  { font-size: 13px; color: #aaaaaa; letter-spacing: 2px; margin-bottom: 8px; }'
);

// ─── COLORS: inline styles in HTML (inline color="dark" fixes) ─
// nav-tab inactive text color in JavaScript-driven areas
h = h.replace(/color:#333;font-size:10px/g, 'color:#aaaaaa;font-size:13px');
h = h.replace(/color:#333;font-size:11px/g, 'color:#aaaaaa;font-size:13px');
h = h.replace(/color:#444;font-size:11px/g, 'color:#aaaaaa;font-size:13px');
h = h.replace(/color:#555;font-size:10px/g, 'color:#aaaaaa;font-size:13px');
h = h.replace(/color:#555;font-size:11px/g, 'color:#aaaaaa;font-size:13px');

// Fix specific inline dark colors used for labels/secondary text in HTML
h = h.replace(/style="color:#333;/g, 'style="color:#aaaaaa;');
h = h.replace(/style="color:#444;/g, 'style="color:#aaaaaa;');
h = h.replace(/style="color:#555;/g, 'style="color:#aaaaaa;');
h = h.replace(/style="color:#666;/g, 'style="color:#aaaaaa;');

// BUT: preserve border/background color values that use these shades
// (those are in style="background:" and "border:" contexts, not "color:")
// The above regex only matches style="color:#... so borders/backgrounds are safe.

// Fix source label inline style in instrument columns
h = h.replace(
  /style="color:#333;font-size:13px;">monitor\./g,
  'style="color:#888;font-size:13px;">monitor.'
);
// Also the general source text spans
h = h.replace(
  /"color:#333;font-size:13px;">monitor-/g,
  '"color:#888;font-size:13px;">monitor-'
);

// ─── FONT SIZES: increase inline hardcoded sizes in HTML (+12%) ─
// 32px → 36px (spy-price inline if any)
h = h.replace(/font-size:32px/g, 'font-size:36px');
// 24px → 27px (stat-val, master-sig inline)
h = h.replace(/font-size:24px/g, 'font-size:27px');
// 22px → 25px
h = h.replace(/font-size:22px/g, 'font-size:25px');
// 20px → 22px (inline auto-trade engine selects etc)
h = h.replace(/font-size:20px/g, 'font-size:22px');
// 18px → 20px (inline headers)
h = h.replace(/font-size:18px/g, 'font-size:20px');
// 16px → 18px (inline headers - but only in style= attributes, not CSS classes already fixed)
h = h.replace(/font-size:16px/g, 'font-size:18px');
// 14px → 16px (inline body text)
h = h.replace(/font-size:14px/g, 'font-size:16px');
// Do NOT touch 13px inline — keep at minimum

// Fix the inline separator pipe characters that got bumped (they used font-size:18px for │)
// We bumped 18→20 above, that's fine — separators can be slightly bigger

// ─── INLINE DARK LABEL TEXT: source tag in auto col ─────────
// The .mkt-v SOURCE row has inline style with color:#333 (now fixed to #aaa above)
// but some JS-generated HTML also uses dark colors — patch the JS template strings
h = h.replace(
  /\\`<span style=\\"color:#333;font-size:13px;\\">monitor\./g,
  '`<span style="color:#888;font-size:13px;">monitor.'
);

// ─── INLINE BACKGROUND dark → keep as decorative (skip) ──────
// Restore: background:#333 should NOT have been changed — only foreground color was changed.
// Since we only targeted style="color:#... these are safe.

// ─── WRITE ───────────────────────────────────────────────────
fs.writeFileSync(file, h, 'utf8');
console.log('Patch applied. File size:', Math.round(h.length / 1024) + 'KB');

// Verify key changes
const checks = [
  ['mkt-k #aaaaaa',     h.includes('.mkt-k     { color: #aaaaaa;')],
  ['ac-para #dddddd',   h.includes('color: #dddddd; line-height: 1.7')],
  ['ae-val #ffffff',    h.includes('.ae-val   { color: #ffffff; }')],
  ['om-table td white', h.includes('color: #ffffff;\n  border-bottom: 1px solid #0a0a14;\n  font-size: var(--fs-sm)')],
  ['opt-b-td white',    h.includes('color: #ffffff;\n  border-bottom: 1px solid #0a0a14;\n  font-size: var(--fs-sm)')],
  ['ntext #dddddd',     h.includes('color: #dddddd; margin-bottom: 4px')],
  ['fs-sm 16px',        h.includes('--fs-sm:   16px;')],
  ['fs-hdr 18px',       h.includes('--fs-hdr:  18px;')],
  ['fs-major 27px',     h.includes('--fs-major: 27px;')],
  ['fs-xl 32px',        h.includes('--fs-xl:   32px;')],
];
checks.forEach(([name, ok]) => console.log((ok ? '✓' : '✗') + ' ' + name));
