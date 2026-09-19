/**
 * Which items have NO selling price, and what was being quoted for them instead?
 *
 * ── The question ──────────────────────────────────────────────────────────
 *
 * The web app's quote screen pre-filled a line's rate from `deriveItemPricing`,
 * whose fallback chain ended:
 *
 *     history → dealer price → item.closingRate → item.openingRate
 *
 * The last two are Tally's stock VALUATION — a cost figure. `salesPricing.ts`
 * had carried the rule "never falls back to closing/opening stock valuation —
 * those are cost figures, not selling prices" in its header since it was
 * written, and enforced it in `resolveSellingRate` only. So an item with no
 * price-list rate and no recent sales was pre-filled AT COST, and the
 * verification pill beside it measured against the live price list — two
 * numbers from two sources on one row, which is what the owner reported as
 * "you're showing me an incorrect rate and beside it I list rate and then
 * you're showing me a different rate".
 *
 * Fixed 19-Sep-2026 (list → history → nothing). This probe sizes what the
 * defect had been reaching: items with no list rate, where a valuation figure
 * was therefore available to be quoted.
 *
 * ── Safety ────────────────────────────────────────────────────────────────
 *
 * Read-only. Three collection pulls, all of verified object types
 * (`StockItem`), plus the price list report. Nothing is written.
 *
 *   npx tsx server/scripts/probe-unpriced-items.ts
 *
 * NOTE (G8, and this machine): `MKCP_TALLY_ROLE=sandbox` here — the open
 * company is an older backup that shares production's name. The SHAPE of the
 * answer transfers; the exact counts are this copy's, not the real books'.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { esc, blocksOf, tagOf } from "../src/services/tallyRequest.js";
import { fetchPriceList, latestRates } from "../src/services/tallyPriceList.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
/**
 * Decode the entities Tally emits, then case-fold.
 *
 * The join between the item master and the price list is the item NAME, and
 * these two responses escape it differently. The first run of this probe
 * reported 60 unpriced items whose names read `BACK STAY KW 20&QUOT; RB` and
 * `B.B. AXLE &AMP; CUP BHOGAL PT` — every one of them a join failure on `"`,
 * `'` and `&`, not an item without a price. Tally also emits `&QUOT;` and
 * `&APOS;` in caps, which a case-sensitive decoder passes straight through,
 * so the decode runs BEFORE the upper-casing and is case-insensitive itself.
 */
const key = (s: string) =>
  s.replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
   .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
   .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
   .replace(/&amp;/gi, "&")          // last: an entity may itself be escaped
   .replace(/\s+/g, " ").trim().toUpperCase();

const num = (s: string | null | undefined) => {
  const v = parseFloat(String(s ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(v) ? v : 0;
};

/** Stock items with their valuation rates. */
async function items(company: string) {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>ItRates</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="ItRates" ISMODIFY="No"><TYPE>StockItem</TYPE>
<NATIVEMETHOD>NAME</NATIVEMETHOD><NATIVEMETHOD>CLOSINGRATE</NATIVEMETHOD>
<NATIVEMETHOD>OPENINGRATE</NATIVEMETHOD><NATIVEMETHOD>CLOSINGBALANCE</NATIVEMETHOD>
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw = (await tallyPost(U, xml, 180_000, true)) as string;
  return blocksOf(raw, "STOCKITEM").map((b) => ({
    name: key(tagOf(b, "NAME") ?? ""),
    closing: num(tagOf(b, "CLOSINGRATE")),
    opening: num(tagOf(b, "OPENINGRATE")),
  })).filter((i) => i.name);
}

/**
 * The full price list, through the SAME parser the sync agent uses.
 *
 * A hand-rolled `<RATE>` regex was tried here first and reported "0 items
 * priced" against a 1.2 MB response — a parser result presented as Tally's
 * answer, which is precisely the fact G7 exists to keep separate. The real
 * parser knows the traps this one did not: `<PRICELEVEL[^>]*>` also matches
 * `<PRICELEVELLIST.LIST>`, and each block is one (date, level) pair so the
 * newest has to be selected rather than the first.
 */
async function pricedItems(company: string): Promise<Set<string>> {
  const entries = await fetchPriceList(U, company);
  const latest = latestRates(entries);
  const withRate = new Set<string>();
  for (const e of latest.values()) if (e.rate > 0) withRate.add(key(e.itemName));
  return withRate;
}

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  console.log(`\n  UNPRICED ITEMS — WHAT WAS BEING QUOTED INSTEAD?\n  ${company}`);
  console.log(`  role=${process.env.MKCP_TALLY_ROLE ?? "primary"}\n  ${"─".repeat(68)}`);

  const [all, listed] = await Promise.all([items(company), pricedItems(company)]);
  const unlisted = all.filter((i) => !listed.has(i.name));
  const wouldQuoteCost = unlisted.filter((i) => i.closing > 0 || i.opening > 0);

  console.log(`  stock items                       ${String(all.length).padStart(5)}`);
  console.log(`  priced by the live price list     ${String(all.length - unlisted.length).padStart(5)}`);
  console.log(`  NOT priced by the list            ${String(unlisted.length).padStart(5)}`);
  console.log(`   └ of those, carrying a valuation ${String(wouldQuoteCost.length).padStart(5)}  ← was pre-fillable AT COST`);

  console.log(`\n  the ones that could be quoted at cost (first 20):`);
  for (const i of wouldQuoteCost.slice(0, 20)) {
    const r = i.closing > 0 ? i.closing : i.opening;
    console.log(`    ₹${r.toFixed(2).padStart(10)}  ${i.name.slice(0, 52)}`);
  }

  console.log(`\n  What this CANNOT see (P7): whether a given item also had recent`);
  console.log(`  sales history, which would have won over the valuation. So this is`);
  console.log(`  the upper bound on the exposure, not the realised count.\n`);
})();
