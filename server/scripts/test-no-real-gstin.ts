/**
 * Offline guard (#108): this repository is PUBLIC, so no tracked file may carry
 * a real GSTIN or a labelled PAN. Any GSTIN-shaped string must be one of the
 * obviously fake ones:
 *   - a PAN part ending in a placeholder digit group (0000, 1234, 5678, 9876)
 *     such as the documentation examples, or
 *   - a PAN part starting "ZZZ" (the sanitiser's fake series, e.g. ZZZCZ0272Z).
 * Anything else fails and is printed MASKED, so this guard never reprints the
 * value it is complaining about.
 *
 * Git history still holds the pre-#108 values; this guard only stops new ones.
 *
 *   npx tsx scripts/test-no-real-gstin.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g;
const LABELLED_PAN = /\bPAN\b[^A-Za-z0-9]{0,6}([A-Z]{5}\d{4}[A-Z])\b/g;
const FAKE_DIGITS = new Set(["0000", "1234", "5678", "9876"]);

export function isFakePan(pan: string): boolean {
  return pan.startsWith("ZZZ") || FAKE_DIGITS.has(pan.slice(5, 9));
}
export function findRealIdentities(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(GSTIN)) if (!isFakePan(m[0].slice(2, 12))) out.push(m[0]);
  for (const m of text.matchAll(LABELLED_PAN)) if (!isFakePan(m[1])) out.push(m[1]);
  return out;
}
const mask = (s: string) => s.slice(0, 2) + "*".repeat(Math.max(0, s.length - 4)) + s.slice(-2);

let failures = 0;
function ok(name: string, pass: boolean, detail = ""): void {
  console.log(`  ${pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

// The detector itself: values are assembled at runtime so this file holds none.
const realShaped = "19" + "ABCDE" + "9876".replace("9876", "4321") + "F" + "1" + "Z" + "5";
ok("detector flags a GSTIN-shaped string with real-looking digits", findRealIdentities(`x ${realShaped} y`).length === 1);
ok("detector allows placeholder digits", findRealIdentities("19AAAAA0000A1Z5 21ABCDE1234F1Z5").length === 0);
ok("detector allows the ZZZ fake series", findRealIdentities("19ZZZCZ0272Z1ZG").length === 0);
ok("detector flags a labelled real-shaped PAN", findRealIdentities("(PAN: " + "ABCDE" + "4321" + "F)").length === 1);
ok("detector ignores a PAN-shaped word that is not labelled", findRealIdentities("ZZZIQ4530Q").length === 0);

// The repository: every tracked text file.
const repoRoot = join(here, "..", "..");
let files: string[] = [];
try {
  files = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8").split("\0").filter(Boolean);
} catch {
  console.log("  (git not available, repository scan skipped)");
}
const SKIP = /(^|\/)(package-lock\.json|node_modules\/)|\.(png|jpe?g|gif|ico|webp|woff2?|ttf|zip|exe|dmg|pdf)$/i;
const hits: string[] = [];
let scanned = 0;
for (const f of files) {
  if (SKIP.test(f)) continue;
  let text: string;
  try { text = readFileSync(join(repoRoot, f), "utf8"); } catch { continue; }
  scanned++;
  for (const v of findRealIdentities(text)) hits.push(`${f}  ${mask(v)}`);
}
if (files.length) ok(`no real GSTIN or labelled PAN in ${scanned} tracked files`, hits.length === 0, hits.length ? `(${hits.length} hit(s))` : "");
for (const h of hits.slice(0, 25)) console.error(`      ${h}`);

if (failures) { console.error(`\n  ${failures} check(s) failed\n`); process.exit(1); }
console.log("\n  all checks passed\n");
