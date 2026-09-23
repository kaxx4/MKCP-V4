/**
 * Bill-to = ship-to, GST identity and line GST detail in the XML we SEND —
 * offline, no Tally. The live proof is test-push-fidelity-sandbox.ts; this pins
 * the builder so a regression is caught before anything is pushed.
 *
 * Owner, 23-Sep-2026: "You are adding the bill-to address but not the ship-to …
 * when pushing a cash invoice the ship-to address is empty; when pushing a
 * normal ledger invoice as well the ship-to is empty, and that's giving an error
 * in the e-way bill." Fixtures are the real masters of RANI CYCLE STORES
 * ( BHANGAR ) and DIBYASAKTI CYCLE STORE (JALESWAR) as the sandbox holds them.
 *
 *   npx tsx scripts/test-party-identity-xml.ts
 */
import { buildVoucherImportXml, partyIdentity, normaliseRegistrationType, pincodeIn } from "../src/services/voucherPusher.js";
import { diffIdentity } from "../src/services/safePush.js";
import { mailingOn, hsnFor, type TallyMasters, type MasterLedger, type MasterItem, type MasterStockGroup, type GstRevision } from "../src/services/tallyMasters.js";
import type { VoucherPayload } from "../src/types.js";

let passed = 0, failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) passed++; else failed++;
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const rev = (from: string, igst: number): GstRevision =>
  ({ from, rate: igst, cgst: igst / 2, sgst: igst / 2, igst, taxability: "Taxable" });
const led = (o: Partial<MasterLedger> & { name: string }): MasterLedger =>
  ({ parent: "SUNDRY DEBTORS (EG)", gstin: "", state: "", pincode: "", mailingName: o.name, address: [], registrations: [], ...o });

const RANI = led({
  name: "RANI CYCLE STORES ( BHANGAR )", state: "West Bengal", pincode: "743502", address: ["BHANGAR-743502"],
  gstin: "19AAAAR0000R1Z5",
  registrations: [{ applicableFrom: "20240401", gstin: "19AAAAR0000R1Z5", registrationType: "Regular", placeOfSupply: "West Bengal", state: "" }],
  mailing: [{ applicableFrom: "20240401", mailingName: "RANI CYCLE STORES ( BHANGAR )", address: ["BHANGAR-743502"], pincode: "743502", state: "West Bengal", country: "India" }],
});
const DIBYA = led({
  name: "DIBYASAKTI CYCLE STORE (JALESWAR)", state: "Odisha", pincode: "756032", mailingName: "DIBYASAKTI CYCLE STORE",
  address: ["JALESWAR, ODISHA", "(PAN: AAAAD0000D)"], gstin: "21AAAAD0000D1Z6",
  registrations: [{ applicableFrom: "20220401", gstin: "21AAAAD0000D1Z6", registrationType: "Regular", placeOfSupply: "Odisha", state: "Odisha" }],
});
// A party that MOVED: the old address must stay on old vouchers.
const MOVER = led({
  name: "MOVER CYCLES", state: "West Bengal", pincode: "700002", address: ["NEW ROAD"],
  registrations: [{ applicableFrom: "20240401", gstin: "", registrationType: "\x04 Unknown", placeOfSupply: "West Bengal", state: "West Bengal" }],
  mailing: [
    { applicableFrom: "20240401", mailingName: "MOVER CYCLES", address: ["OLD ROAD"], pincode: "700001", state: "West Bengal", country: "India" },
    { applicableFrom: "20260901", mailingName: "MOVER CYCLES", address: ["NEW ROAD"], pincode: "700002", state: "West Bengal", country: "India" },
  ],
});
const CASH = led({ name: "Cash", parent: "Cash-in-Hand", mailingName: "Cash" });

const G = "BICYCLE PARTS ( 87149210 )", K = "TRICYCLE KARNI ( 950300 )";
const group = (name: string, igst: number, hsn: string, desc: string): MasterStockGroup =>
  ({ name, parent: "", gstRate: igst, cgstRate: igst / 2, sgstRate: igst / 2, igstRate: igst,
     gstRevisions: [rev("2025-09-22", igst)], hsnRevisions: [{ from: "2022-04-01", code: hsn, description: desc }] });
const item = (name: string, parent: string, own: GstRevision[] = []): MasterItem =>
  ({ name, parent, baseUnit: "PC", denominator: 1, closingRate: 0, closingStock: 0, gstRate: 0, cgstRate: 0, sgstRate: 0,
     igstRate: 0, gstRevisions: own, gstRateSource: "", hsnRevisions: [] });

