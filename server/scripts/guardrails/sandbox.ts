/**
 * --sandbox : push a few guardrail vouchers into the SANDBOX Tally, one at a
 * time, through safePush (the path the app uses — method step 10), then read
 * back EVERY voucher dated today — ours (MKCP|GUARD|…), the push agent's
 * (MKCP|TEST|…) and anything else — and run the same shape checks on what Tally
 * STORED.
 *
 * Owner's rule, 23-Sep-2026: vouchers are dated TODAY and LEFT in the sandbox
 * for inspection. Nothing here deletes. Re-runs are idempotent: the same
 * REMOTEID + the same number makes Tally ALTER the existing voucher instead of
 * creating a second one (vault §3.3).
 *
 * Deliberately NOT duplicated: the push agent's S1–S7 (every sales / order
 * shape). This mode adds what those do not cover — an interstate PURCHASE, a
 * money voucher, and a CANCEL — and audits all of them together.
 *
 * Refuses unless MKCP_TALLY_ROLE=sandbox and TALLY_URL is localhost:9000.
 */
import { check, unverified, parseVoucher, checkVoucherShape, tag, isOutward } from "./lib.js";
import type { VoucherPayload, LedgerEntry } from "../../src/types.js";
import type { TallyMasters, MasterLedger } from "../../src/services/tallyMasters.js";

export function assertSandboxTarget(env: Record<string, string | undefined> = process.env): string {
  const role = (env.MKCP_TALLY_ROLE ?? "").trim().toLowerCase();
  const url = env.TALLY_URL || "http://localhost:9000";
  if (role !== "sandbox") throw new Error(`REFUSED — MKCP_TALLY_ROLE is "${role || "primary (default)"}", not "sandbox". The round-trip writes vouchers and never runs against the real books.`);
  if (!/^https?:\/\/(localhost|127\.0\.0\.1):9000\/?$/i.test(url)) throw new Error(`REFUSED — TALLY_URL is ${url}. Only the sandbox Tally on localhost:9000 is allowed.`);
  return url;
}

