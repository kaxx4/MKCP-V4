/**
 * PerfLog — Performance Monitoring & Export Page
 *
 * Visualises memory, long tasks, FPS and route-change timings collected
 * automatically by usePerfMonitor. Export the full JSON after a QA session
 * and share it for analysis + targeted fixes.
 *
 * Tabs: Overview · Memory · Long Tasks · Routes · FPS · Export
 */
import { useState, useMemo, useCallback } from "react";
import {
  ResponsiveContainer,
  AreaChart, Area,
  LineChart, Line,
  BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from "recharts";
import {
  Activity, Play, Pause, Trash2, Download, Flag, AlertTriangle,
  Zap, Clock, ArrowRight, MemoryStick, Gauge, ChevronDown, ChevronUp,
  CheckCircle,
} from "lucide-react";
import clsx from "clsx";
import {
  usePerfStore,
  type MemorySnapshot,
  type LongTask,
  type RouteChange,
  type FpsSample,
} from "../store/perfStore";

// ─── Helpers ────────────────────────────────────────────────────────────────

const MB = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
const ms = (n: number)     => `${Math.round(n)} ms`;
const relSec = (ts: number, origin: number) =>
  `${((ts - origin) / 1000).toFixed(0)}s`;

function fmtHHMM(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function elapsed(startedAt: number | null) {
  if (!startedAt) return "—";
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return m > 0 ? `${m}m ${ss}s` : `${ss}s`;
}

function useElapsed(startedAt: number | null) {
  // Re-render every second only on the PerfLog page (cheap since it's one page)
  const [tick, setTick] = useState(0);
  useState(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  });
  void tick;
  return elapsed(startedAt);
}

function taskSeverity(duration: number): "low" | "med" | "high" {
  if (duration >= 300) return "high";
  if (duration >= 100) return "med";
  return "low";
}

const SEVERITY_COLORS: Record<"low" | "med" | "high", string> = {
  low:  "text-warn-600 bg-warn/10",
  med:  "text-orange-600 bg-orange-50",
  high: "text-danger-600 bg-danger/10",
};

const TABS = ["Overview", "Memory", "Long Tasks", "Routes", "FPS", "Export"] as const;
type Tab = typeof TABS[number];

// ─── Custom Tooltip ──────────────────────────────────────────────────────────

function MemTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-neutral-200 rounded-lg px-3 py-2 shadow-md text-xs">
      <p className="font-semibold text-neutral-700 mb-1">{label}</p>
      <p className="text-accent tabular-nums">Used: {payload[0]?.value} MB</p>
      {payload[1] && <p className="text-neutral-500 tabular-nums">Total: {payload[1]?.value} MB</p>}
    </div>
  );
}

function FpsTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const fps = payload[0]?.value ?? 0;
  const color = fps >= 55 ? "text-success-600" : fps >= 35 ? "text-warn-600" : "text-danger-600";
  return (
    <div className="bg-white border border-neutral-200 rounded-lg px-3 py-2 shadow-md text-xs">
      <p className="font-semibold text-neutral-700 mb-1">{label}</p>
      <p className={clsx("tabular-nums font-bold", color)}>{fps} fps</p>
    </div>
  );
}

// ─── KPI Card ────────────────────────────────────────────────────────────────

