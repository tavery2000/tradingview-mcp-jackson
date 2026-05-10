# HANK Service Audit — 2026-05-09

Audit only. No files modified, deleted, or merged.

Scope: every `*.js` file in the project root + `start-hank.bat` invocation chain.
Method: grep + targeted reads against the actual filesystem.

---

## Inventory — what `start-hank.bat` invokes

| Window | Script              | Purpose per launcher                              |
|-------:|---------------------|---------------------------------------------------|
| 1      | `moo-moc.js`        | "MOO/MOC Engine — FJ imbalance — start first"     |
| 2      | `monitor.js`        | "SPY Monitor — Mag-6 + SPY + wsServer :8765"      |
| 3      | `monitor-qqq.js`    | "QQQ Monitor — W3 + QQQ standalone"               |
| 4      | `monitor-iwm.js`    | "IWM Monitor — Mag-3 + IWM standalone"            |
| 5      | `news.js`           | "News Terminal — RSS + SEC + TTS + MOC writer"    |
| 6      | `moc.js`            | "MOC Engine — 15:50 confirmation + hard exit"     |
| 7      | `briefing.js`       | "Morning Briefing — 08:30 ET daily brief"         |
| 8      | `dashboard-server.js` | "Dashboard Server — http://localhost:3000"      |

---

## 1. Duplicate scripts

### 1.1 `moo-moc.js` ⟷ `moc.js` — **CONFIRMED DUPLICATE on the MOC window**

**Status: CONFIRMED DUPLICATE — both are launched and both target 15:50–15:59.**

`start-hank.bat` lines 31 and 56 invoke both. The May 9 production handoff says
`moc.js` handles "both MOO and MOC windows," but the actual code shows the
opposite split:

| Time window | `moo-moc.js`                                       | `moc.js`                                |
|-------------|----------------------------------------------------|------------------------------------------|
| 09:20–09:29 | parses FJ MOO RSS, writes `moo-signal.json` (line 207) | not active                            |
| 15:45       | not active                                         | engine arms (`ARM_MINUTE = 15*60+45`, line 55) |
| 15:50       | parses FJ MOC RSS, writes `moc-signal.json` + `moc-data.json` (line 211) | locks SPY snapshot (`SNAPSHOT_MINUTE = 15*60+50`, line 56) |
| 15:51       | (still in window)                                  | confirms (`CONFIRM_MINUTE = 15*60+51`, line 57); reads `moc-data.json` (line 48) |
| 15:59       | (still in window)                                  | hard exit (`EXIT_MINUTE = 15*60+59`, line 58) |

**Evidence — distinct outputs that must coordinate:**
- `moo-moc.js:207` — `writeFileSync(MOO_SIGNAL_PATH, payload)` — written 09:20–09:29
- `moo-moc.js:211` — `writeFileSync(MOC_DATA_PATH, payload)` — written 15:50–15:59
- `moc.js:48` — `const MOC_DATA_PATH = join(__dirname, 'moc-data.json')` — read at 15:51
- `moc.js:30` — header comment: "moc-data.json written by news.js when FJ MOC alert fires" (out of date — actually written by moo-moc.js)

**Verdict:** Genuinely separate roles, but the **role split disagrees with the May 9 handoff**:
- `moo-moc.js` is the **upstream FJ producer** (writes both MOO and MOC signal files)
- `moc.js` is the **downstream MOC trading engine** (reads `moc-data.json`, fires order, hard-exits at 15:59)

Both are needed. They're not stepping on each other's writes (different files), but they
*are* both running RSS-parse logic during the 15:50 window and `moc.js`'s comment says
news.js writes `moc-data.json` — two-thirds of the documentation is wrong.

**Recommendation: KEEP BOTH but rename `moc.js` to `moc-engine.js`** to make the split
obvious, and update `moc.js:30` header comment to point to `moo-moc.js`. The duplicate
of *responsibility* (RSS parsing) is unavoidable — `moc.js` falls back to its own RSS
fetch if `moc-data.json` is missing.

