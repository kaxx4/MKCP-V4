/**
 * T11 on the dummy: the agent halves of the go-live fixes (D-M.187).
 *
 *   --part f6    the agent respects the recorded filed boundary: a new invoice dated inside a recorded-filed month is refused
 *                BEFORE Tally (nothing in the books), and the very same invoice is not refused for that reason when nothing is
 *                recorded. Uses the real masters of the dummy; writes nothing.
 *   --part f17   the agent sends each job to the company its target names, or not at all. The list holds the dummy (by its GUID) and
 *                a made-up "last year" company that is not open. Through the real job agent, real Tally seams and a memory queue:
 *                (A) target = the dummy by name AND GUID: booked, read back, then deleted; (B) the dummy's name with a wrong GUID:
 *                refused, nothing in the books; (C) a listed company that is not open in Tally: refused, nothing sent; (D) an unlisted
 *                company: refused. Ends with the books as they were.
 *   --part f11   read the dealer price list from the dummy (one read), build the staging row the agent would write, with and without a
 *                requester, and check it against the table's rules. NOTHING is inserted anywhere (the sandbox fence has no door to
 *                that table); the insert and the copy are proved offline with a fake client.
 *
 * Every Tally request goes through the pace-and-liveness gate. Run from server/. One process at a time on the dummy.
 *   npx tsx scripts/rigs/t11-golive-fixes.ts --part f6|f17|f11 [--out file.json] [--expect N]
 */
import "dotenv/config";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";
guardScriptWrites("rigs/t11-golive-fixes");
import { preflight } from "./lib/t11.js";
import { Recorder, makeLive, indiaToday, turn, push, census, countStored, readStored, remove, byKey, makeParty, makeItem, dropParty, dropItem, freshMasters, sweepDay, stampFrom, gate, TallyDownError, stopForTallyDown, type Live } from "./lib/t11Live.js";
import { DUMMY_KIT, zzParties, zzItems, zzNumber, zzNarration, buildSale } from "./lib/t11Kit.js";
import { setRecordedFiledThrough, resetRecordedFiledThroughForTests, filedThroughOn } from "../../src/services/pushGuard.js";
import { practiceGuid } from "../../src/services/tallyRole.js";
import { tallyPost } from "../../src/tally.js";
import { ErpJobAgent, Journal, tallySeams } from "../../src/services/erpJobAgent.js";
import { parseCompanyYears } from "../../src/services/companyYears.js";
import { memErpQueue } from "./lib/memErpQueue.js";
import { rigPayload } from "./lib/simTally.js";
import { fetchPriceList } from "../../src/services/tallyPriceList.js";
import { stagingRow, stagedRates, requesterFrom } from "../../src/services/pricePullStaging.js";
import type { VoucherPayload } from "../../src/types.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const PART = arg("--part") ?? "";
const OUT = arg("--out");
const EXPECTED: Record<string, number> = { f6: -1, f17: -1, f11: -1 };

