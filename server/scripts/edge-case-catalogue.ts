/**
 * The edge-case catalogue (Phase 1.3) and the parser fuzzer (Phase 1.4).
 *
 * ── What this is for ──────────────────────────────────────────────────────
 *
 * Every known silent failure, named, replayable, and run against the MOCK —
 * never against live Tally. That last part is guardrail P6 and it is not a
 * preference: an unrecognised object type raises a modal dialog that blocks
 * TallyPrime's XML port until a human walks over and restarts the
 * application. Fuzzing object types against the live company would take the
 * office offline.
 *
 * ── The one thing it is really testing ────────────────────────────────────
 *
 * Guardrail **G7**: "Tally returned nothing" and "my parser found nothing"
 * are different facts, and today they are indistinguishable. Every convertX()
 * falls through a "no DATA node" branch and returns `{ tallymessage: [] }`,
 * which is byte-identical to a legitimately empty collection. That cost
 * twenty minutes during planning alone, with full context and a live Tally to
 * poke at.
 *
 * So most cases below assert one of two things:
 *   · the converter READ the fixture correctly (a real shape, real counts), or
 *   · the pipeline DISTINGUISHED damage from emptiness rather than reporting
 *     a mangled response as a clean zero.
 *
 * Where a case asserts the current behaviour is WRONG, it says so in the
 * output rather than passing quietly. A catalogue that only records what the
 * code already does is a changelog, not a test.
 *
 *   npx tsx server/scripts/edge-case-catalogue.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { tallyPost } from "../src/tally.js";
import {
  FixtureStore, installMock, uninstallMock, mutate, mutationMeaning,
  ALL_MUTATIONS, type Mutation,
} from "../src/services/tallyMock.js";
import {
  convertStockGroups, convertUnits, convertGodowns, convertCostCentres,
  convertStockItems, convertLedgers, convertVouchers, convertCompanies,
} from "../src/converters/convert.js";
import {
  assertKnownType, KNOWN_TYPES, dateBetween, alterIdAbove,
  buildCollection, blocksOf, readCollection,
} from "../src/services/tallyRequest.js";
import { parseImportResponse } from "../src/services/voucherPusher.js";

const DIR = join(here, "..", "fixtures");
const store = new FixtureStore(DIR);

let pass = 0, fail = 0;
const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}

/** Post through the mock, catching so a rejection is a value not a crash. */
async function post(id: string, raw = false): Promise<{ ok: true; value: any } | { ok: false; err: string }> {
  const fx = store.get(id);
  if (!fx) return { ok: false, err: `no fixture "${id}"` };
  try { return { ok: true, value: await tallyPost("http://mock", fx.requestXml, 30_000, raw) }; }
  catch (e: any) { return { ok: false, err: e.message }; }
}

/** Post a DAMAGED version of a fixture's response. */
async function postMutated(id: string, how: Mutation, raw = false) {
  const fx = store.get(id)!;
  installMock(async () => mutate(fx.responseXml, how));
  const r = await post(id, raw);
  installMock(store.transport());
  return r;
}

