/**
 * "Has anything changed in Tally since last time?"
 *
 * ── Why this was rewritten ────────────────────────────────────────────────
 * The previous implementation asked the Company collection for `AltMstId` and
 * `AltVchId`. Those are not valid methods on this build: Tally answers with a
 * `<CMPINFO>` count block containing no COMPANY objects at all, so both ids
 * parsed as 0 — **every time**. `hasDataChanged` therefore always compared 0
 * against 0 and the incremental path in syncOrchestrator could never fire. It
 * looked correct, logged plausibly, and did nothing.
 *
 * ── What replaces it ──────────────────────────────────────────────────────
 * Every voucher and master carries `AlterID`, a monotonic change counter. Asking
 * for the ones **above a known cursor** is both the change signal and the list of
 * what to re-read, in a single request.
 *
 * Measured against the live company:
 *
 *   vouchers, nothing changed ....  1 KB,  4.0 s
 *   vouchers, 10 changed .........  13 KB, 3.9 s
 *   ledgers,  nothing changed ....  1 KB,  98 ms
 *
 * The payload is negligible either way; the cost is Tally's CPU, and the port is
 * single-threaded. So masters can be polled often and vouchers should not be —
 * a 4-second scan every 30 seconds is about 13% of the port's time, which is the
 * upper end of reasonable while someone is working in Tally.
 */
import { tallyPost } from "../tally.js";
import type { AlterIdSnapshot } from "../types.js";

const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Comparison operators must be XML-ESCAPED. A raw `>` makes Tally return zero
 * rows in 2ms with no error — which reads exactly like "nothing changed" and
 * would quietly disable change detection all over again.
 */
function alterIdXml(company: string, type: string, since: number, extraFields: string[] = []): string {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkChanged</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${escXml(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkChanged" ISMODIFY="No"><TYPE>${type}</TYPE>
<NATIVEMETHOD>AlterID</NATIVEMETHOD>${extraFields.map(f => `<NATIVEMETHOD>${f}</NATIVEMETHOD>`).join("")}
<FILTER>MkChangedF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MkChangedF">$AlterID &gt; ${since}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

export interface ChangedSet {
  /** Highest AlterID seen. Becomes the next cursor. */
  maxAlterId: number;
  /** How many objects changed above the cursor. */
  count: number;
  /** Voucher numbers that changed, when asked for. Empty for masters. */
  voucherNumbers: string[];
}

async function changedSince(
  tallyUrl: string, company: string, type: string, since: number,
  withNumbers: boolean, signal?: AbortSignal,
): Promise<ChangedSet> {
  const raw = await tallyPost(
    tallyUrl,
    alterIdXml(company, type, since, withNumbers ? ["VoucherNumber", "Date"] : []),
    60_000, true, signal,
  ) as string;

  const ids = [...raw.matchAll(/<ALTERID[^>]*>\s*(\d+)\s*<\/ALTERID>/g)].map(m => parseInt(m[1], 10));
  const voucherNumbers = withNumbers
    ? [...raw.matchAll(/<VOUCHERNUMBER[^>]*>([^<]*)<\/VOUCHERNUMBER>/g)].map(m => m[1].trim()).filter(Boolean)
    : [];

  return {
    maxAlterId: ids.length ? Math.max(...ids) : since,
    count: ids.length,
    voucherNumbers,
  };
}

export class ChangeDetector {
  private lastAlterIds: AlterIdSnapshot | null = null;

  /**
   * The current high-water marks, by asking what sits above zero.
   *
   * Only used to establish a baseline — it is the expensive call (a full sweep,
   * ~4s for vouchers). Steady-state polling uses `changedSince` with a real
   * cursor, where the payload collapses to a kilobyte.
   */
  async fetchCurrentAlterIds(
    tallyUrl: string,
    company: string,
    signal?: AbortSignal,
  ): Promise<AlterIdSnapshot> {
    const [vouchers, ledgers, items] = await Promise.all([
      changedSince(tallyUrl, company, "Voucher", 0, false, signal),
      changedSince(tallyUrl, company, "Ledger", 0, false, signal),
      changedSince(tallyUrl, company, "StockItem", 0, false, signal),
    ]);

    // Masters share one counter space; take the highest of the two master kinds.
    const snapshot: AlterIdSnapshot = {
      masterId: Math.max(ledgers.maxAlterId, items.maxAlterId),
      transactionId: vouchers.maxAlterId,
      fetchedAt: new Date().toISOString(),
    };

    console.log(`[ChangeDetector] AlterIDs — masters ${snapshot.masterId} (${ledgers.count} ledgers, ${items.count} items), vouchers ${snapshot.transactionId} (${vouchers.count})`);
    if (!snapshot.masterId && !snapshot.transactionId) {
      console.warn("[ChangeDetector] both counters are zero — change detection is not working, and every sync will behave as if nothing ever changes.");
    }
    return snapshot;
  }

  /**
   * What changed since the cursor, cheaply.
   *
   * Masters are ~40× cheaper to ask than vouchers (98ms against 4s), so a caller
   * that wants to poll often should poll masters often and vouchers rarely.
   */
  async whatChanged(
    tallyUrl: string, company: string, since: AlterIdSnapshot, signal?: AbortSignal,
  ): Promise<{ vouchers: ChangedSet; ledgers: ChangedSet; items: ChangedSet }> {
    const [vouchers, ledgers, items] = await Promise.all([
      changedSince(tallyUrl, company, "Voucher", since.transactionId, true, signal),
      changedSince(tallyUrl, company, "Ledger", since.masterId, false, signal),
      changedSince(tallyUrl, company, "StockItem", since.masterId, false, signal),
    ]);
    return { vouchers, ledgers, items };
  }

  /** Masters only — the cheap poll, safe to run every few seconds. */
  async mastersChangedSince(
    tallyUrl: string, company: string, since: AlterIdSnapshot, signal?: AbortSignal,
  ): Promise<boolean> {
    const [ledgers, items] = await Promise.all([
      changedSince(tallyUrl, company, "Ledger", since.masterId, false, signal),
      changedSince(tallyUrl, company, "StockItem", since.masterId, false, signal),
    ]);
    return ledgers.count > 0 || items.count > 0;
  }

  hasDataChanged(current: AlterIdSnapshot): { mastersChanged: boolean; transactionsChanged: boolean } {
    if (!this.lastAlterIds) return { mastersChanged: true, transactionsChanged: true };
    return {
      mastersChanged: current.masterId > this.lastAlterIds.masterId,
      transactionsChanged: current.transactionId > this.lastAlterIds.transactionId,
    };
  }

  updateSnapshot(snapshot: AlterIdSnapshot): void {
    this.lastAlterIds = snapshot;
  }

  getSnapshot(): AlterIdSnapshot | null {
    return this.lastAlterIds;
  }
}
