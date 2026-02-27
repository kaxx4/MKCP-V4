import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastProvider } from "./components/Toast";
import { useDataStore } from "./store/dataStore";
import { loadData } from "./db/idb";
import { deserializeParsedData } from "./utils/serialize";
import ImportPage from "./pages/Import";
import Dashboard from "./pages/Dashboard";
import Orders from "./pages/Orders";
import Invoices from "./pages/Invoices";
import Ledgers from "./pages/Ledgers";
import Reports from "./pages/Reports";
import Settings from "./pages/Settings";
import Edit from "./pages/Edit";

function AppRoutes() {
  const { data, setData } = useDataStore();

  // Restore from IndexedDB on first load
  useEffect(() => {
    if (!data) {
      loadData<unknown>("parsedData").then((raw) => {
        if (raw) {
          try {
            setData(deserializeParsedData(raw));
          } catch (e) {
            console.error("Failed to restore data from IDB:", e);
          }
        }
      });
    }
  }, []);

  return (
    <Layout>
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
