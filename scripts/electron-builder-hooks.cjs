'use strict';

const path = require('path');
const { existsSync, readdirSync, statSync, mkdirSync, readFileSync, rmSync } = require('fs');
const { spawnSync } = require('child_process');
const { ensurePortablePythonRuntime, checkRuntimeHealth } = require('./setup-python-runtime.js');
const { packMultipleSources } = require('./pack-openclaw-tar.cjs');

function isWindowsTarget(context) {
  return context?.electronPlatformName === 'win32';
}

function isMacTarget(context) {
  return context?.electronPlatformName === 'darwin';
}

function resolveTargetArch(context) {
  if (context?.arch === 3) return 'arm64';
  if (context?.arch === 0) return 'ia32';
  if (context?.arch === 1) return 'x64';
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'ia32') return 'ia32';
  return 'x64';
}

function findPackagedBash(appOutDir) {
  const candidates = [
    path.join(appOutDir, 'resources', 'mingit', 'bin', 'bash.exe'),
    path.join(appOutDir, 'resources', 'mingit', 'usr', 'bin', 'bash.exe'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function verifyPackagedPortableGitRuntimeDirs(appOutDir) {
  const requiredDirs = [
    path.join(appOutDir, 'resources', 'mingit', 'dev', 'shm'),
    path.join(appOutDir, 'resources', 'mingit', 'dev', 'mqueue'),
  ];
  const createdDirs = [];

  for (const dir of requiredDirs) {
    if (existsSync(dir)) continue;
    mkdirSync(dir, { recursive: true });
    createdDirs.push(dir);
  }

  const missingDirs = requiredDirs.filter((dir) => !existsSync(dir));
  if (missingDirs.length > 0) {
    throw new Error(
      'Windows package is missing required PortableGit runtime directories. '
      + `Missing: ${missingDirs.join(', ')}`
    );
  }

  if (createdDirs.length > 0) {
    console.log(
      '[electron-builder-hooks] Created missing PortableGit runtime directories: '
      + createdDirs.join(', ')
    );
  }

  console.log(
    '[electron-builder-hooks] Verified PortableGit runtime directories: '
    + requiredDirs.join(', ')
  );
}

function findPackagedPythonExecutable(appOutDir) {
  const candidates = [
    path.join(appOutDir, 'resources', 'python-win', 'python.exe'),
    path.join(appOutDir, 'resources', 'python-win', 'python3.exe'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function applyMacIconFix(appPath) {
  console.log('[electron-builder-hooks] Applying macOS icon fix for Apple Silicon compatibility...');

  const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist');
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');
  const iconPath = path.join(resourcesPath, 'icon.icns');

  if (!existsSync(infoPlistPath)) {
    console.warn(`[electron-builder-hooks] Info.plist not found at ${infoPlistPath}`);
    return;
  }

  if (!existsSync(iconPath)) {
    console.warn(`[electron-builder-hooks] icon.icns not found at ${iconPath}`);
    return;
  }

  // Check if CFBundleIconName already exists
  const checkResult = spawnSync('plutil', [
    '-extract', 'CFBundleIconName', 'raw', infoPlistPath
  ], { encoding: 'utf-8' });

  if (checkResult.status !== 0) {
    // CFBundleIconName doesn't exist, add it
    console.log('[electron-builder-hooks] Adding CFBundleIconName to Info.plist...');
    const addResult = spawnSync('plutil', [
      '-insert', 'CFBundleIconName', '-string', 'icon', infoPlistPath
    ], { encoding: 'utf-8' });

    if (addResult.status === 0) {
      console.log('[electron-builder-hooks] ✓ CFBundleIconName added successfully');
    } else {
      console.warn('[electron-builder-hooks] Failed to add CFBundleIconName:', addResult.stderr);
    }
  } else {
    console.log('[electron-builder-hooks] ✓ CFBundleIconName already present');
  }

  // Clear extended attributes
  spawnSync('xattr', ['-cr', appPath], { encoding: 'utf-8' });

  // Touch the app to update modification time
  spawnSync('touch', [appPath], { encoding: 'utf-8' });
  spawnSync('touch', [resourcesPath], { encoding: 'utf-8' });

  console.log('[electron-builder-hooks] ✓ macOS icon fix applied');
}

/**
 * Check if a command exists in the system PATH.
 */
function hasCommand(command) {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checker, [command], { stdio: 'ignore' });
  return result.status === 0;
}

/**
 * Install dependencies for all skills in the SKILLs directory.
 * This ensures bundled skills include node_modules for users without npm.
 */
function installSkillDependencies() {
  // Check if npm is available (should be available during build)
  if (!hasCommand('npm')) {
    console.warn('[electron-builder-hooks] npm not found in PATH, skipping skill dependency installation');
    console.warn('[electron-builder-hooks]   (This is only a warning - skills will be installed at runtime if needed)');
    return;
  }

  const skillsDir = path.join(__dirname, '..', 'SKILLs');
  if (!existsSync(skillsDir)) {
    console.log('[electron-builder-hooks] SKILLs directory not found, skipping skill dependency installation');
    return;
  }

  console.log('[electron-builder-hooks] Installing skill dependencies...');

  const entries = readdirSync(skillsDir);
  let installedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const entry of entries) {
    const skillPath = path.join(skillsDir, entry);
    const stat = statSync(skillPath);
    if (!stat.isDirectory()) continue;

    const packageJsonPath = path.join(skillPath, 'package.json');
    const nodeModulesPath = path.join(skillPath, 'node_modules');

    if (!existsSync(packageJsonPath)) {
      continue; // No package.json, skip
    }

    if (existsSync(nodeModulesPath)) {
      console.log(`[electron-builder-hooks]   ${entry}: node_modules exists, skipping`);
      skippedCount++;
      continue;
    }

    console.log(`[electron-builder-hooks]   ${entry}: installing dependencies...`);
    // On Windows, use shell: true so cmd.exe resolves npm.cmd correctly
    const isWin = process.platform === 'win32';
    const result = spawnSync('npm', ['install'], {
      cwd: skillPath,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5 * 60 * 1000, // 5 minute timeout
      shell: isWin,
    });

    if (result.status === 0) {
      console.log(`[electron-builder-hooks]   ${entry}: ✓ installed`);
      installedCount++;
    } else {
      console.error(`[electron-builder-hooks]   ${entry}: ✗ failed`);
      if (result.error) {
        console.error(`[electron-builder-hooks]     Error: ${result.error.message}`);
      }
      if (result.stderr) {
        console.error(`[electron-builder-hooks]     ${result.stderr.substring(0, 200)}`);
      }
      failedCount++;
    }
  }

  console.log(`[electron-builder-hooks] Skill dependencies: ${installedCount} installed, ${skippedCount} skipped, ${failedCount} failed`);
}

async function beforePack(context) {
  // Install skill dependencies first (for all platforms)
  installSkillDependencies();

  if (isWindowsTarget(context)) {
    // Pack resource directories into a single tar for faster NSIS installation.
    // NSIS extracts thousands of small files very slowly on NTFS; a single tar
    // archive is extracted by the unpack script almost instantly.
    const buildTarDir = path.join(__dirname, '..', 'build-tar');
    mkdirSync(buildTarDir, { recursive: true });

    const outputTar = path.join(buildTarDir, 'win-resources.tar');
    const sources = [
      {
        label: 'SKILLs',
        dir: path.join(__dirname, '..', 'SKILLs'),
        prefix: 'SKILLs',
      },
      {
        label: 'Python runtime',
        dir: path.join(__dirname, '..', 'resources', 'python-win'),
        prefix: 'python-win',
      },
    ];

    console.log(`[electron-builder-hooks] Packing combined Windows tar: ${outputTar}`);
    const t0 = Date.now();

    // Remove old tar if exists
    if (existsSync(outputTar)) rmSync(outputTar);

    const { totalFiles, skipped } = packMultipleSources(sources, outputTar);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const sizeMB = (statSync(outputTar).size / (1024 * 1024)).toFixed(1);
    console.log(
      `[electron-builder-hooks] Combined tar packed in ${elapsed}s: `
      + `${totalFiles} files, ${skipped} skipped, ${sizeMB} MB`
    );
  }

  if (!isWindowsTarget(context)) {
    return;
  }

  console.log('[electron-builder-hooks] Windows target detected, ensuring portable Python runtime is prepared...');
  await ensurePortablePythonRuntime({ required: true });
  const runtimeRoot = path.join(__dirname, '..', 'resources', 'python-win');
  const runtimeHealth = checkRuntimeHealth(runtimeRoot, { requirePip: true });
  if (!runtimeHealth.ok) {
    throw new Error(
      'Portable Python runtime health check failed before pack. Missing files: '
      + runtimeHealth.missing.join(', ')
    );
  }

}

async function afterPack(context) {
  if (isMacTarget(context)) {
    const appName = context.packager.appInfo.productFilename;
    const appPath = path.join(context.appOutDir, `${appName}.app`);

    if (existsSync(appPath)) {
      applyMacIconFix(appPath);
    } else {
      console.warn(`[electron-builder-hooks] App not found at ${appPath}, skipping icon fix`);
    }
  }
}

module.exports = {
  beforePack,
  afterPack,
};
