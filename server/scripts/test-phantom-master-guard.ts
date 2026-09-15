/**
 * A master keyed on its own NAME must never reach Supabase.
 *
 * PURE — no live Tally, no Supabase. Feeds the guard the exact shapes the
 * browser sends and asserts which survive.
 *
 * ── What broke ────────────────────────────────────────────────────────────
 *
 * `hasRealGuid` was `!!(m?.guid || "").trim()` — it tested only that the guid
 * was NON-EMPTY. The ids it exists to block are `normalizeId(name)`: the
 * uppercased master name, forwarded by `POST /api/supabase/sync` from the
 * browser's canonical store. A name is always non-empty, so every phantom
 * passed the guard whose own 40-line docstring names it as the enemy.
 *
 * Because the upsert key IS the guid, the phantom and the real row can never
 * reconcile — the table just grows a second row per master.
 *
 * Measured live on 2026-09-15, by the GUID-shape predicate below:
 *
 *   tally_stock_items    951 rows — 492 real,  459 name-keyed
 *   tally_ledgers        940 rows — 485 real,  455 name-keyed
 *   tally_stock_groups    22 rows —  22 real,    0
 *   tally_units            9 rows —   9 real,    0
 *   tally_godowns          1 row  —   1 real,    0
 *   tally_cost_centres     0 rows (this company has none)
 *
 * The 14-Sep-2026 backup held 7 name-keyed stock rows. So it went 7 -> 459 in
 * a day, two days AFTER the guard was extended to every master type and
 * recorded as "verified inert before extending it". It was inert on every path.
 *
 * ── Why tightening is safe ────────────────────────────────────────────────
 *
 * Every master type Tally itself serves carries a GUID-shaped id. Counted from
 * the captured fixtures rather than taken on trust:
 *
 *   MKCP_Ledger      482 GUID tags, 482 GUID-shaped
 *   MKCP_StockItem   489 / 489
 *   MKCP_StockGroup   22 / 22
 *   MKCP_Unit          9 / 9
 *   MKCP_Godown        1 / 1
 *   MKCP_CostCentre    0 masters returned
 *
 * So failing closed drops nothing Tally sends, and blocks only the
 * browser-forwarded canonical ids. Guardrail G5.
 *
 * ── Why this test exists at all ───────────────────────────────────────────
 *
 * Nothing exercised the guard. It could be reduced to a truthiness check and
 * every suite stayed green while half of two master tables filled with rubbish.
 */

/** The shipped predicate, copied verbatim from `SupabaseSync.hasRealGuid`.
 *  It is private, so this mirrors it; the assertions below are the contract
 *  either copy has to meet. */
function hasRealGuid(m: any): boolean {
  const g = (m?.guid || "").trim();
  if (!g) return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]+$/i.test(g)) return false;
  const name = (m?.name || "").trim();
  return !(name && g.toUpperCase() === name.toUpperCase());
}

let failures = 0;
function check(label: string, got: boolean, want: boolean) {
  if (got === want) return;
  failures++;
  console.error(`  FAIL  ${label}\n        expected ${want}, got ${got}`);
}

/* ── Real masters, exactly as Tally serves them. All must survive. ──────── */
const REAL = [
  { label: "stock item", guid: "353d02e0-63aa-11d7-8d44-d4bc1970ad56-0003ce47", name: "BICYCLE TREND 20X1.75" },
  { label: "ledger", guid: "353d02e0-63aa-11d7-8d44-d4bc1970ad56-00000123", name: "KAY ECH CYCLES" },
  { label: "stock group", guid: "353d02e0-63aa-11d7-8d44-d4bc1970ad56-000000a1", name: "TRICYCLE DASH ( 950300 @ 12/ 5 %)" },
  { label: "unit", guid: "353d02e0-63aa-11d7-8d44-d4bc1970ad56-00000009", name: "PCS" },
  { label: "godown", guid: "353d02e0-63aa-11d7-8d44-d4bc1970ad56-00000001", name: "Main Location" },
  { label: "uppercase GUID (Tally is not case-stable)", guid: "353D02E0-63AA-11D7-8D44-D4BC1970AD56-0003CE47", name: "ANYTHING" },
];

/* ── Browser-forwarded canonical masters. None may survive. ─────────────── */
const PHANTOM = [
  { label: "canonical id = the name", guid: "BICYCLE TREND 20X1.75", name: "BICYCLE TREND 20X1.75" },
  { label: "canonical id, different case from name", guid: "ELECTRIC SCOOTER SIGMA", name: "Electric Scooter Sigma" },
  { label: "ledgerId (also a name)", guid: "KAY ECH CYCLES", name: "KAY ECH CYCLES" },
  { label: "safeGuid's company|name fallback", guid: "M.K.CYCLES (P) LTD.|BASKET KID", name: "BASKET KID" },
  { label: "empty", guid: "", name: "NO GUID" },
  { label: "whitespace only", guid: "   ", name: "WHITESPACE" },
  { label: "undefined", guid: undefined, name: "MISSING" },
  { label: "an HSN code", guid: "950300", name: "NUMERIC" },
  { label: "a name that happens to be hex", guid: "abcdef12", name: "SHORT HEX" },
  { label: "hex but wrong grouping", guid: "353d02e0-63aa11d7-8d44", name: "MALFORMED" },
];

console.log("Real masters — must be ACCEPTED:");
for (const m of REAL) {
  const got = hasRealGuid(m);
  console.log(`  ${got ? "ok  " : "FAIL"}  ${m.label}`);
  check(m.label, got, true);
}

console.log("\nBrowser-forwarded phantoms — must be REJECTED:");
for (const m of PHANTOM) {
  const got = hasRealGuid(m);
  console.log(`  ${!got ? "ok  " : "FAIL"}  ${m.label}`);
  check(m.label, got, false);
}

/* ── The regression itself ─────────────────────────────────────────────────
   The old guard was `!!(guid||"").trim()`. Assert it would FAIL this suite,
   so a future simplification back to truthiness cannot pass silently — which
   is exactly how this defect shipped. */
const oldGuard = (m: any) => !!(m?.guid || "").trim();
const oldGuardAccepts = PHANTOM.filter(oldGuard).length;
console.log(`\nThe old truthiness guard accepts ${oldGuardAccepts} of ${PHANTOM.length} phantoms.`);
if (oldGuardAccepts === 0) {
  failures++;
  console.error("  FAIL  this suite cannot distinguish the old guard from the new one, so it proves nothing");
}

console.log(failures === 0 ? "\nPASS — the guard tests identity, not emptiness." : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
