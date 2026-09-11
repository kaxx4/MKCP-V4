/** Stage 6 — reconciliation, run against the last 30 days of live data. */
import "dotenv/config";
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { reconcile, summarise } from "../src/services/reconcile.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const days = parseInt(process.argv.find(a => /^\d+$/.test(a)) ?? "30", 10);

async function main() {
  const company = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000))[0]?.name;
  if (!company) throw new Error("No company loaded");
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const r = await reconcile(TALLY_URL, company, iso(from), iso(to));
  console.log(`\n${summarise(r)}\n`);
  if (!r.ok) {
    console.log("Mismatched buckets (first 25):");
    for (const m of r.mismatches.slice(0, 25)) {
      console.log(`  ${m.date}  ${m.voucherType.padEnd(16)} Tally ${String(m.tally).padStart(3)}  Supabase ${String(m.supabase).padStart(3)}  ${m.tally > m.supabase ? "← missing downstream" : "← extra downstream"}`);
    }
    if (r.mismatches.length > 25) console.log(`  … ${r.mismatches.length - 25} more`);
    if (r.missingDays.length) console.log(`\nDays entirely absent from Supabase: ${r.missingDays.join(", ")}`);
  }
}
main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
