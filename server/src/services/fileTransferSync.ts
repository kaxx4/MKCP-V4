import { classifyTransfer, contentTypeFor, readHead } from "./fileTransferKind.js";
import { createClient, type SupabaseClient, type RealtimeChannel } from "@supabase/supabase-js";
import ws from "ws";
import fs from "fs";
import path from "path";
import chokidar, { type FSWatcher } from "chokidar";

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

  // contentType is NOT optional in practice: supabase-js falls back to
  // text/plain, which made every JSON and XML sent up download as a .txt the
  // web dashboard and Tally both reject.
  const mime = contentTypeFor(filename);
  const kind = classifyTransfer(filename, readHead(buf));

  const up = await client.storage
    .from(BUCKET)
    .upload(storagePath, buf, { upsert: false, contentType: mime });
  if (up.error) throw up.error;

  const ins = await client
    .from("file_transfers")
    .insert({
      company,
      direction: "desktop_to_web",
      filename,
      storage_path: storagePath,
      mime,
      kind,
      size_bytes: buf.length,
      note,
      created_by: "desktop-agent",
    })
    .select("id")
    .single();
  if (ins.error) throw ins.error;
  return { id: (ins.data as { id: string }).id };
}

// ─── Inbound watcher: drop a file in a folder, it appears on the web ────────
//
// The operator exports a price list (or anything else) out of Tally into a
// watched folder on this machine; it is uploaded automatically instead of
// being carried across by hand.

/** Filename of the ledger, kept inside the watched folder itself. */
const SENT_LEDGER = ".mkc-sent.json";

let watcher: FSWatcher | null = null;
let watchedDir: string | null = null;
let watchCompany = "";

/**
 * Files already uploaded, keyed by `name:size:mtime`.
 *
 * chokidar reports every pre-existing file on startup, which is what lets a
 * file dropped while the agent was down still get picked up — but without a
 * ledger it would also re-upload the entire folder on every restart. Keying on
 * size+mtime rather than name alone means re-exporting a fresh price list over
 * the old one is correctly treated as new.
 */
function ledgerPath(dir: string): string {
  return path.join(dir, SENT_LEDGER);
}

function readLedger(dir: string): Set<string> {
  try {
    const raw = fs.readFileSync(ledgerPath(dir), "utf8");
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set(); // absent or corrupt — worst case is one duplicate upload
  }
}

function writeLedger(dir: string, seen: Set<string>): void {
  try {
    // Keep the tail only; this is a dedupe guard, not an audit trail.
    const arr = [...seen].slice(-500);
    fs.writeFileSync(ledgerPath(dir), JSON.stringify(arr), "utf8");
  } catch (err: any) {
    console.warn(`[file-watch] Couldn't write the sent-ledger: ${err.message}`);
  }
}

function fileKey(filePath: string): string | null {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size === 0) return null;
    return `${path.basename(filePath)}:${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return null;
  }
}

async function onWatchedFile(filePath: string): Promise<void> {
  const dir = watchedDir;
  if (!dir) return;
  const base = path.basename(filePath);
  if (base.startsWith(".")) return; // our own ledger, and OS cruft

  const key = fileKey(filePath);
  if (!key) return;
  const seen = readLedger(dir);
  if (seen.has(key)) return;

  try {
    const { id } = await pushFileToWeb(watchCompany, filePath, "Picked up from the watch folder");
    seen.add(key);
    writeLedger(dir, seen);
    console.log(`[file-watch] ✓ Sent "${base}" to the web dashboard (${id})`);
  } catch (err: any) {
    // Deliberately NOT recorded in the ledger — a failed upload should be
    // retried on the next restart rather than silently dropped.
    console.error(`[file-watch] Failed to send "${base}": ${err.message}`);
  }
}

/**
 * Start (or restart) watching the configured folder.
 *
 * Safe to call repeatedly — the operator can change the folder at runtime and
 * this tears the old watcher down first. Called on boot and from the
 * folder-picker IPC handler.
 */
export function startWatchFolder(company: string): { ok: boolean; reason?: string; dir?: string } {
  watchCompany = company;
  if (watcher) {
    void watcher.close();
    watcher = null;
    watchedDir = null;
  }

  const dir = process.env.MKC_WATCH_FOLDER;
  if (!dir) return { ok: false, reason: "no folder configured" };

  // The download folder is where THIS agent writes incoming files. Watching it
  // would upload every file the moment it arrived, straight back to where it
  // came from — an endless round trip. Refuse rather than let that start.
  const syncDir = process.env.MKC_SYNC_FOLDER;
  if (syncDir && path.resolve(syncDir) === path.resolve(dir)) {
    const reason = "the watch folder cannot be the same as the download folder — files would loop back and forth";
    console.error(`[file-watch] ${reason}`);
    return { ok: false, reason };
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err: any) {
    return { ok: false, reason: `folder isn't usable: ${err.message}` };
  }

  watchedDir = dir;
  watcher = chokidar.watch(dir, {
    depth: 0, // the drop folder itself, not a tree
    ignoreInitial: false, // so a file dropped while the agent was down is still caught
    // Tally writes its export progressively; uploading mid-write would ship a
    // truncated file. Wait for the size to hold steady before touching it.
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 300 },
  });

  watcher.on("add", (p) => void onWatchedFile(p));
  watcher.on("change", (p) => void onWatchedFile(p));
  watcher.on("error", (err: unknown) =>
    console.error(`[file-watch] Watcher error: ${err instanceof Error ? err.message : String(err)}`)
  );

  console.log(`[file-watch] ✓ Watching ${dir} for files to send to the web dashboard`);
  return { ok: true, dir };
}

export function stopWatchFolder(): void {
  if (watcher) {
    void watcher.close();
    watcher = null;
    watchedDir = null;
  }
}

export function watchFolderStatus(): { watching: boolean; dir: string | null } {
  return { watching: watcher !== null, dir: watchedDir };
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
