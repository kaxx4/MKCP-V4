/**
 * Does the sync's own voucher request, with the whole fetch list, bring every e-way bill and e-invoice field into ewb_details / einv_details?
 *
 * JOB: the end-to-end proof for owner request 26-Nov-2026 ("every e-way bill field Tally keeps"). It builds the ERP mirror's one-day voucher
 * request exactly as the sync does (ERP_MIRROR_VOUCHER_DEF, the old sync's list plus the ERP fields), reads one day from the sandbox dummy
 * Tally, runs the sync's own converter over it and prints, for each field of both blocks, how many vouchers carry a value.
 * Read-only; one request. The values on the dummy company can be real names and numbers: only counts are printed, never values.
 *
 *   npx tsx server/scripts/verify-ewb-einv-pull.ts [YYYYMMDD]      (default 20260801, a day with e-way bills and IRNs)
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
/* MKCP_ENV_FILE lets a worktree with no server/.env use the agent checkout's file (loaded, never printed). */
config({ path: process.env.MKCP_ENV_FILE || join(here, "..", ".env") });

import { tallyPost } from "../src/tally.js";
import { buildCollectionXml } from "../src/services/xmlBuilder.js";
import { ERP_MIRROR_VOUCHER_DEF } from "../src/services/erpMirrorSync.js";
import { extractVoucherTransport } from "../src/converters/convert.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";
/* 27-Nov-2026: with no company named, Tally answered for whatever was open; after a restart that crashed TallyPrime (c0000005) three times. */
if (!COMPANY || process.env.MKCP_TALLY_ROLE !== "sandbox") { console.error("refused: TALLY_COMPANY is empty or this is not a sandbox machine. Nothing was sent to Tally."); process.exit(2); }

/** Every VOUCHER object in the parsed reply, wherever the collection nests it. */
function vouchersIn(node: any, out: any[] = []): any[] {
  if (!node || typeof node !== "object") return out;
  for (const [k, val] of Object.entries(node)) {
    if (k === "VOUCHER") out.push(...(Array.isArray(val) ? val : [val]));
    else vouchersIn(val, out);
  }
  return out;
}

const filled = (x: unknown): boolean =>
  x !== null && x !== undefined && x !== "" && x !== false && !(Array.isArray(x) && x.length === 0) && !(typeof x === "object" && !Array.isArray(x) && Object.keys(x as object).length === 0);

async function main(): Promise<void> {
  const day = process.argv[2] ?? "20260801";
  const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
  console.log(`\n  E-WAY BILL AND E-INVOICE FIELDS through the sync's own request, ${iso}\n  ` + "─".repeat(66));
  const parsed = await tallyPost(TALLY, buildCollectionXml(ERP_MIRROR_VOUCHER_DEF, COMPANY, iso, iso), ERP_MIRROR_VOUCHER_DEF.timeout, false);
  const vouchers = vouchersIn(parsed);
  console.log(`  ${vouchers.length} voucher(s) read\n`);

  const ewbCount = new Map<string, number>(), einvCount = new Map<string, number>();
  let withEwb = 0, withEinv = 0;
  for (const v of vouchers) {
    const t = extractVoucherTransport(v);
    if (t.ewb_details) { withEwb++; for (const [k, val] of Object.entries(t.ewb_details)) ewbCount.set(k, (ewbCount.get(k) ?? 0) + (filled(val) ? 1 : 0)); }
    if (t.einv_details) { withEinv++; for (const [k, val] of Object.entries(t.einv_details)) einvCount.set(k, (einvCount.get(k) ?? 0) + (filled(val) ? 1 : 0)); }
  }
  console.log(`  ewb_details : ${withEwb} voucher(s) carry the block (filled / ${withEwb})`);
  for (const [k, n] of ewbCount) console.log(`    ${k.padEnd(28)} ${String(n).padStart(3)}`);
  console.log(`\n  einv_details: ${withEinv} voucher(s) carry the block (filled / ${withEinv})`);
  for (const [k, n] of einvCount) console.log(`    ${k.padEnd(28)} ${String(n).padStart(3)}`);
  const bad = withEwb === 0 || withEinv === 0;
  console.log(`\n  ${bad ? "FAIL: a block came back empty on every voucher" : "ok: both blocks fill"}\n`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error("verify failed:", e instanceof Error ? e.message : e); process.exit(1); });
