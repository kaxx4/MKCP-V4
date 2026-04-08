import express from "express";
import cors from "cors";
import { tallyPost, HEALTH_XML } from "./tally.js";
import { convertCompanies } from "./converters/convert.js";
import { SyncOrchestrator } from "./services/syncOrchestrator.js";
import { ChangeDetector } from "./services/changeDetector.js";
import { pushVoucherToTally, pushBatchToTally } from "./services/voucherPusher.js";
import type { SyncPlan, PushVoucherRequest, PushBatchRequest } from "./types.js";

const app = express();
const PORT = 3100;
const TALLY = process.env.TALLY_URL || "http://localhost:9000";

// Singletons
const changeDetector = new ChangeDetector();
const orchestrator = new SyncOrchestrator(TALLY, changeDetector);

// Duplicate sync lock
const activeSyncs = new Map<string, Promise<any>>();

app.use(cors());
app.use(express.json({ limit: "100mb" }));

// ── Log buffer + SSE streaming ────────────────────────────────────────────────
const logBuffer: string[] = [];
const MAX_LOGS = 500;
let lastRawXml: { request: string; response: string; timestamp: string; label: string } | null = null;

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

// ── Middleware: duplicate sync guard ─────────────────────────────────────────
function syncGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  const company = req.body?.company;
  if (!company) return res.status(400).json({ success: false, error: "company required" });
  const lockKey = `${company}_${req.path}`;
  if (activeSyncs.has(lockKey)) {
    return res.status(409).json({ success: false, error: "Sync already in progress for this company" });
  }
  activeSyncs.set(lockKey, Promise.resolve());
  res.on("finish", () => activeSyncs.delete(lockKey));
  res.on("close", () => activeSyncs.delete(lockKey));
  next();
}

