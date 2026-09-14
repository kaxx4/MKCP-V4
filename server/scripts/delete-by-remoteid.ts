/**
 * Delete one voucher from Tally by the REMOTEID we gave it.
 *
 * ── Why this is separate from drain-one-queued ────────────────────────────
 *
 * That script finds a voucher by NUMBER, which is the only handle a person
 * has. For most types that works. It does not work for a Journal: this
 * company's Journal voucher type assigns no number, so Tally DISCARDS the one
 * we send and the voucher lands unnumbered — observed 14-Sep-2026, MASTERID
 * 249395, pushed as "MKCP-T-JRN" and stored with an empty VOUCHERNUMBER. All 98
 * journals in FY26-27 are unnumbered for the same reason.
 *
 * A voucher that cannot be found by number can still be REMOVED, because
 * Delete addresses the REMOTEID we assigned rather than anything Tally chose.
 * That is the whole argument for G5 — identity from creation — and this is what
 * it buys.
 *
 *   npx tsx server/scripts/delete-by-remoteid.ts "<remoteId>" "<voucherType>" "<YYYY-MM-DD>"
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { safePush } from "../src/services/safePush.js";
import type { VoucherPayload } from "../src/types.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";

/** Mirrors TEST_NUMBER_PREFIXES in the web app's domain/sandbox.ts. */
const TEST_PREFIXES = ["MKCP", "RPLY", "VERIFY", "SMOKE", "DEMO"];

async function main(): Promise<void> {
  const [remoteId, voucherType, date] = process.argv.slice(2);
  if (!remoteId || !voucherType || !date) {
    console.error('usage: delete-by-remoteid.ts "<remoteId>" "<voucherType>" "<YYYY-MM-DD>"');
    process.exit(2);
  }

  /* The same refusal the number-based script makes, applied to the id. Our
     remoteIds carry the marker, so a real voucher's id cannot be passed here
     by accident. */
  const marker = remoteId.split("|")[0]?.toUpperCase() ?? "";
  if (!TEST_PREFIXES.includes(marker)) {
    console.error(`\n  REFUSED. "${remoteId}" does not carry a test marker.\n` +
      `  This script only ever deletes ids beginning: ${TEST_PREFIXES.join("| , ")}|\n`);
    process.exit(2);
  }

  const payload = {
    voucherType, date, voucherNumber: "", remoteId,
    partyLedgerName: "", isInvoice: false, ledgerEntries: [],
    action: "Delete",
  } as unknown as VoucherPayload;

  console.log(`\n  DELETE ${voucherType} dated ${date}\n  remoteId: ${remoteId}`);
  const res = await safePush(TALLY, COMPANY, payload, { verify: false });
  console.log(`  → ok=${res.ok}${res.errors?.length ? ` errors=${res.errors.join(" · ")}` : ""}`);
  if (!res.ok) process.exit(1);
  console.log("  removed. Confirm with a read — this script does not verify for you.");
}

main().catch((e) => { console.error("\n  failed:", e instanceof Error ? e.message : e); process.exit(1); });
