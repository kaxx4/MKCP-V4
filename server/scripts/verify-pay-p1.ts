/**
 * verify-pay-p1.ts — PAY-P1 proof on the SANDBOX Tally: every money shape the
 * web Money entry emits, pushed through safePush, read back, then deleted.
 *
 *   npx tsx scripts/verify-pay-p1.ts <payloads.json> <TAG> --push
 *   npx tsx scripts/verify-pay-p1.ts <payloads.json> <TAG> --delete
 *
 * One voucher per invocation, so the caller can hold the shared tally.lock
 * around exactly one request burst (a Tally error modal kills the port; a
 * run that stops at the first failure costs at most one restart).
 *
 * payloads.json is `[{ tag, payload }]` produced by the web app's own
 * buildMoneyPayload — no hand-built payloads, because the seam is what is
 * being tested. Shapes, 1-Oct-2026: P1 On Account to a creditor; P2 SALARY &
 * BONUS with no allocation (the f8fa34c shape); P3 SALARY & BONUS carrying On
 * Account (the pre-f8fa34c shape — Tally drops it, safePush must accept that);
 * R1 On Account receipt from a debtor; R2 receipt to a non-party ledger.
 *
 * Refuses unless MKCP_TALLY_ROLE=sandbox and Tally is localhost:9000.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { safePush } from "../src/services/safePush.js";
import { isSandbox } from "../src/services/tallyRole.js";
import { escapeXml as esc, readTag } from "../src/services/xml.js";
import type { VoucherPayload } from "../src/types.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
if (!isSandbox()) { console.error("REFUSED — MKCP_TALLY_ROLE is not 'sandbox'."); process.exit(2); }
if (!/^https?:\/\/(localhost|127\.0\.0\.1):9000\/?$/i.test(U)) { console.error(`REFUSED — TALLY_URL is ${U}.`); process.exit(2); }

const [file, tag] = process.argv.slice(2);
const all = JSON.parse(readFileSync(file, "utf8")) as { tag: string; payload: VoucherPayload }[];
const hit = all.find((x) => x.tag === tag);
if (!hit) { console.error(`no payload tagged ${tag}`); process.exit(2); }
const p = hit.payload;
if (!/CLAUDE-TEST/.test(p.narration ?? "")) { console.error("REFUSED — narration must carry CLAUDE-TEST."); process.exit(2); }

async function main() {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]?.name ?? "";
  if (!company) { console.error("no company open"); process.exit(1); }

  if (process.argv.includes("--push")) {
    const r = await safePush(U, company, p);
    console.log(JSON.stringify({ tag, ok: r.ok, stage: r.stage, voucherId: r.voucherId, errors: r.errors, differences: r.differences, warnings: r.warnings }, null, 1));
    process.exit(r.ok ? 0 : 1);
  }

  if (process.argv.includes("--delete")) {
    const day = p.date.replace(/-/g, "");
    const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(p.remoteId)}" VCHTYPE="${esc(p.voucherType)}" ACTION="Delete"><DATE>${day}</DATE><VOUCHERTYPENAME>${esc(p.voucherType)}</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(p.voucherNumber)}</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
    const res: string = await tallyPost(U, xml, 60_000, true);
    const n = parseInt(readTag(res, "DELETED") || "0", 10) || 0;
    console.log(`${tag}: deleted=${n}${n ? "" : ` — ${readTag(res, "LINEERROR") || "no DELETED in response"}`}`);
    process.exit(n ? 0 : 1);
  }
  console.error("pass --push or --delete"); process.exit(2);
}
main().catch((e) => { console.error(e); process.exit(1); });
