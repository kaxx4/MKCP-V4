import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Upload, FileJson, CheckCircle, AlertTriangle, Info, Loader2, FlaskConical, Calendar, Zap, Wifi, WifiOff, Package, RefreshCw } from "lucide-react";
import clsx from "clsx";
import { parseMasters } from "../parser/masterParser";
import { parseTransactions } from "../parser/transactionParser";
import { useDataStore } from "../store/dataStore";
import { useTallyStore } from "../store/tallyStore";
import { saveData, loadData, createBackup, saveToStore, loadFromStore, saveJsonUpload } from "../db/idb";
import { serializeParsedData, deserializeParsedData } from "../utils/serialize";
import type { ParsedData, ImportWarning } from "../types/canonical";
import { useToast } from "../components/Toast";
import { generatePredictions, scorePredictions, type PredictionSnapshot } from "../engine/prediction";
import { checkTallyHealth, fullSync, syncMasters, syncDayBook, detectCompany, type TallySyncResult } from "../api/tallyApi";

interface ImportReport {
  items: number;
  ledgers: number;
  vouchers: number;
  stockGroups?: number;
  units?: number;
  chunkDetails?: { label: string; count: number; ms: number }[];
  warnings: ImportWarning[];
  reconErrors: string[];
  duplicatesRemoved?: number;
  newVouchersAdded?: number;
  mergeMode?: boolean;
}

type DropZone = "masters" | "transactions";
type TabMode = "live" | "upload";

/**
 * Convert YYYYMMDD to YYYY-MM-DD for HTML5 date input
 */
