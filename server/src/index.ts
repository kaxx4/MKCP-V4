import "dotenv/config";
import express from "express";
import cors from "cors";
import { tallyPost, HEALTH_XML } from "./tally.js";
import { convertCompanies } from "./converters/convert.js";
import { SyncOrchestrator } from "./services/syncOrchestrator.js";
import { ChangeDetector } from "./services/changeDetector.js";
import { SupabaseSync } from "./services/supabaseSync.js";
import { startPushAgent, getPushAgentStatus, drainNow, getAgentClient } from "./services/pushAgent.js";
import { beginTallyWork, endTallyWork, isTallyBusy } from "./services/tallyBusy.js";
import { startRefreshListener } from "./services/refreshListener.js";
import { startPushListener, listPendingPushes, approvePush, rejectPush } from "./services/pushListener.js";
import { startNightlySync } from "./services/nightlySync.js";
import {
  startFileTransferSync, pushFileToWeb, listRecentTransfers,
  startWatchFolder, watchFolderStatus,
} from "./services/fileTransferSync.js";
import type { SyncPlan } from "./types.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3100", 10);
const TALLY = process.env.TALLY_URL || "http://localhost:9000";

// Singletons
const changeDetector = new ChangeDetector();
const orchestrator = new SyncOrchestrator(TALLY, changeDetector);
const supabaseSync = new SupabaseSync();

// Duplicate sync lock
const activeSyncs = new Map<string, Promise<any>>();

app.use(cors());
app.use(express.json({ limit: "100mb" }));

// ── Request logging ───────────────────────────────────────────────────────────
// One line per request, emitted on "finish" so it carries the real status code
// and elapsed time. Goes through console.log (below) so it lands in logBuffer —
// same stream the root log viewer and AgentStatus.tsx's Logs panel already read,
// no second logging path.
app.use((req, res, next) => {
  const start = Date.now();
  const company = req.body?.company;
  res.on("finish", () => {
    const elapsed = Date.now() - start;
    console.log(`[REQ] ${req.method} ${req.path}${company ? ` company=${company}` : ""} status=${res.statusCode} ${elapsed}ms`);
  });
  next();
});

// ── Log buffer + SSE streaming ────────────────────────────────────────────────
const logBuffer: string[] = [];
const MAX_LOGS = 500;
const TRIM_AT = 600; // trim back to MAX in a single splice once we exceed this
let lastRawXml: { request: string; response: string; timestamp: string; label: string } | null = null;

// Push + amortized trim: instead of an O(n) Array.shift() on EVERY log line once at
// cap (O(n²) during a chatty sync), let the buffer grow to TRIM_AT then drop the
// oldest 100 in one splice — same "keep ~most-recent MAX lines" behavior, O(1) amortized.
function pushLog(line: string) {
  logBuffer.push(line);
  if (logBuffer.length >= TRIM_AT) logBuffer.splice(0, logBuffer.length - MAX_LOGS);
}

