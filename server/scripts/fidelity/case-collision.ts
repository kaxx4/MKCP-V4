/**
 * The owner's exact failure, end to end, through safePush.
 *
 * Push a payment. Push another with the SAME number. The second must not be
 * lost: safePush should find a free number, land the voucher, and say which
 * number it used.
 */
import { safePush } from "../../src/services/safePush.js";
import { tallyPost } from "../../src/tally.js";
import { U, MARK, company, vouchersOnDayXml, objects, fld, check, report } from "./harness.js";
import type { VoucherPayload } from "../../src/types.js";

const TODAY = new Date().toISOString().slice(0, 10);
const N = `${MARK}/X${Date.now().toString().slice(-5)}`;
const PARTY = "AMRIT CYCLE INDUSTRIES";

const mk = (tag: string): VoucherPayload => ({
  remoteId: `MKCP-PAYMENT-${MARK}-${tag}-${Date.now().toString().slice(-6)}`,
  voucherType: "Payment", date: TODAY, voucherNumber: N,
  narration: `${MARK} collision ${tag}`, partyLedgerName: PARTY, isInvoice: false,
  ledgerEntries: [
    { ledgerName: PARTY, amount: 75, isDeemedPositive: true, isPartyLedger: true },
    { ledgerName: "Cash", amount: 75, isDeemedPositive: false, isPartyLedger: false },
  ],
} as unknown as VoucherPayload);

(async () => {
  const co = await company();
  console.log(`\n  number both vouchers ask for: ${N}\n`);

  const first = await safePush(U, co, mk("first"));
  console.log(`  first : ok=${first.ok} stage=${first.stage}`);

  const second = await safePush(U, co, mk("second"));
  console.log(`  second: ok=${second.ok} stage=${second.stage}`);
  if (second.warnings.length) second.warnings.forEach(w => console.log(`          warning: ${w}`));
  if (!second.ok) second.errors.forEach(e => console.log(`          error: ${e}`));

  const vs = objects(await tallyPost(U, vouchersOnDayXml(co, TODAY), 180_000, true) as string, "VOUCHER")
    .filter(v => /ZZTEST collision/.test(fld(v.body, "NARRATION")));
  const nums = vs.map(v => fld(v.body, "VOUCHERNUMBER"));

  report("collision recovery", [
    check("first voucher landed", "yes", first.ok ? "yes" : ""),
    check("second voucher landed too", "yes", second.ok ? "yes" : "",
      { note: "before the fix this was lost: created=0, exceptions=1, five futile retries" }),
    check("two vouchers in the books", "2", String(vs.length)),
    check("they carry DIFFERENT numbers", "yes",
      new Set(nums).size === vs.length ? "yes" : `no — ${nums.join(", ")}`),
    check("the second says which number it got", "yes",
      second.warnings.some(w => /numbered/.test(w)) ? "yes" : ""),
  ]);
  console.log(`  numbers in the books: ${nums.join(", ")}\n`);
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });
