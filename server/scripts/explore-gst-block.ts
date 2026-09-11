/**
 * What does a GST-clean voucher look like, according to Tally itself?
 *
 * GSTR-1 is not exposed over XML on this install — every report name errors
 * with "Could not find Report" (verified, and Tally answers cleanly rather than
 * raising a modal). So the return's exception list cannot be read directly.
 *
 * The workable substitute is better in one important way: compare a voucher we
 * push against vouchers TALLY ITSELF created and has already filed clean, field
 * by field. An exception is always a missing or contradictory field ON THE
 * VOUCHER, and those fields are readable.
 *
 * ⚠ TWO PASSES, DELIBERATELY.
 * Asking for AllLedgerEntries/AllInventoryEntries across a whole year is the
 * shape that wedges Tally's single-threaded port: it timed out at 240s and the
 * port stayed busy for another 77s afterwards. Entry blocks are ~64x the
 * payload. So:
 *   pass 1 — identity fields only, whole year, cheap.
 *   pass 2 — entry blocks for ONE voucher, selected by number.
 * Never combine them.
 *
 *   npx tsx scripts/explore-gst-block.ts
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Identity fields GSTR-1 classifies on — the ones whose absence makes an exception. */
const ID_FIELDS = [
  "PARTYGSTIN", "GSTREGISTRATIONTYPE", "PLACEOFSUPPLY", "STATENAME",
  "COUNTRYOFRESIDENCE", "PARTYNAME", "REFERENCE", "ISINVOICE",
];

const fld = (v: string, t: string) => {
  const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i").exec(v);
  return m ? m[1].trim() : "";
};

function collection(company: string, fields: string[], filter: string): string {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkGstBlk</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkGstBlk" ISMODIFY="No"><TYPE>Voucher</TYPE>
${fields.map((f) => `<NATIVEMETHOD>${f}</NATIVEMETHOD>`).join("")}
<FILTER>MkGstBlkF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MkGstBlkF">${filter}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

/** Numeric-stamp date comparison. `&gt;=` MUST be escaped — a raw `>` returns
 *  zero rows in 2ms with no error, which reads exactly like "nothing matched". */
const SINCE_FY = `($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) &gt;= 20260401`;

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  console.log(`\ncompany  "${company}"\n`);

  // ── Pass 1: identity fields only, no entry blocks ────────────────────────
  const t0 = Date.now();
  const raw: string = await tallyPost(U, collection(company, [
    "Date", "VoucherNumber", "VoucherTypeName", "PartyLedgerName",
    "PartyGSTIN", "GSTRegistrationType", "PlaceOfSupply", "StateName",
    "CountryOfResidence", "PartyName", "Reference", "IsInvoice",
    "IsCancelled", "IsOptional",
  ], SINCE_FY), 240_000, true);
  console.log(`pass 1: ${(raw.length / 1024 / 1024).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const vouchers = [...raw.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]);
  const byType = new Map<string, string[]>();
  for (const v of vouchers) {
    const t = fld(v, "VOUCHERTYPENAME") || "(none)";
    byType.set(t, [...(byType.get(t) ?? []), v]);
  }

  console.log(`\n${vouchers.length} vouchers since 1-Apr-2026 across ${byType.size} types`);
  console.log(`\nhow completely each type carries the fields GSTR-1 classifies on\n`);
  const hdr = "type".padEnd(24) + "n".padStart(5) + "  " +
    ID_FIELDS.map((f) => f.slice(0, 9).padStart(10)).join("");
  console.log(hdr);
  console.log("-".repeat(hdr.length));
  for (const [type, vs] of [...byType].sort((a, b) => b[1].length - a[1].length)) {
    const cells = ID_FIELDS.map((f) => {
      const n = vs.filter((v) => fld(v, f)).length;
      return `${Math.round((n / vs.length) * 100)}%`.padStart(10);
    }).join("");
    console.log(type.slice(0, 23).padEnd(24) + String(vs.length).padStart(5) + "  " + cells);
  }

  // ── Pass 2: one real voucher per type, WITH entry blocks ─────────────────
  // Scoped to a SINGLE DAY, using the numeric-stamp equality that is known to
  // work. A whole day is a few dozen vouchers — small enough to carry entry
  // blocks safely, unlike the year-wide pull that wedged the port.
  console.log(`\n── a native example per type, with its entries ──`);
  for (const type of ["SALES", "Purchase", "Payment", "Receipt", "Contra", "Sales Order Note"]) {
    const vs = byType.get(type);
    if (!vs?.length) { console.log(`\n${type}: none in this period`); continue; }
    const pick = vs[vs.length - 1];
    const num = fld(pick, "VOUCHERNUMBER");
    const day = fld(pick, "DATE").replace(/-/g, "");
    if (!num || !/^\d{8}$/.test(day)) { console.log(`\n${type}: no usable date on ${num || "(no number)"}`); continue; }

    const one: string = await tallyPost(U, collection(company, [
      "Date", "VoucherNumber", "VoucherTypeName", "PartyLedgerName",
      "PartyGSTIN", "GSTRegistrationType", "PlaceOfSupply", "StateName",
      "AllLedgerEntries", "AllInventoryEntries",
    ], `($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${day}`), 120_000, true);

    const v = [...one.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)]
      .map((m) => m[0])
      .find((x) => fld(x, "VOUCHERNUMBER") === num) ?? "";
    console.log(`\n${type} · ${num} · ${fld(v, "DATE")} · ${fld(v, "PARTYLEDGERNAME")}`);
    for (const f of ID_FIELDS) {
      const val = fld(v, f);
      console.log(`   ${f.padEnd(22)} ${val ? val.slice(0, 60) : "\x1b[31m(empty)\x1b[0m"}`);
    }
    const ledgers = [...v.matchAll(/<LEDGERNAME>([^<]*)<\/LEDGERNAME>/g)].map((m) => m[1].trim());
    console.log(`   ${"ledger lines".padEnd(22)} ${ledgers.length}: ${ledgers.slice(0, 6).join(" | ")}`);
    const tax = ledgers.filter((n) => /CGST|SGST|IGST|CESS/i.test(n));
    console.log(`   ${"tax heads".padEnd(22)} ${tax.length ? [...new Set(tax)].join(", ") : "(none)"}`);
    // Does Tally's own voucher carry per-line GST classification?
    const hsn = [...v.matchAll(/<GSTHSNNAME>([^<]*)<\/GSTHSNNAME>/g)].map((m) => m[1].trim()).filter(Boolean);
    if (hsn.length) console.log(`   ${"HSN on lines".padEnd(22)} ${[...new Set(hsn)].join(", ")}`);
  }
})();
