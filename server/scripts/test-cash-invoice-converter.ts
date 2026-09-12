/**
 * Do the two CASH INVOICE paths produce the same voucher in Tally?
 *
 * The counter-sale twin of test-purchase-converter.ts, and it matters at least
 * as much: about a third of this company's sales are cash.
 *
 *   file handoff  buildCashInvoicesXml → a file → a human imports it
 *   push queue    cashInvoiceToPayload → voucherPusher → safePush
 *
 * Both exist while the first is retired. Unit tests prove the converter matches
 * the builder's arithmetic; only Tally can prove the two produce the same
 * voucher.
 *
 * Run twice over: a Cash walk-in and a registered party ledger, because the two
 * take different branches (party ledger, tax head, GST identity).
 *
 *   npx tsx scripts/test-cash-invoice-converter.ts [--keep]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters, gstRateFor, type TallyMasters } from "../src/services/tallyMasters.js";
import { safePush } from "../src/services/safePush.js";
import type { VoucherPayload } from "../src/types.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const KEEP = process.argv.includes("--keep");
const WEB = process.env.WEB_DASHBOARD_DIR
  ?? "C:/Users/kanis/Desktop/Code/MKCP/Live-Sync/MKCP MOB2/web-dashboard";

const DATE = new Date().toISOString().slice(0, 10);
const STAMP = DATE.replace(/-/g, "");
const TAG = `CI${Date.now().toString().slice(-5)}`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const numOf = (s: string) => { const m = /^\s*(-?[\d.]+)/.exec(String(s).replace(/,/g, "")); return m ? parseFloat(m[1]) : NaN; };
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
const healthy = async () => {
  try { return convertCompanies(await tallyPost(U, HEALTH_XML, 10_000)).length > 0; } catch { return false; }
};

async function vouchersOnDay(company: string): Promise<string[]> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkCi</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkCi" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD>
<NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD><NATIVEMETHOD>PlaceOfSupply</NATIVEMETHOD>
<NATIVEMETHOD>IsInvoice</NATIVEMETHOD>
<NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD><NATIVEMETHOD>AllInventoryEntries</NATIVEMETHOD>
<FILTER>MkCiF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MkCiF">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${STAMP}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw: string = await tallyPost(U, xml, 180_000, true);
  return [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]);
}

function ledgersOf(v: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const [, e] of v.matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/g)) {
    const name = fld(e, "LEDGERNAME");
    const amt = numOf(fld(e, "AMOUNT"));
    if (name && Number.isFinite(amt)) m.set(name, (m.get(name) ?? 0) + amt);
  }
  return m;
}

const importXml = (xml: string) => tallyPost(U, xml, 60_000, true) as Promise<string>;

async function remove(company: string, number: string): Promise<boolean> {
  const rid = `MKCP|Sales|${number}|2026-27`;
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(rid)}" VCHTYPE="Sales" ACTION="Delete"><DATE>${STAMP}</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(number)}</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
  const raw = await importXml(xml);
  return (parseInt(fld(raw, "DELETED") || "0", 10) || 0) > 0;
}

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  const m: TallyMasters = await loadMasters(U, company);
  const item = [...m.items.values()].find((i) => i.closingStock > 40 && i.closingRate > 20)!;
  const gst = gstRateFor(m, item.name, DATE).rate;
  const party = [...m.ledgers.values()].find(
    (l) => /SUNDRY DEBTORS/i.test(l.parent) && /WEST BENGAL/i.test(l.state ?? ""))!;

  console.log(`\n\x1b[1mCash invoice — the file path and the queue path, compared in Tally\x1b[0m\n`);
  console.log(`company  "${company}"`);
  console.log(`item     ${item.name} @ ₹${item.closingRate} · GST ${gst}%`);
  console.log(`party    ${party.name} (for the registered-buyer case)`);

  const created: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "mkcp-ci-"));

  /* A JSON scenario, not positional arguments. Item and ledger names here
     contain spaces and brackets, and `shell: true` concatenates argv without
     escaping — the first version of this asked Tally for a stock item called
     "BABY" and a party ledger called "5".

     `company` is the REAL company name read from Tally, not the builder's
     default: the sandbox is "M.K.CYCLES (P) LTD. - (from 1-Apr-26)", and an
     XML carrying the plain name fails with "Could not set SVCurrentCompany". */
  const emit = (out: string, number: string, ledger?: string) => {
    const scenario = join(dir, `${number.replace(/\W/g, "_")}.scenario.json`);
    writeFileSync(scenario, JSON.stringify({
      company, date: DATE, number, cashLedger: "Cash", state: "West Bengal",
      buyer: ledger
        ? { name: ledger, ledger, state: "West Bengal" }
        : { name: "COUNTER SALE" },
      lines: [{
        name: item.name, baseUnit: item.baseUnit, unitsPerPkg: 10, pkgs: 2,
        rate: item.closingRate, gstRate: gst,
      }],
    }, null, 2));
    execFileSync("npx", ["tsx", "scripts/emit-cash-invoice.mts", scenario, out],
      { cwd: WEB, stdio: "inherit", shell: true });
  };

  try {
    for (const [label, ledger] of [
      ["walk-in (Cash)", undefined],
      ["registered party ledger", party.name],
    ] as const) {
      H(label.toUpperCase());
      const xmlNum = `${TAG}/${ledger ? "P" : "C"}X`;
      const payNum = `${TAG}/${ledger ? "P" : "C"}Q`;

      const xmlPath = join(dir, `${payNum.replace(/\W/g, "_")}a.xml`);
      const payPath = join(dir, `${payNum.replace(/\W/g, "_")}b.xml`);
      emit(xmlPath, xmlNum, ledger);
      emit(payPath, payNum, ledger);

      const xml = readFileSync(xmlPath, "utf8");
      const payload: VoucherPayload = JSON.parse(readFileSync(payPath.replace(/\.xml$/, ".payload.json"), "utf8"));

      created.push(xmlNum);
      const imported = await importXml(xml);
      ok(`${xmlNum} imported as raw XML`,
        (parseInt(fld(imported, "CREATED") || "0", 10) || 0) === 1,
        fld(imported, "LINEERROR") || "created=1");

      created.push(payNum);
      const res = await safePush(U, company, payload);

      /* A walk-in used to be REFUSED here, and the guard was right to refuse it:
         the shared "Cash" ledger carries no state, so Tally could not derive a
         place of supply and the voucher would land in GSTR-1's incomplete-
         information bucket. The file path never caught this — it has no guard
         at all — which is the whole difference the queue makes.

         The payload now declares `placeOfSupply` instead, so the information
         Tally needs is present without misdescribing the Cash ledger (which is
         not a party and cannot truthfully hold a state). This assertion is the
         one that matters: about a third of this company's sales are cash, and
         until it passed none of them could go through the guarded path. */
      ok(`${payNum} pushed through safePush`, res.ok,
        res.ok ? "guarded and read back" : (res.errors ?? []).concat(res.differences ?? []).join("; ").slice(0, 120));
      if (!await healthy()) throw new Error("Tally stopped answering");

      const day = await vouchersOnDay(company);
      const a = day.find((v) => fld(v, "VOUCHERNUMBER") === xmlNum);
      const b = day.find((v) => fld(v, "VOUCHERNUMBER") === payNum);
      ok("both vouchers are in the books", Boolean(a && b));
      if (!a || !b) continue;

      const la = ledgersOf(a), lb = ledgersOf(b);
      ok("the same ledgers are posted",
        [...la.keys()].sort().join("|") === [...lb.keys()].sort().join("|"),
        `file: ${[...la.keys()].join(", ")}  ·  queue: ${[...lb.keys()].join(", ")}`);

      const diffs: string[] = [];
      for (const [name, amt] of la) {
        const other = lb.get(name);
        if (other === undefined || Math.abs(other - amt) > 0.02) diffs.push(`${name}: ${amt} vs ${other ?? "absent"}`);
      }
      ok("every ledger carries the same amount", diffs.length === 0,
        diffs.join(" | ") || [...la].map(([n, v]) => `${n} ${v}`).join(" | "));

      ok("billed to the same ledger", fld(a, "PARTYLEDGERNAME") === fld(b, "PARTYLEDGERNAME"),
        `"${fld(a, "PARTYLEDGERNAME")}"`);
      // A walk-in is local by definition, so this must be CGST+SGST either way.
      const heads = [...lb.keys()].filter((n) => /OUTPUT/i.test(n));
      ok(ledger ? "tax heads follow the party's state" : "a walk-in is taxed locally (CGST+SGST, never IGST)",
        heads.length > 0 && !heads.some((h) => /IGST/i.test(h)),
        heads.join(", "));

      /* The reason the whole thing exists. A voucher can balance, read back
         identical and still be unfilable, because GSTR-1 classifies on fields
         the diff never compares. So check the stored PLACEOFSUPPLY directly —
         and check it on the QUEUE voucher, since that is the path being proven.

         For the walk-in this is the field that was missing entirely; for the
         registered party it must still be THEIR state, proving the declaration
         did not leak in and overwrite a ledger that already had one. */
      const pos = fld(b, "PLACEOFSUPPLY");
      const want = ledger ? (party.state ?? "").trim() : "West Bengal";
      ok(ledger ? "place of supply is still the party's own state" : "the walk-in carries a place of supply at all",
        pos.trim().toUpperCase() === want.toUpperCase(),
        `stored "${pos}", expected "${want}"`);
    }
  } finally {
    H("CLEANING UP");
    let gone = 0;
    for (const n of created) if (await remove(company, n)) gone++;
    const left = (await vouchersOnDay(company)).filter((v) => fld(v, "VOUCHERNUMBER").startsWith(TAG));
    if (KEEP) console.log(`    --keep: ${left.length} left in place.`);
    else ok("every voucher this run created has been removed", left.length === 0,
      `created ${created.length}, deleted ${gone}, ${left.length} left`);
    console.log(`\nTally ${(await healthy()) ? "still healthy" : "\x1b[31mNOT ANSWERING\x1b[0m"}.`);
  }

  console.log(`\n\x1b[1m${passed} passed · ${failed} failed\x1b[0m`);
  if (failed) console.log(`\nfailed:\n${failures.map((f) => `  · ${f}`).join("\n")}`);
  console.log();
  process.exit(failed ? 1 : 0);
})();
