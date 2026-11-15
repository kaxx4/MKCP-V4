import { SERVER_BASE } from "./config/serverUrl";
import { useState, useEffect, useCallback, useRef } from "react";
import { createClient, RealtimeChannel } from "@supabase/supabase-js";
import {
  RefreshCw, XCircle, Settings, AlertTriangle, Loader2, Send, Upload, Download, Tag, CalendarRange, PackageSearch, Terminal,
} from "lucide-react";
import { useTallyStore } from "./store/tallyStore";
import { useSupabaseSyncStatusStore } from "./store/supabaseSyncStatusStore";
import { useToast } from "./components/Toast";
import { todayYmd, daysAgoYmd } from "./services/tallyPull";
import { runQuickSync } from "./services/quickSync";
import { useQuickSyncStore } from "./store/quickSyncStore";
import { MirrorPanel } from "./MirrorPanel";
import { PageHeader } from "./components/PageHeader";
import { Card, Chip, Note, Row, RowList, Tile } from "./components/ui";
/* Every section below is a card from components/ui.tsx. The panels were once inline in this file; each now lives in its own file, built from the
   same parts, so the window reads as one system. See each file's header for what it shows and why. */
import { PushQueueCard } from "./components/PushQueuePanel";
import { PrimaryCard } from "./components/PrimaryCard";
import { TallyCard } from "./components/TallyPanel";
import { SupabaseCloudCard } from "./components/SupabaseCloudPanel";
import { QuickSyncCard } from "./components/QuickSyncPanel";
import { type PullAction } from "./components/PullSyncPanel";
import { LogsPanel, isErrorLine } from "./components/LogsPanel";
import { UpdatesCard } from "./components/UpdatesPanel";
/* The readings are derived here AND in QuickView.tsx, so the reasoning lives in one module rather than in whichever window was edited last. The
   part that must not drift is telling "zero" apart from "never counted". */
import { tallyFact, drainFact, queueFact, cloudFact } from "./status/agentFacts";
/* After go-live the office agent runs in primary mode. These are the same plain-English facts the Quick View window reads. */
import { officeFact, claimFact, mirrorRunFact, primaryIsOn, type PrimarySummaryLike } from "./status/primaryFacts";

const SUPA_URL = (import.meta as any).env?.VITE_SUPABASE_URL as string | undefined;
const SUPA_ANON = (import.meta as any).env?.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const sbRead = SUPA_URL && SUPA_ANON
  ? createClient(SUPA_URL, SUPA_ANON, { auth: { persistSession: false } })
  : null;

const BASE = SERVER_BASE;
/** The server address (SERVER_BASE) — the same host:port string in the KPI strip, the push
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
  if (!iso) return "none";
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
/** What the agent is doing right now, in one pill: idle, syncing (and which part), done, skipped or failed (with the actual reason, in full). */
function SyncStateIndicator({
  isSyncing, syncingLabel, qsync,
}: {
  isSyncing: boolean;
  syncingLabel: string | null;
  qsync: import("./store/quickSyncStore").QuickSyncState;
}) {
  if (qsync.running) {
    const phaseLabel = qsync.phase === "push" ? "sending to the online database" : "reading from Tally";
    return (
      <span className="pill pill-live">
        <Loader2 size={16} className="animate-spin" /> Syncing, {phaseLabel}
      </span>
    );
  }
  if (isSyncing) {
    return (
      <span className="pill pill-live">
        <Loader2 size={16} className="animate-spin" /> Syncing{syncingLabel ? `, ${syncingLabel}` : ""}
      </span>
    );
  }
  // A skip shows only while it is newer than the last real finish; a later completed sync supersedes it by the timestamps alone.
  if (qsync.lastSkipped && (!qsync.finishedAt || qsync.lastSkipped.at > qsync.finishedAt)) {
    const reasonLabel = qsync.lastSkipped.reason === "sync-in-progress"
      ? "another sync was already running"
      : qsync.lastSkipped.reason === "not-connected"
        ? "Tally was not connected"
        : "no company is set";
    return <span className="pill pill-warn">{qsync.lastSkipped.label} sync skipped, {reasonLabel}</span>;
  }
  if (qsync.finishedAt) {
    if (qsync.ok) return <span className="pill pill-good">Synced {fmt(qsync.finishedAt)}</span>;
    const errMsg = qsync.tally && !qsync.tally.ok
      ? qsync.tally.error || "The read from Tally failed"
      : qsync.push && !qsync.push.ok
        ? qsync.push.vouchersErr || qsync.push.configErr || "The send to the online database failed"
        : "The sync failed";
    return <span className="pill pill-bad wrap-anywhere max-w-sm">Failed: {errMsg}</span>;
  }
  return <span className="pill">Idle</span>;
}