---

### 1.2 `news.js` `parseMOC()` ⟷ `moo-moc.js` FJ parser — **DEAD CODE PATH**

**Status: SUSPICIOUS — `news.js:613 parseMOC()` exists but never writes the file.**

- `news.js:613` defines `parseMOC(text)`
- `news.js:658` calls `parseMOC(fullText)` and prints to console + speaks TTS
- **No `writeFileSync('moc-data.json', ...)` anywhere in `news.js`**
- `news-moc-patch.js:90` is a *patch suggestion* — `// Apply this patch to news.js to wire parseMOC() → moc-data.json` (line 3) — appears never applied

`moc.js:30` header still claims `news.js` writes `moc-data.json`. It doesn't.
`moo-moc.js:211` does.

**Recommendation: INVESTIGATE.** Either (a) accept `news.js` as display-only and update
`moc.js`'s comment, or (b) decide whether `parseMOC()` in `news.js` should be removed
to avoid future confusion. The patch file `news-moc-patch.js` is dead artifact either
way — see § 5.

---

### 1.3 `monitor-ws-patch.js` ⟷ `monitor.js` wsServer block — **PATCH FILE, ALREADY APPLIED**

**Status: DEAD CODE.** `monitor-ws-patch.js` is a one-time patch artifact (line 3:
"Patches monitor.js to broadcast SPY data + SIGNAL via wsServer on every poll").
Its example code already exists in `monitor.js:3062–3064`. The patch file is not
imported, not invoked from the launcher, and not referenced.

**Recommendation: DEPRECATE** — see § 5 orphans.

---

### 1.4 `news-feeds-patch.js`, `news-moc-patch.js`, `news-overnight-patch.js`

**Status: DEAD CODE.** All three are patch documentation with example snippets
in comments. Not imported, not invoked.

**Recommendation: DEPRECATE** — see § 5.

---

### 1.5 `_build_r2_*.js`, `_build_r3_*.js`, `_patch_r3_*.js` (16 files)

**Status: DEAD CODE — old HTML scaffold builders.** Each one calls
`fs.writeFileSync(file, '')` then `fs.appendFileSync(file, sN)` — they're step-by-step
builders for `hank-electron-r2.html` / `hank-electron-r3.html`. The output HTML files
exist; the builder scripts are no longer needed.

**Recommendation: DEPRECATE** — see § 5.

---

## 2. State file writers

### 2.1 `paper-ledger.json` — **TWO WRITERS WITH SCHEMA MISMATCH (root cause: ledger drift)**

**Status: CONFIRMED RACE CONDITION + SCHEMA MISMATCH.**

| Writer file       | Path constant                                        | Schema written                      | Coordination |
|-------------------|------------------------------------------------------|-------------------------------------|--------------|
| `paperTrading.js` | `LEDGER_FILE` — line 52                              | **Object** with `{trades:[...], balance, totalPnL, totalTrades, wins, losses, ...}` (line 117–123) | `acquireLock()` (line 127) |
| `moc.js`          | `PAPER_LEDGER` — line 50                             | **Bare array** `ledger.push(order)` (line 342); array always reset if file missing (line 339–341) | **None — naive read/modify/write** |

**Evidence — `moc.js:337-348`:**
```js
function writeLedger(order) {
  try {
    const ledger = existsSync(PAPER_LEDGER)
      ? JSON.parse(readFileSync(PAPER_LEDGER, 'utf8'))     // ← assumes array
      : [];
    ledger.push(order);                                    // ← .push on the structured object
    writeFileSync(PAPER_LEDGER, JSON.stringify(ledger, null, 2));
    return true;
  } catch (e) { ... }
}
```

If `paperTrading.js` has populated the ledger (object `{ trades: [...] }`) and `moc.js`
fires its `.push()`, JS will quietly add a `0` indexed property to the object — corrupting
the file or silently dropping the order. There is **no lock** around `moc.js`'s write,
so even if schemas matched it would race `paperTrading.js`'s lock-protected writer.

