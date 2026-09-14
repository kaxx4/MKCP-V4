/**
 * Bank statement rows → receipts and payments, planned against the real books.
 *
 * READ-ONLY. It loads real masters and real open bills from Tally, plans
 * synthetic statement rows against them, and runs every resulting payload
 * through the push guard — but pushes NOTHING. Booking fictitious money
 * movements against real parties is not a thing to do to prove a planner.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * `bankToReceipts` was complete and had no route, so nothing could reach it —
 * the same shape as the purchase converter, and as the seven features in this
 * codebase that typechecked, looked right and did nothing. It now has one
 * (/api/bank/plan, /api/bank/push). This is the proof that what comes out the
 * other end is a voucher Tally would actually accept.
 *
 * ── The rules being pinned ────────────────────────────────────────────────
 *
 *   · a statement is PAYMENTS ONLY in the bank sense — cash is entered by hand
 *   · settlement is FIFO against that party's OWN bills, never another's
 *   · an amount matching nothing is left On Account rather than forced
 *   · a narration that cannot be resolved to one party raises a QUESTION and
 *     is never given a payload
 *
 * That third rule is the expensive one. An `Agst Ref` naming a bill belonging
 * to a different party is silently rewritten by Tally to `New Ref` — creating a
 * liability instead of clearing one, and reporting success.
 *
 *   npx tsx scripts/test-bank-to-receipts.ts
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters, type TallyMasters } from "../src/services/tallyMasters.js";
import { loadOpenBills, receivableBills, payableBills, type OpenBill } from "../src/services/billSettlement.js";
import { planFromBankRows } from "../src/services/bankToReceipts.js";
import { guardVoucher } from "../src/services/pushGuard.js";
import type { ExtractedBankRow } from "../src/services/extraction.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const BANK = process.env.MKCP_BANK_LEDGER || "HDFC BANK";

let passed = 0, failed = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`    \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; failures.push(label); console.log(`    \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
};
const H = (s: string) => console.log(`\n\x1b[1m── ${s} ${"─".repeat(Math.max(0, 56 - s.length))}\x1b[0m`);

const row = (over: Partial<ExtractedBankRow> = {}): ExtractedBankRow => ({
  date: new Date().toISOString().slice(0, 10),
  amount: 1000,
  description: "NEFT CR",
  reference: `UTR${Date.now().toString().slice(-8)}`,
  sourceImageId: "test",
  confidence: 0.99,
  ...over,
});

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  const masters: TallyMasters = await loadMasters(U, company);
  const bills: OpenBill[] = await loadOpenBills(U, company);

  const receivables = receivableBills(bills);
  const payables = payableBills(bills);

  console.log(`\n\x1b[1mBank statement → vouchers, planned against the real books\x1b[0m\n`);
  console.log(`company      "${company}"`);
  console.log(`bank ledger  ${BANK}`);
  console.log(`open bills   ${receivables.length} receivable · ${payables.length} payable`);

  ok("the bank ledger exists in this company", masters.ledgers.has(BANK)
    || [...masters.ledgers.keys()].some((k) => k.toUpperCase() === BANK.toUpperCase()), BANK);
  if (receivables.length === 0 && payables.length === 0) {
    console.log("\n\x1b[33mNo open bills — nothing to settle against. Cannot judge allocation.\x1b[0m\n");
    process.exit(1);
  }

  const owing = receivables[0];
  const owed = payables[0];

  H("MONEY IN — A RECEIPT THAT SETTLES A REAL BILL");
  {
    // The narration carries the payer's name, which is how the real ones read.
    const plan = planFromBankRows(
      [row({ amount: owing.outstanding, description: `NEFT CR ${owing.party}` })],
      masters, bills, BANK,
    );
    const r = plan.rows[0];
    ok("planned as a receipt", r?.kind === "receipt", r?.kind);
    ok("resolved to the payer named in the narration", r?.party === owing.party,
      `${r?.party ?? "none"} (wanted ${owing.party})`);
    ok("settles against that party's own bill",
      r?.settles.length === 1 && r.settles[0].name === owing.name,
      r?.settles.map((s) => `${s.name} ${s.amount}`).join(", ") || "none");
    ok("nothing left on account for an exact-amount payment", (r?.onAccount ?? -1) === 0,
      String(r?.onAccount));

    ok("it produced a payload", Boolean(r?.payload));
    if (r?.payload) {
      const g = guardVoucher(r.payload, masters);
      // The whole point: a voucher the guard would accept, not merely an object.
      ok("the payload passes the push guard", g.ok, g.errors.join(" | ").slice(0, 160));
      ok("it is a Receipt", r.payload.voucherType === "Receipt", r.payload.voucherType);
      ok("it carries a remoteId, so it stays correctable", Boolean(r.payload.remoteId), r.payload.remoteId);

      const party = r.payload.ledgerEntries.find((e) => e.isPartyLedger);
      ok("the party line settles Agst Ref, not On Account",
        party?.billAllocations?.[0]?.billType === "Agst Ref",
        party?.billAllocations?.[0]?.billType);
      /* The expensive mistake. A bill belonging to another party is silently
         rewritten by Tally to New Ref, creating a liability instead of
         clearing one — and still reporting success. */
      ok("every allocated bill belongs to THIS party",
        (party?.billAllocations ?? []).every((a) =>
          bills.some((b) => b.name === a.name && b.party === r.party)),
        (party?.billAllocations ?? []).map((a) => a.name).join(", "));

      const bank = r.payload.ledgerEntries.find((e) => !e.isPartyLedger);
      ok("the other side is the bank", Boolean(bank) && /BANK/i.test(bank!.ledgerName), bank?.ledgerName);
      ok("the UTR is carried as the instrument number",
        Boolean(bank?.bankAllocation?.instrumentNumber), bank?.bankAllocation?.instrumentNumber);
      const net = r.payload.ledgerEntries.reduce(
        (s, e) => s + (e.isDeemedPositive ? -e.amount : e.amount), 0);
      ok("the voucher balances", Math.abs(net) < 0.01, `net ₹${net.toFixed(2)}`);
    }
  }

  H("MONEY OUT — A PAYMENT AGAINST A SUPPLIER BILL");
  if (owed) {
    const plan = planFromBankRows(
      [row({ amount: -owed.outstanding, description: `NEFT DR ${owed.party}` })],
      masters, bills, BANK,
    );
    const r = plan.rows[0];
    ok("a negative amount is planned as a payment", r?.kind === "payment", r?.kind);
    ok("resolved to the supplier", r?.party === owed.party, `${r?.party ?? "none"}`);
    if (r?.payload) {
      const g = guardVoucher(r.payload, masters);
      ok("the payment passes the push guard", g.ok, g.errors.join(" | ").slice(0, 160));
      ok("it is a Payment", r.payload.voucherType === "Payment", r.payload.voucherType);
    } else {
      ok("the payment produced a payload", false, "none");
    }
  } else {
    console.log("    (no open payables in this company — skipped)");
  }

  H("WHAT IT REFUSES TO DECIDE ALONE");
  {
    // A narration naming nobody the masters know. Guessing here would book money
    // against the wrong party, so it must ask instead.
    const plan = planFromBankRows(
      [row({ description: "NEFT CR ZZQX UNKNOWN COUNTERPARTY 4471" })], masters, bills, BANK,
    );
    const r = plan.rows[0];
    ok("an unresolvable narration raises a question", Boolean(r?.question),
      r?.question?.reason ?? "no question raised");
    ok("and is given NO payload, so it cannot be pushed", !r?.payload);
    ok("the plan counts it as needing an answer", plan.needsAnswer >= 1, String(plan.needsAnswer));
  }

  H("AN AMOUNT THAT MATCHES NOTHING");
  {
    // Deliberately unlike any open bill. Forcing it onto one would clear a bill
    // that was never paid; On Account is the honest answer.
    const odd = 7.77;
    const plan = planFromBankRows(
      [row({ amount: odd, description: `NEFT CR ${owing.party}` })], masters, bills, BANK,
    );
    const r = plan.rows[0];
    /* A part payment is NORMAL here — the owner's own rule, and 1,086 of this
       company's real allocations are Agst Ref against 32 On Account. So a ₹7.77
       receipt against a ₹438 bill SHOULD allocate ₹7.77 to it and leave the
       bill open for the rest. My first version of this asserted the opposite
       and was simply wrong about the business.

       The real invariant is about what Tally accepts: allocations must sum to
       the PARTY LINE, not to the bill. A set that sums to anything else is
       rejected, or silently rewritten. */
    ok("a part payment allocates against the bill rather than being forced aside",
      (r?.settles.length ?? 0) === 1,
      `settles ${r?.settles.length ?? 0}, on account ₹${r?.onAccount ?? 0}`);

    const pl = r?.payload?.ledgerEntries.find((e) => e.isPartyLedger);
    const allocated = (pl?.billAllocations ?? []).reduce((t, a) => t + a.amount, 0);
    ok("the allocations sum to the voucher, which is what Tally requires",
      Math.abs(allocated - (pl?.amount ?? 0)) < 0.01,
      `allocated ₹${allocated.toFixed(2)} vs party line ₹${(pl?.amount ?? 0).toFixed(2)}`);
    ok("it does NOT claim to clear the whole bill",
      allocated < owing.outstanding,
      `₹${allocated.toFixed(2)} of ₹${owing.outstanding.toFixed(2)}`);

    if (r?.payload) {
      const g = guardVoucher(r.payload, masters);
      ok("it still produces a guardable voucher", g.ok, g.errors.join(" | ").slice(0, 140));
    }
  }

  H("TOTALS");
  {
    const plan = planFromBankRows(
      [row({ amount: 500 }), row({ amount: -300 }), row({ amount: 200 })], masters, bills, BANK,
    );
    ok("money in and money out are counted separately",
      plan.totalIn === 700 && plan.totalOut === 300,
      `in ₹${plan.totalIn}, out ₹${plan.totalOut}`);
    ok("every row is accounted for", plan.rows.length === 3, String(plan.rows.length));
  }

  console.log(`\n\x1b[1m${passed} passed · ${failed} failed\x1b[0m`);
  if (failed) console.log(`\nfailed:\n${failures.map((f) => `  · ${f}`).join("\n")}`);
  console.log("\nNothing was pushed — this harness is read-only.\n");
  process.exit(failed ? 1 : 0);
})();
