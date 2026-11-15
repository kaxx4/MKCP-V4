/*
 * The Online database card (Supabase): is what this computer sends up reaching it, and who can read and who can write.
 *
 * The head says the verdict once, as a chip and one line (both come from status/agentFacts.ts:cloudFact, the same reasoning every window uses).
 * Below it: the three write channels as three rows, failing ones first, each with the reason in full, then the one thing this screen genuinely
 * knows that a chip cannot fit: the two DIFFERENT credentials in play. Writes go out through this app's own server on the service key; the
 * history lists in this window are read by the window itself on the publishable key compiled into the build. They fail independently and are
 * fixed in different places, which is why "the online database is fine" and "the history is empty" can both be true at once.
 *
 * A channel that has not been tried says "nothing sent since this app started", never "never": the record is kept in memory, so that is the
 * honest claim.
 */
import { AlertTriangle, CheckCircle2, Cloud, CloudOff, Clock, Database, KeyRound, RotateCw } from "lucide-react";
import type { AgentFact } from "../status/agentFacts";
import { Card, Chip, Note, Row, RowList, Tile, chipToneOf } from "./ui";

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
  /** The card's verdict, from cloudFact(). */
  fact: AgentFact;
  /** Whether the renderer has a Supabase read client at all. */
  canRead: boolean;
  /** Host of the project the renderer reads from, if it has one. */
  readHost: string | null;
  fmtTime: (iso: string | null | undefined) => string;
}

/** What each write channel carries, in words a person can use. */
const CHANNEL: Record<"config" | "masters" | "vouchers", { title: string; carries: string }> = {
  config: { title: "Settings", carries: "the 13 settings tables" },
  masters: { title: "Lists", carries: "items and parties" },
  vouchers: { title: "Vouchers", carries: "vouchers, stock lines and ledger lines" },
};

export function SupabaseCloudCard({ config, masters, vouchers, fact, canRead, readHost, fmtTime }: Props) {
  const channels = [["config", config] as const, ["masters", masters] as const, ["vouchers", vouchers] as const];

  /* Failing first, then never-attempted, then the ones that worked. A channel that is fine does not need to be found. */
  const rank = (c: ChannelStatusLike) => (c.success === false ? 0 : c.success === null ? 1 : 2);
  const ordered = [...channels].sort((a, b) => rank(a[1]) - rank(b[1]));
  const failing = channels.filter(([, c]) => c.success === false).length;

  return (
    <Card
      icon={failing > 0 ? CloudOff : Cloud}
      title="Online database"
      sub={fact.sub}
      chip={<Chip tone={chipToneOf(fact.tone)}>{fact.value}</Chip>}
    >
      {failing > 0 && (
        <Note tone="bad" icon={CloudOff}>
          <p className="font-medium">
            {failing === 1 ? "One part is not reaching the online database." : `${failing} parts are not reaching the online database.`}
          </p>
          <p>
            Tally is still being read. What stops is the copy moving, so every screen that reads the online database, the web dashboard
            included, is showing older numbers than this computer has.
          </p>
        </Note>
      )}

      <Tile title="What this computer sends up">
        <RowList>
          {ordered.map(([name, c]) => (
            <Row
              key={name}
              icon={c.success === false ? AlertTriangle : c.success ? CheckCircle2 : Clock}
              tone={c.success === false ? "danger" : c.success ? "success" : "neutral"}
              title={CHANNEL[name].title}
              subject={CHANNEL[name].carries}
              chip={<Chip tone={c.success === false ? "bad" : c.success ? "good" : "neutral"}>{c.success === false ? "Failed" : c.success ? "Sent" : "Not yet"}</Chip>}
              meta={
                <>
                  {c.success === null ? "nothing sent since this app started" : `${c.success ? "last sent" : "last tried"} ${fmtTime(c.lastAt)}`}
                  {c.retryScheduled && (
                    <span className="ml-2 inline-flex items-center gap-1 text-warn-700">
                      <RotateCw size={16} aria-hidden="true" /> trying again within a minute
                    </span>
                  )}
                </>
              }
              error={c.success === false ? c.error : null}
            />
          ))}
        </RowList>
      </Tile>

      <Tile title="Who can read and who can write">
        <RowList>
          <Row
            icon={Cloud}
            title="Sending up"
            subject="this app's own server"
            meta="It uses the access the installer gave this computer. A change to that access only takes effect after the app is closed and opened again."
          />
          <Row
            icon={canRead ? Database : KeyRound}
            tone={canRead ? "neutral" : "warn"}
            title="Reading back"
            subject={canRead ? readHost : "not available in this build"}
            chip={<Chip tone={canRead ? "good" : "warn"}>{canRead ? "Available" : "Not available"}</Chip>}
            meta={
              canRead
                ? "This window reads the online database with the read-only access built into this version."
                : "The history and send-log lists in this window will stay empty."
            }
          />
        </RowList>
        {!canRead && (
          <Note tone="warn" icon={AlertTriangle} className="mt-3">
            <p className="font-medium">This version has no read-only access to the online database, so the lists in this window read empty.</p>
            <p>Empty here means "could not ask", not "nothing has synced". Sending up is not affected and carries on through the server.</p>
            <p>The read-only access is built in when the app is made. It cannot be fixed by changing a file on this computer. A new version of the app is needed.</p>
          </Note>
        )}
      </Tile>
    </Card>
  );
}

export default SupabaseCloudCard;
