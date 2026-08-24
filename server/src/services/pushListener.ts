/**
 * Inbound voucher pushes from the web dashboard.
 *
 * The mirror of refreshListener.ts, in the opposite direction — and a
 * DELIBERATELY SEPARATE file. refreshListener owns the sync that the whole
 * business already depends on every day; adding a second, unrelated
 * responsibility to it would put that at risk for no benefit. Nothing in this
 * file touches the refresh path, its table, or its endpoints.
 *
 * WHY A QUEUE AND NOT A DIRECT CALL
 * TallyPrime listens only on localhost:9000 on this machine. A browser can only
 * POST there if it happens to be running on this machine — which is true on the
 * counter PC and false on the operator's phone. So the web side writes an
 * intent row to `tally_push_commands` and this listener does the local work,
 * exactly as the refresh flow does.
 *
 * WHY IT NEVER IMPORTS ON ITS OWN
 * Pulling data out of Tally is safe to automate. Writing a voucher INTO the
 * live books is not. Every push therefore parks at `awaiting_approval` and
 * waits for someone to approve it HERE, on the machine that holds the books.
 * The web side cannot approve its own request — it has no UPDATE grant on the
 * table (see the migration), so the decision cannot be forged from a browser.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";
import { tallyPost } from "../tally.js";

if (typeof (globalThis as any).WebSocket === "undefined") {
  (globalThis as any).WebSocket = ws;
}

export interface PendingPush {
  id: number;
  label: string;
  voucherType: string | null;
  deviceName: string | null;
  createdAt: string;
  /** Kept in memory only — the approval UI shows a summary, not the payload. */
  xml: string;
}

/** Awaiting a human decision on this machine. Exposed to the Electron UI via
 *  the endpoints in index.ts; deliberately in-memory, because an approval
 *  queue that survives a restart would let a voucher be booked hours later by
 *  someone who has forgotten what it was. A dropped queue is recoverable —
 *  the operator pushes again. A stale approval is not. */
const pending = new Map<number, PendingPush>();

// SupabaseClient (schema-agnostic) rather than ReturnType<typeof createClient>:
// the latter infers a typed schema and narrows every table name to `never`.
let client: SupabaseClient | null = null;
let tallyUrl = "http://localhost:9000";

export function listPendingPushes(): Omit<PendingPush, "xml">[] {
  return [...pending.values()]
    .map(({ xml: _xml, ...rest }) => rest)
    .sort((a, b) => a.id - b.id);
}

async function setStatus(
  id: number,
  status: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  if (!client) return;
  try {
    await client
      .from("tally_push_commands")
      .update({ status, decided_at: new Date().toISOString(), ...extra })
      .eq("id", id);
  } catch (e) {
    console.error(`📤 [WEB-PUSH] could not write status ${status} for id=${id}:`, e);
  }
}

/**
 * Parse Tally's import reply. Tally answers HTTP 200 even when it rejects the
 * voucher — the verdict is in the body — so the status written back must come
 * from the body, never from the transport.
 */
function verdict(raw: string): { ok: boolean; message: string } {
  const num = (tag: string) => {
    const m = raw.match(new RegExp(`<${tag}>\\s*(-?\\d+)\\s*</${tag}>`, "i"));
    return m ? parseInt(m[1], 10) : 0;
  };
  const created = num("CREATED");
  const altered = num("ALTERED");
  const errors = num("ERRORS");
  const exceptions = num("EXCEPTIONS");
  const le = raw.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/i);
  const lineError = le ? le[1].trim() : "";

  if (errors === 0 && exceptions === 0 && created + altered > 0) {
    const parts = [created ? `${created} created` : "", altered ? `${altered} altered` : ""].filter(Boolean);
    return { ok: true, message: `Tally accepted it — ${parts.join(", ")}` };
  }
  if (lineError) return { ok: false, message: `Tally rejected it: ${lineError}` };
  if (errors || exceptions) return { ok: false, message: `Tally reported ${errors} error(s), ${exceptions} exception(s)` };
  // Nothing created, nothing wrong: Tally ignored it. Usually a voucher type or
  // company name it does not recognise. Not a success.
  return { ok: false, message: "Tally created nothing — check the voucher type and company name" };
}

