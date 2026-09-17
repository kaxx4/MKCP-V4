/* Can a TARGETED field list reach the nested blocks, or only the * wildcard? */
import { tallyPost } from "../../src/tally.js";
import { U, company, esc, objects, fld, block, flds } from "./harness.js";
const want = ["Name","Parent","PriorStateName","PartyGSTIN","LedStateName",
              "LedMailingDetails","LedGSTRegDetails","Address","PinCode","CountryName"];
(async () => {
  const co = await company();
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkP</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkP" ISMODIFY="No"><TYPE>Ledger</TYPE>
${want.map(w=>`<NATIVEMETHOD>${w}</NATIVEMETHOD>`).join("")}
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const res = await tallyPost(U, xml, 120_000, true) as string;
  console.log(`bytes ${res.length}`);
  const togo = objects(res, "LEDGER").find(l => /TOGO CYCLES/i.test(l.name));
  if (!togo) { console.log("TOGO not found"); return; }
  const mail = block(togo.body, "LEDMAILINGDETAILS\.LIST");
  const reg  = block(togo.body, "LEDGSTREGDETAILS\.LIST");
  console.log(`  PRIORSTATENAME        ${fld(togo.body,"PRIORSTATENAME") || "(absent)"}`);
  console.log(`  PARTYGSTIN            ${fld(togo.body,"PARTYGSTIN") || "(absent)"}`);
  console.log(`  LEDSTATENAME          ${fld(togo.body,"LEDSTATENAME") || "(absent)"}`);
  console.log(`  mailing block         ${mail ? "present" : "(absent)"}  state=${fld(mail,"STATE")||"-"} pincode=${fld(mail,"PINCODE")||"-"}`);
  console.log(`  address lines         ${JSON.stringify(flds(block(mail,"ADDRESS\.LIST")||mail,"ADDRESS"))}`);
  console.log(`  gst reg block         ${reg ? "present" : "(absent)"}  gstin=${fld(reg,"GSTIN")||"-"} state=${fld(reg,"STATE")||"-"}`);
})().catch(e => { console.error(e); process.exit(1); });
