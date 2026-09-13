/**
 * Every voucher type the new screen offers, pushed into Tally.
 *
 * The redesign puts voucher writing in one place: pick a type, fill it in. That
 * rests on ONE builder — `draftToPayload` — instead of the four specialised
 * ones the app grew. Unit tests prove it is self-consistent and that it agrees
 * with the money builder already proven against the live company.
 *
 * This is the other half: does Tally ACCEPT what it produces, for each type?
 * A form that offers Contra and Journal on the strength of a unit test is how
 * a screen gets shipped that cannot save.
 *
 * Payloads come from the web app's own engine via scripts/emit-drafts.mts,
 * which refuses to emit anything `validateDraft` would reject — so nothing is
 * pushed here that a person could not have submitted.
 *
 *   npx tsx scripts/test-draft-engine.ts [--keep]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters, type TallyMasters } from "../src/services/tallyMasters.js";
import { safePush } from "../src/services/safePush.js";
import { vouchersOnDay } from "../src/services/localSession.js";
import type { VoucherPayload } from "../src/types.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const KEEP = process.argv.includes("--keep");
const WEB = process.env.WEB_DASHBOARD_DIR
  ?? "C:/Users/kanis/Desktop/Code/MKCP/Live-Sync/MKCP MOB2/web-dashboard";

const DATE = new Date().toISOString().slice(0, 10);
const STAMP = DATE.replace(/-/g, "");
const TAG = `DE${Date.now().toString().slice(-5)}`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let passed = 0, failed = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`    \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; failures.push(label); console.log(`    \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
};
const H = (s: string) => console.log(`\n\x1b[1m── ${s} ${"─".repeat(Math.max(0, 56 - s.length))}\x1b[0m`);

async function remove(company: string, remoteId: string, type: string): Promise<void> {
  await tallyPost(U, `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(remoteId)}" VCHTYPE="${esc(type)}" ACTION="Delete"><DATE>${STAMP}</DATE><VOUCHERTYPENAME>${esc(type)}</VOUCHERTYPENAME></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`, 60_000, true);
}

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  const m: TallyMasters = await loadMasters(U, company);

  const led = [...m.ledgers.values()];
  const party = led.find((l) => /SUNDRY DEBTORS/i.test(l.parent) && l.state)!.name;
  const bank = led.find((l) => /BANK ACCOUNTS/i.test(l.parent ?? ""))!.name;
  const cash = led.find((l) => /^CASH$/i.test(l.name))?.name ?? "Cash";
  const salesLedger = led.find((l) => /^SALES/i.test(l.name) && /W\.?B\.?/i.test(l.name))?.name
    ?? led.find((l) => /SALES ACCOUNTS/i.test(l.parent ?? ""))!.name;
  const item = [...m.items.values()].find((i) => i.closingStock > 20 && i.closingRate > 10);

  console.log(`\n\x1b[1mEvery voucher type the new screen offers\x1b[0m\n`);
  console.log(`company  "${company}"`);
  console.log(`party    ${party}`);
  console.log(`bank     ${bank}   cash ${cash}`);
  console.log(`sales    ${salesLedger}`);
  console.log(`item     ${item ? `${item.name} @ ₹${item.closingRate}` : "(none suitable — sales skipped)"}\n`);

  const dir = mkdtempSync(join(tmpdir(), "mkcp-de-"));
  const scenario = join(dir, "scenario.json");
  writeFileSync(scenario, JSON.stringify({
    date: DATE, tag: TAG, party, bank, cash, salesLedger,
    ...(item ? { item: { name: item.name, unit: item.baseUnit, rate: item.closingRate } } : {}),
  }, null, 2));

  execFileSync("npx", ["tsx", "scripts/emit-drafts.mts", scenario, join(dir, "d")],
    { cwd: WEB, stdio: "inherit", shell: true });

  const kinds = ["payment", "receipt", "contra", "journal", "sales"];
  const pushed: { remoteId: string; type: string }[] = [];

  try {
    for (const kind of kinds) {
      const path = join(dir, `d.${kind}.json`);
      if (!existsSync(path)) continue;
      const payload: VoucherPayload = JSON.parse(readFileSync(path, "utf8"));

      H(kind.toUpperCase());
      // Recorded BEFORE the push, so cleanup runs even if it throws.
      pushed.push({ remoteId: payload.remoteId!, type: payload.voucherType });

      const res = await safePush(U, company, payload);
      ok(`${payload.voucherNumber} pushed`, res.ok,
        res.ok ? "guarded and read back"
          : (res.errors ?? []).concat(res.differences ?? []).join("; ").slice(0, 150));
      if (!res.ok) continue;

      const day = await vouchersOnDay(U, company, DATE);
      /* Journals are numbered "None" in this company, so Tally stores no number
         however good the one we sent — match on narration for those. */
      const stored = day.find((v) => v.voucherNumber === payload.voucherNumber)
        ?? day.find((v) => v.narration === payload.narration);
      ok("it is in the books", Boolean(stored), stored ? `#${stored.masterId}` : "not found");
      if (!stored) continue;

      /* THE DIRECTION CHECK. A voucher with Dr/Cr reversed still balances and
         still reads back — it is simply posted the wrong way round, and only
         the ledger it lands in would ever say so. Tally stores debits NEGATIVE,
         so the party line's stored sign is what proves the mapping. */
      const partyLine = payload.ledgerEntries.find((e) => e.isPartyLedger);
      if (partyLine) {
        const storedLine = stored.ledgers.find((l) => l.name === partyLine.ledgerName);
        const wantNegative = partyLine.isDeemedPositive;   // debit → negative in Tally
        ok("the party line posted on the side it was written on",
          storedLine !== undefined && (storedLine.amount < 0) === wantNegative,
          `${partyLine.isDeemedPositive ? "Dr" : "Cr"} → stored ${storedLine?.amount}`);
      }

      ok("it balances in the books",
        Math.abs(stored.ledgers.reduce((t, l) => t + l.amount, 0)) < 0.02,
        `net ₹${stored.ledgers.reduce((t, l) => t + l.amount, 0).toFixed(2)}`);
    }
  } finally {
    H("CLEANING UP");
    if (KEEP) console.log(`    --keep: ${pushed.length} voucher(s) left in place.`);
    else {
      for (const p of pushed) await remove(company, p.remoteId, p.type);
      // Verified by RE-READING; a delete response has returned DELETED=1 next
      // to a LINEERROR before now.
      const left = (await vouchersOnDay(U, company, DATE))
        .filter((v) => v.voucherNumber.startsWith(TAG) || v.narration.includes(TAG));
      ok("every voucher this run created has been removed", left.length === 0,
        `${left.length} left: ${left.map((v) => v.voucherNumber || v.narration.slice(0, 24)).join(", ")}`);
    }
  }

  console.log(`\n\x1b[1m${passed} passed · ${failed} failed\x1b[0m`);
  if (failed) console.log(`\nfailed:\n${failures.map((f) => `  · ${f}`).join("\n")}`);
  console.log();
  process.exit(failed ? 1 : 0);
})();
