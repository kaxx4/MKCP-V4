/**
 * TALLY-7 -- a failed read-back must never be turned green by the mirror check
 * or by a blind requeue. Pure and offline: no Tally, no Supabase.
 *
 *   npx tsx scripts/test-push-verdict.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withReadBackMismatch, hasReadBackMismatch, mayReconcileFromMirror, requeueRefusal } from "../src/services/pushVerdict.js";

let failures = 0;
const ok = (name: string, pass: boolean) => { console.log(`  ${pass ? "ok  " : "FAIL"} ${name}`); if (!pass) failures++; };

const plain = { success: false, created: 0, lineErrors: ["Ledger X does not exist"] };
const stored = withReadBackMismatch({ success: true, created: 1, lineErrors: [] }, ['item "A": qty sent 1.5, stored "2"']);

ok("a refused push (never reached Tally) may be reconciled from the mirror", mayReconcileFromMirror({ result: plain }));
ok("a row with no result may be reconciled", mayReconcileFromMirror({}) && mayReconcileFromMirror({ result: null }));
ok("a row whose read-back found a difference may NOT be reconciled", !mayReconcileFromMirror({ result: stored }));
ok("the marker survives a JSON round trip (it lives in a jsonb column)", hasReadBackMismatch(JSON.parse(JSON.stringify(stored))));
ok("the original result fields are kept beside the marker", (stored as { created: number }).created === 1);
ok("an empty differences list is not a mismatch", !hasReadBackMismatch(withReadBackMismatch({}, [])));
ok("requeue is refused for a read-back mismatch, and says what to do", /Open the voucher in Tally/.test(requeueRefusal({ result: stored }) ?? "") && /qty sent 1.5/.test(requeueRefusal({ result: stored }) ?? ""));
ok("requeue is allowed for an ordinary failure", requeueRefusal({ result: plain }) === null);

// The wiring: the two paths that used to undo the verdict both consult it.
const here = path.dirname(fileURLToPath(import.meta.url));
const agent = fs.readFileSync(path.join(here, "../src/services/pushAgent.ts"), "utf8");
const index = fs.readFileSync(path.join(here, "../src/index.ts"), "utf8");
ok("reconcile() filters its candidates through mayReconcileFromMirror", /\(data as Cand\[\]\)\.filter\(mayReconcileFromMirror\)/.test(agent));
ok("a read-back difference is stored with the marker", /withReadBackMismatch\(result, res\.differences\)/.test(agent));
ok("the requeue route consults requeueRefusal", /requeueRefusal\(row \?\? \{\}\)/.test(index));

if (failures) { console.error(`\n  ${failures} check(s) failed\n`); process.exit(1); }
console.log("\n  all checks passed\n");
