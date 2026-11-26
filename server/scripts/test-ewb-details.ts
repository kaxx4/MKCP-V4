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
/* Compared field by field (the order of keys is not part of the contract). */
const want: Record<string, unknown> = {
  bill_date: "2026-08-01", valid_from: "2026-08-01T11:20", valid_until: "2026-08-02T23:59",
  part_b_updated: true, vehicle_type: "R - Regular", transporter_name: null, transporter_id: null,
  lr_number: null, lr_date: null, from_place: "KOLKATA", from_pincode: "700001", cancelled: false, cancel_reason: null,
  sub_type: null, document_type: null, intrastate: null, from_address: null, from_state: null, to_place: "BADKULLA", to_pincode: "741121",
  to_address: null, to_state: "West Bengal", irp_source: null, cancel_pending: false, transport_mode: "1 - Road", vehicle_number: "WB00X0000",
  distance_km: 90, part_b_pending: false, transporter_id_updated: false, goods_gold: null,
  bill_number: "999900001111", validity: null, generated_on: null, bill_status: null, cancel_code: null, cancel_date: null,
  consignor_name: null, consignor_gstin: null, consignor_state_name: null, consignor_address_type: null,
  consignee_name: null, consignee_gstin: null, consignee_state_name: null, consignee_address_type: null,
  consolidated_bill_number: null, consolidated_bill_date: null, threshold_limit: null, threshold_limit_includes: null,
  remarks: null, place_of_change: null, state_of_change: null, reason_of_change: null, transporter_id_pending: false,
  switches_on: null, multi_vehicle: null, extension_details: null, statewise_threshold: null, supply_type: null, supply_type_source: null,
};
for (const [k, v] of Object.entries(want)) eq("ewb_details." + k, (t.ewb_details as any)?.[k], v);
eq("ewb_details has no field the test does not know", Object.keys(t.ewb_details ?? {}).filter((k) => !(k in want)), []);

/* The full block as Tally sends it (tag names from the sandbox dummy census, 26-Nov-2026; placeholder values). */
const full = extractVoucherTransport({
  VOUCHERTYPENAME: "SALES",
  "EWAYBILLDETAILS.LIST": {
    BILLDATE: "20260801", UPDATEDDATE: "20260801112000000", VALIDUPTO: "20260802235900000", CANCELDATE: "000000000", BILLNUMBER: "999900001111",
    DOCUMENTTYPE: "Tax Invoice", SUBTYPE: "Supply", IRPSOURCE: "NIC1", VALIDITY: "1 Day", BILLSTATUS: "Active",
    CONSIGNORNAME: "ZZ TEST CONSIGNOR", CONSIGNORGSTIN: "PLACEHOLDER", CONSIGNORSTATENAME: "West Bengal", CONSIGNEENAME: "ZZ TEST BUYER", CONSIGNEEGSTIN: "PLACEHOLDER",
    CONSIGNEESTATENAME: "West Bengal", CONSOLIDATEDBILLNUMBER: "CB1", CONSOLIDATEDBILLDATE: "20260802", THRESHOLDLIMIT: "50000", THRESHOLDLIMITINCLUDES: "Tax",
    IGNOREGSTINVALIDATION: "Yes", ISEXPORTEDFORGENERATION: "No", INTRASTATEAPPLICABILITY: "Yes",
    "CONSIGNORADDRESS.LIST": { CONSIGNORADDRESS: ["Line A", "Line B"] }, "CONSIGNEEADDRESS.LIST": { CONSIGNEEADDRESS: "Town" },
    "TRANSPORTDETAILS.LIST": { TRANSPORTMODE: "1 - Road", VEHICLENUMBER: "WB00X0000", ISPARTBUPDATED: "Yes", ISTRANSIDPENDING: "Yes", REMARKS: "ZZ TEST REMARK",
      PLACEOFCHANGE: "ZZ TOWN", STATEOFCHANGE: "West Bengal", REASONOFCHANGE: "Breakdown", IGNOREPARTBVALIDATION: "Yes", DISTANCE: " 90" },
    "MULTIVEHICLEDETAILS.LIST": { VEHICLEROW: [{ VEHICLENUMBER: "WB00Y0000", QUANTITY: "4" }, { VEHICLENUMBER: "" }] },
  },
}).ewb_details as any;
eq("document type", full.document_type, "Tax Invoice");
eq("sub type / reason", full.sub_type, "Supply");
eq("supply type from the voucher type", [full.supply_type, full.supply_type_source], ["Outward", "voucher_type"]);
eq("consignor and consignee", [full.consignor_name, full.consignor_gstin, full.consignee_name, full.consignee_gstin, full.consignor_state_name, full.consignee_state_name],
  ["ZZ TEST CONSIGNOR", "PLACEHOLDER", "ZZ TEST BUYER", "PLACEHOLDER", "West Bengal", "West Bengal"]);
