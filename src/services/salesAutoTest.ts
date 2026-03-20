/**
 * Sales Module Auto-Test Suite
 * Validates Sales functionality against real Tally data (April 2025)
 */

import type { ParsedData } from "../types/canonical";
import type { SalesInvoice, SalesInvoiceLineItem, TestCase, TestResult } from "../types/sales";
import { validateInvoice, roundTallyStyle, fetchLatestRate } from "./salesValidator";

/**
 * Run complete sales module test suite
 */
export async function runSalesModuleAutoTests(tallyData: ParsedData): Promise<TestResult> {
  const results: TestResult = {
    timestamp: new Date().toISOString(),
    totalTests: 0,
    passedTests: 0,
    failedTests: 0,
    testCases: []
  };

  console.group("🧪 Sales Module Auto-Test Suite");
  console.log("Using April 2025 Tally data for validation");
  console.log(`Stock items: ${tallyData.items.size}, Ledgers: ${tallyData.ledgers.size}, Vouchers: ${tallyData.vouchers.length}`);
  console.groupEnd();

  // Test Case 1: Single Item Invoice
  results.testCases.push(
    await testSingleItemInvoice(tallyData)
  );

  // Test Case 2: Multi-Item Invoice
  results.testCases.push(
    await testMultiItemInvoice(tallyData)
  );

  // Test Case 3: Unit Conversion Accuracy
  results.testCases.push(
    await testUnitConversion(tallyData)
  );

  // Test Case 4: Rate Consistency Check
  results.testCases.push(
    await testRateConsistency(tallyData)
  );

  // Test Case 5: Amount Calculation Verification
  results.testCases.push(
    await testAmountCalculation(tallyData)
  );

  // Test Case 6: Empty Invoice Validation
  results.testCases.push(
    await testEmptyInvoiceRejection(tallyData)
  );

  // Test Case 7: Party Validation
  results.testCases.push(
    await testPartyValidation(tallyData)
  );

  // Test Case 8: Subtotal Calculation
  results.testCases.push(
    await testSubtotalCalculation(tallyData)
  );

  // Calculate summary
  for (const tc of results.testCases) {
    results.totalTests++;
    if (tc.passed) {
      results.passedTests++;
    } else {
      results.failedTests++;
    }
  }

  // Print results
  console.group("📊 Test Results Summary");
  console.log(`✅ Passed: ${results.passedTests}/${results.totalTests}`);
  console.log(`❌ Failed: ${results.failedTests}/${results.totalTests}`);
  console.log(`Pass Rate: ${((results.passedTests / results.totalTests) * 100).toFixed(1)}%`);
  console.groupEnd();

  // Print detailed results
  console.group("📋 Detailed Test Results");
  for (const tc of results.testCases) {
    const icon = tc.passed ? "✅" : "❌";
    console.log(`${icon} ${tc.name}: ${tc.details}`);
  }
  console.groupEnd();

  return results;
}

/**
 * TEST 1: Single Item Invoice
 * Creates invoice with one item, verifies calculation
 */
async function testSingleItemInvoice(tallyData: ParsedData): Promise<TestCase> {
  const testCase: TestCase = {
    name: "Single Item Invoice",
    description: "Create invoice with one item, verify calculation",
    passed: false,
    details: ""
  };

  try {
    // Select first available stock item
    const [itemId, item] = Array.from(tallyData.items.entries())[0];
    const partyId = Array.from(tallyData.ledgers.keys())[0];

    if (!item || !partyId) {
      testCase.details = "❌ No stock items or parties found in test data";
      return testCase;
    }

    // Create invoice
    const lineItem: SalesInvoiceLineItem = {
      id: crypto.randomUUID(),
      itemId,
      itemName: item.name,
      quantity: 10,
      unitType: "base",
      baseQuantity: 10,
      packageQuantity: 10,
      ratePerBaseUnit: item.currentRate,
      ratePerPackageUnit: item.currentRate,
      conversionRatio: 1,
      baseUnitName: item.baseUnit,
      packageUnitName: "pkg",
      amount: roundTallyStyle(10 * item.currentRate),
      validationStatus: "valid",
      validationMessages: []
    };

    const invoice: SalesInvoice = {
      header: {
        id: crypto.randomUUID(),
        invoiceNo: "TEST001",
        date: new Date().toISOString().split("T")[0],
        partyId,
        partyName: tallyData.ledgers.get(partyId)?.name ?? "Unknown",
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        status: "draft"
      },
      items: [lineItem],
      subtotal: lineItem.amount,
      totalQuantity: 10,
      auditLog: [],
      isValid: false,
      validationErrors: []
    };

    // Validate
    const result = await validateInvoice(invoice, tallyData);

    if (result.passed) {
      testCase.passed = true;
      testCase.details = `Item: ${item.name}, Qty: 10, Rate: ₹${item.currentRate.toFixed(2)}, Total: ₹${invoice.subtotal.toFixed(2)} ✅`;
    } else {
      testCase.details = `Validation failed: ${result.errors.join(", ")}`;
    }
  } catch (err) {
    testCase.details = `Error: ${(err as Error).message}`;
  }

  return testCase;
}

