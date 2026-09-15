/* Copied VERBATIM from the web dashboard (MKCP MOB2) so the two apps cannot
   drift on how a page announces itself. Keep them identical; if this one needs
   to change, change both. */
import clsx from "clsx";
import type { ReactNode } from "react";

interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned actions (toggles, search, buttons) — wraps under the title on narrow screens. */
  actions?: ReactNode;
  className?: string;
}

/**
 * Desktop page header — formalizes the `.page-header`/`.page-title`/`.page-subtitle`
 * CSS classes every page already applies by hand, so title sizing, subtitle spacing,
 * and the title/actions row layout can't drift page to page.
 */
export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <div className={clsx("page-header", className)}>
      <div className="page-header-row flex-wrap gap-3">
        <div className="min-w-0">
          <h1 className="page-title">{title}</h1>
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
      </div>
    </div>
  );
}
