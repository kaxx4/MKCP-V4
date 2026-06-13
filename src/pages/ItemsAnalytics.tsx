import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Package, TrendingUp, Percent, Truck, Upload, Search,
} from "lucide-react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, Legend,
} from "recharts";
import clsx from "clsx";
import { useDataStore } from "../store/dataStore";
import { useUIStore } from "../store/uiStore";
import {
  computeItemTurnover, getMonthRange, getMonthLabel,
  type ItemTurnoverData, type VoucherIndex,
} from "../engine/inventory";
import { computeItemMargins, type ItemMarginData } from "../engine/financial";
import { toDisplay } from "../engine/unitEngine";
import { fmtINR, fmtNum } from "../utils/format";
import type { CanonicalItem } from "../types/canonical";

const CHART_COLORS = {
  grid: "#e5e5ea",
  tick: "#a1a1a6",
  sale: "#2563eb",
  purchase: "#f97316",
  opening: "#16a34a",
};

const CHART_TOOLTIP_STYLE = {
  contentStyle: { background: "#ffffff", border: "1px solid #e5e5ea", borderRadius: 12, boxShadow: "0 4px 12px rgb(0 0 0 / 0.08)", fontSize: 13, fontFamily: "Inter, -apple-system, sans-serif" },
  labelStyle: { color: "#1d1d1f", fontWeight: 600, marginBottom: 4 },
};

type Tab = "items" | "price" | "margins" | "predicted";

const TABS: { id: Tab; label: string; icon: typeof Package }[] = [
  { id: "items", label: "Items", icon: Package },
  { id: "price", label: "Price Movement", icon: TrendingUp },
  { id: "margins", label: "Profit Margins", icon: Percent },
  { id: "predicted", label: "Predicted Orders", icon: Truck },
];

const LEAD_TIME_MONTHS = 1.5;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Per-month weighted-average sale/purchase rate for one item (last nMonths). */
function computeItemRateSeries(item: CanonicalItem, voucherIndex: VoucherIndex, nMonths: number) {
  const months = getMonthRange(nMonths);
  const monthSet = new Set(months);
  const saleQty: Record<string, number> = {}, saleVal: Record<string, number> = {};
  const purQty: Record<string, number> = {}, purVal: Record<string, number> = {};

  for (const v of voucherIndex.get(item.itemId) ?? []) {
    const ym = v.date.slice(0, 7);
    if (!monthSet.has(ym)) continue;
    const isSale = v.voucherType === "Sales";
    const isPurchase = v.voucherType === "Purchase";
    if (!isSale && !isPurchase) continue;
    for (const line of v.lines) {
      if (line.type !== "inventory" || line.itemId !== item.itemId) continue;
      const q = line.qtyBase ?? 0;
      const a = line.lineAmount ?? 0;
      if (q <= 0) continue;
      if (isSale) { saleQty[ym] = (saleQty[ym] ?? 0) + q; saleVal[ym] = (saleVal[ym] ?? 0) + a; }
      else { purQty[ym] = (purQty[ym] ?? 0) + q; purVal[ym] = (purVal[ym] ?? 0) + a; }
    }
  }

  return months.map((ym) => ({
    label: getMonthLabel(ym),
    sale: saleQty[ym] ? round2(saleVal[ym] / saleQty[ym]) : null,
    purchase: purQty[ym] ? round2(purVal[ym] / purQty[ym]) : null,
  }));
}

