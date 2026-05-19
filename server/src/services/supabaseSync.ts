import { createClient, SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";

// Polyfill WebSocket for Node.js 20 (Supabase needs it for realtime)
if (typeof globalThis !== 'undefined' && !globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
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
    }
  }

  async syncVouchers(messages: any[], company: string): Promise<void> {
    if (!this.client) return;
    if (!messages || messages.length === 0) return;

    const t0 = Date.now();
    const errors: string[] = [];

    try {
      const vouchers = messages
        .filter((m) => m.metadata?.type === "Voucher")
        .map((m) => this.mapVoucher(m, company))
        .filter(Boolean);

      if (vouchers.length === 0) return;

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
          await this.client
            .from("tally_voucher_ledger_entries")
            .delete()
            .in("voucher_guid", chunk)
            .eq("company", company);

          await this.client
            .from("tally_voucher_inventory_entries")
            .delete()
            .in("voucher_guid", chunk)
            .eq("company", company);
        }

        // Insert new entries in batches of 200
        if (ledgerEntries.length > 0) {
          await this.batchAndInsert("tally_voucher_ledger_entries", ledgerEntries);
        }
        if (inventoryEntries.length > 0) {
          await this.batchAndInsert("tally_voucher_inventory_entries", inventoryEntries);
        }
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `[Supabase] ✓ Vouchers synced: ${vouchers.length} vouchers, ${ledgerEntries.length} ledger entries, ${inventoryEntries.length} inventory entries (${elapsed}s)`
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
        errors.length === 0 ? null : errors
      );
    } catch (e: any) {
      const msg = `[Supabase] Vouchers sync error: ${e.message}`;
      console.error(msg);
      await this.logSyncHistory(company, "vouchers", t0, null, [msg], false);
    }
  }

  private async logSyncHistory(
    company: string,
    syncType: "masters" | "vouchers",
    startedAtMs: number,
    rowCounts: any,
    errors: string[] | null = null,
    success: boolean = !errors || errors.length === 0
  ): Promise<void> {
    if (!this.client) return;

    try {
      const startedAt = new Date(startedAtMs).toISOString();
      const completedAt = new Date().toISOString();

      await this.client.from("tally_sync_history").insert({
        company,
        sync_type: syncType,
        started_at: startedAt,
        completed_at: completedAt,
        row_counts: rowCounts,
        errors: errors,
        success,
      });
    } catch (e: any) {
      console.error(`[Supabase] Failed to log sync history: ${e.message}`);
    }
  }

  private async upsertBatch(
    table: string,
    rows: any[],
    conflictCol: string = "guid"
  ): Promise<void> {
    if (!this.client || rows.length === 0) return;

    try {
      const { error } = await this.client.from(table).upsert(rows, {
        onConflict: conflictCol,
      });
      if (error) {
        throw new Error(`${table}: ${error.message}`);
      }
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
        const { error } = await this.client.from(table).insert(batch);
        if (error) {
          throw new Error(`${table}: ${error.message}`);
        }
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

    return {
      guid: this.safeGuid(m.guid, company, fallbackKey),
      company,
      date: m.date,
      effective_date: m.effectivedate,
      voucher_number: m.vouchernumber,
      voucher_type: m.vouchertypename,
      party_ledger_name: m.partyledgername,
      narration: m.narration,
      is_cancelled: m.iscancelled === true,
      is_optional: m.isoptional === true,
      ledger_entries: m.allledgerentries || null,
      inventory_entries: m.allinventoryentries || null,
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
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[Supabase] ✓ Synced ${mapped.length} unit overrides (${elapsed}s)`);
    } catch (e: any) {
      console.error(`[Supabase] Unit overrides sync failed: ${e.message}`);
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
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[Supabase] ✓ Synced ${mapped.length} tally price list imports (${elapsed}s)`);
    } catch (e: any) {
      console.error(`[Supabase] Tally price list imports sync failed: ${e.message}`);
      throw e;
    }
  }
}
