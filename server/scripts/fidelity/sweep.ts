/**
 * Find and remove everything the fidelity cases created.
 *
 * Sweeps by what is IN THE BOOKS, not by what a push reported. "ok:false" does
 * not mean "nothing was created", and a cleanup that only removes the successes
 * leaves the interesting failures behind for ever.
 *
 * It looks across a window of days rather than today alone, because a case that
 * files a voucher on the WRONG date — the exact defect being hunted — leaves it
 * on a day nobody thought to sweep.
 *
 *   npx tsx scripts/fidelity/sweep.ts            # list what is there
 *   npx tsx scripts/fidelity/sweep.ts --delete   # remove it
 */
import { tallyPost } from "../../src/tally.js";
import { pushVoucherToTally } from "../../src/services/voucherPusher.js";
import { loadMasters } from "../../src/services/tallyMasters.js";
import type { VoucherPayload } from "../../src/types.js";
import { U, MARK, company, vouchersOnDayXml, objects, fld, esc, importSummary, allFieldsXml, journal } from "./harness.js";

const DO = process.argv.includes("--delete");
const DAYS = 40;

const iso = (d: Date) => d.toISOString().slice(0, 10);

async function main(): Promise<void> {
  const co = await company();
  console.log(`\ncompany  ${co}`);
  console.log(`window   last ${DAYS} days + 20 ahead\n`);

  const found: { day: string; number: string; type: string; party: string }[] = [];
  for (let i = -20; i < DAYS; i++) {
    const day = iso(new Date(Date.now() - i * 864e5));
    const vs = objects((await tallyPost(U, vouchersOnDayXml(co, day), 180_000, true)) as string, "VOUCHER");
    for (const v of vs) {
      const num = fld(v.body, "VOUCHERNUMBER");
      const ref = fld(v.body, "REFERENCE");
      const narr = fld(v.body, "NARRATION");
      if (!`${num} ${ref} ${narr}`.includes(MARK)) continue;
      found.push({
        day,
        number: num || ref,
        type: fld(v.body, "VOUCHERTYPENAME"),
        party: fld(v.body, "PARTYLEDGERNAME"),
      });
    }
  }

  if (!found.length) {
    console.log("  nothing to sweep.\n");
  } else {
    for (const f of found) console.log(`  ${f.day}  ${f.type.padEnd(10)} ${f.number}`);
    console.log(`\n  ${found.length} test voucher(s).`);
    if (DO) {
      const masters = await loadMasters(U, co);
      for (const f of found) {
        /* Deleted through the PRODUCTION pusher, not hand-rolled XML.
           Two shapes were tried by hand first — REMOTEID alone, and REMOTEID
           with DATE + VOUCHERTYPENAME + VOUCHERNUMBER — and BOTH answered
           deleted=0 with no error, which is how five test purchases quietly
           accumulated. The pusher's own envelope works first time. Using it
           here also means the sweep exercises the delete path the app uses
           rather than a private imitation of it. */
        /* The JOURNAL decides the REMOTEID, not the voucher's current type.
           Reconstructing it from `f.type` is right only while a voucher is
           still the type it was created as. A Sales Order Note that has since
           been ALTERED into a Sales invoice — which case D does deliberately,
           every run — now reports its type as SALES, so the id rebuilt here
           was `MKCP-SALES-…` while the voucher answers only to
           `MKCP-SALES-ORDER-NOTE-…`. Three of them survived a --delete sweep
           that reported `deleted=0 errors=1` and moved on, and they are the
           leftovers that later made case D compare this run's order against
           the previous run's invoice.

           The journal exists for exactly this and was not being read. It is
           written at creation, before anything can alter the voucher, so it
           holds the id the voucher will answer to for the rest of its life.
           The reconstruction stays as the fallback for anything created
           before the journal existed. */
        /* The LAST entry for a number, not the first.
           Test numbers repeat across runs — the collision case deliberately
           reuses whatever `nextFreeNumber` hands it, so the same number is
           journalled by several runs under different ids. Taking the first
           match handed the sweep an id from a run days ago and it answered
           `deleted=0 errors=1` while the voucher sat there. The newest entry
           is the one that belongs to the voucher currently holding the
           number. */
        const hits = journal().filter((e) => e.number === f.number);
        const remembered = hits.length ? hits[hits.length - 1].remoteId : undefined;
        const res = await pushVoucherToTally(U, co, {
          remoteId: remembered ?? `MKCP-${f.type.toUpperCase().replace(/\s+/g, "-")}-${f.number}`,
          action: "Delete",
          voucherType: f.type,
          date: f.day,
          voucherNumber: f.number,
          partyLedgerName: f.party,
          isInvoice: false,
          ledgerEntries: [],
        } as unknown as VoucherPayload, masters);
        console.log(`  delete ${f.number}: deleted=${(res as unknown as { deleted?: number }).deleted ?? 0} errors=${res.errors}`);
      }
    } else {
      console.log("  (pass --delete to remove them)\n");
    }
  }

  // Test masters too.
  const led = objects((await tallyPost(U, allFieldsXml(co, "Ledger"), 180_000, true)) as string, "LEDGER")
    .filter((l) => l.name.startsWith(MARK));
  if (led.length) {
    console.log(`\n  ${led.length} test ledger(s): ${led.map((l) => l.name).join(", ")}`);
    if (DO) {
      for (const l of led) {
        const res = (await tallyPost(U,
          `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>All Masters</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC><DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${esc(l.name)}" ACTION="Delete"><NAME>${esc(l.name)}</NAME></LEDGER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`,
          60_000, true)) as string;
        console.log(`  delete ${l.name}: ${importSummary(res)}`);
      }
    }
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
