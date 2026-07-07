import { useState, useEffect, useCallback, useRef } from "react";
import { createClient, RealtimeChannel } from "@supabase/supabase-js";
import {
  Wifi, WifiOff, RefreshCw, Cloud, CloudOff, CheckCircle, XCircle,
  Clock, Activity, ChevronDown, ChevronUp, Settings, Database,
  AlertTriangle, Loader2, RotateCcw, ChevronRight,
} from "lucide-react";
import { useTallyStore } from "./store/tallyStore";
import { useSupabaseSyncStatusStore } from "./store/supabaseSyncStatusStore";
import { useToast } from "./components/Toast";
import { todayYmd, daysAgoYmd } from "./services/tallyPull";
import { runQuickSync } from "./services/quickSync";
import { useQuickSyncStore } from "./store/quickSyncStore";

const SUPA_URL = (import.meta as any).env?.VITE_SUPABASE_URL as string | undefined;
const SUPA_ANON = (import.meta as any).env?.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const sbRead = SUPA_URL && SUPA_ANON
  ? createClient(SUPA_URL, SUPA_ANON, { auth: { persistSession: false } })
  : null;

const BASE = (import.meta as any).env?.VITE_TALLY_PROXY || "http://localhost:3100";

// ── Types ────────────────────────────────────────────────────────────────────
interface PushAgentStatus {
  enabled: boolean;
  agentId: string;
  lastTick: string | null;
  tallyHealthy: boolean;
  claimedCount: number;
  last10Results: Array<{ id: string; idempotency_key: string; status: string; error?: string; at: string }>;
  queueStats: { pending: number; pushing: number; failed: number };
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
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

function fmtDur(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

// ── Shared UI components ──────────────────────────────────────────────────────
function Pill({ ok, label }: { ok: boolean | null; label: string }) {
  if (ok === null) return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-neutral-100 text-neutral-500">
      <Clock size={11} /> {label}
    </span>
  );
  return ok ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-green-50 text-green-700 font-medium">
      <CheckCircle size={11} /> {label}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-red-50 text-red-700 font-medium">
      <XCircle size={11} /> {label}
    </span>
  );
}