/** Today in the operator's timezone (IST), YYYY-MM-DD. */
export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const READ_FIELDS = [
  "Date", "VoucherNumber", "VoucherTypeName", "PartyLedgerName", "PartyName", "Narration", "IsCancelled", "IsOptional",
  "PartyMailingName", "Address", "PartyPincode", "StateName", "CountryOfResidence", "PlaceOfSupply",
  "GSTRegistrationType", "PartyGSTIN", "VATDealerType", "CMPGSTIN",
  "BasicBuyerName", "ConsigneeMailingName", "ConsigneeGSTIN", "ConsigneePinCode", "ConsigneeStateName", "ConsigneeCountryName", "ConsigneeAddress", "BasicBuyerAddress",
  "IsInvoice", "PersistedView", "VchEntryMode", "Reference", "ReferenceDate",
  "AllLedgerEntries", "ALLLEDGERENTRIES.APPROPRIATEFOR", "ALLLEDGERENTRIES.GSTAPPROPRIATETO", "AllInventoryEntries",
];

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function runSandbox(): Promise<void> {
  const url = assertSandboxTarget();
  const company = process.env.TALLY_COMPANY || "";
  const { tallyPost, HEALTH_XML } = await import("../../src/tally.js");
  const { loadMasters, gstRateFor } = await import("../../src/services/tallyMasters.js");
  const { safePush } = await import("../../src/services/safePush.js");
  const { buildCollection, blocksOf, onDate } = await import("../../src/services/tallyRequest.js");

  const health = String(await tallyPost(url, HEALTH_XML, 10_000, true).catch((e: Error) => `DOWN ${e.message}`));
  if (!/<STATUS>1<\/STATUS>/.test(health)) { unverified("TG-P13", `sandbox Tally not answering on ${url}: ${health.slice(0, 80)}`); return; }

  const m: TallyMasters = await loadMasters(url, company, { force: true });
  const today = todayLocal();
  const stamp = today.slice(5).replace("-", "");
  const led = (re: RegExp) => [...m.ledgers.keys()].find((n) => re.test(n));
  const need = {
    inputIgst: led(/^INPUT IGST$/i), purchaseCentral: led(/^PURCHASE \( GST CENTRAL \)$/i), roundOff: led(/^ROUNDED OFF$/i),
    outCgst: led(/^OUTPUT CGST$/i), outSgst: led(/^OUTPUT SGST$/i), salesWb: led(/^SALES {2}\( GST W\.B\. \)$/), cash: led(/^Cash$/),
  };
  const missing = Object.entries(need).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) { unverified("TG-P22", `sandbox masters lack ${missing.join(", ")} — scenarios not pushed`); }

  // Real masters only — nothing typed (the harness-lies rule: expected values come from masters).
  const ledgers = [...m.ledgers.values()];
  const supplier = ledgers.find((l) => /Sundry Creditors/i.test(l.parent) && l.gstin && l.state && !/west bengal/i.test(l.state));
  const debtor = ledgers.find((l) => /Sundry Debtors/i.test(l.parent) && l.gstin && /west bengal/i.test(l.state) && l.pincode);
  const rated = [...m.items.values()].filter((i) => i.baseUnit && gstRateFor(m, i.name, today).rate > 0).slice(0, 40);
  const pick = (k: number) => rated[k % Math.max(1, rated.length)];

  const pushes: { id: string; p: VoucherPayload; expectMailing?: string }[] = [];
  if (!missing.length && supplier && rated.length >= 2) {
    const lines = [pick(3), pick(11)].map((it, k) => ({ it, amount: 1000 + 250 * k, rate: gstRateFor(m, it.name, today).rate }));
    const goods = lines.reduce((s, l) => s + l.amount, 0), igst = r2(lines.reduce((s, l) => s + l.amount * l.rate / 100, 0));
    const exact = r2(goods + igst), grand = Math.round(exact), ro = r2(grand - exact);
    const L: LedgerEntry[] = [
      { ledgerName: supplier.name, amount: grand, isDeemedPositive: false, isPartyLedger: true },
      { ledgerName: need.inputIgst!, amount: igst, isDeemedPositive: true, isPartyLedger: false },
    ];
    if (ro) L.push({ ledgerName: need.roundOff!, amount: Math.abs(ro), isDeemedPositive: true, isPartyLedger: false, signedAmount: -ro });
    pushes.push({ id: "G1", p: {
      voucherType: "Purchase", date: today, voucherNumber: `GUARD/${stamp}/P1`, remoteId: `MKCP|GUARD|Purchase|${stamp}|P1`,
      reference: `GUARD-SUP-${stamp}`, referenceDate: today, narration: `MKCP GUARD G1 interstate purchase`, isInvoice: true,
      partyLedgerName: supplier.name, ledgerEntries: L,
      inventoryEntries: lines.map((l) => ({ stockItemName: l.it.name, quantity: 1, unit: l.it.baseUnit, rate: l.amount, amount: l.amount,
        isDeemedPositive: true, salesLedgerName: need.purchaseCentral!, godownName: [...m.godowns][0], batchName: "Primary Batch" })),
    } as VoucherPayload });
  } else unverified("TG-P16", "no interstate supplier / rated items in the sandbox masters — G1 not pushed");

  if (!missing.length && debtor) {
    pushes.push({ id: "G2", p: {
      voucherType: "Receipt", date: today, voucherNumber: `GUARD/${stamp}/R1`, remoteId: `MKCP|GUARD|Receipt|${stamp}|R1`,
      narration: "MKCP GUARD G2 receipt on account", isInvoice: false, partyLedgerName: debtor.name,
      ledgerEntries: [
        { ledgerName: need.cash!, amount: 10, isDeemedPositive: true, isPartyLedger: false },
        // No allocation: Tally books an unallocated receipt On Account with a BLANK
        // bill name (fidelity/case-money.ts). Sending a named On Account allocation
        // is stored without its name, which safePush's diff reports as NOT STORED.
        { ledgerName: debtor.name, amount: 10, isDeemedPositive: false, isPartyLedger: true },
      ],
    } as VoucherPayload });
  }

  if (!missing.length && debtor && rated.length) {
    const it = pick(7), rate = gstRateFor(m, it.name, today).rate, amount = 800;
    const half = r2(amount * rate / 200), exact = r2(amount + 2 * half), grand = Math.round(exact), ro = r2(grand - exact);
    const L: LedgerEntry[] = [
      { ledgerName: debtor.name, amount: grand, isDeemedPositive: true, isPartyLedger: true },
      { ledgerName: need.outCgst!, amount: half, isDeemedPositive: false, isPartyLedger: false },
      { ledgerName: need.outSgst!, amount: half, isDeemedPositive: false, isPartyLedger: false },
    ];
    if (ro) L.push({ ledgerName: need.roundOff!, amount: Math.abs(ro), isDeemedPositive: false, isPartyLedger: false, signedAmount: ro });
    const sale: VoucherPayload = {
      voucherType: "Sales", date: today, voucherNumber: `GUARD/${stamp}/C1`, remoteId: `MKCP|GUARD|Sales|${stamp}|C1`,
      narration: "MKCP GUARD G3 invoice then cancel", isInvoice: true, partyLedgerName: debtor.name, ledgerEntries: L,
      inventoryEntries: [{ stockItemName: it.name, quantity: 1, unit: it.baseUnit, rate: amount, amount, isDeemedPositive: false,
        salesLedgerName: need.salesWb!, godownName: [...m.godowns][0], batchName: "Primary Batch" }],
    } as VoucherPayload;
    pushes.push({ id: "G3", p: sale, expectMailing: (debtor as MasterLedger).mailingName || debtor.name });
    pushes.push({ id: "G3-cancel", p: { ...sale, action: "Cancel" } });
  }

  // One at a time, through the app's own path. Record intent BEFORE each push.
  for (const { id, p } of pushes) {
    console.log(`  → ${id} ${p.action ?? "Create"} ${p.voucherType} ${p.voucherNumber} (${p.remoteId})`);
    const res = await safePush(url, company, p);
    const why = [...res.errors, ...res.differences].join(" | ");
    check(p.voucherType === "Purchase" ? "TG-P16" : p.action === "Cancel" ? "TG-P04" : p.voucherType === "Receipt" ? "TG-P07" : "TG-P13",
      res.ok, `[sandbox] ${id} safePush ${res.stage}: ${why.slice(0, 300)}`);
  }

  // ── Read back EVERYTHING dated today and audit what Tally stored ─────────
  const xml = buildCollection({ id: "MkGuardToday", type: "Voucher", company, fetch: READ_FIELDS, filter: onDate(today.replace(/-/g, "")) });
  const raw = String(await tallyPost(url, xml, 120_000, true));
  const blocks = blocksOf(raw, "VOUCHER").map((b) => `<VOUCHER ${b}`);
  console.log(`  read back ${blocks.length} voucher(s) dated ${today}`);
  if (!blocks.length) { unverified("TG-P13", `no vouchers dated ${today} in the sandbox — nothing stored to audit`); return; }
  for (const b of blocks) {
    const v = parseVoucher(b, "stored");
    const narr = tag(b, "NARRATION");
    const cancelled = /^yes$/i.test(tag(b, "ISCANCELLED"));
    const who = /MKCP GUARD/.test(narr) ? "guard" : /MKCP TEST/.test(narr) ? "push-agent" : "other";
    const label = `[stored/${who}]`;
    if (/G3 invoice then cancel/.test(narr)) check("TG-P04", cancelled, `${label} ${v.number}: Cancel pushed but ISCANCELLED reads "${tag(b, "ISCANCELLED")}"`);
    if (cancelled) continue; // not a posting — never diff fields on a cancel (tally-cancel-is-an-action)
    const g3 = pushes.find((x) => x.id === "G3");
    const expectMailing = /MKCP GUARD G3/.test(narr) ? g3?.expectMailing : undefined;
    checkVoucherShape(v, { masters: m, expectMailing, label });
    if (isOutward(v.type) && v.stock.length) {
      // What GST Tax Analysis turns on: every stored line tied to a source whose dated rate is > 0.
      for (const s of v.stock) {
        const r = gstRateFor(m, s.item, v.date);
        check("TG-P13", !!s.gstSourceType && r.rate > 0, `${label} ${v.number}: stored line "${s.item}" → ${s.gstSourceType ? `${s.gstSourceType} "${s.gstSource}"` : "no GST source"}, resolved rate ${r.rate}% ("Tax rate/tax type not specified" if 0)`);
      }
    }
  }
}
