/**
 * T11 rigs C22, C23, C25, C26, C26b and C29 on the dummy Tally (file 05 section C, tests still to run).
 *
 *   C22  a Stock Journal from a warehouse count difference
 *   C23  a purchase with items Tally lacks: the refusal, the items, then the purchase
 *   C25  a truck run of 4 notes converted after Process (discount and freight, appropriated to GST)
 *   C26  one note split into cash bills and a ledger bill, totals to the paisa
 *   C26b the split's edges: three refusals, one line's quantity shared across two bills
 *   C29  a freight bill under reverse charge, its tax journal, and its payment
 *
 * One part per run, one process at a time on the dummy (the Tally slot):
 *
 *   $env:MKCP_TALLY_ROLE is sandbox (from server/.env). Run from server/:
 *   npx tsx scripts/rigs/t11-first-priority.ts --part c23 [--out <file.json>] [--expect N]
 *   npx tsx scripts/rigs/t11-first-priority.ts --cleanup <stamp>      (remove what a crashed run left)
 *
 * Safety (file 05 section 0), enforced in code before any write: sandbox role and loopback (guardScriptWrites),
 * the one company open is the dummy by GUID (preflight), fake data only (ZZ TEST names, ZZZ GSTINs, ZZTEST numbers).
 * Every write goes through safePush (guard, tallyPost, read-back). Each part deletes what it made by REMOTEID,
 * runs the sweep as a backstop, drops its ZZ TEST masters, and then CHECKS the books: the voucher count is what it
 * was and none of this run's stamp is left. Judge by the books, not by a success list.
 *
 * Never presses e-invoice or e-way send; the rigs send no IRN or e-way field at all.
 */
import "dotenv/config";
import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";
guardScriptWrites("rigs/t11-first-priority");
import { preflight } from "./lib/t11.js";
import { DUMMY_KIT, r2, saleTotals, zzItems, zzParties } from "./lib/t11Kit.js";
import { c23, c25, c26, c26b, c29 } from "./lib/t11Scenarios.js";
import { stockJournalScenario } from "./lib/t11StockJournal.js";
import { compareToPayload, failures, ledgerBrief } from "./lib/t11Check.js";
import {
  Recorder, byKey, census, countStored, dropItem, dropParty, freshMasters, indiaToday, makeItem, makeLive, makeParty,
  push, readStored, remove, stampFrom, sweepDay, asAlter, asCancel, type Live,
} from "./lib/t11Live.js";
import { storedInventoryLines } from "../../src/services/safePush.js";
import { loadOpenBills } from "../../src/services/billSettlement.js";
import { readTag, parseTallyAmount } from "../../src/services/xml.js";
import { gstRateFor, hsnFor } from "../../src/services/tallyMasters.js";
import { pull as pullAll, remoteIdGuesses } from "../find-stranded-test-vouchers.js";
import { tallyPost } from "../../src/tally.js";
import { escapeXml } from "../../src/services/xml.js";
import type { VoucherPayload } from "../../src/types.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const PART = (arg("--part") ?? "").toLowerCase();
const OUT = arg("--out");
const CLEANUP = arg("--cleanup");
const kit = DUMMY_KIT;
const num = (s: string) => parseTallyAmount(s) ?? NaN;

/** Checks each part is expected to make, learned from its first full live run. -1 = not yet calibrated. */
const EXPECTED: Record<string, number> = { c22: -1, c23: -1, c25: -1, c26: -1, c26b: -1, c29: -1 };

/** What a part made, so teardown can undo it whatever happens in the middle. */
class Made {
  vouchers: VoucherPayload[] = [];
  parties: string[] = [];
  items: string[] = [];
  track(p: VoucherPayload) { const i = this.vouchers.findIndex((v) => v.remoteId === p.remoteId); if (i >= 0) this.vouchers[i] = p; else this.vouchers.push(p); }
}

