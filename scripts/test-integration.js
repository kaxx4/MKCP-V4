#!/usr/bin/env node
// scripts/test-integration.js – Integration tests

import { existsSync, readdirSync, statSync } from 'fs';
import { createServer } from 'http';
import { join } from 'path';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

function ok(msg) { console.log(`${GREEN}✓${RESET} ${msg}`); passed++; }
function fail(msg) { console.log(`${RED}✗${RESET} ${msg}`); failed++; }

console.log(`\n${YELLOW}═══════════════════════════════════════════${RESET}`);
console.log(' Integration Tests – MK Cycles Dashboard');
console.log(`${YELLOW}═══════════════════════════════════════════${RESET}\n`);

// Test 1: electron.js syntax check
try {
  // Validate CJS syntax by checking it doesn't contain top-level import/export
  const { readFileSync } = await import('fs');
  const content = readFileSync('public/electron.js', 'utf8');
  if (content.includes('\nimport ') || content.startsWith('import ')) {
    throw new Error('electron.js contains ESM import – should be CJS');
  }
  ok('electron.js is valid CJS (no top-level imports)');
} catch (err) {
  fail(`electron.js validation: ${err.message}`);
}

// Test 2: preload.js syntax check
try {
  const { readFileSync } = await import('fs');
  const content = readFileSync('public/preload.js', 'utf8');
  if (content.includes('\nimport ') || content.startsWith('import ')) {
    throw new Error('preload.js contains ESM import – should be CJS');
  }
  ok('preload.js is valid CJS');
} catch (err) {
  fail(`preload.js validation: ${err.message}`);
}

// Test 3: server/dist completeness
try {
  const required = ['index.js'];
  const missing = required.filter((f) => !existsSync(join('server/dist', f)));
  if (missing.length > 0) throw new Error(`Missing: ${missing.join(', ')}`);
  ok('server/dist has required files');
} catch (err) {
  fail(`server/dist incomplete: ${err.message}`);
}

// Test 4: dist/ frontend completeness
try {
  if (!existsSync('dist/index.html')) throw new Error('dist/index.html missing');
  if (!existsSync('dist/assets')) throw new Error('dist/assets/ missing');
  ok('dist/ frontend complete');
} catch (err) {
  fail(`dist/ incomplete: ${err.message}`);
}

// Test 5: Port 3101 availability (integration server test)
await new Promise((resolve) => {
  const testServer = createServer((req, res) => res.end('ok'));
  testServer.listen(3101, () => {
    ok('Port 3101 available for test');
    testServer.close(resolve);
  });
  testServer.on('error', () => {
    fail('Port 3101 in use – another process may be running');
    resolve();
  });
});

// Test 6: Installer check (if already built)
try {
  const outDir = 'release';
  if (existsSync(outDir)) {
    const files = readdirSync(outDir);
    const exe = files.find((f) => f.endsWith('.exe'));
    if (exe) {
      const sizeMB = (statSync(join(outDir, exe)).size / 1024 / 1024).toFixed(1);
      ok(`Installer found: ${exe} (${sizeMB} MB)`);
    } else {
      ok('release/ exists (no .exe yet – run: node scripts/build-prod.js)');
    }
  } else {
    ok('Installer not yet built (run: node scripts/build-prod.js)');
  }
} catch (err) {
  fail(`Installer check failed: ${err.message}`);
}

// ── Results ────────────────────────────────────────────────────────────────
console.log(`\n${YELLOW}═══════════════════════════════════════════${RESET}`);
console.log(` Results: ${GREEN}${passed} passed${RESET}  ${RED}${failed} failed${RESET}`);
console.log(`${YELLOW}═══════════════════════════════════════════${RESET}\n`);

if (failed > 0) process.exit(1);
