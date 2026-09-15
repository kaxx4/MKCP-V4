/*
 * The one row shape.
 *
 * Extracted from PushQueuePanel's local `QueueRow` — output is unchanged for
 * the tones it already had, this is a de-duplication, not a restyle. It moved
 * out because the five panels rebuilt alongside it all list "a thing that has a
 * status, a subject, a meta line and sometimes a reason", and five private
 * copies of that row is how the old screen ended up with a `<table>`, a stack
 * of red boxes, a `divide-y` list and a grid of tiles all describing the same
 * kind of fact.
 *
 * The rule the shape encodes: the icon tile carries the STATUS, the title
 * carries the SUBJECT, the meta line carries when/how much, and the reason —
 * which is the only useful part of a failure — sits with its own row, in full,
 * never truncated and never behind a click.
 */
import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export type RowTone = "neutral" | "success" | "danger" | "warn" | "accent";

/* Semantic tokens only. "Failed" must be the same red here, in the push queue,
   and in the web dashboard — which it was not while these panels were painted
   in `bg-red-50` / `bg-yellow-50` / `bg-blue-50` straight off the palette. */
const TONE_TILE: Record<RowTone, string> = {
  neutral: "bg-neutral-100 text-neutral-700",
  success: "bg-success/10 text-success-700",
  danger: "bg-danger/10 text-danger-700",
  warn: "bg-warn/10 text-warn-800",
  accent: "bg-accent/10 text-accent-700",
};

export interface StatusRowProps {
  icon: LucideIcon;
  tone: RowTone;
  /** The subject of the row — a voucher type, a channel name, a sync kind. */
  title: string;
  /** Secondary subject on the same line (party, company, endpoint). */
  subject?: ReactNode;
  /** When / how much — small, tabular, never the thing you read first. */
  meta?: ReactNode;
  /** Richer body under the meta line, for rows that carry figures. */
  detail?: ReactNode;
  /** The reason. Shown in full. */
  error?: string | null;
  action?: ReactNode;
  spinning?: boolean;
}

export function StatusRow({
  icon: Icon, tone, title, subject, meta, detail, error, action, spinning,
}: StatusRowProps) {
  return (
    <li className="rounded-xl bg-white ring-1 ring-black/[0.06] px-3 py-2.5">
      <div className="flex items-start gap-3">
        <span className={clsx("grid h-9 w-9 shrink-0 place-items-center rounded-lg", TONE_TILE[tone])}>
          <Icon size={16} className={spinning ? "animate-spin" : undefined} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-1.5">
                <span className="text-[13px] font-semibold text-neutral-900">{title}</span>
                {subject && <span className="truncate text-[12.5px] text-neutral-700">{subject}</span>}
              </div>
              {meta && <div className="text-[11px] tabular-nums text-neutral-500">{meta}</div>}
            </div>
            {action && <div className="shrink-0">{action}</div>}
          </div>
          {detail && <div className="mt-1 text-[11.5px] text-neutral-700">{detail}</div>}
          {error && (
            <p className="mt-1 break-words rounded bg-danger-soft px-2 py-1 text-[11px] text-danger-700">{error}</p>
          )}
        </div>
      </div>
    </li>
  );
}

/** The small uppercase heading that opens a group of rows inside a panel. */
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
        "mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide",
        tone === "danger" ? "text-danger-700" : tone === "warn" ? "text-warn-800" : "text-neutral-600",
      )}
    >
      {Icon && <Icon size={12} />}
      {children}
    </h3>
  );
}

/** The panel-is-empty state. Same box everywhere so "nothing here" never reads
 *  as "still loading". */
export function EmptyNote({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-xl bg-bg-sub px-4 py-8 text-center">
      <Icon size={20} className="text-neutral-300" />
      <span className="text-[13px] text-neutral-500">{children}</span>
    </div>
  );
}

export default StatusRow;
