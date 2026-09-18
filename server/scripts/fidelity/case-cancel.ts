/**
 * ACTION="Cancel" — the contract's fourth verb, never verified.
 *
 * `types.ts` carries the strongest warning in this codebase about cancelling:
 * the ISCANCELLED *flag* on an Alter returns `altered=1` and is silently
 * discarded, leaving the voucher live. The stated remedy is the ACTION. But
 * the remedy itself had no coverage — not in any fidelity case — so "cancel
 * works" rested on a probe script and an assumption carried forward.
 *
 * It matters more than delete. A cancelled voucher KEEPS its number, which is
 * what an auditor expects of a voided document; a deleted one frees the number
 * for reuse and leaves a hole in the series.
 *
 * Three things have to be true, and only the first is visible in the response:
 *
 *   1. Tally accepts it
 *   2. the voucher is still THERE, holding its number
 *   3. it is marked cancelled, and carries no money
 *
 * This also re-tests the flag-on-Alter trap in the same run, so the day Tally
 * changes its mind about either, this says which one moved.
 *
 *   npx tsx scripts/fidelity/case-cancel.ts
 */
import { tallyPost } from "../../src/tally.js";
import { pushVoucherToTally } from "../../src/services/voucherPusher.js";
import { loadMasters } from "../../src/services/tallyMasters.js";
import type { VoucherPayload } from "../../src/types.js";
import {
  U, MARK, company, vouchersOnDayXml, objects, fld, blocks,
  check, report, remember,
} from "./harness.js";

const TODAY = new Date().toISOString().slice(0, 10);
const stamp = Date.now().toString().slice(-5);

async function read(co: string, narration: string) {
  const vs = objects((await tallyPost(U, vouchersOnDayXml(co, TODAY), 180_000, true)) as string, "VOUCHER");
  return vs.find((v) => fld(v.body, "NARRATION") === narration);
}

(async () => {
  const co = await company();
  const masters = await loadMasters(U, co);
  const party = [...masters.ledgers.values()].find((l) => /Sundry Creditors/i.test(l.parent))!;
  const cash = [...masters.ledgers.values()].find((l) => /^CASH$/i.test(l.name))?.name ?? "Cash";

  console.log(`\ncompany  ${co}`);
  console.log(`party    ${party.name}\n`);

  const mk = (n: string, narr: string): VoucherPayload => ({
    remoteId: `MKCP-PAYMENT-${n}`, voucherType: "Payment", date: TODAY, voucherNumber: n,
    narration: narr, partyLedgerName: party.name, isInvoice: false,
    ledgerEntries: [
      { ledgerName: party.name, amount: 60, isDeemedPositive: true, isPartyLedger: true },
      { ledgerName: cash, amount: 60, isDeemedPositive: false, isPartyLedger: false },
    ],
  } as unknown as VoucherPayload);

  const results: { title: string; checks: ReturnType<typeof check>[] }[] = [];

  // ── The ACTION ────────────────────────────────────────────────────────────
  {
    const n = `${MARK}/CN${stamp}`;
    const narr = `${MARK} cancel action ${stamp}`;
    const p = mk(n, narr);
    remember({ remoteId: p.remoteId!, voucherType: "Payment", number: n, date: TODAY, narration: narr });
    const made = await pushVoucherToTally(U, co, p, masters);

    const res = await pushVoucherToTally(U, co, { ...p, action: "Cancel" } as VoucherPayload, masters);
    const after = await read(co, narr);
    const money = after
      ? blocks(after.body, "ALLLEDGERENTRIES\\.LIST")
          .reduce((t, b) => t + Math.abs(parseFloat(fld(b, "AMOUNT") || "0")), 0)
      : -1;

    console.log(`   cancel: created=${res.created} altered=${res.altered} errors=${res.errors}`);
    results.push({ title: 'ACTION="Cancel" on a Payment', checks: [
      check("the voucher was created first", "1", String(made.created)),
      check("Tally accepted the cancel", "yes", res.errors === 0 ? "yes" : ""),
      check("the voucher is STILL THERE", "yes", after ? "yes" : "",
        { note: "a cancel voids a voucher; it does not remove it — the number stays spoken for" }),
      check("it kept its number", n, after ? fld(after.body, "VOUCHERNUMBER") : null),
      check("marked cancelled", "Yes", after ? fld(after.body, "ISCANCELLED") : null),
      check("and carries no money", "0", after ? String(money) : null,
        { note: "a voucher that reads cancelled but still holds amounts would keep affecting the books" }),
    ]});
  }

  // ── The trap: the FLAG on an Alter ────────────────────────────────────────
  {
    const n = `${MARK}/CF${stamp}`;
    const narr = `${MARK} cancel flag ${stamp}`;
    const p = mk(n, narr);
    remember({ remoteId: p.remoteId!, voucherType: "Payment", number: n, date: TODAY, narration: narr });
    await pushVoucherToTally(U, co, p, masters);

    /* The shape the contract warns about: Alter carrying ISCANCELLED=Yes.
       Asserted as the REFUSAL it is — Tally reports altered=1 and keeps the
       voucher live — so this turns red only if that behaviour changes. */
    const res = await pushVoucherToTally(
      U, co, { ...p, action: "Alter", isCancelled: true } as unknown as VoucherPayload, masters,
    );
    const after = await read(co, narr);
    console.log(`   flag:   created=${res.created} altered=${res.altered} errors=${res.errors}`);
    results.push({ title: "the ISCANCELLED flag on an Alter is silently discarded", checks: [
      check("Tally reports success", "altered", res.altered > 0 ? "altered" : "something else"),
      /* "No", not empty: Tally writes the flag explicitly rather than omitting
         it, so the voucher states that it is live. */
      check("but the voucher is NOT cancelled", "No", after ? fld(after.body, "ISCANCELLED") : null,
        { note: "this is why ACTION=Cancel exists; the flag reads as success and changes nothing" }),
    ]});
  }

  let failed = false;
  for (const r of results) if (report(r.title, r.checks).failed) failed = true;
  console.log(`\n   sweep with scripts/fidelity/sweep.ts --delete\n`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
