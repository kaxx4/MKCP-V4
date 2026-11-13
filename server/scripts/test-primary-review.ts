/**
 * D-M.256, offline: the fixes from the independent review of the single-primary mode (e9d7b66..277c167).
 *   1  a pin MISMATCH ends the job failed with a plain reason; only an unreadable answer puts it back, with a growing pause, so it cannot starve the queue
 *   2  tallySeams carries no pin (the dummy rigs spread it); a mode-OFF agent built that way still claims and posts
 *   4  a pin refusal inside tallyPost is a typed PinRefused: the job ends failed (never uncertain), no "Tally may be showing a message", no breaker count
 *   5  one Tally at a time: a write waits for the request in flight, then goes before any waiting read (slow mock read)
 *   6  no job is settled from a read while the pin cannot be confirmed
 *  12  more than one SVCURRENTCOMPANY, whitespace in the tag, exact name first, names differing only by case
 * Items 3, 7, 8, 9, 10 and 11 are in test-primary-runner.ts, test-primary-tools.ts and test-primary-scripts.ts.
 * No Tally and no database: the transport is the mock, the queue is in memory.
 *
 *   npx tsx scripts/test-primary-review.ts
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { primaryPinFailure, primaryPinProblem, isImportRequest, PinRefused } from "../src/services/primaryMode.js";
import { tallyPost, resetListingCache } from "../src/tally.js";
import { installMock, uninstallMock } from "../src/services/tallyMock.js";
import { ErpJobAgent, Journal, tallySeams, tallyPinSeam } from "../src/services/erpJobAgent.js";
import { TallyLane } from "../src/services/tallyLane.js";
import { withTally, gateState, resetGate } from "../src/services/tallyGate.js";
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
const importXml = (company: string) => `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY></STATICVARIABLES></DESC><DATA/></BODY></ENVELOPE>`;
const readXml = (id: string, company = NAME) => `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${id}</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
const REPLY = "<ENVELOPE><BODY><DATA><IMPORTRESULT><CREATED>1</CREATED><ERRORS>0</ERRORS></IMPORTRESULT></DATA></BODY></ENVELOPE>";
const EMPTY = "<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>";
const env = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({ MKCP_PRIMARY_MODE: "on", MKCP_PRIMARY_COMPANY_GUID: GUID, ...extra });
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const KEYS = ["MKCP_PRIMARY_MODE", "MKCP_PRIMARY_COMPANY_GUID", "MKCP_TALLY_ROLE", "MKCP_PRACTICE_COMPANY", "MKCP_PRACTICE_COMPANY_GUID", "MKCP_PRIMARY_COMPANY", "MKCP_PRIMARY_COMPANY_KEY"];
function setEnv(e: Record<string, string | undefined>): () => void {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(e)) if (v !== undefined) process.env[k] = v;
  return () => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
}

(async () => {
  const dir = mkdtempSync(join(tmpdir(), "primary-review-"));
  let jn = 0;
  const day = indiaToday();
  const pl = (n: number): VoucherPayload & { label: string } => ({ ...rigPayload("REV", n, day), label: "real job" });
  const okPush = async (): Promise<SafePushResult> => ({ ok: true, stage: "done", voucherId: "5001", errors: [], warnings: [], differences: [] });
  const mk = (m: ReturnType<typeof memErpQueue>, extra: Partial<ConstructorParameters<typeof ErpJobAgent>[0]> = {}, clock?: { t: number }) => {
    const pushed: string[] = [], found: string[] = [];
    const a = new ErpJobAgent({
      queue: m.queue, journal: new Journal(join(dir, `j${++jn}.jsonl`)), company: NAME,
      push: async (_c, p) => { pushed.push(String(p.remoteId)); return okPush(); },
      find: async (_c, p) => { found.push(String(p.remoteId)); return []; },
      leaseSeconds: 90, jobLeaseSeconds: 120, wait: async () => {}, ...(clock ? { now: () => clock.t } : {}), ...extra,
    });
    return { a, pushed, found };
  };
  const MISMATCH = { reason: `refused: not the pinned company. "${NAME}" is open under a GUID other than MKCP_PRIMARY_COMPANY_GUID. It is a copy or another year's books. Nothing was sent to Tally.`, definite: true };
  const UNREAD = { reason: "refused: Tally's company list could not be read (socket hang up), so the pinned company cannot be checked. Nothing was sent to Tally.", definite: false };

  console.log("\n  item 1: a mismatch fails the job; an unreadable answer puts it back with a pause");
  {
    const restore = setEnv(env());
    const m = memErpQueue(); const a1 = m.add(pl(1), false); const b1 = m.add(pl(2), false);
    let call = 0;
    // Pre-claim passes, then the company changes before this job's first read: a definite mismatch.
    const { a, pushed } = mk(m, { pin: async () => (++call === 2 ? MISMATCH : null) });
    const r1 = await a.runOnce(1);
    const A = m.rows.get(a1)!;
    ok("the mismatched job ENDS failed (it is not put back)", A.state === "failed" && r1.results[0]?.outcome === "failed", A.state);
    ok("the plain reason is on the job row: 'refused: not the pinned company'", /refused: not the pinned company/.test(String(A.error)) && /Nothing was sent/.test(String(A.error)), String(A.error));
    ok("nothing was sent for it", pushed.length === 0);
    const r2 = await a.runOnce(1);
    ok("a mismatched job does not block a later good job: the next round works the next job", m.rows.get(b1)!.state === "succeeded" && pushed.length === 1 && r2.results[0]?.id === b1, `${m.rows.get(b1)!.state}`);
    ok("the failed job is not claimed again", m.rows.get(a1)!.state === "failed" && A.attempts === 1);
    restore();
  }
  {
    const restore = setEnv(env());
    const m = memErpQueue(); const a1 = m.add(pl(3), false); const b1 = m.add(pl(4), false);
    const clock = { t: Date.now() };
    let state: "unread" | "good" = "unread"; let asked = 0;
    // Pre-claim passes; the first job's own check cannot read the list; later checks are fine once the list is back.
    const { a, pushed } = mk(m, { pin: async () => { asked++; return state === "unread" && asked === 2 ? UNREAD : null; } }, clock);
    const r1 = await a.runOnce(1);
    ok("an unreadable answer puts the job back in the queue, untouched", m.rows.get(a1)!.state === "queued" && r1.results[0]?.outcome === "not-sent" && pushed.length === 0, m.rows.get(a1)!.state);
    ok("that is not a failure: no error is written on the job", m.rows.get(a1)!.error === null || m.rows.get(a1)!.error === undefined);
    const r2 = await a.runOnce(1);
    ok("claiming then PAUSES (the queue is oldest-first, so the same job would be claimed again and again)", r2.results.length === 0 && /paused/.test(r2.stopped ?? "") && m.rows.get(a1)!.state === "queued", r2.stopped);
    clock.t += 16_000; state = "good";
    const r3 = await a.runOnce(1);
    ok("after the pause the job goes through, then the next one", m.rows.get(a1)!.state === "succeeded" && r3.results[0]?.id === a1, m.rows.get(a1)!.state);
    const r4 = await a.runOnce(1);
    ok("and the following job is not held up", m.rows.get(b1)!.state === "succeeded" && r4.results[0]?.id === b1);
    restore();
  }
  {
    const restore = setEnv(env());
    const m = memErpQueue(); m.add(pl(5), false);
    const clock = { t: Date.now() };
    const { a } = mk(m, { pin: async () => UNREAD }, clock);
    // pre-claim fails every time here: no claim at all, the job is never touched
    const r = await a.runOnce(1);
    ok("an unreadable list before the claim claims nothing", r.results.length === 0 && [...m.rows.values()][0].attempts === 0 && /could not be read/.test(r.stopped ?? ""));
    restore();
  }
  {
    // The pause doubles: 15 s, 30 s, ... capped at 300 s.
    const restore = setEnv(env());
    const m = memErpQueue(); m.add(pl(6), false);
    const clock = { t: Date.now() };
    let asked = 0;
    const { a } = mk(m, { pin: async () => (++asked % 2 === 0 ? UNREAD : null) }, clock);
    await a.runOnce(1);
    const p1 = (a as any).claimsPausedUntil - clock.t;
    clock.t += p1 + 1;
    await a.runOnce(1);
    const p2 = (a as any).claimsPausedUntil - clock.t;
    ok("the pause is 15 s, then 30 s", p1 === 15_000 && p2 === 30_000, `${p1} ${p2}`);
    restore();
  }

  console.log("\n  item 2: tallySeams carries no pin; a mode-OFF agent built like the rigs still claims");
  {
    const seams = tallySeams("http://x", async () => listing([[NAME, OTHER]]));
    ok("tallySeams has no `pin`", !("pin" in seams));
    const restore = setEnv({ MKCP_TALLY_ROLE: "sandbox", MKCP_PRACTICE_COMPANY: NAME, MKCP_PRACTICE_COMPANY_GUID: GUID });
    const m = memErpQueue(); const id = m.add({ ...rigPayload("SEAM", 1, day), label: "ZZ TEST seam" } as any, true);
    const pushed: string[] = [];
    const a = new ErpJobAgent({
      queue: m.queue, journal: new Journal(join(dir, `j${++jn}.jsonl`)), company: NAME,
      ...seams,                                            // spread exactly as the dummy rigs do
      push: async (_c: string, p: VoucherPayload) => { pushed.push(String(p.remoteId)); return okPush(); },
      find: async () => [], taken: undefined, stamp: undefined, leaseSeconds: 90, jobLeaseSeconds: 120, wait: async () => {},
    } as any);
    const r = await a.runOnce(1);
    ok("mode OFF, tallySeams spread: the agent claims and posts the ZZ TEST job", m.rows.get(id)!.state === "succeeded" && pushed.length === 1 && r.held, `${m.rows.get(id)!.state} ${r.stopped ?? ""}`);
    ok("and it never asked Tally about the pin (no pin in use)", a.status.pin === undefined || a.status.pin === null);
    restore();
  }

  console.log("\n  item 4: a pin refusal inside tallyPost is a typed error, never 'uncertain'");
  {
    const restore = setEnv(env());
    const sent: string[] = [];
    let live = listing([[NAME, GUID]]), unreadable = false;
    installMock(async (_u, xml) => {
      if (/List of Companies/.test(xml)) { if (unreadable) throw new Error("socket hang up"); return live; }
      sent.push(isImportRequest(xml) ? "IMPORT" : "read");
      return isImportRequest(xml) ? REPLY : EMPTY;
    });
    try {
      resetListingCache();
      live = listing([[NAME, OTHER]]);
      const e1 = await tallyPost("http://x", importXml(NAME), 5000, true).then(() => null, (e: unknown) => e);
      ok("another GUID: tallyPost rejects with PinRefused, definite", e1 instanceof PinRefused && (e1 as PinRefused).definite === true && /other than MKCP_PRIMARY_COMPANY_GUID/.test((e1 as Error).message));
      unreadable = true;
      const e2 = await tallyPost("http://x", importXml(NAME), 5000, true).then(() => null, (e: unknown) => e);
      ok("the company list cannot be read: PinRefused, NOT definite (it may change)", e2 instanceof PinRefused && (e2 as PinRefused).definite === false && /could not be read/.test((e2 as Error).message));
      ok("neither refusal sent anything to Tally", !sent.includes("IMPORT"));
      unreadable = false; live = listing([[NAME, GUID]]);
      const ok3 = await tallyPost("http://x", importXml(NAME), 5000, true).then(() => "sent", () => "refused");
      ok("the right GUID: the write goes", ok3 === "sent" && sent.includes("IMPORT"));
    } finally { uninstallMock(); resetListingCache(); }

    // The agent: the push seam throws PinRefused after `sent`.
    const m = memErpQueue(); const id = m.add(pl(7), false);
    const refused = new PinRefused(`refused: not the pinned company. Nothing was sent to Tally.`, true);
    const { a, found } = mk(m, { pin: async () => null, push: async () => { throw refused; } });
    const r = await a.runOnce(1);
    const row = m.rows.get(id)!;
    ok("a definite refusal after `sent`: the job ends FAILED with the reason, never uncertain", row.state === "failed" && /not the pinned company/.test(String(row.error)) && r.results[0]?.outcome === "failed", row.state);
    ok("it is not read back (nothing reached Tally) ", found.length === 0);
    const m2 = memErpQueue(); const id2 = m2.add(pl(8), false);
    const soft = new PinRefused(`refused: Tally's company list could not be read (socket hang up), so the pinned company cannot be checked. Nothing was sent to Tally.`, false);
    const { a: a2 } = mk(m2, { pin: async () => null, push: async () => { throw soft; } });
    await a2.runOnce(1);
    const row2 = m2.rows.get(id2)!;
    ok("an unreadable refusal after `sent`: failed with 'send it again' (the database does not allow sent back to queued), not uncertain", row2.state === "failed" && /Send it again/.test(String(row2.error)), row2.state);
    // tallyMayShowMessage: two real timeouts raise it; two pin refusals do not.
    const m3 = memErpQueue(); m3.add(pl(9), false); m3.add(pl(10), false);
    const { a: a3 } = mk(m3, { pin: async () => null, push: async () => { throw soft; } });
    await a3.runOnce(1); await a3.runOnce(1);
    ok("two pin refusals in a row do NOT mark 'Tally may be showing a message'", a3.status.tallyMayShowMessage === false);
    const m4 = memErpQueue(); m4.add(pl(11), false); m4.add(pl(12), false);
    const { a: a4 } = mk(m4, { pin: async () => null, push: async () => { throw new Error("Tally hard timeout: Vouchers took longer than 60s"); } });
    await a4.runOnce(1); await a4.runOnce(1).catch(() => {});
    ok("control: two real timeouts DO mark it", a4.status.tallyMayShowMessage === true);
    restore();

    // The write gate: a pin refusal is not evidence about the port.
    resetGate();
    for (let i = 0; i < 3; i++) await withTally("http://x", "push", async () => { throw new PinRefused("refused: x. Nothing was sent to Tally.", true); }).catch(() => {});
    ok("three pin refusals do not open the write breaker", gateState().state === "closed" && gateState().consecutiveFailures === 0, JSON.stringify(gateState()));
    for (let i = 0; i < 2; i++) await withTally("http://x", "push", async () => { throw new Error("connection reset"); }).catch(() => {});
    ok("control: two real failures do", gateState().state === "open");
    resetGate();
  }

  console.log("\n  item 5: one Tally at a time (the lane)");
  {
    const lane = new TallyLane();
    const log: string[] = []; let active = 0, maxActive = 0;
    const work = (name: string, ms: number) => async () => { active++; maxActive = Math.max(maxActive, active); log.push(`start ${name}`); await delay(ms); log.push(`end ${name}`); active--; return name; };
    const p1 = lane.run("read", "slow-read", work("slow-read", 200));
    const p2 = lane.run("read", "read-2", work("read-2", 10));
    const p3 = lane.run("write", "import", work("import", 10));
    const p4 = lane.run("read", "read-3", work("read-3", 10));
    await Promise.all([p1, p2, p3, p4]);
    ok("one at a time", maxActive === 1);
    ok("the write waits for the read in flight, then goes BEFORE the reads that were waiting", log.filter((l) => l.startsWith("start")).join() === "start slow-read,start import,start read-2,start read-3", log.join());
    const l2 = new TallyLane();
    const e = await l2.run("write", "w", async () => { throw new Error("boom"); }).then(() => null, (x) => x);
    const after = await l2.run("read", "r", async () => "fine");
    ok("a failing request does not wedge the lane", e instanceof Error && after === "fine");
  }
  {
    // Through tallyPost with a slow mock read: the queue's Import is not stuck behind the long read.
    const restore = setEnv(env());
    const startOrder: string[] = []; let active = 0, maxActive = 0;
    const t0 = Date.now(); let importStartedAt = 0;
    installMock(async (_u, xml) => {
      const id = /<ID>([^<]+)<\/ID>/.exec(xml)?.[1] ?? "?";
      const tag = isImportRequest(xml) ? "IMPORT" : id;
      active++; maxActive = Math.max(maxActive, active); startOrder.push(tag);
      if (tag === "IMPORT") importStartedAt = Date.now() - t0;
      await delay(tag === "SlowPull" ? 300 : 10);
      active--;
      if (id === "List of Companies") return listing([[NAME, GUID]]);
      return isImportRequest(xml) ? REPLY : EMPTY;
    });
    try {
      resetListingCache();
      const slow = tallyPost("http://x", readXml("SlowPull"), 5000, true);
      await delay(20);
      const readB = tallyPost("http://x", readXml("ReadB"), 5000, true);
      const write = tallyPost("http://x", importXml(NAME), 5000, true);
      await Promise.all([slow, readB, write]);
      ok("primary mode: Tally never sees two requests at once", maxActive === 1, String(maxActive));
      const real = startOrder.filter((t) => t !== "List of Companies");
      ok("the Import goes right after the slow read, BEFORE the read that queued ahead of it", real.join() === "SlowPull,IMPORT,ReadB", startOrder.join());
      ok("it waited for the one slow request only (about 300 ms), not for anything after it", importStartedAt >= 280 && importStartedAt < 600, String(importStartedAt));
      ok("the pin listing is read inside the write's own hold (just before the Import)", startOrder.indexOf("List of Companies") === startOrder.indexOf("IMPORT") - 1, startOrder.join());
    } finally { uninstallMock(); resetListingCache(); }
    restore();

    // Mode OFF: no lane, reads overlap as they always did.
    const restore2 = setEnv({});
    let active2 = 0, max2 = 0;
    installMock(async () => { active2++; max2 = Math.max(max2, active2); await delay(40); active2--; return EMPTY; });
    try { await Promise.all([tallyPost("http://x", readXml("A"), 5000, true), tallyPost("http://x", readXml("B"), 5000, true)]); }
    finally { uninstallMock(); resetListingCache(); }
    ok("mode OFF: nothing is serialised by the lane (unchanged behaviour)", max2 === 2, String(max2));
    restore2();

    // Every caller shares it: tally.ts is the only place a socket to Tally is opened.
    const srcDir = new URL("../src/", import.meta.url);
    const files = ["index.ts", "services/nightlySync.ts", "services/scheduledSyncs.ts", "services/syncOrchestrator.ts", "services/erpMirrorSync.ts", "services/erpMasters.ts", "services/pushAgent.ts"];
    const stray = files.filter((f) => { try { return /tallyPostNow|http\.request\(/.test(readFileSync(new URL(f, srcDir), "utf8")); } catch { return false; } });
    ok("the nightly and scheduled syncs, the mirror, the masters and the old agents open no socket of their own: they all go through tallyPost", stray.length === 0, stray.join());
  }

  console.log("\n  item 6: no job is settled from a read while the pin cannot be confirmed");
  {
    const restore = setEnv(env());
    const m = memErpQueue(); const id = m.add(pl(13), false);
    // A job an earlier boot left `sent`, with no reply in the journal.
    const row = m.rows.get(id)!; row.state = "sent"; row.claimed_by = `${m.machine}#old`; row.lease_until = Date.now() + 60_000;
    let pinOk = false;
    const { a, found } = mk(m, { pin: async () => (pinOk ? null : MISMATCH), find: async () => { return [{ masterId: "77" }]; } });
    await a.runOnce(1);
    ok("pin fails: the open job is NOT read and NOT settled", m.rows.get(id)!.state === "sent", m.rows.get(id)!.state);
    const { a: a2 } = mk(m, { pin: async () => (pinOk ? null : MISMATCH), find: async () => { found.push("read"); return [{ masterId: "77" }]; }, journal: new Journal(join(dir, "jx.jsonl")) });
    const s = await a2.settleOwn();
    ok("settleOwn called directly: left open, reason says the pin was not confirmed", m.rows.get(id)!.state === "sent" && /not read, because the pinned company could not be confirmed/.test(s[0]?.how ?? "") && found.length === 0, s[0]?.how);
    pinOk = true;
    const s3 = await a.settleOwn();
    ok("pin holds: the same job is read and settled as before", s3.length === 1 && m.rows.get(id)!.state !== "sent", `${m.rows.get(id)!.state} ${s3[0]?.how}`);
    restore();
  }

  console.log("\n  item 12: the LOWs");
  {
    const op = (e: Record<string, string | undefined>) => e;
    const E = op(env());
    ok("whitespace inside the tag does not hide a write", isImportRequest("<TALLYREQUEST >Import</TALLYREQUEST>") && isImportRequest("<TALLYREQUEST\n>  Import</TALLYREQUEST>") && isImportRequest("<TALLYREQUEST>Import</TALLYREQUEST>"));
    ok("an Export is still not a write", !isImportRequest("<TALLYREQUEST>Export</TALLYREQUEST>") && !isImportRequest("<TALLYREQUESTS>Import</TALLYREQUESTS>"));
    ok("exact name wins when only capital letters differ from another open company's? No: two names that differ only by case are a refusal",
      /differ only by capital letters/.test(primaryPinProblem(NAME, listing([[NAME, GUID], [NAME.toUpperCase(), OTHER]]), E) ?? ""));
    ok("a name that matches only by case (one company) still passes", primaryPinProblem(NAME.toLowerCase(), listing([[NAME, GUID]]), E) === null);
    ok("an exact match passes", primaryPinProblem(NAME, listing([[NAME, GUID]]), E) === null);
    const f = primaryPinFailure(NAME, listing([[NAME, OTHER]]), E);
    ok("verdicts: another GUID is definite; not open, two GUIDs and the setting missing are not", f?.definite === true
      && primaryPinFailure(NAME, listing([]), E)?.definite === false
      && primaryPinFailure(NAME, listing([[NAME, GUID], [NAME, OTHER]]), E)?.definite === false
      && primaryPinFailure(NAME, listing([[NAME, GUID]]), { MKCP_PRIMARY_MODE: "on" })?.definite === false);
    ok("no company named is definite", primaryPinFailure("  ", listing([[NAME, GUID]]), E)?.definite === true);

    const restore = setEnv(env());
    const sent: string[] = [];
    installMock(async (_u, xml) => { if (/List of Companies/.test(xml)) return listing([[NAME, GUID]]); sent.push("x"); return isImportRequest(xml) ? REPLY : EMPTY; });
    try {
      resetListingCache();
      const two = `<ENVELOPE><HEADER><TALLYREQUEST>Import</TALLYREQUEST></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${NAME}</SVCURRENTCOMPANY></STATICVARIABLES></DESC><DATA><TALLYMESSAGE><STATICVARIABLES><SVCURRENTCOMPANY>${NAME}</SVCURRENTCOMPANY></STATICVARIABLES></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
      const e = await tallyPost("http://x", two, 5000, true).then(() => null, (x: unknown) => x);
      ok("an Import that names more than one company is refused, nothing sent", e instanceof PinRefused && /more than one company/.test((e as Error).message) && sent.length === 0);
      const spaced = importXml(NAME).replace("<TALLYREQUEST>", "<TALLYREQUEST >");
      const e2 = await tallyPost("http://x", spaced.replace(NAME, "ZZ OTHER"), 5000, true).then(() => null, (x: unknown) => x);
      ok("a write spelled with a space in the tag is still held to the pin", e2 instanceof PinRefused, String(e2));
    } finally { uninstallMock(); resetListingCache(); }
    restore();
  }

  console.log("\n  pin seam");
  {
    const restore = setEnv(env());
    const down = tallyPinSeam("http://x", async () => { throw new Error("Cannot connect"); });
    const f = await down(NAME);
    ok("tallyPinSeam: an unreadable list is a refusal that may change (not definite)", f !== null && f.definite === false && /could not be read/.test(f.reason));
    restore();
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
