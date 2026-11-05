/**
 * Rebuild task 0-2 (T-1, T-3): the read-only modes of the Tally scripts must
 * not refuse on a PRIMARY machine; only their write modes may.
 *
 * The defect: find-stranded-test-vouchers.ts, roundtrip-verify.ts and
 * fidelity-vs-native.ts called guardScriptWrites() at module top level. So on
 * the office machine (role primary) the read-only verifier tally-verify-all.ts,
 * which imports `census` from find-stranded, refused before its preflight, and
 * the dry-run / profile-only modes of the other two refused as well. It never
 * shows on this sandbox laptop, and the role is never flipped to see it.
 *
 * So each check runs in a CHILD process whose environment alone says
 * MKCP_TALLY_ROLE=primary. No mock transport is installed (a mock makes the
 * gate allow everything, which would hide the defect). TALLY_URL points at a
 * port nothing listens on and MKCP_OFFLINE=true, so even a script that runs
 * reaches neither Tally nor Supabase. A read mode may then fail to connect;
 * what it must not do is print REFUSED or exit 2 on the gate.
 *
 *   npx tsx scripts/test-read-modes-on-primary.ts
 */
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const TSX = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");
const DEAD = "http://127.0.0.1:9001";   // nothing listens here; checked when this was written (5-Nov-2026)

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${detail && !cond ? `\n      ${detail}` : ""}`);
  if (cond) pass++; else fail++;
}

interface Run { code: number | null; out: string }
function child(args: string[]): Run {
  const env = { ...process.env, MKCP_TALLY_ROLE: "primary", TALLY_URL: DEAD, MKCP_OFFLINE: "true" };
  const r = spawnSync(process.execPath, [TSX, ...args], { cwd: join(here, ".."), env, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const refused = (r: Run) => /REFUSED \(/.test(r.out);
const tail = (r: Run) => `exit ${r.code}: ${r.out.replace(/\s+/g, " ").trim().slice(0, 200)}`;

/** Load a module the way tally-verify-all does, and nothing else. */
function importOnly(script: string): Run {
  const url = pathToFileURL(join(here, script)).href;
  const code = `void (async () => { await import(${JSON.stringify(url)}); console.log("IMPORTED"); process.exit(0); })();`;
  return child(["--eval", code]);
}

console.log("\n  READ MODES ON A PRIMARY MACHINE (child processes only)\n");
ok("tsx is installed where the child expects it", existsSync(TSX), TSX);

// ── T-1: the census import that tally-verify-all makes ─────────────────────
{
  const r = importOnly("find-stranded-test-vouchers.ts");
  ok("importing find-stranded-test-vouchers (for its census) does not refuse", !refused(r) && r.code === 0 && /IMPORTED/.test(r.out), tail(r));
}
{
  const r = child(["scripts/find-stranded-test-vouchers.ts"]);
  ok("find-stranded list mode (no --delete) does not refuse", !refused(r) && r.code !== 2, tail(r));
}
{
  const r = child(["scripts/find-stranded-test-vouchers.ts", "--delete"]);
  ok("find-stranded --delete still refuses on primary (exit 2)", refused(r) && r.code === 2, tail(r));
}

// ── T-3: dry-run and profile-only modes ────────────────────────────────────
{
  const r = child(["scripts/roundtrip-verify.ts"]);
  ok("roundtrip-verify dry run (no --push) does not refuse", !refused(r) && r.code !== 2, tail(r));
}
{
  const r = child(["scripts/roundtrip-verify.ts", "--push"]);
  ok("roundtrip-verify --push still refuses on primary (exit 2)", refused(r) && r.code === 2, tail(r));
}
{
  const r = child(["scripts/fidelity-vs-native.ts", "SALES"]);
  ok("fidelity-vs-native profile only (no --push) does not refuse", !refused(r) && r.code !== 2, tail(r));
}
{
  const r = child(["scripts/fidelity-vs-native.ts", "SALES", "--push"]);
  ok("fidelity-vs-native --push still refuses on primary (exit 2)", refused(r) && r.code === 2, tail(r));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
