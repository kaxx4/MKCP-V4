/**
 * Receipts — the highest-volume money voucher, and the one nothing verified.
 *
 * `case-money.ts` is titled "Payments and receipts" and every one of its four
 * variants pushes a Payment. So the direction that BRINGS MONEY IN had no
 * coverage at all: not the side the party line takes, not `Agst Ref` against a
 * debtor's bill, and not the bank instrument block.
 *
 *   A  against a bill       the allocation that decides whether a receipt
 *                           clears the right invoice or floats unallocated
 *   B  with an INSTRUMENT   BANKALLOCATIONS.LIST — cheque number, transaction
 *                           type, favouring. Its only producer is the web
 *                           app's `chequeVoucher.ts` and the only thing that
 *                           ever looked at it was safePush's diff; nothing had
 *                           confirmed Tally STORES it. Omitting it makes Tally
 *                           prompt for allocation, which hangs an unattended
 *                           push — so "does it land" is load-bearing.
 *   C  on account           a receipt with no allocation must not acquire one
 *
 *   npx tsx scripts/fidelity/case-receipt.ts
 */
import { tallyPost } from "../../src/tally.js";
import { pushVoucherToTally } from "../../src/services/voucherPusher.js";
import { loadMasters } from "../../src/services/tallyMasters.js";
import type { VoucherPayload } from "../../src/types.js";
import {
  U, MARK, company, allFieldsXml, vouchersOnDayXml, objects, fld, block, blocks,
  check, checkNum, report, remember,
} from "./harness.js";

const TODAY = new Date().toISOString().slice(0, 10);
const stamp = Date.now().toString().slice(-5);

/** A real open bill on a DEBTOR — what a receipt actually settles. */
async function debtorBill(co: string): Promise<{ party: string; name: string; amount: number } | null> {
  const dump = (await tallyPost(U, allFieldsXml(co, "Ledger"), 180_000, true)) as string;
  for (const l of objects(dump, "LEDGER")) {
    if (!/Sundry Debtors/i.test(fld(l.body, "PARENT"))) continue;
    for (const b of blocks(l.body, "BILLALLOCATIONS\\.LIST")) {
      const name = fld(b, "NAME");
      const amt = parseFloat(fld(b, "OPENINGBALANCE") || "0");
      if (name && amt) return { party: l.name, name, amount: Math.abs(amt) };
    }
  }
  return null;
}

async function pushAndRead(
  co: string,
  masters: Awaited<ReturnType<typeof loadMasters>>,
  p: VoucherPayload,
  label: string,
) {
  const res = await pushVoucherToTally(U, co, p, masters);
  remember({ remoteId: p.remoteId!, voucherType: "Receipt", number: p.voucherNumber!, date: p.date, narration: p.narration });
  const vs = objects((await tallyPost(U, vouchersOnDayXml(co, p.date), 180_000, true)) as string, "VOUCHER");
  const stored = vs.find((v) => fld(v.body, "NARRATION") === p.narration);
  console.log(`\n   [${label}] created=${res.created} errors=${res.errors}` +
    (res.lineErrors?.length ? `  ${res.lineErrors.join(" | ")}` : ""));
  return { res, stored };
}

