/**
 * Shared machinery for the guardrail runner: the result ledger, and the
 * voucher-shape checks that run identically over XML we BUILT (static mode),
 * XML Tally STORED (sandbox mode) and Tally reads (pull mode).
 *
 * One checker, three inputs, on purpose: a check written twice drifts, and the
 * harness then disagrees with itself about the same voucher (G1).
 */
import { CATALOGUE, byId } from "./catalogue.js";
import type { TallyMasters } from "../../src/services/tallyMasters.js";
import { gstRateFor, registrationOn, findLedger, isMiss } from "../../src/services/tallyMasters.js";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

// ── Result ledger ────────────────────────────────────────────────────────────

export type Status = "PASS" | "FAIL" | "UNVERIFIED";
interface Entry { pass: number; fail: string[]; unverified: string[] }
const results = new Map<string, Entry>();

function entry(id: string): Entry {
  if (!byId.has(id)) throw new Error(`Unknown guardrail id ${id} — add it to catalogue.ts first.`);
  let e = results.get(id);
  if (!e) { e = { pass: 0, fail: [], unverified: [] }; results.set(id, e); }
  return e;
}

/** Record one observation against a guardrail. `detail` is what failed, in words. */
export function check(id: string, ok: boolean, detail: string): void {
  const e = entry(id);
  if (ok) e.pass++; else e.fail.push(detail);
}
/** Could not be decided in this mode — never counted as a pass (step 4 of the method: "not visible" is not a pass). */
export function unverified(id: string, detail: string): void { entry(id).unverified.push(detail); }

export function report(mode: string): number {
  let fails = 0;
  console.log(`\n══ Guardrails — ${mode} ═════════════════════════════════════════`);
  for (const g of CATALOGUE) {
    const e = results.get(g.id);
    if (!e) continue;
    const status: Status = e.fail.length ? "FAIL" : e.pass ? "PASS" : "UNVERIFIED";
    if (status === "FAIL") fails++;
    console.log(`${status.padEnd(10)} ${g.id}  [${g.severity}] ${g.title}  (${e.pass} ok${e.fail.length ? `, ${e.fail.length} failed` : ""}${e.unverified.length ? `, ${e.unverified.length} unverified` : ""})`);
    const seen = new Set<string>();
    const cap = process.env.GUARD_VERBOSE ? 1e9 : 6;
    for (const f of e.fail) { if (seen.has(f)) continue; seen.add(f); if (seen.size > cap) { console.log(`             … ${e.fail.length - cap} more (GUARD_VERBOSE=1 for all)`); break; } console.log(`             ✗ ${f}`); }
    if (status !== "FAIL") for (const u of [...new Set(e.unverified)].slice(0, 3)) console.log(`             ? ${u}`);
  }
  const ran = [...results.keys()];
  const failedIds = CATALOGUE.filter((g) => results.get(g.id)?.fail.length).map((g) => g.id);
  console.log(`\n${ran.length} guardrails exercised, ${failedIds.length} FAIL${failedIds.length ? `: ${failedIds.join(" ")}` : ""}`);
  return fails;
}

export function resetResults(): void { results.clear(); }

// ── XML reading ──────────────────────────────────────────────────────────────

export const unesc = (s: string) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, "&")
  .replace(/[\x00-\x08]/g, "").trim();

const tagRe = (t: string) => new RegExp(`<${t.replace(/\./g, "\\.")}(?:\\s[^>]*)?>([^<]*)</${t.replace(/\./g, "\\.")}>`, "i");
export const tag = (xml: string, t: string): string => { const m = tagRe(t).exec(xml); return m ? unesc(m[1]) : ""; };
export const tags = (xml: string, t: string): string[] =>
  [...xml.matchAll(new RegExp(tagRe(t).source, "gi"))].map((m) => unesc(m[1])).filter(Boolean);
