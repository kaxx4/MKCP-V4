import { type ReactNode, useEffect } from "react";
import { NavBar } from "./NavBar";
import { useUIStore } from "../store/uiStore";
import clsx from "clsx";

export function Layout({ children }: { children: ReactNode }) {
  const { sidebarOpen, isMobile, setIsMobile, setSidebarOpen } = useUIStore();

  // Listen for viewport changes
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent | MediaQueryList) => {
      const mobile = e.matches;
      setIsMobile(mobile);
      if (mobile) setSidebarOpen(false);
    };
    handler(mq); // initial check
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [setIsMobile, setSidebarOpen]);

  return (
    <div className="min-h-screen bg-bg text-primary font-sans">
      <NavBar />
      <main
        className={clsx(
          "transition-all duration-200 min-h-screen",
          isMobile ? "ml-0 pb-16" : sidebarOpen ? "ml-[220px]" : "ml-14"
        )}
      >
        <div className={clsx(isMobile ? "p-3" : "p-6")}>{children}</div>
      </main>
    </div>
  );
}
