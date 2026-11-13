/**
 * D-M.258 item 1, offline: what a read of Tally proves about a job that may already have been done (a resend, or a job left `sent` with its reply lost).
 *
 * BEFORE the fix (277c167..05ab96e) any voucher found by the read meant "already done". So a resent Cancel whose voucher was still live was settled
 * `succeeded` without cancelling anything, and a resent Delete whose voucher was still there was settled `succeeded` without deleting it. This test
 * states the right answers; run against the old code it fails on exactly those cases (the "before"), run against the fix it passes (the "after").
 *
 *   Create/Alter  the voucher found, field by field = the end state
 *   Cancel        done only when the voucher is found AND reads back cancelled; found live = not done, the cancel is sent
 *   Delete        done only when the voucher is NOT found (read fresh, from the pinned company); found = not done, the delete is sent
 *
 *   npx tsx scripts/test-primary-resend.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErpJobAgent, Journal, findInTally } from "../src/services/erpJobAgent.js";
import { endStateProof, targetExistsBefore } from "../src/services/endState.js";
import type { SafePushResult } from "../src/services/safePush.js";
import type { VoucherPayload } from "../src/types.js";
import { memErpQueue } from "./rigs/lib/memErpQueue.js";
import { rigPayload, indiaToday } from "./rigs/lib/simTally.js";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
};
const GUID = "11111111-2222-4333-8444-555555555555";
const NAME = "ZZ OFFICE CO - (from 1-Apr-26)";
const day = indiaToday();
const dir = mkdtempSync(join(tmpdir(), "primary-resend-"));
let jn = 0;

type Found = { masterId: string; cancelled?: boolean }[];
const okPush = async (): Promise<SafePushResult> => ({ ok: true, stage: "done", voucherId: "5001", errors: [], warnings: [], differences: [] });

/** A resend of an earlier job (`resend_of` set), the Tally read answering `found`. Returns what the agent did. */
async function resend(action: "Create" | "Alter" | "Cancel" | "Delete", found: Found | "unread", opts: { number?: boolean; lostReply?: boolean } = {}) {
  const m = memErpQueue();
  const payload = { ...rigPayload("RSD", 1, day), action, ...(opts.number === false ? { voucherNumber: "" } : {}) } as VoucherPayload & { label: string };
  const id = m.add(payload, false, opts.lostReply ? null : "job-original");
  const pushed: string[] = [];
  const a = new ErpJobAgent({
    queue: m.queue, journal: new Journal(join(dir, `j${++jn}.jsonl`)), company: NAME,
    pin: async () => null,
    push: async (_c, p) => { pushed.push(String(p.remoteId)); if (opts.lostReply) throw new Error("socket closed after Tally accepted"); return okPush(); },
    find: async () => { if (found === "unread") throw new Error("Tally did not answer"); return found; },
    leaseSeconds: 90, jobLeaseSeconds: 120, wait: async () => {},
  });
  const r = await a.runOnce(1);
  return { state: m.rows.get(id)!.state, error: String(m.rows.get(id)!.error ?? ""), pushed: pushed.length, detail: r.results[0]?.detail ?? "" };
}