export const has = (xml: string, t: string): boolean => new RegExp(`<${t.replace(/\./g, "\\.")}[\\s>/]`, "i").test(xml);

/** Blocks of one list type, placeholders (no populated tag) dropped. */
export function lists(xml: string, t: string): string[] {
  const n = t.replace(/\./g, "\\.");
  return [...xml.matchAll(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, "g"))]
    .map((m) => m[1]).filter((x) => /<[A-Z0-9_.]+(?:\s[^>]*)?>[^<\s]/.test(x));
}

/** The voucher header with every nested .LIST removed, so a tag read is the voucher's own. */
export function headerOf(voucherXml: string): string {
  let s = voucherXml.replace(/<([A-Z0-9_.]+\.LIST)(?:\s[^>]*)?\/>/g, "");
  for (let i = 0; i < 20; i++) {
    const next = s.replace(/<([A-Z0-9_.]+\.LIST)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, "");
    if (next === s) break;
    s = next;
  }
  return s;
}

export const lead = (s: string) => { const m = /^\s*(-?[\d.]+)/.exec((s ?? "").replace(/,/g, "")); return m ? parseFloat(m[1]) : NaN; };

// ── A voucher, as the checks see it ─────────────────────────────────────────

export interface Line { ledger: string; amount: number; dr: boolean; appropriate: string; vatExp: string }
export interface StockLine {
  item: string; amount: number; dr: boolean; unit: string;
  gstSourceType: string; gstSource: string; hsnSourceType: string; taxability: string; rateInfer: string;
  salesLedger: string; hasBatch: boolean;
}
export interface Voucher {
  origin: "sent" | "stored";
  type: string; number: string; date: string; action: string; remoteId: string;
  party: string; isInvoice: boolean;
  h: (t: string) => string;
  address: string[]; consigneeAddress: string[];
  ledgers: Line[]; stock: StockLine[];
  raw: string;
}

const isoOf = (d: string) => /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;

/**
 * Parse one <VOUCHER> block.
 *
 * `sent` reads LEDGERENTRIES (invoice) / ALLLEDGERENTRIES (accounting) — what we
 * emit. `stored` reads ALLLEDGERENTRIES ONLY: a read-back carries the same money
 * three ways and only that list balances (tally-voucher-gst-shape).
 */
