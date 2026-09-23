/**
 * Preflight for every voucher before it reaches Tally.
 *
 * Two reasons this is strict rather than best-effort:
 *
 *  1. A malformed request throws a modal that blocks Tally's XML port entirely
 *     and costs a full restart of the application. Refusing locally is free;
 *     being refused by Tally is not.
 *  2. Tally accepts several kinds of wrong voucher SILENTLY — a mistyped ledger
 *     name, a unit that isn't the item's own, a missing party state all return
 *     CREATED=1 while the voucher lands incomplete or mis-taxed.
 *
 * Every rule below was established by pushing real vouchers and reading them
 * back; see the vault's "Tally Voucher Push Contract".
 */
import type { VoucherPayload } from "../types.js";
import { type TallyMasters, findLedger, findItem, isMiss, gstRateFor, mailingOn } from "./tallyMasters.js";

export interface GuardResult { ok: boolean; errors: string[]; warnings: string[]; }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * M.K.CYCLES is registered in West Bengal; anything else is interstate.
 *
 * Exported so `voucherPusher` resolves place of supply against the SAME state
 * this guard checks the tax heads against. Two copies of "which state are we"
 * that drifted apart would let a voucher pass the guard as intra-state while
 * being stamped as inter-state, or the reverse.
 */
export const HOME_STATE = "WEST BENGAL";
/** The same state, spelled the way Tally stores it in PLACEOFSUPPLY. */
export const HOME_STATE_NAME = "West Bengal";

/**
 * Which way are the goods moving?
 *
 *   outward — they go TO the counterparty (Sales, Credit Note, orders, dispatch)
 *   inward  — they come TO us (Purchase, Debit Note, Receipt Note)
 *
 * This decides where the place of supply comes from, so the guard and the
 * builder must answer it identically. It used to be an inline regex in
 * `voucherPusher` alone.
 */
export function isInwardSupply(voucherType: string): boolean {
  return /PURCHASE|DEBIT NOTE|RECEIPT NOTE/.test(voucherType.toUpperCase());
}

export type StateSource = "ledger" | "payload" | "none";

/**
 * The counterparty's state for this voucher, and where it came from.
 *
 * Normally the ledger master carries it. It is allowed to come from the payload
 * instead for exactly one real case: a counter sale billed to the shared `Cash`
 * ledger, which has no state and cannot be given one without misdescribing every
 * other voucher that uses it. About a third of this company's sales are cash, so
 * without this they could not be pushed at all.
 *
 * `placeOfSupply` may only stand in on an OUTWARD voucher, where the place of
 * supply and the counterparty's state are the same thing (the goods go to the
 * buyer). On an inward voucher the place of supply is always ours and says
 * nothing about the supplier, so it is refused rather than quietly ignored —
 * see `guardVoucher`.
 *
 * The ledger always wins when it has a state: a payload must not be able to
 * re-describe a party Tally already knows.
 */
export function resolvePartyState(
  p: Pick<VoucherPayload, "voucherType" | "placeOfSupply">,
  ledgerState: string | undefined | null,
): { state: string; source: StateSource } {
  const onLedger = (ledgerState ?? "").trim();
  if (onLedger) return { state: onLedger, source: "ledger" };
  const declared = (p.placeOfSupply ?? "").trim();
  if (declared && !isInwardSupply(p.voucherType)) return { state: declared, source: "payload" };
  return { state: "", source: "none" };
}
/** Voucher types that carry stock but no Dr/Cr to balance. */
const NON_ACCOUNTING = new Set(["Receipt Note", "Material In", "Material Out", "Stock Journal", "Physical Stock"]);
/** Tally overwrites PARTYLEDGERNAME on these with the bank/cash ledger, so the
 *  party line need not match the header. */
const PARTY_OVERWRITTEN = new Set(["Payment", "Receipt", "Contra"]);

const money = (n: number) => `₹${n.toFixed(2)}`;

/**
 * The date through which GST returns have been filed, as YYYY-MM-DD.
 *
 * Tally does record per-voucher filing state — `GST.LIST` carries `ISSIGNED`,
 * `GSTNSTATUS` and a `STATKEY` naming the return period — but it is only present
 * in the Day Book EXPORT, not in a targeted voucher collection, and Day Book
 * ignores its own date range on this install. So it cannot be queried for an
 * arbitrary voucher, and pretending otherwise would give a safety check that
 * silently never fires.
 *
 * An operator-declared boundary is honest and is how the question is actually
 * thought about ("August is filed"). Set MKCP_FILED_THROUGH to move it.
 */
