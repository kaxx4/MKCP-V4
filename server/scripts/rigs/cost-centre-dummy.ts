/**
 * T11 on the dummy Tally: can the agent make a cost centre, and do the cost centre fields the sync pulls (Name, Parent, Category, GUID) read back?
 * (Found open on 13-Nov-2026: the dummy holds no cost centre, so the pull-fields read of cost centres returned nothing to judge.)
 *
 *   1. read    the cost centres the sync's own collection definition returns today (the dummy holds none; the rig records the count)
 *   2. make    a top-level ZZ TEST cost centre, then a ZZ TEST child under it (masterPusher.createCostCentre, which reads each back by name)
 *   3. pull    the sync's own request (config/collections.ts, "costCentres") and its own converter (convertCostCentres): both centres are there with
 *              name, parent, category and a GUID, and the child's parent is the first one
 *   4. teardown the child, then its parent, are deleted; the sync's read returns the starting count again
 * One Tally turn at a time, at least --min-gap-sec (default 120) apart, with a liveness stop. ZZ TEST only.
 *
 *   cd server; npx tsx scripts/rigs/cost-centre-dummy.ts [--out f.json] [--min-gap-sec 120]
 *   cleanup after a stop:  npx tsx scripts/rigs/cost-centre-dummy.ts --cleanup <stamp>
 */
import "dotenv/config";
import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";
guardScriptWrites("rigs/cost-centre-dummy");
import { preflight } from "./lib/t11.js";
import { Recorder, census, indiaToday, makeLive, stampFrom, turn, gate, stopForTallyDown, TallyDownError, type Live } from "./lib/t11Live.js";
import { createCostCentre, deleteCostCentre } from "../../src/services/masterPusher.js";
import { MASTER_COLLECTIONS } from "../../src/config/collections.js";
import { buildCollectionXml } from "../../src/services/xmlBuilder.js";
import { convertCostCentres } from "../../src/converters/convert.js";
import { tallyPost } from "../../src/tally.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const OUT = arg("--out");
const CLEANUP = arg("--cleanup");
/** First full run's check count; -1 = not calibrated yet. */
const EXPECTED = -1;
const names = (stamp: string) => ({ parent: `ZZ TEST CC ${stamp} P`, child: `ZZ TEST CC ${stamp} C` });
const def = MASTER_COLLECTIONS.find((d) => d.name === "costCentres")!;

interface Centre { name: string; parent: string; category: string; guid: string }

