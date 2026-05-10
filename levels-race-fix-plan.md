# Levels-File Race Fix Plan — Task 3 Part A

**Status:** investigation complete, awaiting approval before code changes.

**Summary in one sentence:** Delete two write blocks from `monitor.js`
(lines 2906-2921 for QQQ, 2923-2938 for IWM). The dedicated monitors
(`monitor-qqq.js:1162-1175`, `monitor-iwm.js:1177-1190`) write a strict
**superset** of those blocks, with fresher `todayOpen` data. No
consumer breaks.

---

## Investigation findings

### `monitor.js` write blocks — exact code

**QQQ (lines 2906-2921):**
```js
// qqq-levels.json — QQQ pre-market levels for future briefing expansion
if (qqqClient && qqq?.price) {
  try {
    writeFileSync(join(__dirname, 'qqq-levels.json'), JSON.stringify({
      pdHigh:    global.qqqPreMarketLevels?.pdHigh    ?? null,
      pdLow:     global.qqqPreMarketLevels?.pdLow     ?? null,
      pdClose:   global.qqqPreMarketLevels?.pdClose   ?? null,
      todayOpen: global.qqqPreMarketLevels?.todayOpen ?? null,
      current:   qqq.price,
      vwap:      qqq.vwap,
      bias:      qqq.bias,
      ts:        Date.now(),
      time:      getETString(),
    }, null, 2));
  } catch { /* non-fatal */ }
}
```

**IWM (lines 2923-2938):** identical structure, `iwm`/`iwmPreMarketLevels`.

**When they fire:** every poll (30s cycle) when `qqqClient` and `qqq?.price`
are truthy. Inside the same loop that writes `spy-levels.json` (line 2876)
and `mag6-state.json` (line 2903).

**Where the data comes from:**
- `qqq.price`, `qqq.vwap`, `qqq.bias` — pulled fresh from monitor.js's own CDP
  connection to the QQQ tab (`readQQQInstrument()` earlier in the poll).
- `global.qqqPreMarketLevels` / `global.iwmPreMarketLevels` — calculated **once
  at startup** by `calcPreMarketLevelsForClient(qqqClient)` (monitor.js:3404)
  and `calcPreMarketLevelsForClient(iwmClient)` (monitor.js:3413). **No 09:31 refresh.**

### Dedicated-monitor write blocks

**`monitor-qqq.js:1162-1175`:**
```js
// Write qqq-levels.json for briefing
try {
  const _volColor = _volumePct < 0.50 ? 'red' : _volumePct < 0.80 ? 'yellow' : 'green';
  writeFileSync(LEVELS_FILE, JSON.stringify({
    pdHigh: global.preMarketLevels?.pdHigh ?? null,
    pdLow:  global.preMarketLevels?.pdLow  ?? null,
    pdClose: global.preMarketLevels?.pdClose ?? null,
    todayOpen: global.preMarketLevels?.todayOpen ?? null,
    current: etf?.price ?? null, vwap: etf?.vwap ?? null, bias: etf?.bias ?? null,
    volumePct: parseFloat(_volumePct.toFixed(2)),
    volumeColor: _volColor,
    ts: Date.now(), time: getETString(),
  }, null, 2));
} catch {}
```

**`monitor-iwm.js:1177-1190`:** identical structure for IWM.

**When they fire:** every poll (30s cycle).

**Pre-market data refresh:** dedicated monitors call `calcPreMarketLevels()`
once at startup AND **refresh at 09:31** (monitor-qqq.js:1048-1054, monitor-iwm.js:1066-1072)
when the `todayOpen` field becomes available after the open candle prints.

### Field comparison

#### qqq-levels.json

| Field | monitor.js writes? | monitor-qqq.js writes? | Comment |
|---|:---:|:---:|---|
| `pdHigh`      | yes | yes | Both calculate independently. Same value. |
| `pdLow`       | yes | yes | Same. |
| `pdClose`     | yes | yes | Same. |
| `todayOpen`   | yes | yes | **monitor.js is `null` all day** — calc'd once at 7am before open exists. monitor-qqq.js refreshes at 09:31 and gets the real value. |
| `current`     | yes | yes | Both pulled live from CDP. Same source quality. |
| `vwap`        | yes | yes | Same. |
| `bias`        | yes | yes | Same. |
| `volumePct`   | **NO** | yes | Only the dedicated monitor computes session volume %. |
| `volumeColor` | **NO** | yes | Only dedicated. Used by dashboard color-coding. |
| `ts`          | yes | yes | Both `Date.now()`. |
| `time`        | yes | yes | Both `getETString()`. |

**Verdict:** `monitor-qqq.js` writes a strict **superset**. Removing the monitor.js write loses zero fields and improves `todayOpen` accuracy after 09:31.

#### iwm-levels.json

Identical pattern. Same superset relationship. Same `todayOpen` correctness improvement.

### Consumer audit

Every file that reads `qqq-levels.json` or `iwm-levels.json`:

