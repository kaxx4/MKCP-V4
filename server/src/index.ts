import express from "express";
import cors from "cors";
import { tallyPost, stockItemsXml, ledgersXml, vouchersXml, HEALTH_XML } from "./tally.js";
import { convertStockItems, convertLedgers, convertVouchers, convertCompanies } from "./convert.js";

const app = express();
const PORT = 3100;
const TALLY = process.env.TALLY_URL || "http://localhost:9000";

app.use(cors());
app.use(express.json({ limit: "100mb" }));

// In-memory log buffer for live streaming
const logBuffer: string[] = [];
const MAX_LOGS = 500;

// Intercept console.log to capture logs
const originalLog = console.log;
const originalError = console.error;
console.log = (...args: any[]) => {
  const msg = args.join(" ");
  logBuffer.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  originalLog(...args);
};
console.error = (...args: any[]) => {
  const msg = args.join(" ");
  logBuffer.push(`[${new Date().toLocaleTimeString()}] ❌ ${msg}`);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  originalError(...args);
};

// Root — Live log viewer
app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>MKCP Tally Proxy - Live Logs</title>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Consolas', 'Monaco', monospace;
      background: #0d1117;
      color: #c9d1d9;
      padding: 20px;
    }
    h1 {
      color: #58a6ff;
      margin-bottom: 10px;
      font-size: 24px;
    }
    .info {
      color: #8b949e;
      margin-bottom: 20px;
      font-size: 14px;
    }
    .status {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: bold;
      margin-left: 10px;
    }
    .status.connected { background: #238636; color: white; }
    .status.disconnected { background: #da3633; color: white; }
    #logs {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 16px;
      height: calc(100vh - 140px);
      overflow-y: auto;
      font-size: 13px;
      line-height: 1.6;
    }
    .log-line {
      margin: 2px 0;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .log-line:hover { background: #0d1117; }
    .timestamp { color: #6e7681; }
    .success { color: #3fb950; }
    .error { color: #f85149; }
    .warn { color: #d29922; }
    .info { color: #58a6ff; }
    .separator {
      color: #30363d;
      margin: 8px 0;
      border-top: 1px solid #21262d;
      padding-top: 8px;
    }
  </style>
</head>
<body>
  <h1>🔌 MKCP Tally Proxy Server</h1>
  <div class="info">
    Target: <strong>${TALLY}</strong>
    <span id="status" class="status disconnected">Checking...</span>
  </div>
  <div id="logs"></div>

  <script>
    const logsDiv = document.getElementById('logs');
    const statusSpan = document.getElementById('status');
    let autoScroll = true;

    // Check if user manually scrolled
    logsDiv.addEventListener('scroll', () => {
      const isAtBottom = logsDiv.scrollHeight - logsDiv.scrollTop <= logsDiv.clientHeight + 50;
      autoScroll = isAtBottom;
    });

    // Fetch logs every 500ms
    setInterval(async () => {
      try {
        const res = await fetch('/api/tally/logs');
        const logs = await res.json();

        logsDiv.innerHTML = logs.map(log => {
          let className = 'log-line';
          if (log.includes('✓')) className += ' success';
          else if (log.includes('✗') || log.includes('❌') || log.includes('ERROR')) className += ' error';
          else if (log.includes('⚠')) className += ' warn';
          else if (log.includes('[SYNC]') || log.includes('[DEBUG]')) className += ' info';
          else if (log.includes('====')) className += ' separator';

          return \`<div class="\${className}">\${escapeHtml(log)}</div>\`;
        }).join('');

        if (autoScroll) {
          logsDiv.scrollTop = logsDiv.scrollHeight;
        }
      } catch (e) {
        console.error('Failed to fetch logs:', e);
      }
    }, 500);

    // Check Tally health every 3s
    setInterval(async () => {
      try {
        const res = await fetch('/api/tally/health');
        const data = await res.json();
        if (data.connected) {
          statusSpan.textContent = 'Connected to Tally';
          statusSpan.className = 'status connected';
        } else {
          statusSpan.textContent = 'Disconnected';
          statusSpan.className = 'status disconnected';
        }
      } catch (e) {
        statusSpan.textContent = 'Error';
        statusSpan.className = 'status disconnected';
      }
    }, 3000);

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
  </script>
</body>
</html>
  `);
});

// API endpoint to get logs
app.get("/api/tally/logs", (_req, res) => {
  res.json(logBuffer);
});

// Health
app.get("/api/tally/health", async (_req, res) => {
  try {
    await tallyPost(TALLY, HEALTH_XML, 10_000);
    res.json({ connected: true, tallyUrl: TALLY });
  } catch (e: any) {
    res.json({ connected: false, error: e.message, tallyUrl: TALLY });
  }
});

// Full sync — the main endpoint
app.post("/api/tally/sync", async (req, res) => {
  const { company, fromDate, toDate } = req.body;
  if (!company) return res.status(400).json({ success: false, error: "company required" });

  // Increase Express response timeout to 10 minutes
  res.setTimeout(600_000);

  const t0 = Date.now();
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[SYNC] Company: "${company}"`);
  console.log(`[SYNC] Period: ${fromDate || "all"} → ${toDate || "all"}`);
  console.log(`${"=".repeat(60)}`);

  const errors: string[] = [];

  // ── Step 1: Stock Items (SEQUENTIAL — Tally is single-threaded) ──
  let stocks = { tallymessage: [] as any[] };
  try {
    console.log(`[SYNC] Step 1/3: Fetching stock items...`);
    const xml = await tallyPost(TALLY, stockItemsXml(company), 300_000);
    stocks = convertStockItems(xml);
    console.log(`[SYNC] ✓ Stock items: ${stocks.tallymessage.length}`);
  } catch (e: any) {
    console.error(`[SYNC] ✗ Stock items failed: ${e.message}`);
    errors.push(`Stock items: ${e.message}`);
  }

  // ── Step 2: Ledgers ──
  let ledgers = { tallymessage: [] as any[] };
  try {
    console.log(`[SYNC] Step 2/3: Fetching ledgers...`);
    const xml = await tallyPost(TALLY, ledgersXml(company), 300_000);
    ledgers = convertLedgers(xml);
    console.log(`[SYNC] ✓ Ledgers: ${ledgers.tallymessage.length}`);
  } catch (e: any) {
    console.error(`[SYNC] ✗ Ledgers failed: ${e.message}`);
    errors.push(`Ledgers: ${e.message}`);
  }

  // ── Step 3: Vouchers ──
  let vouchers = { tallymessage: [] as any[] };
  try {
    console.log(`[SYNC] Step 3/3: Fetching vouchers (this may take 1-3 minutes)...`);
    const xml = await tallyPost(TALLY, vouchersXml(company, fromDate, toDate), 300_000);
    vouchers = convertVouchers(xml);
    console.log(`[SYNC] ✓ Vouchers: ${vouchers.tallymessage.length}`);
  } catch (e: any) {
    console.error(`[SYNC] ✗ Vouchers failed: ${e.message}`);
    errors.push(`Vouchers: ${e.message}`);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const stats = {
    stockItems: stocks.tallymessage.length,
    ledgers: ledgers.tallymessage.length,
    vouchers: vouchers.tallymessage.length,
    elapsedSeconds: parseFloat(elapsed),
  };

  console.log(`[SYNC] Done in ${elapsed}s: ${stats.stockItems} items, ${stats.ledgers} ledgers, ${stats.vouchers} vouchers`);
  if (errors.length > 0) console.log(`[SYNC] Errors: ${errors.join("; ")}`);

  const hasData = stats.stockItems > 0 || stats.ledgers > 0 || stats.vouchers > 0;

  res.json({
    success: hasData,
    errors: errors.length > 0 ? errors : undefined,
    error: !hasData ? "Tally returned zero data. Verify: (1) Company name matches EXACTLY as shown in TallyPrime (2) Company is loaded/open (3) Date range is within company period" : undefined,
    masters: {
      tallymessage: [
        { metadata: { type: "Company", name: company }, name: company, fystart: 4 },
        ...stocks.tallymessage,
        ...ledgers.tallymessage,
      ],
    },
    transactions: vouchers,
    stats,
  });
});

// Debug — test individual requests and see raw XML response
app.post("/api/tally/debug", async (req, res) => {
  const { company, test } = req.body;
  if (!company) return res.status(400).json({ error: "company required" });

  let xml = HEALTH_XML;
  if (test === "stock") xml = stockItemsXml(company);
  else if (test === "ledger") xml = ledgersXml(company);
  else if (test === "voucher") xml = vouchersXml(company);

  try {
    console.log(`[DEBUG] Sending ${test || "health"} request...`);
    const raw = await tallyPost(TALLY, xml, 60_000, true);
    res.json({
      success: true,
      xmlSent: xml,
      responseLength: raw.length,
      responsePreview: typeof raw === "string" ? raw.slice(0, 3000) : "parsed object",
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✓ MKCP Tally Proxy → http://localhost:${PORT}`);
  console.log(`   Target: ${TALLY}\n`);
});

declare global { namespace Express { interface Request { tallyUrl: string } } }
