/**
 * On a sandbox machine (MKCP_TALLY_ROLE=sandbox) the push path writes to ONE
 * company only: the practice (dummy) company named by MKCP_PRACTICE_COMPANY.
 * Any other company is refused before a single byte of XML is built or sent.
 *
 * PURE — contacts neither Tally nor Supabase. It checks the decision.
 *
 *   npx tsx scripts/test-practice-company.ts
 */
import { refuseCompanyWrite, practiceCompany } from "../src/services/tallyRole.js";

let passed = 0, failed = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`    \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; failures.push(label); console.log(`    \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
};
const H = (s: string) => console.log(`\n\x1b[1m── ${s} ${"─".repeat(Math.max(0, 56 - s.length))}\x1b[0m`);

const PRACTICE = "PRACTICE DUMMY CO";

/** Run fn with the given role and practice-company env, restoring afterwards. */
const withEnv = <T>(role: string | undefined, practice: string | undefined, fn: () => T): T => {
  const prevRole = process.env.MKCP_TALLY_ROLE;
  const prevPractice = process.env.MKCP_PRACTICE_COMPANY;
  const set = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  set("MKCP_TALLY_ROLE", role);
  set("MKCP_PRACTICE_COMPANY", practice);
  try { return fn(); } finally {
    set("MKCP_TALLY_ROLE", prevRole);
    set("MKCP_PRACTICE_COMPANY", prevPractice);
  }
};

console.log(`\n\x1b[1mThe practice-company check\x1b[0m`);

H("ON THE SANDBOX LAPTOP");
ok("a non-practice company is refused",
  withEnv("sandbox", PRACTICE, () => refuseCompanyWrite("M.K.CYCLES (P) LTD. - (from 1-Apr-26)")) !== null);
ok("an unrelated company is refused",
  withEnv("sandbox", PRACTICE, () => refuseCompanyWrite("SOME OTHER COMPANY")) !== null);
ok("a near-miss name is refused (Tally names are exact)",
  withEnv("sandbox", PRACTICE, () => refuseCompanyWrite("PRACTICE DUMMY CO.")) !== null);
ok("the practice company passes",
  withEnv("sandbox", PRACTICE, () => refuseCompanyWrite(PRACTICE)) === null);
ok("surrounding whitespace on the practice name still passes",
  withEnv("sandbox", PRACTICE, () => refuseCompanyWrite(`  ${PRACTICE}  `)) === null);
ok("a sandbox with no practice company set refuses everything (fail closed)",
  withEnv("sandbox", undefined, () => refuseCompanyWrite(PRACTICE)) !== null);
ok("a blank practice company counts as unset",
  withEnv("sandbox", "   ", () => refuseCompanyWrite(PRACTICE)) !== null);

H("ON THE PRIMARY (REAL) MACHINE");
ok("primary passes any company (existing behaviour)",
  withEnv("primary", undefined, () => refuseCompanyWrite("M.K.CYCLES (P) LTD. - (from 1-Apr-26)")) === null);
ok("unset role passes any company (default is primary)",
  withEnv(undefined, undefined, () => refuseCompanyWrite("ANY COMPANY")) === null);

H("THE REFUSAL SAYS WHY");
const msg = withEnv("sandbox", PRACTICE, () => refuseCompanyWrite("WRONG CO")) ?? "";
ok("the refusal names the company it refused", msg.includes("WRONG CO"));
ok("the refusal names the setting that governs it", msg.includes("MKCP_PRACTICE_COMPANY"));
const unset = withEnv("sandbox", undefined, () => refuseCompanyWrite(PRACTICE)) ?? "";
ok("an unset practice company says so", unset.includes("MKCP_PRACTICE_COMPANY"));

H("READING THE SETTING");
ok("practiceCompany() returns the trimmed name", withEnv("sandbox", "  X Y  ", () => practiceCompany()) === "X Y");
ok("practiceCompany() returns null when unset", withEnv("sandbox", undefined, () => practiceCompany()) === null);

/* The real write paths. Refusal must come back BEFORE any request is made, so the
   Tally URL here is a dead local port: if a refusal leaked through, the call would
   fail with a network error instead of the company message. */
const DEAD_TALLY = "http://127.0.0.1:1";

async function writePaths(): Promise<void> {
  H("THE WRITE PATHS REFUSE BEFORE TOUCHING TALLY");
  const { safePush } = await import("../src/services/safePush.js");
  const { deleteLedger } = await import("../src/services/masterPusher.js");

  const sp = await withEnv("sandbox", PRACTICE, () =>
    safePush(DEAD_TALLY, "WRONG CO", { voucherType: "Sales", date: "2026-04-01" } as any));
  ok("safePush refuses a non-practice company", sp.ok === false && sp.stage === "guard");
  ok("safePush's refusal names the company",
    sp.errors.some((e) => e.includes("WRONG CO") && e.includes("practice company")),
    sp.errors[0] ?? "(no error)");
  ok("safePush sends nothing (no network error in its result)",
    !sp.errors.some((e) => /ECONNREFUSED|fetch failed|connect/i.test(e)));

  const dl = await withEnv("sandbox", PRACTICE, () => deleteLedger(DEAD_TALLY, "WRONG CO", "ANY LEDGER"));
  ok("deleteLedger refuses a non-practice company", dl.ok === false);
  ok("deleteLedger's refusal says why",
    dl.notes.some((n) => n.includes("practice company")), dl.notes[0] ?? "(no note)");
}

(async () => {
  await writePaths();
  console.log(`\n\x1b[1m${passed} passed · ${failed} failed\x1b[0m`);
  if (failed) console.log(`\nfailed:\n${failures.map((f) => `  · ${f}`).join("\n")}`);
  console.log();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
