/**
 * A counter sale: does the walk-in's name and address reach the voucher?
 *
 * The owner's report: "when I split a cash invoice, the narration should be
 * empty and the party address should have the name and address — it didn't
 * last time."
 *
 * Target shape read off a REAL voucher (26-27/0657): the buyer's name sits in
 * BASICBUYERNAME, PARTYNAME and PARTYMAILINGNAME, and the address in BOTH
 * ADDRESS.LIST and BASICBUYERADDRESS.LIST.
 */
import { tallyPost } from "../../src/tally.js";
import { pushVoucherToTally } from "../../src/services/voucherPusher.js";
import { loadMasters } from "../../src/services/tallyMasters.js";
import type { VoucherPayload } from "../../src/types.js";
import {
  U, MARK, company, vouchersOnDayXml, objects, fld, flds, block, blocks,
  check, report, remember,
} from "./harness.js";

const TODAY = new Date().toISOString().slice(0, 10);
const N = `${MARK}/CASH${Date.now().toString().slice(-5)}`;
const BUYER = "RAJU CYCLE MART";
const ADDR = ["12 GRAIN MARKET", "BURDWAN-713101"];

(async () => {
  const co = await company();
  const masters = await loadMasters(U, co);
  const item = [...masters.items.values()].find((i) => /BICYCLE/i.test(i.name)) ?? [...masters.items.values()][0];

  const payload = {
    remoteId: `MKCP-SALES-${N}`, voucherType: "Sales", date: TODAY, voucherNumber: N,
    partyLedgerName: "Cash", isInvoice: true, placeOfSupply: "West Bengal",
    // NO narration — the thing being fixed.
    buyerName: BUYER,
    buyerAddress: ADDR,
    ledgerEntries: [
      { ledgerName: "Cash", amount: 1050, isDeemedPositive: true, isPartyLedger: true },
      { ledgerName: "OUTPUT CGST", amount: 25, isDeemedPositive: false, isPartyLedger: false },
      { ledgerName: "OUTPUT SGST", amount: 25, isDeemedPositive: false, isPartyLedger: false },
    ],
    inventoryEntries: [{
      stockItemName: item.name, quantity: 10, unit: item.baseUnit, rate: 100, amount: 1000,
      isDeemedPositive: false, salesLedgerName: "SALES  ( GST W.B. )",
      godownName: "Main Location", batchName: "Primary Batch",
    }],
  } as unknown as VoucherPayload;

  const res = await pushVoucherToTally(U, co, payload, masters);
  remember({ remoteId: payload.remoteId!, voucherType: "Sales", number: N, date: TODAY });
  console.log(`\n  push: created=${res.created} errors=${res.errors}` +
    (res.lineErrors?.length ? ` | ${res.lineErrors.join(" | ")}` : ""));

  const v = objects(await tallyPost(U, vouchersOnDayXml(co, TODAY), 180_000, true) as string, "VOUCHER")
    .find((x) => fld(x.body, "VOUCHERNUMBER") === N);

  /* The FIRST block with content, never blocks[0].
     A voucher carries ~50 empty placeholder .LIST blocks, so [0] is usually
     empty and reads as "the field is missing" on a voucher that has it. */
  const addrOf = (tag: string) => {
    const b = blocks(v!.body, `${tag}\.LIST`).find((x) => flds(x, tag).length) ?? "";
    return flds(b, tag);
  };

  const { failed } = report("counter sale: the walk-in's identity", [
    check("landed", "yes", v ? "yes" : ""),
    check("billed to Cash", "Cash", v ? fld(v.body, "PARTYLEDGERNAME") : null),
    check("NARRATION is empty", "", v ? fld(v.body, "NARRATION") : null,
      { note: "the buyer's name used to be smuggled in here" }),
    check("PARTYMAILINGNAME carries the customer", BUYER, v ? fld(v.body, "PARTYMAILINGNAME") : null,
      { note: "403 of 413 real counter sales name their customer here" }),
    check("ADDRESS line 1", ADDR[0], v ? (addrOf("ADDRESS")[0] ?? "") : null),
    check("ADDRESS line 2", ADDR[1], v ? (addrOf("ADDRESS")[1] ?? "") : null),
    check("PARTYNAME stays the LEDGER", "Cash", v ? fld(v.body, "PARTYNAME") : null,
      { note: "the accounting party and the person are different things" }),
    check("BASICBASEPARTYNAME stays the LEDGER", "Cash", v ? fld(v.body, "BASICBASEPARTYNAME") : null),
    check("no BASICBUYERADDRESS", "", v ? (addrOf("BASICBUYERADDRESS")[0] ?? "") : null,
      { note: "zero of 413 real counter sales carry one" }),
  ]);

  const del = await pushVoucherToTally(U, co, { ...payload, action: "Delete" } as VoucherPayload, masters);
  console.log(`  cleanup: deleted=${(del as unknown as { deleted?: number }).deleted ?? 0}\n`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
