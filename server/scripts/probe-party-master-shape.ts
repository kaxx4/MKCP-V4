/**
 * What a party LEDGER master holds for bill-to / ship-to — mailing details
 * (dated), GST registration (dated), country, registration type. Read-only.
 *   npx tsx server/scripts/probe-party-master-shape.ts "<ledger name>" ["<ledger name>" ...]
 *   npx tsx server/scripts/probe-party-master-shape.ts --census   (regtype / country counts over debtors)
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import { tallyPost } from "../src/tally.js";
import { buildCollection, blocksOf, tagOf } from "../src/services/tallyRequest.js";

const U = process.env.TALLY_URL || "http://localhost:9000";
const COMPANY = process.env.TALLY_COMPANY || "";
const FETCH = ["Name", "Parent", "PartyGSTIN", "GSTIN", "LedStateName", "PinCode", "MailingName", "CountryName",
  "CountryOfResidence", "GSTRegistrationType", "Address", "LedMailingDetails", "LedGSTRegDetails", "LedgerMobile", "LedgerPhone"];

(async () => {
  const args = process.argv.slice(2);
  const census = args[0] === "--census";
  const names = census ? [] : args;
  const xml = buildCollection({
    id: "PartyShape", type: "Ledger", company: COMPANY, fetch: FETCH,
    ...(census ? { filter: { kind: "compare", expr: "$Parent", cmp: "eq", value: "Sundry Debtors" } as const } : {}),
  });
  const raw: string = await tallyPost(U, xml, 180_000, true);
  const leds = blocksOf(raw, "LEDGER");
  if (census) {
    const c = new Map<string, number>();
    for (const b of leds) {
      const regs = [...b.matchAll(/<GSTREGISTRATIONTYPE>([^<]*)</g)].map((m) => m[1]);
      const mails = (b.match(/<LEDMAILINGDETAILS\.LIST>/g) ?? []).length;
      const k = `regs=[${[...new Set(regs)].join("|")}] mailingBlocks=${mails}`;
      c.set(k, (c.get(k) ?? 0) + 1);
    }
    console.log(leds.length, "debtors"); for (const [k, n] of [...c].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(4), k);
    return;
  }
  for (const n of names) {
    const b = leds.find((x) => (x.match(/NAME="([^"]*)"/)?.[1] ?? tagOf(x, "NAME")) === n || tagOf(x, "NAME") === n);
    console.log(`\n=== ${n}: ${b ? "" : "NOT FOUND"}`);
    if (!b) continue;
    const body = b.replace(/<([A-Z0-9.]+)[^>]*>\s*<\/\1>/g, "").replace(/<([A-Z0-9.]+)[^>]*\/>/g, "");
    const lines = [...body.matchAll(/<([A-Z][A-Z0-9._]*)(?:\s[^>]*)?>([^<]*)<\/\1>|<([A-Z][A-Z0-9._]*\.LIST)[^>]*>/g)]
      .map((m) => (m[3] ? `[${m[3]}]` : `${m[1]}=${m[2].trim()}`)).filter((s) => !/=(No|0|)$/.test(s));
    console.log(lines.join("\n"));
  }
})();
