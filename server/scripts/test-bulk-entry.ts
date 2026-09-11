/**
 * Stage 3 test — FIFO settlement logic, then a real bulk run against Tally.
 *
 *   npx tsx scripts/test-bulk-entry.ts          # logic only, writes nothing
 *   npx tsx scripts/test-bulk-entry.ts --push   # also pushes a small real batch
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadOpenBills, allocateFIFO, billsForParty, receivableBills, payableBills, daysOverdue, type OpenBill } from "../src/services/billSettlement.js";
import { buildBulkVoucher, pushBulk, type BulkRow } from "../src/services/bulkEntry.js";
import { loadMasters } from "../src/services/tallyMasters.js";
import { guardVoucher } from "../src/services/pushGuard.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const PUSH = process.argv.includes("--push");

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); fail++; }
}

const bill = (name: string, date: string, outstanding: number): OpenBill => ({
  name, party: "P", date, closing: -outstanding, outstanding, creditPeriod: "20 Days",
});

async function main() {
  console.log("FIFO allocation (pure logic):\n");

  const bills = [bill("A", "20260401", 1000), bill("B", "20260410", 500), bill("C", "20260420", 250)];

  const exact = allocateFIFO(bills, 1000);
  check("an amount matching the oldest bill clears exactly it",
    exact.allocations.length === 1 && exact.allocations[0].name === "A" && exact.fullyMatched,
    JSON.stringify(exact.allocations));

  const spill = allocateFIFO(bills, 1300);
  check("a larger amount clears oldest-first and part-pays the next",
    spill.allocations.length === 2 && spill.allocations[0].amount === 1000
      && spill.allocations[1].name === "B" && spill.allocations[1].amount === 300,
    JSON.stringify(spill.allocations));

  const part = allocateFIFO(bills, 400);
  check("a part payment allocates against the oldest bill only",
    part.allocations.length === 1 && part.allocations[0].amount === 400 && part.billsClosed.length === 0,
    JSON.stringify(part.allocations));

  const over = allocateFIFO(bills, 2000);
  check("an overpayment clears everything and leaves the rest On Account",
    over.onAccount === 250 && over.allocations.filter(a => a.billType === "Agst Ref").length === 3,
    `onAccount=${over.onAccount}`);

  const tiny = allocateFIFO([], 5);
  check("a small unexplained credit with no open bills goes On Account",
    tiny.onAccount === 5 && !tiny.fullyMatched, JSON.stringify(tiny));

  const closes = allocateFIFO(bills, 1500);
  check("bills fully covered are reported as closed",
    closes.billsClosed.join(",") === "A,B", closes.billsClosed.join(","));

  // ── Against live data ────────────────────────────────────────────────────
  console.log("\nAgainst live Tally data:\n");
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  const open = await loadOpenBills(TALLY_URL, company);
  const recv = receivableBills(open), pay = payableBills(open);
  console.log(`  ${open.length} open bills — ${recv.length} receivable, ${pay.length} payable`);
  check("open bills load from Tally", open.length > 0);

  const overdue = recv.map(b => ({ b, d: daysOverdue(b) })).filter(x => (x.d ?? 0) > 0);
  console.log(`  ${overdue.length} receivable bills are past their credit period`);
  check("due dates derive from each bill's own credit period", overdue.every(x => x.d !== null));

  // Pick a customer with several open bills and settle exactly their oldest two.
  const byParty = new Map<string, OpenBill[]>();
  for (const b of recv) { if (!byParty.has(b.party)) byParty.set(b.party, []); byParty.get(b.party)!.push(b); }
  // Prefer a customer with several open bills, but don't require one — settling
  // bills over a session legitimately leaves everyone down to one.
  const target = [...byParty.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  check("found a customer with at least one open bill", !!target);
  if (!target) { report(); return; }

  const [party] = target;
  const ordered = billsForParty(recv, party);
  const takeCount = Math.min(2, ordered.length);
  console.log(`  "${party}" has ${ordered.length} open bill(s), oldest ${ordered[0].date}`);
  const twoOldest = ordered.slice(0, takeCount).reduce((s, b) => s + b.outstanding, 0);

  const masters = await loadMasters(TALLY_URL, company);
  const row: BulkRow = {
    party, amount: twoOldest, account: "HDFC BANK",
    narration: "BULK TEST RTGS RECEIVED",
    instrument: { transactionType: "Cheque/DD", transferMode: "NEFT", instrumentNumber: `HDFCN${Date.now().toString().slice(-9)}` },
  };
  const built = buildBulkVoucher("receipt", row, open, 1);
  check(`a receipt for the ${takeCount} oldest bill(s) allocates to exactly those`,
    built.settled.length === takeCount && built.settled.map(s => s.name).join(",") === ordered.slice(0, takeCount).map(b => b.name).join(","),
    JSON.stringify(built.settled));
  check("allocations sum exactly to the party line",
    Math.abs(built.settled.reduce((s, b) => s + b.amount, 0) - twoOldest) < 0.02);

  const g = guardVoucher(built.payload, masters);
  check("the generated receipt passes the guard", g.ok, g.errors.join(" | "));

  // A part payment must leave nothing allocated, since Tally requires allocations
  // to match the line exactly and the remainder belongs on account.
  const partial = buildBulkVoucher("receipt", { ...row, amount: twoOldest + 777 }, open, 2);
  check("an amount exceeding all open bills sends no allocations and reports On Account",
    partial.settled.length === 0 && partial.onAccount > 0, `onAccount=${partial.onAccount}`);

  if (PUSH) {
    console.log("\nReal bulk run (2 receipts):\n");
    const oldest = ordered[0];
    const rows: BulkRow[] = [
      { party, amount: oldest.outstanding, account: "HDFC BANK", narration: "BULK TEST 1",
        instrument: { transactionType: "Cheque/DD", transferMode: "NEFT", instrumentNumber: `HDFCN${Date.now().toString().slice(-9)}1` } },
      { party, amount: 5, account: "HDFC BANK", narration: "BULK TEST 2 (small credit)",
        instrument: { transactionType: "Cheque/DD", transferMode: "NEFT", instrumentNumber: `HDFCN${Date.now().toString().slice(-9)}2` } },
    ];
    const res = await pushBulk(TALLY_URL, company, "receipt", rows);
    for (const r of res.rows) {
      console.log(`  ${r.ok ? "✓" : "✗"} ₹${r.row.amount.toFixed(2)} → ${r.ok ? `voucher ${r.voucherId}` : r.errors.join(" | ")}`
        + (r.settledBills.length ? `  [clears ${r.settledBills.map(b => b.name).join(", ")}]` : "")
        + (r.onAccount ? `  [₹${r.onAccount.toFixed(2)} on account]` : ""));
      for (const d of r.differences) console.log(`        diff: ${d}`);
    }
    check("every row in the batch pushed and verified", res.failed === 0, `${res.failed} failed`);
    check("each row produced its own voucher", res.rows.filter(r => r.voucherId).length === res.succeeded);
    // Regression: the batch used to reuse one snapshot, so a second row could
    // settle a bill the first row had already cleared.
    const settledNames = res.rows.flatMap(r => r.settledBills.map(b => b.name));
    check("no bill is settled twice within one batch",
      new Set(settledNames).size === settledNames.length, settledNames.join(", "));
    // With bills still open, ₹5 is a part payment against the NEXT one — which
    // is correct (part payments are normal here). On Account is only right when
    // there is nothing left to allocate against.
    // Either outcome is correct, and both prove the same thing: the first row's
    // bill was drawn down, so the second could not re-settle it. Which one you
    // get depends purely on whether that party had another bill left open.
    const second = res.rows[1];
    const firstBill = res.rows[0].settledBills[0]?.name;
    const movedOn = second.settledBills.length > 0 && second.settledBills.every(b => b.name !== firstBill);
    const wentOnAccount = second.settledBills.length === 0 && second.onAccount > 0;
    check("the second row did not reuse the bill the first one cleared",
      movedOn || wentOnAccount,
      `settled=${JSON.stringify(second.settledBills)} onAccount=${second.onAccount} first=${firstBill}`);
  }

  report();
}

function report() {
  console.log(`\n${"─".repeat(56)}\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
