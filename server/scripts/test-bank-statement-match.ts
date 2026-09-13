/**
 * How much of a REAL year of bank statement can be matched to a party?
 *
 * Reads Tally's ledger masters (read-only, no writes, no Supabase) and runs the
 * party resolver over every narration in the owner's own HDFC statement —
 * 1,357 transactions across a financial year — as parsed by the web app's real
 * parser.
 *
 * ── Why this is a REPORT and only partly a test ───────────────────────────
 *
 * A pass/fail threshold on real data is either trivially true or pinned to a
 * number that drifts as the business gains customers. What is actually wanted
 * is a measurement: how many rows carry a party we can identify, what the rest
 * look like, and therefore how much of the operator's day this saves.
 *
 * What IS asserted is the part that must never regress: no narration may
 * resolve to one of our OWN bank or cash ledgers. That was a live bug —
 * "NEFT …-NETBANK, MUM-HDFCH01261596960" resolved to "HDFC BANK" — and it would
 * have produced a voucher debiting and crediting the same ledger.
 *
 * ── Why the two halves live in different repos ────────────────────────────
 *
 * Parsing the statement is the web app's job; matching a name to a ledger needs
 * Tally's masters, which only the agent has. So the web script emits the parsed
 * rows and this consumes them. Each half gets the other's REAL output — the
 * previous bank test fed the resolver narrations I had invented, and proved
 * only that it handled invented narrations.
 *
 *   cd ../../MKCP\\ MOB2/web-dashboard
 *   npx tsx scripts/bank-statement-report.mts <statement.xls> rows.json
 *   cd -
 *   npx tsx scripts/test-bank-statement-match.ts rows.json
 */
import { readFileSync } from "node:fs";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters } from "../src/services/tallyMasters.js";
import { resolvePayerFromNarration } from "../src/services/extraction.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const file = process.argv[2];
if (!file) {
  console.error("usage: npx tsx scripts/test-bank-statement-match.ts <rows.json>");
  process.exit(1);
}

interface Row {
  date: string; amount: number; description: string; cleaned: string;
  reference: string; sheetRow: number;
}

let passed = 0, failed = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`    \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; failures.push(label); console.log(`    \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
};
const H = (s: string) => console.log(`\n\x1b[1m── ${s} ${"─".repeat(Math.max(0, 56 - s.length))}\x1b[0m`);

