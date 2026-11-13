/**
 * P1 cleanup on the dummy Tally: find every ZZ TEST leftover, optionally remove it, and prove the dummy is clean.
 *
 *   1. census   vouchers (how many in the books, which are ZZTEST), then the ZZ-named masters:
 *               ledgers, stock items, stock groups, units, godowns, cost centres. READ ONLY.
 *   2. remove   (only with --delete) ZZTEST vouchers by the sweep (per day), then ZZ TEST items, ledgers, cost centres, godowns, units
 *   3. prove    a second census: zero ZZ TEST masters and vouchers, the voucher total back to what it was minus what was removed
 *
 * Fake data only: a master is touched only if its name starts "ZZ TEST" (units and godowns: "ZZ" then letters/spaces only, listed first);
 * a voucher only if its number is ZZTEST<digits>/... (the sweep's own rule). One Tally turn at a time, at least --min-gap-sec
 * (default 120) apart, with a liveness stop. Sandbox role and the dummy's GUID are checked first by preflight().
 *
 *   cd server; npx tsx scripts/rigs/p1-cleanup.ts                 # read only census
 *   cd server; npx tsx scripts/rigs/p1-cleanup.ts --delete       # census, remove, census again
 */
import "dotenv/config";
import { guardScriptWrites } from "../../src/services/scriptWriteGuard.js";
guardScriptWrites("rigs/p1-cleanup");
import { preflight } from "./lib/t11.js";
import {
  Recorder, census, dropItem, dropParty, freshMasters, makeLive, stampFrom, readStored, turn, gate, TallyDownError, type Live,
} from "./lib/t11Live.js";
import { deleteCostCentre, deleteGodown, deleteUnit } from "../../src/services/masterPusher.js";
import { MASTER_COLLECTIONS } from "../../src/config/collections.js";
import { buildCollectionXml } from "../../src/services/xmlBuilder.js";
import { convertCostCentres } from "../../src/converters/convert.js";
import { tallyPost } from "../../src/tally.js";
import { voucherDeleteXml, reportedRemoteId, isHarnessVoucher, deleteRefusal } from "../lib/voucherDeleteXml.js";
import { pull as pullAll } from "../find-stranded-test-vouchers.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const DELETE = process.argv.includes("--delete");
const OUT = arg("--out");

const zzMaster = (s: string): boolean => /^ZZ TEST/i.test(s.trim());
const zzSmall = (s: string): boolean => /^ZZ[A-Z ]*$/i.test(s.trim());
const zzVoucher = isHarnessVoucher;

interface Left {
  vouchers: { date: string; number: string; type: string; narration: string; cancelled: boolean }[];
  total: number;
  ledgers: string[]; items: string[]; stockGroups: string[]; units: string[]; godowns: string[]; costCentres: string[];
  /** Looser look (names with ZZ or ZZTEST anywhere, not removed): so a leftover with an odd spelling is seen, not missed. */
  odd: string[];
}
const count = (x: Left): number => x.vouchers.length + x.ledgers.length + x.items.length + x.stockGroups.length + x.units.length + x.godowns.length + x.costCentres.length;

const ccDef = MASTER_COLLECTIONS.find((d) => d.name === "costCentres")!;

async function look(l: Live): Promise<Left> {
  const all = await turn(l, "read every voucher", () => pullAll(l.company));
  const masters = await freshMasters(l);
  const parsed = await turn(l, "read cost centres", () => tallyPost(l.url, buildCollectionXml(ccDef, l.company), ccDef.timeout, false));
  const cc = (convertCostCentres(parsed).tallymessage as { name: string }[]).map((c) => c.name);
  return {
    total: all.length,
    vouchers: all.filter(zzVoucher),
    ledgers: [...masters.ledgers.keys()].filter(zzMaster),
    items: [...masters.items.keys()].filter(zzMaster),
    stockGroups: [...masters.stockGroups.keys()].filter(zzMaster),
    units: [...masters.units].filter(zzSmall),
    godowns: [...masters.godowns].filter((g) => zzMaster(g) || zzSmall(g)),
    costCentres: cc.filter(zzMaster),
    odd: [
      ...[...masters.ledgers.keys()].filter((n) => /ZZ/i.test(n) && !zzMaster(n)).map((n) => `ledger ${n}`),
      ...[...masters.items.keys()].filter((n) => /ZZ/i.test(n) && !zzMaster(n)).map((n) => `item ${n}`),
      ...[...masters.stockGroups.keys()].filter((n) => /ZZ/i.test(n) && !zzMaster(n)).map((n) => `stock group ${n}`),
      ...all.filter((v) => (/ZZTEST/i.test(v.number) || /ZZTEST/i.test(v.narration)) && !zzVoucher(v)).map((v) => `voucher ${v.date} ${v.type} ${v.number} ${v.narration.slice(0, 40)}`),
    ],
  };
}

