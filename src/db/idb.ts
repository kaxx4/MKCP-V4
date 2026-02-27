import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "mkcycles-db";
const DB_VERSION = 2; // bump version for new stores

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
