import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Upload, Tag } from "lucide-react";
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
  source: "sales" | "closing" | "opening" | "none";
}

export default function PriceList() {
  const navigate = useNavigate();
  const { data } = useDataStore();
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const rows = useMemo<PriceRow[]>(() => {
    if (!data) return [];
    const margins = computeItemMargins(data.items, data.vouchers);
    const marginMap = new Map(margins.map((m) => [m.itemId, m]));

    return Array.from(data.items.values()).map((item) => {
      const m = marginMap.get(item.itemId);

      // Priority: sales rate (from actual transactions) > closing rate > opening rate > none
      let displayRate = 0;
      let source: "sales" | "closing" | "opening" | "none" = "none";

      if (m && m.avgSalesRate > 0) {
        displayRate = m.avgSalesRate;
        source = "sales";
      } else if (item.closingRate && item.closingRate > 0) {
        displayRate = item.closingRate;
        source = "closing";
      } else if (item.openingRate && item.openingRate > 0) {
        displayRate = item.openingRate;
        source = "opening";
      }

      return { itemId: item.itemId, name: item.name, group: item.group, displayRate, source };
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

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  function sortIcon(key: SortKey) {
    if (sortKey !== key) return <span className="text-neutral-300">↕</span>;
    return <span className="text-accent">{sortDir === "asc" ? "↑" : "↓"}</span>;
  }

  if (!data) {
    return (
      <div className="empty-state">
        <Tag size={48} className="empty-state-icon" />
        <h2 className="empty-state-title">No Data Loaded</h2>
        <button onClick={() => navigate("/import")} className="btn-primary mt-2">
          <Upload size={14} /> Import Data
        </button>
      </div>
    );
  }

  const COL = "1fr 160px 120px";

  return (
    <div className="page-section">
      <div className="page-header">
        <h1 className="page-title">Dealer Price List</h1>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search items…"
          className="search-input flex-1 min-w-[180px]"
        />
        <select
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
          className="form-select"
        >
          {groups.map((g) => (
            <option key={g} value={g}>{g === "ALL" ? "All Groups" : g}</option>
          ))}
        </select>
        <span className="text-xs text-muted tabular-nums">{sorted.length} items</span>
      </div>

      {/* Table */}
      <div className="section-card overflow-hidden">
        {/* Header */}
        <div className="grid table-header-sticky text-xs" style={{ gridTemplateColumns: COL }}>
          <div
            className="px-3 py-2.5 cursor-pointer select-none flex items-center gap-1 hover:text-primary transition-colors"
            onClick={() => toggleSort("name")}
          >
            Item {sortIcon("name")}
          </div>
          <div
            className="px-3 py-2.5 cursor-pointer select-none flex items-center gap-1 hover:text-primary transition-colors"
            onClick={() => toggleSort("group")}
          >
            Group {sortIcon("group")}
          </div>
          <div
            className="px-3 py-2.5 text-right cursor-pointer select-none flex items-center justify-end gap-1 hover:text-primary transition-colors"
            onClick={() => toggleSort("baseRate")}
          >
            Rate {sortIcon("baseRate")}
          </div>
        </div>

        {/* Body */}
        <div className="overflow-y-auto" style={{ maxHeight: "calc(100vh - 260px)" }}>
          {sorted.length === 0 ? (
            <div className="empty-state py-10">
              <span className="empty-state-description">No items match your filters</span>
            </div>
          ) : (
            sorted.map((row) => (
              <div
                key={row.itemId}
                className="grid items-center border-b border-bg-border/50 last:border-0 hover:bg-neutral-50 transition-colors duration-100"
                style={{ gridTemplateColumns: COL }}
              >
                <div className="px-3 py-2 min-w-0">
                  <div className="text-sm font-medium text-primary truncate" title={row.name}>
                    {row.name}
                  </div>
                </div>
                <div className="px-3 py-2 text-xs text-muted truncate" title={row.group}>
                  {row.group}
                </div>
                <div className="px-3 py-2 text-right">
                  <div className={clsx(
                    "text-sm tabular-nums font-medium",
                    row.displayRate > 0 ? "text-primary" : "text-muted"
                  )}>
                    {row.displayRate > 0 ? fmtRate(row.displayRate) : "—"}
                  </div>
                  {row.displayRate > 0 && (
                    <div className={clsx(
                      "text-2xs mt-1",
                      row.source === "sales" && "text-success",
                      row.source === "closing" && "text-warn",
                      row.source === "opening" && "text-danger"
                    )}>
                      {row.source === "sales" && "from sales"}
                      {row.source === "closing" && "closing stock"}
                      {row.source === "opening" && "opening rate"}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
