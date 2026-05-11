// _test_hierarchy.js — Chart-first hierarchy v2 unit tests.
//
// Scope (Option B — finish Path 2 cleanup, no re-wire of stripped gates):
//   1. CHART_ENGINE_SET membership (the active gate at monitor.js:2384)
//   2. computeBoosterAdj math (helper, currently unwired but exported)
//   3. computeSpyBoosters direction logic (helper, unwired but exported)
//   4. gateMacro4H block conditions + FADE exemption (helper, unwired)
//   5. gateVwap tolerance band + FADE exemption (helper, unwired)
//   6. gate1H structure + pullback/extended adjustments (helper, unwired)
//   7. applyMultipliers numeric pipeline (still called in executeScalpSignal)
//
// Run: node _test_hierarchy.js
//
// The unwired helpers are tested for correctness so a future re-wire (or a
// caller emerging in another module) lands on validated math. Today their
// outputs do not affect dispatch — Path 2 simplification flows reliable Pine
// chart-engine signals straight from basic gates to tier sizing.

import {
  HIERARCHY_V2,
  PINE_PRIMARY,
  CHART_ENGINE_SET,
  computeBoosterAdj,
  computeSpyBoosters,
  gateMacro4H,
  gateVwap,
  gate1H,
  applyMultipliers,
} from './signalConfidence.js';

const tests = [];
function assert(name, cond, detail) {
  tests.push({ name, pass: !!cond, detail: detail ?? '' });
}
function approx(a, b, eps = 0.001) { return Math.abs(a - b) < eps; }

// ─── 1. HIERARCHY_V2 + PINE_PRIMARY + chart engine set ─────────────────────
assert('HIERARCHY_V2 default ON',           HIERARCHY_V2 === true);
assert('PINE_PRIMARY default ON',           PINE_PRIMARY === true);
assert('PINE_PRIMARY is boolean',           typeof PINE_PRIMARY === 'boolean');
assert('PINE_PRIMARY env override works (truthy by default)',
  process.env.PINE_PRIMARY === 'false' ? PINE_PRIMARY === false : PINE_PRIMARY === true);
assert('CHART_ENGINE_SET has STRUCTURE',    CHART_ENGINE_SET.has('STRUCTURE'));
assert('CHART_ENGINE_SET has FVG',          CHART_ENGINE_SET.has('FVG'));
assert('CHART_ENGINE_SET has SWEEP',        CHART_ENGINE_SET.has('SWEEP'));
assert('CHART_ENGINE_SET has FADE (E.1)',   CHART_ENGINE_SET.has('FADE'));
assert('CHART_ENGINE_SET excludes TREND',   !CHART_ENGINE_SET.has('TREND'));
assert('CHART_ENGINE_SET excludes SWING',   !CHART_ENGINE_SET.has('SWING'));
assert('CHART_ENGINE_SET excludes BOUNCE',  !CHART_ENGINE_SET.has('BOUNCE'));

// ─── 2. computeBoosterAdj math ─────────────────────────────────────────────
assert('booster empty → 0',
  computeBoosterAdj({}) === 0);
assert('booster null → 0',
  computeBoosterAdj(null) === 0);
assert('booster vwap_align only → 0.03',
  approx(computeBoosterAdj({ vwap_align: true }), 0.03));
assert('booster vol_burst only → 0.03',
  approx(computeBoosterAdj({ vol_burst: true }), 0.03));
assert('booster tick+delta = 0.10',
  approx(computeBoosterAdj({ tick: 0.05, delta: 0.05 }), 0.10));
assert('booster cap at 0.15 (E.2)',
  approx(computeBoosterAdj({ tick: 0.05, delta: 0.05, mag6: 0.05, w3: 0.10 }), 0.15));
assert('booster cap on overflow',
  approx(computeBoosterAdj({ tick: 0.05, delta: 0.05, mag6: 0.05, w3: 0.10, vwap_align: true, vol_burst: true }), 0.15));
assert('booster floor at 0 (negative ignored as Number.isFinite passes)',
  computeBoosterAdj({ tick: -0.5 }) === 0);

