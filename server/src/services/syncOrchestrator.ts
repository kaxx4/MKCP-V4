import type {
  SyncPlan, SyncProgress, SyncResult, MastersSyncResult, VouchersSyncResult
} from "../types.js";
import { tallyPostWithRetry } from "../tally.js";
import { buildCollectionXml, buildDayBookXml } from "./xmlBuilder.js";

import { getMonthlyChunks, getWeeklyChunks, getDailyChunks } from "../tally.js";
import {
  convertStockGroups, convertUnits, convertGodowns, convertCostCentres,
  convertStockItems, convertLedgers, convertVouchers
} from "../converters/convert.js";
import { PARALLEL_MASTERS, SEQUENTIAL_MASTERS, TRANSACTION_COLLECTIONS } from "../config/collections.js";
import type { ChangeDetector } from "./changeDetector.js";

export class SyncOrchestrator {
  constructor(
    private tallyUrl: string,
    private changeDetector: ChangeDetector
  ) {}

  // ── Fetch masters ─────────────────────────────────────────────────────────
  async syncMastersOnly(
    company: string,
    signal?: AbortSignal,
    onProgress?: (p: SyncProgress) => void
  ): Promise<MastersSyncResult> {
    const t0 = Date.now();
    const errors: string[] = [];

    const emit = (phase: string, step: number, total: number, detail: string) => {
      onProgress?.({ phase, step, totalSteps: total, detail, timestamp: Date.now() });
      console.log(`[MASTERS] Step ${step}/${total}: ${detail}`);
    };

    // Wave 1: 4 small/fast parallel requests — do NOT include P&L/BS here.
    // Sending P&L+BS alongside these 4 = 6 concurrent requests, which overwhelms
    // single-threaded TallyPrime and causes it to crash or time out.
    emit("masters", 1, 8, "Fetching parallel masters (groups, units, godowns, costCentres)...");

    const [groupsRes, unitsRes, godownsRes, costCentresRes] = await Promise.allSettled([
      (async () => { const xml = await tallyPostWithRetry(this.tallyUrl, buildCollectionXml(PARALLEL_MASTERS[0], company), PARALLEL_MASTERS[0].timeout, false, 1, signal); return convertStockGroups(xml); })(),
      (async () => { const xml = await tallyPostWithRetry(this.tallyUrl, buildCollectionXml(PARALLEL_MASTERS[1], company), PARALLEL_MASTERS[1].timeout, false, 1, signal); return convertUnits(xml); })(),
      (async () => { const xml = await tallyPostWithRetry(this.tallyUrl, buildCollectionXml(PARALLEL_MASTERS[2], company), PARALLEL_MASTERS[2].timeout, false, 1, signal); return convertGodowns(xml); })(),
      (async () => { const xml = await tallyPostWithRetry(this.tallyUrl, buildCollectionXml(PARALLEL_MASTERS[3], company), PARALLEL_MASTERS[3].timeout, false, 1, signal); return convertCostCentres(xml); })(),
    ]);

    const groups = groupsRes.status === "fulfilled" ? groupsRes.value : (() => { errors.push(`Stock groups: ${(groupsRes as PromiseRejectedResult).reason?.message}`); return { tallymessage: [] as any[] }; })();
    const units = unitsRes.status === "fulfilled" ? unitsRes.value : (() => { errors.push(`Units: ${(unitsRes as PromiseRejectedResult).reason?.message}`); return { tallymessage: [] as any[] }; })();
    const godowns = godownsRes.status === "fulfilled" ? godownsRes.value : (() => { errors.push(`Godowns: ${(godownsRes as PromiseRejectedResult).reason?.message}`); return { tallymessage: [] as any[] }; })();
    const costCentres = costCentresRes.status === "fulfilled" ? costCentresRes.value : (() => { errors.push(`Cost centres: ${(costCentresRes as PromiseRejectedResult).reason?.message}`); return { tallymessage: [] as any[] }; })();

    console.log(`[MASTERS] ✓ Parallel: ${groups.tallymessage.length} groups, ${units.tallymessage.length} units, ${godowns.tallymessage.length} godowns, ${costCentres.tallymessage.length} cost centres`);

    // Stock Items + Ledgers — fetch in parallel
    let stocks = { tallymessage: [] as any[] };
    let ledgers = { tallymessage: [] as any[] };
    if (!signal?.aborted) {
      // Dealer price lists removed from this wave — the PriceList collection query
      // crashes TallyPrime (ECONNRESET / 5-minute timeout) which then prevents all
      // subsequent voucher fetches. Stock items + ledgers only.
      emit("masters", 2, 8, "Fetching stock items + ledgers...");
      const stocksDef = SEQUENTIAL_MASTERS.find(d => d.tallyCollection === "StockItem")!;
      const ledgersDef = SEQUENTIAL_MASTERS.find(d => d.tallyCollection === "Ledger")!;

      const [stocksRes, ledgersRes] = await Promise.allSettled([
        (async () => {
          const xml = await tallyPostWithRetry(this.tallyUrl, buildCollectionXml(stocksDef, company), stocksDef.timeout, false, 1, signal);
          return convertStockItems(xml);
        })(),
        (async () => {
          const xml = await tallyPostWithRetry(this.tallyUrl, buildCollectionXml(ledgersDef, company), ledgersDef.timeout, false, 1, signal);
          return convertLedgers(xml);
        })(),
      ]);

      if (stocksRes.status === "fulfilled") {
        stocks = stocksRes.value;
        console.log(`[MASTERS] ✓ ${stocks.tallymessage.length} stock items`);
      } else if (!stocksRes.reason?.message?.includes("Aborted")) {
        errors.push(`Stock items: ${stocksRes.reason?.message}`);
      }
      if (ledgersRes.status === "fulfilled") {
        ledgers = ledgersRes.value;
        console.log(`[MASTERS] ✓ ${ledgers.tallymessage.length} ledgers`);
      } else if (!ledgersRes.reason?.message?.includes("Aborted")) {
        errors.push(`Ledgers: ${ledgersRes.reason?.message}`);
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[MASTERS] Done in ${elapsed}s`);

    return {
      success: stocks.tallymessage.length > 0 || ledgers.tallymessage.length > 0,
      errors: errors.length > 0 ? errors : undefined,
      data: {
        tallymessage: [
          { metadata: { type: "Company", name: company }, name: company, fystart: 4 },
          ...groups.tallymessage,
          ...units.tallymessage,
          ...stocks.tallymessage,
          ...ledgers.tallymessage,
          ...godowns.tallymessage,
          ...costCentres.tallymessage,
        ],
      },
      stats: {
        stockGroups: groups.tallymessage.length,
        units: units.tallymessage.length,
        stockItems: stocks.tallymessage.length,
        ledgers: ledgers.tallymessage.length,
        godowns: godowns.tallymessage.length,
        costCentres: costCentres.tallymessage.length,
        elapsedSeconds: parseFloat(elapsed),
      },
    };
  }

  // ── Fetch vouchers ────────────────────────────────────────────────────────
  async syncVouchersOnly(
    company: string,
    fromDate: string,
    toDate: string,
    strategy: "smart" | "monthly" | "weekly" | "daily" = "smart",
    signal?: AbortSignal,
    onProgress?: (p: SyncProgress) => void
  ): Promise<VouchersSyncResult> {
    const t0 = Date.now();

    // Build chunks based on strategy.
    // "smart" is treated as "monthly" — the smart count query sends a Voucher collection
    // to Tally which can trigger "incorrect object type" and crash TallyPrime.
    let chunks: { from: string; to: string; label: string; estimatedCount: number }[];
    if (strategy === "smart" || strategy === "monthly") {
      chunks = getMonthlyChunks(fromDate, toDate).map(c => ({ ...c, estimatedCount: -1 }));
    } else if (strategy === "daily") {
      chunks = getDailyChunks(fromDate, toDate).map(c => ({ ...c, estimatedCount: -1 }));
    } else if (strategy === "weekly") {
      chunks = getWeeklyChunks(fromDate, toDate).map(c => ({ ...c, estimatedCount: -1 }));
    } else {
      chunks = getMonthlyChunks(fromDate, toDate).map(c => ({ ...c, estimatedCount: -1 }));
    }

    console.log(`\n[DAYBOOK] Syncing vouchers for "${company}" (${fromDate} → ${toDate}) in ${chunks.length} ${strategy} chunks...`);

    const allVouchers: any[] = [];
    const seenGuids = new Set<string>();
    const chunkDetails: { label: string; count: number; ms: number }[] = [];
    const errors: string[] = [];
    let chunksSucceeded = 0;
    let chunksFailed = 0;

    const voucherTimeoutMs = TRANSACTION_COLLECTIONS[0].timeout;

    // Concurrency-limited parallel fetch — 3 chunks at a time.
    // Tally is single-threaded but can queue requests; 3 concurrent keeps throughput
    // high without overwhelming it. Results are merged in order after each wave.
    const CONCURRENCY = 3;

    const processChunk = async (chunk: typeof chunks[0], i: number): Promise<void> => {
      if (signal?.aborted) return;
      const chunkT0 = Date.now();

      onProgress?.({
        phase: "vouchers",
        step: i + 1,
        totalSteps: chunks.length,
        detail: `Vouchers batch ${i + 1}/${chunks.length}: ${chunk.label} (~${chunk.estimatedCount > 0 ? chunk.estimatedCount : "?"}${chunk.estimatedCount > 0 ? " vouchers" : ""})`,
        timestamp: Date.now(),
      });

      try {
        console.log(`[DAYBOOK] Chunk ${i + 1}/${chunks.length}: ${chunk.label} (${chunk.from} → ${chunk.to})...`);
        const vouchers = await this._fetchVoucherChunk(company, chunk.from, chunk.to, chunk.label, voucherTimeoutMs, signal);
        const added = this._collectVouchers(vouchers, chunk.label, allVouchers, seenGuids);
        const ms = Date.now() - chunkT0;
        chunkDetails.push({ label: chunk.label, count: added, ms });
        chunksSucceeded++;
        console.log(`[DAYBOOK] ✓ ${chunk.label}: ${added} vouchers (${ms}ms)`);
      } catch (e: any) {
        const isTimeout = e.message?.includes("timeout") || e.message?.includes("TIMEOUT");

        // Auto-fallback: timeout → weekly sub-chunks (sequential within the fallback)
        if (isTimeout && strategy !== "daily" && chunk.from !== chunk.to) {
          console.log(`[DAYBOOK] ⚡ ${chunk.label} timed out — auto-splitting into weekly sub-chunks...`);
          const subChunks = getWeeklyChunks(chunk.from, chunk.to);
          let subTotal = 0;
          for (const sub of subChunks) {
            if (signal?.aborted) break;
            try {
              const subVouchers = await this._fetchVoucherChunk(company, sub.from, sub.to, sub.label, voucherTimeoutMs, signal);
              subTotal += this._collectVouchers(subVouchers, sub.label, allVouchers, seenGuids);
            } catch (subErr: any) {
              errors.push(`${sub.label}: ${subErr.message}`);
            }
          }
          const ms = Date.now() - chunkT0;
          chunkDetails.push({ label: `${chunk.label} (weekly fallback)`, count: subTotal, ms });
          if (subTotal > 0) chunksSucceeded++; else chunksFailed++;
        } else {
          chunksFailed++;
          chunkDetails.push({ label: chunk.label, count: 0, ms: Date.now() - chunkT0 });
          errors.push(`${chunk.label}: ${e.message}`);
          console.error(`[DAYBOOK] ✗ ${chunk.label}: ${e.message}`);
        }
      }
    };

    // Process chunks in waves of CONCURRENCY
    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      if (signal?.aborted) { console.log("[DAYBOOK] Aborted — stopping"); break; }
      const wave = chunks.slice(i, i + CONCURRENCY);
      await Promise.all(wave.map((chunk, j) => processChunk(chunk, i + j)));
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[DAYBOOK] ✓ Total: ${allVouchers.length} vouchers in ${elapsed}s (${chunksSucceeded}/${chunks.length} chunks succeeded)`);

    return {
      success: allVouchers.length > 0,
      errors: errors.length > 0 ? errors : undefined,
      data: { tallymessage: allVouchers },
      stats: {
        vouchers: allVouchers.length,
        fromDate,
        toDate,
        chunksTotal: chunks.length,
        chunksSucceeded,
        chunksFailed,
        chunkDetails,
        elapsedSeconds: parseFloat(elapsed),
      },
    };
  }

  // ── Full sync ─────────────────────────────────────────────────────────────
  async syncAll(
    plan: SyncPlan,
    onProgress: (p: SyncProgress) => void
  ): Promise<SyncResult> {
    const t0 = Date.now();
    const { company, fromDate, toDate, mode, chunkStrategy, signal } = plan;

    console.log(`\n${"=".repeat(60)}`);
    console.log(`[SYNC] Company: "${company}"`);
    console.log(`[SYNC] Period: ${fromDate || "all"} → ${toDate || "all"} | Mode: ${mode} | Strategy: ${chunkStrategy}`);
    console.log(`${"=".repeat(60)}`);

    // AlterID check for incremental mode
    if (mode === "incremental") {
      onProgress({ phase: "check", step: 0, totalSteps: 1, detail: "Checking for changes (AlterID)...", timestamp: Date.now() });
      try {
        const current = await this.changeDetector.fetchCurrentAlterIds(this.tallyUrl, company, signal);
        const { mastersChanged, transactionsChanged } = this.changeDetector.hasDataChanged(current);
        if (!mastersChanged && !transactionsChanged) {
          console.log("[SYNC] No changes detected — skipping sync");
          onProgress({ phase: "done", step: 1, totalSteps: 1, detail: "No changes since last sync — skipped", timestamp: Date.now() });
          return {
            success: true,
            masters: { tallymessage: [] },
            transactions: { tallymessage: [] },
            stats: { stockGroups: 0, units: 0, stockItems: 0, ledgers: 0, godowns: 0, costCentres: 0, vouchers: 0, elapsedSeconds: 0 },
          };
        }
        this.changeDetector.updateSnapshot(current);
        console.log(`[SYNC] Changes detected — mastersChanged=${mastersChanged}, transactionsChanged=${transactionsChanged}`);
      } catch (e: any) {
        console.warn(`[SYNC] AlterID check failed (proceeding with full sync): ${e.message}`);
      }
    }

    // Masters
    let mastersResult: MastersSyncResult | null = null;
    if (mode !== "vouchers-only") {
      mastersResult = await this.syncMastersOnly(company, signal, onProgress);
    }

    // Vouchers
    let vouchersResult: VouchersSyncResult | null = null;
    if (mode !== "masters-only" && fromDate && toDate) {
      vouchersResult = await this.syncVouchersOnly(company, fromDate, toDate, chunkStrategy, signal, onProgress);
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const mStats = mastersResult?.stats;
    const vStats = vouchersResult?.stats;
    const allErrors = [...(mastersResult?.errors ?? []), ...(vouchersResult?.errors ?? [])];

    const stats = {
      stockGroups: mStats?.stockGroups ?? 0,
      units: mStats?.units ?? 0,
      stockItems: mStats?.stockItems ?? 0,
      ledgers: mStats?.ledgers ?? 0,
      godowns: mStats?.godowns ?? 0,
      costCentres: mStats?.costCentres ?? 0,
      vouchers: vStats?.vouchers ?? 0,
      elapsedSeconds: parseFloat(elapsed),
    };

    console.log(`[SYNC] Done in ${elapsed}s: ${stats.stockItems} items, ${stats.ledgers} ledgers, ${stats.vouchers} vouchers`);

    const hasData = stats.stockItems > 0 || stats.ledgers > 0 || stats.vouchers > 0;

    return {
      success: hasData,
      errors: allErrors.length > 0 ? allErrors : undefined,
      error: !hasData ? "Tally returned zero data. Verify company name and date range." : undefined,
      masters: mastersResult?.data ?? { tallymessage: [] },
      transactions: vouchersResult?.data ?? { tallymessage: [] },
      stats,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async _fetchVoucherChunk(
    company: string,
    from: string,
    to: string,
    label: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<ReturnType<typeof convertVouchers>> {
    // Day Book only — collection queries with FETCH/NATIVEMETHOD wildcard paths
    // (e.g., AllLedgerEntries.*) crash TallyPrime with "incorrect object type".
    // Day Book is the official Tally export format for transactions and is stable.
    const xml = await tallyPostWithRetry(this.tallyUrl, buildDayBookXml(company, from, to), timeoutMs, false, 1, signal);
    return convertVouchers(xml);
  }

  private _collectVouchers(
    vouchers: ReturnType<typeof convertVouchers>,
    label: string,
    allVouchers: any[],
    seenGuids: Set<string>
  ): number {
    let added = 0;
    for (const v of vouchers.tallymessage) {
      const guid = v.guid || v.GUID || "";
      if (guid && seenGuids.has(guid)) continue;
      if (guid) seenGuids.add(guid);
      allVouchers.push(v);
      added++;
    }
    const dupes = vouchers.tallymessage.length - added;
    if (dupes > 0) console.log(`[DAYBOOK]   Deduped: ${dupes} duplicate vouchers in ${label}`);
    return added;
  }
}
