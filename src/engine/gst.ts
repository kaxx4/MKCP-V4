import type { CanonicalVoucher, CanonicalItem, CanonicalLedger } from "../types/canonical";

export interface HSNSummary {
  hsn: string;
  description: string;
  uqc: string;
  totalQty: number;
  taxableValue: number;
  igstRate: number;
  cgstRate: number;
  sgstRate: number;
  igstAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  totalTax: number;
  invoiceCount: number;
}

export interface GSTR1Summary {
  period: string;
  b2b: Array<{
    gstin: string;
    partyName: string;
    invoiceCount: number;
    taxableValue: number;
    totalTax: number;
    invoices: Array<{
      invoiceNumber: string;
      date: string;
      taxableValue: number;
      igst: number;
      cgst: number;
      sgst: number;
    }>;
  }>;
  b2cTaxableValue: number;
  b2cTax: number;
  b2cCount: number;
  hsnSummary: HSNSummary[];
  totalTaxableValue: number;
  totalIGST: number;
  totalCGST: number;
  totalSGST: number;
  totalTax: number;
  totalInvoices: number;
}

export interface GSTR3BSummary {
  period: string;
  outwardTaxable: number;
  outwardIGST: number;
  outwardCGST: number;
  outwardSGST: number;
  inwardTaxable: number;
  inwardIGST: number;
  inwardCGST: number;
  inwardSGST: number;
  netIGST: number;
  netCGST: number;
  netSGST: number;
  netPayable: number;
}

function isInterState(partyGstin: string, companyGstin: string): boolean {
  if (!partyGstin || !companyGstin) return false;
  return partyGstin.slice(0, 2) !== companyGstin.slice(0, 2);
}

export function computeGSTR1(
  vouchers: CanonicalVoucher[],
  items: Map<string, CanonicalItem>,
  ledgers: Map<string, CanonicalLedger>,
  month: string,
  companyGstin?: string
): GSTR1Summary {
  const b2bMap = new Map<string, {
    gstin: string;
    partyName: string;
    invoices: Array<{ invoiceNumber: string; date: string; taxableValue: number; igst: number; cgst: number; sgst: number }>;
  }>();
  let b2cTaxableValue = 0;
  let b2cTax = 0;
  let b2cCount = 0;
  const hsnMap = new Map<string, HSNSummary>();
  let totalTaxableValue = 0;
  let totalIGST = 0;
  let totalCGST = 0;
  let totalSGST = 0;
  let totalInvoices = 0;

  for (const v of vouchers) {
    if (v.voucherType !== "Sales" || v.isCancelled || v.isOptional) continue;
    if (v.date.slice(0, 7) !== month) continue;

    totalInvoices++;
    const partyLedger = v.partyLedgerId ? ledgers.get(v.partyLedgerId) : null;
    const partyGstin = partyLedger?.gstin ?? "";
    const interState = companyGstin ? isInterState(partyGstin, companyGstin) : false;

    let invoiceTaxable = 0;
    let invoiceIgst = 0;
    let invoiceCgst = 0;
    let invoiceSgst = 0;

    for (const line of v.lines) {
      if (line.type !== "inventory" || !line.itemId) continue;
      const item = items.get(line.itemId);
      const taxableValue = line.lineAmount ?? 0;
      const gstRate = item?.gstRate ?? 18;
      const taxAmount = taxableValue * (gstRate / 100);

      invoiceTaxable += taxableValue;

      if (interState) {
        invoiceIgst += taxAmount;
      } else {
        invoiceCgst += taxAmount / 2;
        invoiceSgst += taxAmount / 2;
      }

      // HSN accumulation
      const hsn = item?.hsn ?? "0000";
      let hsnEntry = hsnMap.get(hsn);
      if (!hsnEntry) {
        hsnEntry = {
          hsn,
          description: item?.name ?? "Unknown",
          uqc: item?.baseUnit ?? "PCS",
          totalQty: 0,
          taxableValue: 0,
          igstRate: interState ? gstRate : 0,
          cgstRate: interState ? 0 : gstRate / 2,
          sgstRate: interState ? 0 : gstRate / 2,
          igstAmount: 0,
          cgstAmount: 0,
          sgstAmount: 0,
          totalTax: 0,
          invoiceCount: 0,
        };
        hsnMap.set(hsn, hsnEntry);
      }
      hsnEntry.totalQty += line.qtyBase ?? 0;
      hsnEntry.taxableValue += taxableValue;
      if (interState) {
        hsnEntry.igstAmount += taxAmount;
        hsnEntry.igstRate = gstRate;
      } else {
        hsnEntry.cgstAmount += taxAmount / 2;
        hsnEntry.sgstAmount += taxAmount / 2;
        hsnEntry.cgstRate = gstRate / 2;
        hsnEntry.sgstRate = gstRate / 2;
      }
      hsnEntry.totalTax += taxAmount;
    }

    totalTaxableValue += invoiceTaxable;
    totalIGST += invoiceIgst;
    totalCGST += invoiceCgst;
    totalSGST += invoiceSgst;

    if (partyGstin) {
      // B2B
      let entry = b2bMap.get(partyGstin);
      if (!entry) {
        entry = { gstin: partyGstin, partyName: partyLedger?.name ?? v.partyName ?? "Unknown", invoices: [] };
        b2bMap.set(partyGstin, entry);
      }
      entry.invoices.push({
        invoiceNumber: v.voucherNumber,
        date: v.date,
        taxableValue: invoiceTaxable,
        igst: invoiceIgst,
        cgst: invoiceCgst,
        sgst: invoiceSgst,
      });
    } else {
      // B2C
      b2cTaxableValue += invoiceTaxable;
      b2cTax += invoiceIgst + invoiceCgst + invoiceSgst;
      b2cCount++;
    }
  }

  // Update HSN invoice counts
  for (const v of vouchers) {
    if (v.voucherType !== "Sales" || v.isCancelled || v.isOptional) continue;
    if (v.date.slice(0, 7) !== month) continue;
    const hsnsSeen = new Set<string>();
    for (const line of v.lines) {
      if (line.type !== "inventory" || !line.itemId) continue;
      const item = items.get(line.itemId);
      const hsn = item?.hsn ?? "0000";
      if (!hsnsSeen.has(hsn)) {
        hsnsSeen.add(hsn);
        const entry = hsnMap.get(hsn);
        if (entry) entry.invoiceCount++;
      }
    }
  }

  const b2b = Array.from(b2bMap.values()).map(entry => ({
    ...entry,
    invoiceCount: entry.invoices.length,
    taxableValue: entry.invoices.reduce((s, i) => s + i.taxableValue, 0),
    totalTax: entry.invoices.reduce((s, i) => s + i.igst + i.cgst + i.sgst, 0),
  }));

  return {
    period: month,
    b2b,
    b2cTaxableValue,
    b2cTax,
    b2cCount,
    hsnSummary: Array.from(hsnMap.values()),
    totalTaxableValue,
    totalIGST,
    totalCGST,
    totalSGST,
    totalTax: totalIGST + totalCGST + totalSGST,
    totalInvoices,
  };
}