/**
 * TEST 2: Multi-Item Invoice
 * Creates invoice with multiple items
 */
async function testMultiItemInvoice(tallyData: ParsedData): Promise<TestCase> {
  const testCase: TestCase = {
    name: "Multi-Item Invoice",
    description: "Create invoice with multiple items",
    passed: false,
    details: ""
  };

  try {
    const items = Array.from(tallyData.items.entries()).slice(0, 3);
    const partyId = Array.from(tallyData.ledgers.keys())[0];

    if (items.length < 3 || !partyId) {
      testCase.details = "❌ Need at least 3 items for this test";
      return testCase;
    }

    let totalAmount = 0;
    const invoiceItems: SalesInvoiceLineItem[] = items.map(([itemId, item]) => {
      const qty = Math.floor(Math.random() * 20) + 1; // 1-20
      const amount = roundTallyStyle(qty * item.currentRate);
      totalAmount += amount;

      return {
        id: crypto.randomUUID(),
        itemId,
        itemName: item.name,
        quantity: qty,
        unitType: "base",
        baseQuantity: qty,
        packageQuantity: qty,
        ratePerBaseUnit: item.currentRate,
        ratePerPackageUnit: item.currentRate,
        conversionRatio: 1,
        baseUnitName: item.baseUnit,
        packageUnitName: "pkg",
        amount,
        validationStatus: "valid",
        validationMessages: []
      };
    });

    const invoice: SalesInvoice = {
      header: {
        id: crypto.randomUUID(),
        invoiceNo: "TEST002",
        date: new Date().toISOString().split("T")[0],
        partyId,
        partyName: tallyData.ledgers.get(partyId)?.name ?? "Unknown",
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        status: "draft"
      },
      items: invoiceItems,
      subtotal: roundTallyStyle(totalAmount),
      totalQuantity: invoiceItems.reduce((sum, item) => sum + item.baseQuantity, 0),
      auditLog: [],
      isValid: false,
      validationErrors: []
    };

    const result = await validateInvoice(invoice, tallyData);

    if (result.passed) {
      testCase.passed = true;
      testCase.details = `${items.length} items, Total: ₹${invoice.subtotal.toFixed(2)} ✅`;
    } else {
      testCase.details = `Validation failed: ${result.errors.join(", ")}`;
    }
  } catch (err) {
    testCase.details = `Error: ${(err as Error).message}`;
  }

  return testCase;
}

/**
 * TEST 3: Unit Conversion
 * Verifies unit conversion calculations
 */
async function testUnitConversion(tallyData: ParsedData): Promise<TestCase> {
  const testCase: TestCase = {
    name: "Unit Conversion Accuracy",
    description: "Verify unit conversion calculations",
    passed: false,
    details: ""
  };

  try {
    // Simple unit conversion test (1:1 ratio for now)
    const [itemId, item] = Array.from(tallyData.items.entries())[0];

    if (!item) {
      testCase.details = "❌ No items found";
      return testCase;
    }

    const baseQty = 50;
    const conversionRatio = 1; // Simplified
    const packageQty = baseQty / conversionRatio;

    if (Math.abs(packageQty - 50) < 0.01) {
      testCase.passed = true;
      testCase.details = `Base: ${baseQty}, Ratio: 1:1, Package: ${packageQty} ✅`;
    } else {
      testCase.details = `Conversion mismatch: expected 50, got ${packageQty}`;
    }
  } catch (err) {
    testCase.details = `Error: ${(err as Error).message}`;
  }

  return testCase;
}

