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

  console.log("\n  #128  a non-practice company is refused before any XML is sent");
  process.env.MKCP_TALLY_ROLE = "sandbox";
  process.env.MKCP_PRACTICE_COMPANY = "PRACTICE CO";
  let wire = 0;
  installMock(async () => { wire++; return "<ENVELOPE><DATA></DATA></ENVELOPE>"; });
  const body = (company: string) =>
    `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkT</ID></HEADER>` +
    `<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
  const tryPost = async (xml: string): Promise<string> => {
    try { await tallyPost("http://localhost:9099", xml, 5_000, true); return "sent"; }
    catch (e) { return (e as Error).message; }
  };
  const realMsg = await tryPost(body("M.K.CYCLES (P) LTD. - (from 1-Apr-26)"));
  check("non-practice company refused", /refused/i.test(realMsg), realMsg.slice(0, 80));
  check("refused company sends no XML", wire === 0, `transport calls=${wire}`);
  const practiceMsg = await tryPost(body("PRACTICE CO"));
  check("practice company passes the check", wire === 1 && !/refused/i.test(practiceMsg));
  const listMsg = await tryPost(HEALTH_XML);
  check("company listing (no company named) still allowed", wire === 2 && !/refused/i.test(listMsg));
  uninstallMock();
  delete process.env.MKCP_TALLY_ROLE;
  delete process.env.MKCP_PRACTICE_COMPANY;

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
