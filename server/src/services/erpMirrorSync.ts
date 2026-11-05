/**
 * JOB: the ERP mirror sync (rebuild task 1-5, first half, 5-Nov-2026; review
 * fixes 6-Nov-2026, migration 0118).
 *
 * Reads vouchers from Tally into a staging table, then asks the database to
 * swap them into the mirror in one transaction (migrations 0116 to 0118). Every run and
 * every step is written to `erp_sync_runs` / `erp_sync_run_steps`. The
 * high-water mark (the highest voucher AlterID the mirror is known to hold) is
 * kept per company, so an incremental run reads only what changed since.
 *
 * ── What this does NOT touch ──────────────────────────────────────────────
 * Today's sync (`syncOrchestrator.ts`, `supabaseSync.ts`, the tally_* tables)
 * is unchanged and does not import this file. Nothing in `index.ts` starts it,
 * so the office agent runs exactly as before. The database refuses every
 * machine but the sandbox laptop until go-live (`erp_sync_control` live_mirror),
 * and the sandbox only for a ZZTEST company key, as test rows, into the ERP's
 * own `erp_mirror_rows`. The swap into the tally_* tables is a go-live step.
 *
 * ── The rules it keeps (lessons from 1-3 and 1-4) ─────────────────────────
 * - One Tally request at a time, one day per read (a whole-window read wedges
 *   the port). The fetch list is named field by field, no `*` (G7).
 * - An error reply is never "no vouchers": `tallyPost` throws on LINEERROR,
 *   STATUS 0 and a reply with no <DATA>; this file also requires the
 *   <COLLECTION> envelope. A failed read fails the run and the mark stays.
 * - The mark candidate is Tally's highest AlterID read BEFORE the first voucher
 *   read, so a voucher changed while the run reads is above it and is read
 *   again next time (D-1-5.4).
 * - When Tally's highest is BELOW the mark (a restore, a reload, or the newest
 *   voucher deleted), nothing can be above Tally's own highest, so an
 *   incremental would read nothing and lose what changed. It is refused before
 *   any voucher read ("needs a full run"); the database records that a full
 *   run is due, and only a full run may lower the mark (0118, D-1-5.12).
 * - A read that cannot be trusted fails the run instead of reaching the swap:
 *   a voucher with no GUID (never a made-up key, G5), a date that did not
 *   parse, a full day's read holding another day's voucher, an empty ledger
 *   placeholder line, or an accounting voucher with no ledger lines (Tally's
 *   empty .LIST placeholders in big pulls). A voucher with no lines has no
 *   ledger total (null, never 0).
 * - Test runs (the store says so; the caller cannot turn it off) store names
 *   only as `ZZ TEST <kind> <keyed hash>`: the hash is keyed with a secret
 *   derived from this machine's key, so a list of real names cannot be hashed
 *   to reverse it (D-1-5.5, review M3). The database refuses any other name on
 *   a test row.
 *
 * -- Second half, first batch (6-Nov-2026, migration 0119) ----------------
 * - Every full or incremental run also reads the ledger masters (one cheap
 *   request) with Tally's closing balance into the ERP's own
 *   erp_mirror_ledgers (M-6). A ledger list that is empty, has a ledger with
 *   no GUID or name, or a balance that does not parse fails the run; the
 *   database refuses one under 80 percent of the mirror (D-1-5.20).
 * - After every swap the database checks each succeeded ERP job against the
 *   mirror by MASTERID (A6 altered in Tally, A7 vanished, D-1-5.2).
 * - The nightly check (A11, runDayCheck): the AlterID read also fetches each
 *   voucher's GUID, and the database compares key, date and AlterID with the
 *   mirror. Each day that differs queues a one-day re-pull (kind "repull"),
 *   which keeps the mark. planMirrorWork says what to run next.
 */
