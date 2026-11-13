/**
 * JOB: the queue jobs of kind `new_item` and `new_party` (D-M.206, web task 8-3, D-8-3.24): make one stock item (and its new unit, first) or one
 * party ledger in Tally, read it back field by field, and report a plain reason when it cannot be done.
 *
 * The request shape is the one pinned in the web app's `contracts/new-item-twins.json` and built by `buildNewItemPayload` / `buildSupplierPayload`:
 *   new_item   payload.master = { name, parent (stock group), baseUnit, gstRate, hsn, taxability }
 *              payload.new_unit = { name, decimals } | null   (made first, only when set)
 *   new_party  payload.master = { name, parent, state, gstin | null, gstRegistrationType }
 * Everything else in the payload (label, facts, pack, rates in paise, bill_keys) is for the web pages and is not read here.
 *
 * Three parts, all kept apart so each can be tested without Tally:
 *   planMasterJob    PURE. Reads the payload and a snapshot of Tally's masters and either says what to make, or says in plain words why not.
 *                    Everything Tally would refuse is refused here, before anything is sent: a unit Tally does not have (and none to make), a missing
 *                    GST rate or HSN, a stock group that is not there, a name that already exists, a party with no state or a bad GSTIN.
 *   createMasterJob  the writes: `createUnit` then `createStockItem` (each reads its own work back; the item's read-back proves the IGST rate and
 *                    the HSN stuck), or `createLedger` (its read-back proves state and GSTIN stuck). Then one read of the new master's MASTERID, because
 *                    the queue refuses to call a job succeeded without one.
 *   settleMasterJob  PURE. For a job whose reply was lost: does the snapshot show the master exactly as the plan says?
 *
 * No voucher is touched. The writes go through masterPusher, which sends through `tallyPost` and refuses a company the role does not allow.
 */
import { tallyPost } from "../tally.js";
import { PinRefused } from "./primaryMode.js";
import { escapeXml, readTag } from "./xml.js";
import { blocksOf } from "./tallyRequest.js";
import { createLedger, createStockItem, createUnit, isValidUnitName, type NewLedger, type NewStockItem, type NewUnit } from "./masterPusher.js";
import { gstRateFor, hsnFor, type TallyMasters } from "./tallyMasters.js";
import { isGstinChecksumValid } from "./gstIdentity.js";

export const MASTER_KINDS = ["new_item", "new_party"] as const;
export type MasterKind = (typeof MASTER_KINDS)[number];
export const isMasterKind = (k: string | null | undefined): k is MasterKind => !!k && (MASTER_KINDS as readonly string[]).includes(k);

export type MasterPlan =
  | { kind: "new_item"; label: string; unit: NewUnit | null; item: NewStockItem }
  | { kind: "new_party"; label: string; ledger: NewLedger };

export type PlanResult = { ok: true; plan: MasterPlan } | { ok: false; reason: string };

const loose = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
const text = (v: unknown): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Tally's own words for how an item is taxed; the web sends "Taxable". */
const TAXABILITY = ["Taxable", "Exempt", "Nil Rated"] as const;
/** An HSN or SAC code: digits only, four to eight of them. */
const HSN_RE = /^\d{4,8}$/;

const hasKey = (m: Map<string, unknown>, name: string): string | null => {
  if (m.has(name)) return name;
  const want = loose(name);
  for (const k of m.keys()) if (loose(k) === want) return k;
  return null;
};

/**
 * What to make, or why not. `m` is a FRESH read of the company's masters (the caller forces a reload: a cached copy could miss a name
 * made a minute ago). `today` is the ISO day the GST rate is judged on.
 */
export function planMasterJob(kind: string, payload: unknown, m: TallyMasters, opts: { allowExisting?: boolean } = {}): PlanResult {
  if (!isMasterKind(kind)) return { ok: false, reason: `This agent does not know the kind of work "${kind}".` };
  const p = isObj(payload) ? payload : {};
  const master = isObj(p.master) ? p.master : null;
  if (!master) return { ok: false, reason: `The request has no details to make (nothing under "master"). Nothing was sent to Tally.` };
  const label = text(p.label) || text(master.name);
  return kind === "new_item" ? planItem(label, master, p.new_unit, m, !!opts.allowExisting) : planParty(label, master, m, !!opts.allowExisting);
}

