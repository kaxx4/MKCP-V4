/**
 * Sales Page
 * Create and manage pro-forma sales invoices with Tally integration
 */

import { useState, useEffect, useCallback } from "react";
import { Plus, FileText, Send, AlertTriangle, CheckCircle } from "lucide-react";
import clsx from "clsx";
import { useDataStore } from "../store/dataStore";
import { useSalesStore } from "../store/salesStore";
import { validateInvoice, roundTallyStyle } from "../services/salesValidator";
import { useToast } from "../components/Toast";
import type {
  SalesInvoice,
  SalesInvoiceLineItem,
  ValidationResult
} from "../types/sales";

export default function SalesPage() {
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

    const timer = setTimeout(validateAsync, 500); // Debounce
    return () => clearTimeout(timer);
  }, [currentInvoice?.items, tallyData, currentInvoice, setCurrentInvoice]);

  const handlePartyChange = (partyId: string) => {
    if (!currentInvoice) return;

    const party = tallyData?.ledgers.get(partyId);
    if (!party) {
      toast.error("Party not found");
      return;
    }

    setCurrentInvoice({
      ...currentInvoice,
      header: {
        ...currentInvoice.header,
        partyId,
        partyName: party.name
      }
    });
  };

  const handleAddItem = useCallback(() => {
    if (!currentInvoice || !selectedItemId) {
      toast.error("Please select an item");
      return;
    }

    const tallyItem = tallyData?.items.get(selectedItemId);
    if (!tallyItem) {
      toast.error("Item not found in Tally data");
      return;
    }

    const newItem: SalesInvoiceLineItem = {
      id: crypto.randomUUID(),
      itemId: selectedItemId,
      itemName: tallyItem.name,
      quantity: 1,
      unitType: unitMode,
      baseQuantity: 1,
      packageQuantity: 1,
      ratePerBaseUnit: tallyItem.currentRate,
      ratePerPackageUnit: tallyItem.currentRate,
      conversionRatio: 1,
      baseUnitName: tallyItem.baseUnit,
      packageUnitName: "pkg",
      amount: tallyItem.currentRate,
      validationStatus: "valid",
      validationMessages: []
    };

    const updatedItems = [...currentInvoice.items, newItem];
    const newSubtotal = roundTallyStyle(
      updatedItems.reduce((sum, item) => sum + item.amount, 0)
    );

    setCurrentInvoice({
      ...currentInvoice,
      items: updatedItems,
      subtotal: newSubtotal,
      totalQuantity: updatedItems.reduce((sum, item) => sum + item.baseQuantity, 0)
    });

    setSelectedItemId("");
    toast.success(`Added ${tallyItem.name} to invoice`);
  }, [currentInvoice, selectedItemId, tallyData, unitMode, setCurrentInvoice, toast]);

  const handleQuantityChange = (itemId: string, newQuantity: number) => {
    if (!currentInvoice) return;

    const updatedItems = currentInvoice.items.map((item) => {
      if (item.id !== itemId) return item;

      const baseQty = item.unitType === "base" ? newQuantity : newQuantity * item.conversionRatio;
      const amount = roundTallyStyle(baseQty * item.ratePerBaseUnit);

      return {
        ...item,
        quantity: newQuantity,
        baseQuantity: baseQty,
        packageQuantity: baseQty / item.conversionRatio,
        amount
      };
    });

    const newSubtotal = roundTallyStyle(
      updatedItems.reduce((sum, item) => sum + item.amount, 0)
    );

    setCurrentInvoice({
      ...currentInvoice,
      items: updatedItems,
      subtotal: newSubtotal,
      totalQuantity: updatedItems.reduce((sum, item) => sum + item.baseQuantity, 0)
    });
  };

  const handleRemoveItem = (itemId: string) => {
    if (!currentInvoice) return;

    const updatedItems = currentInvoice.items.filter((item) => item.id !== itemId);
    const newSubtotal = roundTallyStyle(
      updatedItems.reduce((sum, item) => sum + item.amount, 0)
    );

    setCurrentInvoice({
      ...currentInvoice,
      items: updatedItems,
      subtotal: newSubtotal,
      totalQuantity: updatedItems.reduce((sum, item) => sum + item.baseQuantity, 0)
    });
  };

  const handleUnitToggle = (newMode: "base" | "package") => {
    setUnitMode(newMode);
  };

  const handleExportPDF = () => {
    if (!validationResult?.passed) {
      toast.error("Fix validation errors before exporting");
      return;
    }
    toast.info("PDF export coming soon");
  };

  const handlePushToTally = () => {
    if (!validationResult?.passed) {
      toast.error("Cannot push invalid invoice to Tally");
      return;
    }
    toast.info("Tally push coming soon");
  };

  if (!currentInvoice) {
    return <div className="p-6">Loading invoice...</div>;
  }

  const availableItems = Array.from(tallyData?.items.values() ?? []).filter(
    (item) => !currentInvoice.items.some((li) => li.itemId === item.itemId)
  );

  const availableParties = Array.from(tallyData?.ledgers.values() ?? []).filter(
    (ledger) => ledger.type === "Customer"
  );

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl md:text-4xl font-bold text-primary">Sales Invoices</h1>
        <p className="text-muted mt-2">Create pro-forma sales invoices with Tally data</p>
      </div>

      {/* Invoice Header */}
      <div className="card-standard grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label className="form-label">Party</label>
          <select
            value={currentInvoice.header.partyId}
            onChange={(e) => handlePartyChange(e.target.value)}
            className="form-select w-full"
          >
            <option value="">Select party...</option>
            {availableParties.map((party) => (
              <option key={party.ledgerId} value={party.ledgerId}>
                {party.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="form-label">Invoice Date</label>
          <input
            type="date"
            value={currentInvoice.header.date}
            onChange={(e) =>
              setCurrentInvoice({
                ...currentInvoice,
                header: { ...currentInvoice.header, date: e.target.value }
              })
            }
            className="form-input w-full"
          />
        </div>

        <div>
          <label className="form-label">Invoice No. (Optional)</label>
          <input
            type="text"
            value={currentInvoice.header.invoiceNo ?? ""}
            onChange={(e) =>
              setCurrentInvoice({
                ...currentInvoice,
                header: { ...currentInvoice.header, invoiceNo: e.target.value }
              })
            }
            placeholder="INV-001"
            className="form-input w-full"
          />
        </div>
      </div>

      {/* Items Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-primary">Items</h2>
          <div className="flex items-center gap-2">
            <label className="text-sm text-muted">Unit:</label>
            <div className="flex border border-bg-border rounded-lg">
              <button
                onClick={() => handleUnitToggle("base")}
                className={clsx(
                  "px-3 py-1 text-sm transition-all",
                  unitMode === "base"
                    ? "bg-accent text-white"
                    : "bg-transparent text-primary hover:bg-bg-hover"
                )}
              >
                Base Units
              </button>
              <button
                onClick={() => handleUnitToggle("package")}
                className={clsx(
                  "px-3 py-1 text-sm transition-all border-l border-bg-border",
                  unitMode === "package"
                    ? "bg-accent text-white"
                    : "bg-transparent text-primary hover:bg-bg-hover"
                )}
              >
                Packages
              </button>
            </div>
          </div>
        </div>

        {/* Items Table */}
        <div className="overflow-x-auto card-standard">
          <table className="w-full text-sm">
            <thead className="border-b border-bg-border bg-bg-hover">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">Item Name</th>
                <th className="text-right px-4 py-3 font-semibold">
                  Qty ({unitMode === "base" ? "Base" : "Pkg"})
                </th>
                <th className="text-right px-4 py-3 font-semibold">Unit</th>
                <th className="text-right px-4 py-3 font-semibold">
                  Rate (₹/{unitMode === "base" ? "Base" : "Pkg"})
                </th>
                <th className="text-right px-4 py-3 font-semibold">Amount (₹)</th>
                <th className="text-center px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {currentInvoice.items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted">
                    No items added yet. Select an item below to get started.
                  </td>
                </tr>
              ) : (
                currentInvoice.items.map((item) => (
                  <tr key={item.id} className="border-b border-bg-border hover:bg-bg-hover/50">
                    <td className="px-4 py-3 font-medium">{item.itemName}</td>
                    <td className="px-4 py-3 text-right">
                      <input
                        type="number"
                        value={item.quantity}
                        onChange={(e) =>
                          handleQuantityChange(item.id, parseFloat(e.target.value) || 0)
                        }
                        className="form-input w-20 text-right"
                        min="0"
                        step="0.01"
                      />
                    </td>
                    <td className="px-4 py-3 text-right text-muted">
                      {unitMode === "base" ? item.baseUnitName : item.packageUnitName}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {(unitMode === "base"
                        ? item.ratePerBaseUnit
                        : item.ratePerPackageUnit
                      ).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-bold">
                      {item.amount.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => handleRemoveItem(item.id)}
                        className="text-danger hover:text-danger-700 transition-colors"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Add Item Row */}
        <div className="flex gap-2">
          <select
            value={selectedItemId}
            onChange={(e) => setSelectedItemId(e.target.value)}
            className="form-select flex-1"
          >
            <option value="">Select item to add...</option>
            {availableItems.map((item) => (
              <option key={item.itemId} value={item.itemId}>
                {item.name}
              </option>
            ))}
          </select>
          <button
            onClick={handleAddItem}
            disabled={!selectedItemId}
            className="btn-primary flex items-center gap-2"
          >
            <Plus size={18} />
            Add Item
          </button>
        </div>
      </div>

      {/* Summary */}
      <div className="card-premium grid grid-cols-3 gap-4 md:gap-6">
        <div>
          <p className="text-sm text-muted mb-1">Total Items</p>
          <p className="text-2xl font-bold text-primary">
            {currentInvoice.totalQuantity.toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-sm text-muted mb-1">Item Count</p>
          <p className="text-2xl font-bold text-primary">{currentInvoice.items.length}</p>
        </div>
        <div>
          <p className="text-sm text-muted mb-1">Total Amount</p>
          <p className="text-2xl font-bold text-accent">₹{currentInvoice.subtotal.toFixed(2)}</p>
        </div>
      </div>

      {/* Validation Status */}
      {validationResult && (
        <div
          className={clsx(
            "rounded-lg p-4 border",
            validationResult.passed
              ? "bg-success/5 border-success/30"
              : "bg-danger/5 border-danger/30"
          )}
        >
          <div className="flex items-start gap-3">
            {validationResult.passed ? (
              <CheckCircle className="text-success flex-shrink-0 mt-0.5" size={20} />
            ) : (
              <AlertTriangle className="text-danger flex-shrink-0 mt-0.5" size={20} />
            )}
            <div className="flex-1 min-w-0">
              <p className={clsx("font-semibold", validationResult.passed ? "text-success" : "text-danger")}>
                {validationResult.passed
                  ? "Invoice is valid and ready to export"
                  : `${validationResult.errors.length} error(s) found`}
              </p>
              {validationResult.errors.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm text-danger">
                  {validationResult.errors.slice(0, 3).map((error, i) => (
                    <li key={i}>• {error}</li>
                  ))}
                  {validationResult.errors.length > 3 && (
                    <li>• And {validationResult.errors.length - 3} more...</li>
                  )}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex gap-3 flex-wrap">
        <button onClick={() => saveDraft(currentInvoice)} className="btn-secondary">
          <FileText size={18} />
          Save Draft
        </button>
        <button
          onClick={handleExportPDF}
          disabled={!validationResult?.passed}
          className="btn-primary"
        >
          Export PDF
        </button>
        <button
          onClick={handlePushToTally}
          disabled={!validationResult?.passed}
          className="btn-accent flex items-center gap-2"
        >
          <Send size={18} />
          Push to Tally
        </button>
      </div>
    </div>
  );
}
