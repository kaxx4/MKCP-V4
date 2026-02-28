import type { CanonicalVoucher, CanonicalLedger } from "../types/canonical";

export interface InvoiceRecord {
  voucherId: string;
  voucherNumber: string;
  date: string;
  partyName: string;
  partyLedgerId: string;
  totalAmount: number;
  paidAmount: number;
  outstanding: number;
  dueDate: string | null;
  daysPastDue: number;
  type: "receivable" | "payable";
  agingBucket: "current" | "1-30" | "31-60" | "61-90" | "90+";
}

const DEBTOR_GROUPS = ["sundry debtors", "debtors", "trade receivables"];
const CREDITOR_GROUPS = ["sundry creditors", "creditors", "trade payables"];

export function isDebtorLedger(ledger: CanonicalLedger): boolean {
  return DEBTOR_GROUPS.some((g) => ledger.group.toLowerCase().includes(g));
}

export function isCreditorLedger(ledger: CanonicalLedger): boolean {
  return CREDITOR_GROUPS.some((g) => ledger.group.toLowerCase().includes(g));
}

export function isBankLedger(ledger: CanonicalLedger): boolean {
  return ledger.group.toLowerCase().includes("bank");
}

export function isCashLedger(ledger: CanonicalLedger): boolean {
  return ledger.group.toLowerCase().includes("cash");
}

/** Compute outstanding for all sales/purchase invoices */
export function computeOutstandingInvoices(
  vouchers: CanonicalVoucher[],
  ledgers: Map<string, CanonicalLedger>,
  defaultCreditDays: number = 30
): InvoiceRecord[] {
  const today = new Date().toISOString().slice(0, 10);

  // Build bill reference → payment amount map
  const billPayments: Record<string, number> = {};
  for (const v of vouchers) {
    if (!["Receipt", "Payment"].includes(v.voucherType)) continue;
    if (v.isCancelled) continue;
    for (const line of v.lines) {
      if (line.type !== "ledger") continue;
      for (const ba of line.billAllocations ?? []) {
        if (ba.billType === "Agst Ref") {
          billPayments[ba.billRef] = (billPayments[ba.billRef] ?? 0) + ba.amount;
        }
      }
    }
  }

  const records: InvoiceRecord[] = [];
  for (const v of vouchers) {
    if (!["Sales", "Purchase"].includes(v.voucherType)) continue;
    if (v.isCancelled || v.isOptional) continue;

    const ledger = v.partyLedgerId ? ledgers.get(v.partyLedgerId) : null;
    const type: "receivable" | "payable" = v.voucherType === "Sales" ? "receivable" : "payable";

    let dueDate: string | null = null;
    let billedAmount = v.totalAmount;
    for (const line of v.lines) {
      if (!line.isPartyLine) continue;
      for (const ba of line.billAllocations ?? []) {
        if (ba.billType === "New Ref") {
          billedAmount = ba.amount;
          dueDate = ba.dueDate ?? null;
        }
      }
    }

    const paidAmount = billPayments[v.voucherNumber] ?? 0;
    const outstanding = Math.max(billedAmount - paidAmount, 0);
    if (outstanding < 0.01) continue;

    if (!dueDate) {
      const creditDays = ledger?.creditDays ?? defaultCreditDays;
      const d = new Date(v.date);
      d.setDate(d.getDate() + creditDays);
      dueDate = d.toISOString().slice(0, 10);
    }

    const daysPastDue = Math.floor(
      (new Date(today).getTime() - new Date(dueDate).getTime()) / 86400000
    );

    records.push({
      voucherId: v.voucherId,
      voucherNumber: v.voucherNumber,
      date: v.date,
      partyName: v.partyName ?? v.partyLedgerId ?? "Unknown",
      partyLedgerId: v.partyLedgerId ?? "",
      totalAmount: billedAmount,
      paidAmount,
      outstanding,
      dueDate,
      daysPastDue,
      type,
      agingBucket: getAgingBucket(daysPastDue),
    });
  }

  return records;
}

function getAgingBucket(days: number): InvoiceRecord["agingBucket"] {
  if (days <= 0) return "current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

/** Compute cash/bank balance — single pass over vouchers */
export function computeBankBalance(
  ledgers: Map<string, CanonicalLedger>,
  vouchers: CanonicalVoucher[]
): number {
  // Collect bank/cash ledger IDs and their opening balances
  const bankCashIds = new Set<string>();
  let balance = 0;
  for (const [, ledger] of ledgers) {
    if (!isBankLedger(ledger) && !isCashLedger(ledger)) continue;
    bankCashIds.add(ledger.ledgerId);
    balance += ledger.openingBalance;
  }
  if (bankCashIds.size === 0) return balance;

  // Single pass over all vouchers
  for (const v of vouchers) {
    if (v.isCancelled) continue;
    for (const line of v.lines) {
      if (line.type !== "ledger" || !line.ledgerId || !bankCashIds.has(line.ledgerId)) continue;
      balance += line.isDebit ? (line.amount ?? 0) : -(line.amount ?? 0);
    }
  }
  return balance;
}

/** Monthly sales totals — uses the actual data range, not current date */
export function monthlyTotals(
  vouchers: CanonicalVoucher[],
  type: "Sales" | "Purchase",
  nMonths: number = 12
): Array<{ label: string; amount: number }> {
  const totals: Record<string, number> = {};
  let latestYM = "";
  for (const v of vouchers) {
    if (v.voucherType !== type || v.isCancelled || v.isOptional) continue;
    const ym = v.date.slice(0, 7);
    // Use totalAmount if available, otherwise sum inventory line amounts
    let amount = v.totalAmount;
    if (!amount) {
      amount = v.lines
        .filter((l) => l.type === "inventory")
        .reduce((s, l) => s + (l.lineAmount ?? 0), 0);
    }
    totals[ym] = (totals[ym] ?? 0) + amount;
    if (ym > latestYM) latestYM = ym;
  }

  if (!latestYM) {
    const now = new Date();
    latestYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  const [ly, lm] = latestYM.split("-").map(Number);
  const months: string[] = [];
  for (let i = nMonths - 1; i >= 0; i--) {
    const d = new Date(ly, lm - 1 - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  return months.map((ym) => {
    const [y, m] = ym.split("-");
    const d = new Date(Number(y), Number(m) - 1, 1);
    return {
      label: d.toLocaleString("en-IN", { month: "short", year: "2-digit" }),
      amount: totals[ym] ?? 0,
    };
  });
}