**This explains the "ledger drift" the user flagged.** The two writers each assume sole
ownership of the file with incompatible schemas.

**Recommendation: INVESTIGATE — and likely MERGE.** Two options:
1. Have `moc.js` import `sendOrder` / `closePosition` from `paperTrading.js` (the same way the three monitors already do) so all writes go through the locked writer.
2. Give `moc.js` its own ledger file (`moc-ledger.json`) so the two never touch the same file.

Option 1 is the correct fix for the reported drift bug.

---

### 2.2 `moc-data.json` — single writer (clean)

**Status: CLEAN.**

| Writer | Line |
|--------|------|
| `moo-moc.js` | 211 |
| `news-moc-patch.js` | 90 (dead — patch file, not invoked) |

`news.js` does NOT write `moc-data.json` despite `moc.js:30` saying so. Single live writer.

---

### 2.3 `moo-signal.json` / `moc-signal.json` — single writer

**Status: CLEAN.**

| File | Writer |
|------|--------|
| `moo-signal.json` | `moo-moc.js:207` (only) |
| `moc-signal.json` | `moo-moc.js` (line shown in 211 region) |

Readers: `monitor.js:1588` (`moo-signal.json`), `dashboard-server.js:178-179` (both),
`session-monitor-2026-05-06.js:14-15` (both — but session-monitor is orphan, see § 5).

---

### 2.4 Per-instrument levels files — **single writer per file (clean)**

**Status: CLEAN.**

| File | Writer | Line |
|------|--------|------|
| `spy-levels.json` | `monitor.js`     | 2876 |
| `qqq-levels.json` | `monitor.js`     | 2909 (cross-write — see note) |
| `qqq-levels.json` | `monitor-qqq.js` | 1165 |
| `iwm-levels.json` | `monitor.js`     | 2926 (cross-write — see note) |
| `iwm-levels.json` | `monitor-iwm.js` | 1180 |

⚠ **`monitor.js` writes `qqq-levels.json` and `iwm-levels.json` from its OWN poll**
(`monitor.js:2909` writes QQQ levels, `monitor.js:2926` writes IWM levels). And
`monitor-qqq.js:1165` / `monitor-iwm.js:1180` ALSO write the same files from their
own polls. **Two writers per file, no coordination.**

**Status (corrected): SUSPICIOUS — 2 writers each on `qqq-levels.json` and `iwm-levels.json`.**

This is the same pattern as the ledger drift but with a smaller blast radius (overwrite,
not corruption). The shape both monitors write is the same `{pdHigh, pdLow, pdClose,
todayOpen, current, vwap, bias, ts, time}`, so the worst case is **stale reads** —
whichever monitor wrote last wins, and a slow `monitor.js` cycle may overwrite a fresh
`monitor-qqq.js` write with stale values.

**Recommendation: INVESTIGATE.** Either:
- Designate one writer per file (probably `monitor-qqq.js` for QQQ, `monitor-iwm.js` for IWM, drop the cross-writes from `monitor.js`), OR
- Add a `ts`-based "younger wins" check.

---

### 2.5 Other JSON state — single writer each (clean)

| File | Writer |
|------|--------|
| `account-tier.json`     | `tier.js:128, 142` |
| `daily-bias.json`       | `daily-bias.js:237` |
| `options-flow.json`     | `options-flow.js:244` |
| `voice-queue.json`      | `paperTrading.js:650` |
| `portfolio-theta.json`  | `paperTrading.js:782` |
| `briefing.json`         | `briefing.js:525` |
| `mag6-state.json`       | `monitor.js:2903` |
| `flow-signal.json`      | `news.js:647` |
| `overnight-news.json`   | `news.js:51` |
| `fvg-state-{INSTR}.json`   | `fvg.js:68`   (called via `triggerScans` from all 3 monitors — separate files per instrument so no race) |
| `sweep-state-{INSTR}.json` | `sweep.js:79` (same — per-instrument files, no race) |

