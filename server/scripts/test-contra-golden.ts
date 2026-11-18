/**
 * Lane agent-poll part 2 (18-Nov-2026), offline: the Contra voucher (a move between the company's own bank accounts, or cash and bank) as the
 * agent builds it. The web app will draft own-account bank transfers as Contra; this pins what reaches Tally so a later change to the builder
 * cannot alter it unseen. No Tally, no database, fake ledger names only (ZZ BANK ONE, ZZ BANK TWO, ZZ CASH).
 *   - a golden copy of the whole XML of a bank-to-bank Contra (two bank ledgers, one debit and one credit);
 *   - the sides: the destination is debited (ISDEEMEDPOSITIVE Yes, negative amount), the source credited (No, positive amount), equal;
 *   - the REMOTEID carries the ERP number; the number follows the Contra series ERP-{N}/{FY};
 *   - a Contra carries no GST or party identity, no bill allocation;
 *   - the guard accepts it, and refuses the wrong ones (no REMOTEID, a REMOTEID without the number, a number already in Tally, one side only);
 *   - Alter, Cancel and Delete carry ACTION and the same REMOTEID.
 * The builder is the same one Receipt and Payment use (voucherPusher.buildVoucherImportXml); nothing was added to it for Contra.
 *
 *   npx tsx scripts/test-contra-golden.ts
 */
import { buildVoucherImportXml } from "../src/services/voucherPusher.js";
import { guardVoucher } from "../src/services/pushGuard.js";
import { seriesDefaultFor, formatSeriesNumber, isErpSeriesNumber, numberTakenBy } from "../src/services/voucherSeries.js";
import type { TallyMasters } from "../src/services/tallyMasters.js";
import type { VoucherPayload } from "../src/types.js";
import { fixtureMasters } from "./guardrails/fixtures.js";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
};

const m = fixtureMasters();
const ledgers = new Map(m.ledgers);
const bank = (n: string) => ({ name: n, parent: "Bank Accounts", gstin: "", state: "", pincode: "", mailingName: "", address: [], registrations: [] } as never);
for (const n of ["ZZ BANK ONE", "ZZ BANK TWO"]) ledgers.set(n, bank(n));
ledgers.set("ZZ CASH", { ...(bank("ZZ CASH") as object), parent: "Cash-in-Hand" } as never);
const M = { ...m, ledgers, ledgerLoose: new Map([...ledgers.keys()].map((k) => [k.replace(/\s+/g, " ").trim().toUpperCase(), k])) } as unknown as TallyMasters;

const utr = (favouring: string) => ({ transactionType: "Others", transferMode: "NEFT", instrumentNumber: "ZZUTR0001", favouring });
const NUMBER = "ERP-7/26-27";
const contra = (over: Partial<VoucherPayload> = {}): VoucherPayload => ({
  voucherType: "Contra", date: "2026-11-18", voucherNumber: NUMBER, remoteId: `MKCP|Contra|${NUMBER}`, narration: "ZZTEST own transfer",
  partyLedgerName: "ZZ BANK TWO", isInvoice: false,
  ledgerEntries: [
    { ledgerName: "ZZ BANK TWO", amount: 25000, isDeemedPositive: true, isPartyLedger: false, bankAllocation: utr("ZZ BANK TWO") },
    { ledgerName: "ZZ BANK ONE", amount: 25000, isDeemedPositive: false, isPartyLedger: false, bankAllocation: utr("ZZ BANK ONE") },
  ],
  ...over,
} as VoucherPayload);

/** One line per tag, no blank lines, so the golden below is about the content and not the indentation. */
const flat = (xml: string) => xml.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");

