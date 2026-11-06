/**
 * Task 1-5, second half, first batch, on the dummy Tally (migration 0119):
 * the ledgers with their closing balances (M-6), the job-to-mirror check
 * (D-1-5.2), A6 (a job's voucher changed in Tally), the A11 nightly key
 * compare with its one-day re-pull, and A7 (a job's voucher gone from Tally).
 *
 * The rig reads every voucher's date first and picks a short window of days
 * (a few dozen vouchers, with a day holding 5 or more), then on the ERP's own
 * test mirror on live (ZZTEST company key, test rows, names scrubbed):
 *   1. a full run reads the window and the ledgers: the mirror holds Tally's
 *      count, and the ledgers carry closing balances, under ZZ TEST names;
 *   2. the nightly check right after finds nothing that differs;
 *   3. one ZZTEST Contra goes through the ERP test queue (erp_enqueue_test_job,
 *      ErpJobAgent) on the window's busiest day; the incremental reads it and
 *      the database links the job to its mirror row by MASTERID;
 *   4. the Contra is changed directly in the dummy (a stand-in for a hand
 *      edit); the incremental reads the new AlterID and the job is flagged
 *      altered_in_tally (A6);
 *   5. the Contra is swept from the dummy and a second ZZTEST Contra is put
 *      on a day outside the window (so Tally's highest is above the mark
 *      again); the nightly check finds exactly that one day differing and
 *      queues one re-pull of it (A11);
 *   6. the re-pull prunes the swept voucher, keeps the mark, and the job is
 *      flagged vanished_from_tally (A7); the check is clean again.
 * Review of batch 1 (migration 0120, 6-Nov-2026): the Contra goes on the
 * window's smallest day, so step 6 is a small-day re-pull (under 5 vouchers)
 * that prunes only from a checked read (H1); an empty balance is stored as 0
 * and every ledger row carries its as-of date (M1, M2); the ledgers are read
 * twice as of one date and must agree, and their sum per primary group must
 * match Tally's own Trial Balance for the loaded period (D-C.2, counts only
 * in the output); the job is linked on the AlterID read after the push (M3).
 * Review 1-5 item 7: single ledgers from three or more primary groups are
 * compared to the paise with Tally's own Trial Balance for the loaded start
 * to balance_as_of (the detailed Trial Balance, and a group's line where it
 * holds one ledger with a balance), because the undated ledger read may
 * follow the period on Tally's screen rather than the company's year.
 * Everything is swept and every test row deleted. The tally_* tables are
 * never read or written. Every request to Tally goes through tallyPost, which
 * checks the practice company's GUID before sending anything.
 *
 * Needs: sandbox role, local Tally with the practice company open, the Tally
 * slot, MKCP_ERP_TEST_QUEUE=on for this one process, this machine's key.
 *
 *   $env:MKCP_ERP_TEST_QUEUE='on'; npx tsx scripts/rigs/mirror-checks-dummy.ts --part checks --out <file.json>
 *   then, after the sweep and census: ... --part tb --out <file.json>
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";
guardScriptWrites("rigs/mirror-checks-dummy"); // writes only on a sandbox role against a local Tally
import { tallyPost } from "../../src/tally.js";
import { erpTestQueueClient, agentMachineId, agentMachineKey } from "../../src/services/supabaseClient.js";
import { practiceCompany, practiceGuid } from "../../src/services/tallyRole.js";
import { safePush } from "../../src/services/safePush.js";
import { ErpJobAgent, Journal, supabaseErpQueue, tallySeams } from "../../src/services/erpJobAgent.js";
import { runMirrorSync, runRepull, runDayCheck, supabaseMirrorStore, tallyMirrorReads, eachDay, ledgerPeriod, parseBalance, assertParsedCollection, indiaToday, judgeLoadedPeriod, tallyDateToIso, type MirrorSyncReport, type DayCheckReport } from "../../src/services/erpMirrorSync.js";
import { buildCollectionXml } from "../../src/services/xmlBuilder.js";
import { txt as tallyText, arr as tallyList } from "../../src/converters/convert.js";
import { fetchReport, parseReport, REPORTS } from "../../src/services/tallyReports.js";
import { escapeXml, tallyDate as xmlTallyDate } from "../../src/services/xml.js";
import { rigPayload } from "./lib/simTally.js";
import { isSweepVoucher } from "../lib/testVoucherMatch.js";
import type { VoucherPayload } from "../../src/types.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const OUT = arg("--out");
const PART = arg("--part");
if (PART !== "checks" && PART !== "tb" && PART !== "period") { console.error("say --part checks (everything but the Trial Balance), --part period (do the undated reads see a voucher dated after the loaded period?) or --part tb (the Trial Balance comparison only, run last)"); process.exit(2); }
const company = practiceCompany();
if (!company) { console.error("MKCP_PRACTICE_COMPANY is not set"); process.exit(2); }
if (!practiceGuid()) { console.error("MKCP_PRACTICE_COMPANY_GUID is not set: the rig will not read a company it cannot identify"); process.exit(2); }
const c = erpTestQueueClient();
const machine = agentMachineId(), key = agentMachineKey();
const stamp = Date.now().toString().slice(-6);           // digits only: the sweep matches ZZTEST<digits>/<n>
const companyKey = `ZZTEST-CHECKS-${stamp}`;
const store = supabaseMirrorStore(c, machine, key, companyKey, true);
const tally = tallyMirrorReads(TALLY_URL, company);
const post = (url: string, xml: string, timeoutMs = 180_000) => tallyPost(url, xml, timeoutMs, true) as Promise<string>;
const journal = join(tmpdir(), `mirror-checks-dummy-${stamp}.jsonl`);
const sweepScript = join(dirname(process.argv[1]), "..", "sweep-test-vouchers.ts");
const tsxCli = join(dirname(process.argv[1]), "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const sweep = (day: string) => spawnSync(process.execPath, [tsxCli, sweepScript, "ZZTEST", day, "--yes"], { encoding: "utf8", env: process.env });

function provenance() {
  const git = (...a: string[]) => (spawnSync("git", a, { encoding: "utf8", cwd: dirname(process.argv[1]) }).stdout ?? "").trim();
  return { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirtyFiles: git("status", "--porcelain", "--", "..", "../../src").split("\n").filter(Boolean) };
}

/** A short run of days: 3 then 2, 20 to 200 vouchers, one day with 6 or more; the smallest such window (fast reads). */
function pickWindow(byDay: Record<string, number>) {
  const dates = Object.keys(byDay).sort();
  if (!dates.length) return null;
  const all = eachDay(dates[0], dates[dates.length - 1]);
  for (const w of [3, 2]) {
    let best: { from: string; to: string; count: number; days: number } | null = null;
    for (let i = 0; i + w <= all.length; i++) {
      const ds = all.slice(i, i + w);
      const n = ds.reduce((s, d) => s + (byDay[d] ?? 0), 0);
      if (n >= 20 && n <= 200 && ds.some((d) => (byDay[d] ?? 0) >= 6) && (!best || n < best.count)) best = { from: ds[0], to: ds[w - 1], count: n, days: w };
    }
    if (best) return best;
  }
  return null;
}

