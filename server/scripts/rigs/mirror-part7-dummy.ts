/**
 * Task 1-5, part 7, on the dummy Tally: the full fetch list, READ ONLY.
 *
 * Nothing is pushed to Tally and nothing is swept. The rig:
 *   1. probes each new ledger field ON ITS OWN (Guid, Name and that one field), one request at
 *      a time with the usual limit and no retry, so a field Tally dislikes shows up alone;
 *   2. reads the voucher types (with parent), the units (with decimals) and the item keys, one
 *      request each, and counts them;
 *   3. runs the ERP mirror sync (a one-day full window plus the ledgers, as test rows, names
 *      scrubbed) into the ERP's own test mirror;
 *   4. counts, from Tally's raw reply (an independent regular-expression count, not the
 *      parser's), the ledgers with a phone, a mobile and a PAN, and the vouchers of the
 *      window with a user and with a bank instrument, and counts the same in the ERP test
 *      mirror after the swap. Only counts are printed, never a number or a name;
 *   5. checks that no phone, mobile, PAN, user name or instrument number was stored in the
 *      test mirror (every stored value is scanned against the values Tally sent);
 *   6. deletes this run's test rows.
 * The tally_* tables are never read or written. Every request goes through tallyPost, which
 * checks the practice company's GUID. The Tally slot must be claimed first.
 *
 *   $env:MKCP_ERP_TEST_QUEUE='on'; npx tsx scripts/rigs/mirror-part7-dummy.ts --out <file.json>
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";
guardScriptWrites("rigs/mirror-part7-dummy"); // writes only on a sandbox role against a local Tally
import { tallyPost } from "../../src/tally.js";
import { erpTestQueueClient, agentMachineId, agentMachineKey } from "../../src/services/supabaseClient.js";
import { practiceCompany, practiceGuid } from "../../src/services/tallyRole.js";
import {
  runMirrorSync, supabaseMirrorStore, tallyMirrorReads, eachDay, ERP_MIRROR_LEDGER_DEF, ERP_MIRROR_VOUCHER_DEF, ERP_MIRROR_VOUCHERTYPE_DEF,
  ERP_MIRROR_UNIT_DEF, ERP_MIRROR_ITEM_DEF, type MirrorSyncReport,
} from "../../src/services/erpMirrorSync.js";
import { buildCollectionXml } from "../../src/services/xmlBuilder.js";
import type { CollectionDef } from "../../src/types.js";
import { swapStoreCleanup } from "./rigExit.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const OUT = arg("--out");
const company = practiceCompany();
if (!company) { console.error("MKCP_PRACTICE_COMPANY is not set"); process.exit(2); }
if (!practiceGuid()) { console.error("MKCP_PRACTICE_COMPANY_GUID is not set: the rig will not read a company it cannot identify"); process.exit(2); }
const c = erpTestQueueClient();
const machine = agentMachineId(), key = agentMachineKey();
const stamp = Date.now().toString().slice(-6);
const companyKey = `ZZTEST-PART7-${stamp}`;
const store = supabaseMirrorStore(c, machine, key, companyKey, true);
const tally = tallyMirrorReads(TALLY_URL, company);
const raw = (def: CollectionDef, timeout: number) => tallyPost(TALLY_URL, buildCollectionXml(def, company), timeout, true) as Promise<string>;

function provenance() {
  const git = (...a: string[]) => (spawnSync("git", a, { encoding: "utf8", cwd: dirname(process.argv[1]) }).stdout ?? "").trim();
  return { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirtyFiles: git("status", "--porcelain", "--", "..", "../../src").split("\n").filter(Boolean) };
}
/** Count of non-empty `<TAG>text</TAG>` elements and of all `<TAG` elements (sent, empty or not) in a raw reply. */
const countTag = (xml: string, tag: string) => ({
  filled: [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*\\S[^<]*)</${tag}>`, "g"))].length,
  sent: [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>)`, "g"))].length,
});

