/**
 * The one voucher-number rule (task 1-4), the sync agent's copy.
 *
 * The number itself is taken on the server, by `erp_take_voucher_number`
 * (web repo, migration 0113), inside the transaction that makes the job. This
 * is the same rule in TypeScript for the guard here and the audit (task 1-5).
 * It mirrors the web app's `engine/push/voucherSeries.ts`, and both, with the
 * database, run `contracts/voucher-series.json` (a byte copy of the web
 * repo's file), so the three cannot drift apart.
 *
 * A template uses `{N}` for the counter and `{FY}` for the year as `26-27`.
 * Sales continues Tally's own `{FY}/{N}` series; Payment, Receipt, Contra,
 * Journal and Stock Journal pushed by the ERP use `ERP-{N}/{FY}` (D-1-4.2).
 */
import { financialYearOf } from "./remoteId.js";

export type SeedSource = "tally_highest" | "erp_own";

export interface SeriesDefault {
  template: string;
  width: number;
  seedSource: SeedSource;
}

/** The same table as `erp_series_default` in 0113. Keys are lower-case voucher types. */
export const SERIES_DEFAULTS: Readonly<Record<string, SeriesDefault>> = {
  sales: { template: "{FY}/{N}", width: 4, seedSource: "tally_highest" },
  payment: { template: "ERP-{N}/{FY}", width: 1, seedSource: "erp_own" },
  receipt: { template: "ERP-{N}/{FY}", width: 1, seedSource: "erp_own" },
  contra: { template: "ERP-{N}/{FY}", width: 1, seedSource: "erp_own" },
  journal: { template: "ERP-{N}/{FY}", width: 1, seedSource: "erp_own" },
  "stock journal": { template: "ERP-{N}/{FY}", width: 1, seedSource: "erp_own" },
};

export function seriesDefaultFor(voucherType: string): SeriesDefault | null {
  return SERIES_DEFAULTS[String(voucherType ?? "").trim().toLowerCase()] ?? null;
}

/** "2026-27" to "26-27". */
export function fyShort(fy: string): string {
  return `${fy.slice(2, 4)}-${fy.slice(5, 7)}`;
}

export function formatSeriesNumber(template: string, fy: string, n: number, width: number): string {
  const digits = String(n);
  // Every occurrence, as SQL's replace() does.
  return template.split("{FY}").join(fyShort(fy)).split("{N}").join(digits.padStart(Math.max(width || 1, digits.length), "0"));
}

const escapeRe = (s: string) => s.replace(/[\][\\.+*?^$(){}|/-]/g, "\\$&");

/** The counter inside a number of this series and year, or null when it is not in the series. */
export function seriesCounter(number: string | null | undefined, template: string, fy: string): number | null {
  if (number == null || !template.includes("{N}")) return null;
  const at = template.indexOf("{N}");
  const part = (s: string) => escapeRe(s).split(escapeRe("{FY}")).join(escapeRe(fyShort(fy)));
  const m = new RegExp(`^${part(template.slice(0, at))}([0-9]{1,9})${part(template.slice(at + 3))}$`).exec(String(number).trim());
  return m ? Number(m[1]) : null;
}

/** India's date for an instant, as YYYY-MM-DD (+05:30 all year). */
export function indiaDateOf(at: Date | string | number = new Date()): string {
  const ms = new Date(at).getTime();
  return new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
}

/**
 * Is this number one the ERP's own prefixed series issues (`ERP-<n>/<yy-yy>`)
 * for its type, in the financial year of `date`? Sales is not prefixed: it
 * shares Tally's series, so a Sales number is never "ours" by its shape.
 */
export function isErpSeriesNumber(number: string, voucherType: string, date?: string): boolean {
  const d = seriesDefaultFor(voucherType);
  if (!d || d.seedSource !== "erp_own") return false;
  const fy = financialYearOf(date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : indiaDateOf());
  return seriesCounter(number, d.template, fy) !== null;
}
