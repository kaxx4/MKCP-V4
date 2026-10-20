/**
 * Phase 2 W2 (owner 20-Oct-2026): the e-way bill block lands in ewb_details.
 * Shape copied from a real block read on the dummy Tally, 21-Oct-2026
 * (probe-ewaybill-fields.ts EWB_DUMP=1), with a placeholder bill number.
 *
 *   npx tsx server/scripts/test-ewb-details.ts
 */
import { extractVoucherTransport, tallyStamp } from "../src/converters/convert.js";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const voucher = {
  "EWAYBILLDETAILS.LIST": {
    BILLDATE: "20260801", UPDATEDDATE: "20260801112000000", VALIDUPTO: "20260802235900000",
    CANCELDATE: "000000000", BILLNUMBER: "999900001111", CONSIGNEEPINCODE: "741121", CONSIGNEEPLACE: "BADKULLA",
    CONSIGNORPLACE: "KOLKATA", CONSIGNORPINCODE: "700001", SHIPPEDTOSTATE: "West Bengal", ISCANCELLED: "",
    "TRANSPORTDETAILS.LIST": {
      TRANSPORTMODE: "1 - Road", VEHICLENUMBER: "WB00X0000", VEHICLETYPE: "R - Regular",
      ISPARTBUPDATED: "Yes", DISTANCE: " 90", TRANSPORTERNAME: "", DOCUMENTNUMBER: "",
    },
  },
};

const t = extractVoucherTransport(voucher);
eq("number still in its own column", t.ewb_number, "999900001111");
eq("distance still parsed", t.transport_distance_km, 90);
eq("ewb_details", t.ewb_details, {
  bill_date: "2026-08-01", valid_from: "2026-08-01T11:20", valid_until: "2026-08-02T23:59",
  part_b_updated: true, vehicle_type: "R - Regular", transporter_name: null, transporter_id: null,
  lr_number: null, lr_date: null, from_place: "KOLKATA", from_pincode: "700001", cancelled: false, cancel_reason: null,
});
eq("no e-way bill → null details", extractVoucherTransport({}).ewb_details, null);
eq("zero date → null", tallyStamp("000000000"), null);
eq("date only", tallyStamp("20261021"), "2026-10-21");
eq("parser number survives", tallyStamp(20261021), "2026-10-21");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
