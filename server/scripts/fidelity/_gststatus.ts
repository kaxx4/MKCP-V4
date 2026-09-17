import { tallyPost } from "../../src/tally.js";
import { U, company, vouchersOnDayXml, objects, fld } from "./harness.js";
(async () => {
  const co = await company();
  const mine = objects(await tallyPost(U, vouchersOnDayXml(co,"2026-09-17"),180_000,true) as string,"VOUCHER")
    .find(v => /ZZTEST sales local/.test(fld(v.body,"NARRATION")));
  const real = objects(await tallyPost(U, vouchersOnDayXml(co,"2026-09-14"),180_000,true) as string,"VOUCHER")
    .find(v => fld(v.body,"VOUCHERNUMBER")==="26-27/0662");
  const tagsOf = (b:string) => new Map([...b.matchAll(/<([A-Z0-9_]+)>([^<]*)<\/\1>/gi)].map(m=>[m[1],m[2].trim()]));
  const a = tagsOf(mine!.body), r = tagsOf(real!.body);
  const keys = [...new Set([...a.keys(),...r.keys()])].filter(k=>/GST|RET|TAX|STAT/i.test(k)).sort();
  console.log(`\n  tag                                    ZZTEST push        real invoice`);
  let diffs = 0;
  for (const k of keys) {
    const va = a.get(k) ?? "(absent)", vr = r.get(k) ?? "(absent)";
    if (va === vr) continue;
    diffs++;
    console.log(`  ${k.padEnd(38)} ${va.slice(0,18).padEnd(19)} ${vr.slice(0,20)}`);
  }
  console.log(`\n  ${diffs} GST-ish tags differ out of ${keys.length}`);
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });
