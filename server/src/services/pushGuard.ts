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
import { type TallyMasters, type MasterLedger, findLedger, findItem, isMiss, gstRateFor, revisionOn, registrationOn, hsnFor } from "./tallyMasters.js";
import { partyIdentity } from "./voucherPusher.js";
import { sameState, codeForState, stateFromGstin, normalizeGstin, isGstinChecksumValid, isCashLikeParty, PIN_RE, HSN_RE } from "./gstIdentity.js";
import type { OpenBill } from "./billSettlement.js";

export interface GuardResult { ok: boolean; errors: string[]; warnings: string[]; }

/**
 * Facts the guard needs that are not masters. Optional: when absent, the rule
 * that needs them degrades to a WARNING naming what it could not check —
 * never to a silent pass.
 */
export interface GuardContext {
  /** Open bills (billSettlement.loadOpenBills). Needed to check an Agst Ref. */
  openBills?: OpenBill[];
  /**
   * Every voucher number this TYPE already holds in the mirror, for the same
   * financial year as the voucher being pushed — trimmed, upper-cased. Loaded
   * by `safePush` only when the payload carries an explicit `numberOverride`
   * (see there); absent otherwise, including for an ordinary auto-numbered
   * Create, so this never costs a read on the common path.
   */
  existingVoucherNumbers?: Set<string>;
}

/**
 * Voucher types that are numbered in this company and that Tally does NOT
 * auto-number on an XML import (measured 17-Sep-2026, see safePush: a Create
 * with the number omitted came back created=0 exceptions=1). Journal is
 * configured with numbering "None" and is the one exception.
 */
const NUMBERED = new Set(["SALES", "PURCHASE", "SALES ORDER", "SALES ORDER NOTE", "PAYMENT", "RECEIPT", "CONTRA"]);

/**
 * Never automated. Owner, 10-Sep-2026: credit and debit notes are always keyed
 * by hand in Tally. Checked 24-Sep-2026: the web's `buildCreditNote` is called
 * by no page, and push_queue holds no Credit/Debit Note row ever.
 */
const NEVER_AUTOMATED = new Set(["CREDIT NOTE", "DEBIT NOTE"]);

/** Outward voucher types whose tax the guard recomputes (TG-P15). */
const OUTWARD_TAXED = new Set(["SALES", "SALES ORDER", "SALES ORDER NOTE"]);

/**
 * The e-way bill threshold: CGST Rule 138, consignment (goods) value above
 * ₹50,000. Used for a cash walk-in or MIXED ORDER (`isCashLikeParty`), whose
 * ship-to is whatever the operator typed.
 *
 * Owner, 24-Sep-2026, superseding the earlier "optional below the limit"
 * rule: a buyer address is now ALWAYS required on a cash sale, and a cash
 * sale over this figure is refused outright rather than merely needing an
 * e-way bill — this is not just an e-way bill gate any more, the name is kept
 * because it is still the same figure (Rule 138). Hypothesis, not measured:
 * West Bengal's intra-state threshold is taken to equal the Rule 138 figure.
 */
export const EWAY_BILL_THRESHOLD = 50_000;

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

