/**
 * JOB: choose which ledger names go on the real-names deny-list (the file `test-no-real-names` scans the repo with).
 *
 * Pure: takes ledger names and their parent groups, returns the names to refuse. The list is sensitive, so the
 * script that calls this (`build-name-denylist.ts`) writes it to the git-ignored `server/data/name-denylist.txt`
 * and prints counts only, never a name.
 */
export interface LedgerRef { name: string; parent: string }

const PARTY_GROUPS = /sundry|debtor|creditor|loan|capital|advance|salary|staff|employee|partner|director/i;
const GENERIC = /^(cash|bank|profit|loss|stock|opening|closing|round|trade|freight|tds|gst|igst|cgst|sgst|output|input|zz\b)/i;

/** The ledger names worth refusing in a public repository: people and trading parties, not accounts like "CASH". */
export function selectDenyNames(ledgers: LedgerRef[]): string[] {
  const seen = new Set<string>();
  for (const l of ledgers) {
    const name = l.name.replace(/\s+/g, " ").trim();
    if (!PARTY_GROUPS.test(l.parent)) continue;
    if (name.length < 5 || (name.match(/[A-Za-z]/g) ?? []).length < 4) continue;
    if (GENERIC.test(name)) continue;
    seen.add(name.toUpperCase());
  }
  return [...seen].sort();
}
