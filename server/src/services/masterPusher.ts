/**
 * Creating a master in Tally — the write path that has only ever been a script.
 *
 * ── Why this has to exist ─────────────────────────────────────────────────
 *
 * A party phones and reads out an order. If they are new, the call currently
 * dead-ends: the push guard refuses an unknown party name by design, and the
 * master cache has a ten-minute TTL, so a party created by hand in Tally at
 * 10:02 is unusable until 10:12 — squarely inside the busiest hour of the day.
 *
 * ── The trap this encodes ─────────────────────────────────────────────────
 *
 * **State and GST identity must be NESTED.** Sent as flat fields,
 * `LEDSTATENAME` and `GSTIN` are ACCEPTED — Tally answers `CREATED=1` — and
 * then read back EMPTY. That is the worst possible failure here, because:
 *
 *   · the push guard needs the state to choose CGST+SGST against IGST, and
 *   · a voucher to a party with no state lands in a GSTR exception bucket,
 *     while balancing, verifying, and reading back byte-identical.
 *
 * So a "successful" flat create produces a party that silently files wrong.
 * The only defence is to nest, and then to READ THE MASTER BACK and confirm
 * the state actually stuck — which `createLedger` does before reporting success.
 */
import { tallyPost } from "../tally.js";
import { escapeXml } from "./xml.js";
import { invalidateMasters } from "./tallyMasters.js";
import { blocksOf } from "./tallyRequest.js";
import { refuseCompanyWrite } from "./tallyRole.js";

export interface NewLedger {
  name: string;
  /** e.g. "SUNDRY DEBTORS". The group decides how the party behaves. */
  parent: string;
  state: string;
  country?: string;
  pincode?: string;
  /**
   * One line per element, or a single string which may contain newlines.
   *
   * Tally stores ADDRESS as SEVERAL lines inside ADDRESS.LIST and this house's
   * parties really use them: 235 of 341 have more than one, and one has six.
   * A single joined string was emitted as one <ADDRESS> element, so
   * "PLOT NO. 13, GRAIN MARKET
GILL ROAD, LUDHIANA-141003" came back as one
   * run-on line — verified against this company, 17-Sep-2026.
   */
  address?: string | string[];
  mailingName?: string;
  gstin?: string;
  /** "Regular" | "Composition" | "Unregistered" | "Consumer" */
  gstRegistrationType?: string;
  phone?: string;
  contact?: string;
  email?: string;
  /** e.g. "20 Days" — the business modal. Lives on the bill, not the party. */
  creditPeriod?: string;
  billWise?: boolean;
  /** YYYYMMDD. Tally's GST registration is DATED; a backdated voucher needs a
   *  registration in force on that date. Defaults to the FY start. */
  applicableFrom?: string;
}

export interface MasterPushResult {
  ok: boolean;
  created: number;
  altered: number;
  errors: number;
  exceptions: number;
  lineErrors: string[];
  /** What a read-back actually found. Absent when the write itself failed. */
  readBack?: { name: string; state: string; gstin: string; parent: string } | null;
  /** Why it failed, or what is suspicious about a nominal success. */
  notes: string[];
  requestXml: string;
  responseXml: string;
}

const esc = escapeXml;   // xml.ts (G1)

const num = (xml: string, tag: string): number => {
  const m = new RegExp(`<${tag}>\\s*(\\d+)\\s*</${tag}>`, "i").exec(xml);
  return m ? Number(m[1]) : 0;
};

function envelope(company: string, body: string): string {
  return `<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY><IMPORTDATA>
    <REQUESTDESC><REPORTNAME>All Masters</REPORTNAME>
      <STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
    </REQUESTDESC>
    <REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${body}</TALLYMESSAGE></REQUESTDATA>
  </IMPORTDATA></BODY>
</ENVELOPE>`;
}

/**
 * ADDRESS.LIST with one <ADDRESS> per line.
 *
 * Splitting on newlines as well as taking an array, because callers hold it
 * both ways and a newline inside a single <ADDRESS> is not a second line to
 * Tally — it is whitespace, and it comes back collapsed.
 */
/** Line break in either convention. Kept as a named constant because the
 *  literal form kept getting mangled by shell heredocs. */
const NEWLINE = new RegExp("\r?\n");

