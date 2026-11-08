/**
 * JOB: the laptop's half of the bank-mail test (rebuild lane T7m). It proves one TEST bank-mail
 * draft, once the server side has turned it into an ERP job, is booked by the laptop agent on the
 * DUMMY Tally, reads back right, and is swept again. On the real path the Owner's submit runs on the
 * server, never here, so this rig never creates or submits a draft: the coordinator does that part
 * in the database, and hands this rig the job id.
 *
 * Five modes, each saved with --out <file.json>:
 *
 *   --ledgers               READ ONLY. Cheap company-list read, check the loaded company is the practice
 *                           company (name and GUID), list the ZZ TEST ledgers, say whether HDFC BANK exists,
 *                           and take a census of vouchers that look like ours. Writes nothing, anywhere.
 *   --book --job <uuid>     Run the ERP job agent for that ONE test job. Refuses unless that job is the only
 *                           claimable test job. Claims one job only and gives it back if it is not the named
 *                           one. Then reads the voucher back from Tally for that one day and prints it, and
 *                           prints the job's final state and booked number. Does NOT sweep.
 *   --sweep --job <uuid>    Reads the job (number, date), deletes that one voucher from the dummy company and
 *                           confirms it is gone, then deletes the job, its proposal and its proposal request
 *                           through the fence. Prints erp_stale_test_rows() and compares the census with the
 *                           one saved by --ledgers (--census-from <that file>). Last of all it removes the test
 *                           party ledger (as --party-remove does), so one sweep leaves the dummy as it was.
 *   --party-create          The dummy company has no ZZ TEST party, so this makes ONE: the ledger
 *                           "ZZ TEST BANKMAIL PARTY" under Sundry Debtors, through masterPusher's createLedger
 *                           (sandbox role, local Tally and the practice GUID are checked first). No GSTIN, no
 *                           address, no opening balance; it carries the state West Bengal only because
 *                           createLedger refuses a party with no state. Refuses if the name already exists.
 *                           Reads it back and prints name, group and GUID.
 *   --party-remove          Deletes that one ledger, only when its name is exactly "ZZ TEST BANKMAIL PARTY".
 *                           Refuses while any voucher still names it as party. Confirms it is gone.
 *
 * Writes: --book books one ZZTESTBM Receipt or Payment in the dummy company and moves the job's row through
 * the queue functions; --sweep deletes that voucher and the job's three live rows. Never push_queue,
 * claim_push_jobs, the old test queue or any table main reads. The draft table and its change signals are
 * the coordinator's, not this rig's: the fence does not reach them.
 *
 * The sweep guard: the server numbers a test draft ZZTESTBM plus 8 upper-case hex characters, with no slash
 * or dash. The shared `isSweepVoucher` and the census patterns now know that shape (BANK_MAIL_TEST_NUMBER in
 * lib/testVoucherMatch.ts). This rig deletes only a voucher that passes the shared `isSweepVoucher` AND whose
 * number is exactly the job's own number, and it still counts ZZTESTBM vouchers on their own beside the census.
 *
 * Needs: sandbox role, local Tally with the practice company open, the Tally slot, this machine's registered
 * key, and (for --book and --sweep) MKCP_ERP_TEST_QUEUE=on for that one process.
 *
 *   $env:MKCP_ERP_TEST_QUEUE='on'; npx tsx scripts/rigs/bank-mail-dummy.ts --ledgers --out <ledgers.json>
 *   $env:MKCP_ERP_TEST_QUEUE='on'; npx tsx scripts/rigs/bank-mail-dummy.ts --book --job <uuid> --out <book.json>
 *   $env:MKCP_ERP_TEST_QUEUE='on'; npx tsx scripts/rigs/bank-mail-dummy.ts --sweep --job <uuid> --census-from <ledgers.json> --out <sweep.json>
 */
