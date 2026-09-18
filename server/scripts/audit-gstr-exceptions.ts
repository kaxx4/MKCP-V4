/**
 * Audit the books for vouchers Tally would bucket as GSTR exceptions.
 *
 * Read-only. Writes nothing to Tally and nothing to Supabase.
 *
 * This is the nightly gate for "nothing we push lands in an exception". Run it
 * once to take a baseline, then after any pushing: a NEW exception attributable
 * to us is a failure, and the pre-existing ones are the state of the books.
 *
 *   npx tsx server/scripts/audit-gstr-exceptions.ts [--from 20260401] [--to 20270331]
 *   npx tsx server/scripts/audit-gstr-exceptions.ts --baseline   (writes the baseline file)
 *   npx tsx server/scripts/audit-gstr-exceptions.ts --compare    (compares against it)
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { tallyPost } from "../src/tally.js";
import { buildCollection, dateBetween, blocksOf, tagOf } from "../src/services/tallyRequest.js";
import { auditAll, type AuditedVoucher } from "../src/services/gstrExceptions.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";
const BASELINE = join(here, "..", "data", "gstr-baseline.json");

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

function parseVoucher(block: string): AuditedVoucher {
  /* Prefer ALLLEDGERENTRIES, fall back to LEDGERENTRIES — the same precedence
     convert.ts uses. Reading BOTH double-counts. */
  const allBlocks = [...block.matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/g)];
  const simpleBlocks = [...block.matchAll(/(?:^|[^L])<LEDGERENTRIES\.LIST>([\s\S]*?)<\/LEDGERENTRIES\.LIST>/g)];
  const named = (bs: RegExpMatchArray[]) => bs.filter((m) => /<LEDGERNAME[^>]*>\s*\S/i.test(m[1]));
  const chosen = named(allBlocks).length ? named(allBlocks) : named(simpleBlocks);
  const entries = chosen.map((m) => ({
    ledgerName: (tagOf(m[1], "LEDGERNAME") ?? "").trim(),
    amount: Number(tagOf(m[1], "AMOUNT") ?? 0),
    /* Arrives only because the fetch list below names
       ALLLEDGERENTRIES.APPROPRIATEFOR explicitly. Drop that line and this
       silently reads "" on every entry, and every adjustment line in the book
       becomes an exception. */
    appropriateFor: (tagOf(m[1], "APPROPRIATEFOR") ?? "").trim(),
  }));
  return {
    entriesPopulated: entries.length > 0,
    voucherNumber: (tagOf(block, "VOUCHERNUMBER") ?? "").trim(),
    date: (tagOf(block, "DATE") ?? "").trim(),
    voucherType: (tagOf(block, "VOUCHERTYPENAME") ?? "").trim(),
    party: (tagOf(block, "PARTYLEDGERNAME") ?? "").trim(),
    placeOfSupply: (tagOf(block, "PLACEOFSUPPLY") ?? "").trim(),
    partyGstin: (tagOf(block, "PARTYGSTIN") ?? "").trim(),
    consigneeState: (tagOf(block, "CONSIGNEESTATENAME") ?? "").trim(),
    narration: (tagOf(block, "NARRATION") ?? "").trim(),
    entries,
  };
}