export default function ItemsAnalytics() {
  const navigate = useNavigate();
  const data = useDataStore((s) => s.data);
  const voucherIndex = useDataStore((s) => s.voucherIndex);
  const stockMap = useDataStore((s) => s.stockMap);
  const itemMargins = useDataStore((s) => s.itemMargins);
  const { unitMode, isMobile } = useUIStore();

  const [tab, setTab] = useState<Tab>("items");
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("ALL");

  // ── Derived data (memoized; heavy single-pass engines) ──
  const turnoverMap = useMemo(() => {
    if (!data) return new Map<string, ItemTurnoverData>();
    return new Map(computeItemTurnover(data.items, data.vouchers).map((t) => [t.itemId, t]));
  }, [data]);

  const marginsMap = useMemo(() => {
    if (itemMargins && itemMargins.size) return itemMargins;
    if (!data) return new Map<string, ItemMarginData>();
    return new Map(computeItemMargins(data.items, data.vouchers).map((m) => [m.itemId, m]));
  }, [itemMargins, data]);

  const groups = useMemo(() => {
    if (!data) return [];
    const set = new Set<string>();
    for (const item of data.items.values()) if (item.group) set.add(item.group);
    return Array.from(set).sort();
  }, [data]);

  const items = useMemo(() => {
    if (!data) return [];
    const q = search.toLowerCase();
    return Array.from(data.items.values())
      .filter((it) => (groupFilter === "ALL" || it.group === groupFilter))
      .filter((it) => !q || it.name.toLowerCase().includes(q) || it.itemId.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data, search, groupFilter]);

  if (!data) {
    return (
      <div className="empty-state">
        <Package size={64} className="empty-state-icon" />
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
        <h1 className="page-title">Items &amp; Analytics</h1>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-1.5">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={clsx("filter-chip flex items-center gap-1.5", tab === id && "filter-chip-active")}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {/* Shared search + group filter (Items, Margins, Predicted) */}
      {tab !== "price" && (
        <div className="flex flex-wrap gap-2 md:gap-3 bento-card">
          <div className="flex-1 min-w-[140px] md:min-w-[220px] relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search item name"
              className="search-input w-full pl-8"
            />
          </div>
          <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} className="form-input">
            <option value="ALL">All groups</option>
            {groups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          <div className="text-xs text-muted self-center ml-auto">{items.length} items</div>
        </div>
      )}

      {tab === "items" && (
        <ItemsTab items={items} turnoverMap={turnoverMap} marginsMap={marginsMap} stockMap={stockMap} unitMode={unitMode} isMobile={isMobile} />
      )}
      {tab === "price" && (
        <PriceMovementTab allItems={Array.from(data.items.values())} voucherIndex={voucherIndex} turnoverMap={turnoverMap} />
      )}
      {tab === "margins" && (
        <MarginsTab items={items} marginsMap={marginsMap} />
      )}
      {tab === "predicted" && (
        <PredictedTab items={items} turnoverMap={turnoverMap} stockMap={stockMap} unitMode={unitMode} />
      )}
    </div>
  );
}

/* ─── Velocity badge ──────────────────────────────────── */
function velocityBadge(cls?: ItemTurnoverData["classification"]) {
  if (!cls) return <span className="badge badge-muted">—</span>;
  const map: Record<string, string> = {
    fast: "badge-success",
    moderate: "badge-info",
    slow: "badge-warn",
    dead: "badge-danger",
  };
  return <span className={clsx("badge", map[cls])}>{cls}</span>;
}

/* ─── Tab 1: Items ────────────────────────────────────── */
function ItemsTab({ items, turnoverMap, marginsMap, stockMap, unitMode, isMobile }: {
  items: CanonicalItem[];
  turnoverMap: Map<string, ItemTurnoverData>;
  marginsMap: Map<string, ItemMarginData>;
  stockMap: Map<string, number>;
  unitMode: "BASE" | "PKG";
  isMobile: boolean;
}) {
  const rows = items.slice(0, 500);
  return (
    <div className="section-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm" style={{ minWidth: isMobile ? "640px" : undefined }}>
          <thead>
            <tr className="table-header">
              <th className="px-4 py-3 text-left">Item</th>
              <th className="px-4 py-3 text-left">Group</th>
              <th className="px-4 py-3 text-right whitespace-nowrap">Stock</th>
              <th className="px-4 py-3 text-right whitespace-nowrap">Avg / mo (out)</th>
              <th className="px-4 py-3 text-center">Velocity</th>
              <th className="px-4 py-3 text-right whitespace-nowrap">Avg Sale ₹</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((it) => {
              const stock = stockMap.get(it.itemId) ?? 0;
              const t = turnoverMap.get(it.itemId);
              const m = marginsMap.get(it.itemId);
              const stockDisp = toDisplay(it, stock, unitMode);
              const avgOut = t?.avgMonthlyOutward ?? 0;
              return (
                <tr key={it.itemId} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50/50">
                  <td className="px-4 py-2.5 font-medium text-neutral-900 max-w-xs">
                    <span title={it.name} className="block truncate">{it.name}</span>
                  </td>
                  <td className="px-4 py-2.5 text-neutral-500 max-w-[160px]">
                    <span className="block truncate">{it.group}</span>
                  </td>
                  <td className={clsx("px-4 py-2.5 text-right tabular-nums whitespace-nowrap", stock <= 0 ? "text-danger" : "text-neutral-900")}>
                    {stockDisp.formatted}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-neutral-700 whitespace-nowrap">
                    {fmtNum(round2(avgOut))} {it.baseUnit}
                  </td>
                  <td className="px-4 py-2.5 text-center">{velocityBadge(t?.classification)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-neutral-700 whitespace-nowrap">
                    {m && m.avgSalesRate > 0 ? fmtINR(m.avgSalesRate) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {items.length > 500 && (
        <div className="caption-text text-center py-2">Showing first 500 of {items.length} items — refine the search.</div>
      )}
      {items.length === 0 && (
        <div className="empty-state"><span className="empty-state-description">No items match.</span></div>
      )}
    </div>
  );
}

/* ─── Tab 2: Price Movement ───────────────────────────── */
function PriceMovementTab({ allItems, voucherIndex, turnoverMap }: {
  allItems: CanonicalItem[];
  voucherIndex: VoucherIndex;
  turnoverMap: Map<string, ItemTurnoverData>;
}) {
  const [months, setMonths] = useState(12);
  const [search, setSearch] = useState("");

  // Items that actually have transaction history, busiest first.
  const tradedItems = useMemo(() => {
    return allItems
      .filter((it) => (turnoverMap.get(it.itemId)?.totalOutwardQty ?? 0) > 0 || voucherIndex.has(it.itemId))
      .sort((a, b) => (turnoverMap.get(b.itemId)?.avgMonthlyOutward ?? 0) - (turnoverMap.get(a.itemId)?.avgMonthlyOutward ?? 0));
  }, [allItems, voucherIndex, turnoverMap]);

  const [selectedId, setSelectedId] = useState<string>(() => tradedItems[0]?.itemId ?? "");
  const selectedItem = useMemo(() => allItems.find((it) => it.itemId === selectedId) ?? null, [allItems, selectedId]);

  const filteredOptions = useMemo(() => {
    const q = search.toLowerCase();
    const base = tradedItems.filter((it) => !q || it.name.toLowerCase().includes(q)).slice(0, 200);
    // Always keep the currently-selected item in the option list, even when the search
    // filters it out — otherwise the controlled <select> holds a value with no matching
    // option (blank/invalid) and the chart would mismatch the box.
    if (selectedId && !base.some((it) => it.itemId === selectedId)) {
      const sel = tradedItems.find((it) => it.itemId === selectedId);
      if (sel) return [sel, ...base];
    }
    return base;
  }, [tradedItems, search, selectedId]);

  const series = useMemo(() => {
    if (!selectedItem) return [];
    return computeItemRateSeries(selectedItem, voucherIndex, months);
  }, [selectedItem, voucherIndex, months]);

  const hasData = series.some((p) => p.sale !== null || p.purchase !== null);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 md:gap-3 bento-card">
        <div className="flex-1 min-w-[160px] md:min-w-[240px] relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter items…"
            className="search-input w-full pl-8"
          />
        </div>
        <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} className="form-input flex-1 min-w-[200px]">
          {filteredOptions.map((it) => <option key={it.itemId} value={it.itemId}>{it.name}</option>)}
          {filteredOptions.length === 0 && <option value="">No matching items</option>}
        </select>
        <div className="flex gap-1">
          {[6, 12, 24].map((n) => (
            <button key={n} onClick={() => setMonths(n)} className={clsx("filter-chip", months === n && "filter-chip-active")}>
              {n}m
            </button>
          ))}
        </div>
      </div>

      <div className="bento-card">
        {selectedItem ? (
          <>
            <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
              <h3 className="text-base font-bold text-neutral-900 truncate">{selectedItem.name}</h3>
              <span className="text-xs text-neutral-500">
                Opening rate {fmtINR(selectedItem.openingRate)} / {selectedItem.baseUnit}
              </span>
            </div>
            {hasData ? (
              <ResponsiveContainer width="100%" height={340}>
                <LineChart data={series} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 12, fill: CHART_COLORS.tick }} />
                  <YAxis tick={{ fontSize: 12, fill: CHART_COLORS.tick }} width={64}
                    tickFormatter={(v) => `₹${v}`} />
                  <Tooltip {...CHART_TOOLTIP_STYLE} formatter={(v: any) => v == null ? "—" : fmtINR(Number(v))} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {selectedItem.openingRate > 0 && (
                    <ReferenceLine y={selectedItem.openingRate} stroke={CHART_COLORS.opening} strokeDasharray="4 4"
                      label={{ value: "Opening", fontSize: 10, fill: CHART_COLORS.opening, position: "insideTopRight" }} />
                  )}
                  <Line type="monotone" dataKey="sale" name="Avg Sale Rate" stroke={CHART_COLORS.sale} strokeWidth={2} dot={{ r: 3 }} connectNulls />
                  <Line type="monotone" dataKey="purchase" name="Avg Purchase Rate" stroke={CHART_COLORS.purchase} strokeWidth={2} dot={{ r: 3 }} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="empty-state py-10">
                <TrendingUp size={32} className="text-neutral-300 mx-auto mb-2" />
                <span className="empty-state-description">No sale/purchase transactions in the last {months} months.</span>
              </div>
            )}
            <p className="text-xs text-neutral-500 mt-2">
              Monthly weighted-average rate (line amount ÷ quantity). Gaps = no transactions that month.
            </p>
          </>
        ) : (
          <div className="empty-state py-10"><span className="empty-state-description">Select an item to view its price movement.</span></div>
        )}
      </div>
    </div>
  );
}

/* ─── Tab 3: Profit Margins ───────────────────────────── */
function MarginsTab({ items, marginsMap }: {
  items: CanonicalItem[];
  marginsMap: Map<string, ItemMarginData>;
}) {
  const rows = useMemo(() => {
    return items
      .map((it) => marginsMap.get(it.itemId))
      .filter((m): m is ItemMarginData => !!m && (m.totalSalesQty > 0 || m.totalPurchaseQty > 0))
      .sort((a, b) => b.marginPct - a.marginPct);
  }, [items, marginsMap]);

  function marginTone(pct: number) {
    if (pct >= 40) return "text-success font-bold";
    if (pct < 5) return "text-danger font-semibold";
    return "text-neutral-900";
  }

  return (
    <div className="section-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm" style={{ minWidth: "720px" }}>
          <thead>
            <tr className="table-header">
              <th className="px-4 py-3 text-left">Item</th>
              <th className="px-4 py-3 text-right whitespace-nowrap">Avg Purchase ₹</th>
              <th className="px-4 py-3 text-right whitespace-nowrap">Avg Sale ₹</th>
              <th className="px-4 py-3 text-right whitespace-nowrap">Margin / unit</th>
              <th className="px-4 py-3 text-right whitespace-nowrap">Margin %</th>
              <th className="px-4 py-3 text-right whitespace-nowrap">Est. Profit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.itemId} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50/50">
                <td className="px-4 py-2.5 font-medium text-neutral-900 max-w-xs">
                  <span title={m.name} className="block truncate">{m.name}</span>
                  {m.hasNoPurchases && <span className="ml-1 text-2xs text-amber-600" title="No purchases — cost estimated from opening rate">est. cost</span>}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-neutral-700 whitespace-nowrap">{m.avgPurchaseRate > 0 ? fmtINR(m.avgPurchaseRate) : "—"}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-neutral-700 whitespace-nowrap">{m.avgSalesRate > 0 ? fmtINR(m.avgSalesRate) : "—"}</td>
                <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap">{fmtINR(m.marginPerUnit)}</td>
                <td className={clsx("px-4 py-2.5 text-right tabular-nums whitespace-nowrap", marginTone(m.marginPct))}>{round2(m.marginPct)}%</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-neutral-700 whitespace-nowrap">{fmtINR(m.totalProfit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <div className="empty-state"><span className="empty-state-description">No sales/purchase history for these items.</span></div>
      )}
    </div>
  );
}

