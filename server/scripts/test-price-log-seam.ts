/**
 * The whole loop against real Supabase: prices in, pull logged, changes read back.
 *
 * ── Why this does NOT run a real Tally price pull ─────────────────────────
 * This machine has a BACKUP company open in Tally, and it shares its NAME with
 * production. `syncPriceList` upserts on (company, item, level, date), so a
 * pull from here would write the backup's rates straight onto the real price
 * list under the same company key — silently, with no delete involved and
 * nothing to undo it from. So the diff and the writes are exercised against a
 * company name nothing else uses, and everything is removed afterwards.
 *
 * Run: npx tsx scripts/test-price-log-seam.ts
 */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import { recordPricePull, type PriceEntry } from "../src/services/priceChangeLog.js";

const env: Record<string, string> = {};
for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const KEY = process.env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_KEY;
const CO = "ZZTEST PRICE LOG CO";

const e = (itemName: string, date: string, rate: number): PriceEntry =>
  ({ itemName, priceLevel: "DEALER", date, rate });

let pass = 0, fail = 0;
function is(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
}

(async () => {
  if (!KEY) { console.log("  no service key on this machine — cannot test the Supabase half"); return; }
  const sb = createClient(
    env.SUPABASE_URL || env.VITE_SUPABASE_URL || "https://vmkytsytxlofjyeotmgb.supabase.co",
    KEY, { auth: { persistSession: false } },
  );

  const cleanup = async () => {
    const { data } = await sb.from("tally_price_pulls").select("id").eq("company", CO);
    for (const p of data ?? []) await sb.from("tally_price_changes").delete().eq("pull_id", p.id);
    await sb.from("tally_price_pulls").delete().eq("company", CO);
    await sb.from("tally_price_list").delete().eq("company", CO);
  };
  await cleanup();

  const priceRows = (entries: PriceEntry[]) => entries.map((x) => ({
    company: CO, item_name: x.itemName, price_level: x.priceLevel,
    price_level_raw: x.priceLevel, effective_from: x.date, rate: x.rate,
    unit: "PCS", discount_pct: 0, synced_at: new Date().toISOString(),
  }));

  // ── pull 1: nothing stored yet ──────────────────────────────────────────
  const first = [e("CHAIN", "2025-04-01", 100), e("TYRE", "2025-04-01", 200)];
  const r1 = await recordPricePull(sb, CO, first, "seam-test");
  await sb.from("tally_price_list").upsert(priceRows(first), { onConflict: "company,item_name,price_level,effective_from" });

  const { data: p1 } = await sb.from("tally_price_pulls").select("*").eq("id", r1.pullId!).single();
  is("first pull is flagged as the baseline", p1.is_first_pull, true);
  is("first pull writes NO change rows", r1.changes, 0);
  is("it still records what it saw", [p1.row_count, p1.item_count], [2, 2]);

  // ── pull 2: one rate moved, one re-stamped, one new ──────────────────────
  const second = [
    e("CHAIN", "2026-04-01", 130),      // moved 100 → 130
    e("TYRE", "2026-04-01", 200),       // re-stamped at the SAME rate
    e("BRAKE SHOE", "2026-04-01", 75),  // new item
  ];
  const r2 = await recordPricePull(sb, CO, second, "seam-test");
  await sb.from("tally_price_list").upsert(priceRows(second), { onConflict: "company,item_name,price_level,effective_from" });

  const { data: p2 } = await sb.from("tally_price_pulls").select("*").eq("id", r2.pullId!).single();
  is("counts one change and one addition", [p2.changed_count, p2.added_count], [1, 1]);
  is("the re-stamp is not counted", r2.changes, 2);

  const { data: ch } = await sb.from("tally_price_changes").select("*").eq("pull_id", r2.pullId!).order("item_name");
  is("names the items that actually moved", (ch ?? []).map((c: any) => c.item_name), ["BRAKE SHOE", "CHAIN"]);
  const chain = (ch ?? []).find((c: any) => c.item_name === "CHAIN");
  is("carries the old and new rate", [Number(chain.old_rate), Number(chain.new_rate)], [100, 130]);
  is("carries Tally's effective date, not the pull date", chain.effective_from, "2026-04-01");

  // ── pull 3: the same data again ─────────────────────────────────────────
  const r3 = await recordPricePull(sb, CO, second, "seam-test");
  const { data: p3 } = await sb.from("tally_price_pulls").select("*").eq("id", r3.pullId!).single();
  is("re-pulling the same data records a pull with nothing in it", [p3.changed_count, p3.added_count], [0, 0]);

  /* The objection engine/priceChanges.ts raised against this whole design:
     "a second pull of the same data reports nothing changed and DESTROYS the
     first answer". It does not — pull 2's list is still there. */
  const { count } = await sb.from("tally_price_changes")
    .select("*", { count: "exact", head: true }).eq("pull_id", r2.pullId!);
  is("and pull 2's list survives it", count, 2);

  const { data: log } = await sb.from("tally_price_pulls")
    .select("id").eq("company", CO).order("pulled_at", { ascending: false });
  is("three pulls in the log", (log ?? []).length, 3);

  if (!process.argv.includes("--keep")) { await cleanup(); console.log("\n  cleaned up"); }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (fail) process.exitCode = 1;
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
