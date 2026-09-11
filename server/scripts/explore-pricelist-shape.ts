/**
 * The exact nesting of FULLPRICELIST, dumped raw for one item that has several
 * price levels. Parsing this by regex without knowing whether PRICELEVEL sits
 * beside DATE or inside PRICELEVELLIST.LIST is how a catalogue ends up half
 * populated with nobody noticing.
 *
 *   npx tsx scripts/explore-pricelist-shape.ts [itemNameFragment]
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const want = (process.argv[2] ?? "").toUpperCase();

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  const raw: string = await tallyPost(U,
    `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkPrices</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkPrices" ISMODIFY="No"><TYPE>StockItem</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>FullPriceList</NATIVEMETHOD>
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`, 240_000, true);

  const items = [...raw.matchAll(/<STOCKITEM\b([^>]*)>([\s\S]*?)<\/STOCKITEM>/g)];

  // Pick an item that exercises the structure: the most price-list blocks, or
  // the named one if the caller asked for a specific SKU.
  let best: { name: string; body: string; blocks: number } | null = null;
  for (const [, attrs, body] of items) {
    const name = /(?:^|\s)NAME="([^"]*)"/.exec(attrs)?.[1] ?? "";
    if (want && !name.toUpperCase().includes(want)) continue;
    const blocks = [...body.matchAll(/<FULLPRICELIST\.LIST>/g)].length;
    if (!best || blocks > best.blocks) best = { name, body, blocks };
  }
  if (!best) { console.log("no matching item"); return; }

  console.log(`\n"${best.name}" — ${best.blocks} FULLPRICELIST.LIST block(s)\n`);

  // Show the LAST block whole (the most recent dated one) plus counts.
  const blocks = [...best.body.matchAll(/<FULLPRICELIST\.LIST>([\s\S]*?)<\/FULLPRICELIST\.LIST>/g)].map((m) => m[1]);
  const last = blocks[blocks.length - 1];
  console.log("── the most recent block, verbatim ──");
  console.log(last.replace(/^\s*\n/gm, ""));

  console.log("\n── structure across all blocks ──");
  for (const [i, b] of blocks.entries()) {
    const date = /<DATE[^>]*>([^<]*)<\/DATE>/.exec(b)?.[1]?.trim() ?? "(none)";
    const levels = [...b.matchAll(/<PRICELEVEL[^>]*>([^<]*)<\/PRICELEVEL>/g)].map((m) => m[1].trim());
    const rates = [...b.matchAll(/<RATE[^>]*>([^<]*)<\/RATE>/g)].map((m) => m[1].trim());
    const bands = [...b.matchAll(/<PRICELEVELLIST\.LIST>/g)].length;
    console.log(`  block ${i + 1}: DATE=${date}  PRICELEVEL×${levels.length}[${levels.join(", ")}]  PRICELEVELLIST×${bands}  RATE×${rates.length}[${rates.slice(0, 4).join(", ")}]`);
  }

  /* The decisive question for a parser: can ONE block carry MORE THAN ONE level?
     NOTE the closing tag in this pattern. `<PRICELEVEL[^>]*>` alone also matches
     `<PRICELEVELLIST.LIST>` — the list element's name starts with the scalar's —
     which reported every single block as carrying multiple price levels and would
     have produced a parser that read the catalogue wrongly. Requiring
     `</PRICELEVEL>` is what makes the count mean what it says. */
  const LEVEL = /<PRICELEVEL>([^<]*)<\/PRICELEVEL>/g;
  const multi = blocks.filter((b) => [...b.matchAll(LEVEL)].length > 1).length;
  console.log(`\nblocks carrying more than one PRICELEVEL: ${multi} of ${blocks.length}`);

  // And across the whole catalogue, so one item doesn't mislead.
  let anyMulti = 0, totalBlocks = 0, banded = 0, multiBand = 0;
  for (const [, , body] of items) {
    for (const [, b] of body.matchAll(/<FULLPRICELIST\.LIST>([\s\S]*?)<\/FULLPRICELIST\.LIST>/g)) {
      totalBlocks++;
      if ([...b.matchAll(LEVEL)].length > 1) anyMulti++;
      if (/<STARTINGFROM>\s*\S/.test(b) || /<ENDINGAT>\s*\S/.test(b)) banded++;
      if ([...b.matchAll(/<PRICELEVELLIST\.LIST>/g)].length > 1) multiBand++;
    }
  }
  console.log(`catalogue-wide: ${totalBlocks} blocks, ${anyMulti} with multiple levels, ${banded} with a quantity band, ${multiBand} with more than one PRICELEVELLIST`);
})();
