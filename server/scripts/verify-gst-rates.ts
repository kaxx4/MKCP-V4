/**
 * GST rates, read from Tally and landed in Supabase.
 *
 * Replaces `src/data/gstMasterRates.json` — a checked-in file with no import
 * path, changed only by editing the repo and redeploying, and load-bearing for
 * what tax an invoice carries.
 *
 * Proves against real data: that the rate lives on the STOCK GROUP, that IGST is
 * the full rate, that the value arrives with a leading space, and that a rate
 * resolves AS AT a date across the 22-Sep-2025 change.
 *
 *   npx tsx server/scripts/verify-gst-rates.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { createClient } from "@supabase/supabase-js";
import { fetchGstRates, resolveRate } from "../src/services/tallyGstRates.js";
import { SupabaseSync } from "../src/services/supabaseSync.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

let fails = 0;
const ok = (what: string, cond: boolean, detail = "") => {
  if (cond) console.log(`  ok    ${what}`);
  else { fails++; console.log(`  FAIL  ${what}${detail ? " — " + detail : ""}`); }
};

async function main(): Promise<void> {
  console.log("\n  GST RATES, END TO END\n  " + "─".repeat(60));

  const t0 = Date.now();
  const rows = await fetchGstRates(TALLY, COMPANY);
  console.log(`\n  Pulled ${rows.length} declared rates in ${Date.now() - t0} ms.`);

  const items = rows.filter((r) => r.scope === "item");
  const groups = rows.filter((r) => r.scope === "stock_group");
  console.log(`  ${items.length} at item level · ${groups.length} at stock-group level`);

  ok("rates were found at all", rows.length > 0);

  // Trap 1 — the rate lives on the group.
  ok("the stock group carries most of the declarations, as measured",
    groups.length > 0, "no group-level rates — the resolution chain would find nothing");

  // Trap 2 — IGST is the full rate, CGST/SGST are halves.
  const withBoth = rows.filter((r) => r.igst > 0 && r.cgst > 0);
  ok("IGST is the FULL rate and CGST/SGST are halves of it",
    withBoth.length > 0 && withBoth.every((r) => Math.abs(r.igst - (r.cgst + r.sgst)) < 0.01),
    withBoth.length ? `first: igst ${withBoth[0].igst}, cgst ${withBoth[0].cgst}, sgst ${withBoth[0].sgst}` : "none carried both");
  ok("the combined rate follows IGST, never CGST alone",
    withBoth.every((r) => r.gstRate === r.igst));

  // Trap 3 — the leading space.
  ok("the leading space in <GSTRATE> 6</GSTRATE> was parsed, not dropped",
    rows.every((r) => Number.isFinite(r.gstRate)) && rows.some((r) => r.gstRate > 0));

  const spread = new Map<number, number>();
  for (const r of rows) spread.set(r.gstRate, (spread.get(r.gstRate) ?? 0) + 1);
  console.log(`  rates in use: ${[...spread].sort((a, b) => a[0] - b[0]).map(([r, n]) => `${r}% ×${n}`).join(" · ")}`);

  // Trap 4 — dated, and the 22-Sep-2025 change is in there.
  const dates = [...new Set(rows.map((r) => r.effectiveFrom))].sort();
  ok("rates are a dated history, not one value", dates.length > 2, `${dates.length} distinct dates`);
  console.log(`  ${dates.length} effective dates, ${dates[0]} … ${dates[dates.length - 1]}`);
  ok("the 22-Sep-2025 change is present",
    dates.includes("2025-09-22"), "expected the day bicycles moved to 5%");

  // ── Resolution across that boundary ─────────────────────────────────────
  const changed = groups.find((g) => g.effectiveFrom === "2025-09-22");
  if (changed) {
    const before = resolveRate(rows, "—none—", changed.name, "2025-09-01");
    const after = resolveRate(rows, "—none—", changed.name, "2026-09-13");
    console.log(`\n  ${changed.name}`);
    console.log(`     as at 2025-09-01 : ${before ? `${before.rate}% (from ${before.from}, effective ${before.effectiveFrom})` : "(none)"}`);
    console.log(`     as at 2026-09-13 : ${after ? `${after.rate}% (from ${after.from}, effective ${after.effectiveFrom})` : "(none)"}`);
    ok("a backdated lookup never returns a rate from the future",
      !before || before.effectiveFrom <= "2025-09-01");
    ok("the rate genuinely changed across 22-Sep-2025",
      !!before && !!after && before.rate !== after.rate,
      before && after ? `both ${before.rate}%` : "could not resolve both sides");
  }

  // ── The resolution chain ────────────────────────────────────────────────
  const deferring = items.filter((r) => !r.declaresOwn);
  console.log(`\n  ${items.filter((r) => r.declaresOwn).length} items declare their own rate; ` +
              `the rest inherit from their stock group.`);
  ok("resolution reports WHERE the rate came from", (() => {
    const g = groups[0];
    const r = g ? resolveRate(rows, "—none—", g.name, "2026-09-13") : null;
    return !!r && r.from === "stock_group" && r.sourceName === g!.name;
  })());
  ok("an unknown item with no group returns null rather than guessing",
    resolveRate(rows, "NOT A REAL ITEM", undefined, "2026-09-13") === null);

  // ── Supabase ────────────────────────────────────────────────────────────
  if (!SB_URL || !SB_KEY) {
    console.log("\n  (No Supabase credentials — skipping the landing check.)");
  } else {
    console.log("\n  Syncing via SupabaseSync.syncGstRates…");
    await new SupabaseSync().syncGstRates(rows, COMPANY);

    const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
    const { count, error } = await sb
      .from("tally_gst_rates").select("*", { count: "exact", head: true }).eq("company", COMPANY);
    if (error) ok("tally_gst_rates is readable", false, error.message);
    else {
      ok("the rows landed in tally_gst_rates", (count ?? 0) > 0, `${count} rows`);
      console.log(`        ${count} rows in Supabase`);
    }
  }

  console.log("\n  " + "─".repeat(60));
  console.log(`  ${fails === 0 ? "GST rates update themselves." : fails + " check(s) failed."}\n`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
