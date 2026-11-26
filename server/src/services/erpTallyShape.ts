/**
 * JOB: the tally-shaped voucher a mirror row carries for the go-live swap (D-1-5.58, option C).
 *
 * Main's app reads tally_vouchers, tally_voucher_ledger_entries and tally_voucher_inventory_entries. At
 * go-live the app may read the erp_tally_* views instead, and those give back exactly the columns of those
 * tables. The columns come from this file: it takes one voucher as the ERP mirror read it and returns the row
 * of each of the three tables, built by the SAME mappers today's sync uses (`mapVoucher` and `voucherChildRows`
 * in supabaseSync.ts), so there is one definition of what a tally_* column holds and the two cannot drift.
 *
 * The result rides inside the mirror row (`row.tally`), so the mirror's own guards apply to it unchanged:
 * the floor, the per-day checks, the prune. The database copies it out with `erp_tally_derive` (migration 0129).
 *
 * Never here: a write, a Tally read, a decision. Pure.
 *
 * What is NOT filled and why (parity will show it until it is decided):
 *  - `remote_id` is null: Tally does not export it, today's column is backfilled from the push queue.
 *  - `version` is 0, the column's default.
 *
 * Test runs (the dummy company is an old copy of the real books): every name is a keyed stand-in, and every
 * free-text, tax-identity, e-invoice, e-way, buyer and consignee field is null, because the database refuses a
 * test row that carries one (`erp_tally_derive`, "not a ZZ TEST stand-in"). Amounts, dates, types, numbers and
 * flags are kept, so the dummy still proves the shape and the figures.
 */
import { SupabaseSync, voucherChildRows } from "./supabaseSync.js";

export interface TallyBlob {
  voucher: Record<string, unknown>;
  ledger_entries: Record<string, unknown>[];
  inventory_entries: Record<string, unknown>[];
}

export interface TallyShapeOpts {
  /** The company key the rows are stored under (the `company` column). */
  company: string;
  /** A keyed stand-in for a name on a test run; the real name otherwise. Null for an empty name. */
  name: (kind: string, s: string) => string | null;
  test: boolean;
}

/** Columns that hold a person's or a registration's details: null on every test row. */
export const PERSONAL_VOUCHER_COLUMNS = [
  "reference", "irn", "irn_ack_no", "irn_ack_date", "irn_qr", "ewb_number", "ewb_valid_until", "vehicle_number",
  "consignee_pincode", "consignee_place", "consignee_state", "ship_to_place", "dispatch_from_place", "party_gstin",
  "buyer_name", "buyer_address", "buyer_pincode", "buyer_pincode_source", "buyer_place", "buyer_state",
  "ewb_details", "einv_details", "ledger_entries",
  /* The distance is worked out from the two addresses, and the embedded inventory copy repeats the stock lines: neither may ride a test row (migration 0138 refuses them). */
  "transport_distance_km", "inventory_entries",
] as const;

/** The tally_vouchers columns, in the live table's order (checked against information_schema, 6-Nov-2026). */
export const TALLY_VOUCHER_COLUMNS = [
  "guid", "company", "date", "effective_date", "voucher_number", "voucher_type", "party_ledger_name", "narration", "is_cancelled",
  "is_optional", "ledger_entries", "inventory_entries", "synced_at", "reference", "ewb_number", "ewb_valid_until", "vehicle_number",
  "transport_mode", "transport_distance_km", "consignee_pincode", "consignee_place", "consignee_state", "ship_to_place",
  "dispatch_from_place", "party_gstin", "place_of_supply", "master_id", "alter_id", "remote_id", "version", "irn", "irn_ack_no",
  "irn_ack_date", "buyer_name", "buyer_address", "buyer_pincode", "buyer_pincode_source", "buyer_place", "buyer_state", "ewb_details", "irn_qr",
  "einv_details",
] as const;
export const TALLY_LEDGER_ENTRY_COLUMNS = ["id", "voucher_guid", "company", "ledger_name", "is_debit", "is_party_ledger", "amount", "bill_allocations", "synced_at"] as const;
export const TALLY_INVENTORY_ENTRY_COLUMNS = [
  "id", "voucher_guid", "company", "stock_item_name", "actual_qty", "billed_qty", "rate", "amount", "is_deemed_positive", "synced_at",
  "godown_name", "batch_name", "destination_godown_name", "batch_allocations", "is_split_across_godowns",
] as const;

/** The mappers hold no state, so the class is not constructed (no client, no credentials needed). */
const mapper = (): { mapVoucher: (m: any, company: string) => any } => Object.create(SupabaseSync.prototype) as any;

/**
 * One converted voucher (convertVouchers output, with the transport and buyer blocks it attaches) to the
 * three tally_* rows. Null when it has no GUID. Volatile columns (`synced_at`, `id`) are left out: the database
 * stamps the first and makes the second.
 */
export function tallyBlobFrom(v: any, o: TallyShapeOpts): TallyBlob | null {
  if (!String(v?.guid ?? "").trim()) return null;
  const mapped = mapper().mapVoucher(v, o.company);
  if (!mapped) return null;
  const kids = voucherChildRows(mapped, o.company);
  const { synced_at: _s, ...voucher } = mapped as Record<string, unknown>;
  const row: Record<string, unknown> = { ...voucher, remote_id: null, version: 0 };
  let ledger = kids.ledger.map(({ synced_at: _a, ...r }: Record<string, unknown>) => ({ ...r }));
  const inventory = kids.inventory.map(({ synced_at: _b, ...r }: Record<string, unknown>) => ({ ...r }));
  if (o.test) {
    for (const c of PERSONAL_VOUCHER_COLUMNS) row[c] = null;
    row.party_ledger_name = o.name("PARTY", String(mapped.party_ledger_name ?? ""));
    const narration = String(mapped.narration ?? "");
    row.narration = /ZZ ?TEST/i.test(narration) ? narration : null;
    ledger = ledger.map((r) => ({ ...r, ledger_name: o.name("LEDGER", String(r.ledger_name ?? "")), bill_allocations: null }));
  }
  return { voucher: row, ledger_entries: ledger, inventory_entries: inventory };
}