function planItem(label: string, master: Record<string, unknown>, newUnitRaw: unknown, m: TallyMasters, allowExisting: boolean): PlanResult {
  const name = text(master.name), parent = text(master.parent), baseUnit = text(master.baseUnit);
  const refuse = (why: string): PlanResult => ({ ok: false, reason: `${why} Nothing was sent to Tally.` });
  if (!name) return refuse("The item has no name.");
  if (!parent) return refuse(`"${name}" has no stock group.`);
  if (!baseUnit) return refuse(`"${name}" has no unit.`);
  const rate = master.gstRate;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 100) return refuse(`"${name}" has no GST rate. Tally would make the item without tax, and every bill with it would be wrong.`);
  const hsn = text(master.hsn);
  if (!hsn) return refuse(`"${name}" has no HSN code. Choose one before it is sent.`);
  if (!HSN_RE.test(hsn)) return refuse(`The HSN code "${hsn}" for "${name}" is not 4 to 8 digits.`);
  const tax = master.taxability === undefined || master.taxability === null ? "Taxable" : String(master.taxability);
  if (!(TAXABILITY as readonly string[]).includes(tax)) return refuse(`"${tax}" is not a way Tally taxes an item (Taxable, Exempt or Nil Rated).`);

  const clash = hasKey(m.items, name);
  if (clash && !allowExisting) return refuse(`An item called "${clash}" is already in Tally.`);
  const group = hasKey(m.stockGroups, parent);
  if (!group) return refuse(`The stock group "${parent}" is not in Tally. This page cannot make a group; add it in Tally first.`);

  // The unit: already in Tally, or made first (only when the request says so and the symbol is one Tally accepts).
  const existingUnit = [...m.units].find((u) => u === baseUnit) ?? [...m.units].find((u) => loose(u) === loose(baseUnit)) ?? null;
  let unit: NewUnit | null = null;
  if (!existingUnit) {
    const nu = isObj(newUnitRaw) ? newUnitRaw : null;
    if (!nu) return refuse(`The unit "${baseUnit}" is not in Tally, and the request does not ask to make it.`);
    const nuName = text(nu.name);
    if (nuName !== baseUnit) return refuse(`The request makes a new unit "${nuName}" but the item uses "${baseUnit}".`);
    if (!isValidUnitName(nuName)) return refuse(`"${nuName}" cannot be a unit in Tally: a unit symbol is letters only, up to 20 (Tally answers BAD UNIT NAME for digits or spaces).`);
    const dec = typeof nu.decimals === "number" && Number.isInteger(nu.decimals) && nu.decimals >= 0 && nu.decimals <= 6 ? nu.decimals : 0;
    unit = { name: nuName, decimals: dec };
  }
  const item: NewStockItem = { name, parent: group, baseUnit: existingUnit ?? baseUnit, gstRate: rate, hsn, taxability: tax as NewStockItem["taxability"] };
  return { ok: true, plan: { kind: "new_item", label, unit, item } };
}

function planParty(label: string, master: Record<string, unknown>, m: TallyMasters, allowExisting: boolean): PlanResult {
  const name = text(master.name), parent = text(master.parent), state = text(master.state);
  const refuse = (why: string): PlanResult => ({ ok: false, reason: `${why} Nothing was sent to Tally.` });
  if (!name) return refuse("The party has no name.");
  if (!parent) return refuse(`"${name}" has no ledger group.`);
  if (!state) return refuse(`"${name}" has no state. Without it every bill to the party lands in a GST exception.`);
  const clash = hasKey(m.ledgers, name);
  if (clash && !allowExisting) return refuse(`A ledger called "${clash}" is already in Tally.`);
  // A group is known by the ledgers that sit in it. SUNDRY CREDITORS has hundreds; a group nobody uses yet cannot be told apart from a typo.
  const groups = new Set([...m.ledgers.values()].map((l) => loose(l.parent)));
  if (!groups.has(loose(parent))) return refuse(`The ledger group "${parent}" is not one Tally has ledgers in. Check the spelling, or add the group in Tally first.`);
  const realParent = [...m.ledgers.values()].find((l) => loose(l.parent) === loose(parent))!.parent;
  const gstinRaw = master.gstin === null || master.gstin === undefined ? "" : String(master.gstin).trim().toUpperCase();
  if (gstinRaw && !isGstinChecksumValid(gstinRaw)) return refuse(`The GSTIN "${gstinRaw}" for "${name}" does not pass the GST check digit.`);
  const reg = text(master.gstRegistrationType) || (gstinRaw ? "Regular" : "Unregistered");
  if (!["Regular", "Composition", "Unregistered", "Consumer"].includes(reg)) return refuse(`"${reg}" is not a GST registration type Tally knows.`);
  if (reg !== "Unregistered" && reg !== "Consumer" && !gstinRaw) return refuse(`"${name}" is marked ${reg} but has no GSTIN.`);
  const ledger: NewLedger = { name, parent: realParent, state, country: "India", gstin: gstinRaw || undefined, gstRegistrationType: reg };
  return { ok: true, plan: { kind: "new_party", label, ledger } };
}

