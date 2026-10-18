/**
 * Route auth and CORS policy for the agent's HTTP server (#98).
 *
 * The agent can write to the books (/api/local/push, /api/bank/push,
 * /api/tally/import, /api/file-transfer/push which reads any local file), yet
 * until now its only gate was CORS, which a request with no Origin header
 * (curl, a script, any non-browser client) walks straight past.
 *
 * ── Bearer token ──────────────────────────────────────────────────────────
 *   AGENT_API_TOKEN=<long random string>
 * When SET, every route except the health probe requires
 *   Authorization: Bearer <token>
 * and answers 401 otherwise. The compare is constant-time. When UNSET the
 * server behaves exactly as before and logs ONE startup warning, so nothing
 * breaks at the office the day this ships; the owner turns it on by setting the
 * variable (see CLAUDE.md, "Turning agent auth on").
 *
 * Open routes: GET /api/tally/health (a liveness probe carries no data worth
 * guarding) and GET / (a static page shell; the logs it polls are behind the
 * token like everything else).
 *
 * ── CORS ──────────────────────────────────────────────────────────────────
 * Default (AGENT_ALLOWED_ORIGINS unset): today's list, which is loopback, any
 * https://*.vercel.app, and the legacy ALLOWED_ORIGINS additions.
 * AGENT_ALLOWED_ORIGINS=https://a.example,https://b.example narrows it to
 * EXACTLY those origins plus loopback (the Electron renderer and dev tabs);
 * the *.vercel.app wildcard is then off. Requests with no Origin header are
 * still passed by CORS (that is what it does); the bearer token is what stops
 * them.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import cors from "cors";
import type { Express, Request, Response, NextFunction } from "express";

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const VERCEL_ORIGIN = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i;

/** Paths that need no token. Exact match, no prefixes. */
export const OPEN_PATHS: readonly string[] = ["/api/tally/health", "/"];

const list = (v: string | undefined): string[] =>
  (v ?? "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);

export interface AgentAuthConfig {
  /** null = auth off (the pre-#98 behaviour). */
  token: string | null;
  /** null = the default policy (loopback + *.vercel.app + legacy ALLOWED_ORIGINS). */
  explicitOrigins: string[] | null;
  legacyOrigins: string[];
}

export function loadAgentAuthConfig(env: Record<string, string | undefined> = process.env): AgentAuthConfig {
  const token = (env.AGENT_API_TOKEN ?? "").trim();
  const explicit = list(env.AGENT_ALLOWED_ORIGINS);
  return {
    token: token || null,
    explicitOrigins: explicit.length ? explicit : null,
    legacyOrigins: list(env.ALLOWED_ORIGINS),
  };
}

/** Constant-time string compare: both sides are hashed first so length is not leaked either. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export function originAllowed(origin: string, cfg: AgentAuthConfig): boolean {
  const o = origin.replace(/\/+$/, "");
  if (LOOPBACK_ORIGIN.test(o)) return true;
  if (cfg.explicitOrigins) return cfg.explicitOrigins.includes(o);
  return VERCEL_ORIGIN.test(o) || cfg.legacyOrigins.includes(o);
}

/** The token carried by an Authorization header, or null when it is not a Bearer one. */
export function bearerOf(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return m ? m[1] : null;
}

export function isOpenPath(path: string): boolean {
  return OPEN_PATHS.includes(path);
}

/** Express middleware. A no-op passthrough when no token is configured. */
export function agentAuth(cfg: AgentAuthConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!cfg.token) return next();
    if (req.method === "OPTIONS") return next(); // CORS preflight carries no credentials
    if (isOpenPath(req.path)) return next();
    const presented = bearerOf(req.header("authorization"));
    if (presented !== null && safeEqual(presented, cfg.token)) return next();
    res.setHeader("WWW-Authenticate", 'Bearer realm="mkcp-agent"');
    res.status(401).json({ error: "unauthorized", hint: "send Authorization: Bearer <AGENT_API_TOKEN>" });
  };
}

/** The one startup line. Returns the text so a test can check it without capturing console. */
export function authStartupNotice(cfg: AgentAuthConfig): { level: "warn" | "info"; text: string } {
  if (cfg.token) {
    return { level: "info", text: `[security] agent route auth ON — every route except /api/tally/health needs "Authorization: Bearer <AGENT_API_TOKEN>".` };
  }
  return {
    level: "warn",
    text:
      `⚠ [security] AGENT_API_TOKEN is not set — the agent's routes (including voucher push and file upload) accept ANY ` +
      `caller that can reach this port. Set AGENT_API_TOKEN to turn route auth on (see CLAUDE.md, "Turning agent auth on").`,
  };
}

/**
 * Install CORS and route auth on an app, in that order (CORS answers the
 * preflight before auth sees it). Used by src/index.ts and, unchanged, by
 * scripts/test-agent-auth.ts, so the test exercises the real wiring.
 */
export function installAgentSecurity(app: Express, cfg: AgentAuthConfig, warn: (m: string) => void = console.warn): void {
  app.use(cors({
    origin(origin, cb) {
      // No Origin header: same-origin, curl, or the Electron renderer. The bearer token is what gates those.
      if (!origin || originAllowed(origin, cfg)) return cb(null, true);
      warn(`[security] blocked cross-origin request from ${origin}`);
      cb(new Error(`Origin ${origin} is not allowed`));
    },
    credentials: true,
  }));
  app.use(agentAuth(cfg));
}
