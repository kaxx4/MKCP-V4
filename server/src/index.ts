import express from "express";
import cors from "cors";
import { tallyPost, stockItemsXml, stockGroupsXml, unitsXml, ledgersXml, vouchersXml, getMonthlyChunks, HEALTH_XML } from "./tally.js";
import { convertStockItems, convertStockGroups, convertUnits, convertLedgers, convertVouchers, convertCompanies } from "./convert.js";

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

// SSE progress endpoint — streams log entries in real time
app.get("/api/tally/progress", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let lastIndex = logBuffer.length;

  const interval = setInterval(() => {
    while (lastIndex < logBuffer.length) {
      res.write(`data: ${JSON.stringify(logBuffer[lastIndex])}\n\n`);
      lastIndex++;
    }
  }, 300);

  req.on("close", () => {
    clearInterval(interval);
  });
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

// ── Sync Masters Only (groups + units + stock items + ledgers) ──
app.post("/api/tally/sync-masters", async (req, res) => {
  const { company } = req.body;
  if (!company) return res.status(400).json({ success: false, error: "company required" });

  res.setTimeout(300_000); // 5 min
  const t0 = Date.now();
  console.log(`\n[MASTERS] Syncing masters for "${company}"...`);

  let groups = { tallymessage: [] as any[] };
  let units = { tallymessage: [] as any[] };
  let stocks = { tallymessage: [] as any[] };
  let ledgers = { tallymessage: [] as any[] };
  const errors: string[] = [];

  // Step 1: Stock Groups
  try {
    console.log(`[MASTERS] Step 1/4: Fetching stock groups...`);
    const xml = await tallyPost(TALLY, stockGroupsXml(company), 30_000);
    groups = convertStockGroups(xml);
    console.log(`[MASTERS] ✓ ${groups.tallymessage.length} stock groups`);
  } catch (e: any) {
    console.error(`[MASTERS] ✗ Stock groups: ${e.message}`);
    errors.push(`Stock groups: ${e.message}`);
  }

  // Step 2: Units
  try {
    console.log(`[MASTERS] Step 2/4: Fetching units...`);
    const xml = await tallyPost(TALLY, unitsXml(company), 30_000);
    units = convertUnits(xml);
    console.log(`[MASTERS] ✓ ${units.tallymessage.length} units`);
  } catch (e: any) {
    console.error(`[MASTERS] ✗ Units: ${e.message}`);
    errors.push(`Units: ${e.message}`);
  }

  // Step 3: Stock Items
  try {
    console.log(`[MASTERS] Step 3/4: Fetching stock items...`);
    const xml = await tallyPost(TALLY, stockItemsXml(company), 120_000);
    stocks = convertStockItems(xml);
    console.log(`[MASTERS] ✓ ${stocks.tallymessage.length} stock items`);
  } catch (e: any) {
    console.error(`[MASTERS] ✗ Stock items: ${e.message}`);
    errors.push(e.message);
  }

  // Step 4: Ledgers
  try {
    console.log(`[MASTERS] Step 4/4: Fetching ledgers...`);
    const xml = await tallyPost(TALLY, ledgersXml(company), 120_000);
    ledgers = convertLedgers(xml);
    console.log(`[MASTERS] ✓ ${ledgers.tallymessage.length} ledgers`);
  } catch (e: any) {
    console.error(`[MASTERS] ✗ Ledgers: ${e.message}`);
    errors.push(e.message);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[MASTERS] Done in ${elapsed}s`);

  res.json({
    success: stocks.tallymessage.length > 0 || ledgers.tallymessage.length > 0,
    errors: errors.length > 0 ? errors : undefined,
    data: {
      tallymessage: [
        { metadata: { type: "Company", name: company }, name: company, fystart: 4 },
        ...groups.tallymessage,
        ...units.tallymessage,
        ...stocks.tallymessage,
        ...ledgers.tallymessage,
      ],
    },
    stats: {
      stockGroups: groups.tallymessage.length,
      units: units.tallymessage.length,
      stockItems: stocks.tallymessage.length,
      ledgers: ledgers.tallymessage.length,
      elapsedSeconds: parseFloat(elapsed),
    },
  });
});

// ── Sync Day Book (vouchers for a period) — MONTHLY CHUNKING ──
app.post("/api/tally/sync-daybook", async (req, res) => {
  const { company, fromDate, toDate } = req.body;
  if (!company) return res.status(400).json({ success: false, error: "company required" });
  if (!fromDate || !toDate) return res.status(400).json({ success: false, error: "fromDate and toDate required (YYYYMMDD)" });

  res.setTimeout(900_000); // 15 min
  const t0 = Date.now();
  const chunks = getMonthlyChunks(fromDate, toDate);
  console.log(`\n[DAYBOOK] Syncing vouchers for "${company}" (${fromDate} → ${toDate}) in ${chunks.length} monthly chunks...`);

  const allVouchers: any[] = [];
  const chunkDetails: { label: string; count: number; ms: number }[] = [];
  const errors: string[] = [];
  let chunksSucceeded = 0;
  let chunksFailed = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkT0 = Date.now();
    try {
      console.log(`[DAYBOOK] Chunk ${i + 1}/${chunks.length}: ${chunk.label} (${chunk.from} → ${chunk.to})...`);
      const xml = await tallyPost(TALLY, vouchersXml(company, chunk.from, chunk.to), 120_000);
      const vouchers = convertVouchers(xml);
      const ms = Date.now() - chunkT0;
      allVouchers.push(...vouchers.tallymessage);
      chunkDetails.push({ label: chunk.label, count: vouchers.tallymessage.length, ms });
      chunksSucceeded++;
      console.log(`[DAYBOOK] ✓ ${chunk.label}: ${vouchers.tallymessage.length} vouchers (${ms}ms)`);
    } catch (e: any) {
      const ms = Date.now() - chunkT0;
      chunksFailed++;
      chunkDetails.push({ label: chunk.label, count: 0, ms });
      const errMsg = `${chunk.label}: ${e.message}`;
      errors.push(errMsg);
      console.error(`[DAYBOOK] ✗ ${errMsg}`);
      // Continue — don't abort on chunk failure
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[DAYBOOK] ✓ Total: ${allVouchers.length} vouchers in ${elapsed}s (${chunksSucceeded}/${chunks.length} chunks succeeded)`);

  res.json({
    success: allVouchers.length > 0,
    errors: errors.length > 0 ? errors : undefined,
    data: { tallymessage: allVouchers },
    stats: {
      vouchers: allVouchers.length,
      fromDate,
      toDate,
      chunksTotal: chunks.length,
      chunksSucceeded,
      chunksFailed,
      chunkDetails,
      elapsedSeconds: parseFloat(elapsed),
    },
  });
});

// Full sync — the main endpoint
app.post("/api/tally/sync", async (req, res) => {
  const { company, fromDate, toDate } = req.body;
  if (!company) return res.status(400).json({ success: false, error: "company required" });

  // Increase Express response timeout to 15 minutes
  res.setTimeout(900_000);

  const t0 = Date.now();
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[SYNC] Company: "${company}"`);
  console.log(`[SYNC] Period: ${fromDate || "all"} → ${toDate || "all"}`);
  console.log(`${"=".repeat(60)}`);

  const errors: string[] = [];

  // ── Step 1: Stock Groups ──
  let groups = { tallymessage: [] as any[] };
  try {
    console.log(`[SYNC] Step 1/5: Fetching stock groups...`);
    const xml = await tallyPost(TALLY, stockGroupsXml(company), 30_000);
    groups = convertStockGroups(xml);
    console.log(`[SYNC] ✓ Stock groups: ${groups.tallymessage.length}`);
  } catch (e: any) {
    console.error(`[SYNC] ✗ Stock groups failed: ${e.message}`);
    errors.push(`Stock groups: ${e.message}`);
  }

  // ── Step 2: Units ──
  let units = { tallymessage: [] as any[] };
  try {
    console.log(`[SYNC] Step 2/5: Fetching units...`);
    const xml = await tallyPost(TALLY, unitsXml(company), 30_000);
    units = convertUnits(xml);
    console.log(`[SYNC] ✓ Units: ${units.tallymessage.length}`);
  } catch (e: any) {
    console.error(`[SYNC] ✗ Units failed: ${e.message}`);
    errors.push(`Units: ${e.message}`);
  }

  // ── Step 3: Stock Items ──
  let stocks = { tallymessage: [] as any[] };
  try {
    console.log(`[SYNC] Step 3/5: Fetching stock items...`);
    const xml = await tallyPost(TALLY, stockItemsXml(company), 300_000);
    stocks = convertStockItems(xml);
    console.log(`[SYNC] ✓ Stock items: ${stocks.tallymessage.length}`);
  } catch (e: any) {
    console.error(`[SYNC] ✗ Stock items failed: ${e.message}`);
    errors.push(`Stock items: ${e.message}`);
  }

  // ── Step 4: Ledgers ──
  let ledgers = { tallymessage: [] as any[] };
  try {
    console.log(`[SYNC] Step 4/5: Fetching ledgers...`);
    const xml = await tallyPost(TALLY, ledgersXml(company), 300_000);
    ledgers = convertLedgers(xml);
    console.log(`[SYNC] ✓ Ledgers: ${ledgers.tallymessage.length}`);
  } catch (e: any) {
    console.error(`[SYNC] ✗ Ledgers failed: ${e.message}`);
    errors.push(`Ledgers: ${e.message}`);
  }

  // ── Step 5: Vouchers (Monthly Chunking) ──
  const allVouchers: any[] = [];
  if (fromDate && toDate) {
    const chunks = getMonthlyChunks(fromDate, toDate);
    console.log(`[SYNC] Step 5/5: Fetching vouchers month-by-month (${chunks.length} chunks)...`);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        console.log(`[SYNC]   Chunk ${i + 1}/${chunks.length}: ${chunk.label}...`);
        const xml = await tallyPost(TALLY, vouchersXml(company, chunk.from, chunk.to), 120_000);
        const vouchers = convertVouchers(xml);
        allVouchers.push(...vouchers.tallymessage);
        console.log(`[SYNC]   ✓ ${chunk.label}: ${vouchers.tallymessage.length} vouchers`);
      } catch (e: any) {
        console.error(`[SYNC]   ✗ ${chunk.label}: ${e.message}`);
        errors.push(`Vouchers ${chunk.label}: ${e.message}`);
      }
    }
    console.log(`[SYNC] ✓ Total vouchers: ${allVouchers.length}`);
  } else {
    console.log(`[SYNC] Step 5/5: Skipped — no date range provided`);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const stats = {
    stockGroups: groups.tallymessage.length,
    units: units.tallymessage.length,
    stockItems: stocks.tallymessage.length,
    ledgers: ledgers.tallymessage.length,
    vouchers: allVouchers.length,
    elapsedSeconds: parseFloat(elapsed),
  };

  console.log(`[SYNC] Done in ${elapsed}s: ${stats.stockGroups} groups, ${stats.units} units, ${stats.stockItems} items, ${stats.ledgers} ledgers, ${stats.vouchers} vouchers`);
  if (errors.length > 0) console.log(`[SYNC] Errors: ${errors.join("; ")}`);

  const hasData = stats.stockItems > 0 || stats.ledgers > 0 || stats.vouchers > 0;

  res.json({
    success: hasData,
    errors: errors.length > 0 ? errors : undefined,
    error: !hasData ? "Tally returned zero data. Verify: (1) Company name matches EXACTLY as shown in TallyPrime (2) Company is loaded/open (3) Date range is within company period" : undefined,
    masters: {
      tallymessage: [
        { metadata: { type: "Company", name: company }, name: company, fystart: 4 },
        ...groups.tallymessage,
        ...units.tallymessage,
        ...stocks.tallymessage,
        ...ledgers.tallymessage,
      ],
    },
    transactions: { tallymessage: allVouchers },
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
  else if (test === "voucher") xml = vouchersXml(company, "20250401", "20250430");
  else if (test === "groups") xml = stockGroupsXml(company);
  else if (test === "units") xml = unitsXml(company);

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

// Debug — return first N parsed stock items with all fields
app.post("/api/tally/debug-stock", async (req, res) => {
  const { company, count = 5 } = req.body;
  if (!company) return res.status(400).json({ error: "company required" });
  try {
    const xml = await tallyPost(TALLY, stockItemsXml(company), 120_000);
    const stocks = convertStockItems(xml);
    res.json({
      success: true,
      totalItems: stocks.tallymessage.length,
      sample: stocks.tallymessage.slice(0, count),
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
