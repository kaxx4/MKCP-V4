import { memo } from "react";
import clsx from "clsx";
import type { ReactNode } from "react";

interface KPICardProps {
  title: string;
  value: string;
  sub?: string;
  icon?: ReactNode;
  trend?: "up" | "down" | "neutral";
  accent?: boolean;
  danger?: boolean;
}

export const KPICard = memo(function KPICard({ title, value, sub, icon, trend, accent, danger }: KPICardProps) {
  return (
    <article
      className={clsx(
        "bento-card flex flex-col gap-1.5 md:gap-2 min-w-0",
        accent ? "border-accent/40" : danger ? "border-danger/40" : "border-bg-border"
      )}
      aria-label={`${title}: ${value}${sub ? `, ${sub}` : ''}`}
    >
      <div className="flex items-center justify-between gap-1 min-w-0">
        <h3 className="text-muted text-xs md:text-sm font-sans uppercase tracking-wider truncate font-medium">{title}</h3>
        {icon && <span className="text-muted flex-shrink-0" aria-hidden="true">{icon}</span>}
      </div>
      <div
        className={clsx(
          "text-lg md:text-2xl font-sans font-semibold truncate",
          accent ? "text-accent" : danger ? "text-danger" : "text-primary"
        )}
        title={value}
      >
        {value}
      </div>
      {sub && (
        <p
          className={clsx(
            "text-xs md:text-sm font-sans truncate",
            trend === "up" ? "text-success" : trend === "down" ? "text-danger" : "text-muted"
          )}
        >
          {sub}
        </p>
      )}
    </article>
  );
});
