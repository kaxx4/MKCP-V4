/**
 * Offline guard (#108 follow-up): this repository is PUBLIC, so no tracked file
 * may carry a real party, person or supplier name. Fixtures and script literals
 * use stable fakes ("PARTY 042 CYCLE STORES", "PERSON 003").
 *
 * The list of REAL names to refuse is itself sensitive, so it is NOT in the repo.
 * It is read, one name per line (blank lines and `#` comments ignored), from:
 *   1. the file named by the MKCP_NAME_DENYLIST environment variable, else
 *   2. server/data/name-denylist.txt  (git-ignored, kept only on the owner's machine).
 * With neither present this test SKIPS (exit 0) and says so; it never fails for a
 * missing list. Matching is case-insensitive, whitespace-tolerant and bounded by
 * non-alphanumerics, so "PARTY 042" can never collide with a longer word.
 * Hits are printed as file:line plus a masked token, never the name itself.
 *
 * A line that genuinely needs a deny-listed word (a common word that is also a Tally term, or the name of a shared system ledger the app
 * depends on by name) is allowed one line at a time in server/scripts/name-allowlist.json: the file, a short fingerprint of the trimmed
 * line (so the allow-list carries no name) and the reason. Change the line and the fingerprint no longer matches: the line is checked again.
 *
 *   MKCP_NAME_DENYLIST=/path/to/list.txt npx tsx scripts/test-no-real-names.ts
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function compileDenyList(lines: string[]): RegExp[] {
  return lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((name) => new RegExp(
      "(?<![A-Za-z0-9])" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+") + "(?![A-Za-z0-9])", "i"));
}
export function findNames(text: string, denies: RegExp[]): number[] {
  const out: number[] = [];
  text.split("\n").forEach((line, i) => { if (denies.some((rx) => rx.test(line))) out.push(i + 1); });
  return out;
}

/** Fingerprint of one line for the allow-list: the first 16 hex digits of the SHA-256 of the trimmed line. */
export function lineKey(line: string): string {
  return createHash("sha256").update(line.trim()).digest("hex").slice(0, 16);
}
export interface AllowEntry { file: string; line: string; why: string }
export function isAllowed(allow: AllowEntry[], file: string, line: string): boolean {
  const k = lineKey(line);
  return allow.some((a) => a.file === file && a.line === k && a.why.trim().length > 0);
}

let failures = 0;
function ok(name: string, pass: boolean, detail = ""): void {
  console.log(`  ${pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

// The detector itself, with invented names.
const probe = compileDenyList(["# comment", "", "ZZ TESTCO", "AB.CD STORES"]);
ok("detector matches case-insensitively and across spacing", findNames("x zz   testco y", probe).length === 1);
ok("detector respects word boundaries", findNames("ZZ TESTCOS and XZZ TESTCO", probe).length === 0);
ok("detector escapes regex characters", findNames("ab.cd stores", probe).length === 1 && findNames("abxcd stores", probe).length === 0);
ok("detector ignores comments and blank lines", probe.length === 2);
{
  const allow: AllowEntry[] = [{ file: "a.ts", line: lineKey("  x zz testco y  "), why: "invented" }];
  ok("allow-list: the same line in the same file is allowed (spaces at the ends do not matter)", isAllowed(allow, "a.ts", "x zz testco y"));
  ok("allow-list: the same line in another file is not allowed", !isAllowed(allow, "b.ts", "x zz testco y"));
  ok("allow-list: a changed line is checked again", !isAllowed(allow, "a.ts", "x zz testco y z"));
  ok("allow-list: an entry with no reason allows nothing", !isAllowed([{ file: "a.ts", line: lineKey("q"), why: " " }], "a.ts", "q"));
}

// The repository.
const repoRoot = join(here, "..", "..");
const listPath = process.env.MKCP_NAME_DENYLIST ?? join(here, "..", "data", "name-denylist.txt");
if (!existsSync(listPath)) {
  console.log(`\n  SKIPPED repository scan: no deny-list (set MKCP_NAME_DENYLIST or create server/data/name-denylist.txt).\n`);
} else {
  const denies = compileDenyList(readFileSync(listPath, "utf8").split(/\r?\n/));
  ok(`deny-list loaded (${denies.length} names)`, denies.length > 0);
  let files: string[] = [];
  try {
    files = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 })
      .toString("utf8").split("\0").filter(Boolean);
  } catch { console.log("  (git not available, repository scan skipped)"); }
  const SKIP = /(^|\/)(package-lock\.json|skills-lock\.json|node_modules\/|\.claude\/|\.agents\/)|\.(png|jpe?g|gif|ico|webp|woff2?|ttf|zip|exe|dmg|pdf)$/i;
  const allowPath = join(here, "name-allowlist.json");
  const allow: AllowEntry[] = existsSync(allowPath) ? (JSON.parse(readFileSync(allowPath, "utf8")).entries as AllowEntry[]) : [];
  const hits: string[] = [];
  let scanned = 0, allowed = 0;
  for (const f of files) {
    if (SKIP.test(f)) continue;
    let text: string;
    try { text = readFileSync(join(repoRoot, f), "utf8"); } catch { continue; }
    scanned++;
    const lines = text.split("\n");
    for (const ln of findNames(text, denies)) {
      if (isAllowed(allow, f, lines[ln - 1])) { allowed++; continue; }
      hits.push(`${f}:${ln}`);
    }
  }
  if (allow.length) console.log(`  (${allowed} line(s) allowed one by one in name-allowlist.json, ${allow.length} entries)`);
  if (files.length) ok(`no deny-listed real name in ${scanned} tracked files`, hits.length === 0, hits.length ? `(${hits.length} line(s))` : "");
  for (const h of hits) console.error(`      ${h}`);
}

if (failures) { console.error(`\n  ${failures} check(s) failed\n`); process.exit(1); }
console.log("\n  all checks passed\n");
