/**
 * EXPLORATION 7 — what would a real-time pull actually cost?
 *
 * The dashboard lags the books because the pull is a midnight full sync plus a
 * 30-minute tick that only runs while the Electron window is open.
 *
 * The first attempt at this measurement WEDGED Tally: a full year of vouchers
 * with the nested entry blocks exceeded 300 seconds and took the port down. That
 * was the first freeze caused by a perfectly well-formed request rather than an
 * invalid one, and it is the finding that matters most here — a production pull
 * needs a size ceiling, not just a timeout.
 *
 * So this escalates the window and stops before the next step could repeat it.
 * Nothing here writes.
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The fields the dashboard actually reads, per types/canonical.ts. */
const VOUCHER_FIELDS = [
  "Date", "VoucherNumber", "VoucherTypeName", "Narration", "Reference",
  "PartyLedgerName", "IsCancelled", "IsOptional", "Guid", "AlterID", "MasterID",
  "LedgerEntries", "AllLedgerEntries", "AllInventoryEntries",
];

function collection(company: string, type: string, fields: string[], filter?: { name: string; expr: string }) {
  return `<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>Inc</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="Inc" ISMODIFY="No"><TYPE>${type}</TYPE>
${fields.map(f => `<NATIVEMETHOD>${esc(f)}</NATIVEMETHOD>`).join("")}
${filter ? `<FILTER>${filter.name}</FILTER>` : ""}
</COLLECTION>
${filter ? `<SYSTEM TYPE="Formulae" NAME="${filter.name}">${filter.expr}</SYSTEM>` : ""}
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

async function healthy(): Promise<boolean> {
  try { return convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 8_000)).length > 0; }
  catch { return false; }
}

/**
 * Comparison operators MUST be XML-escaped. With a raw `>=` Tally returns zero
 * rows in 2ms with no error at all — indistinguishable from "nothing in this
 * date range", which is exactly how it goes unnoticed.
 */
const D = "($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date)";
const stamp = (from: number, to: number) => ({
  name: "IncDate",
  expr: `${D} &gt;= ${from} AND ${D} &lt;= ${to}`,
});

const kb = (n: number) => Math.round(n / 1024);

async function main() {
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  console.log(`company "${company}"`);

  /** Stop escalating once a window costs this much; the next would be the one that hurts. */
  const CEILING_MS = 40_000;

  console.log(`\n── Cost of a bounded window, WITH entry blocks ──`);
  const windows: Array<[string, number, number]> = [
    ["one day (11 Aug)", 20260811, 20260811],
    ["one week (11-17 Aug)", 20260811, 20260817],
    ["one month (Aug)", 20260801, 20260831],
    ["one quarter (Jun-Aug)", 20260601, 20260831],
  ];

  let lastMs = 0;
  for (const [label, from, to] of windows) {
    if (lastMs > CEILING_MS) {
      console.log(`  · stopping — the previous window took ${lastMs}ms; the next could wedge the port`);
      break;
    }
    const t0 = Date.now();
    let raw: string;
    try {
      raw = await tallyPost(TALLY_URL, collection(company, "Voucher", VOUCHER_FIELDS, stamp(from, to)), 120_000, true) as string;
    } catch (e) {
      console.log(`  x ${label.padEnd(24)} ${(e as Error).message.slice(0, 46)}`);
      break;
    }
    lastMs = Date.now() - t0;
    const n = [...raw.matchAll(/<VOUCHER\b/g)].length;
    console.log(`  + ${label.padEnd(24)} ${String(n).padStart(5)} vch ${String(kb(raw.length)).padStart(6)}KB ${String(lastMs).padStart(6)}ms  ${String(n ? Math.round(raw.length / n) : 0).padStart(5)}B/vch`);
    if (!await healthy()) { console.log("\n! Tally stopped answering."); return; }
  }

  // ── What a poll would actually issue ──────────────────────────────────────
  console.log(`\n── AlterID as the change cursor ──`);
  const t0 = Date.now();
  const idsRaw = await tallyPost(TALLY_URL, collection(company, "Voucher", ["AlterID"]), 120_000, true) as string;
  const ids = [...idsRaw.matchAll(/<ALTERID[^>]*>\s*(\d+)\s*<\/ALTERID>/g)]
    .map(m => parseInt(m[1], 10)).sort((a, b) => a - b);
  console.log(`  bare AlterID sweep: ${ids.length} vouchers, ${kb(idsRaw.length)}KB, ${Date.now() - t0}ms`);
  if (!ids.length) { console.log("  x no AlterID returned"); return; }
  console.log(`  range ${ids[0]} .. ${ids[ids.length - 1]}`);

  // A realistic catch-up: whatever changed past the 99th percentile.
  const cursor = ids[Math.floor(ids.length * 0.99)];
  const t1 = Date.now();
  const since = await tallyPost(TALLY_URL, collection(company, "Voucher", VOUCHER_FIELDS,
    { name: "IncAlter", expr: `$AlterID &gt; ${cursor}` }), 120_000, true) as string;
  const n = [...since.matchAll(/<VOUCHER\b/g)].length;
  console.log(`  catch-up past AlterID ${cursor}: ${n} vouchers, ${kb(since.length)}KB, ${Date.now() - t1}ms`);
  if (!await healthy()) { console.log("\n! Tally stopped answering."); return; }

  console.log(`\n── Masters carry AlterID too ──`);
  for (const type of ["Ledger", "StockItem"] as const) {
    const t2 = Date.now();
    const raw = await tallyPost(TALLY_URL, collection(company, type, ["Name", "AlterID"]), 120_000, true) as string;
    const mids = [...raw.matchAll(/<ALTERID[^>]*>\s*(\d+)\s*<\/ALTERID>/g)].map(m => parseInt(m[1], 10));
    console.log(`  ${type.padEnd(11)} ${String(mids.length).padStart(4)} objects, max ${mids.length ? Math.max(...mids) : "-"}, ${kb(raw.length)}KB ${Date.now() - t2}ms`);
  }

  console.log(await healthy() ? "\nTally still healthy." : "\n! Tally NOT responding.");
}

main().catch(e => console.error("FAILED:", e.message));