function addressBlock(address: string | string[] | undefined): string {
  const lines = (Array.isArray(address) ? address : String(address ?? "").split(NEWLINE))
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return "";
  return `<ADDRESS.LIST TYPE="String">${lines.map((l) => `<ADDRESS>${esc(l)}</ADDRESS>`).join("")}</ADDRESS.LIST>`;
}

/**
 * The ledger body.
 *
 * Exported so a test can assert the SHAPE without writing to Tally — the
 * nesting is the whole point, and it is worth being able to check it without
 * touching the live books.
 */
export function buildLedgerXml(l: NewLedger, action: "Create" | "Alter" = "Create"): string {
  const from = l.applicableFrom ?? "20260401";
  const mailing = l.mailingName ?? l.name;

  /* Both nested blocks are emitted even when sparse. A LEDGSTREGDETAILS.LIST
     with no GSTIN is how an unregistered party is stated DELIBERATELY — the
     alternative, omitting the block, is indistinguishable from forgetting.

     PARTYGSTIN is emitted FLAT as well, and that is not redundancy. Dumping a
     party Tally's own UI created beside one this builder created (17-Sep-2026,
     `NATIVEMETHOD *`) shows PARTYGSTIN present on the first and absent on the
     second: it is a STORED field, not a view of the nested block. The sync
     reads exactly that field, so without it an inline-created party arrives in
     the mirror with no GSTIN, and a purchase against it files into a GSTR-2
     exception with nothing on screen to say so.
     Ruled out first: APPLICABLEFROM. Four parties created at 2022/2024/2025/
     2026-04-01 all came back with an empty PartyGSTIN, so the date is not the
     variable — the missing tag is. */
  return `
    <LEDGER NAME="${esc(l.name)}" ACTION="${action}">
      <NAME>${esc(l.name)}</NAME>
      <PARENT>${esc(l.parent)}</PARENT>
      <ISBILLWISEON>${l.billWise === false ? "No" : "Yes"}</ISBILLWISEON>
      ${l.phone ? `<LEDGERMOBILE>${esc(l.phone)}</LEDGERMOBILE>` : ""}
      ${l.contact ? `<LEDGERCONTACT>${esc(l.contact)}</LEDGERCONTACT>` : ""}
      ${l.email ? `<EMAIL>${esc(l.email)}</EMAIL>` : ""}
      ${l.creditPeriod ? `<BILLCREDITPERIOD>${esc(l.creditPeriod)}</BILLCREDITPERIOD>` : ""}
      <COUNTRYOFRESIDENCE>${esc(l.country ?? "India")}</COUNTRYOFRESIDENCE>
      ${l.gstin ? `<PARTYGSTIN>${esc(l.gstin)}</PARTYGSTIN>` : ""}
      <LEDMAILINGDETAILS.LIST>
        <APPLICABLEFROM>${from}</APPLICABLEFROM>
        <MAILINGNAME>${esc(mailing)}</MAILINGNAME>
        ${addressBlock(l.address)}
        <STATE>${esc(l.state)}</STATE>
        <COUNTRY>${esc(l.country ?? "India")}</COUNTRY>
        ${l.pincode ? `<PINCODE>${esc(l.pincode)}</PINCODE>` : ""}
      </LEDMAILINGDETAILS.LIST>
      <!-- Element order copied from a party Tally itself stores
           (probe-gstreg-block.ts against a real dealer): APPLICABLEFROM,
           GSTREGISTRATIONTYPE, STATE, PLACEOFSUPPLY, GSTIN.

           Order was NOT load-bearing — it was changed on the hypothesis that it
           was, and the GSTIN still read back empty, so the hypothesis was wrong.
           The real cause was in the read, not the write (see readLedger). Kept
           matching Tally's own shape anyway, on the principle that copying what
           it already stores costs nothing; recorded as "matches" rather than
           "required" so nobody later treats an untested guess as a finding. -->
      <LEDGSTREGDETAILS.LIST>
        <APPLICABLEFROM>${from}</APPLICABLEFROM>
        <GSTREGISTRATIONTYPE>${esc(l.gstRegistrationType ?? (l.gstin ? "Regular" : "Unregistered"))}</GSTREGISTRATIONTYPE>
        <STATE>${esc(l.state)}</STATE>
        <PLACEOFSUPPLY>${esc(l.state)}</PLACEOFSUPPLY>
        ${l.gstin ? `<GSTIN>${esc(l.gstin)}</GSTIN>` : ""}
      </LEDGSTREGDETAILS.LIST>
    </LEDGER>`;
}

