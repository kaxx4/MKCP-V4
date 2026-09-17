import { tallyPost } from "../../src/tally.js";
import { buildLedgerXml } from "../../src/services/masterPusher.js";
import { U, MARK, company, esc, allFieldsXml, objects, fld, push } from "./harness.js";
const NAME = `${MARK} DIFF`;
(async () => {
  const co = await company();
  await push(co, buildLedgerXml({ name: NAME, parent: "Sundry Creditors", state: "West Bengal",
    country: "India", address: "TEST", gstin: "19AFLPA4406Q1Z4", gstRegistrationType: "Regular" } as any, "Create"), "create");
  const dump = await tallyPost(U, allFieldsXml(co, "Ledger"), 180_000, true) as string;
  const all = objects(dump, "LEDGER");
  const mineObj = all.find(l => l.name === NAME)!;
  const realObj = all.find(l => /ACHARIYA CYCLE STORES/i.test(l.name))!;
  const tags = (b: string) => new Map([...b.matchAll(/<([A-Z0-9_]+)>([^<]*)<\/\1>/gi)].map(m => [m[1], m[2].trim()]));
  const a = tags(mineObj.body), b = tags(realObj.body);
  const interesting = /GST|TAX|STATE|PARTY|REGIS|APPLIC|COUNTRY|DEALER/i;
  console.log(`\n  tag                          created-by-app        created-in-tally`);
  const keys = [...new Set([...a.keys(), ...b.keys()])].filter(k => interesting.test(k)).sort();
  for (const k of keys) {
    const va = a.get(k) ?? "(absent)", vb = b.get(k) ?? "(absent)";
    if (va === vb) continue;
    console.log(`  ${k.padEnd(28)} ${va.slice(0,20).padEnd(21)} ${vb.slice(0,24)}`);
  }
  await tallyPost(U, `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>All Masters</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC><DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${esc(NAME)}" ACTION="Delete"><NAME>${esc(NAME)}</NAME></LEDGER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`, 60_000, true);
  console.log("\n  (deleted)\n");
})().catch(e => { console.error(e); process.exit(1); });
