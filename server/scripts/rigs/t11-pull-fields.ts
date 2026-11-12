/**
 * T11 read-only: for every collection the agent pulls from Tally (today's sync and the ERP mirror), run the
 * agent's OWN request builder against the dummy and report, per field in the fetch list, how many returned
 * objects carry a non-empty value for it. A field that is empty everywhere is NOT proof Tally lacks it (G7: it may
 * be a field Tally holds that the request does not resolve); it is flagged "never populated" for a person to judge,
 * with the probe script that settles it. No writes. Values are never printed, only counts.
 *
 *   npx tsx scripts/rigs/t11-pull-fields.ts [--out file.json] [--days N]
 *
 * Vouchers are read one day at a time on a few small days (3 to 25 vouchers, covering each type), never a range,
 * never a dated ledger collection. Run from server/. One process at a time on the dummy.
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { preflight } from "./lib/t11.js";
import { tallyPost } from "../../src/tally.js";
import { buildCollectionXml } from "../../src/services/xmlBuilder.js";
import { MASTER_COLLECTIONS, TRANSACTION_COLLECTIONS } from "../../src/config/collections.js";
import { ERP_MIRROR_VOUCHER_DEF, ERP_MIRROR_LEDGER_DEF, ERP_MIRROR_VOUCHERTYPE_DEF, ERP_MIRROR_UNIT_DEF, ERP_MIRROR_ITEM_DEF, ERP_MIRROR_COMPANY_DEF } from "../../src/services/erpMirrorSync.js";
import { pull as pullAll } from "../find-stranded-test-vouchers.js";
import type { CollectionDef } from "../../src/types.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const OUT = arg("--out");
const DAYS = Number(arg("--days") ?? 4);

/** Objects of a type in a reply (a count element such as <LEDGER>205</LEDGER> has no markup inside, so it is skipped). */
const objects = (raw: string, tag: string): string[] => [...raw.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi"))].map((m) => m[1]).filter((b) => b.includes("<"));

/** Does the object carry a non-empty value for a fetch field? List fields (AllLedgerEntries) count when any nested tag has text. */
function populated(obj: string, field: string): boolean {
  const up = field.toUpperCase();
  const scalar = new RegExp(`<${up}(?:\\s[^>]*)?>([^<]+)</${up}>`).exec(obj);
  if (scalar && scalar[1].replace(/&#4;|\s/g, "") !== "") return true;
  const list = new RegExp(`<${up}\\.LIST[^>]*>([\\s\\S]*?)</${up}\\.LIST>`, "g");
  for (const m of obj.matchAll(list)) if (/<[A-Z0-9_.]+>[^<\s][^<]*<\//.test(m[1])) return true;
  return false;
}

interface Row { def: string; request: string; objects: number; fields: number; populated: string[]; neverPopulated: string[]; ms: number; error?: string }

async function readDef(url: string, company: string, def: CollectionDef, from?: string, to?: string): Promise<Row> {
  const t0 = Date.now();
  const fetch = def.fetch ?? [];
  try {
    const xml = buildCollectionXml(def, company, from, to);
    const raw = (await tallyPost(url, xml, Math.min(def.timeout, 240_000), true)) as string;
    const objs = objects(raw, def.tallyCollection.toUpperCase());
    const pop = fetch.filter((f) => objs.some((o) => populated(o, f)));
    return { def: def.name, request: `${def.tallyCollection}${from ? ` ${from}` : ""}`, objects: objs.length, fields: fetch.length, populated: pop, neverPopulated: fetch.filter((f) => !pop.includes(f)), ms: Date.now() - t0 };
  } catch (e) {
    return { def: def.name, request: def.tallyCollection, objects: 0, fields: fetch.length, populated: [], neverPopulated: fetch, ms: Date.now() - t0, error: (e as Error).message.slice(0, 160) };
  }
}

(async () => {
  const pf = await preflight();
  const rows: Row[] = [];
  const masters: CollectionDef[] = [...MASTER_COLLECTIONS, ERP_MIRROR_LEDGER_DEF, ERP_MIRROR_VOUCHERTYPE_DEF, ERP_MIRROR_UNIT_DEF, ERP_MIRROR_ITEM_DEF, ERP_MIRROR_COMPANY_DEF];
  for (const d of masters) { const r = await readDef(pf.tallyUrl, pf.company, d); rows.push(r); console.log(`  ${d.name}: ${r.objects} objects, ${r.populated.length}/${r.fields} fields populated, ${r.ms} ms${r.error ? `  ERROR ${r.error}` : ""}`); }

  // Days: the smallest days (3 to 25 vouchers) that between them cover the most voucher types.
  const all = await pullAll(pf.company);
  const byDay = new Map<string, Set<string>>(); const count = new Map<string, number>();
  for (const v of all) { const d = String(v.date); byDay.set(d, (byDay.get(d) ?? new Set()).add(v.type)); count.set(d, (count.get(d) ?? 0) + 1); }
  const candidates = [...byDay.keys()].filter((d) => (count.get(d) ?? 0) >= 3 && (count.get(d) ?? 0) <= 25);
  const chosen: string[] = []; const covered = new Set<string>();
  while (chosen.length < DAYS && candidates.length) {
    candidates.sort((a, b) => [...byDay.get(b)!].filter((t) => !covered.has(t)).length - [...byDay.get(a)!].filter((t) => !covered.has(t)).length || (count.get(a)! - count.get(b)!));
    const d = candidates.shift()!; chosen.push(d); byDay.get(d)!.forEach((t) => covered.add(t));
  }
  console.log(`  voucher days chosen: ${chosen.length} (${chosen.map((d) => `${count.get(d)} vouchers`).join(", ")}); types covered: ${[...covered].join(", ")}`);
  const vdefs: CollectionDef[] = [ERP_MIRROR_VOUCHER_DEF, ...TRANSACTION_COLLECTIONS];
  const merged = new Map<string, Row>();
  for (const d of vdefs) for (const day of chosen) {
    const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
    const r = await readDef(pf.tallyUrl, pf.company, d, iso, iso);
    console.log(`  ${d.name} ${iso}: ${r.objects} vouchers, ${r.populated.length}/${r.fields} fields populated, ${r.ms} ms${r.error ? `  ERROR ${r.error}` : ""}`);
    const prev = merged.get(d.name);
    if (!prev) merged.set(d.name, { ...r, request: `Voucher by day x${chosen.length}` });
    else { prev.objects += r.objects; prev.ms += r.ms; prev.populated = [...new Set([...prev.populated, ...r.populated])]; prev.neverPopulated = (d.fetch ?? []).filter((f) => !prev.populated.includes(f)); prev.error = prev.error ?? r.error; }
  }
  rows.push(...merged.values());
  console.log("\n  Fields never populated (G7: not proof Tally lacks them):");
  for (const r of rows) if (r.neverPopulated.length) console.log(`   ${r.def}: ${r.neverPopulated.join(", ")}`);
  const bad = rows.filter((r) => r.error || r.objects === 0);
  console.log(`\n  ${rows.length - bad.length} of ${rows.length} reads answered with objects; ${bad.length} did not`);
  if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2)); }
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(`FAILED: ${(e as Error).message}`); process.exit(2); });
