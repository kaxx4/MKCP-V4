/**
 * Which push-blocking rules does Tally itself back up? (owner, 26-Nov-2026: "i dont want pushes to tally to get blocked")
 *
 * JOB: for each rule the 26-Nov audit called COULD-BE-WARNING or UNSURE, push the very voucher the rule refuses straight to the sandbox
 * dummy Tally (no guard in the way), read it back, and report what Tally did with it: refused it, kept it as sent, or changed it. The verdict
 * is made from that, never from the rule's own comment: a rule may become a warning only when Tally keeps exactly what was sent AND the books
 * come out right whichever way the caller was wrong (money, tax, GST identity, stock). The guard's own answer for each voucher is printed
 * beside Tally's, so a rule that changes later shows up here.
 *
 *   npx tsx server/scripts/verify-push-rules-dummy.ts <evidence-dir> [--cleanup-stamp=NNNNNN]
 *
 * Data is fake and swept: ZZ TEST parties, items and ZZZ GSTINs; vouchers numbered ZZTEST/... and deleted by REMOTEID at the end, then the
 * masters. ONE request to Tally at a time. If Tally stops answering the script stops and says so; it never retries in a loop. After an XML
 * error TallyPrime's server may need a person to restart it.
 * Writes only on a sandbox role against a local Tally (guardScriptWrites).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters, invalidateMasters, hsnFor, type TallyMasters } from "../src/services/tallyMasters.js";
import { buildVoucherImportXml } from "../src/services/voucherPusher.js";
import { guardVoucher } from "../src/services/pushGuard.js";
import { diffStored } from "../src/services/safePush.js";
import { createLedger, deleteLedger, createStockItem, deleteStockItem } from "../src/services/masterPusher.js";
import { gstinCheckDigit } from "../src/services/gstIdentity.js";
import { guardScriptWrites } from "../src/services/scriptWriteGuard.js";
import type { VoucherPayload } from "../src/types.js";
guardScriptWrites("verify-push-rules-dummy");

const U = process.env.TALLY_URL || "http://localhost:9000";
const OUT = process.argv[2];
if (!OUT || OUT.startsWith("--")) { console.error("usage: verify-push-rules-dummy.ts <evidence-dir> [--cleanup-stamp=NNNNNN]"); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const CLEAN = process.argv.find((a) => a.startsWith("--cleanup-stamp="))?.slice(16);
if (CLEAN !== undefined && !/^\d{6}$/.test(CLEAN)) { console.error("--cleanup-stamp needs the six-digit stamp of an earlier run"); process.exit(2); }
const STAMP = CLEAN ?? Date.now().toString().slice(-6);
const D = new Date(Date.now() + 5.5 * 3600_000); // India's day
const TODAY = D.toISOString().slice(0, 10), DAY = TODAY.replace(/-/g, "");
const PARTY = `ZZ TEST PARTY R${STAMP}`, SUPP = `ZZ TEST SUPPLIER R${STAMP}`, SUPP_LATE = `ZZ TEST SUPPLIER LATE R${STAMP}`;
const ITEM = `ZZ TEST ITEM R${STAMP}`, ITEM_NOHSN = `ZZ TEST ITEM NOHSN R${STAMP}`;
const GROUP = "BICYCLE PARTS ( 87149990 )";
const gstin = (mid: string) => { const f = `19ZZZAA${mid}A1Z`; return f + gstinCheckDigit(f); };
const G_PARTY = gstin("0000"), G_SUPP = gstin("0001"), G_LATE = gstin("0002");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fld = (x: string, t: string) => ([...x.matchAll(new RegExp(`<${t}(?:\\s[^>/]*)?>([^<]*)</${t}>`, "gi"))].map((m) => m[1].replace(/&#4;\s*/g, "").trim()).find(Boolean) ?? "");
const counts = (r: string) => `CREATED=${fld(r, "CREATED") || 0} ALTERED=${fld(r, "ALTERED") || 0} DELETED=${fld(r, "DELETED") || 0} ERRORS=${fld(r, "ERRORS") || 0} EXCEPTIONS=${fld(r, "EXCEPTIONS") || 0}${fld(r, "LINEERROR") ? ` LINEERROR=${fld(r, "LINEERROR")}` : ""}`;
const GODOWN = "Main Location";
let COMPANY = "";
const post = async (xml: string, ms = 120_000): Promise<string> => (await tallyPost(U, xml, ms, true)) as string;

