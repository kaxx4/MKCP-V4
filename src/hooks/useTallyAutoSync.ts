import { useEffect, useRef } from "react";
import { useTallyStore } from "../store/tallyStore";
import { useDataStore } from "../store/dataStore";
import { fullSync } from "../api/tallyApi";
import { parseMasters } from "../parser/masterParser";
import { parseTransactions } from "../parser/transactionParser";
import { saveData } from "../db/idb";
import { serializeParsedData } from "../utils/serialize";
import type { ParsedData } from "../types/canonical";
import { useToast } from "../components/Toast";

/**
 * Auto-sync hook - runs periodic Tally sync in the background
 * Only runs if isConnected && autoSyncMinutes > 0
 */
export function useTallyAutoSync() {
  const {
    isConnected,
    isSyncing,
    autoSyncMinutes,
    companyName,
    fyFromDate,
    fyToDate,
    setLastSync,
    setSyncing,
  } = useTallyStore();

  const { mergeData } = useDataStore();
  const { toast } = useToast();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Clear any existing interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    // Only set up auto-sync if enabled and connected
    if (!isConnected || autoSyncMinutes <= 0 || !companyName.trim()) {
      return;
    }

    const runAutoSync = async () => {
      // Skip if already syncing
      if (isSyncing) {
        console.log("[auto-sync] Skipping - sync already in progress");
        return;
      }

      try {
        console.log(`[auto-sync] Starting auto-sync for "${companyName}"`);
        setSyncing(true);

        const result = await fullSync(companyName, fyFromDate, fyToDate);

        // Parse using existing parsers
        const mastersResult = parseMasters(result.masters);
        const txResult = parseTransactions(result.transactions);

        // Build ParsedData
        const data: ParsedData = {
          company: mastersResult.company,
          items: mastersResult.items,
          ledgers: mastersResult.ledgers,
          vouchers: txResult.vouchers,
          importedAt: new Date().toISOString(),
          sourceFiles: ["tally-auto-sync"],
          warnings: [...mastersResult.warnings, ...txResult.warnings],
        };

        // Merge and save
        mergeData(data);
        await saveData("parsedData", serializeParsedData(data));

        setLastSync(new Date().toISOString());
        console.log(`[auto-sync] Complete: ${result.stats.vouchers} vouchers, ${result.stats.stockItems} items`);

        toast(
          `Auto-sync complete: ${result.stats.vouchers} vouchers`,
          "success"
        );
      } catch (err: any) {
        console.error("[auto-sync] Failed:", err.message);
        toast(`Auto-sync failed: ${err.message}`, "error");
      } finally {
        setSyncing(false);
      }
    };

    // Set up interval
    const intervalMs = autoSyncMinutes * 60 * 1000;
    console.log(`[auto-sync] Enabled: every ${autoSyncMinutes} minutes`);

    intervalRef.current = setInterval(runAutoSync, intervalMs);

    // Cleanup on unmount
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isConnected, autoSyncMinutes, companyName, fyFromDate, fyToDate, isSyncing]);
}
