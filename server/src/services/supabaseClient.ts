/**
 * The ONLY place this process builds a Supabase client.
 *
 * ── Why a chokepoint rather than nine guards ──────────────────────────────
 *
 * `createClient` used to be called in nine modules. Making "this machine must
 * not touch Supabase" true meant remembering to guard all nine — and the tenth,
 * whenever someone added it. A guard you have to remember is not a guard.
 *
 * Now every caller comes through here, and `scripts/test-offline-mode.ts` fails
 * the build if a direct `createClient(` reappears anywhere else in `src/`. That
 * turns a convention into something enforced.
 *
 * ── Offline mode ──────────────────────────────────────────────────────────
 *
 * `MKCP_OFFLINE=true` makes this return `null`, always. Every caller already
 * handles a null client — they had to, because the service key is optional —
 * so the whole Supabase surface simply stops existing.
 *
 * That is what makes a full dummy session possible: this computer holds Tally
 * open on a DUPLICATE company, while the real books run elsewhere and sync to
 * the same project. Vouchers can be pulled, pushed, altered and cancelled
 * against the local Tally all day with no possibility of a row reaching the
 * shared mirror.
 *
 * A machine declared `MKCP_TALLY_ROLE=sandbox` is offline automatically — a
 * copy of the company has no business writing to shared state, and the two
 * settings would otherwise have to be kept in step by hand.
 */
import { createClient, type SupabaseClient, type SupabaseClientOptions } from "@supabase/supabase-js";
import { isSandbox } from "./tallyRole.js";

export const DEFAULT_SUPABASE_URL = "https://vmkytsytxlofjyeotmgb.supabase.co";

/** True when this process must not contact Supabase at all. */
export function isOffline(): boolean {
  if ((process.env.MKCP_OFFLINE ?? "").trim().toLowerCase() === "true") return true;
  // A copy of the company is offline by definition — see tallyRole.ts.
  return isSandbox();
}

/** Why, in one line, for a log or a status endpoint. */
export function offlineReason(): string | null {
  if ((process.env.MKCP_OFFLINE ?? "").trim().toLowerCase() === "true") return "MKCP_OFFLINE=true";
  if (isSandbox()) return "MKCP_TALLY_ROLE=sandbox";
  return null;
}

let warned = false;

/**
 * A service-role client, or `null`.
 *
 * Null means one of: offline mode, or no service key configured. Callers must
 * treat both the same way — carry on doing whatever they can without Supabase —
 * which every existing caller already does.
 */
export function supabaseClient(options?: SupabaseClientOptions<"public">): SupabaseClient | null {
  if (isOffline()) {
    if (!warned) {
      warned = true;
      console.log(`🔌 [offline] Supabase is disabled (${offlineReason()}). Tally still works normally.`);
    }
    return null;
  }
  const url = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!key) return null;
  /* `persistSession: false` on every client: this is a server process with no
     browser storage, and a client that tries to persist a session here writes
     nothing and warns. Callers may add realtime options on top. */
  return createClient(url, key, { auth: { persistSession: false }, ...(options ?? {}) });
}

/**
 * For the two callers that legitimately want to fail loudly rather than degrade
 * — a diagnostic script is useless if it silently reports nothing.
 */
export function requireSupabase(what: string): SupabaseClient {
  const c = supabaseClient();
  if (!c) {
    const why = offlineReason() ?? "SUPABASE_SERVICE_KEY is not set";
    throw new Error(`${what} needs Supabase, but it is unavailable (${why}).`);
  }
  return c;
}
