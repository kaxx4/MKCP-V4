/**
 * T11 read-only: where does Tally keep an item's own HSN? (found 13-Nov-2026 by master-jobs-dummy.ts: an item made by the stock item builder
 * with its own HSN reads back that HSN from Tally, but the masters reader's `hsnFor` returned its stock group's.)
 *
 * One request: every stock item with its GstDetails and HsnDetails blocks, counted. Prints counts only, no names, no codes. Writes nothing.
 *   A  items with HSNDETAILS.LIST carrying a declared code (what hsnRevisions() reads today)
 *   B  items with an HSNCODE inside GSTDETAILS.LIST (what the stock item builder writes)
 *   C  B but not A: the items whose own HSN the masters reader cannot see
 *   D  A and B both, with different codes
 *
 *   cd server; npx tsx scripts/rigs/t11-probe-item-hsn.ts
 */
import "dotenv/config";
import { preflight } from "./lib/t11.js";
import { makeLive, indiaToday, turn } from "./lib/t11Live.js";
import { tallyPost } from "../../src/tally.js";
import { escapeXml } from "../../src/services/xml.js";
import { blocksOf } from "../../src/services/tallyRequest.js";

(async () => {
  const p = await preflight();
  const l = makeLive(p, indiaToday(), "000000");
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>T11ItemHsn</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${escapeXml(p.company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="T11ItemHsn" ISMODIFY="No"><TYPE>StockItem</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>GstDetails</NATIVEMETHOD><NATIVEMETHOD>HsnDetails</NATIVEMETHOD>
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw = (await turn(l, "read every item's GST and HSN blocks", () => tallyPost(p.tallyUrl, xml, 300_000, true))) as string;
  const items = blocksOf(raw, "STOCKITEM").filter((b) => /<NAME>/.test(b) || /NAME=/.test(b));
  const tag = (s: string, t: string) => /<([A-Z]+)>/.test(s) ? (new RegExp(`<${t}>\\s*([^<]*?)\\s*</${t}>`).exec(s)?.[1] ?? "") : "";
  let a = 0, b = 0, c = 0, d = 0, none = 0;
  for (const it of items) {
    const declared = [...it.matchAll(/<HSNDETAILS\.LIST>([\s\S]*?)<\/HSNDETAILS\.LIST>/g)].map((m) => m[1])
      .filter((x) => tag(x, "HSNCODE") && !/as per/i.test(tag(x, "SRCOFHSNDETAILS")));
    const inGst = [...it.matchAll(/<GSTDETAILS\.LIST>([\s\S]*?)<\/GSTDETAILS\.LIST>/g)].map((m) => tag(m[1], "HSNCODE")).filter(Boolean);
    const hasA = declared.length > 0, hasB = inGst.length > 0;
    if (hasA) a++;
    if (hasB) b++;
    if (hasB && !hasA) c++;
    if (hasA && hasB && !inGst.every((g) => declared.some((x) => tag(x, "HSNCODE") === g))) d++;
    if (!hasA && !hasB) none++;
  }
  console.log(`items read: ${items.length}`);
  console.log(`  A  declared in HSNDETAILS.LIST (read by the masters reader today): ${a}`);
  console.log(`  B  an HSNCODE inside GSTDETAILS.LIST (what the item builder writes): ${b}`);
  console.log(`  C  B but not A (own HSN the masters reader cannot see): ${c}`);
  console.log(`  D  both, with different codes: ${d}`);
  console.log(`  neither (inherits its stock group's HSN): ${none}`);
  process.exit(0);
})().catch((e) => { console.error(`FAILED: ${(e as Error).message}`); process.exit(2); });
