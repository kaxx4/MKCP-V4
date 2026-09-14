/**
 * Phase 2.3 — deriving the object spine from what the books already hold.
 *
 * ── Why this is real work and not a script ────────────────────────────────
 *
 * The schema was the easy half. The hard half is that every existing order,
 * bill and shipment has to get its initial state from somewhere, and the
 * derivation is genuinely ambiguous: an order half-shipped two months ago has
 * no obvious state, and a bill part-settled across three receipts has to land
 * somewhere.
 *
 * So this is built to be RE-RUN. The first pass will be wrong in ways only the
 * operator can name, and the fix for that is not to get it right first time —
 * it is to make being wrong cheap:
 *
 *   · Every derived row carries `derived_from`, `derived_at` and a version, so
 *     you can tell what produced a state and re-derive when the rule changes.
 *   · `operator_state` is NEVER written here and always wins on read (G10).
 *     A person's correction survives every re-run.
 *   · Nothing is deleted. A re-run upserts on the natural key.
 *
 * ── Dry run is the default ────────────────────────────────────────────────
 *
 * It prints what it would write, including every case it is unsure about,
 * and writes nothing unless asked. The ambiguous cases are the output that
 * matters — they are the questions for the operator.
 *
 *   npx tsx server/scripts/derive-objects.ts            # dry run
 *   npx tsx server/scripts/derive-objects.ts --write
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const COMPANY = process.env.TALLY_COMPANY || "";
const SB_URL = process.env.SUPABASE_URL!;
const SB_KEY = (process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY)!;
const WRITE = process.argv.includes("--write");

/** Bump when the RULES change, so a row's state can be traced to a rule set. */
const DERIVATION_VERSION = 1;

/** Modal credit period in this business — see the domain layer. */
const DEFAULT_CREDIT_DAYS = 20;

const sb: SupabaseClient = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

interface Alloc {
  party: string; voucher_type: string; date: string; guid: string;
  bill_name: string; bill_type: string; amt: number;
  credit_period_raw: string | null; bill_date: string | null; bill_id: number | null;
}

