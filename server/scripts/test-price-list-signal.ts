/**
 * The price-list change signal — one shape, two writers.
 *
 * PURE — no Supabase, no Tally. This machine is MKCP_TALLY_ROLE=sandbox and may
 * not write to Supabase, so the bump itself CANNOT be observed here. What this
 * pins is the write shape, which is the part that can silently diverge.
 *
 * ── What broke ────────────────────────────────────────────────────────────
 *
 * The web app subscribes to `price_list_change_signal` to know prices changed
 * (MKCP MOB2 web-dashboard/src/App.tsx:478-497). Two things write the price
 * list, and only one bumped the signal:
 *
 *   · `api/price-list.ts` POST — the FILE IMPORT path, which the owner has
 *     stopped using. Bumps it.
 *   · this agent's Tally pull → `SupabaseSync.syncPriceList` — the path
 *     actually in use. Did not.
 *
 * Measured 15-Sep-2026 with read-only SQL: the pull had just written 498
 * current rows / 488 distinct items stamped 08:08 UTC, with a matching
 * `tally_refresh_commands` row at `scope='price_list'`, `status='done'` — and
 * `price_list_change_signal` still read 14-Sep 11:34. A live push that only
 * fires for the half of the system nobody uses.
 *
 * ── What is asserted ──────────────────────────────────────────────────────
 *
 *   1. The row shape: exactly `company`, `updated_at`, `item_count` — the
 *      live table's three columns, `company` being its primary key.
 *   2. `updated_at` is an ISO timestamp the column will accept.
 *   3. `item_count` is the DISTINCT-ITEM count, so "488 prices updated" reads
 *      the same from either writer — not the dated-history row count (~4,254),
 *      which is what `tally_price_list` actually receives.
 *   4. G1: the sibling repo's import writer still uses the same columns and
 *      the same `onConflict: "company"`. Checked by reading its source when it
 *      is present; reported as UNCHECKED, never as passed, when it is not.
 *
 *   npx tsx server/scripts/test-price-list-signal.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { priceListSignalRow } from "../src/services/supabaseSync.js";

const here = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0, skipped = 0;
const ok = (what: string, cond: boolean, detail = ""): void => {
  if (cond) { pass++; console.log(`  ok    ${what}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${what}${detail ? "  — " + detail : ""}`); }
};
const unchecked = (what: string, why: string): void => {
  skipped++; console.log(`  ????  ${what}  — NOT CHECKED: ${why}`);
};

const COMPANY = "M.K.CYCLES (P) LTD. - (from 1-Apr-26)";

console.log("\n  PRICE-LIST CHANGE SIGNAL — the write shape");
console.log("  " + "─".repeat(66));

// ── 1. The row ────────────────────────────────────────────────────────────
console.log("\n  1. The row the pull path will upsert");
{
  const row = priceListSignalRow(COMPANY, 488, new Date("2026-09-15T08:08:00.000Z"));
  ok("columns are exactly the live table's three",
    Object.keys(row).sort().join(",") === "company,item_count,updated_at",
    Object.keys(row).join(", "));
  ok("company is the primary key value, carried verbatim", row.company === COMPANY);
  ok("item_count is the number passed, not a row count", row.item_count === 488);
  ok("updated_at is an ISO timestamptz", row.updated_at === "2026-09-15T08:08:00.000Z");
  ok("updated_at round-trips through Date without drift",
    new Date(row.updated_at).toISOString() === row.updated_at);
  ok("nothing extra leaks in — the signal is contentless by design",
    !("rate" in row) && !("cost_price" in row) && !("items" in row));
}

// ── 2. Defaults and edges ─────────────────────────────────────────────────
console.log("\n  2. Edges");
{
  const now = priceListSignalRow(COMPANY, 0);
  ok("a zero count still produces a valid row (an empty pull is still news)",
    now.item_count === 0 && typeof now.updated_at === "string");
  ok("the default timestamp is now, not a fixed constant",
    Math.abs(Date.now() - Date.parse(now.updated_at)) < 5_000);
}

// ── 3. item_count means DISTINCT ITEMS ────────────────────────────────────
console.log("\n  3. item_count means distinct items, not dated revisions");
{
  /* What `syncPriceList` receives is the whole dated history: the same item
     appears once per price level per effective date. Counting rows would make
     the toast say 4,254 where the import path says 488. */
  const entries = [
    { itemName: "BASKET KID", date: "2025-04-01" },
    { itemName: "BASKET KID", date: "2026-04-01" },
    { itemName: "BASKET KID", date: "2026-09-01" },
    { itemName: "RIM MOTOR CYCLE 18", date: "2026-04-01" },
  ];
  const items = new Set(entries.map((e) => e.itemName)).size;
  ok("four dated revisions across two items count as two",
    priceListSignalRow(COMPANY, items).item_count === 2, `rows ${entries.length} → items ${items}`);
}

// ── 4. G1: the other writer must still agree ──────────────────────────────
console.log("\n  4. The file-import writer in MKCP MOB2 still writes the same shape");
{
  const sibling = join(here, "..", "..", "..", "MKCP MOB2", "web-dashboard", "api", "price-list.ts");
  if (!existsSync(sibling)) {
    unchecked("import path columns match", `sibling repo not present at ${sibling}`);
  } else {
    const src = readFileSync(sibling, "utf8");
    const block = /from\("price_list_change_signal"\)[\s\S]{0,400}?\}\s*,?\s*\)/.exec(src)?.[0] ?? "";
    ok("the sibling still upserts price_list_change_signal", block.length > 0);
    for (const col of ["company", "updated_at", "item_count"]) {
      ok(`import path still writes ${col}`, new RegExp(`\\b${col}\\s*:`).test(block));
    }
    ok("import path still conflicts on company (one row per company)",
      /onConflict:\s*"company"/.test(block));
    ok("import path writes nothing this path does not",
      !/cost_price|rate\s*:/.test(block));
  }
}

console.log("\n  " + "─".repeat(66));
console.log(`  ${pass} passed, ${fail} failed, ${skipped} not checked`);
console.log("  NOTE: the live bump is UNOBSERVED — sandbox role may not write to Supabase.\n");
process.exit(fail === 0 ? 0 : 1);
