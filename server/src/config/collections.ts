import type { CollectionDef } from "../types.js";

export const MASTER_COLLECTIONS: CollectionDef[] = [
  {
    name: "stockGroups",
    tallyCollection: "StockGroup",
    metadataType: "Stock Group",
    category: "master",
    fetch: ["Name", "Parent", "IsAddable", "GUID"],
    timeout: 30_000,
    parallel: true,
  },
  {
    name: "units",
    tallyCollection: "Unit",
    metadataType: "Unit",
    category: "master",
    fetch: ["Name", "OriginalName", "BaseUnits", "AdditionalUnits", "Conversion", "IsSimpleUnit", "IsFormallyCompound", "GUID"],
    timeout: 30_000,
    parallel: true,
  },
  {
    name: "godowns",
    tallyCollection: "Godown",
    metadataType: "Godown",
    category: "master",
    fetch: ["Name", "Parent", "HasNoSpace", "GUID"],
    timeout: 30_000,
    parallel: true,
  },
  {
    name: "costCentres",
    tallyCollection: "CostCentre",
    metadataType: "Cost Centre",
    category: "master",
    fetch: ["Name", "Parent", "Category", "GUID"],
    timeout: 30_000,
    parallel: true,
  },
  {
    name: "stockItems",
    tallyCollection: "StockItem",
    metadataType: "Stock Item",
    category: "master",
    fetch: [
      "Name", "Parent", "Category", "BaseUnits", "AdditionalUnits", "Denominator",
      "OpeningBalance", "OpeningRate", "OpeningValue",
      // The converter reads CLOSINGBALANCE/CLOSINGRATE/CLOSINGVALUE with a "0"
      // default (converters/convert.ts). They were missing from this fetch list,
      // so Tally never sent them and every stock item landed in Supabase with
      // closing_rate = "0" — which is why four modules disagreed about stock
      // value. services/tallyMasters.ts already proves Tally serves these.
      "ClosingBalance", "ClosingRate", "ClosingValue",
      "GSTApplicable", "GSTTypeOfSupply", "GSTDetails", "HSNDetails", "GUID",
      // convertStockItems reads these four (convert.ts:279-282) and mapStockItem
      // writes them to four Supabase columns — but they were never in this list,
      // so Tally was never asked and all four columns were permanently empty.
      // Guardrail G4. Probed one field at a time before adding, because a bad
      // fetch field can crash TallyPrime: all four are served and populated on
      // 489 of 489 items (server/scripts/probe-stockitem-fields.ts, 13-Sep-2026 —
      // "Avg. Cost", "Avg. Price", "No", "No").
      "CostingMethod", "ValuationMethod", "IsBatchWiseOn", "IsCostCentresOn",
    ],
    timeout: 900_000,
    parallel: false,
  },
  {
    name: "ledgers",
    tallyCollection: "Ledger",
    metadataType: "Ledger",
    category: "master",
    fetch: [
      /* Measured against the live books 17-Sep-2026, 341 parties:
           LedStateName  341/341   PartyGSTIN 220/341   Address 335/341
           GSTIN           0/341   LedGSTIN     0/341
         The last two returned nothing for a single party and were dropped —
         two fields on every masters pull that could never answer. `PartyGSTIN`
         is the one that works.

         LedGSTRegDetails is the DATED registration block, and it is here
         because `PartyGSTIN` is computed and comes back EMPTY when the block
         carries no STATE: 53 parties (Amrit Cycle Industries, B. D. Malik &
         Sons, Asian Bikes…) hold a GSTIN that the flat field will not report.
         A GSTIN-less purchase files into a GSTR-2 exception silently, so the
         block is the fallback — see convertLedgers. */
      "Name", "Parent", "OpeningBalance", "PartyGSTIN", "LedGSTRegDetails",
      "CreditPeriod", "BillCreditPeriod", "GUID",
      "MailingName", "Address", "LedStateName", "CountryName", "PinCode", "Email", "LedgerPhone",
    ],
    timeout: 900_000,
    parallel: false,
  },
];

