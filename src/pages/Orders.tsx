import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Plus, Minus, Trash2, Download, X, Upload, Package, Filter, FolderPlus, FolderOpen, Save, Copy, ChevronDown, ChevronUp, BarChart3 } from "lucide-react";
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
import { useOrderGroupStore, type OrderGroup } from "../store/orderGroupStore";
import { getCurrentStock, getCurrentStockIndexed, computeMonthlyBuckets, computeMonthlyBucketsIndexed, suggestedReorder, suggestedReorderIndexed, avgMonthlyOutwardIndexed } from "../engine/inventory";
import { getItemMovements, type MovementRecord, type MovementDirection } from "../engine/audit/movementTracer";
import { toDisplay, fromDisplay } from "../engine/unitEngine";
import { UnitToggle } from "../components/UnitToggle";
import { fmtNum } from "../utils/format";
import type { CanonicalItem } from "../types/canonical";
import clsx from "clsx";

export default function Orders() {
  const navigate = useNavigate();
  const { data, voucherIndex } = useDataStore();
  const { unitMode, coverMonths, setCoverMonths, isMobile } = useUIStore();
  const { lines: orderLines, setLine, removeLine, clearAll, getAllLines } = useOrderStore();
  const {
    groups: orderGroupsMap,
    activeGroupId,
    createGroup,
    updateGroup,
    deleteGroup,
    duplicateGroup,
    setActiveGroup,
    setGroupLines,
    addLinesToGroup,
    getAllGroups,
  } = useOrderGroupStore();

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("ALL");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [orderQty, setOrderQty] = useState("");
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);
  const [stockFilterEnabled, setStockFilterEnabled] = useState(false);
  const [stockFilterOp, setStockFilterOp] = useState<"<=" | ">=" | "=">("<=");
  const [stockFilterValue, setStockFilterValue] = useState("0");
  const [showGroupPanel, setShowGroupPanel] = useState(false);
  const [showChart, setShowChart] = useState(true);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupDesc, setNewGroupDesc] = useState("");
  const [movementModal, setMovementModal] = useState<{ direction: MovementDirection; month?: string } | null>(null);
  const [mobileTab, setMobileTab] = useState<"list" | "detail" | "order">("list");
  const [monthSpan, setMonthSpan] = useState(8);

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
    if (stockFilterEnabled) {
      const threshold = parseFloat(stockFilterValue) || 0;
      result = result.filter((i) => {
        const stock = stockCache.get(i.itemId) ?? 0;
        if (stockFilterOp === "<=") return stock <= threshold;
        if (stockFilterOp === ">=") return stock >= threshold;
        return stock === threshold;
      });
    }
    return result;
  }, [allItems, debouncedSearch, groupFilter, fuse, stockFilterEnabled, stockFilterOp, stockFilterValue, stockCache]);

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
    return computeMonthlyBucketsIndexed(selectedItem, voucherIndex, monthSpan);
  }, [selectedItem, data, voucherIndex, monthSpan]);

  const suggested = useMemo(() => {
    if (!selectedItem || !data) return 0;
    const s = suggestedReorderIndexed(selectedItem, voucherIndex, currentStock, coverMonths);
    return Math.max(0, s);
  }, [selectedItem, data, voucherIndex, currentStock, coverMonths]);


  function selectItem(item: CanonicalItem) {
    setSelectedItemId(item.itemId);
    const existing = orderLines[item.itemId];
    if (existing) {
      const disp = toDisplay(item, existing.qtyBase, unitMode);
      setOrderQty(String(disp.value));
    } else {
      const s = Math.max(0, suggestedReorderIndexed(item, voucherIndex, getCurrentStockIndexed(item, voucherIndex), coverMonths));
      const disp = toDisplay(item, s, unitMode);
      setOrderQty(s > 0 ? String(disp.value) : "");
    }
    if (isMobile) {
      setMobileTab("detail");
    } else {
      setTimeout(() => qtyRef.current?.focus(), 50);
    }
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

  // ── Order Group Helpers ──
  const orderGroups = getAllGroups();

  function handleCreateGroup() {
    if (!newGroupName.trim()) return;
    const id = createGroup(newGroupName.trim(), newGroupDesc.trim());
    const currentLines = getAllLines();
    if (currentLines.length > 0) {
      const lineMap: Record<string, any> = {};
      for (const l of currentLines) lineMap[l.itemId] = l;
      setGroupLines(id, lineMap);
    }
    setNewGroupName("");
    setNewGroupDesc("");
    setActiveGroup(id);
  }

  function handleSaveToGroup(groupId: string) {
    const currentLines = getAllLines();
    const lineMap: Record<string, any> = {};
    for (const l of currentLines) lineMap[l.itemId] = l;
    setGroupLines(groupId, lineMap);
  }

  function handleLoadGroup(group: OrderGroup) {
    clearAll();
    for (const [itemId, line] of Object.entries(group.lines)) {
      setLine(itemId, line);
    }
    setActiveGroup(group.id);
  }

  function handleAddGroupToOrder(group: OrderGroup) {
    for (const [itemId, line] of Object.entries(group.lines)) {
      setLine(itemId, line);
    }
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
    // Use item's own avg monthly outward to determine if stock is low
    const avg = avgMonthlyOutwardIndexed(item, voucherIndex);
    if (avg > 0 && stock < avg * coverMonths) return "text-warn";
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
    return computeMonthlyBucketsIndexed(focusedItem, voucherIndex, monthSpan);
  }, [focusedItem, data, voucherIndex, monthSpan]);

  return (
    <div className="flex flex-col h-screen gap-0">
      {/* Page title for accessibility - hidden from view */}
      <h1 className="sr-only">Purchase Orders</h1>

      {/* Order Groups Bar */}
      <div className="flex items-center gap-2 px-2 md:px-3 py-2 bg-white border border-bg-border rounded-t-2xl mb-0 overflow-x-auto">
        <button
          onClick={() => setShowGroupPanel(!showGroupPanel)}
          className={clsx(
            "flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition",
            showGroupPanel ? "bg-accent text-white" : "bg-bg-border text-muted hover:text-primary"
          )}
        >
          <FolderOpen size={13} />
          Order Groups ({orderGroups.length})
        </button>
        {orderGroups.length > 0 && !showGroupPanel && (
          <div className="flex gap-1.5 overflow-x-auto">
            {orderGroups.slice(0, 5).map((g) => (
              <button
                key={g.id}
                onClick={() => handleLoadGroup(g)}
                className={clsx(
                  "flex items-center gap-1 text-xs px-2.5 py-1 rounded-md border transition whitespace-nowrap",
                  activeGroupId === g.id
                    ? "border-accent bg-accent/10 text-accent font-medium"
                    : "border-bg-border text-muted hover:text-primary hover:bg-bg-border/50"
                )}
                title={`${Object.keys(g.lines).length} items — ${g.description || "No description"}`}
              >
                <span className="w-2 h-2 rounded-full" style={{ background: g.color }} />
                {g.name}
                <span className="text-muted/60 font-mono">({Object.keys(g.lines).length})</span>
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2 text-xs text-muted">
          <span className="font-mono">{orderLinesList.length} items in order</span>
        </div>
      </div>

      {/* Order Groups Expanded Panel */}
      {showGroupPanel && (
        <div className="bg-bg-card border-x border-b border-bg-border p-4 space-y-3 mb-0">
          {/* Create new group */}
          <div className="flex flex-col md:flex-row items-stretch md:items-end gap-2 md:gap-3">
            <div className="flex-1">
              <label className="text-xs text-muted font-medium mb-1 block">Group Name</label>
              <input
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="e.g. Weekly Order, Premium Items, Urgent Restock…"
                className="w-full bg-bg border border-bg-border rounded-lg px-3 py-1.5 text-sm text-primary outline-none focus:border-accent/60"
                onKeyDown={(e) => e.key === "Enter" && handleCreateGroup()}
              />
            </div>
            <div className="flex-1">
              <label className="text-xs text-muted font-medium mb-1 block">Description (optional)</label>
              <input
                value={newGroupDesc}
                onChange={(e) => setNewGroupDesc(e.target.value)}
                placeholder="Notes about this order group…"
                className="w-full bg-bg border border-bg-border rounded-lg px-3 py-1.5 text-sm text-primary outline-none focus:border-accent/60"
                onKeyDown={(e) => e.key === "Enter" && handleCreateGroup()}
              />
            </div>
            <button
              onClick={handleCreateGroup}
              disabled={!newGroupName.trim()}
              className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover disabled:opacity-40 text-white text-sm font-medium px-4 py-1.5 rounded-lg transition whitespace-nowrap"
            >
              <FolderPlus size={14} />
              Create & Save Current Order
            </button>
          </div>

          {/* Existing groups */}
          {orderGroups.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              {orderGroups.map((g) => {
                const lineCount = Object.keys(g.lines).length;
                const isActive = activeGroupId === g.id;
                return (
                  <div
                    key={g.id}
                    className={clsx(
                      "border rounded-lg p-3 transition",
                      isActive ? "border-accent bg-accent/5" : "border-bg-border bg-bg hover:bg-bg-border/20"
                    )}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: g.color }} />
                        <span className="font-medium text-sm text-primary truncate">{g.name}</span>
                      </div>
                      <span className="text-xs font-mono text-muted whitespace-nowrap">{lineCount} items</span>
                    </div>
                    {g.description && (
                      <p className="text-xs text-muted mb-2 truncate">{g.description}</p>
                    )}
                    <div className="text-xs text-muted mb-2">
                      Updated: {new Date(g.updatedAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}
                    </div>
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => handleLoadGroup(g)}
                        className="flex items-center gap-1 text-xs px-2 py-1 bg-accent/15 text-accent hover:bg-accent/25 rounded transition"
                      >
                        <FolderOpen size={11} /> Load
                      </button>
                      <button
                        onClick={() => handleAddGroupToOrder(g)}
                        className="flex items-center gap-1 text-xs px-2 py-1 bg-bg-border text-muted hover:text-primary rounded transition"
                        title="Add group items to current order"
                      >
                        <Plus size={11} /> Merge
                      </button>
                      <button
                        onClick={() => handleSaveToGroup(g.id)}
                        className="flex items-center gap-1 text-xs px-2 py-1 bg-bg-border text-muted hover:text-primary rounded transition"
                        title="Overwrite group with current order"
                      >
                        <Save size={11} /> Save
                      </button>
                      <button
                        onClick={() => duplicateGroup(g.id)}
                        className="flex items-center gap-1 text-xs px-2 py-1 bg-bg-border text-muted hover:text-primary rounded transition"
                      >
                        <Copy size={11} />
                      </button>
                      <button
                        onClick={() => { if (confirm(`Delete "${g.name}"?`)) deleteGroup(g.id); }}
                        className="flex items-center gap-1 text-xs px-2 py-1 bg-danger/10 text-danger hover:bg-danger/20 rounded transition ml-auto"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-4 text-sm text-muted">
              No order groups yet. Create one to save your current order for reuse.
            </div>
          )}
        </div>
      )}

      {/* Mobile tab switcher */}
      {isMobile && (
        <div className="flex bento-card !p-1 gap-1">
          {([["list", "Items"], ["detail", "Detail"], ["order", "Order"]] as const).map(([tab, label]) => (
            <button
              key={tab}
              onClick={() => setMobileTab(tab)}
              className={clsx(
                "flex-1 py-2 text-xs font-medium rounded-lg transition",
                mobileTab === tab ? "bg-accent text-white" : "text-muted hover:text-primary"
              )}
            >
              {label} {tab === "order" && orderLinesList.length > 0 && `(${orderLinesList.length})`}
            </button>
          ))}
        </div>
      )}

      {/* Top 3-panel area */}
      <div className={clsx("flex gap-0 flex-1 min-h-0 overflow-hidden rounded-xl border border-bg-border", isMobile && "flex-col")}>
        {/* LEFT: Item List */}
        <div className={clsx(
          "flex flex-col border-bg-border bg-bg-card",
          isMobile ? (mobileTab === "list" ? "flex-1" : "hidden") : "w-[26%] border-r"
        )}>
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
            {/* Group filter hidden per user request */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setStockFilterEnabled((v) => !v)}
                className={clsx(
                  "flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg border transition",
                  stockFilterEnabled
                    ? "bg-accent/15 border-accent text-accent font-medium"
                    : "bg-bg border-bg-border text-muted hover:text-primary"
                )}
                title="Filter by closing stock"
              >
                <Filter size={12} />
                Stock
              </button>
              {stockFilterEnabled && (
                <>
                  <select
                    value={stockFilterOp}
                    onChange={(e) => setStockFilterOp(e.target.value as "<=" | ">=" | "=")}
                    className="bg-bg border border-bg-border rounded-lg px-1.5 py-1.5 text-xs text-primary outline-none font-mono"
                  >
                    <option value="<=">≤</option>
                    <option value=">=">≥</option>
                    <option value="=">=</option>
                  </select>
                  <input
                    type="number"
                    value={stockFilterValue}
                    onChange={(e) => setStockFilterValue(e.target.value)}
                    className="w-16 bg-bg border border-bg-border rounded-lg px-2 py-1.5 text-xs text-primary font-mono text-center outline-none focus:border-accent/60"
                  />
                </>
              )}
            </div>
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
        <div className={clsx(
          "flex flex-col bg-bg min-h-0",
          isMobile ? (mobileTab === "detail" ? "flex-1" : "hidden") : "flex-1"
        )}>
          {focusedItem ? (
            <div className="p-4 flex flex-col gap-4 overflow-y-auto flex-1">
              <div>
                <h2 className="text-base md:text-lg font-bold text-primary leading-tight">{focusedItem.name}</h2>
                <div className="text-muted text-xs mt-0.5">{focusedItem.group} · {focusedItem.baseUnit}{focusedItem.pkgUnit ? ` · ${focusedItem.unitsPerPkg}/${focusedItem.pkgUnit}` : ""}</div>
              </div>

              {/* Mobile quick-add to order */}
              {isMobile && selectedItem && (
                <div className="flex items-center gap-2 bg-bg-card border border-bg-border rounded-lg p-2">
                  <span className="text-xs text-muted flex-shrink-0">Order Qty:</span>
                  <input
                    ref={qtyRef}
                    type="text"
                    inputMode="decimal"
                    value={orderQty}
                    onChange={(e) => setOrderQty(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addToOrder()}
                    placeholder="0"
                    className="flex-1 bg-bg border border-bg-border rounded px-2 py-1.5 font-mono text-sm text-center outline-none focus:border-accent/60"
                  />
                  <button
                    onClick={addToOrder}
                    disabled={!orderQty}
                    className="bg-accent hover:bg-accent-hover disabled:opacity-40 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition"
                  >
                    <Plus size={14} />
                  </button>
                </div>
              )}

              {/* Mini KPIs - Redesigned for Accessibility */}
              {focusedItem && focusedMonthlyBuckets.length > 0 && (() => {
                const item = focusedItem; // Capture in const to ensure non-null type
                const last = focusedMonthlyBuckets[focusedMonthlyBuckets.length - 1]!;
                const kpis = [
                  { label: "Opening", val: toDisplay(item, last.openingQtyBase, unitMode).formatted, color: "text-text-primary", clickable: false },
                  { label: "In", val: toDisplay(item, last.inwardsBase, unitMode).formatted, color: "text-success", clickable: true, direction: "inward" as MovementDirection },
                  { label: "Out", val: toDisplay(item, last.outwardsBase, unitMode).formatted, color: "text-danger", clickable: true, direction: "outward" as MovementDirection },
                  { label: "Closing", val: toDisplay(item, focusedStock, unitMode).formatted, color: focusedStock <= 0 ? "text-danger" : "text-accent", clickable: false },
                ];
                return (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {kpis.map(({ label, val, color, clickable, direction }) => (
                      <div
                        key={label}
                        onClick={clickable && direction ? () => setMovementModal({ direction, month: last.yearMonth }) : undefined}
                        className={clsx(
                          "bg-bg-card border-2 border-bg-border rounded-lg p-4 text-center transition-all",
                          clickable && "cursor-pointer hover:border-accent hover:bg-accent/10 hover:shadow-md"
                        )}
                        title={clickable ? `Click to view ${label.toLowerCase()} transactions` : undefined}
                      >
                        <div className={`text-lg md:text-xl font-semibold ${color}`}>{val}</div>
                        <div className="text-text-secondary text-sm font-medium mt-1">{label} {clickable && "→"}</div>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* Monthly data table - Redesigned for Accessibility */}
              {focusedItem && focusedMonthlyBuckets.length > 0 && (() => {
                const item = focusedItem; // Capture in const to ensure non-null type
                return (
                  <div className={clsx("bento-card !p-0 overflow-hidden", !showChart && "flex-1 flex flex-col")}>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-bg-card border-b-2 border-bg-border">
                          {["Month", "Opening", "In", "Out", "Closing"].map((h) => (
                            <th key={h} className="text-left text-text-primary font-bold px-4 py-3">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {focusedMonthlyBuckets.map((b) => {
                          const inwardVal = toDisplay(item, b.inwardsBase, unitMode).value;
                          const outwardVal = toDisplay(item, b.outwardsBase, unitMode).value;
                          return (
                            <tr key={b.yearMonth} className={clsx("border-b border-bg-border/50 hover:bg-bg-card/50 transition-colors", !showChart && "h-full")}>
                              <td className={clsx("px-4 text-text-primary font-medium", showChart ? "py-3" : "py-4")}>{b.label}</td>
                              <td className={clsx("px-4 font-semibold text-text-primary", showChart ? "py-3" : "py-4")}>{toDisplay(item, b.openingQtyBase, unitMode).formatted}</td>
                              <td
                                className={clsx("px-4 font-semibold cursor-pointer hover:underline transition-colors",
                                  inwardVal === 0 ? "text-bg-border/60 hover:text-bg-border/80" : "text-success hover:text-success-hover",
                                  showChart ? "py-3" : "py-4"
                                )}
                                onClick={() => inwardVal !== 0 && setMovementModal({ direction: "inward", month: b.yearMonth })}
                                title={inwardVal !== 0 ? "Click to view inward transactions" : "No inward movements"}
                              >{toDisplay(item, b.inwardsBase, unitMode).formatted}</td>
                              <td
                                className={clsx("px-4 font-semibold cursor-pointer hover:underline transition-colors",
                                  outwardVal === 0 ? "text-bg-border/60 hover:text-bg-border/80" : "text-danger hover:text-danger-hover",
                                  showChart ? "py-3" : "py-4"
                                )}
                                onClick={() => outwardVal !== 0 && setMovementModal({ direction: "outward", month: b.yearMonth })}
                                title={outwardVal !== 0 ? "Click to view outward transactions" : "No outward movements"}
                              >{toDisplay(item, b.outwardsBase, unitMode).formatted}</td>
                              <td className={clsx("px-4 font-bold text-accent", showChart ? "py-3" : "py-4")}>{toDisplay(item, b.closingQtyBase, unitMode).formatted}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })()}

              {/* Chart Toggle + Data Span Control */}
              {focusedItem && focusedMonthlyBuckets.length > 0 && (() => {
                const item = focusedItem; // Capture in const to ensure non-null type
                return (
                  <div className="bento-card !p-0 overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-3 border-b border-bg-border hover:bg-bg-card/50 transition-colors">
                      <button
                        onClick={() => setShowChart(!showChart)}
                        className="flex items-center gap-1.5 text-sm font-medium text-text-primary hover:text-accent transition-colors"
                      >
                        <BarChart3 size={16} />
                        {monthSpan}-Month History
                      </button>
                      <div className="flex items-center gap-2">
                        <label className="text-xs font-medium text-text-secondary">Show:</label>
                        <select
                          value={monthSpan}
                          onChange={(e) => setMonthSpan(parseInt(e.target.value))}
                          className="bg-bg-card border border-bg-border rounded px-2 py-1 text-xs font-medium text-text-primary hover:border-accent focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all"
                        >
                          {[3, 6, 8, 12, 24].map((m) => (
                            <option key={m} value={m}>{m} mo</option>
                          ))}
                        </select>
                        {showChart ? <ChevronUp size={16} className="text-text-secondary" /> : <ChevronDown size={16} className="text-text-secondary" />}
                      </div>
                    </div>
                    {showChart && (
                      <div className="px-3 pb-3">
                        <ResponsiveContainer width="100%" height={Math.max(180, 180 + (monthSpan - 8) * 15)}>
                          <ComposedChart data={focusedMonthlyBuckets.map((b) => ({
                            label: b.label,
                            in: toDisplay(item, b.inwardsBase, unitMode).value,
                            out: toDisplay(item, b.outwardsBase, unitMode).value,
                            closing: toDisplay(item, b.closingQtyBase, unitMode).value,
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
                );
              })()}

              {/* Movement Transaction Modal */}
              {movementModal && focusedItem && (() => {
                const movements = getItemMovements(
                  focusedItem,
                  voucherIndex,
                  movementModal.direction,
                  movementModal.month,
                );
                const dirLabel = movementModal.direction === "inward" ? "Inward" : "Outward";
                const monthLabel = movementModal.month
                  ? new Date(Number(movementModal.month.split("-")[0]), Number(movementModal.month.split("-")[1]) - 1, 1)
                      .toLocaleString("en-IN", { month: "short", year: "2-digit" })
                  : "All";
                return (
                  <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setMovementModal(null)}>
                    <div className={clsx("bento-card shadow-2xl flex flex-col", isMobile ? "w-full h-full rounded-none" : "w-[700px] max-h-[80vh]")} onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-between px-4 py-3 border-b border-bg-border">
                        <div>
                          <h3 className="text-sm font-bold text-primary">{focusedItem.name} — {dirLabel} Transactions</h3>
                          <p className="text-xs text-muted mt-0.5">Month: {monthLabel} · {movements.length} transactions</p>
                        </div>
                        <button onClick={() => setMovementModal(null)} className="text-muted hover:text-primary p-1"><X size={16} /></button>
                      </div>
                      <div className="overflow-y-auto flex-1">
                        {movements.length === 0 ? (
                          <div className="text-center text-muted text-sm py-8">No {dirLabel.toLowerCase()} transactions found</div>
                        ) : (
                          <table className="w-full text-xs">
                            <thead className="sticky top-0 bg-bg-card">
                              <tr className="border-b border-bg-border">
                                <th className="text-left text-muted px-3 py-2 font-medium">Date</th>
                                <th className="text-left text-muted px-3 py-2 font-medium">Voucher</th>
                                <th className="text-left text-muted px-3 py-2 font-medium">Type</th>
                                <th className="text-left text-muted px-3 py-2 font-medium">Party</th>
                                <th className="text-right text-muted px-3 py-2 font-medium">Qty</th>
                                <th className="text-right text-muted px-3 py-2 font-medium">Rate</th>
                                <th className="text-right text-muted px-3 py-2 font-medium">Amount</th>
                              </tr>
                            </thead>
                            <tbody>
                              {movements.map((m, i) => (
                                <tr key={`${m.voucherId}-${i}`} className="border-b border-bg-border/50 hover:bg-bg-border/20">
                                  <td className="px-3 py-1.5 text-muted">{m.date}</td>
                                  <td className="px-3 py-1.5 font-mono text-primary">{m.voucherNumber}</td>
                                  <td className="px-3 py-1.5 text-muted">{m.voucherType}</td>
                                  <td className="px-3 py-1.5 text-primary truncate max-w-[160px]" title={m.partyName}>{m.partyName}</td>
                                  <td className="px-3 py-1.5 font-mono text-right">{fmtNum(m.qty)}</td>
                                  <td className="px-3 py-1.5 font-mono text-right text-muted">{m.rate > 0 ? fmtNum(m.rate) : "—"}</td>
                                  <td className="px-3 py-1.5 font-mono text-right font-semibold">{fmtNum(m.amount)}</td>
                                </tr>
                              ))}
                            </tbody>
                            <tfoot>
                              <tr className="border-t-2 border-bg-border bg-bg-border/10">
                                <td colSpan={4} className="px-3 py-2 font-semibold text-primary">Total</td>
                                <td className="px-3 py-2 font-mono text-right font-bold">{fmtNum(movements.reduce((s, m) => s + m.qty, 0))}</td>
                                <td className="px-3 py-2"></td>
                                <td className="px-3 py-2 font-mono text-right font-bold">{fmtNum(movements.reduce((s, m) => s + m.amount, 0))}</td>
                              </tr>
                            </tfoot>
                          </table>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}

            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-muted text-sm">
              Select an item from the list
            </div>
          )}
        </div>

        {/* RIGHT: Order Entry (All Items) — Virtualized */}
        <div className={clsx(
          "flex flex-col border-bg-border bg-bg-card min-h-0",
          isMobile ? (mobileTab === "order" ? "flex-1" : "hidden") : "w-[28%] border-l"
        )}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-bg-border">
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-primary">Order Entry</span>
              <span className="text-xs text-muted font-mono">{orderLinesList.length} items</span>
            </div>
            <div className="flex gap-2">
              <UnitToggle />
              <button onClick={exportCSV} className="flex items-center gap-1.5 text-xs bg-bg-border hover:bg-bg-border/70 text-muted hover:text-primary px-2 py-1.5 rounded-lg transition cursor-pointer" aria-label="Export as CSV" title="Export CSV">
                <Download size={12} />
              </button>
              <button onClick={exportXLSX} className="flex items-center gap-1.5 text-xs bg-accent hover:bg-accent-hover text-white px-2 py-1.5 rounded-lg transition cursor-pointer" aria-label="Export as Excel" title="Export Excel">
                <Download size={12} />
              </button>
              <button onClick={clearAll} className="text-xs bg-danger/20 hover:bg-danger/30 text-danger px-2 py-1.5 rounded-lg transition cursor-pointer" aria-label="Clear all order items" title="Clear order">
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
