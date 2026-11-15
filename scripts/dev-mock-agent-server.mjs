#!/usr/bin/env node
/**
 * A pretend agent server, for looking at the agent window without Tally, a database or a real machine.
 * Nothing here talks to anything: it answers the renderer's GET routes from fixed fake data (ZZ TEST names only) on port 3100.
 *
 *   node scripts/dev-mock-agent-server.mjs [scenario]
 *   scenario: office-ready (default) | office-notready | office-notstarted | office-off | down
 *   Switch while it runs:  GET http://localhost:3100/__scenario?name=office-notready
 *
 * It also answers the window's read-only database calls (GET /rest/v1/...) with fake rows, so the history, send log and failed-job lists fill in.
 * Point the window at it with VITE_SUPABASE_URL=http://127.0.0.1:<port> and VITE_SUPABASE_PUBLISHABLE_KEY=mock (never a real key).
 *
 * Then `npx vite` and open http://localhost:5173/ (the main window) or http://localhost:5173/#/pip (Quick View).
 * Not packaged (scripts/ is not part of the installer).
 */
import http from "node:http";

let scenario = process.argv[2] || "office-ready";
/* MOCK_PORT lets a second copy run beside a real agent without touching its port 3100. */
const PORT = Number(process.env.MOCK_PORT) || 3100;
const minsAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

const KEY_HASH = "5d41402abc4b2a76b9719d911017c592a0b1c2d3e4f5061728394a5b6c7d8e9f";

function summary() {
  if (scenario === "office-off") return { mode: "off", machineId: null, keyHash: null, pin: { ok: null, problem: null, at: null }, registered: null,
    claim: { running: false, lastLookAt: null, lastWorkAt: null, lastNote: null, errors: 0, holdsLease: null, pausedReason: null, stoppedBecause: [] },
    mirror: { running: false, lastLookAt: null, lastWorkAt: null, lastNote: null, errors: 0, holds: 0, alarms: 0 },
    preflight: { at: null, ready: null, lines: [], lastError: null }, startProblems: [], at: new Date().toISOString() };
  const ready = scenario === "office-ready";
  const notStarted = scenario === "office-notstarted";
  const lines = ready ? [
    { name: "the primary settings are complete", ok: true, detail: "" },
    { name: "Tally answers on its port", ok: true, detail: "" },
    { name: "the open company carries the pinned GUID", ok: true, detail: "" },
    { name: "the database is reachable and this machine's key is registered as primary", ok: true, detail: "" },
  ] : [
    { name: "the primary settings are complete", ok: true, detail: "" },
    { name: "Tally answers on its port", ok: true, detail: "" },
    { name: "the open company carries the pinned GUID", ok: false, detail: "refused: not the pinned company. \"ZZ TEST CO\" is open under a GUID other than MKCP_PRIMARY_COMPANY_GUID. It is a copy or another year's books." },
    { name: "the database is reachable and this machine's key is registered as primary", ok: false, detail: "the database says role \"none\", not primary" },
  ];
  return {
    mode: notStarted ? "on-not-running" : "on",
    machineId: "office-pc-1",
    keyHash: KEY_HASH,
    pin: notStarted ? { ok: null, problem: null, at: null } : ready ? { ok: true, problem: null, at: minsAgo(1) } : { ok: false, problem: lines[2].detail, at: minsAgo(1) },
    registered: notStarted ? null : ready,
    claim: notStarted
      ? { running: false, lastLookAt: null, lastWorkAt: null, lastNote: null, errors: 0, holdsLease: null, pausedReason: null, stoppedBecause: [] }
      : { running: true, lastLookAt: minsAgo(0.2), lastWorkAt: ready ? minsAgo(7) : null, lastNote: ready ? "idle" : "claiming is paused for 40 s more: a job was put back: refused: the pinned company could not be read", errors: 0, holdsLease: ready,
          pausedReason: ready ? null : "a job was put back: refused: not the pinned company", stoppedBecause: ready ? [] : ["Tally may be showing a message on the office screen; the queue is paused until it answers normally"] },
    mirror: notStarted
      ? { running: false, lastLookAt: null, lastWorkAt: null, lastNote: null, errors: 0, holds: 0, alarms: 0 }
      : { running: true, lastLookAt: minsAgo(2), lastWorkAt: ready ? minsAgo(18) : null, lastNote: ready ? "incremental:swapped" : "nothing due", errors: ready ? 0 : 1, holds: ready ? 0 : 1, alarms: 0 },
    preflight: notStarted ? { at: null, ready: null, lines: [], lastError: null } : { at: minsAgo(3), ready, lines, lastError: null },
    startProblems: notStarted ? [
      "refused: MKCP_PRIMARY_COMPANY_GUID is not set, so this machine cannot prove which company it holds. Nothing is posted and nothing is claimed until it is set.",
      "MKCP_ERP_AGENT_KEY is not set (the machine's own key; only its sha-256 is registered in the database)",
    ] : [],
    at: new Date().toISOString(),
  };
}

const routes = {
  "/api/tally/health": () => ({ connected: scenario !== "office-notstarted", tallyUrl: "http://localhost:9000" }),
  "/api/push-agent/status": () => ({
    enabled: scenario === "office-off", agentId: "ZZ-MOCK-PC#4242", lastTick: minsAgo(0.1), tallyHealthy: true, claimedCount: 0, last10Results: [],
    queueStats: { pending: 0, pushing: 0, failed: 1 }, queueStatsAt: minsAgo(0.1),
  }),
  "/api/primary/summary": summary,
  "/api/tally/company": () => ({ success: true, current: "ZZ TEST COMPANY" }),
  "/api/tally/logs": () => [
    "[tally] 10:02:11 read 214 vouchers for 2026-11-14",
    "\u2713 [Supabase] vouchers pushed (214 rows)",
    "\u26a0 [DAYBOOK] one voucher came back short, retrying",
    "\u{1F310} [WEB-SYNC] refresh asked from the web",
    "\u274c [tally] a ZZ TEST ledger was refused: name differs in case",
    "[NIGHTLY] next full sync at 00:00",
  ],
  "/api/file-transfer/status": () => ({ ok: true, rows: [], watch: { watching: true, dir: "C:\\Mock\\Watch" } }),
  "/api/whoami": () => ({ app: "mkcp-tally-proxy", version: "1.5.13", pid: 4242, startedAt: minsAgo(300) }),
  "/api/mirror/panel": () => ({
    company: "ZZ TEST COMPANY", offline: false, lastFullSyncAt: minsAgo(60 * 20),
    syncs: [
      { startedAt: minsAgo(18), completedAt: minsAgo(17), syncType: "vouchers", success: true, counts: { vouchers: 214, ledger_entries: 640 }, errors: null, full: false },
      { startedAt: minsAgo(60 * 20), completedAt: minsAgo(60 * 19), syncType: "vouchers", success: true, counts: { vouchers: 9120 }, errors: null, full: true },
      { startedAt: minsAgo(60 * 21), completedAt: minsAgo(60 * 21), syncType: "masters", success: false, counts: null, errors: ["a ZZ TEST ledger was refused"], full: false },
    ],
    snapshot: [
      { table: "tally_vouchers", rows: 9120, newest: "2026-11-14" }, { table: "tally_items", rows: 2310, newest: null },
      { table: "tally_ledgers", rows: 840, newest: null }, { table: "tally_stock_groups", rows: null, newest: null },
    ],
    pushes: [
      { id: "1", status: "succeeded", voucherType: "Sales", voucherNumber: "ZZTEST001/1", party: "ZZ TEST PARTY 042", amount: 18250, attempts: 1, lastError: null, createdAt: minsAgo(30), claimedAt: minsAgo(30), pushedAt: minsAgo(29), waitedSeconds: 4 },
      { id: "2", status: "failed", voucherType: "Receipt", voucherNumber: "ZZTEST001/2", party: "ZZ TEST PARTY 043", amount: 0, attempts: 3, lastError: "the ledger name differs by a capital letter from the one in Tally", createdAt: minsAgo(90), claimedAt: null, pushedAt: null, waitedSeconds: null },
    ],
    edits: [{ id: 1, at: minsAgo(45), who: "PERSON 003", domain: "discount rules", table: "discount_rules", action: "upsert", count: 3 }],
    pushLatency: { count: 12, pickupMedian: 0.6, inTallyMedian: 3.2, inTallySlowest: 9 },
  }),
};


