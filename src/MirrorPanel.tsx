import { SERVER_BASE } from "./config/serverUrl";
/**
 * The Mirror card: sync history, the mirror snapshot and the push log, on the agent itself.
 *
 * The web dashboard has all three. This machine is the one doing the work, and it had counters ("Pending 4, Failed 1") plus a console log. So the
 * screen in the office could say a push had failed but not WHICH voucher, for which party, or why, and the person standing in front of it had to
 * open the web app on another device to find out. See server/src/services/mirrorPanel.ts.
 *
 * The refusal text is shown in full and never truncated. Each one names the thing to fix (a ledger Tally spells differently, a filed GST period)
 * and the reason is the only useful part of it.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Database, RefreshCw, Check, AlertTriangle, Loader2, Minus, Clock, PenLine, GitCompareArrows,
} from "lucide-react";
import { Card, Chip, Note, Row, RowList, Tile, type ChipTone, type RowTone } from "./components/ui";

/* The edit-log action chips. These are CATEGORIES, not states, so only the one that carries real meaning keeps a status colour. */
const ACTION_TONE: Record<string, ChipTone> = { upsert: "info", delete: "bad", export: "neutral", import: "neutral" };

const BASE = SERVER_BASE;

interface SyncRun {
  startedAt: string; completedAt: string | null; syncType: string | null;
  success: boolean; counts: Record<string, number> | null; errors: string[] | null; full: boolean;
}
interface Snapshot { table: string; rows: number | null; newest: string | null }
interface PushRow {
  id: string; status: string; voucherType: string; voucherNumber: string; party: string;
  amount: number; attempts: number; lastError: string | null;
  createdAt: string; claimedAt: string | null; pushedAt: string | null; waitedSeconds: number | null;
}
interface EditRow {
  id: number; at: string; who: string; domain: string; table: string; action: string; count: number | null;
}
interface WhoAmI {
  app?: string; version?: string; pid?: number; startedAt?: string;
  role?: string | null; pushAgentEnabledEnv?: boolean; hasSupabaseKey?: boolean;
}

interface Panel {
  company: string; offline: boolean; syncs: SyncRun[]; lastFullSyncAt: string | null;
  snapshot: Snapshot[]; pushes: PushRow[]; edits: EditRow[];
  pushLatency: { count: number; pickupMedian: number | null; inTallyMedian: number | null; inTallySlowest: number | null };
  error?: string;
}

const n = (v: number | null | undefined) =>
  v == null ? "not known" : v.toLocaleString("en-IN");

const when = (iso: string | null): string => {
  if (!iso) return "not recorded";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
};

/* One red, one green: a push's state is told in the same chip tones as everywhere else on this screen. */
const STATUS_TONE: Record<string, ChipTone> = {
  succeeded: "good", pending: "info", claimed: "info", pushing: "info", failed: "bad", cancelled: "neutral",
};
const STATUS_ROW: Record<string, RowTone> = {
  succeeded: "success", pending: "accent", claimed: "accent", pushing: "accent", failed: "danger", cancelled: "neutral",
};
const STATUS_WORD: Record<string, string> = {
  succeeded: "done", pending: "waiting", claimed: "picked up", pushing: "being sent", failed: "refused", cancelled: "cancelled",
};
const ACTION_WORD: Record<string, string> = { upsert: "saved", delete: "deleted", export: "exported", import: "imported" };

declare const __APP_VERSION__: string;

/**
 * Is the server on this computer's port actually OURS? It can be a leftover copy from an earlier session or a second copy of the app. When it
 * is, this app's own server never starts, and every screen here talks to an older copy that was started with a different setup.
 */
function StaleServerBanner({ who, reachable }: { who: WhoAmI | null; reachable: boolean }) {
  const mine = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : null;
  const theirs = who?.version;
  /* Only when we can actually TELL. An older server has no /api/whoami at all, which is itself the signal. A network blip is not. */
  const mismatch = reachable && (!who || (!!mine && !!theirs && theirs !== mine && theirs !== "unknown"));
  if (!mismatch) return null;

  return (
    <Note tone="warn" icon={AlertTriangle}>
      <p className="font-medium">
        Another copy of this program is already running on this computer. This window is talking to that copy, not to its own.
      </p>
      <p>
        {who?.version
          ? <>That copy is version <strong className="font-medium">{who.version}</strong>{who.startedAt ? <>, started {new Date(who.startedAt).toLocaleString("en-IN")}</> : null}.
              This window is version <strong className="font-medium">{mine}</strong>.</>
          : <>It is too old to say which version it is.</>}
      </p>
      <p>
        Everything on this screen comes from that copy, and it was started with whatever settings existed then. Close the other copy, then
        close and open this app again.
      </p>
    </Note>
  );
}

