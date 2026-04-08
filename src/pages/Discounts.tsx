import { useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Pencil, Upload, AlertTriangle, X, Plus, Trash2, RotateCcw, ChevronDown, ChevronRight } from "lucide-react";
import clsx from "clsx";
import { useDataStore } from "../store/dataStore";
import { useDiscountStore } from "../store/discountStore";
import {
  DEFAULT_ITEM_CATEGORY_MAP,
  calculateVoucherDiscount,
  type DiscountCategory,
  type DiscountTier,
  type LineDiscountResult,
} from "../engine/discounts";
import { fmtINR, fmtNum, fmtDate } from "../utils/format";
import type { CanonicalVoucher } from "../types/canonical";

// ── Constants ─────────────────────────────────────────────────────────────────
const PAGE_SIZE = 20;

// ── Voucher Selector ──────────────────────────────────────────────────────────
type VoucherTab = "Sales" | "Delivery Note";

function VoucherSelector({
  vouchers,
  selectedId,
  onSelect,
}: {
  vouchers: CanonicalVoucher[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [tab, setTab] = useState<VoucherTab>("Sales");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return vouchers
      .filter((v) => {
        if (v.isCancelled || v.isOptional) return false;
        if (tab === "Sales") return v.voucherType === "Sales";
        return (
          v.voucherType === "Delivery Note" ||
          v.voucherType.toLowerCase().includes("delivery")
        );
      })
      .filter((v) => {
        if (!q) return true;
        return (
          (v.partyName ?? "").toLowerCase().includes(q) ||
          v.voucherNumber.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [vouchers, tab, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageVouchers = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleTabChange = (newTab: VoucherTab) => {
    setTab(newTab);
    setPage(0);
    setSearch("");
  };

  return (
    <div className="section-card">
      {/* Controls — with breathing room */}
      <div className="mb-5 flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex gap-2">
            {(["Sales", "Delivery Note"] as VoucherTab[]).map((t) => (
              <button
                key={t}
                onClick={() => handleTabChange(t)}
                className={clsx(
                  "px-3.5 py-2 rounded-lg text-sm font-medium transition-colors",
                  tab === t
                    ? "bg-accent text-white"
                    : "bg-bg border border-bg-border text-muted hover:text-primary"
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="flex-1 flex items-center gap-2">
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              placeholder="Search party or voucher #"
              className="search-input flex-1 min-w-[140px]"
            />
            <span className="text-xs text-muted tabular-nums whitespace-nowrap px-2">
              {filtered.length} total
            </span>
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="py-12 text-center">
          <div className="text-muted text-sm">
            {tab === "Delivery Note"
              ? "No delivery notes found in loaded data"
              : "No sales vouchers found"}
          </div>
        </div>
      ) : (
        <>
          {/* Table — with proper row height */}
          <div className="overflow-x-auto -mx-5 -mb-5 pr-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-bg-border text-xs text-muted bg-bg">
                  <th className="text-left px-5 py-3 font-medium w-8"></th>
                  <th className="text-left px-5 py-3 font-medium">Vch No</th>
                  <th className="text-left px-5 py-3 font-medium">Date</th>
                  <th className="text-left px-5 py-3 font-medium">Party</th>
                  <th className="text-right px-5 py-3 font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {pageVouchers.map((v) => {
                  const isSelected = v.voucherId === selectedId;
                  return (
                    <tr
                      key={v.voucherId}
                      onClick={() => onSelect(v.voucherId)}
                      className={clsx(
                        "border-b border-bg-border/40 cursor-pointer transition-colors duration-150",
                        isSelected
                          ? "bg-accent/10 hover:bg-accent/15"
                          : "hover:bg-bg-hover"
                      )}
                    >
                      <td className="px-5 py-3">
                        <input
                          type="radio"
                          readOnly
                          checked={isSelected}
                          className="accent-accent cursor-pointer"
                        />
                      </td>
                      <td className="px-5 py-3 font-mono text-xs tabular-nums text-primary font-medium">
                        {v.voucherNumber}
                      </td>
                      <td className="px-5 py-3 text-xs text-muted whitespace-nowrap">
                        {fmtDate(v.date)}
                      </td>
                      <td className="px-5 py-3 text-primary max-w-xs truncate">
                        {v.partyName ?? v.partyLedgerId ?? "—"}
                      </td>
                      <td className="px-5 py-3 text-right font-medium tabular-nums">
                        {fmtINR(v.totalAmount)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination — with better spacing */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-1.5 mt-5 flex-wrap">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-2.5 py-1.5 text-sm rounded-lg border border-bg-border disabled:opacity-40 hover:bg-bg-hover transition-colors font-medium"
              >
                ‹
              </button>
              {Array.from({ length: Math.min(totalPages, 7) }).map((_, i) => {
                const pageNum =
                  totalPages <= 7
                    ? i
                    : page < 4
                    ? i
                    : page > totalPages - 4
                    ? totalPages - 7 + i
                    : page - 3 + i;
                return (
                  <button
                    key={pageNum}
                    onClick={() => setPage(pageNum)}
                    className={clsx(
                      "px-3 py-1.5 text-sm rounded-lg border font-medium transition-colors",
                      page === pageNum
                        ? "border-accent bg-accent text-white"
                        : "border-bg-border hover:bg-bg-hover text-muted"
                    )}
                  >
                    {pageNum + 1}
                  </button>
                );
              })}
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page === totalPages - 1}
                className="px-2.5 py-1.5 text-sm rounded-lg border border-bg-border disabled:opacity-40 hover:bg-bg-hover transition-colors font-medium"
              >
                ›
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Discount Breakdown ────────────────────────────────────────────────────────
function DiscountBreakdown({
  voucher,
  lines,
  result,
}: {
  voucher: CanonicalVoucher;
  lines: LineDiscountResult[];
  result: { totalLineAmount: number; totalDiscountAmount: number; effectivePct: number };
}) {
  const allNoDiscount = lines.every((l) => l.discountPct === 0);

  return (
    <div className="section-card">
      {/* Voucher header — with breathing room */}
      <div className="mb-5 pb-4 border-b border-bg-border">
        <div className="font-semibold text-lg text-primary">
          {voucher.partyName ?? voucher.partyLedgerId ?? "—"}
        </div>
        <div className="text-sm text-muted mt-1.5 space-y-0.5">
          <div>{voucher.voucherType} {voucher.voucherNumber}</div>
          <div className="flex items-center gap-2 text-xs">
            <span>{fmtDate(voucher.date)}</span>
            <span className="text-muted/50">•</span>
            <span className="font-mono font-medium text-primary">{fmtINR(voucher.totalAmount)}</span>
          </div>
        </div>
      </div>

      {lines.length === 0 ? (
        <div className="py-12 text-center text-muted text-sm">
          No inventory items found in this voucher
        </div>
      ) : (
        <>
          {allNoDiscount && (
            <div className="mb-4 px-4 py-3 bg-warn/10 text-warn text-sm rounded-lg border border-warn/20 font-medium">
              No discounts applicable to this invoice
            </div>
          )}

          {/* Table — spacious layout */}
          <div className="overflow-x-auto -mx-5 -mb-5 pr-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-bg-border text-xs text-muted bg-bg">
                  <th className="text-left px-5 py-3 font-medium">Item Name</th>
                  <th className="text-right px-5 py-3 font-medium">Qty</th>
                  <th className="text-right px-5 py-3 font-medium">Unit Rate</th>
                  <th className="text-right px-5 py-3 font-medium">Line ₹</th>
                  <th className="text-left px-5 py-3 font-medium">Category</th>
                  <th className="text-center px-5 py-3 font-medium">Disc%</th>
                  <th className="text-right px-5 py-3 font-medium">Disc ₹</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => {
                  const hasDiscount = line.discountPct > 0;
                  const unitsNotConfigured =
                    line.unitsPerPkg === 1 && line.categoryId !== "NO_DISCOUNT";
                  const unitRate = line.qtyBase > 0 ? line.lineAmount / line.qtyBase : 0;

                  return (
                    <tr
                      key={idx}
                      className={clsx(
                        "border-b border-bg-border/40 transition-colors duration-150",
                        hasDiscount ? "bg-success/8 hover:bg-success/12" : "hover:bg-bg-hover"
                      )}
                    >
                      <td className="px-5 py-3 max-w-xs">
                        <div className="flex items-center gap-2">
                          <div className="flex-1">
                            <div className={clsx(
                              "font-medium truncate",
                              hasDiscount ? "text-primary" : "text-muted"
                            )}>
                              {line.itemName}
                            </div>
                            <div className="text-2xs text-muted/60 mt-0.5">{line.tierLabel}</div>
                          </div>
                          {unitsNotConfigured && (
                            <span
                              title="Package unit not configured — discounting on individual units"
                              className="text-warn flex-shrink-0 cursor-help"
                            >
                              <AlertTriangle size={14} />
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums text-sm">
                        {fmtNum(line.qtyBase, 0)}
                        <div className="text-2xs text-muted/60 mt-0.5">
                          {line.unitsPerPkg > 1 ? `${line.packages} pkg` : "pc"}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-right font-mono text-sm tabular-nums">
                        {fmtNum(unitRate, 2)}
                      </td>
                      <td className="px-5 py-3 text-right font-medium tabular-nums text-sm">
                        {fmtINR(line.lineAmount)}
                      </td>
                      <td className="px-5 py-3">
                        <span className={clsx(
                          "inline-block px-2 py-1 rounded text-xs font-medium whitespace-nowrap",
                          line.categoryId === "NO_DISCOUNT"
                            ? "bg-neutral-100 text-neutral-600"
                            : "bg-accent/15 text-accent"
                        )}>
                          {line.categoryName}
                        </span>
                      </td>
                      <td className={clsx(
                        "px-5 py-3 text-center font-medium tabular-nums",
                        hasDiscount ? "text-success font-semibold" : "text-muted"
                      )}>
                        {line.discountPct > 0 ? `${line.discountPct}%` : "—"}
                      </td>
                      <td className={clsx(
                        "px-5 py-3 text-right font-medium tabular-nums",
                        hasDiscount ? "text-success font-semibold" : "text-muted"
                      )}>
                        {hasDiscount ? fmtINR(line.discountAmount) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-bg-border bg-bg/50 font-semibold text-sm">
                  <td className="px-5 py-4 text-primary" colSpan={4}>
                    Total
                  </td>
                  <td className="px-5 py-4"></td>
                  <td className="px-5 py-4 text-center text-success">
                    {fmtNum(result.effectivePct, 2)}%
                  </td>
                  <td className="px-5 py-4 text-right tabular-nums text-success text-base">
                    {fmtINR(result.totalDiscountAmount)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="mt-4 p-3 bg-bg rounded-lg text-sm">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <span className="text-muted">Invoice subtotal (items)</span>
              <span className="font-mono font-semibold text-primary">{fmtINR(result.totalLineAmount)}</span>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mt-2 pt-2 border-t border-bg-border">
              <span className="text-muted">Total discount applied</span>
              <span className="font-mono font-semibold text-success">{fmtINR(result.totalDiscountAmount)} ({fmtNum(result.effectivePct, 2)}%)</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Edit Rules Modal ──────────────────────────────────────────────────────────
function EditRulesModal({
  onClose,
  allItemIds,
}: {
  onClose: () => void;
  allItemIds: string[];
}) {
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

  // Merged item->category for display
  const mergedMap = useMemo(
    () => ({ ...DEFAULT_ITEM_CATEGORY_MAP, ...localOverrides }),
    [localOverrides]
  );

  // All items to show: static 550 + any extra from loaded data
  const allItems = useMemo(() => {
    const staticKeys = new Set(Object.keys(DEFAULT_ITEM_CATEGORY_MAP));
    const extra = allItemIds.filter((id) => !staticKeys.has(id));
    return [
      ...Object.keys(DEFAULT_ITEM_CATEGORY_MAP),
      ...extra,
    ];
  }, [allItemIds]);

  const filteredItems = useMemo(() => {
    const q = itemSearch.toLowerCase();
    return allItems.filter((id) => !q || id.toLowerCase().includes(q)).slice(0, 100);
  }, [allItems, itemSearch]);

  // ── Tier helpers ─────────────────────────────────────────────
  function updateTier(catId: string, tierIdx: number, field: keyof DiscountTier, value: string) {
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
    setLocalCats((cats) =>
      cats.map((c) => {
        if (c.id !== catId) return c;
        return { ...c, tiers: c.tiers.filter((_, i) => i !== tierIdx) };
      })
    );
  }

  function deleteCategory(catId: string) {
    if (!window.confirm(`Delete category "${localCats.find((c) => c.id === catId)?.name}"?`)) return;
    setLocalCats((cats) => cats.filter((c) => c.id !== catId));
  }

  function addCategory() {
    const name = window.prompt("Category name:")?.trim();
    if (!name) return;
    const id = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    setLocalCats((cats) => [...cats, { id, name, tiers: [] }]);
  }

  // ── Save & actions ────────────────────────────────────────────
  function handleSave() {
    setCategories(localCats);
    setItemCategoryOverrides(localOverrides);
    onClose();
  }

  function handleReset() {
    if (!window.confirm("Reset all discount rules to defaults?")) return;
    resetToDefaults();
    onClose();
  }

  // Close on backdrop click
  const handleBackdrop = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={handleBackdrop}
    >
      <div
        className="bg-white rounded-xl shadow-2xl flex flex-col"
        style={{ width: "92vw", maxWidth: "900px", height: "88vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-bg-border flex-shrink-0">
          <h2 className="text-xl font-bold text-primary">Edit Discount Rules</h2>
          <button onClick={onClose} className="btn-icon hover:bg-bg-hover rounded-lg transition-colors" aria-label="Close">
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 border-b border-bg-border flex-shrink-0 px-6">
          {(["tiers", "items"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={clsx(
                "px-1 py-3 text-sm font-medium border-b-2 transition-colors",
                activeTab === t
                  ? "border-accent text-accent"
                  : "border-transparent text-muted hover:text-primary"
              )}
            >
              {t === "tiers" ? "Discount Tiers" : "Item Assignments"}
            </button>
          ))}
        </div>

        {/* Body — scrollable with breathing room */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === "tiers" && (
            <div className="flex flex-col gap-3">
              {localCats.map((cat) => {
                const isExpanded = expandedCatId === cat.id;
                const isNoDisco = cat.id === "NO_DISCOUNT";

                return (
                  <div key={cat.id} className="section-card overflow-hidden">
                    {/* Category header */}
                    <div
                      className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-bg-hover transition-colors"
                      onClick={() => setExpandedCatId(isExpanded ? null : cat.id)}
                    >
                      <div className="flex items-center gap-2">
                        {isExpanded ? (
                          <ChevronDown size={14} className="text-muted flex-shrink-0" />
                        ) : (
                          <ChevronRight size={14} className="text-muted flex-shrink-0" />
                        )}
                        <span className="font-medium text-sm text-primary">{cat.name}</span>
                        <span className="text-xs text-muted">({cat.tiers.length} tiers)</span>
                      </div>
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => addTier(cat.id)}
                          className="flex items-center gap-1 px-2.5 py-1 text-xs rounded border border-bg-border hover:bg-bg-hover transition-colors text-muted hover:text-primary"
                        >
                          <Plus size={12} /> Add Tier
                        </button>
                        {!isNoDisco && (
                          <button
                            onClick={() => deleteCategory(cat.id)}
                            className="flex items-center gap-1 px-2.5 py-1 text-xs rounded border border-danger/30 text-danger hover:bg-danger/10 transition-colors"
                          >
                            <Trash2 size={12} /> Delete
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Tier rows */}
                    {isExpanded && (
                      <div className="border-t border-bg-border">
                        {cat.tiers.length === 0 ? (
                          <div className="px-4 py-3 text-xs text-muted italic">
                            No tiers — items in this category get 0% discount
                          </div>
                        ) : (
                          <>
                            {/* Tier header */}
                            <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 px-4 py-2 text-xs font-medium text-muted border-b border-bg-border/50 bg-bg">
                              <span>Min Qty (pkgs)</span>
                              <span>Max Qty (blank = unlimited)</span>
                              <span>Discount %</span>
                              <span className="w-6" />
                            </div>
                            {cat.tiers.map((tier, ti) => (
                              <div
                                key={ti}
                                className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 px-4 py-2 items-center border-b border-bg-border/30 last:border-b-0"
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
                                  className="w-6 h-6 flex items-center justify-center rounded hover:bg-danger/10 text-danger transition-colors"
                                  aria-label="Remove tier"
                                >
                                  <X size={14} />
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
                className="flex items-center justify-center gap-2 py-3 rounded-lg border-2 border-dashed border-bg-border text-muted hover:text-primary hover:border-accent/50 transition-colors text-sm"
              >
                <Plus size={16} /> Add New Category
              </button>
            </div>
          )}

          {activeTab === "items" && (
            <div>
              <div className="mb-3 flex items-center gap-2">
                <input
                  value={itemSearch}
                  onChange={(e) => setItemSearch(e.target.value)}
                  placeholder="Search items…"
                  className="search-input flex-1"
                />
                <span className="text-xs text-muted tabular-nums whitespace-nowrap">
                  Showing {filteredItems.length} of {allItems.length} items
                </span>
              </div>

              <div className="section-card overflow-hidden">
                {/* Header */}
                <div className="grid grid-cols-2 px-4 py-2.5 text-xs font-medium text-muted border-b border-bg-border bg-bg">
                  <span>Item Name</span>
                  <span>Category</span>
                </div>
                {filteredItems.map((itemId) => {
                  const isNew = !(itemId in DEFAULT_ITEM_CATEGORY_MAP);
                  const effectiveCat = mergedMap[itemId] ?? "No Discount";
                  return (
                    <div
                      key={itemId}
                      className="grid grid-cols-2 px-4 py-2 items-center border-b border-bg-border/30 last:border-b-0 hover:bg-bg-hover"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs text-primary truncate">{itemId}</span>
                        {isNew && (
                          <span className="px-1.5 py-0.5 text-2xs bg-info/15 text-info rounded font-medium flex-shrink-0">
                            NEW
                          </span>
                        )}
                      </div>
                      <select
                        value={effectiveCat}
                        onChange={(e) => {
                          const newCat = e.target.value;
                          setLocalOverrides((ov) => {
                            // Only store if different from static default
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
                })}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between px-6 py-5 border-t border-bg-border flex-shrink-0">
          <button
            onClick={handleReset}
            className="flex items-center gap-2 px-3.5 py-2.5 text-sm rounded-lg border border-danger/30 text-danger hover:bg-danger/10 transition-colors font-medium"
          >
            <RotateCcw size={16} /> Reset to Defaults
          </button>
          <div className="flex items-center gap-3">
            <button onClick={onClose} className="btn-secondary text-sm px-4 py-2.5">
              Cancel
            </button>
            <button onClick={handleSave} className="btn-primary text-sm px-4 py-2.5">
              Save Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function Discounts() {
  const navigate = useNavigate();
  const { data } = useDataStore();
  const { categories, itemCategoryOverrides } = useDiscountStore();

  const [selectedVoucherId, setSelectedVoucherId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

  const vouchers = useMemo(
    () => (data?.vouchers ?? []).filter((v) => !v.isCancelled && !v.isOptional),
    [data]
  );

  const selectedVoucher = useMemo(
    () => (selectedVoucherId ? vouchers.find((v) => v.voucherId === selectedVoucherId) ?? null : null),
    [vouchers, selectedVoucherId]
  );

  const discountResult = useMemo(() => {
    if (!selectedVoucher || !data) return null;
    return calculateVoucherDiscount(
      selectedVoucher,
      data.items,
      categories,
      itemCategoryOverrides
    );
  }, [selectedVoucher, data, categories, itemCategoryOverrides]);

  // All item IDs for the modal item assignments tab
  const allItemIds = useMemo(
    () => (data ? Array.from(data.items.keys()) : []),
    [data]
  );

  if (!data) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon text-5xl">%</div>
        <h2 className="empty-state-title">No Data Loaded</h2>
        <p className="empty-state-desc">Import your Tally data to calculate discounts</p>
        <button onClick={() => navigate("/import")} className="btn-primary mt-2">
          <Upload size={14} /> Import Data
        </button>
      </div>
    );
  }

  return (
    <div className="page-section">
      {/* Page Header — with proper spacing */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="page-title">Discounts</h1>
          <p className="text-sm text-muted mt-2">
            Calculate automatic discounts for Sales invoices
          </p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="btn-secondary flex items-center gap-2 px-4 py-2.5 font-medium flex-shrink-0"
        >
          <Pencil size={16} /> Edit Rules
        </button>
      </div>

      {/* Voucher Selector */}
      <div className="mb-6">
        <VoucherSelector
          vouchers={vouchers}
          selectedId={selectedVoucherId}
          onSelect={setSelectedVoucherId}
        />
      </div>

      {/* Discount Breakdown */}
      {selectedVoucher && discountResult && (
        <div className="mb-6">
          <DiscountBreakdown
            voucher={selectedVoucher}
            lines={discountResult.lines}
            result={discountResult}
          />
        </div>
      )}

      {/* Edit Rules Modal */}
      {showModal && (
        <EditRulesModal onClose={() => setShowModal(false)} allItemIds={allItemIds} />
      )}
    </div>
  );
}
