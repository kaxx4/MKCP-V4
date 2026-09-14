/**
 * The party resolver, against REAL bank narrations.
 *
 * PURE — no Tally, no Supabase.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * `test-bank-to-receipts.ts` fed the resolver narrations I invented
 * ("NEFT CR ACHARIYA CYCLE STORES"). The owner then sent a screenshot of the
 * actual HDFC statement, and the real thing looks nothing like that:
 *
 *   NEFT DR-UTIB0004696-AMRIT CYCLE INDUSTRIES-NETBANK, MUM-HDFCH01261596960-NBH6FHF2PFRE5DXK
 *   RTGS CR-PUNB0035000-M S NEW ASHOK CYCLE STORES-...
 *   IMPS-625537700664-VARIETYVERSE EMPIRE-S...
 *   UPI-SUMAN SARKAR-8167043560-5@AXL-HDFC...
 *   IB BILLPAY DR-HDFCEL-457704XXXXXX4589
 *
 * A test built on invented input proves the code handles invented input. This
 * is the fixture-on-both-sides trap that hid seven dead features in these repos,
 * and I had walked straight into it.
 *
 * ── What the real format forces ───────────────────────────────────────────
 *
 *   · The party sits between hyphens, after an IFSC code — it is not at the end
 *     and not separated by spaces.
 *   · DR means money OUT and CR money IN. Nothing else in the row says so.
 *   · Some rows have NO party at all (IB BILLPAY is a card/utility payment).
 *   · The noise is full of things that look like ledger words: HDFCH…,
 *     NETBANK, SBIN…, PUNB…, AXL.
 *
 * That last one is the dangerous one, and it is what this script was written to
 * find out about.
 *
 *   npx tsx scripts/test-bank-narrations.ts
 */
import { resolvePayerFromNarration } from "../src/services/extraction.js";

let passed = 0, failed = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`    \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; failures.push(label); console.log(`    \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
};
const H = (s: string) => console.log(`\n\x1b[1m── ${s} ${"─".repeat(Math.max(0, 56 - s.length))}\x1b[0m`);

/* Shaped like this company's real chart of accounts: long party names with
   bracketed towns, plus the bank and cash ledgers that sit alongside them and
   are the false positives worth worrying about. */
const LEDGERS = [
  "AMRIT CYCLE INDUSTRIES",
  "NEW ASHOK CYCLE STORES (MIDNAPUR)",
  "ACHARIYA CYCLE STORES (MANGLAMARO)",
  "VARIETYVERSE EMPIRE",
  "MAHESH RAM",
  "HDFC BANK",
  "Cash",
  "SBI CURRENT",
];

const r = (narration: string) => resolvePayerFromNarration(narration, LEDGERS);

console.log(`\n\x1b[1mParty resolution against real HDFC narrations\x1b[0m`);

H("THE ONES THAT MUST RESOLVE");
{
  const n = "NEFT DR-UTIB0004696-AMRIT CYCLE INDUSTRIES-NETBANK, MUM-HDFCH01261596960-NBH6FHF2PFRE5DXK";
  const res = r(n);
  ok("a full party name between hyphens resolves",
    res.status === "resolved" && res.value === "AMRIT CYCLE INDUSTRIES",
    res.status === "resolved" ? res.value : res.reason);
}
{
  const n = "IMPS-625537700664-VARIETYVERSE EMPIRE-SOME BRANCH";
  const res = r(n);
  ok("an IMPS narration resolves",
    res.status === "resolved" && res.value === "VARIETYVERSE EMPIRE",
    res.status === "resolved" ? res.value : res.reason);
}
{
  const n = "NEFT DR-SBIN0001483-MAHESH RAM-NETBANKING";
  const res = r(n);
  ok("a two-word personal name resolves",
    res.status === "resolved" && res.value === "MAHESH RAM",
    res.status === "resolved" ? res.value : res.reason);
}

