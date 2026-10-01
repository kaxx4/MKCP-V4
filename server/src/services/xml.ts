/**
 * The ONE place this repo escapes, decodes and formats Tally XML (guardrail G1).
 *
 * Before 1-Oct-2026 there were twelve local `esc`/`escXml` copies and four
 * hand-rolled decoders, and they did not agree: seven escaped no `"`, one
 * decoded `&amp;` first (so `&amp;quot;` came out as `"`), none handled a
 * control character, and every number went out through `${n}` — so NaN,
 * Infinity and `1e-7` reached Tally as text. Every builder and every regex
 * reader now goes through the functions below.
 *
 *   OUT   escapeXml · fmtAmount · fmtQty · tallyDate · tallyDateInt
 *   IN    decodeTallyBody · decodeXmlEntities · readTag · readAllTags ·
 *         parseTallyAmount · parseImportResult · importVerdict
 *
 * Evidence for each rule is in the comment on the function, with its date.
 */

/** A value that cannot be written into, or read out of, Tally XML. Never a crash, never a silent zero. */
export class TallyXmlError extends Error {
  constructor(
    readonly kind: "invalid-number" | "invalid-date" | "invalid-value" | "malformed-response" | "encoding",
    message: string,
  ) {
    super(message);
    this.name = "TallyXmlError";
  }
}

// ── Outbound ─────────────────────────────────────────────────────────────────

/* XML 1.0 forbids every C0 control except TAB, LF and CR, and the two
   non-characters U+FFFE/U+FFFF. Lone surrogates cannot be encoded as UTF-8
   (Buffer.from turns them into U+FFFD, silently changing the text).

   ONE exception, \x04: Tally writes its reserved values with it — "&#4; Not
   Applicable", "&#4; Primary", "\x04 Unknown" on two ledgers' registration
   type — and a value read back from Tally must be able to go back out
   unchanged. Sent as `&#4;` it is accepted: voucherPusher has emitted
   `&#4; Not Applicable` on every GST line since 23-Sep-2026 and the stored
   lines read back with it (server/data/push-fidelity-S*.stored.xml). Every
   other control character is dropped. */
const DROP = /[\x00-\x03\x05-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** What `escapeXml` keeps of a string — the text a reader gets back. */
export function xmlSafeText(s: string): string {
  return s.replace(DROP, "");
}

/**
 * Escape any value for element content OR a double-quoted attribute.
 *
 * `&` `<` `>` `"` `'` are all escaped. `&apos;` is safe to send: Tally writes it
 * itself (`&apos;&apos; GREEN` in native-shape/26_27_0654.explicit.xml), so its
 * reader takes it. `null`/`undefined` become "" — a builder that wants the tag
 * OMITTED must say so (see `optTag`); a builder never emits "undefined".
 * A non-finite number throws rather than writing "NaN".
 */
export function escapeXml(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TallyXmlError("invalid-number", `Refusing to write ${v} into Tally XML.`);
    return String(v);
  }
  return xmlSafeText(String(v))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\x04/g, "&#4;");
}

/** `<TAG>value</TAG>`, or nothing at all when the value is empty/absent. */
export function optTag(tag: string, v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? escapeXml(v) : escapeXml(v.trim());
  return s ? `<${tag}>${s}</${tag}>` : "";
}

/**
 * A money amount with fixed decimals. Throws on NaN/Infinity — "NaN" in an
 * AMOUNT is accepted by Tally as zero with no error, which is worse than any
 * refusal. `-0` is written as `0.00`.
 */
export function fmtAmount(n: number, dp = 2): string {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new TallyXmlError("invalid-number", `Refusing to write amount ${String(n)} into Tally XML.`);
  }
  const s = n.toFixed(dp);
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
}

/** Signed amount by Tally's rule: a debit (ISDEEMEDPOSITIVE=Yes) is negative. */
export function fmtSigned(amount: number, isDeemedPositive: boolean): string {
  if (!Number.isFinite(amount)) throw new TallyXmlError("invalid-number", `Refusing to write amount ${amount} into Tally XML.`);
  return fmtAmount(isDeemedPositive ? -Math.abs(amount) : Math.abs(amount));
}

