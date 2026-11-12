/**
 * F17, agent half (D-12-6.1, D-M.187), offline: the list of companies by year, a job's target, and the weekly read-only
 * pull of last year's company. No Tally, no Supabase. Fake names and made-up GUIDs only.
 *
 *   cd server; npx tsx scripts/test-company-years.ts
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCompanyYears, resolveTarget, loadedProblem, targetOf, lastYearEntry, loadCompanyYears } from "../src/services/companyYears.js";
import { planLastYearPull, runLastYearPull, fyStartOf, WEEK_MS } from "../src/services/lastYearPull.js";
import { ErpJobAgent, Journal } from "../src/services/erpJobAgent.js";
import { memErpQueue } from "./rigs/lib/memErpQueue.js";
import { SimTally, rigPayload, sandboxForRig, indiaToday } from "./rigs/lib/simTally.js";
import type { VoucherPayload } from "../src/types.js";

sandboxForRig();
let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
};
const G26 = "11111111-2222-3333-4444-555555555555-00000001";
const G25 = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const THIS = "ZZ TEST CYCLES (from 1-Apr-26)";
const LAST = "ZZ TEST CYCLES (from 1-Apr-25)";
const raw = JSON.stringify([{ company: THIS, fyStart: 2026, guid: G26 }, { company: LAST, fyStart: 2025, guid: G25 }]);

console.log("the list:");
{
  const p = parseCompanyYears(raw);
  ok("a good list loads whole", p.list.length === 2 && p.problems.length === 0);
  ok("nothing configured is an empty list with no problem", parseCompanyYears("").list.length === 0 && parseCompanyYears(undefined).problems.length === 0);
  ok("junk is refused as a whole", parseCompanyYears("{nope").list.length === 0 && parseCompanyYears("{nope").problems.length === 1 && parseCompanyYears('{"a":1}').problems.length === 1);
  const bad = parseCompanyYears(JSON.stringify([{ company: THIS, fyStart: 2026, guid: G26 }, { company: "", fyStart: "x", guid: "nope" }]));
  ok("one bad entry makes the whole list unusable, never half", bad.list.length === 0 && bad.problems.length >= 3, bad.problems.join(" | "));
  const two = parseCompanyYears(JSON.stringify([{ company: THIS, fyStart: 2026, guid: G26 }, { company: THIS, fyStart: 2025, guid: G25 }]));
  ok("one company with two GUIDs is refused", two.list.length === 0 && /two different GUIDs/.test(two.problems.join()));
  const yr = parseCompanyYears(JSON.stringify([{ company: THIS, fyStart: 2026, guid: G26 }, { company: LAST, fyStart: 2026, guid: G25 }]));
  ok("one year with two companies is refused", yr.list.length === 0 && /two different companies/.test(yr.problems.join()));
  const same = parseCompanyYears(JSON.stringify([{ company: THIS, fyStart: 2026, guid: G26 }, { company: THIS, fyStart: 2026, guid: G26.toUpperCase() }]));
  ok("the same entry twice (GUID in another letter case) is accepted", same.problems.length === 0);
  const dir = mkdtempSync(join(tmpdir(), "cy-"));
  const f = join(dir, "c.json");
  writeFileSync(f, raw);
  ok("the list can come from a file named by MKCP_COMPANY_YEARS_FILE", loadCompanyYears({ MKCP_COMPANY_YEARS_FILE: f } as NodeJS.ProcessEnv).list.length === 2);
  ok("a missing file loads empty with a problem", loadCompanyYears({ MKCP_COMPANY_YEARS_FILE: join(dir, "none.json") } as NodeJS.ProcessEnv).problems.length === 1);
  ok("last year's entry is found by year", lastYearEntry(p.list, 2026)?.company === LAST && lastYearEntry(p.list, 2025) === null);
}

console.log("\nwhich company a job goes to:");
{
  const list = parseCompanyYears(raw).list;
  const own = THIS;
  const r0 = resolveTarget(list, { company: "", guid: "" }, own);
  ok("no target: the agent's own company, as today", r0.ok && r0.company === own && !r0.viaList);
  const r1 = resolveTarget(list, { company: own, guid: "" }, own);
  ok("a target naming the agent's own company with no GUID is the same as none", r1.ok && r1.company === own && !r1.viaList);
  const r2 = resolveTarget(list, { company: LAST, guid: G25.toLowerCase() }, own);
  ok("last year's company by exact name and GUID (letter case ignored for the GUID)", r2.ok && r2.company === LAST && r2.viaList && r2.entry?.fyStart === 2025);
  const t = (company: string, guid: string) => resolveTarget(list, { company, guid }, own);
  ok("another company with no GUID is refused", !t(LAST, "").ok);
  ok("the right name with the wrong GUID is refused", !t(LAST, G26).ok);
  ok("an unlisted company is refused", !t("ZZ TEST OTHER", G25).ok);
  ok("a near-miss name is refused (no forgiving a typo)", !t("zz test cycles (from 1-apr-25)", G25).ok);
  ok("a GUID with no company is refused", !t("", G25).ok);
  ok("a malformed GUID is refused", !t(LAST, "not-a-guid").ok);
  ok("with no list at all, any other company is refused", !resolveTarget([], { company: LAST, guid: G25 }, own).ok);
  ok("the target is read from payload.targetCompany and payload.targetGuid", JSON.stringify(targetOf({ targetCompany: " X ", targetGuid: " g " })) === JSON.stringify({ company: "X", guid: "g" }) && targetOf({}).company === "");
  const listing = (name: string, guid: string) => `<ENVELOPE><COMPANY NAME="${name}"><GUID>${guid}</GUID></COMPANY></ENVELOPE>`;
  const entry = list[1];
  ok("open in Tally under the recorded GUID: fine", loadedProblem(listing(LAST, G25), entry) === null);
  ok("not open: refused with plain words", /not open/.test(loadedProblem(listing(THIS, G26), entry) ?? ""));
  ok("open under another GUID: refused", /different GUID/.test(loadedProblem(listing(LAST, G26), entry) ?? ""));
  ok("open twice under two GUIDs: refused", /more than once/.test(loadedProblem(listing(LAST, G25) + listing(LAST, G26), entry) ?? ""));
}

console.log("\nthe agent sends to the right company, or does not send:");
(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-agent-"));
  let jn = 0;
  const COMPANY = process.env.MKCP_PRACTICE_COMPANY!;
  const day = indiaToday();
  const list = parseCompanyYears(JSON.stringify([{ company: COMPANY, fyStart: 2026, guid: G26 }, { company: LAST, fyStart: 2025, guid: G25 }])).list;
  const pl = (n: number, target?: { c: string; g: string }): VoucherPayload & { label: string } =>
    ({ ...rigPayload("CY", n, day), label: "ZZ TEST company years", ...(target ? { targetCompany: target.c, targetGuid: target.g } : {}) }) as never;
  const make = (loaded: (c: string) => string | null) => {
    const m = memErpQueue(); const sim = new SimTally(); const sentTo: string[] = []; let checked = 0;
    const agent = new ErpJobAgent({
      queue: m.queue, journal: new Journal(join(dir, `j${++jn}.jsonl`)), company: COMPANY, companies: list,
      push: (c, p) => { sentTo.push(c); return sim.push("sim", c, p); },
      find: async () => [], leaseSeconds: 90, jobLeaseSeconds: 120, wait: async () => {},
      refuse: () => null, // the sandbox rule (practice company only) is tested elsewhere; this tests the choice of company
      companyLoaded: async (e) => { checked++; return loaded(e.company); },
    });
    return { m, sim, agent, sentTo, checks: () => checked };
  };
  {
    const x = make(() => null); x.m.add(pl(1));
    const r = await x.agent.runOnce(1);
    ok("a job with no target goes to the agent's own company and no company check is made", r.results[0]?.outcome === "succeeded" && x.sentTo[0] === COMPANY && x.checks() === 0, JSON.stringify(r.results[0]));
  }
  {
    const x = make(() => null); x.m.add(pl(2, { c: LAST, g: G25 }));
    const r = await x.agent.runOnce(1);
    ok("a job aimed at last year's company (name and GUID match, open in Tally) is sent to that company", r.results[0]?.outcome === "succeeded" && x.sentTo[0] === LAST && x.checks() === 1, JSON.stringify(r.results[0]));
  }
  {
    const x = make(() => null); const id = x.m.add(pl(3, { c: LAST, g: G26 }));
    const r = await x.agent.runOnce(1);
    ok("the wrong GUID is refused before Tally: nothing sent, nothing in the books, no company check", r.results[0]?.outcome === "failed" && x.sentTo.length === 0 && x.sim.books.size === 0 && x.checks() === 0 && x.m.rows.get(id)!.state === "failed");
  }
  {
    const x = make(() => null); x.m.add(pl(4, { c: "ZZ TEST NOT LISTED", g: G25 }));
    const r = await x.agent.runOnce(1);
    ok("a company not in the list is refused before Tally", r.results[0]?.outcome === "failed" && x.sentTo.length === 0 && /not in this agent's list/.test(r.results[0].detail));
  }
  {
    const x = make(() => `"${LAST}" is not open in Tally, so nothing can be sent to it. Open it and send again.`); x.m.add(pl(5, { c: LAST, g: G25 }));
    const r = await x.agent.runOnce(1);
    ok("a listed company that is not open in Tally is refused before anything is sent", r.results[0]?.outcome === "failed" && x.sentTo.length === 0 && /not open/.test(r.results[0].detail));
  }
  {
    const m = memErpQueue(); const sim = new SimTally(); const sentTo: string[] = [];
    const agent = new ErpJobAgent({ queue: m.queue, journal: new Journal(join(dir, `j${++jn}.jsonl`)), company: COMPANY, push: (c, p) => { sentTo.push(c); return sim.push("sim", c, p); }, find: async () => [], leaseSeconds: 90, jobLeaseSeconds: 120, wait: async () => {} });
    m.add(pl(6, { c: LAST, g: G25 }));
    const r = await agent.runOnce(1);
    ok("an agent with no list refuses every other company (fail closed)", r.results[0]?.outcome === "failed" && sentTo.length === 0);
  }

  console.log("\nthe weekly read-only pull of last year's company:");
  const NOW = (d: string) => new Date(`${d}T10:00:00+05:30`);
  const base = { gstr3bFiledThrough: null as string | null, lastPullAt: null as Date | null };
  ok("the financial year of a day: 2 April 2027 is FY 2027, 20 March 2027 is FY 2026", fyStartOf("2027-04-02") === 2027 && fyStartOf("2027-03-20") === 2026);
  const listNext = parseCompanyYears(JSON.stringify([{ company: "ZZ TEST CYCLES (from 1-Apr-27)", fyStart: 2027, guid: G26 }, { company: THIS, fyStart: 2026, guid: G25 }])).list;
  const p = (day: string, over: Partial<typeof base> = {}) => planLastYearPull({ now: NOW(day), ...base, list: listNext, ...over });
  ok("on 2 April, with March not filed and never pulled, a pull is due", p("2027-04-02").due && p("2027-04-02").entry?.company === THIS);
  ok("the day before 1 April it is not (last year's company is still this year's)", !p("2027-03-31").due);
  const oneOnly = parseCompanyYears(JSON.stringify([{ company: THIS, fyStart: 2027, guid: G26 }])).list;
  ok("with no entry for last year it is not due", !planLastYearPull({ now: NOW("2027-04-02"), ...base, list: oneOnly }).due && /no company is recorded/.test(planLastYearPull({ now: NOW("2027-04-02"), ...base, list: [] }).why));
  ok("once March's GSTR-3B is recorded as filed it stops", !p("2027-04-25", { gstr3bFiledThrough: "2027-03-31" }).due && /closed/.test(p("2027-04-25", { gstr3bFiledThrough: "2027-03-31" }).why));
  ok("a GSTR-3B recorded only through February does not close it", p("2027-04-25", { gstr3bFiledThrough: "2027-02-28" }).due);
  ok("a pull inside the last week is not repeated", !p("2027-04-10", { lastPullAt: NOW("2027-04-05") }).due);
  ok("a week later it is due again", p("2027-04-12", { lastPullAt: new Date(NOW("2027-04-12").getTime() - WEEK_MS - 1000) }).due);
  ok("past 30 June it stops whatever is recorded", !p("2027-07-01").due && /hard stop/.test(p("2027-07-01").why));

  let synced = 0;
  const sync = async () => { synced++; return { state: "swapped" as const, error: null }; };
  const open = (name: string, guid: string) => async () => `<COMPANY NAME="${name}"><GUID>${guid}</GUID></COMPANY>`;
  const notOpen = await runLastYearPull({ entry: listNext[1], listing: open("other", G25), sync });
  ok("last year's company not open: skipped with the reason, nothing read", notOpen.state === "skipped" && /not open/.test(notOpen.why) && notOpen.report === null && synced === 0);
  const wrongGuid = await runLastYearPull({ entry: listNext[1], listing: open(THIS, G26), sync });
  ok("open under another GUID: skipped, never read", wrongGuid.state === "skipped" && /different GUID/.test(wrongGuid.why) && synced === 0);
  const down = await runLastYearPull({ entry: listNext[1], listing: async () => { throw new Error("reset"); }, sync });
  ok("Tally's list could not be read: failed, nothing read", down.state === "failed" && down.report === null && synced === 0);
  const good = await runLastYearPull({ entry: listNext[1], listing: open(THIS, G25), sync });
  ok("open under the recorded GUID: the checked sync runs once for that company and the pull is reported", good.state === "pulled" && synced === 1);
  const refused = await runLastYearPull({ entry: listNext[1], listing: open(THIS, G25), sync: async () => ({ state: "refused" as const, error: "below the floor" }) });
  ok("a refusal by the sync's floor is a skip, not a failure", refused.state === "skipped" && /floor/.test(refused.why));
  const crashed = await runLastYearPull({ entry: listNext[1], listing: open(THIS, G25), sync: async () => { throw new Error("db down"); } });
  ok("a sync that throws is a failure with its reason", crashed.state === "failed" && /db down/.test(crashed.why));

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
