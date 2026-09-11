/**
 * Stage 1 test suite — proves the guard refuses every failure mode we found by
 * experiment, and that a good voucher still pushes AND verifies.
 *
 * Every negative case here is a real bug that reached Tally at some point today
 * and returned CREATED=1 while corrupting or dropping data.
 *
 *   npx tsx scripts/test-push-guard.ts           # guard only, writes nothing
 *   npx tsx scripts/test-push-guard.ts --push    # also does one verified push
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters, type TallyMasters } from "../src/services/tallyMasters.js";
import { guardVoucher } from "../src/services/pushGuard.js";
import { safePush } from "../src/services/safePush.js";
import type { VoucherPayload } from "../src/types.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const PUSH = process.argv.includes("--push");
const TAG = `G${Date.now().toString().slice(-6)}`;
const TODAY = new Date().toISOString().slice(0, 10);

let pass = 0, fail = 0;

function expectRejected(name: string, p: VoucherPayload, m: TallyMasters, mustMention: string) {
  const r = guardVoucher(p, m);
  const hit = r.errors.find(e => e.toLowerCase().includes(mustMention.toLowerCase()));
  if (!r.ok && hit) { console.log(`  ✓ ${name}`); console.log(`      → ${hit}`); pass++; }
  else {
    console.log(`  ✗ ${name} — expected an error mentioning "${mustMention}"`);
    console.log(`      got: ${r.ok ? "ACCEPTED (!)" : r.errors.join(" | ")}`);
    fail++;
  }
}

function expectAccepted(name: string, p: VoucherPayload, m: TallyMasters) {
  const r = guardVoucher(p, m);
  if (r.ok) { console.log(`  ✓ ${name}${r.warnings.length ? `  (${r.warnings.length} warning)` : ""}`); pass++; }
  else { console.log(`  ✗ ${name} — unexpectedly rejected:`); for (const e of r.errors) console.log(`      ${e}`); fail++; }
}

async function main() {
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded in Tally");
  console.log(`→ ${company}\n`);
  const m = await loadMasters(TALLY_URL, company);

  // Pick real masters to build from.
  const supplier = [...m.ledgers.values()].find(l => /SUNDRY CREDITORS/i.test(l.parent) && l.state)!;
  const customer = [...m.ledgers.values()].find(l => /SUNDRY DEBTORS/i.test(l.parent) && l.state)!;
  const item = [...m.items.values()].find(i => i.closingStock > 20 && i.closingRate > 20)!;
  const godown = [...m.godowns][0];
  console.log(`using supplier="${supplier.name}" (${supplier.state}), item="${item.name}" (${item.baseUnit})\n`);

  const qty = 2, rate = item.closingRate, amount = Math.round(qty * rate * 100) / 100;
  // Interstate parties post to the CENTRAL account, local ones to W.B.
  const interstate = supplier.state.trim().toUpperCase() !== "WEST BENGAL";
  const purchaseAccount = interstate ? "PURCHASE ( GST CENTRAL )" : "PURCHASE ( GST W.B. )";

  /** A correct purchase, which each negative case then breaks in exactly one way. */
  const good = (): VoucherPayload => ({
    voucherType: "Purchase", date: TODAY, voucherNumber: `${TAG}/OK`, reference: `${TAG}/OK`,
    narration: `${TAG} guard test`, partyLedgerName: supplier.name, isInvoice: true,
    ledgerEntries: [{
      ledgerName: supplier.name, amount, isDeemedPositive: false, isPartyLedger: true,
      billAllocations: [{ name: `${TAG}/OK`, billType: "New Ref", amount }],
    }],
    inventoryEntries: [{
      stockItemName: item.name, quantity: qty, unit: item.baseUnit, rate, amount,
      isDeemedPositive: true, salesLedgerName: purchaseAccount,
      godownName: godown, batchName: "Primary Batch",
    }],
  });

  console.log("Failure modes the guard must catch:");

  // 1. The bug that silently dropped a whole accounting allocation today.
  const w = good(); w.inventoryEntries![0].salesLedgerName = purchaseAccount.replace("PURCHASE (", "PURCHASE  (");
  expectRejected("ledger name off by one space", w, m, purchaseAccount);

  // 2. Silently voids qty and rate.
  const u = good(); u.inventoryEntries![0].unit = "PCS";
  expectRejected("unit that is not the item's base unit", u, m, "base unit");

  // 3. Rejected by Tally with EXCEPTIONS=1 and no reason.
  const b = good(); b.ledgerEntries[0].amount = amount + 500;
  expectRejected("unbalanced voucher", b, m, "does not balance");

  // 4. Double-counts the credit side — today's original sales failure.
  const d = good();
  d.ledgerEntries.push({ ledgerName: purchaseAccount, amount, isDeemedPositive: true, isPartyLedger: false });
  expectRejected("accounting ledger duplicated as a ledger entry", d, m, "counted twice");

  // 5. Tally refuses when allocations don't match the line exactly.
  const ba = good(); ba.ledgerEntries[0].billAllocations![0].amount = amount - 10;
  expectRejected("bill allocations not summing to their line", ba, m, "must match exactly");

  // 6. This company has no Delivery Note type.
  const vt = good(); vt.voucherType = "Delivery Note";
  expectRejected("voucher type not configured in this company", vt, m, "not configured");

  // 7. A negative magnitude can make an unbalanced voucher net to zero.
  const neg = good(); neg.ledgerEntries[0].amount = -amount;
  expectRejected("negative amount instead of a magnitude", neg, m, "magnitude");

  // 8. Nonexistent item.
  const it = good(); it.inventoryEntries![0].stockItemName = "NO SUCH ITEM AT ALL";
  expectRejected("unknown stock item", it, m, "does not exist");

  // 9. Wrong stock direction for a purchase.
  const dir = good(); dir.inventoryEntries![0].isDeemedPositive = false;
  expectRejected("inward item marked outward", dir, m, "isDeemedPositive=true");

  // 10. Wrong tax head for the party's state — files wrong in GSTR-1 while
  //     looking perfect on screen. Only found at return time.
  const st = good();
  st.inventoryEntries![0].salesLedgerName = interstate ? "PURCHASE ( GST W.B. )" : "PURCHASE ( GST CENTRAL )";
  expectRejected(`tax account contradicting the party's state (${supplier.state})`, st, m,
    interstate ? "interstate transaction" : "local transaction");

  console.log("\nThe correct voucher:");
  expectAccepted("balanced purchase with exact master names", good(), m);

  if (PUSH) {
    console.log("\nVerified push:");
    const res = await safePush(TALLY_URL, company, good());
    if (res.ok) { console.log(`  ✓ pushed and verified — voucher ${res.voucherId}`); pass++; }
    else {
      console.log(`  ✗ failed at "${res.stage}"`);
      for (const e of res.errors) console.log(`      ${e}`);
      for (const d2 of res.differences) console.log(`      diff: ${d2}`);
      fail++;
    }
  }

  // ── GSTR-1 exception prevention ─────────────────────────────────────────
  // These map onto categories seen in the operator's own return. A voucher that
  // trips one of them balances, imports and reads back clean — and then never
  // reaches B2B supplies. The read-back diff cannot see it, so the guard must.
  console.log("\nGSTR-1 exceptions:");

  /**
   * The good purchase with an adjustment line bolted on and the party reduced to
   * match. This is INWARD, so the signs mirror a sale: stock is a debit
   * (negative) and the party a credit (positive), which means a discount that
   * reduces what we owe contributes POSITIVELY.
   */
  const withAdjustment = (appropriate: boolean): VoucherPayload => {
    const v = good();
    const net = Math.round((amount - 100) * 100) / 100;
    v.ledgerEntries[0].amount = net;
    v.ledgerEntries[0].billAllocations = [{ name: `${TAG}/OK`, billType: "New Ref", amount: net }];
    v.ledgerEntries.push({
      ledgerName: "TRADE DISCOUNTS / H.C.", amount: 100,
      isDeemedPositive: false, signedAmount: 100, isPartyLedger: false,
      ...(appropriate ? { appropriateToGst: "Goods" as const } : {}),
    });
    return v;
  };

  expectRejected("an adjustment line that does not appropriate to GST",
    withAdjustment(false), m, "appropriate to GST");

  expectAccepted("the same line once it appropriates to GST",
    withAdjustment(true), m);

  {
    // Tax heads and rounding change the total but are not adjustments to the
    // assessable value, so they must not be asked to declare appropriation.
    const v = good();
    const net = Math.round((amount - 0.4) * 100) / 100;
    v.ledgerEntries[0].amount = net;
    v.ledgerEntries[0].billAllocations = [{ name: `${TAG}/OK`, billType: "New Ref", amount: net }];
    v.ledgerEntries.push({ ledgerName: "ROUNDED OFF", amount: 0.4, isDeemedPositive: false, isPartyLedger: false });
    expectAccepted("ROUNDED OFF is not asked to appropriate", v, m);
  }

  console.log(`\n${"─".repeat(56)}\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
