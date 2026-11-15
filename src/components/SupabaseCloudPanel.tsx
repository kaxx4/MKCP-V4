/*
 * Supabase Cloud, rebuilt from 0 on the web dashboard's idiom.
 *
 * ── What was wrong with the old one ───────────────────────────────────────
 *
 * It repeated the header: the KPI strip already says "Supabase — OK / Error /
 * Never" with the last write time under it, and this panel then re-derived the
 * same verdict from the same three channels and printed it four more times as
 * green and red `Pill`s — `bg-success-soft`, `bg-danger-soft` straight off the palette,
 * so "Error" here was a different red from "failed" in the push queue below it.
 *
 * Worse, the word it printed was wrong. `success === null` rendered as
 * "Never", which reads as "this machine has never written to Supabase". The
 * store behind it (store/supabaseSyncStatusStore.ts) is plain in-memory zustand
 * with no persistence — so it is `null` on every launch, and a machine that had
 * been mirroring all week showed three "Never"s every morning until the first
 * push. The honest statement is "not since this app started", and that is what
 * it says now.
 *
 * The retry hint said `retry ~60s` in `text-warn-700` — a fifth colour, and a
 * figure with no unit of trust behind it.
 *
 * ── What this shows instead ───────────────────────────────────────────────
 *
 * The three write channels as three rows, failing ones first, each with the
 * reason in full. Then the one thing this screen genuinely knows and the KPI
 * tile cannot fit: the two DIFFERENT credentials in play. Writes go out through
 * this app's own server on the service key in %APPDATA%; the history lists on
 * this page are read by the window itself on the publishable key that was
 * compiled into the build. They fail independently and they are fixed in
 * different places — which is why "Supabase is fine" and "the history is empty"
 * can both be true at once.
 */
import {
  AlertTriangle, CheckCircle2, Cloud, CloudOff, Clock, Database, KeyRound, RotateCw,
} from "lucide-react";
import { StatusRow, RowGroupHeading } from "./StatusRow";

export interface ChannelStatusLike {
  lastAt: string | null;
  success: boolean | null;
  error: string | null;
  retryScheduled: boolean;
}

interface Props {
  config: ChannelStatusLike;
  masters: ChannelStatusLike;
  vouchers: ChannelStatusLike;
  /** Whether the renderer has a Supabase read client at all. */
  canRead: boolean;
  /** Host of the project the renderer reads from, if it has one. */
  readHost: string | null;
  fmtTime: (iso: string | null | undefined) => string;
}

/** What each write channel carries, in words a person can use. "masters failed" means something quite different from "config failed". */
const CHANNEL: Record<"config" | "masters" | "vouchers", { title: string; carries: string }> = {
  config: { title: "Settings", carries: "the 13 settings tables" },
  masters: { title: "Lists", carries: "items and parties" },
  vouchers: { title: "Vouchers", carries: "vouchers, stock lines and ledger lines" },
};

export function SupabaseCloudPanel({ config, masters, vouchers, canRead, readHost, fmtTime }: Props) {
  const channels = [
    ["config", config] as const,
    ["masters", masters] as const,
    ["vouchers", vouchers] as const,
  ];

  /* Failing first, then never-attempted, then the ones that worked. A channel that is fine does not need to be found. */
  const rank = (c: ChannelStatusLike) => (c.success === false ? 0 : c.success === null ? 1 : 2);
  const ordered = [...channels].sort((a, b) => rank(a[1]) - rank(b[1]));
  const failing = channels.filter(([, c]) => c.success === false).length;

  return (
    <div className="space-y-4">
      {failing > 0 && (
        <div className="note note-bad">
          <CloudOff size={16} className="mt-1 shrink-0" />
          <div>
            <p className="font-medium">
              {failing === 1 ? "One part is not reaching the online database." : `${failing} parts are not reaching the online database.`}
            </p>
            <p className="mt-1">
              Tally is still being read. What stops is the copy moving, so every screen that reads the online database, the web dashboard
              included, is showing older numbers than this computer has.
            </p>
          </div>
        </div>
      )}

      <section>
        <RowGroupHeading>What this computer sends up</RowGroupHeading>
        <ul className="tray flex flex-col gap-2">
          {ordered.map(([name, c]) => {
            const meta = c.success === null
              /* NOT "never": the record is kept in memory, so this is the honest claim. */
              ? "nothing sent since this app started"
              : `${c.success ? "last sent" : "last tried"} ${fmtTime(c.lastAt)}`;
            return (
              <StatusRow
                key={name}
                icon={c.success === false ? AlertTriangle : c.success ? CheckCircle2 : Clock}
                tone={c.success === false ? "danger" : c.success ? "success" : "neutral"}
                title={CHANNEL[name].title}
                subject={CHANNEL[name].carries}
                meta={
                  <>
                    {meta}
                    {c.retryScheduled && (
                      <span className="ml-2 inline-flex items-center gap-1 text-warn-700">
                        <RotateCw size={16} /> trying again within a minute
                      </span>
                    )}
                  </>
                }
                error={c.success === false ? c.error : null}
              />
            );
          })}
        </ul>
      </section>

      <section>
        <RowGroupHeading>Who can read and who can write</RowGroupHeading>
        <ul className="tray flex flex-col gap-2">
          <StatusRow
            icon={Cloud}
            tone="neutral"
            title="Sending up"
            subject="this app's own server"
            meta="It uses the access the installer gave this computer. A change to that access only takes effect after the app is closed and opened again."
          />
          <StatusRow
            icon={canRead ? Database : KeyRound}
            tone={canRead ? "neutral" : "warn"}
            title="Reading back"
            subject={canRead ? <span>{readHost}</span> : "not available in this build"}
            meta={
              canRead
                ? "This window reads the online database with the read-only access built into this version."
                : "The history and send-log lists on this page will stay empty."
            }
          />
        </ul>
        {!canRead && (
          <div className="mt-2 note note-warn">
            <AlertTriangle size={16} className="mt-1 shrink-0" />
            <div>
              <p className="font-medium">This version has no read-only access to the online database, so the lists on this page read empty.</p>
              <p className="mt-1">
                Empty here means "could not ask", not "nothing has synced". Sending up is not affected and carries on through the server.
              </p>
              <p className="mt-1">The read-only access is built in when the app is made. It cannot be fixed by changing a file on this computer. A new version of the app is needed.</p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export default SupabaseCloudPanel;