// ── Does Tally already hold exactly this? (a job whose reply was lost) ────────────────────────────────────────────────

export type SettleVerdict = { state: "present"; detail: string } | { state: "absent"; detail: string } | { state: "differs"; detail: string };

/** `today` is the ISO day the item's GST is read on. A fresh read of the masters is expected. */
export function settleMasterJob(plan: MasterPlan, m: TallyMasters, today: string): SettleVerdict {
  if (plan.kind === "new_item") {
    const key = hasKey(m.items, plan.item.name);
    if (!key) return { state: "absent", detail: `no item called "${plan.item.name}" in Tally` };
    const it = m.items.get(key)!;
    const rate = gstRateFor(m, key, today).rate, hsn = hsnFor(m, key, today).code;
    const bad: string[] = [];
    if (loose(it.baseUnit) !== loose(plan.item.baseUnit)) bad.push(`unit "${it.baseUnit}" (asked "${plan.item.baseUnit}")`);
    if (Math.abs(rate - plan.item.gstRate) > 0.001) bad.push(`GST ${rate} (asked ${plan.item.gstRate})`);
    if (plan.item.hsn && hsn !== plan.item.hsn) bad.push(`HSN "${hsn}" (asked "${plan.item.hsn}")`);
    return bad.length ? { state: "differs", detail: `"${key}" is in Tally with ${bad.join(", ")}` } : { state: "present", detail: `"${key}" is in Tally exactly as asked` };
  }
  const key = hasKey(m.ledgers, plan.ledger.name);
  if (!key) return { state: "absent", detail: `no ledger called "${plan.ledger.name}" in Tally` };
  const led = m.ledgers.get(key)!;
  const bad: string[] = [];
  if (loose(led.parent) !== loose(plan.ledger.parent)) bad.push(`group "${led.parent}" (asked "${plan.ledger.parent}")`);
  if (loose(led.state) !== loose(plan.ledger.state)) bad.push(`state "${led.state}" (asked "${plan.ledger.state}")`);
  if ((plan.ledger.gstin ?? "") !== (led.gstin ?? "").toUpperCase()) bad.push(`GSTIN "${led.gstin}" (asked "${plan.ledger.gstin ?? ""}")`);
  return bad.length ? { state: "differs", detail: `"${key}" is in Tally with ${bad.join(", ")}` } : { state: "present", detail: `"${key}" is in Tally exactly as asked` };
}

// ── The writes ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MasterOutcome {
  ok: boolean;
  /** "unit", "item" or "ledger": where it stopped, or what was last written. */
  stage: string;
  /** Plain words, always set: what happened. */
  reason: string;
  masterId: string | null;
  /** True when the unit was made and then the item was not (the unit stays; a send again sees it and skips it). */
  unitMade?: boolean;
  /** True when the master was made in Tally but could not be proven (no id, or the read-back showed something else): a person must look, it is not simply "failed". */
  madeUnproven?: boolean;
  readBack?: Record<string, string>;
}

const said = (r: { notes: string[]; lineErrors: string[] }): string => [...r.notes, ...r.lineErrors].filter(Boolean).join("; ").slice(0, 400);

/** The MASTERID of one master by name; null when Tally does not show it. */
export async function readMasterId(tallyUrl: string, company: string, type: "StockItem" | "Ledger", name: string): Promise<string | null> {
  const id = `MjId${type}`;
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${id}</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="${id}" ISMODIFY="No"><TYPE>${type}</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>MasterId</NATIVEMETHOD>
<FILTER>${id}F</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="${id}F">$Name = "${escapeXml(name)}"</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw: string = await tallyPost(tallyUrl, xml, 30_000, true);
  const block = blocksOf(raw, type.toUpperCase())[0] ?? "";
  const mid = readTag(block, "MASTERID");
  return /^\d{1,18}$/.test(mid) ? mid : null;
}

/**
 * Make what the plan says. Each builder reads its own work back (the item: IGST rate and HSN; the ledger: state and GSTIN), and only then is the
 * MASTERID read. Never throws for a refusal by Tally: that comes back as `ok: false` with Tally's own words. A thrown error (no answer) is the caller's.
 */
