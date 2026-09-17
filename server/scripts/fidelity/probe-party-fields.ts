/**
 * What can the SYNC actually see about a party?
 *
 * Measured with the sync's OWN targeted field list, not a `NATIVEMETHOD *`
 * dump. That distinction is the whole point: `*` returns STORED fields, and
 * several of these are COMPUTED — LedStateName is absent from a `*` dump on
 * every one of 341 parties and returns "Punjab" the moment it is asked for by
 * name. A census built on `*` reports a catastrophe that is not there (G7).
 */
import { tallyPost } from "../../src/tally.js";
import { U, company, esc, objects, fld, block, flds } from "./harness.js";

const SYNC_FIELDS = ["Name","Parent","OpeningBalance","GSTIN","LedGSTIN","PartyGSTIN",
  "CreditPeriod","BillCreditPeriod","GUID","MailingName","Address","LedStateName",
  "CountryName","PinCode","Email","LedgerPhone"];

(async () => {
  const co = await company();
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkP</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkP" ISMODIFY="No"><TYPE>Ledger</TYPE>
${SYNC_FIELDS.map(w=>`<NATIVEMETHOD>${w}</NATIVEMETHOD>`).join("")}
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const res = await tallyPost(U, xml, 180_000, true) as string;
  const led = objects(res, "LEDGER").filter(l => l.name);
  const parties = led.filter(l => /Sundry (Debtors|Creditors)/i.test(fld(l.body, "PARENT")));
  const n = parties.length;
  const has = (f:(b:string)=>any) => parties.filter(p => { const v=f(p.body); return Array.isArray(v)?v.length>0:!!v; }).length;
  const mail = (b:string) => block(b,"LEDMAILINGDETAILS\.LIST");
  const addrLines = (b:string) => flds(block(mail(b),"ADDRESS\.LIST") || block(b,"ADDRESS\.LIST") || b, "ADDRESS");
  console.log(`\n${led.length} ledgers, ${n} parties (Sundry Debtors/Creditors) — SYNC'S OWN FIELD LIST\n`);
  const rows: [string, number][] = [
    ["LEDSTATENAME    → mirror.state",   has(b=>fld(b,"LEDSTATENAME"))],
    ["PARTYGSTIN      → mirror.gstin",   has(b=>fld(b,"PARTYGSTIN"))],
    ["GSTIN",                            has(b=>fld(b,"GSTIN"))],
    ["LEDGSTIN",                         has(b=>fld(b,"LEDGSTIN"))],
    ["ADDRESS lines   → mirror.address", has(b=>addrLines(b))],
    ["PINCODE",                          has(b=>fld(b,"PINCODE"))],
    ["EMAIL",                            has(b=>fld(b,"EMAIL"))],
    ["LEDGERPHONE",                      has(b=>fld(b,"LEDGERPHONE"))],
    ["BILLCREDITPERIOD",                 has(b=>fld(b,"BILLCREDITPERIOD"))],
  ];
  for (const [k,v] of rows) console.log(`  ${String(v).padStart(4)} / ${n}   ${k}`);
  const multi = parties.filter(p => addrLines(p.body).length > 1).length;
  const maxLines = Math.max(...parties.map(p => addrLines(p.body).length));
  console.log(`\n  ${multi} of ${n} parties have a MULTI-LINE address (up to ${maxLines} lines)`);
  const noState = parties.filter(p => !fld(p.body,"LEDSTATENAME"));
  console.log(`  ${noState.length} parties with NO state: ${noState.slice(0,6).map(p=>p.name).join(", ")}`);
  console.log("");
})().catch(e => { console.error(e); process.exit(1); });
