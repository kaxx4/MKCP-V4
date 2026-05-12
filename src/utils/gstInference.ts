import type { CanonicalVoucher, CanonicalVoucherLine } from "../types/canonical";

/**
 * Parse GST rate (total %) from a Tally ledger name.
 * Handles: "OUTPUT CGST @9%", "SGST @9%", "IGST @18%", "CGST 6%", etc.
 * Returns null if the ledger doesn't look like a GST entry.
 */
function parseGstRateFromLedgerName(ledgerId: string): { type: "igst" | "cgst" | "sgst"; rate: number } | null {
  const name = ledgerId.toUpperCase();

  const igst = name.match(/\bIGST\b.*?(\d+(?:\.\d+)?)\s*%?/);
  if (igst) return { type: "igst", rate: parseFloat(igst[1]) };

  const cgst = name.match(/\bCGST\b.*?(\d+(?:\.\d+)?)\s*%?/);
  if (cgst) return { type: "cgst", rate: parseFloat(cgst[1]) };

  // SGST or UTGST
  const sgst = name.match(/\b[SU]GST\b.*?(\d+(?:\.\d+)?)\s*%?/);
  if (sgst) return { type: "sgst", rate: parseFloat(sgst[1]) };

  return null;
}

/** Infer the total GST rate that applies to a voucher from its ledger lines. */
function inferVoucherGstRate(lines: CanonicalVoucherLine[]): number | null {
  let cgst = 0;
  let sgst = 0;
  let igst = 0;

  for (const line of lines) {
    if (line.type !== "ledger" || !line.ledgerId) continue;
    const parsed = parseGstRateFromLedgerName(line.ledgerId);
    if (!parsed) continue;
    if (parsed.type === "igst") igst = Math.max(igst, parsed.rate);
    else if (parsed.type === "cgst") cgst = Math.max(cgst, parsed.rate);
    else if (parsed.type === "sgst") sgst = Math.max(sgst, parsed.rate);
  }

  if (igst > 0) return igst;
  if (cgst > 0 || sgst > 0) return cgst + sgst;
  return null;
}

/**
 * Scan vouchers and infer GST rate per item by majority vote.
 * Only considers Sales and Purchase vouchers (not cancelled/optional).
 * Returns a Map<itemId (upper), gstRate>.
 */
export function inferGstRatesFromVouchers(vouchers: CanonicalVoucher[]): Map<string, number> {
  // itemId → Map<gstRate, occurrenceCount>
  const tallies = new Map<string, Map<number, number>>();

  for (const voucher of vouchers) {
    if (voucher.isCancelled || voucher.isOptional) continue;
    if (voucher.voucherType !== "Sales" && voucher.voucherType !== "Purchase") continue;

    const rate = inferVoucherGstRate(voucher.lines);
    if (rate === null || rate <= 0) continue;

    for (const line of voucher.lines) {
      if (line.type !== "inventory" || !line.itemId) continue;
      const counts = tallies.get(line.itemId) ?? new Map<number, number>();
      counts.set(rate, (counts.get(rate) ?? 0) + 1);
      tallies.set(line.itemId, counts);
    }
  }

  const result = new Map<string, number>();
  for (const [itemId, counts] of tallies) {
    let bestRate = 0;
    let bestCount = 0;
    for (const [rate, count] of counts) {
      if (count > bestCount) { bestCount = count; bestRate = rate; }
    }
    if (bestRate > 0) result.set(itemId, bestRate);
  }
  return result;
}
