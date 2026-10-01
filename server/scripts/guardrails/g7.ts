/**
 * --g7 : pull-side request hygiene, offline. "A field you did not ask for is
 * indistinguishable from a field Tally lacks" (G7) — so every parser that reads
 * a field must sit behind a fetch list that NAMES it. Checked from the source
 * and the real request builders, never by asking Tally.
 *
 *   TG-L11  the GSTR audit's fetch list names every field its parser reads,
 *           incl. ALLLEDGERENTRIES.APPROPRIATEFOR
 *   TG-L14  the mirror's voucher fetch list names every header field
 *           convertVouchers reads (party_gstin / place_of_supply / consignee_*)
 *   TG-L02  every TDL formula is XML-escaped (a raw ">" in an AlterID filter
 *           returns ZERO rows with no error)
 *   TG-L04  the mirror sums ALLLEDGERENTRIES alone — never LEDGERENTRIES too
 *   TG-P20/P09  safePush's read-back names every field its diff reads — the
 *           read-back is how an Agst Ref→New Ref rewrite or a dropped ship-to
 *           is caught, and it is blind to a field it never asked for
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { check, unverified } from "./lib.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = (...p: string[]) => readFileSync(join(here, "..", "..", ...p), "utf8");
const U = (s: string) => s.trim().toUpperCase();

/**
 * Fields convertVouchers reads that no live probe has confirmed a Voucher
 * answers by that name. Adding an unprobed NATIVEMETHOD to the production
 * sync is not done blind; probe on the SANDBOX (probe-ewaybill-fields.ts is
 * the template) and then move the name into the fetch list.
 */
const UNPROBED = new Set(["SHIPTOPLACE", "DISPATCHFROMPLACE"]);

