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
