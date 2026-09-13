/**
 * Stage 3.4 end to end: a voucher the app created, cancelled by the app.
 *
 * `test-cancel-voucher.ts` proved Tally accepts `ACTION="Cancel"` using payloads
 * this repo composed. This proves the WEB APP's own output does the same thing —
 * payloads from `buildEditPayload`, each run through the real `validateVoucher`
 * the push queue uses, emitted by scripts/emit-voucher-edit.mts.
 *
 * That distinction is the whole point. Every dead feature in these repos died
 * between two layers whose fixtures were hand-built on both sides, so neither
 * test ever fed the other real output.
 *
 * ── What is being checked ─────────────────────────────────────────────────
 *
 * A cancel must keep the voucher and its number — that is the reason to prefer
 * it over Delete for anything a customer has seen. And the verdict has to come
 * from the STORED FLAG: `ACTION="Alter"` carrying ISCANCELLED returns
 * `altered=1` and leaves the voucher live, so the response cannot tell a real
 * cancellation from a discarded one.
 *
 *   npx tsx scripts/test-voucher-edit.ts [--keep]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters, type TallyMasters } from "../src/services/tallyMasters.js";
import { safePush } from "../src/services/safePush.js";
import type { VoucherPayload } from "../src/types.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const KEEP = process.argv.includes("--keep");
const WEB = process.env.WEB_DASHBOARD_DIR
  ?? "C:/Users/kanis/Desktop/Code/MKCP/Live-Sync/MKCP MOB2/web-dashboard";

const DATE = new Date().toISOString().slice(0, 10);
const STAMP = DATE.replace(/-/g, "");
const TAG = `VE${Date.now().toString().slice(-5)}`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fld = (v: string, t: string) => {
  const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i").exec(v);
  return m ? m[1].trim() : "";
};

let passed = 0, failed = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`    \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; failures.push(label); console.log(`    \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
};
const H = (s: string) => console.log(`\n\x1b[1m── ${s} ${"─".repeat(Math.max(0, 56 - s.length))}\x1b[0m`);

/** One day only — entry blocks across a wider range wedge Tally's port. */
async function vouchersToday(company: string): Promise<string[]> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkVe</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkVe" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>MasterId</NATIVEMETHOD>
<NATIVEMETHOD>IsCancelled</NATIVEMETHOD><NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD>
<FILTER>MkVeF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MkVeF">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${STAMP}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw: string = await tallyPost(U, xml, 180_000, true);
  /* `<VOUCHER ` with whitespace, never `<VOUCHER\b` — every response opens with
     a <CMPINFO> preamble containing a literal `<VOUCHER>0</VOUCHER>` COUNT tag,
     and a \b pattern swallows it as if it were a voucher. */
  return [...raw.matchAll(/<VOUCHER\s[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]);
}
const mine = (day: string[], number: string) =>
  day.filter((v) => fld(v, "VOUCHERNUMBER") === number);

