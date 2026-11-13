/**
 * D-M.248 item 3 (runbook M3): seed every voucher series so the first number the new app gives is the next number in Tally.
 * READS Tally (read-only: one request per series, filtered by type) and PRINTS SQL. It writes nothing: the series table refuses writes from the
 * service key (migration 0113), so this is a dry run by design and a person runs the printed statement. The statement does nothing if a row
 * already exists, and an undo statement is printed beside it.
 *
 *   npx tsx scripts/primary-seed-series.ts [--fy 2026-27] [--series-key MKCP] [--company "<name>"] [--min-gap-sec 0]
 *                                          [--empty-ok=<type>]... [--skip-mirror-check]
 *
 * D-M.256 item 11, what it refuses to print a seed for:
 *   - a type whose list in Tally could not be read;
 *   - a type whose list is EMPTY, unless a person passes --empty-ok=<type> (an empty list looks the same as a failed read);
 *   - a type for which the mirror already holds a higher counter than Tally's list reaches (the list is short).
 * The mirror check needs the database. Without it (a sandbox laptop) the check is reported as NOT RUN and the exit is 1 unless a person passes
 * --skip-mirror-check.
 *
 * On the office PC the open company must carry MKCP_PRIMARY_COMPANY_GUID (checked first). On a sandbox laptop it reads the practice company only
 * and says so: the numbers are the dummy's and the SQL must not be run.
 * Exit 0 only when every type has a seed, nothing is refused and nothing warns.
 */
import "dotenv/config";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { takenNumbersOrThrow } from "../src/services/voucherNumbering.js";
import { SERIES_DEFAULTS, seriesCounter } from "../src/services/voucherSeries.js";
import { financialYearOf } from "../src/services/remoteId.js";
import { isSandbox, practiceCompany, practiceGuidProblem } from "../src/services/tallyRole.js";
import { primaryPinProblem, primaryCompanyName, primaryCompanyKey } from "../src/services/primaryMode.js";
import { tallyCompany } from "../src/config/company.js";
import { supabaseClient } from "../src/services/supabaseClient.js";
import { planSeriesSeeds, seedSql, seedRefusals } from "../src/services/primaryTools.js";

const argv = process.argv;
const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const URL_ = process.env.TALLY_URL || "http://localhost:9000";
const gapMs = Math.max(0, Number(arg("--min-gap-sec") ?? 0)) * 1000;
const emptyOk = argv.filter((a) => a.startsWith("--empty-ok=")).map((a) => a.slice("--empty-ok=".length).trim().toLowerCase()).filter(Boolean);
const skipMirror = argv.includes("--skip-mirror-check");
const titleCase = (k: string) => k.split(" ").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

/** The highest counter the mirror holds for each type, or null when the mirror cannot be consulted. */
async function mirrorHighest(companyKey: string, fy: string): Promise<Record<string, number> | null> {
  const c = supabaseClient() as any;
  if (!c) return null;
  const out: Record<string, number> = {};
  for (const [key, d] of Object.entries(SERIES_DEFAULTS)) {
    let best = 0;
    for (let from = 0; ; from += 1000) {
      const { data, error } = await c.from("erp_mirror_rows").select("voucher_number").eq("company_key", companyKey).eq("object", "voucher").eq("is_test", false)
        .ilike("voucher_type", titleCase(key)).range(from, from + 999);
      if (error) return null;
      for (const r of data ?? []) { const n = seriesCounter(r.voucher_number, d.template, fy); if (n !== null && n > best) best = n; }
      if (!data || data.length < 1000) break;
    }
    out[key] = best;
  }
  return out;
}

(async () => {
  const sandbox = isSandbox();
  const company = arg("--company") ?? (sandbox ? practiceCompany() ?? "" : primaryCompanyName() || tallyCompany());
  if (!company) { console.error("No company: set MKCP_PRACTICE_COMPANY (sandbox) or MKCP_PRIMARY_COMPANY."); process.exit(2); }
  const fy = arg("--fy") ?? financialYearOf(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));
  const listing = (await tallyPost(URL_, HEALTH_XML, 10_000, true)) as string;
  const why = sandbox ? practiceGuidProblem(company, listing) : primaryPinProblem(company, listing);
  if (why) { console.error(`${why}\nNothing was read.`); process.exit(2); }
  console.log(sandbox ? "  SANDBOX RUN: the practice company is read (its GUID matches). These numbers are the dummy's; do not run the SQL." : "  the open company carries the pinned GUID");
  console.log(`  reading ${Object.keys(SERIES_DEFAULTS).length} voucher types of ${company}, financial year ${fy} (read-only)\n`);

  const taken: Record<string, string[]> = {};
  const unreadable: string[] = [];
  let first = true;
  for (const key of Object.keys(SERIES_DEFAULTS)) {
    if (!first && gapMs) await new Promise((r) => setTimeout(r, gapMs));
    first = false;
    try { taken[key] = await takenNumbersOrThrow(URL_, company, titleCase(key), (u, x, t, r) => tallyPost(u, x, t, r)); }
    catch (e) { taken[key] = []; unreadable.push(key); console.log(`  ${titleCase(key)}: could not be read (${(e as Error).message.slice(0, 120)})`); }
  }
  const seeds = planSeriesSeeds(taken, fy);

  const companyKey = primaryCompanyKey({ ...process.env, MKCP_PRIMARY_COMPANY: company });
  const mirror = skipMirror ? null : await mirrorHighest(companyKey, fy);
  const refusals = seedRefusals(seeds, { unreadable, emptyOk, mirrorHighest: mirror });
  const refused = new Set(refusals.map((r) => r.voucherType));

  console.log("  type            in Tally   in this series   highest   mirror   next number the counter gives");
  for (const s of seeds) {
    const m = mirror ? String(mirror[s.voucherType.toLowerCase()] ?? "?") : "n/a";
    console.log(`  ${s.voucherType.padEnd(14)}  ${String(s.inTally).padStart(8)}   ${String(s.inSeries).padStart(14)}   ${String(s.highest).padStart(7)}   ${m.padStart(6)}   ${refused.has(s.voucherType) ? "REFUSED" : s.next}${s.warning ? `\n     WARNING: ${s.warning}` : ""}`);
  }
  for (const r of refusals) console.log(`  REFUSED ${r.voucherType}: ${r.reason}`);
  if (mirror === null) console.log(skipMirror ? "  mirror cross-check skipped by --skip-mirror-check" : "  MIRROR CROSS-CHECK NOT RUN: no database on this machine (or the mirror could not be read). Run it where the database is, or pass --skip-mirror-check if a person accepts that.");

  const ok = seeds.filter((s) => !refused.has(s.voucherType));
  if (ok.length) {
    const sql = seedSql(ok, { seriesKey: arg("--series-key") ?? "MKCP", mirrorCompany: company });
    console.log(`\n-- 1. seed (run in the database console; does nothing for a row that already exists)\n${sql.up}\n\n-- 2. read it back: the next_number column must equal the table above\n${sql.check}\n\n-- undo (only while no number has been taken from the series)\n${sql.down}\n`);
  } else console.log("\n  No seed is printed: every type was refused.\n");
  process.exit(refusals.length || seeds.some((s) => s.warning) || (mirror === null && !skipMirror) ? 1 : 0);
})().catch((e) => { console.error(`FAILED: ${(e as Error).message}`); process.exit(2); });
