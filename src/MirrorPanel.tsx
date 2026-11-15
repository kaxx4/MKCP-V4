import { SERVER_BASE } from "./config/serverUrl";
/**
 * Sync history, mirror snapshot and the push log — on the agent itself.
 *
 * The web dashboard has all three. This machine is the one doing the work, and
 * it had counters ("Pending 4, Failed 1") plus a console log. So the screen in
 * the office could say a push had failed but not WHICH voucher, for which
 * party, or why — and the person standing in front of it had to open the web
 * app on another device to find out. See server/src/services/mirrorPanel.ts.
 *
 * The refusal text is shown in full and never truncated. Each one names the
 * thing to fix — a ledger Tally spells differently, a filed GST period — and
 * the reason is the only useful part of it.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Database, History, ArrowUpRight, RefreshCw, Check, AlertTriangle, Loader2, Minus, Clock, PenLine,
} from "lucide-react";

/* The edit-log action chips. These are CATEGORIES, not states, so only the one that carries real meaning keeps a status colour. */
const ACTION_TONE: Record<string, string> = {
  upsert: "bg-accent-soft text-accent-700",
  delete: "bg-danger-soft text-danger-700",
  export: "bg-neutral-100 text-neutral-700",
  import: "bg-neutral-100 text-neutral-700",
};

const BASE = SERVER_BASE;

interface SyncRun {
  startedAt: string; completedAt: string | null; syncType: string | null;
  success: boolean; counts: Record<string, number> | null; errors: string[] | null; full: boolean;
}
interface Snapshot { table: string; rows: number | null; newest: string | null }
interface PushRow {
  id: string; status: string; voucherType: string; voucherNumber: string; party: string;
  amount: number; attempts: number; lastError: string | null;
  createdAt: string; claimedAt: string | null; pushedAt: string | null; waitedSeconds: number | null;
}
interface EditRow {
  id: number; at: string; who: string; domain: string; table: string; action: string; count: number | null;
}
interface WhoAmI {
  app?: string; version?: string; pid?: number; startedAt?: string;
  role?: string | null; pushAgentEnabledEnv?: boolean; hasSupabaseKey?: boolean;
}

interface Panel {
  company: string; offline: boolean; syncs: SyncRun[]; lastFullSyncAt: string | null;
  snapshot: Snapshot[]; pushes: PushRow[]; edits: EditRow[];
  pushLatency: { count: number; pickupMedian: number | null; inTallyMedian: number | null; inTallySlowest: number | null };
  error?: string;
}

const n = (v: number | null | undefined) =>
  v == null ? "not known" : v.toLocaleString("en-IN");

const when = (iso: string | null): string => {
  if (!iso) return "not recorded";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
};

/* Semantic tokens only: "failed" here must be the same red as "failed" everywhere else on this screen. */
const TONE: Record<string, string> = {
  succeeded: "text-success-700", pending: "text-accent-700", claimed: "text-accent-700",
  pushing: "text-accent-700", failed: "text-danger-700", cancelled: "text-neutral-700",
};
const STATUS_WORD: Record<string, string> = {
  succeeded: "done", pending: "waiting", claimed: "picked up", pushing: "being sent", failed: "refused", cancelled: "cancelled",
};
const ACTION_WORD: Record<string, string> = { upsert: "saved", delete: "deleted", export: "exported", import: "imported" };

declare const __APP_VERSION__: string;

/**
 * Is the server on this computer's port actually OURS? It can be a leftover copy from an earlier session or a second copy of the app. When it
 * is, this app's own server never starts, and every screen here talks to an older copy that was started with a different setup.
 */
function StaleServerBanner({ who, reachable }: { who: WhoAmI | null; reachable: boolean }) {
  const mine = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : null;
  const theirs = who?.version;
  /* Only when we can actually TELL. An older server has no /api/whoami at all, which is itself the signal. A network blip is not. */
  const mismatch = reachable && (!who || (!!mine && !!theirs && theirs !== mine && theirs !== "unknown"));
  if (!mismatch) return null;

  return (
    <div className="note note-warn">
      <AlertTriangle size={16} className="mt-1 shrink-0" />
      <div>
        <p className="font-medium">
          Another copy of this program is already running on this computer. This window is talking to that copy, not to its own.
        </p>
        <p className="mt-1">
          {who?.version
            ? <>That copy is version <b>{who.version}</b>{who.startedAt ? <>, started {new Date(who.startedAt).toLocaleString("en-IN")}</> : null}.
                This window is version <b>{mine}</b>.</>
            : <>It is too old to say which version it is.</>}
        </p>
        <p className="mt-1">
          Everything on this screen comes from that copy, and it was started with whatever settings existed then. Close the other copy, then
          close and open this app again.
        </p>
      </div>
    </div>
  );
}

