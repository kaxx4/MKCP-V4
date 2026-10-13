/**
 * Debug-endpoint guard (task #99) — PURE, no Tally, no Supabase.
 *
 *   npx tsx scripts/test-debug-guard.ts      (from server/)
 *
 * The guard must refuse every Import envelope however it is dressed, and
 * allow Export reads. `legacyIsImport` is the regex that shipped before this
 * fix; the bypass cases are shown to slip past it.
 */
import assert from "node:assert/strict";
import { checkDebugXml } from "../src/services/debugGuard.ts";

const legacyIsImport = (xml: string) => /<TALLYREQUEST>\s*Import\s*Data\s*<\/TALLYREQUEST>/i.test(xml);
const env = (req: string, body = "") =>
  `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>${req}</TALLYREQUEST></HEADER><BODY>${body}</BODY></ENVELOPE>`;
const IMPORT_BODY = `<IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC><REQUESTDATA><TALLYMESSAGE><VOUCHER REMOTEID="x"/></TALLYMESSAGE></REQUESTDATA></IMPORTDATA>`;

const bypasses: Array<[string, string]> = [
  ["entity-encoded tags", `&lt;ENVELOPE&gt;&lt;HEADER&gt;&lt;TALLYREQUEST&gt;Import Data&lt;/TALLYREQUEST&gt;&lt;/HEADER&gt;&lt;/ENVELOPE&gt;`],
  ["CDATA-wrapped value", env("<![CDATA[Import Data]]>")],
  ["entity-encoded space", env("Import&#32;Data")],
  ["numeric entity letters", env("&#73;mport Data")],
  ["double-encoded tags", `&amp;lt;TALLYREQUEST&amp;gt;Import Data&amp;lt;/TALLYREQUEST&amp;gt;`],
  ["comment inside value", env("Import<!-- x --> Data")],
  ["unknown non-Export type", env("Execute")],
  ["IMPORTDATA inside Export", env("Export", IMPORT_BODY)],
  ["Export header, Import body in CDATA", env("Export", `<![CDATA[${IMPORT_BODY}]]>`)],
  ["lower-case IMPORTDATA", env("Export", "<importdata></importdata>")],
  ["tag with attributes", `<ENVELOPE><HEADER><TALLYREQUEST type="x">Import Data</TALLYREQUEST></HEADER></ENVELOPE>`],
];

const plainImport = env("Import Data", IMPORT_BODY);
const regressions: Array<[string, string]> = [
  ["second TALLYREQUEST is Import", `<ENVELOPE><HEADER><TALLYREQUEST>Export</TALLYREQUEST></HEADER><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER></ENVELOPE>`],
  ["plain Import Data", plainImport],
  ["whitespace-varied Import", `<ENVELOPE><HEADER><TALLYREQUEST>\n  Import\n  Data  \n</TALLYREQUEST></HEADER></ENVELOPE>`],
  ["case-varied Import", `<envelope><header><tallyrequest>import data</tallyrequest></header></envelope>`],
];

const allowed: Array<[string, string]> = [
  ["Export Collection read", env("Export", `<TDL><TDLMESSAGE><COLLECTION NAME="MkBills"/></TDLMESSAGE></TDL>`)],
  ["Export with CDATA", env("<![CDATA[Export]]>")],
  ["Export with ampersand text", env("Export", "<SVCOMPANY>A &amp; B Cycles</SVCOMPANY>")],
  ["Export Data report", `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>Trial Balance</ID></HEADER></ENVELOPE>`],
];

let failures = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e: any) { failures++; console.log(`FAIL ${name}\n     ${e.message.split("\n")[0]}`); }
};

for (const [name, xml] of bypasses) {
  check(`refuses bypass: ${name}`, () => {
    assert.equal(checkDebugXml(xml).allowed, false);
  });
  check(`  (legacy regex missed: ${name})`, () => {
    assert.equal(legacyIsImport(xml), false, "legacy regex already caught it");
  });
}
for (const [name, xml] of regressions) {
  check(`refuses: ${name}`, () => assert.equal(checkDebugXml(xml).allowed, false));
}
for (const [name, xml] of allowed) {
  check(`allows Export read: ${name}`, () => assert.equal(checkDebugXml(xml).allowed, true));
}

if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log("\nall debug-guard tests passed");
