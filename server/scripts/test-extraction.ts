/**
 * Stages 4 & 5 — the deterministic half, tested without a single image.
 *
 * Extraction (reading pixels) is one adapter behind this. Everything here is
 * what happens AFTER a model has read something, and it is where the expensive
 * mistakes live: a supplier's wording resolved to the wrong stock item, a bank
 * narration matched to the wrong party, a unit taken from the invoice instead of
 * the master.
 *
 *   npx tsx scripts/test-extraction.ts          # logic only
 *   npx tsx scripts/test-extraction.ts --push   # also books one synthetic bank row
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters } from "../src/services/tallyMasters.js";
import { resolveName, resolveInvoice, resolvePayerFromNarration, type ExtractedInvoice, type ExtractedBankRow } from "../src/services/extraction.js";
import { loadOpenBills, receivableBills, billsForParty } from "../src/services/billSettlement.js";
import { planFromBankRows, pushBankPlan } from "../src/services/bankToReceipts.js";
import { guardVoucher } from "../src/services/pushGuard.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const PUSH = process.argv.includes("--push");
const STAMP = Date.now().toString().slice(-8);

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); fail++; }
};

async function main() {
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  const masters = await loadMasters(TALLY_URL, company);

  const anyItem = [...masters.items.values()].find(i => i.closingStock > 10 && i.closingRate > 10)!;
  const debtor = [...masters.ledgers.values()].find(l => /SUNDRY DEBTORS/i.test(l.parent))!;
  const supplier = [...masters.ledgers.values()].find(l => /SUNDRY CREDITORS/i.test(l.parent) && l.state)!;

  // ── Name resolution ──────────────────────────────────────────────────────
  console.log("\nResolving printed text to real masters:\n");

  const exact = resolveName(anyItem.name, masters.items.keys());
  check("an exact name resolves", exact.status === "resolved" && exact.value === anyItem.name);

  const spaced = resolveName(anyItem.name.replace(/\s+/g, "  "), masters.items.keys());
  check("extra whitespace still resolves (punctuation-only difference)",
    spaced.status === "resolved" && spaced.value === anyItem.name,
    JSON.stringify(spaced));

  const nonsense = resolveName("SOMETHING NOBODY SELLS", masters.items.keys());
  check("an unknown description becomes a question, never a guess",
    nonsense.status === "question", JSON.stringify(nonsense));

  // The trap the archive documents: similar wording, genuinely different items.
  const trap = resolveName("Fork Togo 20 inch", masters.items.keys());
  check("a plausible-but-inexact item is queued rather than auto-matched",
    trap.status === "question",
    trap.status === "resolved" ? `auto-matched to "${trap.value}" — unsafe` : "");
  if (trap.status === "question" && trap.candidates.length) {
    console.log(`      suggests: ${trap.candidates.join(" | ")}`);
  }

  // A human's past confirmation outranks everything, because the same words
  // mean different items from different vendors.
  const learned = new Map([["FORK TOGO 20 INCH", anyItem.name]]);
  const viaLearned = resolveName("Fork Togo 20 inch", masters.items.keys(), learned);
  check("a learned mapping wins over a fuzzy guess",
    viaLearned.status === "resolved" && viaLearned.how === "learned");

  // ── Invoice resolution ───────────────────────────────────────────────────
  console.log("\nResolving a whole invoice:\n");

  const goodInvoice: ExtractedInvoice = {
    vendorText: supplier.name, invoiceNumber: "TEST/1", invoiceDate: "2026-09-11",
    lines: [{ description: anyItem.name, quantity: 4, unitText: "PCS", rate: 100, amount: 400, confidence: 0.97 }],
    taxableTotal: 400, sourceImageId: "img-1", confidence: 0.96,
  };
  const r1 = resolveInvoice(goodInvoice, masters);
  check("a clean invoice resolves with no questions", r1.ready, JSON.stringify(r1.questions));
  check("the UNIT comes from the item master, not the invoice's wording",
    r1.lines[0]?.unit === anyItem.baseUnit && anyItem.baseUnit !== "PCS",
    `invoice said "PCS", master says "${anyItem.baseUnit}", used "${r1.lines[0]?.unit}"`);

  const lowConf = resolveInvoice({ ...goodInvoice,
    lines: [{ ...goodInvoice.lines[0], confidence: 0.4 }] }, masters);
  check("a low-confidence line is queued, not booked",
    !lowConf.ready && lowConf.questions.some(q => /low confidence/i.test(q.reason)));

  const badTotals = resolveInvoice({ ...goodInvoice, taxableTotal: 4000 }, masters);
  check("line amounts that contradict the printed total raise a question",
    badTotals.questions.some(q => q.field === "totals"),
    JSON.stringify(badTotals.questions));

  const unknownVendor = resolveInvoice({ ...goodInvoice, vendorText: "BRAND NEW SUPPLIER LTD" }, masters);
  check("an unknown vendor blocks the invoice", !unknownVendor.ready && !unknownVendor.vendor);

  // ── Bank narration → party ───────────────────────────────────────────────
  console.log("\nMatching bank narrations to parties:\n");

  const narration = `NEFT-HDFCN52026091101-${debtor.name}-PAYMENT`;
  const payer = resolvePayerFromNarration(narration, masters.ledgers.keys());
  check("a party embedded in a bank narration is found",
    payer.status === "resolved" && payer.value === debtor.name,
    JSON.stringify(payer));

  const vague = resolvePayerFromNarration("NEFT-CMS-000123456-COLLECTION", masters.ledgers.keys());
  check("a narration naming nobody becomes a question", vague.status === "question");

  // ── Bank rows → a reviewable plan ────────────────────────────────────────
  console.log("\nTurning statement rows into vouchers:\n");

  const bills = await loadOpenBills(TALLY_URL, company);
  const recv = receivableBills(bills);
  const withBills = [...new Set(recv.map(b => b.party))]
    .map(p => ({ party: p, bills: billsForParty(recv, p) }))
    .sort((a, b) => b.bills.length - a.bills.length)[0];
  check("found a customer with an open bill to settle", !!withBills);
  if (!withBills) { report(); return; }

  const oldest = withBills.bills[0];
  const rows: ExtractedBankRow[] = [
    { date: "2026-09-11", amount: oldest.outstanding,
      description: `NEFT-UTR${STAMP}1-${withBills.party}-INV SETTLEMENT`,
      reference: `UTR${STAMP}1`, sourceImageId: "bank-1", confidence: 0.97 },
    { date: "2026-09-11", amount: 250,
      description: "NEFT-UTR${STAMP}2-UNIDENTIFIED REMITTER",
      reference: `UTR${STAMP}2`, sourceImageId: "bank-1", confidence: 0.95 },
    { date: "2026-09-11", amount: 999,
      description: `NEFT-UTR${STAMP}3-${withBills.party}-PART`,
      reference: `UTR${STAMP}3`, sourceImageId: "bank-1", confidence: 0.3 },
  ];

  const plan = planFromBankRows(rows, masters, bills, "HDFC BANK");
  check("the identified row became a bookable receipt", !!plan.rows[0].payload && !plan.rows[0].question);
  check("it settles the oldest open bill first",
    plan.rows[0].settles[0]?.name === oldest.name, JSON.stringify(plan.rows[0].settles));
  check("the unidentified remitter is queued, not booked to a guessed party",
    !!plan.rows[1].question && !plan.rows[1].payload);
  check("the low-confidence row is queued", !!plan.rows[2].question);
  check("the plan counts what is ready versus what needs an answer",
    plan.ready === 1 && plan.needsAnswer === 2, `ready=${plan.ready} needsAnswer=${plan.needsAnswer}`);

  const g = guardVoucher(plan.rows[0].payload!, masters);
  check("the generated receipt passes the push guard", g.ok, g.errors.join(" | "));
  check("the UTR is carried into the bank instrument",
    plan.rows[0].payload!.ledgerEntries.some(e => e.bankAllocation?.instrumentNumber === `UTR${STAMP}1`));

  if (PUSH) {
    console.log("\nBooking the ready rows:\n");
    const res = await pushBankPlan(TALLY_URL, company, plan);
    for (const d of res.details) {
      console.log(`  ${d.voucherId ? "✓" : "✗"} ₹${Math.abs(d.row.source.amount).toFixed(2)} ${d.row.party ?? ""} → ${d.voucherId ?? d.errors.join(" | ")}`);
      for (const x of d.differences) console.log(`        diff: ${x}`);
    }
    check("ready rows booked and verified", res.pushed === 1 && res.failed === 0,
      `pushed=${res.pushed} failed=${res.failed} skipped=${res.skipped}`);
    check("rows needing an answer were left alone", res.skipped === 2, `skipped=${res.skipped}`);
  }

  report();
}

function report() {
  console.log(`\n${"─".repeat(56)}\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
