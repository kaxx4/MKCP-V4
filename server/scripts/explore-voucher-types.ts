/**
 * EXPLORATION 8 — which of the configured voucher types will actually accept a push?
 *
 * 25 types exist in this company; 10 have been pushed. The rest are unknowns, and
 * an unknown here is the expensive kind: a type that half-works produces a
 * voucher that looks right and is wrong.
 *
 * Each type gets the simplest legitimate voucher of its shape, pushed through
 * safePush (guard → gate → push → read back → diff) and then deleted. Every one
 * carries a REMOTEID so it can be removed again — without that it would be
 * permanent, which is how 296 test vouchers got stuck before.
 *
 *   npx tsx scripts/explore-voucher-types.ts --push
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters } from "../src/services/tallyMasters.js";
import { safePush } from "../src/services/safePush.js";
import type { VoucherPayload } from "../src/types.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const PUSH = process.argv.includes("--push");
const TAG = `VT${Date.now().toString().slice(-6)}`;
const TODAY = new Date().toISOString().slice(0, 10);

let pass = 0, fail = 0;
const results: Array<{ type: string; ok: boolean; detail: string }> = [];

async function healthy() {
  try { return convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 8_000)).length > 0; }
  catch { return false; }
}

async function main() {
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  const m = await loadMasters(TALLY_URL, company, { force: true });

  const customer = [...m.ledgers.values()].find(l => /SUNDRY DEBTORS/i.test(l.parent) && /WEST BENGAL/i.test(l.state))!;
  const supplier = [...m.ledgers.values()].find(l => /SUNDRY CREDITORS/i.test(l.parent) && l.state && !/WEST BENGAL/i.test(l.state))!;
  const item = [...m.items.values()].find(i => i.closingStock > 40 && i.closingRate > 20)!;
  const godown = [...m.godowns][0];

  console.log(`company "${company}"`);
  console.log(`${m.voucherTypes.size} voucher types configured:\n  ${[...m.voucherTypes].join(", ")}\n`);
  if (!PUSH) { console.log("Pass --push to run. Every voucher is deleted again."); return; }

  const AMT = 1000;
  /** An accounting two-liner works for anything that is not stock-bearing. */
  const accounting = (type: string, dr: string, cr: string): VoucherPayload => ({
    remoteId: `MKCP|${type}|${TAG}/${type}|2026-27`,
    voucherType: type as VoucherPayload["voucherType"],
    date: TODAY, voucherNumber: `${TAG}/${type}`,
    narration: `${TAG} type probe`, partyLedgerName: dr, isInvoice: false,
    ledgerEntries: [
      { ledgerName: dr, amount: AMT, isDeemedPositive: true, isPartyLedger: true },
      { ledgerName: cr, amount: AMT, isDeemedPositive: false, isPartyLedger: false },
    ],
  });

  /** Stock-bearing types need an item line with a godown and batch. */
  const withStock = (type: string, party: string, ledger: string, outward: boolean): VoucherPayload => {
    const amount = Math.round(2 * item.closingRate * 100) / 100;
    return {
      remoteId: `MKCP|${type}|${TAG}/${type}|2026-27`,
      voucherType: type as VoucherPayload["voucherType"],
      date: TODAY, voucherNumber: `${TAG}/${type}`,
      narration: `${TAG} type probe`, partyLedgerName: party, isInvoice: true,
      ledgerEntries: [{ ledgerName: party, amount, isDeemedPositive: outward, isPartyLedger: true }],
      inventoryEntries: [{
        stockItemName: item.name, quantity: 2, unit: item.baseUnit, rate: item.closingRate,
        amount, isDeemedPositive: !outward, salesLedgerName: ledger,
        godownName: godown, batchName: "Primary Batch",
      }],
    };
  };

  // Only the types this company actually has, minus the ten already proven.
  const PROVEN = new Set(["SALES", "PURCHASE", "RECEIPT", "PAYMENT", "CONTRA", "JOURNAL", "SALES ORDER NOTE", "DEBIT NOTE"]);
  const plan: Array<[string, VoucherPayload]> = [];
  for (const t of m.voucherTypes) {
    const u = t.toUpperCase();
    if (PROVEN.has(u)) continue;
    if (/CREDIT NOTE/.test(u)) plan.push([t, withStock(t, customer.name, "SALES  ( GST W.B. )", false)]);
    else if (/DELIVERY|DESPATCH/.test(u)) plan.push([t, withStock(t, customer.name, "SALES  ( GST W.B. )", true)]);
    else if (/RECEIPT NOTE|PURCHASE ORDER/.test(u)) plan.push([t, withStock(t, supplier.name, "PURCHASE ( GST CENTRAL )", false)]);
    else if (/STOCK JOURNAL|PHYSICAL|MANUFACTUR/.test(u)) { results.push({ type: t, ok: false, detail: "skipped — needs a bespoke stock-only shape" }); }
    else if (/MEMO|REVERSING|ATTENDANCE|PAYROLL|SALARY/.test(u)) { results.push({ type: t, ok: false, detail: "skipped — out of agreed scope" }); }
    else plan.push([t, accounting(t, customer.name, "Cash")]);
  }

  console.log(`probing ${plan.length} unproven types, one at a time\n`);
  const made: VoucherPayload[] = [];

  for (const [type, payload] of plan) {
    let detail = "", ok = false;
    try {
      const res = await safePush(TALLY_URL, company, payload);
      ok = res.ok;
      detail = res.ok ? `id ${res.voucherId}` : (res.errors[0] ?? res.differences.join(" | ")).slice(0, 88);
      if (res.voucherId) made.push(payload);
    } catch (e) { detail = (e as Error).message.slice(0, 88); }

    console.log(`  ${ok ? "\x1b[32m+\x1b[0m" : "\x1b[31mx\x1b[0m"} ${type.padEnd(22)} ${detail}`);
    results.push({ type, ok, detail });
    ok ? pass++ : fail++;

    if (!await healthy()) { console.log(`\n! Tally stopped answering after "${type}".`); break; }
  }

  console.log(`\nremoving ${made.length} probe vouchers`);
  let gone = 0;
  for (const p of made) {
    try { if ((await safePush(TALLY_URL, company, { ...p, action: "Delete" })).ok) gone++; } catch { /* reported below */ }
  }
  console.log(`  removed ${gone} of ${made.length}`);

  console.log(`\n${"=".repeat(58)}`);
  console.log(`${pass} types accept a push, ${fail} do not\n`);
  for (const r of results) console.log(`  ${r.ok ? "+" : "-"} ${r.type.padEnd(22)} ${r.detail}`);
  console.log(await healthy() ? "\nTally still healthy." : "\n! Tally NOT responding.");
}

main().catch(e => console.error("FAILED:", e.message));