/**
 * A quantity or rate as a plain decimal — never exponent notation (`1e-7`),
 * never NaN. Integers and ordinary decimals come out exactly as `String(n)`
 * did, so nothing that worked changes.
 */
export function fmtQty(n: number): string {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new TallyXmlError("invalid-number", `Refusing to write quantity ${String(n)} into Tally XML.`);
  }
  const s = String(n);
  if (!/e/i.test(s)) return s;
  return n.toFixed(6).replace(/\.?0+$/, "") || "0";
}

/**
 * Any accepted date spelling → Tally's `YYYYMMDD`, validated as a real calendar
 * date. Accepts `YYYY-MM-DD`, `YYYYMMDD`, or an ISO timestamp. Throws otherwise:
 * `"2026-9-1".replace(/-/g,"")` is "202691", which Tally reads as no date.
 */
export function tallyDate(input: string): string {
  const s = String(input ?? "").trim();
  const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:$|T)/.exec(s);
  if (!m) throw new TallyXmlError("invalid-date", `"${s}" is not a date (expected YYYY-MM-DD).`);
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) {
    throw new TallyXmlError("invalid-date", `"${s}" is not a real calendar date.`);
  }
  return `${y}${mo}${d}`;
}

/** The same, as the integer a TDL date filter compares against. */
export function tallyDateInt(input: string): number {
  return Number(tallyDate(input));
}

/** A non-negative integer for a TDL filter (`$AlterID &gt; N`). Throws on anything else. */
export function tdlInt(n: number): number {
  if (!Number.isFinite(n)) throw new TallyXmlError("invalid-number", `Refusing to put ${n} into a TDL filter.`);
  return Math.max(0, Math.floor(n));
}

/**
 * A string literal inside a TDL formula, XML-escaped, quotes included.
 *
 * XML escaping cannot protect a TDL literal: `&quot;` decodes back to `"`
 * BEFORE Tally evaluates the formula, so `$Name = "FRAME 22""` ends the
 * literal early and the filter silently matches nothing (the same failure
 * shape as an unescaped `>=`, tally-pull-performance). TDL has no escape for
 * `"` inside a literal, so a value carrying one is refused. Item names carry
 * inch marks (`FRAME KW CYCLE 22"`), so this is a real case, not a theory.
 */
export function tdlString(v: string): string {
  const s = xmlSafeText(String(v ?? ""));
  if (s.includes('"')) {
    throw new TallyXmlError("invalid-value", `Cannot put ${JSON.stringify(s)} in a TDL string literal: it contains a double quote, which ends the literal and makes the filter match nothing.`);
  }
  return `"${escapeXml(s)}"`;
}

// ── Inbound ──────────────────────────────────────────────────────────────────

/**
 * A response body → text, whatever Tally encoded it as.
 *
 * Tally answers in the encoding of the request (UTF-8 here), but writes files
 * and some configured exports as UTF-16LE with a BOM. Decoding UTF-16 as UTF-8
 * produces a NUL between every character, the <DATA> check fails, and the pull
 * reports a malformed envelope instead of the rows it actually received.
 */
export function decodeTallyBody(buf: Buffer | Uint8Array): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let text: string;
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) text = b.subarray(2).toString("utf16le");
  else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    const sw = Buffer.from(b.subarray(2, 2 + ((b.length - 2) & ~1)));
    text = sw.swap16().toString("utf16le");
  } else if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) text = b.subarray(3).toString("utf8");
  // No BOM but every other byte NUL in the first characters: UTF-16LE without a BOM.
  else if (b.length >= 4 && b[1] === 0 && b[3] === 0 && b[0] !== 0) text = b.toString("utf16le");
  else text = b.toString("utf8");
  return text.replace(/^﻿/, "");
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * Decode XML character references in ONE pass, so `&amp;quot;` becomes the
 * literal text `&quot;` and never `"` (tallyPriceList decoded `&amp;` first and
 * double-decoded). Numeric references decode to their character — `&#4;`
 * becomes \x04, which `escapeXml` writes back as `&#4;`, so a reserved value
 * round-trips. An unknown or invalid reference is left as written.
 */
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return whole;
      return String.fromCodePoint(cp);
    }
    return NAMED[body] ?? whole;
  });
}

