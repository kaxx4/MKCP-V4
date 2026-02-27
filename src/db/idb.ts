import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "mkcycles-db";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("parsedData")) {
          db.createObjectStore("parsedData");
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
