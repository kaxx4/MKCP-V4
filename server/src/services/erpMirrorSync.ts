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
 *
 * -- Review fixes (6-Nov-2026, migration 0120) -----------------------------
 * - M2, as decided in D-C.2 (6-Nov-2026): the ledgers are read with NO
 *   period. A dated read (SVFROMDATE/SVTODATE) made the dummy Tally recompute
 *   every ledger: no answer in 120 s, then the port stayed dead. Instead the
 *   run reads the period Tally has loaded from the Company object
 *   (StartingFrom, EndingAt) and stores its end as balance_as_of. A loaded
 *   period that is not the financial year to date marks every row
 *   balance_period_unexpected, and those figures are never the year's
 *   closing balances.
 * - A balance Tally leaves empty is 0, as Tally shows it and today's
 *   converter writes it; the row says closing_balance_sent false (M1). A
 *   balance with text after the number fails the run (parseTallyAmount,
 *   strict, M6).
 * - A one-day run (every re-pull) is judged by the database's per-day rule
 *   only, and trusts a small day's count only because the "read <day>" step
 *   is written after every voucher of that read passed its checks (H1).
 * - lastFullRun is the planner's weekly clock: the last full run that was not
 *   a re-pull (M4).
 * - An Owner can accept a refused big drop (migration 0121, per run). The
 *   floor refusal stays the default and the agent never decides: acceptedRuns
 *   is the database's list, swapAccepted passes the run id only (no floor, no
 *   mark; the database uses the run's own recorded AlterID read), and the
 *   database checks the acceptance again (6 hours, no other swap since, the
 *   staged read unchanged). applyAcceptedDrops runs first in planMirrorWork.
 */
import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CollectionDef } from "../types.js";
import { tallyPost } from "../tally.js";
import { buildCollectionXml, buildChangedVoucherXml } from "./xmlBuilder.js";
import { convertVouchers, txt as tallyText, arr as tallyList } from "../converters/convert.js";
import { parseTallyAmount } from "./xml.js";
import { TRANSACTION_COLLECTIONS } from "../config/collections.js";
import { tallyBlobFrom } from "./erpTallyShape.js";

/** The ERP mirror's voucher fields for this half: header, identity, ledger lines (for totals). */
export const ERP_MIRROR_VOUCHER_DEF: CollectionDef = {
  name: "erpMirrorVouchers",
  tallyCollection: "Voucher",
  metadataType: "Voucher",
  category: "transaction",
  fetch: [
    "Guid", "Date", "VoucherTypeName", "VoucherNumber", "Reference", "Narration",
    "PartyLedgerName", "IsCancelled", "IsOptional", "EffectiveDate", "AlterID", "MasterId",
    /* Part 7: who entered it in Tally. The bank instrument number and date ride inside
       AllLedgerEntries (BANKALLOCATIONS.LIST), so they need no field of their own. */
    "EnteredBy",
    "AllLedgerEntries",
    /* The go-live swap (D-1-5.58): every field today's voucher read asks for, so the mirror row can carry the
       whole tally_vouchers row (inventory lines, e-way bill, IRN, buyer, GST fields). The list is today's own,
       taken from collections.ts so it cannot drift; names Tally already answers, no `*` (buildCollection refuses one). */
    ...(TRANSACTION_COLLECTIONS.find((c) => c.name === "vouchers")?.fetch ?? []).filter((f) => f !== "AllLedgerEntries"),
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
  fetch: ["Guid", "Name", "Parent", "OpeningBalance", "ClosingBalance", "AlterID", "MasterId",
    /* Part 7, each named (G7): phone and mobile, PAN (Tally's income tax number), the GST registration type and bill-wise on. */
    "LedgerPhone", "LedgerMobile", "IncomeTaxNumber", "GSTRegistrationType", "IsBillWiseOn"],
  timeout: 120_000,
  parallel: false,
};

/**
 * Part 7: the voucher types with their parent (a custom type's parent says what it behaves as). Probed
 * and parsed here; not staged anywhere until the go-live swap shape is decided (reports/1-5.md, part 7).
 */
export const ERP_MIRROR_VOUCHERTYPE_DEF: CollectionDef = {
  name: "erpMirrorVoucherTypes",
  tallyCollection: "VoucherType",
  metadataType: "Voucher Type",
  category: "master",
  fetch: ["Guid", "Name", "Parent", "AlterID", "MasterId"],
  timeout: 60_000,
  parallel: false,
};

/** Part 7: the units with their decimal places (a unit that takes no decimals must never be shown a fraction). Not staged yet. */
export const ERP_MIRROR_UNIT_DEF: CollectionDef = {
  name: "erpMirrorUnits",
  tallyCollection: "Unit",
  metadataType: "Unit",
  category: "master",
  fetch: ["Guid", "Name", "DecimalPlaces", "IsSimpleUnit", "AlterID", "MasterId"],
  timeout: 60_000,
  parallel: false,
};

/** Part 7: the stock items' keys only (GUID, name, AlterID, MasterId). Not staged yet. */
export const ERP_MIRROR_ITEM_DEF: CollectionDef = {
  name: "erpMirrorItems",
  tallyCollection: "StockItem",
  metadataType: "Stock Item",
  category: "master",
  fetch: ["Guid", "Name", "BaseUnits", "AlterID", "MasterId"],
  timeout: 120_000,
  parallel: false,
};

/** D-C.2: the company's loaded period, one Company collection (StartingFrom, EndingAt), no period of its own. */
export const ERP_MIRROR_COMPANY_DEF: CollectionDef = {
  name: "erpMirrorCompanyPeriod",
  tallyCollection: "Company",
  metadataType: "Company",
  category: "master",
  /* LastVoucherDate (D-1-5.43): the company's latest voucher date, so a period
     that ends before today can still be shown to hide nothing. A field Tally
     leaves empty is "not shown", never "nothing after" (G7). */
  fetch: ["Name", "Guid", "StartingFrom", "EndingAt", "LastVoucherDate"],
  timeout: 30_000,
  parallel: false,
};

/** Pure: the loaded period of the company named `company` from a Company collection; exactly one such company or it throws. */
export function loadedPeriodFromParsed(parsed: any, company: string): LoadedPeriod {
  const col = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;
  const all = tallyList(col?.COMPANY ?? col?.["COMPANY.LIST"]).map((c: any) => ({
    name: (tallyText(c?.["@_NAME"]) || tallyText(c?.NAME)).trim(), from: tallyText(c?.STARTINGFROM).trim() || null, to: tallyText(c?.ENDINGAT).trim() || null,
    lastVoucher: tallyText(c?.LASTVOUCHERDATE).trim() || null,
  }));
  const mine = all.filter((c) => c.name === company.trim());
  if (mine.length !== 1) throw new Error(`refused: the company period read found ${mine.length} companies named as this one (of ${all.length}), so the ledger balances would have no date; the run fails`);
  return { from: mine[0].from, to: mine[0].to, lastVoucher: mine[0].lastVoucher };
}

export interface MirrorLedgerRow {
  key: string;
  name: string;
  parent: string | null;
  closing_balance: number | null;
  opening_balance: number | null;
  alter_id: number | null;
  master_id: number | null;
  row: Record<string, unknown>;
  /** The date the balance is for: the end of the period Tally has loaded, YYYY-MM-DD (D-C.2). */
  balance_as_of: string;
}

/** One ledger as Tally sent it (strings), before it is checked. */
export interface TallyLedger {
  guid: string; name: string; parent: string; closingbalance: string; openingbalance: string; alterid: string; masterid: string;
  /** Part 7. Absent on a ledger the caller built without them. Tally sends a contact or tax tag only when it holds a value (dummy, 6-Nov-2026: 75 of 482 ledgers carry a phone tag and 75 are filled), so a missing tag is "none". `sent` is true when this ledger came back with the bill-wise tag, which Tally sends on every ledger (482 of 482): the proof the added fields were served at all. */
  phone?: string; mobile?: string; pan?: string; gstregistrationtype?: string; isbillwiseon?: string; sent?: boolean;
}

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

/**
 * Part 7. Pure: who entered a voucher and its bank instruments, for its mirror row. On a test run the
 * user name is a one-way stand-in and the instrument number is not stored (its date and how many are);
 * `extras_sent` is false for a voucher the caller built without them, so "none" and "not read" differ.
 */
export function voucherExtraFields(v: any, opts: { scrub: false } | { scrub: true; salt: string }): Record<string, unknown> {
  const x = v?.erpExtras as { enteredby: string; instruments: { number: string; date: string | null }[] } | undefined;
  if (!x) return { extras_sent: false };
  return {
    extras_sent: true,
    entered_by: x.enteredby ? (opts.scrub ? scrubName("USER", x.enteredby, opts.salt) : x.enteredby) : null,
    instrument_count: x.instruments.length,
    instruments: x.instruments.map((i) => ({ number: opts.scrub ? null : i.number || null, number_present: i.number !== "", date: i.date })),
  };
}

/** Pure: one converted voucher (convertVouchers output) to a staging row, or null when it has no GUID. */
export function mirrorRowFrom(v: any, opts: { scrub: false } | { scrub: true; salt: string }, tally?: { company: string }): MirrorRow | null {
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
      ...voucherExtraFields(v, opts),
      ledgers: lines.map((e: any) => ({ ledger: name("LEDGER", String(e.ledgername ?? "")), amount: money(e.amount), debit: e.isdeemedpositive === true })),
      /* The tally-shaped voucher and its lines for the go-live swap (erpTallyShape.ts); the database copies it out (erp_tally_derive). */
      ...(tally ? { tally: tallyBlobFrom(v, { company: tally.company, name, test: opts.scrub }) } : {}),
    },
  };
}

