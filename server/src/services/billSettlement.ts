/**
 * Bill-wise settlement — reading what's outstanding, and deciding what a payment
 * clears.
 *
 * The rules encoded here are the owner's, confirmed 2026-09-10, and they match
 * what the books already do:
 *   · FIFO — the oldest bill clears first, then the next.
 *   · One payment is one voucher. Several payments make several vouchers.
 *   · An amount that matches no bill cleanly is left On Account. That is the
 *     correct outcome, not a failure.
 *   · Part payments are deliberate and normal (188 of 826 bills in the live data
 *     were settled across more than one voucher; one took five).
 *
 * Sign convention, straight from Tally: a debtor's open bill carries a NEGATIVE
 * closing balance (they owe us), a creditor's a POSITIVE one (we owe them).
 */
import { tallyPost } from "../tally.js";

export interface OpenBill {
  /** The bill reference — for our own sales this is the invoice number. */
  name: string;
  party: string;
  /** YYYYMMDD, as Tally stores it. */
  date: string;
  /** Signed as Tally holds it: negative = receivable, positive = payable. */
  closing: number;
  /** Outstanding magnitude, always positive. */
  outstanding: number;
  creditPeriod: string;
}

export interface Allocation { name: string; amount: number; billType: "Agst Ref" | "On Account"; }
export interface SettlementPlan {
  allocations: Allocation[];
  /** Amount that could not be matched to any open bill. */
  onAccount: number;
  /** True when the whole amount landed on specific bills. */
  fullyMatched: boolean;
  /** Bills this payment closes completely (useful for reporting). */
  billsClosed: string[];
}

const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unesc = (s: string) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const fld = (b: string, t: string) => {
  const m = new RegExp(`<${t}[^>]*>([^<]*)</${t}>`).exec(b);
  return m ? unesc(m[1].trim()) : "";
};
const lead = (s: string) => { const m = /^\s*(-?[\d.]+)/.exec(s.replace(/,/g, "")); return m ? parseFloat(m[1]) : 0; };
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Read every open bill reference from Tally. */
export async function loadOpenBills(tallyUrl: string, company: string): Promise<OpenBill[]> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkBills</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${escXml(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkBills" ISMODIFY="No"><TYPE>Bills</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>Parent</NATIVEMETHOD>
<NATIVEMETHOD>BillDate</NATIVEMETHOD><NATIVEMETHOD>ClosingBalance</NATIVEMETHOD>
<NATIVEMETHOD>BillCreditPeriod</NATIVEMETHOD>
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;

  const resp: string = await tallyPost(tallyUrl, xml, 180_000, true);
  const bills: OpenBill[] = [];
  for (const m of resp.matchAll(/<BILL\b[^>]*>[\s\S]*?<\/BILL>/g)) {
    const b = m[0];
    const name = fld(b, "NAME");
    const party = fld(b, "PARENT");
    const closing = lead(fld(b, "CLOSINGBALANCE"));
    if (!name || !party || Math.abs(closing) < 0.01) continue;
    // The first node is a running aggregate rather than a bill; anything of that
    // magnitude is not a real outstanding invoice for this business.
    if (Math.abs(closing) >= 5_000_000) continue;
    bills.push({
      name, party, date: fld(b, "BILLDATE"), closing,
      outstanding: Math.abs(closing),
      creditPeriod: fld(b, "BILLCREDITPERIOD"),
    });
  }
  return bills;
}

export const receivableBills = (bills: OpenBill[]) => bills.filter(b => b.closing < 0);
export const payableBills = (bills: OpenBill[]) => bills.filter(b => b.closing > 0);

export function billsForParty(bills: OpenBill[], party: string): OpenBill[] {
  return bills
    .filter(b => b.party === party)
    // FIFO: oldest first. Ties broken by reference so the order is deterministic.
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

/**
 * Decide what an incoming amount clears, oldest bill first.
 *
 * Anything left over once every open bill is covered goes On Account rather than
 * being forced onto a bill — matching how the books already handle it, and the
 * only safe outcome for a small unexplained credit (₹2 and ₹5 test transfers are
 * a real occurrence here).
 */
export function allocateFIFO(openBills: OpenBill[], amount: number): SettlementPlan {
  const allocations: Allocation[] = [];
  const billsClosed: string[] = [];
  let remaining = r2(Math.abs(amount));

  for (const bill of openBills) {
    if (remaining <= 0.009) break;
    const take = r2(Math.min(bill.outstanding, remaining));
    if (take <= 0.009) continue;
    allocations.push({ name: bill.name, amount: take, billType: "Agst Ref" });
    if (Math.abs(take - bill.outstanding) < 0.01) billsClosed.push(bill.name);
    remaining = r2(remaining - take);
  }

  const onAccount = remaining > 0.009 ? remaining : 0;
  if (onAccount > 0) allocations.push({ name: "", amount: onAccount, billType: "On Account" });

  return { allocations, onAccount, fullyMatched: onAccount === 0 && allocations.length > 0, billsClosed };
}

/** Total outstanding for a party, as a positive magnitude. */
export function partyOutstanding(bills: OpenBill[], party: string): number {
  return r2(billsForParty(bills, party).reduce((s, b) => s + b.outstanding, 0));
}

/** Days overdue for a bill, given its credit period ("20 Days") and today. */
export function daysOverdue(bill: OpenBill, today = new Date()): number | null {
  if (!/^\d{8}$/.test(bill.date)) return null;
  const y = +bill.date.slice(0, 4), mo = +bill.date.slice(4, 6), d = +bill.date.slice(6, 8);
  const credit = parseInt(/(\d+)/.exec(bill.creditPeriod)?.[1] ?? "0", 10);
  const due = new Date(y, mo - 1, d + credit);
  return Math.floor((today.getTime() - due.getTime()) / 86_400_000);
}
