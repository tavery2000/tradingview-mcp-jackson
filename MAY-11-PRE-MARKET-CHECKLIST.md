# May 11 Pre-Market Operator Checklist

Read this Monday morning before launching `start-hank.bat`.
Wraps the May 9 hygiene work tagged at `may-9-hygiene`.

---

## a) Pre-market sanity checks (run ~08:00 ET)

```powershell
# 1. Working tree clean — no half-finished edits
git status --short
# Expected: only untracked entries (HTML/MD docs, flow.js, alpaca.js).
# NOTHING with " M " (modified tracked) prefix.

# 2. May 9 hygiene work present at HEAD
git log --oneline -1
# Expected: starts with "4af7371" (the rename commit) or anything LATER.

# 3. Tag is reachable for one-command rollback
git tag -l may-9-hygiene
# Expected: prints "may-9-hygiene"

# 4. ASK HANK still works (sanity ping the local-state CLI)
echo help | node ask-cli.js
# Expected: green banner, gray help block, "bye." on exit. No stack trace.

# 5. start-hank.bat references all resolve (no orphans, no archived files)
$bat = Get-Content start-hank.bat -Raw
[regex]::Matches($bat, 'node\s+([\w\-\.]+\.js)') | ForEach-Object {
  $s = $_.Groups[1].Value
  "$(if (Test-Path $s) {'✓'} else {'✗ MISSING'}) $s"
}
# Expected: 8/8 ✓
#   moo-moc.js, monitor.js, monitor-qqq.js, monitor-iwm.js,
#   news.js, moc-engine.js, briefing.js, dashboard-server.js
```

**Known test-pollution issue to fix before live:**

The e2e test `_test_moc_e2e.js` backs up `paper-ledger.json` and the
journal file but does NOT back up `account-tier.json`. Each test run
calls `paperTrading.closePosition(..., $0 P&L)`, which records a "loss"
and increments `consecutiveLosses` in the tier file. Running the test
N times leaves `consecutiveLosses` at N (or higher).

**Reset Monday morning if needed:**

```powershell
# Inspect first
node ask-cli.js  # then type: tier
# Look at "consec L" — should be 0 going into the day

# If it's >0 due to test runs, edit the file directly:
$t = Get-Content account-tier.json | ConvertFrom-Json
$t.consecutiveLosses = 0
$t | ConvertTo-Json | Set-Content account-tier.json -Encoding utf8
```

(The proper fix is to update `_test_moc_e2e.js` to back up `account-tier.json`
in its `filesToProtect` array. Small follow-up; not part of May 9 hygiene.)

---

## b) Behavioral changes to watch for during Monday paper trading

### MOC engine (`moc-engine.js`, formerly `moc.js`)

When the MOC engine fires at 15:50–15:59 ET:

- **Trade now appears in `paper-ledger.json`** as a structured-object entry
  in `trades[]` with `engine: 'MOC'`. Pre-fix it would corrupt the ledger
  with a `.push(order)` against the structured object. Look for:
  ```
  paper-ledger.json → trades[N] → engine: "MOC", status: "OPEN" or "CLOSED"
  ```
- **Trade now appears in `logs/journal/journal-2026-05-11.jsonl`** with two
  records: `type: 'ENTRY'` and `type: 'EXIT'`, both bearing the same
  `requestId`. Pre-fix the MOC engine bypassed the journal entirely.
- **`tag` field on every MOC trade** is `'MOC_ENGINE|NO_EXIT_PRICE'` until
  live exit-chain pricing wires in. The `NO_EXIT_PRICE` marker tells ASK HANK,
  tier rolling-100 stats, and the dashboard to filter these out of P&L
  aggregates. **All MOC trades will show `pnl: 0`** until the follow-up.
- **MOC sizing now obeys tier.** Tier 1 + finalConfidence 0.8 → 1 contract
  via `paperTrading.getPositionSize()`. Pre-fix the MOC engine's
  `CONTRACTS = { 5: 6, 4: 5, 3: 3, 2: 2, 1: 1 }` table fired without tier
  awareness — at conviction 4 it would have placed 5 contracts regardless
  of tier or daily-loss state. New behavior is more conservative and
  correct in the long run; when account tiers up to T2 ($50–100k), MOC
  sizing will scale automatically.

