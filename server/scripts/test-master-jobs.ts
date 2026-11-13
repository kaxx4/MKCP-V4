/**
 * D-M.206 offline: the worker for queue jobs of kind `new_item` and `new_party` (web task 8-3), without Tally or Supabase.
 *   - the request shapes are the web's own (contracts/new-item-twins.json and buildSupplierPayload, copied below as fixtures);
 *   - planMasterJob refuses, in plain words and before anything is sent, what Tally would refuse;
 *   - the agent makes the unit then the item (or the ledger), reports the master's id, and finishes the job;
 *   - a refused job sends nothing; a lost reply is settled by reading the masters, never by making it again.
 *
 *   npx tsx scripts/test-master-jobs.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErpJobAgent, Journal, type ErpJob } from "../src/services/erpJobAgent.js";
import { isMasterKind, planMasterJob, settleMasterJob, masterTestRefusal, type MasterOutcome, type MasterPlan } from "../src/services/masterJobs.js";
import { buildStockItemXml, buildLedgerXml, buildCostCentreXml, isValidUnitName } from "../src/services/masterPusher.js";
import { hsnRevisions, type TallyMasters, type MasterItem, type MasterLedger } from "../src/services/tallyMasters.js";
import { fixtureMasters, G_PARTS, SUPPLIER } from "./guardrails/fixtures.js";
import { memErpQueue } from "./rigs/lib/memErpQueue.js";
import { sandboxForRig } from "./rigs/lib/simTally.js";
import { isGstinChecksumValid } from "../src/services/gstIdentity.js";
import { fakeGstin } from "./rigs/lib/t11Kit.js";

sandboxForRig();
const COMPANY = process.env.MKCP_PRACTICE_COMPANY!;
let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
};
const dir = mkdtempSync(join(tmpdir(), "master-journal-"));
let jn = 0;
const journal = () => new Journal(join(dir, `j${++jn}.jsonl`));

// ── The web's own request shapes (contracts/new-item-twins.json, lane/newitems 2a0ea489; buildSupplierPayload) ───────
const ITEM_PAYLOAD = {
  label: "ZZ TEST RIM 29 X 2.1", item_key: "n-0a1b2c3d", draft_id: null,
  master: { name: "ZZ TEST RIM 29 X 2.1", parent: G_PARTS, baseUnit: "ZZUNIT", gstRate: 18, hsn: "87149290", taxability: "Taxable" },
  new_unit: { name: "ZZUNIT", decimals: 0 }, pack: { size: 10, unit: "PKG" }, planned_rate_paise: 69900, last_rate_paise: 61200,
  bill_keys: ["ZZ TEST SUPPLIER|ZZ-PUR-2284"], why: "Needed by ZZ-PUR-2284", facts: [], warnings: [], checks: [],
};
const GSTIN = fakeGstin("19", 4242);
const PARTY_PAYLOAD = {
  label: "ZZ TEST NEW SUPPLIER", party_key: "s-1a2b3c4d",
  master: { name: "ZZ TEST NEW SUPPLIER", parent: "SUNDRY CREDITORS", state: "West Bengal", gstin: GSTIN, gstRegistrationType: "Regular" },
  bill_keys: ["ZZ TEST SUPPLIER|ZZ-PUR-2284"], why: "Needed by ZZ-PUR-2284", facts: [], warnings: [], checks: [],
};
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const withMaster = (base: typeof ITEM_PAYLOAD, over: Record<string, unknown>, unit: unknown = base.new_unit) => ({ ...clone(base), master: { ...clone(base.master), ...over }, new_unit: unit });

/** The fixture masters, with the stock group the item names and a Sundry Creditors ledger group in the spelling the books use. */
function masters(): TallyMasters {
  const m = fixtureMasters();
  m.units.add("PCS");
  return m;
}
const refusedWith = (kind: string, payload: unknown, re: RegExp, m = masters()) => {
  const r = planMasterJob(kind, payload, m);
  return !r.ok && re.test(r.reason) && /Nothing was sent to Tally/.test(r.reason);
};

