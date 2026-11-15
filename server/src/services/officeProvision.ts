/**
 * JOB: provision the office PC by itself (go-live D-M.286). Nobody types anything on that machine, so the agent writes its own single-primary settings
 * into the app's own .env the first time it can prove it is the office PC holding the real books, then starts the primary mode in-process.
 *
 * It does NOTHING unless ALL of these hold:
 *   1. MKCP_TALLY_ROLE resolves to primary (never on a sandbox);
 *   2. MKCP_PRIMARY_MODE is not explicitly "off";
 *   3. a database client exists (the office .env's service key; not offline);
 *   4. Tally's company listing shows the company named OFFICE_COMPANY_NAME open under exactly one GUID, and that GUID is OFFICE_COMPANY_GUID.
 *
 * Then it writes these keys into the .env the app already reads (loadPackagedEnv in public/electron.js): it replaces a key's line or appends one, and
 * never touches any other line. Values are never printed or logged.
 *   MKCP_PRIMARY_MODE=on                      replaced
 *   MKCP_PRIMARY_COMPANY_GUID=<the constant>  replaced
 *   PUSH_AGENT_ENABLED=false                  replaced (the old push agent must not run beside the primary)
 *   MKCP_ERP_AGENT_KEY=<32 random bytes, hex> made ONCE on this machine, never overwritten; it never leaves the machine and is never logged
 *   MKCP_AGENT_MACHINE_ID=office-pc-1         kept if the file already holds a valid one
 *   MKCP_ERP_JOURNAL_PATH=<userData>\erp-journal.jsonl   kept if the file already holds an absolute one (changing it would orphan the journal)
 *
 * The OFFICE_COMPANY_GUID is the 36-character prefix of every live voucher GUID of the company. The pin (primaryMode.ts) still fails closed if it is
 * wrong: a wrong constant means nothing is claimed and nothing is posted, never a write to the wrong books.
 *
 * Pure parts (decision, file merge) are separate from the file and Tally seams so the tests need neither.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import { companyGuidsFromListing } from "./tallyRole.js";
import { validMachineId } from "./primaryTools.js";

type Env = Record<string, string | undefined>;

export const OFFICE_COMPANY_NAME = "M.K.CYCLES (P) LTD. - (from 1-Apr-26)";
export const OFFICE_COMPANY_GUID = "353d02e0-63aa-11d7-8d44-d4bc1970ad56";
export const OFFICE_MACHINE_ID = "office-pc-1";
/** How often the agent tries again while Tally is closed or shows another company. */
export const OFFICE_PROVISION_RETRY_MS = 5 * 60_000;

export interface ProvisionRefusal { permanent: boolean; reason: string }

/**
 * Pure: why this machine must not be provisioned now, or null. `permanent` means waiting will not change it (a sandbox, the mode explicitly off, no
 * database client); otherwise Tally may simply not be open yet and the agent asks again later.
 */
export function provisionRefusal(o: { env: Env; hasClient: boolean; listingXml: string | null }): ProvisionRefusal | null {
  if ((o.env.MKCP_TALLY_ROLE ?? "").trim().toLowerCase() === "sandbox") return { permanent: true, reason: "MKCP_TALLY_ROLE=sandbox: a sandbox is never provisioned as the office primary" };
  if ((o.env.MKCP_PRIMARY_MODE ?? "").trim().toLowerCase() === "off") return { permanent: true, reason: "MKCP_PRIMARY_MODE is explicitly off" };
  if (!o.hasClient) return { permanent: true, reason: "no database client (offline, or no service key in this machine's .env)" };
  if (o.listingXml === null) return { permanent: false, reason: "Tally's company list could not be read" };
  const guids = companyGuidsFromListing(o.listingXml);
  const sameLetters = [...guids.keys()].filter((k) => k.trim().toLowerCase() === OFFICE_COMPANY_NAME.toLowerCase());
  const exact = sameLetters.filter((k) => k.trim() === OFFICE_COMPANY_NAME);
  if (exact.length !== 1 || sameLetters.length !== 1) return { permanent: false, reason: `the company "${OFFICE_COMPANY_NAME}" is not open exactly once in Tally` };
  const found = guids.get(exact[0]) ?? [];
  if (found.length !== 1) return { permanent: false, reason: "the office company is open under more than one GUID" };
  if (found[0].trim().toLowerCase() !== OFFICE_COMPANY_GUID.toLowerCase()) return { permanent: false, reason: "the open company carries a GUID other than the office company's" };
  return null;
}

// ── The file merge ───────────────────────────────────────────────────────────
const unquote = (v: string): string => {
  const t = v.trim();
  return (t.startsWith('"') && t.endsWith('"') && t.length >= 2) || (t.startsWith("'") && t.endsWith("'") && t.length >= 2) ? t.slice(1, -1).trim() : t;
};
const lineKey = (line: string): { key: string; value: string } | null => {
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
  return m ? { key: m[1], value: unquote(m[2].replace(/\s+#.*$/, "")) } : null;
};

export interface EnvWish {
  /** The value to write; a function is called only when the key is actually written (so a key is made only when needed). */
  value: string | (() => string);
  /** Keep what the file already has when it is acceptable (`ok`), and only write when it is missing or not acceptable. */
  keep?: (existing: string) => boolean;
}

/**
 * Pure: the .env text with each wished key set. A key's line is replaced (every line for it) or one is appended; every other line, comment and the
 * line endings stay exactly as they were. Returns the new text and the NAMES of the keys that changed (never a value).
 */
export function mergeEnvText(text: string, wishes: Record<string, EnvWish>): { text: string; changed: string[] } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.split(/\r?\n/);
  const trailingNewline = text === "" || /\r?\n$/.test(text);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const changed: string[] = [];
  for (const [key, wish] of Object.entries(wishes)) {
    const at: number[] = [];
    lines.forEach((l, i) => { if (lineKey(l)?.key === key) at.push(i); });
    const existing = at.map((i) => lineKey(lines[i])!.value);
    if (wish.keep && existing.some((v) => v !== "" && wish.keep!(v))) continue;
    if (!wish.keep && at.length && existing.every((v) => v === (typeof wish.value === "string" ? wish.value : v)) && typeof wish.value === "string") continue;
    const value = typeof wish.value === "function" ? wish.value() : wish.value;
    if (at.length) at.forEach((i) => { lines[i] = `${key}=${value}`; });
    else lines.push(`${key}=${value}`);
    changed.push(key);
  }
  return { text: lines.join(eol) + (lines.length && (trailingNewline || changed.length) ? eol : ""), changed };
}

/** The wishes of the office provisioning, for one userData folder. `makeKey` is called only when no key exists yet. */
export function officeWishes(userDataDir: string, makeKey: () => string = () => randomBytes(32).toString("hex")): Record<string, EnvWish> {
  return {
    MKCP_PRIMARY_MODE: { value: "on" },
    MKCP_PRIMARY_COMPANY_GUID: { value: OFFICE_COMPANY_GUID },
    MKCP_AGENT_MACHINE_ID: { value: OFFICE_MACHINE_ID, keep: validMachineId },
    MKCP_ERP_AGENT_KEY: { value: makeKey, keep: () => true },
    MKCP_ERP_JOURNAL_PATH: { value: path.join(userDataDir, "erp-journal.jsonl"), keep: (v) => path.isAbsolute(v) },
    PUSH_AGENT_ENABLED: { value: "false" },
  };
}

/** Both places the app reads its .env from (public/electron.js loadPackagedEnv), real folder first. */
export const envCandidates = (userDataDir: string): string[] =>
  [path.join(userDataDir, ".env"), path.join(path.dirname(userDataDir), "MK Cycles Dashboard", ".env")];

export interface EnvIo {
  exists(p: string): boolean;
  read(p: string): string;
  /** Write the whole file (atomically where the platform allows). */
  write(p: string, text: string): void;
}
export const nodeEnvIo: EnvIo = {
  exists: (p) => fs.existsSync(p),
  read: (p) => fs.readFileSync(p, "utf8"),
  write: (p, text) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, p);
  },
};

/**
 * Which file to write: the first candidate that exists and holds at least one setting (the one the app is already reading, so a new file never
 * shadows it), else the real userData one.
 */
export function chooseEnvFile(userDataDir: string, io: EnvIo = nodeEnvIo): string {
  const c = envCandidates(userDataDir);
  for (const p of c) {
    try { if (io.exists(p) && Object.keys(parseDotenv(io.read(p))).length > 0) return p; } catch { /* unreadable: not it */ }
  }
  return c[0];
}

