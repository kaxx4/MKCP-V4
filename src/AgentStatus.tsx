import { useState, useEffect, useCallback, useRef } from "react";
import { PendingPushes } from "./PendingPushes";
import { createClient, RealtimeChannel } from "@supabase/supabase-js";
import {
  Wifi, WifiOff, RefreshCw, Cloud, CloudOff, CheckCircle, XCircle,
  Clock, Activity, ChevronDown, ChevronUp, Settings, Database,
  AlertTriangle, Loader2, Send, Upload, Download, Tag, CalendarRange, PackageSearch,
} from "lucide-react";
import { useTallyStore } from "./store/tallyStore";
import { useSupabaseSyncStatusStore } from "./store/supabaseSyncStatusStore";
import { useToast } from "./components/Toast";
import { todayYmd, daysAgoYmd } from "./services/tallyPull";
import { runQuickSync } from "./services/quickSync";
import { useQuickSyncStore } from "./store/quickSyncStore";
import { MirrorPanel } from "./MirrorPanel";
import { PageHeader } from "./components/PageHeader";
import { StatTile } from "./components/StatTile";
import { PushQueuePanel } from "./components/PushQueuePanel";
/* The five panels below were inline in this file. Each is rebuilt on the web
   dashboard's idiom the way PushQueuePanel was — see each file's header for
   what the old version got wrong and why the new one is shaped as it is. */
import { TallyPanel } from "./components/TallyPanel";
import { SupabaseCloudPanel } from "./components/SupabaseCloudPanel";
import { QuickSyncPanel } from "./components/QuickSyncPanel";
import { PullSyncPanel, type PullAction } from "./components/PullSyncPanel";
import { LogsPanel, isErrorLine } from "./components/LogsPanel";
import { UpdatesPanel } from "./components/UpdatesPanel";
/* The four KPI facts are derived here AND in QuickView.tsx, so the reasoning
   lives in one module rather than in whichever window was edited last. The part
   that must not drift is telling "zero" apart from "never counted". */
import { tallyFact, drainFact, queueFact, cloudFact, toneToStatTile } from "./status/agentFacts";

const SUPA_URL = (import.meta as any).env?.VITE_SUPABASE_URL as string | undefined;
const SUPA_ANON = (import.meta as any).env?.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const sbRead = SUPA_URL && SUPA_ANON
  ? createClient(SUPA_URL, SUPA_ANON, { auth: { persistSession: false } })
  : null;

const BASE = (import.meta as any).env?.VITE_TALLY_PROXY || "http://localhost:3100";
/** `localhost:3100` — the same host:port string in the KPI strip, the push
 *  queue panel and the Tally panel, derived once. */