export const TRANSACTION_COLLECTIONS: CollectionDef[] = [
  {
    name: "vouchers",
    tallyCollection: "Voucher",
    metadataType: "Voucher",
    category: "transaction",
    fetch: [
      "Guid", "Date", "VoucherTypeName", "VoucherNumber", "Reference", "Narration",
      "PartyLedgerName", "IsCancelled", "IsOptional", "EffectiveDate", "AlterID", "MasterId",
      /* E-invoice registration. Tally emits these as self-closing empty tags on
         an invoice with no IRN yet — proven with a NATIVEMETHOD * probe, and
         that emptiness IS the signal: an e-invoice must reach the IRP within 30
         days of the invoice date or it can never be registered, and the buyer
         loses their input tax credit. The app never calls the IRP (a hard scope
         boundary); it only needs to NOTICE. It cannot notice without these.
         server/scripts/probe-irn-fields.ts, 14-Sep-2026. */
      "IRN", "IRNAckNo", "IRNAckDate",
      /* E-way bill and transport. convert.ts has read
         EWAYBILLDETAILS.TRANSPORTDETAILS.DISTANCE (plus the bill number, vehicle
         and mode) since it was written — and this list never asked for the
         block, so every one of those columns was empty on all 2,792 mirrored
         vouchers. G4 exactly: a converter reading fields nobody fetches, the
         same defect already recorded for convertStockItems.

         Tally holds them. Probed 14-Sep-2026 on the 23 SALES vouchers of
         1-Aug-2026: DISTANCE="90", VEHICLENUMBER="WB03D3840",
         TRANSPORTMODE="1 - Road", CONSIGNEEPINCODE="741121". Verified with an
         explicit FETCH of this exact name — not a wildcard — returning 41,227
         bytes with the block intact. server/scripts/probe-ewaybill-fields.ts.

         Worth the extra payload: the e-way bill's distance is the only
         freight distance anyone has actually accepted. The web app's fallbacks
         are a routed estimate and, below that, a rate card typed in July 2024
         that runs up to 67% wrong. */
      "EWayBillDetails",
      /* Party GST identity and ship-to. convertVouchers has read PARTYGSTIN,
         PLACEOFSUPPLY and the CONSIGNEE* / PARTYPINCODE header fields since the
         e-way bill columns were added — and this list never named them, so on
         24-Sep-2026 the mirror held party_gstin and place_of_supply on 0 of
         1,243 FY26-27 outward/inward invoices (consignee_state came only from
         the e-way bill block). G7 again: an unasked field reads as "Tally has
         none". Caught by guardrails --g7 (TG-L14).

         Each name is the one safePush's read-back (MkVerify) has asked for on
         every live push since 23-Sep-2026 and that fidelity-vs-native
         measured populated (PARTYGSTIN / PLACEOFSUPPLY 39/39 on Sales Order
         Notes). These are COMPUTED fields: they come back only alongside the
         entry lists below, which this request already names.
         SHIPTOPLACE / DISPATCHFROMPLACE are read too but have never been
         probed by name — left out until a sandbox probe confirms them. */
      "PartyGSTIN", "PlaceOfSupply", "PartyPincode",
      "ConsigneeMailingName", "ConsigneeStateName", "ConsigneePinCode",
      // Sub-lists WITHOUT .* wildcards — wildcards crash TallyPrime ("incorrect object type").
      // Requesting the parent key is enough: TallyPrime returns all standard sub-fields automatically.
      "AllLedgerEntries",
      "LedgerEntries",
      "AllInventoryEntries",
      "InventoryEntries",
    ],
    timeout: 180_000,
    parallel: false,
  },
];

/** All parallel-eligible masters (small/fast) */
export const PARALLEL_MASTERS = MASTER_COLLECTIONS.filter(c => c.parallel);

/** Sequential masters (large/slow) */
export const SEQUENTIAL_MASTERS = MASTER_COLLECTIONS.filter(c => !c.parallel);
