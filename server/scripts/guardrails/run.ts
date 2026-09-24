/**
 * Tally guardrails — one entry point for the push and pull guardrail checks.
 *
 *   npx tsx server/scripts/guardrails/run.ts --static    builder + guard over fixtures, no Tally
 *                                              [--no-replay]  skip replaying real push_queue payloads
 *   npx tsx server/scripts/guardrails/run.ts --sandbox   push MKCP|GUARD vouchers to the SANDBOX Tally, one at a
 *                                                        time, left in place; audit EVERY voucher dated today
 *   npx tsx server/scripts/guardrails/run.ts --calibrate the shape checks over HAND-TYPED sandbox vouchers
 *                                                        (read-only) — is the instrument right?
 *   npx tsx server/scripts/guardrails/run.ts --pull      READ-ONLY mirror audit vs Tally's own reports
 *                                              [--refresh-reports]  ask the office agent for fresh snapshots first
 *
 *   npx tsx server/scripts/guardrails/run.ts --simulate  the WEB app's payloads through guard → builder → safePush into
 *                                                        a simulated Tally (tallyMock), silent failures included
 *   npx tsx server/scripts/guardrails/run.ts --g7        pull-side fetch lists name every field their parsers read;
 *                                                        TDL filters escaped; ALLLEDGERENTRIES summed alone
 *   npx tsx server/scripts/guardrails/run.ts --suites    every offline assertion script (test-*.ts), as child processes
 *
 * ONE COMMAND, OFFLINE (any machine, no Tally, no Supabase write):
 *   MKCP_TALLY_ROLE=sandbox npx tsx server/scripts/guardrails/run.ts --offline
 *     = --static --no-replay, --simulate, --g7, --suites
 *
 * ONE COMMAND, LIVE (the SANDBOX PC only, TallyPrime open on localhost:9000):
 *   MKCP_TALLY_ROLE=sandbox npx tsx server/scripts/guardrails/run.ts --live
 *     = the offline set, then --sandbox, --calibrate, --pull, and the live
 *       suites (test-push-guard --push, test-edge-cases,
 *       test-push-fidelity-sandbox --push). Refuses unless role=sandbox.
 *
 * With no flag, runs --static then --pull. Prints PASS / FAIL / UNVERIFIED per
 * guardrail ID (catalogue.ts; long form in the vault: 07_Systems/Contracts/
 * Tally Guardrails — Push and Pull.md). Exit 1 if any guardrail FAILs.
 *
 * Never pushes to the office Tally: --sandbox refuses unless
 * MKCP_TALLY_ROLE=sandbox and TALLY_URL is localhost:9000.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", "..", ".env"), quiet: true } as Parameters<typeof config>[0]);

const args = new Set(process.argv.slice(2));
const OFFLINE_SET = ["--static", "--simulate", "--g7", "--suites"];
if (args.has("--offline")) { OFFLINE_SET.forEach((f) => args.add(f)); args.add("--no-replay"); }
if (args.has("--live")) {
  if ((process.env.MKCP_TALLY_ROLE ?? "").trim().toLowerCase() !== "sandbox") {
    console.error("\n  REFUSED — --live pushes test vouchers; run it only on the sandbox PC with MKCP_TALLY_ROLE=sandbox.\n");
    process.exit(2);
  }
  [...OFFLINE_SET, "--sandbox", "--calibrate", "--pull", "--live-suites"].forEach((f) => args.add(f));
}
const modes = ["--static", "--simulate", "--g7", "--suites", "--sandbox", "--calibrate", "--pull", "--live-suites"].filter((f) => args.has(f));
if (!modes.length) modes.push("--static", "--pull");

(async () => {
  // pushGuard freezes MKCP_FILED_THROUGH at import. Remember whether it was
  // CONFIGURED before giving the static checks a boundary to test against.
  const filedConfigured = !!(process.env.MKCP_FILED_THROUGH ?? "").trim();
  if (!filedConfigured) process.env.MKCP_FILED_THROUGH = "2026-08-31";
  const lib = await import("./lib.js");
  let fails = 0;
  for (const mode of modes) {
    lib.resetResults();
    try {
      if (mode === "--static") {
        // Machine configuration, not code: in --offline (a cloud box with no
        // server/.env) it cannot be judged, so it is reported, not failed.
        if (filedConfigured) lib.check("TG-P05", true, "");
        else if (args.has("--offline") && !args.has("--live")) lib.unverified("TG-P05", "MKCP_FILED_THROUGH is not set here — check server/.env on the office and sandbox PCs (filed-period protection is OFF without it)");
        else lib.check("TG-P05", false, "MKCP_FILED_THROUGH is not set in server/.env on this machine — filed-period protection is OFF (the guard only warns)");
        const { runStatic } = await import("./static.js");
        await runStatic({ replay: !args.has("--no-replay") });
      } else if (mode === "--simulate") {
        const { runSimulate } = await import("./simulate.js");
        await runSimulate();
      } else if (mode === "--g7") {
        const { runG7 } = await import("./g7.js");
        await runG7();
      } else if (mode === "--suites" || mode === "--live-suites") {
        const { runSuites } = await import("./suites.js");
        fails += runSuites(mode === "--live-suites" ? "live" : "offline");
        continue;
      } else if (mode === "--calibrate") {
        const { runCalibrate } = await import("./calibrate.js");
        await runCalibrate();
      } else if (mode === "--sandbox") {
        const { runSandbox } = await import("./sandbox.js");
        await runSandbox();
      } else {
        const { runPull } = await import("./pull.js");
        await runPull({ refreshReports: args.has("--refresh-reports") });
      }
    } catch (e) {
      console.error(`\n${mode} could not run: ${(e as Error).message}`);
      fails++;
    }
    fails += lib.report(mode.slice(2));
  }
  process.exit(fails ? 1 : 0);
})();
