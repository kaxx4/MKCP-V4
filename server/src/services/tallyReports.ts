/**
 * Tally's own reports, fetched and parsed into rows.
 *
 * ── Why ask Tally instead of computing it ─────────────────────────────────
 *
 * A report is a COMPUTED answer. Bills Payable already knows each bill's due
 * date — derived from that bill's own credit period, not the party's — and how
 * many days it is overdue. The app recomputes exactly that from vouchers, and
 * it is where the journal-settlement defect lived: payments aimed at bills that
 * were already closed, because a discount-allowed Journal was not counted as a
 * settlement. Asking the system that owns the answer removes a whole class of
 * that.
 *
 * ── The shape they all share ──────────────────────────────────────────────
 *
 * A report is a FLAT stream of elements, not a list of records. Each record
 * begins at a marker element and runs until the next one; the fields between
 * may be siblings of the marker or nested under it, and the nesting is not
 * consistent between reports. Verified 17-Sep-2026 by dumping the element
 * skeleton of each:
 *
 *   Bills Payable    <BILLFIXED> starts a record; BILLCL/BILLDUE/BILLOVERDUE
 *                    are SIBLINGS that follow it, not children
 *   Trial Balance    <DSPACCNAME> starts; the amounts hang two levels down
 *                    inside DSPACCINFO
 *   Ratio Analysis   <RATIONAME> starts; RATIOVALUE may be ABSENT, because
 *                    some names are section headings rather than ratios
 *
 * So one parser serves all of them: split on the marker, then pull named leaf
 * tags from each slice regardless of depth. A record with a missing field gets
 * an empty string — never a zero, which would be a number nobody measured.
 *
 * ── Cost, which decides how these may be used ─────────────────────────────
 *
 * Tally's XML port is single-threaded, and a report holds it for as long as it
 * runs. Measured on the live books:
 *
 *   Bills Payable/Receivable, GST Rate Setup, Cheque Register,
 *   Ratio Analysis, Balance Sheet, P&L, Trial Balance, Cash Flow,
 *   Funds Flow, Group Summary ............................ seconds
 *   Stock Summary, Godown Summary, Movement Analysis,
 *   Reorder Status ....................................... OVER 60 SECONDS
 *
 * The slow four are marked `slow` and must never be reached from a page load.
 * That is the reason the whole thing runs as a tracked job rather than a fetch.
 *
 * NOT INCLUDED: "List of Accounts". It answers, at 10.8 MB, and it is the
 * master list the masters sync already pulls — a second copy through a
 * different path is two things to disagree (G1).
 */
import { tallyPost } from "../tally.js";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type FieldKind = "text" | "money" | "qty" | "date" | "int" | "rate";

export interface ReportField {
  /** The Tally element name. */
  tag: string;
  /** What the row key is called once parsed. */
  as: string;
  kind: FieldKind;
}

export interface ReportDef {
  /** Stable key used in the database and the UI. Never the display name. */
  key: string;
  /** Exactly what Tally is asked for. A wrong name answers
   *  `Could not find Report` and costs nothing. */
  tallyName: string;
  label: string;
  /** One line an operator would recognise. */
  hint: string;
  /** The element that begins a record. */
  startTag: string;
  fields: ReportField[];
  /** Sends SVFROMDATE/SVTODATE. Balance-type reports ignore them. */
  period: boolean;
  /** Over 60 seconds against the live books — never on a page load. */
  slow?: boolean;
  /** Derive extra columns after parsing. See the bills reports' sign note. */
  derive?: (row: ReportRow) => void;
}

/**
 * Both bills reports carry Tally's OWN sign, and the two disagree:
 * payables come back POSITIVE (`21280236.00`) and receivables NEGATIVE
 * (`-438.00`) for the same idea — money outstanding. Measured across both
 * reports on the live books, 17-Sep-2026.
 *
 * A page that summed `amount` across the two would net them against each other
 * and show a number that means nothing. So `outstanding` is added as the
 * MAGNITUDE, and the raw `amount` is kept beside it rather than overwritten —
 * the sign is Tally's statement about direction and is not ours to discard.
 */
const billOutstanding = (row: ReportRow): void => {
  const a = row.amount;
  row.outstanding = typeof a === "number" ? Math.abs(a) : null;
};

