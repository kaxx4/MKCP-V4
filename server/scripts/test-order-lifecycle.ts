/**
 * One order, two states, ONE voucher — proved in Tally.
 *
 * The web app's model is that an order is not a chain of linked documents. It
 * is a single voucher whose type changes: a Sales Order Note (goods booked,
 * stock committed, nothing owed) altered in place into a Sales invoice (goods
 * dispatched, stock moved, amount receivable).
 *
 * ── What is already settled, and what is not ──────────────────────────────
 *
 * That a Sales Order Note converts to Sales on the same REMOTEID, keeping its
 * MASTERID, was proved on 2026-09-11. This harness exists for the part that was
 * NOT: the invoice also takes a DIFFERENT VOUCHER NUMBER, because sales
 * numbering has to stay continuous in Tally for GST. So the Alter changes the
 * type AND the number at once, and only the REMOTEID holds the two together.
 *
 * If that does not work the failure is silent and expensive. An Alter against a
 * REMOTEID Tally cannot resolve does not error — it performs a CREATE and
 * returns created=1. The books would then hold an unbilled order AND an invoice
 * for the same goods: the stock counted twice, the customer invoiced once.
 *
 * So every check below counts vouchers before and after, and a duplicate is
 * treated as a failure rather than inferred from the response.
 *
 * The payloads come from the WEB APP's own engine via
 * scripts/emit-order-lifecycle.mts. A harness that composes its own payloads
 * proves only the harness.
 *
 *   npx tsx scripts/test-order-lifecycle.ts [--keep]
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
const TAG = `OL${Date.now().toString().slice(-5)}`;

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

/**
 * Every voucher on ONE day, with the fields this harness judges on.
 *
 * Scoped to a single day deliberately: entry blocks across a wider range are
 * 64x the payload and wedge Tally's single-threaded port — a year-wide pull
 * once timed out at 240s and kept the port busy for another 77s after that.
 */
async function vouchersOnDay(company: string): Promise<string[]> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkOl</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkOl" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD>
<NATIVEMETHOD>MasterId</NATIVEMETHOD><NATIVEMETHOD>PlaceOfSupply</NATIVEMETHOD>
<NATIVEMETHOD>IsInvoice</NATIVEMETHOD><NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD>
<NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD><NATIVEMETHOD>AllInventoryEntries</NATIVEMETHOD>
<FILTER>MkOlF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MkOlF">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${STAMP}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw: string = await tallyPost(U, xml, 180_000, true);
  return [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]);
}

/** Every voucher on today whose number belongs to this run. */
const mine = (day: string[]) => day.filter((v) => fld(v, "VOUCHERNUMBER").startsWith(TAG));

function ledgersOf(v: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const [, e] of v.matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/g)) {
    const name = fld(e, "LEDGERNAME");
    const amt = numOf(fld(e, "AMOUNT"));
    if (name && Number.isFinite(amt)) m.set(name, (m.get(name) ?? 0) + amt);
  }
  return m;
}
function itemsOf(v: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const [, e] of v.matchAll(/<ALLINVENTORYENTRIES\.LIST>([\s\S]*?)<\/ALLINVENTORYENTRIES\.LIST>/g)) {
    const name = fld(e, "STOCKITEMNAME");
    const qty = numOf(fld(e, "ACTUALQTY"));
    if (name) m.set(name, (m.get(name) ?? 0) + (Number.isFinite(qty) ? qty : 0));
  }
  return m;
}

const importXml = (xml: string) => tallyPost(U, xml, 60_000, true) as Promise<string>;

/**
 * Delete by the REMOTEID the voucher was CREATED with, whatever type it now
 * holds — the same identity rule this harness is testing.
 *
 * ⚠ `DELETED` in the response is not proof: a failed delete has been observed
 * returning DELETED=1 alongside a LINEERROR. The caller re-reads the books.
 */
