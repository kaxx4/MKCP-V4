/**
 * Does the web app's bulk-money engine produce vouchers Tally settles correctly?
 *
 * This is the Stage 3 proof: "every allocation confirmed Agst Ref against the
 * correct party by reading the vouchers back". It matters more than it sounds.
 * An `Agst Ref` naming a bill that belongs to somebody else is NOT rejected —
 * Tally silently rewrites it to `New Ref`, which creates a fresh liability
 * instead of clearing an existing one, and reports success either way. Nothing
 * but a read-back can see it.
 *
 * Three steps, so nothing between the engine and Tally is hand-written:
 *
 *   1. here     — read a real party's REAL open bills from Tally
 *   2. web repo — run engine/bulkMoney.ts over them, emit payloads
 *   3. here     — push the payloads, read them back, check every allocation
 *
 * Step 2 runs the SAME functions the Money entry page calls. A fixture written
 * by hand on this side would prove nothing about the page.
 *
 * ⚠ It settles bills that ALREADY EXIST, deliberately.
 * An earlier version raised three invoices and immediately cited them. That
 * reproducibly came back as `New Ref`: a bill raised seconds ago is not yet
 * citable — Tally's outstanding index has not picked it up within the same
 * push session. Which is also the realistic case, since a morning's collection
 * clears yesterday's invoices, not ones raised in the same breath. Raising
 * fixture bills first therefore tested a scenario that neither occurs nor
 * works, and reported a failure in the engine that was not there.
 *
 *   npx tsx scripts/test-bulk-money.ts --push [--keep]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadOpenBills, receivableBills, payableBills, billsForParty } from "../src/services/billSettlement.js";
import { safePush } from "../src/services/safePush.js";
import type { VoucherPayload } from "../src/types.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const PUSH = process.argv.includes("--push");
const KEEP = process.argv.includes("--keep");
const WEB = process.env.WEB_DASHBOARD_DIR
  ?? "C:/Users/kanis/Desktop/Code/MKCP/Live-Sync/MKCP MOB2/web-dashboard";

const DATE = new Date().toISOString().slice(0, 10);
const STAMP = DATE.replace(/-/g, "");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (s: string) => { const m = /^\s*(-?[\d.]+)/.exec(String(s).replace(/,/g, "")); return m ? parseFloat(m[1]) : NaN; };
const fld = (v: string, t: string) => {
  const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i").exec(v);
  return m ? m[1].trim() : "";
};
/** Tally stores bill dates as YYYYMMDD; the web engine sorts on ISO. */
const iso = (yyyymmdd: string) =>
  /^\d{8}$/.test(yyyymmdd) ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}` : DATE;

let passed = 0, failed = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`    \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; failures.push(label); console.log(`    \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); }
};
const H = (s: string) => console.log(`\n\x1b[1m── ${s} ${"─".repeat(Math.max(0, 56 - s.length))}\x1b[0m`);
const healthy = async () => {
  try { return convertCompanies(await tallyPost(U, HEALTH_XML, 10_000)).length > 0; } catch { return false; }
};

/** Single-day read-back WITH entry blocks — safe; a year-wide one is not. */
async function vouchersOnDay(company: string): Promise<string[]> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkBulk</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkBulk" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD>
<NATIVEMETHOD>IsInvoice</NATIVEMETHOD><NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD>
<NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD>
<FILTER>MkBulkF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MkBulkF">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${STAMP}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw: string = await tallyPost(U, xml, 180_000, true);
  return [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]);
}

function allocationsOf(v: string): Array<{ ledger: string; bill: string; type: string; amount: number }> {
  const out: Array<{ ledger: string; bill: string; type: string; amount: number }> = [];
  for (const [, entry] of v.matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/g)) {
    const ledger = fld(entry, "LEDGERNAME");
    for (const [, b] of entry.matchAll(/<BILLALLOCATIONS\.LIST>([\s\S]*?)<\/BILLALLOCATIONS\.LIST>/g)) {
      const bill = fld(b, "NAME");
      if (!bill) continue;
      out.push({ ledger, bill, type: fld(b, "BILLTYPE"), amount: num(fld(b, "AMOUNT")) });
    }
  }
  return out;
}

async function remove(company: string, type: string, number: string): Promise<boolean> {
  const rid = `MKCP|${type}|${number}|2026-27`;
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(rid)}" VCHTYPE="${esc(type)}" ACTION="Delete"><DATE>${STAMP}</DATE><VOUCHERTYPENAME>${esc(type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(number)}</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
  const raw: string = await tallyPost(U, xml, 60_000, true);
  return (parseInt(fld(raw, "DELETED") || "0", 10) || 0) > 0;
}

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;

  H("REAL OPEN BILLS");
  const all = await loadOpenBills(U, company);
  const recv = receivableBills(all), payb = payableBills(all);
  console.log(`\ncompany    "${company}"`);
  console.log(`bills      ${all.length} open · ${recv.length} receivable · ${payb.length} payable`);

  /** Pick a party with at least two open bills on the given side. */
  const pick = (side: "receipt" | "payment") => {
    const wanted = side === "receipt" ? recv : payb;
    const sign = (b: { closing: number }) => (side === "receipt" ? b.closing < 0 : b.closing > 0);
    const party = wanted.map((b) => b.party).find((p) => billsForParty(all, p).filter(sign).length >= 2);
    if (!party) return null;
    const bills = billsForParty(all, party).filter(sign)
      .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3);
    // A DIFFERENT party's bill, carried into the scenario so the cross-party
    // trap is exercised rather than assumed away.
    const otherParty = wanted.map((b) => b.party).find((p) => p !== party)!;
    const otherBill = billsForParty(all, otherParty).filter(sign)[0]!;
    return { party, bills, otherParty, otherBill };
  };

  const cases = (["receipt", "payment"] as const)
    .map((side) => ({ side, ...(pick(side) ?? {}) }))
    .filter((c): c is { side: "receipt" | "payment" } & NonNullable<ReturnType<typeof pick>> => "party" in c);

  if (!cases.length) { console.log("\nNo party has 2+ open bills on either side — cannot run.\n"); process.exit(1); }
  for (const c of cases) {
    console.log(`\n${c.side.padEnd(9)}  ${c.party}`);
    for (const b of c.bills) console.log(`  bill     ${b.name.padEnd(24)} ${iso(b.date)}  ₹${b.outstanding.toFixed(2)}`);
    console.log(`  other    ${c.otherParty} — ${c.otherBill.name} (must never be cited)`);
  }

  if (!PUSH) { console.log(`\nDry run. Pass --push.\n`); return; }

  const created: Array<{ type: string; number: string }> = [];
  try {
    for (const c of cases) {
      const { side, party, bills, otherParty, otherBill } = c;
      const voucherType = side === "receipt" ? "Receipt" : "Payment";
      // Clear the oldest in full and part-pay the next — the ordinary shape of
      // a morning's run.
      const amount = r2(bills[0].outstanding + bills[1].outstanding / 2);

      // ═════ The web engine builds the payload ══════════════════════════
      H(`${voucherType.toUpperCase()} · RUNNING THE WEB ENGINE`);
      console.log(`    ${party} — ₹${amount.toFixed(2)}`);
      const dir = mkdtempSync(join(tmpdir(), "mkcp-bulk-"));
      const scenarioPath = join(dir, "scenario.json");
      const payloadsPath = join(dir, "payloads.json");

      writeFileSync(scenarioPath, JSON.stringify({
        kind: side,
        date: DATE,
        accountLedgerName: "HDFC BANK",
        rows: [{ party, amount, instrument: `UTR${STAMP}` }],
        bills: {
          [party]: bills.map((b) => ({
            billRef: b.name, date: iso(b.date), outstanding: r2(b.outstanding), daysPastDue: 0,
          })),
          [otherParty]: [{ billRef: otherBill.name, date: iso(otherBill.date), outstanding: r2(otherBill.outstanding), daysPastDue: 0 }],
        },
      }, null, 2));

      execFileSync("npx", ["tsx", "scripts/emit-money-payloads.mts", scenarioPath, payloadsPath], {
        cwd: WEB, stdio: "inherit", shell: true,
      });

      const emitted: Array<{
        party: string; problems: string[];
        allocation: { lines: Array<{ billRef: string; amount: number }>; onAccount: number };
        payload: VoucherPayload;
      }> = JSON.parse(readFileSync(payloadsPath, "utf8"));

      ok("the engine produced a payload", emitted.length === 1, `${emitted.length}`);
      ok("with no validation problems", emitted[0].problems.length === 0, emitted[0].problems.join("; "));
      ok("it did NOT reach across to the other party's bill",
        !emitted[0].allocation.lines.some((l) => l.billRef === otherBill.name),
        emitted[0].allocation.lines.map((l) => l.billRef).join(", "));
      ok("it cleared the oldest bill in full",
        emitted[0].allocation.lines[0]?.billRef === bills[0].name &&
        Math.abs(emitted[0].allocation.lines[0].amount - bills[0].outstanding) < 0.02,
        `${emitted[0].allocation.lines[0]?.billRef} ₹${emitted[0].allocation.lines[0]?.amount}`);
      ok("it part-paid the next one",
        emitted[0].allocation.lines.length >= 2 &&
        emitted[0].allocation.lines[1].amount < bills[1].outstanding - 0.01,
        emitted[0].allocation.lines.map((l) => `${l.billRef} ₹${l.amount}`).join(" | "));
      ok("it accounted for every rupee",
        Math.abs(emitted[0].allocation.lines.reduce((s, l) => s + l.amount, 0) + emitted[0].allocation.onAccount - amount) < 0.02,
        `₹${amount}`);

      // ═════ Push and read back ═════════════════════════════════════════
      H(`${voucherType.toUpperCase()} · PUSHING AND READING BACK`);
      const voucher = emitted[0].payload;
      // Recorded BEFORE the push: safePush returning ok:false does not mean
      // nothing was created — it rejects on its read-back diff, not on whether
      // Tally stored something. A cleanup list built from successes leaves real
      // vouchers behind, which is exactly what happened here once.
      created.push({ type: voucherType, number: voucher.voucherNumber! });
      const res = await safePush(U, company, voucher);
      ok(`${voucher.voucherNumber} pushed`, res.ok,
        res.ok ? `₹${amount}` : (res.errors ?? []).concat(res.differences ?? []).join("; ").slice(0, 130));
      if (!await healthy()) throw new Error("Tally stopped answering");

      const stored = (await vouchersOnDay(company)).find((v) => fld(v, "VOUCHERNUMBER") === voucher.voucherNumber);
      ok(`the ${side} is in the books`, Boolean(stored));

      if (stored) {
        const allocs = allocationsOf(stored);
        const partyAllocs = allocs.filter((a) => a.ledger === party);

        ok("it carries bill allocations", partyAllocs.length > 0, `${partyAllocs.length}`);
        // THE check this whole script exists for.
        ok(`EVERY allocation stayed "Agst Ref"`,
          partyAllocs.length > 0 && partyAllocs.every((a) => /Agst Ref/i.test(a.type)),
          partyAllocs.map((a) => `${a.bill} ${a.type}`).join(" | "));
        ok("every bill cited belongs to THIS party",
          partyAllocs.every((a) => bills.some((b) => b.name === a.bill) || /On Account/i.test(a.type)),
          partyAllocs.map((a) => a.bill).join(", "));
        ok("the other party's bill was never cited", !allocs.some((a) => a.bill === otherBill.name));
        ok("the allocations match what the engine decided",
          emitted[0].allocation.lines.every((l) =>
            partyAllocs.some((a) => a.bill === l.billRef && Math.abs(Math.abs(a.amount) - l.amount) < 0.02)),
          partyAllocs.map((a) => `${a.bill} ₹${Math.abs(a.amount)}`).join(" | "));
        ok("it is not an invoice and carries no GST identity",
          fld(stored, "ISINVOICE") === "No" && !fld(stored, "PARTYGSTIN"),
          `ISINVOICE=${fld(stored, "ISINVOICE")} GSTIN="${fld(stored, "PARTYGSTIN")}"`);
      }
    }
  } finally {
    if (KEEP) {
      console.log(`\n--keep: leaving ${created.length} voucher(s) in place.`);
    } else {
      H("CLEANING UP");
      // Only what this run created. The bills it settled are REAL and are left
      // exactly as they were — deleting the receipt restores their outstanding.
      let gone = 0;
      for (const v of created) if (await remove(company, v.type, v.number)) gone++;
      const left = (await vouchersOnDay(company))
        .filter((v) => created.some((c) => c.number === fld(v, "VOUCHERNUMBER")));
      ok("everything this run created has been removed", left.length === 0,
        `created ${created.length}, deleted ${gone}, ${left.length} left`);
    }
    console.log(`\nTally ${(await healthy()) ? "still healthy" : "\x1b[31mNOT ANSWERING\x1b[0m"}.`);
  }

  console.log(`\n\x1b[1m${passed} passed · ${failed} failed\x1b[0m`);
  if (failed) console.log(`\nfailed:\n${failures.map((f) => `  · ${f}`).join("\n")}`);
  console.log();
  process.exit(failed ? 1 : 0);
})();
