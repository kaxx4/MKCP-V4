/**
 * What an extractor must hand back, and how its output becomes a voucher.
 *
 * The vision step — reading pixels — is deliberately NOT here. It is one adapter
 * behind this interface, because it is the only part that depends on what a
 * photo looks like. Everything downstream of it is deterministic and testable
 * without a single image, and that is where the money-losing mistakes live:
 * resolving a supplier's wording to the right stock item, deciding a tax head,
 * matching a payment to the right bill.
 *
 * The rule that governs all of it, inherited from the existing purchase-capture
 * work and reconfirmed by the owner: **running headless means queue the
 * question, never pick the closest match.** A wrong item silently books stock
 * that never arrived; a wrong party silently misallocates real cash. Neither
 * shows up as an error anywhere.
 */
import type { TallyMasters } from "./tallyMasters.js";
import { findLedger, findItem, isMiss } from "./tallyMasters.js";

// ── What the vision step returns ────────────────────────────────────────────

/** One line as printed on a supplier's invoice, before any interpretation. */
export interface ExtractedLine {
  /** Verbatim description from the invoice face. */
  description: string;
  quantity: number;
  /** Unit as printed — "PCS", "Pair", "Nos". Not a Tally unit. */
  unitText?: string;
  rate: number;
  amount: number;
  /** 0–1. Below the review threshold this line gets queued, not booked. */
  confidence: number;
}

/** One invoice. A single photo may yield several of these. */
export interface ExtractedInvoice {
  vendorText: string;
  invoiceNumber: string;
  /** YYYY-MM-DD. */
  invoiceDate: string;
  lines: ExtractedLine[];
  taxableTotal?: number;
  taxTotal?: number;
  grandTotal?: number;
  /** Which source image, and where in it — so a reviewer can see the original. */
  sourceImageId: string;
  confidence: number;
}

/** One row of a bank statement or screenshot. */
export interface ExtractedBankRow {
  /** YYYY-MM-DD. */
  date: string;
  /** Positive = money in (a receipt); negative = money out (a payment). */
  amount: number;
  /** The narration as the bank printed it — where the payer's name hides. */
  description: string;
  /** UTR / cheque number. Becomes INSTRUMENTNUMBER in Tally. */
  reference?: string;
  sourceImageId: string;
  confidence: number;
}

// ── Resolution ──────────────────────────────────────────────────────────────

export type Resolution<T> =
  | { status: "resolved"; value: T; how: "exact" | "normalised" | "learned" }
  | { status: "question"; candidates: string[]; reason: string };

/** Confidence below which nothing is booked without a human, regardless of match quality. */
export const REVIEW_THRESHOLD = 0.85;

