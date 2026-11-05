/**
 * probe: does safePush's read-back (MkVerify) carry each voucher's ALTERID,
 * MASTERID and GUID without asking for them (G7)? Read only, one request, the
 * practice company. Prints only counts and field presence, never names.
 *
 *   npx tsx scripts/probe-readback-alterid.ts 2026-04-10
 */
import "dotenv/config";
import { tallyPost } from "../src/tally.js";
import { practiceCompany } from "../src/services/tallyRole.js";
import { vouchersOnDateXml } from "../src/services/safePush.js";
import { readTag } from "../src/services/xml.js";

const day = process.argv[2] ?? "2026-04-10";
const company = practiceCompany();
if (!company) { console.error("MKCP_PRACTICE_COMPANY is not set"); process.exit(2); }
(async () => {
  const xml = (await tallyPost(process.env.TALLY_URL || "http://localhost:9000", vouchersOnDateXml(company, day), 180_000, true)) as string;
  const vs = [...xml.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]);
  const has = (t: string) => vs.filter((v) => /^\d+$/.test(readTag(v, t))).length;
  const guid = vs.filter((v) => readTag(v, "GUID").length > 8).length;
  console.log(JSON.stringify({ day, vouchers: vs.length, alterid: has("ALTERID"), masterid: has("MASTERID"), guid }));
})();
