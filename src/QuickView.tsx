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
 * question: **is the pipeline alive, and is anything waiting on me?**
 *
 *   1. Vouchers waiting for approval — the only thing here that BLOCKS work.
 *      A web-pushed voucher sits until someone presses Import in the main
 *      window, and a pending approval nobody sees is a voucher never booked.
 *   2. Tally · Push drain · Queue — the three facts the local server knows.
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
import clsx from "clsx";
import { AlertTriangle, Inbox, RefreshCw } from "lucide-react";
import {
  tallyFact, drainFact, queueFact,
  type AgentFact, type HealthLike, type PushStatusLike,
} from "./status/agentFacts";

const BASE = (import.meta as any).env?.VITE_TALLY_PROXY || "http://localhost:3100";
const BASE_LABEL = BASE.replace(/^https?:\/\//, "");

/** Same 10s cadence as the main window — the two should not disagree about how
 *  old a reading is because one of them looked more recently. */
const POLL_MS = 10_000;

const TONE_TEXT: Record<AgentFact["tone"], string> = {
  good: "text-success-700",
  bad: "text-danger-700",
  warn: "text-warn-800",
  unknown: "text-warn-800",
};

const TONE_TINT: Record<AgentFact["tone"], string> = {
  good: "bg-success-soft",
  bad: "bg-danger-soft",
  warn: "bg-warn-soft",
  unknown: "bg-warn-soft",
};

/** One fact, sized to be read at a glance rather than studied. */
function FactRow({ fact }: { fact: AgentFact }) {
  return (
    <li
      className={clsx(
        "rounded-xl px-3 py-2.5",
        fact.attention ? TONE_TINT[fact.tone] : "bg-white ring-1 ring-black/[0.06]",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-neutral-700">
          {fact.label}
        </span>
        <span className={clsx("font-mono text-[17px] font-black tabular-nums", TONE_TEXT[fact.tone])}>
          {fact.value}
        </span>
      </div>
      {/* Never truncated. The sub-line is where "never counted" lives, and
          cropping it turns an honest unknown back into a bare figure. */}
      <p className="mt-0.5 text-[10.5px] leading-snug text-neutral-700">{fact.sub}</p>
    </li>
  );
}

export default function QuickView() {
  const [health, setHealth] = useState<HealthLike | null>(null);
  const [pushStatus, setPushStatus] = useState<PushStatusLike | null>(null);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  /* When the server last actually answered. Null until it has once. */
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [polling, setPolling] = useState(false);

  const poll = useCallback(async () => {
    setPolling(true);
    try {
      const [h, p, pend] = await Promise.all([
        fetch(`${BASE}/api/tally/health`).then((r) => r.json()).catch(() => null),
        fetch(`${BASE}/api/push-agent/status`).then((r) => r.json()).catch(() => null),
        fetch(`${BASE}/api/tally/pending-pushes`).then((r) => r.json()).catch(() => null),
      ]);
      setHealth(h);
      setPushStatus(p);
      /* A failed fetch must not collapse to 0 — "nothing is waiting for you" is
         the single most reassuring thing this window can say, and it is exactly
         the claim an unanswered request cannot support. */
      setPendingCount(Array.isArray(pend) ? pend.length : null);
      const answered = h != null || p != null || Array.isArray(pend);
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

  const facts = [
    tallyFact(health, BASE_LABEL),
    drainFact(pushStatus),
    queueFact(pushStatus),
  ];

  const waiting = pendingCount ?? 0;

  return (
    /* `min-h-screen` and nothing wider than the window: at 280px this is a
       single column with a 12px gutter, which is the narrowest the Electron
       window can be made (public/electron.js, minWidth 280). */
    <div className="min-h-screen bg-bg-page px-3 py-3">
      <header className="mb-2.5 flex items-center gap-2">
        <h1 className="flex-1 text-[13px] font-bold text-neutral-900">Sync agent</h1>
        <button
          onClick={() => void poll()}
          disabled={polling}
          title={polling ? "Already reading…" : `Re-read now. It refreshes on its own every ${POLL_MS / 1000} s.`}
          aria-label="Refresh now"
          className="btn-icon h-9 w-9 shrink-0 tap"
        >
          <RefreshCw size={14} className={polling ? "animate-spin" : ""} />
        </button>
      </header>

      {/* 1 — the only thing here that blocks work, and it is allowed to shout. */}
      {pendingCount == null ? (
        <div className="mb-2.5 flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2.5 text-[11.5px] text-warn-800">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            Cannot tell whether anything is waiting for approval — the local server did not answer.
          </span>
        </div>
      ) : waiting > 0 ? (
        <div className="mb-2.5 rounded-xl bg-warn-soft px-3 py-3">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[28px] font-black leading-none tabular-nums text-warn-800">
              {waiting}
            </span>
            <span className="text-[12px] font-semibold text-warn-800">
              voucher{waiting === 1 ? "" : "s"} waiting for you
            </span>
          </div>
          <p className="mt-1 text-[10.5px] leading-snug text-warn-800">
            Pushed from the web dashboard. Nothing reaches Tally until you import {waiting === 1 ? "it" : "them"} in
            the main window.
          </p>
        </div>
      ) : (
        <p className="mb-2.5 flex items-center gap-1.5 rounded-xl bg-white px-3 py-2.5 text-[11.5px] text-neutral-600 ring-1 ring-black/[0.06]">
          <Inbox size={13} className="shrink-0 text-neutral-400" />
          Nothing waiting for your approval.
        </p>
      )}

      {/* 2 — is the pipeline alive */}
      <ul className="flex flex-col gap-2">
        {facts.map((f) => <FactRow key={f.label} fact={f} />)}
      </ul>

      {/* 3 — how old everything above is. A small always-on-top window is the
             easiest place in the product to leave a stale number sitting in
             front of someone for an hour. */}
      <p className="mt-2.5 text-[10px] leading-snug text-neutral-500">
        {reachable === false
          ? confirmedAt
            ? `${BASE_LABEL} stopped answering — it last did at ${new Date(confirmedAt).toLocaleTimeString("en-IN")}. Nothing above is a current reading.`
            : `The local server on ${BASE_LABEL} is not answering.`
          : confirmedAt
            ? `Confirmed ${new Date(confirmedAt).toLocaleTimeString("en-IN")} · every ${POLL_MS / 1000} s`
            : "Reading…"}
      </p>
    </div>
  );
}
