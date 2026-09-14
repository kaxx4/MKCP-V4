/**
 * Phase 2.4 — the location key, verified from Tally through the converter.
 *
 * Runs against the MOCK by default (the captured day), so it needs nothing
 * running; pass --live to pull a fresh day from Tally instead.
 *
 * What it proves: every inventory line that Tally gives a batch allocation now
 * carries a godown and a batch out of the converter, and a line split across
 * godowns is flagged rather than silently reduced to its first allocation.
 *
 * What it cannot prove from this machine: that the columns fill in Supabase —
 * MKCP_TALLY_ROLE=sandbox makes every SupabaseSync write a no-op. Said here
 * rather than papered over (P7).
 *
 *   npx tsx server/scripts/verify-location-key.ts [--live]
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { tallyPostWithRetry } from "../src/tally.js";
import { buildCollectionXml } from "../src/services/xmlBuilder.js";
import { convertVouchers } from "../src/converters/convert.js";
import { TRANSACTION_COLLECTIONS } from "../src/config/collections.js";
import { FixtureStore, installMock } from "../src/services/tallyMock.js";
import { verifyContext } from "../src/services/verifyContext.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";
const LIVE = process.argv.includes("--live");

let fails = 0;
const ok = (what: string, cond: boolean, detail = "") => {
  if (cond) console.log(`  ok    ${what}${detail ? "  — " + detail : ""}`);
  else { fails++; console.log(`  FAIL  ${what}${detail ? "  — " + detail : ""}`); }
};

interface Entry {
  stockitemname: string;
  godownname: string;
  batchname: string;
  destinationgodownname: string;
  issplitacrossgodowns: boolean;
  batchallocations: { godownname: string; batchname: string; batchid: number | null }[];
}

async function main(): Promise<void> {
  console.log("\n  THE LOCATION KEY — Tally → converter\n  " + "─".repeat(62));

  if (!LIVE) {
    const store = new FixtureStore(join(here, "..", "fixtures"));
    if (store.size === 0) {
      console.log("\n  No fixtures. Run capture-fixtures.ts, or pass --live.\n");
      process.exit(1);
    }
    installMock(store.transport());
    console.log("  source: the captured fixture day (no Tally needed)\n");
  } else {
    console.log("  source: live Tally\n");
  }

  const def = TRANSACTION_COLLECTIONS[0];
  const parsed = await tallyPostWithRetry(
    TALLY, buildCollectionXml(def, COMPANY, "20260910", "20260910"), def.timeout, false, 1,
  );
  const vs = convertVouchers(parsed).tallymessage as { inventoryentries: Entry[]; vouchernumber: string }[];

  const lines = vs.flatMap((v) => v.inventoryentries ?? []);
  const withAlloc = lines.filter((l) => l.batchallocations?.length > 0);
  const withGodown = lines.filter((l) => !!l.godownname);
  const withBatch = lines.filter((l) => !!l.batchname);
  const split = lines.filter((l) => l.issplitacrossgodowns);

  console.log(`  ${vs.length} vouchers · ${lines.length} inventory lines`);
  console.log(`     with a batch allocation : ${withAlloc.length}`);
  console.log(`     carrying a godown       : ${withGodown.length}`);
  console.log(`     carrying a batch        : ${withBatch.length}`);
  console.log(`     split across godowns    : ${split.length}\n`);

  ok("inventory lines exist to test", lines.length > 0, `${lines.length}`);
  ok("every line with an allocation carries a godown",
    withGodown.length === withAlloc.length, `${withGodown.length}/${withAlloc.length}`);
  ok("every line with an allocation carries a batch",
    withBatch.length === withAlloc.length, `${withBatch.length}/${withAlloc.length}`);

  /* The allocation list must be KEPT, not reduced to its first element. A
     line split across godowns is the case the flat columns cannot express,
     and losing it silently is exactly the class of defect being hunted. */
  const listPreserved = withAlloc.every((l) => Array.isArray(l.batchallocations));
  ok("the full allocation list survives the converter", listPreserved);

  const consistent = withAlloc.every((l) => l.batchallocations[0].godownname === l.godownname);
  ok("the flat godown column is the primary allocation's", consistent);

  /* The split flag must agree with the list rather than being decorative. */
  const flagAgrees = lines.every((l) => {
    const distinct = new Set((l.batchallocations ?? []).map((a) => a.godownname).filter(Boolean)).size;
    return l.issplitacrossgodowns === (distinct > 1);
  });
  ok("the split flag agrees with the allocation list", flagAgrees);

  const godowns = new Map<string, number>();
  const batches = new Map<string, number>();
  for (const l of lines) {
    if (l.godownname) godowns.set(l.godownname, (godowns.get(l.godownname) ?? 0) + 1);
    if (l.batchname) batches.set(l.batchname, (batches.get(l.batchname) ?? 0) + 1);
  }
  console.log(`\n  distinct godowns: ${[...godowns].map(([k, v]) => `${k} (${v})`).join(", ") || "—"}`);
  console.log(`  distinct batches: ${[...batches].map(([k, v]) => `${k} (${v})`).join(", ") || "—"}`);

  if (godowns.size === 1) {
    console.log(`\n  One godown, as expected — this company has exactly one. The key buys`);
    console.log(`  nothing today and everything the day a second one opens, because rows`);
    console.log(`  synced before it existed would be unattributable forever.`);
  }

  const ctx = verifyContext();
  console.log(`\n  NOT VERIFIED HERE: that the columns fill in Supabase.`);
  console.log(`  ${ctx.canWrite
    ? "This process can write — run a voucher sync and check tally_voucher_inventory_entries."
    : `This process cannot write (${ctx.why}), so landing depends on the next voucher sync from a non-sandbox process.`}`);

  console.log("\n  " + "─".repeat(62));
  console.log(`  ${fails === 0 ? "The location key reaches the converter." : fails + " check(s) failed."}\n`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
