/**
 * JOB: the office agent's own preflight, reported to the database so a person can read why it is not ready without touching the office PC
 * (go-live D-M.286). The same checks as scripts/primary-preflight.ts (which now calls this file), run on each start of the primary mode and on each
 * failed company pin, and sent with erp_agent_preflight_report (migration 0317). Until the machine is registered it is sent again every 5 minutes.
 *
 * The report carries the SHA-256 of the machine key (the same hash scripts/primary-register.ts prints, so a person can see which key to register)
 * and NEVER the key: every line's text is scrubbed of the key before it leaves, and the key is not an argument to anything that is sent.
 */
import { keyHashOf, type PreflightLine } from "./primaryTools.js";
import { readPrimaryConfig } from "./primaryRunner.js";
import { primaryPinProblem, primaryCompanyName } from "./primaryMode.js";
import { tallyCompany } from "../config/company.js";
import { agentMachineId } from "./supabaseClient.js";
import { setPreflightNudge } from "./preflightNudge.js";

type Env = Record<string, string | undefined>;
type RpcClient = { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> };

/** How often an unready (for example unregistered) machine reports again. */
export const PREFLIGHT_EVERY_MS = 5 * 60_000;

/** Pure: the text with every occurrence of the key replaced, so a line can never carry it. */
export const scrubKey = (text: string, key: string): string => (key.length >= 8 ? text.split(key).join("[key]") : text);

/**
 * The checks. `listing` reads Tally's company list (null on failure is expressed by throwing). Never throws itself; every failure is a line.
 */
export async function runPreflightLines(o: { tallyUrl: string; env: Env; readListing: () => Promise<string>; client: RpcClient | null }): Promise<PreflightLine[]> {
  const lines: PreflightLine[] = [];
  const cfg = readPrimaryConfig(o.tallyUrl, o.env);
  if (cfg.ok) lines.push({ name: "the primary settings are complete", ok: true, detail: "" });
  else for (const p of cfg.problems) lines.push({ name: "setting", ok: false, detail: p });

  let listing = "";
  try { listing = await o.readListing(); lines.push({ name: "Tally answers on its port", ok: true, detail: "" }); }
  catch (e) { lines.push({ name: "Tally answers on its port", ok: false, detail: (e as Error).message.slice(0, 120) }); }

  if (listing) {
    const why = primaryPinProblem(primaryCompanyName(o.env) || tallyCompany(), listing, o.env);
    lines.push({ name: "the open company carries the pinned GUID", ok: !why, detail: why ? why.replace(/\s*Nothing was sent to Tally\.?$/, "") : "" });
  }

  const roleName = "the database is reachable and this machine's key is registered as primary";
  if (!o.client) lines.push({ name: roleName, ok: false, detail: "no database client on this machine (sandbox, offline or no service key)" });
  else {
    const machine = agentMachineId(o.env);
    const key = (o.env.MKCP_ERP_AGENT_KEY ?? "").trim();
    if (machine === "unnamed-machine" || !key) lines.push({ name: roleName, ok: false, detail: "no machine id or key to ask with" });
    else {
      try {
        const { data, error } = await o.client.rpc("erp_agent_role", { p_machine: machine, p_key: key });
        const role = typeof data === "string" ? data : null;
        lines.push({ name: roleName, ok: !error && role === "primary", detail: error ? error.message.slice(0, 120) : role === "primary" ? "" : `the database says role "${role ?? "none"}", not primary` });
      } catch (e) { lines.push({ name: roleName, ok: false, detail: (e as Error).message.slice(0, 120) }); }
    }
  }
  const key = (o.env.MKCP_ERP_AGENT_KEY ?? "").trim();
  return lines.map((l) => ({ ...l, detail: scrubKey(l.detail, key) }));
}

/** Pure: the arguments of erp_agent_preflight_report. No key anywhere in them; the hash only. */
export function reportArgs(o: { machine: string; key: string; lines: PreflightLine[]; version: string | null }): Record<string, unknown> {
  return {
    p_machine: o.machine,
    p_key_hash: keyHashOf(o.key),
    p_lines: o.lines.map((l) => ({ name: scrubKey(l.name, o.key), ok: l.ok, detail: scrubKey(l.detail, o.key) })),
    p_ready: o.lines.length > 0 && o.lines.every((l) => l.ok),
    p_version: o.version,
  };
}

export class PreflightReporter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastAt = 0;
  private lastReady = false;
  private busy = false;
  readonly status: { reports: number; lastAt: string | null; lastReady: boolean | null; lastError: string | null } = { reports: 0, lastAt: null, lastReady: null, lastError: null };
  constructor(private o: {
    run: () => Promise<PreflightLine[]>;
    send: (args: Record<string, unknown>) => Promise<void>;
    machine: string; key: string; version: string | null;
    everyMs?: number; now?: () => number; log?: (l: string) => void;
  }) {}

  /** Report now (once at a time). Never throws. */
  async reportNow(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const now = this.o.now ?? Date.now;
    try {
      const lines = await this.o.run();
      const args = reportArgs({ machine: this.o.machine, key: this.o.key, lines, version: this.o.version });
      await this.o.send(args);
      this.lastReady = args.p_ready === true;
      this.status.reports++; this.status.lastAt = new Date(now()).toISOString(); this.status.lastReady = this.lastReady; this.status.lastError = null;
    } catch (e) {
      this.status.lastError = scrubKey((e as Error).message, this.o.key).slice(0, 160);
      (this.o.log ?? (() => {}))(`could not send the preflight report: ${this.status.lastError}`);
    } finally { this.lastAt = now(); this.busy = false; }
  }

  /** A pin failed: report again, but not more often than the periodic rate. */
  nudge(): void {
    const now = (this.o.now ?? Date.now)();
    if (now - this.lastAt >= (this.o.everyMs ?? PREFLIGHT_EVERY_MS)) void this.reportNow();
  }

  /** Report at once, then every `everyMs` while the last report was not ready (a ready machine reports again only on a failed pin). */
  start(): void {
    setPreflightNudge(() => this.nudge());
    const every = this.o.everyMs ?? PREFLIGHT_EVERY_MS;
    const loop = async (): Promise<void> => {
      if (this.stopped) return;
      if (!this.lastReady || this.status.reports === 0) await this.reportNow();
      this.timer = setTimeout(() => { void loop(); }, every);
      this.timer.unref?.();
    };
    void loop();
  }
  private stopped = false;
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; setPreflightNudge(null); }
}
