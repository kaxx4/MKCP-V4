import { type ReactNode } from "react";

export function Layout({ children }: { children: ReactNode }) {
  return (
    /* `bg-bg-page` — the app ground, defined once. This said `bg-neutral-100`
       (#f5f5f7) while AgentStatus's own wrapper said `bg-bg-page` (#eeefec,
       repainted #f2f2f4 by the bento layer), so the window had two different
       grounds stacked on each other and whichever showed depended on which
       element happened to reach the edge. Measured 15-Sep-2026: the page
       wrapper computed rgb(245,245,247) here against rgb(242,242,244) three
       lines into the same screen. */
    <div className="min-h-screen bg-bg-page text-neutral-950 font-sans">
      {children}
    </div>
  );
}
