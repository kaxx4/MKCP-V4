/**
 * Can every item resolve a GST rate, and where does it come from?
 *
 * ── Why this is not a field lookup ────────────────────────────────────────
 *
 * A GST rate is NOT simply a property of an item. `SRCOFGSTDETAILS` on this
 * company's items commonly reads "As per Company/Stock Group", meaning the item
 * declares nothing and inherits from its stock group — and only a small
 * minority declare their own.
 *
 * So code that reads the item's own rate and stops gets 0 for most of the
 * catalogue. A voucher built on that files under GSTR-1's "Tax Rate is not
 * specified", which is the failure this whole rebuild keeps circling: the
 * voucher balances, verifies, reads back byte-identical, and the return is
 * wrong.
 *
 * `gstRateFor` walks item -> stock group -> up the group tree. This measures
 * how much of the catalogue actually depends on that walk, and — the part that
 * matters — names any item where the walk finds nothing.
 *
 *   npx tsx server/scripts/verify-gst-rate-chain.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters, gstRateFor } from "../src/services/tallyMasters.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";

let fails = 0;
const ok = (what: string, cond: boolean, detail = "") => {
  if (cond) console.log(`  ok    ${what}${detail ? "  — " + detail : ""}`);
  else { fails++; console.log(`  FAIL  ${what}${detail ? "  — " + detail : ""}`); }
};

async function main(): Promise<void> {
  console.log("\n  GST RATE CHAIN — item -> stock group -> up the tree");
  console.log("  " + "─".repeat(66));

  const company = convertCompanies(await tallyPost(TALLY, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  const m = await loadMasters(TALLY, company, { force: true });

  let own = 0, group = 0, none = 0;
  const unresolved: string[] = [];

  for (const [name] of m.items) {
    const r = gstRateFor(m, name);
    if (r.source === "item") own++;
    else if (r.source.startsWith("stock group")) group++;
    else {
      none++;
      if (unresolved.length < 8) unresolved.push(`${name.slice(0, 40).padEnd(42)} ${r.source}`);
    }
  }

  console.log(`\n  ${m.items.size} items`);
  console.log(`    rate on the item itself   ${String(own).padStart(4)}`);
  console.log(`    inherited from a group    ${String(group).padStart(4)}`);
  console.log(`    NO RATE ANYWHERE          ${String(none).padStart(4)}`);

  /* The inheritance is the whole point. If almost everything declared its own
     rate, the walk would be dead code and reading the item alone would be
     safe — so this number is what justifies the function existing. */
  ok("most of the catalogue INHERITS its rate rather than declaring one",
    group > own,
    `${group} inherited vs ${own} declared — reading the item alone would return 0 for ${group} items`);

  ok("every item resolves to a rate",
    none === 0,
    none === 0 ? "" : `${none} item(s) would file as "Tax Rate is not specified"`);

  if (unresolved.length) {
    console.log(`\n  items with no resolvable rate — each one files wrong if invoiced:`);
    for (const u of unresolved) console.log(`    ${u}`);
    if (none > unresolved.length) console.log(`    …and ${none - unresolved.length} more`);
  }

  /* A sanity check on the walk itself: a known item should resolve to a
     plausible GST rate rather than something absurd. */
  const sample = [...m.items.keys()].find((n) => gstRateFor(m, n).rate > 0);
  if (sample) {
    const r = gstRateFor(m, sample);
    console.log(`\n  e.g. ${sample.slice(0, 40)} -> ${r.rate}% from ${r.source}`);
    ok("a resolved rate is a real GST slab", [0, 5, 12, 18, 28].includes(r.rate), `${r.rate}%`);
  }

  console.log("\n  " + "─".repeat(66));
  console.log(`  ${fails === 0 ? "Every item can be priced for GST." : fails + " check(s) failed."}\n`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
