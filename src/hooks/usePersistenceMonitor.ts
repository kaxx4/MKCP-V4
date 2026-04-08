/**
 * Data Persistence Monitor Hook
 *
 * Ensures that imported Tally data persists across page reloads and browser sessions.
 * This hook monitors the data store and performs automatic backups to IndexedDB.
 */

import { useEffect, useRef } from "react";
import { useDataStore } from "../store/dataStore";
import { saveData, createBackup } from "../db/idb";
import { serializeParsedData } from "../utils/serialize";

interface PersistenceConfig {
  autoBackupInterval?: number; // ms between auto-backups (default: 5 min)
  verbose?: boolean; // Log persistence events
  onDataChanged?: () => void; // Callback when data changes
}

/**
 * Hook that monitors data store and ensures persistence to IndexedDB
 * Call this once in your root component (e.g., App.tsx)
 */
export function usePersistenceMonitor(config: PersistenceConfig = {}) {
  const { autoBackupInterval = 5 * 60 * 1000, verbose = false } = config;
  const { data } = useDataStore();
  const lastSavedRef = useRef<string | null>(null);
  const backupTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Save data whenever it changes
  useEffect(() => {
    if (!data) return;

    const dataString = JSON.stringify(data);

    // Only save if data actually changed
    if (dataString === lastSavedRef.current) {
      return;
    }

    lastSavedRef.current = dataString;

    const performSave = async () => {
      try {
        await saveData("parsedData", serializeParsedData(data));

        if (verbose) {
          console.log(
            `[PERSIST] ✓ Data saved (${data.vouchers?.length ?? 0} vouchers, ${data.items?.size ?? 0} items)`
          );
        }

        config.onDataChanged?.();
      } catch (err) {
        console.error("[PERSIST] ✗ Failed to save data:", err);
      }
    };

    // Debounce saves with a small delay to avoid excessive writes
    const timer = setTimeout(performSave, 100);
    return () => clearTimeout(timer);
  }, [data, verbose, config.onDataChanged]);

  // Periodic auto-backup
  useEffect(() => {
    if (!data || data.vouchers.length === 0) return;

    const performBackup = async () => {
      try {
        const backupKey = await createBackup(
          serializeParsedData(data),
          `auto_backup_${new Date().toISOString()}`
        );

        if (verbose) {
          console.log(`[PERSIST] ✓ Auto-backup created: ${backupKey}`);
        }
      } catch (err) {
        console.warn("[PERSIST] ⚠️ Auto-backup failed:", err);
      }
    };

    backupTimeoutRef.current = setInterval(performBackup, autoBackupInterval);

    return () => {
      if (backupTimeoutRef.current) {
        clearInterval(backupTimeoutRef.current);
      }
    };
  }, [data, autoBackupInterval, verbose]);

  // Cleanup on unmount
  return () => {
    if (backupTimeoutRef.current) {
      clearInterval(backupTimeoutRef.current);
    }
  };
}

export default usePersistenceMonitor;
