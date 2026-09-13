/**
 * Build a Tally request so the known traps cannot be written.
 *
 * ── Why a builder and not a template string ───────────────────────────────
 *
 * Every request shape in this codebase is a hand-assembled string, and the
 * failures are all in the assembly rather than in Tally:
 *
 *   · An unescaped `>` or `<` in a TDL filter returns **zero rows with no
 *     error**. Indistinguishable from "nothing changed". This is documented in
 *     three places and was still walked into during the planning of this very
 *     rebuild — by someone who had just read the documentation.
 *   · A `.*` wildcard in a fetch list **crashes TallyPrime**.
 *   · An unrecognised object TYPE raises a **modal dialog that blocks the XML
 *     port until a human restarts the application**. Not recoverable in code.
 *   · A collection whose NAME differs from the request ID silently returns
 *     nothing.
 *
 * So the comparison operators are written as words and escaped on the way out,
 * the object type is checked against the list that is known to work, and the
 * name is derived from the id rather than passed twice.
 *
 * Guardrail G9: the claims above each carry their evidence, in `docs/` or in the
 * exception log.
 */

/** Object types verified to work against this company. */
export const KNOWN_TYPES = [
  "Company", "Ledger", "Group", "StockItem", "StockGroup", "Unit", "Godown",
  "CostCentre", "CostCategory", "Voucher", "VoucherType", "Bills", "Currency",
] as const;
export type TallyType = (typeof KNOWN_TYPES)[number];

/**
 * ⚠ Anything not in KNOWN_TYPES raises a modal on the Tally desktop and kills
 * the port. Discovering new types is a MOCK-ONLY activity (guardrail P6).
 */
export function assertKnownType(type: string): asserts type is TallyType {
  if (!(KNOWN_TYPES as readonly string[]).includes(type)) {
    throw new Error(
      `Refusing to ask Tally for object type "${type}". It is not in the verified list, ` +
      `and an unrecognised type raises a modal dialog that blocks the XML port until ` +
      `someone restarts TallyPrime by hand. Add it to KNOWN_TYPES only after proving it ` +
      `against the mock.`,
    );
  }
}

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Filters ───────────────────────────────────────────────────────────────
//
// Written as structure, rendered with escaping. There is no way to hand this a
// raw `>=`.

export type Cmp = "gte" | "lte" | "gt" | "lt" | "eq" | "ne";

const CMP_XML: Record<Cmp, string> = {
  gte: "&gt;=",
  lte: "&lt;=",
  gt: "&gt;",
  lt: "&lt;",
  eq: "=",
  ne: "!=",
};

export type Filter =
  /** A TDL expression compared to a literal. `expr` must contain no < or >. */
  | { kind: "compare"; expr: string; cmp: Cmp; value: string | number }
  | { kind: "and"; of: Filter[] }
  | { kind: "or"; of: Filter[] };

/** `$Date` as a comparable YYYYMMDD integer — the form Tally can actually filter on. */
export const DATE_AS_INT =
  "($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date)";

export function dateBetween(fromYYYYMMDD: string, toYYYYMMDD: string): Filter {
  return {
    kind: "and",
    of: [
      { kind: "compare", expr: DATE_AS_INT, cmp: "gte", value: Number(fromYYYYMMDD) },
      { kind: "compare", expr: DATE_AS_INT, cmp: "lte", value: Number(toYYYYMMDD) },
    ],
  };
}

export function onDate(yyyymmdd: string): Filter {
  return { kind: "compare", expr: DATE_AS_INT, cmp: "eq", value: Number(yyyymmdd) };
}

export function alterIdAbove(watermark: number): Filter {
  return { kind: "compare", expr: "$AlterID", cmp: "gt", value: Math.max(0, Math.floor(watermark)) };
}

function renderFilter(f: Filter): string {
  switch (f.kind) {
    case "compare": {
      if (/[<>]/.test(f.expr)) {
        throw new Error(
          `Filter expression contains a raw < or >: ${f.expr}. Use the cmp field — a raw ` +
          `comparison operator inside TDL returns zero rows with no error.`,
        );
      }
      const v = typeof f.value === "number" ? String(f.value) : `"${esc(f.value)}"`;
      return `${f.expr} ${CMP_XML[f.cmp]} ${v}`;
    }
    case "and":
      return f.of.map(renderFilter).join(" AND ");
    case "or":
      return f.of.map(renderFilter).join(" OR ");
  }
}

// ── Collection export ─────────────────────────────────────────────────────

export interface CollectionRequest {
  /** Used as both the request ID and the COLLECTION NAME — they must agree. */
  id: string;
  type: TallyType | string;
  /** NATIVEMETHOD names. A `.*` wildcard here crashes TallyPrime. */
  fetch: string[];
  filter?: Filter;
  company?: string;
}

