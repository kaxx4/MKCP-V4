/**
 * Edge-case sweep — 40+ variations pushed to Tally and read back.
 *
 * Two kinds of case:
 *   REJECT — the guard must refuse it locally. Tally is never contacted, which
 *            matters because a malformed request freezes it until restart.
 *   PUSH   — must reach Tally, be created, and read back field-for-field.
 *
 * Stops immediately on a transport failure: after one, Tally may be showing a
 * modal and every subsequent request would fail for an unrelated reason.
 *
 *   npx tsx scripts/test-edge-cases.ts          # guard cases only
 *   npx tsx scripts/test-edge-cases.ts --push   # the full sweep
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters, type TallyMasters, type MasterItem, type MasterLedger } from "../src/services/tallyMasters.js";
import { guardVoucher } from "../src/services/pushGuard.js";
import { safePush } from "../src/services/safePush.js";
import { loadOpenBills, receivableBills, billsForParty, type OpenBill } from "../src/services/billSettlement.js";
import type { VoucherPayload, LedgerEntry, InventoryEntry } from "../src/types.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const PUSH = process.argv.includes("--push");
const TAG = `E${Date.now().toString().slice(-7)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

let pass = 0, fail = 0, skipped = 0, halted = false;
const results: Array<{ n: number; name: string; verdict: string }> = [];
let counter = 0;

function record(name: string, ok: boolean, verdict: string) {
  counter++;
  results.push({ n: counter, name, verdict });
  if (ok) { pass++; console.log(`  ✓ ${String(counter).padStart(2)}. ${name} — ${verdict}`); }
  else { fail++; console.log(`  ✗ ${String(counter).padStart(2)}. ${name} — ${verdict}`); }
}

/** The guard must refuse this, naming the reason. Tally is never contacted. */
function expectReject(name: string, p: VoucherPayload, m: TallyMasters, mustMention: string) {
  const r = guardVoucher(p, m);
  const hit = r.errors.find(e => e.toLowerCase().includes(mustMention.toLowerCase()));
  record(name, !r.ok && !!hit, !r.ok ? (hit ? "refused locally" : `refused, but for the wrong reason: ${r.errors[0]}`) : "ACCEPTED — should have been refused");
}

/** Must reach Tally, be created, and read back identically. */
async function expectPush(name: string, p: VoucherPayload, company: string) {
  if (halted) { skipped++; counter++; console.log(`  – ${String(counter).padStart(2)}. ${name} — skipped, Tally halted`); return; }
  if (!PUSH) { skipped++; counter++; return; }
  try {
    const res = await safePush(TALLY_URL, company, p);
    if (res.ok) record(name, true, `voucher ${res.voucherId}`);
    else record(name, false, res.differences.length ? `stored differently: ${res.differences[0]}` : res.errors[0] ?? "rejected");
  } catch (e) {
    halted = true;
    record(name, false, `TRANSPORT — ${(e as Error).message}`);
  }
}