/**
 * Read one ledger back, to find out what Tally actually kept.
 *
 * ── Why this asks for the nested block ────────────────────────────────────
 *
 * Asking a Collection for `GSTIN` on a freshly created ledger returns NOTHING
 * — not an empty tag, no tag at all — while a `NATIVEMETHOD *` dump of the
 * same party shows the GSTIN present both flat and inside
 * LEDGSTREGDETAILS.LIST. Measured 13-Sep-2026, with and without PartyGSTIN in
 * the fetch list; identical either way.
 *
 * That cost two wrong diagnoses before the bytes were looked at: first the
 * element order was "fixed" (it was already right), then the create was
 * blamed (it was correct all along). The flat `$GSTIN` on a Ledger is a
 * DERIVED method resolving a DATED registration, and it does not resolve here.
 * The nested block is where the stored truth is, so that is what gets read.
 */
async function readLedger(
  tallyUrl: string, company: string, name: string,
): Promise<{ name: string; state: string; gstin: string; parent: string } | null> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MpRead</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MpRead" ISMODIFY="No"><TYPE>Ledger</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>Parent</NATIVEMETHOD>
<NATIVEMETHOD>LedStateName</NATIVEMETHOD><NATIVEMETHOD>GSTIN</NATIVEMETHOD><NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD>
<NATIVEMETHOD>LedGstRegDetails</NATIVEMETHOD><NATIVEMETHOD>LedMailingDetails</NATIVEMETHOD>
<FILTER>MpReadF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MpReadF">$Name = "${esc(name)}"</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;

  const raw: string = await tallyPost(tallyUrl, xml, 30_000, true);
  /* blocksOf, not a bare regex: CMPINFO carries <LEDGER>205</LEDGER> as a
     COUNT, so a naive test matches an empty collection and reports a party
     that is not there. */
  if (blocksOf(raw, "LEDGER").length === 0) return null;

  const f = (t: string, src = raw) =>
    (new RegExp(`<${t}[^>]*>([^<]*)</${t}>`, "i").exec(src)?.[1] ?? "").replace(/&#4;\s*/g, "").trim();

  const regBlock = /<LEDGSTREGDETAILS\.LIST>([\s\S]*?)<\/LEDGSTREGDETAILS\.LIST>/i.exec(raw)?.[1] ?? "";
  const mailBlock = /<LEDMAILINGDETAILS\.LIST>([\s\S]*?)<\/LEDMAILINGDETAILS\.LIST>/i.exec(raw)?.[1] ?? "";

  return {
    name: f("NAME") || name,
    // The nested STATE is the stored value; LEDSTATENAME is the derived one.
    state: f("STATE", regBlock) || f("STATE", mailBlock) || f("LEDSTATENAME"),
    gstin: f("GSTIN", regBlock) || f("GSTIN") || f("PARTYGSTIN"),
    parent: f("PARENT"),
  };
}

/**
 * Create a party in Tally and PROVE it is usable before saying so.
 *
 * The read-back is not belt-and-braces. A flat create returns CREATED=1 and
 * leaves the state empty, so `CREATED=1` on its own is not evidence that the
 * party can be invoiced — and a party with no state produces vouchers that
 * balance, verify, and file wrong.
 */
