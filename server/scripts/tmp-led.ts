import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import { tallyPost } from "../src/tally";
const COMPANY = process.env.TALLY_COMPANY || "M.K.CYCLES (P) LTD. - (from 1-Apr-26)";
const esc = (s: string) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>L</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="L" ISMODIFY="No"><TYPE>Ledger</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>Parent</NATIVEMETHOD></COLLECTION>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
(async () => {
  const res: string = await tallyPost("http://localhost:9000", xml, 120000, true);
  const names = [...res.matchAll(/<LEDGER[^>]*NAME="([^"]*)"/gi)].map(m => m[1]);
  console.log(`Tally ledgers: ${names.length}`);
  const hits = names.filter(n => /AMRIT/i.test(n));
  console.log("matching AMRIT:", hits.length ? hits.map(h => JSON.stringify(h)) : "NONE");
  const exact = names.find(n => n === "AMRIT SALES ( INDIA )");
  console.log("exact 'AMRIT SALES ( INDIA )':", exact ? "PRESENT" : "ABSENT");
})();
