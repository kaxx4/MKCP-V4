/**
 * Offline: the two safety rules of the bank-mail rig (scripts/rigs/bank-mail-dummy.ts), kept in
 * scripts/rigs/lib/bankMailGuards.ts so they can be asserted without a Tally or a database.
 *
 *   M1  the test party ledger may be removed only when nothing still uses it. Tally overwrites the header party
 *       on Receipt and Payment, so counting by the header can say "0 vouchers use it" while a booked voucher
 *       names it on a ledger line. The rule reads the ledger lines (the production reader, voucherLedgerNames)
 *       and also refuses while any ZZTESTBM voucher is still in the books.
 *   M2  the sweep deletes by one REMOTEID, and it must be exactly the form the server writes for this voucher,
 *       MKCP|<type>|<the job's own ZZTESTBM number>|<financial year>, and the voucher found by that number must
 *       pass the shared sweep guard and carry ZZTEST in its narration. No guessing.
 *
 * The voucher XML is the 8-Nov-2026 dummy read-back shape with fake names.
 *
 *   npx tsx server/scripts/test-bank-mail-rig.ts
 */
import { bankMailRemoteId, sweepDeleteRefusal, partyUseRefusal, daysToRead, whileHoldingLease } from "./rigs/lib/bankMailGuards.js";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
};

const PARTY = "ZZ TEST BANKMAIL PARTY", BANK = "HDFC BANK", NUM = "ZZTESTBM57968668";
const voucher = (o: { header: string; names: string[]; tag?: string; number?: string }) => `<VOUCHER><DATE>20261108</DATE><VOUCHERNUMBER>${o.number ?? NUM}</VOUCHERNUMBER>
<VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><PARTYLEDGERNAME>${o.header}</PARTYLEDGERNAME>
${o.names.map((n) => `<${o.tag ?? "ALLLEDGERENTRIES.LIST"}><LEDGERNAME>${n}</LEDGERNAME><AMOUNT>101.00</AMOUNT></${o.tag ?? "ALLLEDGERENTRIES.LIST"}>`).join("\n")}
</VOUCHER>`;
const headerOnlyCount = (xmls: string[], party: string) => xmls.filter((v) => /<PARTYLEDGERNAME>([^<]*)</.exec(v)?.[1]?.trim().toLowerCase() === party.toLowerCase()).length;

const job = { voucherType: "Receipt", voucherNumber: NUM, date: "2026-11-08", remoteId: `MKCP|Receipt|${NUM}|2026-27` };
const goodFound = { number: NUM, type: "Receipt", narration: "ZZ TEST BANK MAIL DUMMY PUSH ZZTEST" };

console.log("\n  Bank-mail rig safety rules\n");

// ── M2: the sweep's delete handle ────────────────────────────────────────────
ok("M2 the REMOTEID the server writes: MKCP|type|number|financial year", bankMailRemoteId("Receipt", NUM, "2026-11-08") === `MKCP|Receipt|${NUM}|2026-27`);
ok("M2 the financial year follows April to March", bankMailRemoteId("Payment", NUM, "2027-03-31").endsWith("|2026-27") && bankMailRemoteId("Payment", NUM, "2027-04-01").endsWith("|2027-28"));
ok("M2 the good case is allowed", sweepDeleteRefusal(job, [goodFound]) === null, String(sweepDeleteRefusal(job, [goodFound])));
ok("M2 nothing booked is allowed (nothing to delete)", sweepDeleteRefusal(job, []) === null);
ok("M2 a REMOTEID with no financial year is refused (a loose guess)", sweepDeleteRefusal({ ...job, remoteId: `MKCP|Receipt|${NUM}` }, [goodFound]) !== null);
ok("M2 a REMOTEID for another voucher's number is refused", sweepDeleteRefusal({ ...job, remoteId: "MKCP|Receipt|ZZTESTBM11111111|2026-27" }, [goodFound]) !== null);
ok("M2 a REMOTEID for another type is refused", sweepDeleteRefusal({ ...job, remoteId: `MKCP|Payment|${NUM}|2026-27` }, [goodFound]) !== null);
ok("M2 a REMOTEID in the wrong financial year is refused", sweepDeleteRefusal({ ...job, remoteId: `MKCP|Receipt|${NUM}|2025-26` }, [goodFound]) !== null);
ok("M2 a missing REMOTEID is refused", sweepDeleteRefusal({ ...job, remoteId: undefined }, [goodFound]) !== null);
ok("M2 a job number with a trailing space is refused", sweepDeleteRefusal({ ...job, voucherNumber: NUM + " ", remoteId: `MKCP|Receipt|${NUM} |2026-27` }, [goodFound]) !== null);
ok("M2 a job number with 7 hex characters is refused", sweepDeleteRefusal({ ...job, voucherNumber: "ZZTESTBM5796866", remoteId: "MKCP|Receipt|ZZTESTBM5796866|2026-27" }, [{ ...goodFound, number: "ZZTESTBM5796866" }]) !== null);
ok("M2 a voucher whose narration lacks ZZTEST is refused", sweepDeleteRefusal(job, [{ ...goodFound, narration: "AS PER BILL" }]) !== null);
ok("M2 a voucher Tally returned under a different number is refused", sweepDeleteRefusal(job, [{ ...goodFound, number: "ZZTESTBM11111111" }]) !== null);
ok("M2 a voucher whose number has a trailing newline is refused", sweepDeleteRefusal(job, [{ ...goodFound, number: NUM + "\n" }]) !== null);
ok("M2 a voucher of another type is refused", sweepDeleteRefusal(job, [{ ...goodFound, type: "Payment" }]) !== null);
ok("M2 two vouchers found is refused", sweepDeleteRefusal(job, [goodFound, goodFound]) !== null);
ok("M2 the type compares without regard to case (Tally says RECEIPT)", sweepDeleteRefusal(job, [{ ...goodFound, type: "RECEIPT" }]) === null);

