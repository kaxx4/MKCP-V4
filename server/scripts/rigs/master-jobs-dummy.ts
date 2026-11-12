/**
 * D-M.206 on the dummy Tally: the worker for queue jobs of kind `new_item` and `new_party` (web task 8-3), proved with the web's own request shapes.
 *
 *   1. new_item   a ZZ TEST item with a NEW unit (made first), group and GST/HSN from the dummy: the job succeeds, with Tally's id; the rig then reads
 *                 the unit, the item (unit, IGST rate, HSN, group) back from Tally on its own.
 *   2. new_party  a ZZ TEST supplier with a fake GSTIN: succeeds; ledger group, state and GSTIN read back.
 *   3. refused    (a) the same item again (the name exists), (b) a unit Tally lacks with no unit to make, (c) no HSN: each ends `failed` with a plain
 *                 reason and NOTHING is sent (the create seam is not called, no master appears).
 *   4. teardown   the ledger, the item and the unit are deleted and read back as gone.
 * The queue is in memory (this rig tests the Tally half; the database half needs migration 0310 and a sandbox claim rule, see the T11 report).
 * One Tally "turn" per job or read, at least --min-gap-sec (default 120) apart, with a liveness stop. ZZ TEST only; nothing else is touched.
 *
 *   cd server; npx tsx scripts/rigs/master-jobs-dummy.ts [--out f.json] [--min-gap-sec 120]
 *   cleanup after a stop:  npx tsx scripts/rigs/master-jobs-dummy.ts --cleanup <stamp>
 */
import "dotenv/config";
import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";
guardScriptWrites("rigs/master-jobs-dummy");
import { preflight } from "./lib/t11.js";
import { DUMMY_KIT, fakeGstin } from "./lib/t11Kit.js";
import { Recorder, census, dropItem, dropParty, freshMasters, indiaToday, makeLive, stampFrom, turn, gate, stopForTallyDown, TallyDownError, type Live } from "./lib/t11Live.js";
import { memErpQueue } from "./lib/memErpQueue.js";
import { ErpJobAgent, Journal, tallySeams, type ErpJob } from "../../src/services/erpJobAgent.js";
import { deleteUnit } from "../../src/services/masterPusher.js";
import { gstRateFor, hsnFor } from "../../src/services/tallyMasters.js";
import { tallyPost } from "../../src/tally.js";
import type { MasterPlan } from "../../src/services/masterJobs.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const OUT = arg("--out");
const CLEANUP = arg("--cleanup");
const kit = DUMMY_KIT;
/** First full run's check count; -1 = not calibrated yet. */
const EXPECTED = -1;
const post = (url: string, xml: string, ms = 180_000) => tallyPost(url, xml, ms, true) as Promise<string>;
/** A unit symbol is letters only (Tally answers BAD UNIT NAME for digits): the stamp's digits become letters. */
const lettersOf = (stamp: string): string => stamp.replace(/\d/g, (d) => "ABCDEFGHIJ"[Number(d)]);
const names = (stamp: string) => ({
  item: `ZZ TEST ITEM W ${stamp}`, unit: `ZZ${lettersOf(stamp)}`, party: `ZZ TEST SUPPLIER W ${stamp}`,
});

async function cleanup(l: Live): Promise<number> {
  const rec = new Recorder("master-jobs cleanup", -1);
  const n = names(l.stamp);
  const m = await freshMasters(l);
  if (m.items.has(n.item)) { const r = await dropItem(l, n.item); rec.check(`cleanup: item "${n.item}" removed`, r.ok, r.detail); }
  if (m.ledgers.has(n.party)) { const r = await dropParty(l, n.party); rec.check(`cleanup: ledger "${n.party}" removed`, r.ok, r.detail); }
  if (m.units.has(n.unit)) { const r = await turn(l, "delete unit", () => deleteUnit(l.url, l.company, n.unit)); rec.check(`cleanup: unit "${n.unit}" removed`, r.ok, r.notes.join("; ")); }
  return rec.finish();
}

