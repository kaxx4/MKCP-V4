/**
 * Task 1-3 done-when on the dummy Tally: the ERP queue agent (`erpJobAgent.ts`)
 * against the live `erp_jobs` (ZZ TEST rows only, deleted at the end) and the
 * practice company (ZZTEST vouchers only, swept at the end).
 *
 *   C19  a 60-job run, two boots racing, never double-claims or double-books
 *   M-3  a job cancelled while claimed is never booked
 *   D2   a kill mid-push (after Tally accepted) recovers within 2 minutes, nothing lost or doubled
 *   D4   a kill before Tally got it ends uncertain, and an uncertain job never retries itself
 *        a dropped connection after Tally accepted ends succeeded
 *   H-14 a second job with a used REMOTEID is refused before Tally
 *   M3   the database refuses a wrong machine key and an unregistered machine
 *   H1/M1/D21 the four Sales steps. With --zz-party they run on a made-up customer and item (ZZ TEST names, a ZZZ GSTIN, built
 *        with the production master builders) that the run creates first and deletes at the end, never on a real ledger.
 *        --only-sales runs just those four (plus the three cheap database checks), so a short run does not repeat C19, D2 and D4.
 *
 * PACE AND LIVENESS (D-M.180, T11 task 2): every request to Tally goes through one gate. A "turn" is one thing the rig asks of Tally
 * (one boot processing a job with its read-back, one read of the day's vouchers, one killed boot, the sweep). The next turn starts at
 * least `--min-gap-sec` seconds (default 120; 0 turns the rest off) after the last one ended, and a plain GET on Tally's port must
 * answer before each turn. While the rig rests, the boots it holds keep their lease with a heartbeat (the database only, not Tally).
 * If Tally stops answering, the run stops cleanly: nothing more is sent, nothing is restarted, and the leftovers and the cleanup
 * command are printed. At the default pace the full 60-job run takes about three hours; use `--jobs 3 --no-sales` for a short one.
 *
 * Needs: sandbox role, local Tally with the practice company open, the Tally slot,
 * MKCP_ERP_TEST_QUEUE=on for this one process, and this machine's registered key.
 *
 *   $env:MKCP_ERP_TEST_QUEUE='on'; npx tsx scripts/rigs/erp-queue-dummy.ts --out <file.json> [--jobs 60]
 *   or, to borrow the machine id and key from another worktree's .env without copying them:
 *   npx tsx scripts/rigs/erp-queue-dummy.ts --env-file <path to that .env> --out <file.json> [--jobs 3] [--no-sales]
 */
