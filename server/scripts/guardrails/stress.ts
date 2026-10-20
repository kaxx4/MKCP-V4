/**
 * --stress : every way the WEB app writes to Tally, pushed one at a time into
 * the SANDBOX Tally through safePush, then read back, shape-checked and
 * DELETED so a re-run starts clean.
 *
 *   web builders (salesOrderToPayload, cashInvoiceToPayload, convertToBilled,
 *   purchaseToPayload, buildMoneyPayload, correctReceiptAmount, chequeToDraft,
 *   draftToPayload, buildEditPayload, buildCreditNote, invoiceFromOrder — via
 *   web-dashboard/scripts/emit-stress.mts, the functions the UI calls)
 *     → safePush (guard → build → push → read-back diff), ONE request at a time
 *     → read back both test dates, run checkVoucherShape on every STRESS voucher
 *     → count per voucher number (Alter / double push / convert leave exactly one)
 *     → Delete every STRESS voucher by REMOTEID, re-count against the baseline
 *
 * Owner, 18-Oct-2026: the laptop's Tally is the dummy and live push tests are
 * authorised there. Refuses unless MKCP_TALLY_ROLE=sandbox and TALLY_URL is
 * localhost:9000 (assertSandboxTarget). Never touches Supabase: on a sandbox
 * role supabaseClient() is null by construction.
 *
 * Hard stops (a Tally import error freezes the XML port until TallyPrime is
 * restarted — tally-error-requires-restart):
 *   · a lock file — two runs never overlap;
 *   · health is asked before EVERY push, and a refusal stops the run;
 *   · any push-stage failure the scenario did not predict stops the run.
 *
 * Identity: numbers are STRESS/<mmdd>/<id>, REMOTEIDs MKCP|STRESS|<mmdd>|<id>,
 * narrations start "CLAUDE-TEST STRESS <id>" — never the bare MKCP- prefix,
 * which is a real bill series (mkcp-prefix-is-a-real-bill-series).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { check, unverified, parseVoucher, checkVoucherShape, tag, webDir } from "./lib.js";
import { assertSandboxTarget, todayLocal, READ_FIELDS } from "./sandbox.js";
import type { VoucherPayload } from "../../src/types.js";
import type { TallyMasters, MasterLedger, MasterItem } from "../../src/services/tallyMasters.js";
import type { OpenBill } from "../../src/services/billSettlement.js";
import type { SafePushResult } from "../../src/services/safePush.js";

const here = dirname(fileURLToPath(import.meta.url));
const r2 = (n: number) => Math.round(n * 100) / 100;
const DEFAULT_LOCK = "C:\\Users\\kanis\\AppData\\Local\\Temp\\claude\\C--Users-kanis-Desktop-Code-MKCP-Live-Sync\\e5d919b7-a9ba-44b9-9fe7-16dd35d89584\\scratchpad\\tally.lock";

/** What a scenario is expected to do. */
type Expect =
  | "ok"            // safePush ok, stage done
  | "guard"         // refused by the guard, nothing sent to Tally
  | "builder"       // the web builder itself refuses / throws
  | "tally-reject"; // Tally refuses it and safePush reports it (never a duplicate)

interface Scenario {
  id: string;
  what: string;
  expect: Expect;
  /** Built (so others can derive from it) but never pushed. */
  buildOnly?: boolean;
  /** Error text the refusal must contain. */
  because?: RegExp;
  spec: Record<string, unknown>;
  /** Post-build mutation, for the hand-broken cases a builder cannot produce. */
  mutate?: (p: VoucherPayload) => VoucherPayload;
}

class Stop extends Error {}