const masters = {
  company: "TEST", loadedAt: 0, ledgerLoose: new Map(), itemLoose: new Map(),
  godowns: new Set(["Main Location"]), units: new Set(["PC"]), voucherTypes: new Set(["SALES"]),
  ledgers: new Map([RANI, DIBYA, MOVER, CASH].map((l) => [l.name, l])),
  stockGroups: new Map([[G, group(G, 5, "87149210", "BICYCLE PARTS")], [K, group(K, 5, "950300", "BABY TRICYCLE")]]),
  items: new Map([
    ["RIM DLR", item("RIM DLR", G)],
    // Declares its own 18% but inherits its HSN — the two chains are separate.
    ["BABY TRICYCLE HUNTER", item("BABY TRICYCLE HUNTER", K, [rev("2024-04-01", 18)])],
  ]),
} as unknown as TallyMasters;

const sale = (partyLedgerName: string, o: Partial<VoucherPayload> = {}): VoucherPayload => ({
  voucherType: "Sales", date: "2026-09-23", voucherNumber: "T/1", remoteId: "MKCP|TEST|T1", isInvoice: true,
  partyLedgerName,
  ledgerEntries: [{ ledgerName: partyLedgerName, amount: 100, isDeemedPositive: true, isPartyLedger: true }],
  inventoryEntries: [{ stockItemName: "RIM DLR", quantity: 1, unit: "PC", rate: 100, amount: 100, isDeemedPositive: false,
    salesLedgerName: "SALES  ( GST W.B. )", godownName: "Main Location", batchName: "Primary Batch" }],
  ...o,
} as VoucherPayload);

const header = (xml: string) => xml.replace(/<ALLINVENTORYENTRIES\.LIST>[\s\S]*?<\/ALLINVENTORYENTRIES\.LIST>/g, "")
  .replace(/<LEDGERENTRIES\.LIST>[\s\S]*?<\/LEDGERENTRIES\.LIST>/g, "");
