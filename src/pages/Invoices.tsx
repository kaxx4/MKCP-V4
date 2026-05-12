import { useState, useMemo, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Upload, FileText, X, CheckCircle2, XCircle } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { useDataStore } from "../store/dataStore";
import { useUIStore } from "../store/uiStore";
import { computeOutstandingInvoices, computeItemMargins, type InvoiceRecord } from "../engine/financial";
import { fmtINR, fmtDate } from "../utils/format";
import type { CanonicalVoucher, ParsedData } from "../types/canonical";
import { useTallyPriceListStore, type TallyPriceEntry } from "../store/tallyPriceListStore";
import { RatePill, AmountPill, priceMatches } from "../components/PriceVerification";

type FilterType = "All" | "Sales" | "Purchase" | "Receipt" | "Payment";

/** Unified row type covering invoices AND payments/receipts */
interface TxRow {
  voucherId: string;
  voucherNumber: string;
  date: string;
  partyName: string;
  amount: number;
  outstanding: number | null;   // null for P&R
  dueDate: string | null;
  daysPastDue: number;
  agingBucket: InvoiceRecord["agingBucket"] | null;
  txType: "Sales" | "Purchase" | "Receipt" | "Payment";
}

function buildTxRows(
  invoices: InvoiceRecord[],
  vouchers: CanonicalVoucher[],
  ledgers: ParsedData["ledgers"]
): TxRow[] {
  const invoiceRows: TxRow[] = invoices.map((inv) => ({
    voucherId: inv.voucherId,
    voucherNumber: inv.voucherNumber,
    date: inv.date,
    partyName: inv.partyName,
    amount: inv.totalAmount,
    outstanding: inv.outstanding,
    dueDate: inv.dueDate,
    daysPastDue: inv.daysPastDue,
    agingBucket: inv.agingBucket,
    txType: inv.type === "receivable" ? "Sales" : "Purchase",
  }));

  const prRows: TxRow[] = [];
  for (const v of vouchers) {
    if (v.voucherType !== "Payment" && v.voucherType !== "Receipt") continue;
    if (v.isCancelled || v.isOptional) continue;

    let partyName = v.partyName ?? "";
    let amount = v.totalAmount;
    if (!partyName && v.partyLedgerId) {
      partyName = ledgers.get(v.partyLedgerId)?.name ?? v.partyLedgerId;
    }
    if (!partyName) {
      for (const line of v.lines) {
        if (line.type === "ledger" && line.isPartyLine) {
          partyName = ledgers.get(line.ledgerId ?? "")?.name ?? line.ledgerId ?? "";
          amount = line.amount ?? 0;
          break;
        }
      }
    }
    if (!partyName) partyName = "—";

    prRows.push({
      voucherId: v.voucherId,
      voucherNumber: v.voucherNumber,
      date: v.date,
      partyName,
      amount,
      outstanding: null,
      dueDate: null,
      daysPastDue: 0,
      agingBucket: null,
      txType: v.voucherType as "Payment" | "Receipt",
    });
  }

  return [...invoiceRows, ...prRows];
}

function getInvoicePriceList(data: ParsedData, tallyEntries: Record<string, TallyPriceEntry>): Map<string, number> {
  const map = new Map<string, number>();
  const hasTally = Object.keys(tallyEntries).length > 0;

  const marginMap = hasTally ? null : (() => {
    const margins = computeItemMargins(data.items, data.vouchers);
    return new Map(margins.map((m) => [m.itemId, m]));
  })();

  for (const [itemId, item] of data.items) {
    if (hasTally) {
      const entry = tallyEntries[item.name.toUpperCase()];
      if (entry && entry.sellingRate > 0) { map.set(itemId, entry.sellingRate); continue; }
    }
    const m = marginMap?.get(itemId);
    const rate = m && m.avgSalesRate > 0
      ? m.avgSalesRate
      : (item.closingRate ?? item.openingRate ?? 0);
    if (rate > 0) map.set(itemId, rate);
  }
  return map;
}

