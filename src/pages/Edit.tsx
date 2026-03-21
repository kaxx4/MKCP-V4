import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Save, RotateCcw, Upload, Package } from "lucide-react";
import Fuse from "fuse.js";
import { useDataStore } from "../store/dataStore";
import { useOverrideStore } from "../store/overrideStore";
import { fmtNum } from "../utils/format";
import type { CanonicalItem } from "../types/canonical";
import clsx from "clsx";

interface EditRow {
  itemId: string;
  name: string;
  group: string;
  baseUnit: string;
  pkgUnit: string;
  unitsPerPkg: number;
  dirty: boolean;
}

export default function Edit() {
  const navigate = useNavigate();
  const { data, setData } = useDataStore();
  const { setUnitOverride } = useOverrideStore();

  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("ALL");
  const [rows, setRows] = useState<Record<string, EditRow>>({});

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

  const filteredItems = useMemo(() => {
    let result = allItems;
    if (groupFilter !== "ALL") result = result.filter((i) => i.group === groupFilter);
    if (search.trim()) {
      const ids = new Set(fuse.search(search.trim()).map((r) => r.item.itemId));
      result = result.filter((i) => ids.has(i.itemId));
    }
    return result;
  }, [allItems, search, groupFilter, fuse]);

  function getRow(item: CanonicalItem): EditRow {
    if (rows[item.itemId]) return rows[item.itemId];
    return {
      itemId: item.itemId,
      name: item.name,
      group: item.group,
      baseUnit: item.baseUnit,
      pkgUnit: item.pkgUnit ?? "",
      unitsPerPkg: item.unitsPerPkg,
      dirty: false,
    };
  }

  function updateRow(itemId: string, field: keyof EditRow, value: string | number) {
    const item = data?.items.get(itemId);
    if (!item) return;
    const current = getRow(item);
    setRows((prev) => ({
      ...prev,
      [itemId]: { ...current, [field]: value, dirty: true },
    }));
  }

  const dirtyCount = Object.values(rows).filter((r) => r.dirty).length;

  function saveAll() {
    if (!data) return;
    const newItems = new Map(data.items);

    for (const row of Object.values(rows)) {
      if (!row.dirty) continue;
      const existing = newItems.get(row.itemId);
      if (!existing) continue;

      const pkgUnit = row.pkgUnit.trim() || null;
      const unitsPerPkg = pkgUnit ? Math.max(1, row.unitsPerPkg) : 1;

      const updated: CanonicalItem = {
        ...existing,
        baseUnit: row.baseUnit.trim() || existing.baseUnit,
        pkgUnit,
        unitsPerPkg,
      };
      newItems.set(row.itemId, updated);

      setUnitOverride(row.itemId, {
        itemId: row.itemId,
        pkgUnit: pkgUnit ?? "",
        unitsPerPkg,
        source: "manual",
        confidence: 1,
        updatedAt: new Date().toISOString(),
      });
    }

    setData({ ...data, items: newItems });
    setRows({});
  }

  function resetAll() {
    setRows({});
  }

  if (!data) {
    return (
      <div className="empty-state">
        <Package size={64} className="empty-state-icon" />
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

  return (
    <div className="flex flex-col h-[calc(100vh-112px)] gap-3">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <h1 className="page-title">Edit Units</h1>
        <div className="flex items-center gap-2">
          {dirtyCount > 0 && (
            <>
              <span className="caption-text text-warn tabular-nums">{dirtyCount} unsaved</span>
              <button
                onClick={resetAll}
                className="btn-secondary btn-sm"
              >
                <RotateCcw size={12} />
                Reset
              </button>
              <button
                onClick={saveAll}
                className="btn-primary btn-sm"
              >
                <Save size={12} />
                Save All
              </button>
            </>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2">
        <div className="flex-1">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search items…"
            className="search-input w-full"
          />
        </div>
        <select
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
          className="form-select"
        >
          {groups.map((g) => (
            <option key={g} value={g}>{g === "ALL" ? "All Groups" : g}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto section-card">
        <table className="w-full text-sm min-w-[540px]">
          <thead className="table-header-sticky">
            <tr className="border-b border-bg-border">
              <th className="table-header text-left">Item</th>
              <th className="table-header text-left">Group</th>
              <th className="table-header text-left w-24">Base Unit</th>
              <th className="table-header text-left w-24">Pkg Unit</th>
              <th className="table-header text-left w-28">Units/Pkg</th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.map((item) => {
              const row = getRow(item);
              return (
                <tr
                  key={item.itemId}
                  className={clsx(
                    "responsive-table-row",
                    row.dirty ? "bg-accent/5" : ""
                  )}
                >
                  <td className="table-cell-emphasis truncate max-w-[250px]">{item.name}</td>
                  <td className="table-cell text-muted truncate max-w-[180px]">{item.group}</td>
                  <td className="table-cell">
                    <input
                      value={row.baseUnit}
                      onChange={(e) => updateRow(item.itemId, "baseUnit", e.target.value.toUpperCase())}
                      className="form-input tabular-nums text-xs"
                    />
                  </td>
                  <td className="table-cell">
                    <input
                      value={row.pkgUnit}
                      onChange={(e) => updateRow(item.itemId, "pkgUnit", e.target.value.toUpperCase())}
                      placeholder="—"
                      className="form-input tabular-nums text-xs"
                    />
                  </td>
                  <td className="table-cell">
                    <input
                      type="number"
                      min={1}
                      value={row.unitsPerPkg}
                      onChange={(e) => updateRow(item.itemId, "unitsPerPkg", parseInt(e.target.value) || 1)}
                      className="form-input tabular-nums text-xs"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