/** The sync's own read of cost centres: its request, its converter. */
async function pull(l: Live, why: string): Promise<Centre[]> {
  const parsed = await turn(l, why, () => tallyPost(l.url, buildCollectionXml(def, l.company), def.timeout, false));
  const { tallymessage } = convertCostCentres(parsed);
  return (tallymessage as Centre[]).map((c) => ({ name: c.name, parent: c.parent, category: c.category, guid: c.guid }));
}
const clean = (s: string): string => String(s ?? "").replace(/&#4;\s*/g, "").trim();

async function cleanup(l: Live): Promise<number> {
  const rec = new Recorder("cost-centre cleanup", -1);
  const n = names(l.stamp);
  const have = new Set((await pull(l, "read cost centres")).map((c) => c.name));
  for (const name of [n.child, n.parent]) {
    if (!have.has(name)) continue;
    const r = await turn(l, "delete cost centre", () => deleteCostCentre(l.url, l.company, name));
    rec.check(`cleanup: cost centre "${name}" removed`, r.ok, r.notes.join("; "));
  }
  return rec.finish();
}

async function body(l: Live, rec: Recorder, made: { parent: boolean; child: boolean }, start: { n: number }): Promise<void> {
  const n = names(l.stamp);
  const before = await pull(l, "read cost centres (before)");
  start.n = before.length;
  rec.note(`cost centres in the dummy before: ${before.length}`);
  rec.check("the sync's own read of cost centres answers (the request is accepted)", Array.isArray(before));

  const p = await turn(l, "make the parent cost centre", () => createCostCentre(l.url, l.company, { name: n.parent }));
  made.parent = p.created > 0;
  rec.check("a top-level ZZ TEST cost centre is created and read back by name", p.ok, p.ok ? `parent "${p.readBack?.parent}", category "${p.readBack?.category}"` : `${p.notes.join("; ")} ${p.lineErrors.join("; ")}`.slice(0, 200));
  if (!p.ok) return;
  rec.check("the top-level one reads back with no cost centre above it", clean(p.readBack?.parent ?? "") === "" || /primary/i.test(p.readBack?.parent ?? ""), `parent "${p.readBack?.parent}"`);

  const c = await turn(l, "make the child cost centre", () => createCostCentre(l.url, l.company, { name: n.child, parent: n.parent }));
  made.child = c.created > 0;
  rec.check("a ZZ TEST child cost centre is created and read back by name", c.ok, c.ok ? `parent "${c.readBack?.parent}", category "${c.readBack?.category}"` : `${c.notes.join("; ")} ${c.lineErrors.join("; ")}`.slice(0, 200));
  if (c.ok) rec.check("the child reads back with its parent set to the first centre", clean(c.readBack?.parent ?? "") === n.parent, `parent "${c.readBack?.parent}"`);

  const after = await pull(l, "read cost centres (after the two were made)");
  const gp = after.find((x) => x.name === n.parent), gc = after.find((x) => x.name === n.child);
  rec.check("the sync's own read finds the two new centres and no other change", !!gp && (!c.ok || !!gc) && after.length === before.length + (c.ok ? 2 : 1), `${after.length} now, ${before.length} before`);
  if (gp) {
    rec.check("pulled: the parent has a name, a GUID and a category", !!gp.name && !!gp.guid && clean(gp.category) !== "", `category "${clean(gp.category)}", guid ${gp.guid ? "present" : "missing"}`);
    rec.check("pulled: the parent has no cost centre above it", clean(gp.parent) === "" || /primary/i.test(gp.parent), `parent "${clean(gp.parent)}"`);
  }
  if (gc) {
    rec.check("pulled: the child names its parent", clean(gc.parent) === n.parent, `parent "${clean(gc.parent)}"`);
    rec.check("pulled: the child has a GUID different from its parent's", !!gc.guid && !!gp && gc.guid !== gp.guid);
  }
}

async function teardown(l: Live, rec: Recorder, made: { parent: boolean; child: boolean }, start: { n: number }): Promise<void> {
  const n = names(l.stamp);
  if (made.child) { const r = await turn(l, "delete the child", () => deleteCostCentre(l.url, l.company, n.child)); rec.check(`teardown: cost centre "${n.child}" deleted`, r.ok, r.notes.join("; ")); }
  if (made.parent) { const r = await turn(l, "delete the parent", () => deleteCostCentre(l.url, l.company, n.parent)); rec.check(`teardown: cost centre "${n.parent}" deleted`, r.ok, r.notes.join("; ")); }
  const left = await pull(l, "read cost centres (after teardown)");
  rec.check("teardown: no cost centre of this run is left, and the count is the starting count", left.filter((c) => c.name.includes(l.stamp)).length === 0 && left.length === start.n, `${left.length} now, ${start.n} at the start`);
}

(async () => {
  const pf = await preflight();
  console.log(`  preflight ok (dummy is the only company open, ${pf.listMs} ms)`);
  if (CLEANUP) process.exit(await cleanup(makeLive(pf, indiaToday(), CLEANUP)));
  const stamp = stampFrom();
  const l = makeLive(pf, indiaToday(), stamp);
  const rec = new Recorder("cost centre on the dummy", EXPECTED < 0 ? 0 : EXPECTED);
  console.log(`\n  COST CENTRE on the dummy (${l.day}, stamp ${stamp})${EXPECTED < 0 ? "  [CALIBRATION RUN: the expected check count is not set yet]" : ""}\n`);
  const made = { parent: false, child: false };
  const start = { n: 0 };
  let down: TallyDownError | null = null;
  try {
    const before = await census(l);
    rec.note(`books before: ${before.total} vouchers, ${before.ours} ours (masters only are touched here)`);
    await body(l, rec, made, start);
  } catch (e) { if (e instanceof TallyDownError) down = e; else rec.check("the run finished without an error", false, (e as Error).message.slice(0, 300)); }
  finally {
    if (!down && !gate(l).down) { try { await teardown(l, rec, made, start); } catch (e) { if (e instanceof TallyDownError) down = e; else throw e; } }
    else down = down ?? gate(l).down;
    if (down) stopForTallyDown(rec, down, stamp, [`cost centre ${names(stamp).child}`, `cost centre ${names(stamp).parent}`], `cd server; npx tsx scripts/rigs/cost-centre-dummy.ts --cleanup ${stamp}`);
  }
  let code = rec.finish(OUT ?? undefined);
  if (EXPECTED < 0 && rec.failed === 0) { console.log(`  calibration: ${rec.passed} checks passed, set EXPECTED = ${rec.passed}`); code = 0; }
  process.exit(code);
})().catch((e) => { console.error(`FAILED before the run started: ${(e as Error).message}`); process.exit(2); });
