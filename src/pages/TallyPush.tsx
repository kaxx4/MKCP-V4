import { useState } from "react";
import { Send, Plus, Trash2, CheckCircle, XCircle, Loader2, ChevronDown, ChevronUp, Wifi, WifiOff } from "lucide-react";
import clsx from "clsx";
import { useTallyStore } from "../store/tallyStore";
import { pushTest, type PushTestRequest, type PushTestResult } from "../api/tallyApi";

type VoucherTab = "Sales" | "Purchase" | "Delivery Note";

interface ItemRow {
  id: number;
  name: string;
  qty: string;
  unit: string;
  rate: string;
}

interface FormState {
  date: string;
  voucherNumber: string;
  narration: string;
  partyName: string;
  ledgerName: string;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let _idSeed = 1;
const newRow = (): ItemRow => ({ id: _idSeed++, name: "", qty: "1", unit: "Nos", rate: "0" });

const TAB_LABELS: VoucherTab[] = ["Sales", "Purchase", "Delivery Note"];

const TAB_DEFAULTS: Record<VoucherTab, Partial<FormState>> = {
  "Sales":         { ledgerName: "Sales" },
  "Purchase":      { ledgerName: "Purchase" },
  "Delivery Note": { ledgerName: "" },
};

export default function TallyPush() {
  const { companyName, isConnected } = useTallyStore();

  const [tab, setTab] = useState<VoucherTab>("Sales");
  const [form, setForm] = useState<FormState>({
    date: todayISO(),
    voucherNumber: "",
    narration: "",
    partyName: "",
    ledgerName: "Sales",
  });
  const [items, setItems] = useState<ItemRow[]>([newRow()]);
  const [pushing, setPushing] = useState(false);
  const [result, setResult] = useState<PushTestResult | null>(null);
  const [xmlOpen, setXmlOpen] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);

  function switchTab(t: VoucherTab) {
    setTab(t);
    setForm(f => ({ ...f, ...TAB_DEFAULTS[t] }));
    setResult(null);
    setXmlOpen(false);
    setRawOpen(false);
  }

  function setField(field: keyof FormState, value: string) {
    setForm(f => ({ ...f, [field]: value }));
  }

  function setItem(id: number, field: keyof ItemRow, value: string) {
    setItems(rows => rows.map(r => r.id === id ? { ...r, [field]: value } : r));
  }

  function addItem() {
    setItems(rows => [...rows, newRow()]);
  }

  function removeItem(id: number) {
    setItems(rows => rows.length > 1 ? rows.filter(r => r.id !== id) : rows);
  }

  const total = items.reduce((s, i) => s + (parseFloat(i.qty) || 0) * (parseFloat(i.rate) || 0), 0);

  async function handlePush(dryRun = false) {
    if (!companyName) return;
    const validItems = items.filter(i => i.name.trim() && parseFloat(i.qty) > 0);
    if (validItems.length === 0) return;

    setPushing(true);
    setResult(null);

    const payload: PushTestRequest = {
      company: companyName,
      voucherType: tab,
      date: form.date,
      partyName: form.partyName.trim(),
      ledgerName: form.ledgerName.trim(),
      items: validItems.map(i => ({
        name: i.name.trim(),
        qty: parseFloat(i.qty) || 0,
        unit: i.unit.trim() || "Nos",
        rate: parseFloat(i.rate) || 0,
      })),
      voucherNumber: form.voucherNumber.trim() || undefined,
      narration: form.narration.trim() || undefined,
      dryRun,
    };

    const r = await pushTest(payload);
    setResult(r);
    setPushing(false);
  }

  const canPush = !!companyName && !!form.partyName.trim() && items.some(i => i.name.trim());

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-neutral-950">Push to Tally</h1>
          <p className="text-sm text-neutral-500 mt-0.5">Create Sales, Purchase, or Delivery Note vouchers directly in TallyPrime</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {isConnected
            ? <><Wifi size={14} className="text-emerald-600" /><span className="text-emerald-700 font-medium">{companyName || "Connected"}</span></>
            : <><WifiOff size={14} className="text-red-500" /><span className="text-red-600">Tally not connected</span></>
          }
        </div>
      </div>

