/**
 * Is GST appropriation observable from a read? The GSTR audit says no.
 *
 * `gstrExceptions.ts` declines to check the one exception class that hits 63%
 * of invoices — an adjustment line (TRADE DISCOUNTS / H.C.) that does not
 * appropriate to GST, which makes Tally compute expected tax on the gross and
 * file the voucher under "Mismatch between Expected and Modified Tax Amount".
 * Its reason: the appropriation is "not observable from a voucher read", having
 * been inferred once from VATASSESSABLEVALUE and produced 431 false positives.
 *
 * That note also says where the property really lives — "a property of the
 * LEDGER MASTER (`appropriatefor: "GST"`)" — and then never reads the ledger
 * master. And `voucherPusher.ts:290` EMITS <APPROPRIATEFOR> per line, so the
 * tag exists in Tally's vocabulary; the audit's fetch list simply never asks
 * for it.
 *
 * So two questions, both read-only:
 *   A. Does the Ledger master carry an appropriation field we can read?
 *   B. Does a voucher's ALLLEDGERENTRIES block carry it when asked directly?
 *
 * Either answer closes the hole: A lets the audit check every adjustment ledger
 * once; B lets it check per line. Both "no" confirms the existing note.
 *
 *   npx tsx server/scripts/probe-gst-appropriation.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });

import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { esc, blocksOf, tagOf } from "../src/services/tallyRequest.js";

const TALLY = process.env.TALLY_URL || "http://localhost:9000";

/* Hand-built rather than via buildCollection: that helper refuses a "*" fetch,
   correctly, because a `.*` in a fetch list crashes Tally. A bare "*" is the
   documented wildcard and is a different thing — explore-fields.ts uses it. */
function wildcardXml(company: string, type: string): string {
  return `<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>ApprProbe</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="ApprProbe" ISMODIFY="No"><TYPE>${esc(type)}</TYPE>
<NATIVEMETHOD>*</NATIVEMETHOD></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

async function healthy(): Promise<boolean> {
  try { return convertCompanies(await tallyPost(TALLY, HEALTH_XML, 8_000)).length > 0; }
  catch { return false; }
}

(async () => {
  const company = convertCompanies(await tallyPost(TALLY, HEALTH_XML, 10_000))[0]!.name;
  console.log(`\n  GST APPROPRIATION — IS IT READABLE?\n  company "${company}"\n  ${"─".repeat(64)}`);

  /* ── A. the ledger master ─────────────────────────────────────────────── */
  console.log("\n  A. Ledger master fields");
  const ledRaw = await tallyPost(TALLY, wildcardXml(company, "Ledger"), 120_000, true) as string;
  console.log(`     ${Math.round(ledRaw.length / 1024)} KB over ${blocksOf(ledRaw, "LEDGER").length} ledgers`);

  const adj = blocksOf(ledRaw, "LEDGER").filter((b) =>
    /DISCOUNT|H\.C\.|ROUND|CARRIAGE|HANDLING|FREIGHT/i.test(b.slice(0, 300)));
  console.log(`     ${adj.length} look like adjustment ledgers`);

  const apprTags = new Set<string>();
  for (const b of blocksOf(ledRaw, "LEDGER")) {
    for (const m of b.matchAll(/<([A-Z0-9._]*APPROPRIAT[A-Z0-9._]*)[ >]/gi)) apprTags.add(m[1].toUpperCase());
  }
  console.log(`     appropriation-shaped tags present: ${apprTags.size ? [...apprTags].join(", ") : "NONE"}`);

  for (const b of adj.slice(0, 6)) {
    const name = (tagOf(b, "NAME") ?? tagOf(b, "LANGUAGENAME") ?? "?").trim();
    const vals = [...apprTags].map((t) => `${t}=${(tagOf(b, t) ?? "").trim() || "∅"}`).join("  ");
    console.log(`       · ${name.slice(0, 34).padEnd(34)} ${vals || "(no appropriation tag)"}`);
  }

  if (!await healthy()) { console.log("\n  ⚠ Tally stopped after the ledger probe."); process.exit(1); }

  /* ── B. the voucher line ──────────────────────────────────────────────── */
  console.log("\n  B. Voucher ledger-entry fields");
  const vchXml = `<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>ApprVch</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="ApprVch" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>DATE</NATIVEMETHOD><NATIVEMETHOD>VOUCHERNUMBER</NATIVEMETHOD>
<NATIVEMETHOD>VOUCHERTYPENAME</NATIVEMETHOD>
<NATIVEMETHOD>ALLLEDGERENTRIES.LIST</NATIVEMETHOD>
<NATIVEMETHOD>ALLLEDGERENTRIES.APPROPRIATEFOR</NATIVEMETHOD>
<NATIVEMETHOD>ALLLEDGERENTRIES.GSTAPPROPRIATETO</NATIVEMETHOD>
<FILTER>ApprVchF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="ApprVchF">($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) &gt;= 20260401 AND ($$YearOfDate:$Date * 10000 + $$MonthOfDate:$Date * 100 + $$DayOfDate:$Date) &lt;= 20260430</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const vRaw = await tallyPost(TALLY, vchXml, 300_000, true) as string;
  const vouchers = blocksOf(vRaw, "VOUCHER");
  console.log(`     ${Math.round(vRaw.length / 1024)} KB over ${vouchers.length} April vouchers`);

  const withDisc = vouchers.filter((v) => /TRADE DISCOUNT/i.test(v));
  console.log(`     ${withDisc.length} carry a TRADE DISCOUNTS line`);

  const lineTags = new Set<string>();
  for (const v of withDisc.slice(0, 40)) {
    for (const e of blocksOf(v, "ALLLEDGERENTRIES.LIST")) {
      if (!/TRADE DISCOUNT/i.test(e)) continue;
      for (const m of e.matchAll(/<([A-Z0-9._]+)[ >]/gi)) lineTags.add(m[1].toUpperCase());
    }
  }
  const apprOnLine = [...lineTags].filter((t) => /APPROPRIAT|ASSESSABLE|GST/i.test(t));
  console.log(`     tags on a TRADE DISCOUNTS line: ${lineTags.size}`);
  console.log(`     of those, GST/appropriation-shaped: ${apprOnLine.length ? apprOnLine.join(", ") : "NONE"}`);

  if (withDisc[0]) {
    const e = blocksOf(withDisc[0], "ALLLEDGERENTRIES.LIST").find((x) => /TRADE DISCOUNT/i.test(x));
    if (e) {
      console.log(`\n     one real line, in full:`);
      for (const line of e.trim().split("\n").slice(0, 24)) console.log(`       ${line.trim()}`);
    }
  }

  writeFileSync(join(here, "..", "data", "appropriation-probe.json"), JSON.stringify({
    company, ledgerApprTags: [...apprTags], adjustmentLedgers: adj.length,
    vouchersApril: vouchers.length, withDiscountLine: withDisc.length,
    lineTags: [...lineTags].sort(), apprOnLine,
  }, null, 2));

  console.log(`\n  healthy after: ${await healthy()}\n`);
})();
