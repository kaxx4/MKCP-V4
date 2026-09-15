/**
 * The four facts about the pipeline, derived in ONE place.
 *
 * Two windows now ask the same questions — the main status board's KPI strip
 * and the always-on-top Quick View — and the answers are not obvious: several
 * of them turn on the difference between "zero" and "never counted", which took
 * a sweep of the whole window to get right (see 43a5bd5, and the vault's
 * [[Agent Window Display Contract]]). Two copies of that reasoning would drift,
 * and the copy that drifts is the one that starts reassuring people again.
 *
 * So this module owns the MEANING and neither window owns any of it. Each
 * window still does its own fetching — they poll at different rates for
 * different reasons — but both hand the results to these functions.
 *
 * The rule every one of them follows: a status has THREE states, not two.
 * Known good, known bad, and NOT MEASURED — and the third must not look like
 * the first. Every bug this replaced was a falsy default (`?? 0`, `!== false`)
 * turning "could not ask" into a confident, reassuring answer.
 */

export type FactTone = "good" | "bad" | "warn" | "unknown";

export interface AgentFact {
  label: string;
  /** Short enough to be the hero of a tile. Never a number we did not measure. */
  value: string;
  tone: FactTone;
  /** The second line: where the figure came from, or why there isn't one. */
  sub: string;
  /** Worth a tinted strip rather than a quiet white card. */
  attention: boolean;
}

/** `/api/tally/health`. `null` means THIS APP'S OWN server did not answer. */
export interface HealthLike {
  connected: boolean;
  tallyUrl: string;
  busy?: boolean;
  error?: string;
}

/** `/api/push-agent/status`. `null` means the local server did not answer. */
export interface PushStatusLike {
  enabled: boolean;
  agentId: string;
  lastTick: string | null;
  queueStats: { pending: number; pushing: number; failed: number };
  /** When those counts were last read out of Supabase; null/absent = never.
   *  Written by server/src/services/pushAgent.ts:refreshQueueStats. */
  queueStatsAt?: string | null;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-IN");

/**
 * Is TallyPrime reachable — and if not, WHICH process is missing?
 *
 * `health == null` is this app's own server failing to answer, which is a
 * different failure with a different fix. Naming Tally's port 9000 for it sends
 * the reader into TallyPrime's connectivity settings for a problem that is not
 * there. Observed 15-Sep-2026 with the local server stopped.
 */
export function tallyFact(health: HealthLike | null, baseLabel: string): AgentFact {
  if (health == null) {
    return {
      label: "Tally",
      value: "Unknown",
      tone: "unknown",
      sub: `this app's own server on ${baseLabel} is not answering`,
      attention: true,
    };
  }
  if (!health.connected) {
    return {
      label: "Tally",
      value: "Offline",
      tone: "bad",
      sub: "TallyPrime is not answering on :9000",
      attention: true,
    };
  }
  return {
    label: "Tally",
    value: "Connected",
    tone: "good",
    sub: health.busy ? "busy with a sync — inferred, not a fresh ping" : health.tallyUrl || baseLabel,
    attention: false,
  };
}

/** Is the drain loop running? `null` status is not "Disabled" — it is unread. */
export function drainFact(pushStatus: PushStatusLike | null): AgentFact {
  if (!pushStatus) {
    return {
      label: "Push drain",
      value: "Unknown",
      tone: "unknown",
      sub: "the local server did not answer, so its state is unknown",
      attention: true,
    };
  }
  if (!pushStatus.enabled) {
    return {
      label: "Push drain",
      value: "Disabled",
      tone: "warn",
      sub: "queued vouchers will stay queued",
      attention: true,
    };
  }
  return {
    label: "Push drain",
    value: "Running",
    tone: "good",
    sub: pushStatus.lastTick ? `last tick ${clock(pushStatus.lastTick)}` : "no tick yet",
    attention: false,
  };
}

/**
 * How deep is the queue.
 *
 * `queueStats` holds its initial zeros until a drain tick has actually read
 * them out of Supabase, and three paths never get there: the agent could not
 * start (no service key), the first tick has not finished, or the read failed.
 * A queue reported as empty is a queue nobody goes to look at.
 */
export function queueFact(pushStatus: PushStatusLike | null): AgentFact {
  const at = pushStatus?.queueStatsAt ?? null;
  if (!pushStatus) {
    /* Not "never counted" — the agent may have counted it a hundred times; we
       could not ask. Two different unknowns with two different fixes. */
    return {
      label: "Queue",
      value: "—",
      tone: "unknown",
      sub: "the local server did not answer, so the depth is unknown",
      attention: true,
    };
  }
  if (!at) {
    return {
      label: "Queue",
      value: "—",
      tone: "unknown",
      sub: "never counted — the drain agent has not reported a depth",
      attention: true,
    };
  }
  const { pending, pushing, failed } = pushStatus.queueStats;
  const waiting = pending + pushing;
  return {
    label: "Queue",
    value: String(waiting),
    tone: failed > 0 ? "warn" : "good",
    sub: failed > 0 ? `${failed} failed · counted ${clock(at)}` : `nothing waiting · counted ${clock(at)}`,
    attention: failed > 0,
  };
}

/** One channel of the Supabase push status store. */
export interface ChannelLike {
  lastAt: string | null;
  success: boolean | null;
  error: string | null;
}

/**
 * Is the mirror accepting writes.
 *
 * `success` is `null` on a channel nothing has tried, and `success !== false`
 * counted that as fine — so an app that had pushed nothing reported the mirror
 * "OK" in the largest type on the screen.
 *
 * ONLY VALID IN THE WINDOW THAT DOES THE PUSHING. `supabaseSyncStatusStore` is
 * plain in-memory zustand with no persistence and no cross-window channel, and
 * every Electron BrowserWindow is its own renderer process with its own module
 * instance. In the Quick View window all three channels are `null` forever,
 * because that window never pushes — so Quick View deliberately does not show
 * this fact rather than showing a permanent "Not tried". (15-Sep-2026)
 */
export function cloudFact(config: ChannelLike, masters: ChannelLike, vouchers: ChannelLike): AgentFact {
  const channels = [config, masters, vouchers];
  const failing = channels.some((c) => c.success === false);
  const tried = channels.some((c) => c.success !== null);
  const lastAt = vouchers.lastAt || masters.lastAt || config.lastAt;

  if (failing) {
    return {
      label: "Supabase",
      value: "Error",
      tone: "bad",
      /* Not "last write": `lastAt` is stamped on every ATTEMPT, so a failing
         channel was reporting a write that never happened. */
      sub: lastAt ? `last tried ${clock(lastAt)}` : "no push since this app started",
      attention: true,
    };
  }
  if (!tried) {
    return {
      label: "Supabase",
      value: "Not tried",
      tone: "unknown",
      /* The store is in-memory, so no timestamp means "not since this app
         started", never "never". */
      sub: "no push since this app started",
      attention: false,
    };
  }
  return {
    label: "Supabase",
    value: "OK",
    tone: "good",
    sub: lastAt ? `last write ${clock(lastAt)}` : "no push since this app started",
    attention: false,
  };
}

/** For a tile component whose tone vocabulary is the design system's, not this
 *  module's. `unknown` deliberately maps to warn: it needs a person. */
export function toneToStatTile(tone: FactTone): "danger" | "warn" | "success" | undefined {
  return tone === "bad" ? "danger" : tone === "warn" || tone === "unknown" ? "warn" : tone === "good" ? "success" : undefined;
}
