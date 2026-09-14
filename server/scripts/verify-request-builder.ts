/**
 * Every shape the request builder can produce, asked of the LIVE Tally.
 *
 * `test-tally-request.ts` proves the builder refuses the traps. That is a pure
 * test and it proves nothing about whether Tally answers — which is the failure
 * mode this project actually has. This script asks.
 *
 * Read-only. Sends nothing but Export requests.
 *
 *   npx tsx server/scripts/verify-request-builder.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

import {
  buildCollection, buildReport, dateBetween, onDate, alterIdAbove,
  readCollection, tagOf, type ReadOutcome,
} from "../src/services/tallyRequest.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";

async function ask(xml: string): Promise<string> {
  const res = await fetch(TALLY, { method: "POST", body: xml });
  return res.text();
}

let failures = 0;

function show(label: string, o: ReadOutcome<unknown>): void {
  const good = o.rows.length > 0;
  if (!good) failures++;
  console.log(
    `  [${good ? " ok " : "FAIL"}] ${label.padEnd(32)} ${String(o.rows.length).padStart(5)} rows  ` +
    `${String(Math.round(o.bytes / 1024)).padStart(5)} KB`,
  );
  // G7: when it is empty, say WHICH kind of empty.
  if (!good) console.log(`         ${o.note}`);
}

async function main(): Promise<void> {
  console.log("\n  REQUEST BUILDER, AGAINST THE LIVE TALLY");
  console.log(`  ${TALLY} · ${COMPANY}`);
  console.log("  " + "─".repeat(62));

  show("Ledger", readCollection(
    await ask(buildCollection({
      id: "VrbLedger", type: "Ledger",
      fetch: ["NAME", "PARENT", "LEDSTATENAME", "PARTYGSTIN", "CREDITPERIOD"],
      company: COMPANY,
    })), "LEDGER", (b) => tagOf(b, "NAME") ?? null));

  show("StockItem", readCollection(
    await ask(buildCollection({
      id: "VrbItem", type: "StockItem",
      fetch: ["NAME", "BASEUNITS", "CLOSINGBALANCE"],
      company: COMPANY,
    })), "STOCKITEM", (b) => tagOf(b, "NAME") ?? null));

  show("StockGroup", readCollection(
    await ask(buildCollection({ id: "VrbGrp", type: "StockGroup", fetch: ["NAME", "PARENT"], company: COMPANY })),
    "STOCKGROUP", (b) => tagOf(b, "NAME") ?? null));

  show("Godown", readCollection(
    await ask(buildCollection({ id: "VrbGod", type: "Godown", fetch: ["NAME", "PARENT"], company: COMPANY })),
    "GODOWN", (b) => tagOf(b, "NAME") ?? null));

  show("Unit", readCollection(
    await ask(buildCollection({ id: "VrbUnit", type: "Unit", fetch: ["NAME", "BASEUNITS"], company: COMPANY })),
    "UNIT", (b) => tagOf(b, "NAME") ?? null));

  show("Bills (open)", readCollection(
    await ask(buildCollection({
      id: "VrbBill", type: "Bills",
      fetch: ["NAME", "PARENT", "BILLDATE", "CLOSINGBALANCE", "BILLCREDITPERIOD"],
      company: COMPANY,
    })), "BILL", (b) => tagOf(b, "NAME") ?? null));

  // The date filter — the shape that silently returns zero rows when written by hand.
  show("Voucher · FY26-27", readCollection(
    await ask(buildCollection({
      id: "VrbVch", type: "Voucher",
      fetch: ["DATE", "VOUCHERTYPENAME", "VOUCHERNUMBER", "ALTERID", "PARTYLEDGERNAME"],
      filter: dateBetween("20260401", "20270331"),
      company: COMPANY,
    })), "VOUCHER", (b) => tagOf(b, "DATE") ?? null));

  show("Voucher · one day", readCollection(
    await ask(buildCollection({
      id: "VrbDay", type: "Voucher",
      fetch: ["DATE", "VOUCHERNUMBER", "VOUCHERTYPENAME"],
      filter: onDate("20260913"),
      company: COMPANY,
    })), "VOUCHER", (b) => tagOf(b, "VOUCHERNUMBER") ?? null));

  // The incremental shape. This is what makes AlterID sync possible at all.
  show("Voucher · AlterID watermark", readCollection(
    await ask(buildCollection({
      id: "VrbAlt", type: "Voucher",
      fetch: ["ALTERID", "VOUCHERNUMBER", "VOUCHERTYPENAME"],
      filter: alterIdAbove(355000),
      company: COMPANY,
    })), "VOUCHER", (b) => tagOf(b, "ALTERID") ?? null));

  show("Report · Trial Balance", readCollection(
    await ask(buildReport("Trial Balance", COMPANY, "20260401", "20270331")),
    "DSPACCNAME", (b) => tagOf(b, "DSPDISPNAME") ?? null));

  console.log("  " + "─".repeat(62));
  console.log(
    failures === 0
      ? "\n  Every builder shape was answered by the live Tally.\n"
      : `\n  ${failures} shape(s) returned nothing — see the note on each.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
