import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Upload, Truck, X, PackageCheck } from "lucide-react";
import clsx from "clsx";
import { useDataStore } from "../store/dataStore";
import { useUIStore } from "../store/uiStore";
import { fmtINR, fmtDate } from "../utils/format";
import { getCurrentStockIndexed } from "../engine/inventory";
import type { ItemMarginData } from "../engine/financial";
import type { CanonicalVoucher, ParsedData } from "../types/canonical";
import type { VoucherIndex } from "../engine/inventory";
import { useTallyPriceListStore, type TallyPriceEntry } from "../store/tallyPriceListStore";
import { RatePill, AmountPill, priceMatches, PRICE_TOLERANCE } from "../components/PriceVerification";

function getPriceList(
  data: ParsedData,
  tallyEntries: Record<string, TallyPriceEntry>,
  precomputedMargins: Map<string, ItemMarginData> | null,
): Map<string, number> {
  const map = new Map<string, number>();
  const hasTally = Object.keys(tallyEntries).length > 0;

  for (const [itemId, item] of data.items) {
    // 1. Tally rate takes priority when available
    if (hasTally) {
      const entry = tallyEntries[item.name.toUpperCase()];
      if (entry && entry.sellingRate > 0) {
        map.set(itemId, entry.sellingRate);
        continue;
      }
    }
    // 2. Use pre-computed margins (avoids O(items × vouchers) on every navigation)
    const m = precomputedMargins?.get(itemId);
    const rate = m && m.avgSalesRate > 0
      ? m.avgSalesRate
      : (item.closingRate ?? item.openingRate ?? 0);
    if (rate > 0) map.set(itemId, rate);
  }
  return map;
}

/** Compute delivery-readiness for a voucher.
 *  @param stockCache — pre-computed Map<itemId, currentStock> for O(1) lookup.
 *    When omitted, falls back to calling getCurrentStockIndexed per line (slow path).
 */
function computeReadiness(
  voucher: CanonicalVoucher,
  data: ParsedData,
  voucherIndex: VoucherIndex,
  priceList: Map<string, number>,
  stockCache?: Map<string, number>,
) {
  const inv = voucher.lines.filter((l) => l.type === "inventory");
  let allInStock = true;
  let allPricesMatch = true;
  for (const line of inv) {
    const item = line.itemId ? data.items.get(line.itemId) : null;
    const qty = line.qtyBase ?? 0;
    const rate = line.ratePerBase ?? 0;
    let stock: number | null;
    if (stockCache && line.itemId) {
      stock = stockCache.has(line.itemId) ? stockCache.get(line.itemId)! : null;
    } else {
      stock = item ? getCurrentStockIndexed(item, voucherIndex) : null;
    }
    if (stock === null || stock < qty) allInStock = false;
    const ref = line.itemId ? (priceList.get(line.itemId) ?? 0) : 0;
    if (ref > 0 && !priceMatches(rate, ref)) allPricesMatch = false;
  }
  // Ready-to-deliver criterion: ALL items in stock. Price-match is informational
  // only — a DN can ship even if billed rates differ from the price list.
  // (Was: ready = allInStock && allPricesMatch — relaxed 2026-05-23 per user.)
  return { allInStock, allPricesMatch, ready: allInStock };
}

