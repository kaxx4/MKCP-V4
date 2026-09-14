/**
 * EXPLORATION 6 — can masters be created over XML?
 *
 * This decides whether the dashboard can create a customer mid-invoice or has to
 * dead-end with "party does not exist". The push guard refuses unknown names by
 * design, and the master cache has a ten-minute TTL, so today a party created in
 * Tally at 10:02 is unusable until 10:12 — squarely inside the busiest hour.
 *
 * Creates one ledger, one stock item and one godown, reads each back, then
 * removes them. Master names are prefixed so anything left behind is obvious.
 *
 *   npx tsx scripts/explore-master-create.ts --push
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters } from "../src/services/tallyMasters.js";
import { withTally } from "../src/services/tallyGate.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const PUSH = process.argv.includes("--push");
const TAG = `ZZPROBE${Date.now().toString().slice(-5)}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let pass = 0, fail = 0;
const ok = (n: string, good: boolean, d = "") => {
  console.log(`  ${good ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${n}${d ? ` — ${d}` : ""}`);
  good ? pass++ : fail++;
};

async function healthy() {
  try { return convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 8_000)).length > 0; }
  catch { return false; }
}

/** Masters import through the same envelope as vouchers, with REPORTNAME "All Masters". */
function masterXml(company: string, body: string, action: "Create" | "Alter" | "Delete" = "Create"): string {
  return `<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY><IMPORTDATA>
    <REQUESTDESC><REPORTNAME>All Masters</REPORTNAME>
      <STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
    </REQUESTDESC>
    <REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${body}</TALLYMESSAGE></REQUESTDATA>
  </IMPORTDATA></BODY>
</ENVELOPE>`;
}

const counts = (raw: string) => ["CREATED", "ALTERED", "DELETED", "ERRORS", "EXCEPTIONS"]
  .map(t => `${t}=${(new RegExp(`<${t}>\\s*(\\d+)`).exec(raw) ?? [])[1] ?? "?"}`).join(" ");

async function send(company: string, body: string, label: string): Promise<string> {
  const raw = await withTally(TALLY_URL, label, () => tallyPost(TALLY_URL, masterXml(company, body), 60_000, true) as Promise<string>);
  return raw;
}

