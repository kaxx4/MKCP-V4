/**
 * JOB: the live half of the T11 rigs: everything that talks to the dummy Tally, through the same three gates
 * production uses (tallyPost, pushGuard, safePush). Imported only by rigs that have already called
 * `guardScriptWrites` and `preflight()`.
 *
 *   - one-voucher reads (every stored field), by number or by narration
 *   - the census (how many vouchers, how many are ours) before and after every rig
 *   - push / alter / cancel / delete a payload by REMOTEID through safePush
 *   - ZZ TEST masters made with the production builders, removed afterwards
 *   - the sweep (a backstop; a rig deletes what it made by REMOTEID first)
 *   - the rig recorder and its exit rule (exactly the expected number passed, none failed)
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tallyPost } from "../../../src/tally.js";
import { safePush, type SafePushResult } from "../../../src/services/safePush.js";
import { createLedger, deleteLedger, createStockItem, deleteStockItem, type NewLedger, type NewStockItem } from "../../../src/services/masterPusher.js";
import { loadMasters, invalidateMasters, type TallyMasters } from "../../../src/services/tallyMasters.js";
import { escapeXml, tdlString, tallyDateInt } from "../../../src/services/xml.js";
import { pull as pullAll } from "../../find-stranded-test-vouchers.js";
import { rigExitCode, type RigCheck } from "../rigExit.js";
import type { VoucherPayload } from "../../../src/types.js";
import type { Preflight } from "./t11.js";
import type { ZzItem, ZzParty } from "./t11Kit.js";

const here = dirname(fileURLToPath(import.meta.url));
const post = (url: string, xml: string, ms = 180_000) => tallyPost(url, xml, ms, true) as Promise<string>;

export interface Live { url: string; company: string; day: string; stamp: string }
export const makeLive = (p: Preflight, day: string, stamp: string): Live => ({ url: p.tallyUrl, company: p.company, day, stamp });

export const indiaToday = (): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

/** The recorder: each check is a line in the report, and the exit code is the rule from rigExit.ts. */
export class Recorder {
  readonly checks: RigCheck[] = [];
  readonly notes: string[] = [];
  constructor(readonly rig: string, readonly expected: number) {}
  check(name: string, ok: boolean, detail = ""): boolean {
    this.checks.push({ name, ok, detail });
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
    return ok;
  }
  note(s: string): void { this.notes.push(s); console.log(`  note  ${s}`); }
  get passed(): number { return this.checks.filter((c) => c.ok).length; }
  get failed(): number { return this.checks.length - this.passed; }
  /** Prints the summary line the evidence files quote, writes the report, and returns the exit code. */
  finish(out?: string): number {
    const code = rigExitCode(this.checks, this.expected);
    const short = this.passed < this.expected && this.failed === 0 ? `; only ${this.passed} of the ${this.expected} expected checks ran and passed` : "";
    console.log(`\n  ${this.rig}: ${this.passed} passed, ${this.failed} failed${short}`);
    if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify({ rig: this.rig, expected: this.expected, passed: this.passed, failed: this.failed, checks: this.checks, notes: this.notes, at: new Date().toISOString() }, null, 2)); }
    return code;
  }
}

/** The whole stored voucher (every stored scalar plus the entry lists) for one number or narration on one day, or null. */
export async function readStored(l: Live, day: string, by: { number?: string; narration?: string; type?: string }): Promise<string | null> {
  const stamp = tallyDateInt(day);
  const conds = [`(($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${stamp})`];
  if (by.number) conds.push(`$VoucherNumber = ${tdlString(by.number)}`);
  if (by.narration) conds.push(`$Narration = ${tdlString(by.narration)}`);
  if (by.type) conds.push(`$VoucherTypeName = ${tdlString(by.type)}`);
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>T11Read</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${escapeXml(l.company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="T11Read" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>*</NATIVEMETHOD><NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD><NATIVEMETHOD>LedgerEntries</NATIVEMETHOD>
<NATIVEMETHOD>AllInventoryEntries</NATIVEMETHOD><NATIVEMETHOD>EWayBillDetails</NATIVEMETHOD>
<FILTER>T11ReadF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="T11ReadF">${conds.join(" AND ")}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw = await post(l.url, xml);
  /* Real voucher blocks only: the reply also carries a count element <VOUCHER>105</VOUCHER> (5-Nov-2026). */
  const all = [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]).filter((b) => b.includes("<VOUCHERTYPENAME>"));
  return all.length ? all.join("\n") : null;
}

/** How many stored vouchers does `readStored` find for this key? (A duplicate shows up here.) */
export const countStored = async (l: Live, day: string, by: Parameters<typeof readStored>[2]): Promise<number> => {
  const v = await readStored(l, day, by);
  return v ? (v.match(/<VOUCHERTYPENAME>/g) ?? []).length : 0;
};

/** Total vouchers in the books and how many look like ours (the trimmed read the census uses). */
export async function census(l: Live): Promise<{ total: number; ours: number; mine: number }> {
  const all = await pullAll(l.company);
  const isOurs = (v: { number: string; narration: string }) => /^ZZTEST\d*\//.test(v.number) || /^ZZTEST\d+/.test(v.narration);
  const mark = `ZZTEST${l.stamp}`;
  return { total: all.length, ours: all.filter(isOurs).length, mine: all.filter((v) => v.number.startsWith(mark) || v.narration.includes(mark)).length };
}

/** safePush as production calls it (all three gates). */
export const push = (l: Live, p: VoucherPayload, opts: { verify?: boolean } = {}): Promise<SafePushResult> => safePush(l.url, l.company, p, opts);

/** How a voucher is found again: by number, except a Journal (the Journal type is numbered "None", so Tally keeps no number): by its narration. */
export const byKey = (p: VoucherPayload): { number?: string; narration?: string; type: string } =>
  p.voucherNumber && !/^journal$/i.test(p.voucherType) ? { number: p.voucherNumber, type: p.voucherType } : { narration: p.narration, type: p.voucherType };

/** The payload that undoes `p`: same REMOTEID, number, date and type, action Delete. */
export const asDelete = (p: VoucherPayload): VoucherPayload => ({ ...p, action: "Delete" } as VoucherPayload);
export const asCancel = (p: VoucherPayload): VoucherPayload => ({ ...p, action: "Cancel" } as VoucherPayload);
export const asAlter = (p: VoucherPayload, patch: Partial<VoucherPayload> = {}): VoucherPayload => ({ ...p, ...patch, action: "Alter" } as VoucherPayload);

/** Delete a voucher this rig made. True when Tally said it is gone and the read finds none. */
export async function remove(l: Live, p: VoucherPayload): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await push(l, asDelete(p), { verify: false });
    const left = await countStored(l, p.date, byKey(p));
    /* Judge by the books (G7/P1): gone is gone, whether or not Tally had it to delete. */
    return { ok: left === 0, detail: r.ok ? `${left} left` : `${left} left (delete said: ${(r.errors[0] ?? "refused").slice(0, 90)})` };
  } catch (e) { return { ok: false, detail: (e as Error).message.slice(0, 120) }; }
}

