/* Copied VERBATIM from the web dashboard (MKCP MOB2). Same reasoning as
   PageHeader: a figure should look the same in the agent's window as it does
   in the browser, because it is the same figure about the same books. */
import clsx from "clsx";
import type { ReactNode } from "react";

export interface StatTileProps {
  label: string;
  value: ReactNode;
  /** Render the value in the accent colour. */
  accent?: boolean;
  /** Semantic tone for the value colour. */
  tone?: "danger" | "warn" | "success";
  /** Optional sub-label under the value. */
  sub?: string;
  /**
   * "Needs attention" strip treatment — a flat tinted background matching the
   * tile's tone/accent (bg-danger-soft, bg-accent-soft, etc.) instead of a
   * white ring+shadow card. Opt-in only: existing default-variant consumers
   * are pixel-identical to before, this is additive.
   */
  tint?: boolean;
  /** Optional leading icon (e.g. a lucide-react icon element), rendered next to the label. */
  icon?: ReactNode;
  /**
   * Optional trailing delta/change indicator rendered next to the value
   * (e.g. "+12%" in success/danger tone). Caller controls its own colour.
   */
  delta?: ReactNode;
  /** Makes the whole tile a button — for KPI cards that navigate/filter on click. */
  onClick?: () => void;
  /**
   * Page-level KPI strip treatment: the figure becomes the hero of the tile
   * rather than a slightly-bold line of text. Opt-in, and set by `StatStrip`
   * only — every existing inline consumer stays pixel-identical.
   */
  emphasis?: boolean;
}

/**
 * Canonical compact KPI tile.
 *
 * Extracted VERBATIM from the byte-identical local `Kpi` components that were
 * copy-pasted across pages (DeadStock, Vendors, …). Output is intentionally
 * pixel-identical to those copies — this is a de-duplication, not a restyle.
 * Values render in the app's numeric signature face (IBM Plex Mono) since
 * every standalone KPI number does, per the "Refined Minimal" direction.
 */
export function StatTile({ label, value, accent, tone, sub, tint, icon, delta, onClick, emphasis }: StatTileProps) {
  const toneTintBg =
    tone === "danger" ? "bg-danger-soft"
    : tone === "warn" ? "bg-warn-soft"
    : tone === "success" ? "bg-success-soft"
    : accent ? "bg-accent-soft"
    : "bg-bg-sub";

  const Comp = onClick ? "button" : "div";

  return (
    <Comp
      onClick={onClick}
      className={clsx(
        /* A size query container, so the figure below can be sized from the
           tile's own width rather than from a breakpoint that knows nothing
           about how many tiles share the row. */
        "rounded-xl text-left w-full [container-type:inline-size]",
        // p-4 floor for a page-level card; the compact inline variant keeps its
        // original tighter box.
        emphasis ? "p-4" : "px-3 py-2.5",
        tint ? toneTintBg : "bg-white ring-1 ring-black/[0.06] shadow-sm",
        onClick && "transition-transform active:scale-[0.96] hover:ring-black/[0.12]"
      )}
    >
      <div className="flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide text-neutral-700">
        {icon && <span className="shrink-0 [&_svg]:h-3.5 [&_svg]:w-3.5">{icon}</span>}
        <span className="truncate">{label}</span>
      </div>
      <div className={clsx("flex items-baseline gap-1.5", emphasis ? "mt-2" : "mt-0.5")}>
        <div
          className={clsx(
            /* NEVER `truncate` on a figure.
               `₹11,86,91,923` needed 178px in a 143px tile and rendered as
               `₹11,86,91,9…` — a number cropped mid-digit is not an abbreviated
               number, it is a different and wrong one, and this is the largest
               type on the page. Nine of these read as crores on the invoices
               screen every morning.

               So it stays on one line and the TYPE shrinks to fit instead: the
               tile is a size container above, and `cqw` sizes the figure from
               the tile's own width, which is the thing that actually varies.
               The Tailwind sizes stay ahead of it as the fallback for a browser
               without container queries — cropping is the one outcome ruled
               out, not a particular font size. */
            "font-mono font-black tabular-nums whitespace-nowrap",
            emphasis
              ? "stat-figure text-2xl lg:text-[28px] leading-none [font-size:clamp(15px,11cqw,28px)]"
              : "text-[17px] [font-size:clamp(12px,8cqw,17px)]",
            tone === "danger"
              ? "text-danger-600"
              : tone === "warn"
              ? "text-warn-700"
              : tone === "success"
              ? "text-success-600"
              : accent
              ? "text-accent"
              : "text-neutral-900"
          )}
        >
          {value}
        </div>
        {delta && <div className="text-[11px] font-semibold shrink-0">{delta}</div>}
      </div>
      {sub && <div className="text-[10.5px] text-neutral-700 truncate mt-0.5">{sub}</div>}
    </Comp>
  );
}

export default StatTile;
