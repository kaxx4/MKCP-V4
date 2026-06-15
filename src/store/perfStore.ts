/**
 * PerfStore — lightweight performance telemetry store.
 * Auto-records: memory snapshots, long tasks, route changes, FPS samples.
 * User-addable: named markers (checkpoint events).
 * Designed for Electron QA sessions → export JSON for analysis.
 */
import { create } from "zustand";

// ─── Event types ────────────────────────────────────────────────────────────

export interface MemorySnapshot {
  ts: number;           // epoch ms
  heapUsed: number;     // bytes (JS heap)
  heapTotal: number;    // bytes
  heapLimit: number;    // bytes (V8 limit)
  route: string;
}

export interface LongTask {
  id: string;
  ts: number;
  duration: number;     // ms
  route: string;
}

export interface RouteChange {
  id: string;
  ts: number;
  from: string;
  to: string;
  renderMs: number;     // time between nav-start and useEffect fire
  heapDelta: number;    // bytes gained/lost vs previous route
}

export interface PerfMarker {
  id: string;
  ts: number;
  label: string;
  route: string;
  heapUsed: number;     // snapshot at marker time
}

export interface FpsSample {
  ts: number;
  fps: number;
  route: string;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export interface PerfSummary {
  sessionDurationSeconds: number;
  peakHeapMB: number;
  avgHeapMB: number;
  longTaskCount: number;
  totalLongTaskMs: number;
  worstLongTaskMs: number;
  worstLongTaskRoute: string;
  routeCount: number;
  slowestRouteMs: number;
  slowestRoute: string;
  avgFps: number;
  minFps: number;
  minFpsRoute: string;
}

interface PerfState {
  recording: boolean;
  startedAt: number | null;

  memorySnapshots: MemorySnapshot[];
  longTasks: LongTask[];
  routeChanges: RouteChange[];
  markers: PerfMarker[];
  fpsSamples: FpsSample[];

  // Actions
  startRecording: () => void;
  pauseRecording: () => void;
  addMemorySnapshot: (snap: MemorySnapshot) => void;
  addLongTask: (task: Omit<LongTask, "id">) => void;
  addRouteChange: (change: Omit<RouteChange, "id">) => void;
  addMarker: (label: string, route: string) => void;
  addFpsSample: (sample: FpsSample) => void;
  clearAll: () => void;
  buildSummary: () => PerfSummary;
  buildExport: () => object;
}

let _seq = 0;
const uid = () => `p${++_seq}`;

function readMemory() {
  const m = (performance as any).memory;
  return {
    heapUsed:  m?.usedJSHeapSize  ?? 0,
    heapTotal: m?.totalJSHeapSize ?? 0,
    heapLimit: m?.jsHeapSizeLimit ?? 0,
  };
}

export const usePerfStore = create<PerfState>((set, get) => ({
  recording: true,
  startedAt: Date.now(),

  memorySnapshots: [],
  longTasks: [],
  routeChanges: [],
  markers: [],
  fpsSamples: [],

  startRecording: () =>
    set((s) => ({ recording: true, startedAt: s.startedAt ?? Date.now() })),

  pauseRecording: () => set({ recording: false }),

  addMemorySnapshot: (snap) => {
    if (!get().recording) return;
    set((s) => ({ memorySnapshots: [...s.memorySnapshots.slice(-600), snap] }));
  },

  addLongTask: (task) => {
    if (!get().recording) return;
    set((s) => ({ longTasks: [...s.longTasks.slice(-400), { ...task, id: uid() }] }));
  },

  addRouteChange: (change) => {
    set((s) => ({ routeChanges: [...s.routeChanges.slice(-400), { ...change, id: uid() }] }));
  },

  addMarker: (label, route) => {
    const { heapUsed } = readMemory();
    set((s) => ({
      markers: [...s.markers, { id: uid(), ts: Date.now(), label, route, heapUsed }],
    }));
  },

  addFpsSample: (sample) => {
    if (!get().recording) return;
    set((s) => ({ fpsSamples: [...s.fpsSamples.slice(-180), sample] }));
  },

  clearAll: () =>
    set({
      memorySnapshots: [],
      longTasks: [],
      routeChanges: [],
      markers: [],
      fpsSamples: [],
      startedAt: Date.now(),
    }),

  buildSummary: () => {
    const s = get();
    const elapsed = s.startedAt ? (Date.now() - s.startedAt) / 1000 : 0;
    const heaps   = s.memorySnapshots.map((m) => m.heapUsed);
    const fpsList = s.fpsSamples.map((f) => f.fps);

    const worstTask = s.longTasks.length
      ? s.longTasks.reduce((a, b) => (a.duration > b.duration ? a : b))
      : null;
    const slowestRoute = s.routeChanges.length
      ? s.routeChanges.reduce((a, b) => (a.renderMs > b.renderMs ? a : b))
      : null;
    const minFpsSample = fpsList.length
      ? s.fpsSamples.reduce((a, b) => (a.fps < b.fps ? a : b))
      : null;

    return {
      sessionDurationSeconds: Math.round(elapsed),
      peakHeapMB:   heaps.length ? +(Math.max(...heaps) / 1024 / 1024).toFixed(2) : 0,
      avgHeapMB:    heaps.length ? +(heaps.reduce((a, b) => a + b, 0) / heaps.length / 1024 / 1024).toFixed(2) : 0,
      longTaskCount: s.longTasks.length,
      totalLongTaskMs: Math.round(s.longTasks.reduce((a, t) => a + t.duration, 0)),
      worstLongTaskMs: worstTask ? Math.round(worstTask.duration) : 0,
      worstLongTaskRoute: worstTask?.route ?? "—",
      routeCount: s.routeChanges.length,
      slowestRouteMs: slowestRoute ? Math.round(slowestRoute.renderMs) : 0,
      slowestRoute: slowestRoute ? `${slowestRoute.from} → ${slowestRoute.to}` : "—",
      avgFps: fpsList.length ? +(fpsList.reduce((a, b) => a + b, 0) / fpsList.length).toFixed(1) : 0,
      minFps: fpsList.length ? Math.min(...fpsList) : 0,
      minFpsRoute: minFpsSample?.route ?? "—",
    };
  },

  buildExport: () => {
    const s = get();
    return {
      exportedAt: new Date().toISOString(),
      appVersion: "MKCP Dashboard",
      summary: s.buildSummary(),
      memorySnapshots: s.memorySnapshots,
      longTasks: s.longTasks,
      routeChanges: s.routeChanges,
      markers: s.markers,
      fpsSamples: s.fpsSamples,
    };
  },
}));
