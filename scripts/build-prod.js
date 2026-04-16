#!/usr/bin/env node
// scripts/build-prod.js – Production installer builder

import { execSync, execFileSync } from 'child_process';
import { existsSync, readdirSync, statSync, rmSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { readFileSync } from 'fs';

const ROOT = process.cwd();
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

function step(msg) { console.log(`\n${CYAN}▶ ${msg}${RESET}`); }
function ok(msg) { console.log(`${GREEN}✓${RESET} ${msg}`); }
function fail(msg) { console.error(`${RED}✗ ${msg}${RESET}`); }
function warn(msg) { console.warn(`${YELLOW}⚠${RESET} ${msg}`); }

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit', ...opts });
    return true;
  } catch {
    fail(`Command failed: ${cmd}`);
    if (opts.critical !== false) process.exit(1);
    return false;
  }
}

/** Read output dir from electron-builder.json5 (strips comments) */
function getOutputDir() {
  try {
    const raw = readFileSync(join(ROOT, 'electron-builder.json5'), 'utf8');
    // Strip // comments then parse
    const stripped = raw.replace(/\/\/[^\n]*/g, '');
    const cfg = JSON.parse(stripped);
    return cfg?.directories?.output ?? 'release';
  } catch {
    return 'release';
  }
}

/** Try to clear the output directory, with retries for locked files */
async function clearOutputDir(outDir) {
  if (!existsSync(outDir)) return; // Nothing to clear

  const asar = join(outDir, 'win-unpacked', 'resources', 'app.asar');
  if (!existsSync(asar)) {
    // No asar — try normal delete
    try { rmSync(outDir, { recursive: true, force: true }); } catch {}
    return;
  }

  // asar exists — Windows Defender may lock it briefly; retry with delays
  console.log(`  Clearing previous build (may take a moment if Defender scans it)...`);
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      rmSync(asar, { force: true });
      rmSync(outDir, { recursive: true, force: true });
      console.log(`  ${GREEN}✓${RESET} Previous build cleared`);
      return;
    } catch (err) {
      if (attempt < 8) {
        process.stdout.write(`  Attempt ${attempt}/8 — file locked, retrying in 3s...\r`);
        await new Promise(r => setTimeout(r, 3000));
      } else {
        // Last resort: rename the old dir out of the way
        const backup = outDir + '_old';
        try {
          if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
          renameSync(outDir, backup);
          warn(`Could not delete locked build — moved to ${backup}_old`);
        } catch {
          fail(`Cannot clear ${outDir}: ${err.message}`);
          fail('Close any running MK Cycles Dashboard instances and retry.');
          process.exit(1);
        }
      }
    }
  }
}

async function main() {
  console.log(`\n${YELLOW}════════════════════════════════════════${RESET}`);
  console.log('  MK Cycles Dashboard – Production Build');
  console.log(`${YELLOW}════════════════════════════════════════${RESET}\n`);

  const outputDir = getOutputDir();

  // Step 0: Clear previous build (handles locked app.asar)
  step('Clearing previous build output...');
  await clearOutputDir(join(ROOT, outputDir));

  // Step 1: Ensure server has ALL deps (including @types/* needed for tsc)
  step('Installing server dependencies (including dev for build)...');
  run('npm install', { cwd: join(ROOT, 'server') });
  ok('Server dependencies ready');

  // Step 2: Build React frontend
  step('Building React frontend...');
  run('npm run build');
  if (!existsSync(join(ROOT, 'dist/index.html'))) {
    fail('dist/index.html not created');
    process.exit(1);
  }
  ok('React frontend built → dist/');

  // Step 3: Build Express server (needs @types/* from step 1)
  step('Building Express server...');
  run('npm run build:server');
  if (!existsSync(join(ROOT, 'server/dist/index.js'))) {
    fail('server/dist/index.js not created');
    process.exit(1);
  }
  ok('Express server built → server/dist/');

  // Step 4: Run electron-builder
  step('Building Electron installer...');
  run('npx electron-builder --win --config electron-builder.json5');

  // Step 5: Verify output
  step('Verifying output...');
  const outDir = join(ROOT, outputDir);
  if (!existsSync(outDir)) {
    fail(`${outputDir}/ not created`);
    process.exit(1);
  }

  const files = readdirSync(outDir);
  const exe = files.find((f) => f.endsWith('.exe'));

  if (!exe) {
    fail(`No .exe file in ${outputDir}/`);
    process.exit(1);
  }

  const stats = statSync(join(outDir, exe));
  const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
  ok(`Installer created: ${exe} (${sizeMB} MB)`);

  console.log(`\n${GREEN}════════════════════════════════════════${RESET}`);
  console.log(`  ✅ BUILD COMPLETE`);
  console.log(`  📦 ${outputDir}/${exe}`);
  console.log(`  📏 ${sizeMB} MB`);
  console.log(`${GREEN}════════════════════════════════════════${RESET}\n`);
}

main().catch((err) => {
  fail(`Build failed: ${err.message}`);
  process.exit(1);
});
