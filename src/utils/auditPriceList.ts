/**
 * Audit the imported price list for anomalies.
 * Detects items with suspiciously low rates (likely cost prices mixed in opening balance).
 */

import type { ParsedData } from "../types/canonical";

export interface PriceAnomaly {
  itemId: string;
  itemName: string;
  openingRate: number;
  openingValue: number;
  openingQty: number;
  calculatedRate: number;
  flags: string[];
}

export interface PriceAuditResult {
  totalItems: number;
  anomalies: PriceAnomaly[];
  summary: {
    costPriceItems: number;
    zeroRateItems: number;
    missingValueItems: number;
  };
}

/**
 * Audit price list: find items where opening rate looks like cost price.
 * Heuristics:
 * - Baby items/finished goods should have markup over cost (usually 2-3x)
 * - Rate < ₹100 but qty > 0 suggests cost price (cost of baby items)
 * - Value = Qty × Rate; if inconsistent, may indicate import error
 */
export function auditPriceList(data: ParsedData | null): PriceAuditResult {
  const anomalies: PriceAnomaly[] = [];

  if (!data) {
    return {
      totalItems: 0,
      anomalies: [],
      summary: {
        costPriceItems: 0,
        zeroRateItems: 0,
        missingValueItems: 0,
      },
    };
  }

  let costPriceCount = 0;
  let zeroRateCount = 0;
  let missingValueCount = 0;

  for (const [_, item] of data.items) {
    const openingRate = item.openingRate || 0;
    const openingQty = item.openingQtyBase || 0;
    const openingValue = item.openingValue || 0;
    const flags: string[] = [];

    // Flag: Zero rate with opening quantity
    if (openingRate === 0 && openingQty > 0) {
      flags.push("ZERO_RATE_WITH_QTY");
      zeroRateCount++;
    }

    // Flag: Very low rate (< ₹50) — likely cost price
    if (0 < openingRate && openingRate < 50) {
      flags.push("SUSPICIOUSLY_LOW_RATE");
      costPriceCount++;
    }

    // Flag: Rate-Value mismatch (off by >10%)
    if (openingQty > 0 && openingValue > 0) {
      const calculatedRate = openingValue / openingQty;
      const deviation = Math.abs(openingRate - calculatedRate) / Math.max(openingRate, calculatedRate);
      if (deviation > 0.1) {
        flags.push("RATE_VALUE_MISMATCH");
      }
    }

    // Flag: Baby/finished goods with low rate
    if (item.name.toLowerCase().includes("baby") || item.name.toLowerCase().includes("tricycle")) {
      if (openingRate > 0 && openingRate < 500) {
        flags.push("BABY_ITEM_COST_PRICE");
        costPriceCount++;
      }
    }

    // Flag: Missing value but has rate and qty
    if (openingRate > 0 && openingQty > 0 && openingValue === 0) {
      flags.push("MISSING_OPENING_VALUE");
      missingValueCount++;
    }

    if (flags.length > 0) {
      anomalies.push({
        itemId: item.itemId,
        itemName: item.name,
        openingRate,
        openingValue,
        openingQty,
        calculatedRate: openingQty > 0 ? openingValue / openingQty : 0,
        flags,
      });
    }
  }

  // Sort by severity: cost price + baby items first
  anomalies.sort((a, b) => {
    const aWeight = a.flags.filter((f) => f.includes("COST") || f.includes("BABY")).length;
    const bWeight = b.flags.filter((f) => f.includes("COST") || f.includes("BABY")).length;
    return bWeight - aWeight;
  });

  return {
    totalItems: data.items.size,
    anomalies: anomalies.slice(0, 100), // Limit to top 100 anomalies
    summary: {
      costPriceItems: costPriceCount,
      zeroRateItems: zeroRateCount,
      missingValueItems: missingValueCount,
    },
  };
}

/**
 * Export audit results as CSV for review in Excel.
 */
export function exportPriceAuditAsCSV(result: PriceAuditResult): string {
  const rows: string[] = [
    "Item ID,Item Name,Opening Rate,Opening Qty,Opening Value,Calculated Rate,Flags",
  ];

  for (const anom of result.anomalies) {
    const flags = anom.flags.join("; ");
    const row = [
      `"${anom.itemId}"`,
      `"${anom.itemName}"`,
      anom.openingRate.toFixed(2),
      anom.openingQty.toFixed(0),
      anom.openingValue.toFixed(0),
      anom.calculatedRate.toFixed(2),
      `"${flags}"`,
    ].join(",");
    rows.push(row);
  }

  rows.push(""); // Blank line
  rows.push("Summary:");
  rows.push(`Total Items,${result.totalItems}`);
  rows.push(`Anomalies Found,${result.anomalies.length}`);
  rows.push(`Cost Price Items,${result.summary.costPriceItems}`);
  rows.push(`Zero Rate Items,${result.summary.zeroRateItems}`);
  rows.push(`Missing Value Items,${result.summary.missingValueItems}`);

  return rows.join("\n");
}
