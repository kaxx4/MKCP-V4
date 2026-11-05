/**
 * JOB: the ERP mirror sync (rebuild task 1-5, first half, 5-Nov-2026).
 *
 * Reads vouchers from Tally into a staging table, then asks the database to
 * swap them into the mirror in one transaction (migration 0116). Every run and
 * every step is written to `erp_sync_runs` / `erp_sync_run_steps`. The
 * high-water mark (the highest voucher AlterID the mirror is known to hold) is
 * kept per company, so an incremental run reads only what changed since.
 *
 * ── What this does NOT touch ──────────────────────────────────────────────
 * Today's sync (`syncOrchestrator.ts`, `supabaseSync.ts`, the tally_* tables)
 * is unchanged and does not import this file. Nothing in `index.ts` starts it,
 * so the office agent runs exactly as before. The database refuses every
 * machine but the sandbox laptop until go-live (`erp_control` live_claims),
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
 *   again next time (D-1-5.4). The mark follows Tally DOWN when the newest
 *   voucher is deleted (Tally's highest falls; migration 0117, D-1-5.9), and
 *   an incremental reads above the lower of the mark and Tally's highest.
 * - Keys are Tally's GUID; a voucher with no GUID is counted and left out,
 *   never given a made-up key (G5).
 * - Test runs from the dummy company store names one way only (D-1-5.5): the
 *   dummy is an old copy of the real books.
 */
import { createHash } from "node:crypto";
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
  fetch: ["AlterID", "Date"],
  timeout: 120_000,
  parallel: false,
};

export interface MirrorRow {
  key: string;
  master_id: number | null;
  alter_id: number | null;
  voucher_date: string | null;
  voucher_type: string | null;
  voucher_number: string | null;
  party: string | null;
  ledger_total: number;
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

/** One-way stand-in for a name from the dummy company. ZZ TEST names are kept as they are. */
export function scrubName(kind: string, name: string | null | undefined): string | null {
  const s = (name ?? "").trim();
  if (!s) return null;
  if (/^ZZ\s?TEST\b/i.test(s)) return s;
  return `ZZ TEST ${kind} ${createHash("sha256").update(s.toUpperCase()).digest("hex").slice(0, 8)}`;
}

/** Pure: one converted voucher (convertVouchers output) to a staging row, or null when it has no GUID. */
export function mirrorRowFrom(v: any, opts: { scrub: boolean }): MirrorRow | null {
  const key = String(v?.guid ?? "").trim();
  if (!key) return null;
  const lines = Array.isArray(v.allledgerentries) ? v.allledgerentries : [];
  const total = lines.reduce((s: number, e: any) => s + Math.abs(money(e.amount)), 0) / 2;
  const name = (kind: string, s: string) => (opts.scrub ? scrubName(kind, s) : (s || "").trim() || null);
  const narration = String(v.narration ?? "");
  return {
    key,
    master_id: Number(v.masterid) || null,
    alter_id: Number(v.alterid) || null,
    voucher_date: isoOf(v.date),
    voucher_type: String(v.vouchertypename ?? "").trim() || null,
    voucher_number: String(v.vouchernumber ?? "").trim() || null,
    party: name("PARTY", String(v.partyledgername ?? "")),
    ledger_total: Math.round(total * 100) / 100,
    is_cancelled: v.iscancelled === true,
    is_optional: v.isoptional === true,
    row: {
      narration: opts.scrub ? (/ZZ\s?TEST/i.test(narration) ? narration : null) : narration || null,
      reference: opts.scrub ? null : (v.reference || null),
      effective_date: isoOf(v.effectivedate),
      ledgers: lines.map((e: any) => ({ ledger: name("LEDGER", String(e.ledgername ?? "")), amount: money(e.amount), debit: e.isdeemedpositive === true })),
    },
  };
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
  /** Tally's highest voucher AlterID now, the latest voucher date and the voucher count. */
  highest(): Promise<{ alterId: number; latestDate: string | null; count: number }>;
  /** Converted vouchers dated on one day. */
  vouchersOn(day: string): Promise<any[]>;
  /** Converted vouchers whose AlterID is above `mark` (any date). */
  changedSince(mark: number): Promise<any[]>;
}

export interface SwapResult {
  state: "swapped" | "refused";
  reason?: string;
  [k: string]: unknown;
}

export interface MirrorStore {
  start(kind: "full" | "incremental", scope?: { from: string; to: string }): Promise<{ run_id: string; scope_from: string; scope_to: string; mark: number | null }>;
  step(run: string, step: string, state: "ok" | "failed" | "info", rows?: number | null, ms?: number | null, detail?: unknown): Promise<void>;
  stage(run: string, rows: MirrorRow[]): Promise<number>;
  swap(run: string, markCandidate: number, floorPct?: number): Promise<SwapResult>;
  fail(run: string, error: string): Promise<void>;
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
      for (const v of list) {
        if (Number(v.alterid) > alterId) alterId = Number(v.alterid);
        const d = isoOf(v.date);
        if (d && (!latest || d > latest)) latest = d;
      }
      return { alterId, latestDate: latest, count: list.length };
    },
    async vouchersOn(day: string) {
      const parsed = assertParsedCollection(await post(tallyUrl, buildCollectionXml(ERP_MIRROR_VOUCHER_DEF, company, day, day), ERP_MIRROR_VOUCHER_DEF.timeout, false), `the read of ${day}`);
      return convertVouchers(parsed).tallymessage.filter((v) => isoOf(v.date) === day);
    },
    async changedSince(mark: number) {
      const parsed = assertParsedCollection(await post(tallyUrl, buildChangedVoucherXml(ERP_MIRROR_VOUCHER_DEF, company, mark), ERP_MIRROR_VOUCHER_DEF.timeout, false), `the read above AlterID ${mark}`);
      return convertVouchers(parsed).tallymessage;
    },
  };
}

