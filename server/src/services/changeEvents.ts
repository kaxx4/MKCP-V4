/**
 * JOB: the "which documents changed in Tally" list (owner H-2, 18-Nov-2026), written by the office computer as it saves the mirror,
 * into erp_tally_change_events (web migration 0340). Pure: the reads and the insert live in SupabaseSync.
 *
 * Why here and not a database trigger: a trigger on tally_vouchers was tried on 19-Nov-2026 and removed the same night, because the
 * rebuild's additive rule forbids a trigger on a table the live site uses.
 *
 * new     = a pulled voucher the mirror did not hold just before the save.
 * edited  = held, and Tally's AlterID moved (both are numbers and they differ). A blank AlterID on either side is not called an edit.
 * deleted = a voucher the per-day prune removed (see SupabaseSync: only when the prune removed exactly the vouchers it was expected to).
 * Nothing is listed when the "before" read could not be made (prior null): "could not tell" is never "new".
 * The total is Tally's own figure on the party line, unsigned; a voucher with no party line uses its largest line.
 */

export const EVENT_CEILING = 300;

export interface ChangeEventRow {
  company: string;
  op: "new" | "edited" | "deleted";
  guid: string;
  voucher_type: string | null;
  voucher_number: string | null;
  voucher_date: string | null;
  party: string | null;
  total_before: number | null;
  total_after: number | null;
  alter_before: number | null;
  alter_after: number | null;
}

const AMOUNT = /^-?\d+(\.\d+)?$/;

/** Unsigned total of a voucher from its stored ledger lines. Null when no line carries a readable amount. */
export function voucherTotal(entries: unknown): number | null {
  if (!Array.isArray(entries)) return null;
  const amt = (e: any): number | null => {
    const s = String(e?.amount ?? "").trim();
    return AMOUNT.test(s) ? Math.abs(Number(s)) : null;
  };
  const isParty = (e: any) => e?.ispartyledger === true || e?.ispartyledger === "Yes" || e?.ispartyledger === "true";
  for (const e of entries) if (isParty(e)) { const a = amt(e); if (a !== null) return a; }
  let max: number | null = null;
  for (const e of entries) { const a = amt(e); if (a !== null && (max === null || a > max)) max = a; }
  return max;
}

const str = (v: unknown): string | null => { const s = String(v ?? "").trim(); return s ? s : null; };
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface PriorVoucher { alterId: number | null; total: number | null }

/** New and edited events for vouchers just saved. `prior` null = the before-read failed: nothing is listed. */
export function newAndEdited(company: string, saved: ReadonlyArray<any>, prior: ReadonlyMap<string, PriorVoucher> | null): ChangeEventRow[] {
  if (!prior) return [];
  const out: ChangeEventRow[] = [];
  for (const v of saved) {
    const guid = str(v?.guid);
    if (!guid) continue;
    const after = num(v?.alter_id);
    const base = {
      company, guid, voucher_type: str(v?.voucher_type), voucher_number: str(v?.voucher_number), voucher_date: str(v?.date),
      party: str(v?.party_ledger_name),
    };
    const p = prior.get(guid);
    if (!p) {
      out.push({ ...base, op: "new", total_before: null, total_after: voucherTotal(v?.ledger_entries), alter_before: null, alter_after: after });
    } else if (p.alterId !== null && after !== null && p.alterId !== after) {
      out.push({ ...base, op: "edited", total_before: p.total, total_after: voucherTotal(v?.ledger_entries), alter_before: p.alterId, alter_after: after });
    }
    if (out.length >= EVENT_CEILING) break;
  }
  return out;
}

/** Deleted events for mirror rows the prune removed. */
export function deletedEvents(company: string, removed: ReadonlyArray<any>): ChangeEventRow[] {
  return removed.slice(0, EVENT_CEILING).filter((r) => str(r?.guid)).map((r) => ({
    company, op: "deleted" as const, guid: String(r.guid), voucher_type: str(r.voucher_type), voucher_number: str(r.voucher_number),
    voucher_date: str(r.date), party: str(r.party_ledger_name), total_before: voucherTotal(r.ledger_entries), total_after: null,
    alter_before: num(r.alter_id), alter_after: null,
  }));
}
