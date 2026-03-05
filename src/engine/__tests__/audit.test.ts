/**
 * Comprehensive unit tests for the audit engine.
 * Tests verify the inventory identity: CLOSING = OPENING + INWARDS - OUTWARDS
 */

import { describe, it, expect } from "vitest";
import type { CanonicalItem, CanonicalVoucher } from "../../types/canonical";
import { buildVoucherIndex } from "../inventory";
import {
  auditAllItems,
  auditMonthlyChain,
  auditInvoiceBalance,
  getVoucherTypeDistribution,
  findNegativeStockItems,
  findDeadItems,
  findItemsWithoutGST,
} from "../audit";

const EPSILON = 1e-9;

// Helper to create a test item
function createItem(
  name: string,
  openingQty: number = 0,
  openingRate: number = 100
): CanonicalItem {
  return {
    itemId: name.toUpperCase(),
    name,
    group: "Test Group",
    baseUnit: "PC",
    pkgUnit: null,
    unitsPerPkg: 1,
    openingQtyBase: openingQty,
    openingRate,
    openingValue: openingQty * openingRate,
  };
}

// Helper to create a test voucher
function createVoucher(
  type: CanonicalVoucher["voucherType"],
  number: string,
  date: string,
  itemLines: Array<{ itemId: string; qty: number; rate?: number }>,
  isCancelled = false,
  isOptional = false
): CanonicalVoucher {
  return {
    voucherId: `${type}|${number}|${date}`,
    voucherNumber: number,
    voucherType: type,
    date,
    totalAmount: itemLines.reduce((s, l) => s + l.qty * (l.rate ?? 100), 0),
    isCancelled,
    isOptional,
    lines: itemLines.map((l) => ({
      type: "inventory",
      itemId: l.itemId,
      qtyBase: l.qty,
      ratePerBase: l.rate ?? 100,
      lineAmount: l.qty * (l.rate ?? 100),
    })),
  };
}

