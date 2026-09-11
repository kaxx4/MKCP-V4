/**
 * Does the real-time loop actually see a change and act on it?
 *
 * Not a unit test. Starts the real poller, pushes a real voucher into Tally,
 * and waits for the loop to notice it on its own — which is the only thing that
 * proves the cursor, the detector, the fetch and the wiring all line up.
 *
 *   npx tsx scripts/test-realtime.ts --push
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters } from "../src/services/tallyMasters.js";
import { safePush } from "../src/services/safePush.js";
import { SyncOrchestrator } from "../src/services/syncOrchestrator.js";
import { ChangeDetector } from "../src/services/changeDetector.js";
import { RealtimeSync } from "../src/services/realtimeSync.js";
import type { VoucherPayload } from "../src/types.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const PUSH = process.argv.includes("--push");
const TAG = `RT${Date.now().toString().slice(-6)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  const orchestrator = new SyncOrchestrator(U, new ChangeDetector());
  // No Supabase client: this proves the Tally half. Uploading is separately covered.
  // Tick fast and check vouchers every tick — this is a test, not production.
  const rt = new RealtimeSync(U, orchestrator, null, { tickMs: 3_000, voucherEvery: 1 });

  console.log("starting the poller…");
  await rt.start();
  const started = rt.getStatus();
  console.log(`  baseline masters=${started.cursor?.masterId} vouchers=${started.cursor?.transactionId}`);
  if (!started.running) { console.log("x poller did not start"); return; }

  await sleep(4000);
  const quiet = rt.getStatus();
  console.log(`  after ${quiet.ticks} quiet tick(s): vouchersApplied=${quiet.vouchersApplied}, lastChangeAt=${quiet.lastChangeAt ?? "none"}`);
  if (quiet.vouchersApplied !== 0) console.log("  ! it reported changes with nothing happening");

  if (!PUSH) { rt.stop(); console.log("\nPass --push to make a real change."); return; }

  const m = await loadMasters(U, company, { force: true });
  const party = [...m.ledgers.values()].find(l => /SUNDRY DEBTORS/i.test(l.parent) && /WEST BENGAL/i.test(l.state))!;
  const num = `${TAG}/1`;
  const v: VoucherPayload = {
    remoteId: `MKCP|Receipt|${num}|2026-27`, voucherType: "Receipt", date: TODAY,
    voucherNumber: num, narration: `${TAG} realtime probe`, partyLedgerName: party.name, isInvoice: false,
    ledgerEntries: [
      { ledgerName: "HDFC BANK", amount: 321, isDeemedPositive: true, isPartyLedger: false },
      { ledgerName: party.name, amount: 321, isDeemedPositive: false, isPartyLedger: true },
    ],
  };

  console.log(`\npushing ${num} …`);
  const res = await safePush(U, company, v);
  console.log(`  ${res.ok ? "+" : "x"} ${res.ok ? `id ${res.voucherId}` : res.errors[0]}`);
  if (!res.ok) { rt.stop(); return; }

  console.log("\nwaiting for the loop to notice it on its own…");
  let seen = false;
  for (let i = 0; i < 12 && !seen; i++) {
    await sleep(3000);
    const st = rt.getStatus();
    if (st.vouchersApplied > 0 || st.lastChangeAt) {
      seen = true;
      console.log(`  + noticed after ~${(i + 1) * 3}s — vouchersApplied=${st.vouchersApplied}, cursor now ${st.cursor?.transactionId}`);
    }
  }
  if (!seen) console.log(`  x not noticed within 36s — status: ${JSON.stringify(rt.getStatus())}`);

  rt.stop();
  await safePush(U, company, { ...v, action: "Delete" });
  console.log("\nstopped and cleaned up.");
})();
