/**
 * Rebuild batch 0.4: the dummy-company Tally tests, with evidence saved.
 *
 *   npx tsx --env-file=server/.env server/scripts/test-batch04-dummy.ts <evidence-dir> [--only=reuse,note,eway,bulk,batch60]
 *
 * Each test saves the request, the response and the voucher before and after
 * into <evidence-dir>/<test>.json. Everything uses a ZZ TEST party, a ZZ TEST
 * stock item and a ZZZ-series GSTIN, and removes what it made. The bulk test
 * leaves ONE invoice on purpose so a person can watch Tally's e-invoice list;
 * it is never sent for e-invoicing (an IRN from this copy would be real).
 *
 * Writes only on a sandbox role against a local Tally (guardScriptWrites).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters, invalidateMasters, type TallyMasters } from "../src/services/tallyMasters.js";
import { buildVoucherImportXml } from "../src/services/voucherPusher.js";
import { safePush } from "../src/services/safePush.js";
import { createLedger, deleteLedger, createStockItem, deleteStockItem } from "../src/services/masterPusher.js";
import { guardScriptWrites } from "../src/services/scriptWriteGuard.js";
import type { VoucherPayload } from "../src/types.js";
guardScriptWrites("test-batch04-dummy"); // #104

const U = process.env.TALLY_URL || "http://localhost:9000";
const OUT = process.argv[2];
if (!OUT || OUT.startsWith("--")) { console.error("usage: test-batch04-dummy.ts <evidence-dir> [--only=a,b]"); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const ONLY = (process.argv.find((a) => a.startsWith("--only="))?.slice(7) ?? "reuse,note,eway,bulk,batch60").split(",");
const TODAY = new Date().toISOString().slice(0, 10);
const DAY = TODAY.replace(/-/g, "");
const STAMP = Date.now().toString().slice(-6);
const PARTY = `ZZ TEST PARTY ${STAMP}`;
const ITEM = `ZZ TEST ITEM ${STAMP}`;
const GODOWN = "Main Location";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** First NON-EMPTY value of a tag. Tally pads blocks with self-closing placeholders, which must not match. */
const fld = (x: string, t: string) => ([...x.matchAll(new RegExp(`<${t}(?:\s[^>/]*)?>([^<]*)</${t}>`, "gi"))].map((m) => m[1].trim()).find(Boolean) ?? "");
const counts = (r: string) => `CREATED=${fld(r, "CREATED")} ALTERED=${fld(r, "ALTERED")} DELETED=${fld(r, "DELETED")} ERRORS=${fld(r, "ERRORS")} EXCEPTIONS=${fld(r, "EXCEPTIONS")}${fld(r, "LINEERROR") ? ` LINEERROR=${fld(r, "LINEERROR")}` : ""}`;

type Step = { step: string; note?: string; requestXml?: string; responseXml?: string; voucher?: string | null };
const verdicts: { test: string; pass: boolean; summary: string }[] = [];
let COMPANY = "";

async function post(xml: string, ms = 120_000): Promise<string> { return (await tallyPost(U, xml, ms, true)) as string; }

/** The whole voucher (stored fields plus entry lists) for one number on today's date, or null. */
async function readVoucher(number: string): Promise<string | null> {
  const stamp = Number(DAY);
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>B04V</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="B04V" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>*</NATIVEMETHOD><NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD><NATIVEMETHOD>LedgerEntries</NATIVEMETHOD>
<NATIVEMETHOD>AllInventoryEntries</NATIVEMETHOD><NATIVEMETHOD>EWayBillDetails</NATIVEMETHOD>
<FILTER>B04VF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="B04VF">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${stamp} AND $VoucherNumber = "${esc(number)}"</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw = await post(xml, 180_000);
  const all = [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]);
  return all.length ? all.join("\n") : null;
}
const countByNumber = (v: string | null) => (v ? (v.match(/<VOUCHERNUMBER>/g) ?? []).length : 0);

