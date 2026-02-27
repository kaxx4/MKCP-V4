import { type ReactNode } from "react";
import { NavBar } from "./NavBar";
import { useUIStore } from "../store/uiStore";
import clsx from "clsx";

export function Layout({ children }: { children: ReactNode }) {
  const { sidebarOpen } = useUIStore();

  return (
    <div className="min-h-screen bg-bg text-primary font-sans">
      <NavBar />
      <main
        className={clsx(
          "transition-all duration-200 min-h-screen",
          sidebarOpen ? "ml-[220px]" : "ml-14"
        )}
      >
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}