import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CollectionDef } from "../types.js";
import { tallyPost } from "../tally.js";
import { buildCollectionXml, buildChangedVoucherXml } from "./xmlBuilder.js";
import { convertVouchers } from "../converters/convert.js";

/** The ERP mirror's voucher fields for this half: header, identity, ledger lines (for totals). */
export const ERP_MIRROR_VOUCHER_DEF: CollectionDef = {
  name: "erpMirrorVouchers",
  tallyCollection: "Voucher",
  metadataType: "Voucher",
  category: "transaction",
  fetch: [
    "Guid", "Date", "VoucherTypeName", "VoucherNumber", "Reference", "Narration",
    "PartyLedgerName", "IsCancelled", "IsOptional", "EffectiveDate", "AlterID", "MasterId",
    "AllLedgerEntries",
  ],
  timeout: 180_000,
  parallel: false,
};

/** Only the AlterID and date of every voucher: the cheap read for the mark (about 4 s on the live books). */
export const ERP_MIRROR_MARK_DEF: CollectionDef = {
  name: "erpMirrorMark",
  tallyCollection: "Voucher",
  metadataType: "Voucher",
  category: "transaction",
  /* Guid too (0119): the nightly check compares the mirror key by key (A11). */
  fetch: ["AlterID", "Date", "Guid"],
  timeout: 120_000,
  parallel: false,
};

/** The ledger masters with Tally's closing balance (M-6, 0119). Fields named one by one (G7), no `*`. */
export const ERP_MIRROR_LEDGER_DEF: CollectionDef = {
  name: "erpMirrorLedgers",
  tallyCollection: "Ledger",
  metadataType: "Ledger",
  category: "master",
  fetch: ["Guid", "Name", "Parent", "OpeningBalance", "ClosingBalance", "AlterID", "MasterId"],
  timeout: 120_000,
  parallel: false,
};

export interface MirrorLedgerRow {
  key: string;
  name: string;
  parent: string | null;
  closing_balance: number | null;
  opening_balance: number | null;
  alter_id: number | null;
  master_id: number | null;
  row: Record<string, unknown>;
}

/** One ledger as Tally sent it (strings), before it is checked. */
export interface TallyLedger { guid: string; name: string; parent: string; closingbalance: string; openingbalance: string; alterid: string; masterid: string }

export interface MirrorRow {
  key: string;
  master_id: number | null;
  alter_id: number | null;
  voucher_date: string | null;
  voucher_type: string | null;
  voucher_number: string | null;
  party: string | null;
  ledger_total: number | null;
  is_cancelled: boolean;
  is_optional: boolean;
  row: Record<string, unknown>;
}

