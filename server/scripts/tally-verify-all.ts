/**
 * The whole Tally path — pull and push — in one command.
 *
 *   npx tsx server/scripts/tally-verify-all.ts            # preflight + every READ
 *   npx tsx server/scripts/tally-verify-all.ts --push     # also the WRITE path
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * "Make sure the push and pull to Tally isn't broken" has, until now, meant
 * remembering which of ~60 scripts to run and in what order. There was no
 * single answer, so the honest answer was usually "the parts I happened to
 * run". This is the single answer, and it exits non-zero when it is no.
 *
 * It composes the existing harnesses rather than reimplementing them — each
 * already knows how to clean up after itself, and a second copy of that
 * knowledge would drift (G1).
 *
 * ── The failure it was written for ────────────────────────────────────────
 *
 * On 22-Sep-2026 the owner said Tally was open. It was not — or rather, its
 * Windows SERVICES were: `tallygatewayserver.exe` was listening on 9999 and
 * answering with the licence server, `tallyscheduler.exe` was running, and
 * nothing at all was on 9000 (checked on both IPv4 and IPv6). From the outside
 * that is indistinguishable from "TallyPrime is open but its XML port is
 * switched off", and both look like "Tally is broken" to any harness that
 * simply times out.
 *
 * So the preflight names WHICH state the machine is in and what to do about
 * it. The distinction matters because the two fixes are different — one needs
 * the app opened, the other needs a setting changed — and neither is visible
 * in a connection error.
 *
 * ── The rule every stage obeys ────────────────────────────────────────────
 *
 * A stage that cannot run reports **CANNOT RUN**, never "passed" (G7). A check
 * that reports zero because it is broken is the most expensive failure shape
 * in this project — it has now happened with the `<RATE>` regex, the long-task
 * observer, the overflow sweep and the JWT guard. Every read below therefore
 * asserts a non-zero floor, and a zero says whether it came from Tally or from
 * our own parser.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { config } from "dotenv";
config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { esc, blocksOf, tagOf } from "../src/services/tallyRequest.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const ROLE = process.env.MKCP_TALLY_ROLE ?? "primary";
const PUSH = process.argv.includes("--push");

const G = "\x1b[32m", Y = "\x1b[33m", R = "\x1b[31m", D = "\x1b[2m", X = "\x1b[0m";
type Verdict = "pass" | "fail" | "cannot-run" | "skipped";
const results: { stage: string; verdict: Verdict }[] = [];
const mark = (v: Verdict) =>
  v === "pass" ? `${G}✓ pass      ${X}`
  : v === "fail" ? `${R}✗ FAIL      ${X}`
  : v === "cannot-run" ? `${Y}⊘ CANNOT RUN${X}`
  : `${D}· skipped   ${X}`;
function record(stage: string, verdict: Verdict, note = "") {
  results.push({ stage, verdict });
  console.log(`  ${mark(verdict)} ${stage}${note ? `  ${D}${note}${X}` : ""}`);
}

/**
 * Which state is this machine in?
 *
 * `tally.exe` absent, a listener on 9999 and nothing on 9000 is the exact
 * shape seen on 22-Sep. The licence gateway is a Windows SERVICE and runs
 * whether or not anybody has opened TallyPrime, so its presence proves
 * nothing at all about the XML port.
 */
