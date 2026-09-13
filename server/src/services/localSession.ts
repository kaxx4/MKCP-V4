/**
 * Reading vouchers back out of Tally, for a session that never touches Supabase.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * This computer holds Tally open on a DUPLICATE company while the real books
 * live elsewhere. Everything the rebuild has built — pushing a voucher,
 * converting an order, correcting a narration, cancelling an invoice — needs to
 * be exercisable here end to end before any of it goes near the shared mirror.
 *
 * The write half already exists and is guarded: `safePush` resolves master
 * names, runs the preflight guard, serialises against Tally's single-threaded
 * port, and diffs what Tally actually stored. What was missing was the read
 * half — a plain "what is in the books on this day".
 *
 * ── One implementation, not six ───────────────────────────────────────────
 *
 * Six harnesses had each written their own copy of this query, and they drifted:
 * different field lists, and one of them matched `<VOUCHER\b` which also catches
 * the `<VOUCHER>0</VOUCHER>` COUNT tag in Tally's <CMPINFO> preamble. This is
 * the one implementation, with that trap handled once.
 */
import { tallyPost } from "../tally.js";

export interface VoucherSummary {
  guid: string;
  masterId: string;
  voucherNumber: string;
  voucherType: string;
  date: string;
  party: string;
  narration: string;
  isCancelled: boolean;
  isOptional: boolean;
  /** Ledger name → signed amount, as Tally stores it. */
  ledgers: { name: string; amount: number }[];
  /** Total of the debit side, which is what a person means by "the amount". */
  amount: number;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const fld = (v: string, t: string): string => {
  const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i").exec(v);
  return m ? m[1].trim() : "";
};

const num = (s: string): number => {
  const m = /^\s*(-?[\d.]+)/.exec(String(s).replace(/,/g, ""));
  return m ? parseFloat(m[1]) : NaN;
};

const yes = (s: string) => /^yes$/i.test(s.trim());

/**
 * Every voucher on ONE day.
 *
 * Deliberately one day. Entry blocks (`AllLedgerEntries`) across a wider range
 * are 64x the payload and wedge Tally's single-threaded port — a year-wide pull
 * once timed out at 240s and kept the port busy for another 77s afterwards.
 */
export async function vouchersOnDay(
  tallyUrl: string,
  company: string,
  isoDate: string,
): Promise<VoucherSummary[]> {
  const stamp = isoDate.replace(/-/g, "");
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkLocal</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkLocal" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD>
<NATIVEMETHOD>Guid</NATIVEMETHOD><NATIVEMETHOD>MasterId</NATIVEMETHOD>
<NATIVEMETHOD>Narration</NATIVEMETHOD><NATIVEMETHOD>IsCancelled</NATIVEMETHOD>
<NATIVEMETHOD>IsOptional</NATIVEMETHOD><NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD>
<FILTER>MkLocalF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MkLocalF">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${stamp}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;

  const raw: string = await tallyPost(tallyUrl, xml, 180_000, true);

  /* `<VOUCHER ` WITH WHITESPACE, never `<VOUCHER\b`.
     Every response opens with a <CMPINFO> preamble of count tags, one of which
     is literally `<VOUCHER>0</VOUCHER>`. A \b pattern matches that too and it
     carries no fields, so it arrives as a blank voucher in the list. Real
     voucher elements always carry attributes (REMOTEID, VCHTYPE, VCHKEY); the
     count tag never does. */
  const blocks = [...raw.matchAll(/<VOUCHER\s[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]);

  return blocks.map((b) => {
    const ledgers: { name: string; amount: number }[] = [];
    /* ALLLEDGERENTRIES only. `LEDGERENTRIES.LIST` is a PARTIAL view of the same
       postings, so reading both double-counts every amount — which is exactly
       what made an early harness report 35 failures that were all its own. */
    for (const [, e] of b.matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/g)) {
      const name = fld(e, "LEDGERNAME");
      const amt = num(fld(e, "AMOUNT"));
      if (name && Number.isFinite(amt)) ledgers.push({ name, amount: amt });
    }
    const dateRaw = fld(b, "DATE");
    return {
      guid: fld(b, "GUID"),
      masterId: fld(b, "MASTERID"),
      voucherNumber: fld(b, "VOUCHERNUMBER"),
      voucherType: fld(b, "VOUCHERTYPENAME"),
      date: /^\d{8}$/.test(dateRaw)
        ? `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`
        : dateRaw,
      party: fld(b, "PARTYLEDGERNAME"),
      narration: fld(b, "NARRATION"),
      isCancelled: yes(fld(b, "ISCANCELLED")),
      isOptional: yes(fld(b, "ISOPTIONAL")),
      ledgers,
      // The debit side. Tally stores debits negative, so flip the sign back.
      amount: ledgers.filter((l) => l.amount < 0).reduce((t, l) => t - l.amount, 0),
    };
  });
}