export async function createLedger(
  tallyUrl: string, company: string, ledger: NewLedger,
  action: "Create" | "Alter" = "Create",
): Promise<MasterPushResult> {
  const notes: string[] = [];

  const companyRefusal = refuseCompanyWrite(company);
  if (companyRefusal) {
    return {
      ok: false, created: 0, altered: 0, errors: 0, exceptions: 0, lineErrors: [],
      notes: [companyRefusal], requestXml: "", responseXml: "",
    };
  }

  if (!ledger.state?.trim()) {
    return {
      ok: false, created: 0, altered: 0, errors: 0, exceptions: 0, lineErrors: [],
      notes: ["Refused before sending: a party with no state cannot be invoiced correctly. " +
        "The tax head (CGST+SGST against IGST) is chosen from it, and a voucher to a stateless " +
        "party balances, verifies, reads back identical, and still lands in a GSTR exception bucket."],
      requestXml: "", responseXml: "",
    };
  }

  const body = buildLedgerXml(ledger, action);
  const requestXml = envelope(company, body);
  const responseXml: string = await tallyPost(tallyUrl, requestXml, 60_000, true);

  const created = num(responseXml, "CREATED");
  const altered = num(responseXml, "ALTERED");
  const errors = num(responseXml, "ERRORS");
  const exceptions = num(responseXml, "EXCEPTIONS");
  const lineErrors = [...responseXml.matchAll(/<LINEERROR>([^<]*)/gi)].map((m) => m[1].trim());

  const wrote = action === "Create" ? created > 0 : altered > 0;

  /* ── Invalidate HERE, not in the caller ──────────────────────────────────
     The master cache has a ten-minute TTL, so without this a party created at
     10:02 is refused by the push guard — which reads that cache — until 10:12,
     squarely inside the busiest hour. `invalidateMasters()` has always existed;
     the problem is that every caller had to remember it, and this codebase has
     already concluded that a guard you have to remember is not a guard.

     Invalidated on ANY write, including a failed-verification one: if Tally
     changed anything at all, the cache is stale, and being wrong about that is
     more expensive than one extra reload. */
  if (wrote || altered > 0 || created > 0) invalidateMasters();

  if (!wrote) {
    notes.push(`Tally did not ${action.toLowerCase()} the ledger.` +
      (exceptions > 0 ? " EXCEPTIONS=1 with no message is the silent-failure signature." : ""));
    return { ok: false, created, altered, errors, exceptions, lineErrors, notes, requestXml, responseXml };
  }

  const readBack = await readLedger(tallyUrl, company, ledger.name);
  if (!readBack) {
    notes.push("Tally reported success and the ledger cannot be read back. Do not use this party.");
    return { ok: false, created, altered, errors, exceptions, lineErrors, readBack: null, notes, requestXml, responseXml };
  }

  /* The check that matters. This is the exact failure a flat create produces. */
  if (!readBack.state) {
    notes.push(
      `Tally reported ${action.toLowerCase()}=1 and the state read back EMPTY. The party exists and ` +
      `is NOT safe to invoice — the push guard cannot choose a tax head without it. ` +
      `This is what happens when state is sent as a flat field instead of inside ` +
      `LEDMAILINGDETAILS.LIST / LEDGSTREGDETAILS.LIST.`,
    );
    return { ok: false, created, altered, errors, exceptions, lineErrors, readBack, notes, requestXml, responseXml };
  }

  if (ledger.gstin && !readBack.gstin) {
    notes.push(`GSTIN was sent and read back empty — the party would file as B2C. ` +
      `Legitimate for an unregistered dealer, wrong for this one.`);
    return { ok: false, created, altered, errors, exceptions, lineErrors, readBack, notes, requestXml, responseXml };
  }

  notes.push(`Read back with state "${readBack.state}"${readBack.gstin ? ` and GSTIN ${readBack.gstin}` : " and no GSTIN (B2C)"} — usable.`);
  return { ok: true, created, altered, errors, exceptions, lineErrors, readBack, notes, requestXml, responseXml };
}

/** Remove a master. Used by tests; a real one should be marked inactive instead. */
export async function deleteLedger(
  tallyUrl: string, company: string, name: string,
): Promise<MasterPushResult> {
  const companyRefusal = refuseCompanyWrite(company);
  if (companyRefusal) {
    return {
      ok: false, created: 0, altered: 0, errors: 0, exceptions: 0, lineErrors: [],
      notes: [companyRefusal], requestXml: "", responseXml: "",
    };
  }
  const body =`<LEDGER NAME="${esc(name)}" ACTION="Delete"><NAME>${esc(name)}</NAME></LEDGER>`;
  const requestXml = envelope(company, body);
  const responseXml: string = await tallyPost(tallyUrl, requestXml, 60_000, true);
  const deleted = num(responseXml, "DELETED");
  if (deleted > 0) invalidateMasters();
  return {
    ok: deleted > 0, created: 0, altered: 0, deleted, errors: num(responseXml, "ERRORS"),
    exceptions: num(responseXml, "EXCEPTIONS"),
    lineErrors: [...responseXml.matchAll(/<LINEERROR>([^<]*)/gi)].map((m) => m[1].trim()),
    notes: deleted > 0 ? [] : ["Tally did not delete the ledger."],
    requestXml, responseXml,
  } as MasterPushResult & { deleted: number };
}

