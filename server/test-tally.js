#!/usr/bin/env node
/**
 * Tally connectivity diagnostic tool
 * Usage: node test-tally.js [tally-url] [company-name]
 */

const http = require('http');
const { URL } = require('url');

const TALLY_URL = process.argv[2] || 'http://localhost:9000';
const COMPANY = process.argv[3] || 'M.K.CYCLES (P) LTD.';

console.log(`\n🔍 Testing Tally connection...`);
console.log(`   URL: ${TALLY_URL}`);
console.log(`   Company: ${COMPANY}\n`);

// Simple ping to test connectivity
function pingTally() {
  return new Promise((resolve, reject) => {
    const url = new URL(TALLY_URL);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Company</TYPE>
    <ID>${COMPANY}</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TallyOfCompany FETCH="Name,GUID">
        <COMPANY NAME="${COMPANY}"/>
      </TallyOfCompany>
    </DESC>
  </BODY>
</ENVELOPE>`;

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 9000,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(xml, 'utf-8'),
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (data.includes('TALLYMESSAGE') || data.includes('Company')) {
            console.log(`✅ SUCCESS: Tally is reachable and responding`);
            console.log(`   Status: ${res.statusCode}`);
            console.log(`   Response length: ${data.length} bytes\n`);
            resolve(true);
          } else {
            console.log(`⚠️  Tally responded but invalid response:`);
            console.log(`   Status: ${res.statusCode}`);
            console.log(`   Response: ${data.substring(0, 200)}...\n`);
            resolve(false);
          }
        });
      }
    );

    req.on('error', (err) => {
      console.log(`❌ FAILED: Cannot connect to Tally`);
      console.log(`   Error: ${err.message}`);
      console.log(`   Code: ${err.code}\n`);
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      console.log(`❌ TIMEOUT: Tally took too long to respond`);
      console.log(`   Waited 15 seconds...\n`);
      reject(new Error('Timeout'));
    });

    req.write(xml);
    req.end();
  });
}

async function main() {
  try {
    await pingTally();
    console.log(`📋 Diagnostics:
  1. Check if Tally Prime is running
  2. Verify Tally is listening on port ${new URL(TALLY_URL).port || 9000}
  3. Verify company name matches exactly: "${COMPANY}"
  4. Check Tally firewall settings
  5. Try connecting from another app to verify it's not an Electron issue\n`);
  } catch (err) {
    console.log(`📋 Troubleshooting:
  1. Make sure Tally Prime is running
  2. Verify the Tally gateway is enabled (Gateway > Enable Gateway)
  3. Ensure Tally is set to accept connections on localhost:9000
  4. Try restarting both Tally and the Dashboard app
  5. Check Windows Firewall isn't blocking port 9000\n`);
    process.exit(1);
  }
}

main().catch(console.error);
