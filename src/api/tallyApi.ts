const BASE = (import.meta as any).env?.DEV ? "" : ((import.meta as any).env?.VITE_TALLY_PROXY || "http://localhost:3100");

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
    const r = await fetch(`${BASE}/api/tally/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company, fromDate, toDate }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const j = await r.json();
    if (!j.success && j.error && !j.masters) throw new Error(j.error);
    return j;
  } catch (e: any) {
    clearTimeout(timer);
    if (e.name === "AbortError") {
      throw new Error("Sync timed out after 10 minutes. Try narrowing the date range (e.g., 6 months instead of full year).");
    }
    throw e;
  }
}
