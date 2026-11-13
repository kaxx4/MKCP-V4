/**
 * D-M.248 item 1, offline: the company pin of the single-primary mode (services/primaryMode.ts). OFF unless MKCP_PRIMARY_MODE=on.
 *   - pure: the settings, fail closed with the GUID unset, a sandbox may not run the mode, the pin judges the company listing;
 *   - at the transport (tallyPost): with the mode on, every WRITE is held to the pinned GUID from a fresh listing, reads are not, and with the
 *     mode off nothing changes; a refused write sends no XML;
 *   - in the job agent: nothing is claimed while the pin fails, a job is put back (not failed) when the pin fails right before `sent`, and a
 *     real job is refused unless the mode is on.
 * No Tally and no database: the transport is the mock, the queue is in memory.
 *
 *   npx tsx scripts/test-primary-pin.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { primaryModeOn, primaryGuid, primaryModeRefusal, primaryPinProblem, isImportRequest, stableCompanyKey, primaryCompanyKey } from "../src/services/primaryMode.js";
import { tallyPost, resetListingCache } from "../src/tally.js";
import { installMock, uninstallMock } from "../src/services/tallyMock.js";
import { ErpJobAgent, Journal, tallySeams } from "../src/services/erpJobAgent.js";
import type { SafePushResult } from "../src/services/safePush.js";
import type { VoucherPayload } from "../src/types.js";
import { memErpQueue } from "./rigs/lib/memErpQueue.js";
import { rigPayload, indiaToday } from "./rigs/lib/simTally.js";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
};
const GUID = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-8888-4777-8666-444444444444";
const NAME = "ZZ OFFICE CO - (from 1-Apr-26)";
const listing = (cos: Array<[string, string]>) => `<ENVELOPE><BODY><DATA><COLLECTION>${cos.map(([n, g]) => `<COMPANY NAME="${n}"><NAME>${n}</NAME><GUID>${g}</GUID></COMPANY>`).join("")}</COLLECTION></DATA></BODY></ENVELOPE>`;
const env = (extra: Record<string, string> = {}): Record<string, string | undefined> => ({ MKCP_PRIMARY_MODE: "on", MKCP_PRIMARY_COMPANY_GUID: GUID, ...extra });
const importXml = (company: string) => `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY></STATICVARIABLES></DESC><DATA/></BODY></ENVELOPE>`;
const exportXml = (company: string) => `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkRead</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
const REPLY = "<ENVELOPE><BODY><DATA><IMPORTRESULT><CREATED>1</CREATED><ERRORS>0</ERRORS></IMPORTRESULT></DATA></BODY></ENVELOPE>";

function setEnv(e: Record<string, string | undefined>): () => void {
  const keys = ["MKCP_PRIMARY_MODE", "MKCP_PRIMARY_COMPANY_GUID", "MKCP_TALLY_ROLE", "MKCP_PRACTICE_COMPANY", "MKCP_PRACTICE_COMPANY_GUID", "MKCP_PRIMARY_COMPANY", "MKCP_PRIMARY_COMPANY_KEY"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(e)) if (v !== undefined) process.env[k] = v;
  return () => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
}

(async () => {
  console.log("\n  the settings and the pin (pure)");
  ok("the mode is off by default", !primaryModeOn({}) && !primaryModeOn({ MKCP_PRIMARY_MODE: "off" }));
  ok("the mode is on only for the word on (any case, spaces ignored)", primaryModeOn({ MKCP_PRIMARY_MODE: " ON " }));
  ok("the GUID is read trimmed", primaryGuid({ MKCP_PRIMARY_COMPANY_GUID: `  ${GUID} ` }) === GUID);
  ok("with the GUID unset the mode refuses everything (fail closed)", /MKCP_PRIMARY_COMPANY_GUID is not set/.test(primaryModeRefusal({ MKCP_PRIMARY_MODE: "on" }) ?? ""));
  ok("with the GUID blank it is still unset", primaryModeRefusal({ MKCP_PRIMARY_COMPANY_GUID: "   " }) !== null);
  ok("a sandbox machine may not run the mode, whatever else is set", /sandbox/.test(primaryModeRefusal(env({ MKCP_TALLY_ROLE: "sandbox" })) ?? ""));
  ok("a primary with the GUID set has no refusal", primaryModeRefusal(env()) === null);
  ok("the pin passes when the company is open under the pinned GUID", primaryPinProblem(NAME, listing([[NAME, GUID]]), env()) === null);
  ok("the GUID compare ignores case", primaryPinProblem(NAME, listing([[NAME, GUID.toUpperCase()]]), env()) === null);
  ok("the company name compare ignores case", primaryPinProblem(NAME.toLowerCase(), listing([[NAME, GUID]]), env()) === null);
  ok("the pin passes with other companies open beside it", primaryPinProblem(NAME, listing([["ZZ OLD YEAR", OTHER], [NAME, GUID]]), env()) === null);
  ok("a company open under another GUID is refused, in plain words", /other than MKCP_PRIMARY_COMPANY_GUID/.test(primaryPinProblem(NAME, listing([[NAME, OTHER]]), env()) ?? "") && /Nothing was sent/.test(primaryPinProblem(NAME, listing([[NAME, OTHER]]), env()) ?? ""));
  ok("a company that is not open is refused", /not open in Tally/.test(primaryPinProblem(NAME, listing([["ZZ OLD YEAR", OTHER]]), env()) ?? ""));
  ok("an empty listing is refused (not a pass)", primaryPinProblem(NAME, "", env()) !== null);
  ok("the same name open under two GUIDs is refused", /more than once/.test(primaryPinProblem(NAME, listing([[NAME, GUID], [NAME, OTHER]]), env()) ?? ""));
  ok("no company named is refused", primaryPinProblem("  ", listing([[NAME, GUID]]), env()) !== null);
  ok("the pin with the GUID unset is refused even if the company is open", primaryPinProblem(NAME, listing([[NAME, GUID]]), { MKCP_PRIMARY_MODE: "on" }) !== null);
  ok("an Import is a write; an Export, the listing and the health check are not", isImportRequest(importXml("X")) && !isImportRequest(exportXml("X")));
  ok("the stable company key drops the year part", stableCompanyKey(NAME) === "ZZ OFFICE CO" && stableCompanyKey("ZZ OFFICE CO") === "ZZ OFFICE CO");
  ok("the company key can be set outright; by default it is Tally's full name (tally_* is keyed by it)", primaryCompanyKey({ MKCP_PRIMARY_COMPANY_KEY: "K1", MKCP_PRIMARY_COMPANY: NAME }) === "K1" && primaryCompanyKey({ MKCP_PRIMARY_COMPANY: NAME }) === NAME);

  console.log("\n  at the transport: tallyPost holds every write to the pin");
  const sent: string[] = [];
  let live = listing([[NAME, GUID]]);
  let listings = 0;
  installMock(async (_u, xml) => {
    if (/<ID>\s*List of Companies\s*<\/ID>/i.test(xml)) { listings++; return live; }
    sent.push(xml.includes("<TALLYREQUEST>Import") ? "import" : "read");
    return REPLY;
  });
  try {
    let restore = setEnv(env());
    resetListingCache();
    const w1 = await tallyPost("http://x", importXml(NAME), 5000, true).then(() => "sent", (e: Error) => e.message);
    ok("mode on, right GUID: the write goes", w1 === "sent" && sent.at(-1) === "import");
    live = listing([[NAME, OTHER]]);
    const before = sent.length;
    const w2 = await tallyPost("http://x", importXml(NAME), 5000, true).then(() => "sent", (e: Error) => e.message);
    ok("mode on, the GUID changed since a moment ago: the write is refused (the listing is read fresh each time)", /other than MKCP_PRIMARY_COMPANY_GUID/.test(w2), w2.slice(0, 100));
    ok("a refused write sends no XML", sent.length === before);
    const r1 = await tallyPost("http://x", exportXml("ZZ OLD YEAR"), 5000, true).then(() => "sent", (e: Error) => e.message);
    ok("a read of another company is not held to the pin", r1 === "sent");
    const w3 = await tallyPost("http://x", importXml("ZZ OLD YEAR"), 5000, true).then(() => "sent", (e: Error) => e.message);
    ok("a write to a company that is not open is refused", /not open in Tally/.test(w3));
    const noCo = await tallyPost("http://x", importXml("").replace("<SVCURRENTCOMPANY></SVCURRENTCOMPANY>", ""), 5000, true).then(() => "sent", (e: Error) => e.message);
    ok("a write that names no company is refused", /names no company/.test(noCo), noCo.slice(0, 80));
    restore();

    restore = setEnv({ MKCP_PRIMARY_MODE: "on" });
    live = listing([[NAME, GUID]]);
    const w4 = await tallyPost("http://x", importXml(NAME), 5000, true).then(() => "sent", (e: Error) => e.message);
    ok("mode on and the GUID unset: every write is refused (fail closed)", /MKCP_PRIMARY_COMPANY_GUID is not set/.test(w4));
    restore();

    restore = setEnv(env({ MKCP_TALLY_ROLE: "sandbox", MKCP_PRACTICE_COMPANY: "ZZ PRACTICE", MKCP_PRACTICE_COMPANY_GUID: OTHER }));
    const w5 = await tallyPost("http://x", importXml("ZZ PRACTICE"), 5000, true).then(() => "sent", (e: Error) => e.message);
    ok("a sandbox machine with the mode on is refused (the practice rules still stand, and the mode does not run there)", w5 !== "sent");
    restore();

    restore = setEnv({});
    live = listing([[NAME, OTHER]]);
    const l0 = listings;
    const w6 = await tallyPost("http://x", importXml(NAME), 5000, true).then(() => "sent", (e: Error) => e.message);
    ok("mode OFF: a write goes as it always did, no pin, no listing read", w6 === "sent" && listings === l0);
    restore();
  } finally { uninstallMock(); resetListingCache(); }

  console.log("\n  in the job agent");
  const dir = mkdtempSync(join(tmpdir(), "primary-pin-"));
  let jn = 0;
  const day = indiaToday();
  const pl = (n: number): VoucherPayload & { label: string } => ({ ...rigPayload("PIN", n, day), label: "real job" });
  const okPush = async (): Promise<SafePushResult> => ({ ok: true, stage: "done", voucherId: "5001", errors: [], warnings: [], differences: [] });
  const mk = (m: ReturnType<typeof memErpQueue>, extra: Partial<ConstructorParameters<typeof ErpJobAgent>[0]> = {}) => {
    const pushed: string[] = [];
    const a = new ErpJobAgent({
      queue: m.queue, journal: new Journal(join(dir, `j${++jn}.jsonl`)), company: NAME,
      push: async (c, p) => { pushed.push(String(p.remoteId)); return okPush(); },
      find: async () => [], leaseSeconds: 90, jobLeaseSeconds: 120, wait: async () => {}, ...extra,
    });
    return { a, pushed };
  };
  {
    const restore = setEnv(env());
    const m = memErpQueue(); const id = m.add(pl(1), false);
    const { a, pushed } = mk(m, { pin: async () => "refused: company \"X\" is open under a GUID other than MKCP_PRIMARY_COMPANY_GUID. Nothing was sent to Tally." });
    const r = await a.runOnce(1);
    ok("a failing pin claims nothing", m.rows.get(id)!.state === "queued" && r.results.length === 0 && pushed.length === 0);
    ok("the round says why, and the agent keeps the reason", /other than MKCP_PRIMARY_COMPANY_GUID/.test(r.stopped ?? "") && a.status.pin?.ok === false);
    restore();
  }
  {
    const restore = setEnv(env());
    const m = memErpQueue(); const id = m.add(pl(2), false);
    const { a, pushed } = mk(m, { pin: async () => null });
    const r = await a.runOnce(1);
    ok("a passing pin lets a real job through (the mode is on)", m.rows.get(id)!.state === "succeeded" && pushed.length === 1 && r.results[0].outcome === "succeeded");
    ok("the agent records that the pin held", a.status.pin?.ok === true);
    restore();
  }
  {
    const restore = setEnv(env());
    const m = memErpQueue(); const id = m.add(pl(3), false);
    let calls = 0;
    const { a, pushed } = mk(m, { pin: async () => (++calls === 1 ? null : "refused: company \"X\" is not open in Tally, so its GUID cannot be checked. Nothing was sent to Tally.") });
    const r = await a.runOnce(1);
    ok("the pin passes before the claim and fails right before `sent`: the job goes back to the queue", m.rows.get(id)!.state === "queued" && r.results[0]?.outcome === "not-sent" && pushed.length === 0, `${m.rows.get(id)!.state}`);
    ok("that is not a failure: the job is not marked failed and nothing was sent", m.rows.get(id)!.error === null || m.rows.get(id)!.error === undefined);
    restore();
  }
  {
    const restore = setEnv(env());
    const m = memErpQueue(); const id = m.add(pl(4), false);
    const { a } = mk(m, { pin: async () => { throw new Error("socket hang up"); } });
    const r = await a.runOnce(1);
    ok("a pin check that cannot run is a refusal, never a pass", m.rows.get(id)!.state === "queued" && /could not be checked/.test(r.stopped ?? ""));
    restore();
  }
  {
    const restore = setEnv({});
    const m = memErpQueue(); const id = m.add(pl(5), false);
    const { a, pushed } = mk(m);
    await a.runOnce(1);
    ok("mode OFF: a real job is refused exactly as before (only the office agent after go-live)", m.rows.get(id)!.state === "failed" && /only by the office agent after go-live/.test(String(m.rows.get(id)!.error)) && pushed.length === 0);
    restore();
  }
  {
    const seams = tallySeams("http://x", async () => listing([[NAME, GUID]]));
    const restore = setEnv(env());
    ok("tallySeams supplies the pin: open under the right GUID passes", (await seams.pin(NAME)) === null);
    const seams2 = tallySeams("http://x", async () => listing([[NAME, OTHER]]));
    ok("tallySeams supplies the pin: another GUID is refused", /other than MKCP_PRIMARY_COMPANY_GUID/.test((await seams2.pin(NAME)) ?? ""));
    restore();
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