/** The database half, through the ERP functions of migration 0116. Every error throws. */
export function supabaseMirrorStore(c: SupabaseClient, machine: string, key: string, companyKey: string, isTest: boolean): MirrorStore {
  const call = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await c.rpc(fn, { p_machine: machine, p_key: key, ...args });
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  return {
    start: async (kind, scope) => call("erp_sync_run_start", { p_company_key: companyKey, p_kind: kind, p_scope_from: scope?.from ?? null, p_scope_to: scope?.to ?? null, p_is_test: isTest }),
    step: async (run, step, state, rows, ms, detail) => { await call("erp_sync_run_step", { p_run: run, p_step: step, p_state: state, p_rows: rows ?? null, p_ms: ms ?? null, p_detail: detail ?? null }); },
    stage: async (run, rows) => Number(await call("erp_sync_stage", { p_run: run, p_rows: rows })),
    swap: async (run, mark, floorPct) => call("erp_sync_swap", { p_run: run, p_mark_candidate: mark, ...(floorPct === undefined ? {} : { p_floor_pct: floorPct }) }),
    fail: async (run, error) => { await call("erp_sync_run_fail", { p_run: run, p_error: error }); },
  };
}

export interface MirrorSyncReport {
  run_id: string | null;
  kind: "full" | "incremental";
  state: "swapped" | "refused" | "failed";
  scope: { from: string; to: string } | null;
  markCandidate: number | null;
  read: number;
  staged: number;
  noGuid: number;
  swap: SwapResult | null;
  error: string | null;
  tallyReads: number;
}

const STAGE_BATCH = 500;

/**
 * One run. Full: every day of the scope, one read per day. Incremental: one
 * read of everything above the mark. Then stage and swap. Any failure fails
 * the run in the database (the mark does not move) and is returned, never
 * swallowed into "nothing changed".
 */
export async function runMirrorSync(opts: {
  store: MirrorStore; tally: MirrorTally; kind: "full" | "incremental";
  scope?: { from: string; to: string }; scrub: boolean; floorPct?: number;
  log?: (line: string) => void;
}): Promise<MirrorSyncReport> {
  const { store, tally, kind, scrub } = opts;
  const log = opts.log ?? ((l: string) => console.log(`[erpMirror] ${l}`));
  const report: MirrorSyncReport = { run_id: null, kind, state: "failed", scope: null, markCandidate: null, read: 0, staged: 0, noGuid: 0, swap: null, error: null, tallyReads: 0 };
  const run = await store.start(kind, opts.scope);
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
  const take = (list: any[]) => {
    report.read += list.length;
    for (const v of list) {
      const r = mirrorRowFrom(v, { scrub });
      if (r) buffer.push(r); else report.noGuid++;
    }
  };
  try {
    const [top, ms0] = await timed(() => tally.highest());
    report.tallyReads++;
    report.markCandidate = top.alterId;
    await store.step(run.run_id, "read Tally's highest voucher AlterID before reading", "ok", top.count, ms0, { alter_id: top.alterId, latest_date: top.latestDate, mark_before: run.mark });
    if (kind === "full") {
      for (const day of eachDay(run.scope_from, run.scope_to)) {
        const [list, ms] = await timed(() => tally.vouchersOn(day));
        report.tallyReads++;
        take(list);
        await store.step(run.run_id, `read ${day}`, "ok", list.length, ms, null);
        if (buffer.length >= STAGE_BATCH) await flush();
      }
    } else {
      /* Above the LOWER of the mark and Tally's highest now (0117, D-1-5.9): when
         the newest voucher is deleted, Tally's highest falls, and a number it
         hands out again would sit below the old mark. */
      const from = Math.min(run.mark ?? 0, top.alterId);
      const [list, ms] = await timed(() => tally.changedSince(from));
      report.tallyReads++;
      take(list);
      await store.step(run.run_id, `read every voucher above AlterID ${from}`, "ok", list.length, ms,
        from < (run.mark ?? 0) ? { alter_id_fell_from: run.mark, to: top.alterId } : null);
    }
    await flush();
    await store.step(run.run_id, "staged", "ok", report.staged, null, report.noGuid ? { left_out_no_guid: report.noGuid } : null);
    const [res, msS] = await timed(() => store.swap(run.run_id, top.alterId, opts.floorPct));
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