eq("validity, status, bill number, irp source", [full.validity, full.bill_status, full.bill_number, full.irp_source], ["1 Day", "Active", "999900001111", "NIC1"]);
eq("consolidated bill and threshold", [full.consolidated_bill_number, full.consolidated_bill_date, full.threshold_limit, full.threshold_limit_includes], ["CB1", "2026-08-02", "50000", "Tax"]);
eq("addresses joined", [full.from_address, full.to_address], ["Line A, Line B", "Town"]);
eq("transport extras", [full.remarks, full.place_of_change, full.state_of_change, full.reason_of_change, full.transporter_id_pending], ["ZZ TEST REMARK", "ZZ TOWN", "West Bengal", "Breakdown", true]);
eq("switches that are Yes, lower case, both levels", full.switches_on, ["ignoregstinvalidation", "ignorepartbvalidation"]);
eq("multi-vehicle rows keep only filled fields", full.multi_vehicle, [{ vehiclenumber: "WB00Y0000", quantity: "4" }]);
eq("intrastate text kept", full.intrastate, "Yes");
eq("a Purchase is an inward supply", (extractVoucherTransport({ VOUCHERTYPENAME: "Purchase", "EWAYBILLDETAILS.LIST": { BILLNUMBER: "1" } }).ewb_details as any).supply_type, "Inward");
eq("Tally's own supply type wins when filled", (extractVoucherTransport({ VOUCHERTYPENAME: "SALES", GSTSUPPLYTYPE: "Inward", "EWAYBILLDETAILS.LIST": { BILLNUMBER: "1" } }).ewb_details as any).supply_type_source, "tally");
eq("no voucher type, no guess", (extractVoucherTransport({ "EWAYBILLDETAILS.LIST": { BILLNUMBER: "1" } }).ewb_details as any).supply_type, null);

eq("no e-invoice header → null einv_details", t.einv_details, null);
const einv = extractVoucherTransport({ ...voucher, IRNCANCELLED: "No", IRNIRPSOURCE: "NIC", DISPATCHFROMNAME: "ZZ TEST DEPOT", DISPATCHFROMPINCODE: "700001",
  "DISPATCHFROMADDRESS.LIST": { DISPATCHFROMADDRESS: ["Line 1", "Line 2"] }, ISEWAYBILLAPPLICABLE: "Yes", CONSIGNEEGSTIN: "PLACEHOLDER" }).einv_details;
eq("e-invoice header read", einv && [einv.irn_cancelled, einv.irp_source, einv.dispatch_from_name, einv.dispatch_from_pincode, einv.dispatch_from_address, einv.ewb_applicable, einv.consignee_gstin, einv.delivery_same_as_consignee],
  [false, "NIC", "ZZ TEST DEPOT", "700001", "Line 1, Line 2", true, "PLACEHOLDER", null]);
