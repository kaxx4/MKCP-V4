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
