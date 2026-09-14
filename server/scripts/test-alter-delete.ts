/**
 * The verbs beyond "create": Alter, Delete — and Sales Orders.
 *
 * Creating is only half a pipeline. Without alter and delete every correction
 * needs a person in Tally, which defeats the point of automating entry.
 *
 * The governing discovery: **Tally addresses an existing voucher by REMOTEID, an
 * identity the CALLER assigns at creation.** A voucher created without one can
 * only ever be created — `ACTION="Alter"` on it does not fail, it performs a
 * Create and returns `created=1`, which reads as success while duplicating real
 * money in the books.
 *
 *   npx tsx scripts/test-alter-delete.ts --push
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters } from "../src/services/tallyMasters.js";
import { safePush } from "../src/services/safePush.js";
import type { VoucherPayload } from "../src/types.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const PUSH = process.argv.includes("--push");
const TAG = `AD${Date.now().toString().slice(-6)}`;
const TODAY = new Date().toISOString().slice(0, 10);

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`); pass++; }
  else { console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); fail++; }
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const fld = (b: string, t: string) => {
  const m = new RegExp(`<${t}[^>]*>([^<]*)</${t}>`).exec(b);
  return m ? unesc(m[1].trim()) : "";
};
const lead = (s: string) => { const m = /^\s*(-?[\d.]+)/.exec(s.replace(/,/g, "")); return m ? parseFloat(m[1]) : NaN; };
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Read one date's vouchers (Day Book ignores date ranges on this install). */
async function vouchersOn(company: string, iso: string): Promise<string[]> {
  const stamp = parseInt(iso.replace(/-/g, ""), 10);
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>AdVerify</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="AdVerify" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>Narration</NATIVEMETHOD>
<NATIVEMETHOD>Guid</NATIVEMETHOD><NATIVEMETHOD>MasterId</NATIVEMETHOD><NATIVEMETHOD>AlterId</NATIVEMETHOD>
<NATIVEMETHOD>IsCancelled</NATIVEMETHOD><NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD>
<NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD><NATIVEMETHOD>LedgerEntries</NATIVEMETHOD>
<NATIVEMETHOD>AllInventoryEntries</NATIVEMETHOD>
<FILTER>AdVerifyDate</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="AdVerifyDate">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${stamp}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw: string = await tallyPost(TALLY_URL, xml, 180_000, true);
  return [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map(x => x[0]);
}
const byNumber = (vs: string[], num: string) => vs.filter(v => fld(v, "VOUCHERNUMBER") === num);

async function main() {
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  const m = await loadMasters(TALLY_URL, company);

  const supplier = [...m.ledgers.values()].find(l => /SUNDRY CREDITORS/i.test(l.parent) && l.state && !/WEST BENGAL/i.test(l.state))!;
  const customer = [...m.ledgers.values()].find(l => /SUNDRY DEBTORS/i.test(l.parent) && /WEST BENGAL/i.test(l.state))!;
  const item = [...m.items.values()].find(i => i.closingStock > 20 && i.closingRate > 20)!;
  const godown = [...m.godowns][0];
  console.log(`\ncompany "${company}"`);
  console.log(`supplier ${supplier.name} (${supplier.state})`);
  console.log(`item ${item.name} @ ${item.closingRate}/${item.baseUnit}\n`);

  if (!PUSH) { console.log("Pass --push to run (this writes vouchers and then removes them)."); return; }

  const PURCH = "PURCHASE ( GST CENTRAL )";
  const num = `${TAG}/1`;
  const amount = r2(2 * item.closingRate);

  const base: VoucherPayload = {
    remoteId: `MKCP|Purchase|${num}`,
    voucherType: "Purchase", date: TODAY, voucherNumber: num, reference: num,
    narration: `${TAG} original narration`, partyLedgerName: supplier.name, isInvoice: true,
    ledgerEntries: [{
      ledgerName: supplier.name, amount, isDeemedPositive: false, isPartyLedger: true,
      billAllocations: [{ name: num, billType: "New Ref", amount }],
    }],
    inventoryEntries: [{
      stockItemName: item.name, quantity: 2, unit: item.baseUnit, rate: item.closingRate,
      amount, isDeemedPositive: true, salesLedgerName: PURCH, godownName: godown, batchName: "Primary Batch",
    }],
  };

  // ── 1. Create ────────────────────────────────────────────────────────────
  console.log("Creating a voucher to work on:");
  const created = await safePush(TALLY_URL, company, base);
  check("created and verified", created.ok, created.voucherId ?? created.errors[0]);
  if (!created.ok) { report(); return; }

  let vs = await vouchersOn(company, TODAY);
  const alterId0 = fld(byNumber(vs, num)[0] ?? "", "ALTERID");
  console.log(`      alterId=${alterId0}`);

  // ── 2. Alter the narration ───────────────────────────────────────────────
  console.log("\nAltering in place:");
  const newNarration = `${TAG} ALTERED narration`;
  const aRes = await safePush(TALLY_URL, company, { ...base, action: "Alter", narration: newNarration });
  check("ALTER accepted and verified", aRes.ok, aRes.errors[0] ?? aRes.differences[0] ?? "altered");

  vs = await vouchersOn(company, TODAY);
  const copies = byNumber(vs, num);
  check("the narration actually changed", fld(copies[0] ?? "", "NARRATION") === newNarration,
    `stored "${fld(copies[0] ?? "", "NARRATION")}"`);
  check("it is the SAME voucher, not a duplicate", copies.length === 1,
    `${copies.length} voucher(s) carry this number`);
  check("AlterID advanced, so a sync can detect the edit",
    Number(fld(copies[0] ?? "", "ALTERID")) > Number(alterId0),
    `${alterId0} → ${fld(copies[0] ?? "", "ALTERID")}`);

  // ── 3. Alter the amounts ─────────────────────────────────────────────────
  const newAmount = r2(amount + 100);
  const repriced = await safePush(TALLY_URL, company, {
    ...base, action: "Alter", narration: newNarration,
    ledgerEntries: [{
      ledgerName: supplier.name, amount: newAmount, isDeemedPositive: false, isPartyLedger: true,
      billAllocations: [{ name: num, billType: "New Ref", amount: newAmount }],
    }],
    inventoryEntries: [{ ...base.inventoryEntries![0], rate: r2(newAmount / 2), amount: newAmount }],
  });
  check("ALTER of amounts accepted and verified", repriced.ok,
    repriced.errors[0] ?? repriced.differences[0] ?? "repriced");

  vs = await vouchersOn(company, TODAY);
  const partyLine = [...(byNumber(vs, num)[0] ?? "").matchAll(/<LEDGERENTRIES\.LIST>([\s\S]*?)<\/LEDGERENTRIES\.LIST>/g)]
    .map(x => x[1]).find(x => fld(x, "LEDGERNAME") === supplier.name);
  check("the new amount is what Tally stored",
    Math.abs(lead(fld(partyLine ?? "", "AMOUNT")) - newAmount) < 0.02,
    `stored ${lead(fld(partyLine ?? "", "AMOUNT"))}, expected ${newAmount}`);

  // ── 4. The dangerous case: Alter with no identity ────────────────────────
  const noId = await safePush(TALLY_URL, company, { ...base, action: "Alter", remoteId: undefined });
  check("Alter without a remoteId is refused before it can duplicate",
    !noId.ok && noId.stage === "guard" && /remoteId/i.test(noId.errors[0] ?? ""),
    noId.errors[0] ?? "ACCEPTED — would have duplicated");

  // ── 5. Delete ────────────────────────────────────────────────────────────
  console.log("\nDeleting:");
  const del = await safePush(TALLY_URL, company, { ...base, action: "Delete" });
  check("DELETE accepted", del.ok, del.errors[0] ?? "deleted");
  vs = await vouchersOn(company, TODAY);
  check("the voucher is gone from Tally", byNumber(vs, num).length === 0);

  // ── 6. Sales Order Note ──────────────────────────────────────────────────
  console.log("\nSales Order Note:");
  const soNum = `${TAG}/SO`;
  const soAmount = r2(3 * item.closingRate);
  const so: VoucherPayload = {
    remoteId: `MKCP|SalesOrder|${soNum}`,
    // A Sales Order reserves stock rather than moving it — isInvoice stays false,
    // which is the one exception to "Invoice Voucher View means ISINVOICE=Yes".
    voucherType: "Sales Order Note" as VoucherPayload["voucherType"],
    date: TODAY, voucherNumber: soNum, narration: `${TAG} order`,
    partyLedgerName: customer.name, isInvoice: false,
    ledgerEntries: [{ ledgerName: customer.name, amount: soAmount, isDeemedPositive: true, isPartyLedger: true }],
    inventoryEntries: [{
      stockItemName: item.name, quantity: 3, unit: item.baseUnit, rate: item.closingRate,
      amount: soAmount, isDeemedPositive: false, salesLedgerName: "SALES  ( GST W.B. )",
      godownName: godown, batchName: "Primary Batch",
    }],
  };
  const soRes = await safePush(TALLY_URL, company, so);
  check("Sales Order Note created", soRes.ok, soRes.errors[0] ?? soRes.differences[0] ?? String(soRes.voucherId));

  vs = await vouchersOn(company, TODAY);
  const stored = byNumber(vs, soNum)[0];
  check("the order reads back with its type", !!stored && fld(stored, "VOUCHERTYPENAME") === "Sales Order Note",
    stored ? `type "${fld(stored, "VOUCHERTYPENAME")}"` : "not found");
  if (stored) {
    const lines = [...stored.matchAll(/<ALLINVENTORYENTRIES\.LIST>([\s\S]*?)<\/ALLINVENTORYENTRIES\.LIST>/g)]
      .map(x => x[1]).filter(x => /<[A-Z0-9_.]+>[^<\s]/.test(x));
    check("the order carries its item line",
      lines.length === 1 && fld(lines[0], "STOCKITEMNAME") === item.name, `${lines.length} line(s)`);
  }

  // An order left open is a standing demand signal in the dashboard, so clear it.
  const soDel = await safePush(TALLY_URL, company, { ...so, action: "Delete" });
  check("the order can be deleted by its remoteId", soDel.ok, soDel.errors[0] ?? "deleted");

  report();
}

function report() {
  console.log(`\n${"─".repeat(58)}\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
