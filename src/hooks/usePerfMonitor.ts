/**
 * usePerfMonitor — auto-instruments the app with zero-config perf tracking.
 *
 * Must be called inside <Router> so useLocation works.
 * Instruments:
 *  - Route changes (timing + heap delta)
 *  - Memory snapshots every 5 s (performance.memory — Chromium/Electron only)
 *  - Long tasks (PerformanceObserver entryType "longtask")
 *  - FPS counter via requestAnimationFrame (1 sample/sec)
 */
import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { usePerfStore } from "../store/perfStore";

function snapMemory() {
  const m = (performance as any).memory;
  return {
    heapUsed:  m?.usedJSHeapSize  ?? 0,
    heapTotal: m?.totalJSHeapSize ?? 0,
    heapLimit: m?.jsHeapSizeLimit ?? 0,
  };
}

/** Returns the canonical "route path" regardless of HashRouter vs BrowserRouter. */
function currentPath(): string {
  const hash = window.location.hash.replace(/^#/, "");
  return hash || window.location.pathname;
}

export function usePerfMonitor() {
  const location  = useLocation();
  const store     = usePerfStore;   // read store without subscribing (avoids re-renders)

  // Mutable refs — safe to read in closures without stale captures
  const prevRoute  = useRef<string>(location.pathname);
  const prevHeap   = useRef<number>(0);
  const navTs      = useRef<number>(performance.now());
  const routeRef   = useRef<string>(location.pathname);
  const fpsFrames  = useRef<number>(0);
  const lastFpsTs  = useRef<number>(performance.now());
  const rafHandle  = useRef<number>(0);

  // Keep routeRef in sync with current route (used by interval/observer closures)
  useEffect(() => {
    routeRef.current = location.pathname;
  }, [location.pathname]);

  // ── Route-change timing ─────────────────────────────────────────────────
  useEffect(() => {
    const nowMs  = performance.now();
    const mem    = snapMemory();

    if (prevRoute.current !== location.pathname) {
      store.getState().addRouteChange({
        ts:         Date.now(),
        from:       prevRoute.current,
        to:         location.pathname,
        renderMs:   Math.round(nowMs - navTs.current),
        heapDelta:  mem.heapUsed - prevHeap.current,
      });
    }

    prevRoute.current = location.pathname;
    prevHeap.current  = mem.heapUsed;
    navTs.current     = performance.now();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // ── Memory snapshot every 5 s ──────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      if (!store.getState().recording) return;
      const mem = snapMemory();
      store.getState().addMemorySnapshot({
        ts: Date.now(),
        ...mem,
        route: currentPath(),
      });
    }, 5000);
    // Capture one immediately on mount
    const mem = snapMemory();
    store.getState().addMemorySnapshot({ ts: Date.now(), ...mem, route: currentPath() });

    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Long-task observer ─────────────────────────────────────────────────
  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;
    let obs: PerformanceObserver | null = null;
    try {
      obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!store.getState().recording) continue;
          store.getState().addLongTask({
            ts:       Date.now(),
            duration: entry.duration,
            route:    currentPath(),
          });
        }
      });
      obs.observe({ entryTypes: ["longtask"] });
    } catch {
      // "longtask" not supported in this runtime (e.g., Firefox)
    }
    return () => obs?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── FPS counter ────────────────────────────────────────────────────────
  useEffect(() => {
    function tick() {
      fpsFrames.current++;
      const now = performance.now();
      if (now - lastFpsTs.current >= 1000) {
        if (store.getState().recording) {
          store.getState().addFpsSample({
            ts:    Date.now(),
            fps:   fpsFrames.current,
            route: currentPath(),
          });
        }
        fpsFrames.current = 0;
        lastFpsTs.current = now;
      }
      rafHandle.current = requestAnimationFrame(tick);
    }
    rafHandle.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafHandle.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
