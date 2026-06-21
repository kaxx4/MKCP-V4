import { createClient } from "@supabase/supabase-js";
import ws from "ws";

// Same WebSocket polyfill used by SupabaseSync
if (typeof globalThis !== "undefined" && !globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

let started = false;

/** Current financial year (Apr 1 → today) as YYYYMMDD. Matches the desktop FY. */
function currentFyRange(): { from: string; to: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  // FY starts 1 April; before April we're still in last year's FY.
  const fyStartYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
  const from = `${fyStartYear}0401`;
  const to = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return { from, to };
}

/**
 * Subscribes to `tally_refresh_commands` via Supabase Realtime.
 * When the web dashboard inserts a row for this company, we:
 *   1. Immediately update status → "ack" so the web button gets feedback.
 *   2. POST to our own /api/tally/sync endpoint (the same path the desktop
 *      UI uses) so the existing syncGuard, orchestrator, and Supabase upload
 *      all run normally.
 *
 * Call once from index.ts inside the app.listen callback.
 */
export function startRefreshListener(localPort: number, company: string): void {
  if (started) return;
  started = true;

  // Reuse the same credentials SupabaseSync uses — hardcoded fallbacks are
  // fine here because they're already in the codebase.
  const url =
    process.env.SUPABASE_URL ||
    "https://vmkytsytxlofjyeotmgb.supabase.co";
  const key =
    process.env.SUPABASE_SERVICE_KEY ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZta3l0c3l0eGxvZmp5ZW90bWdiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODY0MjAyMCwiZXhwIjoyMDk0MjE4MDIwfQ.W-LfPU_GMCFafIWjHt0n5bs1oC08IX7IuXLj6TVY1BU";

  const supabase = createClient(url, key, {
    realtime: { params: { eventsPerSecond: 2 } },
  });

  // One channel per company so multiple desktop instances don't cross-trigger.
  const channelName = `refresh-listener-${company
    .replace(/[^a-zA-Z0-9]/g, "_")
    .toLowerCase()}`;

  supabase
    .channel(channelName)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "tally_refresh_commands",
        // Only rows for THIS company — safe even if other companies share the DB.
        filter: `company=eq.${company}`,
      },
      async (payload) => {
        const id: number = (payload.new as any).id;
        const { from, to } = currentFyRange();

        // ── Loud, distinct banner so a web-triggered sync is impossible to miss
        //    in the log tail. Every line carries the 🌐 [WEB-SYNC] marker so the
        //    in-app Logs panel "Remote" filter can isolate the whole lifecycle.
        console.log("");
        console.log("🌐 ──────────────────────────────────────────────────────");
        console.log("🌐 [WEB-SYNC] Refresh requested from the WEB dashboard");
        console.log(`🌐 [WEB-SYNC]   • command id : ${id}`);
        console.log(`🌐 [WEB-SYNC]   • company    : ${company}`);
        console.log(`🌐 [WEB-SYNC]   • range      : ${from} → ${to}  (daily chunks)`);
        console.log("🌐 ──────────────────────────────────────────────────────");

        // Ack immediately so the web button shows "✓ Sync started" within ~1 s.
        await supabase
          .from("tally_refresh_commands")
          .update({ status: "ack" })
          .eq("id", id);
        console.log(`🌐 [WEB-SYNC] ✓ Acknowledged (id=${id}) — web button now shows "started"`);

        // Fire the same /api/tally/sync endpoint the desktop UI uses.
        // NOTE: we pass the current FY date range + daily chunking. A bare
        // { company } produces an empty date window in the orchestrator, which
        // pulls masters but ZERO vouchers — so the remote refresh must scope the
        // range exactly like the desktop "Sync Now" button does.
        // This fetch AWAITS the full sync (it can take minutes), so the response
        // carries the real result counts — we log them when it returns.
        // syncGuard returns 409 if a sync is already running — that's fine,
        // it just means the data will be fresh from the current run anyway.
        try {
          console.log(`🌐 [WEB-SYNC] → Firing Tally sync now… (id=${id})`);
          const resp = await fetch(
            `http://localhost:${localPort}/api/tally/sync`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                company,
                fromDate: from,
                toDate: to,
                mode: "full",
                chunkStrategy: "daily",
              }),
            }
          );

          if (resp.ok) {
            const result: any = await resp.json().catch(() => null);
            const s = result?.stats;
            if (s) {
              console.log(
                `🌐 [WEB-SYNC] ✓ Completed (id=${id}): ` +
                  `${s.vouchers ?? 0} vouchers, ${s.stockItems ?? 0} items, ` +
                  `${s.ledgers ?? 0} ledgers in ${s.elapsedSeconds ?? "?"}s`
              );
            } else {
              console.log(`🌐 [WEB-SYNC] ✓ Completed (id=${id})`);
            }
            // Mark done so the web button can flip to "✓ Synced".
            await supabase
              .from("tally_refresh_commands")
              .update({ status: "done" })
              .eq("id", id);
          } else if (resp.status === 409) {
            console.log(
              `🌐 [WEB-SYNC] ⏭ Skipped (id=${id}) — a sync was already running; ` +
                `data will be fresh from that run`
            );
          } else {
            throw new Error(`HTTP ${resp.status}`);
          }
        } catch (err: any) {
          console.error(
            `🌐 [WEB-SYNC] ✗ Failed (id=${id}): ${err.message}`
          );
          // Mark error so the web button shows "✗ Failed" instead of spinning.
          await supabase
            .from("tally_refresh_commands")
            .update({ status: "error" })
            .eq("id", id);
        }
      }
    )
    .subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        console.log(
          `🌐 [WEB-SYNC] ✓ Listening for remote refresh (company="${company}")`
        );
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error(
          `🌐 [WEB-SYNC] ✗ Channel error: ${status}${err ? " — " + err.message : ""}`
        );
      }
    });
}
