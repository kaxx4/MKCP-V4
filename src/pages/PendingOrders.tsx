import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Upload, Truck, X, CheckCircle2, XCircle, PackageCheck } from "lucide-react";
import clsx from "clsx";
import { useDataStore } from "../store/dataStore";
import { useUIStore } from "../store/uiStore";
import { fmtINR, fmtRate, fmtDate } from "../utils/format";
import { getCurrentStockIndexed } from "../engine/inventory";
import { computeItemMargins } from "../engine/financial";
import type { CanonicalVoucher, ParsedData } from "../types/canonical";
import type { VoucherIndex } from "../engine/inventory";

// Price tolerance: ±1% to absorb Tally rounding and minor rate variations
const PRICE_TOLERANCE = 0.01;

function getPriceList(data: ParsedData): Map<string, number> {
  const margins = computeItemMargins(data.items, data.vouchers);
  const map = new Map<string, number>();
  for (const m of margins) {
    // Prefer avgSalesRate (actual billed history); fall back to Tally item rates
    const item = data.items.get(m.itemId);
    const rate = m.avgSalesRate > 0
      ? m.avgSalesRate
      : (item?.closingRate ?? item?.openingRate ?? 0);
    if (rate > 0) map.set(m.itemId, rate);
  }
  return map;
}

function priceMatches(rate: number, ref: number): boolean {
  if (ref <= 0) return true; // no reference — can't verify
  // Absolute ₹1 floor: avoids false mismatch on tiny rounding differences
  const absDiff = Math.abs(rate - ref);
  if (absDiff <= 1) return true;
  return absDiff / ref <= PRICE_TOLERANCE;
}

/** Compute delivery-readiness for a voucher */
function computeReadiness(voucher: CanonicalVoucher, data: ParsedData, voucherIndex: VoucherIndex, priceList: Map<string, number>) {
  const inv = voucher.lines.filter((l) => l.type === "inventory");
  let allInStock = true;
  let allPricesMatch = true;
  for (const line of inv) {
    const item = line.itemId ? data.items.get(line.itemId) : null;
    const qty = line.qtyBase ?? 0;
    const rate = line.ratePerBase ?? 0;
    const stock = item ? getCurrentStockIndexed(item, voucherIndex) : null;
    if (stock === null || stock < qty) allInStock = false;
    const ref = line.itemId ? (priceList.get(line.itemId) ?? 0) : 0;
    if (ref > 0 && !priceMatches(rate, ref)) allPricesMatch = false;
  }
  return { allInStock, allPricesMatch, ready: allInStock && allPricesMatch };
}

/** Click-to-toggle tooltip for price verification icons */
function PriceTooltip({ ok, billedRate, refRate }: { ok: boolean; billedRate: number; refRate: number }) {
  const [open, setOpen] = useState(false);
  const diff = billedRate - refRate;
  const pct = ((diff / refRate) * 100).toFixed(1);
  const sign = diff > 0 ? "+" : "";

  const label = ok
    ? `Price verified — matches price list (${fmtRate(refRate)})`
    : `Price mismatch — billed ${fmtRate(billedRate)}, price list ${fmtRate(refRate)} (${sign}${pct}%)`;

  return (
    <span className="relative inline-flex items-center">
      <span
        title={label}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="cursor-pointer"
      >
        {ok
          ? <CheckCircle2 size={14} className="text-blue-500 inline" />
          : <XCircle size={14} className="text-yellow-500 inline" />}
      </span>
      {open && (
        <span
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-50 w-max max-w-[220px] rounded-md bg-neutral-900 text-white text-[11px] leading-tight px-2 py-1.5 shadow-lg pointer-events-none whitespace-normal text-center"
        >
          {label}
          <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-neutral-900" />
        </span>
      )}
    </span>
  );
}

