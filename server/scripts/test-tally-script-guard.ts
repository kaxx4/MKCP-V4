/**
 * Every script that talks to Tally's port goes through checkedRequest() and
 * tallyPost(). An unchecked or unknown-type request is refused before it leaves.
 *
 * PURE — no Tally, no Supabase, no network. Nothing here sends a request.
 *
 *   npx tsx server/scripts/test-tally-script-guard.ts
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkedRequest, buildCollection, dateBetween } from "../src/services/tallyRequest.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");

let pass = 0;
let fail = 0;

function ok(what: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ok    ${what}`); }
  else { fail++; console.log(`  FAIL  ${what}${detail ? "  — " + detail : ""}`); }
}

function refused(what: string, xml: string, match: RegExp): void {
  try {
    checkedRequest(xml);
    fail++; console.log(`  FAIL  ${what} — was sent through the guard without a refusal`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ok(what, match.test(msg), `unexpected message: ${msg.slice(0, 120)}`);
  }
}

const exportCollection = (type: string) =>
  `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>` +
  `<TYPE>Collection</TYPE><ID>Probe</ID></HEADER><BODY><DESC><STATICVARIABLES>` +
  `<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE>` +
  `<COLLECTION NAME="Probe" ISMODIFY="No"><TYPE>${type}</TYPE><NATIVEMETHOD>NAME</NATIVEMETHOD>` +
  `</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;

console.log("\n  TALLY SCRIPT GUARD — refusals and the call sites\n");

// 1. A verified type passes through unchanged.
const good = exportCollection("Company");
ok("a verified Collection type is passed through unchanged", checkedRequest(good) === good);

// 2. The request builder's own output passes the guard.
const built = buildCollection({ id: "Gd", type: "Voucher", fetch: ["DATE"], filter: dateBetween("20260401", "20260430") });
ok("builder output passes the guard", checkedRequest(built) === built);

// 3. An unknown type is refused (it would raise a modal and kill the port).
refused("an unknown object type is refused", exportCollection("Widget"), /not in the verified list/);

// 4. A Collection with no COLLECTION TYPE cannot be checked, so it is refused.
refused(
  "a Collection with no COLLECTION TYPE is refused",
  `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>X</ID></HEADER><BODY/></ENVELOPE>`,
  /cannot be checked/,
);

// 5. Not an envelope at all — a bare string is refused.
refused("a bare string that is not an ENVELOPE is refused", "<HELLO/>", /not an ENVELOPE/);

// 6. No TALLYREQUEST — a header without one is refused.
refused(
  "a request with no TALLYREQUEST is refused",
  `<ENVELOPE><HEADER><VERSION>1</VERSION><ID>X</ID></HEADER><BODY/></ENVELOPE>`,
  /no TALLYREQUEST/,
);

// 7. An Export with no ID is refused (a malformed header raises a modal).
refused(
  "an Export with no <ID> is refused",
  `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE></HEADER><BODY/></ENVELOPE>`,
  /no <ID>/,
);

// 8. The call sites: each script sends through checkedRequest and nothing else.
const sites = [
  "server/scripts/verify-request-builder.ts",
  "scripts/verify-tally-roundtrip.ts",
  "scripts/go-live-check.ts",
];
for (const rel of sites) {
  const src = readFileSync(join(repo, rel), "utf8");
  ok(`${rel} sends through checkedRequest()`, /checkedRequest\(/.test(src));
  ok(`${rel} sends through tallyPost()`, /tallyPost\(/.test(src));
  ok(`${rel} has no raw fetch() to Tally`, !/fetch\(\s*(TALLY|url|U)\b/.test(src));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
