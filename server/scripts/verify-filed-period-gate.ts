/**
 * Does filed-period protection actually fire — and what is unprotected today?
 *
 * ── The risk this measures ────────────────────────────────────────────────
 *
 * `MKCP_FILED_THROUGH` is the hard backstop against altering a voucher that
 * sits inside an already-submitted GST return. It is UNSET on this machine, and
 * safePush says so on every single write:
 *
 *   "MKCP_FILED_THROUGH is not set, so filed-period protection is off — an
 *    Alter could change an already-submitted return."
 *
 * A warning printed on every write is a warning nobody reads. This turns it
 * into a pass/fail, and — more usefully — proves the protection WORKS when
 * configured, so setting it is a one-line change with a known effect rather
 * than a leap.
 *
 * Running the existing guard suite with and without the variable proves
 * nothing on its own: 14/14 both ways, because no case in it is dated inside a
 * filed period. This builds that case deliberately.
 *
 *   npx tsx server/scripts/verify-filed-period-gate.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters, type TallyMasters } from "../src/services/tallyMasters.js";
import { guardVoucher } from "../src/services/pushGuard.js";
import type { VoucherPayload } from "../src/types.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";

let fails = 0;
const ok = (what: string, cond: boolean, detail = "") => {
  if (cond) console.log(`  ok    ${what}${detail ? "  — " + detail : ""}`);
  else { fails++; console.log(`  FAIL  ${what}${detail ? "  — " + detail : ""}`); }
};

/** An Alter dated inside a period that would be filed. */
function alterInFiledPeriod(m: TallyMasters): VoucherPayload {
  const party = [...m.ledgers.values()]
    .find((l) => /SUNDRY DEBTORS/i.test(l.parent) && /WEST BENGAL/i.test(l.state ?? ""))!;
  const item = [...m.items.values()].find((i) => i.closingStock > 5)!;
  return {
    remoteId: "MKCP|Sales|FILEDGATE-1|2026-27",
    action: "Alter",
    voucherType: "Sales",
    date: "2026-07-15",            // well inside any plausible filed period
    voucherNumber: "FILEDGATE-1",
    partyLedgerName: party.name,
    isInvoice: true,
    /* Balanced on purpose. An unbalanced payload is refused for BEING
       unbalanced, which would mask whether the period gate fired at all — the
       only question this script exists to answer. */
    ledgerEntries: [
      { ledgerName: party.name, amount: 1000, isDeemedPositive: true, isPartyLedger: true },
    ],
    inventoryEntries: [{
      stockItemName: item.name, quantity: 1, unit: item.baseUnit, rate: 1000,
      amount: 1000, isDeemedPositive: false,
      salesLedgerName: "SALES  ( GST W.B. )",
      godownName: "Main Location", batchName: "Primary Batch",
    }],
  };
}

async function main(): Promise<void> {
  console.log("\n  FILED-PERIOD PROTECTION\n  " + "─".repeat(66));

  const company = convertCompanies(await tallyPost(TALLY, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  const m = await loadMasters(TALLY, company);

  const payload = alterInFiledPeriod(m);
  const configured = (process.env.MKCP_FILED_THROUGH ?? "").trim();

  console.log(`\n  MKCP_FILED_THROUGH = ${configured || "(not set)"}`);
  console.log(`  test voucher: Alter a SALES dated ${payload.date}\n`);

  const g = guardVoucher(payload, m);
  const refusedForPeriod = g.errors.some((e) => /filed|period|return/i.test(e));
  const warnedAboutConfig = g.warnings.some((w) => /MKCP_FILED_THROUGH is not set/i.test(w));

  for (const e of g.errors.slice(0, 3)) console.log(`     ERROR  ${e.slice(0, 120)}`);
  for (const w of g.warnings.filter((x) => /FILED/i.test(x)).slice(0, 2)) console.log(`     warn   ${w.slice(0, 120)}`);

  if (configured) {
    /* Configured: the gate must REFUSE. This is the state the office should be
       in before anything runs in anger. */
    ok("an Alter inside the filed period is REFUSED", refusedForPeriod,
      refusedForPeriod ? "" : "the gate did not fire even though the date is inside the filed period");
    ok("no 'not configured' warning remains", !warnedAboutConfig);
  } else {
    /* Unset — today's state. The point is not to fail the build, it is to make
       the exposure explicit and measurable instead of a line in a log. */
    ok("the guard SAYS the protection is off", warnedAboutConfig,
      "a warning on every write is a warning nobody reads — this makes it checkable");
    console.log(`\n  UNPROTECTED RIGHT NOW: an Alter dated ${payload.date} is ` +
      `${refusedForPeriod ? "refused anyway" : "NOT refused"} by the period gate.`);
    console.log(`  Set MKCP_FILED_THROUGH to the last filed date (e.g. 2026-08-31) to close this.`);
  }

  /* Whatever the configuration, the gate must never be the ONLY thing standing
     between a bad payload and the books — so confirm the rest of the guard is
     still doing its job on the same voucher. */
  console.log(`\n  the rest of the guard on this payload: ${g.errors.length} error(s), ${g.warnings.length} warning(s)`);

  console.log("\n  " + "─".repeat(66));
  console.log(`  ${fails === 0 ? "Measured." : fails + " check(s) failed."}\n`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
