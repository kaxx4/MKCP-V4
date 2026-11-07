/**
 * The masters of the go-live swap store, on the dummy Tally (reports/1-5.md "what is not filled"): ledger details, stock
 * items, stock groups, GST rates and the company row, read one request at a time (each under 120 s, no retry) and written
 * to the swap store as TEST rows of a ZZTEST company key, then checked and swept.
 *
 * Order, and why: (1) one cheap read first, with a 60 s limit, that also proves the open company's GUID; if it does not
 * answer the rig stops and never restarts Tally; (2) the masters run (services/erpMasters.ts); (3) the checks below, all
 * against the database; (4) the clean-up, with its result checked and the leftover rows counted.
 * A watchdog ends the rig if no Tally request completes for 300 s, and in any case at 590 s. Nothing is sent to Tally
 * after the masters run: no report request here.
 *
 * Needs: sandbox role, local Tally with the practice company open, the Tally slot, MKCP_ERP_TEST_QUEUE=on for this one
 * process, this machine's key, committed code.
 *
 *   $env:MKCP_ERP_TEST_QUEUE='on'; npx tsx scripts/rigs/masters-dummy.ts --out <file.json>
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";
guardScriptWrites("rigs/masters-dummy");
import { tallyPost } from "../../src/tally.js";
import { erpTestQueueClient, agentMachineId, agentMachineKey } from "../../src/services/supabaseClient.js";
import { practiceCompany, practiceGuid } from "../../src/services/tallyRole.js";
import { buildCollectionXml } from "../../src/services/xmlBuilder.js";
import { scrubName, scrubSaltFrom } from "../../src/services/erpMirrorSync.js";
import { MASTER_TABLES, PERSONAL_LEDGER_COLUMNS, fetchGstWithinLimit, runMasters, supabaseMastersStore, type MasterTable } from "../../src/services/erpMasters.js";
import { rigExitCode, swapStoreCleanup, type RigCheck } from "./rigExit.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const OUT = arg("--out");
const company = practiceCompany();
if (!company) { console.error("MKCP_PRACTICE_COMPANY is not set"); process.exit(2); }
if (!practiceGuid()) { console.error("MKCP_PRACTICE_COMPANY_GUID is not set: the rig will not read a company it cannot identify"); process.exit(2); }
const c = erpTestQueueClient();
const machine = agentMachineId(), key = agentMachineKey();
const stamp = Date.now().toString().slice(-6);
const companyKey = `ZZTEST-MASTERS-${stamp}`;
const salt = scrubSaltFrom(key);
const steps: { step: string; ok: boolean; detail: string; at: string }[] = [];
const checks: RigCheck[] = [];
const step = (s: string, ok: boolean, detail = "") => { steps.push({ step: s, ok, detail, at: new Date().toISOString() }); checks.push({ name: s, ok, detail }); console.log(`  ${ok ? "✓" : "✗"} ${s}${detail ? ` (${detail})` : ""}`); };
const EXPECTED_CHECKS = 16;

function provenance() {
  const git = (...a: string[]) => (spawnSync("git", a, { encoding: "utf8", cwd: dirname(process.argv[1]) }).stdout ?? "").trim();
  return { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirtyFiles: git("status", "--porcelain", "--", "..", "../../src").split("\n").filter(Boolean) };
}

/** The columns of each tally_* table less synced_at and id (the order of the live tables, read 6-Nov-2026). */
const COLUMNS: Record<MasterTable, string[]> = {
  tally_companies: ["name"],
  tally_stock_groups: ["guid", "company", "name", "parent", "is_addable"],
  tally_stock_items: ["guid", "company", "name", "parent", "category", "base_units", "additional_units", "denominator", "opening_balance", "opening_rate", "opening_value",
    "closing_balance", "closing_rate", "closing_value", "gst_applicable", "gst_type_of_supply", "costing_method", "valuation_method", "is_batch_wise", "is_cost_centre", "gst_details", "hsn_details"],
  tally_ledgers: ["guid", "company", "name", "parent", "opening_balance", "gstin", "credit_period", "state", "country", "pincode", "mailing_name", "address", "phone", "email"],
  tally_gst_rates: ["company", "scope", "name", "effective_from", "gst_rate", "cgst_rate", "sgst_rate", "igst_rate", "taxability", "parent"],
};

let lastTallyActivity = Date.now();
const t0 = Date.now();
let finishing = false;

async function finish(report: Record<string, unknown>): Promise<never> {
  if (finishing) process.exit(3);
  finishing = true;
  const swapClean = await swapStoreCleanup(c, machine, key, companyKey).catch((e) => ({ ok: false, detail: String(e) }));
  step("this run's swap-store rows are deleted and none is left", swapClean.ok, swapClean.detail);
  const full = { rig: "masters-dummy", stamp, companyKey, provenance: provenance(), minutes: Math.round((Date.now() - t0) / 6000) / 10, steps, ...report,
    passed: steps.filter((s) => s.ok).length, failed: steps.filter((s) => !s.ok).length };
  if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(full, null, 2)); }
  console.log(`\n  ${full.passed} passed, ${full.failed} failed (${full.minutes} min)`);
  process.exit(rigExitCode(checks, EXPECTED_CHECKS));
}

// the watchdog: never wait on Tally for long
setInterval(() => {
  const quiet = Date.now() - lastTallyActivity, total = Date.now() - t0;
  if (quiet > 300_000 || total > 590_000) {
    step("the watchdog ended the run (no Tally request completed for 300 s, or 590 s in all); Tally is NOT restarted", false, `quiet ${Math.round(quiet / 1000)} s, total ${Math.round(total / 1000)} s`);
    void finish({ aborted: "watchdog" });
  }
}, 5000).unref();

