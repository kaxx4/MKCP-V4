import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Pencil, Upload, ChevronDown, X } from "lucide-react";
import clsx from "clsx";
import { useDataStore } from "../store/dataStore";
import { useDiscountStore } from "../store/discountStore";
import { calculateVoucherDiscount, DEFAULT_DISCOUNT_CATEGORIES } from "../engine/discounts";
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-96 max-h-96 overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 flex-shrink-0">
          <h3 className="text-lg font-semibold text-neutral-900">{groupName}</h3>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-neutral-100"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Total Packages */}
          <div className="px-4 py-3 bg-blue-50 rounded-lg border border-blue-200">
            <div className="text-sm text-blue-700 font-medium">Total Packages in Group</div>
            <div className="text-2xl font-bold text-blue-900 mt-1">{totalPackages}</div>
          </div>

          {/* Items List */}
          <div>
            <div className="text-xs font-semibold text-neutral-600 uppercase tracking-wide mb-3">
              Items in This Group
            </div>
            <div className="space-y-2">
              {items.map((item, idx) => (
                <div key={idx} className="px-3 py-2 bg-neutral-50 rounded-lg border border-neutral-200">
                  <div className="text-sm font-medium text-neutral-900">{item.itemName}</div>
                  <div className="text-xs text-neutral-600 mt-1">
                    {fmtNum(item.qty, 0)} units = {item.packages} pkg{item.packages !== 1 ? 's' : ''}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-neutral-200 flex-shrink-0">
          <button
            onClick={onClose}
            className="w-full px-4 py-2 bg-blue-500 text-white rounded-lg font-medium hover:bg-blue-600 transition-colors"
          >
            Close
          </button>
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
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
    <div className="card space-y-4">
      <div className="flex gap-2">
        {(["Sales", "Delivery Note"] as VoucherTab[]).map((t) => (
          <button
            key={t}
            onClick={() => handleTabChange(t)}
            className={clsx(
              "px-4 py-2.5 rounded-lg text-sm font-medium transition-all",
              tab === t
                ? "bg-blue-500 text-white shadow-sm"
                : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
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
        <span className="text-xs font-medium text-neutral-500 whitespace-nowrap">
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
  items,
}: {
  voucher: CanonicalVoucher;
  result: any;
  items: Map<string, any>;
}) {
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);

  if (!result) return null;

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

      {result.groupSummaries && result.groupSummaries.length > 0 ? (
        <>
          {/* Total Discount Summary */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-5 bg-gradient-to-r from-green-50 to-emerald-50 rounded-lg border-2 border-green-200">
            <div className="text-center">
              <div className="text-sm font-medium text-green-700">Subtotal</div>
              <div className="text-2xl font-bold text-green-900 mt-2">{fmtINR(result.totalLineAmount)}</div>
            </div>
            <div className="text-center border-l border-r border-green-200">
              <div className="text-sm font-medium text-green-700">Total Discount</div>
              <div className="text-2xl font-bold text-green-900 mt-2">−{fmtINR(result.totalDiscountAmount)}</div>
            </div>
            <div className="text-center">
              <div className="text-sm font-medium text-green-700">Effective Rate</div>
              <div className="text-2xl font-bold text-green-900 mt-2">{fmtNum(result.effectivePct, 2)}%</div>
            </div>
          </div>

          {/* Group Summary Cards */}
          <div className="space-y-3">
            <div className="text-xs font-semibold text-neutral-600 uppercase tracking-wide">
              Discount by Category (Group-wise)
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {result.groupSummaries.map((group: any) => (
                <div
                  key={group.categoryId}
                  onClick={() => setSelectedGroup(group.categoryId)}
                  className={clsx(
                    "p-4 rounded-lg border-2 cursor-pointer hover:shadow-md transition-all",
                    group.groupRuleApplied
                      ? "border-blue-400 bg-blue-50"
                      : "border-neutral-200 bg-neutral-50 hover:bg-neutral-100"
                  )}
                >
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div>
                      <div className="font-semibold text-neutral-900">{group.categoryName}</div>
                      <div className="text-xs text-neutral-600 mt-1">{group.totalPackages} packages</div>
                    </div>
                    <div className="text-right">
                      <div className={clsx(
                        "text-lg font-bold",
                        group.appliedDiscountPct > 0 ? "text-green-600" : "text-neutral-500"
                      )}>
                        {group.appliedDiscountPct.toFixed(1)}%
                      </div>
                      <div className="text-xs text-neutral-600 mt-1">discount</div>
                    </div>
                  </div>
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between text-neutral-600">
                      <span>Subtotal:</span>
                      <span className="font-medium text-neutral-900">{fmtINR(group.totalAmount)}</span>
                    </div>
                    <div className="flex justify-between pt-1 border-t border-neutral-200">
                      <span className="text-green-700 font-medium">Discount:</span>
                      <span className="font-semibold text-green-700">−{fmtINR(group.totalDiscount)}</span>
                    </div>

                    {/* Discount Tier Display */}
                    <div className="pt-2 space-y-1.5 border-t border-neutral-200">
                      {group.baseTierInfo && (
                        <div className="px-2.5 py-1.5 bg-neutral-100 rounded border border-neutral-300">
                          <div className="text-xs text-neutral-600 font-medium">Base Tier</div>
                          <div className="text-sm font-semibold text-neutral-900 mt-0.5">
                            {group.baseTierInfo}
                          </div>
                        </div>
                      )}

                      {/* Show if Group Rule was applied */}
                      {group.groupRuleApplied && (
                        <div className="px-2.5 py-1.5 bg-blue-200 rounded border border-blue-400">
                          <div className="text-xs text-blue-800 font-bold">🎯 {group.groupRuleApplied}</div>
                          <div className="text-sm font-bold text-blue-900 mt-0.5">
                            Upgraded to {group.appliedDiscountPct}%
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    className="mt-3 w-full text-xs font-medium text-blue-600 hover:text-blue-700 py-1.5 px-2 rounded hover:bg-blue-50"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedGroup(group.categoryId);
                    }}
                  >
                    View Items →
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Items Breakdown (collapsible) */}
          <div className="space-y-2">
            <div className="text-xs font-semibold text-neutral-600 uppercase tracking-wide">
              Items in Invoice
            </div>
            <div className="border border-neutral-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 bg-neutral-50">
                    <th className="text-left px-4 py-3 font-semibold text-neutral-700">Item</th>
                    <th className="text-right px-4 py-3 font-semibold text-neutral-700">Qty</th>
                    <th className="text-left px-4 py-3 font-semibold text-neutral-700">Category</th>
                    <th className="text-right px-4 py-3 font-semibold text-neutral-700">Amount</th>
                    <th className="text-center px-4 py-3 font-semibold text-neutral-700">Disc%</th>
                    <th className="text-right px-4 py-3 font-semibold text-neutral-700">Discount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {result.lines.map((line: any, idx: number) => (
                    <tr
                      key={idx}
                      className={clsx(
                        "transition-colors",
                        line.discountPct > 0 ? "bg-green-50 hover:bg-green-100" : "hover:bg-neutral-50"
                      )}
                    >
                      <td className="px-4 py-3 text-neutral-900 font-medium">{line.itemName}</td>
                      <td className="px-4 py-3 text-right text-neutral-700">
                        <div className="font-medium tabular-nums">{fmtNum(line.qtyBase, 0)}</div>
                        <div className="text-xs text-neutral-500 mt-0.5">
                          {line.packages} pkg{line.packages !== 1 ? 's' : ''}
                        </div>
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
                      <td className="px-4 py-3 text-right font-semibold text-neutral-900 tabular-nums">
                        {fmtINR(line.lineAmount)}
                      </td>
                      <td className={clsx(
                        "px-4 py-3 text-center font-semibold tabular-nums",
                        line.discountPct > 0 ? "text-green-600" : "text-neutral-500"
                      )}>
                        {line.discountPct > 0 ? `${line.discountPct}%` : "—"}
                      </td>
                      <td className={clsx(
                        "px-4 py-3 text-right font-semibold tabular-nums",
                        line.discountPct > 0 ? "text-green-600" : "text-neutral-500"
                      )}>
                        {line.discountPct > 0 ? fmtINR(line.discountAmount) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
        <div>
          <h1 className="page-title">Discounts</h1>
          <p className="text-sm text-neutral-600 mt-2">
            Group-wise automatic discounts for Sales invoices
          </p>
        </div>
        <button
          onClick={() => navigate("/discount-rules")}
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
            result={discountResult}
            items={data.items}
          />
        </div>
      )}
    </div>
  );
}
