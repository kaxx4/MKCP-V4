import { useState, useRef, useEffect } from "react";
import { Settings as SettingsIcon, Trash2, Download, Upload, AlertTriangle, FileSpreadsheet, Archive, RotateCcw } from "lucide-react";
import clsx from "clsx";
import { useUIStore } from "../store/uiStore";
import { useDataStore } from "../store/dataStore";
import { useOverrideStore } from "../store/overrideStore";
import { clearAllData, listBackups, loadBackup, deleteBackup, exportBackupAsJSON } from "../db/idb";
import { useToast } from "../components/Toast";
import { exportUnitsToExcel, importUnitsFromExcel } from "../utils/unitExcelHandler";
import { deserializeParsedData } from "../utils/serialize";

export default function Settings() {
  const { unitMode, toggleUnitMode, fyYear, setFyYear, coverMonths, setCoverMonths, leadTimeMonths, setLeadTimeMonths, defaultCreditDays, setDefaultCreditDays } = useUIStore();
  const { clearData, data, refreshOverrides } = useDataStore();
  const { exportAuditLog, units, setUnitOverride } = useOverrideStore();
  const { toast } = useToast();
  const [confirmClear, setConfirmClear] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [backups, setBackups] = useState<Array<{ key: string; label: string; createdAt: string }>>([]);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load backups on mount
  useEffect(() => {
    loadBackupsList();
  }, []);

  async function loadBackupsList() {
    const list = await listBackups();
    setBackups(list);
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

  function handleExportAudit() {
    const json = exportAuditLog();
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `audit_log_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    toast("Audit log exported", "success");
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

  const fyOptions: string[] = [];
  const currentYear = new Date().getFullYear();
  for (let y = currentYear - 3; y <= currentYear + 1; y++) {
    fyOptions.push(`${y}-${y + 1}`);
  }

  return (
    <div className="max-w-xl space-y-6">
      <h1 className="text-2xl font-bold text-primary flex items-center gap-3">
        <SettingsIcon size={24} className="text-accent" />
        Settings
      </h1>

      {/* Data info */}
      {data && (
        <div className="bg-bg-card border border-bg-border rounded-xl p-4">
          <h3 className="text-sm font-semibold text-primary mb-3">Loaded Data</h3>
          <div className="grid grid-cols-3 gap-3 text-center">
            <Stat label="Items" value={data.items.size} />
            <Stat label="Ledgers" value={data.ledgers.size} />
            <Stat label="Vouchers" value={data.vouchers.length} />
          </div>
          <p className="text-muted text-xs mt-3">
            Source: {data.sourceFiles.join(", ")}
          </p>
        </div>
      )}

      {/* Unit Mode */}
      <Section title="Unit Mode">
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted">Currently: <span className="text-primary font-mono">{unitMode}</span></span>
          <button onClick={toggleUnitMode}
            className="bg-accent hover:bg-accent-hover text-white px-4 py-1.5 rounded-lg text-sm transition">
            Switch to {unitMode === "BASE" ? "PKG" : "BASE"}
          </button>
        </div>
      </Section>

      {/* Financial Year */}
      <Section title="Financial Year">
        <select value={fyYear} onChange={(e) => setFyYear(e.target.value)}
          className="bg-bg border border-bg-border rounded-lg px-3 py-2 text-primary text-sm outline-none">
          {fyOptions.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </Section>

      {/* Cover Months */}
      <Section title="Default Cover Months">
        <div className="flex gap-2">
          {[1, 1.5, 2, 3].map((m) => (
            <button key={m} onClick={() => setCoverMonths(m)}
              className={`px-4 py-1.5 rounded-lg text-sm font-mono transition ${coverMonths === m ? "bg-accent text-white" : "bg-bg border border-bg-border text-muted hover:text-primary"}`}>
              {m}
            </button>
          ))}
        </div>
      </Section>

      {/* Lead Time */}
      <Section title="Lead Time Months">
        <input type="number" value={leadTimeMonths} min={0.5} max={6} step={0.5}
          onChange={(e) => setLeadTimeMonths(parseFloat(e.target.value) || 1.5)}
          className="bg-bg border border-bg-border rounded-lg px-3 py-2 text-primary text-sm outline-none w-24" />
      </Section>

      {/* Default Credit Days */}
      <Section title="Default Credit Days">
        <input type="number" value={defaultCreditDays} min={0} max={365}
          onChange={(e) => setDefaultCreditDays(parseInt(e.target.value) || 30)}
          className="bg-bg border border-bg-border rounded-lg px-3 py-2 text-primary text-sm outline-none w-24" />
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
              className="flex items-center gap-2 bg-accent hover:bg-accent-hover disabled:bg-muted disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg transition text-sm"
            >
              <FileSpreadsheet size={14} />
              Export Template
            </button>
            <button
              onClick={handleImportUnitsClick}
              disabled={!data || isImporting}
              className="flex items-center gap-2 bg-bg-card border border-bg-border hover:border-accent/50 text-muted hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 rounded-lg transition text-sm"
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

      {/* Export Audit Log */}
      <Section title="Audit Log">
        <button onClick={handleExportAudit}
          className="flex items-center gap-2 bg-bg-card border border-bg-border hover:border-accent/50 text-muted hover:text-primary px-4 py-2 rounded-lg transition text-sm">
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
                        "flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs transition",
                        confirmRestore === backup.key
                          ? "bg-success/20 border border-success text-success"
                          : "bg-bg-card border border-bg-border hover:border-accent/50 text-muted hover:text-primary"
                      )}
                    >
                      <RotateCcw size={12} />
                      {confirmRestore === backup.key ? "Confirm?" : "Restore"}
                    </button>
                    <button
                      onClick={() => handleDownloadBackup(backup.key)}
                      className="flex items-center gap-1 bg-bg-card border border-bg-border hover:border-accent/50 text-muted hover:text-primary px-3 py-1.5 rounded-lg text-xs transition"
                    >
                      <Download size={12} />
                      Download
                    </button>
                    <button
                      onClick={() => handleDeleteBackup(backup.key)}
                      className="flex items-center gap-1 bg-danger/10 hover:bg-danger/20 border border-danger/30 text-danger px-3 py-1.5 rounded-lg text-xs transition"
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

      {/* Clear Data */}
      <Section title="Danger Zone">
        <div className="space-y-2">
          {confirmClear && (
            <div className="flex items-center gap-2 text-danger text-sm bg-danger/10 border border-danger/30 rounded-lg p-3">
              <AlertTriangle size={14} />
              This will delete all imported data. Click again to confirm.
            </div>
          )}
          <button onClick={handleClearData}
            className="flex items-center gap-2 bg-danger/10 hover:bg-danger/20 border border-danger/30 text-danger px-4 py-2 rounded-lg transition text-sm">
            <Trash2 size={14} />
            {confirmClear ? "Confirm Clear All Data" : "Clear All Data"}
          </button>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg-card border border-bg-border rounded-xl p-4">
      <h3 className="text-sm font-semibold text-muted mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-bg border border-bg-border rounded-lg p-3">
      <div className="text-xl font-mono font-bold text-accent">{value.toLocaleString("en-IN")}</div>
      <div className="text-muted text-xs mt-0.5">{label}</div>
    </div>
  );
}