/** Compact, always-visible sync-state indicator — idle / syncing(phase) / succeeded /
 *  failed(actual error). Reads only from stores already populated by every sync path
 *  (quickSyncStore for quick-sync, tallyStore.isSyncing for manual full/masters/daybook
 *  triggers) — no new store. */
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
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-blue-50 text-blue-700">
        <Loader2 size={12} className="animate-spin" /> Syncing · {phaseLabel}
      </span>
    );
  }
  if (isSyncing) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-blue-50 text-blue-700">
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
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-50 text-amber-700">
        <AlertTriangle size={12} /> {qsync.lastSkipped.label} sync skipped — {reasonLabel}
      </span>
    );
  }
  if (qsync.finishedAt) {
    if (qsync.ok) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-green-50 text-green-700">
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
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-red-50 text-red-700 max-w-[360px] truncate"
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

function Badge({ label, color }: { label: string; color: "green" | "red" | "yellow" | "blue" | "gray" }) {
  const cls = {
    green: "bg-green-100 text-green-800",
    red: "bg-red-100 text-red-800",
    yellow: "bg-yellow-100 text-yellow-800",
    blue: "bg-blue-100 text-blue-800",
    gray: "bg-neutral-100 text-neutral-600",
  }[color];
  return <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${cls}`}>{label}</span>;
}

function SectionCard({ title, icon, children, defaultOpen = true }: {
  title: string; icon: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
      <button
        className="flex items-center gap-2 px-4 py-3 border-b border-neutral-100 bg-neutral-50 w-full text-left"
        onClick={() => setOpen(v => !v)}
      >
        <span className="text-neutral-500">{icon}</span>
        <h2 className="font-semibold text-sm text-neutral-700 flex-1">{title}</h2>
        {open ? <ChevronUp size={14} className="text-neutral-400" /> : <ChevronDown size={14} className="text-neutral-400" />}
      </button>
      {open && <div className="px-4 py-3">{children}</div>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm border-b border-neutral-50 last:border-0">
      <span className="text-neutral-500 text-xs">{label}</span>
      <span className="text-neutral-800 font-medium text-right ml-4 max-w-[200px] truncate">{value}</span>
    </div>
  );
}

function Btn({ onClick, disabled, children, variant = "secondary" }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode; variant?: "primary" | "secondary" | "danger";
}) {
  const cls = {
    primary: "bg-blue-600 text-white hover:bg-blue-700",
    secondary: "border border-neutral-200 bg-white hover:bg-neutral-50 text-neutral-700",
    danger: "border border-red-200 bg-red-50 hover:bg-red-100 text-red-700",
  }[variant];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg disabled:opacity-50 disabled:cursor-not-allowed ${cls}`}
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
  const lastSyncAt         = useTallyStore((s) => s.lastSyncAt);
  const lastMastersSyncAt  = useTallyStore((s) => s.lastMastersSyncAt);
  const lastVouchersSyncAt = useTallyStore((s) => s.lastVouchersSyncAt);
  const lastVoucherDate    = useTallyStore((s) => s.lastVoucherDate);
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
  const [polling, setPolling] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [draining, setDraining] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [syncHistory, setSyncHistory] = useState<SyncHistoryRow[]>([]);
  const [pushLog, setPushLog] = useState<PushLogRow[]>([]);
  const [failedJobs, setFailedJobs] = useState<FailedQueueRow[]>([]);
  const [requeueing, setRequeueing] = useState<string | null>(null);
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());
  const qsync = useQuickSyncStore();
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [logFilter, setLogFilter] = useState<"all" | "errors" | "tally" | "supabase" | "remote" | "auto">("all");
  const logsBoxRef = useRef<HTMLDivElement | null>(null);
  const logsAutoScrollRef = useRef(true);

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

  // ── Live log polling — only while the Logs panel is open (every 2s) ───────
  useEffect(() => {
    if (!showLogs) return;
    void fetchLogs();
    const id = setInterval(() => void fetchLogs(), 2000);
    return () => clearInterval(id);
  }, [showLogs, fetchLogs]);

  // Keep the log box pinned to the bottom unless the user scrolled up.
  useEffect(() => {
    const el = logsBoxRef.current;
    if (el && logsAutoScrollRef.current) el.scrollTop = el.scrollHeight;
  }, [logs, logFilter]);

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

  const toggleError = useCallback((id: string) => {
    setExpandedErrors(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // ── Derived values ────────────────────────────────────────────────────────
  const connected = health?.connected ?? false;
  const company = companyName || "—";
  const cloudOk = cloudConfig.success !== false && cloudMasters.success !== false && cloudVouchers.success !== false;
  const cloudLastAt = cloudVouchers.lastAt || cloudMasters.lastAt || cloudConfig.lastAt;
  const qs = pushStatus?.queueStats ?? { pending: 0, pushing: 0, failed: 0 };

  const cloudChannels = [
    ["config",   cloudConfig]   as const,
    ["masters",  cloudMasters]  as const,
    ["vouchers", cloudVouchers] as const,
  ];

  // ── Log filtering ──────────────────────────────────────────────────────────
  // Genuine errors carry the ❌/✗ marker (the server prefixes every console.error
  // with ❌). Also catch explicit failure words, but NOT benign "(0 errors)" summaries.
  const isErrorLine = (l: string) => /❌|✗/.test(l) || /\bfailed\b|\bexception\b|\brejected\b/i.test(l);
  const errorLogCount = logs.filter(isErrorLine).length;
  const visibleLogs = logs.filter((l) => {
    if (logFilter === "errors")   return isErrorLine(l);
    if (logFilter === "tally")    return /\[tally\]|\[DAYBOOK\]|\[SYNC\]|\[MASTERS\]|\[convert\]|\[PUSH-TEST\]/i.test(l);
    if (logFilter === "supabase") return /\[Supabase\]|\[pushAgent\]|\[Auto-push|\[Config Sync\]/i.test(l);
    if (logFilter === "remote")   return /🌐|\[WEB-SYNC\]/.test(l);  // web-triggered (Supabase) refresh
    if (logFilter === "auto")     return /🌙|\[NIGHTLY\]|origin=scheduled-/i.test(l);   // any of the 4 automatic triggers: nightly full-FY + the 3 scheduled quick syncs
    return true;
  });

  return (
    <div className="min-h-screen bg-neutral-100 p-4 md:p-6">
      {/* Header */}
      <div className="mb-5 flex items-center justify-between max-w-5xl mx-auto">
        <div>
          <h1 className="text-xl font-bold text-neutral-900">MKCP Sync Agent</h1>
          <p className="text-xs text-neutral-500 mt-0.5">{company}</p>
        </div>
        <div className="flex items-center gap-2">
          <SyncStateIndicator isSyncing={isSyncing} syncingLabel={syncing} qsync={qsync} />
          <button
            onClick={() => { void poll(); void fetchHistory(); void fetchPushLog(); void fetchFailedJobs(); }}
            disabled={polling}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-neutral-200 bg-white hover:bg-neutral-50 text-neutral-600 disabled:opacity-50"
          >
            <RefreshCw size={13} className={polling ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-5xl mx-auto">

        {/* ── Tally Connection ──────────────────────────────────── */}
        <SectionCard title="Tally" icon={connected ? <Wifi size={15} /> : <WifiOff size={15} />}>
          <Row label="Status" value={<Pill ok={connected} label={connected ? "Connected" : "Disconnected"} />} />
          <Row label="URL" value={health?.tallyUrl || BASE} />
          <Row label="Company" value={health?.current || company} />
          {!connected && health?.error && (
            <p className="mt-2 text-xs text-red-600 bg-red-50 rounded p-2">{health.error}</p>
          )}
        </SectionCard>

        {/* ── Cloud / Supabase ──────────────────────────────────── */}
        <SectionCard title="Supabase Cloud" icon={cloudOk ? <Cloud size={15} /> : <CloudOff size={15} />}>
          {cloudChannels.map(([ch, chCloud]) => (
            <Row key={ch} label={ch.charAt(0).toUpperCase() + ch.slice(1)} value={
              <span className="flex items-center gap-1">
                <Pill ok={chCloud.success} label={
                  chCloud.success == null ? "Never" : chCloud.success ? "OK" : "Error"
                } />
                {chCloud.retryScheduled && (
                  <span className="text-[10px] text-yellow-600">retry ~60s</span>
                )}
              </span>
            } />
          ))}
          <Row label="Last pushed" value={fmt(cloudLastAt)} />
          {cloudChannels.map(([ch, chCloud]) =>
            chCloud.error && chCloud.success === false ? (
              <p key={`err-${ch}`} className="mt-1 text-xs text-red-600 bg-red-50 rounded p-2 truncate" title={chCloud.error}>
                <span className="font-medium capitalize">{ch}:</span> {chCloud.error}
              </p>
            ) : null
          )}
        </SectionCard>

        {/* ── Quick Sync (Tally → then → Supabase) ──────────────── */}
        <div className="md:col-span-2">
          <SectionCard title="Quick Sync  (Tally → then push → Supabase)" icon={<RefreshCw size={15} />}>
            <p className="text-xs text-neutral-500 mb-2">
              Pulls daily from Tally, then pushes to Supabase once the pull finishes (never during a sync).
            </p>
            <div className="flex gap-2 flex-wrap mb-3">
              {([
                ["Today",        todayYmd(),        todayYmd()],
                ["Last 7 days",  daysAgoYmd(6),     todayYmd()],
                ["This FY",      fyFromDate,        todayYmd()],
              ] as [string, string, string][]).map(([label, from, to]) => {
                const running = qsync.running === label;
                return (
                  <Btn key={label} variant={label === "Last 7 days" ? "primary" : "secondary"}
                    onClick={() => quickSync(label, from, to)}
                    disabled={!!qsync.running || !!syncing || isSyncing || !connected}>
                    {running
                      ? <><Loader2 size={12} className="animate-spin" /> {qsync.phase === "push" ? "Pushing…" : "Syncing…"}</>
                      : <><RefreshCw size={12} /> {label}</>}
                  </Btn>
                );
              })}
            </div>

            {/* Two-phase result with clear success / error + statistics */}
            {(qsync.tally || qsync.running) && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                {/* Phase 1 — Tally */}
                <div className="rounded-lg border border-neutral-200 p-2.5">
                  <div className="flex items-center gap-1.5 mb-1">
                    {qsync.running && qsync.phase === "sync"
                      ? <Loader2 size={13} className="animate-spin text-blue-500" />
                      : qsync.tally?.ok ? <CheckCircle size={13} className="text-green-600" /> : qsync.tally ? <XCircle size={13} className="text-red-600" /> : <Clock size={13} className="text-neutral-400" />}
                    <span className="font-semibold text-neutral-700">1 · Tally pull</span>
                  </div>
                  {qsync.tally ? (
                    qsync.tally.ok ? (
                      <div className="text-neutral-600 space-y-0.5">
                        <div><span className="font-medium text-neutral-800">{qsync.tally.vouchers}</span> voucher(s) pulled{qsync.tally.cleared > 0 ? <> · <span className="text-amber-700">{qsync.tally.cleared} cleared</span></> : null}</div>
                        <div className="text-neutral-400">{qsync.tally.chunksSucceeded}/{qsync.tally.chunksTotal} chunks{qsync.tally.chunksFailed > 0 ? <span className="text-red-600"> · {qsync.tally.chunksFailed} failed</span> : null} · {qsync.tally.elapsedSeconds}s</div>
                      </div>
                    ) : (
                      <div className="text-red-600 break-words">{qsync.tally.error}</div>
                    )
                  ) : <div className="text-neutral-400">{qsync.phase === "sync" ? "Pulling from Tally…" : "—"}</div>}
                </div>

                {/* Phase 2 — Supabase */}
                <div className="rounded-lg border border-neutral-200 p-2.5">
                  <div className="flex items-center gap-1.5 mb-1">
                    {qsync.running && qsync.phase === "push"
                      ? <Loader2 size={13} className="animate-spin text-blue-500" />
                      : qsync.push?.ok ? <CheckCircle size={13} className="text-green-600" /> : qsync.push ? <XCircle size={13} className="text-red-600" /> : <Clock size={13} className="text-neutral-400" />}
                    <span className="font-semibold text-neutral-700">2 · Supabase push</span>
                  </div>
                  {qsync.push ? (
                    <div className="text-neutral-600 space-y-0.5">
                      <div><span className="font-medium text-neutral-800">{qsync.push.vouchers}</span> vouchers · {qsync.push.items} items · {qsync.push.ledgers} ledgers</div>
                      {qsync.push.ok
                        ? <div className="text-green-700">Pushed successfully</div>
                        : <div className="text-red-600 break-words">{qsync.push.vouchersErr || qsync.push.configErr || "Push had errors"}</div>}
                    </div>
                  ) : <div className="text-neutral-400">{qsync.phase === "push" ? "Pushing to Supabase…" : qsync.running ? "Waiting for pull…" : "—"}</div>}
                </div>
              </div>
            )}
          </SectionCard>
        </div>

        {/* ── Pull Sync ─────────────────────────────────────────── */}
        <div className="md:col-span-2">
          <SectionCard title="Pull Sync  (Tally → Supabase)" icon={<Database size={15} />}>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
              {([
                ["Full sync",    lastSyncAt],
                ["Masters",      lastMastersSyncAt],
                ["Vouchers",     lastVouchersSyncAt],
              ] as [string, string | null][]).map(([label, val]) => (
                <div key={label} className="bg-neutral-50 rounded-lg p-2 text-center">
                  <div className="text-[10px] text-neutral-400 uppercase tracking-wide">{label}</div>
                  <div className="text-xs font-medium text-neutral-800 mt-0.5 truncate">{fmt(val).split(" ")[0] || "—"}</div>
                </div>
              ))}
              <div className="bg-neutral-50 rounded-lg p-2 text-center">
                <div className="text-[10px] text-neutral-400 uppercase tracking-wide">Last voucher</div>
                <div className="text-xs font-medium text-neutral-800 mt-0.5">{lastVoucherDate || "—"}</div>
              </div>
            </div>
            <div className="flex gap-2 flex-wrap mb-2">
              <Btn variant="primary"
                onClick={() => triggerSync("/api/tally/sync", { company, fromDate: fyFromDate, toDate: fyToDate, mode: "full", chunkStrategy: "daily" }, "Full sync")}
                disabled={!!syncing || isSyncing || !connected}>
                {syncing === "Full sync" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                Sync Now
              </Btn>
              <Btn onClick={() => triggerSync("/api/tally/sync-masters", { company }, "Sync Masters")} disabled={!!syncing || isSyncing || !connected}>
                {syncing === "Sync Masters" && <Loader2 size={12} className="animate-spin" />}
                Sync Masters
              </Btn>
              <Btn onClick={() => triggerSync("/api/tally/sync-daybook", { company, fromDate: fyFromDate, toDate: fyToDate, chunkMode: "daily" }, "Sync Daybook")} disabled={!!syncing || isSyncing || !connected}>
                {syncing === "Sync Daybook" && <Loader2 size={12} className="animate-spin" />}
                Sync Daybook
              </Btn>
            </div>

            {/* Quick voucher refresh by date range */}
            <div className="flex gap-1.5 flex-wrap mb-4">
              <span className="text-[10px] text-neutral-400 uppercase tracking-wide self-center mr-0.5">Vouchers:</span>
              {([
                ["Today",     0,  0 ],
                ["Last week", 6,  0 ],
                ["Last month",29, 0 ],
                ["3 months",  89, 0 ],
              ] as [string, number, number][]).map(([label, daysBack, daysAhead]) => {
                const fmt8 = (d: Date) => {
                  const y = d.getFullYear();
                  const m = String(d.getMonth() + 1).padStart(2, "0");
                  const day = String(d.getDate()).padStart(2, "0");
                  return `${y}${m}${day}`;
                };
                const to   = new Date(); to.setDate(to.getDate() + daysAhead);
                const from = new Date(); from.setDate(from.getDate() - daysBack);
                const key  = `Vouchers ${label}`;
                return (
                  <button
                    key={label}
                    onClick={() => triggerSync("/api/tally/sync-daybook", { company, fromDate: fmt8(from), toDate: fmt8(to), chunkMode: "daily" }, key)}
                    disabled={!!syncing || isSyncing || !connected}
                    className="px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors
                      border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50 hover:border-neutral-300
                      disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                  >
                    {syncing === key ? <Loader2 size={10} className="animate-spin" /> : null}
                    {label}
                  </button>
                );
              })}
            </div>

            {/* Sync History */}
            {syncHistory.length > 0 && (
              <div>
                <p className="text-xs font-medium text-neutral-500 mb-1.5">Recent sync history</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-neutral-100">
                        <th className="text-left py-1 pr-3 text-neutral-400 font-medium">Started</th>
                        <th className="text-left py-1 pr-3 text-neutral-400 font-medium">Type</th>
                        <th className="text-left py-1 pr-3 text-neutral-400 font-medium">Duration</th>
                        <th className="text-left py-1 pr-3 text-neutral-400 font-medium">Chunks</th>
                        <th className="text-left py-1 pr-3 text-neutral-400 font-medium">Rows</th>
                        <th className="text-left py-1 text-neutral-400 font-medium">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {syncHistory.map(row => (
                        <>
                          <tr key={row.id} className="border-b border-neutral-50 hover:bg-neutral-50 cursor-pointer"
                            onClick={() => row.errors?.length && toggleError(row.id)}>
                            <td className="py-1 pr-3 text-neutral-600 whitespace-nowrap">{fmt(row.started_at)}</td>
                            <td className="py-1 pr-3">
                              <Badge label={row.sync_type} color={row.sync_type === "masters" ? "blue" : "gray"} />
                            </td>
                            <td className="py-1 pr-3 text-neutral-600">{fmtDur(row.duration_ms)}</td>
                            <td className="py-1 pr-3 text-neutral-600">{row.chunk_count ?? "—"}</td>
                            <td className="py-1 pr-3 text-neutral-600">
                              {row.row_counts
                                ? Object.entries(row.row_counts).map(([k, v]) => `${k}:${v}`).join(" ")
                                : "—"}
                            </td>
                            <td className="py-1">
                              <span className="flex items-center gap-1">
                                <Pill ok={row.success} label={row.success ? "OK" : "Error"} />
                                {row.errors?.length ? <ChevronRight size={11} className="text-neutral-400" /> : null}
                              </span>
                            </td>
                          </tr>
                          {expandedErrors.has(row.id) && row.errors?.length && (
                            <tr key={`${row.id}-err`}>
                              <td colSpan={6} className="pb-2">
                                <div className="bg-red-50 rounded p-2 text-xs text-red-700 space-y-0.5">
                                  {row.errors.map((e, i) => <div key={i}>{e}</div>)}
                                </div>
                              </td>
                            </tr>
                          )}
                        </>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!sbRead && (
                  <p className="text-xs text-neutral-400 mt-1">
                    Set VITE_SUPABASE_URL + VITE_SUPABASE_PUBLISHABLE_KEY to enable history.
                  </p>
                )}
              </div>
            )}
          </SectionCard>
        </div>

        {/* ── Push Queue ────────────────────────────────────────── */}
        <div className="md:col-span-2">
          <SectionCard title="Push Queue  (Supabase → Tally)" icon={<Activity size={15} />}>
            {pushStatus ? (
              <>
                <div className="flex items-center gap-3 mb-3 flex-wrap">
                  <Pill ok={pushStatus.enabled} label={pushStatus.enabled ? "Agent running" : "Agent disabled"} />
                  {pushStatus.lastTick == null
                    ? <Pill ok={null} label="Tally not checked" />
                    : <Pill ok={pushStatus.tallyHealthy} label={pushStatus.tallyHealthy ? "Tally healthy" : "Tally unreachable"} />
                  }
                  <span className="text-xs text-neutral-500">Last tick: {fmt(pushStatus.lastTick)}</span>
                </div>

                <div className="flex gap-2 mb-3 flex-wrap">
                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-blue-50 text-blue-800 text-xs font-medium">
                    Pending: {qs.pending}
                  </span>
                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-yellow-50 text-yellow-800 text-xs font-medium">
                    Pushing: {qs.pushing}
                  </span>
                  <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium ${qs.failed > 0 ? "bg-red-100 text-red-800" : "bg-neutral-100 text-neutral-600"}`}>
                    Failed: {qs.failed}
                  </span>
                </div>

                <div className="flex gap-2 mb-4">
                  <Btn onClick={drainQueue} disabled={draining || !pushStatus.enabled}>
                    {draining ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                    Drain Now
                  </Btn>
                </div>

                {!pushStatus.enabled && (
                  <p className="mb-3 text-xs text-yellow-700 bg-yellow-50 rounded p-2 flex items-center gap-1">
                    <AlertTriangle size={12} />
                    Set PUSH_AGENT_ENABLED=true in server env to activate the drain agent.
                  </p>
                )}

                {/* Push Log */}
                {pushLog.length > 0 && (
                  <div className="mb-4">
                    <p className="text-xs font-medium text-neutral-500 mb-1.5">Push log (last 30)</p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-neutral-100">
                            <th className="text-left py-1 pr-3 text-neutral-400 font-medium">Resolved</th>
                            <th className="text-left py-1 pr-3 text-neutral-400 font-medium">Type</th>
                            <th className="text-left py-1 pr-3 text-neutral-400 font-medium">Party</th>
                            <th className="text-left py-1 pr-3 text-neutral-400 font-medium">Date</th>
                            <th className="text-left py-1 pr-3 text-neutral-400 font-medium">Result</th>
                            <th className="text-left py-1 text-neutral-400 font-medium">VCH ID</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pushLog.map(row => (
                            <>
                              <tr key={row.id}
                                className="border-b border-neutral-50 hover:bg-neutral-50 cursor-pointer"
                                onClick={() => row.last_error && toggleError(`pl-${row.id}`)}>
                                <td className="py-1 pr-3 text-neutral-500 whitespace-nowrap">{fmt(row.resolved_at)}</td>
                                <td className="py-1 pr-3">
                                  <Badge label={row.voucher_type || "—"} color="gray" />
                                </td>
                                <td className="py-1 pr-3 text-neutral-700 max-w-[120px] truncate" title={row.party ?? ""}>{row.party || "—"}</td>
                                <td className="py-1 pr-3 text-neutral-500">{row.date || "—"}</td>
                                <td className="py-1 pr-3">
                                  <span className="flex items-center gap-1">
                                    <Badge label={row.status} color={row.status === "succeeded" ? "green" : "red"} />
                                    {row.last_error ? <ChevronRight size={11} className="text-neutral-400" /> : null}
                                  </span>
                                </td>
                                <td className="py-1 text-neutral-500 font-mono text-[10px]">{row.tally_vch_id || "—"}</td>
                              </tr>
                              {expandedErrors.has(`pl-${row.id}`) && row.last_error && (
                                <tr key={`pl-${row.id}-err`}>
                                  <td colSpan={6} className="pb-2">
                                    <div className="bg-red-50 rounded p-2 text-xs text-red-700">
                                      {row.line_errors?.join(" · ") || row.last_error}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Failed jobs with re-queue */}
                {failedJobs.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-red-600 mb-1.5 flex items-center gap-1">
                      <AlertTriangle size={12} /> {failedJobs.length} failed job{failedJobs.length > 1 ? "s" : ""} in queue
                    </p>
                    <div className="space-y-2">
                      {failedJobs.map(job => (
                        <div key={job.id} className="bg-red-50 rounded-lg p-3 text-xs">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-1 flex-wrap">
                                <span className="font-medium text-red-800">
                                  {(job.payload as any)?.voucherType || "Voucher"}
                                </span>
                                {(job.payload as any)?.partyLedgerName && (
                                  <span className="text-red-700">→ {(job.payload as any).partyLedgerName}</span>
                                )}
                                <span className="text-red-400">· attempts: {job.attempts}</span>
                              </div>
                              {job.last_error && (
                                <p className="text-red-600 mt-1 break-words">{job.last_error}</p>
                              )}
                              <p className="text-red-400 mt-0.5 font-mono text-[10px]">{job.idempotency_key.slice(0, 30)}…</p>
                            </div>
                            <Btn onClick={() => requeueJob(job.id)} disabled={requeueing === job.id}>
                              {requeueing === job.id
                                ? <Loader2 size={11} className="animate-spin" />
                                : <RotateCcw size={11} />}
                              Re-queue
                            </Btn>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-neutral-400 py-2">Loading push agent status…</p>
            )}
          </SectionCard>
        </div>

        {/* ── Logs ─────────────────────────────────────────────── */}
        <div className="md:col-span-2">
          <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
            <button
              className="flex items-center gap-2 px-4 py-3 border-b border-neutral-100 bg-neutral-50 w-full text-left"
              onClick={() => setShowLogs(v => !v)}
            >
              <Activity size={15} className="text-neutral-500" />
              <h2 className="font-semibold text-sm text-neutral-700 flex-1">
                Logs{showLogs && logs.length > 0 ? ` (${logs.length})` : ""}
                {showLogs && errorLogCount > 0 && (
                  <span className="ml-2 text-xs font-medium text-red-600">{errorLogCount} error{errorLogCount === 1 ? "" : "s"}</span>
                )}
              </h2>
              {showLogs && (
                <span
                  role="button"
                  tabIndex={0}
                  className="text-xs text-neutral-500 hover:text-neutral-800 px-2 py-0.5 rounded border border-neutral-200"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard?.writeText(visibleLogs.join("\n")).then(
                      () => toast("Logs copied", "success"),
                      () => toast("Copy failed", "error"),
                    );
                  }}
                >
                  Copy
                </span>
              )}
              {showLogs ? <ChevronUp size={14} className="text-neutral-400" /> : <ChevronDown size={14} className="text-neutral-400" />}
            </button>
            {showLogs && (
              <div className="px-3 py-3">
                {/* Filter chips — isolate errors or a single source for debugging */}
                <div className="flex gap-1.5 mb-2 flex-wrap">
                  {([
                    ["all", "All"],
                    ["errors", "Errors only"],
                    ["tally", "Tally"],
                    ["supabase", "Supabase"],
                    ["remote", "🌐 Remote"],
                    ["auto", "⏱ Scheduled"],
                  ] as [typeof logFilter, string][]).map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setLogFilter(key)}
                      className={`px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors ${
                        logFilter === key
                          ? "bg-neutral-900 text-white border-neutral-900"
                          : "bg-white text-neutral-600 border-neutral-200 hover:bg-neutral-50"
                      }`}
                    >
                      {label}{key === "errors" && errorLogCount > 0 ? ` (${errorLogCount})` : ""}
                    </button>
                  ))}
                </div>
                <div
                  ref={logsBoxRef}
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    logsAutoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                  }}
                  className="font-mono text-[11px] leading-relaxed bg-neutral-950 text-neutral-200 rounded-lg p-3 h-80 overflow-y-auto whitespace-pre-wrap"
                >
                  {visibleLogs.length === 0 ? (
                    <span className="text-neutral-500">
                      {logs.length === 0
                        ? "Waiting for log activity… (trigger a sync to see Tally + Supabase logs here)"
                        : `No ${logFilter === "all" ? "" : logFilter + " "}lines in the current buffer.`}
                    </span>
                  ) : (
                    visibleLogs.map((line, i) => {
                      const cls = isErrorLine(line) ? "text-red-400"
                        : /🌐/.test(line) ? "text-cyan-300"   // web-triggered remote refresh
                        : /🌙/.test(line) ? "text-violet-300" // scheduled nightly full-FY sync
                        : /⚠/.test(line) ? "text-amber-400"
                        : /✓/.test(line) ? "text-green-400"
                        : "text-neutral-300";
                      return <div key={i} className={cls}>{line}</div>;
                    })
                  )}
                </div>
                <p className="mt-1.5 text-[10px] text-neutral-400">
                  Live tail of the local server (last {logs.length || 0} lines, refreshes every 2s). Also at {BASE}/
                </p>
              </div>
            )}
          </div>
        </div>

        {/* ── Settings ─────────────────────────────────────────── */}
        <div className="md:col-span-2">
          <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
            <button
              className="flex items-center gap-2 px-4 py-3 border-b border-neutral-100 bg-neutral-50 w-full text-left"
              onClick={() => setShowSettings(v => !v)}
            >
              <Settings size={15} className="text-neutral-500" />
              <h2 className="font-semibold text-sm text-neutral-700 flex-1">Settings</h2>
              {showSettings ? <ChevronUp size={14} className="text-neutral-400" /> : <ChevronDown size={14} className="text-neutral-400" />}
            </button>
            {showSettings && (
              <div className="px-4 py-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                {([
                  ["Company name",       editCompany, setEditCompany],
                  ["Proxy URL",          editProxy,   setEditProxy],
                  ["FY from (YYYYMMDD)", editFyFrom,  setEditFyFrom],
                  ["FY to (YYYYMMDD)",   editFyTo,    setEditFyTo],
                ] as [string, string, (v: string) => void][]).map(([label, val, set]) => (
                  <label key={label} className="block">
                    <span className="text-xs text-neutral-500 mb-1 block">{label}</span>
                    <input
                      className="w-full border border-neutral-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                    className="w-full border border-neutral-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    value={editTodayMins}
                    onChange={e => setEditTodayMins(e.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-neutral-500 mb-1 block">Last 7 days — every (minutes, 0 = off)</span>
                  <input
                    type="number" min={0} step={1}
                    className="w-full border border-neutral-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    value={editWeekMins}
                    onChange={e => setEditWeekMins(e.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-neutral-500 mb-1 block">This FY — every (minutes, 0 = off · heavy, use the button)</span>
                  <input
                    type="number" min={0} step={1}
                    className="w-full border border-neutral-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    value={editFyMins}
                    onChange={e => setEditFyMins(e.target.value)}
                  />
                </label>

                <div className="sm:col-span-2">
                  <Btn variant="primary" onClick={applySettings}>Save settings</Btn>
                </div>
              </div>
            )}
          </div>
        </div>

      </div>

      <p className="mt-6 text-center text-xs text-neutral-400 max-w-5xl mx-auto">
        Agent: {pushStatus?.agentId ?? "—"} · Auto-refresh every 10 s
      </p>
    </div>
  );
}
