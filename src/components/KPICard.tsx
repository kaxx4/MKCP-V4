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

export function KPICard({ title, value, sub, icon, trend, accent, danger }: KPICardProps) {
  return (
    <div
      className={clsx(
        "bg-bg-card border rounded-xl p-4 flex flex-col gap-2",
        accent ? "border-accent/40" : danger ? "border-danger/40" : "border-bg-border"
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-muted text-xs font-sans uppercase tracking-wider">{title}</span>
        {icon && <span className="text-muted">{icon}</span>}
      </div>
      <div
        className={clsx(
          "text-2xl font-mono font-semibold",
          accent ? "text-accent" : danger ? "text-danger" : "text-primary"
        )}
      >
        {value}
      </div>
      {sub && (
        <div
          className={clsx(
            "text-xs font-sans",
            trend === "up" ? "text-success" : trend === "down" ? "text-danger" : "text-muted"
          )}
        >
          {sub}
        </div>
      )}
    </div>
  );
}
