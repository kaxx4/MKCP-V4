/**
 * EXPLORATION 9 — what verbs does Tally accept beyond Create / Alter / Delete?
 *
 * Cancel is the interesting one: a cancelled voucher keeps its number and its
 * place in the books but carries no value, which is how Tally preserves a
 * numbering sequence when an entry is abandoned. If it works over XML it is a
 * far better answer than Delete for anything already seen by a person.
 *
 *   npx tsx scripts/explore-verbs.ts --push
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters } from "../src/services/tallyMasters.js";
import { safePush } from "../src/services/safePush.js";
import { withTally } from "../src/services/tallyGate.js";
import { buildVoucherImportXml } from "../src/services/voucherPusher.js";
import type { VoucherPayload } from "../src/types.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const PUSH = process.argv.includes("--push");
const TAG = `VB${Date.now().toString().slice(-6)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const counts = (raw: string) => ["CREATED", "ALTERED", "DELETED", "CANCELLED", "ERRORS", "EXCEPTIONS"]
  .map(t => `${t}=${(new RegExp(`<${t}>\s*(\d+)`).exec(raw) ?? [])[1] ?? "?"}`).join(" ");

async function healthy() {
  try { return convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 8_000)).length > 0; }
  catch { return false; }
}

async function main() {
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  const m = await loadMasters(TALLY_URL, company, { force: true });
  const party = [...m.ledgers.values()].find(l => /SUNDRY DEBTORS/i.test(l.parent) && /WEST BENGAL/i.test(l.state))!;
  console.log(`company "${company}"`);
  if (!PUSH) { console.log("\nPass --push to run."); return; }

  const num = `${TAG}/1`;
  const base: VoucherPayload = {
    remoteId: `MKCP|Receipt|${num}|2026-27`, voucherType: "Receipt", date: TODAY,
    voucherNumber: num, narration: `${TAG} verb probe`, partyLedgerName: party.name, isInvoice: false,
    ledgerEntries: [
      { ledgerName: "HDFC BANK", amount: 500, isDeemedPositive: true, isPartyLedger: false },
      { ledgerName: party.name, amount: 500, isDeemedPositive: false, isPartyLedger: true },
    ],
  };

  console.log("\n1. Create a voucher to act on");
  const made = await safePush(TALLY_URL, company, base);
  console.log(`   ${made.ok ? "+" : "x"} ${made.ok ? `id ${made.voucherId}` : made.errors[0]}`);
  if (!made.ok) return;

  // ── Cancel ────────────────────────────────────────────────────────────────
  console.log("\n2. ACTION=\"Cancel\"");
  const xml = buildVoucherImportXml(company, { ...base, action: "Cancel" as VoucherPayload["action"] }, m);
  let raw = "";
  try {
    raw = await withTally(TALLY_URL, "cancel", () => tallyPost(TALLY_URL, xml, 60_000, true) as Promise<string>);
    const err = /<LINEERROR>([^<]*)/.exec(raw)?.[1]?.trim();
    console.log(`   ${counts(raw)}${err ? `  ERR: ${err}` : ""}`);
  } catch (e) { console.log(`   threw: ${(e as Error).message}`); }
  if (!await healthy()) { console.log("\n! Tally stopped answering."); return; }

  // Did it actually cancel, or just get ignored?
  const stamp = parseInt(TODAY.replace(/-/g, ""), 10);
  const verify = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>V</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="V" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>VoucherNumber</NATIVEMETHOD><NATIVEMETHOD>IsCancelled</NATIVEMETHOD><NATIVEMETHOD>Date</NATIVEMETHOD>
<FILTER>F</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="F">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${stamp}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const book = await tallyPost(TALLY_URL, verify, 180_000, true) as string;
  const mine = [...book.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map(x => x[0])
    .find(v => new RegExp(`<VOUCHERNUMBER>${num.replace("/", "\/")}</VOUCHERNUMBER>`).test(v));
  if (!mine) console.log("   voucher is GONE from the books entirely");
  else console.log(`   still present · IsCancelled=${(/<ISCANCELLED[^>]*>([^<]*)/.exec(mine) ?? [])[1]?.trim() ?? "?"}`);

  console.log("\n3. Clean up");
  const del = await safePush(TALLY_URL, company, { ...base, action: "Delete" });
  console.log(`   ${del.ok ? "+ deleted" : `x ${del.errors[0]}`}`);
  console.log(await healthy() ? "\nTally still healthy." : "\n! Tally NOT responding.");
}

main().catch(e => console.error("FAILED:", e.message));
