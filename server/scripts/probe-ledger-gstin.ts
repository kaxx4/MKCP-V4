/**
 * Where does a party's GSTIN actually live on the wire?
 *
 * verify-master-create.ts created a ledger with GSTIN nested inside
 * LEDGSTREGDETAILS.LIST. The STATE stuck; the GSTIN read back empty. Two
 * possibilities:
 *
 *   · the create genuinely failed to set it → inline party creation would
 *     produce B2C parties, and every invoice to one lands in a GSTR exception
 *     bucket while balancing and verifying perfectly;
 *   · the READ is asking for the wrong field → the party is fine and the
 *     verification is wrong.
 *
 * Ask a party that definitely has one.
 *
 *   npx tsx server/scripts/probe-ledger-gstin.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { tallyPost } from "../src/tally.js";
import { blocksOf } from "../src/services/tallyRequest.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Every field on one object. The wildcard is legal on NATIVEMETHOD here. */
function allFieldsXml(name: string): string {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>GstProbe</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="GstProbe" ISMODIFY="No"><TYPE>Ledger</TYPE>
<NATIVEMETHOD>*</NATIVEMETHOD>
<FILTER>GstProbeF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="GstProbeF">$Name = "${esc(name)}"</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

/** Any party the mirror says is registered. */
async function findRegisteredParty(): Promise<string | null> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>GstAny</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="GstAny" ISMODIFY="No"><TYPE>Ledger</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>GSTIN</NATIVEMETHOD><NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD>
<NATIVEMETHOD>LedStateName</NATIVEMETHOD>
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw: string = await tallyPost(TALLY, xml, 120_000, true);
  for (const b of blocksOf(raw, "LEDGER")) {
    const g = b.match(/<(?:PARTYGSTIN|GSTIN)[^>]*>([^<]+)</i)?.[1]?.replace(/&#4;\s*/g, "").trim();
    const n = b.match(/^[^>]*NAME="([^"]+)"/i)?.[1];
    if (g && g.length >= 15 && n) return n.replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  }
  return null;
}

async function main(): Promise<void> {
  console.log("\n  WHERE A PARTY'S GSTIN LIVES\n  " + "─".repeat(66));

  const party = await findRegisteredParty();
  if (!party) { console.log("\n  No registered party found to ask.\n"); return; }
  console.log(`\n  asking: ${party}\n`);

  const raw: string = await tallyPost(TALLY, allFieldsXml(party), 120_000, true);

  /* Every tag whose value LOOKS like a GSTIN: 2 digits, 10 PAN chars, 3 more. */
  const hits = [...raw.matchAll(/<([A-Z][A-Z0-9._]*)[^>]*>\s*(?:&#4;\s*)?([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3})\s*</gi)];
  const byTag = new Map<string, string>();
  for (const h of hits) byTag.set(h[1].toUpperCase(), h[2]);

  console.log("  tags carrying a GSTIN-shaped value:");
  if (byTag.size === 0) console.log("    (none — the wildcard may not have returned the block)");
  for (const [t, v] of byTag) console.log(`    ${t.padEnd(28)} ${v}`);

  /* Is it nested? Find the enclosing .LIST for each hit. */
  console.log("\n  nested blocks present on this ledger:");
  const lists = new Set([...raw.matchAll(/<([A-Z][A-Z0-9._]*\.LIST)>/gi)].map((m) => m[1].toUpperCase()));
  for (const l of [...lists].sort()) {
    const has = new RegExp(`<${l.replace(/\./g, "\\.")}>[\\s\\S]*?[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}[\\s\\S]*?</${l.replace(/\./g, "\\.")}>`, "i").test(raw);
    console.log(`    ${l.padEnd(34)}${has ? "  <-- contains a GSTIN" : ""}`);
  }

  console.log("\n  " + "─".repeat(66));
  const flat = [...byTag.keys()].filter((t) => !t.includes("."));
  if (flat.length) {
    console.log(`  Readable via: ${flat.join(", ")}`);
    console.log(`  So a read that asks for these and gets nothing means the CREATE did not`);
    console.log(`  set it — not that the read is wrong.`);
  } else {
    console.log(`  No flat tag carries it — the GSTIN is only inside a nested block, so a`);
    console.log(`  collection asking for GSTIN/PartyGSTIN will always read empty and the`);
    console.log(`  verification, not the create, was wrong.`);
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
