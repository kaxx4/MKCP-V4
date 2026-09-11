/**
 * Can a Sales Order Note become a Sales Invoice?
 *
 * The operator's real flow: a quote/order is raised (sometimes in Tally itself),
 * and later it becomes an invoice. Tally's native mechanism for that is order
 * tracking — the invoice consumes the pending order through ORDERNO /
 * TRACKINGNUMBER — but this company reads back `USETRACKINGNUMBER=No` and
 * `ORDERNO = "Not Applicable"` on all 2,742 vouchers, and neither "Sales Order
 * Outstandings" nor "Sales Order Book" is a recognised report here. So the
 * native path looks unavailable, and the question becomes which fallback works:
 *
 *   A. Convert in place — ACTION="Alter" on the order's REMOTEID, changing the
 *      voucher type to Sales. One document, one identity, history preserved.
 *   B. Re-issue — create a separate Sales invoice from the order's lines, then
 *      delete or retire the order. Two documents.
 *
 * A is much better if Tally allows it. This finds out.
 *
 *   npx tsx scripts/test-so-to-invoice.ts --push
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters } from "../src/services/tallyMasters.js";
import { safePush } from "../src/services/safePush.js";
import type { VoucherPayload } from "../src/types.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const PUSH = process.argv.includes("--push");
const TAG = `SO${Date.now().toString().slice(-6)}`;
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
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Health gate — an error dialog freezes Tally, so stop the moment it goes quiet. */
async function healthy(): Promise<boolean> {
  try { return convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 8_000)).length > 0; }
  catch { return false; }
}