export async function runG7(): Promise<void> {
  // ── safePush read-back ─────────────────────────────────────────────────
  const { vouchersOnDateXml } = await import("../../src/services/safePush.js");
  const verifyXml = vouchersOnDateXml("X", "2026-09-23");
  const asked = new Set([...verifyXml.matchAll(/<NATIVEMETHOD>([^<]+)<\/NATIVEMETHOD>/g)].map((m) => U(m[1])));
  const sp = src("src", "services", "safePush.ts");
  // Header fields the diffs read: fld(header|mine|x, "TAG") and lines("TAG").
  const reads = new Set<string>([
    ...[...sp.matchAll(/fld\((?:header|mine|x), "([A-Z]+)"\)/g)].map((m) => m[1]),
    ...[...sp.matchAll(/lines\("([A-Z]+)"\)/g)].map((m) => m[1]),
  ]);
  // Entry-level reads arrive inside a named list.
  const viaList: Record<string, string> = { LEDGERNAME: "ALLLEDGERENTRIES", AMOUNT: "ALLLEDGERENTRIES", NAME: "ALLLEDGERENTRIES", BILLTYPE: "ALLLEDGERENTRIES", STOCKITEMNAME: "ALLINVENTORYENTRIES", GSTRATEDUTYHEAD: "ALLINVENTORYENTRIES", GSTRATE: "ALLINVENTORYENTRIES" };
  const missing = [...reads].filter((t) => !asked.has(t) && !(viaList[t] && asked.has(viaList[t])));
  check("TG-P09", reads.size >= 15 && missing.length === 0,
    `safePush's read-back diff reads ${missing.join(", ") || `only ${reads.size} fields (parser changed?)`} without naming ${missing.length ? "them" : "enough"} in its fetch list — the diff would read "absent" as "Tally did not store it"`);
  for (const t of ["ALLLEDGERENTRIES", "LEDGERENTRIES", "ALLINVENTORYENTRIES", "ISCANCELLED"]) {
    check("TG-P20", asked.has(t), `safePush's read-back does not name ${t} — a bill-type rewrite / a cancel cannot be seen`);
  }
  check("TG-L02", !/\*/.test(verifyXml.replace(/\$\$[A-Za-z]+:\$[A-Za-z]+ \* \d+/g, "")), `safePush's read-back carries a wildcard`);

  // ── Mirror: convertVouchers vs the vouchers fetch list ─────────────────
  const { TRANSACTION_COLLECTIONS } = await import("../../src/config/collections.js");
  const vdef = TRANSACTION_COLLECTIONS.find((c) => c.name === "vouchers");
  if (!vdef) { unverified("TG-L14", "no 'vouchers' collection in config/collections.ts"); }
  else {
    const fetched = new Set((vdef.fetch ?? []).map(U));
    const conv = src("src", "converters", "convert.ts");
    const headerReads = new Set([...conv.matchAll(/\bv\.([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1]));
    const notAsked = [...headerReads].filter((f) => !fetched.has(f) && !UNPROBED.has(f));
    check("TG-L14", notAsked.length === 0,
      `convertVouchers reads ${notAsked.join(", ")} but the vouchers fetch list never names ${notAsked.length > 1 ? "them" : "it"} — the mirror column is empty on every row and looks like Tally's answer`);
    for (const f of UNPROBED) if (headerReads.has(f) && !fetched.has(f)) {
      unverified("TG-L14", `convertVouchers reads ${f}, which is not fetched and has never been probed live — ship_to_place / dispatch_from_place are always empty. Probe it on the sandbox before adding it.`);
    }
    check("TG-L02", !(vdef.fetch ?? []).some((f) => f.includes("*")), `the vouchers fetch list carries a wildcard (crashes TallyPrime)`);
  }

  // ── GSTR audit: parser reads vs fetch list ─────────────────────────────
  const audit = src("scripts", "audit-gstr-exceptions.ts");
  const fetchBlock = /fetch:\s*\[([\s\S]*?)\]/.exec(audit)?.[1] ?? "";
  const auditFetch = new Set([...fetchBlock.matchAll(/"([A-Z.]+)"/g)].map((m) => m[1]));
  const blockReads = [...audit.matchAll(/tagOf\(block, "([A-Z]+)"\)/g)].map((m) => m[1]);
  const lost = blockReads.filter((t) => !auditFetch.has(t));
  check("TG-L11", blockReads.length >= 6 && lost.length === 0, `the GSTR audit reads ${lost.join(", ") || "too few fields"} without fetching ${lost.length ? "them" : "them by name"}`);
  check("TG-L11", auditFetch.has("ALLLEDGERENTRIES.APPROPRIATEFOR"),
    `the GSTR audit reads APPROPRIATEFOR but its fetch list does not name ALLLEDGERENTRIES.APPROPRIATEFOR — every adjustment line would read as unappropriated`);

  // ── Every TDL formula escaped ──────────────────────────────────────────
  const { alterIdAbove, buildCollection } = await import("../../src/services/tallyRequest.js");
  const alterReq = buildCollection({ id: "G7Alter", type: "Voucher", fetch: ["AlterID"], filter: alterIdAbove(1234) });
  const formula = /<SYSTEM TYPE="Formulae"[^>]*>([\s\S]*?)<\/SYSTEM>/.exec(alterReq)?.[1] ?? "";
  check("TG-L02", /&gt;/.test(formula) && !/[<>]/.test(formula), `the AlterID filter renders as "${formula}" — an unescaped ">" returns zero rows, no error`);
  const files = ["services/changeDetector.ts", "services/safePush.ts", "services/billSettlement.ts", "services/voucherNumbering.ts",
    "services/syncOrchestrator.ts", "services/localSession.ts", "services/tallyReports.ts", "services/statusRoutine.ts"];
  for (const f of files) {
    let text = ""; try { text = src("src", f); } catch { continue; }
    for (const m of text.matchAll(/TYPE="Formulae" NAME="[^"]*">([^\n]*?)<\/SYSTEM>/g)) {
      const body = m[1].replace(/\$\{[^}]*\}/g, "");
      check("TG-L02", !/[<>]/.test(body), `${f}: TDL formula "${m[1].slice(0, 80)}" carries a raw comparison character`);
    }
  }

  // ── The mirror sums ALLLEDGERENTRIES alone ────────────────────────────
  const { convertVouchers } = await import("../../src/converters/convert.js");
  const le = (n: string, a: number) => ({ LEDGERNAME: n, AMOUNT: String(a) });
  const parsed = { ENVELOPE: { BODY: { DATA: { COLLECTION: { VOUCHER: [{
    DATE: "20260923", VOUCHERTYPENAME: "Purchase", VOUCHERNUMBER: "G7/1", PARTYLEDGERNAME: "S",
    "LEDGERENTRIES.LIST": [le("S", 105), le("INPUT IGST", -5)],
    "ALLLEDGERENTRIES.LIST": [le("S", 105), le("INPUT IGST", -5), le("PURCHASE ( GST CENTRAL )", -100)],
  }] } } } } };
  const log = console.log; console.log = () => {};
  let out: any[] = [];
  try { out = convertVouchers(parsed).tallymessage; } finally { console.log = log; }
  const lines = (out[0]?.allledgerentries ?? []) as unknown[];
  const n = Array.isArray(lines) ? lines.length : -1;
  check("TG-L04", n === 3, `convertVouchers kept ${n} ledger lines from a voucher carrying 3 in ALLLEDGERENTRIES and 2 more in LEDGERENTRIES — summing both double-counts`);
}
