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
import { AlertTriangle, Upload, ShoppingCart, Check, Download } from "lucide-react";
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
  const { unitMode, isMobile } = useUIStore();
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
      <div className="empty-state">
        <AlertTriangle size={64} className="empty-state-icon" />
        <h2 className="empty-state-title">No Data Loaded</h2>
        <button
          onClick={() => navigate("/import")}
          className="btn-primary mt-2"
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
      <span className={clsx("badge", severity === "Critical" ? "badge-danger" : severity === "Low" ? "badge-warn" : severity === "Reorder" ? "badge-muted" : "badge-success")}>
        {severity}
      </span>
    );
  };

  return (
    <div className="flex flex-col h-[calc(100vh-112px)] gap-3 md:gap-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h1 className="page-title">Low Stock Alerts</h1>
          <span className="badge badge-muted">
            {filtered.length} items
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={exportCSV}
            className="btn-secondary btn-sm"
          >
            <Download size={14} />
            Export
          </button>
          <button
            onClick={handleAddAll}
            className="btn-primary btn-sm"
          >
            <ShoppingCart size={14} />
            Add All
          </button>
        </div>
      </div>

      {/* KPI Cards — responsive bento grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
        {[
          {
            label: "Need Reorder",
            value: fmtNum(kpis.totalReorder, 0),
            color: "text-warn",
          },
          {
            label: "Reorder Value",
            value: fmtINR(kpis.totalReorderValue),
            color: "text-accent",
          },
          {
            label: "Zero Stock",
            value: fmtNum(kpis.zeroStock, 0),
            color: "text-danger",
          },
          {
            label: "< 1 Month",
            value: fmtNum(kpis.lowSupply, 0),
            color: "text-warn",
          },
        ].map(({ label, value, color }) => (
          <div key={label} className="bento-card">
            <div className={clsx("metric-value truncate", color)}>{value}</div>
            <div className="metric-label">{label}</div>
          </div>
        ))}
      </div>

      {/* Filter Bar — wraps on mobile */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
          className="form-select"
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
          className="form-select"
        >
          <option value="All">All Severities</option>
          <option value="Critical">Critical</option>
          <option value="Low">Low</option>
          <option value="Reorder">Reorder</option>
        </select>
        <div className="flex-1 min-w-[120px]">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search items..."
            className="search-input w-full"
          />
        </div>
      </div>

      {/* Mobile: Card list / Desktop: Virtualized Table */}
      {isMobile ? (
        <div ref={parentRef} className="flex-1 overflow-y-auto min-h-0 space-y-2">
          {filtered.map((d) => {
            const stockDisp = toDisplay(d.item, d.stock, unitMode);
            const sugDisp = toDisplay(d.item, d.suggested, unitMode);
            const isAdded = addedItems.has(d.item.itemId);

            return (
              <div key={d.item.itemId} className="bento-card space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-primary truncate">{d.item.name}</div>
                    <div className="text-[10px] text-muted truncate">{d.item.group}</div>
                  </div>
                  {severityBadge(d.severity)}
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <span className="text-muted">Stock</span>
                    <div className="tabular-nums font-medium text-primary">{stockDisp.formatted}</div>
                  </div>
                  <div>
                    <span className="text-muted">Avg/mo</span>
                    <div className="tabular-nums font-medium text-muted">{toDisplay(d.item, d.avgOut, unitMode).formatted}</div>
                  </div>
                  <div>
                    <span className="text-muted">Reorder</span>
                    <div className="tabular-nums font-semibold text-accent">{d.suggested > 0 ? sugDisp.formatted : "-"}</div>
                  </div>
                </div>
                {d.suggested > 0 && (
                  <button
                    onClick={() => handleAdd(d)}
                    disabled={isAdded}
                    className={clsx(
                      "w-full flex items-center justify-center gap-1.5 btn-sm",
                      isAdded ? "btn-ghost text-success" : "btn-ghost text-accent cursor-pointer"
                    )}
                  >
                    {isAdded ? <><Check size={12} /> Added</> : <><ShoppingCart size={12} /> Add to Order</>}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="section-card overflow-hidden flex flex-col flex-1 min-h-0">
          {/* Table header */}
          <div className="flex table-header-sticky">
            <div className="flex-1 px-4 py-2.5 min-w-0">Item</div>
            <div className="w-28 px-3 py-2.5 text-right hidden lg:block">Group</div>
            <div className="w-24 px-3 py-2.5 text-right">Stock</div>
            <div className="w-24 px-3 py-2.5 text-right hidden md:block">Avg/Mo</div>
            <div className="w-20 px-3 py-2.5 text-right hidden md:block">Mo Left</div>
            <div className="w-24 px-3 py-2.5 text-right">Reorder</div>
            <div className="w-20 px-3 py-2.5 text-center">Status</div>
            <div className="w-24 px-3 py-2.5 text-center">Action</div>
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
                    <div className="w-28 px-3 text-xs text-muted text-right truncate hidden lg:block" title={d.item.group}>
                      {d.item.group}
                    </div>
                    <div className="w-24 px-3 text-sm tabular-nums text-right text-primary">
                      {stockDisp.formatted}
                    </div>
                    <div className="w-24 px-3 text-sm tabular-nums text-right text-muted hidden md:block">
                      {avgDisp.formatted}
                    </div>
                    <div className={clsx("w-20 px-3 text-sm tabular-nums text-right hidden md:block", monthsColor)}>
                      {monthsLabel}
                    </div>
                    <div className="w-24 px-3 text-sm tabular-nums text-right text-accent font-semibold">
                      {d.suggested > 0 ? sugDisp.formatted : "-"}
                    </div>
                    <div className="w-20 px-3 text-center">{severityBadge(d.severity)}</div>
                    <div className="w-24 px-3 text-center">
                      {isAdded ? (
                        <span className="inline-flex items-center gap-1 text-xs text-success font-medium">
                          <Check size={12} />
                          Added
                        </span>
                      ) : d.suggested > 0 ? (
                        <button
                          onClick={() => handleAdd(d)}
                          className="btn-ghost btn-sm text-accent"
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
      )}
    </div>
  );
}
