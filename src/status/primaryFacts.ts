/**
 * JOB: say, in plain English for a non-technical owner, what the office computer's primary mode is doing. Pure functions only: the window fetches
 * `GET /api/primary/summary` and hands the answer here, and so does the small Quick View, so the two windows cannot disagree.
 *
 * The rule from agentFacts.ts holds here too: a status has THREE states, known good, known bad and NOT KNOWN, and the third must never look like
 * the first. A pin that has not been checked yet is "not checked yet", never "matches". A machine no preflight has spoken about is "not known",
 * never "registered".
 *
 * No setting names, no file names and no jargon in anything returned for display. When the agent says something this file has no sentence for,
 * the display gets a safe plain sentence and the agent's own words ride along separately in `raw`, for a helper to read.
 */
import type { AgentFact, FactTone } from "./agentFacts";

export interface PreflightLineLike { name: string; ok: boolean; detail: string }

/** `GET /api/primary/summary` (server/src/services/primarySummary.ts). `null` from the window means the local server did not answer. */
export interface PrimarySummaryLike {
  mode: "on" | "on-not-running" | "off";
  machineId: string | null;
  keyHash: string | null;
  pin: { ok: boolean | null; problem: string | null; at: string | null };
  registered: boolean | null;
  claim: { running: boolean; lastLookAt: string | null; lastWorkAt: string | null; lastNote: string | null; errors: number; holdsLease: boolean | null; pausedReason: string | null; stoppedBecause: string[] };
  mirror: { running: boolean; lastLookAt: string | null; lastWorkAt: string | null; lastNote: string | null; errors: number; holds: number; alarms: number };
  preflight: { at: string | null; ready: boolean | null; lines: PreflightLineLike[]; lastError: string | null };
  startProblems: string[];
  at: string;
}

/** Is the card for this answer the office card? Only when the mode is switched on; "off" keeps the old queue card. */
export const primaryIsOn = (s: PrimarySummaryLike | null | undefined): s is PrimarySummaryLike => !!s && s.mode !== "off";

// ── time, in words ───────────────────────────────────────────────────────────
const clock = (d: Date) => d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

