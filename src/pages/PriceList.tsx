import { useState, useMemo, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Upload, Tag, ChevronDown, Search, FileUp, Trash2, RotateCcw } from "lucide-react";
import clsx from "clsx";
import { useDataStore } from "../store/dataStore";
import { fmtRate } from "../utils/format";
import { useTallyPriceListStore } from "../store/tallyPriceListStore";
import { useOverrideStore } from "../store/overrideStore";
import { parseTallyPriceListJson } from "../parser/tallyPriceListParser";
import { inferGstRatesFromVouchers } from "../utils/gstInference";

type SortKey = "name" | "group";
type SortDir = "asc" | "desc";

interface PriceRow {
  itemId: string;
  name: string;
  group: string;
  gstRate?: number;
  gstRateInferred: boolean;
  gstRateDefault: boolean;
  gstRateOverridden: boolean;     // user manually set this via the GST cell
  tallyRate?: number;
  tallyUnit?: string;
  tallyCostPrice?: number;
  dealerPrices?: Array<{ priceListName: string; dealerRate: number; dealerDiscount?: number }>;
}

export default function PriceList() {
  const navigate = useNavigate();
  const data = useDataStore((s) => s.data);
  const { entries: tallyEntries, importedAt, itemCount: tallyItemCount, setPriceList, clearPriceList } = useTallyPriceListStore();
  const gstOverrides = useOverrideStore((s) => s.gstRates);
  const setGstOverride = useOverrideStore((s) => s.setGstOverride);
  const removeGstOverride = useOverrideStore((s) => s.removeGstOverride);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  // Inline GST edit state: which item's GST cell is currently editing + the input draft
  const [editingGstId, setEditingGstId] = useState<string | null>(null);
  const [editingGstValue, setEditingGstValue] = useState<string>("");
  const gstInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus and select-all when entering edit mode
  useEffect(() => {
    if (editingGstId && gstInputRef.current) {
      gstInputRef.current.focus();
      gstInputRef.current.select();
    }
  }, [editingGstId]);

  function startGstEdit(itemId: string, currentPct: number) {
    setEditingGstId(itemId);
    setEditingGstValue(String(currentPct));
  }

  function commitGstEdit() {
    if (!editingGstId) return;
    const trimmed = editingGstValue.trim();
    if (trimmed === "") {
      setEditingGstId(null);
      return;
    }
    const pct = parseFloat(trimmed);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      // Invalid — just discard the edit and exit
      setEditingGstId(null);
      return;
    }
    setGstOverride(editingGstId, pct);
    setEditingGstId(null);
  }

  function cancelGstEdit() {
    setEditingGstId(null);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    setImporting(true);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const buffer = ev.target?.result as ArrayBuffer;
        const bytes = new Uint8Array(buffer);
        let encoding = "UTF-8";
        if (bytes[0] === 0xFF && bytes[1] === 0xFE) encoding = "UTF-16LE";
        else if (bytes[0] === 0xFE && bytes[1] === 0xFF) encoding = "UTF-16BE";
        const text = new TextDecoder(encoding).decode(buffer);
        const entries = parseTallyPriceListJson(text);
        if (entries.length === 0) {
          setImportError("No items with selling rates found in the file.");
        } else {
          setPriceList(entries, new Date().toISOString());
        }
      } catch (err) {
        setImportError((err as Error).message);
      } finally {
        setImporting(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    };
    reader.onerror = () => {
      setImportError("Failed to read file.");
      setImporting(false);
    };
    reader.readAsArrayBuffer(file);
  }

  // Dep narrowed to data?.vouchers so unrelated data field changes
  // (importedAt, sourceFiles, items map mutations from override edits)
  // don't trigger a full voucher scan to rebuild the GST inference map.
  const inferredGstRates = useMemo(
    () => (data ? inferGstRatesFromVouchers(data.vouchers) : new Map<string, number>()),
    [data?.vouchers]
  );

  const rows = useMemo<PriceRow[]>(() => {
    if (!data) return [];
    return Array.from(data.items.values()).map((item) => {
      const tallyEntry = tallyEntries[item.name.toUpperCase()];
      const override = gstOverrides[item.itemId];
      const masterGst = item.gstRate;
      const inferredGst = inferredGstRates.get(item.itemId);
      // Priority: user override > Tally master > voucher-inferred > default 5%
      const gstRate = override?.gstPct ?? masterGst ?? inferredGst ?? 5;
      const gstRateOverridden = override !== undefined;
      const gstRateInferred = !gstRateOverridden && masterGst === undefined && inferredGst !== undefined;
      const gstRateDefault = !gstRateOverridden && masterGst === undefined && inferredGst === undefined;
      return {
        itemId: item.itemId,
        name: item.name,
        group: item.group,
        gstRate,
        gstRateInferred,
        gstRateDefault,
        gstRateOverridden,
        tallyRate: tallyEntry?.sellingRate,
        tallyUnit: tallyEntry?.unit,
        tallyCostPrice: tallyEntry?.costPrice,
        dealerPrices: item.dealerPrices?.map(dp => ({
          priceListName: dp.priceListName,
          dealerRate: dp.dealerRate,
          dealerDiscount: dp.dealerDiscount,
        })),
      };
    });
  }, [data, tallyEntries, inferredGstRates, gstOverrides]);

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
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir]);

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

  const cols = tallyItemCount > 0 ? "48px 1fr 160px 80px 140px 150px" : "48px 1fr 160px 80px";

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
      <div className="mb-8 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="page-title mb-1">Dealer Price List</h1>
          <p className="text-slate-600">Manage and view all item pricing across dealer price lists</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={handleFileChange}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white font-semibold rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors text-sm"
            >
              <FileUp size={16} />
              {importing ? "Importing…" : "Import Tally Rates"}
            </button>
            {tallyItemCount > 0 && (
              <button
                onClick={clearPriceList}
                className="flex items-center gap-2 px-3 py-2 bg-red-100 text-red-700 font-semibold rounded-lg hover:bg-red-200 transition-colors text-sm min-h-10"
                title="Clear imported rates"
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
          {tallyItemCount > 0 && importedAt && (
            <p className="text-xs text-emerald-700 font-semibold">
              {tallyItemCount} rates loaded · {new Date(importedAt).toLocaleDateString()}
            </p>
          )}
          {importError && (
            <p className="text-xs text-red-600 font-semibold max-w-xs text-right">{importError}</p>
          )}
        </div>
      </div>

      {/* Filters Section */}
      <div className="mb-8 p-6 bg-white rounded-xl border border-slate-200 shadow-sm">
        <h2 className="text-sm font-bold text-slate-900 mb-4 uppercase tracking-wider">Filters & Search</h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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

        <div className="mt-4 pt-4 border-t border-slate-200">
          <p className="text-sm font-semibold text-slate-700">
            <span className="text-blue-600 font-bold text-base">{sorted.length}</span> item{sorted.length !== 1 ? "s" : ""} found
          </p>
        </div>
      </div>

      {/* Table Section */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {/* Table Header */}
        <div className="grid text-sm font-bold text-slate-900 bg-slate-50 border-b-2 border-slate-200" style={{ gridTemplateColumns: cols }}>
          <div className="px-4 py-4"></div>
          <div
            className="px-4 py-4 cursor-pointer select-none flex items-center gap-2 hover:bg-slate-100 transition-colors"
            onClick={() => toggleSort("name")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") toggleSort("name"); }}
            aria-sort={sortKey === "name" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
          >
            Item Name {sortIcon("name")}
          </div>
          <div
            className="px-4 py-4 cursor-pointer select-none flex items-center gap-2 hover:bg-slate-100 transition-colors"
            onClick={() => toggleSort("group")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") toggleSort("group"); }}
            aria-sort={sortKey === "group" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
          >
            Group {sortIcon("group")}
          </div>
          <div className="px-4 py-4 text-right text-orange-600">
            GST %
          </div>
          {tallyItemCount > 0 && (
            <div className="px-4 py-4 text-right text-emerald-700">
              Tally Rate
            </div>
          )}
          {tallyItemCount > 0 && (
            <div className="px-4 py-4 text-right text-purple-700">
              Price + GST
            </div>
          )}
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
                    style={{ gridTemplateColumns: cols }}
                  >
                    {/* Expand Button */}
                    <div className="flex justify-center">
                      {hasDealerPrices && (
                        <button
                          onClick={() => toggleExpanded(row.itemId)}
                          className="min-h-10 min-w-10 flex items-center justify-center hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
                          title={expanded ? "Collapse dealer prices" : "Expand to view dealer prices"}
                          aria-expanded={expanded}
                          aria-label={`${expanded ? "Collapse" : "Expand"} dealer prices for ${row.name}`}
                        >
                          <ChevronDown
                            size={18}
                            className={clsx("transition-transform text-slate-600", expanded && "rotate-180")}
                          />
                        </button>
                      )}
                    </div>

                    {/* Item Name */}
                    <div className="px-2 min-w-0">
                      <div className="text-base font-bold text-slate-900 truncate" title={row.name}>
                        {row.name}
                      </div>
                    </div>

                    {/* Group */}
                    <div className="px-2">
                      <span className="inline-block px-3 py-1 bg-slate-100 text-slate-700 font-semibold text-sm rounded-full" title={row.group}>
                        {row.group}
                      </span>
                    </div>

                    {/* GST Rate — click pill to edit, Enter to save, Esc to cancel */}
                    <div className="px-2 text-right">
                      {editingGstId === row.itemId ? (
                        <div className="inline-flex items-center gap-1">
                          <input
                            ref={gstInputRef}
                            type="number"
                            inputMode="decimal"
                            min={0}
                            max={100}
                            step={0.5}
                            value={editingGstValue}
                            onChange={(e) => setEditingGstValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") { e.preventDefault(); commitGstEdit(); }
                              else if (e.key === "Escape") { e.preventDefault(); cancelGstEdit(); }
                            }}
                            onBlur={commitGstEdit}
                            onClick={(e) => e.stopPropagation()}
                            className="w-16 px-2 py-0.5 text-sm font-bold tabular-nums text-right border-2 border-accent-500 rounded-md focus:outline-none focus:ring-2 focus:ring-accent-500/30 bg-white"
                            aria-label={`Edit GST rate for ${row.name}`}
                          />
                          <span className="text-sm font-bold text-slate-600">%</span>
                        </div>
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          {row.gstRateOverridden && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); removeGstOverride(row.itemId); }}
                              title="Reset to Tally master / inferred rate"
                              aria-label={`Reset GST override for ${row.name}`}
                              className="text-blue-500 hover:text-blue-700 transition-colors"
                            >
                              <RotateCcw size={12} strokeWidth={2.5} />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); startGstEdit(row.itemId, row.gstRate ?? 5); }}
                            title={
                              row.gstRateOverridden
                                ? `Manually set — click to edit (was ${row.gstRateInferred ? "inferred" : "from Tally master"})`
                                : row.gstRateDefault
                                  ? "Default 5% — click to set"
                                  : row.gstRateInferred
                                    ? "Rate inferred from past vouchers — click to override"
                                    : "Rate from Tally master — click to override"
                            }
                            className={clsx(
                              "inline-block px-2 py-0.5 font-bold text-sm rounded-full tabular-nums cursor-pointer transition-all active:scale-95 hover:ring-2 hover:ring-offset-1",
                              row.gstRateOverridden
                                ? "bg-blue-50 text-blue-700 border border-blue-300 hover:ring-blue-300"
                                : row.gstRateDefault
                                  ? "bg-slate-100 text-slate-500 border border-slate-200 hover:ring-slate-300"
                                  : row.gstRateInferred
                                    ? "bg-amber-50 text-amber-700 border border-amber-200 hover:ring-amber-300"
                                    : "bg-orange-50 text-orange-700 hover:ring-orange-300"
                            )}
                          >
                            {row.gstRateOverridden ? "✎ " : row.gstRateDefault ? "" : row.gstRateInferred ? "~" : ""}{row.gstRate}%
                          </button>
                        </span>
                      )}
                    </div>

                    {/* Tally Rate */}
                    {tallyItemCount > 0 && (
                      <div className="px-2 text-right">
                        {row.tallyRate !== undefined ? (
                          <>
                            <div className="text-lg font-bold tabular-nums text-emerald-600">
                              {fmtRate(row.tallyRate)}
                            </div>
                            {row.tallyCostPrice !== undefined && (
                              <div className="text-xs font-semibold mt-1 text-slate-500">
                                Cost: {fmtRate(row.tallyCostPrice)}
                              </div>
                            )}
                          </>
                        ) : (
                          <span className="text-slate-300 text-lg">—</span>
                        )}
                      </div>
                    )}

                    {/* Price + GST */}
                    {tallyItemCount > 0 && (
                      <div className="px-2 text-right">
                        {row.tallyRate !== undefined && row.gstRate !== undefined ? (
                          <div className="text-lg font-bold tabular-nums text-purple-700">
                            {fmtRate(row.tallyRate * (1 + row.gstRate / 100))}
                          </div>
                        ) : (
                          <span className="text-slate-300 text-lg">—</span>
                        )}
                      </div>
                    )}
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
