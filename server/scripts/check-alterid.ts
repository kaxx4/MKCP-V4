/**
 * Does change detection actually detect change?
 *
 * The previous implementation returned 0/0 forever, so the incremental path
 * could never fire. This proves the replacement both reads a real high-water
 * mark AND notices a genuine change — by making one.
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters } from "../src/services/tallyMasters.js";
import { safePush } from "../src/services/safePush.js";
import { ChangeDetector } from "../src/services/changeDetector.js";
import type { VoucherPayload } from "../src/types.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const PUSH = process.argv.includes("--push");
const TAG = `CD${Date.now().toString().slice(-6)}`;
const TODAY = new Date().toISOString().slice(0, 10);

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  const cd = new ChangeDetector();

  const t0 = Date.now();
  const base = await cd.fetchCurrentAlterIds(U, company);
  console.log(`baseline: masters=${base.masterId} vouchers=${base.transactionId}  (${Date.now() - t0}ms)`);
  if (!base.masterId || !base.transactionId) { console.log("x counters are zero — still broken"); return; }
  cd.updateSnapshot(base);

  const t1 = Date.now();
  const quiet = await cd.whatChanged(U, company, base);
  console.log(`quiet poll: ${quiet.vouchers.count} vouchers, ${quiet.ledgers.count} ledgers, ${quiet.items.count} items  (${Date.now() - t1}ms)`);

  if (!PUSH) { console.log("\nPass --push to prove it notices a real change."); return; }

  const m = await loadMasters(U, company, { force: true });
  const party = [...m.ledgers.values()].find(l => /SUNDRY DEBTORS/i.test(l.parent) && /WEST BENGAL/i.test(l.state))!;
  const num = `${TAG}/1`;
  const v: VoucherPayload = {
    remoteId: `MKCP|Receipt|${num}|2026-27`, voucherType: "Receipt", date: TODAY,
    voucherNumber: num, narration: `${TAG} change probe`, partyLedgerName: party.name, isInvoice: false,
    ledgerEntries: [
      { ledgerName: "HDFC BANK", amount: 250, isDeemedPositive: true, isPartyLedger: false },
      { ledgerName: party.name, amount: 250, isDeemedPositive: false, isPartyLedger: true },
    ],
  };

  console.log("\npushing one voucher…");
  const res = await safePush(U, company, v);
  console.log(`  ${res.ok ? "+" : "x"} ${res.ok ? `id ${res.voucherId}` : res.errors[0]}`);
  if (!res.ok) return;

  const t2 = Date.now();
  const after = await cd.whatChanged(U, company, base);
  console.log(`\nafter poll: ${after.vouchers.count} vouchers changed  (${Date.now() - t2}ms)`);
  console.log(`  numbers: ${after.vouchers.voucherNumbers.slice(0, 5).join(", ")}`);
  console.log(`  ${after.vouchers.voucherNumbers.includes(num) ? "+ the new voucher was detected" : "x the new voucher was NOT detected"}`);
  console.log(`  cursor moves ${base.transactionId} -> ${after.vouchers.maxAlterId}`);

  await safePush(U, company, { ...v, action: "Delete" });
  console.log("\ncleaned up.");
})();
