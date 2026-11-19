/**
 * PROBE (A-3, 19-Nov-2026): can "Sync now" skip the days that did not change?
 *
 * Today a "last N days" sync re-reads every voucher of every day with its full entry blocks. The idea: first read only Guid, Date and
 * AlterID for the whole window (the "fingerprint"), compare each day with the mirror, and fully read only the days that differ.
 * This measures, on whichever company Tally has open, what the fingerprint costs against the full day reads it would replace.
 *
 * READ ONLY. Every request goes through the circuit breaker, one at a time, and holds the shared lock file. Same collection, same
 * date filter, same TYPE as the real daily read (buildCollectionXml), only fewer fields. Run on the laptop's dummy Tally:
 *   npx tsx server/scripts/probe-day-fingerprint.ts
 */
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { withTally } from "../src/services/tallyGate.js";
import { buildCollectionXml } from "../src/services/xmlBuilder.js";
import { TRANSACTION_COLLECTIONS } from "../src/config/collections.js";
import { SupabaseSync } from "../src/services/supabaseSync.js";
import { convertVouchers, convertCompanies } from "../src/converters/convert.js";
import { buildPrints, daysToRead } from "../src/services/dayFingerprint.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const LOCK = process.env.MKCP_TALLY_LOCK || "C:/Users/kanis/AppData/Local/Temp/claude/26cbb7c21c52055a/5b2c40ab-14be-417f-aeeb-84a1475231d5/scratchpad/tally.lock";

const post = (xml: string, timeoutMs: number) =>
  withTally(TALLY_URL, "probe-fingerprint", () => tallyPost(TALLY_URL, xml, timeoutMs, true)) as Promise<string>;

const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

async function timed(label: string, xml: string, timeoutMs = 120_000) {
  const t = Date.now();
  const raw = await post(xml, timeoutMs);
  const ms = Date.now() - t;
  const guids = [...raw.matchAll(/<GUID[^>]*>([^<]+)<\/GUID>/g)].map((m) => m[1].trim());
  const dates = [...raw.matchAll(/<DATE[^>]*>(\d{8})<\/DATE>/g)].map((m) => m[1]);
  console.log(`${label.padEnd(34)} ${String(ms).padStart(6)} ms ${String(Math.round(raw.length / 1024)).padStart(7)} KB ${String(guids.length).padStart(5)} vouchers`);
  return { ms, bytes: raw.length, guids, dates, raw };
}

async function main() {
  if (existsSync(LOCK)) { console.log(`CANNOT RUN: ${LOCK} is held by another Tally user.`); process.exit(2); }
  writeFileSync(LOCK, `probe-day-fingerprint ${process.pid} ${new Date().toISOString()}`);
  try {
    const companies = convertCompanies(await withTally(TALLY_URL, "probe-fingerprint", () => tallyPost(TALLY_URL, HEALTH_XML, 10_000)));
    const company = companies[0]?.name;
    if (!company) { console.log("CANNOT RUN: no company open in Tally."); process.exit(2); }
    console.log(`Company open: (name withheld), ${companies.length} loaded\n`);

    const fpDef = { ...TRANSACTION_COLLECTIONS[0], fetch: ["Guid", "Date", "AlterID"] };
    const full = TRANSACTION_COLLECTIONS[0];

    const now = new Date();
    const fyStart = `${now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear()}0401`;
    const year = await timed("fingerprint, whole year", buildCollectionXml(fpDef, company, fyStart, ymd(now)));
    const last = year.dates.sort().at(-1);
    if (!last) { console.log("No vouchers this year in the open company; nothing to compare."); return; }
    const end = new Date(+last.slice(0, 4), +last.slice(4, 6) - 1, +last.slice(6, 8));
    const start = new Date(end); start.setDate(start.getDate() - 6);
    console.log(`(window = the 7 days ending on the latest voucher date)\n`);

    const fp7 = await timed("fingerprint, 7 days", buildCollectionXml(fpDef, company, ymd(start), ymd(end)));
    let fullMs = 0, fullBytes = 0, fullCount = 0;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const r = await timed(`full day read ${ymd(d)}`, buildCollectionXml(full, company, ymd(d), ymd(d)), 180_000);
      fullMs += r.ms; fullBytes += r.bytes; fullCount += r.guids.length;
    }
    console.log(`\nSUMMARY 7 days: full reads ${fullMs} ms / ${Math.round(fullBytes / 1024)} KB / ${fullCount} vouchers; ` +
      `fingerprint ${fp7.ms} ms / ${Math.round(fp7.bytes / 1024)} KB / ${fp7.guids.length} vouchers`);
    console.log(`SUMMARY year: fingerprint ${year.ms} ms / ${Math.round(year.bytes / 1024)} KB / ${year.guids.length} vouchers`);
    const sameSet = new Set(fp7.guids).size === fullCount;
    console.log(`fingerprint and full reads list the same number of vouchers: ${sameSet ? "yes" : "NO"}`);

    /* Agreement check on the three busiest days: the fingerprint, put through the SAME conversion the upload uses, must give the
       same guid -> AlterID per day as the full read of those days. If it does, a skip decision means what it says. */
    const sync = new SupabaseSync();
    const counts = new Map<string, number>();
    for (const d of year.dates) counts.set(d, (counts.get(d) ?? 0) + 1);
    const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d]) => d).sort();
    let agree = 0, disagree = 0;
    for (const day of busiest) {
      const parsed = (xml: string, ms: number) => withTally(TALLY_URL, "probe-fingerprint", () => tallyPost(TALLY_URL, xml, ms, false));
      const fpRaw = await parsed(buildCollectionXml(fpDef, company, day, day), 120_000);
      const fullRaw = await parsed(buildCollectionXml(full, company, day, day), 180_000);
      const toPrint = (p: any) => buildPrints(sync.fingerprintRowsOf(convertVouchers(p).tallymessage, company));
      const a = toPrint(fpRaw), b = toPrint(fullRaw);
      const same = !!a && !!b && JSON.stringify([...(a.get(day) ?? new Map())].sort()) === JSON.stringify([...(b.get(day) ?? new Map())].sort());
      console.log(`agreement ${day}: fingerprint ${a?.get(day)?.size ?? "unusable"} vs full ${b?.get(day)?.size ?? "unusable"} -> ${same ? "same" : "DIFFERENT"}`);
      if (same) agree++; else disagree++;
      if (daysToRead([day], a, b).length !== 0) { console.log(`  daysToRead would still read ${day} (expected skip)`); disagree++; }
    }
    console.log(`AGREEMENT: ${agree} same, ${disagree} different`);
  } finally {
    try { unlinkSync(LOCK); } catch { /* gone */ }
  }
}

main().catch((e) => { console.log(`ERROR: ${e?.message || e}`); try { unlinkSync(LOCK); } catch { /* gone */ } process.exit(1); });