const reEsc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The decoded, trimmed text of the first `<TAG>` in a block — "" when absent
 * or self-closing (`<NAME/>`, which is how Tally stores an On Account bill's
 * name). CDATA is unwrapped. Exact tag match: `NAME` never matches `NAMEX`.
 */
export function readTag(block: string, tag: string): string {
  const t = reEsc(tag);
  // The first occurrence that holds TEXT. Self-closing and nested-markup
  // occurrences are skipped, exactly as the old per-file `<T[^>]*>([^<]*)</T>`
  // readers skipped them — minus their prefix bug (`NAME` matched `NAME.LIST`).
  for (const m of block.matchAll(new RegExp(`<${t}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${t}>)`, "g"))) {
    if (m[1] === undefined) continue;
    if (m[1].includes("<") && !/^\s*<!\[CDATA\[[\s\S]*\]\]>\s*$/.test(m[1])) continue;
    return readText(m[1]);
  }
  return "";
}

/** Every `<TAG>` text in a block, decoded and trimmed. */
export function readAllTags(block: string, tag: string): string[] {
  const t = reEsc(tag);
  return [...block.matchAll(new RegExp(`<${t}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${t}>)`, "g"))]
    .map((m) => (m[1] === undefined ? "" : readText(m[1])));
}

/** Element text → value: CDATA unwrapped, entities decoded, trimmed. Nested markup yields "". */
function readText(inner: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(inner);
  if (cdata) return cdata[1].trim();
  if (inner.includes("<")) return "";
  return decodeXmlEntities(inner).trim();
}

/**
 * A Tally amount or quantity string → number, or null when there is nothing
 * numeric to read. Never 0 for "absent".
 *
 *   "-1918494.24"           → -1918494.24
 *   "(-)5,000.00"           → -5000          Tally's report notation for negative
 *   "3,79,56,526.73 Dr"     → -37956526.73   Dr = debit = negative, Tally's XML sign
 *   "1,200.00 Cr"           → 1200
 *   "31320.00 UT = 87 PKG"  → 31320          the LEADING number; never strip non-digits
 *   "995.24/PC"             → 995.24
 *   "₹ 1,23,456"            → 123456
 */
export function parseTallyAmount(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).replace(/[ \s]+/g, " ").trim();
  if (!s) return null;
  let neg = false;
  if (/^\(\s*-\s*\)/.test(s)) { neg = true; s = s.replace(/^\(\s*-\s*\)\s*/, ""); }
  s = s.replace(/^(?:₹|Rs\.?|INR)\s*/i, "");
  const m = /^([+-]?)\s*(\d[\d,]*(?:\.\d+)?|\.\d+)/.exec(s);
  if (!m) return null;
  let n = parseFloat(m[2].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  if (m[1] === "-") neg = !neg;
  const rest = s.slice(m[0].length).trim();
  if (/^Dr\b/i.test(rest)) neg = true;
  else if (/^Cr\b/i.test(rest)) neg = false;
  n = neg ? -n : n;
  return Object.is(n, -0) ? 0 : n;
}

// ── Import responses ────────────────────────────────────────────────────────

export interface ImportCounts {
  /** False when the body carries none of Tally's import counters at all. */
  parsed: boolean;
  created: number;
  altered: number;
  deleted: number;
  cancelled: number;
  ignored: number;
  combined: number;
  errors: number;
  exceptions: number;
  lastVchId: string | null;
  /** Decoded: `Voucher Number &apos;1920/26-27&apos;` reads `Voucher Number '1920/26-27'`. */
  lineErrors: string[];
}

