/**
 * Does Tally send bill NAMES, and does the converter keep them?
 *
 * ── Why this is being asked ───────────────────────────────────────────────
 *
 * The mirror holds 7,621 "New Ref" bill allocation lines and **6,779 of them
 * have a blank name** — only 842 carry one. A bill without a name cannot be
 * settled against, cannot be aged, and cannot become a Bill object at all, so
 * this blocks Phase 2.3 outright.
 *
 * Two possibilities, and they need different fixes:
 *   · Tally does not send the name on these  → a fetch-list or voucher-type
 *     question, and the Bill object has to be derived some other way.
 *   · Tally sends it and the converter drops it → a G4 defect, and the Bill
 *     object is one line of code away.
 *
 * Look at the bytes rather than reasoning about it.
 *
 *   npx tsx server/scripts/probe-bill-allocations.ts [YYYYMMDD]
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { tallyPost } from "../src/tally.js";
import { convertVouchers } from "../src/converters/convert.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";
const DAY = process.argv[2] ?? "20260901";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function xml(): string {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>BillProbe</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="BillProbe" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD>
<NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD><NATIVEMETHOD>LedgerEntries</NATIVEMETHOD>
<FILTER>BillProbeF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="BillProbeF">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${Number(DAY)}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

async function main(): Promise<void> {
  console.log(`\n  BILL ALLOCATIONS on ${DAY}\n  ` + "─".repeat(66));

  const raw: string = await tallyPost(TALLY, xml(), 180_000, true);

  const blocks = [...raw.matchAll(/<BILLALLOCATIONS\.LIST>([\s\S]*?)<\/BILLALLOCATIONS\.LIST>/gi)].map((m) => m[1]);
  const populated = blocks.filter((b) => b.trim().length > 0);
  console.log(`\n  ${blocks.length} BILLALLOCATIONS.LIST blocks, ${populated.length} populated\n`);

  if (populated.length) {
    console.log("  === first populated block, verbatim ===");
    console.log(populated[0].split("\n").slice(0, 24).join("\n"));
  }

  /* Which tag actually carries the name? The converter reads <NAME>; if Tally
     uses something else here that is the whole defect. */
  const tagCounts: Record<string, number> = {};
  for (const b of populated) {
    for (const t of b.matchAll(/<([A-Z][A-Z0-9._]*)[^>]*>([^<]*)<\/\1>/gi)) {
      const tag = t[1].toUpperCase();
      const val = t[2].replace(/&#4;\s*/g, "").trim();
      if (val) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }
  }
  console.log("\n  === populated tags inside the block ===");
  for (const [t, n] of Object.entries(tagCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${t.padEnd(24)} ${n}`);
  }

  // ── And what does the converter make of it? ──────────────────────────────
  const parsedXml = await tallyPost(TALLY, xml(), 180_000, false);
  const vs = convertVouchers(parsedXml).tallymessage as any[];
  const allocs = vs.flatMap((v) => (v.allledgerentries ?? []).flatMap((e: any) => e.billallocations ?? []));
  const named = allocs.filter((a: any) => (a.name ?? "").trim() !== "");

  console.log(`\n  === through the converter ===`);
  console.log(`     ${vs.length} vouchers · ${allocs.length} bill allocations · ${named.length} with a name`);
  for (const a of allocs.slice(0, 6)) {
    console.log(`       name="${a.name}" type="${a.billtype}" amount="${a.amount}"`);
  }

  console.log("\n  " + "─".repeat(66));
  const placeholders = blocks.length - populated.length;
  console.log(`  ${placeholders} of ${blocks.length} blocks Tally sent were empty placeholders.`);

  if (allocs.length === 0) {
    console.log("  No bill allocations converted at all — check the tag path, not the fetch.");
  } else if (named.length === allocs.length) {
    console.log(`  Every converted allocation carries a name (${named.length}).`);
    console.log(`  The placeholders were dropped rather than materialised — which is the fix:`);
    console.log(`  this converter used to turn each one into a bill with a blank name, an`);
    console.log(`  amount of "0" and an INVENTED billtype of "New Ref", which is where the`);
    console.log(`  mirror's 6,779 blank-name "New Ref" lines came from.`);
    console.log(`\n  Those rows are still in Supabase. The entry tables are rewritten per`);
    console.log(`  voucher on sync, so a full voucher sync clears them; nothing here can.`);
  } else {
    console.log(`  ${allocs.length - named.length} of ${allocs.length} converted allocations have no name.`);
    console.log(`  A nameless allocation cannot be settled against or aged — find which`);
    console.log(`  voucher types produce them before deriving any Bill from this.`);
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
