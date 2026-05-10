// Unit test for mocOrderToConsensus — verifies field-by-field mapping
// from moc.js's order shape to paperTrading.sendOrder's consensus shape.
//
// Asserts:
//   - signal/engine/instrument/strike/contracts pass through correctly
//   - confidence label derived from conviction score (>=4 HIGH, else MEDIUM)
//   - finalConfidence numeric is score/5 clamped 0..1
//   - tag carries the 'NO_EXIT_PRICE' marker
//   - context bundles the MOC-specific fields without losing them
//   - works for both CALLS (BUY) and PUTS (SELL) directions
//
// Run: node _test_moc_route.js   (no arguments)
import { mocOrderToConsensus, buildOrder } from './moc.js';

const tests = [];
function assert(name, cond, detail) {
  tests.push({ name, pass: !!cond, detail: detail ?? '' });
}

// ─── Test 1: CALLS conviction 4 (HIGH) ──────────────────
const callsOrder = {
  id: 'MOC-test-1', source: 'MOC_ENGINE', timestamp: Date.now(),
  underlying: 'XSP', optionType: 'CALL', strike: 5847.5, expiry: '2026-05-09',
  action: 'BUY_TO_OPEN', contracts: 5, limitPrice: 0.25, deltaEst: 0.15,
  conviction: 4, hardExitAt: '15:59 ET', status: 'OPEN',
  entrySpyPrice: 5840, entrySpyDelta: 1500, entryTime: '15:51:23',
  snapshotBias: 'bullish',
};
const c1 = mocOrderToConsensus(callsOrder, 'CALLS', { score: 4 });

assert('CALLS signal',         c1.signal === 'CALLS');
assert('engine MOC',           c1.engine === 'MOC');
assert('instrument XSP',       c1.instrument === 'XSP');
assert('strike preserved',     c1.strike === 5847.5);
assert('entryPrice = limit',   c1.entryPrice === 0.25);
assert('confidence HIGH',      c1.confidence === 'HIGH', `got ${c1.confidence}`);
assert('finalConfidence 0.8',  c1.finalConfidence === 0.8, `got ${c1.finalConfidence}`);
assert('contracts = 5',        c1.contracts === 5);
assert('underlyingPrice 5840', c1.underlyingPrice === 5840);
assert('sessionWindow MOC',    c1.sessionWindow === 'MOC');
assert('tag has MOC_ENGINE',   c1.tag?.includes('MOC_ENGINE'));
assert('tag has NO_EXIT_PRICE',c1.tag?.includes('NO_EXIT_PRICE'),
  `tag was: "${c1.tag}"`);
assert('context.conviction',   c1.context.conviction === 4);
assert('context.snapshotBias', c1.context.snapshotBias === 'bullish');
assert('context.entrySpyDelta',c1.context.entrySpyDelta === 1500);
assert('context.expiry kept',  c1.context.expiry === '2026-05-09');
assert('context.deltaEst kept',c1.context.deltaEst === 0.15);
assert('context.hardExitAt',   c1.context.hardExitAt === '15:59 ET');
assert('context.mocSource',    c1.context.mocSource === 'MOC_ENGINE');

// ─── Test 2: PUTS conviction 2 (MEDIUM) ─────────────────
const putsOrder = { ...callsOrder, optionType: 'PUT', conviction: 2,
                    snapshotBias: 'bearish', entrySpyDelta: -2200 };
const c2 = mocOrderToConsensus(putsOrder, 'PUTS', { score: 2 });

assert('PUTS signal',           c2.signal === 'PUTS');
assert('PUTS confidence MEDIUM',c2.confidence === 'MEDIUM');
assert('PUTS finalConf 0.4',    c2.finalConfidence === 0.4);
assert('PUTS context.bias',     c2.context.snapshotBias === 'bearish');

// ─── Test 3: conviction 5 (max HIGH) ────────────────────
const c3 = mocOrderToConsensus(callsOrder, 'CALLS', { score: 5 });
assert('score 5 → HIGH',        c3.confidence === 'HIGH');
assert('score 5 → final 1.0',   c3.finalConfidence === 1.0);

// ─── Test 4: edge cases ─────────────────────────────────
const c4 = mocOrderToConsensus(callsOrder, 'CALLS', null);  // no conviction
assert('null conviction → MEDIUM', c4.confidence === 'MEDIUM');
assert('null conviction → 0',      c4.finalConfidence === 0);

// ─── Test 5: buildOrder still produces the legacy shape ──
// (kept for forensic continuity; the test ensures we didn't accidentally
//  break the legacy moc.js path while routing).
const live = { spyPrice: 5840, spyDelta: 1500 };
const strike = { underlying: 'XSP', optionType: 'CALL', strike: 5847.5,
                 expiry: '2026-05-09', estimatedPremium: 0.25, deltaEst: 0.15 };
// buildOrder reads `live` and `snapshot` from module scope; passing through
// the values the import sees by inserting them into module via globals isn't
// trivial, so just spot-check buildOrder returns a plausible shape.
const bo = buildOrder(strike, 'CALLS', { score: 4 }, 5);
assert('buildOrder has source', bo.source === 'MOC_ENGINE');
assert('buildOrder has strike', bo.strike === 5847.5);
assert('buildOrder has contracts', bo.contracts === 5);

// ─── Report ─────────────────────────────────────────────
let pass = 0, fail = 0;
for (const t of tests) {
  if (t.pass) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${t.name}`); }
  else        { fail++; console.log(`  \x1b[31m✗\x1b[0m ${t.name}  ${t.detail}`); }
}
console.log(`\n${pass}/${tests.length} passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
