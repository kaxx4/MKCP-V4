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
function stored(o: { type: string; number: string; header: string; lines: { name: string; amount: string; dr: boolean; bank?: boolean; bill?: boolean; plain?: boolean }[]; narration?: string; placeholders?: number }): string {
  const lines = o.lines.map((l) => { const T = l.plain ? "LEDGERENTRIES.LIST" : "ALLLEDGERENTRIES.LIST"; return `<${T}>
<LEDGERNAME>${l.name}</LEDGERNAME><ISDEEMEDPOSITIVE>${l.dr ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${l.amount}</AMOUNT>
${l.bank ? "<BANKALLOCATIONS.LIST><INSTRUMENTNUMBER>ZZBMDUMMY01</INSTRUMENTNUMBER><TRANSACTIONTYPE>Cheque/DD</TRANSACTIONTYPE><AMOUNT>-101.00</AMOUNT></BANKALLOCATIONS.LIST>" : ""}
${l.bill ? "<BILLALLOCATIONS.LIST><NAME></NAME><BILLTYPE>On Account</BILLTYPE><AMOUNT>101.00</AMOUNT></BILLALLOCATIONS.LIST>" : ""}
</${T}>`; }).join("\n") + "\n<ALLLEDGERENTRIES.LIST></ALLLEDGERENTRIES.LIST>".repeat(o.placeholders ?? 0);
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
    // The money lines are identical to the payload's, so diffStored is clean and only the party rule can refuse these.
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
    ok("partyMatchesStored: Receipt, header alone is not enough", !partyMatchesStored({ ...payload("Receipt", "x"), partyLedgerName: OTHER }, stored({ type: "Receipt", number: "x", header: OTHER, lines: goodLines })));
    ok("partyMatchesStored: the type is compared without regard to case", partyMatchesStored({ ...payload("Receipt", "x"), voucherType: "RECEIPT" } as unknown as VoucherPayload, r));
    ok("PARTY_OVERWRITTEN is exported from pushGuard and holds Payment, Receipt and Contra only",
      PARTY_OVERWRITTEN.size === 3 && ["Payment", "Receipt", "Contra"].every((t) => PARTY_OVERWRITTEN.has(t)));
    ok("partyIsOverwritten: Sales, Purchase, Journal are not", !["Sales", "Purchase", "Journal", "Debit Note"].some(partyIsOverwritten));
  }


  // ── Review 8-Nov-2026 (L2 to L5): line count, which list, exact names, empty party, child types ───────
  {
    const p = payload("Receipt", "ZZTESTBM00000001");
    // L2: the 8-Nov bank-mail voucher has 2 lines and still matches, with or without empty placeholder blocks.
    ok("L2 a normal 2-line bank-mail voucher still matches", partyMatchesStored(p, stored({ type: "Receipt", number: "x", header: BANK, lines: goodLines })));
    ok("L2 empty placeholder blocks are not counted as lines", partyMatchesStored(p, stored({ type: "Receipt", number: "x", header: BANK, lines: goodLines, placeholders: 2 })));
    // A combined payment: the payload sends 2 lines, the stored voucher holds those 2 plus 2 more. diffStored accepts a subset.
    const pay = payload("Payment", "ZZTEST000001/P1");
    const four = [
      { name: BANK, amount: "-101.00", dr: true, bank: true }, { name: PARTY, amount: "101.00", dr: false, bill: true },
      { name: OTHER, amount: "55.00", dr: false }, { name: "CASH", amount: "-55.00", dr: true },
    ];
    const combined = stored({ type: "Payment", number: "ZZTEST000001/P1", header: BANK, lines: four });
    ok("L2 a combined 4-line voucher is NOT found for a 2-line payload", !partyMatchesStored(pay, combined));
    ok("L2 findInTally does not find the combined voucher", (await findInTally(post(reply(combined)), "ZZ CO", pay)).length === 0);
    ok("L2 pickByMoney does not pick the combined voucher", pickByMoney([combined], pay) === undefined);
    const pay4 = { ...pay, ledgerEntries: [...pay.ledgerEntries,
      { ledgerName: OTHER, amount: 55, isDeemedPositive: false, isPartyLedger: false }, { ledgerName: "CASH", amount: 55, isDeemedPositive: true, isPartyLedger: false }] } as VoucherPayload;
    ok("L2 a 4-line payload does find its own 4-line voucher", partyMatchesStored(pay4, combined) && (await findInTally(post(reply(combined)), "ZZ CO", pay4)).length === 1);
    ok("L2 the line count does not apply to a header-matched type (Sales keeps the header rule only)",
      partyMatchesStored({ voucherType: "Sales", partyLedgerName: PARTY } as VoucherPayload, stored({ type: "Sales", number: "x", header: PARTY, lines: four })));

    // L4: which list holds the lines. diffStored reads LEDGERENTRIES.LIST and ALLLEDGERENTRIES.LIST together; the repo rule says summing
    // both double-counts, so the party match reads ALLLEDGERENTRIES.LIST when it holds anything and the plain list otherwise.
    const plain = goodLines.map((l) => ({ ...l, plain: true }));
    ok("L4 the party only in a plain LEDGERENTRIES.LIST block (no ALL block) still matches", partyMatchesStored(p, stored({ type: "Receipt", number: "x", header: BANK, lines: plain })));
    ok("L4 findInTally finds a voucher whose lines are all in plain LEDGERENTRIES.LIST", (await findInTally(post(reply(stored({ type: "Receipt", number: p.voucherNumber!, header: BANK, lines: plain }))), "ZZ CO", p)).length === 1);
    ok("L4 the same lines listed in both blocks are counted once, not twice",
      partyMatchesStored(p, stored({ type: "Receipt", number: "x", header: BANK, lines: goodLines }).replace("</VOUCHER>", stored({ type: "Receipt", number: "x", header: BANK, lines: plain }).match(/<LEDGERENTRIES\.LIST>[\s\S]*<\/LEDGERENTRIES\.LIST>/)![0] + "</VOUCHER>")));
    ok("L4 when the ALL block holds other lines, a party only in the plain block is not enough (fails safe)",
      !partyMatchesStored({ ...p, partyLedgerName: OTHER }, stored({ type: "Receipt", number: "x", header: BANK, lines: [{ name: BANK, amount: "-101.00", dr: true, bank: true }, { name: PARTY, amount: "101.00", dr: false, bill: true }] })
        .replace("</VOUCHER>", "<LEDGERENTRIES.LIST><LEDGERNAME>" + OTHER + "</LEDGERNAME><AMOUNT>1.00</AMOUNT></LEDGERENTRIES.LIST></VOUCHER>")));

    // L4: names stay exact.
    ok("L4 a party name that differs by case is not found", !partyMatchesStored({ ...p, partyLedgerName: PARTY.toLowerCase() }, stored({ type: "Receipt", number: "x", header: BANK, lines: goodLines })));
    ok("L4 a party name with a trailing space is not found", !partyMatchesStored({ ...p, partyLedgerName: PARTY + " " }, stored({ type: "Receipt", number: "x", header: BANK, lines: goodLines })));
    ok("L4 findInTally keeps the name exact (case, money lines identical)", (await findInTally(post(reply(stored({ type: "Receipt", number: p.voucherNumber!, header: BANK, lines: goodLines }))), "ZZ CO", { ...p, partyLedgerName: PARTY.toLowerCase() })).length === 0);
    ok("L4 pickByMoney keeps the name exact (trailing space, money lines identical)", pickByMoney([stored({ type: "Receipt", number: "x", header: BANK, lines: goodLines })], { ...p, partyLedgerName: PARTY + " " }) === undefined);

    // L3: an empty party on these types never matches in the money fallback; the number path (findInTally) still works.
    for (const t of ["Payment", "Receipt", "Contra"]) {
      const e = { ...payload(t, "ZZTESTBM0000000" + t.length), partyLedgerName: "" } as VoucherPayload;
      const v = stored({ type: t, number: e.voucherNumber!, header: BANK, lines: goodLines });
      ok("L3 " + t + ": an empty party is never matched by the money fallback", pickByMoney([v], e) === undefined && !partyMatchesStored(e, v));
      ok("L3 " + t + ": findInTally with an empty party still finds it by number", (await findInTally(post(reply(v)), "ZZ CO", e)).length === 1);
    }

    // L4: a Contra with cash and bank only (its party is the bank or cash ledger itself).
    const contra = { voucherType: "Contra", date: DAY, voucherNumber: "ZZTEST000002/C1", partyLedgerName: BANK, narration: "ZZTEST contra",
      ledgerEntries: [{ ledgerName: BANK, amount: 500, isDeemedPositive: true, isPartyLedger: false }, { ledgerName: "Cash", amount: 500, isDeemedPositive: false, isPartyLedger: false }] } as unknown as VoucherPayload;
    const cv = stored({ type: "Contra", number: "ZZTEST000002/C1", header: "Cash", narration: "ZZTEST contra",
      lines: [{ name: BANK, amount: "-500.00", dr: true }, { name: "Cash", amount: "500.00", dr: false }] });
    ok("L4 a Contra of cash and bank only: found although the header says Cash", (await findInTally(post(reply(cv)), "ZZ CO", contra)).length === 1 && pickByMoney([cv], contra) === cv);
    ok("L4 a Contra is not found when the party is on neither line (money lines identical)", pickByMoney([cv], { ...contra, partyLedgerName: PARTY } as VoucherPayload) === undefined);

    // L4: a lower-case type from a payload.
    const lower = { ...payload("Payment", "ZZTEST000003/P1"), voucherType: "payment" } as unknown as VoucherPayload;
    const lv = stored({ type: "Payment", number: "ZZTEST000003/P1", header: BANK, lines: goodLines });
    ok("L4 findInTally finds a voucher for a lower-case 'payment' type", (await findInTally(post(reply(lv)), "ZZ CO", lower)).length === 1);
    ok("L4 pickByMoney finds it for a lower-case 'payment' type", pickByMoney([lv], lower) === lv);

    // L5: a child type such as "Bank Receipt" is not one of the three, so it keeps the header compare and fails safe.
    const child = { ...payload("Bank Receipt", "ZZTEST000004/R1") } as unknown as VoucherPayload;
    const chv = stored({ type: "Bank Receipt", number: "ZZTEST000004/R1", header: BANK, lines: goodLines });
    ok("L5 a child type 'Bank Receipt' with a bank header is NOT found (header compare, fails safe)", !partyMatchesStored(child, chv) && pickByMoney([chv], child) === undefined);
    ok("L5 a child type is found only when its header is the party", partyMatchesStored(child, stored({ type: "Bank Receipt", number: "x", header: PARTY, lines: goodLines })));
  }

  // L1: one case-free type compare, one home.
  {
    const safe = await import("../src/services/safePush.js");
    const agent = await import("../src/services/erpJobAgent.js");
    ok("L1 sameVoucherType lives in safePush and erpJobAgent re-exports that same function", safe.sameVoucherType === agent.sameVoucherType);
    ok("L1 it compares without regard to case or spaces", safe.sameVoucherType(" sales ", "SALES") && !safe.sameVoucherType("Sales", "Purchase"));
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