// ── Root — Live log viewer ─────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html><html><head><title>MKCP Tally Proxy</title><meta charset="utf-8">
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Consolas,monospace;background:#0d1117;color:#c9d1d9;padding:20px}
h1{color:#58a6ff;margin-bottom:10px}#logs{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:16px;height:calc(100vh - 100px);overflow-y:auto;font-size:13px;line-height:1.6}
.log-line{margin:2px 0;white-space:pre-wrap}.success{color:#3fb950}.error{color:#f85149}.warn{color:#d29922}</style></head>
<body><h1>🔌 MKCP Tally Proxy → ${TALLY}</h1><div id="logs"></div>
<script>const l=document.getElementById('logs');let last=0,auto=true;l.addEventListener('scroll',()=>{auto=l.scrollHeight-l.scrollTop<=l.clientHeight+50});
setInterval(async()=>{const r=await fetch('/api/tally/logs');const d=await r.json();l.innerHTML=d.map(x=>{let c='log-line';if(x.includes('✓'))c+=' success';else if(x.includes('✗')||x.includes('❌'))c+=' error';else if(x.includes('⚠'))c+=' warn';const e=document.createElement('div');e.textContent=x;return'<div class="'+c+'">'+e.innerHTML+'</div>'}).join('');if(auto)l.scrollTop=l.scrollHeight},500);</script></body></html>`);
});

// ── Utility endpoints ──────────────────────────────────────────────────────────
app.get("/api/tally/logs", (_req, res) => res.json(logBuffer));

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
  req.on("close", () => clearInterval(interval));
});

app.get("/api/tally/health", async (_req, res) => {
  try {
    await tallyPost(TALLY, HEALTH_XML, 10_000);
    res.json({ connected: true, tallyUrl: TALLY });
  } catch (e: any) {
    res.json({ connected: false, error: e.message, tallyUrl: TALLY });
  }
});

app.get("/api/tally/company", async (_req, res) => {
  try {
    const parsed = await tallyPost(TALLY, HEALTH_XML, 10_000);
    const companies = convertCompanies(parsed);
    res.json({ success: true, companies, current: companies[0]?.name ?? null });
  } catch (e: any) {
    res.json({ success: false, error: e.message, companies: [], current: null });
  }
});

// ── Sync endpoints ─────────────────────────────────────────────────────────────
app.post("/api/tally/sync", syncGuard, async (req, res) => {
  const { company, fromDate, toDate, mode = "full", chunkStrategy = "smart" } = req.body;
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });
  res.setTimeout(5_400_000);

  const plan: SyncPlan = {
    company, fromDate: fromDate ?? "", toDate: toDate ?? "",
    mode, chunkStrategy, signal: ac.signal,
  };

  try {
    const result = await orchestrator.syncAll(plan, (p) => {
      console.log(`[SYNC] ${p.phase} ${p.step}/${p.totalSteps}: ${p.detail}`);
    });
    if (!res.writableEnded) res.json(result);
  } catch (e: any) {
    if (!res.writableEnded) res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/tally/sync-masters", syncGuard, async (req, res) => {
  const { company } = req.body;
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });
  res.setTimeout(1_200_000);

  try {
    const result = await orchestrator.syncMastersOnly(company, ac.signal, (p) => {
      console.log(`[MASTERS] ${p.step}/${p.totalSteps}: ${p.detail}`);
    });
    if (!res.writableEnded) res.json(result);
  } catch (e: any) {
    if (!res.writableEnded) res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/tally/sync-daybook", syncGuard, async (req, res) => {
  const { company, fromDate, toDate, chunkMode = "smart" } = req.body;
  if (!fromDate || !toDate) return res.status(400).json({ success: false, error: "fromDate and toDate required (YYYYMMDD)" });
  if (fromDate.length !== 8 || toDate.length !== 8) return res.status(400).json({ success: false, error: "Invalid date format — expected YYYYMMDD" });

  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });
  res.setTimeout(5_400_000);

  const strategy: "smart" | "monthly" | "weekly" | "daily" =
    ["smart","monthly","weekly","daily"].includes(chunkMode) ? chunkMode : "smart";

  try {
    const result = await orchestrator.syncVouchersOnly(company, fromDate, toDate, strategy, ac.signal, (p) => {
      console.log(`[DAYBOOK] ${p.step}/${p.totalSteps}: ${p.detail}`);
    });
    if (!res.writableEnded) res.json(result);
  } catch (e: any) {
    if (!res.writableEnded) res.status(500).json({ success: false, error: e.message });
  }
});

// ── Voucher push endpoints ─────────────────────────────────────────────────────
app.post("/api/tally/push-voucher", async (req: express.Request, res: express.Response) => {
  const { company, voucher } = req.body as PushVoucherRequest;
  if (!company) return res.status(400).json({ success: false, error: "company required" });
  if (!voucher) return res.status(400).json({ success: false, error: "voucher payload required" });
  try {
    const result = await pushVoucherToTally(TALLY, company, voucher);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ success: false, created: 0, errors: 1, lineErrors: [e.message], rawResponse: "" });
  }
});

app.post("/api/tally/push-batch", async (req: express.Request, res: express.Response) => {
  const { company, vouchers } = req.body as PushBatchRequest;
  if (!company) return res.status(400).json({ success: false, error: "company required" });
  if (!Array.isArray(vouchers) || vouchers.length === 0) return res.status(400).json({ success: false, error: "vouchers array required" });
  try {
    const result = await pushBatchToTally(TALLY, company, vouchers);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Legacy raw import endpoint (backward compat) ───────────────────────────────
app.post("/api/tally/import", express.text({ type: "application/xml" }), async (req, res) => {
  try {
    const xml = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    lastRawXml = { request: xml, response: "", timestamp: new Date().toISOString(), label: "import-voucher" };
    const response = await tallyPost(TALLY, xml, 30_000, true);
    const responseText = typeof response === "string" ? response : JSON.stringify(response);
    lastRawXml.response = responseText.slice(0, 50_000);
    res.setHeader("Content-Type", "application/xml");
    res.status(200).send(responseText);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Debug endpoints ─────────────────────────────────────────────────────────────
app.post("/api/tally/debug", async (req, res) => {
  const { company, xml: customXml } = req.body;
  if (!company && !customXml) return res.status(400).json({ error: "company or xml required" });
  try {
    const xml = customXml ?? HEALTH_XML;
    const raw = await tallyPost(TALLY, xml, 60_000, true);
    res.json({ success: true, responseLength: raw.length, responsePreview: raw.slice(0, 3000) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/tally/debug/raw", (_req, res) => {
  res.json(lastRawXml ?? { stored: false });
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✓ MKCP Tally Proxy → http://localhost:${PORT}`);
  console.log(`   Target: ${TALLY}\n`);
});
