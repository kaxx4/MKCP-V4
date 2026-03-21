import { type ReactNode, useEffect } from "react";
import { NavBar } from "./NavBar";
import { useUIStore } from "../store/uiStore";
import clsx from "clsx";

export function Layout({ children }: { children: ReactNode }) {
  const { sidebarOpen, isMobile, setIsMobile, setSidebarOpen } = useUIStore();

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
          "transition-[margin] duration-200 min-h-screen",
          isMobile ? "ml-0 pb-16" : sidebarOpen ? "ml-[220px]" : "ml-14"
        )}
      >
        <div className={clsx("mx-auto max-w-screen-2xl", isMobile ? "p-4 pt-5" : "p-8 lg:p-10")}>
          {children}
        </div>
      </main>
    </div>
  );
}
