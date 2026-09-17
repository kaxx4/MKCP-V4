/**
 * Payments and receipts: does the money land where it was aimed?
 *
 * The owner's report: "the payment receipt entries are giving errors… on
 * account, off account, whatever." Four variants, each isolating one thing:
 *
 *   A  against a bill    Agst Ref against a real open bill. The one that
 *                        decides whether a payment reduces the right debt or
 *                        floats as an unallocated credit.
 *   B  on account        No allocation at all. Legitimate, and it must NOT
 *                        quietly acquire one.
 *   C  no number         Payment is "Automatic (Manual Override)" in this
 *                        company, so omitting the number should have Tally
 *                        assign one. This is the recovery committed in
 *                        751438c, which had never been run against Tally.
 *   D  another party's   The documented silent rewrite: a bill reference
 *      bill             belonging to someone else is accepted, turned into a
 *                        New Ref, and reported as success — creating a
 *                        liability nobody asked for.
 *
 *   npx tsx scripts/fidelity/case-money.ts
 */
import { tallyPost } from "../../src/tally.js";
import { pushVoucherToTally } from "../../src/services/voucherPusher.js";
import { loadMasters } from "../../src/services/tallyMasters.js";
import type { VoucherPayload } from "../../src/types.js";
import {
  U, MARK, company, allFieldsXml, vouchersOnDayXml, objects, fld, flds, block, blocks,
  check, checkNum, report,
} from "./harness.js";

const TODAY = new Date().toISOString().slice(0, 10);
const stamp = Date.now().toString().slice(-5);

interface OpenBill { party: string; name: string; amount: number }

/** Real open bills, read from the party masters rather than invented. */
async function openBills(co: string): Promise<OpenBill[]> {
  const dump = (await tallyPost(U, allFieldsXml(co, "Ledger"), 180_000, true)) as string;
  const out: OpenBill[] = [];
  for (const l of objects(dump, "LEDGER")) {
    if (!/Sundry Creditors/i.test(fld(l.body, "PARENT"))) continue;
    for (const b of blocks(l.body, "BILLALLOCATIONS\\.LIST")) {
      const name = fld(b, "NAME");
      const amt = parseFloat(fld(b, "OPENINGBALANCE") || "0");
      if (name && amt) out.push({ party: l.name, name, amount: Math.abs(amt) });
    }
  }
  return out;
}

async function pushAndRead(
  co: string, masters: Awaited<ReturnType<typeof loadMasters>>,
  payload: VoucherPayload, label: string,
): Promise<{ res: Awaited<ReturnType<typeof pushVoucherToTally>>; stored?: { name: string; body: string } }> {
  const res = await pushVoucherToTally(U, co, payload, masters);
  const vs = objects((await tallyPost(U, vouchersOnDayXml(co, payload.date), 180_000, true)) as string, "VOUCHER");
  const stored = vs.find((v) => fld(v.body, "NARRATION") === payload.narration);
  console.log(`\n   [${label}] created=${res.created} altered=${res.altered} errors=${res.errors}` +
    (res.lineErrors?.length ? `  lineErrors: ${res.lineErrors.join(" | ")}` : ""));
  return { res, stored };
}