/* ═══ Stock item, unit and godown builders (rebuild batch 0.4, 3-Nov-2026) ═══
   The ERP's "New product" and "Create item" need these. Same rules as the
   ledger builder above: GST goes in NESTED blocks, and success means a
   read-back found what was sent, never CREATED=1 alone (G7). */

export interface NewStockItem {
  name: string;
  /** Stock group, e.g. "BICYCLE PARTS ( 87149990 )". */
  parent: string;
  /** Base unit that already exists in the company, e.g. "PC". */
  baseUnit: string;
  /** Combined GST rate in percent, e.g. 18. Split into CGST and SGST halves. */
  gstRate: number;
  hsn?: string;
  /** YYYYMMDD. Tally's item GST is DATED. Defaults to the FY start. */
  applicableFrom?: string;
  taxability?: "Taxable" | "Exempt" | "Nil Rated";
}

export interface NewUnit {
  name: string;
  /** Decimal places the unit holds. 0 for pieces. */
  decimals?: number;
}

export interface NewGodown {
  name: string;
}

export interface NewCostCentre {
  name: string;
  /** The cost centre it sits under; empty for a top-level one. */
  parent?: string;
  /** The cost category; empty means Tally's own "Primary Cost Category". */
  category?: string;
}

export interface MasterWriteResult {
  ok: boolean;
  created: number;
  deleted: number;
  errors: number;
  exceptions: number;
  lineErrors: string[];
  notes: string[];
  requestXml: string;
  responseXml: string;
}

/** One rate row per duty head, in the order Tally stores them. */
function rateRows(gstRate: number): string {
  const half = Math.round((gstRate / 2) * 100) / 100;
  const row = (head: string, rate: number, type = "Based on Value") => `
          <RATEDETAILS.LIST>
            <GSTRATEDUTYHEAD>${head}</GSTRATEDUTYHEAD>
            <GSTRATEVALUATIONTYPE>${type}</GSTRATEVALUATIONTYPE>
            <GSTRATE>${rate}</GSTRATE>
          </RATEDETAILS.LIST>`;
  return row("CGST", half) + row("SGST/UTGST", half) + row("IGST", gstRate)
    + row("Cess", 0, "&#4; Not Applicable");
}

/** Exported so a test can assert the nesting without touching Tally. */
export function buildStockItemXml(i: NewStockItem, action: "Create" | "Alter" = "Create"): string {
  const from = i.applicableFrom ?? "20260401";
  return `
    <STOCKITEM NAME="${esc(i.name)}" ACTION="${action}">
      <NAME>${esc(i.name)}</NAME>
      <PARENT>${esc(i.parent)}</PARENT>
      <BASEUNITS>${esc(i.baseUnit)}</BASEUNITS>
      <ISBATCHWISEON>No</ISBATCHWISEON>
      <GSTAPPLICABLE>&#4; Applicable</GSTAPPLICABLE>
      <GSTDETAILS.LIST>
        <APPLICABLEFROM>${from}</APPLICABLEFROM>
        ${i.hsn ? `<HSNCODE>${esc(i.hsn)}</HSNCODE>` : ""}
        <TAXABILITY>${i.taxability ?? "Taxable"}</TAXABILITY>
        <STATEWISEDETAILS.LIST>
          <STATENAME>&#4; Any</STATENAME>${rateRows(i.gstRate)}
        </STATEWISEDETAILS.LIST>
      </GSTDETAILS.LIST>
    </STOCKITEM>`;
}

export function buildUnitXml(u: NewUnit, action: "Create" | "Alter" = "Create"): string {
  return `
    <UNIT NAME="${esc(u.name)}" ACTION="${action}">
      <NAME>${esc(u.name)}</NAME>
      <ISSIMPLEUNIT>Yes</ISSIMPLEUNIT>
      <DECIMALPLACES>${u.decimals ?? 0}</DECIMALPLACES>
    </UNIT>`;
}

export function buildGodownXml(g: NewGodown, action: "Create" | "Alter" = "Create"): string {
  return `
    <GODOWN NAME="${esc(g.name)}" ACTION="${action}">
      <NAME>${esc(g.name)}</NAME>
      <PARENT/>
    </GODOWN>`;
}

