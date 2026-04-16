#!/usr/bin/env node
// scripts/setup.js – Environment validation

import { execSync } from 'child_process';
import { existsSync } from 'fs';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function ok(msg) { console.log(`${GREEN}✓${RESET} ${msg}`); }
function fail(msg) { console.error(`${RED}✗${RESET} ${msg}`); }
function warn(msg) { console.warn(`${YELLOW}⚠${RESET} ${msg}`); }

let errors = 0;

// Node.js version
const nodeVer = process.version;
const nodeMaj = parseInt(nodeVer.slice(1));
if (nodeMaj >= 18) {
  ok(`Node.js ${nodeVer}`);
} else {
  fail(`Node.js ${nodeVer} – need 18+`);
  errors++;
}

// npm version
try {
  const npmVer = execSync('npm --version', { encoding: 'utf8' }).trim();
  const npmMaj = parseInt(npmVer);
  if (npmMaj >= 9) ok(`npm ${npmVer}`);
  else warn(`npm ${npmVer} – recommend 9+`);
} catch {
  fail('npm not found');
  errors++;
}

// Required directories
for (const dir of ['src', 'server', 'public']) {
  if (existsSync(dir)) ok(`${dir}/ exists`);
  else { fail(`${dir}/ missing`); errors++; }
}

// Disk space check (approximate via temp write)
try {
  execSync('node -e "require(\'fs\').writeFileSync(\'.__disk_check__\', \'x\')"', { stdio: 'ignore' });
  execSync('node -e "require(\'fs\').unlinkSync(\'.__disk_check__\')"', { stdio: 'ignore' });
  ok('Disk writable');
} catch {
  fail('Disk write failed');
  errors++;
}

if (errors > 0) {
  console.log(`\n${RED}Setup failed with ${errors} error(s). Fix above issues first.${RESET}`);
  process.exit(1);
} else {
  console.log(`\n${GREEN}✓ Environment validated – ready to build.${RESET}`);
}