async function vouchersOn(company: string, iso: string): Promise<string[]> {
  const stamp = parseInt(iso.replace(/-/g, ""), 10);
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>SoVerify</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="SoVerify" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>Narration</NATIVEMETHOD>
<NATIVEMETHOD>Guid</NATIVEMETHOD><NATIVEMETHOD>MasterId</NATIVEMETHOD><NATIVEMETHOD>AlterId</NATIVEMETHOD>
<NATIVEMETHOD>IsInvoice</NATIVEMETHOD><NATIVEMETHOD>IsCancelled</NATIVEMETHOD>
<NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD>
<NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD><NATIVEMETHOD>LedgerEntries</NATIVEMETHOD>
<NATIVEMETHOD>AllInventoryEntries</NATIVEMETHOD>
<FILTER>SoVerifyDate</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="SoVerifyDate">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${stamp}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw: string = await tallyPost(TALLY_URL, xml, 180_000, true);
  return [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map(x => x[0]);
}

const byNumber = (vs: string[], n: string) => vs.filter(v => fld(v, "VOUCHERNUMBER") === n);

async function main() {
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  const m = await loadMasters(TALLY_URL, company);

  const customer = [...m.ledgers.values()].find(l => /SUNDRY DEBTORS/i.test(l.parent) && /WEST BENGAL/i.test(l.state))!;
  const item = [...m.items.values()].find(i => i.closingStock > 20 && i.closingRate > 20)!;
  const godown = [...m.godowns][0];

  console.log(`\ncompany  "${company}"`);
  console.log(`customer ${customer.name} (${customer.state})`);
  console.log(`item     ${item.name} @ ${item.closingRate}/${item.baseUnit}\n`);

  if (!PUSH) { console.log("Pass --push to run (writes a voucher, then removes it)."); return; }

  const SALES = "SALES  ( GST W.B. )";
  const num = `${TAG}/1`;
  const remoteId = `MKCP|Order|${num}`;
  const qty = 3;
  const amount = r2(qty * item.closingRate);

  const lines = (dp: boolean) => [{
    stockItemName: item.name, quantity: qty, unit: item.baseUnit, rate: item.closingRate,
    amount, isDeemedPositive: dp, salesLedgerName: SALES,
    godownName: godown, batchName: "Primary Batch",
  }];

  // ── 1. Raise the order ───────────────────────────────────────────────────
  console.log("1. Raise a Sales Order Note");
  const order: VoucherPayload = {
    remoteId,
    voucherType: "Sales Order Note" as VoucherPayload["voucherType"],
    date: TODAY, voucherNumber: num, narration: `${TAG} order raised`,
    partyLedgerName: customer.name, isInvoice: false,
    ledgerEntries: [{ ledgerName: customer.name, amount, isDeemedPositive: true, isPartyLedger: true }],
    inventoryEntries: lines(false),
  };
  const made = await safePush(TALLY_URL, company, order);
  check("order created", made.ok, made.errors[0] ?? made.differences[0] ?? String(made.voucherId));
  if (!made.ok) return;
  if (!await healthy()) { console.log("\n⚠ Tally stopped answering. STOPPING."); return; }

  let vs = await vouchersOn(company, TODAY);
  const beforeCount = byNumber(vs, num).length;
  const before = byNumber(vs, num)[0];
  check("reads back as Sales Order Note", !!before && fld(before, "VOUCHERTYPENAME") === "Sales Order Note",
    before ? `type "${fld(before, "VOUCHERTYPENAME")}" · isInvoice=${fld(before, "ISINVOICE")} · masterId=${fld(before, "MASTERID")}` : "not found");
  const masterIdBefore = before ? fld(before, "MASTERID") : "";

  // ── 2. Convert in place ──────────────────────────────────────────────────
  // Same REMOTEID, same number, but now a Sales invoice: ISINVOICE flips to Yes
  // and the stock line reverses to outward. If Tally honours this, one document
  // changed identity and the order is GONE rather than duplicated.
  console.log("\n2. Alter that same REMOTEID into a Sales invoice");
  const converted: VoucherPayload = {
    remoteId, action: "Alter",
    voucherType: "Sales",
    date: TODAY, voucherNumber: num, narration: `${TAG} converted to invoice`,
    partyLedgerName: customer.name, isInvoice: true,
    ledgerEntries: [{
      ledgerName: customer.name, amount, isDeemedPositive: true, isPartyLedger: true,
      billAllocations: [{ name: num, billType: "New Ref", amount }],
    }],
    inventoryEntries: lines(false),
  };
  const conv = await safePush(TALLY_URL, company, converted);
  check("alter-to-Sales accepted", conv.ok, conv.errors[0] ?? conv.differences[0] ?? String(conv.voucherId));
  if (!await healthy()) { console.log("\n⚠ Tally stopped answering. STOPPING."); return; }

  // ── 3. What actually happened? ───────────────────────────────────────────
  console.log("\n3. Inspect the result");
  vs = await vouchersOn(company, TODAY);
  const after = byNumber(vs, num);
  check("still exactly one voucher with this number (no duplicate)",
    after.length === beforeCount, `${beforeCount} before → ${after.length} after`);
  if (after.length) {
    // This company spells the type "SALES"; Tally matches case-insensitively on
    // import but stores and returns its own spelling.
    const t = fld(after[0], "VOUCHERTYPENAME");
    check("voucher type is now Sales", t.toUpperCase() === "SALES", `type "${t}"`);
    check("ISINVOICE flipped to Yes", fld(after[0], "ISINVOICE") === "Yes", `isInvoice=${fld(after[0], "ISINVOICE")}`);
    check("kept the same MASTERID (converted, not replaced)",
      fld(after[0], "MASTERID") === masterIdBefore,
      `${masterIdBefore} → ${fld(after[0], "MASTERID")}`);
    const inv = [...after[0].matchAll(/<ALLINVENTORYENTRIES\.LIST>([\s\S]*?)<\/ALLINVENTORYENTRIES\.LIST>/g)]
      .map(x => x[1]).filter(x => /<[A-Z0-9_.]+>[^<\s]/.test(x));
    check("item line survived the conversion", inv.length === 1 && fld(inv[0], "STOCKITEMNAME") === item.name,
      `${inv.length} line(s)`);
    const bills = [...after[0].matchAll(/<BILLALLOCATIONS\.LIST>([\s\S]*?)<\/BILLALLOCATIONS\.LIST>/g)]
      .map(x => x[1]).filter(x => /<[A-Z0-9_.]+>[^<\s]/.test(x));
    check("invoice now creates a bill reference", bills.length >= 1,
      bills.length ? `${bills.length}× — "${fld(bills[0], "NAME")}" ${fld(bills[0], "BILLTYPE")}` : "none");
  }

  // ── 3b. Put a trade discount on that invoice ─────────────────────────────
  // 66% of real sales carry a `TRADE DISCOUNTS / H.C.` line, and every builder
  // in both repos ties a line's SIGN to its debit flag:
  //     signed = isDeemedPositive ? -abs(amount) : +abs(amount)
  // Real discount lines read back as ISDEEMEDPOSITIVE=No with a NEGATIVE amount
  // — a negative credit, which that expression cannot produce. The decisive
  // question is whether it matters: if Tally normalises the debit encoding into
  // the same stored shape, no builder surgery is needed.
  console.log("\n3b. Add a TRADE DISCOUNTS line to the converted invoice");
  const DISCOUNT = "TRADE DISCOUNTS / H.C.";
  const disc = r2(amount * 0.02);
  const withDisc = await safePush(TALLY_URL, company, {
    ...converted,
    narration: `${TAG} converted, discounted`,
    ledgerEntries: [
      {
        ledgerName: customer.name, amount: r2(amount - disc), isDeemedPositive: true, isPartyLedger: true,
        billAllocations: [{ name: num, billType: "New Ref", amount: r2(amount - disc) }],
      },
      // The only encoding the current builders can express: debit side.
      { ledgerName: DISCOUNT, amount: disc, isDeemedPositive: true, isPartyLedger: false },
    ],
  });
  check("invoice with a discount line accepted", withDisc.ok,
    withDisc.errors[0] ?? withDisc.differences[0] ?? String(withDisc.voucherId));
  if (!await healthy()) { console.log("\n⚠ Tally stopped answering. STOPPING."); return; }

  vs = await vouchersOn(company, TODAY);
  const dv = byNumber(vs, num)[0];
  if (dv) {
    const led = [...dv.matchAll(/<LEDGERENTRIES\.LIST>([\s\S]*?)<\/LEDGERENTRIES\.LIST>/g)]
      .map(x => x[1]).filter(x => /<[A-Z0-9_.]+>[^<\s]/.test(x));
    const dl = led.find(l => fld(l, "LEDGERNAME").toUpperCase().includes("TRADE DISCOUNT"));
    check("the discount line is stored on the invoice", !!dl, dl ? "" : `${led.length} ledger lines, none a discount`);
    if (dl) {
      const storedAmt = parseFloat(fld(dl, "AMOUNT"));
      const storedDp = fld(dl, "ISDEEMEDPOSITIVE");
      console.log(`      sent  ISDEEMEDPOSITIVE=Yes AMOUNT=${(-disc).toFixed(2)}`);
      console.log(`      tally ISDEEMEDPOSITIVE=${storedDp} AMOUNT=${storedAmt.toFixed(2)}`);
      // The real-world shape, seen on 444 live vouchers.
      check("Tally normalised it to the real-world shape (No / negative)",
        storedDp === "No" && storedAmt < 0,
        storedDp === "Yes" ? "kept the debit encoding — builders must be able to emit a negative credit" : "");
    }
  }

  // ── 4. Clean up ──────────────────────────────────────────────────────────
  console.log("\n4. Remove the test voucher");
  const del = await safePush(TALLY_URL, company, { ...converted, action: "Delete" });
  check("deleted by REMOTEID", del.ok, del.errors[0] ?? "");
  vs = await vouchersOn(company, TODAY);
  check("gone from the books", byNumber(vs, num).length === 0, `${byNumber(vs, num).length} left`);

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(await healthy() ? "Tally still healthy." : "⚠ Tally is NOT responding — it may be showing a dialog.");
}

main().catch(e => { console.error("FAILED:", e.message); });
