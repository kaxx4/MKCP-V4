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

/**
 * Are two voucher numbers the same voucher number, for this type and year?
 * Review L2 (1-4): the same text, ignoring spaces at the ends and letter case;
 * or, where the type has a counter series, the same counter, so
 * "ERP-05/26-27" is counter 5 and padding or case can never slip past.
 * The database twin is `erp_same_voucher_number` (migration 0115); both run
 * the `sameNumber` cases in contracts/voucher-series.json.
 */
export function sameVoucherNumber(a: string | null | undefined, b: string | null | undefined, voucherType: string, fy: string): boolean {
  const x = String(a ?? "").trim().toUpperCase(), y = String(b ?? "").trim().toUpperCase();
  if (!x || !y) return false;
  if (x === y) return true;
  const d = seriesDefaultFor(voucherType);
  if (!d) return false;
  const t = d.template.toUpperCase();
  const cx = seriesCounter(x, t, fy), cy = seriesCounter(y, t, fy);
  return cx !== null && cx === cy;
}

/**
 * Types whose number is the SUPPLIER's, not ours (review H1, file 18 section
 * 2.1): one bill number may belong to many suppliers, so a number is "taken"
 * only for the same party in the same financial year. Live, 5-Nov-2026: 16
 * Purchase or Debit Note numbers repeat across 34 vouchers this year.
 */
const PARTY_KEYED = new Set(["purchase", "debit note"]);
export function isPartyKeyedType(voucherType: string): boolean {
  return PARTY_KEYED.has(String(voucherType ?? "").trim().toLowerCase());
}

/** One voucher Tally holds: its number, and for party-keyed types its party and date (YYYY-MM-DD). */
export interface TakenVoucher { number: string; party?: string | null; date?: string | null }

const partyKey = (s: string | null | undefined) => String(s ?? "").trim().replace(/\s+/g, " ").toUpperCase();

/**
 * Is this Create's number already used in Tally? Returns the number found, or
 * null when it is free or the type is not checked.
 * - A type the counter numbers (the series table): the same number in the
 *   payload's financial year, by `sameVoucherNumber`.
 * - Purchase and Debit Note: the same party, the same number (text, any case)
 *   and the same financial year. A row with no party or no date counts as a
 *   match: what cannot be told apart is treated as taken, never as free.
 * - Any other type: not checked here (it is not ours to number).
 */
export function numberTakenBy(
  p: { voucherType: string; voucherNumber?: string | null; partyLedgerName?: string | null; date?: string | null },
  taken: ReadonlyArray<string | TakenVoucher>,
): string | null {
  const number = String(p.voucherNumber ?? "").trim();
  if (!number) return null;
  const fy = financialYearOf(p.date && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : indiaDateOf());
  const rows = taken.map((t) => (typeof t === "string" ? { number: t } : t));
  if (isPartyKeyedType(p.voucherType)) {
    const party = partyKey(p.partyLedgerName);
    const hit = rows.find((t) => String(t.number ?? "").trim().toUpperCase() === number.toUpperCase()
      && (!t.party || !party || partyKey(t.party) === party)
      && (!t.date || !/^\d{4}-\d{2}-\d{2}$/.test(t.date) || financialYearOf(t.date) === fy));
    return hit ? hit.number : null;
  }
  if (!seriesDefaultFor(p.voucherType)) return null;
  return rows.find((t) => sameVoucherNumber(t.number, number, p.voucherType, fy))?.number ?? null;
}