async function remove(company: string, remoteId: string, type: string): Promise<boolean> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(remoteId)}" VCHTYPE="${esc(type)}" ACTION="Delete"><DATE>${STAMP}</DATE><VOUCHERTYPENAME>${esc(type)}</VOUCHERTYPENAME></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
  const raw = await importXml(xml);
  const err = fld(raw, "LINEERROR");
  return !err && (parseInt(fld(raw, "DELETED") || "0", 10) || 0) > 0;
}

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  const m: TallyMasters = await loadMasters(U, company);
  const item = [...m.items.values()].find((i) => i.closingStock > 40 && i.closingRate > 20)!;
  const gst = gstRateFor(m, item.name, DATE).rate;
  const party = [...m.ledgers.values()].find(
    (l) => /SUNDRY DEBTORS/i.test(l.parent) && /WEST BENGAL/i.test(l.state ?? ""))!;

  const orderNumber = `${TAG}/SO`;
  const invoiceNumber = `${TAG}/INV`;

  console.log(`\n\x1b[1mOne order through its states — booked, then billed\x1b[0m\n`);
  console.log(`company  "${company}"`);
  console.log(`item     ${item.name} @ ₹${item.closingRate} · GST ${gst}%`);
  console.log(`party    ${party.name}`);
  console.log(`numbers  ${orderNumber} → ${invoiceNumber}  (the number CHANGES; the identity must not)`);

  const dir = mkdtempSync(join(tmpdir(), "mkcp-ol-"));
  const scenario = join(dir, "scenario.json");
  writeFileSync(scenario, JSON.stringify({
    company, date: DATE, orderNumber, invoiceNumber,
    party: { name: party.name, state: party.state || "West Bengal" },
    lines: [{
      name: item.name, baseUnit: item.baseUnit, unitsPerPkg: 10, pkgs: 2,
      rate: item.closingRate, gstRate: gst,
    }],
  }, null, 2));

  execFileSync("npx", ["tsx", "scripts/emit-order-lifecycle.mts", scenario, join(dir, "order")],
    { cwd: WEB, stdio: "inherit", shell: true });

  const pending: VoucherPayload = JSON.parse(readFileSync(join(dir, "order.pending.json"), "utf8"));
  const billed: VoucherPayload = JSON.parse(readFileSync(join(dir, "order.billed.json"), "utf8"));

  // Recorded BEFORE anything is pushed, so cleanup runs even if a push throws
  // half way. Recording it after a successful push is how a previous harness
  // left two real vouchers in the books.
  const remoteId = pending.remoteId!;
  let pushedAnything = false;

  try {
    H("THE ENGINE'S OWN CLAIM");
    ok("the two states share one identity", pending.remoteId === billed.remoteId, remoteId);
    ok("the order is booked, not invoiced",
      pending.voucherType === "Sales Order Note" && pending.isInvoice === false);
    ok("the invoice is an Alter, not a Create",
      billed.action === "Alter" && billed.voucherType === "Sales" && billed.isInvoice === true);
    ok("the invoice carries a different number", billed.voucherNumber !== pending.voucherNumber,
      `${pending.voucherNumber} → ${billed.voucherNumber}`);

    H("BOOKED");
    pushedAnything = true;
    const p1 = await safePush(U, company, pending);
    ok(`${orderNumber} pushed through safePush`, p1.ok,
      p1.ok ? "guarded and read back" : (p1.errors ?? []).concat(p1.differences ?? []).join("; ").slice(0, 140));
    if (!await healthy()) throw new Error("Tally stopped answering");

    const day1 = mine(await vouchersOnDay(company));
    ok("exactly one voucher exists for this order", day1.length === 1, `${day1.length} found`);
    const before = day1[0];
    if (!before) throw new Error("the order is not in the books — nothing further can be judged");

    const masterIdBefore = fld(before, "MASTERID");
    ok("Tally stored it as a Sales Order Note",
      /SALES ORDER/i.test(fld(before, "VOUCHERTYPENAME")), fld(before, "VOUCHERTYPENAME"));
    ok("an order is not an invoice — ISINVOICE=No",
      /^no$/i.test(fld(before, "ISINVOICE")), fld(before, "ISINVOICE"));
    ok("it has a MASTERID to compare against", Boolean(masterIdBefore), masterIdBefore);

    const ledgersBefore = ledgersOf(before);
    const itemsBefore = itemsOf(before);
    ok("it carries the ordered stock", itemsBefore.size > 0,
      [...itemsBefore].map(([n, q]) => `${n} ${q}`).join(", "));

    H("BILLED — THE SAME VOUCHER, CONVERTED");
    const p2 = await safePush(U, company, billed);
    ok(`${invoiceNumber} pushed through safePush`, p2.ok,
      p2.ok ? "guarded and read back" : (p2.errors ?? []).concat(p2.differences ?? []).join("; ").slice(0, 140));
    if (!await healthy()) throw new Error("Tally stopped answering");

    const day2 = mine(await vouchersOnDay(company));

    /* THE ASSERTION THIS HARNESS EXISTS FOR. A silent Create leaves TWO
       vouchers: the order still open and an invoice beside it, the same goods
       counted twice. The count is checked before anything else, because every
       later check would pass just as happily on a duplicate. */
    ok("STILL exactly one voucher — the order was converted, not copied",
      day2.length === 1,
      `${day2.length} found: ${day2.map((v) => `${fld(v, "VOUCHERNUMBER")} (${fld(v, "VOUCHERTYPENAME")})`).join(", ")}`);

    const after = day2.find((v) => fld(v, "VOUCHERNUMBER") === invoiceNumber);
    ok("it now answers to the invoice number", Boolean(after),
      day2.map((v) => fld(v, "VOUCHERNUMBER")).join(", "));
    ok("the order number is gone from the books",
      !day2.some((v) => fld(v, "VOUCHERNUMBER") === orderNumber));
    if (!after) throw new Error("the invoice is not in the books");

    ok("the SAME MASTERID — genuinely one document",
      fld(after, "MASTERID") === masterIdBefore,
      `${masterIdBefore} → ${fld(after, "MASTERID")}`);
    ok("Tally stored it as a Sales voucher",
      /^SALES$/i.test(fld(after, "VOUCHERTYPENAME")), fld(after, "VOUCHERTYPENAME"));
    ok("it is now an invoice — ISINVOICE=Yes",
      /^yes$/i.test(fld(after, "ISINVOICE")), fld(after, "ISINVOICE"));
    ok("still billed to the same party",
      fld(after, "PARTYLEDGERNAME") === fld(before, "PARTYLEDGERNAME"),
      `"${fld(after, "PARTYLEDGERNAME")}"`);

    H("WHAT WAS ORDERED IS WHAT WAS BILLED");
    const ledgersAfter = ledgersOf(after);
    const diffs: string[] = [];
    for (const [name, amt] of ledgersBefore) {
      const other = ledgersAfter.get(name);
      if (other === undefined || Math.abs(other - amt) > 0.02) diffs.push(`${name}: ${amt} vs ${other ?? "absent"}`);
    }
    ok("every ledger carries the same amount it did as an order", diffs.length === 0,
      diffs.join(" | ") || [...ledgersAfter].map(([n, v]) => `${n} ${v}`).join(" | "));

    const itemsAfter = itemsOf(after);
    const qtyDiffs: string[] = [];
    for (const [name, qty] of itemsBefore) {
      const other = itemsAfter.get(name);
      if (other === undefined || Math.abs(other - qty) > 0.001) qtyDiffs.push(`${name}: ${qty} vs ${other ?? "absent"}`);
    }
    ok("the same goods, in the same quantity", qtyDiffs.length === 0,
      qtyDiffs.join(" | ") || [...itemsAfter].map(([n, q]) => `${n} ${q}`).join(", "));

    /* The invoice must be filable. An order carries no GST identity because it
       is not a supply yet; the invoice it becomes is one, and a Sales voucher
       without a place of supply lands in GSTR-1's exception bucket. */
    ok("the invoice has a place of supply, so it can be filed",
      Boolean(fld(after, "PLACEOFSUPPLY")), `"${fld(after, "PLACEOFSUPPLY")}"`);

    /* BACKWARDS IS NOT TESTED HERE, and deliberately not faked.
       billed → pending is refused by the web engine before a payload can exist
       (canTransition, and convertToBilled throws on an already-billed voucher),
       and that is covered by src/engine/__tests__/orderLifecycle.test.ts.
       Asserting it from this side would mean re-checking the payload this
       script already checked — a green tick that cannot fail, which is worse
       than no tick. Proving it against Tally would mean un-invoicing a sale in
       a live company to watch what happens, which is not worth knowing. */
  } finally {
    H("CLEANING UP");
    if (!pushedAnything) {
      console.log("    nothing was pushed.");
    } else if (KEEP) {
      console.log(`    --keep: ${mine(await vouchersOnDay(company)).length} left in place.`);
    } else {
      /* Delete by the identity, and try BOTH types: the voucher is a Sales if
         the conversion worked and a Sales Order Note if it did not, and this
         has to clean up after a failure as well as a pass. */
      let gone = false;
      for (const t of ["Sales", "Sales Order Note"]) {
        if (await remove(company, remoteId, t)) { gone = true; break; }
      }
      // Verified by RE-READING the books, with a broader predicate than the one
      // used to delete. Checking with the same predicate can only ever agree
      // with itself.
      const left = mine(await vouchersOnDay(company));
      ok("every voucher this run created has been removed", left.length === 0,
        `delete reported ${gone ? "success" : "nothing"}, ${left.length} left in the books`);
    }
    console.log(`\nTally ${(await healthy()) ? "still healthy" : "\x1b[31mNOT ANSWERING\x1b[0m"}.`);
  }

  console.log(`\n\x1b[1m${passed} passed · ${failed} failed\x1b[0m`);
  if (failed) console.log(`\nfailed:\n${failures.map((f) => `  · ${f}`).join("\n")}`);
  console.log();
  process.exit(failed ? 1 : 0);
})();
