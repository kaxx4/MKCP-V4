/**
 * Did anything I verified this session actually reach the mirror?
 *
 * `MKCP_TALLY_ROLE=sandbox` makes `supabaseClient()` return null, so every
 * write through `SupabaseSync` is a silent no-op. Several verification scripts
 * call `syncMasters`/`syncVouchers` and then COUNT rows with a direct client —
 * which counts rows that were already there and reports them as landed.
 *
 * That is the exact shape of failure this project keeps hitting: a green check
 * that observed nothing. So: read the mirror directly and say what is really
 * in it, with no write in between.
 *
 *   npx tsx server/scripts/check-mirror-truth.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { createClient } from "@supabase/supabase-js";
import { isOffline, offlineReason } from "../src/services/supabaseClient.js";

const COMPANY = process.env.TALLY_COMPANY || "";
const SB_URL = process.env.SUPABASE_URL!;
const SB_KEY = (process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY)!;

const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

/**
 * Columns whose emptiness can be an EMPTY STRING rather than a null.
 *
 * The `neq(col, "")` probe below is only meaningful for TEXT. Applied to an
 * integer column it compares a number to a string, matches nothing, and reports
 * "non-null but EMPTY STRING" on perfectly good data — which is exactly what it
 * did for master_id and alter_id, nearly producing the conclusion that Phase
 * 2.2 had not landed when it had (master_id 247956, alter_id 352333 are real).
 *
 * A diagnostic that cries wolf is worse than no diagnostic, so the check now
 * only runs where it means something.
 */
const TEXT_COLUMNS = new Set([
  "costing_method", "valuation_method", "state", "phone", "remote_id", "irn",
]);

async function col(table: string, column: string): Promise<{ nonNull: number; total: number; nonEmpty: number }> {
  const { count: total } = await sb.from(table).select("*", { count: "exact", head: true }).eq("company", COMPANY);
  const { count: nonNull } = await sb.from(table)
    .select("*", { count: "exact", head: true }).eq("company", COMPANY).not(column, "is", null);
  if (!TEXT_COLUMNS.has(column)) {
    // Not text: "non-empty" is not a question that can be asked, so non-null is
    // the whole answer rather than a suspiciously low second number.
    return { nonNull: nonNull ?? 0, total: total ?? 0, nonEmpty: nonNull ?? 0 };
  }
  const { count: nonEmpty } = await sb.from(table)
    .select("*", { count: "exact", head: true }).eq("company", COMPANY).not(column, "is", null).neq(column, "");
  return { nonNull: nonNull ?? 0, total: total ?? 0, nonEmpty: nonEmpty ?? 0 };
}

async function main(): Promise<void> {
  console.log("\n  WHAT IS REALLY IN THE MIRROR");
  console.log("  " + "─".repeat(68));
  console.log(`  company: ${COMPANY}`);
  console.log(`  this process writes to Supabase: ${isOffline() ? `NO — ${offlineReason()}` : "yes"}`);
  console.log(`  (so anything below was written by some EARLIER run, not by this one)\n`);

  const rows: [string, string][] = [
    ["tally_stock_items", "costing_method"],
    ["tally_stock_items", "valuation_method"],
    ["tally_ledgers", "state"],
    ["tally_ledgers", "phone"],
    ["tally_vouchers", "master_id"],
    ["tally_vouchers", "alter_id"],
    ["tally_vouchers", "remote_id"],
    ["tally_vouchers", "irn"],
  ];

  console.log(`  ${"table.column".padEnd(38)} ${"non-null".padStart(9)} ${"non-empty".padStart(10)} ${"of".padStart(7)}`);
  console.log("  " + "─".repeat(68));
  for (const [t, c] of rows) {
    try {
      const r = await col(t, c);
      const flag = r.nonNull > 0 && r.nonEmpty === 0 ? "  <-- non-null but EMPTY STRING" : "";
      console.log(`  ${`${t}.${c}`.padEnd(38)} ${String(r.nonNull).padStart(9)} ${String(r.nonEmpty).padStart(10)} ${String(r.total).padStart(7)}${flag}`);
    } catch (e: any) {
      console.log(`  ${`${t}.${c}`.padEnd(38)} ERROR ${e.message.slice(0, 40)}`);
    }
  }

  // When was each table last written?
  console.log("\n  Last synced_at per table (who wrote last, and when):");
  for (const t of ["tally_stock_items", "tally_ledgers", "tally_vouchers"]) {
    const { data } = await sb.from(t).select("synced_at").eq("company", COMPANY)
      .order("synced_at", { ascending: false }).limit(1);
    console.log(`  ${t.padEnd(24)} ${data?.[0]?.synced_at ?? "—"}`);
  }

  console.log("\n  " + "─".repeat(68));
  console.log("  A column showing non-null but zero non-empty was never really filled;");
  console.log("  a check that only asks \"is it null\" reports it as landed.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
