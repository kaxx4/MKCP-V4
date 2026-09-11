/**
 * GST rates are DATED, and Tally keeps every revision.
 *
 * Each item/stock group carries one GSTDETAILS.LIST per rate change, stamped
 * with APPLICABLEFROM. A parser that takes the first match reads whichever
 * revision Tally happens to emit first — and for this company that is 2017, not
 * today. Bicycles and parts moved rate in September 2025, so reading the 2017
 * block reports a rate that has been wrong for a year.
 *
 * This dumps every dated block so the resolver can be written against the real
 * shape rather than a guess.
 *
 *   npx tsx scripts/explore-gst-dated.ts [nameFragment]
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const want = (process.argv[2] ?? "BICYCLE").toUpperCase();

const head = (block: string, name: string): number => {
  const m = new RegExp(
    `<GSTRATEDUTYHEAD>\\s*${name}\\s*</GSTRATEDUTYHEAD>[\\s\\S]{0,300}?<GSTRATE>\\s*([^<]*?)\\s*</GSTRATE>`, "i",
  ).exec(block);
  return m ? parseFloat(m[1]) || 0 : 0;
};

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;

  const ask = (type: string) =>
    tallyPost(U, `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkGstD</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkGstD" ISMODIFY="No"><TYPE>${type}</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>GSTDetails</NATIVEMETHOD>
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`, 240_000, true) as Promise<string>;

  for (const [label, type] of [["stock group", "STOCKGROUP"], ["item", "STOCKITEM"]] as const) {
    const raw = await ask(type === "STOCKGROUP" ? "StockGroup" : "StockItem");
    const objs = [...raw.matchAll(new RegExp(`<${type}\\b([^>]*)>([\\s\\S]*?)</${type}>`, "g"))];

    // How many dated revisions does each object carry?
    const counts = new Map<number, number>();
    let shown = 0;
    for (const [, attrs, body] of objs) {
      const name = /(?:^|\s)NAME="([^"]*)"/.exec(attrs)?.[1] ?? "";
      const blocks = [...body.matchAll(/<GSTDETAILS\.LIST>([\s\S]*?)<\/GSTDETAILS\.LIST>/g)].map((m) => m[1]);
      counts.set(blocks.length, (counts.get(blocks.length) ?? 0) + 1);

      if (name.toUpperCase().includes(want) && blocks.length && shown < 3) {
        shown++;
        console.log(`\n── ${label} "${name}" — ${blocks.length} dated revision(s)`);
        for (const b of blocks) {
          const from = /<APPLICABLEFROM>([^<]*)<\/APPLICABLEFROM>/.exec(b)?.[1]?.trim() ?? "(none)";
          const taxability = /<TAXABILITY>([^<]*)<\/TAXABILITY>/.exec(b)?.[1]?.trim() ?? "";
          console.log(`   from ${from}  CGST ${head(b, "CGST")}  SGST ${head(b, "SGST/UTGST")}  IGST ${head(b, "IGST")}  ${taxability}`);
        }
      }
    }
    console.log(`\n${label}s by number of dated GST revisions:`);
    for (const [n, c] of [...counts].sort((a, b) => a[0] - b[0])) console.log(`   ${c} object(s) with ${n} revision(s)`);
  }
})();
