import { type ReactNode } from "react";

/** The window's one ground: a flat colour from the design tokens, with the Geist body face. */
export function Layout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-bg-page font-sans text-neutral-900">{children}</div>;
}