function KpiCard({
  label, value, sub, icon, accent,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  accent?: "ok" | "warn" | "bad" | "neutral";
}) {
  const accentClass = {
    ok:      "text-success-600",
    warn:    "text-warn-600",
    bad:     "text-danger-600",
    neutral: "text-accent",
  }[accent ?? "neutral"];

  return (
    <div className="card flex items-start gap-3">
      <div className={clsx("w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5",
        accent === "ok"   ? "bg-success/10" :
        accent === "warn" ? "bg-warn/10" :
        accent === "bad"  ? "bg-danger/10" : "bg-accent/10")}>
        <span className={accentClass}>{icon}</span>
      </div>
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{label}</p>
        <p className={clsx("text-xl font-bold tabular-nums mt-0.5", accentClass)}>{value}</p>
        {sub && <p className="text-xs text-neutral-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function PerfLog() {
  const {
    recording, startedAt,
    memorySnapshots, longTasks, routeChanges, markers, fpsSamples,
    startRecording, pauseRecording,
    addMarker, clearAll, buildSummary, buildExport,
  } = usePerfStore();

  const [tab, setTab]             = useState<Tab>("Overview");
  const [markerLabel, setMarkerLabel] = useState("");
  const [markerInput, setMarkerInput] = useState(false);
  const [sortLTDesc, setSortLTDesc]   = useState(true);
  const elapsedStr = useElapsed(startedAt);

  // ── Derived chart data ──────────────────────────────────────────────────

  const memChartData = useMemo(() => {
    const origin = memorySnapshots[0]?.ts ?? Date.now();
    return memorySnapshots.map((s) => ({
      t:     relSec(s.ts, origin),
      used:  +(+MB(s.heapUsed)),
      total: +(+MB(s.heapTotal)),
      route: s.route,
    }));
  }, [memorySnapshots]);

  const fpsChartData = useMemo(() => {
    const origin = fpsSamples[0]?.ts ?? Date.now();
    return fpsSamples.map((s) => ({
      t:   relSec(s.ts, origin),
      fps: s.fps,
    }));
  }, [fpsSamples]);

  const sortedTasks = useMemo(
    () => [...longTasks].sort((a, b) =>
      sortLTDesc ? b.duration - a.duration : a.duration - b.duration
    ),
    [longTasks, sortLTDesc]
  );

  const summary = useMemo(() => buildSummary(), [
    // recompute when any of the arrays or recording state changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    memorySnapshots.length, longTasks.length, routeChanges.length, fpsSamples.length,
  ]);

  // ── Export ──────────────────────────────────────────────────────────────

  const handleExportJSON = useCallback(() => {
    const data = buildExport();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `mkcp-perf-${new Date().toISOString().slice(0, 16).replace("T", "_")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [buildExport]);

  const handleMark = useCallback(() => {
    const label = markerLabel.trim() || `Checkpoint ${markers.length + 1}`;
    const route = window.location.hash.replace(/^#/, "") || window.location.pathname;
    addMarker(label, route);
    setMarkerLabel("");
    setMarkerInput(false);
  }, [markerLabel, markers.length, addMarker]);

  // ── Recording status color ─────────────────────────────────────────────
  const fpsAccent = summary.avgFps >= 55 ? "ok" : summary.avgFps >= 35 ? "warn" : "bad";
  const ltAccent  = summary.longTaskCount === 0 ? "ok" : summary.longTaskCount < 5 ? "warn" : "bad";

  return (
    <div className="page-section">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="page-title flex items-center gap-2">
            <Activity size={18} className="text-accent" />
            Performance Log
          </h1>
          <p className="page-subtitle">
            Auto-recording · {elapsedStr} elapsed ·{" "}
            {memorySnapshots.length} snapshots · {longTasks.length} long tasks
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Mark event */}
          {markerInput ? (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={markerLabel}
                onChange={(e) => setMarkerLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleMark(); if (e.key === "Escape") setMarkerInput(false); }}
                placeholder="Marker label…"
                className="form-input text-xs py-1 px-2 w-40"
              />
              <button onClick={handleMark} className="btn-primary btn-sm">Save</button>
              <button onClick={() => setMarkerInput(false)} className="btn-ghost btn-sm">×</button>
            </div>
          ) : (
            <button onClick={() => setMarkerInput(true)} className="btn-secondary btn-sm gap-1.5">
              <Flag size={13} /> Mark Event
            </button>
          )}

          {/* Record / Pause */}
          {recording ? (
            <button onClick={pauseRecording} className="btn-secondary btn-sm gap-1.5">
              <Pause size={13} /> Pause
            </button>
          ) : (
            <button onClick={startRecording} className="btn-primary btn-sm gap-1.5">
              <Play size={13} /> Resume
            </button>
          )}

          {/* Clear */}
          <button onClick={() => { if (confirm("Clear all perf data?")) clearAll(); }}
            className="btn-ghost btn-sm gap-1.5 text-danger hover:bg-danger/10">
            <Trash2 size={13} /> Clear
          </button>

          {/* Export */}
          <button onClick={handleExportJSON} className="btn-primary btn-sm gap-1.5">
            <Download size={13} /> Export JSON
          </button>
        </div>
      </div>

      {/* ── Recording badge ──────────────────────────────────────────────── */}
      <div className={clsx(
        "inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold w-fit",
        recording ? "bg-success/10 text-success-600" : "bg-neutral-100 text-neutral-500"
      )}>
        <span className={clsx(
          "w-2 h-2 rounded-full",
          recording ? "bg-success-600 animate-pulse" : "bg-neutral-400"
        )} />
        {recording ? "Recording" : "Paused"} — session started {startedAt ? fmtHHMM(startedAt) : "—"}
      </div>

      {/* ── KPI Row ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          label="Peak Heap"
          value={`${summary.peakHeapMB} MB`}
          sub={`avg ${summary.avgHeapMB} MB`}
          icon={<MemoryStick size={14} />}
          accent={summary.peakHeapMB < 150 ? "ok" : summary.peakHeapMB < 400 ? "warn" : "bad"}
        />
        <KpiCard
          label="Long Tasks"
          value={String(summary.longTaskCount)}
          sub={summary.totalLongTaskMs > 0 ? `${summary.totalLongTaskMs} ms total` : "none detected"}
          icon={<AlertTriangle size={14} />}
          accent={ltAccent}
        />
        <KpiCard
          label="Slowest Route"
          value={summary.slowestRouteMs > 0 ? ms(summary.slowestRouteMs) : "—"}
          sub={summary.slowestRoute !== "—" ? summary.slowestRoute.split("→")[1]?.trim() ?? "—" : "—"}
          icon={<Clock size={14} />}
          accent={summary.slowestRouteMs < 300 ? "ok" : summary.slowestRouteMs < 800 ? "warn" : "bad"}
        />
        <KpiCard
          label="Avg FPS"
          value={summary.avgFps > 0 ? `${summary.avgFps}` : "—"}
          sub={summary.minFps > 0 ? `min ${summary.minFps} fps` : "measuring…"}
          icon={<Gauge size={14} />}
          accent={fpsAccent}
        />
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────────────── */}
      <div className="section-card">
        <div className="tab-list">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={clsx("tab-item", tab === t && "tab-item-active")}
            >
              {t}
              {t === "Long Tasks" && longTasks.length > 0 && (
                <span className={clsx(
                  "ml-1.5 text-2xs font-bold px-1.5 py-0.5 rounded-full",
                  longTasks.some((lt) => lt.duration >= 300)
                    ? "bg-danger/10 text-danger-600"
                    : "bg-warn/10 text-warn-600"
                )}>{longTasks.length}</span>
              )}
              {t === "Routes" && routeChanges.length > 0 && (
                <span className="ml-1.5 text-2xs bg-neutral-100 text-neutral-600 font-bold px-1.5 py-0.5 rounded-full">
                  {routeChanges.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ── Overview Tab ─────────────────────────────────────────────── */}
        {tab === "Overview" && (
          <div className="p-4 space-y-5">
            {memChartData.length < 2 ? (
              <div className="flex items-center justify-center h-36 text-neutral-400 text-sm">
                Collecting data… snapshots every 5 s
              </div>
            ) : (
              <>
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wide text-neutral-500 mb-3">
                    Heap Memory (last {memChartData.length} samples)
                  </h3>
                  <ResponsiveContainer width="100%" height={160}>
                    <AreaChart data={memChartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                      <defs>
                        <linearGradient id="heapGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor="#2563eb" stopOpacity={0.15} />
                          <stop offset="95%" stopColor="#2563eb" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
                      <XAxis dataKey="t" tick={{ fontSize: 10, fill: "#a1a1a6" }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 10, fill: "#a1a1a6" }} axisLine={false} tickLine={false} unit=" MB" width={48} />
                      <Tooltip content={<MemTooltip />} />
                      <Area type="monotone" dataKey="used"  stroke="#2563eb" fill="url(#heapGrad)" strokeWidth={1.5} dot={false} name="Used" />
                      <Area type="monotone" dataKey="total" stroke="#a1a1a6" fill="none"           strokeWidth={1}   dot={false} strokeDasharray="4 2" name="Total" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                {fpsChartData.length >= 2 && (
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wide text-neutral-500 mb-3">FPS</h3>
                    <ResponsiveContainer width="100%" height={100}>
                      <LineChart data={fpsChartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
                        <XAxis dataKey="t" tick={{ fontSize: 10, fill: "#a1a1a6" }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                        <YAxis tick={{ fontSize: 10, fill: "#a1a1a6" }} axisLine={false} tickLine={false} domain={[0, 65]} />
                        <Tooltip content={<FpsTooltip />} />
                        <ReferenceLine y={60} stroke="#16a34a" strokeDasharray="4 2" strokeWidth={1} />
                        <ReferenceLine y={30} stroke="#dc2626" strokeDasharray="4 2" strokeWidth={1} />
                        <Line type="monotone" dataKey="fps" stroke="#2563eb" strokeWidth={1.5} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </>
            )}

            {/* Markers in overview */}
            {markers.length > 0 && (
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wide text-neutral-500 mb-2">Markers</h3>
                <div className="space-y-1">
                  {markers.map((m) => (
                    <div key={m.id} className="flex items-center gap-3 text-xs py-1.5 px-3 bg-accent/[0.04] rounded-lg border border-accent/20">
                      <Flag size={11} className="text-accent flex-shrink-0" />
                      <span className="font-semibold text-neutral-800">{m.label}</span>
                      <span className="text-neutral-400">{fmtHHMM(m.ts)}</span>
                      <span className="text-neutral-400 ml-auto truncate">{m.route}</span>
                      <span className="text-accent tabular-nums">{MB(m.heapUsed)} MB</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Memory Tab ───────────────────────────────────────────────── */}
        {tab === "Memory" && (
          <div className="p-4 space-y-4">
            {memChartData.length < 2 ? (
              <div className="flex items-center justify-center h-40 text-neutral-400 text-sm">
                Waiting for snapshots…
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={memChartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="heapGrad2" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#2563eb" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#2563eb" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
                  <XAxis dataKey="t" tick={{ fontSize: 10, fill: "#a1a1a6" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: "#a1a1a6" }} axisLine={false} tickLine={false} unit=" MB" width={52} />
                  <Tooltip content={<MemTooltip />} />
                  <Area type="monotone" dataKey="used"  stroke="#2563eb" fill="url(#heapGrad2)" strokeWidth={2}   dot={false} name="Heap Used" />
                  <Area type="monotone" dataKey="total" stroke="#a1a1a6" fill="none"            strokeWidth={1.5} dot={false} strokeDasharray="4 2" name="Heap Total" />
                </AreaChart>
              </ResponsiveContainer>
            )}

            {/* Raw table */}
            <div className="overflow-auto max-h-48 rounded-lg border border-neutral-200">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="table-header">Time</th>
                    <th className="table-header text-right">Used (MB)</th>
                    <th className="table-header text-right">Total (MB)</th>
                    <th className="table-header text-right">Limit (MB)</th>
                    <th className="table-header">Route</th>
                  </tr>
                </thead>
                <tbody>
                  {[...memorySnapshots].reverse().map((s, i) => (
                    <tr key={i} className="responsive-table-row font-mono text-xs">
                      <td className="table-cell text-muted">{fmtHHMM(s.ts)}</td>
                      <td className="table-cell text-right tabular-nums text-accent font-semibold">{MB(s.heapUsed)}</td>
                      <td className="table-cell text-right tabular-nums text-neutral-500">{MB(s.heapTotal)}</td>
                      <td className="table-cell text-right tabular-nums text-neutral-400">{MB(s.heapLimit)}</td>
                      <td className="table-cell text-neutral-600 truncate max-w-[160px]">{s.route}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Long Tasks Tab ───────────────────────────────────────────── */}
        {tab === "Long Tasks" && (
          <div className="p-4 space-y-3">
            {longTasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 gap-3">
                <CheckCircle size={28} className="text-success-600" />
                <p className="text-sm font-semibold text-neutral-700">No long tasks detected</p>
                <p className="text-xs text-neutral-400 max-w-xs text-center">
                  Tasks that block the main thread for &gt;50 ms will appear here.
                </p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 text-xs text-neutral-500">
                  <span>
                    <span className="inline-block w-2 h-2 rounded-full bg-warn mr-1" />50–99 ms
                  </span>
                  <span>
                    <span className="inline-block w-2 h-2 rounded-full bg-orange-400 mr-1" />100–299 ms
                  </span>
                  <span>
                    <span className="inline-block w-2 h-2 rounded-full bg-danger mr-1" />≥300 ms
                  </span>
                  <button
                    onClick={() => setSortLTDesc(!sortLTDesc)}
                    className="ml-auto btn-ghost btn-sm gap-1"
                  >
                    {sortLTDesc ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
                    {sortLTDesc ? "Worst first" : "Shortest first"}
                  </button>
                </div>
                <div className="overflow-auto max-h-96 rounded-lg border border-neutral-200">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th className="table-header">#</th>
                        <th className="table-header">Time</th>
                        <th className="table-header text-right">Duration</th>
                        <th className="table-header">Route</th>
                        <th className="table-header">Severity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedTasks.map((t, i) => {
                        const sev = taskSeverity(t.duration);
                        return (
                          <tr key={t.id} className="responsive-table-row text-xs font-mono">
                            <td className="table-cell text-neutral-400">{i + 1}</td>
                            <td className="table-cell text-muted">{fmtHHMM(t.ts)}</td>
                            <td className="table-cell text-right tabular-nums font-bold">
                              <span className={clsx("px-1.5 py-0.5 rounded font-mono", SEVERITY_COLORS[sev])}>
                                {ms(t.duration)}
                              </span>
                            </td>
                            <td className="table-cell text-neutral-600 max-w-[180px] truncate">{t.route}</td>
                            <td className="table-cell">
                              <span className={clsx(
                                "text-2xs font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded",
                                SEVERITY_COLORS[sev]
                              )}>
                                {sev}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {/* Mini bar chart of task durations */}
                <div>
                  <h4 className="text-xs font-semibold text-neutral-500 mb-2 uppercase tracking-wide">
                    Duration distribution (top 30)
                  </h4>
                  <ResponsiveContainer width="100%" height={100}>
                    <BarChart
                      data={sortedTasks.slice(0, 30).map((t, i) => ({ i: i + 1, ms: Math.round(t.duration) }))}
                      barSize={8}
                      margin={{ top: 2, right: 4, bottom: 0, left: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
                      <XAxis dataKey="i" tick={{ fontSize: 9, fill: "#a1a1a6" }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 9, fill: "#a1a1a6" }} axisLine={false} tickLine={false} />
                      <Tooltip formatter={(v: number) => [`${v} ms`, "duration"]} contentStyle={{ fontSize: 11 }} />
                      <ReferenceLine y={300} stroke="#dc2626" strokeDasharray="3 2" />
                      <ReferenceLine y={100} stroke="#d97706" strokeDasharray="3 2" />
                      <Bar dataKey="ms" fill="#2563eb" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Routes Tab ──────────────────────────────────────────────── */}
        {tab === "Routes" && (
          <div className="p-4 space-y-3">
            {routeChanges.length === 0 ? (
              <div className="flex items-center justify-center py-10 text-neutral-400 text-sm">
                Navigate between pages to see route timing here.
              </div>
            ) : (
              <div className="overflow-auto max-h-96 rounded-lg border border-neutral-200">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="table-header">Time</th>
                      <th className="table-header">From</th>
                      <th className="table-header">To</th>
                      <th className="table-header text-right">Render ms</th>
                      <th className="table-header text-right">Heap Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...routeChanges].reverse().map((r) => {
                      const slow = r.renderMs >= 500 ? "bad" : r.renderMs >= 200 ? "warn" : "ok";
                      const heapSign = r.heapDelta > 0 ? "+" : "";
                      const heapMB = (r.heapDelta / 1024 / 1024).toFixed(1);
                      return (
                        <tr key={r.id} className="responsive-table-row text-xs">
                          <td className="table-cell font-mono text-muted">{fmtHHMM(r.ts)}</td>
                          <td className="table-cell text-neutral-500 max-w-[110px] truncate">{r.from}</td>
                          <td className="table-cell flex items-center gap-1">
                            <ArrowRight size={10} className="text-neutral-300 flex-shrink-0" />
                            <span className="font-medium text-neutral-800 truncate">{r.to}</span>
                          </td>
                          <td className="table-cell text-right tabular-nums">
                            <span className={clsx(
                              "font-mono font-semibold px-1.5 py-0.5 rounded",
                              slow === "ok"  ? "text-success-600 bg-success/10" :
                              slow === "warn"? "text-warn-600 bg-warn/10" :
                                              "text-danger-600 bg-danger/10"
                            )}>
                              {ms(r.renderMs)}
                            </span>
                          </td>
                          <td className={clsx(
                            "table-cell text-right tabular-nums font-mono text-xs",
                            r.heapDelta > 5 * 1024 * 1024 ? "text-danger-600 font-bold" :
                            r.heapDelta > 0 ? "text-warn-600" : "text-success-600"
                          )}>
                            {heapSign}{heapMB} MB
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── FPS Tab ─────────────────────────────────────────────────── */}
        {tab === "FPS" && (
          <div className="p-4 space-y-4">
            {fpsChartData.length < 3 ? (
              <div className="flex items-center justify-center h-40 text-neutral-400 text-sm">
                Collecting FPS samples (1/sec)…
              </div>
            ) : (
              <>
                <div className="flex items-center gap-4 text-xs text-neutral-500">
                  <span><span className="inline-block w-2 h-2 rounded-full bg-success-600 mr-1" />≥55 fps — smooth</span>
                  <span><span className="inline-block w-2 h-2 rounded-full bg-warn mr-1" />35–54 fps — ok</span>
                  <span><span className="inline-block w-2 h-2 rounded-full bg-danger mr-1" />&lt;35 fps — janky</span>
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={fpsChartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
                    <XAxis dataKey="t" tick={{ fontSize: 10, fill: "#a1a1a6" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: "#a1a1a6" }} axisLine={false} tickLine={false} domain={[0, 65]} />
                    <Tooltip content={<FpsTooltip />} />
                    <ReferenceLine y={60} stroke="#16a34a" strokeDasharray="4 2" strokeWidth={1.5} label={{ value: "60", fill: "#16a34a", fontSize: 10 }} />
                    <ReferenceLine y={30} stroke="#dc2626" strokeDasharray="4 2" strokeWidth={1.5} label={{ value: "30", fill: "#dc2626", fontSize: 10 }} />
                    <Line
                      type="monotone" dataKey="fps" strokeWidth={2} dot={false}
                      stroke="#2563eb"
                    />
                  </LineChart>
                </ResponsiveContainer>

                {/* Low-fps events */}
                {fpsSamples.filter((f) => f.fps < 35).length > 0 && (
                  <div>
                    <h4 className="text-xs font-bold uppercase tracking-wide text-danger-600 mb-2">
                      ⚠ Low-FPS Events (&lt;35 fps)
                    </h4>
                    <div className="overflow-auto max-h-40 rounded-lg border border-danger/20">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th className="table-header">Time</th>
                            <th className="table-header text-right">FPS</th>
                            <th className="table-header">Route</th>
                          </tr>
                        </thead>
                        <tbody>
                          {fpsSamples.filter((f) => f.fps < 35).map((f, i) => (
                            <tr key={i} className="responsive-table-row text-xs">
                              <td className="table-cell font-mono text-muted">{fmtHHMM(f.ts)}</td>
                              <td className="table-cell text-right tabular-nums font-bold text-danger-600">{f.fps}</td>
                              <td className="table-cell text-neutral-600 truncate">{f.route}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Export Tab ──────────────────────────────────────────────── */}
        {tab === "Export" && (
          <div className="p-4 space-y-4">
            <div className="alert alert-info">
              <Zap size={14} className="flex-shrink-0 mt-0.5 text-accent" />
              <div>
                <p className="font-semibold text-sm mb-1">How to use</p>
                <ol className="text-xs text-neutral-600 space-y-1 list-decimal pl-4">
                  <li>Use the app normally — navigate every page, test all features</li>
                  <li>Add <strong>Markers</strong> at interesting moments (e.g., "loaded orders", "opened modal")</li>
                  <li>Click <strong>Export JSON</strong> when done</li>
                  <li>Share the file — the summary + raw data surfaces every abnormality</li>
                </ol>
              </div>
            </div>

            {/* Summary preview */}
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wide text-neutral-500 mb-2">Session Summary</h3>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
                {Object.entries(summary).map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between px-3 py-2 bg-neutral-50 rounded-lg border border-neutral-200">
                    <span className="text-neutral-500 font-medium truncate mr-2">{k}</span>
                    <span className="font-mono font-semibold text-neutral-900 tabular-nums flex-shrink-0">{String(v)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button onClick={handleExportJSON} className="btn-primary gap-2">
                <Download size={15} /> Export Full JSON
              </button>
              <span className="text-xs text-neutral-400">
                Includes {memorySnapshots.length} memory snapshots, {longTasks.length} long tasks,{" "}
                {routeChanges.length} route events, {fpsSamples.length} FPS samples, {markers.length} markers
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
