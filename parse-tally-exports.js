#!/usr/bin/env node

/**
 * Parse Tally XML Export Files
 * Extracts key metrics from the 7 reference files
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseXMLFile(filePath, encoding = 'utf-8') {
  try {
    const content = fs.readFileSync(filePath, encoding);
    return content;
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err.message);
    return null;
  }
}

function countVouchers(xmlContent) {
  // Count <VOUCHER tags (case-insensitive, with attributes)
  const matches = xmlContent.match(/<VOUCHER\s+[^>]*VCHTYPE\s*=\s*"([^"]+)"/gi) || [];

  // Group by type
  const byType = {};
  xmlContent.matchAll(/<VOUCHER\s+[^>]*VCHTYPE\s*=\s*"([^"]+)"/gi).forEach((match) => {
    const type = match[1].trim();
    byType[type] = (byType[type] || 0) + 1;
  });

  return {
    total: matches.length,
    byType,
  };
}

function extractFinancialMetrics(xmlContent, tagName) {
  // Extract numeric values between opening and closing tags
  const pattern = new RegExp(`<${tagName}[^>]*>\\s*([\\d.-]+)\\s*</${tagName}>`, 'gi');
  const values = [];
  let match;

  while ((match = pattern.exec(xmlContent)) !== null) {
    values.push(parseFloat(match[1]));
  }

  return values;
}

console.log(`\n${'═'.repeat(60)}`);
console.log('TALLY XML EXPORT ANALYSIS');
console.log(`${'═'.repeat(60)}\n`);

const exportDir = path.join(__dirname, 'TALLY TEST 193');

// 1. P&L Report
console.log('📊 PROFIT & LOSS REPORT (PandL.xml)');
console.log(`${'─'.repeat(60)}`);

const pandlPath = path.join(exportDir, 'PandL.xml');
const pandlXml = parseXMLFile(pandlPath, 'utf-16le');

if (pandlXml) {
  // Try to find numeric values in BSMAINAMT tags
  const salesMatch = pandlXml.match(/Sales\s*Accounts.*?<BSMAINAMT>([^<]+)<\/BSMAINAMT>/is);
  const costMatch = pandlXml.match(/Cost\s*of\s*Sales.*?<BSMAINAMT>([^<]+)<\/BSMAINAMT>/is);
  const closingStockMatch = pandlXml.match(/Closing\s*Stock.*?<PLSUBAMT>([^<]+)<\/PLSUBAMT>/is);

  console.log(`Sales: ${salesMatch ? salesMatch[1].trim() : 'N/A'}`);
  console.log(`Cost of Sales: ${costMatch ? costMatch[1].trim() : 'N/A'}`);
  console.log(`Closing Stock: ${closingStockMatch ? closingStockMatch[1].trim() : 'N/A'}`);
  console.log();
}

// 2. Balance Sheet
console.log('📊 BALANCE SHEET (BSheet.xml)');
console.log(`${'─'.repeat(60)}`);

const bsheetPath = path.join(exportDir, 'BSheet.xml');
const bsheetXml = parseXMLFile(bsheetPath, 'utf-16le');

if (bsheetXml) {
  const capitalMatch = bsheetXml.match(/Capital\s*Account.*?<BSMAINAMT>([^<]+)<\/BSMAINAMT>/is);
  const liabMatch = bsheetXml.match(/Current\s*Liabilities.*?<BSMAINAMT>([^<]+)<\/BSMAINAMT>/is);
  const pnlMatch = bsheetXml.match(/Profit\s*.*\s*Loss.*?<BSMAINAMT>([^<]+)<\/BSMAINAMT>/is);

  console.log(`Capital Account: ${capitalMatch ? capitalMatch[1].trim() : 'N/A'}`);
  console.log(`Current Liabilities: ${liabMatch ? liabMatch[1].trim() : 'N/A'}`);
  console.log(`Profit & Loss A/c: ${pnlMatch ? pnlMatch[1].trim() : 'N/A'}`);
  console.log();
}

// 3. Payments
console.log('💳 PAYMENTS (Payments.xml)');
console.log(`${'─'.repeat(60)}`);

const paymentsPath = path.join(exportDir, 'Payments.xml');
const paymentsXml = parseXMLFile(paymentsPath);

if (paymentsXml) {
  const paymentData = countVouchers(paymentsXml);
  console.log(`Total Payment Vouchers: ${paymentData.total}`);
  if (Object.keys(paymentData.byType).length > 0) {
    console.log('Breakdown:');
    Object.entries(paymentData.byType).forEach(([type, count]) => {
      console.log(`  - ${type}: ${count}`);
    });
  }
  console.log();
}

// 4. Receipts
console.log('💰 RECEIPTS (Receipts.xml)');
console.log(`${'─'.repeat(60)}`);

const receiptsPath = path.join(exportDir, 'Receipts.xml');
const receiptsXml = parseXMLFile(receiptsPath);

if (receiptsXml) {
  const receiptData = countVouchers(receiptsXml);
  console.log(`Total Receipt Vouchers: ${receiptData.total}`);
  if (Object.keys(receiptData.byType).length > 0) {
    console.log('Breakdown:');
    Object.entries(receiptData.byType).forEach(([type, count]) => {
      console.log(`  - ${type}: ${count}`);
    });
  }
  console.log();
}

// 5. Stock Summary
console.log('📦 STOCK SUMMARY (StkSum.xml)');
console.log(`${'─'.repeat(60)}`);

const stkSumPath = path.join(exportDir, 'StkSum.xml');
const stkSumXml = parseXMLFile(stkSumPath);

if (stkSumXml) {
  // Count stock items
  const itemCount = (stkSumXml.match(/<STOCKITEM[^>]*>/gi) || []).length;
  console.log(`Stock Items: ${itemCount}`);

  // Try to find opening and closing values
  const openingMatch = stkSumXml.match(/Opening\s*Value.*?<[^>]*>([\\d.,-]+)</is);
  const closingMatch = stkSumXml.match(/Closing\s*Value.*?<[^>]*>([\\d.,-]+)</is);

  if (openingMatch) console.log(`Opening Value: ${openingMatch[1]}`);
  if (closingMatch) console.log(`Closing Value: ${closingMatch[1]}`);
  console.log();
}

// 6. Income & Expense
console.log('💼 INDIRECT INCOME (IndInc.xml)');
console.log(`${'─'.repeat(60)}`);

const indIncPath = path.join(exportDir, 'IndInc.xml');
const indIncXml = parseXMLFile(indIncPath);

if (indIncXml) {
  const incomeCount = (indIncXml.match(/<LEDGER[^>]*>/gi) || []).length;
  console.log(`Ledger Heads in Indirect Income: ${incomeCount}`);
  console.log();
}

console.log('💼 INDIRECT EXPENSES (IndExp.xml)');
console.log(`${'─'.repeat(60)}`);

const indExpPath = path.join(exportDir, 'IndExp.xml');
const indExpXml = parseXMLFile(indExpPath);

if (indExpXml) {
  const expenseCount = (indExpXml.match(/<LEDGER[^>]*>/gi) || []).length;
  console.log(`Ledger Heads in Indirect Expenses: ${expenseCount}`);
  console.log();
}

console.log(`${'═'.repeat(60)}`);
console.log('ANALYSIS COMPLETE');
console.log(`${'═'.repeat(60)}\n`);
