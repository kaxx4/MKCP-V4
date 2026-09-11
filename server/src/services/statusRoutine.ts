/**
 * The check that runs on a trigger (or hourly) and answers one question:
 * "is everything actually fine?"
 *
 * It exists because this system's signature failure is that nothing ever looks
 * broken. A sync that silently stops looks like a quiet week. A prune that
 * deleted a year completed before anything reported a failure. A push queue that
 * can't insert a row looks like nobody queued anything. So rather than waiting
 * for an error, this counts both sides and reports the gap.
 *
 * Every number here is derived live. Nothing is stored and read back as truth.
 */
import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { tallyPost, HEALTH_XML } from "../tally.js";
import { convertCompanies } from "../converters/convert.js";
import { reconcile, type ReconcileReport } from "./reconcile.js";

export type Severity = "ok" | "watch" | "alert";

export interface Finding {
  severity: Severity;
  area: string;
  message: string;
  /** What to do about it, when there is something to do. */
  action?: string;
}

export interface StatusReport {
  checkedAt: string;
  company: string | null;
  tallyReachable: boolean;
  findings: Finding[];
  /** Highest severity present — what a status light should show. */
  overall: Severity;
  numbers: {
    tallyAlterId: number | null;
    lastSyncAgeMinutes: number | null;
    vouchersLast7Days: number | null;
    supabaseLast7Days: number | null;
    pushQueuePending: number | null;
    pushQueueFailed: number | null;
    capturesAwaiting: number | null;
  };
  reconciliation?: ReconcileReport;
}

const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const num = (s: string | undefined) => { const n = parseInt(String(s ?? "").replace(/[^\d-]/g, ""), 10); return Number.isFinite(n) ? n : null; };

