/**
 * D-M.248 item 3, offline: the pure half of the go-live commands (services/primaryTools.ts) and the six command scripts' guard rails.
 * No Tally, no database. The scripts print SQL or read; the tests check the SQL text and the rules, and that no script writes anywhere.
 *
 *   npx tsx scripts/test-primary-tools.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keyHashOf, validMachineId, sqlStr, registerSql, switchSql, switchCheckSql, planSeriesSeeds, seedSql, seedRefusals, parityVerdict, proofChecks, preflightText, type ProofInput } from "../src/services/primaryTools.js";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
};
const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };

(async () => {
  console.log("\n  key, machine, literals");
  const h = keyHashOf("abc");
  ok("sha-256 of a key is 64 lower-case hex, known value", h === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  ok("surrounding whitespace in the key does not change the hash", keyHashOf("  abc\n") === h);
  ok("machine ids: neutral names pass", validMachineId("office-pc-1") && validMachineId("a.b_c-9"));
  ok("machine ids: too short, spaces, unnamed-machine fail", !validMachineId("ab") && !validMachineId("office pc") && !validMachineId("unnamed-machine"));
  ok("sqlStr doubles a quote", sqlStr("O'Neil") === "'O''Neil'");
  ok("sqlStr refuses a control character", throws(() => sqlStr("a\nb")));

  console.log("\n  register the primary machine");
  const reg = registerSql("office-pc-1", h);
  ok("register inserts a primary with only the hash", /insert into public\.erp_agent_machines/.test(reg.up) && /'primary'/.test(reg.up) && reg.up.includes(h));
  ok("register undo retires, never deletes", /set retired_at = now\(\)/.test(reg.down) && !/delete/i.test(reg.down));
  ok("register check lists primaries", /role = 'primary'/.test(reg.check));
  ok("register refuses a bad machine id", throws(() => registerSql("x", h)));
  ok("register refuses a hash that is not sha-256", throws(() => registerSql("office-pc-1", "plain-key")));
  ok("a registered statement never holds a raw key (only the 64 hex digits)", (reg.up.match(/[0-9a-f]{64}/g) ?? []).length === 1);

  console.log("\n  the two switches");
  ok("live_claims on writes erp_control with on:true", /public\.erp_control/.test(switchSql("live_claims", true)) && /"on": true/.test(switchSql("live_claims", true)));
  ok("live_claims off writes on:false", /"on": false/.test(switchSql("live_claims", false)));
  ok("live_mirror goes to erp_sync_control", /public\.erp_sync_control/.test(switchSql("live_mirror", true)) && /'live_mirror'/.test(switchSql("live_mirror", true)));
  ok("a switch statement is idempotent (on conflict do update)", /on conflict \(key\) do update/.test(switchSql("live_claims", true)));
  ok("an unknown switch is refused", throws(() => switchSql("tally_swap" as any, true)));
  ok("the read-back names both switches and says 'off' when no row", /live_claims/.test(switchCheckSql()) && /live_mirror/.test(switchCheckSql()) && /no row \(off\)/.test(switchCheckSql()));

  console.log("\n  seed the voucher counters");
  const taken = { sales: ["26-27/0001", "26-27/0007", "26-27/0003", "25-26/0900", "junk"], payment: ["12"], receipt: [], contra: [], journal: [], "stock journal": [] };
  const seeds = planSeriesSeeds(taken, "2026-27");
  const sales = seeds.find((s) => s.voucherType === "Sales")!;
  ok("six series planned, 'Stock Journal' title-cased", seeds.length === 6 && seeds.some((s) => s.voucherType === "Stock Journal"));
  ok("Sales: highest is the largest counter of THIS year (last year's 900 does not count)", sales.highest === 7, String(sales.highest));
  ok("Sales: the next number is one above, padded to 4", sales.next === "26-27/0008", sales.next);
  ok("Sales: counts what Tally holds and what is in the series", sales.inTally === 5 && sales.inSeries === 3, `${sales.inTally}/${sales.inSeries}`);
  ok("Payment ERP-own series starts at 1 when nothing is in it", seeds.find((s) => s.voucherType === "Payment")!.next === "ERP-1/26-27" || seeds.find((s) => s.voucherType === "Payment")!.highest === 0);
  ok("an empty Sales list is not a warning (nothing to be wrong about)", planSeriesSeeds({ ...taken, sales: [] }, "2026-27").find((s) => s.voucherType === "Sales")!.warning === null);
  const odd = planSeriesSeeds({ ...taken, sales: ["AB/1", "AB/2"] }, "2026-27").find((s) => s.voucherType === "Sales")!;
  ok("Sales numbers in an unknown format warn, and the seed is 0", odd.warning !== null && odd.highest === 0);
  ok("a missing read is refused, never read as empty", throws(() => planSeriesSeeds({ sales: [] } as any, "2026-27")));
  ok("a year that is not like 2026-27 is refused", throws(() => planSeriesSeeds(taken, "2026")));
  const sql = seedSql(seeds, { seriesKey: "MKCP", mirrorCompany: "ZZ CO - (from 1-Apr-26)" });
  ok("seed does nothing on a row that exists", /on conflict \(company_key, type_key, fy\) do nothing/.test(sql.up));
  ok("seed writes last_issued from Tally's highest, marked as a real series", sql.up.includes(", 7, false, 'go-live seed from Tally')"));
  ok("seed undo deletes only unused go-live seeds", /s\.note = 'go-live seed from Tally'/.test(sql.down) && /not exists/.test(sql.down) && /not s\.is_test/.test(sql.down));
  ok("seed check shows the next number per series", /erp_series_format/.test(sql.check));

  console.log("\n  the parity verdict");
  const good = { passed: true, reasons: [], tables: { tally_vouchers: { old_rows: 10, new_rows: 10, only_in_old: 0, only_in_new: 0 } }, test_rows_in_store: 0 };
  ok("passed with tables and no reasons passes", parityVerdict(good).pass);
  ok("passed:false fails", !parityVerdict({ ...good, passed: false }).pass);
  ok("passed with a reason fails", !parityVerdict({ ...good, reasons: ["x"] }).pass);
  ok("nothing, null and a string all fail", !parityVerdict(null).pass && !parityVerdict(undefined).pass && !parityVerdict("passed").pass);
  ok("no tables fails", !parityVerdict({ passed: true }).pass);
  ok("differences and test rows are named", parityVerdict({ ...good, tables: { t: { old_rows: 3, new_rows: 2, only_in_old: 1, only_in_new: 0 } }, test_rows_in_store: 2 }).lines.join("|").includes("1 only in tally_*") && parityVerdict({ ...good, test_rows_in_store: 2 }).lines.join("|").includes("2 test row"));

  console.log("\n  the M11 proof");
  const full: ProofInput = { found: 1, differences: [], jobState: "succeeded", jobAttempts: 1, jobsWithRemoteId: 1, bookedNumber: "26-27/0008", sentNumber: "26-27/0008", counterLast: 8, numberCounter: 8, pinned: true };
  const run = (o: Partial<ProofInput>) => proofChecks({ ...full, ...o });
  ok("seven checks, all pass on a clean voucher", run({}).length === 7 && run({}).every((c) => c.ok));
  ok("not in the pinned company fails", !run({ pinned: false })[0].ok);
  ok("zero or two vouchers found fails", !run({ found: 0 })[1].ok && !run({ found: 2 })[1].ok);
  ok("a difference fails and is shown", !run({ differences: ["ledger X: sent 5, stored 6"] })[2].ok && run({ differences: ["ledger X: sent 5, stored 6"] })[2].detail.includes("sent 5"));
  ok("a job that is not succeeded fails", !run({ jobState: "uncertain" })[3].ok);
  ok("two attempts or two jobs with the REMOTEID fails", !run({ jobAttempts: 2 })[4].ok && !run({ jobsWithRemoteId: 2 })[4].ok);
  ok("booked differing from sent fails", !run({ bookedNumber: "26-27/0009" })[5].ok);
  ok("a counter below the number fails", !run({ counterLast: 7 })[6].ok);
  ok("unknown is never a pass: nulls fail every job-side check", [3, 4, 5, 6].every((i) => !run({ jobState: null, jobAttempts: null, jobsWithRemoteId: null, bookedNumber: null, sentNumber: null, counterLast: null, numberCounter: null })[i].ok));

  console.log("\n  the preflight text");
  const pf = preflightText([{ name: "a", ok: true, detail: "" }, { name: "b", ok: false, detail: "why" }]);
  ok("one failing line is not ready, and says how many", !pf.ready && /1 line\(s\) not ready/.test(pf.text) && /NOT READY {2}b {2}\(why\)/.test(pf.text));
  ok("all ready is ready", preflightText([{ name: "a", ok: true, detail: "" }]).ready);
  ok("an empty list is ready only vacuously (the script always adds lines)", preflightText([]).ready);

  console.log("\n  D-M.256 items 9 and 11: parity over nothing, and the seed refusals");
  ok("parity: passed:true with ZERO tables compared is not a pass", !parityVerdict({ passed: true, reasons: [], tables: {}, test_rows_in_store: 0 }).pass && /compared no tables/.test(parityVerdict({ passed: true, reasons: [], tables: {} }).lines.join(" ")));
  {
    const s6 = planSeriesSeeds({ sales: ["26-27/0003"], payment: [], receipt: [], contra: [], journal: [], "stock journal": [] }, "2026-27");
    const none = { unreadable: [] as string[], emptyOk: [] as string[], mirrorHighest: null as Record<string, number> | null };
    const names = (r: ReturnType<typeof seedRefusals>) => r.map((x) => x.voucherType).join();
    ok("an empty Tally list for a type is refused unless a person names the type", names(seedRefusals(s6, none)) === "Payment,Receipt,Contra,Journal,Stock Journal");
    ok("--empty-ok=<type> lifts it for that type only (case does not matter)", names(seedRefusals(s6, { ...none, emptyOk: ["Payment", "stock journal"] })) === "Receipt,Contra,Journal");
    ok("an unreadable list is refused even when the type is named empty-ok", names(seedRefusals(s6, { ...none, unreadable: ["payment"], emptyOk: ["payment"] })).startsWith("Payment"));
    const all = { ...none, emptyOk: ["payment", "receipt", "contra", "journal", "stock journal"] };
    ok("a mirror that holds a higher counter than Tally's list refuses that type", names(seedRefusals(s6, { ...all, mirrorHighest: { sales: 9, payment: 0, receipt: 0, contra: 0, journal: 0, "stock journal": 0 } })) === "Sales");
    ok("a mirror at or below Tally's highest does not refuse", seedRefusals(s6, { ...all, mirrorHighest: { sales: 3, payment: 0, receipt: 0, contra: 0, journal: 0, "stock journal": 0 } }).length === 0);
    ok("no mirror (null) refuses nothing here; the script reports the check as NOT RUN", seedRefusals(s6, all).length === 0);
  }

  console.log("\n  D-M.256 item 3: the preflight asks with the machine's own id and key");
  {
    const pf2 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "primary-preflight.ts"), "utf8");
    ok("it calls erp_agent_role with p_machine and p_key, not erp_my_open_jobs with no arguments", /erp_agent_role", \{ p_machine: machine, p_key: key \}/.test(pf2) && !/erp_my_open_jobs/.test(pf2.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
    ok("only role 'primary' passes", /role === "primary"/.test(pf2));
    ok("the help says: set the .env first, run it with the agent stopped, and 'mode not on' is a failure", /STOPPED/.test(pf2) && /MKCP_PRIMARY_MODE is not\s+[*]?\s*on/.test(pf2));
  }

  console.log("\n  the six scripts only read or print");
  const dir = join(dirname(fileURLToPath(import.meta.url)));
  const names = readdirSync(dir).filter((f) => /^primary-.*\.ts$/.test(f));
  ok("all six command scripts exist", ["register", "switches", "seed-series", "parity", "voucher-proof", "preflight"].every((n) => names.includes(`primary-${n}.ts`)), names.join(","));
  for (const f of names) {
    const src = readFileSync(join(dir, f), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    ok(`${f}: no Tally Import, no database write, no key printed`,
      !/TALLYREQUEST>Import|\.insert\(|\.update\(|\.upsert\(|\.delete\(|safePush\(|tallyPost\([^)]*Import/.test(code)
      && !/console\.\w+\([^)]*process\.env\.MKCP_ERP_AGENT_KEY/.test(code)
      && !/SUPABASE_SERVICE_KEY/.test(code.replace(/\/\/.*$/gm, "")));
  }
  const reg2 = readFileSync(join(dir, "primary-register.ts"), "utf8");
  ok("register prints a key only for a freshly generated one", /if \(generate\)/.test(reg2) && !/console\.log\([^)]*\$\{process\.env/.test(reg2));
  const pr = readFileSync(join(dir, "primary-parity.ts"), "utf8");
  ok("parity is a dry run unless --run", /includes\("--run"\)/.test(pr) && /Dry run/.test(pr));
  const seedSrc = readFileSync(join(dir, "primary-seed-series.ts"), "utf8");
  ok("seed checks the pin first on a primary, and reads (no write call)", /primaryPinProblem/.test(seedSrc) && /takenNumbersOrThrow/.test(seedSrc));

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