export function guardVoucher(p: VoucherPayload, m: TallyMasters, ctx: GuardContext = {}): GuardResult {
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
  /* A NEW invoice backdated into a filed period changes that return exactly as
     much as an Alter does — it is a supply the filed GSTR-1 does not contain.
     Invoice-shaped vouchers only: a bank receipt entered late against an old
     date moves no GST figure, and bank statements routinely lag. (TG-P05) */
  if (action0 === "Create" && FILED_THROUGH && p.date <= FILED_THROUGH
      && (p.isInvoice || (p.inventoryEntries ?? []).some(e => !!e.salesLedgerName))) {
    if (!p.allowFiledPeriodEdit) {
      errors.push(`Create refused: ${p.voucherType} dated ${p.date} falls in a GST period already filed (through ${FILED_THROUGH}) — a new invoice there is a supply the filed return does not contain. Date it in the open period, or set allowFiledPeriodEdit if the return will be amended.`);
    } else {
      warnings.push(`New ${p.voucherType} dated ${p.date} lands in a FILED period (through ${FILED_THROUGH}) — the return will need amending.`);
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

  if (NEVER_AUTOMATED.has(p.voucherType.trim().toUpperCase())) {
    errors.push(`${p.voucherType} is never automated — the owner keys credit and debit notes into Tally by hand (10-Sep-2026). (TG-P29)`);
  }

  // ── Identity: without a REMOTEID a voucher can only ever be created ───────
  // An Alter on a voucher that has no REMOTEID does NOT fail — Tally performs a
  // Create instead and returns created=1, which reads as success while
  // duplicating real money. Refuse rather than let that happen.
  const action = p.action ?? "Create";
  if (CHANGES_EXISTING.has(action) && !p.remoteId) {
    errors.push(`${action} requires a remoteId — Tally addresses existing vouchers by REMOTEID. Without one it would silently create a duplicate instead of changing anything.`);
  }
  /* G5: every write carries identity from creation. A voucher created without
     a REMOTEID is permanently unreachable — 13 are stuck in the books that way
     and can only be removed by hand. This used to be a warning. (TG-P01) */
  if (action === "Create" && !p.remoteId?.trim()) {
    errors.push("Create refused: no remoteId. A voucher created without one can never be altered, cancelled or deleted from here, and a re-push would duplicate it (G5).");
  }
  // Tally does not auto-number an XML import. (TG-P03)
  if (action === "Create" && NUMBERED.has(p.voucherType.trim().toUpperCase()) && !p.voucherNumber?.trim()) {
    errors.push(`Create refused: ${p.voucherType} has no voucherNumber. Tally does not number a voucher arriving over XML — it answers created=0 exceptions=1 with no reason.`);
  }
  /*
   * A hand-typed OVERRIDE number gets a duplicate check the auto-assigned path
   * does not — an auto-assigned number was just learned from the same mirror a
   * moment ago, so a collision there is already unlikely; a typed one has no
   * such guarantee. `existingVoucherNumbers` is loaded by `safePush` ONLY when
   * `numberOverride` is set (a mirror read on every push was not worth it), so
   * this degrades to a warning rather than a silent pass when it is absent —
   * same rule as `openBills` above.
   */
  if (action === "Create" && p.numberOverride && p.voucherNumber?.trim()) {
    if (ctx.existingVoucherNumbers) {
      const key = p.voucherNumber.trim().toUpperCase();
      if (ctx.existingVoucherNumbers.has(key)) {
        errors.push(`Create refused: the overridden voucher number "${p.voucherNumber}" already exists for ${p.voucherType} in the mirror. Pick a different number — an explicit override is never renumbered automatically.`);
      }
    } else {
      warnings.push(`Overridden voucher number "${p.voucherNumber}" could not be checked against existing ${p.voucherType} numbers — the mirror was not loaded.`);
    }
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
        /* An Agst Ref naming a bill that is not open for THIS party is not an
           error to Tally: it silently rewrites it as a New Ref, reports success,
           and creates a fresh liability (TG-P20). Checked against Tally's own
           open bills. Only on a Create — an Alter re-sends allocations whose
           bill this very voucher may already have closed. */
        if (b.billType === "Agst Ref" && b.name?.trim() && (p.action ?? "Create") === "Create") {
          if (!ctx.openBills) {
            warnings.push(`Agst Ref "${b.name}" on "${e.ledgerName}" could not be checked against open bills before the push — only the read-back will catch Tally rewriting it as a New Ref.`);
          } else if (!ctx.openBills.some(o => o.party === e.ledgerName && o.name === b.name)) {
            const elsewhere = ctx.openBills.find(o => o.name === b.name);
            errors.push(`Agst Ref "${b.name}" is not an open bill of "${e.ledgerName}"${elsewhere ? ` (it is open for "${elsewhere.party}")` : ""}. Tally would silently turn it into a New Ref and book a fresh liability.`);
          }
        }
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
    // Checked on the identity voucherPusher WILL emit (partyIdentity), not on a
    // re-derivation of it, so the guard and the builder cannot disagree. (TG-P09)
    //
    // The rules below MIRROR the web's refusal before enqueue
    // (web-dashboard/src/engine/push/gstIdentity.ts, 24-Sep-2026) as defence in
    // depth: a queued row can come from an old tab, a script or
    // /api/local/push. Same thresholds, same state table (gstIdentity.ts here).
    const act = p.action ?? "Create";
    if (!isInwardSupply(p.voucherType) && act !== "Cancel" && act !== "Delete") {
      const id = partyIdentity(p, m);
      const walkIn = isWalkInLedger(party);
      if (id) {
        const c = id.consignee;
        const missing: string[] = [];
        if (!c.mailingName.trim()) missing.push("name");
        if (!c.state.trim()) missing.push("state");
        if (!c.country.trim()) missing.push("country");
        if (!walkIn && !c.address.length) missing.push("address");
        if (!walkIn && !c.pincode.trim()) missing.push("pincode");
        if (id.gstin && c.gstin !== id.gstin) missing.push(`GSTIN (bill-to ${id.gstin}, ship-to "${c.gstin}")`);
        if (missing.length) {
          errors.push(walkIn
            ? `The walk-in's ship-to has no ${missing.join(", ")}.`
            : `Ledger "${party.name}" gives the ship-to no ${missing.join(", ")} in Tally, so the invoice's ship-to would be incomplete and the e-way bill / e-invoice for it refused. Add it to the ledger in Tally (the ledger is the only source — a typed copy is ignored).`);
        }
        if (!walkIn && c.pincode.trim() && !PIN_RE.test(c.pincode.trim())) {
          errors.push(`The pincode on ledger "${party.name}" ("${c.pincode}") is not a 6-digit Indian pincode — the e-way bill and e-invoice will refuse it.`);
        }
      }
      if (walkIn) {
        // A counter sale (or MIXED ORDER): the buyer is in the shop, so the
        // supply is local.
        if (declared && !sameState(declared, HOME_STATE_NAME)) {
          errors.push(`A cash sale's place of supply is ${HOME_STATE_NAME}, not "${declared}" — the buyer is standing in the shop and the tax is charged as local.`);
        }
        if (!p.buyerName?.trim()) {
          errors.push(`A cash sale needs the buyer's name — it is the bill-to and ship-to on the invoice, and the Cash/MIXED ORDER ledger has neither.`);
        }
        const typed = (p.buyerAddress ?? []).map(l => l.trim()).filter(Boolean);
        const goods = (p.inventoryEntries ?? []).reduce((t, i) => t + Math.abs(i.amount), 0);
        // Owner, 24-Sep-2026: a buyer address is ALWAYS required on a cash
        // sale, not only above the e-way bill limit — reversing the earlier
        // "optional at the counter" rule.
        if (!typed.length) {
          errors.push(`A cash sale needs the buyer's address — it is the ship-to on the invoice; type it on the voucher.`);
        }
        // Owner, 24-Sep-2026: "a cash sale above ₹50,000 is not allowed at
        // all" — not merely needing an e-way bill, refused outright. Basis is
        // goods (consignment) value, the same basis EWAY_BILL_THRESHOLD
        // already used here, per CGST Rule 138.
        if (goods > EWAY_BILL_THRESHOLD) {
          errors.push(`This cash sale is ₹${goods.toFixed(0)} of goods, over the ₹${EWAY_BILL_THRESHOLD} limit for a cash sale. Split it into smaller cash sales, or bill it to the party's own ledger.`);
        }
      } else if (p.buyerName?.trim() || (p.buyerAddress ?? []).some(l => l.trim())) {
        // Bill-to and ship-to both come from the ledger; a typed buyer would
        // be a second consignee (the web refuses it too).
        errors.push(`"${party.name}" is a party ledger, so bill-to and ship-to come from its ledger. The voucher also carries a typed buyer name/address, which would be a second consignee — remove it.`);
      }
    }

    // ── The party's GSTIN and state, as the e-invoice reads them ─────────────
    if (!isWalkInLedger(party) && act !== "Cancel" && act !== "Delete") {
      const g = normalizeGstin(registrationOn(party, p.date).gstin ?? "");
      if (g && !isGstinChecksumValid(g)) {
        errors.push(`The GSTIN on "${party.name}" (${g}) fails its check digit — not a valid GSTIN. Correct it on the ledger in Tally.`);
      } else if (g && resolved.state && codeForState(resolved.state) && codeForState(resolved.state) !== g.slice(0, 2)) {
        errors.push(`"${party.name}" has GSTIN ${g}, issued in ${stateFromGstin(g) ?? `state ${g.slice(0, 2)}`}, but its ledger state is "${resolved.state}". One of them is wrong in Tally, and the tax heads depend on which.`);
      }
      if (resolved.state && !codeForState(resolved.state)) {
        errors.push(`The state on "${party.name}" ("${resolved.state}") is not a GST state name — pick it from Tally's state list.`);
      }
    } else if (isWalkInLedger(party) && isInwardSupply(p.voucherType)) {
      errors.push(`A ${p.voucherType} cannot be booked against the cash ledger — the supplier's own ledger carries the GSTIN and state.`);
    }

    // ── HSN on every outward stock line — the e-invoice rejects a line
    //    without one, and GSTR-1's HSN summary is built from it. ──────────────
    if (!isInwardSupply(p.voucherType) && act !== "Cancel" && act !== "Delete") {
      for (const ie of p.inventoryEntries ?? []) {
        const h = hsnFor(m, ie.stockItemName, p.date).code.trim();
        if (!h) errors.push(`"${ie.stockItemName}" has no HSN in Tally (not on the item, not on its stock group) — the e-invoice rejects a line without one. Set it in Tally.`);
        else if (!HSN_RE.test(h)) errors.push(`The HSN on "${ie.stockItemName}" ("${h}") is not 4, 6 or 8 digits.`);
      }
    }

    // ── OUTPUT tax on a sale, INPUT tax on a purchase — never crossed. ───────
    for (const e of p.ledgerEntries ?? []) {
      if (!TAX_HEAD.test(e.ledgerName)) continue;
      if (isInwardSupply(p.voucherType) && /\bOUTPUT\b/i.test(e.ledgerName)) errors.push(`"${e.ledgerName}" is an OUTPUT tax ledger on a ${p.voucherType} — inward tax goes to the INPUT ledgers (it is input credit, not tax collected).`);
      if (!isInwardSupply(p.voucherType) && /\bINPUT\b/i.test(e.ledgerName)) errors.push(`"${e.ledgerName}" is an INPUT tax ledger on a ${p.voucherType} — outward tax goes to the OUTPUT ledgers.`);
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

    // "Tax Rate is not specified". Resolved through Tally's own chain — item,
    // then stock group — AS AT THE VOUCHER DATE. Only 36 of 489 items declare a
    // rate; 453 inherit. On an OUTWARD voucher a line nothing resolves for is
    // refused (TG-P13): the builder would send it with no GST source and Tally
    // files it under "Tax rate/tax type not specified" (26-27/0718..0723). An
    // item whose own block in force says Exempt / Nil Rated is a real 0%.
    const outwardTaxed = OUTWARD_TAXED.has(p.voucherType.trim().toUpperCase());
    const unrated = (p.inventoryEntries ?? [])
      .filter(ie => gstRateFor(m, ie.stockItemName, p.date).rate === 0 && !declaredExempt(m, ie.stockItemName, p.date))
      .map(ie => ie.stockItemName);
    if (unrated.length) {
      const names = `${unrated.slice(0, 3).map(n => `"${n}"`).join(", ")}${unrated.length > 3 ? ` and ${unrated.length - 3} more` : ""}`;
      if (outwardTaxed) {
        errors.push(`No GST rate resolves on ${p.date} for ${names} — neither the item nor any stock group above it declares one. Tally would file the line under "Tax rate/tax type not specified". Set the rate on the item or its group in Tally.`);
      } else {
        warnings.push(`No GST rate resolves on ${p.date} for ${names} in the item → group chain.`);
      }
    }

    // Tax booked must equal the dated rate × the taxable value (TG-P15). The
    // voucher can balance and read back byte-identical with the wrong tax.
    if (outwardTaxed && !unrated.length) {
      const t = taxCheck(p, m);
      if (t.booked < t.lo - t.tol || t.booked > t.hi + t.tol) {
        errors.push(`Tax booked ₹${t.booked.toFixed(2)} but the dated rates × taxable value give ₹${t.lo.toFixed(2)}${t.hi - t.lo > 0.005 ? `–₹${t.hi.toFixed(2)}` : ""} (taxable ₹${t.taxable.toFixed(2)}). The voucher balances and would file wrong.`);
      }
      if (t.cgst > 0 || t.sgst > 0) {
        if (Math.abs(t.cgst - t.sgst) > 0.02) errors.push(`CGST ₹${t.cgst.toFixed(2)} ≠ SGST ₹${t.sgst.toFixed(2)} — a local supply splits its tax in equal halves.`);
      }
    }

    // A registered party buying taxable goods with no tax line at all is either
    // an exempt supply that should say so, or a missing tax head.
    const hasTaxLine = (p.ledgerEntries ?? []).some(e => TAX_HEAD.test(e.ledgerName));
    if (party.gstin && !hasTaxLine) {
      warnings.push(`No CGST/SGST/IGST line on an invoice to a registered party — correct only if this supply is genuinely exempt or nil-rated.`);
    }
  }

  // ── ROUNDED OFF (TG-P17): at most 50 paise, and on the side the books use —
  //    a credit on every sale (664 of 664 hand-typed sales round-offs), a debit
  //    on a purchase (web purchasePayload; native purchases). The sign rides on
  //    the amount, never on the side. ──────────────────────────────────────────
  for (const e of p.ledgerEntries ?? []) {
    if (!/^\s*ROUND(ED)?\s*OFF\s*$/i.test(e.ledgerName)) continue;
    const v = e.signedAmount !== undefined ? Math.abs(e.signedAmount) : Math.abs(e.amount);
    if (v > 0.5 + 1e-9) errors.push(`ROUNDED OFF of ${money(v)} — rounding to the rupee is never more than ₹0.50; a larger figure is an arithmetic error hidden in the rounding line.`);
    const vt = p.voucherType.trim().toUpperCase();
    if (OUTWARD_TAXED.has(vt) && e.isDeemedPositive) errors.push(`ROUNDED OFF on a ${p.voucherType} must sit on the CREDIT side (isDeemedPositive=false), with its sign on the amount — every hand-typed sale does.`);
    if (vt === "PURCHASE" && !e.isDeemedPositive) errors.push(`ROUNDED OFF on a Purchase must sit on the DEBIT side (isDeemedPositive=true), with its sign on the amount.`);
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

/** An item whose OWN block in force declares it Exempt / Nil Rated is a real 0%. */
function declaredExempt(m: TallyMasters, itemName: string, asOf: string): boolean {
  const item = m.items.get(itemName);
  const own = item ? revisionOn(item.gstRevisions ?? [], asOf) : undefined;
  return !!own && /exempt|nil/i.test(own.taxability ?? "");
}

/**
 * Tax the voucher SHOULD carry, from Tally's dated rates, vs what it books.
 *
 * Taxable = stock lines + every adjustment that appropriates to GST (a trade
 * discount reduces it, a handling charge raises it). The adjustment is spread
 * over the lines, and the web app spreads a per-item discount by item — so
 * the expected tax is a RANGE: the adjustment taxed at the lowest and at the
 * highest rate on the voucher. Tolerance: ₹1, or 2 paise per line for rounding.
 */
export function taxCheck(p: VoucherPayload, m: TallyMasters): {
  booked: number; lo: number; hi: number; tol: number; taxable: number; cgst: number; sgst: number;
} {
  const TAX = /\b(CGST|SGST|UTGST|IGST|CESS)\b/i;
  const ROUND = /^\s*ROUND(ED)?\s*OFF\s*$/i;
  const cr = (e: { amount: number; isDeemedPositive: boolean; signedAmount?: number }) =>
    e.signedAmount !== undefined ? e.signedAmount : (e.isDeemedPositive ? -Math.abs(e.amount) : Math.abs(e.amount));
  let base = 0; const rates: number[] = [];
  let stockTotal = 0;
  for (const ie of p.inventoryEntries ?? []) {
    const r = gstRateFor(m, ie.stockItemName, p.date).rate;
    rates.push(r);
    base += Math.abs(ie.amount) * r / 100;
    stockTotal += Math.abs(ie.amount);
  }
  let adj = 0, booked = 0, cgst = 0, sgst = 0;
  for (const e of p.ledgerEntries ?? []) {
    if (e.isPartyLedger || ROUND.test(e.ledgerName)) continue;
    if (TAX.test(e.ledgerName)) {
      const v = cr(e); booked += v;
      if (/\bCGST\b/i.test(e.ledgerName)) cgst += v;
      if (/\b(SGST|UTGST)\b/i.test(e.ledgerName)) sgst += v;
    } else if (e.appropriateToGst) adj += cr(e);
  }
  const minR = rates.length ? Math.min(...rates) : 0, maxR = rates.length ? Math.max(...rates) : 0;
  const a = base + adj * minR / 100, b = base + adj * maxR / 100;
  return { booked, lo: Math.min(a, b), hi: Math.max(a, b), tol: Math.max(1, 0.02 * rates.length), taxable: stockTotal + adj, cgst, sgst };
}

/** The shared walk-in ledger — the same test as the web's `isWalkIn`:
 *  named Cash or MIXED ORDER (`isCashLikeParty`), or under a cash group. */
export function isWalkInLedger(l: Pick<MasterLedger, "name" | "parent">): boolean {
  return isCashLikeParty(l.name) || /cash/i.test(l.parent ?? "");
}
