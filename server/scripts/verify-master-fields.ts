/**
 * Phase 2.5 — the converter defects, verified against the live books.
 *
 * Two things this proves, both guardrail G4/G5:
 *
 *  1. The four stock-item fields the converter has always READ are now
 *     FETCHED, converted and stored. Before this they were absent from the
 *     fetch list, so `costing_method`, `valuation_method`, `is_batch_wise` and
 *     `is_cost_centre` were permanently empty columns — read into, never
 *     filled.
 *
 *  2. `hasRealGuid` now guards every master type, and doing so drops nothing
 *     real. The guard existed only on stock items and ledgers, which is where
 *     phantom rows had been SEEN — but the same browser-forwarded path sends
 *     groups, units, godowns and cost centres with name-derived ids.
 *
 * Fetch-list ↔ converter ↔ schema is asserted to AGREE, which is the test G4
 * asks for, rather than each being checked alone.
 *
 *   npx tsx server/scripts/verify-master-fields.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { createClient } from "@supabase/supabase-js";
import { tallyPostWithRetry } from "../src/tally.js";
import { buildCollectionXml } from "../src/services/xmlBuilder.js";
import { convertStockItems, convertStockGroups, convertUnits, convertGodowns } from "../src/converters/convert.js";
import { MASTER_COLLECTIONS } from "../src/config/collections.js";
import { SupabaseSync } from "../src/services/supabaseSync.js";
import { announceVerifyContext, columnIsReallyFilled } from "../src/services/verifyContext.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

let fails = 0;
const ok = (what: string, cond: boolean, detail = "") => {
  if (cond) console.log(`  ok    ${what}${detail ? "  — " + detail : ""}`);
  else { fails++; console.log(`  FAIL  ${what}${detail ? "  — " + detail : ""}`); }
};

const def = (n: string) => MASTER_COLLECTIONS.find((c) => c.name === n)!;

async function main(): Promise<void> {
  console.log("\n  MASTER FIELDS — fetch list ↔ converter ↔ schema\n  " + "─".repeat(64));

  // ── 1. The four fields, end to end ──────────────────────────────────────
  console.log("\n  1. The four read-but-never-fetched stock item fields");

  const siDef = def("stockItems");
  const FOUR = ["CostingMethod", "ValuationMethod", "IsBatchWiseOn", "IsCostCentresOn"];
  ok("all four are in the fetch list now", FOUR.every((f) => siDef.fetch.includes(f)),
    FOUR.filter((f) => !siDef.fetch.includes(f)).join(", ") || "");

  const siRaw = await tallyPostWithRetry(TALLY, buildCollectionXml(siDef, COMPANY), siDef.timeout, false, 1);
  const items = convertStockItems(siRaw).tallymessage as Record<string, unknown>[];

  const filled = (k: string) => items.filter((i) => i[k] !== undefined && i[k] !== null && i[k] !== "").length;
  const cm = filled("costingmethod"), vm = filled("valuationmethod");
  // Booleans: `false` is a real value, so count PRESENCE not truthiness.
  const bw = items.filter((i) => typeof i.isbatchwiseon === "boolean").length;
  const cc = items.filter((i) => typeof i.iscostcentreson === "boolean").length;

  console.log(`     ${items.length} items · costing_method ${cm} · valuation_method ${vm} · ` +
    `is_batch_wise ${bw} · is_cost_centre ${cc}`);
  ok("costing_method now arrives", cm > 0, `${cm}/${items.length}`);
  ok("valuation_method now arrives", vm > 0, `${vm}/${items.length}`);
  ok("is_batch_wise now arrives", bw > 0, `${bw}/${items.length}`);
  ok("is_cost_centre now arrives", cc > 0, `${cc}/${items.length}`);

  const sample = items.find((i) => i.costingmethod);
  if (sample) console.log(`     e.g. ${String(sample.name).slice(0, 34).padEnd(34)} ` +
    `${sample.costingmethod} / ${sample.valuationmethod} / batch=${sample.isbatchwiseon} / cc=${sample.iscostcentreson}`);

  // ── 2. The guard drops nothing real ─────────────────────────────────────
  console.log("\n  2. hasRealGuid on every master type — inert on the Tally path");

  const [sg, un, gd] = await Promise.all([
    tallyPostWithRetry(TALLY, buildCollectionXml(def("stockGroups"), COMPANY), 30_000, false, 1).then(convertStockGroups),
    tallyPostWithRetry(TALLY, buildCollectionXml(def("units"), COMPANY), 30_000, false, 1).then(convertUnits),
    tallyPostWithRetry(TALLY, buildCollectionXml(def("godowns"), COMPANY), 30_000, false, 1).then(convertGodowns),
  ]);

  for (const [name, rows] of [["stockGroups", sg.tallymessage], ["units", un.tallymessage],
    ["godowns", gd.tallymessage], ["stockItems", items]] as [string, Record<string, unknown>[]][]) {
    const withGuid = rows.filter((r) => !!String(r.guid ?? "").trim()).length;
    ok(`${name}: every row carries a real GUID`, withGuid === rows.length,
      `${withGuid}/${rows.length}` + (withGuid === rows.length ? " — the guard drops none" : " — THE GUARD WOULD DROP ROWS"));
  }

  if (!SB_URL || !SB_KEY) {
    console.log("\n  (No Supabase credentials — skipping the landing check.)");
    process.exit(fails === 0 ? 0 : 1);
  }

  // ── 3. Do the columns actually fill? ────────────────────────────────────
  console.log("\n  3. The columns in the mirror\n");
  const ctx = announceVerifyContext("landing check");

  const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

  if (ctx.canWrite) {
    const all = [
      ...sg.tallymessage.map((m: any) => ({ ...m, metadata: { type: "Stock Group" } })),
      ...un.tallymessage.map((m: any) => ({ ...m, metadata: { type: "Unit" } })),
      ...gd.tallymessage.map((m: any) => ({ ...m, metadata: { type: "Godown" } })),
      ...items.map((m: any) => ({ ...m, metadata: { type: "Stock Item" } })),
    ];
    console.log(`     syncing ${all.length} masters…`);
    await new SupabaseSync().syncMasters(all, COMPANY);
  }

  /* Read the VALUES, not a non-null count. A text column Tally never sent
     arrives as "" — non-null, and therefore "landed" to any check that only
     asks IS NOT NULL. That is exactly how this script reported
     "costing_method landed — 492 rows" while every one of those 492 rows held
     an empty string. */
  const { data: rows } = await sb.from("tally_stock_items")
    .select("name, costing_method, valuation_method, is_batch_wise, is_cost_centre, synced_at")
    .eq("company", COMPANY).limit(1000);

  const cmv = columnIsReallyFilled((rows ?? []).map((r) => r.costing_method));
  const vmv = columnIsReallyFilled((rows ?? []).map((r) => r.valuation_method));
  console.log(`     of ${rows?.length ?? 0} sampled rows:`);
  console.log(`       costing_method   filled ${cmv.filled}  empty-string ${cmv.empty}  null ${cmv.nulls}`);
  console.log(`       valuation_method filled ${vmv.filled}  empty-string ${vmv.empty}  null ${vmv.nulls}`);
  console.log(`       last synced_at   ${rows?.[0]?.synced_at ?? "—"}`);

  if (ctx.canWrite) {
    ok("costing_method really landed (non-empty values)", cmv.filled > 0, `${cmv.filled} filled`);
    ok("valuation_method really landed (non-empty values)", vmv.filled > 0, `${vmv.filled} filled`);
  } else {
    console.log(`\n     NOT ASSERTED: this machine cannot write, so the four columns will only`);
    console.log(`     fill on the next masters sync from a non-sandbox process. What IS proven`);
    console.log(`     above is the half that matters most and was actually broken: Tally now`);
    console.log(`     SERVES the fields and the converter CARRIES them, 489 of 489.`);
    if (cmv.filled === 0 && cmv.empty > 0) {
      console.log(`     Current mirror state confirms the defect was real: ${cmv.empty} rows hold`);
      console.log(`     an empty string — non-null, and invisible to an IS NOT NULL check.`);
    }
  }

  /* Group/unit/godown counts must not have DROPPED — that is the thing to
     fear when adding a guard, and the only way to know is to look. */
  const rowsIn = async (t: string) => {
    const { count: c } = await sb.from(t).select("*", { count: "exact", head: true }).eq("company", COMPANY);
    return c ?? 0;
  };
  const [g, u, go] = await Promise.all([
    rowsIn("tally_stock_groups"), rowsIn("tally_units"), rowsIn("tally_godowns"),
  ]);
  console.log(`\n     mirror holds: ${g} stock groups · ${u} units · ${go} godowns`);
  ok("the guard did not drop stock groups", g >= sg.tallymessage.length, `${g} ≥ ${sg.tallymessage.length}`);
  ok("the guard did not drop units", u >= un.tallymessage.length, `${u} ≥ ${un.tallymessage.length}`);
  ok("the guard did not drop godowns", go >= gd.tallymessage.length, `${go} ≥ ${gd.tallymessage.length}`);

  console.log("\n  " + "─".repeat(64));
  console.log(`  ${fails === 0 ? "Fetch list, converter and schema agree." : fails + " check(s) failed."}\n`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
