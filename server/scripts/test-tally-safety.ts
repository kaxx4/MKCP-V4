/**
 * Does Tally survive the automation?
 *
 * The failure we are protecting against is specific: Tally's XML port is
 * single-threaded, and an unexpected request raises a modal dialog in the
 * desktop app. While that dialog is up the port accepts connections and never
 * answers, so everything queues behind it and a person has to restart Tally.
 *
 * Note what is NOT tested here: we never deliberately send real Tally malformed
 * XML to see what happens. That is the one experiment that would cause the very
 * outage we are trying to prevent. The circuit breaker is exercised against a
 * dead port instead, which produces the same transport failure safely.
 *
 *   npx tsx scripts/test-tally-safety.ts --push
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters } from "../src/services/tallyMasters.js";
import { safePush } from "../src/services/safePush.js";
import { withTally, probe, gateState, resetGate, assertWritable, TallyUnavailableError } from "../src/services/tallyGate.js";
import type { VoucherPayload } from "../src/types.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const DEAD_URL = "http://localhost:9099";           // nothing listens here
const PUSH = process.argv.includes("--push");
const TAG = `SAFE${Date.now().toString().slice(-6)}`;
const TODAY = new Date().toISOString().slice(0, 10);

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`); pass++; }
  else { console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); fail++; }
};
const r2 = (x: number) => Math.round(x * 100) / 100;

async function main() {
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  const m = await loadMasters(TALLY_URL, company);
  const supplier = [...m.ledgers.values()].find(l => /SUNDRY CREDITORS/i.test(l.parent) && l.state && !/WEST BENGAL/i.test(l.state))!;
  const item = [...m.items.values()].find(i => i.closingStock > 20 && i.closingRate > 20)!;
  const godown = [...m.godowns][0];
  console.log(`\ncompany "${company}"\n`);

  // ── 1. Serialisation ─────────────────────────────────────────────────────
  console.log("Concurrency:");
  {
    // Ten callers fire at once. On a single-threaded port this is exactly the
    // shape that wedges Tally; the gate must turn it into a queue of one.
    let concurrent = 0, peak = 0;
    const work = Array.from({ length: 10 }, (_, i) =>
      withTally(TALLY_URL, `probe-${i}`, async () => {
        concurrent++; peak = Math.max(peak, concurrent);
        try { return await tallyPost(TALLY_URL, HEALTH_XML, 15_000); }
        finally { concurrent--; }
      }));
    const settled = await Promise.allSettled(work);
    const ok = settled.filter(s => s.status === "fulfilled").length;
    check("ten concurrent requests all completed", ok === 10, `${ok}/10`);
    check("never more than one in flight at a time", peak === 1, `peak concurrency ${peak}`);
    check("Tally still answering afterwards", await probe(TALLY_URL));
  }

  // ── 2. Circuit breaker, exercised safely against a dead port ─────────────
  console.log("\nCircuit breaker (against a dead port, not Tally):");
  {
    resetGate();
    let refusedFast = false;
    for (let i = 0; i < 4; i++) {
      try {
        await withTally(DEAD_URL, `dead-${i}`, () => tallyPost(DEAD_URL, HEALTH_XML, 3_000));
      } catch (e) {
        if (e instanceof TallyUnavailableError) refusedFast = true;
      }
    }
    check("the circuit opened after repeated transport failures", gateState().state === "open",
      `state=${gateState().state}, failures=${gateState().consecutiveFailures}`);
    check("later callers are refused immediately rather than each timing out", refusedFast);

    // A probe against the dead port must NOT reopen the gate.
    const stillDead = await probe(DEAD_URL, 2_000);
    check("a failing probe does not reopen the circuit", !stillDead && gateState().state === "open");

    resetGate();
    check("the gate can be reset once Tally is fixed", gateState().state === "closed");
  }

  // ── 3. Pre-flight ────────────────────────────────────────────────────────
  console.log("\nPre-flight:");
  {
    let refused = false;
    try { await assertWritable(DEAD_URL); } catch { refused = true; }
    check("a batch refuses to start when Tally is unreachable", refused);
    resetGate();
    let allowed = true;
    try { await assertWritable(TALLY_URL); } catch { allowed = false; }
    check("a batch starts when Tally is healthy", allowed);
  }

  if (!PUSH) { report(); return; }

  // ── 4. Burst of real writes ──────────────────────────────────────────────
  console.log("\nA burst of real writes:");
  {
    const amount = r2(2 * item.closingRate);
    const make = (i: number): VoucherPayload => ({
      remoteId: `MKCP|Safety|${TAG}|${i}`,
      voucherType: "Purchase", date: TODAY, voucherNumber: `${TAG}/${i}`, reference: `${TAG}/${i}`,
      narration: `${TAG} burst ${i}`, partyLedgerName: supplier.name, isInvoice: true,
      ledgerEntries: [{ ledgerName: supplier.name, amount, isDeemedPositive: false, isPartyLedger: true,
        billAllocations: [{ name: `${TAG}/${i}`, billType: "New Ref", amount }] }],
      inventoryEntries: [{ stockItemName: item.name, quantity: 2, unit: item.baseUnit, rate: item.closingRate,
        amount, isDeemedPositive: true, salesLedgerName: "PURCHASE ( GST CENTRAL )",
        godownName: godown, batchName: "Primary Batch" }],
    });

    // Fired all at once on purpose — the gate is what makes this safe.
    const t0 = Date.now();
    const settled = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => safePush(TALLY_URL, company, make(i))));
    const okCount = settled.filter(s => s.status === "fulfilled" && s.value.ok).length;
    check("twelve simultaneous pushes all succeeded and verified", okCount === 12, `${okCount}/12 in ${Date.now() - t0}ms`);
    check("Tally still answering after the burst", await probe(TALLY_URL));
    check("the circuit stayed closed throughout", gateState().state === "closed", `state=${gateState().state}`);

    // Clean up after ourselves — every one is addressable by its remoteId.
    let removed = 0;
    for (let i = 0; i < 12; i++) {
      const del = await safePush(TALLY_URL, company, { ...make(i), action: "Delete" });
      if (del.ok) removed++;
    }
    check("all twelve removed again by remoteId", removed === 12, `${removed}/12`);
    check("Tally healthy after the whole cycle", await probe(TALLY_URL));
  }

  report();
}

function report() {
  console.log(`\n${"─".repeat(58)}\n${pass} passed, ${fail} failed`);
  console.log(`gate: ${JSON.stringify(gateState())}`);
  if (fail) process.exit(1);
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
