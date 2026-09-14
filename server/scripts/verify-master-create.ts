/**
 * Phase 3.3 — inline party creation, and the trap it has to survive.
 *
 * The Phase 3 gate: "a party created inline is usable in the same order."
 *
 * Two things are proven here and neither is obvious:
 *
 *  1. **Nested wins, flat lies.** Sent as flat fields, LEDSTATENAME and GSTIN
 *     are ACCEPTED — Tally answers CREATED=1 — and read back EMPTY. Both
 *     shapes are pushed here so the difference is measured rather than
 *     asserted. It matters because a party with no state produces vouchers
 *     that balance, verify, read back byte-identical, and still land in a GSTR
 *     exception bucket.
 *
 *  2. **The party is usable IMMEDIATELY.** The master cache has a ten-minute
 *     TTL and the push guard reads it, so without invalidation a party created
 *     at 10:02 is refused until 10:12 — inside the busiest hour of the day.
 *
 * Everything it creates is prefixed ZZVERIFY and deleted afterwards.
 *
 *   npx tsx server/scripts/verify-master-create.ts --push
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { createLedger, deleteLedger, buildLedgerXml } from "../src/services/masterPusher.js";
import { loadMasters } from "../src/services/tallyMasters.js";
import { blocksOf } from "../src/services/tallyRequest.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const PUSH = process.argv.includes("--push");
const STAMP = Date.now().toString().slice(-6);
const NESTED = `ZZVERIFY NESTED ${STAMP}`;
const FLAT = `ZZVERIFY FLAT ${STAMP}`;

let pass = 0, fail = 0;
const ok = (what: string, cond: boolean, detail = "") => {
  if (cond) { console.log(`  ok    ${what}${detail ? "  — " + detail : ""}`); pass++; }
  else { console.log(`  FAIL  ${what}${detail ? "  — " + detail : ""}`); fail++; }
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The WRONG shape, pushed on purpose so the trap is measured, not assumed. */
function flatEnvelope(company: string, name: string): string {
  return `<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY><IMPORTDATA>
    <REQUESTDESC><REPORTNAME>All Masters</REPORTNAME>
      <STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
    </REQUESTDESC>
    <REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
      <LEDGER NAME="${esc(name)}" ACTION="Create">
        <NAME>${esc(name)}</NAME>
        <PARENT>SUNDRY DEBTORS</PARENT>
        <ISBILLWISEON>Yes</ISBILLWISEON>
        <LEDSTATENAME>West Bengal</LEDSTATENAME>
        <GSTIN>19AAAAA0000A1Z5</GSTIN>
        <COUNTRYNAME>India</COUNTRYNAME>
      </LEDGER>
    </TALLYMESSAGE></REQUESTDATA>
  </IMPORTDATA></BODY>
</ENVELOPE>`;
}

async function readState(company: string, name: string): Promise<{ found: boolean; state: string; gstin: string }> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>VmcRead</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="VmcRead" ISMODIFY="No"><TYPE>Ledger</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>LedStateName</NATIVEMETHOD>
<NATIVEMETHOD>GSTIN</NATIVEMETHOD><NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD>
<FILTER>VmcF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="VmcF">$Name = "${esc(name)}"</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw: string = await tallyPost(TALLY, xml, 30_000, true);
  const f = (t: string) => (new RegExp(`<${t}[^>]*>([^<]*)</${t}>`, "i").exec(raw)?.[1] ?? "").replace(/&#4;\s*/g, "").trim();
  /* blocksOf, not a bare regex. CMPINFO carries <LEDGER>205</LEDGER> as a COUNT,
     so /<LEDGER[\s>]/ matches an empty collection and reports the party as still
     present — which is how this check claimed the books were dirty after a clean
     delete. It is the exact trap the edge-case catalogue already covers, walked
     into anyway. */
  return { found: blocksOf(raw, "LEDGER").length > 0, state: f("LEDSTATENAME"), gstin: f("GSTIN") || f("PARTYGSTIN") };
}

