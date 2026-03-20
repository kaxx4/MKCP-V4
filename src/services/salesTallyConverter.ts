/**
 * Sales Invoice to Tally XML Converter
 * Converts SalesInvoice JSON to Tally-compatible XML format
 */

import type { SalesInvoice } from '../types/sales';

interface TallyVoucher {
  xmlVersion: string;
  voucherType: string;
  date: string;
  referenceNumber: string;
  partyName: string;
  partyLedgerName: string;
  narration: string;
  lines: TallyLine[];
  totalAmount: number;
}

interface TallyLine {
  itemName: string;
  quantity: number;
  baseQuantity: number;
  unit: string;
  rate: number;
  amount: number;
  accountingName?: string;
}

/**
 * Convert SalesInvoice to Tally-compatible XML format
 * Returns XML string suitable for Tally import via localhost:3100
 */
export function convertInvoiceToTallyXML(invoice: SalesInvoice): string {
  const voucher: TallyVoucher = {
    xmlVersion: '1.0',
    voucherType: 'Sales',
    date: invoice.header.date,
    referenceNumber: invoice.header.invoiceNo || invoice.header.id.substring(0, 12),
    partyName: invoice.header.partyName,
    partyLedgerName: invoice.header.partyName,
    narration: `Pro-forma sales invoice created from dashboard - ID: ${invoice.header.id}`,
    lines: invoice.items.map(item => ({
      itemName: item.itemName,
      quantity: item.baseQuantity,
      baseQuantity: item.baseQuantity,
      unit: item.baseUnitName,
      rate: item.ratePerBaseUnit,
      amount: item.amount,
      accountingName: 'Sales'
    })),
    totalAmount: invoice.subtotal
  };

  return buildTallyXML(voucher);
}

/**
 * Build Tally XML structure from voucher object
 */
function buildTallyXML(voucher: TallyVoucher): string {
  const lines = voucher.lines
    .map(
      (line, index) => `
    <LINEITEM.LIST>
      <LINEITEMNO>${index + 1}</LINEITEMNO>
      <ITEMNAME>${escapeXML(line.itemName)}</ITEMNAME>
      <ITEMDESC></ITEMDESC>
      <GSTUNITTYPE>UQC</GSTUNITTYPE>
      <QUANTITY>${line.quantity}</QUANTITY>
      <UNIT>${line.unit}</UNIT>
      <RATE>${line.rate}</RATE>
      <AMOUNT>${line.amount}</AMOUNT>
    </LINEITEM.LIST>`
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTLIST IMPORTTYPE="Voucher">
      <VOUCHER VOUCHERTYPE="Sales">
        <DATE>${voucher.date}</DATE>
        <REFERENCENUMBER>${escapeXML(voucher.referenceNumber)}</REFERENCENUMBER>
        <NARRATION>${escapeXML(voucher.narration)}</NARRATION>
        <LEDGER.LIST>
          <LEDGERNAME>${escapeXML(voucher.partyLedgerName)}</LEDGERNAME>
          <AMOUNT>${voucher.totalAmount}</AMOUNT>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
        </LEDGER.LIST>${lines}
      </VOUCHER>
    </IMPORTLIST>
  </BODY>
</ENVELOPE>`;
}

/**
 * Escape XML special characters
 */
function escapeXML(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Validate invoice before conversion
 */
export function validateInvoiceForTally(invoice: SalesInvoice): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Check required fields
  if (!invoice.header.partyName) {
    errors.push('Party name is required');
  }

  if (!invoice.header.date) {
    errors.push('Invoice date is required');
  }

  if (invoice.items.length === 0) {
    errors.push('Invoice must contain at least one item');
  }

  // Check item details
  for (const item of invoice.items) {
    if (!item.itemName) {
      errors.push(`Item name is missing`);
    }
    if (item.baseQuantity <= 0) {
      errors.push(`Quantity for ${item.itemName} must be greater than 0`);
    }
    if (item.ratePerBaseUnit <= 0) {
      errors.push(`Rate for ${item.itemName} must be greater than 0`);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Push invoice to Tally via API endpoint
 * Expects a backend endpoint at /api/tally/import that forwards to Tally XML API
 */
export async function pushInvoiceToTally(
  invoice: SalesInvoice,
  apiEndpoint: string = '/api/tally/import'
): Promise<{
  success: boolean;
  message: string;
  tallyId?: string;
  error?: string;
}> {
  // Validate first
  const validation = validateInvoiceForTally(invoice);
  if (!validation.valid) {
    return {
      success: false,
      message: 'Invoice validation failed',
      error: validation.errors.join('; ')
    };
  }

  // Convert to XML
  const xml = convertInvoiceToTallyXML(invoice);

  try {
    // Send to backend API which will forward to Tally
    const response = await fetch(apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml'
      },
      body: xml
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        message: `Tally import failed with status ${response.status}`,
        error: errorText
      };
    }

    const responseText = await response.text();

    // Try to extract Tally response ID
    const idMatch = responseText.match(/<GUID>(.*?)<\/GUID>/);
    const tallyId = idMatch ? idMatch[1] : undefined;

    return {
      success: true,
      message: 'Invoice successfully pushed to Tally',
      tallyId
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to connect to Tally',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Generate Tally-compatible CSV for bulk import
 */
export function exportInvoiceAsCSV(invoices: SalesInvoice[]): string {
  let csv =
    'InvoiceNo,Date,PartyName,ItemName,Quantity,Unit,Rate,Amount,Total\n';

  for (const invoice of invoices) {
    const dateStr = invoice.header.date;
    const partyName = invoice.header.partyName;
    const invoiceNo = invoice.header.invoiceNo || invoice.header.id.substring(0, 12);

    for (const item of invoice.items) {
      csv += `"${invoiceNo}","${dateStr}","${partyName}","${item.itemName}",${item.baseQuantity},"${item.baseUnitName}",${item.ratePerBaseUnit},${item.amount},${invoice.subtotal}\n`;
    }
  }

  return csv;
}

/**
 * Prepare invoice batch for Tally import
 */
export function prepareBatchForTally(
  invoices: SalesInvoice[]
): {
  validInvoices: SalesInvoice[];
  invalidInvoices: Array<{ invoice: SalesInvoice; errors: string[] }>;
} {
  const validInvoices: SalesInvoice[] = [];
  const invalidInvoices: Array<{ invoice: SalesInvoice; errors: string[] }> = [];

  for (const invoice of invoices) {
    const validation = validateInvoiceForTally(invoice);
    if (validation.valid) {
      validInvoices.push(invoice);
    } else {
      invalidInvoices.push({
        invoice,
        errors: validation.errors
      });
    }
  }

  return { validInvoices, invalidInvoices };
}
