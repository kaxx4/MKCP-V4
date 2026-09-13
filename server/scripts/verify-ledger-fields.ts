/**
 * Party state, address and contact — pulled, converted, stored, read back.
 *
 * These seven fields have been requested from Tally by `collections.ts` since
 * the beginning and dropped on the floor by `convertLedgers` every time. STATE
 * is the one that matters: it decides CGST+SGST against IGST on every outward
 * voucher, and `pushGuard`'s whole tax-head rule rests on it — while the mirror
 * the guard reads from did not have it.
 *
 * Runs the REAL path: fetch → convertLedgers → SupabaseSync.syncMasters.
 *
 *   npx tsx server/scripts/verify-ledger-fields.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { createClient } from "@supabase/supabase-js";
import { tallyPostWithRetry } from "../src/tally.js";
import { buildCollectionXml } from "../src/services/xmlBuilder.js";
import { convertLedgers } from "../src/converters/convert.js";
import { SEQUENTIAL_MASTERS } from "../src/config/collections.js";
import { SupabaseSync } from "../src/services/supabaseSync.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

let fails = 0;
const ok = (what: string, cond: boolean, detail = "") => {
  if (cond) console.log(`  ok    ${what}`);
  else { fails++; console.log(`  FAIL  ${what}${detail ? " — " + detail : ""}`); }
};

async function main(): Promise<void> {
  console.log("\n  LEDGER FIELDS, END TO END\n  " + "─".repeat(62));

  const def = SEQUENTIAL_MASTERS.find((d) => d.tallyCollection === "Ledger")!;
  const parsed = await tallyPostWithRetry(TALLY, buildCollectionXml(def, COMPANY), def.timeout, false, 1);
  const { tallymessage: ledgers } = convertLedgers(parsed);

  console.log(`\n  ${ledgers.length} ledgers converted.`);
  ok("ledgers were converted", ledgers.length > 0);

  const withState = ledgers.filter((l: { state?: string }) => !!l.state?.trim());
  const withPhone = ledgers.filter((l: { phone?: string }) => !!l.phone?.trim());
  const withGstin = ledgers.filter((l: { gstin?: string }) => !!l.gstin?.trim());
  const withAddr = ledgers.filter((l: { address?: string }) => !!l.address?.trim());

  console.log(`     state   ${String(withState.length).padStart(4)}`);
  console.log(`     gstin   ${String(withGstin.length).padStart(4)}`);
  console.log(`     phone   ${String(withPhone.length).padStart(4)}`);
  console.log(`     address ${String(withAddr.length).padStart(4)}`);

  // The measurement from the read verification: 399 of 482 carry a state.
  ok("STATE survives the converter — it never used to", withState.length > 300,
    `only ${withState.length} of ${ledgers.length}`);
  ok("contact details survive too", withPhone.length > 0 || withAddr.length > 0);

  const sample = withState.slice(0, 3) as { name: string; state: string; gstin: string; phone: string }[];
  for (const s of sample) {
    console.log(`     ${s.name.slice(0, 36).padEnd(36)} ${String(s.state).padEnd(16)} ${s.gstin || "—"}`);
  }

  /* ── A data finding, not a code failure ─────────────────────────────────
     The state should agree with the GSTIN's own state code, or the tax-head
     decision rests on two facts that disagree. 19 is West Bengal.

     Four parties in the live books disagree, and all four are TRANSPORTERS:
     HITECH LOGISTICS (09, UP), MODERN TRANSPORT (09, UP), SAURASHTRA ROADWAYS
     (27, Maharashtra) and RANDHAWA ROADWAYS (03, Punjab) are all recorded as
     West Bengal.

     Freight here is under reverse charge and those vouchers carry no GST at
     all, so the immediate filing risk is low. The master data is still wrong,
     and the guard would read it if one were ever billed normally. Reported
     rather than failed — it is the owner's data to correct, not a defect in
     this code. */
  const wb = withState.filter((l: { state?: string; gstin?: string }) =>
    (l.state ?? "").toLowerCase().includes("bengal") && !!l.gstin?.trim());
  const mismatched = wb.filter((l: { gstin?: string }) => !(l.gstin ?? "").startsWith("19"));
  if (mismatched.length) {
    console.log(`\n  ⚠ ${mismatched.length} part${mismatched.length === 1 ? "y" : "ies"} recorded in West Bengal with a GSTIN from elsewhere:`);
    for (const m of mismatched as { name: string; gstin: string }[]) {
      console.log(`     ${m.name.slice(0, 38).padEnd(40)} ${m.gstin}`);
    }
    console.log("     The tax head follows the state, so this would pick the wrong one — and");
    console.log("     the voucher would balance either way. Worth correcting in Tally.");
  } else {
    ok("state agrees with the GSTIN state code on every WB party", true);
  }

  // ── Landing ─────────────────────────────────────────────────────────────
  if (!SB_URL || !SB_KEY) {
    console.log("\n  (No Supabase credentials — skipping the landing check.)");
  } else {
    console.log("\n  Syncing via SupabaseSync.syncMasters…");
    await new SupabaseSync().syncMasters(
      [{ metadata: { type: "Company", name: COMPANY }, name: COMPANY, fystart: 4 }, ...ledgers],
      COMPANY,
    );

    const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
    const { count } = await sb
      .from("tally_ledgers").select("*", { count: "exact", head: true })
      .eq("company", COMPANY).not("state", "is", null);
    ok("state landed in tally_ledgers", (count ?? 0) > 300, `${count} rows with a state`);
    console.log(`        ${count} ledgers now carry a state in the mirror`);

    const { data } = await sb
      .from("tally_ledgers").select("name, state, gstin, phone, address")
      .eq("company", COMPANY).not("state", "is", null).limit(3);
    for (const d of data ?? []) {
      console.log(`        ${String(d.name).slice(0, 34).padEnd(34)} ${String(d.state).padEnd(14)} ${d.gstin || "—"}`);
    }
  }

  console.log("\n  " + "─".repeat(62));
  console.log(`  ${fails === 0 ? "The guard can now see the field it depends on." : fails + " check(s) failed."}\n`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