(async () => {
  const prov = provenance();
  console.log(`\n  Masters of the swap store on the dummy Tally (stamp ${stamp}, commit ${prov.commit.slice(0, 8)})\n`);
  step("the run uses committed code (no uncommitted change in the agent's src or scripts)", prov.dirtyFiles.length === 0, prov.dirtyFiles.join(", "));
  let report: Record<string, unknown> = {};
  try {
    // 1. one cheap read, 60 s, no retry
    const cheap = { name: "mkcpCheapCompanies", tallyCollection: "Company", metadataType: "Company", category: "master", fetch: ["Name", "Guid"], timeout: 60_000, parallel: false } as any;
    const c0 = Date.now();
    const r: any = await tallyPost(TALLY_URL, buildCollectionXml(cheap, company!), 60_000, false);
    lastTallyActivity = Date.now();
    const col = r?.ENVELOPE?.BODY?.DATA?.COLLECTION;
    const list = [].concat(col?.COMPANY ?? col?.["COMPANY.LIST"] ?? []) as any[];
    const guids = list.map((x) => String(x?.GUID?.["#text"] ?? x?.GUID ?? "").trim());
    step("one cheap read first (60 s limit): Tally answered and the open company's GUID is the practice company's", guids.length === 1 && guids[0] === practiceGuid(), `${Date.now() - c0} ms, ${guids.length} company`);
    if (!(guids.length === 1 && guids[0] === practiceGuid())) throw new Error("the cheap read did not confirm the practice company; stopping without touching Tally again");

    // 2. the masters
    const store = supabaseMastersStore(c as any, machine, key, companyKey, true);
    const post = async (xml: string, ms: number) => { const v = await tallyPost(TALLY_URL, xml, ms, false); lastTallyActivity = Date.now(); return v; };
    const mastersOpts = { company: companyKey, test: true, name: (k: string, s: string) => scrubName(k, s, salt) };
    const rep = await runMasters({ post, fetchGst: async () => { const v = await fetchGstWithinLimit(TALLY_URL, company!); lastTallyActivity = Date.now(); return v; }, store, mastersOpts, company: company!, newMarker: randomUUID });
    report = { masters: rep };
    step("the masters run finished with no error", rep.ok && !rep.error, rep.error ?? `${rep.tallyRequests} Tally requests`);
    step("every Tally request answered inside 120 s (the slowest is named)", rep.reads.length > 0 && rep.reads.every((x) => x.ms < 120_000), `slowest ${rep.reads.slice().sort((a, b) => b.ms - a.ms)[0]?.name} ${rep.reads.slice().sort((a, b) => b.ms - a.ms)[0]?.ms} ms; ${rep.reads.length} reads`);
    if (!rep.ok) throw new Error(rep.error ?? "masters failed");

    // 3. the checks
    const rowsOf = async (t: MasterTable) => {
      const out: { key: string; row: Record<string, any>; is_test: boolean }[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await c.from("erp_tally_rows").select("key,row,is_test").eq("company_key", companyKey).eq("tally_table", t).eq("is_test", true).order("key").range(from, from + 999);
        if (error) throw new Error(`erp_tally_rows ${t}: ${error.message}`);
        out.push(...((data ?? []) as any[]));
        if (!data || data.length < 1000) break;
      }
      return out;
    };
    const held = Object.fromEntries(await Promise.all(MASTER_TABLES.map(async (t) => [t, await rowsOf(t)]))) as Record<MasterTable, { key: string; row: Record<string, any>; is_test: boolean }[]>;
    step("the store holds exactly the rows the run wrote, for every table, and all are test rows", MASTER_TABLES.every((t) => held[t].length === rep.rows[t] && held[t].every((x) => x.is_test)), MASTER_TABLES.map((t) => `${t.replace("tally_", "")} ${held[t].length}/${rep.rows[t]}`).join(", "));
    step("ledgers, stock items, stock groups and GST rates are not empty on the dummy", ["tally_ledgers", "tally_stock_items", "tally_stock_groups", "tally_gst_rates"].every((t) => (rep.rows[t as MasterTable] ?? 0) > 0), MASTER_TABLES.map((t) => `${t.replace("tally_", "")} ${rep.rows[t]}`).join(", "));
    step("every row has exactly the columns of its tally_* table (less id and synced_at)", MASTER_TABLES.every((t) => held[t].every((x) => Object.keys(x.row).sort().join() === [...COLUMNS[t]].sort().join())), MASTER_TABLES.map((t) => `${t.replace("tally_", "")} ${new Set(held[t].map((x) => Object.keys(x.row).length)).size === 1 ? Object.keys(held[t][0]?.row ?? {}).length : "mixed"}`).join(", "));
    step("every ledger name is a ZZ TEST stand-in and every personal ledger column is null", held.tally_ledgers.every((x) => /^ZZ TEST LEDGER [0-9a-f]{10}$/.test(String(x.row.name)) && PERSONAL_LEDGER_COLUMNS.every((p) => x.row[p] === null)), `${held.tally_ledgers.length} ledgers`);
    step("every row carries the test company key", MASTER_TABLES.every((t) => held[t].every((x) => (t === "tally_companies" ? x.row.name : x.row.company) === companyKey)));
    const withState = held.tally_ledgers.filter((x) => x.row.state).length, withParent = held.tally_ledgers.filter((x) => x.row.parent).length;
    step("the ledger detail fields that are not personal came through the split reads (state, group, credit period)", withState > 0 && withParent === held.tally_ledgers.length, `${withState} of ${held.tally_ledgers.length} have a state; ${held.tally_ledgers.filter((x) => x.row.credit_period).length} a credit period`);
    step("stock items carry opening and closing values from their own reads", held.tally_stock_items.some((x) => x.row.closing_value !== null && x.row.closing_value !== "0") && held.tally_stock_items.every((x) => x.row.base_units), `${held.tally_stock_items.filter((x) => x.row.gst_details).length} with GST details, ${held.tally_stock_items.filter((x) => x.row.hsn_details).length} with HSN details`);
    step("a put to a voucher table is refused by the database (those are the derive's alone)", await (async () => {
      const { error } = await c.rpc("erp_tally_put", { p_machine: machine, p_key: key, p_company_key: companyKey, p_table: "tally_vouchers", p_marker: randomUUID(), p_rows: [], p_is_test: true });
      return !!error && /derive|refused/i.test(error.message);
    })());

    // the floor: a second run of one table that puts far fewer rows is refused and removes nothing
    const marker = randomUUID();
    const some = held.tally_stock_items.slice(0, 1).map((x) => ({ key: x.key, row: x.row }));
    let refused = "";
    try { await store.put("tally_stock_items", marker, some); await store.finish("tally_stock_items", marker, some.length); } catch (e) { refused = (e as Error).message; }
    const afterFloor = (await rowsOf("tally_stock_items")).length;
    step("a run that puts under 80 percent of the table is refused and removes nothing", held.tally_stock_items.length < 2 ? true : /under 80 percent/.test(refused) && afterFloor === held.tally_stock_items.length, `${refused.slice(0, 90)}; ${afterFloor} rows kept`);

    // a second full run changes nothing: same counts, nothing removed
    const rep2 = await runMasters({ post, fetchGst: async () => { const v = await fetchGstWithinLimit(TALLY_URL, company!); lastTallyActivity = Date.now(); return v; }, store, mastersOpts, company: company!, newMarker: randomUUID, log: () => {} });
    const held2 = Object.fromEntries(await Promise.all(MASTER_TABLES.map(async (t) => [t, await rowsOf(t)]))) as typeof held;
    step("a second run leaves the same rows (same keys, same row values), removing none", rep2.ok && MASTER_TABLES.every((t) => held2[t].length === held[t].length && held2[t].every((x, i) => x.key === held[t][i].key && JSON.stringify(x.row) === JSON.stringify(held[t][i].row))
      && Number((rep2.finished[t] as any)?.removed ?? 0) === 0), rep2.error ?? MASTER_TABLES.map((t) => `${t.replace("tally_", "")} removed ${(rep2.finished[t] as any)?.removed}`).join(", "));
    report = { masters: rep, secondRun: { ok: rep2.ok, reads: rep2.reads.length } };
    step("the largest put request is within the byte cap", rep.largestPutBytes <= 1_500_000 + 200_000, `${rep.largestPutRows} rows, ${rep.largestPutBytes} bytes`);
  } catch (e) {
    step("the run finished without an error", false, (e as Error).message);
  } finally {
    await finish(report);
  }
})();
