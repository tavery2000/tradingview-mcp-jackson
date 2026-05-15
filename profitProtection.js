/**
 * profitProtection.js — multi-tier profit-protection gate.
 *
 * 2026-05-15 Task 3 redesign. Replaces the single-trail $5K/$1.5K design that
 * the operator's day-2-loss-analysis showed would have killed the +$22K
 * afternoon recovery on 2026-05-15.
 *
 * Tiers (escalate as peak combined daily P&L climbs):
 *   LIGHT   @ +$5K   trail $5K   pause 30min on trail breach
 *   MEDIUM  @ +$10K  trail $3.5K pause 60min on trail breach
 *   HARD    @ +$15K  trail $2K   day-end lock on trail breach (no resume)
 *
 * Single export: evaluate({ dailyPnL, today, etTime }) → { blocked, reason, tier }
 *
 * Caller passes the COMBINED options + futures daily P&L. State persists to
 * profit-protection-state.json (gitignored runtime state). Resets per ET-date.
 *
 * Side effects on tier transition / pause / lock:
 *   - jAlert (journal)
 *   - global.wsBroadcast (dashboard banner)
 *   - pushVoiceAlert (TTS)
 *   - console banner
 *   - state file write
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { jAlert } from './journal.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, 'profit-protection-state.json');

const ENABLED          = (process.env.PROFIT_PROTECTION_ENABLED || 'false').toLowerCase() === 'true';
const PP_LIGHT_TRIGGER  = parseFloat(process.env.PP_LIGHT_TRIGGER  || '5000');
const PP_LIGHT_TRAIL    = parseFloat(process.env.PP_LIGHT_TRAIL    || '5000');
const PP_LIGHT_PAUSE_MS = parseFloat(process.env.PP_LIGHT_PAUSE_MIN || '30') * 60_000;
const PP_MEDIUM_TRIGGER = parseFloat(process.env.PP_MEDIUM_TRIGGER || '10000');
const PP_MEDIUM_TRAIL   = parseFloat(process.env.PP_MEDIUM_TRAIL   || '3500');
const PP_MEDIUM_PAUSE_MS = parseFloat(process.env.PP_MEDIUM_PAUSE_MIN || '60') * 60_000;
const PP_HARD_TRIGGER   = parseFloat(process.env.PP_HARD_TRIGGER   || '15000');
const PP_HARD_TRAIL     = parseFloat(process.env.PP_HARD_TRAIL     || '2000');

const PAPER_LEDGER   = join(__dirname, 'paper-ledger.json');
const FUTURES_LEDGER = join(__dirname, 'futures-ledger.json');

function _emptyState(today) {
  return {
    date: today,
    peakDailyPnL: 0,
    currentTier: 'NONE',
    pauseUntil: null,
    hardLocked: false,
    tierLog: [],
  };
}

function _loadState(today) {
  try {
    if (!existsSync(STATE_FILE)) return _emptyState(today);
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (s.date !== today) return _emptyState(today);
    return s;
  } catch {
    return _emptyState(today);
  }
}

function _saveState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

export function getCombinedDailyPnL(today) {
  let combined = 0;
  try {
    const p = JSON.parse(readFileSync(PAPER_LEDGER, 'utf8'));
    combined += p.dailyPnL?.[today] || 0;
  } catch {}
  try {
    const f = JSON.parse(readFileSync(FUTURES_LEDGER, 'utf8'));
    combined += f.dailyPnL?.[today] || 0;
  } catch {}
  return combined;
}

function _tierFromPeak(peak) {
  if (peak >= PP_HARD_TRIGGER)   return 'HARD';
  if (peak >= PP_MEDIUM_TRIGGER) return 'MEDIUM';
  if (peak >= PP_LIGHT_TRIGGER)  return 'LIGHT';
  return 'NONE';
}

function _trailForTier(tier) {
  switch (tier) {
    case 'HARD':   return PP_HARD_TRAIL;
    case 'MEDIUM': return PP_MEDIUM_TRAIL;
    case 'LIGHT':  return PP_LIGHT_TRAIL;
    default:       return null;
  }
}

function _pauseMsForTier(tier) {
  switch (tier) {
    case 'MEDIUM': return PP_MEDIUM_PAUSE_MS;
    case 'LIGHT':  return PP_LIGHT_PAUSE_MS;
    default:       return null;
  }
}

function _notify(kind, payload) {
  try { jAlert(kind === 'PROFIT_PROTECTION_HARD_LOCK' ? 'critical' : 'warning', kind, payload); } catch {}
  if (typeof global.wsBroadcast === 'function') {
    try { global.wsBroadcast({ type: 'warning', payload: { kind, ...payload } }); } catch {}
  }
  try {
    if (typeof global.pushVoiceAlert === 'function') {
      const msg = kind === 'PROFIT_PROTECTION_HARD_LOCK'
        ? `Profit protection HARD LOCK. Day ends. Locked at ${Math.round(payload.dailyPnL).toLocaleString()} dollars.`
        : kind === 'PROFIT_PROTECTION_PAUSE'
        ? `Profit protection ${payload.tier} pause. Resume in ${Math.round((payload.pauseUntil - Date.now()) / 60_000)} minutes.`
        : `Profit protection ${payload.tier} active. Trailing ${_trailForTier(payload.tier)} dollars from peak.`;
      global.pushVoiceAlert(`pp-${kind}`, 'critical', msg, 300_000);
    }
  } catch {}
}

/**
 * Evaluate whether a new entry should be blocked by profit protection.
 *
 * Caller invokes once per entry-decision; the function maintains internal state
 * across calls and persists to disk.
 *
 * @param {Object} opts
 * @param {string} opts.today  — ET date string (YYYY-MM-DD)
 * @param {number} [opts.dailyPnL] — optional combined dailyPnL; computed from
 *                                   ledgers if omitted
 * @returns {{blocked: boolean, reason?: string, tier: string, dailyPnL: number,
 *           peakDailyPnL: number}}
 */