import "dotenv/config";
import "./lib/envByPath.js"; // --env-file <path>: takes the machine id and key from that .env by name, in this process only
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";
guardScriptWrites("rigs/erp-queue-dummy"); // writes only on a sandbox role against a local Tally
import { tallyPost } from "../../src/tally.js";
import { erpTestQueueClient, agentMachineId, agentMachineKey } from "../../src/services/supabaseClient.js";
import { practiceCompany } from "../../src/services/tallyRole.js";
import { safePush, vouchersOnDateXml } from "../../src/services/safePush.js";
import { loadMasters, gstRateFor, invalidateMasters } from "../../src/services/tallyMasters.js";
import { createLedger, deleteLedger, createStockItem, deleteStockItem } from "../../src/services/masterPusher.js";
import { DUMMY_KIT, buildSale, zzParties, zzItems } from "./lib/t11Kit.js";
import { readTag } from "../../src/services/xml.js";
import { ErpJobAgent, Journal, supabaseErpQueue, tallySeams, type ErpJob } from "../../src/services/erpJobAgent.js";
import { rigPayload, indiaToday } from "./lib/simTally.js";
import { isSweepVoucher } from "../lib/testVoucherMatch.js";
import type { VoucherPayload } from "../../src/types.js";
import { TallyGate, TallyDownError, httpPing, minGapFromArgv } from "./lib/t11Gate.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const OUT = arg("--out");
const JOBS = Number(arg("--jobs") ?? 60);
/** T11: skip the four Sales steps (H1/M1, D21). They take a REAL debtor ledger from the dummy as the voucher's party, which the tallycheck lane's rule forbids ("no real ledger as party"). Everything else, H-14 included, runs. */
const NO_SALES = process.argv.includes("--no-sales");
/** The Sales steps use a made-up customer and item that this run creates and deletes (never a real ledger). Without it they take the first debtor of the dummy, as before. */
const ZZ_PARTY = process.argv.includes("--zz-party");
/** Run only the Sales steps (after the three cheap database checks). */
const ONLY_SALES = process.argv.includes("--only-sales");
const CHILD = arg("--child");             // "after-accept" | "before-send": a boot that dies mid-push
const JOURNAL = arg("--journal") ?? join(tmpdir(), `erp-queue-dummy-${Date.now()}.jsonl`);
const company = practiceCompany();
if (!company) { console.error("MKCP_PRACTICE_COMPANY is not set"); process.exit(2); }
const c = erpTestQueueClient();
const machine = agentMachineId(), key = agentMachineKey();
const q = supabaseErpQueue(c, machine, key);
const post = (url: string, xml: string, timeoutMs = 180_000) => tallyPost(url, xml, timeoutMs, true) as Promise<string>;
const seams = tallySeams(TALLY_URL, post);
const agent = (extra: Partial<ConstructorParameters<typeof ErpJobAgent>[0]> = {}) => {
  const a = new ErpJobAgent({ queue: q, journal: new Journal(JOURNAL), company: company!, ...seams, leaseSeconds: 30, jobLeaseSeconds: 120, ...extra });
  live.add(a);
  return a;
};
const sleep = (t: number) => new Promise((r) => setTimeout(r, t));
/** Boots this run holds; they keep their lease during a rest between Tally turns. Cleared before a deliberate lease lapse. */
const live = new Set<ErpJobAgent>();
const gate = new TallyGate({
  minGapMs: minGapFromArgv(process.argv), ping: () => httpPing(TALLY_URL), log: (s) => console.log(s),
  sleep: async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await sleep(Math.min(10_000, Math.max(0, end - Date.now())));
      await Promise.all([...live].map((a) => a.heartbeat().catch(() => false)));
    }
  },
});
/** One Tally turn at a time, in the order asked (the two racing boots never reach Tally together through this). */
let chain: Promise<unknown> = Promise.resolve();
const T = <R>(label: string, fn: () => Promise<R>): Promise<R> => {
  const r = chain.then(() => gate.run(label, fn));
  chain = r.catch(() => undefined);
  return r;
};
async function untilHeld(a: ErpJobAgent, maxMs = 60_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) { if (await a.heartbeat()) return true; await sleep(3000); }
  return false;
}

if (CHILD) {
  // A boot that dies mid-push. It claims the one queued job, and exits with code 9
  // either right after Tally accepted (nothing journalled after `sent`) or right before calling Tally.
  (async () => {
    const a = agent({ push: async (co, p) => {
      if (CHILD === "before-send") process.exit(9);
      await safePush(TALLY_URL, co, p);
      process.exit(9);
    } });
    if (!(await untilHeld(a))) { console.error("child: no lease"); process.exit(3); }
    await a.runOnce(1);
    process.exit(4);   // should never get here
  })();
} else {
  main();
}

/** The git tree this run used (review M5): the evidence names the committed code it proves. */
function provenance() {
  const git = (...a: string[]) => (spawnSync("git", a, { encoding: "utf8", cwd: dirname(process.argv[1]) }).stdout ?? "").trim();
  const dirty = git("status", "--porcelain", "--", "..", "../../src").split("\n").filter(Boolean);
  return { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirtyFiles: dirty };
}

