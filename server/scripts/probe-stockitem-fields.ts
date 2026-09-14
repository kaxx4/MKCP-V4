/**
 * Do the four fields convertStockItems reads actually exist on the wire?
 *
 * `convertStockItems` reads COSTINGMETHOD, VALUATIONMETHOD, ISBATCHWISEON and
 * ISCOSTCENTRESON (convert.ts:279-282). None of them is in the StockItem fetch
 * list (collections.ts:45-55), so Tally has never been asked for them and those
 * four Supabase columns are permanently empty. Guardrail G4.
 *
 * Adding a field to a fetch list is the change class that can crash TallyPrime
 * (a `.*` wildcard does), so this ASKS first, one field at a time, against a
 * single item. If a field comes back empty on every item it is not added — an
 * unpopulated column is what we are trying to stop creating.
 *
 *   npx tsx server/scripts/probe-stockitem-fields.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { tallyPost } from "../src/tally.js";
import { blocksOf, allTagsOf } from "../src/services/tallyRequest.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";

const CANDIDATES = ["CostingMethod", "ValuationMethod", "IsBatchWiseOn", "IsCostCentresOn"];

function xmlFor(fields: string[]): string {
  return `<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>ProbeItem</ID></HEADER>
<BODY><DESC><STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
${COMPANY ? `<SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY>` : ""}
</STATICVARIABLES><TDL><TDLMESSAGE>
<COLLECTION NAME="ProbeItem" ISMODIFY="No">
<TYPE>StockItem</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD>
${fields.map((f) => `<NATIVEMETHOD>${f}</NATIVEMETHOD>`).join("\n")}
</COLLECTION>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

async function main(): Promise<void> {
  console.log("\n  STOCKITEM FIELD PROBE — are the four read-but-never-fetched fields real?");
  console.log("  " + "─".repeat(72) + "\n");

  /* One field at a time. A combined request that fails tells you nothing about
     WHICH field caused it, and a bad field can cost a Tally restart. */
  const verdicts: Record<string, { served: boolean; populated: number; total: number; sample: string }> = {};

  for (const f of CANDIDATES) {
    try {
      const raw: string = await tallyPost(TALLY, xmlFor([f]), 60_000, true);
      const items = blocksOf(raw, "STOCKITEM");
      const vals = allTagsOf(raw, f.toUpperCase());
      const nonEmpty = vals.filter((v) => v && v.trim() !== "");
      verdicts[f] = {
        served: vals.length > 0,
        populated: nonEmpty.length,
        total: items.length,
        sample: [...new Set(nonEmpty)].slice(0, 3).join(" | ") || "—",
      };
      const v = verdicts[f];
      console.log(`  ${f.padEnd(18)} served=${String(v.served).padEnd(5)} ` +
        `populated ${String(v.populated).padStart(4)}/${String(v.total).padEnd(4)}  ${v.sample}`);
    } catch (e: any) {
      verdicts[f] = { served: false, populated: 0, total: 0, sample: `ERROR: ${e.message}` };
      console.log(`  ${f.padEnd(18)} FAILED — ${e.message}`);
    }
  }

  console.log("\n  " + "─".repeat(72));
  const worth = CANDIDATES.filter((f) => verdicts[f].populated > 0);
  const empty = CANDIDATES.filter((f) => verdicts[f].served && verdicts[f].populated === 0);
  const dead = CANDIDATES.filter((f) => !verdicts[f].served);

  if (worth.length) console.log(`  ADD to the fetch list (served and populated): ${worth.join(", ")}`);
  if (empty.length) console.log(`  Do NOT add (served but empty on every item):  ${empty.join(", ")}`);
  if (dead.length) console.log(`  Do NOT add (Tally does not serve it):          ${dead.join(", ")}`);
  console.log("");
  console.log("  Whatever is not added must be DELETED from convertStockItems and");
  console.log("  mapStockItem — G4 says a field is stored or documented as dropped,");
  console.log("  never read into a column that stays empty forever.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
