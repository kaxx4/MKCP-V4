/**
 * The 27-Nov-2026 review of the push-blocking rules (owner: "i dont want pushes to tally to get blocked").
 * Each change below is backed by a run on the sandbox dummy Tally: scripts/verify-push-rules-dummy.ts. Offline: never contacts Tally.
 *
 *   npx tsx server/scripts/test-push-rules-27nov.ts
 */
import { guardVoucher } from "../src/services/pushGuard.js";
import type { VoucherPayload } from "../src/types.js";
import { fixtureMasters, sale, purchase, PARTY_LOCAL, PARTY_INTER, SUPPLIER } from "./guardrails/fixtures.js";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => { if (cond) pass++; else fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + detail}`); };
const m = fixtureMasters();
const clip = [{ item: "CARRIER CLIP", amount: 1000.3, rate: 5 }];

// ── Loosened: warn, do not refuse ───────────────────────────────────────────
{
  const p = { ...purchase("R27/1", [{ item: "CARRIER CLIP", amount: 100, rate: 5 }]), placeOfSupply: "Punjab" } as VoucherPayload;
  const g = guardVoucher(p, m);
  ok("a place of supply typed on a Purchase warns that it was ignored", g.warnings.some((w) => /was typed on this Purchase and was ignored/.test(w)), g.warnings.join("|"));
  ok("... and no longer refuses", !g.errors.some((e) => /place of supply/i.test(e)), g.errors.join("|"));
}
{
  const v = sale({ number: "R27/2", party: PARTY_LOCAL, lines: clip });
  const r = v.ledgerEntries.find((e) => e.ledgerName === "ROUNDED OFF")!;
  r.isDeemedPositive = true;
  const g = guardVoucher(v, m);
  ok("a sale's round-off on the debit side warns", g.ok && g.warnings.some((w) => /debit side/.test(w)), g.errors.join("|"));
}
{
  const p = purchase("R27/3", [{ item: "CARRIER CLIP", amount: 1000.3, rate: 5 }]);
  const r = p.ledgerEntries.find((e) => e.ledgerName === "ROUNDED OFF");
  if (r) {
    r.isDeemedPositive = !r.isDeemedPositive;
    const g = guardVoucher(p, m);
    ok("a purchase's round-off on the credit side warns", g.warnings.some((w) => /credit side/.test(w)), g.errors.join("|") + g.warnings.join("|"));
  } else ok("(fixture purchase has no round-off to flip)", true);
}

// ── Kept hard: the dummy Tally accepts these silently, so the guard is the only check ─────
{
  const v = sale({ number: "R27/4", party: PARTY_LOCAL, lines: clip });
  const r = v.ledgerEntries.find((e) => e.ledgerName === "ROUNDED OFF")!;
  r.amount = 3; r.signedAmount = 3;
  const g = guardVoucher(v, m);
  ok("a round-off over 50 paise is refused, with what to do", g.errors.some((e) => /never more than ₹0\.50/.test(e) && /Check the amounts/.test(e)), g.errors.join("|"));
}
{
  const v = sale({ number: "R27/5", party: PARTY_LOCAL, lines: clip });
  v.inventoryEntries![0].quantity = 10; v.inventoryEntries![0].rate = 100; // 10 x 100 against an amount of 1000.30
  const g = guardVoucher(v, m);
  ok("amount not equal to quantity x rate is still refused", g.errors.some((e) => /does not equal quantity/.test(e) && /Correct the rate or the amount/.test(e)), g.errors.join("|"));
}
{
  const v = sale({ number: "R27/6", party: PARTY_LOCAL, lines: clip });
  v.inventoryEntries!.push({ ...v.inventoryEntries![0], quantity: 1, rate: 0, amount: 0 });
  const g = guardVoucher(v, m);
  ok("a zero-value stock line is still refused and the text says Tally drops it", g.errors.some((e) => /positive magnitude/.test(e) && /silently drops/.test(e)), g.errors.join("|"));
}

// ── The ship-to rule cannot fire on name, country or GSTIN: the bill-to is the ship-to ─────
{
  // A ledger with no mailing name and no country: the identity falls back to the ledger's own name and India, so nothing is missing.
  const bare = fixtureMasters();
  const led = bare.ledgers.get(PARTY_INTER)!;
  led.mailingName = ""; (led as unknown as { country?: string }).country = "";
  const g = guardVoucher(sale({ number: "R27/7", party: PARTY_INTER, inter: true, lines: clip }), bare);
  ok("no mailing name or country on the ledger: no ship-to refusal (name falls back to the ledger name, country to India)", !g.errors.some((e) => /ship-to/i.test(e)), g.errors.join("|"));
}

// ── Refusal texts say what to do next ───────────────────────────────────────
{
  const v = sale({ number: "R27/8", party: "NO SUCH PARTY", lines: clip });
  const g = guardVoucher(v, m);
  ok("an unknown party says to check the spelling or create it", g.errors.some((e) => /does not exist\. Check the spelling, or create the party in Tally first/.test(e)), g.errors.join("|"));
  const w = { ...sale({ number: "R27/9", party: SUPPLIER, lines: clip }), remoteId: undefined } as VoucherPayload;
  const g2 = guardVoucher(w, m);
  ok("a missing tracking id says it is an app fault and what to do", g2.errors.some((e) => /fault in the app/.test(e)), g2.errors.join("|"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
