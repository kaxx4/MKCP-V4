/**
 * Push something, read back EVERY field, and diff it against what was intended.
 *
 * ── Why, when safePush already verifies ───────────────────────────────────
 *
 * safePush compares the handful of fields it thinks matter. "The voucher in
 * Tally is the voucher I meant" is a bigger claim, and the gap between them is
 * where this project's real defects have lived: a party address fetched and
 * dropped, a purchase filed under the supplier's own date, a payment landing On
 * Account when it was meant to settle a bill. Each of those passes the push,
 * passes the read-back diff, and is wrong in the books.
 *
 * So the rule here is: state the intent as data BEFORE pushing, then read the
 * object back with `NATIVEMETHOD *` — every populated tag, not the ones we
 * remembered to ask for — and compare. A field the read-back does not carry is
 * reported UNKNOWN, never "fine": "my parser found nothing" and "Tally holds
 * nothing" are different facts (G7).
 *
 * ── Safety ────────────────────────────────────────────────────────────────
 *
 * For a throwaway company only. Everything written carries MARK in its name or
 * number so `sweep` can find it again — including after a push that REPORTED
 * failure, because "ok:false" does not mean "nothing was created".
 *
 * Never touches Supabase. The backup company shares its NAME with production,
 * so a sync from here would overwrite the real mirror (see the company-key
 * collision note in the vault).
 */
import { tallyPost, HEALTH_XML } from "../../src/tally.js";
import { convertCompanies } from "../../src/converters/convert.js";

export const U = process.env.TALLY_URL || "http://localhost:9000";

/** Every artefact these cases create carries this. Nothing else may. */
export const MARK = "ZZTEST";

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** First occurrence of a tag's text; attributes tolerated. */
export function fld(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return m ? m[1].trim() : "";
}

/** Every occurrence of a tag's text, in document order. */
export function flds(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi"))]
    .map((m) => m[1].trim())
    .filter(Boolean);
}

/** True when a block holds anything other than self-closing empty tags. */
function hasContent(b: string | undefined): boolean {
  return !!b && !!b.replace(/<[^>]*\/>/g, "").replace(/\s/g, "");
}

/**
 * The first nested `X.LIST` block that actually CONTAINS something.
 *
 * Tally emits a voucher with roughly fifty EMPTY placeholder `.LIST` elements —
 * BILLALLOCATIONS.LIST, BANKALLOCATIONS.LIST, EXCISEALLOCATIONS.LIST and so on
 * — whether or not the voucher uses them. Taking the first match therefore
 * returns an empty string most of the time, and reads as "the push dropped it".
 * That is exactly how the purchase case reported a MISSING bill reference
 * against a voucher whose reference was present and correct two blocks later.
 *
 * First non-empty wins. If every occurrence is empty the answer is "", which
 * then genuinely means Tally holds nothing.
 */
export function block(xml: string, name: string): string {
  for (const m of xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "gi"))) {
    if (hasContent(m[1])) return m[1];
  }
  return "";
}

/** Every non-empty occurrence of a nested block. */
export function blocks(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "gi"))]
    .map((m) => m[1])
    .filter(hasContent);
}

/**
 * A NAME attribute, anchored.
 *
 * `NAME="` also matches `RESERVEDNAME="`, which every master carries and which
 * usually comes FIRST — so an unanchored read returns the empty string for
 * every object and the whole dump looks nameless. Cost twenty minutes on the
 * first run of this very harness.
 */
export function attrName(attrs: string): string {
  return /(?:^|\s)NAME="([^"]*)"/.exec(attrs)?.[1] ?? "";
}

export async function company(): Promise<string> {
  return convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
}

/**
 * A collection of one object type with EVERY populated field.
 *
 * An unrecognised TYPE raises a modal in Tally and blocks its XML port until a
 * human restarts the application, so only verified types are ever passed here.
 */