(async () => {
  const co = await company();
  const masters = await loadMasters(U, co);
  const bill = await debtorBill(co);
  if (!bill) { console.log("  no open debtor bill to aim a receipt at"); return; }

  const bank = [...masters.ledgers.values()].find((l) => /bank/i.test(l.parent))?.name;
  const cash = [...masters.ledgers.values()].find((l) => /^CASH$/i.test(l.name))?.name ?? "Cash";
  const GET = Math.min(500, Math.round(bill.amount / 2));

  console.log(`\ncompany   ${co}`);
  console.log(`party     ${bill.party}`);
  console.log(`open bill ${bill.name}  (${bill.amount})`);
  console.log(`receiving ${GET} into ${bank ?? cash}\n`);

  const results: { title: string; checks: ReturnType<typeof check>[] }[] = [];

  /* A receipt DEBITS the bank/cash and CREDITS the party: money comes in, and
     what they owe goes down. The reverse still balances, which is exactly why
     the side has to be read back from the books rather than inferred from a
     successful response. */
  const base = (n: string, narr: string, into: string): VoucherPayload => ({
    remoteId: `MKCP-RECEIPT-${n}`, voucherType: "Receipt", date: TODAY, voucherNumber: n,
    narration: narr, partyLedgerName: bill.party, isInvoice: false,
    ledgerEntries: [
      { ledgerName: into, amount: GET, isDeemedPositive: true, isPartyLedger: false },
      { ledgerName: bill.party, amount: GET, isDeemedPositive: false, isPartyLedger: true },
    ],
  } as unknown as VoucherPayload);

  // A — against the bill
  {
    const n = `${MARK}/RA${stamp}`;
    const narr = `${MARK} receipt agst ${stamp}`;
    const p = base(n, narr, cash);
    (p.ledgerEntries[1] as unknown as { billAllocations: unknown[] }).billAllocations =
      [{ name: bill.name, billType: "Agst Ref", amount: GET }];
    const { res, stored } = await pushAndRead(co, masters, p, "A agst ref");
    const ba = stored ? block(stored.body, "BILLALLOCATIONS\\.LIST") : "";
    const partyLine = stored
      ? blocks(stored.body, "ALLLEDGERENTRIES\\.LIST").find((b) => fld(b, "LEDGERNAME") === bill.party) ?? ""
      : "";
    results.push({ title: "A — receipt against a debtor's open bill", checks: [
      check("created", "1", String(res.created)),
      check("landed", "yes", stored ? "yes" : ""),
      check("settles the bill named", bill.name, stored ? fld(ba, "NAME") : null),
      check("as Agst Ref, not a new debt", "Agst Ref", stored ? fld(ba, "BILLTYPE") : null,
        { note: "a New Ref here opens a fresh receivable instead of clearing one" }),
      check("the party is CREDITED", "No", partyLine ? fld(partyLine, "ISDEEMEDPOSITIVE") : null,
        { note: "money in reduces what they owe; a debit would increase it and still balance" }),
      checkNum("for the amount received", GET, partyLine ? fld(partyLine, "AMOUNT") : null),
    ]});
  }

  // B — with a bank instrument
  if (bank) {
    const n = `${MARK}/RB${stamp}`;
    const narr = `${MARK} receipt bank ${stamp}`;
    const CHQ = `9${stamp}`;
    const p = base(n, narr, bank);
    (p.ledgerEntries[0] as unknown as { bankAllocation: unknown }).bankAllocation = {
      transactionType: "Cheque", transferMode: "Cheque", instrumentNumber: CHQ,
      favouring: bill.party, instrumentDate: TODAY,
    };
    const { res, stored } = await pushAndRead(co, masters, p, "B bank instrument");
    const bk = stored ? block(stored.body, "BANKALLOCATIONS\\.LIST") : "";
    results.push({ title: "B — receipt carrying a cheque: the instrument block", checks: [
      check("created", "1", String(res.created)),
      check("the instrument block exists", "yes", stored ? (bk ? "yes" : "") : null,
        { note: "never confirmed before; without it Tally prompts for allocation and an unattended push hangs" }),
      check("cheque number", CHQ, bk ? fld(bk, "INSTRUMENTNUMBER") : null),
      check("transaction type", "Cheque", bk ? fld(bk, "TRANSACTIONTYPE") : null),
      check("favouring", bill.party, bk ? fld(bk, "PAYMENTFAVOURING") : null),
      /* NEGATIVE, because the bank line is a DEBIT and Tally stores a debit as
         a negative amount — the instrument block carries the same signed value
         as the ledger line it belongs to. Asserting +500 here reported a
         correct voucher as wrong; the sign is the convention, not an error. */
      checkNum("instrument amount, signed as a debit", -GET, bk ? fld(bk, "AMOUNT") : null),
    ]});
  } else {
    console.log("  (no bank ledger in this company — the instrument case cannot run)");
  }

  // C — on account
  {
    const n = `${MARK}/RC${stamp}`;
    const narr = `${MARK} receipt onacct ${stamp}`;
    const { res, stored } = await pushAndRead(co, masters, base(n, narr, cash), "C on account");
    const ba = stored ? block(stored.body, "BILLALLOCATIONS\\.LIST") : "";
    results.push({ title: "C — receipt on account, no allocation intended", checks: [
      check("created", "1", String(res.created)),
      check("no bill was named", "", stored ? fld(ba, "NAME") : null,
        { note: "an allocation appearing here would be one nobody asked for" }),
      check("recorded as On Account", "On Account", stored ? fld(ba, "BILLTYPE") : null),
    ]});
  }

  let failed = false;
  for (const r of results) if (report(r.title, r.checks).failed) failed = true;
  console.log(`\n   sweep with scripts/fidelity/sweep.ts --delete\n`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
