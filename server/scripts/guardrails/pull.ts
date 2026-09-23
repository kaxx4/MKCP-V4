/**
 * --pull : READ-ONLY audit of the mirror against Tally.
 *
 *   · The OFFICE Tally is reached only through Tally's own reports, already in
 *     tally_report_snapshots. `--refresh-reports` asks for fresh ones by
 *     inserting rows into tally_report_jobs — the one write this mode can make,
 *     explicitly allowed (a pure read on the office side). Never a push.
 *   · The SANDBOX Tally (this machine, when MKCP_TALLY_ROLE=sandbox) is read
 *     directly — its own native vouchers are used to CHECK THE INSTRUMENT: if
 *     the tax-parity checker disagreed with Tally's own arithmetic on vouchers a
 *     person typed, the checker would be wrong, not the books (method step 5).
 *
 * Window: today and the previous 6 days (MKCP_GUARD_DAYS to change).
 */
import { unesc, check, unverified, voucherFromMirror, checkTaxParity, taxParity, isOutward, parseVoucher, HOME, TAX_HEAD, ROUNDING } from "./lib.js";
import { mirrorClient, mastersFromMirror, allRows, COMPANY_KEY } from "./mirror.js";
import { todayLocal } from "./sandbox.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TallyMasters } from "../../src/services/tallyMasters.js";