export const FILED_THROUGH = (process.env.MKCP_FILED_THROUGH ?? "").trim();

export function guardVoucher(p: VoucherPayload, m: TallyMasters): GuardResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── A filed return must not change underneath itself ──────────────────────
  const action0 = p.action ?? "Create";
  /* Cancel belongs with Alter and Delete everywhere below: it changes a filed
     return exactly as much as they do (a cancelled invoice leaves GSTR-1), and
     it needs a REMOTEID exactly as much, because Tally has no other handle. */
  const CHANGES_EXISTING = new Set(["Alter", "Cancel", "Delete"]);
  if (CHANGES_EXISTING.has(action0) && FILED_THROUGH && p.date <= FILED_THROUGH) {
    if (!p.allowFiledPeriodEdit) {
      errors.push(`${action0} refused: ${p.date} falls in a GST period already filed (through ${FILED_THROUGH}). Changing it would alter a submitted return. Set allowFiledPeriodEdit if the return will be revised.`);
    } else {
      warnings.push(`${action0} on ${p.date} changes a voucher in a FILED period (through ${FILED_THROUGH}) — the return will need revising.`);
    }
  }
  if (CHANGES_EXISTING.has(action0) && !FILED_THROUGH) {
    warnings.push("MKCP_FILED_THROUGH is not set, so filed-period protection is off — an Alter could change an already-submitted return.");
  }

  // ── Voucher type must exist in THIS company ───────────────────────────────
  // A case-only difference is tolerated — Tally itself matches case-insensitively,
  // and this company's Sales type is literally named "SALES", so rejecting
  // "Sales" would refuse a voucher Tally would happily accept. Anything else is
  // a genuine miss.
  if (!m.voucherTypes.has(p.voucherType)) {
    const near = [...m.voucherTypes].find(v => v.toUpperCase() === p.voucherType.toUpperCase());
    if (near) warnings.push(`Voucher type "${p.voucherType}" — this company spells it "${near}". Tally will match it anyway.`);
    else errors.push(`Voucher type "${p.voucherType}" is not configured in this company. Available: ${[...m.voucherTypes].slice(0, 8).join(", ")}…`);
  }

  if (!DATE_RE.test(p.date)) errors.push(`Date must be YYYY-MM-DD (got "${p.date}").`);

  // ── Identity: without a REMOTEID a voucher can only ever be created ───────
  // An Alter on a voucher that has no REMOTEID does NOT fail — Tally performs a
  // Create instead and returns created=1, which reads as success while
  // duplicating real money. Refuse rather than let that happen.
  const action = p.action ?? "Create";
  if (CHANGES_EXISTING.has(action) && !p.remoteId) {
    errors.push(`${action} requires a remoteId — Tally addresses existing vouchers by REMOTEID. Without one it would silently create a duplicate instead of changing anything.`);
  }
  if (action === "Create" && !p.remoteId) {
    warnings.push("No remoteId set — this voucher will not be correctable later, and a re-push would duplicate it rather than being refused.");
  }

  // ── Names must resolve EXACTLY. Near misses are the dangerous case: Tally
  //    drops the fragment rather than erroring, so name them precisely. ──────
  const party = findLedger(m, p.partyLedgerName);
  if (isMiss(party)) {
    errors.push(party.suggestion
      ? `Party ledger "${p.partyLedgerName}" does not exist — Tally spells it "${party.suggestion}".`
      : `Party ledger "${p.partyLedgerName}" does not exist.`);
  }

  // ── Place of supply, when the ledger cannot carry one ─────────────────────
  const partyState = isMiss(party) ? "" : party.state;
  const resolved = resolvePartyState(p, partyState);
  const declared = (p.placeOfSupply ?? "").trim();

  if (declared && isInwardSupply(p.voucherType)) {
    // On an inward voucher the place of supply is always OUR state, so a declared
    // one says nothing about the supplier and cannot stand in for their state.
    // Accepting and ignoring it would let a caller believe they had supplied the
    // missing information.
    errors.push(`placeOfSupply is not accepted on ${p.voucherType}: goods are coming TO us, so the place of supply is always ${HOME_STATE_NAME}. It cannot supply the supplier's state — set that on their ledger in Tally.`);
  }
  if (declared && partyState && declared.toUpperCase() !== partyState.trim().toUpperCase()) {
    // Tally's own master is the authority. A payload disagreeing with it is a
    // bug in the caller, not an override.
    errors.push(`placeOfSupply "${declared}" contradicts the state on ledger "${!isMiss(party) ? party.name : p.partyLedgerName}" (${partyState}). The ledger is authoritative — remove placeOfSupply.`);
  }
  if (resolved.source === "payload") {
    // A typo here is not cosmetic: it decides CGST+SGST vs IGST. Check it against
    // the states this company's own ledgers actually use rather than a hardcoded
    // list, so it stays true as the book grows.
    const known = new Set<string>([HOME_STATE_NAME.toUpperCase()]);
    for (const l of m.ledgers.values()) if (l.state) known.add(l.state.trim().toUpperCase());
    if (!known.has(resolved.state.toUpperCase())) {
      errors.push(`placeOfSupply "${resolved.state}" is not a state any ledger in this company uses — check the spelling. It decides CGST+SGST vs IGST, so a typo mis-taxes the voucher silently.`);
    } else {
      warnings.push(`Place of supply "${resolved.state}" comes from the payload, not from ledger "${p.partyLedgerName}" — that ledger has no state of its own.`);
    }
  }
  if (!isMiss(party) && resolved.source === "none") {
    // Without a state Tally cannot decide CGST+SGST vs IGST, and books it wrong silently.
    warnings.push(`Party "${party.name}" has no state on its ledger master — the tax head cannot be derived from it.`);
  }

  if (!p.ledgerEntries?.length) errors.push("Voucher has no ledger entries.");

  for (const e of p.ledgerEntries ?? []) {
    const led = findLedger(m, e.ledgerName);
    if (isMiss(led)) {
      errors.push(led.suggestion
        ? `Ledger "${e.ledgerName}" does not exist — Tally spells it "${led.suggestion}".`
        : `Ledger "${e.ledgerName}" does not exist.`);
    }
    if (!Number.isFinite(e.amount)) errors.push(`Ledger "${e.ledgerName}" has a non-numeric amount.`);
    else if (e.amount < 0) {
      // Direction comes only from isDeemedPositive. A negative magnitude flips this
      // entry's contribution and can make an unbalanced voucher net to zero.
      errors.push(`Ledger "${e.ledgerName}" has a negative amount (${money(e.amount)}) — amount is a magnitude; direction comes from isDeemedPositive.`);
    }

    // Bill allocations must sum EXACTLY to their parent line — true in 1,732 of
    // 1,732 real ledger lines. Tally rejects the voucher otherwise.
    if (e.billAllocations?.length) {
      const sum = e.billAllocations.reduce((s, b) => s + b.amount, 0);
      if (Math.abs(sum - e.amount) > 0.02) {
        errors.push(`Bill allocations on "${e.ledgerName}" total ${money(sum)} but the line is ${money(e.amount)} — they must match exactly.`);
      }
      for (const b of e.billAllocations) {
        if (!b.name?.trim()) errors.push(`A bill allocation on "${e.ledgerName}" has no reference name.`);
      }
    }
  }

  // ── Stock lines ───────────────────────────────────────────────────────────
  for (const ie of p.inventoryEntries ?? []) {
    const item = findItem(m, ie.stockItemName);
    if (isMiss(item)) {
      errors.push(item.suggestion
        ? `Stock item "${ie.stockItemName}" does not exist — Tally spells it "${item.suggestion}".`
        : `Stock item "${ie.stockItemName}" does not exist.`);
    } else if (ie.unit !== item.baseUnit) {
      // Silent failure: a unit that isn't the item's own base unit makes Tally
      // void the quantity and rate while still creating the voucher.
      errors.push(`Unit "${ie.unit}" on "${ie.stockItemName}" is not that item's base unit ("${item.baseUnit}") — Tally would void the quantity and rate without erroring.`);
    }
    if (ie.salesLedgerName) {
      const sl = findLedger(m, ie.salesLedgerName);
      if (isMiss(sl)) {
        errors.push(sl.suggestion
          ? `Accounting ledger "${ie.salesLedgerName}" does not exist — Tally spells it "${sl.suggestion}". It would be dropped silently.`
          : `Accounting ledger "${ie.salesLedgerName}" does not exist — it would be dropped silently.`);
      }
    }
    if (ie.godownName && !m.godowns.has(ie.godownName)) {
      errors.push(`Godown "${ie.godownName}" does not exist.`);
    }
    if (!Number.isFinite(ie.quantity) || ie.quantity <= 0) errors.push(`Quantity for "${ie.stockItemName}" must be positive.`);
    // Tally rounds a fractional quantity to whatever decimal precision the unit
    // is configured for, WITHOUT reporting it — 1.5 PC was stored as 2 PC in
    // testing. The voucher still balances on value, so nothing looks wrong; only
    // the stock figure is off.
    if (Number.isFinite(ie.quantity) && !Number.isInteger(ie.quantity)) {
      warnings.push(`Quantity ${ie.quantity} for "${ie.stockItemName}" is fractional — if "${isMiss(item) ? ie.unit : item.baseUnit}" carries no decimal places Tally will round it silently. Verify the stored quantity.`);
    }
    // Zero is rejected, not just negative. A zero-value line books stock out of
    // nothing and is almost always a rate that failed to read; the house
    // convention for a genuine stock adjustment is ₹1, never ₹0.
    if (!Number.isFinite(ie.amount) || ie.amount <= 0) {
      errors.push(`Amount for "${ie.stockItemName}" must be a positive magnitude — a zero-value stock line would add stock with no value.`);
    }
  }

  const hasStock = (p.inventoryEntries?.length ?? 0) > 0;
  // Invoice-SHAPED, not `isInvoice`: a Sales Order Note carries ISINVOICE=No
  // yet still puts its goods in stock lines with their own accounting
  // allocation, so the stock side is what balances the party line.
  const invoiceShaped = p.isInvoice || (p.inventoryEntries ?? []).some(e => !!e.salesLedgerName);

  // ── Invoice mode: the sales/purchase ledger belongs ONLY in the stock line's
  //    accounting allocation. Listing it as its own entry double-counts that
  //    side and Tally rejects the voucher with EXCEPTIONS=1 and no reason. ────
  if (invoiceShaped && hasStock) {
    const acctLedgers = new Set((p.inventoryEntries ?? []).map(i => i.salesLedgerName).filter(Boolean));
    for (const e of p.ledgerEntries ?? []) {
      if (acctLedgers.has(e.ledgerName)) {
        errors.push(`"${e.ledgerName}" appears both as a ledger entry and as a stock line's accounting allocation — on an item invoice it belongs only in the allocation, or that side is counted twice.`);
      }
    }
  }

  // ── Balance. On an item invoice the stock lines supply the contra side. ────
  if (!NON_ACCOUNTING.has(p.voucherType)) {
    // Balance the values Tally will receive. A line carrying an explicit
    // signedAmount — a negative credit, such as TRADE DISCOUNTS / H.C. — is
    // emitted verbatim, so re-deriving its sign here would balance a voucher
    // that is not the one being sent.
    const ledgerSide = (p.ledgerEntries ?? []).reduce((s, e) => s + (e.signedAmount !== undefined
      ? e.signedAmount
      : (e.isDeemedPositive ? -Math.abs(e.amount) : Math.abs(e.amount))), 0);
    const stockSide = (invoiceShaped ? p.inventoryEntries ?? [] : [])
      .reduce((s, e) => s + (e.isDeemedPositive ? -Math.abs(e.amount) : Math.abs(e.amount)), 0);
    const net = ledgerSide + stockSide;
    if (Math.abs(net) > 0.02) {
      errors.push(`Voucher does not balance: ledgers ${money(ledgerSide)} + stock ${money(stockSide)} = ${money(net)}, must be zero.`);
    }
  }

  // ── Party line sanity ─────────────────────────────────────────────────────
  const partyLines = (p.ledgerEntries ?? []).filter(e => e.isPartyLedger);
  if (partyLines.length > 1) errors.push(`Expected at most one party ledger line, found ${partyLines.length}.`);
  if (partyLines.length === 1 && !PARTY_OVERWRITTEN.has(p.voucherType) && partyLines[0].ledgerName !== p.partyLedgerName) {
    errors.push(`The party line ("${partyLines[0].ledgerName}") must match partyLedgerName ("${p.partyLedgerName}").`);
  }

  // ── Direction of stock movement ───────────────────────────────────────────
  // Compared case-insensitively: this company's type is literally named "SALES".
  if (p.voucherType.toUpperCase() === "SALES") {
    for (const ie of p.inventoryEntries ?? []) {
      if (ie.isDeemedPositive) errors.push(`Outward item "${ie.stockItemName}" must have isDeemedPositive=false.`);
    }
  } else if (p.voucherType === "Purchase") {
    for (const ie of p.inventoryEntries ?? []) {
      if (!ie.isDeemedPositive) errors.push(`Inward item "${ie.stockItemName}" must have isDeemedPositive=true.`);
    }
  }

  // ── Tax head must agree with the party's state ────────────────────────────
  // Verified across 455 real purchases with no exception: Punjab/UP/Delhi → IGST,
  // West Bengal → CGST+SGST. Getting this wrong produces a voucher that looks
  // perfect on screen and files wrong in GSTR-1, which is only found at return time.
  if (!isMiss(party) && resolved.state) {
    const interstate = resolved.state.trim().toUpperCase() !== HOME_STATE;
    // Name the party when the state is theirs, and the declaration when it is
    // not — "Cash is in West Bengal" would be a confusing thing to read.
    const because = resolved.source === "payload"
      ? `This voucher declares its place of supply as ${resolved.state}`
      : `Party "${party.name}" is in ${resolved.state}`;
    const names = [
      ...(p.ledgerEntries ?? []).map(e => e.ledgerName),
      ...(p.inventoryEntries ?? []).map(i => i.salesLedgerName).filter(Boolean) as string[],
    ];
    const usesIgst = names.some(n => /\bIGST\b/i.test(n));
    const usesLocalPair = names.some(n => /\bCGST\b/i.test(n)) || names.some(n => /\bSGST\b/i.test(n));
    const usesWbAccount = names.some(n => /GST\s*W\.?B\.?/i.test(n));
    const usesCentralAccount = names.some(n => /GST\s*CENTRAL/i.test(n));

    if (interstate && (usesLocalPair || usesWbAccount)) {
      errors.push(`${because}, so this is an interstate transaction — it must use IGST and the "( GST CENTRAL )" account, not CGST/SGST or "( GST W.B. )".`);
    }
    if (!interstate && (usesIgst || usesCentralAccount)) {
      errors.push(`${because}, so this is a local transaction — it must use CGST+SGST and the "( GST W.B. )" account, not IGST or "( GST CENTRAL )".`);
    }
  }

  // ── GSTR-1 exception prevention ───────────────────────────────────────────
  // A voucher can balance, import cleanly and read back identical, and still be
  // unfilable: Tally parks it under "Transactions with Incomplete/Mismatch in
  // Information" and it never reaches B2B supplies. The read-back diff cannot
  // see this — it compares amounts, allocations and stock, none of which are
  // what GSTR-1 classifies on. So the check has to happen before the push.
  //
  // Each rule below maps to an exception category seen in the operator's own
  // return on 2026-09-11.
  if (invoiceShaped && (p.inventoryEntries ?? []).length > 0 && !isMiss(party)) {
    const TAX_HEAD = /\b(CGST|SGST|UTGST|IGST|CESS)\b/i;
    const ROUNDING = /^\s*ROUND(ED)?\s*OFF\s*$/i;

    // "GST Registration Details of the Party are invalid or not specified".
    // A party with no state has no place of supply, so the supply cannot be
    // classified at all. A party with no GSTIN is legitimately B2C — allowed,
    // but worth saying out loud since it changes which return table it lands in.
    if (!resolved.state) {
      errors.push(`Party "${party.name}" has no state on its ledger master, so Tally cannot determine the place of supply — the voucher would land in GSTR-1 under "GST Registration Details of the Party are invalid or not specified". Set the state in Tally, or declare placeOfSupply on the voucher if this ledger cannot carry one (as the shared Cash ledger cannot).`);
    }
    if (!party.gstin) {
      warnings.push(`Party "${party.name}" has no GSTIN, so this files as an unregistered (B2C) supply rather than B2B.`);
    }

    // Ship-to = bill-to, and the e-way bill / e-invoice read it (owner,
    // 23-Sep-2026: an empty ship-to "is giving an error in the e-way bill").
    // voucherPusher fills both from the ledger's mailing details — or, for a
    // walk-in, from what the operator typed — so an empty one here means the
    // SOURCE is empty. A warning, not a refusal: most invoices need no e-way
    // bill, and the fix belongs in the Tally ledger, not in this voucher.
    if (!isInwardSupply(p.voucherType)) {
      const mail = mailingOn(party, p.date);
      const walkIn = !party.gstin && !mail.address.length && !(party.state ?? "").trim();
      const addr = walkIn ? (p.buyerAddress ?? []).filter((l) => l.trim()) : mail.address;
      if (!addr.length) {
        warnings.push(walkIn
          ? `No address typed for this walk-in, so the invoice's bill-to and ship-to are blank — an e-way bill for it will be refused.`
          : `Ledger "${party.name}" has no mailing address in Tally, so the invoice's bill-to and ship-to are blank — an e-way bill or e-invoice for it will be refused. Add the address to the ledger in Tally.`);
      } else if (!walkIn && !(mail.pincode ?? "").trim()) {
        warnings.push(`Ledger "${party.name}" has no pincode in Tally, so the ship-to has none — an e-way bill or e-invoice for it will be refused. Add the pincode to the ledger in Tally.`);
      }
    }

    // "Mismatch between Expected Tax Amount and Modified Tax Amount".
    // Any line that is neither the party, nor a tax head, nor rounding, shifts
    // what the invoice is worth. Unless it declares that it appropriates to GST,
    // Tally leaves it out of the assessable value, computes expected tax on the
    // gross stock amount, and disagrees with the tax actually booked.
    for (const e of p.ledgerEntries ?? []) {
      if (e.isPartyLedger) continue;
      if (TAX_HEAD.test(e.ledgerName) || ROUNDING.test(e.ledgerName)) continue;
      if (!e.appropriateToGst) {
        errors.push(`"${e.ledgerName}" changes the invoice value but does not appropriate to GST, so Tally will compute expected tax on the gross and file this under GSTR-1's "Mismatch between Expected Tax Amount and Modified Tax Amount". Set appropriateToGst: "Goods" on that line.`);
      }
    }

    // "Tax Rate is not specified". An item whose master carries no rate and
    // whose group does not supply one leaves Tally with nothing to compute on.
    // `gstRate` is 0 both when genuinely unset and when inherited from the
    // group, so this can only ever be a warning — an error here would block
    // legitimate vouchers for every group-rated item.
    // Resolve through the real chain — item, then stock group, then nothing.
    // Only 36 of 489 items declare a rate; 453 inherit, so reading the item's
    // own field alone reports almost the whole catalogue as unrated.
    const unrated = (p.inventoryEntries ?? [])
      .filter(ie => gstRateFor(m, ie.stockItemName).rate === 0)
      .map(ie => ie.stockItemName);
    if (unrated.length) {
      warnings.push(`No GST rate on the item master for ${unrated.slice(0, 3).map(n => `"${n}"`).join(", ")}${unrated.length > 3 ? ` and ${unrated.length - 3} more` : ""} — Tally will fall back to the stock group. If the group has none either, the voucher files under "Tax Rate is not specified".`);
    }

    // A registered party buying taxable goods with no tax line at all is either
    // an exempt supply that should say so, or a missing tax head.
    const hasTaxLine = (p.ledgerEntries ?? []).some(e => TAX_HEAD.test(e.ledgerName));
    if (party.gstin && !hasTaxLine) {
      warnings.push(`No CGST/SGST/IGST line on an invoice to a registered party — correct only if this supply is genuinely exempt or nil-rated.`);
    }
  }

  // ── A bank ledger with no instrument detail makes Tally prompt on every
  //    entry — 1,275 of the company's real vouchers carry one. ───────────────
  if (PARTY_OVERWRITTEN.has(p.voucherType)) {
    for (const e of p.ledgerEntries ?? []) {
      const led = findLedger(m, e.ledgerName);
      if (!isMiss(led) && /BANK/i.test(led.parent) && !e.bankAllocation) {
        warnings.push(`"${e.ledgerName}" is a bank ledger with no instrument detail — Tally will open the Bank Allocation prompt for this voucher.`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
