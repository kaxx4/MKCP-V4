/**
 * Audit M1, offline: the "Check again" readback (`services/erpReadback.ts`). Reaches neither Tally nor Supabase: Tally is a fake `post` that
 * returns canned collection XML (the shape the MkVerify day read returns), and the queue is in memory.
 *
 * It proves: one read per ask and the answer it gives (found and the same, found but different, not found on a good empty read, two found,
 * a cancelled voucher, a type in another case, no number, no usable date, an error-shaped or empty reply and a thrown read are read_failed,
 * never not_found); the round (at most 3, one at a time in queue order, one failure never stops the rest, an answer is written even for a
 * failed read, a sandbox answers only test asks and the office machine only real ones, the pin stops reading, another company is not read);
 * a missing database function is one quiet line and a 15-minute wait, never a throw; the client's request shape; the fence allows the two
 * new functions; and the queue loop runs the readback only on an idle round that held the lease.
 *
 *   npx tsx scripts/test-erp-readback.ts
 */
import {
  readbackVoucher, runReadbackRound, ReadbackRunner, supabaseReadbackQueue, readbackTargetOf, looksLikeMissingFunction, usableDate,
  READBACK_PER_ROUND, type ReadbackAsk, type ReadbackAnswer, type ReadbackQueue,
} from "../src/services/erpReadback.js";
import { erpTestFence, ERP_TEST_RPCS } from "../src/services/supabaseClient.js";
import { PrimaryQueueLoop } from "../src/services/primaryRunner.js";
import { rigPayload } from "./rigs/lib/simTally.js";
import type { RunReport } from "../src/services/erpJobAgent.js";

let passed = 0, failed = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
};
const H = (s: string) => console.log(`\n── ${s}`);

const DAY = "2026-11-18";
const CO = "ZZ PRACTICE CO";
const sent = rigPayload("123456", 1, DAY);                       // Contra ZZTEST123456/1, HDFC BANK 11 Dr, Cash 11 Cr
const N = sent.voucherNumber!;

/** One stored voucher as the MkVerify read returns it. */
function vch(o: { type?: string; number?: string; masterId?: string; cancelled?: boolean; amount?: number } = {}): string {
  const a = o.amount ?? 11;
  return `<VOUCHER REMOTEID="" VCHTYPE="${o.type ?? "Contra"}" ACTION="Create"><DATE>20261118</DATE><VOUCHERTYPENAME>${o.type ?? "Contra"}</VOUCHERTYPENAME>`
    + `<VOUCHERNUMBER>${o.number ?? N}</VOUCHERNUMBER><NARRATION>ZZTEST123456 rig</NARRATION><ISCANCELLED>${o.cancelled ? "Yes" : "No"}</ISCANCELLED><MASTERID>${o.masterId ?? "501"}</MASTERID>`
    + `<ALLLEDGERENTRIES.LIST><LEDGERNAME>HDFC BANK</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${a}.00</AMOUNT></ALLLEDGERENTRIES.LIST>`
    + `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${a}.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>`;
}
const reply = (...vs: string[]) => `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DESC></DESC><DATA><COLLECTION>${vs.join("")}</COLLECTION></DATA></BODY></ENVELOPE>`;
/** A fake post that answers with `xml` and remembers what was asked. */
function fake(xml: string | (() => string | Promise<string>)) {
  const asked: string[] = [];
  const post = async (req: string) => { asked.push(req); return typeof xml === "function" ? await xml() : xml; };
  return { post, asked };
}
const fixedNow = () => new Date("2026-11-18T10:00:00.000Z");

