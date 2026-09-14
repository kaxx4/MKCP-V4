/**
 * Take ONE queued voucher to Tally, by hand, and prove it arrived.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * The push agent drains `push_queue` on a timer, and it is switched OFF on this
 * machine: `MKCP_TALLY_ROLE=sandbox` makes `supabaseClient()` return null, so
 * the agent never connects. That is the correct setting during a parallel run
 * and flipping it is a human's decision, not a script's.
 *
 * But "the queue is not draining" is a different fact from "the path does not
 * work", and the second one is what needs proving. This drains exactly one row,
 * through the SAME `safePush` the agent uses — same guard, same read-back, same
 * diff — so what is verified is the real path and not a rehearsal of it.
 *
 * ── Safety ───────────────────────────────────────────────────────────────
 *
 * Refuses any voucher whose number is not marked as a test (the prefixes in the
 * web app's domain/sandbox.ts). This cannot be pointed at real trade, whatever
 * is sitting in the queue.
 *
 *   npx tsx server/scripts/drain-one-queued.ts <voucherNumber> [--delete]
 *
 * `--delete` removes it from Tally again afterwards, which is how every write
 * test in this project is expected to end.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { createClient } from "@supabase/supabase-js";
import { safePush } from "../src/services/safePush.js";
import { tallyPost } from "../src/tally.js";
import type { VoucherPayload } from "../src/types.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";

/** Mirrors TEST_NUMBER_PREFIXES in the web app's domain/sandbox.ts. */
const TEST_PREFIXES = ["MKCP-", "RPLY-", "VERIFY-", "SMOKE-", "DEMO-"];

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Ask Tally for one voucher by number — the only answer that counts. */
async function readBackFromTally(voucherNumber: string): Promise<string> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkDrainVerify</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkDrainVerify" ISMODIFY="No"><TYPE>Voucher</TYPE>
<FETCH>VoucherNumber</FETCH><FETCH>VoucherTypeName</FETCH><FETCH>Date</FETCH>
<FETCH>PartyLedgerName</FETCH><FETCH>Narration</FETCH><FETCH>MasterId</FETCH>
<FETCH>AllLedgerEntries</FETCH>
<FILTER>MkDrainVerifyF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MkDrainVerifyF">$VoucherNumber = "${esc(voucherNumber)}"</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  return tallyPost(TALLY, xml, 120_000, true);
}

/**
 * Read a field off the voucher, tolerating an attribute on the tag.
 *
 * Tally writes the SAME field both ways depending on which one it is:
 * `<VOUCHERNUMBER>MKCP-VERIFY-01</VOUCHERNUMBER>` but
 * `<NARRATION TYPE="String">…</NARRATION>` and `<MASTERID TYPE="Number"> 249391</MASTERID>`.
 * A `<TAG>` regex silently returns nothing for the second kind, which reads on
 * screen as "Tally does not have it" — the exact confusion G7 exists to stop.
 */
function field(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "i").exec(xml);
  return m ? m[1].trim() || "—" : "—";
}

/**
 * Count the vouchers Tally actually returned.
 *
 * Only the <DATA> half of the envelope holds them. The <DESC><CMPINFO> half
 * carries a census of the company's objects, and one of its lines is literally
 * `<VOUCHER>81</VOUCHER>` — the number of vouchers in the company. Counting
 * `<VOUCHER[\s>]` across the whole envelope therefore reports one more than
 * exists, which reads as "an Alter became a Create" when nothing went wrong.
 */
function vouchersIn(xml: string): { count: number; data: string } {
  const data = /<DATA>([\s\S]*)<\/DATA>/i.exec(xml)?.[1] ?? "";
  return { count: data.match(/<VOUCHER[\s>]/gi)?.length ?? 0, data };
}

