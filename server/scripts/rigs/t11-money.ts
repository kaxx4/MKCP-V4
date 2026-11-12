/**
 * T11 money-voucher matrix on the dummy Tally (D-M.164): Receipt, Payment and Contra, every bill allocation
 * type, cash and bank instruments, a ledger that is not bill-by-bill, an expense payment, TDS, and
 * Alter / Cancel / Delete of one of each. Every voucher is pushed through safePush and then read back from
 * Tally field by field (t11Check.compareToPayload), the bill picture is read from Tally's own open bills, and
 * the totals are tied to the paisa.
 *
 * One part per run (each is self-contained, makes its own ZZ TEST ledgers, and removes everything):
 *   npx tsx scripts/rigs/t11-money.ts --part receipts   [--out f.json] [--expect N]
 *   npx tsx scripts/rigs/t11-money.ts --part payments
 *   npx tsx scripts/rigs/t11-money.ts --part contras    (also Alter / Cancel / Delete of a Receipt, Payment, Contra)
 *   npx tsx scripts/rigs/t11-money.ts --part modes      (D-M.197: the bank transfer modes the web sends, Cheque/UPI/NEFT/RTGS, spelling read back)
 *   npx tsx scripts/rigs/t11-money.ts --cleanup <stamp>
 *
 * Run from server/. Sandbox role and loopback are enforced by guardScriptWrites and the preflight; fake data only.
 */
import "dotenv/config";
import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";
guardScriptWrites("rigs/t11-money");
import { preflight } from "./lib/t11.js";
import { DUMMY_KIT, r2 } from "./lib/t11Kit.js";
import { alteredCopy, moneyScenario, modeCases, variant, type BillExpect, type MoneyCase } from "./lib/t11Money.js";
import { compareToPayload, failures, ledgerBrief } from "./lib/t11Check.js";
import { Recorder, byKey, census, countStored, dropItem, dropParty, freshMasters, indiaToday, makeItem, makeLive, makeParty, push, readLedgerFlags, readStored, remove, stampFrom, sweepDay, asCancel, turn, TallyDownError, stopForTallyDown, gate, type Live } from "./lib/t11Live.js";
import { loadOpenBills } from "../../src/services/billSettlement.js";
import { readTag, parseTallyAmount } from "../../src/services/xml.js";
import { pull as pullAll, remoteIdGuesses } from "../find-stranded-test-vouchers.js";
import { tallyPost } from "../../src/tally.js";
import { escapeXml } from "../../src/services/xml.js";
import type { VoucherPayload } from "../../src/types.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const PART = (arg("--part") ?? "").toLowerCase();
const OUT = arg("--out");
const CLEANUP = arg("--cleanup");
const kit = DUMMY_KIT;
const num = (s: string) => parseTallyAmount(s) ?? NaN;
/** Checks expected from each part's first full run; -1 = not calibrated yet. */
const EXPECTED: Record<string, number> = { receipts: 126, payments: 100, contras: 61, modes: 74 };

class Made {
  vouchers: VoucherPayload[] = []; parties: string[] = []; items: string[] = [];
  track(p: VoucherPayload) { const i = this.vouchers.findIndex((v) => v.remoteId === p.remoteId); if (i >= 0) this.vouchers[i] = p; else this.vouchers.push(p); }
}

/** Signed sum of every ledger line of a stored voucher (Tally: debit negative). Zero when the voucher balances. */
const ledgerSum = (v: string): number => r2([...v.matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/g)].reduce((a, m) => a + num(readTag(m[1], "AMOUNT")), 0));
const lineOf = (v: string, name: string): string | undefined =>
  [...v.matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/g)].map((m) => m[1]).find((b) => readTag(b, "LEDGERNAME") === name);