export function computeGSTR3B(
  vouchers: CanonicalVoucher[],
  items: Map<string, CanonicalItem>,
  ledgers: Map<string, CanonicalLedger>,
  month: string,
  companyGstin?: string
): GSTR3BSummary {
  let outwardTaxable = 0, outwardIGST = 0, outwardCGST = 0, outwardSGST = 0;
  let inwardTaxable = 0, inwardIGST = 0, inwardCGST = 0, inwardSGST = 0;

  for (const v of vouchers) {
    if (v.isCancelled || v.isOptional) continue;
    if (v.date.slice(0, 7) !== month) continue;
    if (v.voucherType !== "Sales" && v.voucherType !== "Purchase") continue;

    const partyLedger = v.partyLedgerId ? ledgers.get(v.partyLedgerId) : null;
    const partyGstin = partyLedger?.gstin ?? "";
    const interState = companyGstin ? isInterState(partyGstin, companyGstin) : false;

    for (const line of v.lines) {
      if (line.type !== "inventory" || !line.itemId) continue;
      const item = items.get(line.itemId);
      const taxableValue = line.lineAmount ?? 0;
      const gstRate = item?.gstRate ?? 18;
      const taxAmount = taxableValue * (gstRate / 100);

      if (v.voucherType === "Sales") {
        outwardTaxable += taxableValue;
        if (interState) outwardIGST += taxAmount;
        else { outwardCGST += taxAmount / 2; outwardSGST += taxAmount / 2; }
      } else {
        inwardTaxable += taxableValue;
        if (interState) inwardIGST += taxAmount;
        else { inwardCGST += taxAmount / 2; inwardSGST += taxAmount / 2; }
      }
    }
  }

  return {
    period: month,
    outwardTaxable,
    outwardIGST,
    outwardCGST,
    outwardSGST,
    inwardTaxable,
    inwardIGST,
    inwardCGST,
    inwardSGST,
    netIGST: outwardIGST - inwardIGST,
    netCGST: outwardCGST - inwardCGST,
    netSGST: outwardSGST - inwardSGST,
    netPayable: (outwardIGST - inwardIGST) + (outwardCGST - inwardCGST) + (outwardSGST - inwardSGST),
  };
}