import "dotenv/config";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";
guardScriptWrites("rigs/bank-mail-dummy"); // writes only on a sandbox role against a local Tally
import { tallyPost, HEALTH_XML } from "../../src/tally.js";
import { erpTestQueueClient, agentMachineId, agentMachineKey } from "../../src/services/supabaseClient.js";
import { practiceCompany, practiceGuid, companyGuidsFromListing } from "../../src/services/tallyRole.js";
import { vouchersOnDateXml, diffStored } from "../../src/services/safePush.js";
import { loadMasters } from "../../src/services/tallyMasters.js";
import { createLedger, deleteLedger } from "../../src/services/masterPusher.js";
import { blocksOf, tagOf } from "../../src/services/tallyRequest.js";
import { readTag, escapeXml, tallyDateInt } from "../../src/services/xml.js";
import { ErpJobAgent, Journal, supabaseErpQueue, tallySeams, sameVoucherType, type ErpJob } from "../../src/services/erpJobAgent.js";
import { isSweepVoucher, BANK_MAIL_TEST_NUMBER } from "../lib/testVoucherMatch.js";
import { pull, isOurVoucher, remoteIdGuesses } from "../find-stranded-test-vouchers.js";
import { rigExitCode, rigSummary, recordError, type RigCheck } from "./rigExit.js";
import type { VoucherPayload } from "../../src/types.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const flag = (k: string) => process.argv.includes(k);
const OUT = arg("--out");
const JOB = arg("--job");
const CENSUS_FROM = arg("--census-from");
const MODE = flag("--ledgers") ? "ledgers" : flag("--book") ? "book" : flag("--sweep") ? "sweep"
  : flag("--party-create") ? "party-create" : flag("--party-remove") ? "party-remove" : null;
/** How many checks each mode makes when everything goes right (rigExitCode wants the exact number). */
const EXPECT = { ledgers: 6, book: 16, sweep: 12, "party-create": 5, "party-remove": 4 } as const;

const BANK_LEDGER = "HDFC BANK";
/** The one ledger this rig may create and remove. The remove path compares against this exact string. */
const PARTY = "ZZ TEST BANKMAIL PARTY";
const PARTY_GROUP = "Sundry Debtors";
const BANK_NUMBER = BANK_MAIL_TEST_NUMBER;   // one definition (G1)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (t: number) => new Promise((r) => setTimeout(r, t));
const indiaToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const post = (url: string, xml: string, timeoutMs = 180_000) => tallyPost(url, xml, timeoutMs, true) as Promise<string>;

class Stop extends Error {}

