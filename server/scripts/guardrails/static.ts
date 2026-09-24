/**
 * --static : run the production builder and guard over fixture payloads and
 * assert every push guardrail on the XML. No Tally, no network (except the
 * optional replay of real queued payloads, below).
 *
 * Two kinds of assertion, both required by Engineering Guardrails 7.5:
 *   · the GOOD voucher is built correctly (shape checks in lib.ts), and
 *   · the BAD voucher is REFUSED by the guard. A rule the guard does not
 *     enforce is a FAIL here even when today's payloads happen to be right —
 *     "NOT ENFORCED" is the finding.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { XMLValidator } from "fast-xml-parser";
import { check, unverified, parseVoucher, checkVoucherShape, tag } from "./lib.js";
import {
  fixtureMasters, sale, purchase, receipt, stock, COMPANY, PARTY_LOCAL, PARTY_INTER, PARTY_UNREG, PARTY_LATE_REG, SUPPLIER,
  SALES_WB, DISCOUNT, fixtureOpenBills,
} from "./fixtures.js";
import type { VoucherPayload } from "../../src/types.js";
import type { TallyMasters } from "../../src/services/tallyMasters.js";

const here = dirname(fileURLToPath(import.meta.url));

export async function runStatic(opts: { replay: boolean }): Promise<void> {
  // The guard reads MKCP_FILED_THROUGH at import, so the caller sets it first.
  const { buildVoucherImportXml, pushVoucherToTally } = await import("../../src/services/voucherPusher.js");
  const { guardVoucher, FILED_THROUGH } = await import("../../src/services/pushGuard.js");
  const { diffStored } = await import("../../src/services/safePush.js");
  const m = fixtureMasters();

  const build = (p: VoucherPayload, masters: TallyMasters = m) => buildVoucherImportXml(COMPANY, p, masters);
  const guard = (p: VoucherPayload, masters: TallyMasters = m) => guardVoucher(p, masters, masters === m ? { openBills: fixtureOpenBills() } : {});
  // The "this company spells it SALES" warning is noise here; show the one about the rule.
  const relevant = (w: string[]) => w.find((x) => !/spells it/.test(x)) ?? undefined;
  const refused = (id: string, what: string, p: VoucherPayload, errorLike?: RegExp) => {
    const g = guard(p);
    const hit = !g.ok && (!errorLike || g.errors.some((e) => errorLike.test(e)));
    check(id, hit, `NOT ENFORCED — guard lets through: ${what}${g.ok && relevant(g.warnings) ? ` (only warns: "${relevant(g.warnings)!.slice(0, 110)}…")` : ""}`);
  };
  const accepted = (id: string, what: string, p: VoucherPayload) => {
    const g = guard(p);
    check(id, g.ok, `guard wrongly refuses ${what}: ${g.errors[0] ?? ""}`);
  };

  // Backdated fixtures test RATE and REGISTRATION dating, not filing: they
  // declare the amendment so the filed-period rule (TG-P05) stays out of it.
  const filedOk = (p: VoucherPayload): VoucherPayload => ({ ...p, allowFiledPeriodEdit: true });

  // ── Good vouchers: build and check the shape ──────────────────────────────
  const scenarios: { label: string; p: VoucherPayload; expectMailing?: string }[] = [
    { label: "cash walk-in (0719's lines)", expectMailing: "SUBHAS CYCLE", p: sale({
      number: "GUARD/S1", party: "Cash", placeOfSupply: "West Bengal", buyerName: "SUBHAS CYCLE", buyerAddress: ["JHALDAH", "PURULIA"],
      lines: [{ item: "BICYCLE BASKET EHD", amount: 21638.4, rate: 5 }, { item: "BRAKE SHOE  ( POWER )", amount: 7257.12, rate: 5 },
              { item: "CARRIER CLIP", amount: 4985.7, rate: 5 }, { item: "BABY TRICYCLE MUGHAL DLX RACER BB MSC AMPHA", amount: 10057.12, rate: 5 }] }) },
    { label: "registered local, 5% + own 18%, trade discount", expectMailing: "RANI CYCLE STORES", p: sale({
      number: "GUARD/S2", party: PARTY_LOCAL, discount: 119,
      lines: [{ item: "CARRIER CLIP", amount: 5949, rate: 5 }, { item: "HORN X", amount: 1200, rate: 18 }] }) },
    { label: "registered interstate (Odisha) IGST", expectMailing: "DIBYASAKTI CYCLE STORE", p: sale({
      number: "GUARD/S3", party: PARTY_INTER, inter: true, lines: [{ item: "BICYCLE BASKET EHD", amount: 10000, rate: 5 }] }) },
    { label: "unregistered party ledger", expectMailing: "TAPAS CYCLE", p: sale({
      number: "GUARD/S4", party: PARTY_UNREG, lines: [{ item: "CARRIER CLIP", amount: 999, rate: 5 }] }) },
    { label: "backdated across 22-Sep-2025 (12% then) to a party registered 01-Jun-2025", p: filedOk(sale({
      number: "GUARD/S5", date: "2025-09-01", party: PARTY_LATE_REG, lines: [{ item: "CARRIER CLIP", amount: 1000, rate: 12 }] })) },
    { label: "backdated to before that party's registration", p: filedOk(sale({
      number: "GUARD/S6", date: "2025-05-01", party: PARTY_LATE_REG, lines: [{ item: "CARRIER CLIP", amount: 1000, rate: 12 }] })) },
    { label: "names with & and inch mark", p: sale({
      number: "GUARD/S7", party: PARTY_LOCAL, lines: [{ item: "B.B. AXLE & CUP BHOGAL PT", amount: 500, rate: 5 }, { item: 'PLIER BOX JT. 10" ( 50 PCS )', amount: 300, rate: 5 }] }) },
    { label: "interstate purchase (Punjab)", p: purchase("GUARD/P1", [{ item: "CARRIER CLIP", amount: 20000, rate: 5 }, { item: "HORN X", amount: 1000, rate: 18 }]) },
    { label: "receipt on account", p: receipt("GUARD/R1", PARTY_LOCAL, 5000) },
  ];
  for (const s of scenarios) {
    const g = guard(s.p);
    check("TG-P22", g.ok, `good fixture "${s.label}" refused by the guard: ${g.errors.join(" | ")}`);
    let xml: string;
    try { xml = build(s.p); } catch (e) { check("TG-P25", false, `${s.label}: builder threw ${(e as Error).message}`); continue; }
    check("TG-P28", XMLValidator.validate(xml) === true, `${s.label}: generated XML is not well-formed`);
    check("TG-P31", tag(xml, "SVCURRENTCOMPANY") === COMPANY, `${s.label}: SVCURRENTCOMPANY is "${tag(xml, "SVCURRENTCOMPANY")}"`);
    const v = parseVoucher(/<VOUCHER\b[\s\S]*<\/VOUCHER>/.exec(xml)![0], "sent");
    check("TG-P01", !!v.remoteId, `${s.label}: built XML has no REMOTEID attribute`);
    check("TG-P03", !!v.number, `${s.label}: built XML has no VOUCHERNUMBER`);
    checkVoucherShape(v, { masters: m, expectMailing: s.expectMailing, label: `[static] ${s.label}:` });
  }

  // ── Identity ─────────────────────────────────────────────────────────────
  const base = () => sale({ number: "GUARD/X1", party: PARTY_LOCAL, lines: [{ item: "CARRIER CLIP", amount: 1000, rate: 5 }] });
  refused("TG-P01", "a Create with no remoteId", { ...base(), remoteId: undefined });
  refused("TG-P02", "an Alter with no remoteId", { ...base(), remoteId: undefined, action: "Alter" }, /remoteId/i);
  refused("TG-P02", "a Cancel with no remoteId", { ...base(), remoteId: undefined, action: "Cancel" }, /remoteId/i);
  refused("TG-P02", "a Delete with no remoteId", { ...base(), remoteId: undefined, action: "Delete" }, /remoteId/i);
  refused("TG-P03", "a Sales Create with no voucher number (Tally answers exceptions=1)", { ...base(), voucherNumber: undefined });

  const cancelXml = build({ ...base(), action: "Cancel" });
  check("TG-P04", /ACTION="Cancel"/.test(cancelXml) && !/ISCANCELLED/i.test(cancelXml), `a Cancel is not built as ACTION="Cancel" without ISCANCELLED`);

  // ── Filed period ─────────────────────────────────────────────────────────
  if (!FILED_THROUGH) unverified("TG-P05", "MKCP_FILED_THROUGH unset in this process");
  else {
    const filedDay = FILED_THROUGH; // on the boundary itself
    refused("TG-P05", `an Alter dated ${filedDay} (filed period)`, { ...base(), date: filedDay, action: "Alter" }, /filed/i);
    refused("TG-P05", `a Cancel dated ${filedDay} (filed period)`, { ...base(), date: filedDay, action: "Cancel" }, /filed/i);
    refused("TG-P05", `a NEW invoice backdated to ${filedDay}, inside an already-filed GST period`, { ...base(), date: filedDay }, /filed/i);
  }

  // ── State, place of supply, tax head ─────────────────────────────────────
  const localIgst = sale({ number: "GUARD/X2", party: PARTY_LOCAL, inter: true, lines: [{ item: "CARRIER CLIP", amount: 1000, rate: 5 }] });
  refused("TG-P11", "a West Bengal party billed IGST on the CENTRAL account", localIgst, /local/i);
  const interLocal = sale({ number: "GUARD/X3", party: PARTY_INTER, lines: [{ item: "CARRIER CLIP", amount: 1000, rate: 5 }] });
  refused("TG-P11", "an Odisha party billed CGST+SGST on the W.B. account", interLocal, /interstate/i);
  refused("TG-P12", "a cash sale with no place of supply", sale({ number: "GUARD/X4", party: "Cash", lines: [{ item: "CARRIER CLIP", amount: 100, rate: 5 }] }));
  refused("TG-P12", "a cash sale declaring a misspelt state (\"West Bangal\")", sale({ number: "GUARD/X5", party: "Cash", placeOfSupply: "West Bangal", lines: [{ item: "CARRIER CLIP", amount: 100, rate: 5 }] }), /spelling|not a state/i);
  refused("TG-P12", "a placeOfSupply on a purchase", { ...purchase("GUARD/X6", [{ item: "CARRIER CLIP", amount: 100, rate: 5 }]), placeOfSupply: "Punjab" }, /not accepted/i);
  refused("TG-P10", "a placeOfSupply contradicting the party ledger's state", { ...base(), placeOfSupply: "Odisha" }, /contradicts/i);

  // ── Line GST ─────────────────────────────────────────────────────────────
  refused("TG-P13", "a stock line whose item has no rate anywhere in its chain (EV GOODS) — Tally files it \"Tax rate/tax type not specified\"",
    sale({ number: "GUARD/X7", party: PARTY_LOCAL, lines: [{ item: "EV THING", amount: 1000, rate: 5 }] }));
  const wrongTax = sale({ number: "GUARD/X8", party: PARTY_LOCAL, lines: [{ item: "CARRIER CLIP", amount: 1000, rate: 12 }] }); // 12% on a 5% item, balanced
  refused("TG-P15", "tax booked at 12% on an item whose dated rate is 5% (voucher balanced)", wrongTax);
  const halfTax = sale({ number: "GUARD/X9", party: PARTY_LOCAL, lines: [{ item: "CARRIER CLIP", amount: 1000, rate: 5 }] });
  const sg = halfTax.ledgerEntries.find((e) => e.ledgerName === "OUTPUT SGST")!; const party = halfTax.ledgerEntries[0];
  party.amount = +(party.amount - sg.amount).toFixed(2); halfTax.ledgerEntries = halfTax.ledgerEntries.filter((e) => e !== sg);
  refused("TG-P15", "a local sale carrying CGST with no SGST (balanced)", halfTax);
  const noTax = sale({ number: "GUARD/X10", party: PARTY_LOCAL, lines: [{ item: "CARRIER CLIP", amount: 1000, rate: 0 }] });
  refused("TG-P15", "a registered taxable sale with no tax line at all", noTax);

  // TG-P14 — the resolver itself, dated
  const { gstRateFor } = await import("../../src/services/tallyMasters.js");
  check("TG-P14", gstRateFor(m, "CARRIER CLIP", "2025-09-21").rate === 12, `rate on 21-Sep-2025 should be the 2022 revision, 12%`);
  check("TG-P14", gstRateFor(m, "CARRIER CLIP", "2025-09-22").rate === 5, `rate on 22-Sep-2025 should be 5%`);
  check("TG-P14", gstRateFor(m, "CARRIER CLIP", "2026-09-23").source === `stock group "BICYCLE PARTS ( 87149990 )"`, `a 0% item placeholder must not win over its group`);
  check("TG-P14", gstRateFor(m, "HORN X", "2026-09-23").rate === 18, `an item's own 18% must win over its 5% group`);

  // ── Round-off ────────────────────────────────────────────────────────────
  const bigRound = sale({ number: "GUARD/X11", party: PARTY_LOCAL, lines: [{ item: "CARRIER CLIP", amount: 1000, rate: 5 }] });
  const ro = bigRound.ledgerEntries.find((e) => e.ledgerName === "ROUNDED OFF");
  bigRound.ledgerEntries[0].amount += 3; bigRound.ledgerEntries = bigRound.ledgerEntries.filter((e) => e !== ro);
  bigRound.ledgerEntries.push({ ledgerName: "ROUNDED OFF", amount: 3, isDeemedPositive: false, isPartyLedger: false, signedAmount: 3 });
  refused("TG-P17", "a ROUNDED OFF of ₹3.00", bigRound);
  const drRound = sale({ number: "GUARD/X12", party: PARTY_LOCAL, lines: [{ item: "CARRIER CLIP", amount: 1000.3, rate: 5 }] });
  const r = drRound.ledgerEntries.find((e) => e.ledgerName === "ROUNDED OFF");
  // The old export-builder bug: side flipped by the sign (isDeemedPositive: roundOff < 0), same arithmetic.
  if (r) r.isDeemedPositive = true;
  if (r) refused("TG-P17", "a sales ROUNDED OFF moved to the debit side", drRound);

  // ── Adjustments / discount ───────────────────────────────────────────────
  const unapp = sale({ number: "GUARD/X13", party: PARTY_LOCAL, discount: 50, lines: [{ item: "CARRIER CLIP", amount: 1000, rate: 5 }] });
  delete unapp.ledgerEntries.find((e) => e.ledgerName === DISCOUNT)!.appropriateToGst;
  refused("TG-P18", "a TRADE DISCOUNTS line without appropriateToGst", unapp, /appropriate/i);
  const discXml = build(sale({ number: "GUARD/X14", party: PARTY_LOCAL, discount: 119, lines: [{ item: "CARRIER CLIP", amount: 5949, rate: 5 }] }));
  const discBlock = /<LEDGERENTRIES\.LIST>(?:(?!<\/LEDGERENTRIES\.LIST>)[\s\S])*TRADE DISCOUNTS[\s\S]*?<\/LEDGERENTRIES\.LIST>/.exec(discXml)?.[0] ?? "";
  check("TG-P19", /<ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE>/.test(discBlock) && /<AMOUNT>-119\.00<\/AMOUNT>/.test(discBlock),
    `discount not emitted as the native negative credit (ISDEEMEDPOSITIVE=No, AMOUNT=-119.00)`);
  check("TG-P18", /<APPROPRIATEFOR>GST<\/APPROPRIATEFOR>/.test(discBlock) && /<GSTAPPROPRIATETO>Goods<\/GSTAPPROPRIATETO>/.test(discBlock),
    `discount line built without APPROPRIATEFOR=GST / GSTAPPROPRIATETO=Goods`);

  // ── Bills ────────────────────────────────────────────────────────────────
  refused("TG-P20", "an Agst Ref naming a bill that is not open for this party (Tally rewrites it to New Ref)",
    receipt("GUARD/X15", PARTY_LOCAL, 1000, "Agst Ref", "TI/26-27/34"));
  const agst = receipt("GUARD/X16", PARTY_LOCAL, 1000, "Agst Ref", "26-27/0460");
  const storedAsNewRef = `<VOUCHER><ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><AMOUNT>-1000.00</AMOUNT></ALLLEDGERENTRIES.LIST>` +
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${PARTY_LOCAL}</LEDGERNAME><AMOUNT>1000.00</AMOUNT><BILLALLOCATIONS.LIST><NAME>26-27/0460</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>1000.00</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST></VOUCHER>`;
  check("TG-P20", diffStored(agst, storedAsNewRef).some((d) => /Agst Ref.*New Ref/.test(d)), `safePush's read-back diff does not catch an Agst Ref stored as New Ref`);
  const badAlloc = receipt("GUARD/X17", PARTY_LOCAL, 1000);
  badAlloc.ledgerEntries[1].billAllocations![0].amount = 900;
  refused("TG-P21", "bill allocations totalling ₹900 on a ₹1,000 line", badAlloc, /must match/i);

  // ── Names, units, structure, balance ─────────────────────────────────────
  const twoSpaces = purchase("GUARD/X18", [{ item: "CARRIER CLIP", amount: 100, rate: 5 }]);
  twoSpaces.inventoryEntries![0].salesLedgerName = "PURCHASE  ( GST CENTRAL )";
  refused("TG-P22", "\"PURCHASE  ( GST CENTRAL )\" with two spaces (Tally drops the allocation silently)", twoSpaces, /spells it/i);
  refused("TG-P22", "an unknown godown", { ...base(), inventoryEntries: [{ ...stock("CARRIER CLIP", 1000), godownName: "Godown 2" }] }, /Godown/i);
  refused("TG-P23", "unit \"PCS\" on a PC item", { ...base(), inventoryEntries: [{ ...stock("CARRIER CLIP", 1000), unit: "PCS" }] }, /base unit/i);
  const dbl = base(); dbl.ledgerEntries.push({ ledgerName: SALES_WB, amount: 1000, isDeemedPositive: false, isPartyLedger: false });
  refused("TG-P24", "the sales ledger as its own entry AND in the allocation", dbl, /counted twice/i);
  const unbal = base(); unbal.ledgerEntries[0].amount += 10;
  refused("TG-P25", "an unbalanced voucher", unbal, /balance/i);

  // ── Masters required ─────────────────────────────────────────────────────
  let threw = false;
  try { await pushVoucherToTally("http://127.0.0.1:1", COMPANY, base(), undefined as unknown as TallyMasters); } catch (e) { threw = /masters/i.test((e as Error).message); }
  check("TG-P26", threw, `pushVoucherToTally without masters did not throw before touching Tally`);
  const bare = build(base(), undefined as unknown as TallyMasters);
  check("TG-P26", /GSTREGISTRATIONTYPE/.test(bare),
    `buildVoucherImportXml without masters still returns an invoice with NO GST identity block (optional parameter whose absence removes a whole block — Engineering Guardrails 1.2)`);

  // ── Voucher types ────────────────────────────────────────────────────────
  refused("TG-P29", "a Delivery Note (not configured in this company)", { ...base(), voucherType: "Delivery Note" }, /not configured/i);
  refused("TG-P29", "a Credit Note (owner 10-Sep: never automated, always keyed by hand)", { ...base(), voucherType: "Credit Note" });
  refused("TG-P29", "a Debit Note (owner 10-Sep: never automated)", { ...purchase("GUARD/X19", [{ item: "CARRIER CLIP", amount: 100, rate: 5 }]), voucherType: "Debit Note" });

  // ── Role separation ──────────────────────────────────────────────────────
  const { supabaseClient } = await import("../../src/services/supabaseClient.js");
  const prevRole = process.env.MKCP_TALLY_ROLE;
  process.env.MKCP_TALLY_ROLE = "sandbox";
  check("TG-P30", supabaseClient() === null, `a sandbox machine still gets a Supabase client`);
  process.env.MKCP_TALLY_ROLE = prevRole;
  const { assertSandboxTarget } = await import("./sandbox.js");
  let refusedPrimary = false;
  try { assertSandboxTarget({ MKCP_TALLY_ROLE: "primary", TALLY_URL: "http://localhost:9000" }); } catch { refusedPrimary = true; }
  check("TG-P30", refusedPrimary, `the guardrail round-trip would run on a primary (office) machine`);
  let refusedRemote = false;
  try { assertSandboxTarget({ MKCP_TALLY_ROLE: "sandbox", TALLY_URL: "http://192.168.1.20:9000" }); } catch { refusedRemote = true; }
  check("TG-P30", refusedRemote, `the guardrail round-trip would push to a non-localhost Tally`);

  // ── Second sources of rates ──────────────────────────────────────────────
  const agentSrc = ["voucherPusher.ts", "pushGuard.ts", "safePush.ts"].map((f) => readFileSync(join(here, "..", "..", "src", "services", f), "utf8")).join("\n");
  check("TG-P32", !/gstMasterRates|gstMasterHsn/.test(agentSrc), `the agent push path reads a checked-in rate file`);
  const { webDir: findWebDir } = await import("./lib.js");
  const webDir = findWebDir();
  const webCash = join(webDir, "src", "engine", "cashInvoice.ts");
  if (existsSync(webCash)) {
    const src = readFileSync(webCash, "utf8");
    check("TG-P32", !/lookupMasterGstRate|gstMasterRates/.test(src),
      `web engine/cashInvoice.ts (file-export path) decides each line's GST source from lookupMasterGstRate → src/data/gstMasterRates.json, a checked-in copy`);
    const gm = join(webDir, "src", "engine", "gstMaster.ts");
    if (existsSync(gm)) check("TG-P32", !/gstMasterRates\.json/.test(readFileSync(gm, "utf8")),
      `web engine/gstMaster.ts falls back to the static src/data/gstMasterRates.json`);
  } else unverified("TG-P32", `web app not found at ${webDir} (set MKCP_WEB_DIR)`);

  // ── Real queued payloads, through today's builder, with the MIRROR's masters ─
  if (opts.replay) await replayQueued(build, guard);
}

/**
 * Replay the last N real push_queue payloads through today's builder, using a
 * TallyMasters rebuilt from the mirror. READ-ONLY: two SELECTs.
 *
 * The mirror's ledgers carry no dated registration blocks, so registration type
 * falls back to the flat GSTIN — which is exactly what production does for a
 * ledger with no LEDGSTREGDETAILS, e.g. the shared Cash ledger.
 */