export interface ProvisionResult {
  state: "skipped" | "provisioned" | "already";
  permanent?: boolean;
  reason?: string;
  /** Names of the keys written (never values). */
  changed: string[];
  file?: string;
}

/**
 * One attempt. Reads Tally's company list, decides, merges the file, and puts the same settings into this process's environment so the primary mode
 * can start without a restart. Never throws; never logs a value.
 */
export async function provisionOffice(d: {
  env: Env; userDataDir: string | null; hasClient: boolean; readListing: () => Promise<string>;
  io?: EnvIo; makeKey?: () => string; log?: (l: string) => void;
}): Promise<ProvisionResult> {
  const log = d.log ?? ((l: string) => console.log(`[office provision] ${l}`));
  const io = d.io ?? nodeEnvIo;
  try {
    // cheap permanent refusals first: do not even ask Tally on a sandbox
    const pre = provisionRefusal({ env: d.env, hasClient: d.hasClient, listingXml: "" });
    if (pre?.permanent) { return { state: "skipped", permanent: true, reason: pre.reason, changed: [] }; }
    if (!d.userDataDir || !path.isAbsolute(d.userDataDir)) return { state: "skipped", permanent: true, reason: "the app's own data folder is not known", changed: [] };
    let listing: string | null = null;
    try { listing = await d.readListing(); } catch { listing = null; }
    const why = provisionRefusal({ env: d.env, hasClient: d.hasClient, listingXml: listing });
    if (why) return { state: "skipped", permanent: why.permanent, reason: why.reason, changed: [] };

    const file = chooseEnvFile(d.userDataDir, io);
    const before = io.exists(file) ? io.read(file) : "";
    const merged = mergeEnvText(before, officeWishes(d.userDataDir, d.makeKey));
    if (merged.changed.length) io.write(file, merged.text);
    // this process now holds the same settings the file does (read back from the text, never from a variable that could differ)
    const after = parseDotenv(merged.text);
    for (const k of Object.keys(officeWishes(d.userDataDir, () => ""))) if (after[k] !== undefined && after[k] !== "") d.env[k] = after[k];
    log(merged.changed.length ? `wrote ${merged.changed.join(", ")} (names only) into ${file}` : `every setting was already in ${file}`);
    return { state: merged.changed.length ? "provisioned" : "already", changed: merged.changed, file };
  } catch (e) {
    return { state: "skipped", permanent: false, reason: `could not write the settings: ${(e as Error).message.slice(0, 160)}`, changed: [] };
  }
}

/**
 * Try now, then every OFFICE_PROVISION_RETRY_MS until it provisions, is permanently refused, or `shouldRun` says the primary is already running.
 * `onReady` is called once, after the settings are in this process's environment.
 */
export function startOfficeProvisioning(o: {
  env: Env; userDataDir: string | null; hasClient: () => boolean; readListing: () => Promise<string>;
  shouldRun: () => boolean; onReady: (r: ProvisionResult) => void | Promise<void>;
  retryMs?: number; io?: EnvIo; makeKey?: () => string; log?: (l: string) => void;
}): { stop(): void } {
  const log = o.log ?? ((l: string) => console.log(`[office provision] ${l}`));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let lastReason = "";
  const attempt = async (): Promise<void> => {
    if (stopped || !o.shouldRun()) return;
    const r = await provisionOffice({ env: o.env, userDataDir: o.userDataDir, hasClient: o.hasClient(), readListing: o.readListing, io: o.io, makeKey: o.makeKey, log: o.log });
    if (r.state === "skipped") {
      if (r.reason && r.reason !== lastReason) { lastReason = r.reason; log(`not provisioning: ${r.reason}${r.permanent ? "" : " (will ask again)"}`); }
      if (r.permanent || stopped) return;
      timer = setTimeout(() => { void attempt(); }, o.retryMs ?? OFFICE_PROVISION_RETRY_MS);
      timer.unref?.();
      return;
    }
    try { await o.onReady(r); } catch (e) { log(`starting the primary mode failed: ${(e as Error).message.slice(0, 160)}`); }
  };
  void attempt();
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); timer = null; } };
}
