/**
 * Does a PUSHED invoice keep its party GST identity?
 *
 * The vault recorded this as an open question — "Tally accepts the push,
 * answers created=1, and does not keep them" — and the project's plan carries
 * it as an unresolved risk, because a voucher with no GST identity balances,
 * reads back byte-identical and still files into a GSTR exception.
 *
 * That finding was made with a push path that never sent the tags:
 * `pushVoucherToTally` took no `masters`, and `buildGstIdentity` returns ""
 * without them. The XML was inspected separately, WITH masters, which is why
 * it looked as though Tally were discarding fields it had been given.
 *
 * This asks the question properly: push through the same builder the app uses,
 * with masters, and read every identity field back.
 */
import { tallyPost } from "../../src/tally.js";
import { pushVoucherToTally } from "../../src/services/voucherPusher.js";
import { loadMasters } from "../../src/services/tallyMasters.js";
import type { VoucherPayload } from "../../src/types.js";
import { U, MARK, company, vouchersOnDayXml, objects, fld, check, report, remember } from "./harness.js";

const TODAY = new Date().toISOString().slice(0, 10);
const STAMP = Date.now().toString().slice(-5);

(async () => {
  const co = await company();
  const masters = await loadMasters(U, co);
  const L = [...masters.ledgers.values()];
  const item = [...masters.items.values()][0];
  const party = L.find((l) => /Sundry Debtors/i.test(l.parent) && /west bengal/i.test(l.state) && l.gstin)!;

  const n = `${MARK}/GST${STAMP}`;
  const narr = `${MARK} gst identity ${STAMP}`;
  const p = {
    remoteId: `MKCP-SALES-${n}`, voucherType: "Sales", date: TODAY, voucherNumber: n,
    narration: narr, partyLedgerName: party.name, isInvoice: true,
    ledgerEntries: [
      { ledgerName: party.name, amount: 1050, isDeemedPositive: true, isPartyLedger: true },
      { ledgerName: "OUTPUT CGST", amount: 25, isDeemedPositive: false, isPartyLedger: false },
      { ledgerName: "OUTPUT SGST", amount: 25, isDeemedPositive: false, isPartyLedger: false },
    ],
    inventoryEntries: [{ stockItemName: item.name, quantity: 10, unit: item.baseUnit, rate: 100, amount: 1000,
      isDeemedPositive: false, salesLedgerName: "SALES  ( GST W.B. )", godownName: "Main Location", batchName: "Primary Batch" }],
  } as unknown as VoucherPayload;

  remember({ remoteId: p.remoteId!, voucherType: "Sales", number: n, date: TODAY });
  const res = await pushVoucherToTally(U, co, p, masters);
  const v = objects(await tallyPost(U, vouchersOnDayXml(co, TODAY), 240_000, true) as string, "VOUCHER")
    .find((x) => fld(x.body, "NARRATION") === narr);

  const { failed } = report("pushed invoice: is the GST identity kept?", [
    check("created", "1", String(res.created)),
    check("PARTYGSTIN", party.gstin!, v ? fld(v.body, "PARTYGSTIN") : null),
    check("STATENAME", party.state!, v ? fld(v.body, "STATENAME") : null),
    check("PLACEOFSUPPLY", party.state!, v ? fld(v.body, "PLACEOFSUPPLY") : null),
    check("CONSIGNEEGSTIN", party.gstin!, v ? fld(v.body, "CONSIGNEEGSTIN") : null),
    check("GSTREGISTRATIONTYPE", "Regular", v ? fld(v.body, "GSTREGISTRATIONTYPE") : null),
    check("COUNTRYOFRESIDENCE", "India", v ? fld(v.body, "COUNTRYOFRESIDENCE") : null),
  ]);

  await pushVoucherToTally(U, co, { ...p, action: "Delete" } as VoucherPayload, masters);
  console.log(`  cleaned up\n`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
