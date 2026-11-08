/**
 * Offline: how a stored voucher is matched to the party we sent (bank-mail lane, 8-Nov-2026).
 *
 * Tally overwrites a voucher's header party (PARTYLEDGERNAME) with the bank or cash ledger on Payment,
 * Receipt and Contra (PARTY_OVERWRITTEN in pushGuard.ts). On 8-Nov-2026 the dummy company stored a test
 * Receipt with header party "HDFC BANK" while the party sat on the credit line. The two matchers that
 * settle a job or a push from a read of Tally compared the header to the payload party, so they could not
 * find that voucher:
 *   - findInTally (erpJobAgent.ts): the crash-recovery read that settles a job left `sent`;
 *   - pickByMoney (safePush.ts): the read-back's last resort when no number or narration matches.
 * Both now ask one helper, partyMatchesStored (safePush.ts), which looks on the ledger lines for those three
 * types and on the header for every other type.
 *
 * The voucher XML below is built from what Tally returned on 8-Nov-2026 (header, two ledger lines, the bank
 * detail on the bank line, an On Account bill on the party line). Every name and number is a fake test one.
 *
 *   npx tsx server/scripts/test-party-match.ts
 */
import { findInTally } from "../src/services/erpJobAgent.js";
import { pickByMoney, partyMatchesStored } from "../src/services/safePush.js";
import { PARTY_OVERWRITTEN, partyIsOverwritten } from "../src/services/pushGuard.js";
import type { VoucherPayload } from "../src/types.js";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
};

const PARTY = "ZZ TEST BANKMAIL PARTY", BANK = "HDFC BANK", OTHER = "ZZ TEST OTHER PARTY";
const DAY = "2026-11-08";

/** One stored voucher, shaped as the dummy Tally returned it on 8-Nov-2026. */
function stored(o: { type: string; number: string; header: string; lines: { name: string; amount: string; dr: boolean; bank?: boolean; bill?: boolean }[]; narration?: string }): string {
  const lines = o.lines.map((l) => `<ALLLEDGERENTRIES.LIST>
<LEDGERNAME>${l.name}</LEDGERNAME><ISDEEMEDPOSITIVE>${l.dr ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${l.amount}</AMOUNT>
${l.bank ? "<BANKALLOCATIONS.LIST><INSTRUMENTNUMBER>ZZBMDUMMY01</INSTRUMENTNUMBER><TRANSACTIONTYPE>Cheque/DD</TRANSACTIONTYPE><AMOUNT>-101.00</AMOUNT></BANKALLOCATIONS.LIST>" : ""}
${l.bill ? "<BILLALLOCATIONS.LIST><NAME></NAME><BILLTYPE>On Account</BILLTYPE><AMOUNT>101.00</AMOUNT></BILLALLOCATIONS.LIST>" : ""}
</ALLLEDGERENTRIES.LIST>`).join("\n");
  return `<VOUCHER REMOTEID="" VCHTYPE="${o.type}" ACTION="Create"><DATE>20261108</DATE><VOUCHERNUMBER>${o.number}</VOUCHERNUMBER>
<VOUCHERTYPENAME>${o.type}</VOUCHERTYPENAME><NARRATION>${o.narration ?? "ZZ TEST BANK MAIL DUMMY PUSH ZZTEST"}</NARRATION>
<PARTYLEDGERNAME>${o.header}</PARTYLEDGERNAME><ISCANCELLED>No</ISCANCELLED>
${lines}
</VOUCHER>`;
}
const reply = (...vs: string[]) => `<ENVELOPE><BODY><DATA><COLLECTION>${vs.join("\n")}</COLLECTION></DATA></BODY></ENVELOPE>`;

