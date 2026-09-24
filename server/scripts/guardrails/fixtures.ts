/**
 * Masters and payloads for the static guardrail checks — no Tally needed.
 *
 * Shaped on the real company (names, spacing, dated revisions, the placeholder
 * 0% block most items carry) so a check that passes here is checking the thing
 * the books actually contain. Values come from the vault notes and the live
 * mirror on 23-Sep-2026, never invented to make a check pass:
 *   · BICYCLE PARTS groups: 12% from 2017, 12% from 2022, 5% from 22-Sep-2025
 *   · items carry their OWN GST block at rate 0 (placeholder) — the real rate is
 *     on the group (the 0718..0723 incident)
 *   · `SALES  ( GST W.B. )` has TWO spaces, `PURCHASE ( GST W.B. )` one
 *   · 26-27/0719's four real lines and amounts
 */
import type { TallyMasters, MasterItem, MasterStockGroup, MasterLedger, GstRevision, LedgerRegistration } from "../../src/services/tallyMasters.js";
import type { VoucherPayload, LedgerEntry, InventoryEntry } from "../../src/types.js";
import type { OpenBill } from "../../src/services/billSettlement.js";

export const COMPANY = "M.K.CYCLES (P) LTD. - (from 1-Apr-26)";

const rev = (from: string, igst: number): GstRevision => ({ from, rate: igst, cgst: igst / 2, sgst: igst / 2, igst, taxability: "Taxable" });
const BIKE_REVS = [rev("2017-07-01", 12), rev("2022-04-01", 12), rev("2025-09-22", 5)];

const group = (name: string, revisions: GstRevision[], hsn = "", parent = ""): MasterStockGroup => {
  const now = revisions[revisions.length - 1];
  return { name, parent, gstRate: now?.rate ?? 0, cgstRate: now?.cgst ?? 0, sgstRate: now?.sgst ?? 0, igstRate: now?.igst ?? 0, gstRevisions: revisions,
    // The HSN in the group's own name, declared the way Tally stores it (HSNDETAILS, "Specify Details Here").
    hsnRevisions: hsn ? [{ from: "2017-07-01", code: hsn, description: name }] : [] } as MasterStockGroup;
};
const item = (name: string, parent: string, own: GstRevision[] = [rev("2022-04-01", 0)], baseUnit = "PC"): MasterItem =>
  ({ name, parent, baseUnit, denominator: 1, closingRate: 0, closingStock: 0, gstRate: 0, cgstRate: 0, sgstRate: 0, igstRate: 0,
     gstRevisions: own, gstRateSource: "As per Company/Stock Group" } as unknown as MasterItem);
const reg = (applicableFrom: string, gstin: string, registrationType: string, state: string): LedgerRegistration =>
  ({ applicableFrom, gstin, registrationType, placeOfSupply: state, state } as LedgerRegistration);
const ledger = (name: string, parent: string, o: Partial<MasterLedger> = {}): MasterLedger =>
  ({ name, parent, gstin: "", state: "", pincode: "", mailingName: "", address: [], registrations: [], ...o } as MasterLedger);

export const G_PARTS = "BICYCLE PARTS ( 87149990 )";
export const G_TRIKE = "TRICYCLE KARNI ( 950300 )";
export const G_EV = "EV GOODS";
export const SALES_WB = "SALES  ( GST W.B. )";
export const SALES_CENTRAL = "SALES  ( GST CENTRAL )";
export const PURCHASE_CENTRAL = "PURCHASE ( GST CENTRAL )";
export const DISCOUNT = "TRADE DISCOUNTS / H.C.";

export const PARTY_LOCAL = "RANI CYCLE STORES ( BHANGAR )";
export const PARTY_INTER = "DIBYASAKTI CYCLE STORE (JALESWAR)";
export const PARTY_UNREG = "TAPAS CYCLE (RANAGHAT)";
export const PARTY_LATE_REG = "LATE REG CYCLE (BARASAT)";
export const SUPPLIER = "ACCURATE BYCYCLE PARTS";
/** Several cash orders billed together for packing convenience, a different
 *  buyer every time (owner, 24-Sep-2026). Live, 24-Sep-2026: its ledger carries
 *  a state (unlike Cash) but no address and no pincode. */
export const PARTY_MIXED_ORDER = "MIXED ORDER";

