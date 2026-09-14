/**
 * Record what Tally really answers, once, so everything after can run offline.
 *
 * This is the only script in Phase 1 that needs TallyPrime. Everything it
 * writes into server/fixtures/ is then replayed by the mock, which is what the
 * edge-case catalogue and the parser fuzzer run against.
 *
 * Two rules it follows:
 *   · READS ONLY. No Import request is ever sent from here.
 *   · Voucher shapes are captured for ONE MONTH. A year-wide pull returns
 *     unpopulated placeholder entry lists, so a year fixture would bake in a
 *     shape that is technically real and analytically useless.
 *
 *   npx tsx server/scripts/capture-fixtures.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { buildCollectionXml } from "../src/services/xmlBuilder.js";
import { MASTER_COLLECTIONS, TRANSACTION_COLLECTIONS } from "../src/config/collections.js";
import { FixtureStore, type Fixture } from "../src/services/tallyMock.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";
const DIR = join(here, "..", "fixtures");

/**
 * Masters are captured whole; vouchers are captured for ONE DAY.
 *
 * Not to save time — a month took 8.3s. To keep the fixture committable:
 * September alone came back as **25.1 MB**, ~147 KB per voucher, because the
 * nested entry blocks dwarf the voucher header (measured: entry blocks are
 * ~64x the rest of the payload). A day carries every shape a month does —
 * sales, cash sales, receipts, journals, their entry and inventory lists —
 * at a size a repo can hold.
 *
 * The one shape a day CANNOT produce is the unpopulated placeholder entry
 * list that a year-wide pull returns. That is reproduced by the
 * `placeholder-lists` mutation instead, which is exactly what mutations are
 * for: shapes too expensive or too dangerous to capture live.
 */
const FROM = "20260910";
const TO = "20260910";

async function capture(store: FixtureStore, label: string, xml: string, timeout: number): Promise<void> {
  const id = xml.match(/<ID[^>]*>([^<]+)<\/ID>/i)?.[1]?.trim() ?? label;
  const t0 = Date.now();
  try {
    const body: string = await tallyPost(TALLY, xml, timeout, true); // rawMode — we want the bytes
    const ms = Date.now() - t0;
    const fx: Fixture = {
      id, label, capturedAt: new Date().toISOString(),
      requestXml: xml, responseXml: body, elapsedMs: ms,
    };
    store.save(fx);
    const kb = (Buffer.byteLength(body) / 1024).toFixed(0);
    console.log(`  ok    ${label.padEnd(28)} ${String(kb).padStart(6)} KB  ${String(ms).padStart(6)} ms  id="${id}"`);
  } catch (e: any) {
    console.log(`  FAIL  ${label.padEnd(28)} ${e.message}`);
  }
}

async function main(): Promise<void> {
  console.log("\n  CAPTURING TALLY FIXTURES\n  " + "─".repeat(70));
  console.log(`  company: ${COMPANY || "(default)"}   window: ${FROM}–${TO}\n`);

  const store = new FixtureStore(DIR);

  await capture(store, "health / companies", HEALTH_XML, 30_000);

  for (const def of MASTER_COLLECTIONS) {
    await capture(store, def.name, buildCollectionXml(def, COMPANY), def.timeout);
  }
  for (const def of TRANSACTION_COLLECTIONS) {
    await capture(store, def.name, buildCollectionXml(def, COMPANY, FROM, TO), def.timeout);
  }

  console.log("\n  " + "─".repeat(70));
  console.log(`  ${store.size} fixture(s) in server/fixtures/`);
  console.log(`  ids: ${store.ids().join(", ")}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
