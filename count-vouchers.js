#!/usr/bin/env node

/**
 * Count Vouchers in Large Tally XML Export Files
 * Uses streaming to handle 40-56 MB files efficiently
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function countVouchersInFile(filePath, fileName) {
  return new Promise((resolve) => {
    let voucherCount = 0;
    let byType = {};

    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      if (line.includes('<VOUCHER')) {
        voucherCount++;

        // Extract VCHTYPE from line
        const typeMatch = line.match(/VCHTYPE\s*=\s*"([^"]+)"/);
        if (typeMatch) {
          const type = typeMatch[1].trim();
          byType[type] = (byType[type] || 0) + 1;
        }
      }
    });

    rl.on('close', () => {
      resolve({ fileName, voucherCount, byType });
    });

    rl.on('error', (err) => {
      console.error(`Error reading ${fileName}:`, err.message);
      resolve({ fileName, voucherCount: 0, byType: {} });
    });
  });
}

async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('COUNTING VOUCHERS IN LARGE TALLY EXPORT FILES');
  console.log(`${'═'.repeat(60)}\n`);

  const exportDir = path.join(__dirname, 'TALLY TEST 193');

  const files = [
    { name: 'Payments.xml', label: '💳 PAYMENTS' },
    { name: 'Receipts.xml', label: '💰 RECEIPTS' },
  ];

  for (const file of files) {
    const filePath = path.join(exportDir, file.name);

    if (!fs.existsSync(filePath)) {
      console.log(`${file.label} (${file.name})`);
      console.log(`${'─'.repeat(60)}`);
      console.log(`File not found: ${filePath}\n`);
      continue;
    }

    console.log(`${file.label} (${file.name})`);
    console.log(`${'─'.repeat(60)}`);

    const fileStats = fs.statSync(filePath);
    const fileSizeGB = (fileStats.size / (1024 * 1024 * 1024)).toFixed(2);
    const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(1);

    console.log(`File size: ${fileSizeMB} MB`);
    console.log(`Counting vouchers (this may take a moment)...`);

    const startTime = Date.now();
    const result = await countVouchersInFile(filePath, file.name);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`Total Vouchers: ${result.voucherCount}`);
    if (Object.keys(result.byType).length > 0) {
      console.log('Breakdown by Type:');
      Object.entries(result.byType)
        .sort((a, b) => b[1] - a[1])
        .forEach(([type, count]) => {
          console.log(`  - ${type}: ${count}`);
        });
    }
    console.log(`Processing time: ${duration}s\n`);
  }

  console.log(`${'═'.repeat(60)}`);
  console.log('ANALYSIS COMPLETE');
  console.log(`${'═'.repeat(60)}\n`);
}

main().catch(console.error);