export function parseVoucher(xml: string, origin: "sent" | "stored"): Voucher {
  const open = /<VOUCHER\b([^>]*)>/.exec(xml)?.[1] ?? "";
  const attr = (a: string) => unesc(new RegExp(`\\b${a}="([^"]*)"`).exec(open)?.[1] ?? "");
  const header = headerOf(xml);
  const h = (t: string) => tag(header, t);
  const ledgerBlocks = origin === "stored"
    ? lists(xml, "ALLLEDGERENTRIES.LIST")
    : [...lists(xml, "LEDGERENTRIES.LIST").filter((b) => !/ACCOUNTINGALLOCATIONS/.test(b)), ...lists(xml, "ALLLEDGERENTRIES.LIST")];
  const stockBlocks = lists(xml, "ALLINVENTORYENTRIES.LIST").length ? lists(xml, "ALLINVENTORYENTRIES.LIST") : lists(xml, "INVENTORYENTRIES.LIST");
  const ledgers: Line[] = ledgerBlocks
    .map((b) => headerOf(b))
    .map((b) => ({
      ledger: tag(b, "LEDGERNAME"), amount: lead(tag(b, "AMOUNT")), dr: /^yes$/i.test(tag(b, "ISDEEMEDPOSITIVE")),
      appropriate: tag(b, "APPROPRIATEFOR"), vatExp: tag(b, "VATEXPAMOUNT"),
    }))
    .filter((l) => l.ledger);
  const stock: StockLine[] = stockBlocks.map((b) => {
    const top = headerOf(b);
    const alloc = lists(b, "ACCOUNTINGALLOCATIONS.LIST")[0] ?? "";
    return {
      item: tag(top, "STOCKITEMNAME"), amount: lead(tag(top, "AMOUNT")), dr: /^yes$/i.test(tag(top, "ISDEEMEDPOSITIVE")),
      unit: (/^\s*-?[\d.]+\s+(\S+)/.exec(tag(top, "ACTUALQTY") || tag(top, "BILLEDQTY"))?.[1] ?? ""),
      gstSourceType: tag(top, "GSTSOURCETYPE"),
      gstSource: tag(top, "GSTSTOCKGROUPSOURCE") || tag(top, "GSTITEMSOURCE"),
      hsnSourceType: tag(top, "HSNSOURCETYPE"),
      taxability: tag(top, "GSTOVRDNTAXABILITY"),
      rateInfer: tag(top, "GSTRATEINFERAPPLICABILITY"),
      salesLedger: tag(alloc, "LEDGERNAME"),
      hasBatch: lists(b, "BATCHALLOCATIONS.LIST").length > 0,
    };
  }).filter((s) => s.item);
  const addr = (listTag: string) => lists(xml, listTag).flatMap((b) => tags(b, listTag.replace(/\.LIST$/, "")));
  return {
    origin, type: h("VOUCHERTYPENAME") || attr("VCHTYPE"), number: h("VOUCHERNUMBER"), date: isoOf(h("DATE")),
    action: attr("ACTION") || "Create", remoteId: attr("REMOTEID"),
    party: h("PARTYLEDGERNAME"), isInvoice: /^yes$/i.test(h("ISINVOICE")),
    h, address: addr("ADDRESS.LIST"),
    // Ship-to address. Native invoices (26-27/0551, 0658) keep it in
    // BASICBUYERADDRESS.LIST; CONSIGNEEADDRESS.LIST exists only inside the
    // e-way bill block Tally writes when a person raises one.
    consigneeAddress: addr("BASICBUYERADDRESS.LIST"),
    ledgers, stock, raw: xml,
  };
}

// ── Classification ───────────────────────────────────────────────────────────

export const HOME = "West Bengal";
export const TAX_HEAD = /\b(CGST|SGST|UTGST|IGST|CESS)\b/i;
export const ROUNDING = /^\s*ROUND(ED)?\s*OFF\s*$/i;
export const REVENUE = (n: string) => /^\s*(SALES|PURCHASE)\b/i.test(n) && !/DISCOUNT/i.test(n);
export const isOutward = (t: string) => /^(SALES|CREDIT NOTE|SALES ORDER NOTE)$/i.test(t.trim());
export const isInward = (t: string) => /PURCHASE|DEBIT NOTE|RECEIPT NOTE/i.test(t);
export const isMoney = (t: string) => /^(PAYMENT|RECEIPT|CONTRA|JOURNAL)$/i.test(t.trim());
/** Tally's own words for a registration type, as stored on 1,069 native sales (census 23-Sep-2026). */
export const TALLY_REG_TYPES = new Set(["Regular", "Unregistered/Consumer", "Composition", "Consumer", "Unknown", "SEZ"]);

// ── The voucher-shape checks ────────────────────────────────────────────────

export interface ShapeContext {
  masters: TallyMasters;
  /** What bill-to MUST be, from the master (or the walk-in the operator typed) — never from the payload under test. */
  expectMailing?: string;
  label: string;
}

/**
 * Run every push-shape guardrail that can be decided from the voucher itself.
 * Used on built XML and on Tally read-backs alike.
 */