async function main(): Promise<void> {
  console.log("\n  EDGE-CASE CATALOGUE — replayed against the mock, never live Tally");
  console.log("  " + "─".repeat(74));

  if (store.size === 0) {
    console.log("\n  No fixtures. Run: npx tsx server/scripts/capture-fixtures.ts\n");
    process.exit(1);
  }
  console.log(`  ${store.size} fixtures: ${store.ids().join(", ")}\n`);

  installMock(store.transport());

  // ── A. The mock is really standing in for Tally ─────────────────────────
  console.log("  A. The mock replaces the socket and nothing else");

  const health = await post("List of Companies");
  check("a live-captured response replays through tallyPost", health.ok);

  const unknown = await (async () => {
    installMock(store.transport());
    try { await tallyPost("http://mock", "<ENVELOPE><HEADER><ID>Nothing At All</ID></HEADER></ENVELOPE>", 5_000); return null; }
    catch (e: any) { return e.message; }
  })();
  check("an uncaptured shape THROWS rather than answering empty",
    !!unknown && unknown.includes("No fixture"),
    "a mock that answers unknown shapes with an empty envelope reproduces the bug it exists to catch");

  // ── B. Every converter reads its real fixture ───────────────────────────
  console.log("\n  B. Each converter against the shape Tally actually sends");

  const cases: [string, string, (p: any) => { tallymessage: any[] } | any[]][] = [
    ["stockGroups", "MKCP_StockGroup", convertStockGroups],
    ["units", "MKCP_Unit", convertUnits],
    ["godowns", "MKCP_Godown", convertGodowns],
    ["costCentres", "MKCP_CostCentre", convertCostCentres],
    ["stockItems", "MKCP_StockItem", convertStockItems],
    ["ledgers", "MKCP_Ledger", convertLedgers],
    ["vouchers", "MKCP_Voucher", convertVouchers],
  ];

  /* A converter returning zero is not automatically a failure — this company
     genuinely has no cost centres (CMPINFO: COSTCENTRE 0). Asserting "> 0 rows"
     on every collection would be the G7 mistake in the test itself: treating an
     empty answer as a broken one. So zero is accepted ONLY when the response
     really carries no objects of that type, and that is checked, not assumed. */
  const EMPTY_TAG: Record<string, string> = {
    stockGroups: "STOCKGROUP", units: "UNIT", godowns: "GODOWN",
    costCentres: "COSTCENTRE", stockItems: "STOCKITEM", ledgers: "LEDGER", vouchers: "VOUCHER",
  };

  const baseline = new Map<string, number>();
  for (const [name, id, fn] of cases) {
    const r = await post(id);
    if (!r.ok) { check(`${name} replays`, false, r.err); continue; }
    const out = fn(r.value);
    const rows = Array.isArray(out) ? out : out.tallymessage;
    baseline.set(name, rows.length);

    if (rows.length > 0) { check(`${name} converts`, true, `${rows.length} rows`); continue; }

    const raw = store.get(id)!.responseXml;
    const probe = readCollection(raw, EMPTY_TAG[name], (b) => b);
    check(`${name} converts`, probe.emptyFromTally,
      probe.emptyFromTally
        ? `0 rows, and Tally really sent no <${EMPTY_TAG[name]}> — a genuinely empty collection, not a parser failure`
        : `0 rows but the response HAS objects — ${probe.note}`);
  }

  const comp = await post("List of Companies");
  if (comp.ok) {
    const rows = convertCompanies(comp.value);
    check("companies converts", rows.length > 0, `${rows.length} rows`);
  }

  // ── C. G7 — damage must not read as emptiness ───────────────────────────
  console.log("\n  C. G7 — \"Tally said nothing\" vs \"I could not read it\"");
  console.log("     Each row: what the pipeline DID with a response we broke on purpose.\n");

  const g7: { mutation: Mutation; outcome: string; distinguished: boolean }[] = [];

  for (const how of ALL_MUTATIONS) {
    const r = await postMutated("MKCP_Ledger", how);
    let outcome: string;
    let distinguished: boolean;

    if (!r.ok) {
      outcome = `rejected: ${r.err.slice(0, 58)}`;
      distinguished = true;                       // an error is an error — correct
    } else {
      const rows = convertLedgers(r.value).tallymessage;
      const before = baseline.get("ledgers") ?? 0;
      if (rows.length === 0) {
        outcome = "resolved, 0 rows — INDISTINGUISHABLE from an empty company";
        distinguished = false;                    // the G7 failure, exactly
      } else if (rows.length < before) {
        outcome = `resolved, ${rows.length} of ${before} rows — a PARTIAL read reported as complete`;
        distinguished = false;
      } else {
        outcome = `resolved, ${rows.length} rows (damage absorbed)`;
        distinguished = true;
      }
    }

    g7.push({ mutation: how, outcome, distinguished });
    console.log(`     ${how.padEnd(20)} ${distinguished ? "  " : "!!"} ${outcome}`);
    console.log(`     ${" ".repeat(20)}    ${mutationMeaning(how)}`);
  }

  console.log("");

  /* ── The known blind spots, named rather than tolerated ───────────────────
     `convertX()` reads a parsed object and has no way to say "this response
     was damaged". Two mutations therefore still come out of the converter as
     a clean zero. They are listed HERE, by name, so that a NEW blind spot
     fails this check loudly instead of joining a silent majority.

     `no-data-node` is NOT on this list any more: the transport now rejects a
     DATA-less envelope outright, which closed it for every read caller at
     once. That is the shape of the fix for the remaining two as well — move
     the decision to where the bytes still exist. */
  const KNOWN_BLIND: Mutation[] = ["cmpinfo-only", "attributes-stripped"];

  const blind = g7.filter((g) => !g.distinguished).map((g) => g.mutation);
  const surprises = blind.filter((m) => !KNOWN_BLIND.includes(m));
  const fixed = KNOWN_BLIND.filter((m) => !blind.includes(m));

  check("no NEW converter blind spot", surprises.length === 0,
    surprises.length ? `unlisted: ${surprises.join(", ")}` : `${KNOWN_BLIND.length} known and named`);

  for (const m of blind.filter((x) => KNOWN_BLIND.includes(x))) {
    console.log(`     known blind spot: ${m} — the converter reports 0 rows. ` +
      `readCollection() names it correctly; no convertX() uses readCollection yet.`);
  }
  if (fixed.length) console.log(`     now fixed, remove from KNOWN_BLIND: ${fixed.join(", ")}`);

  /* readCollection (tallyRequest.ts) exists BECAUSE of the blind spots above.
     It is the fix, so it is the thing that must actually hold. */
  console.log("\n     readCollection() — the G7-aware reader, on the same damage.");
  console.log("     It must always name WHICH fact it is reporting. Silence is the bug.\n");

  /** A deliberately minimal parser: a LEDGER block is real if it has a name. */
  const parseLedger = (b: string) => {
    const n = b.match(/NAME="([^"]*)"/i)?.[1];
    return n ? { name: n } : null;
  };

  let readerBlind = 0;
  const fx = store.get("MKCP_Ledger")!;
  for (const how of ALL_MUTATIONS) {
    const r = readCollection(mutate(fx.responseXml, how), "LEDGER", parseLedger);
    /* "Named" means the outcome carries a fact, not just a row count of zero.
       Rows found is itself a fact; so is each of the three failure flags. */
    const named = r.rows.length > 0 || r.emptyFromTally || r.unparsed || r.noDataNode;
    if (!named) readerBlind++;
    console.log(`     ${how.padEnd(20)} ${named ? "  " : "!!"} ${r.note.slice(0, 96)}`);
  }
  check("readCollection names which fact it is reporting, on every mutation",
    readerBlind === 0,
    readerBlind ? `${readerBlind} mutation(s) produced an unexplained zero` : "");

  // ── D. The request-side traps ───────────────────────────────────────────
  console.log("\n  D. Request-side traps — made unwritable rather than merely documented");

  check("an unrecognised object type is refused BEFORE it reaches the socket",
    (() => { try { assertKnownType("SalesOrderThing"); return false; } catch { return true; } })(),
    "live, this raises a modal that blocks the port until a human restarts Tally");

  check("every known type passes its own guard",
    KNOWN_TYPES.every((t) => { try { assertKnownType(t); return true; } catch { return false; } }),
    `${KNOWN_TYPES.length} types`);

  /* Filters are STRUCTURE, rendered with escaping — there is no string path a
     raw `>=` can travel down. Prove it by rendering one and reading the XML. */
  const alterXml = buildCollection({
    id: "probe", type: "Ledger", fetch: ["Name"], filter: alterIdAbove(1000),
  });
  const filterLine = alterXml.match(/<SYSTEM[^>]*>([\s\S]*?)<\/SYSTEM>/i)?.[1] ?? "";
  check("a comparison filter renders escaped", filterLine.includes("&gt;"),
    `unescaped this returns ZERO ROWS WITH NO ERROR — rendered: ${filterLine.trim()}`);
  check("the rendered filter carries no bare < or >", !/[<>]/.test(filterLine));

  const rangeXml = buildCollection({
    id: "probe", type: "Voucher", fetch: ["Date"], filter: dateBetween("20260401", "20260430"),
  });
  check("a date range renders both bounds, both escaped",
    rangeXml.includes("20260401") && rangeXml.includes("20260430") &&
    rangeXml.includes("&gt;=") && rangeXml.includes("&lt;="));

  check("a raw > in a filter expression is refused at build time",
    (() => {
      try {
        buildCollection({ id: "p", type: "Ledger", fetch: ["Name"],
          filter: { kind: "compare", expr: "$AlterID > 5", cmp: "gt", value: 1 } });
        return false;
      } catch { return true; }
    })(),
    "this is the exact shape that silently returned zero rows");

  check("a .* wildcard is refused in a fetch list",
    (() => {
      try { buildCollection({ id: "p", type: "Voucher", fetch: ["AllLedgerEntries.*"] }); return false; }
      catch { return true; }
    })(),
    "a wildcard fetch field crashes TallyPrime outright");

  // ── E. The splitter, on both tag shapes ─────────────────────────────────
  console.log("\n  E. blocksOf — the two tag shapes that split differently");

  const withAttrs = `<X><BILL NAME="a"><N>1</N></BILL><BILL NAME="b"><N>2</N></BILL></X>`;
  const noAttrs = `<X><DSPACCNAME><N>1</N></DSPACCNAME><DSPACCNAME><N>2</N></DSPACCNAME></X>`;
  check("<BILL NAME=…> splits", blocksOf(withAttrs, "BILL").length === 2, `${blocksOf(withAttrs, "BILL").length}`);
  check("<DSPACCNAME> with no attributes splits",
    blocksOf(noAttrs, "DSPACCNAME").length === 2,
    `a <TAG\\s pattern reads this as 0 — it is how the Trial Balance read as empty`);

  const singular = `<X><BILLS><BILL><N>1</N></BILL></BILLS></X>`;
  check("<BILLS> wrapper is not mistaken for a <BILL>", blocksOf(singular, "BILL").length === 1);

  const countTag = `<X><CMPINFO><LEDGER>295</LEDGER></CMPINFO><LEDGER NAME="real"><N>1</N></LEDGER></X>`;
  check("a CMPINFO count tag is not counted as an object",
    blocksOf(countTag, "LEDGER").length === 1,
    `preamble counts look exactly like objects — got ${blocksOf(countTag, "LEDGER").length}`);

  // ── F. The import response — the silent-failure signature ───────────────
  console.log("\n  F. parseImportResponse — EXCEPTIONS is the signal that means 'silently wrong'");

  const imp = (b: string) => parseImportResponse(b);
  const okRes = imp(`<ENVELOPE><HEADER></HEADER><BODY><DATA><IMPORTRESULT><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><EXCEPTIONS>0</EXCEPTIONS></IMPORTRESULT></DATA></BODY></ENVELOPE>`);
  check("a clean create reads as created=1", okRes.created === 1 && (okRes.exceptions ?? 0) === 0);

  const exc = imp(`<ENVELOPE><BODY><DATA><IMPORTRESULT><CREATED>0</CREATED><ERRORS>0</ERRORS><EXCEPTIONS>1</EXCEPTIONS></IMPORTRESULT></DATA></BODY></ENVELOPE>`);
  check("EXCEPTIONS=1 with ERRORS=0 is surfaced, not swallowed",
    exc.exceptions === 1,
    "created=0, errors=0, no message — this is what a wrong ledger tag looks like");
  check("EXCEPTIONS=1 is not reported as a success", !(exc.created && exc.created > 0));

  const alt = imp(`<ENVELOPE><BODY><DATA><IMPORTRESULT><ALTERED>1</ALTERED><ERRORS>0</ERRORS></IMPORTRESULT></DATA></BODY></ENVELOPE>`);
  check("ALTERED is read", alt.altered === 1, "an ISCANCELLED flag returns altered=1 and leaves the voucher LIVE");

  const del = imp(`<ENVELOPE><BODY><DATA><IMPORTRESULT><DELETED>1</DELETED><ERRORS>0</ERRORS></IMPORTRESULT></DATA></BODY></ENVELOPE>`);
  check("DELETED is read", del.deleted === 1);

  // ── G. The two facts a captured fixture can settle ──────────────────────
  console.log("\n  G. Settling the KB conflict by looking at the bytes (Phase 1.6)");

  const vfx = store.get("MKCP_Voucher")!;
  const hasAll = /<ALLLEDGERENTRIES\.LIST>/i.test(vfx.responseXml);
  const hasPlain = /<LEDGERENTRIES\.LIST>/i.test(vfx.responseXml);
  console.log(`     ALLLEDGERENTRIES.LIST present: ${hasAll}`);
  console.log(`     LEDGERENTRIES.LIST present:    ${hasPlain}`);
  check("the export carries ALLLEDGERENTRIES.LIST", hasAll,
    "the KB claims LEDGERENTRIES only — on the read side that is wrong");
  if (hasAll && hasPlain) {
    console.log("     BOTH are present — reading both double-counts. Prefer ALL, fall back to plain.");
  }

  const bom = vfx.responseXml.charCodeAt(0);
  console.log(`     first char of the response: U+${bom.toString(16).toUpperCase().padStart(4, "0")} ` +
    `(${bom === 0xfeff ? "BOM — UTF-16 claim supported" : "no BOM — UTF-8 on the read side"})`);

  uninstallMock();

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log("\n  " + "─".repeat(74));
  console.log(`  ${pass} passed · ${fail} failed`);
  if (fail) {
    console.log("\n  Failing:");
    for (const r of results.filter((x) => !x.ok)) console.log(`    · ${r.name}${r.detail ? " — " + r.detail : ""}`);
  }
  console.log("");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { uninstallMock(); console.error(e); process.exit(1); });
