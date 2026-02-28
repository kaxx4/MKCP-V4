import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Upload, FileJson, CheckCircle, AlertTriangle, Info, Loader2, FlaskConical, Calendar } from "lucide-react";
import clsx from "clsx";
import { parseMasters } from "../parser/masterParser";
import { parseTransactions } from "../parser/transactionParser";
import { useDataStore } from "../store/dataStore";
import { saveData, loadData, createBackup, saveToStore, loadFromStore } from "../db/idb";
import { serializeParsedData, deserializeParsedData } from "../utils/serialize";
import type { ParsedData, ImportWarning } from "../types/canonical";
import { useToast } from "../components/Toast";
import { generatePredictions, scorePredictions, type PredictionSnapshot } from "../engine/prediction";

interface ImportReport {
  items: number;
  ledgers: number;
  vouchers: number;
  warnings: ImportWarning[];
  reconErrors: string[];
  duplicatesRemoved?: number;
  newVouchersAdded?: number;
  mergeMode?: boolean;
}

type DropZone = "masters" | "transactions";

export default function ImportPage() {
  const navigate = useNavigate();
  const { mergeData, data: existingData } = useDataStore();
  const { toast } = useToast();

  const [mastersFile, setMastersFile] = useState<File | null>(null);
  const [txFile, setTxFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [pendingData, setPendingData] = useState<ParsedData | null>(null);
  const [dragOver, setDragOver] = useState<DropZone | null>(null);
  const [debugLog, setDebugLog] = useState<string[]>([]);

  // Calculate existing data metadata
  const existingDataInfo = existingData ? (() => {
    const mastersUploadedAt = existingData.importedAt
      ? new Date(existingData.importedAt).toLocaleString('en-IN', {
          dateStyle: 'medium',
          timeStyle: 'short'
        })
      : 'Unknown';

    const hasMasters = existingData.sourceFiles.some(f =>
      f.toLowerCase().includes('master') || f.toLowerCase().includes('sample/masters')
    );

    const nonCancelledVouchers = existingData.vouchers.filter(v => !v.isCancelled);
    const sortedVouchers = [...nonCancelledVouchers].sort((a, b) => a.date.localeCompare(b.date));

    const earliestTxDate = sortedVouchers.length > 0
      ? new Date(sortedVouchers[0].date).toLocaleDateString('en-IN', { dateStyle: 'medium' })
      : 'N/A';

    const latestVoucher = sortedVouchers.length > 0 ? sortedVouchers[sortedVouchers.length - 1] : null;
    const latestTxDate = latestVoucher
      ? new Date(latestVoucher.date).toLocaleDateString('en-IN', { dateStyle: 'medium' })
      : 'N/A';

    const lastVoucherEntry = latestVoucher
      ? `${latestVoucher.voucherType} #${latestVoucher.voucherNumber}`
      : 'N/A';

    return {
      mastersUploadedAt,
      hasMasters,
      earliestTxDate,
      latestTxDate,
      lastVoucherEntry,
      totalVouchers: sortedVouchers.length
    };
  })() : null;

  const handleDrop = useCallback((zone: DropZone, e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(null);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (zone === "masters") setMastersFile(file);
    else setTxFile(file);
  }, []);

  const handleFileSelect = (zone: DropZone, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (zone === "masters") setMastersFile(file);
    else setTxFile(file);
    e.target.value = "";
  };

  const addLog = (msg: string) => {
    setDebugLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  async function loadSampleData() {
    try {
      setImporting(true);
      setDebugLog([]);
      addLog("Fetching sample data...");
      const [mRes, tRes] = await Promise.all([
        fetch("/sample/masters.json"),
        fetch("/sample/transactions.json"),
      ]);
      addLog("Sample files downloaded");
      const [mRaw, tRaw] = await Promise.all([mRes.json(), tRes.json()]);
      addLog("JSON parsed successfully");
      await runImportFromParsed(mRaw, tRaw, ["sample/masters.json", "sample/transactions.json"]);
    } catch (e) {
      addLog(`ERROR: ${e}`);
      toast(`Failed to load sample data: ${e}`, "error");
    } finally {
      setImporting(false);
    }
  }

  async function runImport() {
    if (!txFile) {
      toast("Please select at least a transactions file", "warn");
      return;
    }
    setImporting(true);
    setDebugLog([]);
    try {
      let mastersRaw: unknown | null = null;
      let txRaw: unknown;

      // Parse masters file if provided
      if (mastersFile) {
        addLog(`Reading masters file: ${mastersFile.name} (${(mastersFile.size / 1024).toFixed(0)} KB)`);
        // Handle UTF-16 encoded files (Tally Prime export)
        try {
          mastersRaw = JSON.parse(await mastersFile.text());
          addLog("Masters file parsed (UTF-8)");
        } catch {
          addLog("UTF-8 failed, trying UTF-16...");
          // Try UTF-16 via ArrayBuffer
          const buf = await mastersFile.arrayBuffer();
          const decoder = new TextDecoder("utf-16");
          mastersRaw = JSON.parse(decoder.decode(buf));
          addLog("Masters file parsed (UTF-16)");
        }
      } else {
        addLog("No masters file — will use existing data");
      }

      addLog(`Reading transactions file: ${txFile.name} (${(txFile.size / 1024).toFixed(0)} KB)`);
      try {
        txRaw = JSON.parse(await txFile.text());
        addLog("Transactions file parsed (UTF-8)");
      } catch {
        addLog("UTF-8 failed, trying UTF-16...");
        const buf = await txFile.arrayBuffer();
        const decoder = new TextDecoder("utf-16");
        txRaw = JSON.parse(decoder.decode(buf));
        addLog("Transactions file parsed (UTF-16)");
      }

      const sourceFiles = mastersFile ? [mastersFile.name, txFile.name] : [txFile.name];
      await runImportFromParsed(mastersRaw, txRaw, sourceFiles);
    } catch (e) {
      addLog(`ERROR: ${String(e)}`);
      toast(`Import failed: ${String(e)}`, "error");
    } finally {
      setImporting(false);
    }
  }

  async function runImportFromParsed(mastersRaw: unknown | null, txRaw: unknown, sourceFiles: string[]) {
    let items: Map<string, any>;
    let ledgers: Map<string, any>;
    let company: any | null = null;
    let mw: ImportWarning[] = [];

    // Load existing data for smart merging
    const existingRaw = await loadData<unknown>("parsedData");
    const existingData = existingRaw ? deserializeParsedData(existingRaw) : null;

    if (mastersRaw) {
      addLog("Parsing masters (items, ledgers)...");
      const parsed = parseMasters(mastersRaw);
      company = parsed.company;

      // Merge masters with existing data
      if (existingData) {
        addLog("Merging new masters with existing data...");
        items = new Map(existingData.items);
        ledgers = new Map(existingData.ledgers);

        // Update/add new items
        let newItems = 0;
        let updatedItems = 0;
        for (const [itemId, item] of parsed.items) {
          if (items.has(itemId)) {
            updatedItems++;
          } else {
            newItems++;
          }
          items.set(itemId, item);
        }

        // Update/add new ledgers
        let newLedgers = 0;
        let updatedLedgers = 0;
        for (const [ledgerId, ledger] of parsed.ledgers) {
          if (ledgers.has(ledgerId)) {
            updatedLedgers++;
          } else {
            newLedgers++;
          }
          ledgers.set(ledgerId, ledger);
        }

        addLog(`Masters merged: ${newItems} new items, ${updatedItems} updated | ${newLedgers} new ledgers, ${updatedLedgers} updated`);
      } else {
        items = parsed.items;
        ledgers = parsed.ledgers;
        addLog(`Parsed ${items.size} items, ${ledgers.size} ledgers (${mw.length} warnings)`);
      }
      mw = parsed.warnings;
    } else {
      addLog("No masters file — using existing data...");
      if (existingData) {
        items = existingData.items;
        ledgers = existingData.ledgers;
        company = existingData.company;
        addLog(`Using existing: ${items.size} items, ${ledgers.size} ledgers`);
      } else {
        toast("No existing masters data found. Please upload a masters file.", "error");
        throw new Error("No masters data available");
      }
    }

    addLog("Parsing transactions (vouchers)...");
    const { vouchers: newVouchers, warnings: tw } = parseTransactions(txRaw);
    addLog(`Parsed ${newVouchers.length} new vouchers (${tw.length} warnings)`);

    // Smart merge: Remove duplicates and add only new vouchers
    let vouchers = newVouchers;
    let duplicatesRemoved = 0;
    let newVouchersAdded = 0;

    if (existingData && existingData.vouchers.length > 0) {
      addLog("Detecting duplicates and merging vouchers...");

      // Create a Set of existing voucher IDs for fast lookup
      const existingVoucherIds = new Set(existingData.vouchers.map(v => v.voucherId));

      // Filter out duplicates from new vouchers
      const uniqueNewVouchers = newVouchers.filter(v => {
        if (existingVoucherIds.has(v.voucherId)) {
          duplicatesRemoved++;
          return false;
        }
        return true;
      });

      newVouchersAdded = uniqueNewVouchers.length;

      // Merge existing + new unique vouchers
      vouchers = [...existingData.vouchers, ...uniqueNewVouchers];

      // Sort by date
      vouchers.sort((a, b) => a.date.localeCompare(b.date));

      addLog(`Duplicates removed: ${duplicatesRemoved} | New vouchers added: ${newVouchersAdded} | Total: ${vouchers.length}`);
    } else {
      newVouchersAdded = newVouchers.length;
      addLog(`First import: ${newVouchersAdded} vouchers added`);
    }

    addLog("Running voucher reconciliation checks...");
    const reconErrors: string[] = [];
    for (const v of vouchers) {
      const ledgerLines = v.lines.filter((l) => l.type === "ledger");
      const debits = ledgerLines.filter((l) => l.isDebit).reduce((s, l) => s + (l.amount ?? 0), 0);
      const credits = ledgerLines.filter((l) => !l.isDebit).reduce((s, l) => s + (l.amount ?? 0), 0);
      if (Math.abs(debits - credits) > 1 && ledgerLines.length > 1) {
        reconErrors.push(
          `${v.voucherType} ${v.voucherNumber} (${v.date}): Dr=${debits.toFixed(0)} Cr=${credits.toFixed(0)}`
        );
      }
    }
    addLog(`Found ${reconErrors.length} reconciliation issues`);

    const data: ParsedData = {
      company: company ?? { name: "MK Cycles", fyStartMonth: 4 },
      items,
      ledgers,
      vouchers,
      importedAt: new Date().toISOString(),
      sourceFiles,
      warnings: [...mw, ...tw],
    };

    addLog("✓ Import complete — review summary below");
    setPendingData(data);
    setReport({
      items: items.size,
      ledgers: ledgers.size,
      vouchers: vouchers.length,
      warnings: data.warnings,
      reconErrors: reconErrors.slice(0, 20),
      duplicatesRemoved,
      newVouchersAdded,
      mergeMode: existingData !== null,
    });
  }

  async function acceptData() {
    if (!pendingData) return;

    // 1. Backup existing data before overwriting
    const existingRaw = await loadData("parsedData");
    if (existingRaw) {
      const dateLabel = new Date().toISOString().slice(0, 10);
      const backupKey = await createBackup(existingRaw, `pre-import_${dateLabel}`);
      addLog(`Backup created: ${backupKey}`);
    }

    // 2. Load previous predictions for scoring
    const prevSnapshot = await loadFromStore<PredictionSnapshot>("predictions", "latest");

    // 3. Merge new data into store
    mergeData(pendingData);
    const merged = useDataStore.getState().data!;
    await saveData("parsedData", serializeParsedData(pendingData));

    // 4. Score previous predictions against new data
    if (prevSnapshot && prevSnapshot.predictions.length > 0) {
      const accuracy = scorePredictions(prevSnapshot.predictions, pendingData.vouchers, "Sales");
      if (accuracy.length > 0) {
        const avgDateScore = accuracy.reduce((s, a) => s + a.dateAccuracyScore, 0) / accuracy.length;
        const avgItemScore = accuracy.reduce((s, a) => s + a.itemAccuracyScore, 0) / accuracy.length;

        // Store accuracy results
        const accuracyKey = `accuracy_${new Date().toISOString().slice(0, 10)}`;
        await saveToStore("predictions", accuracyKey, accuracy);

        addLog(`Prediction accuracy: dates ${(avgDateScore * 100).toFixed(0)}%, items ${(avgItemScore * 100).toFixed(0)}%`);
        toast(
          `Prediction accuracy: dates ${(avgDateScore * 100).toFixed(0)}%, items ${(avgItemScore * 100).toFixed(0)}%`,
          avgDateScore > 0.5 ? "success" : "warn"
        );
      }
    }

    // 5. Generate fresh predictions with all data and save
    const freshPredictions = generatePredictions(merged.vouchers, merged.items, "Sales");
    await saveToStore("predictions", "latest", {
      generatedAt: new Date().toISOString(),
      predictions: freshPredictions,
    });
    addLog(`Generated ${freshPredictions.length} fresh predictions`);

    toast(`Imported ${report!.items} items, ${report!.ledgers} ledgers, ${report!.vouchers} vouchers`, "success");
    navigate("/orders");
  }

  function downloadReport() {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "import_report.json";
    a.click();
  }

  const warns = report?.warnings.filter((w) => w.severity === "warn") ?? [];
  const fatals = report?.warnings.filter((w) => w.severity === "fatal") ?? [];

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-primary mb-1">Import Tally Data</h1>
        <p className="text-muted text-sm">Upload your exported JSON files from Tally Prime</p>
      </div>

      {/* Existing Data Info */}
      {existingDataInfo && (
        <div className="bg-bg-card border border-bg-border rounded-xl p-4 mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Calendar size={16} className="text-accent" />
            <h3 className="font-semibold text-primary">Current Data Status</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-bg border border-bg-border rounded-lg p-3">
              <div className="text-xs text-muted mb-1">Masters Data</div>
              <div className="text-sm font-medium text-primary">
                {existingDataInfo.hasMasters ? '✓ Loaded' : '⚠ Not Loaded'}
              </div>
              <div className="text-xs text-muted mt-1">
                Uploaded: {existingDataInfo.mastersUploadedAt}
              </div>
            </div>
            <div className="bg-bg border border-bg-border rounded-lg p-3">
              <div className="text-xs text-muted mb-1">Transaction Data</div>
              <div className="text-sm font-medium text-primary">
                {existingDataInfo.totalVouchers.toLocaleString('en-IN')} vouchers
              </div>
              <div className="text-xs text-muted mt-1">
                Period: {existingDataInfo.earliestTxDate} to {existingDataInfo.latestTxDate}
              </div>
              <div className="text-xs text-muted mt-1">
                Last Entry: <span className="font-mono text-primary">{existingDataInfo.lastVoucherEntry}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Drop Zones */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <DropZoneCard
          zone="masters"
          file={mastersFile}
          label="masters.json (Optional)"
          subtitle={mastersFile ? "Stock items + Ledgers" : "Optional — uses existing if skipped"}
          dragOver={dragOver === "masters"}
          onDrop={(e) => handleDrop("masters", e)}
          onDragOver={(e) => { e.preventDefault(); setDragOver("masters"); }}
          onDragLeave={() => setDragOver(null)}
          onSelect={(e) => handleFileSelect("masters", e)}
        />
        <DropZoneCard
          zone="transactions"
          file={txFile}
          label="transactions.json"
          subtitle="Vouchers (Sales, Purchase, etc.)"
          dragOver={dragOver === "transactions"}
          onDrop={(e) => handleDrop("transactions", e)}
          onDragOver={(e) => { e.preventDefault(); setDragOver("transactions"); }}
          onDragLeave={() => setDragOver(null)}
          onSelect={(e) => handleFileSelect("transactions", e)}
        />
      </div>

      {/* Action buttons */}
      <div className="flex gap-3 mb-6">
        <button
          onClick={runImport}
          disabled={!txFile || importing}
          className="flex items-center gap-2 bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold px-5 py-2.5 rounded-lg transition"
        >
          {importing ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
          {importing ? "Importing..." : "Parse Files"}
        </button>
        <button
          onClick={loadSampleData}
          disabled={importing}
          className="flex items-center gap-2 bg-bg-border hover:bg-bg-border/70 text-muted hover:text-primary font-medium px-5 py-2.5 rounded-lg transition"
        >
          <FlaskConical size={16} />
          Load Sample Data
        </button>
      </div>

      {/* Debug Log */}
      {debugLog.length > 0 && (
        <div className="bg-bg-card border border-bg-border rounded-xl p-4 mb-6">
          <h3 className="text-sm font-semibold text-primary mb-2 flex items-center gap-2">
            <Info size={14} />
            Import Progress Log
          </h3>
          <div className="bg-bg border border-bg-border rounded-lg p-3 max-h-48 overflow-y-auto font-mono text-xs">
            {debugLog.map((log, idx) => (
              <div key={idx} className={clsx(
                "py-0.5",
                log.includes("ERROR") ? "text-danger" : log.includes("✓") ? "text-success" : "text-muted"
              )}>
                {log}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Report */}
      {report && (
        <div className="bg-bg-card border border-bg-border rounded-xl p-6 space-y-4">
          <h2 className="text-lg font-semibold text-primary">Import Summary</h2>

          {/* Merge Info Banner */}
          {report.mergeMode && (
            <div className="bg-accent/10 border border-accent/30 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2 text-accent font-medium text-sm">
                <CheckCircle size={14} />
                Smart Merge Completed
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-bg-card border border-bg-border rounded-lg p-2">
                  <span className="text-muted">Duplicates Removed:</span>
                  <span className="font-mono font-bold text-warn ml-2">{report.duplicatesRemoved}</span>
                </div>
                <div className="bg-bg-card border border-bg-border rounded-lg p-2">
                  <span className="text-muted">New Vouchers Added:</span>
                  <span className="font-mono font-bold text-success ml-2">{report.newVouchersAdded}</span>
                </div>
              </div>
            </div>
          )}

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: "Items", value: report.items, color: "text-success" },
              { label: "Ledgers", value: report.ledgers, color: "text-accent" },
              { label: "Total Vouchers", value: report.vouchers, color: "text-primary" },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-bg border border-bg-border rounded-lg p-4 text-center">
                <div className={`text-3xl font-mono font-bold ${color}`}>{value.toLocaleString("en-IN")}</div>
                <div className="text-muted text-sm mt-1">{label}</div>
              </div>
            ))}
          </div>

          {/* Reconciliation errors */}
          {report.reconErrors.length > 0 && (
            <div className="bg-warn/10 border border-warn/30 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2 text-warn font-medium text-sm">
                <AlertTriangle size={14} />
                {report.reconErrors.length} Reconciliation Issue(s)
              </div>
              <ul className="space-y-1">
                {report.reconErrors.slice(0, 5).map((e, i) => (
                  <li key={i} className="text-muted text-xs font-mono">{e}</li>
                ))}
                {report.reconErrors.length > 5 && (
                  <li className="text-muted text-xs">... and {report.reconErrors.length - 5} more</li>
                )}
              </ul>
            </div>
          )}

          {/* Warnings */}
          {(warns.length > 0 || fatals.length > 0) && (
            <div className="bg-bg border border-bg-border rounded-lg p-4 max-h-48 overflow-y-auto">
              <div className="text-muted text-sm font-medium mb-2">
                Warnings: {warns.length} warn, {fatals.length} fatal
              </div>
              {fatals.map((w, i) => (
                <div key={i} className="flex items-start gap-2 text-danger text-xs font-mono mb-1">
                  <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                  <span>[{w.context}] {w.message}</span>
                </div>
              ))}
              {warns.slice(0, 10).map((w, i) => (
                <div key={i} className="flex items-start gap-2 text-warn text-xs font-mono mb-1">
                  <Info size={12} className="mt-0.5 flex-shrink-0" />
                  <span>[{w.context}] {w.message}</span>
                </div>
              ))}
            </div>
          )}

          {/* Accept button */}
          <div className="flex gap-3 pt-2">
            <button
              onClick={acceptData}
              className="flex items-center gap-2 bg-success hover:bg-success/80 text-white font-semibold px-6 py-2.5 rounded-lg transition"
            >
              <CheckCircle size={16} />
              Accept & Continue to Orders
            </button>
            <button
              onClick={downloadReport}
              className="flex items-center gap-2 bg-bg-border hover:bg-bg-border/70 text-muted hover:text-primary px-5 py-2.5 rounded-lg transition text-sm"
            >
              Download Report
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface DropZoneCardProps {
  zone: DropZone;
  file: File | null;
  label: string;
  subtitle: string;
  dragOver: boolean;
  onDrop: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

function DropZoneCard({ zone, file, label, subtitle, dragOver, onDrop, onDragOver, onDragLeave, onSelect }: DropZoneCardProps) {
  return (
    <label
      className={clsx(
        "border-2 border-dashed rounded-xl p-6 flex flex-col items-center gap-3 cursor-pointer transition",
        dragOver
          ? "border-accent bg-accent/10"
          : file
          ? "border-success/50 bg-success/5"
          : "border-bg-border hover:border-accent/50 bg-bg-card"
      )}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <input
        type="file"
        accept=".json"
        className="hidden"
        onChange={onSelect}
        data-zone={zone}
      />
      {file ? (
        <CheckCircle size={32} className="text-success" />
      ) : (
        <FileJson size={32} className="text-muted" />
      )}
      <div className="text-center">
        <div className="font-mono text-sm font-medium text-primary">{label}</div>
        <div className="text-muted text-xs mt-1">{subtitle}</div>
        {file && <div className="text-success text-xs mt-2 truncate max-w-[180px]">{file.name}</div>}
        {!file && <div className="text-muted text-xs mt-2">Drop file or click to select</div>}
      </div>
    </label>
  );
}