async function main(): Promise<void> {
  console.log("\n  INLINE PARTY CREATION\n  " + "─".repeat(66));

  // ── Shape checks need no Tally at all ───────────────────────────────────
  console.log("\n  1. The XML shape");
  const shape = buildLedgerXml({ name: "X", parent: "SUNDRY DEBTORS", state: "West Bengal", gstin: "19AAAAA0000A1Z5" });
  ok("state is inside LEDMAILINGDETAILS.LIST",
    /<LEDMAILINGDETAILS\.LIST>[\s\S]*<STATE>West Bengal<\/STATE>[\s\S]*<\/LEDMAILINGDETAILS\.LIST>/.test(shape));
  ok("GSTIN is inside LEDGSTREGDETAILS.LIST",
    /<LEDGSTREGDETAILS\.LIST>[\s\S]*<GSTIN>[\s\S]*<\/LEDGSTREGDETAILS\.LIST>/.test(shape));
  ok("no flat LEDSTATENAME is emitted", !/<LEDSTATENAME>/i.test(shape),
    "the flat field is accepted and silently dropped");
  ok("the GST registration carries a date",
    /<LEDGSTREGDETAILS\.LIST>[\s\S]*<APPLICABLEFROM>/.test(shape),
    "registration is DATED — a backdated voucher needs one in force then");

  const noGstin = buildLedgerXml({ name: "X", parent: "SUNDRY DEBTORS", state: "West Bengal" });
  ok("a party with no GSTIN is stated as Unregistered, not left blank",
    /<GSTREGISTRATIONTYPE>Unregistered<\/GSTREGISTRATIONTYPE>/.test(noGstin),
    "omitting the block is indistinguishable from forgetting it");

  const stateless = await createLedger(TALLY, "irrelevant", { name: "X", parent: "SUNDRY DEBTORS", state: "" });
  ok("a party with NO state is refused before anything is sent", !stateless.ok && stateless.requestXml === "");

  if (!PUSH) {
    console.log("\n  Pass --push to create real masters in Tally (removed afterwards).\n");
    process.exit(fail === 0 ? 0 : 1);
  }

  const company = convertCompanies(await tallyPost(TALLY, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  console.log(`\n  company: ${company}`);

  let madeNested = false, madeFlat = false;
  try {
    // ── 2. The flat shape, pushed on purpose ──────────────────────────────
    console.log("\n  2. The trap, measured — flat fields");
    const flatRaw: string = await tallyPost(TALLY, flatEnvelope(company, FLAT), 60_000, true);
    const flatCreated = /<CREATED>\s*1/.test(flatRaw);
    madeFlat = flatCreated;
    ok("Tally ACCEPTS the flat shape and reports CREATED=1", flatCreated,
      "which is exactly why this is dangerous");

    if (flatCreated) {
      const back = await readState(company, FLAT);
      console.log(`     read back: state="${back.state}" gstin="${back.gstin}"`);
      ok("…and the state reads back EMPTY", back.state === "",
        "a party that reports success and cannot be invoiced correctly");
    }

    // ── 3. The nested shape, through the service ──────────────────────────
    console.log("\n  3. The service — nested, with a read-back");
    const res = await createLedger(TALLY, company, {
      name: NESTED, parent: "SUNDRY DEBTORS", state: "West Bengal",
      gstin: "19AAAAA0000A1Z5", pincode: "700001", address: "Verify Street",
      phone: "9800000000", creditPeriod: "20 Days",
    });
    madeNested = res.created > 0;
    for (const n of res.notes) console.log(`     ${n}`);
    ok("created and verified usable", res.ok);
    ok("the state really stuck", !!res.readBack?.state, res.readBack?.state ?? "(empty)");
    ok("the GSTIN really stuck", !!res.readBack?.gstin, res.readBack?.gstin ?? "(empty)");

    // ── 4. Usable in the same order ───────────────────────────────────────
    console.log("\n  4. Usable IMMEDIATELY — the ten-minute cache");
    const masters = await loadMasters(TALLY, company);
    const found = masters.ledgers.get(NESTED.toUpperCase()) ?? [...masters.ledgers.values()].find((l) => l.name === NESTED);
    ok("THE NEW PARTY IS IN THE MASTER CACHE AT ONCE — this is the gate", !!found,
      found ? `state ${found.state}` : "the cache was not invalidated; the push guard would refuse this party for 10 minutes");
    ok("and it carries the state the guard needs", !!found?.state, found?.state ?? "");

  } finally {
    console.log("\n  5. Removing the test masters");
    if (madeNested) {
      const d = await deleteLedger(TALLY, company!, NESTED);
      ok("nested test party deleted", d.ok, d.notes[0] ?? "deleted");
    }
    if (madeFlat) {
      const d = await deleteLedger(TALLY, company!, FLAT);
      ok("flat test party deleted", d.ok, d.notes[0] ?? "deleted");
    }
    const leftN = await readState(company!, NESTED);
    const leftF = await readState(company!, FLAT);
    ok("the books are left clean", !leftN.found && !leftF.found);
  }

  console.log("\n  " + "─".repeat(66));
  console.log(`  ${pass} passed · ${fail} failed`);
  console.log(fail === 0 ? "  A party created inline is usable in the same order.\n" : "  The gate is NOT met.\n");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