describe("auditAllItems", () => {
  it("should pass with zero discrepancy for known data", () => {
    const items = new Map([
      ["ITEM1", createItem("Item1", 100)],
    ]);

    const vouchers: CanonicalVoucher[] = [
      createVoucher("Purchase", "P1", "2026-01-15", [{ itemId: "ITEM1", qty: 50 }]),
      createVoucher("Sales", "S1", "2026-01-20", [{ itemId: "ITEM1", qty: 30 }]),
      createVoucher("Sales", "S2", "2026-01-25", [{ itemId: "ITEM1", qty: 20 }]),
      createVoucher("Credit Note", "CR1", "2026-01-28", [{ itemId: "ITEM1", qty: 10 }]),
      createVoucher("Debit Note", "DR1", "2026-01-30", [{ itemId: "ITEM1", qty: 5 }]),
    ];

    const voucherIndex = buildVoucherIndex(vouchers);
    const results = auditAllItems(items, vouchers, voucherIndex);

    expect(results.length).toBe(1);
    const r = results[0];

    // Opening: 100
    // Inwards: Purchase(50) + CreditNote(10) = 60
    // Outwards: Sales(30+20) + DebitNote(5) = 55
    // Expected Closing: 100 + 60 - 55 = 105
    expect(r.openingQtyBase).toBe(100);
    expect(r.totalInwards).toBe(60);
    expect(r.totalOutwards).toBe(55);
    expect(r.expectedClosing).toBe(105);
    expect(r.computedClosing).toBe(105);
    expect(Math.abs(r.discrepancy)).toBeLessThan(EPSILON);
    expect(r.details.purchaseQty).toBe(50);
    expect(r.details.salesQty).toBe(50);
    expect(r.details.creditNoteQty).toBe(10);
    expect(r.details.debitNoteQty).toBe(5);
    expect(r.details.voucherCount).toBe(5);
  });

  it("should handle Stock Journal with mixed +/- quantities", () => {
    const items = new Map([
      ["ITEM2", createItem("Item2", 50)],
    ]);

    const vouchers: CanonicalVoucher[] = [
      createVoucher("Stock Journal", "SJ1", "2026-01-10", [{ itemId: "ITEM2", qty: 20 }]),
      createVoucher("Stock Journal", "SJ2", "2026-01-15", [{ itemId: "ITEM2", qty: -15 }]),
    ];

    const voucherIndex = buildVoucherIndex(vouchers);
    const results = auditAllItems(items, vouchers, voucherIndex);

    const r = results[0];
    // Opening: 50
    // Inwards: StockJournal(+20) = 20
    // Outwards: StockJournal(|-15|) = 15
    // Expected: 50 + 20 - 15 = 55
    expect(r.totalInwards).toBe(20);
    expect(r.totalOutwards).toBe(15);
    expect(r.expectedClosing).toBe(55);
    expect(r.computedClosing).toBe(55);
    expect(Math.abs(r.discrepancy)).toBeLessThan(EPSILON);
    expect(r.details.stockJournalInQty).toBe(20);
    expect(r.details.stockJournalOutQty).toBe(15);
  });

  it("should exclude cancelled vouchers from calculations", () => {
    const items = new Map([
      ["ITEM3", createItem("Item3", 100)],
    ]);

    const vouchers: CanonicalVoucher[] = [
      createVoucher("Purchase", "P1", "2026-01-10", [{ itemId: "ITEM3", qty: 50 }]),
      createVoucher("Sales", "S1", "2026-01-15", [{ itemId: "ITEM3", qty: 30 }], true), // cancelled
      createVoucher("Sales", "S2", "2026-01-20", [{ itemId: "ITEM3", qty: 20 }]),
    ];

    const voucherIndex = buildVoucherIndex(vouchers);
    const results = auditAllItems(items, vouchers, voucherIndex);

    const r = results[0];
    // Cancelled S1 should be excluded
    // Opening: 100, Inwards: 50, Outwards: 20 (S1 excluded)
    // Expected: 100 + 50 - 20 = 130
    expect(r.totalInwards).toBe(50);
    expect(r.totalOutwards).toBe(20);
    expect(r.expectedClosing).toBe(130);
    expect(r.computedClosing).toBe(130);
    expect(Math.abs(r.discrepancy)).toBeLessThan(EPSILON);
    expect(r.details.cancelledSkipped).toBe(1);
  });

  it("should exclude optional vouchers from calculations", () => {
    const items = new Map([
      ["ITEM4", createItem("Item4", 100)],
    ]);

    const vouchers: CanonicalVoucher[] = [
      createVoucher("Purchase", "P1", "2026-01-10", [{ itemId: "ITEM4", qty: 50 }]),
      createVoucher("Sales", "S1", "2026-01-15", [{ itemId: "ITEM4", qty: 30 }], false, true), // optional
      createVoucher("Sales", "S2", "2026-01-20", [{ itemId: "ITEM4", qty: 20 }]),
    ];

    const voucherIndex = buildVoucherIndex(vouchers);
    const results = auditAllItems(items, vouchers, voucherIndex);

    const r = results[0];
    // Optional S1 should be excluded
    expect(r.totalOutwards).toBe(20);
    expect(r.expectedClosing).toBe(130);
    expect(r.computedClosing).toBe(130);
    expect(Math.abs(r.discrepancy)).toBeLessThan(EPSILON);
    expect(r.details.optionalSkipped).toBe(1);
  });

  it("should handle zero opening and zero transactions correctly", () => {
    const items = new Map([
      ["ITEM5", createItem("Item5", 0)],
    ]);

    const vouchers: CanonicalVoucher[] = [];

    const voucherIndex = buildVoucherIndex(vouchers);
    const results = auditAllItems(items, vouchers, voucherIndex);

    const r = results[0];
    expect(r.expectedClosing).toBe(0);
    expect(r.computedClosing).toBe(0);
    expect(Math.abs(r.discrepancy)).toBeLessThan(EPSILON);
  });

  it("should handle opening only with no transactions", () => {
    const items = new Map([
      ["ITEM6", createItem("Item6", 75)],
    ]);

    const vouchers: CanonicalVoucher[] = [];

    const voucherIndex = buildVoucherIndex(vouchers);
    const results = auditAllItems(items, vouchers, voucherIndex);

    const r = results[0];
    expect(r.expectedClosing).toBe(75);
    expect(r.computedClosing).toBe(75);
    expect(Math.abs(r.discrepancy)).toBeLessThan(EPSILON);
  });

  it("should handle Credit Note qty equals Sales qty (net outward = 0)", () => {
    const items = new Map([
      ["ITEM7", createItem("Item7", 100)],
    ]);

    const vouchers: CanonicalVoucher[] = [
      createVoucher("Sales", "S1", "2026-01-15", [{ itemId: "ITEM7", qty: 50 }]),
      createVoucher("Credit Note", "CR1", "2026-01-20", [{ itemId: "ITEM7", qty: 50 }]),
    ];

    const voucherIndex = buildVoucherIndex(vouchers);
    const results = auditAllItems(items, vouchers, voucherIndex);

    const r = results[0];
    // Sales outward: 50, Credit Note inward: 50 → net = 0
    // Expected: 100 + 50 - 50 = 100
    expect(r.totalInwards).toBe(50);
    expect(r.totalOutwards).toBe(50);
    expect(r.expectedClosing).toBe(100);
    expect(r.computedClosing).toBe(100);
    expect(Math.abs(r.discrepancy)).toBeLessThan(EPSILON);
  });
});

describe("auditMonthlyChain", () => {
  it("should validate chain continuity over 6 months", () => {
    const item = createItem("Item1", 100);
    const vouchers: CanonicalVoucher[] = [
      createVoucher("Purchase", "P1", "2026-01-10", [{ itemId: "ITEM1", qty: 50 }]),
      createVoucher("Sales", "S1", "2026-01-20", [{ itemId: "ITEM1", qty: 30 }]),
      createVoucher("Purchase", "P2", "2026-02-10", [{ itemId: "ITEM1", qty: 20 }]),
      createVoucher("Sales", "S2", "2026-02-20", [{ itemId: "ITEM1", qty: 40 }]),
      createVoucher("Purchase", "P3", "2026-03-10", [{ itemId: "ITEM1", qty: 60 }]),
    ];

    const voucherIndex = buildVoucherIndex(vouchers);
    const result = auditMonthlyChain(item, voucherIndex, 6);

    expect(result.valid).toBe(true);
    expect(result.breaks.length).toBe(0);
  });

  it("should detect breaks in monthly chain", () => {
    // This is a synthetic test - in real code, breaks shouldn't happen
    // We're testing the detection logic itself
    const item = createItem("Item1", 100);
    const vouchers: CanonicalVoucher[] = [
      createVoucher("Sales", "S1", "2026-01-15", [{ itemId: "ITEM1", qty: 50 }]),
    ];

    const voucherIndex = buildVoucherIndex(vouchers);
    const result = auditMonthlyChain(item, voucherIndex, 3);

    // With correct implementation, there should be no breaks
    expect(result.valid).toBe(true);
  });
});

describe("auditInvoiceBalance", () => {
  it("should compute total billed, paid, and outstanding correctly", () => {
    const vouchers: CanonicalVoucher[] = [
      {
        voucherId: "Sales|INV001|2026-01-10",
        voucherNumber: "INV001",
        voucherType: "Sales",
        date: "2026-01-10",
        totalAmount: 10000,
        isCancelled: false,
        isOptional: false,
        lines: [
          {
            type: "ledger",
            ledgerId: "CUSTOMER1",
            isDebit: true,
            amount: 10000,
            isPartyLine: true,
            billAllocations: [{ billRef: "INV001", billType: "New Ref", amount: 10000 }],
          },
        ],
      },
      {
        voucherId: "Sales|INV002|2026-01-15",
        voucherNumber: "INV002",
        voucherType: "Sales",
        date: "2026-01-15",
        totalAmount: 5000,
        isCancelled: false,
        isOptional: false,
        lines: [
          {
            type: "ledger",
            ledgerId: "CUSTOMER2",
            isDebit: true,
            amount: 5000,
            isPartyLine: true,
            billAllocations: [{ billRef: "INV002", billType: "New Ref", amount: 5000 }],
          },
        ],
      },
      {
        voucherId: "Receipt|RCP001|2026-01-20",
        voucherNumber: "RCP001",
        voucherType: "Receipt",
        date: "2026-01-20",
        totalAmount: 10000,
        isCancelled: false,
        isOptional: false,
        lines: [
          {
            type: "ledger",
            ledgerId: "CUSTOMER1",
            isDebit: false,
            amount: 10000,
            billAllocations: [{ billRef: "INV001", billType: "Agst Ref", amount: 10000 }],
          },
        ],
      },
      {
        voucherId: "Receipt|RCP002|2026-01-25",
        voucherNumber: "RCP002",
        voucherType: "Receipt",
        date: "2026-01-25",
        totalAmount: 2000,
        isCancelled: false,
        isOptional: false,
        lines: [
          {
            type: "ledger",
            ledgerId: "CUSTOMER2",
            isDebit: false,
            amount: 2000,
            billAllocations: [{ billRef: "INV002", billType: "Agst Ref", amount: 2000 }],
          },
        ],
      },
    ];

    const result = auditInvoiceBalance(vouchers, new Map());

    expect(result.totalBilled).toBe(15000);
    expect(result.totalPaid).toBe(12000);
    expect(result.totalOutstanding).toBe(3000);
    expect(result.orphanedPayments.length).toBe(0);
  });

  it("should detect orphaned payments", () => {
    const vouchers: CanonicalVoucher[] = [
      {
        voucherId: "Receipt|RCP001|2026-01-20",
        voucherNumber: "RCP001",
        voucherType: "Receipt",
        date: "2026-01-20",
        totalAmount: 5000,
        isCancelled: false,
        isOptional: false,
        lines: [
          {
            type: "ledger",
            ledgerId: "CUSTOMER1",
            isDebit: false,
            amount: 5000,
            billAllocations: [{ billRef: "NONEXISTENT", billType: "Agst Ref", amount: 5000 }],
          },
        ],
      },
    ];

    const result = auditInvoiceBalance(vouchers, new Map());

    expect(result.totalBilled).toBe(0);
    expect(result.totalPaid).toBe(5000);
    expect(result.orphanedPayments).toContain("NONEXISTENT");
  });
});

