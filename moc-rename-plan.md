# MOC Rename Plan — Task 4 Part A

**Status:** investigation complete, awaiting approval before code changes.

**Summary in one sentence:** `git mv moc.js moc-engine.js`, update 4 active
files that reference the old name (start-hank.bat, _test_moc_route.js,
_test_moc_e2e.js, the renamed file's own internal references), update
2 doc files (HANK-BRIEFING.md, hank-electron-r3.html dashboard labels),
plus the one-line `news.js → moo-moc.js` correction in the header
comment block.

---

## Investigation findings

### `moc.js` references — categorized

#### A. Active code (MUST update)

| File:Line | Reference | Action |
|---|---|---|
| `start-hank.bat:56` | `node moc.js` (Window 6 launcher) | Rename + update Window-6 echo banner |
| `_test_moc_route.js:13` | `import {...} from './moc.js'` | Rename import path |
| `_test_moc_route.js:2, 74` | comments mentioning `moc.js` | Rename for accuracy |
| `_test_moc_e2e.js:137` | `await import('./moc.js')` | Rename import path |
| `_test_moc_e2e.js:3, 120, 121, 124, 131, 140, 147, 183` | comments mentioning `moc.js` | Rename for accuracy |

#### B. The renamed file's own internal references (MUST update)

Inside the file (will be `moc-engine.js` after git mv):

| Line | Current text |
|---:|---|
| 3 | `* moc.js — MOC (Market-On-Close) Engine v2` |
| **30** | **`*   moc-data.json  written by news.js when FJ MOC alert fires`** ← inaccurate, see § B below |
| 34 | `* Usage: node moc.js   (Window 3, alongside monitor.js + news.js)` |
| 338, 339 | `// Map a moc.js-style 'order' to the 'consensus' object paperTrading.sendOrder` etc. |
| 345 | `// moc.js doesn't yet track live option premium at exit.` |
| 549 | `// Exit price degraded: moc.js doesn't yet pull live option premium at exit,` |
| 612 | `// paperTrading; moc.js no longer writes paper-ledger.json directly.` |
| 793 | `// Run main() only when invoked directly ('node moc.js') — not when imported` |

Note the existing inaccuracy on line 34 — says "Window 3" but `start-hank.bat:56` actually launches it as Window 6. **Will fix in same edit** (cosmetic, identical-edit cost).

#### C. Cross-reference docs that are still authoritative (SHOULD update)

| File:Line | Context |
|---|---|
| `HANK-BRIEFING.md:12` | `- moc.js           — MOC/MOO imbalance engine` (also has stale description) |
| `HANK-BRIEFING.md:27` | `Window 3: node moc.js` (also wrong window number) |
| `hank-electron-r3.html:1511` | `<span class="svc-name">moc.js</span>` — live dashboard service label |
| `hank-electron-r3.html:3061` | `<span class="s-lbl">moc.js</span>` — live dashboard label |
| `moo-moc.js:11, 17, 20, 31, 209, 253` | comments naming `moc.js` as the consumer (e.g. `// Also write moc-data.json for moc.js compatibility`) |
| `moo-moc.js:182` | `// Approx share count (SPY ~$500 reference) — used by moc.js scoreConviction` |

#### D. Historical / snapshot docs (DO NOT update)

These reference `moc.js` because that was the filename at the time the doc was written. Updating them would falsify the historical record.

| File | Why preserved |
|---|---|
| `services-audit-2026-05-09.md` | The audit captured a snapshot of the codebase on 2026-05-09 when the file was still `moc.js`. References stay accurate to the audit's timestamp. |
| `ledger-fix-plan.md` | Same — investigation plan written when filename was `moc.js`. |
| `levels-race-fix-plan.md` | Doesn't actually reference `moc.js` (only `moo-moc.js`); noise match in the grep. |

#### E. Files NOT touched (out of scope)

| File | Reason |
|---|---|
| `_archive/2026-05-09-orphans/*` | Archived. Updating archived files defeats the archive. |
| `hank-electron-r2.html` | Older dashboard; r3 is the live one. Updating r2 adds noise without value. |
| `electron-plan.md:84-85` | Future-state plan doc with a service-name → script map. Borderline; recommend leaving for now to keep diff scoped. Mentioning as a follow-up. |
| `.claude/settings.local.json` | AI tool-permission cache. Pre-approval entries auto-rebuild on next use. Touching this file shouldn't be part of an engineering change. |
| `monitor.js:1583` | Reference is to `moo-moc.js`, not `moc.js`. False-positive in grep. |

### Header comment correction (the actual `news.js → moo-moc.js` fix)

**Current text (moc.js line 30):**
```
 *   moc-data.json  written by news.js when FJ MOC alert fires
```

**Corrected text:**
```
 *   moc-data.json  written by moo-moc.js when FJ MOC alert fires
```

**Justification:**
- `moo-moc.js:211` is the only active writer of `moc-data.json` (verified via `Grep "writeFileSync\([^)]*MOC_DATA"`).
- `news.js` has a `parseMOC()` function but **never calls writeFileSync for moc-data.json** (audit § 1.2 confirmed; the `news-moc-patch.js` example was never applied to `news.js` and is now archived under `_archive/2026-05-09-orphans/`).
- Aside from the news.js → moo-moc.js fix, **no other content edits to the header are proposed** — the architecture diagram, gates list, re-score loop, and Data section structure all stay intact.

### Confirmation: `moc-data.json` writer is `moo-moc.js`

```
moo-moc.js:211     writeFileSync(MOC_DATA_PATH, payload);     ← only active writer
_archive/.../news-moc-patch.js:90     ← archived patch, never applied
_test_moc_e2e.js:92     ← test fixture, not production
```

Single live writer confirmed.

---

## A) Rename approach

### Mechanical

```bash
git mv moc.js moc-engine.js
```

`git mv` preserves history (the file's commit log will continue under the new name; `git log --follow moc-engine.js` shows the full history including everything before the rename).

### Files needing reference updates after the rename

**Active code (4 files):**

1. **`start-hank.bat:56`** — change:
   ```
   ... && node moc.js"
   ```
   to:
   ```
   ... && node moc-engine.js"
   ```
   Also update the echo banner from `HANK MOC ENGINE` (already says "ENGINE", still accurate) — no echo change needed.

2. **`_test_moc_route.js:13`** — change:
   ```js
   import { mocOrderToConsensus, buildOrder } from './moc.js';
   ```
   to:
   ```js
   import { mocOrderToConsensus, buildOrder } from './moc-engine.js';
   ```
   Plus comment updates at lines 2 and 74 (cosmetic).

3. **`_test_moc_e2e.js:137`** — change:
   ```js
   const moc = await import('./moc.js');
   ```
   to:
   ```js
   const moc = await import('./moc-engine.js');
   ```
   Plus comment updates at lines 3, 120, 121, 124, 131, 140, 147, 183 (cosmetic).

4. **`moc-engine.js`** (renamed file) — internal references on lines 3, 30, 34, 338, 339, 345, 549, 612, 793. The line-30 update is the substantive header correction (B below); the others are cosmetic filename references.

**Doc files (3 files):**

5. **`HANK-BRIEFING.md:12, 27`** — operator handoff doc. Update name + window number.
6. **`hank-electron-r3.html:1511, 3061`** — live dashboard service labels. Update for visual accuracy.
7. **`moo-moc.js:11, 17, 20, 31, 182, 209, 253`** — moo-moc.js's comments reference `moc.js` as the downstream consumer. Update for doc accuracy.

### Files specifically NOT updated (with rationale)

- **`services-audit-2026-05-09.md`** — historical audit snapshot. References stay accurate to the audit's date.
- **`ledger-fix-plan.md`** — historical investigation plan. Same rationale.
- **`hank-electron-r2.html`** — superseded by r3. Updating dead UI adds churn.
- **`electron-plan.md`** — design doc; deferred to a future cleanup pass.
- **`_archive/2026-05-09-orphans/*`** — archived files; updating them defeats the archive.
- **`.claude/settings.local.json`** — AI permission cache; auto-rebuilds.

---

## B) Header comment correction

**Single substantive line change** in the renamed file's header:

**Before (line 30):**
```
 *   moc-data.json  written by news.js when FJ MOC alert fires
```

**After:**
```
 *   moc-data.json  written by moo-moc.js when FJ MOC alert fires
```

**No other content rewrites in the header.** The architecture diagram, gate list, re-score logic description, and Data section structure are preserved as-is. The only other touches in the header block are the consequential filename updates from § A above (lines 3 and 34 — `moc.js` → `moc-engine.js`).

---

## C) Single-commit execution order

1. `git mv moc.js moc-engine.js` — preserves git history.
2. Edit `moc-engine.js`:
   a. Line 3: `moc.js` → `moc-engine.js` (header self-identification)
   b. **Line 30: `news.js` → `moo-moc.js`** (the actual content correction)
   c. Line 34: `node moc.js   (Window 3, alongside monitor.js + news.js)` → `node moc-engine.js   (Window 6, alongside monitor.js + moo-moc.js)`
   d. Lines 338, 339, 345, 549, 612, 793: filename references in code comments → `moc-engine.js`
3. Edit `start-hank.bat:56`: `node moc.js` → `node moc-engine.js`.
4. Edit `_test_moc_route.js:13` (import) + comments at 2, 74.
5. Edit `_test_moc_e2e.js:137` (dynamic import) + comments at 3, 120, 121, 124, 131, 140, 147, 183.
6. Edit `HANK-BRIEFING.md:12, 27`.
7. Edit `hank-electron-r3.html:1511, 3061`.
8. Edit `moo-moc.js:11, 17, 20, 31, 182, 209, 253`.
9. `node --check moc-engine.js _test_moc_route.js _test_moc_e2e.js moo-moc.js` — verify all parse.
10. `node _test_moc_route.js` — unit tests still pass after the rename.
11. `node _test_moc_e2e.js` — e2e test still passes (verifies the dynamic import with the new filename works).
12. `git status` — confirm only the expected files are modified.
13. Single commit covering all of the above.

---

## D) Risk assessment

### What breaks if we rename without updating `start-hank.bat`?

Window 6 fails to launch Monday morning with `Error: Cannot find module 'moc.js'`. The other 7 windows still start. Operator immediately sees the failure. Recovery: edit start-hank.bat or rename back. Detectable in seconds.

### What breaks if a test file or doc reference is missed?

- **`_test_moc_route.js` import not updated:** test fails with module-not-found. Visible immediately when the test runs.
- **`_test_moc_e2e.js` dynamic import not updated:** test crashes with module-not-found at runtime. Visible immediately when the test runs.
- **`HANK-BRIEFING.md` not updated:** operator handoff doc references the old name. Cosmetic; doesn't break anything operational.
- **`hank-electron-r3.html` not updated:** dashboard shows the wrong filename in the service-status panel. Cosmetic; doesn't break functionality.
- **`moo-moc.js` comments not updated:** internal documentation accuracy degrades. No runtime impact.

### Mitigation

- The execution order (§ C) updates active code FIRST, then docs.
- Step 9 runs `node --check` on every active file touched.
- Steps 10-11 re-run both test scripts to confirm imports resolve.
- Step 12 reviews `git status` before commit — any unexpected diff aborts the commit.

### How to verify the rename didn't break the ledger fix tests

After the rename:

- **`node _test_moc_route.js`** must still print `30/30 passed`. The test imports `mocOrderToConsensus` and `buildOrder` — those exports survive the rename. If the test fails with `Cannot find module './moc.js'`, the import path wasn't updated.
- **`node _test_moc_e2e.js`** must still print `24/24 passed`. The test does `await import('./moc.js')` — needs path update. After update: same backup/restore cycle, same assertions, all green.

If either test regresses, abort and fix before committing.

---

## E) Test plan

After all edits complete, run from project root:

```powershell
node --check moc-engine.js
node --check _test_moc_route.js
node --check _test_moc_e2e.js
node --check moo-moc.js
node _test_moc_route.js          # expected: 30/30 passed
node _test_moc_e2e.js            # expected: 24/24 passed
```

**`start-hank.bat` dry-run** — open the file in an editor and confirm Window 6 reads `node moc-engine.js`. Do NOT actually run start-hank.bat (would launch all 8 services). Resolution check only:

```powershell
$bat = Get-Content start-hank.bat -Raw
$matches = [regex]::Matches($bat, 'node\s+([\w\-\.]+\.js)')
foreach ($m in $matches) {
  $script = $m.Groups[1].Value
  Test-Path $script ? "✓ $script" : "✗ MISSING $script"
}
```

Expected: 8/8 ✓ including `moc-engine.js` (and NOT `moc.js`).

**Live verification deferred to Monday's session** — start-hank.bat boots cleanly, Window 6 logs the new banner, MOC engine runs through the 15:45-15:59 cycle without "module not found" errors.

---

## Summary

- **One file renamed:** `moc.js` → `moc-engine.js` (via `git mv`, history preserved).
- **One substantive comment fix:** line 30, `news.js` → `moo-moc.js`.
- **Cosmetic filename updates** in 7 other files (3 active code, 4 docs).
- **Zero behavior changes.** The renamed file behaves identically; the test scripts run identically; the launcher targets the new path.
- **Held for investigation per audit § 5:** `flow.js`, `alpaca.js`. Untouched.

Awaiting approval before any code changes.