const steps: RigCheck[] = [];
const extra: Record<string, unknown> = {};
const step = (name: string, ok: boolean, detail = "") => {
  steps.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` (${detail})` : ""}`);
  return ok;
};
/** A step that must pass for the rest to make sense: on a fail, stop the run. */
const must = (name: string, ok: boolean, detail = "") => { if (!step(name, ok, detail)) throw new Stop(`${name}${detail ? `: ${detail}` : ""}`); };

// ── Tally reads ──────────────────────────────────────────────────────────────
/** Step 1 and 2 of every mode: a cheap company-list read, then the loaded company must be the practice company. */
async function preflight(): Promise<string> {
  const company = practiceCompany();
  if (!company) throw new Stop("MKCP_PRACTICE_COMPANY is not set");
  let listing = "";
  try { listing = await post(TALLY_URL, HEALTH_XML, 10_000); } catch (e) { must("Tally answers the company-list read", false, (e as Error).message); }
  const guids = companyGuidsFromListing(listing);
  must("Tally answers the company-list read", guids.size > 0, `${guids.size} company(ies) loaded`);
  const key = [...guids.keys()].find((k) => k.toLowerCase() === company.toLowerCase());
  const found = key === undefined ? [] : guids.get(key) ?? [];
  const mine = practiceGuid();
  must("the loaded company is the practice company (name and GUID)", found.length === 1 && !!mine && found[0] === mine,
    found.length === 0 ? "the practice company is not loaded" : found.length > 1 ? "loaded more than once" : found[0] === mine ? "name and GUID match" : "the GUID is not the practice company's");
  return company;
}

interface Block { number: string; type: string; date: string; party: string; narration: string; lines: { ledger: string; amount: string; positive: string; bank: string[]; bills: string[] }[]; xml: string }

/** The vouchers of one day, type and number, filtered inside Tally. Never a dated ledger collection. */
async function voucherOnDay(company: string, isoDate: string, type: string, number: string): Promise<Block[]> {
  const xml = await post(TALLY_URL, vouchersOnDateXml(company, isoDate, { voucherType: type, voucherNumber: number }));
  return [...xml.matchAll(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g)].map((m) => m[0])
    .filter((v) => readTag(v, "VOUCHERNUMBER").trim() === number && sameVoucherType(readTag(v, "VOUCHERTYPENAME"), type))
    .map((v) => {
      /* ALLLEDGERENTRIES.LIST alone: summing both lists double-counts (the repo CLAUDE.md). */
      let blocks = [...v.matchAll(/<ALLLEDGERENTRIES\.LIST\b[^>]*>[\s\S]*?<\/ALLLEDGERENTRIES\.LIST>/g)].map((m) => m[0]);
      if (!blocks.length) blocks = [...v.matchAll(/<LEDGERENTRIES\.LIST\b[^>]*>[\s\S]*?<\/LEDGERENTRIES\.LIST>/g)].map((m) => m[0]);
      return {
        number: readTag(v, "VOUCHERNUMBER").trim(), type: readTag(v, "VOUCHERTYPENAME").trim(), date: readTag(v, "DATE").trim(),
        party: readTag(v, "PARTYLEDGERNAME").trim(), narration: readTag(v, "NARRATION").trim(), xml: v,
        lines: blocks.map((b) => ({
          ledger: readTag(b, "LEDGERNAME").trim(), amount: readTag(b, "AMOUNT").trim(), positive: readTag(b, "ISDEEMEDPOSITIVE").trim(),
          /* bank and bill details, read as stored so they can be shown beside the line */
          bank: [...b.matchAll(/<BANKALLOCATIONS\.LIST\b[^>]*>[\s\S]*?<\/BANKALLOCATIONS\.LIST>/g)].map((m) => `instrument ${readTag(m[0], "INSTRUMENTNUMBER").trim()}, type ${readTag(m[0], "TRANSACTIONTYPE").trim()}, amount ${readTag(m[0], "AMOUNT").trim()}`),
          bills: [...b.matchAll(/<BILLALLOCATIONS\.LIST\b[^>]*>[\s\S]*?<\/BILLALLOCATIONS\.LIST>/g)].map((m) => `name "${readTag(m[0], "NAME").trim()}", type ${readTag(m[0], "BILLTYPE").trim()}, amount ${readTag(m[0], "AMOUNT").trim()}`),
        })),
      };
    });
}

/** Vouchers that look like ours: the shared census (find-stranded-test-vouchers) plus this rig's own ZZTESTBM shape, from ONE read. */
async function takeCensus(company: string): Promise<{ total: number; ours: string[]; bankMail: string[]; partyVouchers: number }> {
  const all = await pull(company);
  const key = (v: { date: string; type: string; number: string }) => `${v.date}|${v.type}|${v.number}`;
  const uniq = (a: string[]) => [...new Set(a)].sort();
  return {
    total: all.length,
    ours: uniq(all.filter(isOurVoucher).map(key)),
    bankMail: uniq(all.filter((v) => BANK_NUMBER.test(v.number)).map(key)),
    partyVouchers: all.filter((v) => v.party.trim().toLowerCase() === PARTY.toLowerCase()).length,
  };
}

// ── The test party ledger ────────────────────────────────────────────────────
interface PartyRead { name: string; group: string; guid: string }
/** One ledger by exact name, with its group and GUID. A custom collection filtered inside Tally; null when it is not there. */
async function readParty(company: string): Promise<PartyRead | null> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkPartyRead</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkPartyRead" ISMODIFY="No"><TYPE>Ledger</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>Parent</NATIVEMETHOD><NATIVEMETHOD>Guid</NATIVEMETHOD>
<FILTER>MkPartyReadF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MkPartyReadF">$Name = "${escapeXml(PARTY)}"</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw = await post(TALLY_URL, xml, 30_000);
  /* blocksOf, not a bare regex: the company info carries <LEDGER>205</LEDGER> as a count (masterPusher.readLedger). */
  const block = blocksOf(raw, "LEDGER")[0];
  if (!block) return null;
  const attr = /<LEDGER\b[^>]*\bNAME="([^"]*)"/i.exec(block)?.[1];
  return { name: (attr ?? tagOf(block, "NAME") ?? "").trim(), group: (tagOf(block, "PARENT") ?? "").trim(), guid: (tagOf(block, "GUID") ?? "").trim() };
}

/**
 * Remove the test party, exactly two checks every time (so --sweep and --party-remove count alike):
 *  1. no voucher names it as party (the caller's census count), or it is not there;
 *  2. it is removed and a fresh read finds nothing, or it was not there.
 * The name read back is compared to the constant before anything is sent; nothing else can be deleted from here.
 */
async function removeParty(company: string, vouchersUsingIt: number): Promise<void> {
  const here = await readParty(company);
  if (here && here.name !== PARTY) {
    step("no voucher uses the test party (or it is not there)", false, `the ledger read back is named "${here.name}", not exactly the test name; nothing was deleted`);
    step("the test party ledger is removed (or was not there)", false, "skipped");
    return;
  }
  const ok1 = step("no voucher uses the test party (or it is not there)", !here || vouchersUsingIt === 0, here ? `${vouchersUsingIt} voucher(s) name it as party` : "the ledger is not there");
  if (!ok1) { step("the test party ledger is removed (or was not there)", false, "skipped: a voucher still uses it"); return; }
  if (!here) { step("the test party ledger is removed (or was not there)", true, "it was not there"); return; }
  const r = await deleteLedger(TALLY_URL, company, PARTY);
  const after = await readParty(company);
  step("the test party ledger is removed (or was not there)", r.ok && after === null,
    r.ok ? (after ? "Tally said deleted but a fresh read still finds it" : "deleted, and a fresh read finds nothing") : `${r.notes.join(" ")} ${r.lineErrors.join("; ")}`.trim());
}

async function modePartyCreate() {
  const company = await preflight();                                                         // checks 1, 2
  const m = await loadMasters(TALLY_URL, company, { force: true });
  const clash = [...m.ledgers.values()].find((l) => l.name.trim().toLowerCase() === PARTY.toLowerCase());
  must("no ledger with that name exists yet", !clash, clash ? `"${clash.name}" is already there under ${clash.parent}` : `${m.ledgers.size} ledgers checked`);  // check 3
  const r = await createLedger(TALLY_URL, company, { name: PARTY, parent: PARTY_GROUP, state: "West Bengal", gstRegistrationType: "Unregistered" });
  must("Tally created the ledger", r.ok, r.ok ? `created ${r.created}` : `${r.notes.join(" ")} ${r.lineErrors.join("; ")}`.trim());   // check 4
  const got = await readParty(company);
  console.log(`\n  ledger read back:\n    name  ${got?.name ?? "-"}\n    group ${got?.group ?? "-"}\n    guid  ${got?.guid ?? "-"}`);
  extra.party = got;
  step("read back: exact name, group Sundry Debtors, a GUID", !!got && got.name === PARTY && got.group.toLowerCase() === PARTY_GROUP.toLowerCase() && got.guid.length > 0,
    got ? `${got.name} | ${got.group} | ${got.guid || "no GUID"}` : "not found");                // check 5
  console.log(`\n  The ledger is still in the dummy Tally. --sweep (or --party-remove) removes it.`);
}

async function modePartyRemove() {
  const company = await preflight();                                                         // checks 1, 2
  const cen = await takeCensus(company);
  console.log(`\n  vouchers naming the test party: ${cen.partyVouchers}`);
  await removeParty(company, cen.partyVouchers);                                             // checks 3, 4
}

// ── The job row ──────────────────────────────────────────────────────────────
type Client = ReturnType<typeof erpTestQueueClient>;
interface JobRow { id: string; state: string; payload: VoucherPayload & { label?: string }; proposal_id: string | null; booked_number: string | null; master_id: string | null; error: string | null; hidden_at: string | null; is_test: boolean; idempotency_key: string; kind: string }
const JOB_COLS = "id,state,payload,proposal_id,booked_number,master_id,error,hidden_at,is_test,idempotency_key,kind";
async function readJob(c: Client, id: string): Promise<JobRow | null> {
  const { data, error } = await c.from("erp_jobs").select(JOB_COLS).eq("is_test", true).eq("id", id).maybeSingle();
  if (error) throw new Stop(`could not read the job: ${error.message}`);
  return (data as JobRow | null) ?? null;
}
const describe = (p: VoucherPayload & { label?: string }) =>
  `${p.voucherType} ${p.voucherNumber} dated ${p.date}, party ${p.partyLedgerName}, label ${p.label}`;
/** The job must be a bank-mail test job: ZZTESTBM number, ZZ TEST label, ZZTEST narration, a REMOTEID. */
function bankMailJobProblem(j: JobRow): string | null {
  const p = j.payload;
  if (!j.is_test) return "the job is not a test job";
  if (!BANK_NUMBER.test(String(p.voucherNumber ?? ""))) return `the voucher number ${p.voucherNumber} is not ZZTESTBM plus 8 hex characters`;
  if (!String(p.label ?? "").startsWith("ZZ TEST")) return "the job is not labelled ZZ TEST";
  if (!String(p.narration ?? "").includes("ZZTEST")) return "the narration does not carry the ZZTEST mark";
  if (!String(p.remoteId ?? "").trim()) return "the job has no REMOTEID";
  if (!/^(receipt|payment)$/i.test(p.voucherType)) return `the voucher type ${p.voucherType} is not Receipt or Payment`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return `the date ${p.date} is not a plain day`;
  return null;
}

// ── Mode 1: --ledgers ────────────────────────────────────────────────────────
async function modeLedgers() {
  const company = await preflight();                                                         // checks 1, 2
  const m = await loadMasters(TALLY_URL, company, { force: true });
  const all = [...m.ledgers.values()];
  const zz = all.filter((l) => /^ZZ ?TEST/i.test(l.name)).sort((a, b) => a.name.localeCompare(b.name));
  step("ledgers read from the dummy company", all.length > 0, `${all.length} ledgers`);        // check 3
  step(`${BANK_LEDGER} exists`, all.some((l) => l.name === BANK_LEDGER), all.find((l) => l.name === BANK_LEDGER)?.parent ?? "not found");  // check 4
  step("at least one ZZ TEST / ZZTEST ledger exists", zz.length > 0, `${zz.length} found`);    // check 5
  console.log("\n  ZZ TEST ledgers (name | group):");
  for (const l of zz) console.log(`    ${l.name} | ${l.parent}`);
  extra.zzTestLedgers = zz.map((l) => ({ name: l.name, group: l.parent }));
  const cen = await takeCensus(company);                                                     // check 6
  step("census taken", true, `${cen.total} vouchers read; ${cen.ours.length} look like ours; ${cen.bankMail.length} are ZZTESTBM`);
  console.log(`\n  census: ${cen.ours.length} voucher(s) that look like ours`);
  for (const k of cen.ours) console.log(`    ${k}`);
  console.log(`  census: ${cen.bankMail.length} ZZTESTBM voucher(s)`);
  for (const k of cen.bankMail) console.log(`    ${k}`);
  extra.censusOurs = cen.ours; extra.censusBankMail = cen.bankMail; extra.vouchersRead = cen.total;
}

// ── Mode 2: --book ───────────────────────────────────────────────────────────
async function modeBook() {
  if (!JOB || !UUID.test(JOB)) throw new Stop("--book needs --job <uuid>");
  const company = await preflight();                                                         // checks 1, 2
  const c = erpTestQueueClient();                                                            // throws unless sandbox + switch + practice GUID
  const machine = agentMachineId(), key = agentMachineKey();
  const q = supabaseErpQueue(c, machine, key);

  const job = await readJob(c, JOB);
  const problem = !job ? "no test job has that id" : bankMailJobProblem(job) ?? (job.state !== "queued" ? `the job is ${job.state}, not queued` : job.hidden_at ? "the job is hidden" : null);
  must("the job is a queued bank-mail test job", !problem, problem ?? describe(job!.payload));  // check 3
  const p = job!.payload;
  console.log(`\n  job ${JOB}: ${describe(p)}`);

  /* Only this job may be claimable. The database claim takes the oldest claimable test job, so a second one would be booked instead. */
  const nowMs = Date.now();
  const { data: open, error: openErr } = await c.from("erp_jobs").select("id,state,hidden_at,next_try_at,lease_until").eq("is_test", true).in("state", ["queued", "claimed"]);
  if (openErr) throw new Stop(`could not list the queue: ${openErr.message}`);
  const others = (open ?? []).filter((r: any) => r.id !== JOB);
  const claimable = others.filter((r: any) => !r.hidden_at && (!r.next_try_at || new Date(r.next_try_at).getTime() <= nowMs)
    && (r.state === "queued" || (r.state === "claimed" && r.lease_until && new Date(r.lease_until).getTime() < nowMs)));
  const mine = await q.myOpenJobs();
  must("this is the only claimable test job and this machine holds no open job", claimable.length === 0 && others.length === 0 && mine.length === 0,
    `other queued or claimed test jobs ${others.length} (claimable ${claimable.length}), this machine's open jobs ${mine.length}`);  // check 4

  const before = await voucherOnDay(company, p.date, p.voucherType, p.voucherNumber!);
  must("Tally holds no voucher with that number yet", before.length === 0, `${before.length} found`);  // check 5

  const journalPath = join(tmpdir(), `bank-mail-dummy-${Date.now()}.jsonl`);
  const seams = tallySeams(TALLY_URL, post);
  const agent = new ErpJobAgent({ queue: q, journal: new Journal(journalPath), company, ...seams, leaseSeconds: 30, jobLeaseSeconds: 120 });
  let held = false;
  for (let t0 = Date.now(); Date.now() - t0 < 60_000 && !(held = await agent.heartbeat()); ) await sleep(3000);
  must("the agent holds the queue lease", held, held ? "" : agent.status.red.join("; "));   // check 6

  /* Claim exactly one job, by hand, so a second job that turned up since the check can never be booked. */
  const claimed = await q.claim(agent.nonce, 1, 120);
  if (claimed.length && claimed[0].id !== JOB) {
    await q.finish(agent.nonce, claimed[0].id, "queued").catch(() => false);                 // give it back unbooked
    must("the job the agent claimed is the named one", false, `it claimed a different job (${claimed[0].id}) and gave it back unbooked`);
  }
  must("the job the agent claimed is the named one", claimed.length === 1 && claimed[0].id === JOB, `${claimed.length} claimed`);  // check 7

  let outcome = "no outcome";
  try {
    const r = await agent.processJob(claimed[0] as ErpJob);
    outcome = r.outcome;
    step("the agent booked it on the dummy Tally", r.outcome === "succeeded", `${r.outcome}: ${r.detail}`);  // check 8
  } catch (e) { step("the agent booked it on the dummy Tally", false, (e as Error).message); }

  const after = await readJob(c, JOB);
  extra.job = { state: after?.state, bookedNumber: after?.booked_number, masterId: after?.master_id, error: after?.error };
  console.log(`\n  job after: state ${after?.state}, booked number ${after?.booked_number ?? "-"}, master id ${after?.master_id ?? "-"}${after?.error ? `, error: ${after.error}` : ""}`);
  step("the job row says succeeded with the booked number", after?.state === "succeeded" && after.booked_number === p.voucherNumber,
    `state ${after?.state}, booked number ${after?.booked_number ?? "-"}; agent outcome ${outcome}`);   // check 9

  /* The read-back from Tally, one day, filtered by type and number inside Tally. Printed whatever the checks say. */
  const got = await voucherOnDay(company, p.date, p.voucherType, p.voucherNumber!);
  const v = got[0];
  extra.voucher = v ? { type: v.type, number: v.number, date: v.date, party: v.party, narration: v.narration, lines: v.lines } : null;
  if (v) {
    console.log(`\n  Tally read-back (${p.date}):\n    type ${v.type}\n    number ${v.number}\n    date ${v.date}\n    party ${v.party}\n    narration ${v.narration}`);
    for (const l of v.lines) {
      console.log(`    line ${l.ledger} | ${l.amount} | deemed positive ${l.positive}`);
      for (const b of l.bank) console.log(`      bank: ${b}`);
      for (const b of l.bills) console.log(`      bill: ${b}`);
    }
  }
  step("Tally holds exactly one voucher with that number", got.length === 1, `${got.length} found`);   // check 10
  step("type is the job's type", !!v && sameVoucherType(v.type, p.voucherType), v?.type ?? "no voucher");   // check 11
  /* Tally overwrites the header party with the bank ledger on Payment, Receipt and Contra (PARTY_OVERWRITTEN in pushGuard.ts),
     so for those three types the party is looked for on the ledger lines, and for any other type on the header. */
  const partyOnLines = !!v && v.lines.some((l) => l.ledger === p.partyLedgerName);
  const headerOverwritten = /^(payment|receipt|contra)$/i.test(p.voucherType);
  step("party is the job's party (on a ledger line for Payment, Receipt and Contra)", !!v && (headerOverwritten ? partyOnLines : v.party === p.partyLedgerName),
    v ? `header party ${v.party}; ${headerOverwritten ? `party on a ledger line: ${partyOnLines}` : "compared on the header"}` : "no voucher");          // check 12
  const abs = (s: string) => Math.abs(parseFloat(s.replace(/[^0-9.\-]/g, "")));
  const want = (p.ledgerEntries ?? []).map((e) => ({ ledger: e.ledgerName, amount: e.amount }));
  const linesOk = !!v && want.length >= 2 && want.every((w) => v.lines.some((l) => l.ledger === w.ledger && Math.abs(abs(l.amount) - w.amount) < 0.02));
  step("every ledger line of the job is there with its amount (party and bank)", linesOk, want.map((w) => `${w.ledger} ${w.amount}`).join("; "));  // check 13
  step("narration ends ZZTEST", !!v && v.narration.endsWith("ZZTEST"), v?.narration ?? "no voucher");     // check 14
  const diffs = v ? diffStored(p, v.xml) : ["no voucher"];
  step("the stored copy matches what was sent, field by field", diffs.length === 0, diffs.join("; "));      // check 15
  /* The crash-recovery read (findInTally) must find the booked voucher exactly once, as the real settle path would.
     It matches the party on the ledger lines for Receipt, Payment and Contra, because Tally overwrites the header party. */
  let again: { masterId: string }[] = [];
  let againErr = "";
  try { again = await seams.find(company, p); } catch (e) { againErr = (e as Error).message; }
  step("findInTally finds the booked voucher exactly once (the crash-recovery read)", again.length === 1 && !againErr,
    againErr || `${again.length} found; master id ${again[0]?.masterId ?? "-"}, the job row says ${after?.master_id ?? "-"}`);  // check 16
  console.log(`\n  The voucher is still in the dummy Tally. Run --sweep --job ${JOB} to remove it.`);
}

