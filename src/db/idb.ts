import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "mkcycles-db";
const DB_VERSION = 3; // bump version for new stores

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (!db.objectStoreNames.contains("parsedData")) {
          db.createObjectStore("parsedData");
        }
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains("unitOverrides")) {
            db.createObjectStore("unitOverrides");
          }
          if (!db.objectStoreNames.contains("backups")) {
            db.createObjectStore("backups");
          }
          if (!db.objectStoreNames.contains("predictions")) {
            db.createObjectStore("predictions");
          }
        }
        if (oldVersion < 3) {
          if (!db.objectStoreNames.contains("jsonUploads")) {
            db.createObjectStore("jsonUploads");
          }
        }
      },
    });
  }
  return dbPromise;
}

export async function saveData(key: string, value: unknown): Promise<void> {
  const db = await getDB();
  await db.put("parsedData", value, key);
}

export async function loadData<T>(key: string): Promise<T | undefined> {
  const db = await getDB();
  return db.get("parsedData", key);
}

export async function clearAllData(): Promise<void> {
  const db = await getDB();
  await db.clear("parsedData");
}

// Generic store operations
export async function saveToStore(storeName: string, key: string, value: unknown): Promise<void> {
  const db = await getDB();
  await db.put(storeName, value, key);
}

export async function loadFromStore<T>(storeName: string, key: string): Promise<T | undefined> {
  const db = await getDB();
  return db.get(storeName, key);
}

export async function getAllFromStore<T>(storeName: string): Promise<T[]> {
  const db = await getDB();
  return db.getAll(storeName);
}

export async function getAllKeysFromStore(storeName: string): Promise<IDBValidKey[]> {
  const db = await getDB();
  return db.getAllKeys(storeName);
}

export async function deleteFromStore(storeName: string, key: string): Promise<void> {
  const db = await getDB();
  await db.delete(storeName, key);
}

// Backup system
export async function createBackup(data: unknown, label: string): Promise<string> {
  const db = await getDB();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const key = `backup_${timestamp}_${label}`;
  await db.put("backups", { data, label, createdAt: new Date().toISOString() }, key);
  return key;
}

export async function listBackups(): Promise<Array<{ key: string; label: string; createdAt: string }>> {
  const db = await getDB();
  const keys = await db.getAllKeys("backups");
  const backups: Array<{ key: string; label: string; createdAt: string }> = [];
  for (const key of keys) {
    const val = await db.get("backups", key);
    if (val) backups.push({ key: String(key), label: val.label, createdAt: val.createdAt });
  }
  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function loadBackup(key: string): Promise<unknown> {
  const db = await getDB();
  const val = await db.get("backups", key);
  return val?.data;
}

export async function deleteBackup(key: string): Promise<void> {
  const db = await getDB();
  await db.delete("backups", key);
}

export async function exportBackupAsJSON(key: string): Promise<Blob> {
  const data = await loadBackup(key);
  return new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
}

export async function clearStore(storeName: string): Promise<void> {
  const db = await getDB();
  await db.clear(storeName);
}

// ── JSON Upload persistence ──────────────────────────
export async function saveJsonUpload(filename: string, data: unknown): Promise<void> {
  const db = await getDB();
  await db.put("jsonUploads", { filename, data, uploadedAt: new Date().toISOString() }, filename);
}

export async function loadJsonUpload<T>(filename: string): Promise<{ filename: string; data: T; uploadedAt: string } | undefined> {
  const db = await getDB();
  return db.get("jsonUploads", filename);
}

export async function listJsonUploads(): Promise<string[]> {
  const db = await getDB();
  const keys = await db.getAllKeys("jsonUploads");
  return keys.map(String);
}

export async function clearJsonUploads(): Promise<void> {
  const db = await getDB();
  await db.clear("jsonUploads");
}

/**
 * Export ALL data (parsedData, overrides, predictions, json uploads) as a single JSON backup.
 * Used by the "Erase Data" flow to create a full backup before clearing.
 */
export async function exportFullBackupAsJSON(): Promise<Blob> {
  const db = await getDB();
  const parsedData = await db.getAll("parsedData");
  const parsedDataKeys = await db.getAllKeys("parsedData");
  const unitOverrides = await db.getAll("unitOverrides");
  const unitOverrideKeys = await db.getAllKeys("unitOverrides");
  const predictions = await db.getAll("predictions");
  const predictionKeys = await db.getAllKeys("predictions");
  const jsonUploads = await db.getAll("jsonUploads");
  const jsonUploadKeys = await db.getAllKeys("jsonUploads");

  const fullBackup = {
    exportedAt: new Date().toISOString(),
    version: DB_VERSION,
    stores: {
      parsedData: parsedDataKeys.map((k, i) => ({ key: String(k), value: parsedData[i] })),
      unitOverrides: unitOverrideKeys.map((k, i) => ({ key: String(k), value: unitOverrides[i] })),
      predictions: predictionKeys.map((k, i) => ({ key: String(k), value: predictions[i] })),
      jsonUploads: jsonUploadKeys.map((k, i) => ({ key: String(k), value: jsonUploads[i] })),
    },
  };

  return new Blob([JSON.stringify(fullBackup, null, 2)], { type: "application/json" });
}

/**
 * Erase all data from ALL stores. Should be called AFTER backup is downloaded.
 */
export async function eraseAllStores(): Promise<void> {
  const db = await getDB();
  await db.clear("parsedData");
  await db.clear("unitOverrides");
  await db.clear("predictions");
  await db.clear("jsonUploads");
  await db.clear("backups");
}
