import http from "node:http";

export interface LocalSyncResponse {
  ok: boolean;
  status: number;
  json: any;
}

/**
 * POST /api/tally/sync to our OWN Express server over localhost using Node's raw
 * http client — NOT the global (undici) fetch.
 *
 * WHY NOT fetch: a full-FY sync withholds response headers for the entire run
 * (~90 min on real data — the handler only calls res.json() at the very end).
 * Node's global fetch applies undici's default 300s headersTimeout, so it would
 * abort the request ~5 min in; that abort tears down the socket, which fires the
 * server's res.on("close") → AbortController.abort(), killing the sync mid-flight
 * and leaving a truncated FY uploaded to Supabase. http.request has no header
 * timeout, so the long-running self-call completes normally.
 *
 * Used by both the nightly scheduler and the web-refresh listener.
 */
export function postTallySync(port: number, body: object): Promise<LocalSyncResponse> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/tally/sync",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* non-JSON body → leave null */
          }
          const status = res.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, json });
        });
      }
    );
    // Safety cap well above the longest realistic full-FY sync (~90 min) so a
    // genuinely hung server can't block forever, without aborting normal syncs.
    req.setTimeout(2 * 60 * 60 * 1000, () =>
      req.destroy(new Error("local /api/tally/sync request timed out after 2h"))
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
