import { createClient, type SupabaseClient, type RealtimeChannel } from "@supabase/supabase-js";
import ws from "ws";
import fs from "fs";
import path from "path";

// Same WebSocket polyfill used by SupabaseSync / refreshListener.
if (typeof globalThis !== "undefined" && !globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

let started = false;
let client: SupabaseClient | null = null;

interface FileTransferRow {
  id: string;
  company: string;
  direction: "web_to_desktop" | "desktop_to_web";
  filename: string;
  storage_path: string;
  status: "pending" | "downloaded" | "dismissed";
}

const BUCKET = "file-transfers";

/** Downloads path — where files the web dashboard pushes land locally.
 *  Set by public/electron.js from the operator's configured setting
 *  (loadPackagedEnv-adjacent: the renderer picks a folder via a native
 *  dialog, electron.js stores it and passes it through as an env var
 *  before the server module loads, same as TALLY_COMPANY). */
function getSyncFolder(): string | null {
  const dir = process.env.MKC_SYNC_FOLDER;
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (err: any) {
    console.error(`[file-transfer] Configured folder "${dir}" isn't usable: ${err.message}`);
    return null;
  }
}

async function downloadOne(supabase: SupabaseClient, row: FileTransferRow): Promise<void> {
  const dir = getSyncFolder();
  if (!dir) {
    console.warn(
      `[file-transfer] "${row.filename}" is waiting in Supabase but no local sync folder is configured — ` +
        `set one from the app's Settings, then it'll be picked up on the next connection/restart.`
    );
    return; // leave status = pending; a later catch-up pass or restart will retry once a folder is set
  }

  const { data, error } = await supabase.storage.from(BUCKET).download(row.storage_path);
  if (error || !data) {
    console.error(`[file-transfer] Failed to download "${row.filename}": ${error?.message ?? "no data"}`);
    return;
  }

  // Avoid clobbering an existing file of the same name — every incoming
  // transfer keeps its own timestamped copy rather than silently overwriting
  // whatever the operator has sitting in the folder.
  const safe = row.filename.replace(/[^\w.\-]+/g, "_");
  const destPath = path.join(dir, `${Date.now()}-${safe}`);
  const buf = Buffer.from(await data.arrayBuffer());
  fs.writeFileSync(destPath, buf);

  const { error: updateErr } = await supabase
    .from("file_transfers")
    .update({ status: "downloaded" })
    .eq("id", row.id);
  if (updateErr) {
    console.error(`[file-transfer] Downloaded "${row.filename}" but failed to mark it handled: ${updateErr.message}`);
  } else {
    console.log(`[file-transfer] ✓ Saved "${row.filename}" to ${destPath}`);
  }
}

/** Catch-up pass for anything that landed while this instance wasn't
 *  running or wasn't yet configured with a sync folder — Realtime INSERT
 *  events only fire once, so a row missed at insert time would otherwise
 *  sit pending forever. */
async function catchUpPending(supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase
    .from("file_transfers")
    .select("id, company, direction, filename, storage_path, status")
    .eq("direction", "web_to_desktop")
    .eq("status", "pending");
  if (error) {
    console.warn(`[file-transfer] Catch-up query failed: ${error.message}`);
    return;
  }
  for (const row of (data ?? []) as FileTransferRow[]) {
    await downloadOne(supabase, row);
  }
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let channel: RealtimeChannel | null = null;
let attempt = 0;

function connect(supabase: SupabaseClient): void {
  channel = supabase
    .channel("file-transfers-desktop")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "file_transfers", filter: "direction=eq.web_to_desktop" },
      (payload) => {
        void downloadOne(supabase, payload.new as FileTransferRow);
      }
    )
    .subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        attempt = 0;
        console.log("[file-transfer] ✓ Listening for incoming files from the web dashboard");
        void catchUpPending(supabase); // pick up anything that arrived while disconnected
        return;
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        console.error(`[file-transfer] Realtime ${status}${err ? " — " + err.message : ""} — reconnecting`);
        const dead = channel;
        channel = null;
        if (dead) supabase.removeChannel(dead);
        attempt += 1;
        const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
        retryTimer = setTimeout(() => connect(supabase), delay);
      }
    });
}

/** Call once from index.ts. Requires SUPABASE_URL/SUPABASE_SERVICE_KEY in the
 *  env (see supabaseSync.ts's constructor for the same fail-closed rule —
 *  no hardcoded fallback key here either). */
export function startFileTransferSync(): void {
  if (started) return;
  started = true;

  const url = process.env.SUPABASE_URL || "https://vmkytsytxlofjyeotmgb.supabase.co";
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!key) {
    console.error("[file-transfer] SUPABASE_SERVICE_KEY not set — file transfer sync disabled");
    return;
  }

  client = createClient(url, key, { realtime: { params: { eventsPerSecond: 2 } } });
  connect(client);
}

/** Upload a local file (already on disk — the operator picked it via a
 *  native file dialog in the renderer) to the web dashboard. Used by the
 *  POST /api/file-transfer/push route. */
export async function pushFileToWeb(company: string, filePath: string, note: string | null): Promise<{ id: string }> {
  if (!client) throw new Error("File transfer sync isn't running (no Supabase credentials configured)");
  const filename = path.basename(filePath);
  const buf = fs.readFileSync(filePath);
  const safe = filename.replace(/[^\w.\-]+/g, "_");
  const storagePath = `desktop-to-web/${Date.now()}-${safe}`;

  const up = await client.storage.from(BUCKET).upload(storagePath, buf, { upsert: false });
  if (up.error) throw up.error;

  const ins = await client
    .from("file_transfers")
    .insert({
      company,
      direction: "desktop_to_web",
      filename,
      storage_path: storagePath,
      size_bytes: buf.length,
      note,
      created_by: "desktop-agent",
    })
    .select("id")
    .single();
  if (ins.error) throw ins.error;
  return { id: (ins.data as { id: string }).id };
}

/** Recent transfers for this company, both directions — for AgentStatus.tsx
 *  to poll and show a status panel. */
export async function listRecentTransfers(company: string): Promise<any[]> {
  if (!client) return [];
  const { data, error } = await client
    .from("file_transfers")
    .select("*")
    .eq("company", company)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) {
    console.warn(`[file-transfer] listRecentTransfers failed: ${error.message}`);
    return [];
  }
  return data ?? [];
}
