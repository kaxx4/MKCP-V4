/**
 * T11 read-only look at operator-typed vouchers, to copy their shape: one Stock Journal, the
 * reverse-charge Journals, and a freight Purchase. Prints structure only: tag names, ledger
 * names that are books (never a party), signs and amounts. Reads only.
 *   npx tsx scripts/rigs/t11-probe-natives.ts "<TYPE>" "<narration filter or ->" [maxPrint]
 * Narration filter is an exact match on the NARRATION field, or "-" for none.
 */
import "dotenv/config";
import { preflight } from "./lib/t11.js";
import { tallyPost } from "../../src/tally.js";
import { escapeXml, tdlString } from "../../src/services/xml.js";
import { blocksOf } from "../../src/services/tallyRequest.js";

const type = process.argv[2] ?? "Stock Journal";
const narr = process.argv[3] ?? "-";
const max = Number(process.argv[4] ?? 2);
(async () => {
  const p = await preflight();
  const conds = [`$VoucherTypeName = ${tdlString(type)}`];
  if (narr !== "-") conds.push(`$Narration = ${tdlString(narr)}`);
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>T11Nat</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${escapeXml(p.company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="T11Nat" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>*</NATIVEMETHOD><NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD><NATIVEMETHOD>LedgerEntries</NATIVEMETHOD>
<NATIVEMETHOD>AllInventoryEntries</NATIVEMETHOD>
<FILTER>T11NatF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="T11NatF">${conds.join(" AND ")}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw = (await tallyPost(p.tallyUrl, xml, 280_000, true)) as string;
  const vs = blocksOf(raw, "VOUCHER").filter((b) => b.includes("<VOUCHERTYPENAME>"));
  console.log(`found ${vs.length} ${type} voucher(s)${narr !== "-" ? ` with that narration` : ""}`);
  const mask = (s: string) => s.replace(/<(PARTYLEDGERNAME|PARTYNAME|PARTYMAILINGNAME|BASICBUYERNAME|CONSIGNEEMAILINGNAME|PARTYGSTIN|CONSIGNEEGSTIN|GSTIN|ADDRESS|BASICBUYERADDRESS|GUID|REMOTEID|VCHKEY|IRN\w*|EWAY\w*)>([^<]+)</g, "<$1>***<");
  for (const v of vs.slice(0, max)) {
    const tags = [...new Set([...v.matchAll(/<([A-Z0-9_.]+)[ >]/g)].map((m) => m[1]))].filter((t) => !/^(\/)/.test(t));
    console.log(`\n--- tags (${tags.length}): ${tags.join(" ")}`);
    console.log(mask(v.replace(/\s{2,}/g, " ")).slice(0, 6000));
  }
  process.exit(0);
})().catch((e) => { console.error(`FAILED: ${(e as Error).message}`); process.exit(2); });