---

## 3. wsServer topics

### 3.1 Server lives in `wsServer.js`

`wsServer.js:95` defines `broadcast(type, payload, forceImmediate)`. Helpers wrap specific topics:

| Helper             | Topic    | Line |
|--------------------|----------|------|
| `broadcastGreeks`  | `greeks` | 138 |
| `broadcastSignal`  | `signal` | 139 |
| `broadcastNews`    | `news`   | 140 |
| `broadcastMOC`     | `moc`    | 141 |
| `broadcastMemory`  | `memory` | 142 |
| `broadcastGC`      | `gc`     | 143 |
| `broadcastStatus`  | `status` | 144 |
| `broadcastAlert`   | `alert`  | 147 |

`wsServer.js:398-402` exposes `global.wsBroadcast = (type, payload) => broadcast(...)`
for monitor.js to use **without importing wsServer.js**. Topics emitted via the global:

- `monitor.js:3062-3064` — `tick` events: `TICK_SPY`, `TICK_QQQ`, `TICK_IWM` (per-poll, throttle bypass at `wsServer.js:402`)
- `monitor.js` (signal payload via `broadcastSignal`)

### 3.2 Subscribers

| Subscriber                | Topics consumed                                    | Line |
|--------------------------|----------------------------------------------------|------|
| `moc.js`                  | connects to `ws://localhost:8765`, listens for SPY price/delta/vwap (via SIGNAL or TICK) | 670 |
| `paperTrading.js`         | connects to wsServer, listens for `TICK_SPY` / `TICK_QQQ` / `TICK_IWM` | 1542, 1557 |
| `useHANK.js`              | connects to wsServer (display client) | 130 |
| `warroom-test.js`         | imports + drives wsServer for testing | 22 |

### 3.3 Findings

**Status: CLEAN — no topic duplication.**

- Each topic has exactly one emitter (the central wsServer broadcast helpers, or `monitor.js` via `global.wsBroadcast`).
- Subscribers are not duplicated: `moc.js` and `paperTrading.js` both listen to TICK
  events but for different purposes (snapshot lock vs. live exit checks); they don't
  generate duplicate side effects.
- `useHANK.js` subscribes (line 130) but is not in `start-hank.bat` and not imported anywhere — see § 5.

**One concern:** `monitor-ws-patch.js:47` has its own `WebSocketServer({ port: WS_BROADCAST_PORT })`
on the same port. **Dead code** (the patch was applied to monitor.js already), but if
ever invoked it would conflict with `wsServer.js`. See § 5.

---

## 4. Journal writers

### 4.1 Function definitions (`journal.js`)

| Function       | Line | Type emitted   |
|----------------|------|----------------|
| `jPoll(s)`     | 57   | `POLL`         |
| `jSignal(...)` | 58   | `SIGNAL`       |
| `jGateBlock(...)` | 61 | `GATE_BLOCK`   |
| `jEntry(t)`    | 64   | `ENTRY`        |
| `jExit(t)`     | 81   | `EXIT`         |
| `jAlert(...)`  | 96   | `ALERT`        |
| `jError(...)`  | 97   | `ERROR`        |

`journal.js:53` uses `appendFileSync` — multi-process append-safe at the OS level.

### 4.2 Caller map

| File               | Imports from journal.js                                 |
|--------------------|---------------------------------------------------------|
| `monitor.js`       | jPoll, jSignal, jGateBlock, jAlert, jError              |
| `monitor-qqq.js`   | jPoll, jSignal, jGateBlock, jAlert, jError              |
| `monitor-iwm.js`   | jPoll, jSignal, jGateBlock, jAlert, jError              |
| `paperTrading.js`  | **jEntry, jExit**, jError, jAlert, journal             |
| `bars.js`          | jError, jAlert                                          |
| `daily-bias.js`    | jAlert, jError                                          |
| `options-flow.js`  | jAlert, jError                                          |
| `triggerScans.js`  | jAlert, jError                                          |
| `moc.js`           | journal (raw), jAlert, jError                           |