async function deleteVoucher(type: string, number: string, remoteId: string): Promise<string> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(remoteId)}" VCHTYPE="${esc(type)}" ACTION="Delete"><DATE>${DAY}</DATE><VOUCHERTYPENAME>${esc(type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(number)}</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
  return post(xml, 60_000);
}

const payment = (number: string, remoteId: string, amount = 75): VoucherPayload => ({
  remoteId, voucherType: "Payment", date: TODAY, voucherNumber: number,
  narration: `ZZTEST batch04 ${STAMP}`, partyLedgerName: PARTY, isInvoice: false,
  ledgerEntries: [
    { ledgerName: PARTY, amount, isDeemedPositive: true, isPartyLedger: true },
    { ledgerName: "Cash", amount, isDeemedPositive: false, isPartyLedger: false },
  ],
} as unknown as VoucherPayload);

const sales = (type: string, number: string, remoteId: string, m: TallyMasters): VoucherPayload => {
  const it = m.items.get(ITEM)!;
  const taxable = 1000, gst = 90;
  return {
    remoteId, voucherType: type, date: TODAY, voucherNumber: number,
    narration: `ZZTEST batch04 ${STAMP}`, partyLedgerName: PARTY, isInvoice: type === "Sales",
    ledgerEntries: [
      { ledgerName: PARTY, amount: taxable + gst * 2, isDeemedPositive: true, isPartyLedger: true,
        ...(type === "Sales" ? { billAllocations: [{ name: number, billType: "New Ref", amount: taxable + gst * 2 }] } : {}) },
      { ledgerName: "OUTPUT CGST", amount: gst, isDeemedPositive: false, isPartyLedger: false },
      { ledgerName: "OUTPUT SGST", amount: gst, isDeemedPositive: false, isPartyLedger: false },
    ],
    inventoryEntries: [{
      stockItemName: ITEM, quantity: 10, unit: it.baseUnit, rate: 100, amount: taxable,
      isDeemedPositive: false, salesLedgerName: "SALES  ( GST W.B. )", godownName: GODOWN, batchName: "Primary Batch",
    }],
  } as unknown as VoucherPayload;
};

const save = (test: string, steps: Step[], pass: boolean, summary: string) => {
  writeFileSync(join(OUT, `${test}.json`), JSON.stringify({ test, company: COMPANY, pass, summary, steps }, null, 2));
  verdicts.push({ test, pass, summary });
  console.log(`  ${pass ? "PASS" : "FINDING"}  ${test} — ${summary}`);
};

// ── 1. A reused voucher number with a new REMOTEID ────────────────────────────
async function reuse(m: TallyMasters) {
  const steps: Step[] = [];
  const N = `ZZTEST/R${STAMP}`;
  const ridA = `MKCP|Payment|${N}|2026-27`, ridB = `MKCP|Payment|${N}|2026-27|B`;
  const before = await readVoucher(N);
  steps.push({ step: "before: number not in the books", voucher: before });
  const reqA = buildVoucherImportXml(COMPANY, payment(N, ridA), m);
  const resA = await post(reqA);
  steps.push({ step: "A: create with the number", requestXml: reqA, responseXml: resA, note: counts(resA), voucher: await readVoucher(N) });
  const reqB = buildVoucherImportXml(COMPANY, payment(N, ridB, 80), m);
  const resB = await post(reqB);
  const after = await readVoucher(N);
  steps.push({ step: "B: create again with the SAME number and a NEW REMOTEID", requestXml: reqB, responseXml: resB, note: counts(resB), voucher: after });
  const n = countByNumber(after);
  const delA = await deleteVoucher("Payment", N, ridA);
  const delB = await deleteVoucher("Payment", N, ridB);
  steps.push({ step: "cleanup", note: `A: ${counts(delA)} | B: ${counts(delB)}`, voucher: await readVoucher(N) });
  save("1-reused-number", steps, true,
    `second create with a reused number: ${counts(resB)}; vouchers with that number afterwards: ${n} (${n >= 2 ? "Tally KEPT BOTH, duplicate numbers allowed" : n === 1 ? "Tally kept one: second was refused or merged" : "none"})`);
}

