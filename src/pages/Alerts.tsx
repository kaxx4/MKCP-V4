import { useState, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useDataStore } from "../store/dataStore";
import { useOrderStore, type OrderLine } from "../store/orderStore";
import { useUIStore } from "../store/uiStore";
import {
  getCurrentStockIndexed,
  avgMonthlyOutwardIndexed,
  suggestedReorderIndexed,
} from "../engine/inventory";
import { toDisplay } from "../engine/unitEngine";
import { fmtINR, fmtNum } from "../utils/format";
import { AlertTriangle, Upload, Search, ShoppingCart, Check, Download } from "lucide-react";
import clsx from "clsx";
import type { CanonicalItem } from "../types/canonical";

interface AlertRow {
  item: CanonicalItem;
  stock: number;
  avgOut: number;
  suggested: number;
  monthsRemaining: number;
  severity: "Critical" | "Low" | "Reorder" | "OK";
}

export default function Alerts() {
  const navigate = useNavigate();
  const { data, voucherIndex } = useDataStore();
  const { setLine } = useOrderStore();
  const { unitMode } = useUIStore();
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("ALL");
  const [severityFilter, setSeverityFilter] = useState<"All" | "Critical" | "Low" | "Reorder">("All");
  const [addedItems, setAddedItems] = useState<Set<string>>(new Set());
  const parentRef = useRef<HTMLDivElement>(null);

  // Compute alert data for all items
  const alertData = useMemo(() => {
    if (!data) return [];
    return Array.from(data.items.values())
      .map((item): AlertRow => {
        const stock = getCurrentStockIndexed(item, voucherIndex);
        const avgOut = avgMonthlyOutwardIndexed(item, voucherIndex, 3);
        const suggested = suggestedReorderIndexed(item, voucherIndex, stock);
        const monthsRemaining = avgOut > 0 ? stock / avgOut : Infinity;
        let severity: AlertRow["severity"] = "OK";
        if (stock <= 0) severity = "Critical";
        else if (avgOut > 0 && stock < avgOut) severity = "Low";
        else if (suggested > 0) severity = "Reorder";
        return { item, stock, avgOut, suggested, monthsRemaining, severity };
      })
      .filter((d) => d.severity !== "OK");
  }, [data, voucherIndex]);

  // Apply filters
  const filtered = useMemo(() => {
    let result = alertData;
    if (groupFilter !== "ALL") result = result.filter((d) => d.item.group === groupFilter);
    if (severityFilter !== "All") result = result.filter((d) => d.severity === severityFilter);
    if (search) {
      const s = search.toLowerCase();
      result = result.filter((d) => d.item.name.toLowerCase().includes(s));
    }
    return result.sort((a, b) => {
      const order = { Critical: 0, Low: 1, Reorder: 2, OK: 3 };
      return order[a.severity] - order[b.severity];
    });
  }, [alertData, groupFilter, severityFilter, search]);

  // Groups for filter
  const groups = useMemo(() => {
    const gs = new Set(alertData.map((d) => d.item.group));
    return ["ALL", ...Array.from(gs).sort()];
  }, [alertData]);

  // KPIs
  const kpis = useMemo(
    () => ({
      totalReorder: alertData.filter((d) => d.suggested > 0).length,
      totalReorderValue: alertData.reduce((s, d) => s + d.suggested * d.item.openingRate, 0),
      zeroStock: alertData.filter((d) => d.stock <= 0).length,
      lowSupply: alertData.filter((d) => d.severity === "Low").length,
    }),
    [alertData]
  );

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 20,
  });

  // Add to order handler
  const handleAdd = (d: AlertRow) => {
    setLine(d.item.itemId, {
      itemId: d.item.itemId,
      itemName: d.item.name,
      baseUnit: d.item.baseUnit,
      pkgUnit: d.item.pkgUnit,
      unitsPerPkg: d.item.unitsPerPkg,
      qtyBase: d.suggested,
      ratePerBase: d.item.openingRate,
    });
    setAddedItems((prev) => new Set(prev).add(d.item.itemId));
  };

  const handleAddAll = () => {
    for (const d of filtered) {
      if (d.suggested > 0) {
        handleAdd(d);
      }
    }
  };

  // CSV export
  const exportCSV = () => {
    const rows = [
      ["Item", "Group", "Current Stock", "Unit", "Avg Monthly Out (3mo)", "Months Remaining", "Suggested Reorder", "Severity"],
      ...filtered.map((d) => {
        const stockDisp = toDisplay(d.item, d.stock, unitMode);
        const avgDisp = toDisplay(d.item, d.avgOut, unitMode);
        const sugDisp = toDisplay(d.item, d.suggested, unitMode);
        const months = d.avgOut > 0 ? (d.stock / d.avgOut).toFixed(1) : "N/A";
        return [
          d.item.name,
          d.item.group,
          stockDisp.value,
          stockDisp.label,
          avgDisp.value,
          months,
          sugDisp.value,
          d.severity,
        ];
      }),
    ];
    const csv = rows.map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `low_stock_alerts_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  // No data state
  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-4">
        <AlertTriangle size={64} className="text-muted" />
        <h2 className="text-xl font-semibold text-primary">No Data Loaded</h2>
        <button
          onClick={() => navigate("/import")}
          className="flex items-center gap-2 bg-accent hover:bg-accent-hover text-white font-semibold px-5 py-2.5 rounded-lg transition mt-2"
        >
          <Upload size={16} />
          Import Data
        </button>
      </div>
    );
  }

  const severityBadge = (severity: AlertRow["severity"]) => {
    const styles = {
      Critical: "bg-danger/10 text-danger",
      Low: "bg-warn/10 text-warn",
      Reorder: "bg-accent/10 text-accent",
      OK: "bg-success/10 text-success",
    };
    return (
      <span className={clsx("px-2 py-0.5 rounded-full text-xs font-medium", styles[severity])}>
        {severity}
      </span>
    );
  };

  return (
    <div className="flex flex-col h-[calc(100vh-112px)] gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-primary">Low Stock Alerts</h1>
          <span className="bg-accent/15 text-accent text-xs font-semibold px-2.5 py-1 rounded-full">
            {filtered.length} items
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={exportCSV}
            className="flex items-center gap-1.5 text-xs bg-bg-card border border-bg-border hover:bg-bg-border/70 text-muted hover:text-primary px-3 py-2 rounded-lg transition"
          >
            <Download size={14} />
            Export CSV
          </button>
          <button
            onClick={handleAddAll}
            className="flex items-center gap-1.5 text-sm bg-accent hover:bg-accent-hover text-white font-semibold px-4 py-2 rounded-lg transition"
          >
            <ShoppingCart size={14} />
            Add All to Order
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-4 gap-3">
        {[
          {
            label: "Items Needing Reorder",
            value: fmtNum(kpis.totalReorder, 0),
            color: "text-warn",
            bg: "bg-warn/10",
          },
          {
            label: "Total Reorder Value",
            value: fmtINR(kpis.totalReorderValue),
            color: "text-accent",
            bg: "bg-accent/10",
          },
          {
            label: "Zero Stock Items",
            value: fmtNum(kpis.zeroStock, 0),
            color: "text-danger",
            bg: "bg-danger/10",
          },
          {
            label: "< 1 Month Supply",
            value: fmtNum(kpis.lowSupply, 0),
            color: "text-warn",
            bg: "bg-warn/10",
          },
        ].map(({ label, value, color, bg }) => (
          <div key={label} className="bg-bg-card border border-bg-border rounded-xl p-4">
            <div className={clsx("text-2xl font-bold font-mono", color)}>{value}</div>
            <div className="text-muted text-xs mt-1">{label}</div>
          </div>
        ))}
      </div>

      {/* Filter Bar */}
      <div className="flex items-center gap-3">
        <select
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
          className="bg-bg-card border border-bg-border rounded-lg px-3 py-2 text-sm text-primary outline-none focus:border-accent/60"
        >
          {groups.map((g) => (
            <option key={g} value={g}>
              {g === "ALL" ? "All Groups" : g}
            </option>
          ))}
        </select>
        <select
          value={severityFilter}
          onChange={(e) => setSeverityFilter(e.target.value as typeof severityFilter)}
          className="bg-bg-card border border-bg-border rounded-lg px-3 py-2 text-sm text-primary outline-none focus:border-accent/60"
        >
          <option value="All">All Severities</option>
          <option value="Critical">Critical (Zero Stock)</option>
          <option value="Low">Low (&lt; 1 Month)</option>
          <option value="Reorder">Reorder Needed</option>
        </select>
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search items..."
            className="w-full bg-bg-card border border-bg-border rounded-lg pl-9 pr-3 py-2 text-sm text-primary placeholder-muted focus:border-accent/60 outline-none"
          />
        </div>
      </div>

      {/* Virtualized Table */}
      <div className="bg-bg-card border border-bg-border rounded-xl overflow-hidden flex flex-col flex-1 min-h-0">
        {/* Table header */}
        <div className="flex text-xs text-muted font-medium border-b border-bg-border bg-bg-card sticky top-0 z-10">
          <div className="flex-1 px-4 py-2.5 min-w-0">Item</div>
          <div className="w-28 px-3 py-2.5 text-right">Group</div>
          <div className="w-28 px-3 py-2.5 text-right">Stock</div>
          <div className="w-28 px-3 py-2.5 text-right">Avg Out/Mo</div>
          <div className="w-24 px-3 py-2.5 text-right">Months Left</div>
          <div className="w-28 px-3 py-2.5 text-right">Reorder Qty</div>
          <div className="w-24 px-3 py-2.5 text-center">Severity</div>
          <div className="w-28 px-3 py-2.5 text-center">Action</div>
        </div>

        {/* Table body */}
        <div ref={parentRef} className="flex-1 overflow-y-auto min-h-0">
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              position: "relative",
              width: "100%",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const d = filtered[virtualRow.index];
              const stockDisp = toDisplay(d.item, d.stock, unitMode);
              const avgDisp = toDisplay(d.item, d.avgOut, unitMode);
              const sugDisp = toDisplay(d.item, d.suggested, unitMode);
              const isAdded = addedItems.has(d.item.itemId);

              let monthsLabel: string;
              let monthsColor: string;
              if (d.stock <= 0) {
                monthsLabel = "0";
                monthsColor = "text-danger font-bold";
              } else if (d.avgOut === 0) {
                monthsLabel = "\u221E";
                monthsColor = "text-muted";
              } else {
                monthsLabel = (d.stock / d.avgOut).toFixed(1);
                monthsColor = d.monthsRemaining < 1 ? "text-warn" : "text-primary";
              }

              return (
                <div
                  key={d.item.itemId}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                    height: `${virtualRow.size}px`,
                  }}
                  className="flex items-center border-b border-bg-border/50 hover:bg-bg-border/20 transition-colors"
                >
                  <div className="flex-1 px-4 text-sm text-primary truncate min-w-0" title={d.item.name}>
                    {d.item.name}
                  </div>
                  <div className="w-28 px-3 text-xs text-muted text-right truncate" title={d.item.group}>
                    {d.item.group}
                  </div>
                  <div className="w-28 px-3 text-sm font-mono text-right text-primary">
                    {stockDisp.formatted}
                  </div>
                  <div className="w-28 px-3 text-sm font-mono text-right text-muted">
                    {avgDisp.formatted}
                  </div>
                  <div className={clsx("w-24 px-3 text-sm font-mono text-right", monthsColor)}>
                    {monthsLabel}
                  </div>
                  <div className="w-28 px-3 text-sm font-mono text-right text-accent font-semibold">
                    {d.suggested > 0 ? sugDisp.formatted : "-"}
                  </div>
                  <div className="w-24 px-3 text-center">{severityBadge(d.severity)}</div>
                  <div className="w-28 px-3 text-center">
                    {isAdded ? (
                      <span className="inline-flex items-center gap-1 text-xs text-success font-medium">
                        <Check size={12} />
                        Added
                      </span>
                    ) : d.suggested > 0 ? (
                      <button
                        onClick={() => handleAdd(d)}
                        className="inline-flex items-center gap-1 text-xs bg-accent/10 hover:bg-accent/20 text-accent font-medium px-2.5 py-1 rounded-lg transition cursor-pointer"
                      >
                        <ShoppingCart size={12} />
                        Add
                      </button>
                    ) : (
                      <span className="text-xs text-muted">-</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
