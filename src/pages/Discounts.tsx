import { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Pencil, Upload, X, RotateCcw, ChevronDown } from "lucide-react";
import clsx from "clsx";
import { useDataStore } from "../store/dataStore";
import { useDiscountStore } from "../store/discountStore";
import { calculateVoucherDiscount } from "../engine/discounts";
import { fmtINR, fmtNum, fmtDate } from "../utils/format";
import type { CanonicalVoucher } from "../types/canonical";

const PAGE_SIZE = 20;
type VoucherTab = "Sales" | "Delivery Note";

// ── Group Breakdown Modal ─────────────────────────────────────────────────────
function GroupDetailsModal({
  isOpen,
  onClose,
  groupName,
  totalPackages,
  items,
}: {
  isOpen: boolean;
  onClose: () => void;
  groupName: string;
  totalPackages: number;
  items: Array<{ itemName: string; qty: number; packages: number }>;
}) {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header border-b border-neutral-200">
          <h3 className="card-title">{groupName}</h3>
          <button onClick={onClose} className="btn-icon" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="modal-body space-y-4">
          {/* Total Packages */}
          <div className="px-4 py-3 bg-accent/[0.06] rounded-xl border border-accent/20">
            <div className="label-text text-accent">Total Packages in Group</div>
            <div className="metric-value text-accent mt-1">{totalPackages}</div>
          </div>

          {/* Items List */}
          <div>
            <div className="label-text mb-3">Items in This Group</div>
            <div className="space-y-2">
              {items.map((item, idx) => (
                <div key={idx} className="px-3 py-2 bg-neutral-50 rounded-lg border border-neutral-200">
                  <div className="text-sm font-medium text-neutral-900">{item.itemName}</div>
                  <div className="text-xs text-neutral-500 mt-1">
                    {fmtNum(item.qty, 0)} units = {item.packages} pkg{item.packages !== 1 ? 's' : ''}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="modal-footer border-t border-neutral-200">
          <button onClick={onClose} className="btn-primary w-full">Close</button>
        </div>
      </div>
    </div>
  );
}

// ── Voucher Selector ──────────────────────────────────────────────────────────
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
      {/* Tabs */}
      <div className="flex gap-2 border-b border-neutral-200 pb-4">
        {(["Sales", "Delivery Note"] as VoucherTab[]).map((t) => (
          <button
            key={t}
            onClick={() => handleTabChange(t)}
            className={clsx(
              "px-4 py-2.5 rounded-lg text-sm font-medium transition-all border-b-2",
              tab === t
                ? "border-blue-500 text-blue-600 bg-blue-50"
                : "border-transparent text-neutral-600 hover:text-neutral-900"
            )}
          >
            {t}
          </button>
        ))}
      </div>

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
        <span className="text-xs font-semibold text-neutral-600 whitespace-nowrap px-3 py-1.5 bg-neutral-100 rounded-lg">
          {filtered.length} found
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="py-12 text-center text-neutral-500 text-sm">
          No {tab === "Delivery Note" ? "delivery notes" : "sales vouchers"} found
        </div>
      ) : (
        <>
          <div className="border border-neutral-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50">
                  <th className="text-left px-4 py-3 font-semibold text-neutral-700 w-8"></th>
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
                        "cursor-pointer transition-colors",
                        isSelected
                          ? "bg-blue-50 hover:bg-blue-100"
                          : "hover:bg-neutral-50"
                      )}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="radio"
                          readOnly
                          checked={isSelected}
                          className="accent-blue-500"
                        />
                      </td>
                      <td className="px-4 py-3 font-mono text-xs font-medium text-blue-600">
                        {v.voucherNumber}
                      </td>
                      <td className="px-4 py-3 text-sm text-neutral-600">
                        {fmtDate(v.date)}
                      </td>
                      <td className="px-4 py-3 text-sm text-neutral-900 truncate max-w-xs">
                        {v.partyName ?? v.partyLedgerId ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-semibold text-neutral-900">
                        {fmtINR(v.totalAmount)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 flex-wrap">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-3 py-2 text-sm rounded-lg border border-neutral-200 disabled:opacity-40 hover:bg-neutral-100 font-medium"
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
                        : "border border-neutral-200 hover:bg-neutral-100"
                    )}
                  >
                    {pageNum + 1}
                  </button>
                );
              })}
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page === totalPages - 1}
                className="px-3 py-2 text-sm rounded-lg border border-neutral-200 disabled:opacity-40 hover:bg-neutral-100 font-medium"
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

