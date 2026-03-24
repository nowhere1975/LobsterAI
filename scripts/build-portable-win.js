#!/usr/bin/env node
/**
 * build-portable-win.js
 *
 * Builds a Windows portable zip:
 *   release/AI助手-portable-win.zip
 *
 * Steps:
 *   1. Run electron-builder --win --dir --x64
 *   2. Write 启动.bat into the unpacked directory
 *   3. Create an empty data/ directory
 *   4. Zip the unpacked directory via PowerShell (no extra npm deps needed)
 */

'use strict';

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const tar = require('tar');

// Signal to electron-builder-hooks to skip openclaw runtime check
process.env.LOBSTERAI_PORTABLE_BUILD = '1';

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const UNPACKED_DIR = path.join(RELEASE_DIR, 'win-unpacked');
const DATA_DIR = path.join(UNPACKED_DIR, 'data');
const ZIP_NAME = 'AI助手-portable-win.zip';
const ZIP_PATH = path.join(RELEASE_DIR, ZIP_NAME);

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

// ── 1. electron-builder ──────────────────────────────────────────────────────
console.log('\n=== Step 1: electron-builder --win --dir --x64 ===');
run('npx electron-builder --win --dir --x64');

if (!fs.existsSync(UNPACKED_DIR)) {
  console.error(`ERROR: Expected unpacked dir not found: ${UNPACKED_DIR}`);
  process.exit(1);
}

// ── 1b. Extract win-resources.tar into resources/ ────────────────────────────
// NSIS installer normally extracts this tar; portable builds must do it here.
// Skip cfmind/ (openclaw) — only extract SKILLs/ and python-win/.
console.log('\n=== Step 1b: Extract win-resources.tar ===');
const TAR_PATH = path.join(UNPACKED_DIR, 'resources', 'win-resources.tar');
const RESOURCES_DIR = path.join(UNPACKED_DIR, 'resources');
if (fs.existsSync(TAR_PATH)) {
  tar.extract({
    file: TAR_PATH,
    cwd: RESOURCES_DIR,
    sync: true,
    filter: (p) => !p.startsWith('cfmind/') && !p.startsWith('cfmind\\'),
  });
  fs.unlinkSync(TAR_PATH);
  console.log('Extracted SKILLs/ and python-win/ from tar, removed tar.');
} else {
  console.warn('WARNING: win-resources.tar not found — SKILLs/Python may be missing.');
}

// ── 1c. Copy SKILLs directly from project source (belt-and-suspenders) ───────
// Tar extraction may omit SKILLs if tar.replace has prefix issues.
// Always sync directly from the project SKILLs/ directory to be safe.
console.log('\n=== Step 1c: Sync SKILLs/ from project source ===');
const SKILLS_SRC = path.join(ROOT, 'SKILLs');
const SKILLS_DST = path.join(RESOURCES_DIR, 'SKILLs');
if (fs.existsSync(SKILLS_SRC)) {
  if (fs.existsSync(SKILLS_DST)) {
    // Skills already exist from tar extraction — overwrite to ensure freshness
    fs.rmSync(SKILLS_DST, { recursive: true, force: true });
  }
  fs.cpSync(SKILLS_SRC, SKILLS_DST, { recursive: true });
  const skillCount = fs.readdirSync(SKILLS_DST).filter(
    f => fs.statSync(path.join(SKILLS_DST, f)).isDirectory()
  ).length;
  console.log(`Synced ${skillCount} skill(s) from ${SKILLS_SRC} to ${SKILLS_DST}`);
} else {
  console.warn('WARNING: SKILLs source not found at', SKILLS_SRC);
}

// ── 1d. Pre-install moments-card Playwright + Chromium ───────────────────────
// Installs into the unpacked skills dir so the portable package is self-contained.
// PLAYWRIGHT_BROWSERS_PATH points inside the skill dir — capture.js auto-detects it.
console.log('\n=== Step 1d: Pre-install moments-card Playwright + Chromium ===');
const mcSkillDir = path.join(SKILLS_DST, 'moments-card');
if (fs.existsSync(mcSkillDir)) {
  const mcBrowsersDir = path.join(mcSkillDir, 'playwright-browsers');
  try {
    run('npm install --prefer-offline', { cwd: mcSkillDir });
    run('npx playwright install chromium', {
      cwd: mcSkillDir,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: mcBrowsersDir },
    });
    console.log('moments-card: Playwright + Chromium installed at', mcBrowsersDir);
  } catch (e) {
    console.warn('WARNING: moments-card Playwright install failed:', e.message);
    console.warn('Users will need to run: cd moments-card && npm install && npx playwright install chromium');
  }
} else {
  console.warn('WARNING: moments-card skill dir not found, skipping Playwright install.');
}

// ── 2. data/ directory ───────────────────────────────────────────────────────
console.log('\n=== Step 2: Create data/ directory ===');
fs.mkdirSync(DATA_DIR, { recursive: true });
// .portable marker: app detects portable mode by its presence (more reliable than env var)
fs.writeFileSync(path.join(DATA_DIR, '.portable'), '');
// .gitkeep so zip doesn't skip the directory
fs.writeFileSync(path.join(DATA_DIR, '.gitkeep'), '');
console.log(`Created: ${DATA_DIR}`);

// ── 3. Zip via PowerShell ────────────────────────────────────────────────────
console.log(`\n=== Step 4: Compress to ${ZIP_NAME} ===`);

// Remove existing zip if present
if (fs.existsSync(ZIP_PATH)) {
  fs.unlinkSync(ZIP_PATH);
}

// PowerShell Compress-Archive supports Unicode paths
const psCmd = [
  'powershell.exe',
  '-NonInteractive',
  '-Command',
  `Compress-Archive -Path '${UNPACKED_DIR}\\*' -DestinationPath '${ZIP_PATH}' -Force`,
].join(' ');

const result = spawnSync('powershell.exe', [
  '-NonInteractive',
  '-Command',
  `Compress-Archive -Path '${UNPACKED_DIR}\\*' -DestinationPath '${ZIP_PATH}' -Force`,
], { stdio: 'inherit', cwd: ROOT });

if (result.status !== 0) {
  console.error('ERROR: PowerShell Compress-Archive failed.');
  console.error('You can manually zip the contents of:', UNPACKED_DIR);
  process.exit(1);
}

console.log(`\n✓ Done: ${ZIP_PATH}`);
console.log(`  Size: ${(fs.statSync(ZIP_PATH).size / 1024 / 1024).toFixed(1)} MB`);
