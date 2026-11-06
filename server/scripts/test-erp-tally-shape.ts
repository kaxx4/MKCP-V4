/**
 * Offline proof for the go-live swap voucher block (D-1-5.58, option C): erpTallyShape.ts gives, from one
 * voucher as the ERP mirror reads it, the rows of tally_vouchers, tally_voucher_ledger_entries and
 * tally_voucher_inventory_entries, built by the mappers the old sync uses, and a test run block carries no
 * personal field.
 *
 *   npx tsx scripts/test-erp-tally-shape.ts
 */
import {
  tallyBlobFrom, TALLY_VOUCHER_COLUMNS, TALLY_LEDGER_ENTRY_COLUMNS, TALLY_INVENTORY_ENTRY_COLUMNS,
} from "../src/services/erpTallyShape.js";
import { mirrorRowFrom, scrubName, scrubSaltFrom } from "../src/services/erpMirrorSync.js";
import { SupabaseSync, voucherChildRows } from "../src/services/supabaseSync.js";

let passed = 0, failed = 0;
const ok = (what: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`  ok    ${what}`); } else { failed++; console.log(`  FAIL  ${what}${detail ? "  - " + detail : ""}`); }
};
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** A converted voucher with every block the full field list brings (fictitious). */
const voucher = (): any => ({
  metadata: { type: "Voucher" }, guid: "zz-guid-1", date: "20261101", effectivedate: "20261101", vouchernumber: "ZZ/1", vouchertypename: "Sales",
  partyledgername: "A Real Party", narration: "A real narration", reference: "REF1", iscancelled: false, isoptional: false, masterid: "77", alterid: "9",
  irn: "IRN-REAL", irnackno: "123", irnackdate: "2026-11-02", irnqr: "QR",
  allledgerentries: [
    { ledgername: "A Real Party", amount: "-1180.00", isdeemedpositive: true, ispartyledger: true, billallocations: [{ name: "B1", amount: "1180" }] },
    { ledgername: "Sales", amount: "1000.00", isdeemedpositive: false, ispartyledger: false },
    { ledgername: "GST", amount: "180.00", isdeemedpositive: false, ispartyledger: false },
  ],
  allinventoryentries: [
    { stockitemname: "Item One", actualqty: "2 nos", billedqty: "2 nos", rate: "500/nos", amount: "1000.00", isdeemedpositive: false, godownname: "Main", batchname: "B", batchallocations: [{ godown: "Main" }] },
  ],
  transport: { ewb_number: "EWB1", ewb_valid_until: "20261105", ewb_details: { cancelled: false }, vehicle_number: "WB00X0000", transport_mode: "1 - Road", transport_distance_km: 90,
    consignee_pincode: "700001", consignee_place: "TOWN", consignee_state: "West Bengal", ship_to_place: "TOWN", dispatch_from_place: "DEPOT", party_gstin: "ZZZ", place_of_supply: "West Bengal" },
  buyer: { buyer_name: "A Buyer", buyer_address: "Street", buyer_pincode: "700002", buyer_pincode_source: "tally", buyer_place: "TOWN", buyer_state: "West Bengal" },
});

const real = { company: "ZZ CO", name: (_k: string, s: string) => (s || "").trim() || null, test: false };
const salt = scrubSaltFrom("zz-key-for-the-test");
const test = { company: "ZZTEST CO", name: (k: string, s: string) => scrubName(k, s, salt), test: true };

console.log("THE THREE ROWS HAVE EXACTLY THE LIVE COLUMNS");
const b = tallyBlobFrom(voucher(), real)!;
ok("a voucher with a GUID gives a block", !!b);
ok("the voucher row has every tally_vouchers column except synced_at (the database stamps it)", same(Object.keys(b.voucher), TALLY_VOUCHER_COLUMNS.filter((c) => c !== "synced_at")), JSON.stringify(Object.keys(b.voucher).filter((k) => !(TALLY_VOUCHER_COLUMNS as readonly string[]).includes(k))));
ok("each ledger line has every tally_voucher_ledger_entries column except id and synced_at", b.ledger_entries.every((r) => same(Object.keys(r), TALLY_LEDGER_ENTRY_COLUMNS.filter((c) => c !== "id" && c !== "synced_at"))));
ok("each inventory line has every tally_voucher_inventory_entries column except id and synced_at", b.inventory_entries.every((r) => same(Object.keys(r), TALLY_INVENTORY_ENTRY_COLUMNS.filter((c) => c !== "id" && c !== "synced_at"))));
ok("three ledger lines and one inventory line, in the order Tally sent them", b.ledger_entries.length === 3 && b.inventory_entries.length === 1 && b.ledger_entries[0].ledger_name === "A Real Party" && b.ledger_entries[2].ledger_name === "GST");

