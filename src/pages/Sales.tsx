/**
 * Sales Page
 * Create and manage pro-forma sales invoices with Tally integration
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Plus, FileText, Send, AlertTriangle, CheckCircle, Download, Loader2, Trash2, Search, IndianRupee, Package, Upload, Printer, ChevronDown } from "lucide-react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { useDataStore } from "../store/dataStore";
import { useSalesStore } from "../store/salesStore";
import { validateInvoice, roundTallyStyle } from "../services/salesValidator";
import { downloadInvoicePDF, exportInvoiceAsA4PDF, printInvoice } from "../services/salesPDFExporter";
import { pushInvoiceToTally, validateInvoiceForPush, gstTypeFromGSTIN, DEFAULT_PUSH_CONFIG } from "../services/salesTallyConverter";
import { useToast } from "../components/Toast";
import type {
  SalesInvoice,
  SalesInvoiceLineItem,
  ValidationResult,
  PushResult
} from "../types/sales";

export default function SalesPage() {
  const navigate = useNavigate();
  const { data: tallyData } = useDataStore();
  const {
    currentInvoice,
    setCurrentInvoice,
    saveDraft,
    unitMode,
    setUnitMode
  } = useSalesStore();
  const { toast } = useToast();

  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string>("");
  const [itemSearch, setItemSearch] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [pushResult, setPushResult] = useState<PushResult | null>(null);
  const [showPrintMenu, setShowPrintMenu] = useState(false);
  const itemSelectRef = useRef<HTMLSelectElement>(null);
  const printMenuRef = useRef<HTMLDivElement>(null);

  // Close print menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (printMenuRef.current && !printMenuRef.current.contains(e.target as Node)) {
        setShowPrintMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Initialize empty invoice if none exists
  useEffect(() => {
    if (!currentInvoice) {
      const now = new Date().toISOString();
      const newInvoice: SalesInvoice = {
        header: {
          id: crypto.randomUUID(),
          invoiceNo: undefined,
          date: now.split("T")[0],
          partyId: "",
          partyName: "",
          createdAt: now,
          modifiedAt: now,
          status: "draft"
        },
        items: [],
        subtotal: 0,
        totalQuantity: 0,
        auditLog: [
          {
            timestamp: now,
            action: "created",
            details: { type: "new_invoice" }
          }
        ],
        isValid: false,
        validationErrors: ["Invoice must have at least one item"]
      };
      setCurrentInvoice(newInvoice);
    }
  }, [currentInvoice, setCurrentInvoice]);

  // Auto-validate on changes
  useEffect(() => {
    if (!currentInvoice || currentInvoice.items.length === 0) return;

    const validateAsync = async () => {
      setIsValidating(true);
      const result = await validateInvoice(currentInvoice, tallyData);
      setValidationResult(result);
      setCurrentInvoice({
        ...currentInvoice,
        isValid: result.passed,
        validationErrors: result.errors
      });
      setIsValidating(false);
    };

    const timer = setTimeout(validateAsync, 500);
    return () => clearTimeout(timer);
  }, [currentInvoice?.items, tallyData, currentInvoice, setCurrentInvoice]);

  // Available items filtered by search
  const availableItems = useMemo(() => {
    const all = Array.from(tallyData?.items.values() ?? []).filter(
      (item) => !currentInvoice?.items.some((li) => li.itemId === item.itemId)
    );
    if (!itemSearch.trim()) return all;
    const q = itemSearch.toLowerCase();
    return all.filter((item) => item.name.toLowerCase().includes(q));
  }, [tallyData, currentInvoice?.items, itemSearch]);

  const availableParties = useMemo(() =>
    Array.from(tallyData?.ledgers.values() ?? []).filter(
      (ledger) => ledger.type === "Customer"
    ),
    [tallyData]
  );

  const handlePartyChange = (partyId: string) => {
    if (!currentInvoice) return;
    const party = tallyData?.ledgers.get(partyId);
    if (!party) { toast.error("Party not found"); return; }
    setCurrentInvoice({
      ...currentInvoice,
      header: { ...currentInvoice.header, partyId, partyName: party.name }
    });
  };

  const handleAddItem = useCallback(() => {
    if (!currentInvoice || !selectedItemId) {
      toast.error("Please select an item");
      return;
    }
    const tallyItem = tallyData?.items.get(selectedItemId);
    if (!tallyItem) { toast.error("Item not found in Tally data"); return; }

    const newItem: SalesInvoiceLineItem = {
      id: crypto.randomUUID(),
      itemId: selectedItemId,
      itemName: tallyItem.name,
      quantity: 1,
      unitType: unitMode,
      baseQuantity: 1,
      packageQuantity: 1,
      ratePerBaseUnit: tallyItem.currentRate ?? 0,
      ratePerPackageUnit: tallyItem.currentRate ?? 0,
      conversionRatio: 1,
      baseUnitName: tallyItem.baseUnit,
      packageUnitName: "pkg",
      amount: tallyItem.currentRate ?? 0,
      validationStatus: "valid",
      validationMessages: []
    };

    const updatedItems = [...currentInvoice.items, newItem];
    const newSubtotal = roundTallyStyle(updatedItems.reduce((s, i) => s + i.amount, 0));
    setCurrentInvoice({
      ...currentInvoice,
      items: updatedItems,
      subtotal: newSubtotal,
      totalQuantity: updatedItems.reduce((s, i) => s + i.baseQuantity, 0)
    });
    setSelectedItemId("");
    setItemSearch("");
    toast.success(`Added ${tallyItem.name}`);
  }, [currentInvoice, selectedItemId, tallyData, unitMode, setCurrentInvoice, toast]);

  const handleQuantityChange = (itemId: string, newQuantity: number) => {
    if (!currentInvoice) return;
    const updatedItems = currentInvoice.items.map((item) => {
      if (item.id !== itemId) return item;
      const baseQty = item.unitType === "base" ? newQuantity : newQuantity * item.conversionRatio;
      const amount = roundTallyStyle(baseQty * item.ratePerBaseUnit);
      return { ...item, quantity: newQuantity, baseQuantity: baseQty, packageQuantity: baseQty / item.conversionRatio, amount };
    });
    const newSubtotal = roundTallyStyle(updatedItems.reduce((s, i) => s + i.amount, 0));
    setCurrentInvoice({
      ...currentInvoice,
      items: updatedItems,
      subtotal: newSubtotal,
      totalQuantity: updatedItems.reduce((s, i) => s + i.baseQuantity, 0)
    });
  };

  const handleRemoveItem = (itemId: string) => {
    if (!currentInvoice) return;
    const updatedItems = currentInvoice.items.filter((item) => item.id !== itemId);
    const newSubtotal = roundTallyStyle(updatedItems.reduce((s, i) => s + i.amount, 0));
    setCurrentInvoice({
      ...currentInvoice,
      items: updatedItems,
      subtotal: newSubtotal,
      totalQuantity: updatedItems.reduce((s, i) => s + i.baseQuantity, 0)
    });
  };

  const handleExportPDF = useCallback(() => {
    if (!currentInvoice) return;
    if (!validationResult?.passed) { toast.error("Fix validation errors before exporting"); return; }
    try {
      setIsExporting(true);
      downloadInvoicePDF(currentInvoice);
      toast.success(`Downloaded PDF: Invoice_${currentInvoice.header.invoiceNo || "DRAFT"}`);
    } catch { toast.error("Failed to export PDF"); }
    finally { setIsExporting(false); }
  }, [currentInvoice, validationResult, toast]);

  const handlePrint = useCallback((format: "a4" | "thermal") => {
    if (!currentInvoice) return;
    setShowPrintMenu(false);
    try {
      printInvoice(currentInvoice, {}, format);
      toast.success(`Printing ${format === "a4" ? "A4 invoice" : "thermal receipt"}...`);
    } catch { toast.error("Failed to open print dialog"); }
  }, [currentInvoice, toast]);

  const handlePushToTally = useCallback(async () => {
    if (!currentInvoice) return;
    const validation = validateInvoiceForPush(currentInvoice);
    if (!validation.valid) {
      toast.error(`Cannot push: ${validation.errors.slice(0, 3).join("; ")}`);
      return;
    }
    if (!validationResult?.passed) { toast.error("Fix validation errors first"); return; }
    if (currentInvoice.header.status === "exported") {
      toast.error("Invoice already exported to Tally");
      return;
    }
    try {
      setIsPushing(true);
      setPushResult(null);
      const partyLedger = tallyData?.ledgers?.get(currentInvoice.header.partyId.toUpperCase());
      const result = await pushInvoiceToTally(currentInvoice, partyLedger, DEFAULT_PUSH_CONFIG);
      setPushResult(result);
      if (result.success) {
        toast.success(`Created in Tally${result.lastVoucherId ? ` (ID: ${result.lastVoucherId})` : ""}`);
        setCurrentInvoice({ ...currentInvoice, header: { ...currentInvoice.header, status: "exported" } });
      } else {
        toast.error(result.lineErrors.length > 0 ? result.lineErrors[0] : "Push to Tally failed");
      }
    } catch (e: any) { toast.error(e.message || "Failed to push to Tally"); }
    finally { setIsPushing(false); }
  }, [currentInvoice, validationResult, tallyData, setCurrentInvoice, toast]);

  // ─── Empty state ──────────────────────────────────────────
  if (!tallyData) {
    return (
      <div className="empty-state h-[60vh]">
        <div className="w-16 h-16 rounded-2xl bg-neutral-100 flex items-center justify-center mb-5">
          <IndianRupee size={32} className="text-neutral-400" />
        </div>
        <h2 className="empty-state-title">No Data Loaded</h2>
        <p className="empty-state-description">Import your Tally data to create sales invoices</p>
        <button onClick={() => navigate("/import")} className="btn-primary gap-2">
          <Upload size={16} /> Go to Import
        </button>
      </div>
    );
  }

  if (!currentInvoice) {
    return (
      <div className="page-section">
        <div className="card flex items-center justify-center py-16">
          <Loader2 size={24} className="animate-spin text-neutral-400" />
          <span className="ml-3 text-neutral-500">Initializing invoice...</span>
        </div>
      </div>
    );
  }

  const fmtAmount = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ─── Main render ──────────────────────────────────────────
  return (
    <div className="page-section">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Sales Invoice</h1>
          <p className="page-subtitle">
            {currentInvoice.items.length} item{currentInvoice.items.length !== 1 ? "s" : ""} · ₹{fmtAmount(currentInvoice.subtotal)}
            {currentInvoice.header.partyName && ` · ${currentInvoice.header.partyName}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={clsx(
            "status-badge",
            validationResult?.passed ? "status-badge-active" : currentInvoice.items.length > 0 ? "status-badge-pending" : "status-badge-inactive"
          )}>
            {validationResult?.passed ? "Valid" : currentInvoice.items.length > 0 ? "Draft" : "Empty"}
          </span>
        </div>
      </div>

      {/* Invoice Header Card */}
      <div className="section-card">
        <div className="section-card-header">
          <h3 className="card-title">Invoice Details</h3>
          <span className="caption-text">{currentInvoice.header.date}</span>
        </div>
        <div className="section-card-body">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div className="input-group">
              <label className="form-label" htmlFor="sales-party">Party</label>
              <select
                id="sales-party"
                value={currentInvoice.header.partyId}
                onChange={(e) => handlePartyChange(e.target.value)}
                className="form-select w-full"
              >
                <option value="">Select party...</option>
                {availableParties.map((party) => (
                  <option key={party.ledgerId} value={party.ledgerId}>{party.name}</option>
                ))}
              </select>
              <p className="form-helper">{availableParties.length} customers available</p>
            </div>

            <div className="input-group">
              <label className="form-label" htmlFor="sales-date">Invoice Date</label>
              <input
                id="sales-date"
                type="date"
                value={currentInvoice.header.date}
                onChange={(e) => setCurrentInvoice({
                  ...currentInvoice,
                  header: { ...currentInvoice.header, date: e.target.value }
                })}
                className="form-input w-full"
              />
            </div>

            <div className="input-group">
              <label className="form-label" htmlFor="sales-invno">Invoice No.</label>
              <input
                id="sales-invno"
                type="text"
                value={currentInvoice.header.invoiceNo ?? ""}
                onChange={(e) => setCurrentInvoice({
                  ...currentInvoice,
                  header: { ...currentInvoice.header, invoiceNo: e.target.value }
                })}
                placeholder="Auto-generated if blank"
                className="form-input w-full"
              />
              <p className="form-helper">Optional — leave blank for auto</p>
            </div>
          </div>
        </div>
      </div>

      {/* Items Table Card */}
      <div className="section-card">
        <div className="section-card-header">
          <h3 className="card-title">Line Items</h3>
          <div className="flex items-center gap-1 bg-neutral-100 rounded-lg p-0.5">
            <button
              onClick={() => setUnitMode("base")}
              className={clsx(
                "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                unitMode === "base"
                  ? "bg-white text-neutral-950 shadow-sm"
                  : "text-neutral-500 hover:text-neutral-700"
              )}
            >
              Base
            </button>
            <button
              onClick={() => setUnitMode("package")}
              className={clsx(
                "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                unitMode === "package"
                  ? "bg-white text-neutral-950 shadow-sm"
                  : "text-neutral-500 hover:text-neutral-700"
              )}
            >
              Package
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th className="table-header">Item Name</th>
                <th className="table-header text-right">Qty</th>
                <th className="table-header text-right">Unit</th>
                <th className="table-header text-right">Rate (₹)</th>
                <th className="table-header text-right">Amount (₹)</th>
                <th className="table-header text-center w-12"></th>
              </tr>
            </thead>
            <tbody>
              {currentInvoice.items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center">
                    <div className="flex flex-col items-center gap-2">
                      <Package size={24} className="text-neutral-300" />
                      <p className="text-sm text-neutral-500">No items yet</p>
                      <p className="caption-text">Search and add items below</p>
                    </div>
                  </td>
                </tr>
              ) : (
                currentInvoice.items.map((item, idx) => (
                  <tr key={item.id} className="responsive-table-row">
                    <td className="table-cell-emphasis">{item.itemName}</td>
                    <td className="table-cell text-right">
                      <input
                        type="number"
                        value={item.quantity}
                        onChange={(e) => handleQuantityChange(item.id, parseFloat(e.target.value) || 0)}
                        className="form-input w-20 text-right tabular-nums py-1 px-2 text-sm"
                        min="0"
                        step="0.01"
                      />
                    </td>
                    <td className="table-cell-muted text-right">
                      {unitMode === "base" ? item.baseUnitName : item.packageUnitName}
                    </td>
                    <td className="table-cell-right">
                      {fmtAmount(unitMode === "base" ? item.ratePerBaseUnit : item.ratePerPackageUnit)}
                    </td>
                    <td className="table-cell-right font-semibold">
                      {fmtAmount(item.amount)}
                    </td>
                    <td className="table-cell text-center">
                      <button
                        onClick={() => handleRemoveItem(item.id)}
                        className="btn-icon w-7 h-7 text-neutral-400 hover:text-danger"
                        aria-label={`Remove ${item.itemName}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
              {/* Totals row */}
              {currentInvoice.items.length > 0 && (
                <tr className="table-footer-row">
                  <td className="table-cell">
                    <span className="font-semibold">{currentInvoice.items.length} item{currentInvoice.items.length !== 1 ? "s" : ""}</span>
                  </td>
                  <td className="table-cell text-right font-semibold tabular-nums">
                    {currentInvoice.totalQuantity.toFixed(2)}
                  </td>
                  <td className="table-cell"></td>
                  <td className="table-cell text-right font-semibold">Total</td>
                  <td className="table-cell text-right font-bold tabular-nums text-accent">
                    ₹{fmtAmount(currentInvoice.subtotal)}
                  </td>
                  <td className="table-cell"></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Add Item Row */}
        <div className="px-6 py-4 border-t border-neutral-200 bg-neutral-50/50">
          <div className="flex gap-2 items-end">
            <div className="flex-1 input-group">
              <label className="form-label text-xs" htmlFor="add-item-select">Add Item</label>
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 pointer-events-none" />
                <input
                  type="text"
                  value={itemSearch}
                  onChange={(e) => setItemSearch(e.target.value)}
                  placeholder={`Search ${availableItems.length} items...`}
                  className="form-input w-full pl-9 text-sm"
                />
              </div>
              {itemSearch && (
                <div className="mt-1 max-h-40 overflow-y-auto bg-white border border-neutral-200 rounded-lg shadow-lg">
                  {availableItems.slice(0, 20).map((item) => (
                    <button
                      key={item.itemId}
                      onClick={() => {
                        setSelectedItemId(item.itemId);
                        setItemSearch(item.name);
                      }}
                      className={clsx(
                        "w-full text-left px-3 py-2 text-sm hover:bg-neutral-50 transition-colors border-b border-neutral-100 last:border-0",
                        selectedItemId === item.itemId && "bg-accent/5 text-accent font-medium"
                      )}
                    >
                      <span className="truncate block">{item.name}</span>
                      <span className="caption-text">{item.baseUnit} · ₹{(item.currentRate ?? 0).toFixed(2)}</span>
                    </button>
                  ))}
                  {availableItems.length > 20 && (
                    <p className="px-3 py-2 caption-text text-center">
                      {availableItems.length - 20} more — refine your search
                    </p>
                  )}
                  {availableItems.length === 0 && (
                    <p className="px-3 py-3 text-sm text-neutral-500 text-center">No matching items</p>
                  )}
                </div>
              )}
            </div>
            <button
              onClick={handleAddItem}
              disabled={!selectedItemId}
              className="btn-primary"
            >
              <Plus size={16} />
              Add
            </button>
          </div>
        </div>
      </div>

      {/* Validation Alert */}
      {validationResult && (
        <div className={clsx("alert", validationResult.passed ? "alert-success" : "alert-danger")}>
          {validationResult.passed ? (
            <CheckCircle className="text-success flex-shrink-0 mt-0.5" size={18} />
          ) : (
            <AlertTriangle className="text-danger flex-shrink-0 mt-0.5" size={18} />
          )}
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm">
              {validationResult.passed
                ? "Invoice is valid and ready to export"
                : `${validationResult.errors.length} validation error${validationResult.errors.length !== 1 ? "s" : ""}`}
            </p>
            {validationResult.errors.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 text-sm text-neutral-700">
                {validationResult.errors.slice(0, 5).map((error, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <span className="text-danger mt-1 text-xs">&#9679;</span>
                    {error}
                  </li>
                ))}
                {validationResult.errors.length > 5 && (
                  <li className="text-neutral-500">+{validationResult.errors.length - 5} more</li>
                )}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* GST Indicator */}
      {currentInvoice.header.partyName && (() => {
        const partyLedger = tallyData?.ledgers ? Array.from(tallyData.ledgers.values()).find((l: any) => l.name === currentInvoice.header.partyName) : undefined;
        const gstType = gstTypeFromGSTIN(partyLedger?.gstin ?? currentInvoice.header.partyGST, "19");
        return (
          <div className={clsx("flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg w-fit",
            gstType === "intra" ? "bg-success/10 text-success" : "bg-accent/10 text-accent"
          )}>
            <span className="font-semibold">
              {gstType === "intra" ? "Intra-State (CGST + SGST)" : "Inter-State (IGST)"}
            </span>
            {partyLedger?.gstin && <span className="opacity-70">{partyLedger.gstin}</span>}
          </div>
        );
      })()}

      {/* Push result display */}
      {pushResult && (
        <div className={clsx("alert", pushResult.success ? "alert-success" : "alert-danger")}>
          {pushResult.success ? (
            <CheckCircle size={16} className="text-success flex-shrink-0" />
          ) : (
            <AlertTriangle size={16} className="text-danger flex-shrink-0" />
          )}
          <div className="flex-1 min-w-0 text-sm">
            {pushResult.success
              ? `Created in Tally${pushResult.lastVoucherId ? ` (Voucher ID: ${pushResult.lastVoucherId})` : ""}`
              : pushResult.lineErrors.join(" | ")}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3 flex-wrap items-center">
        <button
          onClick={() => saveDraft(currentInvoice)}
          className="btn-secondary"
        >
          <FileText size={16} />
          Save Draft
        </button>
        <div className="flex-1" />
        <button
          onClick={handleExportPDF}
          disabled={!validationResult?.passed || isExporting}
          className="btn-secondary"
        >
          {isExporting ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
          {isExporting ? "Exporting..." : "Download PDF"}
        </button>

        {/* Print dropdown */}
        <div className="relative" ref={printMenuRef}>
          <button
            onClick={() => setShowPrintMenu(v => !v)}
            disabled={!validationResult?.passed}
            className="btn-secondary"
          >
            <Printer size={16} />
            Print
            <ChevronDown size={14} />
          </button>
          {showPrintMenu && (
            <div className="absolute right-0 bottom-full mb-1 w-44 bg-white border border-neutral-200 rounded-lg shadow-lg z-50 overflow-hidden">
              <button
                onClick={() => handlePrint("a4")}
                className="w-full text-left px-4 py-2.5 text-sm hover:bg-neutral-50 transition-colors"
              >
                A4 Invoice (GST)
              </button>
              <button
                onClick={() => handlePrint("thermal")}
                className="w-full text-left px-4 py-2.5 text-sm hover:bg-neutral-50 transition-colors border-t border-neutral-100"
              >
                Thermal Receipt (80mm)
              </button>
            </div>
          )}
        </div>

        <button
          onClick={handlePushToTally}
          disabled={!validationResult?.passed || isPushing || currentInvoice.header.status === "exported"}
          className="btn-primary"
        >
          {isPushing ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          {isPushing ? "Pushing..." : currentInvoice.header.status === "exported" ? "Exported ✓" : "Push to Tally"}
        </button>
      </div>
    </div>
  );
}
