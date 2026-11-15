/**
 * D-M.279, offline: the two guards of the mirror's day windows (services/mirrorGuards.ts, wired in erpMirrorSync.ts and primaryRunner.ts).
 *
 *   1. A full run reads FORWARD days too. The fault it ends: the office re-dated open Sales Order Notes to a later day (16-Nov); the window ended at
 *      today, the old day read without them, and the prune removed them with the new day never read. Shown here BEFORE (a window that ends today
 *      loses the note) and AFTER (the forward window keeps it), through the real runMirrorSync against a store that prunes like the database does.
 *   2. A voucher type the mirror holds for a window that the read holds none of, while it holds other types, is not pruned: the run is held, an alarm
 *      is raised (kind and reason), journalled and shown on the status. The same helper guards the nightly day check. A normal single deletion
 *      still prunes.
 *
 * No Tally, no database: a fake Tally and a fake store that applies the database's swap rules (full: upsert in scope, delete in-scope rows not staged;
 * incremental: upsert in scope, delete rows whose new date is outside the scope).
 *
 *   npx tsx scripts/test-mirror-guards.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMirrorSync, runDayCheck, scrubSaltFrom, type MirrorStore, type MirrorTally, type MirrorRow, type DayCheckVoucher, type SwapResult } from "../src/services/erpMirrorSync.js";
import { mirrorFullScope, vanishedTypes, countByType, pendingVanishAcks, vanishAckFor, MIRROR_FORWARD_DAYS, MIRROR_VANISH_MIN, VANISH_ACK_MAX_AGE_MS } from "../src/services/mirrorGuards.js";
import { PrimaryMirrorLoop, MIRROR_HOLD_HEALTH_AFTER, type MirrorRunners, type MirrorHealthNote } from "../src/services/primaryRunner.js";
import { Journal } from "../src/services/erpJobAgent.js";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
};
const noop = () => {};

interface V { guid: string; date: string; alterid: number; type: string; number: string }
const asTallyVoucher = (v: V) => ({
  guid: v.guid, date: v.date.replace(/-/g, ""), alterid: v.alterid, masterid: v.alterid + 1000, vouchertypename: v.type, vouchernumber: v.number,
  partyledgername: "ZZ TEST DEBTOR", narration: "n", reference: "", iscancelled: false, isoptional: false, effectivedate: v.date.replace(/-/g, ""),
  allledgerentries: [{ ledgername: "ZZ TEST DEBTOR", amount: "-100.00", isdeemedpositive: true }, { ledgername: "SALES", amount: "100.00", isdeemedpositive: false }],
});
const dayOf = (v: V) => v.date;

/** A fake Tally holding `books`. `highest` lists every voucher (any date) with its type, as the real AlterID read does. */
function tallyOf(books: () => V[], today: string): MirrorTally & { reads: string[] } {
  const reads: string[] = [];
  const t = {
    reads,
    async highest() {
      const list = books();
      const byDay: Record<string, number> = {};
      for (const v of list) byDay[v.date] = (byDay[v.date] ?? 0) + 1;
      const vouchers: DayCheckVoucher[] = list.map((v) => ({ k: v.guid, d: v.date, a: v.alterid, t: v.type }));
      return { alterId: Math.max(0, ...list.map((v) => v.alterid)), latestDate: list.map(dayOf).sort().pop() ?? null, count: list.length, byDay, vouchers };
    },
    async vouchersOn(day: string) { reads.push(day); return books().filter((v) => v.date === day).map(asTallyVoucher); },
    async changedSince(mark: number, upTo?: number) { return books().filter((v) => v.alterid > mark && (upTo === undefined || v.alterid <= upTo)).map(asTallyVoucher); },
    async ledgers() { return [{ guid: "L-1", name: "ZZ TEST DEBTOR", parent: "Sundry Debtors", closingbalance: "-100.00", openingbalance: "0", alterid: "7", masterid: "70" }]; },
    async loadedPeriod() { const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)); const s = m >= 4 ? y : y - 1; return { from: `${s}0401`, to: today.replace(/-/g, ""), lastVoucher: today.replace(/-/g, "") }; },
  };
  return t as unknown as MirrorTally & { reads: string[] };
}