async function body(part: string, l: Live, rec: Recorder, made: Made): Promise<void> {
  const day = l.day, stamp = l.stamp;
  /** Push through safePush; record one check; track the voucher for teardown (even on a failed verify the books may hold it). */
  const send = async (label: string, p: VoucherPayload, expectOk = true) => {
    const r = await push(l, p);
    made.track(p);
    const detail = r.ok ? `stage ${r.stage}` : `stage ${r.stage}: ${[...r.errors, ...r.differences].join(" | ").slice(0, 260)}`;
    rec.check(label, r.ok === expectOk, detail);
    return r;
  };
  const stored = async (p: VoucherPayload) => readStored(l, p.date, byKey(p));
  const fieldCheck = (label: string, p: VoucherPayload, v: string | null, partyOverwritten = false) => {
    if (!v) { rec.check(`${label}: every field we sent reads back as sent`, false, "the voucher could not be read"); return; }
    const res = compareToPayload(p, v, { partyOverwritten, derivedPostings: true });
    const bad = failures(res);
    rec.check(`${label}: every field we sent reads back as sent (${res.length} fields)`, bad.length === 0, bad.slice(0, 6).join(" | "));
    if (bad.length) rec.note(`${label} stored ledger lines: ${ledgerBrief(v)}`);
  };

  // ── C23 ──────────────────────────────────────────────────────────────────
  if (part === "c23") {
    const s = c23(stamp, day, kit);
    const sup = await makeParty(l, s.parties.supplier); made.parties.push(s.parties.supplier.name);
    rec.check("C23 supplier ledger made with the production builder (Punjab, ZZZ GSTIN)", sup.ok, sup.detail);
    const before = await census(l);
    const refused = await push(l, s.beforeItems);
    rec.check("C23 the purchase is REFUSED while Tally lacks the items (guard stage, says the item does not exist)",
      !refused.ok && refused.stage === "guard" && refused.errors.some((e) => /does not exist/i.test(e)), `${refused.stage}: ${refused.errors[0]?.slice(0, 150) ?? ""}`);
    rec.check("C23 nothing reached Tally for the refused purchase", (await countStored(l, day, { number: s.beforeItems.voucherNumber })) === 0);
    for (const it of s.items) { const r = await makeItem(l, it); made.items.push(it.name); rec.check(`C23 item "${it.name}" created with the C14 builder and read back with its GST`, r.ok, r.detail); }
    const m = await freshMasters(l);
    for (const it of s.items) {
      const got = m.items.get(it.name);
      rec.check(`C23 "${it.name}" is in the masters: base unit ${it.baseUnit}, GST ${it.gstRate} percent, HSN ${it.hsn}`,
        !!got && got.baseUnit === it.baseUnit && gstRateFor(m, it.name, day).rate === it.gstRate && hsnFor(m, it.name, day).code === it.hsn,
        got ? `rate ${gstRateFor(m, it.name, day).rate}, hsn ${hsnFor(m, it.name, day).code}` : "missing");
    }
    const r = await send("C23 the purchase of the new items is pushed and its read-back matches", s.purchase);
    rec.check("C23 safePush reports no differences", r.differences.length === 0, r.differences.join(" | ").slice(0, 200));
    const v = await stored(s.purchase);
    fieldCheck("C23 purchase", s.purchase, v);
    rec.check("C23 stored once (no duplicate)", (await countStored(l, day, { number: s.purchase.voucherNumber })) === 1);
    rec.check("C23 the supplier's invoice number and date are stored (REFERENCE, REFERENCEDATE)", !!v && readTag(v, "REFERENCE") === s.purchase.reference && readTag(v, "REFERENCEDATE") === day.replace(/-/g, ""), v ? `${readTag(v, "REFERENCE")} / ${readTag(v, "REFERENCEDATE")}` : "");
    const m2 = await freshMasters(l);
    for (const [name, qty] of s.expectedStock) rec.check(`C23 stock of "${name}" moved by the purchase`, Math.abs((m2.items.get(name)?.closingStock ?? NaN) - qty) < 0.001, `closing ${m2.items.get(name)?.closingStock}, expected ${qty}`);
    const again = await push(l, s.purchase);
    rec.check("C23 pushing the same purchase again is idempotent: still one voucher (same REMOTEID updates, never duplicates)", (await countStored(l, day, { number: s.purchase.voucherNumber })) === 1, again.ok ? "ok" : again.errors[0]?.slice(0, 120));
    void before;
    return;
  }

  // ── C25 ──────────────────────────────────────────────────────────────────
  if (part === "c25") {
    const s = c25(stamp, day, kit);
    for (const p of [s.parties.local, s.parties.inter]) { const r = await makeParty(l, p); made.parties.push(p.name); rec.check(`C25 party "${p.name}" made`, r.ok, r.detail); }
    for (const it of s.items) { const r = await makeItem(l, it); made.items.push(it.name); rec.check(`C25 item "${it.name}" made`, r.ok, r.detail); }
    await freshMasters(l);
    const masterIds = new Map<string, string>();
    for (const t of s.notes) {
      const n = s.noteOf(t);
      await send(`C25 ${t.tag} the note is pushed (a Sales Order Note: reserves stock, not an invoice)`, n);
      const v = await stored(n);
      masterIds.set(t.tag, v ? readTag(v, "MASTERID") : "");
      rec.check(`C25 ${t.tag} the note reads back as a Sales Order Note, not an invoice`, !!v && /sales order note/i.test(readTag(v, "VOUCHERTYPENAME")) && !/^yes$/i.test(readTag(v, "ISINVOICE")), v ? `${readTag(v, "VOUCHERTYPENAME")} / ISINVOICE ${readTag(v, "ISINVOICE")}` : "no read");
    }
    let sumParty = 0, expectParty = 0;
    for (const t of s.notes) {
      const inv = s.invoiceOf(t);
      const net = r2(t.freight - t.discount);
      const r = await send(`C25 ${t.tag} Process: the note is altered into a Sales invoice with discount ${t.discount} and freight ${t.freight}`, inv);
      rec.check(`C25 ${t.tag} safePush read-back has no differences`, r.differences.length === 0, r.differences.join(" | ").slice(0, 200));
      const v = await stored(inv);
      fieldCheck(`C25 ${t.tag} invoice`, inv, v);
      rec.check(`C25 ${t.tag} same voucher (same MASTERID as the note) and now type SALES`, !!v && readTag(v, "MASTERID") === masterIds.get(t.tag) && /^sales$/i.test(readTag(v, "VOUCHERTYPENAME")), v ? `${readTag(v, "MASTERID")} vs ${masterIds.get(t.tag)}; ${readTag(v, "VOUCHERTYPENAME")}` : "no read");
      rec.check(`C25 ${t.tag} the note is gone, one invoice stands`, (await countStored(l, day, { number: inv.voucherNumber })) === 1);
      if (v) {
        const lines = [...v.matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/g)].map((m) => m[1]);
        const adj = lines.filter((b) => readTag(b, "LEDGERNAME") === kit.discount);
        if (net === 0) rec.check(`C25 ${t.tag} no adjustment line`, adj.length === 0);
        else rec.check(`C25 ${t.tag} the adjustment is ONE line on ${kit.discount}: a credit, ${net < 0 ? "negative" : "positive"} ${net}, APPROPRIATEFOR GST`,
          adj.length === 1 && readTag(adj[0], "ISDEEMEDPOSITIVE") === "No" && Math.abs(num(readTag(adj[0], "AMOUNT")) - net) < 0.011 && readTag(adj[0], "APPROPRIATEFOR") === "GST",
          adj.length ? `${adj.length} line(s): side ${readTag(adj[0], "ISDEEMEDPOSITIVE")}, amount ${readTag(adj[0], "AMOUNT")}, appropriate ${readTag(adj[0], "APPROPRIATEFOR")}` : "no line stored");
        const party = lines.find((b) => readTag(b, "LEDGERNAME") === t.party.name);
        const stockedParty = party ? num(readTag(party, "AMOUNT")) : NaN;
        const want = saleTotals(inv).grand;
        sumParty += Math.abs(stockedParty); expectParty += want;
        rec.check(`C25 ${t.tag} the party owes ${want} (read back ${Math.abs(stockedParty)})`, Math.abs(Math.abs(stockedParty) - want) < 0.011);
      }
    }
    rec.check("C25 the four invoices add up to what the four notes plus adjustments say, to the paisa", Math.abs(r2(sumParty) - r2(expectParty)) < 0.011, `${r2(sumParty)} vs ${r2(expectParty)}`);
    const c = await census(l);
    rec.check("C25 exactly four vouchers of this run stand (the notes became the invoices, none left over)", c.mine === 4, `${c.mine}`);
    return;
  }

  // ── C26 ──────────────────────────────────────────────────────────────────
  if (part === "c26") {
    const s = c26(stamp, day, kit);
    const r0 = await makeParty(l, s.parties.local); made.parties.push(s.parties.local.name); rec.check("C26 ledger party made", r0.ok, r0.detail);
    for (const it of s.items) { const r = await makeItem(l, it); made.items.push(it.name); rec.check(`C26 item "${it.name}" made`, r.ok, r.detail); }
    await freshMasters(l);
    await send("C26 the whole order is pushed as ONE Sales Order Note (6 lines)", s.note);
    const nv = await stored(s.note);
    const noteQty = new Map<string, number>();
    for (const i of s.note.inventoryEntries!) noteQty.set(i.stockItemName, (noteQty.get(i.stockItemName) ?? 0) + i.quantity);
    rec.check("C26 the note reads back with 6 stock lines", !!nv && storedInventoryLines(nv).length === 6, nv ? `${storedInventoryLines(nv).length}` : "no read");
    const rl = await send("C26 Split: the note becomes the ledger bill (lines 1 and 2), same voucher", s.ledgerBill);
    rec.check("C26 ledger bill has no differences", rl.differences.length === 0, rl.differences.join(" | ").slice(0, 160));
    const lv = await stored(s.ledgerBill);
    fieldCheck("C26 ledger bill", s.ledgerBill, lv);
    const cashStored: (string | null)[] = [];
    for (const [i, b] of s.cashBills.entries()) {
      const r = await send(`C26 cash bill ${i + 1} is pushed on the Cash ledger with its buyer`, b);
      rec.check(`C26 cash bill ${i + 1} has no differences`, r.differences.length === 0, r.differences.join(" | ").slice(0, 160));
      const v = await stored(b); cashStored.push(v);
      fieldCheck(`C26 cash bill ${i + 1}`, b, v);
      rec.check(`C26 cash bill ${i + 1} stored the buyer: name and address on the voucher, ledger stays Cash`,
        !!v && readTag(v, "PARTYMAILINGNAME") === b.buyerName && readTag(v, "PARTYLEDGERNAME") === kit.cash && /KOLKATA/.test(v), v ? `${readTag(v, "PARTYMAILINGNAME")} / ${readTag(v, "PARTYLEDGERNAME")}` : "no read");
    }
    const bills = [s.ledgerBill, ...s.cashBills];
    const tot = bills.map(saleTotals);
    const stockQty = new Map<string, number>();
    for (const v of [lv, ...cashStored]) for (const m of (v ?? "").matchAll(/<ALLINVENTORYENTRIES\.LIST>([\s\S]*?)<\/ALLINVENTORYENTRIES\.LIST>/g)) {
      const name = readTag(m[1], "STOCKITEMNAME"); if (!name) continue;
      stockQty.set(name, (stockQty.get(name) ?? 0) + (parseTallyAmount(readTag(m[1], "ACTUALQTY")) ?? 0));
    }
    rec.check("C26 the three bills together hold exactly the note's quantities of each item", [...noteQty].every(([k, q]) => Math.abs((stockQty.get(k) ?? -1) - q) < 0.001), JSON.stringify([...stockQty]));
    rec.check("C26 taxable values add back to the note's to the paisa", r2(tot.reduce((a, t) => a + t.taxable, 0)) === s.whole.taxable, `${tot.map((t) => t.taxable).join(" + ")} vs ${s.whole.taxable}`);
    const taxSum = r2(tot.reduce((a, t) => a + t.tax, 0));
    rec.check("C26 tax adds back to the note's, within 2 paise (each bill rounds its own halves)", Math.abs(taxSum - s.whole.tax) <= 0.02, `${taxSum} vs ${s.whole.tax}`);
    rec.note(`C26 tax difference against the whole note: ${r2(taxSum - s.whole.tax)}; round-offs ${tot.map((t) => t.roundOff).join(", ")}`);
    const readParty = (v: string | null, name: string) => { const m = [...(v ?? "").matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/g)].map((x) => x[1]).find((b) => readTag(b, "LEDGERNAME") === name); return m ? Math.abs(num(readTag(m, "AMOUNT"))) : NaN; };
    const owed = [readParty(lv, s.parties.local.name), ...cashStored.map((v) => readParty(v, kit.cash))];
    rec.check("C26 each bill's party line equals its worked total, to the paisa", owed.every((o, i) => Math.abs(o - tot[i].grand) < 0.005), `${owed.join(", ")} vs ${tot.map((t) => t.grand).join(", ")}`);
    rec.check("C26 the three bills have three different REMOTEIDs and three vouchers stand", new Set(bills.map((b) => b.remoteId)).size === 3 && (await census(l)).mine === 3);
    return;
  }

  // ── C26b ─────────────────────────────────────────────────────────────────
  if (part === "c26b") {
    const s = c26b(stamp, day, kit);
    for (const it of s.items) { const r = await makeItem(l, it); made.items.push(it.name); rec.check(`C26b item "${it.name}" made`, r.ok, r.detail); }
    await freshMasters(l);
    const before = await census(l);
    for (const [label, p, re] of [["over the Rs 50,000 cash limit", s.overLimit, /50,?000/], ["with no buyer name", s.noBuyer, /buyer/i], ["taxed as interstate", s.wrongState, /./]] as const) {
      const r = await push(l, p);
      rec.check(`C26b a cash bill ${label} is refused before Tally`, !r.ok && r.stage === "guard" && r.errors.some((e) => re.test(e)), `${r.stage}: ${r.errors[0]?.slice(0, 140) ?? ""}`);
      rec.check(`C26b ... and nothing of it is in the books`, (await countStored(l, day, { number: p.voucherNumber })) === 0);
    }
    const after = await census(l);
    rec.check("C26b the three refusals left the voucher count unchanged", after.total === before.total, `${before.total} -> ${after.total}`);
    const ra = await send("C26b share A (6 of the 10) is pushed", s.shareA);
    const rb = await send("C26b share B (4 of the 10) is pushed", s.shareB);
    rec.check("C26b both shares read back with no differences", ra.differences.length === 0 && rb.differences.length === 0);
    const va = await stored(s.shareA), vb = await stored(s.shareB);
    fieldCheck("C26b share A", s.shareA, va); fieldCheck("C26b share B", s.shareB, vb);
    const taxable = (v: string | null) => { const m = (v ?? "").match(/<ALLINVENTORYENTRIES\.LIST>[\s\S]*?<\/ALLINVENTORYENTRIES\.LIST>/); return m ? Math.abs(num(readTag(m[0], "AMOUNT"))) : NaN; };
    rec.check("C26b the two shares' stored values add to the whole line, to the paisa", r2(taxable(va) + taxable(vb)) === s.wholeLine.taxable, `${taxable(va)} + ${taxable(vb)} vs ${s.wholeLine.taxable}`);
    return;
  }

  // ── C29 ──────────────────────────────────────────────────────────────────
  if (part === "c29") {
    const s = c29(stamp, day, kit);
    const rt = await makeParty(l, s.parties.transport); made.parties.push(s.parties.transport.name);
    rec.check("C29 transporter ledger made (unregistered, West Bengal, under Sundry Creditors (Freight))", rt.ok, rt.detail);
    await freshMasters(l);
    const rb = await send("C29 the freight bill is pushed as a Purchase (Cr carrier New Ref, Dr FREIGHT ( UNDER RCM ))", s.bill);
    rec.check("C29 the freight bill read-back has no differences", rb.differences.length === 0, rb.differences.join(" | ").slice(0, 160));
    const vb = await stored(s.bill);
    fieldCheck("C29 freight bill", s.bill, vb);
    rec.check("C29 the bill carries no GST line and no stock line (the tax is booked by the journal)", !!vb && !/OUTPUT|INPUT [CSI]GST/.test(vb) && !/<STOCKITEMNAME>[^<]/.test(vb));
    let open = await loadOpenBills(l.url, l.company);
    const mine = open.find((b) => b.name === s.billNo && b.party === s.parties.transport.name);
    rec.check("C29 the bill is open for the carrier as a payable of the full amount", !!mine && Math.abs(mine.closing - s.amount) < 0.011 && mine.closing > 0, mine ? `closing ${mine.closing}` : "not among the open bills");
    const half = r2(s.rcmTax / 2);
    const tally = async (label: string, p: VoucherPayload, outs: [string, string][], ins: [string, string, number][]) => {
      const rj = await send(`C29 ${label} journal is pushed (BEING GST UNDER RCM)`, p);
      rec.check(`C29 ${label} journal read-back has no differences`, rj.differences.length === 0, rj.differences.join(" | ").slice(0, 160));
      const vj = await stored(p);
      fieldCheck(`C29 ${label} journal`, p, vj);
      const jl = (vj ?? "").match(/<ALLLEDGERENTRIES\.LIST>[\s\S]*?<\/ALLLEDGERENTRIES\.LIST>/g) ?? [];
      const amt = (name: string, side: string) => jl.filter((b) => readTag(b, "LEDGERNAME") === name && readTag(b, "ISDEEMEDPOSITIVE") === side).map((b) => Math.abs(num(readTag(b, "AMOUNT")))).reduce((a, x) => a + x, 0);
      rec.check(`C29 ${label} journal books the tax right: ${[...outs, ...ins.map((i) => [i[0], i[1]] as [string, string])].map(([n, sd]) => `${n} ${sd === "Yes" ? "Dr" : "Cr"}`).join(", ")}`,
        outs.every(([n, sd]) => Math.abs(amt(n, sd) - half) < 0.011) && ins.every(([n, sd, v]) => Math.abs(amt(n, sd) - v) < 0.011),
        [...outs.map(([n, sd]) => `${n} ${amt(n, sd)}`), ...ins.map(([n, sd]) => `${n} ${amt(n, sd)}`)].join(", "));
      return vj;
    };
    const vInc = await tally("increase-in-liability", s.tax, [[kit.outCgst, "No"], [kit.outSgst, "No"]], [[kit.rcmAsset, "Yes", s.rcmTax]]);
    const vDec = await tally("decrease-in-liability", s.taxDecrease, [[kit.inCgst, "Yes"], [kit.inSgst, "Yes"]], [[kit.rcmAsset, "No", s.rcmTax]]);
    const rcmNet = (v: string | null) => (v ?? "").match(/<ALLLEDGERENTRIES\.LIST>[\s\S]*?<\/ALLLEDGERENTRIES\.LIST>/g)?.filter((b) => readTag(b, "LEDGERNAME") === kit.rcmAsset).reduce((a, b) => a + num(readTag(b, "AMOUNT")), 0) ?? NaN;
    rec.check("C29 the GST UNDER RCM holding ledger nets to nil across the two journals", Math.abs(r2(rcmNet(vInc) + rcmNet(vDec))) < 0.005, `${rcmNet(vInc)} + ${rcmNet(vDec)}`);
    const rp = await send("C29 the payment of the freight bill is pushed (Dr carrier against the bill, Cr Cash)", s.pay);
    rec.check("C29 the payment read-back has no differences", rp.differences.length === 0, rp.differences.join(" | ").slice(0, 160));
    const vp = await stored(s.pay);
    fieldCheck("C29 payment", s.pay, vp, true);
    open = await loadOpenBills(l.url, l.company);
    const left = open.find((b) => b.name === s.billNo && b.party === s.parties.transport.name);
    rec.check("C29 the bill is settled: no longer open for the carrier", !left || Math.abs(left.closing) < 0.011, left ? `still ${left.closing}` : "gone from the open bills");
    rec.check("C29 four vouchers of this run stand (bill, two journals, payment)", (await census(l)).mine === 4);
    return;
  }

  // ── C22 ──────────────────────────────────────────────────────────────────
  if (part === "c22") {
    const s = stockJournalScenario(stamp, day, kit);
    for (const it of s.items) { const r = await makeItem(l, it); made.items.push(it.name); rec.check(`C22 item "${it.name}" made`, r.ok, r.detail); }
    const stock = async () => { const m = await freshMasters(l); return new Map(s.items.map((i) => [i.name, m.items.get(i.name)?.closingStock ?? NaN])); };
    const same = (got: Map<string, number>, want: Map<string, number>) => [...want].every(([k, q]) => Math.abs((got.get(k) ?? NaN) - q) < 0.001);
    const zero = await stock();
    rec.check("C22 the new items start with no stock", [...zero.values()].every((q) => q === 0), JSON.stringify([...zero]));
    const g = await send("C22 count found MORE: a Stock Journal brings 4 of item A IN", s.gain);
    rec.check("C22 the read-back has no differences", g.differences.length === 0, g.differences.join(" | ").slice(0, 200));
    const gv = await stored(s.gain);
    fieldCheck("C22 gain", s.gain, gv);
    rec.check("C22 it reads back as a Stock Journal carrying our REMOTEID's number and narration", !!gv && /stock journal/i.test(readTag(gv, "VOUCHERTYPENAME")) && readTag(gv, "NARRATION") === s.gain.narration, gv ? readTag(gv, "VOUCHERTYPENAME") : "no read");
    rec.check("C22 stock of item A in Tally moved by +4", same(await stock(), s.expected.afterGain), "");
    const lo = await send("C22 count found LESS: a Stock Journal takes 1 of item A OUT", s.loss);
    rec.check("C22 the read-back has no differences", lo.differences.length === 0, lo.differences.join(" | ").slice(0, 200));
    fieldCheck("C22 loss", s.loss, await stored(s.loss));
    rec.check("C22 stock of item A in Tally is now 3 (+4 then -1)", same(await stock(), s.expected.afterLoss));
    const mx = await send("C22 a mixed voucher: item B in 2, item A out 1, in one Stock Journal", s.mixed);
    rec.check("C22 the read-back has no differences", mx.differences.length === 0, mx.differences.join(" | ").slice(0, 200));
    fieldCheck("C22 mixed", s.mixed, await stored(s.mixed));
    rec.check("C22 stock is now A 2 and B 2", same(await stock(), s.expected.afterMixed));
    const dup = await push(l, s.gain);
    rec.check("C22 pushing the same Stock Journal again does not double the stock (same REMOTEID)", (await countStored(l, day, { narration: s.gain.narration, type: "Stock Journal" })) === 1, dup.ok ? "ok" : dup.errors[0]?.slice(0, 100));
    const c = await census(l);
    rec.check("C22 three Stock Journals of this run stand", c.mine === 3, `${c.mine}`);
    return;
  }
  throw new Error(`unknown part "${part}"`);
}