function emit(company: string, scenarios: Scenario[]): Map<string, { payload?: VoucherPayload; error?: string }> | string {
  const web = webDir();
  const emitter = join(web, "scripts", "emit-stress.mts");
  if (!existsSync(emitter)) return `web emitter not found at ${emitter} (set MKCP_WEB_DIR)`;
  const dir = mkdtempSync(join(tmpdir(), "mkcp-stress-"));
  const inP = join(dir, "in.json"), outP = join(dir, "out.json");
  writeFileSync(inP, JSON.stringify({ company, scenarios: scenarios.map((s) => ({ id: s.id, ...s.spec })) }));
  const tsx = join(here, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
  const r = spawnSync(process.execPath, [tsx, emitter, inP, outP], { cwd: web, encoding: "utf8" });
  if (r.status !== 0) return `web emitter failed: ${(r.stderr || r.stdout).slice(0, 800)}`;
  const rows = JSON.parse(readFileSync(outP, "utf8")) as { id: string; payload?: VoucherPayload; error?: string }[];
  return new Map(rows.map((x) => [x.id, x]));
}

/** Tally's BILLDATE ("20260410" or "10-Apr-2026") → YYYY-MM-DD. */
function isoBillDate(s: string): string {
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function runStress(opts: { dry?: boolean; clean?: boolean } = {}): Promise<void> {
  const url = assertSandboxTarget();
  const company = process.env.TALLY_COMPANY || "";
  const lockPath = process.env.STRESS_LOCK || DEFAULT_LOCK;
  let fd: number;
  try { fd = openSync(lockPath, "wx"); } catch {
    throw new Error(`lock ${lockPath} exists — another Tally run is in progress (or crashed: check, then delete it by hand)`);
  }
  closeSync(fd);
  try { await stress(url, company, !!opts.dry, !!opts.clean); }
  finally { try { unlinkSync(lockPath); } catch { /* already gone */ } }
}

async function stress(url: string, company: string, dry: boolean, clean: boolean): Promise<void> {
  const { tallyPost, HEALTH_XML } = await import("../../src/tally.js");
  const { loadMasters, gstRateFor, hsnFor, registrationOn } = await import("../../src/services/tallyMasters.js");
  const { safePush } = await import("../../src/services/safePush.js");
  const { guardVoucher, filedThroughOn, gstReturnFiledThrough } = await import("../../src/services/pushGuard.js");
  const { loadOpenBills } = await import("../../src/services/billSettlement.js");
  const { isGstinChecksumValid, codeForState, PIN_RE, HSN_RE } = await import("../../src/services/gstIdentity.js");
  const { buildCollection, blocksOf, onDate } = await import("../../src/services/tallyRequest.js");

  const healthy = async (): Promise<boolean> => {
    const h = String(await tallyPost(url, HEALTH_XML, 10_000, true).catch((e: Error) => `DOWN ${e.message}`));
    return /<STATUS>1<\/STATUS>/.test(h);
  };
  if (!(await healthy())) { unverified("TG-P33", `sandbox Tally not answering on ${url}`); return; }

  const m: TallyMasters = await loadMasters(url, company, { force: true });
  const today = todayLocal();
  // run.ts pins MKCP_FILED_THROUGH for --static; the statutory calendar still binds a live push, so take the later.
  const filed = [filedThroughOn(), gstReturnFiledThrough()].sort().pop()!;
  if (today <= filed) throw new Error(`today ${today} is inside the filed period (through ${filed}) — nothing invoice-shaped can be pushed`);
  // Backdated within the open period: the 5th of this month, else yesterday.
  const fifth = `${today.slice(0, 8)}05`;
  const back = fifth > filed && fifth < today ? fifth : today;
  const mmdd = today.slice(5).replace("-", "");
  const num = (id: string) => `STRESS/${mmdd}/${id}`;
  const rid = (id: string) => `MKCP|STRESS|${mmdd}|${id}`;
  const nar = (id: string, rest = "") => `CLAUDE-TEST STRESS ${id}${rest ? ` ${rest}` : ""}`;
  console.log(`  stress: today ${today}, backdate ${back}, filed through ${filed}`);

  // ── Real masters only ──────────────────────────────────────────────────────
  const ledgers = [...m.ledgers.values()];
  const led = (re: RegExp) => [...m.ledgers.keys()].find((n) => re.test(n));
  const L = {
    salesWb: led(/^SALES {2}\( GST W\.B\. \)$/), salesC: led(/^SALES {2}\( GST CENTRAL \)$/),
    outC: led(/^OUTPUT CGST$/), outS: led(/^OUTPUT SGST$/), outI: led(/^OUTPUT IGST$/),
    inC: led(/^INPUT CGST$/), inS: led(/^INPUT SGST$/), inI: led(/^INPUT IGST$/),
    purWb: led(/^PURCHASE \( GST W\.B\. \)$/), purC: led(/^PURCHASE \( GST CENTRAL \)$/),
    ro: led(/^ROUNDED OFF$/), disc: led(/^TRADE DISCOUNTS \/ H\.C\.$/), cash: led(/^Cash$/),
  };
  const missing = Object.entries(L).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`sandbox masters lack ${missing.join(", ")}`);
  const regOk = (l: MasterLedger, wantHome: boolean) => {
    const g = registrationOn(l, today).gstin.trim();
    const st = (l.state || "").trim();
    return !!g && isGstinChecksumValid(g) && codeForState(st) === g.slice(0, 2) && /west bengal/i.test(st) === wantHome;
  };
  const addressed = (l: MasterLedger) => l.address.length > 0 && PIN_RE.test((l.pincode || "").trim());
  const notZ = (l: MasterLedger) => !/\(\s*Z\s*\)/i.test(l.name) && l.name === l.name.trim() && !/ {2}/.test(l.name);
  const debtors = ledgers.filter((l) => /Sundry Debtors/i.test(l.parent) && notZ(l));
  const creditors = ledgers.filter((l) => /Sundry Creditors/i.test(l.parent) && notZ(l));
  const localDebtor = debtors.find((l) => regOk(l, true) && addressed(l));
  const interDebtor = debtors.find((l) => regOk(l, false) && addressed(l));
  const unregDebtor = debtors.find((l) => !registrationOn(l, today).gstin.trim() && !l.gstin && /west bengal/i.test(l.state) && addressed(l));
  const localSupplier = creditors.find((l) => regOk(l, true));
  const interSupplier = creditors.find((l) => regOk(l, false));
  const bank = ledgers.find((l) => /^Bank Accounts$/i.test(l.parent) && notZ(l));
  const expenses = ledgers.filter((l) => /^Indirect Expenses$/i.test(l.parent) && notZ(l) && !/DISCOUNT|ROUND/i.test(l.name));
  const picks = { localDebtor, interDebtor, unregDebtor, localSupplier, interSupplier, bank, exp1: expenses[0], exp2: expenses[1] };
  const lacking = Object.entries(picks).filter(([, v]) => !v).map(([k]) => k);
  if (lacking.length) throw new Error(`no sandbox master fits: ${lacking.join(", ")}`);
  for (const [k, v] of Object.entries(picks)) console.log(`    ${k.padEnd(14)} ${v!.name}`);

  const rated = [...m.items.values()].filter((i) => {
    const r = gstRateFor(m, i.name, back).rate, r2_ = gstRateFor(m, i.name, today).rate;
    return i.baseUnit && r > 0 && r === r2_ && HSN_RE.test(hsnFor(m, i.name, today).code.trim()) && i.name === i.name.trim();
  });
  const byRate = (want: number) => rated.find((i) => gstRateFor(m, i.name, today).rate === want);
  const itA = byRate(18) ?? rated[0], itB = byRate(5) ?? rated.find((i) => gstRateFor(m, i.name, today).rate !== gstRateFor(m, itA?.name ?? "", today).rate);
  const itC = rated.find((i) => i !== itA && i !== itB);
  if (!itA || !itB || !itC) throw new Error("sandbox has too few rated items with HSN");
  const rateOf = (i: MasterItem) => gstRateFor(m, i.name, today).rate;
  console.log(`    items          ${itA.name} @${rateOf(itA)}% · ${itB.name} @${rateOf(itB)}% · ${itC.name} @${rateOf(itC)}%`);
  const line = (i: MasterItem, pkgs: number, rate: number) => ({ name: i.name, baseUnit: i.baseUnit, pkgs, rate, gstRate: rateOf(i) });
  const party = (l: MasterLedger) => ({ name: l.name, state: l.state, gstin: registrationOn(l, today).gstin || undefined, address: l.address.join("\n") });

  // A unit rate whose local round-off has the wanted sign (TG-P17, both directions).
  const rateForRounding = (gst: number, sign: 1 | -1) => {
    for (let k = 0; k < 400; k++) {
      const rate = r2(101 + k * 0.37);
      const half = r2(rate * gst / 200), exact = r2(rate + 2 * half), ro = r2(Math.round(exact) - exact);
      if (sign * ro > 0.05) return rate;
    }
    return 101;
  };

  // Open bills: an OLD one (never one raised seconds ago — tally-bill-settlement-timing).
  const bills: OpenBill[] = await loadOpenBills(url, company);
  const oldEnough = (b: OpenBill) => { const d = isoBillDate(b.date); return !!d && d < back; };
  const isLedger = (n: string) => m.ledgers.has(n) && notZ(m.ledgers.get(n)!);
  const recv = bills.filter((b) => b.closing < 0 && oldEnough(b) && b.outstanding > 200 && isLedger(b.party) && /Sundry Debtors/i.test(m.ledgers.get(b.party)!.parent));
  const pay = bills.filter((b) => b.closing > 0 && oldEnough(b) && b.outstanding > 200 && isLedger(b.party) && /Sundry Creditors/i.test(m.ledgers.get(b.party)!.parent));
  const recvBill = recv[0], payBill = pay[0];
  // A bill of ANOTHER party whose name is not also open for localDebtor.
  const foreign = bills.find((b) => b.party !== localDebtor!.name && b.closing < 0 && !bills.some((x) => x.party === localDebtor!.name && x.name === b.name));
  console.log(`    receivable     ${recvBill ? `${recvBill.party} / ${recvBill.name} (${recvBill.outstanding})` : "NONE"}`);
  console.log(`    payable        ${payBill ? `${payBill.party} / ${payBill.name} (${payBill.outstanding})` : "NONE"}`);
  const webBill = (b: OpenBill) => ({ billRef: b.name, date: isoBillDate(b.date), outstanding: b.outstanding, daysPastDue: 30 });

  // ── The matrix ─────────────────────────────────────────────────────────────
  const q = (id: string, what: string, expect: Expect, l: MasterLedger, lines: unknown[], extra: Record<string, unknown> = {}, sc: Partial<Scenario> = {}): Scenario => ({
    id, what, expect, ...sc,
    spec: { builder: "quote", kind: "invoice", date: today, number: num(id), remoteId: rid(id), narration: nar(id), party: party(l), lines, ...extra },
  });
  const money = (id: string, what: string, expect: Expect, row: Record<string, unknown>, billsFor: unknown[] = [], sc: Partial<Scenario> = {}): Scenario => ({
    id, what, expect, ...sc,
    spec: { builder: "money", remoteId: rid(id), row: { date: today, voucherNumber: num(id), narration: nar(id), ...row }, bills: billsFor },
  });
  const purchase = (id: string, what: string, sup: MasterLedger, amounts: [MasterItem, number][], extra: Record<string, unknown> = {}, rmt = rid(id), number = num(id)): Scenario => {
    const intra = /west bengal/i.test(sup.state);
    const taxable = r2(amounts.reduce((s, [, a]) => s + a, 0));
    const gst = r2(amounts.reduce((s, [i, a]) => s + a * rateOf(i) / 100, 0));
    return { id, what, expect: "ok", spec: {
      builder: "purchase", date: today, number, remoteId: rmt, narration: nar(id), intra, taxable, gst, grand: Math.round(taxable + gst),
      vendor: { name: sup.name, group: sup.parent, gstin: registrationOn(sup, today).gstin, state: sup.state, pincode: sup.pincode, address: sup.address },
      lines: amounts.map(([i, a]) => ({ name: i.name, baseUnit: i.baseUnit, qty: 1, rate: a, amount: a })), ...extra,
    } };
  };
  const draft = (id: string, what: string, expect: Expect, d: Record<string, unknown>, sc: Partial<Scenario> = {}): Scenario => ({
    id, what, expect, ...sc,
    spec: { builder: "draft", draft: { date: today, voucherNumber: num(id), narration: nar(id), remoteId: rid(id), ...d } },
  });

  // Debit-encoded discount (draftToPayload, the /voucher screen): Dr party, Dr TRADE DISCOUNTS,
  // Cr tax; goods on the stock line. Taxable = goods − discount (CGST Act s.15).
  const dGoods = 2000, dDisc = 150, dRate = rateOf(itA);
  const dHalf = r2((dGoods - dDisc) * dRate / 200), dExact = r2(dGoods - dDisc + 2 * dHalf), dGrand = Math.round(dExact), dRo = r2(dGrand - dExact);
  const longNarr = nar("S33", `& <tag> "quoted" 'single' ₹ মাল — ${"long narration segment ".repeat(40)}end`);

  const S: Scenario[] = [
    q("S01", "Sales invoice, local registered, CGST+SGST", "ok", localDebtor!, [line(itA, 2, 250)]),
    q("S01x", "S01 at a new quantity (edit source, not pushed)", "ok", localDebtor!, [line(itA, 3, 250)], { number: num("S01"), remoteId: rid("S01"), narration: nar("S01") }, { buildOnly: true }),
    q("S02", "Sales invoice, interstate registered, IGST", "ok", interDebtor!, [line(itA, 1, 400)]),
    q("S03", "Sales invoice, unregistered party ledger", "ok", unregDebtor!, [line(itB, 4, 75)]),
    { id: "S04", what: "Cash sale, buyer name + address with XML-hostile characters", expect: "ok",
      spec: { builder: "cash", date: today, number: num("S04"), remoteId: rid("S04"), narration: nar("S04"),
        buyer: { name: `O'BRIEN & SONS <"TEST"> ₹`, address: "12 TEST LANE & CO\nBARASAT 700124" }, lines: [line(itB, 2, 120)] } },
    { id: "S05", what: "Cash sale, goods EXACTLY ₹50,000 (e-way boundary, allowed)", expect: "ok",
      spec: { builder: "cash", date: today, number: num("S05"), remoteId: rid("S05"), narration: nar("S05"),
        buyer: { name: "STRESS WALKIN FIFTY", address: "1 TEST ROAD\nKOLKATA 700001" }, lines: [line(itA, 1, 50000)] } },
    { id: "S06", what: "Cash sale, goods ₹50,000.50 (over the limit, refused)", expect: "guard", because: /over the ₹50000 limit/,
      spec: { builder: "cash", date: today, number: num("S06"), remoteId: rid("S06"), narration: nar("S06"),
        buyer: { name: "STRESS WALKIN OVER", address: "1 TEST ROAD\nKOLKATA 700001" }, lines: [line(itA, 1, 50000.5)] } },
    q("S07", "Multi-line, mixed GST slabs", "ok", localDebtor!, [line(itA, 1, 310), line(itB, 3, 95.5), line(itC, 2, 47.25)]),
    q("S08", "Trade discount, native NEGATIVE-CREDIT encoding (salesOrderToPayload shares)", "ok", localDebtor!,
      [line(itA, 2, 500), line(itB, 1, 300)], { shares: [60, 15] }),
    draft("S09", "Trade discount, DEBIT encoding (draftToPayload)", "ok", {
      voucherType: "Sales", partyLedgerName: localDebtor!.name,
      lines: [
        { ledgerName: localDebtor!.name, side: "dr", amount: dGrand },
        { ledgerName: L.disc, side: "dr", amount: dDisc, appropriateToGst: "Goods" },
        { ledgerName: L.outC, side: "cr", amount: dHalf }, { ledgerName: L.outS, side: "cr", amount: dHalf },
        ...(dRo ? [{ ledgerName: L.ro, side: "cr", amount: Math.abs(dRo), ...(dRo < 0 ? { negative: true } : {}) }] : []),
      ],
      items: [{ stockItemName: itA.name, quantity: 4, unit: itA.baseUnit, rate: dGoods / 4, accountLedgerName: L.salesWb, godownName: "Main Location", batchName: "Primary Batch" }],
    }),
    q("S10", "Same item twice at two rates (two batch/godown lines)", "ok", localDebtor!, [line(itB, 2, 100), line(itB, 3, 90)]),
    q("S11", "Rounding plug UP (positive credit)", "ok", localDebtor!, [line(itA, 1, rateForRounding(rateOf(itA), 1))]),
    q("S12", "Rounding plug DOWN (negative credit)", "ok", localDebtor!, [line(itA, 1, rateForRounding(rateOf(itA), -1))]),
    q("S13", "Sales Order Note", "ok", localDebtor!, [line(itB, 5, 60)], { kind: "order" }),
    { id: "S14", what: "Order S13 billed in place: Alter, same REMOTEID, new number", expect: "ok",
      spec: { builder: "convert", from: "S13", invoiceNumber: num("S14") } },
    /* M1 (web handoff/phase2/GUARDRAILS.md), owner 20-Oct-2026: "the trade discount got
       put, but the freight wasn't offset against it". The billing modal now sends the
       order's identity with the posting draft's content; Tally must hold ONE netted
       TRADE DISCOUNTS / H.C. line = discount − freight, in both directions. */
    q("S13c", "Sales Order Note to bill WITH charges (M1)", "ok", localDebtor!, [line(itB, 4, 75)], { kind: "order" }),
    { id: "S14c", what: "Order S13c billed with discount 150 and freight 60: ONE H.C. line of 90 (M1)", expect: "ok",
      spec: { builder: "convertWithCharges", from: "S13c", invoiceNumber: num("S14c"), discount: 150, handling: 60, gstRate: rateOf(itB) } },
    q("S13d", "Sales Order Note to bill with freight above the discount (M1)", "ok", localDebtor!, [line(itB, 2, 80)], { kind: "order" }),
    { id: "S14d", what: "Order S13d billed with discount 50 and freight 120: ONE H.C. line, a charge of 70 (M1)", expect: "ok",
      spec: { builder: "convertWithCharges", from: "S13d", invoiceNumber: num("S14d"), discount: 50, handling: 120, gstRate: rateOf(itB) } },
    /* M4/M6 (web handoff/phase2/GUARDRAILS.md), owner 20-Oct-2026: a typed line of
       packages AND loose pieces is pushed as two rows of the same item, package rows
       first in typed order, then loose rows, one per-piece rate. 2.5 packs of 4 = 8 + 2. */
    q("S07L", "Loose split: 2 pkgs + 2 loose of one item, a whole item between (M4)", "ok", localDebtor!,
      [{ ...line(itB, 2.5, 60), unitsPerPkg: 4 }, line(itA, 1, 310)]),
    { id: "S15", what: "Alter S01's amount (buildEditPayload) — must leave ONE voucher", expect: "ok",
      spec: { builder: "edit", from: "S01", action: "alter", editedFrom: "S01x" } },
    { id: "S16", what: "Cancel S03 (ACTION=Cancel)", expect: "ok", spec: { builder: "edit", from: "S03", action: "cancel" } },
    // Delete of a SALES voucher is refused by the web's own policy (domain/editability: the party has a copy, cancel instead).
    { id: "S17", what: "Delete S02 (a Sales invoice) from the app — policy says cancel", expect: "builder",
      spec: { builder: "edit", from: "S02", action: "delete" } },
    { id: "S18", what: "S04 pushed again, byte-identical (idempotent)", expect: "ok",
      spec: { builder: "cash", date: today, number: num("S04"), remoteId: rid("S04"), narration: nar("S04"),
        buyer: { name: `O'BRIEN & SONS <"TEST"> ₹`, address: "12 TEST LANE & CO\nBARASAT 700124" }, lines: [line(itB, 2, 120)] } },
    purchase("S20", "Purchase, local supplier (CGST+SGST input)", localSupplier!, [[itA, 1200], [itB, 800]]),
    purchase("S21", "Purchase, interstate supplier (IGST input)", interSupplier!, [[itA, 1500]]),
    { ...purchase("S22", "Purchase S20 altered (amount change, meta.updates)", localSupplier!, [[itA, 1300], [itB, 800]],
      { updates: { voucherNumber: num("S20"), date: today }, narration: nar("S20") }, rid("S20"), num("S20")) },
    money("S23", "Receipt on account (bank, UTR)", "ok", { kind: "receipt", partyLedgerName: localDebtor!.name, partyLedgerId: localDebtor!.name,
      amount: 1234.5, accountLedgerName: bank!.name, instrumentNumber: "UTRSTRESS23", transferMode: "NEFT" }),
    ...(recvBill ? [money("S24", `Receipt settling OLD bill ${recvBill.name} (Agst Ref)`, "ok", { kind: "receipt", partyLedgerName: recvBill.party,
      partyLedgerId: recvBill.party, amount: 100, accountLedgerName: L.cash }, [webBill(recvBill)])] : []),
    ...(payBill ? [money("S25", `Payment settling OLD bill ${payBill.name} (Agst Ref)`, "ok", { kind: "payment", partyLedgerName: payBill.party,
      partyLedgerId: payBill.party, amount: 100, accountLedgerName: L.cash }, [webBill(payBill)])] : []),
    ...(foreign ? [money("S26", `Receipt citing ANOTHER party's bill ${foreign.name} (${foreign.party})`, "guard",
      { kind: "receipt", partyLedgerName: localDebtor!.name, partyLedgerId: localDebtor!.name, amount: 50, accountLedgerName: L.cash },
      [{ billRef: foreign.name, date: isoBillDate(foreign.date) || back, outstanding: foreign.outstanding, daysPastDue: 30 }], { because: /not an open bill/ })] : []),
    money("S27", "Payment on account (cash)", "ok", { kind: "payment", partyLedgerName: localSupplier!.name, partyLedgerId: localSupplier!.name,
      amount: 321, accountLedgerName: L.cash }),
    money("S28", "Contra cash → bank", "ok", { kind: "contra", partyLedgerName: "", partyLedgerId: "", amount: 500, accountLedgerName: bank!.name, contraFromLedgerName: L.cash }),
    { id: "S28d", what: "Delete S28 (Contra) by REMOTEID", expect: "ok", spec: { builder: "edit", from: "S28", action: "delete" } },
    draft("S29", "Journal (expense reclass, numbering None)", "ok", { voucherType: "Journal", partyLedgerName: expenses[0].name,
      lines: [{ ledgerName: expenses[0].name, side: "dr", amount: 77 }, { ledgerName: expenses[1].name, side: "cr", amount: 77 }] }),
    { id: "S30", what: "Credit note (buildCreditNote) — never automated", expect: "guard", because: /never automated/,
      spec: { builder: "creditNote", date: today, number: num("S30"), remoteId: rid("S30"), narration: nar("S30"),
        items: [{ name: itA.name, baseUnit: itA.baseUnit }],
        source: { voucherNumber: num("S07"), partyName: localDebtor!.name, lines: [
          { type: "inventory", itemId: itA.name, qtyBase: 1, ratePerBase: 310, lineAmount: 310 },
          { type: "ledger", ledgerName: localDebtor!.name, amount: 366, isPartyLine: true },
          { type: "ledger", ledgerName: L.salesWb, amount: 310 },
          { type: "ledger", ledgerName: L.outC, amount: 27.9 }, { type: "ledger", ledgerName: L.outS, amount: 27.9 },
        ] },
        lines: [{ itemId: itA.name, name: itA.name, qty: 1 }] } },
    { id: "S31a", what: "Cheque batch payment #1 (chequeToDraft)", expect: "ok", spec: { builder: "cheque", number: num("S31a"), remoteId: rid("S31a"), narration: nar("S31a"),
      cheque: { chequeNumber: "990031", date: today, partyLedgerName: localSupplier!.name, amount: 2100, bankLedgerName: bank!.name } } },
    { id: "S31b", what: "Cheque batch payment #2 (chequeToDraft)", expect: "ok", spec: { builder: "cheque", number: num("S31b"), remoteId: rid("S31b"), narration: nar("S31b"),
      cheque: { chequeNumber: "990032", date: today, partyLedgerName: interSupplier!.name, amount: 1900, bankLedgerName: bank!.name } } },
    ...(recvBill ? [{ id: "S32", what: "correctReceiptAmount on S24 (Alter, surplus On Account)", expect: "ok" as Expect,
      spec: { builder: "correctReceipt", from: "S24", amount: 150 } }] : []),
    q("S34a", "Party name with a TRAILING space", "guard", { ...localDebtor!, name: `${localDebtor!.name} ` }, [line(itB, 1, 99)], {}, { because: /does not exist/ }),
    q("S34b", "Party name with a DOUBLE space", "guard", { ...localDebtor!, name: localDebtor!.name.replace(" ", "  ") }, [line(itB, 1, 99)], {}, { because: /does not exist/ }),
    q("S35a", "Stock item that does not exist", "guard", localDebtor!, [{ ...line(itB, 1, 99), name: `${itB.name} STRESS-NO-SUCH` }], {}, { because: /does not exist/ }),
    draft("S35b", "Ledger that does not exist (single-space SALES ( GST W.B. ))", "guard", {
      voucherType: "Sales", partyLedgerName: localDebtor!.name,
      lines: [{ ledgerName: localDebtor!.name, side: "dr", amount: 118 }, { ledgerName: L.outC, side: "cr", amount: 9 }, { ledgerName: L.outS, side: "cr", amount: 9 }],
      items: [{ stockItemName: itA.name, quantity: 1, unit: itA.baseUnit, rate: 100, accountLedgerName: "SALES ( GST W.B. )", godownName: "Main Location", batchName: "Primary Batch" }],
    }, { because: /does not exist/ }),
    q("S36a", "Zero-quantity line", "guard", localDebtor!, [line(itB, 0, 99), line(itA, 1, 100)], {}, { because: /must be positive|positive magnitude/ }),
    draft("S36b", "Negative ledger amount", "guard", { voucherType: "Receipt", partyLedgerName: localDebtor!.name,
      lines: [{ ledgerName: L.cash, side: "dr", amount: -100 }, { ledgerName: localDebtor!.name, side: "cr", amount: -100 }] }, { because: /negative amount/ }),
    { ...q("S37", "Backdated within the open period", "ok", localDebtor!, [line(itA, 1, 180)]), spec: { ...q("S37", "", "ok", localDebtor!, [line(itA, 1, 180)]).spec, date: back } },
    { id: "S38", what: "invoiceFromOrder (Tally-native order → new invoice)", expect: "ok", spec: { builder: "invoiceFromOrder", number: num("S38"), remoteId: rid("S38"),
      narration: nar("S38"), date: today, interState: false, rates: { [itB.name]: rateOf(itB), [itC.name]: rateOf(itC) },
      items: [{ name: itB.name, baseUnit: itB.baseUnit }, { name: itC.name, baseUnit: itC.baseUnit }],
      order: { voucherNumber: "NATIVE-ORDER-STRESS", partyName: localDebtor!.name, lines: [
        { type: "inventory", itemId: itB.name, qtyBase: 2, ratePerBase: 88 }, { type: "inventory", itemId: itC.name, qtyBase: 1, ratePerBase: 64 },
      ] } } },
    /* W5 (web handoff/phase2/GUARDRAILS.md M9), owner 20-Oct-2026: a delivery note typed in Tally
       is COPIED as a website-owned Sales Order Note (our REMOTEID, new number), discount carried. */
    { id: "S38n", what: "noteCopyFromOrder (Tally-typed note → website note copy, discount carried) (M9)", expect: "ok",
      spec: { builder: "noteCopy", number: num("S38n"), remoteId: rid("S38n"),
      narration: nar("S38n"), date: today, interState: false, rates: { [itB.name]: rateOf(itB), [itC.name]: rateOf(itC) },
      items: [{ name: itB.name, baseUnit: itB.baseUnit }, { name: itC.name, baseUnit: itC.baseUnit }],
      order: { voucherNumber: "NATIVE-NOTE-STRESS", partyName: localDebtor!.name, lines: [
        { type: "inventory", itemId: itB.name, qtyBase: 3, ratePerBase: 88 }, { type: "inventory", itemId: itC.name, qtyBase: 2, ratePerBase: 64 },
        { type: "ledger", ledgerName: "TRADE DISCOUNTS / H.C.", signedAmount: -20 },
      ] } } },
    q("S33", "XML-hostile + unicode + very long narration", "ok", localDebtor!, [line(itB, 1, 99)], { narration: longNarr }),
    // LAST: the two that make Tally itself refuse (a taken number). Health is asked after each.
    { ...q("S19", "S07's lines under S01's NUMBER and a NEW REMOTEID (app-assigned number)", "ok", localDebtor!, [line(itB, 1, 55)]),
      spec: { ...q("S19", "", "ok", localDebtor!, [line(itB, 1, 55)]).spec, number: num("S01") } },
    { ...q("S19o", "S01's NUMBER typed as an override, new REMOTEID — must be refused, never renumbered", "tally-reject", localDebtor!, [line(itB, 1, 56)]),
      spec: { ...q("S19o", "", "ok", localDebtor!, [line(itB, 1, 56)]).spec, number: num("S01") },
      mutate: (p: VoucherPayload) => ({ ...p, numberOverride: true }) },
  ];

  const built = emit(company, S);
  if (typeof built === "string") { check("TG-P33", false, built); return; }

  // ── Baseline ───────────────────────────────────────────────────────────────
  const dates = [...new Set([today, back])];
  const readDay = async (d: string) => {
    const xml = buildCollection({ id: "MkStressDay", type: "Voucher", company, fetch: [...READ_FIELDS, "MasterId"], filter: onDate(d.replace(/-/g, "")) });
    return blocksOf(String(await tallyPost(url, xml, 180_000, true)), "VOUCHER").map((b) => `<VOUCHER ${b}`);
  };
  const isOurs = (b: string) => /CLAUDE-TEST STRESS /.test(tag(b, "NARRATION"));
  const idOf = (b: string) => /CLAUDE-TEST STRESS (\S+)/.exec(tag(b, "NARRATION"))?.[1] ?? "";
  const { resetGate } = await import("../../src/services/tallyGate.js");

  /* The Delete for each STRESS voucher Tally HOLDS, built from the last payload
     pushed under its REMOTEID (scenario order) — so a converted order is
     deleted as the Sales it became, a renumbered one under its stored number.
     Driven by the read-back, never by a success list: safePush ok:false does
     not mean nothing landed (CLAUDE.md). */
  const lastByRid = new Map<string, VoucherPayload>();
  for (const sc of S) {
    const p = built.get(sc.id)?.payload;
    if (!p || sc.buildOnly || p.action === "Delete" || !p.remoteId) continue;
    lastByRid.set(p.remoteId, sc.mutate ? sc.mutate(p) : p);
  }
  const deleteStored = async (blocks: string[]): Promise<number> => {
    let failed = 0;
    for (const b of blocks) {
      const id = idOf(b), r = rid(id), p = lastByRid.get(r);
      if (!p) { check("TG-P34", false, `stored STRESS voucher "${id}" (${tag(b, "VOUCHERNUMBER")}) maps to no known REMOTEID — delete it by hand`); failed++; continue; }
      if (!(await healthy())) { check("TG-P34", false, `Tally stopped answering during cleanup at ${r} — restart TallyPrime`); return failed + 1; }
      resetGate();
      const number = tag(b, "VOUCHERNUMBER") || p.voucherNumber;
      const res = await safePush(url, company, { ...p, voucherNumber: number, action: "Delete" });
      check("TG-P34", res.ok, `Delete ${r} (${number}): ${res.stage} ${res.errors.join(" | ").slice(0, 200)}`);
      console.log(`  ✂ ${r} ${number} ${res.ok ? "deleted" : `NOT deleted: ${res.errors[0] ?? res.stage}`}`);
      if (!res.ok) failed++;
    }
    return failed;
  };

  const baseline: Record<string, number> = {};
  for (const d of dates) {
    const blocks = await readDay(d);
    const left = blocks.filter(isOurs);
    baseline[d] = blocks.length - left.length;
    console.log(`  baseline ${d}: ${blocks.length} voucher(s)${left.length ? `, ${left.length} STRESS left over from an earlier run` : ""}`);
    if (left.length && !clean) throw new Error(`STRESS vouchers already on ${d} (${left.map((b) => tag(b, "VOUCHERNUMBER") || idOf(b)).join(", ")}) — run --stress-clean first`);
    if (left.length && !dry) await deleteStored(left);
  }
  if (clean) {
    for (const d of dates) {
      const after = await readDay(d);
      const left = after.filter(isOurs);
      check("TG-P34", !left.length && after.length === baseline[d], `${d}: ${after.length} after clean (non-STRESS baseline ${baseline[d]})${left.length ? `; left: ${left.map(idOf).join(", ")}` : ""}`);
      console.log(`  after clean ${d}: ${after.length} (non-STRESS ${baseline[d]})`);
    }
    return;
  }

  // ── Push, one at a time ─────────────────────────────────────────────────────
  /** Latest payload per REMOTEID — what the cleanup Delete is built from. */
  const latest = new Map<string, VoucherPayload>();
  const outcomes: { id: string; what: string; expect: Expect; got: string; ok: boolean; detail: string }[] = [];
  let stopped = "";
  let masterS13 = "";
  for (const s of S) {
    const row = built.get(s.id);
    const label = `[stress ${s.id}] ${s.what}`;
    if (!row) { check("TG-P33", false, `${label}: emitter returned nothing`); continue; }
    if (s.buildOnly) continue;
    if (row.error) {
      const ok = s.expect === "builder" || (s.expect === "guard" && /^REFUSED/.test(row.error));
      outcomes.push({ id: s.id, what: s.what, expect: s.expect, got: "builder refused", ok, detail: row.error.slice(0, 200) });
      check("TG-P33", ok, `${label}: web builder ${ok ? "refused" : "FAILED"}: ${row.error.slice(0, 300)}`);
      continue;
    }
    let p = row.payload!;
    if (s.mutate) p = s.mutate(p);
    check("TG-P33", /^MKCP\|STRESS\|/.test(p.remoteId ?? "") && !/^MKCP-/.test(p.voucherNumber ?? ""), `${label}: identity ${p.remoteId} / ${p.voucherNumber} is not a STRESS one`);

    if (dry) {
      const g = guardVoucher(p, m, { openBills: bills });
      const ok = s.expect === "guard" ? !g.ok && (!s.because || g.errors.some((e) => s.because!.test(e))) : g.ok;
      console.log(`  ${ok ? "·" : "✗"} ${s.id} dry guard ${g.ok ? "ok" : "REFUSED"} — ${[...g.errors].join(" | ").slice(0, 400)}`);
      outcomes.push({ id: s.id, what: s.what, expect: s.expect, got: g.ok ? "guard ok" : "guard refused", ok, detail: g.errors.join(" | ").slice(0, 200) });
      continue;
    }

    if (!(await healthy())) { stopped = `Tally stopped answering HEALTH before ${s.id} — restart TallyPrime`; break; }
    resetGate();
    console.log(`  → ${s.id} ${p.action ?? "Create"} ${p.voucherType} ${p.voucherNumber} (${p.remoteId})`);
    let res: SafePushResult;
    try { res = await safePush(url, company, p); }
    catch (e) { stopped = `${s.id}: safePush threw ${(e as Error).message} — STOP (Tally may be behind a dialog)`; break; }
    const why = [...res.errors, ...res.differences].join(" | ");
    const got = res.ok ? `ok (${res.stage})` : `${res.stage}: ${why.slice(0, 160)}`;
    let ok: boolean;
    if (s.expect === "ok") ok = res.ok && res.stage === "done";
    else if (s.expect === "guard") ok = !res.ok && res.stage === "guard" && (!s.because || res.errors.some((e) => s.because!.test(e)));
    else ok = !res.ok && res.stage === "push";
    outcomes.push({ id: s.id, what: s.what, expect: s.expect, got, ok, detail: why.slice(0, 300) });
    check("TG-P33", ok, `${label}: expected ${s.expect}, got ${got}`);
    for (const w of res.warnings.filter((x) => /numbered "/.test(x))) console.log(`     ${w}`);
    if (res.ok || res.stage !== "guard") {
      // Anything that reached Tally may be in the books (ok:false does not mean nothing landed).
      const renum = res.warnings.map((w) => /numbered "([^"]+)" instead/.exec(w)?.[1]).find(Boolean);
      const final = renum ? { ...p, voucherNumber: renum } : p;
      if (p.action === "Delete" && res.ok) latest.delete(p.remoteId!); else latest.set(p.remoteId!, { ...final, action: undefined });
    }
    // MASTERID must survive the order → invoice conversion (tally-order-to-invoice-conversion).
    if ((s.id === "S13" || s.id === "S14") && res.ok) {
      const b = (await readDay(today)).find((x) => /CLAUDE-TEST STRESS S13(\s|$)/.test(tag(x, "NARRATION")));
      const mid = b ? tag(b, "MASTERID") : "";
      if (s.id === "S13") masterS13 = mid;
      else check("TG-P33", !!masterS13 && mid === masterS13, `[stress S14] MASTERID before conversion "${masterS13}", after "${mid}" — the Alter minted a new voucher`);
      console.log(`     MASTERID ${s.id === "S13" ? "before" : "after"} conversion: ${mid || "(none)"}`);
    }
    if (res.stage === "push") {
      // Tally refused. Expected only for S19o; either way, nothing more goes until it answers.
      if (!(await healthy())) { stopped = `Tally stopped answering after ${s.id} (${got}) — restart TallyPrime`; break; }
      if (!ok) { stopped = `${s.id}: unexpected Tally refusal (${got}) — STOP per the hard rule`; break; }
    }
  }
  if (dry) { printMatrix(outcomes); return; }

  // ── Read back and audit what Tally STORED ──────────────────────────────────
  const stored: string[] = [];
  if (!stopped) for (const d of dates) stored.push(...(await readDay(d)).filter(isOurs));
  const byId = new Map<string, string[]>();
  for (const b of stored) byId.set(idOf(b), [...(byId.get(idOf(b)) ?? []), b]);
  console.log(`  read back ${stored.length} STRESS voucher(s)`);
  const one = (id: string, label: string) => {
    const n = byId.get(id)?.length ?? 0;
    check("TG-P33", n === 1, `[stress ${id}] ${label}: ${n} voucher(s) stored, expected exactly 1`);
    return byId.get(id)?.[0];
  };
  if (!stopped) {
    for (const b of stored) {
      const v = parseVoucher(b, "stored");
      const id = idOf(b);
      if (/^yes$/i.test(tag(b, "ISCANCELLED"))) continue;
      const cash = id === "S04" ? `O'BRIEN & SONS <"TEST"> ₹` : id === "S05" ? "STRESS WALKIN FIFTY" : undefined;
      checkVoucherShape(v, { masters: m, expectMailing: cash, label: `[stored ${id}]` });
    }
    // Exactly one voucher per number for the ones that were pushed twice / altered / converted.
    const s01 = one("S01", "Alter of S01");
    if (s01) {
      const party = parseVoucher(s01, "stored").ledgers.find((l) => l.ledger === localDebtor!.name);
      const want = built.get("S01x")?.payload?.ledgerEntries.find((e) => e.isPartyLedger)?.amount;
      check("TG-P33", !!party && !!want && Math.abs(Math.abs(party.amount) - want) < 0.02, `[stress S15] Alter did not change S01's amount (stored ${party?.amount}, wanted ${want})`);
    }
    one("S04", "double push of S04");
    const conv = one("S13", "order S13 converted by S14");
    if (conv) {
      check("TG-P33", /^SALES$/i.test(tag(conv, "VOUCHERTYPENAME")) && tag(conv, "VOUCHERNUMBER") === num("S14"),
        `[stress S14] converted voucher reads ${tag(conv, "VOUCHERTYPENAME")} ${tag(conv, "VOUCHERNUMBER")}, expected SALES ${num("S14")}`);
      const s13 = latest.get(rid("S13"));
      void s13;
    }
    // M1: a converted order carries exactly ONE netted H.C. line of discount − freight.
    for (const [ord, inv, want, kind] of [["S13c", "S14c", 90, "discount"], ["S13d", "S14d", 70, "charge"]] as const) {
      const v = one(ord, `order ${ord} converted with charges by ${inv}`);
      if (!v) continue;
      check("TG-P33", /^SALES$/i.test(tag(v, "VOUCHERTYPENAME")) && tag(v, "VOUCHERNUMBER") === num(inv),
        `[stress M1 ${inv}] reads ${tag(v, "VOUCHERTYPENAME")} ${tag(v, "VOUCHERNUMBER")}, expected SALES ${num(inv)}`);
      const hc = parseVoucher(v, "stored").ledgers.filter((l) => /TRADE\s*DISCOUNT/i.test(l.ledger));
      check("TG-P33", hc.length === 1 && Math.abs(Math.abs(hc[0].amount) - want) < 0.02,
        `[stress M1 ${inv}] ${hc.length} H.C. line(s) (${hc.map((h) => h.amount).join(", ")}), wanted ONE of ${want} (${kind})`);
      console.log(`     M1 ${inv}: H.C. ${hc.map((h) => h.amount).join(", ")} (want ${want}, ${kind})`);
    }
    // M4/M6: the stored loose voucher holds itB 8, itA 1, itB 2 in that order, one rate.
    const loose = one("S07L", "loose split S07L");
    if (loose) {
      const st = parseVoucher(loose, "stored").stock;
      const got = st.map((s) => `${s.item} ${Math.abs(s.amount)}`);
      const want = [`${itB.name} ${8 * 60}`, `${itA.name} 310`, `${itB.name} ${2 * 60}`];
      check("TG-P33", got.length === 3 && got.every((g, i) => g === want[i]),
        `[stress M4 S07L] stored rows [${got.join(" | ")}], wanted [${want.join(" | ")}]`);
      console.log(`     M4 S07L: ${got.join(" | ")}`);
    }
    const s03 = one("S03", "cancelled S03");
    if (s03) check("TG-P04", /^yes$/i.test(tag(s03, "ISCANCELLED")), `[stress S16] S03 reads ISCANCELLED="${tag(s03, "ISCANCELLED")}"`);
    check("TG-P33", !byId.has("S28"), `[stress S28d] S28 still stored after Delete by REMOTEID`);
    one("S02", "S02 (its app Delete was refused, so it must still be there)");
    one("S20", "purchase S20 altered by S22");
    const withS01Number = stored.filter((b) => tag(b, "VOUCHERNUMBER") === num("S01"));
    check("TG-P03", withS01Number.length === 1, `[stress S19] ${withS01Number.length} vouchers carry number ${num("S01")} — a duplicate number was accepted`);
    // A sales invoice is a receivable: its party line carries a New Ref named for ITS OWN stored number.
    for (const id of ["S01", "S07", "S13", "S19", "S38"]) {
      const b = byId.get(id)?.[0];
      if (!b) continue;
      const number = tag(b, "VOUCHERNUMBER");
      const refs = [...b.matchAll(/<BILLALLOCATIONS\.LIST>([\s\S]*?)<\/BILLALLOCATIONS\.LIST>/g)].map((x) => `${tag(x[1], "BILLTYPE")}:${tag(x[1], "NAME")}`).filter((x) => x !== ":");
      check("TG-P33", refs.includes(`New Ref:${number}`), `[stress ${id}] stored ${number} carries bill refs [${refs.join(", ")}], expected "New Ref:${number}"`);
    }
    // M9: the copy is a Sales Order Note of ours, both stock lines, ONE H.C. line of 20 (discount).
    const copy = one("S38n", "note copy S38n");
    if (copy) {
      const pv = parseVoucher(copy, "stored");
      const hc = pv.ledgers.filter((l) => /TRADE\s*DISCOUNT/i.test(l.ledger));
      check("TG-P33", /SALES ORDER NOTE/i.test(pv.type) && pv.stock.length === 2 && hc.length === 1 && Math.abs(Math.abs(hc[0].amount) - 20) < 0.02,
        `[stress M9 S38n] stored ${pv.type}, ${pv.stock.length} stock line(s), H.C. [${hc.map((h) => h.amount).join(", ")}], wanted SALES ORDER NOTE, 2, [20]`);
      console.log(`     M9 S38n: ${pv.type} ${pv.number}, stock ${pv.stock.length}, H.C. ${hc.map((h) => h.amount).join(", ")}`);
    }
    check("TG-P33", !byId.has("S19o"), `[stress S19o] an overridden duplicate number landed in the books`);
    if (recvBill) {
      const s24 = one("S24", "receipt S24 corrected by S32");
      if (s24) {
        const party = parseVoucher(s24, "stored").ledgers.find((l) => l.ledger === recvBill.party);
        check("TG-P33", !!party && Math.abs(Math.abs(party.amount) - 150) < 0.02, `[stress S32] corrected receipt reads ${party?.amount}, expected 150`);
      }
      // The Agst Ref survived as an Agst Ref (TG-P20) — on the stored bill allocation.
      const agst = s24 && /<BILLTYPE>Agst Ref<\/BILLTYPE>/.test(s24) && s24.includes(`<NAME>${recvBill.name.replace(/&/g, "&amp;")}</NAME>`);
      if (s24) check("TG-P20", !!agst, `[stress S24] stored receipt does not cite ${recvBill.name} as Agst Ref`);
    }
    // MASTERID kept through the order → invoice conversion: one voucher, read before and after
    // is not possible after the fact, so the conversion's single surviving voucher (above) is
    // the proof that no second MASTERID was minted.
  }

  // ── Cleanup: Delete every STRESS voucher by REMOTEID ───────────────────────
  if (stopped) {
    console.log(`\n  ✗ STOPPED: ${stopped}\n  NOT cleaning up — these REMOTEIDs may be in the sandbox: ${[...latest.keys()].join(", ")}`);
    check("TG-P33", false, `run stopped: ${stopped}`);
    printMatrix(outcomes);
    return;
  }
  await deleteStored(stored);
  for (const d of dates) {
    const after = await readDay(d);
    const left = after.filter(isOurs);
    check("TG-P34", after.length === baseline[d] && !left.length,
      `${d}: ${after.length} voucher(s) after cleanup vs ${baseline[d]} before${left.length ? `; STRESS left: ${left.map(idOf).join(", ")}` : ""}`);
    console.log(`  after cleanup ${d}: ${after.length} (baseline ${baseline[d]})`);
  }
  printMatrix(outcomes);
}

function printMatrix(rows: { id: string; what: string; expect: string; got: string; ok: boolean }[]): void {
  console.log(`\n  ── stress matrix ──`);
  for (const r of rows) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(5)} expect ${r.expect.padEnd(12)} ${r.what.slice(0, 70).padEnd(70)}  → ${r.got.slice(0, 120)}`);
}