export function checkVoucherShape(v: Voucher, ctx: ShapeContext): void {
  const L = `${ctx.label} ${v.type} ${v.number || "(no number)"}`;
  const m = ctx.masters;
  const invoiceShaped = v.isInvoice || v.stock.some((s) => s.salesLedger);

  // TG-P07 money vouchers carry nothing
  if (isMoney(v.type)) {
    // On a READ, Tally itself fills GSTREGISTRATIONTYPE on money vouchers from the
    // ledger (22% of native Receipts carry it) — so only what we SEND is held to it.
    const fields = v.origin === "sent" ? ["PARTYGSTIN", "PLACEOFSUPPLY", "GSTREGISTRATIONTYPE", "CONSIGNEEGSTIN"] : ["PARTYGSTIN", "PLACEOFSUPPLY", "CONSIGNEEGSTIN"];
    const stamped = fields.filter((t) => v.h(t));
    check("TG-P07", stamped.length === 0, `${L}: money voucher stamped with ${stamped.join(", ")}`);
  }

  // TG-P25 balance + sign
  if (!/RECEIPT NOTE|MATERIAL|STOCK JOURNAL|PHYSICAL/i.test(v.type)) {
    const ledgerSide = v.ledgers.reduce((s, l) => s + l.amount, 0);
    const stockSide = v.origin === "sent" && invoiceShaped ? v.stock.reduce((s, x) => s + x.amount, 0) : 0;
    const net = ledgerSide + stockSide;
    check("TG-P25", v.ledgers.length > 0 && Math.abs(net) < 0.02, `${L}: does not balance (net ${net.toFixed(2)}, ${v.ledgers.length} ledger lines)`);
    for (const l of v.ledgers) {
      // Negative credits are legitimate on exactly these two ledgers (Engineering Guardrails 1.3).
      // Rounding and discount/rebate lines carry the sign opposite to their side on
      // either direction in hand-typed books (negative credit on a sale, negative
      // debit on a purchase — calibrated on native SI082627/2654).
      const contraOk = ROUNDING.test(l.ledger) || /DISCOUNT|REBATE/i.test(l.ledger);
      const signOk = contraOk || (l.dr ? l.amount <= 0 : l.amount >= 0);
      check("TG-P25", signOk, `${L}: "${l.ledger}" ISDEEMEDPOSITIVE=${l.dr ? "Yes" : "No"} with amount ${l.amount}`);
    }
    for (const s of v.stock) check("TG-P25", s.dr ? s.amount <= 0 : s.amount >= 0, `${L}: stock "${s.item}" sign disagrees with its side`);
  }

  if (!invoiceShaped || !v.stock.length) return;
  const outward = isOutward(v.type), inward = isInward(v.type);

  // TG-P24 structure (only meaningful on what we send)
  if (v.origin === "sent") {
    const invoiceTag = /<LEDGERENTRIES\.LIST>/.test(v.raw), accountingTag = /<ALLLEDGERENTRIES\.LIST>/.test(v.raw);
    check("TG-P24", invoiceTag && !accountingTag, `${L}: invoice-shaped voucher must use LEDGERENTRIES.LIST only`);
    const allocLedgers = new Set(v.stock.map((s) => s.salesLedger).filter(Boolean));
    check("TG-P24", !v.ledgers.some((l) => allocLedgers.has(l.ledger)), `${L}: sales/purchase ledger listed as its own entry AND in the allocation`);
    check("TG-P24", v.stock.every((s) => s.hasBatch), `${L}: a stock line has no batch allocation`);
    check("TG-P24", /RECEIPT NOTE/i.test(v.type) ? !has(v.raw, "PERSISTEDVIEW") : true, `${L}: Receipt Note must omit PERSISTEDVIEW`);
  }

  // Resolve the party and what its identity must be on THIS date.
  const party = findLedger(m, v.party);
  const reg = !isMiss(party) ? registrationOn(party, v.date) : { gstin: "", registrationType: "", placeOfSupply: "", state: "" };
  // The EXPECTED GSTIN is worked out here, independently of registrationOn — a
  // check that calls the function under test to compute its expectation can
  // only agree with it (tally-harness-lies-more-than-the-app, pattern 2).
  const expectGstin = !isMiss(party) ? gstinInForce(party, v.date) : "";
  const partyState = !isMiss(party) ? (reg.placeOfSupply || reg.state || "").trim() : "";

  // TG-P06 identity block
  // COUNTRYOFRESIDENCE is absent on native purchases (calibrated 23-Sep), so it is held on outward only.
  for (const t of ["GSTREGISTRATIONTYPE", "STATENAME", "PLACEOFSUPPLY", ...(outward ? ["COUNTRYOFRESIDENCE"] : []), "PARTYMAILINGNAME"]) {
    check("TG-P06", !!v.h(t), `${L}: ${t} missing`);
  }
  if (expectGstin) {
    check("TG-P06", v.h("PARTYGSTIN") === expectGstin, `${L}: PARTYGSTIN "${v.h("PARTYGSTIN")}" ≠ registration in force on ${v.date} "${expectGstin}"`);
    check("TG-P27", v.h("PARTYGSTIN") === expectGstin, `${L}: GSTIN is not the one in force on ${v.date}`);
  } else if (!isMiss(party)) {
    check("TG-P27", !v.h("PARTYGSTIN"), `${L}: party was unregistered on ${v.date} (its dated block in force then has no GSTIN) but the voucher carries today's GSTIN ${v.h("PARTYGSTIN")}`);
  }
  void reg;

  // TG-P08 registration vocabulary
  const rt = v.h("GSTREGISTRATIONTYPE");
  check("TG-P08", TALLY_REG_TYPES.has(rt), `${L}: GSTREGISTRATIONTYPE "${rt}" is not a word Tally stores (native unregistered sales read "Unregistered/Consumer")`);
  check("TG-P08", !!v.h("PARTYGSTIN") === (rt === "Regular" || rt === "Composition" || rt === "SEZ"), `${L}: registration type "${rt}" disagrees with GSTIN "${v.h("PARTYGSTIN")}"`);

  // TG-P09 ship-to = bill-to
  const billName = v.h("PARTYMAILINGNAME");
  const pairs: [string, string, string][] = [
    ["CONSIGNEEMAILINGNAME", v.h("CONSIGNEEMAILINGNAME"), billName],
    ["CONSIGNEESTATENAME", v.h("CONSIGNEESTATENAME"), v.h("STATENAME")],
    ["CONSIGNEECOUNTRYNAME", v.h("CONSIGNEECOUNTRYNAME"), v.h("COUNTRYOFRESIDENCE") || "India"],
    ["CONSIGNEEGSTIN", v.h("CONSIGNEEGSTIN"), v.h("PARTYGSTIN")],
    ["CONSIGNEEPINCODE", v.h("CONSIGNEEPINCODE"), v.h("PARTYPINCODE")],
  ];
  // On a purchase WE are the consignee — bill-to = ship-to is an outward rule.
  for (const [t, got, want] of inward ? [] : pairs) {
    if (!want && (t === "CONSIGNEEGSTIN" || t === "CONSIGNEEPINCODE")) continue; // nothing to copy
    check("TG-P09", !!got && got === want, `${L}: ${t} "${got}" ≠ bill-to "${want}"`);
  }
  if (inward) {
    // On a purchase WE are the consignee; the bill-to/ship-to rule is about outward supplies.
  } else if (v.address.length) {
    check("TG-P09", v.consigneeAddress.join("|") === v.address.join("|"),
      `${L}: ship-to address (BASICBUYERADDRESS) [${v.consigneeAddress.join(" / ")}] ≠ bill-to address [${v.address.join(" / ")}]`);
  }
  if (ctx.expectMailing) check("TG-P09", billName === ctx.expectMailing, `${L}: bill-to name "${billName}" ≠ expected "${ctx.expectMailing}"`);

  // TG-P10 place of supply direction
  const pos = v.h("PLACEOFSUPPLY"), stateName = v.h("STATENAME");
  if (inward) check("TG-P10", pos === HOME, `${L}: inward place of supply "${pos}" — must be ${HOME}`);
  if (outward) check("TG-P10", !!pos && pos === stateName, `${L}: outward place of supply "${pos}" ≠ party state "${stateName}"`);
  if (partyState) check("TG-P10", stateName.toUpperCase() === partyState.toUpperCase(), `${L}: STATENAME "${stateName}" ≠ ledger state "${partyState}"`);

  // TG-P11 tax head follows state
  const counterState = inward ? stateName : pos;
  const inter = !!counterState && counterState.toUpperCase() !== HOME.toUpperCase();
  const names = [...v.ledgers.map((l) => l.ledger), ...v.stock.map((s) => s.salesLedger)];
  const usesIgst = names.some((n) => /\bIGST\b/i.test(n)), usesPair = names.some((n) => /\b(CGST|SGST)\b/i.test(n));
  const usesCentral = names.some((n) => /GST\s*CENTRAL/i.test(n)), usesWb = names.some((n) => /GST\s*W\.?B\.?/i.test(n));
  if (counterState) {
    check("TG-P11", inter ? !(usesPair || usesWb) : !(usesIgst || usesCentral),
      `${L}: ${inter ? "interstate" : "local"} (${counterState}) but uses ${inter ? "CGST/SGST or W.B." : "IGST or CENTRAL"}`);
  }

  // TG-P12 cash walk-in is local
  if (/^\s*cash\s*$/i.test(v.party) && outward) {
    check("TG-P12", pos === HOME && !usesIgst, `${L}: cash walk-in with place of supply "${pos}"${usesIgst ? " and IGST" : ""}`);
  }

  // TG-P13 / TG-P16 line source + TG-P14 dated rate + TG-P15 tax arithmetic
  for (const s of v.stock) {
    const r = gstRateFor(m, s.item, v.date);
    const want = r.rate > 0 ? (r.source === "item" ? { t: "Stock Item", n: s.item } : { t: "Stock Group", n: /^stock group "(.*)"$/.exec(r.source)?.[1] ?? "" }) : null;
    const gid = inward ? "TG-P16" : "TG-P13";
    const named = !!s.gstSourceType && !!s.gstSource;
    // Inward: 186 of 186 hand-typed purchase lines in the sandbox (5–18 Sep) name
    // their source (run.ts --calibrate), and so did our G1 purchase when READ BACK
    // although the builder did not send one — Tally resolved it from the masters
    // on import. So on a purchase only the STORED shape decides; what we send
    // cannot (23-Sep-2026). Sales are different: 0718..0723 prove Tally does NOT
    // fill it there.
    if (inward && v.origin === "sent" && !named) {
      unverified("TG-P16", `${L}: inward line "${s.item}" sent with no GST source — Tally filled it on import in the 23-Sep sandbox round-trip; confirm with --sandbox`);
      continue;
    }
    check(gid, named,
      `${L}: line "${s.item}" names no GST source${r.rate > 0 ? "" : " (and no master in its chain declares a rate — Tally files it 'Tax rate/tax type not specified')"}`);
    if (want && s.gstSourceType) {
      check("TG-P14", s.gstSourceType === want.t && s.gstSource === want.n,
        `${L}: line "${s.item}" sources ${s.gstSourceType} "${s.gstSource}", the chain on ${v.date} resolves ${want.t} "${want.n}" @ ${r.rate}%`);
    }
    if (s.gstSourceType) check(gid, !!s.hsnSourceType && /taxable/i.test(s.taxability || (v.origin === "stored" ? "Taxable" : "")),
      `${L}: line "${s.item}" has a GST source but no HSN source / taxability`);
  }
  for (const a of outward ? adjustments(v) : []) {
    // TG-P18 appropriation — an outward (GSTR-1) rule. On a purchase the supplier's
    // bill decides, and native purchases carry rebates unappropriated. (sent carries "GST"; stored reads "GST"). A web file export sending "Goods" is Tally-normalised.
    check("TG-P18", /^(GST|Goods)$/i.test(a.appropriate), `${L}: adjustment "${a.ledger}" does not appropriate to GST`);
    if (v.origin === "sent" && a.appropriate) check("TG-P18", !a.vatExp || Math.abs(lead(a.vatExp) - a.amount) < 0.005, `${L}: VATEXPAMOUNT ${a.vatExp} ≠ AMOUNT ${a.amount}`);
  }
  if (outward || inward) checkTaxParity("TG-P15", v, m, L);

  // TG-P17 round-off
  const ro = v.ledgers.filter((l) => ROUNDING.test(l.ledger));
  for (const r of ro) {
    check("TG-P17", Math.abs(r.amount) <= 0.5 + 1e-9, `${L}: ROUNDED OFF ${r.amount} exceeds ₹0.50`);
    if (outward) check("TG-P17", !r.dr, `${L}: sales ROUNDED OFF on the debit side (all 664 native sales round-offs are credits)`);
    if (inward) check("TG-P17", r.dr, `${L}: purchase ROUNDED OFF on the credit side (all 78 native are debits)`);
  }
  const partyLine = v.ledgers.find((l) => l.ledger === v.party);
  if (outward && partyLine && ro.length) {
    check("TG-P17", Math.abs(Math.abs(partyLine.amount) - Math.round(Math.abs(partyLine.amount))) < 0.005,
      `${L}: party total ${partyLine.amount} is not whole rupees although a round-off line is present`);
  }
}

