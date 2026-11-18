/**
 * JOB: answer the Approvals page's "Check again" button (audit finding M1, 18-Nov-2026). A person asks the database to look again at a push
 * that may have landed (`request_erp_readback`, a row in `erp_readback_requests`); this module is the agent's half: it reads Tally ONCE for the
 * job's voucher and writes a plain answer back. It never writes to Tally: no push, no alter, no cancel. The only request it sends is the same
 * bounded, filtered read the queue agent settles jobs with (`vouchersOnDateXml` by day, type and number, judged by `assertCollectionReply`).
 *
 * Three parts:
 *  1. `readbackVoucher`: pure apart from the `post` seam. Given a job's type, number and date, one read, one answer object. Never throws.
 *  2. `runReadbackRound`: takes at most 3 open asks, answers them one at a time (Tally takes one request at a time), never lets one failure
 *     stop the rest, and writes an answer even when the read failed (so the person sees why). A sandbox answers only test asks, the office
 *     machine only real ones. A queue that cannot be reached (for example the database functions are not applied yet) is one quiet log line.
 *  3. `ReadbackRunner`: the back-off around the round, so a slow or missing database is asked less often, never in a tight loop.
 *
 * Who calls it: `PrimaryQueueLoop` (primaryRunner.ts) after a queue round that held the lease and did no work, inside the same busy flag,
 * so it never overlaps a push or the mirror sync, and only behind the company pin. The database half is two functions the owner applies
 * separately: `erp_agent_readback_open` and `erp_agent_readback_answer` (machine id and key checked in the database).
 *
 * G7: an empty or error-shaped reply never means "nothing there". Only a read that came back as a proper collection with no such voucher in it
 * is `not_found`; anything else is `read_failed`.
 */
import { vouchersOnDateXml, diffStored, sameVoucherType } from "./safePush.js";
import { assertCollectionReply } from "./voucherNumbering.js";
import { readTag } from "./xml.js";
import { backoffMs, JOB_POLL_MS } from "./jobPoll.js";
import type { VoucherPayload } from "../types.js";

export type ReadbackStatus = "found" | "not_found" | "ambiguous" | "read_failed";

export interface ReadbackMatch {
  voucherNumber: string;
  cancelled: boolean;
  masterId: string | null;
  /**
   * True when Tally holds exactly what was sent (`diffStored` finds no difference), false when it differs. Null when the agent was given only
   * the type, number and date and not the lines that were sent, so there was nothing to compare against.
   */
  sameAsSent: boolean | null;
}

export interface ReadbackAnswer {
  readAt: string;
  status: ReadbackStatus;
  checked: { type: string; number: string; date: string };
  matches: ReadbackMatch[];
  note: string;
}

/** What one check needs. A full payload (with its lines) also lets the answer say whether Tally holds what was sent. */
export type ReadbackTarget = {
  /** As the job or the database names it; compared with Tally's type without regard to case. */
  voucherType: string;
  voucherNumber?: string | null;
  date?: string | null;
  ledgerEntries?: VoucherPayload["ledgerEntries"];
  inventoryEntries?: VoucherPayload["inventoryEntries"];
};

/** How long one readback read may take: the same as the stamp read (a filtered day read takes 5 to 50 s on the dummy). */
export const READBACK_TIMEOUT_MS = 60_000;
/** At most this many asks are answered per round. */
export const READBACK_PER_ROUND = 3;