/**
 * The small button used by Settings and File transfer. `disabledReason` is not decoration: a flat grey button that says nothing is the difference
 * between a two-second fix and a hunt through the log. When it is given it becomes the tooltip AND the accessible description, and the button is
 * disabled from that fact rather than from a separate flag.
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
      className={`${cls} shrink-0`}
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
  /* The office computer's answer (GET /api/primary/summary). Null until read, and also null when the local server did not answer;
     `primaryRead` tells the two apart so an unread card is not shown as a failed one. */
  const [primary, setPrimary] = useState<PrimarySummaryLike | null>(null);
  const [primaryRead, setPrimaryRead] = useState(false);
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
    } catch { /* server not up yet. Ignore */ }
  }, []);

  // ── Poll — only hits local server endpoints (not Supabase) ───────────────
  const poll = useCallback(async () => {
    setPolling(true);
    try {
      const [h, p, office] = await Promise.all([
        fetch(`${BASE}/api/tally/health`).then(r => r.json()).catch(() => null),
        fetch(`${BASE}/api/push-agent/status`).then(r => r.json()).catch(() => null),
        fetch(`${BASE}/api/primary/summary`).then(r => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      setHealth(h);
      setPrimary(office);
      setPrimaryRead(true);
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

  /* The version actually RUNNING, shown beside the title and handed to the Updates card, so "1.5.18 is ready" is always read against the version
     that is running. */
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
    : "Only the installed desktop app can open a folder picker. This window is running in a browser.";

  const chooseWatchFolder = useCallback(async () => {
    const api = (window as any).electronAPI;
    if (!api?.pickWatchFolder) return;
    const res = await api.pickWatchFolder();
    if (res?.ok) {
      setWatchFolder(res.path);
      toast("Anything dropped in this folder will be sent up by itself", "success");
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
      toast(`That file could not be sent: ${err.message}`, "error");
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
      toast(`${label}: the read from Tally failed: ${r.tally?.error ?? "no reason given"}`, "error");
    } else {
      toast(
        r.ok ? `${label}: read ${r.tally.vouchers} voucher(s) from Tally and sent them to the online database` : `${label}: read from Tally, but the send to the online database had errors`,
        r.ok ? "success" : "error",
      );
    }
  }, [companyName, toast, fetchHistory, fetchPushLog]);

  // ── Actions (stable refs via useCallback) ────────────────────────────────
  const triggerSync = useCallback(async (endpoint: string, body: Record<string, unknown>, label: string) => {
    // Respect the global lock — never start a manual sync while another sync
    // (manual, scheduled, or quick) is running.
    if (useTallyStore.getState().isSyncing) { toast("A sync is already running. Please wait.", "info"); return; }
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
      toast("Sending started", "success");
    } catch { toast("Sending could not be started", "error"); }
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
        toast("Put back in the queue and sent on its way", "success");
        void fetchFailedJobs();
        void poll();
      } else {
        toast(`It could not be put back in the queue: ${j.error}`, "error");
      }
    } catch (e: any) {
      toast(`It could not be put back in the queue: ${e.message}`, "error");
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
  const company = companyName || "none";

  /* The readings, from status/agentFacts.ts and status/primaryFacts.ts: the same functions the Quick View window renders from. Each knows the
     difference between a measured value and one that was never read; the reasoning for each sits in that module, next to the field it reads.
     Each one now sits in the card it is about: Tally's and the online database's in their own cards, the sender's or the office computer's in the
     sending card. In office (primary) mode the old push drain and its queue depth describe a queue nothing uses, so they give way to the office
     readings. When the mode is off, the readings are exactly what they were. */
  const officeOn = primaryIsOn(primary);
  const tallyFactNow = tallyFact(health, BASE_LABEL);
  const cloudFactNow = cloudFact(cloudConfig, cloudMasters, cloudVouchers);
  const officeFacts = [officeFact(primary), claimFact(primary), mirrorRunFact(primary)];
  const oldSenderFacts = [drainFact(pushStatus), queueFact(pushStatus)];

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
      note: "the whole year, one day at a time. The slowest",
      /* Kept from the old panel and still true: a full-year detail pull is the
         heaviest thing this app can ask Tally for, and it sat one click away
         from the much narrower Masters button. */
      confirm: "Read the WHOLE financial year from Tally? This is the slowest option. \"Parties and items\" or \"All vouchers\" is usually what you want.",
      run: () => triggerSync("/api/tally/sync", { company, fromDate: fyFromDate, toDate: fyToDate, mode: "full", chunkStrategy: "daily" }, "Full sync"),
    },
    {
      key: "masters", label: "Parties and items", icon: PackageSearch,
      note: "items, parties and groups",
      run: () => triggerSync("/api/tally/sync-masters", { company }, "Parties and items"),
    },
    {
      key: "daybook", label: "All vouchers", icon: CalendarRange,
      note: "every voucher in the financial year",
      run: () => triggerSync("/api/tally/sync-daybook", { company, fromDate: fyFromDate, toDate: fyToDate, chunkMode: "daily" }, "All vouchers"),
    },
    {
      /* One Tally request for the whole catalogue — measured at well under a
         second against the live company — so it does not belong behind a
         masters sync that takes minutes. */
      key: "price", label: "Price list", icon: Tag,
      note: "the whole catalogue in one go",
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
    <div className="min-h-screen bg-bg-page p-4 md:p-5">
      <div className="mx-auto flex max-w-page flex-col gap-4">
        {/* ── The header band: the app and its version, what it is doing now, a refresh, and the Updates card right under it ───────────────── */}
        <header className="flex flex-col gap-4">
          <PageHeader
            className="!mb-0"
            title={
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                Sync agent
                {appVersion && <Chip plain>Version {appVersion}</Chip>}
              </span>
            }
            subtitle={<>{company} · the only program here that talks to Tally</>}
            actions={
              <>
                <SyncStateIndicator isSyncing={isSyncing} syncingLabel={syncing} qsync={qsync} />
                <button
                  onClick={() => { void poll(); void fetchHistory(); void fetchPushLog(); void fetchFailedJobs(); }}
                  disabled={polling}
                  title={polling ? "Already reading." : "Read everything again now. It refreshes on its own every 10 seconds."}
                  className="btn-secondary"
                >
                  <RefreshCw size={16} className={polling ? "animate-spin" : ""} />
                  Refresh
                </button>
              </>
            }
          />
          <UpdatesCard currentVersion={appVersion} />
        </header>

        {/* ── Quick sync, with the other reads from Tally and the history behind them ─────────────────────────────────────────────────────── */}
        <QuickSyncCard
          ranges={quickRanges}
          qsync={qsync}
          connected={connected}
          notConnectedReason={notConnectedReason}
          company={companyName}
          otherSyncRunning={!!syncing || isSyncing}
          onRun={(r) => quickSync(r.label, r.from, r.to)}
          pullActions={pullActions}
          pullWindows={voucherWindows}
          pullRunningLabel={syncing}
          pullBusy={!!syncing || isSyncing || !!qsync.running}
          history={syncHistory}
          canReadHistory={!!sbRead}
        />

        {/* ── The two things everything depends on: the online database and Tally ─────────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <SupabaseCloudCard
            config={cloudConfig}
            masters={cloudMasters}
            vouchers={cloudVouchers}
            fact={cloudFactNow}
            canRead={!!sbRead}
            readHost={SUPA_URL ? new URL(SUPA_URL).host : null}
            fmtTime={fmt}
          />
          <TallyCard health={health} fact={tallyFactNow} configuredCompany={companyName} base={BASE} />
        </div>

        {/* ── Sending to Tally ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
            Office mode: the office computer's card, which carries the office readings. Otherwise the old push queue, which lists, drains and
            re-queues rows of a queue nothing feeds after go-live. Until the first answer arrives neither card is drawn, so a reading in progress
            never looks like the other mode. */}
        {officeOn ? (
          <PrimaryCard
            summary={primary}
            facts={officeFacts}
            baseLabel={BASE_LABEL}
            onRefresh={() => void poll()}
            refreshing={polling}
            onCopy={(text) =>
              navigator.clipboard?.writeText(text).then(
                () => toast("Fingerprint copied", "success"),
                () => toast("It could not be copied", "error"),
              )
            }
          />
        ) : primaryRead ? (
          <PushQueueCard
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
            facts={oldSenderFacts}
          />
        ) : null}

        {/* ── The mirror, as this machine sees it ─────────────────────────────────────────────────────────────────────────────────────── */}
        <MirrorPanel showOldQueue={!officeOn} />

        {/* ── File transfer ───────────────────────────────────────────────────────────────────────────────────────────────────────────── */}
        <Card
          collapsible
          icon={Send}
          title="File transfer"
          sub="Files that move between this computer and the web dashboard."
          chip={incomingWaiting > 0 ? <Chip tone="info">{incomingWaiting} new</Chip> : undefined}
          defaultOpen={false}
          open={showFileTransfer}
          onOpenChange={setShowFileTransfer}
        >
          {noBridgeReason && (
            <Note tone="warn" icon={AlertTriangle}>
              <p>{noBridgeReason} The list below is still live.</p>
            </Note>
          )}

          <Tile title="Incoming files are saved to">
            <div className="flex flex-wrap items-center gap-2">
              <div className="field-read min-w-0 flex-1 basis-48 wrap-anywhere">
                {syncFolder || "not chosen yet, so files will wait until you choose a folder"}
              </div>
              <Btn onClick={() => void chooseSyncFolder()} disabledReason={noBridgeReason}>Choose folder</Btn>
            </div>
          </Tile>

          <Tile title="Watch folder" aside="drop a Tally export here and it uploads by itself">
            <div className="flex flex-wrap items-center gap-2">
              <div className="field-read min-w-0 flex-1 basis-48 wrap-anywhere">
                {watchStatus?.dir || watchFolder || "not chosen yet, so nothing is being watched"}
              </div>
              <Btn onClick={() => void chooseWatchFolder()} disabledReason={noBridgeReason}>Choose folder</Btn>
            </div>
            {/* The path above is only the folder last CHOSEN. Whether anything is actually being watched is decided by the server. */}
            {watchStatus && (
              <p className="mt-3 flex items-center gap-2">
                <Chip tone={watchStatus.watching ? "good" : "warn"}>{watchStatus.watching ? "Watching" : "Not watching"}</Chip>
                <span className={`text-xs ${watchStatus.watching ? "text-neutral-700" : "text-warn-700"}`}>
                  {watchStatus.watching
                    ? "The server is watching this folder now."
                    : "The server is NOT watching anything. A file dropped in this folder will just sit there."}
                </span>
              </p>
            )}
            <p className="mt-2 text-xs text-neutral-700">
              It must be a different folder from the one above, or files would go back and forth forever.
            </p>
          </Tile>

          <Tile title="Send a file to the web dashboard">
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="form-input min-w-0 flex-1 basis-48"
                placeholder="A note to go with it (optional)"
                aria-label="A note to go with the file"
                value={transferNote}
                onChange={e => setTransferNote(e.target.value)}
              />
              <Btn
                variant="primary"
                onClick={() => void pushFileToWeb()}
                disabled={pushingFile}
                disabledReason={noBridgeReason ?? (companyName.trim() ? null : "No company is set in Settings, so a file has nothing to be filed under.")}
              >
                {pushingFile ? "Sending" : "Choose a file and send it"}
              </Btn>
            </div>
          </Tile>

          <Tile title="Recent transfers">
            {/* "None" was once printed for three different answers: there are none, this computer cannot read the list, and the read failed.
                The server now says which. */}
            {transfersError ? (
              <Note tone="warn" icon={AlertTriangle}>
                <p>
                  The transfer list could not be read: {transfersError}. That is not the same as there being none
                  {transfersReadAt ? `. The last list that did come back was at ${new Date(transfersReadAt).toLocaleTimeString("en-IN")}` : ""}.
                </p>
              </Note>
            ) : transfers.length === 0 ? (
              <p className="text-sm text-neutral-700">No transfers in either direction yet.</p>
            ) : (
              <div className="max-h-72 overflow-y-auto">
                <RowList>
                  {transfers.map(t => (
                    <Row
                      key={t.id}
                      /* Direction is a CATEGORY, not a state, so it gets no status colour: incoming takes the accent because it is the only one
                         that can still need you; outgoing is neutral because it is done. */
                      icon={t.direction === "web_to_desktop" ? Download : Upload}
                      tone={t.direction === "web_to_desktop" ? "accent" : "neutral"}
                      title={t.filename}
                      meta={<>{t.kind && t.kind !== "unknown" ? `${KIND_LABEL[t.kind]}, ` : ""}{fmt(t.created_at)}</>}
                      chip={
                        <Chip tone={t.status === "pending" ? "warn" : t.status === "downloaded" ? "good" : "neutral"}>
                          {t.status === "pending" ? "waiting" : t.status === "downloaded" ? "received" : "put aside"}
                        </Chip>
                      }
                      action={
                        t.direction === "web_to_desktop" && t.status === "pending" ? (
                          <button
                            className="btn-icon shrink-0"
                            onClick={() => void dismissTransfer(t.id)}
                            disabled={transferBusy === t.id || !sbRead}
                            title={sbRead ? "Put this one aside" : "This build has no read access to the online database, so it cannot put a transfer aside."}
                            aria-label="Put this transfer aside"
                          >
                            {transferBusy === t.id ? <Loader2 size={16} className="animate-spin" /> : <XCircle size={16} />}
                          </button>
                        ) : undefined
                      }
                    />
                  ))}
                </RowList>
              </div>
            )}
          </Tile>
        </Card>

        {/* ── Settings ────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */}
        <Card
          collapsible
          icon={Settings}
          title="Settings"
          sub="The company this computer syncs as, the financial year, and how often it syncs by itself."
          defaultOpen={false}
          open={showSettings}
          onOpenChange={setShowSettings}
        >
          <Tile title="Company and financial year">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {([
                ["Company name",                     editCompany, setEditCompany],
                ["Local server address",             editProxy,   setEditProxy],
                ["Financial year starts (YYYYMMDD)", editFyFrom,  setEditFyFrom],
                ["Financial year ends (YYYYMMDD)",   editFyTo,    setEditFyTo],
              ] as [string, string, (v: string) => void][]).map(([label, val, set]) => (
                <label key={label} className="block">
                  <span className="mb-1 block text-sm text-neutral-700">{label}</span>
                  <input className="form-input" value={val} onChange={e => set(e.target.value)} />
                </label>
              ))}
            </div>
          </Tile>

          {/* The scheduled quick syncs are the only automatic syncs. 0 turns one off. */}
          <Tile title="Automatic sync timing">
            <p className="mb-3 text-sm text-neutral-700">
              Each one runs the matching quick sync: read the days from Tally, then send them to the online database. Only "Today" runs by
              default. Type 0 to turn one off. Nothing else syncs by itself.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="flex flex-col">
                <span className="mb-1 block text-sm text-neutral-700">Today: every how many minutes</span>
                <input type="number" min={0} step={1} className="form-input mt-auto" value={editTodayMins} onChange={e => setEditTodayMins(e.target.value)} />
              </label>
              <label className="flex flex-col">
                <span className="mb-1 block text-sm text-neutral-700">Last 7 days: every how many minutes (0 is off)</span>
                <input type="number" min={0} step={1} className="form-input mt-auto" value={editWeekMins} onChange={e => setEditWeekMins(e.target.value)} />
              </label>
              <label className="flex flex-col">
                <span className="mb-1 block text-sm text-neutral-700">This financial year: every how many minutes (0 is off, heavy, use the button instead)</span>
                <input type="number" min={0} step={1} className="form-input mt-auto" value={editFyMins} onChange={e => setEditFyMins(e.target.value)} />
              </label>
            </div>
          </Tile>

          <div className="px-3 pb-1 pt-1">
            <Btn variant="primary" onClick={applySettings} title="Keep these on this computer and use them from now on.">
              Save settings
            </Btn>
          </div>
        </Card>

        {/* ── Logs, last ──────────────────────────────────────────────────────────────────────────────────────────────────────────────── */}
        <Card
          collapsible
          icon={Terminal}
          title={`Logs${logs.length > 0 ? ` (${logs.length})` : ""}`}
          sub="What this app's server has been doing, line by line."
          defaultOpen={false}
          open={showLogs}
          onOpenChange={setShowLogs}
          chip={logErrorCount > 0 ? <Chip tone="bad">{logErrorCount} error{logErrorCount === 1 ? "" : "s"}</Chip> : undefined}
        >
          <LogsPanel
            logs={logs}
            base={BASE}
            onCopy={(text) =>
              navigator.clipboard?.writeText(text).then(
                () => toast("Logs copied", "success"),
                () => toast("They could not be copied", "error"),
              )
            }
          />
        </Card>

        {/* `agentId` is the computer's name and a number, from the server. When it is missing the server did not answer, which is a fact about
            this app and not an agent named "none". */}
        <p className="text-center text-xs text-neutral-700">
          {pushStatus?.agentId
            ? `Agent: ${pushStatus.agentId}`
            : "The local server is not answering, so this window cannot name the agent."}
          {" · Refreshes by itself every 10 seconds"}
        </p>
      </div>
    </div>
  );
}
