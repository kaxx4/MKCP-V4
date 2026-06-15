import type { CanonicalVoucher, CanonicalLedger, CanonicalItem } from "../../types/canonical";

// ─── Types ──────────────────────────────────────────────────────────

export interface MonthlyTaxData {
  month: string;
  label: string;
  gstCollected: number;      // Output tax from Sales
  gstPaid: number;            // Input tax from Purchases
  netLiability: number;       // Collected - Paid
  taxableRevenue: number;
  nonTaxableRevenue: number;
  salesCount: number;
  purchaseCount: number;
}

export interface TaxAlert {
  type: "liability_spike" | "missing_gst" | "high_taxable" | "mismatch" | "info";
  title: string;
  description: string;
  severity: "info" | "warning" | "danger";
  month?: string;
}

export interface MissingGSTEntry {
  voucherId: string;
  voucherNumber: string;
  date: string;
  partyName: string;
  amount: number;
  voucherType: string;
}

export interface TaxCategoryBreakdown {
  rate: number;
  taxableValue: number;
  taxAmount: number;
  invoiceCount: number;
}

export interface TaxRadarResult {
  monthlyData: MonthlyTaxData[];
  alerts: TaxAlert[];
  missingGSTEntries: MissingGSTEntry[];
  taxCategories: TaxCategoryBreakdown[];
  summary: {
    totalGSTCollected: number;
    totalGSTPaid: number;
    netGSTLiability: number;
    totalTaxableRevenue: number;
    totalNonTaxableRevenue: number;
    taxableRatio: number;     // % of revenue that is taxable
    missingEntryCount: number;
    highExposureMonth: string;
    highExposureAmount: number;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  return `${MONTHS[parseInt(m!, 10) - 1]} ${y!.slice(2)}`;
}

function isTaxLedger(group: string): boolean {
  const g = group.toLowerCase();
  return g.includes("duties") || g.includes("taxes") || g.includes("tax") ||
         g.includes("gst") || g.includes("sgst") || g.includes("cgst") || g.includes("igst") ||
         g.includes("tds") || g.includes("tcs");
}

// ─── Main Computation ──────────────────────────────────────────────

export function computeTaxRadar(
  vouchers: CanonicalVoucher[],
  items: Map<string, CanonicalItem>,
  ledgers: Map<string, CanonicalLedger>,
  /**
   * Optional per-item user GST overrides. If a row in this map exists for an
   * itemId, that pct wins over `item.gstRate`. Lets PriceList edits feed
   * straight into the tax-rate categorization without round-tripping through
   * the Tally master.
   */
  gstOverrides?: Record<string, { gstPct: number }>,
): TaxRadarResult {
  const monthlyMap = new Map<string, {
    gstCollected: number;
    gstPaid: number;
    taxableRevenue: number;
    nonTaxableRevenue: number;
    salesCount: number;
    purchaseCount: number;
  }>();

  const missingGSTEntries: MissingGSTEntry[] = [];
  const taxRateMap = new Map<number, { taxableValue: number; taxAmount: number; count: number }>();

  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;
    const ym = v.date.slice(0, 7);
    let md = monthlyMap.get(ym);
    if (!md) {
      md = { gstCollected: 0, gstPaid: 0, taxableRevenue: 0, nonTaxableRevenue: 0, salesCount: 0, purchaseCount: 0 };
      monthlyMap.set(ym, md);
    }

    if (v.voucherType === "Sales" || v.voucherType === "Purchase" ||
        v.voucherType === "Credit Note" || v.voucherType === "Debit Note") {
      // Credit Note = sales return (reduces GST collected), Debit Note = purchase return (reduces GST paid)
      const isSalesSide = v.voucherType === "Sales" || v.voucherType === "Credit Note";
      const isReturn = v.voucherType === "Credit Note" || v.voucherType === "Debit Note";
      const sign = isReturn ? -1 : 1;
      if (isSalesSide) md.salesCount++; else md.purchaseCount++;

      // Check for tax lines in the voucher
      let hasTaxLine = false;
      let totalTaxAmount = 0;
      let totalLineAmount = 0;

      for (const line of v.lines) {
        if (line.type === "ledger" && line.ledgerId) {
          const ledger = ledgers.get(line.ledgerId);
          if (ledger && isTaxLedger(ledger.group)) {
            hasTaxLine = true;
            totalTaxAmount += line.amount ?? 0;
          }
        }
        if (line.type === "inventory") {
          totalLineAmount += Math.abs(line.lineAmount ?? 0);

          // Track tax categories by item GST rate
          if (line.itemId) {
            const item = items.get(line.itemId);
            const override = gstOverrides?.[line.itemId]?.gstPct;
            const rate = override ?? item?.gstRate ?? 18;
            const lineAmt = Math.abs(line.lineAmount ?? 0);
            const taxAmt = lineAmt * rate / 100;
            let tr = taxRateMap.get(rate);
            if (!tr) { tr = { taxableValue: 0, taxAmount: 0, count: 0 }; taxRateMap.set(rate, tr); }
            tr.taxableValue += lineAmt * sign;
            tr.taxAmount += taxAmt * sign;
            tr.count++;
          }
        }
      }

      // Accumulate tax (returns subtract)
      if (isSalesSide) {
        md.gstCollected += totalTaxAmount * sign;
        if (totalLineAmount > 0) {
          if (hasTaxLine) md.taxableRevenue += totalLineAmount * sign;
          else md.nonTaxableRevenue += totalLineAmount * sign;
        }
      } else {
        md.gstPaid += totalTaxAmount * sign;
      }

      // Flag missing GST entries (Sales/Purchase/DN/CN > ₹10k without tax lines)
      if (!hasTaxLine && totalLineAmount > 10000) {
        missingGSTEntries.push({
          voucherId: v.voucherId,
          voucherNumber: v.voucherNumber,
          date: v.date,
          partyName: v.partyName ?? "Unknown",
          amount: totalLineAmount,
          voucherType: v.voucherType,
        });
      }
    }
  }

