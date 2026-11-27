/**
 * Which of the 26-Nov e-way / e-invoice FETCH names makes the mirror's voucher read hang Tally?
 *
 * JOB: bisect the freeze seen twice on 27-Nov-2026 (verify-ewb-einv-pull.ts, one day, no answer in 180 s, Tally needed a restart).
 * Sends the mirror's own one-day request (ERP_MIRROR_VOUCHER_DEF) with the new names removed, then with groups 1..N added back.
 * ONE request per run, sandbox dummy company only (tally.ts company guard). A timeout means Tally is wedged: stop and restart it.
 * Prints counts and timings only, never values.
 *
 *   npx tsx scripts/bisect-ewb-fetch.ts <YYYYMMDD> <groups>     groups: "none" | "1" | "1,2" | ... (see GROUPS)
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
/* MKCP_ENV_FILE lets a worktree with no server/.env use the agent checkout's file (loaded, never printed). */
config({ path: process.env.MKCP_ENV_FILE || join(here, "..", ".env") });

import { tallyPost } from "../src/tally.js";
import { buildCollectionXml } from "../src/services/xmlBuilder.js";
import { ERP_MIRROR_VOUCHER_DEF } from "../src/services/erpMirrorSync.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";
/* 27-Nov-2026: with no company named, Tally answered for whatever was open; after a restart that crashed TallyPrime (c0000005) three times. */
if (!COMPANY || process.env.MKCP_TALLY_ROLE !== "sandbox") { console.error("refused: TALLY_COMPANY is empty or this is not a sandbox machine. Nothing was sent to Tally."); process.exit(2); }

export const GROUPS: Record<string, string[]> = {
  "1": ["IRNCancelled", "IRNCancelDate", "IRNCancelReason", "IRNCancelCode", "IRNIRPSource", "IRNAckUpdateDateTime", "IRNJSONExported"],
  "2": ["DispatchFromName", "DispatchFromAddress", "DispatchFromPlace", "DispatchFromPinCode", "DispatchFromStateName", "DispatchDate",
    "BillToPlace", "ConsigneeGSTIN", "ConsigneePinNumber", "ConsigneeCountryName"],
  "3": ["TransporterName", "TransportMode", "GoodsVehicleNumber", "TransporterVehicle2", "TransporterAddrTown", "TransporterAddrState",
    "TransporterAddrPinCode", "BasicShipDocumentNo", "BasicShippedBy", "BasicPlaceOfReceipt", "BillOfLadingNo", "BillOfLadingDate"],
  "4": ["IsDeliverySameAsConsignee", "IsDispatchSameAsConsignor", "IsEWayBillApplicable", "IsEWayBillExcluded", "OvrdNEWayBillApplicability",
    "IsEInvOverridden", "IsECommerceSupply"],
  "5": ["GSTSupplyType", "GSTITCDocumentType", "InvDeliveryDate", "DocumentID", "PlaceOfSupplyState", "PlaceOfSupplyCountry"],
  "6": ["IRNErrorList", "EWayBillErrorList"],
};
const ALL_NEW = new Set(Object.values(GROUPS).flat());

async function main(): Promise<void> {
  const day = process.argv[2] ?? "20260801";
  const pick = (process.argv[3] ?? "none") === "none" ? [] : process.argv[3].split(",");
  const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
  const base = (ERP_MIRROR_VOUCHER_DEF.fetch ?? []).filter((f) => !ALL_NEW.has(f));
  const added = pick.flatMap((g) => GROUPS[g] ?? (() => { throw new Error(`no group ${g}`); })());
  const def = { ...ERP_MIRROR_VOUCHER_DEF, fetch: [...base, ...added], timeout: 90_000 };
  console.log(`  ${iso}: base ${base.length} names + groups [${pick.join(",") || "none"}] (${added.length} names)`);
  const t0 = Date.now();
  const parsed = await tallyPost(TALLY, buildCollectionXml(def, COMPANY, iso, iso), def.timeout, false);
  const n = JSON.stringify(parsed).split('"VOUCHER"').length - 1;
  console.log(`  ok in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${n} VOUCHER node(s)`);
}

main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exit(1); });
