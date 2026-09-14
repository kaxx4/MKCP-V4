/**
 * The guard that keeps a duplicate company from writing to the real mirror.
 *
 * PURE — touches nothing. It exercises the decision, not the effect, because
 * the effect is "real business data is silently destroyed" and that is not
 * something to demonstrate in order to test it.
 *
 * ── What it is guarding ───────────────────────────────────────────────────
 *
 * Two machines share one Supabase project. The real books run on the owner's
 * other computer; this repo also runs against a DUPLICATE company — and a Tally
 * duplicate carries the SAME NAME as the original, which is the only key the
 * mirror has. So both machines write the same rows.
 *
 *   · a scheduled sync from the copy overwrites the real company's vouchers
 *   · the push agent on the copy claims real jobs from the shared push_queue
 *     and books them into the COPY, where they are lost, while the queue row
 *     reads "succeeded"
 *
 * The second is the bad one: an invoice raised on the web app would simply
 * never appear in the real books, and nothing anywhere would say so.
 *
 *   npx tsx scripts/test-tally-role.ts
 */
/* dotenv first: this script asks what THIS machine will actually do when the
   agent starts on it, which means reading the real .env rather than a fixture. */
import "dotenv/config";
import { tallyRole, isSandbox, refuseSharedWrite } from "../src/services/tallyRole.js";

let passed = 0, failed = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`    \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; failures.push(label); console.log(`    \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
};
const H = (s: string) => console.log(`\n\x1b[1m── ${s} ${"─".repeat(Math.max(0, 56 - s.length))}\x1b[0m`);

const withRole = <T>(v: string | undefined, fn: () => T): T => {
  const prev = process.env.MKCP_TALLY_ROLE;
  if (v === undefined) delete process.env.MKCP_TALLY_ROLE;
  else process.env.MKCP_TALLY_ROLE = v;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.MKCP_TALLY_ROLE;
    else process.env.MKCP_TALLY_ROLE = prev;
  }
};

console.log(`\n\x1b[1mThe sandbox guard\x1b[0m`);

H("DECLARING A COPY");
ok("sandbox is recognised", withRole("sandbox", () => tallyRole()) === "sandbox");
ok("and refuses a shared write", withRole("sandbox", () => refuseSharedWrite("test")) === true);
ok("case and whitespace do not defeat it",
  withRole("  SANDBOX  ", () => isSandbox()) === true);

H("THE DEFAULT IS PRIMARY, DELIBERATELY");
/* Defaulting to safe would silently stop the REAL machine syncing the moment
   this shipped — a worse failure than the one being prevented, and far harder
   to notice. A copy is the unusual case and declares itself. */
ok("unset means primary", withRole(undefined, () => tallyRole()) === "primary");
ok("primary allows shared writes", withRole(undefined, () => refuseSharedWrite("test")) === false);
ok("an explicit primary allows them too", withRole("primary", () => refuseSharedWrite("test")) === false);
ok("an unrecognised value is treated as primary, not silently blocked",
  withRole("banana", () => tallyRole()) === "primary");

H("THIS MACHINE, AS CONFIGURED");
const here = tallyRole();
ok("this machine declares itself a sandbox", here === "sandbox",
  `MKCP_TALLY_ROLE=${process.env.MKCP_TALLY_ROLE ?? "(unset)"}`);
if (here !== "sandbox") {
  console.log(`\n    \x1b[31mIf this machine holds a DUPLICATE company, set MKCP_TALLY_ROLE=sandbox`);
  console.log(`    in server/.env before starting the agent.\x1b[0m`);
}

console.log(`\n\x1b[1m${passed} passed · ${failed} failed\x1b[0m`);
if (failed) console.log(`\nfailed:\n${failures.map((f) => `  · ${f}`).join("\n")}`);
console.log();
process.exit(failed ? 1 : 0);
