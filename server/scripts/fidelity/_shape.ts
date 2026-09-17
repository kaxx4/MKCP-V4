import { tallyPost } from "../../src/tally.js";
import { U, company, esc } from "./harness.js";
(async () => {
  const co = await company();
  const name = process.argv[2];
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>${esc(name)}</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY><SVFROMDATE>20260401</SVFROMDATE><SVTODATE>20260930</SVTODATE></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
  const res = await tallyPost(U, xml, 400_000, true) as string;
  // element skeleton: names of every element, with nesting depth
  const events = [...res.matchAll(/<(\/?)([A-Z0-9_.]+)([^>]*?)(\/?)>/gi)];
  let depth = 0; const lines: string[] = []; const counts = new Map<string,number>();
  for (const e of events) {
    const closing = e[1] === "/", selfClose = e[4] === "/";
    const tag = e[2];
    counts.set(tag, (counts.get(tag) ?? 0) + (closing ? 0 : 1));
    if (closing) { depth--; continue; }
    if (lines.length < 42) lines.push(`${"  ".repeat(Math.max(0,depth))}<${tag}${e[3].trim()?" "+e[3].trim().slice(0,40):""}>`);
    if (!selfClose) depth++;
  }
  console.log(`\n=== ${name} — element skeleton (first 42) ===`);
  lines.forEach(l => console.log("  " + l));
  console.log(`\n  most repeated elements:`);
  [...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10).forEach(([t,n]) => console.log(`    ${String(n).padStart(5)}  ${t}`));
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });
