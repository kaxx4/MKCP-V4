import "dotenv/config";
import express from "express";
import cors from "cors";
import { tallyPost, HEALTH_XML } from "./tally.js";
import { convertCompanies } from "./converters/convert.js";
import { SyncOrchestrator } from "./services/syncOrchestrator.js";
import { ChangeDetector } from "./services/changeDetector.js";
import { SupabaseSync } from "./services/supabaseSync.js";
import { pushVoucherToTally, pushBatchToTally, buildVoucherImportXml, parseImportResponse } from "./services/voucherPusher.js";
import { startPushAgent, getPushAgentStatus } from "./services/pushAgent.js";
import type { SyncPlan, PushVoucherRequest, PushBatchRequest } from "./types.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3100", 10);
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

// ── Supabase sync endpoint ─────────────────────────────────────────────────────
app.post("/api/supabase/sync", async (req: express.Request, res: express.Response) => {
  const { company, items = [], ledgers = [], vouchers = [] } = req.body;
  if (!company) return res.status(400).json({ success: false, error: "company required" });

  try {
    console.log(`[Supabase] Manual sync initiated: ${items.length} items, ${ledgers.length} ledgers, ${vouchers.length} vouchers`);
    const supabase = new SupabaseSync();

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
      await supabase.syncMasters(masterMessages, company);
    }

    // Build voucher messages from frontend data
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

    // Sync vouchers
    if (voucherMessages.length > 0) {
      await supabase.syncVouchers(voucherMessages, company);
    }

    console.log(`[Supabase] Manual sync completed successfully`);
    res.json({
      success: true,
      message: `Synced ${masterMessages.length} masters and ${voucherMessages.length} vouchers to Supabase`,
      itemsCount: items.length,
      ledgersCount: ledgers.length,
      vouchersCount: vouchers.length,
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
    const supabase = new SupabaseSync();

    // Sync each table in parallel — Promise.allSettled means one failure doesn't break others.
    // Each entry is labeled so we can report exactly which table failed.
    const syncTasks: Array<{ label: string; promise: Promise<void> }> = [
      { label: "discount_rules", promise: discountRules.length > 0 ? supabase.syncDiscountRules(discountRules, company) : Promise.resolve() },
      { label: "order_groups", promise: orderGroups.length > 0 ? supabase.syncOrderGroups(orderGroups, company) : Promise.resolve() },
      { label: "unit_overrides", promise: Object.keys(unitOverrides).length > 0 ? supabase.syncUnitOverrides(unitOverrides, company) : Promise.resolve() },
      { label: "rate_overrides", promise: rateOverrides.length > 0 ? supabase.syncRateOverrides(rateOverrides, company) : Promise.resolve() },
      { label: "gst_overrides", promise: Object.keys(gstOverrides).length > 0 ? supabase.syncGstOverrides(gstOverrides, company) : Promise.resolve() },
      { label: "item_category_overrides", promise: Object.keys(itemCategoryOverrides).length > 0 ? supabase.syncItemCategoryOverrides(itemCategoryOverrides, company) : Promise.resolve() },
      { label: "category_colors", promise: Object.keys(categoryColors).length > 0 ? supabase.syncCategoryColors(categoryColors, company) : Promise.resolve() },
      { label: "vendor_group_assignments", promise: Object.keys(vendorGroupAssignments).length > 0 ? supabase.syncVendorGroupAssignments(vendorGroupAssignments, company) : Promise.resolve() },
      { label: "item_notes", promise: Object.keys(itemNotes).length > 0 ? supabase.syncItemNotes(itemNotes, company) : Promise.resolve() },
      { label: "calling_list_entries", promise: callingList.length > 0 ? supabase.syncCallingList(callingList, company) : Promise.resolve() },
      { label: "tally_price_list_imports", promise: Object.keys(tallyPriceListImports).length > 0 ? supabase.syncTallyPriceListImports(tallyPriceListImports, tallyPriceListImportedAt, company) : Promise.resolve() },
      { label: "voucher_overrides", promise: Object.keys(voucherOverrides).length > 0 ? supabase.syncVoucherOverrides(voucherOverrides, company) : Promise.resolve() },
      { label: "app_settings", promise: Object.keys(appSettings).length > 0 ? supabase.syncAppSettings(appSettings, company) : Promise.resolve() },
      // order_draft_lines always fires — empty array means "clear the cloud draft"
      { label: "order_draft_lines", promise: supabase.syncOrderDraftLines(orderDraftLines, company) },
    ];

    const results = await Promise.allSettled(syncTasks.map(t => t.promise));

    const errors = results
      .map((r, i) => ({ r, label: syncTasks[i].label }))
      .filter(({ r }) => r.status === "rejected")
      .map(({ r, label }) => `${label}: ${(r as PromiseRejectedResult).reason?.message || String((r as PromiseRejectedResult).reason)}`);

    console.log(`[Supabase] Config sync completed (${errors.length} errors)`);
    res.json({
      success: true,
      message: "Configuration data synced to Supabase",
      discountRulesCount: discountRules.length,
      orderGroupsCount: orderGroups.length,
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

// ── Push-test: convenience endpoint that builds payload from simple inputs ───────
// Accepts: { company, voucherType, date, partyName, ledgerName, items[], voucherNumber?, narration?, dryRun? }
// Returns: push result + the exact XML sent (for debugging)
app.post("/api/tally/push-test", async (req: express.Request, res: express.Response) => {
  const {
    company, voucherType = "Sales", date,
    partyName, ledgerName,
    items = [], voucherNumber, narration, dryRun = false,
  } = req.body;

  if (!company)   return res.status(400).json({ success: false, error: "company required" });
  if (!partyName) return res.status(400).json({ success: false, error: "partyName required" });
  if (!date)      return res.status(400).json({ success: false, error: "date required (YYYY-MM-DD)" });

  const totalAmount = (items as any[]).reduce((s: number, i: any) => s + (Number(i.qty) * Number(i.rate)), 0);
  // Normalize for branching — but preserve the ORIGINAL string so VCHTYPE/VOUCHERTYPENAME
  // match exactly what Tally has configured in the open company (e.g. "SALES" not "Sales")
  const vt = String(voucherType).trim().toUpperCase();
  const isSales        = vt === "SALES" || vt.startsWith("SALES");
  const isPurchase     = vt === "PURCHASE" || vt.startsWith("PURCHASE");
  const isDeliveryNote = vt.includes("DELIVERY");

  try {
    let payload: any;

    if (isSales) {
      if (!ledgerName) return res.status(400).json({ success: false, error: "ledgerName (sales account) required for Sales" });
      payload = {
        voucherType: voucherType,   // exact name the company uses, e.g. "SALES"
        date, voucherNumber, narration,
        partyLedgerName: partyName,
        isInvoice: true,
        ledgerEntries: [
          {
            ledgerName: partyName,
            amount: totalAmount,
            isDeemedPositive: true,   // Dr customer
            isPartyLedger: true,
            billAllocations: voucherNumber
              ? [{ name: voucherNumber, billType: "New Ref", amount: totalAmount }]
              : [],
          },
          {
            ledgerName,
            amount: totalAmount,
            isDeemedPositive: false,  // Cr sales account
            isPartyLedger: false,
          },
        ],
        inventoryEntries: (items as any[]).map((i: any) => ({
          stockItemName: i.name,
          quantity: Number(i.qty),
          unit: i.unit || "Nos",
          rate: Number(i.rate),
          amount: Number(i.qty) * Number(i.rate),  // positive = outward
          isDeemedPositive: false,                  // outward
          salesLedgerName: ledgerName,
        })),
      };
    } else if (isPurchase) {
      if (!ledgerName) return res.status(400).json({ success: false, error: "ledgerName (purchase account) required for Purchase" });
      payload = {
        voucherType: voucherType,   // exact name the company uses, e.g. "Purchase"
        date, voucherNumber, narration,
        partyLedgerName: partyName,
        isInvoice: true,
        ledgerEntries: [
          {
            ledgerName,
            amount: totalAmount,
            isDeemedPositive: true,   // Dr purchase account
            isPartyLedger: false,
          },
          {
            ledgerName: partyName,
            amount: totalAmount,
            isDeemedPositive: false,  // Cr supplier
            isPartyLedger: true,
            billAllocations: voucherNumber
              ? [{ name: voucherNumber, billType: "New Ref", amount: totalAmount }]
              : [],
          },
        ],
        inventoryEntries: (items as any[]).map((i: any) => ({
          stockItemName: i.name,
          quantity: Number(i.qty),
          unit: i.unit || "Nos",
          rate: Number(i.rate),
          amount: -(Number(i.qty) * Number(i.rate)), // negative = inward
          isDeemedPositive: true,                     // inward
          salesLedgerName: ledgerName,
        })),
      };
    } else if (isDeliveryNote) {
      payload = {
        voucherType: voucherType,   // exact name; defaults to "Delivery Note"
        date, voucherNumber, narration,
        partyLedgerName: partyName,
        isInvoice: false,
        ledgerEntries: [],  // inventory voucher — no accounting balance needed
        inventoryEntries: (items as any[]).map((i: any) => ({
          stockItemName: i.name,
          quantity: Number(i.qty),
          unit: i.unit || "Nos",
          rate: Number(i.rate),
          amount: Number(i.qty) * Number(i.rate), // positive = outward
          isDeemedPositive: false,                 // outward
          salesLedgerName: "",                     // no accounting allocation for pure delivery
        })),
      };
    } else {
      return res.status(400).json({ success: false, error: "voucherType must be Sales, Purchase, or Delivery Note" });
    }

    const sentXml = buildVoucherImportXml(company, payload);
    console.log(`[PUSH-TEST] ${voucherType} | ${date} | party="${partyName}" | total=${totalAmount} | dryRun=${dryRun}`);

    if (dryRun) {
      return res.json({ success: true, dryRun: true, sentXml, payload, created: 0, errors: 0, lineErrors: [], rawResponse: "" });
    }

    const rawResponse = await tallyPost(TALLY, sentXml, 30_000, true);
    const responseText = typeof rawResponse === "string" ? rawResponse : JSON.stringify(rawResponse);
    const result = parseImportResponse(responseText);
    console.log(`[PUSH-TEST] Result: created=${result.created} errors=${result.errors} success=${result.success}`);
    if (result.lineErrors.length) console.error(`[PUSH-TEST] Errors: ${result.lineErrors.join("; ")}`);

    res.json({ ...result, sentXml, payload });
  } catch (e: any) {
    console.error(`[PUSH-TEST] Exception: ${e.message}`);
    res.status(500).json({ success: false, error: e.message, created: 0, errors: 1, lineErrors: [e.message], rawResponse: "" });
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

// Start the drain loop only when explicitly enabled, so it can be turned off without
// a code change. The agent is an ADDITIONAL consumer of Tally — the manual
// /api/tally/push-voucher and /push-batch endpoints above are unchanged.
if (process.env.PUSH_AGENT_ENABLED === "true") {
  startPushAgent({ tallyUrl: TALLY });
}
