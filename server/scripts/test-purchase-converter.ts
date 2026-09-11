/**
 * Do the two purchase paths produce the SAME voucher in Tally?
 *
 * A purchase can reach Tally two ways today:
 *
 *   file handoff  buildPurchaseXml → a file → a human imports it.
 *                 No master resolution, no guard, no read-back.
 *   push queue    purchaseToPayload → voucherPusher → safePush.
 *                 Guarded, serialised, and diffed against what Tally stored.
 *
 * Both exist while the first is retired, so any difference in ledger, sign or
 * total would put two different vouchers in the books depending on which button
 * was pressed. The unit tests prove the payload matches the XML's arithmetic;
 * only Tally can prove the two produce the same voucher.
 *
 * So: push one of each, under different numbers, read both back, and compare
 * them field by field. Both are deleted afterwards.
 *
 *   npx tsx scripts/test-purchase-converter.ts [--keep]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { safePush } from "../src/services/safePush.js";
import type { VoucherPayload } from "../src/types.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const KEEP = process.argv.includes("--keep");
const WEB = process.env.WEB_DASHBOARD_DIR
  ?? "C:/Users/kanis/Desktop/Code/MKCP/Live-Sync/MKCP MOB2/web-dashboard";

const DATE = new Date().toISOString().slice(0, 10);
const STAMP = DATE.replace(/-/g, "");
const TAG = `PC${Date.now().toString().slice(-5)}`;
const AMOUNT = 10_000;

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
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkPc</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkPc" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD>
<NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD><NATIVEMETHOD>PlaceOfSupply</NATIVEMETHOD>
<NATIVEMETHOD>StateName</NATIVEMETHOD><NATIVEMETHOD>IsInvoice</NATIVEMETHOD>
<NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD><NATIVEMETHOD>AllInventoryEntries</NATIVEMETHOD>
<FILTER>MkPcF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MkPcF">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${STAMP}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw: string = await tallyPost(U, xml, 180_000, true);
  return [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]);
}

/** Ledger name → signed amount, from the balanced list. */
function ledgersOf(v: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const [, e] of v.matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/g)) {
    const name = fld(e, "LEDGERNAME");
    const amt = numOf(fld(e, "AMOUNT"));
    if (name && Number.isFinite(amt)) m.set(name, (m.get(name) ?? 0) + amt);
  }
  return m;
}

function stockOf(v: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const [, e] of v.matchAll(/<ALLINVENTORYENTRIES\.LIST>([\s\S]*?)<\/ALLINVENTORYENTRIES\.LIST>/g)) {
    const name = fld(e, "STOCKITEMNAME");
    const amt = numOf(fld(e, "AMOUNT"));
    if (name && Number.isFinite(amt)) m.set(name, (m.get(name) ?? 0) + amt);
  }
  return m;
}

const importXml = (xml: string) => tallyPost(U, xml, 60_000, true) as Promise<string>;

