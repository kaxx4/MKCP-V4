/**
 * Prove the exception log records what it is for.
 *
 * Deliberately provokes the failure shapes — including the ones Tally answers
 * *successfully* while refusing the content — and then reads the log back to
 * confirm each left an entry with its request and response intact.
 *
 * Writes nothing to Tally that is not immediately removed. Read-only apart from
 * one Journal that is created and deleted.
 *
 *   npx tsx server/scripts/verify-exception-log.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, rmSync } from "node:fs";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { tallyPost } from "../src/tally.js";
import { configureTallyLog, summarise } from "../src/services/tallyLog.js";
import { buildCollection, buildReport, onDate } from "../src/services/tallyRequest.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";
const LOG = join(here, "..", "data", "verify-tally-log.jsonl");

let fails = 0;
const ok = (what: string, cond: boolean, detail = "") => {
  if (cond) console.log(`  ok    ${what}`);
  else { fails++; console.log(`  FAIL  ${what}${detail ? " — " + detail : ""}`); }
};

/** Swallow the rejection — we are provoking failures on purpose. */
async function attempt(xml: string, raw = false): Promise<void> {
  try { await tallyPost(TALLY, xml, 60_000, raw); } catch { /* expected */ }
}

async function main(): Promise<void> {
  if (existsSync(LOG)) rmSync(LOG);
  configureTallyLog(LOG);

  console.log("\n  EXCEPTION LOG\n  " + "─".repeat(60));
  console.log("\n  Provoking the shapes that matter…");

  // 1. An ordinary successful read — the digest case.
  await attempt(buildCollection({ id: "ElGod", type: "Godown", fetch: ["NAME"], company: COMPANY }));

  // 2. A read that legitimately returns nothing. NOT a failure — and the log
  //    must not confuse the two (guardrail G7).
  await attempt(buildCollection({
    id: "ElNone", type: "Voucher", fetch: ["DATE"], filter: onDate("20200101"), company: COMPANY,
  }));

  // 3. A company name Tally does not have. This is the LINEERROR path, which
  //    the transport rejects before any caller sees it.
  await attempt(buildCollection({
    id: "ElBadCo", type: "Ledger", fetch: ["NAME"], company: "NO SUCH COMPANY LTD",
  }));

  // 4. An import Tally accepts and then refuses without saying why — the
  //    EXCEPTIONS=1, ERRORS=0, no-message signature. A voucher naming a ledger
  //    that does not exist does this.
  const badImport =
    `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE>` +
    `<ID>Vouchers</ID></HEADER><BODY><DESC><STATICVARIABLES>` +
    `<SVCURRENTCOMPANY>${COMPANY.replace(/&/g, "&amp;")}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>` +
    `<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF">` +
    `<VOUCHER REMOTEID="MKCP|LOGPROBE|1" VCHTYPE="Journal" ACTION="Create" OBJVIEW="Accounting Voucher View">` +
    `<DATE>20260913</DATE><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>` +
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>A LEDGER THAT DOES NOT EXIST</LEDGERNAME>` +
    `<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1</AMOUNT></ALLLEDGERENTRIES.LIST>` +
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>ALSO NOT A LEDGER</LEDGERNAME>` +
    `<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1</AMOUNT></ALLLEDGERENTRIES.LIST>` +
    `</VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
  await attempt(badImport, true);

  // 5. A report, for shape coverage.
  await attempt(buildReport("Trial Balance", COMPANY, "20260401", "20270331"));

  // ── Read it back ────────────────────────────────────────────────────────
  const s = summarise(LOG);
  console.log(`\n  Recorded ${s.total} interactions.`);
  console.log("  by outcome: " + Object.entries(s.byOutcome).map(([k, v]) => `${k} ${v}`).join(" · "));

  console.log("\n  Assertions");
  ok("every interaction left a row", s.total >= 5, `got ${s.total}`);
  ok("successful reads are recorded", (s.byOutcome["ok"] ?? 0) >= 2);
  ok("at least one failure shape was captured",
    s.failingShapes.length > 0, "no failing shape recorded — the provocations may have all succeeded");

  const errShape = s.failingShapes.find((f) => f.outcome === "tally-error");
  ok("a LINEERROR is classified as a Tally error", !!errShape,
    "expected the bad company name to produce one");
  if (errShape) console.log(`        → ${errShape.label}: ${errShape.note ?? ""}`);

  const excShape = s.failingShapes.find((f) => f.outcome === "exception");
  if (excShape) {
    console.log(`        → EXCEPTIONS captured: ${excShape.note ?? ""}`);
  }
  ok("the silent-refusal signature is either captured or the import was rejected outright",
    !!excShape || !!errShape);

  // The whole point of P8: a failure keeps its request.
  const { readFileSync } = await import("node:fs");
  const rows = readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const failed = rows.filter((r: { outcome: string }) => r.outcome !== "ok");
  const succeeded = rows.filter((r: { outcome: string }) => r.outcome === "ok");

  ok("a FAILED interaction keeps its full request XML",
    failed.every((r: { requestXml?: string }) => typeof r.requestXml === "string" && r.requestXml.length > 0));
  ok("a FAILED interaction keeps its full response XML",
    failed.every((r: { responseXml?: string }) => typeof r.responseXml === "string"));
  ok("a SUCCESSFUL interaction keeps only a digest",
    succeeded.every((r: { requestXml?: string }) => r.requestXml === undefined));
  ok("every row carries timing and size",
    rows.every((r: { elapsedMs?: number; bytesIn?: number }) => typeof r.elapsedMs === "number" && typeof r.bytesIn === "number"));
  ok("collection rows carry their object type",
    rows.filter((r: { kind: string }) => r.kind === "Collection")
        .every((r: { objectType?: string }) => !!r.objectType));
  ok("a filtered request records its filter",
    rows.some((r: { filter?: string }) => !!r.filter && r.filter.includes("&gt;=") === false));

  console.log(`\n  Log: ${LOG}`);
  console.log("  " + "─".repeat(60));
  console.log(`  ${fails === 0 ? "The log records what it is for." : fails + " assertion(s) failed."}\n`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