export const REPORTS: ReportDef[] = [
  {
    key: "bills-payable", tallyName: "Bills Payable", label: "Bills payable",
    hint: "What we owe, bill by bill, with each bill's own due date",
    startTag: "BILLFIXED", period: true, derive: billOutstanding,
    fields: [
      { tag: "BILLDATE", as: "billDate", kind: "date" },
      { tag: "BILLREF", as: "billRef", kind: "text" },
      { tag: "BILLPARTY", as: "party", kind: "text" },
      { tag: "BILLCL", as: "amount", kind: "money" },
      { tag: "BILLDUE", as: "dueDate", kind: "date" },
      { tag: "BILLOVERDUE", as: "overdueDays", kind: "int" },
    ],
  },
  {
    key: "bills-receivable", tallyName: "Bills Receivable", label: "Bills receivable",
    hint: "What is owed to us, bill by bill, with days overdue",
    startTag: "BILLFIXED", period: true, derive: billOutstanding,
    fields: [
      { tag: "BILLDATE", as: "billDate", kind: "date" },
      { tag: "BILLREF", as: "billRef", kind: "text" },
      { tag: "BILLPARTY", as: "party", kind: "text" },
      { tag: "BILLCL", as: "amount", kind: "money" },
      { tag: "BILLDUE", as: "dueDate", kind: "date" },
      { tag: "BILLOVERDUE", as: "overdueDays", kind: "int" },
    ],
  },
  {
    key: "gst-rate-setup", tallyName: "GST Rate Setup", label: "GST rates and HSN",
    hint: "Every group's dated GST rate and HSN code, from Tally's own setup",
    startTag: "GSTMASTERDISPNAME", period: false,
    fields: [
      { tag: "GSTMASTERDISPNAME", as: "name", kind: "text" },
      { tag: "GSTRATEAPPLFROM", as: "rateFrom", kind: "date" },
      { tag: "GSTRATETAXTYPE", as: "taxability", kind: "text" },
      { tag: "GSTRATEIGSTRATE", as: "igstRate", kind: "rate" },
      { tag: "HSNSACAPPLFROM", as: "hsnFrom", kind: "date" },
      { tag: "HSNSACCODE", as: "hsn", kind: "text" },
    ],
  },
  {
    key: "cheque-register", tallyName: "Cheque Register", label: "Cheque register",
    hint: "Per bank: how many cheques are unreconciled — the BRS gap",
    startTag: "CRPARTICULARS", period: true,
    fields: [
      { tag: "CRPARTICULARS", as: "bank", kind: "text" },
      { tag: "CRNOTUSEDCHQS", as: "notUsed", kind: "int" },
      { tag: "CRUNRECONCILEDCHQS", as: "unreconciled", kind: "int" },
      { tag: "CRRECONCILEDCHQS", as: "reconciled", kind: "int" },
      { tag: "CRBLANKCHQS", as: "blank", kind: "int" },
      { tag: "CRCANCELLEDCHQS", as: "cancelled", kind: "int" },
      { tag: "CROUTOFPERIOD", as: "outOfPeriod", kind: "int" },
      { tag: "CRTOTALCHQS", as: "total", kind: "int" },
    ],
  },
  {
    key: "ratio-analysis", tallyName: "Ratio Analysis", label: "Ratios",
    hint: "Working capital, cash, debtors, and what is due today",
    startTag: "RATIONAME", period: true,
    fields: [
      { tag: "RATIONAME", as: "name", kind: "text" },
      { tag: "RATIOVALUE", as: "value", kind: "money" },
    ],
  },
  {
    key: "trial-balance", tallyName: "Trial Balance", label: "Trial balance",
    hint: "Closing debit and credit by group",
    startTag: "DSPACCNAME", period: true,
    fields: [
      { tag: "DSPDISPNAME", as: "name", kind: "text" },
      { tag: "DSPCLDRAMTA", as: "debit", kind: "money" },
      { tag: "DSPCLCRAMTA", as: "credit", kind: "money" },
    ],
  },
  {
    key: "group-summary", tallyName: "Group Summary", label: "Group summary",
    hint: "The same, one level down",
    startTag: "DSPACCNAME", period: true,
    fields: [
      { tag: "DSPDISPNAME", as: "name", kind: "text" },
      { tag: "DSPCLDRAMTA", as: "debit", kind: "money" },
      { tag: "DSPCLCRAMTA", as: "credit", kind: "money" },
    ],
  },
  {
    key: "balance-sheet", tallyName: "Balance Sheet", label: "Balance sheet",
    hint: "Assets and liabilities as Tally states them",
    startTag: "BSNAME", period: true,
    fields: [
      { tag: "DSPDISPNAME", as: "name", kind: "text" },
      { tag: "BSSUBAMT", as: "sub", kind: "money" },
      { tag: "BSMAINAMT", as: "amount", kind: "money" },
    ],
  },
  {
    key: "profit-and-loss", tallyName: "Profit and Loss", label: "Profit and loss",
    hint: "The period's P&L",
    startTag: "DSPACCNAME", period: true,
    fields: [
      { tag: "DSPDISPNAME", as: "name", kind: "text" },
      { tag: "PLSUBAMT", as: "sub", kind: "money" },
      { tag: "PLAMT", as: "amount", kind: "money" },
    ],
  },
  {
    key: "cash-flow", tallyName: "Cash Flow", label: "Cash flow",
    hint: "Inflow and outflow by period",
    startTag: "DSPPERIOD", period: true,
    fields: [
      { tag: "DSPPERIOD", as: "period", kind: "text" },
      { tag: "DSPDRAMTA", as: "inflow", kind: "money" },
      { tag: "DSPCRAMTA", as: "outflow", kind: "money" },
      { tag: "DSPCLAMTA", as: "net", kind: "money" },
    ],
  },
  {
    key: "funds-flow", tallyName: "Funds Flow", label: "Funds flow",
    hint: "Sources and uses by period",
    startTag: "DSPPERIOD", period: true,
    fields: [
      { tag: "DSPPERIOD", as: "period", kind: "text" },
      { tag: "DSPDRAMTA", as: "sources", kind: "money" },
      { tag: "DSPCRAMTA", as: "uses", kind: "money" },
      { tag: "DSPCLAMTA", as: "net", kind: "money" },
    ],
  },
  {
    key: "stock-summary", tallyName: "Stock Summary", label: "Stock summary",
    hint: "Closing quantity, rate and value by group",
    startTag: "DSPDISPNAME", period: true, slow: true,
    fields: [
      { tag: "DSPDISPNAME", as: "name", kind: "text" },
      { tag: "DSPCLQTY", as: "qty", kind: "qty" },
      { tag: "DSPCLRATE", as: "rate", kind: "money" },
      { tag: "DSPCLAMTA", as: "value", kind: "money" },
    ],
  },
  {
    key: "godown-summary", tallyName: "Godown Summary", label: "Godown summary",
    hint: "The same, per godown",
    startTag: "DSPDISPNAME", period: true, slow: true,
    fields: [
      { tag: "DSPDISPNAME", as: "name", kind: "text" },
      { tag: "DSPCLQTY", as: "qty", kind: "qty" },
      { tag: "DSPCLRATE", as: "rate", kind: "money" },
      { tag: "DSPCLAMTA", as: "value", kind: "money" },
    ],
  },
  {
    key: "movement-analysis", tallyName: "Movement Analysis", label: "Movement analysis",
    hint: "In and out by group, with cost against price — margin, computed",
    startTag: "DSPDISPNAME", period: true, slow: true,
    fields: [
      { tag: "DSPDISPNAME", as: "name", kind: "text" },
      { tag: "STKINQTY", as: "inQty", kind: "qty" },
      { tag: "STKINCOST", as: "inRate", kind: "money" },
      { tag: "STKINVALUE", as: "inValue", kind: "money" },
      { tag: "STKOUTQTY", as: "outQty", kind: "qty" },
      { tag: "STKOUTPRICE", as: "outRate", kind: "money" },
      { tag: "STKOUTVALUE", as: "outValue", kind: "money" },
    ],
  },
  {
    key: "reorder-status", tallyName: "Reorder Status", label: "Reorder status",
    hint: "Closing stock against the reorder level, per item",
    startTag: "ROSNAME", period: true, slow: true,
    fields: [
      { tag: "ROSNAME", as: "item", kind: "text" },
      { tag: "ROSCLSTOCK", as: "closing", kind: "qty" },
      { tag: "ROSREFERENCE", as: "reference", kind: "qty" },
    ],
  },
];

