/**
 * What does Tally actually serve for the price list?
 *
 * The Price List page currently needs a human to export from Tally and import
 * here. If `FULLPRICELIST.LIST` carries the whole catalogue, that manual step
 * can go. This measures the real shape before anything is built on it.
 *
 *   npx tsx scripts/explore-pricelist.ts
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { writeFileSync } from "node:fs";

const U = process.env.TALLY_URL || "http://localhost:9000";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const collectionXml = (company: string, fields: string[]) =>
  `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkPrices</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkPrices" ISMODIFY="No"><TYPE>StockItem</TYPE>
${fields.map((f) => `<NATIVEMETHOD>${f}</NATIVEMETHOD>`).join("")}
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  console.log(`\ncompany  "${company}"\n`);

  const t0 = Date.now();
  const raw: string = await tallyPost(
    U, collectionXml(company, ["Name", "FullPriceList"]), 240_000, true,
  );
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`FULLPRICELIST  ${(raw.length / 1024 / 1024).toFixed(2)} MB in ${secs}s`);

  const items = [...raw.matchAll(/<STOCKITEM\b([^>]*)>([\s\S]*?)<\/STOCKITEM>/g)];
  console.log(`items returned  ${items.length}`);

  let withPrices = 0;
  const levels = new Map<string, number>();
  const dates = new Map<string, number>();
  const samples: string[] = [];

  for (const [, attrs, body] of items) {
    const name = /(?:^|\s)NAME="([^"]*)"/.exec(attrs)?.[1] ?? "";
    const rows = [...body.matchAll(/<FULLPRICELIST\.LIST>([\s\S]*?)<\/FULLPRICELIST\.LIST>/g)];
    if (rows.length) withPrices++;
    for (const [, r] of rows) {
      const date = /<DATE[^>]*>([^<]*)<\/DATE>/.exec(r)?.[1]?.trim() ?? "";
      if (date) dates.set(date, (dates.get(date) ?? 0) + 1);
      for (const [, lvl] of r.matchAll(/<PRICELEVEL[^>]*>([^<]*)<\/PRICELEVEL>/g)) {
        levels.set(lvl.trim(), (levels.get(lvl.trim()) ?? 0) + 1);
      }
      if (samples.length < 2 && name) samples.push(`${name}\n${r.trim().slice(0, 900)}`);
    }
  }

  console.log(`items WITH a priced entry  ${withPrices} of ${items.length}`);

  console.log(`\nprice levels`);
  for (const [lvl, n] of [...levels].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  ${JSON.stringify(lvl)}`);
  }
  // Case-only duplicates split a catalogue silently — a lookup keyed on the
  // level name would find half the rows.
  const byLower = new Map<string, string[]>();
  for (const lvl of levels.keys()) {
    const k = lvl.toLowerCase();
    byLower.set(k, [...(byLower.get(k) ?? []), lvl]);
  }
  const collisions = [...byLower.values()].filter((v) => v.length > 1);
  console.log(collisions.length
    ? `\n⚠ price levels differing ONLY by case: ${collisions.map((c) => c.join(" / ")).join(", ")}`
    : `\nno case-only duplicate price levels`);

  console.log(`\ndates present`);
  for (const [d, n] of [...dates].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(n).padStart(6)}  ${d}`);
  }

  console.log(`\nsample entries\n${samples.join("\n\n")}`);

  writeFileSync("exploration-pricelist.json", JSON.stringify({
    bytes: raw.length, seconds: Number(secs), items: items.length, withPrices,
    levels: Object.fromEntries(levels), dates: Object.fromEntries(dates),
  }, null, 2));
  console.log(`\nwrote exploration-pricelist.json`);
})();
