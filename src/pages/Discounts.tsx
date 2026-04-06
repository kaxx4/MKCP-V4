import { useState, useMemo, useCallback } from "react";
import { Tag, ChevronDown, ChevronUp, Edit2, Trash2, Plus, X, Download, Save, Search } from "lucide-react";
import clsx from "clsx";
import { useDataStore } from "../store/dataStore";
import { useDiscountStore, type DiscountCategory, type DiscountTier } from "../store/discountStore";
import { useToast } from "../components/Toast";
import { fmtINR, fmtDate } from "../utils/format";
import type { CanonicalVoucher } from "../types/canonical";

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtPct(n: number) {
  return n % 1 === 0 ? `${n}%` : `${n.toFixed(1)}%`;
}

function tierLabel(tier: DiscountTier): string {
  if (tier.maxQty === Infinity) return `${tier.minQty}+ pkg`;
  if (tier.minQty === tier.maxQty) return `${tier.minQty} pkg`;
  return `${tier.minQty}–${tier.maxQty} pkg`;
}

function validateTiers(tiers: DiscountTier[]): string | null {
  for (const t of tiers) {
    if (t.minQty < 0 || t.maxQty < t.minQty) return "Invalid quantity range in tiers.";
    if (t.discountPercent < 0 || t.discountPercent > 100) return "Discount must be 0–100%.";
  }
  const sorted = [...tiers].sort((a, b) => a.minQty - b.minQty);
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].maxQty >= sorted[i + 1]!.minQty) return "Overlapping quantity ranges detected.";
  }
  return null;
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function InvoiceLineCalc({
  voucher,
  items,
  getDiscount,
  itemAssignments,
}: {
  voucher: CanonicalVoucher;
  items: Map<string, any>;
  getDiscount: (itemId: string, qtyPkg: number) => number;
  itemAssignments: Record<string, string>;
}) {
  const invLines = voucher.lines.filter(l => l.type === "inventory" && l.itemId);
  if (invLines.length === 0) return <p className="text-muted text-xs px-4 py-2">No inventory lines.</p>;

  let subtotal = 0, totalDiscount = 0;

  const rows = invLines.map((line, i) => {
    const item = line.itemId ? items.get(line.itemId) : null;
    const name = item?.name ?? line.itemId ?? "Unknown";
    const qtyBase = line.qtyBase ?? 0;
    const unitsPerPkg = item?.unitsPerPkg ?? 1;
    const qtyPkg = unitsPerPkg > 0 ? qtyBase / unitsPerPkg : qtyBase;
    const ratePerBase = line.ratePerBase ?? 0;
    const lineSubtotal = line.lineAmount ?? (qtyBase * ratePerBase);
    const catName = line.itemId ? itemAssignments[line.itemId.toUpperCase()] : undefined;
    const discPct = line.itemId ? getDiscount(line.itemId, Math.round(qtyPkg)) : 0;
    const discAmt = lineSubtotal * (discPct / 100);
    const net = lineSubtotal - discAmt;

    subtotal += lineSubtotal;
    totalDiscount += discAmt;

    return (
      <tr key={i} className="border-b border-neutral-100 hover:bg-neutral-50 transition-colors">
        <td className="px-3 py-2 text-xs text-muted truncate max-w-[140px]" title={name}>{name}</td>
        <td className="px-3 py-2 text-xs text-right tabular-nums">{Math.round(qtyPkg)}</td>
        <td className="px-3 py-2 text-xs text-right tabular-nums">{fmtINR(ratePerBase * unitsPerPkg)}</td>
        <td className="px-3 py-2 text-xs text-right tabular-nums">{fmtINR(lineSubtotal)}</td>
        <td className="px-3 py-2 text-xs truncate max-w-[120px] text-muted" title={catName}>{catName ?? <span className="text-neutral-300 italic">None</span>}</td>
        <td className="px-3 py-2 text-xs text-center">
          {discPct > 0
            ? <span className="badge badge-warn">{fmtPct(discPct)}</span>
            : <span className="text-neutral-300">—</span>}
        </td>
        <td className="px-3 py-2 text-xs text-right tabular-nums font-medium text-success-700">{fmtINR(net)}</td>
      </tr>
    );
  });

  const netTotal = subtotal - totalDiscount;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-neutral-50 border-b border-neutral-200">
            <th className="px-3 py-2 text-left text-xs font-medium text-muted">Item</th>
            <th className="px-3 py-2 text-right text-xs font-medium text-muted">Qty (Pkg)</th>
            <th className="px-3 py-2 text-right text-xs font-medium text-muted">Pkg Price</th>
            <th className="px-3 py-2 text-right text-xs font-medium text-muted">Subtotal</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-muted">Category</th>
            <th className="px-3 py-2 text-center text-xs font-medium text-muted">Disc%</th>
            <th className="px-3 py-2 text-right text-xs font-medium text-muted">Net Total</th>
          </tr>
        </thead>
        <tbody>{rows}</tbody>
        <tfoot className="border-t-2 border-neutral-200 bg-neutral-50">
          <tr>
            <td colSpan={3} className="px-3 py-2 text-xs font-semibold text-right text-muted">Grand Total</td>
            <td className="px-3 py-2 text-xs font-semibold text-right tabular-nums">{fmtINR(subtotal)}</td>
            <td className="px-3 py-2 text-xs text-muted text-center">
              {totalDiscount > 0 && <span className="text-warn-700">-{fmtINR(totalDiscount)} ({fmtPct(subtotal > 0 ? totalDiscount / subtotal * 100 : 0)})</span>}
            </td>
            <td />
            <td className="px-3 py-2 text-xs font-bold text-right tabular-nums text-success-700">{fmtINR(netTotal)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ─── Edit Tiers Modal ────────────────────────────────────────────────────────

function EditTiersModal({
  category,
  onClose,
}: {
  category: DiscountCategory;
  onClose: () => void;
}) {
  const { updateTiers } = useDiscountStore();
  const { toast } = useToast();
  const [tiers, setTiers] = useState<DiscountTier[]>(
    category.tiers.map(t => ({ ...t }))
  );

  const setTier = (idx: number, updates: Partial<DiscountTier>) => {
    setTiers(prev => prev.map((t, i) => i === idx ? { ...t, ...updates } : t));
  };

  const addTier = () => {
    setTiers(prev => [...prev, { minQty: 1, maxQty: Infinity, discountPercent: 0 }]);
  };

  const removeTier = (idx: number) => {
    setTiers(prev => prev.filter((_, i) => i !== idx));
  };

  const save = () => {
    const err = validateTiers(tiers);
    if (err) { toast(err, "error"); return; }
    updateTiers(category.name, tiers);
    toast(`Tiers updated for "${category.name}".`, "success");
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-200">
          <h2 className="font-semibold text-sm">{category.name}</h2>
          <button onClick={onClose} className="btn-icon"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <div className="grid grid-cols-[1fr_1fr_1fr_32px] gap-2 text-xs font-medium text-muted mb-1">
            <span>Min Pkg</span><span>Max Pkg</span><span>Discount %</span><span />
          </div>
          {tiers.map((tier, idx) => (
            <div key={idx} className="grid grid-cols-[1fr_1fr_1fr_32px] gap-2 items-center">
              <input
                type="number" min={0} value={tier.minQty}
                onChange={e => setTier(idx, { minQty: parseFloat(e.target.value) || 0 })}
                className="form-input text-sm"
              />
              <input
                type="number" min={0}
                value={tier.maxQty === Infinity ? "" : tier.maxQty}
                placeholder="∞"
                onChange={e => setTier(idx, { maxQty: e.target.value === "" ? Infinity : parseFloat(e.target.value) || 0 })}
                className="form-input text-sm"
              />
              <input
                type="number" min={0} max={100} step={0.1} value={tier.discountPercent}
                onChange={e => setTier(idx, { discountPercent: parseFloat(e.target.value) || 0 })}
                className="form-input text-sm"
              />
              <button onClick={() => removeTier(idx)} className="btn-icon text-danger-600"><Trash2 size={14} /></button>
            </div>
          ))}
          <button onClick={addTier} className="btn-secondary btn-sm w-full mt-2">
            <Plus size={14} />Add Tier
          </button>
          <p className="text-xs text-muted mt-2">Leave Max Pkg blank for open-ended (∞). Tiers must not overlap.</p>
        </div>

        <div className="flex gap-2 px-5 py-4 border-t border-neutral-200">
          <button onClick={save} className="btn-primary btn-sm flex-1"><Save size={14} />Save Tiers</button>
          <button onClick={onClose} className="btn-secondary btn-sm">Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ─── Assign Items Modal ──────────────────────────────────────────────────────

function AssignItemsModal({
  categoryName,
  onClose,
}: {
  categoryName: string;
  onClose: () => void;
}) {
  const { data } = useDataStore();
  const { itemAssignments, assignItem, unassignItem } = useDiscountStore();
  const { toast } = useToast();
  const [search, setSearch] = useState("");

  const allItems = useMemo(() => data ? Array.from(data.items.values()) : [], [data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allItems;
    return allItems.filter(i => i.name.toLowerCase().includes(q) || i.itemId.toLowerCase().includes(q));
  }, [allItems, search]);

  const assignedToThis = useMemo(
    () => new Set(Object.entries(itemAssignments).filter(([, c]) => c === categoryName).map(([id]) => id)),
    [itemAssignments, categoryName]
  );

  const toggle = (itemId: string) => {
    if (assignedToThis.has(itemId)) {
      unassignItem(itemId);
    } else {
      assignItem(itemId, categoryName);
    }
  };

  const selectAll = () => {
    const ids = filtered.map(i => i.itemId);
    ids.forEach(id => assignItem(id, categoryName));
    toast(`Assigned ${ids.length} items to "${categoryName}".`, "success");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-200">
          <div>
            <h2 className="font-semibold text-sm">Assign Items</h2>
            <p className="text-xs text-muted mt-0.5">Category: <strong>{categoryName}</strong> · {assignedToThis.size} assigned</p>
          </div>
          <button onClick={onClose} className="btn-icon"><X size={16} /></button>
        </div>

        <div className="px-5 pt-3 pb-2 border-b border-neutral-100">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search items…"
              className="form-input pl-8 text-sm w-full"
            />
          </div>
          <div className="flex gap-2 mt-2">
            <button onClick={selectAll} className="btn-secondary btn-sm text-xs">Select All ({filtered.length})</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {filtered.slice(0, 200).map(item => {
            const assigned = assignedToThis.has(item.itemId);
            const otherCat = itemAssignments[item.itemId];
            const conflict = otherCat && otherCat !== categoryName;
            return (
              <label key={item.itemId} className={clsx(
                "flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer hover:bg-neutral-50 transition-colors",
                assigned && "bg-accent/5"
              )}>
                <input type="checkbox" checked={assigned} onChange={() => toggle(item.itemId)} className="accent-accent" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate font-medium">{item.name}</p>
                  {conflict && <p className="text-xs text-warn-600">Currently in: {otherCat}</p>}
                </div>
                <span className="text-xs text-muted flex-shrink-0">{item.pkgUnit ?? item.baseUnit}</span>
              </label>
            );
          })}
          {filtered.length > 200 && <p className="text-xs text-muted text-center py-3">Showing first 200 results. Refine your search.</p>}
        </div>

        <div className="px-5 py-4 border-t border-neutral-200">
          <button onClick={onClose} className="btn-primary btn-sm w-full">Done</button>
        </div>
      </div>
    </div>
  );
}

// ─── Invoice Selector Modal ──────────────────────────────────────────────────

function InvoicePickerModal({
  onSelect,
  onClose,
}: {
  onSelect: (v: CanonicalVoucher) => void;
  onClose: () => void;
}) {
  const { data } = useDataStore();
  const [search, setSearch] = useState("");

  const salesVouchers = useMemo(() => {
    if (!data) return [];
    return data.vouchers
      .filter(v => v.voucherType === "Sales" && !v.isCancelled)
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return salesVouchers;
    return salesVouchers.filter(v =>
      v.voucherNumber?.toLowerCase().includes(q) ||
      v.partyName?.toLowerCase().includes(q) ||
      v.date.includes(q)
    );
  }, [salesVouchers, search]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-200">
          <h2 className="font-semibold text-sm">Select Invoice</h2>
          <button onClick={onClose} className="btn-icon"><X size={16} /></button>
        </div>
        <div className="px-5 pt-3 pb-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search by invoice #, party, or date…"
              className="form-input pl-8 text-sm w-full"
              autoFocus
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {filtered.slice(0, 100).map(v => (
            <button key={v.voucherId} onClick={() => { onSelect(v); onClose(); }}
              className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-neutral-50 transition-colors">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{v.partyName ?? "—"}</p>
                <p className="text-xs text-muted">{v.voucherNumber} · {fmtDate(v.date)}</p>
              </div>
              <span className="text-sm font-semibold text-primary flex-shrink-0">{fmtINR(v.totalAmount)}</span>
            </button>
          ))}
          {filtered.length === 0 && <p className="text-sm text-muted text-center py-8">No invoices found.</p>}
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function Discounts() {
  const { data } = useDataStore();
  const { categories, itemAssignments, addCategory, renameCategory, deleteCategory, getDiscount } = useDiscountStore();
  const { toast } = useToast();

  const [selectedVoucher, setSelectedVoucher] = useState<CanonicalVoucher | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [editingTiers, setEditingTiers] = useState<DiscountCategory | null>(null);
  const [assigningCategory, setAssigningCategory] = useState<string | null>(null);
  const [expandedCat, setExpandedCat] = useState<string | null>(null);
  const [newCatName, setNewCatName] = useState("");
  const [showAddCat, setShowAddCat] = useState(false);
  const [renamingCat, setRenamingCat] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Count items per category
  const itemCountByCat = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const catName of Object.values(itemAssignments)) {
      counts[catName] = (counts[catName] ?? 0) + 1;
    }
    return counts;
  }, [itemAssignments]);

  const handleAddCategory = () => {
    const name = newCatName.trim();
    if (!name) return;
    if (categories.find(c => c.name === name)) { toast("Category already exists.", "error"); return; }
    addCategory(name);
    setNewCatName("");
    setShowAddCat(false);
    toast(`Category "${name}" created.`, "success");
  };

  const handleDeleteCategory = (name: string) => {
    const count = itemCountByCat[name] ?? 0;
    if (count > 0) { toast(`Unassign ${count} item(s) from "${name}" first.`, "error"); return; }
    deleteCategory(name);
    toast(`Category "${name}" deleted.`, "info");
  };

  const handleRename = (oldName: string) => {
    const name = renameValue.trim();
    if (!name || name === oldName) { setRenamingCat(null); return; }
    if (categories.find(c => c.name === name)) { toast("Name already taken.", "error"); return; }
    renameCategory(oldName, name);
    setRenamingCat(null);
    toast(`Renamed to "${name}".`, "success");
  };

  const exportCSV = useCallback(() => {
    if (!selectedVoucher || !data) return;
    const lines = selectedVoucher.lines.filter(l => l.type === "inventory" && l.itemId);
    const rows = [
      ["Item", "Qty (Pkg)", "Pkg Price", "Subtotal", "Category", "Discount %", "Discount Amt", "Net Total"],
      ...lines.map(line => {
        const item = line.itemId ? data.items.get(line.itemId) : null;
        const name = item?.name ?? line.itemId ?? "";
        const qtyBase = line.qtyBase ?? 0;
        const unitsPerPkg = item?.unitsPerPkg ?? 1;
        const qtyPkg = Math.round(unitsPerPkg > 0 ? qtyBase / unitsPerPkg : qtyBase);
        const ratePerPkg = (line.ratePerBase ?? 0) * unitsPerPkg;
        const subtotal = line.lineAmount ?? (qtyBase * (line.ratePerBase ?? 0));
        const catName = line.itemId ? itemAssignments[line.itemId.toUpperCase()] ?? "" : "";
        const discPct = line.itemId ? getDiscount(line.itemId, qtyPkg) : 0;
        const discAmt = subtotal * (discPct / 100);
        const net = subtotal - discAmt;
        return [name, qtyPkg, ratePerPkg.toFixed(2), subtotal.toFixed(2), catName, discPct, discAmt.toFixed(2), net.toFixed(2)];
      }),
    ];
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `discount_${selectedVoucher.voucherNumber ?? "invoice"}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [selectedVoucher, data, itemAssignments, getDiscount]);

  if (!data) {
    return (
      <div className="page-section flex items-center justify-center h-[60vh]">
        <div className="text-center">
          <Tag size={32} className="mx-auto mb-3 text-muted" />
          <p className="text-muted">Import data from Tally first to use Discount Manager.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-section space-y-6">
      {/* Header */}
      <div className="page-header">
        <h1 className="page-title">Discount Manager</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowPicker(true)} className="btn-primary btn-sm">
            <Search size={14} />{selectedVoucher ? "Change Invoice" : "Select Invoice"}
          </button>
          {selectedVoucher && (
            <button onClick={exportCSV} className="btn-secondary btn-sm">
              <Download size={14} />Export CSV
            </button>
          )}
        </div>
      </div>

      {/* Selected Invoice */}
      {selectedVoucher ? (
        <div className="card">
          <div className="flex items-start justify-between mb-3">
            <div>
              <p className="text-xs text-muted">Invoice</p>
              <p className="font-semibold text-sm">{selectedVoucher.partyName ?? "—"}</p>
              <p className="text-xs text-muted">{selectedVoucher.voucherNumber} · {fmtDate(selectedVoucher.date)} · {fmtINR(selectedVoucher.totalAmount)}</p>
            </div>
            <button onClick={() => setSelectedVoucher(null)} className="btn-icon"><X size={14} /></button>
          </div>
          <InvoiceLineCalc
            voucher={selectedVoucher}
            items={data.items}
            getDiscount={getDiscount}
            itemAssignments={itemAssignments}
          />
        </div>
      ) : (
        <div className="card border-dashed text-center py-10">
          <Tag size={24} className="mx-auto mb-2 text-muted" />
          <p className="text-sm text-muted">Select an invoice above to see discount breakdown.</p>
        </div>
      )}

      {/* Categories */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="section-header mb-0">Discount Categories</h2>
          <button onClick={() => setShowAddCat(true)} className="btn-secondary btn-sm">
            <Plus size={14} />New Category
          </button>
        </div>

        {showAddCat && (
          <div className="card mb-3 flex items-center gap-2">
            <input
              value={newCatName} onChange={e => setNewCatName(e.target.value)}
              placeholder="Category name…" className="form-input flex-1 text-sm"
              onKeyDown={e => e.key === "Enter" && handleAddCategory()}
              autoFocus
            />
            <button onClick={handleAddCategory} className="btn-primary btn-sm"><Plus size={14} />Create</button>
            <button onClick={() => { setShowAddCat(false); setNewCatName(""); }} className="btn-secondary btn-sm">Cancel</button>
          </div>
        )}

        <div className="space-y-2">
          {categories.map(cat => {
            const itemCount = itemCountByCat[cat.name] ?? 0;
            const isExpanded = expandedCat === cat.name;
            const isRenaming = renamingCat === cat.name;

            return (
              <div key={cat.name} className="card p-0 overflow-hidden">
                {/* Header row */}
                <div
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-neutral-50 transition-colors"
                  onClick={() => setExpandedCat(isExpanded ? null : cat.name)}
                >
                  <div className="flex-1 min-w-0">
                    {isRenaming ? (
                      <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                        <input
                          value={renameValue} onChange={e => setRenameValue(e.target.value)}
                          className="form-input text-sm flex-1"
                          onKeyDown={e => { if (e.key === "Enter") handleRename(cat.name); if (e.key === "Escape") setRenamingCat(null); }}
                          autoFocus
                        />
                        <button onClick={() => handleRename(cat.name)} className="btn-primary btn-sm"><Save size={12} />Save</button>
                        <button onClick={() => setRenamingCat(null)} className="btn-secondary btn-sm">Cancel</button>
                      </div>
                    ) : (
                      <p className="font-medium text-sm truncate">{cat.name}</p>
                    )}
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-xs text-muted">{itemCount} item{itemCount !== 1 ? "s" : ""}</span>
                      <span className="text-xs text-muted">·</span>
                      <span className="text-xs text-muted">
                        {cat.tiers.length === 0 ? "No tiers" : cat.tiers.map(t => `${tierLabel(t)}: ${fmtPct(t.discountPercent)}`).join(" · ")}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => setEditingTiers(cat)}
                      className="btn-icon text-accent" title="Edit tiers"
                    ><Edit2 size={14} /></button>
                    <button
                      onClick={() => { setRenamingCat(cat.name); setRenameValue(cat.name); }}
                      className="btn-icon" title="Rename"
                    ><span className="text-xs font-bold">Aa</span></button>
                    <button
                      onClick={() => setAssigningCategory(cat.name)}
                      className="btn-icon text-muted" title="Assign items"
                    ><Tag size={14} /></button>
                    <button
                      onClick={() => handleDeleteCategory(cat.name)}
                      className="btn-icon text-danger-600" title="Delete"
                    ><Trash2 size={14} /></button>
                    {isExpanded ? <ChevronUp size={14} className="text-muted" /> : <ChevronDown size={14} className="text-muted" />}
                  </div>
                </div>

                {/* Expanded: assigned items */}
                {isExpanded && (
                  <div className="border-t border-neutral-100 px-4 py-3">
                    <p className="text-xs font-medium text-muted mb-2">Assigned Items ({itemCount})</p>
                    {itemCount === 0 ? (
                      <p className="text-xs text-muted italic">No items assigned. Click the tag icon to assign.</p>
                    ) : (
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-1 max-h-48 overflow-y-auto">
                        {Object.entries(itemAssignments)
                          .filter(([, c]) => c === cat.name)
                          .map(([id]) => {
                            const item = data.items.get(id);
                            return (
                              <span key={id} className="text-xs bg-neutral-100 rounded px-2 py-0.5 truncate" title={item?.name ?? id}>
                                {item?.name ?? id}
                              </span>
                            );
                          })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Modals */}
      {showPicker && <InvoicePickerModal onSelect={setSelectedVoucher} onClose={() => setShowPicker(false)} />}
      {editingTiers && <EditTiersModal category={editingTiers} onClose={() => setEditingTiers(null)} />}
      {assigningCategory && <AssignItemsModal categoryName={assigningCategory} onClose={() => setAssigningCategory(null)} />}
    </div>
  );
}
