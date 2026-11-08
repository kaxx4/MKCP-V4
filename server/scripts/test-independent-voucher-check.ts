/**
 * Offline proof for review item 13 of thread 8: the independent reading of a voucher's raw XML agrees with the block the
 * real chain builds from the same XML (the agent's read, the converter, the mapper), and it catches a flipped sign, a
 * changed quantity, rate, date, a leaked personal field, and a missing line.
 *   npx tsx scripts/test-independent-voucher-check.ts
 */
import { XMLParser } from "fast-xml-parser";
import { tallyMirrorReads, scrubName, scrubSaltFrom } from "../src/services/erpMirrorSync.js";
import { tallyBlobFrom } from "../src/services/erpTallyShape.js";
import { compareRawToBlock, numOf, parseRawVoucher, pickForCheck, splitRawVouchers } from "./rigs/lib/independentVoucherCheck.js";

let passed = 0, failed = 0;
const ok = (what: string, cond: boolean, detail = "") => { if (cond) passed++; else { failed++; console.log(`  FAIL  ${what}${detail ? "  - " + detail : ""}`); } };

// the same parser options as tally.ts (the reply is parsed there before the converter sees it)
const ARRAY = new Set(["TALLYMESSAGE", "VOUCHER", "LEDGER", "ALLLEDGERENTRIES", "LEDGERENTRIES", "ALLINVENTORYENTRIES", "INVENTORYENTRIES", "BILLALLOCATIONS", "BATCHALLOCATIONS", "ACCOUNTINGALLOCATIONS", "BANKALLOCATIONS", "GSTDETAILS", "HSNDETAILS", "STATEWISEDETAILS", "RATEDETAILS"]);
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", parseTagValue: false, trimValues: true, isArray: (t) => ARRAY.has(t.toUpperCase().replace(/\.LIST$/, "")) });

const sales = (guid: string, n: string) => `<VOUCHER REMOTEID="${guid}" VCHTYPE="Sales" ACTION="Create">
 <GUID>${guid}</GUID><DATE>20261101</DATE><EFFECTIVEDATE>20261101</EFFECTIVEDATE><VOUCHERNUMBER>${n}</VOUCHERNUMBER><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
 <PARTYLEDGERNAME>PARTY 001 &amp; SONS</PARTYLEDGERNAME><PARTYMAILINGNAME>PARTY 001 &amp; SONS</PARTYMAILINGNAME><NARRATION>ZZ TEST narration</NARRATION><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL>
 <PARTYGSTIN>ZZZ00AAAAA0000A1Z0</PARTYGSTIN><PLACEOFSUPPLY>West Bengal</PLACEOFSUPPLY><ALTERID>41</ALTERID><MASTERID>9</MASTERID>
 <IRN>ZZIRN1</IRN><IRNACKNO>5551</IRNACKNO>
 <EWAYBILLDETAILS.LIST><BILLNUMBER>ZZEWB1</BILLNUMBER><VALIDUPTO>20261105</VALIDUPTO><TRANSPORTDETAILS.LIST><TRANSPORTMODE>1 - Road</TRANSPORTMODE><DISTANCE> 104</DISTANCE><VEHICLENUMBER>ZZ00ZZ0000</VEHICLENUMBER></TRANSPORTDETAILS.LIST></EWAYBILLDETAILS.LIST>
 <ALLLEDGERENTRIES.LIST><LEDGERNAME>PARTY 001 &amp; SONS</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>-1,180.00</AMOUNT>
   <BILLALLOCATIONS.LIST><NAME>B1</NAME><AMOUNT>-1180.00</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST>
 <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
 <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output GST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>180.00</AMOUNT></ALLLEDGERENTRIES.LIST>
 <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Item One</STOCKITEMNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><RATE>500.00/nos</RATE><AMOUNT>1000.00</AMOUNT><ACTUALQTY> 2 nos</ACTUALQTY><BILLEDQTY> 2 nos</BILLEDQTY>
   <BATCHALLOCATIONS.LIST><GODOWNNAME>Main</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><AMOUNT>1000.00</AMOUNT><ACTUALQTY> 2 nos</ACTUALQTY></BATCHALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>
</VOUCHER>`;
const reply = (...v: string[]) => `<ENVELOPE><BODY><DATA><COLLECTION>${v.join("")}</COLLECTION></DATA></BODY></ENVELOPE>`;

