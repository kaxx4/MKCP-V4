/**
 * Every outward stock line names where its GST rate and HSN come from.
 *
 * Without GSTSOURCETYPE + the source master on the line, Tally files the whole
 * invoice under GST Tax Analysis → "Tax rate/tax type not specified", even
 * though the tax ledgers are right. Found 23-Sep-2026 on cash split invoices
 * 26-27/0718..0723. Fixture: 26-27/0719's real queued payload, and the live
 * mirror's rate rows for its three stock groups (tally_gst_rates, same day) —
 * the items declare no rate of their own, so every line must source its group.
 *
 *   npx tsx scripts/test-line-gst-source.ts
 */
import { buildVoucherImportXml } from "../src/services/voucherPusher.js";
import type { TallyMasters, MasterItem, MasterStockGroup, GstRevision } from "../src/services/tallyMasters.js";
import type { VoucherPayload } from "../src/types.js";

let passed = 0, failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) passed++; else failed++;
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const rev = (from: string, igst: number): GstRevision =>
  ({ from, rate: igst, cgst: igst / 2, sgst: igst / 2, igst, taxability: "Taxable" } as GstRevision);
const groupRevs = [rev("2017-07-01", 12), rev("2022-04-01", 12), rev("2025-09-22", 5)];
const group = (name: string): MasterStockGroup =>
  ({ name, parent: "", gstRate: 5, cgstRate: 2.5, sgstRate: 2.5, igstRate: 5, gstRevisions: groupRevs });
const item = (name: string, parent: string, own: GstRevision[] = []): MasterItem =>
  ({ name, parent, baseUnit: "PC", denominator: 1, closingRate: 0, closingStock: 0, gstRate: 0, cgstRate: 0,
     sgstRate: 0, igstRate: 0, gstRevisions: own, gstRateSource: "As per Company/Stock Group" });

const G1 = "BICYCLE PARTS ( 87149990 )", G2 = "BICYCLE PARTS ( 87149400 )", G3 = "TRICYCLE KARNI ( 950300 )";
const masters = {
  company: "TEST", loadedAt: 0, ledgers: new Map(), ledgerLoose: new Map(), itemLoose: new Map(), godowns: new Set(), units: new Set(), voucherTypes: new Set(),
  stockGroups: new Map([G1, G2, G3].map((g) => [g, group(g)])),
  items: new Map([
    // The live items carry their OWN GST block at rate 0 — a placeholder that must not win.
    ["BICYCLE BASKET EHD", item("BICYCLE BASKET EHD", G1, [rev("2024-04-01", 0)])],
    ["BRAKE SHOE  ( POWER )", item("BRAKE SHOE  ( POWER )", G2, [rev("2022-04-01", 0)])],
    ["CARRIER CLIP", item("CARRIER CLIP", G1, [rev("2022-04-01", 0)])],
    ["BABY TRICYCLE MUGHAL DLX RACER BB MSC AMPHA", item("BABY TRICYCLE MUGHAL DLX RACER BB MSC AMPHA", G3, [rev("2022-04-01", 0)])],
    ["HORN X", item("HORN X", G1, [rev("2022-04-01", 18)])],
    ["EV THING", item("EV THING", "EV GOODS")],
  ]),
} as unknown as TallyMasters;

const line = (stockItemName: string, amount: number) => ({
  rate: amount, unit: "PC", amount, quantity: 1, batchName: "Primary Batch", godownName: "Main Location",
  stockItemName, salesLedgerName: "SALES  ( GST W.B. )", isDeemedPositive: false,
});
const payload = (lines: ReturnType<typeof line>[], voucherType = "Sales"): VoucherPayload => {
  const goods = lines.reduce((s, l) => s + l.amount, 0);
  return {
    date: "2026-09-23", voucherType, isInvoice: true, voucherNumber: "T/1", remoteId: "MKCP|T|1",
    partyLedgerName: "Cash", placeOfSupply: "West Bengal",
    ledgerEntries: [{ ledgerName: "Cash", amount: goods, isPartyLedger: true, isDeemedPositive: true }],
    inventoryEntries: lines,
  } as unknown as VoucherPayload;
};
const blocks = (xml: string) => [...xml.matchAll(/<ALLINVENTORYENTRIES\.LIST>([\s\S]*?)<\/ALLINVENTORYENTRIES\.LIST>/g)].map((m) => m[1]);

console.log("26-27/0719 — every line sources its stock group");
const x0719 = buildVoucherImportXml("TEST", payload([
  line("BICYCLE BASKET EHD", 21638.4), line("BRAKE SHOE  ( POWER )", 7257.12),
  line("CARRIER CLIP", 4985.7), line("BABY TRICYCLE MUGHAL DLX RACER BB MSC AMPHA", 10057.12),
]), masters);
const b = blocks(x0719);
ok("four stock lines", b.length === 4);
[G1, G2, G1, G3].forEach((g, i) => {
  ok(`line ${i + 1} → Stock Group ${g}`,
    b[i]?.includes("<GSTSOURCETYPE>Stock Group</GSTSOURCETYPE>") &&
    b[i]?.includes(`<GSTSTOCKGROUPSOURCE>${g}</GSTSTOCKGROUPSOURCE>`) &&
    b[i]?.includes(`<HSNSTOCKGROUPSOURCE>${g}</HSNSTOCKGROUPSOURCE>`) === true);
  ok(`line ${i + 1} taxable goods, rate as per masters`,
    b[i]?.includes("<GSTOVRDNTAXABILITY>Taxable</GSTOVRDNTAXABILITY>") &&
    b[i]?.includes("<GSTOVRDNTYPEOFSUPPLY>Goods</GSTOVRDNTYPEOFSUPPLY>") &&
    b[i]?.includes("<GSTRATEINFERAPPLICABILITY>As per Masters/Company</GSTRATEINFERAPPLICABILITY>") === true);
});
ok("GST block sits right after STOCKITEMNAME (Tally's own order)",
  /<\/STOCKITEMNAME>\s*<GSTOVRDNTAXABILITY>/.test(b[0] ?? ""));

console.log("an item declaring its own rate sources itself");
const own = blocks(buildVoucherImportXml("TEST", payload([line("HORN X", 100)]), masters))[0] ?? "";
ok("Stock Item source", own.includes("<GSTSOURCETYPE>Stock Item</GSTSOURCETYPE>") && own.includes("<GSTITEMSOURCE>HORN X</GSTITEMSOURCE>"));

console.log("nothing resolvable, no masters, or inward → line unchanged");
const none = blocks(buildVoucherImportXml("TEST", payload([line("EV THING", 100)]), masters))[0] ?? "";
ok("no rate anywhere → no GST block", !none.includes("GSTSOURCETYPE"));
const noMasters = blocks(buildVoucherImportXml("TEST", payload([line("CARRIER CLIP", 100)])))[0] ?? "";
ok("no masters → no GST block", !noMasters.includes("GSTSOURCETYPE"));
const inward = blocks(buildVoucherImportXml("TEST", payload([line("CARRIER CLIP", 100)], "Purchase"), masters))[0] ?? "";
ok("purchase untouched (not yet proven against native purchases)", !inward.includes("GSTSOURCETYPE"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
