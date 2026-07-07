import { createClient, SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";

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
    const url = process.env.SUPABASE_URL || "https://vmkytsytxlofjyeotmgb.supabase.co";
    const key = process.env.SUPABASE_SERVICE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZta3l0c3l0eGxvZmp5ZW90bWdiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODY0MjAyMCwiZXhwIjoyMDk0MjE4MDIwfQ.W-LfPU_GMCFafIWjHt0n5bs1oC08IX7IuXLj6TVY1BU";

    if (!url || !key) {
      console.warn("[Supabase] Missing Supabase credentials — sync disabled");
      this.client = null;
      return;
    }

    try {
      this.client = createClient(url, key, {
        auth: { persistSession: false },
        realtime: {
          params: {
            eventsPerSecond: 10,
          },
        },
      });
      console.log("[Supabase] Client initialized");
    } catch (err: any) {
      console.error(`[Supabase] Failed to initialize client: ${err.message}`);
      console.error(`[Supabase] WebSocket support: ${typeof WebSocket}`);
      this.client = null;
    }
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
      const priceLists = messages
        .filter((m) => m.metadata?.type === "Price List")
        .map((m) => this.mapPriceList(m, company))
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
        this.batchAndUpsert("tally_price_lists", priceLists),
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
        `[Supabase] ✓ Masters synced: ${groups.length} groups, ${units.length} units, ${godowns.length} godowns, ${costCentres.length} cost centres, ${items.length} items, ${ledgers.length} ledgers, ${priceLists.length} price lists (${elapsed}s)`
      );

      await this.logSyncHistory(company, "masters", t0, {
        groups: groups.length,
        units: units.length,
        godowns: godowns.length,
        costCentres: costCentres.length,
        items: items.length,
        ledgers: ledgers.length,
        priceLists: priceLists.length,
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

      // Batch vouchers in chunks of 200 (smaller than stock items due to JSONB payload)
      const BATCH_SIZE = 200;
      for (let i = 0; i < vouchers.length; i += BATCH_SIZE) {
        const batch = vouchers.slice(i, i + BATCH_SIZE);
        await this.upsertBatch("tally_vouchers", batch);
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
        // Empty days are pruned too (their stale rows have no matching pulled GUID).
        deleted = await this.deleteVoucherOrphansForDays(company, meta.pruneDays, Array.from(voucherGuids));
      } else if (meta?.pruneRange?.from && meta?.pruneRange?.to) {
        deleted = await this.deleteVoucherOrphansInRange(
          company,
          meta.pruneRange.from,
          meta.pruneRange.to,
          Array.from(voucherGuids)
        );
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
   * Uses an RPC (migration 017) so the GUID list ships in the POST body — a plain
   * .not("guid","in",...) DELETE would put hundreds of 36-char GUIDs in the URL
   * query string and overflow the length limit. Best-effort: a missing migration
   * or any error logs a warning and returns 0 (never throws, never over-deletes).
   */
  private async deleteVoucherOrphansInRange(
    company: string,
    from: string,
    to: string,
    validGuids: string[]
  ): Promise<number> {
    if (!this.client) return 0;
    const clean = (validGuids || []).filter((g): g is string => typeof g === "string" && g.length > 0);
    // Empty valid set is ambiguous (genuinely-empty range vs failed pull) — refuse
    // to delete-all-in-range. The early `vouchers.length === 0` return upstream
    // already guards this, but keep the belt-and-braces check here too.
    if (clean.length === 0) return 0;
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
        return 0;
      }
      const n = typeof data === "number" ? data : 0;
      if (n > 0) console.log(`[Supabase] ⌫ Removed ${n} voucher(s) deleted in Tally within ${from}–${to}`);
      return n;
    } catch (e: any) {
      console.warn(`[Supabase] Voucher range cleanup error: ${e?.message || e}`);
      return 0;
    }
  }

  /**
   * Delete vouchers on the given days whose GUID isn't in the just-pulled set.
   * One RPC for all days (migration 019). Each day must be one we pulled cleanly;
   * an empty pulled set for a day means that day is empty in Tally now, so its
   * stale rows are removed. Best-effort: a missing migration warns and returns 0.
   */
  private async deleteVoucherOrphansForDays(company: string, days: string[], validGuids: string[]): Promise<number> {
    if (!this.client) return 0;
    // Days arrive as YYYYMMDD (chunk dates) — convert to ISO to match the stored
    // tally_vouchers.date column (normalized to ISO above).
    const cleanDays = (days || [])
      .filter((d): d is string => typeof d === "string" && /^\d{8}$/.test(d))
      .map((d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);
    if (cleanDays.length === 0) return 0;
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
        return 0;
      }
      const n = typeof data === "number" ? data : 0;
      if (n > 0) console.log(`[Supabase] ⌫ Removed ${n} voucher(s) deleted in Tally across ${cleanDays.length} day(s)`);
      return n;
    } catch (e: any) {
      console.warn(`[Supabase] Per-day voucher prune error: ${e?.message || e}`);
      return 0;
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

  private safeGuid(raw: string | undefined, company: string, fallbackKey: string): string {
    const g = (raw || "").trim();
    return g || `${company}|${fallbackKey}`;
  }

  private mapCompany(m: any): any {
    return {
      name: m.name,
      synced_at: new Date().toISOString(),
    };
  }

  private mapStockGroup(m: any, company: string): any {
    if (!m.name) return null;
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
    return {
      guid: this.safeGuid(m.guid, company, m.name),
      company,
      name: m.name,
      parent: m.parent || "Unsorted",
      opening_balance: m.openingbalance,
      gstin: m.gstin,
      credit_period: m.creditperiod,
      synced_at: new Date().toISOString(),
    };
  }

  private mapPriceList(m: any, company: string): any {
    if (!m.name) return null;
    return {
      guid: this.safeGuid(m.guid, company, m.name),
      company,
      name: m.name,
      parent: m.parent || "PriceList",
      items: m.items || null,
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
      reference: m.reference ?? null,   // mirror Tally <REFERENCE> for push-agent reconciliation (see migration 012)
      is_cancelled: m.iscancelled === true,
      is_optional: m.isoptional === true,
      ledger_entries: ledgerArr.length > 0 ? ledgerArr : null,
      inventory_entries: inventoryArr.length > 0 ? inventoryArr : null,
      synced_at: new Date().toISOString(),
    };
  }

  // ── Sync configuration data (local-only stores) ────────────────────────────

  async syncDiscountRules(rules: any[], company: string): Promise<void> {
    if (!this.client) return;
    if (!rules || rules.length === 0) return;

    const t0 = Date.now();
    try {
      const mapped = rules.map((r, idx) => ({
        id: r.id || `rule_${company}_${idx}_${Date.now()}`,
        company,
        name: r.name || `Rule ${idx + 1}`,
        category: r.category,
        discount_type: r.discountType,
        discount_value: r.discountValue,
        conditions: r.conditions || {},
        priority: r.priority || idx,
        enabled: r.enabled !== false,
        synced_at: new Date().toISOString(),
      }));

      // discount_rules has PRIMARY KEY (id) — onConflict must match a unique constraint
      await this.upsertBatch("discount_rules", mapped, "id");
      await this.deleteOrphans("discount_rules", company, "id", mapped.map(r => r.id));
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[Supabase] ✓ Synced ${mapped.length} discount rules (${elapsed}s)`);
    } catch (e: any) {
      console.error(`[Supabase] Discount rules sync failed: ${e.message}`);
      throw e;
    }
  }

  async syncOrderGroups(groups: any[], company: string): Promise<void> {
    if (!this.client) return;
    if (!groups || groups.length === 0) return;

    const t0 = Date.now();
    try {
      const mapped = groups.map((g) => ({
        id: g.id,
        company,
        name: g.name,
        description: g.description || "",
        color: g.color || "#3b82f6",
        tags: g.tags || [],
        item_ids: g.itemIds || [],
        lines: g.lines || {},
        created_at: g.createdAt,
        updated_at: g.updatedAt,
        synced_at: new Date().toISOString(),
      }));

      // order_groups has PRIMARY KEY (id); batch to stay under REST payload limits
      const BATCH = 50; // smaller batch since `lines` JSONB can be large
      for (let i = 0; i < mapped.length; i += BATCH) {
        const batch = mapped.slice(i, i + BATCH);
        await this.upsertBatch("order_groups", batch, "id");
      }
      await this.deleteOrphans("order_groups", company, "id", mapped.map(r => r.id));
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[Supabase] ✓ Synced ${mapped.length} order groups (${elapsed}s)`);
    } catch (e: any) {
      console.error(`[Supabase] Order groups sync failed: ${e.message}`);
      throw e;
    }
  }

  async syncUnitOverrides(overrides: Record<string, any>, company: string): Promise<void> {
    if (!this.client) return;
    if (!overrides || Object.keys(overrides).length === 0) return;

    const t0 = Date.now();
    try {
      const mapped = Object.entries(overrides).map(([itemId, override]: [string, any]) => ({
        item_id: itemId,
        company,
        pkg_unit: override.pkgUnit,
        units_per_pkg: override.unitsPerPkg,
        source: override.source || "manual",
        confidence: override.confidence || 1,
        updated_at: override.updatedAt || new Date().toISOString(),
        synced_at: new Date().toISOString(),
      }));

      // unit_overrides has UNIQUE(company, item_id); SERIAL id is just for PK
      const BATCH = 200;
      for (let i = 0; i < mapped.length; i += BATCH) {
        const batch = mapped.slice(i, i + BATCH);
        await this.upsertBatch("unit_overrides", batch, "company,item_id");
      }
      await this.deleteOrphans("unit_overrides", company, "item_id", mapped.map(r => r.item_id));
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[Supabase] ✓ Synced ${mapped.length} unit overrides (${elapsed}s)`);
    } catch (e: any) {
      console.error(`[Supabase] Unit overrides sync failed: ${e.message}`);
      throw e;
    }
  }

  async syncGstOverrides(overrides: Record<string, any>, company: string): Promise<void> {
    if (!this.client) return;
    if (!overrides || Object.keys(overrides).length === 0) return;

    const t0 = Date.now();
    try {
      const mapped = Object.values(overrides).map((ov: any) => ({
        item_id: ov.itemId,
        company,
        gst_pct: ov.gstPct,
        updated_at: ov.updatedAt || new Date().toISOString(),
        synced_at: new Date().toISOString(),
      }));

      // gst_overrides has UNIQUE(company, item_id)
      const BATCH = 200;
      for (let i = 0; i < mapped.length; i += BATCH) {
        const batch = mapped.slice(i, i + BATCH);
        await this.upsertBatch("gst_overrides", batch, "company,item_id");
      }
      await this.deleteOrphans("gst_overrides", company, "item_id", mapped.map(r => r.item_id));
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[Supabase] ✓ Synced ${mapped.length} GST overrides (${elapsed}s)`);
    } catch (e: any) {
      console.error(`[Supabase] GST overrides sync failed: ${e.message}`);
      throw e;
    }
  }

  async syncRateOverrides(overrides: any[], company: string): Promise<void> {
    if (!this.client) return;
    if (!overrides || overrides.length === 0) return;

    const t0 = Date.now();
    try {
      const mapped = overrides.map((r) => ({
        item_id: r.itemId,
        company,
        unit_rate: r.unitRate,
        pkg_rate: r.pkgRate,
        updated_at: r.updatedAt || new Date().toISOString(),
        synced_at: new Date().toISOString(),
      }));

      // rate_overrides has UNIQUE(company, item_id)
      const BATCH = 200;
      for (let i = 0; i < mapped.length; i += BATCH) {
        const batch = mapped.slice(i, i + BATCH);
        await this.upsertBatch("rate_overrides", batch, "company,item_id");
      }
      await this.deleteOrphans("rate_overrides", company, "item_id", mapped.map(r => r.item_id));
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[Supabase] ✓ Synced ${mapped.length} rate overrides (${elapsed}s)`);
    } catch (e: any) {
      console.error(`[Supabase] Rate overrides sync failed: ${e.message}`);
      throw e;
    }
  }

  async syncItemCategoryOverrides(overrides: Record<string, string>, company: string): Promise<void> {
    if (!this.client) return;
    if (!overrides || Object.keys(overrides).length === 0) return;

    const t0 = Date.now();
    try {
      const mapped = Object.entries(overrides).map(([itemId, categoryId]) => ({
        item_id: itemId,
        company,
        category_id: categoryId,
        updated_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
      }));

      const BATCH = 200;
      for (let i = 0; i < mapped.length; i += BATCH) {
        const batch = mapped.slice(i, i + BATCH);
        const { error } = await this.client.from("item_category_overrides").upsert(batch, {
          onConflict: "company,item_id",
        });
        if (error) throw new Error(error.message);
      }
      await this.deleteOrphans("item_category_overrides", company, "item_id", mapped.map(r => r.item_id));
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[Supabase] ✓ Synced ${mapped.length} item category overrides (${elapsed}s)`);
    } catch (e: any) {
      console.error(`[Supabase] Item category overrides sync failed: ${e.message}`);
      throw e;
    }
  }

  async syncCategoryColors(colors: Record<string, string>, company: string): Promise<void> {
    if (!this.client) return;
    if (!colors || Object.keys(colors).length === 0) return;

    const t0 = Date.now();
    try {
      const mapped = Object.entries(colors).map(([categoryId, color]) => ({
        category_id: categoryId,
        company,
        color,
        updated_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
      }));

      const BATCH = 200;
      for (let i = 0; i < mapped.length; i += BATCH) {
        const batch = mapped.slice(i, i + BATCH);
        const { error } = await this.client.from("category_colors").upsert(batch, {
          onConflict: "company,category_id",
        });
        if (error) throw new Error(error.message);
      }
      await this.deleteOrphans("category_colors", company, "category_id", mapped.map(r => r.category_id));
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[Supabase] ✓ Synced ${mapped.length} category colors (${elapsed}s)`);
    } catch (e: any) {
      console.error(`[Supabase] Category colors sync failed: ${e.message}`);
      throw e;
    }
  }

  async syncVendorGroupAssignments(assignments: Record<string, string>, company: string): Promise<void> {
    if (!this.client) return;
    if (!assignments || Object.keys(assignments).length === 0) return;

    const t0 = Date.now();
    try {
      const mapped = Object.entries(assignments).map(([itemId, vendorGroupId]) => ({
        item_id: itemId,
        company,
        vendor_group_id: vendorGroupId,
        updated_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
      }));

      const BATCH = 200;
      for (let i = 0; i < mapped.length; i += BATCH) {
        const batch = mapped.slice(i, i + BATCH);
        const { error } = await this.client.from("vendor_group_assignments").upsert(batch, {
          onConflict: "company,item_id",
        });
        if (error) throw new Error(error.message);
      }
      await this.deleteOrphans("vendor_group_assignments", company, "item_id", mapped.map(r => r.item_id));
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[Supabase] ✓ Synced ${mapped.length} vendor group assignments (${elapsed}s)`);
    } catch (e: any) {
      console.error(`[Supabase] Vendor group assignments sync failed: ${e.message}`);
      throw e;
    }
  }

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

  async syncTallyPriceListImports(entries: Record<string, any>, importedAt: string | null, company: string): Promise<void> {
    if (!this.client) return;
    if (!entries || Object.keys(entries).length === 0) return;

    const t0 = Date.now();
    try {
      // Store keys by .toUpperCase() — normalize to prevent case-insensitive duplicates
      const mapped = Object.values(entries).map((e: any) => ({
        item_name: (e.itemName || "").toUpperCase(),
        company,
        selling_rate: e.sellingRate,
        cost_price: e.costPrice || null,
        unit: e.unit,
        imported_at: importedAt || new Date().toISOString(),
        synced_at: new Date().toISOString(),
      }));

      const BATCH = 200;
      for (let i = 0; i < mapped.length; i += BATCH) {
        const batch = mapped.slice(i, i + BATCH);
        const { error } = await this.client.from("tally_price_list_imports").upsert(batch, {
          onConflict: "company,item_name",
        });
        if (error) throw new Error(error.message);
      }
      await this.deleteOrphans("tally_price_list_imports", company, "item_name", mapped.map(r => r.item_name));
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[Supabase] ✓ Synced ${mapped.length} tally price list imports (${elapsed}s)`);
    } catch (e: any) {
      console.error(`[Supabase] Tally price list imports sync failed: ${e.message}`);
      throw e;
    }
  }

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

  async syncOrderDraftLines(lines: any[], company: string): Promise<void> {
    if (!this.client) return;
    if (!lines || lines.length === 0) {
      // If draft is empty, wipe any old rows so the cloud reflects local truth.
      try {
        await this.client.from("order_draft_lines").delete().eq("company", company);
      } catch { /* swallow — clean-slate is best-effort */ }
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