/**
 * The GSTIN in force on a date, read straight off the dated LEDGSTREGDETAILS
 * blocks: the newest block not after the date wins EVEN WHEN ITS GSTIN IS EMPTY
 * (the party was unregistered then). Only with no block in force does the flat
 * master field stand in.
 */
export function gstinInForce(led: { gstin: string; registrations: { applicableFrom: string; gstin: string }[] }, isoDate: string): string {
  const stamp = isoDate.replace(/-/g, "");
  const blocks = [...(led.registrations ?? [])].sort((a, b) => (a.applicableFrom || "").localeCompare(b.applicableFrom || ""));
  const inForce = blocks.filter((r) => !r.applicableFrom || r.applicableFrom <= stamp).pop();
  return (inForce ? inForce.gstin : led.gstin || "").trim();
}

/** Lines that move the invoice value: not the party, a tax head, rounding or the revenue ledger. */
export function adjustments(v: Voucher): Line[] {
  return v.ledgers.filter((l) => !TAX_HEAD.test(l.ledger) && !ROUNDING.test(l.ledger) && !REVENUE(l.ledger) && l.ledger !== v.party);
}

/**
 * Booked tax vs Σ dated rate × taxable, with appropriated adjustments spread
 * over the lines in proportion to value (CGST Act s.15 — how Tally itself does
 * it: 26-27/0551, (6577.92 − 72) × 5% = 325.30 exactly).
 */
