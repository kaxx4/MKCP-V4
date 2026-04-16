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
      "GSTApplicable", "GSTTypeOfSupply", "GSTDetails", "HSNDetails", "GUID",
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
      "PartyLedgerName", "IsCancelled", "IsOptional", "EffectiveDate",
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
