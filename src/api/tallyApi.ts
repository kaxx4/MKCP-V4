const PROXY_BASE = (import.meta as any).env?.DEV ? "" : ((import.meta as any).env?.VITE_TALLY_PROXY || "http://localhost:3100");

export interface TallyHealthStatus {
  connected: boolean;
  error?: string;
  tallyUrl: string;
}

export interface TallySyncResult {
  masters: { tallymessage: any[] };
  transactions: { tallymessage: any[] };
  stats: {
    stockItems: number;
    ledgers: number;
    vouchers: number;
    elapsedSeconds: number;
  };
}

export async function checkTallyHealth(): Promise<TallyHealthStatus> {
  try {
    const res = await fetch(`${PROXY_BASE}/api/tally/health`, { signal: AbortSignal.timeout(5000) });
    return await res.json();
  } catch {
    return { connected: false, error: "Proxy server not reachable at " + PROXY_BASE, tallyUrl: "" };
  }
}

export async function fetchCompanyInfo(): Promise<any> {
  const res = await fetch(`${PROXY_BASE}/api/tally/company`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error);
  return json.data;
}

export async function fetchMasters(company: string): Promise<{ tallymessage: any[] }> {
  const res = await fetch(`${PROXY_BASE}/api/tally/masters?company=${encodeURIComponent(company)}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error);
  return json.data;
}

export async function fetchVouchers(
  company: string,
  fromDate?: string,
  toDate?: string
): Promise<{ tallymessage: any[] }> {
  const params = new URLSearchParams({ company });
  if (fromDate) params.set("from", fromDate);
  if (toDate) params.set("to", toDate);

  const res = await fetch(`${PROXY_BASE}/api/tally/vouchers?${params}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error);
  return json.data;
}

export async function fullSync(
  company: string,
  fromDate?: string,
  toDate?: string
): Promise<TallySyncResult> {
  const res = await fetch(`${PROXY_BASE}/api/tally/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ company, fromDate, toDate }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error);
  return json;
}

export async function pushVoucher(company: string, voucherXml: string): Promise<any> {
  const res = await fetch(`${PROXY_BASE}/api/tally/push/voucher`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ company, voucherXml }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error);
  return json.result;
}