/** A store that keeps the mirror's rows and applies the swap the way migrations 0116 and 0118 do. */
function storeOf(initial: { key: string; date: string; type: string }[], opts: { typeCounts?: boolean; scopeIfNone?: { from: string; to: string } } = {}) {
  const rows = new Map(initial.map((r) => [r.key, { ...r }]));
  let staged: MirrorRow[] = [];
  let scope = { from: "", to: "" };
  let kind: "full" | "incremental" | "repull" = "full";
  const log: string[] = [];
  let failed: string | null = null;
  const typeCounts = opts.typeCounts === false ? undefined : async (from: string, to: string) => {
    const out: Record<string, number> = {};
    for (const r of rows.values()) if (r.date >= from && r.date <= to) out[r.type] = (out[r.type] ?? 0) + 1;
    return out;
  };
  const store: MirrorStore = {
    isTest: false, scrubSalt: null,
    async start(k, sc) { kind = k; scope = sc ?? opts.scopeIfNone ?? { from: "2026-04-01", to: "2026-11-15" }; staged = []; log.push(`start ${k} ${scope.from}..${scope.to}`); return { run_id: "R1", scope_from: scope.from, scope_to: scope.to, mark: k === "full" ? null : 5 }; },
    async step() {},
    async stage(_r, r) { staged.push(...r); return staged.length; },
    async swap(): Promise<SwapResult> {
      log.push("swap");
      const inScope = (d: string | null) => !!d && d >= scope.from && d <= scope.to;
      for (const s of staged) if (inScope(s.voucher_date)) rows.set(s.key, { key: s.key, date: s.voucher_date!, type: s.voucher_type ?? "" });
      if (kind === "full") {
        const keys = new Set(staged.map((s) => s.key));
        for (const [k, r] of [...rows]) if (inScope(r.date) && !keys.has(k)) rows.delete(k);
      } else {
        for (const s of staged) if (!inScope(s.voucher_date)) rows.delete(s.key);
      }
      return { state: "swapped" } as SwapResult;
    },
    async fail(_r, e) { failed = e; log.push("fail"); },
    async stageLedgers() { return 1; },
    async repullStart() { return null; },
    async checkDays(hi, v) { log.push(`check ${v.length} ${JSON.stringify(Object.keys(v[0] ?? {}))}`); return { state: "ok" }; },
    async lastFullRun() { return null; },
    async acceptedRuns() { return []; },
    async swapAccepted() { return { state: "swapped" } as SwapResult; },
    ...(typeCounts ? { typeCounts } : {}),
  };
  return { store, rows, log, get failed() { return failed; } };
}