const norm = (s: string) =>
  s.toUpperCase()
   .replace(/["'`]/g, "")
   .replace(/[^A-Z0-9]+/g, " ")
   .trim();

/**
 * Resolve a printed string to a real master name.
 *
 * Deliberately conservative. It will return a question rather than a guess
 * whenever more than one master is plausible — an ambiguous item is cheap to
 * ask about and expensive to get wrong. `learned` mappings (a human's past
 * confirmation) outrank even an exact match, because the same printed words
 * genuinely mean different items from different vendors: "Chain Wheel & Crank
 * 44T" is one item from Asia Cutting Tools and a different one from Anand
 * Brothers.
 */
export function resolveName(
  printed: string,
  candidatesByName: Iterable<string>,
  learned?: Map<string, string>
): Resolution<string> {
  const cleaned = printed.trim();
  if (!cleaned) return { status: "question", candidates: [], reason: "Nothing was read for this field." };

  const learnedHit = learned?.get(norm(cleaned));
  if (learnedHit) return { status: "resolved", value: learnedHit, how: "learned" };

  const all = [...candidatesByName];
  const exact = all.find(n => n === cleaned);
  if (exact) return { status: "resolved", value: exact, how: "exact" };

  // Whitespace and punctuation differences only. Safe because it cannot change
  // which words are present — `FORK  TOGO 20" RB` vs `FORK TOGO 20 X 1.75`
  // differ in words, so they will NOT collapse together here.
  const target = norm(cleaned);
  const normalised = all.filter(n => norm(n) === target);
  if (normalised.length === 1) return { status: "resolved", value: normalised[0], how: "normalised" };
  if (normalised.length > 1) {
    return { status: "question", candidates: normalised, reason: `"${cleaned}" matches ${normalised.length} masters equally well.` };
  }

  // Token overlap, only ever to SUGGEST. Never auto-accepted, however good.
  const words = target.split(" ").filter(w => w.length > 2);
  const scored = all
    .map(n => {
      const nw = new Set(norm(n).split(" "));
      const hits = words.filter(w => nw.has(w)).length;
      return { n, score: hits - Math.max(0, nw.size - words.length) * 0.25 };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  return {
    status: "question",
    candidates: scored.map(s => s.n),
    reason: scored.length
      ? `"${cleaned}" does not match any master exactly. Closest: ${scored.map(s => s.n).join(" | ")}.`
      : `"${cleaned}" does not resemble any known master.`,
  };
}

export interface ResolvedLine {
  itemName: string;
  /** The item's OWN base unit — never the invoice's wording. */
  unit: string;
  quantity: number;
  rate: number;
  amount: number;
}

export interface InvoiceResolution {
  vendor?: string;
  lines: ResolvedLine[];
  /** Everything a human must answer before this can be booked. */
  questions: Array<{ field: string; reason: string; candidates: string[] }>;
  ready: boolean;
}

/**
 * Turn an extracted invoice into something that could be pushed — or into a
 * list of questions.
 *
 * Note what is NOT taken from the invoice: the unit. The invoice says "26 PRS";
 * the item's base unit is `PR`. Sending the invoice's wording makes Tally void
 * the quantity and rate without erroring, so the unit always comes from the
 * master.
 */
export function resolveInvoice(
  inv: ExtractedInvoice,
  masters: TallyMasters,
  learnedItems?: Map<string, string>,
  learnedVendors?: Map<string, string>
): InvoiceResolution {
  const questions: InvoiceResolution["questions"] = [];
  let vendor: string | undefined;

  const v = resolveName(inv.vendorText, masters.ledgers.keys(), learnedVendors);
  if (v.status === "resolved") {
    const led = findLedger(masters, v.value);
    if (isMiss(led)) questions.push({ field: "vendor", reason: `"${v.value}" is no longer a ledger.`, candidates: [] });
    else vendor = led.name;
  } else {
    questions.push({ field: "vendor", reason: v.reason, candidates: v.candidates });
  }

  const lines: ResolvedLine[] = [];
  for (const [i, l] of inv.lines.entries()) {
    if (l.confidence < REVIEW_THRESHOLD) {
      questions.push({
        field: `line ${i + 1}`,
        reason: `Read with low confidence (${(l.confidence * 100).toFixed(0)}%): "${l.description}".`,
        candidates: [],
      });
      continue;
    }
    const r = resolveName(l.description, masters.items.keys(), learnedItems);
    if (r.status !== "resolved") {
      questions.push({ field: `line ${i + 1}`, reason: r.reason, candidates: r.candidates });
      continue;
    }
    const item = findItem(masters, r.value);
    if (isMiss(item)) {
      questions.push({ field: `line ${i + 1}`, reason: `"${r.value}" is no longer a stock item.`, candidates: [] });
      continue;
    }
    // Trust the invoice for quantity, rate and amount; trust the master for everything else.
    lines.push({ itemName: item.name, unit: item.baseUnit, quantity: l.quantity, rate: l.rate, amount: l.amount });
  }

  // Arithmetic the invoice itself can confirm. A line total that doesn't equal
  // qty × rate usually means a misread digit, and the printed total is the
  // redundancy that locates it.
  if (inv.taxableTotal != null && lines.length === inv.lines.length) {
    const sum = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    if (Math.abs(sum - inv.taxableTotal) > 1) {
      questions.push({
        field: "totals",
        reason: `Line amounts sum to ${sum.toFixed(2)} but the invoice states ${inv.taxableTotal.toFixed(2)} — a difference of ${(sum - inv.taxableTotal).toFixed(2)} suggests a misread figure.`,
        candidates: [],
      });
    }
  }

  if (inv.confidence < REVIEW_THRESHOLD) {
    questions.push({ field: "invoice", reason: `Whole invoice read with low confidence (${(inv.confidence * 100).toFixed(0)}%).`, candidates: [] });
  }

  return { vendor, lines, questions, ready: questions.length === 0 && !!vendor && lines.length > 0 };
}

/**
 * Find the party a bank narration refers to.
 *
 * Bank descriptions are noisy — "NEFT-HDFCN52025-SARKAR CYCLE HABRA-..." — so
 * this looks for a ledger whose words all appear in the narration, and refuses
 * when several do. Money moved against the wrong party is invisible on screen
 * and painful to unwind, so a question is always the cheaper outcome.
 */
export function resolvePayerFromNarration(
  description: string,
  ledgerNames: Iterable<string>,
  learned?: Map<string, string>
): Resolution<string> {
  const hay = norm(description);
  const learnedHit = learned?.get(hay);
  if (learnedHit) return { status: "resolved", value: learnedHit, how: "learned" };

  const matches: Array<{ name: string; score: number }> = [];
  for (const name of ledgerNames) {
    const words = norm(name).split(" ").filter(w => w.length > 2);
    if (!words.length) continue;
    const hits = words.filter(w => hay.includes(w)).length;
    // Every significant word of the ledger name must be present.
    if (hits === words.length) matches.push({ name, score: words.length });
  }

  if (matches.length === 1) return { status: "resolved", value: matches[0].name, how: "normalised" };
  if (matches.length > 1) {
    // The most specific name wins only if it is strictly more specific.
    matches.sort((a, b) => b.score - a.score);
    if (matches[0].score > matches[1].score) return { status: "resolved", value: matches[0].name, how: "normalised" };
    return {
      status: "question",
      candidates: matches.slice(0, 3).map(m => m.name),
      reason: `The narration matches ${matches.length} parties equally well.`,
    };
  }
  return { status: "question", candidates: [], reason: `No party name found in "${description}".` };
}
