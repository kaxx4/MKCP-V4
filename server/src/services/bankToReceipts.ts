/**
 * Bank rows → receipts and payments.
 *
 * The cleanest of the automation cases, because the fields line up exactly: a
 * statement row gives amount, date, UTR and a narration containing the payer —
 * and Tally's `INSTRUMENTNUMBER` is precisely that UTR, on 1,275 of this
 * company's existing vouchers.
 *
 * Two owner rules shape everything here:
 *   · Bank statements carry PAYMENTS ONLY. Cash is entered by hand, so a row
 *     that cannot be a bank movement is not silently turned into one.
 *   · Settlement is FIFO, and an amount matching nothing is left On Account.
 */
import type { ExtractedBankRow } from "./extraction.js";
import { resolvePayerFromNarration, REVIEW_THRESHOLD } from "./extraction.js";
import type { TallyMasters } from "./tallyMasters.js";
import { loadOpenBills, billsForParty, allocateFIFO, receivableBills, payableBills, type OpenBill } from "./billSettlement.js";
import { safePush } from "./safePush.js";
import type { VoucherPayload } from "../types.js";

export interface BankPlanRow {
  source: ExtractedBankRow;
  kind: "receipt" | "payment";
  party?: string;
  settles: Array<{ name: string; amount: number }>;
  onAccount: number;
  payload?: VoucherPayload;
  /** Present when a human must decide before this can be booked. */
  question?: { reason: string; candidates: string[] };
}

export interface BankPlan {
  rows: BankPlanRow[];
  ready: number;
  needsAnswer: number;
  totalIn: number;
  totalOut: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Turn statement rows into a reviewable plan. Nothing is sent here — this is
 * what a person looks at before anything reaches the books.
 */
export function planFromBankRows(
  rows: ExtractedBankRow[],
  masters: TallyMasters,
  openBills: OpenBill[],
  bankLedger: string,
  learnedPayers?: Map<string, string>
): BankPlan {
  const out: BankPlanRow[] = [];
  // Bills consumed earlier in this batch must not be offered again.
  const working: OpenBill[] = openBills.map(b => ({ ...b }));

  for (const [i, row] of rows.entries()) {
    const kind: "receipt" | "payment" = row.amount >= 0 ? "receipt" : "payment";
    const amount = r2(Math.abs(row.amount));

    if (row.confidence < REVIEW_THRESHOLD) {
      out.push({ source: row, kind, settles: [], onAccount: 0,
        question: { reason: `Row read with low confidence (${(row.confidence * 100).toFixed(0)}%).`, candidates: [] } });
      continue;
    }
    if (amount < 0.01) {
      out.push({ source: row, kind, settles: [], onAccount: 0,
        question: { reason: "Row has no amount.", candidates: [] } });
      continue;
    }

    const who = resolvePayerFromNarration(row.description, masters.ledgers.keys(), learnedPayers);
    if (who.status !== "resolved") {
      out.push({ source: row, kind, settles: [], onAccount: 0,
        question: { reason: who.reason, candidates: who.candidates } });
      continue;
    }
    const party = who.value;

    const pool = billsForParty(kind === "receipt" ? receivableBills(working) : payableBills(working), party);
    const plan = allocateFIFO(pool, amount);
    const settles = plan.allocations.filter(a => a.billType === "Agst Ref").map(a => ({ name: a.name, amount: a.amount }));

    // Tally requires allocations to sum EXACTLY to the party line, so a part-
    // matched amount is sent with no allocations and sits on account instead.
    const useAllocations = settles.length > 0 && plan.onAccount === 0;

    const partyLine = {
      ledgerName: party, amount,
      isDeemedPositive: kind === "payment",
      isPartyLedger: true,
      ...(useAllocations
        ? { billAllocations: settles.map(s => ({ name: s.name, billType: "Agst Ref" as const, amount: s.amount })) }
        : {}),
    };
    const bankLine = {
      ledgerName: bankLedger, amount,
      isDeemedPositive: kind === "receipt",
      isPartyLedger: false,
      bankAllocation: {
        transactionType: "Cheque/DD",
        transferMode: "NEFT",
        instrumentNumber: row.reference ?? "",
        favouring: party,
        instrumentDate: row.date,
      },
    };

    // Number from the UTR, not a running index. A bank transaction has exactly
    // one UTR, so re-importing the same statement produces the same voucher
    // number and Tally refuses it — which is the idempotency we want, for free.
    // An index-based number instead looks new every run and silently duplicates
    // real money, or (as here) gets rejected with no reason given.
    const ref = (row.reference ?? "").trim();
    const prefix = kind === "receipt" ? "R" : "P";
    const payload: VoucherPayload = {
      voucherType: kind === "receipt" ? "Receipt" : "Payment",
      date: row.date,
      voucherNumber: ref
        ? `BANK/${prefix}/${ref}`
        : `BANK/${prefix}/${row.date.replace(/-/g, "")}/${i + 1}`,
      narration: row.description.slice(0, 200),
      partyLedgerName: party,
      isInvoice: false,
      ledgerEntries: kind === "receipt" ? [bankLine, partyLine] : [partyLine, bankLine],
    };

    if (useAllocations) {
      for (const s of settles) {
        const b = working.find(x => x.name === s.name && x.party === party);
        if (b) b.outstanding = r2(Math.max(0, b.outstanding - s.amount));
      }
      for (let k = working.length - 1; k >= 0; k--) if (working[k].outstanding <= 0.009) working.splice(k, 1);
    }

    out.push({ source: row, kind, party, settles: useAllocations ? settles : [], onAccount: plan.onAccount, payload });
  }

  return {
    rows: out,
    ready: out.filter(r => r.payload && !r.question).length,
    needsAnswer: out.filter(r => r.question).length,
    totalIn: r2(out.filter(r => r.kind === "receipt").reduce((s, r) => s + Math.abs(r.source.amount), 0)),
    totalOut: r2(out.filter(r => r.kind === "payment").reduce((s, r) => s + Math.abs(r.source.amount), 0)),
  };
}

export interface BankPushResult {
  pushed: number;
  failed: number;
  skipped: number;
  details: Array<{ row: BankPlanRow; voucherId: string | null; errors: string[]; differences: string[] }>;
}

/** Push only the rows that need no human answer. Everything else is left alone. */
export async function pushBankPlan(
  tallyUrl: string,
  company: string,
  plan: BankPlan
): Promise<BankPushResult> {
  const details: BankPushResult["details"] = [];
  let pushed = 0, failed = 0, skipped = 0;

  for (const row of plan.rows) {
    if (!row.payload || row.question) { skipped++; continue; }
    try {
      const res = await safePush(tallyUrl, company, row.payload);
      if (res.ok) pushed++; else failed++;
      details.push({ row, voucherId: res.voucherId, errors: res.errors, differences: res.differences });
    } catch (e) {
      failed++;
      details.push({ row, voucherId: null, errors: [`Transport failure: ${(e as Error).message}`], differences: [] });
      break;   // Tally may now be blocked; do not hammer it.
    }
  }
  return { pushed, failed, skipped, details };
}

/** Convenience: read the bills, build the plan, in one call. */
export async function planBankRows(
  tallyUrl: string,
  company: string,
  rows: ExtractedBankRow[],
  masters: TallyMasters,
  bankLedger = "HDFC BANK",
  learnedPayers?: Map<string, string>
): Promise<BankPlan> {
  const bills = await loadOpenBills(tallyUrl, company);
  return planFromBankRows(rows, masters, bills, bankLedger, learnedPayers);
}