H("THE ONES THAT MUST NOT RESOLVE TO OUR OWN BANK");
{
  /* THE DANGEROUS CASE. This narration contains "HDFCH01261596960" and
     "NETBANK". The resolver matches ledger words as SUBSTRINGS, so "HDFC BANK"
     finds "hdfc" inside HDFCH… and "bank" inside NETBANK — and would name our
     own bank as the payer. The voucher would then debit and credit the same
     ledger, for a party nobody can identify. */
  const n = "NEFT CR-UTIB0004696-SOME UNKNOWN TRADER-NETBANK, MUM-HDFCH01261596960";
  const res = r(n);
  ok("an unknown party does NOT become our own bank ledger",
    !(res.status === "resolved" && /HDFC BANK/i.test(res.value)),
    res.status === "resolved" ? `resolved to "${res.value}"` : "asked a question");
}
{
  // No party at all — a credit-card/utility bill payment.
  const n = "IB BILLPAY DR-HDFCEL-457704XXXXXX4589";
  const res = r(n);
  ok("a bill payment with no party asks rather than guessing",
    res.status !== "resolved",
    res.status === "resolved" ? `resolved to "${res.value}"` : "asked a question");
}
{
  /* "SBIN0001483" is an IFSC code, not the State Bank ledger. A substring
     match on "sbi" finds it. */
  const n = "NEFT DR-SBIN0001483-AMRIT CYCLE INDUSTRIES-NETBANKING";
  const res = r(n);
  ok("an IFSC code is not mistaken for a bank ledger",
    res.status === "resolved" && res.value === "AMRIT CYCLE INDUSTRIES",
    res.status === "resolved" ? res.value : res.reason);
}

H("TRUNCATION AND TOWN SUFFIXES");
{
  /* Real ledger names carry a bracketed town the bank narration never has.
     "NEW ASHOK CYCLE STORES (MIDNAPUR)" against a narration that says only
     "M S NEW ASHOK CYCLE STORES" — every ledger word must appear, and
     "midnapur" does not. */
  const n = "RTGS CR-PUNB0035000-M S NEW ASHOK CYCLE STORES-KOLKATA";
  const res = r(n);
  /* The bank never prints the bracketed town, so requiring it made every one of
     these a question — safe, and useless at the volume this runs at. */
  ok("a name whose only missing words are the bracketed town RESOLVES",
    res.status === "resolved" && res.value === "NEW ASHOK CYCLE STORES (MIDNAPUR)",
    res.status === "resolved" ? res.value : res.reason);
}
{
  /* Two branches of one trading name, and the narration names neither. Guessing
     would put money against the wrong branch; asking is the right outcome. */
  const two = ["ACHARIYA CYCLE STORES (MANGLAMARO)", "ACHARIYA CYCLE STORES (HOWRAH)"];
  const res = resolvePayerFromNarration("NEFT CR-UTIB0004696-ACHARIYA CYCLE STORES-KOL", two);
  ok("two branches with nothing to separate them ask rather than guess",
    res.status === "question", res.status === "resolved" ? res.value : res.reason);
}
{
  // The same pair, but this narration names the town.
  const two = ["ACHARIYA CYCLE STORES (MANGLAMARO)", "ACHARIYA CYCLE STORES (HOWRAH)"];
  const res = resolvePayerFromNarration("NEFT CR-UTIB0004696-ACHARIYA CYCLE STORES HOWRAH-KOL", two);
  ok("naming the town picks that branch",
    res.status === "resolved" && /HOWRAH/.test(res.value),
    res.status === "resolved" ? res.value : res.reason);
}

H("AMBIGUITY IS A QUESTION, NOT A GUESS");
{
  // Two cycle stores; the narration names neither fully.
  const n = "RTGS CR-PUNB0035000-CYCLE STORES";
  const res = r(n);
  ok("a narration matching nothing fully asks", res.status !== "resolved",
    res.status === "resolved" ? `resolved to "${res.value}"` : "asked a question");
}

console.log(`\n\x1b[1m${passed} passed · ${failed} failed\x1b[0m`);
if (failed) console.log(`\nfailed:\n${failures.map((f) => `  · ${f}`).join("\n")}`);
console.log();
process.exit(failed ? 1 : 0);
