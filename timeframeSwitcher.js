/**
 * timeframeSwitcher.js — auto-switch chart timeframe at fixed ET boundaries
 *
 * P2-13 (2026-05-14 EOD): operator directive — at 09:30 ET switch all
 * monitor charts to AM_RESOLUTION (default '1'), at 12:00 ET switch to
 * PM_RESOLUTION (default '5'). Reduces signal noise post-noon when the
 * tape typically chops; 1m provides scouting precision in the morning.
 *
 * Idempotent — tracks last-switched ET-date per transition so multiple
 * polling cycles don't re-issue setResolution. Switch fires once per day
 * per transition.
 *
 * Usage from monitor.js / monitor-qqq.js / monitor-iwm.js polling loop:
 *   import { maybeSwitchTimeframe } from './timeframeSwitcher.js';
 *   await maybeSwitchTimeframe(client, { name: 'monitor.js' });
 *
 * client = chrome-remote-interface CDP client
 *
 * Env config:
 *   AUTO_TIMEFRAME_SWITCH       (default true)
 *   AM_RESOLUTION               (default '1')
 *   PM_RESOLUTION               (default '5')
 *   TIMEFRAME_SWITCH_HOUR_ET    (default 12)
 */

const _switchedToday = new Map();   // key: `${name}|${transition}`, value: 'YYYY-MM-DD'

function getETDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}
function getETMins() {
  const t = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export async function maybeSwitchTimeframe(client, opts = {}) {
  const enabled = (process.env.AUTO_TIMEFRAME_SWITCH || 'true').toLowerCase() === 'true';
  if (!enabled) return null;
  if (!client) return null;

  const am = process.env.AM_RESOLUTION || '1';
  const pm = process.env.PM_RESOLUTION || '5';
  const switchHour = parseInt(process.env.TIMEFRAME_SWITCH_HOUR_ET || '12', 10);
  const name = opts.name || 'unknown';
  const today = getETDate();
  const mins = getETMins();

  // 09:30 ET → AM_RESOLUTION
  if (mins >= 9 * 60 + 30 && mins < switchHour * 60) {
    const key = `${name}|am`;
    if (_switchedToday.get(key) !== today) {
      _switchedToday.set(key, today);
      try {
        await _setRes(client, am);
        console.log(`  [TF-SWITCH] ${name}: AM resolution → ${am} at ${mins} mins ET`);
        return { transition: 'am', resolution: am };
      } catch (e) {
        console.log(`  [TF-SWITCH] ${name}: AM switch FAILED — ${e.message}`);
        _switchedToday.delete(key);   // retry on next poll
      }
    }
  }

  // 12:00 ET → PM_RESOLUTION
  if (mins >= switchHour * 60 && mins < 16 * 60) {
    const key = `${name}|pm`;
    if (_switchedToday.get(key) !== today) {
      _switchedToday.set(key, today);
      try {
        await _setRes(client, pm);
        console.log(`  [TF-SWITCH] ${name}: PM resolution → ${pm} at ${mins} mins ET`);
        return { transition: 'pm', resolution: pm };
      } catch (e) {
        console.log(`  [TF-SWITCH] ${name}: PM switch FAILED — ${e.message}`);
        _switchedToday.delete(key);
      }
    }
  }

  return null;
}

async function _setRes(client, resolution) {
  return await client.Runtime.evaluate({
    expression: `(function(){
      try {
        window.TradingViewApi._activeChartWidgetWV.value().setResolution('${resolution}');
        return true;
      } catch(e) { return false; }
    })()`,
    returnByValue: true,
  });
}

// Returns 'AM' if before TIMEFRAME_SWITCH_HOUR_ET, 'PM' otherwise.
// Used by paperTrading.js to apply PM stop/target multipliers.
export function getCurrentTimeframeRegime() {
  const switchHour = parseInt(process.env.TIMEFRAME_SWITCH_HOUR_ET || '12', 10);
  return getETMins() >= switchHour * 60 ? 'PM' : 'AM';
}
