import { lazy, Suspense, useEffect, startTransition } from "react";
import { BrowserRouter, HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { usePerfMonitor } from "./hooks/usePerfMonitor";
import { Loader2 } from "lucide-react";
import { Layout } from "./components/Layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastProvider } from "./components/Toast";
import { useDataStore } from "./store/dataStore";
import { useOverrideStore } from "./store/overrideStore";
import { useDiscountStore } from "./store/discountStore";
import { loadData, loadFromStore } from "./db/idb";
import { deserializeParsedData } from "./utils/serialize";
import { useTallyAutoSync } from "./hooks/useTallyAutoSync";
import { usePersistenceMonitor } from "./hooks/usePersistenceMonitor";
import { useSupabaseConfigSync } from "./hooks/useSupabaseConfigSync";
import { useSupabaseAutoPushAfterTally } from "./hooks/useSupabaseAutoPushAfterTally";
import { useSupabaseAutoPushInterval } from "./hooks/useSupabaseAutoPushInterval";
import { initializeVendorGroups } from "./services/vendorGroupInitService";
import { initializeOrderGroups } from "./services/orderGroupInitService";
import "./utils/dataDebug"; // Initialize data persistence debug utilities

// Lazy load pages
const ImportPage = lazy(() => import("./pages/Import"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Orders = lazy(() => import("./pages/Orders"));
const Invoices = lazy(() => import("./pages/Invoices"));
const Ledgers = lazy(() => import("./pages/Ledgers"));
const Reports = lazy(() => import("./pages/Reports"));
const Settings = lazy(() => import("./pages/Settings"));
const Edit = lazy(() => import("./pages/Edit"));
const Alerts = lazy(() => import("./pages/Alerts"));
const PendingOrders = lazy(() => import("./pages/PendingOrders"));
const PriceList = lazy(() => import("./pages/PriceList"));
const RoutesPage = lazy(() => import("./pages/Routes"));
const Discounts = lazy(() => import("./pages/Discounts"));
const DiscountRules = lazy(() => import("./pages/DiscountRules"));
const PriceListCorrection = lazy(() => import("./pages/PriceListCorrection"));
const ServerLogs = lazy(() => import("./pages/ServerLogs"));
const Outreach = lazy(() => import("./pages/Outreach"));
const CalendarPage = lazy(() => import("./pages/Calendar"));
const PerfLog = lazy(() => import("./pages/PerfLog"));
const TallyPush = lazy(() => import("./pages/TallyPush"));
const DistancePage = lazy(() => import("./pages/DistancePage"));

// Loading fallback component
function LoadingFallback() {
  return (
    <div className="flex items-center justify-center h-[60vh]">
      <Loader2 className="animate-spin text-accent" size={32} />
    </div>
  );
}

function AppRoutes() {
  const data = useDataStore((s) => s.data);
  const setData = useDataStore((s) => s.setData);

  // Enable Tally auto-sync
  useTallyAutoSync();

  // Background performance monitoring (memory, long tasks, FPS, route timing)
  usePerfMonitor();

  // Enable automatic data persistence and monitoring
  usePersistenceMonitor({ verbose: (import.meta as any).env?.DEV });

  // Enable automatic syncing of config data (discounts, order groups, unit overrides) to Supabase
  useSupabaseConfigSync();

  // 5 minutes after every Tally sync completes, push EVERYTHING to Supabase
  // (config + items + ledgers + vouchers with full inventory lines)
  useSupabaseAutoPushAfterTally();

  // Every 15 minutes (regardless of Tally sync), push EVERYTHING to Supabase.
  // Belt-and-suspenders: guarantees user-edited data lands in Supabase even
  // for sessions where the user only edits config and never triggers a Tally sync.
  useSupabaseAutoPushInterval();

  // Load saved discount rules from Electron file on startup.
  // This ensures user edits survive even if localStorage is cleared (reinstall, cache wipe).
  // Zustand persist already handles the normal cross-session case via localStorage.
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

  // Restore from IndexedDB on first load with comprehensive error handling
  useEffect(() => {
    (async () => {
      try {
        // Always attempt to restore data, don't skip if data exists.
        // Use startTransition so React keeps the UI interactive while
        // hydration runs — paints the empty Dashboard skeleton first,
        // then upgrades to full data without blocking input/scroll.
        const raw = await loadData<unknown>("parsedData");
        if (raw) {
          const parsed = deserializeParsedData(raw);
          startTransition(() => {
            setData(parsed);
          });
          console.log(`[RESTORE] ✓ Loaded persisted data: ${parsed.vouchers?.length ?? 0} vouchers, ${parsed.items?.size ?? 0} items`);
        } else {
          console.log("[RESTORE] ℹ No persisted data found in IndexedDB");
        }

        // Restore unit overrides from IDB if Zustand localStorage is empty
        const currentOverrides = useOverrideStore.getState().units;
        if (!currentOverrides || Object.keys(currentOverrides).length === 0) {
          const storedOverrides = await loadFromStore<Record<string, any>>("unitOverrides", "latest");
          if (storedOverrides && Object.keys(storedOverrides).length > 0) {
            for (const [itemId, override] of Object.entries(storedOverrides)) {
              useOverrideStore.getState().setUnitOverride(itemId, override);
            }
            console.log(`[RESTORE] ✓ Loaded ${Object.keys(storedOverrides).length} unit overrides`);
          }
        }

        // Load default overrides from repo if nothing exists
        await useOverrideStore.getState().loadDefaults();
      } catch (e) {
        console.error("[RESTORE] ✗ Failed to restore data from IndexedDB:", e);
        // Still try to load defaults even if restore fails
        try {
          await useOverrideStore.getState().loadDefaults();
        } catch (defaultErr) {
          console.error("[RESTORE] ✗ Failed to load default overrides:", defaultErr);
        }
      }
    })();
  }, [setData]);

  // Initialize vendor groups and order groups when data loads
  useEffect(() => {
    if (data && data.items && data.items.size > 0) {
      const itemsArray = Array.from(data.items.values());
      initializeVendorGroups(itemsArray);
      initializeOrderGroups(itemsArray);
    }
  }, [data?.vouchers?.length]); // Trigger when data updates (vouchers.length is a stable indicator)

  return (
    <Layout>
      <Suspense fallback={<LoadingFallback />}>
        <Routes>
          <Route path="/" element={<Navigate to={data ? "/orders" : "/import"} replace />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/ledgers" element={<Ledgers />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/edit" element={<Edit />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/pending-orders" element={<PendingOrders />} />
          <Route path="/price-list" element={<PriceList />} />
          <Route path="/routes" element={<RoutesPage />} />
          <Route path="/discounts" element={<Discounts />} />
          <Route path="/discount-rules" element={<DiscountRules />} />
          <Route path="/price-correction" element={<PriceListCorrection />} />
          <Route path="/outreach" element={<Outreach />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/server-logs" element={<ServerLogs />} />
          <Route path="/perf-log" element={<PerfLog />} />
          <Route path="/tally-push" element={<TallyPush />} />
          <Route path="/distance" element={<DistancePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}

// file:// URLs (Electron packaged build) need HashRouter — BrowserRouter requires
// a server to handle path rewrites, which doesn't exist in a local file context.
const Router = (window as any).electronAPI?.isElectron ? HashRouter : BrowserRouter;

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <Router>
          <AppRoutes />
        </Router>
      </ToastProvider>
    </ErrorBoundary>
  );
}