async function remove(company: string, remoteId: string): Promise<void> {
  await tallyPost(U, `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(remoteId)}" VCHTYPE="Payment" ACTION="Delete"><DATE>${STAMP}</DATE><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`, 60_000, true);
}

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  const m: TallyMasters = await loadMasters(U, company);
  const bank = [...m.ledgers.values()].find((l) => /BANK/i.test(l.name))!.name;
  const party = [...m.ledgers.values()].find(
    (l) => /SUNDRY DEBTORS/i.test(l.parent) && l.state)!.name;

  const number = `${TAG}/C`;

  console.log(`\n\x1b[1mA voucher the app made, cancelled by the app\x1b[0m\n`);
  console.log(`company  "${company}"`);
  console.log(`party    ${party}`);
  console.log(`bank     ${bank}`);
  console.log(`voucher  ${number}\n`);

  const dir = mkdtempSync(join(tmpdir(), "mkcp-ve-"));
  const scenario = join(dir, "scenario.json");
  writeFileSync(scenario, JSON.stringify({
    company, date: DATE, voucherNumber: number, party, bank, amount: 100,
  }, null, 2));

  /* A JSON scenario, not argv: ledger names here contain spaces and brackets,
     and `shell: true` concatenates argv without escaping. */
  execFileSync("npx", ["tsx", "scripts/emit-voucher-edit.mts", scenario, join(dir, "ve")],
    { cwd: WEB, stdio: "inherit", shell: true });

  const create: VoucherPayload = JSON.parse(readFileSync(join(dir, "ve.create.json"), "utf8"));
  const cancel: VoucherPayload = JSON.parse(readFileSync(join(dir, "ve.cancel.json"), "utf8"));

  // Recorded BEFORE the push, so cleanup runs even if something throws part way.
  const remoteId = create.remoteId!;
  let pushed = false;

  try {
    H("WHAT THE WEB ENGINE PRODUCED");
    ok("the cancel addresses the same voucher", cancel.remoteId === create.remoteId, remoteId);
    /* An Alter carrying ISCANCELLED returns altered=1 and leaves the voucher
       live and in GSTR-1 — so the verb is the whole thing. */
    ok(`the verb is "Cancel", not "Alter"`, cancel.action === "Cancel", String(cancel.action));
    ok("it carries the original body, not an edited one",
      JSON.stringify(cancel.ledgerEntries) === JSON.stringify(create.ledgerEntries));

    H("CREATE");
    pushed = true;
    const p1 = await safePush(U, company, create);
    ok(`${number} pushed`, p1.ok,
      p1.ok ? "guarded and read back" : (p1.errors ?? []).concat(p1.differences ?? []).join("; ").slice(0, 140));

    const before = mine(await vouchersToday(company), number);
    ok("it is in the books", before.length === 1, `${before.length} found`);
    if (before.length !== 1) throw new Error("nothing to cancel");
    const masterId = fld(before[0], "MASTERID");
    ok("and is not cancelled", /^no$/i.test(fld(before[0], "ISCANCELLED")), fld(before[0], "ISCANCELLED"));

    H("CANCEL");
    const p2 = await safePush(U, company, cancel);
    /* safePush verifies a cancel by reading IsCancelled back, never by the
       response count — the working shape and the discarded one both answer
       altered=1. So `ok` here already means the flag is set. */
    ok("safePush reports the cancel as done", p2.ok,
      p2.ok ? "verified against the stored flag" : (p2.errors ?? []).join("; ").slice(0, 160));

    const after = mine(await vouchersToday(company), number);
    ok("the voucher still EXISTS — a cancel is not a delete", after.length === 1,
      `${after.length} found`);
    if (after.length !== 1) throw new Error("the voucher is gone");

    ok("it kept its number", fld(after[0], "VOUCHERNUMBER") === number, fld(after[0], "VOUCHERNUMBER"));
    ok("it kept its MASTERID", fld(after[0], "MASTERID") === masterId,
      `${masterId} → ${fld(after[0], "MASTERID")}`);
    ok("the books agree it is cancelled", /^yes$/i.test(fld(after[0], "ISCANCELLED")),
      `ISCANCELLED=${fld(after[0], "ISCANCELLED")}`);
    ok("no duplicate was created",
      (await vouchersToday(company)).filter((v) => fld(v, "VOUCHERNUMBER").startsWith(TAG)).length === 1);
  } finally {
    H("CLEANING UP");
    if (!pushed) console.log("    nothing was pushed.");
    else if (KEEP) console.log("    --keep: left in place.");
    else {
      await remove(company, remoteId);
      // Verified by RE-READING the books. A delete response has been observed
      // returning DELETED=1 alongside a LINEERROR.
      const left = (await vouchersToday(company)).filter((v) => fld(v, "VOUCHERNUMBER").startsWith(TAG));
      ok("every voucher this run created has been removed", left.length === 0,
        `${left.length} left`);
    }
  }

  console.log(`\n\x1b[1m${passed} passed · ${failed} failed\x1b[0m`);
  if (failed) console.log(`\nfailed:\n${failures.map((f) => `  · ${f}`).join("\n")}`);
  console.log();
  process.exit(failed ? 1 : 0);
})();
