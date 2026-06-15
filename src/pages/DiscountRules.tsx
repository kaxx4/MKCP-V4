import { useState, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, X, Plus, Trash2, RotateCcw, ArrowLeft, Download, Upload, Palette } from "lucide-react";
import clsx from "clsx";
import { useDataStore } from "../store/dataStore";
import { useDiscountStore } from "../store/discountStore";
import { ColorPicker } from "../components/ColorPicker";
import {
  DEFAULT_ITEM_CATEGORY_MAP,
  DEFAULT_GROUP_RULES,
  type DiscountCategory,
  type DiscountTier,
  type GroupRule,
} from "../engine/discounts";

// Discount rules file version — bump when schema changes
const FILE_VERSION = "2";

interface DiscountRulesFile {
  version: string;
  exportedAt: string;
  categories: DiscountCategory[];
  groupRules: GroupRule[];
  itemCategoryOverrides: Record<string, string>;
  allItemAssignments: Record<string, string>;
}

declare global {
  interface Window {
    electronAPI?: {
      isElectron?: boolean;
      discountRules?: {
        load:   () => Promise<{ ok: boolean; data?: DiscountRulesFile; reason?: string }>;
        save:   (p: DiscountRulesFile) => Promise<{ ok: boolean; reason?: string }>;
        export: (p: DiscountRulesFile) => Promise<{ ok: boolean; filePath?: string; reason?: string }>;
        import: () => Promise<{ ok: boolean; data?: DiscountRulesFile; reason?: string }>;
      };
    };
  }
}

function buildPayload(
  cats: DiscountCategory[],
  overrides: Record<string, string>
): DiscountRulesFile {
  return {
    version: FILE_VERSION,
    exportedAt: new Date().toISOString(),
    categories: cats,
    groupRules: DEFAULT_GROUP_RULES,
    itemCategoryOverrides: overrides,
    allItemAssignments: { ...DEFAULT_ITEM_CATEGORY_MAP, ...overrides },
  };
}

