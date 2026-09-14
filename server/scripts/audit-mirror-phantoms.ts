/**
 * Which vouchers does the Supabase mirror hold that Tally no longer has?
 *
 * READ-ONLY, always. It names the rows; pruning them is a separate, guarded
 * operation — see the note it prints.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * A voucher deleted in Tally is not automatically removed downstream. The sync
 * prunes per DAY, and only for days a pull actually covered — so anything
 * deleted outside a synced window simply stays in the mirror forever, and the
 * dashboard keeps serving it as real.
 *
 * `status-check` reports the gap in aggregate ("16 buckets have more rows
 * downstream than in Tally"). This names the actual rows, because a count is
 * not enough to decide whether they are test pollution or someone's real
 * voucher that was deleted by mistake — and those two want opposite actions.
 *
 *   npx tsx scripts/audit-mirror-phantoms.ts [days]
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const DAYS = parseInt(process.argv.find((a) => /^\d+$/.test(a)) ?? "14", 10);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fld = (v: string, t: string) => {
  const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i").exec(v);
  return m ? m[1].trim() : "";
};
const ymd = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * Vouchers in Tally for ONE day. No entry blocks — this only needs identity,
 * and entry blocks across several days are what wedges Tally's port.
 */
async function tallyDay(company: string, iso: string): Promise<Set<string>> {
  const stamp = iso.replace(/-/g, "");
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkPh</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkPh" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>Guid</NATIVEMETHOD>
<FILTER>MkPhF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MkPhF">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${stamp}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw: string = await tallyPost(U, xml, 120_000, true);
  const out = new Set<string>();
  /* ⚠ MATCH `<VOUCHER ` WITH WHITESPACE, NOT `<VOUCHER\b`.
     Every Tally response opens with a <CMPINFO> preamble of COUNT tags, one of
     which is literally `<VOUCHER>0</VOUCHER>`. A \b pattern matches that too,
     and it carries no GUID — so a junk entry lands in the parsed list and any
     count taken from it is one too high.

     Here it changed nothing (the phantom total was 58 before and after the
     fix), because the entry contributes no GUID to the set either way. It is
     fixed anyway: the same \b pattern is copied through several harnesses, and
     in one that counts vouchers rather than filtering them by number it would
     be an off-by-one that nobody would think to question.

     Real voucher elements always carry attributes (REMOTEID, VCHTYPE, VCHKEY);
     the count tag never does. */
  for (const m of raw.matchAll(/<VOUCHER\s[^>]*>[\s\S]*?<\/VOUCHER>/g)) {
    const id = fld(m[0], "GUID");
    if (id) out.add(id);
  }
  return out;
}

(async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required.");
    process.exit(1);
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;

  const from = new Date();
  from.setDate(from.getDate() - (DAYS - 1));

  console.log(`\n\x1b[1mMirror rows with no voucher behind them\x1b[0m\n`);
  console.log(`company  "${company}"`);
  console.log(`window   ${ymd(from)} → ${ymd(new Date())} (${DAYS} days)`);
  console.log(`mode     read-only\n`);

  let phantomTotal = 0;

  for (let i = 0; i < DAYS; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    const iso = ymd(d);

    const { data, error } = await sb
      .from("tally_vouchers")
      .select("guid, voucher_number, voucher_type, date")
      .eq("company", company)
      .eq("date", iso);
    if (error) { console.error(`  ${iso}  supabase error: ${error.message}`); continue; }
    const rows = data ?? [];
    if (rows.length === 0) continue;

    const inTally = await tallyDay(company, iso);
    const phantoms = rows.filter((r) => !inTally.has(String(r.guid)));
    if (phantoms.length === 0) {
      console.log(`  ${iso}  \x1b[32m✓\x1b[0m ${rows.length} row(s), all present in Tally`);
      continue;
    }

    phantomTotal += phantoms.length;
    console.log(`  ${iso}  \x1b[33m${phantoms.length} phantom(s)\x1b[0m of ${rows.length} row(s) · Tally has ${inTally.size}`);
    for (const p of phantoms.slice(0, 12)) {
      console.log(`        ${String(p.voucher_type ?? "?").padEnd(18)} ${p.voucher_number ?? "(no number)"}`);
    }
    if (phantoms.length > 12) {
      console.log(`        … and ${phantoms.length - 12} more`);
    }
  }

  console.log(`\n${phantomTotal} phantom row(s) across the window.`);

  console.log(`
These rows exist downstream and not in the company Tally currently has open.

⚠ DO NOT "FIX" THIS BY SYNCING UNTIL YOU KNOW WHICH COMPANY IS OPEN.

  Tally exposes ONE company name, and a duplicate carries the SAME name as the
  original. The mirror is keyed on that name alone, so it cannot tell a sandbox
  from the real books — both write to the same rows.

  If these rows came from the REAL company and a DUPLICATE is open now, then a
  daily sync would prune real vouchers out of the mirror, day by day, and every
  one of them would look like a voucher legitimately deleted in Tally. That is
  the destructive outcome, and it is indistinguishable from the safe one from
  in here.

  So: confirm which company is open FIRST. A quick tell is whether it contains
  test vouchers — a sandbox does, the real books do not.

  Once you are certain the open company is authoritative:

      POST /api/tally/sync-daybook  { chunkMode: "daily", fromDate, toDate }

  which prunes via delete_voucher_orphans_for_days, using the guids Tally
  actually returned. That path carries a mass-deletion guard (it returns -1 and
  refuses rather than emptying a day wholesale). Never hand-roll the DELETE —
  on this table the last accident cost a year of data.
`);
})();