const BASE_LABEL = BASE.replace(/^https?:\/\//, "");

// ── Types ────────────────────────────────────────────────────────────────────
interface PushAgentStatus {
  enabled: boolean;
  agentId: string;
  lastTick: string | null;
  tallyHealthy: boolean;
  claimedCount: number;
  last10Results: Array<{ id: string; idempotency_key: string; status: string; error?: string; at: string }>;
  queueStats: { pending: number; pushing: number; failed: number };
  /** When those counts were last actually read out of Supabase. `null` means
   *  they never have been — the initial zeros, not a measured empty queue.
   *  Written by server/src/services/pushAgent.ts:refreshQueueStats. */
  queueStatsAt: string | null;
}

interface TallyHealth {
  connected: boolean;
  tallyUrl: string;
  current?: string | null;
  error?: string;
}

interface SyncHistoryRow {
  id: string;
  sync_type: "masters" | "vouchers";
  started_at: string;
  completed_at: string;
  success: boolean;
  duration_ms: number | null;
  chunk_count: number | null;
  row_counts: Record<string, number> | null;
  errors: string[] | null;
}

interface PushLogRow {
  id: string;
  push_queue_id: string;
  idempotency_key: string;
  voucher_type: string | null;
  party: string | null;
  date: string | null;
  status: "succeeded" | "failed";
  tally_vch_id: string | null;
  attempts: number;
  last_error: string | null;
  line_errors: string[] | null;
  resolved_at: string;
}

/** Deliberate port of web-dashboard/src/lib/fileTransferKind.ts's label map —
 *  the two repos can't share a module, so this list is duplicated. Keep it in
 *  step: the server-side classifier (server/src/services/fileTransferKind.ts)
 *  is what actually writes `kind` onto the row; this is display-only. */
type FileTransferKind = "price_list" | "purchase_xml" | "packing_list" | "sales_order" | "unknown";
const KIND_LABEL: Record<FileTransferKind, string> = {
  price_list: "Price list",
  purchase_xml: "Purchase / in-transit XML",
  packing_list: "Packing list",
  sales_order: "Sales order",
  unknown: "File",
};

interface FileTransferRow {
  id: string;
  direction: "web_to_desktop" | "desktop_to_web";
  filename: string;
  status: "pending" | "downloaded" | "dismissed";
  note: string | null;
  size_bytes: number | null;
  created_at: string;
  updated_at: string;
  kind: FileTransferKind;
}

interface FailedQueueRow {
  id: string;
  idempotency_key: string;
  company: string;
  payload: Record<string, unknown>;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  /* en-IN explicitly. The default locale rendered `9/15/2026 12:04:54 PM`
     next to rows formatted `15/9/2026, 12:04:54 pm` — the same instant in two
     notations, one line apart. */
  return new Date(iso).toLocaleString("en-IN");
}

// ── Shared UI components ──────────────────────────────────────────────────────
/** Compact, always-visible sync-state indicator — idle / syncing(phase) / succeeded /
 *  failed(actual error). Reads only from stores already populated by every sync path
 *  (quickSyncStore for quick-sync, tallyStore.isSyncing for manual full/masters/daybook
 *  triggers) — no new store. */
/**
 * What the updater is doing, in the header, permanently.
 *
 * Only `ready` and `error` are worth interrupting for, so everything else is
 * quiet or absent: "current" says nothing at all rather than adding a green
 * tick nobody needs. `ready` is deliberately not a button — this process holds
 * Tally's single-threaded port and drains the push queue, so it installs on the
 * next ordinary quit rather than offering to restart mid-push.
 */
interface UpdateState {
  phase: string;
  version?: string;
  percent?: number;
  message?: string;
  notes?: string | null;
  releaseName?: string | null;
  releaseDate?: string | null;
}

/**
 * The update control — what is available, what is in it, and install it now.
 *
 * It was a status chip and nothing more: it told you a version was ready and
 * then made you quit the app to get it. On a machine that is deliberately left
 * running — this one owns Tally's port and drains the push queue — "the next
 * time you close it" can be days, so a fix could sit downloaded and unused for
 * a week. Asked for directly on 16-Sep-2026.
 *
 * Three things it must do that a chip could not:
 *   · say WHAT is in the release, so accepting a restart is not an act of
 *     faith in a version number;
 *   · install on demand;
 *   · refuse to do that while a voucher push is in flight — see `installNow`
 *     in autoUpdate.js. Quitting then ends the push between "Tally created it"
 *     and "the queue row says so".
 */
function UpdateChip({ state, currentVersion }: { state: UpdateState | null; currentVersion?: string }) {
  const [open, setOpen] = useState(false);
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  /* Close on an outside click or Escape — a panel that can only be dismissed by
     the control that opened it traps a mis-tap. */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  if (!state) return null;
  const { phase, version, percent } = state;
  if (phase === "idle" || phase === "disabled") return null;

  const api = (window as any).electronAPI?.update;

  async function install(force: boolean) {
    setWorking(true);
    setBusyMsg(null);
    try {
      const r = await api?.installNow({ force });
      if (r && !r.ok) {
        setBusyMsg(
          r.reason === "busy"
            ? "A voucher is being pushed to Tally right now. Installing would cut it off mid-push."
            : r.reason,
        );
      }
    } catch (e) {
      setBusyMsg(e instanceof Error ? e.message : "Couldn't start the install.");
    } finally {
      setWorking(false);
    }
  }

  const tone =
    phase === "ready" ? "border-success-200 bg-success-50 text-success-700"
    : phase === "error" ? "border-warn-200 bg-warn-50 text-warn-800"
    : "border-neutral-200 bg-white text-neutral-600";

  const label =
    phase === "downloading" ? `Update${typeof percent === "number" ? ` ${percent}%` : "…"}`
    : phase === "ready" ? (version ? `v${version} ready` : "Update ready")
    : phase === "installing" ? "Restarting…"
    : phase === "checking" ? "Checking…"
    : phase === "current" ? (currentVersion ? `v${currentVersion}` : "Up to date")
    : "Update check failed";

  return (
    <div className="relative" ref={boxRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold ${tone}`}
        title="Updates — what is available and what is in it"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${
          phase === "ready" ? "bg-success-600"
          : phase === "error" ? "bg-warn-600"
          : phase === "downloading" || phase === "checking" ? "bg-accent animate-pulse"
          : "bg-neutral-400"}`} />
        {label}
        <ChevronDown size={12} className={open ? "rotate-180 transition-transform" : "transition-transform"} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Updates"
          className="absolute right-0 z-50 mt-1.5 w-[320px] rounded-xl border border-neutral-200 bg-white p-3 shadow-lg"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[13px] font-semibold text-neutral-900">
              {phase === "ready" || phase === "downloading" ? `Version ${version ?? "?"}` : "Updates"}
            </span>
            {currentVersion && (
              <span className="text-[11px] text-neutral-500">running v{currentVersion}</span>
            )}
          </div>

          {state.releaseDate && (
            <div className="mt-0.5 text-[11px] text-neutral-500">
              published {new Date(state.releaseDate).toLocaleDateString()}
            </div>
          )}

          {/* What is in it. Rendered as TEXT, never as markup — release notes
              are authored outside this app and a renderer that injects them is
              a renderer that trusts a remote string. */}
          {state.notes && (
            <div className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-neutral-50 p-2 text-[11.5px] leading-snug text-neutral-700">
              {state.notes.replace(/<[^>]+>/g, "").trim()}
            </div>
          )}

          {state.message && !state.notes && (
            <p className="mt-2 text-[11.5px] text-neutral-600">{state.message}</p>
          )}

          {busyMsg && (
            <p className="mt-2 rounded-lg bg-warn-50 p-2 text-[11.5px] font-medium text-warn-800">{busyMsg}</p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {phase === "ready" && (
              <button
                onClick={() => void install(false)}
                disabled={working}
                className="btn-primary btn-sm flex-1 disabled:opacity-50"
                title="Closes the agent, installs, and starts it again."
              >
                {working ? "Starting…" : "Install and restart"}
              </button>
            )}
            {phase !== "ready" && (
              <button
                onClick={() => { setBusyMsg(null); void api?.checkNow(); }}
                className="btn-secondary btn-sm flex-1"
              >
                Check for updates
              </button>
            )}
          </div>

          {/* The override, and only once refusing has actually happened. An
              "install anyway" offered up front invites the very thing the
              refusal exists to prevent. */}
          {busyMsg?.startsWith("A voucher") && (
            <button
              onClick={() => void install(true)}
              className="mt-2 w-full text-[11px] font-semibold text-warn-800 underline"
            >
              Install anyway — I accept the push may be cut off
            </button>
          )}

          {phase === "ready" && (
            <p className="mt-2 text-[10.5px] leading-snug text-neutral-500">
              It installs on its own the next time you close the app. Nothing is lost by waiting.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SyncStateIndicator({
  isSyncing, syncingLabel, qsync,
}: {
  isSyncing: boolean;
  syncingLabel: string | null;
  qsync: import("./store/quickSyncStore").QuickSyncState;
}) {
  if (qsync.running) {
    const phaseLabel = qsync.phase === "push" ? "Pushing to Supabase…" : "Pulling from Tally…";
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-accent/10 text-accent-700">
        <Loader2 size={12} className="animate-spin" /> Syncing · {phaseLabel}
      </span>
    );
  }
  if (isSyncing) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-accent/10 text-accent-700">
        <Loader2 size={12} className="animate-spin" /> Syncing{syncingLabel ? ` · ${syncingLabel}` : ""}
      </span>
    );
  }
  // Skip is only shown while it's newer than the last real finish — a subsequent
  // completed sync naturally supersedes it via this comparison, no separate
  // "clear" action needed (single source of truth: the timestamps).
  if (qsync.lastSkipped && (!qsync.finishedAt || qsync.lastSkipped.at > qsync.finishedAt)) {
    const reasonLabel = qsync.lastSkipped.reason === "sync-in-progress"
      ? "another sync was already running"
      : qsync.lastSkipped.reason === "not-connected"
        ? "Tally not connected"
        : "no company configured";
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-warn-soft text-warn-800">
        <AlertTriangle size={12} /> {qsync.lastSkipped.label} sync skipped — {reasonLabel}
      </span>
    );
  }
  if (qsync.finishedAt) {
    if (qsync.ok) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-success/10 text-success-700">
          <CheckCircle size={12} /> Synced {fmt(qsync.finishedAt)}
        </span>
      );
    }
    const errMsg = qsync.tally && !qsync.tally.ok
      ? qsync.tally.error || "Tally pull failed"
      : qsync.push && !qsync.push.ok
        ? qsync.push.vouchersErr || qsync.push.configErr || "Supabase push failed"
        : "Sync failed";
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-danger-soft text-danger-700 max-w-[360px] truncate"
        title={errMsg}
      >
        <XCircle size={12} className="shrink-0" /> Failed · {errMsg}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-neutral-100 text-neutral-500">
      <Clock size={12} /> Idle
    </span>
  );
}

/**
 * The collapsible panel — ONE definition.
 *
 * Logs, Settings and File transfer each hand-rolled this same card and header
 * inline further down, because SectionCard could not carry the small badge
 * their headers needed (an error count, a "new" pill). Four copies of one
 * shape, so an affordance had to be fixed four times and was not: none of the
 * four said `aria-expanded`, none had a hover state, and the header was 44px
 * only by the accident of its padding. Adding a `badge` slot collapses them
 * into this. (15-Sep-2026)
 */
function SectionCard({ title, icon, children, badge, defaultOpen = true, bodyClassName = "px-4 py-3", open: openProp, onOpenChange }: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  /** Small trailing note in the header — the one thing worth seeing while the
   *  panel is still closed. */
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  bodyClassName?: string;
  /** Controlled mode. Three panels poll a server only while they are open, so
   *  the parent has to know — Logs refreshes its tail every 2s, File transfer
   *  its list every 10s, and both are deliberately quiet while shut. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => { setOpenState(next); onOpenChange?.(next); };
  return (
    <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
      <button
        className="flex min-h-11 w-full items-center gap-2 border-b border-neutral-100 bg-neutral-50 px-4 py-3 text-left transition-colors hover:bg-neutral-100"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={open ? `Hide ${title}` : `Show ${title}`}
      >
        <span className="text-neutral-500">{icon}</span>
        <h2 className="font-semibold text-sm text-neutral-700 flex-1">{title}</h2>
        {badge}
        {open ? <ChevronUp size={14} className="text-neutral-400" /> : <ChevronDown size={14} className="text-neutral-400" />}
      </button>
      {open && <div className={bodyClassName}>{children}</div>}
    </div>
  );
}

/**
 * The small button used by Settings and File transfer.
 *
 * It used to carry its own three-variant palette — `bg-blue-600`,
 * `bg-red-50 text-red-700` — which meant the agent's "danger" was a different
 * red from the danger in every panel beside it and from the web dashboard's.
 * It now composes the shared `.btn-*` classes in index.css, which is the same
 * vocabulary the rebuilt panels use, so there is one definition of each state.
 *
 * `disabledReason` is not decoration: a flat grey button that says nothing is
 * the difference between a two-second fix and a hunt through the log. When it
 * is given, it becomes the tooltip AND the accessible description, and the
 * button is disabled from that fact rather than from a separate flag.
 */
function Btn({ onClick, disabled, disabledReason, children, variant = "secondary", title }: {
  onClick: () => void;
  disabled?: boolean;
  /** Why this is not available. Supplying it also disables the button. */
  disabledReason?: string | null;
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "danger";
  title?: string;
}) {
  const cls = { primary: "btn-primary", secondary: "btn-secondary", danger: "btn-danger" }[variant];
  const off = !!disabled || !!disabledReason;
  return (
    <button
      onClick={onClick}
      disabled={off}
      title={disabledReason ?? title}
      aria-description={disabledReason ?? undefined}
      className={`${cls} btn-sm tap-y shrink-0`}
    >
      {children}
    </button>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function AgentStatus() {
  // Fine-grained selectors — component only re-renders when the specific field changes.
  const companyName        = useTallyStore((s) => s.companyName);
  const proxyUrl           = useTallyStore((s) => s.proxyUrl);
  const fyFromDate         = useTallyStore((s) => s.fyFromDate);
  const fyToDate           = useTallyStore((s) => s.fyToDate);
  /* `lastSyncAt`, `lastMastersSyncAt`, `lastVouchersSyncAt` and
     `lastVoucherDate` were subscribed here and rendered NOWHERE — they are
     what PullSyncPanel's old freshness tiles read before that panel was
     rebuilt on `tally_sync_history`. Two of them could not have told the truth
     anyway: `setLastMastersSync` is exported by store/tallyStore.ts and called
     from nowhere in this repo, so `lastMastersSyncAt` is null on every
     machine, and `lastSyncAt` is stamped by `triggerSync` after ANY manual
     pull including a 0.4s price-list fetch. Dropped rather than left as four
     live subscriptions re-rendering a 1,100-line component for values it does
     not use. They are still PUSHED to Supabase by hooks/useSupabaseConfigSync
     — see the note there.  (15-Sep-2026) */
  const syncTodayMinutes = useTallyStore((s) => s.syncTodayMinutes);
  const syncWeekMinutes  = useTallyStore((s) => s.syncWeekMinutes);
  const syncFyMinutes    = useTallyStore((s) => s.syncFyMinutes);
  const isSyncing        = useTallyStore((s) => s.isSyncing);   // global "any sync running" lock
  const setTallySyncing  = useTallyStore((s) => s.setSyncing);
  const setConnected       = useTallyStore((s) => s.setConnected);
  const setLastSync        = useTallyStore((s) => s.setLastSync);
  const setCompanyName     = useTallyStore((s) => s.setCompanyName);
  const setProxyUrl        = useTallyStore((s) => s.setProxyUrl);
  const setFyDates         = useTallyStore((s) => s.setFyDates);
  const setSyncTodayMinutes = useTallyStore((s) => s.setSyncTodayMinutes);
  const setSyncWeekMinutes  = useTallyStore((s) => s.setSyncWeekMinutes);
  const setSyncFyMinutes    = useTallyStore((s) => s.setSyncFyMinutes);

  const cloudConfig   = useSupabaseSyncStatusStore((s) => s.config);
  const cloudMasters  = useSupabaseSyncStatusStore((s) => s.masters);
  const cloudVouchers = useSupabaseSyncStatusStore((s) => s.vouchers);

  const { toast } = useToast();

  const [health, setHealth] = useState<TallyHealth | null>(null);
  const [pushStatus, setPushStatus] = useState<PushAgentStatus | null>(null);
  const [pushStatusUnreachable, setPushStatusUnreachable] = useState(false);
  const [polling, setPolling] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [draining, setDraining] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showFileTransfer, setShowFileTransfer] = useState(false);
  const [syncFolder, setSyncFolder] = useState<string>("");
  const [watchFolder, setWatchFolder] = useState<string>("");
  const [transfers, setTransfers] = useState<FileTransferRow[]>([]);
  /* Null until the first answer. `transfersError` non-null means the list is
     empty because it could not be READ, which is the opposite of empty. */
  const [transfersError, setTransfersError] = useState<string | null>(null);
  const [transfersReadAt, setTransfersReadAt] = useState<string | null>(null);
  /* What the SERVER says it is watching, which is the only thing that decides
     whether a dropped file is picked up. The Electron setting below is just
     the path last chosen. */
  const [watchStatus, setWatchStatus] = useState<{ watching: boolean; dir: string | null } | null>(null);
  const [pushingFile, setPushingFile] = useState(false);
  const [transferNote, setTransferNote] = useState("");
  const [transferBusy, setTransferBusy] = useState<string | null>(null);
  const [syncHistory, setSyncHistory] = useState<SyncHistoryRow[]>([]);
  const [pushLog, setPushLog] = useState<PushLogRow[]>([]);
  const [failedJobs, setFailedJobs] = useState<FailedQueueRow[]>([]);
  const [requeueing, setRequeueing] = useState<string | null>(null);
  const qsync = useQuickSyncStore();
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  // Settings local state (initialised once from store — not reactive after that)
  const [editCompany, setEditCompany] = useState(companyName);
  const [editProxy, setEditProxy]     = useState(proxyUrl);
  const [editFyFrom, setEditFyFrom]   = useState(fyFromDate);
  const [editFyTo, setEditFyTo]       = useState(fyToDate);
  const [editTodayMins, setEditTodayMins] = useState(String(syncTodayMinutes));
  const [editWeekMins, setEditWeekMins]   = useState(String(syncWeekMinutes));
  const [editFyMins, setEditFyMins]       = useState(String(syncFyMinutes));

  // ── Supabase data fetchers ────────────────────────────────────────────────
  const fetchHistory = useCallback(async () => {
    if (!sbRead) return;
    const { data } = await sbRead
      .from("tally_sync_history")
      .select("id,sync_type,started_at,completed_at,success,duration_ms,chunk_count,row_counts,errors")
      .order("started_at", { ascending: false })
      .limit(20);
    if (data) setSyncHistory(data as SyncHistoryRow[]);
  }, []);

  const fetchPushLog = useCallback(async () => {
    if (!sbRead) return;
    const { data } = await sbRead
      .from("push_sync_log")
      .select("id,push_queue_id,idempotency_key,voucher_type,party,date,status,tally_vch_id,attempts,last_error,line_errors,resolved_at")
      .order("resolved_at", { ascending: false })
      .limit(30);
    if (data) setPushLog(data as PushLogRow[]);
  }, []);

  const fetchFailedJobs = useCallback(async () => {
    if (!sbRead) return;
    const { data } = await sbRead
      .from("push_queue")
      .select("id,idempotency_key,company,payload,attempts,last_error,created_at")
      .eq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(50);
    if (data) setFailedJobs(data as FailedQueueRow[]);
  }, []);

  // ── Server log buffer (Tally + Supabase sync activity) ──────────────────────
  const fetchLogs = useCallback(async () => {
    try {
      const r = await fetch(`${BASE}/api/tally/logs`);
      const lines = await r.json();
      if (Array.isArray(lines)) setLogs(lines as string[]);
    } catch { /* server not up yet — ignore */ }
  }, []);

  // ── Poll — only hits local server endpoints (not Supabase) ───────────────
  const poll = useCallback(async () => {
    setPolling(true);
    try {
      const [h, p] = await Promise.all([
        fetch(`${BASE}/api/tally/health`).then(r => r.json()).catch(() => null),
        fetch(`${BASE}/api/push-agent/status`).then(r => r.json()).catch(() => null),
      ]);
      setHealth(h);
      if (h != null) setConnected(!!h.connected);
      setPushStatus(p);
      // A completed poll with no payload = the local server is down/unreachable,
      // not "still loading" — track it so the queue card can say so instead of
      // showing an infinite "Loading…" that's indistinguishable from a hang.
      setPushStatusUnreachable(p == null);
    } finally {
      setPolling(false);
    }
  }, [setConnected]);

  // ── Realtime — stored by ref, removed via removeChannel on unmount ────────
  const realtimeChannelRef = useRef<RealtimeChannel | null>(null);
  useEffect(() => {
    if (!sbRead || realtimeChannelRef.current) return;
    realtimeChannelRef.current = sbRead
      .channel("agent-status-sync")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "tally_sync_history" }, () => void fetchHistory())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "push_sync_log" }, () => void fetchPushLog())
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "push_queue" }, () => void fetchFailedJobs())
      .subscribe();
    return () => {
      if (realtimeChannelRef.current && sbRead) {
        sbRead.removeChannel(realtimeChannelRef.current);
        realtimeChannelRef.current = null;
      }
    };
  }, []); // stable: fetchHistory/fetchPushLog/fetchFailedJobs all have [] deps

  // ── Poll interval — server endpoints only ─────────────────────────────────
  useEffect(() => {
    void poll();
    const id = setInterval(() => void poll(), 10_000);
    return () => clearInterval(id);
  }, [poll]);

  // ── One-time initial Supabase fetch — realtime drives subsequent updates ──
  useEffect(() => {
    void fetchHistory();
    void fetchPushLog();
    void fetchFailedJobs();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* One read at startup so the COLLAPSED Logs header can carry a real error
     count. Without it `logs` is empty until the panel is opened, which made the
     "2 errors" badge visible only to someone who had already gone looking. */
  useEffect(() => { void fetchLogs(); }, [fetchLogs]);

  // ── Live log polling — only while the Logs panel is open (every 2s) ───────
  useEffect(() => {
    if (!showLogs) return;
    void fetchLogs();
    const id = setInterval(() => void fetchLogs(), 2000);
    return () => clearInterval(id);
  }, [showLogs, fetchLogs]);

  // ── File transfer — only while that panel is open, same convention as Logs ─
  const fetchTransfers = useCallback(async () => {
    if (!companyName) return;
    try {
      const resp = await fetch(`${BASE}/api/file-transfer/status?company=${encodeURIComponent(companyName)}`);
      if (!resp.ok) { setTransfersError(`the server answered ${resp.status}`); return; }
      const body = await resp.json();
      setTransfers(body.rows ?? []);
      setWatchStatus(body.watch ?? null);
      /* `ok:false` carries an empty list that means "could not ask". Older
         servers do not send `ok` at all, and an absent field is not a
         failure — hence the explicit `=== false`. */
      setTransfersError(body.ok === false ? (body.error || "Supabase could not be read.") : null);
      if (body.ok !== false) setTransfersReadAt(new Date().toISOString());
    } catch (e: any) {
      setTransfersError(`the local server is not answering (${e?.message ?? e})`);
    }
  }, [companyName]);

  /* One read at startup, for the same reason the Logs panel takes one: the
     "new" badge on this panel's COLLAPSED header is computed from `transfers`,
     and `transfers` was only ever fetched while the panel was open. A badge
     whose entire job is to tell you something arrived could not appear until
     after you had already gone and looked. (15-Sep-2026) */
  useEffect(() => { void fetchTransfers(); }, [fetchTransfers]);

  useEffect(() => {
    if (!showFileTransfer) return;
    void fetchTransfers();
    const id = setInterval(() => void fetchTransfers(), 10_000);
    return () => clearInterval(id);
  }, [showFileTransfer, fetchTransfers]);

  /* Over-the-air update state.
     Read once AND subscribed: a check can resolve before this component mounts,
     and an updater whose result nobody ever sees is the failure this feature is
     supposed to remove, not introduce. */
  const [update, setUpdate] = useState<UpdateState | null>(null);
  useEffect(() => {
    const api = (window as any).electronAPI?.update;
    if (!api) return;               // browser/dev — there is no updater to report
    void api.getState().then(setUpdate).catch(() => {});
    return api.onState(setUpdate);
  }, []);

  /* The version actually RUNNING, so the panel can say "v1.4.4 ready, running
     v1.4.3" rather than naming one number and leaving the other to memory. */
  const [appVersion, setAppVersion] = useState<string | undefined>();
  useEffect(() => {
    void (window as any).electronAPI?.getVersion?.().then(setAppVersion).catch(() => {});
  }, []);

  useEffect(() => {
    if (!showFileTransfer || !(window as any).electronAPI?.getSettings) return;
    (window as any).electronAPI.getSettings().then((s: any) => {
      setSyncFolder(s?.syncFolderPath || "");
      setWatchFolder(s?.watchFolderPath || "");
    });
  }, [showFileTransfer]);

  /* Every control in File transfer goes through Electron's main process. In a
     browser tab (`npm run dev`, and the preview this UI is checked in) there is
     no `electronAPI`, and each handler quietly `return`ed — a live-looking
     button that did nothing at all when pressed. Named once, and rendered as
     the reason the buttons are off. */
  const desktopBridge = typeof window !== "undefined" && !!(window as any).electronAPI;
  const noBridgeReason = desktopBridge
    ? null
    : "Only the installed desktop app can open a folder picker — this window is running in a browser.";

  const chooseWatchFolder = useCallback(async () => {
    const api = (window as any).electronAPI;
    if (!api?.pickWatchFolder) return;
    const res = await api.pickWatchFolder();
    if (res?.ok) {
      setWatchFolder(res.path);
      toast("Anything dropped in this folder will be sent up automatically", "success");
    } else if (res?.reason && res.reason !== "canceled") {
      toast(res.reason, "error");
    }
  }, [toast]);

  const chooseSyncFolder = useCallback(async () => {
    const api = (window as any).electronAPI;
    if (!api?.pickSyncFolder) return;
    const res = await api.pickSyncFolder();
    if (res?.ok) {
      setSyncFolder(res.path);
      toast("Incoming files will be saved here from now on", "success");
    }
  }, [toast]);

  const pushFileToWeb = useCallback(async () => {
    const api = (window as any).electronAPI;
    if (!api?.pickFileToPush || !companyName) return;
    const picked = await api.pickFileToPush();
    if (!picked?.ok) return;
    setPushingFile(true);
    try {
      const resp = await fetch(`${BASE}/api/file-transfer/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company: companyName, filePath: picked.path, note: transferNote || undefined }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${resp.status}`);
      }
      toast("Sent to the web dashboard", "success");
      setTransferNote("");
      void fetchTransfers();
    } catch (err: any) {
      toast(`Couldn't send that file: ${err.message}`, "error");
    } finally {
      setPushingFile(false);
    }
  }, [companyName, transferNote, toast, fetchTransfers]);

  const dismissTransfer = useCallback(async (id: string) => {
    if (!sbRead) return;
    setTransferBusy(id);
    try {
      await sbRead.from("file_transfers").update({ status: "dismissed" }).eq("id", id);
      void fetchTransfers();
    } finally {
      setTransferBusy(null);
    }
  }, [fetchTransfers]);

  // ── Quick Sync: pull from Tally (daily), THEN push to Supabase ────────────
  // Sequential by design — the push only starts after the Tally pull finishes,
  // and pullFromTally holds the global sync lock so the push can't run mid-sync.
  const quickSync = useCallback(async (label: string, fromYmd: string, toYmd: string) => {
    if (useQuickSyncStore.getState().running) return; // one quick-sync at a time
    await runQuickSync(companyName, label, fromYmd, toYmd, false);
    void fetchHistory();
    void fetchPushLog();
    const r = useQuickSyncStore.getState();
    if (!r.tally?.ok) {
      toast(`${label}: Tally sync failed — ${r.tally?.error ?? "unknown"}`, "error");
    } else {
      toast(
        r.ok ? `${label}: synced ${r.tally.vouchers} voucher(s) → pushed to Supabase` : `${label}: synced, but Supabase push had errors`,
        r.ok ? "success" : "error",
      );
    }
  }, [companyName, toast, fetchHistory, fetchPushLog]);

  // ── Actions (stable refs via useCallback) ────────────────────────────────
  const triggerSync = useCallback(async (endpoint: string, body: Record<string, unknown>, label: string) => {
    // Respect the global lock — never start a manual sync while another sync
    // (manual, scheduled, or quick) is running.
    if (useTallyStore.getState().isSyncing) { toast("A sync is already running — please wait", "info"); return; }
    setSyncing(label);
    setTallySyncing(true);
    try {
      const r = await fetch(`${BASE}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.success) {
        toast(`${label} complete`, "success");
        setLastSync(new Date().toISOString());
        void fetchHistory();
      } else {
        toast(`${label} failed: ${j.error || "unknown error"}`, "error");
      }
    } catch (e: any) {
      toast(`${label} failed: ${e.message}`, "error");
    } finally {
      setSyncing(null);
      setTallySyncing(false);
    }
  }, [toast, setLastSync, fetchHistory, setTallySyncing]);

  const drainQueue = useCallback(async () => {
    setDraining(true);
    try {
      await fetch(`${BASE}/api/push-agent/drain`, { method: "POST" });
      await new Promise(r => setTimeout(r, 600));
      await poll();
      void fetchPushLog();
      void fetchFailedJobs();
      toast("Drain tick triggered", "success");
    } catch { toast("Drain trigger failed", "error"); }
    finally { setDraining(false); }
  }, [toast, poll, fetchPushLog, fetchFailedJobs]);

  const requeueJob = useCallback(async (id: string) => {
    setRequeueing(id);
    try {
      const r = await fetch(`${BASE}/api/push-agent/requeue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const j = await r.json();
      if (j.ok) {
        toast("Job requeued — draining now", "success");
        void fetchFailedJobs();
        void poll();
      } else {
        toast(`Requeue failed: ${j.error}`, "error");
      }
    } catch (e: any) {
      toast(`Requeue failed: ${e.message}`, "error");
    } finally {
      setRequeueing(null);
    }
  }, [toast, fetchFailedJobs, poll]);

  const applySettings = useCallback(() => {
    setCompanyName(editCompany.trim());
    setProxyUrl(editProxy.trim());
    setFyDates(editFyFrom.trim(), editFyTo.trim());
    // Clamp interval inputs: non-negative integers, 0 = disabled.
    const todayM = Math.max(0, Math.round(Number(editTodayMins) || 0));
    const weekM  = Math.max(0, Math.round(Number(editWeekMins) || 0));
    const fyM    = Math.max(0, Math.round(Number(editFyMins) || 0));
    setSyncTodayMinutes(todayM);
    setSyncWeekMinutes(weekM);
    setSyncFyMinutes(fyM);
    setEditTodayMins(String(todayM));
    setEditWeekMins(String(weekM));
    setEditFyMins(String(fyM));
    toast("Settings saved", "success");
  }, [editCompany, editProxy, editFyFrom, editFyTo, editTodayMins, editWeekMins, editFyMins,
      setCompanyName, setProxyUrl, setFyDates, setSyncTodayMinutes, setSyncWeekMinutes, setSyncFyMinutes, toast]);

  // ── Derived values ────────────────────────────────────────────────────────
  const connected = health?.connected ?? false;
  /* `health` is null when OUR OWN server did not answer, which is a different
     failure from Tally being down and has a different fix. The Tally tile used
     to blame TallyPrime's port 9000 in both cases. */
  const localServerDown = health == null;
  const company = companyName || "—";

  /* The four facts, from status/agentFacts.ts — the same functions the Quick
     View window renders from. Each knows the difference between a measured
     value and one that was never read; the reasoning for each sits in that
     module, next to the field it reads. */
  const facts = [
    tallyFact(health, BASE_LABEL),
    drainFact(pushStatus),
    queueFact(pushStatus),
    cloudFact(cloudConfig, cloudMasters, cloudVouchers),
  ];

  /* Still needed below: the Supabase panel lists every channel individually,
     and the push-queue panel says whether a depth was ever counted. */
  const cloudOk = ![cloudConfig, cloudMasters, cloudVouchers].some((c) => c.success === false);

  /* Inbound files still waiting for this machine. Named once, because it is
     both the header badge and the thing the badge is counting. */
  const incomingWaiting = transfers.filter(
    (t) => t.status === "pending" && t.direction === "web_to_desktop",
  ).length;


  /* One reason, the first that applies. A flat-disabled button that says
     nothing is the difference between a two-second fix and a hunt through the
     log — four separate conditions used to produce the identical grey button. */
  const logErrorCount = logs.filter(isErrorLine).length;

  /* Named once and passed to both panels, so Quick Sync and Pull Sync can
     never give two different reasons for the same grey button — and so neither
     blames TallyPrime when it is this app's own server that is down. */
  const notConnectedReason = localServerDown
    ? `This app's own server on ${BASE_LABEL} is not answering, so Tally cannot be reached from here.`
    : "Tally is not answering, so there is nothing to pull from.";

  const pullBlocked =
    !connected ? notConnectedReason
    : !companyName.trim() ? "No company is set in Settings, so there is nothing to sync as."
    : null;

  /* The three Quick Sync windows ARE the three scheduled syncs — same labels,
     same ranges, driven by hooks/useScheduledSyncs.ts off these same three
     interval settings. Carrying the interval onto the button is the only place
     that fact is stated outside the collapsed Settings panel. */
  const quickRanges = [
    { label: "Today",       from: todayYmd(),    to: todayYmd(), everyMinutes: syncTodayMinutes },
    { label: "Last 7 days", from: daysAgoYmd(6), to: todayYmd(), everyMinutes: syncWeekMinutes  },
    { label: "This FY",     from: fyFromDate,    to: todayYmd(), everyMinutes: syncFyMinutes    },
  ];

  const ymd = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const daysBackYmd = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };

  const pullActions: PullAction[] = [
    {
      key: "full", label: "Full sync", icon: RefreshCw,
      note: "whole FY, day by day — slowest",
      /* Kept from the old panel and still true: a full-year detail pull is the
         heaviest thing this app can ask Tally for, and it sat one click away
         from the much narrower Masters button. */
      confirm: "Pull the FULL current financial year from Tally? This is the slowest option — Masters or Daybook is usually what you actually want.",
      run: () => triggerSync("/api/tally/sync", { company, fromDate: fyFromDate, toDate: fyToDate, mode: "full", chunkStrategy: "daily" }, "Full sync"),
    },
    {
      key: "masters", label: "Sync Masters", icon: PackageSearch,
      note: "items, ledgers, groups",
      run: () => triggerSync("/api/tally/sync-masters", { company }, "Sync Masters"),
    },
    {
      key: "daybook", label: "Sync Daybook", icon: CalendarRange,
      note: "every voucher in the FY window",
      run: () => triggerSync("/api/tally/sync-daybook", { company, fromDate: fyFromDate, toDate: fyToDate, chunkMode: "daily" }, "Sync Daybook"),
    },
    {
      /* One Tally request for the whole catalogue — measured at well under a
         second against the live company — so it does not belong behind a
         masters sync that takes minutes. */
      key: "price", label: "Price list", icon: Tag,
      note: "one request, whole catalogue",
      run: () => triggerSync("/api/tally/sync-price-list", { company, origin: "agent-ui" }, "Price list"),
    },
  ];

  const voucherWindows = ([
    ["Today", 0], ["Last week", 6], ["Last month", 29], ["3 months", 89],
  ] as [string, number][]).map(([label, back]) => ({
    label,
    run: () => triggerSync(
      "/api/tally/sync-daybook",
      { company, fromDate: daysBackYmd(back), toDate: ymd(new Date()), chunkMode: "daily" },
      `Vouchers ${label}`,
    ),
  }));

  return (
    /* `bg-bg-page`, the same ground the web dashboard paints. This was
       `bg-neutral-100`, a different off-white, so the two apps sat side by side
       on the same desk in visibly different greys. */
    <div className="min-h-screen bg-bg-page p-4 md:p-6">
      <div className="max-w-5xl mx-auto">
        {/* The web dashboard's own PageHeader, copied verbatim — same title
            sizing, same subtitle spacing, same title/actions row. The agent
            previously hand-rolled a smaller heading, which is why it read as a
            utility window rather than as part of the same product. */}
        <PageHeader
          title="Sync agent"
          subtitle={<>{company} · the only thing here that talks to Tally</>}
          actions={
            <>
              <UpdateChip state={update} currentVersion={appVersion} />
              <SyncStateIndicator isSyncing={isSyncing} syncingLabel={syncing} qsync={qsync} />
              <button
                onClick={() => { void poll(); void fetchHistory(); void fetchPushLog(); void fetchFailedJobs(); }}
                disabled={polling}
                title={polling ? "Already reading…" : "Re-read health, the push queue and the Supabase lists now. They refresh on their own every 10 s."}
                className="btn-secondary btn-sm"
              >
                <RefreshCw size={13} className={polling ? "animate-spin" : ""} />
                Refresh
              </button>
            </>
          }
        />

        {/* The four figures worth reading before anything else: is Tally there,
            is the drain running, how deep is the queue, and when did the mirror
            last move. They were scattered across four panels, each as a small
            pill, so the state of the system had to be assembled by eye. */}
        <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          {facts.map((f) => (
            <StatTile
              key={f.label}
              emphasis
              label={f.label}
              value={f.value}
              tone={toneToStatTile(f.tone)}
              tint={f.attention}
              sub={f.sub}
            />
          ))}
        </div>
      </div>

      {/* Above the status grid on purpose: this is the only thing on this screen
          that BLOCKS something, and a pending approval buried under status
          cards is a voucher that never gets booked. */}
      <div className="max-w-5xl mx-auto">
        <PendingPushes />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-5xl mx-auto">

        {/* ── Cloud / Supabase ──────────────────────────────────── */}
        <SectionCard title="Supabase Cloud" icon={cloudOk ? <Cloud size={15} /> : <CloudOff size={15} />}>
          <SupabaseCloudPanel
            config={cloudConfig}
            masters={cloudMasters}
            vouchers={cloudVouchers}
            canRead={!!sbRead}
            readHost={SUPA_URL ? new URL(SUPA_URL).host : null}
            fmtTime={fmt}
          />
        </SectionCard>

        {/* ── Tally ─────────────────────────────────────────────── */}
        <SectionCard title="Tally" icon={connected ? <Wifi size={15} /> : <WifiOff size={15} />}>
          <TallyPanel health={health} configuredCompany={companyName} base={BASE} />
        </SectionCard>

        {/* ── Quick Sync (Tally → then push → Supabase) ────────── */}
        <div className="md:col-span-2">
          <SectionCard title="Quick Sync  (Tally → then push → Supabase)" icon={<RefreshCw size={15} />}>
            <QuickSyncPanel
              ranges={quickRanges}
              qsync={qsync}
              connected={connected}
              notConnectedReason={notConnectedReason}
              company={companyName}
              otherSyncRunning={!!syncing || isSyncing}
              onRun={(r) => quickSync(r.label, r.from, r.to)}
            />
          </SectionCard>
        </div>

        {/* ── Pull Sync ─────────────────────────────────────────── */}
        <div className="md:col-span-2">
          <SectionCard title="Pull Sync  (Tally → Supabase)" icon={<Database size={15} />}>
            <PullSyncPanel
              actions={pullActions}
              windows={voucherWindows}
              runningLabel={syncing}
              busy={!!syncing || isSyncing || !!qsync.running}
              blocked={pullBlocked}
              history={syncHistory}
              canReadHistory={!!sbRead}
            />
          </SectionCard>
        </div>

        {/* ── Push Queue ────────────────────────────────────────── */}
        {/* Rebuilt in components/PushQueuePanel.tsx on the web dashboard's row
            idiom. The counts and the two health pills that used to open this
            panel now live in the KPI strip at the top of the page, so this is
            only the work behind them: what is stuck, what is waiting, what
            went. */}
        <div className="md:col-span-2">
          <SectionCard title="Push queue  (Supabase → Tally)" icon={<Activity size={15} />}>
            <PushQueuePanel
              status={pushStatus}
              unreachable={pushStatusUnreachable}
              baseLabel={BASE_LABEL}
              log={pushLog}
              failedJobs={failedJobs}
              draining={draining}
              onDrain={drainQueue}
              requeueingId={requeueing}
              onRequeue={requeueJob}
              fmtTime={fmt}
            />
          </SectionCard>
        </div>

        {/* ── The mirror, as this machine sees it ──────────────── */}
        {/* Sync history, data snapshot and a per-voucher push log — the three
            things the web dashboard has had and the agent did not, so the one
            screen in the office could report a failure without being able to
            say which voucher or why. */}
        <div className="md:col-span-2">
          <MirrorPanel />
        </div>

        {/* ── Logs ─────────────────────────────────────────────── */}
        {/* Rebuilt in components/LogsPanel.tsx. The header keeps only the
            error count, because that is the one thing worth seeing while the
            panel is still closed; everything else moved inside. */}
        <div className="md:col-span-2">
          <SectionCard
            title={`Logs${logs.length > 0 ? ` (${logs.length})` : ""}`}
            icon={<Activity size={15} />}
            open={showLogs}
            onOpenChange={setShowLogs}
            bodyClassName="px-3 py-3"
            badge={logErrorCount > 0 ? (
              <span className="text-[11px] font-semibold text-danger-700">
                {logErrorCount} error{logErrorCount === 1 ? "" : "s"}
              </span>
            ) : undefined}
          >
            <LogsPanel
              logs={logs}
              base={BASE}
              onCopy={(text) =>
                navigator.clipboard?.writeText(text).then(
                  () => toast("Logs copied", "success"),
                  () => toast("Copy failed", "error"),
                )
              }
            />
          </SectionCard>
        </div>

        {/* ── Settings ─────────────────────────────────────────── */}
        <div className="md:col-span-2">
          <SectionCard
            title="Settings"
            icon={<Settings size={15} />}
            open={showSettings}
            onOpenChange={setShowSettings}
            bodyClassName="px-4 py-4 grid grid-cols-1 sm:grid-cols-2 gap-4"
          >
            <>
                {([
                  ["Company name",       editCompany, setEditCompany],
                  ["Proxy URL",          editProxy,   setEditProxy],
                  ["FY from (YYYYMMDD)", editFyFrom,  setEditFyFrom],
                  ["FY to (YYYYMMDD)",   editFyTo,    setEditFyTo],
                ] as [string, string, (v: string) => void][]).map(([label, val, set]) => (
                  <label key={label} className="block">
                    <span className="text-xs text-neutral-500 mb-1 block">{label}</span>
                    <input
                      className="form-input w-full"
                      value={val}
                      onChange={e => set(e.target.value)}
                    />
                  </label>
                ))}

                {/* Scheduled quick syncs — the only automatic syncs. 0 = off. */}
                <div className="sm:col-span-2 mt-1 pt-3 border-t border-neutral-100">
                  <p className="text-xs font-medium text-neutral-600">Automatic sync intervals</p>
                  <p className="text-[10px] text-neutral-400">Each runs the matching Quick Sync (pull daily from Tally → push to Supabase). Only Today runs by default; set a value to enable the others (0 = off). No other auto-syncs run.</p>
                </div>
                <label className="block">
                  <span className="text-xs text-neutral-500 mb-1 block">Today — every (minutes)</span>
                  <input
                    type="number" min={0} step={1}
                    className="form-input w-full"
                    value={editTodayMins}
                    onChange={e => setEditTodayMins(e.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-neutral-500 mb-1 block">Last 7 days — every (minutes, 0 = off)</span>
                  <input
                    type="number" min={0} step={1}
                    className="form-input w-full"
                    value={editWeekMins}
                    onChange={e => setEditWeekMins(e.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-neutral-500 mb-1 block">This FY — every (minutes, 0 = off · heavy, use the button)</span>
                  <input
                    type="number" min={0} step={1}
                    className="form-input w-full"
                    value={editFyMins}
                    onChange={e => setEditFyMins(e.target.value)}
                  />
                </label>

                <div className="sm:col-span-2">
                  <Btn variant="primary" onClick={applySettings} title="Store these on this machine and use them from now on.">
                    Save settings
                  </Btn>
                </div>
            </>
          </SectionCard>
        </div>

        {/* ── File transfer ────────────────────────────────────── */}
        <div className="md:col-span-2">
          <SectionCard
            title="File transfer"
            icon={<Send size={15} />}
            open={showFileTransfer}
            onOpenChange={setShowFileTransfer}
            bodyClassName="px-4 py-4 space-y-4"
            badge={incomingWaiting > 0 ? (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-accent/10 text-accent-700">
                {incomingWaiting} new
              </span>
            ) : undefined}
          >
            <>
                {noBridgeReason && (
                  <p className="flex items-start gap-1.5 rounded-xl bg-warn-soft px-3 py-2.5 text-[12px] text-warn-800">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                    {noBridgeReason} The list below is still live.
                  </p>
                )}

                <div>
                  <p className="text-xs text-neutral-500 mb-1">Incoming files save to</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="min-w-0 flex-1 basis-48 truncate rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs">
                      {syncFolder || "not configured — files will wait until you choose one"}
                    </code>
                    <Btn onClick={() => void chooseSyncFolder()} disabledReason={noBridgeReason}>Choose folder</Btn>
                  </div>
                </div>

                <div>
                  <p className="text-xs text-neutral-500 mb-1">
                    Watch folder — drop a Tally export here and it uploads itself
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="min-w-0 flex-1 basis-48 truncate rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs">
                      {watchStatus?.dir || watchFolder || "not configured — nothing is being watched"}
                    </code>
                    <Btn onClick={() => void chooseWatchFolder()} disabledReason={noBridgeReason}>Choose folder</Btn>
                  </div>
                  {/* The path above is only the path last CHOSEN. Whether
                      anything is actually being watched is decided by chokidar
                      in the server, which answers at
                      /api/file-transfer/watch — a route that existed and was
                      read by nothing, so a watcher that failed to start (a
                      folder since deleted, or a path on a disconnected drive)
                      showed here as a configured, working watch folder.
                      (15-Sep-2026) */}
                  {watchStatus && (
                    <p className={`mt-1 text-[11px] ${watchStatus.watching ? "text-neutral-500" : "text-warn-800"}`}>
                      {watchStatus.watching
                        ? "The server is watching this folder now."
                        : "The server is NOT watching anything — a file dropped in this folder will sit there."}
                    </p>
                  )}
                  <p className="text-[11px] text-neutral-400 mt-1">
                    Must be a different folder from the one above, or files would loop back and forth.
                  </p>
                </div>

                <div>
                  <p className="text-xs text-neutral-500 mb-1">Send a file to the web dashboard</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      className="form-input min-w-0 flex-1 basis-48 text-xs"
                      placeholder="Note (optional)"
                      value={transferNote}
                      onChange={e => setTransferNote(e.target.value)}
                    />
                    <Btn
                      variant="primary"
                      onClick={() => void pushFileToWeb()}
                      disabled={pushingFile}
                      disabledReason={noBridgeReason ?? (companyName.trim() ? null : "No company is set in Settings, so a file has nothing to be filed under.")}
                    >
                      {pushingFile ? "Sending…" : "Choose file & send"}
                    </Btn>
                  </div>
                </div>

                <div>
                  <p className="text-xs text-neutral-500 mb-1">Recent transfers</p>
                  {/* "Nothing yet." used to be printed for three different
                      answers — there are no transfers, this machine has no
                      Supabase credentials, and the query failed — two of which
                      mean files may well be waiting. The server now says which.
                      (15-Sep-2026) */}
                  {transfersError ? (
                    <p className="flex items-start gap-1.5 rounded-xl bg-warn-soft px-3 py-2.5 text-[12px] text-warn-800">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                      <span>
                        The transfer list could not be read: {transfersError}. That is not the same as there being
                        none{transfersReadAt ? `; the last list that did come back was at ${new Date(transfersReadAt).toLocaleTimeString("en-IN")}` : ""}.
                      </span>
                    </p>
                  ) : transfers.length === 0 ? (
                    <p className="text-xs text-neutral-500">No transfers in either direction yet.</p>
                  ) : (
                    <div className="space-y-1.5 max-h-56 overflow-y-auto">
                      {transfers.map(t => (
                        <div key={t.id} className="flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg bg-neutral-50">
                          {/* Direction is a CATEGORY, not a state, so it is not
                              given a status colour: incoming takes the accent
                              because it is the only one that can still need
                              you, outgoing is neutral because it is done. */}
                          {t.direction === "web_to_desktop"
                            ? <Download size={12} className="text-accent flex-shrink-0" />
                            : <Upload size={12} className="text-neutral-500 flex-shrink-0" />}
                          <div className="flex-1 min-w-0">
                            <div className="truncate">{t.filename}</div>
                            <div className="flex items-center gap-1.5 text-[10px] text-neutral-400">
                              {t.kind && t.kind !== "unknown" && (
                                <span className="px-1 py-0.5 rounded bg-neutral-200 text-neutral-600 font-medium">
                                  {KIND_LABEL[t.kind]}
                                </span>
                              )}
                              <span>{fmt(t.created_at)}</span>
                            </div>
                          </div>
                          {/* Same three tones as every other status on this
                              screen: waiting is warn, done is success, put
                              aside is neutral. */}
                          <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
                            t.status === "pending" ? "bg-warn/10 text-warn-800"
                            : t.status === "downloaded" ? "bg-success/10 text-success-700"
                            : "bg-neutral-100 text-neutral-600"
                          }`}>{t.status}</span>
                          {t.direction === "web_to_desktop" && t.status === "pending" && (
                            <button
                              className="btn-icon h-9 w-9 shrink-0 tap disabled:opacity-50"
                              onClick={() => void dismissTransfer(t.id)}
                              disabled={transferBusy === t.id || !sbRead}
                              title={sbRead ? "Dismiss" : "This build has no Supabase read credentials, so it cannot mark a transfer dismissed."}
                              aria-label="Dismiss this transfer"
                            >
                              {transferBusy === t.id
                                ? <Loader2 size={14} className="animate-spin" />
                                : <XCircle size={14} />}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
            </>
          </SectionCard>
        </div>

        {/* ── Updates ───────────────────────────────────────────────
            Last on the page, and full width. It is the only section that is
            not about today's work: everything above answers "is the agent
            doing its job right now", and this answers "which build am I on" —
            a question asked occasionally and deliberately, not scanned.
            Full width because it ends the grid, and a half-width card beside
            nothing reads as a layout fault rather than a choice. */}
        <div className="md:col-span-2">
          <SectionCard title="Updates" icon={<Download size={15} />}>
            <UpdatesPanel />
          </SectionCard>
        </div>

      </div>

      {/* `agentId` is `os.hostname()#pid` from the server. When it is a dash the
          server did not answer — which is a fact about this app, not an agent
          named "—". */}
      <p className="mt-6 text-center text-xs text-neutral-400 max-w-5xl mx-auto">
        {pushStatus?.agentId
          ? `Agent: ${pushStatus.agentId}`
          : "The local server is not answering, so this window cannot name the agent."}
        {" · Auto-refresh every 10 s"}
      </p>
    </div>
  );
}
