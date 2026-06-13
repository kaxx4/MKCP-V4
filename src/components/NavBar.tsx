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
  Boxes,
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
  Cloud,
  CloudOff,
} from "lucide-react";
import { useUIStore } from "../store/uiStore";
import { useTallyStore } from "../store/tallyStore";
import { useDataStore } from "../store/dataStore";
import { useSupabaseSyncStatusStore } from "../store/supabaseSyncStatusStore";
import { syncDayBook } from "../api/tallyApi";
import { parseTransactions } from "../parser/transactionParser";
import { refreshDeliveryNotes } from "../services/deliveryNoteRefresh";
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
  { path: "/items-analytics", icon: Boxes, label: "Items & Analytics" },
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

/**
 * Surfaces the rollup state of the three Supabase push channels (config,
 * masters, vouchers). Click → /settings.
 *
 *   • Green Cloud — all three last attempts succeeded (or never attempted yet)
 *   • Amber Cloud — a retry is currently scheduled (transient failure, will retry in <60s)
 *   • Red CloudOff — last attempt of at least one channel failed and no retry queued
 *
 * Reads via granular selectors so the component only re-renders when the rollup
 * actually changes, not on every status mutation.
 */
function CloudSyncIndicator({ compact = false }: { compact?: boolean }) {
  const config = useSupabaseSyncStatusStore((s) => s.config);
  const masters = useSupabaseSyncStatusStore((s) => s.masters);
  const vouchers = useSupabaseSyncStatusStore((s) => s.vouchers);

  const anyFailed = config.success === false || masters.success === false || vouchers.success === false;
  const anyRetrying = config.retryScheduled || masters.retryScheduled || vouchers.retryScheduled;
  const everAttempted = !!(config.lastAt || masters.lastAt || vouchers.lastAt);

  // Pick the most recent attempt timestamp for the tooltip
  const latestAt = [config.lastAt, masters.lastAt, vouchers.lastAt]
    .filter(Boolean)
    .sort()
    .pop();
  const latestRelative = latestAt ? formatRelative(latestAt) : "never";

  const failedChannels = [
    config.success === false ? `config (${config.error ?? "failed"})` : null,
    masters.success === false ? `masters (${masters.error ?? "failed"})` : null,
    vouchers.success === false ? `vouchers (${vouchers.error ?? "failed"})` : null,
  ].filter(Boolean) as string[];

  const state: "ok" | "retry" | "fail" | "idle" =
    anyRetrying ? "retry" : anyFailed ? "fail" : everAttempted ? "ok" : "idle";

  const tone =
    state === "ok" ? "text-success-600"
    : state === "retry" ? "text-warn-600"
    : state === "fail" ? "text-danger-600"
    : "text-neutral-400";

  const label =
    state === "ok" ? "Cloud sync OK"
    : state === "retry" ? "Cloud retry pending"
    : state === "fail" ? "Cloud sync failed"
    : "Not synced yet";

  const Icon = state === "fail" ? CloudOff : Cloud;

  const title =
    state === "fail"
      ? `Last push had errors:\n${failedChannels.join("\n")}\nLast attempt: ${latestRelative}`
      : state === "retry"
      ? `Retry scheduled within 60s. Last attempt: ${latestRelative}`
      : state === "ok"
      ? `All three channels OK. Last push: ${latestRelative}`
      : "Auto-push has not run yet";

  return (
    <NavLink
      to="/settings"
      title={title}
      aria-label={label}
      className={clsx(
        "flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-[background-color,color,transform] duration-150 border min-h-10 active:scale-[0.96]",
        COLORS.hover,
        COLORS.border,
        compact && "w-full"
      )}
    >
      <Icon size={14} className={clsx("flex-shrink-0", tone, state === "retry" && "animate-pulse")} />
      <div className="flex flex-col min-w-0">
        <span className={clsx("text-xs font-medium truncate", tone)}>{label}</span>
        <span className={clsx("text-2xs truncate", COLORS.text.secondary)}>{latestRelative}</span>
      </div>
    </NavLink>
  );
}

function formatRelative(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

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

      // Also refresh delivery notes (rolling window) so fulfilled/cancelled DNs drop
      // off Pending Orders — today-only sync never removes older stale delivery notes.
      let dnMsg = "";
      try {
        const { dnCount } = await refreshDeliveryNotes(companyName);
        dnMsg = ` · ${dnCount} delivery note(s) refreshed`;
      } catch (dnErr: any) {
        console.warn("[today-sync] Delivery-note refresh failed:", dnErr?.message ?? dnErr);
        dnMsg = " · delivery-note refresh failed";
      }

      toast(`Today's daybook synced: ${parsed.vouchers.length} voucher(s) added.${dnMsg}`, "success");
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

              <CloudSyncIndicator compact />
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
                "flex items-center gap-3 px-2.5 py-2 rounded-lg transition-[background-color,color,transform] duration-150 text-sm min-h-10 active:scale-[0.96]",
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
            "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-[background-color,transform] duration-150 text-sm border min-h-10",
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
      <div className="px-2 pb-1">
        <NavLink
          to="/import"
          className={clsx("flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-[background-color,color,transform] duration-150 border min-h-10 active:scale-[0.96]", COLORS.hover, COLORS.border)}
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

      {/* Cloud Sync (Supabase auto-push health) */}
      {sidebarOpen && (
        <div className="px-2 pb-2">
          <CloudSyncIndicator />
        </div>
      )}

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
