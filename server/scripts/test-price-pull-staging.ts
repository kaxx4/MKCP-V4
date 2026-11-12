/**
 * F11, agent half (D-8-4.15, D-8-4.28, D-M.92, D-M.187), offline: a price pull is written to staging with who asked, and an
 * accepted pull is copied into the list. No Tally, no Supabase (a fake client). Fake item names only.
 *
 *   cd server; npx tsx scripts/test-price-pull-staging.ts
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  requesterFrom, mergeRequesters, stagedRates, stagingRow, writePull, entriesFromStaged, applyAccepted, originOf, holdModeOn, STAGING_TABLE,
} from "../src/services/pricePullStaging.js";
import type { PriceListEntry } from "../src/services/tallyPriceList.js";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
};
const U1 = "0b8f6c1e-1111-4222-8333-444444444444";
const U2 = "9a8f6c1e-aaaa-4bbb-8ccc-dddddddddddd";
const E = (name: string, rate: number, level = "dealer"): PriceListEntry =>
  ({ itemName: name, priceLevel: level, priceLevelRaw: level.toUpperCase(), date: "2026-11-01", rate, unit: "PC", discountPct: 2.5 });

(async () => {
console.log("who asked:");
ok("a uuid names a person (lower-cased)", requesterFrom(U1.toUpperCase()) === U1);
ok('the text "web", blank, null and junk name nobody', requesterFrom("web") === null && requesterFrom("") === null && requesterFrom(null) === null && requesterFrom("not-a-uuid") === null && requesterFrom(42) === null);
ok("coalesced commands from one person name that person", mergeRequesters([U1, U1.toUpperCase()]) === U1);
ok("two different people name nobody", mergeRequesters([U1, U2]) === null);
ok("any command that names nobody makes the pull anonymous (the Owner alone decides it)", mergeRequesters([U1, "web"]) === null && mergeRequesters([]) === null);

console.log("\nthe rows:");
{
  const rows = stagedRates([E("ZZ TEST ITEM A", 100), E("ZZ TEST ITEM B", 200, "retail"), E("ZZ TEST ITEM C", 300, "DEALER")]);
  ok("only the dealer level is staged, whatever its letter case", rows.map((r) => r.item_name).join() === "ZZ TEST ITEM A,ZZ TEST ITEM C");
  ok("each row keeps what the page reads (item, rate, unit, date)", rows[0].item_name === "ZZ TEST ITEM A" && rows[0].rate === 100 && rows[0].unit === "PC" && rows[0].effective_from === "2026-11-01");
  ok("and what the copy into the list needs (level, raw level, discount)", rows[0].price_level === "dealer" && rows[0].price_level_raw === "DEALER" && rows[0].discount_pct === 2.5);
  ok("a row with no item name or a rate that is not a number is left out", stagedRates([E("", 1), { ...E("ZZ TEST ITEM X", NaN) }]).length === 0);
  const back = entriesFromStaged(rows)!;
  ok("staged rows copy back into exactly the entries they came from", JSON.stringify(back) === JSON.stringify([E("ZZ TEST ITEM A", 100), E("ZZ TEST ITEM C", 300, "DEALER")].map((e, i) => ({ ...e, priceLevel: i === 0 ? "dealer" : "DEALER", priceLevelRaw: i === 0 ? "DEALER" : "DEALER" }))), JSON.stringify(back));
  ok("a staged list that cannot be read is null, never half", entriesFromStaged([{ item_name: "x" }]) === null && entriesFromStaged([]) === null && entriesFromStaged("nope") === null);
}

console.log("\nthe insert:");
{
  const entries = [E("ZZ TEST ITEM A", 100)];
  const manual = stagingRow({ company: "ZZ TEST CYCLES", entries, routeOrigin: "web-price-list", requestedBy: U1 })!;
  ok("a pull someone asked for is manual and carries that person", manual.origin === "manual" && manual.requested_by === U1 && manual.price_level === "DEALER");
  const daily = stagingRow({ company: "ZZ TEST CYCLES", entries, routeOrigin: "scheduled-price-gst-daily", requestedBy: U1 })!;
  ok("the scheduled daily pull is daily and never carries a person, even if one is passed", daily.origin === "daily" && daily.requested_by === null);
  const anon = stagingRow({ company: "ZZ TEST CYCLES", entries, routeOrigin: "web-price-list", requestedBy: "web" })!;
  ok('a pull whose requester is the text "web" names nobody', anon.requested_by === null);
  ok("a ZZ TEST company is marked as a test row; a real one is not", manual.is_test === true && stagingRow({ company: "A REAL NAME", entries, routeOrigin: "x" })!.is_test === false);
  ok("a pull with no dealer rows is not staged", stagingRow({ company: "ZZ TEST CYCLES", entries: [E("ZZ TEST ITEM A", 1, "retail")], routeOrigin: "x" }) === null);
  ok("the route's origin text maps to the table's two origins", originOf("scheduled-price-gst-daily") === "daily" && originOf("manual") === "manual" && originOf("web-price-list") === "manual");
  const seen: unknown[] = [];
  const good = { from: (t: string) => ({ insert: (row: unknown) => { seen.push([t, row]); return { select: async () => ({ data: [{ id: 41 }], error: null }) }; } }) };
  ok("one INSERT into the staging table, and its id comes back", (await writePull(good as never, manual)) === 41 && (seen[0] as unknown[])[0] === STAGING_TABLE && seen.length === 1);
  const bad = { from: () => ({ insert: () => ({ select: async () => ({ data: null, error: { message: "boom" } }) }) }) };
  let msg = ""; try { await writePull(bad as never, manual); } catch (e) { msg = (e as Error).message; }
  ok("a failed insert throws, so a pull is never reported staged that was not", /boom/.test(msg));
  const noId = { from: () => ({ insert: () => ({ select: async () => ({ data: [], error: null }) }) }) };
  let msg2 = ""; try { await writePull(noId as never, manual); } catch (e) { msg2 = (e as Error).message; }
  ok("an insert that returns no id throws", /no id/.test(msg2));
}

console.log("\nthe copy of an accepted pull:");
{
  const rates = stagedRates([E("ZZ TEST ITEM A", 100)]);
  const q = (rows: unknown[], error: { message: string } | null = null) => {
    const asked: string[] = [];
    const chain: any = { eq: (c: string, v: unknown) => { asked.push(`${c}=${v}`); return chain; }, order: () => chain, limit: async () => ({ data: rows, error }) };
    return { client: { from: () => ({ select: () => chain }) }, asked };
  };
  const applied: Array<[number, string, string]> = [];
  const apply = async (entries: PriceListEntry[], company: string, origin: string) => { applied.push([entries.length, company, origin]); };
  const a = q([{ id: 7, rates, pulled_at: "2026-11-12T00:00:00Z" }]);
  ok("the newest accepted pull is copied into the list once", (await applyAccepted({ client: a.client as never, company: "ZZ TEST CYCLES", lastAppliedId: 0, apply })) === 7 && applied.length === 1 && applied[0][2] === "accepted-pull");
  ok("it asks only for this company, the dealer level and accepted pulls", a.asked.join() === "company=ZZ TEST CYCLES,price_level=DEALER,status=accepted");
  ok("a pull already copied is not copied again", (await applyAccepted({ client: a.client as never, company: "ZZ TEST CYCLES", lastAppliedId: 7, apply })) === null && applied.length === 1);
  ok("nothing accepted: nothing copied", (await applyAccepted({ client: q([]).client as never, company: "ZZ TEST CYCLES", lastAppliedId: 0, apply })) === null);
  let m = ""; try { await applyAccepted({ client: q([{ id: 9, rates: [{ item_name: "x" }], pulled_at: "x" }]).client as never, company: "ZZ TEST CYCLES", lastAppliedId: 0, apply }); } catch (e) { m = (e as Error).message; }
  ok("an accepted pull that cannot be read throws and copies nothing", /cannot be read/.test(m) && applied.length === 1);
  let r = ""; try { await applyAccepted({ client: q([], { message: "down" }).client as never, company: "ZZ TEST CYCLES", lastAppliedId: 0, apply }); } catch (e) { r = (e as Error).message; }
  ok("a failed read throws", /down/.test(r));
}

console.log("\nhold mode and the wiring:");
{
  ok("hold mode is OFF unless MKCP_PRICE_PULL_HOLD is on (today's behaviour is the default)", !holdModeOn({} as NodeJS.ProcessEnv) && !holdModeOn({ MKCP_PRICE_PULL_HOLD: "no" } as NodeJS.ProcessEnv) && holdModeOn({ MKCP_PRICE_PULL_HOLD: " ON " } as NodeJS.ProcessEnv));
  const here = dirname(fileURLToPath(import.meta.url));
  const listener = readFileSync(join(here, "..", "src", "services", "refreshListener.ts"), "utf8");
  const index = readFileSync(join(here, "..", "src", "index.ts"), "utf8");
  ok("the listener carries each command's requester into the pull (realtime and catch-up)", /requested_by: \(payload\.new as any\)\.requested_by/.test(listener) && /requested_by: \(r as any\)\.requested_by/.test(listener) && /requestedBy: mergeRequesters\(b\.requesters\)/.test(listener) && /select\("id, days, scope, created_at, requested_by"\)/.test(listener));
  ok("the route stages the pull only in hold mode, and writes straight to the list otherwise", /if \(holdModeOn\(\)\)[\s\S]*stagePriceList[\s\S]*else \{\s*await supabaseSync\.syncPriceList\(entries, company, origin\)/.test(index));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
