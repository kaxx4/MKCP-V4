import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Upload, BookOpen, ArrowLeft } from "lucide-react";
import clsx from "clsx";
import { useDataStore } from "../store/dataStore";
import { useUIStore } from "../store/uiStore";
import { fmtINR, fmtDate } from "../utils/format";
import type { CanonicalLedger } from "../types/canonical";

export default function Ledgers() {
  const navigate = useNavigate();
  const { data } = useDataStore();
  const { isMobile } = useUIStore();
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("ALL");
  const [selectedLedgerId, setSelectedLedgerId] = useState<string | null>(null);

  const allLedgers = useMemo(() => {
    if (!data) return [];
    return Array.from(data.ledgers.values());
  }, [data]);

  const groups = useMemo(() => {
    const gs = new Set(allLedgers.map((l) => l.group));
    return ["ALL", ...Array.from(gs).sort()];
  }, [allLedgers]);

  const filtered = useMemo(() => {
    return allLedgers.filter((l) => {
      if (groupFilter !== "ALL" && l.group !== groupFilter) return false;
      if (search && !l.name.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [allLedgers, search, groupFilter]);

  const selectedLedger = useMemo(
    () => (selectedLedgerId ? data?.ledgers.get(selectedLedgerId) ?? null : null),
    [selectedLedgerId, data]
  );

  const ledgerTransactions = useMemo(() => {
    if (!selectedLedger || !data) return [];
    const txns: Array<{ date: string; voucherNumber: string; type: string; debit: number; credit: number; running: number }> = [];
    let running = selectedLedger.openingBalance;
    const relevant = data.vouchers
      .filter((v) => !v.isCancelled && v.lines.some((l) => l.type === "ledger" && l.ledgerId === selectedLedger.ledgerId))
      .sort((a, b) => a.date.localeCompare(b.date));

    for (const v of relevant) {
      for (const line of v.lines) {
        if (line.type !== "ledger" || line.ledgerId !== selectedLedger.ledgerId) continue;
        const debit = line.isDebit ? (line.amount ?? 0) : 0;
        const credit = !line.isDebit ? (line.amount ?? 0) : 0;
        running += debit - credit;
        txns.push({ date: v.date, voucherNumber: v.voucherNumber, type: v.voucherType, debit, credit, running });
      }
    }
    return txns;
  }, [selectedLedger, data]);

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-4">
        <BookOpen size={64} className="text-muted" />
        <h2 className="text-xl font-semibold text-primary">No Data Loaded</h2>
        <button onClick={() => navigate("/import")} className="flex items-center gap-2 bg-accent hover:bg-accent-hover text-white font-semibold px-5 py-2.5 rounded-lg transition mt-2">
          <Upload size={16} />Import Data
        </button>
      </div>
    );
  }

  // ─── Mobile: Single panel with back navigation ─────────────────
  if (isMobile) {
    // Show detail view if a ledger is selected
    if (selectedLedger) {
      return (
        <div className="flex flex-col h-[calc(100vh-112px)]">
          {/* Header with back button */}
          <div className="bg-bg-card border border-bg-border rounded-t-xl p-3 border-b">
            <button
              onClick={() => setSelectedLedgerId(null)}
              className="flex items-center gap-1.5 text-xs text-accent mb-2"
            >
              <ArrowLeft size={14} />
              Back to list
            </button>
            <h2 className="text-sm font-bold text-primary">{selectedLedger.name}</h2>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-xs">
              <span className="text-muted">Group: <span className="text-primary">{selectedLedger.group}</span></span>
              <span className="text-muted">Opening: <span className={clsx("font-mono", selectedLedger.openingBalance >= 0 ? "text-success" : "text-danger")}>
                {fmtINR(Math.abs(selectedLedger.openingBalance))} {selectedLedger.openingBalance >= 0 ? "Dr" : "Cr"}
              </span></span>
              {selectedLedger.gstin && (
                <span className="text-muted">GSTIN: <span className="text-primary font-mono">{selectedLedger.gstin}</span></span>
              )}
            </div>
          </div>

          {/* Transaction cards */}
          <div className="flex-1 overflow-y-auto bg-bg-card border-x border-b border-bg-border rounded-b-xl">
            {/* Opening balance card */}
            <div className="px-3 py-2 border-b border-bg-border bg-bg-border/10 text-xs">
              <div className="flex justify-between">
                <span className="text-muted">Opening Balance</span>
                <span className={clsx("font-mono font-medium", selectedLedger.openingBalance >= 0 ? "text-success" : "text-danger")}>
                  {fmtINR(Math.abs(selectedLedger.openingBalance))} {selectedLedger.openingBalance >= 0 ? "Dr" : "Cr"}
                </span>
              </div>
            </div>
            {ledgerTransactions.length === 0 ? (
              <div className="text-center py-8 text-muted text-sm">No transactions</div>
            ) : (
              ledgerTransactions.map((tx, i) => (
                <div key={i} className="px-3 py-2 border-b border-bg-border/50 text-xs">
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-muted">{fmtDate(tx.date)} · {tx.type}</span>
                    <span className="font-mono text-primary">{tx.voucherNumber}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex gap-3">
                      {tx.debit > 0 && <span className="font-mono text-success">Dr {fmtINR(tx.debit)}</span>}
                      {tx.credit > 0 && <span className="font-mono text-danger">Cr {fmtINR(tx.credit)}</span>}
                    </div>
                    <span className={clsx("font-mono font-medium", tx.running >= 0 ? "text-success" : "text-danger")}>
                      {fmtINR(Math.abs(tx.running))} {tx.running >= 0 ? "Dr" : "Cr"}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      );
    }

    // Show list view
    return (
      <div className="flex flex-col h-[calc(100vh-112px)]">
        <div className="mb-2">
          <h1 className="text-lg font-bold text-primary">Ledgers</h1>
        </div>
        <div className="bg-bg-card border border-bg-border rounded-xl flex flex-col flex-1 overflow-hidden">
          <div className="p-3 border-b border-bg-border space-y-2">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search ledgers…"
                className="w-full bg-bg border border-bg-border rounded-lg pl-8 pr-3 py-1.5 text-sm text-primary placeholder-muted outline-none" />
            </div>
            <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}
              className="w-full bg-bg border border-bg-border rounded-lg px-2 py-1.5 text-sm text-primary outline-none">
              {groups.map((g) => <option key={g} value={g}>{g === "ALL" ? "All Groups" : g}</option>)}
            </select>
          </div>
          <div className="flex-1 overflow-y-auto">
            {filtered.map((ledger) => (
              <div key={ledger.ledgerId}
                onClick={() => setSelectedLedgerId(ledger.ledgerId)}
                className="px-3 py-2.5 cursor-pointer border-b border-bg-border/50 active:bg-bg-border/30">
                <div className="text-xs font-sans text-primary truncate">{ledger.name}</div>
                <div className="flex items-center justify-between mt-0.5">
                  <span className="text-muted text-xs truncate">{ledger.group}</span>
                  <span className={clsx("text-xs font-mono", ledger.openingBalance >= 0 ? "text-success" : "text-danger")}>
                    {fmtINR(Math.abs(ledger.openingBalance))} {ledger.openingBalance >= 0 ? "Dr" : "Cr"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ─── Desktop: Side-by-side layout ──────────────────────────────
  return (
    <div className="flex gap-4 h-[calc(100vh-112px)]">
      {/* Left: Ledger List */}
      <div className="w-80 flex flex-col bg-bg-card border border-bg-border rounded-xl overflow-hidden">
        <div className="p-3 border-b border-bg-border space-y-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search ledgers…"
              className="w-full bg-bg border border-bg-border rounded-lg pl-8 pr-3 py-1.5 text-sm text-primary placeholder-muted outline-none" />
          </div>
          <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}
            className="w-full bg-bg border border-bg-border rounded-lg px-2 py-1.5 text-sm text-primary outline-none">
            {groups.map((g) => <option key={g} value={g}>{g === "ALL" ? "All Groups" : g}</option>)}
          </select>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filtered.map((ledger) => (
            <div key={ledger.ledgerId}
              onClick={() => setSelectedLedgerId(ledger.ledgerId)}
              className={clsx("px-3 py-2.5 cursor-pointer border-b border-bg-border/50 transition-colors",
                selectedLedgerId === ledger.ledgerId ? "bg-accent/15 border-l-2 border-l-accent" : "hover:bg-bg-border/30")}>
              <div className="text-xs font-sans text-primary truncate">{ledger.name}</div>
              <div className="flex items-center justify-between mt-0.5">
                <span className="text-muted text-xs truncate">{ledger.group}</span>
                <span className={clsx("text-xs font-mono", ledger.openingBalance >= 0 ? "text-success" : "text-danger")}>
                  {fmtINR(Math.abs(ledger.openingBalance))} {ledger.openingBalance >= 0 ? "Dr" : "Cr"}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right: Ledger Detail */}
      <div className="flex-1 flex flex-col bg-bg-card border border-bg-border rounded-xl overflow-hidden">
        {selectedLedger ? (
          <>
            <div className="p-4 border-b border-bg-border">
              <h2 className="text-lg font-bold text-primary">{selectedLedger.name}</h2>
              <div className="flex gap-6 mt-2 text-sm">
                <div>
                  <span className="text-muted text-xs">Group: </span>
                  <span className="text-primary">{selectedLedger.group}</span>
                </div>
                <div>
                  <span className="text-muted text-xs">Opening: </span>
                  <span className={clsx("font-mono", selectedLedger.openingBalance >= 0 ? "text-success" : "text-danger")}>
                    {fmtINR(Math.abs(selectedLedger.openingBalance))} {selectedLedger.openingBalance >= 0 ? "Dr" : "Cr"}
                  </span>
                </div>
                {selectedLedger.creditDays > 0 && (
                  <div>
                    <span className="text-muted text-xs">Credit Days: </span>
                    <span className="text-primary">{selectedLedger.creditDays}</span>
                  </div>
                )}
                {selectedLedger.gstin && (
                  <div>
                    <span className="text-muted text-xs">GSTIN: </span>
                    <span className="text-primary font-mono text-xs">{selectedLedger.gstin}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-auto">
              {ledgerTransactions.length > 0 ? (
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-bg-card border-b border-bg-border">
                    <tr>
                      {["Date", "Voucher#", "Type", "Debit", "Credit", "Balance"].map((h) => (
                        <th key={h} className="text-left text-muted px-4 py-2.5 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-bg-border/50 bg-bg-border/10">
                      <td className="px-4 py-2 text-muted" colSpan={3}>Opening Balance</td>
                      <td className="px-4 py-2 font-mono text-success">{selectedLedger.openingBalance > 0 ? fmtINR(selectedLedger.openingBalance) : ""}</td>
                      <td className="px-4 py-2 font-mono text-danger">{selectedLedger.openingBalance < 0 ? fmtINR(Math.abs(selectedLedger.openingBalance)) : ""}</td>
                      <td className={clsx("px-4 py-2 font-mono", selectedLedger.openingBalance >= 0 ? "text-success" : "text-danger")}>
                        {fmtINR(Math.abs(selectedLedger.openingBalance))} {selectedLedger.openingBalance >= 0 ? "Dr" : "Cr"}
                      </td>
                    </tr>
                    {ledgerTransactions.map((tx, i) => (
                      <tr key={i} className="border-b border-bg-border/50 hover:bg-bg-border/20">
                        <td className="px-4 py-2 text-muted">{fmtDate(tx.date)}</td>
                        <td className="px-4 py-2 font-mono text-primary">{tx.voucherNumber}</td>
                        <td className="px-4 py-2 text-muted">{tx.type}</td>
                        <td className="px-4 py-2 font-mono text-success">{tx.debit > 0 ? fmtINR(tx.debit) : ""}</td>
                        <td className="px-4 py-2 font-mono text-danger">{tx.credit > 0 ? fmtINR(tx.credit) : ""}</td>
                        <td className={clsx("px-4 py-2 font-mono", tx.running >= 0 ? "text-success" : "text-danger")}>
                          {fmtINR(Math.abs(tx.running))} {tx.running >= 0 ? "Dr" : "Cr"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="flex items-center justify-center h-full text-muted text-sm">
                  No transactions for this ledger
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-muted text-sm">
            Select a ledger to view transactions
          </div>
        )}
      </div>
    </div>
  );
}