/**
 * Set the queue row's status, and SAY SO if the write is refused.
 *
 * This was written first as a bare `.update()` whose `error` nobody read, and it
 * cost a wrong conclusion within the hour: `status: "pushed"` is not one of the
 * six values `push_queue_status_check` allows (pending · claimed · pushing ·
 * succeeded · failed · cancelled), so every such update was rejected, the row
 * stayed "pending", and the script reported a successful push over a row it had
 * not actually marked. A discarded `error` is how this project's dead features
 * were all built; the only fix is to read it.
 */
async function setStatus(
  db: ReturnType<typeof createClient>,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.from("push_queue").update(patch).eq("id", id);
  if (error) throw new Error(`could not set queue row ${id} to "${patch.status}": ${error.message}`);
}

async function deleteFromTally(payload: VoucherPayload): Promise<void> {
  await safePush(TALLY, COMPANY, { ...payload, action: "Delete" }, { verify: false });
}

/**
 * Run the two parsers against the bytes Tally actually sent, and exit.
 *
 * Both cases below are real responses from 14-Sep-2026, not invented ones. Each
 * is a trap this script fell into first and reported as a fact about the books:
 * the census line read as a duplicate voucher, and the attributed tags read as
 * fields Tally did not have.
 *
 *   npx tsx server/scripts/drain-one-queued.ts --selftest
 */