interface Case { tag: string; rule: string; payload: VoucherPayload; sent?: string; counts?: string; guardErrors: string[]; guardWarnings: string[]; stored?: string; diffs?: string[]; note: string }
const cases: Case[] = [];
const findings: string[] = [];

const rid = (type: string, n: string) => `MKCP|${type}|${n}|2026-27`;
const num = (tag: string) => `ZZTEST/${tag}${STAMP}`;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** A one-line sale of ITEM: qty × rate, optional explicit line amount, party total, optional round-off entry. */
function sale(tag: string, qty: number, rate: number, o: { amount?: number; party: number; round?: { amount: number; deemedPositive: boolean }; extraLine?: boolean; item?: string }): VoucherPayload {
  const goods = o.amount ?? r2(qty * rate), half = r2(goods * 0.09), n = num(tag);
  const led: VoucherPayload["ledgerEntries"] = [
    { ledgerName: PARTY, amount: o.party, isDeemedPositive: true, isPartyLedger: true, billAllocations: [{ name: n, billType: "New Ref", amount: o.party }] },
    { ledgerName: "OUTPUT CGST", amount: half, isDeemedPositive: false, isPartyLedger: false },
    { ledgerName: "OUTPUT SGST", amount: half, isDeemedPositive: false, isPartyLedger: false },
  ];
  if (o.round) led.push({ ledgerName: "ROUNDED OFF", amount: Math.abs(o.round.amount), isDeemedPositive: o.round.deemedPositive, signedAmount: o.round.amount, isPartyLedger: false });
  const line = (q: number, rt: number, amt: number) => ({ stockItemName: o.item ?? ITEM, quantity: q, unit: "PC", rate: rt, amount: amt, isDeemedPositive: false, salesLedgerName: "SALES  ( GST W.B. )", godownName: GODOWN, batchName: "Primary Batch" });
  return {
    remoteId: rid("Sales", n), voucherType: "Sales", date: TODAY, voucherNumber: n, narration: `ZZTEST rules ${STAMP} ${tag}`, partyLedgerName: PARTY, isInvoice: true,
    ledgerEntries: led, inventoryEntries: [line(qty, rate, goods), ...(o.extraLine ? [line(1, 0, 0)] : [])],
  } as unknown as VoucherPayload;
}

function purchase(tag: string, supplier: string, extra: Partial<VoucherPayload> = {}, round?: { goods: number; half: number; total: number; amount: number; deemedPositive: boolean }): VoucherPayload {
  const n = num(tag), goods = round?.goods ?? 1000, half = round?.half ?? 90, total = round?.total ?? 1180;
  return {
    remoteId: rid("Purchase", n), voucherType: "Purchase", date: TODAY, voucherNumber: n, narration: `ZZTEST rules ${STAMP} ${tag}`, partyLedgerName: supplier, isInvoice: true,
    reference: `SUP/${n}`, referenceDate: TODAY,
    ledgerEntries: [
      { ledgerName: supplier, amount: total, isDeemedPositive: false, isPartyLedger: true, billAllocations: [{ name: `SUP/${n}`, billType: "New Ref", amount: total }] },
      { ledgerName: "INPUT CGST", amount: half, isDeemedPositive: true, isPartyLedger: false },
      { ledgerName: "INPUT SGST", amount: half, isDeemedPositive: true, isPartyLedger: false },
      ...(round ? [{ ledgerName: "ROUNDED OFF", amount: Math.abs(round.amount), isDeemedPositive: round.deemedPositive, signedAmount: round.amount, isPartyLedger: false }] : []),
    ],
    inventoryEntries: [{ stockItemName: ITEM, quantity: 10, unit: "PC", rate: round ? 99.97 : 100, amount: goods, isDeemedPositive: true, salesLedgerName: "PURCHASE ( GST W.B. )", godownName: GODOWN, batchName: "Primary Batch" }],
    ...extra,
  } as unknown as VoucherPayload;
}