export function fixtureMasters(): TallyMasters {
  const ledgers: MasterLedger[] = [
    ledger("Cash", "Cash-in-Hand"),
    ledger(PARTY_MIXED_ORDER, "Sundry Debtors (EG)", { state: "West Bengal" }),
    ledger(PARTY_LOCAL, "Sundry Debtors", { gstin: "19AAAAR0000R1ZJ", state: "West Bengal", pincode: "743502", mailingName: "RANI CYCLE STORES",
      address: ["BHANGAR-743502"], registrations: [reg("20170701", "19AAAAR0000R1ZJ", "Regular", "West Bengal")] }),
    ledger(PARTY_INTER, "Sundry Debtors", { gstin: "21AAAAD0000D1Z5", state: "Odisha", pincode: "756032", mailingName: "DIBYASAKTI CYCLE STORE",
      address: ["JALESWAR", "BALASORE"], registrations: [reg("20170701", "21AAAAD0000D1Z5", "Regular", "Odisha")] }),
    // An unregistered party ledger, as TallyPrime 7 stores it.
    ledger(PARTY_UNREG, "Sundry Debtors", { state: "West Bengal", pincode: "741201", mailingName: "TAPAS CYCLE", address: ["RANAGHAT"],
      registrations: [reg("20170701", "", "Unregistered/Consumer", "West Bengal")] }),
    // Registered mid-way: a 2024 block with no GSTIN, a 2025 block with one (vault §2.3).
    ledger(PARTY_LATE_REG, "Sundry Debtors", { gstin: "19AAAAL1234A1ZA", state: "West Bengal", pincode: "700124", mailingName: "LATE REG CYCLE",
      address: ["BARASAT"], registrations: [reg("20240401", "", "Unregistered/Consumer", "West Bengal"), reg("20250601", "19AAAAL1234A1ZA", "Regular", "West Bengal")] }),
    ledger(SUPPLIER, "Sundry Creditors", { gstin: "03AAAFA1234B1ZM", state: "Punjab", pincode: "141003", mailingName: "ACCURATE BYCYCLE PARTS",
      address: ["GILL ROAD", "LUDHIANA-141003"], registrations: [reg("20170701", "03AAAFA1234B1ZM", "Regular", "Punjab")] }),
    ledger(SALES_WB, "Sales Accounts"), ledger(SALES_CENTRAL, "Sales Accounts"),
    ledger("PURCHASE ( GST W.B. )", "Purchase Accounts"), ledger(PURCHASE_CENTRAL, "Purchase Accounts"),
    ledger("OUTPUT CGST", "Duties & Taxes"), ledger("OUTPUT SGST", "Duties & Taxes"), ledger("OUTPUT IGST", "Duties & Taxes"),
    ledger("INPUT CGST", "Duties & Taxes"), ledger("INPUT SGST", "Duties & Taxes"), ledger("INPUT IGST", "Duties & Taxes"),
    ledger("ROUNDED OFF", "Indirect Expenses"), ledger(DISCOUNT, "Indirect Expenses"),
    ledger("STATE BANK OF INDIA", "Bank Accounts"),
  ];
  // GSTINs carry real check digits (the guard refuses a checksum failure, as the web does).
  const groups = [group(G_PARTS, BIKE_REVS, "87149990"), group(G_TRIKE, BIKE_REVS, "950300"), group(G_EV, [])];
  const items = [
    item("BICYCLE BASKET EHD", G_PARTS), item("BRAKE SHOE  ( POWER )", G_PARTS), item("CARRIER CLIP", G_PARTS),
    item("BABY TRICYCLE MUGHAL DLX RACER BB MSC AMPHA", G_TRIKE),
    item("HORN X", G_PARTS, [rev("2022-07-18", 18)]),                 // declares its own 18%
    item("EV THING", G_EV, []),                                        // nothing in its chain declares a rate
    item("B.B. AXLE & CUP BHOGAL PT", G_PARTS),                        // & in a name
    item('PLIER BOX JT. 10" ( 50 PCS )', G_PARTS),                     // inch mark in a name
  ];
  // Same key as tallyMasters' looseKey — a near-miss must find its suggestion.
  const lower = (s: string) => s.replace(/\s+/g, " ").trim().toUpperCase();
  return {
    company: COMPANY, loadedAt: Date.now(),
    ledgers: new Map(ledgers.map((l) => [l.name, l])),
    items: new Map(items.map((i) => [i.name, i])),
    stockGroups: new Map(groups.map((g) => [g.name, g])),
    godowns: new Set(["Main Location"]), units: new Set(["PC"]),
    voucherTypes: new Set(["SALES", "Purchase", "Payment", "Receipt", "Contra", "Journal", "Credit Note", "Debit Note", "Sales Order Note", "Receipt Note"]),
    ledgerLoose: new Map(ledgers.map((l) => [lower(l.name), l.name])),
    itemLoose: new Map(items.map((i) => [lower(i.name), i.name])),
  } as unknown as TallyMasters;
}

/** Open bills as billSettlement.loadOpenBills returns them. 26-27/0460 is open
 *  for the local party; TI/26-27/34 is open for the SUPPLIER, not for it. */
export function fixtureOpenBills(): OpenBill[] {
  return [
    { name: "26-27/0460", party: PARTY_LOCAL, date: "20260901", closing: -5000, outstanding: 5000, creditPeriod: "20 Days" },
    { name: "TI/26-27/34", party: SUPPLIER, date: "20260810", closing: 12000, outstanding: 12000, creditPeriod: "" },
  ];
}