/**
 * Read an Import response. Works on both shapes Tally returns — the bare
 * `<RESPONSE>` (every archived push in push_queue, Sep-2026) and
 * `<ENVELOPE>…<IMPORTRESULT>`. Never throws.
 */
export function parseImportResult(body: unknown): ImportCounts {
  const xml = typeof body === "string" ? body : "";
  const count = (tag: string): number | undefined => {
    const m = new RegExp(`<${tag}>\\s*(-?\\d+)\\s*</${tag}>`, "i").exec(xml);
    return m ? parseInt(m[1], 10) : undefined;
  };
  const tags = ["CREATED", "ALTERED", "DELETED", "CANCELLED", "IGNORED", "COMBINED", "ERRORS", "EXCEPTIONS"] as const;
  const raw = Object.fromEntries(tags.map((t) => [t, count(t)])) as Record<(typeof tags)[number], number | undefined>;
  const lineErrors = [...xml.matchAll(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/gi)]
    .map((m) => decodeXmlEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim())
    .filter(Boolean);
  const lastVch = /<LASTVCHID>\s*([^<]*?)\s*<\/LASTVCHID>/i.exec(xml)?.[1];
  return {
    parsed: tags.some((t) => raw[t] !== undefined),
    created: raw.CREATED ?? 0,
    altered: raw.ALTERED ?? 0,
    deleted: raw.DELETED ?? 0,
    cancelled: raw.CANCELLED ?? 0,
    ignored: raw.IGNORED ?? 0,
    combined: raw.COMBINED ?? 0,
    errors: raw.ERRORS ?? 0,
    exceptions: raw.EXCEPTIONS ?? 0,
    lastVchId: lastVch ? lastVch : null,
    lineErrors,
  };
}

export type ImportAction = "Create" | "Alter" | "Cancel" | "Delete";

/**
 * Did the counter THIS action should move actually move — and nothing else go wrong?
 *
 *   Create  CREATED ≥ 1  (or ALTERED ≥ 1: a Create whose REMOTEID already
 *           exists updates it in place — the idempotency a stable id is for)
 *   Alter   ALTERED ≥ 1 and CREATED = 0  (an Alter that CREATES made a duplicate)
 *   Cancel  ALTERED ≥ 1 and CREATED = 0  (Tally reports a cancel as an alteration)
 *   Delete  DELETED ≥ 1  (and no LINEERROR — DELETED=1 has been seen beside one)
 *
 * Any LINEERROR, any ERRORS, any EXCEPTIONS is a failure: EXCEPTIONS=1 with no
 * text is how Tally refuses content without saying why. A body with no
 * counters at all is a failure, not a quiet zero.
 */
export function importVerdict(r: ImportCounts, action: ImportAction = "Create"): { ok: boolean; reason: string } {
  if (!r.parsed) return { ok: false, reason: "Tally's reply carried no import counters — not a result." };
  if (r.lineErrors.length) return { ok: false, reason: r.lineErrors.join("; ") };
  if (r.errors > 0) return { ok: false, reason: `Tally reported ${r.errors} error(s).` };
  if (r.exceptions > 0) return { ok: false, reason: `EXCEPTIONS=${r.exceptions} — Tally refused the content and gave no reason.` };
  switch (action) {
    case "Create":
      return r.created > 0 || r.altered > 0
        ? { ok: true, reason: r.created > 0 ? "created" : "already existed under this REMOTEID; altered in place" }
        : { ok: false, reason: "Tally created nothing." };
    case "Alter":
    case "Cancel":
      if (r.created > 0) return { ok: false, reason: `Asked to ${action.toUpperCase()}, Tally CREATED instead — a duplicate.` };
      return r.altered > 0 ? { ok: true, reason: "altered" } : { ok: false, reason: `Tally altered nothing.` };
    case "Delete":
      return r.deleted > 0 ? { ok: true, reason: "deleted" } : { ok: false, reason: "Tally deleted nothing." };
  }
}
