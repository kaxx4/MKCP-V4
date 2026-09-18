/**
 * Which vouchers would land in a GSTR exception bucket.
 *
 * ── Why this exists in this shape ─────────────────────────────────────────
 *
 * The requirement is that NOTHING this app pushes lands in an exception. That
 * is the one failure every other safety net here is blind to: a voucher missing
 * its GST identity **balances, verifies, reads back byte-identical, and files
 * wrong**. `safePush`'s diff compares what we sent against what Tally stored,
 * and on this failure both are equally wrong.
 *
 * The obvious verification — read Tally's own exception list — is not
 * available. Asked on 13-Sep-2026: `GSTR-1`, `GSTR1`, `GSTR-3B`, `GST Returns`,
 * `Returns Summary`, `HSN/SAC Summary` and `Statutory Reports` all come back
 * "Could not find Report". Only `GST Rate Setup` answers. So Tally will not tell
 * us which vouchers it is unhappy about.
 *
 * ── So audit the preconditions instead ────────────────────────────────────
 *
 * Everything the exceptions depend on IS readable off the voucher —
 * `PLACEOFSUPPLY`, `PARTYGSTIN`, `CONSIGNEESTATENAME`, the ledger names on the
 * entries, and `APPROPRIATEFOR`. So rather than asking Tally what it dislikes,
 * we check the same conditions Tally checks, by the same rules the push guard
 * enforces.
 *
 * `APPROPRIATEFOR` is the late addition, and the reason it was late is worth
 * keeping: this file spent a while asserting the field was unreadable, when in
 * fact nothing had ever asked Tally for it. A fetch list that omits a field and
 * a Tally that does not hold it look identical in the response — guardrail G7.
 * See the note in `auditVoucher`.
 *
 * This is a weaker guarantee than reading the real list and the plan says so
 * (guardrail P7 — every verification states what it cannot see). What it gains
 * is that it runs nightly over ALL vouchers, needs no portal, and catches a
 * problem the day it is created rather than on the 11th.
 */

export type ExceptionKind =
  | "no-place-of-supply"
  | "no-party-gstin"
  | "tax-head-mismatch"
  | "no-tax-line"
  | "unappropriated-adjustment";

export interface GstrException {
  kind: ExceptionKind;
  voucherNumber: string;
  date: string;
  voucherType: string;
  party: string;
  /** What Tally would say, or near enough to recognise it. */
  message: string;
  /** True when this voucher carries one of our own test markers. */
  isOurTestVoucher: boolean;
}

export interface AuditedVoucher {
  /**
   * True when the entry list came back POPULATED.
   *
   * A large voucher collection returns empty placeholder `.LIST` blocks for
   * some vouchers — 186 of 310 April sales vouchers in one 24 MB pull. Auditing
   * those as "no tax line" produces a false exception for each. So a voucher
   * whose entries did not populate is SKIPPED and counted separately, never
   * flagged. Chunk the pull smaller to get them.
   */
  entriesPopulated: boolean;
  voucherNumber: string;
  date: string;
  voucherType: string;
  party: string;
  placeOfSupply: string;
  partyGstin: string;
  consigneeState: string;
  narration: string;
  /**
   * `appropriateFor` is Tally's own `<APPROPRIATEFOR>` on that ledger entry —
   * "GST" on an appropriated line, empty or absent otherwise. It only arrives
   * if the caller asks for `ALLLEDGERENTRIES.APPROPRIATEFOR` by name; a plain
   * `ALLLEDGERENTRIES.LIST` fetch returns the line without it, which is what
   * made this look unreadable for a while. See `probe-gst-appropriation.ts`.
   */
  entries: { ledgerName: string; amount: number; appropriateFor: string }[];
}

