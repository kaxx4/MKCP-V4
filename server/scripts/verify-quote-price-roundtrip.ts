/**
 * Does the rate the pricing precedence resolves survive a trip to Tally?
 *
 * ── The question ──────────────────────────────────────────────────────────
 *
 * On 19-Sep-2026 the quote screen's pricing was changed to
 *
 *     booked  →  live Tally price list  →  sales history  →  nothing
 *
 * removing a fallback to `closingRate` / `openingRate`, which are stock
 * VALUATION — cost, not a selling price. Unit tests cover the decision. They
 * say nothing about whether the resolved figure reaches the books intact, and
 * on this project "the suite is green" has been wrong seven times.
 *
 * So: take the rate off Tally's own price list, run it through the REAL web-app
 * builders, push it to Tally, read it back, and compare.
 *
 * ── Why the payload is built by another repo ──────────────────────────────
 *
 * The Sales Quote page pushes by enqueueing to the SHARED Supabase
 * `push_queue`, drained by the office machine. Pressing "Push order" in a
 * browser here would book a test voucher into the real company through someone
 * else's machine. So this harness shells out to
 * `MKCP MOB2/web-dashboard/scripts/build-quote-payload.ts`, which calls
 * `makeLine` and `salesOrderToPayload` — the same two functions in the same
 * order as the page — and sends the result to LOCAL Tally directly.
 *
 * PROVEN here: makeLine → salesOrderToPayload → pushGuard → Tally → read-back.
 * NOT PROVEN (P7): the Supabase queue hop and the agent's claim/lease, covered
 * by the agent's own harnesses and by the office machine running it daily.
 *
 * ── Safety ────────────────────────────────────────────────────────────────
 *
 * Marked number range, REMOTEID set from creation so it can be removed (G5 —
 * 13 vouchers are stranded forever for want of one), one voucher, deleted at
 * the end, and the cleanup SWEEPS the books rather than trusting the push
 * result: `safePush` returning ok:false does not mean nothing was created.
 *
 *   npx tsx server/scripts/verify-quote-price-roundtrip.ts          (dry)
 *   npx tsx server/scripts/verify-quote-price-roundtrip.ts --push   (writes + deletes)
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { config } from "dotenv";
const HERE = dirname(fileURLToPath(import.meta.url));
config({ path: join(HERE, "..", ".env") });

import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters } from "../src/services/tallyMasters.js";
import { fetchPriceList, latestRates } from "../src/services/tallyPriceList.js";
import { guardVoucher } from "../src/services/pushGuard.js";
import { safePush } from "../src/services/safePush.js";
import { esc, blocksOf, tagOf } from "../src/services/tallyRequest.js";
import type { VoucherPayload } from "../src/types.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const PUSH = process.argv.includes("--push");
const TODAY = new Date().toISOString().slice(0, 10);
const TAG = `MKCP-QP${Date.now().toString().slice(-5)}`;
const WEB = join(HERE, "..", "..", "..", "MKCP MOB2", "web-dashboard");

/** Decode Tally's entities, then case-fold — the price list and the item master
 *  escape the same name differently, and `&QUOT;`/`&APOS;` come back in CAPS. */
const key = (s: string) =>
  s.replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
   .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
   .replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim().toUpperCase();

/** Read the voucher back and return the RATE Tally stored on its stock line. */
async function readBack(company: string, number: string) {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>QPCheck</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="QPCheck" ISMODIFY="No"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>VOUCHERNUMBER</NATIVEMETHOD><NATIVEMETHOD>VOUCHERTYPENAME</NATIVEMETHOD>
<NATIVEMETHOD>PARTYLEDGERNAME</NATIVEMETHOD>
<NATIVEMETHOD>ALLINVENTORYENTRIES.LIST</NATIVEMETHOD>
<NATIVEMETHOD>ALLLEDGERENTRIES.LIST</NATIVEMETHOD>
<FILTER>QPCheckF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="QPCheckF">$$IsEqual:$VoucherNumber:"${esc(number)}"</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw = await tallyPost(U, xml, 120_000, true) as string;
  const vs = blocksOf(raw, "VOUCHER").filter((v) => (tagOf(v, "VOUCHERTYPENAME") ?? "").trim());
  if (!vs.length) return null;
  const v = vs[0];
  const inv = blocksOf(v, "ALLINVENTORYENTRIES.LIST")[0] ?? "";
  // `<RATE>` comes back as "43.34/ST" — the unit rides along with the number.
  const rateRaw = (tagOf(inv, "RATE") ?? "").trim();
  return {
    type: (tagOf(v, "VOUCHERTYPENAME") ?? "").trim(),
    party: (tagOf(v, "PARTYLEDGERNAME") ?? "").trim(),
    item: (tagOf(inv, "STOCKITEMNAME") ?? "").trim(),
    rateRaw,
    rate: parseFloat(rateRaw.replace(/[^0-9.\-]/g, "")),
    qty: (tagOf(inv, "ACTUALQTY") ?? tagOf(inv, "BILLEDQTY") ?? "").trim(),
    amount: parseFloat((tagOf(inv, "AMOUNT") ?? "0").replace(/[^0-9.\-]/g, "")),
  };
}

