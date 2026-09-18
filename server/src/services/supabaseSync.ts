import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { recordPricePull } from "./priceChangeLog.js";
import ws from "ws";
import { supabaseClient } from "./supabaseClient.js";
import {
  emitMirrorChanges,
  selectMovedChanges,
  describeSelection,
  SIGNAL_CEILING,
  type PriorVersions,
} from "./mirrorSignal.js";

// Polyfill WebSocket for Node.js 20 (Supabase needs it for realtime)
if (typeof globalThis !== 'undefined' && !globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

/**
 * Normalize Tally XML→JSON entry arrays.
 *
 * Tally's XML→JSON conversion is inconsistent across voucher types:
 *   • Old format / multiple rows: m.allinventoryentries is the array directly
 *   • New format / nested:        m.allinventoryentries.inventoryentries is the array
 *   • Single row (nested):        m.allinventoryentries.inventoryentries is a single object
 *   • Single row (flat):          m.allinventoryentries itself is a single object
 *   • Empty:                       null / undefined
 *
 * This normalizer returns a consistent array so downstream `Array.isArray(...)`
 * checks always succeed and entries actually get pushed to the denormalized
 * tally_voucher_inventory_entries / tally_voucher_ledger_entries tables.
 *
 * NOTE: this lives in the Supabase sync layer — it does NOT modify how Tally
 * XML is parsed, fetched, or imported. The Tally import path is untouched.
 */
/**
 * The one row shape both price-list writers put into `price_list_change_signal`.
 *
 * Exported and pure so the write can be pinned by a test without a Supabase
 * connection — this machine is sandbox-role and may not write. It must stay
 * byte-identical in column set to the file-import writer in MKCP MOB2's
 * `web-dashboard/api/price-list.ts`, or the web side cannot tell which path
 * produced a given row (G1). See `bumpPriceListSignal` for the full account.
 */
export function priceListSignalRow(
  company: string,
  itemCount: number,
  now: Date = new Date(),
): { company: string; updated_at: string; item_count: number } {
  return { company, updated_at: now.toISOString(), item_count: itemCount };
}

/** Normalize a Tally date to ISO YYYY-MM-DD. Accepts "20260401" or "2026-04-01". */
function toIsoDate(raw: any): any {
  if (raw == null) return raw;
  const s = String(raw).trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
}

function normalizeTallyEntries(raw: any, innerKey: string): any[] {
  if (raw == null) return [];
  // Already an array (old format / multiple rows)
  if (Array.isArray(raw)) return raw;
  // Wrapped: { inventoryentries: ... }
  if (typeof raw === "object" && innerKey in raw) {
    const inner = raw[innerKey];
    if (inner == null) return [];
    if (Array.isArray(inner)) return inner;
    if (typeof inner === "object") return [inner]; // single nested entry
    return [];
  }
  // Single entry object passed directly (no wrapper)
  if (typeof raw === "object") return [raw];
  return [];
}

export class SupabaseSync {
  private client: SupabaseClient | null;

  constructor() {
    // Service-role key must come from the env — no hardcoded fallback. A
    // literal key used to sit here (and in refreshListener.ts), got committed
    // and pushed to the repo, and must be treated as a rotated/dead credential
    // going forward: even a private repo's git history keeps it, and a
    // service-role key bypasses RLS entirely, so a leaked one is a full-DB
    // read/write credential, not a "speed bump" like the client-side
    // MKC_API_SECRET. Fail closed instead of silently reusing it.
    const url = process.env.SUPABASE_URL || "https://vmkytsytxlofjyeotmgb.supabase.co";
    const key = process.env.SUPABASE_SERVICE_KEY;

    if (!url || !key) {
      console.warn("[Supabase] Missing Supabase credentials — sync disabled");
      this.client = null;
      return;
    }

    try {
      /* Through the one chokepoint, so OFFLINE MODE reaches every writer at
         once. This class is the main one — masters, vouchers, config, and the
         prunes — so a machine holding a duplicate company must not get a live
         client here under any circumstances. See supabaseClient.ts. */
      this.client = supabaseClient({ realtime: { params: { eventsPerSecond: 10 } } });
      if (!this.client) return;
      console.log("[Supabase] Client initialized");
    } catch (err: any) {
      console.error(`[Supabase] Failed to initialize client: ${err.message}`);
      console.error(`[Supabase] WebSocket support: ${typeof WebSocket}`);
      this.client = null;
    }
  }

  /**
   * The client, or null when this process must not touch Supabase.
   *
   * Exposed for readers that need the mirror to answer a question rather than
   * to receive a write — the incremental-sync cursor is the first: "what is the
   * highest AlterID I actually hold" is a question only the mirror can answer,
   * and it is the difference between resuming correctly after a restart and
   * silently skipping everything edited while the agent was down.
   *
   * Null is a normal answer (offline mode, no service key) and every caller
   * must handle it — see services/syncCursor.ts, which reports the degraded
   * cursor rather than pretending it has one.
   */
  getClient(): SupabaseClient | null {
    return this.client;
  }

  async syncMasters(messages: any[], company: string): Promise<void> {
    if (!this.client) return;
    if (!messages || messages.length === 0) return;

    const t0 = Date.now();
    const errors: string[] = [];

    try {
      const groups = messages
        .filter((m) => m.metadata?.type === "Stock Group")
        .map((m) => this.mapStockGroup(m, company))
        .filter(Boolean);
      const units = messages
        .filter((m) => m.metadata?.type === "Unit")
        .map((m) => this.mapUnit(m, company))
        .filter(Boolean);
      const godowns = messages
        .filter((m) => m.metadata?.type === "Godown")
        .map((m) => this.mapGodown(m, company))
        .filter(Boolean);
      const costCentres = messages
        .filter((m) => m.metadata?.type === "Cost Centre")
        .map((m) => this.mapCostCentre(m, company))
        .filter(Boolean);
      const items = messages
        .filter((m) => m.metadata?.type === "Stock Item")
        .map((m) => this.mapStockItem(m, company))
        .filter(Boolean);
      const ledgers = messages
        .filter((m) => m.metadata?.type === "Ledger")
        .map((m) => this.mapLedger(m, company))
        .filter(Boolean);
      const companies = messages
        .filter((m) => m.metadata?.type === "Company")
        .map((m) => this.mapCompany(m))
        .filter(Boolean);

      // Batch large tables (stock items, ledgers) to avoid exceeding REST payload limits
      const results = await Promise.allSettled([
        this.upsertBatch("tally_stock_groups", groups),
        this.upsertBatch("tally_units", units),
        this.upsertBatch("tally_godowns", godowns),
        this.upsertBatch("tally_cost_centres", costCentres),
        this.batchAndUpsert("tally_stock_items", items),
        this.batchAndUpsert("tally_ledgers", ledgers),
        this.upsertBatch("tally_companies", companies, "name"),
      ]);

      // Log any failures from Promise.allSettled
      const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      failed.forEach((r) => {
        const msg = `[Supabase] Masters upsert failed: ${r.reason?.message || String(r.reason)}`;
        errors.push(msg);
        console.error(msg);
      });

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `[Supabase] ✓ Masters synced: ${groups.length} groups, ${units.length} units, ${godowns.length} godowns, ${costCentres.length} cost centres, ${items.length} items, ${ledgers.length} ledgers (${elapsed}s)`
      );

      await this.logSyncHistory(company, "masters", t0, {
        groups: groups.length,
        units: units.length,
        godowns: godowns.length,
        costCentres: costCentres.length,
        items: items.length,
        ledgers: ledgers.length,
      }, errors.length === 0 ? null : errors);
    } catch (e: any) {
      const msg = `[Supabase] Masters sync error: ${e.message}`;
      console.error(msg);
      await this.logSyncHistory(company, "masters", t0, null, [msg], false);
      throw e;
    }
  }

  async syncVouchers(
    messages: any[],
    company: string,
    meta?: { chunkCount?: number; pruneRange?: { from: string; to: string }; pruneDays?: string[] }
  ): Promise<void> {
    if (!this.client) return;
    // If there are days to prune we must run even with zero pulled vouchers
    // (those days may be empty in Tally now and need their stale rows cleared).
    if ((!messages || messages.length === 0) && !meta?.pruneDays?.length) return;

    const t0 = Date.now();
    const errors: string[] = [];

    try {
      const vouchers = messages
        .filter((m) => m.metadata?.type === "Voucher")
        .map((m) => this.mapVoucher(m, company))
        .filter(Boolean);

      // Per-day prune can clear empty days even with nothing to upsert.
      if (vouchers.length === 0 && !meta?.pruneDays?.length) return;

      /* ── Read the AlterIDs we are about to overwrite ─────────────────────
         This MUST happen before the upsert: the pre-image is the whole point.
         Skipped above the ceiling, where emitMirrorChanges stays silent anyway
         and this would only be a large read to feed a discarded answer. A null
         result means "could not tell" and every voucher is then announced. */
      const priorAlterIds: PriorVersions | null =
        vouchers.length > 0 && vouchers.length <= SIGNAL_CEILING
          ? await this.priorVoucherAlterIds(company, vouchers.map((v: any) => String(v.guid)))
          : null;

      // Batch vouchers in chunks of 200 (smaller than stock items due to JSONB payload)
      const BATCH_SIZE = 200;
      for (let i = 0; i < vouchers.length; i += BATCH_SIZE) {
        const batch = vouchers.slice(i, i + BATCH_SIZE);
        await this.upsertBatch("tally_vouchers", batch);
      }

      /* ── Say WHICH vouchers moved (Phase 4.2) ────────────────────────────
         Emitted AFTER the upsert, never before: a client that reacts instantly
         must not be sent looking for a row that has not landed. Never throws,
         and stays silent above a ceiling — a full sync rewrites every voucher,
         and 2,792 individual hints would cost more than the single reload they
         were meant to replace. A client that misses or ignores all of this does
         exactly what it does today. See services/mirrorSignal.ts. */
      const candidates = vouchers.map((v: any) => ({
        table: "tally_vouchers",
        pk: String(v.guid),
        // Upserts, so an existing voucher is an update and a new one an
        // insert — indistinguishable from here, and the client treats both
        // the same way (fetch that row). "update" is the honest label for
        // "this row now differs from what you hold".
        op: "update" as const,
        version: typeof v.alter_id === "number" ? v.alter_id : null,
      }));

      /* Drop the ones whose AlterID did not move since the mirror row we just
         overwrote. A pass re-emitting its whole window was producing 4,918
         signals for 106 vouchers in 24 h (measured 15-Sep-2026); replayed
         against those rows this leaves 115. Nothing is dropped on any weaker
         evidence than "both AlterIDs are numbers and they are equal" — see
         selectMovedChanges. */
      const selection = selectMovedChanges(candidates, priorAlterIds ?? new Map());

      const signal = await emitMirrorChanges(this.client, company, selection.emit);
      if (selection.unchangedAlterId.length > 0 || signal.suppressed || signal.emitted === 0) {
        console.log(
          `[Supabase] mirror signals: ${describeSelection(selection)}` +
          `${priorAlterIds ? "" : " [no pre-image available — nothing deduped]"} → ${signal.note}`
        );
      }

      // Extract and sync denormalized ledger and inventory entries
      const ledgerEntries: any[] = [];
      const inventoryEntries: any[] = [];
      const voucherGuids: Set<string> = new Set();

      for (const v of vouchers) {
        voucherGuids.add(v.guid);

        // Ledger entries
        if (v.ledger_entries && Array.isArray(v.ledger_entries)) {
          for (const le of v.ledger_entries) {
            ledgerEntries.push({
              voucher_guid: v.guid,
              company,
              ledger_name: le.ledgername,
              is_debit: le.isdeemedpositive === true,
              is_party_ledger: le.ispartyledger === true,
              amount: le.amount,
              bill_allocations: le.billallocations || null,
              synced_at: new Date().toISOString(),
            });
          }
        }

        // Inventory entries
        if (v.inventory_entries && Array.isArray(v.inventory_entries)) {
          for (const ie of v.inventory_entries) {
            inventoryEntries.push({
              voucher_guid: v.guid,
              company,
              stock_item_name: ie.stockitemname,
              actual_qty: ie.actualqty,
              billed_qty: ie.billedqty,
              rate: ie.rate,
              amount: ie.amount,
              is_deemed_positive: ie.isdeemedpositive === true,
              /* The location key (Phase 2.4). Tally carries godown and batch on
                 BATCHALLOCATIONS.LIST for every inventory line; this table had
                 nowhere to put them, so the mirror could not say where anything
                 physically was. `?? null` rather than `?? ""` — a row whose
                 allocation Tally did not send must read as "no key", not as an
                 empty godown name. */
              godown_name: ie.godownname || null,
              batch_name: ie.batchname || null,
              destination_godown_name: ie.destinationgodownname || null,
              batch_allocations: ie.batchallocations?.length ? ie.batchallocations : null,
              is_split_across_godowns: ie.issplitacrossgodowns === true,
              synced_at: new Date().toISOString(),
            });
          }
        }
      }

      // Delete old entries for these vouchers, then insert new ones
      if (voucherGuids.size > 0) {
        const guidsArray = Array.from(voucherGuids);

        // Delete in chunks to avoid SQL length limits
        const DELETE_CHUNK = 100;
        for (let i = 0; i < guidsArray.length; i += DELETE_CHUNK) {
          const chunk = guidsArray.slice(i, i + DELETE_CHUNK);
          // Retry-wrapped: a transient "fetch failed" here used to fail the whole
          // voucher sync (leaving stale child entries). withRetry rides out the blip.
          await this.withRetry("delete tally_voucher_ledger_entries", async () => {
            const { error } = await this.client!
              .from("tally_voucher_ledger_entries")
              .delete()
              .in("voucher_guid", chunk)
              .eq("company", company);
            if (error) throw new Error(`tally_voucher_ledger_entries: ${error.message}`);
          });

          await this.withRetry("delete tally_voucher_inventory_entries", async () => {
            const { error } = await this.client!
              .from("tally_voucher_inventory_entries")
              .delete()
              .in("voucher_guid", chunk)
              .eq("company", company);
            if (error) throw new Error(`tally_voucher_inventory_entries: ${error.message}`);
          });
        }

        // Insert new entries in batches of 200
        if (ledgerEntries.length > 0) {
          await this.batchAndInsert("tally_voucher_ledger_entries", ledgerEntries);
        }
        if (inventoryEntries.length > 0) {
          await this.batchAndInsert("tally_voucher_inventory_entries", inventoryEntries);
        }
      }

      // Remove vouchers deleted or converted in Tally — but ONLY within the date
      // window that was actually pulled (meta.pruneDays / meta.pruneRange). A
      // daybook/range sync pulls a SUBSET of vouchers, so deleting every GUID not
      // in that subset would wipe the entire history outside the range. Scoping
      // the delete to the pulled days/range makes that pull authoritative only
      // for what it covers and leaves all other dates untouched.
      //
      // The only caller that omits both (a pure upsert, no deletion) is the
      // /api/supabase/sync masters-only route's LEGACY vouchers path — as of the
      // per-day-pruned Delivery Note fix, no current caller sends vouchers there
      // at all (voucher pushes only ever go through the meta.pruneDays path
      // above, from syncOrchestrator). Omitting the meta here used to be exactly
      // how a stale, already-deleted voucher got silently re-inserted every
      // cycle — do not resurrect an unmeta'd voucher push without pruning.
      let deleted = 0;
      if (meta?.pruneDays?.length) {
        // Per-day prune: each successfully-pulled day is authoritative for itself,
        // so deletions (incl. old Delivery Notes) clear even if other days failed.
        // Empty days are pruned too (their stale rows have no matching pulled GUID) —
        // UNLESS the mass-deletion guard (migration 026) refuses a wide, mostly-
        // empty batch; see deleteVoucherOrphansForDays below.
        const r = await this.deleteVoucherOrphansForDays(company, meta.pruneDays, Array.from(voucherGuids));
        deleted = r.deleted;
        if (r.guardTripped) {
          const msg = `Mass-deletion guard refused per-day prune across ${meta.pruneDays.length} day(s) — ` +
            `too much of the existing data would have been removed for too little fresh data pulled back. ` +
            `Nothing was deleted; existing vouchers on these days were left untouched.`;
          console.warn(`[Supabase] ⚠ ${msg}`);
          errors.push(msg);
        }
      } else if (meta?.pruneRange?.from && meta?.pruneRange?.to) {
        const r = await this.deleteVoucherOrphansInRange(
          company,
          meta.pruneRange.from,
          meta.pruneRange.to,
          Array.from(voucherGuids)
        );
        deleted = r.deleted;
        if (r.guardTripped) {
          const msg = `Mass-deletion guard refused range prune for ${meta.pruneRange.from}–${meta.pruneRange.to} — ` +
            `too much of the existing data would have been removed for too little fresh data pulled back. ` +
            `Nothing was deleted; existing vouchers in this range were left untouched.`;
          console.warn(`[Supabase] ⚠ ${msg}`);
          errors.push(msg);
        }
      }
      if (deleted > 0) {
        // Clean up child rows whose parent was just deleted.
        await this.cleanupOrphanEntries(company);
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `[Supabase] ✓ Vouchers synced: ${vouchers.length} vouchers, ${ledgerEntries.length} ledger entries, ${inventoryEntries.length} inventory entries${deleted > 0 ? `, ${deleted} orphan(s) removed` : ""} (${elapsed}s)`
      );

      await this.logSyncHistory(
        company,
        "vouchers",
        t0,
        {
          vouchers: vouchers.length,
          ledgerEntries: ledgerEntries.length,
          inventoryEntries: inventoryEntries.length,
        },
        errors.length === 0 ? null : errors,
        undefined,
        meta?.chunkCount
      );
    } catch (e: any) {
      const msg = `[Supabase] Vouchers sync error: ${e.message}`;
      console.error(msg);
      await this.logSyncHistory(company, "vouchers", t0, null, [msg], false);
      throw e;
    }
  }

  /**
   * The AlterIDs the mirror holds for these GUIDs, read BEFORE the upsert.
   *
   * This is the source of truth for "what did the last signal announce",
   * not a cache of it: a signal is only ever emitted after a successful upsert
   * (see the emit site), so the AlterID sitting in `tally_vouchers` when this
   * runs is exactly the one the previous signal carried. An in-process map
   * would have said the same thing while the agent stayed up and forgotten it
   * across the restarts that happen several times a day.
   *
   * Cost, measured on this dataset 15-Sep-2026: 2,839 vouchers total, and a
   * normal pass carries a few dozen — two columns for at most SIGNAL_CEILING
   * (300) GUIDs, chunked 100 at a time because `.in()` is a GET and the GUIDs
   * are 36 chars each. That is the same chunk size the child-row deletes below
   * have used against this table without hitting a URL limit.
   *
   * Returns null when it CANNOT answer — a failed read, a missing column, no
   * client. Null is not "nothing changed"; the caller turns it into "announce
   * everything", which is the behaviour that existed before this read did.
   *
   * TRAP: `tally_vouchers` also has a column literally called `version`, and it
   * is 0 on every row (checked 15-Sep-2026, integer, never written by this
   * agent). `mirror_change_signal.version` is `tally_vouchers.alter_id` —
   * verified by join, 100 of 100 matched pairs. Read alter_id, never version.
   */
  private async priorVoucherAlterIds(
    company: string,
    guids: string[],
  ): Promise<PriorVersions | null> {
    if (!this.client) return null;
    const clean = (guids || []).filter((g): g is string => typeof g === "string" && g.length > 0);
    if (clean.length === 0) return new Map();

    const held = new Map<string, number | null>();
    const CHUNK = 100;
    try {
      for (let i = 0; i < clean.length; i += CHUNK) {
        const chunk = clean.slice(i, i + CHUNK);
        const { data, error } = await this.withRetry("select prior alter_id", async () => {
          const res = await this.client!
            .from("tally_vouchers")
            .select("guid, alter_id")
            .eq("company", company)
            .in("guid", chunk);
          if (res.error && this.isTransient(res.error)) throw res.error;
          return res;
        });
        if (error) {
          console.warn(`[Supabase] mirror signals: pre-image read failed (${error.message}) — announcing every voucher this pass`);
          return null;
        }
        for (const row of data ?? []) {
          /* A row with no alter_id is recorded as null, NOT omitted: "the row
             exists but carries no AlterID" and "there is no row" are different
             facts (G7). Both are emitted, but they are not the same thing and
             the log says which. */
          const a = (row as any).alter_id;
          held.set(String((row as any).guid), typeof a === "number" ? a : null);
        }
      }
      return held;
    } catch (e: any) {
      console.warn(`[Supabase] mirror signals: pre-image read threw (${e?.message || e}) — announcing every voucher this pass`);
      return null;
    }
  }

  private async logSyncHistory(
    company: string,
    syncType: "masters" | "vouchers",
    startedAtMs: number,
    rowCounts: any,
    errors: string[] | null = null,
    success: boolean = !errors || errors.length === 0,
    chunkCount?: number
  ): Promise<void> {
    if (!this.client) return;

    try {
      const startedAt = new Date(startedAtMs).toISOString();
      const completedAt = new Date().toISOString();

      await this.withRetry("insert tally_sync_history", async () => {
        const { error } = await this.client!.from("tally_sync_history").insert({
          company,
          sync_type: syncType,
          started_at: startedAt,
          completed_at: completedAt,
          row_counts: rowCounts,
          errors: errors,
          success,
          duration_ms: Date.now() - startedAtMs,
          ...(chunkCount != null ? { chunk_count: chunkCount } : {}),
        });
        if (error) throw new Error(error.message);
      });
    } catch (e: any) {
      console.error(`[Supabase] Failed to log sync history: ${e.message}`);
    }
  }

  /**
   * Propagate local deletes to Supabase by removing cloud rows whose unique
   * key is NOT in the list the client just pushed.
   *
   * Safety:
   *   • Empty `validKeys` is a no-op — protects against a partially-hydrated
   *     store accidentally wiping a populated cloud.
   *   • Database function additionally allowlists (table, keyCol) — see
   *     migration 010_orphan_cleanup_function.sql.
   *   • Failures are logged but never thrown — orphan cleanup is best-effort.
   *     The push itself has already succeeded; stale cloud rows are a smaller
   *     problem than a 500 on the whole sync.
   */
  private async deleteOrphans(
    table: string,
    company: string,
    keyCol: string,
    validKeys: string[]
  ): Promise<number> {
    if (!this.client) return 0;
    // Defensive filter: a single null/undefined/empty key in the array would
    // poison the DB-side `<>ALL($2)` comparison (NULL propagation) and quietly
    // skip the cleanup. Strip them client-side so the cleanup is reliable.
    const clean = (validKeys || []).filter(
      (k): k is string => typeof k === "string" && k.length > 0
    );
    if (clean.length === 0) return 0;
    try {
      const { data, error } = await this.withRetry(`rpc delete_orphans (${table})`, async () => {
        const res = await this.client!.rpc("delete_orphans", {
          p_table: table,
          p_company: company,
          p_key_col: keyCol,
          p_valid_keys: clean,
        });
        // postgrest resolves a transient fetch failure into { error } (it does NOT throw
        // and won't auto-retry a POST), so re-throw transient errors to trigger withRetry's
        // backoff. Non-transient errors fall through to the best-effort handler below.
        if (res.error && this.isTransient(res.error)) throw res.error;
        return res;
      });
      if (error) {
        // Most likely cause: migration not applied yet. Log + continue.
        console.warn(`[Supabase] Orphan cleanup skipped for ${table}: ${error.message}`);
        return 0;
      }
      const n = typeof data === "number" ? data : 0;
      if (n > 0) {
        console.log(`[Supabase] ⌫ Cleaned ${n} orphan rows from ${table}`);
      }
      return n;
    } catch (e: any) {
      console.warn(`[Supabase] Orphan cleanup error in ${table}: ${e?.message || e}`);
      return 0;
    }
  }

  /**
   * Delete vouchers within [from, to] whose GUID is NOT in the just-pulled set.
   * This is how a range sync propagates Tally deletions/conversions to the cloud
   * WITHOUT touching vouchers dated outside the pulled window.
   *
   * Uses an RPC (migration 017, mass-deletion-guarded by 026) so the GUID list
   * ships in the POST body — a plain .not("guid","in",...) DELETE would put
   * hundreds of 36-char GUIDs in the URL query string and overflow the length
   * limit. Best-effort: a missing migration or any error logs a warning and
   * returns { deleted: 0 } (never throws, never over-deletes). The RPC itself
   * returns -1 (mapped to guardTripped: true here) when it refused a prune that
   * would have removed too much of the existing range for too little confirmed
   * fresh data — see migration 026's header for the incident that motivated it.
   */
  private async deleteVoucherOrphansInRange(
    company: string,
    from: string,
    to: string,
    validGuids: string[]
  ): Promise<{ deleted: number; guardTripped: boolean }> {
    if (!this.client) return { deleted: 0, guardTripped: false };
    const clean = (validGuids || []).filter((g): g is string => typeof g === "string" && g.length > 0);
    // Empty valid set is ambiguous (genuinely-empty range vs failed pull) — refuse
    // to delete-all-in-range. The early `vouchers.length === 0` return upstream
    // already guards this, but keep the belt-and-braces check here too.
    if (clean.length === 0) return { deleted: 0, guardTripped: false };
    try {
      const { data, error } = await this.withRetry("rpc delete_voucher_orphans_in_range", async () => {
        const res = await this.client!.rpc("delete_voucher_orphans_in_range", {
          p_company: company,
          p_from: toIsoDate(from),
          p_to: toIsoDate(to),
          p_valid_guids: clean,
        });
        if (res.error && this.isTransient(res.error)) throw res.error; // postgrest returns fetch errors as {error}
        return res;
      });
      if (error) {
        console.warn(`[Supabase] Voucher range cleanup skipped (${from}–${to}): ${error.message}`);
        return { deleted: 0, guardTripped: false };
      }
      const n = typeof data === "number" ? data : 0;
      if (n === -1) return { deleted: 0, guardTripped: true };
      if (n > 0) console.log(`[Supabase] ⌫ Removed ${n} voucher(s) deleted in Tally within ${from}–${to}`);
      return { deleted: n, guardTripped: false };
    } catch (e: any) {
      console.warn(`[Supabase] Voucher range cleanup error: ${e?.message || e}`);
      return { deleted: 0, guardTripped: false };
    }
  }

  /**
   * Delete vouchers on the given days whose GUID isn't in the just-pulled set.
   * One RPC for all days (migration 019, mass-deletion-guarded by 026). Each day
   * must be one we pulled cleanly; an empty pulled set for a day normally means
   * that day is empty in Tally now, so its stale rows are removed — UNLESS the
   * batch spans more than a few days and would remove most of what's on file,
   * in which case the RPC refuses (returns -1, mapped to guardTripped: true
   * here) rather than trusting an all-empty response across a wide window. See
   * migration 026's header for the incident that motivated this. Best-effort: a
   * missing migration warns and returns { deleted: 0 }.
   */
  private async deleteVoucherOrphansForDays(
    company: string,
    days: string[],
    validGuids: string[]
  ): Promise<{ deleted: number; guardTripped: boolean }> {
    if (!this.client) return { deleted: 0, guardTripped: false };
    // Days arrive as YYYYMMDD (chunk dates) — convert to ISO to match the stored
    // tally_vouchers.date column (normalized to ISO above).
    const cleanDays = (days || [])
      .filter((d): d is string => typeof d === "string" && /^\d{8}$/.test(d))
      .map((d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);
    if (cleanDays.length === 0) return { deleted: 0, guardTripped: false };
    const cleanGuids = (validGuids || []).filter((g): g is string => typeof g === "string" && g.length > 0);
    try {
      const { data, error } = await this.withRetry("rpc delete_voucher_orphans_for_days", async () => {
        const res = await this.client!.rpc("delete_voucher_orphans_for_days", {
          p_company: company,
          p_days: cleanDays,
          p_valid_guids: cleanGuids,
        });
        if (res.error && this.isTransient(res.error)) throw res.error; // postgrest returns fetch errors as {error}
        return res;
      });
      if (error) {
        console.warn(`[Supabase] Per-day voucher prune skipped: ${error.message}`);
        return { deleted: 0, guardTripped: false };
      }
      const n = typeof data === "number" ? data : 0;
      if (n === -1) return { deleted: 0, guardTripped: true };
      if (n > 0) console.log(`[Supabase] ⌫ Removed ${n} voucher(s) deleted in Tally across ${cleanDays.length} day(s)`);
      return { deleted: n, guardTripped: false };
    } catch (e: any) {
      console.warn(`[Supabase] Per-day voucher prune error: ${e?.message || e}`);
      return { deleted: 0, guardTripped: false };
    }
  }

  /** Remove ledger + inventory entries for vouchers no longer in tally_vouchers. */
  private async cleanupOrphanEntries(company: string): Promise<void> {
    if (!this.client) return;
    try {
      const { data, error } = await this.withRetry("rpc cleanup_orphan_voucher_entries", async () => {
        const res = await this.client!.rpc("cleanup_orphan_voucher_entries", { p_company: company });
        if (res.error && this.isTransient(res.error)) throw res.error; // postgrest returns fetch errors as {error}
        return res;
      });
      if (error) {
        console.warn(`[Supabase] Orphan entry cleanup skipped: ${error.message}`);
        return;
      }
      if (typeof data === "number" && data > 0) {
        console.log(`[Supabase] ⌫ Cleaned ${data} orphan entry rows (ledger + inventory)`);
      }
    } catch (e: any) {
      console.warn(`[Supabase] Orphan entry cleanup error: ${e?.message || e}`);
    }
  }

  /** True for connection-level blips worth retrying (NOT data/constraint errors). */
  private isTransient(e: any): boolean {
    const m = (e?.message || String(e ?? "")).toLowerCase();
    return m.includes("fetch failed") || m.includes("econnreset") || m.includes("etimedout")
      || m.includes("enotfound") || m.includes("eai_again") || m.includes("socket hang up")
      || m.includes("network") || m.includes("und_err") || m.includes("timeout");
  }

  /**
   * Run a Supabase network op with backoff retry on TRANSIENT failures only.
   * A momentary "TypeError: fetch failed" (brief loss of connectivity) was aborting
   * the whole masters/voucher sync; retrying lets it ride out the blip. Data errors
   * (constraint/RLS) don't match isTransient, so they fail fast without pointless retries.
   */
  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const delays = [500, 1500, 3500]; // up to 3 retries (~5.5s total)
    let lastErr: any;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        return await fn();
      } catch (e: any) {
        lastErr = e;
        if (attempt < delays.length && this.isTransient(e)) {
          const d = delays[attempt];
          console.warn(`[Supabase] ${label}: transient failure (try ${attempt + 1}/${delays.length + 1}) — retrying in ${d}ms: ${e?.message || e}`);
          await new Promise((r) => setTimeout(r, d));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  private async upsertBatch(
    table: string,
    rows: any[],
    conflictCol: string = "guid"
  ): Promise<void> {
    if (!this.client || rows.length === 0) return;

    try {
      await this.withRetry(`upsert ${table}`, async () => {
        const { error } = await this.client!.from(table).upsert(rows, { onConflict: conflictCol });
        if (error) throw new Error(`${table}: ${error.message}`);
      });
    } catch (e: any) {
      console.error(`[Supabase] Batch upsert error in ${table}: ${e.message}`);
      throw e;
    }
  }

  private async batchAndUpsert(table: string, rows: any[]): Promise<void> {
    if (!this.client || rows.length === 0) return;

    const BATCH_SIZE = 200;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      await this.upsertBatch(table, batch);
    }
  }

  private async batchAndInsert(table: string, rows: any[]): Promise<void> {
    if (!this.client || rows.length === 0) return;

    const BATCH_SIZE = 200;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      try {
        await this.withRetry(`insert ${table}`, async () => {
          const { error } = await this.client!.from(table).insert(batch);
          if (error) throw new Error(`${table}: ${error.message}`);
        });
      } catch (e: any) {
        console.error(`[Supabase] Batch insert error in ${table}: ${e.message}`);
        throw e;
      }
    }
  }

  /**
   * ── The fallback has never fired. Measured 15-Sep-2026 ──────────────────
   *
   * `company|name` appears in ZERO rows of `tally_vouchers` (0 of 2,839, all
   * GUID-shaped), and zero rows of `tally_stock_items`, `tally_ledgers`,
   * `tally_stock_groups`, `tally_units` and `tally_godowns`. It has never
   * produced a stored id in this database.
   *
   * That is worth saying because the phantoms looked like its work and were
   * not: the browser forwards `normalizeId(name)` as the guid, which is
   * non-empty, so this returned it untouched. The invented-id branch was never
   * the leak — the guard in front of it was.
   *
   * For the six MASTER mappers this is now unreachable by construction:
   * `hasRealGuid` requires a GUID-shaped id before any of them reach here.
   * Only `mapVoucher` can still get here with nothing, and if it ever does,
   * that voucher would be keyed on a name and could never be reconciled with
   * the real one — so it is said out loud rather than absorbed.
   */
  private safeGuid(raw: string | undefined, company: string, fallbackKey: string): string {
    const g = (raw || "").trim();
    if (g) return g;
    console.warn(
      `[sync] no GUID for "${fallbackKey}" — keying it on the name. This has never ` +
      `happened in production and a row written this way cannot reconcile with ` +
      `the real one. Check what produced it before trusting the row.`,
    );
    return `${company}|${fallbackKey}`;
  }

  /**
   * A master row is only authoritative if Tally gave us its real GUID.
   *
   * Why this guard exists — it cost 464 phantom ledgers and ~470 phantom stock
   * items in production, found 2026-08-27:
   *
   * `POST /api/supabase/sync` (called by the desktop's scheduled `pushAll`)
   * forwards the CANONICAL masters held in the browser. Canonical ids are
   * `normalizeId(name)` — the NAME, not Tally's GUID. `safeGuid` happily
   * accepted that as a guid, so every quick sync inserted a second row per
   * master keyed on the name, alongside the real row keyed on
   * `353d02e0-63aa-11d7-...`. Because the upsert key IS the guid, the two can
   * never reconcile: `tally_ledgers` went to 947 rows for 483 names, all stubs
   * carrying `parent: "Unsorted"` and NULL gstin/credit_period/opening_balance.
   *
   * The damage is silent — the readers dedupe (`ledgerRichness` / `richness` in
   * the web app's dataset.ts) so the UI looked fine, while every raw SQL join
   * against those tables quietly DOUBLED. That is how a GSTR-1 reconciliation
   * came back at exactly 2x the filed figure.
   *
   * A master without a real GUID is a phantom, so we skip it rather than
   * invent an id for it. Genuine Tally master syncs always carry a GUID, so
   * this is inert on the real path.
   *
   * ── Extended to every master type, 13-Sep-2026 ───────────────────────────
   *
   * It guarded only stock items and ledgers, which is where the damage had
   * been SEEN — but the same `POST /api/supabase/sync` path forwards stock
   * groups, units, godowns and cost centres from the browser with exactly the
   * same name-derived canonical ids, so those four could still create
   * name-keyed phantoms. They had not yet, which is not the same as being
   * safe. Guardrail G5.
   *
   * Verified inert before extending it: every master type Tally serves carries
   * a real GUID — stock groups 22/22, units 9/9, godowns 1/1, ledgers 482/482,
   * stock items 489/489, cost centres 0 of 0 (this company has none). So the
   * guard drops nothing real and blocks only the browser-forwarded path.
   */
  /**
   * ── It was inert. Measured 15-Sep-2026 ──────────────────────────────────
   *
   * This returned `!!(m?.guid || "").trim()` — it tested only that the guid was
   * NON-EMPTY. But the phantom ids it exists to block are `normalizeId(name)`,
   * the uppercased item name, which is always non-empty. Every phantom passed
   * the guard the comment above describes it as stopping.
   *
   * `tally_stock_items` on 15-Sep-2026: **951 rows — 492 carrying a real Tally
   * GUID and 459 whose guid IS the item name**, every one of those 459 with
   * `gst_details` null and the rest of its columns empty. The 14-Sep backup held
   * 7. So it went 7 → 459 in a day, two days AFTER this guard was extended to
   * "every master type" and verified "inert on the real path" — it was inert on
   * every path.
   *
   * A Tally GUID looks like `353d02e0-63aa-11d7-8d44-d4bc1970ad56-0003ce47`:
   * hex groups joined by hyphens. An item name does not. Testing the SHAPE is
   * what the guard always meant; testing emptiness only ever tested that a
   * string had been set.
   *
   * Safe to tighten, and checked before tightening: every master type Tally
   * itself serves carries a real GUID — stock groups 22/22, units 9/9, godowns
   * 1/1, ledgers 482/482, stock items 489/489. So this drops nothing Tally
   * sends and blocks only the browser-forwarded canonical ids. Guardrail G5.
   *
   * It does NOT clean up the 459 already there. A prune keys on "this guid is
   * not GUID-shaped", never on "absent from today's pull" — sandbox and
   * production share one company name, so an absence-based prune would delete
   * real data (G6). That is a separate, operator-approved action.
   */
  private hasRealGuid(m: any): boolean {
    const g = (m?.guid || "").trim();
    if (!g) return false;
    // Hex-and-hyphen only, at least two groups, and long enough that a short
    // coded item name cannot pass by accident.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]+$/i.test(g)) return false;
    // Belt and braces: never accept the canonical id, whatever its shape.
    const name = (m?.name || "").trim();
    return !(name && g.toUpperCase() === name.toUpperCase());
  }

  private mapCompany(m: any): any {
    return {
      name: m.name,
      synced_at: new Date().toISOString(),
    };
  }

  private mapStockGroup(m: any, company: string): any {
    if (!m.name) return null;
    if (!this.hasRealGuid(m)) return null; // see hasRealGuid — phantom-master guard
    return {
      guid: this.safeGuid(m.guid, company, m.name),
      company,
      name: m.name,
      parent: m.parent || "Primary",
      is_addable: m.isaddable === "Yes",
      synced_at: new Date().toISOString(),
    };
  }

  private mapUnit(m: any, company: string): any {
    if (!m.name) return null;
    if (!this.hasRealGuid(m)) return null; // see hasRealGuid — phantom-master guard
    return {
      guid: this.safeGuid(m.guid, company, m.name),
      company,
      name: m.name,
      original_name: m.originalname,
      base_units: m.baseunits,
      additional_units: m.additionalunits,
      conversion: m.conversion,
      is_simple: m.issimpleunit === "Yes",
      is_compound: m.isformallycompound === "Yes",
      synced_at: new Date().toISOString(),
    };
  }

  private mapGodown(m: any, company: string): any {
    if (!m.name) return null;
    if (!this.hasRealGuid(m)) return null; // see hasRealGuid — phantom-master guard
    return {
      guid: this.safeGuid(m.guid, company, m.name),
      company,
      name: m.name,
      parent: m.parent || "Main Location",
      has_no_space: m.hasnospace === true,
      synced_at: new Date().toISOString(),
    };
  }

  private mapCostCentre(m: any, company: string): any {
    if (!m.name) return null;
    if (!this.hasRealGuid(m)) return null; // see hasRealGuid — phantom-master guard
    return {
      guid: this.safeGuid(m.guid, company, m.name),
      company,
      name: m.name,
      parent: m.parent,
      category: m.category,
      synced_at: new Date().toISOString(),
    };
  }

  private mapStockItem(m: any, company: string): any {
    if (!m.name) return null;
    if (!this.hasRealGuid(m)) return null; // see hasRealGuid — phantom-master guard
    return {
      guid: this.safeGuid(m.guid, company, m.name),
      company,
      name: m.name,
      parent: m.parent || "Primary",
      category: m.category,
      base_units: m.baseunits,
      additional_units: m.additionalunits,
      denominator: m.denominator,
      opening_balance: m.openingbalance,
      opening_rate: m.openingrate,
      opening_value: m.openingvalue,
      closing_balance: m.closingbalance,
      closing_rate: m.closingrate,
      closing_value: m.closingvalue,
      gst_applicable: m.gstapplicable,
      gst_type_of_supply: m.gsttypeofsupply,
      costing_method: m.costingmethod,
      valuation_method: m.valuationmethod,
      is_batch_wise: m.isbatchwiseon === true,
      is_cost_centre: m.iscostcentreson === true,
      gst_details: m.gstdetails || null,
      hsn_details: m.hsndetails || null,
      synced_at: new Date().toISOString(),
    };
  }

  private mapLedger(m: any, company: string): any {
    if (!m.name) return null;
    if (!this.hasRealGuid(m)) return null; // see hasRealGuid — phantom-master guard
    return {
      guid: this.safeGuid(m.guid, company, m.name),
      company,
      name: m.name,
      parent: m.parent || "Unsorted",
      opening_balance: m.openingbalance,
      gstin: m.gstin,
      credit_period: m.creditperiod,
      /* STATE decides CGST+SGST against IGST on every outward voucher, and the
         push guard's tax-head rule rests on it — while the mirror it reads from
         did not carry it at all. Tally has always sent these; convertLedgers
         has always discarded them. */
      state: m.state || null,
      country: m.country || null,
      pincode: m.pincode || null,
      mailing_name: m.mailingname || null,
      address: m.address || null,
      phone: m.phone || null,
      email: m.email || null,
      synced_at: new Date().toISOString(),
    };
  }

  private mapVoucher(m: any, company: string): any {
    // Synthetic GUID from voucher components if no real GUID exists
    const fallbackKey = [m.vouchertypename, m.date, m.vouchernumber, m.partyledgername]
      .filter(Boolean)
      .join("|");

    // Normalize entry shapes. Tally's XML→JSON wraps rows inside an inner key
    // for newer voucher types (e.g. allinventoryentries.inventoryentries), but
    // older types return the array directly. Without normalization, the
    // downstream Array.isArray(...) check in syncVouchers fails and zero
    // entries get pushed to the denormalized table.
    const ledgerArr = normalizeTallyEntries(m.allledgerentries, "ledgerentries");
    const inventoryArr = normalizeTallyEntries(m.allinventoryentries, "inventoryentries");

    // `transport` is absent on anything not produced by the current converter
    // (an older cached payload, a hand-built row in a test). Default to an empty
    // object so every field below resolves to null instead of throwing.
    const t = (m.transport ?? {}) as Record<string, any>;

    return {
      guid: this.safeGuid(m.guid, company, fallbackKey),
      company,
      // Normalize to ISO YYYY-MM-DD so tally_vouchers.date is consistent no matter
      // which path wrote it (server daybook = YYYYMMDD, renderer push = ISO).
      // The prune compares on this column, so consistency is essential.
      date: toIsoDate(m.date),
      effective_date: toIsoDate(m.effectivedate),
      voucher_number: m.vouchernumber,
      voucher_type: m.vouchertypename,
      party_ledger_name: m.partyledgername,
      narration: m.narration,
      /* Tally's own identity (stable across an Alter) and its change counter.
         remote_id is NOT set here — Tally does not export it, so it is written
         when we push and backfilled from push_queue, never learned by reading. */
      master_id: m.masterid ?? null,
      alter_id: m.alterid ?? null,
      /* The IRP clock. `|| null` not `?? null`: Tally sends an EMPTY string for
         an unregistered invoice, and "" stored in a text column is non-null —
         which would read as "registered, with a blank number" to every query
         that asks `WHERE irn IS NULL`. That is the same empty-string-vs-null
         confusion that made costing_method look landed on 492 rows. */
      irn: m.irn || null,
      irn_ack_no: m.irnackno || null,
      irn_ack_date: m.irnackdate || null,
      reference: m.reference ?? null,   // mirror Tally <REFERENCE> for push-agent reconciliation (see migration 012)
      is_cancelled: m.iscancelled === true,
      is_optional: m.isoptional === true,
      ledger_entries: ledgerArr.length > 0 ? ledgerArr : null,
      inventory_entries: inventoryArr.length > 0 ? inventoryArr : null,

      // E-way bill / delivery fields (migration 025). Extracted by
      // convert.ts extractVoucherTransport; nearly always null on vouchers that
      // never moved goods, which is normal and not a sync failure.
      //
      // Every key is emitted unconditionally, even when the whole block is
      // absent. PostgREST builds one INSERT column list per batch and rejects a
      // batch whose objects have differing key sets, so a conditional spread
      // here would fail the moment one voucher in a 200-row chunk had an e-way
      // bill and another did not — which is the normal case, not the edge case.
      ewb_number: t.ewb_number ?? null,
      ewb_valid_until: t.ewb_valid_until ?? null,
      vehicle_number: t.vehicle_number ?? null,
      transport_mode: t.transport_mode ?? null,
      transport_distance_km: t.transport_distance_km ?? null,
      consignee_pincode: t.consignee_pincode ?? null,
      consignee_place: t.consignee_place ?? null,
      consignee_state: t.consignee_state ?? null,
      ship_to_place: t.ship_to_place ?? null,
      dispatch_from_place: t.dispatch_from_place ?? null,
      party_gstin: t.party_gstin ?? null,
      place_of_supply: t.place_of_supply ?? null,

      synced_at: new Date().toISOString(),
    };
  }

  // ── Sync configuration data (local-only stores) ────────────────────────────
  // Note: discount_rules and order_groups are WEB-OWNED (web always holds
  // priority, jsonb `data` blob schema per web migration 0021) — the desktop
  // does not write them. See /api/supabase/sync-config for the full task list.

  // NOTE: syncUnitOverrides, syncGstOverrides, syncRateOverrides, and
  // syncVendorGroupAssignments (below) were removed (2026-08-25) — same
  // reasoning as syncItemCategoryOverrides/syncCategoryColors/
  // syncTallyPriceListImports above. None of the four have an active editing
  // UI anywhere in this desktop app (verified: their store setters —
  // setUnitOverride/setRateOverride/setGstOverride in overrideStore.ts,
  // assignItem/batchAssignItems in vendorGroupStore.ts — have zero callers
  // outside the stores themselves and a one-time boot restore from a bundled
  // defaults JSON / IndexedDB cache). The web dashboard's Edit Units, Price
  // List, and Vendors pages are the only places a person actually changes
  // this data. Every scheduled quick-sync (SyncAgent, always running,
  // multiple devices) was re-pushing that stale/default snapshot and calling
  // deleteOrphans, silently reverting whatever the web app had just written.

  // NOTE: syncItemCategoryOverrides and syncCategoryColors were removed
  // (2026-08-25). Both are part of the SAME web-owned "discount rules"
  // feature as discount_rules/order_groups (the Item Assignments + Color
  // tabs on the web dashboard's Discount Rules page) but were missed when
  // that exclusion was first added below — this file's own writer used the
  // desktop's stale local copy of these overrides and called deleteOrphans,
  // which silently deleted/reverted whatever the web app had just written
  // every time a scheduled quick-sync ran. Root-caused from the web side as
  // "discounts keep getting reset" — see web-dashboard's config_edit_log
  // (migration 0050/0051) for the write-attribution trail that made the
  // periodic revert visible. Fixed the same way discount_rules/order_groups
  // were: the desktop simply stops writing these two tables. See the
  // "web-owned" comment on the syncTasks list in index.ts.

  async syncItemNotes(notes: Record<string, { itemId: string; note: string; updatedAt: string }>, company: string): Promise<void> {
    if (!this.client) return;
    if (!notes || Object.keys(notes).length === 0) return;

    const t0 = Date.now();
    try {
      const mapped = Object.values(notes)
        .filter((n) => n.note && n.note.trim())
        .map((n) => ({
          item_id: n.itemId,
          company,
          note: n.note,
          updated_at: n.updatedAt || new Date().toISOString(),
          synced_at: new Date().toISOString(),
        }));

      if (mapped.length === 0) return;

      const BATCH = 200;
      for (let i = 0; i < mapped.length; i += BATCH) {
        const batch = mapped.slice(i, i + BATCH);
        const { error } = await this.client.from("item_notes").upsert(batch, {
          onConflict: "company,item_id",
        });
        if (error) throw new Error(error.message);
      }
      await this.deleteOrphans("item_notes", company, "item_id", mapped.map(r => r.item_id));
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[Supabase] ✓ Synced ${mapped.length} item notes (${elapsed}s)`);
    } catch (e: any) {
      console.error(`[Supabase] Item notes sync failed: ${e.message}`);
      throw e;
    }
  }

  async syncCallingList(entries: any[], company: string): Promise<void> {
    if (!this.client) return;
    if (!entries || entries.length === 0) return;

    const t0 = Date.now();
    try {
      const mapped = entries.map((e) => ({
        party_ledger_id: e.partyLedgerId,
        company,
        party_name: e.partyName,
        phone: e.phone || null,
        email: e.email || null,
        items: e.items || [],
        note: e.note || null,
        called: e.called === true,
        called_at: e.calledAt || null,
        added_at: e.addedAt || new Date().toISOString(),
        synced_at: new Date().toISOString(),
      }));

      const BATCH = 200;
      for (let i = 0; i < mapped.length; i += BATCH) {
        const batch = mapped.slice(i, i + BATCH);
        const { error } = await this.client.from("calling_list_entries").upsert(batch, {
          onConflict: "company,party_ledger_id",
        });
        if (error) throw new Error(error.message);
      }
      await this.deleteOrphans("calling_list_entries", company, "party_ledger_id", mapped.map(r => r.party_ledger_id));
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[Supabase] ✓ Synced ${mapped.length} calling list entries (${elapsed}s)`);
    } catch (e: any) {
      console.error(`[Supabase] Calling list sync failed: ${e.message}`);
      throw e;
    }
  }

  // NOTE: syncTallyPriceListImports was removed (2026-08-25) — same reasoning
  // as syncItemCategoryOverrides/syncCategoryColors above. The web dashboard's
  // Price List page (PriceList.tsx → apiUploadPriceList) is the only current,
  // user-facing way to import a price list; useTallyPriceListStore on the
  // desktop side has no UI writer left (nothing calls setPriceList), so it
  // only ever held a stale/empty local snapshot. Every scheduled quick-sync
  // pushed that stale snapshot and called deleteOrphans, silently deleting
  // rows the web app had just uploaded — reported as "I upload a JSON but it
  // doesn't sync across devices."

  async syncAppSettings(settings: Record<string, any>, company: string): Promise<void> {
    if (!this.client) return;
    if (!settings || Object.keys(settings).length === 0) return;

    const t0 = Date.now();
    try {
      const mapped = Object.entries(settings).map(([key, value]) => ({
        company,
        key,
        value: value === undefined ? null : value,
        updated_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
      }));

      const { error } = await this.client.from("app_settings").upsert(mapped, {
        onConflict: "company,key",
      });
      if (error) throw new Error(error.message);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[Supabase] ✓ Synced ${mapped.length} app settings (${elapsed}s)`);
    } catch (e: any) {
      console.error(`[Supabase] App settings sync failed: ${e.message}`);
      throw e;
    }
  }

  /**
   * Mirror Tally's dated price list.
   *
   * ⚠ Depends on migration 027, which has NOT been applied. Until it is, this
   * throws "relation does not exist" — verify with
   * `scripts/verify-supabase-tables.ts` before trusting it, because an
   * unverified Supabase seam is exactly how this codebase's dead features
   * happened.
   *
   * The whole catalogue is 4,254 rows and costs 0.18s to read from Tally, so
   * it is upserted wholesale rather than diffed. Keyed on
   * (company, item_name, price_level, effective_from) — a rate that has not
   * changed upserts onto itself, so re-running is free rather than duplicating.
   *
   * NEVER deletes. A price list is a history: a row missing from today's pull
   * means Tally no longer reports that revision, not that the price never
   * existed. Pruning it would silently rewrite what a backdated voucher is
   * priced at.
   */
  async syncPriceList(
    entries: Array<{
      itemName: string; priceLevel: string; priceLevelRaw: string;
      date: string; rate: number; unit: string; discountPct: number;
    }>,
    company: string,
    origin: string = "manual",
  ): Promise<void> {
    if (!this.client || !entries.length) return;
    const t0 = Date.now();

    /* BEFORE the upsert, and that ordering is the whole thing.
       The log records what THIS pull changed, which it can only know by
       comparing against what is stored right now. One line further down and
       the "before" side has already been overwritten with the "after" side,
       and the diff is silently empty on every pull for ever — a failure that
       looks exactly like "nothing ever changes". */
    await recordPricePull(this.client, company, entries, origin);
    const mapped = entries.map((e) => ({
      company,
      item_name: e.itemName,
      price_level: e.priceLevel,
      price_level_raw: e.priceLevelRaw,
      effective_from: e.date,
      rate: e.rate,
      unit: e.unit,
      discount_pct: e.discountPct,
      synced_at: new Date().toISOString(),
    }));
    await this.batchAndUpsertOn("tally_price_list", mapped, "company,item_name,price_level,effective_from");
    const items = new Set(entries.map((e) => e.itemName)).size;
    console.log(`[Supabase] ✓ Synced ${mapped.length} price-list entries (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    await this.bumpPriceListSignal(company, items);
  }

  /**
   * Tell the other devices the price list moved.
   *
   * ── Why this exists ───────────────────────────────────────────────────
   * The web app subscribes to `price_list_change_signal` and NOT to
   * `tally_price_list_imports` (MKCP MOB2 web-dashboard/src/App.tsx:478-497:
   * that table is outside the supabase_realtime publication and has no SELECT
   * policy, and granting one would expose the whole cost book). The signal is
   * a deliberately contentless row.
   *
   * Only ONE of the two writers was bumping it. `api/price-list.ts`'s POST —
   * the file-import path the owner has stopped using — upserts the row; this
   * agent's Tally pull writes `tally_price_list` directly and bumped nothing.
   * Measured 15-Sep-2026: the pull had just written 498 current rows / 488
   * items stamped 08:08 UTC with a matching `scope='price_list'` refresh
   * command marked done, while the signal still read 14-Sep 11:34. So the
   * live push worked only for the half of the system nobody uses, and a
   * second device open during a pull was never told to refetch. A display
   * that silently does nothing is this project's house failure mode.
   *
   * ── The shape is the import path's shape, on purpose (G1) ─────────────
   * Same table, same three columns, same `onConflict: "company"` upsert onto
   * the single per-company row. If the two writers diverged the web side
   * could not tell which produced a given row. `item_count` is the number of
   * DISTINCT ITEMS, matching what the import path's row count means there
   * (one current price per item) and what `/api/tally/sync-price-list`
   * already reports as `items` — not `mapped.length`, which for a pull is the
   * whole dated history (~4,254 revisions) and would make "488 prices
   * updated" read as 4,254.
   *
   * ── Non-fatal, and after the upserts ──────────────────────────────────
   * Exactly as the import path reasons: the prices are already committed by
   * the time this runs, so failing the sync over a missed notification would
   * report a failure that did not happen. The client's wake-on-return refetch
   * is the actual guarantee; this is the latency optimisation on top of it.
   *
   * NOT OBSERVED LIVE. This machine is MKCP_TALLY_ROLE=sandbox and may not
   * write to Supabase, so the bump itself has never been watched landing.
   * What is verified is the write shape, pinned in
   * server/scripts/test-price-list-signal.ts, and the live facts above
   * (read-only SQL): the table is a BASE TABLE keyed on `company`, holds
   * exactly one row, and IS in the supabase_realtime publication.
   */
  private async bumpPriceListSignal(company: string, itemCount: number): Promise<void> {
    if (!this.client) return;
    try {
      const { error } = await this.client
        .from("price_list_change_signal")
        .upsert(priceListSignalRow(company, itemCount), { onConflict: "company" });
      if (error) console.warn(`[Supabase] price-list change signal not sent: ${error.message}`);
      else console.log(`[Supabase] ✓ price-list change signal bumped (${itemCount} items)`);
    } catch (e: any) {
      console.warn(`[Supabase] price-list change signal not sent: ${e?.message ?? e}`);
    }
  }

  /**
   * Mirror Tally's dated GST rates, for items AND stock groups.
   *
   * Both scopes, because a rate resolves item-first then up the stock-group
   * tree: only 36 of 489 items declare their own, 453 inherit. Storing just
   * the item level loses the rate for 93% of the catalogue.
   *
   * ⚠ Also depends on migration 027. Same caveat as above.
   */
  async syncGstRates(
    rows: Array<{
      scope: "item" | "stock_group"; name: string; effectiveFrom: string;
      gstRate: number; cgst: number; sgst: number; igst: number;
      taxability: string; parent?: string;
    }>,
    company: string,
  ): Promise<void> {
    if (!this.client || !rows.length) return;
    const t0 = Date.now();
    const mapped = rows.map((r) => ({
      company,
      scope: r.scope,
      name: r.name,
      effective_from: r.effectiveFrom,
      gst_rate: r.gstRate,
      cgst_rate: r.cgst,
      sgst_rate: r.sgst,
      igst_rate: r.igst,
      taxability: r.taxability || null,
      parent: r.parent || null,
      synced_at: new Date().toISOString(),
    }));
    await this.batchAndUpsertOn("tally_gst_rates", mapped, "company,scope,name,effective_from");
    console.log(`[Supabase] ✓ Synced ${mapped.length} GST rate rows (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }

  /** batchAndUpsert, but with an explicit conflict target rather than `guid`. */
  private async batchAndUpsertOn(table: string, rows: any[], conflictCol: string): Promise<void> {
    if (!this.client || rows.length === 0) return;
    const BATCH_SIZE = 200;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      await this.upsertBatch(table, rows.slice(i, i + BATCH_SIZE), conflictCol);
    }
  }

  /**
   * Clear the cloud draft. Separated from {@link syncOrderDraftLines} because
   * an empty array used to mean "wipe everything", and that is far too
   * destructive a thing to express by omission — the desktop's draft store has
   * no writers, so every call was the empty one and the wipe was the ONLY
   * reachable branch. Clearing is now something a caller has to ask for.
   */
  async clearOrderDraftLines(company: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.from("order_draft_lines").delete().eq("company", company);
    } catch { /* swallow — clean-slate is best-effort */ }
  }

  async syncOrderDraftLines(lines: any[], company: string): Promise<void> {
    if (!this.client) return;
    if (!lines || lines.length === 0) {
      // Deliberately a no-op, NOT a wipe — see clearOrderDraftLines above.
      return;
    }

    const t0 = Date.now();
    try {
      const mapped = lines.map((l) => ({
        company,
        item_id: l.itemId,
        item_name: l.itemName,
        base_unit: l.baseUnit,
        pkg_unit: l.pkgUnit,
        units_per_pkg: l.unitsPerPkg,
        qty_base: l.qtyBase,
        rate_per_base: l.ratePerBase,
        updated_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
      }));

      // Upsert is safe under concurrent calls (idempotent per unique key).
      // Then delete rows whose item_id is no longer in the current draft.
      // This avoids the DELETE-then-INSERT race that caused duplicate-key errors
      // when two concurrent config syncs ran simultaneously.
      await this.upsertBatch("order_draft_lines", mapped, "company,item_id");
      const currentIds = mapped.map(r => r.item_id).filter(Boolean);
      if (currentIds.length > 0) {
        const { error } = await this.client
          .from("order_draft_lines")
          .delete()
          .eq("company", company)
          .not("item_id", "in", `(${currentIds.join(",")})`);
        if (error) console.warn(`[Supabase] order_draft_lines orphan delete: ${error.message}`);
      }
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[Supabase] ✓ Synced ${mapped.length} order draft lines (${elapsed}s)`);
    } catch (e: any) {
      console.error(`[Supabase] Order draft lines sync failed: ${e.message}`);
      throw e;
    }
  }

  async syncVoucherOverrides(overrides: Record<string, any>, company: string): Promise<void> {
    if (!this.client) return;
    if (!overrides || Object.keys(overrides).length === 0) return;

    const t0 = Date.now();
    try {
      const mapped = Object.entries(overrides).map(([voucherId, override]: [string, any]) => ({
        voucher_id: voucherId,
        company,
        status: override.status || null,
        scheduled_date: override.scheduledDate || null,
        notes: override.notes || null,
        follow_ups: override.followUps || [],
        updated_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
      }));

      const BATCH = 200;
      for (let i = 0; i < mapped.length; i += BATCH) {
        const batch = mapped.slice(i, i + BATCH);
        const { error } = await this.client.from("voucher_overrides").upsert(batch, {
          onConflict: "company,voucher_id",
        });
        if (error) throw new Error(error.message);
      }
      await this.deleteOrphans("voucher_overrides", company, "voucher_id", mapped.map(r => r.voucher_id));
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[Supabase] ✓ Synced ${mapped.length} voucher overrides (${elapsed}s)`);
    } catch (e: any) {
      console.error(`[Supabase] Voucher overrides sync failed: ${e.message}`);
      throw e;
    }
  }
}
