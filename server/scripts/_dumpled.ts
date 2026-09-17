import { tallyPost } from "../src/tally.js";
import { allFieldsXml, company, fld } from "./push-fidelity.js";
const U = process.env.TALLY_URL || "http://localhost:9000";
(async () => {
  const co = await company();
  const xml = await tallyPost(U, allFieldsXml(co, "Ledger"), 180_000, true) as string;
  const all = [...xml.matchAll(/<LEDGER\b([^>]*)>([\s\S]*?)<\/LEDGER>/g)]
    .map(m => ({ name: /(?:^|\s)NAME="([^"]*)"/.exec(m[1])?.[1] ?? "", body: m[2] }));
  console.log(`parsed ${all.length} ledgers; named: ${all.filter(l=>l.name).length}`);
  const target = process.argv[2] || "TOGO";
  const pick = all.find(l => l.name.toUpperCase().includes(target.toUpperCase())) ?? all[0];
  console.log(`\n=== ${pick.name} ===`);
  // nested blocks
  for (const [, block, inner] of pick.body.matchAll(/<([A-Z0-9_.]+\.LIST)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)) {
    const kids = [...inner.matchAll(/<([A-Z0-9_.]+)(?:\s[^>]*)?>([^<]*)<\/\1>/gi)]
      .filter(k => k[2].trim()).map(k => `${k[1]}=${k[2].trim().slice(0,46)}`);
    console.log(`  [${block}] ${kids.join("  ") || "(empty)"}`);
  }
  console.log("  --- flat, address/state/gst related ---");
  for (const t of ["ADDRESS","LEDSTATENAME","STATENAME","PRIORSTATENAME","COUNTRYNAME","PINCODE","PARTYGSTIN","GSTREGISTRATIONTYPE","LEDGERPHONE","LEDGERMOBILE","EMAIL","PARENT","BILLCREDITPERIOD"]) {
    const v = fld(pick.body, t);
    console.log(`  ${t.padEnd(22)} ${v ? v.slice(0,60) : "(absent)"}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
