import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Layout } from "./components/Layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastProvider } from "./components/Toast";
import { useDataStore } from "./store/dataStore";
import { useOverrideStore } from "./store/overrideStore";
import { loadData, loadFromStore } from "./db/idb";
import { deserializeParsedData } from "./utils/serialize";

// Lazy load pages
const ImportPage = lazy(() => import("./pages/Import"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Orders = lazy(() => import("./pages/Orders"));
const Invoices = lazy(() => import("./pages/Invoices"));
const Ledgers = lazy(() => import("./pages/Ledgers"));
const Reports = lazy(() => import("./pages/Reports"));
const Settings = lazy(() => import("./pages/Settings"));
const Edit = lazy(() => import("./pages/Edit"));

// Loading fallback component
function LoadingFallback() {
  return (
    <div className="flex items-center justify-center h-[60vh]">
      <Loader2 className="animate-spin text-accent" size={32} />
    </div>
  );
}

function AppRoutes() {
  const { data, setData } = useDataStore();

  // Restore from IndexedDB on first load
  useEffect(() => {
    if (!data) {
      (async () => {
        try {
          // Restore parsed data
          const raw = await loadData<unknown>("parsedData");
          if (raw) {
            setData(deserializeParsedData(raw));
          }

          // Restore unit overrides from IDB if Zustand localStorage is empty
          const currentOverrides = useOverrideStore.getState().units;
          if (!currentOverrides || Object.keys(currentOverrides).length === 0) {
            const storedOverrides = await loadFromStore<Record<string, any>>("unitOverrides", "latest");
            if (storedOverrides && Object.keys(storedOverrides).length > 0) {
              for (const [itemId, override] of Object.entries(storedOverrides)) {
                useOverrideStore.getState().setUnitOverride(itemId, override);
              }
            }
          }

          // Load default overrides from repo if nothing exists
          await useOverrideStore.getState().loadDefaults();
        } catch (e) {
          console.error("Failed to restore data from IDB:", e);
        }
      })();
    }
  }, []);

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
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </ToastProvider>
    </ErrorBoundary>
  );
}
