import { tallyPost } from "../../src/tally.js";
import { U, company, esc, objects, fld } from "./harness.js";
(async () => {
  const co = await company();
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkG</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkG" ISMODIFY="No"><TYPE>Ledger</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>Parent</NATIVEMETHOD><NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD><NATIVEMETHOD>LedGSTRegDetails</NATIVEMETHOD>
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const res = await tallyPost(U, xml, 180_000, true) as string;
  const parties = objects(res,"LEDGER").filter(l=>l.name && /Sundry (Debtors|Creditors)/i.test(fld(l.body,"PARENT")));
  const show = (label:string, pick:(flat:string,nested:boolean)=>boolean) => {
    const rows = parties.filter(p => {
      const flat = fld(p.body,"PARTYGSTIN");
      const blocks = [...p.body.matchAll(/<LEDGSTREGDETAILS\.LIST>([\s\S]*?)<\/LEDGSTREGDETAILS\.LIST>/gi)].map(m=>m[1]);
      return pick(flat, blocks.some(b=>fld(b,"GSTIN")));
    }).slice(0,4);
    console.log(`\n${label}`);
    for (const p of rows) {
      const blocks = [...p.body.matchAll(/<LEDGSTREGDETAILS\.LIST>([\s\S]*?)<\/LEDGSTREGDETAILS\.LIST>/gi)].map(m=>m[1]);
      console.log(`  ${p.name}`);
      console.log(`    flat PARTYGSTIN = ${fld(p.body,"PARTYGSTIN") || "(empty)"}`);
      blocks.forEach((b,i)=>console.log(`    block ${i}: from=${fld(b,"APPLICABLEFROM")||"-"} type=${fld(b,"GSTREGISTRATIONTYPE")||"-"} gstin=${fld(b,"GSTIN")||"(none)"} state=${fld(b,"STATE")||"-"}`));
    }
  };
  show("── nested only (sync blind) ──", (flat,nested)=>!flat && nested);
  show("── both present (works) ──", (flat,nested)=>!!flat && nested);
  console.log("");
})().catch(e => { console.error(e); process.exit(1); });