// ── M1: when the test party may be removed ───────────────────────────────────
const booked = voucher({ header: BANK, names: [BANK, PARTY] });
ok("M1 the old header-only count says 0 for the booked Receipt (the bug)", headerOnlyCount([booked], PARTY) === 0);
ok("M1 the rule refuses: a voucher names the party on a ledger line", partyUseRefusal(PARTY, { voucherXmls: [booked], bankMailNumbers: [], headerCount: 0 }) !== null);
ok("M1 it refuses when the party is only in a plain LEDGERENTRIES.LIST block", partyUseRefusal(PARTY, { voucherXmls: [voucher({ header: BANK, names: [BANK, PARTY], tag: "LEDGERENTRIES.LIST" })], bankMailNumbers: [], headerCount: 0 }) !== null);
ok("M1 it refuses while any ZZTESTBM voucher is still in the books", partyUseRefusal(PARTY, { voucherXmls: [], bankMailNumbers: ["20261108|Receipt|" + NUM], headerCount: 0 }) !== null);
ok("M1 it refuses when a header names the party", partyUseRefusal(PARTY, { voucherXmls: [], bankMailNumbers: [], headerCount: 1 }) !== null);
ok("M1 it allows removal when nothing uses the party", partyUseRefusal(PARTY, { voucherXmls: [voucher({ header: BANK, names: [BANK, "CASH"] })], bankMailNumbers: [], headerCount: 0 }) === null);
ok("M1 a ledger whose name differs by case is not this party",
  partyUseRefusal(PARTY, { voucherXmls: [voucher({ header: BANK, names: [BANK, PARTY.toLowerCase()] })], bankMailNumbers: [], headerCount: 0 }) === null);
ok("M1 the days to read are the census days plus the extra days, once each, as plain dates",
  JSON.stringify(daysToRead(["20260917|Payment|ZZTEST/X1", "20260917|Payment|ZZTEST/X2", "20260918|Receipt|RT741351/R"], ["2026-11-08", "2026-09-18"]))
    === JSON.stringify(["2026-09-17", "2026-09-18", "2026-11-08"]));
ok("M1 a census key that is not a date is skipped, never read", JSON.stringify(daysToRead(["bad|Receipt|X"], [])) === "[]");

// ── The queue lease while a slow push runs (8-Nov-2026: Tally took 12 to 37 s a read and the 30 s lease lapsed before the outcome write) ──
(async () => {
  const sleep = (t: number) => new Promise((r) => setTimeout(r, t));
  let calls = 0;
  const out = await whileHoldingLease(async () => { calls++; }, 20, async () => { await sleep(400); return "result"; });
  const during = calls;
  ok("lease: it is renewed several times while a slow step runs", during >= 3, `${during} renewals in about 400 ms at 20 ms`);
  ok("lease: the step's own result comes back", out === "result");
  await sleep(100);
  ok("lease: renewing stops when the step ends", calls === during, `${during} then ${calls}`);
  let failing = 0;
  const out2 = await whileHoldingLease(async () => { failing++; throw new Error("database busy"); }, 20, async () => { await sleep(90); return 7; });
  ok("lease: a failed renewal never stops the step", out2 === 7 && failing >= 2, `${failing} failed renewals`);
  let thrown = "";
  let c3 = 0;
  try { await whileHoldingLease(async () => { c3++; }, 20, async () => { await sleep(50); throw new Error("push failed"); }); } catch (e) { thrown = (e as Error).message; }
  await sleep(80);
  const c3a = c3; await sleep(80);
  ok("lease: the step's error still comes out, and renewing stops", thrown === "push failed" && c3 === c3a);
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
