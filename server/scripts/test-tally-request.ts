/**
 * The request builder refuses to write the traps.
 *
 * PURE — no Tally, no Supabase. Every case here is a failure that has actually
 * happened against this company, and the point is that the builder makes each
 * one unwritable rather than merely documented.
 *
 *   npx tsx server/scripts/test-tally-request.ts
 */
import {
  buildCollection, buildReport, assertKnownType, esc,
  dateBetween, onDate, alterIdAbove, blocksOf, readCollection, tagOf,
  DATE_AS_INT,
} from "../src/services/tallyRequest.js";

let pass = 0;
let fail = 0;

function ok(what: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ok    ${what}`); }
  else { fail++; console.log(`  FAIL  ${what}${detail ? "  — " + detail : ""}`); }
}

function throws(what: string, fn: () => unknown, match: RegExp): void {
  try {
    fn();
    fail++; console.log(`  FAIL  ${what} — did not throw`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (match.test(msg)) { pass++; console.log(`  ok    ${what}`); }
    else { fail++; console.log(`  FAIL  ${what} — wrong message: ${msg}`); }
  }
}

console.log("\n  THE TRAPS, MADE UNWRITABLE\n  " + "─".repeat(62));

// ── The one that returns zero rows with no error ──────────────────────────
console.log("\n  An unescaped comparison in a filter");
{
  const xml = buildCollection({
    id: "T1", type: "Voucher", fetch: ["DATE"], filter: dateBetween("20260401", "20270331"),
  });
  ok("renders >= as &gt;= , never raw", xml.includes("&gt;=") && !/\$Date\) >=/.test(xml));
  ok("renders <= as &lt;=", xml.includes("&lt;="));
  ok("no raw > survives inside the SYSTEM formula",
    !/<SYSTEM[^>]*>[^<]*[<>][^<]*<\/SYSTEM>/.test(xml.replace(/&[a-z]+;/g, "")));
  throws("refuses an expression containing a raw >",
    () => buildCollection({ id: "T2", type: "Voucher", fetch: ["DATE"],
      filter: { kind: "compare", expr: "$Qty > 0", cmp: "gt", value: 1 } }),
    /raw < or >|zero rows with no error/i);
}

// ── The one that crashes TallyPrime ───────────────────────────────────────
console.log("\n  Wildcards in a fetch list");
throws("refuses NATIVEMETHOD *",
  () => buildCollection({ id: "T3", type: "Voucher", fetch: ["*"] }),
  /wildcard|crashes TallyPrime/i);
throws("refuses a nested wildcard",
  () => buildCollection({ id: "T4", type: "Voucher", fetch: ["ALLLEDGERENTRIES.*"] }),
  /wildcard/i);

// ── The one that needs a human to restart Tally ───────────────────────────
console.log("\n  Unrecognised object types");
throws("refuses a type not known to work",
  () => assertKnownType("Widget"),
  /modal dialog|blocks the XML port/i);
ok("permits the verified types", (() => {
  for (const t of ["Voucher", "Ledger", "StockItem", "Bills", "Company"]) assertKnownType(t);
  return true;
})());

// ── Name / id agreement ───────────────────────────────────────────────────
console.log("\n  Collection name and request id");
{
  const xml = buildCollection({ id: "MkThing", type: "Ledger", fetch: ["NAME"] });
  ok("ID and COLLECTION NAME are the same string",
    xml.includes("<ID>MkThing</ID>") && xml.includes('COLLECTION NAME="MkThing"'));
  ok("strips characters that would break the name",
    buildCollection({ id: "Mk-Thing 2!", type: "Ledger", fetch: ["NAME"] }).includes('NAME="MkThing2"'));
}

// ── Escaping ──────────────────────────────────────────────────────────────
console.log("\n  Company names with XML-significant characters");
{
  const xml = buildCollection({ id: "T5", type: "Ledger", fetch: ["NAME"], company: 'A & B "Co" <x>' });
  ok("escapes & < > and quotes in the company name",
    xml.includes("A &amp; B &quot;Co&quot; &lt;x&gt;"));
  ok("esc() handles all five", esc('&<>"') === "&amp;&lt;&gt;&quot;");
}

// ── The filters we actually use ───────────────────────────────────────────
console.log("\n  The filters in production use");
{
  ok("date-as-integer is the comparable form", DATE_AS_INT.includes("$$YearOfDate:$Date * 10000"));
  const single = buildCollection({ id: "T6", type: "Voucher", fetch: ["DATE"], filter: onDate("20260913") });
  ok("a single day renders as =", single.includes("= 20260913"));
  const inc = buildCollection({ id: "T7", type: "Voucher", fetch: ["ALTERID"], filter: alterIdAbove(355528) });
  ok("the AlterID watermark renders escaped", inc.includes("$AlterID &gt; 355528"));
  ok("a negative watermark floors at zero",
    buildCollection({ id: "T8", type: "Voucher", fetch: ["ALTERID"], filter: alterIdAbove(-5) }).includes("&gt; 0"));
}

// ── Reading back ──────────────────────────────────────────────────────────
console.log("\n  Splitting a response");
{
  /* The CMPINFO preamble carries a literal <VOUCHER>0</VOUCHER> count tag. */
  const withPreamble =
    "<ENVELOPE><DESC><CMPINFO><LEDGER>27</LEDGER><VOUCHER>0</VOUCHER></CMPINFO></DESC>" +
    "<DATA><COLLECTION>" +
    '<VOUCHER REMOTEID="a"><DATE>20260913</DATE></VOUCHER>' +
    '<VOUCHER REMOTEID="b"><DATE>20260912</DATE></VOUCHER>' +
    "</COLLECTION></DATA></ENVELOPE>";
  ok("drops the CMPINFO count tag", blocksOf(withPreamble, "VOUCHER").length === 2);

  /* A tag with NO attributes — this is how Trial Balance read as zero rows. */
  const noAttrs = "<DATA><DSPACCNAME><DSPDISPNAME>Investments</DSPDISPNAME></DSPACCNAME>" +
                  "<DSPACCNAME><DSPDISPNAME>Sales Accounts</DSPDISPNAME></DSPACCNAME></DATA>";
  ok("still finds tags that carry no attributes", blocksOf(noAttrs, "DSPACCNAME").length === 2);
}

// ── G7: empty response vs empty parse ─────────────────────────────────────
console.log("\n  G7 — 'Tally returned nothing' vs 'my parser found nothing'");
{
  const empty = "<ENVELOPE><DESC><CMPINFO><VOUCHER>0</VOUCHER></CMPINFO></DESC><DATA><COLLECTION></COLLECTION></DATA></ENVELOPE>";
  const e = readCollection(empty, "VOUCHER", (b) => tagOf(b, "DATE") ?? null);
  ok("an empty collection is reported as empty FROM TALLY", e.emptyFromTally && !e.unparsed);
  ok("and says so in words", /answer was empty/i.test(e.note));

  const present =
    "<ENVELOPE><DESC><CMPINFO><VOUCHER>0</VOUCHER></CMPINFO></DESC><DATA><COLLECTION>" +
    '<VOUCHER REMOTEID="a"><SOMETHINGELSE>x</SOMETHINGELSE></VOUCHER>' +
    "</COLLECTION></DATA></ENVELOPE>";
  const p = readCollection(present, "VOUCHER", (b) => tagOf(b, "DATE") ?? null);
  ok("a payload the parser cannot read is reported as a PARSER failure", p.unparsed && !p.emptyFromTally);
  ok("and names it as such", /PARSER failure/i.test(p.note));

  const good =
    "<DATA><COLLECTION><VOUCHER REMOTEID=\"a\"><DATE>20260913</DATE></VOUCHER></COLLECTION></DATA>";
  const g = readCollection(good, "VOUCHER", (b) => tagOf(b, "DATE") ?? null);
  ok("a normal read is neither", g.rows.length === 1 && !g.unparsed && !g.emptyFromTally);
}

// ── Reports ───────────────────────────────────────────────────────────────
console.log("\n  Report requests");
{
  const r = buildReport("Trial Balance", "M.K.CYCLES (P) LTD.", "20260401", "20270331");
  ok("names the report and carries the period",
    r.includes("<ID>Trial Balance</ID>") && r.includes("<SVFROMDATE>20260401</SVFROMDATE>"));
  ok("omits the period when not given", !buildReport("Trial Balance").includes("SVFROMDATE"));
}

console.log("\n  " + "─".repeat(62));
console.log(`  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