export function buildCostCentreXml(c: NewCostCentre, action: "Create" | "Alter" = "Create"): string {
  return `
    <COSTCENTRE NAME="${esc(c.name)}" ACTION="${action}">
      <NAME>${esc(c.name)}</NAME>
      ${c.parent ? `<PARENT>${esc(c.parent)}</PARENT>` : "<PARENT/>"}
      ${c.category ? `<CATEGORY>${esc(c.category)}</CATEGORY>` : ""}
    </COSTCENTRE>`;
}

async function writeMaster(
  tallyUrl: string, company: string, body: string, want: "created" | "deleted", what: string,
): Promise<MasterWriteResult> {
  const refusal = refuseCompanyWrite(company);
  if (refusal) {
    return { ok: false, created: 0, deleted: 0, errors: 0, exceptions: 0, lineErrors: [],
      notes: [refusal], requestXml: "", responseXml: "" };
  }
  const requestXml = envelope(company, body);
  const responseXml: string = await tallyPost(tallyUrl, requestXml, 60_000, true);
  const created = num(responseXml, "CREATED");
  const deleted = num(responseXml, "DELETED");
  const errors = num(responseXml, "ERRORS");
  const exceptions = num(responseXml, "EXCEPTIONS");
  if (created > 0 || deleted > 0) invalidateMasters();
  const wrote = want === "created" ? created > 0 : deleted > 0;
  return {
    ok: wrote, created, deleted, errors, exceptions,
    lineErrors: [...responseXml.matchAll(/<LINEERROR>([^<]*)/gi)].map((m) => m[1].trim()),
    notes: wrote ? [] : [`Tally did not ${want === "created" ? "create" : "delete"} the ${what}.` +
      (exceptions > 0 ? " EXCEPTIONS=1 with no message is the silent-failure signature." : "")],
    requestXml, responseXml,
  };
}

/** Read one master of a known-safe type back by name. Returns the raw blocks. */
async function readMasterRaw(
  tallyUrl: string, company: string, type: "StockItem" | "Unit" | "Godown" | "CostCentre", name: string, fields: string[],
): Promise<string> {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MpRead${type}</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MpRead${type}" ISMODIFY="No"><TYPE>${type}</TYPE>
${fields.map((f) => `<NATIVEMETHOD>${f}</NATIVEMETHOD>`).join("")}
<FILTER>MpRead${type}F</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MpRead${type}F">$Name = "${esc(name)}"</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw: string = await tallyPost(tallyUrl, xml, 30_000, true);
  return blocksOf(raw, type.toUpperCase()).join("\n");
}

/**
 * Create a stock item and prove the GST stuck. The read-back asks for the
 * nested GSTDETAILS block and checks the HSN and the IGST rate came back.
 */
