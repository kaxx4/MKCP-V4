/**
 * Fields Tally populates that nothing in this system reads.
 *
 * Only object types the codebase already uses are passed to <TYPE> — an
 * unrecognised one raises a modal and blocks the port until a human restarts
 * TallyPrime, so this is never a sweep over guesses.
 */
import { tallyPost } from "../../src/tally.js";
import { U, company, allFieldsXml, objects } from "./harness.js";

/** What the sync already asks for, by object. */
const FETCHED: Record<string, string[]> = {
  Ledger: ["NAME","PARENT","OPENINGBALANCE","PARTYGSTIN","LEDGSTREGDETAILS","CREDITPERIOD",
    "BILLCREDITPERIOD","GUID","MAILINGNAME","ADDRESS","LEDSTATENAME","COUNTRYNAME","PINCODE","EMAIL","LEDGERPHONE"],
  StockItem: ["NAME","PARENT","BASEUNITS","DENOMINATOR","CLOSINGBALANCE","CLOSINGRATE",
    "GSTDETAILS","SRCOFGSTDETAILS","ADDITIONALUNITS","OPENINGBALANCE","OPENINGRATE","OPENINGVALUE",
    "CLOSINGVALUE","GSTAPPLICABLE","GSTTYPEOFSUPPLY","COSTINGMETHOD","VALUATIONMETHOD","ISBATCHWISEON","ISCOSTCENTRESON","HSNDETAILS"],
  Godown: ["NAME"],
  Unit: ["NAME"],
  CostCentre: ["NAME","PARENT"],
  StockGroup: ["NAME","PARENT","GSTDETAILS"],
};

/** Noise: audit trail, legacy tax regimes, payroll, UI state. */
const BORING = /^(OLD|GUID|ALTERID|MASTERID|LANGUAGE|AUDIT|REMOTE|CANCELLED|TYPEOFUPDATE|OBJECTUPDATE|SERVICETAX|EXCISE|VAT|TDS|TCS|FBT|GRATUITY|SLAB|LBT|STCATEG|DEDUCTEE|ATTENDANCE|XBRL|SCHVI|CENVAT|HARYANA|UAE|IRN|EWAY|PF|ESI|SALARY|PAYSLIP|CONTRI)/i;

async function main(): Promise<void> {
  const co = await company();
  console.log(`\ncompany  ${co}\n`);
  for (const [type, fetched] of Object.entries(FETCHED)) {
    const xml = (await tallyPost(U, allFieldsXml(co, type), 240_000, true)) as string;
    const objs = objects(xml, type.toUpperCase()).filter((o) => o.name);
    if (!objs.length) { console.log(`── ${type}: nothing returned\n`); continue; }
    /* Count DISTINCT VALUES per tag, not occurrences.
       A field carrying the same string on all 482 ledgers holds no
       information — TAXTYPE=Others, ALLOWINMOBILE=No,
       TAXCLASSIFICATIONNAME="Not Applicable". The first version of this probe
       ranked by how many objects populated a tag and returned two screens of
       exactly that boilerplate. Variety is the signal, not presence. */
    const counts = new Map<string, number>();
    const values = new Map<string, Set<string>>();
    for (const o of objs) {
      const seen = new Set<string>();
      for (const m of o.body.matchAll(/<([A-Z0-9_]+)>([^<]*)<\/\1>/gi)) {
        const v = m[2].trim();
        if (!v || seen.has(m[1])) continue;
        seen.add(m[1]);
        counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
        if (!values.has(m[1])) values.set(m[1], new Set());
        const set = values.get(m[1])!;
        if (set.size < 60) set.add(v);
      }
    }
    const have = new Set(fetched.map((f) => f.toUpperCase()));
    const unused = [...counts.entries()]
      .filter(([k, n]) => !have.has(k) && !BORING.test(k)
        && n >= Math.max(3, objs.length * 0.05)
        && (values.get(k)?.size ?? 0) > 1)
      .sort((a, b) => (values.get(b[0])!.size - values.get(a[0])!.size) || b[1] - a[1]);
    console.log(`── ${type}  (${objs.length} objects, ${counts.size} populated tags, ${unused.length} unused AND varying)`);
    for (const [k, n] of unused.slice(0, 22)) {
      const example = objs.find((o) => new RegExp(`<${k}>([^<]+)</${k}>`, "i").test(o.body));
      const val = example ? new RegExp(`<${k}>([^<]+)</${k}>`, "i").exec(example.body)![1].trim() : "";
      console.log(`   ${String(n).padStart(4)}/${String(objs.length).padEnd(4)} ${String(values.get(k)!.size).padStart(3)} distinct  ${k.padEnd(26)} e.g. ${val.slice(0, 30)}`);
    }
    console.log("");
  }
}

main().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
