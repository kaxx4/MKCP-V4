/**
 * Offline proof for review item 12 of thread 8: a live rig can no longer exit 0 after an error or a missing check.
 *   npx tsx scripts/test-rig-exit.ts
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { leftoverCheck, recordError, rigExitCode, rigSummary, type RigCheck } from "./rigs/rigExit.js";

let passed = 0, failed = 0;
const ok = (name: string, cond: boolean) => { if (cond) passed++; else { failed++; console.log(`FAIL ${name}`); } };
const pass = (n: string): RigCheck => ({ name: n, ok: true, detail: "" });
const fail = (n: string): RigCheck => ({ name: n, ok: false, detail: "" });

ok("all expected checks passed exits 0", rigExitCode([pass("a"), pass("b")], 2) === 0);
ok("one failed check exits 1", rigExitCode([pass("a"), fail("b")], 2) === 1);
ok("FEWER passes than expected exits 1 even with no failed check (the old rule said 0)", rigExitCode([pass("a")], 6) === 1);
ok("no checks at all exits 1", rigExitCode([], 6) === 1);
ok("MORE passes than expected exits 1 (the expected count is a fact to keep in step)", rigExitCode([pass("a"), pass("b"), pass("c")], 2) === 1);

const r: RigCheck[] = [pass("latency")];
recordError(r, new Error("socket closed"));
ok("an error in the body becomes a failed check", r.length === 2 && r[1].ok === false && r[1].detail === "socket closed");
ok("after an error the exit is 1 even if the rest passed", rigExitCode([...r, pass("x"), pass("y"), pass("z"), pass("w"), pass("v")], 6) === 1);
recordError(r, "plain text");
ok("a thrown string is recorded too", r[2].detail === "plain text");

ok("a read error on what is left fails the check, never counts as zero", leftoverCheck("left", { count: null, error: { message: "timeout" } }).ok === false);
ok("an empty count fails", leftoverCheck("left", { count: null, error: null }).ok === false);
ok("zero left passes", leftoverCheck("left", { count: 0, error: null }).ok === true);
ok("three left fails", leftoverCheck("left", { count: 3, error: null }).ok === false);
ok("the summary names a shortfall", /only 1 of the 6 expected/.test(rigSummary([pass("a")], 6)));
ok("the summary does not name one when a check failed", !/only/.test(rigSummary([pass("a"), fail("b")], 6)));

// the rig itself uses all of it (a scan, so a later edit that drops the rule is seen offline)
const rig = readFileSync(join(dirname(process.argv[1]), "rigs", "realtime-signals-live.ts"), "utf8");
ok("the realtime rig records a caught error", /catch \(e\) \{\s*recordError\(results, e\)/.test(rig));
ok("the realtime rig exits through rigExitCode with an expected count", /process\.exit\(rigExitCode\(results, EXPECTED_CHECKS\)\)/.test(rig) && /EXPECTED_CHECKS = 6/.test(rig));
ok("the realtime rig no longer ignores a failed read of what is left", /leftoverCheck\(/.test(rig) && !/const \{ data: left \}/.test(rig));

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
