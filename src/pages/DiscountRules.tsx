import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, X, Plus, Trash2, RotateCcw, ArrowLeft } from "lucide-react";
import clsx from "clsx";
import { useDataStore } from "../store/dataStore";
import { useDiscountStore } from "../store/discountStore";
import {
  DEFAULT_ITEM_CATEGORY_MAP,
  type DiscountCategory,
  type DiscountTier,
} from "../engine/discounts";

export default function DiscountRules() {
  const navigate = useNavigate();
  const { data } = useDataStore();
  const { categories, itemCategoryOverrides, setCategories, setItemCategoryOverrides, resetToDefaults } =
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

  function addCategory() {
    const name = window.prompt("Category name:")?.trim();
    if (!name) return;
    const id = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    setHasChanges(true);
    setLocalCats((cats) => [...cats, { id, name, tiers: [] }]);
  }

  // ── Save & actions ────────────────────────────────────────────
  function handleSave() {
    setCategories(localCats);
    setItemCategoryOverrides(localOverrides);
    setHasChanges(false);
    navigate("/discounts");
  }

  function handleReset() {
    if (!window.confirm("Reset all discount rules to defaults?")) return;
    resetToDefaults();
    setHasChanges(false);
    navigate("/discounts");
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
      {/* Header with back button */}
      <div className="page-header">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate("/discounts")} className="btn-secondary btn-sm">
            <ArrowLeft size={14} /> Back
          </button>
          <div>
            <h1 className="page-title">Edit Discount Rules</h1>
            <p className="page-subtitle">Configure discount tiers and item assignments</p>
          </div>
        </div>
      </div>

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
            onClick={addCategory}
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