async function body(part: string, l: Live, rec: Recorder, made: Made): Promise<void> {
  const day = l.day, stamp = l.stamp;
  const m0 = await freshMasters(l);
  const tdsLedger = [...m0.ledgers.values()].find((x) => /TDS/i.test(x.name) && /(duties|taxes|liabilit)/i.test(x.parent))?.name;
  const secondBank = [...m0.ledgers.values()].find((x) => /^bank accounts$/i.test(x.parent) && x.name !== kit.bank)?.name;
  rec.note(`TDS ledger in the dummy: ${tdsLedger ?? "NONE (the TDS case is NOT RUN)"}; second bank ledger: ${secondBank ?? "NONE (bank to bank is NOT RUN)"}`);
  const s = moneyScenario(stamp, day, kit, { tdsLedger, secondBank });
  const D = s.parties.debtor.name, C = s.parties.carrier.name, E = s.parties.expense.name, N = s.parties.plainDebtor.name;

  const stored = (p: VoucherPayload) => readStored(l, p.date, byKey(p));
  const send = async (label: string, p: VoucherPayload) => {
    made.track(p);   // before the push: if Tally accepts it and the read-back then fails, teardown still deletes it
    const r = await push(l, p);
    rec.check(label, r.ok, r.ok ? `stage ${r.stage}${r.differences.length ? `; differences: ${r.differences.join(" | ").slice(0, 160)}` : ""}` : `stage ${r.stage}: ${[...r.errors, ...r.differences].join(" | ").slice(0, 300)}`);
    return r;
  };
  const fieldCheck = (label: string, p: VoucherPayload, v: string | null, overwritten: boolean) => {
    if (!v) { rec.check(`${label}: every field we sent reads back as sent`, false, "the voucher could not be read"); return; }
    const res = compareToPayload(p, v, { partyOverwritten: overwritten, derivedPostings: true });
    const bad = failures(res);
    rec.check(`${label}: every field we sent reads back as sent (${res.length} fields)`, bad.length === 0, bad.slice(0, 8).join(" | "));
    if (bad.length) rec.note(`${label} stored ledger lines: ${ledgerBrief(v)}`);
  };
  const billsNow = async () => turn(l, "open bills", () => loadOpenBills(l.url, l.company));
  const judgeBills = async (id: string, expect: BillExpect[] | undefined) => {
    if (!expect?.length) return;
    const open = await billsNow();
    for (const e of expect) {
      const b = open.find((x) => x.party === e.party && x.name === e.name);
      const remaining = b ? r2(Math.abs(b.closing)) : 0;
      const sign = b ? (b.closing < 0 ? "receivable" : "payable") : "settled";
      const ok = Math.abs(remaining - e.remaining) < 0.011;
      if (e.judge === false) rec.note(`${id} bill "${e.name}" after the voucher: ${remaining} ${sign} (we expected ${e.remaining}; not judged)`);
      else rec.check(`${id} bill "${e.name}" is ${e.remaining === 0 ? "settled" : `left with ${e.remaining}`} in Tally's open bills`, ok, `${remaining} ${sign}`);
    }
  };

  /** One money voucher, all the checks. */
  const runCase = async (c: MoneyCase) => {
    const p = c.voucher;
    const r = await send(`${c.id} ${c.label}: pushed, read back by safePush`, p);
    if (!r.ok && r.stage !== "verify" && r.stage !== "done") { rec.note(`${c.id} stopped at stage ${r.stage}; the read-back checks are skipped`); return; }
    const v = await stored(p);
    fieldCheck(`${c.id}`, p, v, true);
    if (!v) return;
    rec.check(`${c.id} stored once`, (v.match(/<VOUCHERTYPENAME>/g) ?? []).length === 1);
    rec.check(`${c.id} the voucher balances to the paisa in Tally (signed lines add to nil)`, Math.abs(ledgerSum(v)) < 0.005, `${ledgerSum(v)}`);
    // The party and bank/cash lines land on the right sides.
    for (const e of p.ledgerEntries) {
      const b = lineOf(v, e.ledgerName);
      const side = b ? readTag(b, "ISDEEMEDPOSITIVE") : "";
      const amt = b ? num(readTag(b, "AMOUNT")) : NaN;
      rec.check(`${c.id} "${e.ledgerName.replace(/ZZ TEST /, "")}" is a ${e.isDeemedPositive ? "debit" : "credit"} of ${e.amount}`,
        !!b && (side === "Yes") === e.isDeemedPositive && Math.abs(Math.abs(amt) - e.amount) < 0.005 && (amt < 0) === e.isDeemedPositive, b ? `side ${side}, amount ${amt}` : "no such line");
    }
    await judgeBills(c.id, c.expect);
  };

  // ── ledgers and bills ───────────────────────────────────────────────────
  const need = part === "receipts" ? [s.parties.debtor, s.parties.plainDebtor] : part === "payments" ? [s.parties.carrier, s.parties.expense] : [s.parties.debtor, s.parties.carrier];   // contras and modes
  for (const p of need) { const r = await makeParty(l, p); made.parties.push(p.name); rec.check(`ledger "${p.name.replace(/ZZ TEST /, "")}" made with the production builder`, r.ok, r.detail); }
  await freshMasters(l);
  const flag = async (name: string, want: boolean) => {
    const f = await readLedgerFlags(l, name);
    rec.check(`ISBILLWISEON read from Tally for "${name.replace(/ZZ TEST /, "")}" is ${want ? "Yes" : "No"}, never assumed`, !!f && f.billWise === want, f ? `parent "${f.parent}", billwise ${f.billWise}` : "ledger not found");
  };
  if (part === "receipts") { await flag(D, true); await flag(N, false); }
  if (part === "payments") { await flag(C, true); await flag(E, false); }
  if (part === "contras" || part === "modes") { await flag(D, true); await flag(C, true); }
  for (const nm of [kit.cash, kit.bank]) { const f = await readLedgerFlags(l, nm); rec.note(`book ledger "${nm}": parent "${f?.parent}", bill-by-bill ${f?.billWise}`); }

  if (part === "receipts") {
    const ir = await makeItem(l, s.item); made.items.push(s.item.name); rec.check("item for the sales bills made", ir.ok, ir.detail);
    await freshMasters(l);
    for (const [i, v] of s.sales.entries()) {
      // The 9 bills of the C27 mix are S6..S14; all 14 are made so every case has its bill.
      await send(`bill S${i + 1}: sales invoice to the debtor, ${s.g[i]} (an open New Ref bill)`, v);
    }
    const open = await billsNow();
    rec.check("all 14 sales bills are open for the debtor with the right amounts", s.sales.every((v, i) => { const b = open.find((x) => x.party === D && x.name === v.voucherNumber); return !!b && Math.abs(Math.abs(b.closing) - s.g[i]) < 0.011 && b.closing < 0; }), `${open.filter((x) => x.party === D).length} open`);
    for (const c of s.cases.filter((x) => x.kind === "receipt")) await runCase(c);
    // The not-bill-wise ledger must carry no bill at all, and the debtor's On Account / Advance must be visible.
    const open2 = await billsNow();
    rec.check("the not-bill-by-bill ledger has no bill in Tally's open bills", !open2.some((x) => x.party === N));
    return;
  }

  if (part === "payments") {
    for (const [i, v] of s.freight.entries()) await send(`bill F${i + 1}: freight bill from the carrier, ${s.freightAmounts[i]} (an open payable)`, v);
    const open = await billsNow();
    rec.check("all 8 freight bills are open for the carrier as payables of the right amounts", s.freight.every((_, i) => { const b = open.find((x) => x.party === C && x.name === s.fBill(i)); return !!b && Math.abs(b.closing - s.freightAmounts[i]) < 0.011 && b.closing > 0; }), `${open.filter((x) => x.party === C).length} open`);
    for (const c of s.cases.filter((x) => x.kind === "payment")) await runCase(c);
    const open2 = await billsNow();
    rec.check("the expense ledger (not bill-by-bill) has no bill in Tally's open bills", !open2.some((x) => x.party === E));
    return;
  }

  if (part === "modes") {
    // Which spelling does Tally keep? Each stored bank allocation is read and its two strings are put on the record.
    const seen: string[] = [];
    for (const c of modeCases(stamp, day, kit, D, C)) {
      await runCase(c);
      const v = await stored(c.voucher);
      // The bank allocation sits on the BANK ledger's line. Other lines carry an empty placeholder, so the first block in the voucher is the wrong one to read.
      const bankLine = v ? lineOf(v, kit.bank) ?? "" : "";
      const ba = [...bankLine.matchAll(/<BANKALLOCATIONS\.LIST>[\s\S]*?<\/BANKALLOCATIONS\.LIST>/g)].map((x) => x[0]).find((b) => readTag(b, "TRANSACTIONTYPE") || readTag(b, "INSTRUMENTNUMBER")) ?? "";
      const sent = c.voucher.ledgerEntries.find((e) => e.bankAllocation)!.bankAllocation!;
      const got = { type: readTag(ba, "TRANSACTIONTYPE"), mode: readTag(ba, "TRANSFERMODE"), no: readTag(ba, "INSTRUMENTNUMBER") };
      seen.push(`${c.id}: sent type "${sent.transactionType}" mode "${sent.transferMode}" no "${sent.instrumentNumber}" -> stored type "${got.type}" mode "${got.mode}" no "${got.no}"`);
      rec.check(`${c.id} the bank allocation reads back with the same spelling (mode "${sent.transferMode}")`,
        !!ba && got.type === sent.transactionType && got.mode === sent.transferMode && got.no === sent.instrumentNumber, `stored type "${got.type}", mode "${got.mode}", number "${got.no}"`);
    }
    for (const line of seen) rec.note(`READ-BACK ${line}`);
    return;
  }

  if (part === "contras") {
    for (const c of s.cases.filter((x) => x.kind === "contra")) await runCase(c);
    // Alter / Cancel / Delete of one Receipt, one Payment, one Contra.
    for (const [what, base] of [["Receipt", s.lifeR], ["Payment", s.lifeP], ["Contra", s.lifeK]] as const) {
      const over = what !== "Contra" || true;
      const A = base, B = variant(base, "B");
      await send(`${what} life A created`, A);
      const alt = alteredCopy(A, 190, `ZZCHANGED${stamp}`);
      made.track(alt); const ra = await push(l, alt);
      rec.check(`${what} ALTER: amount 150 to 190, instrument number and narration changed, same REMOTEID`, ra.ok, ra.ok ? `stage ${ra.stage}` : [...ra.errors, ...ra.differences].join(" | ").slice(0, 300));
      const va = await stored(alt);
      fieldCheck(`${what} ALTER`, alt, va, over);
      rec.check(`${what} ALTER: still one voucher (no duplicate), narration is the new one`, (await countStored(l, day, { number: A.voucherNumber!, type: what })) === 1 && !!va && readTag(va, "NARRATION") === alt.narration);
      rec.check(`${what} ALTER: the voucher still balances`, !!va && Math.abs(ledgerSum(va)) < 0.005);
      const rd = await remove(l, alt);
      rec.check(`${what} DELETE: removed by REMOTEID and gone from the books`, rd.ok, rd.detail);
      made.vouchers = made.vouchers.filter((v) => v.remoteId !== alt.remoteId);
      await send(`${what} life B created (to be cancelled)`, B);
      const rc = await push(l, asCancel(B), { verify: false });
      rec.check(`${what} CANCEL: Tally accepts ACTION="Cancel" on it`, rc.ok, rc.ok ? "" : [...rc.errors, ...rc.differences].join(" | ").slice(0, 200));
      const vc = await stored(B);
      rec.check(`${what} CANCEL: it is now cancelled (ISCANCELLED Yes, or gone from the day's list)`, vc === null || /^yes$/i.test(readTag(vc, "ISCANCELLED")), vc ? `ISCANCELLED ${readTag(vc, "ISCANCELLED")}` : "not listed");
    }
    return;
  }
  throw new Error(`unknown part "${part}"`);
}

