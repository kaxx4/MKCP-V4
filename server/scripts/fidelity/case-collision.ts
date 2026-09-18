/**
 * The owner's exact failure, end to end, through safePush.
 *
 * Push a payment. Push another with the SAME number. The second must not be
 * lost: safePush should find a free number, land the voucher, and say which
 * number it used.
 */
import { safePush } from "../../src/services/safePush.js";
import { tallyPost } from "../../src/tally.js";
import { U, MARK, company, vouchersOnDayXml, objects, fld, check, report, remember } from "./harness.js";
import type { VoucherPayload } from "../../src/types.js";

const TODAY = new Date().toISOString().slice(0, 10);
const N = `${MARK}/X${Date.now().toString().slice(-5)}`;
const PARTY = "AMRIT CYCLE INDUSTRIES";
const STAMP = Date.now().toString().slice(-6);

/* The REMOTEID is minted ONCE per tag and written down.
   It used to embed a fresh `Date.now()` at every call, which made it
   unreproducible the moment the process exited — and this case never recorded
   it either. Since a REMOTEID is the only handle Tally accepts for a delete,
   every run left two payments in the books that nothing could ever address;
   five had accumulated that way before this was noticed. */
const RIDS = new Map<string, string>();
const ridFor = (tag: string): string => {
  const existing = RIDS.get(tag);
  if (existing) return existing;
  const rid = `MKCP-PAYMENT-${MARK}-${tag}-${STAMP}`;
  RIDS.set(tag, rid);
  return rid;
};

const mk = (tag: string): VoucherPayload => ({
  remoteId: ridFor(tag),
  voucherType: "Payment", date: TODAY, voucherNumber: N,
  narration: `${MARK} collision ${tag} ${STAMP}`, partyLedgerName: PARTY, isInvoice: false,
  ledgerEntries: [
    { ledgerName: PARTY, amount: 75, isDeemedPositive: true, isPartyLedger: true },
    { ledgerName: "Cash", amount: 75, isDeemedPositive: false, isPartyLedger: false },
  ],
} as unknown as VoucherPayload);

(async () => {
  const co = await company();
  console.log(`\n  number both vouchers ask for: ${N}\n`);

  /* Remembered BEFORE the push, not after: a push that reports failure may
     still have created the voucher, and an id written down only on success is
     missing exactly when it is needed. */
  remember({ remoteId: ridFor("first"), voucherType: "Payment", number: N, date: TODAY });
  const first = await safePush(U, co, mk("first"));
  console.log(`  first : ok=${first.ok} stage=${first.stage}`);

  remember({ remoteId: ridFor("second"), voucherType: "Payment", number: N, date: TODAY });
  const second = await safePush(U, co, mk("second"));
  console.log(`  second: ok=${second.ok} stage=${second.stage}`);
  if (second.warnings.length) second.warnings.forEach(w => console.log(`          warning: ${w}`));
  if (!second.ok) second.errors.forEach(e => console.log(`          error: ${e}`));

  const vs = objects(await tallyPost(U, vouchersOnDayXml(co, TODAY), 180_000, true) as string, "VOUCHER")
    /* Per-run narration, matching case-sales: this is the KEY the read-back
       uses, and a constant one counts every previous run's leftovers as this
       run's work — which reported "4 vouchers in the books" for a case that
       creates exactly 2, and then bound this run's REMOTEIDs to last run's
       voucher numbers. */
    .filter(v => fld(v.body, "NARRATION").includes(`${MARK} collision`) && fld(v.body, "NARRATION").endsWith(STAMP));
  const nums = vs.map(v => fld(v.body, "VOUCHERNUMBER"));

  /* Re-record each id against the number it ACTUALLY landed on.
     The whole point of this case is that safePush renumbers the second
     voucher, so the number guessed before the push is wrong for exactly the
     voucher the collision produced — and the sweep looks its ids up BY number.
     Without this the recovered voucher is journalled under a number that is
     not in the books, and the sweep falls back to a reconstructed id that
     Tally does not answer to. */
  for (const v of vs) {
    const tag = /collision (first|second) /.exec(fld(v.body, "NARRATION"))?.[1];
    if (!tag) continue;
    remember({ remoteId: ridFor(tag), voucherType: "Payment", number: fld(v.body, "VOUCHERNUMBER"), date: TODAY });
  }

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