function selfTest(): void {
  const REAL = `<ENVELOPE><BODY>
 <DESC><CMPINFO><LEDGER>264</LEDGER><VOUCHERNUMBERSERIES>103</VOUCHERNUMBERSERIES>
  <VOUCHER>81</VOUCHER></CMPINFO></DESC>
 <DATA><COLLECTION>
  <VOUCHER REMOTEID="353d02e0-0003ce2f" VCHTYPE="Receipt">
   <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
   <VOUCHERNUMBER>MKCP-VERIFY-01</VOUCHERNUMBER>
   <NARRATION TYPE="String">MKCP verification receipt</NARRATION>
   <MASTERID TYPE="Number"> 249391</MASTERID>
  </VOUCHER>
 </COLLECTION></DATA></BODY></ENVELOPE>`;

  const cases: [string, unknown, unknown][] = [
    // The census line <VOUCHER>81</VOUCHER> lives in CMPINFO, outside <DATA>.
    // Counting it made one voucher read as two — i.e. as a silent duplicate.
    ["one voucher is counted once", vouchersIn(REAL).count, 1],
    ["the company census is not a voucher", vouchersIn(REAL).data.includes("CMPINFO"), false],
    // Tally attributes some tags and not others, for the same kind of field.
    ["a bare tag is read", field(vouchersIn(REAL).data, "VOUCHERNUMBER"), "MKCP-VERIFY-01"],
    ["an attributed tag is read", field(vouchersIn(REAL).data, "NARRATION"), "MKCP verification receipt"],
    ["a numeric tag is trimmed", field(vouchersIn(REAL).data, "MASTERID"), "249391"],
    // An absent field must say so, never read as empty-but-present.
    ["an absent field says so", field(vouchersIn(REAL).data, "PARTYLEDGERNAME"), "—"],
    // Nothing found at all is zero, not a crash.
    ["an empty envelope is zero", vouchersIn("<ENVELOPE><BODY></BODY></ENVELOPE>").count, 0],
  ];

  let bad = 0;
  for (const [name, got, want] of cases) {
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`);
  }
  console.log(bad ? `\n  ${bad} failed.` : "\n  all good.");
  process.exit(bad ? 1 : 0);
}

async function main(): Promise<void> {
  if (process.argv.includes("--selftest")) return selfTest();

  const wanted = process.argv[2];
  const alsoDelete = process.argv.includes("--delete");
  if (!wanted) {
    console.error("usage: drain-one-queued.ts <voucherNumber> [--delete]");
    process.exit(2);
  }

  if (!TEST_PREFIXES.some((p) => wanted.toUpperCase().startsWith(p))) {
    console.error(
      `\n  REFUSED. "${wanted}" is not a marked test voucher.\n` +
      `  This script only ever touches numbers starting with: ${TEST_PREFIXES.join(", ")}\n`,
    );
    process.exit(2);
  }

  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) { console.error("SUPABASE_URL / SUPABASE_SERVICE_KEY missing from server/.env"); process.exit(2); }
  const db = createClient(url, key, { auth: { persistSession: false } });

  console.log(`\n  DRAIN ONE — ${wanted}\n  ` + "─".repeat(60));

  const { data: rows, error } = await db
    .from("push_queue").select("*").eq("company", COMPANY).order("created_at", { ascending: false }).limit(50);
  if (error) { console.error("  could not read push_queue:", error.message); process.exit(1); }

  const job = (rows ?? []).find((r) => (r.payload as VoucherPayload)?.voucherNumber === wanted);
  if (!job) { console.error(`  no queued voucher numbered ${wanted}`); process.exit(1); }

  const payload = job.payload as VoucherPayload;
  console.log(`  found queue row ${job.id} — ${payload.voucherType} ${payload.voucherNumber}, status "${job.status}"`);
  console.log(`  remoteId: ${payload.remoteId}`);

  /* A row already marked succeeded is NOT pushed again. Re-running this script
     to re-read or to clean up must never post a second voucher: a Create that
     repeats a REMOTEID already in the books is one of the ways this project has
     made duplicates before, and the read-back below cannot un-make one. */
  if (job.status === "succeeded") {
    console.log("\n  already pushed — not pushing again. Verifying what is in Tally.");
  } else {
    console.log("\n  pushing through safePush (same guard and read-back the agent uses)…");
    const res = await safePush(TALLY, COMPANY, payload);
    console.log(`  → ok=${res.ok}${res.errors?.length ? ` errors=${res.errors.join(" · ")}` : ""}`);
    if (!res.ok) {
      await setStatus(db, job.id, { status: "failed", last_error: (res.errors ?? []).join(" · ") });
      process.exit(1);
    }
    await setStatus(db, job.id, { status: "succeeded", pushed_at: new Date().toISOString() });
  }

  console.log("\n  asking TALLY whether it is there…");
  const raw = await readBackFromTally(wanted);
  const { count: found, data } = vouchersIn(raw);

  console.log(`  vouchers matching ${wanted} in Tally: ${found}`);
  console.log(`  type=${field(data, "VOUCHERTYPENAME")}  masterId=${field(data, "MASTERID")}`);
  console.log(`  date=${field(data, "DATE")}  deleted=${field(data, "ISDELETED")}`);
  console.log(`  party=${field(data, "PARTYLEDGERNAME")}`);
  console.log(`  narration=${field(data, "NARRATION")}`);
  for (const e of data.match(/<ALLLEDGERENTRIES\.LIST>[\s\S]*?<\/ALLLEDGERENTRIES\.LIST>/gi) ?? []) {
    console.log(`    ${field(e, "LEDGERNAME")}  ${field(e, "AMOUNT")}`);
  }

  if (found !== 1) {
    console.error(`\n  EXPECTED EXACTLY ONE. ${found} found — a duplicate here means an Alter became a Create.`);
    process.exit(1);
  }
  console.log("\n  ✓ Tally holds exactly one voucher with this number.");

  if (alsoDelete) {
    console.log("\n  removing it again…");
    await deleteFromTally(payload);
    const after = await readBackFromTally(wanted);
    const left = vouchersIn(after).count;
    console.log(`  vouchers left in Tally: ${left}`);
    const { error: delErr } = await db.from("push_queue").delete().eq("id", job.id);
    if (delErr) throw new Error(`Tally is clean but the queue row survived: ${delErr.message}`);
    console.log("  queue row removed.");
    if (left !== 0) { console.error("  STILL PRESENT — clean it up by hand."); process.exit(1); }
    console.log("\n  ✓ the books are as they were.");
  } else {
    console.log("\n  LEFT IN TALLY on purpose. Re-run with --delete to remove it.");
  }
}

main().catch((e) => { console.error("\n  failed:", e instanceof Error ? e.message : e); process.exit(1); });
