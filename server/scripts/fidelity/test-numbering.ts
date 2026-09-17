/**
 * Tests for nextFreeNumber. Pure — no Tally, no network.
 *
 * Run: npx tsx scripts/fidelity/test-numbering.ts
 *
 * The corpora below are REAL number shapes from these books, not invented
 * ones: the counter sits first on a Payment and last on a Sales invoice, and
 * getting that backwards files a voucher into the wrong financial year.
 */
import { nextFreeNumber } from "../../src/services/voucherNumbering.js";

let pass = 0;
let fail = 0;

function is(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : `\n          got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
}

// ── the counter is FIRST ────────────────────────────────────────────────────
const payments = ["1864/26-27", "1865/26-27", "1866/26-27", "1867/26-27"];
is("bumps the leading counter, not the year",
  nextFreeNumber(payments, "1867/26-27"), "1868/26-27");

is("starts above the HIGHEST taken, not above the one that failed",
  nextFreeNumber(payments, "1864/26-27"), "1868/26-27");

// ── the counter is LAST, zero-padded ───────────────────────────────────────
const sales = ["26-27/0676", "26-27/0677", "26-27/0678"];
is("bumps the trailing counter and keeps the padding",
  nextFreeNumber(sales, "26-27/0678"), "26-27/0679");

// ── mixed series must not contaminate each other ───────────────────────────
const mixed = [...payments, "CHQ-544/26-27", "CHQ-546/26-27", "BULK/R/20260914/SOMEONE"];
is("ignores numbers of a different shape",
  nextFreeNumber(mixed, "1867/26-27"), "1868/26-27");
is("continues the CHQ series on its own terms",
  nextFreeNumber(mixed, "CHQ-546/26-27"), "CHQ-547/26-27");

// ── refusing to guess ───────────────────────────────────────────────────────
is("gives up when there is no digit at all", nextFreeNumber(payments, "ABC"), null);
is("gives up on an ambiguous shape with no peers to learn from",
  nextFreeNumber([], "1867/26-27"), null,
);
is("a single digit run needs no peers", nextFreeNumber([], "CRN/1460"), "CRN/1461");

// ── the free-number guarantee ───────────────────────────────────────────────
is("skips over a gap that is already occupied",
  nextFreeNumber(["10/26-27", "11/26-27", "12/26-27"], "10/26-27"), "13/26-27");

is("an empty input is not a number", nextFreeNumber(payments, ""), null);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail) process.exitCode = 1;
