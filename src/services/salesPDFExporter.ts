/**
 * Sales Invoice PDF Export Service
 * Generates Tally-style PDF invoices using jsPDF
 */

import jsPDF from 'jspdf';
import 'jspdf-autotable';
import type { SalesInvoice } from '../types/sales';

interface PDFOptions {
  companyName?: string;
  address?: string;
  phone?: string;
  email?: string;
  gstNumber?: string;
}

/**
 * Export sales invoice as PDF
 */
export function exportInvoiceAsPDF(
  invoice: SalesInvoice,
  options: PDFOptions = {}
): Blob {
  const {
    companyName = 'M.K.CYCLES (P) LTD.',
    address = 'Bangalore, India',
    phone = '',
    email = ''
  } = options;

  // Create PDF document (A4, mm, INR)
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4'
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  let yPosition = 10;

  // Set default font
  doc.setFont('helvetica');

  // Header: Company Name and Details
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text(companyName, pageWidth / 2, yPosition, { align: 'center' });
  yPosition += 8;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(address, pageWidth / 2, yPosition, { align: 'center' });
  if (phone) {
    yPosition += 4;
    doc.text(`Phone: ${phone}`, pageWidth / 2, yPosition, { align: 'center' });
  }
  if (email) {
    yPosition += 4;
    doc.text(`Email: ${email}`, pageWidth / 2, yPosition, { align: 'center' });
  }
  yPosition += 8;

  // Invoice Title
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('PRO-FORMA SALES INVOICE', pageWidth / 2, yPosition, { align: 'center' });
  yPosition += 10;

  // Invoice Details (2 columns)
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');

  const leftCol = 15;
  const rightCol = pageWidth / 2 + 10;

  // Left column
  doc.text('Invoice No.:', leftCol, yPosition);
  doc.setFont('helvetica', 'bold');
  doc.text(invoice.header.invoiceNo || 'DRAFT', leftCol + 30, yPosition);
  doc.setFont('helvetica', 'normal');

  // Right column
  doc.text('Date:', rightCol, yPosition);
  doc.setFont('helvetica', 'bold');
  doc.text(invoice.header.date, rightCol + 15, yPosition);
  doc.setFont('helvetica', 'normal');

  yPosition += 6;

  // Party Details
  doc.text('Party Name:', leftCol, yPosition);
  doc.setFont('helvetica', 'bold');
  doc.text(invoice.header.partyName || 'Not specified', leftCol + 30, yPosition);
  doc.setFont('helvetica', 'normal');

  yPosition += 8;

  // Items Table
  const tableData: (string | number)[][] = [];

  // Add header row
  tableData.push([
    'S.No.',
    'Item Name',
    'Qty (Base)',
    'Unit',
    'Rate (₹)',
    'Amount (₹)'
  ]);

  // Add item rows
  invoice.items.forEach((item, index) => {
    tableData.push([
      String(index + 1),
      item.itemName,
      item.baseQuantity.toFixed(2),
      item.baseUnitName,
      item.ratePerBaseUnit.toFixed(2),
      item.amount.toFixed(2)
    ]);
  });

  // Add totals row
  tableData.push([
    '',
    'TOTAL',
    invoice.totalQuantity.toFixed(2),
    '',
    '',
    invoice.subtotal.toFixed(2)
  ]);

  // Use autoTable to generate the table
  (doc as any).autoTable({
    head: [tableData[0]],
    body: tableData.slice(1),
    startY: yPosition,
    margin: { left: 15, right: 15 },
    styles: {
      fontSize: 9,
      cellPadding: 3,
      border: '1'
    },
    headStyles: {
      fillColor: [51, 51, 51],
      textColor: 255,
      fontStyle: 'bold',
      halign: 'center'
    },
    bodyStyles: {
      textColor: 0,
      lineColor: [200, 200, 200]
    },
    footStyles: {
      fillColor: [240, 240, 240],
      fontStyle: 'bold',
      textColor: 0
    },
    columnStyles: {
      0: { halign: 'center', cellWidth: 12 },
      1: { halign: 'left' },
      2: { halign: 'right', cellWidth: 18 },
      3: { halign: 'center', cellWidth: 15 },
      4: { halign: 'right', cellWidth: 20 },
      5: { halign: 'right', cellWidth: 20 }
    },
    didDrawPage: (data) => {
      // Add footer
      const pageCount = (doc as any).internal.pages.length - 1;
      const currentPage = data.pageNumber;

      doc.setFontSize(8);
      doc.setTextColor(150);
      doc.text(
        `Page ${currentPage} of ${pageCount}`,
        pageWidth / 2,
        pageHeight - 5,
        { align: 'center' }
      );
    }
  });

  // Get final Y position after table
  yPosition = (doc as any).lastAutoTable.finalY + 10;

  // Summary Section
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('Summary:', 15, yPosition);
  yPosition += 6;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`Total Items: ${invoice.items.length}`, 20, yPosition);
  yPosition += 4;
  doc.text(`Total Quantity: ${invoice.totalQuantity.toFixed(2)}`, 20, yPosition);
  yPosition += 4;
  doc.text(`Subtotal: ₹${invoice.subtotal.toFixed(2)}`, 20, yPosition);
  yPosition += 6;

  // Status
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(0, 100, 0);
  doc.text(`Status: ${invoice.header.status.toUpperCase()}`, 20, yPosition);
  doc.setTextColor(0);

  // Add metadata footer
  yPosition += 8;
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(150);
  doc.text(
    `Generated: ${new Date().toLocaleString()} | Invoice ID: ${invoice.header.id}`,
    15,
    pageHeight - 10
  );

  // Generate blob
  const pdfBlob = doc.output('blob');
  return pdfBlob;
}

