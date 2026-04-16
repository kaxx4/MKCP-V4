import { useState, useMemo, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronUp, Upload, FileText } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { useDataStore } from "../store/dataStore";
import { useUIStore } from "../store/uiStore";
import { computeOutstandingInvoices, type InvoiceRecord } from "../engine/financial";
import { fmtINR, fmtDate } from "../utils/format";
import type { CanonicalVoucher, ParsedData } from "../types/canonical";

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
  // Invoice rows
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

  // Payment / Receipt rows
  const prRows: TxRow[] = [];
  for (const v of vouchers) {
    if (v.voucherType !== "Payment" && v.voucherType !== "Receipt") continue;
    if (v.isCancelled || v.isOptional) continue;

    // Find party line — use partyLedgerId first, fall back to largest amount line
    let partyName = v.partyName ?? "";
    let amount = v.totalAmount;
    if (!partyName && v.partyLedgerId) {
      partyName = ledgers.get(v.partyLedgerId)?.name ?? v.partyLedgerId;
    }
    if (!partyName) {
      // Last resort: first non-bank ledger line
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

export default function Invoices() {
  const navigate = useNavigate();
  const { data } = useDataStore();
  const { isMobile } = useUIStore();

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<FilterType>("All");
  const [expandedId, setExpandedId] = useState<string | null>(null);
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

  // Totals derived from unfiltered rows — only recompute when rows change
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
    <div className="page-section">
      <div className="page-header">
        <h1 className="page-title">Invoices</h1>
      </div>

      {/* Summary — bento grid */}
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

      {/* Table (desktop) / Cards (mobile) */}
      {isMobile ? (
        <MobileCards filtered={filtered} expandedId={expandedId} setExpandedId={setExpandedId} data={data} />
      ) : (
        <TxTable filtered={filtered} expandedId={expandedId} setExpandedId={setExpandedId} data={data} />
      )}
    </div>
  );
}

function typeBadge(txType: TxRow["txType"]) {
  switch (txType) {
    case "Sales":    return <span className="badge badge-success">Sales</span>;
    case "Purchase": return <span className="badge badge-danger">Purchase</span>;
    case "Receipt":  return <span className="badge badge-info">Receipt</span>;
    case "Payment":  return <span className="badge badge-warn">Payment</span>;
  }
}

/** Expanded voucher detail */
function VoucherDetail({ voucher, data }: { voucher: CanonicalVoucher; data: ParsedData }) {
  const invLines = voucher.lines.filter(l => l.type === "inventory");
  const ledgerLines = voucher.lines.filter(l => l.type === "ledger");

  return (
    <div className="text-xs space-y-1">
      {invLines.length > 0 && (
        <>
          <div className="text-muted font-medium mb-1">Items</div>
          {invLines.map((line, i) => {
            const item = line.itemId ? data.items.get(line.itemId) : null;
            const name = item?.name ?? line.itemId ?? "Unknown";
            return (
              <div key={i} className="flex items-center gap-2 tabular-nums text-primary">
                <span className="truncate flex-1" title={name}>{name}</span>
                <span className="text-muted flex-shrink-0">{line.qtyBase ?? 0} {item?.baseUnit ?? ""}</span>
                <span className="flex-shrink-0">{fmtINR(line.lineAmount ?? 0)}</span>
              </div>
            );
          })}
        </>
      )}
      {ledgerLines.length > 0 && (
        <>
          <div className="text-muted font-medium mt-2 mb-1">Ledgers</div>
          {ledgerLines.map((line, i) => {
            const ledgerName = line.ledgerId ? (data.ledgers.get(line.ledgerId)?.name ?? line.ledgerId) : "";
            const bas = line.billAllocations ?? [];
            return (
              <div key={i}>
                <div className="flex gap-4 tabular-nums text-primary">
                  <span className="text-muted w-6">{line.isDebit ? "Dr" : "Cr"}</span>
                  <span className="truncate flex-1">{ledgerName}</span>
                  <span>{fmtINR(line.amount ?? 0)}</span>
                </div>
                {bas.map((ba, j) => (
                  <div key={j} className="flex gap-4 pl-6 text-muted tabular-nums">
                    <span className="truncate flex-1">{ba.billType}: {ba.billRef}</span>
                    <span>{fmtINR(ba.amount)}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function TxTable({ filtered, expandedId, setExpandedId, data }: {
  filtered: TxRow[];
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
  data: ParsedData;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const COL_TEMPLATE = "100px 130px 90px 1fr 120px 100px 44px";

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (expandedId === filtered[i]?.voucherId ? 240 : 48),
    overscan: 10,
  });

  useEffect(() => { virtualizer.measure(); }, [expandedId, virtualizer]);

  return (
    <div className="section-card overflow-hidden">
      <div className="table-scroll" style={{ minWidth: "780px" }}>
        <div className="grid table-header" style={{ gridTemplateColumns: COL_TEMPLATE }}>
          {["Date", "Voucher#", "Type", "Party", "Amount", "Outstanding", ""].map((h) => (
            <div key={h} className="px-4 py-3">{h}</div>
          ))}
        </div>

        <div ref={parentRef} className="overflow-auto max-h-[60vh]" style={{ minWidth: "780px" }}>
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = filtered[virtualRow.index];
              if (!row) return null;
              const isExpanded = expandedId === row.voucherId;
              const voucher = isExpanded ? data.vouchers.find(v => v.voucherId === row.voucherId) : null;

              return (
                <div
                  key={row.voucherId}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)`, zIndex: isExpanded ? 10 : 1 }}
                  className="bg-bg-card"
                >
                  <div className="grid responsive-table-row cursor-pointer" style={{ gridTemplateColumns: COL_TEMPLATE }}
                    onClick={() => setExpandedId(isExpanded ? null : row.voucherId)}>
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
                    <div className="table-cell text-muted">
                      {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </div>
                  </div>

                  {isExpanded && voucher && (
                    <div className="bg-bg border-b border-bg-border px-6 py-4">
                      <VoucherDetail voucher={voucher} data={data} />
                    </div>
                  )}
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

function MobileCards({ filtered, expandedId, setExpandedId, data }: {
  filtered: TxRow[];
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
  data: ParsedData;
}) {
  return (
    <div className="space-y-2">
      {filtered.length === 0 && (
        <div className="bento-card empty-state">
          <span className="empty-state-description">No records found</span>
        </div>
      )}
      {filtered.slice(0, 100).map((row) => {
        const isExpanded = expandedId === row.voucherId;
        const voucher = isExpanded ? data.vouchers.find(v => v.voucherId === row.voucherId) : null;
        return (
          <div key={row.voucherId} className="bento-card overflow-hidden !p-0">
            <div className="p-3 cursor-pointer active:bg-bg-border/20"
              onClick={() => setExpandedId(isExpanded ? null : row.voucherId)}>
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
            {isExpanded && voucher && (
              <div className="border-t border-bg-border bg-bg px-3 py-2">
                <VoucherDetail voucher={voucher} data={data} />
              </div>
            )}
          </div>
        );
      })}
      {filtered.length > 100 && (
        <div className="caption-text text-center py-2">Showing first 100 of {filtered.length} rows</div>
      )}
    </div>
  );
}
