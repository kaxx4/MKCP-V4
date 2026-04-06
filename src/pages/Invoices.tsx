import { useState, useMemo, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronUp, Download, Upload, FileText, FileDown } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { useDataStore } from "../store/dataStore";
import { useUIStore } from "../store/uiStore";
import { useDiscountStore } from "../store/discountStore";
import { computeOutstandingInvoices, type InvoiceRecord } from "../engine/financial";
import { fmtINR, fmtDate } from "../utils/format";

type FilterType = "All" | "Sales" | "Purchase";

export default function Invoices() {
  const navigate = useNavigate();
  const { data } = useDataStore();
  const { isMobile } = useUIStore();

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<FilterType>("All");
  const [showPaid, setShowPaid] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const invoices = useMemo(() => {
    if (!data) return [];
    return computeOutstandingInvoices(data.vouchers, data.ledgers, 30);
  }, [data]);

  const filtered = useMemo(() => {
    return invoices
      .filter((inv) => {
        if (typeFilter === "Sales" && inv.type !== "receivable") return false;
        if (typeFilter === "Purchase" && inv.type !== "payable") return false;
        if (dateFrom && inv.date < dateFrom) return false;
        if (dateTo && inv.date > dateTo) return false;
        if (search && !inv.partyName.toLowerCase().includes(search.toLowerCase()) &&
            !inv.voucherNumber.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [invoices, typeFilter, dateFrom, dateTo, search]);

  function agingColor(inv: InvoiceRecord) {
    if (inv.agingBucket === "current") return "text-success bg-success/10";
    if (inv.agingBucket === "1-30") return "text-warn bg-warn/10";
    return "text-danger bg-danger/10";
  }

  function exportPurchasePDFs() {
    // TODO: Implement purchase PDF export when purchasePDFExporter is available
  }

  function exportCSV() {
    function escCSV(v: string | number): string {
      const s = String(v);
      return (s.includes(",") || s.includes('"') || s.includes("\n"))
        ? `"${s.replace(/"/g, '""')}"` : s;
    }

    const header = ["Date", "Voucher#", "Type", "Party", "Amount", "Paid", "Outstanding", "Due Date", "Days Overdue", "Items"];

    const rows = filtered.map((inv) => {
      const voucher = data!.vouchers.find(v => v.voucherId === inv.voucherId);
      const invLines = voucher?.lines.filter(l => l.type === "inventory") ?? [];
      const itemsStr = invLines.map(line => {
        const item = line.itemId ? data!.items.get(line.itemId) : null;
        const name = item?.name ?? line.itemId ?? "Unknown";
        const unit = item?.baseUnit ?? "";
        const qty = line.qtyBase ?? 0;
        const rate = line.ratePerBase ?? 0;
        const amount = line.lineAmount ?? qty * rate;
        return `${name} (${qty} ${unit} @ ${rate.toFixed(2)}) = ${amount.toFixed(2)}`;
      }).join("; ");

      return [
        inv.date, inv.voucherNumber, inv.type === "receivable" ? "Sales" : "Purchase",
        inv.partyName, inv.totalAmount, inv.paidAmount, inv.outstanding, inv.dueDate ?? "", inv.daysPastDue,
        itemsStr,
      ].map(escCSV).join(",");
    });

    const csv = [header.map(escCSV).join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `invoices_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

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

  const totalAR = filtered.filter((i) => i.type === "receivable").reduce((s, i) => s + i.outstanding, 0);
  const totalAP = filtered.filter((i) => i.type === "payable").reduce((s, i) => s + i.outstanding, 0);

  return (
    <div className="page-section">
      <div className="page-header">
        <h1 className="page-title">Invoices</h1>
        <div className="flex gap-2">
          {typeFilter !== "Sales" && (
            <button onClick={exportPurchasePDFs} className="btn-secondary btn-sm">
              <FileDown size={14} />Export PDFs
            </button>
          )}
          <button onClick={exportCSV} className="btn-secondary btn-sm">
            <Download size={14} />Export CSV
          </button>
        </div>
      </div>

      {/* Summary — bento grid */}
      <div className="grid grid-cols-3 gap-2 md:gap-3">
        <div className="bento-card">
          <div className="metric-label">Outstanding AR</div>
          <div className="metric-value text-success truncate">{fmtINR(totalAR)}</div>
        </div>
        <div className="bento-card">
          <div className="metric-label">Outstanding AP</div>
          <div className="metric-value text-danger truncate">{fmtINR(totalAP)}</div>
        </div>
        <div className="bento-card">
          <div className="metric-label">Invoices</div>
          <div className="metric-value text-primary">{filtered.length}</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 md:gap-3 bento-card">
        <div className="flex-1 min-w-[140px] md:min-w-[200px]">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search party / voucher#"
            className="search-input w-full" />
        </div>
        <div className="flex gap-1">
          {(["All", "Sales", "Purchase"] as FilterType[]).map((t) => (
            <button key={t} onClick={() => setTypeFilter(t)}
              className={clsx("px-2.5 md:px-3 py-1.5 rounded-lg text-xs md:text-sm transition", typeFilter === t ? "bg-accent text-white" : "bg-bg border border-bg-border text-muted hover:text-primary")}>
              {t}
            </button>
          ))}
        </div>
        <div className="hidden md:flex items-center gap-1.5">
          <label htmlFor="invoice-from" className="form-label">From</label>
          <input id="invoice-from" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
            className="form-input" />
        </div>
        <div className="hidden md:flex items-center gap-1.5">
          <label htmlFor="invoice-to" className="form-label">To</label>
          <input id="invoice-to" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
            className="form-input" />
        </div>
      </div>

      {/* Table (desktop) / Cards (mobile) */}
      {isMobile ? (
        <MobileInvoiceCards filtered={filtered} expandedId={expandedId} setExpandedId={setExpandedId} agingColor={agingColor} data={data} />
      ) : (
        <InvoiceTable filtered={filtered} expandedId={expandedId} setExpandedId={setExpandedId} agingColor={agingColor} data={data} />
      )}
    </div>
  );
}

/** Discount-aware expanded detail for a voucher */
function VoucherDetail({ voucher, data }: {
  voucher: import("../types/canonical").CanonicalVoucher;
  data: import("../types/canonical").ParsedData;
}) {
  const { getDiscount, itemAssignments } = useDiscountStore();

  const invLines = voucher.lines.filter(l => l.type === "inventory" && l.itemId);
  const ledgerLines = voucher.lines.filter(l => l.type === "ledger");

  let totalSubtotal = 0;
  let totalDiscount = 0;

  const invRows = invLines.map((line, i) => {
    const item = line.itemId ? data.items.get(line.itemId) : null;
    const name = item?.name ?? line.itemId ?? "";
    const qtyBase = line.qtyBase ?? 0;
    const unitsPerPkg = item?.unitsPerPkg ?? 1;
    const qtyPkg = unitsPerPkg > 0 ? qtyBase / unitsPerPkg : qtyBase;
    const qtyPkgRounded = Math.round(qtyPkg);
    const subtotal = line.lineAmount ?? (qtyBase * (line.ratePerBase ?? 0));
    const catName = line.itemId ? itemAssignments[line.itemId.toUpperCase()] : undefined;
    const discPct = line.itemId ? getDiscount(line.itemId, qtyPkgRounded) : 0;
    const discAmt = subtotal * (discPct / 100);
    const net = subtotal - discAmt;
    totalSubtotal += subtotal;
    totalDiscount += discAmt;
    return (
      <div key={i} className="flex gap-2 items-baseline text-xs tabular-nums">
        <span className="text-muted w-8 flex-shrink-0">Inv</span>
        <span className="truncate flex-1 min-w-0" title={name}>{name}</span>
        <span className="text-muted flex-shrink-0">{qtyPkgRounded} pkg</span>
        <span className="flex-shrink-0">{fmtINR(subtotal)}</span>
        {discPct > 0 ? (
          <>
            <span className="text-warn-700 flex-shrink-0">−{discPct}%</span>
            <span className="font-semibold text-success-700 flex-shrink-0">{fmtINR(net)}</span>
          </>
        ) : (
          <span className="text-muted flex-shrink-0 text-[10px]">{catName ? "0%" : "no cat."}</span>
        )}
      </div>
    );
  });

  return (
    <div className="text-xs space-y-1.5">
      {invRows}
      {invLines.length > 0 && totalDiscount > 0 && (
        <div className="flex justify-between pt-1 border-t border-neutral-200 font-medium">
          <span className="text-muted">Total discount</span>
          <span className="text-warn-700">−{fmtINR(totalDiscount)}</span>
          <span className="text-success-700">{fmtINR(totalSubtotal - totalDiscount)}</span>
        </div>
      )}
      {ledgerLines.map((line, i) => {
        const ledgerName = line.ledgerId ? (data.ledgers.get(line.ledgerId)?.name ?? line.ledgerId) : "";
        return (
          <div key={`l${i}`} className="flex gap-4 tabular-nums text-xs text-muted">
            <span className="w-8 flex-shrink-0">{line.isDebit ? "Dr" : "Cr"}</span>
            <span className="truncate flex-1" title={ledgerName}>{ledgerName}</span>
            <span className="ml-auto">{fmtINR(line.amount ?? 0)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Virtualized invoice table component */
function InvoiceTable({ filtered, expandedId, setExpandedId, agingColor, data }: {
  filtered: InvoiceRecord[];
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
  agingColor: (inv: InvoiceRecord) => string;
  data: import("../types/canonical").ParsedData;
}) {
  const parentRef = useRef<HTMLDivElement>(null);

  // Fixed column template for grid layout - ensures header and rows align
  const COL_TEMPLATE = "100px 120px 90px 1fr 120px 44px";

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (expandedId === filtered[i]?.voucherId ? 240 : 48),
    overscan: 10,
  });

  // Re-measure virtualizer when expanded row changes
  useEffect(() => {
    virtualizer.measure();
  }, [expandedId, virtualizer]);

  return (
    <div className="section-card overflow-hidden">
      <div className="table-scroll" style={{ minWidth: "700px" }}>
        {/* Header */}
        <div className="grid table-header"
             style={{ gridTemplateColumns: COL_TEMPLATE }}>
          {["Date", "Voucher#", "Type", "Party", "Amount", ""].map((h) => (
            <div key={h} className="px-4 py-3">{h}</div>
          ))}
        </div>

        {/* Virtualized rows */}
        <div ref={parentRef} className="overflow-auto max-h-[60vh]" style={{ minWidth: "700px" }}>
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const inv = filtered[virtualRow.index];
              if (!inv) return null;
              const isExpanded = expandedId === inv.voucherId;
              const voucher = isExpanded ? data.vouchers.find((v: import("../types/canonical").CanonicalVoucher) => v.voucherId === inv.voucherId) : null;

              return (
                <div
                  key={inv.voucherId}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                    zIndex: isExpanded ? 10 : 1,
                  }}
                  className="bg-bg-card"
                >
                  {/* Main row with grid layout */}
                  <div
                    className="grid responsive-table-row cursor-pointer"
                    style={{ gridTemplateColumns: COL_TEMPLATE }}
                    onClick={() => setExpandedId(isExpanded ? null : inv.voucherId)}
                  >
                    <div className="table-cell text-muted overflow-hidden whitespace-nowrap">{fmtDate(inv.date)}</div>
                    <div className="table-cell-mono overflow-hidden truncate">{inv.voucherNumber}</div>
                    <div className="table-cell overflow-hidden">
                      <span className={clsx("badge", inv.type === "receivable" ? "badge-success" : "badge-danger")}>
                        {inv.type === "receivable" ? "Sales" : "Purchase"}
                      </span>
                    </div>
                    <div className="table-cell-emphasis truncate overflow-hidden">{inv.partyName}</div>
                    <div className="table-cell-mono overflow-hidden whitespace-nowrap">{fmtINR(inv.totalAmount)}</div>
                    <div className="table-cell text-muted overflow-hidden">
                      {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </div>
                  </div>

                  {/* Expanded voucher detail */}
                  {isExpanded && voucher && (
                    <div className="bg-bg border-b border-bg-border px-6 py-4">
                      <p className="text-xs font-medium text-muted mb-2">Voucher Lines</p>
                      <VoucherDetail voucher={voucher} data={data} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {filtered.length === 0 && (
          <div className="empty-state"><span className="empty-state-description">No outstanding invoices found</span></div>
        )}
      </div>
    </div>
  );
}

/** Mobile-friendly stacked card view for invoices */
function MobileInvoiceCards({ filtered, expandedId, setExpandedId, agingColor, data }: {
  filtered: InvoiceRecord[];
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
  agingColor: (inv: InvoiceRecord) => string;
  data: import("../types/canonical").ParsedData;
}) {
  return (
    <div className="space-y-2">
      {filtered.length === 0 && (
        <div className="bento-card empty-state">
          <span className="empty-state-description">No outstanding invoices found</span>
        </div>
      )}
      {filtered.slice(0, 100).map((inv) => {
        const isExpanded = expandedId === inv.voucherId;
        const voucher = isExpanded ? data.vouchers.find((v: import("../types/canonical").CanonicalVoucher) => v.voucherId === inv.voucherId) : null;
        return (
          <div
            key={inv.voucherId}
            className="bento-card overflow-hidden !p-0"
          >
            <div
              className="p-3 cursor-pointer active:bg-bg-border/20"
              onClick={() => setExpandedId(isExpanded ? null : inv.voucherId)}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-primary truncate mr-2">{inv.partyName}</span>
                <span className={clsx("badge flex-shrink-0", inv.type === "receivable" ? "badge-success" : "badge-danger")}>
                  {inv.type === "receivable" ? "Sales" : "Purchase"}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted">{fmtDate(inv.date)} · {inv.voucherNumber}</span>
                <span className="font-sans tabular-nums font-semibold text-primary">{fmtINR(inv.totalAmount)}</span>
              </div>
              {inv.outstanding > 0 && (
                <div className="flex items-center justify-between mt-1 text-xs">
                  <span className={clsx("px-1.5 py-0.5 rounded", agingColor(inv))}>
                    {inv.daysPastDue > 0 ? `${inv.daysPastDue}d overdue` : "Current"}
                  </span>
                  <span className="text-muted">Due: <span className="font-sans tabular-nums font-medium text-primary">{fmtINR(inv.outstanding)}</span></span>
                </div>
              )}
            </div>

            {isExpanded && voucher && (
              <div className="border-t border-bg-border bg-bg px-3 py-2">
                <p className="text-[10px] text-muted font-medium mb-1.5">Voucher Lines</p>
                <VoucherDetail voucher={voucher} data={data} />
              </div>
            )}
          </div>
        );
      })}
      {filtered.length > 100 && (
        <div className="caption-text text-center py-2">
          Showing first 100 of {filtered.length} invoices
        </div>
      )}
    </div>
  );
}
