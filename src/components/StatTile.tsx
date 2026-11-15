/* One figure about the pipeline: a label, the figure itself in the display face, and one line saying where it came from.
   A tile is either a white card (all is well) or a flat tinted strip (needs a person); it never glows and never has a gradient. */
import clsx from "clsx";
import type { ReactNode } from "react";

export interface StatTileProps {
  label: string;
  value: ReactNode;
  /** Semantic tone for the figure. */
  tone?: "danger" | "warn" | "success";
  /** Optional line under the figure. */
  sub?: string;
  /** "Needs attention": a flat tinted strip in the tone's own tint instead of a white card. */
  tint?: boolean;
  /** Optional leading icon next to the label. */
  icon?: ReactNode;
}

const TINT = { danger: "bg-danger-soft", warn: "bg-warn-soft", success: "bg-success-soft" } as const;
const INK = { danger: "text-danger-700", warn: "text-warn-700", success: "text-success-700" } as const;

export function StatTile({ label, value, tone, sub, tint, icon }: StatTileProps) {
  return (
    <div
      className={clsx(
        /* 20 px corner, 16 px in: the tile's own parts need no corner of their own. */
        "w-full rounded-lg p-4 text-left",
        tint && tone ? TINT[tone] : "bg-white shadow-card",
      )}
    >
      <div className="flex items-center gap-2 text-xs text-neutral-700">
        {icon && <span className="shrink-0 [&_svg]:h-4 [&_svg]:w-4">{icon}</span>}
        <span className="wrap-anywhere">{label}</span>
      </div>
      {/* The figure wraps rather than shrinks or crops: a number cut off mid-digit is a different number. */}
      <div className={clsx("mt-2 font-display text-2xl tabular-nums wrap-anywhere", tone ? INK[tone] : "text-neutral-950")}>
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-neutral-700 wrap-anywhere">{sub}</div>}
    </div>
  );
}

export default StatTile;
