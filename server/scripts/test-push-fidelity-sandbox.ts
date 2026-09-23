/**
 * Push-fidelity harness — SANDBOX ONLY.
 *
 * Owner, 23-Sep-2026: "Test the sales order push and the sales invoice push and
 * make sure the data is proper … bill-to and ship-to will always be the same for
 * every party … the GST and party details in e-way bill and e-invoice details
 * cannot be broken at any point."
 *
 * What it does, in order, one voucher at a time:
 *
 *   1. Refuses to run unless MKCP_TALLY_ROLE=sandbox AND Tally is localhost:9000.
 *   2. Builds scenarios from LIVE sandbox masters (parties, items, GST rates) —
 *      nothing typed — and hands them to the WEB builders
 *      (web-dashboard/scripts/emit-push-fidelity.mts) so the payloads are the
 *      ones the app itself would queue.
 *   3. --dry   builds each voucher's XML with buildVoucherImportXml and checks
 *              the SENT party / consignee / line-GST fields against what the
 *              masters say they must be.
 *      --push  pushes each through safePush (guard + read-back), then reads it
 *              back with every Party-Details field ASKED FOR BY NAME (G7) and
 *              asserts: bill-to, ship-to (= bill-to), GST identity, place of
 *              supply, the rate Tally resolved on every stock line, tax heads,
 *              totals, balance.
 *
 * Expected values come from the ledger master (registrationOn / LEDMAILINGDETAILS)
 * or, for a counter sale, from the walk-in the operator typed — never from the
 * payload under test. A check that compares the voucher to its own payload
 * proves nothing (tally-harness-lies-more-than-the-app).
 *
 * Vouchers are LEFT in the sandbox for the owner to inspect (owner's rule,
 * 23-Sep). Every one carries REMOTEID "MKCP|TEST|…" and narration "MKCP TEST…";
 * every id is journaled to data/push-fidelity-journal.jsonl. `--cleanup`
 * deletes them by REMOTEID.
 *
 *   npx tsx scripts/test-push-fidelity-sandbox.ts --dry
 *   npx tsx scripts/test-push-fidelity-sandbox.ts --push [--only S3,S4]
 *   npx tsx scripts/test-push-fidelity-sandbox.ts --cleanup
 *
 * MKCP_WEB_DIR overrides where the web app lives (default ../../MKCP MOB2/web-dashboard).
 */
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, readFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { loadMasters, registrationOn, mailingOn, gstRateFor, hsnFor, type TallyMasters, type MasterLedger } from "../src/services/tallyMasters.js";
import { buildVoucherImportXml } from "../src/services/voucherPusher.js";
import { guardVoucher } from "../src/services/pushGuard.js";
import { safePush } from "../src/services/safePush.js";
import { buildCollection, blocksOf, tagOf, onDate } from "../src/services/tallyRequest.js";
import { isSandbox } from "../src/services/tallyRole.js";
import type { VoucherPayload } from "../src/types.js";

// ── 1. Refuse anything but the sandbox ──────────────────────────────────────
const U = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";
if (!isSandbox()) {
  console.error("\n  REFUSED — MKCP_TALLY_ROLE is not 'sandbox'. This harness writes vouchers; it never runs against the real books.\n");
  process.exit(2);
}
if (!/^https?:\/\/(localhost|127\.0\.0\.1):9000\/?$/i.test(U)) {
  console.error(`\n  REFUSED — TALLY_URL is ${U}. Only the sandbox Tally on localhost:9000 is allowed.\n`);
  process.exit(2);
}

const DRY = process.argv.includes("--dry");
const PUSH = process.argv.includes("--push");
const CLEANUP = process.argv.includes("--cleanup");
const ONLY = (() => { const i = process.argv.indexOf("--only"); return i > 0 ? new Set(process.argv[i + 1].split(",")) : null; })();
const DATE = process.env.MKCP_TEST_DATE || new Date().toLocaleDateString("en-CA");  // LOCAL date, not UTC
const STAMP = DATE.slice(5).replace("-", "");
const DATA = join(here, "..", "data");
const JOURNAL = join(DATA, "push-fidelity-journal.jsonl");
const WEB_DIR = resolve(process.env.MKCP_WEB_DIR || join(here, "..", "..", "..", "MKCP MOB2", "web-dashboard"));
mkdirSync(DATA, { recursive: true });

