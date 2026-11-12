/**
 * JOB: build the Import XML for a Stock Journal, the voucher that moves stock without moving money
 * (task C22, a warehouse count difference: the Count screen found more or fewer than the books say).
 *
 * A Stock Journal has no party, no ledger lines and no GST. It has stock lines only, in two directions:
 *   - stock IN  (the count found more):  `INVENTORYENTRIESIN.LIST`,  ISDEEMEDPOSITIVE Yes, amount negative (a debit)
 *   - stock OUT (the count found less):  `INVENTORYENTRIESOUT.LIST`, ISDEEMEDPOSITIVE No,  amount positive (a credit)
 * which is the same sign rule every other stock line here follows (`InventoryEntry.isDeemedPositive` true = arrives).
 *
 * It rides on the same payload as every other voucher (`VoucherPayload` with `voucherType: "Stock Journal"`), so it
 * goes through the same three gates: `pushGuard.guardVoucher`, `safePush` and `tallyPost`. The caller sets
 * `isInvoice: false`, `ledgerEntries: []`, a REMOTEID, a narration naming the count, and one line per item with a
 * godown. A line's amount is a positive value (the house rule: a genuine adjustment is worth at least a rupee, never
 * zero, because a zero-value line books stock out of nothing).
 *
 * Why a module of its own: `buildVoucherImportXml` (voucherPusher.ts) is built around party, ledger lines and tax;
 * a Stock Journal shares almost none of it. `buildVoucherImportXml` hands a Stock Journal here, so there is still one
 * way in.
 *
 * The wire shape was copied from an operator-typed Stock Journal in the dummy company (reports T11-evidence).
 */
import type { InventoryEntry, VoucherPayload } from "../types.js";
import { escapeXml as esc, fmtAmount, fmtQty, fmtSigned, tallyDate } from "./xml.js";

/** The view Tally files an operator-typed Stock Journal under. */
export const STOCK_JOURNAL_VIEW = "Consumption Voucher View";

export const isStockJournal = (voucherType: string): boolean => voucherType.trim().toUpperCase() === "STOCK JOURNAL";

function line(e: InventoryEntry): string {
  const inward = e.isDeemedPositive;
  const tag = inward ? "INVENTORYENTRIESIN.LIST" : "INVENTORYENTRIESOUT.LIST";
  const amt = fmtSigned(e.amount, inward);
  return `
  <${tag}>
    <STOCKITEMNAME>${esc(e.stockItemName)}</STOCKITEMNAME>
    <ISDEEMEDPOSITIVE>${inward ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
    <RATE>${fmtAmount(e.rate)}/${esc(e.unit)}</RATE>
    <AMOUNT>${amt}</AMOUNT>
    <ACTUALQTY>${fmtQty(e.quantity)} ${esc(e.unit)}</ACTUALQTY>
    <BILLEDQTY>${fmtQty(e.quantity)} ${esc(e.unit)}</BILLEDQTY>
    <BATCHALLOCATIONS.LIST>
      <GODOWNNAME>${esc(e.godownName ?? "")}</GODOWNNAME>
      <BATCHNAME>${esc(e.batchName || "Primary Batch")}</BATCHNAME>
      <AMOUNT>${amt}</AMOUNT>
      <ACTUALQTY>${fmtQty(e.quantity)} ${esc(e.unit)}</ACTUALQTY>
      <BILLEDQTY>${fmtQty(e.quantity)} ${esc(e.unit)}</BILLEDQTY>
    </BATCHALLOCATIONS.LIST>
  </${tag}>`;
}

/** The whole Import envelope for one Stock Journal. Throws on a payload that is not one. */
export function buildStockJournalXml(company: string, p: VoucherPayload): string {
  if (!isStockJournal(p.voucherType)) throw new Error(`buildStockJournalXml was given a ${p.voucherType}`);
  if (!(p.inventoryEntries?.length)) throw new Error("A Stock Journal needs at least one stock line.");
  if (p.ledgerEntries?.length) throw new Error("A Stock Journal carries stock lines only; it has no ledger lines.");
  const ins = p.inventoryEntries.filter((e) => e.isDeemedPositive);
  const outs = p.inventoryEntries.filter((e) => !e.isDeemedPositive);
  return `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER${p.remoteId ? ` REMOTEID="${esc(p.remoteId)}"` : ""} VCHTYPE="${esc(p.voucherType)}" ACTION="${esc(p.action ?? "Create")}" OBJVIEW="${STOCK_JOURNAL_VIEW}">
            <DATE>${tallyDate(p.date)}</DATE>
            <VOUCHERTYPENAME>${esc(p.voucherType)}</VOUCHERTYPENAME>
            <ISINVOICE>No</ISINVOICE>
            <PERSISTEDVIEW>${STOCK_JOURNAL_VIEW}</PERSISTEDVIEW>
            ${p.voucherNumber ? `<VOUCHERNUMBER>${esc(p.voucherNumber)}</VOUCHERNUMBER>` : ""}
            ${p.narration ? `<NARRATION>${esc(p.narration)}</NARRATION>` : ""}${ins.map(line).join("")}${outs.map(line).join("")}
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}