const einv2 = extractVoucherTransport({ IRNCANCELLED: "Yes", IRNCANCELDATE: "20260803", IRNCANCELREASON: "Duplicate", IRNCANCELCODE: "1", IRNACKUPDATEDATETIME: "20260801112000000",
  BILLTOPLACE: "ZZ TOWN", ISDELIVERYSAMEASCONSIGNEE: "Yes", ISDISPATCHSAMEASCONSIGNOR: "No", ISEWAYBILLEXCLUDED: "Yes", OVRDNEWAYBILLAPPLICABILITY: "No", ISEINVOVERRIDDEN: "No",
  ISECOMMERCESUPPLY: "No", IRNJSONEXPORTED: "Yes", CONSIGNEEPINNUMBER: "PLACEHOLDER", CONSIGNEECOUNTRYNAME: "India", GSTSUPPLYTYPE: "Outward", GSTITCDOCUMENTTYPE: "Invoice",
  INVDELIVERYDATE: "20260804", DISPATCHDATE: "20260802", DOCUMENTID: "D1", PLACEOFSUPPLYSTATE: "West Bengal", PLACEOFSUPPLYCOUNTRY: "India",
  TRANSPORTERNAME: "ZZ TEST CARRIER", GOODSVEHICLENUMBER: "WB00Z0000", BILLOFLADINGNO: "BL1", TRANSPORTERADDRTOWN: "ZZ TOWN",
  "EWAYBILLERRORLIST.LIST": { ERROR: { ERRORCODE: "238", ERRORDESC: "ZZ TEST ERROR" } } }).einv_details as any;
eq("IRN cancel block", [einv2.irn_cancelled, einv2.irn_cancel_date, einv2.irn_cancel_reason, einv2.irn_cancel_code, einv2.ack_updated_at], [true, "2026-08-03", "Duplicate", "1", "20260801112000000"]);
eq("same-as and override flags", [einv2.delivery_same_as_consignee, einv2.dispatch_same_as_consignor, einv2.ewb_excluded, einv2.ewb_applicability_overridden, einv2.einv_overridden, einv2.ecommerce_supply, einv2.irn_json_exported],
  [true, false, true, false, false, false, true]);
eq("tax-invoice and document fields", [einv2.gst_supply_type, einv2.gst_itc_document_type, einv2.inv_delivery_date, einv2.dispatch_date, einv2.document_id, einv2.place_of_supply_state, einv2.place_of_supply_country],
  ["Outward", "Invoice", "2026-08-04", "2026-08-02", "D1", "West Bengal", "India"]);
eq("consignee PAN and country, bill-to place", [einv2.consignee_pan, einv2.consignee_country, einv2.bill_to_place], ["PLACEHOLDER", "India", "ZZ TOWN"]);
eq("header shipping keeps only what Tally filled", einv2.header_shipping, { transportername: "ZZ TEST CARRIER", goodsvehiclenumber: "WB00Z0000", billofladingno: "BL1", transporteraddrtown: "ZZ TOWN" });
eq("error rows kept", einv2.ewb_errors, [{ errorcode: "238", errordesc: "ZZ TEST ERROR" }]);
eq("no error list, no rows", einv2.irn_errors, null);
eq("a header of empty tags → no einv block", extractVoucherTransport({ IRNCANCELLED: "", DISPATCHFROMNAME: "", TRANSPORTERNAME: "", "EWAYBILLERRORLIST.LIST": "" }).einv_details, null);
eq("Tally's defaults on every voucher (all No, a stamp, India) are not an e-invoice block", extractVoucherTransport({ IRNCANCELLED: "No", IRNACKUPDATEDATETIME: "20260801112000000", CONSIGNEECOUNTRYNAME: "India",
  ISDELIVERYSAMEASCONSIGNEE: "No", ISDISPATCHSAMEASCONSIGNOR: "No", ISEWAYBILLAPPLICABLE: "No", IRNJSONEXPORTED: "No", ISEINVOVERRIDDEN: "No" }).einv_details, null);
eq("one real value is enough, and the No flags then read false", (extractVoucherTransport({ IRNCANCELLED: "No", BILLTOPLACE: "ZZ TOWN" }).einv_details as any)?.irn_cancelled, false);
eq("no e-way bill → null details", extractVoucherTransport({}).ewb_details, null);
eq("zero date → null", tallyStamp("000000000"), null);
eq("date only", tallyStamp("20261021"), "2026-10-21");
eq("parser number survives", tallyStamp(20261021), "2026-10-21");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