const deleteXml = (type: string, number: string, remoteId: string) => `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(remoteId)}" VCHTYPE="${esc(type)}" ACTION="Delete"><DATE>${DAY}</DATE><VOUCHERTYPENAME>${esc(type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(number)}</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;

/** Every voucher of today, whole (stored fields plus entry lists): the slow read, done once. */
async function readToday(): Promise<string[]> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>RulesV</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="RulesV" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>*</NATIVEMETHOD><NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD><NATIVEMETHOD>LedgerEntries</NATIVEMETHOD><NATIVEMETHOD>AllInventoryEntries</NATIVEMETHOD>
<FILTER>RulesVF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="RulesVF">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${Number(DAY)}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw = await post(xml, 300_000);
  return [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]).filter((b) => b.includes("<VOUCHERNUMBER>"));
}

/** The money-and-identity lines of a stored voucher, for the evidence file. */
function digest(v: string): string {
  const ents = [...v.matchAll(/<(ALL)?LEDGERENTRIES\.LIST>([\s\S]*?)<\/(ALL)?LEDGERENTRIES\.LIST>/g)].map((m) => `${fld(m[2], "LEDGERNAME")} ${fld(m[2], "ISDEEMEDPOSITIVE")} ${fld(m[2], "AMOUNT")}`);
  const inv = [...v.matchAll(/<(ALL)?INVENTORYENTRIES\.LIST>([\s\S]*?)<\/(ALL)?INVENTORYENTRIES\.LIST>/g)].map((m) => `${fld(m[2], "STOCKITEMNAME")} qty ${fld(m[2], "BILLEDQTY")} rate ${fld(m[2], "RATE")} amt ${fld(m[2], "AMOUNT")} hsn ${fld(m[2], "GSTHSNNAME") || "-"}`);
  return `no ${fld(v, "VOUCHERNUMBER")} | party ${fld(v, "PARTYLEDGERNAME")} | gstin ${fld(v, "PARTYGSTIN") || "-"} | regtype ${fld(v, "GSTREGISTRATIONTYPE") || "-"} | pos ${fld(v, "PLACEOFSUPPLY") || "-"} | state ${fld(v, "STATENAME") || "-"} | ledgers [${ents.join("; ")}] | stock [${inv.join("; ")}]`;
}

async function main(): Promise<void> {
  COMPANY = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]?.name ?? "";
  if (!COMPANY) throw new Error("No company loaded");
  console.log(`\ncompany loaded; stamp ${STAMP}; day ${TODAY}`);

  if (CLEAN !== undefined) { await cleanup(); return; }

  // ── masters ──────────────────────────────────────────────────────────────
  const mk = async (name: string, l: Parameters<typeof createLedger>[2]) => { const r = await createLedger(U, COMPANY, l); console.log(`  ledger ${name}: ${r.ok ? "made" : "NOT made: " + r.notes.join(" ")}`); if (!r.ok) throw new Error("master not made"); };
  await mk(PARTY, { name: PARTY, parent: "SUNDRY DEBTORS", state: "West Bengal", gstin: G_PARTY, address: ["ZZ TEST STREET", "ZZ TEST CITY"], pincode: "700001" });
  await mk(SUPP, { name: SUPP, parent: "SUNDRY CREDITORS", state: "West Bengal", gstin: G_SUPP, address: ["ZZ TEST STREET", "ZZ TEST CITY"], pincode: "700001" });
  await mk(SUPP_LATE, { name: SUPP_LATE, parent: "SUNDRY CREDITORS", state: "West Bengal", gstin: G_LATE, address: ["ZZ TEST STREET", "ZZ TEST CITY"], pincode: "700001", applicableFrom: "20261201" });
  const it = await createStockItem(U, COMPANY, { name: ITEM, parent: GROUP, baseUnit: "PC", gstRate: 18, hsn: "87149990" });
  console.log(`  item ${ITEM}: ${it.ok ? "made" : "NOT made: " + it.notes.join(" ")}`); if (!it.ok) throw new Error("item not made");
  const it2 = await createStockItem(U, COMPANY, { name: ITEM_NOHSN, parent: GROUP, baseUnit: "PC", gstRate: 18 });
  console.log(`  item ${ITEM_NOHSN} (no HSN of its own): ${it2.ok ? "made" : "NOT made: " + it2.notes.join(" ")}`);
  invalidateMasters();
  const m: TallyMasters = await loadMasters(U, COMPANY);
  const hsnOfNoHsn = hsnFor(m, ITEM_NOHSN, TODAY);
  console.log(`  masters reloaded; item with no own HSN resolves HSN "${hsnOfNoHsn.code}" from ${hsnOfNoHsn.source}`);

  // ── the vouchers: one per rule, one at a time ────────────────────────────
  const plan: { tag: string; rule: string; p: VoucherPayload }[] = [
    { tag: "A", rule: "control: a sale rounded UP, round-off on the credit side (how every hand-typed sale is written)", p: sale("A", 10, 99.97, { party: 1180, round: { amount: 0.36, deemedPositive: false } }) },
    { tag: "B", rule: "control: a sale rounded DOWN, round-off on the credit side with a negative amount (the house form)", p: sale("B", 10, 99.93, { party: 1179, round: { amount: -0.18, deemedPositive: false } }) },
    { tag: "C", rule: "ROUNDED OFF on the 'wrong' side: rounded down, written as a debit (ISDEEMEDPOSITIVE=Yes), same money as B", p: sale("C", 10, 99.93, { party: 1179, round: { amount: -0.18, deemedPositive: true } }) },
    { tag: "D", rule: "ROUNDED OFF over 50 paise: party total 1181.00 on goods and tax worth 1178.82, 2.18 hidden in the round-off", p: sale("D", 10, 99.9, { party: 1181, round: { amount: 2.18, deemedPositive: false } }) },
    { tag: "E", rule: "line amount is not quantity x rate: 10 x 100 but amount 950", p: sale("E", 10, 100, { amount: 950, party: 1121 }) },
    { tag: "F", rule: "a stock line with amount 0 beside a normal line (a free or sample piece)", p: sale("F", 10, 100, { party: 1180, extraLine: true }) },
    { tag: "G", rule: "placeOfSupply 'Delhi' typed on a Purchase from a West Bengal supplier", p: purchase("G", SUPP, { placeOfSupply: "Delhi" } as Partial<VoucherPayload>) },
    { tag: "H", rule: "a Purchase dated before the supplier's GST registration starts (registration from 1-Dec-2026)", p: purchase("H", SUPP_LATE) },
    { tag: "I", rule: "control: a Purchase rounded up, round-off on the debit side with a negative amount (the house form for a purchase)", p: purchase("I", SUPP, {}, { goods: 999.7, half: 89.97, total: 1180, amount: -0.36, deemedPositive: true }) },
    { tag: "J", rule: "ROUNDED OFF on the 'wrong' side of a Purchase: written as a credit (ISDEEMEDPOSITIVE=No), same money as I", p: purchase("J", SUPP, {}, { goods: 999.7, half: 89.97, total: 1180, amount: -0.36, deemedPositive: false }) },
    { tag: "K", rule: "a sale of an item that has no HSN of its own (it inherits its stock group's)", p: sale("K", 10, 100, { party: 1180, item: ITEM_NOHSN }) },
  ];
  for (const { tag, rule, p } of plan) {
    const g = guardVoucher(p, m);
    const c: Case = { tag, rule, payload: p, guardErrors: g.errors, guardWarnings: g.warnings, note: "" };
    const xml = buildVoucherImportXml(COMPANY, p, m);
    const res = await post(xml);
    c.sent = xml; c.counts = counts(res);
    console.log(`  ${tag}  ${c.counts}  | guard now: ${g.ok ? "accepts" : "REFUSES (" + g.errors.length + ")"}${g.warnings.length ? ", " + g.warnings.length + " warning(s)" : ""}  | ${rule}`);
    cases.push(c);
  }

  // ── one read of the day, then judge ──────────────────────────────────────
  console.log("\n  reading the day back (slow: Tally scans every voucher) ...");
  const stored = await readToday();
  for (const c of cases) {
    const v = stored.find((s) => fld(s, "VOUCHERNUMBER") === c.payload.voucherNumber);
    if (!v) { c.stored = "(not in the books)"; c.note = "Tally did not keep it"; continue; }
    c.stored = digest(v);
    c.diffs = diffStored(c.payload, v);
    c.note = c.diffs.length ? `Tally changed it: ${c.diffs.join(" | ")}` : "Tally kept exactly what was sent";
  }
  for (const c of cases) { console.log(`\n  ${c.tag}: ${c.rule}\n     ${c.counts}\n     ${c.note}\n     ${c.stored}`); }

  // ── sweep ────────────────────────────────────────────────────────────────
  await cleanup(m);
  writeFileSync(join(OUT, `rules-${STAMP}.json`), JSON.stringify({ stamp: STAMP, day: TODAY, hsnOfItemWithNoOwnHsn: hsnOfNoHsn, cases: cases.map(({ sent, ...rest }) => rest), findings }, null, 2));
  console.log(`\n  evidence written to ${join(OUT, `rules-${STAMP}.json`)}`);
}

/** Delete every ZZTEST voucher of this stamp (by REMOTEID), then the masters; then read the day once more to prove none is left. */
async function cleanup(m?: TallyMasters): Promise<void> {
  console.log("\n  sweeping ...");
  for (const tag of ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"]) {
    const type = "GHIJ".includes(tag) ? "Purchase" : "Sales", n = num(tag);
    const r = await post(deleteXml(type, n, rid(type, n)), 60_000);
    console.log(`    ${type} ${n}: ${counts(r)}`);
  }
  for (const n of [ITEM, ITEM_NOHSN]) { const r = await deleteStockItem(U, COMPANY, n); console.log(`    item ${n}: ${r.ok ? "deleted" : "NOT deleted " + r.notes.join(" ")}`); }
  for (const n of [PARTY, SUPP, SUPP_LATE]) { const r = await deleteLedger(U, COMPANY, n); console.log(`    ledger ${n}: ${r.ok ? "deleted" : "NOT deleted " + r.notes.join(" ")}`); }
  invalidateMasters();
  const left = (await readToday()).filter((s) => fld(s, "VOUCHERNUMBER").startsWith(`ZZTEST/`) && fld(s, "VOUCHERNUMBER").endsWith(STAMP) || fld(s, "NARRATION").includes(`ZZTEST rules ${STAMP}`));
  console.log(`    vouchers of this run still in the books: ${left.length}`);
  const mm = await loadMasters(U, COMPANY);
  const stillThere = [PARTY, SUPP, SUPP_LATE].filter((n) => mm.ledgers.has(n)).concat([ITEM, ITEM_NOHSN].filter((n) => mm.items.has(n)));
  console.log(`    test masters still in Tally: ${stillThere.length ? stillThere.join(", ") : "none"}`);
  void m;
  if (left.length || stillThere.length) { console.log("  NOT CLEAN. Re-run with --cleanup-stamp=" + STAMP); process.exit(1); }
  console.log("  clean.");
}

main().catch((e) => { console.error("verify failed:", e instanceof Error ? e.message : e); console.error(`If vouchers or masters were made, remove them with --cleanup-stamp=${STAMP}`); process.exit(1); });