/** The payload the money engine built for the 8-Nov test: bank Dr 101 with a NEFT detail, party Cr 101 On Account. */
function payload(type: string, number: string): VoucherPayload {
  return {
    voucherType: type, date: DAY, voucherNumber: number, partyLedgerName: PARTY, narration: "ZZ TEST BANK MAIL DUMMY PUSH ZZTEST",
    ledgerEntries: [
      { ledgerName: BANK, amount: 101, isDeemedPositive: true, isPartyLedger: false,
        bankAllocation: { transactionType: "Cheque/DD", transferMode: "NEFT", instrumentNumber: "ZZBMDUMMY01", favouring: PARTY } },
      { ledgerName: PARTY, amount: 101, isDeemedPositive: false, isPartyLedger: true,
        billAllocations: [{ name: "", billType: "On Account", amount: 101 }] },
    ],
  } as unknown as VoucherPayload;
}
const goodLines = [{ name: BANK, amount: "-101.00", dr: true, bank: true }, { name: PARTY, amount: "101.00", dr: false, bill: true }];
const noPartyLines = [{ name: BANK, amount: "-101.00", dr: true, bank: true }, { name: OTHER, amount: "101.00", dr: false, bill: true }];

(async () => {
  console.log("\n  Party match on a stored voucher (bank-mail lane)\n");
  const post = (xml: string) => async () => xml;

  // ── findInTally ────────────────────────────────────────────────────────────
  for (const type of ["Receipt", "Payment", "Contra"]) {
    const p = payload(type, `ZZTESTBM0000000${type.length}`);
    const found = await findInTally(post(reply(stored({ type, number: p.voucherNumber!, header: BANK, lines: goodLines }))), "ZZ CO", p);
    ok(`findInTally finds a ${type} whose header says the bank when the party is on a ledger line`, found.length === 1, `${found.length} found`);
  }
  {
    const p = payload("Receipt", "ZZTESTBM00000001");
    const none = await findInTally(post(reply(stored({ type: "Receipt", number: p.voucherNumber!, header: BANK, lines: noPartyLines }))), "ZZ CO", p);
    ok("findInTally does NOT find a Receipt whose lines lack the party (header says the bank)", none.length === 0, `${none.length} found`);
    // diffStored is clean here (both money lines are stored), so only the party rule can refuse this one.
    const askedOther = await findInTally(post(reply(stored({ type: "Receipt", number: p.voucherNumber!, header: BANK, lines: goodLines }))), "ZZ CO", { ...p, partyLedgerName: OTHER });
    ok("findInTally does NOT find a Receipt when the party we sent is on none of its lines (money lines all match)", askedOther.length === 0, askedOther.length + " found");
    const twice = await findInTally(post(reply(
      stored({ type: "Receipt", number: p.voucherNumber!, header: BANK, lines: goodLines }),
      stored({ type: "Receipt", number: p.voucherNumber!, header: BANK, lines: goodLines }))), "ZZ CO", p);
    ok("findInTally still reports every match (the caller applies the exactly-one rule)", twice.length === 2, `${twice.length}`);
    const wrongNo = await findInTally(post(reply(stored({ type: "Receipt", number: "ZZTESTBM99999999", header: BANK, lines: goodLines }))), "ZZ CO", p);
    ok("findInTally still requires the number to match", wrongNo.length === 0);
    const wrongType = await findInTally(post(reply(stored({ type: "Payment", number: p.voucherNumber!, header: BANK, lines: goodLines }))), "ZZ CO", p);
    ok("findInTally still requires the voucher type to match", wrongType.length === 0);
    const diff = await findInTally(post(reply(stored({ type: "Receipt", number: p.voucherNumber!, header: BANK,
      lines: [{ name: BANK, amount: "-102.00", dr: true, bank: true }, { name: PARTY, amount: "102.00", dr: false, bill: true }] }))), "ZZ CO", p);
    ok("findInTally still requires diffStored to be clean (a different amount is not found)", diff.length === 0);
  }
  {
    // A Sales voucher keeps the header match: its header holds the party.
    const s = { ...payload("Sales", "ZZTEST000001/S1"), partyLedgerName: PARTY } as VoucherPayload;
    const salesLines = [{ name: PARTY, amount: "-101.00", dr: true }, { name: "SALES", amount: "101.00", dr: false }];
    s.ledgerEntries = [
      { ledgerName: PARTY, amount: 101, isDeemedPositive: true, isPartyLedger: true },
      { ledgerName: "SALES", amount: 101, isDeemedPositive: false, isPartyLedger: false },
    ] as VoucherPayload["ledgerEntries"];
    const headerOk = await findInTally(post(reply(stored({ type: "Sales", number: s.voucherNumber!, header: PARTY, lines: salesLines }))), "ZZ CO", s);
    ok("findInTally finds a Sales voucher whose header is the party", headerOk.length === 1, `${headerOk.length}`);
    const headerOther = await findInTally(post(reply(stored({ type: "Sales", number: s.voucherNumber!, header: OTHER, lines: salesLines }))), "ZZ CO", s);
    ok("findInTally does NOT find a Sales voucher whose header is another party, even if a line names ours", headerOther.length === 0, `${headerOther.length}`);
  }

  // ── pickByMoney (safePush's fallback) ──────────────────────────────────────
  {
    const p = payload("Receipt", "ZZTESTBM00000001");
    const good = stored({ type: "Receipt", number: "ZZTESTBM77777777", header: BANK, lines: goodLines });
    ok("pickByMoney finds a Receipt whose header says the bank when the party is on a ledger line", pickByMoney([good], p) === good);
    ok("pickByMoney does NOT pick a Receipt whose lines lack the party",
      pickByMoney([stored({ type: "Receipt", number: "ZZTESTBM77777777", header: BANK, lines: noPartyLines })], p) === undefined);
    ok("pickByMoney does NOT pick a Receipt when the party we sent is on none of its lines (money lines all match)",
      pickByMoney([good], { ...p, partyLedgerName: OTHER }) === undefined);
    ok("pickByMoney keeps the one-candidate rule: two look-alikes pick nothing",
      pickByMoney([good, stored({ type: "Receipt", number: "ZZTESTBM88888888", header: BANK, lines: goodLines })], p) === undefined);
    ok("pickByMoney still requires the type to match",
      pickByMoney([stored({ type: "Payment", number: "ZZTESTBM77777777", header: BANK, lines: goodLines })], p) === undefined);
    ok("pickByMoney still requires diffStored to be clean",
      pickByMoney([stored({ type: "Receipt", number: "ZZTESTBM77777777", header: BANK,
        lines: [{ name: BANK, amount: "-102.00", dr: true, bank: true }, { name: PARTY, amount: "102.00", dr: false, bill: true }] })], p) === undefined);
    const s = payload("Sales", "ZZTEST000001/S1");
    s.ledgerEntries = [
      { ledgerName: PARTY, amount: 101, isDeemedPositive: true, isPartyLedger: true },
      { ledgerName: "SALES", amount: 101, isDeemedPositive: false, isPartyLedger: false },
    ] as VoucherPayload["ledgerEntries"];
    const salesLines = [{ name: PARTY, amount: "-101.00", dr: true }, { name: "SALES", amount: "101.00", dr: false }];
    const sv = stored({ type: "Sales", number: "ZZTEST000001/S1", header: PARTY, lines: salesLines });
    ok("pickByMoney finds a Sales voucher whose header is the party", pickByMoney([sv], s) === sv);
    ok("pickByMoney does NOT pick a Sales voucher whose header is another party",
      pickByMoney([stored({ type: "Sales", number: "ZZTEST000001/S1", header: OTHER, lines: salesLines })], s) === undefined);
  }

  // ── the one helper and its one home for the set ────────────────────────────
  {
    const r = stored({ type: "Receipt", number: "ZZTESTBM00000001", header: BANK, lines: goodLines });
    ok("partyMatchesStored: Receipt, party on a line", partyMatchesStored(payload("Receipt", "x"), r));
    ok("partyMatchesStored: Receipt, header alone is not enough", !partyMatchesStored(payload("Receipt", "x"), stored({ type: "Receipt", number: "x", header: PARTY, lines: noPartyLines })));
    ok("partyMatchesStored: the type is compared without regard to case", partyMatchesStored({ ...payload("Receipt", "x"), voucherType: "RECEIPT" } as unknown as VoucherPayload, r));
    ok("PARTY_OVERWRITTEN is exported from pushGuard and holds Payment, Receipt and Contra only",
      PARTY_OVERWRITTEN.size === 3 && ["Payment", "Receipt", "Contra"].every((t) => PARTY_OVERWRITTEN.has(t)));
    ok("partyIsOverwritten: Sales, Purchase, Journal are not", !["Sales", "Purchase", "Journal", "Debit Note"].some(partyIsOverwritten));
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