interface MirrorProps {
  /** True only on a machine where office mode is off. The queue timing and the push log describe the old push queue, which nothing feeds after go-live. */
  showOldQueue?: boolean;
}

export function MirrorPanel({ showOldQueue = true }: MirrorProps) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [who, setWho] = useState<WhoAmI | null>(null);
  const [reachable, setReachable] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      /* whoami FIRST, and separately: if the wrong copy is answering, that is the thing to say, and it explains whatever the panel does next. */
      try {
        const w = await fetch(`${BASE}/api/whoami`);
        setReachable(true);
        setWho(w.ok ? ((await w.json()) as WhoAmI) : null);
      } catch {
        setReachable(false);
        setWho(null);
      }
      const r = await fetch(`${BASE}/api/mirror/panel?limit=25`);
      setPanel(r.ok ? await r.json() : null);
    } catch {
      setPanel(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => { void load(); }, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const refresh = (
    <button
      onClick={() => void load()}
      disabled={busy}
      className="btn-icon shrink-0"
      aria-label="Read the online copy again"
      title={busy ? "Reading the online copy" : "Read the online copy again now"}
    >
      <RefreshCw size={16} className={busy ? "animate-spin" : ""} />
    </button>
  );

  const card = (children: React.ReactNode) => (
    <Card
      collapsible
      icon={GitCompareArrows}
      title="Mirror"
      sub="What the online copy of Tally holds, and what has been sent to it."
      chip={panel && !panel.offline ? <Chip plain>{panel.company}</Chip> : undefined}
    >
      {children}
    </Card>
  );

  if (!panel) {
    return card(
      <>
        <StaleServerBanner who={who} reachable={reachable} />
        <Tile>
          <p className="flex items-center gap-3 text-sm text-neutral-700">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Clock size={16} />}
            {busy ? "Reading the online copy"
              : reachable
                ? "This app's server answered, but not with this panel. See the note above."
                : "This app's own server could not be reached."}
          </p>
        </Tile>
      </>,
    );
  }

  if (panel.offline) {
    return card(
      <Note tone="warn" icon={AlertTriangle}>
        <p>The online database is not set up or cannot be reached from this computer, so there is nothing to read. {panel.error}</p>
      </Note>,
    );
  }

  const lat = panel.pushLatency;

  return card(
    <>
      <StaleServerBanner who={who} reachable={reachable} />

      {showOldQueue && (
        <>
          {/* How fast a queued voucher reaches Tally (old push queue) */}
          <Tile title="How fast the old queue reaches Tally" aside={refresh}>
            {lat.count === 0 ? (
              <p className="text-sm text-neutral-700">Nothing has been sent yet, so there is no timing to show.</p>
            ) : (
              <>
                {/* TWO figures, never one: this app noticing a voucher and Tally importing it are different things with different remedies. */}
                <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-700">
                  <span>
                    <span className="font-display text-2xl text-neutral-950">{lat.pickupMedian ?? "not known"} seconds</span>{" "}
                    to be noticed
                  </span>
                  <span>
                    <span className="font-display text-2xl text-neutral-950">{lat.inTallyMedian ?? "not known"} seconds</span>{" "}
                    inside Tally
                    {lat.inTallySlowest != null ? `, slowest ${lat.inTallySlowest} seconds` : ""}. {lat.count} measured.
                  </span>
                </div>
                <p className="mt-2 text-xs text-neutral-700">
                  Being noticed takes under a second. The rest is Tally taking in one voucher at a time, so a batch finishes in a line, not all at once.
                </p>
                {lat.pickupMedian != null && lat.pickupMedian > 6 && (
                  <Note tone="warn" icon={AlertTriangle} className="mt-3">
                    <p>
                      Being noticed is slower than the 4-second check, which means the instant signal is not arriving and every voucher is waiting for the
                      next check.
                    </p>
                  </Note>
                )}
              </>
            )}
          </Tile>

          {/* Send log (old push queue) */}
          <Tile title="What the old queue has sent" aside={`${panel.pushes.length} most recent`}>
            {panel.pushes.length === 0 ? (
              <p className="text-sm text-neutral-700">Nothing has been queued yet.</p>
            ) : (
              <div className="max-h-80 overflow-auto">
                <RowList>
                  {panel.pushes.map((p) => (
                    <Row
                      key={p.id}
                      icon={p.status === "succeeded" ? Check : p.status === "failed" ? AlertTriangle : p.status === "cancelled" ? Minus : Loader2}
                      tone={STATUS_ROW[p.status] ?? "neutral"}
                      spinning={p.status !== "succeeded" && p.status !== "failed" && p.status !== "cancelled"}
                      title={p.voucherType}
                      subject={p.voucherNumber}
                      chip={<Chip tone={STATUS_TONE[p.status] ?? "neutral"}>{STATUS_WORD[p.status] ?? p.status}</Chip>}
                      meta={
                        <>
                          {p.party}{p.amount > 0 && <span className="tabular-nums">, ₹{p.amount.toLocaleString("en-IN")}</span>}
                          <br />
                          Queued {when(p.createdAt)}
                          {p.waitedSeconds !== null && p.waitedSeconds >= 0 && `. Took ${p.waitedSeconds} seconds`}
                          {p.attempts > 1 && `. Tried ${p.attempts} times`}
                        </>
                      }
                      /* In full. Cutting a refusal short removes the only useful part. */
                      error={p.lastError}
                    />
                  ))}
                </RowList>
              </div>
            )}
          </Tile>
        </>
      )}

      {/* Sync history. A whole-year read is its own fact: entries made for an earlier date are most of the work here and the small syncs only
          look at today, so a run of small successful syncs makes the copy look fresh while last week's orders quietly never arrive. */}
      <Tile
        title="Sync history"
        aside={
          <span className="inline-flex items-center gap-3">
            last whole-year read: {panel.lastFullSyncAt ? when(panel.lastFullSyncAt) : "none on record"}
            {showOldQueue ? null : refresh}
          </span>
        }
      >
        <div className="max-h-72 overflow-auto">
          <RowList>
            {panel.syncs.map((s, i) => (
              <Row
                key={i}
                icon={s.success ? Check : AlertTriangle}
                tone={s.success ? "success" : "danger"}
                title={<span className="capitalize">{s.syncType ?? "sync"}</span>}
                subject={Object.entries(s.counts ?? {}).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${n(Number(v))} ${k.replace(/_/g, " ")}`).join(", ") || "nothing changed"}
                chip={s.full ? <Chip tone="info" plain>whole year</Chip> : undefined}
                meta={when(s.startedAt)}
              />
            ))}
          </RowList>
        </div>
      </Tile>

      {/* Snapshot: the same figures, in the same shape, as the web Sync Logs page, so the two screens can be read against each other. */}
      <Tile title="What the online database holds">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {panel.snapshot.map((s) => (
            <div key={s.table} className="tile-white">
              <div className="flex items-center gap-2 text-xs text-neutral-700 wrap-anywhere">
                <Database size={16} className="shrink-0 text-neutral-600" aria-hidden="true" />
                {s.table.replace(/^tally_/, "").replace(/_/g, " ")}
              </div>
              <div className="font-display text-2xl tabular-nums text-neutral-950">{n(s.rows)}</div>
              {s.newest && <div className="text-xs text-neutral-700">up to {s.newest}</div>}
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-neutral-700">
          "Not known" means that list could not be read, which is not the same as it being empty.
        </p>
      </Tile>

      {/* Activity log: who changed what, from the same record the web page reads. The agent is the computer people stand in front of when
          something looks wrong, and "did someone change the discount rules?" is one of the first questions. */}
      <Tile title="Who changed what" aside={`${panel.edits.length} most recent`}>
        {panel.edits.length === 0 ? (
          <p className="text-sm text-neutral-700">Nothing has been recorded yet.</p>
        ) : (
          <div className="max-h-72 overflow-auto">
            <RowList>
              {panel.edits.map((e) => (
                <Row
                  key={e.id}
                  icon={PenLine}
                  title={e.domain}
                  subject={[e.count != null ? `${e.count} rows` : null, e.who].filter(Boolean).join(", ")}
                  chip={<Chip tone={ACTION_TONE[e.action] ?? "neutral"}>{ACTION_WORD[e.action] ?? e.action}</Chip>}
                  meta={when(e.at)}
                />
              ))}
            </RowList>
          </div>
        )}
      </Tile>
    </>,
  );
}
