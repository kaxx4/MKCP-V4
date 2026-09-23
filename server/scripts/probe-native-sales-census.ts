/**
 * Scalar census of native SALES / Sales Order Note vouchers — which to sample.
 * Read-only; scalar fields plus the entry lists needed for computed fields.
 *   npx tsx server/scripts/probe-native-sales-census.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { config } from "dotenv";
config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import { tallyPost } from "../src/tally.js";
import { buildCollection, blocksOf, tagOf } from "../src/services/tallyRequest.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";
(async () => {
  const xml = buildCollection({
    id: "NatCensus", type: "Voucher", company: COMPANY,
    fetch: ["Date", "VoucherNumber", "VoucherTypeName", "PartyLedgerName", "PartyMailingName",
      "PartyGSTIN", "StateName", "PlaceOfSupply", "GSTRegistrationType", "ConsigneeMailingName",
      "BasicBuyerName", "PartyPincode", "ConsigneePincode", "RemoteID"],
    filter: { kind: "or", of: [{ kind: "compare", expr: "$VoucherTypeName", cmp: "eq", value: "SALES" }, { kind: "compare", expr: "$VoucherTypeName", cmp: "eq", value: "Sales Order Note" }] },
  });
  const raw: string = await tallyPost(U, xml, 180_000, true);
  const vs = blocksOf(raw, "VOUCHER");
  const rows = vs.map((v) => ({
    date: tagOf(v, "DATE"), no: tagOf(v, "VOUCHERNUMBER"), type: tagOf(v, "VOUCHERTYPENAME"),
    party: tagOf(v, "PARTYLEDGERNAME"), mail: tagOf(v, "PARTYMAILINGNAME"), gstin: tagOf(v, "PARTYGSTIN"),
    state: tagOf(v, "STATENAME"), pos: tagOf(v, "PLACEOFSUPPLY"), reg: tagOf(v, "GSTREGISTRATIONTYPE"),
    cmail: tagOf(v, "CONSIGNEEMAILINGNAME"), bb: tagOf(v, "BASICBUYERNAME"), pin: tagOf(v, "PARTYPINCODE"), cpin: tagOf(v, "CONSIGNEEPINCODE"),
  }));
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "data", "native-sales-census.json"), JSON.stringify(rows, null, 1));
  console.log(`${rows.length} vouchers`);
  const byType = new Map<string, number>(); for (const r of rows) byType.set(r.type ?? "", (byType.get(r.type ?? "") ?? 0) + 1);
  console.log([...byType]);
  const dates = rows.map((r) => r.date ?? "").sort(); console.log("range", dates[0], dates[dates.length - 1]);
  const regs = new Map<string, number>(); for (const r of rows) regs.set(`${r.type}|${r.reg}`, (regs.get(`${r.type}|${r.reg}`) ?? 0) + 1);
  console.log([...regs]);
  const states = new Map<string, number>(); for (const r of rows) states.set(r.state ?? "", (states.get(r.state ?? "") ?? 0) + 1);
  console.log([...states]);
})();