(async () => {
  H("ONE READ, ONE ANSWER");
  {
    const t = fake(reply(vch()));
    const a = await readbackVoucher(t.post, CO, sent, fixedNow);
    ok("found: exactly one voucher of that type and number on the day", a.status === "found" && a.matches.length === 1, JSON.stringify(a));
    ok("found: it is the same as what was sent", a.matches[0]?.sameAsSent === true);
    ok("found: MASTERID and number are reported, not cancelled", a.matches[0]?.masterId === "501" && a.matches[0]?.voucherNumber === N && a.matches[0]?.cancelled === false);
    ok("found: the answer says what was checked and when", a.checked.type === "Contra" && a.checked.number === N && a.checked.date === DAY && a.readAt === "2026-11-18T10:00:00.000Z");
    ok("found: the note is one plain sentence", /^Found in Tally: Contra ZZTEST123456\/1 on 2026-11-18, and it matches what was sent\.$/.test(a.note), a.note);
    ok("Tally is asked exactly once", t.asked.length === 1);
    ok("the request is the bounded MkVerify day read, filtered by type and number", /<ID>MkVerify<\/ID>/.test(t.asked[0]) && /\$VoucherTypeName = "Contra"/.test(t.asked[0]) && /\$VoucherNumber = "ZZTEST123456\/1"/.test(t.asked[0]) && /= 20261118\)/.test(t.asked[0]), t.asked[0].slice(-300));
    ok("the request is an Export (a read), never an Import", /<TALLYREQUEST>Export<\/TALLYREQUEST>/.test(t.asked[0]) && !/Import/i.test(t.asked[0]));
  }
  {
    const a = await readbackVoucher(fake(reply(vch({ amount: 12 }))).post, CO, sent, fixedNow);
    ok("found but different: sameAsSent is false", a.status === "found" && a.matches[0]?.sameAsSent === false, JSON.stringify(a.matches));
    ok("found but different: the note says it differs", /differs from what was sent/.test(a.note), a.note);
  }
  {
    const a = await readbackVoucher(fake(reply()).post, CO, sent, fixedNow);
    ok("not_found: a good read with no such voucher", a.status === "not_found" && a.matches.length === 0, a.status);
    ok("not_found: the note says Tally was read", /^Tally was read and holds no Contra ZZTEST123456\/1 on 2026-11-18\./.test(a.note), a.note);
  }
  {
    const a = await readbackVoucher(fake(reply(vch({ number: "ZZTEST123456/2" }), vch({ type: "Payment" }))).post, CO, sent, fixedNow);
    ok("not_found: another number or another type on the day is not this voucher", a.status === "not_found", a.status);
  }
  {
    const a = await readbackVoucher(fake(reply(vch({ masterId: "501" }), vch({ masterId: "502" }))).post, CO, sent, fixedNow);
    ok("ambiguous: two vouchers of that type and number", a.status === "ambiguous" && a.matches.length === 2 && a.matches.map((m) => m.masterId).join() === "501,502");
    ok("ambiguous: the note asks a person to check", /A person must check/.test(a.note), a.note);
  }
  {
    const a = await readbackVoucher(fake(reply(vch({ cancelled: true }))).post, CO, sent, fixedNow);
    ok("a cancelled voucher is found and shown as cancelled", a.status === "found" && a.matches[0]?.cancelled === true && /cancelled there/.test(a.note), a.note);
  }
  {
    const sale = { ...sent, voucherType: "Sales", ledgerEntries: undefined, inventoryEntries: undefined };
    const a = await readbackVoucher(fake(reply(vch({ type: "SALES" }))).post, CO, sale, fixedNow);
    ok("case-free type: the job says Sales, Tally keeps SALES", a.status === "found", a.status);
  }
  {
    const lineErr = `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><LINEERROR>Could not find Company</LINEERROR></DATA></BODY></ENVELOPE>`;
    const a = await readbackVoucher(fake(lineErr).post, CO, sent, fixedNow);
    ok("read_failed on an error-shaped reply, never not_found", a.status === "read_failed" && /Could not find Company/.test(a.note), a.note);
    const s0 = await readbackVoucher(fake(`<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>0</STATUS></HEADER></ENVELOPE>`).post, CO, sent, fixedNow);
    ok("read_failed on STATUS 0", s0.status === "read_failed", s0.status);
    const e = await readbackVoucher(fake("").post, CO, sent, fixedNow);
    ok("G7: an empty reply is read_failed, never not_found", e.status === "read_failed", e.status);
  }
  {
    const long = "socket hang up ".repeat(30);
    const a = await readbackVoucher(async () => { throw new Error(long); }, CO, sent, fixedNow);
    ok("read_failed on a thrown post, and the function does not throw", a.status === "read_failed");
    ok("the reason is kept to 160 characters", a.note.length <= 160 && /^Tally could not be read: socket hang up/.test(a.note), `${a.note.length}`);
  }
  {
    const t = fake(reply(vch()));
    const a = await readbackVoucher(t.post, CO, { ...sent, voucherNumber: "" }, fixedNow);
    ok("no number: read_failed, says the check needs one, Tally not asked", a.status === "read_failed" && /needs one/.test(a.note) && t.asked.length === 0, a.note);
    const b = await readbackVoucher(t.post, CO, { ...sent, date: "18-11-2026" }, fixedNow);
    ok("a number but no usable date: read_failed, Tally not asked", b.status === "read_failed" && /not a usable day/.test(b.note) && t.asked.length === 0, b.note);
    const c = await readbackVoucher(t.post, CO, { ...sent, date: "2026-02-30" }, fixedNow);
    ok("a date that is not a real day is not usable", c.status === "read_failed" && t.asked.length === 0);
    const d = await readbackVoucher(t.post, CO, null as any, fixedNow);
    ok("no payload at all: read_failed, no throw", d.status === "read_failed");
  }
  {
    const a = await readbackVoucher(fake(reply(vch())).post, CO, { voucherType: "Contra", voucherNumber: N, date: DAY }, fixedNow);
    ok("only type, number and date given: found, sameAsSent is null (nothing to compare)", a.status === "found" && a.matches[0]?.sameAsSent === null && /Not compared/.test(a.note), a.note);
    ok("usableDate takes a timestamp's day", usableDate("2026-11-18T00:00:00+05:30") === DAY && usableDate(null) === null);
  }

  H("THE ROUND");
  const ask = (n: number, over: Partial<ReadbackAsk> = {}): ReadbackAsk => ({
    id: `ask-${n}`, jobId: `job-${n}`, isTest: false, kind: "voucher", voucherType: "Contra", voucherNumber: `ZZTEST123456/${n}`, date: DAY, ...over,
  });
  function memQueue(asks: ReadbackAsk[], o: { failAnswer?: string; openError?: string } = {}) {
    const answers = new Map<string, ReadbackAnswer>();
    let opens = 0;
    const q: ReadbackQueue = {
      async open(limit) { opens++; if (o.openError) throw new Error(o.openError); return asks.filter((a) => !answers.has(a.id)).slice(0, limit); },
      async answer(id, a) { if (id === o.failAnswer) throw new Error("erp_agent_readback_answer: network down"); answers.set(id, a); return true; },
    };
    return { q, answers, opens: () => opens };
  }
  {
    const m = memQueue([1, 2, 3, 4, 5].map((n) => ask(n)));
    let inFlight = 0, maxInFlight = 0;
    const order: string[] = [];
    const rep = await runReadbackRound({
      queue: m.q, wantTest: false, log: () => {},
      find: async (a) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); order.push(a.id); await new Promise((r) => setTimeout(r, 5)); inFlight--;
        return readbackVoucher(fake(reply(vch({ number: a.voucherNumber! }))).post, CO, readbackTargetOf(a), fixedNow); },
    });
    ok(`at most ${READBACK_PER_ROUND} asks per round`, rep.taken === 3 && rep.results.length === 3 && m.answers.size === 3, `${rep.taken}`);
    ok("one at a time, never two reads together", maxInFlight === 1);
    ok("in the order the queue gave them", order.join() === "ask-1,ask-2,ask-3", order.join());
    ok("each answer is written", rep.results.every((r) => r.written) && m.answers.get("ask-1")?.status === "found");
    const rep2 = await runReadbackRound({ queue: m.q, wantTest: false, log: () => {}, find: async (a) => readbackVoucher(fake(reply()).post, CO, readbackTargetOf(a), fixedNow) });
    ok("the next round takes the rest", rep2.results.map((r) => r.id).join() === "ask-4,ask-5");
  }
  {
    const m = memQueue([ask(1), ask(2), ask(3)], { failAnswer: "ask-1" });
    const rep = await runReadbackRound({
      queue: m.q, wantTest: false, log: () => {},
      find: async (a) => { if (a.id === "ask-2") throw new Error("boom"); return readbackVoucher(async () => { throw new Error("ECONNREFUSED"); }, CO, readbackTargetOf(a), fixedNow); },
    });
    ok("one failure never stops the rest: all three were tried", rep.results.length === 3, JSON.stringify(rep.results));
    ok("a failed answer write is reported, the next asks still answered", rep.results[0].written === false && rep.results[1].written && rep.results[2].written);
    ok("an answer is written even for read_failed (the person sees why)", m.answers.get("ask-3")?.status === "read_failed" && /ECONNREFUSED/.test(m.answers.get("ask-3")!.note));
    ok("a find that throws still gets a read_failed answer", m.answers.get("ask-2")?.status === "read_failed" && /boom/.test(m.answers.get("ask-2")!.note));
  }
  {
    const asks = [ask(1, { isTest: true }), ask(2), ask(3, { isTest: true }), ask(4)];
    const sb = memQueue(asks), pr = memQueue(asks);
    const find = async (a: ReadbackAsk) => readbackVoucher(fake(reply()).post, CO, readbackTargetOf(a), fixedNow);
    await runReadbackRound({ queue: sb.q, wantTest: true, find, log: () => {} });
    await runReadbackRound({ queue: pr.q, wantTest: false, find, log: () => {} });
    ok("a sandbox answers only test asks", [...sb.answers.keys()].sort().join() === "ask-1,ask-3");
    ok("the office machine answers only real asks", [...pr.answers.keys()].sort().join() === "ask-2,ask-4");
    const crowd = memQueue([...[1, 2, 3, 4, 5, 6].map((n) => ask(n, { isTest: true })), ask(7)]);
    await runReadbackRound({ queue: crowd.q, wantTest: false, find, log: () => {} });
    ok("asks of the other role at the head of the list do not crowd out this machine's own", crowd.answers.has("ask-7"));
  }
  {
    const m = memQueue([ask(1), ask(2)]);
    let reads = 0;
    const rep = await runReadbackRound({ queue: m.q, wantTest: false, log: () => {}, pin: async () => "the company open in Tally is not the pinned one",
      find: async (a) => { reads++; return readbackVoucher(fake(reply()).post, CO, readbackTargetOf(a), fixedNow); } });
    ok("the pin fails: nothing is read and nothing is answered; the asks stay open", reads === 0 && m.answers.size === 0 && /not the pinned one/.test(rep.stopped ?? ""));
    const m2 = memQueue([ask(1)]);
    const rep2 = await runReadbackRound({ queue: m2.q, wantTest: false, log: () => {}, pin: async () => { throw new Error("list unreadable"); }, find: async () => { reads++; throw new Error("x"); } });
    ok("a pin that cannot be checked is a refusal, never a pass", reads === 0 && m2.answers.size === 0 && /could not be checked/.test(rep2.stopped ?? ""));
    const m3 = memQueue([ask(1, { company: "ANOTHER CO" }), ask(2, { company: CO.toLowerCase() })]);
    let reads3 = 0;
    await runReadbackRound({ queue: m3.q, wantTest: false, company: CO, log: () => {}, pin: async () => null,
      find: async (a) => { reads3++; return readbackVoucher(fake(reply(vch({ number: a.voucherNumber! }))).post, CO, readbackTargetOf(a), fixedNow); } });
    ok("an ask for another company is answered read_failed without reading Tally", m3.answers.get("ask-1")?.status === "read_failed" && /different company/.test(m3.answers.get("ask-1")!.note));
    ok("the pinned company (any case) is read", m3.answers.get("ask-2")?.status === "found" && reads3 === 1);
  }

  H("A QUEUE THAT CANNOT BE REACHED");
  {
    const missing = "erp_agent_readback_open: Could not find the function public.erp_agent_readback_open(p_key, p_limit, p_machine) in the schema cache";
    ok("the missing-function words are recognised", looksLikeMissingFunction(missing) && looksLikeMissingFunction("function erp_agent_readback_open(text) does not exist") && !looksLikeMissingFunction("timeout"));
    const m = memQueue([ask(1)], { openError: missing });
    let threw = false, rep: Awaited<ReturnType<typeof runReadbackRound>> | null = null;
    try { rep = await runReadbackRound({ queue: m.q, wantTest: false, find: async () => { throw new Error("never"); }, log: () => {} }); } catch { threw = true; }
    ok("the round does not throw when the function does not exist", !threw && !!rep?.queueError && rep.results.length === 0);
    let t = 1_000_000;
    const lines: string[] = [];
    const r = new ReadbackRunner({ queue: m.q, wantTest: false, find: async () => { throw new Error("never"); }, log: (l) => lines.push(l), now: () => t });
    await r.tick();
    ok("one quiet line, saying the functions are not applied yet", lines.length === 1 && /not applied yet/.test(lines[0]), lines.join(" | "));
    const opensBefore = m.opens();
    t += 60_000; const skipped = await r.tick();
    ok("no tight loop: within 15 minutes the database is not asked again", skipped === null && m.opens() === opensBefore);
    t += 15 * 60_000; await r.tick();
    ok("after 15 minutes it asks again, and does not log the same line twice", m.opens() === opensBefore + 1 && lines.length === 1, `${lines.length}`);
    const slow = memQueue([ask(1)], { openError: "erp_agent_readback_open: canceling statement due to statement timeout" });
    const lines2: string[] = [];
    let t2 = 0;
    const r2 = new ReadbackRunner({ queue: slow.q, wantTest: false, find: async () => { throw new Error("never"); }, log: (l) => lines2.push(l), now: () => t2, pollMs: 30_000 });
    await r2.tick(); t2 += 29_000; await r2.tick();
    ok("a slow database: the first wait is 30 s", slow.opens() === 1);
    t2 += 2_000; await r2.tick(); t2 += 59_000; await r2.tick();
    ok("then 60 s (it doubles, as the queue loop does)", slow.opens() === 2, `${slow.opens()}`);
    t2 += 2_000; await r2.tick();
    ok("and asks again after the longer wait", slow.opens() === 3);
  }

  H("THE DATABASE CLIENT");
  {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const client = { rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "erp_agent_readback_open") return { data: [
        { id: "a1", job_id: "j1", is_test: true, kind: "voucher", voucher_type: "Contra", voucher_number: N, voucher_date: "2026-11-18", company: CO },
        { id: "a2", job_id: "j2", is_test: "yes", kind: "voucher", voucher_type: "Contra", voucher_number: N, voucher_date: DAY },
        { id: "a3", job_id: "j3", is_test: false, kind: "voucher", voucher_type: "Sales", voucher_number: null, voucher_date: "2026-11-18T00:00:00" },
      ], error: null };
      return { data: true, error: null };
    } };
    const q = supabaseReadbackQueue(client, "sandbox-laptop-1", "k".repeat(64));
    const asks = await q.open(5);
    ok("open sends the machine, the key and the limit", calls[0].fn === "erp_agent_readback_open" && calls[0].args.p_machine === "sandbox-laptop-1" && calls[0].args.p_key === "k".repeat(64) && calls[0].args.p_limit === 5);
    ok("rows are mapped to asks", asks.length === 2 && asks[0].jobId === "j1" && asks[0].isTest === true && asks[0].date === DAY && asks[0].company === CO);
    ok("an ask whose test flag is not true or false is left alone", !asks.some((a) => a.id === "a2"));
    ok("a missing number stays null; a timestamp date is cut to the day", asks[1].voucherNumber === null && asks[1].date === DAY && asks[1].isTest === false);
    const a: ReadbackAnswer = { readAt: "x", status: "not_found", checked: { type: "Contra", number: N, date: DAY }, matches: [], note: "n" };
    ok("answer sends the id and the answer object", (await q.answer("a1", a)) === true && calls[1].fn === "erp_agent_readback_answer" && calls[1].args.p_id === "a1" && calls[1].args.p_answer === a);
    const bad = supabaseReadbackQueue({ rpc: async () => ({ data: null, error: { message: "function does not exist" } }) }, "m", "k");
    let msg = "";
    try { await bad.open(3); } catch (e) { msg = (e as Error).message; }
    ok("an error comes back as '<function>: <message>'", msg === "erp_agent_readback_open: function does not exist", msg);
  }

  H("THE SANDBOX FENCE");
  {
    const P = "https://abcdefghijklmnopqrst.supabase.co";
    ok("the fence lists erp_agent_readback_open and erp_agent_readback_answer", ERP_TEST_RPCS.includes("erp_agent_readback_open") && ERP_TEST_RPCS.includes("erp_agent_readback_answer"));
    ok("POST to both is allowed", erpTestFence(`${P}/rest/v1/rpc/erp_agent_readback_open`, "POST", P) === null && erpTestFence(`${P}/rest/v1/rpc/erp_agent_readback_answer`, "POST", P) === null);
    ok("the person's request_erp_readback is not the agent's and stays refused", erpTestFence(`${P}/rest/v1/rpc/request_erp_readback`, "POST", P) !== null);
    ok("the readback table itself cannot be read or written directly", erpTestFence(`${P}/rest/v1/erp_readback_requests?select=*`, "GET", P) !== null && erpTestFence(`${P}/rest/v1/erp_readback_requests`, "PATCH", P) !== null);
  }

  H("THE QUEUE LOOP RUNS IT ONLY WHEN IDLE");
  {
    const round = (r: Partial<RunReport>): RunReport => ({ held: true, settled: [], results: [], ...r });
    let next: RunReport = round({});
    let ticks = 0;
    let busyDuring = false;
    const loop: PrimaryQueueLoop = new PrimaryQueueLoop({
      agent: { runOnce: async () => next }, pollMs: 30_000, busyMs: 2_000, log: () => {},
      readback: { tick: async () => { ticks++; busyDuring = loop.status.busy; return null; } },
    });
    await loop.tick();
    ok("an idle round that held the lease runs the readback", ticks === 1);
    ok("inside the round's busy flag (the mirror waits)", busyDuring);
    next = round({ results: [{ id: "j", key: "k", outcome: "succeeded", detail: "" }] });
    await loop.tick();
    ok("a round that worked a job does not", ticks === 1);
    next = round({ held: false, stopped: "the company open in Tally is not the pinned one" });
    await loop.tick();
    ok("a round that did not hold the lease, or failed the pin, does not", ticks === 1);
    next = round({ stopped: "claiming is paused for 15 s more" });
    await loop.tick();
    ok("a round paused because the pin could not be checked does not", ticks === 1);
    const loud = new PrimaryQueueLoop({ agent: { runOnce: async () => round({}) }, pollMs: 30_000, busyMs: 2_000, log: () => {},
      readback: { tick: async () => { throw new Error("should never escape"); } } });
    const wait = await loud.tick();
    ok("a readback that throws never fails the queue round", wait === 30_000 && loud.status.errors === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); console.log(`\n${passed} passed, ${failed + 1} failed\n`); process.exit(1); });