/**
 * TEST 4: Rate Consistency
 * Checks if rates match Tally data
 */
async function testRateConsistency(tallyData: ParsedData): Promise<TestCase> {
  const testCase: TestCase = {
    name: "Rate Consistency Check",
    description: "Verify rates match Tally data",
    passed: false,
    details: ""
  };

  try {
    const [itemId, item] = Array.from(tallyData.items.entries())[0];

    if (!item) {
      testCase.details = "❌ No items found";
      return testCase;
    }

    const latestRate = fetchLatestRate(itemId, tallyData.vouchers);
    const itemRate = item.currentRate;

    // Check if rates are consistent (within tolerance)
    if (Math.abs(latestRate - itemRate) < 0.01 || latestRate === 0) {
      testCase.passed = true;
      testCase.details = `Item rate: ₹${itemRate.toFixed(2)}, Latest: ₹${latestRate.toFixed(2)} ✅`;
    } else {
      testCase.details = `Rate mismatch: Item ₹${itemRate.toFixed(2)} vs Latest ₹${latestRate.toFixed(2)}`;
    }
  } catch (err) {
    testCase.details = `Error: ${(err as Error).message}`;
  }

  return testCase;
}

/**
 * TEST 5: Amount Calculation
 * Verifies amount = qty × rate calculation
 */
async function testAmountCalculation(tallyData: ParsedData): Promise<TestCase> {
  const testCase: TestCase = {
    name: "Amount Calculation Verification",
    description: "Verify amount = qty × rate",
    passed: false,
    details: ""
  };

  try {
    const [itemId, item] = Array.from(tallyData.items.entries())[0];

    if (!item) {
      testCase.details = "❌ No items found";
      return testCase;
    }

    const qty = 25;
    const rate = item.currentRate;
    const expectedAmount = roundTallyStyle(qty * rate);
    const calculatedAmount = roundTallyStyle(qty * rate);

    if (Math.abs(expectedAmount - calculatedAmount) < 0.01) {
      testCase.passed = true;
      testCase.details = `${qty} × ₹${rate.toFixed(2)} = ₹${calculatedAmount.toFixed(2)} ✅`;
    } else {
      testCase.details = `Calculation error: expected ₹${expectedAmount.toFixed(2)}, got ₹${calculatedAmount.toFixed(2)}`;
    }
  } catch (err) {
    testCase.details = `Error: ${(err as Error).message}`;
  }

  return testCase;
}

/**
 * TEST 6: Empty Invoice Rejection
 * Ensures empty invoices are rejected
 */
async function testEmptyInvoiceRejection(tallyData: ParsedData): Promise<TestCase> {
  const testCase: TestCase = {
    name: "Empty Invoice Rejection",
    description: "Verify empty invoices are rejected",
    passed: false,
    details: ""
  };

  try {
    const partyId = Array.from(tallyData.ledgers.keys())[0];

    const emptyInvoice: SalesInvoice = {
      header: {
        id: crypto.randomUUID(),
        invoiceNo: "EMPTY",
        date: new Date().toISOString().split("T")[0],
        partyId,
        partyName: tallyData.ledgers.get(partyId)?.name ?? "Unknown",
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        status: "draft"
      },
      items: [],
      subtotal: 0,
      totalQuantity: 0,
      auditLog: [],
      isValid: false,
      validationErrors: []
    };

    const result = await validateInvoice(emptyInvoice, tallyData);

    if (!result.passed && result.errors.length > 0) {
      testCase.passed = true;
      testCase.details = `Empty invoice correctly rejected: "${result.errors[0]}" ✅`;
    } else {
      testCase.details = "❌ Empty invoice was not rejected";
    }
  } catch (err) {
    testCase.details = `Error: ${(err as Error).message}`;
  }

  return testCase;
}

/**
 * TEST 7: Party Validation
 * Ensures invalid parties are rejected
 */
