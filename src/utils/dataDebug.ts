/**
 * Data Persistence Debug Utilities
 *
 * Use these to diagnose why imported Tally data might not persist across page loads.
 * Call from browser console: window.__mkcycles?.diagnoseDataPersistence()
 */

import { loadData, getAllFromStore, getAllKeysFromStore } from "../db/idb";
import type { ParsedData } from "../types/canonical";

export interface DataDiagnostics {
  timestamp: string;
  indexedDbStatus: {
    available: boolean;
    parsedDataStoreExists: boolean;
    parsedDataKeys: IDBValidKey[];
    parsedDataSize: number;
    unitOverridesKeys: IDBValidKey[];
    predictionsKeys: IDBValidKey[];
  };
  dataStatus: {
    hasData: boolean;
    voucherCount?: number;
    itemCount?: number;
    ledgerCount?: number;
    company?: string;
    importedAt?: string;
    sourceFiles?: string[];
    warnings?: number;
  };
  zustandState: {
    hasDataInStore: boolean;
    hasRawDataInStore: boolean;
  };
  localStorageStatus: {
    available: boolean;
    zustandKeys: string[];
  };
  recommendations: string[];
}

/**
 * Run comprehensive diagnostics on data persistence
 */
export async function diagnoseDataPersistence(): Promise<DataDiagnostics> {
  const diagnostics: DataDiagnostics = {
    timestamp: new Date().toISOString(),
    indexedDbStatus: {
      available: false,
      parsedDataStoreExists: false,
      parsedDataKeys: [],
      parsedDataSize: 0,
      unitOverridesKeys: [],
      predictionsKeys: [],
    },
    dataStatus: {
      hasData: false,
    },
    zustandState: {
      hasDataInStore: false,
      hasRawDataInStore: false,
    },
    localStorageStatus: {
      available: false,
      zustandKeys: [],
    },
    recommendations: [],
  };

  try {
    // Check IndexedDB availability
    if (typeof indexedDB !== "undefined") {
      diagnostics.indexedDbStatus.available = true;

      // Get all keys from each store
      try {
        diagnostics.indexedDbStatus.parsedDataKeys = await getAllKeysFromStore("parsedData");
        diagnostics.indexedDbStatus.parsedDataStoreExists = true;
      } catch (e) {
        console.error("Failed to get parsedData keys:", e);
      }

      try {
        diagnostics.indexedDbStatus.unitOverridesKeys = await getAllKeysFromStore("unitOverrides");
      } catch (e) {
        console.error("Failed to get unitOverrides keys:", e);
      }

      try {
        diagnostics.indexedDbStatus.predictionsKeys = await getAllKeysFromStore("predictions");
      } catch (e) {
        console.error("Failed to get predictions keys:", e);
      }

      // Try to load and analyze parsed data
      if (diagnostics.indexedDbStatus.parsedDataKeys.length > 0) {
        try {
          const data = await loadData<unknown>("parsedData");
          if (data) {
            diagnostics.indexedDbStatus.parsedDataSize = JSON.stringify(data).length;

            // Try to extract metadata if it's ParsedData
            if (typeof data === "object" && data !== null) {
              const obj = data as any;
              if ("vouchers" in obj && Array.isArray(obj.vouchers)) {
                diagnostics.dataStatus.voucherCount = obj.vouchers.length;
              }
              if ("items" in obj && obj.items instanceof Map) {
                diagnostics.dataStatus.itemCount = obj.items.size;
              }
              if ("items" in obj && typeof obj.items === "object") {
                diagnostics.dataStatus.itemCount = Object.keys(obj.items).length;
              }
              if ("ledgers" in obj) {
                if (obj.ledgers instanceof Map) {
                  diagnostics.dataStatus.ledgerCount = obj.ledgers.size;
                } else if (typeof obj.ledgers === "object") {
                  diagnostics.dataStatus.ledgerCount = Object.keys(obj.ledgers).length;
                }
              }
              if ("company" in obj && typeof obj.company === "object") {
                diagnostics.dataStatus.company = obj.company?.name;
              }
              if ("importedAt" in obj) {
                diagnostics.dataStatus.importedAt = obj.importedAt;
              }
              if ("sourceFiles" in obj && Array.isArray(obj.sourceFiles)) {
                diagnostics.dataStatus.sourceFiles = obj.sourceFiles;
              }
              if ("warnings" in obj && Array.isArray(obj.warnings)) {
                diagnostics.dataStatus.warnings = obj.warnings.length;
              }
              diagnostics.dataStatus.hasData = true;
            }
          }
        } catch (e) {
          console.error("Failed to load parsed data:", e);
          diagnostics.recommendations.push("⚠️ Data exists in IndexedDB but failed to deserialize - may be corrupted");
        }
      }
    } else {
      diagnostics.recommendations.push("❌ IndexedDB not available - browser privacy mode or old browser detected");
    }
  } catch (e) {
    console.error("IndexedDB diagnostics failed:", e);
    diagnostics.recommendations.push("❌ Critical IndexedDB error - check browser console for details");
  }

  // Check Zustand state (if available in window)
  try {
    const window_any = window as any;
    if (window_any.__mkcycles?.dataStore) {
      const state = window_any.__mkcycles.dataStore.getState();
      diagnostics.zustandState.hasDataInStore = state.data !== null;
      diagnostics.zustandState.hasRawDataInStore = state.rawData !== null;
    }
  } catch (e) {
    console.warn("Could not access Zustand state");
  }

  // Check localStorage for Zustand persistence
  try {
    if (typeof localStorage !== "undefined") {
      diagnostics.localStorageStatus.available = true;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.includes("zustand") || key?.includes("override")) {
          diagnostics.localStorageStatus.zustandKeys.push(key);
        }
      }
    }
  } catch (e) {
    diagnostics.recommendations.push("⚠️ localStorage not available - browser privacy mode detected");
  }

  // Generate recommendations
  if (!diagnostics.indexedDbStatus.available) {
    diagnostics.recommendations.push("🔴 CRITICAL: IndexedDB is not available - data cannot persist");
  } else if (diagnostics.indexedDbStatus.parsedDataKeys.length === 0) {
    diagnostics.recommendations.push("🟡 WARNING: No data imported yet. Use Import page to load Tally data first");
  } else if (!diagnostics.dataStatus.hasData) {
    diagnostics.recommendations.push("🔴 CRITICAL: Data keys exist but cannot be loaded - IndexedDB may be corrupted");
    diagnostics.recommendations.push("   ACTION: Open IndexedDB in DevTools and verify data is stored");
  } else {
    diagnostics.recommendations.push("✅ Data persistence appears healthy");
    if (diagnostics.dataStatus.voucherCount) {
      diagnostics.recommendations.push(`✅ ${diagnostics.dataStatus.voucherCount} vouchers loaded from storage`);
    }
    if (diagnostics.dataStatus.itemCount) {
      diagnostics.recommendations.push(`✅ ${diagnostics.dataStatus.itemCount} items loaded from storage`);
    }
  }

  // Check if data should be in Zustand but isn't
  if (diagnostics.dataStatus.hasData && !diagnostics.zustandState.hasDataInStore) {
    diagnostics.recommendations.push("⚠️ Data exists in IndexedDB but not loaded in memory - try refreshing the page");
  }

  if (diagnostics.dataStatus.importedAt) {
    diagnostics.recommendations.push(`ℹ️ Last import: ${new Date(diagnostics.dataStatus.importedAt).toLocaleString()}`);
  }

  return diagnostics;
}