const OUTWARD = /^(SALES|CREDIT NOTE)$/i;
const TAX_HEAD = /\b(CGST|SGST|UTGST|IGST|CESS)\b/i;
const ROUNDING = /^\s*ROUND(ED)?\s*OFF\s*$/i;
const IGST = /\bIGST\b/i;
const CGST_SGST = /\b(CGST|SGST|UTGST)\b/i;
const CASH = /^\s*CASH\s*$/i;
/**
 * The revenue ledger — `SALES ( GST W.B. )`, `SALES ( GST CENTRAL )`.
 *
 * It exists on a READ and not on a push: a pushed voucher carries the sales
 * ledger inside the inventory entry's `ACCOUNTINGALLOCATIONS`, so `pushGuard`
 * never sees it among `ledgerEntries`, but `ALLLEDGERENTRIES.LIST` lists it
 * flat alongside the rest. Treating it as an adjustment line would flag every
 * invoice in the book — which is the shape of the 431 false positives the
 * first version of this file produced.
 *
 * `DISCOUNT` is carved out because `PURCHASE DISCOUNTS ( @ 5% )` starts with
 * PURCHASE and is a genuine adjustment, not revenue.
 */
const REVENUE = (n: string) => /^\s*(SALES|PURCHASE)\b/i.test(n) && !/DISCOUNT/i.test(n);
const TEST_MARKER = /^(MKCP-|RPLY-|VERIFY-|SMOKE-|DEMO-)/i;

const HOME_STATE = "WEST BENGAL";

/**
 * Audit one voucher.
 *
 * Only outward supplies are checked — a purchase reaches GSTR-2 rather than
 * GSTR-1, and money vouchers correctly carry no GST at all, which is verified
 * rather than assumed.
 */
export function auditVoucher(v: AuditedVoucher): GstrException[] {
  if (!OUTWARD.test(v.voucherType.trim())) return [];
  // Never flag a voucher whose entries Tally did not send.
  if (!v.entriesPopulated) return [];

  const out: GstrException[] = [];
  const isOurTestVoucher = TEST_MARKER.test(v.voucherNumber.trim());
  const add = (kind: ExceptionKind, message: string) =>
    out.push({ kind, voucherNumber: v.voucherNumber, date: v.date, voucherType: v.voucherType, party: v.party, message, isOurTestVoucher });

  const isCashSale = v.entries.some((e) => CASH.test(e.ledgerName));

  // ── Place of supply ─────────────────────────────────────────────────────
  // Without it Tally cannot decide which return section the voucher belongs in.
  const pos = (v.placeOfSupply || v.consigneeState || "").trim();
  if (!pos) {
    add("no-place-of-supply",
      "GST Registration Details are invalid or not specified — no place of supply on the voucher.");
  }

  // ── Party GSTIN ─────────────────────────────────────────────────────────
  // A cash sale is legitimately B2C. A named party without a GSTIN files as B2C
  // too, which is allowed but is usually a missing master rather than a choice.
  if (!isCashSale && !v.partyGstin.trim()) {
    add("no-party-gstin",
      `"${v.party}" has no GSTIN, so this files as B2C. Correct for a counter sale; a missing master otherwise.`);
  }

  // ── Tax head against the place of supply ────────────────────────────────
  const interState = !!pos && pos.trim().toUpperCase() !== HOME_STATE;
  const heads = v.entries.filter((e) => TAX_HEAD.test(e.ledgerName));
  const hasIgst = heads.some((e) => IGST.test(e.ledgerName));
  const hasLocal = heads.some((e) => CGST_SGST.test(e.ledgerName) && !IGST.test(e.ledgerName));

  if (heads.length === 0) {
    add("no-tax-line", "No CGST, SGST or IGST line at all on an outward supply.");
  } else if (interState && hasLocal) {
    add("tax-head-mismatch",
      `Place of supply is ${pos} but the voucher carries CGST/SGST. An inter-state supply takes IGST.`);
  } else if (!interState && hasIgst) {
    add("tax-head-mismatch",
      `Place of supply is ${pos} but the voucher carries IGST. A local supply takes CGST + SGST.`);
  }

  /* ── GST appropriation on an adjustment line ───────────────────────────
   *
   * An adjustment line that does not appropriate to GST leaves Tally computing
   * expected tax on the gross stock amount, which disagrees with the tax
   * actually booked — "Mismatch between Expected Tax Amount and Modified Tax
   * Amount". It is the single most common exception class available to this
   * business, because most invoices carry a TRADE DISCOUNTS / H.C. line.
   *
   * This file used to skip the check, on the stated grounds that appropriation
   * was "not observable from a voucher read". That was wrong, and worth being
   * precise about, because the reasoning failed in two separate places:
   *
   *   · It IS observable. Tally returns `<APPROPRIATEFOR>GST</APPROPRIATEFOR>`
   *     and `<GSTAPPROPRIATETO>Goods</GSTAPPROPRIATETO>` on the entry — but only
   *     when the fetch list names `ALLLEDGERENTRIES.APPROPRIATEFOR`. The audit
   *     asked for a bare `ALLLEDGERENTRIES.LIST` and concluded from its absence
   *     that Tally does not hold it. Measured 18-Sep-2026 over 876 April
   *     vouchers, 80 of which carry a discount line.
   *   · The fallback claim was backwards too — it said the appropriation is a
   *     property of the LEDGER MASTER "which TRADE DISCOUNTS / H.C. does carry".
   *     All nine adjustment ledgers read `APPROPRIATEFOR = Not Applicable` on
   *     their masters. It is set per transaction, not inherited.
   *
   * The earlier 431 false positives were real, but they came from inferring
   * appropriation from `VATASSESSABLEVALUE` — which is present and EMPTY on
   * every line of every voucher, including OUTPUT CGST, so it carries nothing.
   * Reading the actual tag is not that inference repeated; it is the fix for it.
   *
   * The classification below is `pushGuard` rule 30's, plus REVENUE, which the
   * guard does not need and a read does.
   */
  for (const e of v.entries) {
    if (e.ledgerName === v.party) continue;
    if (CASH.test(e.ledgerName)) continue;
    if (TAX_HEAD.test(e.ledgerName) || ROUNDING.test(e.ledgerName)) continue;
    if (REVENUE(e.ledgerName)) continue;
    if (/GST/i.test(e.appropriateFor)) continue;
    add("unappropriated-adjustment",
      `"${e.ledgerName}" (${e.amount}) changes the invoice value but does not appropriate to GST, ` +
      `so Tally computes expected tax on the gross — "Mismatch between Expected Tax Amount and ` +
      `Modified Tax Amount".`);
  }

  return out;
}

