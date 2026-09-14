/**
 * Tally ↔ Supabase reconciliation.
 *
 * One of the two things the owner has asked for repeatedly: a standing check
 * that says green or red, rather than a dashboard you have to cross-check by
 * opening Tally.
 *
 * It matters more than it sounds. The system's signature failure is that
 * everything degrades gracefully — a sync that silently stops looks exactly like
 * a quiet week, and the September prune incident completed its damage before
 * anything reported a failure. Counting both sides per day and per voucher type
 * turns "did everything arrive?" into a number.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { tallyPost } from "../tally.js";
import { requireSupabase } from "./supabaseClient.js";

export interface DayTypeCount { date: string; voucherType: string; tally: number; supabase: number; }
export interface ReconcileReport {
  company: string;
  from: string;
  to: string;
  ok: boolean;
  tallyTotal: number;
  supabaseTotal: number;
  /** Only the buckets that disagree. */
  mismatches: DayTypeCount[];
  /** Days present in Tally with nothing at all in Supabase — the loud case. */
  missingDays: string[];
  checkedAt: string;
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fld = (b: string, t: string) => {
  const m = new RegExp(`<${t}[^>]*>([^<]*)</${t}>`).exec(b);
  return m ? m[1].trim() : "";
};
/** YYYY-MM-DD → D-Mon-YYYY */
const tallyDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d}-${MONTHS[m - 1]}-${y}`;
};

/* Throws rather than degrading: reconcile exists to REPORT a gap, and one that
   silently reports nothing is worse than one that says it cannot run. */
function supa(): SupabaseClient {
  return requireSupabase("Reconciliation");
}

/**
 * Count vouchers per day and type as Tally holds them.
 *
 * Uses a Collection with a TDL date filter, NOT the Day Book report. Verified
 * 2026-09-10: Day Book **ignores `SVFROMDATE`/`SVTODATE` on this install** —
 * three different ranges returned byte-identical responses containing only the
 * current date. A reconciliation built on it would report every historical day
 * as missing. (The same caveat applies to `buildDayBookXml` in xmlBuilder.ts,
 * which the sync agent uses as a fallback.)
 */
async function countFromTally(tallyUrl: string, company: string, from: string, to: string) {
  const fromInt = parseInt(from.replace(/-/g, ""), 10);
  const toInt = parseInt(to.replace(/-/g, ""), 10);
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkReconcile</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${escXml(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE>
<COLLECTION NAME="MkReconcile" ISMODIFY="No">
<TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD>
<NATIVEMETHOD>IsCancelled</NATIVEMETHOD>
<NATIVEMETHOD>IsOptional</NATIVEMETHOD>
<FILTER>MkReconcileDates</FILTER>
</COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MkReconcileDates">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) &gt;= ${fromInt} AND ($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) &lt;= ${toInt}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;

  const resp: string = await tallyPost(tallyUrl, xml, 300_000, true);
  const counts = new Map<string, number>();
  for (const m of resp.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)) {
    const b = m[0];
    // Cancelled and optional vouchers are drafts, not postings — the sync
    // excludes them, so counting them here would manufacture a false mismatch.
    if (/<ISCANCELLED>Yes<\/ISCANCELLED>/.test(b)) continue;
    if (/<ISOPTIONAL>Yes<\/ISOPTIONAL>/.test(b)) continue;
    const date = fld(b, "DATE");
    const type = fld(b, "VOUCHERTYPENAME");
    if (!date || !type) continue;
    const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    const key = `${iso}|${type.toUpperCase()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** The same counts as Supabase holds them. */
async function countFromSupabase(company: string, from: string, to: string) {
  const client = supa();
  const counts = new Map<string, number>();
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await client
      .from("tally_vouchers")
      .select("date, voucher_type, is_cancelled, is_optional")
      .eq("company", company)
      .gte("date", from)
      .lte("date", to)
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`Supabase read failed: ${error.message}`);
    if (!data?.length) break;
    for (const row of data) {
      if (row.is_cancelled || row.is_optional) continue;
      const key = `${row.date}|${String(row.voucher_type ?? "").toUpperCase()}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (data.length < PAGE) break;
  }
  return counts;
}

export async function reconcile(
  tallyUrl: string,
  company: string,
  from: string,
  to: string
): Promise<ReconcileReport> {
  const [tally, supabase] = await Promise.all([
    countFromTally(tallyUrl, company, from, to),
    countFromSupabase(company, from, to),
  ]);

  const keys = new Set([...tally.keys(), ...supabase.keys()]);
  const mismatches: DayTypeCount[] = [];
  let tallyTotal = 0, supabaseTotal = 0;
  const tallyDays = new Set<string>(), supaDays = new Set<string>();

  for (const key of keys) {
    const [date, voucherType] = key.split("|");
    const t = tally.get(key) ?? 0;
    const s = supabase.get(key) ?? 0;
    tallyTotal += t; supabaseTotal += s;
    if (t > 0) tallyDays.add(date);
    if (s > 0) supaDays.add(date);
    if (t !== s) mismatches.push({ date, voucherType, tally: t, supabase: s });
  }

  mismatches.sort((a, b) => a.date.localeCompare(b.date) || a.voucherType.localeCompare(b.voucherType));
  const missingDays = [...tallyDays].filter(d => !supaDays.has(d)).sort();

  return {
    company, from, to,
    ok: mismatches.length === 0,
    tallyTotal, supabaseTotal, mismatches, missingDays,
    checkedAt: new Date().toISOString(),
  };
}

/** One-line summary for a log or a status panel. */
export function summarise(r: ReconcileReport): string {
  if (r.ok) return `✓ reconciled ${r.from}..${r.to}: ${r.tallyTotal} vouchers, Tally and Supabase agree.`;
  const worst = r.mismatches.slice(0, 3)
    .map(m => `${m.date} ${m.voucherType} ${m.tally}≠${m.supabase}`).join("; ");
  return `✗ ${r.mismatches.length} mismatch(es) ${r.from}..${r.to} — Tally ${r.tallyTotal} vs Supabase ${r.supabaseTotal}`
    + (r.missingDays.length ? `, ${r.missingDays.length} day(s) absent from Supabase` : "")
    + `. ${worst}`;
}