/** One block of the mirror: a white card with a quiet header and a body. Not collapsible: the page already has a panel around the whole mirror. */
function Block({ icon, title, aside, children, action }: { icon: React.ReactNode; title: string; aside?: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="flex min-h-11 items-center gap-3 px-4 py-2">
        <span className="text-neutral-700">{icon}</span>
        <h2 className="panel-title">{title}</h2>
        {aside && <span className="text-xs text-neutral-700">{aside}</span>}
        {action}
      </div>
      <div className="px-4 pb-4">{children}</div>
    </section>
  );
}

interface MirrorProps {
  /** True only on a machine where office mode is off. The queue timing and the push log describe the old push queue, which nothing feeds after go-live. */
  showOldQueue?: boolean;
}

export function MirrorPanel({ showOldQueue = true }: MirrorProps) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [who, setWho] = useState<WhoAmI | null>(null);
  const [reachable, setReachable] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      /* whoami FIRST, and separately: if the wrong copy is answering, that is the thing to say, and it explains whatever the panel does next. */
      try {
        const w = await fetch(`${BASE}/api/whoami`);
        setReachable(true);
        setWho(w.ok ? ((await w.json()) as WhoAmI) : null);
      } catch {
        setReachable(false);
        setWho(null);
      }
      const r = await fetch(`${BASE}/api/mirror/panel?limit=25`);
      setPanel(r.ok ? await r.json() : null);
    } catch {
      setPanel(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => { void load(); }, 15_000);
    return () => clearInterval(t);
  }, [load]);

  if (!panel) {
    return (
      <div className="space-y-4">
        <StaleServerBanner who={who} reachable={reachable} />
        <div className="rounded-lg bg-white px-4 py-3 text-sm text-neutral-700 shadow-card">
          {busy ? "Reading the online copy"
            : reachable
              ? "This app's server answered, but not with this panel. See the note above."
              : "This app's own server could not be reached."}
        </div>
      </div>
    );
  }

  if (panel.offline) {
    return (
      <div className="note note-warn">
        <AlertTriangle size={16} className="mt-1 shrink-0" />
        <span>The online database is not set up or cannot be reached from this computer, so there is nothing to read. {panel.error}</span>
      </div>
    );
  }

  const lat = panel.pushLatency;
  const refresh = (
    <button
      onClick={() => void load()}
      disabled={busy}
      className="btn-icon shrink-0"
      aria-label="Read the online copy again"
      title={busy ? "Reading the online copy" : "Read the online copy again now"}
    >
      <RefreshCw size={16} className={busy ? "animate-spin" : ""} />
    </button>
  );

  return (
    <div className="space-y-4">
      <StaleServerBanner who={who} reachable={reachable} />

      {showOldQueue && (
        <>
          {/* ── How fast a queued voucher reaches Tally (old push queue) ───── */}
          <Block icon={<Clock size={16} />} title="How fast the old queue reaches Tally" action={refresh}>
            <div className="text-sm text-neutral-700">
              {lat.count === 0 ? (
                <span>Nothing has been sent yet, so there is no timing to show.</span>
              ) : (
                <>
                  {/* TWO figures, never one: this app noticing a voucher and Tally importing it are different things with different remedies. */}
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    <span>
                      <span className="font-display text-2xl text-neutral-950">{lat.pickupMedian ?? "not known"} seconds</span>{" "}
                      to be noticed
                    </span>
                    <span>
                      <span className="font-display text-2xl text-neutral-950">{lat.inTallyMedian ?? "not known"} seconds</span>{" "}
                      inside Tally
                      <span className="text-neutral-700">
                        {lat.inTallySlowest != null ? `, slowest ${lat.inTallySlowest} seconds` : ""}. {lat.count} measured.
                      </span>
                    </span>
                  </div>
                  <p className="mt-2 text-xs">
                    Being noticed takes under a second. The rest is Tally taking in one voucher at a time, so a batch finishes in a line, not all at once.
                  </p>
                  {lat.pickupMedian != null && lat.pickupMedian > 6 && (
                    <p className="mt-2 text-warn-700">
                      Being noticed is slower than the 4-second check, which means the instant signal is not arriving and every voucher is waiting for the
                      next check.
                    </p>
                  )}
                </>
              )}
            </div>
          </Block>

          {/* ── Send log (old push queue) ──────────────────────────────────── */}
          <Block icon={<ArrowUpRight size={16} />} title="What the old queue has sent" aside={`${panel.pushes.length} most recent`}>
            {panel.pushes.length === 0 ? (
              <p className="text-sm text-neutral-700">Nothing has been queued yet.</p>
            ) : (
              <ul className="tray flex max-h-80 flex-col gap-2 overflow-auto">
                {panel.pushes.map((p) => (
                  <li key={p.id} className="rounded-md bg-white p-3 shadow-card">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium">{p.voucherType}</span>
                      <span className="text-sm text-neutral-700">{p.voucherNumber}</span>
                      <span className={`ml-auto inline-flex items-center gap-1 text-sm ${TONE[p.status] ?? "text-neutral-700"}`}>
                        {p.status === "succeeded" ? <Check size={16} />
                          : p.status === "failed" ? <AlertTriangle size={16} />
                          : p.status === "cancelled" ? <Minus size={16} />
                          : <Loader2 size={16} className="animate-spin" />}
                        {STATUS_WORD[p.status] ?? p.status}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm text-neutral-700 wrap-anywhere">{p.party}</span>
                      {p.amount > 0 && <span className="ml-auto text-sm tabular-nums text-neutral-900">₹{p.amount.toLocaleString("en-IN")}</span>}
                    </div>
                    <div className="mt-1 text-xs text-neutral-700">
                      Queued {when(p.createdAt)}
                      {p.waitedSeconds !== null && p.waitedSeconds >= 0 && `. Took ${p.waitedSeconds} seconds`}
                      {p.attempts > 1 && `. Tried ${p.attempts} times`}
                    </div>
                    {/* In full. Cutting a refusal short removes the only useful part. */}
                    {p.lastError && <p className="mt-2 rounded-sm bg-danger-soft px-3 py-2 text-xs text-danger-700 wrap-anywhere">{p.lastError}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Block>
        </>
      )}

      {/* ── Sync history ───────────────────────────────────────────────── */}
      <Block
        icon={<History size={16} />}
        title="Sync history"
        aside={`last whole-year read: ${panel.lastFullSyncAt ? when(panel.lastFullSyncAt) : "none on record"}`}
        action={showOldQueue ? undefined : refresh}
      >
        {/* A whole-year read is its own fact. Entries made for an earlier date are most of the work here and the small syncs only look at
            today, so a run of small successful syncs makes the copy look fresh while last week's orders quietly never arrive. */}
        <ul className="tray flex max-h-72 flex-col gap-2 overflow-auto">
          {panel.syncs.map((s, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-x-2 rounded-md bg-white p-3 text-sm shadow-card">
              <span className={s.success ? "text-success-700" : "text-danger-700"}>
                {s.success ? <Check size={16} /> : <AlertTriangle size={16} />}
              </span>
              <span className="font-medium capitalize">{s.syncType ?? "sync"}</span>
              {s.full && <span className="rounded-xs bg-accent-soft px-2 text-xs text-accent-700">whole year</span>}
              <span className="text-neutral-700 wrap-anywhere">
                {Object.entries(s.counts ?? {}).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${n(Number(v))} ${k.replace(/_/g, " ")}`).join(", ") || "nothing changed"}
              </span>
              <span className="ml-auto text-xs text-neutral-700">{when(s.startedAt)}</span>
            </li>
          ))}
        </ul>
      </Block>

      {/* ── Snapshot: the same figures, in the same shape, as the web Sync Logs page, so the two screens can be read against each other. ── */}
      <Block icon={<Database size={16} />} title="What the online database holds">
        <div className="tray grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {panel.snapshot.map((s) => (
            <div key={s.table} className="rounded-md bg-white p-3 shadow-card">
              <div className="text-xs text-neutral-700 wrap-anywhere">{s.table.replace(/^tally_/, "").replace(/_/g, " ")}</div>
              <div className="font-display text-2xl tabular-nums text-neutral-950">{n(s.rows)}</div>
              {s.newest && <div className="text-xs text-neutral-700">up to {s.newest}</div>}
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-neutral-700">
          "Not known" means that list could not be read, which is not the same as it being empty.
        </p>
      </Block>

      {/* ── Activity log: who changed what, from the same record the web page reads. The agent is the computer people stand in front of
          when something looks wrong, and "did someone change the discount rules?" is one of the first questions. ── */}
      <Block icon={<PenLine size={16} />} title="Who changed what" aside={`${panel.edits.length} most recent`}>
        {panel.edits.length === 0 ? (
          <p className="text-sm text-neutral-700">Nothing has been recorded yet.</p>
        ) : (
          <ul className="tray flex max-h-72 flex-col gap-2 overflow-auto">
            {panel.edits.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-x-2 rounded-md bg-white p-3 text-sm shadow-card">
                <span className={`rounded-xs px-2 text-xs ${ACTION_TONE[e.action] ?? "bg-neutral-100 text-neutral-700"}`}>
                  {ACTION_WORD[e.action] ?? e.action}
                </span>
                <span className="font-medium wrap-anywhere">{e.domain}</span>
                {e.count != null && <span className="text-neutral-700">{e.count} rows</span>}
                <span className="text-neutral-700 wrap-anywhere">{e.who}</span>
                <span className="ml-auto text-xs text-neutral-700">{when(e.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Block>
    </div>
  );
}