  // Build monthly data
  const monthlyData: MonthlyTaxData[] = Array.from(monthlyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, md]) => ({
      month,
      label: monthLabel(month),
      gstCollected: md.gstCollected,
      gstPaid: md.gstPaid,
      netLiability: md.gstCollected - md.gstPaid,
      taxableRevenue: md.taxableRevenue,
      nonTaxableRevenue: md.nonTaxableRevenue,
      salesCount: md.salesCount,
      purchaseCount: md.purchaseCount,
    }));

  // Tax category breakdown
  const taxCategories: TaxCategoryBreakdown[] = Array.from(taxRateMap.entries())
    .map(([rate, data]) => ({
      rate,
      taxableValue: data.taxableValue,
      taxAmount: data.taxAmount,
      invoiceCount: data.count,
    }))
    .sort((a, b) => b.taxableValue - a.taxableValue);

  // Summary
  const totalGSTCollected = monthlyData.reduce((s, m) => s + m.gstCollected, 0);
  const totalGSTPaid = monthlyData.reduce((s, m) => s + m.gstPaid, 0);
  const totalTaxableRevenue = monthlyData.reduce((s, m) => s + m.taxableRevenue, 0);
  const totalNonTaxableRevenue = monthlyData.reduce((s, m) => s + m.nonTaxableRevenue, 0);
  const totalRevenue = totalTaxableRevenue + totalNonTaxableRevenue;

  // Find highest liability month
  let highExposureMonth = "";
  let highExposureAmount = 0;
  for (const m of monthlyData) {
    if (m.netLiability > highExposureAmount) {
      highExposureMonth = m.label;
      highExposureAmount = m.netLiability;
    }
  }

  // Generate alerts
  const alerts = generateTaxAlerts(monthlyData, missingGSTEntries, totalGSTCollected, totalGSTPaid, totalTaxableRevenue, totalRevenue);

  return {
    monthlyData,
    alerts,
    missingGSTEntries: missingGSTEntries.sort((a, b) => b.amount - a.amount).slice(0, 50),
    taxCategories,
    summary: {
      totalGSTCollected,
      totalGSTPaid,
      netGSTLiability: totalGSTCollected - totalGSTPaid,
      totalTaxableRevenue,
      totalNonTaxableRevenue,
      taxableRatio: totalRevenue > 0 ? (totalTaxableRevenue / totalRevenue) * 100 : 0,
      missingEntryCount: missingGSTEntries.length,
      highExposureMonth,
      highExposureAmount,
    },
  };
}

// ─── Alerts ─────────────────────────────────────────────────────────

function generateTaxAlerts(
  monthly: MonthlyTaxData[],
  missingEntries: MissingGSTEntry[],
  totalCollected: number,
  totalPaid: number,
  taxableRevenue: number,
  totalRevenue: number,
): TaxAlert[] {
  const alerts: TaxAlert[] = [];

  // GST liability spike (any month > 2x average)
  if (monthly.length >= 3) {
    const avgLiability = monthly.reduce((s, m) => s + m.netLiability, 0) / monthly.length;
    for (const m of monthly.slice(-3)) {
      if (m.netLiability > avgLiability * 2 && m.netLiability > 50000) {
        alerts.push({
          type: "liability_spike",
          title: "GST Liability Spike",
          description: `${m.label}: ₹${(m.netLiability / 100000).toFixed(1)}L liability (${(m.netLiability / avgLiability).toFixed(1)}x average)`,
          severity: "warning",
          month: m.month,
        });
      }
    }
  }

  // Missing GST entries
  if (missingEntries.length > 0) {
    const totalMissing = missingEntries.reduce((s, e) => s + e.amount, 0);
    alerts.push({
      type: "missing_gst",
      title: "Possible Missing GST Entries",
      description: `${missingEntries.length} transaction(s) worth ₹${(totalMissing / 100000).toFixed(1)}L may be missing GST entries`,
      severity: missingEntries.length > 10 ? "danger" : "warning",
    });
  }

  // High taxable ratio
  if (totalRevenue > 0 && taxableRevenue / totalRevenue > 0.9) {
    alerts.push({
      type: "high_taxable",
      title: "High Taxable Revenue",
      description: `${((taxableRevenue / totalRevenue) * 100).toFixed(0)}% of revenue is taxable — ensure all exemptions are applied`,
      severity: "info",
    });
  }

  // Net liability vs net credit
  const netLiability = totalCollected - totalPaid;
  if (netLiability > 0) {
    alerts.push({
      type: "info",
      title: "GST Payable",
      description: `Net GST payable: ₹${(netLiability / 100000).toFixed(1)}L (collected ₹${(totalCollected / 100000).toFixed(1)}L - paid ₹${(totalPaid / 100000).toFixed(1)}L)`,
      severity: "info",
    });
  } else if (netLiability < 0) {
    alerts.push({
      type: "info",
      title: "GST Credit Available",
      description: `Input tax credit: ₹${(Math.abs(netLiability) / 100000).toFixed(1)}L available for offset`,
      severity: "info",
    });
  }

  return alerts;
}
