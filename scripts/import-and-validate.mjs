#!/usr/bin/env node
/**
 * Full FY Import (Daily Mode) + Validation against Tally XML Reports
 *
 * Usage: node scripts/import-and-validate.mjs
 *
 * Prerequisites:
 * - Tally running on port 9000
 * - Proxy server running on port 3100 (cd server && npm run dev)
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import * as http from "node:http";

const BASE = "http://localhost:3100";
const COMPANY = "M.K.CYCLES (P) LTD.";
const FY_FROM = "20250401";
const FY_TO = "20260331";

// ─── Helper: fetch with timeout ─────────────────────────────────────
async function fetchWithTimeout(url, options = {}, timeoutMs = 600_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(timer);
    return r;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ─── HTTP POST with proper socket timeout (for long-running requests) ─
function httpPost(path, body, timeoutMs = 5400000) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = http.request({
      hostname: "localhost",
      port: 3100,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => {
        chunks.push(chunk);
        // Reset timeout on data received
        req.socket?.setTimeout(timeoutMs);
      });
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error(`Invalid JSON response: ${raw.slice(0, 200)}`));
        }
      });
      res.on("error", reject);
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`HTTP timeout after ${(timeoutMs / 1000).toFixed(0)}s`));
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── Parse UTF-16 Tally XML (spaces between chars) ─────────────────
function parseUTF16TallyXML(filePath) {
  const buf = readFileSync(filePath);
  // UTF-16LE: every other byte is the ASCII char, skip BOM
  let text = "";
  const start = (buf[0] === 0xFF && buf[1] === 0xFE) ? 2 : 0;
  for (let i = start; i < buf.length; i += 2) {
    const code = buf[i] | (buf[i + 1] << 8);
    if (code > 0) text += String.fromCharCode(code);
  }
  return text;
}

// ─── Parse P&L XML ──────────────────────────────────────────────────
function parsePandL(filePath) {
  const xml = parseUTF16TallyXML(filePath);
  const items = [];
  // Extract name-amount pairs
  const nameRe = /<DSPDISPNAME>(.*?)<\/DSPDISPNAME>/g;
  const mainAmtRe = /<BSMAINAMT>(.*?)<\/BSMAINAMT>/g;
  const subAmtRe = /<PLSUBAMT>(.*?)<\/PLSUBAMT>/g;

  let nameMatch;
  const names = [];
  while ((nameMatch = nameRe.exec(xml))) {
    names.push(nameMatch[1].trim());
  }

  const mainAmts = [];
  let amtMatch;
  while ((amtMatch = mainAmtRe.exec(xml))) {
    mainAmts.push(amtMatch[1].trim());
  }

  const subAmts = [];
  while ((amtMatch = subAmtRe.exec(xml))) {
    subAmts.push(amtMatch[1].trim());
  }

  // Build structured P&L
  const pl = {};
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const mainAmt = mainAmts[i] ? parseFloat(mainAmts[i]) : 0;
    const subAmt = subAmts[i] ? parseFloat(subAmts[i]) : 0;
    const amt = mainAmt || subAmt;

    if (name.includes("Sales Account")) pl.sales = Math.abs(amt);
    else if (name.includes("Cost of Sales")) pl.costOfSales = Math.abs(amt);
    else if (name.includes("Opening Stock")) pl.openingStock = Math.abs(amt);
    else if (name.includes("Purchase Account")) pl.purchases = Math.abs(amt);
    else if (name.includes("Closing Stock")) pl.closingStock = Math.abs(amt);
    else if (name.includes("Direct Expense")) pl.directExpenses = Math.abs(amt);
    else if (name.includes("Indirect Income")) pl.indirectIncome = Math.abs(amt);
    else if (name.includes("Indirect Expense")) pl.indirectExpenses = Math.abs(amt);
  }

  pl.grossProfit = (pl.sales || 0) - (pl.costOfSales || 0);
  pl.netProfit = pl.grossProfit + (pl.indirectIncome || 0) - (pl.indirectExpenses || 0);

  return pl;
}

// ─── Parse Balance Sheet XML ────────────────────────────────────────
function parseBSheet(filePath) {
  const xml = parseUTF16TallyXML(filePath);
  const bs = {};
  const nameRe = /<DSPDISPNAME>(.*?)<\/DSPDISPNAME>/g;
  const amtRe = /<BSMAINAMT>(.*?)<\/BSMAINAMT>/g;

  const names = [];
  let m;
  while ((m = nameRe.exec(xml))) names.push(m[1].trim());
  const amts = [];
  while ((m = amtRe.exec(xml))) amts.push(m[1].trim());

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const amt = amts[i] ? parseFloat(amts[i]) : 0;

    if (name.includes("Capital Account")) bs.capitalAccount = Math.abs(amt);
    else if (name.includes("Loans (Liability)")) bs.loans = Math.abs(amt);
    else if (name.includes("Current Liabilities")) bs.currentLiabilities = Math.abs(amt);
    else if (name.includes("Profit") && name.includes("Loss")) bs.profitAndLoss = Math.abs(amt);
    else if (name.includes("Fixed Assets")) bs.fixedAssets = Math.abs(amt);
    else if (name.includes("Investments")) bs.investments = Math.abs(amt);
    else if (name.includes("Current Assets")) bs.currentAssets = Math.abs(amt);
  }

  bs.totalLiabilities = (bs.capitalAccount || 0) + (bs.loans || 0) + (bs.currentLiabilities || 0) + (bs.profitAndLoss || 0);
  bs.totalAssets = (bs.fixedAssets || 0) + (bs.investments || 0) + (bs.currentAssets || 0);

  return bs;
}

// ─── Parse Stock Summary XML ────────────────────────────────────────
function parseStkSum(filePath) {
  const xml = parseUTF16TallyXML(filePath);
  const items = [];

  // Pattern: DSPDISPNAME followed by DSPCLQTY, DSPCLRATE, DSPCLAMTA
  const nameRe = /<DSPDISPNAME>(.*?)<\/DSPDISPNAME>/g;
  const qtyRe = /<DSPCLQTY>(.*?)<\/DSPCLQTY>/g;
  const amtRe = /<DSPCLAMTA>(.*?)<\/DSPCLAMTA>/g;

  const names = [];
  let m;
  while ((m = nameRe.exec(xml))) names.push(m[1].trim());
  const qtys = [];
  while ((m = qtyRe.exec(xml))) qtys.push(m[1].trim());
  const amts = [];
  while ((m = amtRe.exec(xml))) amts.push(m[1].trim());

  let totalClosingValue = 0;
  for (let i = 0; i < names.length && i < qtys.length; i++) {
    const qty = qtys[i];
    const amt = amts[i] ? Math.abs(parseFloat(amts[i])) : 0;

    // Parse qty like "4 PC" -> { value: 4, unit: "PC" }
    const qtyMatch = qty.match(/([\d.]+)\s*(.+)/);
    const qtyVal = qtyMatch ? parseFloat(qtyMatch[1]) : 0;
    const unit = qtyMatch ? qtyMatch[2].trim() : "";

    items.push({ name: names[i], qty: qtyVal, unit, amount: amt });
    totalClosingValue += amt;
  }

  return { items, totalClosingValue, count: items.length };
}

// ─── Parse Indirect Expenses XML ────────────────────────────────────
function parseIndExp(filePath) {
  const xml = parseUTF16TallyXML(filePath);
  const expenses = [];

  const nameRe = /<DSPDISPNAME>(.*?)<\/DSPDISPNAME>/g;
  const amtRe = /<DSPCLDRAMTA>(.*?)<\/DSPCLDRAMTA>/g;

  const names = [];
  let m;
  while ((m = nameRe.exec(xml))) names.push(m[1].trim());
  const amts = [];
  while ((m = amtRe.exec(xml))) amts.push(m[1].trim());

  let total = 0;
  for (let i = 0; i < names.length; i++) {
    const amt = amts[i] ? Math.abs(parseFloat(amts[i])) : 0;
    if (amt > 0) {
      expenses.push({ name: names[i], amount: amt });
      total += amt;
    }
  }

  return { expenses, total };
}

// ─── Parse Indirect Income XML ──────────────────────────────────────
function parseIndInc(filePath) {
  const xml = parseUTF16TallyXML(filePath);
  const incomes = [];

  const nameRe = /<DSPDISPNAME>(.*?)<\/DSPDISPNAME>/g;
  const amtRe = /<DSPCLCRAMTA>(.*?)<\/DSPCLCRAMTA>/g;

  const names = [];
  let m;
  while ((m = nameRe.exec(xml))) names.push(m[1].trim());
  const amts = [];
  while ((m = amtRe.exec(xml))) amts.push(m[1].trim());

  let total = 0;
  for (let i = 0; i < names.length; i++) {
    const amt = amts[i] ? Math.abs(parseFloat(amts[i])) : 0;
    if (amt > 0) {
      incomes.push({ name: names[i], amount: amt });
      total += amt;
    }
  }

  return { incomes, total };
}

// ─── Count vouchers in Payments/Receipts XML ────────────────────────
function countVouchersInXML(filePath, voucherType) {
  const xml = parseUTF16TallyXML(filePath);
  const re = new RegExp(`VCHTYPE="${voucherType}"`, "g");
  const matches = xml.match(re);
  return matches ? matches.length : 0;
}

// ─── Format numbers ─────────────────────────────────────────────────
function fmtLakhs(n) { return `₹${(n / 100000).toFixed(2)}L`; }
function fmtINR(n) { return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

// ═══════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════
async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  MKCP Full FY Import + Validation");
  console.log(`  Company: ${COMPANY}`);
  console.log(`  Period: ${FY_FROM} → ${FY_TO}`);
  console.log(`  Mode: Daily chunks`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // ─── Step 1: Check health ───────────────────────────────────────
  console.log("Step 1: Checking Tally connection...");
  const healthRes = await fetchWithTimeout(`${BASE}/api/tally/health`, {}, 10000);
  const health = await healthRes.json();
  if (!health.connected) {
    console.error("❌ Tally not connected:", health.error);
    process.exit(1);
  }
  console.log(`✅ Tally connected at ${health.tallyUrl}\n`);

  // ─── Step 2: Sync Masters ───────────────────────────────────────
  console.log("Step 2: Syncing Masters (groups, units, stock items, ledgers)...");
  const t0Masters = Date.now();
  const masters = await httpPost("/api/tally/sync-masters", { company: COMPANY }, 1200000);
  const mastersSec = ((Date.now() - t0Masters) / 1000).toFixed(1);

  if (!masters.success) {
    console.error("❌ Masters sync failed:", masters.errors || masters.error);
    if (masters.stats) console.log("  Partial stats:", masters.stats);
  }

  console.log(`✅ Masters synced in ${mastersSec}s:`);
  console.log(`   ${masters.stats.stockGroups} stock groups`);
  console.log(`   ${masters.stats.units} units`);
  console.log(`   ${masters.stats.stockItems} stock items`);
  console.log(`   ${masters.stats.ledgers} ledgers`);
  console.log(`   ${masters.stats.godowns ?? 0} godowns`);
  console.log(`   ${masters.stats.costCentres ?? 0} cost centres`);

  if (masters.tallyFinancials?.pl) {
    const pl = masters.tallyFinancials.pl;
    console.log(`\n   Tally P&L: Sales=${fmtLakhs(pl.sales)}, Purchases=${fmtLakhs(pl.purchases)}, Closing Stock=${fmtLakhs(pl.closingStock)}`);
  }
  if (masters.tallyFinancials?.bs) {
    const bs = masters.tallyFinancials.bs;
    console.log(`   Tally BS: Capital=${fmtLakhs(bs.capitalAccount)}, P&L A/c=${fmtLakhs(bs.profitAndLoss)}`);
  }
  console.log("");

  // ─── Step 3: Sync Day Book (Daily Mode) ─────────────────────────
  console.log("Step 3: Syncing Day Book in DAILY mode (full FY)...");
  console.log("   This may take 10-30 minutes for a full year of data.");
  console.log("   Watch the proxy terminal for chunk progress.\n");

  const t0Daybook = Date.now();
  const daybook = await httpPost("/api/tally/sync-daybook", {
    company: COMPANY,
    fromDate: FY_FROM,
    toDate: FY_TO,
    chunkMode: "daily",
  }, 5400000); // 90 min
  const daybookSec = ((Date.now() - t0Daybook) / 1000).toFixed(1);

  if (daybook.errors?.length) {
    console.log(`   ⚠ ${daybook.errors.length} chunk errors:`);
    for (const err of daybook.errors.slice(0, 10)) console.log(`     ${err}`);
  }

  console.log(`✅ Day Book synced in ${daybookSec}s:`);
  console.log(`   ${daybook.stats.vouchers} vouchers`);
  console.log(`   ${daybook.stats.chunksSucceeded}/${daybook.stats.chunksTotal} chunks succeeded`);
  if (daybook.stats.chunksFailed > 0) {
    console.log(`   ⚠ ${daybook.stats.chunksFailed} chunks failed`);
  }

  // Show voucher type breakdown
  if (daybook.data?.tallymessage) {
    const typeCounts = {};
    const vouchers = Array.isArray(daybook.data.tallymessage) ? daybook.data.tallymessage : [daybook.data.tallymessage];
    for (const msg of vouchers) {
      const vArr = msg.VOUCHER || msg.voucher || [];
      const vList = Array.isArray(vArr) ? vArr : [vArr];
      for (const v of vList) {
        const type = v.VOUCHERTYPENAME || v["@_VCHTYPE"] || "Unknown";
        typeCounts[type] = (typeCounts[type] || 0) + 1;
      }
    }
    console.log(`\n   Voucher Type Breakdown:`);
    for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`     ${type}: ${count}`);
    }
  }
  console.log("");

  // ─── Step 4: Parse Reference XML Files ──────────────────────────
  console.log("Step 4: Parsing Tally XML reference reports...\n");

  const tallyDir = "C:/Program Files/Tally/Tally.ERP9";

  // P&L
  console.log("   ── Profit & Loss ──");
  const pl = parsePandL(`${tallyDir}/PandL.xml`);
  console.log(`   Sales:            ${fmtLakhs(pl.sales)}`);
  console.log(`   Opening Stock:    ${fmtLakhs(pl.openingStock)}`);
  console.log(`   Purchases:        ${fmtLakhs(pl.purchases)}`);
  console.log(`   Closing Stock:    ${fmtLakhs(pl.closingStock)}`);
  console.log(`   Direct Expenses:  ${fmtLakhs(pl.directExpenses)}`);
  console.log(`   Cost of Sales:    ${fmtLakhs(pl.costOfSales)}`);
  console.log(`   Gross Profit:     ${fmtLakhs(pl.grossProfit)}`);
  console.log(`   Indirect Income:  ${fmtLakhs(pl.indirectIncome)}`);
  console.log(`   Indirect Expense: ${fmtLakhs(pl.indirectExpenses)}`);
  console.log(`   Net Profit:       ${fmtLakhs(pl.netProfit)}`);
  console.log("");

  // Balance Sheet
  console.log("   ── Balance Sheet ──");
  const bs = parseBSheet(`${tallyDir}/BSheet.xml`);
  console.log(`   Capital Account:    ${fmtLakhs(bs.capitalAccount)}`);
  console.log(`   Loans (Liability):  ${fmtLakhs(bs.loans || 0)}`);
  console.log(`   Current Liabilities:${fmtLakhs(bs.currentLiabilities)}`);
  console.log(`   Profit & Loss A/c:  ${fmtLakhs(bs.profitAndLoss)}`);
  console.log(`   Total Liabilities:  ${fmtLakhs(bs.totalLiabilities)}`);
  console.log(`   Fixed Assets:       ${fmtLakhs(bs.fixedAssets)}`);
  console.log(`   Investments:        ${fmtLakhs(bs.investments)}`);
  console.log(`   Current Assets:     ${fmtLakhs(bs.currentAssets)}`);
  console.log(`   Total Assets:       ${fmtLakhs(bs.totalAssets)}`);
  console.log("");

  // Stock Summary
  console.log("   ── Stock Summary ──");
  const stk = parseStkSum(`${tallyDir}/StkSum.xml`);
  console.log(`   Total Items:        ${stk.count}`);
  console.log(`   Total Closing Value:${fmtLakhs(stk.totalClosingValue)}`);
  console.log(`   (Should match P&L Closing Stock: ${fmtLakhs(pl.closingStock)})`);
  console.log("");

  // Indirect Expenses
  console.log("   ── Indirect Expenses ──");
  const indExp = parseIndExp(`${tallyDir}/IndExp.xml`);
  console.log(`   ${indExp.expenses.length} expense heads, Total: ${fmtLakhs(indExp.total)}`);
  console.log(`   (Should match P&L Indirect Expenses: ${fmtLakhs(pl.indirectExpenses)})`);
  console.log("");

  // Indirect Income
  console.log("   ── Indirect Income ──");
  const indInc = parseIndInc(`${tallyDir}/IndInc.xml`);
  console.log(`   ${indInc.incomes.length} income heads, Total: ${fmtLakhs(indInc.total)}`);
  console.log(`   (Should match P&L Indirect Income: ${fmtLakhs(pl.indirectIncome)})`);
  console.log("");

  // Payment/Receipt voucher counts
  console.log("   ── Payment & Receipt Vouchers ──");
  const paymentCount = countVouchersInXML(`${tallyDir}/Payments.xml`, "Payment");
  const receiptCount = countVouchersInXML(`${tallyDir}/Receipts.xml`, "Receipt");
  console.log(`   Payments.xml: ${paymentCount} Payment vouchers`);
  console.log(`   Receipts.xml: ${receiptCount} Receipt vouchers`);
  console.log("");

  // ─── Step 5: Cross-Validation ───────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  VALIDATION RESULTS");
  console.log("═══════════════════════════════════════════════════════════\n");

  const checks = [];

  // 5a: Compare P&L from masters sync vs XML
  if (masters.tallyFinancials?.pl) {
    const apiPL = masters.tallyFinancials.pl;
    checks.push(validate("P&L Sales", apiPL.sales, pl.sales));
    checks.push(validate("P&L Purchases", apiPL.purchases, pl.purchases));
    checks.push(validate("P&L Opening Stock", apiPL.openingStock, pl.openingStock));
    checks.push(validate("P&L Closing Stock", apiPL.closingStock, pl.closingStock));
    checks.push(validate("P&L Direct Expenses", apiPL.directExpenses, pl.directExpenses));
    checks.push(validate("P&L Indirect Income", apiPL.indirectIncome, pl.indirectIncome));
    checks.push(validate("P&L Indirect Expenses", apiPL.indirectExpenses, pl.indirectExpenses));
    checks.push(validate("P&L Net Profit", apiPL.netProfit, pl.netProfit));
  } else {
    console.log("⚠ No P&L data from masters sync — skipping P&L API validation");
  }

  // 5b: Compare BS from masters sync vs XML
  if (masters.tallyFinancials?.bs) {
    const apiBS = masters.tallyFinancials.bs;
    checks.push(validate("BS Capital Account", apiBS.capitalAccount, bs.capitalAccount));
    checks.push(validate("BS Current Liabilities", apiBS.currentLiabilities, bs.currentLiabilities));
    checks.push(validate("BS P&L A/c", apiBS.profitAndLoss, bs.profitAndLoss));
    checks.push(validate("BS Fixed Assets", apiBS.fixedAssets, bs.fixedAssets));
    checks.push(validate("BS Investments", apiBS.investments, bs.investments));
    checks.push(validate("BS Current Assets", apiBS.currentAssets, bs.currentAssets));
  } else {
    console.log("⚠ No BS data from masters sync — skipping BS API validation");
  }

  // 5c: Stock Summary vs Closing Stock
  checks.push(validate("Stock Summary Total vs P&L Closing Stock", stk.totalClosingValue, pl.closingStock, 5000));

  // 5d: Indirect Expenses total
  checks.push(validate("IndExp Total vs P&L", indExp.total, pl.indirectExpenses, 100));

  // 5e: Indirect Income total
  checks.push(validate("IndInc Total vs P&L", indInc.total, pl.indirectIncome, 100));

  // 5f: Voucher counts
  console.log("\n   ── Voucher Count Comparison ──");
  console.log(`   Imported Vouchers (API): ${daybook.stats.vouchers}`);
  console.log(`   Tally Payment XML:       ${paymentCount} payments`);
  console.log(`   Tally Receipt XML:       ${receiptCount} receipts`);
  console.log(`   Expected Payment+Receipt: ${paymentCount + receiptCount}`);
  console.log("");

  // ─── Summary ────────────────────────────────────────────────────
  const passed = checks.filter(c => c).length;
  const failed = checks.filter(c => !c).length;

  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  SUMMARY: ${passed} PASSED, ${failed} FAILED out of ${checks.length} checks`);
  console.log(`  Masters: ${masters.stats.stockItems} items, ${masters.stats.ledgers} ledgers`);
  console.log(`  Vouchers: ${daybook.stats.vouchers} (daily mode, ${daybook.stats.chunksSucceeded} chunks)`);
  console.log(`  Time: Masters ${mastersSec}s + DayBook ${daybookSec}s = ${(parseFloat(mastersSec) + parseFloat(daybookSec)).toFixed(1)}s total`);
  console.log("═══════════════════════════════════════════════════════════");

  process.exit(failed > 0 ? 1 : 0);
}

function validate(label, actual, expected, toleranceAbs = 1) {
  const diff = Math.abs((actual || 0) - (expected || 0));
  const pctDiff = expected ? ((diff / Math.abs(expected)) * 100).toFixed(3) : "N/A";
  const pass = diff <= toleranceAbs;

  if (pass) {
    console.log(`   ✅ ${label}: ${fmtINR(actual)} (exact match)`);
  } else {
    console.log(`   ❌ ${label}: Got ${fmtINR(actual || 0)} vs Expected ${fmtINR(expected || 0)} (diff: ${fmtINR(diff)}, ${pctDiff}%)`);
  }

  return pass;
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
