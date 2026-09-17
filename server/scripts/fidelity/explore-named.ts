/**
 * Named collections and Execute/Function — what else the XML gateway will do.
 *
 * ── Why this probes ONE AT A TIME with a health check between ─────────────
 *
 * A malformed request can raise a modal dialog in TallyPrime that blocks the
 * XML port until a human clears it. That happened on 17-Sep-2026: an Export
 * header carrying a `<TYPE>` but no `<ID>` took the port down, and the THREE
 * probes that ran after it all timed out — so the log said four things were
 * dangerous when only one was. A batch of probes cannot tell you which member
 * broke it.
 *
 * So: probe, ping, probe, ping. The first ping that fails names the culprit
 * exactly, and everything stops there rather than producing a page of
 * meaningless timeouts.
 *
 * Named collections are known-safe as a CLASS before we start: `HEALTH_XML` is
 * `<TYPE>Collection</TYPE><ID>List of Companies</ID>`, the single most-used
 * request in this codebase.
 *
 *   npx tsx scripts/fidelity/explore-named.ts            # named collections
 *   npx tsx scripts/fidelity/explore-named.ts --functions # and Execute/Function
 */
import { tallyPost, HEALTH_XML } from "../../src/tally.js";
import { U, company, esc } from "./harness.js";

const WITH_FUNCTIONS = process.argv.includes("--functions");

/** Is the port still answering? The whole method rests on this. */
async function alive(): Promise<boolean> {
  try {
    await tallyPost(U, HEALTH_XML, 12_000);
    return true;
  } catch {
    return false;
  }
}

interface Outcome {
  label: string;
  status: string;
  bytes: number;
  objects: number;
  note: string;
}

function summarise(res: string): Omit<Outcome, "label"> {
  const status = /<STATUS>\s*(-?\d+)\s*<\/STATUS>/.exec(res)?.[1] ?? "?";
  const err = /<LINEERROR>([\s\S]*?)<\/LINEERROR>/i.exec(res)?.[1]?.replace(/&apos;/g, "'").trim();
  const desc = /<DESC>([^<]*)<\/DESC>/.exec(res)?.[1]?.trim();
  // Count the commonest repeated element — a rough "how many things came back".
  const counts = new Map<string, number>();
  for (const m of res.matchAll(/<([A-Z][A-Z0-9_]*)[\s>]/g)) {
    if (/^(ENVELOPE|HEADER|BODY|DESC|DATA|VERSION|STATUS|COLLECTION)$/.test(m[1])) continue;
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    status,
    bytes: res.length,
    objects: top?.[1] ?? 0,
    note: err ? `LINEERROR: ${err.slice(0, 60)}` : desc ? `DESC: ${desc.slice(0, 50)}` : top ? `most common <${top[0]}>` : "",
  };
}

async function main(): Promise<void> {
  const co = await company();
  console.log(`\ncompany  ${co}`);
  console.log(`method   one probe, then a health check, stopping at the first block\n`);

  const namedCollection = (id: string) =>
    `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${esc(id)}</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC></BODY></ENVELOPE>`;

  const probes: { label: string; xml: string }[] = [
    // Named collections. Same SHAPE as the health check, which is why this
    // class is safe to walk.
    /* PROVEN SAFE, 17-Sep-2026. Do not add a name to this list on the theory
       that it looks like the others: `List of Units` is a perfectly reasonable
       guess — `Unit` IS a valid collection TYPE — and it BLOCKED THE PORT. The
       named-collection namespace is a fixed, finite set, NOT "List of " plus
       any type name. Anything new goes through this script's one-at-a-time
       health check, never into a batch. */
    ...["List of Ledgers", "List of Groups", "List of StockItems", "List of StockGroups",
        "List of Godowns", "List of CostCentres", "List of VoucherTypes"]
      .map((id) => ({ label: `collection "${id}"`, xml: namedCollection(id) })),
  ];

  if (WITH_FUNCTIONS) {
    /* Execute/Function is a DIFFERENT shape and therefore a different risk. It
       goes last, one at a time, after everything safe has been learned. The
       function names are the ones worth having rather than a sweep: the first
       would answer the numbering question directly. */
    const fn = (id: string, params: string[] = []) =>
      `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Execute</TALLYREQUEST><TYPE>Function</TYPE><ID>${esc(id)}</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY></STATICVARIABLES>
<FUNCPARAMLIST>${params.map((p) => `<PARAM>${esc(p)}</PARAM>`).join("")}</FUNCPARAMLIST></DESC></BODY></ENVELOPE>`;
    probes.push(
      { label: 'function "$$Today"', xml: fn("$$Today") },
      { label: 'function "$$LastVoucherNumber" (Payment)', xml: fn("$$LastVoucherNumber", ["Payment"]) },
      { label: 'function "$$CmpMailName"', xml: fn("$$CmpMailName") },
    );
  }

  const results: Outcome[] = [];
  for (const p of probes) {
    let res: string;
    try {
      res = (await tallyPost(U, p.xml, 45_000, true)) as string;
      results.push({ label: p.label, ...summarise(res) });
    } catch (e) {
      results.push({ label: p.label, status: "—", bytes: 0, objects: 0, note: `threw: ${(e as Error).message.slice(0, 50)}` });
    }

    if (!(await alive())) {
      console.log(`\n  ⚠ THE PORT WENT DOWN ON: ${p.label}`);
      console.log(`    Everything before it is trustworthy. Nothing after it was run.`);
      console.log(`    Clear the dialog in TallyPrime before running this again.\n`);
      break;
    }
  }

  const w = Math.max(...results.map((r) => r.label.length));
  for (const r of results) {
    console.log(`  ${r.label.padEnd(w)}  status=${r.status.padEnd(3)} ${String(Math.round(r.bytes / 1024)).padStart(5)} KB  ${String(r.objects).padStart(5)} objs  ${r.note}`);
  }
  console.log("");
}

main().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