(async () => {
  console.log("\n  the forward window (pure)");
  {
    const s = mirrorFullScope("2026-11-15");
    ok(`on 15-Nov-2026 the window runs from the year's 1 April to ${MIRROR_FORWARD_DAYS} days ahead`, s.from === "2026-04-01" && s.to === "2026-12-30", JSON.stringify(s));
    ok("the forward reach is one documented constant, 45", MIRROR_FORWARD_DAYS === 45);
    ok("near the year's end it stops at 31 March (Tally takes nothing beyond the year)", mirrorFullScope("2027-02-20").to === "2027-03-31" && mirrorFullScope("2027-03-31").to === "2027-03-31");
    ok("on 1 April a new year starts, with its own forward reach", JSON.stringify(mirrorFullScope("2027-04-01")) === JSON.stringify({ from: "2027-04-01", to: "2027-05-16" }));
    const widest = ["2026-04-01", "2026-12-01", "2027-02-15", "2027-03-31"].map(mirrorFullScope).every((w) => (Date.parse(w.to) - Date.parse(w.from)) / 86_400_000 <= 366);
    ok("the window never exceeds the database's limit of a year", widest);
    let threw = false; try { mirrorFullScope("15-11-2026"); } catch { threw = true; }
    ok("a date that is not YYYY-MM-DD is refused", threw);
  }

  console.log("\n  a Sales Order Note re-dated from 14-Nov to 16-Nov (today is 15-Nov)");
  {
    const today = "2026-11-15";
    const sales: V = { guid: "S-1", date: "2026-11-10", alterid: 10, type: "Sales", number: "26-27/0010" };
    const noteBefore: V = { guid: "N-1", date: "2026-11-14", alterid: 11, type: "Sales Order Note", number: "SO-1" };
    const noteAfter: V = { ...noteBefore, date: "2026-11-16", alterid: 12 };
    const mirrorNow = [{ key: "S-1", date: "2026-11-10", type: "Sales" }, { key: "N-1", date: "2026-11-14", type: "Sales Order Note" }];

    // BEFORE: a window that ends today (what the live sync read)
    const old = storeOf(mirrorNow, { typeCounts: false });
    await runMirrorSync({ store: old.store, tally: tallyOf(() => [sales, noteAfter], today), kind: "full", scope: { from: "2026-04-01", to: today }, today, log: noop });
    ok("BEFORE the fix (window ends today, no type guard): the re-dated note is pruned off its old day and its new day is never read: it is gone", !old.rows.has("N-1"), [...old.rows.keys()].join());
    const threeNow = [...mirrorNow, { key: "N-2", date: "2026-11-14", type: "Sales Order Note" }, { key: "N-3", date: "2026-11-14", type: "Sales Order Note" }];
    const threeAfter: V[] = [sales, noteAfter, { ...noteAfter, guid: "N-2" }, { ...noteAfter, guid: "N-3" }];
    const guarded = storeOf(threeNow);
    const gRep = await runMirrorSync({ store: guarded.store, tally: tallyOf(() => threeAfter, today), kind: "full", scope: { from: "2026-04-01", to: today }, today, log: noop });
    ok("even with the old window, when 3 or more notes are re-dated at once the type guard holds that prune and alarms", gRep.state === "refused" && guarded.rows.has("N-1") && gRep.alarms?.[0]?.type === "Sales Order Note");
    const one = storeOf(mirrorNow);
    await runMirrorSync({ store: one.store, tally: tallyOf(() => [sales, noteAfter], today), kind: "full", scope: { from: "2026-04-01", to: today }, today, log: noop });
    ok("one or two notes re-dated with the old window are NOT held by the guard (a deletion like any other): only the forward window protects them", !one.rows.has("N-1"));

    // AFTER: the default full window reaches forward
    const fresh = storeOf(mirrorNow);
    const tl = tallyOf(() => [sales, noteAfter], today);
    const rep = await runMirrorSync({ store: fresh.store, tally: tl, kind: "full", today, log: noop });
    ok("AFTER: the default full window ends 45 days ahead", rep.scope?.to === "2026-12-30" && rep.scope?.from === "2026-04-01", JSON.stringify(rep.scope));
    ok("AFTER: the new day (16-Nov) is read, and so is the last forward day", tl.reads.includes("2026-11-16") && tl.reads.includes("2026-12-30"));
    ok("AFTER: the note is still in the mirror, now on its new day", fresh.rows.get("N-1")?.date === "2026-11-16" && fresh.rows.get("S-1")?.date === "2026-11-10", JSON.stringify([...fresh.rows.values()]));
    ok("AFTER: it is on one day only (the old day no longer holds it)", [...fresh.rows.values()].filter((r) => r.type === "Sales Order Note").length === 1);

    // the incremental path: a re-date inside the mark's scope stays, beyond it is dropped (the same fault, one level down)
    const inc = storeOf(mirrorNow, { scopeIfNone: { from: "2026-04-01", to: "2026-12-30" } });
    await runMirrorSync({ store: inc.store, tally: tallyOf(() => [sales, noteAfter], today), kind: "incremental", today, log: noop });
    ok("an incremental whose mark scope reaches forward keeps the re-dated note on its new day", inc.rows.get("N-1")?.date === "2026-11-16", JSON.stringify([...inc.rows.values()]));
    const incOld = storeOf(mirrorNow, { scopeIfNone: { from: "2026-04-01", to: today } });
    await runMirrorSync({ store: incOld.store, tally: tallyOf(() => [sales, noteAfter], today), kind: "incremental", today, log: noop });
    ok("BEFORE: an incremental whose scope ends today deletes the note it just read (moved outside the scope)", !incOld.rows.has("N-1"));
  }

  console.log("\n  a voucher type that reads zero is not pruned, and alarms");
  {
    const today = "2026-11-15";
    const initial = [
      ...[1, 2, 3, 4, 5].map((i) => ({ key: `S-${i}`, date: "2026-11-1" + (i % 3), type: "Sales" })),
      ...[1, 2, 3].map((i) => ({ key: `N-${i}`, date: "2026-11-12", type: "Sales Order Note" })),
    ];
    const salesOnly: V[] = [1, 2, 3, 4, 5].map((i) => ({ guid: `S-${i}`, date: "2026-11-1" + (i % 3), alterid: i, type: "Sales", number: `X/${i}` }));
    const s = storeOf(initial);
    const r = await runMirrorSync({ store: s.store, tally: tallyOf(() => salesOnly, today), kind: "full", today, log: noop });
    ok("the run is held: refused, not swapped, the run is marked failed with the reason", r.state === "refused" && !s.log.includes("swap") && s.log.includes("fail") && /vanished from the read/.test(r.error ?? ""), `${r.state} ${s.log.join()} ${r.error}`);
    ok("the three notes are still in the mirror (nothing was pruned)", [...s.rows.values()].filter((x) => x.type === "Sales Order Note").length === 3 && s.rows.size === 8);
    ok("the alarm names the kind, the type, the rows held and the reason", r.alarms?.length === 1 && r.alarms[0].kind === "type_vanished" && r.alarms[0].type === "Sales Order Note" && r.alarms[0].storeRows === 3 && /whole type missing/.test(r.alarms[0].reason) && r.alarms[0].where === "full", JSON.stringify(r.alarms));

    // a normal single deletion still prunes
    const s2 = storeOf(initial);
    const oneGone: V[] = [...salesOnly, ...[1, 2].map((i) => ({ guid: `N-${i}`, date: "2026-11-12", alterid: 20 + i, type: "Sales Order Note", number: `SO-${i}` }))];
    const r2 = await runMirrorSync({ store: s2.store, tally: tallyOf(() => oneGone, today), kind: "full", today, log: noop });
    ok("a normal single deletion (one note gone, the type still present) still prunes", r2.state === "swapped" && !r2.alarms && s2.rows.size === 7 && !s2.rows.has("N-3"), `${r2.state} ${s2.rows.size}`);
    const s3 = storeOf(initial);
    const allFine: V[] = [...salesOnly, ...[1, 2, 3].map((i) => ({ guid: `N-${i}`, date: "2026-11-12", alterid: 20 + i, type: "SALES ORDER NOTE", number: `SO-${i}` }))];
    const r3 = await runMirrorSync({ store: s3.store, tally: tallyOf(() => allFine, today), kind: "full", today, log: noop });
    ok("the type compares without regard to case (the queue says Sales Order Note, Tally keeps SALES ORDER NOTE)", r3.state === "swapped" && !r3.alarms && s3.rows.size === 8);
    const s4 = storeOf(initial, { typeCounts: false });
    const r4 = await runMirrorSync({ store: s4.store, tally: tallyOf(() => salesOnly, today), kind: "full", today, log: noop });
    ok("a store that cannot count types is not guarded (as before): the run goes through", r4.state === "swapped" && s4.rows.size === 5);
    const s5 = storeOf(initial);
    s5.store.typeCounts = async () => { throw new Error("erp_mirror_rows: permission denied"); };
    const r5 = await runMirrorSync({ store: s5.store, tally: tallyOf(() => salesOnly, today), kind: "full", today, log: noop });
    ok("a count that cannot be read fails the run (a guard that cannot look is not a pass), nothing pruned", r5.state === "failed" && /permission denied/.test(r5.error ?? "") && s5.rows.size === 8, `${r5.state} ${r5.error}`);
    const s6 = storeOf(initial);
    const r6 = await runMirrorSync({ store: s6.store, tally: tallyOf(() => [], today), kind: "full", today, log: noop });
    ok("an EMPTY read is not this guard's to judge (nothing else is present): it goes on to the database's own floors", !r6.alarms);
  }

  console.log("\n  the pure rule");
  {
    const w = { from: "2026-11-01", to: "2026-11-30", where: "full" as const };
    ok("a type the store holds (3 or more) and the pull lacks, with other types present: one alarm", vanishedTypes({ Sales: 4, Receipt: 3 }, { Sales: 6 }, w).length === 1);
    ok("MIRROR_VANISH_MIN is 3: one or two rows of a type going to zero is a normal deletion", MIRROR_VANISH_MIN === 3 && vanishedTypes({ "Sales Order Note": 2, Sales: 4 }, { Sales: 6 }, w).length === 0 && vanishedTypes({ "Sales Order Note": 1, Sales: 4 }, { Sales: 6 }, w).length === 0 && vanishedTypes({ "Sales Order Note": 3, Sales: 4 }, { Sales: 6 }, w).length === 1);
    ok("case and spaces do not matter", vanishedTypes({ "sales order note": 3 }, { "SALES ORDER NOTE ": 1, Sales: 3 }, w).length === 0);
    ok("a pull with nothing at all raises no alarm here", vanishedTypes({ Sales: 4 }, {}, w).length === 0);
    ok("a type the store holds none of raises none", vanishedTypes({ Sales: 4, Receipt: 0 }, { Sales: 1 }, w).length === 0);
    ok("two types gone give two alarms", vanishedTypes({ Sales: 4, Receipt: 3, Payment: 5 }, { Sales: 1 }, w).length === 2);
    ok("an acknowledged type is not held (and is named as released)", vanishedTypes({ Sales: 4, Receipt: 3 }, { Sales: 1 }, w, ["receipt"]).length === 0);
    ok("countByType counts a voucher with no type under one name", JSON.stringify(countByType([{ voucher_type: "Sales" }, { voucher_type: null }, { type: "Sales" }])) === JSON.stringify({ Sales: 2, "(no type)": 1 }));
  }

  console.log("\n  the nightly day check uses the same helper");
  {
    const today = "2026-11-15";
    const initial = [{ key: "S-1", date: "2026-11-10", type: "Sales" }, { key: "N-1", date: "2026-11-12", type: "Sales Order Note" }, { key: "N-2", date: "2026-11-12", type: "Sales Order Note" }, { key: "N-3", date: "2026-11-12", type: "Sales Order Note" }];
    const salesOnly: V[] = [{ guid: "S-1", date: "2026-11-10", alterid: 1, type: "Sales", number: "1" }, { guid: "S-2", date: "2026-11-14", alterid: 2, type: "Sales", number: "2" }];
    const s = storeOf(initial);
    const r = await runDayCheck({ store: s.store, tally: tallyOf(() => salesOnly, today), log: noop });
    ok("the check is refused with an alarm when a whole type is missing from Tally's list, and nothing is stored", r.state === "refused" && r.alarms?.length === 1 && r.alarms[0].where === "day_check" && !s.log.some((l) => l.startsWith("check")), `${r.state} ${s.log.join()}`);
    const books: V[] = [...salesOnly, { guid: "N-1", date: "2026-11-12", alterid: 3, type: "Sales Order Note", number: "SO" }];
    const s2 = storeOf(initial);
    const r2 = await runDayCheck({ store: s2.store, tally: tallyOf(() => books, today), log: noop });
    ok("a normal list goes to the database, and only the key, date and AlterID are sent (never the type)", r2.state === "ok" && s2.log.some((l) => l.startsWith("check 3 ") && l.includes('["k","d","a"]')), s2.log.join());
  }

  console.log("\n  the alarm reaches the status and the journal");
  {
    const dir = mkdtempSync(join(tmpdir(), "mirror-guards-"));
    const journal = new Journal(join(dir, "j.jsonl"));
    const alarm = { kind: "type_vanished" as const, type: "Sales Order Note", storeRows: 3, from: "2026-04-01", to: "2026-12-30", where: "full" as const, reason: "the mirror holds 3 Sales Order Note voucher(s) ..." };
    const runners: MirrorRunners = {
      mirror: async () => ({ state: "refused", error: "refused: 1 voucher type(s) vanished from the read (Sales Order Note)", alarms: [alarm] }),
      check: async () => ({ state: "ok", error: null }), repull: async () => null, accepted: async () => [],
    };
    const loop = new PrimaryMirrorLoop({
      store: { acceptedRuns: async () => [], lastFullRun: async () => null } as unknown as MirrorStore, tally: {} as MirrorTally,
      plan: { hasMark: async () => false, fullDue: async () => false, lastCheckAt: async () => new Date(), queuedRepulls: async () => 0 },
      tickMs: 1000, log: noop, runners, journal,
    });
    const rep = await loop.tick();
    ok("the pass shows the held run", rep.did.some((d) => d.work === "full" && d.state === "refused"));
    ok("/api/primary/status carries the alarm: kind, type, where, reason and when", loop.status.alarms.length === 1 && loop.status.alarms[0].kind === "type_vanished" && loop.status.alarms[0].type === "Sales Order Note" && !!loop.status.alarms[0].at && /3 Sales Order Note/.test(loop.status.alarms[0].reason));
    const j = journal.entries().filter((e) => e.kind === "mirror-alarm") as Array<{ alarm: string; where: string; reason: string }>;
    ok("the journal has it, with the kind and the reason", j.length === 1 && /type_vanished: Sales Order Note/.test(j[0].alarm) && j[0].where === "full" && /3 Sales Order Note/.test(j[0].reason));
    for (let i = 0; i < 25; i++) await loop.tick();
    ok("the status keeps the last 20 alarms only", loop.status.alarms.length === 20);
  }

  console.log("\n  D-M.281: only a mass disappearance holds, and a hold can be released once");
  {
    const today = "2026-11-15";
    const sales: V[] = [1, 2, 3, 4].map((i) => ({ guid: `S-${i}`, date: "2026-11-1" + (i % 3), alterid: i, type: "Sales", number: `X/${i}` }));
    const rowsOf = (n: number) => [...sales.map((v) => ({ key: v.guid, date: v.date, type: v.type })), ...Array.from({ length: n }, (_, i) => ({ key: `N-${i + 1}`, date: "2026-11-12", type: "Sales Order Note" }))];
    // 2 notes deleted: normal
    const two = storeOf(rowsOf(2));
    const r2n = await runMirrorSync({ store: two.store, tally: tallyOf(() => sales, today), kind: "full", today, log: noop });
    ok("2 notes deleted after billing prune normally: swapped, no alarm, the notes gone, the other vouchers still updated", r2n.state === "swapped" && !r2n.alarms && two.rows.size === 4);
    // 5 vanishing: hold + alarm
    const five = storeOf(rowsOf(5));
    const r5 = await runMirrorSync({ store: five.store, tally: tallyOf(() => sales, today), kind: "full", today, log: noop });
    ok("5 notes vanishing hold the swap and alarm, naming the type and the count", r5.state === "refused" && r5.alarms?.[0]?.storeRows === 5 && r5.alarms[0].type === "Sales Order Note" && five.rows.size === 9);
    // ack: exactly one run, through the loop and the journal
    const dir = mkdtempSync(join(tmpdir(), "mirror-ack-"));
    const jpath = join(dir, "j.jsonl");
    const journal = new Journal(jpath);
    const st = storeOf(rowsOf(5));
    const health: MirrorHealthNote[] = [];
    const runners: MirrorRunners = {
      mirror: (store, tally, kind, log, released) => runMirrorSync({ store, tally, kind, today, log, released }),
      check: async () => ({ state: "ok", error: null }), repull: async () => null, accepted: async () => [],
    };
    const loop = new PrimaryMirrorLoop({
      store: st.store, tally: tallyOf(() => sales, today),
      plan: { hasMark: async () => false, fullDue: async () => false, lastCheckAt: async () => new Date(), queuedRepulls: async () => 0 },
      tickMs: 1000, log: noop, runners, journal, health: async (n) => { health.push(n); },
    });
    await loop.tick();
    ok("run 1 is held: one hold on the status, with the type, the count and the release command in one line", loop.status.holds.length === 1 && loop.status.holds[0].type === "Sales Order Note" && loop.status.holds[0].storeRows === 5 && /5 voucher/.test(loop.status.holds[0].line) && /ack-vanish "Sales Order Note"/.test(loop.status.holds[0].line));
    ok("after ONE held run the sync-health signal is not told yet", health.length === 0);
    await loop.tick();
    ok(`after ${MIRROR_HOLD_HEALTH_AFTER} held runs in a row the sync-health signal is told (a failed row for the web's sync log, naming the type)`, health.length === 1 && health[0].syncType === "mirror-held" && /Sales Order Note/.test(health[0].errors[0]) && health[0].counts.held_runs === 2 && health[0].counts.rows === 5);
    await loop.tick();
    ok("a third held run inside the hour does not write another health row", health.length === 1 && loop.status.holds[0].consecutive === 3);
    ok("nothing was pruned while held", st.rows.size === 9);
    // the acknowledgement, written the way the script writes it
    const refused = vanishAckFor(journal.entries() as { kind: string; alarm?: string }[], "Sales Orderr Note", new Date().toISOString());
    ok("an acknowledgement for a type nobody is holding is refused", !refused.ok && /no vanished-type alarm/.test(refused.reason));
    const good = vanishAckFor(journal.entries() as { kind: string; alarm?: string }[], "sales order note", new Date().toISOString());
    ok("an acknowledgement for the held type (any case) is accepted", good.ok);
    if (good.ok) journal.append(good.entry);
    await loop.tick();
    ok("the next run prunes the type: swapped, the notes gone, the hold cleared", st.rows.size === 4 && loop.status.holds.length === 0);
    ok("the acknowledgement is used up (journalled once)", journal.entries().filter((e) => e.kind === "vanish-ack-used").length === 1 && pendingVanishAcks(journal.entries() as { kind: string; type?: string; at?: string }[], Date.now()).length === 0);
    // the type reappears and vanishes again: held again, the old ack does not release it
    for (let i = 1; i <= 4; i++) st.rows.set(`N-${i}`, { key: `N-${i}`, date: "2026-11-12", type: "Sales Order Note" });
    await loop.tick();
    ok("a later vanishing holds again (one acknowledgement released exactly one run)", st.rows.size === 8 && loop.status.holds.length === 1 && loop.status.holds[0].consecutive === 1);
    // a clean run clears a hold
    const sales5: V[] = [...sales, ...[1, 2, 3, 4].map((i) => ({ guid: `N-${i}`, date: "2026-11-12", alterid: 20 + i, type: "Sales Order Note", number: `SO-${i}` }))];
    const loop2 = new PrimaryMirrorLoop({
      store: st.store, tally: tallyOf(() => sales5, today),
      plan: { hasMark: async () => false, fullDue: async () => false, lastCheckAt: async () => new Date(), queuedRepulls: async () => 0 },
      tickMs: 1000, log: noop, runners, journal,
    });
    loop2.status.holds.push({ type: "Sales Order Note", storeRows: 4, where: "full", since: "x", lastAt: "x", consecutive: 4, line: "x" });
    await loop2.tick();
    ok("a run that finds the type again clears the hold", loop2.status.holds.length === 0);
    // pure acknowledgement rules
    const nowMs = Date.parse("2026-11-15T10:00:00Z");
    const at = (ms: number) => new Date(nowMs - ms).toISOString();
    ok("an acknowledgement older than a day is ignored", pendingVanishAcks([{ kind: "vanish-ack", type: "Sales Order Note", at: at(VANISH_ACK_MAX_AGE_MS + 60_000) }], nowMs).length === 0);
    ok("a fresh one counts, and a later 'used' cancels it", pendingVanishAcks([{ kind: "vanish-ack", type: "A", at: at(1000) }], nowMs).length === 1 && pendingVanishAcks([{ kind: "vanish-ack", type: "A", at: at(2000) }, { kind: "vanish-ack-used", type: "a", at: at(1000) }], nowMs).length === 0);
    ok("two acknowledgements release two runs (each 'used' cancels one)", pendingVanishAcks([{ kind: "vanish-ack", type: "A", at: at(3000) }, { kind: "vanish-ack", type: "A", at: at(2500) }, { kind: "vanish-ack-used", type: "A", at: at(1000) }], nowMs).length === 1);
    // the script, end to end
    const jp2 = join(dir, "script.jsonl");
    const j2 = new Journal(jp2);
    j2.append({ kind: "mirror-alarm", alarm: "type_vanished: Sales Order Note", where: "full", reason: "x", at: new Date().toISOString() });
    const tsx = join(dirname(process.argv[1]), "..", "node_modules", "tsx", "dist", "cli.mjs");
    const script = join(dirname(process.argv[1]), "primary-switches.ts");
    const run = (args: string[], env: Record<string, string>) => spawnSync(process.execPath, [tsx, script, ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 120_000 });
    const bad = run(["ack-vanish", "Receipt"], { MKCP_ERP_JOURNAL_PATH: jp2 });
    ok("the script refuses a type with no alarm on record, and writes nothing", bad.status === 2 && /no vanished-type alarm/.test(bad.stderr) && j2.entries().filter((e) => e.kind === "vanish-ack").length === 0, bad.stderr.slice(0, 120));
    const noPath = run(["ack-vanish", "Sales Order Note"], { MKCP_ERP_JOURNAL_PATH: "" });
    ok("the script refuses without the agent's journal path", noPath.status === 2 && /MKCP_ERP_JOURNAL_PATH/.test(noPath.stderr));
    const good2 = run(["ack-vanish", "Sales Order Note"], { MKCP_ERP_JOURNAL_PATH: jp2 });
    ok("the script writes one vanish-ack line to the journal", good2.status === 0 && j2.entries().filter((e) => e.kind === "vanish-ack").length === 1, good2.stderr.slice(0, 120));
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
