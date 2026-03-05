import { NavLink } from "react-router-dom";
import {
  Upload,
  LayoutDashboard,
  ShoppingCart,
  FileText,
  BookOpen,
  BarChart2,
  Settings,
  Pencil,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Bike,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useUIStore } from "../store/uiStore";
import { useTallyStore } from "../store/tallyStore";
import clsx from "clsx";

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

export function NavBar() {
  const { sidebarOpen, setSidebarOpen } = useUIStore();
  const { isConnected, lastSyncAt } = useTallyStore();

  const formatLastSync = () => {
    if (!lastSyncAt) return "Never";
    const date = new Date(lastSyncAt);
    const now = new Date();
    const diffMins = Math.floor((now.getTime() - date.getTime()) / 60000);
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    return date.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
  };

  return (
    <nav
      className={clsx(
        "fixed left-0 top-0 h-full bg-bg-card border-r border-bg-border flex flex-col transition-all duration-200 z-20",
        sidebarOpen ? "w-[220px]" : "w-14"
      )}
    >
      {/* Logo */}
      <div className="flex items-center gap-3 px-3 py-4 border-b border-bg-border h-14">
        <Bike size={22} className="text-accent flex-shrink-0" />
        {sidebarOpen && (
          <span className="text-primary font-bold text-sm font-sans truncate">MK Cycles</span>
        )}
      </div>

      {/* Nav items */}
      <div className="flex-1 py-3 flex flex-col gap-1 px-2">
        {NAV_ITEMS.map(({ path, icon: Icon, label }) => (
          <NavLink
            key={path}
            to={path}
            className={({ isActive }) =>
              clsx(
                "flex items-center gap-3 px-2 py-2.5 rounded-lg transition-colors text-sm",
                isActive
                  ? "bg-accent/15 text-accent font-medium"
                  : "text-muted hover:text-primary hover:bg-bg-border/50"
              )
            }
          >
            <Icon size={18} className="flex-shrink-0" />
            {sidebarOpen && <span className="font-sans">{label}</span>}
          </NavLink>
        ))}
      </div>

      {/* Tally Connection Status */}
      <NavLink
        to="/import"
        className="mx-2 mb-2 px-2 py-2 rounded-lg hover:bg-bg-border/50 transition border border-bg-border"
        title={isConnected ? `Connected - Last sync: ${formatLastSync()}` : "Not connected - Click to connect"}
      >
        <div className="flex items-center gap-2">
          {isConnected ? (
            <Wifi size={14} className="text-success flex-shrink-0" />
          ) : (
            <WifiOff size={14} className="text-danger flex-shrink-0" />
          )}
          {sidebarOpen && (
            <div className="flex flex-col min-w-0">
              <span className={clsx(
                "text-xs font-medium truncate",
                isConnected ? "text-success" : "text-danger"
              )}>
                {isConnected ? "Tally Connected" : "Tally Offline"}
              </span>
              {lastSyncAt && (
                <span className="text-[10px] text-muted truncate">
                  {formatLastSync()}
                </span>
              )}
            </div>
          )}
        </div>
      </NavLink>

      {/* Collapse toggle */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="flex items-center justify-center p-3 border-t border-bg-border text-muted hover:text-primary transition"
      >
        {sidebarOpen ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </button>
    </nav>
  );
}
