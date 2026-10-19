/**
 * TALLY-20 -- a failed Tally read must not advance the real-time pull cursor.
 * Offline: the Tally post is injected, the detector and orchestrator are stubs.
 *
 *   npx tsx scripts/test-changed-vouchers-cursor.ts
 */
import { SyncOrchestrator } from "../src/services/syncOrchestrator.js";
import { ChangeDetector } from "../src/services/changeDetector.js";
import { RealtimeSync } from "../src/services/realtimeSync.js";

let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => { console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${detail ? " -- " + detail : ""}`); if (!pass) failures++; };

async function main() {
  // 1. The orchestrator: a failed read throws instead of returning an empty list.
  const orch = new SyncOrchestrator("http://tally.invalid:9000", new ChangeDetector());
  (orch as any).post = async () => { throw new Error("timeout after 60000ms"); };
  let threw = "";
  try { await orch.syncChangedVouchers("TEST CO", 500); } catch (e: any) { threw = e.message; }
  ok("syncChangedVouchers THROWS when Tally cannot be read", /Could not read the changed vouchers/.test(threw), threw);
  const noBaseline = await orch.syncChangedVouchers("TEST CO", 0);
  ok("watermark 0 (no baseline yet) is still a legitimate empty answer", noBaseline.tallymessage.length === 0);

  // 2. The loop: cursor stays put on a failed read, moves on a good one.
  const mkLoop = (fetchChanged: () => Promise<{ tallymessage: unknown[] }>) => {
    const stubOrch = { syncChangedVouchers: fetchChanged, syncMastersOnly: async () => {} } as unknown as SyncOrchestrator;
    const rt = new RealtimeSync("http://tally.invalid:9000", stubOrch, null, { tickMs: 1_000_000, voucherEvery: 1 });
    const detector = {
      mastersChangedSince: async () => false,
      whatChanged: async () => ({ vouchers: { count: 3, maxAlterId: 900, voucherNumbers: ["A/1", "A/2", "A/3"] } }),
      updateSnapshot: () => {},
      fetchCurrentAlterIds: async () => ({ masterId: 1, transactionId: 900 }),
    };
    (rt as any).detector = detector;
    (rt as any).company = "TEST CO";
    (rt as any).cursor = { masterId: 1, transactionId: 500 };
    return rt;
  };
  const failing = mkLoop(async () => { throw new Error("Could not read the changed vouchers from Tally"); });
  await (failing as any).tick();
  ok("after a FAILED read the cursor is still 500 (not moved to 900)", (failing as any).cursor.transactionId === 500, `cursor ${(failing as any).cursor.transactionId}`);
  ok("and the error is on the status line for the operator", /Could not read/.test(failing.getStatus().lastError ?? ""));
  const good = mkLoop(async () => ({ tallymessage: [] }));
  await (good as any).tick();
  ok("after a good read the cursor advances to 900", (good as any).cursor.transactionId === 900);

  if (failures) { console.error(`\n  ${failures} check(s) failed\n`); process.exit(1); }
  console.log("\n  all checks passed\n");
}
main().catch((e) => { console.error(e); process.exit(1); });