// ── 2. Converting a Sales Order Note to an invoice ────────────────────────────
async function note(m: TallyMasters) {
  const steps: Step[] = [];
  const NOTE = "Sales Order Note";
  if (!m.voucherTypes.has(NOTE)) { save("2-note-conversion", [{ step: "no such voucher type", note: [...m.voucherTypes].join(", ") }], false, `"${NOTE}" is not a voucher type in this company`); return; }
  // A: Alter the voucher type of an existing note.
  const nA = `ZZTEST/NA${STAMP}`, ridA = `MKCP|${NOTE}|${nA}|2026-27`;
  const reqNote = buildVoucherImportXml(COMPANY, sales(NOTE, nA, ridA, m), m);
  const resNote = await post(reqNote);
  steps.push({ step: "A1: create the note", requestXml: reqNote, responseXml: resNote, note: counts(resNote), voucher: await readVoucher(nA) });
  const alterXml = reqNote.replace(/ACTION="Create"/g, 'ACTION="Alter"').replace(/VCHTYPE="[^"]*"/, 'VCHTYPE="Sales"')
    .replace(/<VOUCHERTYPENAME>[^<]*<\/VOUCHERTYPENAME>/, "<VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>");
  const resAlter = await post(alterXml);
  const afterAlter = await readVoucher(nA);
  steps.push({ step: "A2: Alter the same REMOTEID to voucher type Sales", requestXml: alterXml, responseXml: resAlter, note: counts(resAlter), voucher: afterAlter });
  const typeAfterAlter = afterAlter ? fld(afterAlter, "VOUCHERTYPENAME") : "(gone)";
  // B: delete the note, create the invoice with its own REMOTEID.
  const nB = `ZZTEST/NB${STAMP}`, ridB = `MKCP|${NOTE}|${nB}|2026-27`;
  const resNoteB = await post(buildVoucherImportXml(COMPANY, sales(NOTE, nB, ridB, m), m));
  steps.push({ step: "B1: create a second note", note: counts(resNoteB), voucher: await readVoucher(nB) });
  const delB = await deleteVoucher(NOTE, nB, ridB);
  steps.push({ step: "B2: delete the note", responseXml: delB, note: counts(delB), voucher: await readVoucher(nB) });
  const ridInv = `MKCP|Sales|${nB}|2026-27`;
  const reqInv = buildVoucherImportXml(COMPANY, sales("Sales", nB, ridInv, m), m);
  const resInv = await post(reqInv);
  const invV = await readVoucher(nB);
  steps.push({ step: "B3: create the invoice with the same number", requestXml: reqInv, responseXml: resInv, note: counts(resInv), voucher: invV });
  const typeB = invV ? fld(invV, "VOUCHERTYPENAME") : "(gone)";
  // cleanup
  const cleanup: string[] = [];
  for (const [type, num, rid] of [["Sales", nA, ridA], [NOTE, nA, ridA], ["Sales", nB, ridInv]] as const) {
    const r = await deleteVoucher(type, num, rid);
    if (/<DELETED>1/.test(r)) cleanup.push(`${type}/${num} removed`);
  }
  steps.push({ step: "cleanup", note: cleanup.join(", ") || "nothing to remove" });
  save("2-note-conversion", steps, true,
    `Alter-to-Sales: ${counts(resAlter)}, type after = "${typeAfterAlter}". Delete-then-create: delete ${counts(delB)}, invoice ${counts(resInv)}, type = "${typeB}"`);
}

