import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Save, RotateCcw, Upload, Package } from "lucide-react";
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

  return (
    <div className="flex flex-col h-[calc(100vh-112px)] gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-primary">Edit Units</h1>
        <div className="flex items-center gap-2">
          {dirtyCount > 0 && (
            <>
              <span className="text-xs text-warn font-mono">{dirtyCount} unsaved</span>
              <button
                onClick={resetAll}
                className="flex items-center gap-1.5 text-xs bg-bg-border hover:bg-bg-border/70 text-muted hover:text-primary px-3 py-1.5 rounded-lg transition"
              >
                <RotateCcw size={12} />
                Reset
              </button>
              <button
                onClick={saveAll}
                className="flex items-center gap-1.5 text-xs bg-accent hover:bg-accent-hover text-white px-3 py-1.5 rounded-lg transition"
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
        <div className="relative flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search items…"
            className="w-full bg-bg-card border border-bg-border rounded-lg pl-8 pr-3 py-1.5 text-sm text-primary placeholder-muted focus:border-accent/60 outline-none"
          />
        </div>
        <select
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
          className="bg-bg-card border border-bg-border rounded-lg px-2 py-1.5 text-sm text-primary outline-none"
        >
          {groups.map((g) => (
            <option key={g} value={g}>{g === "ALL" ? "All Groups" : g}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto bg-bg-card border border-bg-border rounded-xl">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-bg-card z-10">
            <tr className="border-b border-bg-border">
              <th className="text-left text-muted px-3 py-2.5 font-medium">Item</th>
              <th className="text-left text-muted px-3 py-2.5 font-medium">Group</th>
              <th className="text-left text-muted px-3 py-2.5 font-medium w-24">Base Unit</th>
              <th className="text-left text-muted px-3 py-2.5 font-medium w-24">Pkg Unit</th>
              <th className="text-left text-muted px-3 py-2.5 font-medium w-28">Units/Pkg</th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.map((item) => {
              const row = getRow(item);
              return (
                <tr
                  key={item.itemId}
                  className={clsx(
                    "border-b border-bg-border/50 transition-colors",
                    row.dirty ? "bg-accent/5" : "hover:bg-bg-border/20"
                  )}
                >
                  <td className="px-3 py-2 text-primary truncate max-w-[250px]">{item.name}</td>
                  <td className="px-3 py-2 text-muted truncate max-w-[180px] text-xs">{item.group}</td>
                  <td className="px-3 py-2">
                    <input
                      value={row.baseUnit}
                      onChange={(e) => updateRow(item.itemId, "baseUnit", e.target.value.toUpperCase())}
                      className="w-full bg-bg border border-bg-border rounded px-2 py-1 text-primary font-mono text-xs outline-none focus:border-accent/60"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={row.pkgUnit}
                      onChange={(e) => updateRow(item.itemId, "pkgUnit", e.target.value.toUpperCase())}
                      placeholder="—"
                      className="w-full bg-bg border border-bg-border rounded px-2 py-1 text-primary font-mono text-xs outline-none focus:border-accent/60 placeholder-muted"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      min={1}
                      value={row.unitsPerPkg}
                      onChange={(e) => updateRow(item.itemId, "unitsPerPkg", parseInt(e.target.value) || 1)}
                      className="w-full bg-bg border border-bg-border rounded px-2 py-1 text-primary font-mono text-xs outline-none focus:border-accent/60"
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
