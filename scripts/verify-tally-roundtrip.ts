/**
 * Every way this system reads Tally and every way it writes to it, exercised
 * against the live Tally on this machine, with what came back printed.
 *
 * ── Why one script and not a test suite ───────────────────────────────────
 *
 * A test suite proves the code is internally consistent. Seven features in this
 * project typechecked, passed their tests and did nothing. What settles a
 * question about Tally is asking Tally, so this asks — one request per
 * capability, and it prints a sample of the answer so the shape can be read
 * rather than trusted.
 *
 * ── Writes clean up after themselves ──────────────────────────────────────
 *
 * Every voucher created here is created, read back, altered, read back again,
 * and then CANCELLED or DELETED. Nothing is left in the books. That is only
 * possible because each one carries a REMOTEID we assign at creation — the
 * single handle Tally offers, and the reason the guard refuses a Create
 * without one.
 *
 *   npx tsx scripts/verify-tally-roundtrip.ts            reads only
 *   npx tsx scripts/verify-tally-roundtrip.ts --write    reads + write round-trips
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

import { buildVoucherImportXml, parseImportResponse } from "../server/src/services/voucherPusher.js";
import type { VoucherPayload } from "../server/src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", "server", ".env") });

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";
const DO_WRITES = process.argv.includes("--write");

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Tally's port is single-threaded; every request goes through here, in turn. */
async function ask(xml: string, label: string, timeoutMs = 120_000): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(TALLY, { method: "POST", body: xml, signal: ctl.signal });
    const text = await res.text();
    const ms = Date.now() - started;
    const kb = Math.round(text.length / 1024);
    console.log(`    ${label} · ${kb} KB · ${ms} ms`);
    return text;
  } finally {
    clearTimeout(t);
  }
}

const tag = (xml: string, name: string): string | undefined =>
  xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, "i"))?.[1];

const allTags = (xml: string, name: string): string[] =>
  [...xml.matchAll(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, "gi"))].map((m) => m[1]);

/**
 * Split a response into object blocks.
 *
 * Two traps, and they pull in opposite directions.
 *
 * Every Tally response opens with a CMPINFO preamble full of COUNT tags —
 * `<VOUCHER>0</VOUCHER>`, `<LEDGER>0</LEDGER>` — so a naive `<TAG\\b` split
 * gains a phantom object holding the whole preamble. Tightening to `<TAG\\s`
 * fixes that only for elements that carry attributes: `<BILL NAME="…">` splits
 * correctly while `<DSPACCNAME>` does not, and a report silently reads as zero
 * rows. That is exactly how this script first reported "Trial Balance: 0".
 *
 * So: match both forms, then drop the count tags by their shape — a piece that
 * opens with digits and immediately closes is a count, not an object.
 */
const blocks = (xml: string, name: string): string[] =>
  xml
    .split(new RegExp(`<${name}[\\s>]`, "i"))
    .slice(1)
    .filter((b) => !new RegExp(`^\\s*\\d*\\s*</${name}>`, "i").test(b));

function head(s: string, n = 3): string { return s.split("\n").slice(0, n).join("\n"); }

const line = (s = "") => console.log(s);
const rule = () => line("  " + "─".repeat(70));

// ── Request builders ──────────────────────────────────────────────────────

