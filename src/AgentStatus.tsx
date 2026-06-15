import { useState, useEffect, useCallback } from "react";
import {
  Wifi, WifiOff, RefreshCw, Cloud, CloudOff, CheckCircle, XCircle,
  Clock, Activity, ChevronDown, ChevronUp, Settings, Database,
  AlertTriangle, Loader2,
} from "lucide-react";
import { useTallyStore } from "./store/tallyStore";
import { useSupabaseSyncStatusStore } from "./store/supabaseSyncStatusStore";
import { useToast } from "./components/Toast";

const BASE = (import.meta as any).env?.VITE_TALLY_PROXY || "http://localhost:3100";

interface PushAgentStatus {
  enabled: boolean;
  agentId: string;
  lastTick: string | null;
  tallyHealthy: boolean;
  claimedCount: number;
  last10Results: Array<{ id: string; idempotency_key: string; status: string; error?: string; at: string }>;
}

interface TallyHealth {
  connected: boolean;
  tallyUrl: string;
  error?: string;
  current?: string;
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

function Pill({ ok, label }: { ok: boolean | null; label: string }) {
  if (ok === null) return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-neutral-100 text-neutral-500">
      <Clock size={11} /> {label}
    </span>
  );
  return ok ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-green-50 text-green-700">
      <CheckCircle size={11} /> {label}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-red-50 text-red-700">
      <XCircle size={11} /> {label}
    </span>
  );
}

function SectionCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-neutral-100 bg-neutral-50">
        <span className="text-neutral-500">{icon}</span>
        <h2 className="font-semibold text-sm text-neutral-700">{title}</h2>
      </div>
      <div className="px-4 py-3">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm border-b border-neutral-50 last:border-0">
      <span className="text-neutral-500 text-xs">{label}</span>
      <span className="text-neutral-800 font-medium text-right ml-4">{value}</span>
    </div>
  );
}

