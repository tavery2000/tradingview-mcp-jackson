/**
 * weeklyLoss.js — rolling-7d realized P&L tiered gate
 *
 * 2026-05-17 STUB. Per operator directive, this is wired into the gate
 * chain on Sun 5/17 but full enforcement lands Tue 5/19. Today's stub:
 *   - evaluate() returns { blocked: false } unconditionally
 *   - logs WEEKLY_LOSS_STUB jAlert so we can verify the gate is being
 *     called from sendOrder (vs. silently bypassed)
 *
 * Tue 5/19 plan:
 *   - Read realized P&L from rolling 7d window across both paper-ledger
 *     and MCP get_account_balance history
 *   - Persist last computed value to weekly-loss-state.json
 *   - Three tiers per operator spec:
 *       -$500 (MAX_WEEKLY_LOSS_WARN)  → warning + TTS
 *       -$750 (MAX_WEEKLY_LOSS_BLOCK) → reject new entries
 *       -$1000 (MAX_WEEKLY_LOSS)      → hard halt + auto-flatten
 *   - Hook into the global rollback flag WEBULL_INTEGRATION_HALT on
 *     the hard-halt tier
 *
 * For now: import succeeds, evaluate() never blocks.
 */

import { jAlert } from './journal.js';

const STUB_MODE = true;   // flip to false in Tue 5/19 full impl
let _stubLoggedFor = null;

export const weeklyLossConfig = {
  STUB_MODE,
  MAX_WEEKLY_LOSS_WARN:  parseFloat(process.env.MAX_WEEKLY_LOSS_WARN  || '500'),
  MAX_WEEKLY_LOSS_BLOCK: parseFloat(process.env.MAX_WEEKLY_LOSS_BLOCK || '750'),
  MAX_WEEKLY_LOSS:       parseFloat(process.env.MAX_WEEKLY_LOSS       || '1000'),
};

export function evaluate({ today } = {}) {
  if (STUB_MODE) {
    // Log once per ET-date that the stub was reached — proves gate wiring
    if (_stubLoggedFor !== today) {
      _stubLoggedFor = today;
      try { jAlert('info', 'WEEKLY_LOSS_STUB', {
        message: 'weeklyLoss stub reached; full impl Tue 5/19',
        config: weeklyLossConfig,
        date: today,
      }); } catch {}
    }
    return { blocked: false, tier: 'STUB', weeklyPnL: 0 };
  }
  // Tue 5/19 full implementation lands here.
  return { blocked: false, tier: 'NONE', weeklyPnL: 0 };
}
