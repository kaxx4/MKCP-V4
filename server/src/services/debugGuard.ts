/**
 * Read-only gate for the raw-XML debug endpoint (POST /api/tally/debug).
 *
 * Allowlist first: the only TALLYREQUEST this endpoint may send is `Export`
 * (every builder in the codebase uses Export for reads). Anything else is
 * refused, including `Import Data`, `Execute` and anything not yet known.
 *
 * Normalisation runs before the check so that a dressed-up envelope — entity
 * encoded, double encoded, CDATA-wrapped, comment-split, attribute-carrying,
 * case- or whitespace-varied — is judged by the same rule as a plain one.
 * The check fails closed: when in doubt, refuse.
 */
import { decodeXmlEntities } from "./xml.js";

export type DebugVerdict = { allowed: true } | { allowed: false; reason: string };

const MAX_PASSES = 5;

/** Decode entities and unwrap CDATA until the text stops changing. */
function normalise(xml: string): string {
  let s = xml;
  for (let i = 0; i < MAX_PASSES; i++) {
    const next = decodeXmlEntities(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
    if (next === s) break;
    s = next;
  }
  return s;
}

export function checkDebugXml(xml: string): DebugVerdict {
  const text = normalise(xml);

  // Any Import Data body, in any tag case, is a write whatever the header says.
  if (/<\s*IMPORTDATA\b/i.test(text)) {
    return { allowed: false, reason: "contains an IMPORTDATA block" };
  }

  const opens = text.match(/<\s*TALLYREQUEST\b/gi) ?? [];
  const elements = [...text.matchAll(/<\s*TALLYREQUEST\b[^>]*>([\s\S]*?)<\s*\/\s*TALLYREQUEST\s*>/gi)];
  if (opens.length === 0 || elements.length !== opens.length) {
    return { allowed: false, reason: "TALLYREQUEST missing or malformed" };
  }
  for (const m of elements) {
    const value = m[1].replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    if (value !== "export") {
      return { allowed: false, reason: `request type "${value.slice(0, 40)}" is not on the read allowlist` };
    }
  }
  return { allowed: true };
}