function formatDateForInput(yyyymmdd: string): string {
  if (!yyyymmdd || yyyymmdd.length !== 8) return '';
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/**
 * Format FY date range for display
 */
function formatFYRange(from: string, to: string): string {
  if (!from || !to) return 'Not set';
  const fromYear = from.slice(0, 4);
  const toYear = to.slice(0, 4);
  return `FY ${fromYear}-${toYear.slice(2)}`;
}

export default function ImportPage() {
  const navigate = useNavigate();
  const { mergeData, data: existingData } = useDataStore();
  const { toast } = useToast();

  // Tab state
  const [tab, setTab] = useState<TabMode>("live");

  // Tally Live state
  const {
    companyName,
    isConnected,
    lastSyncAt,
    isSyncing,
    fyFromDate,
    fyToDate,
    syncMode,
    lastVoucherDate,
    lastMastersSyncAt,
    lastVouchersSyncAt,
    setCompanyName,
    setConnected,
    setLastSync,
    setSyncing,
    setFyDates,
    setSyncMode,
    resetToCurrentFY,
    setLastVoucherDate,
    setLastMastersSync,
    setLastVouchersSync,
  } = useTallyStore();

  // Upload state
  const [mastersFile, setMastersFile] = useState<File | null>(null);
  const [txFile, setTxFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);

  // Shared state
  const [report, setReport] = useState<ImportReport | null>(null);
  const [pendingData, setPendingData] = useState<ParsedData | null>(null);
  const [dragOver, setDragOver] = useState<DropZone | null>(null);
  const [debugLog, setDebugLog] = useState<string[]>([]);

  // Check Tally connection on mount
  useEffect(() => {
    if (tab === "live") {
      checkConnection();
    }
  }, [tab]);

  async function checkConnection() {
    try {
      const health = await checkTallyHealth();
      setConnected(health.connected);
      if (!health.connected) {
        addLog(`⚠ Tally not connected: ${health.error || "Server not reachable"}`);
      } else {
        addLog("✓ Tally proxy connected");
      }
    } catch (err) {
      setConnected(false);
      addLog(`⚠ Connection check failed: ${err}`);
    }
  }

  async function handleTallySync() {
    if (!companyName.trim()) {
      toast("Please enter company name", "warn");
      return;
    }

    setSyncing(true);
    setDebugLog([]);
    try {
      addLog(`Starting sync for "${companyName}"...`);
      addLog("Note: First sync of a large company can take 2-5 minutes. Watch the proxy terminal for progress.");
      const t0 = Date.now();

      // Call full sync
      const result: TallySyncResult = await fullSync(companyName, fyFromDate, fyToDate);

      // Show partial errors
      if (result.errors) {
        for (const err of result.errors) addLog(`⚠  ${err}`);
      }

      // Show error if sync failed
      if (!result.success && result.error) {
        addLog(`⚠ ${result.error}`);
      }

      // Check if we actually got data
      if (result.stats.stockItems === 0 && result.stats.ledgers === 0 && result.stats.vouchers === 0) {
        addLog("ERROR: Tally returned zero data!");
        addLog("Check: 1) Company name exact match  2) Company loaded in Tally  3) FY dates correct");
        addLog("Test: Open a new terminal and run:");
        addLog(`  curl -X POST http://localhost:3100/api/tally/debug -H "Content-Type: application/json" -d "{\\"company\\":\\"${companyName}\\",\\"test\\":\\"stock\\"}"`);
        toast("Sync returned empty data — check log", "error");
        setSyncing(false);
        return;
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      addLog(`✓ Data fetched in ${elapsed}s`);
      addLog(`  ${result.stats.stockGroups} stock groups`);
      addLog(`  ${result.stats.units} units`);
      addLog(`  ${result.stats.stockItems} stock items`);
      addLog(`  ${result.stats.ledgers} ledgers`);
      addLog(`  ${result.stats.vouchers} vouchers`);

      // Parse using EXISTING parsers
      addLog("Parsing masters...");
      const mastersResult = parseMasters(result.masters);
      addLog("Parsing transactions...");
      const txResult = parseTransactions(result.transactions);

      // Build ParsedData
      const data: ParsedData = {
        company: mastersResult.company,
        items: mastersResult.items,
        ledgers: mastersResult.ledgers,
        vouchers: txResult.vouchers,
        importedAt: new Date().toISOString(),
        sourceFiles: ["tally-live-sync"],
        warnings: [...mastersResult.warnings, ...txResult.warnings],
      };

      addLog("✓ Parsing complete");

      // Reconciliation check
      addLog("Running reconciliation checks...");
      const reconErrors: string[] = [];
      for (const v of data.vouchers) {
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

      setPendingData(data);
      setReport({
        items: data.items.size,
        ledgers: data.ledgers.size,
        vouchers: data.vouchers.length,
        stockGroups: mastersResult.stockGroups.length,
        units: mastersResult.units.length,
        warnings: data.warnings,
        reconErrors: reconErrors.slice(0, 20),
        mergeMode: false,
      });

      setLastSync(new Date().toISOString());
      addLog("✓ Sync complete — review summary below");
    } catch (err: any) {
      addLog(`ERROR: ${err.message || err}`);
      toast(`Sync failed: ${err.message || err}`, "error");
      setConnected(false);
    } finally {
      setSyncing(false);
    }
  }

  async function handleSyncMasters() {
    if (!companyName.trim()) { toast("Enter company name", "warn"); return; }
    setSyncing(true);
    setDebugLog([]);
    setReport(null);
    setPendingData(null);
    try {
      addLog(`Syncing masters for "${companyName}"...`);
      const result = await syncMasters(companyName);

      if (result.errors?.length) result.errors.forEach(e => addLog(`⚠ ${e}`));
      if (result.stats.stockItems === 0 && result.stats.ledgers === 0) {
        addLog("ERROR: Zero masters returned. Check company name matches EXACTLY.");
        toast("No masters found — check company name", "error");
        return;
      }
      addLog(`✓ ${result.stats.stockGroups} groups, ${result.stats.units} units, ${result.stats.stockItems} stock items, ${result.stats.ledgers} ledgers, ${result.stats.godowns ?? 0} godowns, ${result.stats.costCentres ?? 0} cost centres in ${result.stats.elapsedSeconds}s`);

      addLog("Parsing masters...");
      const parsed = parseMasters(result.data);
      addLog(`Parsed: ${parsed.items.size} items, ${parsed.ledgers.size} ledgers, ${parsed.warnings.length} warnings`);

      if (parsed.items.size === 0 && parsed.ledgers.size === 0) {
        addLog("ERROR: Parser found 0 items and 0 ledgers in the response.");
        addLog("The data arrived from Tally but the format may not match.");
        parsed.warnings.forEach(w => addLog(`  [${w.context}] ${w.message}`));
        toast("Parser found 0 items — check proxy console", "error");
        return;
      }

      // Build ParsedData with masters only (keep existing vouchers if any)
      const existingRaw = await loadData<unknown>("parsedData");
      const existing = existingRaw ? deserializeParsedData(existingRaw) : null;

      const data: ParsedData = {
        company: parsed.company ?? { name: companyName, fyStartMonth: 4 },
        items: parsed.items,
        ledgers: parsed.ledgers,
        vouchers: existing?.vouchers ?? [],
        importedAt: new Date().toISOString(),
        sourceFiles: ["tally-masters-sync"],
        warnings: parsed.warnings,
      };

      // Save immediately — no "Accept" step needed for masters
      if (existing) {
        await createBackup(existingRaw, `pre-masters-sync`);
      }
      mergeData(data);
      await saveData("parsedData", serializeParsedData(data));

      setLastSync(new Date().toISOString());
      setLastMastersSync(new Date().toISOString());
      addLog("✓ Masters saved to app. You can now sync Day Book or go to Orders.");
      toast(`Synced ${parsed.stockGroups.length} groups, ${parsed.units.length} units, ${parsed.items.size} items, ${parsed.ledgers.size} ledgers`, "success");
    } catch (err: any) {
      addLog(`ERROR: ${err.message}`);
      toast(`Masters sync failed: ${err.message}`, "error");
    } finally {
      setSyncing(false);
    }
  }

  async function handleSyncDayBook() {
    if (!companyName.trim()) { toast("Enter company name", "warn"); return; }
    if (!fyFromDate || !fyToDate) { toast("Select date range", "warn"); return; }
    setSyncing(true);
    setDebugLog([]);
    setReport(null);
    setPendingData(null);
    try {
      addLog(`Syncing Day Book for "${companyName}" (${fyFromDate} → ${fyToDate}) [${syncMode} chunks]...`);
      addLog("Fetching vouchers chunk-by-chunk for reliability.");
      const result = await syncDayBook(companyName, fyFromDate, fyToDate, syncMode);

      if (result.errors?.length) {
        for (const err of result.errors) addLog(`⚠ ${err}`);
      }

      if (!result.success || result.stats.vouchers === 0) {
        addLog(result.error || "Zero vouchers returned for this period.");
        addLog("Try: 1) Shorter period 2) Check dates are within loaded company FY");
        toast("No vouchers found for this period", "warn");
        return;
      }
      addLog(`✓ ${result.stats.vouchers} vouchers fetched in ${result.stats.elapsedSeconds}s (${result.stats.chunksSucceeded}/${result.stats.chunksTotal} chunks)`);
      if (result.stats.chunkDetails) {
        for (const cd of result.stats.chunkDetails) {
          addLog(`  ${cd.label}: ${cd.count} vouchers (${cd.ms}ms)`);
        }
      }

      addLog("Parsing transactions...");
      const parsed = parseTransactions(result.data);
      addLog(`Parsed: ${parsed.vouchers.length} vouchers, ${parsed.warnings.length} warnings`);

      // Load existing data and merge (duplicates auto-ignored by mergeData)
      const existingRaw = await loadData<unknown>("parsedData");
      const existing = existingRaw ? deserializeParsedData(existingRaw) : null;

      if (!existing || existing.items.size === 0) {
        addLog("⚠ No masters data loaded yet. Sync Masters first for best results.");
      }

      const data: ParsedData = {
        company: existing?.company ?? { name: companyName, fyStartMonth: 4 },
        items: existing?.items ?? new Map(),
        ledgers: existing?.ledgers ?? new Map(),
        vouchers: parsed.vouchers,
        importedAt: new Date().toISOString(),
        sourceFiles: ["tally-daybook-sync"],
        warnings: parsed.warnings,
      };

      if (existing) {
        await createBackup(existingRaw, `pre-daybook-sync`);
      }
      mergeData(data);

      const merged = useDataStore.getState().data!;
      await saveData("parsedData", serializeParsedData(merged));

      setLastSync(new Date().toISOString());
      // Track latest voucher date for incremental sync
      const allDates = merged.vouchers.filter(v => !v.isCancelled).map(v => v.date).sort();
      const latestDate = allDates.length > 0 ? allDates[allDates.length - 1] : null;
      if (latestDate) setLastVoucherDate(latestDate);
      setLastVouchersSync(new Date().toISOString());

      const totalVouchers = merged.vouchers.length;
      addLog(`✓ Day Book saved. Total vouchers now: ${totalVouchers}`);
      toast(`Synced ${parsed.vouchers.length} vouchers (${totalVouchers} total)`, "success");
    } catch (err: any) {
      addLog(`ERROR: ${err.message}`);
      toast(`Day Book sync failed: ${err.message}`, "error");
    } finally {
      setSyncing(false);
    }
  }

  async function handleIncrementalSync() {
    if (!companyName.trim()) { toast("Enter company name", "warn"); return; }
    setSyncing(true);
    setDebugLog([]);
    setReport(null);
    setPendingData(null);
    try {
      // Determine start date: day after last known voucher, or FY start
      let incrementalFrom = fyFromDate;
      if (lastVoucherDate) {
        // Parse YYYY-MM-DD to YYYYMMDD and add 1 day
        const d = new Date(lastVoucherDate);
        d.setDate(d.getDate() + 1);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        incrementalFrom = `${yyyy}${mm}${dd}`;
        addLog(`Incremental sync: fetching from ${lastVoucherDate} + 1 day (${incrementalFrom}) to ${fyToDate}`);
      } else {
        addLog(`No previous voucher date found — falling back to full FY range (${fyFromDate} → ${fyToDate})`);
      }

      // If incremental start is after the end date, nothing to sync
      if (incrementalFrom > fyToDate) {
        addLog("Already up to date — no new vouchers to fetch.");
        toast("Already up to date", "success");
        setSyncing(false);
        return;
      }

      const result = await syncDayBook(companyName, incrementalFrom, fyToDate, syncMode);

      if (result.errors?.length) {
        for (const err of result.errors) addLog(`⚠ ${err}`);
      }

      if (!result.success || result.stats.vouchers === 0) {
        addLog(result.error || "Zero new vouchers found since last sync.");
        toast("No new vouchers found", "info");
        setSyncing(false);
        return;
      }
      addLog(`✓ ${result.stats.vouchers} new vouchers fetched in ${result.stats.elapsedSeconds}s`);

      addLog("Parsing transactions...");
      const parsed = parseTransactions(result.data);
      addLog(`Parsed: ${parsed.vouchers.length} vouchers`);

      const existingRaw = await loadData<unknown>("parsedData");
      const existing = existingRaw ? deserializeParsedData(existingRaw) : null;

      const data: ParsedData = {
        company: existing?.company ?? { name: companyName, fyStartMonth: 4 },
        items: existing?.items ?? new Map(),
        ledgers: existing?.ledgers ?? new Map(),
        vouchers: parsed.vouchers,
        importedAt: new Date().toISOString(),
        sourceFiles: ["tally-incremental-sync"],
        warnings: parsed.warnings,
      };

      if (existing) {
        await createBackup(existingRaw, `pre-incremental-sync`);
      }
      mergeData(data);

      const merged = useDataStore.getState().data!;
      await saveData("parsedData", serializeParsedData(merged));

      // Track latest voucher date for next incremental sync
      const allDates = merged.vouchers.filter(v => !v.isCancelled).map(v => v.date).sort();
      const latestDate = allDates.length > 0 ? allDates[allDates.length - 1] : null;
      if (latestDate) setLastVoucherDate(latestDate);
      setLastVouchersSync(new Date().toISOString());
      setLastSync(new Date().toISOString());

      addLog(`✓ Incremental sync complete. Total vouchers: ${merged.vouchers.length}`);
      toast(`Added ${parsed.vouchers.length} new vouchers (${merged.vouchers.length} total)`, "success");
    } catch (err: any) {
      addLog(`ERROR: ${err.message}`);
      toast(`Incremental sync failed: ${err.message}`, "error");
    } finally {
      setSyncing(false);
    }
  }

  async function handleImportAll() {
    if (!companyName.trim()) { toast("Enter company name", "warn"); return; }
    if (!fyFromDate || !fyToDate) { toast("Select date range", "warn"); return; }
    setSyncing(true);
    setDebugLog([]);
    setReport(null);
    setPendingData(null);
    try {
      const t0 = Date.now();
      addLog(`=== IMPORT ALL: "${companyName}" (${fyFromDate} → ${fyToDate}) ===`);

      // Step 1: Sync Masters
      addLog("Step 1/2: Fetching masters (groups + units + stock items + ledgers)...");
      const mastersResult = await syncMasters(companyName);
      if (mastersResult.errors?.length) mastersResult.errors.forEach(e => addLog(`⚠ ${e}`));
      addLog(`✓ ${mastersResult.stats.stockGroups} groups, ${mastersResult.stats.units} units, ${mastersResult.stats.stockItems} stock items, ${mastersResult.stats.ledgers} ledgers, ${mastersResult.stats.godowns ?? 0} godowns, ${mastersResult.stats.costCentres ?? 0} cost centres`);

      // Step 2: Sync Day Book (chunked)
      addLog(`Step 2/2: Fetching vouchers [${syncMode} chunks] (this may take 2-10 minutes)...`);
      const dayBookResult = await syncDayBook(companyName, fyFromDate, fyToDate, syncMode);
      if (dayBookResult.errors?.length) dayBookResult.errors.forEach(e => addLog(`⚠ ${e}`));
      addLog(`✓ ${dayBookResult.stats.vouchers} vouchers fetched (${dayBookResult.stats.chunksSucceeded}/${dayBookResult.stats.chunksTotal} chunks)`);
      if (dayBookResult.stats.chunkDetails) {
        for (const cd of dayBookResult.stats.chunkDetails) {
          addLog(`  ${cd.label}: ${cd.count} vouchers (${cd.ms}ms)`);
        }
      }

      // Parse masters
      addLog("Parsing masters...");
      const parsedMasters = parseMasters(mastersResult.data);
      addLog(`Parsed: ${parsedMasters.stockGroups.length} groups, ${parsedMasters.units.length} units, ${parsedMasters.items.size} items, ${parsedMasters.ledgers.size} ledgers`);

      // Parse vouchers
      addLog("Parsing transactions...");
      const parsedTx = parseTransactions(dayBookResult.data);
      addLog(`Parsed: ${parsedTx.vouchers.length} vouchers`);

      // Show voucher date distribution
      if (parsedTx.vouchers.length > 0) {
        const dateCounts = new Map<string, number>();
        const typeCounts = new Map<string, number>();
        for (const v of parsedTx.vouchers) {
          dateCounts.set(v.date, (dateCounts.get(v.date) || 0) + 1);
          typeCounts.set(v.voucherType, (typeCounts.get(v.voucherType) || 0) + 1);
        }
        const dates = [...dateCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        if (dates.length > 15) {
          addLog(`Voucher dates: ${dates.length} unique dates from ${dates[0][0]} to ${dates[dates.length - 1][0]}`);
        } else {
          addLog(`Voucher dates: ${dates.map(([d, c]) => `${d} (${c})`).join(", ")}`);
        }
        addLog(`Voucher types: ${[...typeCounts.entries()].map(([t, c]) => `${t}: ${c}`).join(", ")}`);
      }

      // Load existing data for backup
      const existingRaw = await loadData<unknown>("parsedData");
      const existing = existingRaw ? deserializeParsedData(existingRaw) : null;

      // Build combined ParsedData
      const data: ParsedData = {
        company: parsedMasters.company ?? { name: companyName, fyStartMonth: 4 },
        items: parsedMasters.items,
        ledgers: parsedMasters.ledgers,
        vouchers: parsedTx.vouchers,
        importedAt: new Date().toISOString(),
        sourceFiles: ["tally-import-all"],
        warnings: [...parsedMasters.warnings, ...parsedTx.warnings],
        tallyPL: mastersResult.tallyFinancials?.pl ?? undefined,
        tallyBS: mastersResult.tallyFinancials?.bs ?? undefined,
      };
      if (data.tallyPL) addLog(`✓ Tally P&L: Sales=${(data.tallyPL.sales/100000).toFixed(1)}L, Closing Stock=${(data.tallyPL.closingStock/100000).toFixed(1)}L`);
      if (data.tallyBS) addLog(`✓ Tally BS: Capital=${(data.tallyBS.capitalAccount/100000).toFixed(1)}L, P&L=${(data.tallyBS.profitAndLoss/100000).toFixed(1)}L`);

      // Backup existing data
      if (existing) {
        await createBackup(existingRaw, `pre-import-all`);
      }

      // Save
      mergeData(data);
      const merged = useDataStore.getState().data!;
      await saveData("parsedData", serializeParsedData(merged));

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      setLastSync(new Date().toISOString());
      setLastMastersSync(new Date().toISOString());
      // Track latest voucher date for incremental sync
      const allDates = merged.vouchers.filter(v => !v.isCancelled).map(v => v.date).sort();
      const latestDate = allDates.length > 0 ? allDates[allDates.length - 1] : null;
      if (latestDate) setLastVoucherDate(latestDate);
      setLastVouchersSync(new Date().toISOString());

      addLog(`✓ Import All complete in ${elapsed}s — ${merged.items.size} items, ${merged.ledgers.size} ledgers, ${merged.vouchers.length} vouchers`);
      toast(`Imported ${merged.items.size} items, ${merged.ledgers.size} ledgers, ${merged.vouchers.length} vouchers`, "success");
    } catch (err: any) {
      addLog(`ERROR: ${err.message}`);
      toast(`Import failed: ${err.message}`, "error");
    } finally {
      setSyncing(false);
    }
  }

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
        try {
          mastersRaw = JSON.parse(await mastersFile.text());
          addLog("Masters file parsed (UTF-8)");
        } catch {
          addLog("UTF-8 failed, trying UTF-16...");
          const buf = await mastersFile.arrayBuffer();
          const decoder = new TextDecoder("utf-16");
          mastersRaw = JSON.parse(decoder.decode(buf));
          addLog("Masters file parsed (UTF-16)");
        }
        try {
          await saveJsonUpload(mastersFile.name, mastersRaw);
          addLog(`✓ Masters JSON persisted locally as "${mastersFile.name}"`);
        } catch { addLog("Warning: Could not persist masters JSON locally"); }
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

      try {
        await saveJsonUpload(txFile.name, txRaw);
        addLog(`✓ Transactions JSON persisted locally as "${txFile.name}"`);
      } catch { addLog("Warning: Could not persist transactions JSON locally"); }

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

    const existingRaw = await loadData<unknown>("parsedData");
    const existingData = existingRaw ? deserializeParsedData(existingRaw) : null;

    if (mastersRaw) {
      addLog("Parsing masters (items, ledgers)...");
      const parsed = parseMasters(mastersRaw);
      company = parsed.company;

      if (existingData) {
        addLog("Merging new masters with existing data...");
        items = new Map(existingData.items);
        ledgers = new Map(existingData.ledgers);

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

    let vouchers = newVouchers;
    let duplicatesRemoved = 0;
    let newVouchersAdded = 0;

    if (existingData && existingData.vouchers.length > 0) {
      addLog("Detecting duplicates and merging vouchers...");

      const existingVoucherIds = new Set(existingData.vouchers.map(v => v.voucherId));

      const uniqueNewVouchers = newVouchers.filter(v => {
        if (existingVoucherIds.has(v.voucherId)) {
          duplicatesRemoved++;
          return false;
        }
        return true;
      });

      newVouchersAdded = uniqueNewVouchers.length;

      vouchers = [...existingData.vouchers, ...uniqueNewVouchers];
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

    const existingRaw = await loadData("parsedData");
    if (existingRaw) {
      const dateLabel = new Date().toISOString().slice(0, 10);
      const backupKey = await createBackup(existingRaw, `pre-import_${dateLabel}`);
      addLog(`Backup created: ${backupKey}`);
    }

    const prevSnapshot = await loadFromStore<PredictionSnapshot>("predictions", "latest");

    mergeData(pendingData);
    const merged = useDataStore.getState().data!;
    await saveData("parsedData", serializeParsedData(pendingData));

    if (prevSnapshot && prevSnapshot.predictions.length > 0) {
      const accuracy = scorePredictions(prevSnapshot.predictions, pendingData.vouchers, "Sales");
      if (accuracy.length > 0) {
        const avgDateScore = accuracy.reduce((s, a) => s + a.dateAccuracyScore, 0) / accuracy.length;
        const avgItemScore = accuracy.reduce((s, a) => s + a.itemAccuracyScore, 0) / accuracy.length;

        const accuracyKey = `accuracy_${new Date().toISOString().slice(0, 10)}`;
        await saveToStore("predictions", accuracyKey, accuracy);

        addLog(`Prediction accuracy: dates ${(avgDateScore * 100).toFixed(0)}%, items ${(avgItemScore * 100).toFixed(0)}%`);
        toast(
          `Prediction accuracy: dates ${(avgDateScore * 100).toFixed(0)}%, items ${(avgItemScore * 100).toFixed(0)}%`,
          avgDateScore > 0.5 ? "success" : "warn"
        );
      }
    }

    const freshPredictions = generatePredictions(merged.vouchers, merged.items, "Sales");
    const { generateItemForecasts } = await import("../engine/prediction");
    const { forecasts: itemForecasts, alerts: inventoryAlerts } = generateItemForecasts(merged.vouchers, merged.items);
    await saveToStore("predictions", "latest", {
      generatedAt: new Date().toISOString(),
      predictions: freshPredictions,
      itemForecasts,
      inventoryAlerts,
    });
    addLog(`Generated ${freshPredictions.length} party predictions + ${itemForecasts.length} item forecasts + ${inventoryAlerts.length} alerts`);

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
        <h1 className="text-2xl md:text-3xl font-bold text-primary mb-1">Import Tally Data</h1>
        <p className="text-muted text-xs md:text-sm">Connect live to TallyPrime or upload JSON files</p>
      </div>

      {/* Tab Switcher */}
      <div className="flex gap-2 mb-6 bg-bg-card border border-bg-border rounded-lg p-1">
        <button
          onClick={() => setTab("live")}
          className={clsx(
            "flex items-center gap-2 flex-1 px-4 py-2.5 rounded-md font-medium transition",
            tab === "live"
              ? "bg-accent text-white"
              : "text-muted hover:text-primary"
          )}
        >
          <Zap size={16} />
          Live Tally Connection
        </button>
        <button
          onClick={() => setTab("upload")}
          className={clsx(
            "flex items-center gap-2 flex-1 px-4 py-2.5 rounded-md font-medium transition",
            tab === "upload"
              ? "bg-accent text-white"
              : "text-muted hover:text-primary"
          )}
        >
          <Upload size={16} />
          Upload JSON Files
        </button>
      </div>

      {/* Existing Data Info */}
      {existingDataInfo && (
        <div className="bento-card mb-6">
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

      {/* LIVE TALLY TAB */}
      {tab === "live" && (
        <div className="space-y-6">
          {/* Connection Status */}
          <div className={clsx(
            "border rounded-xl p-4",
            isConnected ? "bg-success/10 border-success/30" : "bg-danger/10 border-danger/30"
          )}>
            <div className="flex items-center gap-3 mb-3">
              {isConnected ? (
                <Wifi size={20} className="text-success" />
              ) : (
                <WifiOff size={20} className="text-danger" />
              )}
              <div>
                <div className="font-semibold text-primary">
                  {isConnected ? "Connected to Tally" : "Not Connected"}
                </div>
                <div className="text-xs text-muted">
                  {isConnected
                    ? "Proxy server running on http://localhost:3100"
                    : "Start proxy: cd server && npm run dev"}
                </div>
              </div>
              <button
                onClick={checkConnection}
                className="ml-auto text-sm px-3 py-1.5 bg-bg-border hover:bg-bg-border/70 rounded-md text-muted hover:text-primary"
              >
                Test Connection
              </button>
            </div>
            {lastSyncAt && (
              <div className="text-xs text-muted">
                Last sync: {new Date(lastSyncAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
              </div>
            )}
            {lastMastersSyncAt && (
              <div className="text-xs text-muted">
                Masters: {new Date(lastMastersSyncAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
              </div>
            )}
            {lastVouchersSyncAt && (
              <div className="text-xs text-muted">
                Vouchers: {new Date(lastVouchersSyncAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                {lastVoucherDate && ` (up to ${lastVoucherDate})`}
              </div>
            )}
          </div>

          {/* Sync Form */}
          <div className="bento-card space-y-4">
            <div>
              <label className="block text-sm font-medium text-primary mb-2">Company Name</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  className="flex-1 px-4 py-2 bg-bg border border-bg-border rounded-lg text-primary font-medium focus:outline-none focus:ring-2 focus:ring-accent"
                  placeholder="Enter exact company name from TallyPrime"
                />
                <button
                  onClick={async () => {
                    try {
                      const result = await detectCompany();
                      if (result.current) {
                        setCompanyName(result.current);
                        addLog(`✓ Auto-detected company: ${result.current}`);
                        toast(`Detected: ${result.current}`, "success");
                      } else {
                        toast("Could not detect company — is Tally running?", "warn");
                      }
                    } catch {
                      toast("Detection failed", "error");
                    }
                  }}
                  disabled={isSyncing}
                  className="px-4 py-2 bg-accent hover:bg-accent-hover disabled:opacity-50 text-white font-medium rounded-lg transition text-sm whitespace-nowrap"
                >
                  Auto-Detect
                </button>
              </div>
              <p className="text-xs text-muted mt-1">
                Must match EXACTLY as shown in TallyPrime (case-sensitive, including dots/spaces)
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-primary mb-2">
                  FY From Date
                </label>
                <input
                  type="date"
                  value={formatDateForInput(fyFromDate)}
                  onChange={(e) => {
                    const yyyymmdd = e.target.value.replace(/-/g, '');
                    setFyDates(yyyymmdd, fyToDate);
                  }}
                  className="w-full px-4 py-2 bg-bg border border-bg-border rounded-lg text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-primary mb-2">
                  FY To Date
                </label>
                <input
                  type="date"
                  value={formatDateForInput(fyToDate)}
                  onChange={(e) => {
                    const yyyymmdd = e.target.value.replace(/-/g, '');
                    setFyDates(fyFromDate, yyyymmdd);
                  }}
                  className="w-full px-4 py-2 bg-bg border border-bg-border rounded-lg text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
            </div>
            {/* Date range summary + Reset + Chunk mode */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex-1 text-xs text-muted bg-bg border border-bg-border rounded-lg px-3 py-2">
                <strong>Range:</strong> {fyFromDate.slice(6,8)}/{fyFromDate.slice(4,6)}/{fyFromDate.slice(0,4)} — {fyToDate.slice(6,8)}/{fyToDate.slice(4,6)}/{fyToDate.slice(0,4)} ({formatFYRange(fyFromDate, fyToDate)})
                {fyFromDate === fyToDate && <span className="text-danger ml-2 font-bold">⚠ SINGLE DAY — click Reset FY!</span>}
                {fyFromDate > fyToDate && <span className="text-danger ml-2 font-bold">⚠ FROM after TO — click Reset FY!</span>}
              </div>
              <button
                onClick={() => {
                  resetToCurrentFY();
                  addLog("✓ Dates reset to current FY");
                }}
                className="text-xs px-3 py-2 bg-warn/20 hover:bg-warn/30 text-warn font-semibold rounded-lg transition whitespace-nowrap"
              >
                Reset to Current FY
              </button>
            </div>

            {/* Chunk mode selector */}
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted font-medium">Sync Mode:</span>
              {(["monthly", "weekly", "daily"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setSyncMode(mode)}
                  className={`text-xs px-3 py-1.5 rounded-md font-medium transition ${
                    syncMode === mode
                      ? "bg-accent text-white"
                      : "bg-bg-border text-muted hover:text-primary"
                  }`}
                >
                  {mode === "monthly" ? "Monthly (fast)" : mode === "weekly" ? "Weekly (balanced)" : "Daily (safest)"}
                </button>
              ))}
            </div>
            <div className="text-xs text-muted bg-bg border border-bg-border rounded-lg px-3 py-2">
              💡 <strong>Tip:</strong> Use <strong>Monthly</strong> for fast syncs. If you get empty/partial data, try <strong>Weekly</strong> or <strong>Daily</strong> mode — it makes smaller requests that are less likely to timeout or fail.
            </div>

            {/* Primary Import All Button */}
            <button
              onClick={handleImportAll}
              disabled={isSyncing || !isConnected || !companyName.trim() || !fyFromDate || !fyToDate}
              className="flex items-center justify-center gap-2 w-full bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold px-6 py-3.5 rounded-lg transition text-base"
            >
              {isSyncing ? <Loader2 size={18} className="animate-spin" /> : <RefreshCw size={18} />}
              {isSyncing ? "Importing..." : "Import All from Tally"}
            </button>

            {/* Secondary: Individual Sync Buttons */}
            <div className="grid grid-cols-3 gap-3">
              <button
                onClick={handleSyncMasters}
                disabled={isSyncing || !isConnected || !companyName.trim()}
                className="flex items-center justify-center gap-2 bg-bg-border hover:bg-bg-border/70 disabled:opacity-50 disabled:cursor-not-allowed text-muted hover:text-primary font-medium px-4 py-2.5 rounded-lg transition text-sm"
              >
                {isSyncing ? <Loader2 size={14} className="animate-spin" /> : <Package size={14} />}
                Masters Only (Groups + Units + Items + Ledgers)
              </button>
              <button
                onClick={handleSyncDayBook}
                disabled={isSyncing || !isConnected || !companyName.trim() || !fyFromDate || !fyToDate}
                className="flex items-center justify-center gap-2 bg-bg-border hover:bg-bg-border/70 disabled:opacity-50 disabled:cursor-not-allowed text-muted hover:text-primary font-medium px-4 py-2.5 rounded-lg transition text-sm"
              >
                {isSyncing ? <Loader2 size={14} className="animate-spin" /> : <FileJson size={14} />}
                Vouchers Only (Monthly Chunks)
              </button>
              <button
                onClick={handleIncrementalSync}
                disabled={isSyncing || !isConnected || !companyName.trim()}
                className="flex items-center justify-center gap-2 bg-bg-border hover:bg-bg-border/70 disabled:opacity-50 disabled:cursor-not-allowed text-muted hover:text-primary font-medium px-4 py-2.5 rounded-lg transition text-sm"
              >
                {isSyncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                {lastVoucherDate ? `Since ${lastVoucherDate}` : "Incremental Sync"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* UPLOAD JSON TAB */}
      {tab === "upload" && (
        <div className="space-y-6">
          {/* Drop Zones */}
          <div className="grid grid-cols-2 gap-4">
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
          <div className="flex gap-3">
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
        </div>
      )}

      {/* Debug Log */}
      {debugLog.length > 0 && (
        <div className="bento-card mt-6">
          <h3 className="text-sm font-semibold text-primary mb-2 flex items-center gap-2">
            <Info size={14} />
            {tab === "live" ? "Sync Progress Log" : "Import Progress Log"}
          </h3>
          <div className="bg-bg border border-bg-border rounded-lg p-3 max-h-72 overflow-y-auto font-mono text-xs">
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
        <div className="bento-card space-y-4 mt-6">
          <h2 className="text-base md:text-lg font-semibold text-primary">Import Summary</h2>

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
          <div className={clsx("grid gap-4", report.stockGroups || report.units ? "grid-cols-3 md:grid-cols-5" : "grid-cols-3")}>
            {[
              ...(report.stockGroups ? [{ label: "Groups", value: report.stockGroups, color: "text-muted" }] : []),
              ...(report.units ? [{ label: "Units", value: report.units, color: "text-muted" }] : []),
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
