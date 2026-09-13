/**
 * The GST registration block on a REAL party, verbatim.
 *
 * Our create nests GSTIN inside LEDGSTREGDETAILS.LIST. The state sticks; the
 * GSTIN does not — and a probe confirmed GSTIN/PARTYGSTIN are readable flat
 * fields on a real party, so the read was right and the create is wrong.
 *
 * Copy the shape from a party Tally itself is happy with.
 *
 *   npx tsx server/scripts/probe-gstreg-block.ts "PARTY NAME"
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { tallyPost } from "../src/tally.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";
const PARTY = process.argv[2] ?? "ACHARIYA CYCLE STORES (MANGLAMARO)";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function main(): Promise<void> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>RegProbe</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="RegProbe" ISMODIFY="No"><TYPE>Ledger</TYPE>
<NATIVEMETHOD>*</NATIVEMETHOD><FILTER>RegProbeF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="RegProbeF">$Name = "${esc(PARTY)}"</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;

  const raw: string = await tallyPost(TALLY, xml, 120_000, true);
  console.log(`\n  ${PARTY}\n  ` + "─".repeat(70));

  for (const block of ["LEDGSTREGDETAILS.LIST", "GSTREGISTRATIONDETAILS.LIST", "LEDMAILINGDETAILS.LIST", "GSTDETAILS.LIST"]) {
    const esc2 = block.replace(/\./g, "\\.");
    const m = new RegExp(`<${esc2}>([\\s\\S]*?)</${esc2}>`, "i").exec(raw);
    console.log(`\n  === ${block} ===`);
    if (!m) { console.log("     (not present)"); continue; }
    const body = m[1].trim();
    if (!body) { console.log("     (present but EMPTY)"); continue; }
    console.log(body.split("\n").slice(0, 30).map((l) => "  " + l).join("\n"));
  }

  /* And the flat neighbourhood — what sits next to GSTIN at the top level. */
  console.log(`\n  === flat GST-ish fields ===`);
  for (const t of ["GSTIN", "PARTYGSTIN", "LEDGSTIN", "GSTREGISTRATIONTYPE", "LEDSTATENAME",
    "GSTTYPEOFREGISTRATION", "ISGSTAPPLICABLE", "PLACEOFSUPPLY", "COUNTRYOFRESIDENCE"]) {
    const v = new RegExp(`<${t}[^>]*>([^<]*)</${t}>`, "i").exec(raw)?.[1]?.replace(/&#4;\s*/g, "").trim();
    console.log(`     ${t.padEnd(24)} ${v === undefined ? "(absent)" : v === "" ? "(empty)" : v}`);
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
