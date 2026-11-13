/**
 * JOB: the pure half of the go-live commands for the single-primary mode (D-M.248 item 3): register the primary machine (M1), turn the two
 * database switches on and off (M1, M2), seed the voucher counters (M3), judge the parity result (M9b), judge one real voucher (M11), and print
 * the preflight (D4). Nothing here talks to Tally or the database: the scripts in server/scripts/primary-*.ts do the reading and hand the answers
 * to these functions, so every rule has an offline test.
 *
 * Nothing here writes. Every command prints SQL for a person to run in the database console (the key is never stored in the repo, and the
 * switch, machine and series tables refuse writes from the service key on purpose), or reads.
 */
import { createHash } from "node:crypto";
import { seriesCounter, formatSeriesNumber, SERIES_DEFAULTS } from "./voucherSeries.js";

/** sha-256 of a key, lower-case hex: the only form of the key that goes to the database. */
export const keyHashOf = (key: string): string => createHash("sha256").update(key.trim(), "utf8").digest("hex");

/** The database's own rule for a machine id (0109). */
export const validMachineId = (id: string): boolean => /^[A-Za-z0-9_.-]{3,64}$/.test(id) && id !== "unnamed-machine";

/** A SQL string literal. Refuses control characters rather than guessing. */
export function sqlStr(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(s)) throw new Error("a control character cannot go into a SQL literal");
  return `'${s.replace(/'/g, "''")}'`;
}

// ── Register the primary machine ─────────────────────────────────────────────
export function registerSql(machine: string, keyHash: string, note = "the office PC, single primary (go-live)"): { up: string; down: string; check: string } {
  if (!validMachineId(machine)) throw new Error(`"${machine}" is not a valid machine id (3 to 64 letters, digits, dot, dash or underscore; not "unnamed-machine")`);
  if (!/^[0-9a-f]{64}$/.test(keyHash)) throw new Error("the key hash must be 64 hex digits");
  return {
    up: `insert into public.erp_agent_machines (machine_id, role, key_hash, note)\nvalues (${sqlStr(machine)}, 'primary', ${sqlStr(keyHash)}, ${sqlStr(note)});`,
    down: `update public.erp_agent_machines set retired_at = now(), note = coalesce(note || '; ', '') || 'retired: rolled back'\n where machine_id = ${sqlStr(machine)} and role = 'primary' and retired_at is null;`,
    check: `select machine_id, role, retired_at is null as active, created_at from public.erp_agent_machines where role = 'primary' order by created_at;`,
  };
}

// ── The two switches ─────────────────────────────────────────────────────────
export type SwitchName = "live_claims" | "live_mirror";
const SWITCH_TABLE: Record<SwitchName, string> = { live_claims: "public.erp_control", live_mirror: "public.erp_sync_control" };

/** The statement that turns one switch on or off. Idempotent. Run as the database owner in the console (the service key cannot write these tables). */
export function switchSql(which: SwitchName, on: boolean): string {
  const t = SWITCH_TABLE[which];
  if (!t) throw new Error(`unknown switch ${which}`);
  return `insert into ${t} (key, value, updated_at)\nvalues (${sqlStr(which)}, '{"on": ${on ? "true" : "false"}}'::jsonb, now())\non conflict (key) do update set value = excluded.value, updated_at = now();`;
}
export const switchCheckSql = (): string =>
  `select 'live_claims' as switch, coalesce((select value->>'on' from public.erp_control where key = 'live_claims'), 'no row (off)') as state\nunion all\nselect 'live_mirror', coalesce((select value->>'on' from public.erp_sync_control where key = 'live_mirror'), 'no row (off)');`;

// ── Seed the voucher counters (M3) ───────────────────────────────────────────
export interface SeriesSeed {
  voucherType: string; fy: string; template: string; width: number; seedSource: "tally_highest" | "erp_own";
  /** Vouchers of this type Tally holds. */
  inTally: number;
  /** Of those, how many are numbered in this series and year. */
  inSeries: number;
  highest: number;
  next: string;
  warning: string | null;
}
const titleCase = (k: string): string => k.split(" ").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

/** Pure: for each series the ERP numbers, the highest counter Tally holds in this financial year and the number the counter will give next. */
export function planSeriesSeeds(taken: Record<string, string[]>, fy: string): SeriesSeed[] {
  if (!/^[0-9]{4}-[0-9]{2}$/.test(fy)) throw new Error(`"${fy}" is not a financial year like 2026-27`);
  return Object.entries(SERIES_DEFAULTS).map(([key, d]) => {
    const list = taken[key];
    if (list === undefined) throw new Error(`no list of ${key} numbers was read from Tally`);
    const counters = list.map((n) => seriesCounter(n, d.template, fy)).filter((c): c is number => c !== null);
    const highest = counters.reduce((m, c) => Math.max(m, c), 0);
    let warning: string | null = null;
    if (d.seedSource === "tally_highest" && highest === 0 && list.length > 0) warning = `Tally holds ${list.length} ${titleCase(key)} voucher(s) but none is numbered like ${d.template.replace("{FY}", fy.slice(2, 4) + "-" + fy.slice(5)).replace("{N}", "0001")}; check the number format before seeding`;
    else if (d.seedSource === "tally_highest" && list.length > counters.length * 20 && counters.length > 0) warning = `only ${counters.length} of ${list.length} ${titleCase(key)} numbers are in this year's series`;
    return { voucherType: titleCase(key), fy, template: d.template, width: d.width, seedSource: d.seedSource, inTally: list.length, inSeries: counters.length, highest,
      next: formatSeriesNumber(d.template, fy, highest + 1, d.width), warning };
  });
}

