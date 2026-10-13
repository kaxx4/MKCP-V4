/**
 * Guard checks for the sync agent's scripts (#123, #102, #103, #128).
 *
 * Nothing here contacts Tally. The gate and the refusals run against a dead
 * local port and a spy function, so a refusal is proven without any request
 * reaching a real Tally.
 *
 *   npx tsx scripts/test-agent-guards.ts
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { companyRefusal } from "../src/services/tallyRole.js";
import { installMock, uninstallMock } from "../src/services/tallyMock.js";
import { withTally, resetGate, gateState, TallyUnavailableError } from "../src/services/tallyGate.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, name), "utf-8");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`); pass++; }
  else { console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); fail++; }
};

async function main(): Promise<void> {
  console.log("\n  #123  exploration scripts send only through the gate");
  for (const name of ["explore-adopt-voucher.ts", "explore-incremental.ts"]) {
    const src = read(name);
    const raw = src.split("\n").filter((l) => /\btallyPost\(/.test(l) && !/guardedPost|withTally/.test(l));
    check(`${name} has no raw tallyPost call`, raw.length === 0, raw.length ? raw[0].trim() : "");
    check(`${name} routes through withTally`, /withTally\(url, "explore"/.test(src));
  }

  console.log("\n  #102  the drain watcher treats only CLAUDE-TEST numbers as tests");
  const drain = read("watch-agent-drain.ts");
  const prefixes = /TEST_PREFIXES\s*=\s*\[([^\]]*)\]/.exec(drain)?.[1] ?? "";
  check("test prefixes include CLAUDE-TEST", /"CLAUDE-TEST"/.test(prefixes));
  check("test prefixes do not include MKCP-", !/"MKCP-"/.test(prefixes));

  console.log("\n  #103  the sweep refuses a real MKCP- prefix");
  const sweep = read("sweep-test-vouchers.ts");
  check("sweep refuses any MKCP prefix before listing", /PREFIX[\s\S]{0,200}MKCP/i.test(sweep) && /process\.exit\(2\)/.test(sweep));

  console.log("\n  #128  only the practice company, identified by GUID, receives XML");
  process.env.MKCP_TALLY_ROLE = "sandbox";
  process.env.MKCP_PRACTICE_COMPANY = "PRACTICE CO";
  process.env.MKCP_PRACTICE_COMPANY_GUID = "GUID-PRACTICE";
  let wire = 0;
  let listedGuid = "GUID-PRACTICE";
  let listed = true;
  installMock(async (_u, x) => {
    if (/List of Companies/.test(x)) {
      const co = listed ? `<COMPANY NAME="PRACTICE CO"><GUID>${listedGuid}</GUID></COMPANY>` : "";
      return `<ENVELOPE><BODY><DATA><COLLECTION>${co}</COLLECTION></DATA></BODY></ENVELOPE>`;
    }
    wire++;
    return "<ENVELOPE><DATA></DATA></ENVELOPE>";
  });
  const body = (company: string) =>
    `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkT</ID></HEADER>` +
    `<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
  const tryPost = async (xml: string): Promise<string> => {
    try { await tallyPost("http://localhost:9099", xml, 5_000, true); return "sent"; }
    catch (e) { return (e as Error).message; }
  };
  const realMsg = await tryPost(body("M.K.CYCLES (P) LTD. - (from 1-Apr-26)"));
  check("non-practice name refused", /refused/i.test(realMsg), realMsg.slice(0, 80));
  check("refused name sends no XML", wire === 0, `transport calls=${wire}`);
  const okMsg = await tryPost(body("PRACTICE CO"));
  check("practice name with matching GUID passes", wire === 1 && okMsg === "sent", okMsg.slice(0, 80));
  listedGuid = "GUID-DUPLICATE";
  const dupMsg = await tryPost(body("PRACTICE CO"));
  check("same name, other GUID refused", /GUID other/i.test(dupMsg) && wire === 1, dupMsg.slice(0, 80));
  listedGuid = "GUID-PRACTICE";
  listed = false;
  const absentMsg = await tryPost(body("PRACTICE CO"));
  check("company not loaded refused", /not loaded/i.test(absentMsg) && wire === 1, absentMsg.slice(0, 80));
  listed = true;
  delete process.env.MKCP_PRACTICE_COMPANY_GUID;
  const noGuidMsg = await tryPost(body("PRACTICE CO"));
  check("unset practice GUID refused", /GUID is not set/i.test(noGuidMsg) && wire === 1, noGuidMsg.slice(0, 80));
  process.env.MKCP_PRACTICE_COMPANY_GUID = "GUID-PRACTICE";
  const listMsg = await tryPost(HEALTH_XML);
  check("company listing (no company named) still allowed", !/refused/i.test(listMsg));
  uninstallMock();
  delete process.env.MKCP_TALLY_ROLE;
  delete process.env.MKCP_PRACTICE_COMPANY;
  delete process.env.MKCP_PRACTICE_COMPANY_GUID;

  console.log("\n  #128 review  entities decode fully and company names compare case-insensitively");
  process.env.MKCP_TALLY_ROLE = "sandbox";
  process.env.MKCP_PRACTICE_COMPANY = "PRACTICE'CO \"X\"";
  process.env.MKCP_PRACTICE_COMPANY_GUID = "GUID-PRACTICE";
  const named = (c: string) =>
    `<ENVELOPE><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
  for (const [label, c] of [
    ["&apos;", "PRACTICE&apos;CO &quot;X&quot;"],
    ["&#39; and &#34;", "PRACTICE&#39;CO &#34;X&#34;"],
    ["&#x27; and &#x22;", "PRACTICE&#x27;CO &#x22;X&#x22;"],
  ] as const) {
    check(`decodes ${label} to the practice name`, companyRefusal(named(c)) === null, companyRefusal(named(c)) ?? "");
  }
  check("case-insensitive name match", companyRefusal(named("practice'co \"x\"")) === null);
  check("case-insensitive still refuses other names", companyRefusal(named("PRACTICE'CO X")) !== null);
  process.env.MKCP_PRACTICE_COMPANY = "PRACTICE CO";
  delete process.env.MKCP_TALLY_ROLE;
  process.env.MKCP_TALLY_ROLE = "sandbox";
  process.env.MKCP_PRACTICE_COMPANY_GUID = "GUID-PRACTICE";
  let wire2 = 0;
  let listed2 = "PRACTICE CO";
  installMock(async (_u, x) => {
    if (/List of Companies/.test(x)) return `<ENVELOPE><BODY><DATA><COLLECTION><COMPANY NAME="${listed2}"><GUID>GUID-PRACTICE</GUID></COMPANY></COLLECTION></DATA></BODY></ENVELOPE>`;
    wire2++; return "<ENVELOPE><DATA></DATA></ENVELOPE>";
  });
  let caseMsg = "sent";
  try { await tallyPost("http://localhost:9099", named("practice co"), 5_000, true); }
  catch (e) { caseMsg = (e as Error).message; }
  check("GUID lookup is case-insensitive", caseMsg === "sent" && wire2 === 1, caseMsg.slice(0, 80));
  uninstallMock();
  delete process.env.MKCP_TALLY_ROLE;
  delete process.env.MKCP_PRACTICE_COMPANY;
  delete process.env.MKCP_PRACTICE_COMPANY_GUID;

  console.log("\n  #123  an open gate refuses without calling the request");
  resetGate();
  const dead = "http://localhost:9099";           // nothing listens here
  for (let i = 0; i < 2; i++) {
    await withTally(dead, "probe", () => Promise.reject(new Error("refused"))).catch(() => undefined);
  }
  check("gate opens after two transport failures", gateState().state === "open");
  let called = false;
  let refused = false;
  try {
    await withTally(dead, "guarded", async () => { called = true; return "x"; });
  } catch (e) {
    refused = e instanceof TallyUnavailableError;
  }
  check("open gate refuses with TallyUnavailableError", refused);
  check("refused request body never runs", !called);
  resetGate();

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main();