export default function Invoices() {
  const navigate = useNavigate();
  const data = useDataStore((s) => s.data);
  const { isMobile } = useUIStore();
  const { entries: tallyEntries } = useTallyPriceListStore();

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<FilterType>("All");
  const [selectedRow, setSelectedRow] = useState<TxRow | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const invoices = useMemo(() => {
    if (!data) return [];
    return computeOutstandingInvoices(data.vouchers, data.ledgers, 30);
  }, [data]);

  const rows = useMemo(() => {
    if (!data) return [];
    return buildTxRows(invoices, data.vouchers, data.ledgers);
  }, [invoices, data]);

  const filtered = useMemo(() => {
    return rows
      .filter((row) => {
        if (typeFilter === "Sales" && row.txType !== "Sales") return false;
        if (typeFilter === "Purchase" && row.txType !== "Purchase") return false;
        if (typeFilter === "Receipt" && row.txType !== "Receipt") return false;
        if (typeFilter === "Payment" && row.txType !== "Payment") return false;
        if (dateFrom && row.date < dateFrom) return false;
        if (dateTo && row.date > dateTo) return false;
        if (search) {
          const q = search.toLowerCase();
          if (!row.partyName.toLowerCase().includes(q) && !row.voucherNumber.toLowerCase().includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [rows, typeFilter, dateFrom, dateTo, search]);

  const totals = useMemo(() => {
    let ar = 0, ap = 0, receipts = 0, payments = 0;
    for (const r of rows) {
      if (r.txType === "Sales") ar += r.outstanding ?? r.amount;
      else if (r.txType === "Purchase") ap += r.outstanding ?? r.amount;
      else if (r.txType === "Receipt") receipts += r.amount;
      else if (r.txType === "Payment") payments += r.amount;
    }
    return { ar, ap, receipts, payments };
  }, [rows]);

  const priceList = useMemo(
    () => data ? getInvoicePriceList(data, tallyEntries) : new Map<string, number>(),
    [data, tallyEntries]
  );

  // Look up full voucher for the selected row
  const selectedVoucher = useMemo(() => {
    if (!selectedRow || !data) return null;
    return data.vouchers.find((v) => v.voucherId === selectedRow.voucherId) ?? null;
  }, [selectedRow, data]);

  // Close modal on Escape
  useEffect(() => {
    if (!selectedRow) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setSelectedRow(null); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedRow]);

  if (!data) {
    return (
      <div className="empty-state">
        <FileText size={64} className="empty-state-icon" />
        <h2 className="empty-state-title">No Data Loaded</h2>
        <button onClick={() => navigate("/import")} className="btn-primary mt-2">
          <Upload size={16} />Import Data
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="page-section">
        <div className="page-header">
          <h1 className="page-title">Invoices</h1>
        </div>

        {/* Summary */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
          <div className="bento-card">
            <div className="metric-label">Outstanding AR</div>
            <div className="metric-value text-success truncate">{fmtINR(totals.ar)}</div>
          </div>
          <div className="bento-card">
            <div className="metric-label">Outstanding AP</div>
            <div className="metric-value text-danger truncate">{fmtINR(totals.ap)}</div>
          </div>
          <div className="bento-card">
            <div className="metric-label">Receipts</div>
            <div className="metric-value text-primary truncate">{fmtINR(totals.receipts)}</div>
          </div>
          <div className="bento-card">
            <div className="metric-label">Payments</div>
            <div className="metric-value text-warn truncate">{fmtINR(totals.payments)}</div>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-2 md:gap-3 bento-card">
          <div className="flex-1 min-w-[140px] md:min-w-[200px]">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search party / voucher#"
              className="search-input w-full" />
          </div>
          <div className="flex flex-wrap gap-1">
            {(["All", "Sales", "Purchase", "Receipt", "Payment"] as FilterType[]).map((t) => (
              <button key={t} onClick={() => setTypeFilter(t)}
                className={clsx("filter-chip", typeFilter === t && "filter-chip-active")}>
                {t}
              </button>
            ))}
          </div>
          <div className="hidden md:flex items-center gap-1.5">
            <label className="form-label">From</label>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="form-input" />
          </div>
          <div className="hidden md:flex items-center gap-1.5">
            <label className="form-label">To</label>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="form-input" />
          </div>
          <div className="text-xs text-muted self-center ml-auto">{filtered.length} rows</div>
        </div>

        {/* Table / Cards */}
        {isMobile ? (
          <MobileCards filtered={filtered} onSelect={setSelectedRow} />
        ) : (
          <TxTable filtered={filtered} onSelect={setSelectedRow} />
        )}
      </div>

      {/* Modal */}
      {selectedRow && selectedVoucher && (
        <VoucherModal
          row={selectedRow}
          voucher={selectedVoucher}
          data={data}
          priceList={priceList}
          onClose={() => setSelectedRow(null)}
        />
      )}
    </>
  );
}

/* ─── Type badge ──────────────────────────────────────── */
function typeBadge(txType: TxRow["txType"]) {
  switch (txType) {
    case "Sales":    return <span className="badge badge-success">Sales</span>;
    case "Purchase": return <span className="badge badge-danger">Purchase</span>;
    case "Receipt":  return <span className="badge badge-info">Receipt</span>;
    case "Payment":  return <span className="badge badge-warn">Payment</span>;
  }
}

/* ─── Modal popup ─────────────────────────────────────── */
function VoucherModal({ row, voucher, data, priceList, onClose }: {
  row: TxRow;
  voucher: CanonicalVoucher;
  data: ParsedData;
  priceList: Map<string, number>;
  onClose: () => void;
}) {
  const { inv, led, isSales, totalBilled, totalList, allPricesMatch } = useMemo(() => {
    const inv = voucher.lines.filter((l) => l.type === "inventory");
    const led = voucher.lines.filter((l) => l.type === "ledger");
    const isSales = row.txType === "Sales";
    const totalBilled = inv.reduce((s, l) => s + (l.lineAmount ?? 0), 0);
    const totalList = isSales ? inv.reduce((s, l) => {
      const refRate = l.itemId ? (priceList.get(l.itemId) ?? 0) : 0;
      return s + (l.qtyBase ?? 0) * refRate;
    }, 0) : 0;
    const allPricesMatch = isSales && inv.every((l) => {
      const ref = l.itemId ? (priceList.get(l.itemId) ?? 0) : 0;
      return priceMatches(l.ratePerBase ?? 0, ref);
    });
    return { inv, led, isSales, totalBilled, totalList, allPricesMatch };
  }, [voucher, priceList, row.txType]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={`${row.txType} Voucher ${row.voucherNumber}`}
      onClick={onClose}
    >
      <div
        className="relative bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden animate-modal-pop"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b border-neutral-200 bg-gradient-to-r from-neutral-50 to-white">
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-3 flex-wrap mb-2">
              <h2 className="text-lg font-bold text-neutral-950">
                {row.partyName}
              </h2>
              <span className="text-xs font-mono text-neutral-500 bg-neutral-100 px-2.5 py-1 rounded-md">
                {row.voucherNumber}
              </span>
              {typeBadge(row.txType)}
            </div>
            <div className="text-sm text-neutral-600">
              <span className="font-medium">{fmtDate(row.date)}</span>
              {voucher.narration && (
                <>
                  <span className="mx-2 text-neutral-300">·</span>
                  <span className="italic text-neutral-500">{voucher.narration}</span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3 ml-6 flex-shrink-0">
            {isSales && inv.length > 0 && (
              allPricesMatch ? (
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 text-xs font-semibold border border-blue-200">
                  <CheckCircle2 size={14} className="flex-shrink-0" />
                  <span>Prices Verified</span>
                </div>
              ) : (
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-50 text-amber-700 text-xs font-semibold border border-amber-200">
                  <XCircle size={14} className="flex-shrink-0" />
                  <span>Price Mismatch</span>
                </div>
              )
            )}
            <button onClick={onClose} className="btn-icon flex-shrink-0" aria-label="Close voucher">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-6">

          {/* Sales: full price verification table */}
          {isSales && inv.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-neutral-900 mb-4 flex items-center gap-2">
                <FileText size={16} className="text-neutral-500 flex-shrink-0" />
                Invoice Items — Price Verification
              </h3>
              <div className="overflow-x-auto border border-neutral-200 rounded-xl">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="bg-neutral-50 border-b border-neutral-200">
                      <th className="px-4 py-3 text-left font-semibold text-neutral-700 text-xs uppercase tracking-wide">Item Name</th>
                      <th className="px-4 py-3 text-right font-semibold text-neutral-700 text-xs uppercase tracking-wide whitespace-nowrap w-20">Qty</th>
                      <th className="px-4 py-3 text-right font-semibold text-neutral-700 text-xs uppercase tracking-wide whitespace-nowrap">Rate</th>
                      <th className="px-4 py-3 text-right font-semibold text-neutral-700 text-xs uppercase tracking-wide whitespace-nowrap">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inv.map((line, i) => {
                      const item = line.itemId ? data.items.get(line.itemId) : null;
                      const name = item?.name ?? line.itemId ?? "Unknown";
                      const qty = line.qtyBase ?? 0;
                      const rate = line.ratePerBase ?? 0;
                      const amt = line.lineAmount ?? qty * rate;
                      const refRate = line.itemId ? (priceList.get(line.itemId) ?? 0) : 0;
                      const refAmt = qty * refRate;
                      return (
                        <tr key={i} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50/50 transition-colors duration-75">
                          <td className="px-4 py-3 text-neutral-900 font-medium max-w-xs">
                            <span title={name} className="block truncate">{name}</span>
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-neutral-700 whitespace-nowrap">
                            {qty} {item?.baseUnit ? <span className="text-2xs text-neutral-500">{item.baseUnit}</span> : ""}
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            <RatePill rate={rate} refRate={refRate} />
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            <AmountPill billedAmt={amt} listAmt={refAmt} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-neutral-50 border-t border-neutral-200 font-semibold">
                      <td colSpan={3} className="px-4 py-3 text-right text-neutral-900 text-lg">Total Amount</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <AmountPill billedAmt={totalBilled} listAmt={totalList} isTotal={true} />
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {/* Non-Sales: simple items list */}
          {!isSales && inv.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-neutral-900 mb-4 flex items-center gap-2">
                <FileText size={16} className="text-neutral-500 flex-shrink-0" />
                Items
              </h3>
              <div className="overflow-x-auto border border-neutral-200 rounded-xl">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="bg-neutral-50 border-b border-neutral-200">
                      <th className="px-4 py-3 text-left font-semibold text-neutral-700 text-xs uppercase tracking-wide">Item Name</th>
                      <th className="px-4 py-3 text-right font-semibold text-neutral-700 text-xs uppercase tracking-wide whitespace-nowrap w-20">Qty</th>
                      <th className="px-4 py-3 text-right font-semibold text-neutral-700 text-xs uppercase tracking-wide whitespace-nowrap">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inv.map((line, i) => {
                      const item = line.itemId ? data.items.get(line.itemId) : null;
                      const name = item?.name ?? line.itemId ?? "Unknown";
                      const qty = line.qtyBase ?? 0;
                      const amt = line.lineAmount ?? 0;
                      return (
                        <tr key={i} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50/50 transition-colors duration-75">
                          <td className="px-4 py-3 text-neutral-900 font-medium max-w-xs">
                            <span title={name} className="block truncate">{name}</span>
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-neutral-700 whitespace-nowrap">
                            {qty} {item?.baseUnit ? <span className="text-2xs text-neutral-500">{item.baseUnit}</span> : ""}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-neutral-900 font-medium whitespace-nowrap">
                            {fmtINR(amt)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Ledger entries */}
          {led.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-neutral-900 mb-3">Ledger Entries</h3>
              <div className="space-y-2 bg-neutral-50 rounded-xl p-4 border border-neutral-200">
                {led.map((line, i) => {
                  const name = line.ledgerId
                    ? (data.ledgers.get(line.ledgerId)?.name ?? line.ledgerId) : "";
                  const bas = line.billAllocations ?? [];
                  return (
                    <div key={i}>
                      <div className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          <span className={clsx(
                            "text-xs font-semibold flex-shrink-0 px-2 py-0.5 rounded-md",
                            line.isDebit ? "bg-blue-100 text-blue-700" : "bg-orange-100 text-orange-700"
                          )}>
                            {line.isDebit ? "Dr" : "Cr"}
                          </span>
                          <span className="text-neutral-700 truncate">{name}</span>
                        </div>
                        <span className="text-neutral-900 font-semibold tabular-nums flex-shrink-0 ml-3">
                          {fmtINR(line.amount ?? 0)}
                        </span>
                      </div>
                      {bas.map((ba, j) => (
                        <div key={j} className="flex gap-4 pl-10 mt-1 text-xs text-neutral-500 tabular-nums">
                          <span className="truncate flex-1">{ba.billType}: {ba.billRef}</span>
                          <span className="flex-shrink-0">{fmtINR(ba.amount)}</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Outstanding info (Sales/Purchase only) */}
          {row.outstanding !== null && row.outstanding > 0.01 && (
            <div className="flex items-center justify-between p-4 bg-amber-50 rounded-xl border border-amber-200">
              <span className="text-sm font-semibold text-amber-800">Outstanding Amount</span>
              <span className="text-base font-bold tabular-nums text-amber-700">{fmtINR(row.outstanding)}</span>
            </div>
          )}
          {row.outstanding !== null && row.outstanding <= 0.01 && (
            <div className="flex items-center justify-between p-4 bg-green-50 rounded-xl border border-green-200">
              <span className="text-sm font-semibold text-green-800">Payment Status</span>
              <span className="text-base font-bold text-green-700">Fully Paid</span>
            </div>
          )}

          {!inv.length && !led.length && (
            <div className="text-center py-8">
              <FileText size={32} className="text-neutral-300 mx-auto mb-3" />
              <p className="text-neutral-500 text-sm">No line details available.</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-neutral-200 bg-neutral-50 flex items-center justify-between">
          <div className="text-xs text-neutral-600">
            {inv.length > 0 && <>{inv.length} item{inv.length !== 1 ? "s" : ""}</>}
            {inv.length > 0 && led.length > 0 && " · "}
            {led.length > 0 && <>{led.length} ledger entr{led.length !== 1 ? "ies" : "y"}</>}
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-neutral-200 hover:bg-neutral-300 active:bg-neutral-400 text-neutral-900 font-medium text-sm transition-colors duration-150 cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Desktop table ───────────────────────────────────── */
function TxTable({ filtered, onSelect }: {
  filtered: TxRow[];
  onSelect: (row: TxRow) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const COL_TEMPLATE = "100px 130px 90px 1fr 120px 100px";

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 10,
  });

  return (
    <div className="section-card overflow-hidden">
      <div className="table-scroll" style={{ minWidth: "720px" }}>
        <div className="grid table-header" style={{ gridTemplateColumns: COL_TEMPLATE }}>
          {["Date", "Voucher#", "Type", "Party", "Amount", "Outstanding"].map((h) => (
            <div key={h} className="px-4 py-3">{h}</div>
          ))}
        </div>

        <div ref={parentRef} className="overflow-auto max-h-[60vh]" style={{ minWidth: "720px" }}>
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = filtered[virtualRow.index];
              if (!row) return null;
              return (
                <div
                  key={row.voucherId}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)`, gridTemplateColumns: COL_TEMPLATE }}
                  className="grid responsive-table-row cursor-pointer hover:bg-neutral-50 bg-bg-card"
                  onClick={() => onSelect(row)}
                >
                  <div className="table-cell text-muted whitespace-nowrap">{fmtDate(row.date)}</div>
                  <div className="table-cell-mono truncate">{row.voucherNumber}</div>
                  <div className="table-cell">{typeBadge(row.txType)}</div>
                  <div className="table-cell-emphasis truncate">{row.partyName}</div>
                  <div className="table-cell-mono whitespace-nowrap">{fmtINR(row.amount)}</div>
                  <div className="table-cell-mono whitespace-nowrap">
                    {row.outstanding !== null ? (
                      row.outstanding > 0.01
                        ? <span className="text-danger">{fmtINR(row.outstanding)}</span>
                        : <span className="text-success text-xs">Paid</span>
                    ) : (
                      <span className="text-muted text-xs">—</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {filtered.length === 0 && (
          <div className="empty-state"><span className="empty-state-description">No records found</span></div>
        )}
      </div>
    </div>
  );
}

/* ─── Mobile cards ────────────────────────────────────── */
function MobileCards({ filtered, onSelect }: {
  filtered: TxRow[];
  onSelect: (row: TxRow) => void;
}) {
  return (
    <div className="space-y-2">
      {filtered.length === 0 && (
        <div className="bento-card empty-state">
          <span className="empty-state-description">No records found</span>
        </div>
      )}
      {filtered.slice(0, 100).map((row) => (
        <div
          key={row.voucherId}
          className="bento-card overflow-hidden p-3 cursor-pointer active:bg-bg-border/20"
          onClick={() => onSelect(row)}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium text-primary truncate mr-2">{row.partyName}</span>
            {typeBadge(row.txType)}
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted">{fmtDate(row.date)} · {row.voucherNumber}</span>
            <span className="font-sans tabular-nums font-semibold text-primary">{fmtINR(row.amount)}</span>
          </div>
          {row.outstanding !== null && row.outstanding > 0.01 && (
            <div className="flex items-center justify-between mt-1 text-xs">
              <span className="text-muted">Outstanding</span>
              <span className="text-danger font-medium tabular-nums">{fmtINR(row.outstanding)}</span>
            </div>
          )}
        </div>
      ))}
      {filtered.length > 100 && (
        <div className="caption-text text-center py-2">Showing first 100 of {filtered.length} rows</div>
      )}
    </div>
  );
}