// ── Mode 3: --sweep ──────────────────────────────────────────────────────────
async function modeSweep() {
  if (!JOB || !UUID.test(JOB)) throw new Stop("--sweep needs --job <uuid>");
  const company = await preflight();                                                         // checks 1, 2
  const c = erpTestQueueClient();
  const job = await readJob(c, JOB);
  const problem = !job ? "no test job has that id" : bankMailJobProblem(job);
  must("the job is a bank-mail test job", !problem, problem ?? describe(job!.payload));    // check 3
  const p = job!.payload, number = p.voucherNumber!;

  /* Tally first: find the one voucher, judge it with the shared sweep guard plus the job's own number, delete it, confirm it is gone. */
  const found = await voucherOnDay(company, p.date, p.voucherType, number);
  const guarded = found.filter((v) => v.number === number && isSweepVoucher({ number: v.number, narration: v.narration }, "ZZTEST"));
  step("the voucher in Tally passes the sweep guard (or none was booked)", found.length <= 1 && guarded.length === found.length,
    `${found.length} found; passes the shared isSweepVoucher and carries the job's own number: ${guarded.length}`);  // check 4
  let deletedInTally = 0;
  if (found.length === 1 && guarded.length === 1) {
    const day = tallyDateInt(p.date), type = found[0].type;
    const ids = [...new Set([String(p.remoteId), ...remoteIdGuesses(type, number)])];
    for (const rid of ids) {
      const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${escapeXml(rid)}" VCHTYPE="${escapeXml(type)}" ACTION="Delete"><DATE>${day}</DATE><VOUCHERTYPENAME>${escapeXml(type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${escapeXml(number)}</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
      try {
        const res = await post(TALLY_URL, xml, 60_000);
        deletedInTally = parseInt(readTag(res, "DELETED") || "0", 10) || 0;
      } catch { /* a wrong REMOTEID guess reads as "does not exist"; try the next */ }
      if (deletedInTally) break;
    }
  }
  step("the voucher was deleted from the dummy Tally (or none was booked)", found.length === 0 || deletedInTally === 1, `deleted ${deletedInTally} of ${found.length}`);  // check 5
  const left = await voucherOnDay(company, p.date, p.voucherType, number);
  step("a fresh one-day read finds no voucher with that number", left.length === 0, `${left.length} left`);  // check 6

  /* The job's three live rows, through the fence: job, then its proposal request, then its proposal. */
  const pid = job!.proposal_id;
  const reqs = pid ? await c.from("erp_proposal_requests").select("request_id").eq("is_test", true).eq("proposal_id", pid) : { data: [], error: null };
  const reqIds = ((reqs.data ?? []) as { request_id: string }[]).map((r) => r.request_id);
  const d1 = await c.from("erp_jobs").delete().in("id", [JOB]).eq("is_test", true);
  const d2 = reqIds.length ? await c.from("erp_proposal_requests").delete().in("request_id", reqIds).eq("is_test", true) : { error: null };
  const d3 = pid ? await c.from("erp_proposals").delete().in("id", [pid]).eq("is_test", true) : { error: null };
  const errs = [reqs.error?.message, d1.error?.message, d2.error?.message, d3.error?.message].filter(Boolean);
  const jobLeft = await c.from("erp_jobs").select("id").eq("is_test", true).eq("id", JOB);
  const propLeft = pid ? await c.from("erp_proposals").select("id").eq("is_test", true).eq("id", pid) : { data: [], error: null };
  const reqLeft = pid ? await c.from("erp_proposal_requests").select("request_id").eq("is_test", true).eq("proposal_id", pid) : { data: [], error: null };
  const leftN = (jobLeft.data?.length ?? 0) + (propLeft.data?.length ?? 0) + (reqLeft.data?.length ?? 0);
  step("the job, its proposal and its proposal request are deleted", errs.length === 0 && !jobLeft.error && !propLeft.error && !reqLeft.error && leftN === 0,
    errs.join("; ") || `deleted job 1, proposal ${pid ? 1 : 0}, request(s) ${reqIds.length}; ${leftN} left`);   // check 7

  /* Information: change signals the draft's submit made are the coordinator's to remove (the fence does not reach them). */
  const sig = await c.from("erp_change_signals").select("table_name", { count: "exact", head: true }).eq("is_test", true).eq("table_name", "erp_bank_mail_drafts");
  extra.changeSignalsForDrafts = sig.error ? `unreadable: ${sig.error.message}` : sig.count;
  console.log(`\n  info: erp_change_signals rows for erp_bank_mail_drafts (the coordinator's to remove): ${sig.error ? sig.error.message : sig.count}`);

  const stale = await c.rpc("erp_stale_test_rows", {});
  const rows = (stale.data ?? []) as { table_name: string; stale: number | string }[];
  const total = rows.reduce((n, r) => n + Number(r.stale), 0);
  extra.staleTestRows = { total, nonZero: rows.filter((r) => Number(r.stale) > 0) };
  console.log(`  erp_stale_test_rows(): total ${total}${rows.filter((r) => Number(r.stale) > 0).map((r) => `; ${r.table_name} ${r.stale}`).join("")}   (counts only rows older than one day)`);
  step("erp_stale_test_rows() answered", !stale.error, stale.error?.message ?? `total ${total}`);          // check 8

  const cen = await takeCensus(company);
  extra.censusOurs = cen.ours; extra.censusBankMail = cen.bankMail;
  let before: { censusOurs?: string[]; censusBankMail?: string[] } | null = null;
  try { before = CENSUS_FROM ? JSON.parse(readFileSync(CENSUS_FROM, "utf8")) : null; } catch { before = null; }
  const same = !!before?.censusOurs && JSON.stringify(before.censusOurs) === JSON.stringify(cen.ours);
  const fresh = cen.ours.filter((k) => !before?.censusOurs?.includes(k)), gone = (before?.censusOurs ?? []).filter((k) => !cen.ours.includes(k));
  step("the census equals the one taken by --ledgers", same,
    before?.censusOurs ? `${cen.ours.length} now, ${before.censusOurs.length} before${fresh.length ? `; new: ${fresh.join(", ")}` : ""}${gone.length ? `; missing: ${gone.join(", ")}` : ""}` : "no --census-from file given or readable, so nothing was compared");  // check 9
  step("no ZZTESTBM voucher is left in the books", cen.bankMail.length === 0, `${cen.bankMail.length} left${cen.bankMail.length ? `: ${cen.bankMail.join(", ")}` : ""}`);   // check 10

  /* Last, once the voucher is gone: the test party goes too, so one sweep leaves the dummy as it was. */
  await removeParty(company, cen.partyVouchers);                                             // checks 11, 12
}

// ── Run ──────────────────────────────────────────────────────────────────────
(async () => {
  if (!MODE) { console.error("Say one of --ledgers, --party-create, --book --job <uuid>, --sweep --job <uuid>, --party-remove"); process.exit(2); }
  console.log(`\n  bank-mail rig on the dummy Tally, mode ${MODE} (${indiaToday()})\n`);
  try {
    if (MODE === "ledgers") await modeLedgers();
    else if (MODE === "book") await modeBook();
    else if (MODE === "party-create") await modePartyCreate();
    else if (MODE === "party-remove") await modePartyRemove();
    else await modeSweep();
  } catch (e) {
    recordError(steps, e, e instanceof Stop ? "the run stopped" : "the run finished without an error");
    console.log(`  ✗ ${steps[steps.length - 1].name} (${steps[steps.length - 1].detail})`);
  } finally {
    const report = { rig: "bank-mail-dummy", mode: MODE, day: indiaToday(), job: JOB, steps, ...extra, summary: rigSummary(steps, EXPECT[MODE]) };
    if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2)); }
    console.log(`\n  ${report.summary}\n`);
    process.exit(rigExitCode(steps, EXPECT[MODE]));
  }
})();
