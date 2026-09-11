/**
 * MOCK RUN — every function the daily interface will execute, end to end.
 *
 * Not unit tests. Each block performs the real operation against the live
 * company, reads it back out of Tally, checks the stored shape, and then removes
 * what it made. The point is to know — before committing to a build order —
 * which capabilities actually work, which have caveats, and which are blocked.
 *
 * Discipline, because an error dialog freezes Tally and costs a restart:
 *   - one operation at a time, health-checked between phases
 *   - everything goes through safePush (guard → gate → push → read back → diff)
 *   - every voucher carries a REMOTEID so it can be removed again
 *   - the run aborts the moment Tally stops answering
 *
 *   npx tsx scripts/mock-run-all.ts --push
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters, type TallyMasters } from "../src/services/tallyMasters.js";
import { safePush } from "../src/services/safePush.js";
import { loadOpenBills, billsForParty, allocateFIFO, receivableBills, payableBills, daysOverdue } from "../src/services/billSettlement.js";
import { planFromBankRows } from "../src/services/bankToReceipts.js";
import { guardVoucher } from "../src/services/pushGuard.js";
import type { VoucherPayload, LedgerEntry } from "../src/types.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const PUSH = process.argv.includes("--push");
const TAG = `MR${Date.now().toString().slice(-6)}`;
const TODAY = new Date().toISOString().slice(0, 10);

let pass = 0, fail = 0, skip = 0;
const results: { phase: string; name: string; ok: boolean | null; detail: string }[] = [];
let phase = "";
const P = (p: string) => { phase = p; console.log(`\n\x1b[1m── ${p} ${"─".repeat(Math.max(0, 58 - p.length))}\x1b[0m`); };
const ok = (name: string, good: boolean, detail = "") => {
  results.push({ phase, name, ok: good, detail });
  if (good) { console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); pass++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); fail++; }
};
const note = (name: string, detail: string) => {
  results.push({ phase, name, ok: null, detail });
  console.log(`  \x1b[33m•\x1b[0m ${name} — ${detail}`); skip++;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const fld = (b: string, t: string) => {
  const m = new RegExp(`<${t}[^>]*>([^<]*)</${t}>`).exec(b);
  return m ? unesc(m[1].replace(/&#\d+;/g, "").trim()) : "";
};
const lead = (s: string) => { const m = /^\s*(-?[\d.]+)/.exec(String(s).replace(/,/g, "")); return m ? parseFloat(m[1]) : NaN; };
const r2 = (x: number) => Math.round(x * 100) / 100;
const inr = (n: number) => "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
const populated = (xs: string[]) => xs.filter(x => /<[A-Z0-9_.]+>[^<\s]/.test(x));

async function healthy(): Promise<boolean> {
  try { return convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 8_000)).length > 0; }
  catch { return false; }
}

async function vouchersOn(company: string, iso: string): Promise<string[]> {
  const stamp = parseInt(iso.replace(/-/g, ""), 10);
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MrVerify</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MrVerify" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>Narration</NATIVEMETHOD>
<NATIVEMETHOD>Guid</NATIVEMETHOD><NATIVEMETHOD>MasterId</NATIVEMETHOD><NATIVEMETHOD>AlterId</NATIVEMETHOD>
<NATIVEMETHOD>IsInvoice</NATIVEMETHOD><NATIVEMETHOD>IsCancelled</NATIVEMETHOD>
<NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD>
<NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD><NATIVEMETHOD>LedgerEntries</NATIVEMETHOD>
<NATIVEMETHOD>AllInventoryEntries</NATIVEMETHOD>
<FILTER>MrVerifyDate</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MrVerifyDate">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${stamp}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw: string = await tallyPost(TALLY_URL, xml, 240_000, true);
  return [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map(x => x[0]);
}
const byNumber = (vs: string[], n: string) => vs.filter(v => fld(v, "VOUCHERNUMBER") === n);

/** Report export, used for the read-side capabilities. */
async function report(company: string, id: string, from?: string, to?: string): Promise<string> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>${id}</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
${from ? `<SVFROMDATE TYPE="Date">${from}</SVFROMDATE><SVTODATE TYPE="Date">${to}</SVTODATE>` : ""}
</STATICVARIABLES></DESC></BODY></ENVELOPE>`;
  return tallyPost(TALLY_URL, xml, 240_000, true);
}

/** Every voucher this run creates is registered here so the finally block removes it. */
const made: VoucherPayload[] = [];
async function push(company: string, p: VoucherPayload, register = true) {
  const res = await safePush(TALLY_URL, company, p);
  if (register && res.voucherId) made.push(p);
  return res;
}

async function main() {
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  const m: TallyMasters = await loadMasters(TALLY_URL, company);

  const wbCustomer = [...m.ledgers.values()].find(l => /SUNDRY DEBTORS/i.test(l.parent) && /WEST BENGAL/i.test(l.state))!;
  const outSupplier = [...m.ledgers.values()].find(l => /SUNDRY CREDITORS/i.test(l.parent) && l.state && !/WEST BENGAL/i.test(l.state))!;
  const item = [...m.items.values()].find(i => i.closingStock > 40 && i.closingRate > 20)!;
  const item2 = [...m.items.values()].find(i => i.name !== item.name && i.closingStock > 40 && i.closingRate > 20)!;
  const godown = [...m.godowns][0];
  const BANK = "HDFC BANK";
  const SALES = "SALES  ( GST W.B. )";
  const PURCH = "PURCHASE ( GST CENTRAL )";
  const DISCOUNT = "TRADE DISCOUNTS / H.C.";

  console.log(`\ncompany   "${company}"`);
  console.log(`customer  ${wbCustomer.name} (${wbCustomer.state})`);
  console.log(`supplier  ${outSupplier.name} (${outSupplier.state})`);
  console.log(`items     ${item.name} @ ${item.closingRate} · ${item2.name} @ ${item2.closingRate}`);
  if (!PUSH) { console.log("\nPass --push to run. Every voucher is deleted again at the end."); return; }

  try {
    // ═══════════════════════════════════════════════════════════════════
    P("A · READ — what Tally will answer without us computing it");

    const pl = await report(company, "Profit and Loss", "1-Apr-2026", "11-Sep-2026");
    const plLines = [...pl.matchAll(/<DSPDISPNAME>([^<]*)</g)].map(x => x[1].replace(/&#\d+;/g, "").trim());
    const plAmts = [...pl.matchAll(/<BSMAINAMT>([^<]+)</g)].map(x => lead(x[1])).filter(Number.isFinite);
    ok("period P&L returns named lines with amounts", plLines.length > 3 && plAmts.length > 0,
      `${plLines.length} lines, e.g. ${plLines.slice(0, 3).join(" · ")}`);

    const tb = await report(company, "Trial Balance", "1-Apr-2026", "11-Sep-2026");
    ok("trial balance returns groups", [...tb.matchAll(/<DSPDISPNAME>/g)].length > 3,
      `${[...tb.matchAll(/<DSPDISPNAME>/g)].length} groups`);

    const cf = await report(company, "Cash Flow", "1-Apr-2026", "11-Sep-2026");
    ok("cash flow returns periods", cf.length > 400, `${cf.length} bytes`);
    if (!await healthy()) throw new Error("Tally stopped answering after reports");

    // Per-item stock valuation — the collections.ts fix
    const stk = await tallyPost(TALLY_URL, `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MrStk</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MrStk" ISMODIFY="No"><TYPE>StockItem</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>ClosingRate</NATIVEMETHOD><NATIVEMETHOD>ClosingValue</NATIVEMETHOD>
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`, 240_000, true);
    const stkItems = [...stk.matchAll(/<STOCKITEM\b[^>]*>[\s\S]*?<\/STOCKITEM>/g)].map(x => x[0]);
    const rated = stkItems.filter(s => lead(fld(s, "CLOSINGRATE")) > 0);
    ok("per-item closing rates come through", rated.length > stkItems.length * 0.9,
      `${rated.length} of ${stkItems.length} items priced`);

    // ═══════════════════════════════════════════════════════════════════
    P("B · OUTSTANDING — bills, ageing, who to call");

    const bills = await loadOpenBills(TALLY_URL, company);
    const recv = receivableBills(bills), payb = payableBills(bills);
    ok("open bills load from Tally", bills.length > 0,
      `${bills.length} bills · ${recv.length} receivable ${inr(recv.reduce((s, b) => s + b.outstanding, 0))} · ${payb.length} payable`);

    const withTerms = bills.filter(b => /\d/.test(b.creditPeriod ?? ""));
    const noTerms = bills.filter(b => !/\d/.test(b.creditPeriod ?? ""));
    ok("ageing computes where terms exist", withTerms.length > 0,
      `${withTerms.length} of ${bills.length} bills have a credit period (${Math.round(withTerms.length / bills.length * 100)}%)`);
    if (noTerms.length) {
      // daysOverdue() parses the credit period out of a string and falls back to 0.
      // A bill with no terms therefore looks due on its own bill date — i.e. maximally
      // overdue — rather than being excluded. That inflates a call list rather than
      // shortening it, which is the more dangerous failure.
      const sample = noTerms.find(b => b.closing < 0) ?? noTerms[0];
      const d = daysOverdue(sample, new Date(TODAY));
      ok("bills with NO credit period are not silently dropped", d !== null,
        `${noTerms.length} of ${bills.length} have no terms; e.g. "${sample.name}" reports ${d} days overdue with none set`);
      note("no-terms bills read as maximally overdue",
        `daysOverdue() defaults an absent credit period to 0, so the bill date becomes the due date — a call list must bucket these separately`);
    }

    const partyWithBills = recv.find(b => billsForParty(bills, b.party).length >= 2);
    if (partyWithBills) {
      const pb = billsForParty(bills, partyWithBills.party);
      const total = r2(pb.slice(0, 2).reduce((s, b) => s + b.outstanding, 0));
      const plan = allocateFIFO(pb, total);
      const summed = r2(plan.allocations.reduce((s, a) => s + a.amount, 0));
      ok("FIFO allocation is exact and oldest-first",
        Math.abs(summed - total) < 0.02 && plan.allocations[0].name === pb[0].name && plan.fullyMatched,
        `${plan.allocations.length} bills, ${inr(total)}, first = ${plan.allocations[0].name}`);
      const partial = allocateFIFO(pb, r2(pb[0].outstanding / 2));
      ok("part payment takes one bill and does not over-consume",
        partial.allocations.length === 1 && partial.onAccount === 0,
        `${partial.allocations.length} allocation(s), onAccount ${partial.onAccount}`);
      const over = allocateFIFO(pb, r2(pb.reduce((s, b) => s + b.outstanding, 0) + 5000));
      ok("unmatched surplus goes On Account, never forced onto a bill",
        over.onAccount > 0 && over.allocations.some(a => a.billType === "On Account"),
        `${inr(over.onAccount)} on account`);
    } else note("multi-bill party not found", "cannot exercise FIFO across bills in this company right now");

    if (!await healthy()) throw new Error("Tally stopped answering after bills");

    // ═══════════════════════════════════════════════════════════════════
    P("C · MONEY IN — receipt against specific bills");

    const target = recv[0];
    if (target) {
      const amt = r2(target.outstanding);
      const num = `${TAG}/R1`;
      const res = await push(company, {
        remoteId: `MKCP|Receipt|${num}`, voucherType: "Receipt", date: TODAY, voucherNumber: num,
        narration: "RTGS RECEIVED", partyLedgerName: target.party, isInvoice: false,
        ledgerEntries: [
          { ledgerName: BANK, amount: amt, isDeemedPositive: true, isPartyLedger: false,
            bankAllocation: { transactionType: "Others", transferMode: "NEFT", instrumentNumber: `UTR${TAG}`, favouring: target.party, instrumentDate: TODAY } },
          { ledgerName: target.party, amount: amt, isDeemedPositive: false, isPartyLedger: true,
            billAllocations: [{ name: target.name, billType: "Agst Ref", amount: amt }] },
        ],
      });
      ok("receipt settles a real bill (Agst Ref)", res.ok, res.errors[0] ?? res.differences[0] ?? `id ${res.voucherId}`);

      const vs = await vouchersOn(company, TODAY);
      const stored = byNumber(vs, num)[0];
      if (stored) {
        const led = populated([...stored.matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/g)].map(x => x[1]));
        const partyLine = led.find(l => fld(l, "LEDGERNAME") === target.party);
        const ba = partyLine ? populated([...partyLine.matchAll(/<BILLALLOCATIONS\.LIST>([\s\S]*?)<\/BILLALLOCATIONS\.LIST>/g)].map(x => x[1])) : [];
        ok("the bill reference is stored as Agst Ref",
          ba.length === 1 && fld(ba[0], "BILLTYPE") === "Agst Ref" && fld(ba[0], "NAME") === target.name,
          ba.length ? `"${fld(ba[0], "NAME")}" ${fld(ba[0], "BILLTYPE")}` : "none");
        const bank = led.find(l => fld(l, "LEDGERNAME") === BANK);
        const bk = bank ? populated([...bank.matchAll(/<BANKALLOCATIONS\.LIST>([\s\S]*?)<\/BANKALLOCATIONS\.LIST>/g)].map(x => x[1])) : [];
        ok("bank instrument stored (stops Tally prompting)", bk.length >= 1,
          bk.length ? `UTR ${fld(bk[0], "INSTRUMENTNUMBER")}` : "NOT STORED");
        ok("narration carries the instrument", fld(stored, "NARRATION").length > 0, `"${fld(stored, "NARRATION")}"`);
      }
    } else note("no receivable bill available", "skipping the settle-a-real-bill run");
    if (!await healthy()) throw new Error("Tally stopped answering after receipt");

    // ═══════════════════════════════════════════════════════════════════
    P("D · MONEY OUT — payment, and a bulk batch");

    // Bills must all belong to the SAME party. Mixing parties is not a harmless
    // mistake: see the cross-party check below.
    const payParty = [...new Set(payb.map(b => b.party))]
      .map(party => payb.filter(b => b.party === party && b.outstanding > 100))
      .sort((a, b) => b.length - a.length)[0] ?? [];
    const payTargets = payParty.slice(0, 9);   // 9 is the real-world maximum
    if (payTargets.length >= 2) {
      const total = r2(payTargets.reduce((s, b) => s + b.outstanding, 0));
      const num = `${TAG}/P1`;
      const res = await push(company, {
        remoteId: `MKCP|Payment|${num}`, voucherType: "Payment", date: TODAY, voucherNumber: num,
        narration: "AS PER BILL", partyLedgerName: payTargets[0].party, isInvoice: false,
        ledgerEntries: [
          { ledgerName: payTargets[0].party, amount: total, isDeemedPositive: true, isPartyLedger: true,
            billAllocations: payTargets.map(b => ({ name: b.name, billType: "Agst Ref" as const, amount: r2(b.outstanding) })) },
          { ledgerName: BANK, amount: total, isDeemedPositive: false, isPartyLedger: false,
            bankAllocation: { transactionType: "Others", transferMode: "RTGS", instrumentNumber: `UTRP${TAG}`, favouring: payTargets[0].party, instrumentDate: TODAY } },
        ],
      });
      ok(`payment settles ${payTargets.length} bills of one party on one voucher`, res.ok,
        res.differences.length ? res.differences.join(" | ") : (res.errors[0] ?? `${payTargets[0].party} ${inr(total)}`));
      if (res.differences.length) {
        console.log(`      sent: ${payTargets.map(b => `${b.name}=${b.outstanding}`).join("  ")}`);
        const vs2 = await vouchersOn(company, TODAY);
        const st = byNumber(vs2, num)[0];
        if (st) {
          const led = populated([...st.matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/g)].map(x => x[1]));
          const pl2 = led.find(l => fld(l, "LEDGERNAME") === payTargets[0].party);
          const ba = pl2 ? populated([...pl2.matchAll(/<BILLALLOCATIONS\.LIST>([\s\S]*?)<\/BILLALLOCATIONS\.LIST>/g)].map(x => x[1])) : [];
          console.log(`      tally: ${ba.map(b => `${fld(b, "NAME")}=${fld(b, "AMOUNT")}(${fld(b, "BILLTYPE")})`).join("  ") || "no allocations"}`);
        }
      }
    } else note("not enough payable bills for one party", "multi-bill payment not exercised");

    // An Agst Ref naming a bill that is NOT open for that party does not fail.
    // Tally rewrites it as a New Ref — so instead of clearing a debt it creates
    // one, and still reports created=1. Only the read-back diff catches this.
    const other = payb.find(b => payTargets.length && b.party !== payTargets[0].party && b.outstanding > 100);
    if (other && payTargets.length) {
      const amt = r2(other.outstanding);
      const num = `${TAG}/P2`;
      const res2 = await push(company, {
        remoteId: `MKCP|Payment|${num}`, voucherType: "Payment", date: TODAY, voucherNumber: num,
        narration: "MOCK RUN cross-party ref", partyLedgerName: payTargets[0].party, isInvoice: false,
        ledgerEntries: [
          { ledgerName: payTargets[0].party, amount: amt, isDeemedPositive: true, isPartyLedger: true,
            billAllocations: [{ name: other.name, billType: "Agst Ref", amount: amt }] },
          { ledgerName: BANK, amount: amt, isDeemedPositive: false, isPartyLedger: false },
        ],
      });
      const rewritten = res2.differences.some(d => /New Ref/.test(d));
      ok("a bill ref from ANOTHER party is caught by read-back, not by Tally",
        rewritten,
        rewritten ? `Tally silently rewrote "${other.name}" Agst Ref → New Ref; the diff caught it`
                  : "expected Tally to rewrite the ref — behaviour may have changed");
      note("never bypass safePush",
        "an unguarded route would have booked this as a NEW liability while reporting success");
    }

    // Bulk: three receipts in one pass, bills drawn down within the batch
    const bulkTargets = recv.slice(0, 3);
    if (bulkTargets.length >= 2) {
      let allOk = true; const ids: string[] = [];
      for (const [i, b] of bulkTargets.entries()) {
        const amt = r2(b.outstanding / 2); // deliberate part payments
        const num = `${TAG}/B${i + 1}`;
        const r = await push(company, {
          remoteId: `MKCP|Receipt|${num}`, voucherType: "Receipt", date: TODAY, voucherNumber: num,
          narration: `CH NO: 00${i}${TAG.slice(-3)}`, partyLedgerName: b.party, isInvoice: false,
          ledgerEntries: [
            { ledgerName: BANK, amount: amt, isDeemedPositive: true, isPartyLedger: false },
            { ledgerName: b.party, amount: amt, isDeemedPositive: false, isPartyLedger: true,
              billAllocations: [{ name: b.name, billType: "Agst Ref", amount: amt }] },
          ],
        });
        if (!r.ok) { allOk = false; ids.push(r.errors[0] ?? r.differences[0] ?? "?"); }
      }
      ok(`bulk run — ${bulkTargets.length} part-payment receipts in one pass`, allOk, ids[0] ?? "");
    }
    if (!await healthy()) throw new Error("Tally stopped answering after payments");

    // ═══════════════════════════════════════════════════════════════════
    P("E · BANK STATEMENT — rows straight to a receipt plan");

    const bankRows = recv.slice(0, 3).map((b, i) => ({
      date: TODAY,
      amount: b.outstanding,                 // positive = money in
      description: `NEFT CR ${b.party} UTR${TAG}${i}`,   // the payer name hides in here
      reference: `UTRBANK${TAG}${i}`,
      sourceImageId: `mock-${TAG}`,
      confidence: 0.97,
    }));
    const plan = planFromBankRows(bankRows, m, bills, BANK, new Map());
    ok("bank rows resolve to payers and allocate against bills", plan.ready > 0,
      `${plan.ready} ready, ${plan.needsAnswer} need review, ${inr(plan.totalIn)} in`);
    const settled = plan.rows.filter(r => r.settles.length > 0);
    ok("resolved rows carry real bill settlements", settled.length > 0,
      settled.length ? `e.g. ${settled[0].party} → ${settled[0].settles.map(s => s.name).join(", ")}` : "none");
    const idem = plan.rows.filter(r => r.payload).every(r => /UTRBANK/.test(r.payload!.voucherNumber ?? ""));
    ok("voucher number keyed on the UTR (re-import is idempotent)", idem,
      plan.rows.find(r => r.payload)?.payload?.voucherNumber ?? "no payload built");
    // A statement with an unreadable payer must stop, not guess.
    const murky = planFromBankRows(
      [{ date: TODAY, amount: 4321, description: "NEFT CR 0000913", reference: `UTRX${TAG}`, sourceImageId: `mock-${TAG}`, confidence: 0.97 }],
      m, bills, BANK, new Map());
    ok("an unreadable payer becomes a question, not a guess", murky.needsAnswer === 1,
      murky.rows[0]?.question?.reason ?? "resolved anyway");

    // ═══════════════════════════════════════════════════════════════════
    P("F · SELLING — invoice from scratch, with a discount, both signs");

    const qty = 4, rate = item.closingRate;
    const gross = r2(qty * rate);
    const disc = r2(gross * 0.03);
    const taxable = r2(gross - disc);
    const cgst = r2(taxable * 0.09), sgst = cgst;
    const rawTotal = r2(taxable + cgst + sgst);
    const grand = Math.round(rawTotal);
    const round = r2(grand - rawTotal);

    const invLines = (n: string) => ({
      remoteId: `MKCP|Sales|${n}`, voucherType: "Sales" as const, date: TODAY, voucherNumber: n,
      partyLedgerName: wbCustomer.name, isInvoice: true,
      inventoryEntries: [{
        stockItemName: item.name, quantity: qty, unit: item.baseUnit, rate,
        amount: gross, isDeemedPositive: false, salesLedgerName: SALES,
        godownName: godown, batchName: "Primary Batch",
      }],
    });

    // F1 — native encoding: discount as a NEGATIVE CREDIT, the shape Tally writes
    const n1 = `${TAG}/S1`;
    const discLine: LedgerEntry = {
      ledgerName: DISCOUNT, amount: disc, isDeemedPositive: false, isPartyLedger: false,
      signedAmount: -disc, appropriateToGst: "Goods",
    };
    const r1 = await push(company, {
      ...invLines(n1), narration: "MOCK RUN discount native",
      ledgerEntries: [
        { ledgerName: wbCustomer.name, amount: grand, isDeemedPositive: true, isPartyLedger: true,
          billAllocations: [{ name: n1, billType: "New Ref", amount: grand }] },
        discLine,
        { ledgerName: "OUTPUT CGST", amount: cgst, isDeemedPositive: false, isPartyLedger: false },
        { ledgerName: "OUTPUT SGST", amount: sgst, isDeemedPositive: false, isPartyLedger: false },
        ...(round !== 0 ? [{ ledgerName: "ROUNDED OFF", amount: Math.abs(round), isDeemedPositive: round < 0, isPartyLedger: false }] : []),
      ],
    });
    ok("invoice with a NEGATIVE-CREDIT discount (native shape)", r1.ok,
      r1.errors[0] ?? r1.differences[0] ?? `${inr(grand)} incl ${inr(disc)} discount`);

    let vs = await vouchersOn(company, TODAY);
    const s1 = byNumber(vs, n1)[0];
    if (s1) {
      const led = populated([...s1.matchAll(/<LEDGERENTRIES\.LIST>([\s\S]*?)<\/LEDGERENTRIES\.LIST>/g)].map(x => x[1]));
      const dl = led.find(l => /TRADE DISCOUNT/i.test(fld(l, "LEDGERNAME")));
      ok("discount stored exactly as the books write it",
        !!dl && fld(dl, "ISDEEMEDPOSITIVE") === "No" && lead(fld(dl, "AMOUNT")) < 0,
        dl ? `ISDEEMEDPOSITIVE=${fld(dl, "ISDEEMEDPOSITIVE")} AMOUNT=${fld(dl, "AMOUNT")}` : "no discount line");
      const tax = led.filter(l => /OUTPUT (C|S)GST/i.test(fld(l, "LEDGERNAME")));
      ok("CGST+SGST used for a West Bengal party", tax.length === 2, `${tax.length} tax lines`);
    }

    // F2 — the positive case: freight exceeded the discount, so the line is a CREDIT-side positive
    const freightNet = r2(gross * 0.02);
    const taxable2 = r2(gross + freightNet);
    const cgst2 = r2(taxable2 * 0.09), sgst2 = cgst2;
    const rawTotal2 = r2(taxable2 + cgst2 + sgst2);
    const grand2 = Math.round(rawTotal2);
    const round2 = r2(grand2 - rawTotal2);
    const n2 = `${TAG}/S2`;
    const r2res = await push(company, {
      ...invLines(n2), remoteId: `MKCP|Sales|${n2}`, voucherNumber: n2, narration: "MOCK RUN freight exceeds discount",
      ledgerEntries: [
        { ledgerName: wbCustomer.name, amount: grand2, isDeemedPositive: true, isPartyLedger: true,
          billAllocations: [{ name: n2, billType: "New Ref", amount: grand2 }] },
        // Positive net: adds to the charge rather than reducing it. 155 of 444 real lines look like this.
        { ledgerName: DISCOUNT, amount: freightNet, isDeemedPositive: false, isPartyLedger: false, signedAmount: freightNet, appropriateToGst: "Goods" },
        { ledgerName: "OUTPUT CGST", amount: cgst2, isDeemedPositive: false, isPartyLedger: false },
        { ledgerName: "OUTPUT SGST", amount: sgst2, isDeemedPositive: false, isPartyLedger: false },
        ...(round2 !== 0 ? [{ ledgerName: "ROUNDED OFF", amount: Math.abs(round2), isDeemedPositive: round2 < 0, isPartyLedger: false }] : []),
      ],
    });
    ok("invoice where freight EXCEEDS the discount (positive line)", r2res.ok,
      r2res.errors[0] ?? r2res.differences[0] ?? `${inr(grand2)}`);
    if (!await healthy()) throw new Error("Tally stopped answering after sales");

    // ═══════════════════════════════════════════════════════════════════
    P("G · ORDER → INVOICE — the conversion");

    const n3 = `${TAG}/O1`;
    const soAmt = r2(3 * item2.closingRate);
    const soBase = {
      remoteId: `MKCP|Order|${n3}`, date: TODAY, voucherNumber: n3,
      partyLedgerName: wbCustomer.name,
      inventoryEntries: [{
        stockItemName: item2.name, quantity: 3, unit: item2.baseUnit, rate: item2.closingRate,
        amount: soAmt, isDeemedPositive: false, salesLedgerName: SALES,
        godownName: godown, batchName: "Primary Batch",
      }],
    };
    const so = await push(company, {
      ...soBase, voucherType: "Sales Order Note" as VoucherPayload["voucherType"], isInvoice: false,
      narration: "MOCK RUN order raised",
      ledgerEntries: [{ ledgerName: wbCustomer.name, amount: soAmt, isDeemedPositive: true, isPartyLedger: true }],
    }, false);
    ok("sales order raised with a REMOTEID", so.ok, so.errors[0] ?? so.differences[0] ?? "");

    vs = await vouchersOn(company, TODAY);
    const before = byNumber(vs, n3)[0];
    const midBefore = before ? fld(before, "MASTERID") : "";

    const convertedPayload: VoucherPayload = {
      ...soBase, action: "Alter", voucherType: "Sales", isInvoice: true,
      narration: "MOCK RUN converted to invoice",
      ledgerEntries: [{
        ledgerName: wbCustomer.name, amount: soAmt, isDeemedPositive: true, isPartyLedger: true,
        billAllocations: [{ name: n3, billType: "New Ref", amount: soAmt }],
      }],
    };
    const conv = await push(company, convertedPayload);
    ok("converted to a Sales invoice in place", conv.ok, conv.errors[0] ?? conv.differences[0] ?? "");

    vs = await vouchersOn(company, TODAY);
    const after = byNumber(vs, n3);
    ok("no duplicate created", after.length === 1, `${after.length} voucher(s) with this number`);
    if (after.length === 1) {
      ok("same MASTERID — one document, changed type", fld(after[0], "MASTERID") === midBefore,
        `${midBefore} → ${fld(after[0], "MASTERID")}`);
      ok("now an invoice", fld(after[0], "VOUCHERTYPENAME").toUpperCase() === "SALES" && fld(after[0], "ISINVOICE") === "Yes",
        `${fld(after[0], "VOUCHERTYPENAME")} · isInvoice=${fld(after[0], "ISINVOICE")}`);
    }
    if (!await healthy()) throw new Error("Tally stopped answering after conversion");

    // ═══════════════════════════════════════════════════════════════════
    P("H · BUYING — interstate purchase, and a pure-expense purchase");

    const pQty = 5, pRate = item.closingRate;
    const pGross = r2(pQty * pRate);
    const igst = r2(pGross * 0.18);
    const pTotal = r2(pGross + igst);
    const n4 = `${TAG}/PU1`;
    const pu = await push(company, {
      remoteId: `MKCP|Purchase|${n4}`, voucherType: "Purchase", date: TODAY, voucherNumber: n4,
      reference: n4, narration: "MOCK RUN interstate purchase",
      partyLedgerName: outSupplier.name, isInvoice: true,
      ledgerEntries: [
        { ledgerName: outSupplier.name, amount: pTotal, isDeemedPositive: false, isPartyLedger: true,
          billAllocations: [{ name: n4, billType: "New Ref", amount: pTotal }] },
        { ledgerName: "INPUT IGST", amount: igst, isDeemedPositive: true, isPartyLedger: false },
      ],
      inventoryEntries: [{
        stockItemName: item.name, quantity: pQty, unit: item.baseUnit, rate: pRate,
        amount: pGross, isDeemedPositive: true, salesLedgerName: PURCH,
        godownName: godown, batchName: "Primary Batch",
      }],
    });
    ok("interstate purchase with IGST", pu.ok, pu.errors[0] ?? pu.differences[0] ?? `${inr(pTotal)}`);

    // Expense purchase — no stock lines at all
    const expAmt = 2500;
    const n5 = `${TAG}/PU2`;
    const exp = await push(company, {
      remoteId: `MKCP|Purchase|${n5}`, voucherType: "Purchase", date: TODAY, voucherNumber: n5,
      narration: "MOCK RUN expense only", partyLedgerName: "Cash", isInvoice: false,
      ledgerEntries: [
        { ledgerName: "Office Expenses", amount: expAmt, isDeemedPositive: true, isPartyLedger: false },
        { ledgerName: "Cash", amount: expAmt, isDeemedPositive: false, isPartyLedger: true },
      ],
    });
    ok("expense purchase with no stock lines", exp.ok, exp.errors[0] ?? exp.differences[0] ?? `${inr(expAmt)}`);

    // Contra — cash to bank
    const n6 = `${TAG}/C1`;
    const contra = await push(company, {
      remoteId: `MKCP|Contra|${n6}`, voucherType: "Contra" as VoucherPayload["voucherType"],
      date: TODAY, voucherNumber: n6, narration: "CASH DEP",
      partyLedgerName: BANK, isInvoice: false,
      ledgerEntries: [
        { ledgerName: BANK, amount: 10000, isDeemedPositive: true, isPartyLedger: false },
        { ledgerName: "Cash", amount: 10000, isDeemedPositive: false, isPartyLedger: false },
      ],
    });
    ok("contra — cash deposited to bank", contra.ok, contra.errors[0] ?? contra.differences[0] ?? "");
    if (!await healthy()) throw new Error("Tally stopped answering after purchases");

    // ═══════════════════════════════════════════════════════════════════
    // Exactly what engine/salesOrderPayload.ts now emits for /sales-quote: a
    // Sales Order Note with a native-encoding trade discount and a godown and
    // batch on every stock line. Worth pushing the real shape rather than
    // trusting the converter's unit tests.
    P("G2 · THE /sales-quote SHAPE — a discounted order, then billed");

    const qn = `${TAG}/Q1`;
    const qQty = 4, qRate = item.closingRate;
    const qGross = r2(qQty * qRate);
    const qDisc = r2(qGross * 0.03);
    const qTaxable = r2(qGross - qDisc);
    const qCgst = r2(qTaxable * 0.09), qSgst = qCgst;
    const qExact = r2(qTaxable + qCgst + qSgst);
    const qGrand = Math.round(qExact);
    const qRound = r2(qGrand - qExact);
    const qRemote = `MKCP|Sales Order Note|${qn}|2026-27`;

    const qLedgers = (withBill: boolean): LedgerEntry[] => [
      {
        ledgerName: wbCustomer.name, amount: qGrand, isDeemedPositive: true, isPartyLedger: true,
        ...(withBill ? { billAllocations: [{ name: qn, billType: "New Ref" as const, amount: qGrand }] } : {}),
      },
      { ledgerName: DISCOUNT, amount: qDisc, isDeemedPositive: false, isPartyLedger: false, signedAmount: -qDisc, appropriateToGst: "Goods" },
      { ledgerName: "OUTPUT CGST", amount: qCgst, isDeemedPositive: false, isPartyLedger: false },
      { ledgerName: "OUTPUT SGST", amount: qSgst, isDeemedPositive: false, isPartyLedger: false },
      ...(qRound !== 0
        ? [{ ledgerName: "ROUNDED OFF", amount: Math.abs(qRound), isDeemedPositive: qRound < 0, isPartyLedger: false }]
        : []),
    ];
    const qStock = [{
      stockItemName: item.name, quantity: qQty, unit: item.baseUnit, rate: qRate,
      amount: qGross, isDeemedPositive: false, salesLedgerName: SALES,
      godownName: godown, batchName: "Primary Batch",
    }];

    const quote = await push(company, {
      remoteId: qRemote, voucherType: "Sales Order Note",
      date: TODAY, voucherNumber: qn, narration: "MOCK RUN quote with discount",
      partyLedgerName: wbCustomer.name, isInvoice: false,
      ledgerEntries: qLedgers(false), inventoryEntries: qStock,
    });
    ok("a discounted sales order pushes through the guarded queue", quote.ok,
      quote.errors[0] ?? quote.differences[0] ?? `${inr(qGrand)} incl ${inr(qDisc)} discount`);

    // And it must still convert — the reason the web app now stamps a REMOTEID.
    const qConv = await push(company, {
      remoteId: qRemote, action: "Alter", voucherType: "Sales",
      date: TODAY, voucherNumber: qn, narration: "MOCK RUN quote billed",
      partyLedgerName: wbCustomer.name, isInvoice: true,
      ledgerEntries: qLedgers(true), inventoryEntries: qStock,
    }, false);
    ok("…and that quote converts to an invoice, discount intact", qConv.ok,
      qConv.errors[0] ?? qConv.differences[0] ?? "");

    vs = await vouchersOn(company, TODAY);
    const billed = byNumber(vs, qn);
    ok("one document, not two", billed.length === 1, `${billed.length} voucher(s)`);
    if (billed.length === 1) {
      const led = populated([...billed[0].matchAll(/<LEDGERENTRIES\.LIST>([\s\S]*?)<\/LEDGERENTRIES\.LIST>/g)].map(x => x[1]));
      const dl = led.find(l => /TRADE DISCOUNT/i.test(fld(l, "LEDGERNAME")));
      ok("the discount survived the conversion in its native shape",
        !!dl && fld(dl, "ISDEEMEDPOSITIVE") === "No" && lead(fld(dl, "AMOUNT")) < 0,
        dl ? `ISDEEMEDPOSITIVE=${fld(dl, "ISDEEMEDPOSITIVE")} AMOUNT=${fld(dl, "AMOUNT")}` : "no discount line");
    }
    if (!await healthy()) throw new Error("Tally stopped answering after the quote");

    // ═══════════════════════════════════════════════════════════════════
    P("I · CORRECTING — alter an existing voucher");

    const altered = await push(company, {
      remoteId: `MKCP|Purchase|${n5}`, action: "Alter", voucherType: "Purchase",
      date: TODAY, voucherNumber: n5, narration: "MOCK RUN expense CORRECTED",
      partyLedgerName: "Cash", isInvoice: false,
      ledgerEntries: [
        { ledgerName: "Office Expenses", amount: 3100, isDeemedPositive: true, isPartyLedger: false },
        { ledgerName: "Cash", amount: 3100, isDeemedPositive: false, isPartyLedger: true },
      ],
    }, false);
    ok("amount corrected on an existing voucher", altered.ok, altered.errors[0] ?? altered.differences[0] ?? "2500 → 3100");

    vs = await vouchersOn(company, TODAY);
    const corrected = byNumber(vs, n5);
    ok("correction did not duplicate", corrected.length === 1, `${corrected.length} voucher(s)`);
    if (corrected.length === 1) {
      const led = populated([...corrected[0].matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/g)].map(x => x[1]));
      const oe = led.find(l => /Office Expenses/i.test(fld(l, "LEDGERNAME")));
      ok("the new amount is what is stored", !!oe && Math.abs(Math.abs(lead(fld(oe, "AMOUNT"))) - 3100) < 0.02,
        oe ? fld(oe, "AMOUNT") : "line missing");
      ok("narration updated too", /CORRECTED/.test(fld(corrected[0], "NARRATION")), fld(corrected[0], "NARRATION"));
    }

    // ═══════════════════════════════════════════════════════════════════
    P("J · GUARD — what it refuses before anything reaches Tally");

    const bad = (p: Partial<VoucherPayload>): VoucherPayload => ({
      voucherType: "Receipt", date: TODAY, voucherNumber: `${TAG}/X`, partyLedgerName: wbCustomer.name,
      isInvoice: false, ledgerEntries: [], ...p,
    } as VoucherPayload);

    const g1 = guardVoucher(bad({ ledgerEntries: [
      { ledgerName: "NO SUCH LEDGER AT ALL", amount: 100, isDeemedPositive: true, isPartyLedger: false },
      { ledgerName: wbCustomer.name, amount: 100, isDeemedPositive: false, isPartyLedger: true }] }), m);
    ok("refuses an unknown ledger", g1.errors.length > 0, g1.errors[0]?.slice(0, 76));

    const g2 = guardVoucher(bad({ ledgerEntries: [
      { ledgerName: BANK, amount: 100, isDeemedPositive: true, isPartyLedger: false },
      { ledgerName: wbCustomer.name, amount: 250, isDeemedPositive: false, isPartyLedger: true }] }), m);
    ok("refuses an unbalanced voucher", g2.errors.length > 0, g2.errors[0]?.slice(0, 76));

    const g3 = guardVoucher(bad({ action: "Alter", remoteId: undefined, ledgerEntries: [
      { ledgerName: BANK, amount: 100, isDeemedPositive: true, isPartyLedger: false },
      { ledgerName: wbCustomer.name, amount: 100, isDeemedPositive: false, isPartyLedger: true }] }), m);
    ok("refuses Alter without a REMOTEID", g3.errors.length > 0, g3.errors[0]?.slice(0, 76));

    const g4 = guardVoucher(bad({ voucherType: "Sales", isInvoice: true, ledgerEntries: [
      { ledgerName: wbCustomer.name, amount: 118, isDeemedPositive: true, isPartyLedger: true },
      { ledgerName: "OUTPUT IGST", amount: 18, isDeemedPositive: false, isPartyLedger: false }],
      inventoryEntries: [{ stockItemName: item.name, quantity: 1, unit: item.baseUnit, rate: 100,
        amount: 100, isDeemedPositive: false, salesLedgerName: SALES, godownName: godown, batchName: "Primary Batch" }] }), m);
    ok("refuses IGST on a West Bengal party", g4.errors.length > 0 || g4.warnings.length > 0,
      (g4.errors[0] ?? g4.warnings[0] ?? "").slice(0, 76));

  } finally {
    // ═══════════════════════════════════════════════════════════════════
    P("Z · CLEAN UP — removing everything this run created");
    let removed = 0, stuck = 0;
    for (const p of made) {
      try {
        const d = await safePush(TALLY_URL, company, { ...p, action: "Delete" });
        if (d.ok) removed++; else stuck++;
      } catch { stuck++; }
    }
    console.log(`  removed ${removed} of ${made.length}${stuck ? `, ${stuck} could not be removed` : ""}`);
    const left = await vouchersOn(company, TODAY).catch(() => [] as string[]);
    const mine = left.filter(v => fld(v, "VOUCHERNUMBER").startsWith(TAG));
    ok("no mock vouchers left behind", mine.length === 0,
      mine.length ? mine.map(v => fld(v, "VOUCHERNUMBER")).join(", ") : "books are clean");

    // ═══════════════════════════════════════════════════════════════════
    console.log(`\n\x1b[1m${"═".repeat(62)}\x1b[0m`);
    const byPhase = new Map<string, { p: number; f: number; n: number }>();
    for (const r of results) {
      const e = byPhase.get(r.phase) ?? { p: 0, f: 0, n: 0 };
      if (r.ok === true) e.p++; else if (r.ok === false) e.f++; else e.n++;
      byPhase.set(r.phase, e);
    }
    for (const [ph, e] of byPhase)
      console.log(`  ${e.f ? "\x1b[31m✗\x1b[0m" : "\x1b[32m✓\x1b[0m"} ${ph.padEnd(52)} ${e.p} ok${e.f ? `, ${e.f} FAILED` : ""}${e.n ? `, ${e.n} note` : ""}`);
    console.log(`\n  ${pass} passed · ${fail} failed · ${skip} notes`);
    if (fail) {
      console.log("\n  failures:");
      for (const r of results.filter(r => r.ok === false)) console.log(`    ✗ [${r.phase.split(" ")[0]}] ${r.name} — ${r.detail}`);
    }
    console.log(await healthy() ? "\n  Tally still healthy." : "\n  \x1b[31m⚠ Tally is NOT responding.\x1b[0m");
  }
}

main().catch(e => { console.error("\nRUN ABORTED:", e.message); });
