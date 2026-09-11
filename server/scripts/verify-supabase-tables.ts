/**
 * Do the price-list and GST-rate mirrors actually work end to end?
 *
 * Run this AFTER applying migration 027. It pulls from Tally, writes to
 * Supabase, reads the rows back, and checks the figures survived the round
 * trip — including the two that are easy to lose: the price level's case
 * folding, and the DATED nature of both tables.
 *
 * It exists because this codebase has shipped seven features that typechecked,
 * logged plausibly and did nothing, every one of them failing at a seam like
 * this. `syncPriceList` and `syncGstRates` are written but have never run
 * against a real database — so until this passes, they are exactly the kind of
 * code that has died here before.
 *
 *   npx tsx scripts/verify-supabase-tables.ts          # read-only probe
 *   npx tsx scripts/verify-supabase-tables.ts --write  # pull, write, verify
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { fetchPriceList, latestRates } from "../src/services/tallyPriceList.js";
import { loadMasters, revisionOn } from "../src/services/tallyMasters.js";
import { SupabaseSync } from "../src/services/supabaseSync.js";

config();

const U = process.env.TALLY_URL || "http://localhost:9000";
const WRITE = process.argv.includes("--write");

let passed = 0, failed = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`    \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; failures.push(label); console.log(`    \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
};
const H = (s: string) => console.log(`\n\x1b[1m── ${s} ${"─".repeat(Math.max(0, 56 - s.length))}\x1b[0m`);

(async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error("\nSUPABASE_URL / SUPABASE_SERVICE_KEY missing from server/.env — cannot run.\n");
    process.exit(1);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  // ── Does the schema exist at all? ───────────────────────────────────────
  H("SCHEMA");
  for (const table of ["tally_price_list", "tally_gst_rates"]) {
    const { error } = await db.from(table).select("id").limit(1);
    const missing = /does not exist|schema cache/i.test(error?.message ?? "");
    ok(`${table} exists`, !missing,
      missing ? "apply migrations/027_tally_price_list_and_gst_rates.sql first" : (error?.message ?? "ready"));
  }
  if (failed) {
    console.log(`\n\x1b[1mMigration 027 has not been applied.\x1b[0m Nothing else can be checked.\n`);
    process.exit(1);
  }

  if (!WRITE) {
    H("CURRENT CONTENTS");
    for (const table of ["tally_price_list", "tally_gst_rates"]) {
      const { count } = await db.from(table).select("*", { count: "exact", head: true });
      console.log(`    ${table.padEnd(20)} ${count ?? 0} rows`);
    }
    console.log(`\nRead-only. Pass --write to pull from Tally and verify the round trip.\n`);
    return;
  }

  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  const sync = new SupabaseSync(url, key);

  // ── Price list ──────────────────────────────────────────────────────────
  H("PRICE LIST");
  const entries = await fetchPriceList(U, company);
  ok("pulled from Tally", entries.length > 1000, `${entries.length} dated entries`);

  await sync.syncPriceList(entries, company);

  const { count: plCount } = await db.from("tally_price_list")
    .select("*", { count: "exact", head: true }).eq("company", company);
  ok("rows landed in Supabase", (plCount ?? 0) >= entries.length,
    `${plCount} rows for ${entries.length} pulled`);

  // Spot-check a real figure end to end, rather than trusting the count.
  const current = latestRates(entries);
  const sample = [...current.values()].find((e) => e.rate > 0)!;
  const { data: back } = await db.from("tally_price_list")
    .select("rate, unit, price_level, price_level_raw, effective_from")
    .eq("company", company).eq("item_name", sample.itemName)
    .eq("price_level", sample.priceLevel).eq("effective_from", sample.date).maybeSingle();

  ok("a specific rate survived the round trip",
    back != null && Math.abs(Number(back.rate) - sample.rate) < 0.005,
    `${sample.itemName} ${sample.priceLevel} ${sample.date}: Tally ₹${sample.rate} · Supabase ₹${back?.rate}`);
  ok("the unit travelled with the rate", back?.unit === sample.unit, `"${back?.unit}"`);
  ok("the price level is stored FOLDED", back?.price_level === back?.price_level?.toUpperCase(),
    `${back?.price_level} (raw "${back?.price_level_raw}")`);

  // The whole reason this is a dated table: more than one row per item+level.
  const { count: histCount } = await db.from("tally_price_list")
    .select("*", { count: "exact", head: true })
    .eq("company", company).eq("item_name", sample.itemName).eq("price_level", sample.priceLevel);
  ok("history is kept, not flattened to one current rate", (histCount ?? 0) > 1,
    `${histCount} dated revisions for ${sample.itemName}`);

  // Re-running must not duplicate.
  await sync.syncPriceList(entries, company);
  const { count: plAgain } = await db.from("tally_price_list")
    .select("*", { count: "exact", head: true }).eq("company", company);
  ok("re-running upserts rather than duplicating", plAgain === plCount, `${plAgain} vs ${plCount}`);

  // ── GST rates ───────────────────────────────────────────────────────────
  H("GST RATES");
  const masters = await loadMasters(U, company);
  const rows = [
    ...[...masters.items.values()].flatMap((i) =>
      i.gstRevisions.map((r) => ({
        scope: "item" as const, name: i.name, effectiveFrom: r.from || "2017-07-01",
        gstRate: r.rate, cgst: r.cgst, sgst: r.sgst, igst: r.igst,
        taxability: r.taxability, parent: i.parent,
      }))),
    ...[...masters.stockGroups.values()].flatMap((g) =>
      g.gstRevisions.map((r) => ({
        scope: "stock_group" as const, name: g.name, effectiveFrom: r.from || "2017-07-01",
        gstRate: r.rate, cgst: r.cgst, sgst: r.sgst, igst: r.igst,
        taxability: r.taxability, parent: g.parent,
      }))),
  ];
  ok("built rows for items AND stock groups",
    rows.some((r) => r.scope === "item") && rows.some((r) => r.scope === "stock_group"),
    `${rows.filter((r) => r.scope === "item").length} item · ${rows.filter((r) => r.scope === "stock_group").length} group`);

  await sync.syncGstRates(rows, company);

  const { count: gstCount } = await db.from("tally_gst_rates")
    .select("*", { count: "exact", head: true }).eq("company", company);
  ok("rows landed in Supabase", (gstCount ?? 0) >= rows.length, `${gstCount} rows for ${rows.length} built`);

  // The rate change that makes this table dated at all: bicycles moved to 5%
  // on 22 September 2025. If only one revision per group survived, this fails.
  const bicycle = [...masters.stockGroups.values()].find((g) => /^BICYCLE \(/i.test(g.name));
  if (bicycle) {
    const { data: revs } = await db.from("tally_gst_rates")
      .select("effective_from, gst_rate, cgst_rate, igst_rate")
      .eq("company", company).eq("scope", "stock_group").eq("name", bicycle.name)
      .order("effective_from", { ascending: true });
    ok("every dated revision was kept", (revs?.length ?? 0) >= 2,
      (revs ?? []).map((r) => `${r.effective_from} ${r.gst_rate}%`).join(" → "));

    const now = revisionOn(bicycle.gstRevisions, new Date().toISOString().slice(0, 10));
    const newest = revs?.[revs.length - 1];
    ok("the current rate matches what Tally resolves",
      newest != null && now != null && Math.abs(Number(newest.gst_rate) - now.rate) < 0.005,
      `Supabase ${newest?.gst_rate}% · Tally ${now?.rate}%`);
    ok("IGST is the combined rate, CGST its half",
      newest != null && Math.abs(Number(newest.igst_rate) - Number(newest.cgst_rate) * 2) < 0.005,
      `IGST ${newest?.igst_rate} vs CGST ${newest?.cgst_rate}×2`);
  } else {
    ok("found the BICYCLE stock group to check dated revisions", false);
  }

  console.log(`\n\x1b[1m${passed} passed · ${failed} failed\x1b[0m`);
  if (failed) console.log(`\nfailed:\n${failures.map((f) => `  · ${f}`).join("\n")}`);
  console.log();
  process.exit(failed ? 1 : 0);
})();