const HOME = "West Bengal";
/** A sentinel the web builder is fed as the party's address. The ledger master
 *  is authoritative; if this ever reaches Tally, a typed copy won. */
const TYPED_COPY = "TYPED COPY MUST NOT REACH TALLY";
const WALKIN = { name: "MKCP TEST WALKIN CYCLE", address: "12 TEST LANE\nBARASAT 700124" };

let passed = 0, failed = 0;
const results: Array<{ id: string; ok: boolean; line: string }> = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) passed++; else failed++;
  console.log(`     ${cond ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${detail ? ` — ${detail}` : ""}`);
  return cond;
};

async function alive(): Promise<boolean> {
  try { await tallyPost(U, HEALTH_XML, 20_000); return true; } catch { return false; }
}

// ── 2. Scenarios, from live masters ──────────────────────────────────────────
interface Line { name: string; baseUnit: string; unitsPerPkg: number; pkgs: number; rate: number; gstRate: number }

function pickItem(m: TallyMasters, pred: (r: { rate: number; source: string }, name: string) => boolean, avoid: Set<string>): Line {
  for (const i of m.items.values()) {
    if (avoid.has(i.name) || !(i.closingRate > 1) || !m.units.has(i.baseUnit)) continue;
    const r = gstRateFor(m, i.name, DATE);
    if (!pred(r, i.name)) continue;
    avoid.add(i.name);
    return { name: i.name, baseUnit: i.baseUnit, unitsPerPkg: 1, pkgs: 1, rate: Math.round(i.closingRate * 112) / 100, gstRate: r.rate };
  }
  throw new Error("no item matches");
}

function buildScenarios(m: TallyMasters) {
  const need = (n: string): MasterLedger => {
    const l = m.ledgers.get(n); if (!l) throw new Error(`sandbox has no ledger "${n}"`); return l;
  };
  const avoid = new Set<string>();
  const grp5 = pickItem(m, (r) => r.rate === 5 && r.source.startsWith("stock group"), avoid);
  const own18 = pickItem(m, (r) => r.rate === 18 && r.source === "item", avoid);
  const own5 = pickItem(m, (r) => r.rate === 5 && r.source === "item", avoid);
  const grp5b = pickItem(m, (r) => r.rate === 5 && r.source.startsWith("stock group"), avoid);
  const L = (l: Line, pkgs: number, rateAdj = 0): Line => ({ ...l, pkgs, rate: Math.round((l.rate + rateAdj) * 100) / 100 });

  // Parties: a local registered dealer, an unregistered one, an inter-state one.
  const local = need("RANI CYCLE STORES ( BHANGAR )");
  const localOrders = need("KAMALABHA CYCLE STORES (LAKHIKANTOPUR)");
  const unreg = [...m.ledgers.values()].find((l) => /DEBTOR/i.test(l.parent) && !registrationOn(l, DATE).gstin
    && l.state && l.pincode && l.address.length >= 2)!;
  const inter = [...m.ledgers.values()].find((l) => /DEBTOR/i.test(l.parent) && l.state && !/bengal/i.test(l.state)
    && registrationOn(l, DATE).gstin && l.pincode && l.address.length)!;
  const party = (l: MasterLedger) => ({ name: l.name, state: l.state, gstin: registrationOn(l, DATE).gstin || undefined, address: TYPED_COPY });
  const n = (k: string) => `MKCPTEST/${STAMP}-${k}`;
  const rid = (k: string) => `MKCP|TEST|${DATE}|${k}`;
  const narr = (what: string) => `MKCP TEST — ${what}`;

  return {
    scenarios: [
      { id: "S1", kind: "order", what: "Sales Order Note, local WB party, 3 rates/sources (5% group, 18% own, 5% own)",
        number: n("SO1"), remoteId: rid("SO1"), narration: narr("order stays an order"), party: party(localOrders),
        lines: [L(grp5, 4), L(own18, 3, 0.07), L(own5, 10)] },
      { id: "S2", kind: "order", what: "Sales Order Note to be converted (created as order)",
        number: n("SO2"), remoteId: rid("SO2"), narration: narr("order converted to invoice"), party: party(localOrders),
        lines: [L(grp5b, 6), L(own18, 2)] },
      { id: "S3", kind: "invoice", what: "Sales invoice, local WB registered, multi-rate, trade discount (negative line)",
        number: n("S03"), remoteId: rid("S03"), narration: narr("local registered, discount"), party: party(local),
        lines: [L(grp5, 5), L(own18, 4, 0.13), L(own5, 12)], discountByItem: { [grp5.name]: 25, [own18.name]: 10 } },
      { id: "S4", kind: "invoice", what: "Sales invoice, UNREGISTERED party ledger (Unregistered/Consumer)",
        number: n("S04"), remoteId: rid("S04"), narration: narr("unregistered party"), party: party(unreg),
        lines: [L(grp5b, 3, 0.11), L(own18, 1)] },
      { id: "S5", kind: "invoice", what: "Sales invoice, INTER-STATE party (IGST, central sales ledger)",
        number: n("S05"), remoteId: rid("S05"), narration: narr("inter-state"), party: party(inter),
        lines: [L(grp5, 7, 0.03), L(own18, 2)] },
      { id: "S6", kind: "cash", what: "Cash split, WALK-IN with typed name + address, multi-rate, net discount (negative)",
        number: n("S06"), remoteId: rid("S06"), narration: narr("walk-in counter sale"),
        buyer: { name: WALKIN.name, address: WALKIN.address }, discount: 40, handling: 0,
        lines: [L(grp5b, 2), L(own18, 1, 0.21), L(own5, 5)] },
      { id: "S7", kind: "cash", what: "Cash split billed to a PARTY ledger, handling > discount (positive charge line)",
        number: n("S07"), remoteId: rid("S07"), narration: narr("split to party, handling"),
        buyer: { name: local.name, ledger: local.name, state: local.state, gstin: registrationOn(local, DATE).gstin },
        discount: 10, handling: 60, lines: [L(grp5, 3), L(own5, 4, 0.09)] },
      { id: "S2b", kind: "convert", what: "Order S2 converted to a Sales invoice in place (Alter, same REMOTEID)",
        from: "S2", invoiceNumber: n("S2B") },
    ],
    parties: { local: local.name, localOrders: localOrders.name, unreg: unreg.name, inter: inter.name },
    items: { grp5: grp5.name, own18: own18.name, own5: own5.name, grp5b: grp5b.name },
  };
}