### 4.3 `jEntry` / `jExit` — single caller (clean)

**Status: CLEAN.**

- `jEntry` called only from `paperTrading.js:472`
- `jExit`  called only from `paperTrading.js:559`
- `moc.js` does NOT call jEntry/jExit — it bypasses the journal entirely and writes the ledger directly (see § 2.1). **This is a separate bug** from journal duplication: trades placed by `moc.js` never produce ENTRY/EXIT journal records, so any analysis that scans the journal for trade history misses them.

**Recommendation:** Either (a) merge moc.js's order path into paperTrading.sendOrder (which would naturally produce jEntry/jExit), or (b) explicitly call jEntry/jExit from moc.js. § 2.1 already recommends option (a).

### 4.4 `jSignal` — multiple callers (clean — different scopes)

`monitor.js:2846-2850` emits SIGNAL for SPY-context signals.
`monitor-qqq.js:1121-1123` emits SIGNAL with `instrument: 'QQQ'` extra.
`monitor-iwm.js:1138-1140` emits SIGNAL with `instrument: 'IWM'` extra.

Each instrument writes its own signal records. No duplication — different instruments. **CLEAN.**

### 4.5 `jGateBlock` — multiple callers per instrument

Three monitors call `jGateBlock` for their own instrument. `monitor.js:2358-2507` calls
it 18 times for SPY-only contexts, plus once for QQQ in the older shared dispatch path.
`monitor-qqq.js` and `monitor-iwm.js` each call it ~10 times for their own instrument.

**Risk:** if `monitor.js` ever fires a QQQ scalp through its old dispatch (per `monitor.js`
line 2961, suspended via `QQQ_SUSPENDED = false` flag), AND `monitor-qqq.js` is also
running, the same QQQ signal could be gated/journalled by both processes. The
`QQQ_SUSPENDED` flag exists exactly to prevent this — verify it's still `false` (it is,
per the source).

**Status: SUSPICIOUS — but currently mitigated by `QQQ_SUSPENDED`/by IWM never being routed through `monitor.js`.** Worth a note in the cleanup commit.

---

## 5. Orphaned files

Definition: lives in project root, has `setInterval`/`SIGINT` (i.e. service-shaped),
and is **NOT** invoked by `start-hank.bat` AND **NOT** imported by any active file.