(async () => {
  const prov = provenance();
  const steps: { step: string; ok: boolean; detail: string; at: string }[] = [];
  const step = (s: string, ok: boolean, detail = "") => { steps.push({ step: s, ok, detail, at: new Date().toISOString() }); console.log(`  ${ok ? "✓" : "✗"} ${s}${detail ? ` (${detail})` : ""}`); };
  const counts: Record<string, unknown> = {};
  let run: MirrorSyncReport | null = null;
  const t0 = Date.now();
  console.log(`\n  Part 7 fetch list on the dummy Tally, read only (stamp ${stamp}, commit ${prov.commit.slice(0, 8)}, tree ${prov.tree.slice(0, 8)})\n`);
  step("the run uses committed code (no uncommitted change in the agent's src or scripts)", prov.dirtyFiles.length === 0, prov.dirtyFiles.join(", "));
  try {
    // 1. each new ledger field alone
    for (const f of ["LedgerPhone", "LedgerMobile", "IncomeTaxNumber", "GSTRegistrationType", "IsBillWiseOn"]) {
      const def: CollectionDef = { ...ERP_MIRROR_LEDGER_DEF, name: `probe${f}`, fetch: ["Guid", "Name", f] };
      const t = Date.now();
      const xml = await raw(def, 120_000);
      const tag = f.toUpperCase();
      const n = countTag(xml, tag), ledgers = countTag(xml, "GUID");
      counts[`probe_${f}`] = { ms: Date.now() - t, ledgers: ledgers.sent, tagSent: n.sent, filled: n.filled };
      step(`probe ${f} alone: Tally answers, and sends the tag`, !/<LINEERROR>|<STATUS>0<\/STATUS>/i.test(xml) && ledgers.sent > 0 && n.sent > 0, `${Date.now() - t} ms, ${ledgers.sent} ledgers, ${n.sent} sent the tag, ${n.filled} filled`);
    }

    // 2. voucher types, units, item keys: one read each
    for (const [label, def, tag] of [["voucher types", ERP_MIRROR_VOUCHERTYPE_DEF, "PARENT"], ["units", ERP_MIRROR_UNIT_DEF, "DECIMALPLACES"], ["item keys", ERP_MIRROR_ITEM_DEF, "GUID"]] as const) {
      const t = Date.now();
      const xml = await raw(def, def.timeout);
      const objectTag = def.tallyCollection.toUpperCase();
      const objects = [...xml.matchAll(new RegExp(`<${objectTag}(?:\\s[^>]*)?>`, "g"))].length;
      const withTag = countTag(xml, tag);
      counts[`read_${label}`] = { ms: Date.now() - t, objects, withTag: withTag.sent, filled: withTag.filled };
      step(`${label}: Tally answers with named fields`, objects > 0 && withTag.sent > 0 && !/<LINEERROR>/i.test(xml), `${Date.now() - t} ms, ${objects} objects, ${withTag.sent} carry ${tag}, ${withTag.filled} filled`);
    }

    // 3. a one-day full window and the ledgers into the ERP test mirror
    const top = await tally.highest();
    const day = Object.entries(top.byDay).filter(([, n]) => n >= 5 && n <= 60).sort((a, b) => b[1] - a[1])[0];
    if (!day) throw new Error("no day with 5 to 60 vouchers to use as the window");
    const scope = { from: day[0], to: day[0] };
    counts.window = { day: day[0], vouchers: day[1] };
    run = await runMirrorSync({ store, tally, kind: "full", scope });
    step("the one-day full run and the ledger read swapped into the test mirror", run.state === "swapped" && run.read === day[1], `${run.read} vouchers read, Tally counts ${day[1]}${run.error ? `, ${run.error}` : ""}`);

    // 4. independent counts from Tally's raw replies, then the same in the test mirror
    const ledgerXml = await raw(ERP_MIRROR_LEDGER_DEF, ERP_MIRROR_LEDGER_DEF.timeout);
    const before = {
      ledgers: countTag(ledgerXml, "GUID").sent,
      phone: countTag(ledgerXml, "LEDGERPHONE").filled, mobile: countTag(ledgerXml, "LEDGERMOBILE").filled, pan: countTag(ledgerXml, "INCOMETAXNUMBER").filled,
      registrationType: countTag(ledgerXml, "GSTREGISTRATIONTYPE").filled, billwiseOn: [...ledgerXml.matchAll(/<ISBILLWISEON(?:\s[^>]*)?>\s*Yes\s*<\/ISBILLWISEON>/gi)].length,
    };
    const dayXml = await tallyPost(TALLY_URL, buildCollectionXml(ERP_MIRROR_VOUCHER_DEF, company, day[0], day[0]), ERP_MIRROR_VOUCHER_DEF.timeout, true) as string;
    /* Vouchers with at least one bank block that holds an instrument number or date, counted per voucher in the raw reply (not by the parser). */
    const vouchersRaw = dayXml.split(/<\/VOUCHER>/i).slice(0, -1);
    const holdsInstrument = (v: string) => [...v.matchAll(/<BANKALLOCATIONS\.LIST\b[\s\S]*?<\/BANKALLOCATIONS\.LIST>/gi)].some((b) => /<INSTRUMENT(?:NUMBER|DATE)(?:\s[^>]*)?>[^<]*\S[^<]*<\/INSTRUMENT(?:NUMBER|DATE)>/i.test(b[0]));
    const beforeV = { vouchers: vouchersRaw.length, enteredBy: countTag(dayXml, "ENTEREDBY").filled, instrumentVouchers: vouchersRaw.filter(holdsInstrument).length };
    counts.before = { ...before, ...beforeV };
    const q = async (table: string, filters: [string, string][]) => {
      let r = c.from(table).select("key", { count: "exact", head: true }).eq("company_key", companyKey).eq("is_test", true);
      for (const [col, v] of filters) r = r.filter(col, "eq", v);
      const { count, error } = await r;
      if (error) throw new Error(`count ${table}: ${error.message}`);
      return count ?? 0;
    };
    const after = {
      ledgers: await q("erp_mirror_ledgers", []),
      phone: await q("erp_mirror_ledgers", [["row->>has_phone", "true"]]), mobile: await q("erp_mirror_ledgers", [["row->>has_mobile", "true"]]), pan: await q("erp_mirror_ledgers", [["row->>has_pan", "true"]]),
      registrationType: await (async () => { const { count } = await c.from("erp_mirror_ledgers").select("key", { count: "exact", head: true }).eq("company_key", companyKey).eq("is_test", true).not("row->>gst_registration_type", "is", null); return count ?? 0; })(),
      billwiseOn: await q("erp_mirror_ledgers", [["row->>is_billwise_on", "true"]]),
      sentAll: await q("erp_mirror_ledgers", [["row->>contact_fields_sent", "true"]]),
    };
    const afterV = {
      vouchers: await q("erp_mirror_rows", []), enteredBy: await (async () => { const { count } = await c.from("erp_mirror_rows").select("key", { count: "exact", head: true }).eq("company_key", companyKey).eq("is_test", true).not("row->>entered_by", "is", null); return count ?? 0; })(),
      instrumentVouchers: await (async () => { const { count } = await c.from("erp_mirror_rows").select("key", { count: "exact", head: true }).eq("company_key", companyKey).eq("is_test", true).gt("row->>instrument_count", "0"); return count ?? 0; })(),
      extrasSent: await q("erp_mirror_rows", [["row->>extras_sent", "true"]]),
    };
    counts.after = { ...after, ...afterV };
    const billwiseTags = countTag(ledgerXml, "ISBILLWISEON").sent;
    step("the test mirror holds as many ledgers as Tally sent, and each says the fields were served (the bill-wise tag Tally sends on every ledger)", after.ledgers === before.ledgers && after.sentAll === billwiseTags && billwiseTags === before.ledgers, `${after.ledgers} in the mirror, ${before.ledgers} in Tally's reply, ${billwiseTags} with the bill-wise tag, ${after.sentAll} marked served`);
    step("phones, mobiles and PANs: the mirror counts the same as Tally's reply", after.phone === before.phone && after.mobile === before.mobile && after.pan === before.pan,
      `phone ${before.phone} to ${after.phone}, mobile ${before.mobile} to ${after.mobile}, PAN ${before.pan} to ${after.pan}`);
    step("registration type and bill-wise: the mirror counts the same as Tally's reply", after.registrationType === before.registrationType && after.billwiseOn === before.billwiseOn,
      `registration type ${before.registrationType} to ${after.registrationType}, bill-wise on ${before.billwiseOn} to ${after.billwiseOn}`);
    step("the window's vouchers: every one says its extras were read, and users are counted", afterV.vouchers === day[1] && afterV.extrasSent === afterV.vouchers && afterV.enteredBy === beforeV.enteredBy && afterV.instrumentVouchers === beforeV.instrumentVouchers,
      `${afterV.vouchers} vouchers, ${afterV.extrasSent} with extras read, a user on ${beforeV.enteredBy} in Tally and ${afterV.enteredBy} in the mirror, vouchers with a bank instrument ${beforeV.instrumentVouchers} in Tally and ${afterV.instrumentVouchers} in the mirror`);

    // 5. nothing personal stored: scan the stored rows against the values Tally sent
    const grab = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*\\S[^<]*)</${tag}>`, "g"))].map((m) => m[1].trim());
    const secrets = new Set<string>([...grab(ledgerXml, "LEDGERPHONE"), ...grab(ledgerXml, "LEDGERMOBILE"), ...grab(ledgerXml, "INCOMETAXNUMBER"), ...grab(dayXml, "ENTEREDBY"), ...grab(dayXml, "INSTRUMENTNUMBER")].filter((s) => s.length >= 4));
    const { data: lrows } = await c.from("erp_mirror_ledgers").select("row").eq("company_key", companyKey).eq("is_test", true).limit(5000);
    const { data: vrows } = await c.from("erp_mirror_rows").select("row").eq("company_key", companyKey).eq("is_test", true).limit(5000);
    const blob = JSON.stringify([lrows, vrows]);
    let leaks = 0;
    for (const s of secrets) if (blob.includes(s)) leaks++;
    counts.scan = { distinctValuesChecked: secrets.size, leaks };
    step("no phone, mobile, PAN, user name or instrument number from Tally is stored in the test mirror", leaks === 0 && secrets.size > 0, `${secrets.size} distinct values checked against ${(lrows ?? []).length} ledger rows and ${(vrows ?? []).length} voucher rows, ${leaks} found`);
  } catch (e) {
    step("the run finished without an error", false, (e as Error).message);
  } finally {
    const { data: cleaned, error: ce } = await c.rpc("erp_sync_test_cleanup", { p_machine: machine, p_key: key, p_company_key: companyKey });
    const swapClean = await swapStoreCleanup(c, machine, key, companyKey);   // the swap store's test rows (migration 0130): the call is checked and the leftover rows counted
    step("the swap store holds none of this run's test rows after the clean-up", swapClean.ok, swapClean.detail);
    const { count: runsLeft } = await c.from("erp_sync_runs").select("id", { count: "exact", head: true }).eq("company_key", companyKey).eq("is_test", true);
    const { count: rowsLeft } = await c.from("erp_mirror_rows").select("key", { count: "exact", head: true }).eq("company_key", companyKey).eq("is_test", true);
    const { count: ledLeft } = await c.from("erp_mirror_ledgers").select("key", { count: "exact", head: true }).eq("company_key", companyKey).eq("is_test", true);
    step("this run's test rows are deleted (mirror rows, ledgers, mark, runs, steps, staging)", !ce && runsLeft === 0 && rowsLeft === 0 && ledLeft === 0, ce?.message ?? JSON.stringify(cleaned));
    const report = { rig: "mirror-part7-dummy", stamp, companyKey, provenance: prov, minutes: Math.round((Date.now() - t0) / 6000) / 10, counts, steps,
      run: run && { run_id: run.run_id, state: run.state, read: run.read, ledgers: run.ledgers, error: run.error },
      passed: steps.filter((s) => s.ok).length, failed: steps.filter((s) => !s.ok).length };
    if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(report, null, 2)); }
    console.log(`\n  ${report.passed} passed, ${report.failed} failed (${report.minutes} min)`);
    process.exit(report.failed ? 1 : 0);
  }
})();