/** Remove everything a part made: vouchers by REMOTEID, the sweep as a backstop, then ZZ TEST masters. */
async function teardown(l: Live, rec: Recorder, made: Made, before: { total: number; ours: number } | null): Promise<void> {
  for (const p of [...made.vouchers].reverse()) {
    const r = await remove(l, p);
    rec.check(`teardown: ${p.voucherType} ${p.voucherNumber} deleted by REMOTEID`, r.ok, r.detail);
  }
  const sw = sweepDay(l.day);
  rec.check("teardown: the sweep (backstop) ran clean", sw === 0, `exit ${sw}`);
  for (const n of made.items) { const r = await dropItem(l, n); rec.check(`teardown: item "${n}" removed`, r.ok, r.detail); }
  for (const n of made.parties) { const r = await dropParty(l, n); rec.check(`teardown: ledger "${n}" removed`, r.ok, r.detail); }
  try {
    const after = await census(l);
    rec.check("teardown: none of this run's vouchers is left in the books", after.mine === 0, `${after.mine} left`);
    if (before) rec.check("teardown: the voucher count is what it was before the run", after.total === before.total && after.ours === before.ours, `total ${before.total} -> ${after.total}, ours ${before.ours} -> ${after.ours}`);
  } catch (e) { rec.check("teardown: the books could be counted afterwards", false, (e as Error).message.slice(0, 120)); }
  const m = await freshMasters(l);
  const left = [...m.ledgers.keys()].filter((k) => k.includes(l.stamp)).concat([...m.items.keys()].filter((k) => k.includes(l.stamp)));
  rec.check("teardown: no ZZ TEST ledger or item of this run is left", left.length === 0, left.join(", "));
}