| Reader | Line | Fields it uses | Race-window risk |
|---|---|---|---|
| `dashboard-server.js` | 172, 173 | whole file (`/api/levels`) | None — reads on HTTP request, last write wins anyway |
| `l2.js` | 50, 51 | `pdHigh`, `pdLow`, `current`, `vwap` | None — polls every 5s, would just see fresher data after fix |
| `ask.js` (ASK HANK) | 90, 107 (template `${sym.toLowerCase()}-levels.json`) | `current`, `vwap`, `pdHigh`, `pdLow`, `pdClose`, `todayOpen`, `bias`, `ts`, `time` | None — read-on-demand from REPL |
| `briefing.js` | 9, 463, 630 | **NONE — these are display strings only**, file is not actually read | n/a |
| `electron-plan.md` | 107-108 | doc only | n/a |
| `_archive/2026-05-09-orphans/session-monitor-2026-05-06.js` | 12-13 | archived, not running | n/a |

**No consumer reads `volumePct` or `volumeColor` today.** Those fields are
preserved going forward but no current consumer cares about them — they're
already there, dashboard hasn't wired them yet.

**No consumer reads any field that ONLY monitor.js writes today** (because
monitor.js writes a strict subset of monitor-qqq.js / monitor-iwm.js).

### Startup-window analysis

`start-hank.bat`:
- T+0s: `moo-moc.js` (Window 1)
- T+0s: `monitor.js` (Window 2)
- T+6s: `monitor-qqq.js` (Window 3)
- T+8s: `monitor-iwm.js` (Window 4)

monitor.js's first poll fires roughly T+30s. monitor-qqq.js's first poll fires
roughly T+36s. Today, monitor.js wins the first write race; the dedicated
monitor overwrites a few seconds later. After the fix, the dedicated monitor
is the only writer.

**Worst-case startup window:**
- T+0..T+36s: `qqq-levels.json` may not exist yet.
- T+0..T+38s: `iwm-levels.json` may not exist yet.

This is **already the behavior on the first poll**. Today, the dashboard /
l2.js / ASK HANK either find no file (return "no data") or find the file
written by monitor.js with `todayOpen: null` — both are degraded states
for the first ~30 seconds. After the fix, the degraded state is identical
("no file" vs "null fields").

All consumers already handle missing files gracefully:
- `dashboard-server.js:172-173` uses `?? {}` fallback.
- `l2.js` returns null per-file in its read loop.
- `ask.js:91` returns `"No data for QQQ. Is monitor.js running?"`.

The 30s-startup gap is **acceptable** and **unchanged in severity** by this fix.

---

## A) What gets removed

Two contiguous blocks in `monitor.js`:

**Block 1 — qqq-levels.json (lines 2906-2921, ~16 lines):**
```js
  // qqq-levels.json — QQQ pre-market levels for future briefing expansion
  if (qqqClient && qqq?.price) {
    try {
      writeFileSync(join(__dirname, 'qqq-levels.json'), JSON.stringify({
        ...8 lines of fields...
      }, null, 2));
    } catch { /* non-fatal */ }
  }
```

**Block 2 — iwm-levels.json (lines 2923-2938, ~16 lines):**
```js
  // iwm-levels.json — IWM pre-market levels for future briefing expansion
  if (iwmClient && iwm?.price) {
    try {
      writeFileSync(join(__dirname, 'iwm-levels.json'), JSON.stringify({
        ...8 lines of fields...
      }, null, 2));
    } catch { /* non-fatal */ }
  }
```

**Total expected diff in monitor.js:** −32 lines, +0 lines (~~30 lines of code + ~2 blank/comment lines).

**Imports that become unused:** none. `writeFileSync` and `join` are still
needed for `spy-levels.json` (line 2876), `mag6-state.json` (line 2903), and
many other files monitor.js writes.

### Optional cleanup (recommended NO for this commit, defer to follow-up)

The `calcPreMarketLevelsForClient(qqqClient)` and `calcPreMarketLevelsForClient(iwmClient)`
calls at monitor.js:3404 and 3413, and the resulting `global.qqqPreMarketLevels` /
`global.iwmPreMarketLevels` reads at lines 1862-1863, 2108-2109, become **partial dead code**:
- The values are still printed at startup as a "QQQ pre-market: PDH ... PDL ..." log line
  (informational — useful for the operator to see).
- But no code reads them after the writes are removed.

**Recommendation:** leave them in. The startup print is operator-useful diagnostic. The cost is one extra CDP fetch at startup per non-SPY symbol — negligible. Removing them is a separate cleanup task (would also require deleting `calcPreMarketLevelsForClient` if it has no other callers — let me verify).

---

## B) What gets preserved

**Nothing needs to be migrated.** monitor.js's writes are a strict subset of
the dedicated monitors' writes, and the only field where monitor.js had a
unique value (`todayOpen`) was actually wrong (always `null` for the session).

**Decision: option (ii) for every field** — none lost, all already covered.

### Specifically:
- `pdHigh`, `pdLow`, `pdClose`, `todayOpen` → already written by monitor-qqq.js / monitor-iwm.js with **better** `todayOpen` due to 09:31 refresh.
- `current`, `vwap`, `bias` → already written by dedicated monitors via their own CDP read.
- `ts`, `time` → already written.

