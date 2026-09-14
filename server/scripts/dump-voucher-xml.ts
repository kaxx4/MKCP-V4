/** Print the exact import XML our builder produces, for diffing against a
 *  real Tally-exported voucher. Read-only — sends nothing. */
import { buildVoucherImportXml } from "../src/services/voucherPusher.js";
import type { VoucherPayload } from "../src/types.js";

const payload: VoucherPayload = {
  voucherType: "Sales",
  date: "2026-09-10",
  voucherNumber: "DBG-1",
  reference: "DBG-1",
  narration: "debug",
  partyLedgerName: "ACHARIYA CYCLE STORES (MANGLAMARO)",
  isInvoice: true,
  ledgerEntries: [
    { ledgerName: "ACHARIYA CYCLE STORES (MANGLAMARO)", amount: 100, isDeemedPositive: true, isPartyLedger: true },
    { ledgerName: "SALES  ( GST CENTRAL )", amount: 100, isDeemedPositive: false, isPartyLedger: false },
  ],
  inventoryEntries: [
    {
      stockItemName: "BABY CAR BUMBLE BEE DC 110",
      quantity: 1, unit: "PC", rate: 100, amount: 100,
      isDeemedPositive: false,
      salesLedgerName: "SALES  ( GST CENTRAL )",
      godownName: "Main Location",
    },
  ],
};

console.log(buildVoucherImportXml("M.K.CYCLES (P) LTD. - (from 1-Apr-26)", payload));
