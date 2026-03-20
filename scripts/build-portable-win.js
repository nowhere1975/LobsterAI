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

// Signal to electron-builder-hooks to skip openclaw runtime check
process.env.LOBSTERAI_PORTABLE_BUILD = '1';

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const UNPACKED_DIR = path.join(RELEASE_DIR, 'win-unpacked');
const BAT_SRC = path.join(__dirname, 'portable-assets', '启动.bat');
const BAT_DST = path.join(UNPACKED_DIR, '启动.bat');
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

// ── 2. 启动.bat ──────────────────────────────────────────────────────────────
console.log('\n=== Step 2: Write 启动.bat ===');
fs.copyFileSync(BAT_SRC, BAT_DST);
console.log(`Written: ${BAT_DST}`);

// ── 3. data/ directory ───────────────────────────────────────────────────────
console.log('\n=== Step 3: Create data/ directory ===');
fs.mkdirSync(DATA_DIR, { recursive: true });
// Write a placeholder so git/zip doesn't skip the empty dir
fs.writeFileSync(path.join(DATA_DIR, '.gitkeep'), '');
console.log(`Created: ${DATA_DIR}`);

// ── 4. Zip via PowerShell ────────────────────────────────────────────────────
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