const originalLog = console.log;
const originalError = console.error;
console.log = (...args: any[]) => {
  const msg = args.join(" ");
  pushLog(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
  originalLog(...args);
};
console.error = (...args: any[]) => {
  const msg = args.join(" ");
  pushLog(`[${new Date().toISOString().slice(11, 19)}] ❌ ${msg}`);
  originalError(...args);
};

// ── Middleware: duplicate sync guard ─────────────────────────────────────────
function syncGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  const company = req.body?.company;
  if (!company) return res.status(400).json({ success: false, error: "company required" });
  // One lock per company (not per company+path): all /api/tally/* sync routes
  // share Tally's single-threaded XML port, so two different routes for the
  // same company must serialize too, not just two calls to the same route.
  const lockKey = `${company}`;
  if (activeSyncs.has(lockKey)) {
    const origin = req.body?.origin || "manual";
    console.log(`[SYNC] ✗ rejected (already in progress) origin=${origin} company=${company}`);
    return res.status(409).json({ success: false, error: "Sync already in progress for this company" });
  }
  activeSyncs.set(lockKey, Promise.resolve());
  // Mark Tally as busy so health pings skip the (now-saturated) port until done.
  beginTallyWork();
  let released = false;
  const release = () => { if (released) return; released = true; activeSyncs.delete(lockKey); endTallyWork(); };
  res.on("finish", release);
  res.on("close", release);
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
  // A sync in flight IS proof Tally is reachable. Skip the ping so it doesn't
  // queue behind the sync on Tally's single-threaded port and time out (which
  // would flap the connected indicator and spam errors).
  if (isTallyBusy()) {
    return res.json({ connected: true, tallyUrl: TALLY, busy: true });
  }
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
  res.setTimeout(0); // No server socket timeout: a finite ceiling destroys the socket mid-sync → res.on("close") → ac.abort() → truncated upload. Per-chunk (orchestrator) + client (postTallySync 2h / browser) timeouts bound it.

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
  const { company, origin = "manual" } = req.body;
  const t0 = Date.now();
  console.log(`[SYNC] origin=${origin} company=${company} route=sync-masters`);
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });
  res.setTimeout(0); // No server socket timeout (see /api/tally/sync) — avoids destroying the socket mid-sync.

  try {
    const result = await orchestrator.syncMastersOnly(company, ac.signal, (p) => {
      console.log(`[MASTERS] ${p.step}/${p.totalSteps}: ${p.detail}`);
    });
    if (!res.writableEnded) res.json(result);
    console.log(`[SYNC] ✓ origin=${origin} company=${company} route=sync-masters items=${result.stats?.stockItems ?? 0} ledgers=${result.stats?.ledgers ?? 0} ${Date.now() - t0}ms`);
  } catch (e: any) {
    if (!res.writableEnded) res.status(500).json({ success: false, error: e.message });
    console.log(`[SYNC] ✗ origin=${origin} company=${company} route=sync-masters error="${e.message}" ${Date.now() - t0}ms`);
  }
});

app.post("/api/tally/sync-daybook", syncGuard, async (req, res) => {
  const { company, fromDate, toDate, chunkMode = "smart", origin = "manual" } = req.body;
  if (!fromDate || !toDate) return res.status(400).json({ success: false, error: "fromDate and toDate required (YYYYMMDD)" });
  if (fromDate.length !== 8 || toDate.length !== 8) return res.status(400).json({ success: false, error: "Invalid date format — expected YYYYMMDD" });

  const t0 = Date.now();
  console.log(`[SYNC] origin=${origin} company=${company} route=sync-daybook range=${fromDate}-${toDate}`);

  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });
  res.setTimeout(0); // No server socket timeout: a finite ceiling destroys the socket mid-sync → res.on("close") → ac.abort() → truncated upload. Per-chunk (orchestrator) + client (postTallySync 2h / browser) timeouts bound it.

  const strategy: "smart" | "monthly" | "weekly" | "daily" =
    ["smart","monthly","weekly","daily"].includes(chunkMode) ? chunkMode : "smart";

  try {
    const result = await orchestrator.syncVouchersOnly(company, fromDate, toDate, strategy, ac.signal, (p) => {
      console.log(`[DAYBOOK] ${p.step}/${p.totalSteps}: ${p.detail}`);
    });
    if (!res.writableEnded) res.json(result);
    console.log(`[SYNC] ✓ origin=${origin} company=${company} route=sync-daybook vouchers=${result.stats?.vouchers ?? 0} ${Date.now() - t0}ms`);
  } catch (e: any) {
    if (!res.writableEnded) res.status(500).json({ success: false, error: e.message });
    console.log(`[SYNC] ✗ origin=${origin} company=${company} route=sync-daybook error="${e.message}" ${Date.now() - t0}ms`);
  }
});

// Incremental: fetch vouchers edited since a given AlterID watermark (any date),
// so edits to OLD vouchers outside the daybook window still propagate.
app.post("/api/tally/changed-vouchers", syncGuard, async (req, res) => {
  const { company, sinceAlterId } = req.body as { company?: string; sinceAlterId?: number };
  if (!company) return res.status(400).json({ success: false, error: "company required" });
  const since = Number(sinceAlterId) || 0;

  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });
  res.setTimeout(0); // No server socket timeout: a finite ceiling destroys the socket mid-sync → res.on("close") → ac.abort() → truncated upload. Per-chunk (orchestrator) + client (postTallySync 2h / browser) timeouts bound it.

  try {
    const converted = await orchestrator.syncChangedVouchers(company, since, ac.signal);
    if (!res.writableEnded) {
      res.json({ success: true, data: converted, stats: { vouchers: converted.tallymessage.length, sinceAlterId: since } });
    }
  } catch (e: any) {
    if (!res.writableEnded) res.status(500).json({ success: false, error: e.message });
  }
});

