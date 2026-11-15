/**
 * JOB: the one read-only answer behind the agent window's "office computer" card (agent-ui lane, after D-M.286). It gathers what the primary mode
 * already knows (the two loops, the company pin, the last preflight) into one small, plain object for `GET /api/primary/summary`.
 *
 * It decides nothing and sends nothing: no Tally request, no database call. Everything is read from objects the process already holds.
 *
 * NO SECRETS. The machine key is never an argument to anything that leaves here: it is read only to take its sha-256 (the same hash
 * scripts/primary-register.ts prints, so a person can match it to the registered key), and every free-text field is scrubbed of the key
 * before it is returned. The database key, the company's GUID and the settings file path are not read at all.
 */
import { keyHashOf, type PreflightLine } from "./primaryTools.js";
import { primaryModeOn } from "./primaryMode.js";
import { readPrimaryConfig, type LoopStatus, type MirrorLoopStatus } from "./primaryRunner.js";
import { scrubKey } from "./primaryPreflight.js";
import { agentMachineId } from "./supabaseClient.js";

type Env = Record<string, string | undefined>;

export interface PrimarySummary {
  /** `on`: the office loops are running. `on-not-running`: the mode is switched on but could not start (see `startProblems`). `off`: not the office computer's mode. */
  mode: "on" | "on-not-running" | "off";
  /** The neutral name this machine registered under, or null when none is set. */
  machineId: string | null;
  /** The key's sha-256 (never the key), or null when this machine has no key yet. */
  keyHash: string | null;
  /** When the company check last ran, and what it said. `ok` is null when it has not run yet. */
  pin: { ok: boolean | null; problem: string | null; at: string | null };
  /** True when the database knows this machine's key as the primary, false when the last preflight said it does not, null when no preflight has said. */
  registered: boolean | null;
  /** The queue loop: `lastLookAt` is the last time it asked for work, `lastWorkAt` the last time it worked a job (null: none since the program started). */
  claim: { running: boolean; lastLookAt: string | null; lastWorkAt: string | null; lastNote: string | null; errors: number; holdsLease: boolean | null; pausedReason: string | null; stoppedBecause: string[] };
  /** The mirror loop: same two times, and how many things it is holding back. */
  mirror: { running: boolean; lastLookAt: string | null; lastWorkAt: string | null; lastNote: string | null; errors: number; holds: number; alarms: number };
  /** The latest preflight report: when, whether every line passed, and the lines themselves. */
  preflight: { at: string | null; ready: boolean | null; lines: PreflightLine[]; lastError: string | null };
  /** Why the mode could not start, in the agent's own words (empty unless `mode` is `on-not-running`). */
  startProblems: string[];
  /** When this answer was made. */
  at: string;
}

export interface SummaryInputs {
  env: Env;
  tallyUrl: string;
  /** `primary.status()` from startPrimaryMode, or null when the loops are not running. */
  primary: { queue: LoopStatus; mirror: MirrorLoopStatus; agent: unknown } | null;
  /** `preflightReporter.status`, or null when no reporter exists on this machine. */
  preflight: { lastAt: string | null; lastReady: boolean | null; lastError: string | null; lines: PreflightLine[] } | null;
  now?: Date;
}

const REGISTERED_LINE = /registered as primary/i;

type AgentLike = {
  holder?: string | null; red?: string[]; claimsPaused?: { reason: string } | null;
  pin?: { ok: boolean; problem: string | null; at: string } | null;
};

/** Pure. Never throws, never reads the network. */
export function buildPrimarySummary(i: SummaryInputs): PrimarySummary {
  const key = (i.env.MKCP_ERP_AGENT_KEY ?? "").trim();
  const scrub = (t: string): string => scrubKey(t, key);
  const machine = agentMachineId(i.env);
  const on = primaryModeOn(i.env);
  const agent = (i.primary?.agent ?? null) as AgentLike | null;

  const lines = (i.preflight?.lines ?? []).map((l) => ({ name: scrub(l.name), ok: l.ok, detail: scrub(l.detail) }));
  const regLine = lines.find((l) => REGISTERED_LINE.test(l.name));

  let startProblems: string[] = [];
  if (on && !i.primary) {
    const cfg = readPrimaryConfig(i.tallyUrl, i.env);
    startProblems = cfg.ok ? ["the settings are complete, but the office loops have not started yet"] : cfg.problems.map((p) => scrub(p).slice(0, 300));
  }

  const q = i.primary?.queue;
  const m = i.primary?.mirror;
  return {
    mode: on ? (i.primary ? "on" : "on-not-running") : "off",
    machineId: machine === "unnamed-machine" ? null : machine,
    keyHash: key ? keyHashOf(key) : null,
    pin: { ok: agent?.pin ? agent.pin.ok : null, problem: agent?.pin?.problem ? scrub(agent.pin.problem).slice(0, 300) : null, at: agent?.pin?.at ?? null },
    registered: regLine ? regLine.ok : null,
    claim: {
      running: !!q?.running, lastLookAt: q?.lastAt ?? null, lastWorkAt: q?.lastWorkAt ?? null, lastNote: q?.lastNote ? scrub(q.lastNote).slice(0, 300) : null,
      errors: q?.errors ?? 0, holdsLease: agent ? !!agent.holder : null,
      pausedReason: agent?.claimsPaused?.reason ? scrub(agent.claimsPaused.reason).slice(0, 300) : null,
      stoppedBecause: (agent?.red ?? []).map((r) => scrub(r).slice(0, 300)),
    },
    mirror: {
      running: !!m?.running, lastLookAt: m?.lastAt ?? null, lastWorkAt: m?.lastWorkAt ?? null, lastNote: m?.lastNote ? scrub(m.lastNote).slice(0, 300) : null,
      errors: m?.errors ?? 0, holds: m?.holds.length ?? 0, alarms: m?.alarms.length ?? 0,
    },
    preflight: { at: i.preflight?.lastAt ?? null, ready: i.preflight?.lastReady ?? null, lines, lastError: i.preflight?.lastError ? scrub(i.preflight.lastError) : null },
    startProblems,
    at: (i.now ?? new Date()).toISOString(),
  };
}
