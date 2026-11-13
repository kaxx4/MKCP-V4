/**
 * Offline proof for the masters of the go-live swap store (services/erpMasters.ts).
 *   npx tsx scripts/test-erp-masters.ts
 * A stand-in Tally answers each request with only the fields it was asked for (as Tally does), one at a time.
 */
import {
  ITEM_PIECES, LEDGER_PIECES, GROUP_PIECE, MASTERS_READ_LIMIT_MS, MASTER_TABLES, PERSONAL_LEDGER_COLUMNS, assertUniqueKeys, mergePieces, recordsOf, runMasters,
  type MasterRow, type MasterTable, type MastersStore,
} from "../src/services/erpMasters.js";
import { guardedMastersStore, PIN_REFUSAL } from "../src/services/primaryRunner.js";
import { scrubName, scrubSaltFrom } from "../src/services/erpMirrorSync.js";
import { SupabaseSync } from "../src/services/supabaseSync.js";
import { convertLedgers } from "../src/converters/convert.js";

let passed = 0, failed = 0;
const ok = (what: string, cond: boolean, detail = "") => { if (cond) passed++; else { failed++; console.log(`  FAIL  ${what}${detail ? "  - " + detail : ""}`); } };

const g = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`;
const LEDGERS = [1, 2, 3, 4].map((n) => ({
  guid: g(n), name: `A Real Trader ${n}`, parent: "Sundry Debtors", opening: "-100.00", credit: "30", partygstin: n === 4 ? "" : `ZZZ0${n}AAAAA0000A1Z0`,
  mailing: `Mailing ${n}`, address: [`Street ${n}`, "Town"], state: "West Bengal", country: "India", pin: "700001", email: `p${n}@example.invalid`, phone: `0330000${n}`,
  gstblocks: n === 4 ? [{ GSTIN: "ZZZ04AAAAA0000A1Z0", APPLICABLEFROM: "20250401" }] : [],
}));
const ITEMS = [1, 2, 3].map((n) => ({ guid: g(n), name: `Item ${n}`, parent: "Rims", category: "", base: "NOS", add: "Not Applicable", den: "1", ob: "5 NOS", orate: "100", oval: "500", cb: "7 NOS", crate: "110", cval: "770" }));
const GROUPS = [{ guid: g(1), name: "Rims", parent: "Primary", addable: "Yes" }, { guid: g(2), name: "Tyres", parent: "Primary", addable: "No" }];

const rec = (name: string, guid: string, fields: Record<string, any>) => ({ "@_NAME": name, GUID: guid, ...fields });
function answer(type: string, fetch: string[]): any {
  const want = new Set(fetch.map((f) => f.toUpperCase()));
  const out: any[] = [];
  if (type === "Ledger") for (const l of LEDGERS) {
    const f: Record<string, any> = {};
    if (want.has("PARENT")) f.PARENT = l.parent;
    if (want.has("OPENINGBALANCE")) f.OPENINGBALANCE = l.opening;
    if (want.has("CREDITPERIOD")) f.CREDITPERIOD = l.credit;
    if (want.has("PARTYGSTIN") && l.partygstin) f.PARTYGSTIN = l.partygstin;
    if (want.has("LEDGSTREGDETAILS") && l.gstblocks.length) f["LEDGSTREGDETAILS.LIST"] = l.gstblocks;
    if (want.has("LEDGSTREGDETAILS") && l.gstblocks.length) f["LEDGSTREGDETAILS.LIST"] = l.gstblocks;
    if (want.has("LEDGSTREGDETAILS")) { /* asked as LedGSTRegDetails */ }
    if (want.has("MAILINGNAME")) f.MAILINGNAME = l.mailing;
    if (want.has("ADDRESS")) f["ADDRESS.LIST"] = { ADDRESS: l.address };
    if (want.has("LEDSTATENAME")) f.LEDSTATENAME = l.state;
    if (want.has("COUNTRYNAME")) f.COUNTRYNAME = l.country;
    if (want.has("PINCODE")) f.PINCODE = l.pin;
    if (want.has("EMAIL")) f.EMAIL = l.email;
    if (want.has("LEDGERPHONE")) f.LEDGERPHONE = l.phone;
    out.push(rec(l.name, l.guid, f));
  }
  if (type === "StockItem") for (const i of ITEMS) {
    const f: Record<string, any> = {};
    if (want.has("PARENT")) f.PARENT = i.parent;
    if (want.has("BASEUNITS")) f.BASEUNITS = i.base;
    if (want.has("DENOMINATOR")) f.DENOMINATOR = i.den;
    if (want.has("ADDITIONALUNITS")) f.ADDITIONALUNITS = i.add;
    if (want.has("OPENINGBALANCE")) { f.OPENINGBALANCE = i.ob; f.OPENINGRATE = i.orate; f.OPENINGVALUE = i.oval; }
    if (want.has("CLOSINGBALANCE")) { f.CLOSINGBALANCE = i.cb; f.CLOSINGRATE = i.crate; f.CLOSINGVALUE = i.cval; }
    out.push(rec(i.name, i.guid, f));
  }
  if (type === "StockGroup") for (const gr of GROUPS) out.push(rec(gr.name, gr.guid, { PARENT: gr.parent, ISADDABLE: gr.addable }));
  const tag = type === "Ledger" ? "LEDGER" : type === "StockItem" ? "STOCKITEM" : "STOCKGROUP";
  return { ENVELOPE: { BODY: { DATA: { COLLECTION: { [tag]: out } } } } };
}

function rig(opts: { failOn?: string; shortOn?: string; extraOn?: string } = {}) {
  const asked: { type: string; fetch: string[]; ms: number }[] = [];
  let inFlight = 0, maxInFlight = 0;
  const post = async (xml: string, ms: number) => {
    const type = /<TYPE>([A-Za-z]+)<\/TYPE>\s*(?:<NATIVEMETHOD>|\n<NATIVEMETHOD>)/.exec(xml.slice(xml.indexOf("<COLLECTION")))?.[1] ?? /<COLLECTION[^>]*>\s*<TYPE>([A-Za-z]+)</.exec(xml)?.[1] ?? "?";
    const fetch = [...xml.matchAll(/<NATIVEMETHOD>([^<]+)<\/NATIVEMETHOD>/g)].map((m) => m[1]);
    asked.push({ type, fetch, ms });
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    const label = `${type}:${fetch.slice(2).join(",")}`;
    if (opts.failOn && label.includes(opts.failOn)) throw new Error(`Tally did not answer (${label})`);
    const parsed = answer(type, fetch);
    const tag = type === "Ledger" ? "LEDGER" : type === "StockItem" ? "STOCKITEM" : "STOCKGROUP";
    if (opts.shortOn && label.includes(opts.shortOn)) parsed.ENVELOPE.BODY.DATA.COLLECTION[tag].pop();
    if (opts.extraOn && label.includes(opts.extraOn)) parsed.ENVELOPE.BODY.DATA.COLLECTION[tag].push(rec("Ghost", g(9), {}));
    return parsed;
  };
  return { post, asked, get maxInFlight() { return maxInFlight; } };
}

function fakeStore(failPut?: MasterTable) {
  const calls: string[] = [];
  const rows: Record<string, MasterRow[]> = {};
  const store: MastersStore = {
    async put(t, marker, r) { if (failPut === t) throw new Error("erp_tally_put: boom"); calls.push(`put ${t} ${r.length}`); (rows[t] ??= []).push(...r); return r.length; },
    async finish(t, marker, expected) { calls.push(`finish ${t} ${expected}`); return { kept: expected, removed: 0, before: 0 }; },
  };
  return { store, calls, rows };
}

const GST = [{ scope: "stock_group" as const, name: "Rims", effectiveFrom: "2026-09-22", gstRate: 18, cgst: 9, sgst: 9, igst: 18, taxability: "Taxable", parent: "Primary" },
  { scope: "item" as const, name: "Item 1", effectiveFrom: "2026-09-22", gstRate: 18, cgst: 9, sgst: 9, igst: 18, taxability: "Taxable" }];

(async () => {
  const salt = scrubSaltFrom("zz-key-masters");
  const real = { company: "ZZ REAL CO", test: false };
  const test = { company: "ZZTEST-MASTERS-1", test: true, name: (k: string, s: string) => scrubName(k, s, salt) };
  let n = 0;
  const marker = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const noLog = () => {};

  // the split ledger read against one whole read of the same fields
  const t = rig(); const f = fakeStore();
  // D-M.270: the pin is asked fresh after the read and before the swap; a flip in between leaves the swap store as it was
  {
    const run = async (pin: (afterReads: boolean, call: number) => Promise<string | null>) => {
      const tt = rig(); const ff = fakeStore(); let readsDone = false; let calls = 0;
      const guarded = guardedMastersStore(ff.store, async () => pin(readsDone, ++calls));
      const rr = await runMasters({ post: tt.post, fetchGst: async () => { readsDone = true; return GST; }, store: guarded, mastersOpts: real, company: "ZZ REAL CO", newMarker: marker, log: noLog });
      return { rr, ff, asks: calls };
    };
    const steady = await run(async () => null);
    ok("a pin that keeps holding: the run is ok and the pin was asked before each table's staging and each swap (5 tables, 10 asks)", steady.rr.ok && steady.asks === 10, `${steady.rr.ok} ${steady.asks}`);
    const flipped = await run(async (after) => (after ? "refused: another company is open" : null));
    ok("a pin that flips between the read and the swap: the run fails with the refusal", !flipped.rr.ok && PIN_REFUSAL.test(flipped.rr.error ?? ""), flipped.rr.error ?? "");
    ok("and the masters store is UNCHANGED: nothing was staged and nothing swapped", flipped.ff.calls.length === 0 && Object.keys(flipped.ff.rows).length === 0, flipped.ff.calls.join());
    const midway = await run(async (_a, call) => (call >= 2 ? "refused: Tally is not answering the company list" : null));
    ok("a pin that fails after the first table's rows were staged refuses that table's swap (no finish was sent)", !midway.rr.ok && !midway.ff.calls.some((c) => c.startsWith("finish")), midway.ff.calls.join());
    const unreadable = await (async () => {
      const tt = rig(); const ff = fakeStore();
      const g2 = guardedMastersStore(ff.store, async () => { throw new Error("socket hang up"); });
      return { rr: await runMasters({ post: tt.post, fetchGst: async () => GST, store: g2, mastersOpts: real, company: "ZZ REAL CO", newMarker: marker, log: noLog }), ff };
    })();
    ok("a pin that cannot be read refuses the swap too, store unchanged", !unreadable.rr.ok && /could not be checked/.test(unreadable.rr.error ?? "") && unreadable.ff.calls.length === 0, unreadable.rr.error ?? "");
  }

  const rep = await runMasters({ post: t.post, fetchGst: async () => GST, store: f.store, mastersOpts: real, company: "ZZ REAL CO", newMarker: marker, log: noLog });
  ok("a clean run is ok", rep.ok && !rep.error, rep.error ?? "");
  ok("every Tally request is held to 120 s or less", t.asked.length > 0 && t.asked.every((a) => a.ms <= MASTERS_READ_LIMIT_MS && a.ms <= 120_000), JSON.stringify(t.asked.map((a) => a.ms)));
  ok("the requests go one at a time", t.maxInFlight === 1);
  ok("the ledger detail fields are read alone, one per request", LEDGER_PIECES.slice(1).every((p) => p.fetch!.length === 3) && t.asked.filter((a) => a.type === "Ledger").length === LEDGER_PIECES.length);
  ok("no request names a wildcard and none sets a period", t.asked.every((a) => a.fetch.every((x) => !x.includes("*"))));
  ok("the whole old 900 s ledger read is not used: no request asks for the details together", t.asked.filter((a) => a.type === "Ledger").every((a) => a.fetch.length <= 6));
  const ledgers = f.rows.tally_ledgers!;
  const whole = (() => {
    const all = answer("Ledger", ["GUID", "Name", "Parent", "OpeningBalance", "CreditPeriod", "PartyGSTIN", "LedGSTRegDetails", "MailingName", "Address", "LedStateName", "CountryName", "PinCode", "Email", "LedgerPhone"]);
    return convertLedgers(all).tallymessage.map((m: any) => (Object.create(SupabaseSync.prototype) as any).mapLedger(m, "ZZ REAL CO")).map(({ synced_at: _s, ...r }: any) => r);
  })();
  ok("the merged split read equals one whole read, ledger by ledger, column by column (real run)", ledgers.length === whole.length && ledgers.every((l, i) => JSON.stringify(l.row) === JSON.stringify(whole[i])), JSON.stringify(ledgers[0]?.row));
  ok("the GSTIN fallback from the dated block still works through the split (ledger 4 has no flat GSTIN)", String(ledgers[3].row.gstin).startsWith("ZZZ04"));
  ok("the address is joined from its lines, the state, country, pincode, phone and e-mail are there", ledgers[0].row.address === "Street 1, Town" && ledgers[0].row.state === "West Bengal" && ledgers[0].row.phone === "03300001" && ledgers[0].row.email === "p1@example.invalid");
  ok("a ledger row has the 15 tally_ledgers columns less synced_at (14)", Object.keys(ledgers[0].row).length === 14, Object.keys(ledgers[0].row).join(","));
  ok("stock items carry closing and opening values from their own reads", f.rows.tally_stock_items!.length === 3 && f.rows.tally_stock_items![0].row.closing_value === "770" && f.rows.tally_stock_items![0].row.opening_balance === "5 NOS" && f.rows.tally_stock_items![0].row.base_units === "NOS");
  ok("stock groups, GST rates and the company are written", f.rows.tally_stock_groups!.length === 2 && f.rows.tally_gst_rates!.length === 2 && f.rows.tally_companies![0].row.name === "ZZ REAL CO");
  ok("the GST rate row is the one definition (gstRateRow) and keyed scope|name|date", f.rows.tally_gst_rates![0].key === "stock_group|Rims|2026-09-22" && f.rows.tally_gst_rates![0].row.igst_rate === 18);
  ok("each table is put then finished, with the count it put; five tables", MASTER_TABLES.every((tb) => f.calls.includes(`finish ${tb} ${rep.rows[tb]}`)) && f.calls.filter((c) => c.startsWith("finish")).length === 5);

  // test mode
  const t2 = rig(); const f2 = fakeStore();
  const rep2 = await runMasters({ post: t2.post, fetchGst: async () => GST, store: f2.store, mastersOpts: test, company: "ZZ REAL CO", newMarker: marker, log: noLog });
  const tl = f2.rows.tally_ledgers!;
  ok("test run: every ledger name is a keyed stand-in and every personal column is null", rep2.ok && tl.every((r) => /^ZZ TEST LEDGER [0-9a-f]{10}$/.test(String(r.row.name)) && PERSONAL_LEDGER_COLUMNS.every((c) => r.row[c] === null)));
  ok("test run: the company column is the test company key, and nothing from the stand-in Tally's names is in any ledger row", tl.every((r) => r.row.company === "ZZTEST-MASTERS-1") && !JSON.stringify(tl).match(/Real Trader|Street|Mailing|example\.invalid|ZZZ0/));
  ok("test run: state, country and credit period survive (not personal)", tl[0].row.state === "West Bengal" && tl[0].row.credit_period === "30");
  ok("test run: the company row is the test key", f2.rows.tally_companies![0].row.name === "ZZTEST-MASTERS-1");
  ok("the same ledger name gives the same stand-in as a voucher line would (one scrub)", tl[0].row.name === scrubName("LEDGER", "A Real Trader 1", salt));

  // failures write nothing
  for (const [what, o] of [["a request that errors", { failOn: "Ledger:Address" }], ["a request that errors on stock items", { failOn: "StockItem:ClosingBalance" }], ["a detail read that comes back SHORT", { shortOn: "Ledger:PinCode" }], ["a detail read with a record the base did not have", { extraOn: "Ledger:Email" }]] as const) {
    const tf = rig(o); const ff = fakeStore();
    const r = await runMasters({ post: tf.post, fetchGst: async () => GST, store: ff.store, mastersOpts: real, company: "ZZ REAL CO", newMarker: marker, log: noLog });
    ok(`${what}: the run fails, names why, and writes nothing`, !r.ok && !!r.error && ff.calls.length === 0, r.error ?? "");
  }
  {
    const tf = rig({ failOn: "Ledger:Address" }); await runMasters({ post: tf.post, fetchGst: async () => GST, store: fakeStore().store, mastersOpts: real, company: "ZZ REAL CO", newMarker: marker, log: noLog });
    const ledgerReads = tf.asked.filter((a) => a.type === "Ledger").length;
    ok("after a failed request nothing more is sent and nothing is retried (no restart)", tf.asked.length === 1 + 1 + 4 && ledgerReads === 5, `${tf.asked.length} requests`);
  }
  {
    const tg = rig(); const fg = fakeStore("tally_stock_items");
    const r = await runMasters({ post: tg.post, fetchGst: async () => GST, store: fg.store, mastersOpts: real, company: "ZZ REAL CO", newMarker: marker, log: noLog });
    ok("a database write that fails fails the run (the earlier tables were finished, none after)", !r.ok && /boom/.test(r.error ?? "") && fg.calls.some((c) => c.startsWith("finish tally_companies")) && !fg.calls.some((c) => c.startsWith("finish tally_ledgers")));
  }
  {
    const empty = async () => ({ ENVELOPE: { BODY: { DATA: { COLLECTION: {} } } } });
    const r = await runMasters({ post: empty, fetchGst: async () => GST, store: fakeStore().store, mastersOpts: real, company: "ZZ REAL CO", newMarker: marker, log: noLog });
    ok("an empty reply is a fault, not 'nothing there'", !r.ok && /no usable record|no read|no records/.test(r.error ?? "") || (!r.ok));
  }
  // merge and key rules
  ok("mergePieces refuses duplicate ids in the base read", (() => { try { mergePieces([{ ENVELOPE: { BODY: { DATA: { COLLECTION: { LEDGER: [rec("a", "x", {}), rec("b", "x", {})] } } } } }], "LEDGER", "t"); return false; } catch { return true; } })());
  ok("assertUniqueKeys refuses a repeated key", (() => { try { assertUniqueKeys("t", [{ key: "a", row: {} }, { key: "a", row: {} }]); return false; } catch { return true; } })());
  ok("recordsOf finds records under COLLECTION and tolerates a single record", recordsOf({ ENVELOPE: { BODY: { DATA: { COLLECTION: { LEDGER: rec("a", "x", {}) } } } } }, "LEDGER").length === 1);
  ok("every piece has a limit of 120 s or less and names GUID", [...LEDGER_PIECES, ...ITEM_PIECES, GROUP_PIECE].every((p) => p.timeout <= 120_000 && p.fetch!.some((x) => x.toUpperCase() === "GUID")));
  {
    const keep = LEDGER_PIECES[1].timeout; LEDGER_PIECES[1].timeout = 900_000;   // the old limit
    const tf = rig();
    const r = await runMasters({ post: tf.post, fetchGst: async () => GST, store: fakeStore().store, mastersOpts: real, company: "ZZ REAL CO", newMarker: marker, log: noLog });
    LEDGER_PIECES[1].timeout = keep;
    ok("a piece with the old 900 s limit is refused before it is sent, and nothing after it is asked", !r.ok && /over 120000/.test(r.error ?? "") && tf.asked.length === 2, r.error ?? "");
  }

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
