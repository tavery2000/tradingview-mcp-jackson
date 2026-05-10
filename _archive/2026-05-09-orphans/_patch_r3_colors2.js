const fs = require('fs');
const file = 'C:\\Users\\tomav\\tradingview-mcp-jackson\\hank-electron-r3.html';
let h = fs.readFileSync(file, 'utf8');

// All remaining CSS class-level color:#333 labels → #aaaaaa
// These are all label/secondary text, none are intentional near-black decorations

const fixes = [
  // ob-sym/ob-exp (options tab buttons, inactive)
  [/(\n  color: #333;\n  cursor: pointer;\n  background: transparent;)/, '\n  color: #aaaaaa;\n  cursor: pointer;\n  background: transparent;'],
  // news-tab inactive
  ['.news-tab  { font-size: 13px; color: #333; padding: 4px 10px; border: 1px solid #111; cursor: pointer; font-family: var(--mono); }',
   '.news-tab  { font-size: 13px; color: #aaaaaa; padding: 4px 10px; border: 1px solid #111; cursor: pointer; font-family: var(--mono); }'],
  // pnl-table th
  ['.pnl-table th { color: #333; font-size: 13px;',
   '.pnl-table th { color: #aaaaaa; font-size: 13px;'],
  // mode-btn inactive
  ['.mode-btn  { flex: 1; padding: 9px; background: #0a0a14; border: 1px solid #111; color: #333;',
   '.mode-btn  { flex: 1; padding: 9px; background: #0a0a14; border: 1px solid #111; color: #aaaaaa;'],
  // qs-lbl (quote strip labels)
  ['.qs-lbl   { color: #333; font-size: 13px; }',
   '.qs-lbl   { color: #aaaaaa; font-size: 13px; }'],
  // side-btn inactive calls
  ['.side-btn[data-side=calls] { background: #0a0a0a; border-color: #1a1a1a; color: #333; }',
   '.side-btn[data-side=calls] { background: #0a0a0a; border-color: #1a1a1a; color: #666; }'],
  // side-btn inactive puts
  ['.side-btn[data-side=puts]  { background: #0a0a0a; border-color: #1a1a1a; color: #333; }',
   '.side-btn[data-side=puts]  { background: #0a0a0a; border-color: #1a1a1a; color: #666; }'],
  // og-lbl (options grid labels)
  ['.og-lbl  { font-size: 13px; color: #333; letter-spacing: 2px; margin-bottom: 8px; }',
   '.og-lbl  { font-size: 13px; color: #aaaaaa; letter-spacing: 2px; margin-bottom: 8px; }'],
  // strike-lbl
  ['.strike-lbl { color: #333; font-size: 13px; letter-spacing: 2px; flex: 1; }',
   '.strike-lbl { color: #aaaaaa; font-size: 13px; letter-spacing: 2px; flex: 1; }'],
  // op-lbl (order preview labels)
  ['.op-lbl { color: #333; font-size: 13px; letter-spacing: 1px; }',
   '.op-lbl { color: #aaaaaa; font-size: 13px; letter-spacing: 1px; }'],
  // tl-time (trade log timestamps)
  ['.tl-time  { color: #333; flex-shrink: 0; font-size: 13px; }',
   '.tl-time  { color: #aaaaaa; flex-shrink: 0; font-size: 13px; }'],
  // pos-table th
  ['.pos-table th { color: #333; font-size: 13px;',
   '.pos-table th { color: #aaaaaa; font-size: 13px;'],
  // setting-card-lbl
  ['.setting-card-lbl { font-size: 13px; color: #333; letter-spacing: 2px; margin-bottom: 12px; }',
   '.setting-card-lbl { font-size: 13px; color: #aaaaaa; letter-spacing: 2px; margin-bottom: 12px; }'],
  // cm-who (chat "YOU" label)
  ['.cm-who  { color: #333; font-size: 13px; flex-shrink: 0; width: 60px; }',
   '.cm-who  { color: #aaaaaa; font-size: 13px; flex-shrink: 0; width: 60px; }'],
  // cal-lbl (calendar popup section labels)
  ['.cal-lbl  { font-size: 13px; color: #333; letter-spacing: 2px; margin-bottom: 6px; }',
   '.cal-lbl  { font-size: 13px; color: #aaaaaa; letter-spacing: 2px; margin-bottom: 6px; }'],
];

for (const [from, to] of fixes) {
  if (from instanceof RegExp) {
    h = h.replace(from, to);
  } else {
    if (!h.includes(from)) console.warn('NOT FOUND:', from.slice(0, 60));
    h = h.replace(from, to);
  }
}

// Also fix remaining .s-lbl, .api-lbl, .lvl-lbl if dark
h = h.replace('.s-lbl { color: #666; font-size: var(--fs-sm); }',
              '.s-lbl { color: #aaaaaa; font-size: var(--fs-sm); }');
h = h.replace('.api-lbl  { color: #666; font-size: var(--fs-sm); }',
              '.api-lbl  { color: #aaaaaa; font-size: var(--fs-sm); }');
h = h.replace('.lvl-lbl    { color: #444; font-size: 13px; }',
              '.lvl-lbl    { color: #aaaaaa; font-size: 13px; }');
h = h.replace('.s-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #0a0a14; font-size: var(--fs-sm); }',
              '.s-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #0a0a14; font-size: var(--fs-sm); color: #cccccc; }');
h = h.replace('.api-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #0a0a14; font-size: var(--fs-sm); }',
              '.api-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #0a0a14; font-size: var(--fs-sm); color: #cccccc; }');

// Fix op-val in order preview (data values should be white)
h = h.replace('.op-val { color: #aaa; font-weight: bold; }',
              '.op-val { color: #ffffff; font-weight: bold; }');

// tl-text (trade log entries)
h = h.replace('.tl-text  { color: #666; }',
              '.tl-text  { color: #aaaaaa; }');

// cal-text in popup
h = h.replace('.cal-text { font-size: var(--fs-sm); color: #888; line-height: 1.7; }',
              '.cal-text { font-size: var(--fs-sm); color: #cccccc; line-height: 1.7; }');

// og-row values in TRADE tab
h = h.replace('.og-row  { display: flex; justify-content: space-between; padding: 3px 0; font-size: var(--fs-sm); }',
              '.og-row  { display: flex; justify-content: space-between; padding: 3px 0; font-size: var(--fs-sm); color: #cccccc; }');

fs.writeFileSync(file, h, 'utf8');
console.log('Color patch 2 applied. File size:', Math.round(h.length / 1024) + 'KB');

// Verify no remaining CSS color:#333
const remaining = (h.match(/color: #333/g) || []).length;
const remaining444 = (h.match(/color: #444/g) || []).length;
const remaining555 = (h.match(/\..*color: #555/g) || []).length;
console.log('Remaining color:#333:', remaining, '(should be 0)');
console.log('Remaining color:#444:', remaining444, '(should be 0)');
console.log('CSS color:#555 classes:', remaining555, '(should be 0)');