async function teardown(l: Live, rec: Recorder, made: Made, before: { total: number; ours: number } | null): Promise<void> {
  // Money first (they reference the bills), bills last.
  const order = (p: VoucherPayload) => (["Receipt", "Payment", "Contra"].includes(p.voucherType) ? 0 : 1);
  for (const p of [...made.vouchers].sort((a, b) => order(a) - order(b))) {
    const r = await remove(l, p);
    rec.check(`teardown: ${p.voucherType} ${p.voucherNumber} deleted by REMOTEID`, r.ok, r.detail);
  }
  const sw = sweepDay(l.day);
  rec.check("teardown: the sweep (backstop) ran clean", sw === 0, `exit ${sw}`);
  for (const n of made.items) { const r = await dropItem(l, n); rec.check(`teardown: item "${n}" removed`, r.ok, r.detail); }
  for (const n of made.parties) { const r = await dropParty(l, n); rec.check(`teardown: ledger "${n}" removed`, r.ok, r.detail); }
  try {
    const after = await census(l);
    rec.check("teardown: none of this run's vouchers is left in the books", after.mine === 0, `${after.mine} left`);
    if (before) rec.check("teardown: the voucher count is what it was before the run", after.total === before.total && after.ours === before.ours, `total ${before.total} -> ${after.total}, ours ${before.ours} -> ${after.ours}`);
  } catch (e) { rec.check("teardown: the books could be counted afterwards", false, (e as Error).message.slice(0, 120)); }
  const m = await freshMasters(l);
  const left = [...m.ledgers.keys(), ...m.items.keys()].filter((k) => k.includes(l.stamp));
  rec.check("teardown: no ZZ TEST ledger or item of this run is left", left.length === 0, left.join(", "));
}