async function replayQueued(build: (p: VoucherPayload, m: TallyMasters) => string, guard: (p: VoucherPayload, m: TallyMasters) => { ok: boolean; errors: string[] }): Promise<void> {
  const { mirrorClient, mastersFromMirror } = await import("./mirror.js");
  const sb = mirrorClient();
  if (!sb) { unverified("TG-P13", "replay skipped: no Supabase read credentials"); return; }
  const m = await mastersFromMirror(sb);
  const { data, error } = await sb.from("push_queue").select("id,payload,status,created_at").order("created_at", { ascending: false }).limit(40);
  if (error || !data) { unverified("TG-P13", `replay skipped: ${error?.message}`); return; }
  let n = 0;
  for (const row of data) {
    const p = row.payload as VoucherPayload;
    if (!p?.inventoryEntries?.length || !/^(sales|sales order note)$/i.test(p.voucherType)) continue;
    n++;
    const label = `[replay ${String(row.created_at).slice(0, 10)} ${p.voucherType} ${p.voucherNumber}]`;
    const g = guard(p, m);
    if (!g.ok) { check("TG-P22", false, `${label} today's guard refuses a payload that was queued: ${g.errors[0]}`); continue; }
    let xml: string;
    try { xml = build(p, m); } catch (e) { check("TG-P25", false, `${label} builder threw ${(e as Error).message}`); continue; }
    const v = parseVoucher(/<VOUCHER\b[\s\S]*<\/VOUCHER>/.exec(xml)![0], "sent");
    checkVoucherShape(v, { masters: m, expectMailing: p.buyerName?.trim() || undefined, label });
    if (n >= 12) break;
  }
  if (!n) unverified("TG-P13", "replay found no queued sales payloads");
}
