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
    /** Days (YYYYMMDD) whose single-day chunk succeeded AND were actually pruned
     *  server-side — same list the server used for its own per-day Supabase
     *  prune. Only present for the daily strategy and only when the upload
     *  succeeded. The client uses this to clear its local copy of exactly the
     *  same days, instead of gating on the whole range being clean. */
    succeededDays?: string[];
    /** Whether the server's own Supabase vouchers upload+prune actually succeeded.
     *  This is now the only voucher-push confirmation the client gets. */
    vouchersUploadOk?: boolean;
    elapsedSeconds: number;
  };
}

/**
 * @param origin Who triggered this sync — "manual" (default, server-side) or
 *   "scheduled-<label>" (e.g. "scheduled-today"). Purely for log labeling
 *   (see server's [SYNC] origin= lines) — never affects sync behavior.
 */
export async function syncMasters(company: string, origin?: string): Promise<MastersSyncResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1_200_000); // 20 min — stock items XML can be very large
  try {
    const r = await fetch(`${BASE}/api/tally/sync-masters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company, origin }),
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

/** @param origin see {@link syncMasters} */
export async function syncDayBook(company: string, fromDate: string, toDate: string, chunkMode: "smart" | "monthly" | "daily" | "weekly" = "smart", origin?: string): Promise<DayBookSyncResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_400_000); // 90 min — weekly full-FY can take 60+ min
  try {
    const r = await fetch(`${BASE}/api/tally/sync-daybook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company, fromDate, toDate, chunkMode, origin }),
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
