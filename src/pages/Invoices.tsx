import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Search, ChevronDown, ChevronUp, Download, Upload, FileText } from "lucide-react";
import clsx from "clsx";
import { useDataStore } from "../store/dataStore";
import { computeOutstandingInvoices, type InvoiceRecord } from "../engine/financial";
import { fmtINR, fmtDate } from "../utils/format";

type FilterType = "All" | "Sales" | "Purchase";

export default function Invoices() {
  const navigate = useNavigate();
  const { data } = useDataStore();

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

  function exportCSV() {
    const rows = [
      ["Date", "Voucher#", "Type", "Party", "Amount", "Paid", "Outstanding", "Due Date", "Days Overdue"],
      ...filtered.map((i) => [
        i.date, i.voucherNumber, i.type === "receivable" ? "Sales" : "Purchase",
        i.partyName, i.totalAmount, i.paidAmount, i.outstanding, i.dueDate ?? "", i.daysPastDue
      ]),
    ];
    const csv = rows.map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `invoices_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-4">
        <FileText size={64} className="text-muted" />
        <h2 className="text-xl font-semibold text-primary">No Data Loaded</h2>
        <button onClick={() => navigate("/import")} className="flex items-center gap-2 bg-accent hover:bg-accent-hover text-white font-semibold px-5 py-2.5 rounded-lg transition mt-2">
          <Upload size={16} />Import Data
        </button>
      </div>
    );
  }

  const totalAR = filtered.filter((i) => i.type === "receivable").reduce((s, i) => s + i.outstanding, 0);
  const totalAP = filtered.filter((i) => i.type === "payable").reduce((s, i) => s + i.outstanding, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-primary">Invoices</h1>
        <button onClick={exportCSV} className="flex items-center gap-2 bg-bg-card border border-bg-border hover:border-accent/50 text-muted hover:text-primary px-4 py-2 rounded-lg transition text-sm">
          <Download size={14} />Export CSV
        </button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-bg-card border border-bg-border rounded-xl p-4">
          <div className="text-muted text-xs">Total Outstanding AR</div>
          <div className="text-success text-xl font-mono font-bold mt-1">{fmtINR(totalAR)}</div>
        </div>
        <div className="bg-bg-card border border-bg-border rounded-xl p-4">
          <div className="text-muted text-xs">Total Outstanding AP</div>
          <div className="text-danger text-xl font-mono font-bold mt-1">{fmtINR(totalAP)}</div>
        </div>
        <div className="bg-bg-card border border-bg-border rounded-xl p-4">
          <div className="text-muted text-xs">Invoices Shown</div>
          <div className="text-primary text-xl font-mono font-bold mt-1">{filtered.length}</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 bg-bg-card border border-bg-border rounded-xl p-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search party / voucher#"
            className="w-full bg-bg border border-bg-border rounded-lg pl-8 pr-3 py-1.5 text-sm text-primary placeholder-muted outline-none" />
        </div>
        <div className="flex gap-1">
          {(["All", "Sales", "Purchase"] as FilterType[]).map((t) => (
            <button key={t} onClick={() => setTypeFilter(t)}
              className={clsx("px-3 py-1.5 rounded-lg text-sm transition", typeFilter === t ? "bg-accent text-white" : "bg-bg border border-bg-border text-muted hover:text-primary")}>
              {t}
            </button>
          ))}
        </div>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
          className="bg-bg border border-bg-border rounded-lg px-3 py-1.5 text-sm text-primary outline-none" />
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
          className="bg-bg border border-bg-border rounded-lg px-3 py-1.5 text-sm text-primary outline-none" />
      </div>

      {/* Table */}
      <div className="bg-bg-card border border-bg-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-bg-border">
              <tr>
                {["Date", "Voucher#", "Type", "Party", "Amount", "Paid", "Outstanding", "Due Date", "Status"].map((h) => (
                  <th key={h} className="text-left text-muted px-4 py-3 font-medium text-xs">{h}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => {
                const isExpanded = expandedId === inv.voucherId;
                const voucher = data.vouchers.find((v) => v.voucherId === inv.voucherId);
                return (
                  <>
                    <tr key={inv.voucherId}
                      className="border-b border-bg-border/50 hover:bg-bg-border/20 cursor-pointer"
                      onClick={() => setExpandedId(isExpanded ? null : inv.voucherId)}>
                      <td className="px-4 py-3 text-muted">{fmtDate(inv.date)}</td>
                      <td className="px-4 py-3 font-mono text-primary">{inv.voucherNumber}</td>
                      <td className="px-4 py-3">
                        <span className={clsx("text-xs px-2 py-0.5 rounded-full", inv.type === "receivable" ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>
                          {inv.type === "receivable" ? "Sales" : "Purchase"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-primary max-w-[200px] truncate">{inv.partyName}</td>
                      <td className="px-4 py-3 font-mono text-primary">{fmtINR(inv.totalAmount)}</td>
                      <td className="px-4 py-3 font-mono text-success">{fmtINR(inv.paidAmount)}</td>
                      <td className="px-4 py-3 font-mono font-semibold text-primary">{fmtINR(inv.outstanding)}</td>
                      <td className="px-4 py-3 text-muted text-xs">{inv.dueDate ? fmtDate(inv.dueDate) : "-"}</td>
                      <td className="px-4 py-3">
                        <span className={clsx("text-xs px-2 py-0.5 rounded-full", agingColor(inv))}>
                          {inv.agingBucket === "current" ? "Current" : `${inv.daysPastDue}d overdue`}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted">
                        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </td>
                    </tr>
                    {isExpanded && voucher && (
                      <tr key={`${inv.voucherId}-detail`} className="bg-bg border-b border-bg-border">
                        <td colSpan={10} className="px-6 py-4">
                          <div className="text-xs space-y-2">
                            <div className="text-muted font-medium mb-2">Voucher Lines</div>
                            {voucher.lines.map((line, i) => (
                              <div key={i} className="flex gap-4 font-mono text-primary">
                                {line.type === "ledger" ? (
                                  <>
                                    <span className="text-muted w-16">{line.isDebit ? "Dr" : "Cr"}</span>
                                    <span>{line.ledgerId}</span>
                                    <span className="ml-auto">{fmtINR(line.amount ?? 0)}</span>
                                  </>
                                ) : (
                                  <>
                                    <span className="text-muted w-16">Inv</span>
                                    <span>{line.itemId}</span>
                                    <span className="text-muted">{line.qtyBase} {" × "} {fmtINR(line.ratePerBase ?? 0)}</span>
                                    <span className="ml-auto">{fmtINR(line.lineAmount ?? 0)}</span>
                                  </>
                                )}
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="text-center py-12 text-muted text-sm">No outstanding invoices found</div>
          )}
        </div>
      </div>
    </div>
  );
}
