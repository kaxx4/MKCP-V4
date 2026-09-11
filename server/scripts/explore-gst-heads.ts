/**
 * What duty heads does Tally actually publish per item/stock group, and what is
 * the COMBINED rate?
 *
 * `tallyMasters.gstRate` is parsed from the CGST duty head alone. CGST is half
 * of an intra-state GST rate (CGST 9 + SGST 9 = 18), so the field's name
 * promises a total and delivers a component. Nothing does arithmetic with it
 * today — pushGuard only tests it for zero — but the next caller that does will
 * halve every tax figure in the app.
 *
 * This dumps the real duty-head block so the fix is based on what Tally sends.
 *
 *   npx tsx scripts/explore-gst-heads.ts [itemNameFragment]
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const want = (process.argv[2] ?? "").toUpperCase();

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;

  const ask = (type: string, fields: string[]) =>
    tallyPost(U, `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkGst</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkGst" ISMODIFY="No"><TYPE>${type}</TYPE>
${fields.map((f) => `<NATIVEMETHOD>${f}</NATIVEMETHOD>`).join("")}
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`, 240_000, true) as Promise<string>;

  // Stock groups are where 453 of 489 items get their rate, so look there too.
  for (const [label, type] of [["stock group", "StockGroup"], ["item", "StockItem"]] as const) {
    const raw = await ask(type, ["Name", "GSTDetails"]);
    const blocks = [...raw.matchAll(new RegExp(`<${type.toUpperCase()}\\b([^>]*)>([\\s\\S]*?)</${type.toUpperCase()}>`, "g"))];

    // Count every duty head present, and the rate values each carries.
    const heads = new Map<string, Map<string, number>>();
    let withDetails = 0;
    let sample = "";
    for (const [, attrs, body] of blocks) {
      const name = /(?:^|\s)NAME="([^"]*)"/.exec(attrs)?.[1] ?? "";
      const pairs = [...body.matchAll(
        /<GSTRATEDUTYHEAD>\s*([^<]*?)\s*<\/GSTRATEDUTYHEAD>[\s\S]{0,300}?<GSTRATE>\s*([^<]*?)\s*<\/GSTRATE>/g)];
      if (pairs.length) withDetails++;
      for (const [, head, rate] of pairs) {
        if (!heads.has(head)) heads.set(head, new Map());
        const m = heads.get(head)!;
        m.set(rate, (m.get(rate) ?? 0) + 1);
      }
      if (!sample && pairs.length >= 2 && (!want || name.toUpperCase().includes(want))) {
        const blk = /<GSTDETAILS\.LIST>[\s\S]*?<\/GSTDETAILS\.LIST>/.exec(body);
        sample = `"${name}"\n${(blk?.[0] ?? body).slice(0, 1800)}`;
      }
    }

    console.log(`\n══ ${label} — ${blocks.length} total, ${withDetails} carrying GST details`);
    for (const [head, rates] of heads) {
      const top = [...rates].sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([r, n]) => `${r}×${n}`).join("  ");
      console.log(`  ${head.padEnd(14)} ${top}`);
    }
    if (sample) console.log(`\nsample\n${sample}\n`);
  }
})();
