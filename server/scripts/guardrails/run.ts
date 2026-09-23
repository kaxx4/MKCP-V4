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
const modes = ["--static", "--sandbox", "--pull", "--calibrate"].filter((f) => args.has(f));
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
        lib.check("TG-P05", filedConfigured, "MKCP_FILED_THROUGH is not set in server/.env on this machine — filed-period protection is OFF (the guard only warns)");
        const { runStatic } = await import("./static.js");
        await runStatic({ replay: !args.has("--no-replay") });
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
