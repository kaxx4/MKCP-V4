/**
 * T11 read-only: what Tally itself says about this install and the open company, for the Edit Log question (coordinator, 12-Nov-2026).
 * The office runs TallyPrime 7.2 Edit Log. This reads, from Tally's own Company object (a bare NATIVEMETHOD * discovery read, which is
 * safe), every field whose name speaks of a log, an audit, an edit, a release, a version or an edition, and prints the field NAME with
 * its value only when the value is Yes or No (a switch) or a short release/version text. No serial number, no licence value and no
 * company detail is printed. One request. Writes nothing; changes no setting.
 *
 *   cd server; npx tsx scripts/rigs/t11-probe-company.ts
 */
import "dotenv/config";
import { preflight } from "./lib/t11.js";
import { makeLive, indiaToday, turn } from "./lib/t11Live.js";
import { tallyPost } from "../../src/tally.js";
import { escapeXml, tdlString } from "../../src/services/xml.js";
import { blocksOf } from "../../src/services/tallyRequest.js";

(async () => {
  const p = await preflight();
  const l = makeLive(p, indiaToday(), "000000");
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>T11Co</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${escapeXml(p.company)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="T11Co" ISMODIFY="No"><TYPE>Company</TYPE>
<NATIVEMETHOD>*</NATIVEMETHOD><FILTER>T11CoF</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="T11CoF">$Name = ${tdlString(p.company)}</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const raw = (await turn(l, "read company switches", () => tallyPost(p.tallyUrl, xml, 120_000, true))) as string;
  const cos = blocksOf(raw, "COMPANY").filter((b) => /<NAME>/.test(b));
  console.log(`company objects returned: ${cos.length}`);
  const co = cos[0] ?? raw;
  const scalars = [...co.matchAll(/<([A-Z0-9_]+)>([^<]*)<\/\1>/g)].map((m) => [m[1], m[2].replace(/&#4;\s*/g, "").trim()] as const);
  const wanted = scalars.filter(([k]) => /LOG|AUDIT|EDIT|VERSION|RELEASE|EDITION|PRODUCT/.test(k) && !/SERIAL|LICEN|EMAIL|PHONE|ADDRESS/.test(k));
  for (const [k, v] of wanted) {
    const show = /^(yes|no)$/i.test(v) ? v : v.length > 0 && v.length <= 40 && !/[@\\/]/.test(v) ? v : v ? "(set)" : "(empty)";
    console.log(`  ${k} = ${show}`);
  }
  if (!wanted.length) console.log("  no field of the Company object has a name that speaks of a log, audit, edit, release, version or edition");
  process.exit(0);
})().catch((e) => { console.error(`FAILED: ${(e as Error).message}`); process.exit(2); });