(async () => {
  const prov = provenance();
  const steps: { step: string; ok: boolean; detail: string; at: string }[] = [];
  const step = (s: string, ok: boolean, detail = "") => { steps.push({ step: s, ok, detail, at: new Date().toISOString() }); console.log(`  ${ok ? "✓" : "✗"} ${s}${detail ? ` (${detail})` : ""}`); };
  const runs: Record<string, MirrorSyncReport | DayCheckReport | null> = {};
  const counts: Record<string, unknown> = {};
  const made: { job: string; proposal: string; request: string }[] = [];
  const sw = (r: any) => (r?.swap ?? {}) as Record<string, any>;
  const mark = async () => (await c.from("erp_sync_marks").select("alter_id,scope_from,scope_to,full_due").eq("company_key", companyKey).eq("is_test", true).maybeSingle()).data as any;
  const jobCheck = async () => { const { data, error } = await c.rpc("erp_job_mirror_check", { p_machine: machine, p_key: key, p_company_key: companyKey, p_is_test: true }); if (error) throw new Error(error.message); return data as any; };
  const flags = async (job: string) => ((await c.from("erp_record_flags").select("kind,detail,resolved_at").eq("is_test", true).eq("company_key", companyKey).eq("job_id", job)).data ?? []) as any[];
  const t0 = Date.now();
  const pushedDays = new Set<string>();

  /* Coordinator, 6-Nov-2026: the Trial Balance comparison runs last, on its
     own (--part tb), after the sweep and the census. It writes nothing to the
     database. Each report request has 120 s and no retry; a timeout stops the
     part and nothing more is sent. */
  const tbProof = async () => {
    const top = await tally.highest();
    const loaded = await tally.loadedPeriod();
    const judged = judgeLoadedPeriod(loaded, indiaToday(), top.latestDate);
    const asOf: string | null = judged.asOf;
    const readA = await tally.ledgers();
    counts.loadedPeriod = { from: judged.from, to: judged.asOf, lastVoucherDate: loaded.lastVoucher ?? null, latestVoucherInAlterIdRead: top.latestDate, unexpected: judged.unexpected, why: judged.why, ledgers: readA.length, vouchers: top.count };
    const groupDef = { name: "erpRigGroups", tallyCollection: "Group", metadataType: "Group", category: "master", fetch: ["Name", "Parent"], timeout: 120_000, parallel: false } as any;
    const period = { from: judged.from ?? ledgerPeriod(asOf!).from, to: asOf! };
    /* The parsed reply (rawMode false): the rig's post returns raw text, which is never a collection. Found on the dummy, 6-Nov-2026. */
    const gParsed = assertParsedCollection(await tallyPost(TALLY_URL, buildCollectionXml(groupDef, company!), 120_000, false), "the group read");
    const gcol = gParsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;
    const parentOf = new Map<string, string>(tallyList(gcol?.GROUP ?? gcol?.["GROUP.LIST"]).map((g: any) => [(tallyText(g?.["@_NAME"]) || tallyText(g?.NAME)).trim(), tallyText(g?.PARENT).trim()]));
    /* D-M.13 carried item: a ledger whose parent is Primary (Profit & Loss
       A/c is one) is its own line in the Trial Balance, not part of a group.
       Batch 1 summed such ledgers under a made-up line "Primary", which the
       Trial Balance never has. A parent that is neither Primary nor a group
       the group read returned is counted as unresolved (never guessed). */
    const isTop = (p: string) => p === "" || p === "Primary";
    const primary = (g: string) => { let x = g; for (let i = 0; i < 50 && parentOf.get(x) && !isTop(parentOf.get(x)!); i++) x = parentOf.get(x)!; return x; };
    const lineOf = (l: { name: string; parent: string }) => isTop(l.parent) ? l.name : parentOf.has(l.parent) ? primary(l.parent) : "(unresolved parent)";
    const r2 = (n: number) => Math.round(n * 100) / 100;
    /* Found on the dummy, 6-Nov-2026 (tb2): the report parser leaves XML
       entities in names ("Loans &amp; Advances (Asset)"), so those lines never
       matched by name. The rig decodes them; the shared parser is not changed
       here (it feeds today's report snapshots). */
    const unent = (x: string) => x.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
    /* Found on the dummy, 6-Nov-2026 (tb2): the Trial Balance shows Profit &
       Loss A/c at its opening balance (9,574,442.66 = that ledger's opening, to
       the paise); this year's result is already in the income and expense
       lines. So that one line is compared with the ledger's opening. */
    const PNL = "Profit & Loss A/c";
    const figureFor = (l: { name: string; parent: string; closingbalance: string; openingbalance: string }) =>
      isTop(l.parent) && l.name === PNL ? (parseBalance(l.openingbalance) ?? 0) : (parseBalance(l.closingbalance) ?? 0);
    const sums = new Map<string, number>(), ledgersPer = new Map<string, number>(), openingPer = new Map<string, number>();
    for (const l of readA) {
      const k = lineOf(l);
      sums.set(k, r2((sums.get(k) ?? 0) + figureFor(l)));
      ledgersPer.set(k, (ledgersPer.get(k) ?? 0) + 1);
      openingPer.set(k, r2((openingPer.get(k) ?? 0) + (parseBalance(l.openingbalance) ?? 0)));
    }
    /* Our figure for every group, rolled up through the group tree, so a differing primary group can be followed one level down. */
    const rolled = new Map<string, number>();
    for (const l of readA) {
      if (isTop(l.parent) || !parentOf.has(l.parent)) continue;
      let x = l.parent;
      for (let i = 0; i < 50 && x && !isTop(x); i++) { rolled.set(x, r2((rolled.get(x) ?? 0) + (parseBalance(l.closingbalance) ?? 0))); x = parentOf.get(x) ?? ""; }
    }
    const tb = await fetchReport(TALLY_URL, company!, REPORTS.find((r) => r.key === "trial-balance")!, period, 120_000);   // coordinator: 120 s, no retry
    const tbNet = new Map<string, number>(tb.rows.map((r) => [unent(String(r.name ?? "")), r2((Number(r.debit) || 0) + (Number(r.credit) || 0))]));
    const groups = [...sums].filter(([, v]) => v !== 0);
    const same = groups.filter(([g, v]) => tbNet.has(g) && Math.abs(tbNet.get(g)! - v) < 0.01).length;
    const flipped = groups.filter(([g, v]) => tbNet.has(g) && Math.abs(tbNet.get(g)! + v) < 0.01).length;
    const matched = Math.max(same, flipped), sign = same >= flipped ? "the sign as Tally keeps it" : "the opposite sign";
    const signF = same >= flipped ? 1 : -1;
    counts.balanceProof = { asOf, period, ledgersRead: readA.length, groupsRead: parentOf.size, ledgersUnderPrimary: readA.filter((l) => isTop(l.parent)).length,
      ledgersWithUnresolvedParent: readA.filter((l) => !isTop(l.parent) && !parentOf.has(l.parent)).length,
      primaryGroupsWithBalance: groups.length, trialBalanceRows: tb.rows.length, matchedTrialBalance: matched, sign, unmatched: groups.length - matched };
    /* A record, not the check: the check is the D-M.13 step below, which also allows a group's Opening Stock line. */
    step("D-C.2 (record): primary groups whose ledgers sum to the Trial Balance line exactly",
      groups.length > 0, `${matched} of ${groups.length} primary groups match (${sign}); the Trial Balance has ${tb.rows.length} rows`);

    /* Review 1-5 item 7 (D-1-5.41): StartingFrom and EndingAt are the
       company's year, but the undated ledger read may follow the period on
       Tally's screen instead. So single ledgers are compared too, to the
       paise, against Tally's own Trial Balance for the loaded start to
       balance_as_of: the detailed Trial Balance (EXPLODEFLAG, a report, not a
       ledger collection), and, for a primary group with only one ledger
       holding a balance, that group's line in the plain Trial Balance. At
       least three ledgers from three primary groups must be compared, and
       every one compared must match. In memory only; counts in the output. */
    const factor = same >= flipped ? 1 : -1;
    const tbDetailXml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>Trial Balance</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${escapeXml(company!)}</SVCURRENTCOMPANY><SVFROMDATE>${xmlTallyDate(period.from)}</SVFROMDATE><SVTODATE>${xmlTallyDate(period.to)}</SVTODATE><EXPLODEFLAG>Yes</EXPLODEFLAG></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
    const tbDetailRaw = await post(TALLY_URL, tbDetailXml, 120_000);
    if (/<LINEERROR>/i.test(tbDetailRaw)) throw new Error("the detailed Trial Balance came back with a Tally error");
    const tbDetailRows = parseReport(REPORTS.find((r) => r.key === "trial-balance")!, tbDetailRaw)
      .map((r) => ({ name: unent(String(r.name ?? "")), fig: Math.round(((Number(r.debit) || 0) + (Number(r.credit) || 0)) * 100) / 100 }));
    const tbDetail = new Map<string, number>(tbDetailRows.map((r) => [r.name, r.fig]));
    /* D-M.13: every line that differs, ours or Tally's, with both figures.
       A name is printed only when it is one of Tally's own standard names
       (the 28 reserved groups and Tally's fixed report lines); any other
       line is "a company-made line" plus its number, never its name (the
       dummy is an old copy of the real books). Each differing primary
       group is followed one level down with the detailed Trial Balance. */
    const STANDARD = new Set(["Branch / Divisions", "Capital Account", "Current Assets", "Current Liabilities", "Direct Expenses", "Direct Incomes",
      "Fixed Assets", "Indirect Expenses", "Indirect Incomes", "Investments", "Loans (Liability)", "Misc. Expenses (ASSET)", "Purchase Accounts",
      "Sales Accounts", "Suspense A/c", "Bank Accounts", "Bank OD A/c", "Cash-in-Hand", "Deposits (Asset)", "Duties & Taxes", "Loans & Advances (Asset)",
      "Provisions", "Reserves & Surplus", "Secured Loans", "Stock-in-Hand", "Sundry Creditors", "Sundry Debtors", "Unsecured Loans",
      "Profit & Loss A/c", "Difference in opening balances", "Opening Stock", "Closing Stock", "Grand Total", "(unresolved parent)"]);
    const madeUp = new Map<string, string>();
    const safeName = (n: string) => STANDARD.has(n) ? n : (madeUp.get(n) ?? (madeUp.set(n, `a company-made line ${madeUp.size + 1}`), madeUp.get(n)!));
    const isOk = (ours: number, theirs: number | undefined) => theirs !== undefined && Math.abs(signF * theirs - ours) < 0.01;
    const childrenOf = (g: string) => [...parentOf].filter(([, p]) => p === g).map(([n]) => n);
    const differing: Record<string, unknown>[] = [];
    for (const [g, ours] of [...sums].filter(([, v]) => v !== 0)) {
      if (isOk(ours, tbNet.get(g))) continue;
      const theirs = tbNet.get(g);
      const subs = childrenOf(g);
      const kids = subs.map((s) => ({ s, ours: rolled.get(s) ?? 0, tally: tbDetail.get(s) }))
        .filter((k) => k.tally !== undefined || k.ours !== 0)
        .filter((k) => !isOk(k.ours, k.tally))
        .map((k) => ({ line: safeName(k.s), ours: k.ours, tally: k.tally === undefined ? null : r2(signF * k.tally), difference: k.tally === undefined ? null : r2(signF * k.tally - k.ours),
          ledgersOurs: readA.filter((l) => { let x = l.parent; for (let i = 0; i < 50 && x && !isTop(x); i++) { if (x === k.s) return true; x = parentOf.get(x) ?? ""; } return false; }).length }));
      const directLedgers = readA.filter((l) => l.parent === g);
      /* The detailed Trial Balance in its own order: the rows after this line up to the next line of the plain one are its parts. */
      const at = tbDetailRows.findIndex((r) => r.name === g);
      const parts: { line: string; tally: number; ours: number | null }[] = [];
      for (let i = at + 1; at >= 0 && i < tbDetailRows.length && !tbNet.has(tbDetailRows[i].name); i++) {
        const r = tbDetailRows[i];
        const led = readA.find((l) => l.name === r.name && !parentOf.has(l.name));
        parts.push({ line: safeName(r.name), tally: r2(signF * r.fig), ours: parentOf.has(r.name) ? (rolled.get(r.name) ?? 0) : led ? (parseBalance(led.closingbalance) ?? 0) : null });
      }
      const directDiff = directLedgers.filter((l) => tbDetail.has(l.name) && !isOk(parseBalance(l.closingbalance) ?? 0, tbDetail.get(l.name))).length;
      differing.push({ line: safeName(g), ours, tally: theirs === undefined ? null : r2(signF * theirs), difference: theirs === undefined ? null : r2(signF * theirs - ours),
        ledgers: ledgersPer.get(g) ?? 0, openingOfThoseLedgers: openingPer.get(g) ?? 0, subGroups: subs.length, ledgersDirectlyUnder: directLedgers.length,
        directLedgersDiffering: directDiff, subGroupsDiffering: kids,
        detailedPartsNotOurs: parts.filter((x) => x.ours === null), detailedPartsDiffering: parts.filter((x) => x.ours !== null && Math.abs(x.tally - x.ours) >= 0.01),
        detailedPartsSum: r2(parts.reduce((t, x) => t + x.tally, 0)) });
    }
    const tbOnly = [...tbNet].filter(([n, v]) => v !== 0 && !sums.has(n)).map(([n, v]) => ({ line: safeName(n), tally: r2(signF * v) }));
    counts.groupDifferences = { differing, trialBalanceLinesWithNoLedgerOfOurs: tbOnly };
    /* Found on the dummy, 6-Nov-2026 (tb3): the one group still differing,
       Current Assets, differs by exactly its Opening Stock line (23,089,054.05),
       a figure Tally takes from the stock items, not from any ledger; every
       other part of the group matched. A group differing only by that line is
       explained, and named so in the output; anything else still fails. */
    const explained = differing.filter((d: any) => d.tally !== null && d.detailedPartsDiffering.length === 0 && d.subGroupsDiffering.length === 0
      && d.detailedPartsNotOurs.length > 0 && d.detailedPartsNotOurs.every((x: any) => x.line === "Opening Stock")
      && Math.abs(d.ours + d.detailedPartsNotOurs.reduce((t: number, x: any) => t + x.tally, 0) - d.tally) < 0.01);
    step("D-M.13: every primary group matches the Trial Balance, or differs only by its Opening Stock line (stock, not a ledger balance)",
      groups.length > 0 && matched + explained.length === groups.length && tbOnly.length === 0,
      `${matched} match, ${explained.length} differ only by Opening Stock (${explained.map((d: any) => d.line).join(", ") || "none"}), ${groups.length - matched - explained.length} unexplained, ${tbOnly.length} Trial Balance lines with no ledger of ours`);
    for (const d of differing) console.log(`    differs: ${JSON.stringify(d)}`);
    for (const d of tbOnly) console.log(`    only in the Trial Balance: ${JSON.stringify(d)}`);
    const ledgerFig = new Map<string, { group: string; fig: number }>();
    for (const l of readA) if (!parentOf.has(l.name)) ledgerFig.set(l.name, { group: lineOf(l), fig: figureFor(l) });
    const compared = new Map<string, { group: string; ok: boolean; via: string }>();
    for (const [name, { group, fig }] of ledgerFig) {
      if (fig !== 0 && tbDetail.has(name)) compared.set(name, { group, ok: Math.abs(factor * tbDetail.get(name)! - fig) < 0.005, via: "detailed" });
    }
    for (const [g] of groups) {
      const holders = [...ledgerFig].filter(([, x]) => x.group === g && x.fig !== 0);
      if (holders.length === 1 && !compared.has(holders[0][0]) && tbNet.has(g)) {
        compared.set(holders[0][0], { group: g, ok: Math.abs(factor * tbNet.get(g)! - holders[0][1].fig) < 0.005, via: "only ledger of its group" });
      }
    }
    const cmp = [...compared.values()];
    const groupsCompared = new Set(cmp.map((x) => x.group)).size;
    const today = indiaToday();
    const vouchersAfterToday = Object.entries(top.byDay).filter(([d]) => d > today && d <= asOf!).reduce((s, [, n]) => s + n, 0);
    counts.ledgerProof = { asOf, period, today, ledgersCompared: cmp.length, matched: cmp.filter((x) => x.ok).length, differ: cmp.filter((x) => !x.ok).length,
      primaryGroupsCompared: groupsCompared, viaDetailed: cmp.filter((x) => x.via === "detailed").length, viaOnlyLedger: cmp.filter((x) => x.via !== "detailed").length,
      detailedTrialBalanceRows: tbDetail.size, vouchersAfterTodayUpToAsOf: vouchersAfterToday,
      tellsYearEndFromToday: asOf! > today && vouchersAfterToday > 0 };
    step("review 1-5 item 7: single ledgers' closing figures from three or more primary groups equal Tally's own Trial Balance for the loaded start to balance_as_of, to the paise",
      cmp.length >= 3 && groupsCompared >= 3 && cmp.every((x) => x.ok),
      `${cmp.filter((x) => x.ok).length} of ${cmp.length} ledgers match across ${groupsCompared} primary groups (${cmp.filter((x) => x.via === "detailed").length} from the detailed Trial Balance); `
        + (asOf! > today ? (vouchersAfterToday > 0 ? `${vouchersAfterToday} vouchers fall after today and up to ${asOf}, so a match means the year end, not the screen's date` : `no voucher falls after today and up to ${asOf}, so this cannot tell the year end from today`) : `as of ${asOf}, today ${today}`));
  };

  /* D-M.13 carried item b: the "expected loaded period" rule. When Tally's
     loaded period ends before today (EndingAt was 5-Nov on 6-Nov), do the
     undated reads (the AlterID read, the ledgers) see a voucher dated after
     that end? One ZZTEST Contra dated today goes straight to the dummy; the
     undated reads are made before and after; the voucher is swept. Nothing
     is written to the database. Counts only in the output. */
  const periodProbe = async () => {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const today = indiaToday();
    const h0 = await tally.highest();
    const lp0 = await tally.loadedPeriod();
    const p0 = judgeLoadedPeriod(lp0, today, h0.latestDate);
    const l0 = await tally.ledgers();
    counts.before = { loadedFrom: p0.from, loadedTo: p0.asOf, lastVoucherDate: lp0.lastVoucher ?? null, unexpected: p0.unexpected, why: p0.why, today, vouchers: h0.count, highestAlterId: h0.alterId, latestVoucherDate: h0.latestDate, ledgers: l0.length,
      vouchersAfterLoadedEnd: Object.entries(h0.byDay).filter(([d]) => d > p0.asOf).reduce((s, [, n]) => s + n, 0) };
    step("the loaded period ends before today, so the probe can tell", p0.asOf < today, `loaded ${p0.from} to ${p0.asOf}, today ${today}; latest voucher ${h0.latestDate}`);
    if (!(p0.asOf < today)) return;
    const p = { ...rigPayload(stamp, 1, today), label: "ZZ TEST 1-5 period probe" } as VoucherPayload;
    if (!isSweepVoucher({ number: p.voucherNumber ?? "", narration: p.narration ?? "" }, "ZZTEST")) throw new Error("refused: not a shape the sweep can remove");
    pushedDays.add(today);
    const pr = await safePush(TALLY_URL, company!, p);
    step("one ZZTEST Contra dated today is in the dummy", pr.ok, pr.ok ? "" : pr.errors.join("; "));
    if (!pr.ok) return;
    const h1 = await tally.highest();
    const lp1 = await tally.loadedPeriod();
    const p1 = judgeLoadedPeriod(lp1, today, h1.latestDate);
    const l1 = await tally.ledgers();
    const dayRead = await tally.vouchersOn(today);
    const f0 = new Map(l0.map((l) => [l.guid, parseBalance(l.closingbalance) ?? 0]));
    const moved = l1.filter((l) => (f0.get(l.guid) ?? 0) !== (parseBalance(l.closingbalance) ?? 0));
    const amt = (p.ledgerEntries ?? [])[0]?.amount ?? 0;
    const movedBy = [...new Set(moved.map((l) => Math.abs(r2((parseBalance(l.closingbalance) ?? 0) - (f0.get(l.guid) ?? 0)))))];
    counts.after = { loadedFrom: p1.from, loadedTo: p1.asOf, lastVoucherDate: lp1.lastVoucher ?? null, unexpected: p1.unexpected, why: p1.why, vouchers: h1.count, highestAlterId: h1.alterId, latestVoucherDate: h1.latestDate,
      todayInUndatedRead: h1.byDay[today] ?? 0, todayInDatedRead: dayRead.length, ledgersWhoseBalanceMoved: moved.length, movedBy, contraAmount: amt };
    step("the dated read of today sees the Contra", dayRead.length >= 1, `${dayRead.length} on ${today}`);
    step("finding: does the undated AlterID read see a voucher dated after the loaded period's end?", true,
      `${h1.count - h0.count} more vouchers, ${h1.byDay[today] ?? 0} dated today; highest ${h0.alterId} to ${h1.alterId}`);
    step("finding: do the undated ledger balances include it?", true, `${moved.length} ledgers moved, by ${JSON.stringify(movedBy)} (the Contra is ${amt})`);
    step("finding: did the loaded period move?", true, `${p0.from} to ${p0.asOf} before, ${p1.from} to ${p1.asOf} after`);
    const s = sweep(today); pushedDays.delete(today);
    const h2 = await tally.highest();
    const lp2 = await tally.loadedPeriod();
    const p2 = judgeLoadedPeriod(lp2, today, h2.latestDate);
    counts.afterSweep = { vouchers: h2.count, todayInUndatedRead: h2.byDay[today] ?? 0, latestVoucherDate: h2.latestDate, loadedTo: p2.asOf, lastVoucherDate: lp2.lastVoucher ?? null, unexpected: p2.unexpected, why: p2.why };
    /* Found on the dummy, 6-Nov-2026 (period2): LastVoucherDate is the date of
       the last voucher entered and stays after that voucher is deleted, while
       EndingAt follows the latest voucher that exists (back to 5-Nov after the
       sweep). So after a sweep the rule flags: it cannot tell a deleted voucher
       from a hidden one, and a flag is the safe side. */
    step("D-1-5.43: Tally fills LastVoucherDate in every read (G7)", !!tallyDateToIso(lp0.lastVoucher) && !!tallyDateToIso(lp1.lastVoucher) && !!tallyDateToIso(lp2.lastVoucher),
      `last voucher ${lp0.lastVoucher}/${lp1.lastVoucher}/${lp2.lastVoucher}, AlterID read ${h0.latestDate}/${h1.latestDate}/${h2.latestDate}`);
    step("D-1-5.43: with a voucher dated today the period ends today and is expected", !p1.unexpected && p1.asOf === today, p1.why ?? `ends ${p1.asOf}`);
    step("D-1-5.43: before the push and after the sweep the period is expected only if nothing Tally reports is dated after its end, else flagged",
      [[p0, lp0, h0], [p2, lp2, h2]].every(([pp, lp, hh]: any) => pp.unexpected === ((tallyDateToIso(lp.lastVoucher) ?? "9999") > pp.asOf || (hh.latestDate ?? "") > pp.asOf)),
      `${p0.why ?? "expected"}; ${p2.why ?? "expected"} (ends ${p0.asOf}, ${p2.asOf})`);
  };

  console.log(`\n  ERP mirror checks on the dummy Tally (stamp ${stamp}, commit ${prov.commit.slice(0, 8)}, tree ${prov.tree.slice(0, 8)})\n`);
  step("the run uses committed code (no uncommitted change in the agent's src or scripts)", prov.dirtyFiles.length === 0, prov.dirtyFiles.join(", "));
  try {
    if (PART === "tb") { await tbProof(); return; }
    if (PART === "period") { await periodProbe(); return; }
    const top = await tally.highest();
    const win = pickWindow(top.byDay);
    if (!win) throw new Error("no short window of days with 20 to 200 vouchers and a day of 6 or more");
    const scope = { from: win.from, to: win.to };
    const busy = eachDay(win.from, win.to).sort((a, b) => (top.byDay[b] ?? 0) - (top.byDay[a] ?? 0))[0];
    /* 0120 H1: the job goes on the window's smallest day, so the re-pull of step 6 is a small-day re-pull. */
    const jobDay = eachDay(win.from, win.to).sort((a, b) => (top.byDay[a] ?? 0) - (top.byDay[b] ?? 0))[0];
    const smallDay = (top.byDay[jobDay] ?? 0) + 1 < 5;
    const outside = eachDay(win.to, "2027-03-31")[1];   // the day after the window, inside the year
    counts.tally = { vouchers: top.count, highestAlterId: top.alterId, keysRead: top.vouchers?.length, window: win, busiestDay: busy, busiestCount: top.byDay[busy], jobDay, jobDayCount: top.byDay[jobDay] ?? 0, smallDay, outsideDay: outside };
    step("picked a short window (Tally's own count per day, read first, with every voucher's key)", !!outside && (top.vouchers?.length ?? 0) === top.count && top.vouchers!.every((v) => v.k && v.d && v.a),
      `${win.days} days ${win.from} to ${win.to}: ${win.count} vouchers; busiest ${busy} with ${top.byDay[busy]}; Tally holds ${top.count}, highest AlterID ${top.alterId}; every one of ${top.vouchers?.length} keys read`);

    // 1. a full run with the ledgers
    const full = runs.full = await runMirrorSync({ store, tally, kind: "full", scope });
    const { count: nRows } = await c.from("erp_mirror_rows").select("key", { count: "exact", head: true }).eq("company_key", companyKey).eq("is_test", true);
    const { data: leds } = await c.from("erp_mirror_ledgers").select("name,parent,closing_balance,row,balance_as_of").eq("company_key", companyKey).eq("is_test", true).limit(5000);
    const withBal = (leds ?? []).filter((l: any) => l.closing_balance !== null);
    const sumBal = Math.round(withBal.reduce((s: number, l: any) => s + Number(l.closing_balance), 0) * 100) / 100;
    counts.ledgers = { read: full.ledgers, inMirror: (leds ?? []).length, withClosingBalance: withBal.length, sentNone: (leds ?? []).filter((l: any) => l.row?.closing_balance_sent === false).length, sumOfClosingBalances: sumBal };
    step("full run: swapped, the mirror holds exactly Tally's count for the window", full.state === "swapped" && nRows === win.count && full.read === win.count, `${full.read} read, ${nRows} in the mirror, Tally ${win.count}${full.error ? `, ${full.error}` : ""}`);
    step("M-6: the ledgers are in the ERP mirror with Tally's closing balances (counted before and after: 0, then every ledger Tally sent)",
      (full.ledgers ?? 0) > 0 && (leds ?? []).length === full.ledgers && withBal.length > 0,
      `${full.ledgers} ledgers read, ${(leds ?? []).length} in the mirror, ${withBal.length} with a closing balance, sum ${sumBal}`);
    step("ledger and group names from the dummy are stored only as ZZ TEST stand-ins", (leds ?? []).every((l: any) => /^ZZ TEST\b/.test(l.name) && (!l.parent || /^ZZ TEST\b/.test(l.parent))));
    const asOf = full.ledgersAsOf;
    const empties = (leds ?? []).filter((l: any) => l.row?.closing_balance_sent === false);
    step("D-C.2 and 0120 M1: every ledger row carries as balance_as_of the end of the period Tally has loaded, flagged when that is not the year to date, and a balance Tally left empty is stored as 0, marked as not sent",
      !!asOf && asOf === full.ledgerPeriod?.to && (leds ?? []).every((l: any) => l.balance_as_of === asOf && l.row?.balance_period_unexpected === full.ledgerPeriod?.unexpected) && empties.every((l: any) => Number(l.closing_balance) === 0),
      `as of ${asOf}, loaded from ${full.ledgerPeriod?.from}, ${full.ledgerPeriod?.unexpected ? `flagged balance_period_unexpected: ${full.ledgerPeriod?.why}` : "the year to date"}; ${empties.length} empty balances stored as ${[...new Set(empties.map((l: any) => Number(l.closing_balance)))].join(",") || "none"}`);

    // D-C.2: the same figures twice (no period asked). The Trial Balance comparison is --part tb, run last.
    const readA = await tally.ledgers(), readB = await tally.ledgers();
    const figs = (rs: typeof readA) => new Map(rs.map((l) => [l.guid, parseBalance(l.closingbalance) ?? 0]));
    const fa = figs(readA), fb = figs(readB);
    const sameTwice = fa.size === fb.size && [...fa].every(([g, v]) => fb.get(g) === v);
    counts.balanceTwice = { asOf, ledgersReadA: readA.length, ledgersReadB: readB.length, sameTwice };
    step("D-C.2: two ledger reads with no period give the same figures", sameTwice && readA.length === full.ledgers, `${readA.length} and ${readB.length} ledgers as of ${asOf}`);

    // 2. the nightly check right after
    const dc0 = runs.check0 = await runDayCheck({ store, tally });
    step("A11: the nightly check right after the full run finds nothing that differs", dc0.state === "ok" && dc0.result?.days_differing === 0 && dc0.result?.tally === win.count && dc0.result?.mirror === win.count,
      JSON.stringify({ ...dc0.result, days: undefined }));

    // 3. one ZZTEST Contra through the ERP test queue
    const p1 = { ...rigPayload(stamp, 1, jobDay), label: "ZZ TEST 1-5 checks" } as VoucherPayload;
    if (!isSweepVoucher({ number: p1.voucherNumber ?? "", narration: p1.narration ?? "" }, "ZZTEST")) throw new Error("refused: not a shape the sweep can remove");
    const request = `ZZTEST-M${stamp}-1`;
    const { data: enq, error: ee } = await c.rpc("erp_enqueue_test_job", { p_machine: machine, p_key: key, p_payload: p1, p_request_id: request });
    if (ee) throw new Error(`enqueue: ${ee.message}`);
    made.push({ job: enq.job_id, proposal: enq.proposal_id, request });
    pushedDays.add(jobDay);
    const agent = new ErpJobAgent({ queue: supabaseErpQueue(c, machine, key), journal: new Journal(journal), company: company!, ...tallySeams(TALLY_URL, post), leaseSeconds: 30, jobLeaseSeconds: 120 });
    let held = false;
    for (let i = 0; i < 20 && !held; i++) { held = await agent.heartbeat(); if (!held) await new Promise((r) => setTimeout(r, 3000)); }
    await agent.runOnce(1);
    const { data: job } = await c.from("erp_jobs").select("id,state,master_id,error").eq("is_test", true).eq("id", enq.job_id).single();
    step("one ZZTEST Contra goes through the ERP test queue and succeeds with Tally's MASTERID", (job as any)?.state === "succeeded" && /^\d+$/.test((job as any)?.master_id ?? ""), JSON.stringify(job));
    const inc1 = runs.inc1 = await runMirrorSync({ store, tally, kind: "incremental" });
    const jc1 = await jobCheck();
    step("the incremental reads it and the database links the job to its one mirror row (D-1-5.2)",
      inc1.state === "swapped" && inc1.read === 1 && sw(inc1).jobs?.linked === 1 && jc1.mapped_one === 1 && jc1.mapped_none.length === 0 && jc1.shared_create_master_ids.length === 0,
      `read ${inc1.read}, jobs ${JSON.stringify(sw(inc1).jobs)}, check ${JSON.stringify({ ...jc1 })}`);
    const { data: link } = await c.from("erp_record_links").select("baseline_source,alter_id_seen").eq("is_test", true).eq("job_id", enq.job_id).maybeSingle();
    const { data: jobAt } = await c.from("erp_jobs").select("alter_id_at_push,succeeded_at,result").eq("is_test", true).eq("id", enq.job_id).single();
    step("0120 M3 and L4: the job records the AlterID read right after the push and when it succeeded, and the link takes that AlterID as its baseline",
      (link as any)?.baseline_source === "push" && Number((jobAt as any)?.alter_id_at_push) > 0 && Number((link as any)?.alter_id_seen) === Number((jobAt as any)?.alter_id_at_push) && !!(jobAt as any)?.succeeded_at,
      `baseline ${(link as any)?.baseline_source} at ${(link as any)?.alter_id_seen}; pushed at ${(jobAt as any)?.alter_id_at_push}${(jobAt as any)?.result?.alter_id_unread ? `; unread: ${(jobAt as any).result.alter_id_unread}` : ""}`);

    // 4. the Contra changed directly in the dummy (a hand edit)
    const edited = await safePush(TALLY_URL, company!, { ...p1, action: "Alter", narration: `ZZTEST${stamp} rig, changed in Tally` } as VoucherPayload);
    const inc2 = runs.inc2 = await runMirrorSync({ store, tally, kind: "incremental" });
    const f2 = await flags(enq.job_id);
    step("A6: changed in Tally, the incremental reads the new AlterID and the job is flagged altered_in_tally",
      edited.ok && inc2.state === "swapped" && inc2.read === 1 && sw(inc2).jobs?.altered_in_tally === 1 && f2.some((f) => f.kind === "altered_in_tally" && !f.resolved_at),
      `alter ${edited.ok ? "ok" : edited.errors[0]}; read ${inc2.read}; ${JSON.stringify(f2.map((f) => ({ kind: f.kind, detail: f.detail })))}`);

    // 5. swept from the dummy; a second Contra outside the window lifts Tally's highest above the mark again
    const s1 = sweep(jobDay);
    const p2 = { ...rigPayload(stamp, 2, outside), label: "ZZ TEST 1-5 checks" } as VoucherPayload;
    pushedDays.add(outside);
    const pr2 = await safePush(TALLY_URL, company!, p2);
    const m5 = await mark();
    const dc1 = runs.check1 = await runDayCheck({ store, tally });
    const { data: q } = await c.from("erp_sync_repulls").select("day,state").eq("company_key", companyKey).eq("is_test", true);
    const dayRow = (dc1.result?.days ?? [])[0] ?? {};
    counts.check1 = { tallyHighest: dc1.tallyHighest, mark: m5?.alter_id, result: { ...dc1.result } };
    step("A11: after the sweep the nightly check finds exactly the job's day differing (one gone from Tally) and queues one re-pull of it",
      s1.status === 0 && pr2.ok && (dc1.tallyHighest ?? 0) > (m5?.alter_id ?? Infinity) && dc1.state === "gaps" && dc1.result?.days_differing === 1 && dc1.result?.repulls_queued === 1
        && dayRow.day === jobDay && dayRow.gone_from_tally === 1 && (q ?? []).length === 1 && (q ?? [])[0].day === jobDay && (q ?? [])[0].state === "queued",
      `sweep exit ${s1.status}; second Contra ${pr2.ok ? "in" : pr2.errors[0]}; Tally ${dc1.tallyHighest} above the mark ${m5?.alter_id}; ${JSON.stringify(dayRow)}`);

    // 6. the re-pull
    const rp = runs.repull = await runRepull({ store, tally });
    const m6 = await mark();
    const f6 = await flags(enq.job_id);
    step(`A7${smallDay ? " and 0120 H1" : ""}: the one-day re-pull of ${smallDay ? `a small day (${(top.byDay[jobDay] ?? 0) + 1} in the mirror before the sweep)` : "the job's day"} prunes the swept voucher from a checked read, keeps the mark and its days, and the job is flagged vanished_from_tally`,
      rp?.state === "swapped" && sw(rp).repull === true && sw(rp).pruned === 1 && sw(rp).jobs?.vanished_from_tally === 1 && rp?.ledgers === null
        && m6?.alter_id === m5?.alter_id && m6?.scope_from === scope.from && m6?.scope_to === scope.to && f6.some((f) => f.kind === "vanished_from_tally" && !f.resolved_at) && sw(rp).kind === "repull",
      `kind ${sw(rp).kind}, pruned ${sw(rp).pruned}, mark ${m5?.alter_id} to ${m6?.alter_id}, jobs ${JSON.stringify(sw(rp).jobs)}`);
    const dc2 = runs.check2 = await runDayCheck({ store, tally });
    const jc2 = await jobCheck();
    step("the nightly check is clean again (the second Contra is outside the window and above the mark), and the job maps to no row",
      dc2.state === "ok" && dc2.result?.days_differing === 0 && jc2.mapped_one === 0 && jc2.mapped_none.length === 1 && jc2.open_flags?.altered_in_tally === 1 && jc2.open_flags?.vanished_from_tally === 1,
      `${JSON.stringify({ ...dc2.result, days: undefined })}; ${JSON.stringify(jc2)}`);
    step("a re-pull with nothing queued reads nothing", (await runRepull({ store, tally })) === null);
  } catch (e) {
    step("the run finished without an error", false, (e as Error).message);
  } finally {
    for (const d of pushedDays) { const r = sweep(d); step(`swept ZZTEST vouchers from ${d}`, r.status === 0, `sweep exit ${r.status}`); }
    const { data: cleaned, error: ce } = await c.rpc("erp_sync_test_cleanup", { p_machine: machine, p_key: key, p_company_key: companyKey });
    const ids = made.map((m) => m.job);
    const d1 = ids.length ? await c.from("erp_jobs").delete().in("id", ids).eq("is_test", true) : { error: null };
    const d2 = made.length ? await c.from("erp_proposal_requests").delete().in("request_id", made.map((m) => m.request)).eq("is_test", true) : { error: null };
    const d3 = made.length ? await c.from("erp_proposals").delete().in("id", made.map((m) => m.proposal)).eq("is_test", true) : { error: null };
    const left: Record<string, number> = {};
    for (const tb of ["erp_sync_runs", "erp_mirror_rows", "erp_mirror_ledgers", "erp_sync_day_checks", "erp_sync_repulls", "erp_record_flags", "erp_record_links"]) {
      const { count } = await c.from(tb).select("*", { count: "exact", head: true }).eq("company_key", companyKey).eq("is_test", true);
      left[tb] = count ?? -1;
    }
    const { count: jobsLeft } = await c.from("erp_jobs").select("id", { count: "exact", head: true }).eq("is_test", true).in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
    step("every test row of this run is deleted", !ce && !d1.error && !d2.error && !d3.error && Object.values(left).every((n) => n === 0) && jobsLeft === 0,
      `${ce?.message ?? JSON.stringify(cleaned)}; left ${JSON.stringify(left)}, jobs ${jobsLeft}`);
    const brief = (r: any) => r && ("swap" in r ? { run_id: r.run_id, kind: r.kind, state: r.state, read: r.read, ledgers: r.ledgers, tallyReads: r.tallyReads, swap: r.swap ? { ...r.swap, changed_keys: undefined, pruned_keys: undefined } : null, error: r.error }
      : { state: r.state, vouchers: r.vouchers, tallyHighest: r.tallyHighest, result: r.result ? { ...r.result, days: r.result.days } : null, error: r.error });
    const report = { rig: "mirror-checks-dummy", part: PART, stamp, companyKey, provenance: prov, minutes: Math.round((Date.now() - t0) / 6000) / 10, counts, steps,
      runs: Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, brief(r)])), passed: steps.filter((s) => s.ok).length, failed: steps.filter((s) => !s.ok).length };
    if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2)); }
    console.log(`\n  ${report.passed} passed, ${report.failed} failed (${report.minutes} min)`);
    process.exit(report.failed ? 1 : 0);
  }
})();
