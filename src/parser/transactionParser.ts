/**
 * Transaction parser — handles the actual Tally Prime JSON export format.
 *
 * Real format: { "tallymessage": [...] }
 * Each message is a voucher with flat lowercase fields.
 *
 * Key quirks:
 *  - vouchertypename: "SALES", "Purchase", "Payment", "Receipt", "Journal", "Contra"
 *  - date: "20240401" (YYYYMMDD)
 *  - isdeemedpositive / ispartyledger / iscancelled / isoptional: boolean (not "Yes"/"No")
 *  - amount: "-49919.00" or "402405.00" (string, negative = Tally credit)
 *  - actualqty: " 240 PC" (string with unit)
 *  - rate: "185.71/PC" (string with separator)
 *  - ledgerentries (SALES) OR allledgerentries (Payment/Receipt/etc.)
 *  - bill alloc: { name: "bill-ref", billtype: "Agst Ref", amount: "256852.00" }
 */

import type {
  CanonicalVoucher,
  CanonicalVoucherLine,
  CanonicalBillAlloc,
  ImportWarning,
  VoucherType,
} from "../types/canonical";

export interface TxParseResult {
  vouchers: CanonicalVoucher[];
  warnings: ImportWarning[];
}

const VOUCHER_TYPE_MAP: Record<string, VoucherType> = {
  sales: "Sales",
  sale: "Sales",
  purchase: "Purchase",
  receipt: "Receipt",
  payment: "Payment",
  journal: "Journal",
  contra: "Contra",
  "debit note": "Debit Note",
  debitnote: "Debit Note",
  "credit note": "Credit Note",
  creditnote: "Credit Note",
  "stock journal": "Stock Journal",
  stockjournal: "Stock Journal",
};

