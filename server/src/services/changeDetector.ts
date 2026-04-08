import type { AlterIdSnapshot } from "../types.js";
import { buildAlterIdXml } from "./xmlBuilder.js";
import { tallyPost } from "../tally.js";

export class ChangeDetector {
  private lastAlterIds: AlterIdSnapshot | null = null;

  /** Fetch current AltMstId and AltVchId from Tally */
  async fetchCurrentAlterIds(
    tallyUrl: string,
    company: string,
    signal?: AbortSignal
  ): Promise<AlterIdSnapshot> {
    const xml = buildAlterIdXml(company);
    const parsed = await tallyPost(tallyUrl, xml, 15_000, false, signal);

    // Navigate to company collection result
    const root =
      parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION ??
      parsed?.ENVELOPE?.BODY?.DATA?.TALLYMESSAGE ??
      parsed?.ENVELOPE?.BODY?.DATA ??
      null;

    let masterId = 0;
    let transactionId = 0;

    if (root) {
      const companies = Array.isArray(root.COMPANY)
        ? root.COMPANY
        : root.COMPANY
        ? [root.COMPANY]
        : [];

      if (companies.length > 0) {
        const co = companies[0];
        masterId = parseInt(co.ALTMSTID ?? co["@_ALTMSTID"] ?? "0", 10) || 0;
        transactionId = parseInt(co.ALTVCHID ?? co["@_ALTVCHID"] ?? "0", 10) || 0;
      }
    }

    console.log(`[ChangeDetector] AlterIDs — Master: ${masterId}, Transaction: ${transactionId}`);

    return {
      masterId,
      transactionId,
      fetchedAt: new Date().toISOString(),
    };
  }

  /** Compare current snapshot against last known snapshot */
  hasDataChanged(current: AlterIdSnapshot): {
    mastersChanged: boolean;
    transactionsChanged: boolean;
  } {
    if (!this.lastAlterIds) {
      return { mastersChanged: true, transactionsChanged: true };
    }
    return {
      mastersChanged: current.masterId !== this.lastAlterIds.masterId,
      transactionsChanged: current.transactionId !== this.lastAlterIds.transactionId,
    };
  }

  updateSnapshot(snapshot: AlterIdSnapshot): void {
    this.lastAlterIds = snapshot;
  }

  getLastSnapshot(): AlterIdSnapshot | null {
    return this.lastAlterIds;
  }
}