(async () => {
  console.log("\n  Master jobs (new_item, new_party), offline (D-M.206)\n");

  console.log("  the kinds and the unit rule");
  ok("new_item and new_party are master kinds; a sales invoice is not", isMasterKind("new_item") && isMasterKind("new_party") && !isMasterKind("sales_invoice") && !isMasterKind(undefined));
  const unitCases: Array<[string, boolean]> = [["PCS", true], ["pc", true], ["ZZUNIT", true], ["ABCDEFGHIJKLMNOPQRST", true], ["ABCDEFGHIJKLMNOPQRSTU", false], ["ZZU1", false], ["ZZ U2", false], ["", false], [" PCS", false], ["P-C", false]];
  ok("the unit symbol rule answers as the web twin does (contract unitNames)", unitCases.every(([n, want]) => isValidUnitName(n) === want));

  console.log("\n  planning an item");
  const good = planMasterJob("new_item", ITEM_PAYLOAD, masters());
  ok("the web's own item request plans: a new unit first, then the item", good.ok && good.plan.kind === "new_item" && good.plan.unit?.name === "ZZUNIT" && good.plan.item.name === "ZZ TEST RIM 29 X 2.1" && good.plan.item.parent === G_PARTS && good.plan.item.gstRate === 18 && good.plan.item.hsn === "87149290");
  if (good.ok && good.plan.kind === "new_item") {
    const x = buildStockItemXml(good.plan.item);
    ok("the plan builds the item the production way (nested GST block, IGST 18, HSN)", x.includes("<HSNCODE>87149290</HSNCODE>") && /<GSTRATEDUTYHEAD>IGST<[/]GSTRATEDUTYHEAD>[\s\S]*?<GSTRATE>18<[/]GSTRATE>/.test(x));
  }
  const existingUnit = planMasterJob("new_item", withMaster(ITEM_PAYLOAD, { baseUnit: "PC" }, null), masters());
  ok("a unit Tally already has needs no new unit", existingUnit.ok && existingUnit.plan.kind === "new_item" && existingUnit.plan.unit === null);
  const unitMadeMeanwhile = planMasterJob("new_item", ITEM_PAYLOAD, (() => { const m = masters(); m.units.add("ZZUNIT"); return m; })());
  ok("a new unit that Tally has by now is not made twice", unitMadeMeanwhile.ok && unitMadeMeanwhile.plan.kind === "new_item" && unitMadeMeanwhile.plan.unit === null);
  ok("REFUSED: a unit Tally lacks and the request does not make", refusedWith("new_item", withMaster(ITEM_PAYLOAD, { baseUnit: "ZZNOPE" }, null), /unit "ZZNOPE" is not in Tally/));
  ok("REFUSED: a new unit whose name differs from the item's unit", refusedWith("new_item", withMaster(ITEM_PAYLOAD, { baseUnit: "ZZUNIT" }, { name: "ZZOTHER", decimals: 0 }), /makes a new unit "ZZOTHER" but the item uses "ZZUNIT"/));
  ok("REFUSED: a new unit with a digit (Tally answers BAD UNIT NAME)", refusedWith("new_item", withMaster(ITEM_PAYLOAD, { baseUnit: "ZZU1" }, { name: "ZZU1", decimals: 0 }), /letters only/));
  ok("REFUSED: no GST rate", refusedWith("new_item", withMaster(ITEM_PAYLOAD, { gstRate: null }), /no GST rate/));
  ok("REFUSED: a GST rate that is not a number", refusedWith("new_item", withMaster(ITEM_PAYLOAD, { gstRate: "18" }), /no GST rate/));
  ok("REFUSED: no HSN", refusedWith("new_item", withMaster(ITEM_PAYLOAD, { hsn: "" }), /no HSN code/));
  ok("REFUSED: an HSN that is not 4 to 8 digits", refusedWith("new_item", withMaster(ITEM_PAYLOAD, { hsn: "87A" }), /not 4 to 8 digits/));
  ok("REFUSED: a name Tally already holds, even in other letters and spacing", refusedWith("new_item", withMaster(ITEM_PAYLOAD, { name: "carrier  clip" }), /already in Tally/));
  ok("REFUSED: a stock group Tally does not have", refusedWith("new_item", withMaster(ITEM_PAYLOAD, { parent: "NO SUCH GROUP" }), /stock group "NO SUCH GROUP" is not in Tally/));
  ok("REFUSED: a way of taxing Tally does not know", refusedWith("new_item", withMaster(ITEM_PAYLOAD, { taxability: "Maybe" }), /not a way Tally taxes/));
  ok("REFUSED: no name", refusedWith("new_item", withMaster(ITEM_PAYLOAD, { name: "  " }), /no name/));
  ok("REFUSED: no details at all", refusedWith("new_item", { label: "x" }, /no details/));
  ok("the group name is taken in Tally's own spelling", (() => { const r = planMasterJob("new_item", withMaster(ITEM_PAYLOAD, { parent: G_PARTS.toLowerCase() }), masters()); return r.ok && r.plan.kind === "new_item" && r.plan.item.parent === G_PARTS; })());

  console.log("\n  planning a party");
  const m2 = masters();
  const pgood = planMasterJob("new_party", PARTY_PAYLOAD, m2);
  ok("the web's own party request plans, in the group's own spelling", pgood.ok && pgood.plan.kind === "new_party" && pgood.plan.ledger.parent === "Sundry Creditors" && pgood.plan.ledger.state === "West Bengal" && pgood.plan.ledger.gstin === GSTIN);
  if (pgood.ok && pgood.plan.kind === "new_party") ok("the plan builds the ledger the production way (state and GSTIN nested)", /LEDMAILINGDETAILS\.LIST/.test(buildLedgerXml(pgood.plan.ledger)) && /LEDGSTREGDETAILS\.LIST/.test(buildLedgerXml(pgood.plan.ledger)));
  const unreg = clone(PARTY_PAYLOAD); unreg.master.gstin = null as unknown as string; unreg.master.gstRegistrationType = "Unregistered";
  const pun = planMasterJob("new_party", unreg, m2);
  ok("an unregistered party plans with no GSTIN", pun.ok && pun.plan.kind === "new_party" && !pun.plan.ledger.gstin && pun.plan.ledger.gstRegistrationType === "Unregistered");
  const withMasterP = (over: Record<string, unknown>) => ({ ...clone(PARTY_PAYLOAD), master: { ...clone(PARTY_PAYLOAD.master), ...over } });
  ok("REFUSED: no state", refusedWith("new_party", withMasterP({ state: "" }), /no state/));
  ok("REFUSED: a ledger that already exists", refusedWith("new_party", withMasterP({ name: SUPPLIER }), /already in Tally/));
  ok("REFUSED: a ledger group Tally has no ledgers in", refusedWith("new_party", withMasterP({ parent: "NO SUCH GROUP" }), /ledger group "NO SUCH GROUP"/));
  ok("REFUSED: a GSTIN that fails its check digit", refusedWith("new_party", withMasterP({ gstin: "19AAAAA0000A1Z0" }), /check digit/) && !isGstinChecksumValid("19AAAAA0000A1Z0"));
  ok("REFUSED: Regular with no GSTIN", refusedWith("new_party", withMasterP({ gstin: null }), /no GSTIN/));
  ok("REFUSED: an unknown registration type", refusedWith("new_party", withMasterP({ gstRegistrationType: "Odd" }), /registration type/));
  ok("REFUSED: a kind this agent does not know", (() => { const r = planMasterJob("new_godown", {}, m2); return !r.ok && /does not know/.test(r.reason); })());

  console.log("\n  does Tally already hold exactly this? (a lost reply)");
  if (good.ok && pgood.ok) {
    const none = settleMasterJob(good.plan, masters(), "2026-11-12");
    ok("not in Tally: absent", none.state === "absent");
    const present = masters();
    const it = { name: "ZZ TEST RIM 29 X 2.1", parent: G_PARTS, baseUnit: "ZZUNIT", denominator: 1, closingRate: 0, closingStock: 0, gstRate: 18, cgstRate: 9, sgstRate: 9, igstRate: 18,
      gstRevisions: [{ from: "2026-04-01", rate: 18, cgst: 9, sgst: 9, igst: 18, taxability: "Taxable" }], hsnRevisions: [{ from: "2026-04-01", code: "87149290", description: "" }], gstRateSource: "Item" } as unknown as MasterItem;
    present.items.set(it.name, it);
    ok("in Tally exactly as asked: present", settleMasterJob(good.plan, present, "2026-11-12").state === "present");
    const wrong = masters(); wrong.items.set(it.name, { ...it, baseUnit: "PC" } as MasterItem);
    ok("in Tally with another unit: differs, says which", (() => { const v = settleMasterJob(good.plan, wrong, "2026-11-12"); return v.state === "differs" && /unit "PC"/.test(v.detail); })());
    const lp = masters();
    lp.ledgers.set("ZZ TEST NEW SUPPLIER", { name: "ZZ TEST NEW SUPPLIER", parent: "Sundry Creditors", gstin: GSTIN, state: "West Bengal", pincode: "", mailingName: "", address: [], registrations: [] } as MasterLedger);
    ok("a party in Tally exactly as asked: present", settleMasterJob(pgood.plan, lp, "2026-11-12").state === "present");
    lp.ledgers.get("ZZ TEST NEW SUPPLIER")!.state = "Punjab";
    ok("a party with another state: differs", settleMasterJob(pgood.plan, lp, "2026-11-12").state === "differs");
  }

  console.log("\n  the masters reader sees an item's own HSN (found on the dummy, 13-Nov-2026)");
  {
    const built = "<STOCKITEM><NAME>X</NAME><GSTDETAILS.LIST><APPLICABLEFROM>20260401</APPLICABLEFROM><HSNCODE>87149290</HSNCODE><TAXABILITY>Taxable</TAXABILITY></GSTDETAILS.LIST></STOCKITEM>";
    const typed = "<STOCKITEM><NAME>Y</NAME><HSNDETAILS.LIST><APPLICABLEFROM>20260401</APPLICABLEFROM><HSNCODE>87141010</HSNCODE><SRCOFHSNDETAILS>Specify Details Here</SRCOFHSNDETAILS></HSNDETAILS.LIST><GSTDETAILS.LIST><APPLICABLEFROM>20260401</APPLICABLEFROM><HSNCODE>87149999</HSNCODE></GSTDETAILS.LIST></STOCKITEM>";
    const inherit = "<STOCKITEM><NAME>Z</NAME><GSTDETAILS.LIST><APPLICABLEFROM>20260401</APPLICABLEFROM><TAXABILITY>Taxable</TAXABILITY></GSTDETAILS.LIST></STOCKITEM>";
    ok("an item made by the builder: its HSN inside GSTDETAILS.LIST is read for an item", hsnRevisions(built, true).map((r) => r.code).join() === "87149290" && hsnRevisions(built, true)[0].from === "2026-04-01");
    ok("a stock GROUP is read exactly as before (the GST block is not read for a group)", hsnRevisions(built).length === 0);
    ok("a hand-typed item with HSNDETAILS is read exactly as before (the GST block is ignored beside it)", hsnRevisions(typed, true).map((r) => r.code).join() === "87141010");
    ok("an item that declares no HSN still inherits its group's", hsnRevisions(inherit, true).length === 0);
  }

  console.log("\n  the cost centre request (T11, 13-Nov-2026)");
  {
    const top = buildCostCentreXml({ name: "ZZ TEST CC 1 P" });
    const kid = buildCostCentreXml({ name: "ZZ TEST CC 1 C & Co", parent: "ZZ TEST CC 1 P", category: "ZZ TEST CAT" });
    ok("a top-level cost centre has an empty parent and no category line", /<COSTCENTRE NAME="ZZ TEST CC 1 P" ACTION="Create">/.test(top) && /<PARENT[/]>/.test(top) && !/<CATEGORY>/.test(top));
    ok("a child names its parent and category, and the name is escaped", /<PARENT>ZZ TEST CC 1 P<[/]PARENT>/.test(kid) && /<CATEGORY>ZZ TEST CAT<[/]CATEGORY>/.test(kid) && /C &amp; Co/.test(kid));
    ok("an Alter request says Alter", /ACTION="Alter"/.test(buildCostCentreXml({ name: "X" }, "Alter")));
  }

  console.log("\n  the sandbox rule for a test master job");
  const env = (over: Record<string, string> = {}) => ({ MKCP_TALLY_ROLE: "sandbox", MKCP_PRACTICE_COMPANY: COMPANY, ...over }) as unknown as NodeJS.ProcessEnv;
  const jb = (payload: unknown, label = "ZZ TEST x") => ({ company: COMPANY, label, payload });
  ok("a ZZ TEST item in the practice company on a sandbox is allowed", masterTestRefusal(jb(ITEM_PAYLOAD), env()) === null);
  ok("a real-looking name is refused", /does not start with ZZ TEST/.test(masterTestRefusal(jb(withMaster(ITEM_PAYLOAD, { name: "CARRIER CLIP 2" })), env()) ?? ""));
  ok("a label without ZZ TEST is refused", /not labelled ZZ TEST/.test(masterTestRefusal(jb(ITEM_PAYLOAD, "RIM"), env()) ?? ""));
  ok("another company is refused", /not the practice company/.test(masterTestRefusal({ ...jb(ITEM_PAYLOAD), company: "SOMEONE ELSE" }, env()) ?? ""));
  ok("a primary machine is refused", /not a sandbox/.test(masterTestRefusal(jb(ITEM_PAYLOAD), env({ MKCP_TALLY_ROLE: "primary" })) ?? ""));
  ok("a test unit not starting with ZZ is refused", /must start with ZZ/.test(masterTestRefusal(jb(withMaster(ITEM_PAYLOAD, { baseUnit: "BOX" }, { name: "BOX", decimals: 0 })), env()) ?? ""));

  console.log("\n  the agent works the job");
  const noWait = async () => {};
  type Calls = { created: MasterPlan[]; read: number; ids: number };
  function agent(m: ReturnType<typeof memErpQueue>, calls: Calls, over: Partial<ConstructorParameters<typeof ErpJobAgent>[0]> = {}, snapshot: () => TallyMasters = masters) {
    return new ErpJobAgent({
      queue: m.queue, journal: journal(), company: COMPANY,
      push: async () => { throw new Error("a master job must never be pushed as a voucher"); },
      find: async () => { throw new Error("a master job must never be read as a voucher"); },
      masters: async () => { calls.read++; return snapshot(); },
      createMaster: async (_c, plan) => { calls.created.push(plan); return { ok: true, stage: "item", reason: "Made and read back: unit ZZUNIT, IGST 18%, HSN 87149290.", masterId: "4242", unitMade: !!(plan.kind === "new_item" && plan.unit), readBack: { igst: "18" } } satisfies MasterOutcome; },
      masterIdOf: async () => { calls.ids++; return "4243"; },
      leaseSeconds: 90, jobLeaseSeconds: 120, wait: noWait, ...over,
    });
  }
  const addJob = (m: ReturnType<typeof memErpQueue>, kind: string, payload: unknown) => { const id = m.add(payload as ErpJob["payload"]); m.rows.get(id)!.kind = kind; return id; };

  {
    const m = memErpQueue({ secondMs: 10 }); const calls: Calls = { created: [], read: 0, ids: 0 };
    const id = addJob(m, "new_item", ITEM_PAYLOAD);
    const a = agent(m, calls);
    const rep = await a.runOnce(1);
    const row = m.rows.get(id)!;
    ok("an approved item: the unit and the item are made, the job succeeds with the master's id", row.state === "succeeded" && row.master_id === "4242" && rep.results[0]?.outcome === "succeeded", `${row.state} ${row.master_id}`);
    ok("exactly one create, with the unit first", calls.created.length === 1 && calls.created[0].kind === "new_item" && (calls.created[0] as Extract<MasterPlan, { kind: "new_item" }>).unit?.name === "ZZUNIT");
    ok("the masters were read fresh before it", calls.read >= 1);
    ok("the result tells the page what was done", JSON.stringify(row.result).includes("ZZ TEST RIM 29 X 2.1") && JSON.stringify(row.result).includes("unit_made"));
  }
  {
    const m = memErpQueue({ secondMs: 10 }); const calls: Calls = { created: [], read: 0, ids: 0 };
    const id = addJob(m, "new_party", PARTY_PAYLOAD);
    await agent(m, calls).runOnce(1);
    ok("an approved party succeeds", m.rows.get(id)!.state === "succeeded" && calls.created[0]?.kind === "new_party");
  }
  {
    const m = memErpQueue({ secondMs: 10 }); const calls: Calls = { created: [], read: 0, ids: 0 };
    const id = addJob(m, "new_item", withMaster(ITEM_PAYLOAD, { hsn: "" }));
    const rep = await agent(m, calls).runOnce(1);
    const row = m.rows.get(id)!;
    ok("a refused item: failed with the plain reason, nothing created", row.state === "failed" && /no HSN code/.test(String(row.error)) && calls.created.length === 0, `${row.state} ${row.error}`);
    ok("a refused item never reached `sent`", rep.results[0]?.outcome === "failed" && !JSON.stringify(row.result).includes("\"stage\":\"done\""));
  }
  {
    const m = memErpQueue({ secondMs: 10 }); const calls: Calls = { created: [], read: 0, ids: 0 };
    const id = addJob(m, "new_item", ITEM_PAYLOAD);
    const a = agent(m, calls, { createMaster: async () => ({ ok: false, stage: "item", unitMade: true, reason: 'The unit "ZZUNIT" was made, but the item was not. Tally did not make the item "ZZ TEST RIM 29 X 2.1": EXCEPTIONS=1.', masterId: null }) });
    await a.runOnce(1);
    const row = m.rows.get(id)!;
    ok("Tally refuses the item after the unit: failed, the reason says the unit stays", row.state === "failed" && /unit "ZZUNIT" was made, but the item was not/.test(String(row.error)));
    ok("the report says the unit WAS made, never that it was not (error text and result flag)", !/unit[^.]*was not made/i.test(String(row.error)) && JSON.stringify(row.result).includes("unit_made"), `${row.error} ${JSON.stringify(row.result)}`);
  }
  {
    // D-M.258 item 1: the resend of that job re-plans from FRESH masters. The unit is in Tally now, so only the item is made.
    const m = memErpQueue({ secondMs: 10 }); const calls: Calls = { created: [], read: 0, ids: 0 };
    const id1 = addJob(m, "new_item", ITEM_PAYLOAD);
    let attempt = 0;
    const withUnit = (): TallyMasters => { const x = masters(); x.units.add("ZZUNIT"); return x; };
    const a = agent(m, calls, {
      createMaster: async (_c, plan) => {
        calls.created.push(plan);
        if (++attempt === 1) return { ok: false, stage: "item", unitMade: true, reason: 'The unit "ZZUNIT" was made, but the item was not. Tally did not make the item "ZZ TEST RIM 29 X 2.1": EXCEPTIONS=1.', masterId: null } satisfies MasterOutcome;
        return { ok: true, stage: "item", unitMade: false, reason: "Made and read back: unit ZZUNIT, IGST 18%, HSN 87149290.", masterId: "4242", readBack: { igst: "18" } } satisfies MasterOutcome;
      },
    }, () => (attempt === 0 ? masters() : withUnit()));
    await a.runOnce(1);
    const first = calls.created[0] as Extract<MasterPlan, { kind: "new_item" }>;
    const readsBefore = calls.read;
    const id2 = addJob(m, "new_item", ITEM_PAYLOAD);
    m.rows.get(id2)!.resend_of = id1;
    await a.runOnce(1);
    const second = calls.created[1] as Extract<MasterPlan, { kind: "new_item" }>;
    ok("the first attempt planned a new unit and the item", first.unit?.name === "ZZUNIT");
    ok("the resend read the masters again (fresh), not the first attempt's plan", calls.read > readsBefore);
    ok("the resend plans the ITEM ONLY: the unit the first attempt made is in Tally now, so it is not made again", second && second.unit === null && second.item.name === "ZZ TEST RIM 29 X 2.1", JSON.stringify(second?.unit));
    ok("the resend succeeds with the master's id", m.rows.get(id2)!.state === "succeeded" && m.rows.get(id2)!.master_id === "4242", m.rows.get(id2)!.state);
  }
  {
    const m = memErpQueue({ secondMs: 10 }); const calls: Calls = { created: [], read: 0, ids: 0 };
    const id = addJob(m, "new_item", ITEM_PAYLOAD);
    const a = agent(m, calls, { createMaster: async () => ({ ok: false, stage: "item", reason: "The item was made and read back, but Tally gave no id for it. A person must check it in Tally.", masterId: null, madeUnproven: true }) });
    await a.runOnce(1);
    ok("made but not proven (no id): uncertain, never failed", m.rows.get(id)!.state === "uncertain");
  }
  {
    const m = memErpQueue({ secondMs: 10 }); const calls: Calls = { created: [], read: 0, ids: 0 };
    const id = addJob(m, "new_item", ITEM_PAYLOAD);
    // The reply is lost, but Tally now shows the item exactly as asked.
    const after = masters();
    after.items.set("ZZ TEST RIM 29 X 2.1", { name: "ZZ TEST RIM 29 X 2.1", parent: G_PARTS, baseUnit: "ZZUNIT", denominator: 1, closingRate: 0, closingStock: 0, gstRate: 18, cgstRate: 9, sgstRate: 9, igstRate: 18,
      gstRevisions: [{ from: "2026-04-01", rate: 18, cgst: 9, sgst: 9, igst: 18, taxability: "Taxable" }], hsnRevisions: [{ from: "2026-04-01", code: "87149290", description: "" }], gstRateSource: "Item" } as unknown as MasterItem);
    after.units.add("ZZUNIT");
    let read = 0;
    const a = agent(m, calls, { createMaster: async () => { throw new Error("Tally reset the connection"); } }, () => (++read === 1 ? masters() : after));
    const rep = await a.runOnce(1);
    const row = m.rows.get(id)!;
    ok("a reply lost after Tally made it: settled succeeded by reading the masters, with the id", row.state === "succeeded" && row.master_id === "4243" && /exactly as asked/.test(rep.results[0]?.detail ?? ""), `${row.state} ${row.master_id} ${rep.results[0]?.detail}`);
    ok("it was not made a second time", calls.created.length === 0);
  }
  {
    const m = memErpQueue({ secondMs: 10 }); const calls: Calls = { created: [], read: 0, ids: 0 };
    const id = addJob(m, "new_item", ITEM_PAYLOAD);
    const a = agent(m, calls, { createMaster: async () => { throw new Error("Tally reset the connection"); } });   // the masters never show it
    await a.runOnce(1);
    ok("a reply lost and the masters do not show it: uncertain, a person checks", m.rows.get(id)!.state === "uncertain" && /not found in Tally/.test(String(m.rows.get(id)!.error)));
  }
  {
    const m = memErpQueue({ secondMs: 10 }); const calls: Calls = { created: [], read: 0, ids: 0 };
    const id = addJob(m, "new_item", ITEM_PAYLOAD);
    const a = agent(m, calls, { masters: undefined, createMaster: undefined });
    await a.runOnce(1);
    ok("an agent with no master worker fails the job plainly and pushes nothing", m.rows.get(id)!.state === "failed" && /cannot make new items or parties yet/.test(String(m.rows.get(id)!.error)));
  }
  {
    const m = memErpQueue({ secondMs: 10 }); const calls: Calls = { created: [], read: 0, ids: 0 };
    const id = addJob(m, "new_item", withMaster(ITEM_PAYLOAD, { name: "RIM WITHOUT THE TEST MARK" }));
    const a = agent(m, calls);
    await a.runOnce(1);
    ok("on the sandbox a master without ZZ TEST in its name is refused before Tally (default rule)", m.rows.get(id)!.state === "failed" && /does not start with ZZ TEST/.test(String(m.rows.get(id)!.error)) && calls.read === 0);
  }
  {
    const m = memErpQueue({ secondMs: 10 }); const calls: Calls = { created: [], read: 0, ids: 0 };
    const id = addJob(m, "new_item", ITEM_PAYLOAD);
    const a = agent(m, calls, { masters: async () => { throw new Error("Tally timeout"); } });
    await a.runOnce(1);
    ok("masters that cannot be read: failed, nothing sent, says to send again", m.rows.get(id)!.state === "failed" && /send it again when Tally answers/.test(String(m.rows.get(id)!.error)) && calls.created.length === 0);
  }

  console.log("\n  D-M.263 item 3: a pin refusal after the unit was made says the unit WAS made");
  {
    const { PinRefused } = await import("../src/services/primaryMode.js");
    const refuse = (unit: string | null) => async () => { const e = new PinRefused("refused: the company open in Tally is not the pinned one.", false); if (unit) e.unitMade = unit; throw e; };
    const m1 = memErpQueue({ secondMs: 10 }); const c1: Calls = { created: [], read: 0, ids: 0 };
    const id1 = addJob(m1, "new_item", ITEM_PAYLOAD);
    await agent(m1, c1, { createMaster: refuse("ZZUNIT") }).runOnce(1);
    const r1 = m1.rows.get(id1)!;
    ok("unit made, then the pin refused the item: failed, the note says the unit WAS made and the item was not", r1.state === "failed" && /unit "ZZUNIT" WAS made in Tally/.test(String(r1.error)), `${r1.state}: ${r1.error}`);
    ok("the result carries sent_to_tally false for the item and unit_made true with the unit's name", (r1.result as any)?.sent_to_tally === false && (r1.result as any)?.unit_made === true && (r1.result as any)?.unit === "ZZUNIT", JSON.stringify(r1.result));
    const m2 = memErpQueue({ secondMs: 10 }); const c2: Calls = { created: [], read: 0, ids: 0 };
    const id2 = addJob(m2, "new_item", ITEM_PAYLOAD);
    await agent(m2, c2, { createMaster: refuse(null) }).runOnce(1);
    const r2 = m2.rows.get(id2)!;
    ok("nothing made before the refusal: no unit note, no unit_made", r2.state === "failed" && !/WAS made/.test(String(r2.error)) && (r2.result as any)?.unit_made === undefined, `${r2.error} ${JSON.stringify(r2.result)}`);
    const src = (await import("node:fs")).readFileSync(new URL("../src/services/masterJobs.ts", import.meta.url), "utf8");
    ok("createMasterJob marks the pin refusal with the unit it had made (the item request is wrapped after the unit)", /if \(unitMade && e instanceof PinRefused\) e\.unitMade = plan\.unit!\.name/.test(src));
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