async function main() {
  const day = indiaToday();
  const prov = provenance();
  // Digits only: the sweep and the census match ZZTEST<digits>/<n> (testVoucherMatch.ts).
  // A "Q" here once left 82 rig vouchers in the dummy that the sweep could not see.
  const stamp = Date.now().toString().slice(-6);
  const steps: { step: string; ok: boolean; detail: string; at: string }[] = [];
  const step = (s: string, ok: boolean, detail = "") => {
    steps.push({ step: s, ok, detail, at: new Date().toISOString() });
    console.log(`  ${ok ? "✓" : "✗"} ${s}${detail ? ` (${detail})` : ""}`);
  };
  const made: { job: string; proposal: string; request: string }[] = [];
  const payload = (n: number, over: Partial<VoucherPayload> = {}) => ({ ...rigPayload(stamp, n, day), label: "ZZ TEST 1-3 queue", ...over });
  async function enqueue(n: number, over: Partial<VoucherPayload> = {}): Promise<{ id: string; p: VoucherPayload }> {
    const p = payload(n, over);
    const request = `ZZTEST-Q${stamp}-${n}${over.remoteId ? "-dup" : ""}`;
    const { data, error } = await c.rpc("erp_enqueue_test_job", { p_machine: machine, p_key: key, p_payload: p, p_request_id: request });
    if (error) throw new Error(`enqueue: ${error.message}`);
    made.push({ job: data.job_id, proposal: data.proposal_id, request });
    return { id: data.job_id, p };
  }
  /* Sales jobs (review H1): the queue says "Sales", Tally's master is "SALES".
     Built from the dummy's own masters, the way guardrails/sandbox.ts builds G3:
     a West Bengal debtor, one rated item, CGST and SGST. Number ZZTEST<digits>/S<n>,
     so the sweep removes it; REMOTEID MKCP|SALES|<number>, a spelling the sweep tries. */
  let saleBase: ((n: number) => VoucherPayload) | null = null;
  /** The made-up customer and item of --zz-party, once created. Deleted in the cleanup, after the vouchers are swept. */
  const zzMasters: { party: string | null; item: string | null } = { party: null, item: null };
  async function salePayload(n: number): Promise<VoucherPayload> {
    if (!saleBase && ZZ_PARTY) {
      const party = zzParties(stamp).local, item = zzItems(stamp)[0];
      const lg = await T("create the ZZ TEST customer", () => createLedger(TALLY_URL, company!, { name: party.name, parent: party.parent, state: party.state, country: "India", pincode: party.pincode, address: party.address, gstin: party.gstin, gstRegistrationType: party.gstRegistrationType, billWise: true }));
      if (!lg.ok) throw new Error(`could not create the ZZ TEST customer: ${[...lg.notes, ...lg.lineErrors].join("; ").slice(0, 160)}`);
      zzMasters.party = party.name;
      const it = await T("create the ZZ TEST item", () => createStockItem(TALLY_URL, company!, { name: item.name, parent: item.parent, baseUnit: item.baseUnit, gstRate: item.gstRate, hsn: item.hsn }));
      if (!it.ok) throw new Error(`could not create the ZZ TEST item: ${[...it.notes, ...it.lineErrors].join("; ").slice(0, 160)}`);
      zzMasters.item = item.name;
      step("H1 the Sales steps use a made-up customer and item, created here with the production builders", true, `${party.name}, ${item.name}`);
      saleBase = (k: number) => ({
        ...buildSale({ kit: DUMMY_KIT, type: "Sales", number: `ZZTEST${stamp}/S${k}`, date: day, narration: `ZZTEST${stamp} rig sale`, party, lines: [{ item: item.name, unit: item.baseUnit, qty: 1, rate: 800 + k, gstRate: item.gstRate }] }),
        label: "ZZ TEST 1-3 queue",
      }) as unknown as VoucherPayload;
    }
    if (!saleBase) {
      const m = await T("load masters", () => loadMasters(TALLY_URL, company!, { force: true }));
      const led = (re: RegExp) => [...m.ledgers.keys()].find((x) => re.test(x));
      const need = { outCgst: led(/^OUTPUT CGST$/i), outSgst: led(/^OUTPUT SGST$/i), salesWb: led(/^SALES {2}\( GST W\.B\. \)$/), roundOff: led(/^ROUNDED OFF$/i) };
      const debtor = [...m.ledgers.values()].find((l) => /Sundry Debtors/i.test(l.parent) && l.gstin && /west bengal/i.test(l.state) && l.pincode);
      const it = [...m.items.values()].find((i) => i.baseUnit && gstRateFor(m, i.name, day).rate > 0);
      if (!debtor || !it || Object.values(need).some((v) => !v)) throw new Error("the dummy's masters lack a debtor, a rated item or the sales ledgers");
      const godown = [...m.godowns][0];
      saleBase = (k: number) => {
        const amount = 800 + k, rate = gstRateFor(m, it.name, day).rate;
        const half = Math.round(amount * rate / 2) / 100, exact = Math.round((amount + 2 * half) * 100) / 100;
        const grand = Math.round(exact), ro = Math.round((grand - exact) * 100) / 100;
        const L = [
          { ledgerName: debtor.name, amount: grand, isDeemedPositive: true, isPartyLedger: true },
          { ledgerName: need.outCgst!, amount: half, isDeemedPositive: false, isPartyLedger: false },
          { ledgerName: need.outSgst!, amount: half, isDeemedPositive: false, isPartyLedger: false },
          ...(ro ? [{ ledgerName: need.roundOff!, amount: Math.abs(ro), isDeemedPositive: false, isPartyLedger: false, signedAmount: ro }] : []),
        ];
        const number = `ZZTEST${stamp}/S${k}`;
        return {
          voucherType: "Sales", date: day, voucherNumber: number, remoteId: `MKCP|SALES|${number}`,
          narration: `ZZTEST${stamp} rig sale`, isInvoice: true, partyLedgerName: debtor.name, ledgerEntries: L,
          inventoryEntries: [{ stockItemName: it.name, quantity: 1, unit: it.baseUnit, rate: amount, amount, isDeemedPositive: false,
            salesLedgerName: need.salesWb!, godownName: godown, batchName: "Primary Batch" }],
          label: "ZZ TEST 1-3 queue",
        } as unknown as VoucherPayload;
      };
    }
    return saleBase(n);
  }
  async function enqueueSale(n: number, tag = ""): Promise<{ id: string; p: VoucherPayload }> {
    const p = await salePayload(n);
    const request = `ZZTEST-Q${stamp}-S${n}${tag}`;
    const { data, error } = await c.rpc("erp_enqueue_test_job", { p_machine: machine, p_key: key, p_payload: p, p_request_id: request, p_kind: "sales_invoice" });
    if (error) throw new Error(`enqueue sale: ${error.message}`);
    made.push({ job: data.job_id, proposal: data.proposal_id, request });
    return { id: data.job_id, p };
  }
  const job = async (id: string) => (await c.from("erp_jobs").select("id,state,error,master_id,attempts").eq("is_test", true).eq("id", id).single()).data as ErpJob & { error: string | null };
  const inTally = async (p: VoucherPayload) => (await T("read voucher", () => seams.find(company!, p))).length;
  /** The numbers this run's Contra vouchers hold on the day, from ONE read (60 separate reads would be 60 rests). */
  const contraNumbers = async (): Promise<string[]> => T("read the day's Contra vouchers", async () => {
    const raw = await post(TALLY_URL, vouchersOnDateXml(company!, day, { voucherType: "Contra" }));
    return [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => readTag(m[0], "VOUCHERNUMBER"));
  });
  const tsx = join(dirname(process.argv[1]), "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
  const child = (mode: string) => T(`a boot that dies ${mode}`, async () => spawnSync(process.execPath, [tsx, process.argv[1], "--child", mode, "--journal", JOURNAL], { encoding: "utf8", env: process.env, timeout: 180_000 }));

  console.log(`\n  ERP queue on the dummy Tally (${day}, stamp ${stamp}, ${JOBS} jobs, commit ${prov.commit.slice(0, 8)}, tree ${prov.tree.slice(0, 8)})\n`);
  step("M5 the run uses committed code (no uncommitted change in the agent's src or scripts)", prov.dirtyFiles.length === 0, prov.dirtyFiles.join(", "));
  { const p1 = payload(1); if (!isSweepVoucher({ number: p1.voucherNumber ?? "", narration: p1.narration ?? "" }, "ZZTEST")) throw new Error(`refused: ${p1.voucherNumber} is not a shape the sweep can remove`); }
  try {
    // M3, live
    const bad = await c.rpc("erp_agent_take_lease", { p_machine: machine, p_key: "not-the-key", p_nonce: "x" });
    step("M3 the database refuses this machine with a wrong key", !!bad.error && /key is wrong/.test(bad.error.message), bad.error?.message.slice(0, 70));
    const office = await c.rpc("claim_erp_jobs", { p_machine: "OFFICE-PC", p_key: key, p_nonce: "x" });
    step("M3 an unregistered machine cannot claim", !!office.error && /not registered/.test(office.error.message));
    const old = await c.rpc("claim_erp_test_jobs", { p_agent: `${machine}#x`, p_limit: 1, p_lease_seconds: 10 });
    step("M3 the old test-queue claim with only the service key is refused", !!old.error && /machine key/.test(old.error.message));

    let salesAgent: ErpJobAgent | null = null;
    if (ONLY_SALES) {
      salesAgent = agent();
      if (!(await untilHeld(salesAgent, 90_000))) throw new Error("the Sales boot never took the lease");
    } else {
    // C19: 60 jobs, two boots racing
    const ids: string[] = [];
    for (let n = 1; n <= JOBS; n++) ids.push((await enqueue(n)).id);
    const A = agent(), B = agent();
    const t0 = Date.now();
    let byA = 0, byB = 0;
    for (let round = 0; round < JOBS * 3; round++) {
      const [ra, rb] = await T("two boots, one job", () => Promise.all([A.runOnce(1), B.runOnce(1)]));
      byA += ra.results.length; byB += rb.results.length;
      if (ra.results.length + rb.results.length === 0 && (ra.held || rb.held)) break;
      if (byA + byB >= JOBS) break;   // every job handled: no need to spend a rest on an empty round
    }
    const states = await Promise.all(ids.map(job));
    const good = states.filter((s) => s?.state === "succeeded").length;
    // One read of the day's Contras, counted per number (Tally answers in turn, and each read is a rest).
    const onDay = await contraNumbers();
    const counts: number[] = ids.map((_, i) => onDay.filter((x) => x === payload(i + 1).voucherNumber).length);
    step(`C19 ${JOBS} jobs with a second boot running beside the first: all succeeded`, good === JOBS, `${good}/${JOBS} in ${Math.round((Date.now() - t0) / 1000)} s, boots ${byA}/${byB}`);
    step("C19 each voucher is in Tally exactly once (never double-claimed or double-booked)", counts.every((n) => n === 1), `counts ${[...new Set(counts)].join(",")}`);
    step("C19 the lease shut the second boot out: only one boot wrote to Tally (the race itself is proved offline)", byA === 0 || byB === 0);

    // H-14: a used REMOTEID is refused before Tally
    const dupP = payload(9001, { remoteId: String(payload(1).remoteId) });
    const dup = await enqueue(9001, { remoteId: String(payload(1).remoteId) });
    const holder = byA ? A : B;
    await T("holder, duplicate-REMOTEID job", () => holder.runOnce(1));
    const dj = await job(dup.id);
    step("H-14 a second job with a used REMOTEID is refused before Tally", dj.state === "failed" && /REMOTEID/.test(dj.error ?? "") && (await inTally(dupP)) === 0, dj.error?.slice(0, 80) ?? "");

    // M-3: cancel while claimed
    const cx = await enqueue(9002);
    const { cancel, r } = await T("a job cancelled while claimed", async () => {
      await holder.heartbeat();
      const [claimed] = await q.claim(holder.nonce, 1, 120);
      const cancel = await c.rpc("erp_cancel_test_job", { p_machine: machine, p_key: key, p_id: claimed.id });
      return { cancel, r: await holder.processJob(claimed) };
    });
    step("M-3 a job cancelled while claimed is never booked", !!cancel.data && r.outcome === "not-sent" && (await job(cx.id)).state === "cancelled" && (await inTally(cx.p)) === 0, r.detail);

    // dropped connection after Tally accepted
    const dr = await enqueue(9003);
    const D = agent({ push: async (co, p) => { await safePush(TALLY_URL, co, p); throw new Error("simulated: the network dropped after Tally accepted"); } });
    live.delete(A); live.delete(B);                   // let the holder's lease run out
    await sleep(31_000);                              // the holder's lease runs out; D takes it
    await untilHeld(D);
    await T("a dropped connection after Tally accepted", () => D.runOnce(1));
    step("a dropped connection after Tally accepted ends succeeded, booked once", (await job(dr.id)).state === "succeeded" && (await inTally(dr.p)) === 1);

    // D2: kill mid-push after Tally accepted
    const k1 = await enqueue(9004);
    live.clear();
    await sleep(31_000);
    const c1 = await child("after-accept");
    const killedAt = Date.now(), restAtKill = gate.waitedMs;
    step("D2 a boot dies after Tally accepted (exit 9), the job is left sent", c1.status === 9 && (await job(k1.id)).state === "sent", `exit ${c1.status}`);
    const R = agent();
    const held = await untilHeld(R, 90_000);
    const rep = await T("the restarted boot settles the killed job", () => R.runOnce(1));
    const sinceKill = Date.now() - killedAt - (gate.waitedMs - restAtKill);   // not counting the rest we chose to give Tally
    const k1s = await job(k1.id);
    step("D2 the restarted boot settles it by reading Tally, within 2 minutes, booked once",
      held && k1s.state === "succeeded" && (await inTally(k1.p)) === 1 && sinceKill < 120_000,
      `${k1s.state}, ${Math.round(sinceKill / 1000)} s not counting the ${Math.round((gate.waitedMs - restAtKill) / 1000)} s rest, ${rep.settled[0]?.how ?? "no settle"}`);

    // D4: kill before Tally got it
    const k2 = await enqueue(9005);
    live.clear();
    await sleep(31_000);
    const c2 = await child("before-send");
    const R2 = agent();
    await untilHeld(R2, 90_000);
    await T("the restarted boot meets a job that never reached Tally", () => R2.runOnce(1));
    const k2s = await job(k2.id);
    step("D4 sent but not in Tally after a crash: uncertain, not pushed", c2.status === 9 && k2s.state === "uncertain" && (await inTally(k2.p)) === 0, k2s.error?.slice(0, 70) ?? "");
    await T("the uncertain job is left alone", () => R2.runOnce(5));
    step("D4 an uncertain job never retries itself", (await job(k2.id)).state === "uncertain" && (await inTally(k2.p)) === 0);

    salesAgent = R2;
    }
    if (NO_SALES) step("H1/M1/D21 Sales steps skipped by --no-sales (they use a real debtor ledger as the party)", true, "not run");
    else {
    const R2 = salesAgent!;
    // H1 and M1 with Sales: payload "Sales", master "SALES"
    const s1 = await enqueueSale(1);
    await T("a Sales job", () => R2.runOnce(1));
    const s1s = await job(s1.id);
    step("H1/M1 a Sales job (payload Sales, master SALES): safePush's filtered verify finds it, succeeded, in Tally once",
      s1s.state === "succeeded" && (await inTally(s1.p)) === 1, `${s1s.state}${s1s.error ? `: ${s1s.error.slice(0, 80)}` : ""}`);
    const s2 = await enqueueSale(2);
    const SD = agent({ push: async (co, p) => { await safePush(TALLY_URL, co, p); throw new Error("simulated: the network dropped after Tally accepted"); } });
    live.clear();
    await sleep(31_000);
    await untilHeld(SD);
    await T("a Sales job, reply lost", () => SD.runOnce(1));
    const s2s = await job(s2.id);
    step("H1 Sales, reply lost after Tally accepted: the read-back finds it, succeeded, booked once",
      s2s.state === "succeeded" && (await inTally(s2.p)) === 1, s2s.state);
    const s3 = await enqueueSale(3);
    live.clear();
    await sleep(31_000);
    const c3 = await child("after-accept");
    const SR = agent();
    await untilHeld(SR, 90_000);
    const s3rep = await T("the restarted boot settles the killed Sales job", () => SR.runOnce(1));
    const s3s = await job(s3.id);
    step("H1 Sales, a boot killed after Tally accepted: the restarted boot settles it from Tally, booked once",
      c3.status === 9 && s3s.state === "succeeded" && (await inTally(s3.p)) === 1, `${s3s.state}, ${s3rep.settled[0]?.how ?? "no settle"}`);
    /* Resend of a Sales job that already landed (D21): a second job with the
       same number and REMOTEID, marked as a resend of s1 on the claimed copy
       (the database's resend function is proved in the live test; the fenced
       client does not reach it). The agent must read Tally first and not push. */
    const s4 = await enqueueSale(1, "-resend");
    const before = await inTally(s1.p);
    const { rc, r4 } = await T("a resend of a Sales job that landed", async () => {
      await SR.heartbeat();
      const [rc] = await q.claim(SR.nonce, 1, 120);
      return { rc, r4: await SR.processJob({ ...rc, resend_of: s1.id }) };
    });
    step("H1 D21 a resend of a Sales job that landed reads Tally first, finds it once, and does not push again",
      rc?.id === s4.id && r4.outcome === "succeeded" && before === 1 && (await inTally(s1.p)) === 1, r4.detail);
    }
  } catch (e) {
    if (e instanceof TallyDownError) {
      console.log(`\n  TALLY_DOWN: ${e.message}\n  Nothing more was sent. The run stopped cleanly; Tally was not restarted.`);
      console.log(`  This run's vouchers carry the numbers ZZTEST${stamp}/... When TallyPrime is open on the dummy again, run:  npx tsx scripts/sweep-test-vouchers.ts ZZTEST ${day} --yes`);
      step("Tally kept answering until the end of the run", false, e.message);
    } else step("the run finished without an error", false, (e as Error).message);
  } finally {
    // Clean up: sweep the dummy by what is in the books, then delete this run's rows.
    // If Tally stopped answering, nothing more is sent to it: the rows below are still deleted (the database only).
    const sweepCmd = [tsx, join(dirname(process.argv[1]), "..", "sweep-test-vouchers.ts"), "ZZTEST", day, "--yes"];
    const tallyUp = !gate.down;
    const sweep = tallyUp
      ? await T("sweep", async () => spawnSync(process.execPath, sweepCmd, { encoding: "utf8", env: process.env })).catch(() => ({ status: 1, stdout: "sweep skipped: Tally stopped answering" }))
      : { status: 1, stdout: "sweep skipped: Tally stopped answering" };
    // L7: every number this run made is gone, not only voucher 1 (one read per type).
    const ours = new RegExp(`^ZZTEST${stamp}/`);
    let left: string[] = [];
    try {
      if (gate.down) throw new Error("Tally stopped answering, not read");
      for (const t of ["Contra", "Sales"]) {
        const raw = await T(`read the day's ${t} vouchers`, () => post(TALLY_URL, vouchersOnDateXml(company!, day, { voucherType: t })));
        left = left.concat([...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => readTag(m[0], "VOUCHERNUMBER")).filter((n) => ours.test(n)));
      }
    } catch (e) { left = [`read failed: ${(e as Error).message}`]; }
    step("swept from the dummy: none of this run's numbers is left", sweep.status === 0 && left.length === 0, `sweep exit ${sweep.status}, left ${left.length}${left.length ? `: ${left.slice(0, 5).join(", ")}` : ""}`);
    /* The made-up customer and item (--zz-party): deleted only after their vouchers are swept, and only if the sweep left none of this run's. */
    if (zzMasters.party || zzMasters.item) {
      const dels: string[] = [];
      try {
        if (gate.down) throw new Error("Tally stopped answering, nothing more is sent");
        if (zzMasters.party) { const r = await T("delete the ZZ TEST customer", () => deleteLedger(TALLY_URL, company!, zzMasters.party!)); dels.push(`customer ${r.ok ? "deleted" : `NOT deleted: ${r.notes.join("; ").slice(0, 80)}`}`); }
        if (zzMasters.item) { const r = await T("delete the ZZ TEST item", () => deleteStockItem(TALLY_URL, company!, zzMasters.item!)); dels.push(`item ${r.ok ? "deleted" : `NOT deleted: ${r.notes.join("; ").slice(0, 80)}`}`); }
      } catch (e) { dels.push(`stopped: ${(e as Error).message}`); }
      invalidateMasters();
      step("the made-up customer and item are deleted from the dummy", dels.length === (zzMasters.party ? 1 : 0) + (zzMasters.item ? 1 : 0) && dels.every((d) => /deleted$/.test(d) && !/NOT/.test(d)), dels.join("; "));
    }
    const ids = made.map((m) => m.job).filter(Boolean);
    const d1 = ids.length ? await c.from("erp_jobs").delete().in("id", ids).eq("is_test", true) : { error: null };
    const d2 = made.length ? await c.from("erp_proposal_requests").delete().in("request_id", made.map((m) => m.request)).eq("is_test", true) : { error: null };
    const d3 = made.length ? await c.from("erp_proposals").delete().in("id", made.map((m) => m.proposal)).eq("is_test", true) : { error: null };
    const { data: rest } = await c.from("erp_jobs").select("id").eq("is_test", true).in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
    step("this run's test rows are deleted", !d1.error && !d2.error && !d3.error && (rest ?? []).length === 0,
      [d1.error?.message, d2.error?.message, d3.error?.message].filter(Boolean).join("; "));
    const report = { rig: "erp-queue-dummy", day, stamp, jobs: JOBS, provenance: prov, steps, passed: steps.filter((s) => s.ok).length, failed: steps.filter((s) => !s.ok).length,
      sweepTail: (sweep.stdout ?? "").split("\n").slice(-6) };
    if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2)); }
    console.log(`\n  ${report.passed} passed, ${report.failed} failed`);
    process.exit(report.failed ? 1 : 0);
  }
}