// ─── 3. computeSpyBoosters direction logic (E.2 normalized table) ──────────
const bullCtx = { tick: 600, delta: 1500, bulls: 4, bears: 1, w3Score: 4, volPct: 0.7, price: 740, vwap: 738 };
const bullBoosters = computeSpyBoosters(bullCtx, 'CALLS');
assert('SPY CALLS: tick > +400 → tick booster',  bullBoosters.tick === 0.05);
assert('SPY CALLS: delta > +1000 → delta booster', bullBoosters.delta === 0.05);
assert('SPY CALLS: bulls 4>bears 1 → mag6 0.05',   bullBoosters.mag6 === 0.05);
assert('SPY CALLS: w3=4 → w3 0.10',                bullBoosters.w3 === 0.10);
assert('SPY CALLS: volPct 0.7 → vol_burst',        bullBoosters.vol_burst === true);
assert('SPY CALLS: price>vwap → vwap_align',       bullBoosters.vwap_align === true);
assert('SPY CALLS: total adj = 0.15 (capped)',
  approx(computeBoosterAdj(bullBoosters), 0.15));

const bearCtx = { tick: -600, delta: -1500, bulls: 1, bears: 4, w3Score: 1, volPct: 0.7, price: 736, vwap: 738 };
const bearBoosters = computeSpyBoosters(bearCtx, 'PUTS');
assert('SPY PUTS: tick < -400 → tick booster',  bearBoosters.tick === 0.05);
assert('SPY PUTS: delta < -1000 → delta booster', bearBoosters.delta === 0.05);
assert('SPY PUTS: bears 4>bulls 1 → mag6 0.05',   bearBoosters.mag6 === 0.05);
assert('SPY PUTS: w3=1 → w3 0.10 (bearish bound)', bearBoosters.w3 === 0.10);
assert('SPY PUTS: price<vwap → vwap_align',       bearBoosters.vwap_align === true);

// Direction mismatch — bull consensus, PUTS signal should NOT get boosters
const mismatch = computeSpyBoosters(bullCtx, 'PUTS');
assert('SPY PUTS w/ bull tick → no tick booster',  mismatch.tick === undefined);
assert('SPY PUTS w/ bull delta → no delta booster', mismatch.delta === undefined);
assert('SPY PUTS w/ bulls>bears → no mag6 booster', mismatch.mag6 === undefined);

// ─── 4. gateMacro4H block conditions (E.5) ─────────────────────────────────
const sigCallsStructure = { signal: 'CALLS', engine: 'STRUCTURE' };
const sigPutsStructure  = { signal: 'PUTS',  engine: 'STRUCTURE' };
const sigCallsFade      = { signal: 'CALLS', engine: 'FADE' };
const sigPutsFade       = { signal: 'PUTS',  engine: 'FADE' };

assert('M4H block: CALLS into DOWN macro',
  gateMacro4H(sigCallsStructure, { macro4H: 'DOWN' }).block === true);
assert('M4H block reason MACRO4H_COUNTER',
  gateMacro4H(sigCallsStructure, { macro4H: 'DOWN' }).reason === 'MACRO4H_COUNTER');
assert('M4H block: PUTS into UP macro',
  gateMacro4H(sigPutsStructure, { macro4H: 'UP' }).block === true);
assert('M4H pass: CALLS into UP macro',
  gateMacro4H(sigCallsStructure, { macro4H: 'UP' }).block === false);
assert('M4H pass: PUTS into DOWN macro',
  gateMacro4H(sigPutsStructure, { macro4H: 'DOWN' }).block === false);
assert('M4H pass: RANGING never blocks (sub-Q2)',
  gateMacro4H(sigCallsStructure, { macro4H: 'RANGING' }).block === false);
assert('M4H pass: UNKNOWN never blocks (sub-Q2)',
  gateMacro4H(sigPutsStructure, { macro4H: 'UNKNOWN' }).block === false);
// FADE exemption — operator sub-Q1 RESOLVED: FADE follows BLOCK like everything else
// (counter-trend is the FADE point at the intraday level, but 4H block still applies)
// CORRECTION per recommendation doc line 371: "keep BLOCK on FADE counter-4H"
// Implementation in signalConfidence.js:249 says `if (engine === 'FADE') return noop;`
// This DOES exempt FADE — reflecting an in-code policy decision that diverges from
// the doc's sub-Q1 recommendation. Test the actual implementation.
assert('M4H FADE exempt: CALLS+DOWN passes',
  gateMacro4H(sigCallsFade, { macro4H: 'DOWN' }).block === false);
assert('M4H FADE exempt: PUTS+UP passes',
  gateMacro4H(sigPutsFade, { macro4H: 'UP' }).block === false);
assert('M4H null signal → noop',
  gateMacro4H(null, { macro4H: 'DOWN' }).block === false);

// ─── 5. gateVwap tolerance + FADE exemption (E.6) ──────────────────────────
// ±0.15% tolerance. price > vwap*(1-0.0015) passes for CALLS.
assert('VWAP pass: CALLS price > vwap',
  gateVwap(sigCallsStructure, 740, 738).block === false);