export function taxParity(v: Voucher, m: TallyMasters): { expected: number; booked: number; taxable: number; unresolved: string[]; cgst: number; sgst: number } {
  const outward = isOutward(v.type);
  let expected = 0, taxable = 0;
  const unresolved: string[] = [];
  for (const s of v.stock) {
    const r = gstRateFor(m, s.item, v.date);
    if (!(r.rate > 0)) unresolved.push(s.item);
    const amt = Math.abs(s.amount);
    taxable += amt; expected += amt * r.rate / 100;
  }
  for (const a of adjustments(v)) {
    // Only an APPROPRIATED line moves the assessable value. "?" = the source
    // cannot say (the mirror never fetched APPROPRIATEFOR): assume appropriated
    // on outward, where the whole FY book has zero unappropriated lines.
    const appropriated = /^(GST|Goods)$/i.test(a.appropriate) || (a.appropriate === "?" && outward);
    if (!appropriated) continue;
    if (taxable > 0) {
      const factor = 1 + (outward ? a.amount : -a.amount) / taxable;
      expected *= factor; taxable *= factor;
    }
  }
  const taxLines = v.ledgers.filter((l) => TAX_HEAD.test(l.ledger));
  const sum = (re: RegExp) => taxLines.filter((l) => re.test(l.ledger)).reduce((s, l) => s + Math.abs(l.amount), 0);
  return { expected, booked: sum(/./), taxable, unresolved, cgst: sum(/CGST/i), sgst: sum(/SGST/i) };
}

