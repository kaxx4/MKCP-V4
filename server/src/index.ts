import express from "express";
import cors from "cors";
import { tallyPost, tallyPostWithRetry, stockItemsXml, stockGroupsXml, unitsXml, godownsXml, costCentresXml, ledgersXml, vouchersXml, vouchersCollectionXml, getMonthlyChunks, getDailyChunks, getWeeklyChunks, HEALTH_XML, profitAndLossXml, balanceSheetXml, parsePLReport, parseBSReport } from "./tally.js";
import { convertStockItems, convertStockGroups, convertUnits, convertGodowns, convertCostCentres, convertLedgers, convertVouchers, convertCompanies } from "./convert.js";

const app = express();
const PORT = 3100;
const TALLY = process.env.TALLY_URL || "http://localhost:9000";

// Prevent duplicate concurrent syncs for the same company
const activeSyncs = new Map<string, Promise<any>>();

app.use(cors());
app.use(express.json({ limit: "100mb" }));

// In-memory log buffer for live streaming
const logBuffer: string[] = [];
const MAX_LOGS = 500;

let lastRawXml: { request: string; response: string; timestamp: string; label: string } | null = null;

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

// Company auto-detection
app.get("/api/tally/company", async (_req, res) => {
  try {
    const parsed = await tallyPost(TALLY, HEALTH_XML, 10_000);
    const companies = convertCompanies(parsed);
    res.json({
      success: true,
      companies,
      current: companies.length > 0 ? companies[0].name : null
    });
  } catch (e: any) {
    res.json({ success: false, error: e.message, companies: [], current: null });
  }
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

  const lockKey = `${company}_${req.path}`;
  if (activeSyncs.has(lockKey)) {
    console.log(`[MASTERS] Duplicate request blocked for ${lockKey}`);
    return res.status(409).json({ success: false, error: "Sync already in progress for this company" });
  }

  // Abort in-flight Tally requests when client disconnects
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) { console.log("[MASTERS] Client disconnected — aborting"); ac.abort(); } });

  activeSyncs.set(lockKey, Promise.resolve());
  res.setTimeout(1_200_000); // 20 min — stock items XML can be very large
  const t0 = Date.now();
  console.log(`\n[MASTERS] Syncing masters for "${company}"...`);

  const errors: string[] = [];

  // Parallel fetch: groups + units + godowns + costCentres + financial reports (small/fast)
  // Then sequential: stock items + ledgers (large/slow)
  const [groupsRes, unitsRes, godownsRes, costCentresRes, plReportRes, bsReportRes] = await Promise.allSettled([
    (async () => { console.log(`[MASTERS] Fetching stock groups...`); const xml = await tallyPostWithRetry(TALLY, stockGroupsXml(company), 30_000, false, 1, ac.signal); return convertStockGroups(xml); })(),
    (async () => { console.log(`[MASTERS] Fetching units...`); const xml = await tallyPostWithRetry(TALLY, unitsXml(company), 30_000, false, 1, ac.signal); return convertUnits(xml); })(),
    (async () => { console.log(`[MASTERS] Fetching godowns...`); const xml = await tallyPostWithRetry(TALLY, godownsXml(company), 30_000, false, 1, ac.signal); return convertGodowns(xml); })(),
    (async () => { console.log(`[MASTERS] Fetching cost centres...`); const xml = await tallyPostWithRetry(TALLY, costCentresXml(company), 30_000, false, 1, ac.signal); return convertCostCentres(xml); })(),
    (async () => { console.log(`[MASTERS] Fetching P&L report...`); const xml = await tallyPostWithRetry(TALLY, profitAndLossXml(company), 30_000, true, 1, ac.signal); return parsePLReport(xml); })(),
    (async () => { console.log(`[MASTERS] Fetching Balance Sheet...`); const xml = await tallyPostWithRetry(TALLY, balanceSheetXml(company), 30_000, true, 1, ac.signal); return parseBSReport(xml); })(),
  ]);

  const groups = groupsRes.status === "fulfilled" ? groupsRes.value : (() => { errors.push(`Stock groups: ${(groupsRes as PromiseRejectedResult).reason?.message}`); return { tallymessage: [] as any[] }; })();
  const units = unitsRes.status === "fulfilled" ? unitsRes.value : (() => { errors.push(`Units: ${(unitsRes as PromiseRejectedResult).reason?.message}`); return { tallymessage: [] as any[] }; })();
  const godowns = godownsRes.status === "fulfilled" ? godownsRes.value : (() => { errors.push(`Godowns: ${(godownsRes as PromiseRejectedResult).reason?.message}`); return { tallymessage: [] as any[] }; })();
  const costCentres = costCentresRes.status === "fulfilled" ? costCentresRes.value : (() => { errors.push(`Cost centres: ${(costCentresRes as PromiseRejectedResult).reason?.message}`); return { tallymessage: [] as any[] }; })();
  const plReport = plReportRes.status === "fulfilled" ? plReportRes.value : (() => { console.warn(`[MASTERS] P&L report failed: ${(plReportRes as PromiseRejectedResult).reason?.message}`); return null; })();
  const bsReport = bsReportRes.status === "fulfilled" ? bsReportRes.value : (() => { console.warn(`[MASTERS] Balance Sheet failed: ${(bsReportRes as PromiseRejectedResult).reason?.message}`); return null; })();

  if (plReport) console.log(`[MASTERS] ✓ P&L: Sales=${(plReport.sales/100000).toFixed(1)}L, Closing Stock=${(plReport.closingStock/100000).toFixed(1)}L, Net Profit=${(plReport.netProfit/100000).toFixed(1)}L`);
  if (bsReport) console.log(`[MASTERS] ✓ BS: Capital=${(bsReport.capitalAccount/100000).toFixed(1)}L, P&L=${(bsReport.profitAndLoss/100000).toFixed(1)}L`);
  console.log(`[MASTERS] ✓ Parallel batch: ${groups.tallymessage.length} groups, ${units.tallymessage.length} units, ${godowns.tallymessage.length} godowns, ${costCentres.tallymessage.length} cost centres`);

  // Stock Items (large)
  let stocks = { tallymessage: [] as any[] };
  if (!ac.signal.aborted) {
  try {
    console.log(`[MASTERS] Fetching stock items...`);
    const xml = await tallyPostWithRetry(TALLY, stockItemsXml(company), 900_000, false, 1, ac.signal);
    stocks = convertStockItems(xml);
    console.log(`[MASTERS] ✓ ${stocks.tallymessage.length} stock items`);
  } catch (e: any) {
    if (!e.message?.includes("Aborted")) { console.error(`[MASTERS] ✗ Stock items: ${e.message}`); errors.push(e.message); }
  }
  }

  // Ledgers (large)
  let ledgers = { tallymessage: [] as any[] };
  if (!ac.signal.aborted) {
  try {
    console.log(`[MASTERS] Fetching ledgers...`);
    const xml = await tallyPostWithRetry(TALLY, ledgersXml(company), 900_000, false, 1, ac.signal);
    ledgers = convertLedgers(xml);
    console.log(`[MASTERS] ✓ ${ledgers.tallymessage.length} ledgers`);
  } catch (e: any) {
    if (!e.message?.includes("Aborted")) { console.error(`[MASTERS] ✗ Ledgers: ${e.message}`); errors.push(e.message); }
  }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[MASTERS] Done in ${elapsed}s`);

  if (ac.signal.aborted) { activeSyncs.delete(lockKey); return; }

  try {
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
          ...godowns.tallymessage,
          ...costCentres.tallymessage,
        ],
      },
      tallyFinancials: plReport || bsReport ? { pl: plReport, bs: bsReport } : undefined,
      stats: {
        stockGroups: groups.tallymessage.length,
        units: units.tallymessage.length,
        stockItems: stocks.tallymessage.length,
        ledgers: ledgers.tallymessage.length,
        godowns: godowns.tallymessage.length,
        costCentres: costCentres.tallymessage.length,
        elapsedSeconds: parseFloat(elapsed),
      },
    });
  } catch (e: any) {
    console.error(`[MASTERS] Failed to send response: ${e.message}`);
  } finally {
    activeSyncs.delete(lockKey);
  }
});

// ── Sync Day Book (vouchers for a period) — CONFIGURABLE CHUNKING ──
app.post("/api/tally/sync-daybook", async (req, res) => {
  const { company, fromDate, toDate, chunkMode = "monthly" } = req.body;
  if (!company) return res.status(400).json({ success: false, error: "company required" });
  if (!fromDate || !toDate) return res.status(400).json({ success: false, error: "fromDate and toDate required (YYYYMMDD)" });

  const lockKey = `${company}_${req.path}`;
  if (activeSyncs.has(lockKey)) {
    console.log(`[DAYBOOK] Duplicate request blocked for ${lockKey}`);
    return res.status(409).json({ success: false, error: "Sync already in progress for this company" });
  }

  // Validate dates
  if (fromDate.length !== 8 || toDate.length !== 8) {
    return res.status(400).json({ success: false, error: `Invalid date format: from=${fromDate} to=${toDate}. Expected YYYYMMDD.` });
  }
  if (fromDate > toDate) {
    return res.status(400).json({ success: false, error: `fromDate (${fromDate}) is after toDate (${toDate})` });
  }
  if (fromDate === toDate) {
    console.warn(`[DAYBOOK] ⚠ Single day range detected (${fromDate}). This will only fetch one day of data.`);
  }

  // Abort in-flight Tally requests when client disconnects
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) { console.log("[DAYBOOK] Client disconnected — aborting"); ac.abort(); } });

  activeSyncs.set(lockKey, Promise.resolve());
  res.setTimeout(5_400_000); // 90 min — weekly full-FY can take 60+ min
  const t0 = Date.now();

  // Select chunking strategy
  let chunks: { from: string; to: string; label: string }[];
  if (chunkMode === "daily") {
    chunks = getDailyChunks(fromDate, toDate);
  } else if (chunkMode === "weekly") {
    chunks = getWeeklyChunks(fromDate, toDate);
  } else {
    chunks = getMonthlyChunks(fromDate, toDate);
  }
  console.log(`\n[DAYBOOK] Syncing vouchers for "${company}" (${fromDate} → ${toDate}) in ${chunks.length} ${chunkMode} chunks...`);

  const allVouchers: any[] = [];
  const seenGuids = new Set<string>();
  const chunkDetails: { label: string; count: number; ms: number }[] = [];
  const errors: string[] = [];
  let chunksSucceeded = 0;
  let chunksFailed = 0;

  const VOUCHER_TIMEOUT = 180_000; // 3 minutes per chunk

  // Helper: fetch a single date range and collect vouchers
  async function fetchChunkRange(from: string, to: string, label: string): Promise<ReturnType<typeof convertVouchers>> {
    let vouchers: ReturnType<typeof convertVouchers>;
    try {
      const xml = await tallyPostWithRetry(TALLY, vouchersCollectionXml(company, from, to), VOUCHER_TIMEOUT, false, 1, ac.signal);
      vouchers = convertVouchers(xml);
      if (vouchers.tallymessage.length === 0) {
        console.log(`[DAYBOOK]   Collection returned 0 for ${label}, trying Day Book fallback...`);
        const xml2 = await tallyPostWithRetry(TALLY, vouchersXml(company, from, to), VOUCHER_TIMEOUT, false, 1, ac.signal);
        const fallback = convertVouchers(xml2);
        if (fallback.tallymessage.length > 0) {
          let inRange = 0;
          for (const v of fallback.tallymessage) {
            const vDate = String(v.date ?? "").replace(/-/g, "");
            const vNum = parseInt(vDate, 10);
            if (vNum && vNum >= parseInt(from, 10) && vNum <= parseInt(to, 10)) inRange++;
          }
          if (inRange > 0) {
            console.log(`[DAYBOOK]   Day Book returned ${fallback.tallymessage.length} vouchers, ${inRange} in date range`);
            vouchers = fallback;
          } else {
            console.warn(`[DAYBOOK]   Day Book returned ${fallback.tallymessage.length} vouchers but NONE in range ${from}→${to} — discarding`);
          }
        }
      }
    } catch (primaryErr: any) {
      if (primaryErr.message?.includes("Aborted")) throw primaryErr;
      console.log(`[DAYBOOK]   Collection failed for ${label}, trying Day Book fallback...`);
      const xml2 = await tallyPostWithRetry(TALLY, vouchersXml(company, from, to), VOUCHER_TIMEOUT, false, 1, ac.signal);
      vouchers = convertVouchers(xml2);
    }
    return vouchers;
  }

  // Helper: collect voucher results into allVouchers with dedup
  function collectVouchers(vouchers: ReturnType<typeof convertVouchers>, label: string): number {
    let added = 0;
    for (const v of vouchers.tallymessage) {
      const guid = v.guid || v.GUID || "";
      if (guid && seenGuids.has(guid)) continue;
      if (guid) seenGuids.add(guid);
      allVouchers.push(v);
      added++;
    }
    const dupes = vouchers.tallymessage.length - added;
    if (dupes > 0) console.log(`[DAYBOOK]   Deduped: ${dupes} duplicate vouchers skipped in ${label}`);
    return added;
  }

  for (let i = 0; i < chunks.length; i++) {
    if (ac.signal.aborted) { console.log("[DAYBOOK] Aborted — stopping chunk loop"); break; }
    const chunk = chunks[i];
    const chunkT0 = Date.now();
    try {
      console.log(`[DAYBOOK] Chunk ${i + 1}/${chunks.length}: ${chunk.label} (${chunk.from} → ${chunk.to})...`);
      const vouchers = await fetchChunkRange(chunk.from, chunk.to, chunk.label);
      const added = collectVouchers(vouchers, chunk.label);
      const ms = Date.now() - chunkT0;
      chunkDetails.push({ label: chunk.label, count: added, ms });
      chunksSucceeded++;
      console.log(`[DAYBOOK] ✓ ${chunk.label}: ${added} vouchers (${ms}ms)`);
    } catch (e: any) {
      const isTimeout = e.message?.includes("timeout") || e.message?.includes("TIMEOUT");

      // Auto-fallback: if a monthly chunk timed out, retry with weekly sub-chunks
      if (isTimeout && chunkMode === "monthly" && chunk.from !== chunk.to) {
        console.log(`[DAYBOOK] ⚡ ${chunk.label} timed out — auto-splitting into weekly sub-chunks...`);
        const subChunks = getWeeklyChunks(chunk.from, chunk.to);
        let subTotal = 0;
        let subFailed = false;
        for (const sub of subChunks) {
          try {
            console.log(`[DAYBOOK]   Sub-chunk: ${sub.label} (${sub.from} → ${sub.to})...`);
            const subVouchers = await fetchChunkRange(sub.from, sub.to, sub.label);
            const added = collectVouchers(subVouchers, sub.label);
            subTotal += added;
            console.log(`[DAYBOOK]   ✓ ${sub.label}: ${added} vouchers`);
          } catch (subErr: any) {
            console.error(`[DAYBOOK]   ✗ ${sub.label}: ${subErr.message}`);
            errors.push(`${sub.label}: ${subErr.message}`);
            subFailed = true;
          }
        }
        const ms = Date.now() - chunkT0;
        if (subTotal > 0) {
          chunkDetails.push({ label: `${chunk.label} (weekly fallback)`, count: subTotal, ms });
          chunksSucceeded++;
          console.log(`[DAYBOOK] ✓ ${chunk.label} (weekly fallback): ${subTotal} vouchers total (${ms}ms)`);
        } else {
          chunksFailed++;
          chunkDetails.push({ label: chunk.label, count: 0, ms });
          if (!subFailed) errors.push(`${chunk.label}: no vouchers from weekly fallback`);
        }
      } else {
        const ms = Date.now() - chunkT0;
        chunksFailed++;
        chunkDetails.push({ label: chunk.label, count: 0, ms });
        errors.push(`${chunk.label}: ${e.message}`);
        console.error(`[DAYBOOK] ✗ ${chunk.label}: ${e.message}`);
      }
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[DAYBOOK] ✓ Total: ${allVouchers.length} vouchers in ${elapsed}s (${chunksSucceeded}/${chunks.length} chunks succeeded)`);

  if (ac.signal.aborted) { activeSyncs.delete(lockKey); return; }

  try {
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
  } catch (e: any) {
    console.error(`[DAYBOOK] Failed to send response: ${e.message}`);
  } finally {
    activeSyncs.delete(lockKey);
  }
});

