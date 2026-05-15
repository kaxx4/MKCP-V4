import { useState, useCallback } from "react";
import { NavLink } from "react-router-dom";
import {
  Upload,
  LayoutDashboard,
  ShoppingCart,
  FileText,
  BarChart2,
  Settings,
  Pencil,
  AlertTriangle,
  Truck,
  Tag,
  ChevronLeft,
  Bike,
  Wifi,
  WifiOff,
  MoreHorizontal,
  X,
  RefreshCw,
  Map as MapIcon,
  Percent,
  Terminal,
  CalendarDays,
  Activity,
} from "lucide-react";
import { useUIStore } from "../store/uiStore";
import { useTallyStore } from "../store/tallyStore";
import { useDataStore } from "../store/dataStore";
import { syncDayBook } from "../api/tallyApi";
import { parseTransactions } from "../parser/transactionParser";
import { saveData, loadData, createBackup } from "../db/idb";
import { serializeParsedData, deserializeParsedData } from "../utils/serialize";
import { useToast } from "./Toast";
import clsx from "clsx";

const COLORS = {
  bg: "bg-white",
  border: "border-neutral-200/80",
  text: {
    primary: "text-neutral-900",
    secondary: "text-neutral-500",
    tertiary: "text-neutral-600",
  },
  hover: "hover:bg-neutral-50",
  bgHover: "bg-neutral-50",
  accentBg: "bg-accent/8",
};

