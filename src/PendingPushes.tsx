/**
 * Approval gate for vouchers pushed from the web dashboard.
 *
 * The web side can ASK for a voucher to be booked; only this machine — the one
 * holding the books — decides that it is. Nothing reaches Tally until someone
 * presses Import here. That asymmetry is deliberate: pulling data out of Tally
 * is safe to automate, writing into live books is not.
 *
 * Polls the local proxy the same way AgentStatus polls health and logs. No
 * Supabase access from the renderer — the listener owns that, and the approval
 * decision must be made from the machine, not from a browser that could be
 * anywhere.
 *
 * ── Two things changed on 15-Sep-2026 ────────────────────────────────────
 *
 * It was painted in INLINE HEX — `#fffbeb`, `#e7f6ee`, `#fbeaea`, `#2f5fe0`
 * — which are the warn / success / danger / accent tokens spelled out by hand.
 * Being literals, they were invisible to the token sweep, immune to the bento
 * theme layer that repaints every other surface on this screen, and free to
 * drift: this is the one panel that BLOCKS work, and its red was not the red
 * used by anything else. It now uses the same classes as every other panel.
 *
 * And its poll swallowed failure silently: `catch {}` left the last known list
 * on screen, so a list frozen at 10:04 because the local server died looked
 * exactly like a list that was genuinely empty. An approval queue that cannot
 * be refreshed must say so — the whole point of it is that someone is waiting.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, X } from "lucide-react";

const BASE = (import.meta as any).env?.VITE_TALLY_PROXY || "http://localhost:3100";

interface PendingPush {
  id: number;
  label: string;
  voucherType: string | null;
  deviceName: string | null;
  createdAt: string;
}

export function PendingPushes() {
  const [pending, setPending] = useState<PendingPush[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  /* When the list on screen was last actually confirmed against the server —
     null until the first successful read. */
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${BASE}/api/tally/pending-pushes`);
      const rows = await r.json();
      if (Array.isArray(rows)) {
        setPending(rows as PendingPush[]);
        setConfirmedAt(new Date().toISOString());
        setStale(false);
      }
    } catch {
      /* Proxy not up. Keep the last known list — clearing it would claim
         "nothing is waiting", which is the one thing we cannot know right
         now — but mark it, so nobody reads it as current. */
      setStale(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 4000);
    return () => clearInterval(id);
  }, [refresh]);

  async function decide(id: number, action: "approve" | "reject") {
    setBusyId(id);
    try {
      const r = await fetch(`${BASE}/api/tally/pending-pushes/${id}/${action}`, { method: "POST" });
      // 200 with ok:false is a real answer (Tally rejected the voucher), not a
      // transport failure — show the message either way.
      const result = (await r.json()) as { ok: boolean; message: string };
      setNote({ ok: result.ok, text: result.message });
    } catch (e: any) {
      setNote({ ok: false, text: `Could not reach the sync agent: ${e?.message ?? e}` });
    } finally {
      setBusyId(null);
      void refresh();
    }
  }

  /* Nothing waiting, nothing to report, and the list is current: render nothing
     at all rather than an empty panel taking up room on a screen that is mostly
     status already. A STALE empty list is not the same thing and is not hidden
     — but only once we have managed one good read, otherwise the push-queue
     panel below already says the server is down and this would repeat it. */
  if (pending.length === 0 && !note && !(stale && confirmedAt)) return null;

  return (
    <section
      className={`mb-4 rounded-xl border px-4 py-4 ${
        pending.length ? "border-warn-200 bg-warn-soft" : "border-neutral-200 bg-white"
      }`}
    >
      <h3 className="text-[15px] font-bold text-neutral-900">
        Vouchers waiting for your approval{pending.length ? ` (${pending.length})` : ""}
      </h3>
      <p className="mt-1 text-xs text-neutral-600">
        Pushed from the web dashboard. Nothing is written into Tally until you import it here.
      </p>

      {stale && confirmedAt && (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-danger-soft px-2.5 py-2 text-[11.5px] text-danger-700">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            The sync agent's server stopped answering, so this list is frozen as it was at{" "}
            {new Date(confirmedAt).toLocaleTimeString("en-IN")} — approving is not possible and something
            new may have arrived since.
          </span>
        </p>
      )}

      {note && (
        <div
          className={`mt-3 rounded-lg px-2.5 py-2 text-[12.5px] ${
            note.ok ? "bg-success-soft text-success-700" : "bg-danger-soft text-danger-700"
          }`}
        >
          {note.text}
        </div>
      )}

      {pending.map((p) => (
        <div key={p.id} className="flex flex-wrap items-center gap-2.5 border-t border-neutral-200/70 py-2.5">
          <div className="min-w-0 flex-1 basis-48">
            <div className="text-[13.5px] font-semibold text-neutral-900">{p.label}</div>
            <div className="text-[11.5px] text-neutral-600">
              {p.voucherType ?? "Voucher"} · from {p.deviceName ?? "web"} ·{" "}
              {new Date(p.createdAt).toLocaleTimeString("en-IN")}
            </div>
          </div>
          {/* Decline first and quiet, Import second and primary — the one that
              writes into live books is the one that has to be aimed at. */}
          <button
            onClick={() => void decide(p.id, "reject")}
            disabled={busyId === p.id || stale}
            title={stale ? "The sync agent's server is not answering, so nothing can be decided right now." : undefined}
            className="btn-secondary btn-sm tap-y"
          >
            <X size={12} />
            Decline
          </button>
          <button
            onClick={() => void decide(p.id, "approve")}
            disabled={busyId === p.id || stale}
            title={stale ? "The sync agent's server is not answering, so nothing can be decided right now." : undefined}
            className="btn-primary btn-sm tap-y"
          >
            {busyId === p.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            {busyId === p.id ? "Importing…" : "Import into Tally"}
          </button>
        </div>
      ))}
    </section>
  );
}