async function main() {
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  console.log(`company "${company}"`);
  if (!PUSH) { console.log("\nPass --push to run. Creates three masters, then removes them."); return; }

  const LEDGER = `${TAG} LEDGER`;
  const ITEM = `${TAG} ITEM`;
  const GODOWN = `${TAG} GODOWN`;

  // ── Ledger ────────────────────────────────────────────────────────────────
  console.log("\n1. Create a customer ledger with full GST identity");
  const ledBody = `
    <LEDGER NAME="${esc(LEDGER)}" ACTION="Create">
      <NAME>${esc(LEDGER)}</NAME>
      <PARENT>SUNDRY DEBTORS (EG)</PARENT>
      <ISBILLWISEON>Yes</ISBILLWISEON>
      <LEDGERMOBILE>9800000000</LEDGERMOBILE>
      <BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD>
      <LEDGERCONTACT>Probe Contact</LEDGERCONTACT>
      <!-- State and GST identity live in the nested blocks, not as flat fields.
           Sent flat, LEDSTATENAME is accepted (CREATED=1) and then reads back
           EMPTY — which would leave the party unusable, since the push guard
           needs a state to decide CGST+SGST against IGST. -->
      <LEDMAILINGDETAILS.LIST>
        <APPLICABLEFROM>20260401</APPLICABLEFROM>
        <MAILINGNAME>${esc(LEDGER)}</MAILINGNAME>
        <ADDRESS.LIST TYPE="String"><ADDRESS>Probe Street</ADDRESS></ADDRESS.LIST>
        <STATE>West Bengal</STATE>
        <COUNTRY>India</COUNTRY>
        <PINCODE>700001</PINCODE>
      </LEDMAILINGDETAILS.LIST>
      <LEDGSTREGDETAILS.LIST>
        <APPLICABLEFROM>20260401</APPLICABLEFROM>
        <GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>
        <PLACEOFSUPPLY>West Bengal</PLACEOFSUPPLY>
        <STATE>West Bengal</STATE>
        <GSTIN>19AAAAA0000A1Z5</GSTIN>
      </LEDGSTREGDETAILS.LIST>
    </LEDGER>`;
  let raw = await send(company, ledBody, "create ledger");
  const ledErr = /<LINEERROR>([^<]*)/.exec(raw)?.[1]?.trim();
  ok("ledger create accepted", /<CREATED>\s*1/.test(raw), ledErr ?? counts(raw));
  if (!await healthy()) { console.log("\n⚠ Tally stopped answering."); return; }

  // ── Stock item ────────────────────────────────────────────────────────────
  console.log("\n2. Create a stock item");
  const itemBody = `
    <STOCKITEM NAME="${esc(ITEM)}" ACTION="Create">
      <NAME>${esc(ITEM)}</NAME>
      <PARENT>BICYCLE PARTS ( 87149990 )</PARENT>
      <BASEUNITS>PC</BASEUNITS>
      <ISBATCHWISEON>No</ISBATCHWISEON>
      <GSTAPPLICABLE>&#4; Applicable</GSTAPPLICABLE>
    </STOCKITEM>`;
  raw = await send(company, itemBody, "create item");
  const itemErr = /<LINEERROR>([^<]*)/.exec(raw)?.[1]?.trim();
  ok("stock item create accepted", /<CREATED>\s*1/.test(raw), itemErr ?? counts(raw));
  if (!await healthy()) { console.log("\n⚠ Tally stopped answering."); return; }

  // ── Godown ────────────────────────────────────────────────────────────────
  console.log("\n3. Create a godown");
  raw = await send(company, `
    <GODOWN NAME="${esc(GODOWN)}" ACTION="Create">
      <NAME>${esc(GODOWN)}</NAME><PARENT/>
    </GODOWN>`, "create godown");
  ok("godown create accepted", /<CREATED>\s*1/.test(raw), /<LINEERROR>([^<]*)/.exec(raw)?.[1]?.trim() ?? counts(raw));
  if (!await healthy()) { console.log("\n⚠ Tally stopped answering."); return; }

  // ── Read back through the SAME path the push guard uses ───────────────────
  console.log("\n4. Are they visible to the push path?");
  const m = await loadMasters(TALLY_URL, company, { force: true });
  const led = m.ledgers.get(LEDGER);
  ok("ledger is in the master cache", !!led, led ? `state="${led.state}" gstin="${led.gstin}"` : "not found");
  if (led) {
    ok("its GST identity round-tripped", led.gstin === "19AAAAA0000A1Z5" && /west bengal/i.test(led.state),
      `gstin=${led.gstin || "(none)"} state=${led.state || "(none)"}`);
  }
  ok("stock item is in the master cache", m.items.has(ITEM), m.items.get(ITEM)?.baseUnit ?? "not found");
  ok("godown is in the master cache", m.godowns.has(GODOWN), [...m.godowns].join(", "));

  // ── Alter ─────────────────────────────────────────────────────────────────
  console.log("\n5. Alter a master");
  raw = await send(company, `
    <LEDGER NAME="${esc(LEDGER)}" ACTION="Alter">
      <NAME>${esc(LEDGER)}</NAME>
      <BILLCREDITPERIOD>45 Days</BILLCREDITPERIOD>
    </LEDGER>`, "alter ledger");
  ok("ledger alter accepted", /<ALTERED>\s*1/.test(raw), counts(raw));

  // ── Clean up ──────────────────────────────────────────────────────────────
  console.log("\n6. Remove them");
  for (const [tag, name] of [["LEDGER", LEDGER], ["STOCKITEM", ITEM], ["GODOWN", GODOWN]] as const) {
    raw = await send(company, `<${tag} NAME="${esc(name)}" ACTION="Delete"><NAME>${esc(name)}</NAME></${tag}>`, `delete ${tag}`);
    ok(`${tag.toLowerCase()} deleted`, /<DELETED>\s*1/.test(raw), /<LINEERROR>([^<]*)/.exec(raw)?.[1]?.trim() ?? counts(raw));
  }

  const after = await loadMasters(TALLY_URL, company, { force: true });
  ok("nothing left behind", !after.ledgers.has(LEDGER) && !after.items.has(ITEM) && !after.godowns.has(GODOWN));

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(await healthy() ? "Tally still healthy." : "⚠ Tally NOT responding.");
}

main().catch(e => console.error("FAILED:", e.message));
