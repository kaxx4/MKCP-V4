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

/* The edit-log action chips. These are CATEGORIES, not states — the word is
   already in the chip — so only the one that carries real meaning keeps a
   status colour. The old map spent four hues on them (`bg-purple-50`,
   `bg-amber-50`) and put `import` in the same amber this screen uses for
   "needs attention", so a routine import read as a warning. */
const ACTION_TONE: Record<string, string> = {
  upsert: "bg-accent/10 text-accent-700",
  delete: "bg-danger/10 text-danger-700",
  export: "bg-neutral-100 text-neutral-700",
  import: "bg-neutral-100 text-neutral-700",
};

const BASE = (import.meta as any).env?.VITE_TALLY_PROXY || "http://localhost:3100";

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
  v == null ? "—" : v.toLocaleString("en-IN");

const when = (iso: string | null): string => {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

/* Semantic tokens only — "failed" here must be the same red as "failed" in the
   push queue two panels up, and as "failed" in the web dashboard. */
const TONE: Record<string, string> = {
  succeeded: "text-success-700", pending: "text-accent-700", claimed: "text-accent-700",
  pushing: "text-accent-700", failed: "text-danger-700", cancelled: "text-neutral-400",
};

declare const __APP_VERSION__: string;

/**
 * Is the server on port 3100 actually OURS?
 *
 * It can be a leftover standalone `node dist/index.js` from an earlier session
 * or a second copy of the app. When it is, this app's own server never binds —
 * `EADDRINUSE` goes to a console nobody reads — and every screen here talks to
 * a stale build started with a different environment.
 *
 * That happened on 14-Sep-2026: a server from the previous evening held the
 * port, so the mirror panel 404'd AND the push agent read as disabled, and the
 * only advice on screen was about a `.env` that was already correct. Two wrong
 * readings from one invisible cause, and no way to see it from inside the app.
 */
function StaleServerBanner({ who, reachable }: { who: WhoAmI | null; reachable: boolean }) {
  const mine = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : null;
  const theirs = who?.version;
  /* Only when we can actually TELL. An older server has no /api/whoami at all,
     which is itself the signal — but a network blip is not, so an unreachable
     server says nothing here and the panel's own message covers it. */
  const mismatch = reachable && (!who || (!!mine && !!theirs && theirs !== mine && theirs !== "unknown"));
  if (!mismatch) return null;

  return (
    <div className="bg-warn-soft border border-warn-200 rounded-xl px-4 py-3 text-xs text-warn-800">
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-semibold">
            Another MK Cycles server is holding port 3100 — this window is talking to it, not to its own.
          </p>
          <p className="mt-1">
            {who?.version
              ? <>It reports version <b>{who.version}</b>{who.pid ? <> (pid {who.pid})</> : null}
                  {who.startedAt ? <>, started {new Date(who.startedAt).toLocaleString()}</> : null}.
                  This app is <b>{mine}</b>.</>
              : <>It does not answer <code>/api/whoami</code>, so it predates this build.</>}
          </p>
          <p className="mt-1">
            Everything on this screen — the push agent's state included — is that server's, and it was
            started with whatever environment existed then. Quit it and restart this app.
          </p>
        </div>
      </div>
    </div>
  );
}

export function MirrorPanel() {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [who, setWho] = useState<WhoAmI | null>(null);
  const [reachable, setReachable] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      /* whoami FIRST, and separately: if the wrong server is answering, that is
         the thing to say, and it explains whatever the panel does next. */
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
      <div className="space-y-3">
        <StaleServerBanner who={who} reachable={reachable} />
        <div className="bg-white rounded-xl border border-neutral-200 px-4 py-3 text-xs text-neutral-500">
          {busy ? "Reading the mirror…"
            : reachable
              ? "The server on port 3100 answered, but not with this panel — see above."
              : "Could not reach the local server on port 3100."}
        </div>
      </div>
    );
  }

  if (panel.offline) {
    return (
      <div className="bg-white rounded-xl border border-neutral-200 px-4 py-3 text-xs text-warn-800 flex items-start gap-1.5">
        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
        <span>Supabase is not configured or not reachable, so there is nothing to read. {panel.error}</span>
      </div>
    );
  }

  const lat = panel.pushLatency;

  return (
    <div className="space-y-3">
      <StaleServerBanner who={who} reachable={reachable} />

      {/* ── How fast a queued voucher actually reaches Tally ────────────── */}
      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-neutral-100 bg-neutral-50">
          <Clock size={14} className="text-neutral-500" />
          <h2 className="font-semibold text-sm text-neutral-700 flex-1">Queue to Tally</h2>
          <button onClick={() => void load()} className="text-neutral-400 hover:text-neutral-700" aria-label="Refresh">
            <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
          </button>
        </div>
        <div className="px-4 py-3 text-xs text-neutral-700">
          {lat.count === 0 ? (
            <span className="text-neutral-500">Nothing has been pushed yet, so there is no timing to show.</span>
          ) : (
            <>
              {/* TWO figures, never one. The app's own responsiveness and
                  Tally's import time are different things with different
                  remedies, and blending them reads as "the app took 25
                  seconds" when the app took half of one. */}
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <span>
                  <span className="font-mono text-lg font-bold text-neutral-900">{lat.pickupMedian ?? "—"}s</span>{" "}
                  to pick up
                  <span className="text-neutral-500"> · this app noticing</span>
                </span>
                <span>
                  <span className="font-mono text-lg font-bold text-neutral-900">{lat.inTallyMedian ?? "—"}s</span>{" "}
                  in Tally
                  <span className="text-neutral-500">
                    {lat.inTallySlowest != null ? ` · slowest ${lat.inTallySlowest}s` : ""} · {lat.count} measured
                  </span>
                </span>
              </div>
              <p className="mt-1 text-neutral-500">
                Pickup is sub-second because the agent listens for the insert; the poll behind it is only a
                guarantee. The rest is Tally importing, one voucher at a time — its XML port is
                single-threaded, so a batch finishes in sequence rather than together.
              </p>
              {lat.pickupMedian != null && lat.pickupMedian > 6 && (
                <p className="mt-1 text-warn-800">
                  Pickup is slower than the 4-second poll, which means the realtime channel is not
                  delivering and every push is waiting for a tick.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Push log ───────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-neutral-100 bg-neutral-50">
          <ArrowUpRight size={14} className="text-neutral-500" />
          <h2 className="font-semibold text-sm text-neutral-700 flex-1">Push log</h2>
          <span className="text-[11px] text-neutral-500">{panel.pushes.length} most recent</span>
        </div>
        {panel.pushes.length === 0 ? (
          <p className="px-4 py-3 text-xs text-neutral-500">Nothing queued yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-100 max-h-[320px] overflow-auto">
            {panel.pushes.map((p) => (
              <li key={p.id} className="px-4 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-semibold">{p.voucherType}</span>
                  <span className="text-[11px] font-mono text-neutral-500">{p.voucherNumber}</span>
                  <span className={`ml-auto text-[10.5px] font-bold inline-flex items-center gap-1 ${TONE[p.status] ?? "text-neutral-500"}`}>
                    {p.status === "succeeded" ? <Check size={11} />
                      : p.status === "failed" ? <AlertTriangle size={11} />
                      : p.status === "cancelled" ? <Minus size={11} />
                      : <Loader2 size={11} className="animate-spin" />}
                    {p.status}
                  </span>
                </div>
                <div className="flex items-baseline gap-2 mt-0.5">
                  <span className="text-[11px] text-neutral-600 truncate" title={p.party}>{p.party}</span>
                  {p.amount > 0 && (
                    <span className="ml-auto text-[11px] font-mono text-neutral-700">
                      ₹{p.amount.toLocaleString("en-IN")}
                    </span>
                  )}
                </div>
                <div className="text-[10.5px] text-neutral-400 mt-0.5">
                  queued {when(p.createdAt)}
                  {p.waitedSeconds !== null && p.waitedSeconds >= 0 && ` · took ${p.waitedSeconds}s`}
                  {p.attempts > 1 && ` · ${p.attempts} attempts`}
                </div>
                {/* In full. Truncating a refusal removes the only useful part. */}
                {p.lastError && (
                  <p className="mt-1 text-[10.5px] text-danger-700 bg-danger-soft rounded px-1.5 py-1">{p.lastError}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Sync history ───────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-neutral-100 bg-neutral-50">
          <History size={14} className="text-neutral-500" />
          <h2 className="font-semibold text-sm text-neutral-700 flex-1">Sync history</h2>
          <span className="text-[11px] text-neutral-500">
            last full pull {panel.lastFullSyncAt ? when(panel.lastFullSyncAt) : "— none on record"}
          </span>
        </div>
        {/* A full sweep is its own fact. Backdated entry is most of the work
            here and the small pulls only look at today, so a run of successful
            little syncs makes the mirror look fresh while last week's orders
            quietly never arrive. */}
        <ul className="divide-y divide-neutral-100 max-h-[240px] overflow-auto">
          {panel.syncs.map((s, i) => (
            <li key={i} className="px-4 py-1.5 flex items-baseline gap-2 text-[11px]">
              <span className={s.success ? "text-success-700" : "text-danger-700"}>
                {s.success ? <Check size={11} /> : <AlertTriangle size={11} />}
              </span>
              <span className="font-semibold capitalize">{s.syncType ?? "sync"}</span>
              {s.full && (
                <span className="px-1.5 rounded bg-accent/10 text-accent-700 text-[10px] font-bold">full</span>
              )}
              <span className="text-neutral-500 truncate">
                {Object.entries(s.counts ?? {}).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${n(Number(v))} ${k}`).join(", ") || "—"}
              </span>
              <span className="ml-auto shrink-0 text-neutral-400">{when(s.startedAt)}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* ── Snapshot ─────────────────────────────────────────────────────
          Tiles rather than a list, matching the web Sync Logs page — the same
          five figures in the same shape, so the two screens can be read
          against each other without translating. */}
      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-neutral-100 bg-neutral-50">
          <Database size={14} className="text-neutral-500" />
          <h2 className="font-semibold text-sm text-neutral-700 flex-1">Data snapshot</h2>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 p-3">
          {panel.snapshot.map((s) => (
            <div key={s.table} className="rounded-lg border border-neutral-200 px-3 py-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500 truncate" title={s.table}>
                {s.table.replace(/^tally_/, "").replace(/_/g, " ")}
              </div>
              <div className="font-mono text-lg font-bold text-neutral-900 tabular-nums">{n(s.rows)}</div>
              {s.newest && <div className="text-[10px] text-neutral-400">to {s.newest}</div>}
            </div>
          ))}
        </div>
        <p className="px-4 py-2 text-[10.5px] text-neutral-500 border-t border-neutral-100">
          A dash means the table could not be read, which is not the same as it being empty.
        </p>
      </div>

      {/* ── Activity log ─────────────────────────────────────────────────
          Who changed what, from the same `config_edit_log` the web page reads.
          Here because the agent is the machine people stand in front of when
          something looks wrong, and "did someone change the discount rules?" is
          one of the first questions. */}
      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-neutral-100 bg-neutral-50">
          <PenLine size={14} className="text-neutral-500" />
          <h2 className="font-semibold text-sm text-neutral-700 flex-1">Activity log</h2>
          <span className="text-[11px] text-neutral-500">{panel.edits.length} most recent</span>
        </div>
        {panel.edits.length === 0 ? (
          <p className="px-4 py-3 text-xs text-neutral-500">Nothing recorded yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-100 max-h-[240px] overflow-auto">
            {panel.edits.map((e) => (
              <li key={e.id} className="px-4 py-1.5 flex items-baseline gap-2 text-[11px]">
                <span className={`px-1.5 rounded text-[10px] font-bold shrink-0 ${ACTION_TONE[e.action] ?? "bg-neutral-100 text-neutral-600"}`}>
                  {e.action}
                </span>
                <span className="font-semibold truncate" title={`${e.domain} · ${e.table}`}>{e.domain}</span>
                {e.count != null && <span className="text-neutral-500 shrink-0">×{e.count}</span>}
                <span className="text-neutral-500 truncate" title={e.who}>{e.who}</span>
                <span className="ml-auto shrink-0 text-neutral-400">{when(e.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
