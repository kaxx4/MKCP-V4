import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Upload, Tag, ChevronDown, Search } from "lucide-react";
import clsx from "clsx";
import { useDataStore } from "../store/dataStore";
import { computeItemMargins } from "../engine/financial";
import { fmtRate } from "../utils/format";

type SortKey = "name" | "group" | "baseRate";
type SortDir = "asc" | "desc";

interface PriceRow {
  itemId: string;
  name: string;
  group: string;
  displayRate: number;
  source: "sales" | "closing" | "opening" | "tally-pricelist" | "none";
  dealerPrices?: Array<{ priceListName: string; dealerRate: number; dealerDiscount?: number }>;
}

export default function PriceList() {
  const navigate = useNavigate();
  const { data } = useDataStore();
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  const rows = useMemo<PriceRow[]>(() => {
    if (!data) return [];
    const margins = computeItemMargins(data.items, data.vouchers);
    const marginMap = new Map(margins.map((m) => [m.itemId, m]));

    return Array.from(data.items.values()).map((item) => {
      const m = marginMap.get(item.itemId);

      // Priority: sales rate > closing rate > opening rate > first Tally price list > none
      let displayRate = 0;
      let source: "sales" | "closing" | "opening" | "tally-pricelist" | "none" = "none";

      if (m && m.avgSalesRate > 0) {
        displayRate = m.avgSalesRate;
        source = "sales";
      } else if (item.closingRate && item.closingRate > 0) {
        displayRate = item.closingRate;
        source = "closing";
      } else if (item.openingRate && item.openingRate > 0) {
        displayRate = item.openingRate;
        source = "opening";
      } else if (item.dealerPrices && item.dealerPrices.length > 0) {
        // Use first Tally price list rate as fallback
        displayRate = item.dealerPrices[0].dealerRate;
        source = "tally-pricelist";
      }

      return {
        itemId: item.itemId,
        name: item.name,
        group: item.group,
        displayRate,
        source,
        dealerPrices: item.dealerPrices?.map(dp => ({
          priceListName: dp.priceListName,
          dealerRate: dp.dealerRate,
          dealerDiscount: dp.dealerDiscount,
        })),
      };
    });
  }, [data]);

  const groups = useMemo(() => {
    const gs = new Set(rows.map((r) => r.group));
    return ["ALL", ...Array.from(gs).sort()];
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return rows.filter((r) => {
      if (groupFilter !== "ALL" && r.group !== groupFilter) return false;
      if (q && !r.name.toLowerCase().includes(q) && !r.group.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, search, groupFilter]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "name") cmp = a.name.localeCompare(b.name);
      else if (sortKey === "group") cmp = a.group.localeCompare(b.group) || a.name.localeCompare(b.name);
      else if (sortKey === "baseRate") cmp = a.displayRate - b.displayRate;
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir]);

  // Calculate price source stats
  const stats = useMemo(() => {
    const counts = {
      total: rows.length,
      fromSales: rows.filter(r => r.source === "sales").length,
      fromClosing: rows.filter(r => r.source === "closing").length,
      fromOpening: rows.filter(r => r.source === "opening").length,
      fromTallyPriceLists: rows.filter(r => r.source === "tally-pricelist").length,
      withDealerPrices: rows.filter(r => (r.dealerPrices?.length ?? 0) > 0).length,
    };
    return counts;
  }, [rows]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  function sortIcon(key: SortKey) {
    if (sortKey !== key) return <span className="text-slate-300">↕</span>;
    return <span className="text-blue-600 font-bold">{sortDir === "asc" ? "↑" : "↓"}</span>;
  }

  function toggleExpanded(itemId: string) {
    const next = new Set(expandedItems);
    if (next.has(itemId)) next.delete(itemId);
    else next.add(itemId);
    setExpandedItems(next);
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] py-20">
        <Tag size={56} className="text-slate-300 mb-6" />
        <h2 className="text-2xl font-bold text-slate-900 mb-2">No Data Loaded</h2>
        <p className="text-slate-600 mb-6">Import your Tally data to view the price list</p>
        <button
          onClick={() => navigate("/import")}
          className="px-6 py-3 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2"
        >
          <Upload size={18} /> Import Data
        </button>
      </div>
    );
  }

  return (
    <div className="page-section">
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-slate-900 mb-1">Dealer Price List</h1>
        <p className="text-slate-600">Manage and view all item pricing across dealer price lists</p>
      </div>

      {/* Stats Section */}
      {stats.total > 0 && (
        <div className="mb-8 grid grid-cols-2 md:grid-cols-6 gap-3">
          <div className="bg-white rounded-lg p-4 border border-slate-200 shadow-sm">
            <div className="text-2xs font-bold text-slate-600 uppercase mb-1">Total</div>
            <div className="text-2xl font-bold text-slate-900">{stats.total}</div>
          </div>
          <div className="bg-green-50 rounded-lg p-4 border border-green-200 shadow-sm">
            <div className="text-2xs font-bold text-green-600 uppercase mb-1">Sales</div>
            <div className="text-2xl font-bold text-green-700">{stats.fromSales}</div>
          </div>
          <div className="bg-amber-50 rounded-lg p-4 border border-amber-200 shadow-sm">
            <div className="text-2xs font-bold text-amber-600 uppercase mb-1">Closing</div>
            <div className="text-2xl font-bold text-amber-700">{stats.fromClosing}</div>
          </div>
          <div className="bg-red-50 rounded-lg p-4 border border-red-200 shadow-sm">
            <div className="text-2xs font-bold text-red-600 uppercase mb-1">Opening</div>
            <div className="text-2xl font-bold text-red-700">{stats.fromOpening}</div>
          </div>
          <div className="bg-purple-50 rounded-lg p-4 border border-purple-200 shadow-sm">
            <div className="text-2xs font-bold text-purple-600 uppercase mb-1">Tally Price</div>
            <div className="text-2xl font-bold text-purple-700">{stats.fromTallyPriceLists}</div>
          </div>
          <div className="bg-blue-50 rounded-lg p-4 border border-blue-200 shadow-sm">
            <div className="text-2xs font-bold text-blue-600 uppercase mb-1">w/ Dealer</div>
            <div className="text-2xl font-bold text-blue-700">{stats.withDealerPrices}</div>
          </div>
        </div>
      )}

      {/* Filters Section */}
      <div className="mb-8 p-6 bg-white rounded-xl border border-slate-200 shadow-sm">
        <h2 className="text-sm font-bold text-slate-900 mb-4 uppercase tracking-wider">Filters & Search</h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Search Input */}
          <div className="md:col-span-2">
            <label htmlFor="search" className="block text-sm font-semibold text-slate-700 mb-2">
              Search Items
            </label>
            <div className="relative">
              <Search size={18} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                id="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by item name or group…"
                className="w-full pl-10 pr-4 py-3 text-base font-medium text-slate-900 placeholder-slate-500 border-2 border-slate-200 rounded-lg focus:border-blue-600 focus:outline-none transition-colors"
              />
            </div>
          </div>

          {/* Group Filter */}
          <div>
            <label htmlFor="group" className="block text-sm font-semibold text-slate-700 mb-2">
              Filter by Group
            </label>
            <select
              id="group"
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value)}
              className="w-full px-4 py-3 text-base font-medium text-slate-900 border-2 border-slate-200 rounded-lg focus:border-blue-600 focus:outline-none transition-colors cursor-pointer"
            >
              {groups.map((g) => (
                <option key={g} value={g}>
                  {g === "ALL" ? "All Groups" : g}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Results Summary */}
        <div className="mt-4 pt-4 border-t border-slate-200">
          <p className="text-sm font-semibold text-slate-700">
            <span className="text-blue-600 font-bold text-base">{sorted.length}</span> item{sorted.length !== 1 ? "s" : ""} found
          </p>
        </div>
      </div>

      {/* Table Section */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {/* Table Header */}
        <div className="grid text-sm font-bold text-slate-900 bg-slate-50 border-b-2 border-slate-200" style={{ gridTemplateColumns: "48px 1fr 160px 140px" }}>
          <div className="px-4 py-4"></div>
          <div
            className="px-4 py-4 cursor-pointer select-none flex items-center gap-2 hover:bg-slate-100 transition-colors"
            onClick={() => toggleSort("name")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") toggleSort("name");
            }}
            aria-sort={sortKey === "name" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
          >
            Item Name {sortIcon("name")}
          </div>
          <div
            className="px-4 py-4 cursor-pointer select-none flex items-center gap-2 hover:bg-slate-100 transition-colors"
            onClick={() => toggleSort("group")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") toggleSort("group");
            }}
            aria-sort={sortKey === "group" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
          >
            Group {sortIcon("group")}
          </div>
          <div
            className="px-4 py-4 text-right cursor-pointer select-none flex items-center justify-end gap-2 hover:bg-slate-100 transition-colors"
            onClick={() => toggleSort("baseRate")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") toggleSort("baseRate");
            }}
            aria-sort={sortKey === "baseRate" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
          >
            Base Rate {sortIcon("baseRate")}
          </div>
        </div>

        {/* Table Body */}
        <div className="overflow-y-auto" style={{ maxHeight: "calc(100vh - 340px)" }}>
          {sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-4">
              <Tag size={48} className="text-slate-300 mb-4" />
              <p className="text-lg font-semibold text-slate-600">No items match your filters</p>
              <p className="text-sm text-slate-500 mt-2">Try adjusting your search or group selection</p>
            </div>
          ) : (
            sorted.map((row, idx) => {
              const expanded = expandedItems.has(row.itemId);
              const hasDealerPrices = (row.dealerPrices?.length ?? 0) > 0;
              return (
                <div key={row.itemId} className={idx > 0 ? "border-t border-slate-100" : ""}>
                  {/* Main Row */}
                  <div
                    className="grid items-center px-4 py-4 hover:bg-blue-50 transition-colors duration-150"
                    style={{ gridTemplateColumns: "48px 1fr 160px 140px" }}
                  >
                    {/* Expand Button */}
                    <div className="flex justify-center">
                      {hasDealerPrices && (
                        <button
                          onClick={() => toggleExpanded(row.itemId)}
                          className="p-2 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
                          title={expanded ? "Collapse dealer prices" : "Expand to view dealer prices"}
                          aria-expanded={expanded}
                          aria-label={`${expanded ? "Collapse" : "Expand"} dealer prices for ${row.name}`}
                        >
                          <ChevronDown
                            size={18}
                            className={clsx(
                              "transition-transform text-slate-600",
                              expanded && "rotate-180"
                            )}
                          />
                        </button>
                      )}
                    </div>

                    {/* Item Name */}
                    <div className="px-2 min-w-0">
                      <div
                        className="text-base font-bold text-slate-900 truncate"
                        title={row.name}
                      >
                        {row.name}
                      </div>
                    </div>

                    {/* Group */}
                    <div className="px-2">
                      <span
                        className="inline-block px-3 py-1 bg-slate-100 text-slate-700 font-semibold text-sm rounded-full"
                        title={row.group}
                      >
                        {row.group}
                      </span>
                    </div>

                    {/* Rate */}
                    <div className="px-2 text-right">
                      <div className={clsx(
                        "text-lg font-bold tabular-nums",
                        row.displayRate > 0 ? "text-blue-600" : "text-slate-400"
                      )}>
                        {row.displayRate > 0 ? fmtRate(row.displayRate) : "—"}
                      </div>
                      {row.displayRate > 0 && (
                        <div className={clsx(
                          "text-xs font-semibold mt-1.5",
                          row.source === "sales" && "text-green-600 bg-green-50 px-2 py-1 rounded inline-block",
                          row.source === "closing" && "text-amber-600 bg-amber-50 px-2 py-1 rounded inline-block",
                          row.source === "opening" && "text-red-600 bg-red-50 px-2 py-1 rounded inline-block",
                          row.source === "tally-pricelist" && "text-purple-600 bg-purple-50 px-2 py-1 rounded inline-block"
                        )}>
                          {row.source === "sales" && "✓ From Sales"}
                          {row.source === "closing" && "• Closing Stock"}
                          {row.source === "opening" && "⚠ Opening Rate"}
                          {row.source === "tally-pricelist" && "📋 Tally Price List"}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Dealer Prices Expansion Panel */}
                  {expanded && hasDealerPrices && (
                    <div className="bg-blue-50 border-t border-blue-200 px-4 py-5 ml-12">
                      <h3 className="text-sm font-bold text-slate-900 mb-4 uppercase tracking-wider">Dealer Price Lists</h3>
                      <div className="space-y-3">
                        {row.dealerPrices?.map((dp) => (
                          <div
                            key={dp.priceListName}
                            className="flex items-center justify-between p-3 bg-white rounded-lg border border-blue-100"
                          >
                            <span className="font-semibold text-slate-900">{dp.priceListName}</span>
                            <div className="flex items-center gap-3">
                              <span className="font-bold text-blue-600 tabular-nums">{fmtRate(dp.dealerRate)}</span>
                              {dp.dealerDiscount && (
                                <span className="px-3 py-1 bg-red-100 text-red-700 font-bold text-sm rounded-full">
                                  -{dp.dealerDiscount}%
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
