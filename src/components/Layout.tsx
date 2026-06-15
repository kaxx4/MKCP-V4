import { type ReactNode, useEffect } from "react";
import { NavBar } from "./NavBar";
import { useUIStore } from "../store/uiStore";
import clsx from "clsx";

export function Layout({ children }: { children: ReactNode }) {
  // Granular selectors — Layout only re-renders when sidebarOpen / isMobile change.
  // Previously `const { ... } = useUIStore()` returned the whole store object on every
  // uiStore mutation (fyYear, coverMonths edits in Settings) triggering Layout +
  // NavBar + main content re-renders even when their props were unchanged.
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const isMobile = useUIStore((s) => s.isMobile);
  const setIsMobile = useUIStore((s) => s.setIsMobile);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent | MediaQueryList) => {
      const mobile = e.matches;
      setIsMobile(mobile);
      if (mobile) setSidebarOpen(false);
    };
    handler(mq);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [setIsMobile, setSidebarOpen]);

  return (
    <div className="min-h-screen bg-neutral-100 text-neutral-950 font-sans">
      <a href="#main-content" className="skip-to-content">
        Skip to main content
      </a>

      <NavBar />
      <main
        id="main-content"
        className={clsx(
          "min-h-screen",
          isMobile ? "ml-0 pb-16" : sidebarOpen ? "ml-[220px]" : "ml-14"
        )}
      >
        <div className={clsx("mx-auto max-w-screen-2xl", isMobile ? "p-3 pt-4" : "p-4 lg:p-5")}>
          {children}
        </div>
      </main>
    </div>
  );
}