export function parseTransactions(raw: unknown): TxParseResult {
  const warnings: ImportWarning[] = [];
  const vouchers: CanonicalVoucher[] = [];
  const seen = new Set<string>();

  const rawVouchers = normalizeTransactionInput(raw, warnings);

  for (const rv of rawVouchers) {
    try {
      const v = parseOneVoucher(rv, warnings);
      if (v && !seen.has(v.voucherId)) {
        seen.add(v.voucherId);
        vouchers.push(v);
      }
    } catch (e) {
      warnings.push({ severity: "warn", context: "voucher", message: String(e) });
    }
  }

  return { vouchers, warnings };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeTransactionInput(raw: unknown, warnings: ImportWarning[]): any[] {
  if (!raw || typeof raw !== "object") return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj = raw as Record<string, any>;

  // ── Format 1: Real Tally { tallymessage: [...] } ──
  if (Array.isArray(obj.tallymessage)) {
    warnings.push({ severity: "info", context: "parser", message: `Found ${obj.tallymessage.length} vouchers in tallymessage format` });
    return obj.tallymessage.filter((m: unknown) => {
      if (!m || typeof m !== "object") return false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = m as any;
      // Skip entries that are clearly not vouchers
      const type = msg?.metadata?.type ?? msg?.metadata?.TYPE;
      if (type && type !== "Voucher") return false;
      // Must have a date to be a voucher
      return !!msg.date || !!msg.DATE;
    });
  }

  // ── Format 2: Tally ENVELOPE ──
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages = (obj as any)?.ENVELOPE?.BODY?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE;
    if (Array.isArray(messages)) {
      return messages
        .filter((m: unknown) => {
          if (!m || typeof m !== "object") return false;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (m as any).VOUCHER;
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((m: any) => tallyEnvelopeVoucherToSimple(m.VOUCHER));
    }
  } catch { /* ignore */ }

  // ── Format 3: { vouchers: [...] } ──
  if (Array.isArray(obj.vouchers)) return obj.vouchers;

  // ── Format 4: Array directly ──
  if (Array.isArray(raw)) return raw as unknown[];

  return [];
}

/** Convert Tally ENVELOPE format voucher to simple form */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tallyEnvelopeVoucherToSimple(tv: any): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lines: any[] = [];

  for (const le of toArray(tv.ALLLEDGERENTRIES ?? tv.LEDGERENTRIES)) {
    const billAllocs = toArray(le.BILLALLOCATIONS ?? le.BILLALOCATIONLIST).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (b: any) => ({
        billRef: b.NAME ?? b.BILLNAME,
        billType: b.BILLTYPE ?? "New Ref",
        amount: parseNum(b.AMOUNT),
        dueDate: b.DUEDATE ? formatDate(b.DUEDATE) : undefined,
      })
    );
    lines.push({
      type: "ledger",
      ledgerName: le.LEDGERNAME,
      isDebit: le.ISDEEMEDPOSITIVE === "Yes",
      amount: Math.abs(parseNum(le.AMOUNT)),
      isPartyLine: le.ISPARTYLEDGER === "Yes",
      billAllocations: billAllocs,
    });
  }

  for (const ie of toArray(tv.ALLINVENTORYENTRIES ?? tv.INVENTORYENTRIES)) {
    lines.push({
      type: "inventory",
      itemName: ie.STOCKITEMNAME,
      qtyBase: Math.abs(parseNum(ie.ACTUALQTY ?? ie.BILLEDQTY)),
      ratePerBase: parseNum(ie.RATE),
      lineAmount: Math.abs(parseNum(ie.AMOUNT)),
    });
  }

  return {
    voucherNumber: tv.VOUCHERNUMBER ?? tv.REFERENCE,
    voucherType: tv.VOUCHERTYPENAME,
    date: formatDate(tv.DATE),
    partyName: tv.PARTYLEDGERNAME,
    isCancelled: tv.ISCANCELLED === "Yes",
    isOptional: tv.ISOPTIONAL === "Yes",
    narration: tv.NARRATION,
    lines,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseOneVoucher(rv: any, warnings: ImportWarning[]): CanonicalVoucher | null {
  if (!rv || typeof rv !== "object") return null;

  const date = parseDate(rv.date ?? rv.DATE);
  if (!date) {
    warnings.push({ severity: "warn", context: "voucher", message: `Invalid date: ${rv.date ?? rv.DATE}` });
    return null;
  }

  const voucherType = normalizeVoucherType(rv.vouchertypename ?? rv.voucherType ?? rv.VOUCHERTYPENAME ?? "Other");
  const voucherNumber = String(rv.vouchernumber ?? rv.voucherNumber ?? rv.VOUCHERNUMBER ?? "").trim();
  const voucherId = `${voucherType}|${voucherNumber}|${date}`;

  const lines: CanonicalVoucherLine[] = [];
  let totalAmount = 0;
  let partyLedgerId: string | undefined;
  let partyName = rv.partyledgername ?? rv.partyName ?? rv.PARTYLEDGERNAME;

  // Real Tally format uses ledgerentries (SALES) or allledgerentries (others)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawLedgerEntries: any[] = toArray(
    rv.allledgerentries ?? rv.ledgerentries ?? rv.lines?.filter((l: unknown) => {
      if (!l || typeof l !== "object") return false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (l as any).type === "ledger";
    }) ?? []
  );

  for (const le of rawLedgerEntries) {
    // Handle both real Tally format (lowercase) and simple format
    const ledgerName = le.ledgername ?? le.ledgerName ?? le.LEDGERNAME ?? "";
    const ledgerId = String(ledgerName).toUpperCase().trim();
    if (!ledgerId) continue;

    // In real Tally JSON, isdeemedpositive is a boolean
    // In simple format, isDebit is boolean
    const isDebit = le.isdeemedpositive !== undefined
      ? Boolean(le.isdeemedpositive)
      : Boolean(le.isDebit ?? le.ISDEEMEDPOSITIVE === "Yes");

    // Amount: may be string ("-49919.00") or number; always take abs value
    const amount = Math.abs(parseNum(le.amount ?? le.AMOUNT ?? 0));

    // isPartyLine: boolean in real Tally
    const isPartyLine = le.ispartyledger !== undefined
      ? Boolean(le.ispartyledger)
      : Boolean(le.isPartyLine ?? le.ISPARTYLEDGER === "Yes");

    // Bill allocations
    const rawBAs = le.billallocations ?? le.billAllocations ?? le.BILLALLOCATIONS ?? le.BILLALOCATIONLIST ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const billAllocs: CanonicalBillAlloc[] = toArray(rawBAs).map((b: any) => {
      const billRef = String(b.name ?? b.billRef ?? b.NAME ?? b.BILLNAME ?? "");
      const billType = normalizeBillType(b.billtype ?? b.billType ?? b.BILLTYPE ?? "New Ref");
      const baAmount = Math.abs(parseNum(b.amount ?? b.AMOUNT ?? 0));
      const dueDate = b.dueDate ?? b.DUEDATE ?? undefined;
      return { billRef, billType, amount: baAmount, dueDate: dueDate ? parseDate(dueDate) ?? undefined : undefined };
    }).filter((b) => b.billRef);

    if (isPartyLine) {
      partyLedgerId = ledgerId;
      if (!partyName) partyName = ledgerName;
      totalAmount = amount;
    }

    lines.push({ type: "ledger", ledgerId, isDebit, amount, isPartyLine, billAllocations: billAllocs });
  }

  // Inventory entries
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawInventoryEntries: any[] = toArray(
    rv.allinventoryentries ?? rv.inventoryentries ??
    rv.ALLINVENTORYENTRIES ?? rv.INVENTORYENTRIES ??
    rv.lines?.filter((l: unknown) => {
      if (!l || typeof l !== "object") return false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (l as any).type === "inventory";
    }) ?? []
  );

  for (const ie of rawInventoryEntries) {
    const itemName = ie.stockitemname ?? ie.itemName ?? ie.STOCKITEMNAME ?? "";
    const itemId = String(itemName).toUpperCase().trim();
    if (!itemId) continue;

    // qty: " 240 PC" string or number
    const qtyBase = Math.abs(parseQtyString(
      ie.actualqty ?? ie.billedqty ?? ie.qtyBase ?? ie.ACTUALQTY ?? ie.BILLEDQTY ?? "0"
    ));

    // rate: "185.71/PC" string or number
    const ratePerBase = parseRateString(ie.rate ?? ie.ratePerBase ?? ie.RATE ?? "0");

    // amount: may be negative in Tally
    const lineAmount = Math.abs(parseNum(ie.amount ?? ie.lineAmount ?? ie.AMOUNT ?? qtyBase * ratePerBase));

    if (!totalAmount && lineAmount) totalAmount = lineAmount;

    lines.push({ type: "inventory", itemId, qtyBase, ratePerBase, lineAmount });
  }

  // Determine isCancelled / isOptional — in real Tally these are booleans
  const isCancelled = rv.iscancelled !== undefined
    ? Boolean(rv.iscancelled)
    : Boolean(rv.isCancelled ?? rv.ISCANCELLED === "Yes");
  const isOptional = rv.isoptional !== undefined
    ? Boolean(rv.isoptional)
    : Boolean(rv.isOptional ?? rv.ISOPTIONAL === "Yes");

  return {
    voucherId,
    voucherNumber,
    voucherType,
    date,
    partyLedgerId,
    partyName: partyName ? String(partyName).trim() : undefined,
    totalAmount,
    narration: rv.narration ?? rv.NARRATION,
    isCancelled,
    isOptional,
    lines,
  };
}

function normalizeVoucherType(raw: string): VoucherType {
  const key = String(raw).toLowerCase().trim();
  return VOUCHER_TYPE_MAP[key] ?? "Other";
}

function normalizeBillType(raw: string): CanonicalBillAlloc["billType"] {
  const s = String(raw).toLowerCase().trim();
  if (s === "agst ref" || s === "agst ref.") return "Agst Ref";
  if (s === "new ref" || s === "new ref.") return "New Ref";
  if (s === "advance") return "Advance";
  return "On Account";
}

function parseDate(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  // ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Tally: YYYYMMDD
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  // DD-MM-YYYY or DD/MM/YYYY
  const match = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (match) return `${match[3]}-${match[2]!.padStart(2, "0")}-${match[1]!.padStart(2, "0")}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function formatDate(v: unknown): string {
  return parseDate(v) ?? "";
}

function parseNum(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const s = String(v).replace(/[^0-9.\-]/g, "");
  const n = Number(s);
  return isFinite(n) ? n : 0;
}

/** Parse qty string like " 240 PC" or " 800 PR" → 240 */
function parseQtyString(v: unknown): number {
  if (typeof v === "number") return v;
  const s = String(v).trim();
  const match = s.match(/^-?\s*([0-9]+(?:\.[0-9]+)?)/);
  if (match) return parseFloat(match[1]);
  return parseNum(v);
}

/** Parse rate string like "185.71/PC" → 185.71 */
function parseRateString(v: unknown): number {
  if (typeof v === "number") return v;
  const s = String(v).trim();
  const parts = s.split("/");
  return parseNum(parts[0]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toArray(v: unknown): any[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") return [v];
  return [];
}
