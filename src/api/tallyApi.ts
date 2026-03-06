// ALWAYS use direct connection to bypass Vite proxy timeout issues
const BASE = (import.meta as any).env?.VITE_TALLY_PROXY || "http://localhost:3100";

export interface TallySyncResult {
  success: boolean;
  error?: string;
  errors?: string[];
  masters: { tallymessage: any[] };
  transactions: { tallymessage: any[] };
  stats: { stockItems: number; ledgers: number; vouchers: number; elapsedSeconds: number };
}

export async function checkTallyHealth(): Promise<{ connected: boolean; error?: string; tallyUrl: string }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`${BASE}/api/tally/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    return r.json();
  } catch {
    return { connected: false, error: "Proxy not reachable", tallyUrl: "" };
  }
}

export async function fullSync(company: string, fromDate?: string, toDate?: string): Promise<TallySyncResult> {
  // 10 MINUTE timeout — large companies need this
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 600_000);

  try {
    console.log(`[fullSync] Starting sync request for "${company}" (${fromDate} → ${toDate})`);
    const r = await fetch(`${BASE}/api/tally/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company, fromDate, toDate }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    console.log(`[fullSync] Response received: status=${r.status} ok=${r.ok}`);

    if (!r.ok) {
      const text = await r.text();
      console.error(`[fullSync] Non-OK response:`, text);
      throw new Error(`Server error: ${r.status} ${r.statusText}`);
    }

    const j = await r.json();
    console.log(`[fullSync] Response parsed successfully:`, {
      success: j.success,
      stockItems: j.stats?.stockItems,
      ledgers: j.stats?.ledgers,
      vouchers: j.stats?.vouchers
    });

    if (!j.success && j.error && !j.masters) throw new Error(j.error);
    return j;
  } catch (e: any) {
    clearTimeout(timer);
    console.error(`[fullSync] Error:`, e);
    if (e.name === "AbortError") {
      throw new Error("Sync timed out after 10 minutes. Try narrowing the date range (e.g., 6 months instead of full year).");
    }
    throw e;
  }
}

export interface MastersSyncResult {
  success: boolean;
  errors?: string[];
  data: { tallymessage: any[] };
  stats: { stockItems: number; ledgers: number; elapsedSeconds: number };
}

export interface DayBookSyncResult {
  success: boolean;
  error?: string;
  data: { tallymessage: any[] };
  stats: { vouchers: number; fromDate: string; toDate: string; elapsedSeconds: number };
}

export async function syncMasters(company: string): Promise<MastersSyncResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300_000); // 5 min
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
    if (e.name === "AbortError") throw new Error("Masters sync timed out (5 min)");
    throw e;
  }
}

export async function syncDayBook(company: string, fromDate: string, toDate: string): Promise<DayBookSyncResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 600_000); // 10 min
  try {
    const r = await fetch(`${BASE}/api/tally/sync-daybook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company, fromDate, toDate }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`Server error: ${r.status}`);
    return await r.json();
  } catch (e: any) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error("Day Book sync timed out (10 min). Try a shorter period.");
    throw e;
  }
}