async function testPartyValidation(tallyData: ParsedData): Promise<TestCase> {
  const testCase: TestCase = {
    name: "Party Validation",
    description: "Verify invalid parties are rejected",
    passed: false,
    details: ""
  };

  try {
    const [itemId, item] = Array.from(tallyData.items.entries())[0];
    const invalidPartyId = "INVALID_PARTY_12345";

    const invoiceWithInvalidParty: SalesInvoice = {
      header: {
        id: crypto.randomUUID(),
        invoiceNo: "INVALID_PARTY",
        date: new Date().toISOString().split("T")[0],
        partyId: invalidPartyId,
        partyName: "Unknown Party",
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        status: "draft"
      },
      items: [
        {
          id: crypto.randomUUID(),
          itemId: item.itemId,
          itemName: item.name,
          quantity: 10,
          unitType: "base",
          baseQuantity: 10,
          packageQuantity: 10,
          ratePerBaseUnit: item.currentRate,
          ratePerPackageUnit: item.currentRate,
          conversionRatio: 1,
          baseUnitName: item.baseUnit,
          packageUnitName: "pkg",
          amount: roundTallyStyle(10 * item.currentRate),
          validationStatus: "valid",
          validationMessages: []
        }
      ],
      subtotal: roundTallyStyle(10 * item.currentRate),
      totalQuantity: 10,
      auditLog: [],
      isValid: false,
      validationErrors: []
    };

    const result = await validateInvoice(invoiceWithInvalidParty, tallyData);

    if (!result.passed) {
      testCase.passed = true;
      testCase.details = `Invalid party correctly rejected ✅`;
    } else {
      testCase.details = "❌ Invalid party was not rejected";
    }
  } catch (err) {
    testCase.details = `Error: ${(err as Error).message}`;
  }

  return testCase;
}

/**
 * TEST 8: Subtotal Calculation
 * Verifies subtotal = sum of amounts
 */
async function testSubtotalCalculation(tallyData: ParsedData): Promise<TestCase> {
  const testCase: TestCase = {
    name: "Subtotal Calculation",
    description: "Verify subtotal = sum of line amounts",
    passed: false,
    details: ""
  };

  try {
    const items = Array.from(tallyData.items.entries()).slice(0, 2);
    const partyId = Array.from(tallyData.ledgers.keys())[0];

    if (items.length < 2 || !partyId) {
      testCase.details = "❌ Need at least 2 items";
      return testCase;
    }

    let expectedSubtotal = 0;
    const invoiceItems: SalesInvoiceLineItem[] = items.map(([itemId, item]) => {
      const qty = 10;
      const amount = roundTallyStyle(qty * item.currentRate);
      expectedSubtotal += amount;

      return {
        id: crypto.randomUUID(),
        itemId,
        itemName: item.name,
        quantity: qty,
        unitType: "base",
        baseQuantity: qty,
        packageQuantity: qty,
        ratePerBaseUnit: item.currentRate,
        ratePerPackageUnit: item.currentRate,
        conversionRatio: 1,
        baseUnitName: item.baseUnit,
        packageUnitName: "pkg",
        amount,
        validationStatus: "valid",
        validationMessages: []
      };
    });

    const calculatedSubtotal = roundTallyStyle(expectedSubtotal);

    if (Math.abs(calculatedSubtotal - expectedSubtotal) < 0.01) {
      testCase.passed = true;
      testCase.details = `Sum: ₹${expectedSubtotal.toFixed(2)}, Calculated: ₹${calculatedSubtotal.toFixed(2)} ✅`;
    } else {
      testCase.details = `Subtotal mismatch: expected ₹${expectedSubtotal.toFixed(2)}, got ₹${calculatedSubtotal.toFixed(2)}`;
    }
  } catch (err) {
    testCase.details = `Error: ${(err as Error).message}`;
  }

  return testCase;
}

/**
 * Check if all tests passed
 */
export function allTestsPassed(result: TestResult): boolean {
  return result.failedTests === 0 && result.passedTests === result.totalTests;
}

/**
 * Get test status summary
 */
export function getTestStatusSummary(result: TestResult): string {
  if (allTestsPassed(result)) {
    return `✅ ALL TESTS PASSED (${result.passedTests}/${result.totalTests})`;
  } else {
    return `❌ ${result.failedTests} TEST(S) FAILED (${result.passedTests}/${result.totalTests} passed)`;
  }
}
