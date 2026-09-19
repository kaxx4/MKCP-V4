/**
 * Our voucher, field by field, against one a human typed.
 *
 * ── Why this and not the read-back diff we already have ───────────────────
 *
 * `safePush` asks "did Tally store what we sent". That is blind to a field we
 * never sent, and every silent failure this project has had lived in that blind
 * spot: the missing GST identity block, the unappropriated discount line, and
 * the party address. Each one balanced, verified, read back byte-identical, and
 * was still wrong — because both sides of the comparison were equally
 * incomplete.
 *
 * So this compares against something we did not produce: the SAME voucher type,
 * keyed into Tally by the operator. A field most of their vouchers carry and
 * ours does not is a defect, named.
 *
 * ── How it reads ──────────────────────────────────────────────────────────
 *
 * Fields are fetched EXPLICITLY, never through `NATIVEMETHOD *`. The wildcard
 * returns stored scalars only and is documented as a discovery tool, not a
 * measuring one — using it to measure produced a wrong figure here on
 * 19-Sep-2026 that only surfaced because it contradicted an earlier count.
 *
 * ── Safety ────────────────────────────────────────────────────────────────
 *
 * Writes ONE marked voucher carrying a REMOTEID, reads it, deletes it, then
 * sweeps by number to prove it is gone. Never trusts the push result for
 * cleanup: safePush returning ok:false does not mean nothing was created.
 *
 *   npx tsx server/scripts/fidelity-vs-native.ts            (native profile only)
 *   npx tsx server/scripts/fidelity-vs-native.ts --push     (write ours and diff)
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { config } from "dotenv";
config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters } from "../src/services/tallyMasters.js";
import { guardVoucher } from "../src/services/pushGuard.js";
import { safePush } from "../src/services/safePush.js";
import { esc, blocksOf, tagOf } from "../src/services/tallyRequest.js";
import type { VoucherPayload } from "../src/types.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const PUSH = process.argv.includes("--push");
const TYPE = process.argv.find((a) => !a.startsWith("--") && a !== process.argv[0] && a !== process.argv[1]) ?? "SALES";
const TODAY = new Date().toISOString().slice(0, 10);
const TAG = `MKCP-FID${Date.now().toString().slice(-5)}`;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The fields worth comparing.
 *
 * Tally exports ~200 tags per voucher and most are its own bookkeeping
 * (IGNGSTFMTCRC and friends). These are the ones that carry meaning for a
 * return, a receivable or a delivery — i.e. the ones whose absence costs
 * something real.
 */
const FIELDS = [
  "VOUCHERTYPENAME", "VOUCHERNUMBER", "DATE", "PARTYLEDGERNAME", "PARTYNAME",
  "NARRATION", "REFERENCE", "ISINVOICE", "PERSISTEDVIEW",
  "PARTYGSTIN", "STATENAME", "COUNTRYOFRESIDENCE", "PLACEOFSUPPLY",
  "GSTREGISTRATIONTYPE", "GSTNATUREOFTRANSACTION", "VCHGSTCLASS",
  "CONSIGNEESTATENAME", "CONSIGNEEMAILINGNAME", "CONSIGNEEGSTIN",
  "BASICBUYERNAME", "PARTYMAILINGNAME", "BASICBUYERPINNUMBER",
  "ADDRESS.LIST", "BASICBUYERADDRESS.LIST", "CONSIGNEEADDRESS.LIST",
  "BASICDUEDATEOFPYMT", "BASICORDERREF", "BASICSHIPPEDBY", "BASICSHIPDOCUMENTNO",
  "ALLLEDGERENTRIES.LIST", "ALLINVENTORYENTRIES.LIST",
];