export const reportByKey = (key: string): ReportDef | undefined =>
  REPORTS.find((r) => r.key === key);

// ── Value parsing ───────────────────────────────────────────────────────────

/**
 * A Tally amount.
 *
 * Three shapes, all real: a plain signed number (`-1918494.24`), an Indian
 * grouped figure with a side (`3,79,56,526.73 Dr`), and a percentage
 * (`5 %`). `Cr` is returned NEGATIVE so a column can be summed without
 * knowing which report it came from.
 *
 * Returns null, never 0, when there is nothing to read — a zero here would be
 * a figure nobody measured sitting in a column of figures somebody did.
 */
export function money(raw: string): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const m = /-?[\d,]*\.?\d+/.exec(s.replace(/\s/g, ""));
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return /\bCr\b/i.test(s) ? -Math.abs(n) : n;
}

/** A quantity: the LEADING number, with its unit kept beside it. */
export function qty(raw: string): { value: number | null; unit: string } {
  const s = String(raw ?? "").trim();
  const m = /-?[\d,]*\.?\d+/.exec(s);
  const unit = s.replace(/^[\s\-\d,.]+/, "").trim().split(/\s|=/)[0] ?? "";
  return {
    value: m ? parseFloat(m[0].replace(/,/g, "")) : null,
    unit,
  };
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * `14-Mar-26` or `20260314` → `2026-03-14`.
 *
 * Reports print dates for people; collections return them as YYYYMMDD. Both
 * arrive here, so both are handled rather than assumed.
 */
export function tallyDate(raw: string): string {
  const s = String(raw ?? "").trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/.exec(s);
  if (!m) return "";
  const yy = m[3].length === 2 ? `20${m[3]}` : m[3];
  const mm = MONTHS[m[2].toLowerCase()];
  return mm ? `${yy}-${mm}-${m[1].padStart(2, "0")}` : "";
}

const leaf = (slice: string, tag: string): string => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "i").exec(slice);
  return m ? m[1].trim() : "";
};

