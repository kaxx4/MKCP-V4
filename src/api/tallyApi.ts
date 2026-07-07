// ALWAYS use direct connection to bypass Vite proxy timeout issues
const BASE = (import.meta as any).env?.VITE_TALLY_PROXY || "http://localhost:3100";

export interface MastersSyncResult {
  success: boolean;
  errors?: string[];
  data: { tallymessage: any[] };
  stats: { stockGroups: number; units: number; stockItems: number; ledgers: number; godowns: number; costCentres: number; elapsedSeconds: number };
}

export interface DayBookSyncResult {
  success: boolean;
  error?: string;
  errors?: string[];
  data: { tallymessage: any[] };
  stats: {
    vouchers: number;
    fromDate: string;
    toDate: string;
    chunksTotal: number;
    chunksSucceeded: number;
    chunksFailed: number;
    chunkDetails?: { label: string; count: number; ms: number }[];
    elapsedSeconds: number;
  };
}

export async function syncMasters(company: string): Promise<MastersSyncResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1_200_000); // 20 min — stock items XML can be very large
  try {
    const r = await fetch(`${BASE}/api/tally/sync-masters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`Server error: ${r.status}`);
    return await r.json();
  } catch (e: any) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error("Masters sync timed out (20 min)");
    throw e;
  }
}

export async function syncDayBook(company: string, fromDate: string, toDate: string, chunkMode: "smart" | "monthly" | "daily" | "weekly" = "smart"): Promise<DayBookSyncResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_400_000); // 90 min — weekly full-FY can take 60+ min
  try {
    const r = await fetch(`${BASE}/api/tally/sync-daybook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company, fromDate, toDate, chunkMode }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`Server error: ${r.status}`);
    return await r.json();
  } catch (e: any) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error("Day Book sync timed out (90 min). Try a shorter period.");
    throw e;
  }
}

/**
 * Fetch vouchers edited in Tally since a given AlterID watermark (any date).
 * Catches edits to OLD vouchers the date-windowed daybook pull misses. Returns
 * the same `{ data: { tallymessage } }` shape as syncDayBook so the result feeds
 * straight into parseTransactions. Best-effort: errors resolve to an empty set.
 */
export async function fetchChangedVouchers(
  company: string,
  sinceAlterId: number
): Promise<{ success: boolean; data?: { tallymessage: any[] }; error?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_400_000);
  try {
    const r = await fetch(`${BASE}/api/tally/changed-vouchers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company, sinceAlterId }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`Server error: ${r.status}`);
    return await r.json();
  } catch (e: any) {
    clearTimeout(timer);
    return { success: false, error: e?.message || String(e) };
  }
}