async function body(l: Live, rec: Recorder, made: { item: boolean; party: boolean; unit: boolean }): Promise<void> {
  const n = names(l.stamp);
  const m0 = await freshMasters(l);
  rec.check(`the stock group "${kit.stockGroup}" exists in the dummy`, [...m0.stockGroups.keys()].some((k) => k === kit.stockGroup));
  const creditorGroup = [...m0.ledgers.values()].map((x) => x.parent).find((p) => /^sundry creditors$/i.test(p.trim()));
  rec.note(`ledger group the party is made under: ${creditorGroup ? `"${creditorGroup}" (the request says "SUNDRY CREDITORS")` : "no plain Sundry Creditors group has ledgers in the dummy"}`);
  if (!creditorGroup) { rec.check("the dummy has a Sundry Creditors group with ledgers", false); return; }
  rec.check(`no item, ledger or unit of this run exists yet`, !m0.items.has(n.item) && !m0.ledgers.has(n.party) && !m0.units.has(n.unit));

  const seams = tallySeams(l.url, post);
  const creates: MasterPlan[] = [];
  const mem = memErpQueue({ secondMs: 10 });
  const agent = new ErpJobAgent({
    queue: mem.queue, journal: new Journal(join(mkdtempSync(join(tmpdir(), "master-jobs-")), "j.jsonl")), company: l.company,
    push: async () => { throw new Error("a master job must never be pushed as a voucher"); },
    find: async () => { throw new Error("a master job must never be read as a voucher"); },
    masters: seams.masters, masterIdOf: seams.masterIdOf,
    createMaster: async (company, plan) => { creates.push(plan); made.unit = made.unit || (plan.kind === "new_item" && !!plan.unit); if (plan.kind === "new_item") made.item = true; else made.party = true; return seams.createMaster(company, plan); },
    leaseSeconds: 3600, jobLeaseSeconds: 3600, wait: async () => {},
  });
  const job = (kind: string, payload: Record<string, unknown>): { id: string } => {
    const id = mem.add(payload as unknown as ErpJob["payload"]);
    mem.rows.get(id)!.kind = kind;
    return { id };
  };
  const work = async (label: string) => turn(l, label, () => agent.runOnce(1));

  // The web's own request shapes (contracts/new-item-twins.json; buildSupplierPayload).
  const itemPayload = (over: Record<string, unknown> = {}, unit: unknown = { name: n.unit, decimals: 0 }) => ({
    label: n.item, item_key: `n-zz${l.stamp}`, draft_id: null,
    master: { name: n.item, parent: kit.stockGroup, baseUnit: n.unit, gstRate: 18, hsn: "87149290", taxability: "Taxable", ...over },
    new_unit: unit, pack: { size: 10, unit: "PKG" }, planned_rate_paise: 69900, last_rate_paise: 61200, bill_keys: [`ZZ TEST SUPPLIER|ZZ-W-${l.stamp}`],
    why: "Needed by a ZZ TEST bill", facts: [], warnings: [], checks: [],
  });
  const gstin = fakeGstin("19", Number(l.stamp) % 9000);
  const partyPayload = {
    label: n.party, party_key: `s-zz${l.stamp}`,
    master: { name: n.party, parent: "SUNDRY CREDITORS", state: "West Bengal", gstin, gstRegistrationType: "Regular" },
    bill_keys: [`ZZ TEST SUPPLIER|ZZ-W-${l.stamp}`], why: "Needed by a ZZ TEST bill", facts: [], warnings: [], checks: [],
  };

  // 1. new_item with a new unit
  const j1 = job("new_item", itemPayload());
  await work("job 1: new_item with a new unit");
  const r1 = mem.rows.get(j1.id)!;
  rec.check("1 new_item: the job succeeded", r1.state === "succeeded", `${r1.state}${r1.error ? `: ${r1.error}` : ""}`);
  rec.check("1 new_item: it carries Tally's id for the item", /^\d{1,18}$/.test(String(r1.master_id ?? "")), String(r1.master_id));
  rec.check("1 new_item: exactly one create, the unit first", creates.length === 1 && creates[0].kind === "new_item" && creates[0].unit?.name === n.unit);
  rec.check("1 new_item: the result says the unit was made and what was read back", JSON.stringify(r1.result).includes("unit_made") && JSON.stringify(r1.result).includes("read_back"), JSON.stringify(r1.result).slice(0, 240));
  const m1 = await freshMasters(l);
  const it = m1.items.get(n.item);
  rec.check("1 read by the rig: the unit is in Tally", m1.units.has(n.unit));
  rec.check("1 read by the rig: the item is in Tally under its stock group and new unit", !!it && it.baseUnit === n.unit && it.parent === kit.stockGroup, it ? `unit ${it.baseUnit}, group ${it.parent}` : "missing");
  rec.check("1 read by the rig: GST 18 and HSN 87149290 stuck", !!it && gstRateFor(m1, n.item, l.day).rate === 18 && hsnFor(m1, n.item, l.day).code === "87149290", it ? `rate ${gstRateFor(m1, n.item, l.day).rate}, hsn ${hsnFor(m1, n.item, l.day).code}` : "missing");

  // 2. new_party
  const j2 = job("new_party", partyPayload);
  await work("job 2: new_party");
  const r2 = mem.rows.get(j2.id)!;
  rec.check("2 new_party: the job succeeded", r2.state === "succeeded", `${r2.state}${r2.error ? `: ${r2.error}` : ""}`);
  rec.check("2 new_party: it carries Tally's id for the ledger", /^\d{1,18}$/.test(String(r2.master_id ?? "")), String(r2.master_id));
  const m2 = await freshMasters(l);
  const led = m2.ledgers.get(n.party);
  rec.check("2 read by the rig: the ledger is in Tally under the creditors group, with its state and GSTIN", !!led && /^sundry creditors$/i.test(led.parent.trim()) && led.state === "West Bengal" && led.gstin.toUpperCase() === gstin, led ? `group ${led.parent}, state ${led.state}, gstin ${led.gstin}` : "missing");

  // 3. refused, before Tally
  const before = creates.length;
  const jDup = job("new_item", itemPayload());
  await work("refused (a): the name exists");
  const rDup = mem.rows.get(jDup.id)!;
  rec.check("3a a name that exists: failed, in plain words, nothing created", rDup.state === "failed" && /already in Tally/.test(String(rDup.error)) && creates.length === before, `${rDup.state}: ${String(rDup.error).slice(0, 150)}`);
  const jUnit = job("new_item", itemPayload({ name: `${n.item} B`, baseUnit: "ZZNOPE" }, null));
  await work("refused (b): unit not in Tally");
  const rUnit = mem.rows.get(jUnit.id)!;
  rec.check("3b a unit Tally lacks and no unit to make: failed, nothing created", rUnit.state === "failed" && /unit "ZZNOPE" is not in Tally/.test(String(rUnit.error)) && creates.length === before, `${rUnit.state}: ${String(rUnit.error).slice(0, 150)}`);
  const jHsn = job("new_item", itemPayload({ name: `${n.item} C`, hsn: "" }, null));
  await work("refused (c): no HSN");
  const rHsn = mem.rows.get(jHsn.id)!;
  rec.check("3c no HSN: failed, nothing created", rHsn.state === "failed" && /no HSN code/.test(String(rHsn.error)) && creates.length === before, `${rHsn.state}: ${String(rHsn.error).slice(0, 150)}`);
  const m3 = await freshMasters(l);
  rec.check("3 none of the refused jobs left an item in Tally", ![`${n.item} B`, `${n.item} C`].some((x) => m3.items.has(x)) && [...m3.items.keys()].filter((k) => k.includes(l.stamp)).length === 1);
  rec.check("3 every refused job stopped at the guard stage and never reached `sent`", [rDup, rUnit, rHsn].every((r) => JSON.stringify(r.result).includes('"stage":"guard"')));
}