async function remove(company: string, number: string): Promise<boolean> {
  const rid = `MKCP|Purchase|${number}|2026-27`;
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(rid)}" VCHTYPE="Purchase" ACTION="Delete"><DATE>${STAMP}</DATE><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(number)}</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
  const raw = await importXml(xml);
  return (parseInt(fld(raw, "DELETED") || "0", 10) || 0) > 0;
}

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  console.log(`\n\x1b[1mPurchase — the file path and the queue path, compared in Tally\x1b[0m\n`);
  console.log(`company  "${company}"`);

  const xmlNum = `${TAG}/XML`;
  const payNum = `${TAG}/PAY`;
  const created: string[] = [];

  try {
    // ═════ Emit both, from the REAL builders ════════════════════════════
    H("EMITTING FROM THE WEB REPO");
    const dir = mkdtempSync(join(tmpdir(), "mkcp-pc-"));
    const run = (out: string, number: string) =>
      execFileSync("npx", ["tsx", "scripts/emit-purchase-xml.mts", out, number, DATE, String(AMOUNT)],
        { cwd: WEB, stdio: "inherit", shell: true });

    const xmlPath = join(dir, "a.xml");
    const payPath = join(dir, "b.xml");
    run(xmlPath, xmlNum);
    run(payPath, payNum);

    const xml = readFileSync(xmlPath, "utf8");
    const payload: VoucherPayload = JSON.parse(readFileSync(payPath.replace(/\.xml$/, ".payload.json"), "utf8"));
    ok("both the XML and the payload were emitted", xml.length > 0 && !!payload.voucherNumber,
      `${payload.voucherType} ${payload.voucherNumber}`);

    // ═════ Push each by its own path ════════════════════════════════════
    H("PUSHING BOTH PATHS");
    created.push(xmlNum);
    const importResult = await importXml(xml);
    ok(`${xmlNum} imported as raw XML (the file path)`,
      (parseInt(fld(importResult, "CREATED") || "0", 10) || 0) === 1,
      fld(importResult, "LINEERROR") || "created=1");

    created.push(payNum);
    const res = await safePush(U, company, payload);
    ok(`${payNum} pushed through safePush (the queue path)`, res.ok,
      res.ok ? "guarded and read back" : (res.errors ?? []).concat(res.differences ?? []).join("; ").slice(0, 120));
    if (!await healthy()) throw new Error("Tally stopped answering");

    // ═════ Compare what Tally stored ════════════════════════════════════
    H("COMPARING WHAT TALLY STORED");
    const day = await vouchersOnDay(company);
    const a = day.find((v) => fld(v, "VOUCHERNUMBER") === xmlNum);
    const b = day.find((v) => fld(v, "VOUCHERNUMBER") === payNum);
    ok("both vouchers are in the books", Boolean(a && b));
    if (!a || !b) throw new Error("one of the two vouchers is missing");

    const la = ledgersOf(a), lb = ledgersOf(b);
    ok("the same ledgers are posted",
      [...la.keys()].sort().join("|") === [...lb.keys()].sort().join("|"),
      `file: ${[...la.keys()].join(", ")}  ·  queue: ${[...lb.keys()].join(", ")}`);

    let same = true;
    const diffs: string[] = [];
    for (const [name, amt] of la) {
      const other = lb.get(name);
      if (other === undefined || Math.abs(other - amt) > 0.02) {
        same = false;
        diffs.push(`${name}: ${amt} vs ${other ?? "absent"}`);
      }
    }
    ok("every ledger carries the same amount", same, diffs.join(" | ") ||
      [...la].map(([n, v]) => `${n} ${v}`).join(" | "));

    const sa = stockOf(a), sb = stockOf(b);
    ok("the same stock lines, at the same value",
      [...sa.keys()].sort().join("|") === [...sb.keys()].sort().join("|") &&
      [...sa].every(([n, v]) => Math.abs((sb.get(n) ?? NaN) - v) < 0.02),
      [...sa].map(([n, v]) => `${n} ${v}`).join(" | "));

    for (const f of ["PARTYLEDGERNAME", "PARTYGSTIN", "PLACEOFSUPPLY", "STATENAME", "ISINVOICE"]) {
      ok(`${f} matches`, fld(a, f) === fld(b, f), `"${fld(a, f)}" vs "${fld(b, f)}"`);
    }

    // The queue path's whole advantage: it would have refused a bad voucher.
    ok("the queue path was guarded and read back; the file path was not",
      res.ok, "safePush diffed the stored voucher field by field");
  } finally {
    H("CLEANING UP");
    let gone = 0;
    for (const n of created) if (await remove(company, n)) gone++;
    const left = (await vouchersOnDay(company)).filter((v) => fld(v, "VOUCHERNUMBER").startsWith(TAG));
    if (KEEP) console.log(`    --keep: ${left.length} left in place.`);
    else ok("both vouchers removed", left.length === 0,
      `created ${created.length}, deleted ${gone}, ${left.length} left`);
    console.log(`\nTally ${(await healthy()) ? "still healthy" : "\x1b[31mNOT ANSWERING\x1b[0m"}.`);
  }

  console.log(`\n\x1b[1m${passed} passed · ${failed} failed\x1b[0m`);
  if (failed) console.log(`\nfailed:\n${failures.map((f) => `  · ${f}`).join("\n")}`);
  console.log();
  process.exit(failed ? 1 : 0);
})();
