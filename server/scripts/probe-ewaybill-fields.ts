/**
 * Does Tally carry the e-way bill distance, and does the sync ask for it?
 *
 * ── Why this is worth a probe ─────────────────────────────────────────────
 *
 * `convert.ts` reads `EWAYBILLDETAILS.TRANSPORTDETAILS.DISTANCE` and writes it
 * to `tally_vouchers.transport_distance_km`. That column is EMPTY on all 2,792
 * vouchers in the mirror (measured 14-Sep-2026), as are `ewb_number`,
 * `vehicle_number` and `transport_mode`.
 *
 * The voucher fetch list in `config/collections.ts` does not name the e-way
 * bill block at all. So the likely cause is G4 — the converter reads a field
 * nobody fetches, exactly the defect the plan already records for
 * `convertStockItems` — rather than Tally not holding the data.
 *
 * That matters because the e-way bill's own distance is the best freight
 * distance available anywhere: it is what the portal accepted. The web app
 * currently falls back to a routed estimate, and before that to a rate card
 * typed in July 2024 that is up to 67% wrong.
 *
 * This asks Tally directly, and distinguishes the two possible answers:
 *   · fields present in a wildcard export  → we simply never asked for them
 *   · absent even from the wildcard        → this company does not record them
 *
 * Read-only. Never fuzzes an object type (P6) — Voucher is a known-good type.
 *
 *   npx tsx server/scripts/probe-ewaybill-fields.ts [YYYYMMDD]
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { tallyPost } from "../src/tally.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * `wildcard` asks for everything (what does Tally hold?); `fetchList` asks for
 * exactly the names the sync would use (will the real fetch list work?).
 * Both are needed: the first proves the data exists, the second proves we can
 * name it without a wildcard — and wildcards crash TallyPrime.
 */
function xmlFor(day: string, mode: "wildcard" | "fetchList"): string {
  const selector =
    mode === "wildcard"
      ? "<NATIVEMETHOD>*</NATIVEMETHOD>"
      : ["Guid", "Date", "VoucherNumber", "EWayBillDetails"]
          .map((f) => `<FETCH>${f}</FETCH>`)
          .join("");
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>EwbProbe</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="EwbProbe" ISMODIFY="No"><TYPE>Voucher</TYPE>
${selector}
<FILTER>EwbProbeF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="EwbProbeF">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${Number(day)} AND $VoucherTypeName = "SALES"</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

async function main(): Promise<void> {
  const day = process.argv[2] ?? "20260911";
  console.log(`\n  E-WAY BILL FIELDS on SALES vouchers, ${day}\n  ` + "─".repeat(66));

  const mode = (process.argv[3] === "fetch" ? "fetchList" : "wildcard") as "wildcard" | "fetchList";
  console.log(`  mode: ${mode === "wildcard" ? "NATIVEMETHOD * (what does Tally hold?)" : "explicit FETCH list (can the sync name it?)"}`);
  const raw: string = await tallyPost(TALLY, xmlFor(day, mode), 180_000, true);
  console.log(`  ${raw.length.toLocaleString()} bytes returned`);

  /* Every distinct tag name, so the answer does not depend on guessing the
     spelling. A field that exists under ANY name containing these stems will
     show up here. */
  const tags = new Set<string>();
  for (const m of raw.matchAll(/<([A-Z][A-Z0-9._]*)[\s>/]/gi)) tags.add(m[1].toUpperCase());

  const interesting = [...tags]
    .filter((t) => /EWAY|EWB|TRANSPORT|DISTANCE|VEHICLE|CONSIGNEE|SHIPPED|LADING|DESPATCH|DISPATCH/.test(t))
    .sort();

  console.log(`\n  ${tags.size} distinct tags; ${interesting.length} transport-related:\n`);
  for (const t of interesting) {
    // Is it populated, or one of Tally's self-closing empty placeholders?
    const open = new RegExp(`<${t}>([^<]*)</${t}>`, "i");
    const hit = raw.match(open);
    const selfClosing = new RegExp(`<${t}/>`, "i").test(raw);
    const value = hit?.[1]?.trim();
    console.log(
      `    ${t.padEnd(30)} ${value ? `= ${JSON.stringify(value.slice(0, 40))}` : selfClosing ? "(self-closing / empty)" : "(present, no inline value)"}`,
    );
  }

  if (!interesting.length) {
    console.log("    none — this company records no transport details on these vouchers,");
    console.log("    so the empty mirror columns are the truth and not a fetch-list gap.");
  } else {
    console.log("\n  If these carry values, the mirror's empty columns are a FETCH-LIST gap:");
    console.log("  config/collections.ts does not name the e-way bill block, so convert.ts");
    console.log("  reads a field that never arrives (G4).");
  }
}

main().catch((e) => {
  console.error("probe failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
