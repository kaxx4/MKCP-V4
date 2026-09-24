/**
 * The assertion scripts (server/scripts/test-*.ts), run as child processes so
 * one that calls process.exit cannot take the runner down with it.
 *
 * OFFLINE lists only scripts that need no Tally and no Supabase — measured
 * 24-Sep-2026 in a container with neither: each exits 0 with "N passed, 0
 * failed". A script that talks to Tally belongs in LIVE, never here: run
 * offline it fails on "Cannot connect", which is not a finding.
 */
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "..");

export const OFFLINE: string[][] = [
  ["test-push-guard.ts", "--offline"], ["test-party-identity-xml.ts"], ["test-gstr-exceptions.ts"],
  ["test-gate-recovery.ts"], ["test-place-of-supply.ts"], ["test-line-gst-source.ts"], ["test-stock-item-gst.ts"],
  ["test-tally-request.ts"], ["test-response-parsers.ts"], ["test-tally-role.ts"], ["test-offline-mode.ts"],
  ["test-phantom-master-guard.ts"], ["test-price-gst-daily-sync.ts"], ["test-price-list-signal.ts"], ["test-price-log.ts"],
  ["test-sync-history-changed.ts"], ["test-mirror-signal-dedupe.ts"], ["test-bank-narrations.ts"],
];
export const LIVE: string[][] = [
  ["test-push-guard.ts", "--push"], ["test-edge-cases.ts"], ["test-push-fidelity-sandbox.ts", "--push"],
];

/** Returns the number of failing scripts. */
export function runSuites(which: "offline" | "live"): number {
  const list = which === "live" ? LIVE : OFFLINE;
  const tsx = join(server, "node_modules", "tsx", "dist", "cli.mjs");
  console.log(`\n══ Assertion scripts — ${which} ${"═".repeat(40)}`);
  let failed = 0;
  for (const [file, ...a] of list) {
    const r = spawnSync(process.execPath, [tsx, join("scripts", file), ...a], {
      cwd: server, encoding: "utf8", env: { ...process.env }, timeout: 600_000,
    });
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
    const tally = [...out.matchAll(/(\d+) passed\s*[·,]\s*(\d+) failed/g)].pop();
    const counts = tally ? `${tally[1]} passed, ${tally[2]} failed` : "no pass/fail line";
    const ok = r.status === 0 && (!tally || tally[2] === "0");
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${[file, ...a].join(" ").padEnd(42)} ${counts}${ok ? "" : `  (exit ${r.status})`}`);
    if (!ok) console.log(out.split("\n").filter((l) => /✗|FAIL|Error|failed/i.test(l)).slice(0, 6).map((l) => `        ${l.trim()}`).join("\n"));
  }
  console.log(`${list.length - failed}/${list.length} scripts green`);
  return failed;
}