// ── Discount Breakdown (Group-wise) ──────────────────────────────────────────
function DiscountBreakdown({
  voucher,
  result,
  manualOverrides,
  onSetOverride,
  onClearOverride,
}: {
  voucher: CanonicalVoucher;
  result: any;
  manualOverrides: Record<string, number>;
  onSetOverride: (itemName: string, pct: number) => void;
  onClearOverride: (itemName: string) => void;
}) {
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [groupsOpen, setGroupsOpen] = useState(true);
  const [itemsOpen, setItemsOpen] = useState(true);
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingItem && inputRef.current) inputRef.current.select();
  }, [editingItem]);

  function startEdit(itemName: string, currentPct: number) {
    setEditingItem(itemName);
    setEditValue(String(currentPct));
  }

  function commitEdit(itemName: string) {
    const val = parseFloat(editValue);
    if (!isNaN(val) && val >= 0 && val <= 100) {
      onSetOverride(itemName, val);
    }
    setEditingItem(null);
  }

  if (!result) return null;

  return (
    <div className="card space-y-8">
      {/* Voucher Header */}
      <div className="pb-6 border-b border-neutral-200">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-black text-xl text-neutral-900">
              {voucher.partyName ?? voucher.partyLedgerId ?? "—"}
            </div>
            <div className="flex items-center gap-3 mt-2.5">
              <span className="px-3 py-1 bg-neutral-100 rounded-md text-xs font-bold text-neutral-700 uppercase tracking-wide">
                {voucher.voucherType}
              </span>
              <span className="text-sm font-mono font-semibold text-blue-600">{voucher.voucherNumber}</span>
            </div>
            <div className="text-sm text-neutral-500 mt-2">{fmtDate(voucher.date)}</div>
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-xs text-neutral-500 font-medium uppercase tracking-wide">Invoice Total</div>
            <div className="text-xl font-black text-neutral-900 mt-1 tabular-nums">{fmtINR(voucher.totalAmount)}</div>
          </div>
        </div>
      </div>

      {result.groupSummaries && result.groupSummaries.length > 0 ? (
        <>
          {/* Total Discount Summary */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-0 bg-gradient-to-br from-green-50 to-emerald-50 rounded-xl border-2 border-green-200 overflow-hidden">
            <div className="text-center px-6 py-5">
              <div className="text-xs font-bold text-green-700 uppercase tracking-wide">Subtotal</div>
              <div className="text-2xl font-black text-green-900 mt-2 tabular-nums">{fmtINR(result.totalLineAmount)}</div>
            </div>
            <div className="text-center px-6 py-5 border-y sm:border-y-0 sm:border-x border-green-200">
              <div className="text-xs font-bold text-green-700 uppercase tracking-wide">Total Discount</div>
              <div className="text-2xl font-black text-green-900 mt-2 tabular-nums">−{fmtINR(result.totalDiscountAmount)}</div>
            </div>
            <div className="text-center px-6 py-5">
              <div className="text-xs font-bold text-green-700 uppercase tracking-wide">Effective Rate</div>
              <div className="text-2xl font-black text-green-900 mt-2 tabular-nums">{fmtNum(result.effectivePct, 2)}%</div>
            </div>
          </div>

          {/* Group Summary Cards */}
          <div className="space-y-5">
            <button
              onClick={() => setGroupsOpen((o) => !o)}
              className="flex items-center gap-3 w-full text-left group"
            >
              <div className="h-1 w-4 bg-blue-500 rounded-full flex-shrink-0"></div>
              <div className="text-sm font-bold text-neutral-900 uppercase tracking-wider flex-1">
                Discount by Category (Group-wise)
              </div>
              <ChevronDown
                size={16}
                className={clsx("text-neutral-400 transition-transform duration-200", groupsOpen ? "rotate-0" : "-rotate-90")}
              />
            </button>
            {groupsOpen && <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {result.groupSummaries.map((group: any) => (
                <div
                  key={group.categoryId}
                  onClick={() => setSelectedGroup(group.categoryId)}
                  className={clsx(
                    "p-5 rounded-xl border-2 cursor-pointer hover:shadow-lg transition-all",
                    group.groupRuleApplied
                      ? "border-blue-400 bg-blue-50 hover:bg-blue-100"
                      : "border-neutral-200 bg-white hover:shadow-md"
                  )}
                >
                  {/* Card Header */}
                  <div className="flex items-start justify-between gap-4 mb-4">
                    <div>
                      <div className="font-bold text-base text-neutral-900">{group.categoryName}</div>
                      <div className="text-xs text-neutral-500 mt-1.5 font-medium">
                        {group.totalPackages} package{group.totalPackages !== 1 ? 's' : ''} total
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className={clsx(
                        "text-2xl font-black leading-none",
                        group.appliedDiscountPct > 0 ? "text-green-600" : "text-neutral-400"
                      )}>
                        {group.appliedDiscountPct.toFixed(1)}%
                      </div>
                      <div className="text-xs text-neutral-500 mt-1">discount</div>
                    </div>
                  </div>

                  {/* Amounts */}
                  <div className="space-y-2 mb-4">
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-neutral-600">Subtotal</span>
                      <span className="font-semibold text-neutral-900 tabular-nums">{fmtINR(group.totalAmount)}</span>
                    </div>
                    <div className="flex justify-between items-center text-sm pt-2 border-t border-neutral-200">
                      <span className="text-green-700 font-semibold">Discount</span>
                      <span className="font-bold text-green-700 tabular-nums">−{fmtINR(group.totalDiscount)}</span>
                    </div>
                  </div>

                  {/* Tier Badges */}
                  <div className="space-y-2">
                    {group.baseTierInfo && (
                      <div className="px-3 py-2 bg-neutral-100 rounded-lg border border-neutral-200">
                        <div className="text-xs text-neutral-500 font-semibold uppercase tracking-wide mb-0.5">Base Tier</div>
                        <div className="text-sm font-semibold text-neutral-800">{group.baseTierInfo}</div>
                      </div>
                    )}
                    {group.groupRuleApplied && (
                      <div className="px-3 py-2 bg-blue-100 rounded-lg border border-blue-300">
                        <div className="text-xs text-blue-700 font-bold uppercase tracking-wide mb-0.5">Group Rule Applied</div>
                        <div className="text-sm font-bold text-blue-900">{group.groupRuleApplied}</div>
                        <div className="text-xs text-blue-700 mt-0.5">Upgraded → {group.appliedDiscountPct}%</div>
                      </div>
                    )}
                  </div>

                  <button
                    className="mt-4 w-full text-xs font-semibold text-blue-600 hover:text-blue-800 py-2 px-3 rounded-lg hover:bg-blue-50 border border-blue-200 transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedGroup(group.categoryId);
                    }}
                  >
                    View Items in Group →
                  </button>
                </div>
              ))}
            </div>}
          </div>

          {/* Items Breakdown */}
          <div className="space-y-4 pt-2">
            <button
              onClick={() => setItemsOpen((o) => !o)}
              className="flex items-center gap-3 w-full text-left group"
            >
              <div className="h-1 w-4 bg-neutral-400 rounded-full flex-shrink-0"></div>
              <div className="text-sm font-bold text-neutral-900 uppercase tracking-wider flex-1">
                Items in Invoice
              </div>
              <ChevronDown
                size={16}
                className={clsx("text-neutral-400 transition-transform duration-200", itemsOpen ? "rotate-0" : "-rotate-90")}
              />
            </button>
            {itemsOpen && <div className="border border-neutral-200 rounded-lg overflow-hidden bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 bg-neutral-50">
                    <th className="text-left px-5 py-4 font-bold text-neutral-800">Item</th>
                    <th className="text-right px-5 py-4 font-bold text-neutral-800">Qty</th>
                    <th className="text-left px-5 py-4 font-bold text-neutral-800">Category</th>
                    <th className="text-right px-5 py-4 font-bold text-neutral-800">Amount</th>
                    <th className="text-center px-5 py-4 font-bold text-neutral-800">Disc%</th>
                    <th className="text-right px-5 py-4 font-bold text-neutral-800">Discount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {result.lines.map((line: any, idx: number) => (
                    <tr
                      key={idx}
                      className={clsx(
                        "transition-colors",
                        line.discountPct > 0 ? "bg-green-50 hover:bg-green-100" : "bg-white hover:bg-neutral-50"
                      )}
                    >
                      <td className="px-5 py-4 text-neutral-900 font-semibold">{line.itemName}</td>
                      <td className="px-5 py-4 text-right text-neutral-700">
                        <div className="font-semibold tabular-nums">{fmtNum(line.qtyBase, 0)}</div>
                        <div className="text-xs text-neutral-500 mt-1">
                          {line.packages} pkg{line.packages !== 1 ? 's' : ''}
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <span className={clsx(
                          "inline-block px-3 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap",
                          line.categoryId === "NO_DISCOUNT"
                            ? "bg-neutral-100 text-neutral-700"
                            : "bg-blue-100 text-blue-800"
                        )}>
                          {line.categoryName}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-right font-bold text-neutral-900 tabular-nums">
                        {fmtINR(line.lineAmount)}
                      </td>
                      <td className="px-5 py-4 text-center">
                        {editingItem === line.itemName ? (
                          <input
                            ref={inputRef}
                            type="number"
                            min="0"
                            max="100"
                            step="0.5"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={() => commitEdit(line.itemName)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitEdit(line.itemName);
                              if (e.key === "Escape") setEditingItem(null);
                            }}
                            className="w-16 text-center font-bold border-2 border-blue-400 rounded-md px-1 py-0.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                          />
                        ) : (
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={() => startEdit(line.itemName, line.discountPct)}
                              className={clsx(
                                "font-bold tabular-nums px-2 py-0.5 rounded hover:ring-2 hover:ring-blue-300 transition-all",
                                manualOverrides[line.itemName] !== undefined
                                  ? "text-amber-700 bg-amber-50 ring-1 ring-amber-300"
                                  : line.discountPct > 0
                                  ? "text-green-700 hover:bg-green-50"
                                  : "text-neutral-400 hover:bg-neutral-50"
                              )}
                              title="Click to override"
                            >
                              {line.discountPct > 0 ? `${line.discountPct}%` : "—"}
                            </button>
                            {manualOverrides[line.itemName] !== undefined && (
                              <button
                                onClick={() => onClearOverride(line.itemName)}
                                className="text-neutral-400 hover:text-red-500 transition-colors"
                                title="Clear override"
                              >
                                <RotateCcw size={11} />
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                      <td className={clsx(
                        "px-5 py-4 text-right font-bold tabular-nums",
                        manualOverrides[line.itemName] !== undefined
                          ? "text-amber-700"
                          : line.discountPct > 0 ? "text-green-700" : "text-neutral-400"
                      )}>
                        {line.discountPct > 0 ? fmtINR(line.discountAmount) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>}
          </div>

        </>
      ) : (
        <div className="py-16 text-center text-neutral-500">
          No items with discounts in this invoice
        </div>
      )}

      {/* Group Details Modal */}
      {selectedGroup && (
        <GroupDetailsModal
          isOpen={true}
          onClose={() => setSelectedGroup(null)}
          groupName={result.groupSummaries.find((g: any) => g.categoryId === selectedGroup)?.categoryName || ""}
          totalPackages={result.groupSummaries.find((g: any) => g.categoryId === selectedGroup)?.totalPackages || 0}
          items={result.lines
            .filter((line: any) => line.categoryId === selectedGroup)
            .map((line: any) => ({
              itemName: line.itemName,
              qty: line.qtyBase,
              packages: line.packages,
            }))}
        />
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function Discounts() {
  const navigate = useNavigate();
  const { data } = useDataStore();
  const { categories, itemCategoryOverrides } = useDiscountStore();

  const [selectedVoucherId, setSelectedVoucherId] = useState<string | null>(null);
  const [manualOverrides, setManualOverrides] = useState<Record<string, number>>({});

  const vouchers = useMemo(
    () => (data?.vouchers ?? []).filter((v) => !v.isCancelled && !v.isOptional),
    [data]
  );

  const selectedVoucher = useMemo(
    () => (selectedVoucherId ? vouchers.find((v) => v.voucherId === selectedVoucherId) ?? null : null),
    [vouchers, selectedVoucherId]
  );

  // Reset manual overrides when switching vouchers
  useEffect(() => {
    setManualOverrides({});
  }, [selectedVoucherId]);

  const discountResult = useMemo(() => {
    if (!selectedVoucher || !data) return null;
    return calculateVoucherDiscount(
      selectedVoucher,
      data.items,
      categories,
      itemCategoryOverrides
    );
  }, [selectedVoucher, data, categories, itemCategoryOverrides]);

  // Apply manual overrides on top of calculated result
  const displayResult = useMemo(() => {
    if (!discountResult) return null;
    if (Object.keys(manualOverrides).length === 0) return discountResult;

    const lines = discountResult.lines.map((line: any) => {
      const pct = manualOverrides[line.itemName];
      if (pct === undefined) return line;
      return {
        ...line,
        discountPct: pct,
        discountAmount: (line.lineAmount * pct) / 100,
        tierLabel: `Manual: ${pct}%`,
      };
    });

    // Recalculate group summary totals
    const groupSummaries = discountResult.groupSummaries.map((g: any) => {
      const groupLines = lines.filter((l: any) => l.categoryId === g.categoryId);
      const totalDiscount = groupLines.reduce((s: number, l: any) => s + l.discountAmount, 0);
      return { ...g, totalDiscount };
    });

    const totalDiscountAmount = lines.reduce((s: number, l: any) => s + l.discountAmount, 0);
    const effectivePct = discountResult.totalLineAmount > 0
      ? (totalDiscountAmount / discountResult.totalLineAmount) * 100
      : 0;

    return { ...discountResult, lines, groupSummaries, totalDiscountAmount, effectivePct };
  }, [discountResult, manualOverrides]);

  function handleSetOverride(itemName: string, pct: number) {
    setManualOverrides((prev) => ({ ...prev, [itemName]: pct }));
  }

  function handleClearOverride(itemName: string) {
    setManualOverrides((prev) => {
      const next = { ...prev };
      delete next[itemName];
      return next;
    });
  }

  if (!data) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon text-5xl">%</div>
        <h2 className="empty-state-title">No Data Loaded</h2>
        <p className="empty-state-description">Import your Tally data to calculate discounts</p>
        <button onClick={() => navigate("/import")} className="btn-primary mt-2">
          <Upload size={14} /> Import Data
        </button>
      </div>
    );
  }

  return (
    <div className="page-section">
      {/* Header */}
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h1 className="page-title">Discounts</h1>
            <p className="page-subtitle">Group-wise automatic discounts for Sales invoices</p>
          </div>
          <button onClick={() => navigate("/discount-rules")} className="btn-secondary">
            <Pencil size={16} /> Edit Rules
          </button>
        </div>
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
      {selectedVoucher && displayResult && (
        <div className="mb-8">
          <DiscountBreakdown
            voucher={selectedVoucher}
            result={displayResult}
            manualOverrides={manualOverrides}
            onSetOverride={handleSetOverride}
            onClearOverride={handleClearOverride}
          />
        </div>
      )}
    </div>
  );
}
