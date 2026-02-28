import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Plus, Minus, Trash2, Download, X, Upload, Package } from "lucide-react";
import Fuse from "fuse.js";
import * as XLSX from "xlsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Line,
  ComposedChart,
} from "recharts";
import { useDataStore } from "../store/dataStore";
import { useUIStore } from "../store/uiStore";
import { useOrderStore } from "../store/orderStore";
import { getCurrentStock, getCurrentStockIndexed, computeMonthlyBuckets, computeMonthlyBucketsIndexed, suggestedReorder, buildVoucherIndex } from "../engine/inventory";
import { toDisplay, fromDisplay } from "../engine/unitEngine";
import { UnitToggle } from "../components/UnitToggle";
import { fmtNum } from "../utils/format";
import type { CanonicalItem } from "../types/canonical";
import clsx from "clsx";

export default function Orders() {
  const navigate = useNavigate();
  const { data } = useDataStore();
  const { unitMode, coverMonths, setCoverMonths } = useUIStore();
  const { lines: orderLines, setLine, removeLine, clearAll, getAllLines } = useOrderStore();

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("ALL");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [orderQty, setOrderQty] = useState("");
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const orderInputRefs = useRef<{ [key: string]: HTMLInputElement | null }>({});
  const parentRef = useRef<HTMLDivElement>(null);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 150);
    return () => clearTimeout(timer);
  }, [search]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape") {
        setSearch("");
        searchRef.current?.blur();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const allItems = useMemo(() => {
    if (!data) return [];
    return Array.from(data.items.values());
  }, [data]);

  const groups = useMemo(() => {
    const gs = new Set(allItems.map((i) => i.group));
    return ["ALL", ...Array.from(gs).sort()];
  }, [allItems]);

  const fuse = useMemo(
    () => new Fuse(allItems, { keys: ["name", "group"], threshold: 0.4 }),
    [allItems]
  );

  // Build voucher index for O(V_item) instead of O(V) lookup
  const voucherIndex = useMemo(() => {
    if (!data) return new Map();
    return buildVoucherIndex(data.vouchers);
  }, [data]);

  // Cache stock calculations for all items (using indexed lookup)
  const stockCache = useMemo(() => {
    if (!data) return new Map<string, number>();
    const cache = new Map<string, number>();
    for (const item of allItems) {
      cache.set(item.itemId, getCurrentStockIndexed(item, voucherIndex));
    }
    return cache;
  }, [data, allItems, voucherIndex]);

  const filteredItems = useMemo(() => {
    let result = allItems;
    if (groupFilter !== "ALL") result = result.filter((i) => i.group === groupFilter);
    if (debouncedSearch.trim()) {
      const searchResult = fuse.search(debouncedSearch.trim());
      const ids = new Set(searchResult.map((r) => r.item.itemId));
      result = result.filter((i) => ids.has(i.itemId));
    }
    return result;
  }, [allItems, debouncedSearch, groupFilter, fuse]);

  const selectedItem = useMemo(
    () => (selectedItemId ? data?.items.get(selectedItemId) ?? null : null),
    [selectedItemId, data]
  );

  const currentStock = useMemo(() => {
    if (!selectedItem || !data) return 0;
    return getCurrentStockIndexed(selectedItem, voucherIndex);
  }, [selectedItem, data, voucherIndex]);

  const monthlyBuckets = useMemo(() => {
    if (!selectedItem || !data) return [];
    return computeMonthlyBucketsIndexed(selectedItem, voucherIndex, 8);
  }, [selectedItem, data, voucherIndex]);

  const suggested = useMemo(() => {
    if (!selectedItem || !data) return 0;
    const s = suggestedReorder(selectedItem, data.vouchers, currentStock, coverMonths);
    return Math.max(0, s);
  }, [selectedItem, data, currentStock, coverMonths]);


  function selectItem(item: CanonicalItem) {
    setSelectedItemId(item.itemId);
    const existing = orderLines[item.itemId];
    if (existing) {
      const disp = toDisplay(item, existing.qtyBase, unitMode);
      setOrderQty(String(disp.value));
    } else {
      const s = Math.max(0, suggestedReorder(item, data?.vouchers ?? [], getCurrentStock(item, data?.vouchers ?? []), coverMonths));
      const disp = toDisplay(item, s, unitMode);
      setOrderQty(s > 0 ? String(disp.value) : "");
    }
    setTimeout(() => qtyRef.current?.focus(), 50);
  }

  function addToOrder() {
    if (!selectedItem || !orderQty) return;
    const displayVal = parseFloat(orderQty) || 0;
    const qtyBase = fromDisplay(selectedItem, displayVal, unitMode);
    setLine(selectedItem.itemId, {
      itemId: selectedItem.itemId,
      itemName: selectedItem.name,
      baseUnit: selectedItem.baseUnit,
      pkgUnit: selectedItem.pkgUnit,
      unitsPerPkg: selectedItem.unitsPerPkg,
      qtyBase,
      ratePerBase: 0,
    });
    setOrderQty("");
  }

  function updateOrderLine(itemId: string, value: string) {
    const item = data?.items.get(itemId);
    if (!item) return;

    const displayVal = parseFloat(value) || 0;
    if (displayVal <= 0) {
      removeLine(itemId);
      return;
    }

    const qtyBase = fromDisplay(item, displayVal, unitMode);
    setLine(itemId, {
      itemId,
      itemName: item.name,
      baseUnit: item.baseUnit,
      pkgUnit: item.pkgUnit,
      unitsPerPkg: item.unitsPerPkg,
      qtyBase,
      ratePerBase: 0,
    });
  }

  function handleOrderInputKeyDown(e: React.KeyboardEvent, itemId: string, items: CanonicalItem[]) {
    const currentIdx = items.findIndex(i => i.itemId === itemId);

    if (e.key === "Enter") {
      e.preventDefault();
      const nextItem = items[currentIdx + 1];
      if (nextItem) {
        const nextInput = orderInputRefs.current[nextItem.itemId];
        if (nextInput) {
          nextInput.focus();
          nextInput.select();
          setFocusedItemId(nextItem.itemId);
        }
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const nextItem = items[currentIdx + 1];
      if (nextItem) {
        const nextInput = orderInputRefs.current[nextItem.itemId];
        if (nextInput) {
          nextInput.focus();
          nextInput.select();
          setFocusedItemId(nextItem.itemId);
        }
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prevItem = items[currentIdx - 1];
      if (prevItem) {
        const prevInput = orderInputRefs.current[prevItem.itemId];
        if (prevInput) {
          prevInput.focus();
          prevInput.select();
          setFocusedItemId(prevItem.itemId);
        }
      }
    }
  }

  const handleKeyDown = useCallback((e: React.KeyboardEvent, items: CanonicalItem[]) => {
    const idx = selectedItemId ? items.findIndex((i) => i.itemId === selectedItemId) : -1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = items[idx + 1];
      if (next) selectItem(next);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = items[idx - 1];
      if (prev) selectItem(prev);
    } else if (e.key === "Enter" && selectedItemId) {
      qtyRef.current?.focus();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItemId, orderLines, unitMode, coverMonths, data]);

  function exportCSV() {
    const lines = getAllLines();
    const rows = [
      ["Item", "Qty", "Unit"],
      ...lines.map((l) => {
        const item = data?.items.get(l.itemId);
        const disp = toDisplay(item ?? null, l.qtyBase, unitMode);
        return [l.itemName, disp.value, disp.label];
      }),
    ];
    const csv = rows.map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `order_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  function exportXLSX() {
    const lines = getAllLines();
    const ws = XLSX.utils.aoa_to_sheet([
      ["Item", "Qty", "Unit"],
      ...lines.map((l) => {
        const item = data?.items.get(l.itemId);
        const disp = toDisplay(item ?? null, l.qtyBase, unitMode);
        return [l.itemName, disp.value, disp.label];
      }),
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Order");
    XLSX.writeFile(wb, `order_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  function getStockColor(item: CanonicalItem, stock: number) {
    if (stock <= 0) return "text-danger";
    const avg = suggested;
    if (avg > 0 && stock < avg) return "text-warn";
    return "text-success";
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-4">
        <Package size={64} className="text-muted" />
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

  const orderLinesList = getAllLines();

  // Track focused item for graph
  const focusedItem = useMemo(() => {
    if (!focusedItemId) return selectedItem;
    return data?.items.get(focusedItemId) ?? selectedItem;
  }, [focusedItemId, selectedItem, data]);

  const focusedStock = useMemo(() => {
    if (!focusedItem || !data) return 0;
    return getCurrentStockIndexed(focusedItem, voucherIndex);
  }, [focusedItem, data, voucherIndex]);

  const focusedMonthlyBuckets = useMemo(() => {
    if (!focusedItem || !data) return [];
    return computeMonthlyBucketsIndexed(focusedItem, voucherIndex, 8);
  }, [focusedItem, data, voucherIndex]);

  return (
    <div className="flex flex-col h-[calc(100vh-112px)] gap-0">
      {/* Top 3-panel area */}
      <div className="flex gap-0 flex-1 min-h-0 overflow-hidden rounded-xl border border-bg-border">
        {/* LEFT: Item List */}
        <div className="w-[26%] flex flex-col border-r border-bg-border bg-bg-card">
          <div className="p-3 border-b border-bg-border space-y-2">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search items… (Ctrl+F)"
                className="w-full bg-bg border border-bg-border rounded-lg pl-8 pr-3 py-1.5 text-sm text-primary placeholder-muted focus:border-accent/60 outline-none"
                onKeyDown={(e) => handleKeyDown(e, filteredItems)}
              />
            </div>
            <select
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value)}
              className="w-full bg-bg border border-bg-border rounded-lg px-2 py-1.5 text-sm text-primary outline-none"
            >
              {groups.map((g) => (
                <option key={g} value={g}>{g === "ALL" ? "All Groups" : g}</option>
              ))}
            </select>
          </div>
          <div ref={parentRef} className="flex-1 overflow-y-auto">
            {(() => {
              const virtualizer = useVirtualizer({
                count: filteredItems.length,
                getScrollElement: () => parentRef.current,
                estimateSize: () => 58,
                overscan: 15,
              });

              return (
                <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}>
                  {virtualizer.getVirtualItems().map((virtualRow) => {
                    const item = filteredItems[virtualRow.index];
                    const stock = stockCache.get(item.itemId) ?? 0;
                    const isSelected = item.itemId === selectedItemId;
                    const inOrder = !!orderLines[item.itemId];
                    const stockDisp = toDisplay(item, stock, unitMode);
                    return (
                      <div
                        key={item.itemId}
                        onClick={() => selectItem(item)}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                        className={clsx(
                          "px-3 py-2.5 cursor-pointer border-b border-bg-border/50 transition-colors",
                          isSelected ? "bg-accent/15 border-l-2 border-l-accent" : "hover:bg-bg-border/30"
                        )}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className={clsx("text-sm font-sans truncate", isSelected ? "text-accent font-medium" : "text-primary")}>
                            {item.name}
                          </span>
                          {inOrder && <span className="text-accent text-xs">●</span>}
                        </div>
                        <div className="flex items-center justify-between mt-0.5">
                          <span className="text-muted text-sm truncate">{item.group}</span>
                          <span className={clsx("text-sm font-mono", getStockColor(item, stock))}>
                            {stockDisp.formatted}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        </div>

        {/* CENTER: Item Detail & Graph */}
        <div className="flex-1 flex flex-col bg-bg min-h-0">
          {focusedItem ? (
            <div className="p-4 flex flex-col gap-4 overflow-y-auto">
              <div>
                <h2 className="text-lg font-bold text-primary leading-tight">{focusedItem.name}</h2>
                <div className="text-muted text-xs mt-0.5">{focusedItem.group} · {focusedItem.baseUnit}{focusedItem.pkgUnit ? ` · ${focusedItem.unitsPerPkg}/${focusedItem.pkgUnit}` : ""}</div>
              </div>

              {/* Mini KPIs */}
              {focusedMonthlyBuckets.length > 0 && (() => {
                const last = focusedMonthlyBuckets[focusedMonthlyBuckets.length - 1]!;
                return (
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      { label: "Opening", val: toDisplay(focusedItem, last.openingQtyBase, unitMode).formatted, color: "text-muted" },
                      { label: "In", val: toDisplay(focusedItem, last.inwardsBase, unitMode).formatted, color: "text-success" },
                      { label: "Out", val: toDisplay(focusedItem, last.outwardsBase, unitMode).formatted, color: "text-danger" },
                      { label: "Closing", val: toDisplay(focusedItem, focusedStock, unitMode).formatted, color: focusedStock <= 0 ? "text-danger" : "text-primary" },
                    ].map(({ label, val, color }) => (
                      <div key={label} className="bg-bg-card border border-bg-border rounded-lg p-2 text-center">
                        <div className={`text-sm font-mono font-semibold ${color}`}>{val}</div>
                        <div className="text-muted text-xs mt-0.5">{label}</div>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* Monthly data table */}
              {focusedMonthlyBuckets.length > 0 && (
                <div className="bg-bg-card border border-bg-border rounded-xl overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-bg-border">
                        {["Month", "Opening", "In", "Out", "Closing"].map((h) => (
                          <th key={h} className="text-left text-muted px-3 py-2 font-medium">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {focusedMonthlyBuckets.map((b) => (
                        <tr key={b.yearMonth} className="border-b border-bg-border/50">
                          <td className="px-3 py-1.5 text-muted">{b.label}</td>
                          <td className="px-3 py-1.5 font-mono text-primary">{toDisplay(focusedItem, b.openingQtyBase, unitMode).formatted}</td>
                          <td className="px-3 py-1.5 font-mono text-success">{toDisplay(focusedItem, b.inwardsBase, unitMode).formatted}</td>
                          <td className="px-3 py-1.5 font-mono text-danger">{toDisplay(focusedItem, b.outwardsBase, unitMode).formatted}</td>
                          <td className="px-3 py-1.5 font-mono text-primary font-semibold">{toDisplay(focusedItem, b.closingQtyBase, unitMode).formatted}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Chart */}
              {focusedMonthlyBuckets.length > 0 && (
                <div className="bg-bg-card border border-bg-border rounded-xl p-3">
                  <div className="text-xs text-muted mb-2 font-medium">8-Month History</div>
                  <ResponsiveContainer width="100%" height={180}>
                    <ComposedChart data={focusedMonthlyBuckets.map((b) => ({
                      label: b.label,
                      in: toDisplay(focusedItem, b.inwardsBase, unitMode).value,
                      out: toDisplay(focusedItem, b.outwardsBase, unitMode).value,
                      closing: toDisplay(focusedItem, b.closingQtyBase, unitMode).value,
                    }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#64748b" }} />
                      <YAxis tick={{ fontSize: 10, fill: "#64748b" }} />
                      <Tooltip
                        contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 8 }}
                        labelStyle={{ color: "#0f172a" }}
                      />
                      <Bar dataKey="in" fill="#10b981" name="In" radius={[2, 2, 0, 0]} barSize={12} />
                      <Bar dataKey="out" fill="#ef4444" name="Out" radius={[2, 2, 0, 0]} barSize={12} />
                      <Line type="monotone" dataKey="closing" stroke="#3b82f6" dot={false} strokeWidth={2} name="Stock" />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              )}

            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-muted text-sm">
              Select an item from the list
            </div>
          )}
        </div>

        {/* RIGHT: Order Entry (All Items) — Virtualized */}
        <div className="w-[28%] flex flex-col border-l border-bg-border bg-bg-card min-h-0">
          <div className="flex items-center justify-between px-4 py-3 border-b border-bg-border">
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-primary">Order Entry</span>
              <span className="text-xs text-muted font-mono">{orderLinesList.length} items</span>
            </div>
            <div className="flex gap-2">
              <UnitToggle />
              <button onClick={exportCSV} className="flex items-center gap-1.5 text-xs bg-bg-border hover:bg-bg-border/70 text-muted hover:text-primary px-2 py-1.5 rounded-lg transition">
                <Download size={12} />
              </button>
              <button onClick={exportXLSX} className="flex items-center gap-1.5 text-xs bg-accent hover:bg-accent-hover text-white px-2 py-1.5 rounded-lg transition">
                <Download size={12} />
              </button>
              <button onClick={clearAll} className="text-xs bg-danger/20 hover:bg-danger/30 text-danger px-2 py-1.5 rounded-lg transition">
                <Trash2 size={12} />
              </button>
            </div>
          </div>
          <div className="sticky top-0 bg-bg-card border-b border-bg-border z-10">
            <div className="flex text-xs text-muted font-medium">
              <div className="flex-1 px-3 py-2">Item</div>
              <div className="w-24 px-3 py-2">Order Qty</div>
            </div>
          </div>
          {(() => {
            const orderPanelRef = useRef<HTMLDivElement>(null);
            const orderVirtualizer = useVirtualizer({
              count: filteredItems.length,
              getScrollElement: () => orderPanelRef.current,
              estimateSize: () => 40,
              overscan: 15,
            });
            return (
              <div ref={orderPanelRef} className="flex-1 overflow-y-auto min-h-0">
                <div style={{ height: `${orderVirtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}>
                  {orderVirtualizer.getVirtualItems().map((virtualRow) => {
                    const item = filteredItems[virtualRow.index];
                    const orderLine = orderLines[item.itemId];
                    const orderQtyValue = orderLine ? toDisplay(item, orderLine.qtyBase, unitMode).value : 0;
                    const hasOrder = orderQtyValue > 0;
                    return (
                      <div
                        key={item.itemId}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                        className={clsx(
                          "flex items-center border-b border-bg-border/50 hover:bg-bg-border/20 transition-colors",
                          focusedItemId === item.itemId && "bg-accent/10"
                        )}
                      >
                        <div className="flex-1 px-3 py-2 text-xs text-primary truncate" title={item.name}>
                          {item.name}
                        </div>
                        <div className="w-24 px-3 py-2">
                          <input
                            ref={(el) => { orderInputRefs.current[item.itemId] = el; }}
                            type="text"
                            inputMode="decimal"
                            value={orderQtyValue || ""}
                            onChange={(e) => {
                              updateOrderLine(item.itemId, e.target.value);
                            }}
                            onFocus={() => {
                              setFocusedItemId(item.itemId);
                              setSelectedItemId(item.itemId);
                            }}
                            onBlur={() => {
                              if (focusedItemId === item.itemId) {
                                setTimeout(() => setFocusedItemId(null), 100);
                              }
                            }}
                            onKeyDown={(e) => handleOrderInputKeyDown(e, item.itemId, filteredItems)}
                            placeholder="0"
                            className={clsx(
                              "w-full bg-bg border border-bg-border rounded px-2 py-1 font-mono text-xs text-center outline-none focus:border-accent/60 transition-all",
                              hasOrder ? "font-bold text-accent" : "text-muted"
                            )}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