const salt = scrubSaltFrom("zz-key-independent-check");
const real = { company: "ZZ CO", name: (_k: string, s: string) => (s || "").trim() || null, test: false };
const test = { company: "ZZTEST CO", name: (k: string, s: string) => scrubName(k, s, salt), test: true };

(async () => {
  const xml = reply(sales("g-1", "ZZ/1"), sales("g-2", "ZZ/2"));
  const reads = tallyMirrorReads("http://x", "ZZ CO", async () => parser.parse(xml));
  const converted = await reads.vouchersOn("2026-11-01");
  ok("the real chain read two vouchers out of the XML", converted.length === 2, String(converted.length));
  const raws = splitRawVouchers(xml).map(parseRawVoucher);
  ok("the independent reader finds two vouchers, three ledger lines and one stock line each", raws.length === 2 && raws[0].ledger.length === 3 && raws[0].stock.length === 1, JSON.stringify(raws[0].ledger));
  ok("nested lists are not read as the line's own (the bill allocation's amount is not the line's)", raws[0].ledger[0].cents === -118000 && raws[0].stock[0].cents === 100000 && raws[0].stock[0].qty === 2 && raws[0].stock[0].rate === 500);
  ok("the e-way bill and distance come from their own lists", raws[0].ewbNumber === "ZZEWB1" && raws[0].distance === 104 && raws[0].transportMode === "1 - Road" && raws[0].date === "2026-11-01");
  { const parts = splitRawVouchers("<COLLECTION><VOUCHER.LIST><X>1</X></VOUCHER.LIST><VOUCHER ACTION=\"Create\"><DATE>20261101</DATE></VOUCHER></COLLECTION>"); ok("a tag that only starts with VOUCHER is not read as a voucher", parts.length === 1 && parts[0].startsWith("<VOUCHER ACTION"), JSON.stringify(parts)); }
  ok("numOf reads grouped, signed and unit-suffixed numbers", numOf("-1,180.00") === -1180 && numOf(" 104") === 104 && numOf("500.00/nos") === 500 && numOf("") === null && numOf("2 nos") === 2);

  // real mode: the block agrees with the XML
  const blocks = converted.map((v: any) => tallyBlobFrom(v, real)!);
  const diffs = raws.flatMap((r, i) => compareRawToBlock(r, blocks[i], { test: false }));
  ok("a real block built from the XML agrees with the XML on every compared field", diffs.length === 0, diffs.join(" ; "));

  // test mode: personal fields must be null in the block, and are
  const tblocks = converted.map((v: any) => tallyBlobFrom(v, test)!);
  const tdiffs = raws.flatMap((r, i) => compareRawToBlock(r, tblocks[i], { test: true }));
  ok("a test block agrees with the XML where it should and holds no personal field", tdiffs.length === 0, tdiffs.join(" ; "));
  ok("...and really did null them (the check would be vacuous otherwise)", tblocks.every((b) => b.voucher.ewb_number === null && b.voucher.irn === null && b.voucher.party_gstin === null && b.voucher.buyer_name === null));

  // each planted fault is caught
  const clone = (b: any) => JSON.parse(JSON.stringify(b));
  const plant = (mut: (b: any) => void, test_ = false) => { const b = clone(test_ ? tblocks[0] : blocks[0]); mut(b); return compareRawToBlock(raws[0], b, { test: test_ }); };
  ok("a debit turned into a credit is caught", plant((b) => { b.ledger_entries[0].is_debit = false; }).length > 0);
  ok("an amount whose sign flipped is caught", plant((b) => { b.ledger_entries[1].amount = "-1000.00"; }).length > 0);
  ok("an amount one paisa off is caught", plant((b) => { b.ledger_entries[1].amount = "1000.01"; }).length > 0);
  ok("a debit carrying a positive amount in the block is called out", plant((b) => { b.ledger_entries[0].amount = "1180.00"; }).some((x) => /positive amount/.test(x)));
  ok("a missing ledger line is caught", plant((b) => { b.ledger_entries.pop(); }).some((x) => /ledger line/.test(x)));
  ok("a changed quantity is caught", plant((b) => { b.inventory_entries[0].actual_qty = "3 nos"; }).some((x) => /stock lines differ/.test(x)));
  ok("a changed rate is caught", plant((b) => { b.inventory_entries[0].rate = "501/nos"; }).some((x) => /stock lines differ/.test(x)));
  ok("a changed billed quantity is caught", plant((b) => { b.inventory_entries[0].billed_qty = "1 nos"; }).some((x) => /stock lines differ/.test(x)));
  ok("a missing stock line is caught", plant((b) => { b.inventory_entries = []; }).some((x) => /stock line/.test(x)));
  ok("a changed date is caught", plant((b) => { b.voucher.date = "2026-11-02"; }).some((x) => /date/.test(x)));
  ok("a changed voucher number is caught", plant((b) => { b.voucher.voucher_number = "ZZ/9"; }).some((x) => /voucher number/.test(x)));
  ok("a changed transport distance is caught", plant((b) => { b.voucher.transport_distance_km = 99; }).some((x) => /distance/.test(x)));
  ok("a changed place of supply is caught", plant((b) => { b.voucher.place_of_supply = "Bihar"; }).some((x) => /place of supply/.test(x)));
  // review of threads 9 and 10, item 5: a line is keyed by its name too, and a buyer the XML has must be in a real block
  ok("real mode: two ledger names swapped between lines (same amounts) are caught", plant((b) => { const t = b.ledger_entries[1].ledger_name; b.ledger_entries[1].ledger_name = b.ledger_entries[2].ledger_name; b.ledger_entries[2].ledger_name = t; }).some((x) => /ledger lines differ/.test(x)));
  ok("real mode: a ledger line moved to another ledger is caught", plant((b) => { b.ledger_entries[1].ledger_name = "Other ledger"; }).some((x) => /ledger lines differ/.test(x)));
  ok("real mode: a stock line under another item name is caught", plant((b) => { b.inventory_entries[0].stock_item_name = "Item Two"; }).some((x) => /stock lines differ/.test(x)));
  ok("real mode: the lines are read with their names (the XML side too)", raws[0].ledger.map((l) => l.name).join("|") === "PARTY 001 & SONS|Sales|Output GST" && raws[0].stock[0].name === "Item One");
  ok("real mode: a buyer the XML holds but the block lacks is caught", plant((b) => { b.voucher.buyer_name = null; }).some((x) => /buyer name is empty/.test(x)));
  ok("real mode: a buyer the XML does not hold is caught", plant((b) => { b.voucher.buyer_name = "Somebody Else"; }).some((x) => /buyer name in the block is not one the XML holds/.test(x)));
  ok("test mode still compares lines without names (they are scrubbed) and still agrees", compareRawToBlock(raws[0], tblocks[0], { test: true }).length === 0);
  ok("real mode: an e-way bill number dropped from the block is caught", plant((b) => { b.voucher.ewb_number = null; }).some((x) => /e-way bill number/.test(x)));
  ok("real mode: a wrong IRN is caught", plant((b) => { b.voucher.irn = "OTHER"; }).some((x) => /IRN/.test(x)));
  ok("real mode: a dropped party GSTIN is caught", plant((b) => { b.voucher.party_gstin = null; }).some((x) => /GSTIN/.test(x)));
  ok("test mode: a personal field that leaked into the block is caught", plant((b) => { b.voucher.irn = "ZZIRN1"; }, true).some((x) => /leaked/.test(x)));
  ok("test mode: a leaked transport distance is caught", plant((b) => { b.voucher.transport_distance_km = 104; }, true).some((x) => /distance/.test(x)));
  ok("test mode: a leaked buyer name is caught", plant((b) => { b.voucher.buyer_name = "A Buyer"; }, true).some((x) => /buyer name/.test(x)));
  ok("no block at all is reported", compareRawToBlock(raws[0], null, { test: true }).length === 1);

  // picking
  const many = Array.from({ length: 30 }, (_, i) => ({ ...raws[0], guid: "g" + i, number: "N" + i }));
  ok("pickForCheck returns at most the number asked for, without repeats", pickForCheck(many, 8).length === 8 && new Set(pickForCheck(many, 8).map((r) => r.guid)).size === 8);
  ok("pickForCheck of an empty reply is empty", pickForCheck([], 8).length === 0);

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
