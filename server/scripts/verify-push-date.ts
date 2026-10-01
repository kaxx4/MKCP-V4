/**
 * PUSH-P1 — a backdated Ludhiana purchase, pushed on its confirmed bill date,
 * proven against the SANDBOX Tally on this laptop. Never the real books.
 *
 * Owner, 1-Oct-2026: "make sure ludhiana bill when pushed, i get a prompt that
 * pushes it on that date". The web app now asks; this proves what the answer
 * does in Tally, one request at a time:
 *
 *   --company   list the companies Tally holds (harmless) and stop
 *   --plan      load masters, pick a Punjab supplier + an item, write the fixture
 *               the web emitter turns into the payload the app would queue
 *   --refuse    the filed-period and pre-registration refusals happen in the
 *               guard, BEFORE an import request is built (no voucher request)
 *   --push      push the emitted payload through safePush, then read it back
 *               with every field ASKED FOR BY NAME (G7) and assert:
 *               DATE = the confirmed bill date, REFERENCEDATE = the supplier's
 *               date, INPUT IGST = Tally's own rate for that date × goods,
 *               party GSTIN = the registration in force on that date.
 *
 * Every stage refuses unless MKCP_TALLY_ROLE=sandbox and Tally is localhost:9000.
 * The test voucher is narrated "CLAUDE-TEST PUSH-P1 <date>" and numbered
 * "CT-P1-…" (never the MKCP- series, a real supplier's bill prefix). It is LEFT
 * in the sandbox for the owner to inspect, per his 23-Sep rule.
 *
 * The caller holds the cross-agent tally.lock around each stage.
 *
 * STATUS 1-Oct-2026: only --company has run (one company, the shared name
 * "M.K.CYCLES (P) LTD. - (from 1-Apr-26)"). --plan was stopped by the session's
 * permission gate because that name is production's too; nothing past it has
 * run, so nothing here is yet proven against Tally.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters, registrationOn, gstRateFor } from "../src/services/tallyMasters.js";
import { guardVoucher } from "../src/services/pushGuard.js";
import { safePush } from "../src/services/safePush.js";
import { isSandbox } from "../src/services/tallyRole.js";
import type { VoucherPayload } from "../src/types.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
if (!isSandbox()) { console.error("REFUSED — MKCP_TALLY_ROLE is not 'sandbox'."); process.exit(2); }
if (!/^https?:\/\/(localhost|127\.0\.0\.1):9000\/?$/i.test(U)) { console.error(`REFUSED — TALLY_URL is ${U}.`); process.exit(2); }

const DATA = process.env.PUSH_P1_DIR || join(here, "..", "data", "push-p1");
mkdirSync(DATA, { recursive: true });
const FIXTURE = join(DATA, "fixture.json");
const PAYLOAD = join(DATA, "payload.json");
const BILL_DATE = process.env.PUSH_P1_BILL_DATE || "2026-09-24";

const arg = (f: string) => process.argv.includes(f);
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? `  (${detail})` : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

async function company(): Promise<string> {
  const cs = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000));
  return cs[0]?.name ?? "";
}

async function main() {
  if (arg("--company")) {
    const cs = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000));
    console.log(JSON.stringify(cs.map((c: any) => ({ name: c.name, startingFrom: c.startingFrom ?? c.booksFrom, ...c })), null, 1).slice(0, 2000));
    return;
  }

  const co = (JSON.parse(readFileSafe(FIXTURE) ?? "{}").company as string) || "";

  if (arg("--plan")) {
    const name = await company();
    const m = await loadMasters(U, name);
    const supplier = [...m.ledgers.values()].find(l =>
      /creditors/i.test(l.parent) && /punjab/i.test(l.state) && l.registrations.some(r => r.gstin) &&
      registrationOn(l, BILL_DATE).gstin && /TOGO CYCLES$/i.test(l.name),
    ) ?? [...m.ledgers.values()].find(l => /creditors/i.test(l.parent) && /punjab/i.test(l.state) && registrationOn(l, BILL_DATE).gstin);
    if (!supplier) throw new Error("no Punjab supplier with a registration in force on the bill date");
    const item = [...m.items.values()].find(i => i.baseUnit && i.closingRate > 20 && (gstRateFor(m, i.name, BILL_DATE)?.rate ?? 0) > 0);
    if (!item) throw new Error("no item with a GST rate on the bill date");
    const fx = {
      company: name, billDate: BILL_DATE,
      supplier: supplier.name, supplierGstinOnDate: registrationOn(supplier, BILL_DATE).gstin,
      registrations: supplier.registrations,
      item: item.name, unit: item.baseUnit, rate: Math.round(item.closingRate * 100) / 100,
      gstRateOnDate: gstRateFor(m, item.name, BILL_DATE)?.rate ?? null,
      purchaseLedger: [...m.ledgers.keys()].find(k => /^PURCHASE \( GST CENTRAL \)$/i.test(k)) ?? null,
      igstLedger: [...m.ledgers.keys()].find(k => /^INPUT IGST$/i.test(k)) ?? null,
    };
    writeFileSync(FIXTURE, JSON.stringify(fx, null, 1));
    console.log(JSON.stringify(fx, null, 1));
    return;
  }

  const payload = JSON.parse(readFileSync(PAYLOAD, "utf8")) as VoucherPayload;
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));

  if (arg("--refuse")) {
    // Masters come from the agent's cache-or-load; the GUARD is what refuses, and
    // it runs before any import request is built.
    const m = await loadMasters(U, co || await company());
    const { backdatedPurchaseRefusals } = await import("../src/services/pushGuard.js");
    const august = { ...payload, date: "2026-08-27" };
    const e1 = backdatedPurchaseRefusals(august, m, "2026-08-31");
    ok("an August bill date with August filed is refused by the guard", e1.length === 1 && /already filed/.test(e1[0]), e1[0]);
    const party = m.ledgers.get(payload.partyLedgerName)!;
    const saved = party.registrations;
    party.registrations = saved.map((r, i) => (i === 0 ? { ...r, applicableFrom: "20260925" } : r)).slice(0, 1);
    const g = guardVoucher(payload, m);
    party.registrations = saved;
    ok("a bill dated before the supplier's registration starts is refused by guardVoucher", !g.ok && g.errors.some(e => /registration .* starts 2026-09-25/.test(e)), g.errors.find(e => /registration/.test(e)));
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exit(1);
    return;
  }

  if (arg("--push")) {
    const name = co || await company();
    const r = await safePush(U, name, payload);
    console.log(`safePush: ok=${r.ok} stage=${(r as any).stage ?? ""} id=${(r as any).voucherId ?? ""}`);
    for (const e of r.errors ?? []) console.log(`  error: ${e}`);
    for (const d of (r as any).differences ?? []) console.log(`  diff: ${JSON.stringify(d)}`);
    writeFileSync(join(DATA, "push-result.json"), JSON.stringify(r, null, 1));
    if (!r.ok) process.exit(1);
    return;
  }

  if (arg("--readback")) {
    const name = co || await company();
    const day = payload.date.replace(/-/g, "");
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkP1</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(name)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkP1" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>EffectiveDate</NATIVEMETHOD><NATIVEMETHOD>ReferenceDate</NATIVEMETHOD><NATIVEMETHOD>Reference</NATIVEMETHOD>
<NATIVEMETHOD>VoucherNumber</NATIVEMETHOD><NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD>
<NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD><NATIVEMETHOD>PlaceOfSupply</NATIVEMETHOD><NATIVEMETHOD>StateName</NATIVEMETHOD><NATIVEMETHOD>Narration</NATIVEMETHOD>
<NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD><NATIVEMETHOD>AllInventoryEntries</NATIVEMETHOD>
<FILTER>MkP1F</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MkP1F">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${day}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
    const raw: string = await tallyPost(U, xml, 120_000, true);
    const fld = (v: string, t: string) => { const mm = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i").exec(v); return mm ? mm[1].trim() : ""; };
    const v = [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map(x => x[0]).find(x => fld(x, "VOUCHERNUMBER") === payload.voucherNumber);
    writeFileSync(join(DATA, "readback.xml"), v ?? raw);
    ok(`voucher ${payload.voucherNumber} is in Tally on ${payload.date}`, !!v);
    if (!v) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
    const want = (iso: string) => iso.replace(/-/g, "");
    ok("DATE = the confirmed bill date", fld(v, "DATE") === want(payload.date), fld(v, "DATE"));
    ok("REFERENCEDATE = the supplier's bill date", fld(v, "REFERENCEDATE") === want(fx.billDate), fld(v, "REFERENCEDATE"));
    const eff = fld(v, "EFFECTIVEDATE");
    ok("EFFECTIVEDATE follows DATE (not sent; Tally derives it)", !eff || eff === want(payload.date), eff || "(absent)");
    ok("party GSTIN = the registration in force on that date", fld(v, "PARTYGSTIN") === fx.supplierGstinOnDate, fld(v, "PARTYGSTIN"));
    ok("narration carries the test tag", /CLAUDE-TEST PUSH-P1/.test(fld(v, "NARRATION")), fld(v, "NARRATION"));
    const ledgers = [...v.matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/g)].map(x => ({ name: fld(x[1], "LEDGERNAME"), amount: parseFloat(fld(x[1], "AMOUNT")) }));
    const goods = payload.inventoryEntries!.reduce((s, e) => s + e.amount, 0);
    const igst = ledgers.find(l => /INPUT IGST/i.test(l.name));
    const expected = Math.round(goods * fx.gstRateOnDate) / 100;
    ok(`INPUT IGST = ${fx.gstRateOnDate}% (Tally's rate on ${fx.billDate}) of ${goods}`, !!igst && Math.abs(Math.abs(igst.amount) - expected) < 0.02, `stored ${igst?.amount}, expected ${expected}`);
    ok("no CGST/SGST on an inter-state purchase", !ledgers.some(l => /INPUT (CGST|SGST)/i.test(l.name)));
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exit(1);
    return;
  }

  console.log("usage: --company | --plan | --refuse | --push | --readback");
}

function readFileSafe(p: string): string | null { try { return readFileSync(p, "utf8"); } catch { return null; } }

main().catch(e => { console.error(`✗ ${e?.message ?? e}`); process.exit(1); });
