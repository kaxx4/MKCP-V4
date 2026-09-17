/* Why is computed PartyGSTIN empty on a party we just created?
   Varying ONE thing: the APPLICABLEFROM on the registration block. */
import { tallyPost } from "../../src/tally.js";
import { buildLedgerXml } from "../../src/services/masterPusher.js";
import { U, MARK, company, esc, objects, fld, push, importSummary } from "./harness.js";

const DATES = ["20220401", "20240401", "20260401", "20250401"];

(async () => {
  const co = await company();
  const made: string[] = [];
  for (const from of DATES) {
    const name = `${MARK} GST ${from}`;
    made.push(name);
    await push(co, buildLedgerXml({
      name, parent: "Sundry Creditors", state: "Punjab", country: "India",
      address: "TEST LINE", gstin: "03ACUPA2463R1Z7", gstRegistrationType: "Regular",
      applicableFrom: from,
    } as any, "Create"), `create ${from}`);
  }
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkT</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkT" ISMODIFY="No"><TYPE>Ledger</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD><NATIVEMETHOD>LedStateName</NATIVEMETHOD>
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const res = await tallyPost(U, xml, 120_000, true) as string;
  const all = objects(res, "LEDGER");
  console.log(`\n  applicableFrom   computed PartyGSTIN        LedStateName`);
  for (const from of DATES) {
    const l = all.find(x => x.name === `${MARK} GST ${from}`);
    console.log(`  ${from}         ${(l ? fld(l.body,"PARTYGSTIN") || "(empty)" : "(not found)").padEnd(26)} ${l ? fld(l.body,"LEDSTATENAME") || "-" : "-"}`);
  }
  for (const n of made) {
    await tallyPost(U, `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>All Masters</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC><DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${esc(n)}" ACTION="Delete"><NAME>${esc(n)}</NAME></LEDGER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`, 60_000, true);
  }
  console.log(`\n  (${made.length} test parties deleted)\n`);
})().catch(e => { console.error(e); process.exit(1); });
