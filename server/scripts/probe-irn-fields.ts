/**
 * Does Tally carry the IRN, and can the mirror see it?
 *
 * ── Why this matters more than it looks ───────────────────────────────────
 *
 * An e-invoice must be registered with the IRP within 30 days of the invoice
 * date. Miss it and the document cannot be registered at all — the buyer loses
 * their input tax credit, and the first anyone hears is the buyer asking why.
 * It is the most expensive silent failure available in this system, and the app
 * pushes invoices that then need an IRN raised in Tally by a person.
 *
 * The app must never call the IRP — that is a hard scope boundary. But it can
 * NOTICE. To notice, it needs to know which pushed invoices still have no IRN,
 * and that is only possible if Tally exposes the field over XML.
 *
 * Answer that before building a clock that might have nothing to read.
 *
 *   npx tsx server/scripts/probe-irn-fields.ts
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

/** Every field on the Sales invoices of one day. */
function xmlFor(day: string): string {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>IrnProbe</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="IrnProbe" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>*</NATIVEMETHOD>
<FILTER>IrnProbeF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="IrnProbeF">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${Number(day)} AND $VoucherTypeName = "SALES"</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

async function main(): Promise<void> {
  const day = process.argv[2] ?? "20260911";
  console.log(`\n  IRN / E-INVOICE FIELDS on SALES vouchers, ${day}\n  ` + "─".repeat(66));

  const raw: string = await tallyPost(TALLY, xmlFor(day), 180_000, true);
  const vouchers = blocksOf(raw, "VOUCHER");
  console.log(`\n  ${vouchers.length} SALES voucher(s)\n`);
  if (vouchers.length === 0) {
    console.log("  No sales that day — try another date as the argument.\n");
    return;
  }

  const tags = [...new Set([...raw.matchAll(/<([A-Z][A-Z0-9._]*)[^>]*>/gi)].map((m) => m[1].toUpperCase()))];
  const interesting = tags.filter((t) => /IRN|EINV|ACKNO|ACKDT|SIGNEDQR|QRCODE|EWAYBILL|EWB|IRP/.test(t));

  console.log("  tags whose name suggests e-invoicing:");
  if (interesting.length === 0) console.log("    (none at all)");

  let anyPopulated = false;
  for (const t of interesting) {
    const e = t.replace(/\./g, "\\.");
    /* `<TAG[\s>]` MISSES a self-closing tag: `<IRN/>` has neither a space nor a
       `>` after the name. That is exactly how this probe first reported
       present=0 for fields the export was plainly emitting — the same family as
       the blocksOf trap the edge-case catalogue already documents, walked into
       again one file later.

       The distinction is the whole answer here. An empty self-closing tag means
       Tally CARRIES the field over XML and this invoice simply has no IRN yet;
       a genuinely absent tag would mean the clock cannot be driven from the
       mirror at all. */
    const present = [...raw.matchAll(new RegExp(`<${e}(?:[\\s>]|\\s*/>)`, "gi"))].length;
    const selfClosed = [...raw.matchAll(new RegExp(`<${e}\\s*/>`, "gi"))].length;
    const vals = [...raw.matchAll(new RegExp(`<${e}[^>]*>([^<]*)</${e}>`, "gi"))]
      .map((v) => v[1].replace(/&#4;\s*/g, "").trim()).filter(Boolean);
    if (vals.length) anyPopulated = true;
    console.log(`    ${t.padEnd(28)} emitted=${String(present).padStart(3)}  empty=${String(selfClosed).padStart(3)}  populated=${String(vals.length).padStart(3)}  ${vals.slice(0, 1).join("")}`);
  }

  console.log("\n  " + "─".repeat(66));
  if (anyPopulated) {
    console.log("  Tally DOES carry an IRN over XML. The clock can be driven from the mirror:");
    console.log("  add the field to the Voucher fetch list, store it, and age it from the");
    console.log("  invoice date against the 30-day IRP limit.");
  } else if (interesting.length > 0) {
    console.log("  The tags exist and are EMPTY on every voucher. Either this company does not");
    console.log("  e-invoice these, or Tally does not populate them over XML. Either way the");
    console.log("  clock cannot be driven from the mirror — say so rather than shipping a");
    console.log("  counter that reads zero and looks like good news.");
  } else {
    console.log("  Tally exposes NO e-invoice field here at all. An IRN clock driven from the");
    console.log("  mirror is not possible; it would need the compliance module's own data,");
    console.log("  which is out of scope (S1), or an operator-entered date.");
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
