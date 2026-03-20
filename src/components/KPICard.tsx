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
        "card-elevated flex flex-col gap-3 min-w-0",
        accent && "border border-accent/20",
        danger && "border border-danger/20",
        !accent && !danger && "border-0"
      )}
      aria-label={`${title}: ${value}${sub ? `, ${sub}` : ""}`}
    >
      <div className="flex items-center justify-between gap-3 min-w-0">
        <h3 className="metric-label text-neutral-600 dark:text-neutral-400 truncate">{title}</h3>
        {icon && (
          <span
            className={clsx(
              "flex-shrink-0 w-5 h-5 flex items-center justify-center",
              accent ? "text-accent" : danger ? "text-danger" : "text-neutral-500 dark:text-neutral-500"
            )}
            aria-hidden="true"
          >
            {icon}
          </span>
        )}
      </div>
      <div
        className={clsx(
          "metric-value truncate font-mono tracking-tight",
          accent ? "text-accent" : danger ? "text-danger" : "text-neutral-950 dark:text-neutral-50"
        )}
        title={value}
      >
        {value}
      </div>
      {sub && (
        <p
          className={clsx(
            "text-xs truncate font-medium",
            trend === "up" && "text-success-600 dark:text-success-400",
            trend === "down" && "text-danger-600 dark:text-danger-400",
            trend !== "up" && trend !== "down" && "text-neutral-600 dark:text-neutral-400"
          )}
        >
          {sub}
        </p>
      )}
    </article>
  );
});
