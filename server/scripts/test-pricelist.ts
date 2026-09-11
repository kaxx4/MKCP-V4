/**
 * Does the price-list pull actually read Tally's catalogue correctly?
 *
 * Runs the real parser over the real response — no fixtures — and checks the
 * things that would otherwise fail silently: the case-folded price level, the
 * unit riding along with the rate, and "latest not after a date" meaning what
 * it says on a 4,255-entry history going back to 2003.
 *
 *   npx tsx scripts/test-pricelist.ts
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import {
  fetchPriceList, latestRates, rateFor, parseRate, normalizeLevel,
} from "../src/services/tallyPriceList.js";

const U = process.env.TALLY_URL || "http://localhost:9000";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  console.log(`\nPrice list from Tally\n\ncompany  "${company}"\n`);

  // ── The pure bits, first ────────────────────────────────────────────────
  console.log("parsing");
  check("splits a rate from its unit", parseRate("995.24/PC").rate === 995.24 && parseRate("995.24/PC").unit === "PC");
  check("survives a rate with no unit", parseRate("12.5").rate === 12.5 && parseRate("12.5").unit === "");
  check("strips thousands separators", parseRate("1,250.00/PC").rate === 1250);
  check("folds DEALER and Dealer together", normalizeLevel("Dealer") === normalizeLevel("DEALER"));

  // ── Against the live catalogue ──────────────────────────────────────────
  console.log("\npulling");
  const t0 = Date.now();
  const entries = await fetchPriceList(U, company);
  const secs = ((Date.now() - t0) / 1000).toFixed(2);
  check("returned a catalogue", entries.length > 1000, `${entries.length} dated entries in ${secs}s`);

  const items = new Set(entries.map((e) => e.itemName));
  check("covering most of the item master", items.size > 400, `${items.size} distinct items`);

  const rawLevels = new Set(entries.map((e) => e.priceLevelRaw));
  const foldedLevels = new Set(entries.map((e) => e.priceLevel));
  check("folding collapses the case-split price level", foldedLevels.size < rawLevels.size,
        `${rawLevels.size} raw [${[...rawLevels].join(", ")}] -> ${foldedLevels.size} folded [${[...foldedLevels].join(", ")}]`);

  check("every entry carries a real rate", entries.every((e) => e.rate > 0));
  check("every entry carries an ISO date", entries.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date)));
  const withUnit = entries.filter((e) => e.unit).length;
  check("rates are quoted in a unit", withUnit > entries.length * 0.9,
        `${withUnit} of ${entries.length} carry one`);

  // ── The history actually resolves ───────────────────────────────────────
  console.log("\nresolving");
  const today = latestRates(entries);
  check("one current rate per item+level", today.size > 0 && today.size <= entries.length,
        `${today.size} current rates from ${entries.length} dated entries`);

  // A rate asked for at an old date must differ from today's, or the "as at"
  // argument is doing nothing — which is exactly the sort of no-op this
  // codebase has shipped before.
  const long = [...items].find((n) => entries.filter((e) => e.itemName === n).length > 20);
  if (long) {
    const level = entries.find((e) => e.itemName === long)!.priceLevel;
    const now = rateFor(today, long, level);
    const then = rateFor(latestRates(entries, "2010-01-01"), long, level);
    check("an as-at date returns the rate in force THEN, not now",
          Boolean(now && then) && now!.rate !== then!.rate,
          `"${long}" ${level}: ${then?.date} ₹${then?.rate} -> ${now?.date} ₹${now?.rate}`);
    check("and never returns an entry dated after the as-at",
          !then || then.date <= "2010-01-01", `${then?.date}`);
  } else {
    check("found an item with enough history to test as-at", false, "none had >20 entries");
  }

  // Every current rate must be the newest for its key.
  const stale = [...today.values()].filter((e) =>
    entries.some((x) => x.itemName === e.itemName && x.priceLevel === e.priceLevel && x.date > e.date));
  check("no current rate is superseded by a later entry", stale.length === 0, `${stale.length} stale`);

  const sample = [...today.values()].slice(0, 3);
  console.log(`\nsample current rates`);
  for (const s of sample) console.log(`  ${s.date}  ${s.priceLevel.padEnd(8)} ₹${String(s.rate).padStart(10)}/${s.unit}  ${s.itemName}`);

  console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check(s) failed`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