const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const FY_START = "2026-04-01";
const money = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function runPull(opts: { refreshReports: boolean }): Promise<void> {
  const sb = mirrorClient();
  if (!sb) { unverified("TG-L01", "no Supabase read credentials in server/.env"); return; }
  const today = todayLocal();
  const days = Math.max(1, Number(process.env.MKCP_GUARD_DAYS) || 7);
  const from = addDays(today, -(days - 1));
  console.log(`  mirror window ${from} … ${today}`);

  if (opts.refreshReports) await refreshReports(sb, ["trial-balance", "bills-receivable", "bills-payable", "gst-rate-setup"]);

  const m = await mastersFromMirror(sb);
  const fy = await allRows<any>(sb, "tally_vouchers",
    "guid,date,voucher_number,voucher_type,party_ledger_name,is_cancelled,is_optional,ledger_entries,inventory_entries,party_gstin,place_of_supply,consignee_state,consignee_pincode,ewb_number,irn,alter_id,remote_id,synced_at",
    (q) => q.gte("date", FY_START).lte("date", today));
  const live = fy.filter((r) => !r.is_cancelled && !r.is_optional);
  const win = live.filter((r) => r.date >= from);
  console.log(`  mirror: ${fy.length} FY vouchers, ${win.length} in window`);

  // ── TG-L01 completeness: when did a FULL re-read last land? ──────────────
  const hist = await sb.from("tally_sync_history").select("sync_type,started_at,success,row_counts,alter_id").eq("company", COMPANY_KEY)
    .order("started_at", { ascending: false }).limit(3000);
  const rows = hist.data ?? [];
  const full = rows.find((h: any) => h.success && h.sync_type === "vouchers" && Number(h.row_counts?.vouchers) >= 500);
  const ageH = full ? (Date.now() - Date.parse(full.started_at)) / 3.6e6 : Infinity;
  check("TG-L01", ageH <= 48, full
    ? `last full voucher re-read (≥500 rows) was ${ageH.toFixed(0)}h ago (${full.started_at}) — backdated entries typed since then may be missing from the mirror`
    : `no full voucher re-read (≥500 rows) in the last ${rows.length} sync-history rows — nothing re-reads a backdated day`);
  const backdatedToday = win.filter((r) => r.date < today && String(r.synced_at ?? "").slice(0, 10) === today).length;
  console.log(`  ${backdatedToday} window voucher(s) dated before today were (re)synced today`);

  // ── TG-L02 incremental cursor ────────────────────────────────────────────
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  const recent = rows.filter((h: any) => h.started_at >= dayAgo);
  const withCursor = recent.filter((h: any) => h.alter_id != null).length;
  check("TG-L02", withCursor > 0, `${recent.length} sync runs in the last 24h, ${withCursor} recorded an AlterID cursor — incremental sync is not observable from the history`);
  check("TG-L02", fy.every((r) => r.alter_id != null), `${fy.filter((r) => r.alter_id == null).length} mirrored vouchers carry no alter_id`);

  // ── TG-L03 prune safety / company key ────────────────────────────────────
  const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}$/i;
  for (const t of ["tally_stock_items", "tally_ledgers", "tally_stock_groups"]) {
    const g = await allRows<any>(sb, t, "guid,name");
    const phantoms = g.filter((r) => !GUID.test(String(r.guid ?? "")));
    check("TG-L03", phantoms.length === 0, `${t}: ${phantoms.length} of ${g.length} rows have no Tally GUID (e.g. "${phantoms[0]?.guid}") — phantom masters a name-keyed prune cannot tell from real ones`);
  }
  const phantomV = fy.filter((r) => !GUID.test(String(r.guid ?? "")));
  check("TG-L03", phantomV.length === 0, `tally_vouchers: ${phantomV.length} FY rows without a Tally GUID`);
  const cos = await sb.from("tally_companies").select("*");
  const cols = Object.keys(cos.data?.[0] ?? {});
  check("TG-L03", cols.some((c) => /machine|source|role|tally_host|guid/i.test(c)),
    `tally_companies is keyed on the company NAME only (${cos.data?.length} row, columns ${cols.join(",")}); a sandbox copy carries the same name, so nothing distinguishes its rows from the office's (mkcp-mirror-company-key-collision) — structural, unresolved`);

  // ── TG-L04 sign conventions / balance ────────────────────────────────────
  let unbalanced = 0, badSign = 0; const ex: string[] = [];
  for (const r of live) {
    const v = voucherFromMirror(r);
    if (!v.ledgers.length) continue;
    const net = v.ledgers.reduce((s, l) => s + l.amount, 0);
    if (Math.abs(net) > 0.02) { unbalanced++; if (ex.length < 4) ex.push(`${r.voucher_type} ${r.voucher_number} ${r.date} nets ${net.toFixed(2)}`); }
    for (const l of v.ledgers) {
      // Rounding and discount/rebate lines legitimately carry the sign opposite to
      // their side on either direction (a negative credit on a sale, a "negative
      // debit" on a purchase) — 318 sales round-offs are written that way by hand.
      const contra = ROUNDING.test(l.ledger) || /DISCOUNT|REBATE/i.test(l.ledger);
      if (!contra && (l.dr ? l.amount > 0.001 : l.amount < -0.001)) { badSign++; if (ex.length < 6) ex.push(`${r.voucher_number} "${l.ledger}" dr=${l.dr} ${l.amount}`); }
    }
  }
  check("TG-L04", unbalanced === 0 && badSign === 0, `${unbalanced} unbalanced vouchers, ${badSign} lines whose sign contradicts their side, of ${live.length}: ${ex.join("; ")}`);

  // ── TG-L05 dated rates vs Tally's GST Rate Setup ─────────────────────────
  const setup = await snapshot(sb, "gst-rate-setup");
  if (!setup) unverified("TG-L05", "no gst-rate-setup snapshot");
  else {
    let compared = 0;
    const entity = (setup.rows as any[]).filter((s) => /&(quot|amp|apos|lt|gt|#\d+);/.test(String(s.name)));
    check("TG-L05", entity.length === 0, `gst-rate-setup snapshot stores ${entity.length} master names still XML-escaped (e.g. "${entity[0]?.name}") — a lookup by the real name misses them`);
    const escapedRates = (await allRows<any>(sb, "tally_gst_rates", "name")).filter((r) => /&(quot|amp|apos|lt|gt|#\d+);/.test(String(r.name)));
    check("TG-L05", escapedRates.length === 0, `tally_gst_rates stores ${escapedRates.length} rows under XML-escaped names (e.g. "${escapedRates[0]?.name}") while tally_stock_items holds the decoded name — the rate for those items is unreachable by name (tally-voucher-import-rules #11)`);
    for (const s0 of setup.rows as any[]) {
      const s = { ...s0, name: unesc(String(s0.name)) };
      if (s.igstRate == null) continue; // Tally declares nothing here; nothing to mirror
      const g = m.stockGroups.get(s.name); const it = m.items.get(s.name);
      const revs = (g ?? it)?.gstRevisions ?? [];
      if (!revs.length) { check("TG-L05", false, `"${s.name}" declares ${s.igstRate}% from ${s.rateFrom} in Tally's GST Rate Setup, but the mirror holds no dated rate for it`); continue; }
      compared++;
      const newest = [...revs].filter((r) => !r.from || r.from <= today).pop()!;
      check("TG-L05", Math.abs(newest.igst - Number(s.igstRate)) < 0.001 && (!s.rateFrom || newest.from === s.rateFrom),
        `"${s.name}": mirror's newest revision ${newest.igst}% from ${newest.from || "undated"} ≠ Tally's ${s.igstRate}% from ${s.rateFrom}`);
    }
    console.log(`  GST Rate Setup (${setup.captured_at}): ${setup.rows.length} masters, ${compared} with mirrored revisions`);
  }
  const undatedBlocks = (await allRows<any>(sb, "tally_stock_items", "guid,gst_details")).filter((r) => GUID.test(String(r.guid)))
    .flatMap((r) => (Array.isArray(r.gst_details) ? r.gst_details : [])).filter((b: any) => !b?.applicablefrom).length;
  check("TG-L05", undatedBlocks === 0, `${undatedBlocks} GST blocks on mirrored stock items carry no applicablefrom — the newest-not-after rule cannot be applied to them`);

  // ── TG-L06 every item SOLD resolves a rate and an HSN ────────────────────
  const soldItems = new Set<string>();
  for (const r of live) if (isOutward(r.voucher_type)) for (const s of r.inventory_entries ?? []) soldItems.add(String(s.stockitemname));
  const hsnRows = await allRows<any>(sb, "tally_stock_items", "guid,name,parent,hsn_details");
  const hsnOf = (name: string): string => {
    const row = hsnRows.find((r) => r.name === name && GUID.test(String(r.guid)));
    const own = (Array.isArray(row?.hsn_details) ? row.hsn_details : []).map((b: any) => String(b?.hsncode ?? "").trim()).filter(Boolean);
    if (own.length) return own[own.length - 1];
    let g = m.items.get(name)?.parent; const seen = new Set<string>();
    while (g && !seen.has(g)) { seen.add(g); const sr = (setup?.rows as any[] | undefined)?.find((x) => x.name === g); if (sr?.hsn) return sr.hsn; const inName = /\(\s*(\d{4,8})\s*[@)]/.exec(g)?.[1]; if (inName) return inName; g = m.stockGroups.get(g)?.parent; }
    return "";
  };
  const noRate: string[] = [], noHsn: string[] = [];
  const { gstRateFor } = await import("../../src/services/tallyMasters.js");
  for (const n of soldItems) {
    if (!(gstRateFor(m, n, today).rate > 0)) noRate.push(n);
    if (!hsnOf(n)) noHsn.push(n);
  }
  check("TG-L06", noRate.length === 0, `${noRate.length} of ${soldItems.size} items sold this FY resolve NO GST rate through item → group: ${noRate.slice(0, 5).map((x) => `"${x}"`).join(", ")}`);
  check("TG-L06", noHsn.length === 0, `${noHsn.length} of ${soldItems.size} items sold this FY resolve NO HSN: ${noHsn.slice(0, 5).map((x) => `"${x}"`).join(", ")}`);

  // ── TG-L07 price list ────────────────────────────────────────────────────
  const pl = await sb.from("tally_price_list").select("price_level,effective_from,rate", { count: "exact" }).eq("company", COMPANY_KEY).limit(1000);
  const plRows = pl.data ?? [];
  check("TG-L07", (pl.count ?? 0) > 0 && plRows.every((r: any) => r.effective_from) && plRows.some((r: any) => /dealer/i.test(r.price_level)),
    `tally_price_list: ${pl.count ?? 0} rows, ${plRows.filter((r: any) => !r.effective_from).length} undated in the first page, DEALER level ${plRows.some((r: any) => /dealer/i.test(r.price_level)) ? "present" : "absent"}`);

  // ── TG-L08 bills vs Tally's report ───────────────────────────────────────
  for (const key of ["bills-receivable", "bills-payable"]) await billsParity(sb, key, fy);

  // ── TG-L09/L10/L14 outward invoices in the window ────────────────────────
  const partyLedger = (n: string) => m.ledgers.get(n);
  // A column the sync never fills cannot decide a GSTR precondition — that is a
  // mirror defect (TG-L14), not evidence about the voucher (G7).
  const fySales = live.filter((r) => /^SALES$/i.test(r.voucher_type));
  const fill = (c: string) => fySales.filter((r) => String(r[c] ?? "").trim()).length;
  const posFilled = fill("place_of_supply"), gstinFilled = fill("party_gstin"), csFilled = fill("consignee_state");
  check("TG-L14", posFilled > 0, `place_of_supply is empty on ALL ${fySales.length} mirrored FY sales — the column exists but the sync never fills it`);
  check("TG-L14", gstinFilled > 0, `party_gstin is empty on ALL ${fySales.length} mirrored FY sales — the column exists but the sync never fills it`);
  console.log(`  FY sales fill: place_of_supply ${posFilled}/${fySales.length}, party_gstin ${gstinFilled}/${fySales.length}, consignee_state ${csFilled}/${fySales.length}`);
  if (!posFilled) unverified("TG-L10", "place of supply cannot be audited from the mirror (never populated) — audited on Tally reads in --sandbox only");
  if (!gstinFilled) unverified("TG-L10", "party GSTIN on the voucher cannot be audited from the mirror (never populated)");
  let outwardN = 0;
  for (const r of win) {
    if (!/^SALES$/i.test(r.voucher_type) || !(r.inventory_entries ?? []).length) continue;
    outwardN++;
    const v = voucherFromMirror(r);
    const L = `[mirror] ${r.voucher_type} ${r.voucher_number} ${r.date}`;
    checkTaxParity("TG-L09", v, m, L);
    const pos = String(r.place_of_supply ?? "").trim() || String(r.consignee_state ?? "").trim() || (partyLedger(r.party_ledger_name)?.state ?? "");
    if (posFilled) check("TG-L10", !!String(r.place_of_supply ?? "").trim(), `${L}: no place of supply`);
    const led = partyLedger(r.party_ledger_name);
    if (gstinFilled && led?.gstin) check("TG-L10", String(r.party_gstin ?? "") === led.gstin, `${L}: party_gstin "${r.party_gstin ?? ""}" ≠ ledger GSTIN ${led.gstin} — files B2C/exception instead of B2B`);
    const inter = !!pos && pos.toUpperCase() !== HOME.toUpperCase();
    const names = v.ledgers.map((l) => l.ledger);
    const usesIgst = names.some((n) => /\bIGST\b/i.test(n)), usesPair = names.some((n) => /\b(CGST|SGST)\b/i.test(n));
    if (pos) check("TG-L10", inter ? !usesPair : !usesIgst, `${L}: place of supply ${pos} but tax heads ${names.filter((n) => TAX_HEAD.test(n)).join("+") || "none"}`);
    check("TG-L10", names.some((n) => TAX_HEAD.test(n)) || taxParity(v, m).expected < 0.5, `${L}: taxable goods, no tax line`);
    // consignee_state/pincode come from the E-WAY BILL block (extractVoucherTransport),
    // so they exist only once a person has raised one — held only where an EWB exists.
    if (r.ewb_number) check("TG-L14", !!String(r.consignee_state ?? "").trim() && !!String(r.consignee_pincode ?? "").trim(),
      `${L}: e-way bill ${r.ewb_number} mirrored without its consignee state/pincode`);
  }
  if (!outwardN) unverified("TG-L09", `no SALES with stock in the mirror window ${from}…${today}`);
  console.log(`  audited ${outwardN} outward invoices in the window`);

  // ── TG-L11 appropriation visible in the mirror ───────────────────────────
  const adjLines = live.flatMap((r) => (r.ledger_entries ?? []).filter((e: any) => /TRADE DISCOUNTS/i.test(String(e.ledgername)) && isOutward(r.voucher_type)));
  const carries = adjLines.filter((e: any) => "appropriatefor" in e).length;
  check("TG-L11", adjLines.length === 0 || carries === adjLines.length,
    `${adjLines.length} TRADE DISCOUNTS lines on mirrored sales, ${carries} carry appropriatefor — the sync does not ask for ALLLEDGERENTRIES.APPROPRIATEFOR by name, so an unappropriated discount (GSTR-1 "Expected vs Modified tax" mismatch) is invisible to anything reading the mirror`);

  // ── TG-L12 totals vs Tally's Trial Balance ───────────────────────────────
  const tb = await snapshot(sb, "trial-balance");
  if (!tb) unverified("TG-L12", "no trial-balance snapshot");
  else {
    const to = String(tb.to_date ?? today);
    // Order vouchers (Sales Order Note, Purchase Order) carry ledger lines in the
    // mirror but post nothing to the books — counting them overstates revenue.
    const NON_POSTING = /ORDER|RECEIPT NOTE|DELIVERY NOTE|MATERIAL|STOCK JOURNAL|PHYSICAL/i;
    const inRange = live.filter((r) => r.date >= String(tb.from_date ?? FY_START) && r.date <= to && !NON_POSTING.test(r.voucher_type));
    for (const grp of ["Sales Accounts", "Purchase Accounts"]) {
      const row = (tb.rows as any[]).find((x) => x.name === grp);
      if (!row) { unverified("TG-L12", `trial balance has no "${grp}" row`); continue; }
      const tally = (Number(row.credit) || 0) + (Number(row.debit) || 0);   // debit is carried negative
      const members = new Set([...m.ledgers.values()].filter((l) => l.parent === grp).map((l) => l.name));
      const mirror = inRange.reduce((s, r) => s + (r.ledger_entries ?? []).filter((e: any) => members.has(e.ledgername)).reduce((a: number, e: any) => a + (parseFloat(e.amount) || 0), 0), 0);
      const diff = mirror - tally;
      const sameDay = inRange.filter((r) => r.date === to).reduce((s, r) => s + (r.ledger_entries ?? []).filter((e: any) => members.has(e.ledgername)).reduce((a: number, e: any) => a + Math.abs(parseFloat(e.amount) || 0), 0), 0);
      if (Math.abs(diff) <= 1) check("TG-L12", true, "");
      else if (Math.abs(diff) <= sameDay + 1) unverified("TG-L12", `${grp}: mirror ${money(mirror)} vs Tally ${money(tally)} (snapshot ${tb.captured_at}) — Δ ${money(diff)} is within ${to}'s own activity (${money(sameDay)}), so it may be post-snapshot entries; re-run with --refresh-reports`);
      else check("TG-L12", false, `${grp}: mirror ${money(mirror)} vs Tally's trial balance ${money(tally)} to ${to} (snapshot ${tb.captured_at}) — Δ ${money(diff)}`);
      console.log(`  ${grp}: mirror ${money(mirror)} · Tally ${money(tally)} · Δ ${money(diff)}`);
    }
    unverified("TG-L12", "GST ledgers (Duties & Taxes) cannot be compared: the Trial Balance report answers at top-group level only (Current Liabilities)");
  }

  // ── TG-L13 e-invoice clock ───────────────────────────────────────────────
  const anyIrn = fy.some((r) => r.irn);
  if (!anyIrn) unverified("TG-L13", "no mirrored voucher carries an IRN at all — cannot tell 'not raised' from 'not synced'");
  else {
    const b2b = live.filter((r) => /^SALES$/i.test(r.voucher_type) && String(r.party_gstin ?? "").trim() && !r.irn);
    const ageDays = (d: string) => (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 864e5;
    const late = b2b.filter((r) => ageDays(r.date) >= 25);
    check("TG-L13", late.length === 0, `${late.length} B2B invoices ≥25 days old with no IRN (IRP refuses after 30): ${late.slice(0, 5).map((r) => `${r.voucher_number} ${r.date}`).join(", ")}`);
    const fresh = b2b.filter((r) => ageDays(r.date) < 25).length;
    console.log(`  e-invoice: ${fy.filter((r) => r.irn).length} with IRN, ${fresh} B2B awaiting IRN inside 25 days`);
  }

  // ── Instrument check against the SANDBOX Tally's own native vouchers ─────
  await sandboxInstrumentCheck(today);
}

async function snapshot(sb: SupabaseClient, report: string): Promise<{ rows: unknown[]; captured_at: string; from_date: string | null; to_date: string | null } | null> {
  const { data } = await sb.from("tally_report_snapshots").select("rows,captured_at,from_date,to_date").eq("company", COMPANY_KEY).eq("report", report)
    .order("captured_at", { ascending: false }).limit(1);
  return (data?.[0] as any) ?? null;
}

/**
 * Bills in Tally's own report vs bills reconstructed from mirrored allocations.
 * Only bills raised this FY: an older bill's opening balance is not in any
 * mirrored voucher, so it cannot be reconstructed (and is not a mirror defect).
 */
async function billsParity(sb: SupabaseClient, key: string, fy: any[]): Promise<void> {
  const snap = await snapshot(sb, key);
  if (!snap) { unverified("TG-L08", `no ${key} snapshot`); return; }
  const sum = new Map<string, number>();
  for (const r of fy) {
    if (r.is_cancelled || r.is_optional || r.date > String(snap.to_date ?? "9999")) continue;
    for (const e of r.ledger_entries ?? []) for (const b of e.billallocations ?? []) {
      const k = `${e.ledgername}|${b.name}`;
      sum.set(k, (sum.get(k) ?? 0) + (parseFloat(b.amount) || 0));
    }
  }
  let ok = 0, compared = 0; const bad: string[] = [];
  const escaped = (snap.rows as any[]).filter((b) => /&(quot|amp|apos|lt|gt|#\d+);/.test(String(b.party)));
  check("TG-L08", escaped.length === 0, `${key} snapshot stores ${escaped.length} party names still XML-escaped (e.g. "${escaped[0]?.party}") — they match no ledger by name`);
  for (const b0 of snap.rows as any[]) {
    const b = { ...b0, party: unesc(String(b0.party)) };
    if (!b.billDate || b.billDate < FY_START) continue;
    compared++;
    const got = Math.abs(sum.get(`${b.party}|${b.billRef}`) ?? 0);
    if (Math.abs(got - Number(b.outstanding)) <= 1) ok++;
    else bad.push(`${b.party} ${b.billRef}: Tally ${money(Number(b.outstanding))}, mirror ${money(got)}`);
  }
  check("TG-L08", bad.length === 0, `${key} (snapshot ${snap.captured_at}): ${bad.length} of ${compared} FY bills disagree — ${bad.slice(0, 4).join("; ")}`);
  console.log(`  ${key}: ${ok}/${compared} FY bills agree with Tally's report (snapshot ${snap.captured_at})`);
}

/**
 * The one write this mode can make: ask the OFFICE agent for fresh reports.
 * tally_report_jobs is a pure-read request on the office side (brief, 23-Sep).
 */
async function refreshReports(sb: SupabaseClient, reports: string[]): Promise<void> {
  const since = new Date().toISOString();
  const { error } = await sb.from("tally_report_jobs").insert(reports.map((report) => ({
    company: COMPANY_KEY, report, status: "pending", requested_by: "guardrails --pull",
    ...(report === "gst-rate-setup" ? {} : { from_date: FY_START, to_date: todayLocal() }),
  })));
  if (error) { console.log(`  could not request reports: ${error.message}`); return; }
  console.log(`  requested ${reports.join(", ")} from the office agent; waiting up to 4 min …`);
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    const { data } = await sb.from("tally_report_jobs").select("report,status,error").eq("requested_by", "guardrails --pull").gte("created_at", since);
    const done = (data ?? []).filter((j: any) => j.status === "done" || j.status === "failed" || j.status === "error");
    if (done.length >= reports.length) { console.log(`  reports: ${(data ?? []).map((j: any) => `${j.report}=${j.status}${j.error ? `(${j.error})` : ""}`).join(", ")}`); return; }
  }
  console.log("  office agent did not finish in 4 min — using the newest snapshots available");
}

/**
 * Run the tax-parity checker over the SANDBOX Tally's own hand-typed vouchers.
 * They were entered by a person in Tally, so if the checker flags them the
 * checker is wrong. Recorded against TG-L09 as the instrument proof.
 */
async function sandboxInstrumentCheck(today: string): Promise<void> {
  if ((process.env.MKCP_TALLY_ROLE ?? "").trim().toLowerCase() !== "sandbox") return;
  const url = process.env.TALLY_URL || "http://localhost:9000";
  if (!/^https?:\/\/(localhost|127\.0\.0\.1):9000\/?$/i.test(url)) return;
  const company = process.env.TALLY_COMPANY || "";
  const { tallyPost, HEALTH_XML } = await import("../../src/tally.js");
  const { loadMasters } = await import("../../src/services/tallyMasters.js");
  const { buildCollection, blocksOf, dateBetween } = await import("../../src/services/tallyRequest.js");
  const health = String(await tallyPost(url, HEALTH_XML, 10_000, true).catch(() => ""));
  if (!/<STATUS>1<\/STATUS>/.test(health)) { console.log("  sandbox Tally not answering — instrument check skipped"); return; }
  const m: TallyMasters = await loadMasters(url, company);
  // The sandbox is an older copy; take its last fortnight up to today.
  const xml = buildCollection({ id: "MkGuardNative", type: "Voucher", company, filter: dateBetween(addDays(today, -14).replace(/-/g, ""), today.replace(/-/g, "")),
    fetch: ["Date", "VoucherNumber", "VoucherTypeName", "PartyLedgerName", "Narration", "IsCancelled", "PlaceOfSupply", "StateName", "PartyGSTIN", "IsInvoice",
      "AllLedgerEntries", "ALLLEDGERENTRIES.APPROPRIATEFOR", "AllInventoryEntries"] });
  const raw = String(await tallyPost(url, xml, 180_000, true));
  let n = 0;
  for (const b of blocksOf(raw, "VOUCHER").map((x) => `<VOUCHER ${x}`)) {
    const v = parseVoucher(b, "stored");
    if (!/^SALES$/i.test(v.type) || !v.stock.length || /^yes$/i.test(/<ISCANCELLED[^>]*>([^<]*)</.exec(b)?.[1] ?? "")) continue;
    if (/MKCP (GUARD|TEST)/.test(/<NARRATION[^>]*>([^<]*)</.exec(b)?.[1] ?? "")) continue; // ours are audited in --sandbox
    n++;
    checkTaxParity("TG-L09", v, m, `[sandbox-native] ${v.number} ${v.date}`);
  }
  console.log(`  instrument check: tax parity over ${n} hand-typed sandbox sales`);
  if (!n) unverified("TG-L09", "sandbox held no hand-typed sales in the last fortnight — instrument check not run");
}