export interface AuditResult {
  vouchersChecked: number;
  outwardChecked: number;
  /** Outward vouchers skipped because Tally sent empty placeholder entry lists. */
  outwardSkipped: number;
  exceptions: GstrException[];
  byKind: Record<string, number>;
  /** Exceptions on vouchers carrying one of our own test markers. */
  ours: GstrException[];
  /** Everything else — the pre-existing state of the books. */
  theirs: GstrException[];
  caveat: string;
}

export function auditAll(vouchers: AuditedVoucher[]): AuditResult {
  const exceptions: GstrException[] = [];
  let outward = 0;
  let skipped = 0;

  for (const v of vouchers) {
    if (OUTWARD.test(v.voucherType.trim())) {
      outward++;
      if (!v.entriesPopulated) skipped++;
    }
    exceptions.push(...auditVoucher(v));
  }

  const byKind: Record<string, number> = {};
  for (const e of exceptions) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;

  return {
    vouchersChecked: vouchers.length,
    outwardChecked: outward - skipped,
    outwardSkipped: skipped,
    exceptions,
    byKind,
    ours: exceptions.filter((e) => e.isOurTestVoucher),
    theirs: exceptions.filter((e) => !e.isOurTestVoucher),
    caveat:
      "Tally's own GSTR exception list is not readable over XML — every GSTR report name " +
      "returns \"Could not find Report\". This audits the same preconditions Tally checks, " +
      "from the fields the voucher exposes. It can be wrong in both directions: a condition " +
      "Tally checks that is not modelled here, or a voucher flagged here that Tally accepts.",
  };
}