export async function createStockItem(
  tallyUrl: string, company: string, item: NewStockItem,
): Promise<MasterWriteResult & { readBack?: { baseUnit: string; igst: string; hsn: string } | null }> {
  const res = await writeMaster(tallyUrl, company, buildStockItemXml(item), "created", "stock item");
  if (!res.ok) return res;
  const block = await readMasterRaw(tallyUrl, company, "StockItem", item.name,
    ["Name", "Parent", "BaseUnits", "GstDetails"]);
  if (!block) {
    return { ...res, ok: false, readBack: null,
      notes: ["Tally reported success and the item cannot be read back. Do not use it."] };
  }
  const f = (t: string, src = block) => (new RegExp(`<${t}[^>]*>([^<]*)</${t}>`, "i").exec(src)?.[1] ?? "").replace(/&#4;\s*/g, "").trim();
  const igstRow = /<RATEDETAILS\.LIST>\s*<GSTRATEDUTYHEAD>IGST<\/GSTRATEDUTYHEAD>[\s\S]*?<\/RATEDETAILS\.LIST>/i.exec(block)?.[0] ?? "";
  const readBack = { baseUnit: f("BASEUNITS"), igst: f("GSTRATE", igstRow), hsn: f("HSNCODE") };
  const rateOk = Number(readBack.igst) === item.gstRate;
  const hsnOk = !item.hsn || readBack.hsn === item.hsn;
  if (!rateOk || !hsnOk) {
    return { ...res, ok: false, readBack, notes: [
      `Item created but the GST did not stick: IGST read back "${readBack.igst}" (sent ${item.gstRate}), HSN "${readBack.hsn}" (sent "${item.hsn ?? ""}"). ` +
      `A flat GST field is accepted and lost; the rate must sit in the nested block.`] };
  }
  return { ...res, readBack, notes: [`Read back with IGST ${readBack.igst}% and HSN "${readBack.hsn}".`] };
}

export const deleteStockItem = (tallyUrl: string, company: string, name: string) =>
  writeMaster(tallyUrl, company, `<STOCKITEM NAME="${esc(name)}" ACTION="Delete"><NAME>${esc(name)}</NAME></STOCKITEM>`, "deleted", "stock item");

/** Tally answered BAD UNIT NAME for ZZU1 and "ZZ U2" and accepted ZZUNIT
 *  (dummy company, 3-Nov-2026): a unit symbol is letters only. */
export const isValidUnitName = (name: string): boolean => /^[A-Za-z]{1,20}$/.test(name);

export async function createUnit(tallyUrl: string, company: string, unit: NewUnit): Promise<MasterWriteResult> {
  if (!isValidUnitName(unit.name)) {
    return { ok: false, created: 0, deleted: 0, errors: 0, exceptions: 0, lineErrors: [],
      notes: [`Refused before sending: Tally rejects a unit symbol with digits or spaces ("${unit.name}" would answer BAD UNIT NAME). Use letters only.`],
      requestXml: "", responseXml: "" };
  }
  const res = await writeMaster(tallyUrl, company, buildUnitXml(unit), "created", "unit");
  if (!res.ok) return res;
  const block = await readMasterRaw(tallyUrl, company, "Unit", unit.name, ["Name", "DecimalPlaces"]);
  if (!block) return { ...res, ok: false, notes: ["Tally reported success and the unit cannot be read back."] };
  return res;
}

/** Tally answers DELETED=1 for a unit that does not exist (3-Nov-2026), so the
 *  unit is read first and a missing one is reported as missing, not deleted. */
export async function deleteUnit(tallyUrl: string, company: string, name: string): Promise<MasterWriteResult> {
  const before = await readMasterRaw(tallyUrl, company, "Unit", name, ["Name"]);
  if (!before) {
    return { ok: false, created: 0, deleted: 0, errors: 0, exceptions: 0, lineErrors: [],
      notes: [`Unit "${name}" is not in the books. Tally would still have answered DELETED=1, so nothing was sent.`],
      requestXml: "", responseXml: "" };
  }
  return writeMaster(tallyUrl, company, `<UNIT NAME="${esc(name)}" ACTION="Delete"><NAME>${esc(name)}</NAME></UNIT>`, "deleted", "unit");
}

export async function createGodown(tallyUrl: string, company: string, godown: NewGodown): Promise<MasterWriteResult> {
  const res = await writeMaster(tallyUrl, company, buildGodownXml(godown), "created", "godown");
  if (!res.ok) return res;
  const block = await readMasterRaw(tallyUrl, company, "Godown", godown.name, ["Name"]);
  if (!block) return { ...res, ok: false, notes: ["Tally reported success and the godown cannot be read back."] };
  return res;
}

export const deleteGodown = (tallyUrl: string, company: string, name: string) =>
  writeMaster(tallyUrl, company, `<GODOWN NAME="${esc(name)}" ACTION="Delete"><NAME>${esc(name)}</NAME></GODOWN>`, "deleted", "godown");

/** Create a cost centre and read it back by name with the same fields the sync pulls (Name, Parent, Category). */
export async function createCostCentre(tallyUrl: string, company: string, centre: NewCostCentre): Promise<MasterWriteResult & { readBack?: { parent: string; category: string } | null }> {
  const res = await writeMaster(tallyUrl, company, buildCostCentreXml(centre), "created", "cost centre");
  if (!res.ok) return res;
  const block = await readMasterRaw(tallyUrl, company, "CostCentre", centre.name, ["Name", "Parent", "Category"]);
  if (!block) return { ...res, ok: false, readBack: null, notes: ["Tally reported success and the cost centre cannot be read back."] };
  const f = (t: string) => (new RegExp(`<${t}[^>]*>([^<]*)</${t}>`, "i").exec(block)?.[1] ?? "").replace(/&#4;\s*/g, "").trim();
  return { ...res, readBack: { parent: f("PARENT"), category: f("CATEGORY") } };
}

export const deleteCostCentre = (tallyUrl: string, company: string, name: string) =>
  writeMaster(tallyUrl, company, `<COSTCENTRE NAME="${esc(name)}" ACTION="Delete"><NAME>${esc(name)}</NAME></COSTCENTRE>`, "deleted", "cost centre");
