/**
 * Every e-way bill and e-invoice tag Tally keeps on a voucher, with how often it is filled and one sample.
 *
 * JOB: settle "which header names does Tally hold for the e-invoice and the e-way bill?" (owner, 26-Nov-2026: pull every e-way bill field).
 * G7: a field the fetch list never names looks identical to a field Tally lacks, so this asks with `NATIVEMETHOD *` (discovery only; it returns
 * stored fields and is safe, unlike a `.*` inside a FETCH list) and reports every tag path under VOUCHER that is NOT inside the ledger or
 * stock entry lists (those are 64 times the payload and carry no e-way or IRN field).
 *
 * Read-only: one filtered Voucher collection request per day and type, sent one at a time through tallyPost (sandbox company only; the
 * company guard in tally.ts refuses anything else). Prints to the console only. The values it shows can be real names and numbers copied
 * into the dummy company: never paste them into a commit or a report.
 *
 *   npx tsx server/scripts/probe-ewb-einv-census.ts <YYYYMMDD>[,<YYYYMMDD>...] [VOUCHERTYPE,...] [--all]
 *     default type SALES ("*" = every type); a day may be a range YYYYMMDD-YYYYMMDD; --all lists every path, not just the e-way / e-invoice /
 *     transport / dispatch family; --fetch=Name1,Name2 asks by explicit FETCH names instead of NATIVEMETHOD * (proves a name works).
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { tallyPost } from "../src/tally.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Entry lists carry no e-way or e-invoice field; skipping them keeps the census about the header. */
const SKIP = /^(ALLLEDGERENTRIES|LEDGERENTRIES|ALLINVENTORYENTRIES|INVENTORYENTRIES|BILLALLOCATIONS|ACCOUNTINGALLOCATIONS|BATCHALLOCATIONS|INVENTORYALLOCATIONS|BANKALLOCATIONS)\.LIST$/;

/** `selector`: NATIVEMETHOD * (discovery) or an explicit FETCH list (the names the sync would use). `day` is one YYYYMMDD or a YYYYMMDD-YYYYMMDD range; type "*" means every type. */
function requestXml(day: string, vtype: string, fetch: string[] | null): string {
  const [from, to] = day.includes("-") ? day.split("-") : [day, day];
  const sel = fetch ? fetch.map((f) => `<FETCH>${esc(f)}</FETCH>`).join("") : "<NATIVEMETHOD>*</NATIVEMETHOD>";
  /* An unescaped >= in a filter silently returns zero rows (tally-pull-performance), so the comparison is written with entities. */
  const typeClause = vtype === "*" ? "" : ` AND $VoucherTypeName = "${esc(vtype)}"`;
  const dayNum = "($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date)";
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>EwbEinvCensus</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="EwbEinvCensus" ISMODIFY="No"><TYPE>Voucher</TYPE>
${sel}
<FILTER>EwbEinvCensusF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="EwbEinvCensusF">${dayNum} &gt;= ${Number(from)} AND ${dayNum} &lt;= ${Number(to)}${typeClause}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

interface Stat { seen: number; filled: number; sample: string }

/** Walk the raw text with a tag stack and record, per path under VOUCHER, how often it appears and how often it holds a value. */
export function census(raw: string, into: Map<string, Stat>): number {
  const stack: string[] = [];
  let vouchers = 0;
  let skipDepth = -1;
  const re = /<(\/?)([A-Za-z][A-Za-z0-9._]*)([^>]*?)(\/?)>|([^<]+)/g;
  let pendingPath: string | null = null;
  for (const m of raw.matchAll(re)) {
    if (m[5] !== undefined) {
      const text = m[5].replace(/&#4;/g, "").trim();
      if (pendingPath && text) {
        const st = into.get(pendingPath)!;
        st.filled++;
        if (!st.sample) st.sample = text.slice(0, 60);
      }
      continue;
    }
    const closing = m[1] === "/", name = m[2].toUpperCase(), selfClose = m[4] === "/";
    if (closing) {
      if (stack[stack.length - 1] === name) stack.pop();
      if (skipDepth >= 0 && stack.length < skipDepth) skipDepth = -1;
      pendingPath = null;
      continue;
    }
    const inVoucher = stack.includes("VOUCHER");
    if (name === "VOUCHER" && !selfClose) vouchers++;
    if (inVoucher && skipDepth < 0) {
      if (SKIP.test(name)) skipDepth = stack.length + 1;
      else {
        const path = [...stack.slice(stack.indexOf("VOUCHER") + 1), name].join(" > ");
        const st = into.get(path) ?? { seen: 0, filled: 0, sample: "" };
        st.seen++;
        into.set(path, st);
        pendingPath = selfClose ? null : path;
      }
    } else pendingPath = null;
    if (!selfClose) stack.push(name);
  }
  return vouchers;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const all = process.argv.includes("--all");
  const fetchArg = process.argv.find((a) => a.startsWith("--fetch="));
  const fetch = fetchArg ? fetchArg.slice(8).split(",").filter(Boolean) : null;
  const days = (args[0] ?? "20260801").split(",");
  const types = (args[1] ?? "SALES").split(",");
  const stats = new Map<string, Stat>();
  let total = 0;
  for (const day of days) {
    for (const t of types) {
      const raw: string = await tallyPost(TALLY, requestXml(day, t, fetch), 180_000, true);
      const n = census(raw, stats);
      total += n;
      console.log(`  ${day} ${t}: ${n} voucher(s), ${raw.length.toLocaleString()} bytes`);
    }
  }
  const family = /EWAY|EWB|TRANSPORT|DISTANCE|VEHICLE|CONSIGN|SHIPPED|DISPATCH|IRN|EINV|BILLTO|SUPPLY|SUBTYPE|DOCUMENT|PLACEOF|DELIVER|CANCEL|PARTB|LADING|GENERATED|VALID/i;
  console.log(`\n  ${total} voucher(s) in all. path : filled/seen : sample\n`);
  for (const [p, s] of [...stats.entries()].sort()) {
    if (!all && !family.test(p)) continue;
    console.log(`  ${p.padEnd(64)} ${String(s.filled).padStart(3)}/${String(s.seen).padEnd(3)} ${s.sample ? JSON.stringify(s.sample) : ""}`);
  }
}

if (process.argv[1] && /probe-ewb-einv-census/.test(process.argv[1])) main().catch((e) => { console.error("probe failed:", e instanceof Error ? e.message : e); process.exit(1); });
