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
  ChevronLeft,
  ChevronRight,
  Bike,
} from "lucide-react";
import { useUIStore } from "../store/uiStore";
import clsx from "clsx";

const NAV_ITEMS = [
  { path: "/import", icon: Upload, label: "Import" },
  { path: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { path: "/orders", icon: ShoppingCart, label: "Orders" },
  { path: "/invoices", icon: FileText, label: "Invoices" },
  { path: "/ledgers", icon: BookOpen, label: "Ledgers" },
  { path: "/reports", icon: BarChart2, label: "Reports" },
  { path: "/edit", icon: Pencil, label: "Edit Units" },
  { path: "/settings", icon: Settings, label: "Settings" },
];

export function NavBar() {
  const { sidebarOpen, setSidebarOpen } = useUIStore();

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
