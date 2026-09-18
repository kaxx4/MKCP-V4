/**
 * Push a voucher, read back EVERY field, and diff it against what was intended.
 *
 * ── Why this exists, when safePush already verifies ───────────────────────
 *
 * safePush's read-back compares the handful of fields it thinks matter. That
 * is not the same as "the voucher in Tally is the voucher I meant", and the
 * gap is where this project's real defects have lived: a party address fetched
 * and dropped, a purchase filed under the supplier's date instead of today's,
 * a payment landing On Account when it was meant to settle a bill. Every one
 * of those passes a push, passes a read-back diff, and is wrong in the books.
 *
 * So this reads the voucher back with `NATIVEMETHOD *` — every populated tag —
 * and prints intent beside reality, field by field. It reports what it CANNOT
 * see as loudly as what it can: a field absent from the read-back is unknown,
 * not confirmed.
 *
 * ── Safety ────────────────────────────────────────────────────────────────
 *
 * Intended for a throwaway company. Everything it writes carries the marker
 * below in its voucher number AND its remoteId, so `--sweep` can find and
 * delete its own work even when a push reported failure — "ok:false" does not
 * mean "nothing was created".
 *
 * It never touches Supabase. This backup company shares its NAME with
 * production, so a sync from here would overwrite the real mirror's rows.
 *
 *   npx tsx scripts/push-fidelity.ts                 # baseline only, writes nothing
 *   npx tsx scripts/push-fidelity.ts --case party    # one named case
 *   npx tsx scripts/push-fidelity.ts --sweep         # delete what it made
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";

const U = process.env.TALLY_URL || "http://localhost:9000";

/** Every artefact this script creates carries this. Nothing else may. */
export const MARK = "ZZTEST";

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** First occurrence of a tag's text, attributes tolerated. */
export function fld(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return m ? m[1].trim() : "";
}

/** Every occurrence of a tag's text. */
export function flds(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi"))]
    .map((m) => m[1].trim());
}

export async function company(): Promise<string> {
  return convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
}

/**
 * A collection of one object type with EVERY field populated.
 *
 * `NATIVEMETHOD *` is the wildcard proved in earlier probing — it returns every
 * populated tag rather than the ones we remembered to ask for, which is the
 * whole point here. An unrecognised TYPE raises a modal in Tally and blocks the
 * port until a human restarts it, so only verified types are ever passed.
 */
export function allFieldsXml(co: string, type: string, filterExpr?: string): string {
  const filt = filterExpr
    ? `<FILTER>MkF</FILTER>`
    : "";
  const sys = filterExpr
    ? `<SYSTEM TYPE="Formulae" NAME="MkF">${filterExpr}</SYSTEM>`
    : "";
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkAll</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkAll" ISMODIFY="No"><TYPE>${type}</TYPE>
<NATIVEMETHOD>*</NATIVEMETHOD>${filt}</COLLECTION>${sys}</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

/** Vouchers on one day, every field. */
export function vouchersOnDay(co: string, iso: string): string {
  const stamp = parseInt(iso.replace(/-/g, ""), 10);
  return allFieldsXml(
    co,
    "Voucher",
    `($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${stamp}`,
  );
}

// ── Baseline ────────────────────────────────────────────────────────────────

async function baseline(): Promise<void> {
  const co = await company();
  console.log(`\ncompany   ${co}`);
  console.log(`tally     ${U}\n`);

  const led = await tallyPost(U, allFieldsXml(co, "Ledger"), 120_000, true) as string;
  const ledgers = [...led.matchAll(/<LEDGER\b[^>]*NAME="([^"]*)"[^>]*>([\s\S]*?)<\/LEDGER>/g)]
    .map((m) => ({ name: m[1], body: m[2] }));
  console.log(`ledgers   ${ledgers.length}`);

  const withAddr = ledgers.filter((l) => fld(l.body, "ADDRESS")).length;
  const withGstin = ledgers.filter((l) => fld(l.body, "PARTYGSTIN")).length;
  const withState = ledgers.filter((l) => fld(l.body, "LEDSTATENAME")).length;
  console.log(`          ${withAddr} carry an address, ${withGstin} a GSTIN, ${withState} a state`);

  const vt = await tallyPost(U, allFieldsXml(co, "VoucherType"), 60_000, true) as string;
  const types = [...vt.matchAll(/<VOUCHERTYPE\b[^>]*NAME="([^"]*)"[^>]*>([\s\S]*?)<\/VOUCHERTYPE>/g)];
  console.log(`\nnumbering method, as Tally holds it:`);
  for (const [, name, body] of types) {
    const method = fld(body, "NUMBERINGMETHOD");
    if (/^(Payment|Receipt|Contra|Journal|Sales|Purchase|Credit Note|Debit Note)$/i.test(name)) {
      console.log(`  ${name.padEnd(14)} ${method || "(none reported)"}`);
    }
  }
  console.log(`\nNothing was written.\n`);
}

/* ── Dispatch ───────────────────────────────────────────────────────────────
   The header above has always documented `--case` and `--sweep`. Neither
   existed: `--sweep` printed "nothing to do yet" and `--case` fell through to
   the baseline, so every `--case sales` run reported "Nothing was written" and
   looked like a push that had quietly done nothing — the exact failure shape
   this whole directory exists to catch.

   The work was never missing, only unreachable: the cases are the twelve
   `fidelity/case-*.ts` files and the sweep is `fidelity/sweep.ts`, each
   runnable on its own. This forwards to them, so the documented interface is
   the real one (G8). */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIDELITY = join(HERE, "fidelity");

function run(script: string, extra: string[] = []): never {
  const r = spawnSync("npx", ["tsx", script, ...extra], { stdio: "inherit", shell: process.platform === "win32" });
  process.exit(r.status ?? 1);
}

const args = process.argv.slice(2);
const caseAt = args.indexOf("--case");

if (args.includes("--sweep")) {
  run(join(FIDELITY, "sweep.ts"), args.filter((a) => a !== "--sweep"));
} else if (caseAt !== -1) {
  const name = args[caseAt + 1];
  const file = name ? join(FIDELITY, `case-${name}.ts`) : "";
  if (!name || !existsSync(file)) {
    console.error(`
  --case needs one of:
`);
    for (const f of require("node:fs").readdirSync(FIDELITY) as string[]) {
      if (f.startsWith("case-")) console.error(`    ${f.replace(/^case-|\.ts$/g, "")}`);
    }
    console.error("");
    process.exit(1);
  }
  run(file, args.slice(caseAt + 2));
} else {
  baseline().catch((e) => { console.error(e); process.exit(1); });
}
