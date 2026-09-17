/**
 * Does a party created by the app actually carry its details?
 *
 * The owner's report: "you're pushing rates, party details, you're not putting
 * the addresses, you're not putting the vendor details." A blank Address on a
 * Tally party-details screen was the first evidence.
 *
 * What a real party in these books holds, read back from TOGO CYCLES:
 *
 *   LEDMAILINGDETAILS.LIST   APPLICABLEFROM, MAILINGNAME, ADDRESS (SEVERAL),
 *                            STATE, COUNTRY, PINCODE
 *   LEDGSTREGDETAILS.LIST    APPLICABLEFROM, GSTREGISTRATIONTYPE, STATE,
 *                            PLACEOFSUPPLY, GSTIN
 *
 * Both are DATED and NESTED. The flat `ADDRESS` tag a dump also shows is the
 * FIRST line only — reading it and calling that "the address" silently drops
 * the rest, and TOGO's is two lines.
 *
 *   npx tsx scripts/fidelity/case-party.ts          # create, verify, delete
 *   npx tsx scripts/fidelity/case-party.ts --keep   # leave it behind to look at
 */
import { tallyPost } from "../../src/tally.js";
import { buildLedgerXml, type NewLedger } from "../../src/services/masterPusher.js";
import {
  U, MARK, company, allFieldsXml, objects, fld, flds, block,
  check, report, push, esc, importSummary,
} from "./harness.js";

/** A collection asking for named fields only — the shape the sync itself uses. */
function targetedXml(co: string, fields: string[]): string {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MkT</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="MkT" ISMODIFY="No"><TYPE>Ledger</TYPE>
${fields.map((f) => `<NATIVEMETHOD>${f}</NATIVEMETHOD>`).join("")}
</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

const KEEP = process.argv.includes("--keep");
const NAME = `${MARK} PARTY ${Date.now().toString().slice(-6)}`;

/** Stated BEFORE the push, so the comparison cannot be talked into agreeing. */
const INTENT: NewLedger = {
  name: NAME,
  parent: "Sundry Creditors",
  state: "Punjab",
  country: "India",
  pincode: "141003",
  // Two lines ON PURPOSE. Real parties have them; TOGO CYCLES has exactly this
  // shape, and a builder that takes one string cannot express it.
  address: "PLOT NO. 13 1ST FLOOR, GRAIN MARKET\nGILL ROAD, LUDHIANA-141003",
  gstin: "03ACUPA2463R1Z7",
  gstRegistrationType: "Regular",
  phone: "9876543210",
  email: "zztest@example.invalid",
  creditPeriod: "21 Days",
  mailingName: NAME,
};

async function main(): Promise<void> {
  const co = await company();
  console.log(`\ncompany  ${co}`);
  console.log(`party    ${NAME}\n`);

  // ── create ────────────────────────────────────────────────────────────────
  const res = await push(co, buildLedgerXml(INTENT, "Create"), "create ledger");
  if (/<LINEERROR>/i.test(res)) {
    console.log(`\n   Tally refused it outright. Nothing further to verify.\n`);
    return;
  }

  // ── read back, every field ────────────────────────────────────────────────
  /* TWO reads, on purpose.
     `NATIVEMETHOD *` returns STORED fields. Several of the ones that matter —
     LedStateName, PartyGSTIN, PriorStateName — are COMPUTED, and come back
     absent from a wildcard dump on every party in the company while answering
     instantly when asked for by name. A census built on `*` alone reported
     "0 of 341 parties have a state", which is false and would have sent me
     rewriting a converter that was already right (G7). */
  const dump = (await tallyPost(U, allFieldsXml(co, "Ledger"), 180_000, true)) as string;
  const mine = objects(dump, "LEDGER").find((l) => l.name === NAME);
  const computed = objects(
    (await tallyPost(U, targetedXml(co, ["Name", "PartyGSTIN", "LedStateName", "Address", "PinCode"]), 120_000, true)) as string,
    "LEDGER",
  ).find((l) => l.name === NAME);
  if (!mine) {
    console.log(`\n   Created, but the read-back cannot find it. Stopping.\n`);
    return;
  }

  const mail = block(mine.body, "LEDMAILINGDETAILS\\.LIST");
  const reg = block(mine.body, "LEDGSTREGDETAILS\\.LIST");
  const addrLines = flds(block(mail, "ADDRESS\\.LIST") || mail, "ADDRESS");

  const intendedAddr = INTENT.address!.split("\n");

  const checks = [
    check("name", NAME, fld(mine.body, "NAME") || mine.name),
    check("parent", INTENT.parent, fld(mine.body, "PARENT")),
    check("credit period", INTENT.creditPeriod, fld(mine.body, "BILLCREDITPERIOD")),
    check("email", INTENT.email, fld(mine.body, "EMAIL")),
    check("phone", INTENT.phone, fld(mine.body, "LEDGERMOBILE")),

    // The two blocks that matter
    check("mailing block present", "yes", mail ? "yes" : ""),
    check("  state (mailing)", INTENT.state, fld(mail, "STATE")),
    check("  country", INTENT.country, fld(mail, "COUNTRY")),
    check("  pincode", INTENT.pincode, fld(mail, "PINCODE")),
    check("  address line count", String(intendedAddr.length), String(addrLines.length),
      { note: "Tally stores ADDRESS as several lines; NewLedger.address is ONE string" }),
    check("  address line 1", intendedAddr[0], addrLines[0] ?? ""),
    check("  address line 2", intendedAddr[1], addrLines[1] ?? ""),

    check("gst block present", "yes", reg ? "yes" : ""),
    check("  gstin", INTENT.gstin, fld(reg, "GSTIN")),
    check("  registration type", INTENT.gstRegistrationType, fld(reg, "GSTREGISTRATIONTYPE")),
    check("  state (gst)", INTENT.state, fld(reg, "STATE")),
    check("  place of supply", INTENT.state, fld(reg, "PLACEOFSUPPLY")),

    // What the SYNC reads, which is a different question from what Tally holds
    // Asked for BY NAME — these are computed, see the note on the second read.
    check("computed LedStateName → mirror.state", INTENT.state,
      computed ? fld(computed.body, "LEDSTATENAME") : null),
    check("computed PartyGSTIN → mirror.gstin", INTENT.gstin,
      computed ? fld(computed.body, "PARTYGSTIN") : null),
    check("computed Address lines → mirror.address", String(intendedAddr.length),
      computed ? String(flds(block(computed.body, "ADDRESS\.LIST") || computed.body, "ADDRESS").length) : null),
  ];

  const { failed, unknown } = report(`party master: intent vs what Tally stored`, checks);

  // ── clean up ──────────────────────────────────────────────────────────────
  if (KEEP) {
    console.log(`\n   --keep: "${NAME}" left in the books. Remove it by hand.\n`);
  } else {
    const del = await push(co, `<LEDGER NAME="${esc(NAME)}" ACTION="Delete"><NAME>${esc(NAME)}</NAME></LEDGER>`, "delete ledger");
    console.log(`   cleanup: ${importSummary(del)}`);
  }
  console.log("");
  if (failed) process.exitCode = 1;
  void unknown;
}

main().catch((e) => { console.error(e); process.exit(1); });