async function main(): Promise<void> {
  const co = await company();
  const masters = await loadMasters(U, co);
  const bills = await openBills(co);
  if (bills.length < 2) { console.log("no open bills to aim at"); return; }

  const mine = bills[0];
  const other = bills.find((b) => b.party !== mine.party)!;
  const cash = [...masters.ledgers.values()].find((l) => /^CASH$/i.test(l.name))?.name ?? "Cash";
  const PAY = Math.min(1000, Math.round(mine.amount / 2));

  console.log(`\ncompany   ${co}`);
  console.log(`party     ${mine.party}`);
  console.log(`open bill ${mine.name}  (₹${mine.amount})`);
  console.log(`paying    ₹${PAY} from ${cash}`);
  console.log(`other     ${other.party} bill ${other.name}  ← for the cross-party trap\n`);

  const base = (n: string, narration: string): VoucherPayload => ({
    remoteId: `MKCP-PAYMENT-${n}`,
    voucherType: "Payment",
    date: TODAY,
    voucherNumber: n,
    narration,
    partyLedgerName: mine.party,
    isInvoice: false,
    ledgerEntries: [],
  } as unknown as VoucherPayload);

  const all: { title: string; checks: ReturnType<typeof check>[] }[] = [];

  // ── A: against a real bill ────────────────────────────────────────────────
  {
    const n = `${MARK}/A${stamp}`;
    const p = base(n, `${MARK} A agst ref`);
    p.ledgerEntries = [
      { ledgerName: mine.party, amount: PAY, isDeemedPositive: true, isPartyLedger: true,
        billAllocations: [{ name: mine.name, billType: "Agst Ref", amount: PAY }] },
      { ledgerName: cash, amount: PAY, isDeemedPositive: false, isPartyLedger: false },
    ] as never;
    const { stored } = await pushAndRead(co, masters, p, "A against a bill");
    const ba = stored ? block(stored.body, "BILLALLOCATIONS\\.LIST") : "";
    all.push({ title: "A — payment against an open bill", checks: [
      check("landed", "yes", stored ? "yes" : ""),
      check("party", mine.party, stored ? fld(stored.body, "PARTYLEDGERNAME") : null),
      check("bill name", mine.name, stored ? fld(ba, "NAME") : null),
      check("bill type", "Agst Ref", stored ? fld(ba, "BILLTYPE") : null,
        { note: "New Ref here would mean it did NOT settle the bill — it opened another" }),
      checkNum("bill amount", PAY, stored ? fld(ba, "AMOUNT").replace("-", "") : null),
      check("cash ledger on the voucher", "yes",
        stored ? (flds(stored.body, "LEDGERNAME").includes(cash) ? "yes" : "") : null),
    ]});
  }

  // ── B: on account ─────────────────────────────────────────────────────────
  {
    const n = `${MARK}/B${stamp}`;
    const p = base(n, `${MARK} B on account`);
    p.ledgerEntries = [
      { ledgerName: mine.party, amount: PAY, isDeemedPositive: true, isPartyLedger: true },
      { ledgerName: cash, amount: PAY, isDeemedPositive: false, isPartyLedger: false },
    ] as never;
    const { stored } = await pushAndRead(co, masters, p, "B on account");
    const ba = stored ? block(stored.body, "BILLALLOCATIONS\\.LIST") : "";
    all.push({ title: "B — on account, no allocation intended", checks: [
      check("landed", "yes", stored ? "yes" : ""),
      check("no bill allocation", "", stored ? fld(ba, "NAME") : null,
        { note: "an allocation appearing here would be one nobody asked for" }),
      check("bill type if any", "", stored ? fld(ba, "BILLTYPE") : null),
    ]});
  }

  // ── C: no voucher number — Tally must assign one ──────────────────────────
  {
    const p = base("", `${MARK} C no number`);
    delete (p as { voucherNumber?: string }).voucherNumber;
    p.remoteId = `MKCP-PAYMENT-${MARK}-C${stamp}`;
    p.ledgerEntries = [
      { ledgerName: mine.party, amount: PAY, isDeemedPositive: true, isPartyLedger: true },
      { ledgerName: cash, amount: PAY, isDeemedPositive: false, isPartyLedger: false },
    ] as never;
    const { stored } = await pushAndRead(co, masters, p, "C no number");
    const assigned = stored ? fld(stored.body, "VOUCHERNUMBER") : "";
    all.push({ title: "C — no number sent, Tally numbers it (Automatic Manual Override)", checks: [
      check("landed", "yes", stored ? "yes" : ""),
      check("Tally assigned a number", "yes", stored ? (assigned ? "yes" : "") : null,
        { note: assigned ? `it chose "${assigned}"` : "blank number — this type is NOT auto-numbered" }),
    ]});
  }

  // ── D: another party's bill reference ─────────────────────────────────────
  {
    const n = `${MARK}/D${stamp}`;
    const p = base(n, `${MARK} D cross party`);
    p.ledgerEntries = [
      { ledgerName: mine.party, amount: PAY, isDeemedPositive: true, isPartyLedger: true,
        billAllocations: [{ name: other.name, billType: "Agst Ref", amount: PAY }] },
      { ledgerName: cash, amount: PAY, isDeemedPositive: false, isPartyLedger: false },
    ] as never;
    const { res, stored } = await pushAndRead(co, masters, p, "D cross-party bill ref");
    const ba = stored ? block(stored.body, "BILLALLOCATIONS\\.LIST") : "";
    const type = stored ? fld(ba, "BILLTYPE") : "";
    all.push({ title: `D — citing ${other.party}'s bill "${other.name}" on a payment to ${mine.party}`, checks: [
      check("Tally reported success", "yes", res.created > 0 ? "yes" : ""),
      check("bill type stored", "Agst Ref", stored ? type : null,
        { note: type === "New Ref"
          ? "REWRITTEN to New Ref — accepted, reported as success, and it has opened a NEW liability"
          : "stayed as sent" }),
    ]});
  }

  let failed = 0;
  for (const a of all) failed += report(a.title, a.checks).failed;
  console.log(`\n   run scripts/fidelity/sweep.ts --delete to clear these\n`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
