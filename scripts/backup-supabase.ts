/**
 * Take a local copy of every Supabase table worth keeping.
 *
 * Written because a schema change is about to happen and there is no other copy
 * of the config tables anywhere. The mirrored Tally tables can be rebuilt from
 * Tally; `discount_rules`, `order_groups`, `packing_group_rules`,
 * `unit_overrides` and the rest CANNOT — they exist only here, they were
 * entered by hand over months, and nothing regenerates them.
 *
 * Telemetry and caches are skipped by name: they are large, they are worthless
 * in a restore, and including them turns a 30-second backup into a long one.
 *
 *   npx tsx scripts/backup-supabase.ts [outDir]
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", "server", ".env") });

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_KEY;

if (!URL || !KEY) {
  console.error("SUPABASE_URL and a key must be set in server/.env");
  process.exit(1);
}

/** Large, regenerable, and useless in a restore. */
const SKIP = new Set([
  "perf_logs",              // 504k telemetry rows
  "weather_daily",          // orphaned, 30k rows, nothing reads it
  "tally_sync_history",     // 20k sync audit rows
  "tally_refresh_commands", // 1.5k command log
  "config_edit_log",        // 2k edit audit
]);

/**
 * Every table, in restore order — parents before children, so a restore that
 * replays this list top to bottom does not trip a foreign key.
 */
const TABLES = [
  // ── Config that exists NOWHERE else. These are the reason for the backup. ──
  "discount_rules", "discount_group_rules", "order_groups", "packing_group_rules",
  "unit_overrides", "item_category_overrides", "gst_overrides", "rate_overrides",
  "voucher_overrides", "vendor_group_assignments", "app_settings", "app_algo_settings",
  "pricing_tables", "pricing_table_rows", "stock_thresholds", "category_colors",
  "route_settings", "split_auto_settings", "user_nav_prefs", "circle_rates",

  // ── Working state ──
  "active_order_draft", "order_draft_lines", "sales_quotes", "split_invoice_drafts",
  "shipments", "warehouse_in_transit", "delivery_discrepancies",
  "purchase_captures", "purchase_capture_messages", "purchase_item_mappings",
  "file_transfers", "push_queue", "push_sync_log", "pending_push",
  "tally_push_commands", "price_list_change_signal", "item_notes",
  "calling_list_entries", "tally_price_list_imports",

  // ── Tally mirror (rebuildable from Tally, but a restore is faster than a resync) ──
  "tally_companies", "tally_units", "tally_godowns", "tally_cost_centres",
  "tally_stock_groups", "tally_stock_items", "tally_ledgers", "tally_price_lists",
  "tally_vouchers", "tally_voucher_ledger_entries", "tally_voucher_inventory_entries",

  // ── Compliance ──
  "compliance_entities", "compliance_obligation_types", "compliance_entity_obligations",
  "compliance_filing_periods", "compliance_documents", "compliance_activity_log",
  "compliance_ewaybills", "compliance_context_store", "compliance_portal_logins",
  "compliance_reminders", "compliance_labels", "compliance_label_links", "compliance_notes",

  // ── Salary ──
  "salary_companies", "salary_employees", "salary_holidays", "salary_attendance",
  "salary_runs", "salary_run_lines", "salary_neft_rows",
  "salary_bonus_settings", "salary_bonus_runs", "salary_bonus_lines", "salary_bonus_neft_rows",

  // ── Vault / outreach ──
  "vault_profiles", "vault_blocks", "vault_documents",
  "outreach_leads", "outreach_messages", "outreach_documents",
  "outreach_registry", "outreach_edits",

  // ── Misc live ──
  "companies", "sync_log", "user_profiles", "bill_allocations", "road_routes",
];

const sb = createClient(URL, KEY, { auth: { persistSession: false } });

/** Supabase caps a select at 1000 rows, so every table is paged. */
async function dump(table: string): Promise<unknown[] | null> {
  const rows: unknown[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select("*").range(from, from + PAGE - 1);
    if (error) return null;
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

async function main() {
  const outDir = process.argv[2] ?? join(here, "..", "..", "supabase-backup");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const dir = join(outDir, stamp);
  mkdirSync(dir, { recursive: true });

  const manifest: Record<string, number | string> = {};
  let total = 0;

  for (const table of TABLES) {
    if (SKIP.has(table)) continue;
    const rows = await dump(table);
    if (rows === null) {
      manifest[table] = "UNREADABLE";
      console.log(`  ${table.padEnd(38)} unreadable (RLS or missing)`);
      continue;
    }
    writeFileSync(join(dir, `${table}.json`), JSON.stringify(rows, null, 1), "utf8");
    manifest[table] = rows.length;
    total += rows.length;
    console.log(`  ${table.padEnd(38)} ${String(rows.length).padStart(6)}`);
  }

  writeFileSync(
    join(dir, "_manifest.json"),
    JSON.stringify({ takenAt: new Date().toISOString(), url: URL, skipped: [...SKIP], tables: manifest }, null, 2),
    "utf8",
  );

  console.log(`\n${total} rows across ${Object.keys(manifest).length} tables`);
  console.log(dir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