/** Remove what a crashed run left under `stamp`: vouchers by every REMOTEID spelling, then the masters. */
async function cleanup(l: Live): Promise<number> {
  const rec = new Recorder("cleanup", -1);
  const all = await pullAll(l.company);
  const mine = all.filter((v) => v.number.startsWith(`ZZTEST${l.stamp}/`));
  console.log(`  ${mine.length} voucher(s) of stamp ${l.stamp} in the books`);
  for (const v of mine) {
    const spellings = [...remoteIdGuesses(v.type, v.number), `MKCP|SALES ORDER NOTE|${v.number}`];
    let gone = false;
    for (const rid of spellings) {
      const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(l.company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${escapeXml(rid)}" VCHTYPE="${escapeXml(v.type)}" ACTION="Delete">
<DATE>${v.date}</DATE><VOUCHERTYPENAME>${escapeXml(v.type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${escapeXml(v.number)}</VOUCHERNUMBER></VOUCHER>
</TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
      try { const res = (await tallyPost(l.url, xml, 120_000, true)) as string; if (/<DELETED>[1-9]/.test(res)) { gone = true; break; } } catch { /* wrong spelling */ }
    }
    rec.check(`cleanup: ${v.type} ${v.number} deleted`, gone);
  }
  const m = await freshMasters(l);
  for (const k of [...m.items.keys()].filter((k) => k.includes(l.stamp))) { const r = await dropItem(l, k); rec.check(`cleanup: item "${k}" removed`, r.ok, r.detail); }
  for (const k of [...m.ledgers.keys()].filter((k) => k.startsWith("ZZ TEST") && k.includes(l.stamp))) { const r = await dropParty(l, k); rec.check(`cleanup: ledger "${k}" removed`, r.ok, r.detail); }
  return rec.failed ? 1 : 0;
}

(async () => {
  const pf = await preflight();
  console.log(`  preflight ok (dummy is the only company open, ${pf.listMs} ms)`);
  if (CLEANUP) { process.exit(await cleanup(makeLive(pf, indiaToday(), CLEANUP))); }
  if (!(part_ok(PART))) { console.error(`usage: --part c22|c23|c25|c26|c26b|c29   (got "${PART}")`); process.exit(2); }
  const stamp = stampFrom();
  const l = makeLive(pf, indiaToday(), stamp);
  const expected = arg("--expect") ? Number(arg("--expect")) : EXPECTED[PART];
  const rec = new Recorder(`t11 ${PART}`, expected < 0 ? 0 : expected);
  console.log(`\n  T11 ${PART.toUpperCase()} on the dummy (${l.day}, stamp ${stamp})${expected < 0 ? "  [CALIBRATION RUN: the expected check count is not set yet, so this exit code is by failures only]" : ""}\n`);
  const made = new Made();
  let before: { total: number; ours: number } | null = null;
  try { before = await census(l); rec.note(`books before: ${before.total} vouchers, ${before.ours} ours`); await body(PART, l, rec, made); }
  catch (e) { rec.check("the part finished without an error", false, (e as Error).message.slice(0, 300)); }
  finally { await teardown(l, rec, made, before); }
  let code = rec.finish(OUT ?? undefined);
  if (expected < 0 && rec.failed === 0) { console.log(`  calibration: ${rec.passed} checks passed, set EXPECTED.${PART} = ${rec.passed}`); code = 0; }
  process.exit(code);
})().catch((e) => { console.error(`FAILED before the part started: ${(e as Error).message}`); process.exit(2); });

function part_ok(p: string): boolean { return ["c22", "c23", "c25", "c26", "c26b", "c29"].includes(p); }
void zzItems; void zzParties; void asAlter; void asCancel;
