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
  const [keys, values] = await Promise.all([db.getAllKeys("backups"), db.getAll("backups")]);
  const backups: Array<{ key: string; label: string; createdAt: string }> = [];
  for (let i = 0; i < keys.length; i++) {
    const val = values[i];
    if (val) backups.push({ key: String(keys[i]), label: val.label, createdAt: val.createdAt });
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

/**
 * Keep only the `keepCount` most recent backups, deleting the rest.
 *
 * createBackup() has always inserted under a fresh timestamped key with no
 * corresponding deletion anywhere in the codebase — every 5-minute
 * usePersistenceMonitor tick added a full ~100-500MB dataset copy to
 * IndexedDB, forever, with nothing ever pruning it. Left running for weeks
 * on a machine that's on all day, that's a multi-GB (confirmed: tens of GB)
 * unbounded leak. This is the missing other half of that write path.
 */
export async function pruneBackups(keepCount: number): Promise<number> {
  const all = await listBackups(); // already sorted newest-first
  const toDelete = all.slice(keepCount);
  await Promise.all(toDelete.map((b) => deleteBackup(b.key)));
  return toDelete.length;
}

/** Every key currently in a store, for a one-time cleanup sweep. */
export async function clearStore(storeName: string): Promise<number> {
  const db = await getDB();
  const keys = await db.getAllKeys(storeName);
  await Promise.all(keys.map((k) => db.delete(storeName, k)));
  return keys.length;
}