export function buildCollection(req: CollectionRequest): string {
  assertKnownType(req.type);

  for (const f of req.fetch) {
    if (f.includes("*")) {
      throw new Error(
        `Fetch field "${f}" contains a wildcard. A .* in a fetch list crashes TallyPrime ` +
        `outright — request the parent key instead and Tally returns the standard sub-fields.`,
      );
    }
  }

  const id = req.id.replace(/[^A-Za-z0-9_]/g, "");
  if (!id) throw new Error(`Collection id "${req.id}" has no usable characters.`);

  const fields = req.fetch.map((f) => `<NATIVEMETHOD>${esc(f)}</NATIVEMETHOD>`).join("");
  const filterName = `${id}F`;
  const filterRef = req.filter ? `<FILTER>${filterName}</FILTER>` : "";
  const filterSys = req.filter
    ? `<SYSTEM TYPE="Formulae" NAME="${filterName}">${renderFilter(req.filter)}</SYSTEM>`
    : "";
  const company = req.company
    ? `<SVCURRENTCOMPANY>${esc(req.company)}</SVCURRENTCOMPANY>`
    : "";

  return (
    `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>` +
    `<TYPE>Collection</TYPE><ID>${id}</ID></HEADER><BODY><DESC><STATICVARIABLES>` +
    `<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${company}</STATICVARIABLES><TDL><TDLMESSAGE>` +
    `<COLLECTION NAME="${id}" ISMODIFY="No"><TYPE>${req.type}</TYPE>${fields}${filterRef}</COLLECTION>` +
    `${filterSys}</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`
  );
}

// ── Report export ─────────────────────────────────────────────────────────

export function buildReport(report: string, company?: string, from?: string, to?: string): string {
  const dates = from && to
    ? `<SVFROMDATE>${esc(from)}</SVFROMDATE><SVTODATE>${esc(to)}</SVTODATE>`
    : "";
  const co = company ? `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>` : "";
  return (
    `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>` +
    `<TYPE>Data</TYPE><ID>${esc(report)}</ID></HEADER><BODY><DESC><STATICVARIABLES>` +
    `<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${co}${dates}</STATICVARIABLES>` +
    `</DESC></BODY></ENVELOPE>`
  );
}

// ── Reading a response ────────────────────────────────────────────────────

/**
 * Split a response into object blocks.
 *
 * Two traps pulling in opposite directions, both hit during this rebuild:
 *
 *   · Every response opens with a CMPINFO preamble full of COUNT tags —
 *     `<VOUCHER>0</VOUCHER>`, `<LEDGER>0</LEDGER>`. A naive split on `<TAG`
 *     gains a phantom object holding the whole preamble.
 *   · Tightening to `<TAG\s` fixes that only for elements carrying attributes.
 *     `<BILL NAME="…">` splits correctly; `<DSPACCNAME>` does not, and a report
 *     silently reads as zero rows.
 *
 * So: match both forms, then drop the count tags by shape.
 */
export function blocksOf(xml: string, tag: string): string[] {
  return xml
    .split(new RegExp(`<${tag}[\\s>]`, "i"))
    .slice(1)
    .filter((b) => !new RegExp(`^\\s*\\d*\\s*</${tag}>`, "i").test(b));
}

export function tagOf(xml: string, name: string): string | undefined {
  return xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, "i"))?.[1];
}

export function allTagsOf(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, "gi"))].map((m) => m[1]);
}

/**
 * Did Tally return an empty collection, or did our parser find nothing?
 *
 * Guardrail G7. These are different facts and they are currently
 * indistinguishable, which cost twenty minutes during planning with full
 * context and no time pressure.
 */
export interface ReadOutcome<T> {
  rows: T[];
  /** True when Tally itself returned no objects of this type. */
  emptyFromTally: boolean;
  /** True when Tally returned a payload our parser could not read. */
  unparsed: boolean;
  bytes: number;
  note: string;
}

export function readCollection<T>(
  xml: string,
  tag: string,
  parse: (block: string) => T | null,
): ReadOutcome<T> {
  const blocks = blocksOf(xml, tag);
  const rows = blocks.map(parse).filter((r): r is T => r !== null);
  const hasDataNode = /<DATA>/i.test(xml);
  const emptyFromTally = hasDataNode && blocks.length === 0;
  const unparsed = blocks.length > 0 && rows.length === 0;

  return {
    rows,
    emptyFromTally,
    unparsed,
    bytes: xml.length,
    note: unparsed
      ? `Tally returned ${blocks.length} <${tag}> block(s) and the parser read none of them. ` +
        `This is a PARSER failure, not an empty result.`
      : emptyFromTally
        ? `Tally returned no <${tag}> objects. The request reached it and the answer was empty.`
        : `${rows.length} row(s).`,
  };
}
