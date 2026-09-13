/**
 * One record per Tally interaction, kept where it can be read afterwards.
 *
 * ── What exists today, and why it is backwards ────────────────────────────
 *
 * Request XML is persisted **only for pushes that succeeded** (`pushAgent.ts`
 * writes it into `push_queue.result` on the success branch). The failures — the
 * ones somebody would actually need — keep a truncated response and lose the
 * request entirely. Read failures keep nothing at all: `syncOrchestrator` turns
 * a rejected chunk into `errors.push("${label}: failed after retry")`, which is
 * the label, not the XML.
 *
 * So there is no record anywhere of *which request shapes fail*. That is the
 * single thing needed to make "zero scope of error" a claim rather than a hope,
 * and it is guardrail P8: **persist the evidence of failure, not success.**
 *
 * ── Local file, not Supabase ──────────────────────────────────────────────
 *
 * JSONL on disk beside the agent. It works when the machine is in sandbox mode
 * (where Supabase writes are refused), it works with no credentials, it survives
 * a Supabase outage, and it can grow large without costing anything. Diagnostic
 * data does not belong in a shared mirror.
 *
 * ── What is kept ──────────────────────────────────────────────────────────
 *
 * A FAILURE keeps the complete request and response. A SUCCESS keeps a digest —
 * shape, size, timing, counts — because a successful request's body tells you
 * nothing you did not already know, and full bodies for 3,000 vouchers a day
 * would bury the interesting rows.
 */
import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

export type Outcome = "ok" | "empty" | "tally-error" | "transport-error" | "exception";

export interface TallyLogRow {
  at: string;
  /** Which builder or call site produced this. */
  label: string;
  /** "Collection" | "Data" | "Import" */
  kind: string;
  /** Object type for a collection, report name for a report. */
  objectType?: string;
  fields?: string[];
  filter?: string;
  timeoutMs?: number;
  elapsedMs: number;
  bytesIn: number;
  outcome: Outcome;

  // Import responses
  created?: number;
  altered?: number;
  deleted?: number;
  errors?: number;
  exceptions?: number;
  lineErrors?: string[];

  /** Collection responses — how many objects came back. */
  objects?: number;

  /** Kept in full ONLY on a failure. */
  requestXml?: string;
  responseXml?: string;
  /** Why this row is interesting, in words. */
  note?: string;
}

const MAX_BYTES = 32 * 1024 * 1024;   // rotate at 32 MB
const KEEP_ROTATIONS = 3;

let logPath: string | null = null;
let disabled = false;

export function configureTallyLog(path: string): void {
  logPath = path;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    disabled = true;
  }
}

/** Default location, used when nothing configured it. */
function defaultPath(): string {
  return join(process.cwd(), "server", "data", "tally-log.jsonl");
}

function rotateIfNeeded(path: string): void {
  try {
    if (!existsSync(path)) return;
    if (statSync(path).size < MAX_BYTES) return;
    for (let i = KEEP_ROTATIONS - 1; i >= 1; i--) {
      const from = `${path}.${i}`;
      if (existsSync(from)) renameSync(from, `${path}.${i + 1}`);
    }
    renameSync(path, `${path}.1`);
  } catch {
    /* rotation is best-effort; never let it stop a sync */
  }
}

/**
 * Record one interaction.
 *
 * Never throws. A logger that can break the thing it observes is worse than no
 * logger — this runs inside the Tally transport, on the path every sync takes.
 */
export function recordTallyCall(row: TallyLogRow): void {
  if (disabled) return;
  const path = logPath ?? defaultPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path);
    appendFileSync(path, JSON.stringify(row) + "\n", "utf8");
  } catch {
    disabled = true;   // stop trying; do not spam the console on every request
  }
}

/** Is this response a failure worth keeping in full? */
export function classify(responseXml: string): { outcome: Outcome; note?: string } {
  if (/<LINEERROR>\s*\S/i.test(responseXml)) {
    const msg = responseXml.match(/<LINEERROR>([^<]*)<\/LINEERROR>/i)?.[1]?.trim();
    return { outcome: "tally-error", note: msg };
  }
  const exceptions = Number(responseXml.match(/<EXCEPTIONS>(\d+)<\/EXCEPTIONS>/i)?.[1] ?? 0);
  if (exceptions > 0) {
    return {
      outcome: "exception",
      // The signature that matters: Tally accepted the request and refused the
      // content without saying why.
      note: `EXCEPTIONS=${exceptions} with no LINEERROR — Tally refused the content and gave no reason.`,
    };
  }
  return { outcome: "ok" };
}

const MAX_KEPT = 200_000;   // characters, per body, on a failure

export function truncateForLog(xml: string): string {
  if (xml.length <= MAX_KEPT) return xml;
  return `${xml.slice(0, MAX_KEPT)}\n…[${xml.length - MAX_KEPT} more characters]`;
}

// ── Reading it back ───────────────────────────────────────────────────────

export interface LogSummary {
  total: number;
  byOutcome: Record<string, number>;
  /** Distinct request shapes that have ever failed, with an example. */
  failingShapes: { label: string; objectType?: string; outcome: Outcome; note?: string; count: number }[];
  slowest: { label: string; elapsedMs: number }[];
}

export function summarise(path?: string): LogSummary {
  const p = path ?? logPath ?? defaultPath();
  let lines: string[] = [];
  try {
    lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  } catch {
    return { total: 0, byOutcome: {}, failingShapes: [], slowest: [] };
  }

  const byOutcome: Record<string, number> = {};
  const failing = new Map<string, { label: string; objectType?: string; outcome: Outcome; note?: string; count: number }>();
  const timings: { label: string; elapsedMs: number }[] = [];

  for (const line of lines) {
    let row: TallyLogRow;
    try { row = JSON.parse(line) as TallyLogRow; } catch { continue; }
    byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1;
    timings.push({ label: row.label, elapsedMs: row.elapsedMs });

    if (row.outcome !== "ok") {
      const key = `${row.label}|${row.objectType ?? ""}|${row.outcome}`;
      const hit = failing.get(key);
      if (hit) hit.count++;
      else failing.set(key, { label: row.label, objectType: row.objectType, outcome: row.outcome, note: row.note, count: 1 });
    }
  }

  return {
    total: lines.length,
    byOutcome,
    failingShapes: [...failing.values()].sort((a, b) => b.count - a.count),
    slowest: timings.sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 10),
  };
}