function show(title: string, x: Left): void {
  console.log(`\n  ${title}: ${x.total} vouchers in the books; ZZ leftovers ${count(x)}`);
  for (const v of x.vouchers) console.log(`    voucher  ${v.date}  ${v.type}  ${v.number}  ${v.cancelled ? "(cancelled)" : ""}  ${v.narration.slice(0, 50)}`);
  for (const [k, a] of [["ledger", x.ledgers], ["item", x.items], ["stock group", x.stockGroups], ["unit", x.units], ["godown", x.godowns], ["cost centre", x.costCentres]] as const)
    for (const n of a) console.log(`    ${k.padEnd(11)} ${n}`);
  for (const n of x.odd) console.log(`    odd (not removed) ${n}`);
}

async function main(): Promise<number> {
  const p = await preflight();
  const l = makeLive(p, new Date().toISOString().slice(0, 10), stampFrom());
  console.log(`P1 cleanup on the dummy (${DELETE ? "will remove ZZ TEST leftovers" : "read only"}); one turn at a time, ${Math.round((gate(l) as unknown as { opts?: { minGapMs?: number } }).opts?.minGapMs ?? 120000) / 1000}s apart`);
  const rec = new Recorder("p1-cleanup", DELETE ? -1 : -1);
  try {
    const before = await look(l);
    show("BEFORE", before);
    rec.note(`before: ${before.total} vouchers, ${before.vouchers.length} ZZTEST, ${before.ledgers.length} ledgers, ${before.items.length} items, ${before.stockGroups.length} stock groups, ${before.units.length} units, ${before.godowns.length} godowns, ${before.costCentres.length} cost centres`);
    if (!DELETE) { rec.finish(OUT ?? undefined); return 0; }

    /* vouchers first: masters cannot go while a voucher uses them. Each voucher is deleted by the REMOTEID Tally itself holds for it
       (the head of a voucher read carries it; found 13-Nov-2026), through the production writer. The old sweep guessed REMOTEIDs and could not
       reach vouchers an older harness made under a different spelling. */
    const groups = new Map<string, { iso: string; type: string }>();
    for (const v of before.vouchers) {
      const iso = /^\d{8}$/.test(v.date) ? `${v.date.slice(0, 4)}-${v.date.slice(4, 6)}-${v.date.slice(6, 8)}` : v.date;
      groups.set(`${iso}|${v.type}`, { iso, type: v.type });
    }
    for (const g of groups.values()) {
      const raw = await readStored(l, g.iso, { type: g.type });
      const blocks = (raw ?? "").split(/(?=<VOUCHER\b)/).filter((b) => /^<VOUCHER\b/.test(b));
      const tag = (b: string, t: string) => (new RegExp(`<${t}[^>]*>([^<]*)</${t}>`).exec(b)?.[1] ?? "").trim();
      const un = (x: string) => x.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      for (const b of blocks) {
        const number = un(tag(b, "VOUCHERNUMBER")), narration = un(tag(b, "NARRATION"));
        if (!zzVoucher({ number, narration })) continue;
        const remoteId = reportedRemoteId(b);
        const party = un(tag(b, "PARTYLEDGERNAME"));
        const label = `${g.iso} ${g.type} ${number || narration.slice(0, 24)}`;
        /* D-M.266: only a harness voucher, only on a ZZ TEST party or one of the eight listed stranded ones; never a guess at a REMOTEID. */
        const why = deleteRefusal({ iso: g.iso, type: g.type, number, narration, party });
        if (why) { rec.check(`voucher ${label} deleted`, false, `refused, not sent: ${why}`); continue; }
        if (!remoteId) { rec.check(`voucher ${label} deleted`, false, "Tally gave no REMOTEID for it; not sent"); continue; }
        /* Through tallyPost (company and practice-GUID checks on the request), from a file behind guardScriptWrites, one turn at a time. The message
           is the one builder the sweep script uses too (lib/voucherDeleteXml.ts). */
        const xml = voucherDeleteXml({ company: l.company, remoteId, type: g.type, day: g.iso.replace(/-/g, ""), number });
        try {
          const res = await turn(l, `delete ${label}`, () => tallyPost(l.url, xml, 60_000, true) as Promise<string>);
          const n = parseInt(/<DELETED>(\d+)<\/DELETED>/.exec(res)?.[1] ?? "0", 10) || 0;
          rec.check(`voucher ${label} deleted`, n === 1, n === 1 ? "" : (/<LINEERROR>([^<]*)/.exec(res)?.[1] ?? "no DELETED in the reply").slice(0, 120));
        } catch (e) { if (e instanceof TallyDownError) throw e; rec.check(`voucher ${label} deleted`, false, (e as Error).message.slice(0, 120)); }
      }
    }
    for (const n of before.items) { const r = await dropItem(l, n); rec.check(`item "${n}" removed`, r.ok, r.detail); }
    for (const n of before.ledgers) { const r = await dropParty(l, n); rec.check(`ledger "${n}" removed`, r.ok, r.detail); }
    for (const n of before.costCentres.sort((a, b) => b.length - a.length)) {
      const r = await turn(l, "delete cost centre", () => deleteCostCentre(l.url, l.company, n)); rec.check(`cost centre "${n}" removed`, r.ok, r.notes.join("; ").slice(0, 120));
    }
    for (const n of before.godowns) { const r = await turn(l, "delete godown", () => deleteGodown(l.url, l.company, n)); rec.check(`godown "${n}" removed`, r.ok, r.notes.join("; ").slice(0, 120)); }
    for (const n of before.units) { const r = await turn(l, "delete unit", () => deleteUnit(l.url, l.company, n)); rec.check(`unit "${n}" removed`, r.ok, r.notes.join("; ").slice(0, 120)); }
    if (before.stockGroups.length) rec.note(`stock groups left for a person to judge (no delete helper): ${before.stockGroups.join("; ")}`);

    const after = await look(l);
    show("AFTER", after);
    rec.check("no ZZ TEST voucher is left", after.vouchers.length === 0, `${after.vouchers.length}`);
    rec.check("no ZZ TEST ledger is left", after.ledgers.length === 0, `${after.ledgers.length}`);
    rec.check("no ZZ TEST item is left", after.items.length === 0, `${after.items.length}`);
    rec.check("no ZZ TEST cost centre is left", after.costCentres.length === 0, `${after.costCentres.length}`);
    rec.check("no ZZ godown or unit is left", after.godowns.length + after.units.length === 0, `${after.godowns.length + after.units.length}`);
    rec.check("the voucher total fell by exactly the ZZTEST vouchers removed", after.total === before.total - before.vouchers.length, `${before.total} - ${before.vouchers.length} = ${before.total - before.vouchers.length}; now ${after.total}`);
    const c = await census(l);
    rec.check("the census finds no ZZTEST voucher", c.ours === 0, `ours ${c.ours} of ${c.total}`);
    rec.finish(OUT ?? undefined);
    return rec.failed ? 1 : 0;
  } catch (e) {
    if (e instanceof TallyDownError) { console.log(`TALLY_DOWN: ${e.message}. Nothing more sent. Not restarted.`); return 3; }
    throw e;
  }
}

main().then((c) => process.exit(c)).catch((e) => { console.error(`p1-cleanup FAILED: ${(e as Error).message}`); process.exit(2); });
