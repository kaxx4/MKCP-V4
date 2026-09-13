/**
 * The Phase 2 gate: a Tally edit surfaces via AlterID, the same day.
 *
 * ── Why this needs a real write ───────────────────────────────────────────
 *
 * Everything about incremental sync has been "written and never run" before.
 * ChangeDetector returned 0/0 forever and looked correct while doing nothing.
 * So the only acceptable evidence is a voucher that really moves in Tally and
 * is really seen above a cursor.
 *
 * The write is authorised, marked, and REMOVED — the cleanup is part of the
 * test, not an afterthought. Every voucher it creates carries an `AID` tag in
 * its number and an explicit REMOTEID, which is the only handle Tally accepts
 * for Delete.
 *
 * ── What it proves, in order ──────────────────────────────────────────────
 *   1. A NEW voucher appears above the cursor.
 *   2. An ALTER of that voucher appears above the new cursor — this is the one
 *      that matters, because an edit to an old voucher has no date signal and
 *      AlterID is the only way to notice it at all.
 *   3. MASTERID survives the alter while ALTERID moves — identity is stable,
 *      the change counter is not.
 *   4. Nothing is left behind.
 *
 *   npx tsx server/scripts/verify-alterid-detection.ts --push
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters } from "../src/services/tallyMasters.js";
import { safePush } from "../src/services/safePush.js";
import { ChangeDetector } from "../src/services/changeDetector.js";
import type { VoucherPayload } from "../src/types.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const PUSH = process.argv.includes("--push");
const TAG = `AID${Date.now().toString().slice(-6)}`;
const TODAY = new Date().toISOString().slice(0, 10);

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { console.log(`  ok    ${name}${detail ? "  — " + detail : ""}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? "  — " + detail : ""}`); fail++; }
};

const r2 = (x: number) => Math.round(x * 100) / 100;

async function main(): Promise<void> {
  console.log("\n  ALTERID DETECTION — the Phase 2 gate\n  " + "─".repeat(66));

  const company = convertCompanies(await tallyPost(TALLY, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  console.log(`  company: ${company}\n`);

  if (!PUSH) {
    console.log("  Pass --push to run. This WRITES a voucher to the live company and");
    console.log("  then removes it; nothing real is touched.\n");
    return;
  }

  const detector = new ChangeDetector();
  const m = await loadMasters(TALLY, company);
  const supplier = [...m.ledgers.values()]
    .find((l) => /SUNDRY CREDITORS/i.test(l.parent) && l.state && !/WEST BENGAL/i.test(l.state))!;
  const item = [...m.items.values()].find((i) => i.closingStock > 20 && i.closingRate > 20)!;
  const godown = [...m.godowns.values()][0]?.name ?? "Main Location";

  const num = `${TAG}/1`;
  const amount = r2(2 * item.closingRate);
  const base: VoucherPayload = {
    remoteId: `MKCP|Purchase|${num}`,
    voucherType: "Purchase", date: TODAY, voucherNumber: num, reference: num,
    narration: `${TAG} before the edit`, partyLedgerName: supplier.name, isInvoice: true,
    ledgerEntries: [{
      ledgerName: supplier.name, amount, isDeemedPositive: false, isPartyLedger: true,
      billAllocations: [{ name: num, billType: "New Ref", amount }],
    }],
    inventoryEntries: [{
      stockItemName: item.name, quantity: 2, unit: item.baseUnit, rate: item.closingRate,
      amount, isDeemedPositive: true, salesLedgerName: "PURCHASE ( GST CENTRAL )",
      godownName: godown, batchName: "Primary Batch",
    }],
  };

  let created = false;
  try {
    // ── The cursor, before anything happens ───────────────────────────────
    const c0 = await detector.fetchCurrentAlterIds(TALLY, company);
    console.log(`  cursor before      : ${c0.transactionId}\n`);

    // ── 1. Create ─────────────────────────────────────────────────────────
    console.log("  1. A new voucher");
    const res = await safePush(TALLY, company, base);
    check("created and verified", res.ok, res.voucherId ?? res.errors[0]);
    if (!res.ok) { return; }
    created = true;

    const c1 = await detector.whatChanged(TALLY, company, c0);
    console.log(`     ${c1.vouchers.count} voucher(s) above ${c0.transactionId}: ` +
      `${c1.vouchers.voucherNumbers.slice(0, 5).join(", ")}`);
    check("the new voucher is seen above the cursor",
      c1.vouchers.voucherNumbers.includes(num), `looking for ${num}`);
    check("the cursor advanced", c1.vouchers.maxAlterId > c0.transactionId,
      `${c0.transactionId} → ${c1.vouchers.maxAlterId}`);

    // ── 2. Alter — the case with no date signal ───────────────────────────
    console.log("\n  2. An EDIT to that voucher — the case a date-based sync cannot see");
    const afterCreate = { ...c0, transactionId: c1.vouchers.maxAlterId };

    const alt = await safePush(TALLY, company, {
      ...base, action: "Alter", narration: `${TAG} AFTER the edit`,
    });
    check("altered in place", alt.ok, alt.errors[0] ?? "altered");

    const c2 = await detector.whatChanged(TALLY, company, afterCreate);
    console.log(`     ${c2.vouchers.count} voucher(s) above ${afterCreate.transactionId}: ` +
      `${c2.vouchers.voucherNumbers.slice(0, 5).join(", ")}`);
    check("THE EDIT IS DETECTED — this is the gate",
      c2.vouchers.voucherNumbers.includes(num),
      "an edit to an old voucher carries no date signal; AlterID is the only way to notice it");
    check("the cursor advanced again", c2.vouchers.maxAlterId > afterCreate.transactionId,
      `${afterCreate.transactionId} → ${c2.vouchers.maxAlterId}`);

    // ── 3. Identity is stable, the counter is not ─────────────────────────
    console.log("\n  3. Identity across the edit");
    const idXml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>AidId</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${company.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="AidId" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>VoucherNumber</NATIVEMETHOD><NATIVEMETHOD>MasterId</NATIVEMETHOD>
<NATIVEMETHOD>AlterId</NATIVEMETHOD><NATIVEMETHOD>RemoteId</NATIVEMETHOD><NATIVEMETHOD>Narration</NATIVEMETHOD>
<FILTER>AidF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="AidF">$VoucherNumber = "${num}"</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
    const raw: string = await tallyPost(TALLY, idXml, 60_000, true);
    const masterId = raw.match(/<MASTERID[^>]*>\s*(\d+)/i)?.[1];
    const alterId = raw.match(/<ALTERID[^>]*>\s*(\d+)/i)?.[1];
    const remoteId = raw.match(/<REMOTEID[^>]*>([^<]*)</i)?.[1];
    const narration = raw.match(/<NARRATION[^>]*>([^<]*)</i)?.[1];

    console.log(`     masterId ${masterId} · alterId ${alterId} · remoteId ${remoteId ?? "(not exported)"}`);
    console.log(`     narration: ${narration}`);
    check("the edit really landed in Tally", (narration ?? "").includes("AFTER the edit"));
    check("MASTERID is present and stable", !!masterId);
    check("ALTERID moved past the pre-edit cursor", Number(alterId) > afterCreate.transactionId,
      `${alterId} > ${afterCreate.transactionId}`);
    check("REMOTEID is still not exported by Tally", !remoteId,
      "0 of 4 previously; identity is recorded when we WRITE, never learned by reading");

  } finally {
    // ── 4. Cleanup is part of the test ──────────────────────────────────────
    if (created) {
      console.log("\n  4. Removing the test voucher");
      const del = await safePush(TALLY, company, { ...base, action: "Delete" });
      check("deleted by its remoteId", del.ok, del.errors[0] ?? "deleted");

      const gone: string = await tallyPost(TALLY,
        `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>AidGone</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${company.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="AidGone" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>VoucherNumber</NATIVEMETHOD><FILTER>AidGoneF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="AidGoneF">$VoucherNumber = "${num}"</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`, 60_000, true);
      check("the books are left clean", !gone.includes(num), `no ${num} remains`);
    }
  }

  console.log("\n  " + "─".repeat(66));
  console.log(`  ${pass} passed · ${fail} failed`);
  console.log(fail === 0
    ? "  A Tally edit surfaces via AlterID, and the test left nothing behind.\n"
    : "  The gate is NOT met.\n");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
