/**
 * Phase 3.1 — can a cash split actually reach Tally through the agent?
 *
 * ── The claim being tested ────────────────────────────────────────────────
 *
 * SplitInvoice.tsx keeps a file-export button alongside its "queue to Tally"
 * button, justified by this comment:
 *
 *   "A bucket billed to the CASH ledger will be refused, and the guard is
 *    right: 'Cash' carries no state ... Until the Cash ledger gets a state,
 *    walk-in splits have to keep using the file path, which is why that button
 *    still exists."
 *
 * Cash sales are ~35% of vouchers here, so if that is stale it is blocking a
 * third of the business from the guarded path. This project has been burned by
 * exactly this before: the price-list pull sat unused for months behind one
 * comment claiming a query crashed TallyPrime. It takes 0.18 seconds.
 *
 * ── What the code actually says now ───────────────────────────────────────
 *
 * pushGuard has `resolvePartyState`, which lets `placeOfSupply` STAND IN for a
 * missing ledger state on an OUTWARD voucher — added precisely for the shared
 * Cash ledger, "which has no state and cannot be given one without
 * misdescribing every other voucher that uses it". And
 * cashInvoicePayload.ts:185 already sets placeOfSupply on every cash bucket.
 *
 * So the two halves may already meet. Run the guard and find out, rather than
 * trusting either comment.
 *
 *   npx tsx server/scripts/verify-cash-split-push.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters } from "../src/services/tallyMasters.js";
import { guardVoucher, resolvePartyState } from "../src/services/pushGuard.js";
import type { VoucherPayload } from "../src/types.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const TODAY = new Date().toISOString().slice(0, 10);

let pass = 0, fail = 0;
const ok = (what: string, cond: boolean, detail = "") => {
  if (cond) { console.log(`  ok    ${what}${detail ? "  — " + detail : ""}`); pass++; }
  else { console.log(`  FAIL  ${what}${detail ? "  — " + detail : ""}`); fail++; }
};

const r2 = (n: number) => Math.round(n * 100) / 100;

async function main(): Promise<void> {
  console.log("\n  CASH SPLITS THROUGH THE AGENT\n  " + "─".repeat(66));

  // ── The stand-in rule, in isolation ─────────────────────────────────────
  console.log("\n  1. placeOfSupply as a stand-in for a stateless ledger");

  const outward = resolvePartyState({ voucherType: "Sales", placeOfSupply: "West Bengal" }, "");
  ok("an OUTWARD voucher accepts placeOfSupply when the ledger has none",
    outward.state === "West Bengal" && outward.source === "payload");

  const inward = resolvePartyState({ voucherType: "Purchase", placeOfSupply: "West Bengal" }, "");
  ok("an INWARD voucher does NOT — the place of supply is always ours there",
    inward.state === "" && inward.source === "none",
    "silently accepting it would describe the supplier's state as ours");

  const wins = resolvePartyState({ voucherType: "Sales", placeOfSupply: "Bihar" }, "West Bengal");
  ok("the LEDGER wins when it has a state", wins.state === "West Bengal" && wins.source === "ledger",
    "a payload must not re-describe a party Tally already knows");

  // ── Against the live masters ────────────────────────────────────────────
  const company = convertCompanies(await tallyPost(TALLY, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  console.log(`\n  2. A real cash sale, guarded  (company: ${company})`);

  const m = await loadMasters(TALLY, company);
  const cash = [...m.ledgers.values()].find((l) => /^cash$/i.test(l.name));
  const item = [...m.items.values()].find((i) => i.closingStock > 20 && i.closingRate > 20)!;
  ok("the Cash ledger exists and has no state", !!cash && !cash.state,
    cash ? `parent ${cash.parent}, state "${cash.state ?? ""}"` : "not found");

  const qty = 2;
  const goods = r2(qty * item.closingRate);
  /* 5% intra-state: CGST 2.5 + SGST 2.5, as explicit ledger lines. Tally
     computes nothing on import — the whole reason tax is posted as lines. */
  const cgst = r2(goods * 0.025);
  const sgst = r2(goods * 0.025);
  const total = r2(goods + cgst + sgst);

  const base: VoucherPayload = {
    remoteId: `MKCP|CashSale|GUARDONLY-${Date.now()}`,
    voucherType: "SALES", date: TODAY, voucherNumber: `GUARDONLY-${Date.now()}`,
    partyLedgerName: cash!.name, isInvoice: true,
    // The whole point: the walk-in's place of supply, declared on the voucher.
    placeOfSupply: "West Bengal",
    ledgerEntries: [
      { ledgerName: cash!.name, amount: total, isDeemedPositive: true, isPartyLedger: true },
      /* The real ledger names in this company. Tally computes NOTHING on
         import, so output tax has to be posted as explicit lines — and the
         names have to be the ones that exist, which is what the guard is for. */
      { ledgerName: "OUTPUT CGST", amount: cgst, isDeemedPositive: false, isPartyLedger: false },
      { ledgerName: "OUTPUT SGST", amount: sgst, isDeemedPositive: false, isPartyLedger: false },
    ],
    inventoryEntries: [{
      stockItemName: item.name, quantity: qty, unit: item.baseUnit, rate: item.closingRate,
      amount: goods, isDeemedPositive: false,
      salesLedgerName: "SALES  ( GST W.B. )",
      godownName: "Main Location", batchName: "Primary Batch",
    }],
  };

  const g = guardVoucher(base, m);
  console.log(`     errors: ${g.errors.length}  warnings: ${g.warnings.length}`);
  for (const e of g.errors) console.log(`       ERROR   ${e}`);
  for (const w of g.warnings.slice(0, 4)) console.log(`       warn    ${w}`);

  ok("A CASH SALE PASSES THE GUARD — the documented blocker is stale",
    g.errors.length === 0,
    g.errors.length ? "still refused" : "placeOfSupply stands in for the stateless Cash ledger");

  ok("no error mentions a missing state",
    !g.errors.some((e) => /has no state/i.test(e)));

  // ── And without the stand-in, it must still be refused ──────────────────
  console.log("\n  3. The guard has not simply gone soft");
  const { placeOfSupply, ...noPos } = base;
  const g2 = guardVoucher(noPos as VoucherPayload, m);
  ok("the same voucher WITHOUT placeOfSupply is refused",
    g2.errors.some((e) => /has no state/i.test(e)),
    "the protection is intact; the stand-in is what makes cash pushable");

  const g3 = guardVoucher({ ...base, voucherType: "Purchase", placeOfSupply: "Bihar" } as VoucherPayload, m);
  ok("placeOfSupply on an INWARD voucher is refused",
    g3.errors.some((e) => /not accepted on/i.test(e)));

  console.log("\n  " + "─".repeat(66));
  console.log(`  ${pass} passed · ${fail} failed`);
  if (fail === 0) {
    console.log("\n  Cash splits can go through the agent. The file-export fallback in");
    console.log("  SplitInvoice.tsx is justified by a comment that is no longer true, and");
    console.log("  the comment should go with the button.\n");
  } else {
    console.log("\n  Not yet — the fallback is still load-bearing.\n");
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
