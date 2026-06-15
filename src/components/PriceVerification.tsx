import { useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import clsx from "clsx";
import { fmtINR, fmtRate } from "../utils/format";

export const PRICE_TOLERANCE = 0.01;

export function priceMatches(rate: number, ref: number): boolean {
  if (ref <= 0) return true;
  const absDiff = Math.abs(rate - ref);
  if (absDiff <= 1) return true;
  return absDiff / ref <= PRICE_TOLERANCE;
}

/** Three-part rate pill: [billed rate | icon + price list rate] */
export function RatePill({ rate, refRate, isTotal = false }: { rate: number; refRate: number; isTotal?: boolean }) {
  const [open, setOpen] = useState(false);
  const hasRef = refRate > 0;
  const ok = priceMatches(rate, refRate);
  const diff = hasRef ? rate - refRate : 0;
  const pct = hasRef ? ((diff / refRate) * 100).toFixed(1) : "0";
  const sign = diff > 0 ? "+" : "";

  const label = !hasRef
    ? `Billed ${fmtRate(rate)} — no price list reference`
    : ok
      ? `Price verified — matches price list (${fmtRate(refRate)})`
      : `Price mismatch — billed ${fmtRate(rate)}, price list ${fmtRate(refRate)} (${sign}${pct}%)`;

  const textSize = isTotal ? "text-[13px]" : "text-[11px]";
  const padding = isTotal ? "px-2 py-1.5" : "px-1.5 py-1";
  const iconSize = isTotal ? 13 : 11;

  return (
    <span className={clsx("relative inline-flex items-stretch rounded overflow-hidden border border-neutral-200 tabular-nums leading-none whitespace-nowrap", textSize)}>
      <span className={clsx("bg-white text-neutral-700 font-medium", padding)}>{fmtRate(rate)}</span>
      <span className="w-px bg-neutral-200 flex-shrink-0" />
      <span
        title={label}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className={clsx(
          "flex items-center gap-0.5 cursor-pointer font-medium",
          padding,
          !hasRef ? "bg-neutral-50 text-neutral-400" :
          ok ? "bg-blue-50 text-blue-700" : "bg-amber-50 text-amber-700"
        )}
      >
        {!hasRef ? (
          <span className="text-neutral-400">—</span>
        ) : ok ? (
          <><CheckCircle2 size={iconSize} className="flex-shrink-0" />{fmtRate(refRate)}</>
        ) : (
          <><XCircle size={iconSize} className="flex-shrink-0" />{fmtRate(refRate)}</>
        )}
      </span>
      {open && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 w-max max-w-[230px] rounded-md bg-neutral-900 text-white text-[11px] leading-snug px-2.5 py-2 shadow-lg pointer-events-none whitespace-normal text-center">
          {label}
          <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-neutral-900" />
        </span>
      )}
    </span>
  );
}

/** Amount pill: [billed amount | icon + price list amount] */
export function AmountPill({ billedAmt, listAmt, isTotal = false }: { billedAmt: number; listAmt: number; isTotal?: boolean }) {
  const [open, setOpen] = useState(false);
  const hasRef = listAmt > 0;
  const ok = !hasRef || Math.abs(billedAmt - listAmt) / listAmt <= PRICE_TOLERANCE;
  const diff = hasRef ? billedAmt - listAmt : 0;
  const pct = hasRef ? ((diff / listAmt) * 100).toFixed(1) : "0";
  const sign = diff > 0 ? "+" : "";

  const label = !hasRef
    ? `Billed ${fmtINR(billedAmt)} — no price list reference`
    : ok
      ? `Amount verified — matches price list (${fmtINR(listAmt)})`
      : `Amount variance — billed ${fmtINR(billedAmt)}, price list ${fmtINR(listAmt)} (${sign}${pct}%)`;

  const textSize = isTotal ? "text-[13px]" : "text-[11px]";
  const padding = isTotal ? "px-3 py-1.5" : "px-2 py-1";
  const iconSize = isTotal ? 13 : 11;

  return (
    <span className={clsx("relative inline-flex items-stretch rounded overflow-hidden border border-neutral-200 tabular-nums leading-none whitespace-nowrap", textSize)}>
      <span className={clsx("bg-white text-neutral-700 font-medium", padding)}>{fmtINR(billedAmt)}</span>
      <span className="w-px bg-neutral-200 flex-shrink-0" />
      <span
        title={label}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className={clsx(
          "flex items-center gap-0.5 cursor-pointer font-medium",
          padding,
          !hasRef ? "bg-neutral-50 text-neutral-400" :
          ok ? "bg-blue-50 text-blue-700" : "bg-amber-50 text-amber-700"
        )}
      >
        {!hasRef ? (
          <span className="text-neutral-400">—</span>
        ) : ok ? (
          <><CheckCircle2 size={iconSize} className="flex-shrink-0" />{fmtINR(listAmt)}</>
        ) : (
          <><XCircle size={iconSize} className="flex-shrink-0" />{fmtINR(listAmt)}</>
        )}
      </span>
      {open && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 w-max max-w-[240px] rounded-md bg-neutral-900 text-white text-[11px] leading-snug px-2.5 py-2 shadow-lg pointer-events-none whitespace-normal text-center">
          {label}
          <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-neutral-900" />
        </span>
      )}
    </span>
  );
}