/** "14 Days" -> 14. Returns null rather than guessing when it cannot read it. */
function parseCreditDays(raw: string | null): number | null {
  if (!raw) return null;
  const m = raw.match(/(\d+)\s*day/i);
  return m ? parseInt(m[1], 10) : null;
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function loadAllocations(): Promise<Alloc[]> {
  /* Paged: 8,700+ ledger entries, and a single select would silently truncate
     at the API's default limit — which would understate every bill without
     erroring, exactly the failure mode being designed against. */
  const out: Alloc[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("tally_voucher_ledger_entries")
      .select("ledger_name, voucher_guid, bill_allocations")
      .eq("company", COMPANY)
      .not("bill_allocations", "is", null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;

    for (const row of data) {
      const allocs = row.bill_allocations;
      if (!Array.isArray(allocs)) continue;
      for (const a of allocs) {
        const name = String(a?.name ?? "").trim();
        const type = String(a?.billtype ?? "").trim();
        /* Phantom guard. convertVouchers used to materialise a bill from every
           EMPTY placeholder block, inventing billtype "New Ref" and amount "0"
           — 6,779 of 7,621 lines in this mirror. Fixed at the converter, but
           the rows already written are still here until a full re-sync, so the
           derivation refuses them rather than deriving 6,779 phantom bills. */
        if (!name || !type) continue;
        const amt = Number(String(a?.amount ?? "").replace(/,/g, ""));
        if (!Number.isFinite(amt)) continue;
        out.push({
          party: row.ledger_name, voucher_type: "", date: "", guid: row.voucher_guid,
          bill_name: name, bill_type: type, amt,
          credit_period_raw: a?.creditperiod ?? null,
          bill_date: a?.billdate ?? null,
          bill_id: a?.billid ?? null,
        });
      }
    }
    if (data.length < PAGE) break;
  }
  return out;
}

async function loadVoucherDates(): Promise<Map<string, { date: string; type: string }>> {
  const m = new Map<string, { date: string; type: string }>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from("tally_vouchers")
      .select("guid, date, voucher_type, is_cancelled")
      .eq("company", COMPANY).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    for (const v of data) {
      if (v.is_cancelled) continue;
      m.set(v.guid, { date: String(v.date).slice(0, 10), type: v.voucher_type ?? "" });
    }
    if (data.length < PAGE) break;
  }
  return m;
}

interface DerivedBill {
  company: string; party_name: string; bill_name: string;
  direction: "receivable" | "payable";
  raised_on: string | null; raised_amount: number | null;
  credit_period_raw: string | null; credit_days: number | null; due_on: string | null;
  settled_amount: number; outstanding: number; last_settled_on: string | null;
  settlement_count: number;
  state: "raised" | "ageing" | "part_settled" | "closed";
  raising_voucher_guid: string | null; bill_id: number | null;
  derived_from: string; derived_at: string; derivation_version: number;
}

async function main(): Promise<void> {
  console.log("\n  DERIVING THE OBJECT SPINE" + (WRITE ? "" : "  (DRY RUN — nothing is written)"));
  console.log("  " + "─".repeat(72));
  console.log(`  company: ${COMPANY}\n`);

  const [allocs, vmeta] = await Promise.all([loadAllocations(), loadVoucherDates()]);
  for (const a of allocs) {
    const v = vmeta.get(a.guid);
    if (v) { a.date = v.date; a.type = v.type; }
  }
  const live = allocs.filter((a) => a.date);       // cancelled vouchers dropped
  console.log(`  ${allocs.length} named allocations · ${live.length} on live vouchers\n`);

  // ── Bills ───────────────────────────────────────────────────────────────
  type Key = string;
  /* JSON, not a delimiter. A party name or bill reference can contain almost
     any character, so any separator is a guess — and a NUL byte, while safe,
     makes the source read as binary to grep and half the toolchain. */
  const key = (p: string, b: string): Key => JSON.stringify([p, b]);

  const raised = new Map<Key, Alloc[]>();
  const settledAgainst = new Map<Key, Alloc[]>();
  const onAccount: Alloc[] = [];

  for (const a of live) {
    const k = key(a.party, a.bill_name);
    if (a.bill_type === "New Ref") (raised.get(k) ?? raised.set(k, []).get(k)!).push(a);
    else if (a.bill_type === "Agst Ref") (settledAgainst.get(k) ?? settledAgainst.set(k, []).get(k)!).push(a);
    else onAccount.push(a);
  }

  const keys = new Set<Key>([...raised.keys(), ...settledAgainst.keys()]);
  const bills: DerivedBill[] = [];
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  /* The cases the plan warned about, counted rather than smoothed over. */
  const ambiguous = {
    settledButNeverRaised: [] as string[],
    overSettled: [] as string[],
    noCreditPeriod: 0,
    billNameReused: [] as string[],
  };

  for (const k of keys) {
    const [party, bill_name] = JSON.parse(k) as [string, string];
    const r = raised.get(k) ?? [];
    const s = settledAgainst.get(k) ?? [];

    if (r.length > 1) ambiguous.billNameReused.push(`${party} / ${bill_name} (${r.length}x)`);

    const raisedAmt = r.length ? r.reduce((t, x) => t + x.amt, 0) : null;
    const settledAmt = s.reduce((t, x) => t + x.amt, 0);

    /* Tally signs the party line: a sale is NEGATIVE on a receivable and a
       receipt POSITIVE, so they net toward zero. Direction comes from the sign
       of what was raised, not from the voucher type — a credit note raises a
       negative receivable and must not be classified as a payable. */
    const direction: "receivable" | "payable" =
      (raisedAmt ?? settledAmt) <= 0 ? "receivable" : "payable";

    if (raisedAmt === null) {
      /* Settled against a bill this mirror never saw raised. Overwhelmingly
         this is a bill from a PRIOR financial year — the mirror holds FY26-27
         only — not a data error. It is recorded with a null raised_amount and
         named here rather than being given an invented opening figure. */
      ambiguous.settledButNeverRaised.push(`${party} / ${bill_name}`);
    } else if (Math.abs(raisedAmt + settledAmt) > Math.abs(raisedAmt) + 1) {
      ambiguous.overSettled.push(`${party} / ${bill_name}`);
    }

    const raisedOn = r.length ? r.map((x) => x.date).sort()[0] : null;
    const creditRaw = r.find((x) => x.credit_period_raw)?.credit_period_raw ?? null;
    const creditDays = parseCreditDays(creditRaw);
    if (creditDays === null) ambiguous.noCreditPeriod++;

    /* Due date uses the bill's OWN period when Tally gave one, and the business
       modal only as a documented fallback — never silently. */
    const effectiveDays = creditDays ?? DEFAULT_CREDIT_DAYS;
    const dueOn = raisedOn ? addDays(raisedOn, effectiveDays) : null;

    const outstanding = (raisedAmt ?? 0) + settledAmt;
    const closed = Math.abs(outstanding) <= 1;   // whole-rupee books; ±1 is noise

    const state: DerivedBill["state"] =
      closed ? "closed"
        : s.length > 0 ? "part_settled"
          : dueOn && dueOn < today ? "ageing"
            : "raised";

    bills.push({
      company: COMPANY, party_name: party, bill_name, direction,
      raised_on: raisedOn, raised_amount: raisedAmt,
      credit_period_raw: creditRaw,
      credit_days: creditDays,
      due_on: dueOn,
      settled_amount: settledAmt,
      outstanding,
      last_settled_on: s.length ? s.map((x) => x.date).sort().at(-1)! : null,
      settlement_count: s.length,
      state,
      raising_voucher_guid: r[0]?.guid ?? null,
      bill_id: r.find((x) => x.bill_id)?.bill_id ?? null,
      derived_from:
        `bill allocations v${DERIVATION_VERSION}: ${r.length} New Ref + ${s.length} Agst Ref` +
        (raisedAmt === null ? "; raised in a period this mirror does not hold" : "") +
        (creditDays === null ? `; no BILLCREDITPERIOD, used the ${DEFAULT_CREDIT_DAYS}-day modal` : ""),
      derived_at: now,
      derivation_version: DERIVATION_VERSION,
    });
  }

  // ── What it found ───────────────────────────────────────────────────────
  const by = (st: string) => bills.filter((b) => b.state === st).length;
  const openValue = bills.filter((b) => b.state !== "closed").reduce((t, b) => t + b.outstanding, 0);

  console.log("  BILLS");
  console.log(`    ${bills.length} derived`);
  console.log(`      raised       ${by("raised")}`);
  console.log(`      ageing       ${by("ageing")}`);
  console.log(`      part_settled ${by("part_settled")}`);
  console.log(`      closed       ${by("closed")}`);
  console.log(`    receivable ${bills.filter((b) => b.direction === "receivable").length} · ` +
    `payable ${bills.filter((b) => b.direction === "payable").length}`);
  console.log(`    open value ${inr(Math.abs(openValue))}`);

  console.log("\n  WHAT THE DERIVATION IS NOT SURE ABOUT — these are the operator's questions");
  console.log(`    settled against a bill never raised here : ${ambiguous.settledButNeverRaised.length}`);
  console.log(`      almost certainly prior-year bills; the mirror holds FY26-27 only.`);
  console.log(`      Recorded with a NULL raised_amount rather than an invented opening figure.`);
  for (const x of ambiguous.settledButNeverRaised.slice(0, 3)) console.log(`        e.g. ${x}`);
  console.log(`    settled for MORE than raised             : ${ambiguous.overSettled.length}`);
  for (const x of ambiguous.overSettled.slice(0, 3)) console.log(`        e.g. ${x}`);
  console.log(`    bill name reused by the same party       : ${ambiguous.billNameReused.length}`);
  for (const x of ambiguous.billNameReused.slice(0, 3)) console.log(`        e.g. ${x}`);
  console.log(`    no credit period on the allocation       : ${ambiguous.noCreditPeriod}`);
  console.log(`      fell back to the ${DEFAULT_CREDIT_DAYS}-day modal, and every such row SAYS so in derived_from.`);

  if (ambiguous.noCreditPeriod === bills.length) {
    console.log(`\n    ALL of them — the mirror predates the converter fix that reads`);
    console.log(`    BILLCREDITPERIOD. Re-run after a full voucher sync and this collapses.`);
  }

  // ── Write ───────────────────────────────────────────────────────────────
  if (!WRITE) {
    console.log(`\n  Dry run. Nothing written. Pass --write to upsert ${bills.length} bills.`);
    console.log(`  operator_state is never written by this script and always wins on read.\n`);
    return;
  }

  console.log(`\n  Writing ${bills.length} bills…`);
  const CHUNK = 500;
  let done = 0;
  for (let i = 0; i < bills.length; i += CHUNK) {
    const chunk = bills.slice(i, i + CHUNK);
    const { error } = await sb.from("mkcp_bills")
      .upsert(chunk, { onConflict: "company,party_name,bill_name" });
    if (error) throw new Error(`mkcp_bills: ${error.message}`);
    done += chunk.length;
    process.stdout.write(`\r    ${done}/${bills.length}`);
  }
  console.log(`\n  Done. Re-runnable: upserts on (company, party, bill_name), never deletes,`);
  console.log(`  and never touches operator_state.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