      {!companyName && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Connect to Tally and sync masters first — the party ledger and stock item names must exist in Tally for the push to succeed.
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-neutral-100 rounded-xl w-fit">
        {TAB_LABELS.map(t => (
          <button
            key={t}
            onClick={() => switchTab(t)}
            className={clsx(
              "px-4 py-1.5 rounded-lg text-sm font-medium transition-colors",
              tab === t
                ? "bg-white text-neutral-950 shadow-sm"
                : "text-neutral-500 hover:text-neutral-700"
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Form */}
        <div className="bg-white rounded-2xl border border-neutral-200 p-5 space-y-4">
          <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wide">Voucher Details</p>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-neutral-600 mb-1">Date</label>
              <input
                type="date"
                value={form.date}
                onChange={e => setField("date", e.target.value)}
                className="w-full text-sm border border-neutral-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent/40"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-neutral-600 mb-1">Voucher No. (optional)</label>
              <input
                type="text"
                placeholder="e.g. SV-001"
                value={form.voucherNumber}
                onChange={e => setField("voucherNumber", e.target.value)}
                className="w-full text-sm border border-neutral-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent/40"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-neutral-600 mb-1">
              {tab === "Sales" ? "Party / Customer Ledger" : tab === "Purchase" ? "Party / Supplier Ledger" : "Party / Customer Ledger"}
            </label>
            <input
              type="text"
              placeholder={tab === "Purchase" ? "e.g. Atlas Cycles" : "e.g. Cash"}
              value={form.partyName}
              onChange={e => setField("partyName", e.target.value)}
              className="w-full text-sm border border-neutral-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </div>

          {tab !== "Delivery Note" && (
            <div>
              <label className="block text-xs font-medium text-neutral-600 mb-1">
                {tab === "Sales" ? "Sales Ledger (account)" : "Purchase Ledger (account)"}
              </label>
              <input
                type="text"
                placeholder={tab === "Sales" ? "e.g. Sales" : "e.g. Purchase"}
                value={form.ledgerName}
                onChange={e => setField("ledgerName", e.target.value)}
                className="w-full text-sm border border-neutral-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent/40"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-neutral-600 mb-1">Narration (optional)</label>
            <input
              type="text"
              placeholder="e.g. Test entry"
              value={form.narration}
              onChange={e => setField("narration", e.target.value)}
              className="w-full text-sm border border-neutral-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </div>
        </div>

        {/* Items */}
        <div className="bg-white rounded-2xl border border-neutral-200 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wide">Items</p>
            <button
              onClick={addItem}
              className="flex items-center gap-1 text-xs font-medium text-accent hover:text-accent/80 transition-colors"
            >
              <Plus size={13} /> Add Item
            </button>
          </div>

          {/* Header row */}
          <div className="grid grid-cols-[1fr_56px_52px_72px_28px] gap-1.5 text-xs font-medium text-neutral-400">
            <span>Item Name</span>
            <span>Qty</span>
            <span>Unit</span>
            <span>Rate (₹)</span>
            <span />
          </div>

          <div className="space-y-1.5 max-h-[280px] overflow-y-auto pr-0.5">
            {items.map(item => (
              <div key={item.id} className="grid grid-cols-[1fr_56px_52px_72px_28px] gap-1.5 items-center">
                <input
                  type="text"
                  placeholder="Stock item name"
                  value={item.name}
                  onChange={e => setItem(item.id, "name", e.target.value)}
                  className="text-xs border border-neutral-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent/40 min-w-0"
                />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={item.qty}
                  onChange={e => setItem(item.id, "qty", e.target.value)}
                  className="text-xs border border-neutral-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent/40 text-right"
                />
                <input
                  type="text"
                  value={item.unit}
                  onChange={e => setItem(item.id, "unit", e.target.value)}
                  className="text-xs border border-neutral-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent/40"
                />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={item.rate}
                  onChange={e => setItem(item.id, "rate", e.target.value)}
                  className="text-xs border border-neutral-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent/40 text-right"
                />
                <button
                  onClick={() => removeItem(item.id)}
                  disabled={items.length === 1}
                  className="text-neutral-400 hover:text-red-500 disabled:opacity-30 transition-colors"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>

          {/* Total */}
          <div className="pt-2 border-t border-neutral-100 flex justify-between items-center">
            <span className="text-xs text-neutral-500">Total</span>
            <span className="text-sm font-bold text-neutral-950">₹{total.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => handlePush(false)}
          disabled={pushing || !canPush}
          className={clsx(
            "flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors",
            pushing || !canPush
              ? "bg-neutral-200 text-neutral-400 cursor-not-allowed"
              : "bg-accent text-white hover:bg-accent/90"
          )}
        >
          {pushing
            ? <><Loader2 size={15} className="animate-spin" />Pushing…</>
            : <><Send size={15} />Push {tab} to Tally</>
          }
        </button>
        <button
          onClick={() => handlePush(true)}
          disabled={pushing || !canPush}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium border border-neutral-300 text-neutral-600 hover:bg-neutral-50 disabled:opacity-40 transition-colors"
        >
          Dry Run (preview XML)
        </button>
      </div>

      {/* Result panel */}
      {result && (
        <div className={clsx(
          "rounded-2xl border p-5 space-y-3",
          result.success ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"
        )}>
          {/* Status header */}
          <div className="flex items-center gap-2">
            {result.success
              ? <CheckCircle size={18} className="text-emerald-600" />
              : <XCircle size={18} className="text-red-500" />
            }
            <span className={clsx("font-semibold text-sm", result.success ? "text-emerald-800" : "text-red-700")}>
              {result.success
                ? result.dryRun ? "Dry run complete — XML generated (not sent to Tally)" : `Voucher created in Tally (ID: ${result.lastVoucherId ?? "—"})`
                : result.error || "Push failed"
              }
            </span>
          </div>

          {/* Stats */}
          {!result.dryRun && (
            <div className="flex gap-6 text-xs">
              <span className="text-neutral-600">Created: <b className="text-neutral-900">{result.created}</b></span>
              <span className="text-neutral-600">Errors: <b className={result.errors ? "text-red-600" : "text-neutral-900"}>{result.errors}</b></span>
              {result.lastVoucherId && <span className="text-neutral-600">Voucher ID: <b className="text-neutral-900">{result.lastVoucherId}</b></span>}
            </div>
          )}

          {/* Line errors */}
          {result.lineErrors && result.lineErrors.length > 0 && (
            <div className="space-y-1">
              {result.lineErrors.map((e, i) => (
                <div key={i} className="text-xs text-red-700 bg-red-100 rounded-lg px-3 py-1.5 font-mono">{e}</div>
              ))}
            </div>
          )}

          {/* Sent XML collapsible */}
          {result.sentXml && (
            <div>
              <button
                onClick={() => setXmlOpen(o => !o)}
                className="flex items-center gap-1.5 text-xs font-medium text-neutral-600 hover:text-neutral-900 transition-colors"
              >
                {xmlOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                {xmlOpen ? "Hide" : "Show"} generated XML
              </button>
              {xmlOpen && (
                <pre className="mt-2 text-xs bg-white border border-neutral-200 rounded-xl p-3 overflow-x-auto text-neutral-700 max-h-72 overflow-y-auto leading-relaxed">
                  {result.sentXml}
                </pre>
              )}
            </div>
          )}

          {/* Raw response collapsible */}
          {result.rawResponse && !result.dryRun && (
            <div>
              <button
                onClick={() => setRawOpen(o => !o)}
                className="flex items-center gap-1.5 text-xs font-medium text-neutral-600 hover:text-neutral-900 transition-colors"
              >
                {rawOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                {rawOpen ? "Hide" : "Show"} raw Tally response
              </button>
              {rawOpen && (
                <pre className="mt-2 text-xs bg-white border border-neutral-200 rounded-xl p-3 overflow-x-auto text-neutral-700 max-h-48 overflow-y-auto leading-relaxed">
                  {result.rawResponse}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {/* How-to note */}
      <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-500 space-y-1">
        <p className="font-semibold text-neutral-600">Before pushing:</p>
        <ul className="list-disc list-inside space-y-0.5">
          <li>Party ledger must exist in Tally (e.g. "Cash", or an exact customer/supplier name)</li>
          <li>Sales/Purchase ledger must exist (e.g. "Sales", "Purchase")</li>
          <li>Stock item names must match exactly as in Tally</li>
          <li>Use <b>Dry Run</b> first to inspect the XML without sending</li>
          <li>Delivery Notes don't need a Sales/Purchase account — only party + items</li>
        </ul>
      </div>
    </div>
  );
}
