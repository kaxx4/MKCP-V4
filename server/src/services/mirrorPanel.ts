/**
 * What the desktop agent can tell you about the mirror, without opening a browser.
 *
 * ── Why the agent needs its own copy of this ──────────────────────────────
 *
 * The web dashboard has sync logs, a data snapshot and a per-voucher push log.
 * The agent — the machine that is actually doing all of it — had counters:
 * "Pending 4, Pushing 0, Failed 1", and a local console log. So the one screen
 * open in the office could tell you a push had failed but not which voucher,
 * for which party, or why; and the operator standing in front of it had to open
 * the web app on another device to find out.
 *
 * That is backwards. The agent is where the work happens and where somebody
 * looks when it stops.
 *
 * ── Three questions, three shapes ─────────────────────────────────────────
 *
 * SYNC HISTORY — what has been pulled, when, and whether it worked. Including
 * the distinction the web app learned the hard way: a run that touched a
 * handful of rows is not the same as a full sweep, and a stream of the former
 * makes a mirror look fresh while backdated entries pile up unseen.
 *
 * SNAPSHOT — what is actually on file, per table. The plainest possible answer
 * to "is the mirror populated", which until now could only be had with SQL.
 *
 * PUSH LOG — per voucher: type, number, party, amount, how long it waited, and
 * the refusal in full. The refusal is the whole point — each one names the
 * thing to fix, and a count cannot.
 */
import { supabaseClient } from "./supabaseClient.js";

/** A sync wide enough to have re-read days that were already synced. */
const FULL_SYNC_MIN_VOUCHERS = 500;

export interface SyncRun {
  startedAt: string;
  completedAt: string | null;
  syncType: string | null;
  success: boolean;
  counts: Record<string, number> | null;
  errors: string[] | null;
  /** True when this run touched enough rows to count as a full sweep. */
  full: boolean;
}

export interface MirrorSnapshot {
  table: string;
  rows: number | null;
  /** Null when the table carries no date column worth reporting. */
  newest: string | null;
}

export interface PushLogRow {
  id: string;
  status: string;
  voucherType: string;
  voucherNumber: string;
  party: string;
  amount: number;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  claimedAt: string | null;
  pushedAt: string | null;
  /**
   * Seconds from queued to pushed.
   *
   * Meaningful only because both stamps now come from the database clock — the
   * agent used to write `pushed_at` from its own, and the difference across two
   * clocks is a duration plus an unknown skew. It read NEGATIVE on real rows.
   */
  waitedSeconds: number | null;
}

export interface EditLogRow {
  id: number;
  at: string;
  who: string;
  domain: string;
  table: string;
  action: string;
  count: number | null;
}

export interface MirrorPanel {
  company: string;
  offline: boolean;
  syncs: SyncRun[];
  lastFullSyncAt: string | null;
  snapshot: MirrorSnapshot[];
  pushes: PushLogRow[];
  /**
   * The two legs, never blended.
   *
   * `pickup` is queued → claimed: how long before the agent NOTICED. That is
   * the app's own responsiveness and it is sub-second, because the agent
   * subscribes to `push_queue` inserts and the 4-second poll is only a
   * guarantee behind it.
   *
   * `inTally` is claimed → pushed: Tally importing the voucher, roughly eight
   * seconds each and SERIALISED, because Tally's XML port is single-threaded.
   * Six vouchers claimed in the same instant finished 9, 18 and 25 seconds
   * apart.
   *
   * One blended number reads as "the app took 25 seconds" when the app took
   * half of one — which is how I first mis-read this myself, from a single row.
   */
  pushLatency: {
    count: number;
    pickupMedian: number | null;
    inTallyMedian: number | null;
    inTallySlowest: number | null;
  };
  /** Who changed what — the same `config_edit_log` the web Activity Log reads. */
  edits: EditLogRow[];
}

const MIRROR_TABLES: { table: string; dateColumn?: string }[] = [
  { table: "tally_vouchers", dateColumn: "date" },
  { table: "tally_voucher_ledger_entries" },
  { table: "tally_voucher_inventory_entries" },
  { table: "tally_ledgers" },
  { table: "tally_stock_items" },
  { table: "tally_price_list", dateColumn: "effective_from" },
  { table: "tally_gst_rates" },
];

function partyAmount(payload: any): number {
  const entries = payload?.ledgerEntries ?? [];
  const party = entries.find((e: any) => e?.isPartyLedger);
  return Math.abs(Number(party?.amount ?? 0));
}