(async () => {
  const saved = { MKCP_PRIMARY_MODE: process.env.MKCP_PRIMARY_MODE, MKCP_PRIMARY_COMPANY_GUID: process.env.MKCP_PRIMARY_COMPANY_GUID, MKCP_TALLY_ROLE: process.env.MKCP_TALLY_ROLE };
  process.env.MKCP_PRIMARY_MODE = "on"; process.env.MKCP_PRIMARY_COMPANY_GUID = GUID; delete process.env.MKCP_TALLY_ROLE;

  console.log("\n  Cancel: 'the voucher exists' is not proof; 'reads back cancelled' is");
  {
    const live = await resend("Cancel", [{ masterId: "9", cancelled: false }]);
    ok("a resent Cancel whose voucher is still LIVE sends the cancel (it must not be settled as done)", live.pushed === 1 && live.state === "succeeded", `pushed ${live.pushed}, ${live.state}: ${live.detail}`);
    const done = await resend("Cancel", [{ masterId: "9", cancelled: true }]);
    ok("a resent Cancel whose voucher reads back cancelled is settled succeeded without sending again", done.pushed === 0 && done.state === "succeeded", `pushed ${done.pushed}, ${done.state}`);
    const unknown = await resend("Cancel", [{ masterId: "9" }]);
    ok("a read that does not say whether it is cancelled is not proof: the cancel is sent", unknown.pushed === 1, `pushed ${unknown.pushed}`);
    const missing = await resend("Cancel", []);
    ok("a voucher to cancel that is not in Tally: nothing is sent, a person decides (uncertain)", missing.pushed === 0 && missing.state === "uncertain", `pushed ${missing.pushed}, ${missing.state}`);
    const twins = await resend("Cancel", [{ masterId: "9", cancelled: true }, { masterId: "10", cancelled: true }]);
    ok("two vouchers found: nothing is sent, a person decides", twins.pushed === 0 && twins.state === "uncertain");
    const unread = await resend("Cancel", "unread");
    ok("a read that fails: not sent, uncertain (as before)", unread.pushed === 0 && unread.state === "uncertain");
  }

  console.log("\n  Delete: 'not found' is the proof; 'found' means it has not happened");
  {
    const still = await resend("Delete", [{ masterId: "9" }]);
    ok("a resent Delete whose voucher is still in Tally sends the delete (it must not be settled as done)", still.pushed === 1 && still.state === "succeeded", `pushed ${still.pushed}, ${still.state}: ${still.detail}`);
    const gone = await resend("Delete", []);
    ok("a resent Delete whose voucher is gone is settled succeeded without sending again", gone.pushed === 0 && gone.state === "succeeded", `pushed ${gone.pushed}, ${gone.state}`);
    const noNumber = await resend("Delete", [], { number: false });
    ok("a Delete with no voucher number is never proved by an empty read (uncertain, nothing sent)", noNumber.pushed === 0 && noNumber.state === "uncertain", `pushed ${noNumber.pushed}, ${noNumber.state}`);
  }

  console.log("\n  Create and Alter: unchanged, the matching voucher is the end state");
  {
    const c1 = await resend("Create", [{ masterId: "9" }]);
    ok("Create found once: settled succeeded, not sent again", c1.pushed === 0 && c1.state === "succeeded");
    const c0 = await resend("Create", []);
    ok("Create not found: sent", c0.pushed === 1 && c0.state === "succeeded");
    const c2 = await resend("Create", [{ masterId: "9" }, { masterId: "10" }]);
    ok("Create found twice: uncertain, nothing sent", c2.pushed === 0 && c2.state === "uncertain");
    const a1 = await resend("Alter", [{ masterId: "9" }]);
    ok("Alter whose voucher already matches the payload field by field (the read only returns a match): settled, not sent again", a1.pushed === 0 && a1.state === "succeeded");
    const a0 = await resend("Alter", []);
    ok("Alter where no voucher matches the new values (the old values are still there): sent", a0.pushed === 1);
  }

  console.log("\n  a reply lost after `sent`: the same end-state rule");
  {
    const cLive = await resend("Cancel", [{ masterId: "9", cancelled: false }], { lostReply: true });
    ok("Cancel, reply lost, voucher still live: NOT settled succeeded (uncertain, a person checks)", cLive.state === "uncertain" && cLive.pushed === 1, `${cLive.state}`);
    const cDone = await resend("Cancel", [{ masterId: "9", cancelled: true }], { lostReply: true });
    ok("Cancel, reply lost, voucher reads back cancelled: settled succeeded", cDone.state === "succeeded", `${cDone.state}`);
    const dGone = await resend("Delete", [], { lostReply: true });
    ok("Delete, reply lost, voucher gone: settled succeeded", dGone.state === "succeeded", `${dGone.state}`);
    const dStill = await resend("Delete", [{ masterId: "9" }], { lostReply: true });
    ok("Delete, reply lost, voucher still there: NOT settled succeeded (uncertain)", dStill.state === "uncertain", `${dStill.state}`);
    const cr = await resend("Create", [{ masterId: "9" }], { lostReply: true });
    ok("Create, reply lost, found once: settled succeeded (unchanged)", cr.state === "succeeded");
  }

  console.log("\n  the pure rule and the read");
  {
    const P = (action: VoucherPayload["action"], number = "N1") => ({ ...rigPayload("RSD", 2, day), action, voucherNumber: number } as VoucherPayload);
    ok("targetExistsBefore: Cancel, Delete and Alter yes; Create no", targetExistsBefore(P("Cancel")) && targetExistsBefore(P("Delete")) && targetExistsBefore(P("Alter")) && !targetExistsBefore(P("Create")) && !targetExistsBefore(P(undefined)));
    ok("an unset action is a Create", endStateProof(P(undefined), [{ masterId: "1" }]).done === true);
    ok("a cancelled voucher without a number is never proof", endStateProof(P("Cancel", ""), [{ masterId: "1", cancelled: true }]).done === false);

    const block = (num: string, cancelled: "Yes" | "No", entries = "") => `<VOUCHER><VOUCHERTYPENAME>Contra</VOUCHERTYPENAME><VOUCHERNUMBER>${num}</VOUCHERNUMBER><MASTERID>5</MASTERID><ISCANCELLED>${cancelled}</ISCANCELLED>${entries}</VOUCHER>`;
    const wrap = (inner: string) => `<ENVELOPE><BODY><DATA><COLLECTION>${inner}</COLLECTION></DATA></BODY></ENVELOPE>`;
    const cancelPayload = { ...rigPayload("RSD", 3, day), action: "Cancel" } as VoucherPayload;           // carries the original ledger lines
    const createPayload = { ...rigPayload("RSD", 3, day), action: "Create" } as VoucherPayload;
    const num = cancelPayload.voucherNumber!;
    const f1 = await findInTally(async () => wrap(block(num, "Yes")), NAME, cancelPayload);
    ok("findInTally finds a cancelled voucher for a Cancel even though its lines are gone, and says it is cancelled", f1.length === 1 && (f1[0] as { cancelled?: boolean }).cancelled === true, JSON.stringify(f1));
    const f2 = await findInTally(async () => wrap(block(num, "No")), NAME, cancelPayload);
    ok("a live voucher reads back as not cancelled", f2.length === 1 && (f2[0] as { cancelled?: boolean }).cancelled === false);
    const f3 = await findInTally(async () => wrap(block(num, "Yes")), NAME, createPayload);
    ok("a Create is still matched field by field (a cancelled shell with no lines is not 'our voucher')", f3.length === 0);
    const f4 = await findInTally(async () => wrap(block("OTHER/1", "No")), NAME, { ...cancelPayload, voucherNumber: num } as VoucherPayload);
    ok("a Cancel or Delete is matched by type and number: another number is not found", f4.length === 0);
    let threw = "";
    try { await findInTally(async () => "<ENVELOPE><RESPONSE>Could not set SVCURRENTCOMPANY</RESPONSE></ENVELOPE>", NAME, { ...cancelPayload, action: "Delete" } as VoucherPayload); } catch (e) { threw = (e as Error).message; }
    ok("an error reply is a failed read, never 'nothing found' (else every Delete would look done)", /error|collection/i.test(threw), threw);
  }

  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