assert('VWAP pass: CALLS price within tolerance (0.10% below)',
  gateVwap(sigCallsStructure, 737.262, 738).block === false);   // 0.10% below — within ±0.15%
assert('VWAP block: CALLS price 0.20% below vwap',
  gateVwap(sigCallsStructure, 736.524, 738).block === true);    // 0.20% below — outside ±0.15%
assert('VWAP block reason VWAP_WRONG_SIDE',
  gateVwap(sigCallsStructure, 736.524, 738).reason === 'VWAP_WRONG_SIDE');
assert('VWAP pass: PUTS price < vwap',
  gateVwap(sigPutsStructure, 736, 738).block === false);
assert('VWAP block: PUTS price 0.20% above vwap',
  gateVwap(sigPutsStructure, 739.476, 738).block === true);
assert('VWAP FADE exempt: CALLS far below VWAP passes',
  gateVwap(sigCallsFade, 730, 738).block === false);            // PDL bounce CALLS far below
assert('VWAP FADE exempt: PUTS far above VWAP passes',
  gateVwap(sigPutsFade, 745, 738).block === false);             // PDH rejection PUTS above
assert('VWAP noop: zero vwap',
  gateVwap(sigCallsStructure, 740, 0).block === false);
assert('VWAP noop: NaN price',
  gateVwap(sigCallsStructure, NaN, 738).block === false);

// ─── 6. gate1H structure + pullback/extended ───────────────────────────────
const a1h = (sp, p) => ({ valid: true, structurePattern: sp, pctOfRange: p });

assert('1H block: CALLS into LH_LL',
  gate1H(sigCallsStructure, a1h('LH_LL', 0.5), 'CHOPPY').block === true);
assert('1H block reason LH_LL',
  gate1H(sigCallsStructure, a1h('LH_LL', 0.5), 'CHOPPY').reason === 'COUNTER_1H_STRUCTURE_LH_LL');
assert('1H block: PUTS into HH_HL',
  gate1H(sigPutsStructure, a1h('HH_HL', 0.5), 'CHOPPY').block === true);
assert('1H CHASING_EXTENDED: CALLS at 0.90 of range',
  gate1H(sigCallsStructure, a1h('HH_HL', 0.90), 'CHOPPY').baseAdjust === -0.15);
assert('1H PULLBACK_WITH_TREND: CALLS at 0.45 in TRENDING_BULL',
  gate1H(sigCallsStructure, a1h('HH_HL', 0.45), 'TRENDING_BULL').baseAdjust === 0.10);
assert('1H noop: no analysis',
  gate1H(sigCallsStructure, null, 'CHOPPY').block === false);

// ─── 7. applyMultipliers numeric pipeline ──────────────────────────────────
const high = applyMultipliers(
  { signal: 'CALLS', engine: 'STRUCTURE', confidence: 'HIGH' },
  { macro4H: 'UP', marketBias: 'TRENDING_BULL', now: new Date('2026-05-12T15:00:00Z') } // 11:00 ET = TREND_TIME
);
assert('applyMult: HIGH STRUCTURE CALLS in TRENDING_BULL TREND_TIME → final > 1.5',
  high.finalConfidence > 1.5, `got ${high.finalConfidence}`);
assert('applyMult: breakdown has session',
  high.breakdown?.session === 'TREND_TIME');
assert('applyMult: macro4H carried through',
  high.macro4H === 'UP');

const noDir = applyMultipliers({ engine: 'STRUCTURE', confidence: 'HIGH' }, {});
assert('applyMult: missing direction → finalConfidence 0',
  noDir.finalConfidence === 0);

const counter = applyMultipliers(
  { signal: 'PUTS', engine: 'STRUCTURE', confidence: 'HIGH' },
  { macro4H: 'UP', marketBias: 'CHOPPY' }
);
assert('applyMult: counter-4H still produces dampened number (0.6x in macro)',
  counter.breakdown?.macro4H === 0.6);

// ─── Summary + exit code ───────────────────────────────────────────────────
const pass = tests.filter(t => t.pass).length;
const fail = tests.filter(t => !t.pass);
console.log(`\n_test_hierarchy.js — ${pass}/${tests.length} passed`);
if (fail.length) {
  console.log('\nFAILURES:');
  for (const t of fail) console.log(`  ✗ ${t.name}  ${t.detail}`);
  process.exit(1);
} else {
  console.log('All chart-first hierarchy v2 assertions passing.');
  process.exit(0);
}