export default function AgentStatus() {
  const tally = useTallyStore();
  const cloud = useSupabaseSyncStatusStore();
  const { toast } = useToast();

  const [health, setHealth] = useState<TallyHealth | null>(null);
  const [pushStatus, setPushStatus] = useState<PushAgentStatus | null>(null);
  const [polling, setPolling] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [draining, setDraining] = useState(false);

  // editable settings (local state, saved to tallyStore on apply)
  const [editCompany, setEditCompany] = useState(tally.companyName);
  const [editProxy, setEditProxy] = useState(tally.proxyUrl);
  const [editFyFrom, setEditFyFrom] = useState(tally.fyFromDate);
  const [editFyTo, setEditFyTo] = useState(tally.fyToDate);

  const poll = useCallback(async () => {
    setPolling(true);
    try {
      const [h, p] = await Promise.all([
        fetch(`${BASE}/api/tally/health`).then((r) => r.json()).catch(() => null),
        fetch(`${BASE}/api/push-agent/status`).then((r) => r.json()).catch(() => null),
      ]);
      setHealth(h);
      if (h?.connected) tally.setConnected(true);
      else if (h) tally.setConnected(false);
      setPushStatus(p);
    } finally {
      setPolling(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    poll();
    const id = setInterval(poll, 10_000);
    return () => clearInterval(id);
  }, [poll]);

  async function triggerSync(endpoint: string, body: Record<string, unknown>, label: string) {
    if (syncing) return;
    setSyncing(label);
    try {
      const r = await fetch(`${BASE}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.success) {
        toast(`${label} complete`, "success");
        tally.setLastSync(new Date().toISOString());
      } else {
        toast(`${label} failed: ${j.error || "unknown error"}`, "error");
      }
    } catch (e: any) {
      toast(`${label} failed: ${e.message}`, "error");
    } finally {
      setSyncing(null);
      poll();
    }
  }

  async function drainQueue() {
    if (draining) return;
    setDraining(true);
    try {
      await fetch(`${BASE}/api/push-agent/drain`, { method: "POST" });
      await new Promise((r) => setTimeout(r, 500));
      await poll();
      toast("Drain tick triggered", "success");
    } catch {
      toast("Drain trigger failed", "error");
    } finally {
      setDraining(false);
    }
  }

  function applySettings() {
    tally.setCompanyName(editCompany.trim());
    tally.setProxyUrl(editProxy.trim());
    tally.setFyDates(editFyFrom.trim(), editFyTo.trim());
    toast("Settings saved", "success");
  }

  const company = tally.companyName || "—";
  const connected = health?.connected ?? false;
  const cloudOk = cloud.config.success !== false && cloud.masters.success !== false && cloud.vouchers.success !== false;
  const cloudLastAt = cloud.vouchers.lastAt || cloud.masters.lastAt || cloud.config.lastAt;

  const statusColors: Record<string, string> = {
    succeeded: "text-green-700",
    failed: "text-red-700",
    retry: "text-yellow-700",
  };

  return (
    <div className="min-h-screen bg-neutral-100 p-4 md:p-6">
      {/* Header */}
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-neutral-900">MKCP Sync Agent</h1>
          <p className="text-xs text-neutral-500 mt-0.5">{company}</p>
        </div>
        <button
          onClick={poll}
          disabled={polling}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-neutral-200 bg-white hover:bg-neutral-50 text-neutral-600 disabled:opacity-50"
        >
          <RefreshCw size={13} className={polling ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-4xl mx-auto">

        {/* ── Tally Connection ─────────────────────────────────── */}
        <SectionCard title="Tally" icon={connected ? <Wifi size={15} /> : <WifiOff size={15} />}>
          <Row
            label="Status"
            value={connected
              ? <Pill ok={true} label="Connected" />
              : <Pill ok={false} label="Disconnected" />}
          />
          <Row label="URL" value={health?.tallyUrl || BASE} />
          <Row label="Company" value={company} />
          {!connected && health?.error && (
            <p className="mt-2 text-xs text-red-600 bg-red-50 rounded p-2">{health.error}</p>
          )}
        </SectionCard>

        {/* ── Cloud / Supabase ─────────────────────────────────── */}
        <SectionCard title="Supabase Cloud" icon={cloudOk ? <Cloud size={15} /> : <CloudOff size={15} />}>
          <Row
            label="Config"
            value={<Pill ok={cloud.config.success} label={cloud.config.success == null ? "Never" : cloud.config.success ? "OK" : "Error"} />}
          />
          <Row
            label="Masters"
            value={<Pill ok={cloud.masters.success} label={cloud.masters.success == null ? "Never" : cloud.masters.success ? "OK" : "Error"} />}
          />
          <Row
            label="Vouchers"
            value={<Pill ok={cloud.vouchers.success} label={cloud.vouchers.success == null ? "Never" : cloud.vouchers.success ? "OK" : "Error"} />}
          />
          <Row label="Last pushed" value={fmt(cloudLastAt)} />
          {cloud.vouchers.error && (
            <p className="mt-2 text-xs text-red-600 bg-red-50 rounded p-2 truncate">{cloud.vouchers.error}</p>
          )}
        </SectionCard>

        {/* ── Pull Sync ────────────────────────────────────────── */}
        <SectionCard title="Pull Sync  (Tally → Supabase)" icon={<Database size={15} />}>
          <Row label="Last full sync" value={fmt(tally.lastSyncAt)} />
          <Row label="Last masters" value={fmt(tally.lastMastersSyncAt)} />
          <Row label="Last vouchers" value={fmt(tally.lastVouchersSyncAt)} />
          <Row label="Last voucher date" value={tally.lastVoucherDate || "—"} />
          <div className="flex gap-2 mt-3 flex-wrap">
            <button
              onClick={() => triggerSync("/api/tally/sync", { company, fromDate: tally.fyFromDate, toDate: tally.fyToDate, mode: "smart" }, "Full sync")}
              disabled={!!syncing || !connected}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {syncing === "Full sync" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              Sync Now
            </button>
            <button
              onClick={() => triggerSync("/api/tally/sync-masters", { company }, "Sync Masters")}
              disabled={!!syncing || !connected}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-neutral-200 bg-white hover:bg-neutral-50 disabled:opacity-50"
            >
              {syncing === "Sync Masters" ? <Loader2 size={12} className="animate-spin" /> : null}
              Sync Masters
            </button>
            <button
              onClick={() => triggerSync("/api/tally/sync-daybook", { company, fromDate: tally.fyFromDate, toDate: tally.fyToDate }, "Sync Daybook")}
              disabled={!!syncing || !connected}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-neutral-200 bg-white hover:bg-neutral-50 disabled:opacity-50"
            >
              {syncing === "Sync Daybook" ? <Loader2 size={12} className="animate-spin" /> : null}
              Sync Daybook
            </button>
          </div>
        </SectionCard>

        {/* ── Push Queue ───────────────────────────────────────── */}
        <SectionCard title="Push Queue  (Supabase → Tally)" icon={<Activity size={15} />}>
          {pushStatus ? (
            <>
              <Row label="Agent" value={pushStatus.enabled ? <Pill ok={true} label="Running" /> : <Pill ok={false} label="Disabled" />} />
              <Row label="Tally health" value={<Pill ok={pushStatus.tallyHealthy} label={pushStatus.tallyHealthy ? "Healthy" : "Unreachable"} />} />
              <Row label="Last tick" value={fmt(pushStatus.lastTick)} />
              <Row label="Claimed this tick" value={pushStatus.claimedCount} />

              <div className="mt-2">
                <button
                  onClick={drainQueue}
                  disabled={draining || !pushStatus.enabled}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-neutral-200 bg-white hover:bg-neutral-50 disabled:opacity-50"
                >
                  {draining ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  Drain Now
                </button>
              </div>

              {pushStatus.last10Results.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs text-neutral-400 mb-1.5">Last 10 results</p>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {pushStatus.last10Results.map((r) => (
                      <div key={r.id} className="flex items-center justify-between text-xs py-1 border-b border-neutral-50">
                        <span className="text-neutral-400 truncate max-w-[140px]" title={r.idempotency_key}>
                          {r.idempotency_key.slice(0, 20)}…
                        </span>
                        <span className={statusColors[r.status] ?? "text-neutral-500"}>{r.status}</span>
                        <span className="text-neutral-300 text-[10px]">{fmt(r.at)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!pushStatus.enabled && (
                <p className="mt-2 text-xs text-yellow-700 bg-yellow-50 rounded p-2 flex items-center gap-1">
                  <AlertTriangle size={12} />
                  Set PUSH_AGENT_ENABLED=true in server env to activate.
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-neutral-400 py-2">Loading push agent status…</p>
          )}
        </SectionCard>

        {/* ── Settings ─────────────────────────────────────────── */}
        <div className="md:col-span-2">
          <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
            <button
              className="flex items-center gap-2 px-4 py-3 border-b border-neutral-100 bg-neutral-50 w-full text-left"
              onClick={() => setShowSettings((v) => !v)}
            >
              <Settings size={15} className="text-neutral-500" />
              <h2 className="font-semibold text-sm text-neutral-700 flex-1">Settings</h2>
              {showSettings ? <ChevronUp size={14} className="text-neutral-400" /> : <ChevronDown size={14} className="text-neutral-400" />}
            </button>
            {showSettings && (
              <div className="px-4 py-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label className="block">
                  <span className="text-xs text-neutral-500 mb-1 block">Company name</span>
                  <input
                    className="w-full border border-neutral-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    value={editCompany}
                    onChange={(e) => setEditCompany(e.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-neutral-500 mb-1 block">Proxy URL</span>
                  <input
                    className="w-full border border-neutral-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    value={editProxy}
                    onChange={(e) => setEditProxy(e.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-neutral-500 mb-1 block">FY from (YYYYMMDD)</span>
                  <input
                    className="w-full border border-neutral-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    value={editFyFrom}
                    onChange={(e) => setEditFyFrom(e.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-neutral-500 mb-1 block">FY to (YYYYMMDD)</span>
                  <input
                    className="w-full border border-neutral-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    value={editFyTo}
                    onChange={(e) => setEditFyTo(e.target.value)}
                  />
                </label>
                <div className="sm:col-span-2">
                  <button
                    onClick={applySettings}
                    className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                  >
                    Save settings
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

      </div>

      <p className="mt-6 text-center text-xs text-neutral-400">
        Agent ID: {pushStatus?.agentId ?? "—"} · Polling every 10 s
      </p>
    </div>
  );
}