/* The window's own read-only calls to the online database (supabase-js sends GET /rest/v1/<table>). Fake rows, ZZ TEST names only. */
const REST = {
  tally_sync_history: () => [
    { id: "h1", sync_type: "vouchers", started_at: minsAgo(18), completed_at: minsAgo(17), success: true, duration_ms: 42000, chunk_count: 1, row_counts: { vouchers: 214, ledger_entries: 640 }, errors: null },
    { id: "h2", sync_type: "masters", started_at: minsAgo(60 * 3), completed_at: minsAgo(60 * 3), success: true, duration_ms: 8200, chunk_count: 1, row_counts: { items: 2310, ledgers: 840 }, errors: null },
    { id: "h3", sync_type: "vouchers", started_at: minsAgo(60 * 20), completed_at: minsAgo(60 * 19), success: true, duration_ms: 540000, chunk_count: 365, row_counts: { vouchers: 9120 }, errors: null },
    { id: "h4", sync_type: "masters", started_at: minsAgo(60 * 21), completed_at: minsAgo(60 * 21), success: false, duration_ms: 900, chunk_count: null, row_counts: null, errors: ["a ZZ TEST ledger was refused: the name differs by a capital letter from the one in Tally"] },
    { id: "h5", sync_type: "vouchers", started_at: minsAgo(60 * 26), completed_at: minsAgo(60 * 26), success: true, duration_ms: 31000, chunk_count: 1, row_counts: { vouchers: 188 }, errors: null },
    { id: "h6", sync_type: "vouchers", started_at: minsAgo(60 * 30), completed_at: minsAgo(60 * 30), success: true, duration_ms: 29000, chunk_count: 1, row_counts: { vouchers: 171 }, errors: null },
    { id: "h7", sync_type: "vouchers", started_at: minsAgo(60 * 34), completed_at: minsAgo(60 * 34), success: true, duration_ms: 27000, chunk_count: 1, row_counts: { vouchers: 166 }, errors: null },
    { id: "h8", sync_type: "vouchers", started_at: minsAgo(60 * 40), completed_at: minsAgo(60 * 40), success: true, duration_ms: 26000, chunk_count: 1, row_counts: { vouchers: 152 }, errors: null },
  ],
  push_sync_log: () => [
    { id: "p1", push_queue_id: "q1", idempotency_key: "k1", voucher_type: "Sales", party: "ZZ TEST PARTY 042", date: "2026-11-14", status: "succeeded", tally_vch_id: "ZZTEST001/1", attempts: 1, last_error: null, line_errors: null, resolved_at: minsAgo(29) },
    { id: "p2", push_queue_id: "q2", idempotency_key: "k2", voucher_type: "Receipt", party: "ZZ TEST PARTY 043", date: "2026-11-14", status: "failed", tally_vch_id: null, attempts: 3, last_error: "the ledger name differs by a capital letter from the one in Tally", line_errors: null, resolved_at: minsAgo(90) },
  ],
  push_queue: () => [
    { id: "q9", idempotency_key: "k9", company: "ZZ TEST COMPANY", payload: { voucherType: "Receipt", partyLedgerName: "ZZ TEST PARTY 043" }, attempts: 3, last_error: "the ledger name differs by a capital letter from the one in Tally", created_at: minsAgo(95) },
  ],
  file_transfers: () => [],
};

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (url.pathname === "/__scenario") { scenario = url.searchParams.get("name") || scenario; res.writeHead(200); return res.end(`scenario: ${scenario}\n`); }
  if (scenario === "down") { req.socket.destroy(); return; }
  const rest = url.pathname.startsWith("/rest/v1/") ? REST[url.pathname.slice(9)] : null;
  if (rest) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(req.method === "GET" ? rest() : [])); }
  const f = routes[url.pathname];
  if (!f) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end("{}"); }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(f()));
}).listen(PORT, "127.0.0.1", () => console.log(`mock agent server on http://localhost:${PORT}, scenario: ${scenario}`));
