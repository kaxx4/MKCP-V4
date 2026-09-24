/**
 * GSTIN and GST-state primitives for the push guard.
 *
 * The SAME table and checksum the web app refuses on before a voucher is queued
 * (web-dashboard/src/domain/gstStates.ts, engine/purchase/normalize.ts,
 * 24-Sep-2026). They live in two repos because the two processes share no code;
 * the guard re-checks server-side as defence in depth — a queued row can come
 * from an old browser tab, a script, or /api/local/push. If the web table
 * changes, change this one (the list is the CBIC state-code notification, which
 * TallyPrime's own State list is keyed on).
 */

export const GST_STATE_BY_CODE: Readonly<Record<string, string>> = {
  "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh",
  "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh",
  "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur",
  "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal",
  "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
  "26": "Dadra & Nagar Haveli and Daman & Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa",
  "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman & Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
  "97": "Other Territory",
};

const ALIASES: Record<string, string> = {
  orissa: "odisha", pondicherry: "puducherry", uttaranchal: "uttarakhand", newdelhi: "delhi", nctofdelhi: "delhi",
};

/** A state name reduced to letters only, "&" read as "and". */
export function stateKey(name: string | null | undefined): string {
  const k = String(name ?? "").toLowerCase().replace(/&/g, "and").replace(/[^a-z]/g, "");
  return ALIASES[k] ?? k;
}

/** True when two spellings name the same state. Empty never matches. */
export function sameState(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = stateKey(a);
  return ka !== "" && ka === stateKey(b);
}

/** The state a GSTIN was issued in, or null. */
export function stateFromGstin(gstin: string | null | undefined): string | null {
  const g = normalizeGstin(String(gstin ?? ""));
  if (!/^\d{2}/.test(g)) return null;
  return GST_STATE_BY_CODE[g.slice(0, 2)] ?? null;
}

/** The code for a state name, or null when the name is not a GST state. */
export function codeForState(name: string | null | undefined): string | null {
  const k = stateKey(name);
  if (!k) return null;
  for (const [code, n] of Object.entries(GST_STATE_BY_CODE)) if (stateKey(n) === k) return code;
  return null;
}

export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const normalizeGstin = (s: string): string => s.toUpperCase().replace(/[^0-9A-Z]/g, "");

const CODE = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The 15th GSTIN character from the first 14 (official mod-36 Luhn). */
export function gstinCheckDigit(first14: string): string {
  if (first14.length !== 14) return "";
  let factor = 2, sum = 0;
  for (let i = first14.length - 1; i >= 0; i--) {
    const cp = CODE.indexOf(first14[i]);
    if (cp < 0) return "";
    const d = factor * cp;
    factor = factor === 2 ? 1 : 2;
    sum += Math.floor(d / 36) + (d % 36);
  }
  return CODE[(36 - (sum % 36)) % 36];
}

export function isGstinChecksumValid(s: string): boolean {
  const g = normalizeGstin(s);
  return GSTIN_RE.test(g) && gstinCheckDigit(g.slice(0, 14)) === g[14];
}

export const PIN_RE = /^[1-9]\d{5}$/;
export const HSN_RE = /^\d{4}(\d{2}(\d{2})?)?$/;

/**
 * "MIXED ORDER" is a real Tally ledger (`SUNDRY DEBTORS (EG)`) but not a real
 * party: it is several cash orders billed together for packing convenience,
 * and the buyer is different on every invoice. Owner, 24-Sep-2026: treat it
 * like `Cash` — a typed buyer name and address on every invoice, place of
 * supply West Bengal, the same ₹50,000 ceiling — because it IS cash, just
 * batched. Its ledger carries a state (West Bengal) that `Cash` does not, but
 * no address and no pincode, so it cannot be checked the way an ordinary
 * party ledger is.
 *
 * SAME definition as the web's `domain/accounting.ts` `isCashLikeParty`
 * (24-Sep-2026); the two are checked against each other, not each carrying
 * its own copy of the reasoning (G1).
 */
export const MIXED_ORDER_PARTY = "MIXED ORDER";

/** True for the shared `Cash` ledger or `MIXED ORDER` by NAME. Does not read
 *  the ledger group — callers that also treat any ledger under a "cash" group
 *  as a walk-in (`isWalkInLedger` in pushGuard.ts) OR this. */
export function isCashLikeParty(name: string | null | undefined): boolean {
  const n = String(name ?? "").trim().toUpperCase();
  return n === "CASH" || n === MIXED_ORDER_PARTY;
}
