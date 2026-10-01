/**
 * Stage 1 test suite — proves the guard refuses every failure mode we found by
 * experiment, and that a good voucher still pushes AND verifies.
 *
 * Every negative case here is a real bug that reached Tally at some point today
 * and returned CREATED=1 while corrupting or dropping data.
 *
 *   npx tsx scripts/test-push-guard.ts           # guard only, writes nothing
 *   npx tsx scripts/test-push-guard.ts --push    # also does one verified push
 *   npx tsx scripts/test-push-guard.ts --offline # fixture masters only, no Tally
 *
 * The offline section always runs first; it needs no Tally, so the ship-to /
 * identity / tax rules are asserted on every machine, cloud included.
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters, type TallyMasters } from "../src/services/tallyMasters.js";
import { guardVoucher } from "../src/services/pushGuard.js";
import { safePush } from "../src/services/safePush.js";
import type { VoucherPayload } from "../src/types.js";
import {
  fixtureMasters, fixtureOpenBills, sale, receipt, purchase, PARTY_LOCAL, PARTY_INTER, PARTY_UNREG,
} from "./guardrails/fixtures.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const PUSH = process.argv.includes("--push");
const OFFLINE = process.argv.includes("--offline");
const TAG = `G${Date.now().toString().slice(-6)}`;
const TODAY = new Date().toISOString().slice(0, 10);

let pass = 0, fail = 0;

function expectRejected(name: string, p: VoucherPayload, m: TallyMasters, mustMention: string, ctx: Parameters<typeof guardVoucher>[2] = {}) {
  const r = guardVoucher(p, m, ctx);
  const hit = r.errors.find(e => e.toLowerCase().includes(mustMention.toLowerCase()));
  if (!r.ok && hit) { console.log(`  ✓ ${name}`); console.log(`      → ${hit}`); pass++; }
  else {
    console.log(`  ✗ ${name} — expected an error mentioning "${mustMention}"`);
    console.log(`      got: ${r.ok ? "ACCEPTED (!)" : r.errors.join(" | ")}`);
    fail++;
  }
}

function expectAccepted(name: string, p: VoucherPayload, m: TallyMasters, ctx: Parameters<typeof guardVoucher>[2] = {}) {
  const r = guardVoucher(p, m, ctx);
  if (r.ok) { console.log(`  ✓ ${name}${r.warnings.length ? `  (${r.warnings.length} warning)` : ""}`); pass++; }
  else { console.log(`  ✗ ${name} — unexpectedly rejected:`); for (const e of r.errors) console.log(`      ${e}`); fail++; }
}

/**
 * Offline — fixture masters shaped on the real company (scripts/guardrails/
 * fixtures.ts), no Tally. Owner, 23-Sep-2026: "bill-to and ship-to are always
 * the same for every party … an empty ship-to breaks the e-way bill."
 */