function collectionXml(company: string, filter: string, id = "Fid"): string {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${id}</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="${id}" ISMODIFY="No"><TYPE>Voucher</TYPE>
${FIELDS.map((f) => `<NATIVEMETHOD>${f}</NATIVEMETHOD>`).join("")}
<FILTER>${id}F</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="${id}F">${filter}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

const populated = (block: string, field: string): boolean => {
  const base = field.replace(/\.LIST$/, "");
  return new RegExp(`<${base}[^>]*>\\s*\\S`, "i").test(block);
};

async function profile(company: string, filter: string, id: string): Promise<{ n: number; freq: Map<string, number> }> {
  const raw = await tallyPost(U, collectionXml(company, filter, id), 300_000, true) as string;
  const vs = blocksOf(raw, "VOUCHER").filter((v) => (tagOf(v, "VOUCHERTYPENAME") ?? "").trim());
  const freq = new Map<string, number>();
  for (const v of vs) for (const f of FIELDS) if (populated(v, f)) freq.set(f, (freq.get(f) ?? 0) + 1);
  return { n: vs.length, freq };
}

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  const m = await loadMasters(U, company);
  console.log(`\n  FIDELITY — "${TYPE}" — ours vs hand-typed\n  ${company}\n  ${"─".repeat(70)}`);

  const native = await profile(company, `$$IsEqual:$VoucherTypeName:"${esc(TYPE)}"`, "FidNat");
  console.log(`\n  hand-typed vouchers of this type: ${native.n}`);
  if (!native.n) { console.log(`  none — check the spelling against the VoucherType masters.\n`); return; }

  const standard = FIELDS.filter((f) => (native.freq.get(f) ?? 0) >= native.n * 0.5);
  console.log(`  fields on at least half of them: ${standard.length}\n`);
  for (const f of standard) console.log(`     ${f.padEnd(28)} ${native.freq.get(f)}/${native.n}`);

  if (!PUSH) { console.log(`\n  (pass --push to write one of ours and diff against this)\n`); return; }

  const party = [...m.ledgers.values()].find((l) => /SUNDRY DEBTORS/i.test(l.parent) && /WEST BENGAL/i.test(l.state ?? ""));
  const item = [...m.items.values()].find((i) => i.closingStock > 5 && i.closingRate > 5);
  if (!party || !item) { console.log("\n  no usable party/item — stopping.\n"); return; }

  const goods = r2(2 * item.closingRate), cgst = r2(goods * 0.025), sgst = r2(goods * 0.025);
  const total = r2(goods + cgst + sgst);
  const number = `${TAG}-1`;
  const p: VoucherPayload = {
    remoteId: `MKCP|Fidelity|${number}|2026-27`,
    voucherType: "Sales", date: TODAY, voucherNumber: number,
    partyLedgerName: party.name, isInvoice: true,
    /* The one field Tally does not resolve from the ledger master itself. */
    partyAddress: party.address,
    narration: "Fidelity probe. Delete if this survives.",
    ledgerEntries: [
      { ledgerName: party.name, amount: total, isDeemedPositive: true, isPartyLedger: true,
        billAllocations: [{ name: number, billType: "New Ref", amount: total }] },
      { ledgerName: "OUTPUT CGST", amount: cgst, isDeemedPositive: false, isPartyLedger: false },
      { ledgerName: "OUTPUT SGST", amount: sgst, isDeemedPositive: false, isPartyLedger: false },
    ],
    inventoryEntries: [{
      stockItemName: item.name, quantity: 2, unit: item.baseUnit, rate: item.closingRate,
      amount: goods, isDeemedPositive: false,
      salesLedgerName: "SALES  ( GST W.B. )",
      godownName: "Main Location", batchName: "Primary Batch",
    }],
  };

  const g = guardVoucher(p, m);
  console.log(`\n  ── pushing ${number}\n     guard: ${g.errors.length} error(s)`);
  for (const e of g.errors.slice(0, 3)) console.log(`       ERROR ${e.slice(0, 120)}`);
  if (g.errors.length) { console.log("     refused; not sent.\n"); return; }

  let ok = false;
  try { ok = (await safePush(U, company, p)).ok; } catch (e) { console.log(`     threw: ${(e as Error).message.slice(0, 90)}`); }
  console.log(`     safePush ok=${ok}`);

  const mine = await profile(company, `$$IsEqual:$VoucherNumber:"${esc(number)}"`, "FidMine");
  console.log(`     read back: ${mine.n} voucher(s)`);

  if (mine.n) {
    const missing = standard.filter((f) => !mine.freq.has(f));
    console.log(`\n  \x1b[31mON THEIRS, MISSING FROM OURS (${missing.length})\x1b[0m`);
    for (const f of missing) console.log(`     ✗ ${f.padEnd(28)} theirs ${native.freq.get(f)}/${native.n}`);
    const extra = FIELDS.filter((f) => mine.freq.has(f) && !standard.includes(f));
    console.log(`\n  ours carries beyond the standard (${extra.length}): ${extra.join(", ") || "none"}`);
    if (!missing.length) console.log(`\n  \x1b[32m  ours carries every field theirs does.\x1b[0m`);

    mkdirSync(join(dirname(fileURLToPath(import.meta.url)), "..", "data"), { recursive: true });
    writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "data", "fidelity-vs-native.json"),
      JSON.stringify({ company, type: TYPE, nativeCount: native.n, standard, missingFromOurs: missing, extraInOurs: extra }, null, 2));
  }

  // ── cleanup, swept not assumed ────────────────────────────────────────────
  const delXml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER REMOTEID="${esc(p.remoteId!)}" VCHTYPE="SALES" ACTION="Delete">
<DATE>${TODAY.replace(/-/g, "")}</DATE><VOUCHERTYPENAME>SALES</VOUCHERTYPENAME>
<VOUCHERNUMBER>${esc(number)}</VOUCHERNUMBER></VOUCHER>
</TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
  await tallyPost(U, delXml, 120_000, true);
  const after = await profile(company, `$$IsEqual:$VoucherNumber:"${esc(number)}"`, "FidGone");
  console.log(`\n  cleanup: ${after.n} left in the books` + (after.n ? `  ⚠ DELETE ${number} BY HAND` : "  — clean"));
  console.log();
})();
