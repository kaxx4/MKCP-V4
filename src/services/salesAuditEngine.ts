/**
 * Sales Audit Engine
 * Comprehensive audit logging and discrepancy tracking
 */

import type { SalesInvoice, AuditLogEntry } from "../types/sales";
import type { ParsedData } from "../types/canonical";

export interface AuditReport {
  invoiceId: string;
  timestamp: string;
  status: "clean" | "warning" | "critical";
  totalActions: number;
  criticalIssues: string[];
  warnings: string[];
  rateChanges: Array<{
    itemId: string;
    itemName: string;
    oldRate: number;
    newRate: number;
    variance: number;
  }>;
  calculations: Array<{
    action: string;
    before: unknown;
    after: unknown;
    details: string;
  }>;
}

/**
 * Generate comprehensive audit report for an invoice
 */
export function generateAuditReport(
  invoice: SalesInvoice,
  tallyData: ParsedData
): AuditReport {
  const report: AuditReport = {
    invoiceId: invoice.header.id,
    timestamp: new Date().toISOString(),
    status: "clean",
    totalActions: invoice.auditLog.length,
    criticalIssues: [],
    warnings: [],
    rateChanges: [],
    calculations: []
  };

  // Analyze each audit log entry
  for (const entry of invoice.auditLog) {
    if (entry.action === "item_added") {
      const itemId = entry.details.itemId as string;
      const tallyItem = tallyData.items.get(itemId);

      if (!tallyItem) {
        report.criticalIssues.push(`Item ${itemId} not found in current Tally data`);
        report.status = "critical";
      }
    }

    if (entry.action === "quantity_changed") {
      const oldQty = entry.details.oldQuantity as number;
      const newQty = entry.details.newQuantity as number;
      const itemName = entry.details.itemName as string;

      if (oldQty > 0 && newQty > oldQty * 2) {
        report.warnings.push(`Quantity for ${itemName} increased significantly: ${oldQty} → ${newQty}`);
      }
    }

    if (entry.action === "validated" && entry.validationResult) {
      if (!entry.validationResult.passed) {
        report.status = "critical";
        report.criticalIssues.push(...entry.validationResult.discrepancies);
      }
    }
  }

  // Check for rate changes
  for (const item of invoice.items) {
    const tallyItem = tallyData.items.get(item.itemId);
    if (tallyItem && Math.abs(tallyItem.currentRate - item.ratePerBaseUnit) > 0.01) {
      const variance = ((tallyItem.currentRate - item.ratePerBaseUnit) / item.ratePerBaseUnit) * 100;

      report.rateChanges.push({
        itemId: item.itemId,
        itemName: item.itemName,
        oldRate: item.ratePerBaseUnit,
        newRate: tallyItem.currentRate,
        variance
      });

      if (Math.abs(variance) > 5) {
        report.status = "warning";
        report.warnings.push(
          `Rate change for ${item.itemName}: ${variance > 0 ? "↑" : "↓"} ${Math.abs(variance).toFixed(1)}%`
        );
      }
    }
  }

  return report;
}

/**
 * Add audit log entry to invoice
 */
export function addAuditLogEntry(
  invoice: SalesInvoice,
  action: string,
  details: Record<string, unknown>
): SalesInvoice {
  const entry: AuditLogEntry = {
    timestamp: new Date().toISOString(),
    action,
    details
  };

  return {
    ...invoice,
    auditLog: [...invoice.auditLog, entry]
  };
}

/**
 * Log item addition
 */
export function logItemAdded(
  invoice: SalesInvoice,
  itemId: string,
  itemName: string,
  quantity: number,
  rate: number
): SalesInvoice {
  return addAuditLogEntry(invoice, "item_added", {
    itemId,
    itemName,
    quantity,
    rate
  });
}

/**
 * Log quantity change
 */