function supa(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Tally's monotonic alteration id — any edit anywhere bumps it. */
async function readAlterId(tallyUrl: string, company: string): Promise<number | null> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkAlterId</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${escXml(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkAlterId" ISMODIFY="No"><TYPE>Company</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>AltVchId</NATIVEMETHOD>
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  try {
    const resp: string = await tallyPost(tallyUrl, xml, 30_000, true);
    return num(/<ALTVCHID[^>]*>([^<]*)<\/ALTVCHID>/.exec(resp)?.[1]);
  } catch { return null; }
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function runStatusCheck(
  tallyUrl: string,
  opts: { reconcileDays?: number } = {}
): Promise<StatusReport> {
  const reconcileDays = opts.reconcileDays ?? 7;
  const findings: Finding[] = [];
  const numbers: StatusReport["numbers"] = {
    tallyAlterId: null, lastSyncAgeMinutes: null, vouchersLast7Days: null,
    supabaseLast7Days: null, pushQueuePending: null, pushQueueFailed: null, capturesAwaiting: null,
  };

  // ── 1. Is Tally even there? Everything else depends on it. ────────────────
  let company: string | null = null;
  let tallyReachable = false;
  try {
    company = convertCompanies(await tallyPost(tallyUrl, HEALTH_XML, 10_000))[0]?.name ?? null;
    tallyReachable = !!company;
  } catch (e) {
    findings.push({
      severity: "alert", area: "Tally",
      message: `Tally is not responding on ${tallyUrl} — ${(e as Error).message}`,
      action: "Check TallyPrime is running with the XML port open. An error dialog also blocks the port until the application is restarted.",
    });
  }
  if (!company && tallyReachable === false && findings.length === 0) {
    findings.push({ severity: "alert", area: "Tally", message: "No company is loaded in Tally." });
  }

  if (company) {
    numbers.tallyAlterId = await readAlterId(tallyUrl, company);
  }

  const client = supa();
  if (!client) {
    findings.push({
      severity: "watch", area: "Supabase",
      message: "Supabase credentials are not configured, so nothing downstream could be checked.",
    });
  }

  // ── 2. Is the sync still running? Silence is the failure mode here. ───────
  if (client && company) {
    const { data: lastSync } = await client
      .from("tally_sync_history")
      .select("started_at, success, errors")
      .eq("company", company)
      .order("started_at", { ascending: false })
      .limit(20);

    if (!lastSync?.length) {
      findings.push({ severity: "alert", area: "Sync", message: "No sync history at all for this company." });
    } else {
      const ageMin = Math.round((Date.now() - new Date(lastSync[0].started_at as string).getTime()) / 60_000);
      numbers.lastSyncAgeMinutes = ageMin;
      if (ageMin > 24 * 60) {
        findings.push({
          severity: "alert", area: "Sync",
          message: `The last sync was ${Math.round(ageMin / 60)} hours ago.`,
          action: "Check the desktop agent is running. Staleness is indistinguishable from a quiet day on the dashboard.",
        });
      } else if (ageMin > 180) {
        findings.push({ severity: "watch", area: "Sync", message: `The last sync was ${Math.round(ageMin / 60)} hours ago.` });
      }

      // Consecutive failures are the shape the September incident took — the
      // damage was already done by the time anything reported a failure.
      let consecutive = 0;
      for (const row of lastSync) { if (row.success) break; consecutive++; }
      if (consecutive >= 3) {
        findings.push({
          severity: "alert", area: "Sync",
          message: `${consecutive} consecutive sync failures, most recent first.`,
          action: "Do not let this retry unattended — repeated empty pulls are what preceded the September data loss.",
        });
      } else if (consecutive > 0) {
        findings.push({ severity: "watch", area: "Sync", message: `${consecutive} recent sync failure(s).` });
      }
    }
  }

  // ── 3. Does Tally agree with Supabase? ───────────────────────────────────
  let reconciliation: ReconcileReport | undefined;
  if (client && company) {
    const to = new Date(), from = new Date(to.getTime() - reconcileDays * 86_400_000);
    try {
      reconciliation = await reconcile(tallyUrl, company, iso(from), iso(to));
      numbers.vouchersLast7Days = reconciliation.tallyTotal;
      numbers.supabaseLast7Days = reconciliation.supabaseTotal;

      // Today is expected to differ — the agent has not necessarily synced it yet.
      const todayIso = iso(new Date());
      const historic = reconciliation.mismatches.filter(m => m.date !== todayIso);
      const missing = historic.filter(m => m.tally > m.supabase);

      if (missing.length) {
        const total = missing.reduce((s, m) => s + (m.tally - m.supabase), 0);
        findings.push({
          severity: "alert", area: "Reconciliation",
          message: `${total} voucher(s) exist in Tally but not in Supabase across ${missing.length} day/type bucket(s).`,
          action: `Oldest gap: ${missing[0].date} ${missing[0].voucherType}. Run an AlterID sweep rather than a date-window sync — backdated entries fall outside every window.`,
        });
      } else if (historic.length) {
        findings.push({
          severity: "watch", area: "Reconciliation",
          message: `${historic.length} bucket(s) have more rows downstream than in Tally — likely deleted in Tally without being pruned downstream.`,
        });
      } else {
        findings.push({
          severity: "ok", area: "Reconciliation",
          message: `Tally and Supabase agree across the last ${reconcileDays} days (${reconciliation.tallyTotal} vouchers).`,
        });
      }
    } catch (e) {
      findings.push({ severity: "watch", area: "Reconciliation", message: `Could not reconcile: ${(e as Error).message}` });
    }
  }

  // ── 4. Is anything queued and going nowhere? ─────────────────────────────
  if (client) {
    const { data: pending } = await client.from("push_queue").select("id, status").in("status", ["pending", "failed"]);
    if (pending) {
      numbers.pushQueuePending = pending.filter(r => r.status === "pending").length;
      numbers.pushQueueFailed = pending.filter(r => r.status === "failed").length;
      if (numbers.pushQueueFailed > 0) {
        findings.push({
          severity: "alert", area: "Push queue",
          message: `${numbers.pushQueueFailed} voucher(s) failed to push.`,
          action: "Read the stored response before requeueing — an exception is structural and a blind retry risks a duplicate.",
        });
      }
      if (numbers.pushQueuePending > 0) {
        findings.push({ severity: "watch", area: "Push queue", message: `${numbers.pushQueuePending} voucher(s) waiting to be pushed.` });
      }
    }

    const { data: caps } = await client.from("purchase_captures").select("id, status").in("status", ["new", "read"]);
    if (caps) {
      numbers.capturesAwaiting = caps.length;
      if (caps.length > 0) {
        findings.push({ severity: "watch", area: "Captures", message: `${caps.length} photographed bill(s) awaiting review.` });
      }
    }
  }

  if (!findings.some(f => f.severity !== "ok")) {
    findings.unshift({ severity: "ok", area: "Overall", message: "Everything checked is in order." });
  }

  const overall: Severity = findings.some(f => f.severity === "alert") ? "alert"
    : findings.some(f => f.severity === "watch") ? "watch" : "ok";

  return { checkedAt: new Date().toISOString(), company, tallyReachable, findings, overall, numbers, reconciliation };
}

/** Human-readable summary — what a trigger reports back. */
export function formatStatus(r: StatusReport): string {
  const icon = { ok: "✓", watch: "!", alert: "✗" };
  const lines = [
    `${icon[r.overall]} ${r.overall.toUpperCase()} — ${r.company ?? "no company"} — ${new Date(r.checkedAt).toLocaleString()}`,
    "",
  ];
  for (const f of r.findings) {
    lines.push(`${icon[f.severity]} ${f.area}: ${f.message}`);
    if (f.action) lines.push(`    → ${f.action}`);
  }
  const n = r.numbers;
  lines.push("", "Numbers:");
  if (n.lastSyncAgeMinutes !== null) lines.push(`  last sync         ${n.lastSyncAgeMinutes} min ago`);
  if (n.vouchersLast7Days !== null) lines.push(`  vouchers (7d)     Tally ${n.vouchersLast7Days} / Supabase ${n.supabaseLast7Days}`);
  if (n.tallyAlterId !== null) lines.push(`  Tally AlterID     ${n.tallyAlterId}`);
  if (n.pushQueuePending !== null) lines.push(`  push queue        ${n.pushQueuePending} pending, ${n.pushQueueFailed} failed`);
  if (n.capturesAwaiting !== null) lines.push(`  captures          ${n.capturesAwaiting} awaiting review`);
  return lines.join("\n");
}