async function cleanup(l: Live): Promise<number> {
  const rec = new Recorder("cleanup", -1);
  const all = await turn(l, "census", () => pullAll(l.company));
  const mine = all.filter((v) => v.number.startsWith(`ZZTEST${l.stamp}/`));
  console.log(`  ${mine.length} voucher(s) of stamp ${l.stamp} in the books`);
  for (const v of mine) {
    let gone = false;
    for (const rid of remoteIdGuesses(v.type, v.number)) {
      const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(l.company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${escapeXml(rid)}" VCHTYPE="${escapeXml(v.type)}" ACTION="Delete">
<DATE>${v.date}</DATE><VOUCHERTYPENAME>${escapeXml(v.type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${escapeXml(v.number)}</VOUCHERNUMBER></VOUCHER>
</TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
      try { const res = (await turn(l, "delete by REMOTEID", () => tallyPost(l.url, xml, 120_000, true))) as string; if (/<DELETED>[1-9]/.test(res)) { gone = true; break; } } catch (e) { if (e instanceof TallyDownError) throw e; /* wrong spelling */ }
    }
    rec.check(`cleanup: ${v.type} ${v.number} deleted`, gone);
  }
  const m = await freshMasters(l);
  for (const k of [...m.items.keys()].filter((k) => k.includes(l.stamp))) { const r = await dropItem(l, k); rec.check(`cleanup: item "${k}" removed`, r.ok, r.detail); }
  for (const k of [...m.ledgers.keys()].filter((k) => k.startsWith("ZZ TEST") && k.includes(l.stamp))) { const r = await dropParty(l, k); rec.check(`cleanup: ledger "${k}" removed`, r.ok, r.detail); }
  return rec.failed ? 1 : 0;
}

(async () => {
  const pf = await preflight();
  console.log(`  preflight ok (dummy is the only company open, ${pf.listMs} ms)`);
  if (CLEANUP) process.exit(await cleanup(makeLive(pf, indiaToday(), CLEANUP)));
  if (!["receipts", "payments", "contras", "modes"].includes(PART)) { console.error(`usage: --part receipts|payments|contras|modes   (got "${PART}")`); process.exit(2); }
  const stamp = stampFrom();
  const l = makeLive(pf, indiaToday(), stamp);
  const expected = arg("--expect") ? Number(arg("--expect")) : EXPECTED[PART];
  const rec = new Recorder(`t11 money ${PART}`, expected < 0 ? 0 : expected);
  console.log(`\n  T11 MONEY ${PART.toUpperCase()} on the dummy (${l.day}, stamp ${stamp})${expected < 0 ? "  [CALIBRATION RUN: the expected check count is not set yet]" : ""}\n`);
  const made = new Made();
  let before: { total: number; ours: number } | null = null;
  let down: TallyDownError | null = null;
  try { before = await census(l); rec.note(`books before: ${before.total} vouchers, ${before.ours} ours`); await body(PART, l, rec, made); }
  catch (e) { if (e instanceof TallyDownError) down = e; else rec.check("the part finished without an error", false, (e as Error).message.slice(0, 300)); }
  finally {
    if (!down && !gate(l).down) { try { await teardown(l, rec, made, before); } catch (e) { if (e instanceof TallyDownError) down = e; else throw e; } }
    else down = down ?? gate(l).down;
    if (down) stopForTallyDown(rec, down, stamp, made.vouchers.map((p) => `${p.voucherType} ${p.voucherNumber ?? p.narration}`), `cd server; npx tsx scripts/rigs/t11-money.ts --cleanup ${stamp}`);
  }
  let code = rec.finish(OUT ?? undefined);
  if (expected < 0 && rec.failed === 0) { console.log(`  calibration: ${rec.passed} checks passed, set EXPECTED.${PART} = ${rec.passed}`); code = 0; }
  process.exit(code);
})().catch((e) => { console.error(`FAILED before the part started: ${(e as Error).message}`); process.exit(2); });
