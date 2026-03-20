import { useState } from "react";
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
  ChevronLeft,
  ChevronRight,
  Bike,
  Wifi,
  WifiOff,
  MoreHorizontal,
  X,
} from "lucide-react";
import { useUIStore } from "../store/uiStore";
import { useTallyStore } from "../store/tallyStore";
import clsx from "clsx";

// Apple HIG color tokens
const COLORS = {
  bg: "bg-white dark:bg-neutral-950",
  border: "border-neutral-200 dark:border-neutral-800",
  text: {
    primary: "text-neutral-950 dark:text-neutral-50",
    secondary: "text-neutral-600 dark:text-neutral-400",
    tertiary: "text-neutral-700 dark:text-neutral-300",
  },
  hover: "hover:bg-neutral-100 dark:hover:bg-neutral-900",
  bgHover: "bg-neutral-100 dark:bg-neutral-900",
  accentBg: "bg-accent/10 dark:bg-accent/20",
};

const NAV_ITEMS = [
  { path: "/import", icon: Upload, label: "Import" },
  { path: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { path: "/orders", icon: ShoppingCart, label: "Orders" },
  { path: "/alerts", icon: AlertTriangle, label: "Alerts" },
  { path: "/invoices", icon: FileText, label: "Invoices" },
  { path: "/reports", icon: BarChart2, label: "Reports" },
  { path: "/edit", icon: Pencil, label: "Edit Units" },
  { path: "/settings", icon: Settings, label: "Settings" },
];

const MOBILE_PRIMARY = NAV_ITEMS.slice(0, 5);
const MOBILE_OVERFLOW = NAV_ITEMS.slice(5);

export function NavBar() {
  const { sidebarOpen, setSidebarOpen, isMobile } = useUIStore();
  const { isConnected, lastSyncAt } = useTallyStore();
  const [moreOpen, setMoreOpen] = useState(false);

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
          className={clsx("fixed bottom-0 left-0 right-0 h-14 flex items-center justify-around z-30 px-1", COLORS.bg, "border-t", COLORS.border, "bg-white/95 dark:bg-neutral-950/95 backdrop-blur-md")}
          aria-label="Main navigation"
        >
          {MOBILE_PRIMARY.map(({ path, icon: Icon, label }) => (
            <NavLink
              key={path}
              to={path}
              className={({ isActive }) =>
                clsx(
                  "flex flex-col items-center justify-center gap-0.5 px-2 py-1.5 rounded-lg min-w-[52px] transition-colors duration-150",
                  isActive ? "text-accent font-medium" : clsx(COLORS.text.secondary, "hover:text-neutral-950 dark:hover:text-neutral-50")
                )
              }
              aria-label={label}
            >
              <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
              <span className="text-[10px] font-medium leading-none">{label}</span>
            </NavLink>
          ))}

          <button
            onClick={() => setMoreOpen(true)}
            className={clsx("flex flex-col items-center justify-center gap-0.5 px-2 py-1.5 rounded-lg min-w-[52px] transition-colors duration-150", COLORS.text.secondary, "hover:text-neutral-950 dark:hover:text-neutral-50")}
            aria-label="More navigation options"
            aria-expanded={moreOpen}
          >
            <MoreHorizontal size={20} strokeWidth={1.75} aria-hidden="true" />
            <span className="text-[10px] font-medium leading-none">More</span>
          </button>
        </nav>

        {moreOpen && (
          <div className="fixed inset-0 z-40 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label="Navigation menu">
            <div
              className="absolute inset-0 bg-black/30 backdrop-blur-sm"
              onClick={() => setMoreOpen(false)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Escape" && setMoreOpen(false)}
            />

            <div className={clsx("relative rounded-t-2xl border-t p-4 pb-6 animate-slide-up shadow-xl", COLORS.bg, COLORS.border)}>
              <div className="w-8 h-1 bg-neutral-300 dark:bg-neutral-700 rounded-full mx-auto mb-4" aria-hidden="true" />

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
                          : clsx(COLORS.text.secondary, "hover:text-neutral-950 dark:hover:text-neutral-50", COLORS.hover)
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
                  <Wifi size={14} className="text-success-600 dark:text-success-400 flex-shrink-0" />
                ) : (
                  <WifiOff size={14} className="text-danger-600 dark:text-danger-400 flex-shrink-0" />
                )}
                <div className="flex flex-col">
                  <span className={clsx("text-xs font-medium", isConnected ? "text-success-600 dark:text-success-400" : "text-danger-600 dark:text-danger-400")}>
                    {isConnected ? "Tally Connected" : "Tally Offline"}
                  </span>
                  {lastSyncAt && <span className={clsx("text-[10px]", COLORS.text.secondary)}>Last sync: {formatLastSync()}</span>}
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
        <div className="w-8 h-8 rounded-lg bg-accent/10 dark:bg-accent/20 flex items-center justify-center flex-shrink-0">
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
                  : clsx(COLORS.text.secondary, "hover:text-neutral-950 dark:hover:text-neutral-50", COLORS.hover)
              )
            }
            aria-label={label}
          >
            <Icon size={18} strokeWidth={1.75} className="flex-shrink-0" aria-hidden="true" />
            {sidebarOpen && <span className="truncate">{label}</span>}
          </NavLink>
        ))}
      </div>

      {/* Tally Connection Status */}
      <div className="px-2 pb-2">
        <NavLink
          to="/import"
          className={clsx("flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors border", COLORS.hover, COLORS.border)}
          title={isConnected ? `Connected - Last sync: ${formatLastSync()}` : "Not connected - Click to connect"}
        >
          {isConnected ? (
            <Wifi size={14} className="text-success-600 dark:text-success-400 flex-shrink-0" />
          ) : (
            <WifiOff size={14} className="text-danger-600 dark:text-danger-400 flex-shrink-0" />
          )}
          {sidebarOpen && (
            <div className="flex flex-col min-w-0">
              <span className={clsx("text-xs font-medium truncate", isConnected ? "text-success-600 dark:text-success-400" : "text-danger-600 dark:text-danger-400")}>
                {isConnected ? "Connected" : "Offline"}
              </span>
              {lastSyncAt && <span className={clsx("text-[10px] truncate", COLORS.text.secondary)}>{formatLastSync()}</span>}
            </div>
          )}
        </NavLink>
      </div>

      {/* Collapse toggle */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className={clsx("flex items-center justify-center h-10 border-t transition-colors cursor-pointer", COLORS.border, COLORS.text.secondary, COLORS.hover)}
        aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
      >
        {sidebarOpen ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </button>
    </nav>
  );
}