export default function PendingOrders() {
  const navigate = useNavigate();
  const { data, voucherIndex } = useDataStore();
  const { isMobile } = useUIStore();
  const [selected, setSelected] = useState<CanonicalVoucher | null>(null);

  const deliveryNotes = useMemo(() => {
    if (!data) return [];
    return data.vouchers
      .filter((v) => v.voucherType === "Delivery Note" && !v.isCancelled && !v.isOptional)
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [data]);

  const priceList = useMemo(() => data ? getPriceList(data) : new Map<string, number>(), [data]);

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
          ? <MobileList notes={deliveryNotes} data={data!} voucherIndex={voucherIndex} priceList={priceList} onSelect={setSelected} />
          : <DesktopTable notes={deliveryNotes} data={data!} voucherIndex={voucherIndex} priceList={priceList} onSelect={setSelected} />}
      </div>

      {/* Modal */}
      {selected && (
        <DNModal voucher={selected} data={data} voucherIndex={voucherIndex} priceList={priceList} onClose={() => setSelected(null)} />
      )}
    </>
  );
}

/* ─── Modal popup ─────────────────────────────────────── */
function DNModal({ voucher, data, voucherIndex, priceList, onClose }: {
  voucher: CanonicalVoucher;
  data: ParsedData;
  voucherIndex: VoucherIndex;
  priceList: Map<string, number>;
  onClose: () => void;
}) {
  const inv = voucher.lines.filter((l) => l.type === "inventory");
  const led = voucher.lines.filter((l) => l.type === "ledger");
  const { allInStock, allPricesMatch, ready } = computeReadiness(voucher, data, voucherIndex, priceList);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Delivery Note ${voucher.voucherNumber}`}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-neutral-200">
          <div>
            <div className="flex items-baseline gap-2">
              <h2 className="text-base font-semibold text-neutral-900">
                {voucher.partyName ?? voucher.voucherNumber}
              </h2>
              <span className="text-xs font-mono text-neutral-500">{voucher.voucherNumber}</span>
            </div>
            <div className="text-xs text-neutral-500 mt-0.5">
              {fmtDate(voucher.date)}
              {voucher.narration && <> · <span className="italic">{voucher.narration}</span></>}
            </div>
          </div>
          <div className="flex items-center gap-2 ml-4 flex-shrink-0">
            {ready ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-green-100 text-green-700 text-xs font-semibold">
                <PackageCheck size={13} />
                Ready to Deliver
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-neutral-100 text-neutral-500 text-xs font-medium">
                {!allInStock && "Stock issues"}
                {!allInStock && !allPricesMatch && " · "}
                {!allPricesMatch && "Price mismatch"}
              </span>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 transition-colors cursor-pointer"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
          {/* Items table */}
          {inv.length > 0 && (
            <div>
              <div className="text-xs font-medium text-neutral-500 mb-2 uppercase tracking-wide">Items</div>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-xs text-neutral-500">
                    <th className="pb-2 text-left font-medium pr-4">Item</th>
                    <th className="pb-2 text-right font-medium pr-4 w-24 whitespace-nowrap">Qty</th>
                    <th className="pb-2 text-right font-medium pr-4 w-28 whitespace-nowrap">Rate</th>
                    <th className="pb-2 text-center font-medium w-6" title="Price verified against price list" />
                    <th className="pb-2 text-right font-medium w-24 whitespace-nowrap">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {inv.map((line, i) => {
                    const item = line.itemId ? data.items.get(line.itemId) : null;
                    const name = item?.name ?? line.itemId ?? "Unknown";
                    const qty = line.qtyBase ?? 0;
                    const rate = line.ratePerBase ?? 0;
                    const amt = line.lineAmount ?? qty * rate;
                    const stock = item ? getCurrentStockIndexed(item, voucherIndex) : null;
                    const inStock = stock !== null && stock >= qty;
                    const rowBg = stock === null ? "" : inStock ? "bg-green-50" : "bg-red-50";
                    const stockLabel = stock === null ? null
                      : stock >= qty ? `${stock} in stock`
                      : stock > 0 ? `only ${stock} in stock`
                      : stock === 0 ? "out of stock"
                      : `${stock} (short by ${Math.abs(stock)})`;
                    const refRate = line.itemId ? (priceList.get(line.itemId) ?? 0) : 0;
                    const priceOk = priceMatches(rate, refRate);
                    const hasRef = refRate > 0;
                    return (
                      <tr key={i} className={clsx("border-b border-neutral-100 last:border-0", rowBg)}>
                        <td className="py-2 pr-4 text-neutral-900 max-w-0" style={{ width: "100%" }}>
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="block truncate" title={name}>{name}</span>
                            {stockLabel && (
                              <span className={clsx(
                                "text-2xs flex-shrink-0 px-1.5 py-0.5 rounded font-medium whitespace-nowrap",
                                inStock ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"
                              )}>
                                {stockLabel}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums text-neutral-600 whitespace-nowrap">
                          {qty} {item?.baseUnit ?? ""}
                        </td>
                        <td className="py-2 pr-1 text-right tabular-nums text-neutral-600 whitespace-nowrap">
                          {fmtRate(rate)}
                        </td>
                        <td className="py-2 px-1 text-center">
                          {hasRef ? (
                            <PriceTooltip ok={priceOk} billedRate={rate} refRate={refRate} />
                          ) : null}
                        </td>
                        <td className="py-2 text-right tabular-nums font-medium text-neutral-900 whitespace-nowrap">
                          {fmtINR(amt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-neutral-200">
                    <td colSpan={3} className="pt-2 text-right text-neutral-500 pr-4 text-xs">Total</td>
                    <td className="pt-2 text-right tabular-nums font-semibold text-neutral-900 whitespace-nowrap">
                      {fmtINR(inv.reduce((s, l) => s + (l.lineAmount ?? 0), 0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* Ledger entries */}
          {led.length > 0 && (
            <div>
              <div className="text-xs font-medium text-neutral-500 mb-2 uppercase tracking-wide">Ledger Entries</div>
              <div className="space-y-1">
                {led.map((line, i) => {
                  const name = line.ledgerId
                    ? (data.ledgers.get(line.ledgerId)?.name ?? line.ledgerId) : "";
                  return (
                    <div key={i} className="flex gap-3 text-sm tabular-nums">
                      <span className="text-neutral-400 w-5 flex-shrink-0">{line.isDebit ? "Dr" : "Cr"}</span>
                      <span className="flex-1 truncate text-neutral-700">{name}</span>
                      <span className="text-neutral-900">{fmtINR(line.amount ?? 0)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!inv.length && !led.length && (
            <p className="text-neutral-500 text-sm">No line details available.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Desktop table ───────────────────────────────────── */
function DesktopTable({ notes, data, voucherIndex, priceList, onSelect }: {
  notes: CanonicalVoucher[];
  data: ParsedData;
  voucherIndex: VoucherIndex;
  priceList: Map<string, number>;
  onSelect: (v: CanonicalVoucher) => void;
}) {
  const COL = "90px 120px 1fr 140px 110px";

  return (
    <div className="section-card overflow-hidden">
      {notes.length === 0 ? (
        <div className="empty-state py-10">
          <Truck size={32} className="empty-state-icon" />
          <span className="empty-state-description">No delivery notes found</span>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="grid table-header-sticky" style={{ gridTemplateColumns: COL, minWidth: 580 }}>
            {["Date", "DN#", "Party", "", "Value"].map((h, i) => (
              <div key={i} className={clsx("px-3 py-2", h === "Value" && "text-right")}>{h}</div>
            ))}
          </div>
          <div className="overflow-y-auto max-h-[calc(100vh-240px)]" style={{ minWidth: 580 }}>
            {notes.map((v) => {
              const { ready } = computeReadiness(v, data, voucherIndex, priceList);
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
function MobileList({ notes, data, voucherIndex, priceList, onSelect }: {
  notes: CanonicalVoucher[];
  data: ParsedData;
  voucherIndex: VoucherIndex;
  priceList: Map<string, number>;
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
        const itemCount = v.lines.filter((l) => l.type === "inventory").length;
        const { ready } = computeReadiness(v, data, voucherIndex, priceList);
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
