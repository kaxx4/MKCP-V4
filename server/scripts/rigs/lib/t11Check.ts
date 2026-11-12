/**
 * JOB: "written equals read", field by field, for every field the agent sends on a voucher.
 *
 * `safePush`'s read-back checks money, stock lines and the party identity block. It does not look at
 * the date, the voucher type, the narration, the reference and its date, the invoice flag, whether a
 * line is a debit or a credit, a bill allocation's name and type, a bank instrument, the APPROPRIATEFOR
 * flag, a stock line's batch and godown, or the accounting allocation that carries the sales ledger.
 * This does, for the T11 rigs, so a field Tally silently drops shows up as a named difference.
 *
 * Pure: takes the payload we sent and the stored voucher's XML (a block from a Collection read). No
 * Tally, no Supabase. The offline test feeds it the Import XML our own builder makes (which uses the same
 * tag names), a hand-mutated copy, and an empty voucher.
 */
import { readTag, parseTallyAmount, tallyDate } from "../../../src/services/xml.js";
import { storedLedgerLines } from "../../../src/services/safePush.js";
import type { LedgerEntry, InventoryEntry, VoucherPayload } from "../../../src/types.js";

export interface FieldResult { field: string; sent: string; stored: string; ok: boolean }

const eqNum = (a: number, b: number) => Math.abs(a - b) < 0.011;
const num = (s: string) => parseTallyAmount(s) ?? NaN;
const sameText = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/** Sub-blocks with at least one populated tag (Tally pads with empty placeholders). */
function blocks(b: string, tag: string): string[] {
  return [...b.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]).filter((x) => /<[A-Z0-9_.]+>[^<\s]/.test(x));
}

const signedOf = (e: LedgerEntry): number => e.signedAmount !== undefined ? e.signedAmount : (e.isDeemedPositive ? -Math.abs(e.amount) : Math.abs(e.amount));
const yn = (b: boolean) => (b ? "Yes" : "No");

/** The quantity Tally stores as "3 PC" or "8 PC =  2.00 PKG": the leading number. */
const qtyOf = (s: string): number => num(s);

/**
 * Compare. `expectEmptyHeaderParty` is for Payment, Receipt and Contra, where Tally replaces the header
 * party with the bank or cash ledger (PARTY_OVERWRITTEN in pushGuard).
 */