/**
 * Pure: a ledger balance as Tally writes it ("-1234.50", Tally's own sign,
 * negative is debit), through the one amount reader, parseTallyAmount, in its
 * strict mode (0120 M6): text after the number, other than Dr or Cr, throws,
 * so it can never be read as a number it is not (G7). Empty means Tally sent
 * none: null here; the row stores 0 and says so (ledgerRowFrom, M1).
 */
export function parseBalance(s: unknown): number | null {
  const n = parseTallyAmount(s, { strict: true });
  return n === null ? null : Math.round(n * 100) / 100;
}

/** Today in India, YYYY-MM-DD (never the UTC date). */
export function indiaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** The financial year to date that holds `asOf`: its 1 April to `asOf`. */
export function ledgerPeriod(asOf: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error(`refused: ${asOf} is not a YYYY-MM-DD date`);
  const y = Number(asOf.slice(0, 4)), mth = Number(asOf.slice(5, 7));
  return { from: `${mth >= 4 ? y : y - 1}-04-01`, to: asOf };
}

const MONTH_NUMBER: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * A date as Tally's Company object gives it to ISO, or null. Accepted, and
 * nothing else: YYYYMMDD (what a collection sends), YYYY-MM-DD, and
 * D-Mon-YYYY or DD-Mon-YYYY (how Tally prints a date for people). A two-digit
 * year (1-Apr-26) is refused: Tally prints one in reports, but no collection
 * read has been seen to send one, so it is not guessed (review 1-5 item 2,
 * D-1-5.38). A date that is not on the calendar is null too; null fails closed.
 */