async function preflight(): Promise<boolean> {
  console.log(`\n  ── preflight`);
  const port = Number(new URL(TALLY_URL).port || 9000);

  let appRunning = false, gatewayRunning = false, probed = false;
  try {
    const t = spawnSync("tasklist", [], { encoding: "utf8" }).stdout ?? "";
    if (t) { probed = true; appRunning = /\btally\.exe\b/i.test(t); gatewayRunning = /tallygatewayserver\.exe/i.test(t); }
  } catch { /* not Windows, or tasklist unavailable — the HTTP probe still decides */ }

  try {
    const open = convertCompanies(await tallyPost(TALLY_URL, HEALTH_XML, 10_000)).map((c) => c.name);
    record(`Tally answers on ${TALLY_URL}`, "pass", open.length ? open.join(", ") : "no company open");
    if (!open.length) {
      console.log(`\n  ${R}Tally is listening but no company is open.${X} Open the company and re-run.\n`);
      return false;
    }
    /* The sandbox rule, restated where it bites. This machine's Tally holds an
       OLD BACKUP company sharing production's name, and every mirror table is
       keyed on that name — so a sync or a queue-drain from here overwrites real
       rows. Local reads and self-cleaning local pushes are fine; anything
       shared is not, and `isSandbox()` already makes the Supabase client null.
       Printing it means the operator knows WHICH Tally they just verified. */
    record(`role = ${ROLE}`, "pass",
      ROLE === "sandbox"
        ? `local Tally only — nothing shared is touched; "${open[0]}" is the BACKUP copy`
        : `this is the real book — pushes below are marked and removed`);
    return true;
  } catch (e) {
    record(`Tally answers on ${TALLY_URL}`, "cannot-run", (e as Error).message.slice(0, 60));
  }

  console.log(`\n  ${R}Nothing is answering on port ${port}.${X}`);
  if (probed) {
    console.log(`  What the machine looks like right now:\n`);
    console.log(`    tally.exe (TallyPrime itself) ....... ${appRunning ? `${G}running${X}` : `${R}NOT running${X}`}`);
    console.log(`    tallygatewayserver.exe (a SERVICE) .. ${gatewayRunning ? "running" : "not running"}`);
    console.log(`\n  ${D}The gateway/licence service runs whether or not anyone has opened`);
    console.log(`  TallyPrime, and it answers on 9999. That is NOT the XML port, and its`);
    console.log(`  presence says nothing about whether any of this will work.${X}\n`);
  }
  if (probed && appRunning) {
    console.log(`  ${Y}→ TallyPrime is open but not serving XML. Turn the port on:${X}`);
    console.log(`     F1 Help → Settings → Connectivity → Client/Server configuration`);
    console.log(`     TallyPrime acts as: Both · Port: ${port} · accept, then re-run.`);
  } else {
    console.log(`  ${Y}→ Open TallyPrime, load the company, then re-run this.${X}`);
  }
  console.log();
  return false;
}

/**
 * One read, with a floor. A collection that comes back empty is a failure of
 * this harness OR of Tally, and those are different facts (G7) — so the count
 * is asserted and a zero says which side produced it.
 */
async function read(stage: string, tdlType: string, fields: string[], floor: number) {
  const id = `VA${Date.now().toString().slice(-6)}`;
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${id}</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="${id}" ISMODIFY="No"><TYPE>${esc(tdlType)}</TYPE>
${fields.map((f) => `<NATIVEMETHOD>${esc(f)}</NATIVEMETHOD>`).join("")}
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  let raw: string;
  try {
    raw = await tallyPost(TALLY_URL, xml, 300_000, true) as string;
  } catch (e) {
    record(stage, "fail", `Tally refused the request: ${(e as Error).message.slice(0, 50)}`);
    return;
  }
  const blocks = blocksOf(raw, tdlType.toUpperCase());
  const named = blocks.filter((b) => (tagOf(b, fields[0]) ?? "").trim()).length;
  if (blocks.length >= floor && named > 0) {
    record(stage, "pass", `${blocks.length} rows, ${named} carry ${fields[0]}`);
    return;
  }
  /* Three distinguishable facts, and the wording says which one it is.
     An earlier draft printed "OUR PARSER, not Tally" for the non-empty case,
     which is itself the over-claim this harness exists to prevent: a big
     response with no matching blocks means the SHAPE disagrees, and that is
     either our tag or Tally answering something else. Naming a culprit we have
     not established would be the same mistake as "0 items priced". */
  record(stage, "fail", raw.length < 200
    ? `Tally returned ${raw.length} bytes — TALLY genuinely sent nothing`
    : blocks.length === 0
      ? `Tally sent ${(raw.length / 1024).toFixed(0)} KB carrying no <${tdlType.toUpperCase()}> at all — SHAPE mismatch (our tag, or Tally answered something else), not an empty book`
      : `${blocks.length} <${tdlType.toUpperCase()}> blocks but ${named} carry ${fields[0]} — Tally answered, the FIELD did not come back (check the fetch list, G7)`);
}

