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
 */
import { useCallback, useEffect, useState } from "react";

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

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${BASE}/api/tally/pending-pushes`);
      const rows = await r.json();
      if (Array.isArray(rows)) setPending(rows as PendingPush[]);
    } catch {
      /* proxy not up — leave the list as-is rather than flashing empty */
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

  // Nothing waiting and nothing to report: render nothing at all rather than an
  // empty panel taking up room on a screen that is mostly status already.
  if (pending.length === 0 && !note) return null;

  return (
    <section
      style={{
        border: "1px solid #e7e7e3",
        borderRadius: 12,
        padding: 16,
        marginBottom: 16,
        background: pending.length ? "#fffbeb" : "#ffffff",
      }}
    >
      <h3 style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 700 }}>
        Vouchers waiting for your approval{pending.length ? ` (${pending.length})` : ""}
      </h3>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "#646469" }}>
        Pushed from the web dashboard. Nothing is written into Tally until you import it here.
      </p>

      {note && (
        <div
          style={{
            marginBottom: 12,
            padding: "8px 10px",
            borderRadius: 8,
            fontSize: 12.5,
            background: note.ok ? "#e7f6ee" : "#fbeaea",
            color: note.ok ? "#15803d" : "#b91c1c",
          }}
        >
          {note.text}
        </div>
      )}

      {pending.map((p) => (
        <div
          key={p.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 0",
            borderTop: "1px solid #f0f0ee",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>{p.label}</div>
            <div style={{ fontSize: 11.5, color: "#646469" }}>
              {p.voucherType ?? "Voucher"} · from {p.deviceName ?? "web"} ·{" "}
              {new Date(p.createdAt).toLocaleTimeString()}
            </div>
          </div>
          <button
            onClick={() => void decide(p.id, "reject")}
            disabled={busyId === p.id}
            style={{
              padding: "6px 12px",
              borderRadius: 8,
              border: "1px solid #e7e7e3",
              background: "#fff",
              cursor: busyId === p.id ? "not-allowed" : "pointer",
              fontSize: 12.5,
            }}
          >
            Decline
          </button>
          <button
            onClick={() => void decide(p.id, "approve")}
            disabled={busyId === p.id}
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              border: "none",
              background: "#2f5fe0",
              color: "#fff",
              fontWeight: 600,
              cursor: busyId === p.id ? "not-allowed" : "pointer",
              fontSize: 12.5,
            }}
          >
            {busyId === p.id ? "Importing…" : "Import into Tally"}
          </button>
        </div>
      ))}
    </section>
  );
}