export function tallyDateToIso(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  let iso: string | null = null;
  const num = /^(\d{4})(\d{2})(\d{2})$/.exec(s) ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (num) iso = `${num[1]}-${num[2]}-${num[3]}`;
  else {
    const mon = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
    const mm = mon ? MONTH_NUMBER[mon[2].toLowerCase()] : undefined;
    if (mon && mm) iso = `${mon[3]}-${mm}-${mon[1].padStart(2, "0")}`;
  }
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** The period Tally has loaded, as the Company object says (raw strings). */
export interface LoadedPeriod { from: string | null; to: string | null; lastVoucher?: string | null }

/**
 * Pure (D-C.2, D-1-5.43): the as-of date for a ledger read with no period is
 * the end of the period Tally has loaded. On the dummy (6-Nov-2026) that end
 * is the latest voucher date (EndingAt 5-Nov while the latest voucher was
 * 5-Nov), and it moved to 6-Nov the moment a voucher dated 6-Nov went in. So
 * a period that ends yesterday is normal on a morning before anyone types.
 *
 * The period is expected when all of these hold:
 *  - it starts on the financial year's 1 April (of today, India time);
 *  - it ends within that year;
 *  - no voucher Tally gave us is dated after its end: neither the latest
 *    date of this run's AlterID read nor the Company's LastVoucherDate;
 *  - if it ends before today, Tally gave a readable LastVoucherDate on or
 *    before the end (otherwise nothing shows the days after it are empty).
 * Anything else is balance_period_unexpected: the figures could leave out
 * vouchers, so they are never the year's or today's balances. An end date
 * that cannot be read refuses the run.
 * Weaker guarantee (P7): the AlterID read and LastVoucherDate come from the
 * same Tally; if a person narrowed the period by hand and Tally hid the later
 * vouchers from both, this cannot see it. The rig shows LastVoucherDate is
 * filled and agrees with the AlterID read.
 */
export function judgeLoadedPeriod(p: LoadedPeriod, today: string, latestVoucherDate: string | null): { asOf: string; from: string | null; unexpected: boolean; why: string | null } {
  const to = tallyDateToIso(p.to), from = tallyDateToIso(p.from);
  if (!to) throw new Error(`refused: Tally's loaded period has no end date that can be read (${JSON.stringify(p.to ?? null)}), so the ledger balances would have no date; the run fails and nothing is swapped`);
  const last = tallyDateToIso(p.lastVoucher);
  const fy = ledgerPeriod(today);
  const fyEnd = `${Number(fy.from.slice(0, 4)) + 1}-03-31`;
  const why = from !== fy.from ? `the loaded period starts ${from ?? "on no readable date"}, not ${fy.from}`
    : to > fyEnd ? `the loaded period ends ${to}, after the financial year ends ${fyEnd}`
    : to < fy.from ? `the loaded period ends ${to}, before it starts ${fy.from}`
    : latestVoucherDate && latestVoucherDate > to ? `Tally holds a voucher dated ${latestVoucherDate}, after the loaded period ends ${to}`
    : last && last > to ? `Tally's last voucher date is ${last}, after the loaded period ends ${to}`
    : to < today && !last ? `the loaded period ends ${to}, before today ${today}, and Tally gave no last voucher date (${JSON.stringify(p.lastVoucher ?? null)}) to show nothing is dated after it`
    : null;
  return { asOf: to, from, unexpected: why !== null, why };
}

/** Pure: why this ledger cannot be trusted as read, or null. */
export function ledgerProblem(l: TallyLedger): string | null {
  if (!String(l?.guid ?? "").trim()) return "no GUID";
  if (!String(l?.name ?? "").trim()) return "no name";
  try { parseBalance(l.closingbalance); parseBalance(l.openingbalance); } catch { return "a balance that does not parse"; }
  return null;
}

/**
 * Part 7. Pure: who entered each voucher and its bank instrument numbers and dates, by GUID, from
 * the parsed reply the converter also reads (the converter drops them, and it is shared with
 * today's sync, so they are read here instead). An instrument is read from BANKALLOCATIONS.LIST
 * under each ledger entry; a block with neither a number nor a date is a placeholder, not an instrument.
 */
export function voucherExtrasFromParsed(parsed: any): Map<string, { enteredby: string; instruments: { number: string; date: string | null }[] }> {
  const data = parsed?.ENVELOPE?.BODY?.DATA;
  const out = new Map<string, { enteredby: string; instruments: { number: string; date: string | null }[] }>();
  const vouchers: any[] = [];
  for (const msg of tallyList(data?.TALLYMESSAGE)) vouchers.push(...tallyList(msg?.VOUCHER ?? msg?.["VOUCHER.LIST"]));
  vouchers.push(...tallyList(data?.COLLECTION?.VOUCHER ?? data?.COLLECTION?.["VOUCHER.LIST"]));
  for (const v of vouchers) {
    const guid = tallyText(v?.GUID).trim() || tallyText(v?.["@_GUID"]).trim();
    if (!guid) continue;
    const instruments: { number: string; date: string | null }[] = [];
    for (const e of [...tallyList(v?.["ALLLEDGERENTRIES.LIST"] ?? v?.ALLLEDGERENTRIES), ...tallyList(v?.["LEDGERENTRIES.LIST"] ?? v?.LEDGERENTRIES)]) {
      for (const b of tallyList(e?.["BANKALLOCATIONS.LIST"] ?? e?.BANKALLOCATIONS)) {
        const number = tallyText(b?.INSTRUMENTNUMBER).trim(), date = isoOf(tallyText(b?.INSTRUMENTDATE));
        if (number || date) instruments.push({ number, date });
      }
    }
    out.set(guid, { enteredby: tallyText(v?.ENTEREDBY).trim(), instruments });
  }
  return out;
}

/** Part 7. Attach the extras to the converted vouchers, by GUID (the converted list is returned as it was, plus `erpExtras`). */
export function withVoucherExtras(list: any[], parsed: any): any[] {
  const extras = voucherExtrasFromParsed(parsed);
  for (const v of list) { const x = extras.get(String(v?.guid ?? "").trim()); if (x) v.erpExtras = x; }
  return list;
}

/**
 * Pure: one checked ledger to a staging row. Test runs store names only as
 * stand-ins. The judged period is required (review 1-5 item 4): without it a
 * row could never say its balance is for an unexpected period.
 */
export function ledgerRowFrom(l: TallyLedger, opts: { scrub: false } | { scrub: true; salt: string }, asOf: string,
  period: { from: string | null; unexpected: boolean; why: string | null }): MirrorLedgerRow {
  if (!period || typeof period.unexpected !== "boolean") throw new Error("refused: a ledger row needs the judged loaded period, so its balance can say whether it is the year to date");
  const name = (kind: string, s: string) => (opts.scrub ? scrubName(kind, s, opts.salt) : (s || "").trim() || null);
  const closing = parseBalance(l.closingbalance), opening = parseBalance(l.openingbalance);
  return {
    key: String(l.guid).trim(),
    name: name("LEDGER", l.name)!,
    parent: name("GROUP", l.parent),
    /* 0120 M1 (coordinator ruling, 6-Nov-2026): Tally leaves a nil balance
       empty and shows it as nil, today's converter writes it as 0 (convert.ts
       openingbalance) and live tally_ledgers holds 0, so 0 it is. The row
       keeps the marker. */
    closing_balance: closing ?? 0,
    opening_balance: opening ?? 0,
    alter_id: Number(l.alterid) || null,
    master_id: Number(l.masterid) || null,
    row: { closing_balance_sent: closing !== null, opening_balance_sent: opening !== null, balance_period_unexpected: period.unexpected,
      ...(period.unexpected ? { loaded_from: period.from, loaded_to: asOf, why: period.why } : {}),
      ...ledgerContactFields(l, opts) },
    balance_as_of: asOf,
  };
}

const yesNo = (s: unknown): boolean | null => { const t = String(s ?? "").trim().toLowerCase(); return t === "yes" ? true : t === "no" ? false : null; };

/**
 * Part 7. Pure: the contact and tax fields of one ledger for its mirror row. On a test run
 * the dummy is an old copy of the real books, so the phone, mobile and PAN themselves are
 * never stored (only whether each is there, so they can still be counted); the registration
 * type and bill-wise flag are not personal and are kept. `contact_fields_sent` is false when
 * the ledger did not come back with the bill-wise tag Tally sends on every ledger, so "none" and "not served" cannot be confused (G7).
 */
export function ledgerContactFields(l: TallyLedger, opts: { scrub: false } | { scrub: true; salt: string }): Record<string, unknown> {
  const t = (s: unknown) => String(s ?? "").trim();
  const phone = t(l.phone), mobile = t(l.mobile), pan = t(l.pan);
  return {
    contact_fields_sent: l.sent === true,
    has_phone: phone !== "", has_mobile: mobile !== "", has_pan: pan !== "",
    phone: opts.scrub ? null : phone || null,
    mobile: opts.scrub ? null : mobile || null,
    pan: opts.scrub ? null : pan || null,
    gst_registration_type: t(l.gstregistrationtype) || null,
    is_billwise_on: yesNo(l.isbillwiseon),
  };
}

/** Pure: the ledgers out of a parsed Ledger collection reply (the shape convertLedgers reads). */
export function ledgersFromParsed(parsed: any): TallyLedger[] {
  /* The converter's own field readers (0120 M6): typed values, the &#4;
     prefix Tally puts on group names, one element or a list. */
  const col = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;
  return tallyList(col?.LEDGER ?? col?.["LEDGER.LIST"]).map((l: any) => ({
    guid: tallyText(l?.GUID).trim(), name: (tallyText(l?.["@_NAME"]) || tallyText(l?.NAME)).trim(), parent: tallyText(l?.PARENT).trim(),
    closingbalance: tallyText(l?.CLOSINGBALANCE), openingbalance: tallyText(l?.OPENINGBALANCE), alterid: tallyText(l?.ALTERID), masterid: tallyText(l?.MASTERID),
    phone: tallyText(l?.LEDGERPHONE).trim(), mobile: tallyText(l?.LEDGERMOBILE).trim(), pan: tallyText(l?.INCOMETAXNUMBER).trim(),
    gstregistrationtype: tallyText(l?.GSTREGISTRATIONTYPE).trim(), isbillwiseon: tallyText(l?.ISBILLWISEON).trim(),
    sent: l != null && typeof l === "object" && "ISBILLWISEON" in l,
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
  highest(): Promise<{ alterId: number; latestDate: string | null; count: number; byDay: Record<string, number>; vouchers?: DayCheckVoucher[];
    /** Vouchers in the AlterID read whose date could not be read (thread 7 review 6): the latest date is then not known. */ undated?: number }>;
  /** Converted vouchers Tally returns for a one-day filter (the caller checks each is of that day). */
  vouchersOn(day: string): Promise<any[]>;
  /** Converted vouchers whose AlterID is above `mark` (any date). */
  changedSince(mark: number, upTo?: number): Promise<any[]>;
  /** Every ledger master with its closing balance for the loaded period (one request, no period: D-C.2). */
  ledgers(): Promise<TallyLedger[]>;
  /** The period Tally has loaded for the company (Company StartingFrom and EndingAt), D-C.2. */
  loadedPeriod(): Promise<LoadedPeriod>;
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
  /** The company key this store writes under; when set, every mirror row carries its tally-shaped block (go-live swap). */
  readonly companyKey?: string;
  /** Copy the tally-shaped blocks out of the mirror rows into the swap store (migration 0129). Optional so older stores still work. */
  deriveTally?(): Promise<Record<string, any>>;
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
  /** The last swapped full run that was not a re-pull, the planner's weekly clock (0120 M4). */
  lastFullRun(): Promise<{ run_id: string; finished_at: string } | null>;
  /** Runs this machine staged that were refused for a big drop and that an Owner has since accepted (0121). The list is the database's, never this agent's guess. */
  acceptedRuns(): Promise<AcceptedRun[]>;
  /** Swap one accepted run. The database uses the run's own recorded AlterID read as the mark and passes no floor: this call cannot lower one. */
  swapAccepted(run: string): Promise<SwapResult>;
}

/** One Owner acceptance waiting to be applied (migration 0121). */
export interface AcceptedRun { acceptance: string; run_id: string; accepted_at?: string; expires_at?: string }

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
      let alterId = 0, latest: string | null = null, undated = 0;
      const byDay: Record<string, number> = {};
      const vouchers: DayCheckVoucher[] = [];
      for (const v of list) {
        if (Number(v.alterid) > alterId) alterId = Number(v.alterid);
        const d = isoOf(v.date);
        if (!d) undated++;
        if (d) byDay[d] = (byDay[d] ?? 0) + 1;
        if (d && (!latest || d > latest)) latest = d;
        const a = String(v.alterid ?? "").trim();
        /* Tally never gives an AlterID of 0, and the converter turns a missing one into 0: so 0 is "missing". */
        vouchers.push({ k: String(v.guid ?? "").trim(), d, a: /^\d+$/.test(a) && Number(a) > 0 ? Number(a) : null });
      }
      /* Review 1-5 item 5: vouchers with no AlterID on any of them is a read
         that did not work (G7), not a mark of 0 to read everything above. */
      if (list.length > 0 && !(alterId > 0)) throw new Error(`refused: the AlterID read returned ${list.length} vouchers and no AlterID on any of them, so there is no mark; nothing is read or swapped`);
      return { alterId, latestDate: latest, count: list.length, byDay, vouchers, undated };
    },
    async vouchersOn(day: string) {
      const parsed = assertParsedCollection(await post(tallyUrl, buildCollectionXml(ERP_MIRROR_VOUCHER_DEF, company, day, day), ERP_MIRROR_VOUCHER_DEF.timeout, false), `the read of ${day}`);
      return withVoucherExtras(convertVouchers(parsed).tallymessage, parsed);
    },
    async changedSince(mark: number, upTo?: number) {
      const what = upTo === undefined ? `the read above AlterID ${mark}` : `the read of AlterIDs ${mark + 1} to ${upTo}`;
      const parsed = assertParsedCollection(await post(tallyUrl, buildChangedVoucherXml(ERP_MIRROR_VOUCHER_DEF, company, mark, upTo), ERP_MIRROR_VOUCHER_DEF.timeout, false), what);
      return withVoucherExtras(convertVouchers(parsed).tallymessage, parsed);
    },
    async ledgers() {
      /* D-C.2: no period, ever. A dated ledger read hung the dummy Tally (6-Nov-2026). */
      const parsed = assertParsedCollection(await post(tallyUrl, buildCollectionXml(ERP_MIRROR_LEDGER_DEF, company), ERP_MIRROR_LEDGER_DEF.timeout, false), "the ledger read");
      return ledgersFromParsed(parsed);
    },
    async loadedPeriod() {
      const parsed = assertParsedCollection(await post(tallyUrl, buildCollectionXml(ERP_MIRROR_COMPANY_DEF, company), ERP_MIRROR_COMPANY_DEF.timeout, false), "the company period read");
      return loadedPeriodFromParsed(parsed, company);
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
    companyKey,
    deriveTally: async () => call("erp_tally_derive", { p_company_key: companyKey, p_is_test: isTest }),
    start: async (kind, scope) => call("erp_sync_run_start", { p_company_key: companyKey, p_kind: kind, p_scope_from: scope?.from ?? null, p_scope_to: scope?.to ?? null, p_is_test: isTest }),
    step: async (run, step, state, rows, ms, detail) => { await call("erp_sync_run_step", { p_run: run, p_step: step, p_state: state, p_rows: rows ?? null, p_ms: ms ?? null, p_detail: detail ?? null }); },
    stage: async (run, rows) => Number(await call("erp_sync_stage", { p_run: run, p_rows: rows })),
    swap: async (run, mark) => call("erp_sync_swap", { p_run: run, p_mark_candidate: mark }),
    fail: async (run, error) => { await call("erp_sync_run_fail", { p_run: run, p_error: error }); },
    stageLedgers: async (run, rows) => Number(await call("erp_sync_stage_ledgers", { p_run: run, p_rows: rows })),
    repullStart: async () => (await call("erp_sync_repull_start", { p_company_key: companyKey, p_is_test: isTest })) ?? null,
    checkDays: async (tallyHighest, vouchers) => call("erp_sync_check_days", { p_company_key: companyKey, p_is_test: isTest, p_tally_highest: tallyHighest, p_vouchers: vouchers }),
    lastFullRun: async () => (await call("erp_sync_last_full_run", { p_company_key: companyKey, p_is_test: isTest })) ?? null,
    acceptedRuns: async () => {
      const data = await call("erp_sync_accepted_runs", { p_company_key: companyKey, p_is_test: isTest });
      /* An answer that is not a list is a fault, never "nothing accepted" (G7). */
      if (!Array.isArray(data)) throw new Error("erp_sync_accepted_runs: the answer is not a list, so nobody can say what was accepted");
      return data as AcceptedRun[];
    },
    /* The mark argument is required by the function but ignored for an accepted run: the database takes the run's own AlterID read. */
    swapAccepted: async (run) => call("erp_sync_swap", { p_run: run, p_mark_candidate: 0 }),
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
  /** The date the ledger balances are for: the end of Tally's loaded period (null when none were read). */
  ledgersAsOf: string | null;
  /** D-C.2: the loaded period, and whether it is the financial year to date. */
  ledgerPeriod?: { from: string | null; to: string; unexpected: boolean; why: string | null } | null;
  /** The answer of erp_tally_derive after a swap (go-live swap); null when not run. A failure here never fails the run. */
  tally?: Record<string, any> | null;
  tallyError?: string | null;
  /** The biggest single staging request of this run (item 15): its rows and its bytes of JSON. */
  largestBatchRows?: number;
  largestBatchBytes?: number;
}

const STAGE_BATCH = 500;
/** Review of thread 8, item 15: a voucher row now carries its tally-shaped block, so 500 rows can be many megabytes. A request holds at most this many bytes of JSON. */
export const STAGE_MAX_BYTES = 1_500_000;

/**
 * Pure: split rows into requests of at most `maxRows` rows AND at most `maxBytes` of JSON. A single row bigger than the cap
 * goes alone (it cannot be split), so no row is ever dropped. Order is kept.
 */
export function stageChunks<T>(rows: readonly T[], maxRows = STAGE_BATCH, maxBytes = STAGE_MAX_BYTES): T[][] {
  const out: T[][] = [];
  let cur: T[] = []; let bytes = 0;
  for (const r of rows) {
    const b = Buffer.byteLength(JSON.stringify(r), "utf8") + 1;
    if (cur.length > 0 && (cur.length >= maxRows || bytes + b > maxBytes)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(r); bytes += b;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** L3 (task 1-5): vouchers per incremental request at most. The busiest dummy day (245 vouchers with their lines) read in one request in 79 s. */
export const INCREMENTAL_CHUNK = 200;

/**
 * Pure (L3): the AlterID ranges (above, upTo] an incremental reads, each
 * holding at most `size` of the vouchers the AlterID read saw above the mark,
 * the last ending at Tally's highest. With no per-voucher list (an older
 * reader) it is one range, as before. Each range also says how many vouchers
 * the AlterID read counted in it, so a short reply can be refused.
 */
export function incrementalRanges(mark: number, highest: number, alterIds: readonly (number | null)[] | undefined, size = INCREMENTAL_CHUNK): { above: number; upTo: number; counted: number | null }[] {
  if (!(highest > mark)) return [{ above: mark, upTo: highest, counted: alterIds ? 0 : null }];
  if (!alterIds) return [{ above: mark, upTo: highest, counted: null }];
  const ids = alterIds.filter((a): a is number => typeof a === "number" && a > mark && a <= highest).sort((x, y) => x - y);
  const out: { above: number; upTo: number; counted: number | null }[] = [];
  let above = mark;
  for (let i = size; i < ids.length; i += size) { out.push({ above, upTo: ids[i - 1], counted: size }); above = ids[i - 1]; }
  out.push({ above, upTo: highest, counted: ids.length - out.length * size });
  return out;
}

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
  /** Today, for judging Tally's loaded period (default today in India). */
  today?: string;
  log?: (line: string) => void;
}): Promise<MirrorSyncReport> {
  return (await runMirror({ ...opts }))!;
}

/** One queued one-day re-pull (A11, 0119): a full read of that day that keeps the mark. Null when none is queued. */
export async function runRepull(opts: { store: MirrorStore; tally: MirrorTally; log?: (line: string) => void }): Promise<MirrorSyncReport | null> {
  return runMirror({ ...opts, kind: "repull" });
}

/**
 * How a copy into the swap store is written in the run diary (review of thread 8, item 14). "ok" only when the copy was whole:
 * every mirror voucher had its block and its deletes ran. A mirror voucher with no block, or deletes that were skipped, is
 * "info"; a day that the per-day floor held back (the database refused to delete from a day that lost too much) is "failed",
 * because the swap store then keeps rows the mirror no longer has. Pure.
 */
export function deriveStepState(t: Record<string, any> | null | undefined): { state: "ok" | "info" | "failed"; note: string | null } {
  if (!t) return { state: "failed", note: "the database gave no answer for the copy" };
  const floorDays = Number(t.day_floor_days ?? 0);
  if (floorDays > 0) return { state: "failed", note: `deletes held back by the per-day floor on ${floorDays} day(s)` };
  const without = Number(t.without_block ?? 0);
  if (without > 0) return { state: "info", note: `${without} mirror voucher(s) have no tally-shaped block, so no delete ran` };
  if (t.deletes_skipped === true) return { state: "info", note: "deletes were skipped" };
  return { state: "ok", note: null };
}

/** After a swap: copy the mirror's tally-shaped blocks into the swap store. The mirror itself is already swapped, so a failure here is reported, never thrown. */
async function deriveAfterSwap(store: MirrorStore, runId: string, report: { tally?: Record<string, any> | null; tallyError?: string | null }, log: (l: string) => void): Promise<void> {
  try {
    const t0 = Date.now();
    report.tally = await store.deriveTally!();
    const { state, note } = deriveStepState(report.tally);
    if (state !== "ok") { if (state === "failed") report.tallyError = note; log(`tally rows copied with a warning: ${note}`); }
    await store.step(runId, state === "ok" ? "copied the tally-shaped rows for the go-live swap" : `copied the tally-shaped rows for the go-live swap, but ${note}`, state, null, Date.now() - t0, report.tally);
  } catch (e) {
    report.tallyError = e instanceof Error ? e.message : String(e);
    log(`tally rows not derived: ${report.tallyError}`);
    try { await store.step(runId, "could not copy the tally-shaped rows for the go-live swap", "failed", null, null, { error: report.tallyError.slice(0, 500) }); } catch { /* reported above */ }
  }
}

async function runMirror(opts: {
  store: MirrorStore; tally: MirrorTally; kind: "full" | "incremental" | "repull";
  scope?: { from: string; to: string };
  ledgers?: boolean;
  today?: string;
  log?: (line: string) => void;
}): Promise<MirrorSyncReport | null> {
  const { store, tally, kind } = opts;
  if (store.isTest && !store.scrubSalt) throw new Error("refused: a test run must scrub names, and the store has no salt");
  const scrubOpts = store.isTest ? { scrub: true as const, salt: store.scrubSalt! } : { scrub: false as const };
  const log = opts.log ?? ((l: string) => console.log(`[erpMirror] ${l}`));
  const report: MirrorSyncReport = { run_id: null, kind, state: "failed", scope: null, markCandidate: null, read: 0, staged: 0, noGuid: 0, swap: null, error: null, tallyReads: 0, ledgers: null, ledgersAsOf: null };
  const run = kind === "repull" ? await store.repullStart() : await store.start(kind, opts.scope);
  if (!run) return null;
  const readLedgers = kind !== "repull" && opts.ledgers !== false;
  report.run_id = run.run_id;
  report.scope = { from: run.scope_from, to: run.scope_to };
  const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => { const t0 = Date.now(); const v = await fn(); return [v, Date.now() - t0]; };
  let buffer: MirrorRow[] = [];
  const flush = async () => {
    const chunks = stageChunks(buffer);
    buffer = [];
    for (const part of chunks) {
      report.staged = await store.stage(run.run_id, part);
      report.largestBatchBytes = Math.max(report.largestBatchBytes ?? 0, Buffer.byteLength(JSON.stringify(part), "utf8"));
      report.largestBatchRows = Math.max(report.largestBatchRows ?? 0, part.length);
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
      buffer.push(mirrorRowFrom(v, scrubOpts, store.companyKey ? { company: store.companyKey } : undefined)!);
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
        /* Review 1-5 item 1 (D-1-5.37): an empty or short reply never means
           "nothing there". The AlterID read just before counted this day's
           vouchers; a day read with fewer refuses the run before the day can
           be pruned. More is fine (vouchers made since). */
        const counted = top.byDay[day] ?? 0;
        if (list.length < counted) throw new Error(`refused: the read of ${day} returned ${list.length} vouchers, but Tally's AlterID read just before counted ${counted} on that day; a short reply is not "fewer vouchers", so the run fails and nothing is swapped`);
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
      /* L3: read in AlterID ranges of at most INCREMENTAL_CHUNK vouchers, up to
         the highest read just before; the last range is open-ended. A range read with fewer
         vouchers than the AlterID read counted in it refuses the run, like a
         short day read (D-1-5.37); more is fine. */
      const ranges = incrementalRanges(from, top.alterId, top.vouchers?.map((v) => v.a));
      /* Thread 7 review 4: the check is on the SET of vouchers, not the count. Every voucher
         (GUID and AlterID) the AlterID read listed above the mark must come back with that
         AlterID or a higher one (a voucher edited meanwhile has a higher one, and may sit in a
         later range); extras are fine. A range that is short is read once more before the run
         fails, because a short reply is not "fewer changes". */
      const wanted = (top.vouchers ?? []).filter((v) => v.k && v.a !== null && v.a > from && v.a <= top.alterId);
      const got = new Map<string, number>();
      const note = (list: any[]) => { for (const v of list) { const g = String(v?.guid ?? "").trim(), a = Number(v?.alterid); if (g && Number.isFinite(a) && a > (got.get(g) ?? -1)) got.set(g, a); } };
      const missingIn = (r: { above: number; upTo: number }) => wanted.filter((v) => v.a! > r.above && v.a! <= r.upTo && (got.get(v.k) ?? -1) < v.a!);
      for (const [i, r] of ranges.entries()) {
        /* The last range has no upper bound (the request as before chunking), so a voucher edited again meanwhile is read, not missed. */
        const last = i === ranges.length - 1;
        const [list, ms] = await timed(() => last ? tally.changedSince(r.above) : tally.changedSince(r.above, r.upTo));
        report.tallyReads++;
        note(list);
        take(list, last ? `the read above AlterID ${r.above}` : `the read of AlterIDs ${r.above + 1} to ${r.upTo}`, null);
        await store.step(run.run_id, last ? `read every voucher above AlterID ${r.above}` : `read AlterIDs ${r.above + 1} to ${r.upTo}`, "ok", list.length, ms, null);
        if (buffer.length >= STAGE_BATCH) await flush();
      }
      /* Judged after all ranges, so a voucher that moved up into a later range is found there. */
      for (const [i, r] of ranges.entries()) {
        if (!missingIn(r).length) continue;
        const last = i === ranges.length - 1;
        const [again, msA] = await timed(() => last ? tally.changedSince(r.above) : tally.changedSince(r.above, r.upTo));
        report.tallyReads++;
        /* Only what the first read did not bring (or brought with a lower AlterID) is kept again. */
        const fresh = again.filter((v) => (got.get(String(v?.guid ?? "").trim()) ?? -1) < Number(v?.alterid));
        note(again);
        take(fresh, `the second read of AlterIDs ${r.above + 1} to ${r.upTo}`, null);
        await store.step(run.run_id, `read AlterIDs ${r.above + 1} to ${r.upTo} again (a voucher the AlterID read listed was missing)`, "info", again.length, msA, { still_missing: missingIn(r).length });
        if (buffer.length >= STAGE_BATCH) await flush();
      }
      const lost = ranges.flatMap((r) => missingIn(r));
      if (lost.length) {
        const sample = lost.slice(0, 5).map((v) => `AlterID ${v.a}`).join(", ");
        throw new Error(`refused: ${lost.length} of the ${wanted.length} vouchers Tally's AlterID read listed above the mark did not come back, even on a second read (${sample}); a short reply is not "fewer changes", so the run fails and nothing is swapped`);
      }
    }
    await flush();
    await store.step(run.run_id, "staged", "ok", report.staged, null, null);
    if (readLedgers) {
      /* M-6: the ledgers and their closing balances, one request, checked
         before any is kept. An empty list is never "no ledgers". */
      /* D-C.2: the balances are for the period Tally has loaded; its end is the as-of date. */
      const loaded = await tally.loadedPeriod();
      report.tallyReads++;
      let period = judgeLoadedPeriod(loaded, opts.today ?? indiaToday(), top.latestDate);
      /* Thread 7 review 6: a voucher whose date cannot be read is not skipped in silence. The latest voucher date is then not known, so the figures are never taken as the year's. */
      if (!period.unexpected && (top.undated ?? 0) > 0) period = { ...period, unexpected: true, why: `${top.undated} voucher(s) in the AlterID read have a date that could not be read, so the latest voucher date is not known` };
      const asOf = period.asOf;
      const [list, msL] = await timed(() => tally.ledgers());
      report.tallyReads++;
      /* D-1-5.43: the period is read again after the ledgers. If it moved (a
         voucher went in meanwhile), the figures' date is not known. */
      const again = await tally.loadedPeriod();
      report.tallyReads++;
      if (!period.unexpected && (again.from !== loaded.from || again.to !== loaded.to || (again.lastVoucher ?? null) !== (loaded.lastVoucher ?? null))) {
        period = { ...period, unexpected: true, why: `the loaded period moved during the ledger read (${loaded.from} to ${loaded.to}, then ${again.from} to ${again.to})` };
      }
      if (period.unexpected) log(`ledger read flagged balance_period_unexpected: ${period.why}`);
      if (!list.length) throw new Error("refused: the ledger read came back empty, which is not a list of ledgers, so the run fails and nothing is swapped");
      /* Part 7 canary: Tally sends the bill-wise tag on every ledger. If not one ledger has it, the added contact and tax fields were not served, and "no phone anywhere" would be a lie. */
      if (list.every((l) => l.sent === false)) throw new Error(`refused: none of the ${list.length} ledgers came back with the bill-wise tag Tally sends on every ledger, so the added contact and tax fields were not served; the run fails and nothing is swapped`);
      const problems = list.map(ledgerProblem).filter((p): p is string => !!p);
      if (problems.length) {
        const counts = [...new Set(problems)].map((p) => `${problems.filter((x) => x === p).length} with ${p}`).join("; ");
        throw new Error(`refused: the ledger read returned ledgers that cannot be trusted as read (${counts}), so the run fails and nothing is swapped`);
      }
      const rows = list.map((l) => ledgerRowFrom(l, scrubOpts, asOf, period));
      let n = 0;
      for (const part of stageChunks(rows)) n = await store.stageLedgers(run.run_id, part);
      report.ledgers = n;
      report.ledgersAsOf = asOf;
      report.ledgerPeriod = { from: period.from, to: asOf, unexpected: period.unexpected, why: period.why };
      await store.step(run.run_id, period.unexpected ? "read and staged the ledgers, flagged balance_period_unexpected" : "read and staged the ledgers with their closing balances", "ok", n, msL,
        { balance_as_of: asOf, loaded_from: period.from, balance_period_unexpected: period.unexpected, why: period.why, closing_balance_sent: rows.filter((r) => r.row.closing_balance_sent).length });
    }
    const [res, msS] = await timed(() => store.swap(run.run_id, top.alterId));
    report.swap = res;
    report.state = res.state;
    await store.step(run.run_id, res.state === "swapped" ? "swapped into the mirror" : `refused: ${res.reason}`, res.state === "swapped" ? "ok" : "failed", null, msS, res);
    log(`${kind} run ${run.run_id}: ${res.state} (${JSON.stringify(res)})`);
    if (res.state === "swapped" && store.deriveTally) await deriveAfterSwap(store, run.run_id, report, log);
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

/** What an Owner-accepted drop did when the agent applied it (task 1-5, migration 0121). */
export interface AcceptedDropReport { run_id: string; acceptance: string; state: "swapped" | "refused" | "failed"; reason: string | null; error: string | null; tally?: Record<string, any> | null; tallyError?: string | null }

/**
 * Apply the big drops an Owner has accepted, one run at a time. The agent does
 * not decide anything here: the database lists the accepted runs, and its swap
 * checks the acceptance again (not older than 6 hours, no other swap since, the
 * staged read unchanged) and uses the run's own recorded AlterID read as the
 * mark. A run that is refused again, or that throws, is reported and the next
 * is still tried; nothing is hidden and nothing is retried here.
 */
export async function applyAcceptedDrops(opts: { store: MirrorStore; log?: (line: string) => void }): Promise<AcceptedDropReport[]> {
  const log = opts.log ?? ((l: string) => console.log(`[erpMirror] ${l}`));
  const list = await opts.store.acceptedRuns();
  const out: AcceptedDropReport[] = [];
  for (const a of list) {
    try {
      const r = await opts.store.swapAccepted(a.run_id);
      const state = r.state === "swapped" ? "swapped" : "refused";
      const entry: AcceptedDropReport = { run_id: a.run_id, acceptance: a.acceptance, state, reason: state === "swapped" ? null : String(r.reason ?? "refused"), error: null };
      out.push(entry);
      /* The same copy and the same diary line as after an ordinary swap: a derive failure is recorded on the run, not only logged. */
      if (state === "swapped" && opts.store.deriveTally) await deriveAfterSwap(opts.store, a.run_id, entry, log);
      log(`accepted drop of run ${a.run_id}: ${state}${state === "refused" ? ` (${String(r.reason ?? "")}: ${String(r.why ?? "")})` : ""}`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      out.push({ run_id: a.run_id, acceptance: a.acceptance, state: "failed", reason: null, error });
      log(`accepted drop of run ${a.run_id}: failed, ${error}`);
    }
  }
  return out;
}

export type MirrorWork = "apply_accepted" | "full" | "incremental" | "check" | "repull";

/**
 * Pure: what the mirror runs next, in order (A7 weekly full, A11 nightly
 * check). A full run when there is no mark, when one is due, or when the last
 * full one swapped 7 or more days ago; otherwise an incremental. Then the
 * nightly check when none ran for 20 hours, then any queued re-pulls. Nothing
 * in index.ts runs it until go-live. When an Owner has accepted a refused big
 * drop (acceptedDrops > 0) that comes first, before any run that would swap.
 */
export function planMirrorWork(s: { now: Date; hasMark: boolean; fullDue: boolean; lastFullAt: Date | null; lastCheckAt: Date | null; queuedRepulls: number; acceptedDrops?: number }): MirrorWork[] {
  const hours = (d: Date | null) => (d ? (s.now.getTime() - d.getTime()) / 3_600_000 : Infinity);
  const out: MirrorWork[] = [];
  /* An Owner's accepted drop goes first: it expires after 6 hours and is void if any other swap runs before it. */
  if ((s.acceptedDrops ?? 0) > 0) out.push("apply_accepted");
  out.push(!s.hasMark || s.fullDue || hours(s.lastFullAt) >= 7 * 24 ? "full" : "incremental");
  if (hours(s.lastCheckAt) >= 20) out.push("check");
  if (s.queuedRepulls > 0) out.push("repull");
  return out;
}
