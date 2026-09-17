#!/usr/bin/env node
// scripts/test.js – Unit tests

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
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

test('electron.js loads the server in-process, never by spawning a binary', () => {
  const content = readFileSync('public/electron.js', 'utf8');
  // This asserted utilityProcess.fork() for a design that was never shipped —
  // it has been failing since before the file-transfer work, against code that
  // is correct. What it was really guarding is the SECOND assertion: on Windows,
  // process.execPath is the Electron binary, not Node, so spawning it relaunches
  // the whole app instead of starting the server. That trap is real and stays.
  assert(
    /require\(\s*serverDist\s*\)/.test(content),
    'electron.js must require() the built server bundle directly into the main process'
  );
  assert(
    !content.includes('process.execPath'),
    'electron.js must NOT use process.execPath (spawns the Electron binary, not Node)'
  );
  assert(
    !content.includes('utilityProcess.fork'),
    'the server runs in-process; reintroducing a child process needs the packaging and .env story revisited'
  );
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

// ── Escaping damage ────────────────────────────────────────────────────────
/**
 * A literal newline, tab or backspace inside a single-quoted string.
 *
 * This has now happened four times in this project, and it is always the same
 * mechanism: a file edited through a shell heredoc, where `\n` in the tool's
 * own string became a REAL newline in the source, and `\b` became a backspace.
 *
 * What makes it worth a build check rather than more care is how it fails.
 * A backspace inside a regex — `/\b(CGST|SGST)\b/` becoming a control
 * character — still compiles, still runs, and silently matches nothing: one of
 * those shipped live in the web app's voucher builder. A real newline inside a
 * quoted string is louder (it does not parse), but it lands as "Unterminated
 * string literal" at a line number that reveals nothing about the cause, which
 * is how it cost time on the go-live check.
 *
 * The web app has had this guard since the second occurrence. This repo did
 * not, which is why the fourth one landed here.
 */
test('no stray control characters in source strings', () => {
  const offenders = [];
  const roots = ['server/src', 'scripts', 'src'];

  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
      } else if (/\.(ts|tsx|js|mjs|mts)$/.test(entry.name)) {
        const lines = readFileSync(full, 'utf8').split('\n');
        lines.forEach((line, i) => {
          // \b (0x08), \f (0x0c) and \v (0x0b) have no business in source at
          // all. A stray \r is normal on Windows and is not the bug.
          if (/[\x08\x0b\x0c]/.test(line)) {
            offenders.push(`${full}:${i + 1} — control character in source`);
          }
        });
      }
    }
  };

  roots.forEach(walk);
  assert(
    offenders.length === 0,
    `control characters found (almost certainly a heredoc turning \\b or \\n into the real thing):\n  ${offenders.join('\n  ')}`
  );
});

// ── The money path ─────────────────────────────────────────────────────────
test('pushAgent never retries a rejection Tally answered', () => {
  // A source-level guard, and only that: this repo has no way to run the agent
  // against a fake Tally, so nothing here proves the behaviour. What it does
  // prove is that the rule has not been quietly reverted.
  //
  // The rule: retries are for SILENCE (socket, timeout, Tally busy) — those
  // throw, and the catch block still retries them. A rejection that safePush
  // RETURNS is a verdict on an identical payload, so repeating it can only
  // repeat the verdict. Live evidence: Payments "1867/26-27" and "1853/26-27"
  // each burned all five attempts on the same duplicate-number rejection, and
  // "CHQ-545/26-27" burned three on a party ledger that does not exist.
  const src = readFileSync('server/src/services/pushAgent.ts', 'utf8');
  assert(
    !/res\.stage\s*===\s*"verify"\s*\?\s*job\.max_attempts\s*:\s*newAttempts/.test(src),
    'pushAgent is retrying answered rejections again — only the verify stage was being exhausted'
  );
  assert(
    /await fail\(job, job\.max_attempts, why, result\);/.test(src),
    'the !res.ok branch must exhaust the retry budget: Tally already gave its answer'
  );
  assert(
    /await fail\(job, newAttempts, e\?\.message \?\? String\(e\), null\);/.test(src),
    'the catch block must KEEP retrying — a thrown error is silence, not a verdict'
  );
});

// ── Results ────────────────────────────────────────────────────────────────
console.log(`\n${YELLOW}═══════════════════════════════════════${RESET}`);
console.log(` Results: ${GREEN}${passed} passed${RESET}  ${RED}${failed} failed${RESET}`);
console.log(`${YELLOW}═══════════════════════════════════════${RESET}\n`);

if (failed > 0) process.exit(1);