const NAV_ITEMS = [
  { path: "/import", icon: Upload, label: "Import" },
  { path: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { path: "/orders", icon: ShoppingCart, label: "Orders" },
  { path: "/alerts", icon: AlertTriangle, label: "Alerts" },
  { path: "/invoices", icon: FileText, label: "Invoices" },
  { path: "/pending-orders", icon: Truck, label: "Pending Orders" },
  { path: "/price-list", icon: Tag, label: "Price List" },
  { path: "/routes", icon: MapIcon, label: "Routes" },
  { path: "/reports", icon: BarChart2, label: "Reports" },
  { path: "/calendar", icon: CalendarDays, label: "Calendar" },
  { path: "/discounts", icon: Percent, label: "Discounts" },
  { path: "/edit", icon: Pencil, label: "Edit Units" },
  { path: "/settings", icon: Settings, label: "Settings" },
  { path: "/server-logs", icon: Terminal, label: "Server Logs" },
  { path: "/perf-log", icon: Activity, label: "Perf Log" },
];

const MOBILE_PRIMARY = NAV_ITEMS.slice(0, 5);
const MOBILE_OVERFLOW = NAV_ITEMS.slice(5).sort((a, b) => {
  // Keep Reports near top of overflow menu (after primary items)
  if (a.path === "/reports") return -1;
  if (b.path === "/reports") return 1;
  return 0;
});

export function NavBar() {
  const { sidebarOpen, setSidebarOpen, isMobile } = useUIStore();
  const { isConnected, lastSyncAt, companyName, isSyncing, setSyncing, setLastSync, setLastVoucherDate, setLastVouchersSync } = useTallyStore();
  const mergeData = useDataStore((s) => s.mergeData);
  const { toast } = useToast();
  const [moreOpen, setMoreOpen] = useState(false);
  const [daybookSyncing, setDaybookSyncing] = useState(false);

  const handleTodaySync = useCallback(async () => {
    if (daybookSyncing || isSyncing) return;
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const todayStr = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;
    setDaybookSyncing(true);
    setSyncing(true);
    try {
      const result = await syncDayBook(companyName, todayStr, todayStr, "daily");
      if (!result.data || !result.data.tallymessage || result.data.tallymessage.length === 0) {
        toast("No vouchers found for today.", "info");
        return;
      }
      const parsed = parseTransactions(result.data);
      const existingRaw = await loadData<unknown>("parsedData");
      const existing = existingRaw ? deserializeParsedData(existingRaw) : null;
      if (existing) await createBackup(existingRaw, "pre-today-sync");
      const dataToMerge = {
        company: existing?.company ?? { name: companyName, fyStartMonth: 4 },
        items: existing?.items ?? new Map(),
        ledgers: existing?.ledgers ?? new Map(),
        vouchers: parsed.vouchers,
        importedAt: new Date().toISOString(),
        sourceFiles: ["tally-today-sync"],
        warnings: parsed.warnings,
      };
      mergeData(dataToMerge);
      const merged = useDataStore.getState().data!;
      await saveData("parsedData", serializeParsedData(merged));
      const now = new Date().toISOString();
      setLastSync(now);
      setLastVouchersSync(now);
      if (parsed.vouchers.length > 0) {
        const dates = parsed.vouchers.map(v => v.date).filter(Boolean).sort();
        if (dates.length) setLastVoucherDate(dates[dates.length - 1]);
      }
      toast(`Today's daybook synced: ${parsed.vouchers.length} voucher(s) added.`, "success");
    } catch (e: any) {
      toast(`Sync failed: ${e.message}`, "error");
    } finally {
      setDaybookSyncing(false);
      setSyncing(false);
    }
  }, [daybookSyncing, isSyncing, companyName, mergeData, toast, setLastSync, setLastVoucherDate, setLastVouchersSync, setSyncing]);

  const formatLastSync = () => {
    if (!lastSyncAt) return "Never";
    const date = new Date(lastSyncAt);
    const now = new Date();
    const diffMins = Math.floor((now.getTime() - date.getTime()) / 60000);
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    return date.toLocaleDateString("en-IN", { month: "short", day: "numeric" });
  };

  // ─── Mobile: Bottom Tab Bar ─────────────────────────────────
  if (isMobile) {
    return (
      <>
        <nav
          className={clsx("fixed bottom-0 left-0 right-0 h-14 flex items-center justify-around z-30 px-1", COLORS.bg, "border-t", COLORS.border)}
          aria-label="Main navigation"
        >
          {MOBILE_PRIMARY.map(({ path, icon: Icon, label }) => (
            <NavLink
              key={path}
              to={path}
              className={({ isActive }) =>
                clsx(
                  "flex flex-col items-center justify-center gap-0.5 px-2 py-1.5 rounded-lg min-w-[52px] transition-colors duration-150",
                  isActive ? "text-accent font-medium" : clsx(COLORS.text.secondary, "hover:text-neutral-950")
                )
              }
              aria-label={label}
            >
              <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
              <span className="text-2xs font-medium leading-none">{label}</span>
            </NavLink>
          ))}

          <button
            onClick={() => setMoreOpen(true)}
            className={clsx("flex flex-col items-center justify-center gap-0.5 px-2 py-1.5 rounded-lg min-w-[52px] transition-[color,transform] duration-150 active:scale-[0.96]", COLORS.text.secondary, "hover:text-neutral-950")}
            aria-label="More navigation options"
            aria-expanded={moreOpen}
          >
            <MoreHorizontal size={20} strokeWidth={1.75} aria-hidden="true" />
            <span className="text-2xs font-medium leading-none">More</span>
          </button>
        </nav>

        {moreOpen && (
          <div className="fixed inset-0 z-40 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label="Navigation menu">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setMoreOpen(false)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Escape" && setMoreOpen(false)}
            />

            <div className={clsx("relative rounded-t-2xl border-t p-4 pb-6 animate-slide-up shadow-xl", COLORS.bg, COLORS.border)}>
              <div className="w-8 h-1 bg-neutral-300 rounded-full mx-auto mb-4" aria-hidden="true" />

              <button
                onClick={() => setMoreOpen(false)}
                className="absolute top-4 right-4 btn-icon"
                aria-label="Close navigation menu"
              >
                <X size={18} aria-hidden="true" />
              </button>

              <div className="flex flex-col gap-0.5 mb-4">
                {MOBILE_OVERFLOW.map(({ path, icon: Icon, label }) => (
                  <NavLink
                    key={path}
                    to={path}
                    onClick={() => setMoreOpen(false)}
                    className={({ isActive }) =>
                      clsx(
                        "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors duration-150 text-sm",
                        isActive
                          ? clsx(COLORS.accentBg, "text-accent font-medium")
                          : clsx(COLORS.text.secondary, "hover:text-neutral-950", COLORS.hover)
                      )
                    }
                  >
                    <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
                    <span>{label}</span>
                  </NavLink>
                ))}
              </div>

              <div className={clsx("flex items-center gap-2.5 px-3 py-2.5 rounded-lg border", COLORS.bgHover, COLORS.border)}>
                {isConnected ? (
                  <Wifi size={14} className="text-success-600 flex-shrink-0" />
                ) : (
                  <WifiOff size={14} className="text-danger-600 flex-shrink-0" />
                )}
                <div className="flex flex-col">
                  <span className={clsx("text-xs font-medium", isConnected ? "text-success-600" : "text-danger-600")}>
                    {isConnected ? "Tally Connected" : "Tally Offline"}
                  </span>
                  {lastSyncAt && <span className={clsx("text-2xs", COLORS.text.secondary)}>Last sync: {formatLastSync()}</span>}
                </div>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  // ─── Desktop: Sidebar ──────────────────────────────────────
  return (
    <nav
      className={clsx(
        "fixed left-0 top-0 h-full flex flex-col transition-[width] duration-200 z-30",
        COLORS.bg,
        "border-r",
        COLORS.border,
        sidebarOpen ? "w-[220px]" : "w-14"
      )}
      aria-label="Main navigation"
    >
      {/* Logo */}
      <div className={clsx("flex items-center gap-3 px-3 h-14 border-b", COLORS.border)}>
        <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
          <Bike size={18} className="text-accent" />
        </div>
        {sidebarOpen && (
          <span className={clsx("font-bold text-sm tracking-tight truncate", COLORS.text.primary)}>MK Cycles</span>
        )}
      </div>

      {/* Nav items */}
      <div className="flex-1 py-2 flex flex-col gap-0.5 px-2 overflow-y-auto">
        {NAV_ITEMS.map(({ path, icon: Icon, label }) => (
          <NavLink
            key={path}
            to={path}
            className={({ isActive }) =>
              clsx(
                "flex items-center gap-3 px-2.5 py-2 rounded-lg transition-colors duration-150 text-sm",
                isActive
                  ? clsx(COLORS.accentBg, "text-accent font-medium")
                  : clsx(COLORS.text.secondary, "hover:text-neutral-950", COLORS.hover)
              )
            }
            aria-label={label}
          >
            <Icon size={18} strokeWidth={1.75} className="flex-shrink-0" aria-hidden="true" />
            {sidebarOpen && <span className="truncate">{label}</span>}
          </NavLink>
        ))}
      </div>

      {/* Quick Sync Today */}
      <div className="px-2 pb-1">
        <button
          onClick={handleTodaySync}
          disabled={daybookSyncing || isSyncing || !isConnected}
          title={isConnected ? "Sync today's daybook from Tally" : "Tally not connected"}
          className={clsx(
            "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-[background-color,transform] duration-150 text-sm border",
            daybookSyncing || isSyncing
              ? "opacity-60 cursor-not-allowed border-neutral-200/80 text-neutral-400"
              : isConnected
              ? "border-accent/30 text-accent hover:bg-accent/8 cursor-pointer active:scale-[0.96]"
              : "opacity-40 cursor-not-allowed border-neutral-200/80 text-neutral-400"
          )}
          aria-label="Sync today's daybook"
        >
          <RefreshCw
            size={14}
            className={clsx("flex-shrink-0", daybookSyncing && "animate-spin")}
            aria-hidden="true"
          />
          {sidebarOpen && (
            <span className="truncate text-xs font-medium">
              {daybookSyncing ? "Syncing..." : "Sync Today"}
            </span>
          )}
        </button>
      </div>

      {/* Tally Connection Status */}
      <div className="px-2 pb-2">
        <NavLink
          to="/import"
          className={clsx("flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors border", COLORS.hover, COLORS.border)}
          title={isConnected ? `Connected - Last sync: ${formatLastSync()}` : "Not connected - Click to connect"}
        >
          {isConnected ? (
            <Wifi size={14} className="text-success-600 flex-shrink-0" />
          ) : (
            <WifiOff size={14} className="text-danger-600 flex-shrink-0" />
          )}
          {sidebarOpen && (
            <div className="flex flex-col min-w-0">
              <span className={clsx("text-xs font-medium truncate", isConnected ? "text-success-600" : "text-danger-600")}>
                {isConnected ? "Connected" : "Offline"}
              </span>
              {lastSyncAt && <span className={clsx("text-2xs truncate", COLORS.text.secondary)}>{formatLastSync()}</span>}
            </div>
          )}
        </NavLink>
      </div>

      {/* Collapse toggle */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className={clsx("flex items-center justify-center h-10 border-t transition-[background-color,transform] duration-150 cursor-pointer active:scale-[0.96]", COLORS.border, COLORS.text.secondary, COLORS.hover)}
        aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
      >
        <ChevronLeft
          size={16}
          className="transition-transform duration-200"
          style={{ transform: sidebarOpen ? "rotate(0deg)" : "rotate(180deg)" }}
        />
      </button>
    </nav>
  );
}
