/**
 * D-M.248 item 3 (runbook M3): seed every voucher series so the first number the new app gives is the next number in Tally.
 * READS Tally (read-only: one request per series, filtered by type) and PRINTS SQL. It writes nothing: the series table refuses writes from the
 * service key (migration 0113), so this is a dry run by design and a person runs the printed statement. The statement does nothing if a row
 * already exists, and an undo statement is printed beside it.
 *
 *   npx tsx scripts/primary-seed-series.ts [--fy 2026-27] [--series-key MKCP] [--company "<name>"] [--min-gap-sec 0]
 *
 * On the office PC the open company must carry MKCP_PRIMARY_COMPANY_GUID (checked first). On a sandbox laptop it reads the practice company only
 * (the transport's own check) and says so: the numbers are the dummy's and the SQL must not be run.
 */
import "dotenv/config";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { takenNumbersOrThrow } from "../src/services/voucherNumbering.js";
import { SERIES_DEFAULTS } from "../src/services/voucherSeries.js";
import { financialYearOf } from "../src/services/remoteId.js";
import { isSandbox, practiceCompany } from "../src/services/tallyRole.js";
import { primaryPinProblem, primaryCompanyName } from "../src/services/primaryMode.js";
import { tallyCompany } from "../src/config/company.js";
import { planSeriesSeeds, seedSql } from "../src/services/primaryTools.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const URL_ = process.env.TALLY_URL || "http://localhost:9000";
const gapMs = Math.max(0, Number(arg("--min-gap-sec") ?? 0)) * 1000;
const titleCase = (k: string) => k.split(" ").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

(async () => {
  const sandbox = isSandbox();
  const company = arg("--company") ?? (sandbox ? practiceCompany() ?? "" : primaryCompanyName() || tallyCompany());
  if (!company) { console.error("No company: set MKCP_PRACTICE_COMPANY (sandbox) or MKCP_PRIMARY_COMPANY."); process.exit(2); }
  const fy = arg("--fy") ?? financialYearOf(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));
  if (!sandbox) {
    const why = primaryPinProblem(company, (await tallyPost(URL_, HEALTH_XML, 10_000, true)) as string);
    if (why) { console.error(`${why}\nNothing was read.`); process.exit(2); }
    console.log("  the open company carries the pinned GUID");
  } else console.log("  SANDBOX RUN: the practice company is read (the transport checks its GUID). These numbers are the dummy's; do not run the SQL.");
  console.log(`  reading ${Object.keys(SERIES_DEFAULTS).length} voucher types of ${company}, financial year ${fy} (read-only)\n`);

  const taken: Record<string, string[]> = {};
  let first = true;
  for (const key of Object.keys(SERIES_DEFAULTS)) {
    if (!first && gapMs) await new Promise((r) => setTimeout(r, gapMs));
    first = false;
    taken[key] = await takenNumbersOrThrow(URL_, company, titleCase(key), (u, x, t, r) => tallyPost(u, x, t, r));
  }
  const seeds = planSeriesSeeds(taken, fy);
  console.log("  type            in Tally   in this series   highest   next number the counter gives");
  for (const s of seeds) console.log(`  ${s.voucherType.padEnd(14)}  ${String(s.inTally).padStart(8)}   ${String(s.inSeries).padStart(14)}   ${String(s.highest).padStart(7)}   ${s.next}${s.warning ? `\n     WARNING: ${s.warning}` : ""}`);
  const sql = seedSql(seeds, { seriesKey: arg("--series-key") ?? "MKCP", mirrorCompany: company });
  console.log(`\n-- 1. seed (run in the database console; does nothing for a row that already exists)\n${sql.up}\n\n-- 2. read it back: the next_number column must equal the table above\n${sql.check}\n\n-- undo (only while no number has been taken from the series)\n${sql.down}\n`);
  process.exit(seeds.some((s) => s.warning) ? 1 : 0);
})().catch((e) => { console.error(`FAILED: ${(e as Error).message}`); process.exit(2); });
