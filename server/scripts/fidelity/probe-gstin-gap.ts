import { tallyPost } from "../../src/tally.js";
import { U, company, esc, objects, fld, block } from "./harness.js";
const F = ["Name","Parent","PartyGSTIN","LedStateName","LedGSTRegDetails"];
(async () => {
  const co = await company();
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkG</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkG" ISMODIFY="No"><TYPE>Ledger</TYPE>
${F.map(w=>`<NATIVEMETHOD>${w}</NATIVEMETHOD>`).join("")}</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const res = await tallyPost(U, xml, 180_000, true) as string;
  const parties = objects(res,"LEDGER").filter(l=>l.name && /Sundry (Debtors|Creditors)/i.test(fld(l.body,"PARENT")));
  let flatOnly=0, nestedOnly=0, both=0, neither=0; const examples:string[]=[];
  for (const p of parties) {
    const flat = fld(p.body,"PARTYGSTIN");
    const nested = fld(block(p.body,"LEDGSTREGDETAILS\.LIST"),"GSTIN");
    if (flat && nested) both++;
    else if (flat) flatOnly++;
    else if (nested) { nestedOnly++; if (examples.length<6) examples.push(`${p.name} → ${nested}`); }
    else neither++;
  }
  console.log(`\nparties ${parties.length}  (one response, like for like)`);
  console.log(`  both flat and nested : ${both}`);
  console.log(`  flat only            : ${flatOnly}`);
  console.log(`  NESTED ONLY          : ${nestedOnly}   ← invisible to the sync`);
  console.log(`  no GSTIN at all      : ${neither}`);
  if (examples.length) { console.log(`\n  examples the sync cannot see:`); examples.forEach(e=>console.log(`    ${e}`)); }
  console.log("");
})().catch(e => { console.error(e); process.exit(1); });