export function checkTaxParity(id: string, v: Voucher, m: TallyMasters, L: string): void {
  const t = taxParity(v, m);
  if (t.unresolved.length) {
    check(id, false, `${L}: no dated rate resolves for ${t.unresolved.slice(0, 3).map((n) => `"${n}"`).join(", ")} — tax cannot be verified and Tally files "Tax rate is not specified"`);
    return;
  }
  check(id, Math.abs(t.booked - t.expected) <= Math.max(1, 0.01 * v.stock.length),
    `${L}: tax booked ₹${t.booked.toFixed(2)} vs dated rate × taxable ₹${t.expected.toFixed(2)} (taxable ₹${t.taxable.toFixed(2)})`);
  check(id, Math.abs(t.cgst - t.sgst) < 0.015, `${L}: CGST ₹${t.cgst.toFixed(2)} ≠ SGST ₹${t.sgst.toFixed(2)}`);
}

/** A mirror row (tally_vouchers) as a Voucher, so the same checks run over it. */
export function voucherFromMirror(row: any): Voucher {
  const map: Record<string, string> = {
    PARTYGSTIN: row.party_gstin ?? "", PLACEOFSUPPLY: row.place_of_supply ?? "", CONSIGNEESTATENAME: row.consignee_state ?? "",
    CONSIGNEEPINCODE: row.consignee_pincode ?? "",
  };
  return {
    origin: "stored", type: row.voucher_type ?? "", number: row.voucher_number ?? "", date: String(row.date ?? "").slice(0, 10),
    action: "Create", remoteId: row.remote_id ?? "", party: row.party_ledger_name ?? "", isInvoice: true,
    h: (t: string) => map[t] ?? "", address: [], consigneeAddress: [],
    ledgers: (row.ledger_entries ?? []).map((e: any) => ({
      ledger: String(e.ledgername ?? ""), amount: parseFloat(e.amount) || 0, dr: e.isdeemedpositive === true || /^yes$/i.test(String(e.isdeemedpositive)),
      appropriate: "appropriatefor" in e ? String(e.appropriatefor ?? "") : "?", vatExp: "",
    })),
    stock: (row.inventory_entries ?? []).map((s: any) => ({
      item: String(s.stockitemname ?? ""), amount: parseFloat(s.amount) || 0, dr: s.isdeemedpositive === true || /^yes$/i.test(String(s.isdeemedpositive)),
      unit: /^\s*-?[\d.]+\s+(\S+)/.exec(String(s.actualqty ?? ""))?.[1] ?? "",
      gstSourceType: "", gstSource: "", hsnSourceType: "", taxability: "", rateInfer: "", salesLedger: "", hasBatch: true,
    })),
    raw: "",
  };
}

/**
 * Where the web app lives. MKCP_WEB_DIR wins; otherwise the sibling checkout
 * under either name it has had ("MKCP MOB2" on the office PC, "MKCPWEB" in a
 * cloud clone). Returns the first that exists, else the first candidate.
 */
export function webDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..", "..", "..", "..");
  const cands = process.env.MKCP_WEB_DIR ? [resolve(process.env.MKCP_WEB_DIR)]
    : [join(root, "MKCP MOB2", "web-dashboard"), join(root, "MKCPWEB", "web-dashboard")];
  return cands.find((c) => existsSync(c)) ?? cands[0];
}