console.log("\nONE DEFINITION: THE OLD SYNC MAPPERS");
const sync = Object.create(SupabaseSync.prototype) as any;
const mapped = sync.mapVoucher(voucher(), "ZZ CO");
const { synced_at: _s, ...mappedNoStamp } = mapped;
ok("every field the old sync writes is in the block unchanged", Object.entries(mappedNoStamp).every(([k, v]) => JSON.stringify(b.voucher[k]) === JSON.stringify(v)));
ok("the date is ISO and the e-way, IRN, buyer and GST fields are filled", b.voucher.date === "2026-11-01" && b.voucher.irn === "IRN-REAL" && b.voucher.ewb_number === "EWB1" && b.voucher.buyer_name === "A Buyer" && b.voucher.party_gstin === "ZZZ" && Number(b.voucher.master_id) === 77);
const kids = voucherChildRows(mapped, "ZZ CO");
ok("the child rows are voucherChildRows output (without the stamp)", JSON.stringify(b.ledger_entries) === JSON.stringify(kids.ledger.map(({ synced_at, ...r }: any) => r)) && JSON.stringify(b.inventory_entries) === JSON.stringify(kids.inventory.map(({ synced_at, ...r }: any) => r)));
ok("remote_id is null and version is 0 (Tally does not export them; reports/1-5.md names the open point)", b.voucher.remote_id === null && b.voucher.version === 0);
ok("a voucher with no GUID gives no block", tallyBlobFrom({ ...voucher(), guid: "" }, real) === null);

console.log("\nA TEST RUN CARRIES NO PERSONAL FIELD");
const tb = tallyBlobFrom(voucher(), test)!;
ok("the party is a keyed stand-in", /^ZZ TEST PARTY [0-9a-f]{10}$/.test(String(tb.voucher.party_ledger_name)));
ok("every ledger line name is a stand-in and its bill allocations are gone", tb.ledger_entries.every((r) => /^ZZ TEST LEDGER [0-9a-f]{10}$/.test(String(r.ledger_name)) && r.bill_allocations === null));
for (const c of ["reference", "irn", "irn_ack_no", "irn_ack_date", "irn_qr", "ewb_number", "ewb_valid_until", "vehicle_number", "consignee_pincode", "consignee_place", "consignee_state", "ship_to_place", "dispatch_from_place", "party_gstin", "buyer_name", "buyer_address", "buyer_pincode", "buyer_place", "buyer_state", "ewb_details", "ledger_entries"]) {
  ok(`test run: ${c} is null`, tb.voucher[c] === null);
}
ok("the narration is dropped unless it already says ZZ TEST", tb.voucher.narration === null && tallyBlobFrom({ ...voucher(), narration: "ZZ TEST note" }, test)!.voucher.narration === "ZZ TEST note");
ok("amounts, dates, types and numbers are kept", tb.voucher.date === "2026-11-01" && tb.ledger_entries[0].amount === "-1180.00" && tb.voucher.voucher_type === "Sales" && tb.voucher.voucher_number === "ZZ/1");
ok("the same name gives the same stand-in in the mirror row and in the block", (() => {
  const row = mirrorRowFrom(voucher(), { scrub: true, salt }, { company: "ZZTEST CO" })!;
  return row.party === tb.voucher.party_ledger_name && (row.row.ledgers as any[])[0].ledger === tb.ledger_entries[0].ledger_name;
})());

console.log("\nTHE MIRROR ROW");
const plain = mirrorRowFrom(voucher(), { scrub: false })!;
ok("without a company the row has no tally block (older callers are unchanged)", !("tally" in plain.row));
const withTally = mirrorRowFrom(voucher(), { scrub: false }, { company: "ZZ CO" })!;
ok("with a company the row carries the block, and nothing else in the row moved", "tally" in withTally.row && JSON.stringify({ ...withTally.row, tally: undefined }) === JSON.stringify({ ...plain.row, tally: undefined }));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
