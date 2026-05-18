/**
 * Price List Correction Tool
 *
 * Helps identify and fix cost prices in opening balances by:
 * 1. Showing which items have cost prices (< ₹50 or baby items < ₹500)
 * 2. Analyzing recent sales rates to estimate correct opening rates
 * 3. Generating bulk update CSV for Tally re-import
 */

import { useState, useMemo } from "react";
import { Upload, Download, AlertTriangle, TrendingUp } from "lucide-react";
import clsx from "clsx";
import { useDataStore } from "../store/dataStore";
import { auditPriceList, type PriceAnomaly } from "../utils/auditPriceList";
import { fmtINR, fmtNum } from "../utils/format";
import { useToast } from "../components/Toast";

interface CostPriceItem extends PriceAnomaly {
  recentSalesRate: number | null;
  recommendedRate: number | null;
  priority: "critical" | "high" | "medium";
}

export default function PriceListCorrection() {
  const data = useDataStore((s) => s.data);
  const { toast } = useToast();
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());

  // Analyze items with cost prices and recent sales
  const costPriceItems = useMemo<CostPriceItem[]>(() => {
    if (!data) return [];

    const auditResult = auditPriceList(data);

    // Filter to cost price + baby items only
    const items = auditResult.anomalies.filter(
      (a) =>
        a.flags.includes("BABY_ITEM_COST_PRICE") ||
        a.flags.includes("SUSPICIOUSLY_LOW_RATE")
    );

    // For each item, find recent sales rates
    const itemsWithRates = items.map((anom) => {
      const item = data.items.get(anom.itemId);
      const recentRates: number[] = [];

      // Search sales/delivery notes for this item
      for (const voucher of data.vouchers) {
        if (voucher.voucherType !== "Sales" &&
            !voucher.voucherType.toLowerCase().includes("delivery")) continue;
        if (voucher.isCancelled) continue;

        for (const line of voucher.lines) {
          if (line.type === "inventory" && line.itemId === anom.itemId && line.ratePerBase && line.ratePerBase > 0) {
            recentRates.push(line.ratePerBase);
          }
        }
      }

      let recommendedRate: number | null = null;
      let recentSalesRate: number | null = null;

      if (recentRates.length > 0) {
        // Use median of recent rates (more robust than average)
        const sorted = recentRates.sort((a, b) => a - b);
        recentSalesRate = sorted[Math.floor(sorted.length / 2)];
        recommendedRate = recentSalesRate;
      }

      // Determine priority
      let priority: "critical" | "high" | "medium" = "medium";
      if (anom.itemName.toLowerCase().includes("baby") ||
          anom.itemName.toLowerCase().includes("tricycle")) {
        priority = "critical";
      } else if (anom.openingRate === 0) {
        priority = "high";
      }

      return {
        ...anom,
        recentSalesRate,
        recommendedRate,
        priority,
      };
    });

    // Sort by priority: critical → high → medium, then by opening value (highest first)
    return itemsWithRates.sort((a, b) => {
      const priorityOrder = { critical: 0, high: 1, medium: 2 };
      if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      }
      return (b.openingValue || 0) - (a.openingValue || 0);
    });
  }, [data]);

  function toggleSelection(itemId: string) {
    const next = new Set(selectedItems);
    if (next.has(itemId)) {
      next.delete(itemId);
    } else {
      next.add(itemId);
    }
    setSelectedItems(next);
  }

  function selectAllByPriority(priority: "critical" | "high" | "medium") {
    const next = new Set(selectedItems);
    costPriceItems.forEach((item) => {
      if (item.priority === priority) {
        next.add(item.itemId);
      }
    });
    setSelectedItems(next);
  }

  function generateTallyCSV() {
    const selectedCostItems = costPriceItems.filter((item) =>
      selectedItems.has(item.itemId)
    );

    if (selectedCostItems.length === 0) {
      toast("Select items to export", "warn");
      return;
    }

    // CSV format for Tally re-import: Item Name | Opening Rate
    const rows = [
      "Item Name,Current Rate,Recommended Rate,Recent Sales Rate,Notes",
    ];

    selectedCostItems.forEach((item) => {
      const notes = item.flags.join("; ");
      rows.push(
        [
          `"${item.itemName}"`,
          item.openingRate.toFixed(2),
          item.recommendedRate ? item.recommendedRate.toFixed(2) : "?",
          item.recentSalesRate ? item.recentSalesRate.toFixed(2) : "No sales data",
          `"${notes}"`,
        ].join(",")
      );
    });

    rows.push(""); // Blank line
    rows.push("Instructions:");
    rows.push(
      '"Copy ""Recommended Rate"" column to TallyPrime Stock Items > Opening Rate"'
    );
    rows.push(
      '"If ""Recommended Rate"" is empty, use ""Recent Sales Rate"" or check item manually"'
    );

    const csv = rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv; charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cost-price-fixes-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    toast(
      `Exported ${selectedCostItems.length} items to CSV`,
      "success"
    );
  }

  if (!data) {
    return (
      <div className="empty-state">
        <Upload size={48} className="empty-state-icon" />
        <h2 className="empty-state-title">No Data Loaded</h2>
        <p className="text-sm text-muted">Import your Tally data first to audit prices</p>
      </div>
    );
  }

  const criticalCount = costPriceItems.filter((i) => i.priority === "critical").length;
  const highCount = costPriceItems.filter((i) => i.priority === "high").length;
  const mediumCount = costPriceItems.filter((i) => i.priority === "medium").length;

  return (
    <div className="page-section">
      {/* Header */}
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h1 className="page-title">Price List Correction</h1>
            <p className="page-subtitle">Fix {costPriceItems.length} cost prices using recent sales data</p>
          </div>
          <button
            onClick={generateTallyCSV}
            disabled={selectedItems.size === 0}
            className="btn-primary flex-shrink-0"
          >
            <Download size={16} /> Export {selectedItems.size > 0 ? `(${selectedItems.size})` : ""}
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-2 md:gap-3">
        <div className="bento-card">
          <div className="metric-label">Critical</div>
          <div className="metric-value text-danger">{criticalCount}</div>
          <div className="text-xs text-muted mt-1">Baby items under ₹500</div>
        </div>
        <div className="bento-card">
          <div className="metric-label">High Priority</div>
          <div className="metric-value text-warn">{highCount}</div>
          <div className="text-xs text-muted mt-1">Items under ₹50</div>
        </div>
        <div className="bento-card">
          <div className="metric-label">Medium Priority</div>
          <div className="metric-value text-info">{mediumCount}</div>
          <div className="text-xs text-muted mt-1">Other anomalies</div>
        </div>
      </div>

      {/* Selection Controls */}
      <div className="section-card mb-6">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setSelectedItems(new Set(costPriceItems.map((i) => i.itemId)))}
            className="btn-secondary text-sm"
          >
            Select All
          </button>
          <button
            onClick={() => selectAllByPriority("critical")}
            className="btn-secondary text-sm"
          >
            Select Critical ({criticalCount})
          </button>
          <button
            onClick={() => selectAllByPriority("high")}
            className="btn-secondary text-sm"
          >
            Select High ({highCount})
          </button>
          <button
            onClick={() => setSelectedItems(new Set())}
            className="btn-secondary text-sm"
          >
            Clear
          </button>
          <span className="text-xs text-muted ml-auto">
            {selectedItems.size} / {costPriceItems.length} selected
          </span>
        </div>
      </div>

      {/* Items Table */}
      <div className="section-card">
        <div className="overflow-x-auto -mx-5 -mb-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-bg-border text-xs text-muted bg-bg">
                <th className="text-left px-5 py-3 font-medium w-8"></th>
                <th className="text-left px-5 py-3 font-medium">Item Name</th>
                <th className="text-right px-5 py-3 font-medium">Current Rate</th>
                <th className="text-right px-5 py-3 font-medium">Recent Sales</th>
                <th className="text-right px-5 py-3 font-medium">Recommended</th>
                <th className="text-left px-5 py-3 font-medium">Priority</th>
                <th className="text-left px-5 py-3 font-medium">Issue</th>
              </tr>
            </thead>
            <tbody>
              {costPriceItems.map((item) => {
                const isSelected = selectedItems.has(item.itemId);
                const isCritical = item.priority === "critical";

                return (
                  <tr
                    key={item.itemId}
                    className={clsx(
                      "border-b border-bg-border/40 cursor-pointer transition-colors duration-150",
                      isSelected ? "bg-accent/10 hover:bg-accent/15" : "hover:bg-bg-hover",
                      isCritical && "border-l-4 border-l-danger"
                    )}
                  >
                    <td className="px-5 py-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelection(item.itemId)}
                        className="accent-accent cursor-pointer"
                      />
                    </td>
                    <td className="px-5 py-3">
                      <div className="font-medium text-primary">{item.itemName}</div>
                      {isCritical && (
                        <div className="text-2xs text-danger mt-0.5 flex items-center gap-1">
                          <AlertTriangle size={10} /> Finished goods
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right font-mono tabular-nums">
                      <span className="text-danger font-semibold">
                        ₹{item.openingRate.toFixed(2)}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right font-mono tabular-nums">
                      {item.recentSalesRate ? (
                        <span className="text-success font-semibold">
                          ₹{item.recentSalesRate.toFixed(2)}
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right font-mono tabular-nums">
                      {item.recommendedRate ? (
                        <div>
                          <span className="text-primary font-semibold">
                            ₹{item.recommendedRate.toFixed(2)}
                          </span>
                          {item.recentSalesRate && item.openingRate > 0 && (
                            <div className="text-2xs text-success mt-0.5 flex items-center justify-end gap-1">
                              <TrendingUp size={10} /> {Math.round((item.recommendedRate - item.openingRate) / item.openingRate * 100)}%
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-warn font-medium">Manual</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={clsx(
                          "inline-block px-2 py-1 rounded text-xs font-medium",
                          item.priority === "critical"
                            ? "bg-danger/15 text-danger"
                            : item.priority === "high"
                            ? "bg-warn/15 text-warn"
                            : "bg-info/15 text-info"
                        )}
                      >
                        {item.priority}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-muted">
                      {item.flags[0]}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Instructions */}
      <div className="section-card mt-6 bg-info/5 border border-info/20">
        <h3 className="font-semibold text-info mb-2 flex items-center gap-2">
          <AlertTriangle size={16} /> How to Fix
        </h3>
        <ol className="text-sm text-muted space-y-1 ml-4 list-decimal">
          <li>
            <strong>Select items</strong> to fix (critical items are auto-listed first)
          </li>
          <li>
            <strong>Review recommended rates</strong> — based on recent sales data
          </li>
          <li>
            <strong>Export CSV</strong> — opens in Excel for final review
          </li>
          <li>
            <strong>Update Tally</strong> — copy "Recommended Rate" to Stock Items &gt; Opening Rate
          </li>
          <li>
            <strong>Re-export</strong> Masters.json from Tally
          </li>
          <li>
            <strong>Re-import</strong> in dashboard and run audit again
          </li>
        </ol>
      </div>
    </div>
  );
}