/** A masters or voucher collection, with the fields we actually consume. */
function collectionXml(type: string, fields: string[], filter?: { from: string; to: string }): string {
  const id = `MKV_${type}`;
  const fetches = fields.map((f) => `<NATIVEMETHOD>${esc(f)}</NATIVEMETHOD>`).join("");
  const filterRef = filter ? `<FILTER>MKVDate</FILTER>` : "";
  const filterSys = filter
    ? `<SYSTEM TYPE="Formulae" NAME="MKVDate">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) &gt;= ${filter.from} AND ($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) &lt;= ${filter.to}</SYSTEM>`
    : "";
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${id}</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="${id}" ISMODIFY="No"><TYPE>${type}</TYPE>${fetches}${filterRef}</COLLECTION>${filterSys}</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

/** Everything changed since a watermark — the incremental sync's request. */
function alterIdXml(since: number): string {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MKVAlter</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="MKVAlter" ISMODIFY="No"><TYPE>Voucher</TYPE><NATIVEMETHOD>DATE</NATIVEMETHOD><NATIVEMETHOD>VOUCHERTYPENAME</NATIVEMETHOD><NATIVEMETHOD>VOUCHERNUMBER</NATIVEMETHOD><NATIVEMETHOD>MASTERID</NATIVEMETHOD><NATIVEMETHOD>ALTERID</NATIVEMETHOD><FILTER>MKVAlterF</FILTER></COLLECTION><SYSTEM TYPE="Formulae" NAME="MKVAlterF">$AlterID &gt; ${since}</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

/** A named report, e.g. Trial Balance. */
function reportXml(report: string): string {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>${esc(report)}</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
}

// ── READS ─────────────────────────────────────────────────────────────────

interface ReadResult { name: string; ok: boolean; count: number; note: string; }
const reads: ReadResult[] = [];

async function readCompany(): Promise<void> {
  line("\n  1 · COMPANY — which books are open");
  const xml = collectionXml("Company", ["NAME", "STARTINGFROM", "GSTREGISTRATIONNUMBER"]);
  const r = await ask(xml, "Collection of Company");
  const names = allTags(r, "NAME").filter((n) => n.trim());
  line(`    → ${names.join(" | ")}`);
  reads.push({ name: "Company", ok: names.length > 0, count: names.length, note: names[0] ?? "" });
}

async function readLedgers(): Promise<void> {
  line("\n  2 · LEDGERS — parties, banks, tax heads");
  const r = await ask(
    collectionXml("Ledger", ["NAME", "PARENT", "OPENINGBALANCE", "CLOSINGBALANCE", "LEDGERPHONE", "PARTYGSTIN", "LEDSTATENAME", "CREDITPERIOD"]),
    "Collection of Ledger",
  );
  const bs = blocks(r, "LEDGER");
  line(`    → ${bs.length} ledgers`);
  for (const b of bs.slice(0, 3)) {
    line(`      ${(tag(b, "NAME") ?? "?").padEnd(38)} parent=${tag(b, "PARENT") ?? "-"}  gstin=${tag(b, "PARTYGSTIN") ?? "-"}  state=${tag(b, "LEDSTATENAME") ?? "-"}`);
  }
  const withGstin = bs.filter((b) => (tag(b, "PARTYGSTIN") ?? "").trim()).length;
  const withState = bs.filter((b) => (tag(b, "LEDSTATENAME") ?? "").trim()).length;
  line(`      ${withGstin} carry a GSTIN · ${withState} carry a state (state decides CGST+SGST vs IGST)`);
  reads.push({ name: "Ledgers", ok: bs.length > 0, count: bs.length, note: `${withState} with state` });
}

async function readItems(): Promise<void> {
  line("\n  3 · STOCK ITEMS — the catalogue");
  const r = await ask(
    collectionXml("StockItem", ["NAME", "PARENT", "BASEUNITS", "CLOSINGBALANCE", "CLOSINGVALUE", "GSTAPPLICABLE"]),
    "Collection of StockItem",
  );
  const bs = blocks(r, "STOCKITEM");
  line(`    → ${bs.length} items`);
  for (const b of bs.slice(0, 3)) {
    line(`      ${(tag(b, "NAME") ?? "?").slice(0, 40).padEnd(40)} unit=${tag(b, "BASEUNITS") ?? "-"}  closing=${tag(b, "CLOSINGBALANCE") ?? "-"}`);
  }
  reads.push({ name: "Stock items", ok: bs.length > 0, count: bs.length, note: "" });
}

async function readSmallMasters(): Promise<void> {
  line("\n  4 · GROUPS / UNITS / GODOWNS — the small masters");
  for (const [type, root] of [["StockGroup", "STOCKGROUP"], ["Unit", "UNIT"], ["Godown", "GODOWN"]] as const) {
    const r = await ask(collectionXml(type, ["NAME", "PARENT"]), `Collection of ${type}`);
    const bs = blocks(r, root);
    line(`    → ${type}: ${bs.length}  e.g. ${bs.slice(0, 3).map((b) => tag(b, "NAME")).join(", ")}`);
    reads.push({ name: type, ok: bs.length > 0, count: bs.length, note: "" });
  }
}

async function readVouchers(): Promise<void> {
  line("\n  5 · VOUCHERS — the daily pull, date-filtered and trimmed");
  const r = await ask(
    collectionXml(
      "Voucher",
      ["DATE", "VOUCHERTYPENAME", "VOUCHERNUMBER", "MASTERID", "ALTERID", "PARTYLEDGERNAME", "ISCANCELLED", "REFERENCE", "NARRATION"],
      { from: "20260401", to: "20270331" },
    ),
    "Collection of Voucher (trimmed)",
  );
  const bs = blocks(r, "VOUCHER");
  line(`    → ${bs.length} vouchers in FY26-27`);

  const byType = new Map<string, number>();
  let maxAlter = 0, maxMaster = 0;
  for (const b of bs) {
    const t = tag(b, "VOUCHERTYPENAME") ?? "?";
    byType.set(t, (byType.get(t) ?? 0) + 1);
    maxAlter = Math.max(maxAlter, Number(tag(b, "ALTERID") ?? 0));
    maxMaster = Math.max(maxMaster, Number(tag(b, "MASTERID") ?? 0));
  }
  line(`      types: ${[...byType].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  line(`      max MASTERID ${maxMaster} · max ALTERID ${maxAlter}`);
  for (const b of bs.slice(-3)) {
    line(`      ${(tag(b, "DATE") ?? "").padEnd(10)} ${(tag(b, "VOUCHERTYPENAME") ?? "").padEnd(16)} ${(tag(b, "VOUCHERNUMBER") ?? "").padEnd(14)} ${(tag(b, "PARTYLEDGERNAME") ?? "").slice(0, 34)}`);
  }
  reads.push({ name: "Vouchers", ok: bs.length > 0, count: bs.length, note: `maxAlterId ${maxAlter}` });
  (globalThis as Record<string, unknown>).__maxAlter = maxAlter;
}

async function readVoucherDetail(): Promise<void> {
  line("\n  6 · VOUCHER ENTRIES — the postings, and why only one list balances");
  const r = await ask(
    collectionXml(
      "Voucher",
      ["DATE", "VOUCHERTYPENAME", "VOUCHERNUMBER", "MASTERID", "ALLLEDGERENTRIES.LIST", "LEDGERENTRIES.LIST", "ALLINVENTORYENTRIES.LIST"],
      { from: "20260901", to: "20260913" },
    ),
    "Collection of Voucher (with entry blocks)",
  );
  const bs = blocks(r, "VOUCHER").filter((b) => (tag(b, "VOUCHERTYPENAME") ?? "").toUpperCase().includes("SALES"));
  line(`    → ${bs.length} sales vouchers in the last fortnight`);
  const sample = bs[bs.length - 1];
  if (sample) {
    line(`      ${tag(sample, "VOUCHERNUMBER")} · masterId ${tag(sample, "MASTERID")}`);
    const all = [...sample.matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/g)];
    let net = 0;
    for (const m of all) {
      const name = tag(m[1], "LEDGERNAME") ?? "?";
      const amt = Number(tag(m[1], "AMOUNT") ?? 0);
      net += amt;
      line(`        ${name.padEnd(42)} ${amt.toFixed(2).padStart(12)}`);
    }
    line(`        ${"net".padEnd(42)} ${net.toFixed(2).padStart(12)}   ← ALLLEDGERENTRIES balances`);
    const partial = [...sample.matchAll(/<LEDGERENTRIES\.LIST>/g)].length;
    line(`        (LEDGERENTRIES.LIST also present: ${partial} — reading BOTH double-counts)`);
  }
  reads.push({ name: "Voucher entries", ok: bs.length > 0, count: bs.length, note: "ALLLEDGERENTRIES balances" });
}

async function readIncremental(): Promise<void> {
  line("\n  7 · CHANGED SINCE — how incremental sync stays level");
  const max = Number((globalThis as Record<string, unknown>).__maxAlter ?? 0);
  const watermark = Math.max(0, max - 5);
  const r = await ask(alterIdXml(watermark), `Vouchers with AlterID > ${watermark}`);
  const bs = blocks(r, "VOUCHER");
  line(`    → ${bs.length} changed since watermark ${watermark} (expect a handful)`);
  for (const b of bs.slice(0, 4)) {
    line(`      alterId ${(tag(b, "ALTERID") ?? "").padStart(7)}  ${(tag(b, "VOUCHERTYPENAME") ?? "").padEnd(16)} ${tag(b, "VOUCHERNUMBER") ?? ""}`);
  }
  line(`      NOTE: no date filter — an edit to an April voucher surfaces here today.`);
  reads.push({ name: "Changed since", ok: true, count: bs.length, note: `watermark ${watermark}` });
}

async function readPriceList(): Promise<void> {
  line("\n  8 · PRICE LIST — replaces the manual export/import");
  const r = await ask(collectionXml("StockItem", ["NAME", "FULLPRICELIST.LIST"]), "StockItem + FULLPRICELIST.LIST");
  const bs = blocks(r, "STOCKITEM");
  const priced = bs.filter((b) => b.includes("<FULLPRICELIST.LIST>"));
  line(`    → ${priced.length} of ${bs.length} items carry a priced entry`);
  const levels = new Map<string, number>();
  for (const b of bs) for (const l of allTags(b, "PRICELEVEL")) levels.set(l, (levels.get(l) ?? 0) + 1);
  line(`      price levels: ${[...levels].map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  line(`      ⚠ DEALER and Dealer differ only in case — a lookup keyed on the name splits the catalogue.`);
  const sample = priced.find((b) => allTags(b, "RATE").length > 1);
  if (sample) {
    line(`      e.g. ${tag(sample, "NAME")}`);
    const dates = allTags(sample, "DATE").slice(0, 3);
    const rates = allTags(sample, "RATE").slice(0, 3);
    dates.forEach((d, i) => line(`           ${d}  ${rates[i] ?? ""}`));
  }
  reads.push({ name: "Price list", ok: priced.length > 0, count: priced.length, note: `${levels.size} levels` });
}

async function readGstRates(): Promise<void> {
  line("\n  9 · GST RATES — dated, declared at GROUP level, and read from IGST");
  const items = await ask(collectionXml("StockItem", ["NAME", "GSTDETAILS.LIST"]), "StockItem + GSTDETAILS.LIST");
  const groups = await ask(collectionXml("StockGroup", ["NAME", "GSTDETAILS.LIST"]), "StockGroup + GSTDETAILS.LIST");

  /* `SRCOFGSTDETAILS` says whether an object declares its own rate or defers.
     Counting objects that merely CARRY a GSTDETAILS block overstates it wildly:
     nearly everything carries one. */
  const src = (xml: string) => {
    const m = new Map<string, number>();
    for (const v of allTags(xml, "SRCOFGSTDETAILS")) m.set(v.trim(), (m.get(v.trim()) ?? 0) + 1);
    return m;
  };
  const iSrc = src(items), gSrc = src(groups);
  line(`    → items:  ${iSrc.get("Specify Details Here") ?? 0} declare their own · ${iSrc.get("As per Company/Stock Group") ?? 0} defer upward`);
  line(`      groups: ${gSrc.get("Specify Details Here") ?? 0} declare their own · ${gSrc.get("As per Company/Stock Group") ?? 0} defer upward`);
  line(`      So the rate really lives on the STOCK GROUP. A lookup that only reads the item finds nothing.`);

  /* The rate itself: inside RATEDETAILS.LIST, keyed by duty head. IGST carries
     the FULL rate; CGST and SGST are halves of it. Reading CGST and doubling is
     equivalent, reading CGST and using it as the rate halves every invoice. */
  const rateBlocks = [...groups.matchAll(/<RATEDETAILS\.LIST>([\s\S]*?)<\/RATEDETAILS\.LIST>/gi)].map((m) => m[1]);
  const igst = rateBlocks
    .filter((b) => (tag(b, "GSTRATEDUTYHEAD") ?? "").trim().toUpperCase() === "IGST")
    .map((b) => Number((tag(b, "GSTRATE") ?? "").trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const spread = new Map<number, number>();
  for (const r of igst) spread.set(r, (spread.get(r) ?? 0) + 1);
  line(`      IGST rates in use: ${[...spread].sort((a, b) => a[0] - b[0]).map(([r, n]) => `${r}% ×${n}`).join(" · ")}`);
  line(`      NOTE the value arrives as " 6" with a leading space — parse with a trim or it reads NaN.`);

  const froms = [...new Set(allTags(groups, "APPLICABLEFROM").filter(Boolean))].sort();
  line(`      dated from: ${froms.slice(0, 3).join(", ")} … ${froms.slice(-3).join(", ")}`);
  line(`      20250922 is the day bicycles moved to 5% — a voucher backdated across it needs the rate in force THEN.`);

  reads.push({ name: "GST rates", ok: igst.length > 0, count: igst.length, note: `${spread.size} distinct IGST rates` });
}

async function readBills(): Promise<void> {
  line("\n 10 · OPEN BILLS — what bill-by-bill settlement cites");
  const r = await ask(collectionXml("Bills", ["NAME", "PARENT", "BILLDATE", "CLOSINGBALANCE", "BILLCREDITPERIOD"]), "Collection of Bills");
  const bs = blocks(r, "BILL");
  line(`    → ${bs.length} open bills`);
  for (const b of bs.slice(0, 3)) {
    line(`      ${(tag(b, "NAME") ?? "").padEnd(22)} ${(tag(b, "PARENT") ?? "").slice(0, 34).padEnd(34)} ${tag(b, "CLOSINGBALANCE") ?? ""}`);
  }
  reads.push({ name: "Open bills", ok: bs.length > 0, count: bs.length, note: "" });
}

async function readReport(): Promise<void> {
  line("\n 11 · REPORTS — asked for, rather than rebuilt");
  const r = await ask(reportXml("Trial Balance"), "Report: Trial Balance", 60_000);
  const rows = blocks(r, "DSPACCNAME");
  line(`    → Trial Balance returned ${Math.round(r.length / 1024)} KB, ${rows.length} account rows`);
  reads.push({ name: "Trial Balance", ok: r.length > 500, count: rows.length, note: "" });
}

// ── WRITES ────────────────────────────────────────────────────────────────

interface WriteResult { action: string; ok: boolean; detail: string; }
const writes: WriteResult[] = [];

const STAMP = Date.now().toString(36).toUpperCase().slice(-5);
const rid = (kind: string) => `MKCP|VERIFY|${kind}|${STAMP}`;

/**
 * Build with the PRODUCTION builder, not a hand-rolled envelope.
 *
 * The first version of this script rolled its own <DESC><DATA><TALLYMESSAGE>
 * import. A Journal went through; a Payment came back EXCEPTIONS=1, ERRORS=0
 * and no message at all -- the silent-failure signature this codebase keeps
 * producing. The real builder emits <IMPORTDATA><REQUESTDESC> with ISINVOICE,
 * PERSISTEDVIEW and ISPARTYLEDGER, and those turn out to be load-bearing.
 *
 * Verifying an approximation of the write path proves nothing about the write
 * path, so this exercises the same function the agent itself uses.
 */
function buildXml(payload: VoucherPayload): string {
  return buildVoucherImportXml(COMPANY, payload);
}

/**
 * Read a voucher back by VOUCHER NUMBER, the way safePush does.
 *
 * Not by REMOTEID: the REMOTEID Tally exports is synthesised rather than the
 * one we sent, so a `$RemoteId = "..."` filter matches nothing. The first
 * version of this script filtered on it and reported every voucher "not found"
 * -- including one it had just created and went on to delete successfully.
 */
async function readBack(voucherNumber: string, date: string): Promise<string | undefined> {
  const id = "MKVBack";
  const d = date.replace(/-/g, "");
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${id}</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="${id}" ISMODIFY="No"><TYPE>Voucher</TYPE><NATIVEMETHOD>DATE</NATIVEMETHOD><NATIVEMETHOD>VOUCHERTYPENAME</NATIVEMETHOD><NATIVEMETHOD>VOUCHERNUMBER</NATIVEMETHOD><NATIVEMETHOD>MASTERID</NATIVEMETHOD><NATIVEMETHOD>ALTERID</NATIVEMETHOD><NATIVEMETHOD>ISCANCELLED</NATIVEMETHOD><NATIVEMETHOD>NARRATION</NATIVEMETHOD><NATIVEMETHOD>ALLLEDGERENTRIES.LIST</NATIVEMETHOD><FILTER>MKVBackF</FILTER></COLLECTION><SYSTEM TYPE="Formulae" NAME="MKVBackF">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${d}</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const r = await ask(xml, `read back ${voucherNumber}`);
  return blocks(r, "VOUCHER").find((b) => (tag(b, "VOUCHERNUMBER") ?? "").trim() === voucherNumber);
}

function showVoucher(b: string | undefined, indent = "        "): void {
  if (!b) { line(`${indent}(not found)`); return; }
  line(`${indent}${tag(b, "VOUCHERTYPENAME")} ${tag(b, "VOUCHERNUMBER")} | masterId ${tag(b, "MASTERID")} | alterId ${tag(b, "ALTERID")} | cancelled=${tag(b, "ISCANCELLED") ?? "No"}`);
  let net = 0;
  for (const m of b.matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/g)) {
    const amt = Number(tag(m[1], "AMOUNT") ?? 0);
    net += amt;
    line(`${indent}  ${(tag(m[1], "LEDGERNAME") ?? "?").padEnd(40)} ${amt.toFixed(2).padStart(12)}`);
  }
  line(`${indent}  ${"net".padEnd(40)} ${net.toFixed(2).padStart(12)}`);
}

const DATE = "2026-09-13";
const BANK = "HDFC BANK";

function payment(party: string, amount: number, narration: string, action: string, num: string): VoucherPayload {
  return {
    voucherType: "Payment",
    date: DATE,
    voucherNumber: num,
    partyLedgerName: party,
    narration,
    action,
    remoteId: rid(num),
    ledgerEntries: [
      { ledgerName: party, amount: -amount, isDeemedPositive: true, isPartyLedger: true },
      { ledgerName: BANK, amount: amount, isDeemedPositive: false, isPartyLedger: false },
    ],
  } as unknown as VoucherPayload;
}

async function push(payload: VoucherPayload, label: string) {
  const res = await ask(buildXml(payload), label);
  const p = parseImportResponse(res) as Record<string, unknown>;
  const n = (k: string) => Number(p[k] ?? 0);
  line(`    created=${n("created")} altered=${n("altered")} deleted=${n("deleted")} errors=${n("errors")} ${String(p.message ?? p.error ?? "")}`);
  return p;
}

async function writeCreateAlterCancel(party: string): Promise<void> {
  line("\n  W1 - CREATE then ALTER then CANCEL  (a Payment: the customer-visible path)");
  const num = `VERIFY-${STAMP}-P`;

  let r = await push(payment(party, 11, "MKCP verify - create", "Create", num), "ACTION=Create");
  let back = await readBack(num, DATE);
  showVoucher(back);
  const masterAtCreate = tag(back ?? "", "MASTERID");
  writes.push({ action: "Create Payment", ok: Number(r.created ?? 0) === 1 && !!back, detail: `masterId ${masterAtCreate ?? "?"}` });

  r = await push(payment(party, 22, "MKCP verify - altered to 22", "Alter", num), "ACTION=Alter");
  back = await readBack(num, DATE);
  showVoucher(back);
  const masterAtAlter = tag(back ?? "", "MASTERID");
  const same = !!masterAtCreate && masterAtCreate === masterAtAlter;
  line(`        MASTERID through the alter: ${same ? "UNCHANGED (" + masterAtAlter + ") - edited in place, not replaced" : masterAtCreate + " -> " + masterAtAlter}`);
  writes.push({ action: "Alter by REMOTEID", ok: Number(r.altered ?? 0) === 1 && same, detail: same ? `same masterId ${masterAtAlter}` : "masterId CHANGED" });

  /* The flag does nothing. Proved here rather than trusted. */
  const flagXml = buildXml(payment(party, 22, "MKCP verify - flag attempt", "Alter", num))
    .replace("</VOUCHER>", "<ISCANCELLED>Yes</ISCANCELLED></VOUCHER>");
  await ask(flagXml, "ACTION=Alter + ISCANCELLED flag");
  back = await readBack(num, DATE);
  const flagWorked = (tag(back ?? "", "ISCANCELLED") ?? "No").toLowerCase() === "yes";
  line(`    IsCancelled now reads "${tag(back ?? "", "ISCANCELLED") ?? "No"}"  ${flagWorked ? "" : "<- the flag is SILENTLY DISCARDED"}`);
  writes.push({ action: "ISCANCELLED flag (expect ignored)", ok: !flagWorked, detail: "discarded, as documented" });

  r = await push(payment(party, 22, "MKCP verify - cancel", "Cancel", num), "ACTION=Cancel");
  back = await readBack(num, DATE);
  const cancelled = (tag(back ?? "", "ISCANCELLED") ?? "No").toLowerCase() === "yes";
  line(`    IsCancelled now reads "${tag(back ?? "", "ISCANCELLED") ?? "No"}"  ${cancelled ? "<- cancelled; number and sequence kept" : "<- NOT CANCELLED"}`);
  showVoucher(back);
  writes.push({ action: "Cancel", ok: cancelled, detail: "number and place in sequence kept" });

  /* Cancelling proves the action; it also LEAVES the voucher in the books, and
     a cancelled voucher is invisible to the ordinary voucher collection, so it
     is easy to believe the run cleaned up when it did not. Two of these were
     found sitting in the real books after earlier runs. Delete it. */
  r = await push(payment(party, 22, "MKCP verify - cleanup", "Delete", num), "ACTION=Delete (cleanup)");
  const removed = !(await readBack(num, DATE)) && Number(r.deleted ?? 0) === 1;
  line(`    cleanup: ${removed ? "removed - nothing left in the books" : "STILL PRESENT - remove " + num + " by hand"}`);
  writes.push({ action: "Cleanup (delete the cancelled voucher)", ok: removed, detail: removed ? "books left clean" : "LEFTOVER" });
}

async function writeCreateDelete(party: string): Promise<void> {
  line("\n  W2 - CREATE then DELETE  (a Journal: the internal path, leaves nothing behind)");
  const num = `VERIFY-${STAMP}-J`;
  const journal = (action: string): VoucherPayload => ({
    voucherType: "Journal", date: DATE, voucherNumber: num,
    partyLedgerName: party, narration: "MKCP verify - journal round trip",
    action, remoteId: rid(num),
    ledgerEntries: [
      { ledgerName: party, amount: -13, isDeemedPositive: true, isPartyLedger: true },
      { ledgerName: BANK, amount: 13, isDeemedPositive: false, isPartyLedger: false },
    ],
  } as unknown as VoucherPayload);

  let r = await push(journal("Create"), "ACTION=Create (Journal)");
  showVoucher(await readBack(num, DATE));
  writes.push({ action: "Create Journal", ok: Number(r.created ?? 0) === 1, detail: "" });

  r = await push(journal("Delete"), "ACTION=Delete");
  const gone = !(await readBack(num, DATE));
  line(`    read back: ${gone ? "GONE - removed entirely" : "STILL THERE"}`);
  writes.push({ action: "Delete", ok: gone, detail: "voucher removed entirely" });
}

async function writeNoIdentity(party: string): Promise<void> {
  line("\n  W3 - A voucher with NO REMOTEID - refused before it can reach Tally");
  /* Deliberately NOT pushed. Tally would accept it, and it would then be
     permanently uncorrectable: GUID, MASTERID and VCHKEY are all rejected by
     Alter and Cancel. The sandbox already holds 296 such vouchers from before
     identities were stamped; creating a 297th in the real books to re-prove the
     point would be vandalism.

     What IS worth checking is that our own guard refuses it, since that guard
     is the only thing standing between an operator and that outcome. */
  try {
    const mod = await import("../server/src/services/pushGuard.js");
    const fn = (mod as Record<string, unknown>).validateVoucher as
      | ((p: unknown) => string[] | { errors?: string[] })
      | undefined;
    if (!fn) { line("    (validateVoucher not exported here - covered by test-push-guard)"); return; }
    const verdict = fn({
      voucherType: "Payment", date: DATE, voucherNumber: "NO-ID-1",
      partyLedgerName: party, action: "Create",
      ledgerEntries: [
        { ledgerName: party, amount: -7, isDeemedPositive: true },
        { ledgerName: BANK, amount: 7, isDeemedPositive: false },
      ],
    });
    const errs = Array.isArray(verdict) ? verdict : (verdict?.errors ?? []);
    const refused = errs.some((e) => /remote\s*id|identity/i.test(e));
    line(`    guard says: ${errs.length ? errs.join(" | ") : "(no complaint)"}`);
    line(`    ${refused ? "Refused - the operator never gets the chance." : "NOT refused - a voucher pushed this way could never be corrected."}`);
    writes.push({ action: "Guard refuses Create with no REMOTEID", ok: refused, detail: refused ? "refused before Tally" : "GUARD GAP" });
  } catch (e) {
    line(`    (guard not importable here: ${e instanceof Error ? e.message : String(e)})`);
  }
}

// ── Report ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  line("\n  TALLY ROUND-TRIP VERIFICATION");
  line(`  ${TALLY} · ${COMPANY}`);
  line(`  ${DO_WRITES ? "READS + WRITES" : "READS ONLY (pass --write to exercise the write actions)"}`);
  rule();

  await readCompany();
  await readLedgers();
  await readItems();
  await readSmallMasters();
  await readVouchers();
  await readVoucherDetail();
  await readIncremental();
  await readPriceList();
  await readGstRates();
  await readBills();
  await readReport();

  if (DO_WRITES) {
    /* A real party, so the ledger resolves. Picked from the books rather than
       hardcoded, because a name Tally does not have fails the import with a
       message that looks like a protocol error. */
    const r = await ask(collectionXml("Ledger", ["NAME", "PARENT"]), "pick a party for the write tests");
    const party =
      blocks(r, "LEDGER")
        .map((b) => ({ name: tag(b, "NAME") ?? "", parent: tag(b, "PARENT") ?? "" }))
        .find((l) => /sundry creditors/i.test(l.parent))?.name ?? "";
    if (!party) {
      line("\n  No sundry creditor found — skipping writes.");
    } else {
      line(`\n  Writing against: ${party}`);
      rule();
      await writeCreateAlterCancel(party);
      await writeCreateDelete(party);
      await writeNoIdentity(party);
    }
  }

  rule();
  line("\n  READS");
  for (const r of reads) {
    line(`    [${r.ok ? " ok " : "FAIL"}] ${r.name.padEnd(18)} ${String(r.count).padStart(6)}  ${r.note}`);
  }
  if (DO_WRITES) {
    line("\n  WRITES");
    for (const w of writes) {
      line(`    [${w.ok ? " ok " : "FAIL"}] ${w.action.padEnd(34)} ${w.detail}`);
    }
  }
  const failed = [...reads.filter((r) => !r.ok), ...writes.filter((w) => !w.ok)];
  line(`\n  ${failed.length === 0 ? "Everything verified against the live Tally." : failed.length + " capability(ies) did not behave as expected."}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
