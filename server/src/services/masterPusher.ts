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
import { invalidateMasters } from "./tallyMasters.js";
import { blocksOf } from "./tallyRequest.js";

export interface NewLedger {
  name: string;
  /** e.g. "SUNDRY DEBTORS". The group decides how the party behaves. */
  parent: string;
  state: string;
  country?: string;
  pincode?: string;
  address?: string;
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

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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
     alternative, omitting the block, is indistinguishable from forgetting. */
  return `
    <LEDGER NAME="${esc(l.name)}" ACTION="${action}">
      <NAME>${esc(l.name)}</NAME>
      <PARENT>${esc(l.parent)}</PARENT>
      <ISBILLWISEON>${l.billWise === false ? "No" : "Yes"}</ISBILLWISEON>
      ${l.phone ? `<LEDGERMOBILE>${esc(l.phone)}</LEDGERMOBILE>` : ""}
      ${l.contact ? `<LEDGERCONTACT>${esc(l.contact)}</LEDGERCONTACT>` : ""}
      ${l.email ? `<EMAIL>${esc(l.email)}</EMAIL>` : ""}
      ${l.creditPeriod ? `<BILLCREDITPERIOD>${esc(l.creditPeriod)}</BILLCREDITPERIOD>` : ""}
      <LEDMAILINGDETAILS.LIST>
        <APPLICABLEFROM>${from}</APPLICABLEFROM>
        <MAILINGNAME>${esc(mailing)}</MAILINGNAME>
        ${l.address ? `<ADDRESS.LIST TYPE="String"><ADDRESS>${esc(l.address)}</ADDRESS></ADDRESS.LIST>` : ""}
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
  const body = `<LEDGER NAME="${esc(name)}" ACTION="Delete"><NAME>${esc(name)}</NAME></LEDGER>`;
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
