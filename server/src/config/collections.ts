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
      "Name", "Parent", "OpeningBalance", "GSTIN", "LedGSTIN", "PartyGSTIN",
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