export function compareToPayload(p: VoucherPayload, stored: string, opts: { partyOverwritten?: boolean } = {}): FieldResult[] {
  const out: FieldResult[] = [];
  const add = (field: string, sent: string, got: string, ok?: boolean) =>
    out.push({ field, sent, stored: got, ok: ok ?? sameText(sent, got) });

  // ── Header ──────────────────────────────────────────────────────────────
  add("date", tallyDate(p.date), readTag(stored, "DATE"));
  add("voucher type", p.voucherType.toUpperCase(), readTag(stored, "VOUCHERTYPENAME").toUpperCase());
  if (p.voucherNumber) add("voucher number", p.voucherNumber, readTag(stored, "VOUCHERNUMBER"));
  add("narration", p.narration ?? "", readTag(stored, "NARRATION"));
  add("reference", p.reference ?? "", readTag(stored, "REFERENCE"));
  if (p.referenceDate) add("reference date", tallyDate(p.referenceDate), readTag(stored, "REFERENCEDATE"));
  if (!opts.partyOverwritten && p.partyLedgerName) add("party ledger", p.partyLedgerName, readTag(stored, "PARTYLEDGERNAME"));
  const isInv = readTag(stored, "ISINVOICE");
  add("is invoice", yn(p.isInvoice), /^yes$/i.test(isInv) ? "Yes" : "No");

  // ── Ledger lines ────────────────────────────────────────────────────────
  const lines = storedLedgerLines(stored);
  const spent = new Set<number>();
  const sent = (p.ledgerEntries ?? []) as LedgerEntry[];
  add("ledger line count", String(sent.length), String(lines.filter((x) => readTag(x, "LEDGERNAME")).length));
  for (const e of sent) {
    const want = signedOf(e);
    let idx = lines.findIndex((x, i) => !spent.has(i) && readTag(x, "LEDGERNAME") === e.ledgerName && eqNum(num(readTag(x, "AMOUNT")), want));
    if (idx < 0) idx = lines.findIndex((x, i) => !spent.has(i) && readTag(x, "LEDGERNAME") === e.ledgerName);
    if (idx < 0) { add(`ledger "${e.ledgerName}"`, "present", "NOT STORED", false); continue; }
    spent.add(idx);
    const l = lines[idx];
    add(`ledger "${e.ledgerName}" amount`, String(want), String(num(readTag(l, "AMOUNT"))), eqNum(num(readTag(l, "AMOUNT")), want));
    add(`ledger "${e.ledgerName}" side`, yn(e.isDeemedPositive), readTag(l, "ISDEEMEDPOSITIVE") || "(absent)");
    if (e.appropriateToGst) add(`ledger "${e.ledgerName}" appropriates to GST`, "GST", readTag(l, "APPROPRIATEFOR") || "(absent)");
    const storedBills = blocks(l, "BILLALLOCATIONS\\.LIST");
    const billSpent = new Set<number>();
    for (const b of e.billAllocations ?? []) {
      // An On Account bill has no name in Tally, and a ledger that keeps no bills drops it (PAY-P1): by type then.
      const isOn = /^on account$/i.test(b.billType);
      const bi = storedBills.findIndex((x, i) => !billSpent.has(i) && (isOn ? /^on account$/i.test(readTag(x, "BILLTYPE")) : readTag(x, "NAME") === b.name));
      if (bi < 0) { if (!isOn || storedBills.length) add(`bill "${b.name}" on "${e.ledgerName}"`, b.billType, "NOT STORED", false); continue; }
      billSpent.add(bi);
      const bs = storedBills[bi];
      add(`bill "${b.name}" type`, b.billType, readTag(bs, "BILLTYPE"));
      const bwant = e.isDeemedPositive ? -Math.abs(b.amount) : Math.abs(b.amount);
      add(`bill "${b.name}" amount`, String(bwant), String(num(readTag(bs, "AMOUNT"))), eqNum(num(readTag(bs, "AMOUNT")), bwant));
    }
    if (e.bankAllocation) {
      const ba = blocks(l, "BANKALLOCATIONS\\.LIST")[0];
      if (!ba) add(`bank instrument on "${e.ledgerName}"`, e.bankAllocation.instrumentNumber, "NOT STORED", false);
      else {
        add("bank instrument number", e.bankAllocation.instrumentNumber, readTag(ba, "INSTRUMENTNUMBER"));
        add("bank transaction type", e.bankAllocation.transactionType, readTag(ba, "TRANSACTIONTYPE"));
        add("bank transfer mode", e.bankAllocation.transferMode, readTag(ba, "TRANSFERMODE"));
        add("bank favouring", e.bankAllocation.favouring, readTag(ba, "PAYMENTFAVOURING"));
        add("bank instrument date", tallyDate(e.bankAllocation.instrumentDate ?? p.date), readTag(ba, "INSTRUMENTDATE"));
      }
    }
  }

  // ── Stock lines ─────────────────────────────────────────────────────────
  const inv = blocks(stored, "ALLINVENTORYENTRIES\\.LIST");
  const invSent = (p.inventoryEntries ?? []) as InventoryEntry[];
  if (invSent.length || inv.length) add("stock line count", String(invSent.length), String(inv.length));
  const ispent = new Set<number>();
  for (const l of invSent) {
    const wantAmt = l.isDeemedPositive ? -Math.abs(l.amount) : Math.abs(l.amount);
    let idx = inv.findIndex((x, i) => !ispent.has(i) && readTag(x, "STOCKITEMNAME") === l.stockItemName && eqNum(num(readTag(x, "AMOUNT")), wantAmt));
    if (idx < 0) idx = inv.findIndex((x, i) => !ispent.has(i) && readTag(x, "STOCKITEMNAME") === l.stockItemName);
    if (idx < 0) { add(`item "${l.stockItemName}"`, "present", "NOT STORED", false); continue; }
    ispent.add(idx);
    const b = inv[idx];
    add(`item "${l.stockItemName}" quantity`, String(l.quantity), String(qtyOf(readTag(b, "ACTUALQTY"))), eqNum(qtyOf(readTag(b, "ACTUALQTY")), l.quantity));
    add(`item "${l.stockItemName}" billed quantity`, String(l.quantity), String(qtyOf(readTag(b, "BILLEDQTY"))), eqNum(qtyOf(readTag(b, "BILLEDQTY")), l.quantity));
    add(`item "${l.stockItemName}" unit`, l.unit, (/\s([A-Za-z]+)\s*$/.exec(readTag(b, "ACTUALQTY"))?.[1] ?? ""));
    add(`item "${l.stockItemName}" rate`, String(l.rate), String(num(readTag(b, "RATE"))), eqNum(num(readTag(b, "RATE")), l.rate));
    add(`item "${l.stockItemName}" amount`, String(wantAmt), String(num(readTag(b, "AMOUNT"))), eqNum(num(readTag(b, "AMOUNT")), wantAmt));
    add(`item "${l.stockItemName}" side`, yn(l.isDeemedPositive), readTag(b, "ISDEEMEDPOSITIVE") || "(absent)");
    if (l.godownName) {
      const ba = blocks(b, "BATCHALLOCATIONS\\.LIST")[0] ?? "";
      add(`item "${l.stockItemName}" godown`, l.godownName, readTag(ba, "GODOWNNAME"));
      add(`item "${l.stockItemName}" batch`, l.batchName || "Primary Batch", readTag(ba, "BATCHNAME"));
    }
    if (l.salesLedgerName) {
      const acc = blocks(b, "ACCOUNTINGALLOCATIONS\\.LIST").find((x) => readTag(x, "LEDGERNAME") === l.salesLedgerName);
      add(`item "${l.stockItemName}" accounting ledger`, l.salesLedgerName, acc ? readTag(acc, "LEDGERNAME") : "NOT STORED", !!acc);
      if (acc) add(`item "${l.stockItemName}" accounting amount`, String(wantAmt), String(num(readTag(acc, "AMOUNT"))), eqNum(num(readTag(acc, "AMOUNT")), wantAmt));
    }
  }
  return out;
}

/** Only the failures, one line each. */
export const failures = (r: FieldResult[]): string[] => r.filter((x) => !x.ok).map((x) => `${x.field}: sent "${x.sent}", stored "${x.stored}"`);