const GOLDEN = `<ENVELOPE>
<HEADER>
<TALLYREQUEST>Import Data</TALLYREQUEST>
</HEADER>
<BODY>
<IMPORTDATA>
<REQUESTDESC>
<REPORTNAME>Vouchers</REPORTNAME>
<STATICVARIABLES>
<SVCURRENTCOMPANY>ZZ DUMMY CO</SVCURRENTCOMPANY>
</STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER REMOTEID="MKCP|Contra|ERP-7/26-27" VCHTYPE="Contra" ACTION="Create" OBJVIEW="Accounting Voucher View">
<DATE>20261118</DATE>
<VOUCHERTYPENAME>Contra</VOUCHERTYPENAME>
<ISINVOICE>No</ISINVOICE>
<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>
<VOUCHERNUMBER>ERP-7/26-27</VOUCHERNUMBER>
<NARRATION>ZZTEST own transfer</NARRATION>
<PARTYLEDGERNAME>ZZ BANK TWO</PARTYLEDGERNAME>
<ALLLEDGERENTRIES.LIST>
<LEDGERNAME>ZZ BANK TWO</LEDGERNAME>
<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
<ISPARTYLEDGER>No</ISPARTYLEDGER>
<AMOUNT>-25000.00</AMOUNT>
<BANKALLOCATIONS.LIST>
<DATE>20261118</DATE>
<INSTRUMENTDATE>20261118</INSTRUMENTDATE>
<BANKERSDATE>20261118</BANKERSDATE>
<TRANSACTIONTYPE>Others</TRANSACTIONTYPE>
<TRANSFERMODE>NEFT</TRANSFERMODE>
<INSTRUMENTNUMBER>ZZUTR0001</INSTRUMENTNUMBER>
<PAYMENTFAVOURING>ZZ BANK TWO</PAYMENTFAVOURING>
<BANKPARTYNAME>ZZ BANK TWO</BANKPARTYNAME>
<PAYMENTMODE>Transacted</PAYMENTMODE>
<STATUS>No</STATUS>
<AMOUNT>-25000.00</AMOUNT>
</BANKALLOCATIONS.LIST>
</ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST>
<LEDGERNAME>ZZ BANK ONE</LEDGERNAME>
<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
<ISPARTYLEDGER>No</ISPARTYLEDGER>
<AMOUNT>25000.00</AMOUNT>
<BANKALLOCATIONS.LIST>
<DATE>20261118</DATE>
<INSTRUMENTDATE>20261118</INSTRUMENTDATE>
<BANKERSDATE>20261118</BANKERSDATE>
<TRANSACTIONTYPE>Others</TRANSACTIONTYPE>
<TRANSFERMODE>NEFT</TRANSFERMODE>
<INSTRUMENTNUMBER>ZZUTR0001</INSTRUMENTNUMBER>
<PAYMENTFAVOURING>ZZ BANK ONE</PAYMENTFAVOURING>
<BANKPARTYNAME>ZZ BANK ONE</BANKPARTYNAME>
<PAYMENTMODE>Transacted</PAYMENTMODE>
<STATUS>No</STATUS>
<AMOUNT>25000.00</AMOUNT>
</BANKALLOCATIONS.LIST>
</ALLLEDGERENTRIES.LIST>
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA>
</BODY>
</ENVELOPE>`;

