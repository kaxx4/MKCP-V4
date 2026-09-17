/**
 * Every report in the catalogue, fetched and parsed, with its rows shown.
 *
 * The point is not "did it return bytes" — it is "are the rows the report's
 * own figures". Each one prints its first rows so a wrong tag or a misread
 * amount is visible rather than averaged away.
 *
 *   npx tsx scripts/fidelity/verify-reports.ts            # the quick ones
 *   npx tsx scripts/fidelity/verify-reports.ts --slow     # include the >60s four
 */
import { REPORTS, fetchReport } from "../../src/services/tallyReports.js";
import { U, company } from "./harness.js";

const WITH_SLOW = process.argv.includes("--slow");
const PERIOD = { from: "2026-04-01", to: "2026-09-30" };

(async () => {
  const co = await company();
  console.log(`\ncompany  ${co}\nperiod   ${PERIOD.from} → ${PERIOD.to}\n`);
  let ok = 0, bad = 0;
  for (const def of REPORTS) {
    if (def.slow && !WITH_SLOW) { console.log(`  ·  ${def.key.padEnd(18)} skipped (slow — pass --slow)`); continue; }
    try {
      const r = await fetchReport(U, co, def, PERIOD);
      const empty = r.rows.length === 0;
      console.log(`\n${empty ? "  !" : "  ok"} ${def.key.padEnd(18)} ${String(r.rows.length).padStart(5)} rows  ${String(Math.round(r.bytes/1024)).padStart(5)} KB  ${String(r.elapsedMs).padStart(6)} ms`);
      for (const row of r.rows.slice(0, 3)) {
        const shown = Object.entries(row)
          .filter(([, v]) => v !== null && v !== "" )
          .map(([k, v]) => `${k}=${String(v).slice(0, 24)}`).join("  ");
        console.log(`       ${shown.slice(0, 150)}`);
      }
      empty ? bad++ : ok++;
    } catch (e) {
      console.log(`\n  ✗ ${def.key.padEnd(18)} ${(e as Error).message.slice(0, 90)}`);
      bad++;
    }
  }
  console.log(`\n  ${ok} reports returned rows, ${bad} did not\n`);
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });
