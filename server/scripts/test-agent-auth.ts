/**
 * #98 — agent route auth and CORS policy, offline (a throwaway express app on
 * an ephemeral loopback port; no Tally, no Supabase, no real agent server).
 *
 *   npx tsx scripts/test-agent-auth.ts
 */
import express from "express";
import type { AddressInfo } from "node:net";
import {
  loadAgentAuthConfig, installAgentSecurity, originAllowed, safeEqual, bearerOf, authStartupNotice, isOpenPath,
} from "../src/services/agentAuth.js";

let failures = 0;
function ok(name: string, pass: boolean, detail = ""): void {
  console.log(`  ${pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

async function withServer<T>(env: Record<string, string | undefined>, fn: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  installAgentSecurity(app, loadAgentAuthConfig(env), () => {});
  app.get("/api/tally/health", (_q, r) => r.json({ ok: true }));
  app.get("/api/local/status", (_q, r) => r.json({ secret: "data" }));
  app.post("/api/local/push", (_q, r) => r.json({ pushed: true }));
  app.use((_e: unknown, _q: express.Request, r: express.Response, _n: express.NextFunction) => { r.status(403).json({ error: "blocked" }); }); // quiet stand-in for express default 500
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  try { return await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`); }
  finally { srv.close(); }
}
const status = async (url: string, init?: RequestInit) => (await fetch(url, init)).status;
const TOKEN = "t0ken-" + "x".repeat(24);

async function main() {
  // ── token ON ───────────────────────────────────────────────────────────
  await withServer({ AGENT_API_TOKEN: TOKEN }, async (b) => {
    ok("missing token → 401", (await status(`${b}/api/local/status`)) === 401);
    ok("missing token on a WRITE route → 401", (await status(`${b}/api/local/push`, { method: "POST" })) === 401);
    ok("wrong token → 401", (await status(`${b}/api/local/status`, { headers: { Authorization: "Bearer nope" } })) === 401);
    ok("same-length wrong token → 401", (await status(`${b}/api/local/status`, { headers: { Authorization: "Bearer " + "y".repeat(TOKEN.length) } })) === 401);
    ok("non-Bearer scheme → 401", (await status(`${b}/api/local/status`, { headers: { Authorization: `Basic ${TOKEN}` } })) === 401);
    ok("right token → 200", (await status(`${b}/api/local/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })) === 200);
    ok("right token on a write route → 200", (await status(`${b}/api/local/push`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } })) === 200);
    ok("health route is open without a token", (await status(`${b}/api/tally/health`)) === 200);
    ok("a health lookalike path is NOT open", (await status(`${b}/api/tally/health/x`)) === 401);
    const r401 = await fetch(`${b}/api/local/status`);
    ok("401 body does not echo the token", !(await r401.text()).includes(TOKEN));
    const pre = await fetch(`${b}/api/local/push`, { method: "OPTIONS", headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization" } });
    ok("CORS preflight from loopback passes without a token", pre.status === 204 && pre.headers.get("access-control-allow-origin") === "http://localhost:5173", `status ${pre.status}`);
  });

  // ── token OFF (today's behaviour) ───────────────────────────────────────
  await withServer({}, async (b) => {
    ok("token unset: routes stay open (no behaviour change)", (await status(`${b}/api/local/status`)) === 200);
    ok("token unset: blank string counts as unset", loadAgentAuthConfig({ AGENT_API_TOKEN: "   " }).token === null);
  });

  // ── CORS ────────────────────────────────────────────────────────────────
  const dflt = loadAgentAuthConfig({});
  ok("default: loopback allowed", originAllowed("http://localhost:5173", dflt) && originAllowed("http://127.0.0.1:3100", dflt));
  ok("default: *.vercel.app still allowed (today's list)", originAllowed("https://mkcp-web.vercel.app", dflt));
  ok("default: arbitrary origin refused", !originAllowed("https://evil.example", dflt));
  ok("default: lookalike vercel host refused", !originAllowed("https://mkcp.vercel.app.evil.example", dflt));
  ok("default: legacy ALLOWED_ORIGINS still honoured", originAllowed("https://x.example", loadAgentAuthConfig({ ALLOWED_ORIGINS: "https://x.example" })));
  const narrow = loadAgentAuthConfig({ AGENT_ALLOWED_ORIGINS: "https://dash.example.com/, https://b.example.com", ALLOWED_ORIGINS: "https://legacy.example" });
  ok("narrowed: listed origin allowed (trailing slash tolerated)", originAllowed("https://dash.example.com", narrow) && originAllowed("https://b.example.com", narrow));
  ok("narrowed: *.vercel.app is now refused", !originAllowed("https://mkcp-web.vercel.app", narrow));
  ok("narrowed: legacy list is superseded", !originAllowed("https://legacy.example", narrow));
  ok("narrowed: loopback still allowed (Electron renderer, dev tab)", originAllowed("http://localhost:5173", narrow));

  await withServer({ AGENT_ALLOWED_ORIGINS: "https://dash.example.com" }, async (b) => {
    const good = await fetch(`${b}/api/tally/health`, { headers: { Origin: "https://dash.example.com" } });
    ok("HTTP: allowed origin gets the ACAO header", good.headers.get("access-control-allow-origin") === "https://dash.example.com");
    const bad = await fetch(`${b}/api/tally/health`, { headers: { Origin: "https://mkcp-web.vercel.app" } });
    ok("HTTP: a vercel.app origin is blocked once narrowed", bad.status !== 200 && !bad.headers.get("access-control-allow-origin"), `status ${bad.status}`);
    ok("HTTP: no Origin header is still passed by CORS", (await status(`${b}/api/tally/health`)) === 200);
  });

  // ── helpers + startup notice ────────────────────────────────────────────
  ok("safeEqual: equal / unequal / different length", safeEqual("abc", "abc") && !safeEqual("abc", "abd") && !safeEqual("abc", "abcd"));
  ok("bearerOf parses and rejects", bearerOf("Bearer abc") === "abc" && bearerOf("bearer abc") === "abc" && bearerOf("Basic abc") === null && bearerOf(undefined) === null);
  ok("open paths are exactly health and the page shell", isOpenPath("/api/tally/health") && isOpenPath("/") && !isOpenPath("/api/tally/logs") && !isOpenPath("/api/tally/health/x"));
  const off = authStartupNotice(loadAgentAuthConfig({}));
  const on = authStartupNotice(loadAgentAuthConfig({ AGENT_API_TOKEN: TOKEN }));
  ok("unset: ONE clear startup warning naming the variable", off.level === "warn" && off.text.includes("AGENT_API_TOKEN") && !off.text.includes("\n"));
  ok("set: an info line, and the token is never printed", on.level === "info" && !on.text.includes(TOKEN));

  if (failures) { console.error(`\n  ${failures} check(s) failed\n`); process.exit(1); }
  console.log("\n  all checks passed\n");
}
main().catch((e) => { console.error(e); process.exit(1); });
