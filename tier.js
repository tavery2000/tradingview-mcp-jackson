/**
 * tier.js — Account tier engine for HANK
 *
 * Position sizing scales with both signal quality (final confidence)
 * and account equity (tier). The two axes multiply: a Tier 1 account
 * trading a 1.50+ confidence signal gets 3 contracts; a Tier 4 account
 * on the same signal gets 10.
 *
 * Tier transitions:
 *   - UP: requires all 4 statistical qualifications met simultaneously,
 *         then waits for operator approval (no auto-promote).
 *   - DOWN: any single trigger fires immediately and drops 1 tier on
 *           the next signal evaluation.
 *
 * State lives in account-tier.json, loaded fresh on each call so the
 * dashboard's manual promotion or an automated demote is picked up by
 * the next signal without restart.
 *
 * Why: position sizing must change BEFORE strategy engines fire, not
 * after. If a TRENDING_BULL day stacks confidence to 2.30 with the
 * wrong contract count, that's the trade that blows the account.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname }                            from 'path';
import { fileURLToPath }                            from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const TIER_FILE  = join(__dirname, 'account-tier.json');

// ─── Tier table ──────────────────────────────────────────
// Indexed by tier number (1..4). Equity bounds are inclusive-low,
// exclusive-high. Tier 4 has no upper bound — past $250k, the contract
// caps stay at 10 because liquidity (not equity) becomes the constraint.

export const TIERS = {
  1: {
    name:           'Foundation',
    minEquity:      25_000,
    maxEquity:      50_000,
    contracts:      { low: 1, mid: 2, high: 3 },
    // Bumped 2026-05-12 from 2 → 3 per operator decision. Reason: SPY+IWM
    // were filling both slots during RTH, capping QQQ out of every cycle
    // and starving the per-instrument-quality dataset. T1 daily-loss cap
    // ($2,500) and per-instrument cap (2) still bound the risk envelope.
    maxConcurrent:  3,
    dailyLossCap:   2_500,
    perInstrumentCap: 2,
  },
  2: {
    name:           'Validation',
    minEquity:      50_000,
    maxEquity:      100_000,
    contracts:      { low: 2, mid: 3, high: 5 },
    maxConcurrent:  3,
    dailyLossCap:   5_000,
    perInstrumentCap: 2,
  },
  3: {
    name:           'Scale',
    minEquity:      100_000,
    maxEquity:      250_000,
    contracts:      { low: 3, mid: 5, high: 8 },
    maxConcurrent:  4,
    dailyLossCap:   10_000,
    perInstrumentCap: 2,
  },
  4: {
    name:           'Institutional',
    minEquity:      250_000,
    maxEquity:      Infinity,
    contracts:      { low: 4, mid: 7, high: 10 },
    maxConcurrent:  5,
    dailyLossCap:   15_000,
    perInstrumentCap: 2,
  },
};

// Tier-up qualifications. Equity is a precondition; the four stat
// qualifications must all be met for the tier-up alert to fire.
export const TIER_UP_REQS = {
  '1->2': { equity: 50_000,  minTrades: 100, minWinRate: 0.60, minProfitFactor: 1.4, maxDrawdownPct: 0.20 },
  '2->3': { equity: 100_000, minTrades: 250, minWinRate: 0.60, minProfitFactor: 1.5, maxDrawdownPct: 0.18 },
  '3->4': { equity: 250_000, minTrades: 500, minWinRate: 0.58, minProfitFactor: 1.5, maxDrawdownPct: 0.15 },
};

// Tier-down triggers. Any one fires.
export const TIER_DOWN_TRIGGERS = {
  drawdownPctFromHWM:        0.15,  // > 15%
  consecutiveLosses:         5,     // ≥ 5 in a row (excludes fade-experiment)
  rolling50WinRateMin:       0.50,  // < 50%
  dailyCapHitsIn5Sessions:   2,     // ≥ 2
  rolling100ProfitFactorMin: 1.2,   // < 1.2
};

// Confidence band → which contracts.{low,mid,high} bucket
export function confidenceBand(finalConfidence) {
  if (finalConfidence == null || finalConfidence < 0.65) return null; // below gate
  if (finalConfidence < 0.90) return 'low';
  if (finalConfidence < 1.50) return 'mid';
  return 'high';
}

// ─── Sizing — the function that gets called from paperTrading ──
export function getPositionSize(finalConfidence, tierNum) {
  const tier = TIERS[tierNum] ?? TIERS[1];
  const band = confidenceBand(finalConfidence);
  if (!band) return 0; // below 0.65 gate — no trade
  return tier.contracts[band];
}

// ─── State persistence ───────────────────────────────────
function defaultState() {
  return {
    tier:             1,
    tierName:         'Foundation',
    equity:           25_000,
    tierUpHWM:        25_000,        // high-water mark since last tier change
    lastChangeAt:     null,
    lastChangeReason: null,
    eligibleForUp:    null,          // {target, reason, since} when 4 quals met
    consecutiveLosses: 0,
    dailyCapHits:     [],            // dates (ET) when daily cap was hit, last 5
    history:          [],            // {ts, from, to, reason}
  };
}

export function loadTier() {
  try {
    if (!existsSync(TIER_FILE)) {
      const s = defaultState();
      writeFileSync(TIER_FILE, JSON.stringify(s, null, 2));
      return s;
    }
    const s = JSON.parse(readFileSync(TIER_FILE, 'utf8'));
    // Forward-compat for older state files
    if (typeof s.tier !== 'number') return defaultState();
    return { ...defaultState(), ...s };
  } catch {
    return defaultState();
  }
}

export function saveTier(state) {
  try {
    writeFileSync(TIER_FILE, JSON.stringify(state, null, 2));
    return true;
  } catch {
    return false;
  }
}

// ─── Helpers used elsewhere ─────────────────────────────
export function getDailyLossCap(tierNum)   { return (TIERS[tierNum] ?? TIERS[1]).dailyLossCap; }
export function getMaxConcurrent(tierNum)  { return (TIERS[tierNum] ?? TIERS[1]).maxConcurrent; }
export function getPerInstrumentCap(tierNum){ return (TIERS[tierNum] ?? TIERS[1]).perInstrumentCap; }
export function getTierName(tierNum)       { return (TIERS[tierNum] ?? TIERS[1]).name; }

// ─── Stat helpers (pure) used by eligibility/down checks ──
function rollingWindow(trades, n) {
  const closed = trades.filter(t => t.pnl != null);
  return closed.slice(Math.max(0, closed.length - n));
}

export function computeStats(trades) {
  const closed = trades.filter(t => t.pnl != null);
  const wins   = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl < 0);
  const sumW   = wins.reduce((s, t) => s + t.pnl, 0);
  const sumL   = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  return {
    closed:        closed.length,
    wins:          wins.length,
    losses:        losses.length,
    winRate:       closed.length ? wins.length / closed.length : 0,
    profitFactor:  sumL > 0 ? sumW / sumL : (sumW > 0 ? Infinity : 0),
    sumWin:        sumW,
    sumLoss:       sumL,
  };
}

// ─── Tier-up eligibility check ──────────────────────────
// Returns { eligible:bool, target:tier, checks:{...} }
// `checks` always includes every requirement with met:bool so the
// dashboard can render a partial progress view (e.g., 3/4 met).
export function checkTierUpEligibility(state, ledger) {
  const cur = state.tier;
  if (cur >= 4) return { eligible: false, target: null, checks: null, reason: 'already at max tier' };

  const target = cur + 1;
  const reqs   = TIER_UP_REQS[`${cur}->${target}`];
  if (!reqs) return { eligible: false, target: null, checks: null, reason: 'no req block' };

  const trades = ledger?.trades ?? [];
  const r100   = rollingWindow(trades, 100);
  const stats100 = computeStats(r100);
  const allStats = computeStats(trades);

  // Drawdown over the period: from tier-up HWM to current equity
  const equity = ledger?.balance ?? state.equity;
  const hwm    = Math.max(state.tierUpHWM ?? 0, equity);
  const ddPct  = hwm > 0 ? Math.max(0, (hwm - equity) / hwm) : 0;

  const checks = {
    equity:         { req: reqs.equity,          val: equity,                  met: equity >= reqs.equity },
    minTrades:      { req: reqs.minTrades,       val: allStats.closed,         met: allStats.closed >= reqs.minTrades },
    minWinRate:     { req: reqs.minWinRate,      val: stats100.winRate,        met: stats100.winRate >= reqs.minWinRate },
    minProfitFactor:{ req: reqs.minProfitFactor, val: stats100.profitFactor,   met: stats100.profitFactor >= reqs.minProfitFactor },
    maxDrawdownPct: { req: reqs.maxDrawdownPct,  val: ddPct,                   met: ddPct <= reqs.maxDrawdownPct },
  };

  const statKeys = ['minTrades', 'minWinRate', 'minProfitFactor', 'maxDrawdownPct'];
  const statsAllMet = statKeys.every(k => checks[k].met);
  const eligible    = checks.equity.met && statsAllMet;

  return { eligible, target, checks, statsMetCount: statKeys.filter(k => checks[k].met).length, statKeys };
}

// ─── Tier-down trigger evaluation ───────────────────────
// Returns { triggered:bool, reason:string|null }
export function checkTierDown(state, ledger) {
  if (state.tier <= 1) return { triggered: false, reason: null };
  const trades = ledger?.trades ?? [];

  // 1. Drawdown > 15% from HWM
  const equity = ledger?.balance ?? state.equity;
  const hwm    = state.tierUpHWM ?? equity;
  if (hwm > 0) {
    const ddPct = Math.max(0, (hwm - equity) / hwm);
    if (ddPct > TIER_DOWN_TRIGGERS.drawdownPctFromHWM) {
      return { triggered: true, reason: `drawdown ${(ddPct*100).toFixed(1)}% from HWM $${hwm.toFixed(0)}` };
    }
  }

  // 2. 5 consecutive losses (excludes FADE_EXPERIMENT_PRE10 trades)
  if ((state.consecutiveLosses ?? 0) >= TIER_DOWN_TRIGGERS.consecutiveLosses) {
    return { triggered: true, reason: `${state.consecutiveLosses} consecutive losses` };
  }

  // 3. Rolling 50-trade win rate < 50%
  const r50 = rollingWindow(trades, 50);
  if (r50.length >= 50) {
    const stats50 = computeStats(r50);
    if (stats50.winRate < TIER_DOWN_TRIGGERS.rolling50WinRateMin) {
      return { triggered: true, reason: `50-trade WR ${(stats50.winRate*100).toFixed(0)}% < 50%` };
    }
  }

  // 4. Daily cap hit ≥ 2 times in last 5 sessions
  const recentCapHits = (state.dailyCapHits ?? []).slice(-5);
  if (recentCapHits.length >= TIER_DOWN_TRIGGERS.dailyCapHitsIn5Sessions) {
    return { triggered: true, reason: `${recentCapHits.length} daily-cap hits in last 5 sessions` };
  }

  // 5. Rolling 100-trade profit factor < 1.2
  const r100 = rollingWindow(trades, 100);
  if (r100.length >= 100) {
    const stats100 = computeStats(r100);
    if (stats100.profitFactor < TIER_DOWN_TRIGGERS.rolling100ProfitFactorMin) {
      return { triggered: true, reason: `100-trade PF ${stats100.profitFactor.toFixed(2)} < 1.20` };
    }
  }

  return { triggered: false, reason: null };
}

// ─── Tier transitions (called by paperTrading after trade close) ─
export function applyTierDown(state, reason) {
  if (state.tier <= 1) return state;
  const from = state.tier;
  state.tier              = state.tier - 1;
  state.tierName          = TIERS[state.tier].name;
  state.lastChangeAt      = new Date().toISOString();
  state.lastChangeReason  = `DOWN: ${reason}`;
  state.eligibleForUp     = null;
  state.consecutiveLosses = 0;
  state.tierUpHWM         = state.equity ?? TIERS[state.tier].minEquity;
  state.history.push({ ts: state.lastChangeAt, from, to: state.tier, reason: state.lastChangeReason });
  return state;
}

export function applyTierUp(state, equity) {
  if (state.tier >= 4) return state;
  const from = state.tier;
  state.tier             = state.tier + 1;
  state.tierName         = TIERS[state.tier].name;
  state.lastChangeAt     = new Date().toISOString();
  state.lastChangeReason = `UP: operator-approved at $${(equity ?? 0).toFixed(0)}`;
  state.eligibleForUp    = null;
  state.tierUpHWM        = equity ?? state.tierUpHWM;
  state.history.push({ ts: state.lastChangeAt, from, to: state.tier, reason: state.lastChangeReason });
  return state;
}

// ─── Equity & HWM updater ───────────────────────────────
export function updateEquity(state, equity) {
  state.equity    = equity;
  state.tierUpHWM = Math.max(state.tierUpHWM ?? 0, equity);
  return state;
}

// ─── Standalone test mode ────────────────────────────────
if (process.argv.includes('--test')) {
  console.log('\n  ⬡ HANK tier.js test\n');
  const cases = [
    [0.50, 1], [0.65, 1], [0.85, 1], [0.90, 1], [1.49, 1], [1.50, 1], [2.30, 1],
    [0.85, 2], [1.20, 2], [1.80, 2],
    [0.85, 3], [1.20, 3], [1.80, 3],
    [0.85, 4], [1.20, 4], [1.80, 4],
  ];
  for (const [conf, t] of cases) {
    const sz = getPositionSize(conf, t);
    console.log(`  conf ${conf.toFixed(2)} × T${t}: ${sz} contract${sz !== 1 ? 's' : ''}`);
  }
  console.log('\n  Caps:');
  for (let t = 1; t <= 4; t++) {
    console.log(`    T${t} ${getTierName(t).padEnd(14)} dailyLoss=$${getDailyLossCap(t)}  concur=${getMaxConcurrent(t)}  perInst=${getPerInstrumentCap(t)}`);
  }
}
