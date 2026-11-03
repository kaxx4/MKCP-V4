/**
 * The push agent must never book a preview job into Tally (rebuild batch 0.2).
 *
 * A branch preview of the web app shares the live database. An Owner can switch
 * writing on for a preview session; its queue rows carry source = 'preview'
 * (migration 0103). This proves the agent's side: preview rows are split off
 * before any Tally work, are dismissed with a reason instead of re-queued
 * (re-queueing would make the agent claim them forever), and the tick wires the
 * helper in before the push loop. No Tally and no Supabase are touched.
 *
 *   npx tsx server/scripts/test-preview-skip.ts
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { partitionPreviewJobs, dismissPreviewJobs, PREVIEW_DISMISS_REASON } from "../src/services/pushAgent.js";

let pass = 0, fail = 0;
const ok = (what: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${what}${detail ? "  — " + detail : ""}`);
  cond ? pass++ : fail++;
};

const job = (id: string, source?: string) => ({
  id, company: "C", payload: {} as never, idempotency_key: `k${id}`, priority: 0,
  status: "claimed", attempts: 0, max_attempts: 5, ...(source === undefined ? {} : { source }),
});

(async () => {
  console.log("\n  partition");
  const { run, preview } = partitionPreviewJobs([job("1"), job("2", "web"), job("3", "preview"), job("4", "PREVIEW"), job("5", "")]);
  ok("a row with no source (before migration 0103) is a normal job", run.some((j) => j.id === "1"));
  ok("a web row is a normal job", run.some((j) => j.id === "2"));
  ok("an empty source is a normal job", run.some((j) => j.id === "5"));
  ok("a preview row is split off", preview.map((j) => j.id).sort().join() === "3,4", preview.map((j) => j.id).join());
  ok("nothing is lost or duplicated", run.length + preview.length === 5);

  console.log("\n  dismiss");
  const calls: { table: string; patch: Record<string, unknown>; ids: string[] }[] = [];
  const fake = {
    from(table: string) {
      return { update(patch: Record<string, unknown>) { return { in(_c: string, ids: string[]) { calls.push({ table, patch, ids }); return Promise.resolve({ error: null }); } }; } };
    },
  };
  await dismissPreviewJobs(fake as never, preview);
  ok("one update on push_queue", calls.length === 1 && calls[0].table === "push_queue");
  ok("the preview rows are dismissed, not re-queued", calls[0]?.patch.status === "dismissed");
  ok("the lease is cleared", calls[0]?.patch.claimed_by === null && calls[0]?.patch.lease_until === null);
  ok("the reason is written for the person who looks", String(calls[0]?.patch.last_error).includes("preview") && calls[0]?.patch.last_error === PREVIEW_DISMISS_REASON);
  ok("only the preview ids are touched", calls[0]?.ids.sort().join() === "3,4");
  calls.length = 0;
  await dismissPreviewJobs(fake as never, []);
  ok("an empty list sends nothing", calls.length === 0);

  console.log("\n  wiring");
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "services", "pushAgent.ts"), "utf8");
  const tick = src.slice(src.indexOf("async function tick()"), src.indexOf("/** Return claimed-but-unprocessed"));
  ok("tick splits preview jobs before the Tally health check", tick.indexOf("partitionPreviewJobs") > -1 && tick.indexOf("partitionPreviewJobs") < tick.indexOf("isTallyHealthy()"));
  ok("tick dismisses them", tick.includes("dismissPreviewJobs"));

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
