/*
 * Supabase Cloud, rebuilt from 0 on the web dashboard's idiom.
 *
 * ── What was wrong with the old one ───────────────────────────────────────
 *
 * It repeated the header: the KPI strip already says "Supabase — OK / Error /
 * Never" with the last write time under it, and this panel then re-derived the
 * same verdict from the same three channels and printed it four more times as
 * green and red `Pill`s — `bg-green-50`, `bg-red-50` straight off the palette,
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
 * The retry hint said `retry ~60s` in `text-yellow-600` — a fifth colour, and a
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

/** What each channel actually carries — the row title alone does not say, and
 *  "masters failed" means something quite different from "config failed". */
const CHANNEL: Record<string, { title: string; carries: string }> = {
  config: { title: "Config", carries: "13 configuration tables" },
  masters: { title: "Masters", carries: "items and ledgers" },
  vouchers: { title: "Vouchers", carries: "vouchers, inventory and ledger entries" },
};

export function SupabaseCloudPanel({ config, masters, vouchers, canRead, readHost, fmtTime }: Props) {
  const channels = [
    ["config", config] as const,
    ["masters", masters] as const,
    ["vouchers", vouchers] as const,
  ];

  /* Failing first, then never-attempted, then the ones that worked. A channel
     that is fine does not need to be found. */
  const rank = (c: ChannelStatusLike) => (c.success === false ? 0 : c.success === null ? 1 : 2);
  const ordered = [...channels].sort((a, b) => rank(a[1]) - rank(b[1]));
  const failing = channels.filter(([, c]) => c.success === false).length;

  return (
    <div className="space-y-3">
      {failing > 0 && (
        <div className="flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2.5 text-[12px] text-danger-700">
          <CloudOff size={14} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">
              {failing === 1 ? "One channel is not reaching Supabase." : `${failing} channels are not reaching Supabase.`}
            </p>
            <p className="mt-1">
              {/* Not "Tally keeps being read" — this panel cannot see whether it
                  is, and when the local server is the thing that is down,
                  nothing is being read either. Stated as what a write-channel
                  failure does and does not imply. (15-Sep-2026) */}
              A write channel failing does not by itself stop Tally being read; it stops the mirror MOVING, so
              every screen that reads Supabase — the web dashboard included — is showing older numbers than this
              machine has.
            </p>
          </div>
        </div>
      )}

      <section>
        <RowGroupHeading>Write channels</RowGroupHeading>
        <ul className="flex flex-col gap-2">
          {ordered.map(([name, c]) => {
            const meta = c.success === null
              /* NOT "never". The store is in-memory; this is the honest claim. */
              ? "no push attempted since this app started"
              : `${c.success ? "last written" : "last tried"} ${fmtTime(c.lastAt)}`;
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
                      <span className="ml-1.5 inline-flex items-center gap-1 text-warn-800">
                        <RotateCw size={10} /> retrying in under a minute
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

      {/* The two credentials. Kept together because the failure they produce
          looks the same from the outside and is fixed in two different places. */}
      <section>
        <RowGroupHeading>Credentials in play</RowGroupHeading>
        <ul className="flex flex-col gap-2">
          <StatusRow
            icon={Cloud}
            tone="neutral"
            title="Writing"
            subject="this app's server, on the service key"
            meta={
              <>
                from <span className="font-mono">%APPDATA%\mkcycles-dashboard-electron\.env</span> — read once at
                startup, so a change needs the app restarted
              </>
            }
          />
          <StatusRow
            icon={canRead ? Database : KeyRound}
            tone={canRead ? "neutral" : "warn"}
            title="Reading"
            subject={canRead ? <span className="font-mono">{readHost}</span> : "no read client"}
            meta={
              canRead
                ? "this window, on the publishable key compiled into this build"
                : "the history and push-log lists on this page will stay empty"
            }
          />
        </ul>
        {!canRead && (
          <div className="mt-2 flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2.5 text-[12px] text-warn-800">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold">This build has no Supabase read credentials, so the lists below read empty.</p>
              <p className="mt-1">
                Empty here means "could not ask", not "nothing has synced" — pushing is unaffected and carries on
                through the server.
              </p>
              <p className="mt-1">
                <span className="font-mono">VITE_SUPABASE_URL</span> and{" "}
                <span className="font-mono">VITE_SUPABASE_PUBLISHABLE_KEY</span> are baked in by Vite at build time,
                not read at run time. Editing a <span className="font-mono">.env</span> on this machine will not
                change them — the app has to be rebuilt.
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export default SupabaseCloudPanel;
