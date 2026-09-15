import { useEffect, useState, startTransition } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastProvider } from "./components/Toast";
import { Layout } from "./components/Layout";
import { useDataStore } from "./store/dataStore";
import { useOverrideStore } from "./store/overrideStore";
import { useDiscountStore } from "./store/discountStore";
import { loadData, loadFromStore } from "./db/idb";
import { deserializeParsedData } from "./utils/serialize";
import { useScheduledSyncs } from "./hooks/useScheduledSyncs";
import { usePersistenceMonitor } from "./hooks/usePersistenceMonitor";
import AgentStatus from "./AgentStatus";
import QuickView from "./QuickView";

function SyncAgent() {
  const setData = useDataStore((s) => s.setData);

  // The ONLY automatic sync: three scheduled quick syncs (Today / 7d / FY),
  // each pulls from Tally then pushes to Supabase. No other auto-sync/push.
  useScheduledSyncs();
  usePersistenceMonitor({ verbose: (import.meta as any).env?.DEV });

  // Restore local IDB snapshot on boot (feeds the scheduled-sync merge path)
  useEffect(() => {
    (async () => {
      try {
        const raw = await loadData<unknown>("parsedData");
        if (raw) {
          const parsed = deserializeParsedData(raw);
          startTransition(() => setData(parsed));
        }
        const currentOverrides = useOverrideStore.getState().units;
        if (!currentOverrides || Object.keys(currentOverrides).length === 0) {
          const storedOverrides = await loadFromStore<Record<string, any>>("unitOverrides", "latest");
          if (storedOverrides && Object.keys(storedOverrides).length > 0) {
            for (const [itemId, override] of Object.entries(storedOverrides)) {
              useOverrideStore.getState().setUnitOverride(itemId, override);
            }
          }
        }
        await useOverrideStore.getState().loadDefaults();
      } catch (e) {
        console.error("[RESTORE] Failed:", e);
        try { await useOverrideStore.getState().loadDefaults(); } catch {}
      }
    })();
  }, [setData]);

  // Load discount rules from Electron file store
  useEffect(() => {
    const api = (window as any).electronAPI?.discountRules;
    if (!api) return;
    api.load().then((res: { ok: boolean; data?: { categories: any[]; itemCategoryOverrides: Record<string, string> } }) => {
      if (res.ok && res.data?.categories?.length) {
        useDiscountStore.getState().hydrateFromFile({
          categories: res.data.categories,
          itemCategoryOverrides: res.data.itemCategoryOverrides ?? {},
        });
      }
    }).catch(() => {});
  }, []);

  return <AgentStatus />;
}

/**
 * Which window is this.
 *
 * `public/electron.js` opens a second, always-on-top BrowserWindow at `#/pip`
 * (tray → "Toggle Quick View", and Ctrl+Shift+P). Nothing read that hash until
 * 15-Sep-2026, so BOTH windows rendered `<SyncAgent />` — which meant the small
 * one showed the entire 1,100-line status board, and, less visibly, mounted a
 * SECOND `useScheduledSyncs()`: a duplicate 30-minute Today sync firing at
 * TallyPrime's single-threaded XML port from a window nobody was looking at.
 *
 * A hash, not a router. One alternative route does not earn a router
 * dependency, and `hashchange` is the whole of what react-router would be doing
 * here.
 */
function useRoute(): "pip" | "main" {
  const read = () => (window.location.hash.replace(/^#\/?/, "").split("?")[0] === "pip" ? "pip" : "main");
  const [route, setRoute] = useState<"pip" | "main">(read);
  useEffect(() => {
    const onHash = () => setRoute(read());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

export default function App() {
  const route = useRoute();
  return (
    <ErrorBoundary>
      <ToastProvider>
        <Layout>
          {/* Quick View mounts NEITHER the scheduler nor the IDB restore — it is
              a reader, and the window doing the work is the main one. */}
          {route === "pip" ? <QuickView /> : <SyncAgent />}
        </Layout>
      </ToastProvider>
    </ErrorBoundary>
  );
}