const tag = (x: string, t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(x)?.[1] ?? "";
const lines = (x: string, t: string) => [...x.matchAll(new RegExp(`<${t}\\.LIST[^>]*>([\\s\\S]*?)</${t}\\.LIST>`, "g"))]
  .map((b) => [...b[1].matchAll(new RegExp(`<${t}>([^<]*)</${t}>`, "g"))].map((m) => m[1]));

console.log("registered local party — ship-to = bill-to, from the LEDGER, typed copy ignored");
{
  const h = header(buildVoucherImportXml("TEST", sale(RANI.name, { partyAddress: ["TYPED COPY"] }), masters));
  ok("exactly ONE bill-to ADDRESS.LIST", lines(h, "ADDRESS").length === 1, JSON.stringify(lines(h, "ADDRESS")));
  ok("bill-to = ledger address", JSON.stringify(lines(h, "ADDRESS")[0]) === JSON.stringify(["BHANGAR-743502"]));
  ok("typed partyAddress never sent when the ledger is known", !h.includes("TYPED COPY"));
  ok("ship-to BASICBUYERADDRESS = bill-to", JSON.stringify(lines(h, "BASICBUYERADDRESS")[0]) === JSON.stringify(["BHANGAR-743502"]));
  ok("BASICBUYERNAME = the party ledger", tag(h, "BASICBUYERNAME") === RANI.name);
  for (const [a, b] of [["PARTYMAILINGNAME", "CONSIGNEEMAILINGNAME"], ["PARTYGSTIN", "CONSIGNEEGSTIN"],
    ["PARTYPINCODE", "CONSIGNEEPINCODE"], ["STATENAME", "CONSIGNEESTATENAME"], ["COUNTRYOFRESIDENCE", "CONSIGNEECOUNTRYNAME"]]) {
    ok(`${b} = ${a} ("${tag(h, a)}")`, !!tag(h, a) && tag(h, a) === tag(h, b));
  }
  ok("GSTREGISTRATIONTYPE Regular, VATDEALERTYPE Regular", tag(h, "GSTREGISTRATIONTYPE") === "Regular" && tag(h, "VATDEALERTYPE") === "Regular");
  ok("PLACEOFSUPPLY West Bengal", tag(h, "PLACEOFSUPPLY") === "West Bengal");
}

console.log("inter-state party");
{
  const h = header(buildVoucherImportXml("TEST", sale(DIBYA.name), masters));
  ok("place of supply and both states = Odisha", ["PLACEOFSUPPLY", "STATENAME", "CONSIGNEESTATENAME"].every((t) => tag(h, t) === "Odisha"));
  ok("two-line address on bill-to AND ship-to", JSON.stringify(lines(h, "ADDRESS")[0]) === JSON.stringify(lines(h, "BASICBUYERADDRESS")[0]) && lines(h, "ADDRESS")[0]?.length === 2);
  ok("mailing name is the master's, not the ledger name", tag(h, "CONSIGNEEMAILINGNAME") === "DIBYASAKTI CYCLE STORE");
}

console.log("cash walk-in — the typed buyer is bill-to AND ship-to");
{
  const p = sale("Cash", { placeOfSupply: "West Bengal", buyerName: "TAPAS CYCLE", buyerAddress: ["12 TEST LANE", "BARASAT 700124"] });
  const h = header(buildVoucherImportXml("TEST", p, masters));
  ok("bill-to = typed lines", JSON.stringify(lines(h, "ADDRESS")[0]) === JSON.stringify(["12 TEST LANE", "BARASAT 700124"]));
  ok("ship-to = typed lines", JSON.stringify(lines(h, "BASICBUYERADDRESS")[0]) === JSON.stringify(["12 TEST LANE", "BARASAT 700124"]));
  ok("PARTYMAILINGNAME and CONSIGNEEMAILINGNAME = walk-in", tag(h, "PARTYMAILINGNAME") === "TAPAS CYCLE" && tag(h, "CONSIGNEEMAILINGNAME") === "TAPAS CYCLE");
  ok("BASICBUYERNAME stays the Cash ledger (native shape)", tag(h, "BASICBUYERNAME") === "Cash");
  ok("Unregistered/Consumer — Tally's word, not 'Unregistered'", tag(h, "GSTREGISTRATIONTYPE") === "Unregistered/Consumer");
  ok("VATDEALERTYPE Unregistered", tag(h, "VATDEALERTYPE") === "Unregistered");
  ok("home state on both sides", tag(h, "STATENAME") === "West Bengal" && tag(h, "CONSIGNEESTATENAME") === "West Bengal");
  ok("typed PIN reaches PARTYPINCODE + CONSIGNEEPINCODE", tag(h, "PARTYPINCODE") === "700124" && tag(h, "CONSIGNEEPINCODE") === "700124");
  ok("no GSTIN on either side", !tag(h, "PARTYGSTIN") && !tag(h, "CONSIGNEEGSTIN"));
  const blank = header(buildVoucherImportXml("TEST", sale("Cash", { placeOfSupply: "West Bengal" }), masters));
  ok("walk-in with no typed name falls back to the ledger's mailing name", tag(blank, "PARTYMAILINGNAME") === "Cash" && tag(blank, "CONSIGNEEMAILINGNAME") === "Cash");
  ok("typed name/address IGNORED on a real party ledger",
    !header(buildVoucherImportXml("TEST", sale(RANI.name, { buyerName: "SOMEONE", buyerAddress: ["ELSEWHERE"] }), masters)).match(/SOMEONE|ELSEWHERE/));
}

console.log("dated mailing and registration");
{
  ok("mailingOn picks the block in force on the voucher date", mailingOn(MOVER, "2026-08-01").address[0] === "OLD ROAD" && mailingOn(MOVER, "2026-09-23").address[0] === "NEW ROAD");
  const h = header(buildVoucherImportXml("TEST", sale(MOVER.name, { date: "2026-08-01" }), masters));
  ok("a backdated voucher carries the OLD address and pin", lines(h, "ADDRESS")[0]?.[0] === "OLD ROAD" && tag(h, "CONSIGNEEPINCODE") === "700001");
  ok("'\\x04 Unknown' registration is never sent verbatim", tag(h, "GSTREGISTRATIONTYPE") === "Unregistered/Consumer" && !h.includes("\x04"));
  ok("normaliseRegistrationType", normaliseRegistrationType("Unregistered", false) === "Unregistered/Consumer"
    && normaliseRegistrationType("", true) === "Regular" && normaliseRegistrationType("Composition", true) === "Composition");
  ok("pincodeIn", pincodeIn(["HABRA - 743263"]) === "743263" && pincodeIn(["PH 9831640650"]) === "" && pincodeIn(["NO PIN"]) === "");
}

console.log("line GST — rate details and HSN, the shape a typed line stores");
{
  const xml = buildVoucherImportXml("TEST", sale(RANI.name, { inventoryEntries: [
    { stockItemName: "RIM DLR", quantity: 1, unit: "PC", rate: 100, amount: 100, isDeemedPositive: false, salesLedgerName: "SALES  ( GST W.B. )" },
    { stockItemName: "BABY TRICYCLE HUNTER", quantity: 1, unit: "PC", rate: 100, amount: 100, isDeemedPositive: false, salesLedgerName: "SALES  ( GST W.B. )" },
  ], ledgerEntries: [{ ledgerName: RANI.name, amount: 200, isDeemedPositive: true, isPartyLedger: true }] }), masters);
  const b = [...xml.matchAll(/<ALLINVENTORYENTRIES\.LIST>([\s\S]*?)<\/ALLINVENTORYENTRIES\.LIST>/g)].map((m) => m[1]);
  const heads = (x: string) => [...x.matchAll(/<RATEDETAILS\.LIST>([\s\S]*?)<\/RATEDETAILS\.LIST>/g)].map((m) => `${tag(m[1], "GSTRATEDUTYHEAD")}:${tag(m[1], "GSTRATE")}:${tag(m[1], "GSTRATEVALUATIONTYPE")}`);
  ok("5% group line → CGST 2.5 / SGST 2.5 / IGST 5 / Cess n.a. / State Cess 0",
    JSON.stringify(heads(b[0])) === JSON.stringify(["CGST:2.5:Based on Value", "SGST/UTGST:2.5:Based on Value", "IGST:5:Based on Value", "Cess:0:&#4; Not Applicable", "State Cess:0:Based on Value"]), JSON.stringify(heads(b[0])));
  ok("HSN 87149210 + description on the group line", tag(b[0], "GSTHSNNAME") === "87149210" && tag(b[0], "GSTHSNDESCRIPTION") === "BICYCLE PARTS");
  ok("own-rate item: 18% from the ITEM", tag(b[1], "GSTSOURCETYPE") === "Stock Item" && heads(b[1])[2] === "IGST:18:Based on Value");
  ok("own-rate item: HSN from its GROUP (separate chain)", tag(b[1], "HSNSOURCETYPE") === "Stock Group" && tag(b[1], "HSNSTOCKGROUPSOURCE") === K && tag(b[1], "GSTHSNNAME") === "950300");
  ok("hsnFor", hsnFor(masters, "BABY TRICYCLE HUNTER", "2026-09-23").code === "950300");
}

console.log("money vouchers and no-masters builds are unchanged");
{
  const pay = buildVoucherImportXml("TEST", { voucherType: "Payment", date: "2026-09-23", partyLedgerName: RANI.name, isInvoice: false,
    ledgerEntries: [{ ledgerName: RANI.name, amount: 10, isDeemedPositive: true, isPartyLedger: true }, { ledgerName: "Cash", amount: 10, isDeemedPositive: false, isPartyLedger: false }] } as VoucherPayload, masters);
  ok("a Payment carries no identity at all", !/BASICBUYER|CONSIGNEE|PARTYGSTIN|ADDRESS\.LIST/.test(pay));
  const bare = header(buildVoucherImportXml("TEST", sale(RANI.name, { partyAddress: ["FALLBACK LINE"] })));
  ok("without masters the payload's partyAddress is the (only) address", lines(bare, "ADDRESS").length === 1 && lines(bare, "ADDRESS")[0][0] === "FALLBACK LINE");
}

console.log("safePush read-back — identity drift is a verification failure");
{
  const p = sale(RANI.name);
  const id = partyIdentity(p, masters)!;
  const xml = buildVoucherImportXml("TEST", p, masters);
  const stored = /<VOUCHER\b[\s\S]*<\/VOUCHER>/.exec(xml)![0];
  // What was sent reads back identically, except the line rate check needs RATEDETAILS — which we sent.
  ok("identical stored voucher → no differences", diffIdentity(p, masters, stored, id).length === 0, diffIdentity(p, masters, stored, id).join(" · "));
  const noShip = stored.replace(/<BASICBUYERADDRESS\.LIST[\s\S]*?<\/BASICBUYERADDRESS\.LIST>/, "");
  ok("ship-to address dropped → reported", diffIdentity(p, masters, noShip, id).some((d) => d.startsWith("ship-to address")));
  const noRate = stored.replace(/<RATEDETAILS\.LIST>[\s\S]*?<\/RATEDETAILS\.LIST>/g, "");
  ok("line rate dropped → reported as 'not specified'", diffIdentity(p, masters, noRate, id).some((d) => /Tax rate not specified/.test(d)));
  const doubled = stored.replace(/<ADDRESS\.LIST TYPE="String">/, `<ADDRESS.LIST TYPE="String"><ADDRESS>TYPED COPY</ADDRESS>`);
  ok("an extra bill-to line → reported", diffIdentity(p, masters, doubled, id).some((d) => d.startsWith("bill-to address")));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
