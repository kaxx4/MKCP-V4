/**
 * Create one party, then look at what Tally ACTUALLY stored.
 *
 * The state sticks and the GSTIN does not, and element order was not the
 * cause. So the question is narrower than "why": did Tally store the
 * LEDGSTREGDETAILS.LIST block at all?
 *
 *   · block stored WITH the GSTIN  -> the flat GSTIN read is derived and the
 *     read is what is wrong.
 *   · block stored WITHOUT it      -> Tally took the block and dropped that one
 *     field.
 *   · block absent                 -> Tally discarded the whole thing while
 *     still reporting CREATED=1.
 *
 * Each points somewhere different, and guessing between them has already cost
 * two attempts.
 *
 *   npx tsx server/scripts/probe-created-party.ts
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
const NAME = `ZZPROBE GST ${Date.now().toString().slice(-6)}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function dump(company: string, name: string): Promise<string> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>PcpRead</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="PcpRead" ISMODIFY="No"><TYPE>Ledger</TYPE>
<NATIVEMETHOD>*</NATIVEMETHOD><FILTER>PcpF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="PcpF">$Name = "${esc(name)}"</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  return await tallyPost(TALLY, xml, 120_000, true);
}

async function main(): Promise<void> {
  const company = convertCompanies(await tallyPost(TALLY, HEALTH_XML, 10_000))[0]?.name!;
  console.log(`\n  CREATED PARTY, AS TALLY STORED IT\n  ` + "─".repeat(68));
  console.log(`  ${NAME}\n`);

  const res = await createLedger(TALLY, company, {
    name: NAME, parent: "SUNDRY DEBTORS", state: "West Bengal",
    gstin: "19AFLPA4406Q1Z4", pincode: "700001", address: "Probe Street",
  });
  console.log(`  create: created=${res.created} errors=${res.errors} exceptions=${res.exceptions}`);
  for (const n of res.notes) console.log(`    ${n}`);
  if (!res.created) { console.log("\n  Not created; nothing to inspect.\n"); return; }

  try {
    const raw = await dump(company, NAME);

    for (const block of ["LEDGSTREGDETAILS.LIST", "LEDMAILINGDETAILS.LIST"]) {
      const e = block.replace(/\./g, "\\.");
      const m = new RegExp(`<${e}>([\\s\\S]*?)</${e}>`, "i").exec(raw);
      console.log(`\n  === ${block} ===`);
      if (!m) console.log("     ABSENT — Tally discarded the whole block and still said CREATED=1");
      else if (!m[1].trim()) console.log("     present but EMPTY");
      else console.log(m[1].trim().split("\n").map((l) => "  " + l.trim()).join("\n"));
    }

    console.log(`\n  === flat fields ===`);
    for (const t of ["GSTIN", "PARTYGSTIN", "GSTREGISTRATIONTYPE", "PLACEOFSUPPLY", "ISGSTAPPLICABLE", "PARENT"]) {
      const v = new RegExp(`<${t}[^>]*>([^<]*)</${t}>`, "i").exec(raw)?.[1]?.replace(/&#4;\s*/g, "").trim();
      console.log(`     ${t.padEnd(22)} ${v === undefined ? "(absent)" : v === "" ? "(empty)" : v}`);
    }

    const inBlock = /<LEDGSTREGDETAILS\.LIST>[\s\S]*?<GSTIN>([^<]+)<\/GSTIN>[\s\S]*?<\/LEDGSTREGDETAILS\.LIST>/i.exec(raw);
    console.log("\n  " + "─".repeat(68));
    if (inBlock) {
      console.log(`  The GSTIN IS stored in the nested block (${inBlock[1]}).`);
      console.log(`  So the flat GSTIN read is derived from something else, and the READ-BACK`);
      console.log(`  check — not the create — is what needs fixing.`);
    } else {
      console.log(`  The GSTIN is NOT in the stored block. Tally accepted the block, kept the`);
      console.log(`  state, and dropped the GSTIN — a party that reports success and would`);
      console.log(`  file every invoice as B2C.`);
    }
  } finally {
    const d = await deleteLedger(TALLY, company, NAME);
    console.log(`\n  cleanup: ${d.ok ? "deleted" : "FAILED — " + d.notes[0]}\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
