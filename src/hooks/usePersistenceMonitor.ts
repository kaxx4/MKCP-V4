/**
 * Data Persistence Monitor Hook
 *
 * Ensures that imported Tally data persists across page reloads and browser sessions.
 * This hook monitors the data store and performs automatic backups to IndexedDB.
 */

import { useEffect, useRef } from "react";
import { useDataStore } from "../store/dataStore";
import { saveData, createBackup, pruneBackups, clearStore } from "../db/idb";
import { serializeParsedData } from "../utils/serialize";

interface PersistenceConfig {
  autoBackupInterval?: number; // ms between auto-backups (default: 5 min)
  verbose?: boolean; // Log persistence events
  onDataChanged?: () => void; // Callback when data changes
}

// Max backups kept in IndexedDB at any time. createBackup() has always
// inserted under a fresh key with nothing ever deleting old ones — left
// running for weeks this grew the `backups` store into tens of GB. Prune
// after every new backup, and run a one-time aggressive sweep on first
// mount to reclaim whatever's already accumulated.
const MAX_BACKUPS = 10;
const CLEANUP_DONE_KEY = "mkc_backup_cleanup_20260814";

/**
 * Hook that monitors data store and ensures persistence to IndexedDB
 * Call this once in your root component (e.g., App.tsx)
 */
export function usePersistenceMonitor(config: PersistenceConfig = {}) {
  const { autoBackupInterval = 5 * 60 * 1000, verbose = false } = config;
  const data = useDataStore((s) => s.data);
  // Use importedAt as a cheap change sentinel — O(1) vs O(n) JSON.stringify
  const lastSavedRef = useRef<string | null>(null);
  const backupIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onDataChangedRef = useRef(config.onDataChanged);
  onDataChangedRef.current = config.onDataChanged;

  // Save data whenever it changes.
  // Debounced 500ms (was 100ms) — during Tally sync the data merges in chunks
  // and 100ms debounce was queueing too many IDB writes back-to-back, causing
  // jank. 500ms collapses bursts of merges into a single write.
  useEffect(() => {
    if (!data) return;

    const changeKey = data.importedAt;
    if (changeKey === lastSavedRef.current) return;
    lastSavedRef.current = changeKey;

    const performSave = async () => {
      try {
        await saveData("parsedData", serializeParsedData(data));
        if (verbose) {
          console.log(
            `[PERSIST] ✓ Data saved (${data.vouchers?.length ?? 0} vouchers, ${data.items?.size ?? 0} items)`
          );
        }
        onDataChangedRef.current?.();
      } catch (err) {
        console.error("[PERSIST] ✗ Failed to save data:", err);
      }
    };

    // Schedule the save in an idle callback so we don't block paint;
    // wrap with a 500ms debounce timer so rapid merges collapse to one write.
    const timer = setTimeout(() => {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(performSave, { timeout: 2000 });
      } else {
        performSave();
      }
    }, 500);
    return () => clearTimeout(timer);
    // NOTE: onDataChanged callback intentionally NOT a dep — it's read via ref
    // so inline arrow functions passed by callers don't retrigger this effect
    // on every render of the parent.
  }, [data, verbose]);

  // Periodic auto-backup (5-min default). Reads data imperatively via getState()
  // so the interval is stable — it doesn't restart every time data changes.
  const lastBackupKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const scheduledBackup = () => {
      const current = useDataStore.getState().data;
      if (!current || current.vouchers.length === 0) return;

      // Skip if nothing changed since the last backup — previously every
      // tick backed up unconditionally even when idle.
      if (current.importedAt === lastBackupKeyRef.current) return;

      const performBackup = async () => {
        try {
          const backupKey = await createBackup(
            serializeParsedData(current),
            `auto_backup_${new Date().toISOString()}`
          );
          lastBackupKeyRef.current = current.importedAt;
          if (verbose) {
            console.log(`[PERSIST] ✓ Auto-backup created: ${backupKey}`);
          }
          const pruned = await pruneBackups(MAX_BACKUPS);
          if (verbose && pruned > 0) {
            console.log(`[PERSIST] ✓ Pruned ${pruned} old backup(s)`);
          }
        } catch (err) {
          console.warn("[PERSIST] ⚠️ Auto-backup failed:", err);
        }
      };

      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(performBackup, { timeout: 3000 });
      } else {
        void performBackup();
      }
    };

    backupIntervalRef.current = setInterval(scheduledBackup, autoBackupInterval);
    return () => {
      if (backupIntervalRef.current) clearInterval(backupIntervalRef.current);
    };
  }, [autoBackupInterval, verbose]);

  // One-time cleanup: reclaim IndexedDB space already accumulated by the
  // unbounded backup leak (and any stale raw-upload entries from the old
  // jsonUploads writer, which no longer exists in this codebase).
  useEffect(() => {
    if (localStorage.getItem(CLEANUP_DONE_KEY)) return;
    (async () => {
      try {
        const prunedBackups = await pruneBackups(MAX_BACKUPS);
        const clearedUploads = await clearStore("jsonUploads");
        localStorage.setItem(CLEANUP_DONE_KEY, "1");
        if (verbose || prunedBackups > 0 || clearedUploads > 0) {
          console.log(
            `[PERSIST] ✓ One-time cleanup: removed ${prunedBackups} old backup(s), ${clearedUploads} stale upload entrie(s)`
          );
        }
      } catch (err) {
        console.warn("[PERSIST] ⚠️ One-time cleanup failed:", err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export default usePersistenceMonitor;