export type ReportRow = Record<string, string | number | null>;

/**
 * Split a report into records and read each one's fields.
 *
 * The marker element may also BE a field (Ratio Analysis, Stock Summary), so
 * the slice starts at the marker and the marker's own text is readable inside
 * it. A record whose every field is empty is dropped: reports emit spacer rows
 * for layout, and they are not data.
 */
export function parseReport(def: ReportDef, xml: string): ReportRow[] {
  const starts = [...xml.matchAll(new RegExp(`<${def.startTag}(?:\\s[^>]*)?>`, "gi"))]
    .map((m) => m.index ?? 0);
  const rows: ReportRow[] = [];

  for (let i = 0; i < starts.length; i++) {
    const slice = xml.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : undefined);
    const row: ReportRow = {};
    let any = false;
    for (const f of def.fields) {
      const raw = leaf(slice, f.tag);
      if (raw) any = true;
      switch (f.kind) {
        case "money": row[f.as] = money(raw); break;
        case "rate": row[f.as] = money(raw); break;
        case "int": {
          const n = parseInt(raw.replace(/[^\d-]/g, ""), 10);
          row[f.as] = Number.isFinite(n) ? n : null;
          break;
        }
        case "date": row[f.as] = tallyDate(raw); break;
        case "qty": {
          const q = qty(raw);
          row[f.as] = q.value;
          row[`${f.as}Unit`] = q.unit;
          break;
        }
        default: row[f.as] = raw;
      }
    }
    if (any) { def.derive?.(row); rows.push(row); }
  }
  return rows;
}

export interface ReportResult {
  key: string;
  rows: ReportRow[];
  bytes: number;
  elapsedMs: number;
}

/**
 * Ask Tally for one report.
 *
 * A wrong report name is NOT a crash: Tally answers `Could not find Report`
 * inside a LINEERROR, which is why report names are safe to probe while
 * collection types are not. That answer is turned into a thrown error here so
 * a caller cannot mistake "no such report" for "a report with no rows".
 */
export async function fetchReport(
  tallyUrl: string,
  company: string,
  def: ReportDef,
  period: { from: string; to: string },
  timeoutMs = def.slow ? 420_000 : 90_000,
): Promise<ReportResult> {
  const t0 = Date.now();
  const dates = def.period
    ? `<SVFROMDATE>${period.from.replace(/-/g, "")}</SVFROMDATE><SVTODATE>${period.to.replace(/-/g, "")}</SVTODATE>`
    : "";
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>${esc(def.tallyName)}</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>${dates}</STATICVARIABLES></DESC></BODY></ENVELOPE>`;

  const res = (await tallyPost(tallyUrl, xml, timeoutMs, true)) as string;
  const err = /<LINEERROR>([\s\S]*?)<\/LINEERROR>/i.exec(res);
  if (err) throw new Error(`Tally: ${err[1].replace(/&apos;/g, "'").trim()}`);

  return {
    key: def.key,
    rows: parseReport(def, res),
    bytes: res.length,
    elapsedMs: Date.now() - t0,
  };
}
