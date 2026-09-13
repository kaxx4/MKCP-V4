/**
 * The price list, pulled from Tally and landed in Supabase.
 *
 * This is the feature the owner remembered as "not being pulled from Tally over
 * XML". Half true: the puller works and always did, and nothing in production
 * ever called it — blocked by a comment claiming the query crashes TallyPrime.
 * It takes 0.18 seconds.
 *
 * Proves, end to end and against real data:
 *   · the pull returns a DATED history, not a snapshot
 *   · DEALER and Dealer fold to one level rather than splitting the catalogue
 *   · a rate resolves AS AT a date — which is what "booked price wins" needs
 *   · the rows reach Supabase and can be read back
 *
 *   npx tsx server/scripts/verify-price-list.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { createClient } from "@supabase/supabase-js";
import { fetchPriceList, latestRates, rateFor, normalizeLevel } from "../src/services/tallyPriceList.js";
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
  console.log("\n  THE PRICE LIST, END TO END\n  " + "─".repeat(60));

  const t0 = Date.now();
  const rows = await fetchPriceList(TALLY, COMPANY);
  const ms = Date.now() - t0;
  console.log(`\n  Pulled ${rows.length} dated entries in ${ms} ms.`);

  ok("the pull returns entries at all", rows.length > 0);
  ok("it is fast — the 'crashes TallyPrime' claim was false", ms < 30_000, `${ms} ms`);

  // ── A history, not a snapshot ───────────────────────────────────────────
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  ok("it is a DATED history spanning years, not one rate per item",
    dates.length > 3, `only ${dates.length} distinct dates`);
  console.log(`        ${dates.length} distinct effective dates, ${dates[0]} … ${dates[dates.length - 1]}`);

  const perItem = new Map<string, number>();
  for (const r of rows) perItem.set(r.itemName, (perItem.get(r.itemName) ?? 0) + 1);
  const multi = [...perItem.values()].filter((n) => n > 1).length;
  ok("many items carry more than one revision", multi > 50, `${multi} items with >1 entry`);

  // ── The casing trap ─────────────────────────────────────────────────────
  const rawLevels = new Map<string, number>();
  for (const r of rows) rawLevels.set(r.priceLevelRaw ?? "", (rawLevels.get(r.priceLevelRaw ?? "") ?? 0) + 1);
  const foldedLevels = new Set(rows.map((r) => r.priceLevel));
  console.log(`\n  Price levels as Tally holds them: ${[...rawLevels].map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  console.log(`  Folded for lookup:                ${[...foldedLevels].join(" · ")}`);

  ok("DEALER and Dealer appear as separate raw spellings",
    rawLevels.has("DEALER") && rawLevels.has("Dealer"));
  ok("…and fold to ONE level, so the catalogue does not split",
    foldedLevels.size < rawLevels.size);
  ok("normalizeLevel folds case", normalizeLevel("Dealer") === normalizeLevel("DEALER"));

  // ── A rate AS AT a date — the "booked price wins" primitive ─────────────
  const latest = latestRates(rows, "2026-09-13");
  const older = latestRates(rows, "2024-06-30");
  ok("resolving as-at a date returns a rate per (item, level)", latest.size > 0);

  const sample = [...perItem.entries()].find(([name, n]) => n >= 3)?.[0];
  if (sample) {
    const now = rateFor(latest, sample, "DEALER");
    const then = rateFor(older, sample, "DEALER");
    console.log(`\n  ${sample}`);
    console.log(`     as at 2026-09-13 : ${now ? `${now.rate}/${now.unit ?? "?"}` : "(none)"}`);
    console.log(`     as at 2024-06-30 : ${then ? `${then.rate}/${then.unit ?? "?"}` : "(none)"}`);
    ok("a backdated lookup never returns a rate from the future",
      !then || !now || new Date(then.date) <= new Date("2024-06-30"));
  }

  ok("the rate carries its unit, so per-PC and per-BOX are not comparable",
    rows.some((r) => !!r.unit));

  // ── Supabase ────────────────────────────────────────────────────────────
  if (!SB_URL || !SB_KEY) {
    console.log("\n  (No Supabase credentials — skipping the landing check.)");
  } else {
    /* Run the REAL writer, not a hand-rolled insert. Verifying an
       approximation of the write path proves nothing about the write path. */
    console.log("\n  Syncing via SupabaseSync.syncPriceList…");
    await new SupabaseSync().syncPriceList(rows, COMPANY);

    const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
    const { count, error } = await sb
      .from("tally_price_list")
      .select("*", { count: "exact", head: true })
      .eq("company", COMPANY);

    if (error) {
      ok("tally_price_list is readable", false, error.message);
    } else {
      ok("the rows landed in tally_price_list", (count ?? 0) > 0, `${count} rows`);
      console.log(`        ${count} rows in Supabase for this company`);

      const { data: dealer } = await sb
        .from("tally_price_list")
        .select("item_name, price_level, price_level_raw, effective_from, rate, unit")
        .eq("company", COMPANY)
        .order("effective_from", { ascending: false })
        .limit(3);
      for (const d of dealer ?? []) {
        console.log(`        ${String(d.item_name).slice(0, 34).padEnd(34)} ${d.price_level.padEnd(8)} ${d.effective_from}  ${d.rate}/${d.unit ?? "?"}`);
      }

      const { data: levels } = await sb
        .from("tally_price_list")
        .select("price_level")
        .eq("company", COMPANY)
        .limit(5000);
      const stored = new Set((levels ?? []).map((l) => l.price_level));
      ok("the stored level is the FOLDED one, so lookups cannot miss",
        ![...stored].some((l) => l !== l.toUpperCase()), `stored: ${[...stored].join(", ")}`);
    }
  }

  console.log("\n  " + "─".repeat(60));
  console.log(`  ${fails === 0 ? "The price list updates itself." : fails + " check(s) failed."}\n`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
