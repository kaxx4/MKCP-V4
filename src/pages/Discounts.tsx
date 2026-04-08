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
  const [tab, setTab] = useState<VoucherTab>("Delivery Note");
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
    <div className="card space-y-6">
      {/* Header Section */}
      <div className="space-y-4">
        {/* Tab Buttons */}
        <div className="flex gap-2">
          {(["Sales", "Delivery Note"] as VoucherTab[]).map((t) => (
            <button
              key={t}
              onClick={() => handleTabChange(t)}
              className={clsx(
                "px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-150",
                tab === t
                  ? "bg-blue-500 text-white shadow-sm"
                  : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
              )}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Search Bar */}
        <div className="flex items-center gap-3">
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Search party or voucher #"
            className="search-input flex-1"
          />
          <span className="text-xs font-medium text-neutral-500 whitespace-nowrap">
            {filtered.length} found
          </span>
        </div>
      </div>

      {/* Content Section */}
      {filtered.length === 0 ? (
        <div className="py-16 text-center">
          <div className="text-neutral-500 text-sm">
            {tab === "Delivery Note"
              ? "No delivery notes found in loaded data"
              : "No sales vouchers found"}
          </div>
        </div>
      ) : (
        <>
          {/* Table */}
          <div className="border border-neutral-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50">
                  <th className="w-8 text-center px-4 py-3"></th>
                  <th className="text-left px-4 py-3 font-semibold text-neutral-700">Voucher</th>
                  <th className="text-left px-4 py-3 font-semibold text-neutral-700">Date</th>
                  <th className="text-left px-4 py-3 font-semibold text-neutral-700">Party</th>
                  <th className="text-right px-4 py-3 font-semibold text-neutral-700">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {pageVouchers.map((v) => {
                  const isSelected = v.voucherId === selectedId;
                  return (
                    <tr
                      key={v.voucherId}
                      onClick={() => onSelect(v.voucherId)}
                      className={clsx(
                        "cursor-pointer transition-colors duration-150",
                        isSelected
                          ? "bg-blue-50 hover:bg-blue-100"
                          : "hover:bg-neutral-50"
                      )}
                    >
                      <td className="text-center px-4 py-3">
                        <input
                          type="radio"
                          readOnly
                          checked={isSelected}
                          className="accent-blue-500 cursor-pointer"
                        />
                      </td>
                      <td className="px-4 py-3 font-mono text-xs font-medium text-blue-600">
                        {v.voucherNumber}
                      </td>
                      <td className="px-4 py-3 text-sm text-neutral-600 whitespace-nowrap">
                        {fmtDate(v.date)}
                      </td>
                      <td className="px-4 py-3 text-sm text-neutral-900 truncate max-w-xs">
                        {v.partyName ?? v.partyLedgerId ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-semibold text-neutral-900 tabular-nums">
                        {fmtINR(v.totalAmount)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 flex-wrap pt-2">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-3 py-2 text-sm rounded-lg border border-neutral-200 disabled:opacity-40 hover:bg-neutral-100 transition-colors font-medium"
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
                      "px-3 py-2 text-sm rounded-lg font-medium transition-colors",
                      page === pageNum
                        ? "bg-blue-500 text-white shadow-sm"
                        : "border border-neutral-200 hover:bg-neutral-100 text-neutral-700"
                    )}
                  >
                    {pageNum + 1}
                  </button>
                );
              })}
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page === totalPages - 1}
                className="px-3 py-2 text-sm rounded-lg border border-neutral-200 disabled:opacity-40 hover:bg-neutral-100 transition-colors font-medium"
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
    <div className="card space-y-6">
      {/* Voucher Header */}
      <div className="pb-5 border-b border-neutral-200">
        <div className="font-semibold text-lg text-neutral-900">
          {voucher.partyName ?? voucher.partyLedgerId ?? "—"}
        </div>
        <div className="text-sm text-neutral-600 mt-2 space-y-1">
          <div>{voucher.voucherType} {voucher.voucherNumber}</div>
          <div className="flex items-center gap-2 text-xs">
            <span>{fmtDate(voucher.date)}</span>
            <span className="text-neutral-400">•</span>
            <span className="font-mono font-medium text-neutral-900">{fmtINR(voucher.totalAmount)}</span>
          </div>
        </div>
      </div>

      {lines.length === 0 ? (
        <div className="py-16 text-center text-neutral-500 text-sm">
          No inventory items found in this voucher
        </div>
      ) : (
        <>
          {/* Group-wise Summary */}
          {result.groupSummaries && result.groupSummaries.length > 0 && (
            <div className="space-y-3">
              <div className="text-xs font-semibold text-neutral-500 uppercase tracking-wide">
                Group Discount Summary
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                {result.groupSummaries.map((g) => (
                  <div key={g.categoryId} className="px-4 py-3 rounded-lg border border-neutral-200 bg-neutral-50">
                    <div className="text-xs font-semibold text-neutral-900 truncate mb-2">{g.categoryName}</div>
                    <div className="flex items-center justify-between gap-2 text-xs mb-2">
                      <span className="text-neutral-600">{g.totalPackages} pkg{g.totalPackages !== 1 ? 's' : ''}</span>
                      <span className={g.appliedDiscountPct > 0 ? "text-green-600 font-semibold" : "text-neutral-500"}>
                        {g.appliedDiscountPct > 0 ? `${g.appliedDiscountPct.toFixed(1)}%` : "—"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-xs text-neutral-600 pt-2 border-t border-neutral-200">
                      <span>{fmtINR(g.totalAmount)}</span>
                      {g.totalDiscount > 0 && <span className="text-green-600 font-medium">−{fmtINR(g.totalDiscount)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* No Discount Alert */}
          {allNoDiscount && (
            <div className="px-4 py-3 bg-amber-50 text-amber-900 text-sm rounded-lg border border-amber-200 font-medium">
              No discounts applicable to this invoice
            </div>
          )}

          {/* Items Table */}
          <div className="border border-neutral-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50">
                  <th className="text-left px-4 py-3 font-semibold text-neutral-700">Item Name</th>
                  <th className="text-right px-4 py-3 font-semibold text-neutral-700">Qty</th>
                  <th className="text-right px-4 py-3 font-semibold text-neutral-700">Unit Rate</th>
                  <th className="text-right px-4 py-3 font-semibold text-neutral-700">Line ₹</th>
                  <th className="text-left px-4 py-3 font-semibold text-neutral-700">Category</th>
                  <th className="text-center px-4 py-3 font-semibold text-neutral-700">Disc%</th>
                  <th className="text-right px-4 py-3 font-semibold text-neutral-700">Disc ₹</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {lines.map((line, idx) => {
                  const hasDiscount = line.discountPct > 0;
                  const unitsNotConfigured =
                    line.unitsPerPkg === 1 && line.categoryId !== "NO_DISCOUNT";
                  const unitRate = line.qtyBase > 0 ? line.lineAmount / line.qtyBase : 0;

                  return (
                    <tr
                      key={idx}
                      className={clsx(
                        "transition-colors duration-150",
                        hasDiscount ? "bg-green-50 hover:bg-green-100" : "hover:bg-neutral-50"
                      )}
                    >
                      <td className="px-4 py-3 max-w-xs">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 min-w-0">
                            <div className={clsx(
                              "font-medium truncate text-sm",
                              hasDiscount ? "text-neutral-900" : "text-neutral-700"
                            )}>
                              {line.itemName}
                            </div>
                            <div className="text-xs text-neutral-500 mt-1">{line.tierLabel}</div>
                          </div>
                          {unitsNotConfigured && (
                            <span
                              title="Package unit not configured — discounting on individual units"
                              className="text-amber-600 flex-shrink-0 cursor-help"
                            >
                              <AlertTriangle size={14} />
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-medium text-neutral-900 tabular-nums">
                        {fmtNum(line.qtyBase, 0)}
                        <div className="text-xs text-neutral-500 mt-1">
                          {line.unitsPerPkg > 1 ? `${line.packages} pkg` : "pc"}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-sm text-neutral-700 tabular-nums">
                        {fmtNum(unitRate, 2)}
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-semibold text-neutral-900 tabular-nums">
                        {fmtINR(line.lineAmount)}
                      </td>
                      <td className="px-4 py-3">
                        <span className={clsx(
                          "inline-block px-2.5 py-1 rounded text-xs font-medium whitespace-nowrap",
                          line.categoryId === "NO_DISCOUNT"
                            ? "bg-neutral-100 text-neutral-600"
                            : "bg-blue-100 text-blue-700"
                        )}>
                          {line.categoryName}
                        </span>
                      </td>
                      <td className={clsx(
                        "px-4 py-3 text-center text-sm font-semibold tabular-nums",
                        hasDiscount ? "text-green-600" : "text-neutral-500"
                      )}>
                        {line.discountPct > 0 ? `${line.discountPct}%` : "—"}
                      </td>
                      <td className={clsx(
                        "px-4 py-3 text-right text-sm font-semibold tabular-nums",
                        hasDiscount ? "text-green-600" : "text-neutral-500"
                      )}>
                        {hasDiscount ? fmtINR(line.discountAmount) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-neutral-200 bg-neutral-50 font-semibold text-sm">
                  <td className="px-4 py-4 text-neutral-900" colSpan={4}>
                    Total
                  </td>
                  <td className="px-4 py-4"></td>
                  <td className="px-4 py-4 text-center text-green-600">
                    {fmtNum(result.effectivePct, 2)}%
                  </td>
                  <td className="px-4 py-4 text-right tabular-nums text-green-600 text-base">
                    {fmtINR(result.totalDiscountAmount)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Summary Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
            <div className="px-5 py-4 bg-neutral-50 rounded-lg border border-neutral-200">
              <div className="text-sm text-neutral-600">Invoice subtotal (items)</div>
              <div className="font-mono font-semibold text-neutral-900 mt-1 text-lg">
                {fmtINR(result.totalLineAmount)}
              </div>
            </div>
            <div className="px-5 py-4 bg-green-50 rounded-lg border border-green-200">
              <div className="text-sm text-green-700">Total discount applied</div>
              <div className="font-mono font-semibold text-green-900 mt-1 text-lg">
                {fmtINR(result.totalDiscountAmount)} ({fmtNum(result.effectivePct, 2)}%)
              </div>
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

  const mergedMap = useMemo(
    () => ({ ...DEFAULT_ITEM_CATEGORY_MAP, ...localOverrides }),
    [localOverrides]
  );

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
        <div className="flex items-center justify-between px-6 py-5 border-b border-neutral-200 flex-shrink-0">
          <h2 className="text-xl font-bold text-neutral-900">Edit Discount Rules</h2>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-9 h-9 rounded-lg hover:bg-neutral-100 transition-colors"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 border-b border-neutral-200 flex-shrink-0 px-6">
          {(["tiers", "items"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={clsx(
                "px-4 py-3 text-sm font-medium border-b-2 transition-colors",
                activeTab === t
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-neutral-600 hover:text-neutral-900"
              )}
            >
              {t === "tiers" ? "Discount Tiers" : "Item Assignments"}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === "tiers" && (
            <div className="flex flex-col gap-4">
              {localCats.map((cat) => {
                const isExpanded = expandedCatId === cat.id;
                const isNoDisco = cat.id === "NO_DISCOUNT";

                return (
                  <div key={cat.id} className="border border-neutral-200 rounded-lg overflow-hidden bg-white">
                    {/* Category header */}
                    <div
                      className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-neutral-50 transition-colors"
                      onClick={() => setExpandedCatId(isExpanded ? null : cat.id)}
                    >
                      <div className="flex items-center gap-3">
                        {isExpanded ? (
                          <ChevronDown size={16} className="text-neutral-500 flex-shrink-0" />
                        ) : (
                          <ChevronRight size={16} className="text-neutral-500 flex-shrink-0" />
                        )}
                        <span className="font-medium text-base text-neutral-900">{cat.name}</span>
                        <span className="text-xs text-neutral-500">({cat.tiers.length} tiers)</span>
                      </div>
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => addTier(cat.id)}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-neutral-200 hover:bg-neutral-100 transition-colors text-neutral-600 font-medium"
                        >
                          <Plus size={14} /> Add Tier
                        </button>
                        {!isNoDisco && (
                          <button
                            onClick={() => deleteCategory(cat.id)}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors font-medium"
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
                          <div className="px-5 py-4 text-sm text-neutral-500 italic">
                            No tiers — items in this category get 0% discount
                          </div>
                        ) : (
                          <>
                            {/* Tier header */}
                            <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-3 px-5 py-3 text-xs font-semibold text-neutral-600 border-b border-neutral-200 bg-white">
                              <span>Min Qty (pkgs)</span>
                              <span>Max Qty (blank = unlimited)</span>
                              <span>Discount %</span>
                              <span className="w-8" />
                            </div>
                            {cat.tiers.map((tier, ti) => (
                              <div
                                key={ti}
                                className="grid grid-cols-[1fr_1fr_1fr_auto] gap-3 px-5 py-3 items-center border-b border-neutral-100 last:border-b-0"
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
                                  className="w-8 h-8 flex items-center justify-center rounded hover:bg-red-100 text-red-600 transition-colors"
                                  aria-label="Remove tier"
                                >
                                  <X size={16} />
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
                className="flex items-center justify-center gap-2 py-4 rounded-lg border-2 border-dashed border-neutral-300 text-neutral-600 hover:text-neutral-900 hover:border-blue-400 transition-colors text-sm font-medium"
              >
                <Plus size={18} /> Add New Category
              </button>
            </div>
          )}

          {activeTab === "items" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <input
                  value={itemSearch}
                  onChange={(e) => setItemSearch(e.target.value)}
                  placeholder="Search items…"
                  className="search-input flex-1"
                />
                <span className="text-xs text-neutral-600 font-medium whitespace-nowrap">
                  {filteredItems.length} of {allItems.length}
                </span>
              </div>

              <div className="border border-neutral-200 rounded-lg overflow-hidden">
                {/* Header */}
                <div className="grid grid-cols-2 px-5 py-3 text-xs font-semibold text-neutral-600 border-b border-neutral-200 bg-neutral-50">
                  <span>Item Name</span>
                  <span>Category</span>
                </div>
                {filteredItems.map((itemId) => {
                  const isNew = !(itemId in DEFAULT_ITEM_CATEGORY_MAP);
                  const effectiveCat = mergedMap[itemId] ?? "No Discount";
                  return (
                    <div
                      key={itemId}
                      className="grid grid-cols-2 px-5 py-3 items-center border-b border-neutral-100 last:border-b-0 hover:bg-neutral-50"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs text-neutral-700 truncate font-medium">{itemId}</span>
                        {isNew && (
                          <span className="px-2 py-0.5 text-2xs bg-blue-100 text-blue-700 rounded font-semibold flex-shrink-0">
                            NEW
                          </span>
                        )}
                      </div>
                      <select
                        value={effectiveCat}
                        onChange={(e) => {
                          const newCat = e.target.value;
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
                })}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between px-6 py-5 border-t border-neutral-200 flex-shrink-0 bg-neutral-50">
          <button
            onClick={handleReset}
            className="flex items-center gap-2 px-4 py-2.5 text-sm rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors font-medium"
          >
            <RotateCcw size={16} /> Reset to Defaults
          </button>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2.5 text-sm rounded-lg border border-neutral-200 text-neutral-700 hover:bg-neutral-100 transition-colors font-medium"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2.5 text-sm rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors font-medium shadow-sm"
            >
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
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
        <div>
          <h1 className="page-title">Discounts</h1>
          <p className="text-sm text-neutral-600 mt-2">
            Calculate automatic discounts for Sales invoices based on quantity tiers
          </p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-white text-neutral-900 border border-neutral-200 hover:bg-neutral-50 transition-colors font-medium shadow-sm"
        >
          <Pencil size={16} /> Edit Rules
        </button>
      </div>

      {/* Voucher Selector */}
      <div className="mb-8">
        <VoucherSelector
          vouchers={vouchers}
          selectedId={selectedVoucherId}
          onSelect={setSelectedVoucherId}
        />
      </div>

      {/* Discount Breakdown */}
      {selectedVoucher && discountResult && (
        <div className="mb-8">
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