---

## C) Startup-window handling

**No new code needed.** The startup window where `qqq-levels.json` /
`iwm-levels.json` don't exist already happens today during T+0…T+30s. All
consumers handle missing files gracefully (audit § 5 confirms the
"graceful degradation" pattern is universal).

**If we wanted to close the startup gap** (separate task): have
`monitor-qqq.js` and `monitor-iwm.js` write a stub `{ ts, time, current: null }`
payload immediately after `initClient()` succeeds, before the first 30s poll.
**Recommendation: defer.** The 30s gap on cold-start is not in any reported
bug list — only the running-state race was.

---

## D) Consumer impact

| Consumer | Behavior change after fix | Risk |
|---|---|---|
| `dashboard-server.js` | None during steady-state. 30s startup gap unchanged. | None. |
| `l2.js` | None. Polls every 5s; sees same fields, possibly fresher `todayOpen`. | None. |
| `ask.js` | None. `qqq` and `iwm` commands now return `current` and `todayOpen` accurately after 09:31. **Improvement, not regression.** | None. |
| `briefing.js` | Doesn't read these files (display strings only). | None. |

**Behavior IMPROVES after fix:**
- `todayOpen` correctly reflects the day's open after 09:31 (was always `null` before due to monitor.js writes overriding monitor-qqq.js writes with stale data).
- `volumePct` and `volumeColor` are no longer wiped by monitor.js's writes between dedicated-monitor polls. (These fields are already in the file but get briefly overwritten with `undefined` by monitor.js; a careful consumer might see `undefined` for ≤30s windows.)

---

## E) Risk assessment

### Worst case if the fix is wrong

- **Scenario A:** dedicated monitor stops running but monitor.js continues. After fix, `qqq-levels.json` goes stale (old `ts`). Consumers see stale data instead of the (also-stale) data monitor.js was writing. **Detection: consumers can flag stale `ts` (>60s old).**
- **Scenario B:** dedicated monitor never starts (config error). After fix, `qqq-levels.json` doesn't exist at all. Consumers return "no data". **Operator sees this immediately in dashboard / ASK HANK.**

Both scenarios are operationally **better** than the pre-fix state, where
stale monitor.js writes were silently masking dedicated-monitor failures.

### Detection for the regression

- `ask.js qqq` and `ask.js iwm` commands surface staleness via the `Last update X ET (Yh ago)` line.
- Dashboard `/api/levels` returns whole file content — a stale `ts` is visible to operators.
- l2.js prints to its CMD window every 5s — a stale read shows up immediately.

No new monitoring code needed.

---

## F) Test plan

### F.1 Pre-fix smoke (verify the bug is real)

Currently impractical without time-traveling to 09:31, but as a sanity check:
- Read `qqq-levels.json` while only `monitor.js` is running (kill `monitor-qqq.js`).
- Confirm `todayOpen: null` and missing `volumePct`/`volumeColor`.
- Restart `monitor-qqq.js`.
- Within 30s, re-read — confirm `todayOpen` and `volumePct`/`volumeColor` populate.

### F.2 Post-fix verification (no market hours required)

After Task 3-B lands:

1. Stop everything: `start-hank.bat` processes, manual `node monitor.js`, etc.
2. Delete `qqq-levels.json` and `iwm-levels.json` from project root.
3. Start only `monitor-qqq.js` (`node monitor-qqq.js`). Wait 60s.
4. **Assert:** `qqq-levels.json` exists and contains all expected fields (pdHigh, pdLow, pdClose, todayOpen, current, vwap, bias, volumePct, volumeColor, ts, time).
5. Stop `monitor-qqq.js`. Start `monitor.js` (`node monitor.js`). Wait 60s.
6. **Assert:** `qqq-levels.json` is **NOT modified** by monitor.js (compare `ts` before and after the 60s wait — should be unchanged).
7. Repeat 1-6 for IWM with `monitor-iwm.js`.

This proves:
- Dedicated monitor is sole writer (step 6's "ts unchanged").
- All consumer fields still produced (step 4's field check).

### F.3 Live verification Monday

Run start-hank.bat normally. After 09:35 ET:
- `cat qqq-levels.json | jq .todayOpen` should be a real price (non-null).
- `cat qqq-levels.json | jq .volumePct` should be present.
- ASK HANK `qqq` should report a fresh `Last update` time-stamped within the last 30s.

If any of those checks fail, `git revert <task-3-hash>` rolls back the fix
without touching unrelated work.

---

## Summary

- **One file changes:** `monitor.js` only. Two write blocks deleted, ~32 lines removed.
- **Zero changes:** `monitor-qqq.js`, `monitor-iwm.js`, every consumer.
- **Zero data loss:** monitor.js writes a strict subset of dedicated-monitor writes, and its `todayOpen` was always stale anyway.
- **Side benefit:** `todayOpen` becomes accurate after 09:31 (was always `null` for the session due to monitor.js overwriting monitor-qqq.js's refreshed value).
- **No new code needed:** dedicated monitors already do the right thing. We're just stopping the second writer from interfering.

Awaiting approval before any code changes.