export async function createMasterJob(tallyUrl: string, company: string, plan: MasterPlan): Promise<MasterOutcome> {
  if (plan.kind === "new_party") {
    const r = await createLedger(tallyUrl, company, plan.ledger);
    if (!r.ok) return { ok: false, stage: "ledger", reason: `Tally did not make the party "${plan.ledger.name}": ${said(r) || "no reason given"}.`, masterId: null };
    const id = await readMasterId(tallyUrl, company, "Ledger", plan.ledger.name);
    const rb = { state: r.readBack?.state ?? "", gstin: r.readBack?.gstin ?? "", parent: r.readBack?.parent ?? "" };
    if (!id) return { ok: false, stage: "ledger", reason: `The party "${plan.ledger.name}" was made and read back, but Tally gave no id for it. A person must check it in Tally.`, masterId: null, readBack: rb, madeUnproven: true };
    return { ok: true, stage: "ledger", reason: `Made and read back: state ${rb.state}${rb.gstin ? `, GSTIN ${rb.gstin}` : ", no GSTIN"}, group ${rb.parent}.`, masterId: id, readBack: rb };
  }
  let unitMade = false;
  if (plan.unit) {
    const u = await createUnit(tallyUrl, company, plan.unit);
    if (!u.ok) return { ok: false, stage: "unit", reason: `Tally did not make the unit "${plan.unit.name}": ${said(u) || "no reason given"}. The item was not tried.`, masterId: null };
    unitMade = true;
  }
  let r: Awaited<ReturnType<typeof createStockItem>>;
  try { r = await createStockItem(tallyUrl, company, plan.item); }
  catch (e) {
    /* D-M.263 item 3: the unit is already in Tally; a pin refusal of the item must say so, never "nothing reached Tally". */
    if (unitMade && e instanceof PinRefused) e.unitMade = plan.unit!.name;
    throw e;
  }
  if (!r.ok) {
    const lead = unitMade ? `The unit "${plan.unit!.name}" was made, but the item was not. ` : "";
    return { ok: false, stage: "item", unitMade, reason: `${lead}Tally did not make the item "${plan.item.name}": ${said(r) || "no reason given"}.`, masterId: null, readBack: r.readBack ? { ...r.readBack } : undefined };
  }
  const id = await readMasterId(tallyUrl, company, "StockItem", plan.item.name);
  const rb = { baseUnit: r.readBack?.baseUnit ?? "", igst: r.readBack?.igst ?? "", hsn: r.readBack?.hsn ?? "" };
  if (!id) return { ok: false, stage: "item", unitMade, reason: `The item "${plan.item.name}" was made and read back, but Tally gave no id for it. A person must check it in Tally.`, masterId: null, readBack: rb, madeUnproven: true };
  return { ok: true, stage: "item", unitMade, reason: `${unitMade ? `Unit "${plan.unit!.name}" made first. ` : ""}Made and read back: unit ${rb.baseUnit}, IGST ${rb.igst}%, HSN ${rb.hsn}.`, masterId: id, readBack: rb };
}

/**
 * The sandbox rule for a master job (the voucher rule asks for a ZZTEST number and narration, which a master does not have): a test job is
 * made only on a sandbox machine, in the practice company, and only when the label and the master's own name say ZZ TEST (a test unit: ZZ then letters).
 */
export function masterTestRefusal(job: { company: string; label: string; payload: unknown }, env: NodeJS.ProcessEnv = process.env): string | null {
  if ((env.MKCP_TALLY_ROLE ?? "").trim().toLowerCase() !== "sandbox") return "refused: not a sandbox machine";
  const practice = (env.MKCP_PRACTICE_COMPANY ?? "").trim();
  if (!practice || job.company.trim() !== practice) return "refused: the job's company is not the practice company";
  if (!String(job.label ?? "").startsWith("ZZ TEST")) return "refused: the job is not labelled ZZ TEST";
  const p = isObj(job.payload) ? job.payload : {};
  const master = isObj(p.master) ? p.master : {};
  if (!text(master.name).startsWith("ZZ TEST")) return "refused: the name to make does not start with ZZ TEST";
  const nu = isObj(p.new_unit) ? p.new_unit : null;
  if (nu && !text(nu.name).toUpperCase().startsWith("ZZ")) return "refused: a test unit must start with ZZ";
  return null;
}
