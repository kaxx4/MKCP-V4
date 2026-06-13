// src/services/deliveryNoteRefresh.ts
//
// Re-pulls Delivery Note vouchers from Tally for a rolling 90-day window and
// replaces the stored in-window DN set, so fulfilled/cancelled delivery notes
// that no longer exist in Tally drop off the Pending Orders page.
//
// Why a *replace* (not a merge): dataStore.mergeData overwrites duplicates by
// voucherId but never REMOVES vouchers that vanished from Tally. A delivery note
// that was fulfilled (converted to an invoice) or cancelled would otherwise linger
// forever. replaceDeliveryNotesInRange drops every in-window DN first, then re-adds
// only what Tally currently returns.
//
// Shared by the NavBar "Sync Today" button and the hourly useDeliveryNoteAutoSync hook.

import { syncDayBook } from "../api/tallyApi";
import { parseTransactions } from "../parser/transactionParser";
import { useDataStore } from "../store/dataStore";
import { saveData } from "../db/idb";
import { serializeParsedData } from "../utils/serialize";

/** Rolling window for "refresh all delivery notes" (days). */
export const DN_REFRESH_WINDOW_DAYS = 90;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** YYYYMMDD (Tally day-book format) for a Date. */
function yyyymmdd(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** YYYY-MM-DD (canonical ISO date) for a Date. */
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface DeliveryNoteRefreshResult {
  /** Delivery notes returned by Tally for the window. */
  dnCount: number;
  /** Total vouchers (all types) returned for the window. */
  total: number;
  fromISO: string;
  toISO: string;
}

/**
 * Refresh delivery notes for the last {@link DN_REFRESH_WINDOW_DAYS} days.
 * Returns the refreshed DN count. Throws on network/Tally failure so callers can
 * decide whether to surface it (the Sync button toasts; the background hook stays silent).
 */
export async function refreshDeliveryNotes(company: string): Promise<DeliveryNoteRefreshResult> {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - DN_REFRESH_WINDOW_DAYS);

  const fromYmd = yyyymmdd(from);
  const toYmd = yyyymmdd(today);
  const fromISO = isoDate(from);
  const toISO = isoDate(today);

  const result = await syncDayBook(company, fromYmd, toYmd, "smart");
  const messages = result.data?.tallymessage ?? [];

  if (!messages.length) {
    // Nothing came back. Still replace the window so any locally-stale DNs in it
    // are cleared (Tally genuinely has none for this period).
    useDataStore.getState().replaceDeliveryNotesInRange([], fromISO, toISO);
    await persist();
    return { dnCount: 0, total: 0, fromISO, toISO };
  }

  const parsed = parseTransactions(result.data);
  const dnCount = parsed.vouchers.filter((v) => v.voucherType === "Delivery Note").length;

  useDataStore.getState().replaceDeliveryNotesInRange(parsed.vouchers, fromISO, toISO);
  await persist();

  return { dnCount, total: parsed.vouchers.length, fromISO, toISO };
}

/** Persist the current merged store data back to IndexedDB.
 *  Persist rawData (the override-free source of truth) — setData re-applies overrides
 *  on the next load, so persisting the override-applied `data` would double-apply them. */
async function persist(): Promise<void> {
  const merged = useDataStore.getState().rawData;
  if (merged) {
    await saveData("parsedData", serializeParsedData(merged));
  }
}
