/**
 * T11 read-only look at the dummy's masters: which GST, freight, discount, cash and
 * bank ledgers, godowns, units, voucher types and stock groups exist. Reads only
 * (the same six collection reads the push path uses). Prints names of masters the
 * rigs must reuse (tax, discount, round-off, freight, cash, bank, sales and
 * purchase ledgers); never prints a party.
 *   npx tsx scripts/rigs/t11-probe-masters.ts
 */
import "dotenv/config";
import { preflight } from "./lib/t11.js";
import { loadMasters } from "../../src/services/tallyMasters.js";

(async () => {
  const p = await preflight();
  const m = await loadMasters(p.tallyUrl, p.company, { force: true });
  const ledgers = [...m.ledgers.values()];
  const show = (label: string, re: RegExp) =>
    console.log(`${label}: ${JSON.stringify(ledgers.filter((l) => re.test(l.name)).map((l) => `${l.name} [${l.parent}]`))}`);
  show("TAX/GST", /GST|CGST|SGST|IGST|RCM|TDS|CESS/i);
  show("DISCOUNT/ROUND", /DISCOUNT|ROUND|H\.C\./i);
  show("FREIGHT/CARTAGE", /FREIGHT|CARTAGE|LOADING|TRANSPORT|PACKING/i);
  show("CASH/BANK", /^CASH$|CASH|BANK/i);
  show("SALES/PURCHASE", /^SALES|^PURCHASE|SALES |PURCHASE /i);
  console.log(`ledger groups seen: ${JSON.stringify([...new Set(ledgers.map((l) => l.parent))].sort())}`);
  console.log(`ledgers total ${ledgers.length}; items ${m.items.size}; godowns ${JSON.stringify([...m.godowns])}`);
  console.log(`units: ${JSON.stringify([...m.units])}`);
  console.log(`voucher types: ${JSON.stringify([...m.voucherTypes])}`);
  console.log(`stock groups: ${m.stockGroups.size}`);
  const zz = ledgers.filter((l) => /^ZZ/i.test(l.name)).map((l) => l.name);
  console.log(`ZZ ledgers present: ${JSON.stringify(zz)}`);
  console.log(`ZZ items present: ${JSON.stringify([...m.items.keys()].filter((n) => /^ZZ/i.test(n)))}`);
  process.exit(0);
})().catch((e) => { console.error(`FAILED: ${(e as Error).message}`); process.exit(2); });
