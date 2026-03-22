import { useState, useRef, useEffect } from "react";
import { Settings as SettingsIcon, Trash2, Download, Upload, AlertTriangle, FileSpreadsheet, Archive, RotateCcw, Shield, HardDrive, Activity, Wifi, RefreshCw } from "lucide-react";
import clsx from "clsx";
import { useUIStore } from "../store/uiStore";
import { useDataStore } from "../store/dataStore";
import { useOverrideStore } from "../store/overrideStore";
import { useTallyStore } from "../store/tallyStore";
import { clearAllData, listBackups, loadBackup, deleteBackup, exportBackupAsJSON, exportFullBackupAsJSON, eraseAllStores, listJsonUploads } from "../db/idb";
import { useToast } from "../components/Toast";
import { exportUnitsToExcel, importUnitsFromExcel } from "../utils/unitExcelHandler";
import { deserializeParsedData } from "../utils/serialize";
import { checkTallyHealth } from "../api/tallyApi";

export default function Settings() {
  const { unitMode, toggleUnitMode, fyYear, setFyYear, coverMonths, setCoverMonths, leadTimeMonths, setLeadTimeMonths, defaultCreditDays, setDefaultCreditDays } = useUIStore();
  const { clearData, data, refreshOverrides, voucherIndex } = useDataStore();
  const { exportAuditLog, units, setUnitOverride } = useOverrideStore();
  const { toast } = useToast();
  const [confirmClear, setConfirmClear] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [backups, setBackups] = useState<Array<{ key: string; label: string; createdAt: string }>>([]);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [eraseStep, setEraseStep] = useState<"idle" | "confirm" | "downloading" | "done">("idle");
  const [jsonUploads, setJsonUploads] = useState<string[]>([]);
  const [auditResults, setAuditResults] = useState<any>(null);
  const [runningAudit, setRunningAudit] = useState(false);
  const [showDiscrepancies, setShowDiscrepancies] = useState(false);
  const [showNegativeStock, setShowNegativeStock] = useState(false);
  const [showNoGstItems, setShowNoGstItems] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load backups and json uploads on mount
  useEffect(() => {
    loadBackupsList();
    loadJsonUploadsList();
  }, []);

  async function loadBackupsList() {
    const list = await listBackups();
    setBackups(list);
  }

  async function loadJsonUploadsList() {
    const files = await listJsonUploads();
    setJsonUploads(files);
  }

  async function handleRestoreBackup(key: string) {
    if (confirmRestore !== key) {
      setConfirmRestore(key);
      return;
    }

    try {
      const backupData = await loadBackup(key);
      if (!backupData) {
        toast("Backup not found", "error");
        return;
      }

      const parsedData = deserializeParsedData(backupData);
      clearData();
      useDataStore.getState().setData(parsedData);

      toast("Backup restored successfully", "success");
      setConfirmRestore(null);
    } catch (err) {
      toast(`Restore failed: ${err instanceof Error ? err.message : "Unknown error"}`, "error");
    }
  }

  async function handleDownloadBackup(key: string) {
    try {
      const blob = await exportBackupAsJSON(key);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${key}.json`;
      a.click();
      toast("Backup downloaded", "success");
    } catch (err) {
      toast(`Download failed: ${err instanceof Error ? err.message : "Unknown error"}`, "error");
    }
  }

  async function handleDeleteBackup(key: string) {
    try {
      await deleteBackup(key);
      await loadBackupsList();
      toast("Backup deleted", "info");
    } catch (err) {
      toast(`Delete failed: ${err instanceof Error ? err.message : "Unknown error"}`, "error");
    }
  }

  async function handleClearData() {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    clearData();
    await clearAllData();
    setConfirmClear(false);
    toast("All data cleared", "info");
  }

  async function handleEraseData() {
    if (eraseStep === "idle") {
      setEraseStep("confirm");
      return;
    }
    if (eraseStep === "confirm") {
      setEraseStep("downloading");
      try {
        const blob = await exportFullBackupAsJSON();
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const filename = `MKCP_full_backup_${timestamp}.json`;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        toast(`Backup downloaded as ${filename}`, "success");
        await new Promise(resolve => setTimeout(resolve, 1500));
        await eraseAllStores();
        clearData();
        localStorage.removeItem("mkcycles-overrides");
        localStorage.removeItem("mkcycles-ui");
        localStorage.removeItem("mkcycles-orders");
        setEraseStep("done");
        toast("All data erased. A backup was saved locally.", "info");
        setTimeout(() => setEraseStep("idle"), 3000);
      } catch (err) {
        toast(`Erase failed: ${err instanceof Error ? err.message : "Unknown error"}`, "error");
        setEraseStep("idle");
      }
    }
  }

  function handleExportAudit() {
    const json = exportAuditLog();
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `audit_log_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    toast("Audit log exported", "success");
  }

  function handleExportDiscrepancies() {
    if (!auditResults || auditResults.failures.length === 0) {
      toast("No discrepancies to export", "info");
      return;
    }

    // CSV format
    const headers = ["Item Name", "Item ID", "Opening Qty", "Inwards", "Outwards", "Expected Closing", "Computed Closing", "Discrepancy"];
    const rows = auditResults.failures.map((f: any) => [
      f.itemName,
      f.itemId,
      f.openingQtyBase.toFixed(4),
      f.totalInwards.toFixed(4),
      f.totalOutwards.toFixed(4),
      f.expectedClosing.toFixed(4),
      f.computedClosing.toFixed(4),
      f.discrepancy.toFixed(4),
    ]);

    const csv = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `inventory_discrepancies_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    toast("Discrepancies exported to CSV", "success");
  }

  function handleExportUnits() {
    if (!data) {
      toast("No data loaded. Import data first.", "error");
      return;
    }
    try {
      exportUnitsToExcel(data.items, units);
      toast("Unit configuration exported successfully", "success");
    } catch (err) {
      toast(`Export failed: ${err instanceof Error ? err.message : "Unknown error"}`, "error");
    }
  }

  function handleImportUnitsClick() {
    fileInputRef.current?.click();
  }

  async function handleImportUnits(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !data) return;

    setIsImporting(true);
    try {
      const { overrides, errors } = await importUnitsFromExcel(file, data.items);

      if (errors.length > 0) {
        // Show first few errors
        const errorMsg = errors.slice(0, 3).join("; ");
        toast(`Import warnings: ${errorMsg}${errors.length > 3 ? ` (${errors.length - 3} more)` : ""}`, "warn");
      }

      if (overrides.length > 0) {
        // Apply overrides
        for (const override of overrides) {
          setUnitOverride(override.itemId, override);
        }
        // Refresh data to apply the new overrides
        refreshOverrides();
        toast(`Successfully imported ${overrides.length} unit configuration(s)`, "success");
      } else if (errors.length === 0) {
        toast("No changes found in the imported file", "info");
      }
    } catch (err) {
      toast(`Import failed: ${err instanceof Error ? err.message : "Unknown error"}`, "error");
    } finally {
      setIsImporting(false);
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function handleRunAudit() {
    if (!data) {
      toast("No data loaded. Import data first.", "error");
      return;
    }

    setRunningAudit(true);
    try {
      const { auditAllItems, auditInvoiceBalance, getVoucherTypeDistribution, findNegativeStockItems, findDeadItems, findItemsWithoutGST } = await import("../engine/audit");

      const itemAudit = auditAllItems(data.items, data.vouchers, voucherIndex);
      const invoiceAudit = auditInvoiceBalance(data.vouchers, data.ledgers);
      const voucherDist = getVoucherTypeDistribution(data.vouchers);
      const negativeStock = findNegativeStockItems(data.items, voucherIndex);
      const deadItems = findDeadItems(data.items, voucherIndex);
      const noGstItems = findItemsWithoutGST(data.items);

      const failures = itemAudit.filter((r) => Math.abs(r.discrepancy) > 1e-9);
      const chainBreaks = itemAudit.filter((r) => !r.monthlyChainValid);

      setAuditResults({
        itemAudit,
        failures,
        chainBreaks,
        invoiceAudit,
        voucherDist,
        negativeStock,
        deadItems,
        noGstItems,
        passCount: itemAudit.length - failures.length,
        totalCount: itemAudit.length,
      });

      if (failures.length === 0) {
        toast(`✓ All ${itemAudit.length} items passed audit`, "success");
      } else {
        toast(`⚠ ${failures.length} of ${itemAudit.length} items have discrepancies`, "warn");
      }
    } catch (err) {
      toast(`Audit failed: ${err instanceof Error ? err.message : "Unknown error"}`, "error");
    } finally {
      setRunningAudit(false);
    }
  }

  const fyOptions: string[] = [];
  const currentYear = new Date().getFullYear();
  for (let y = currentYear - 3; y <= currentYear + 1; y++) {
    fyOptions.push(`${y}-${y + 1}`);
  }

  return (
    <div className="max-w-xl space-y-6">
      <div className="page-header">
        <h1 className="page-title flex items-center gap-3">
          <SettingsIcon size={24} className="text-accent" />
          Settings
        </h1>
      </div>

      {/* Local Data Storage */}
      <Section title="Local Data Storage">
        <div className="space-y-3">
          <div className="flex items-center gap-2 mb-2">
            <HardDrive size={14} className="text-accent" />
            <span className="text-xs text-muted">All data is stored locally in your browser (IndexedDB). Nothing is sent to any server.</span>
          </div>
          {data ? (
            <>
              <div className="grid grid-cols-3 gap-3 text-center">
                <Stat label="Items" value={data.items.size} />
                <Stat label="Ledgers" value={data.ledgers.size} />
                <Stat label="Vouchers" value={data.vouchers.length} />
              </div>
              {jsonUploads.length > 0 && (
                <p className="text-xs text-accent">
                  {jsonUploads.length} JSON file(s) persisted locally
                </p>
              )}
              <p className="text-muted text-xs">
                Source: {data.sourceFiles.join(", ")}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted italic">No data loaded</p>
          )}
        </div>
      </Section>

      {/* Tally Connection */}
      <TallyConnectionSection />

      {/* Unit Mode */}
      <Section title="Unit Mode">
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted">Currently: <span className="text-primary tabular-nums">{unitMode}</span></span>
          <button onClick={toggleUnitMode}
            className="btn-primary btn-sm">
            Switch to {unitMode === "BASE" ? "PKG" : "BASE"}
          </button>
        </div>
      </Section>

      {/* Financial Year */}
      <Section title="Financial Year">
        <select value={fyYear} onChange={(e) => setFyYear(e.target.value)}
          className="form-select">
          {fyOptions.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </Section>

      {/* Cover Months */}
      <Section title="Default Cover Months">
        <div className="flex gap-2">
          {[1, 1.5, 2, 3].map((m) => (
            <button key={m} onClick={() => setCoverMonths(m)}
              className={clsx("btn-sm tabular-nums", coverMonths === m ? "btn-primary" : "btn-secondary")}>
              {m}
            </button>
          ))}
        </div>
      </Section>

      {/* Lead Time */}
      <Section title="Lead Time Months">
        <input type="number" value={leadTimeMonths} min={0.5} max={6} step={0.5}
          onChange={(e) => setLeadTimeMonths(parseFloat(e.target.value) || 1.5)}
          className="form-input w-24" />
      </Section>

      {/* Default Credit Days */}
      <Section title="Default Credit Days">
        <input type="number" value={defaultCreditDays} min={0} max={365}
          onChange={(e) => setDefaultCreditDays(parseInt(e.target.value) || 30)}
          className="form-input w-24" />
      </Section>

      {/* Unit Configuration Export/Import */}
      <Section title="Unit Configuration (Base & Package Units)">
        <div className="space-y-3">
          <p className="text-xs text-muted">
            Export item units to Excel, edit package configurations, then import back.
          </p>
          <div className="flex gap-3">
            <button
              onClick={handleExportUnits}
              disabled={!data}
              className="btn-primary btn-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <FileSpreadsheet size={14} />
              Export Template
            </button>
            <button
              onClick={handleImportUnitsClick}
              disabled={!data || isImporting}
              className="btn-secondary btn-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Upload size={14} />
              {isImporting ? "Importing..." : "Import Excel"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={handleImportUnits}
              className="hidden"
            />
          </div>
          {units && Object.keys(units).length > 0 && (
            <p className="text-xs text-accent">
              {Object.keys(units).length} unit override(s) currently applied
            </p>
          )}
        </div>
      </Section>

      {/* Diagnostics */}
      <Section title="Diagnostics">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Activity size={14} className="text-accent" />
            <span className="text-xs text-muted">Run comprehensive data integrity checks</span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleRunAudit}
              disabled={!data || runningAudit}
              className="btn-primary btn-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Activity size={14} />
              {runningAudit ? "Running Audit..." : "Run Audit"}
            </button>
            {auditResults && auditResults.failures.length > 0 && (
              <button
                onClick={handleExportDiscrepancies}
                className="btn-secondary btn-sm"
              >
                <Download size={14} />
                Export Discrepancies CSV
              </button>
            )}
          </div>

          {auditResults && (
            <div className="space-y-3 bg-bg border border-bg-border rounded-lg p-3 text-sm">
              {/* Summary */}
              <div className="grid grid-cols-2 gap-2">
                <div className="bento-card text-center">
                  <div className={clsx("metric-value", auditResults.failures.length === 0 ? "text-success" : "text-danger")}>
                    {auditResults.passCount}/{auditResults.totalCount}
                  </div>
                  <div className="metric-label">Items Passed</div>
                </div>
                <div className="bento-card text-center">
                  <div className={clsx("metric-value", auditResults.chainBreaks.length === 0 ? "text-success" : "text-warn")}>
                    {auditResults.totalCount - auditResults.chainBreaks.length}/{auditResults.totalCount}
                  </div>
                  <div className="metric-label">Chain Valid</div>
                </div>
              </div>

              {/* Invoice Balance */}
              <div className="border-t border-bg-border pt-2">
                <div className="text-xs font-semibold text-muted mb-1">Invoice Balance</div>
                <div className="grid grid-cols-3 gap-1 text-xs">
                  <div><span className="text-muted">Billed:</span> <span className="tabular-nums text-primary">₹{(auditResults.invoiceAudit.totalBilled / 100000).toFixed(1)}L</span></div>
                  <div><span className="text-muted">Paid:</span> <span className="tabular-nums text-success">₹{(auditResults.invoiceAudit.totalPaid / 100000).toFixed(1)}L</span></div>
                  <div><span className="text-muted">Outstanding:</span> <span className="tabular-nums text-accent">₹{(auditResults.invoiceAudit.totalOutstanding / 100000).toFixed(1)}L</span></div>
                </div>
                {auditResults.invoiceAudit.orphanedPayments.length > 0 && (
                  <div className="text-xs text-warn mt-1">⚠ {auditResults.invoiceAudit.orphanedPayments.length} orphaned payment(s)</div>
                )}
              </div>

              {/* Voucher Distribution */}
              <div className="border-t border-bg-border pt-2">
                <div className="text-xs font-semibold text-muted mb-1">Voucher Types</div>
                <div className="grid grid-cols-2 gap-1 text-xs">
                  {Array.from(auditResults.voucherDist.entries()).map((entry: any) => {
                    const [type, counts] = entry;
                    return (
                      <div key={type}>
                        <span className="text-muted">{type}:</span> <span className="tabular-nums text-primary">{counts.active}</span>
                        {counts.cancelled > 0 && <span className="text-danger ml-1">(-{counts.cancelled})</span>}
                        {counts.optional > 0 && <span className="text-warn ml-1">(~{counts.optional})</span>}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Issues */}
              {(auditResults.failures.length > 0 || auditResults.negativeStock.length > 0 || auditResults.noGstItems.length > 0) && (
                <div className="border-t border-bg-border pt-2">
                  <div className="text-xs font-semibold text-danger mb-1">Issues Found</div>

                  {/* Inventory Discrepancies */}
                  {auditResults.failures.length > 0 && (
                    <div className="space-y-2">
                      <button
                        onClick={() => setShowDiscrepancies(!showDiscrepancies)}
                        className="text-xs text-danger hover:underline cursor-pointer flex items-center gap-1"
                      >
                        • {auditResults.failures.length} item(s) with inventory discrepancies
                        <span className="text-[10px]">{showDiscrepancies ? "▼" : "▶"}</span>
                      </button>
                      {showDiscrepancies && (
                        <div className="ml-3 max-h-64 overflow-y-auto border border-danger/20 rounded p-2 bg-danger/5 space-y-1">
                          <div className="text-[10px] font-semibold text-muted grid grid-cols-6 gap-1 pb-1 border-b border-danger/20">
                            <div className="col-span-2">Item</div>
                            <div className="text-right">Opening</div>
                            <div className="text-right">In</div>
                            <div className="text-right">Out</div>
                            <div className="text-right">Discrepancy</div>
                          </div>
                          {auditResults.failures.map((f: any) => (
                            <div key={f.itemId} className="text-[10px] grid grid-cols-6 gap-1 py-1 border-b border-danger/10 hover:bg-danger/10">
                              <div className="col-span-2 truncate text-primary" title={f.itemName}>{f.itemName}</div>
                              <div className="text-right tabular-nums text-muted">{f.openingQtyBase.toFixed(2)}</div>
                              <div className="text-right tabular-nums text-success">{f.totalInwards.toFixed(2)}</div>
                              <div className="text-right tabular-nums text-danger">{f.totalOutwards.toFixed(2)}</div>
                              <div className="text-right tabular-nums text-danger font-semibold">{f.discrepancy.toFixed(4)}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Negative Stock */}
                  {auditResults.negativeStock.length > 0 && (
                    <div className="space-y-2 mt-2">
                      <button
                        onClick={() => setShowNegativeStock(!showNegativeStock)}
                        className="text-xs text-warn hover:underline cursor-pointer flex items-center gap-1"
                      >
                        • {auditResults.negativeStock.length} item(s) with negative stock
                        <span className="text-[10px]">{showNegativeStock ? "▼" : "▶"}</span>
                      </button>
                      {showNegativeStock && (
                        <div className="ml-3 max-h-64 overflow-y-auto border border-warn/20 rounded p-2 bg-warn/5 space-y-1">
                          <div className="text-[10px] font-semibold text-muted grid grid-cols-2 gap-2 pb-1 border-b border-warn/20">
                            <div>Item</div>
                            <div className="text-right">Current Stock</div>
                          </div>
                          {auditResults.negativeStock.map((item: any) => (
                            <div key={item.itemId} className="text-[10px] grid grid-cols-2 gap-2 py-1 border-b border-warn/10 hover:bg-warn/10">
                              <div className="truncate text-primary" title={item.name}>{item.name}</div>
                              <div className="text-right tabular-nums text-danger font-semibold">{item.currentStock.toFixed(2)}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Items Without GST */}
                  {auditResults.noGstItems.length > 0 && (
                    <div className="space-y-2 mt-2">
                      <button
                        onClick={() => setShowNoGstItems(!showNoGstItems)}
                        className="text-xs text-muted hover:underline cursor-pointer flex items-center gap-1"
                      >
                        • {auditResults.noGstItems.length} item(s) without GST rates
                        <span className="text-[10px]">{showNoGstItems ? "▼" : "▶"}</span>
                      </button>
                      {showNoGstItems && (
                        <div className="ml-3 max-h-64 overflow-y-auto border border-muted/20 rounded p-2 bg-muted/5 space-y-1">
                          <div className="grid grid-cols-2 gap-2">
                            {auditResults.noGstItems.map((item: any) => (
                              <div key={item.itemId} className="text-[10px] truncate text-primary py-1" title={item.name}>
                                {item.name}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Dead Items */}
              {auditResults.deadItems.length > 0 && (
                <div className="border-t border-bg-border pt-2">
                  <div className="text-xs text-muted">ℹ {auditResults.deadItems.length} dead item(s) (zero opening, zero movement)</div>
                </div>
              )}
            </div>
          )}
        </div>
      </Section>

      {/* Export Audit Log */}
      <Section title="Audit Log">
        <button onClick={handleExportAudit}
          className="btn-secondary btn-sm">
          <Download size={14} />Export Audit Log
        </button>
      </Section>

      {/* Backup Management */}
      <Section title="Backup Management">
        <div className="space-y-3">
          <p className="text-xs text-muted">
            Backups are created automatically before each import. You can restore, download, or delete them here.
          </p>
          {backups.length === 0 ? (
            <p className="text-sm text-muted italic">No backups available</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {backups.map((backup) => (
                <div
                  key={backup.key}
                  className="flex items-center justify-between bg-bg border border-bg-border rounded-lg p-3 text-sm"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Archive size={14} className="text-accent flex-shrink-0" />
                      <span className="font-medium text-primary truncate">{backup.label}</span>
                    </div>
                    <p className="text-xs text-muted mt-1">
                      {new Date(backup.createdAt).toLocaleString("en-IN", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    <button
                      onClick={() => handleRestoreBackup(backup.key)}
                      className={clsx(
                        "btn-sm",
                        confirmRestore === backup.key
                          ? "btn-primary bg-success hover:bg-success/80"
                          : "btn-secondary"
                      )}
                    >
                      <RotateCcw size={12} />
                      {confirmRestore === backup.key ? "Confirm?" : "Restore"}
                    </button>
                    <button
                      onClick={() => handleDownloadBackup(backup.key)}
                      className="btn-secondary btn-sm"
                    >
                      <Download size={12} />
                      Download
                    </button>
                    <button
                      onClick={() => handleDeleteBackup(backup.key)}
                      className="btn-danger btn-sm"
                    >
                      <Trash2 size={12} />
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {backups.length > 20 && (
            <p className="text-xs text-warn">
              You have {backups.length} backups. Consider deleting old ones to save space.
            </p>
          )}
        </div>
      </Section>

      {/* Danger Zone */}
      <Section title="Danger Zone">
        <div className="space-y-4">
          {/* Clear Working Data */}
          <div className="space-y-2">
            <p className="text-xs text-muted">Clear in-memory working data (does not delete persisted backups or JSON uploads).</p>
            {confirmClear && (
              <div className="alert alert-danger">
                <AlertTriangle size={14} />
                This will clear all imported data from memory. Click again to confirm.
              </div>
            )}
            <button onClick={handleClearData}
              className="btn-danger btn-sm">
              <Trash2 size={14} />
              {confirmClear ? "Confirm Clear Working Data" : "Clear Working Data"}
            </button>
          </div>

          {/* Erase All Data */}
          <div className="border-t border-bg-border pt-4 space-y-2">
            <div className="flex items-center gap-2">
              <Shield size={14} className="text-danger" />
              <span className="text-sm font-semibold text-danger">Erase All Data (with backup)</span>
            </div>
            <p className="text-xs text-muted">
              Downloads a full backup of ALL data (items, vouchers, overrides, predictions, JSON uploads),
              then permanently erases everything from your browser.
            </p>
            {eraseStep === "confirm" && (
              <div className="alert alert-danger">
                <AlertTriangle size={14} />
                A full backup will be downloaded first, then ALL data will be erased. Click again to proceed.
              </div>
            )}
            {eraseStep === "downloading" && (
              <div className="alert alert-info">
                Downloading backup and erasing data...
              </div>
            )}
            {eraseStep === "done" && (
              <div className="alert alert-success">
                All data erased successfully. Backup was downloaded.
              </div>
            )}
            <button onClick={handleEraseData}
              disabled={eraseStep === "downloading" || eraseStep === "done"}
              className="btn-danger btn-sm disabled:opacity-50 disabled:cursor-not-allowed">
              <Trash2 size={14} />
              {eraseStep === "idle" ? "Erase All Data (with backup)" :
               eraseStep === "confirm" ? "Confirm — Download Backup & Erase" :
               eraseStep === "downloading" ? "Erasing..." : "Done"}
            </button>
          </div>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bento-card">
      <h3 className="section-header">{title}</h3>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bento-card">
      <div className="metric-value text-accent">{value.toLocaleString("en-IN")}</div>
      <div className="metric-label">{label}</div>
    </div>
  );
}

function TallyConnectionSection() {
  const {
    proxyUrl,
    companyName,
    isConnected,
    lastSyncAt,
    autoSyncMinutes,
    fyFromDate,
    fyToDate,
    setProxyUrl,
    setCompanyName,
    setConnected,
    setAutoSync,
    setFyDates,
  } = useTallyStore();

  const { toast } = useToast();
  const [testing, setTesting] = useState(false);

  async function handleTestConnection() {
    setTesting(true);
    try {
      const health = await checkTallyHealth();
      setConnected(health.connected);
      if (health.connected) {
        toast("✓ Connected to Tally proxy", "success");
      } else {
        toast(`⚠ Not connected: ${health.error || "Unknown error"}`, "error");
      }
    } catch (err: any) {
      setConnected(false);
      toast(`Connection failed: ${err.message || err}`, "error");
    } finally {
      setTesting(false);
    }
  }

  const formatLastSync = () => {
    if (!lastSyncAt) return "Never";
    return new Date(lastSyncAt).toLocaleString('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short'
    });
  };

  return (
    <Section title="Tally Connection">
      <div className="space-y-4">
        {/* Connection Status */}
        <div className={clsx(
          "flex items-center gap-3 p-3 rounded-lg border",
          isConnected
            ? "bg-success/10 border-success/30 text-success"
            : "bg-danger/10 border-danger/30 text-danger"
        )}>
          <Wifi size={16} />
          <div className="flex-1">
            <div className="text-sm font-medium">
              {isConnected ? "Connected" : "Not Connected"}
            </div>
            <div className="text-xs opacity-75">
              {isConnected
                ? `Proxy: ${proxyUrl}`
                : "Start proxy: cd server && npm run dev"}
            </div>
          </div>
          <button
            onClick={handleTestConnection}
            disabled={testing}
            className="btn-secondary btn-sm disabled:opacity-50"
          >
            <RefreshCw size={12} className={testing ? "animate-spin" : ""} />
            {testing ? "Testing..." : "Test"}
          </button>
        </div>

        {/* Proxy URL */}
        <div>
          <label className="form-label">Proxy URL</label>
          <input
            type="text"
            value={proxyUrl}
            onChange={(e) => setProxyUrl(e.target.value)}
            placeholder="http://localhost:3100"
            className="form-input tabular-nums"
          />
        </div>

        {/* Company Name */}
        <div>
          <label className="form-label">Company Name (Fixed)</label>
          <input
            type="text"
            value={companyName}
            readOnly
            className="form-input bg-bg-border text-muted cursor-not-allowed"
            title="Company name is permanently set to M.K.CYCLES (P) LTD."
          />
        </div>

        {/* FY Date Range */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="form-label">FY From (YYYYMMDD)</label>
            <input
              type="text"
              value={fyFromDate}
              onChange={(e) => setFyDates(e.target.value, fyToDate)}
              placeholder="20240401"
              className="form-input tabular-nums"
            />
          </div>
          <div>
            <label className="form-label">FY To (YYYYMMDD)</label>
            <input
              type="text"
              value={fyToDate}
              onChange={(e) => setFyDates(fyFromDate, e.target.value)}
              placeholder="20250331"
              className="form-input tabular-nums"
            />
          </div>
        </div>

        {/* Auto-Sync */}
        <div>
          <label className="form-label">Auto-Sync (minutes)</label>
          <select
            value={autoSyncMinutes}
            onChange={(e) => setAutoSync(Number(e.target.value))}
            className="form-select"
          >
            <option value="0">Disabled</option>
            <option value="5">Every 5 minutes</option>
            <option value="15">Every 15 minutes</option>
            <option value="30">Every 30 minutes</option>
            <option value="60">Every hour</option>
          </select>
          <p className="text-xs text-muted mt-1">
            Automatically sync data from Tally at regular intervals (requires active connection)
          </p>
        </div>

        {/* Last Sync */}
        {lastSyncAt && (
          <div className="text-xs text-muted">
            Last sync: {formatLastSync()}
          </div>
        )}
      </div>
    </Section>
  );
}
