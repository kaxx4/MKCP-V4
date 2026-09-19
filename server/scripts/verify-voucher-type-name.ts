/**
 * Does Tally accept the voucher type name we actually send?
 *
 * ── The question ──────────────────────────────────────────────────────────
 *
 * This company's sales voucher type is literally named **SALES** — read off the
 * VoucherType masters 19-Sep-2026:
 *
 *     SALES              parent=SALES             affectsStock=No
 *     Sales Order Note   parent=Sales Order Note  affectsStock=Yes
 *
 * Our payload type union says "Sales", and `voucherPusher.ts` puts that string
 * straight into VOUCHERTYPENAME with no mapping. `pushGuard` already knows about
 * the mismatch and compares case-insensitively — but the guard passing says
 * nothing about what Tally does with the string.
 *
 * Tally may fold case, may refuse, or may CREATE a second voucher type called
 * "Sales" and quietly file our invoices under it — the worst outcome and the
 * hardest to notice, because everything would report success while the books
 * grew a parallel sales type.
 *
 * So: push one, read back the type name Tally actually stored, delete it.
 *
 * ── Safety ────────────────────────────────────────────────────────────────
 *
 * Marked number, REMOTEID set from creation (so it can be deleted — 12 earlier
 * test vouchers are stranded forever for want of one), two units of stock,
 * deleted at the end, and the cleanup SWEEPS the books rather than trusting the
 * push result: safePush returning ok:false does not mean nothing was created.
 *
 *   npx tsx server/scripts/verify-voucher-type-name.ts          (dry - guard only)
 *   npx tsx server/scripts/verify-voucher-type-name.ts --push   (writes + deletes)
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
const TODAY = new Date().toISOString().slice(0, 10);
const TAG = `MKCP-VT${Date.now().toString().slice(-5)}`;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** What type did Tally actually file it under? */
async function readBackType(company: string, number: string): Promise<{ found: number; type: string }> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>VTCheck</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="VTCheck" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>VOUCHERNUMBER</NATIVEMETHOD><NATIVEMETHOD>VOUCHERTYPENAME</NATIVEMETHOD><NATIVEMETHOD>DATE</NATIVEMETHOD>
<FILTER>VTCheckF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="VTCheckF">$$IsEqual:$VoucherNumber:"${esc(number)}"</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw = await tallyPost(U, xml, 120_000, true) as string;
  const vs = blocksOf(raw, "VOUCHER").filter((v) => (tagOf(v, "VOUCHERTYPENAME") ?? "").trim());
  return { found: vs.length, type: vs.length ? (tagOf(vs[0], "VOUCHERTYPENAME") ?? "").trim() : "" };
}

async function del(company: string, remoteId: string, type: string, date: string, number: string): Promise<string> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER REMOTEID="${esc(remoteId)}" VCHTYPE="${esc(type)}" ACTION="Delete">
<DATE>${date.replace(/-/g, "")}</DATE><VOUCHERTYPENAME>${esc(type)}</VOUCHERTYPENAME>
<VOUCHERNUMBER>${esc(number)}</VOUCHERNUMBER></VOUCHER>
</TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
  const res = await tallyPost(U, xml, 120_000, true) as string;
  return /<DELETED>(\d+)<\/DELETED>/.exec(res)?.[1] ?? "0";
}

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  const m = await loadMasters(U, company);
  console.log(`\n  VOUCHER TYPE NAME — WHAT DOES TALLY ACCEPT?\n  ${company}\n  ${"─".repeat(68)}`);
  console.log(`  sales-ish types here: ${[...m.voucherTypes].filter((t) => /sale/i.test(t)).join(" · ")}\n`);

  const party = [...m.ledgers.values()]
    .find((l) => /SUNDRY DEBTORS/i.test(l.parent) && /WEST BENGAL/i.test(l.state ?? ""));
  const item = [...m.items.values()].find((i) => i.closingStock > 5 && i.closingRate > 5);
  if (!party || !item) { console.log("  no usable party/item found — stopping."); return; }
  console.log(`  party: ${party.name}\n  item:  ${item.name} @ ${item.closingRate}\n`);

  const build = (type: string, n: number): VoucherPayload => {
    const goods = r2(2 * item.closingRate);
    const cgst = r2(goods * 0.025), sgst = r2(goods * 0.025);
    const number = `${TAG}-${n}`;
    const total = r2(goods + cgst + sgst);
    return {
      remoteId: `MKCP|TypeProbe|${number}|2026-27`,
      voucherType: type as VoucherPayload["voucherType"],
      date: TODAY, voucherNumber: number,
      partyLedgerName: party.name, isInvoice: true,
      narration: "Voucher-type-name probe. Delete if this survives.",
      ledgerEntries: [
        {
          ledgerName: party.name, amount: total, isDeemedPositive: true, isPartyLedger: true,
          billAllocations: [{ name: number, billType: "New Ref", amount: total }],
        },
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
  };

  const survivors: string[] = [];
  for (const [i, type] of ["Sales", "SALES"].entries()) {
    const p = build(type, i + 1);
    console.log(`\n  ── VOUCHERTYPENAME = "${type}"`);
    const g = guardVoucher(p, m);
    console.log(`     guard: ${g.errors.length} error(s), ${g.warnings.length} warning(s)`);
    for (const e of g.errors.slice(0, 3)) console.log(`       ERROR ${e.slice(0, 120)}`);
    if (!PUSH) { console.log(`     (dry run — pass --push to write)`); continue; }
    if (g.errors.length) { console.log(`     refused by the guard; not sent.`); continue; }

    let ok = false;
    try { ok = (await safePush(U, company, p)).ok; }
    catch (e) { console.log(`     safePush threw: ${(e as Error).message.slice(0, 90)}`); }
    console.log(`     safePush ok=${ok}`);

    const back = await readBackType(company, p.voucherNumber!);
    console.log(`     in Tally: ${back.found} voucher(s)` + (back.found ? `, filed as "${back.type}"` : ""));
    if (back.found) {
      const gone = await del(company, p.remoteId!, back.type, p.date, p.voucherNumber!);
      const after = await readBackType(company, p.voucherNumber!);
      console.log(`     cleanup: deleted=${gone}, left=${after.found}`);
      if (after.found) survivors.push(p.voucherNumber!);
    }
  }

  if (survivors.length) console.log(`\n  ⚠ LEFT IN THE BOOKS — delete by hand: ${survivors.join(", ")}`);
  else if (PUSH) console.log(`\n  books clean — nothing left behind.`);
  console.log();
})();
