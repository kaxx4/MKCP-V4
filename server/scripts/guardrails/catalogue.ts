/**
 * The Tally guardrail catalogue — one ID per rule, shared by every mode.
 *
 * The long form (why, source note, where enforced) lives in the vault:
 *   07_Systems/Contracts/Tally Guardrails — Push and Pull.md
 * Keep the IDs and titles here identical to that note. A rule added in one and
 * not the other is exactly the kind of second definition G1 forbids.
 *
 * Severity:
 *   critical — a voucher that files wrong / breaks GST / e-way / e-invoice, or
 *              writes to the wrong books. Never ship with one red.
 *   high     — silent corruption of the books or the mirror that a person
 *              would eventually notice, at a cost.
 *   medium   — a hazard with a working backstop (read-back, human step).
 */
export type Severity = "critical" | "high" | "medium";
export type Area = "push" | "pull";

export interface Guardrail {
  id: string;
  area: Area;
  severity: Severity;
  title: string;
}

export const CATALOGUE: Guardrail[] = [
  // ── Push: identity ───────────────────────────────────────────────────────
  { id: "TG-P01", area: "push", severity: "critical", title: "Every Create carries a caller-assigned REMOTEID; a Create without one is refused" },
  { id: "TG-P02", area: "push", severity: "critical", title: "Alter / Cancel / Delete are refused without a REMOTEID" },
  { id: "TG-P03", area: "push", severity: "high", title: "Every numbered voucher carries a VOUCHERNUMBER (Tally does not auto-number an import)" },
  { id: "TG-P04", area: "push", severity: "critical", title: "Cancel is ACTION=\"Cancel\", never an ISCANCELLED flag" },
  { id: "TG-P05", area: "push", severity: "critical", title: "Nothing changes a filed GST period: Alter/Cancel/Delete AND backdated Creates are refused at or before MKCP_FILED_THROUGH" },
  // ── Push: party GST identity / e-way / e-invoice ─────────────────────────
  { id: "TG-P06", area: "push", severity: "critical", title: "Invoice-shaped vouchers carry the party GST identity block (reg type, GSTIN, state, place of supply, country, mailing name)" },
  { id: "TG-P07", area: "push", severity: "medium", title: "Money vouchers (Payment/Receipt/Contra/Journal) carry NO GST identity block" },
  { id: "TG-P08", area: "push", severity: "critical", title: "GSTREGISTRATIONTYPE uses Tally's own word — \"Unregistered/Consumer\", never bare \"Unregistered\"" },
  { id: "TG-P09", area: "push", severity: "critical", title: "Ship-to = bill-to: consignee name, state, country, GSTIN, pincode and address all present and equal to the party's" },
  { id: "TG-P10", area: "push", severity: "critical", title: "Place of supply = party's state outward, OUR state inward; STATENAME = counterparty's state" },
  { id: "TG-P11", area: "push", severity: "critical", title: "Tax head follows the state: interstate IGST + CENTRAL accounts, local CGST+SGST + W.B. accounts" },
  { id: "TG-P12", area: "push", severity: "critical", title: "Cash walk-in is local; a payload-declared place of supply is validated and refused on inward vouchers" },
  // ── Push: line GST ───────────────────────────────────────────────────────
  { id: "TG-P13", area: "push", severity: "critical", title: "Every outward stock line names its GST/HSN source master; a line whose rate cannot be resolved is refused" },
  { id: "TG-P14", area: "push", severity: "critical", title: "Rates resolve item → group chain, IGST (combined), newest revision NOT AFTER the voucher date" },
  { id: "TG-P15", area: "push", severity: "critical", title: "Tax ledgers equal Σ rate × post-discount taxable value; CGST = SGST" },
  { id: "TG-P16", area: "push", severity: "high", title: "Inward (purchase) stock lines name a GST source the way native purchases do" },
  // ── Push: invoice arithmetic ─────────────────────────────────────────────
  { id: "TG-P17", area: "push", severity: "high", title: "ROUNDED OFF: side fixed by direction (sales credit), |amount| ≤ ₹0.50, party total whole rupees" },
  { id: "TG-P18", area: "push", severity: "critical", title: "Every value-changing adjustment line appropriates to GST (APPROPRIATEFOR / VATEXPAMOUNT)" },
  { id: "TG-P19", area: "push", severity: "medium", title: "Discount written as the native negative credit and balanced as sent" },
  // ── Push: bills ──────────────────────────────────────────────────────────
  { id: "TG-P20", area: "push", severity: "critical", title: "An Agst Ref names a bill open for THAT party (else Tally silently makes it a New Ref)" },
  { id: "TG-P21", area: "push", severity: "high", title: "Bill allocations sum exactly to their ledger line" },
  // ── Push: structure ──────────────────────────────────────────────────────
  { id: "TG-P22", area: "push", severity: "critical", title: "Ledger, item and godown names resolve EXACTLY against live masters (whitespace-significant)" },
  { id: "TG-P23", area: "push", severity: "high", title: "Stock line unit is the item's own base unit" },
  { id: "TG-P24", area: "push", severity: "high", title: "Invoice structure: LEDGERENTRIES vs ALLLEDGERENTRIES, sales ledger only in the allocation, batch allocation, PERSISTEDVIEW rules" },
  { id: "TG-P25", area: "push", severity: "high", title: "Sign convention (Dr = negative) everywhere and the voucher balances" },
  { id: "TG-P26", area: "push", severity: "critical", title: "The push path requires masters (no silent identity-less build)" },
  { id: "TG-P27", area: "push", severity: "critical", title: "The party registration in force ON THE VOUCHER DATE is used, not today's" },
  { id: "TG-P28", area: "push", severity: "high", title: "Every interpolated value is XML-escaped; the envelope is well-formed" },
  { id: "TG-P29", area: "push", severity: "high", title: "Only configured, automatable voucher types: no Delivery Note; Credit/Debit Notes never automated" },
  { id: "TG-P30", area: "push", severity: "critical", title: "Sandbox never writes shared state; round-trip writes only to a sandbox Tally on localhost" },
  { id: "TG-P31", area: "push", severity: "critical", title: "SVCURRENTCOMPANY is the exact company key" },
  { id: "TG-P32", area: "push", severity: "critical", title: "Tally is the only source of rates/GST/HSN — no hand-kept copy decides a pushed rate" },
  // ── Pull ─────────────────────────────────────────────────────────────────
  { id: "TG-L01", area: "pull", severity: "high", title: "Mirror is complete vs Tally, including backdated days (a full re-read within 48h)" },
  { id: "TG-L02", area: "pull", severity: "medium", title: "Incremental sync is AlterID-driven and its cursor is recorded" },
  { id: "TG-L03", area: "pull", severity: "critical", title: "Prune safety: no phantom rows; sandbox and office cannot collide on the company key" },
  { id: "TG-L04", area: "pull", severity: "high", title: "Mirror sign conventions hold and every mirrored voucher balances" },
  { id: "TG-L05", area: "pull", severity: "critical", title: "Mirrored GST rates are dated (IGST, newest block) and agree with Tally's GST Rate Setup" },
  { id: "TG-L06", area: "pull", severity: "critical", title: "Every stock item sold resolves a GST rate and HSN through the item → group chain" },
  { id: "TG-L07", area: "pull", severity: "medium", title: "Price list mirrored, dated, per price level" },
  { id: "TG-L08", area: "pull", severity: "high", title: "Bills receivable/payable in the mirror agree with Tally's own report" },
  { id: "TG-L09", area: "pull", severity: "critical", title: "GSTR-1 computation parity: booked tax = dated rate × taxable on every mirrored outward invoice" },
  { id: "TG-L10", area: "pull", severity: "critical", title: "GSTR-1 preconditions on every mirrored outward invoice (place of supply, GSTIN, tax head, tax line)" },
  { id: "TG-L11", area: "pull", severity: "high", title: "Adjustment appropriation is visible in the mirror (G7 — asked for by name)" },
  { id: "TG-L12", area: "pull", severity: "high", title: "Totals by type and GST totals: mirror vs Tally's own report" },
  { id: "TG-L13", area: "pull", severity: "critical", title: "E-invoice clock: no B2B invoice nearing the 30-day IRP limit without an IRN" },
  { id: "TG-L14", area: "pull", severity: "high", title: "Mirrored outward vouchers carry their GST/consignee fields (party_gstin, place_of_supply, consignee_state)" },
];

export const byId = new Map(CATALOGUE.map((g) => [g.id, g]));