const short = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/** A real calendar day written yyyy-mm-dd, or null. */
export function usableDate(raw: unknown): string | null {
  const s = String(raw ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

const hasLines = (p: ReadbackTarget) => Array.isArray(p.ledgerEntries) || Array.isArray(p.inventoryEntries);

/**
 * Read Tally once for one voucher and say what is there. Never throws: a failure of any kind is `read_failed` with the reason (at most
 * 160 characters). A payload with no number, or no usable date, is `read_failed` without reading (the check needs both).
 */
export async function readbackVoucher(post: (xml: string) => Promise<string>, company: string, p: ReadbackTarget, now: () => Date = () => new Date()): Promise<ReadbackAnswer> {
  const type = String(p?.voucherType ?? "").trim();
  const number = String(p?.voucherNumber ?? "").trim();
  const date = usableDate(p?.date);
  const base = { checked: { type, number, date: date ?? String(p?.date ?? "") }, matches: [] as ReadbackMatch[] };
  const failed = (note: string): ReadbackAnswer => ({ readAt: now().toISOString(), status: "read_failed", ...base, note: short(note) });
  try {
    if (!type) return failed("Not checked: the job has no voucher type, so Tally was not read.");
    if (!number) return failed("Not checked: the job has no voucher number, and the check needs one to find the voucher. Tally was not read.");
    if (!date) return failed(`Not checked: the job's date (${String(p?.date ?? "none") || "none"}) is not a usable day, so Tally was not read.`);
    const xml = assertCollectionReply(await post(vouchersOnDateXml(company, date, { voucherType: type, voucherNumber: number })));
    const readAt = now().toISOString();
    const blocks = [...xml.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => m[0])
      .filter((v) => sameVoucherType(readTag(v, "VOUCHERTYPENAME"), type) && readTag(v, "VOUCHERNUMBER").trim() === number);
    const compare = hasLines(p);
    const matches: ReadbackMatch[] = blocks.map((v) => ({
      voucherNumber: readTag(v, "VOUCHERNUMBER").trim(),
      cancelled: /^yes$/i.test(readTag(v, "ISCANCELLED") ?? ""),
      masterId: readTag(v, "MASTERID") || null,
      sameAsSent: compare ? diffStored(p as unknown as VoucherPayload, v).length === 0 : null,
    }));
    const what = `${type} ${number} on ${date}`;
    if (matches.length === 0) {
      return { readAt, status: "not_found", ...base, note: `Tally was read and holds no ${what}. It did not arrive.` };
    }
    if (matches.length > 1) {
      return { readAt, status: "ambiguous", ...base, matches, note: `Tally holds ${matches.length} vouchers numbered ${what}. A person must check which one is this job's.` };
    }
    const m = matches[0];
    const note = m.cancelled ? `Found in Tally: ${what}, but it is cancelled there.`
      : m.sameAsSent === true ? `Found in Tally: ${what}, and it matches what was sent.`
      : m.sameAsSent === false ? `Found in Tally: ${what}, but it differs from what was sent. A person must check it.`
      : `Found in Tally: ${what}. Not compared line by line with what was sent.`;
    return { readAt, status: "found", ...base, matches, note };
  } catch (e) {
    return failed(`Tally could not be read: ${(e as Error)?.message ?? String(e)}`);
  }
}

// ── The queue and the round ───────────────────────────────────────────────────

export interface ReadbackAsk {
  id: string;
  jobId: string;
  isTest: boolean;
  kind: string;
  voucherType: string;
  voucherNumber: string | null;
  date: string | null;
  /** The company the job was sent to, when the database knows it. */
  company?: string | null;
  /** The job's full payload, when the database hands it over; lets the answer say whether Tally holds what was sent. */
  payload?: Partial<VoucherPayload> | null;
}

export interface ReadbackQueue {
  open(limit: number): Promise<ReadbackAsk[]>;
  answer(id: string, answer: ReadbackAnswer): Promise<boolean>;
}

export interface ReadbackRoundOpts {
  queue: ReadbackQueue;
  /** One read of Tally for one ask, already bound to the company and the post seam (normally `readbackVoucher`). */
  find: (ask: ReadbackAsk) => Promise<ReadbackAnswer>;
  /** True on the sandbox laptop (answers only test asks); false on the office machine (answers only real asks). */
  wantTest: boolean;
  /** The pinned company. An ask that names another company is answered `read_failed` without reading. */
  company?: string;
  /** The company pin: null when the pinned company is the one open in Tally, else the reason. A failure reads nothing and answers nothing. */
  pin?: () => Promise<string | null>;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface ReadbackRoundReport {
  /** Asks the queue handed over (before the test filter). */
  open: number;
  /** Asks this machine may answer, at most READBACK_PER_ROUND. */
  taken: number;
  results: { id: string; status: ReadbackStatus; written: boolean; detail?: string }[];
  /** The queue itself could not be reached (open failed); nothing was read. */
  queueError: string | null;
  /** The round stopped early (the pin), with the reason. */
  stopped: string | null;
}

/** The queue's error says the database function is not there yet (not applied, or the API has not reloaded its list). */
export function looksLikeMissingFunction(msg: string): boolean {
  return /does not exist|could not find|schema cache|PGRST202|42883/i.test(msg);
}

/**
 * One round: ask the queue for open asks, keep the ones this machine may answer, and answer at most three, one at a time, in the order the
 * queue gave them. Never throws.
 */
export async function runReadbackRound(o: ReadbackRoundOpts): Promise<ReadbackRoundReport> {
  const log = o.log ?? ((l: string) => console.log(`[readback] ${l}`));
  const rep: ReadbackRoundReport = { open: 0, taken: 0, results: [], queueError: null, stopped: null };
  let asks: ReadbackAsk[];
  try {
    /* A few more than we answer, so asks this machine must leave alone (the other role's) cannot crowd out its own. */
    asks = await o.queue.open(READBACK_PER_ROUND * 4);
    if (!Array.isArray(asks)) throw new Error("the queue's answer was not a list");
  } catch (e) {
    rep.queueError = short((e as Error)?.message ?? String(e));
    return rep;
  }
  rep.open = asks.length;
  const mine = asks.filter((a) => a && a.isTest === o.wantTest).slice(0, READBACK_PER_ROUND);
  rep.taken = mine.length;
  for (const ask of mine) {
    let answer: ReadbackAnswer;
    const other = o.company && ask.company && ask.company.trim().toLowerCase() !== o.company.trim().toLowerCase();
    if (other) {
      answer = { readAt: (o.now ?? (() => new Date()))().toISOString(), status: "read_failed",
        checked: { type: ask.voucherType ?? "", number: ask.voucherNumber ?? "", date: ask.date ?? "" }, matches: [],
        note: "Not checked: this job was sent to a different company from the one this agent reads. Tally was not read." };
    } else {
      if (o.pin) {
        let why: string | null;
        try { why = await o.pin(); } catch (e) { why = `the company pin could not be checked (${short((e as Error)?.message ?? String(e), 100)})`; }
        if (why) {
          rep.stopped = short(`not read: ${why}`);
          log(`stopped before reading Tally: ${rep.stopped}. The asks stay open for the next round.`);
          return rep;
        }
      }
      try { answer = await o.find(ask); }
      catch (e) {
        /* `find` should never throw (readbackVoucher does not); if a wrapper does, the person still gets an answer. */
        answer = { readAt: (o.now ?? (() => new Date()))().toISOString(), status: "read_failed",
          checked: { type: ask.voucherType ?? "", number: ask.voucherNumber ?? "", date: ask.date ?? "" }, matches: [],
          note: short(`Tally could not be read: ${(e as Error)?.message ?? String(e)}`) };
      }
    }
    try {
      const written = await o.queue.answer(ask.id, answer);
      rep.results.push({ id: ask.id, status: answer.status, written: written === true, ...(written === true ? {} : { detail: "the ask was no longer open" }) });
    } catch (e) {
      const msg = short((e as Error)?.message ?? String(e));
      rep.results.push({ id: ask.id, status: answer.status, written: false, detail: msg });
      log(`could not write the answer for one ask: ${msg}`);
    }
  }
  if (rep.results.length) log(`answered ${rep.results.filter((r) => r.written).length} of ${rep.results.length} check(s): ${rep.results.map((r) => r.status).join(", ")}`);
  return rep;
}

/**
 * The back-off around the round. A round whose queue call failed waits longer before the next try (30 s doubling to 5 minutes, the same
 * steps as the queue loop); a missing database function waits 15 minutes and is logged once, not every time. One good round puts it back.
 * `tick` never throws.
 */
export class ReadbackRunner {
  private nextAt = 0;
  private fails = 0;
  private lastLogged: string | null = null;
  readonly status: { lastAt: string | null; lastNote: string | null; answered: number } = { lastAt: null, lastNote: null, answered: 0 };
  constructor(private o: Omit<ReadbackRoundOpts, "now"> & { now?: () => number; pollMs?: number; missingWaitMs?: number }) {}

  async tick(): Promise<ReadbackRoundReport | null> {
    const now = (this.o.now ?? Date.now)();
    if (now < this.nextAt) return null;
    const log = this.o.log ?? ((l: string) => console.log(`[readback] ${l}`));
    let rep: ReadbackRoundReport;
    try {
      rep = await runReadbackRound({ ...this.o, log, now: () => new Date((this.o.now ?? Date.now)()) });
    } catch (e) {
      rep = { open: 0, taken: 0, results: [], queueError: short((e as Error)?.message ?? String(e)), stopped: null };
    }
    this.status.lastAt = new Date(now).toISOString();
    if (rep.queueError) {
      this.fails++;
      const missing = looksLikeMissingFunction(rep.queueError);
      const wait = missing ? (this.o.missingWaitMs ?? 15 * 60_000) : backoffMs(this.o.pollMs ?? JOB_POLL_MS, this.fails);
      this.nextAt = now + wait;
      this.status.lastNote = missing ? "the database's readback functions are not there yet" : `the readback list could not be read: ${rep.queueError}`;
      if (this.lastLogged !== this.status.lastNote) {
        log(missing
          ? "the \"Check again\" answers wait: the database's readback functions are not applied yet. Asking again in 15 minutes; nothing else is affected."
          : `the readback list could not be read (${rep.queueError}). Next try in ${Math.round(wait / 1000)} s; nothing else is affected.`);
        this.lastLogged = this.status.lastNote;
      }
      return rep;
    }
    if (this.fails > 0 && this.lastLogged) log("the readback list answers again.");
    this.fails = 0;
    this.lastLogged = null;
    this.nextAt = 0;
    this.status.answered += rep.results.filter((r) => r.written).length;
    this.status.lastNote = rep.stopped ?? (rep.results.length ? `${rep.results.length} check(s) answered` : "no checks asked");
    return rep;
  }
}

/** The live queue over the two database functions, through a client (the fenced test-queue client on the sandbox). */
export function supabaseReadbackQueue(c: { rpc: (fn: string, args: Record<string, unknown>) => any }, machine: string, key: string): ReadbackQueue {
  const call = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await c.rpc(fn, { p_machine: machine, p_key: key, ...args });
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  };
  return {
    open: async (limit) => {
      const rows = await call<unknown>("erp_agent_readback_open", { p_limit: limit });
      if (rows === null || rows === undefined) return [];
      if (!Array.isArray(rows)) throw new Error("erp_agent_readback_open: the answer was not a list");
      return rows.flatMap((r: any): ReadbackAsk[] => {
        /* An ask whose test flag is not a plain true or false is left alone: it must never be answered by the wrong machine. */
        if (!r || typeof r.id !== "string" || typeof r.is_test !== "boolean") return [];
        return [{
          id: r.id, jobId: String(r.job_id ?? ""), isTest: r.is_test, kind: String(r.kind ?? ""),
          voucherType: String(r.voucher_type ?? ""), voucherNumber: r.voucher_number == null ? null : String(r.voucher_number),
          date: r.voucher_date == null ? null : String(r.voucher_date).slice(0, 10), company: r.company == null ? null : String(r.company),
          payload: r.payload && typeof r.payload === "object" ? r.payload : null,
        }];
      });
    },
    answer: async (id, answer) => (await call<boolean>("erp_agent_readback_answer", { p_id: id, p_answer: answer })) === true,
  };
}

/** The target of one ask: its payload when the database handed it over, with the ask's own type, number and date winning. */
export function readbackTargetOf(ask: ReadbackAsk): ReadbackTarget {
  return { ...(ask.payload ?? {}), voucherType: ask.voucherType, voucherNumber: ask.voucherNumber, date: ask.date } as ReadbackTarget;
}
