/**
 * Does the write circuit breaker actually close again?
 *
 * It did not. `withTally` was the only thing that ever OPENED the circuit, and
 * the only route to `tryRecover` was `assertWritable`, whose one non-script
 * caller (`bulkEntry`) is unreachable. So two consecutive transport failures
 * made every later `safePush` throw until the process was restarted — and a
 * transport failure is not exotic here: it is what happens whenever Tally is
 * sitting behind a modal dialog, which is routine.
 *
 * This proves the whole cycle against a FAKE Tally that can be switched off and
 * on at will. Nothing here touches the real one, so it is safe to run any time
 * and cannot wedge the operator's port.
 *
 *   npx tsx scripts/test-gate-recovery.ts
 */
import { createServer, type Server } from "node:http";
import { withTally, gateState, resetGate, TallyUnavailableError } from "../src/services/tallyGate.js";

const PORT = 19_123;
const URL = `http://127.0.0.1:${PORT}`;

/** Enough of a response that `tallyPost` parses it and resolves. */
const OK_XML = `<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>`;

function startFakeTally(): Promise<Server> {
  return new Promise((resolve) => {
    const s = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(OK_XML);
    });
    s.listen(PORT, "127.0.0.1", () => resolve(s));
  });
}

const stop = (s: Server) => new Promise<void>((r) => s.close(() => r()));

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Run one piece of "work" through the gate, reporting how it ended. */
async function attempt(fn: () => Promise<string>): Promise<{ ok: boolean; refused: boolean; err?: string }> {
  try {
    await withTally(URL, "test", fn);
    return { ok: true, refused: false };
  } catch (e) {
    return { ok: false, refused: e instanceof TallyUnavailableError, err: (e as Error).message };
  }
}

const succeed = async () => "done";
const fail = async () => { throw new Error("simulated transport failure"); };

(async () => {
  resetGate();
  console.log("\nGate recovery\n");

  // ── 1. Two consecutive failures open the circuit ─────────────────────────
  console.log("opening the circuit");
  await attempt(fail);
  check("one failure leaves the gate closed", gateState().state === "closed", `state=${gateState().state}`);
  await attempt(fail);
  check("two failures open it", gateState().state === "open", `state=${gateState().state}`);

  // ── 2. While open, work is refused — and refused CHEAPLY ─────────────────
  console.log("\nrefusing while open");
  const refused = await attempt(succeed);
  check("a later write is refused", refused.refused, refused.err?.slice(0, 60));
  check("the gate is still open", gateState().state === "open");

  // ── 3. Repeated attempts while Tally is down stay refused ────────────────
  // The cooldown means this one does not even probe — it is refused from the
  // in-memory state, which is the point: a storm of writes must not turn into
  // a storm of connections against a port that is probably behind a dialog.
  console.log("\nwith no Tally listening");
  const stillRefused = await attempt(succeed);
  check("still refused, no crash", stillRefused.refused, stillRefused.err?.slice(0, 60));

  // ── 4. Tally comes back — the circuit closes on real evidence ─────────────
  console.log("\nbringing Tally back");
  const fake = await startFakeTally();

  // The cooldown deliberately rate-limits probes, so an immediate retry is
  // still refused. That is correct behaviour, not a bug — assert it, then
  // clear the cooldown the way an operator's next attempt would once it lapses.
  const tooSoon = await attempt(succeed);
  check("a retry inside the probe cooldown is still refused", tooSoon.refused,
        "cooldown prevents hammering a port that may be behind a dialog");

  // Simulate the cooldown having lapsed.
  await new Promise((r) => setTimeout(r, 15_100));

  const recovered = await attempt(succeed);
  check("the next write probes, finds Tally alive, and GOES THROUGH", recovered.ok,
        recovered.err ? recovered.err.slice(0, 80) : "");
  check("the circuit is closed again", gateState().state === "closed", `state=${gateState().state}`);
  check("the failure counter reset", gateState().consecutiveFailures === 0,
        `consecutiveFailures=${gateState().consecutiveFailures}`);

  // ── 5. And it still works normally afterwards ────────────────────────────
  console.log("\nback to normal");
  const after = await attempt(succeed);
  check("a further write succeeds", after.ok);

  await stop(fake);
  resetGate();

  console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check(s) failed`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