// ── Payload builders ─────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100;
export const stock = (name: string, amount: number, salesLedger = SALES_WB, dr = false): InventoryEntry =>
  ({ stockItemName: name, quantity: 1, unit: "PC", rate: amount, amount, isDeemedPositive: dr, salesLedgerName: salesLedger,
     godownName: "Main Location", batchName: "Primary Batch" });

/**
 * An outward sale with the arithmetic done the way the web app does it:
 * tax per line on the post-discount value, CGST=SGST halves, round to the rupee
 * with a CREDIT round-off line.
 */
export function sale(o: {
  number: string; date?: string; party: string; lines: { item: string; amount: number; rate: number }[];
  inter?: boolean; discount?: number; placeOfSupply?: string; buyerName?: string; buyerAddress?: string[];
  remoteId?: string | null; action?: VoucherPayload["action"];
}): VoucherPayload {
  const date = o.date ?? "2026-09-23";
  const salesLedger = o.inter ? SALES_CENTRAL : SALES_WB;
  const gross = o.lines.reduce((s, l) => s + l.amount, 0);
  const disc = o.discount ?? 0;
  let half = 0, full = 0;
  for (const l of o.lines) { const post = l.amount - disc * (l.amount / gross); half += post * l.rate / 200; full += post * l.rate / 100; }
  const cgst = o.inter ? 0 : r2(half), igst = o.inter ? r2(full) : 0;
  const exact = r2(gross - disc + (o.inter ? igst : cgst * 2));
  const grand = Math.round(exact), roundOff = r2(grand - exact);
  const L: LedgerEntry[] = [{ ledgerName: o.party, amount: grand, isDeemedPositive: true, isPartyLedger: true }];
  if (disc) L.push({ ledgerName: DISCOUNT, amount: disc, isDeemedPositive: false, isPartyLedger: false, signedAmount: -disc, appropriateToGst: "Goods" });
  if (o.inter) L.push({ ledgerName: "OUTPUT IGST", amount: igst, isDeemedPositive: false, isPartyLedger: false });
  else L.push({ ledgerName: "OUTPUT CGST", amount: cgst, isDeemedPositive: false, isPartyLedger: false },
              { ledgerName: "OUTPUT SGST", amount: cgst, isDeemedPositive: false, isPartyLedger: false });
  if (roundOff) L.push({ ledgerName: "ROUNDED OFF", amount: Math.abs(roundOff), isDeemedPositive: false, isPartyLedger: false, signedAmount: roundOff });
  return {
    voucherType: "Sales", date, voucherNumber: o.number, isInvoice: true, action: o.action,
    remoteId: o.remoteId === null ? undefined : (o.remoteId ?? `MKCP|GUARD|Sales|${o.number}`),
    partyLedgerName: o.party, placeOfSupply: o.placeOfSupply, buyerName: o.buyerName, buyerAddress: o.buyerAddress,
    ledgerEntries: L, inventoryEntries: o.lines.map((l) => stock(l.item, l.amount, salesLedger)),
  } as VoucherPayload;
}

/** Interstate purchase: stock Dr, IGST Dr, supplier Cr, debit round-off. */
export function purchase(number: string, lines: { item: string; amount: number; rate: number }[], date = "2026-09-23"): VoucherPayload {
  const goods = lines.reduce((s, l) => s + l.amount, 0);
  const igst = r2(lines.reduce((s, l) => s + l.amount * l.rate / 100, 0));
  const exact = r2(goods + igst), grand = Math.round(exact), ro = r2(grand - exact);
  const L: LedgerEntry[] = [
    { ledgerName: SUPPLIER, amount: grand, isDeemedPositive: false, isPartyLedger: true },
    { ledgerName: "INPUT IGST", amount: igst, isDeemedPositive: true, isPartyLedger: false },
  ];
  if (ro) L.push({ ledgerName: "ROUNDED OFF", amount: Math.abs(ro), isDeemedPositive: true, isPartyLedger: false, signedAmount: -ro });
  return {
    voucherType: "Purchase", date, voucherNumber: number, isInvoice: true, remoteId: `MKCP|GUARD|Purchase|${number}`,
    reference: `SUP/${number}`, referenceDate: date, partyLedgerName: SUPPLIER,
    ledgerEntries: L, inventoryEntries: lines.map((l) => stock(l.item, l.amount, PURCHASE_CENTRAL, true)),
  } as VoucherPayload;
}

export function receipt(number: string, party: string, amount: number, billType: "On Account" | "Agst Ref" = "On Account", billName = ""): VoucherPayload {
  return {
    voucherType: "Receipt", date: "2026-09-23", voucherNumber: number, isInvoice: false, remoteId: `MKCP|GUARD|Receipt|${number}`,
    partyLedgerName: party,
    ledgerEntries: [
      { ledgerName: "Cash", amount, isDeemedPositive: true, isPartyLedger: false },
      { ledgerName: party, amount, isDeemedPositive: false, isPartyLedger: true,
        billAllocations: [{ name: billName || `GUARD/${number}`, billType, amount }] },
    ],
  } as VoucherPayload;
}
