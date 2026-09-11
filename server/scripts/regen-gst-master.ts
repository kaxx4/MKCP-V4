/**
 * Refresh the web app's GST rate master from Tally.
 *
 * `MKCP MOB2/web-dashboard/src/data/gstMasterRates.json` is a checked-in
 * snapshot of Tally's GST Rate Setup screen with NO import path anywhere
 * (src/engine/gstMaster.ts imports it directly). Updating a rate means editing
 * the file by hand and redeploying — one of the ten manual steps, and the one
 * that decides tax on every invoice the app prices.
 *
 * The agent can already resolve a rate for every item from Tally's own masters
 * (item rate first, then up the stock-group tree — see gstRateFor), so the file
 * can be generated instead of maintained.
 *
 * REPORTS BY DEFAULT, WRITES ONLY WHEN ASKED. These are tax rates: a silent
 * bulk rewrite of 479 of them is not something a script should do on its own.
 * Read the diff, then pass --write.
 *
 *   npx tsx scripts/regen-gst-master.ts           # show what would change
 *   npx tsx scripts/regen-gst-master.ts --write   # apply it
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters, gstRateFor } from "../src/services/tallyMasters.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const WRITE = process.argv.includes("--write");
const TARGET = resolve(
  process.env.WEB_DASHBOARD_DIR ??
    "C:/Users/kanis/Desktop/Code/MKCP/Live-Sync/MKCP MOB2/web-dashboard",
  "src/data/gstMasterRates.json",
);

/** The same normalisation gstMaster.ts applies, so both sides compare alike. */
const normalize = (name: string) =>
  name.trim().toUpperCase().replace(/\s+/g, " ").replace(/\s*([()\-+.,/&])\s*/g, "$1");

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  const masters = await loadMasters(U, company);

  const fresh: Record<string, number> = {};
  let unresolved = 0;
  for (const name of masters.items.keys()) {
    const { rate } = gstRateFor(masters, name);
    if (rate > 0) fresh[name] = rate;
    else unresolved++;
  }

  const current: Record<string, number> = JSON.parse(readFileSync(TARGET, "utf8"));

  // Compare on the NORMALISED key, because that is what the lookup uses — two
  // spellings that differ only in spacing are the same item to the app, and
  // diffing on raw keys would report phantom adds and drops.
  const idx = (o: Record<string, number>) => {
    const m = new Map<string, { name: string; rate: number }>();
    for (const [k, v] of Object.entries(o)) m.set(normalize(k), { name: k, rate: v });
    return m;
  };
  const a = idx(current);
  const b = idx(fresh);

  const changed: string[] = [];
  const added: string[] = [];
  const dropped: string[] = [];

  for (const [k, v] of b) {
    const old = a.get(k);
    if (!old) added.push(`${v.name}: ${v.rate}%`);
    else if (old.rate !== v.rate) changed.push(`${v.name}: ${old.rate}% -> ${v.rate}%`);
  }
  for (const [k, v] of a) if (!b.has(k)) dropped.push(`${v.name}: ${v.rate}%`);

  console.log(`\nGST master — Tally against the checked-in snapshot\n`);
  console.log(`company    "${company}"`);
  console.log(`Tally      ${Object.keys(fresh).length} items resolved${unresolved ? `, ${unresolved} with NO rate` : ""}`);
  console.log(`snapshot   ${Object.keys(current).length} items`);

  const show = (label: string, rows: string[], limit = 25) => {
    console.log(`\n${label}: ${rows.length}`);
    for (const r of rows.slice(0, limit)) console.log(`  ${r}`);
    if (rows.length > limit) console.log(`  … and ${rows.length - limit} more`);
  };
  show("RATE CHANGED", changed);
  show("in Tally, missing from the snapshot", added);
  // A drop is the one that needs a human: the item may have been renamed in
  // Tally, in which case removing it silently loses a real rate.
  show("in the snapshot, absent from Tally (renamed? deleted?)", dropped);

  if (!changed.length && !added.length && !dropped.length) {
    console.log(`\nThe snapshot is already current. Nothing to do.\n`);
    return;
  }

  if (!WRITE) {
    console.log(`\nNothing written. These are tax rates — read the diff above, then re-run with --write.\n`);
    return;
  }

  // Preserve any snapshot entry Tally no longer knows about rather than
  // dropping it: a renamed item would otherwise lose its rate and every
  // invoice for it would silently fall back to the 5% assumption.
  const merged: Record<string, number> = { ...fresh };
  for (const [k, v] of a) if (!b.has(k)) merged[v.name] = v.rate;

  const sorted = Object.fromEntries(Object.entries(merged).sort(([x], [y]) => x.localeCompare(y)));
  writeFileSync(TARGET, JSON.stringify(sorted, null, 2) + "\n", "utf8");
  console.log(`\nWrote ${Object.keys(sorted).length} rates to ${TARGET}`);
  console.log(`(${dropped.length} snapshot-only entr${dropped.length === 1 ? "y" : "ies"} kept, not dropped.)\n`);
})();