| File                              | Last modified | Service-shaped? | Imported? | Status |
|-----------------------------------|---------------|-----------------|-----------|--------|
| `flow.js`                         | 2026-05-04    | yes (`setInterval` × 2 + SIGINT, lines 174–179) | no | **ORPHAN** |
| `useHANK.js`                      | 2026-05-03    | yes (setInterval line 143, WebSocket client) | no | **ORPHAN** |
| `session-monitor-2026-05-06.js`   | 2026-05-06    | yes (SIGINT line 457) | no | **ORPHAN — date-stamped session capture** |
| `scalper-run.js`                  | 2026-04-19    | yes (XRP scalper from prior project) | no | **ORPHAN — pre-HANK era** |
| `monitor-ws-patch.js`             | 2026-05-03    | declares WebSocketServer | no | **ORPHAN — patch applied** |
| `news-feeds-patch.js`             | 2026-05-03    | patch file (commented examples) | no | **ORPHAN** |
| `news-moc-patch.js`               | 2026-05-03    | patch file | no | **ORPHAN — patch never applied (see § 1.2)** |
| `news-overnight-patch.js`         | 2026-05-05    | patch file | no | **ORPHAN** |
| `_build_r2_s1.js` … `_build_r2_s9.js` (7 files) | 2026-05-06 | HTML scaffold builders | no | **ORPHAN** |
| `_build_r3_s1.js` … `_build_r3_s9.js` (7 files) | 2026-05-06 | HTML scaffold builders | no | **ORPHAN** |
| `_patch_r3_colors2.js`            | 2026-05-07    | one-shot patch | no | **ORPHAN** |
| `_patch_r3_readability.js`        | 2026-05-07    | one-shot patch | no | **ORPHAN** |
| `wsServer-schema.js`              | 2026-05-03    | comments only — no exports invoked | no | **ORPHAN — design doc as code** |
| `warroom-test.js`                 | 2026-05-03    | yes (test driver) | no | NOT orphan — clearly named test |
| `test-email.js`                   | 2026-04-27    | one-shot script | imports mailer | NOT orphan — manual test |
| `test-options.js`                 | 2026-05-05    | one-shot script | imports webull | NOT orphan — manual test |
| `list-accounts.js`                | 2026-05-03    | one-shot CLI | imports webull | NOT orphan — utility |
| `listtabs.js`                     | 2026-05-01    | CDP probe | no | NOT orphan — manual probe utility (489 bytes) |
| `probe.js`                        | 2026-04-26    | CDP probe | no | NOT orphan — manual probe utility (1 KB) |
| `alpaca.js`                       | 2026-05-04    | (verify — not service-shaped) | no | **ORPHAN candidate — investigate** |
| `send-beta-update.js`             | 2026-04-29    | mailer one-shot | imports mailer | NOT orphan — manual broadcast |
| `send-manual-briefing.js`         | 2026-05-05    | mailer one-shot | imports mailer | NOT orphan — manual broadcast |

**Library files** (imported, no setInterval/SIGINT — explicitly NOT orphan):
`l2.js`, `theta.js`, `mailer.js`, `journal.js`, `analyze.js`, `bars.js`, `chartDraws.js`,
`chartStructure.js`, `daily-bias.js`, `fvg.js`, `multipliers.js`, `options-flow.js`,
`paperTrading.js`, `signalConfidence.js`, `sweep.js`, `tier.js`, `triggerScans.js`,
`webull.js`, `wsServer.js`, `dashboard-server.js`, `ask.js`/`ask-cli.js`.

**Recommendation: DEPRECATE all 14+ orphans.** Move to an `archive/` subfolder rather
than deleting outright — they're git-tracked or about-to-be-tracked, deletion can
happen in a follow-up commit after a cooling period.

---

## 6. Cron-like time windows

### 6.1 Window grid (each row is a guard found in code)