// ── Add Category Modal ────────────────────────────────────────────────────────
function AddCategoryModal({
  isOpen,
  onClose,
  onConfirm,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState("");

  function handleConfirm() {
    const trimmed = name.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
    setName("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleConfirm();
    if (e.key === "Escape") { setName(""); onClose(); }
  }

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={() => { setName(""); onClose(); }}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200">
          <h3 className="text-base font-bold text-neutral-900">New Category</h3>
          <button
            onClick={() => { setName(""); onClose(); }}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-neutral-100 text-neutral-500 transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-neutral-600 uppercase tracking-wide mb-1.5">
              Category Name
            </label>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g. PUMP TOGO ALL TYPES"
              className="form-input w-full"
            />
            {name.trim() && (
              <div className="text-xs text-neutral-400 mt-1.5">
                ID: <span className="font-mono">{name.trim().toUpperCase().replace(/[^A-Z0-9]/g, "_")}</span>
              </div>
            )}
          </div>
        </div>
        <div className="flex gap-3 px-6 py-4 border-t border-neutral-200 bg-neutral-50">
          <button
            onClick={() => { setName(""); onClose(); }}
            className="flex-1 px-4 py-2 text-sm rounded-lg border border-neutral-200 text-neutral-700 hover:bg-neutral-100 transition-colors font-medium"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!name.trim()}
            className="flex-1 px-4 py-2 text-sm rounded-lg bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
          >
            Add Category
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DiscountRules() {
  const navigate = useNavigate();
  const data = useDataStore((s) => s.data);
  const { categories, itemCategoryOverrides, categoryColors, setCategories, setItemCategoryOverrides, setCategoryColor, resetToDefaults } =
    useDiscountStore();

  const [localCats, setLocalCats] = useState<DiscountCategory[]>(() =>
    JSON.parse(JSON.stringify(categories))
  );
  const [localOverrides, setLocalOverrides] = useState<Record<string, string>>(() => ({
    ...itemCategoryOverrides,
  }));
  const [activeTab, setActiveTab] = useState<"tiers" | "items">("tiers");
  const [itemSearch, setItemSearch] = useState("");
  const [expandedCatId, setExpandedCatId] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [fileMsg, setFileMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [addCatOpen, setAddCatOpen] = useState(false);
  const [colorCatId, setColorCatId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function showMsg(type: "ok" | "err", text: string) {
    setFileMsg({ type, text });
    setTimeout(() => setFileMsg(null), 4000);
  }

  const mergedMap = useMemo(
    () => ({ ...DEFAULT_ITEM_CATEGORY_MAP, ...localOverrides }),
    [localOverrides]
  );

  const allItems = useMemo(() => {
    const staticKeys = new Set(Object.keys(DEFAULT_ITEM_CATEGORY_MAP));
    const extra = (data?.items ? Array.from(data.items.keys()) : []).filter((id) => !staticKeys.has(id));
    return [
      ...Object.keys(DEFAULT_ITEM_CATEGORY_MAP),
      ...extra,
    ];
  }, [data]);

  const filteredItems = useMemo(() => {
    const q = itemSearch.toLowerCase();
    return allItems.filter((id) => !q || id.toLowerCase().includes(q));
  }, [allItems, itemSearch]);

  // ── Tier helpers ─────────────────────────────────────────────
  function updateTier(catId: string, tierIdx: number, field: keyof DiscountTier, value: string) {
    setHasChanges(true);
    setLocalCats((cats) =>
      cats.map((c) => {
        if (c.id !== catId) return c;
        const newTiers = c.tiers.map((t, i) => {
          if (i !== tierIdx) return t;
          if (field === "maxQty") {
            return { ...t, maxQty: value === "" ? null : Number(value) };
          }
          return { ...t, [field]: Number(value) };
        });
        return { ...c, tiers: newTiers };
      })
    );
  }

  function addTier(catId: string) {
    setHasChanges(true);
    setExpandedCatId(catId);
    setLocalCats((cats) =>
      cats.map((c) => {
        if (c.id !== catId) return c;
        return {
          ...c,
          tiers: [...c.tiers, { minQty: 1, maxQty: null, discountPct: 0 }],
        };
      })
    );
  }

  function removeTier(catId: string, tierIdx: number) {
    setHasChanges(true);
    setLocalCats((cats) =>
      cats.map((c) => {
        if (c.id !== catId) return c;
        return { ...c, tiers: c.tiers.filter((_, i) => i !== tierIdx) };
      })
    );
  }

  function deleteCategory(catId: string) {
    if (!window.confirm(`Delete category "${localCats.find((c) => c.id === catId)?.name}"?`)) return;
    setHasChanges(true);
    setLocalCats((cats) => cats.filter((c) => c.id !== catId));
  }

  function handleAddCategory(name: string) {
    const id = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    setHasChanges(true);
    setLocalCats((cats) => [...cats, { id, name, tiers: [] }]);
    setAddCatOpen(false);
    // Auto-expand the new category
    setExpandedCatId(id);
  }

  // ── Save & actions ────────────────────────────────────────────
  async function handleSave() {
    setCategories(localCats);
    setItemCategoryOverrides(localOverrides);
    setHasChanges(false);

    // Write to disk whenever Electron is available
    const payload = buildPayload(localCats, localOverrides);
    if (window.electronAPI?.discountRules) {
      const res = await window.electronAPI.discountRules.save(payload);
      if (!res.ok) showMsg("err", `Saved to store, but file write failed: ${res.reason}`);
    }

    navigate("/discounts");
  }

  function handleReset() {
    if (!window.confirm("Reset all discount rules to defaults?")) return;
    resetToDefaults();
    setHasChanges(false);
    navigate("/discounts");
  }

  async function handleExport() {
    const payload = buildPayload(localCats, localOverrides);

    if (window.electronAPI?.discountRules) {
      // Electron: native save dialog
      const res = await window.electronAPI.discountRules.export(payload);
      if (res.ok) showMsg("ok", `Exported → ${res.filePath}`);
      else if (res.reason !== "canceled") showMsg("err", `Export failed: ${res.reason}`);
    } else {
      // Browser fallback: trigger download
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `discount-rules-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      const itemCount = Object.keys(payload.allItemAssignments).length;
      showMsg("ok", `Exported ${localCats.length} categories, ${DEFAULT_GROUP_RULES.length} group rules, ${itemCount} item assignments`);
    }
  }

  async function handleImport() {
    if (window.electronAPI?.discountRules) {
      // Electron: native open dialog
      const res = await window.electronAPI.discountRules.import();
      if (!res.ok) {
        if (res.reason !== "canceled") showMsg("err", `Import failed: ${res.reason}`);
        return;
      }
      applyImportedRules(res.data!);
    } else {
      // Browser fallback: file input
      fileInputRef.current?.click();
    }
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string) as DiscountRulesFile;
        applyImportedRules(data);
      } catch {
        showMsg("err", "Invalid JSON file");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function applyImportedRules(data: DiscountRulesFile) {
    if (!data.categories || !Array.isArray(data.categories)) {
      showMsg("err", "Invalid file: missing categories");
      return;
    }
    // Merge by category id — overwrite existing, append new, keep local-only ones
    setLocalCats((prev) => {
      const incomingById = new Map(data.categories.map((c) => [c.id, c]));
      const merged = prev.map((c) => incomingById.has(c.id) ? incomingById.get(c.id)! : c);
      for (const cat of data.categories) {
        if (!prev.some((c) => c.id === cat.id)) merged.push(cat);
      }
      return merged;
    });
    // Merge overrides — imported values overwrite same keys, local-only keys kept
    setLocalOverrides((prev) => ({ ...prev, ...(data.itemCategoryOverrides ?? {}) }));
    setHasChanges(true);
    showMsg("ok", `Imported ${data.categories.length} categories (unsaved — click Save to apply)`);
  }

  if (!data) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon text-5xl">%</div>
        <h2 className="empty-state-title">No Data Loaded</h2>
        <p className="empty-state-desc">Import your Tally data first</p>
      </div>
    );
  }

  return (
    <div className="page-section">
      {/* Hidden file input for browser-fallback import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={handleFileInputChange}
      />

      {/* Add Category Modal */}
      <AddCategoryModal
        isOpen={addCatOpen}
        onClose={() => setAddCatOpen(false)}
        onConfirm={handleAddCategory}
      />

      {/* Color Picker Modal */}
      {colorCatId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setColorCatId(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold text-neutral-900 mb-4">
              Edit Color: {localCats.find((c) => c.id === colorCatId)?.name}
            </h3>
            <ColorPicker
              value={categoryColors[colorCatId] || ""}
              onChange={(color) => {
                setCategoryColor(colorCatId, color);
              }}
            />
            <button
              onClick={() => setColorCatId(null)}
              className="w-full mt-4 px-4 py-2 bg-accent text-white rounded-lg font-medium hover:bg-accent-700 transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* Header with back button */}
      <div className="page-header">
        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={() => navigate("/discounts")} className="btn-secondary btn-sm">
            <ArrowLeft size={14} /> Back
          </button>
          <div>
            <h1 className="page-title">Edit Discount Rules</h1>
            <p className="page-subtitle">Configure discount tiers and item assignments</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleImport}
            className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg border border-neutral-200 hover:bg-neutral-100 transition-colors text-neutral-700 font-medium"
            title="Import rules from a JSON file"
          >
            <Upload size={14} /> Import
          </button>
          <button
            onClick={handleExport}
            className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg border border-neutral-200 hover:bg-neutral-100 transition-colors text-neutral-700 font-medium"
            title="Export categories, group rules, and all item assignments to JSON"
          >
            <Download size={14} /> Export
          </button>
        </div>
      </div>

      {/* File operation status message */}
      {fileMsg && (
        <div
          className={clsx(
            "px-4 py-2.5 rounded-lg text-sm font-medium border",
            fileMsg.type === "ok"
              ? "bg-green-50 text-green-800 border-green-200"
              : "bg-red-50 text-red-800 border-red-200"
          )}
        >
          {fileMsg.text}
        </div>
      )}

      {/* Tabs */}
      <div className="tab-list">
        {(["tiers", "items"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={clsx("tab-item", activeTab === t && "tab-item-active")}
          >
            {t === "tiers" ? "Discount Tiers" : "Item Assignments"}
          </button>
        ))}
      </div>

      {/* Content */}
      {activeTab === "tiers" && (
        <div className="space-y-4">
          {localCats.map((cat) => {
            const isExpanded = expandedCatId === cat.id;
            const isNoDisco = cat.id === "NO_DISCOUNT";

            return (
              <div key={cat.id} className="border border-neutral-200 rounded-lg overflow-hidden bg-white">
                {/* Category header */}
                <div
                  className="flex items-center justify-between px-6 py-4 cursor-pointer hover:bg-neutral-50 transition-colors"
                  onClick={() => setExpandedCatId(isExpanded ? null : cat.id)}
                >
                  <div className="flex items-center gap-3">
                    {isExpanded ? (
                      <ChevronDown size={18} className="text-neutral-500 flex-shrink-0" />
                    ) : (
                      <ChevronRight size={18} className="text-neutral-500 flex-shrink-0" />
                    )}
                    <div>
                      <div className="font-semibold text-base text-neutral-900">{cat.name}</div>
                      <div className="text-xs text-neutral-500 mt-0.5">{cat.tiers.length} tier{cat.tiers.length !== 1 ? 's' : ''}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => setColorCatId(cat.id)}
                      className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg border border-neutral-200 hover:bg-neutral-100 transition-colors text-neutral-600 font-medium min-h-10"
                      title="Edit category color"
                    >
                      <Palette size={14} /> Color
                    </button>
                    <button
                      onClick={() => addTier(cat.id)}
                      className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg border border-neutral-200 hover:bg-neutral-100 transition-colors text-neutral-600 font-medium"
                    >
                      <Plus size={14} /> Add Tier
                    </button>
                    {!isNoDisco && (
                      <button
                        onClick={() => deleteCategory(cat.id)}
                        className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors font-medium"
                      >
                        <Trash2 size={14} /> Delete
                      </button>
                    )}
                  </div>
                </div>

                {/* Tier rows */}
                {isExpanded && (
                  <div className="border-t border-neutral-200 bg-neutral-50">
                    {cat.tiers.length === 0 ? (
                      <div className="px-6 py-6 text-sm text-neutral-600 italic bg-white">
                        No tiers — items in this category get 0% discount
                      </div>
                    ) : (
                      <>
                        {/* Tier header */}
                        <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-4 px-6 py-3 text-xs font-semibold text-neutral-600 border-b border-neutral-200 bg-white">
                          <span>Min Qty (pkgs)</span>
                          <span>Max Qty (blank = unlimited)</span>
                          <span>Discount %</span>
                          <span className="w-10" />
                        </div>
                        {cat.tiers.map((tier, ti) => (
                          <div
                            key={ti}
                            className="grid grid-cols-[1fr_1fr_1fr_auto] gap-4 px-6 py-3 items-center border-b border-neutral-100 last:border-b-0 bg-white"
                          >
                            <input
                              type="number"
                              min={0}
                              value={tier.minQty}
                              onChange={(e) => updateTier(cat.id, ti, "minQty", e.target.value)}
                              className="form-input text-sm"
                            />
                            <input
                              type="number"
                              min={0}
                              value={tier.maxQty === null ? "" : tier.maxQty}
                              placeholder="unlimited"
                              onChange={(e) => updateTier(cat.id, ti, "maxQty", e.target.value)}
                              className="form-input text-sm"
                            />
                            <input
                              type="number"
                              min={0}
                              max={100}
                              step={0.5}
                              value={tier.discountPct}
                              onChange={(e) => updateTier(cat.id, ti, "discountPct", e.target.value)}
                              className="form-input text-sm"
                            />
                            <button
                              onClick={() => removeTier(cat.id, ti)}
                              className="w-10 h-10 flex items-center justify-center rounded hover:bg-red-100 text-red-600 transition-colors"
                              aria-label="Remove tier"
                            >
                              <X size={18} />
                            </button>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          <button
            onClick={() => setAddCatOpen(true)}
            className="flex items-center justify-center gap-2 w-full py-4 rounded-lg border-2 border-dashed border-neutral-300 text-neutral-600 hover:text-neutral-900 hover:border-blue-400 transition-colors text-sm font-medium"
          >
            <Plus size={20} /> Add New Category
          </button>
        </div>
      )}

      {activeTab === "items" && (
        <div className="card space-y-4">
          <div className="flex items-center gap-3">
            <input
              value={itemSearch}
              onChange={(e) => setItemSearch(e.target.value)}
              placeholder="Search items…"
              className="search-input flex-1"
            />
            <span className="text-xs text-neutral-600 font-medium whitespace-nowrap">
              {filteredItems.length} / {allItems.length}
            </span>
          </div>

          <div className="border border-neutral-200 rounded-lg overflow-hidden">
            {/* Header */}
            <div className="grid grid-cols-[1fr_1fr] px-6 py-3 text-xs font-semibold text-neutral-600 border-b border-neutral-200 bg-neutral-50 sticky top-0 z-10">
              <span>Item Name</span>
              <span>Category</span>
            </div>
            {/* Items list */}
            <div className="divide-y divide-neutral-100 max-h-96 overflow-y-auto">
              {filteredItems.length === 0 ? (
                <div className="px-6 py-8 text-center text-neutral-500 text-sm">
                  No items found
                </div>
              ) : (
                filteredItems.map((itemId) => {
                  const isNew = !(itemId in DEFAULT_ITEM_CATEGORY_MAP);
                  const effectiveCat = mergedMap[itemId] ?? "No Discount";
                  return (
                    <div
                      key={itemId}
                      className="grid grid-cols-[1fr_1fr] px-6 py-3 items-center hover:bg-neutral-50 transition-colors"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs text-neutral-700 truncate font-medium">{itemId}</span>
                        {isNew && (
                          <span className="px-2 py-0.5 text-2xs bg-blue-100 text-blue-700 rounded font-semibold flex-shrink-0 whitespace-nowrap">
                            NEW
                          </span>
                        )}
                      </div>
                      <select
                        value={effectiveCat}
                        onChange={(e) => {
                          const newCat = e.target.value;
                          setHasChanges(true);
                          setLocalOverrides((ov) => {
                            const staticDefault = DEFAULT_ITEM_CATEGORY_MAP[itemId] ?? "No Discount";
                            if (newCat === staticDefault) {
                              const { [itemId]: _, ...rest } = ov;
                              return rest;
                            }
                            return { ...ov, [itemId]: newCat };
                          });
                        }}
                        className="form-select text-xs"
                      >
                        {localCats.map((c) => (
                          <option key={c.id} value={c.name}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* Footer Actions */}
      <div className="fixed bottom-0 left-0 right-0 border-t border-neutral-200 bg-neutral-50 px-6 py-4">
        <div className="flex items-center justify-between gap-4 max-w-7xl mx-auto">
          <button
            onClick={handleReset}
            className="flex items-center gap-2 px-4 py-2.5 text-sm rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors font-medium"
          >
            <RotateCcw size={16} /> Reset to Defaults
          </button>
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate("/discounts")}
              className="px-5 py-2.5 text-sm rounded-lg border border-neutral-200 text-neutral-700 hover:bg-neutral-100 transition-colors font-medium"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!hasChanges}
              className="px-5 py-2.5 text-sm rounded-lg bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium shadow-sm"
            >
              Save Changes
            </button>
          </div>
        </div>
      </div>

      {/* Bottom spacing for fixed footer */}
      <div className="h-20" />
    </div>
  );
}