export async function buildMirrorPanel(company: string, limit = 25): Promise<MirrorPanel> {
  const client = supabaseClient();
  if (!client) {
    return {
      company, offline: true, syncs: [], lastFullSyncAt: null,
      snapshot: [], pushes: [], edits: [],
      pushLatency: { count: 0, pickupMedian: null, inTallyMedian: null, inTallySlowest: null },
    };
  }

  /* ── Sync history ──────────────────────────────────────────────────── */
  const { data: syncRows } = await client
    .from("tally_sync_history")
    .select("started_at,completed_at,sync_type,success,row_counts,errors")
    .order("started_at", { ascending: false })
    .limit(limit);

  const syncs: SyncRun[] = (syncRows ?? []).map((r: any) => ({
    startedAt: r.started_at,
    completedAt: r.completed_at ?? null,
    syncType: r.sync_type ?? null,
    success: !!r.success,
    counts: r.row_counts ?? null,
    errors: r.errors ?? null,
    full: !!r.success && Number(r.row_counts?.vouchers ?? 0) >= FULL_SYNC_MIN_VOUCHERS,
  }));

  /* Asked for directly, not derived from the window above: a busy day writes
     120+ rows, so `limit` covers a few hours and the last full sweep is almost
     always older than that. Reading an empty window as an empty world is how
     the web app first shipped this banner saying "no full pull on record" on a
     mirror pulled twenty minutes earlier. */
  const { data: fullRows } = await client
    .from("tally_sync_history")
    .select("started_at,completed_at,row_counts")
    .eq("success", true)
    .gte("row_counts->>vouchers", String(FULL_SYNC_MIN_VOUCHERS))
    .order("started_at", { ascending: false })
    .limit(1);
  const fullRow = (fullRows ?? []).find(
    (r: any) => Number(r.row_counts?.vouchers ?? 0) >= FULL_SYNC_MIN_VOUCHERS,
  );

  /* ── Snapshot ──────────────────────────────────────────────────────── */
  const snapshot: MirrorSnapshot[] = await Promise.all(
    MIRROR_TABLES.map(async ({ table, dateColumn }) => {
      try {
        const { count } = await client
          .from(table)
          .select("*", { count: "exact", head: true })
          .eq("company", company);
        let newest: string | null = null;
        if (dateColumn) {
          const { data } = await client
            .from(table)
            .select(dateColumn)
            .eq("company", company)
            .order(dateColumn, { ascending: false })
            .limit(1);
          newest = (data?.[0] as any)?.[dateColumn] ?? null;
        }
        return { table, rows: count ?? 0, newest };
      } catch {
        /* A table that is not there yet reads as null, never as zero. "I could
           not look" and "there is nothing" are different facts (G7). */
        return { table, rows: null, newest: null };
      }
    }),
  );

  /* ── Push log ──────────────────────────────────────────────────────── */
  const { data: pushRows } = await client
    .from("push_queue")
    .select("id,status,payload,attempts,last_error,created_at,claimed_at,pushed_at")
    .eq("company", company)
    .order("created_at", { ascending: false })
    .limit(limit);

  const pushes: PushLogRow[] = (pushRows ?? []).map((r: any) => {
    const p = r.payload ?? {};
    const waited =
      r.pushed_at && r.created_at
        ? Math.round(((new Date(r.pushed_at).getTime() - new Date(r.created_at).getTime()) / 1000) * 10) / 10
        : null;
    return {
      id: String(r.id),
      status: r.status,
      voucherType: p.voucherType ?? "—",
      voucherNumber: p.voucherNumber ?? "—",
      party: p.partyLedgerName ?? "—",
      amount: partyAmount(p),
      attempts: Number(r.attempts ?? 0),
      lastError: r.last_error ?? null,
      createdAt: r.created_at,
      claimedAt: r.claimed_at ?? null,
      pushedAt: r.pushed_at ?? null,
      waitedSeconds: waited,
    };
  });

  /* Negative waits are dropped rather than averaged in: they are rows stamped
     before the database-clock trigger existed, and one of them drags a median
     somewhere impossible. */
  const med = (xs: number[]): number | null =>
    xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null;

  const secs = (from: string | null, to: string | null): number | null =>
    from && to ? Math.round(((new Date(to).getTime() - new Date(from).getTime()) / 1000) * 10) / 10 : null;

  const pickups = pushes
    .map((p) => secs(p.createdAt, p.claimedAt))
    .filter((n): n is number => n !== null && n >= 0);
  const inTally = pushes
    .map((p) => secs(p.claimedAt, p.pushedAt))
    .filter((n): n is number => n !== null && n >= 0);

  /* ── Edit log ──────────────────────────────────────────────────────── */
  const { data: editRows } = await client
    .from("config_edit_log")
    .select("id,created_at,actor,device_name,domain,table_name,action,entity_count")
    .eq("company", company)
    .order("created_at", { ascending: false })
    .limit(limit);

  const edits: EditLogRow[] = (editRows ?? []).map((r: any) => ({
    id: Number(r.id),
    at: r.created_at,
    /* The signed-in profile when there is one, otherwise the device. "Unknown"
       only when neither exists — which is itself worth seeing rather than
       hiding behind a blank. */
    who: r.actor || r.device_name || "Unknown",
    domain: r.domain ?? "—",
    table: r.table_name ?? "—",
    action: r.action ?? "—",
    count: r.entity_count == null ? null : Number(r.entity_count),
  }));

  return {
    company,
    offline: false,
    syncs,
    edits,
    lastFullSyncAt: fullRow ? (fullRow as any).completed_at ?? (fullRow as any).started_at : null,
    snapshot,
    pushes,
    pushLatency: {
      count: inTally.length,
      pickupMedian: med(pickups),
      inTallyMedian: med(inTally),
      inTallySlowest: inTally.length ? Math.max(...inTally) : null,
    },
  };
}
