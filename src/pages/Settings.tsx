import { useState, useRef } from "react";
import { Settings as SettingsIcon, Trash2, Download, Upload, AlertTriangle, FileSpreadsheet } from "lucide-react";
import { useUIStore } from "../store/uiStore";
import { useDataStore } from "../store/dataStore";
import { useOverrideStore } from "../store/overrideStore";
import { clearAllData } from "../db/idb";
import { useToast } from "../components/Toast";
import { exportUnitsToExcel, importUnitsFromExcel } from "../utils/unitExcelHandler";

export default function Settings() {
  const { unitMode, toggleUnitMode, fyYear, setFyYear, coverMonths, setCoverMonths, leadTimeMonths, setLeadTimeMonths, defaultCreditDays, setDefaultCreditDays } = useUIStore();
  const { clearData, data, refreshOverrides } = useDataStore();
  const { exportAuditLog, units, setUnitOverride } = useOverrideStore();
  const { toast } = useToast();
  const [confirmClear, setConfirmClear] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