async function teardown(l: Live, rec: Recorder, made: { item: boolean; party: boolean; unit: boolean }): Promise<void> {
  const n = names(l.stamp);
  const m = await freshMasters(l);
  if (m.items.has(n.item) || made.item) { const r = await dropItem(l, n.item); rec.check(`teardown: item "${n.item}" deleted`, r.ok, r.detail); }
  if (m.ledgers.has(n.party) || made.party) { const r = await dropParty(l, n.party); rec.check(`teardown: ledger "${n.party}" deleted`, r.ok, r.detail); }
  if (m.units.has(n.unit) || made.unit) { const r = await turn(l, "delete unit", () => deleteUnit(l.url, l.company, n.unit)); rec.check(`teardown: unit "${n.unit}" deleted`, r.ok, r.notes.join("; ")); }
  const after = await freshMasters(l);
  const left = [...after.items.keys(), ...after.ledgers.keys(), ...after.units].filter((k) => k.includes(l.stamp) || k === n.unit);
  rec.check("teardown: no item, ledger or unit of this run is left in Tally", left.length === 0, left.join(", "));
}

(async () => {
  const pf = await preflight();
  console.log(`  preflight ok (dummy is the only company open, ${pf.listMs} ms)`);
  if (CLEANUP) process.exit(await cleanup(makeLive(pf, indiaToday(), CLEANUP)));
  const stamp = stampFrom();
  const l = makeLive(pf, indiaToday(), stamp);
  const rec = new Recorder("master jobs on the dummy", EXPECTED < 0 ? 0 : EXPECTED);
  console.log(`\n  MASTER JOBS (new_item, new_party) on the dummy (${l.day}, stamp ${stamp})${EXPECTED < 0 ? "  [CALIBRATION RUN: the expected check count is not set yet]" : ""}\n`);
  const made = { item: false, party: false, unit: false };
  let down: TallyDownError | null = null;
  let before: { total: number; ours: number } | null = null;
  try { before = await census(l); rec.note(`books before: ${before.total} vouchers, ${before.ours} ours (masters only are touched here)`); await body(l, rec, made); }
  catch (e) { if (e instanceof TallyDownError) down = e; else rec.check("the run finished without an error", false, (e as Error).message.slice(0, 300)); }
  finally {
    if (!down && !gate(l).down) { try { await teardown(l, rec, made); } catch (e) { if (e instanceof TallyDownError) down = e; else throw e; } }
    else down = down ?? gate(l).down;
    if (down) stopForTallyDown(rec, down, stamp, [`item ${names(stamp).item}`, `ledger ${names(stamp).party}`, `unit ${names(stamp).unit}`], `cd server; npx tsx scripts/rigs/master-jobs-dummy.ts --cleanup ${stamp}`);
  }
  let code = rec.finish(OUT ?? undefined);
  if (EXPECTED < 0 && rec.failed === 0) { console.log(`  calibration: ${rec.passed} checks passed, set EXPECTED = ${rec.passed}`); code = 0; }
  process.exit(code);
})().catch((e) => { console.error(`FAILED before the run started: ${(e as Error).message}`); process.exit(2); });