async function main() {
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  const m = await loadMasters(TALLY_URL, company);
  const bills = await loadOpenBills(TALLY_URL, company);

  const godown = [...m.godowns][0];
  const localCust = [...m.ledgers.values()].find(l => /SUNDRY DEBTORS/i.test(l.parent) && /WEST BENGAL/i.test(l.state))!;
  const farSupplier = [...m.ledgers.values()].find(l => /SUNDRY CREDITORS/i.test(l.parent) && l.state && !/WEST BENGAL/i.test(l.state))!;
  const localSupplier = [...m.ledgers.values()].find(l => /SUNDRY CREDITORS/i.test(l.parent) && /WEST BENGAL/i.test(l.state));
  const noStateParty = [...m.ledgers.values()].find(l => /SUNDRY (DEBTORS|CREDITORS)/i.test(l.parent) && !l.state);

  const items = [...m.items.values()].filter(i => i.closingRate > 5);
  const item = items.find(i => i.closingStock > 50) ?? items[0];
  const compound = items.find(i => i.denominator > 1) ?? item;
  const quoted = items.find(i => i.name.includes('"'));
  const amped = items.find(i => i.name.includes("&"));
  const cash = m.ledgers.get("Cash")!;
  const bank = m.ledgers.get("HDFC BANK")!;

  console.log(`\ncompany "${company}"`);
  console.log(`local customer  ${localCust.name} (${localCust.state})`);
  console.log(`far supplier    ${farSupplier.name} (${farSupplier.state})`);
  console.log(`item            ${item.name} @ ${item.closingRate}/${item.baseUnit}`);
  if (quoted) console.log(`quoted item     ${quoted.name}`);
  if (amped) console.log(`ampersand item  ${amped.name}`);
  console.log();

  const r2 = (x: number) => Math.round(x * 100) / 100;
  const PURCH_LOCAL = "PURCHASE ( GST W.B. )", PURCH_FAR = "PURCHASE ( GST CENTRAL )";
  const SALES_LOCAL = "SALES  ( GST W.B. )";

  /** A minimal, correct purchase from the far (interstate) supplier. */
  const purchase = (over: Partial<VoucherPayload> = {}, lines?: InventoryEntry[], led?: LedgerEntry[]): VoucherPayload => {
    const inv = lines ?? [{
      stockItemName: item.name, quantity: 2, unit: item.baseUnit, rate: item.closingRate,
      amount: r2(2 * item.closingRate), isDeemedPositive: true,
      salesLedgerName: PURCH_FAR, godownName: godown, batchName: "Primary Batch",
    }];
    const total = r2(inv.reduce((s, l) => s + l.amount, 0));
    return {
      voucherType: "Purchase", date: TODAY, voucherNumber: `${TAG}/${++vnum}`,
      reference: `${TAG}/${vnum}`, narration: `${TAG} edge case`,
      partyLedgerName: farSupplier.name, isInvoice: true,
      ledgerEntries: led ?? [{
        ledgerName: farSupplier.name, amount: total, isDeemedPositive: false, isPartyLedger: true,
        billAllocations: [{ name: `${TAG}/${vnum}`, billType: "New Ref", amount: total }],
      }],
      inventoryEntries: inv,
      ...over,
    };
  };
  let vnum = 0;

  // ══ AMOUNTS AND PRECISION ════════════════════════════════════════════════
  console.log("Amounts and precision:");
  {
    const one = (amt: number, qty = 1, rate = amt) => purchase({}, [{
      stockItemName: item.name, quantity: qty, unit: item.baseUnit, rate,
      amount: amt, isDeemedPositive: true, salesLedgerName: PURCH_FAR,
      godownName: godown, batchName: "Primary Batch",
    }], undefined);
    const withParty = (amt: number, qty = 1, rate = amt) => {
      const p = one(amt, qty, rate);
      p.ledgerEntries = [{ ledgerName: farSupplier.name, amount: amt, isDeemedPositive: false, isPartyLedger: true,
        billAllocations: [{ name: p.voucherNumber!, billType: "New Ref", amount: amt }] }];
      return p;
    };
    await expectPush("smallest bookable amount (₹0.01)", withParty(0.01), company);
    await expectPush("paise precision (₹123.45)", withParty(123.45), company);
    await expectPush("large amount (₹99,99,999)", withParty(9999999), company);
    await expectPush("rate with 4 decimals rounds to a clean amount", withParty(r2(3 * 33.3333), 3, 33.3333), company);

    const zero = withParty(0, 1, 0);
    expectReject("zero-amount stock line", zero, m, "no value");
    const negQty = withParty(100, -2, 50);
    expectReject("negative quantity", negQty, m, "positive");
  }

  // ══ QUANTITIES AND UNITS ═════════════════════════════════════════════════
  console.log("\nQuantities and units:");
  {
    const qty = (q: number, it: MasterItem = item) => {
      const amt = r2(q * it.closingRate);
      const p = purchase({}, [{
        stockItemName: it.name, quantity: q, unit: it.baseUnit, rate: it.closingRate,
        amount: amt, isDeemedPositive: true, salesLedgerName: PURCH_FAR,
        godownName: godown, batchName: "Primary Batch",
      }]);
      p.ledgerEntries = [{ ledgerName: farSupplier.name, amount: amt, isDeemedPositive: false, isPartyLedger: true,
        billAllocations: [{ name: p.voucherNumber!, billType: "New Ref", amount: amt }] }];
      return p;
    };
    await expectPush("quantity of 1", qty(1), company);
    const frac = qty(1.5);
    const fg = guardVoucher(frac, m);
    record("fractional quantity warns that Tally may round it",
      fg.warnings.some(w => /fractional/i.test(w)),
      fg.warnings.find(w => /fractional/i.test(w)) ? "warned before sending" : "no warning raised");
    await expectPush("large quantity (10,000)", qty(10000), company);
    await expectPush(`compound-unit item (denominator ${compound.denominator})`, qty(compound.denominator * 3, compound), company);

    const badUnit = qty(1);
    badUnit.inventoryEntries![0].unit = "WIDGETS";
    expectReject("unit that is not the item's own", badUnit, m, "base unit");

    const noGodown = qty(1);
    noGodown.inventoryEntries![0].godownName = "NOWHERE";
    expectReject("nonexistent godown", noGodown, m, "Godown");
  }

  // ══ NAMES AND ENCODING ═══════════════════════════════════════════════════
  console.log("\nNames and encoding:");
  {
    const withItem = (it: MasterItem) => {
      const amt = r2(1 * it.closingRate);
      const p = purchase({}, [{
        stockItemName: it.name, quantity: 1, unit: it.baseUnit, rate: it.closingRate,
        amount: amt, isDeemedPositive: true, salesLedgerName: PURCH_FAR,
        godownName: godown, batchName: "Primary Batch",
      }]);
      p.ledgerEntries = [{ ledgerName: farSupplier.name, amount: amt, isDeemedPositive: false, isPartyLedger: true,
        billAllocations: [{ name: p.voucherNumber!, billType: "New Ref", amount: amt }] }];
      return p;
    };
    if (quoted) await expectPush(`item name containing an inch mark`, withItem(quoted), company);
    else { counter++; skipped++; console.log(`  – ${counter}. item name containing an inch mark — no such item`); }
    if (amped) await expectPush(`item name containing "&"`, withItem(amped), company);
    else { counter++; skipped++; console.log(`  – ${counter}. item name containing "&" — no such item`); }

    const narr = purchase({ narration: `${TAG} R&D <check> "quotes" & 'apostrophes' — em-dash ₹1,234` });
    await expectPush("narration with XML-special and unicode characters", narr, company);

    await expectPush("very long narration (400 chars)", purchase({ narration: `${TAG} ` + "x".repeat(400) }), company);
    await expectPush("empty narration", purchase({ narration: "" }), company);

    const badLedger = purchase();
    badLedger.inventoryEntries![0].salesLedgerName = "PURCHASE  ( GST CENTRAL )"; // two spaces
    expectReject("accounting ledger off by one space", badLedger, m, "PURCHASE ( GST CENTRAL )");

    const unknownItem = purchase();
    unknownItem.inventoryEntries![0].stockItemName = "ITEM THAT DOES NOT EXIST";
    expectReject("unknown stock item", unknownItem, m, "does not exist");
  }

  // ══ MULTI-LINE SCALE ═════════════════════════════════════════════════════
  console.log("\nMulti-line scale:");
  {
    const nLines = (n: number) => {
      const pick = Array.from({ length: n }, (_, i) => items[i % items.length]);
      const lines: InventoryEntry[] = pick.map((it, i) => ({
        stockItemName: it.name, quantity: 1 + (i % 3), unit: it.baseUnit, rate: it.closingRate,
        amount: r2((1 + (i % 3)) * it.closingRate), isDeemedPositive: true,
        salesLedgerName: PURCH_FAR, godownName: godown, batchName: "Primary Batch",
      }));
      const total = r2(lines.reduce((s, l) => s + l.amount, 0));
      const p = purchase({}, lines);
      p.ledgerEntries = [{ ledgerName: farSupplier.name, amount: total, isDeemedPositive: false, isPartyLedger: true,
        billAllocations: [{ name: p.voucherNumber!, billType: "New Ref", amount: total }] }];
      return p;
    };
    await expectPush("20 stock lines", nLines(20), company);
    await expectPush("76 stock lines (largest seen in the books)", nLines(76), company);

    // Same item twice — legitimate (two rates, two batches on one bill).
    const dupAmt = r2(item.closingRate * 3);
    const dup = purchase({}, [
      { stockItemName: item.name, quantity: 1, unit: item.baseUnit, rate: item.closingRate,
        amount: r2(item.closingRate), isDeemedPositive: true, salesLedgerName: PURCH_FAR, godownName: godown, batchName: "Primary Batch" },
      { stockItemName: item.name, quantity: 2, unit: item.baseUnit, rate: item.closingRate,
        amount: r2(item.closingRate * 2), isDeemedPositive: true, salesLedgerName: PURCH_FAR, godownName: godown, batchName: "Primary Batch" },
    ]);
    dup.ledgerEntries = [{ ledgerName: farSupplier.name, amount: dupAmt, isDeemedPositive: false, isPartyLedger: true,
      billAllocations: [{ name: dup.voucherNumber!, billType: "New Ref", amount: dupAmt }] }];
    await expectPush("the same item twice in one voucher", dup, company);
  }

  // ══ GST AND STATE ════════════════════════════════════════════════════════
  console.log("\nGST and party state:");
  {
    // A full local sale: party + CGST + SGST + rounding, stock on the other side.
    const lines: InventoryEntry[] = [{
      stockItemName: item.name, quantity: 4, unit: item.baseUnit, rate: item.closingRate,
      amount: r2(4 * item.closingRate), isDeemedPositive: false,
      salesLedgerName: SALES_LOCAL, godownName: godown, batchName: "Primary Batch",
    }];
    const goods = lines[0].amount;
    const half = r2(goods * 0.09);
    const gross = r2(goods + half * 2);
    const total = Math.round(gross), rounding = r2(total - gross);
    const led: LedgerEntry[] = [
      { ledgerName: localCust.name, amount: total, isDeemedPositive: true, isPartyLedger: true,
        billAllocations: [{ name: `${TAG}/S${++vnum}`, billType: "New Ref", amount: total }] },
      { ledgerName: "OUTPUT CGST", amount: half, isDeemedPositive: false, isPartyLedger: false },
      { ledgerName: "OUTPUT SGST", amount: half, isDeemedPositive: false, isPartyLedger: false },
    ];
    if (Math.abs(rounding) >= 0.01)
      led.push({ ledgerName: "ROUNDED OFF", amount: Math.abs(rounding), isDeemedPositive: rounding < 0, isPartyLedger: false });

    await expectPush("local sale — CGST + SGST + rounding", {
      voucherType: "Sales", date: TODAY, voucherNumber: `${TAG}/S${vnum}`,
      narration: `${TAG} local sale`, partyLedgerName: localCust.name, isInvoice: true,
      ledgerEntries: led, inventoryEntries: lines,
    }, company);

    // Interstate purchase with IGST.
    const iAmt = r2(2 * item.closingRate);
    const igst = r2(iAmt * 0.05);
    const iTotalGross = r2(iAmt + igst);
    const iTotal = Math.round(iTotalGross), iRound = r2(iTotal - iTotalGross);
    const iLed: LedgerEntry[] = [
      { ledgerName: farSupplier.name, amount: iTotal, isDeemedPositive: false, isPartyLedger: true,
        billAllocations: [{ name: `${TAG}/I${++vnum}`, billType: "New Ref", amount: iTotal }] },
      { ledgerName: "INPUT IGST", amount: igst, isDeemedPositive: true, isPartyLedger: false },
    ];
    if (Math.abs(iRound) >= 0.01)
      iLed.push({ ledgerName: "ROUNDED OFF", amount: Math.abs(iRound), isDeemedPositive: iRound > 0, isPartyLedger: false });
    await expectPush("interstate purchase — IGST", purchase({ voucherNumber: `${TAG}/I${vnum}`, reference: `${TAG}/I${vnum}` }, undefined, iLed), company);

    // The silent mis-filing: interstate party booked to the local tax head.
    const wrongHead = purchase();
    wrongHead.inventoryEntries![0].salesLedgerName = PURCH_LOCAL;
    expectReject("interstate party booked to the W.B. account", wrongHead, m, "interstate transaction");

    if (localSupplier) {
      const wrongLocal = purchase({ partyLedgerName: localSupplier.name });
      wrongLocal.ledgerEntries[0].ledgerName = localSupplier.name;
      expectReject("local party booked to the CENTRAL account", wrongLocal, m, "local transaction");
    } else { counter++; skipped++; console.log(`  – ${counter}. local party booked to CENTRAL — no local supplier`); }

    if (noStateParty) {
      const p = purchase({ partyLedgerName: noStateParty.name });
      p.ledgerEntries[0].ledgerName = noStateParty.name;
      const g = guardVoucher(p, m);
      record("party with no state on its master warns", g.warnings.some(w => /no state/i.test(w)),
        g.warnings.find(w => /no state/i.test(w)) ? "warned, not blocked" : "no warning raised");
    } else { counter++; skipped++; console.log(`  – ${counter}. party with no state — none found`); }
  }

  // ══ BILL ALLOCATIONS ═════════════════════════════════════════════════════
  console.log("\nBill allocations:");
  {
    const recv = receivableBills(bills);
    const target = [...new Set(recv.map(b => b.party))]
      .map(p => ({ party: p, list: billsForParty(recv, p) }))
      .sort((a, b) => b.list.length - a.list.length)[0] as { party: string; list: OpenBill[] } | undefined;

    const receipt = (amount: number, allocs: Array<{ name: string; amount: number }>, label: string) => ({
      voucherType: "Receipt" as const, date: TODAY, voucherNumber: `${TAG}/R${++vnum}`,
      narration: `${TAG} ${label}`, partyLedgerName: target!.party, isInvoice: false,
      ledgerEntries: [
        { ledgerName: bank.name, amount, isDeemedPositive: true, isPartyLedger: false,
          bankAllocation: { transactionType: "Cheque/DD", transferMode: "NEFT", instrumentNumber: `${TAG}R${vnum}`, favouring: target!.party } },
        { ledgerName: target!.party, amount, isDeemedPositive: false, isPartyLedger: true,
          ...(allocs.length ? { billAllocations: allocs.map(a => ({ name: a.name, billType: "Agst Ref" as const, amount: a.amount })) } : {}) },
      ],
    });

    if (target?.list.length) {
      const one = target.list[0];
      await expectPush("receipt settling one bill exactly", receipt(one.outstanding, [{ name: one.name, amount: one.outstanding }], "one bill"), company);

      if (target.list.length >= 2) {
        const two = target.list.slice(0, 2);
        const sum = r2(two.reduce((s, b) => s + b.outstanding, 0));
        await expectPush("receipt settling two bills", receipt(sum, two.map(b => ({ name: b.name, amount: b.outstanding })), "two bills"), company);
      } else { counter++; skipped++; console.log(`  – ${counter}. receipt settling two bills — only one open`); }

      const partial = target.list[0];
      await expectPush("part payment against one bill", receipt(r2(partial.outstanding / 2), [{ name: partial.name, amount: r2(partial.outstanding / 2) }], "part"), company);

      await expectPush("unallocated receipt (sits on account)", receipt(777, [], "on account"), company);

      const short = receipt(1000, [{ name: target.list[0].name, amount: 900 }], "short");
      expectReject("allocations that do not sum to their line", short, m, "must match exactly");
    } else {
      for (const label of ["receipt settling one bill exactly", "receipt settling two bills", "part payment against one bill", "unallocated receipt", "allocations not summing"]) {
        counter++; skipped++; console.log(`  – ${counter}. ${label} — no open bills`);
      }
    }
  }

  // ══ DATES ════════════════════════════════════════════════════════════════
  console.log("\nDates:");
  {
    await expectPush("backdated 30 days", purchase({ date: ago(30) }), company);
    await expectPush("backdated 150 days (worst lag in the books)", purchase({ date: ago(150) }), company);
    await expectPush("financial-year start (1 Apr 2026)", purchase({ date: "2026-04-01" }), company);
    expectReject("malformed date", purchase({ date: "11/09/2026" }), m, "YYYY-MM-DD");
  }

  // ══ VOUCHER TYPES ════════════════════════════════════════════════════════
  console.log("\nVoucher types:");
  {
    const simple = (type: VoucherPayload["voucherType"], dr: MasterLedger, cr: MasterLedger, amount: number) => ({
      voucherType: type, date: TODAY, voucherNumber: `${TAG}/T${++vnum}`,
      narration: `${TAG} ${type} ${vnum}`, partyLedgerName: dr.name, isInvoice: false,
      ledgerEntries: [
        { ledgerName: dr.name, amount, isDeemedPositive: true, isPartyLedger: false },
        { ledgerName: cr.name, amount, isDeemedPositive: false, isPartyLedger: false },
      ],
    } as VoucherPayload);

    await expectPush("Contra — cash to bank", simple("Journal", bank, cash, 5000), company);
    await expectPush("Journal — adjustment", simple("Journal", cash, bank, 250), company);

    const notAType = purchase({ voucherType: "Delivery Note" as VoucherPayload["voucherType"] });
    expectReject("voucher type absent from this company", notAType, m, "not configured");
  }

  // ══ BANK INSTRUMENTS ═════════════════════════════════════════════════════
  console.log("\nBank instruments:");
  {
    const payment = (bankAlloc: boolean, txType = "Cheque/DD") => ({
      voucherType: "Payment" as const, date: TODAY, voucherNumber: `${TAG}/B${++vnum}`,
      narration: `${TAG} payment`, partyLedgerName: farSupplier.name, isInvoice: false,
      ledgerEntries: [
        { ledgerName: farSupplier.name, amount: 1500, isDeemedPositive: true, isPartyLedger: true },
        { ledgerName: bank.name, amount: 1500, isDeemedPositive: false, isPartyLedger: false,
          ...(bankAlloc ? { bankAllocation: { transactionType: txType, transferMode: "NEFT", instrumentNumber: `${TAG}B${vnum}`, favouring: farSupplier.name } } : {}) },
      ],
    });
    await expectPush("payment with a bank instrument", payment(true), company);
    await expectPush('bank instrument of type "Others"', payment(true, "Others"), company);

    const noInstrument = payment(false);
    const g = guardVoucher(noInstrument, m);
    record("bank ledger with no instrument warns (does not block)",
      g.ok && g.warnings.some(w => /Bank Allocation prompt/i.test(w)),
      g.warnings.length ? "warned, still pushable" : "no warning raised");
    await expectPush("payment without an instrument still books", noInstrument, company);
  }

  // ══ BALANCE ══════════════════════════════════════════════════════════════
  console.log("\nBalance:");
  {
    const unbal = purchase();
    unbal.ledgerEntries[0].amount = r2(unbal.ledgerEntries[0].amount + 100);
    unbal.ledgerEntries[0].billAllocations![0].amount = unbal.ledgerEntries[0].amount;
    expectReject("unbalanced voucher", unbal, m, "does not balance");

    const dupLedger = purchase();
    dupLedger.ledgerEntries.push({ ledgerName: PURCH_FAR, amount: dupLedger.ledgerEntries[0].amount, isDeemedPositive: true, isPartyLedger: false });
    expectReject("accounting ledger also listed as a ledger entry", dupLedger, m, "counted twice");

    const negAmt = purchase();
    negAmt.ledgerEntries[0].amount = -negAmt.ledgerEntries[0].amount;
    expectReject("negative amount where a magnitude is required", negAmt, m, "magnitude");

    const twoParties = purchase();
    twoParties.ledgerEntries.push({ ledgerName: localCust.name, amount: 1, isDeemedPositive: true, isPartyLedger: true });
    expectReject("two party lines", twoParties, m, "at most one party");
  }

  // ══ REPORT ═══════════════════════════════════════════════════════════════
  console.log(`\n${"═".repeat(70)}`);
  console.log(`${counter} cases — ${pass} passed, ${fail} failed, ${skipped} skipped`);
  if (halted) console.log(`⚠ Halted early: Tally stopped responding. It may need a restart.`);
  if (fail) {
    console.log(`\nFailures:`);
    for (const r of results.filter(x => /ACCEPTED|stored differently|rejected|TRANSPORT|wrong reason|no warning/.test(x.verdict)))
      console.log(`  ${r.n}. ${r.name} — ${r.verdict}`);
  }
  console.log("═".repeat(70));
  if (fail) process.exit(1);
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
