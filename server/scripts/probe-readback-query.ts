/**
 * What does createLedger's own read-back query actually see?
 *
 * The GSTIN IS stored — a wildcard dump of a freshly created party shows it
 * both flat and nested. Yet createLedger's read-back reports it empty, so the
 * fault is in the read, and the only way to know which part is to look at the
 * bytes that read receives.
 *
 *   npx tsx server/scripts/probe-readback-query.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { createLedger, deleteLedger } from "../src/services/masterPusher.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const NAME = `ZZRB ${Date.now().toString().slice(-6)}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function main(): Promise<void> {
  const company = convertCompanies(await tallyPost(TALLY, HEALTH_XML, 10_000))[0]?.name!;
  console.log(`\n  READ-BACK QUERY\n  ` + "─".repeat(66));

  const res = await createLedger(TALLY, company, {
    name: NAME, parent: "SUNDRY DEBTORS", state: "West Bengal", gstin: "19AFLPA4406Q1Z4",
  });
  console.log(`  created=${res.created} ok=${res.ok}`);
  console.log(`  readBack: ${JSON.stringify(res.readBack)}\n`);

  try {
    // Exactly the query readLedger builds.
    const withPartyGstin = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MpRead</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MpRead" ISMODIFY="No"><TYPE>Ledger</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>Parent</NATIVEMETHOD>
<NATIVEMETHOD>LedStateName</NATIVEMETHOD><NATIVEMETHOD>GSTIN</NATIVEMETHOD><NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD>
<FILTER>MpReadF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MpReadF">$Name = "${esc(NAME)}"</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;

    // The same thing without PartyGSTIN in the fetch list.
    const withoutPartyGstin = withPartyGstin.replace("<NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD>", "");

    for (const [label, xml] of [["WITH PartyGSTIN", withPartyGstin], ["WITHOUT PartyGSTIN", withoutPartyGstin]] as const) {
      const raw: string = await tallyPost(TALLY, xml, 30_000, true);
      const i = raw.indexOf("<LEDGER ");
      console.log(`  === ${label} ===`);
      console.log(i < 0 ? "     (no LEDGER block)" : raw.slice(i, i + 520).split("\n").map((l) => "  " + l).join("\n"));
      console.log("");
    }
  } finally {
    const d = await deleteLedger(TALLY, company, NAME);
    console.log(`  cleanup: ${d.ok ? "deleted" : "FAILED"}\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
