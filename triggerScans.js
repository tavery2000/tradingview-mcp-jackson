/**
 * triggerScans.js — Single-line wire-up for the FVG and sweep scanners.
 *
 * Called once per instrument per poll. Pulls 5M bars from the bar cache,
 * runs both detection passes, persists state to fvg-state-{INSTR}.json
 * and sweep-state-{INSTR}.json, and logs any new gap or sweep through the
 * journal so it surfaces in the dashboard. Returns the scanner outputs so
 * downstream gates / strategies can read them.
 */

import { scanAndUpdate as scanFVG, fvgEntryEngine, markFVGFired } from './fvg.js';
import { scanClosedBar as scanSweep, sweepEntryEngine, markSweepFired,
         getRecentSweeps } from './sweep.js';
import { atr } from './analyze.js';
import { jAlert, jError }             from './journal.js';

export async function scanTriggers(instrument, barCache, levels) {
  if (!barCache) return { ok: false, reason: 'no-cache', fvg: null, sweep: null };
  try {
    const bars5M = await barCache.get('5');
    if (!bars5M || bars5M.length < 5) {
      return { ok: false, reason: 'thin-bars', fvg: null, sweep: null };
    }

    const fvgRes   = scanFVG(instrument, bars5M);
    const sweepRes = levels ? scanSweep(instrument, bars5M, levels)
                            : { sweep: null, blocked: false, state: null };

    if (fvgRes?.newGap) {
      jAlert('info', `${instrument} new ${fvgRes.newGap.type} FVG`, {
        instrument, type: fvgRes.newGap.type,
        top: fvgRes.newGap.top, bottom: fvgRes.newGap.bottom,
        sizeAtr: fvgRes.newGap.sizeAtr,
      });
    }
    if (sweepRes?.sweep) {
      jAlert('info', `${instrument} ${sweepRes.sweep.regime}-regime ${sweepRes.sweep.type} sweep`, {
        instrument, level: sweepRes.sweep.level.label, price: sweepRes.sweep.level.price,
        signal: sweepRes.sweep.signal, wickPenetration: sweepRes.sweep.wickPenetration,
      });
    }
    return { ok: true, fvg: fvgRes, sweep: sweepRes, bars5M };
  } catch (e) {
    jError('trigger-scan', e.message, { instrument });
    return { ok: false, reason: e.message, fvg: null, sweep: null };
  }
}

// Run the FVG and sweep entry engines against the scanner outputs and
// auto-mark the corresponding state entries as fired. Caller dispatches
// the returned signals through the same scalp pathway as TREND/STRUCTURE.
//
// Returns { fvgSig, sweepSig } — either may be null.
export function runEntryEngines(instrument, triggers) {
  if (!triggers?.ok) return { fvgSig: null, sweepSig: null };
  const bars5M = triggers.bars5M;

  const fvgSig = fvgEntryEngine({
    activeFVGs: triggers.fvg?.active,
    bars:       bars5M,
  });
  if (fvgSig?.gapId) {
    markFVGFired(instrument, fvgSig.gapId);
    jAlert('signal', `${instrument} ${fvgSig.event} ${fvgSig.action} ${fvgSig.confidence}`, {
      instrument, event: fvgSig.event, gapId: fvgSig.gapId, reason: fvgSig.reason,
    });
  }

  const recentSweeps = triggers.sweep?.state ? getRecentSweeps(triggers.sweep.state) : [];
  const atr5M = bars5M ? atr(bars5M, 14) : null;
  const sweepSig = sweepEntryEngine({
    recentSweeps,
    bars:  bars5M,
    atr5M,
  });
  if (sweepSig?.sweepId) {
    markSweepFired(instrument, sweepSig.sweepId);
    jAlert('signal', `${instrument} ${sweepSig.event} ${sweepSig.action} ${sweepSig.confidence}`, {
      instrument, event: sweepSig.event, sweepId: sweepSig.sweepId, reason: sweepSig.reason,
    });
  }

  return { fvgSig, sweepSig };
}