/** Approve and import. Returns the operator-facing outcome. */
export async function approvePush(id: number): Promise<{ ok: boolean; message: string }> {
  const item = pending.get(id);
  if (!item) return { ok: false, message: "That push is no longer waiting — it may have been handled already." };
  pending.delete(id);

  await setStatus(id, "importing");
  try {
    const raw = await tallyPost(tallyUrl, item.xml, 30_000, true);
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    const v = verdict(text);
    await setStatus(id, v.ok ? "done" : "error", {
      result_message: v.message,
      tally_response: text.slice(0, 20_000),
    });
    console.log(`📤 [WEB-PUSH] id=${id} ${item.label}: ${v.message}`);
    return v;
  } catch (e: any) {
    const message = `Could not reach Tally: ${e?.message ?? e}`;
    await setStatus(id, "error", { result_message: message });
    console.error(`📤 [WEB-PUSH] id=${id} ${item.label}: ${message}`);
    return { ok: false, message };
  }
}

export async function rejectPush(id: number): Promise<{ ok: boolean; message: string }> {
  const item = pending.get(id);
  if (!item) return { ok: false, message: "That push is no longer waiting." };
  pending.delete(id);
  await setStatus(id, "rejected", { result_message: "Declined on the desktop." });
  console.log(`📤 [WEB-PUSH] id=${id} ${item.label}: declined`);
  return { ok: true, message: "Declined." };
}

async function take(row: any): Promise<void> {
  const id = Number(row.id);
  if (pending.has(id)) return;
  pending.set(id, {
    id,
    label: String(row.label ?? "Voucher"),
    voucherType: row.voucher_type ?? null,
    deviceName: row.device_name ?? null,
    createdAt: String(row.created_at ?? new Date().toISOString()),
    xml: String(row.xml ?? ""),
  });
  await setStatus(id, "awaiting_approval");
  console.log(
    `📤 [WEB-PUSH] ${row.label} from ${row.device_name ?? "web"} is waiting for approval (id=${id})`
  );
}

/**
 * Start listening. Safe to call when the service key is absent — it simply
 * logs and does nothing, exactly like the refresh listener, rather than
 * crashing the proxy.
 */
export function startPushListener(company: string, tally: string): void {
  tallyUrl = tally;
  const url = process.env.SUPABASE_URL || "https://vmkytsytxlofjyeotmgb.supabase.co";
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!key) {
    console.error(
      "📤 [WEB-PUSH] SUPABASE_SERVICE_KEY not set — voucher push disabled " +
        "(the web dashboard's 'Push to Tally' button won't reach this desktop instance)"
    );
    return;
  }

  client = createClient(url, key, { realtime: { params: { eventsPerSecond: 2 } } });

  client
    .channel("tally-push-commands")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "tally_push_commands" },
      (payload) => void take(payload.new)
    )
    .subscribe();

  /* Catch anything queued while this machine was closed, and anything a dropped
     socket missed. Realtime delivers only what happens while connected, so
     without this a push made overnight would sit unseen forever. */
  const drain = async () => {
    if (!client) return;
    try {
      const { data, error } = await client
        .from("tally_push_commands")
        .select("*")
        .eq("company", company)
        .in("status", ["pending", "awaiting_approval"])
        .order("id", { ascending: true })
        .limit(50);
      if (!error && data) for (const row of data) await take(row);
    } catch {
      /* transient — the next sweep retries */
    }
  };
  void drain();
  setInterval(() => void drain(), 60_000);

  console.log("📤 [WEB-PUSH] listening for voucher pushes from the web dashboard");
}
