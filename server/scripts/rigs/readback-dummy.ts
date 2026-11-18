/**
 * Audit M1 on the dummy Tally: the "Check again" readback (`services/erpReadback.ts`) against a real Tally reply.
 *
 *   1. push    ONE fake Contra (ZZTEST<stamp>/1, the rig payload every queue rig uses) through safePush, as production does
 *   2. found   readbackVoucher for that voucher: exactly one, the same as what was sent, not cancelled, with a MASTERID
 *   3. absent  readbackVoucher for ZZTEST<stamp>/999, a number that does not exist: not_found (a good empty read, not a failed one)
 *   4. sweep   the existing sweep (sweep-test-vouchers.ts ZZTEST <day> --yes), then one read: none of this run's numbers is left
 *
 * The readback itself is read only; the push and the sweep are the only writes, both to the dummy only. Database: none (no queue is used).
 * Safety: guardScriptWrites, then preflight() (sandbox role, loopback Tally, the ONE company open is the dummy by GUID). A lock file stops two
 * Tally runs overlapping. Every request goes through the pace-and-liveness gate. If any Tally step fails, NOTHING more is sent (an XML error
 * can freeze TallyPrime until a person restarts it): the rig prints the cleanup line and exits 1. It never opens or restarts Tally.
 *
 *   cd server; npx tsx scripts/rigs/readback-dummy.ts [--out f.json] [--min-gap-sec 120] [--lock <path>]
 *   exit 0 only when all 6 checks passed (rigExit.ts); 2 when it could not start (preflight, lock).
 */
import "dotenv/config";
import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";
guardScriptWrites("rigs/readback-dummy"); // writes only on a sandbox role against a local Tally
import { closeSync, openSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflight } from "./lib/t11.js";
import { Recorder, indiaToday, makeLive, stampFrom, turn, gate, push, countStored, byKey, sweepDay, stopForTallyDown, TallyDownError } from "./lib/t11Live.js";
import { rigPayload } from "./lib/simTally.js";
import { readbackVoucher, READBACK_TIMEOUT_MS } from "../../src/services/erpReadback.js";
import { tallyPost } from "../../src/tally.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const OUT = arg("--out");
const LOCK = arg("--lock") ?? join(tmpdir(), "mkcp-tally.lock");
const EXPECTED = 6;

(async () => {
  let fd: number;
  try { fd = openSync(LOCK, "wx"); } catch {
    console.error(`could not run: the lock ${LOCK} exists, so another Tally run may be in progress (or one crashed: check, then delete it by hand). Nothing was sent.`);
    process.exit(2);
  }
  const unlock = () => { try { closeSync(fd); unlinkSync(LOCK); } catch { /* already gone */ } };
  let code = 1;
  try {
    let pf;
    try { pf = await preflight(); } catch (e) {
      console.error(`could not run: ${(e as Error).message}`);
      code = 2;
      return;
    }
    console.log(`  preflight ok (dummy is the only company open, ${pf.listMs} ms)`);
    const day = indiaToday(), stamp = stampFrom();
    const l = makeLive(pf, day, stamp);
    const rec = new Recorder("readback on the dummy", EXPECTED);
    const cleanup = `cd server; npx tsx scripts/sweep-test-vouchers.ts ZZTEST ${day} --yes`;
    const p = rigPayload(stamp, 1, day);
    const read = (xml: string) => turn(l, "readback read", () => tallyPost(l.url, xml, READBACK_TIMEOUT_MS, true) as Promise<string>);
    console.log(`\n  READBACK on the dummy (${day}, stamp ${stamp})\n`);
    /** A Tally step failed: send nothing more. */
    const stop = (why: string) => {
      console.log(`\n  STOPPED: ${why}\n  Nothing more was sent to Tally. If this run's voucher ZZTEST${stamp}/1 is in the dummy, remove it with:\n    ${cleanup}`);
      rec.note(`stopped: ${why}; cleanup: ${cleanup}`);
    };
    try {
      const r = await push(l, p);
      if (!rec.check("push: one ZZTEST Contra booked through safePush and read back", r.ok, r.ok ? `MASTERID ${r.voucherId}` : [...r.errors, ...r.differences].join("; ").slice(0, 200))) {
        stop(`the push did not succeed (stage ${r.stage})`); return;
      }
      const found = await readbackVoucher(read, l.company, p);
      rec.check("readback: the voucher is found (exactly one)", found.status === "found", `${found.status}: ${found.note}`);
      const m = found.matches[0];
      rec.check("readback: it is the same as what was sent, not cancelled, with a MASTERID", !!m && m.sameAsSent === true && !m.cancelled && !!m.masterId,
        m ? `sameAsSent ${m.sameAsSent}, cancelled ${m.cancelled}, MASTERID ${m.masterId}${r.voucherId ? ` (push said ${r.voucherId})` : ""}` : "no match");
      if (found.status === "read_failed") { stop(`the readback read failed: ${found.note}`); return; }
      const absent = await readbackVoucher(read, l.company, { ...p, voucherNumber: `ZZTEST${stamp}/999` });
      rec.check("readback: a number that does not exist is not_found (a good empty read, not read_failed)", absent.status === "not_found", `${absent.status}: ${absent.note}`);
      if (absent.status === "read_failed") { stop(`the readback read failed: ${absent.note}`); return; }
      const sweep = await turn(l, "sweep", async () => sweepDay(day));
      rec.check("sweep: the existing sweep ran and exited 0", sweep === 0, `exit ${sweep}`);
      const left = await countStored(l, day, byKey(p));
      rec.check("sweep: this run's voucher is gone from the dummy", left === 0, `${left} left`);
    } catch (e) {
      if (e instanceof TallyDownError) stopForTallyDown(rec, e, stamp, [`Contra ZZTEST${stamp}/1`], cleanup);
      else { rec.check("the run finished without an error", false, (e as Error).message.slice(0, 300)); stop((e as Error).message.slice(0, 200)); }
    } finally {
      if (gate(l).down) rec.note("Tally stopped answering; nothing more was sent");
      code = rec.finish(OUT ?? undefined);
    }
  } finally {
    unlock();
    process.exit(code);
  }
})().catch((e) => { console.error(`FAILED before the run started: ${(e as Error).message}`); process.exit(2); });
