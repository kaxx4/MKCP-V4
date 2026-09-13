/**
 * Phase 3.1 — what actually blocks cash splits from reaching Tally.
 *
 * The push path for split invoices is already built: SplitInvoice.tsx has a
 * "queue to Tally" button that enqueues guarded VoucherPayloads. The file
 * fallback survives next to it because of one documented obstacle:
 *
 *   "A bucket billed to the CASH ledger will be refused, and the guard is
 *    right: 'Cash' carries no state, so Tally cannot derive a place of supply
 *    and the voucher would land in GSTR-1's incomplete-information bucket."
 *
 * Cash sales are ~35% of all vouchers here, so this is not a corner. Before
 * changing anything in the live books, check the claim — this codebase has been
 * burned by comments asserting constraints that were not true (the price-list
 * pull was blocked for months by one).
 *
 *   npx tsx server/scripts/probe-cash-ledger.ts
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

/** Every cash-like ledger: the Cash group plus anything named Cash. */
async function cashLedgers(): Promise<string[]> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>CashProbe</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="CashProbe" ISMODIFY="No"><TYPE>Ledger</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>Parent</NATIVEMETHOD>
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw: string = await tallyPost(TALLY, xml, 120_000, true);
  const out: string[] = [];
  for (const b of blocksOf(raw, "LEDGER")) {
    const name = b.match(/^[^>]*NAME="([^"]+)"/i)?.[1]
      ?.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'") ?? "";
    const parent = (b.match(/<PARENT[^>]*>([^<]*)</i)?.[1] ?? "").replace(/&#4;\s*/g, "").trim();
    if (/^cash/i.test(parent) || /^cash/i.test(name)) out.push(name);
  }
  return out;
}

async function inspect(name: string): Promise<void> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>CashOne</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="CashOne" ISMODIFY="No"><TYPE>Ledger</TYPE>
<NATIVEMETHOD>*</NATIVEMETHOD><FILTER>CashOneF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="CashOneF">$Name = "${esc(name)}"</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw: string = await tallyPost(TALLY, xml, 120_000, true);

  const reg = /<LEDGSTREGDETAILS\.LIST>([\s\S]*?)<\/LEDGSTREGDETAILS\.LIST>/i.exec(raw)?.[1] ?? "";
  const mail = /<LEDMAILINGDETAILS\.LIST>([\s\S]*?)<\/LEDMAILINGDETAILS\.LIST>/i.exec(raw)?.[1] ?? "";
  const f = (t: string, src: string) => (new RegExp(`<${t}[^>]*>([^<]*)</${t}>`, "i").exec(src)?.[1] ?? "").replace(/&#4;\s*/g, "").trim();

  const stateReg = f("STATE", reg);
  const stateMail = f("STATE", mail);
  const stateFlat = f("LEDSTATENAME", raw);
  const parent = f("PARENT", raw);

  console.log(`\n  ${name}`);
  console.log(`     parent                       ${parent || "—"}`);
  console.log(`     LEDGSTREGDETAILS.LIST/STATE  ${stateReg || (reg.trim() ? "(empty)" : "(block absent)")}`);
  console.log(`     LEDMAILINGDETAILS.LIST/STATE ${stateMail || (mail.trim() ? "(empty)" : "(block absent)")}`);
  console.log(`     LEDSTATENAME (derived)       ${stateFlat || "(absent)"}`);

  const has = !!(stateReg || stateMail || stateFlat);
  console.log(`     => ${has ? "HAS a state — the documented blocker does NOT apply here" : "NO state — a voucher billed to it cannot derive a place of supply"}`);
}

async function main(): Promise<void> {
  console.log("\n  THE CASH LEDGER — is the documented blocker real?");
  console.log("  " + "─".repeat(68));

  const names = await cashLedgers();
  console.log(`\n  ${names.length} cash-like ledger(s): ${names.join(", ") || "(none)"}`);
  for (const n of names) await inspect(n);

  console.log("\n  " + "─".repeat(68));
  console.log("  A stateless Cash ledger is CORRECT and must stay that way.");
  console.log("");
  console.log("  The obvious fix — Alter it to West Bengal — is the wrong one, and");
  console.log("  pushGuard already says why: `Cash` is shared by every counter sale, so a");
  console.log("  state on it would misdescribe every other voucher that uses it. The");
  console.log("  place of supply belongs to the SALE, not to the till.");
  console.log("");
  console.log("  That is what `placeOfSupply` on the payload is for, and");
  console.log("  resolvePartyState lets it stand in on an OUTWARD voucher only.");
  console.log("  verify-cash-split-push.ts proves a cash sale passes the guard this way.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