async function del(company: string, remoteId: string, type: string, number: string) {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC>
<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER REMOTEID="${esc(remoteId)}" VCHTYPE="${esc(type)}" ACTION="Delete">
<DATE>${TODAY.replace(/-/g, "")}</DATE><VOUCHERTYPENAME>${esc(type)}</VOUCHERTYPENAME>
<VOUCHERNUMBER>${esc(number)}</VOUCHERNUMBER></VOUCHER>
</TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
  const res = await tallyPost(U, xml, 120_000, true) as string;
  return /<DELETED>(\d+)<\/DELETED>/.exec(res)?.[1] ?? "0";
}

(async () => {
  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  console.log(`\n  QUOTE PRICE → TALLY → BACK\n  ${company}`);
  console.log(`  role=${process.env.MKCP_TALLY_ROLE ?? "primary"}\n  ${"─".repeat(68)}`);

  const [m, entries] = await Promise.all([loadMasters(U, company), fetchPriceList(U, company)]);
  const listed = latestRates(entries);
  const byName = new Map<string, number>();
  for (const e of listed.values()) if (e.rate > 0) byName.set(key(e.itemName), e.rate);

  /* An item the LIST prices, that has stock, and whose valuation differs from
     its list rate — so "Tally stored the list rate" cannot be satisfied by a
     cost figure that happens to be equal. */
  const item = [...m.items.values()].find((i) => {
    const lr = byName.get(key(i.name));
    return !!lr && i.closingStock > 20 && i.closingRate > 0
      && Math.abs(lr - i.closingRate) / lr > 0.05;
  });
  const party = [...m.ledgers.values()]
    .find((l) => /SUNDRY DEBTORS/i.test(l.parent) && /WEST BENGAL/i.test(l.state ?? "") && l.gstin);
  if (!item || !party) { console.log("  no usable item/party — stopping."); return; }

  const listRate = byName.get(key(item.name))!;
  console.log(`  party      ${party.name}  [${party.state}]`);
  console.log(`  item       ${item.name}`);
  console.log(`  LIST rate  ₹${listRate}      ← what the precedence must resolve`);
  /* `MasterItem` carries closingRate and NOT openingRate — reading the latter
     gave `undefined`, and `Math.abs(x - undefined) > 0.005` is `NaN > 0.005`,
     i.e. false, so the assertion below reported "A COST FIGURE REACHED THE
     BOOKS" on a run where the stored rate was the list rate and nothing was
     wrong. An assertion that fails for a reason unrelated to its subject is
     worse than none: it trains you to discount the one time it is right. */
  console.log(`  valuation  ₹${item.closingRate} closing   ← must NOT appear\n`);

  const number = `${TAG}-1`;
  const inPath = join(tmpdir(), `qp-in-${TAG}.json`);
  const outPath = join(tmpdir(), `qp-out-${TAG}.json`);
  writeFileSync(inPath, JSON.stringify({
    company, voucherNumber: number, date: TODAY, pkgs: 1, listRate,
    item: {
      itemId: item.name, name: item.name, baseUnit: item.baseUnit,
      unitsPerPkg: 1, group: item.parent ?? "", hsn: "",
      closingRate: item.closingRate, openingRate: 0,
    },
    party: {
      name: party.name, state: party.state ?? "", gstin: party.gstin ?? "",
      /* The two repos disagree on this field's SHAPE: `loadMasters` here types
         it `string[]` (Tally returns one <ADDRESS> per line), while the web
         app's `CanonicalLedger.address` is a single string, because that is
         what the Supabase mirror stores. Joining is what makes this harness
         feed the builder what it really receives in production — passing the
         array straight through made `addressLines` throw on `addr.split`.
         Worth knowing about: it is a live seam between the repos, not a
         harness quirk. */
      address: (Array.isArray(party.address) ? party.address.join(String.fromCharCode(10)) : party.address) ?? "",
    },
  }));

  console.log(`  ── building the payload with the WEB APP's own functions`);
  execFileSync("npx", ["tsx", "scripts/build-quote-payload.ts", inPath, outPath],
    { cwd: WEB, stdio: "inherit", shell: process.platform === "win32" });

  const built = JSON.parse(readFileSync(outPath, "utf8")) as {
    payload: VoucherPayload; line: { rate: number; autoRate: number; gstRate: number };
  };
  const payload = { ...built.payload, remoteId: `MKCP|QuotePrice|${number}|2026-27` };

  /* Assertion 1, before anything is sent: the BUILDER resolved the list rate,
     and neither valuation figure reached the line. */
  const builtOk = Math.abs(built.line.rate - listRate) < 0.005;
  console.log(`\n  ① builder resolved ₹${built.line.rate} vs list ₹${listRate} → ${builtOk ? "MATCH" : "MISMATCH"}`);
  if (!builtOk) { console.log("  builder did not resolve the list rate — stopping before any write."); return; }

  const g = guardVoucher(payload, m);
  console.log(`  ② guard: ${g.errors.length} error(s), ${g.warnings.length} warning(s)`);
  for (const e of g.errors.slice(0, 4)) console.log(`       ERROR ${e.slice(0, 140)}`);
  for (const w of g.warnings.slice(0, 3)) console.log(`       warn  ${w.slice(0, 140)}`);

  if (!PUSH) { console.log(`\n  dry run — pass --push to write.\n`); rmSync(inPath); rmSync(outPath); return; }
  if (g.errors.length) { console.log(`\n  refused by the guard; nothing sent.\n`); rmSync(inPath); rmSync(outPath); return; }

  let ok = false;
  try { ok = (await safePush(U, company, payload)).ok; }
  catch (e) { console.log(`  safePush threw: ${(e as Error).message.slice(0, 120)}`); }
  console.log(`  ③ safePush ok=${ok}`);

  const back = await readBack(company, number);
  if (!back) { console.log(`  ④ nothing in the books — nothing to clean up.\n`); rmSync(inPath); rmSync(outPath); return; }

  console.log(`  ④ Tally stored: ${back.type} · ${back.item} · qty ${back.qty} · RATE ${back.rateRaw} · amount ₹${back.amount}`);
  const stored = Math.abs(back.rate - listRate) < 0.005;
  /* Compare only against valuation figures that EXIST. `openingRate` is
     undefined on most items here, and `Math.abs(x - undefined) > 0.005` is
     `NaN > 0.005`, which is false — so this assertion reported "A COST FIGURE
     REACHED THE BOOKS" on a run where the stored rate was the list rate and
     nothing was wrong. An assertion that fails for a reason unrelated to its
     subject is worse than no assertion: it trains you to discount the one time
     it is right. Same family as the harness lying more than the app. */
  const valuations = [item.closingRate]
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
  const notCost = valuations.every((v) => Math.abs(back.rate - v) > 0.005);
  console.log(`     (compared against ${valuations.length} valuation figure(s): ${valuations.join(", ") || "none on this item"})`);
  console.log(`     rate === list rate      ${stored ? "YES" : `NO  (stored ${back.rate}, list ${listRate})`}`);
  console.log(`     rate is not a valuation ${notCost ? "YES" : "NO  ← A COST FIGURE REACHED THE BOOKS"}`);

  const gone = await del(company, payload.remoteId!, back.type, number);
  const after = await readBack(company, number);
  console.log(`  ⑤ cleanup: deleted=${gone}, left=${after ? 1 : 0}`);
  rmSync(inPath); rmSync(outPath);

  const pass = builtOk && ok && stored && notCost && !after;
  console.log(`\n  ${pass ? "PASS — the resolved price round-tripped and the books are clean." : "FAIL — see above."}`);
  if (after) console.log(`  ⚠ LEFT IN THE BOOKS — delete by hand: ${number}`);
  console.log();
  process.exit(pass ? 0 : 1);
})();