### Levels files

- **`qqq-levels.json` and `iwm-levels.json` now have a single writer**
  (the dedicated monitor for each instrument). `monitor.js` no longer
  cross-writes them.
- **Cold-start gap is ≤36s** (was ≤30s). For roughly the first 30 seconds
  of `start-hank.bat`, `qqq-levels.json` and `iwm-levels.json` may not
  exist yet — until `monitor-qqq.js` / `monitor-iwm.js` complete their
  first poll. ASK HANK and the dashboard return graceful "no data" responses
  during this window. This is unchanged in severity from pre-fix behavior.
- **`todayOpen` field is now correctly refreshed at 09:31 ET** (when the
  open candle prints). Pre-fix `monitor.js`'s cross-writes always set
  `todayOpen: null` because they computed pre-market levels once at
  ~07:00 — masking the dedicated monitor's 09:31 refresh during the
  race window.

### File rename

- **`moc.js` no longer exists.** The file is now `moc-engine.js`. Anything
  that hard-codes the old name (custom scripts, scratch tests, terminal
  history aliases) will fail with `Cannot find module './moc.js'`. The
  fix is to update any such reference to `moc-engine.js`. Active code
  has all been updated; this caveat applies only to ad-hoc scripts.

---

## c) If anything looks wrong

### Quick rollback (whole May 9 hygiene chain)

```powershell
git reset --hard may-9-hygiene^
```

This wipes all 6 hygiene commits in one shot. Working tree returns to
the state immediately before `0b4904f` (the orphan archive).

### Per-task rollback (one specific change)

```powershell
git revert 4af7371   # undo: moc.js → moc-engine.js rename
git revert 48da3bc   # undo: monitor.js cross-write removal
git revert 98e41fc   # undo: ledger schema fix (moc.js → paperTrading routing)
git revert b43f655   # undo: shape-ID tracking
git revert b5d3237   # undo: ASK HANK + audit
git revert 0b4904f   # undo: orphan archive
```

Each revert produces a new commit on top, leaving history intact.

### Re-run the lifecycle tests anytime

```powershell
node _test_moc_route.js   # 30/30 — field mapping
node _test_moc_e2e.js     # 24/24 — end-to-end ledger + journal
```

Both files live in the project root. They back up real state in
`try/finally` blocks and restore on exit (note caveat in section a).

---

## d) Held items still pending (NOT part of May 9 hygiene)

- **`flow.js`** — held for investigation (audit § 5). Service-shaped but
  not in launcher and not imported. Untracked in git.
- **`alpaca.js`** — held for investigation (audit § 5). Reason TBD.
  Untracked in git.
- **Live exit-chain pricing for MOC** — the `NO_EXIT_PRICE` tag exists
  precisely to mark this gap. Either pull a Webull chain quote at
  `hardExit()` time or estimate via delta-1 from live SPY price.
- **Voice bridge (TTS reader)** — Sunday May 17+ work.
- **Electron app build** — Monday afternoon.
- **`_test_moc_e2e.js` should back up `account-tier.json`** — small
  follow-up code change to prevent test-pollution accumulating
  consecutiveLosses on each test run (see section a).
- **`electron-plan.md`** at lines 84-85 still references `moc.js` (the
  old name). Deferred from Task 4-B to keep that diff scoped. Trivial
  fix when next touched.

---

## Tag for forensic reference

```
may-9-hygiene
```

Six commits, six revertable units. Each individual fix can be undone
without disturbing the others.

```
4af7371 Rename moc.js -> moc-engine.js + fix stale header comment
48da3bc Remove monitor.js cross-writes to qqq-levels.json + iwm-levels.json
98e41fc Fix ledger schema race: route MOC trades through paperTrading
b43f655 Shape-ID tracking for FVG/sweep/structure drawings
b5d3237 ASK HANK CLI + May 9 services audit
0b4904f Archive 24 orphan files per services audit
```

Audit source: `services-audit-2026-05-09.md`
Plans:
- `ledger-fix-plan.md`
- `levels-race-fix-plan.md`
- `moc-rename-plan.md`