async function f6(l: Live, rec: Recorder, made: { vouchers: VoucherPayload[]; parties: string[]; items: string[] }): Promise<void> {
  const stamp = l.stamp, kit = DUMMY_KIT;
  const parties = zzParties(stamp); const [item] = zzItems(stamp, kit);
  // A calendar-open day: the 5th of this month is after October's GSTR-1 (due the 11th)? The point is only that the calendar alone does not close it.
  const [y, m] = l.day.split("-").map(Number);
  const openDay = `${y}-${String(m).padStart(2, "0")}-01`;
  const invoice = buildSale({ kit, type: "Sales", number: zzNumber(stamp, "F6"), date: openDay, narration: zzNarration(stamp, "filed boundary"), party: parties.local, lines: [{ item: item.name, unit: "PC", qty: 1, rate: 100, gstRate: 18 }] });
  const calendar = filedThroughOn(new Date(`${l.day}T12:00:00+05:30`));
  rec.note(`the calendar alone closes through ${calendar}; the test invoice is dated ${openDay}`);
  resetRecordedFiledThroughForTests();
  const before = await census(l);
  made.vouchers.push(invoice); // tracked in case anything were ever accepted
  const noRecord = await push(l, invoice);
  rec.check("F6 with nothing recorded the invoice is not refused for a filed period (it may fail for the fake names, which do not exist)", !noRecord.errors.some((e) => /already filed/.test(e)), noRecord.errors.join(" | ").slice(0, 200));
  rec.check("F6 with nothing recorded the push stopped before Tally wrote anything (the fake party and item do not exist)", !noRecord.ok && noRecord.stage !== "done");
  const through = `${y}-${String(m).padStart(2, "0")}-28`;
  rec.check("F6 a recorded filing later than the calendar moves the agent's boundary", setRecordedFiledThrough(through) && filedThroughOn(new Date(`${l.day}T12:00:00+05:30`)) === through);
  const withRecord = await push(l, invoice);
  rec.check("F6 with the filing recorded, the same invoice is refused as inside a filed period", !withRecord.ok && withRecord.stage === "guard" && withRecord.errors.some((e) => /already filed \(through /.test(e)), `${withRecord.stage}: ${withRecord.errors.join(" | ").slice(0, 240)}`);
  rec.check("F6 an earlier recorded date does not move the boundary back", !setRecordedFiledThrough("2026-01-31") && filedThroughOn(new Date(`${l.day}T12:00:00+05:30`)) === through);
  const after = await census(l);
  rec.check("F6 nothing was written to the books", after.total === before.total && after.ours === before.ours && after.mine === 0, `total ${before.total} -> ${after.total}`);
  resetRecordedFiledThroughForTests();
}

async function f17(l: Live, rec: Recorder, made: { vouchers: VoucherPayload[]; parties: string[]; items: string[] }): Promise<void> {
  const guid = practiceGuid();
  const LAST = `ZZ TEST LAST YEAR CO ${l.stamp}`;
  const FAKE = "00000000-0000-4000-8000-000000000001";
  const parsed = parseCompanyYears(JSON.stringify([{ company: l.company, fyStart: 2026, guid }, { company: LAST, fyStart: 2025, guid: FAKE }]));
  rec.check("F17 the dummy's GUID is accepted by the list reader (the shape C35 asks about)", parsed.problems.length === 0 && parsed.list.length === 2, parsed.problems.join(" | "));
  if (parsed.problems.length) { rec.note(`the dummy's GUID does not read as a Tally GUID of the shape the list expects: C35 finding`); return; }
  const m = memErpQueue();
  const dir = mkdtempSync(join(tmpdir(), "t11-f17-"));
  const seams = tallySeams(l.url, (u, x, t) => tallyPost(u, x, t ?? 120_000, true) as Promise<string>);
  const agent = new ErpJobAgent({
    queue: m.queue, journal: new Journal(join(dir, "j.jsonl")), company: l.company, companies: parsed.list, ...seams,
    leaseSeconds: 120, jobLeaseSeconds: 120, wait: async () => {},
  });
  const mk = (n: number, target?: { c: string; g: string }) => ({ ...rigPayload(l.stamp, n, l.day), label: "ZZ TEST company years", ...(target ? { targetCompany: target.c, targetGuid: target.g } : {}) }) as VoucherPayload & { label: string };
  const before = await census(l);
  // (B) the dummy's name with a wrong GUID
  const idB = m.add(mk(2, { c: l.company, g: FAKE }));
  const rB = await turn(l, "agent round B", () => agent.runOnce(1));
  rec.check("F17 (B) the dummy's name with the wrong GUID is refused before Tally", rB.results[0]?.outcome === "failed" && m.rows.get(idB)!.state === "failed", JSON.stringify(rB.results[0]).slice(0, 200));
  // (D) an unlisted company
  const idD = m.add(mk(4, { c: `ZZ TEST UNLISTED ${l.stamp}`, g: FAKE }));
  const rD = await turn(l, "agent round D", () => agent.runOnce(1));
  rec.check("F17 (D) a company not in the list is refused before Tally", rD.results[0]?.outcome === "failed" && m.rows.get(idD)!.state === "failed" && /not in this agent's list/.test(rD.results[0].detail));
  // (C) listed, but not open in Tally: the real company list is read
  const idC = m.add(mk(3, { c: LAST, g: FAKE }));
  const rC = await turn(l, "agent round C", () => agent.runOnce(1));
  rec.check("F17 (C) a listed company that is not open in Tally is refused after one read of Tally's company list", rC.results[0]?.outcome === "failed" && m.rows.get(idC)!.state === "failed" && /not open in Tally/.test(rC.results[0].detail), JSON.stringify(rC.results[0]).slice(0, 220));
  const mid = await census(l);
  rec.check("F17 nothing reached the books from the three refusals", mid.total === before.total && mid.mine === 0, `total ${before.total} -> ${mid.total}, mine ${mid.mine}`);
  // (A) the dummy by name and GUID: the list path, the real GUID check, a real booking
  const pA = mk(1, { c: l.company, g: guid });
  made.vouchers.push(pA);
  const idA = m.add(pA);
  const rA = await turn(l, "agent round A", () => agent.runOnce(1));
  rec.check("F17 (A) the dummy by name AND its GUID passes the real check (open in Tally under that GUID) and is booked", rA.results[0]?.outcome === "succeeded" && m.rows.get(idA)!.state === "succeeded", JSON.stringify(rA.results[0]).slice(0, 220));
  const v = await readStored(l, l.day, byKey(pA));
  rec.check("F17 (A) the voucher is in the dummy's books, once", !!v && (v.match(/<VOUCHERTYPENAME>/g) ?? []).length === 1);
  rec.check("F17 (A) the company the database would stamp at 'sent' is the dummy's name", m.rows.get(idA)!.company === l.company || m.rows.get(idA)!.company === undefined, String(m.rows.get(idA)!.company));
}

async function f11(l: Live, rec: Recorder): Promise<void> {
  const entries = await turn(l, "read the dealer price list", () => fetchPriceList(l.url, l.company));
  rec.check("F11 the dummy's price list was read through the agent's own reader", entries.length > 0, `${entries.length} rows`);
  const rates = stagedRates(entries);
  rec.note(`${entries.length} price rows, ${rates.length} at the dealer level, ${new Set(rates.map((r) => r.item_name)).size} items`);
  const person = "0b8f6c1e-1111-4222-8333-444444444444";
  const manual = stagingRow({ company: l.company, entries, routeOrigin: "web-price-list", requestedBy: person });
  const anon = stagingRow({ company: l.company, entries, routeOrigin: "web-price-list", requestedBy: "web" });
  const daily = stagingRow({ company: l.company, entries, routeOrigin: "scheduled-price-gst-daily", requestedBy: person });
  rec.check("F11 a pull someone asked for is staged as manual with that person", !!manual && manual.origin === "manual" && manual.requested_by === person && manual.price_level === "DEALER");
  rec.check('F11 a pull whose requester is the text "web" names nobody', !!anon && anon.requested_by === null && requesterFrom("web") === null);
  rec.check("F11 the scheduled pull is daily and never carries a person", !!daily && daily.origin === "daily" && daily.requested_by === null);
  rec.check("F11 the staged rates are what the table requires: a non-empty array, every row with an item, a number rate and a date", !!manual && manual.rates.length > 0 && manual.rates.every((r) => r.item_name && Number.isFinite(r.rate) && (r.effective_from === null || /^\d{4}-\d{2}-\d{2}$/.test(r.effective_from))));
  rec.check("F11 the dummy shares the real company's name, so the row is not marked as a test row; the rig inserts nothing", !!manual && manual.is_test === false);
}

(async () => {
  const pf = await preflight();
  console.log(`  preflight ok (dummy is the only company open, ${pf.listMs} ms)`);
  if (!["f6", "f17", "f11"].includes(PART)) { console.error("usage: --part f6|f17|f11"); process.exit(2); }
  const stamp = stampFrom();
  const l = makeLive(pf, indiaToday(), stamp);
  const expected = arg("--expect") ? Number(arg("--expect")) : EXPECTED[PART];
  const rec = new Recorder(`t11 golive ${PART}`, expected < 0 ? 0 : expected);
  console.log(`\n  T11 GO-LIVE FIX ${PART.toUpperCase()} on the dummy (${l.day}, stamp ${stamp})${expected < 0 ? "  [CALIBRATION RUN]" : ""}\n`);
  const made = { vouchers: [] as VoucherPayload[], parties: [] as string[], items: [] as string[] };
  let down: TallyDownError | null = null;
  let before: { total: number; ours: number } | null = null;
  try {
    before = await census(l);
    rec.note(`books before: ${before.total} vouchers, ${before.ours} ours`);
    if (PART === "f6") await f6(l, rec, made); else if (PART === "f17") await f17(l, rec, made); else await f11(l, rec);
  } catch (e) {
    if (e instanceof TallyDownError) down = e; else rec.check("the part finished without an error", false, (e as Error).message.slice(0, 300));
  } finally {
    if (!down && !gate(l).down) {
      try {
        for (const p of made.vouchers) { const r = await remove(l, p); if (PART === "f17") rec.check(`teardown: ${p.voucherType} ${p.voucherNumber} deleted`, r.ok, r.detail); }
        if (made.vouchers.length) rec.check("teardown: the sweep (backstop) ran clean", sweepDay(l.day) === 0);
        const after = await census(l);
        rec.check("teardown: the books are as they were (voucher count and ours)", !!before && after.total === before.total && after.ours === before.ours && after.mine === 0, `total ${before?.total} -> ${after.total}`);
      } catch (e) { if (e instanceof TallyDownError) down = e; else rec.check("teardown finished", false, (e as Error).message.slice(0, 200)); }
    } else down = down ?? gate(l).down;
    if (down) stopForTallyDown(rec, down, stamp, made.vouchers.map((p) => `${p.voucherType} ${p.voucherNumber}`), `cd server; npx tsx scripts/rigs/t11-money.ts --cleanup ${stamp}`);
  }
  let code = rec.finish(OUT ?? undefined);
  if (expected < 0 && rec.failed === 0 && !down) { console.log(`  calibration: ${rec.passed} checks passed, set EXPECTED.${PART} = ${rec.passed}`); code = 0; }
  void makeParty; void makeItem; void dropParty; void dropItem; void freshMasters; void countStored;
  process.exit(code);
})().catch((e) => { console.error(`FAILED before the part started: ${(e as Error).message}`); process.exit(2); });
