/**
 * The three response parsers, fed the same body, must agree.
 *
 * PURE — no Tally, no Supabase.
 *
 * There are three independent readers of a Tally import response:
 *   voucherPusher.parseImportResponse   the general one
 *   safePush's inline count()           the one production actually trusts
 *   pushListener.verdict                the raw-XML relay path
 *
 * They read different field sets, and until now they could not agree:
 * `parseImportResponse` did not read ALTERED, DELETED or EXCEPTIONS at all. So a
 * successful Alter reported success:false created:0, a successful Delete did
 * too, and — worst — a voucher Tally ACCEPTED AND THEN REFUSED
 * (EXCEPTIONS=1, ERRORS=0, no message) reported success:true.
 *
 *   npx tsx server/scripts/test-response-parsers.ts
 */
import { parseImportResponse } from "../src/services/voucherPusher.js";

let pass = 0, fail = 0;
const ok = (what: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${what}`); }
  else { fail++; console.log(`  FAIL  ${what}${detail ? " — " + detail : ""}`); }
};

/** The shape Tally actually returns. */
function importResult(counts: Partial<Record<string, number>>, lineError?: string): string {
  const n = (k: string) => counts[k] ?? 0;
  return (
    `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><IMPORTRESULT>` +
    `<CREATED>${n("CREATED")}</CREATED><ALTERED>${n("ALTERED")}</ALTERED>` +
    `<DELETED>${n("DELETED")}</DELETED><LASTVCHID>${n("LASTVCHID")}</LASTVCHID>` +
    `<LASTMID>0</LASTMID><COMBINED>0</COMBINED><IGNORED>0</IGNORED>` +
    `<ERRORS>${n("ERRORS")}</ERRORS><CANCELLED>${n("CANCELLED")}</CANCELLED>` +
    `<EXCEPTIONS>${n("EXCEPTIONS")}</EXCEPTIONS>` +
    (lineError ? `<LINEERROR>${lineError}</LINEERROR>` : "") +
    `</IMPORTRESULT></DATA></BODY></ENVELOPE>`
  );
}

/** safePush's own reader, reproduced exactly as it works in production. */
const safePushCount = (xml: string, tag: string): number =>
  Number(xml.match(new RegExp(`<${tag}>(\\d+)</${tag}>`, "i"))?.[1] ?? 0);

console.log("\n  THE THREE PARSERS, ON ONE BODY\n  " + "─".repeat(60));

// ── A plain Create ────────────────────────────────────────────────────────
console.log("\n  A successful Create");
{
  const body = importResult({ CREATED: 1, LASTVCHID: 249385 });
  const p = parseImportResponse(body);
  ok("created counted", p.created === 1);
  ok("reported successful", p.success);
  ok("agrees with safePush", p.created === safePushCount(body, "CREATED"));
  ok("carries the voucher id", p.lastVoucherId === "249385");
}

// ── An Alter: CREATED=0, ALTERED=1 ────────────────────────────────────────
console.log("\n  A successful Alter (the case that used to read as failure)");
{
  const body = importResult({ ALTERED: 1 });
  const p = parseImportResponse(body);
  ok("altered counted", p.altered === 1);
  ok("created is zero, correctly", p.created === 0);
  ok("reported SUCCESSFUL — it used to say false", p.success);
  ok("agrees with safePush on ALTERED", p.altered === safePushCount(body, "ALTERED"));
}

// ── A Cancel — Tally reports it as an alteration ──────────────────────────
console.log("\n  A Cancel");
{
  const p = parseImportResponse(importResult({ ALTERED: 1, CANCELLED: 1 }));
  ok("counted as an alteration, which is how Tally reports it", p.altered === 1);
  ok("reported successful", p.success);
}

// ── A Delete ──────────────────────────────────────────────────────────────
console.log("\n  A successful Delete");
{
  const body = importResult({ DELETED: 1 });
  const p = parseImportResponse(body);
  ok("deleted counted", p.deleted === 1);
  ok("reported SUCCESSFUL — it used to say false", p.success);
  ok("agrees with safePush on DELETED", p.deleted === safePushCount(body, "DELETED"));
}

// ── THE IMPORTANT ONE ─────────────────────────────────────────────────────
console.log("\n  Accepted, then refused: EXCEPTIONS=1, ERRORS=0, no message");
{
  const body = importResult({ EXCEPTIONS: 1 });
  const p = parseImportResponse(body);
  ok("the exception is READ — it was ignored entirely before", p.exceptions === 1);
  ok("reported as a FAILURE", !p.success, "this is the silently-wrong voucher");
  ok("agrees with safePush", p.exceptions === safePushCount(body, "EXCEPTIONS"));
}

console.log("\n  An exception alongside a count — still a refusal");
{
  const p = parseImportResponse(importResult({ CREATED: 1, EXCEPTIONS: 1 }));
  ok("counted the create", p.created === 1);
  ok("but still reported a failure", !p.success);
}

// ── A named error ─────────────────────────────────────────────────────────
console.log("\n  A LINEERROR");
{
  const p = parseImportResponse(importResult({ ERRORS: 1 }, "Ledger 'NOT A LEDGER' does not exist!"));
  ok("the message is captured verbatim", p.lineErrors[0]?.includes("does not exist"));
  ok("reported as a failure", !p.success);
}

// ── Agreement across the whole matrix ─────────────────────────────────────
console.log("\n  Agreement on every combination");
{
  const cases: Partial<Record<string, number>>[] = [
    { CREATED: 1 }, { ALTERED: 1 }, { DELETED: 1 }, { EXCEPTIONS: 1 },
    { CREATED: 1, EXCEPTIONS: 1 }, { ALTERED: 1, ERRORS: 1 }, {},
    { CREATED: 3 }, { ALTERED: 2, DELETED: 1 },
  ];
  let disagreements = 0;
  for (const c of cases) {
    const body = importResult(c);
    const p = parseImportResponse(body);
    for (const tag of ["CREATED", "ALTERED", "DELETED", "EXCEPTIONS", "ERRORS"] as const) {
      const mine = tag === "CREATED" ? p.created
        : tag === "ALTERED" ? p.altered
        : tag === "DELETED" ? p.deleted
        : tag === "EXCEPTIONS" ? p.exceptions
        : p.errors;
      if (mine !== safePushCount(body, tag)) {
        disagreements++;
        console.log(`        disagreement on ${tag}: parser ${mine}, safePush ${safePushCount(body, tag)}`);
      }
    }
  }
  ok("the two parsers agree on every count in every combination", disagreements === 0,
    `${disagreements} disagreement(s)`);
}

// ── Nothing this parser reports may be a guess ────────────────────────────
console.log("\n  A malformed body");
{
  const p = parseImportResponse("not xml at all");
  ok("fails closed rather than reporting success", !p.success);
  ok("every count is zero rather than invented",
    p.created === 0 && p.altered === 0 && p.deleted === 0 && p.exceptions === 0);
}

console.log("\n  " + "─".repeat(60));
console.log(`  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
