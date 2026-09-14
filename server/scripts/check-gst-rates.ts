/** Does the item → stock group → company rate chain actually resolve? */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import { loadMasters, gstRateFor } from "../src/services/tallyMasters.js";
const U = process.env.TALLY_URL || "http://localhost:9000";
(async () => {
  const c = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  const m = await loadMasters(U, c, { force: true });
  let own = 0, grp = 0, none = 0;
  const samples: string[] = [];
  const groupHits = new Map<string, number>();
  for (const [n] of m.items) {
    const r = gstRateFor(m, n);
    if (r.source === "item") own++;
    else if (r.source.startsWith("stock group")) { grp++; groupHits.set(r.source, (groupHits.get(r.source) ?? 0) + 1); }
    else { none++; if (samples.length < 4) samples.push(`   ${n.slice(0, 36).padEnd(38)} ${r.source}`); }
  }
  console.log(`\nGST rate resolution across ${m.items.size} items:`);
  console.log(`  from the item itself : ${own}`);
  console.log(`  inherited from group : ${grp}`);
  console.log(`  NO RATE FOUND        : ${none}`);
  if (groupHits.size) {
    console.log(`\n  top inheriting groups:`);
    for (const [g, n2] of [...groupHits].sort((a, b) => b[1] - a[1]).slice(0, 4)) console.log(`   ${String(n2).padStart(4)} × ${g}`);
  }
  if (samples.length) { console.log(`\n  unresolvable — these would file as "Tax Rate is not specified":`); console.log(samples.join("\n")); }
})();