/** The statements that seed the series, undo them, and read them back. `seriesKey` is the company key the new app sends in a job (default MKCP). */
export function seedSql(seeds: SeriesSeed[], o: { seriesKey: string; mirrorCompany: string }): { up: string; down: string; check: string } {
  const note = "go-live seed from Tally";
  const rows = seeds.map((s) => `  (${sqlStr(o.seriesKey)}, ${sqlStr(s.voucherType)}, ${sqlStr(s.fy)}, ${sqlStr(s.template)}, ${s.width}, ${sqlStr(s.seedSource)}, ${sqlStr(o.mirrorCompany)}, ${s.highest}, false, ${sqlStr(note)})`).join(",\n");
  const fy = seeds[0]?.fy ?? "";
  return {
    up: `insert into public.erp_voucher_series (company_key, voucher_type, fy, template, width, seed_source, mirror_company, last_issued, is_test, note)\nvalues\n${rows}\non conflict (company_key, type_key, fy) do nothing;`,
    down: `delete from public.erp_voucher_series s\n where s.company_key = ${sqlStr(o.seriesKey)} and s.fy = ${sqlStr(fy)} and s.note = ${sqlStr(note)} and not s.is_test\n   and not exists (select 1 from public.erp_voucher_tombstones t where t.company_key = s.company_key and t.type_key = s.type_key and t.fy = s.fy);`,
    check: `select voucher_type, fy, last_issued, public.erp_series_format(template, fy, last_issued + 1, width) as next_number\n  from public.erp_voucher_series where company_key = ${sqlStr(o.seriesKey)} and fy = ${sqlStr(fy)} and not is_test order by voucher_type;`,
  };
}

// ── The parity result (M9b) ──────────────────────────────────────────────────
export interface ParityVerdict { pass: boolean; lines: string[] }
/** Pure: the database's parity answer in plain lines. Anything that is not a clear `passed: true` with tables is a fail. */
export function parityVerdict(r: unknown): ParityVerdict {
  const o = (r && typeof r === "object" ? r : {}) as Record<string, any>;
  const lines: string[] = [];
  if (typeof o.passed !== "boolean" || typeof o.tables !== "object" || o.tables === null) {
    return { pass: false, lines: ["the database gave no usable parity answer; treat it as NOT passed"] };
  }
  for (const [t, v] of Object.entries<any>(o.tables)) {
    lines.push(`${t}: ${v.old_rows} rows in tally_*, ${v.new_rows} in the views${v.only_in_old || v.only_in_new ? `, ${v.only_in_old} only in tally_*, ${v.only_in_new} only in the views` : ""}`);
  }
  for (const why of Array.isArray(o.reasons) ? o.reasons : []) lines.push(`reason: ${String(why)}`);
  if (Number(o.test_rows_in_store) > 0) lines.push(`${o.test_rows_in_store} test row(s) in the swap store`);
  return { pass: o.passed === true && (!Array.isArray(o.reasons) || o.reasons.length === 0), lines };
}

// ── One real voucher (M11) ───────────────────────────────────────────────────
export interface ProofInput {
  /** The vouchers Tally returned for the date, type and number the job names. */
  found: number;
  differences: string[];
  jobState: string | null;
  jobAttempts: number | null;
  /** How many jobs share this REMOTEID (must be 1). */
  jobsWithRemoteId: number | null;
  bookedNumber: string | null;
  sentNumber: string | null;
  /** The counter's last_issued for this series, and the counter inside the booked number, when both are known. */
  counterLast: number | null;
  numberCounter: number | null;
  /** True when the company the voucher was read from is the pinned one. */
  pinned: boolean;
}
export interface ProofCheck { name: string; ok: boolean; detail: string }
/** Pure: the checks of runbook step M11 for one voucher that was read back. A check whose input is unknown fails; unknown is never a pass. */
export function proofChecks(i: ProofInput): ProofCheck[] {
  const c = (name: string, ok: boolean, detail = ""): ProofCheck => ({ name, ok, detail });
  return [
    c("the voucher was read from the pinned company", i.pinned, i.pinned ? "" : "the open company is not the pinned one"),
    c("Tally holds exactly one voucher with this type, date and number", i.found === 1, `${i.found} found`),
    c("what Tally stored equals what was sent (no difference)", i.found === 1 && i.differences.length === 0, i.differences.slice(0, 4).join("; ")),
    c("the queue shows the job succeeded", i.jobState === "succeeded", String(i.jobState)),
    c("it was sent once", i.jobsWithRemoteId === 1 && (i.jobAttempts ?? 99) <= 1, `${i.jobsWithRemoteId ?? "?"} job(s) with this REMOTEID, ${i.jobAttempts ?? "?"} attempt(s)`),
    c("the number booked is the number the counter gave", !!i.bookedNumber && i.bookedNumber === i.sentNumber, `booked ${i.bookedNumber ?? "?"}, sent ${i.sentNumber ?? "?"}`),
    c("the counter stands at this number (the next one is one above)", i.counterLast !== null && i.numberCounter !== null && i.counterLast >= i.numberCounter, `counter ${i.counterLast ?? "?"}, number ${i.numberCounter ?? "?"}`),
  ];
}

// ── The preflight (D4) ───────────────────────────────────────────────────────
export interface PreflightLine { name: string; ok: boolean; detail: string }
export function preflightText(lines: PreflightLine[]): { text: string; ready: boolean } {
  const ready = lines.every((l) => l.ok);
  return { ready, text: lines.map((l) => `  ${l.ok ? "READY    " : "NOT READY"}  ${l.name}${l.detail ? `  (${l.detail})` : ""}`).join("\n") + `\n\n  ${ready ? "every line is ready" : `${lines.filter((l) => !l.ok).length} line(s) not ready; the agent will not start the primary mode`}` };
}