// ── 3. E-way fields written by the ERP appear on the saved voucher ────────────
async function eway(m: TallyMasters) {
  const steps: Step[] = [];
  const N = `ZZTEST/E${STAMP}`, rid = `MKCP|Sales|${N}|2026-27`;
  const block = `<EWAYBILLDETAILS.LIST>
<DOCUMENTTYPE>Tax Invoice</DOCUMENTTYPE>
<CONSIGNORPLACE>ZZ TEST PLACE</CONSIGNORPLACE><CONSIGNORPINCODE>700001</CONSIGNORPINCODE>
<CONSIGNEEPLACE>ZZ TEST CONSIGNEE PLACE</CONSIGNEEPLACE><CONSIGNEEPINCODE>711101</CONSIGNEEPINCODE>
<TRANSPORTDETAILS.LIST>
<TRANSPORTMODE>Road</TRANSPORTMODE><VEHICLENUMBER>ZZ00ZZ0000</VEHICLENUMBER><VEHICLETYPE>Regular</VEHICLETYPE>
<DISTANCE>12</DISTANCE><TRANSPORTERNAME>ZZ TEST TRANSPORT</TRANSPORTERNAME>
<DOCUMENTNUMBER>ZZLR${STAMP}</DOCUMENTNUMBER><DOCUMENTDATE>${DAY}</DOCUMENTDATE>
</TRANSPORTDETAILS.LIST>
</EWAYBILLDETAILS.LIST>`;
  const base = buildVoucherImportXml(COMPANY, sales("Sales", N, rid, m), m);
  const req = base.replace(/<\/VOUCHER>/, `${block}</VOUCHER>`);
  const res = await post(req);
  const v = await readVoucher(N);
  steps.push({ step: "create a Sales invoice carrying an e-way block (no e-way number, never sent)", requestXml: req, responseXml: res, note: counts(res), voucher: v });
  const want: Record<string, string> = { VEHICLENUMBER: "ZZ00ZZ0000", TRANSPORTMODE: "Road", DISTANCE: "12", TRANSPORTERNAME: "ZZ TEST TRANSPORT", CONSIGNORPLACE: "ZZ TEST PLACE", CONSIGNEEPINCODE: "711101" };
  const ewb = v ? (/<EWAYBILLDETAILS\.LIST>[\s\S]*?<\/EWAYBILLDETAILS\.LIST>/.exec(v)?.[0] ?? "") : "";
  const got = Object.fromEntries(Object.keys(want).map((k) => [k, fld(ewb, k).replace(/&#4;\s*/g, "")]));
  const missing = Object.keys(want).filter((k) => got[k] !== want[k]);
  steps.push({ step: "compare", note: JSON.stringify({ want, got, missing }) });
  const del = await deleteVoucher("Sales", N, rid);
  steps.push({ step: "cleanup", note: counts(del), voucher: await readVoucher(N) });
  save("3-eway-fields", steps, missing.length === 0, missing.length ? `fields that did NOT read back: ${missing.join(", ")}` : "all six checked e-way fields read back exactly");
}

// ── 4. Bulk "send for e-invoicing" pickup (watch only) ────────────────────────
async function bulk(m: TallyMasters) {
  const steps: Step[] = [];
  const N = `ZZTEST/BULK${STAMP}`, rid = `MKCP|Sales|${N}|2026-27`;
  /* 0-7 C13 (5-Nov-2026): through safePush, so pushGuard and the read-back run
     on this invoice like on every real push (iron rule 1); it was a raw post. */
  const before = await readVoucher(N);
  steps.push({ step: "before: number not in the books", voucher: before });
  const r = await safePush(U, COMPANY, sales("Sales", N, rid, m));
  const req = r.requestXml ?? "", res = r.responseXml ?? "";
  const v = await readVoucher(N);
  steps.push({ step: "create ONE B2B invoice and LEAVE it for a person to look at in Tally's e-invoice list", requestXml: req, responseXml: res,
    note: `safePush ok=${r.ok} stage=${r.stage}${r.errors.length ? ` errors=${r.errors.join(" | ")}` : ""}${r.differences.length ? ` differences=${r.differences.join(" | ")}` : ""} ${res ? counts(res) : ""}`, voucher: v });
  steps.push({ step: "state", note: `IRN on the saved voucher: "${v ? fld(v, "IRN") : ""}" (empty means Tally has not marked it as sent)` });
  save("4-bulk-send-pickup", steps, !!v, `invoice ${N} left in the books for a person to check whether Tally's bulk e-invoice list shows it. NEVER press send. Remove with sweep afterwards.`);
}

// ── 7. Sixty pushes in a row ──────────────────────────────────────────────────
async function batch60() {
  const steps: Step[] = [];
  const marks: number[] = [];
  const t0 = Date.now();
  let okCount = 0;
  const rids: [string, string][] = [];
  for (let i = 1; i <= 60; i++) {
    const N = `ZZTEST/B${STAMP}-${String(i).padStart(2, "0")}`, rid = `MKCP|Payment|${N}|2026-27`;
    rids.push([N, rid]);
    const t = Date.now();
    const r = await safePush(U, COMPANY, payment(N, rid, 10 + i));
    marks.push(Date.now() - t);
    if (r.ok) okCount++;
    steps.push({ step: `push ${i}`, note: `ok=${r.ok} stage=${r.stage} ${Date.now() - t} ms` });
    if (i % 10 === 0) console.log(`    ${i}/60 done, ${Math.round((Date.now() - t0) / 1000)} s elapsed`);
  }
  const total = Math.round((Date.now() - t0) / 1000);
  let gone = 0;
  for (const [N, rid] of rids) if (/<DELETED>1/.test(await deleteVoucher("Payment", N, rid))) gone++;
  steps.push({ step: "cleanup", note: `${gone}/60 removed` });
  const avg = Math.round(marks.reduce((a, b) => a + b, 0) / marks.length);
  save("7-sixty-in-a-row", steps, okCount === 60 && gone === 60,
    `${okCount}/60 pushed and read back in ${total} s (average ${avg} ms each); ${gone}/60 cleaned up. The push lease is 120 s, so a run this long needs renewal. The renewal itself lives in Supabase and cannot be exercised from a sandbox machine.`);
}

(async () => {
  COMPANY = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  console.log(`\n  company "${COMPANY}"  tests: ${ONLY.join(", ")}  evidence: ${OUT}\n`);
  const lg = await createLedger(U, COMPANY, { name: PARTY, parent: "SUNDRY DEBTORS", state: "West Bengal", gstin: "19AAAAA0000A1Z5", address: ["ZZ TEST STREET", "ZZ TEST CITY"], pincode: "700001" });
  if (!lg.ok) { console.error("could not create the test party:", lg.notes.join(" ")); process.exit(1); }
  const it = await createStockItem(U, COMPANY, { name: ITEM, parent: "BICYCLE PARTS ( 87149990 )", baseUnit: "PC", gstRate: 18, hsn: "87149990" });
  if (!it.ok) { await deleteLedger(U, COMPANY, PARTY); console.error("could not create the test item:", it.notes.join(" ")); process.exit(1); }
  invalidateMasters();
  const m = await loadMasters(U, COMPANY);
  console.log(`  voucher types here: ${[...m.voucherTypes].join(", ")}\n`);
  try {
    if (ONLY.includes("reuse")) await reuse(m);
    if (ONLY.includes("note")) await note(m);
    if (ONLY.includes("eway")) await eway(m);
    if (ONLY.includes("bulk")) await bulk(m);
    if (ONLY.includes("batch60")) await batch60();
  } finally {
    // The bulk invoice stays on purpose; the party and item stay with it.
    if (!ONLY.includes("bulk")) {
      const di = await deleteStockItem(U, COMPANY, ITEM);
      const dl = await deleteLedger(U, COMPANY, PARTY);
      console.log(`\n  test item removed: ${di.ok}  test party removed: ${dl.ok}`);
    } else {
      console.log(`\n  LEFT IN PLACE for the bulk-send check: party "${PARTY}", item "${ITEM}", invoice ZZTEST/BULK${STAMP}`);
    }
  }
  writeFileSync(join(OUT, "summary.json"), JSON.stringify({ stamp: STAMP, company: COMPANY, verdicts }, null, 2));
})().catch((e) => { console.error("ERR:", e); process.exit(1); });