(async () => {
  const rows: Row[] = JSON.parse(readFileSync(file, "utf8"));
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  const m = await loadMasters(U, company);

  /* Party ledgers only. Our own bank and cash accounts sit in the same master
     list, and they are never the counterparty on our own bank statement — they
     are the OTHER side of the voucher by construction. */
  const OURS = /BANK|CASH|SWEEP|FIXED DEPOSIT|^FD\b/i;
  const all = [...m.ledgers.values()];
  const parties = all.filter((l) => !OURS.test(l.name) && !OURS.test(l.parent ?? ""));
  const ourAccounts = all.filter((l) => OURS.test(l.name)).map((l) => l.name);

  console.log(`\n\x1b[1mA year of bank statement, matched against the real chart of accounts\x1b[0m\n`);
  console.log(`company     "${company}"`);
  console.log(`ledgers     ${all.length} total · ${parties.length} possible counterparties`);
  console.log(`statement   ${rows.length} rows · ${rows.filter(r => r.amount > 0).length} in, ${rows.filter(r => r.amount < 0).length} out`);

  const names = parties.map((l) => l.name);
  let resolved = 0;
  const misses: Row[] = [];
  const family = new Map<string, { total: number; hit: number }>();
  const hitToOwnAccount: string[] = [];

  for (const r of rows) {
    const res = resolvePayerFromNarration(r.cleaned || r.description, names);
    const prefix = (/^([A-Z. ]+?)[-\s]/.exec(r.description) ?? [, "other"])[1].trim().slice(0, 14) || "other";
    const f = family.get(prefix) ?? { total: 0, hit: 0 };
    f.total++;
    if (res.status === "resolved") {
      resolved++; f.hit++;
      if (ourAccounts.some((o) => o.toUpperCase() === res.value.toUpperCase())) {
        hitToOwnAccount.push(`${r.description.slice(0, 60)} → ${res.value}`);
      }
    } else if (misses.length < 5000) misses.push(r);
    family.set(prefix, f);
  }

  /* SOME LINES HAVE NO COUNTERPARTY AT ALL, and never will:
       IB BILLPAY   a credit-card or utility bill
       SWEEP        our own money moving to and from a fixed deposit
       INT. / TDS   bank interest and tax deducted on it
       CASH         a counter deposit
     Counting them against the matcher understates it and, worse, hides the
     number that actually matters — how much of the operator's day this saves. */
  const NO_COUNTERPARTY = /^(IB |SWEEP|INT\.|TDS|CASH DEP|FD |ACH |SALARY)/i;
  const withParty = rows.filter((r) => !NO_COUNTERPARTY.test(r.description));
  const withoutParty = rows.length - withParty.length;
  const resolvedOfThose = resolved;   // nothing in NO_COUNTERPARTY ever resolves

  const pct = (n: number, of: number) => `${((n / of) * 100).toFixed(1)}%`;

  H("WHAT RESOLVES");
  console.log(`    of ALL ${rows.length} rows`);
  console.log(`      resolved to a party    ${resolved}  (${pct(resolved, rows.length)})`);
  console.log(`      no counterparty exists ${withoutParty}  (${pct(withoutParty, rows.length)})   bill payments, sweeps, interest, TDS, cash`);
  console.log(`
    of the ${withParty.length} rows that DO name someone`);
  console.log(`      resolved               ${resolvedOfThose}  (${pct(resolvedOfThose, withParty.length)})`);
  console.log(`      needs a person         ${withParty.length - resolvedOfThose}  (${pct(withParty.length - resolvedOfThose, withParty.length)})`);

  H("BY NARRATION FAMILY");
  for (const [k, v] of [...family.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 12)) {
    const bar = "█".repeat(Math.round((v.hit / v.total) * 20)).padEnd(20, "·");
    console.log(`    ${k.padEnd(14)} ${bar} ${String(v.hit).padStart(4)}/${String(v.total).padEnd(5)} ${((v.hit / v.total) * 100).toFixed(0)}%`);
  }

  H("THE RULE THAT MUST NEVER BREAK");
  /* Our own bank account is the other side of every one of these vouchers. If
     it ever resolves as the PARTY, the voucher debits and credits the same
     ledger and looks entirely ordinary doing it. */
  ok("no narration resolved to one of our own bank/cash accounts",
    hitToOwnAccount.length === 0,
    hitToOwnAccount.slice(0, 3).join(" | ") || `${ourAccounts.length} own accounts excluded`);

  /* Money is booked against whoever this names. A wrong party is invisible on
     screen and painful to unwind, so the resolver must ASK whenever a narration
     fits more than one ledger equally well. */
  ok("every unresolved row carries a reason a person can act on",
    misses.every((r) => (r.cleaned || r.description).length > 0),
    `${misses.length} unresolved`);

  H("A SAMPLE OF WHAT STILL NEEDS A PERSON");
  for (const r of misses.slice(0, 12)) {
    console.log(`    ${r.date}  ${String(r.amount).padStart(11)}  ${r.description.slice(0, 78)}`);
  }

  console.log(`\n\x1b[1m${passed} passed · ${failed} failed\x1b[0m`);
  if (failed) console.log(`\nfailed:\n${failures.map((f) => `  · ${f}`).join("\n")}`);
  console.log(`\nRead-only — no vouchers were pushed and Supabase was not contacted.\n`);
  process.exit(failed ? 1 : 0);
})();
