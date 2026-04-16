#!/usr/bin/env node
// scripts/test.js – Unit tests

import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

function test(desc, fn) {
  try {
    fn();
    console.log(`${GREEN}✓${RESET} ${desc}`);
    passed++;
  } catch (err) {
    console.log(`${RED}✗${RESET} ${desc}: ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log(`\n${YELLOW}═══════════════════════════════════════${RESET}`);
console.log(' Unit Tests – MK Cycles Dashboard');
console.log(`${YELLOW}═══════════════════════════════════════${RESET}\n`);

// ── File structure ─────────────────────────────────────────────────────────
test('public/electron.js exists', () => assert(existsSync('public/electron.js'), 'Missing'));
test('public/preload.js exists', () => assert(existsSync('public/preload.js'), 'Missing'));
test('public/package.json exists (CJS override)', () => assert(existsSync('public/package.json'), 'Missing'));
test('electron-builder.json5 exists', () => assert(existsSync('electron-builder.json5'), 'Missing'));
test('server/src/index.ts exists', () => assert(existsSync('server/src/index.ts'), 'Missing'));

// ── Built artifacts ────────────────────────────────────────────────────────
test('dist/index.html exists (frontend built)', () => assert(existsSync('dist/index.html'), 'Missing – run: npm run build'));
test('server/dist/index.js exists (server built)', () => assert(existsSync('server/dist/index.js'), 'Missing – run: npm run build:server'));

// ── Config validation ──────────────────────────────────────────────────────
test('vite.config.ts has base: "./"', () => {
  const content = readFileSync('vite.config.ts', 'utf8');
  assert(content.includes('base:') && content.includes('./"'), 'base: "./" missing from vite.config.ts');
});

test('package.json has electron in devDependencies', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert(pkg.devDependencies?.electron, 'electron not found in devDependencies');
});

test('package.json has build:server script', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert(pkg.scripts?.['build:server'], 'build:server script missing');
});

test('electron.js uses utilityProcess.fork (not process.execPath spawn)', () => {
  const content = readFileSync('public/electron.js', 'utf8');
  assert(content.includes('utilityProcess.fork'), 'electron.js must use utilityProcess.fork() to start the server');
  assert(!content.includes('process.execPath'), 'electron.js must NOT use process.execPath (spawns Electron binary, not Node)');
});

test('preload.js uses contextBridge', () => {
  const content = readFileSync('public/preload.js', 'utf8');
  assert(content.includes('contextBridge'), 'contextBridge missing from preload.js');
});

// ── TypeScript ─────────────────────────────────────────────────────────────
test('TypeScript compiles without errors', () => {
  try {
    execSync('npx tsc --noEmit', { stdio: 'pipe' });
  } catch (e) {
    throw new Error('tsc --noEmit failed:\n' + e.stdout?.toString());
  }
});

// ── Results ────────────────────────────────────────────────────────────────
console.log(`\n${YELLOW}═══════════════════════════════════════${RESET}`);
console.log(` Results: ${GREEN}${passed} passed${RESET}  ${RED}${failed} failed${RESET}`);
console.log(`${YELLOW}═══════════════════════════════════════${RESET}\n`);

if (failed > 0) process.exit(1);
