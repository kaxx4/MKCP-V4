import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Minus, Trash2, Download, X, Upload, Package, Filter, FolderPlus, FolderOpen, Save, Copy, ChevronDown, ChevronUp, BarChart3 } from "lucide-react";
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
import { getItemMovements, getItemOrderDocs, type MovementRecord, type MovementDirection } from "../engine/audit/movementTracer";
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
  const [modalTab, setModalTab] = useState<"actual" | "orders">("actual");

  function openMovementModal(direction: MovementDirection, month?: string) {
    setModalTab("actual");
    setMovementModal({ direction, month });
  }
  const [mobileTab, setMobileTab] = useState<"list" | "detail" | "order">("list");
  const [monthSpan, setMonthSpan] = useState(8);

  const searchRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const orderInputRefs = useRef<{ [key: string]: HTMLInputElement | null }>({});
  const parentRef = useRef<HTMLDivElement>(null);
  const orderPanelRef = useRef<HTMLDivElement>(null);

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

  const itemListVirtualizer = useVirtualizer({
    count: filteredItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 30,
    overscan: 15,
  });

  const orderVirtualizer = useVirtualizer({
    count: filteredItems.length,
    getScrollElement: () => orderPanelRef.current,
    estimateSize: () => 40,
    overscan: 15,
  });

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
        <Package size={64} className="text-neutral-500" />
        <h2 className="text-xl font-semibold text-neutral-900">No Data Loaded</h2>
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
      <div className="flex items-center gap-2 px-2 md:px-3 py-2 bento-card !rounded-b-none !mb-0 overflow-x-auto">
        <button
          onClick={() => setShowGroupPanel(!showGroupPanel)}
          className={clsx(
            "flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition duration-150",
            showGroupPanel ? "bg-accent text-white" : "bg-neutral-100 text-neutral-500 hover:text-neutral-900"
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
                  "flex items-center gap-1 text-xs px-2.5 py-1 rounded-md border transition duration-150 whitespace-nowrap",
                  activeGroupId === g.id
                    ? "border-accent bg-accent/10 text-accent font-medium"
                    : "border-neutral-200 text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100/50"
                )}
                title={`${Object.keys(g.lines).length} items — ${g.description || "No description"}`}
              >
                <span className="w-2 h-2 rounded-full" style={{ background: g.color }} />
                {g.name}
                <span className="text-neutral-400 tabular-nums">({Object.keys(g.lines).length})</span>
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2 text-xs text-neutral-500">
          <span className="tabular-nums">{orderLinesList.length} items in order</span>
        </div>
      </div>

      {/* Order Groups Expanded Panel */}
      {showGroupPanel && (
        <div className="bg-white border-x border-b border-neutral-200 p-4 space-y-3 mb-0 page-section">
          {/* Create new group */}
          <div className="flex flex-col md:flex-row items-stretch md:items-end gap-2 md:gap-3">
            <div className="flex-1">
              <label className="label-text mb-1 block">Group Name</label>
              <input
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="e.g. Weekly Order, Premium Items, Urgent Restock…"
                className="form-input"
                onKeyDown={(e) => e.key === "Enter" && handleCreateGroup()}
              />
            </div>
            <div className="flex-1">
              <label className="label-text mb-1 block">Description (optional)</label>
              <input
                value={newGroupDesc}
                onChange={(e) => setNewGroupDesc(e.target.value)}
                placeholder="Notes about this order group…"
                className="form-input"
                onKeyDown={(e) => e.key === "Enter" && handleCreateGroup()}
              />
            </div>
            <button
              onClick={handleCreateGroup}
              disabled={!newGroupName.trim()}
              className="btn-primary btn-sm whitespace-nowrap"
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
                      "border rounded-lg p-3 transition duration-150",
                      isActive ? "border-accent bg-accent/5" : "border-neutral-200 bg-neutral-50 hover:bg-neutral-100/20"
                    )}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: g.color }} />
                        <span className="card-title truncate">{g.name}</span>
                      </div>
                      <span className="text-xs tabular-nums text-neutral-500 whitespace-nowrap">{lineCount} items</span>
                    </div>
                    {g.description && (
                      <p className="text-xs text-neutral-500 mb-2 truncate">{g.description}</p>
                    )}
                    <div className="text-xs text-neutral-500 mb-2">
                      Updated: {new Date(g.updatedAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}
                    </div>
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => handleLoadGroup(g)}
                        className="btn-accent-ghost btn-sm"
                      >
                        <FolderOpen size={11} /> Load
                      </button>
                      <button
                        onClick={() => handleAddGroupToOrder(g)}
                        className="btn-ghost btn-sm"
                        title="Add group items to current order"
                      >
                        <Plus size={11} /> Merge
                      </button>
                      <button
                        onClick={() => handleSaveToGroup(g.id)}
                        className="btn-ghost btn-sm"
                        title="Overwrite group with current order"
                      >
                        <Save size={11} /> Save
                      </button>
                      <button
                        onClick={() => duplicateGroup(g.id)}
                        className="btn-ghost btn-sm"
                      >
                        <Copy size={11} />
                      </button>
                      <button
                        onClick={() => { if (confirm(`Delete "${g.name}"?`)) deleteGroup(g.id); }}
                        className="flex items-center gap-1 text-xs px-2 py-1 bg-danger/10 text-danger hover:bg-danger/20 rounded transition duration-150 ml-auto"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-4 text-sm text-neutral-500">
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
                "flex-1 py-2 text-xs font-medium rounded-lg transition duration-150",
                mobileTab === tab ? "bg-accent text-white" : "text-neutral-500 hover:text-neutral-900"
              )}
            >
              {label} {tab === "order" && orderLinesList.length > 0 && `(${orderLinesList.length})`}
            </button>
          ))}
        </div>
      )}

      {/* Top 3-panel area */}
      <div className={clsx("flex gap-0 flex-1 min-h-0 overflow-hidden rounded-xl border border-neutral-200", isMobile && "flex-col")}>
        {/* LEFT: Item List */}
        <div className={clsx(
          "flex flex-col border-neutral-200 bg-white",
          isMobile ? (mobileTab === "list" ? "flex-1" : "hidden") : "w-[26%] border-r"
        )}>
          <div className="p-2 border-b border-neutral-200 space-y-1.5">
            <div>
              <input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search… (Ctrl+F)"
                className="search-input w-full text-xs py-1.5"
                onKeyDown={(e) => handleKeyDown(e, filteredItems)}
              />
            </div>
            {/* Group filter hidden per user request */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setStockFilterEnabled((v) => !v)}
                className={clsx(
                  "flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg border transition duration-150",
                  stockFilterEnabled
                    ? "bg-accent/15 border-accent text-accent font-medium"
                    : "bg-neutral-50border-neutral-200 text-neutral-500 hover:text-neutral-900"
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
                    className="form-select text-xs py-1 pl-2 min-h-0 tabular-nums"
                  >
                    <option value="<=">≤</option>
                    <option value=">=">≥</option>
                    <option value="=">=</option>
                  </select>
                  <input
                    type="number"
                    value={stockFilterValue}
                    onChange={(e) => setStockFilterValue(e.target.value)}
                    className="w-16 form-input text-xs tabular-nums text-center py-1.5"
                  />
                </>
              )}
            </div>
          </div>
          <div ref={parentRef} className="flex-1 overflow-y-auto">
                <div style={{ height: `${itemListVirtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}>
                  {itemListVirtualizer.getVirtualItems().map((virtualRow) => {
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
                          "flex items-center gap-2 px-3 py-1.5 cursor-pointer border-b border-neutral-100 transition-colors duration-100",
                          isSelected ? "bg-accent/10 border-l-2 border-l-accent" : "hover:bg-neutral-50"
                        )}
                      >
                        <span className={clsx(
                          "text-xs truncate flex-1 min-w-0 leading-none",
                          isSelected ? "text-accent font-semibold" : "text-neutral-800"
                        )}>
                          {item.name}
                        </span>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <span className={clsx("text-[11px] tabular-nums", getStockColor(item, stock))}>
                            {stockDisp.formatted}
                          </span>
                          {inOrder && (
                            <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
          </div>
        </div>

        {/* CENTER: Item Detail & Graph */}
        <div className={clsx(
          "flex flex-col bg-neutral-50 min-h-0",
          isMobile ? (mobileTab === "detail" ? "flex-1" : "hidden") : "flex-1"
        )}>
          {focusedItem ? (
            <div className="p-4 flex flex-col gap-4 overflow-y-auto flex-1">
              <div>
                <h2 className="subsection-header leading-tight">{focusedItem.name}</h2>
                <div className="metric-label mt-0.5">{focusedItem.group} · {focusedItem.baseUnit}{focusedItem.pkgUnit ? ` · ${focusedItem.unitsPerPkg}/${focusedItem.pkgUnit}` : ""}</div>
              </div>

              {/* Mobile quick-add to order */}
              {isMobile && selectedItem && (
                <div className="flex items-center gap-2 bg-white border border-neutral-200 rounded-lg p-2">
                  <span className="label-text flex-shrink-0">Order Qty:</span>
                  <input
                    ref={qtyRef}
                    type="text"
                    inputMode="decimal"
                    value={orderQty}
                    onChange={(e) => setOrderQty(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addToOrder()}
                    placeholder="0"
                    className="flex-1 form-input tabular-nums text-sm text-center"
                  />
                  <button
                    onClick={addToOrder}
                    disabled={!orderQty}
                    className="btn-primary btn-sm"
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
                  { label: "Opening", val: toDisplay(item, last.openingQtyBase, unitMode).formatted, color: "text-neutral-900", clickable: false },
                  { label: "In", val: toDisplay(item, last.inwardsBase, unitMode).formatted, color: "text-success", clickable: true, direction: "inward" as MovementDirection },
                  { label: "Out", val: toDisplay(item, last.outwardsBase, unitMode).formatted, color: "text-danger", clickable: true, direction: "outward" as MovementDirection },
                  { label: "Closing", val: toDisplay(item, focusedStock, unitMode).formatted, color: focusedStock <= 0 ? "text-danger" : "text-accent", clickable: false },
                ];
                return (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {kpis.map(({ label, val, color, clickable, direction }) => (
                      <div
                        key={label}
                        onClick={clickable && direction ? () => openMovementModal(direction, last.yearMonth) : undefined}
                        className={clsx(
                          "bento-card !p-4 text-center transition-all duration-150",
                          clickable && "cursor-pointer hover:border-accent hover:bg-accent/10 hover:shadow-md"
                        )}
                        title={clickable ? `Click to view ${label.toLowerCase()} transactions` : undefined}
                      >
                        <div className={`kpi-value ${color}`}>{val}</div>
                        <div className="metric-label mt-1">{label} {clickable && "→"}</div>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* Monthly data table - Redesigned for Accessibility with Responsive Scrolling */}
              {focusedItem && focusedMonthlyBuckets.length > 0 && (() => {
                const item = focusedItem; // Capture in const to ensure non-null type
                return (
                  <div className={clsx("section-card !p-0 overflow-hidden flex flex-col", !showChart && "flex-1")}>
                    {/* Fixed table header with scrollable body */}
                    <div className={clsx("table-scroll", !showChart ? "flex-1 min-h-[300px]" : "max-h-[400px]")}>
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 z-10">
                          <tr className="bg-white border-b-2 border-neutral-200">
                            {["Month", "Opening", "In", "Out", "Closing"].map((h) => (
                              <th key={h} className="table-header-sticky">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {focusedMonthlyBuckets.map((b) => {
                            const inwardVal = toDisplay(item, b.inwardsBase, unitMode).value;
                            const outwardVal = toDisplay(item, b.outwardsBase, unitMode).value;
                            // Consistent row height for better scrolling UX
                            const dynamicPadding = clsx("py-3", monthSpan > 12 && "md:py-2.5");
                            return (
                              <tr key={b.yearMonth} className="responsive-table-row">
                                <td className={clsx("table-cell-emphasis whitespace-nowrap", dynamicPadding)}>{b.label}</td>
                                <td className={clsx("table-cell-mono", dynamicPadding)}>{toDisplay(item, b.openingQtyBase, unitMode).formatted}</td>
                                <td
                                  className={clsx("table-cell-mono cursor-pointer hover:underline transition-colors duration-150",
                                    inwardVal === 0 ? "text-neutral-300 hover:text-neutral-400" : "num-positive hover:text-success",
                                    dynamicPadding
                                  )}
                                  onClick={() => inwardVal !== 0 && openMovementModal("inward", b.yearMonth)}
                                  title={inwardVal !== 0 ? "Click to view inward transactions" : "No inward movements"}
                                >{toDisplay(item, b.inwardsBase, unitMode).formatted}</td>
                                <td
                                  className={clsx("table-cell-mono cursor-pointer hover:underline transition-colors duration-150",
                                    outwardVal === 0 ? "text-neutral-300 hover:text-neutral-400" : "num-negative hover:text-danger",
                                    dynamicPadding
                                  )}
                                  onClick={() => outwardVal !== 0 && openMovementModal("outward", b.yearMonth)}
                                  title={outwardVal !== 0 ? "Click to view outward transactions" : "No outward movements"}
                                >{toDisplay(item, b.outwardsBase, unitMode).formatted}</td>
                                <td className={clsx("table-cell-mono font-bold text-accent", dynamicPadding)}>{toDisplay(item, b.closingQtyBase, unitMode).formatted}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}

              {/* Chart Toggle + Data Span Control */}
              {focusedItem && focusedMonthlyBuckets.length > 0 && (() => {
                const item = focusedItem; // Capture in const to ensure non-null type
                return (
                  <div className="section-card !p-0 overflow-hidden">
                    <div className="section-card-header hover:bg-white/50 transition-colors duration-150">
                      <button
                        onClick={() => setShowChart(!showChart)}
                        className="flex items-center gap-1.5 text-sm font-medium text-neutral-900 hover:text-accent transition-colors duration-150"
                      >
                        <BarChart3 size={16} />
                        {monthSpan}-Month History
                      </button>
                      <div className="flex items-center gap-2">
                        <label className="label-text">Show:</label>
                        <select
                          value={monthSpan}
                          onChange={(e) => setMonthSpan(parseInt(e.target.value))}
                          className="form-select text-xs py-1 pl-2 min-h-0"
                        >
                          {[3, 6, 8, 12, 24].map((m) => (
                            <option key={m} value={m}>{m} mo</option>
                          ))}
                        </select>
                        {showChart ? <ChevronUp size={16} className="text-neutral-500" /> : <ChevronDown size={16} className="text-neutral-500" />}
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
                            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                            <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
                            <YAxis tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
                            <Tooltip
                              contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, boxShadow: "0 4px 12px rgb(0 0 0 / 0.08)", fontSize: 13 }}
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
                const orderDocs = movementModal.direction === "outward"
                  ? getItemOrderDocs(focusedItem, data?.vouchers ?? [], movementModal.month)
                  : [];
                const dirLabel = movementModal.direction === "inward" ? "Inward" : "Outward";
                const monthLabel = movementModal.month
                  ? new Date(Number(movementModal.month.split("-")[0]), Number(movementModal.month.split("-")[1]) - 1, 1)
                      .toLocaleString("en-IN", { month: "short", year: "2-digit" })
                  : "All";
                const activeRows: MovementRecord[] = modalTab === "actual" ? movements : orderDocs;

                const MovementTable = ({ rows }: { rows: MovementRecord[] }) => rows.length === 0 ? (
                  <div className="text-center text-neutral-500 text-sm py-8">
                    {modalTab === "actual" ? `No ${dirLabel.toLowerCase()} transactions found` : "No sales orders or quotations found"}
                  </div>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-white">
                      <tr className="border-b border-neutral-200">
                        <th className="table-header">Date</th>
                        <th className="table-header">Voucher</th>
                        <th className="table-header">Type</th>
                        <th className="table-header">Party</th>
                        <th className="table-header-sticky text-right">Qty</th>
                        <th className="table-header-sticky text-right">Rate</th>
                        <th className="table-header-sticky text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((m, i) => (
                        <tr key={`${m.voucherId}-${i}`} className="responsive-table-row">
                          <td className="table-cell-muted">{m.date}</td>
                          <td className="table-cell-mono">{m.voucherNumber}</td>
                          <td className={clsx("table-cell-muted", m.voucherType === "Sales Order" && "text-blue-600 font-medium", m.voucherType === "Quotation" && "text-amber-600 font-medium")}>{m.voucherType}</td>
                          <td className="table-cell truncate max-w-[160px]" title={m.partyName}>{m.partyName}</td>
                          <td className="table-cell-mono table-cell-right">{fmtNum(m.qty)}</td>
                          <td className="table-cell-mono table-cell-right text-neutral-500">{m.rate > 0 ? fmtNum(m.rate) : "—"}</td>
                          <td className="table-cell-mono table-cell-right font-semibold">{fmtNum(m.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-neutral-200 bg-neutral-100/10">
                        <td colSpan={4} className="table-cell-emphasis">Total</td>
                        <td className="table-cell-mono table-cell-right font-bold">{fmtNum(rows.reduce((s, m) => s + m.qty, 0))}</td>
                        <td className="table-cell"></td>
                        <td className="table-cell-mono table-cell-right font-bold">{fmtNum(rows.reduce((s, m) => s + m.amount, 0))}</td>
                      </tr>
                    </tfoot>
                  </table>
                );

                return (
                  <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setMovementModal(null)}>
                    <div className={clsx("bento-card shadow-2xl flex flex-col", isMobile ? "w-full h-full rounded-none" : "w-[760px] max-h-[82vh]")} onClick={e => e.stopPropagation()}>
                      {/* Header */}
                      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-200">
                        <div>
                          <h3 className="card-title">{focusedItem.name} — {dirLabel} Details</h3>
                          <p className="metric-label mt-0.5">Month: {monthLabel}</p>
                        </div>
                        <button onClick={() => setMovementModal(null)} className="btn-icon"><X size={16} /></button>
                      </div>

                      {/* Tabs (only for outward direction) */}
                      {movementModal.direction === "outward" && (
                        <div className="flex border-b border-neutral-200 px-4 pt-2 gap-0">
                          <button
                            onClick={() => setModalTab("actual")}
                            className={clsx(
                              "px-4 py-2 text-xs font-semibold border-b-2 transition-colors -mb-px",
                              modalTab === "actual"
                                ? "border-accent text-accent"
                                : "border-transparent text-neutral-500 hover:text-neutral-800"
                            )}
                          >
                            Dispatched / Billed
                            <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-neutral-100 text-neutral-600 text-[10px] font-semibold">{movements.length}</span>
                          </button>
                          <button
                            onClick={() => setModalTab("orders")}
                            className={clsx(
                              "px-4 py-2 text-xs font-semibold border-b-2 transition-colors -mb-px",
                              modalTab === "orders"
                                ? "border-accent text-accent"
                                : "border-transparent text-neutral-500 hover:text-neutral-800"
                            )}
                          >
                            Orders & Quotes
                            {orderDocs.length > 0 && (
                              <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 text-[10px] font-semibold">{orderDocs.length}</span>
                            )}
                          </button>
                        </div>
                      )}

                      <div className="overflow-y-auto flex-1">
                        <MovementTable rows={activeRows} />
                      </div>
                    </div>
                  </div>
                );
              })()}

            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-neutral-500 text-sm">
              Select an item from the list
            </div>
          )}
        </div>

        {/* RIGHT: Order Entry (All Items) — Virtualized */}
        <div className={clsx(
          "flex flex-col border-neutral-200 bg-white min-h-0",
          isMobile ? (mobileTab === "order" ? "flex-1" : "hidden") : "w-[28%] border-l"
        )}>
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-neutral-200">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-semibold text-neutral-900">Order</span>
              {orderLinesList.length > 0 && (
                <span className="text-xs font-semibold px-1.5 py-0.5 rounded-full bg-accent/10 text-accent tabular-nums leading-none">
                  {orderLinesList.length}
                </span>
              )}
            </div>
            <div className="flex items-center gap-0.5">
              <UnitToggle />
              <button onClick={exportXLSX} className="btn-icon" title="Export Excel" aria-label="Export Excel"><Download size={13} /></button>
              <button onClick={clearAll} className="btn-icon text-danger hover:bg-danger/10" title="Clear all" aria-label="Clear order"><Trash2 size={13} /></button>
            </div>
          </div>
          <div className="sticky top-0 bg-white border-b border-neutral-200 z-10">
            <div className="flex text-[10px] font-medium uppercase tracking-wide text-neutral-400">
              <div className="flex-1 px-3 py-1.5">Item</div>
              <div className="w-20 px-2 py-1.5 text-right">Qty</div>
            </div>
          </div>
              <div ref={orderPanelRef} className="flex-1 overflow-y-auto min-h-0 overflow-x-hidden">
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
                          "flex items-center border-b border-neutral-100 transition-colors duration-100",
                          focusedItemId === item.itemId
                            ? "bg-accent/10"
                            : hasOrder
                              ? "bg-accent/[0.03] hover:bg-accent/[0.06]"
                              : "hover:bg-neutral-50"
                        )}
                      >
                        <div
                          className={clsx(
                            "flex-1 px-3 py-1.5 text-xs truncate leading-none",
                            hasOrder ? "text-neutral-800 font-medium" : "text-neutral-400"
                          )}
                          title={item.name}
                        >
                          {item.name}
                        </div>
                        <div className="w-20 px-2 py-1">
                          <input
                            ref={(el) => { orderInputRefs.current[item.itemId] = el; }}
                            type="text"
                            inputMode="decimal"
                            value={orderQtyValue || ""}
                            onChange={(e) => { updateOrderLine(item.itemId, e.target.value); }}
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
                            placeholder="—"
                            className={clsx(
                              "w-full rounded-md px-2 py-1 tabular-nums text-xs text-center outline-none transition-all duration-150",
                              hasOrder
                                ? "bg-accent/10 border border-accent/30 text-accent font-bold focus:border-accent focus:bg-accent/15"
                                : "bg-transparent border border-transparent text-neutral-500 focus:bg-neutral-50 focus:border-neutral-200"
                            )}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
          {orderLinesList.length > 0 && (
            <div className="flex items-center justify-between px-3 py-2 border-t border-neutral-200 bg-neutral-50 flex-shrink-0">
              <span className="text-xs text-neutral-500 tabular-nums">
                <span className="font-semibold text-accent">{orderLinesList.length}</span> items ordered
              </span>
              <button onClick={exportXLSX} className="btn-accent-ghost btn-sm text-xs gap-1">
                <Download size={11} />Export
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