function offlineCases() {
  const m = fixtureMasters();
  const clip = [{ item: "CARRIER CLIP", amount: 1000, rate: 5 }];
  const withLedger = (name: string, patch: Record<string, unknown>): TallyMasters => {
    const ledgers = new Map(m.ledgers);
    const l = ledgers.get(name)!;
    ledgers.set(name, { ...l, ...patch, mailing: [] } as typeof l);
    return { ...m, ledgers } as TallyMasters;
  };

  console.log("Ship-to = bill-to (offline, fixture masters):");
  expectAccepted("registered local sale — ledger carries address + pincode", sale({ number: "PG/1", party: PARTY_LOCAL, lines: clip }), m);
  expectAccepted("inter-state sale (IGST)", sale({ number: "PG/2", party: PARTY_INTER, inter: true, lines: clip }), m);
  expectAccepted("unregistered party ledger", sale({ number: "PG/3", party: PARTY_UNREG, lines: clip }), m);
  expectRejected("party sale whose ledger has NO pincode (e-way bill would be refused)",
    sale({ number: "PG/4", party: PARTY_LOCAL, lines: clip }), withLedger(PARTY_LOCAL, { pincode: "" }), "pincode");
  expectRejected("party sale whose ledger has NO address",
    sale({ number: "PG/5", party: PARTY_LOCAL, lines: clip }), withLedger(PARTY_LOCAL, { address: [] }), "address");
  expectAccepted("cash walk-in with typed name + address",
    sale({ number: "PG/6", party: "Cash", placeOfSupply: "West Bengal", buyerName: "SUBHAS CYCLE", buyerAddress: ["JHALDAH", "PURULIA 723202"], lines: clip }), m);
  // Owner, 24-Sep-2026: a buyer address is now ALWAYS required on a cash
  // sale (not only above the e-way bill limit), and a cash sale above
  // ₹50,000 of goods is refused outright.
  expectRejected("cash walk-in, name only, no address (owner, 24-Sep-2026: address is always required now)",
    sale({ number: "PG/7", party: "Cash", placeOfSupply: "West Bengal", buyerName: "SUBHAS CYCLE", lines: clip }), m, "needs the buyer's address");
  expectAccepted("cash walk-in with name + address, well under the ceiling",
    sale({ number: "PG/7a", party: "Cash", placeOfSupply: "West Bengal", buyerName: "SUBHAS CYCLE", buyerAddress: ["JHALDAH"], lines: clip }), m);
  expectRejected("cash walk-in with no buyer name (ship-to name would read \"Cash\")",
    sale({ number: "PG/7b", party: "Cash", placeOfSupply: "West Bengal", buyerAddress: ["JHALDAH"], lines: clip }), m, "buyer's name");
  expectRejected("cash walk-in over ₹50,000 of goods is refused outright, not merely needing an e-way bill",
    sale({ number: "PG/8", party: "Cash", placeOfSupply: "West Bengal", buyerName: "SUBHAS CYCLE", buyerAddress: ["JHALDAH", "PURULIA 723202"], lines: [{ item: "CARRIER CLIP", amount: 60000, rate: 5 }] }), m, "over the ₹50000 limit for a cash sale");
  expectAccepted("cash walk-in AT the ₹50,000 ceiling (goods value, not over it) still passes",
    sale({ number: "PG/8c", party: "Cash", placeOfSupply: "West Bengal", buyerName: "SUBHAS CYCLE", buyerAddress: ["JHALDAH", "PURULIA 723202"], lines: [{ item: "CARRIER CLIP", amount: 50000, rate: 5 }] }), m);
  expectRejected("cash walk-in declaring an out-of-state place of supply",
    sale({ number: "PG/8d", party: "Cash", placeOfSupply: "Odisha", buyerName: "X", buyerAddress: ["Y"], lines: clip }), m, "place of supply is West Bengal");
  // MIXED ORDER: several cash orders billed together for packing convenience,
  // a different buyer every time (owner, 24-Sep-2026). Its ledger carries a
  // state (unlike Cash) but no pincode — gets the SAME cash rules regardless.
  expectAccepted("MIXED ORDER passes with no ledger pincode once a buyer address is typed",
    sale({ number: "PG/8h", party: "MIXED ORDER", placeOfSupply: "West Bengal", buyerName: "WALK-IN BUYER", buyerAddress: ["BAGNAN"], lines: clip }), m);
  expectRejected("MIXED ORDER still needs a typed buyer address",
    sale({ number: "PG/8i", party: "MIXED ORDER", placeOfSupply: "West Bengal", buyerName: "WALK-IN BUYER", lines: clip }), m, "needs the buyer's address");
  expectRejected("MIXED ORDER gets the same ₹50,000 ceiling as Cash",
    sale({ number: "PG/8j", party: "MIXED ORDER", placeOfSupply: "West Bengal", buyerName: "WALK-IN BUYER", buyerAddress: ["BAGNAN"], lines: [{ item: "CARRIER CLIP", amount: 60000, rate: 5 }] }), m, "over the ₹50000 limit for a cash sale");
  expectRejected("a party-ledger sale carrying a typed buyer name/address (second consignee)",
    sale({ number: "PG/8e", party: PARTY_LOCAL, buyerName: "SOMEONE ELSE", buyerAddress: ["ELSEWHERE"], lines: clip }), m, "second consignee");
  expectRejected("a Sales Order Note whose ledger has no pincode (refused like a Sales invoice)",
    { ...sale({ number: "PG/8f", party: PARTY_LOCAL, lines: clip }), voucherType: "Sales Order Note", isInvoice: false }, withLedger(PARTY_LOCAL, { pincode: "" }), "pincode");
  expectRejected("a ledger pincode that is not 6 digits",
    sale({ number: "PG/8g", party: PARTY_LOCAL, lines: clip }), withLedger(PARTY_LOCAL, { pincode: "74350" }), "6-digit");

  console.log("\nGSTIN, state, HSN, tax ledgers (offline, mirrors the web's gstIdentity):");
  const regWith = (gstin: string, state = "West Bengal") => withLedger(PARTY_LOCAL, { gstin, state, registrations: [{ applicableFrom: "20170701", gstin, registrationType: "Regular", placeOfSupply: state, state }] });
  expectRejected("a GSTIN whose check digit fails", sale({ number: "PG/20", party: PARTY_LOCAL, lines: clip }), regWith("19AAAAR0000R1Z5"), "check digit");
  expectRejected("a GSTIN issued in Odisha on a West Bengal ledger", sale({ number: "PG/21", party: PARTY_LOCAL, lines: clip }), regWith("21AAAAD0000D1Z5"), "issued in Odisha");
  expectRejected("a ledger state that is not a GST state name",
    sale({ number: "PG/22", party: PARTY_UNREG, lines: clip }), withLedger(PARTY_UNREG, { state: "West Bangal", registrations: [{ applicableFrom: "20170701", gstin: "", registrationType: "Unregistered/Consumer", placeOfSupply: "West Bangal", state: "West Bangal" }] }), "not a GST state");
  {
    const noHsn = { ...m, stockGroups: new Map([...m.stockGroups].map(([k, g]) => [k, { ...g, hsnRevisions: [] }])) } as TallyMasters;
    expectRejected("an outward line whose item has no HSN anywhere in its chain", sale({ number: "PG/23", party: PARTY_LOCAL, lines: clip }), noHsn, "no HSN");
  }
  {
    const p = purchase("PG/24", clip);
    p.ledgerEntries.find(e => e.ledgerName === "INPUT IGST")!.ledgerName = "OUTPUT IGST";
    expectRejected("a purchase booking its tax to an OUTPUT ledger", p, m, "OUTPUT tax ledger");
  }
  expectRejected("cash walk-in with no place of supply (ship-to state empty)",
    sale({ number: "PG/9", party: "Cash", lines: clip }), m, "state");

  console.log("\nIdentity, numbering, tax, round-off (offline):");
  expectRejected("a Create with no remoteId (G5)", sale({ number: "PG/10", party: PARTY_LOCAL, lines: clip, remoteId: null }), m, "remoteId");
  expectRejected("a Sales Create with no voucher number", { ...sale({ number: "PG/11", party: PARTY_LOCAL, lines: clip }), voucherNumber: undefined }, m, "voucherNumber");
  {
    // Split Invoice's manual override (24-Sep-2026): pushGuard refuses a
    // duplicate of an existing number, but ONLY when the mirror was loaded
    // (safePush does that just for an override — see GuardContext). Absent,
    // it degrades to a warning rather than a silent pass (G7).
    const overridden = { ...sale({ number: "26-27/0733", party: PARTY_LOCAL, lines: clip }), numberOverride: true };
    const mirror = { existingVoucherNumbers: new Set(["26-27/0733"]) };
    expectRejected("an overridden number that duplicates one already in the mirror", overridden, m, "already exists", mirror);
    expectAccepted("an overridden number the mirror confirms is free", { ...overridden, voucherNumber: "26-27/0740" }, m, { existingVoucherNumbers: new Set(["26-27/0733"]) });
    {
      const r = guardVoucher(overridden, m, {});
      if (r.ok && r.warnings.some(w => /could not be checked/i.test(w))) { console.log("  ✓ an overridden number with no mirror loaded — warns, does not silently pass"); pass++; }
      else { console.log("  ✗ an overridden number with no mirror loaded — expected an ACCEPT carrying a warning"); fail++; }
    }
  }
  expectRejected("tax at 12% on an item whose dated rate is 5%", sale({ number: "PG/12", party: PARTY_LOCAL, lines: [{ item: "CARRIER CLIP", amount: 1000, rate: 12 }] }), m, "Tax booked");
  expectRejected("an outward line with no rate anywhere in its chain", sale({ number: "PG/13", party: PARTY_LOCAL, lines: [{ item: "EV THING", amount: 1000, rate: 5 }] }), m, "No GST rate resolves");
  expectRejected("a Credit Note (never automated)", { ...sale({ number: "PG/14", party: PARTY_LOCAL, lines: clip }), voucherType: "Credit Note" }, m, "never automated");
  {
    const v = sale({ number: "PG/15", party: PARTY_LOCAL, lines: [{ item: "CARRIER CLIP", amount: 1000.3, rate: 5 }] });
    const r = v.ledgerEntries.find(e => e.ledgerName === "ROUNDED OFF");
    if (r) { r.isDeemedPositive = true; expectRejected("a sales round-off moved to the debit side", v, m, "CREDIT side"); }
  }
  const bills = { openBills: fixtureOpenBills() };
  expectRejected("an Agst Ref naming another party's open bill", receipt("PG/16", PARTY_LOCAL, 1000, "Agst Ref", "TI/26-27/34"), m, "not an open bill", bills);
  expectAccepted("an Agst Ref naming this party's open bill", receipt("PG/17", PARTY_LOCAL, 1000, "Agst Ref", "26-27/0460"), m, bills);
  expectAccepted("an inter-state purchase (place of supply is OURS)", purchase("PG/18", clip), m);
}

async function main() {
  // pushGuard reads MKCP_FILED_THROUGH at import; the fixtures are dated in
  // the open period, so nothing here depends on it.
  offlineCases();
  if (OFFLINE) {
    console.log(`\n${"─".repeat(56)}\n${pass} passed, ${fail} failed`);
    if (fail) process.exit(1);
    return;
  }
  console.log("");
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
    // G5: a Create without identity is refused, and --push would strand it.
    remoteId: `MKCP|TEST|${TODAY}|${TAG}/OK`,
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
    // A purchase round-off sits on the DEBIT side with its sign on the amount
    // (web purchasePayload; pushGuard TG-P17) — here a "negative debit".
    v.ledgerEntries.push({ ledgerName: "ROUNDED OFF", amount: 0.4, isDeemedPositive: true, signedAmount: 0.4, isPartyLedger: false });
    expectAccepted("ROUNDED OFF is not asked to appropriate", v, m);
  }

  console.log(`\n${"─".repeat(56)}\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