const isoOf = (yyyymmdd: unknown): string | null => {
  const d = String(yyyymmdd ?? "").replace(/\D/g, "");
  return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
};
const money = (s: unknown): number => {
  const n = parseFloat(String(s ?? "0").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * One-way stand-in for a name from the dummy company, keyed with `salt` (a
 * secret), so it cannot be reversed by hashing a list of names. A name that
 * already starts with "ZZ TEST" is kept as it is.
 */
export function scrubName(kind: string, name: string | null | undefined, salt: string): string | null {
  const s = (name ?? "").trim();
  if (!s) return null;
  if (/^ZZ TEST\b/.test(s)) return s;
  if (!salt) throw new Error("refused: scrubbing a name needs this machine's secret salt");
  return `ZZ TEST ${kind} ${createHmac("sha256", salt).update(s.toUpperCase()).digest("hex").slice(0, 10)}`;
}

/** The salt for test-run names: derived from this machine's ERP key, never stored. */
export function scrubSaltFrom(machineKey: string): string {
  if (!machineKey) throw new Error("refused: no machine key, so test names cannot be scrubbed");
  return createHmac("sha256", machineKey).update("erp-mirror-scrub-v1").digest("hex");
}

/** Voucher types that always carry ledger lines (inventory-only types such as orders and notes do not). */
const ACCOUNTING_TYPE = /^(sales|purchase|receipt|payment|contra|journal|credit note|debit note)\b/i;
const NOT_ACCOUNTING = /order|delivery|receipt note|rejection|memo|stock|physical/i;
export const isAccountingType = (t: string | null) => !!t && ACCOUNTING_TYPE.test(t) && !NOT_ACCOUNTING.test(t);

/**
 * Pure: why this converted voucher cannot be trusted as read, or null. An
 * empty placeholder line (no ledger name) is what Tally sends for a big pull
 * it truncated; an accounting voucher with no lines at all is the same failure.
 */
export function voucherProblem(v: any): string | null {
  if (!String(v?.guid ?? "").trim()) return "no GUID";
  if (!isoOf(v?.date)) return "a date that did not parse";
  const lines = Array.isArray(v.allledgerentries) ? v.allledgerentries : [];
  if (lines.some((e: any) => !String(e?.ledgername ?? "").trim())) return "an empty ledger line (a placeholder)";
  const type = String(v.vouchertypename ?? "").trim() || null;
  if (v.iscancelled !== true && lines.length === 0 && isAccountingType(type)) return `no ledger lines on a ${type}`;
  return null;
}

/** Pure: one converted voucher (convertVouchers output) to a staging row, or null when it has no GUID. */
export function mirrorRowFrom(v: any, opts: { scrub: false } | { scrub: true; salt: string }): MirrorRow | null {
  const key = String(v?.guid ?? "").trim();
  if (!key) return null;
  const lines = (Array.isArray(v.allledgerentries) ? v.allledgerentries : []).filter((e: any) => String(e?.ledgername ?? "").trim());
  const total = lines.reduce((s: number, e: any) => s + Math.abs(money(e.amount)), 0) / 2;
  const name = (kind: string, s: string) => (opts.scrub ? scrubName(kind, s, opts.salt) : (s || "").trim() || null);
  const narration = String(v.narration ?? "");
  return {
    key,
    master_id: Number(v.masterid) || null,
    alter_id: Number(v.alterid) || null,
    voucher_date: isoOf(v.date),
    voucher_type: String(v.vouchertypename ?? "").trim() || null,
    voucher_number: String(v.vouchernumber ?? "").trim() || null,
    party: name("PARTY", String(v.partyledgername ?? "")),
    ledger_total: lines.length ? Math.round(total * 100) / 100 : null,
    is_cancelled: v.iscancelled === true,
    is_optional: v.isoptional === true,
    row: {
      narration: opts.scrub ? (/ZZ ?TEST/i.test(narration) ? narration : null) : narration || null,
      reference: opts.scrub ? null : (v.reference || null),
      ...(lines.length ? {} : { no_ledger_lines: true }),
      effective_date: isoOf(v.effectivedate),
      ledgers: lines.map((e: any) => ({ ledger: name("LEDGER", String(e.ledgername ?? "")), amount: money(e.amount), debit: e.isdeemedpositive === true })),
    },
  };
}

/**
 * Pure: a ledger balance as Tally writes it ("-1234.50", Tally's own sign,
 * negative is debit). Empty means Tally sent none (null, never 0); anything
 * else that is not a plain number throws, so it can never read as 0 (G7).
 */
export function parseBalance(s: unknown): number | null {
  const t = String(s ?? "").trim().replace(/,/g, "");
  if (!t) return null;
  if (!/^-?\d+(\.\d+)?$/.test(t)) throw new Error(`a ledger balance that does not parse (${t.slice(0, 20)})`);
  return Math.round(parseFloat(t) * 100) / 100;
}

/** Pure: why this ledger cannot be trusted as read, or null. */
export function ledgerProblem(l: TallyLedger): string | null {
  if (!String(l?.guid ?? "").trim()) return "no GUID";
  if (!String(l?.name ?? "").trim()) return "no name";
  try { parseBalance(l.closingbalance); parseBalance(l.openingbalance); } catch { return "a balance that does not parse"; }
  return null;
}

/** Pure: one checked ledger to a staging row. Test runs store names only as stand-ins. */
export function ledgerRowFrom(l: TallyLedger, opts: { scrub: false } | { scrub: true; salt: string }): MirrorLedgerRow {
  const name = (kind: string, s: string) => (opts.scrub ? scrubName(kind, s, opts.salt) : (s || "").trim() || null);
  return {
    key: String(l.guid).trim(),
    name: name("LEDGER", l.name)!,
    parent: name("GROUP", l.parent),
    closing_balance: parseBalance(l.closingbalance),
    opening_balance: parseBalance(l.openingbalance),
    alter_id: Number(l.alterid) || null,
    master_id: Number(l.masterid) || null,
    row: { closing_balance_sent: String(l.closingbalance ?? "").trim() !== "" },
  };
}

/** Pure: the ledgers out of a parsed Ledger collection reply (the shape convertLedgers reads). */
export function ledgersFromParsed(parsed: any): TallyLedger[] {
  const txt = (v: any): string => v == null ? "" : typeof v === "object" ? String(v["#text"] ?? "") : String(v);
  const col = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;
  const raw = col?.LEDGER ?? col?.["LEDGER.LIST"];
  const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  return list.map((l: any) => ({
    guid: txt(l?.GUID).trim(), name: (txt(l?.["@_NAME"]) || txt(l?.NAME)).trim(), parent: txt(l?.PARENT).trim(),
    closingbalance: txt(l?.CLOSINGBALANCE), openingbalance: txt(l?.OPENINGBALANCE), alterid: txt(l?.ALTERID), masterid: txt(l?.MASTERID),
  }));
}

/** Every ISO day from `from` to `to`, inclusive. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`);
  if (!(d.getTime() <= end.getTime())) return out;
  for (; d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

// ── The two seams ───────────────────────────────────────────────────────────

export interface MirrorTally {
  /** Tally's highest voucher AlterID now, the latest voucher date, the voucher count, the count per day,
   *  and every voucher's key, date and AlterID for the nightly check (A11). */
  highest(): Promise<{ alterId: number; latestDate: string | null; count: number; byDay: Record<string, number>; vouchers?: DayCheckVoucher[] }>;
  /** Converted vouchers Tally returns for a one-day filter (the caller checks each is of that day). */
  vouchersOn(day: string): Promise<any[]>;
  /** Converted vouchers whose AlterID is above `mark` (any date). */
  changedSince(mark: number): Promise<any[]>;
  /** Every ledger master with its closing balance (one request). */
  ledgers(): Promise<TallyLedger[]>;
}

/** One voucher as the nightly check sends it: key, ISO date, AlterID (raw; the database checks each). */
export interface DayCheckVoucher { k: string; d: string | null; a: number | null }

export interface SwapResult {
  state: "swapped" | "refused";
  reason?: string;
  [k: string]: unknown;
}

export interface MirrorStore {
  /** Test rows: names are always scrubbed (the caller cannot turn it off). */
  readonly isTest: boolean;
  /** The secret salt for scrubbing; required when isTest. */
  readonly scrubSalt: string | null;
  start(kind: "full" | "incremental", scope?: { from: string; to: string }): Promise<{ run_id: string; scope_from: string; scope_to: string; mark: number | null }>;
  step(run: string, step: string, state: "ok" | "failed" | "info", rows?: number | null, ms?: number | null, detail?: unknown): Promise<void>;
  stage(run: string, rows: MirrorRow[]): Promise<number>;
  swap(run: string, markCandidate: number): Promise<SwapResult>;
  fail(run: string, error: string): Promise<void>;
  /** Stage ledgers (at most 500 per call); returns the count staged for the run. */
  stageLedgers(run: string, rows: MirrorLedgerRow[]): Promise<number>;
  /** Start the oldest queued one-day re-pull, or null when none is queued. */
  repullStart(): Promise<{ run_id: string; scope_from: string; scope_to: string; mark: number | null; repull_id?: string } | null>;
  /** The nightly key compare (A11): the database compares and queues the re-pulls. */
  checkDays(tallyHighest: number, vouchers: DayCheckVoucher[]): Promise<Record<string, any>>;
}

/** Throws unless the parsed reply is a collection (an error envelope is never "empty"). */
export function assertParsedCollection(parsed: any, what: string): any {
  const data = parsed?.ENVELOPE?.BODY?.DATA;
  if (data === undefined || data === null || typeof data !== "object" || !("COLLECTION" in data)) {
    throw new Error(`Tally's answer to ${what} has no collection in it, so it is not a list of vouchers`);
  }
  return parsed;
}

type Post = (url: string, xml: string, timeoutMs: number, raw: boolean) => Promise<any>;

/** The real Tally reads, one request at a time (the caller awaits each). */
export function tallyMirrorReads(tallyUrl: string, company: string, post: Post = (u, x, t, r) => tallyPost(u, x, t, r)): MirrorTally {
  return {
    async highest() {
      const parsed = assertParsedCollection(await post(tallyUrl, buildChangedVoucherXml(ERP_MIRROR_MARK_DEF, company, 0), ERP_MIRROR_MARK_DEF.timeout, false), "the AlterID read");
      const list = convertVouchers(parsed).tallymessage;
      let alterId = 0, latest: string | null = null;
      const byDay: Record<string, number> = {};
      const vouchers: DayCheckVoucher[] = [];
      for (const v of list) {
        if (Number(v.alterid) > alterId) alterId = Number(v.alterid);
        const d = isoOf(v.date);
        if (d) byDay[d] = (byDay[d] ?? 0) + 1;
        if (d && (!latest || d > latest)) latest = d;
        const a = String(v.alterid ?? "").trim();
        /* Tally never gives an AlterID of 0, and the converter turns a missing one into 0: so 0 is "missing". */
        vouchers.push({ k: String(v.guid ?? "").trim(), d, a: /^\d+$/.test(a) && Number(a) > 0 ? Number(a) : null });
      }
      return { alterId, latestDate: latest, count: list.length, byDay, vouchers };
    },
    async vouchersOn(day: string) {
      const parsed = assertParsedCollection(await post(tallyUrl, buildCollectionXml(ERP_MIRROR_VOUCHER_DEF, company, day, day), ERP_MIRROR_VOUCHER_DEF.timeout, false), `the read of ${day}`);
      return convertVouchers(parsed).tallymessage;
    },
    async changedSince(mark: number) {
      const parsed = assertParsedCollection(await post(tallyUrl, buildChangedVoucherXml(ERP_MIRROR_VOUCHER_DEF, company, mark), ERP_MIRROR_VOUCHER_DEF.timeout, false), `the read above AlterID ${mark}`);
      return convertVouchers(parsed).tallymessage;
    },
    async ledgers() {
      const parsed = assertParsedCollection(await post(tallyUrl, buildCollectionXml(ERP_MIRROR_LEDGER_DEF, company), ERP_MIRROR_LEDGER_DEF.timeout, false), "the ledger read");
      return ledgersFromParsed(parsed);
    },
  };
}

/** The database half, through the ERP functions of migrations 0116 to 0118. Every error throws. */
export function supabaseMirrorStore(c: SupabaseClient, machine: string, key: string, companyKey: string, isTest: boolean): MirrorStore {
  const scrubSalt = isTest ? scrubSaltFrom(key) : null;
  const call = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await c.rpc(fn, { p_machine: machine, p_key: key, ...args });
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  return {
    isTest,
    scrubSalt,
    start: async (kind, scope) => call("erp_sync_run_start", { p_company_key: companyKey, p_kind: kind, p_scope_from: scope?.from ?? null, p_scope_to: scope?.to ?? null, p_is_test: isTest }),
    step: async (run, step, state, rows, ms, detail) => { await call("erp_sync_run_step", { p_run: run, p_step: step, p_state: state, p_rows: rows ?? null, p_ms: ms ?? null, p_detail: detail ?? null }); },
    stage: async (run, rows) => Number(await call("erp_sync_stage", { p_run: run, p_rows: rows })),
    swap: async (run, mark) => call("erp_sync_swap", { p_run: run, p_mark_candidate: mark }),
    fail: async (run, error) => { await call("erp_sync_run_fail", { p_run: run, p_error: error }); },
    stageLedgers: async (run, rows) => Number(await call("erp_sync_stage_ledgers", { p_run: run, p_rows: rows })),
    repullStart: async () => (await call("erp_sync_repull_start", { p_company_key: companyKey, p_is_test: isTest })) ?? null,
    checkDays: async (tallyHighest, vouchers) => call("erp_sync_check_days", { p_company_key: companyKey, p_is_test: isTest, p_tally_highest: tallyHighest, p_vouchers: vouchers }),
  };
}

export interface MirrorSyncReport {
  run_id: string | null;
  kind: "full" | "incremental" | "repull";
  state: "swapped" | "refused" | "failed";
  scope: { from: string; to: string } | null;
  markCandidate: number | null;
  read: number;
  staged: number;
  noGuid: number;
  swap: SwapResult | null;
  error: string | null;
  tallyReads: number;
  /** Ledgers staged with the run (null when none were read). */
  ledgers: number | null;
}

const STAGE_BATCH = 500;

/**
 * One run. Full: every day of the scope, one read per day. Incremental: one
 * read of everything above the mark, refused before reading when Tally's
 * highest is below the mark. Then stage and swap. Any failure fails the run in
 * the database (the mark does not move) and is returned, never swallowed into
 * "nothing changed". Test runs always scrub names (the store decides).
 */
export async function runMirrorSync(opts: {
  store: MirrorStore; tally: MirrorTally; kind: "full" | "incremental";
  scope?: { from: string; to: string };
  /** Read the ledger masters with the run (default yes). */
  ledgers?: boolean;
  log?: (line: string) => void;
}): Promise<MirrorSyncReport> {
  return (await runMirror({ ...opts }))!;
}

/** One queued one-day re-pull (A11, 0119): a full read of that day that keeps the mark. Null when none is queued. */
export async function runRepull(opts: { store: MirrorStore; tally: MirrorTally; log?: (line: string) => void }): Promise<MirrorSyncReport | null> {
  return runMirror({ ...opts, kind: "repull" });
}

async function runMirror(opts: {
  store: MirrorStore; tally: MirrorTally; kind: "full" | "incremental" | "repull";
  scope?: { from: string; to: string };
  ledgers?: boolean;
  log?: (line: string) => void;
}): Promise<MirrorSyncReport | null> {
  const { store, tally, kind } = opts;
  if (store.isTest && !store.scrubSalt) throw new Error("refused: a test run must scrub names, and the store has no salt");
  const scrubOpts = store.isTest ? { scrub: true as const, salt: store.scrubSalt! } : { scrub: false as const };
  const log = opts.log ?? ((l: string) => console.log(`[erpMirror] ${l}`));
  const report: MirrorSyncReport = { run_id: null, kind, state: "failed", scope: null, markCandidate: null, read: 0, staged: 0, noGuid: 0, swap: null, error: null, tallyReads: 0, ledgers: null };
  const run = kind === "repull" ? await store.repullStart() : await store.start(kind, opts.scope);
  if (!run) return null;
  const readLedgers = kind !== "repull" && opts.ledgers !== false;
  report.run_id = run.run_id;
  report.scope = { from: run.scope_from, to: run.scope_to };
  const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => { const t0 = Date.now(); const v = await fn(); return [v, Date.now() - t0]; };
  let buffer: MirrorRow[] = [];
  const flush = async () => {
    while (buffer.length) {
      const part = buffer.slice(0, STAGE_BATCH);
      report.staged = await store.stage(run.run_id, part);
      buffer = buffer.slice(STAGE_BATCH);
    }
  };
  /* Every voucher of a read is checked before any is kept: one bad voucher
     fails the run (G7: a read we cannot trust is not "fewer vouchers"). */
  const take = (list: any[], what: string, day: string | null) => {
    report.read += list.length;
    const problems: string[] = [];
    for (const v of list) {
      const p = voucherProblem(v) ?? (day && isoOf(v?.date) !== day ? `dated ${isoOf(v?.date)}, not ${day}` : null);
      if (p) { if (p === "no GUID") report.noGuid++; problems.push(p); continue; }
      buffer.push(mirrorRowFrom(v, scrubOpts)!);
    }
    if (problems.length) {
      const counts = [...new Set(problems)].map((p) => `${problems.filter((x) => x === p).length} with ${p}`).join("; ");
      throw new Error(`refused: ${what} returned vouchers that cannot be trusted as read (${counts}), so the run fails and nothing is swapped`);
    }
  };
  try {
    const [top, ms0] = await timed(() => tally.highest());
    report.tallyReads++;
    report.markCandidate = top.alterId;
    await store.step(run.run_id, "read Tally's highest voucher AlterID before reading", "ok", top.count, ms0, { alter_id: top.alterId, latest_date: top.latestDate, mark_before: run.mark });
    if (kind === "full" || kind === "repull") {
      for (const day of eachDay(run.scope_from, run.scope_to)) {
        const [list, ms] = await timed(() => tally.vouchersOn(day));
        report.tallyReads++;
        take(list, `the read of ${day}`, day);
        await store.step(run.run_id, `read ${day}`, "ok", list.length, ms, null);
        if (buffer.length >= STAGE_BATCH) await flush();
      }
    } else if (run.mark !== null && top.alterId < run.mark) {
      /* H1 (0118, D-1-5.12): nothing can be above Tally's own highest, so a
         read above either number would miss what changed. No voucher is read;
         the swap records the refusal and that a full run is due. */
      await store.step(run.run_id, `Tally's highest AlterID ${top.alterId} is below the mark ${run.mark}: needs a full run, nothing read`, "info", null, null,
        { mark: run.mark, tally_highest: top.alterId });
      const res = await store.swap(run.run_id, top.alterId);
      if (res.state !== "refused" || res.reason !== "needs_full_run") throw new Error(`the database did not refuse an incremental below the mark (${JSON.stringify(res)})`);
      report.swap = res;
      report.state = "refused";
      await store.step(run.run_id, "refused: needs_full_run", "failed", null, null, res);
      log(`${kind} run ${run.run_id}: refused, needs a full run (Tally ${top.alterId}, mark ${run.mark})`);
      return report;
    } else {
      const from = run.mark ?? 0;
      const [list, ms] = await timed(() => tally.changedSince(from));
      report.tallyReads++;
      take(list, `the read above AlterID ${from}`, null);
      await store.step(run.run_id, `read every voucher above AlterID ${from}`, "ok", list.length, ms, null);
    }
    await flush();
    await store.step(run.run_id, "staged", "ok", report.staged, null, null);
    if (readLedgers) {
      /* M-6: the ledgers and their closing balances, one request, checked
         before any is kept. An empty list is never "no ledgers". */
      const [list, msL] = await timed(() => tally.ledgers());
      report.tallyReads++;
      if (!list.length) throw new Error("refused: the ledger read came back empty, which is not a list of ledgers, so the run fails and nothing is swapped");
      const problems = list.map(ledgerProblem).filter((p): p is string => !!p);
      if (problems.length) {
        const counts = [...new Set(problems)].map((p) => `${problems.filter((x) => x === p).length} with ${p}`).join("; ");
        throw new Error(`refused: the ledger read returned ledgers that cannot be trusted as read (${counts}), so the run fails and nothing is swapped`);
      }
      const rows = list.map((l) => ledgerRowFrom(l, scrubOpts));
      let n = 0;
      for (let i = 0; i < rows.length; i += STAGE_BATCH) n = await store.stageLedgers(run.run_id, rows.slice(i, i + STAGE_BATCH));
      report.ledgers = n;
      await store.step(run.run_id, "read and staged the ledgers with their closing balances", "ok", n, msL,
        { with_closing_balance: rows.filter((r) => r.closing_balance !== null).length });
    }
    const [res, msS] = await timed(() => store.swap(run.run_id, top.alterId));
    report.swap = res;
    report.state = res.state;
    await store.step(run.run_id, res.state === "swapped" ? "swapped into the mirror" : `refused: ${res.reason}`, res.state === "swapped" ? "ok" : "failed", null, msS, res);
    log(`${kind} run ${run.run_id}: ${res.state} (${JSON.stringify(res)})`);
    return report;
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    report.error = msg;
    log(`${kind} run ${run.run_id} failed: ${msg}`);
    try { await store.step(run.run_id, "failed", "failed", null, null, { error: msg.slice(0, 500) }); } catch { /* the fail below still lands */ }
    try { await store.fail(run.run_id, msg); } catch (e2) { report.error += ` (and the run could not be marked failed: ${(e2 as Error).message})`; }
    return report;
  }
}

export interface DayCheckReport { state: "ok" | "gaps" | "refused" | "failed"; result: Record<string, any> | null; error: string | null; vouchers: number; tallyHighest: number | null }

/**
 * The nightly check (A11, 0119): one cheap read of every voucher's key, date
 * and AlterID, compared with the mirror in the database. Days that differ are
 * queued there for a one-day re-pull. A failed read is "failed", never "ok".
 */
export async function runDayCheck(opts: { store: MirrorStore; tally: MirrorTally; log?: (line: string) => void }): Promise<DayCheckReport> {
  const log = opts.log ?? ((l: string) => console.log(`[erpMirror] ${l}`));
  try {
    const top = await opts.tally.highest();
    if (!top.vouchers) throw new Error("the AlterID read did not return the vouchers' keys, so there is nothing to compare");
    const result = await opts.store.checkDays(top.alterId, top.vouchers);
    const state = (["ok", "gaps", "refused"].includes(result?.state) ? result.state : "failed") as DayCheckReport["state"];
    log(`day check: ${state} (${JSON.stringify({ ...result, days: undefined })})`);
    return { state, result, error: state === "failed" ? `the database answered ${JSON.stringify(result)}` : null, vouchers: top.vouchers.length, tallyHighest: top.alterId };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    log(`day check failed: ${msg}`);
    return { state: "failed", result: null, error: msg, vouchers: 0, tallyHighest: null };
  }
}

export type MirrorWork = "full" | "incremental" | "check" | "repull";

/**
 * Pure: what the mirror runs next, in order (A7 weekly full, A11 nightly
 * check). A full run when there is no mark, when one is due, or when the last
 * full one swapped 7 or more days ago; otherwise an incremental. Then the
 * nightly check when none ran for 20 hours, then any queued re-pulls. Nothing
 * in index.ts runs it until go-live.
 */
export function planMirrorWork(s: { now: Date; hasMark: boolean; fullDue: boolean; lastFullAt: Date | null; lastCheckAt: Date | null; queuedRepulls: number }): MirrorWork[] {
  const hours = (d: Date | null) => (d ? (s.now.getTime() - d.getTime()) / 3_600_000 : Infinity);
  const out: MirrorWork[] = [];
  out.push(!s.hasMark || s.fullDue || hours(s.lastFullAt) >= 7 * 24 ? "full" : "incremental");
  if (hours(s.lastCheckAt) >= 20) out.push("check");
  if (s.queuedRepulls > 0) out.push("repull");
  return out;
}
