#!/usr/bin/env node
/**
 * hank-preflight.js — bootstrap validator (2026-05-17)
 *
 * Runs before start-hank.bat spawns any HANK windows. Validates that the
 * environment is ready for a clean restart, auto-recovers when possible,
 * surfaces clear actions when human input is required.
 *
 * Exits with code 0 if everything is good to launch.
 * Exits with code 1 if a hard blocker requires operator action.
 * Exits with code 2 if recoverable issues remain after auto-fix.
 *
 * Codified from operator's working Sunday 5/17 manual sequence:
 *   1. Defender exclusions for uv install + cache dirs
 *   2. pip install --force-reinstall uv (when 0-byte uvx detected)
 *   3. Verify uvx.exe size > 0
 *   4. Delete stale ./webull-mcp-conf/token.txt (>14d OR <100 bytes)
 *   5. Verify .env present + Node dotenv works
 *   6. Spawn ask> webull auth flow (operator runs manually after preflight)
 *
 * Usage from start-hank.bat:
 *   node hank-preflight.js
 *   if errorlevel 1 (echo Preflight failed; pause; exit /b 1)
 */

import { existsSync, statSync, readdirSync, unlinkSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import { homedir } from 'os';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const checks = [];
function ok(label, detail = '')  { checks.push({ ok: true,  label, detail }); console.log(`  ${C.green}✓${C.reset} ${label}${detail ? `  ${C.dim}${detail}${C.reset}` : ''}`); }
function warn(label, detail='')  { checks.push({ ok: true,  warn: true, label, detail }); console.log(`  ${C.yellow}⚠${C.reset} ${label}${detail ? `  ${C.dim}${detail}${C.reset}` : ''}`); }
function bad(label, detail='')   { checks.push({ ok: false, label, detail }); console.log(`  ${C.red}✗${C.reset} ${label}${detail ? `  ${C.dim}${detail}${C.reset}` : ''}`); }

console.log(`\n${C.bold}${C.cyan}HANK PREFLIGHT${C.reset}  ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`);
console.log(C.dim + '─'.repeat(70) + C.reset);

// ─── 1. .env present + readable ───────────────────────────
const envPath = join(__dirname, '.env');
if (!existsSync(envPath))         bad('.env file missing', envPath);
else                               ok('.env present', `${statSync(envPath).size} bytes`);

const wblKeys = Object.keys(process.env).filter(k => k.startsWith('WEBULL_'));
if (wblKeys.length === 0)         bad('Node dotenv did NOT load WEBULL_* vars', 'check .env BOM / CRLF / load order');
else                               ok('Node dotenv loaded WEBULL_* vars', `${wblKeys.length} keys: ${wblKeys.slice(0,4).join(',')}${wblKeys.length>4?'…':''}`);

// ─── 2. uvx.exe health (Defender quarantine guard) ────────
function _findUvx() {
  try {
    const cmd = process.platform === 'win32' ? 'where uvx' : 'which uvx';
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const first = out.split(/\r?\n/)[0].trim();
    if (first && existsSync(first)) return first;
  } catch {}
  if (process.platform === 'win32') {
    const home = homedir();
    const localPython = join(home, 'AppData', 'Local', 'Python');
    if (existsSync(localPython)) {
      for (const d of readdirSync(localPython)) {
        if (/^pythoncore-/.test(d)) {
          const p = join(localPython, d, 'Scripts', 'uvx.exe');
          if (existsSync(p)) return p;
        }
      }
    }
  }
  return null;
}
const uvxPath = _findUvx();
if (!uvxPath) bad('uvx not found on PATH or known install locations', 'pip install uv');
else {
  const sz = statSync(uvxPath).size;
  if (sz === 0) {
    bad(`uvx.exe is 0 bytes (Defender quarantine?)`, uvxPath);
    console.log(`     ${C.yellow}→ Attempting auto-recovery: pip install --force-reinstall uv${C.reset}`);
    try {
      const r = spawnSync('pip', ['install', '--force-reinstall', '--quiet', 'uv'], { stdio: 'inherit' });
      const sz2 = statSync(uvxPath).size;
      if (sz2 > 0) ok('uv reinstalled', `${sz2} bytes — exited ${r.status}`);
      else bad('uv reinstall did not restore uvx.exe', `still ${sz2} bytes; Defender may be re-quarantining mid-install`);
    } catch (e) { bad('uv reinstall failed', e.message); }
  } else if (sz < 1000) {
    warn(`uvx.exe is suspiciously small (${sz} bytes)`, uvxPath);
  } else {
    ok('uvx.exe present + non-empty', `${(sz/1024).toFixed(0)} KB @ ${uvxPath}`);
  }
}

// ─── 3. Defender exclusions (advisory; doesn't fix automatically) ─
if (process.platform === 'win32' && uvxPath) {
  try {
    const out = execSync(`powershell -NoProfile -Command "Get-MpPreference | Select-Object -ExpandProperty ExclusionPath"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const exclusions = out.split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(Boolean);
    const scriptsDir = dirname(uvxPath).toLowerCase();
    const uvCacheDir = join(homedir(), 'AppData', 'Local', 'uv').toLowerCase();
    const hasScripts = exclusions.some(p => p === scriptsDir || scriptsDir.startsWith(p + '\\'));
    const hasUvCache = exclusions.some(p => p === uvCacheDir || uvCacheDir.startsWith(p + '\\'));
    if (hasScripts && hasUvCache) ok('Defender exclusions present for uv install + cache');
    else {
      warn('Defender exclusions missing — uvx may get quarantined again',
        `Run as admin PowerShell:\n     Add-MpPreference -ExclusionPath '${dirname(uvxPath)}'; Add-MpPreference -ExclusionPath '${join(homedir(),'AppData','Local','uv')}'`);
    }
  } catch {
    warn('Could not query Defender exclusions (Get-MpPreference threw)', 'AV may not be Defender, or admin required');
  }
}

// ─── 4. Webull MCP token staleness ────────────────────────
const tokenDir  = process.env.WEBULL_TOKEN_DIR || join(__dirname, 'webull-mcp-conf');
const tokenFile = join(tokenDir, 'token.txt');
const STALE_DAYS = 14;
if (!existsSync(tokenFile)) {
  warn('Webull MCP token missing', `${tokenFile} — operator must run \`ask> webull auth\` after HANK starts`);
} else {
  const tStat = statSync(tokenFile);
  const ageMs  = Date.now() - tStat.mtimeMs;
  const ageDays = ageMs / 86400_000;
  const sizeOk = tStat.size >= 100;
  if (!sizeOk || ageDays > STALE_DAYS) {
    const reason = !sizeOk ? `${tStat.size} bytes (too small — likely empty stub)` : `${ageDays.toFixed(1)} days old (>${STALE_DAYS}d stale)`;
    console.log(`  ${C.yellow}⚠ Webull token stale${C.reset}  ${C.dim}${reason}${C.reset}`);
    try { unlinkSync(tokenFile); ok('Stale token deleted', `re-auth required via \`ask> webull auth\` after HANK starts`); }
    catch (e) { bad('Could not delete stale token', e.message); }
  } else {
    ok('Webull MCP token present + fresh', `${ageDays.toFixed(1)} days old, ${tStat.size} bytes`);
  }
}

// ─── 5. Webull app reminder banner (operator can't be checked from here) ─
console.log('');
console.log(`  ${C.yellow}OPERATOR PREREQ${C.reset}`);
console.log(`     ${C.bold}1.${C.reset} Webull mobile app must be OPEN and toggled to PAPER mode`);
console.log(`     ${C.bold}2.${C.reset} Phone unlocked + app foreground (for 2FA push if token is stale)`);
console.log(`     ${C.bold}3.${C.reset} If token was just deleted above: run \`ask> webull auth\` after HANK starts`);

// ─── Roll-up ───────────────────────────────────────────────
console.log('');
console.log(C.dim + '─'.repeat(70) + C.reset);
const fails = checks.filter(c => !c.ok);
const warns = checks.filter(c => c.warn);
if (fails.length === 0) {
  console.log(`${C.green}${C.bold}PREFLIGHT OK${C.reset}  ${checks.length - warns.length}✓ ${warns.length}⚠  →  proceeding to start-hank.bat`);
  process.exit(0);
} else {
  console.log(`${C.red}${C.bold}PREFLIGHT BLOCKED${C.reset}  ${fails.length}✗ ${warns.length}⚠`);
  console.log('  Hard blockers must be resolved before launch:');
  for (const f of fails) console.log(`    - ${f.label}  ${f.detail}`);
  process.exit(1);
}
