/**
 * Do the eleven phantom-only master names exist in TALLY?
 *
 * The mirror holds 914 name-keyed master rows created before `hasRealGuid`
 * guarded the converters. 903 of them have a real-GUID twin, so deleting them
 * loses nothing — the name survives on the genuine row. Eleven do not, and for
 * those a prune would remove the NAME from the mirror entirely.
 *
 * Whether that matters depends on a question only Tally can answer: does the
 * name exist there? If it does, the phantom is a stale duplicate and the next
 * masters sync recreates it properly. If it does not, the name came from a
 * VOUCHER referencing a master that has since been renamed or deleted in
 * Tally — and deleting the row would leave those vouchers pointing at nothing.
 *
 * Read-only. Writes nothing to Tally or Supabase.
 *
 *   npx tsx scripts/check-phantom-names.ts
 */
import { tallyPost } from "../src/tally.js";
import { U, company, allFieldsXml, objects } from "./fidelity/harness.js";

const ITEMS = [
  "BABY WALKER S.H.  ( TIGER  )",
  "BICYCLE BRAVO 14T X 2.80",
  "BICYCLE BRAVO 16T X 2.125",
  "BICYCLE BRAVO 20T X 2.125",
  "BICYCLE FLY CARRIER 26T DD DAR",
  "BICYCLE SNOOPY 14T X 2.80",
  "BICYCLE SNOOPY 16T X 2.125",
];
const LEDGERS = [
  "AMRIT SALES ( INDIA )",
  "PRINTING & STATIONERY",
  "SHARES (INVESTMENT) (500 SHARES OF NSE)",
  "SK RABIUL ISLAM (NANDORAMPUR)",
];

const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, " ");

(async () => {
  const co = await company();

  const liveItems = new Set(
    objects(await tallyPost(U, allFieldsXml(co, "StockItem"), 180_000, true) as string, "STOCKITEM")
      .map((o) => norm(o.name)),
  );
  const liveLedgers = new Set(
    objects(await tallyPost(U, allFieldsXml(co, "Ledger"), 180_000, true) as string, "LEDGER")
      .map((o) => norm(o.name)),
  );

  console.log(`\ncompany        ${co}`);
  console.log(`live masters   ${liveItems.size} stock items, ${liveLedgers.size} ledgers\n`);

  let orphans = 0;
  console.log("  the eleven phantom-only names:\n");
  for (const [kind, names, live] of [
    ["stock item", ITEMS, liveItems],
    ["ledger", LEDGERS, liveLedgers],
  ] as const) {
    for (const n of names) {
      const known = live.has(norm(n));
      if (!known) orphans++;
      console.log(`  ${known ? "IN TALLY " : "ORPHAN   "} ${kind.padEnd(11)} ${n}`);
    }
  }

  console.log(`\n  ${11 - orphans} of 11 still exist in Tally — for those the phantom row is`);
  console.log(`  a stale duplicate and the next masters sync recreates it properly.`);
  if (orphans) {
    console.log(`\n  ${orphans} are ORPHANS: the name is referenced by vouchers in the mirror but`);
    console.log(`  no longer exists as a master in Tally. Deleting those rows removes the only`);
    console.log(`  record of the name. They are listed above and should be kept unless the`);
    console.log(`  owner confirms the master was deliberately removed.`);
  }
  console.log();
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