// Full sync — the main endpoint
app.post("/api/tally/sync", async (req, res) => {
  const { company, fromDate, toDate } = req.body;
  if (!company) return res.status(400).json({ success: false, error: "company required" });

  const lockKey = `${company}_${req.path}`;
  if (activeSyncs.has(lockKey)) {
    console.log(`[SYNC] Duplicate request blocked for ${lockKey}`);
    return res.status(409).json({ success: false, error: "Sync already in progress for this company" });
  }

  // Abort in-flight Tally requests when client disconnects
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) { console.log("[SYNC] Client disconnected — aborting"); ac.abort(); } });

  activeSyncs.set(lockKey, Promise.resolve());
  // 90 min — weekly full-FY can take 60+ min
  res.setTimeout(5_400_000);

  const t0 = Date.now();
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[SYNC] Company: "${company}"`);
  console.log(`[SYNC] Period: ${fromDate || "all"} → ${toDate || "all"}`);
  console.log(`${"=".repeat(60)}`);

  const errors: string[] = [];

  // ── Steps 1-2,5-6: Parallel small masters ──
  console.log(`[SYNC] Steps 1-2,5-6: Fetching small masters in parallel...`);
  const [groupsRes, unitsRes, godownsRes, costCentresRes] = await Promise.allSettled([
    (async () => { const xml = await tallyPostWithRetry(TALLY, stockGroupsXml(company), 30_000, false, 1, ac.signal); return convertStockGroups(xml); })(),
    (async () => { const xml = await tallyPostWithRetry(TALLY, unitsXml(company), 30_000, false, 1, ac.signal); return convertUnits(xml); })(),
    (async () => { const xml = await tallyPostWithRetry(TALLY, godownsXml(company), 30_000, false, 1, ac.signal); return convertGodowns(xml); })(),
    (async () => { const xml = await tallyPostWithRetry(TALLY, costCentresXml(company), 30_000, false, 1, ac.signal); return convertCostCentres(xml); })(),
  ]);

  const groups = groupsRes.status === "fulfilled" ? groupsRes.value : (() => { errors.push(`Stock groups: ${(groupsRes as PromiseRejectedResult).reason?.message}`); return { tallymessage: [] as any[] }; })();
  const units = unitsRes.status === "fulfilled" ? unitsRes.value : (() => { errors.push(`Units: ${(unitsRes as PromiseRejectedResult).reason?.message}`); return { tallymessage: [] as any[] }; })();
  const godowns = godownsRes.status === "fulfilled" ? godownsRes.value : (() => { errors.push(`Godowns: ${(godownsRes as PromiseRejectedResult).reason?.message}`); return { tallymessage: [] as any[] }; })();
  const costCentres = costCentresRes.status === "fulfilled" ? costCentresRes.value : (() => { errors.push(`Cost centres: ${(costCentresRes as PromiseRejectedResult).reason?.message}`); return { tallymessage: [] as any[] }; })();

  console.log(`[SYNC] ✓ Parallel batch: ${groups.tallymessage.length} groups, ${units.tallymessage.length} units, ${godowns.tallymessage.length} godowns, ${costCentres.tallymessage.length} cost centres`);

  // ── Step 3: Stock Items (large — sequential) ──
  let stocks = { tallymessage: [] as any[] };
  if (!ac.signal.aborted) {
    try {
      console.log(`[SYNC] Step 3/7: Fetching stock items...`);
      const xml = await tallyPostWithRetry(TALLY, stockItemsXml(company), 300_000, false, 1, ac.signal);
      stocks = convertStockItems(xml);
      console.log(`[SYNC] ✓ Stock items: ${stocks.tallymessage.length}`);
    } catch (e: any) {
      if (!e.message?.includes("Aborted")) { console.error(`[SYNC] ✗ Stock items failed: ${e.message}`); errors.push(`Stock items: ${e.message}`); }
    }
  }

  // ── Step 4: Ledgers (large — sequential) ──
  let ledgers = { tallymessage: [] as any[] };
  if (!ac.signal.aborted) {
    try {
      console.log(`[SYNC] Step 4/7: Fetching ledgers...`);
      const xml = await tallyPostWithRetry(TALLY, ledgersXml(company), 300_000, false, 1, ac.signal);
      ledgers = convertLedgers(xml);
      console.log(`[SYNC] ✓ Ledgers: ${ledgers.tallymessage.length}`);
    } catch (e: any) {
      if (!e.message?.includes("Aborted")) { console.error(`[SYNC] ✗ Ledgers failed: ${e.message}`); errors.push(`Ledgers: ${e.message}`); }
    }
  }

  // ── Step 7: Vouchers (Monthly Chunking) ──
  const allVouchers: any[] = [];
  const seenGuids = new Set<string>();
  if (fromDate && toDate) {
    const chunks = getMonthlyChunks(fromDate, toDate);
    console.log(`[SYNC] Step 7/7: Fetching vouchers month-by-month (${chunks.length} chunks)...`);

    for (let i = 0; i < chunks.length; i++) {
      if (ac.signal.aborted) { console.log("[SYNC] Aborted — stopping voucher chunk loop"); break; }
      const chunk = chunks[i];
      let chunkDone = false;
      for (let attempt = 0; attempt < 2 && !chunkDone; attempt++) {
        const chunkT0 = Date.now();
        try {
          if (attempt > 0) {
            console.log(`[SYNC]   Retrying ${chunk.label}...`);
            await new Promise(r => setTimeout(r, 2000));
          }
          console.log(`[SYNC]   Chunk ${i + 1}/${chunks.length}: ${chunk.label}...`);
          let vouchers: ReturnType<typeof convertVouchers>;
          // PRIMARY: Collection-based export with reliable TDL date filtering
          try {
            const xml = await tallyPostWithRetry(TALLY, vouchersCollectionXml(company, chunk.from, chunk.to), 120_000, false, 1, ac.signal);
            vouchers = convertVouchers(xml);
            // If Collection returned 0 vouchers, try Day Book fallback
            if (vouchers.tallymessage.length === 0) {
              console.log(`[SYNC]   Collection returned 0 for ${chunk.label}, trying Day Book fallback...`);
              const xml2 = await tallyPostWithRetry(TALLY, vouchersXml(company, chunk.from, chunk.to), 120_000, false, 1, ac.signal);
              const fallback = convertVouchers(xml2);
              // Day Book may ignore dates — verify results are in range before accepting
              if (fallback.tallymessage.length > 0) {
                let inRange = 0;
                for (const v of fallback.tallymessage) {
                  const vDate = String(v.date ?? "").replace(/-/g, "");
                  const vNum = parseInt(vDate, 10);
                  if (vNum && vNum >= parseInt(chunk.from, 10) && vNum <= parseInt(chunk.to, 10)) inRange++;
                }
                if (inRange > 0) {
                  console.log(`[SYNC]   Day Book returned ${fallback.tallymessage.length} vouchers, ${inRange} in date range`);
                  vouchers = fallback;
                } else {
                  console.warn(`[SYNC]   Day Book returned ${fallback.tallymessage.length} vouchers but NONE in range — discarding`);
                }
              }
            }
          } catch (primaryErr: any) {
            if (primaryErr.message?.includes("Aborted")) throw primaryErr;
            console.log(`[SYNC]   Collection failed for ${chunk.label}, trying Day Book fallback...`);
            try {
              const xml2 = await tallyPostWithRetry(TALLY, vouchersXml(company, chunk.from, chunk.to), 120_000, false, 1, ac.signal);
              vouchers = convertVouchers(xml2);
            } catch (fallbackErr: any) {
              throw new Error(`Both Collection and Day Book export failed for ${chunk.label}: ${primaryErr.message} / ${fallbackErr.message}`);
            }
          }

          let added = 0;
          for (const v of vouchers.tallymessage) {
            const guid = v.guid || v.GUID || "";
            if (guid && seenGuids.has(guid)) continue;
            if (guid) seenGuids.add(guid);
            allVouchers.push(v);
            added++;
          }
          const dupes = vouchers.tallymessage.length - added;
          if (dupes > 0) console.log(`[SYNC]   Deduped: ${dupes} duplicate vouchers skipped in ${chunk.label}`);
          chunkDone = true;
          console.log(`[SYNC]   ✓ ${chunk.label}: ${added} vouchers (${Date.now() - chunkT0}ms)`);
        } catch (e: any) {
          if (attempt === 1) {
            console.error(`[SYNC]   ✗ ${chunk.label}: ${e.message} (gave up after 2 attempts)`);
            errors.push(`Vouchers ${chunk.label}: ${e.message}`);
          }
        }
      }
    }
    console.log(`[SYNC] ✓ Total vouchers: ${allVouchers.length}`);
  } else {
    console.log(`[SYNC] Step 7/7: Skipped — no date range provided`);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const stats = {
    stockGroups: groups.tallymessage.length,
    units: units.tallymessage.length,
    stockItems: stocks.tallymessage.length,
    ledgers: ledgers.tallymessage.length,
    godowns: godowns.tallymessage.length,
    costCentres: costCentres.tallymessage.length,
    vouchers: allVouchers.length,
    elapsedSeconds: parseFloat(elapsed),
  };

  console.log(`[SYNC] Done in ${elapsed}s: ${stats.stockGroups} groups, ${stats.units} units, ${stats.stockItems} items, ${stats.ledgers} ledgers, ${stats.godowns} godowns, ${stats.costCentres} cost centres, ${stats.vouchers} vouchers`);
  if (errors.length > 0) console.log(`[SYNC] Errors: ${errors.join("; ")}`);

  const hasData = stats.stockItems > 0 || stats.ledgers > 0 || stats.vouchers > 0;

  if (ac.signal.aborted) { activeSyncs.delete(lockKey); return; }

  try {
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
          ...godowns.tallymessage,
          ...costCentres.tallymessage,
        ],
      },
      transactions: { tallymessage: allVouchers },
      stats,
    });
  } catch (e: any) {
    console.error(`[SYNC] Failed to send response: ${e.message}`);
  } finally {
    activeSyncs.delete(lockKey);
  }
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

app.get("/api/tally/debug/raw", (_req, res) => {
  if (!lastRawXml) return res.json({ stored: false, message: "No raw XML captured yet. Use POST /api/tally/debug/raw-test to capture one." });
  res.json({ stored: true, ...lastRawXml });
});

app.post("/api/tally/debug/raw-test", async (req, res) => {
  const { company, test } = req.body;
  if (!company) return res.status(400).json({ error: "company required" });

  let xml = HEALTH_XML;
  if (test === "stock") xml = stockItemsXml(company);
  else if (test === "ledger") xml = ledgersXml(company);
  else if (test === "voucher") xml = vouchersXml(company, "20250401", "20250430");
  else if (test === "groups") xml = stockGroupsXml(company);
  else if (test === "units") xml = unitsXml(company);
  else if (test === "godowns") xml = godownsXml(company);
  else if (test === "costcentres") xml = costCentresXml(company);

  try {
    const raw = await tallyPost(TALLY, xml, 60_000, true);
    lastRawXml = {
      request: xml,
      response: typeof raw === "string" ? raw.slice(0, 50_000) : JSON.stringify(raw).slice(0, 50_000),
      timestamp: new Date().toISOString(),
      label: test || "health",
    };
    res.json({ success: true, responseLength: raw.length, preview: typeof raw === "string" ? raw.slice(0, 3000) : "parsed" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Sales Module - Tally Import Endpoint
app.post("/api/tally/import", express.text({ type: "application/xml" }), async (req, res) => {
  try {
    if (!req.body) {
      return res.status(400).json({ error: "XML body required" });
    }

    const xml = typeof req.body === "string" ? req.body : JSON.stringify(req.body);

    // Store request for debugging
    lastRawXml = {
      request: xml,
      response: "",
      timestamp: new Date().toISOString(),
      label: "import-voucher",
    };

    // Forward to Tally
    const response = await tallyPost(TALLY, xml, 30_000, true);
    const responseText = typeof response === "string" ? response : JSON.stringify(response);

    // Store response for debugging
    lastRawXml.response = responseText.slice(0, 50_000);

    // Try to parse and extract result status
    const isSuccess = responseText.toLowerCase().includes("successfully");

    res.setHeader("Content-Type", "application/xml");
    res.status(isSuccess ? 200 : 400).send(responseText);
  } catch (e: any) {
    console.error("Tally import error:", e.message);
    res.status(500).json({
      error: e.message,
      message: "Failed to import invoice to Tally"
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n✓ MKCP Tally Proxy → http://localhost:${PORT}`);
  console.log(`   Target: ${TALLY}\n`);
});

declare global { namespace Express { interface Request { tallyUrl: string } } }
