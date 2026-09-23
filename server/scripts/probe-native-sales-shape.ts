/**
 * Ground truth for the push-fidelity work: dump hand-typed SALES / Sales Order
 * Note vouchers with every populated tag, so a pushed voucher can be diffed
 * against what the operator's own keyboard produces.
 *
 * Two passes per voucher, because they answer different questions (G7):
 *   wildcard  — NATIVEMETHOD *  → which STORED scalar tags exist at all
 *   explicit  — named fields incl. entry lists → computed fields + line blocks
 *
 * Read-only. Single-day filter so entry blocks are safe to request.
 *   npx tsx server/scripts/probe-native-sales-shape.ts <YYYYMMDD> <voucherNumber> [wildcard|explicit]
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { config } from "dotenv";
config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import { tallyPost } from "../src/tally.js";
import { buildCollection, blocksOf, tagOf, onDate } from "../src/services/tallyRequest.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";

/** Every field that decides the Party Details / e-way / e-invoice screens. */
export const PARTY_FIELDS = [
  "Date", "VoucherNumber", "VoucherTypeName", "PartyLedgerName", "PartyName", "BasicBasePartyName",
  "PartyMailingName", "Address", "PartyPincode", "StateName", "CountryOfResidence", "PlaceOfSupply",
  "GSTRegistrationType", "PartyGSTIN", "VATDealerType", "GSTRegistration", "CMPGSTIN", "CMPGSTRegistrationType", "CMPGSTState",
  "BasicBuyerName", "BasicBuyerAddress", "ConsigneeMailingName", "ConsigneeGSTIN", "ConsigneePinCode",
  "ConsigneeStateName", "ConsigneeCountryName", "ConsigneeGSTRegistrationType", "ConsigneeAddress",
  "IsInvoice", "PersistedView", "VchEntryMode", "Narration", "Reference", "IsOptional",
  "EWayBillDetails", "GSTEWayConsigneeAddress", "GSTConsigneeAddress", "IRNAckNo", "IRN", "IRNAckDate",
  "IsEWayBillApplicable", "IsEInvoiceApplicable", "BasicShippedBy", "BasicShipDocumentNo", "BasicFinalDestination",
  "BasicShipVesselNo", "BasicDueDateOfPymt", "BasicOrderRef", "DispatchFromName", "DispatchFromStateName", "DispatchFromPincode",
  "GSTNatureOfTransaction", "VchGSTClass",
  "AllLedgerEntries", "LedgerEntries", "AllInventoryEntries",
];

(async () => {
  const [day, number, mode = "explicit"] = process.argv.slice(2);
  if (!day || !number) { console.error("usage: <YYYYMMDD> <voucherNumber> [wildcard|explicit]"); process.exit(2); }
  const xml = buildCollection({
    id: mode === "wildcard" ? "NatShapeW" : "NatShapeE", type: "Voucher", company: COMPANY,
    fetch: mode === "wildcard" ? [] : PARTY_FIELDS, filter: onDate(day),
  }).replace(mode === "wildcard" ? "<TYPE>Voucher</TYPE>" : "@@none@@", "<TYPE>Voucher</TYPE><NATIVEMETHOD>*</NATIVEMETHOD>");
  const raw: string = await tallyPost(U, xml, 180_000, true);
  const v = blocksOf(raw, "VOUCHER").find((b) => (tagOf(b, "VOUCHERNUMBER") ?? "") === number);
  if (!v) { console.log(`no voucher ${number} on ${day}`); process.exit(1); }
  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "native-shape");
  mkdirSync(out, { recursive: true });
  const file = join(out, `${number.replace(/[^A-Za-z0-9]/g, "_")}.${mode}.xml`);
  writeFileSync(file, "<VOUCHER " + v);
  // populated leaf tags, with values, in document order (unique path-ish)
  const leaves = [...v.matchAll(/<([A-Z][A-Z0-9._]*)(?:\s[^>]*)?>([^<]+)<\/\1>/g)]
    .map((m) => `${m[1]}=${m[2].trim()}`).filter((s) => !/=$/.test(s));
  console.log(`${number} ${day} (${mode}) ${v.length} bytes → ${file}`);
  console.log([...new Set(leaves)].join("\n"));
})();