export function allFieldsXml(co: string, type: string, filterExpr?: string): string {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkAll</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkAll" ISMODIFY="No"><TYPE>${type}</TYPE>
<NATIVEMETHOD>*</NATIVEMETHOD>${filterExpr ? "<FILTER>MkF</FILTER>" : ""}</COLLECTION>${
    filterExpr ? `<SYSTEM TYPE="Formulae" NAME="MkF">${filterExpr}</SYSTEM>` : ""
  }</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

/**
 * Every voucher on one day, WITH its entry blocks.
 *
 * `NATIVEMETHOD *` alone is not enough and the failure is silent: it returns
 * the voucher's stored scalar fields and NO ALLLEDGERENTRIES.LIST,
 * ALLINVENTORYENTRIES.LIST or BILLALLOCATIONS.LIST at all. A purchase read
 * that way looks like a voucher with no lines, no party entry and no stock —
 * which is indistinguishable from a push that dropped them, and is how the
 * first run of the purchase case reported eleven false failures against a
 * voucher Tally had stored perfectly.
 *
 * So the blocks are named explicitly alongside the wildcard. This is the same
 * list safePush's own verify query uses; entry blocks are ~64x the payload of
 * a voucher header, which is why nothing asks for them unless it needs them.
 */
export function vouchersOnDayXml(co: string, iso: string): string {
  const stamp = parseInt(iso.replace(/-/g, ""), 10);
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkV</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkV" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>*</NATIVEMETHOD>
<NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD><NATIVEMETHOD>LedgerEntries</NATIVEMETHOD>
<NATIVEMETHOD>AllInventoryEntries</NATIVEMETHOD><NATIVEMETHOD>InventoryEntries</NATIVEMETHOD>
<FILTER>MkVF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MkVF">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) = ${stamp}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

export interface Obj { name: string; body: string }

/** Split a collection response into named objects of one element type. */
export function objects(xml: string, element: string): Obj[] {
  return [...xml.matchAll(new RegExp(`<${element}\\b([^>]*)>([\\s\\S]*?)</${element}>`, "g"))]
    .map((m) => ({ name: attrName(m[1]), body: m[2] }));
}

// ── The diff ────────────────────────────────────────────────────────────────

export type Verdict = "MATCH" | "WRONG" | "MISSING" | "UNKNOWN";

export interface Check {
  field: string;
  intended: string;
  stored: string;
  verdict: Verdict;
  note?: string;
}

/**
 * Compare one intended value against what came back.
 *
 * `stored === null` means the read-back did not carry the field at all. That is
 * reported UNKNOWN rather than MISSING, because a field absent from a dump is
 * a fact about the dump, not about the books.
 */
export function check(
  field: string,
  intended: string | undefined,
  stored: string | null,
  opts: { normalise?: (s: string) => string; note?: string } = {},
): Check {
  const n = opts.normalise ?? ((s: string) => s.trim());
  const want = intended === undefined ? "" : n(String(intended));
  if (stored === null) {
    return { field, intended: want, stored: "(not in read-back)", verdict: "UNKNOWN", note: opts.note };
  }
  const got = n(stored);
  if (!want && !got) return { field, intended: "—", stored: "—", verdict: "MATCH", note: opts.note };
  if (!got) return { field, intended: want, stored: "(empty)", verdict: "MISSING", note: opts.note };
  return {
    field,
    intended: want,
    stored: got,
    verdict: got === want ? "MATCH" : "WRONG",
    note: opts.note,
  };
}

const ICON: Record<Verdict, string> = {
  MATCH: "  ok  ",
  WRONG: " WRONG",
  MISSING: " GONE ",
  UNKNOWN: "  ??  ",
};

export function report(title: string, checks: Check[]): { failed: number; unknown: number } {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 66 - title.length))}`);
  const w = Math.max(...checks.map((c) => c.field.length), 10);
  for (const c of checks) {
    console.log(`${ICON[c.verdict]}  ${c.field.padEnd(w)}  intended: ${trunc(c.intended)}`);
    if (c.verdict !== "MATCH") {
      console.log(`         ${" ".repeat(w)}    stored: ${trunc(c.stored)}`);
    }
    if (c.note) console.log(`         ${" ".repeat(w)}       └─ ${c.note}`);
  }
  const failed = checks.filter((c) => c.verdict === "WRONG" || c.verdict === "MISSING").length;
  const unknown = checks.filter((c) => c.verdict === "UNKNOWN").length;
  console.log(
    `   ${checks.length - failed - unknown} matched, ${failed} wrong or missing, ${unknown} not visible in the read-back`,
  );
  return { failed, unknown };
}

/**
 * The leading number out of one of Tally's compound strings.
 *
 * Quantities come back as "10 PC =  10.00 PKG" and rates as "100.00/PC". A
 * naive strip of non-digits turns the first into 1010.00 — which is what the
 * purchase case reported as a WRONG quantity against a voucher that was right.
 * The same trap is documented on `tally_voucher_inventory_entries.actual_qty`,
 * where the leading number is pieces on some lines and packages on others.
 */
export function lead(raw: string): number {
  const m = /-?\d+(?:\.\d+)?/.exec(String(raw ?? "").replace(/,/g, ""));
  return m ? parseFloat(m[0]) : NaN;
}

/** A check that compares NUMBERS, so "100" and "100.00/PC" agree. */
export function checkNum(
  field: string, intended: number, storedRaw: string | null,
  opts: { note?: string; tolerance?: number } = {},
): Check {
  if (storedRaw === null) {
    return { field, intended: String(intended), stored: "(not in read-back)", verdict: "UNKNOWN", note: opts.note };
  }
  const got = lead(storedRaw);
  const tol = opts.tolerance ?? 0.005;
  if (!storedRaw.trim()) {
    return { field, intended: String(intended), stored: "(empty)", verdict: "MISSING", note: opts.note };
  }
  return {
    field,
    intended: String(intended),
    stored: `${Number.isNaN(got) ? "?" : got}   raw: "${storedRaw.trim()}"`,
    verdict: Number.isFinite(got) && Math.abs(got - intended) <= tol ? "MATCH" : "WRONG",
    note: opts.note,
  };
}

const trunc = (s: string) => (s.length > 78 ? `${s.slice(0, 75)}…` : s);

/** Count a tag in an import response. */
export function count(xml: string, tag: string): number {
  return parseInt(new RegExp(`<${tag}>\\s*(\\d+)\\s*</${tag}>`).exec(xml)?.[1] ?? "0", 10);
}

export function importSummary(xml: string): string {
  const parts = ["CREATED", "ALTERED", "DELETED", "ERRORS", "EXCEPTIONS"]
    .map((t) => `${t.toLowerCase()}=${count(xml, t)}`)
    .join(" ");
  const le = flds(xml, "LINEERROR");
  return parts + (le.length ? `  lineErrors: ${le.join(" | ")}` : "");
}

/** Post an import envelope and return the raw response. */
export async function push(co: string, inner: string, label: string): Promise<string> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>All Masters</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${inner}</TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
  const res = (await tallyPost(U, xml, 120_000, true)) as string;
  console.log(`   push ${label}: ${importSummary(res)}`);
  return res;
}