| Window               | File           | Line | Code |
|----------------------|----------------|------|------|
| 09:20–09:29 MOO      | `moo-moc.js`   | 314 | `etMins() > 9*60+20 && etMins() < 9*60+30` (FJ pull) |
| 09:25–09:35 MOO      | `multipliers.js` | 36 | session window for time-multiplier weights |
| 09:29–09:55 OPENING  | `monitor.js`   | 914, 1684, 1934 | `isOpeningWindow()` — three independent definitions |
| 09:29–09:55 OPENING  | `monitor-qqq.js` | 587 | same shape |
| 09:29–09:55 OPENING  | `monitor-iwm.js` | 586 | same shape |
| 09:30–09:35 BULLET-1 | `monitor.js`   | 897 | session table |
| 09:30 OR start       | `daily-bias.js` | 178 | `getETMins() - (9*60+30)` for sessionMins |
| 09:30–09:40 OPEN-RANGE OBSERVATION | `monitor.js` | 2358-2364 | gate block |
| 09:31 levels re-fetch | `monitor.js`  | 2584 | `etM >= 9*60+31` |
| 09:31 levels re-fetch | `monitor-qqq.js` | 1050 | same |
| 09:31 levels re-fetch | `monitor-iwm.js` | 1068 | same |
| 09:35–10:00 OPEN     | `multipliers.js` | 37 |  |
| 09:40 daily-bias eval | `monitor.js`   | 2817 | `_etM >= 9*60+40 && _biasEvaluatedAt < 9*60+40` |
| 12:30 daily-bias re-eval | `monitor.js` | 2818 | second eval at midday |
| 14:00 burn-zone start | `monitor.js`  | 2292 | `targetMult = etMins >= 14*60 ? 1.7 : 2.0` |
| 14:30 AFTERNOON      | `monitor.js`   | 902 | session table |
| 15:00 PRE-MOC start  | `monitor.js`   | 903 | session table |
| 15:30–15:50 SPX-ONLY | `monitor.js`   | 904 | session table |
| 15:30 stop tightening | `monitor.js`  | 2290 | `etMins >= 15*60+30 ? 0.40 : 0.45` |
| 15:30–15:50 PRE-MOC  | `multipliers.js` | 42 |  |
| 15:30–15:50 PRE-MOC  | `theta.js`     | 380 | theta-decay zones |
| 15:45 EOD start      | `monitor.js`   | 2288 | `isEOD = etMins >= 15*60+45` |
| 15:45 isClose()      | `monitor-qqq.js` | 585, `monitor-iwm.js:585` | `etMins() >= 15*60+45` |
| 15:45 MOC arm        | `moc.js`       | 55 | `ARM_MINUTE` |
| 15:50 MOC publication | `moo-moc.js`  | 314 | FJ MOC pull window |
| 15:50 MOC snapshot   | `moc.js`       | 56 | `SNAPSHOT_MINUTE` |
| 15:50–16:00 MOC      | `monitor.js`   | 905 | session table |
| 15:50–16:00 MOC      | `multipliers.js` | 43 |  |
| 15:50–16:15 MOC theta | `theta.js`    | 381 |  |
| 15:51 MOC confirm    | `moc.js`       | 57 | `CONFIRM_MINUTE` — reads `moc-data.json` |
| 15:55 MOC WAR ROOM   | `wsServer.js`  | 248 | mode switch trigger |
| 15:59 MOC hard exit  | `moc.js`       | 58 | `EXIT_MINUTE` |
| 15:59 SPY exit       | `theta.js`     | 286 | `(15*60+59) - getETMins()` |
| 16:00–16:01 session reset | `monitor.js` | 3055, `monitor-qqq.js:1179`, `monitor-iwm.js:1194` | `etMinsNow >= 16*60 && etMinsNow < 16*60+1` — three identical guards |
| 16:14 SPX exit       | `theta.js`     | 285 |  |

### 6.2 Findings

**Status: SUSPICIOUS — multiple overlapping guards on the MOC window (15:50–16:00).**

Six files all guard "MOC happens around 15:50":
1. `moo-moc.js` — pulls FJ RSS, writes data
2. `moc.js`     — locks snapshot, fires order, writes ledger
3. `monitor.js` — session table marks MOC; fires its own EOD logic at 15:45
4. `paperTrading.js` — `'PRE-MOC'` / `'MOC'` session tags at 15:50, EOD logic at 15:45
5. `theta.js`   — theta zone CRITICAL/EXTREME at 15:30 / 15:50
6. `multipliers.js` — confidence multiplier zones

Some redundancy is **expected** (cosmetic session naming) but two guards are
genuinely racing:
- `monitor.js:2288` and `monitor-qqq.js:966` and `monitor-iwm.js:963` all declare
  `isEOD = etMins >= 15*60+45` and trigger their own exit logic. Each scopes to
  its own instrument so this is fine.
- `moc.js:58` `EXIT_MINUTE = 15*60+59` triggers a hard exit on `moc.js`'s own positions —
  but these positions are written to the SAME `paper-ledger.json` that the three
  monitors also exit (§ 2.1). Two independent EOD-exit paths writing the same file.

**Recommendation: INVESTIGATE.** The MOC-window overlap isn't itself a bug — each
file guards a different *action* — but combined with the § 2.1 ledger schema mismatch
it means the 15:59 hard-exit may collide with `paperTrading.js`'s EOD sweep. Fixing
§ 2.1 (route moc.js through paperTrading.js) resolves both at once.