export default function PendingOrders() {
  const navigate = useNavigate();
  const data = useDataStore((s) => s.data);
  const voucherIndex = useDataStore((s) => s.voucherIndex);
  const itemMargins = useDataStore((s) => s.itemMargins);
  const { isMobile } = useUIStore();
  const { entries: tallyEntries } = useTallyPriceListStore();
  const [selected, setSelected] = useState<CanonicalVoucher | null>(null);

  const deliveryNotes = useMemo(() => {
    if (!data) return [];
    return data.vouchers
      .filter((v) => v.voucherType === "Delivery Note" && !v.isCancelled && !v.isOptional)
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [data]);

  const priceList = useMemo(
    () => data ? getPriceList(data, tallyEntries, itemMargins) : new Map<string, number>(),
    [data, tallyEntries, itemMargins],
  );

  // Pre-compute current stock for only the items that appear in pending delivery notes.
  // This collapses O(notes × lines × vouchers_per_item) → O(unique_items × vouchers_per_item).
  const stockCache = useMemo(() => {
    if (!data) return new Map<string, number>();
    const relevant = new Set<string>();
    for (const note of deliveryNotes) {
      for (const line of note.lines) {
        if (line.type === "inventory" && line.itemId) relevant.add(line.itemId);
      }
    }
    const cache = new Map<string, number>();
    for (const itemId of relevant) {
      const item = data.items.get(itemId);
      if (item) cache.set(itemId, getCurrentStockIndexed(item, voucherIndex));
    }
    return cache;
  }, [data, deliveryNotes, voucherIndex]);

  // Pre-compute readiness for all notes once — avoids per-row recomputation during render
  const readinessMap = useMemo(() => {
    if (!data) return new Map<string, ReturnType<typeof computeReadiness>>();
    const map = new Map<string, ReturnType<typeof computeReadiness>>();
    for (const note of deliveryNotes) {
      map.set(note.voucherId, computeReadiness(note, data, voucherIndex, priceList, stockCache));
    }
    return map;
  }, [deliveryNotes, data, voucherIndex, priceList, stockCache]);

  // Close modal on Escape
  useEffect(() => {
    if (!selected) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selected]);

  if (!data) {
    return (
      <div className="empty-state">
        <Truck size={48} className="empty-state-icon" />
        <h2 className="empty-state-title">No Data Loaded</h2>
        <button onClick={() => navigate("/import")} className="btn-primary mt-2">
          <Upload size={14} /> Import Data
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="page-section">
        <div className="page-header">
          <h1 className="page-title">Pending Orders</h1>
        </div>

        {isMobile
          ? <MobileList notes={deliveryNotes} data={data!} voucherIndex={voucherIndex} priceList={priceList} readinessMap={readinessMap} onSelect={setSelected} />
          : <DesktopTable notes={deliveryNotes} data={data!} voucherIndex={voucherIndex} priceList={priceList} readinessMap={readinessMap} onSelect={setSelected} />}
      </div>

      {/* Modal */}
      {selected && (
        <DNModal voucher={selected} data={data} voucherIndex={voucherIndex} priceList={priceList} stockCache={stockCache} onClose={() => setSelected(null)} />
      )}
    </>
  );
}

/* ─── Modal popup ─────────────────────────────────────── */
function DNModal({ voucher, data, voucherIndex, priceList, stockCache, onClose }: {
  voucher: CanonicalVoucher;
  data: ParsedData;
  voucherIndex: VoucherIndex;
  priceList: Map<string, number>;
  stockCache?: Map<string, number>;
  onClose: () => void;
}) {
  const inv = voucher.lines.filter((l) => l.type === "inventory");
  const led = voucher.lines.filter((l) => l.type === "ledger");
  const { allInStock, allPricesMatch, ready } = computeReadiness(voucher, data, voucherIndex, priceList, stockCache);
  const totalBilled = inv.reduce((s, l) => s + (l.lineAmount ?? 0), 0);
  const totalList = inv.reduce((s, l) => {
    const refRate = l.itemId ? (priceList.get(l.itemId) ?? 0) : 0;
    const qty = l.qtyBase ?? 0;
    return s + (qty * refRate);
  }, 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={`Delivery Note ${voucher.voucherNumber}`}
      onClick={onClose}
    >
      {/* Panel */}
      <div
        className="relative bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden animate-modal-pop"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b border-neutral-200 bg-gradient-to-r from-neutral-50 to-white">
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-3 flex-wrap mb-2">
              <h2 className="text-lg font-bold text-neutral-950">
                {voucher.partyName ?? "Delivery Note"}
              </h2>
              <span className="text-xs font-mono text-neutral-500 bg-neutral-100 px-2.5 py-1 rounded-md">
                {voucher.voucherNumber}
              </span>
            </div>
            <div className="text-sm text-neutral-600">
              <span className="font-medium">{fmtDate(voucher.date)}</span>
              {voucher.narration && (
                <>
                  <span className="mx-2 text-neutral-300">·</span>
                  <span className="italic text-neutral-500">{voucher.narration}</span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3 ml-6 flex-shrink-0">
            {ready ? (
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-success/10 text-success-600 text-xs font-semibold border border-success/20">
                <PackageCheck size={14} className="flex-shrink-0" />
                <span>Ready to Deliver</span>
                {!allPricesMatch && (
                  <span
                    className="ml-1 px-1.5 py-0.5 rounded bg-warn/10 text-warn-700 text-[10px] font-medium"
                    title="All items in stock — but billed rates differ from the price list"
                  >
                    rate Δ
                  </span>
                )}
              </div>
            ) : (
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-neutral-100 text-neutral-700 text-xs font-medium border border-neutral-200">
                <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-warn" />
                <span>Stock issues</span>
              </div>
            )}
            <button onClick={onClose} className="btn-icon flex-shrink-0" aria-label="Close delivery note">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-6">
          {/* Items table */}
          {inv.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-neutral-900 mb-4 flex items-center gap-2">
                <Truck size={16} className="text-neutral-500 flex-shrink-0" />
                Items for Delivery
              </h3>
              <div className="overflow-x-auto border border-neutral-200 rounded-xl">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="bg-neutral-50 border-b border-neutral-200">
                      <th className="px-4 py-3 text-left font-semibold text-neutral-700 text-xs uppercase tracking-wide">Item Name</th>
                      <th className="px-4 py-3 text-right font-semibold text-neutral-700 text-xs uppercase tracking-wide whitespace-nowrap w-20">Qty</th>
                      <th className="px-4 py-3 text-right font-semibold text-neutral-700 text-xs uppercase tracking-wide whitespace-nowrap">Rate</th>
                      <th className="px-4 py-3 text-right font-semibold text-neutral-700 text-xs uppercase tracking-wide whitespace-nowrap">Amount</th>
                      <th className="px-4 py-3 text-center font-semibold text-neutral-700 text-xs uppercase tracking-wide whitespace-nowrap">Stock Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inv.map((line, i) => {
                      const item = line.itemId ? data.items.get(line.itemId) : null;
                      const name = item?.name ?? line.itemId ?? "Unknown";
                      const qty = line.qtyBase ?? 0;
                      const rate = line.ratePerBase ?? 0;
                      const amt = line.lineAmount ?? qty * rate;
                      const stock = (stockCache && line.itemId)
                        ? (stockCache.has(line.itemId) ? stockCache.get(line.itemId)! : null)
                        : (item ? getCurrentStockIndexed(item, voucherIndex) : null);
                      const inStock = stock !== null && stock >= qty;
                      const stockLabel = stock === null ? null
                        : stock >= qty ? `${stock} in stock`
                        : stock > 0 ? `only ${stock} in stock`
                        : stock === 0 ? "out of stock"
                        : `${stock} (short by ${Math.abs(stock)})`;
                      const refRate = line.itemId ? (priceList.get(line.itemId) ?? 0) : 0;
                      const refAmt = qty * refRate;
                      return (
                        <tr key={i} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50/50 transition-colors duration-75">
                          <td className="px-4 py-3 text-neutral-900 font-medium max-w-xs">
                            <span title={name} className="block truncate">{name}</span>
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-neutral-700 whitespace-nowrap">
                            {qty} {item?.baseUnit ? <span className="text-2xs text-neutral-500">{item.baseUnit}</span> : ""}
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            <RatePill rate={rate} refRate={refRate} />
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            <AmountPill billedAmt={amt} listAmt={refAmt} />
                          </td>
                          <td className="px-4 py-3 text-center">
                            {stockLabel && (
                              <span className={clsx(
                                "text-2xs inline-flex items-center gap-1 px-2 py-1 rounded-full font-medium whitespace-nowrap",
                                inStock ? "bg-success/10 text-success-600 border border-success/20" : "bg-danger/10 text-danger-600 border border-danger/20"
                              )}>
                                <span className="flex-shrink-0 w-1 h-1 rounded-full bg-current" />
                                {stockLabel}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {inv.length > 0 && (
                    <tfoot>
                      <tr className="bg-neutral-50 border-t border-neutral-200 font-semibold">
                        <td colSpan={3} className="px-4 py-3 text-right text-neutral-900 text-lg">Total Amount</td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          <AmountPill billedAmt={totalBilled} listAmt={totalList} isTotal={true} />
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          )}

          {/* Ledger entries */}
          {led.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-neutral-900 mb-3">Ledger Entries</h3>
              <div className="space-y-2 bg-neutral-50 rounded-xl p-4 border border-neutral-200">
                {led.map((line, i) => {
                  const name = line.ledgerId
                    ? (data.ledgers.get(line.ledgerId)?.name ?? line.ledgerId) : "";
                  return (
                    <div key={i} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <span className={clsx(
                          "text-xs font-semibold flex-shrink-0 px-2 py-0.5 rounded-md",
                          line.isDebit ? "bg-blue-100 text-blue-700" : "bg-orange-100 text-orange-700"
                        )}>
                          {line.isDebit ? "Dr" : "Cr"}
                        </span>
                        <span className="text-neutral-700 truncate">{name}</span>
                      </div>
                      <span className="text-neutral-900 font-semibold tabular-nums flex-shrink-0 ml-3">
                        {fmtINR(line.amount ?? 0)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!inv.length && !led.length && (
            <div className="text-center py-8">
              <Truck size={32} className="text-neutral-300 mx-auto mb-3" />
              <p className="text-neutral-500 text-sm">No line details available.</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-neutral-200 bg-neutral-50 flex items-center justify-between">
          <div className="text-xs text-neutral-600">
            {inv.length} item{inv.length !== 1 ? "s" : ""} · {led.length} ledger entr{led.length !== 1 ? "ies" : "y"}
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-neutral-200 hover:bg-neutral-300 active:bg-neutral-400 text-neutral-900 font-medium text-sm transition-colors duration-150 cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Desktop table ───────────────────────────────────── */
function DesktopTable({ notes, data: _data, voucherIndex: _vi, priceList: _pl, readinessMap, onSelect }: {
  notes: CanonicalVoucher[];
  data: ParsedData;
  voucherIndex: VoucherIndex;
  priceList: Map<string, number>;
  readinessMap: Map<string, ReturnType<typeof computeReadiness>>;
  onSelect: (v: CanonicalVoucher) => void;
}) {
  const COL = "90px 120px 1fr 60px 140px 110px";

  return (
    <div className="section-card overflow-hidden">
      {notes.length === 0 ? (
        <div className="empty-state py-10">
          <Truck size={32} className="empty-state-icon" />
          <span className="empty-state-description">No delivery notes found</span>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="grid table-header-sticky" style={{ gridTemplateColumns: COL, minWidth: 620 }}>
            {["Date", "DN#", "Party", "Pkgs", "", "Value"].map((h, i) => (
              <div key={i} className={clsx("px-3 py-2", (h === "Value" || h === "Pkgs") && "text-right")}>{h}</div>
            ))}
          </div>
          <div className="overflow-y-auto max-h-[calc(100vh-240px)]" style={{ minWidth: 620 }}>
            {notes.map((v) => {
              const { ready } = readinessMap.get(v.voucherId) ?? { ready: false };
              const totalPkgs = v.lines
                .filter((l) => l.type === "inventory")
                .reduce((s, l) => s + (l.qtyBase ?? 0), 0);
              return (
                <div
                  key={v.voucherId}
                  className="grid items-center border-b border-bg-border/50 last:border-0 cursor-pointer hover:bg-neutral-50 transition-colors duration-150"
                  style={{ gridTemplateColumns: COL }}
                  onClick={() => onSelect(v)}
                >
                  <div className="px-3 py-2.5 text-xs text-muted whitespace-nowrap">
                    {fmtDate(v.date)}
                  </div>
                  <div className="px-3 py-2.5 text-xs font-mono text-primary truncate">
                    {v.voucherNumber}
                  </div>
                  <div className="px-3 py-2.5 min-w-0">
                    <div className="text-sm font-medium text-primary truncate">{v.partyName ?? "—"}</div>
                    {v.narration && (
                      <div className="text-xs text-muted truncate">{v.narration}</div>
                    )}
                  </div>
                  <div className="px-3 py-2.5 text-right">
                    {totalPkgs > 0 && (
                      <span className="text-xs font-semibold tabular-nums text-neutral-700">{totalPkgs}</span>
                    )}
                  </div>
                  <div className="px-3 py-2.5">
                    {ready && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold bg-green-100 text-green-700 px-2 py-0.5 rounded-full whitespace-nowrap">
                        <PackageCheck size={11} />
                        Ready to Deliver
                      </span>
                    )}
                  </div>
                  <div className="px-3 py-2.5 text-sm tabular-nums font-medium text-primary text-right whitespace-nowrap">
                    {fmtINR(v.totalAmount)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Mobile card list ────────────────────────────────── */
function MobileList({ notes, data: _data, voucherIndex: _vi, priceList: _pl, readinessMap, onSelect }: {
  notes: CanonicalVoucher[];
  data: ParsedData;
  voucherIndex: VoucherIndex;
  priceList: Map<string, number>;
  readinessMap: Map<string, ReturnType<typeof computeReadiness>>;
  onSelect: (v: CanonicalVoucher) => void;
}) {
  if (!notes.length) {
    return (
      <div className="bento-card empty-state py-10">
        <Truck size={32} className="empty-state-icon" />
        <span className="empty-state-description">No delivery notes found</span>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {notes.map((v) => {
        const invLines = v.lines.filter((l) => l.type === "inventory");
        const itemCount = invLines.length;
        const totalPkgs = invLines.reduce((s, l) => s + (l.qtyBase ?? 0), 0);
        const { ready } = readinessMap.get(v.voucherId) ?? { ready: false };
        return (
          <div
            key={v.voucherId}
            className="bento-card !px-3 !py-2.5 cursor-pointer hover:bg-neutral-50 active:bg-neutral-100 transition-colors duration-150"
            onClick={() => onSelect(v)}
          >
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-sm font-medium text-primary truncate">
                    {v.partyName ?? v.voucherNumber}
                  </span>
                  <span className="text-2xs text-muted font-mono flex-shrink-0">{v.voucherNumber}</span>
                  {ready && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full flex-shrink-0">
                      <PackageCheck size={10} />
                      Ready
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted mt-0.5">
                  {fmtDate(v.date)}
                  {itemCount > 0 && <> · {itemCount} item{itemCount !== 1 ? "s" : ""}</>}
                  {totalPkgs > 0 && <> · <span className="font-semibold text-neutral-600">{totalPkgs} pkgs</span></>}
                  {v.narration && <> · <span className="italic">{v.narration}</span></>}
                </div>
              </div>
              <span className="text-sm tabular-nums font-semibold text-primary flex-shrink-0">
                {fmtINR(v.totalAmount)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