/**
 * Print diagnostics in a readable format
 */
export async function printDataDiagnostics(): Promise<void> {
  const diag = await diagnoseDataPersistence();

  console.group("🔍 MKCP Dashboard - Data Persistence Diagnostics");
  console.log("Timestamp:", diag.timestamp);

  console.group("📦 IndexedDB Status");
  console.log("Available:", diag.indexedDbStatus.available ? "✅ Yes" : "❌ No");
  console.log("Parsed Data Keys:", diag.indexedDbStatus.parsedDataKeys.length > 0 ? "✅ Found" : "❌ None");
  console.log("Data Store Size:", diag.indexedDbStatus.parsedDataSize.toLocaleString(), "bytes");
  console.log("Unit Overrides Keys:", diag.indexedDbStatus.unitOverridesKeys.length);
  console.log("Predictions Keys:", diag.indexedDbStatus.predictionsKeys.length);
  console.groupEnd();

  console.group("📊 Loaded Data Status");
  console.log("Has Data:", diag.dataStatus.hasData ? "✅ Yes" : "❌ No");
  if (diag.dataStatus.hasData) {
    console.log("Company:", diag.dataStatus.company ?? "Unknown");
    console.log("Vouchers:", diag.dataStatus.voucherCount ?? 0);
    console.log("Items:", diag.dataStatus.itemCount ?? 0);
    console.log("Ledgers:", diag.dataStatus.ledgerCount ?? 0);
    console.log("Warnings:", diag.dataStatus.warnings ?? 0);
    console.log("Imported At:", diag.dataStatus.importedAt);
    if (diag.dataStatus.sourceFiles?.length) {
      console.log("Source Files:", diag.dataStatus.sourceFiles);
    }
  }
  console.groupEnd();

  console.group("🧠 In-Memory State");
  console.log("Data in Zustand:", diag.zustandState.hasDataInStore ? "✅ Yes" : "❌ No");
  console.log("Raw Data in Zustand:", diag.zustandState.hasRawDataInStore ? "✅ Yes" : "❌ No");
  console.groupEnd();

  console.group("💾 localStorage Status");
  console.log("Available:", diag.localStorageStatus.available ? "✅ Yes" : "❌ No");
  if (diag.localStorageStatus.available && diag.localStorageStatus.zustandKeys.length > 0) {
    console.log("Zustand Keys:", diag.localStorageStatus.zustandKeys);
  }
  console.groupEnd();

  console.group("📋 Recommendations");
  diag.recommendations.forEach((rec) => console.log(rec));
  console.groupEnd();

  console.groupEnd();

  // Also return diagnostics object for programmatic access
  return diag as any;
}

// Export a global function for browser console access
if (typeof window !== "undefined") {
  const window_any = window as any;
  if (!window_any.__mkcycles) {
    window_any.__mkcycles = {};
  }
  window_any.__mkcycles.diagnoseDataPersistence = diagnoseDataPersistence;
  window_any.__mkcycles.printDataDiagnostics = printDataDiagnostics;
  console.log(
    "💡 Data persistence diagnostics available. Run: window.__mkcycles.printDataDiagnostics() in console"
  );
}
