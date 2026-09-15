/**
 * The stock-item GST block must carry its DATE and its STATE.
 *
 * PURE — replays the captured fixture through the mock transport. No live
 * Tally, no Supabase. (Guardrail P6: never fuzz the live XML port.)
 *
 * ── What broke ────────────────────────────────────────────────────────────
 *
 * `convertStockItems` kept only `statewisedetails > ratedetails` out of each
 * GSTDETAILS.LIST. Tally sends `APPLICABLEFROM` on every block and `STATENAME`
 * on every state block; both were fetched and silently dropped (guardrail G4).
 * The live mirror showed it exactly: 510 blocks, ZERO with a date, and the only
 * key on a block was `statewisedetails`.
 *
 * Without the date there is no defensible way to pick the current block —
 * `BABY CAR TRANSFORMERS` reads 18 / 18 / 0 with the stale zero LAST, and
 * `BABY SCOOTER HECTOR` has its blank FIRST. Taking the first is what built
 * `engine/purchase/data/itemMaster.json`, and it prices four items a full GST
 * slab too high.
 *
 * ── What is asserted ──────────────────────────────────────────────────────
 *
 *   1. Every block carries `applicablefrom`, as an ISO date.
 *   2. Every state block carries `statename`, with Tally's &#4; prefix gone.
 *   3. The web app's existing contract is UNCHANGED — `statewisedetails[]
 *      .ratedetails[]` with `gstratedutyhead` / `gstrate` still reads the same,
 *      because this change has to be additive or MKCP MOB2's
 *      `itemGstRatesFromDetails` breaks.
 *   4. The date actually resolves the ambiguous item: with dates present,
 *      BABY CAR TRANSFORMERS has one newest block and "first vs last" is no
 *      longer a coin flip.
 *
 *   npx tsx server/scripts/test-stock-item-gst.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

import { tallyPost } from "../src/tally.js";
import { FixtureStore, installMock, uninstallMock } from "../src/services/tallyMock.js";
import { convertStockItems, tallyIsoDate } from "../src/converters/convert.js";

let pass = 0, fail = 0;
const ok = (what: string, cond: boolean, detail = ""): void => {
  if (cond) { pass++; console.log(`  ok    ${what}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${what}${detail ? "  — " + detail : ""}`); }
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;

interface RateRow { gstratedutyhead: string; gstrate: string }
interface StateBlock { statename: string | null; ratedetails: RateRow[] }
interface GstBlock { applicablefrom: string | null; statewisedetails: StateBlock[] }

async function main(): Promise<void> {
  console.log("\n  STOCK-ITEM GST BLOCKS — date and state");
  console.log("  " + "─".repeat(66));

  // ── The pure helper, first ──────────────────────────────────────────────
  console.log("\n  tallyIsoDate");
  ok("Tally's compact form becomes an ISO date", tallyIsoDate("20250922") === "2025-09-22");
  ok("the boundary date bicycles moved on survives", tallyIsoDate("20170701") === "2017-07-01");
  ok("an empty value is null, not an epoch", tallyIsoDate("") === null);
  ok("a partial date is null rather than padded", tallyIsoDate("202509") === null);
  ok("an already-ISO value is refused rather than mangled", tallyIsoDate("2025-09-22") === null);
  ok("whitespace is tolerated (Tally pads numerics)", tallyIsoDate("  20220401 ") === "2022-04-01");

  // ── The real converter on the real captured response ────────────────────
  const store = new FixtureStore(join(here, "..", "fixtures"));
  const fx = store.get("MKCP_StockItem");
  if (!fx) {
    console.log("\n  No MKCP_StockItem fixture. Run: npx tsx server/scripts/capture-fixtures.ts\n");
    process.exit(1);
  }

  installMock(store.transport());
  const parsed = await tallyPost("http://mock", fx.requestXml, 30_000);
  uninstallMock();

  const items = convertStockItems(parsed).tallymessage as Array<{
    name: string; gstdetails: GstBlock[];
  }>;

  console.log("\n  The captured response (" + fx.capturedAt + ")");
  ok("the fixture really carries GST blocks (G7: empty is not proof)",
    items.length > 0 && items.some((i) => i.gstdetails.length > 0),
    `${items.length} items`);

  const blocks = items.flatMap((i) => i.gstdetails);
  const states = blocks.flatMap((b) => b.statewisedetails);

  // ── 1. The date ─────────────────────────────────────────────────────────
  console.log("\n  1. APPLICABLEFROM survives conversion");
  ok("every block has the key at all",
    blocks.every((b) => "applicablefrom" in b), `${blocks.length} blocks`);
  const dated = blocks.filter((b) => typeof b.applicablefrom === "string");
  ok("every block carries a date", dated.length === blocks.length,
    `${dated.length}/${blocks.length}`);
  ok("every date is ISO, not Tally's YYYYMMDD",
    dated.every((b) => ISO.test(b.applicablefrom as string)));
  const distinct = [...new Set(dated.map((b) => b.applicablefrom))].sort();
  ok("the dates are a real history, not one repeated value", distinct.length > 1,
    `${distinct.length} distinct: ${distinct[0]} … ${distinct[distinct.length - 1]}`);

  // ── 2. The state ────────────────────────────────────────────────────────
  console.log("\n  2. STATENAME survives conversion");
  ok("every state block has the key at all",
    states.every((s) => "statename" in s), `${states.length} state blocks`);
  ok("every state block is named", states.every((s) => !!s.statename));
  ok("Tally's &#4; sort prefix is stripped",
    states.every((s) => !/[\x00-\x1f]/.test(s.statename as string) && !/^&#/.test(s.statename as string)),
    JSON.stringify([...new Set(states.map((s) => s.statename))]));

  // ── 3. The web app's contract is untouched ──────────────────────────────
  console.log("\n  3. Additive — MKCP MOB2's itemGstRatesFromDetails still reads");
  ok("a state block still exposes ratedetails as an array",
    states.every((s) => Array.isArray(s.ratedetails)));
  const rows = states.flatMap((s) => s.ratedetails);
  ok("rate rows still carry gstratedutyhead and gstrate",
    rows.length > 0 && rows.every((r) => typeof r.gstratedutyhead === "string" && typeof r.gstrate === "string"),
    `${rows.length} rate rows`);
  ok("IGST is still present as its own duty head (it carries the FULL rate)",
    rows.some((r) => r.gstratedutyhead.toUpperCase() === "IGST"));
  ok("a block's keys are exactly the two we mean to store",
    blocks.every((b) => {
      const k = Object.keys(b).sort().join(",");
      return k === "applicablefrom,statewisedetails";
    }));

  // ── 4. The case that cost money ─────────────────────────────────────────
  console.log("\n  4. The ambiguous item is no longer ambiguous");
  const target = items.find((i) => i.name.toUpperCase().includes("BABY CAR TRANSFORMERS"));
  if (!target) {
    ok("BABY CAR TRANSFORMERS is in the fixture", false,
      "cannot assert the motivating case without it");
  } else {
    const igstOf = (b: GstBlock): number => {
      for (const s of b.statewisedetails) {
        for (const r of s.ratedetails) {
          if (r.gstratedutyhead.toUpperCase() === "IGST") return parseFloat(r.gstrate.trim()) || 0;
        }
      }
      return 0;
    };
    const seq = target.gstdetails.map((b) => `${b.applicablefrom}=${igstOf(b)}`);
    ok("it really has more than one block, disagreeing on the rate",
      new Set(target.gstdetails.map(igstOf)).size > 1, seq.join(" "));
    ok("every one of its blocks is dated", target.gstdetails.every((b) => !!b.applicablefrom));

    // The rule the web side can now apply: newest block not after a given date.
    const asOf = (d: string): number | null => {
      let best: GstBlock | null = null;
      for (const b of target.gstdetails) {
        if (!b.applicablefrom || b.applicablefrom > d) continue;
        if (!best || b.applicablefrom >= (best.applicablefrom as string)) best = b;
      }
      return best ? igstOf(best) : null;
    };
    const before = asOf("2025-09-21");
    const after = asOf("2026-09-15");
    ok("a voucher backdated before the change resolves to the old rate",
      before !== null && before > 0, `IGST ${before}`);
    ok("the rate in force today is a different, resolvable answer",
      after !== before, `then ${before} → now ${after}`);
    ok("resolution does not depend on block ORDER (the old, broken rule)",
      igstOf(target.gstdetails[0]) !== igstOf(target.gstdetails[target.gstdetails.length - 1]),
      "first and last disagree, so 'take the first' and 'take the last' cannot both be right");
  }

  console.log("\n  " + "─".repeat(66));
  console.log(`  ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