// ── Supabase sync endpoint ─────────────────────────────────────────────────────
// Masters (items/ledgers) only. Vouchers are deliberately NOT accepted here as
// a routine path: this used to be a pure unguarded upsert with no pruning
// metadata, so if the caller's local copy still held a voucher Tally (and the
// orchestrator's per-day-pruned sync-daybook push) had already deleted, this
// endpoint re-inserted exactly what was just pruned, every cycle. Vouchers now
// only ever reach Supabase via that per-day-pruned path. The `vouchers` field
// is still accepted for backward compatibility with any caller that explicitly
// sends it (graceful no-op otherwise) — as of this fix, pushAll (the only
// caller found repo-wide) no longer sends it.
app.post("/api/supabase/sync", async (req: express.Request, res: express.Response) => {
  const { company, items = [], ledgers = [], vouchers } = req.body;
  if (!company) return res.status(400).json({ success: false, error: "company required" });

  const hasVouchers = Array.isArray(vouchers) && vouchers.length > 0;

  try {
    console.log(`[Supabase] Manual sync initiated: ${items.length} items, ${ledgers.length} ledgers${hasVouchers ? `, ${vouchers.length} vouchers (explicit caller)` : ""}`);
    // Build master messages from frontend data
    const masterMessages = [
      ...items.map((item: any) => ({
        name: item.name,
        guid: item.itemId,
        metadata: { type: "Stock Item" },
        parent: item.group || "Primary",
        gstapplicable: item.gstRate ?? 0,
      })),
      ...ledgers.map((ledger: any) => ({
        name: ledger.name,
        guid: ledger.ledgerId,
        metadata: { type: "Ledger" },
        parent: ledger.parent || "Unsorted",
      })),
    ];

    // Sync masters
    if (masterMessages.length > 0) {
      await supabaseSync.syncMasters(masterMessages, company);
    }

    // Vouchers: only if the caller explicitly sent a non-empty array (see
    // route comment above — not exercised by any current caller).
    let voucherCount = 0;
    if (hasVouchers) {
      const voucherMessages = vouchers.map((v: any) => ({
        guid: v.voucherId,
        metadata: { type: "Voucher" },
        vouchertypename: v.voucherType,
        vouchernumber: v.voucherNumber,
        date: v.date,
        partyledgername: v.partyName,
        allledgerentries: v.lines
          .filter((l: any) => l.type === "ledger")
          .map((l: any) => ({
            ledgername: l.name,
            isdeemedpositive: l.isDebit,
            ispartyledger: false,
            amount: l.amount,
          })),
        // BUGFIX (2026-05-19): canonical line type is "inventory", not "stock".
        // Before this fix, every voucher pushed via /api/supabase/sync was stripped
        // of its inventory entries — that's why Delivery Notes and most older
        // vouchers showed up in the web dashboard with no item lines.
        allinventoryentries: v.lines
          .filter((l: any) => l.type === "inventory")
          .map((l: any) => ({
            stockitemname: l.itemId ?? l.name,
            actualqty: l.qtyBase ?? l.qty,
            billedqty: l.qtyBase ?? l.qty,
            rate: l.ratePerBase ?? l.rate,
            amount: l.lineAmount ?? l.amount,
            isdeemedpositive: l.isDebit ?? false,
          })),
      }));
      voucherCount = voucherMessages.length;
      await supabaseSync.syncVouchers(voucherMessages, company);
    }

    console.log(`[Supabase] Manual sync completed successfully`);
    res.json({
      success: true,
      message: `Synced ${masterMessages.length} masters${hasVouchers ? ` and ${voucherCount} vouchers` : ""} to Supabase`,
      itemsCount: items.length,
      ledgersCount: ledgers.length,
      vouchersCount: voucherCount,
    });
  } catch (e: any) {
    console.error(`[Supabase] Manual sync failed: ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Supabase config sync (all dashboard-edited data) ────────────────────────────
app.post("/api/supabase/sync-config", async (req: express.Request, res: express.Response) => {
  const {
    company = "M.K.CYCLES (P) LTD.",
    discountRules = [],
    orderGroups = [],
    unitOverrides = {},
    rateOverrides = [],
    gstOverrides = {},
    itemCategoryOverrides = {},
    categoryColors = {},
    vendorGroupAssignments = {},
    itemNotes = {},
    callingList = [],
    tallyPriceListImports = {},
    tallyPriceListImportedAt = null,
    voucherOverrides = {},
    appSettings = {},
    orderDraftLines = [],
  } = req.body;

  try {
    console.log(
      `[Supabase] Config sync initiated: ${discountRules.length} rules, ${orderGroups.length} groups, ` +
      `${Object.keys(unitOverrides).length} units, ${rateOverrides.length} rates, ` +
      `${Object.keys(itemCategoryOverrides).length} cat overrides, ${Object.keys(categoryColors).length} colors, ` +
      `${Object.keys(vendorGroupAssignments).length} vendor assignments, ${Object.keys(itemNotes).length} notes, ` +
      `${callingList.length} calling entries, ${Object.keys(tallyPriceListImports).length} tally prices`
    );
    // Sync each table in parallel — Promise.allSettled means one failure doesn't break others.
    // Each entry is labeled so we can report exactly which table failed.
    const syncTasks: Array<{ label: string; promise: Promise<void> }> = [
      // discount_rules & order_groups are WEB-OWNED (web always holds priority).
      // The desktop must not write them: its writer uses the old normalized
      // schema and calls deleteOrphans, which would overwrite/delete rules the
      // web created. These are intentionally skipped here so the web remains the
      // single source of truth. See web migration 0021_discount_order_web_owned.sql.
      { label: "unit_overrides", promise: Object.keys(unitOverrides).length > 0 ? supabaseSync.syncUnitOverrides(unitOverrides, company) : Promise.resolve() },
      { label: "rate_overrides", promise: rateOverrides.length > 0 ? supabaseSync.syncRateOverrides(rateOverrides, company) : Promise.resolve() },
      { label: "gst_overrides", promise: Object.keys(gstOverrides).length > 0 ? supabaseSync.syncGstOverrides(gstOverrides, company) : Promise.resolve() },
      { label: "item_category_overrides", promise: Object.keys(itemCategoryOverrides).length > 0 ? supabaseSync.syncItemCategoryOverrides(itemCategoryOverrides, company) : Promise.resolve() },
      { label: "category_colors", promise: Object.keys(categoryColors).length > 0 ? supabaseSync.syncCategoryColors(categoryColors, company) : Promise.resolve() },
      { label: "vendor_group_assignments", promise: Object.keys(vendorGroupAssignments).length > 0 ? supabaseSync.syncVendorGroupAssignments(vendorGroupAssignments, company) : Promise.resolve() },
      { label: "item_notes", promise: Object.keys(itemNotes).length > 0 ? supabaseSync.syncItemNotes(itemNotes, company) : Promise.resolve() },
      { label: "calling_list_entries", promise: callingList.length > 0 ? supabaseSync.syncCallingList(callingList, company) : Promise.resolve() },
      { label: "tally_price_list_imports", promise: Object.keys(tallyPriceListImports).length > 0 ? supabaseSync.syncTallyPriceListImports(tallyPriceListImports, tallyPriceListImportedAt, company) : Promise.resolve() },
      { label: "voucher_overrides", promise: Object.keys(voucherOverrides).length > 0 ? supabaseSync.syncVoucherOverrides(voucherOverrides, company) : Promise.resolve() },
      { label: "app_settings", promise: Object.keys(appSettings).length > 0 ? supabaseSync.syncAppSettings(appSettings, company) : Promise.resolve() },
      // order_draft_lines always fires — empty array means "clear the cloud draft"
      { label: "order_draft_lines", promise: supabaseSync.syncOrderDraftLines(orderDraftLines, company) },
    ];

    // Run sync tasks sequentially — firing 14 tasks in parallel overwhelms Supabase's
    // connection pool (~15 slots) causing "TypeError: fetch failed" on the overflow.
    const results: PromiseSettledResult<void>[] = [];
    for (const task of syncTasks) {
      results.push(await Promise.allSettled([task.promise]).then(r => r[0]));
    }

    const errors = results
      .map((r, i) => ({ r, label: syncTasks[i].label }))
      .filter(({ r }) => r.status === "rejected")
      .map(({ r, label }) => `${label}: ${(r as PromiseRejectedResult).reason?.message || String((r as PromiseRejectedResult).reason)}`);

    if (errors.length > 0) {
      // Surface each failing table in the log buffer (console.error → ❌ in the
      // Logs panel) so the exact failure is visible for debugging, not just a count.
      for (const e of errors) console.error(`[Supabase] Config sync error → ${e}`);
    }
    console.log(`[Supabase] Config sync completed (${errors.length} error${errors.length === 1 ? "" : "s"})`);
    res.json({
      success: true,
      message: "Configuration data synced to Supabase",
      // discount_rules & order_groups are web-owned and intentionally not written
      // by the desktop, so report 0 written regardless of what was received.
      discountRulesCount: 0,
      orderGroupsCount: 0,
      unitOverridesCount: Object.keys(unitOverrides).length,
      rateOverridesCount: rateOverrides.length,
      gstOverridesCount: Object.keys(gstOverrides).length,
      itemCategoryOverridesCount: Object.keys(itemCategoryOverrides).length,
      categoryColorsCount: Object.keys(categoryColors).length,
      vendorGroupAssignmentsCount: Object.keys(vendorGroupAssignments).length,
      itemNotesCount: Object.keys(itemNotes).length,
      callingListCount: callingList.length,
      tallyPriceListImportsCount: Object.keys(tallyPriceListImports).length,
      voucherOverridesCount: Object.keys(voucherOverrides).length,
      appSettingsCount: Object.keys(appSettings).length,
      orderDraftLinesCount: orderDraftLines.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (e: any) {
    console.error(`[Supabase] Config sync failed: ${e.message}`);
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

// ── Web voucher pushes (awaiting approval on THIS machine) ──────────────────────
// The web dashboard queues a voucher; nothing reaches Tally until it is
// approved here. The renderer polls this the same way it polls /progress.
app.get("/api/tally/pending-pushes", (_req, res) => {
  res.json(listPendingPushes());
});

app.post("/api/tally/pending-pushes/:id/approve", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
  const result = await approvePush(id);
  // 200 with ok:false — Tally rejecting a voucher is an ANSWER, not a
  // transport failure, and the UI needs the message either way.
  res.status(200).json(result);
});

app.post("/api/tally/pending-pushes/:id/reject", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
  res.status(200).json(await rejectPush(id));
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

// ── NIC e-Waybill distance proxy ───────────────────────────────────────────────
app.get("/api/distance", async (req, res) => {
  const { from = "700001", to } = req.query as { from?: string; to?: string };
  if (!to || !/^\d{6}$/.test(to)) return res.status(400).json({ error: "Valid 6-digit 'to' pincode required" });
  if (!/^\d{6}$/.test(from)) return res.status(400).json({ error: "Valid 6-digit 'from' pincode required" });
  try {
    const url = `https://ewaybillgst.gov.in/apipre/api/v1.0/Distance/pincode?srcpincode=${from}&dstpincode=${to}`;
    const response = await fetch(url, {
      headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`NIC API ${response.status}`);
    const data = await response.json() as any;
    const distance: number | null = data?.data?.distance ?? data?.distance ?? null;
    console.log(`[DISTANCE] ${from} → ${to}: ${distance} km`);
    res.json({ distance, from, to });
  } catch (e: any) {
    console.error(`[DISTANCE] ${from} → ${to} failed: ${e.message}`);
    res.status(502).json({ error: e.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
const httpServer = app.listen(PORT, () => {
  console.log(`\n✓ MKCP Tally Proxy → http://localhost:${PORT}`);
  console.log(`   Target: ${TALLY}\n`);

  // Remote refresh: web dashboard can trigger a Tally sync via Supabase Realtime.
  // Reads company name from env so it matches whatever the web inserted.
  const company =
    process.env.TALLY_COMPANY || "M.K.CYCLES (P) LTD. - (from 1-Apr-26)";
  startRefreshListener(PORT, company);

  // Voucher pushes FROM the web dashboard. Separate listener, separate table,
  // separate endpoints — the refresh path above is untouched by it on purpose.
  startPushListener(company, TALLY);

  // Nightly automatic full-FY sync at 00:00 local (configurable via NIGHTLY_SYNC_*).
  startNightlySync(PORT, company);

  // Two-way file handoff with the web dashboard (see server/src/services/fileTransferSync.ts).
  startFileTransferSync();
  // Outbound half: anything dropped in the watch folder is sent up automatically.
  startWatchFolder(company);
});

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    // Port already occupied — log but do NOT crash Electron (we run in the main process)
    console.error(`❌ Port ${PORT} already in use — server did not start. Close any other instance and restart.`);
  } else {
    console.error(`❌ Server error: ${err.message}`);
  }
});

// ── Push-Queue Drain Agent (additive — Prompt 3) ─────────────────────────────────
// Status route for the strip-down status UI (Prompt 4). Always available; reports
// `enabled:false` when the agent isn't running.
app.get("/api/push-agent/status", (_req, res) => res.json(getPushAgentStatus()));

// Trigger an immediate drain tick from the status window's "Drain Now" button.
app.post("/api/push-agent/drain", (_req, res) => {
  drainNow();
  res.json({ ok: true, drainedAt: new Date().toISOString() });
});

// Re-queue a failed push_queue row so it can be retried immediately.
// Only requeues rows with status='failed' — succeeded rows are immutable.
app.post("/api/push-agent/requeue", async (req: express.Request, res: express.Response) => {
  const { id } = req.body as { id?: string };
  if (!id) return res.status(400).json({ error: "id required" });
  const client = getAgentClient();
  if (!client) return res.status(503).json({ error: "Push agent not running (no Supabase client)" });
  const { error } = await client
    .from("push_queue")
    .update({ status: "pending", attempts: 0, not_before: new Date().toISOString(), last_error: null })
    .eq("id", id)
    .eq("status", "failed");
  if (error) return res.status(500).json({ error: error.message });
  drainNow();
  res.json({ ok: true });
});

// Start the drain loop only when explicitly enabled, so it can be turned off without
// a code change.
if (process.env.PUSH_AGENT_ENABLED === "true") {
  startPushAgent({ tallyUrl: TALLY });
}

// ── File transfer (web ↔ desktop) ────────────────────────────────────────────
// Incoming (web -> desktop) is handled entirely by fileTransferSync's own
// Realtime listener (started above) -- these two routes cover the AgentStatus
// UI's read (status panel) and the outgoing (desktop -> web) push, which needs
// a local file path picked via a native dialog in the renderer first.
app.get("/api/file-transfer/status", async (req, res) => {
  const company = String(req.query.company || process.env.TALLY_COMPANY || "");
  if (!company) return res.status(400).json({ error: "company query param required" });
  const rows = await listRecentTransfers(company);
  res.json({ rows });
});

app.get("/api/file-transfer/watch", (_req, res) => {
  res.json(watchFolderStatus());
});

/** Restart the watcher after the operator picks a different folder — the env
 *  var is updated in-process by electron.js, but chokidar has already bound
 *  to the old path and has to be rebuilt. */
app.post("/api/file-transfer/watch/restart", (req: express.Request, res: express.Response) => {
  const company =
    String(req.body?.company || process.env.TALLY_COMPANY || "M.K.CYCLES (P) LTD. - (from 1-Apr-26)");
  const result = startWatchFolder(company);
  res.status(result.ok ? 200 : 400).json(result);
});

app.post("/api/file-transfer/push", async (req: express.Request, res: express.Response) => {
  const { company, filePath, note } = req.body as { company?: string; filePath?: string; note?: string };
  if (!company || !filePath) return res.status(400).json({ error: "company and filePath required" });
  try {
    const result = await pushFileToWeb(company, filePath, note || null);
    res.json({ ok: true, id: result.id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
