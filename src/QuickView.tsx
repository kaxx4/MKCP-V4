import { SERVER_BASE } from "./config/serverUrl";
/**
 * Quick View — the always-on-top window, at `#/pip`.
 *
 * ── Why it exists at all ──────────────────────────────────────────────────
 *
 * `public/electron.js:createPipWindow()` has been opening a 360×520
 * always-on-top window at `#/pip` since it was written, and NOTHING in this
 * renderer read that hash — there is no router in `src/`. So the tray's
 * "Toggle Quick View" and Ctrl+Shift+P both produced the entire 1,100-line
 * status board, eight panels and all, inside a 280–360px window. It did not
 * overflow, which is exactly why it survived: not visibly broken, just not what
 * its name promises. (Audited 15-Sep-2026.)
 *
 * Removing the window was the other option and is the wrong one — the tray item
 * and the global shortcut are both live, registered entry points a person can
 * hit today.
 *
 * ── What it shows, and what it deliberately does not ──────────────────────
 *
 * It is small and on top of everything else, so it is read from across the room
 * while the operator is doing something else. That buys room for exactly one
 * question: **is the pipeline alive?**
 *
 *   1. Tally · Push drain · Queue — the three facts the local server knows.
 *      (A "vouchers waiting for approval" tile used to sit above these; the
 *      approval listener it read was removed 19-Oct-2026, TALLY-27.)
 *
 * NOT the Supabase channel state, even though the main window's KPI strip
 * carries it. `supabaseSyncStatusStore` is plain in-memory zustand, and every
 * Electron BrowserWindow is its own renderer process with its own copy — this
 * window never pushes, so all three channels read `null` here forever and the
 * tile would say "Not tried" on a machine that had been mirroring all day. A
 * display that cannot be right is left out rather than shrunk. See
 * status/agentFacts.ts:cloudFact.
 *
 * Every figure is derived by the SAME functions as the main window's KPI strip
 * (status/agentFacts.ts), so the two windows cannot disagree — including on the
 * part that is easy to get wrong, which is telling "zero" apart from "never
 * counted".
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Chip, chipToneOf } from "./components/ui";
import {
  tallyFact, drainFact, queueFact,
  type AgentFact, type HealthLike, type PushStatusLike,
} from "./status/agentFacts";
/* After go-live the drain and the queue depth describe a queue nothing uses, so on the office computer they give way to the office facts. */
import { officeFact, claimFact, primaryIsOn, type PrimarySummaryLike } from "./status/primaryFacts";

const BASE = SERVER_BASE;
const BASE_LABEL = BASE.replace(/^https?:\/\//, "");

/** Same 10 s cadence as the main window: the two should not disagree about how old a reading is because one looked more recently. */
const POLL_MS = 10_000;

/** One reading, sized to be read at a glance rather than studied: the label, its status as a chip with words, and where the reading came from. */
function FactRow({ fact }: { fact: AgentFact }) {
  return (
    <li className="card">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 pt-3">
        <span className="text-sm font-medium text-neutral-900">{fact.label}</span>
        <Chip tone={chipToneOf(fact.tone)}>{fact.value}</Chip>
      </div>
      {/* Never shortened. The sub-line is where "never counted" lives, and cutting it turns an honest unknown back into a bare figure. */}
      <p className="px-3 pb-3 pt-2 text-xs text-neutral-700 wrap-anywhere">{fact.sub}</p>
    </li>
  );
}

export default function QuickView() {
  const [health, setHealth] = useState<HealthLike | null>(null);
  const [pushStatus, setPushStatus] = useState<PushStatusLike | null>(null);
  const [office, setOffice] = useState<PrimarySummaryLike | null>(null);
  /* When the server last actually answered. Null until it has once. */
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [polling, setPolling] = useState(false);

  const poll = useCallback(async () => {
    setPolling(true);
    try {
      const [h, p, o] = await Promise.all([
        fetch(`${BASE}/api/tally/health`).then((r) => r.json()).catch(() => null),
        fetch(`${BASE}/api/push-agent/status`).then((r) => r.json()).catch(() => null),
        fetch(`${BASE}/api/primary/summary`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      setHealth(h);
      setPushStatus(p);
      setOffice(o);
      const answered = h != null || p != null;
      setReachable(answered);
      if (answered) setConfirmedAt(new Date().toISOString());
    } finally {
      setPolling(false);
    }
  }, []);

  useEffect(() => {
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  const facts = primaryIsOn(office)
    ? [tallyFact(health, BASE_LABEL), officeFact(office), claimFact(office)]
    : [tallyFact(health, BASE_LABEL), drainFact(pushStatus), queueFact(pushStatus)];

  return (
    /* A single column with a 12 px gutter: the narrowest the window can be made is 280 px (public/electron.js, minWidth 280). */
    <div className="min-h-screen bg-bg-page p-3">
      <header className="mb-3 flex items-center gap-2">
        <h1 className="flex-1 text-xl text-neutral-950">Sync agent</h1>
        <button
          onClick={() => void poll()}
          disabled={polling}
          title={polling ? "Already reading." : `Read again now. It refreshes on its own every ${POLL_MS / 1000} seconds.`}
          aria-label="Refresh now"
          className="btn-icon"
        >
          <RefreshCw size={16} className={polling ? "animate-spin" : ""} />
        </button>
      </header>

      {/* 1: is the pipeline alive */}
      <ul className="flex flex-col gap-2">
        {facts.map((f) => <FactRow key={f.label} fact={f} />)}
      </ul>

      {/* 2: how old everything above is. A small always-on-top window is the easiest place in the product to leave a stale number sitting in
          front of someone for an hour. */}
      <p className="mt-3 text-xs text-neutral-700">
        {reachable === false
          ? confirmedAt
            ? `${BASE_LABEL} stopped answering. It last did at ${new Date(confirmedAt).toLocaleTimeString("en-IN")}. Nothing above is a current reading.`
            : `The local server on ${BASE_LABEL} is not answering.`
          : confirmedAt
            ? `Confirmed ${new Date(confirmedAt).toLocaleTimeString("en-IN")} · every ${POLL_MS / 1000} seconds`
            : "Reading"}
      </p>
    </div>
  );
}