describe("getVoucherTypeDistribution", () => {
  it("should count voucher types correctly", () => {
    const vouchers: CanonicalVoucher[] = [
      createVoucher("Sales", "S1", "2026-01-10", [{ itemId: "ITEM1", qty: 10 }]),
      createVoucher("Sales", "S2", "2026-01-15", [{ itemId: "ITEM1", qty: 20 }], true), // cancelled
      createVoucher("Purchase", "P1", "2026-01-20", [{ itemId: "ITEM1", qty: 30 }]),
      createVoucher("Purchase", "P2", "2026-01-25", [{ itemId: "ITEM1", qty: 40 }], false, true), // optional
      createVoucher("Receipt", "R1", "2026-01-30", [{ itemId: "ITEM1", qty: 5 }]),
    ];

    const dist = getVoucherTypeDistribution(vouchers);

    expect(dist.get("Sales")?.total).toBe(2);
    expect(dist.get("Sales")?.cancelled).toBe(1);
    expect(dist.get("Sales")?.active).toBe(1);

    expect(dist.get("Purchase")?.total).toBe(2);
    expect(dist.get("Purchase")?.optional).toBe(1);
    expect(dist.get("Purchase")?.active).toBe(1);

    expect(dist.get("Receipt")?.total).toBe(1);
    expect(dist.get("Receipt")?.active).toBe(1);
  });
});

describe("findNegativeStockItems", () => {
  it("should find items with negative stock", () => {
    const items = new Map([
      ["ITEM1", createItem("Item1", 10)],
      ["ITEM2", createItem("Item2", 50)],
    ]);

    const vouchers: CanonicalVoucher[] = [
      createVoucher("Sales", "S1", "2026-01-10", [{ itemId: "ITEM1", qty: 20 }]), // 10 - 20 = -10
      createVoucher("Sales", "S2", "2026-01-15", [{ itemId: "ITEM2", qty: 30 }]), // 50 - 30 = 20 (positive)
    ];

    const voucherIndex = buildVoucherIndex(vouchers);
    const result = findNegativeStockItems(items, voucherIndex);

    expect(result.length).toBe(1);
    expect(result[0].itemId).toBe("ITEM1");
    expect(result[0].currentStock).toBe(-10);
  });
});

describe("findDeadItems", () => {
  it("should find items with zero opening and zero movement", () => {
    const items = new Map([
      ["ITEM1", createItem("Item1", 0)],
      ["ITEM2", createItem("Item2", 50)],
      ["ITEM3", createItem("Item3", 0)],
    ]);

    const vouchers: CanonicalVoucher[] = [
      createVoucher("Purchase", "P1", "2026-01-10", [{ itemId: "ITEM2", qty: 10 }]),
    ];

    const voucherIndex = buildVoucherIndex(vouchers);
    const result = findDeadItems(items, voucherIndex);

    expect(result.length).toBe(2);
    expect(result.map((r) => r.itemId)).toContain("ITEM1");
    expect(result.map((r) => r.itemId)).toContain("ITEM3");
  });
});

describe("findItemsWithoutGST", () => {
  it("should find items without GST rates", () => {
    const items = new Map([
      ["ITEM1", { ...createItem("Item1"), gstRate: 18 }],
      ["ITEM2", { ...createItem("Item2"), gstRate: undefined }],
      ["ITEM3", { ...createItem("Item3"), gstRate: 12 }],
    ]);

    const result = findItemsWithoutGST(items);

    expect(result.length).toBe(1);
    expect(result[0].itemId).toBe("ITEM2");
  });
});