export function evaluate({ today, dailyPnL = null } = {}) {
  if (!ENABLED) {
    return { blocked: false, tier: 'NONE', dailyPnL: 0, peakDailyPnL: 0 };
  }
  if (!today) {
    return { blocked: false, tier: 'NONE', dailyPnL: 0, peakDailyPnL: 0 };
  }
  if (dailyPnL == null) dailyPnL = getCombinedDailyPnL(today);

  const s = _loadState(today);
  const now = Date.now();

  // Hard lock — terminal for the day
  if (s.hardLocked) {
    return {
      blocked: true,
      reason: `PROFIT_PROTECTION_HARD_LOCK (peak $${s.peakDailyPnL.toFixed(0)}, locked at trail breach)`,
      tier: 'HARD',
      dailyPnL,
      peakDailyPnL: s.peakDailyPnL,
    };
  }

  // Pause-active check
  if (s.pauseUntil && now < s.pauseUntil) {
    const minsLeft = Math.ceil((s.pauseUntil - now) / 60_000);
    return {
      blocked: true,
      reason: `PROFIT_PROTECTION_PAUSED (${s.currentTier}, resume in ${minsLeft}min)`,
      tier: s.currentTier,
      dailyPnL,
      peakDailyPnL: s.peakDailyPnL,
    };
  }
  if (s.pauseUntil && now >= s.pauseUntil) {
    s.pauseUntil = null;   // expired — resume
  }

  // Update peak
  if (dailyPnL > s.peakDailyPnL) s.peakDailyPnL = dailyPnL;

  // Determine current tier from peak
  const newTier = _tierFromPeak(s.peakDailyPnL);
  const tierEscalated = newTier !== s.currentTier && _tierRank(newTier) > _tierRank(s.currentTier);
  if (tierEscalated) {
    s.currentTier = newTier;
    s.tierLog.push({ tier: newTier, ts: now, dailyPnL, peakDailyPnL: s.peakDailyPnL });
    _notify('PROFIT_PROTECTION_TIER_ACTIVATED', { tier: newTier, dailyPnL, peakDailyPnL: s.peakDailyPnL });
  }

  // Trail-breach check at the active tier
  const trail = _trailForTier(s.currentTier);
  if (trail != null && (s.peakDailyPnL - dailyPnL) >= trail) {
    if (s.currentTier === 'HARD') {
      s.hardLocked = true;
      _saveState(s);
      _notify('PROFIT_PROTECTION_HARD_LOCK', { tier: 'HARD', dailyPnL, peakDailyPnL: s.peakDailyPnL, trail });
      return {
        blocked: true,
        reason: `PROFIT_PROTECTION_HARD_LOCK (peak $${s.peakDailyPnL.toFixed(0)}, gave back $${trail}, day ends)`,
        tier: 'HARD',
        dailyPnL,
        peakDailyPnL: s.peakDailyPnL,
      };
    }
    // LIGHT or MEDIUM → pause
    const pauseMs = _pauseMsForTier(s.currentTier);
    s.pauseUntil = now + pauseMs;
    _saveState(s);
    _notify('PROFIT_PROTECTION_PAUSE', { tier: s.currentTier, dailyPnL, peakDailyPnL: s.peakDailyPnL, trail, pauseUntil: s.pauseUntil });
    return {
      blocked: true,
      reason: `PROFIT_PROTECTION_${s.currentTier}_PAUSE (peak $${s.peakDailyPnL.toFixed(0)}, gave back $${trail}, resume in ${Math.round(pauseMs/60_000)}min)`,
      tier: s.currentTier,
      dailyPnL,
      peakDailyPnL: s.peakDailyPnL,
    };
  }

  _saveState(s);
  return { blocked: false, tier: s.currentTier, dailyPnL, peakDailyPnL: s.peakDailyPnL };
}

function _tierRank(t) {
  switch (t) {
    case 'HARD':   return 3;
    case 'MEDIUM': return 2;
    case 'LIGHT':  return 1;
    default:       return 0;
  }
}

export const profitProtectionConfig = {
  ENABLED,
  PP_LIGHT_TRIGGER, PP_LIGHT_TRAIL, PP_LIGHT_PAUSE_MS,
  PP_MEDIUM_TRIGGER, PP_MEDIUM_TRAIL, PP_MEDIUM_PAUSE_MS,
  PP_HARD_TRIGGER, PP_HARD_TRAIL,
};