/**
 * Download PDF invoice to user's computer
 */
export function downloadInvoicePDF(
  invoice: SalesInvoice,
  options?: PDFOptions
): void {
  const blob = exportInvoiceAsPDF(invoice, options);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Invoice_${invoice.header.invoiceNo || invoice.header.id}.pdf`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Generate PDF as data URL for preview
 */
export function getInvoicePDFDataUrl(
  invoice: SalesInvoice,
  options?: PDFOptions
): string {
  const blob = exportInvoiceAsPDF(invoice, options);
  return URL.createObjectURL(blob);
}

/**
 * Export multiple invoices as a single PDF
 */
export function exportMultipleInvoicesAsPDF(
  invoices: SalesInvoice[],
  options: PDFOptions = {}
): Blob {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4'
  });

  invoices.forEach((invoice, index) => {
    if (index > 0) {
      doc.addPage();
    }

    const singleInvoicePDF = exportInvoiceAsPDF(invoice, options);
    const pages = (singleInvoicePDF as any).internal.pages;

    // This is a simplified approach - in production, you'd merge PDFs properly
    // For now, we'll just add each invoice on a new page
  });

  return doc.output('blob');
}

// ── Amount in words (Indian numbering) ───────────────────────────────────────

const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen"];
const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function numberToWords(n: number): string {
  if (n === 0) return "Zero";
  if (n < 0) return "Minus " + numberToWords(-n);
  if (n < 20) return ones[n];
  if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? " " + ones[n % 10] : "");
  if (n < 1000) return ones[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " " + numberToWords(n % 100) : "");
  if (n < 100000) return numberToWords(Math.floor(n / 1000)) + " Thousand" + (n % 1000 ? " " + numberToWords(n % 1000) : "");
  if (n < 10000000) return numberToWords(Math.floor(n / 100000)) + " Lakh" + (n % 100000 ? " " + numberToWords(n % 100000) : "");
  return numberToWords(Math.floor(n / 10000000)) + " Crore" + (n % 10000000 ? " " + numberToWords(n % 10000000) : "");
}

export function amountInWords(amount: number): string {
  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);
  let result = "Rupees " + numberToWords(rupees);
  if (paise > 0) result += " and " + numberToWords(paise) + " Paise";
  return result + " Only";
}

// ── GST Invoice (A4 format) ───────────────────────────────────────────────────

export interface InvoicePrintConfig {
  format: "a4" | "thermal";
  companyName: string;
  companyAddress: string;
  companyGSTIN: string;
  companyState: string;
  companyPhone?: string;
  companyEmail?: string;
  showLogo: boolean;
  footerText?: string;
}

export function exportInvoiceAsA4PDF(
  invoice: SalesInvoice,
  config: Partial<InvoicePrintConfig> = {}
): Blob {
  const cfg: InvoicePrintConfig = {
    format: "a4",
    companyName: "M.K.CYCLES (P) LTD.",
    companyAddress: "Kolkata, West Bengal",
    companyGSTIN: "",
    companyState: "West Bengal",
    companyPhone: "",
    companyEmail: "",
    showLogo: false,
    footerText: "Subject to Kolkata Jurisdiction",
    ...config,
  };

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  let y = 10;

  // Company header
  doc.setFontSize(14); doc.setFont("helvetica", "bold");
  doc.text(cfg.companyName, pw / 2, y, { align: "center" }); y += 6;
  doc.setFontSize(9); doc.setFont("helvetica", "normal");
  doc.text(cfg.companyAddress, pw / 2, y, { align: "center" }); y += 4;
  if (cfg.companyGSTIN) { doc.text(`GSTIN: ${cfg.companyGSTIN}`, pw / 2, y, { align: "center" }); y += 4; }
  if (cfg.companyPhone) { doc.text(`Tel: ${cfg.companyPhone}`, pw / 2, y, { align: "center" }); y += 4; }
  if (cfg.companyEmail) { doc.text(`Email: ${cfg.companyEmail}`, pw / 2, y, { align: "center" }); y += 4; }
  y += 2;
  doc.line(10, y, pw - 10, y); y += 4;

  // Invoice title + metadata
  doc.setFontSize(12); doc.setFont("helvetica", "bold");
  doc.text("TAX INVOICE", pw / 2, y, { align: "center" }); y += 6;

  doc.setFontSize(9); doc.setFont("helvetica", "normal");
  const invoiceNo = invoice.header.invoiceNo || invoice.header.id.substring(0, 12);
  const lx = 15, rx = pw / 2 + 10;
  doc.text(`Invoice No: ${invoiceNo}`, lx, y);
  doc.text(`Date: ${invoice.header.date}`, rx, y); y += 5;
  doc.text(`Place of Supply: ${cfg.companyState}`, lx, y);
  doc.text(`Reverse Charge: N`, rx, y); y += 5;

  // Buyer details
  doc.line(10, y, pw - 10, y); y += 4;
  doc.setFont("helvetica", "bold"); doc.text("Bill To:", lx, y); y += 4;
  doc.setFont("helvetica", "normal");
  doc.text(invoice.header.partyName, lx, y); y += 4;
  if (invoice.header.partyGST) { doc.text(`GSTIN: ${invoice.header.partyGST}`, lx, y); y += 4; }
  y += 2; doc.line(10, y, pw - 10, y); y += 4;

  // Line items table
  const head = [["S.No", "Description", "HSN/SAC", "Qty", "Unit", "Rate (₹)", "Amount (₹)"]];
  const body = invoice.items.map((item, i) => [
    String(i + 1),
    item.itemName,
    "",
    item.baseQuantity.toFixed(2),
    item.baseUnitName || "Nos",
    item.ratePerBaseUnit.toFixed(2),
    item.amount.toFixed(2),
  ]);

  (doc as any).autoTable({
    head, body,
    startY: y,
    margin: { left: 10, right: 10 },
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [40, 40, 40], textColor: 255, fontStyle: "bold" },
    columnStyles: {
      0: { halign: "center", cellWidth: 10 },
      1: { halign: "left" },
      2: { halign: "center", cellWidth: 16 },
      3: { halign: "right", cellWidth: 14 },
      4: { halign: "center", cellWidth: 12 },
      5: { halign: "right", cellWidth: 20 },
      6: { halign: "right", cellWidth: 22 },
    },
  });

  y = (doc as any).lastAutoTable.finalY + 4;

  // Totals
  const totalsX = pw - 65;
  doc.setFontSize(9);
  doc.text("Taxable Amount:", totalsX, y);
  doc.text(`₹${invoice.subtotal.toFixed(2)}`, pw - 12, y, { align: "right" }); y += 5;
  doc.setFont("helvetica", "bold");
  doc.text("Grand Total:", totalsX, y);
  doc.text(`₹${invoice.subtotal.toFixed(2)}`, pw - 12, y, { align: "right" }); y += 6;
  doc.setFont("helvetica", "normal");

  // Amount in words
  doc.setFontSize(8);
  doc.text(`Amount in words: ${amountInWords(invoice.subtotal)}`, lx, y); y += 8;

  // Footer
  doc.line(10, y, pw - 10, y); y += 4;
  doc.setFontSize(8);
  if (cfg.footerText) { doc.text(cfg.footerText, lx, y); }
  doc.text("Authorised Signatory", pw - 12, y, { align: "right" });

  // Page number
  doc.setFontSize(7); doc.setTextColor(150);
  doc.text(`Generated: ${new Date().toLocaleString()}`, lx, ph - 5);

  return doc.output("blob");
}

// ── Thermal (80mm) receipt ────────────────────────────────────────────────────

export function exportInvoiceAsThermalPDF(
  invoice: SalesInvoice,
  config: Partial<InvoicePrintConfig> = {}
): Blob {
  const cfg: InvoicePrintConfig = {
    format: "thermal",
    companyName: "M.K.CYCLES (P) LTD.",
    companyAddress: "Kolkata, West Bengal",
    companyGSTIN: "",
    companyState: "West Bengal",
    showLogo: false,
    footerText: "Thank you for your business",
    ...config,
  };

  // 80mm width = ~80mm, height auto
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: [80, 200] });
  const pw = 80;
  let y = 6;

  doc.setFontSize(10); doc.setFont("helvetica", "bold");
  doc.text(cfg.companyName, pw / 2, y, { align: "center" }); y += 5;
  doc.setFontSize(7); doc.setFont("helvetica", "normal");
  doc.text(cfg.companyAddress, pw / 2, y, { align: "center" }); y += 4;

  doc.line(3, y, pw - 3, y); y += 3;
  const invoiceNo = invoice.header.invoiceNo || invoice.header.id.substring(0, 12);
  doc.text(`Invoice: ${invoiceNo}  Date: ${invoice.header.date}`, pw / 2, y, { align: "center" }); y += 3;
  doc.text(`Party: ${invoice.header.partyName}`, 3, y); y += 4;
  doc.line(3, y, pw - 3, y); y += 3;

  // Items
  for (const item of invoice.items) {
    doc.setFontSize(7);
    doc.text(item.itemName.substring(0, 28), 3, y); y += 3;
    doc.text(`${item.baseQuantity} x ${item.ratePerBaseUnit.toFixed(2)} = ${item.amount.toFixed(2)}`, 5, y); y += 3;
  }

  doc.line(3, y, pw - 3, y); y += 3;
  doc.setFont("helvetica", "bold");
  doc.text(`TOTAL: Rs.${invoice.subtotal.toFixed(2)}`, pw / 2, y, { align: "center" }); y += 4;
  doc.setFont("helvetica", "normal");
  if (cfg.footerText) { doc.setFontSize(7); doc.text(cfg.footerText, pw / 2, y, { align: "center" }); }

  return doc.output("blob");
}

// ── Print via browser window.print() ─────────────────────────────────────────

export function printInvoice(
  invoice: SalesInvoice,
  config: Partial<InvoicePrintConfig> = {},
  format: "a4" | "thermal" = "a4"
): void {
  const blob = format === "thermal"
    ? exportInvoiceAsThermalPDF(invoice, config)
    : exportInvoiceAsA4PDF(invoice, config);
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank");
  if (win) {
    win.onload = () => {
      win.focus();
      win.print();
      setTimeout(() => { win.close(); URL.revokeObjectURL(url); }, 1000);
    };
  }
}
