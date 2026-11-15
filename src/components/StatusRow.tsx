/*
 * The one row shape: an icon tile carrying the STATUS, the subject, a meta line, and the reason in full.
 * Corners are concentric: the row is 12 px at the edge of its 8 px tray, its icon tile 4 px inside the row's own 8 px gap.
 * A reason is never shortened and never hidden behind a click.
 */
import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export type RowTone = "neutral" | "success" | "danger" | "warn" | "accent";

const TONE_TILE: Record<RowTone, string> = {
  neutral: "bg-neutral-100 text-neutral-700",
  success: "bg-success-soft text-success-700",
  danger: "bg-danger-soft text-danger-700",
  warn: "bg-warn-soft text-warn-700",
  accent: "bg-accent-soft text-accent-700",
};

export interface StatusRowProps {
  icon: LucideIcon;
  tone: RowTone;
  /** The subject of the row: a voucher type, a channel name, a kind of sync. */
  title: string;
  /** Second subject on the same line (party, company, address). */
  subject?: ReactNode;
  /** When or how much. Small and never the thing you read first. */
  meta?: ReactNode;
  /** A richer body under the meta line, for rows that carry figures. */
  detail?: ReactNode;
  /** The reason, in full. */
  error?: string | null;
  action?: ReactNode;
  spinning?: boolean;
}

export function StatusRow({ icon: Icon, tone, title, subject, meta, detail, error, action, spinning }: StatusRowProps) {
  return (
    <li className="rounded-md bg-white p-2 shadow-card">
      <div className="flex items-start gap-3">
        {/* 44 px square tile so the row never feels thinner than a tap target; 8 px corner = the row's 12 minus its 4 px inset. */}
        <span className={clsx("grid h-11 w-11 shrink-0 place-items-center rounded-sm", TONE_TILE[tone])}>
          <Icon size={16} className={spinning ? "animate-spin" : undefined} />
        </span>
        <div className="min-w-0 flex-1 py-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-medium text-neutral-900">{title}</span>
                {subject && <span className="text-sm text-neutral-700 wrap-anywhere">{subject}</span>}
              </div>
              {meta && <div className="text-xs tabular-nums text-neutral-600 wrap-anywhere">{meta}</div>}
            </div>
            {action && <div className="shrink-0">{action}</div>}
          </div>
          {detail && <div className="mt-1 text-sm text-neutral-700">{detail}</div>}
          {error && <p className="mt-2 rounded-sm bg-danger-soft px-3 py-2 text-xs text-danger-700 wrap-anywhere">{error}</p>}
        </div>
      </div>
    </li>
  );
}

/** The small heading that opens a group of rows inside a panel. */
export function RowGroupHeading({
  children, tone = "neutral", icon: Icon,
}: {
  children: ReactNode;
  tone?: "neutral" | "danger" | "warn";
  icon?: LucideIcon;
}) {
  return (
    <h3
      className={clsx(
        "mb-2 flex items-center gap-2 font-sans text-xs font-medium tracking-normal",
        tone === "danger" ? "text-danger-700" : tone === "warn" ? "text-warn-700" : "text-neutral-600",
      )}
    >
      {Icon && <Icon size={16} />}
      {children}
    </h3>
  );
}

/** The panel-is-empty state. One box everywhere, so "nothing here" never reads as "still loading". */
export function EmptyNote({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md bg-bg-sub px-4 py-6 text-center">
      <Icon size={20} className="text-neutral-500" />
      <span className="text-sm text-neutral-700">{children}</span>
    </div>
  );
}

export default StatusRow;