### 6.3 Three identical 16:00–16:01 session-reset guards

`monitor.js:3055`, `monitor-qqq.js:1179`, `monitor-iwm.js:1194`:
```js
if (etMinsNow >= 16*60 && etMinsNow < 16*60+1) {
```

Each instrument's monitor independently resets its session state at 16:00. Cosmetically
duplicate but not harmful — they reset only their own state. **Recommendation: KEEP.**

### 6.4 Three identical 09:31 re-fetch guards

`monitor.js:2584`, `monitor-qqq.js:1050`, `monitor-iwm.js:1068` — same pattern, same
verdict. **Recommendation: KEEP.**

### 6.5 Three identical 09:29–09:55 `isOpeningWindow()` definitions inside `monitor.js`

`monitor.js:1684` and `monitor.js:1934` define `isOpeningWindow()` inside two different
closures (likely SPY and a swing engine). `monitor.js:914` defines a top-level one.
Three copies in the same file.

**Recommendation: INVESTIGATE.** Cosmetic refactor to extract to one shared helper.
Harmless today.

---

## Summary table

| Finding | Status | Recommendation |
|---|---|---|
| § 1.1 `moo-moc.js` ⟷ `moc.js` | CONFIRMED DUPLICATE on MOC window — but distinct roles | KEEP BOTH, rename `moc.js` → `moc-engine.js`, fix stale `moc.js:30` comment |
| § 1.2 `news.js parseMOC` is dead | DEAD CODE PATH | INVESTIGATE / DEPRECATE |
| § 1.3 `monitor-ws-patch.js` | DEAD CODE | DEPRECATE |
| § 1.4 `news-*-patch.js` (3 files) | DEAD CODE | DEPRECATE |
| § 1.5 `_build_r2_*` / `_build_r3_*` / `_patch_r3_*` (16 files) | DEAD CODE | DEPRECATE |
| § 2.1 `paper-ledger.json` 2 writers + schema mismatch | CONFIRMED RACE — explains "ledger drift" | MERGE — route moc.js through paperTrading.sendOrder |
| § 2.4 `qqq/iwm-levels.json` 2 writers each | SUSPICIOUS — overwrite, not corruption | INVESTIGATE — drop monitor.js cross-writes |
| § 3 wsServer topics | CLEAN | KEEP |
| § 4.3 `jEntry`/`jExit` single caller | CLEAN | KEEP — but see § 2.1 (moc.js bypasses the journal) |
| § 4.5 `jGateBlock` cross-instrument risk | SUSPICIOUS — mitigated by `QQQ_SUSPENDED` | KEEP — flag for cleanup commit |
| § 5 14+ orphan files | CONFIRMED ORPHANS | DEPRECATE — move to `archive/` |
| § 6.2 MOC-window overlap | SUSPICIOUS — collides with § 2.1 | INVESTIGATE — fixed by § 2.1 |
| § 6.5 three `isOpeningWindow()` copies in `monitor.js` | minor refactor opportunity | INVESTIGATE — harmless |

## Top 3 priorities

1. **Fix § 2.1** — `moc.js` writes `paper-ledger.json` as a bare array while `paperTrading.js`
   writes it as a structured object. **Confirmed root cause of ledger drift.** Route moc.js
   trades through `paperTrading.sendOrder` (which is locked + structured + journals
   ENTRY/EXIT correctly).
2. **Resolve § 2.4** — pick one writer per instrument-levels file. Current cross-writes
   from `monitor.js` to `qqq-levels.json` / `iwm-levels.json` race the dedicated monitors.
3. **Move all § 5 orphans to `archive/`** — 14+ files of dead build artifacts and patch
   stubs muddying the project root, including the outdated `monitor-ws-patch.js` and the
   never-applied `news-moc-patch.js` referenced (incorrectly) in `moc.js`'s header.