export function logQuantityChange(
  invoice: SalesInvoice,
  itemId: string,
  itemName: string,
  oldQuantity: number,
  newQuantity: number
): SalesInvoice {
  return addAuditLogEntry(invoice, "quantity_changed", {
    itemId,
    itemName,
    oldQuantity,
    newQuantity,
    change: newQuantity - oldQuantity,
    changePercent: ((newQuantity - oldQuantity) / oldQuantity) * 100
  });
}

/**
 * Log item removal
 */
export function logItemRemoved(
  invoice: SalesInvoice,
  itemId: string,
  itemName: string,
  amount: number
): SalesInvoice {
  return addAuditLogEntry(invoice, "item_removed", {
    itemId,
    itemName,
    amount
  });
}

/**
 * Log unit toggle
 */
export function logUnitToggle(
  invoice: SalesInvoice,
  fromUnit: "base" | "package",
  toUnit: "base" | "package"
): SalesInvoice {
  return addAuditLogEntry(invoice, "unit_toggled", {
    from: fromUnit,
    to: toUnit,
    itemsCount: invoice.items.length
  });
}

/**
 * Log validation
 */
export function logValidation(
  invoice: SalesInvoice,
  passed: boolean,
  errors: string[],
  discrepancies: string[]
): SalesInvoice {
  return addAuditLogEntry(invoice, "validated", {
    passed,
    errorCount: errors.length,
    discrepancyCount: discrepancies.length
  });
}

/**
 * Format audit report for display
 */
export function formatAuditReport(report: AuditReport): string {
  let output = "";

  output += `═══════════════════════════════════════════\n`;
  output += `📋 AUDIT REPORT\n`;
  output += `═══════════════════════════════════════════\n\n`;

  output += `Invoice ID: ${report.invoiceId}\n`;
  output += `Report Time: ${new Date(report.timestamp).toLocaleString()}\n`;
  output += `Status: ${report.status === "clean" ? "✅ CLEAN" : report.status === "warning" ? "⚠️ WARNING" : "❌ CRITICAL"}\n`;
  output += `Total Actions Logged: ${report.totalActions}\n\n`;

  if (report.criticalIssues.length > 0) {
    output += `🔴 CRITICAL ISSUES (${report.criticalIssues.length}):\n`;
    for (const issue of report.criticalIssues) {
      output += `  • ${issue}\n`;
    }
    output += "\n";
  }

  if (report.warnings.length > 0) {
    output += `🟡 WARNINGS (${report.warnings.length}):\n`;
    for (const warning of report.warnings) {
      output += `  • ${warning}\n`;
    }
    output += "\n";
  }

  if (report.rateChanges.length > 0) {
    output += `📊 RATE CHANGES (${report.rateChanges.length}):\n`;
    for (const change of report.rateChanges) {
      const arrow = change.variance > 0 ? "↑" : "↓";
      output += `  ${arrow} ${change.itemName}: ₹${change.oldRate.toFixed(2)} → ₹${change.newRate.toFixed(2)} (${change.variance > 0 ? "+" : ""}${change.variance.toFixed(1)}%)\n`;
    }
    output += "\n";
  }

  if (report.criticalIssues.length === 0 && report.warnings.length === 0) {
    output += `✅ NO ISSUES DETECTED\n`;
  }

  output += `═══════════════════════════════════════════\n`;

  return output;
}

/**
 * Print audit report to console
 */
export function printAuditReport(report: AuditReport): void {
  console.log(formatAuditReport(report));
}

/**
 * Export audit report as JSON
 */
export function exportAuditReportJSON(report: AuditReport): string {
  return JSON.stringify(report, null, 2);
}

/**
 * Export audit report as CSV
 */
export function exportAuditReportCSV(report: AuditReport): string {
  let csv = "Type,Item,OldValue,NewValue,Variance\n";

  for (const change of report.rateChanges) {
    csv += `Rate,${change.itemName},${change.oldRate},${change.newRate},${change.variance.toFixed(2)}%\n`;
  }

  for (const warning of report.warnings) {
    csv += `Warning,,,,${warning}\n`;
  }

  for (const issue of report.criticalIssues) {
    csv += `Critical,,,,${issue}\n`;
  }

  return csv;
}
