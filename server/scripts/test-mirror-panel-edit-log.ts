/**
 * SYNC-P5 — does the agent's mirror panel see config_edit_log rows written
 * under the STABLE config key (since 30-Sep-2026) as well as the FY-suffixed
 * Tally name (before)? OFFLINE: a fake Supabase client that evaluates the
 * filters the panel actually sends; no socket to anything.
 *
 *   npx tsx server/scripts/test-mirror-panel-edit-log.ts
 */
delete process.env.SUPABASE_SERVICE_KEY;

import { buildMirrorPanel, configCompanyKey, configLogPattern } from "../src/services/mirrorPanel.js";

let passed = 0, failed = 0;
const ok = (what: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`  ok    ${what}`); }
  else { failed++; console.log(`  FAIL  ${what}${detail ? "  — " + detail : ""}`); }
};
const eq = (what: string, got: unknown, want: unknown) =>
  ok(what, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const TALLY = "M.K.CYCLES (P) LTD. - (from 1-Apr-26)";
const STABLE = "M.K.CYCLES (P) LTD.";

/** PostgREST LIKE: `%` any run, `_` one char, `\` escapes. */
function likeToRegex(p: string): RegExp {
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\" && i + 1 < p.length) { re += p[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
    re += c === "%" ? ".*" : c === "_" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s");
}

/** A chainable fake that applies eq / like on `company` to in-memory rows. */
function fakeClient(tables: Record<string, any[]>, seen: { table: string; op: string; value: string }[]) {
  return {
    from(table: string) {
      const filters: ((r: any) => boolean)[] = [];
      const b: any = {
        select: () => b, order: () => b, limit: () => b, gte: () => b,
        eq(col: string, v: any) { if (col === "company") seen.push({ table, op: "eq", value: v }); filters.push((r) => r[col] === v); return b; },
        like(col: string, p: string) { seen.push({ table, op: "like", value: p }); const rx = likeToRegex(p); filters.push((r) => rx.test(String(r[col] ?? ""))); return b; },
        then(res: (x: any) => void, rej: (e: any) => void) {
          try {
            const data = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
            res({ data, count: data.length, error: null });
          } catch (e) { rej(e); }
        },
      };
      return b;
    },
  };
}

async function main(): Promise<void> {
  console.log("\n  SYNC-P5 — config_edit_log under both company keys\n  " + "─".repeat(62));

  console.log("\n  key derivation (same rule as web domain/company.ts)");
  eq("FY-suffixed Tally name → stable key", configCompanyKey(TALLY), STABLE);
  eq("stable key is its own key", configCompanyKey(STABLE), STABLE);
  eq("next year's name → the same stable key", configCompanyKey("M.K.CYCLES (P) LTD. - (from 1-Apr-27)"), STABLE);
  eq("pattern is the stable key as a prefix", configLogPattern(TALLY), `${STABLE}%`);
  eq("% and _ in a name are escaped", configLogPattern("A_B%C - (from 1-Apr-26)"), "A\\_B\\%C%");
  const rx = likeToRegex(configLogPattern(TALLY));
  ok("pattern matches the stable key", rx.test(STABLE));
  ok("pattern matches this FY's name", rx.test(TALLY));
  ok("pattern matches last FY's name", rx.test("M.K.CYCLES (P) LTD. - (from 1-Apr-25)"));
  ok("pattern does not match another company", !rx.test("MONDAL ENTERPRISE"));

  console.log("\n  buildMirrorPanel with a fake client");
  const seen: { table: string; op: string; value: string }[] = [];
  const client = fakeClient({
    config_edit_log: [
      { id: 1, created_at: "2026-09-20T10:00:00Z", actor: "old", company: TALLY, domain: "discounts", table_name: "discount_rules", action: "upsert", entity_count: 1 },
      { id: 2, created_at: "2026-10-01T10:00:00Z", actor: "new", company: STABLE, domain: "discounts", table_name: "discount_rules", action: "upsert", entity_count: 2 },
      { id: 3, created_at: "2026-10-01T11:00:00Z", actor: "x", company: "SOME OTHER CO", domain: "d", table_name: "t", action: "upsert", entity_count: 1 },
    ],
    push_queue: [{ id: 9, status: "succeeded", payload: {}, company: TALLY, created_at: "2026-10-01T09:00:00Z" }],
  }, seen);
  const panel = await buildMirrorPanel(TALLY, 25, client as any);
  eq("edit log carries the pre-30-Sep FY-keyed row AND the stable-keyed row", panel.edits.map((e) => e.id).sort(), [1, 2]);
  ok("another company's edit is not shown", !panel.edits.some((e) => e.id === 3));
  const logQ = seen.filter((s) => s.table === "config_edit_log");
  ok("edit log is read by prefix (like), never eq on the Tally name", logQ.length === 1 && logQ[0].op === "like", JSON.stringify(logQ));
  ok("the mirror itself is still read under the Tally name (eq)",
    seen.some((s) => s.table === "push_queue" && s.op === "eq" && s.value === TALLY));
  eq("push log unaffected", panel.pushes.length, 1);

  const off = await buildMirrorPanel(TALLY, 25, null);
  ok("no client → offline panel, no throw", off.offline === true && off.edits.length === 0);

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("ERR:", e); process.exit(1); });
