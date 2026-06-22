// ALWAYS use direct connection to bypass Vite proxy timeout issues
const BASE = (import.meta as any).env?.VITE_TALLY_PROXY || "http://localhost:3100";

export interface TallySyncResult {
  success: boolean;
  error?: string;
  errors?: string[];
  masters: { tallymessage: any[] };
  transactions: { tallymessage: any[] };
  stats: { stockGroups: number; units: number; stockItems: number; ledgers: number; godowns: number; costCentres: number; vouchers: number; elapsedSeconds: number };
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
  // 90 MINUTE timeout — weekly full-FY can take 60+ min
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_400_000);

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
      stockGroups: j.stats?.stockGroups,
      units: j.stats?.units,
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
      throw new Error("Sync timed out after 90 minutes. Try narrowing the date range or using weekly mode.");
    }
    throw e;
  }
}


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

export function subscribeToProgress(onLog: (msg: string) => void): () => void {
  const es = new EventSource(`${BASE}/api/tally/progress`);
  es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      onLog(msg);
    } catch {
      onLog(e.data);
    }
  };
  es.onerror = () => {
    // Silently reconnect — EventSource handles this automatically
  };
  return () => es.close();
}

// ── Voucher Push ──────────────────────────────────────────────────────────────

export interface PushResult {
  success: boolean;
  created: number;
  errors: number;
  lastVoucherId: string | null;
  lineErrors: string[];
  rawResponse: string;
}

export async function pushVoucher(payload: { company: string; voucher: any }): Promise<PushResult> {
  try {
    const r = await fetch(`${BASE}/api/tally/push-voucher`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const text = await r.text();
      return { success: false, created: 0, errors: 1, lastVoucherId: null, lineErrors: [`HTTP ${r.status}: ${text}`], rawResponse: text };
    }
    return await r.json();
  } catch (e: any) {
    return { success: false, created: 0, errors: 1, lastVoucherId: null, lineErrors: [e.message], rawResponse: "" };
  }
}

export async function pushVoucherBatch(payload: { company: string; vouchers: any[] }): Promise<{
  results: PushResult[];
  successCount: number;
  errorCount: number;
}> {
  try {
    const r = await fetch(`${BASE}/api/tally/push-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`Server error: ${r.status}`);
    return await r.json();
  } catch (e: any) {
    throw e;
  }
}

// ── Push-test: build + push a voucher from simple form inputs ────────────────

export interface PushTestRequest {
  company: string;
  voucherType: "Sales" | "Purchase" | "Delivery Note";
  date: string;               // YYYY-MM-DD
  partyName: string;
  ledgerName: string;         // sales/purchase account (not needed for Delivery Note)
  items: { name: string; qty: number; unit: string; rate: number }[];
  voucherNumber?: string;
  narration?: string;
  dryRun?: boolean;
}

export interface PushTestResult extends PushResult {
  dryRun?: boolean;
  sentXml?: string;
  payload?: any;
  error?: string;
}

export async function pushTest(req: PushTestRequest): Promise<PushTestResult> {
  try {
    const r = await fetch(`${BASE}/api/tally/push-test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!r.ok) {
      const text = await r.text();
      return { success: false, created: 0, errors: 1, lastVoucherId: null, lineErrors: [`HTTP ${r.status}: ${text}`], rawResponse: text };
    }
    return await r.json();
  } catch (e: any) {
    return { success: false, created: 0, errors: 1, lastVoucherId: null, lineErrors: [e.message], rawResponse: "" };
  }
}

// ── Company detection ─────────────────────────────────────────────────────────

export async function detectCompany(): Promise<{ success: boolean; companies: { name: string }[]; current: string | null }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const r = await fetch(`${BASE}/api/tally/company`, { signal: ctrl.signal });
    clearTimeout(timer);
    return r.json();
  } catch {
    return { success: false, companies: [], current: null };
  }
}