function emitWithWebBuilders(doc: unknown): Array<{ id: string; what: string; payload: VoucherPayload }> {
  const inPath = join(DATA, "push-fidelity-scenarios.json");
  const outPath = join(DATA, "push-fidelity-payloads.json");
  writeFileSync(inPath, JSON.stringify(doc, null, 2));
  if (!existsSync(join(WEB_DIR, "scripts", "emit-push-fidelity.mts"))) {
    throw new Error(`web emitter not found under ${WEB_DIR} — set MKCP_WEB_DIR`);
  }
  const r = spawnSync("npx", ["tsx", "scripts/emit-push-fidelity.mts", inPath, outPath], { cwd: WEB_DIR, shell: true, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`web emitter failed:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(readFileSync(outPath, "utf8"));
}

// ── 3. What the masters say each voucher must carry ─────────────────────────
interface Expect {
  header: Record<string, string | null>;      // null = must be absent/empty
  address: string[];                          // bill-to lines == ship-to lines
  interState: boolean;
}

const PIN = /\b([1-9]\d{5})\b/;

function expectFor(p: VoucherPayload, m: TallyMasters): Expect {
  const led = m.ledgers.get(p.partyLedgerName)!;
  const isCash = !led.state && !led.address.length && !registrationOn(led, p.date).gstin && !!p.placeOfSupply;
  if (isCash) {
    const addr = (p.buyerAddress ?? []).map((s) => s.trim()).filter(Boolean);
    const name = p.buyerName?.trim() || led.mailingName || led.name;
    const pin = addr.map((a) => PIN.exec(a)?.[1]).find(Boolean) ?? null;
    return {
      interState: false, address: addr,
      header: {
        PARTYLEDGERNAME: led.name, PARTYNAME: led.name, BASICBASEPARTYNAME: led.name, BASICBUYERNAME: led.name,
        PARTYMAILINGNAME: name, CONSIGNEEMAILINGNAME: name,
        STATENAME: HOME, PLACEOFSUPPLY: HOME, CONSIGNEESTATENAME: HOME,
        COUNTRYOFRESIDENCE: "India", CONSIGNEECOUNTRYNAME: "India",
        GSTREGISTRATIONTYPE: "Unregistered/Consumer", PARTYGSTIN: null, CONSIGNEEGSTIN: null,
        PARTYPINCODE: pin, CONSIGNEEPINCODE: pin, CMPGSTIN: "19AADCM6953C1ZE",
      },
    };
  }
  const reg = registrationOn(led, p.date);
  const mail = mailingOn(led, p.date);
  const state = led.state;
  const regType = reg.registrationType && !/unknown/i.test(reg.registrationType) ? reg.registrationType
    : (reg.gstin ? "Regular" : "Unregistered/Consumer");
  return {
    interState: state.toLowerCase() !== HOME.toLowerCase(), address: mail.address,
    header: {
      PARTYLEDGERNAME: led.name, PARTYNAME: led.name, BASICBASEPARTYNAME: led.name, BASICBUYERNAME: led.name,
      PARTYMAILINGNAME: mail.mailingName, CONSIGNEEMAILINGNAME: mail.mailingName,
      STATENAME: state, PLACEOFSUPPLY: state, CONSIGNEESTATENAME: state,
      COUNTRYOFRESIDENCE: "India", CONSIGNEECOUNTRYNAME: "India",
      GSTREGISTRATIONTYPE: regType === "Unregistered" ? "Unregistered/Consumer" : regType,
      PARTYGSTIN: reg.gstin || null, CONSIGNEEGSTIN: reg.gstin || null,
      PARTYPINCODE: mail.pincode || null, CONSIGNEEPINCODE: mail.pincode || null, CMPGSTIN: "19AADCM6953C1ZE",
    },
  };
}

// ── Parsing a voucher (sent XML or stored export) ───────────────────────────
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function headerOf(v: string): string {
  return v
    .replace(/<ALLINVENTORYENTRIES\.LIST>[\s\S]*?<\/ALLINVENTORYENTRIES\.LIST>/g, "")
    .replace(/<INVENTORYENTRIES\.LIST>[\s\S]*?<\/INVENTORYENTRIES\.LIST>/g, "")
    .replace(/<ALLLEDGERENTRIES\.LIST>[\s\S]*?<\/ALLLEDGERENTRIES\.LIST>/g, "")
    .replace(/<LEDGERENTRIES\.LIST>[\s\S]*?<\/LEDGERENTRIES\.LIST>/g, "")
    .replace(/<EWAYBILLDETAILS\.LIST>[\s\S]*?<\/EWAYBILLDETAILS\.LIST>/g, "");
}
const one = (h: string, t: string) => { const m = new RegExp(`<${t}(?:\\s[^>]*)?>([^<]*)</${t}>`).exec(h); return m ? unesc(m[1].trim()) : ""; };
const listLines = (h: string, t: string): string[][] =>
  [...h.matchAll(new RegExp(`<${t}\\.LIST[^>]*>([\\s\\S]*?)</${t}\\.LIST>`, "g"))]
    .map((b) => [...b[1].matchAll(/<([A-Z]+)>([^<]*)<\/\1>/g)].map((x) => unesc(x[2].trim())).filter(Boolean))
    .filter((ls) => ls.length);
const num = (s: string) => { const m = /^\s*(-?[\d.]+)/.exec(s.replace(/,/g, "")); return m ? parseFloat(m[1]) : 0; };

interface StockLine { item: string; amount: number; igst: number; cess: string; srcType: string; src: string; hsn: string; taxability: string }
function stockLines(v: string): StockLine[] {
  return [...v.matchAll(/<ALLINVENTORYENTRIES\.LIST>([\s\S]*?)<\/ALLINVENTORYENTRIES\.LIST>/g)].map((b) => {
    const blk = b[1];
    const own = blk.replace(/<ACCOUNTINGALLOCATIONS\.LIST>[\s\S]*?<\/ACCOUNTINGALLOCATIONS\.LIST>/g, "")
      .replace(/<BATCHALLOCATIONS\.LIST>[\s\S]*?<\/BATCHALLOCATIONS\.LIST>/g, "");
    const igstBlk = [...own.matchAll(/<RATEDETAILS\.LIST>([\s\S]*?)<\/RATEDETAILS\.LIST>/g)].map((x) => x[1])
      .find((x) => one(x, "GSTRATEDUTYHEAD") === "IGST");
    return {
      item: one(blk, "STOCKITEMNAME"), amount: num(one(own, "AMOUNT")),
      igst: igstBlk ? num(one(igstBlk, "GSTRATE")) : NaN,
      cess: [...own.matchAll(/<RATEDETAILS\.LIST>([\s\S]*?)<\/RATEDETAILS\.LIST>/g)].map((x) => x[1])
        .filter((x) => one(x, "GSTRATEDUTYHEAD") === "Cess").map((x) => one(x, "GSTRATEVALUATIONTYPE")).join(""),
      srcType: one(own, "GSTSOURCETYPE"), src: one(own, "GSTSTOCKGROUPSOURCE") || one(own, "GSTITEMSOURCE"),
      hsn: one(own, "GSTHSNNAME"), taxability: one(own, "GSTOVRDNTAXABILITY"),
    };
  });
}
const ledgerLines = (v: string, tag: string) =>
  [...v.matchAll(new RegExp(`<${tag}\\.LIST>([\\s\\S]*?)</${tag}\\.LIST>`, "g"))]
    .map((b) => ({ name: one(b[1], "LEDGERNAME"), amount: num(one(b[1], "AMOUNT")) }));

// ── Assertions shared by --dry (what we SEND) and --push (what Tally STORED) ─
function assertIdentity(v: string, e: Expect, stored: boolean) {
  const h = headerOf(v);
  for (const [t, want] of Object.entries(e.header)) {
    // Tally derives PARTYNAME/BASICBASEPARTYNAME/CMPGSTIN itself; we only
    // require them on the stored voucher.
    if (!stored && ["CMPGSTIN"].includes(t)) continue;
    const got = one(h, t);
    if (want === null) check(`${t} absent`, !got, got ? `carries "${got}"` : "");
    else check(`${t} = "${want}"`, got === want, got === want ? "" : `got "${got}"`);
  }
  const bill = listLines(h, "ADDRESS"), ship = listLines(h, "BASICBUYERADDRESS");
  check(`bill-to ADDRESS.LIST is ONE block`, bill.length <= 1, `${bill.length} blocks`);
  check(`bill-to address = ${JSON.stringify(e.address)}`, JSON.stringify(bill[0] ?? []) === JSON.stringify(e.address), JSON.stringify(bill[0] ?? []));
  check(`ship-to BASICBUYERADDRESS = bill-to`, JSON.stringify(ship[0] ?? []) === JSON.stringify(e.address), JSON.stringify(ship[0] ?? []));
  check(`no typed-copy address anywhere`, !v.includes(TYPED_COPY));
}

function assertLines(v: string, p: VoucherPayload, m: TallyMasters, e: Expect, stored: boolean, discByItem?: Record<string, number>) {
  const lines = stockLines(v);
  check(`stock lines present (${lines.length} of ${(p.inventoryEntries ?? []).length})`, lines.length === (p.inventoryEntries ?? []).length && lines.length > 0);
  for (const l of lines) {
    const r = gstRateFor(m, l.item, p.date);
    const wantType = r.source === "item" ? "Stock Item" : "Stock Group";
    check(`${l.item}: GSTSOURCETYPE ${wantType}`, l.srcType === wantType, l.srcType || "(none)");
    const h = hsnFor(m, l.item, p.date);
    check(`${l.item}: IGST rate ${r.rate}% on the line${stored ? " as STORED" : ""} (not "not specified")`, l.igst === r.rate, Number.isNaN(l.igst) ? "no rate on the line" : `${l.igst}%`);
    check(`${l.item}: HSN ${h.code || "(none declared)"}${stored ? " as STORED" : ""}`, l.hsn === h.code, l.hsn || "(none)");
    check(`${l.item}: Cess head present, valuation Not Applicable (native shape)`, /Not Applicable/.test(l.cess), l.cess || "(no Cess head)");
  }
  const tag = stored ? "ALLLEDGERENTRIES" : "LEDGERENTRIES";
  const led = ledgerLines(v, tag);
  const names = led.map((x) => x.name);
  if (e.interState) {
    check("inter-state → OUTPUT IGST only", names.includes("OUTPUT IGST") && !names.includes("OUTPUT CGST") && !names.includes("OUTPUT SGST"), names.join(", "));
  } else {
    check("intra-state → CGST + SGST, no IGST", names.includes("OUTPUT CGST") && names.includes("OUTPUT SGST") && !names.includes("OUTPUT IGST"), names.join(", "));
  }
  if (stored) {
    const sum = led.reduce((s, x) => s + x.amount, 0);
    check("ALLLEDGERENTRIES balance to zero", Math.abs(sum) < 0.02, sum.toFixed(2));
    // Expected tax from TALLY's line rates over the taxable value (charge line spread by value).
    const charge = led.find((x) => x.name === "TRADE DISCOUNTS / H.C.")?.amount ?? 0;
    const gross = lines.reduce((s, l) => s + l.amount, 0);
    // A quote's discounts are per item and exact; a cash split's charge is spread by value.
    const sentLedgers = p.ledgerEntries.map((x) => x.ledgerName);
    const taxable = (l: StockLine) => discByItem ? l.amount - (discByItem[l.item] ?? 0) : l.amount + (gross ? charge * l.amount / gross : 0);
    const expectTax = lines.reduce((s, l) => s + taxable(l) * l.igst / 100, 0);
    const tax = led.filter((x) => /^OUTPUT (IGST|CGST|SGST)$/.test(x.name)).reduce((s, x) => s + x.amount, 0);
    check(`tax on the voucher ≈ Σ taxable × Tally's line rate`, Math.abs(tax - expectTax) < 0.05 * lines.length + 0.05, `tax ${tax.toFixed(2)} vs ${expectTax.toFixed(2)}`);
    const cg = led.find((x) => x.name === "OUTPUT CGST")?.amount, sg = led.find((x) => x.name === "OUTPUT SGST")?.amount;
    if (cg !== undefined) check("CGST = SGST", Math.abs(cg - (sg ?? 0)) < 0.011, `${cg} / ${sg}`);
    const party = led.find((x) => x.name === p.partyLedgerName);
    const credits = led.filter((x) => x !== party).reduce((s, x) => s + x.amount, 0);
    check(`party debit = grand total`, !!party && Math.abs(-party.amount - credits) < 0.02, `${party?.amount} vs ${credits.toFixed(2)}`);
    const ro = led.find((x) => x.name === "ROUNDED OFF");
    console.log(`       round-off: ${ro ? (ro.amount > 0 ? `UP +${ro.amount}` : `DOWN ${ro.amount}`) : "none"} · party ${party?.amount} · lines ${sentLedgers.length}`);
  }
}

// ── Read-back with every Party-Details field asked for by name (G7) ─────────
const READ_FIELDS = [
  "Date", "VoucherNumber", "VoucherTypeName", "IsInvoice", "Narration", "PartyLedgerName", "PartyName", "BasicBasePartyName",
  "PartyMailingName", "Address", "PartyPincode", "StateName", "CountryOfResidence", "PlaceOfSupply",
  "GSTRegistrationType", "VATDealerType", "PartyGSTIN", "CMPGSTIN", "GSTRegistration",
  "BasicBuyerName", "BasicBuyerAddress", "ConsigneeMailingName", "ConsigneeGSTIN", "ConsigneePinCode",
  "ConsigneeStateName", "ConsigneeCountryName", "PersistedView", "VchEntryMode",
  "AllLedgerEntries", "LedgerEntries", "AllInventoryEntries",
];
async function readBack(number: string, date: string): Promise<string | undefined> {
  const xml = buildCollection({ id: "PushFidRead", type: "Voucher", company: COMPANY, fetch: READ_FIELDS, filter: onDate(date.replace(/-/g, "")) });
  const raw: string = await tallyPost(U, xml, 180_000, true);
  return blocksOf(raw, "VOUCHER").find((b) => (tagOf(b, "VOUCHERNUMBER") ?? "") === number);
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  if (!(await alive())) { console.error("\n  Tally on localhost:9000 is not answering — STOP. A human must restart it.\n"); process.exit(3); }

  if (CLEANUP) {
    const ids = existsSync(JOURNAL) ? [...new Map(readFileSync(JOURNAL, "utf8").trim().split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as { remoteId: string; voucherType: string; date: string })
      .map((j) => [j.remoteId, j])).values()] : [];
    for (const j of ids.reverse()) {
      if (!j.remoteId.startsWith("MKCP|TEST|")) continue;
      const res = await safePush(U, COMPANY, { voucherType: j.voucherType, date: j.date, remoteId: j.remoteId, action: "Delete",
        partyLedgerName: "", isInvoice: false, ledgerEntries: [] } as unknown as VoucherPayload, { verify: false });
      console.log(`  delete ${j.remoteId}: ok=${res.ok} ${res.errors.join(" ")}`);
      if (!(await alive())) { console.error("  Tally stopped answering — STOP."); process.exit(3); }
    }
    return;
  }

  const m = await loadMasters(U, COMPANY, { force: true });
  const plan = buildScenarios(m);
  console.log(`\n  PUSH FIDELITY — sandbox ${COMPANY} — ${DATE}`);
  console.log(`  parties: ${JSON.stringify(plan.parties)}\n  items:   ${JSON.stringify(plan.items)}`);
  const built = emitWithWebBuilders({ company: COMPANY, date: DATE, scenarios: plan.scenarios });
  const discOf = (id: string): Record<string, number> | undefined => {
    const s = plan.scenarios.find((x) => x.id === id) as { kind: string; discountByItem?: Record<string, number>; from?: string } | undefined;
    if (!s) return undefined;
    if (s.kind === "convert") return discOf(s.from!) ?? {};
    return s.kind === "cash" ? undefined : (s.discountByItem ?? {});
  };

  for (const { id, what, payload } of built) {
    if (ONLY && !ONLY.has(id)) continue;
    console.log(`\n  ── ${id} ${payload.voucherType} ${payload.voucherNumber} — ${what}`);
    const e = expectFor(payload, m);
    const g = guardVoucher(payload, m);
    for (const w of g.warnings) console.log(`       guard warning: ${w.slice(0, 140)}`);
    if (!check("pushGuard accepts", g.ok, g.errors.join(" · ").slice(0, 300))) continue;

    const before = failed;
    if (DRY || !PUSH) {
      const xml = buildVoucherImportXml(COMPANY, payload, m);
      const v = /<VOUCHER\b[\s\S]*<\/VOUCHER>/.exec(xml)![0];
      writeFileSync(join(DATA, `push-fidelity-${id}.sent.xml`), xml);
      assertIdentity(v, e, false);
      assertLines(v, payload, m, e, false, discOf(id));
    } else {
      appendFileSync(JOURNAL, JSON.stringify({ at: new Date().toISOString(), id, remoteId: payload.remoteId, voucherType: payload.voucherType,
        number: payload.voucherNumber, party: payload.partyLedgerName, date: payload.date, what }) + "\n");
      const res = await safePush(U, COMPANY, payload);
      check(`safePush ok (stage ${res.stage})`, res.ok, [...res.errors, ...(res.differences ?? [])].join(" · ").slice(0, 300));
      if (!(await alive())) { console.error("\n  Tally stopped answering after this push — STOP. A human must restart it.\n"); process.exit(3); }
      const v = await readBack(payload.voucherNumber!, payload.date);
      if (!check("read back by its own number", !!v)) continue;
      check(`VOUCHERTYPENAME ${payload.voucherType}`, one(v!, "VOUCHERTYPENAME").toUpperCase() === payload.voucherType.toUpperCase(), one(v!, "VOUCHERTYPENAME"));
      check(`ISINVOICE ${payload.isInvoice ? "Yes" : "No"}`, one(v!, "ISINVOICE") === (payload.isInvoice ? "Yes" : "No"));
      const conv = plan.scenarios.find((x) => x.id === id && x.kind === "convert") as { from: string } | undefined;
      if (conv) {
        // Converted IN PLACE: the order's own number must be gone, or Tally duplicated it.
        const order = built.find((b) => b.id === conv.from)!.payload;
        check(`order ${order.voucherNumber} no longer exists (converted, not duplicated)`, !(await readBack(order.voucherNumber!, order.date)));
      }
      assertIdentity(v!, e, true);
      assertLines(v!, payload, m, e, true, discOf(id));
      writeFileSync(join(DATA, `push-fidelity-${id}.stored.xml`), v!);
    }
    results.push({ id, ok: failed === before, line: `${id.padEnd(4)} ${payload.voucherType.padEnd(17)} ${String(payload.voucherNumber).padEnd(22)} ${payload.partyLedgerName.padEnd(40)} ${payload.remoteId}` });
  }

  console.log(`\n  ${"─".repeat(70)}`);
  for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.line}`);
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("\n  failed:", e instanceof Error ? e.stack : e); process.exit(1); });