/* ─── Tab 4: Predicted Orders ─────────────────────────── */
interface PredictRow {
  item: CanonicalItem;
  currentStock: number;
  avgOut: number;
  suggested: number;
  daysOfStock: number;
}

function PredictedTab({ items, turnoverMap, stockMap, unitMode }: {
  items: CanonicalItem[];
  turnoverMap: Map<string, ItemTurnoverData>;
  stockMap: Map<string, number>;
  unitMode: "BASE" | "PKG";
}) {
  const rows = useMemo<PredictRow[]>(() => {
    return items
      .map((item) => {
        const currentStock = stockMap.get(item.itemId) ?? 0;
        const avgOut = turnoverMap.get(item.itemId)?.avgMonthlyOutward ?? 0;
        const suggested = Math.max(Math.ceil(avgOut * LEAD_TIME_MONTHS - currentStock), 0);
        const daysOfStock = avgOut > 0 ? (currentStock / (avgOut / 30)) : Infinity;
        return { item, currentStock, avgOut, suggested, daysOfStock };
      })
      .filter((r) => r.avgOut > 0) // only items with demand
      .sort((a, b) => a.daysOfStock - b.daysOfStock);
  }, [items, turnoverMap, stockMap]);

  function urgency(days: number): { label: string; cls: string } {
    if (days < 7) return { label: "Critical", cls: "badge-danger" };
    if (days < 14) return { label: "Reorder", cls: "badge-warn" };
    if (days < 30) return { label: "Watch", cls: "badge-info" };
    return { label: "OK", cls: "badge-success" };
  }

  return (
    <div className="section-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm" style={{ minWidth: "720px" }}>
          <thead>
            <tr className="table-header">
              <th className="px-4 py-3 text-left">Item</th>
              <th className="px-4 py-3 text-right whitespace-nowrap">Current Stock</th>
              <th className="px-4 py-3 text-right whitespace-nowrap">Avg / mo (out)</th>
              <th className="px-4 py-3 text-right whitespace-nowrap">Days of Stock</th>
              <th className="px-4 py-3 text-right whitespace-nowrap">Suggested Reorder</th>
              <th className="px-4 py-3 text-center">Urgency</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ item, currentStock, avgOut, suggested, daysOfStock }) => {
              const u = urgency(daysOfStock);
              const stockDisp = toDisplay(item, currentStock, unitMode);
              const reorderDisp = toDisplay(item, suggested, unitMode);
              return (
                <tr key={item.itemId} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50/50">
                  <td className="px-4 py-2.5 font-medium text-neutral-900 max-w-xs">
                    <span title={item.name} className="block truncate">{item.name}</span>
                  </td>
                  <td className={clsx("px-4 py-2.5 text-right tabular-nums whitespace-nowrap", currentStock <= 0 ? "text-danger" : "text-neutral-900")}>
                    {stockDisp.formatted}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-neutral-700 whitespace-nowrap">
                    {fmtNum(round2(avgOut))} {item.baseUnit}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-neutral-700 whitespace-nowrap">
                    {daysOfStock === Infinity ? "∞" : `${Math.round(daysOfStock)}d`}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-neutral-900 whitespace-nowrap">
                    {suggested > 0 ? reorderDisp.formatted : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-center"><span className={clsx("badge", u.cls)}>{u.label}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <div className="empty-state"><span className="empty-state-description">No items with recent demand.</span></div>
      )}
      <div className="caption-text px-4 py-2">
        Suggested reorder = max(0, avg monthly outward × {LEAD_TIME_MONTHS} − current stock). Based on last 3 months of demand.
      </div>
    </div>
  );
}