(async () => {
  console.log("\n  the XML of a bank-to-bank Contra");
  const xml = buildVoucherImportXml("ZZ DUMMY CO", contra(), M);
  ok("the whole XML matches the golden copy", flat(xml) === GOLDEN, (() => { const a = flat(xml).split("\n"), b = GOLDEN.split("\n"); const i = a.findIndex((l, k) => l !== b[k]); return `first difference at line ${i + 1}: got "${a[i]}", want "${b[i]}"`; })());
  const entries = [...xml.matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/g)].map((x) => x[1]);
  ok("two ledger lines, both bank ledgers, written as ALLLEDGERENTRIES (an accounting voucher)", entries.length === 2 && !/<LEDGERENTRIES\.LIST>/.test(xml) && /ZZ BANK TWO/.test(entries[0]) && /ZZ BANK ONE/.test(entries[1]));
  const sides = entries.map((e) => ({ dr: /<ISDEEMEDPOSITIVE>Yes</.test(e), amt: Number(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/.exec(e)![1]) }));
  ok("one debit (Yes, negative) and one credit (No, positive), the same amount, summing to zero", sides[0].dr && sides[0].amt === -25000 && !sides[1].dr && sides[1].amt === 25000 && sides[0].amt + sides[1].amt === 0);
  ok("the header party is the debited bank (Tally's own convention for a Contra)", /<PARTYLEDGERNAME>ZZ BANK TWO<\/PARTYLEDGERNAME>/.test(xml));
  ok("the voucher is not an invoice and carries no GST, place of supply, party identity or bill allocation", /<ISINVOICE>No<\/ISINVOICE>/.test(xml) && !/GSTIN|PLACEOFSUPPLY|STATENAME|PARTYMAILINGNAME|BILLALLOCATIONS|ALLINVENTORYENTRIES|GSTREGISTRATIONTYPE/.test(xml));
  ok("both banks carry the instrument (UTR) so Tally does not stop to ask", (xml.match(/<BANKALLOCATIONS\.LIST>/g) ?? []).length === 2);
  ok("the date is the day the owner chose, in Tally's form", /<DATE>20261118<\/DATE>/.test(xml));

  console.log("\n  cash to bank, and bank to cash");
  const dep = contra({ partyLedgerName: "ZZ BANK ONE", ledgerEntries: [
    { ledgerName: "ZZ BANK ONE", amount: 1234.5, isDeemedPositive: true, isPartyLedger: false, bankAllocation: utr("ZZ CASH") },
    { ledgerName: "ZZ CASH", amount: 1234.5, isDeemedPositive: false, isPartyLedger: false },
  ] });
  const dx = buildVoucherImportXml("ZZ DUMMY CO", dep, M);
  ok("cash to bank: the bank is debited with its instrument, the cash credited with none, to the paisa", /<AMOUNT>-1234\.50<\/AMOUNT>/.test(dx) && /<AMOUNT>1234\.50<\/AMOUNT>/.test(dx) && (dx.match(/<BANKALLOCATIONS\.LIST>/g) ?? []).length === 1);

  console.log("\n  numbering and identity");
  const series = seriesDefaultFor("Contra");
  ok("a Contra uses the ERP series ERP-{N}/{FY}, counted from the ERP's own highest", series?.template === "ERP-{N}/{FY}" && series.seedSource === "erp_own");
  ok("the seventh Contra of 2026-27 is ERP-7/26-27", formatSeriesNumber(series!.template, "2026-27", 7, series!.width) === NUMBER && isErpSeriesNumber(NUMBER, "Contra", "2026-11-18"));
  const next = contra({ voucherNumber: "ERP-8/26-27", remoteId: "MKCP|Contra|ERP-8/26-27" });
  ok("two Contras never share a REMOTEID (the number is part of it)", next.remoteId !== contra().remoteId && buildVoucherImportXml("ZZ DUMMY CO", next, M).includes('REMOTEID="MKCP|Contra|ERP-8/26-27"'));
  ok("a number already in Tally is found (case and padding do not hide it)", numberTakenBy({ voucherType: "Contra", voucherNumber: NUMBER, date: "2026-11-18" }, ["erp-07/26-27"]) !== null && numberTakenBy({ voucherType: "Contra", voucherNumber: NUMBER, date: "2026-11-18" }, ["ERP-6/26-27"]) === null);

  console.log("\n  the guard");
  const g = guardVoucher(contra(), M, {});
  /* One warning is expected and harmless: a bank ledger has no state, and the guard says so for the header party even on a Contra, which carries no GST.
     It is reported to the coordinator (pushGuard is not this lane's to change). Any OTHER warning, such as the bank-instrument one, would be new. */
  const otherWarnings = g.warnings.filter((w) => !/has no state on its ledger master/.test(w));
  ok("the guard accepts the golden Contra, with no warning except the known 'bank ledger has no state' one", g.ok && g.errors.length === 0 && otherWarnings.length === 0, `${g.errors.join(" | ")} || ${g.warnings.join(" | ")}`);
  const noInstr = guardVoucher(contra({ ledgerEntries: contra().ledgerEntries.map((e) => ({ ...e, bankAllocation: undefined })) }), M, {});
  ok("without the UTR the guard warns that Tally will stop and ask (why the web app must send the instrument)", noInstr.warnings.filter((w) => /instrument/.test(w)).length === 2, noInstr.warnings.join(" | "));
  const noRid = guardVoucher(contra({ remoteId: undefined }), M, {});
  ok("a Create with no REMOTEID is refused", !noRid.ok, noRid.errors.join(" | "));
  const wrongRid = guardVoucher(contra({ remoteId: "MKCP|Contra|ERP-99/26-27" }), M, {});
  ok("a REMOTEID that does not carry its ERP number is refused", !wrongRid.ok && /does not carry it/.test(wrongRid.errors.join(" ")), wrongRid.errors.join(" | "));
  const oneSide = contra({ ledgerEntries: [contra().ledgerEntries[0]] });
  let oneSideRefused = false;
  try { oneSideRefused = !guardVoucher(oneSide, M, {}).ok; } catch { oneSideRefused = true; }
  if (!oneSideRefused) { try { buildVoucherImportXml("ZZ DUMMY CO", oneSide, M); } catch { oneSideRefused = true; } }
  ok("a Contra with only one side never reaches Tally (the guard or the builder refuses)", oneSideRefused);
  let imbalanced = "";
  try { buildVoucherImportXml("ZZ DUMMY CO", contra({ ledgerEntries: [{ ...contra().ledgerEntries[0] }, { ...contra().ledgerEntries[1], amount: 24999 }] }), M); } catch (e) { imbalanced = (e as Error).message; }
  ok("an unbalanced Contra throws before any request is built", /Dr\/Cr imbalance/.test(imbalanced), imbalanced);
  const unknown = guardVoucher(contra({ ledgerEntries: [{ ...contra().ledgerEntries[0], ledgerName: "ZZ NO SUCH BANK" }, contra().ledgerEntries[1]], partyLedgerName: "ZZ NO SUCH BANK" }), M, {});
  ok("a ledger Tally does not hold is refused", !unknown.ok, unknown.errors.join(" | "));

  console.log("\n  Alter, Cancel and Delete");
  for (const action of ["Alter", "Cancel", "Delete"] as const) {
    const x = buildVoucherImportXml("ZZ DUMMY CO", contra({ action }), M);
    ok(`${action}: ACTION="${action}" and the same REMOTEID`, new RegExp(`ACTION="${action}"`).test(x) && x.includes('REMOTEID="MKCP|Contra|ERP-7/26-27"'));
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