/** Run an existing harness as-is, and report its own verdict. */
function runHarness(stage: string, script: string, args: string[] = []) {
  const r = spawnSync("npx", ["tsx", join("server", "scripts", script), ...args], {
    cwd: REPO, encoding: "utf8", shell: process.platform === "win32", timeout: 15 * 60_000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const tail = out.trim().split("\n").filter(Boolean).slice(-1)[0]?.trim().slice(0, 70) ?? "";
  if (r.status === 0) record(stage, "pass", tail);
  else record(stage, "fail", `exit ${r.status} · ${tail}`);
}

(async () => {
  console.log(`\n  TALLY — PULL AND PUSH, END TO END`);
  console.log(`  ${"─".repeat(72)}`);

  if (!(await preflight())) {
    console.log(`  ${"─".repeat(72)}`);
    console.log(`  ${Y}Nothing was verified.${X} This is NOT a pass, and it is NOT a failure`);
    console.log(`  of the push path — it is the harness saying it could not look.\n`);
    process.exitCode = 2;
    return;
  }

  console.log(`\n  ── pull  ${D}(reads only; nothing is written)${X}`);
  await read("masters · ledgers", "Ledger", ["NAME", "PARENT", "LEDSTATENAME", "PARTYGSTIN"], 100);
  await read("masters · stock items", "StockItem", ["NAME", "PARENT", "BASEUNITS"], 100);
  await read("masters · stock groups", "StockGroup", ["NAME", "PARENT"], 10);
  await read("masters · voucher types", "VoucherType", ["NAME", "PARENT"], 10);
  await read("books · vouchers (trimmed)", "Voucher",
    ["DATE", "VOUCHERNUMBER", "VOUCHERTYPENAME", "PARTYLEDGERNAME"], 100);

  console.log(`\n  ── guards  ${D}(the 33 push rules and the silent-failure catalogue)${X}`);
  runHarness("push guard rules", "test-push-guard.ts");
  runHarness("edge-case catalogue", "test-edge-cases.ts");
  runHarness("gate recovery", "test-gate-recovery.ts");
  runHarness("GSTR exception audit", "test-gstr-exceptions.ts");

  if (!PUSH) {
    record("push · round trip", "skipped", "pass --push to write and read back");
    record("push · cleanup sweep", "skipped");
  } else {
    console.log(`\n  ── push  ${D}(writes marked vouchers, reads them back, removes them)${X}`);
    runHarness("round trip · build + push + diff", "roundtrip-verify.ts", ["--push"]);
    /* Cleanup is part of the write test, not an afterthought — and it sweeps
       what is ACTUALLY in the books rather than trusting the success list,
       because `safePush` returning ok:false does not mean nothing was created. */
    runHarness("cleanup · remove test vouchers", "find-stranded-test-vouchers.ts", ["--delete"]);
    runHarness("cleanup · confirm books are clean", "find-stranded-test-vouchers.ts");
  }

  console.log(`\n  ${"─".repeat(72)}`);
  const fails = results.filter((r) => r.verdict === "fail").length;
  const blocked = results.filter((r) => r.verdict === "cannot-run").length;
  const passes = results.filter((r) => r.verdict === "pass").length;
  console.log(`  ${passes} passed · ${fails} failed · ${blocked} could not run\n`);
  if (fails || blocked) {
    console.log(`  ${R}The Tally path is NOT verified.${X} Each line above names its stage and,`);
    console.log(`  for a zero, whether it came from Tally or from us.\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ${G}Pull and push both verified against the live books.${X}`);
  if (!PUSH) console.log(`  ${D}Reads only — re-run with --push to prove the write path too.${X}`);
  console.log();
})();