async function main(): Promise<void> {
  const from = arg("from", "20260401");
  const to = arg("to", "20270331");

  console.log("\n  GSTR EXCEPTION AUDIT");
  console.log(`  ${COMPANY} · ${from} … ${to}`);
  console.log("  " + "─".repeat(66));

  /* ── Chunked by month, deliberately ───────────────────────────────────────
     A whole-year pull returns 24 MB and Tally sends EMPTY PLACEHOLDER entry
     lists for most vouchers in it — 186 of 310 April sales vouchers had no
     entries at all. Auditing those produces a false "no tax line" for each.
     Month-sized chunks come back populated. */
  const months: [string, string][] = [];
  {
    const y0 = +from.slice(0, 4), m0 = +from.slice(4, 6);
    const y1 = +to.slice(0, 4), m1 = +to.slice(4, 6);
    for (let y = y0, m = m0; y < y1 || (y === y1 && m <= m1); m === 12 ? (m = 1, y++) : m++) {
      const last = new Date(y, m, 0).getDate();
      const s = `${y}${String(m).padStart(2, "0")}01`;
      const e = `${y}${String(m).padStart(2, "0")}${last}`;
      months.push([s < from ? from : s, e > to ? to : e]);
    }
  }

  const vouchers: AuditedVoucher[] = [];
  for (const [mFrom, mTo] of months) {
    const xml: string = await tallyPost(TALLY, buildCollection({
      id: "GstrAudit", type: "Voucher",
      fetch: [
        "DATE", "VOUCHERTYPENAME", "VOUCHERNUMBER", "PARTYLEDGERNAME",
        "PLACEOFSUPPLY", "PARTYGSTIN", "CONSIGNEESTATENAME", "NARRATION",
        "ALLLEDGERENTRIES.LIST",
        /* Named explicitly: a bare ALLLEDGERENTRIES.LIST returns the entry
           WITHOUT its appropriation, which is what made the check look
           impossible. Verified present 18-Sep-2026. */
        "ALLLEDGERENTRIES.APPROPRIATEFOR", "ALLLEDGERENTRIES.GSTAPPROPRIATETO",
      ],
      filter: dateBetween(mFrom, mTo), company: COMPANY,
    }), 300_000, true);
    const got = blocksOf(xml, "VOUCHER").map(parseVoucher).filter((v) => v.voucherType);
    vouchers.push(...got);
    const populated = got.filter((v) => v.entriesPopulated).length;
    console.log(`    ${mFrom}–${mTo}: ${String(got.length).padStart(5)} vouchers, ${populated} with entries`);
  }

  const r = auditAll(vouchers);

  console.log(`\n  ${r.vouchersChecked} vouchers read · ${r.outwardChecked} outward supplies audited`);
  console.log(`  ${r.exceptions.length} exception condition(s) found\n`);

  if (r.exceptions.length) {
    for (const [kind, n] of Object.entries(r.byKind).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(5)}  ${kind}`);
    }
    console.log("\n  Examples:");
    const seen = new Set<string>();
    for (const e of r.exceptions) {
      if (seen.has(e.kind)) continue;
      seen.add(e.kind);
      console.log(`    ${e.voucherNumber.padEnd(16)} ${e.date}  ${e.message.slice(0, 84)}`);
    }
  } else {
    console.log("    Nothing. Every outward supply carries what the return needs.");
  }

  console.log(`\n  ours (test markers): ${r.ours.length}   ·   pre-existing: ${r.theirs.length}`);
  console.log(`\n  ⚠ ${r.caveat}`);

  // ── Baseline / compare ──────────────────────────────────────────────────
  const key = (e: { kind: string; voucherNumber: string }) => `${e.kind}|${e.voucherNumber}`;

  if (process.argv.includes("--baseline")) {
    mkdirSync(dirname(BASELINE), { recursive: true });
    writeFileSync(BASELINE, JSON.stringify({
      takenAt: new Date().toISOString(), from, to,
      keys: r.exceptions.map(key).sort(),
    }, null, 2), "utf8");
    console.log(`\n  Baseline written: ${r.exceptions.length} condition(s)\n  ${BASELINE}\n`);
    process.exit(0);
  }

  if (process.argv.includes("--compare")) {
    if (!existsSync(BASELINE)) {
      console.log("\n  No baseline yet. Run with --baseline first.\n");
      process.exit(1);
    }
    const base = JSON.parse(readFileSync(BASELINE, "utf8")) as { takenAt: string; keys: string[] };
    const was = new Set(base.keys);
    const now = r.exceptions.map(key);
    const added = now.filter((k) => !was.has(k));
    const fixed = base.keys.filter((k) => !now.includes(k));

    console.log(`\n  Against the baseline taken ${base.takenAt}:`);
    console.log(`    ${added.length} new   ·   ${fixed.length} resolved`);
    for (const k of added.slice(0, 20)) console.log(`      NEW  ${k}`);

    // THE GATE. A new exception is a failure regardless of who created it.
    console.log("\n  " + "─".repeat(66));
    console.log(added.length === 0
      ? "  No new GSTR exceptions.\n"
      : `  ${added.length} NEW GSTR exception(s) — something pushed since the baseline files wrong.\n`);
    process.exit(added.length === 0 ? 0 : 1);
  }

  console.log("");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
