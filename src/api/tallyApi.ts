const BASE = import.meta.env.DEV ? "" : (import.meta.env.VITE_TALLY_PROXY || "http://localhost:3100");

export interface TallySyncResult {
  success: boolean;
  error?: string;
  masters: { tallymessage: any[] };
  transactions: { tallymessage: any[] };
  stats: { stockItems: number; ledgers: number; vouchers: number; elapsedSeconds: number };
}

export async function checkTallyHealth(): Promise<{ connected: boolean; error?: string; tallyUrl: string }> {
  try {
    const r = await fetch(`${BASE}/api/tally/health`, { signal: AbortSignal.timeout(5000) });
    return r.json();
  } catch {
    return { connected: false, error: "Proxy not reachable", tallyUrl: "" };
  }
}

export async function getCompanies(): Promise<any[]> {
  const r = await fetch(`${BASE}/api/tally/company`);
  const j = await r.json();
  if (!j.success) throw new Error(j.error);
  return j.data;
}

export async function fullSync(company: string, fromDate?: string, toDate?: string): Promise<TallySyncResult> {
  const r = await fetch(`${BASE}/api/tally/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ company, fromDate, toDate }),
  });
  const j = await r.json();
  if (!j.success && j.error && !j.masters) throw new Error(j.error);
  return j;
}