/** "3 minutes ago, at 10:04 am", "just now", or a date once it is over a day old. Null in, null out is the caller's choice: this takes only a real time. */
export function whenText(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "at a time that could not be read";
  const sec = Math.round((now.getTime() - d.getTime()) / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago, at ${clock(d)}`;
  const hrs = Math.round(min / 60);
  if (hrs < 24 && d.toDateString() === now.toDateString()) return `${hrs} hour${hrs === 1 ? "" : "s"} ago, at ${clock(d)}`;
  return `${d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })} at ${clock(d)}`;
}

// ── the agent's own sentences, made plain ────────────────────────────────────
export interface Plain { text: string; raw: string | null }

const knownOrRaw = (rules: Array<[RegExp, string]>, source: string, fallback: string): Plain => {
  for (const [re, text] of rules) if (re.test(source)) return { text, raw: null };
  return { text: fallback, raw: source.trim() || null };
};

const SETTING_RULES: Array<[RegExp, string]> = [
  [/MKCP_PRIMARY_MODE is not on/i, "Office mode is not switched on yet."],
  [/sandbox/i, "This computer is marked as a practice machine, so it cannot run as the office computer."],
  [/COMPANY_GUID is not set/i, "This computer has not been told which company is the real one yet, so nothing is sent to Tally."],
  [/MACHINE_ID/i, "This computer has no name of its own in the office system yet."],
  [/AGENT_KEY/i, "This computer has no private key of its own yet."],
  [/SERVICE_KEY|cannot reach the database/i, "This computer cannot reach the online database because its access key is missing."],
  [/OFFLINE/i, "The online database is switched off on this computer."],
  [/JOURNAL/i, "The notebook where this computer records every job is not set up yet."],
  [/PUSH_AGENT_ENABLED/i, "The old sending system is still switched on. It must be off while office mode runs."],
  [/no company name/i, "No company name is set on this computer."],
  [/company list/i, "The list of company years on this computer is not set up correctly."],
];

const PIN_RULES: Array<[RegExp, string]> = [
  [/not the pinned company|another GUID|other than/i, "The company open in Tally is a copy or another year's books, not the real company. Nothing is sent to Tally."],
  [/is not open in Tally/i, "The office company is not open in Tally. Open it in TallyPrime."],
  [/more than once/i, "The company is open in Tally more than once, so the right one cannot be told apart."],
  [/capital letters/i, "Two open companies have almost the same name, so the right one cannot be told apart."],
  [/no company is named/i, "No company is named on this computer, so it cannot check which one Tally has open."],
  [/COMPANY_GUID is not set/i, "This computer has not been told which company is the real one yet."],
  [/sandbox/i, "This computer is marked as a practice machine."],
];

const ROLE_RULES: Array<[RegExp, string]> = [
  [/no database client/i, "This computer cannot reach the online database."],
  [/no machine id or key/i, "This computer has no name or key to introduce itself with."],
  [/not registered|unknown machine|no such machine/i, "This computer is not registered with the online database yet. Someone has to register it once."],
  [/says role/i, "The online database does not list this computer as the office computer yet. Someone has to register it."],
];

/** One preflight line, as a sentence a person can act on. `ok` lines are short confirmations. */
export function plainPreflightLine(l: PreflightLineLike): { ok: boolean; text: string; raw: string | null } {
  const name = l.name.toLowerCase();
  if (/primary settings are complete/.test(name)) return { ok: l.ok, text: "This computer's office settings are all filled in.", raw: null };
  if (name === "setting") return { ok: false, ...knownOrRaw(SETTING_RULES, l.detail, "Something in this computer's office settings is not right.") };
  if (/tally answers/.test(name)) {
    return l.ok
      ? { ok: true, text: "Tally is open and answering.", raw: null }
      : { ok: false, text: "Tally is not answering. Open TallyPrime with the company loaded and check its connection setting.", raw: l.detail.trim() || null };
  }
  if (/carries the pinned/.test(name)) {
    return l.ok
      ? { ok: true, text: "The company open in Tally is the real one.", raw: null }
      : { ok: false, ...knownOrRaw(PIN_RULES, l.detail, "The company open in Tally could not be confirmed as the real one.") };
  }
  if (/registered as primary/.test(name)) {
    return l.ok
      ? { ok: true, text: "The online database knows this computer as the office computer.", raw: null }
      : { ok: false, ...knownOrRaw(ROLE_RULES, l.detail, "The online database did not accept this computer as the office computer.") };
  }
  return { ok: l.ok, text: l.ok ? "This check passed." : "This check did not pass.", raw: l.detail.trim() || l.name };
}

/** The queue loop's last note as a plain sentence. */
export function plainClaimNote(note: string | null): Plain | null {
  if (!note) return null;
  const worked = /^(\d+) job\(s\) worked, (\d+) settled$/.exec(note);
  if (worked) return { text: `${worked[1]} job${worked[1] === "1" ? "" : "s"} sent to Tally, ${worked[2]} checked after an earlier stop.`, raw: null };
  const paused = /claiming is paused for (\d+) s more/i.exec(note);
  if (paused) return { text: `Claiming is paused for ${paused[1]} more seconds because the company in Tally could not be confirmed.`, raw: null };
  return knownOrRaw([
    [/^idle$/, "Nothing was waiting in the queue."],
    [/lease is held|not holding the queue lease/i, "Another computer holds the queue, so this one is waiting its turn."],
    [/off until go-live|live_claims/i, "The office queue is still switched off until go-live, so nothing is claimed."],
    [/^round failed/i, "The last check for work failed. It tries again by itself."],
  ], note, "The queue reported something this window has no plain sentence for.");
}

const WORK_WORDS: Record<string, string> = {
  full: "a full copy", incremental: "an update of what changed", check: "a daily check", repull: "a one-day re-read", masters: "the lists of parties and items", accepted: "an accepted drop",
};
const STATE_WORDS: Record<string, string> = { swapped: "finished", ok: "finished", failed: "failed", refused: "was held back", skipped: "was skipped" };

/** The mirror loop's last note as a plain sentence. */
export function plainMirrorNote(note: string | null): Plain | null {
  if (!note) return null;
  if (note === "nothing due") return { text: "Nothing was due.", raw: null };
  const parts = note.split(", ").map((p) => /^(\w+):(\w+)$/.exec(p));
  if (parts.length && parts.every((p) => p && WORK_WORDS[p[1]] && STATE_WORDS[p[2]])) {
    return { text: parts.map((p) => `${WORK_WORDS[p![1]]} ${STATE_WORDS[p![2]]}`).join("; ").replace(/^./, (c) => c.toUpperCase()) + ".", raw: null };
  }
  return knownOrRaw([
    [/off until go-live|live_mirror/i, "The mirror is still switched off until go-live."],
    [/^pass failed/i, "The last pass failed. It tries again by itself."],
    [/queue is busy|queueBusy/i, "It waited because the queue was busy."],
  ], note, "The mirror reported something this window has no plain sentence for.");
}

// ── the facts ────────────────────────────────────────────────────────────────
const fact = (label: string, value: string, tone: FactTone, sub: string, attention: boolean): AgentFact => ({ label, value, tone, sub, attention });

/** Is the office mode on and every preflight line passing. */
export function officeFact(s: PrimarySummaryLike | null): AgentFact {
  if (!s) return fact("Office mode", "Unknown", "unknown", "the local server did not answer", true);
  if (s.mode === "off") return fact("Office mode", "Off", "unknown", "this computer is not the office computer", false);
  if (s.mode === "on-not-running") return fact("Office mode", "Not started", "bad", "switched on, but it could not start; see the list below", true);
  if (s.preflight.ready === null) return fact("Office mode", "Starting", "unknown", "no readiness report has been made yet", true);
  return s.preflight.ready
    ? fact("Office mode", "Ready", "good", s.machineId ? `this computer is ${s.machineId}` : "every check passed", false)
    : fact("Office mode", "Not ready", "bad", `${s.preflight.lines.filter((l) => !l.ok).length} check${s.preflight.lines.filter((l) => !l.ok).length === 1 ? "" : "s"} not passing`, true);
}

/** When the office copy of Tally last did something. */
export function mirrorRunFact(s: PrimarySummaryLike | null, now: Date = new Date()): AgentFact {
  if (!s) return fact("Last copy to cloud", "Unknown", "unknown", "the local server did not answer", true);
  const m = s.mirror;
  if (m.lastWorkAt) return fact("Last copy to cloud", whenText(m.lastWorkAt, now).split(",")[0], m.errors > 0 ? "warn" : "good", m.errors > 0 ? `${m.errors} failed pass${m.errors === 1 ? "" : "es"} since the program started` : "copied from Tally to the online database", m.errors > 0);
  if (m.lastLookAt) return fact("Last copy to cloud", "None yet", "unknown", `it looked ${whenText(m.lastLookAt, now).split(",")[0]} and nothing was copied`, false);
  return fact("Last copy to cloud", "None yet", "unknown", "it has not looked since the program started", true);
}

/** When the office computer last took a job from the queue. */
export function claimFact(s: PrimarySummaryLike | null, now: Date = new Date()): AgentFact {
  if (!s) return fact("Last job taken", "Unknown", "unknown", "the local server did not answer", true);
  const c = s.claim;
  if (c.lastWorkAt) return fact("Last job taken", whenText(c.lastWorkAt, now).split(",")[0], "good", "a job was sent to Tally", false);
  if (c.lastLookAt) return fact("Last job taken", "None yet", "unknown", `it looked ${whenText(c.lastLookAt, now).split(",")[0]} and found none`, false);
  return fact("Last job taken", "None yet", "unknown", "it has not looked since the program started", true);
}

/** The company check, in a sentence. */
export function pinSentence(s: PrimarySummaryLike, now: Date = new Date()): { tone: "good" | "bad" | "unknown"; value: string; text: string; raw: string | null } {
  const p = s.pin;
  if (p.ok === null) return { tone: "unknown", value: "Not checked yet", text: "The company open in Tally has not been checked yet.", raw: null };
  const when = p.at ? ` Checked ${whenText(p.at, now)}.` : "";
  if (p.ok) return { tone: "good", value: "Matches", text: `The company open in Tally is the real one.${when}`, raw: null };
  const plain = knownOrRaw(PIN_RULES, p.problem ?? "", "The company open in Tally could not be confirmed as the real one.");
  return { tone: "bad", value: "Does not match", text: `${plain.text}${when}`, raw: plain.raw };
}

export function registeredSentence(s: PrimarySummaryLike): { tone: "good" | "bad" | "unknown"; value: string; text: string } {
  if (s.registered === null) return { tone: "unknown", value: "Not known yet", text: "No readiness report has said whether the online database knows this computer." };
  return s.registered
    ? { tone: "good", value: "Yes", text: "The online database knows this computer as the office computer." }
    : { tone: "bad", value: "No", text: "The online database does not know this computer yet. Someone has to register it once." };
}

/** One reason the queue has stopped claiming, as a sentence. */
export function plainStop(reason: string): Plain {
  return knownOrRaw([
    [/Tally may be showing a message/i, "Tally may be showing a message on the office screen. Dismiss it there. The queue waits until Tally answers normally."],
    [/clock is \d+ s off/i, "This computer's clock is different from the online database's, so claiming has stopped. Correct the date and time on this computer."],
    [/the journal/i, "The notebook where this computer records every job could not be written, so claiming has stopped."],
    [/put back|pinned company|could not be (checked|confirmed|read)/i, "Claiming is paused because the company open in Tally could not be confirmed as the real one. It tries again by itself."],
  ], reason, "The queue has stopped for a reason this window has no plain sentence for.");
}