/** The sweep as a backstop (it deletes only ZZTEST numbers whose narration carries ZZTEST). Returns its exit code. */
export function sweepDay(day: string): number {
  const tsx = join(here, "..", "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
  const r = spawnSync(process.execPath, [tsx, join(here, "..", "..", "sweep-test-vouchers.ts"), "ZZTEST", day, "--yes"], { encoding: "utf8", env: process.env, timeout: 600_000 });
  return r.status ?? 1;
}

// ── ZZ TEST masters, with the production builders ────────────────────────────

export function ledgerOf(p: ZzParty): NewLedger {
  return { name: p.name, parent: p.parent, state: p.state, country: "India", pincode: p.pincode, address: p.address, gstin: p.gstin || undefined,
    gstRegistrationType: p.gstRegistrationType, billWise: p.billWise !== false };
}

export async function makeParty(l: Live, p: ZzParty): Promise<{ ok: boolean; detail: string }> {
  const r = await createLedger(l.url, l.company, ledgerOf(p));
  return { ok: r.ok, detail: r.ok ? (r.notes[0] ?? "") : [...r.notes, ...r.lineErrors].join("; ").slice(0, 200) };
}
export async function makeItem(l: Live, i: ZzItem): Promise<{ ok: boolean; detail: string }> {
  const item: NewStockItem = { name: i.name, parent: i.parent, baseUnit: i.baseUnit, gstRate: i.gstRate, hsn: i.hsn };
  const r = await createStockItem(l.url, l.company, item);
  return { ok: r.ok, detail: r.ok ? (r.notes[0] ?? "") : [...r.notes, ...r.lineErrors].join("; ").slice(0, 200) };
}
export async function dropParty(l: Live, name: string): Promise<{ ok: boolean; detail: string }> {
  const r = await deleteLedger(l.url, l.company, name);
  return { ok: r.ok, detail: r.ok ? "deleted" : r.notes.join("; ").slice(0, 160) };
}
export async function dropItem(l: Live, name: string): Promise<{ ok: boolean; detail: string }> {
  const r = await deleteStockItem(l.url, l.company, name);
  return { ok: r.ok, detail: r.ok ? "deleted" : r.notes.join("; ").slice(0, 160) };
}

/** Fresh masters (the cache can be ten minutes old). */
export const freshMasters = async (l: Live): Promise<TallyMasters> => { invalidateMasters(); return loadMasters(l.url, l.company, { force: true }); };

export const stampFrom = (): string => Date.now().toString().slice(-6);

/**
 * The request that reads one ledger's bill-wise flag (and parent) from Tally. Same shape as masterPusher's
 * `MpRead` (a named Ledger collection filtered by name, header ID equal to the collection name), so it
 * cannot raise the wrong-id modal. Exported so the offline test can look at the bytes.
 */
export function ledgerFlagsXml(company: string, name: string): string {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>T11LedFlags</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="T11LedFlags" ISMODIFY="No"><TYPE>Ledger</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>Parent</NATIVEMETHOD><NATIVEMETHOD>IsBillWiseOn</NATIVEMETHOD>
<FILTER>T11LedFlagsF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="T11LedFlagsF">$Name = ${tdlString(name)}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

/** What Tally holds for one ledger: its parent group and whether it is bill-by-bill. Null when no such ledger. Never assumed. */
export async function readLedgerFlags(l: Live, name: string): Promise<{ parent: string; billWise: boolean | null; raw: string } | null> {
  const raw = await post(l.url, ledgerFlagsXml(l.company, name), 60_000);
  const block = [...raw.matchAll(/<LEDGER\b[^>]*>[\s\S]*?<\/LEDGER>/g)].map((m) => m[0]).find((b) => b.includes("<PARENT"));
  if (!block) return null;
  const f = (t: string) => (new RegExp(`<${t}[^>]*>([^<]*)</${t}>`, "i").exec(block)?.[1] ?? "").replace(/&#4;\s*/g, "").trim();
  const bw = f("ISBILLWISEON");
  return { parent: f("PARENT"), billWise: /^yes$/i.test(bw) ? true : /^no$/i.test(bw) ? false : null, raw: block.slice(0, 400) };
}
