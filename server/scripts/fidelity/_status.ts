/* Tally's documented failure envelope is STATUS=0 in the HEADER with a
   STATUS.LIST/CODE/DESC in the body. Nothing here has ever checked it.
   Can we produce one? Header-level nonsense only — an invalid collection TYPE
   raises a modal, a malformed header should not. */
import { tallyPost } from "../../src/tally.js";
import { U, company, esc } from "./harness.js";
(async () => {
  const co = await company();
  const cases: [string, string][] = [
    ["bad TALLYREQUEST", `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Frobnicate</TALLYREQUEST><TYPE>Data</TYPE><ID>Trial Balance</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC></BODY></ENVELOPE>`],
    ["missing ID",       `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC></BODY></ENVELOPE>`],
    ["unknown company",  `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>Trial Balance</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>NO SUCH COMPANY LTD</SVCURRENTCOMPANY></STATICVARIABLES></DESC></BODY></ENVELOPE>`],
    ["named collection", `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>List of Ledgers</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC></BODY></ENVELOPE>`],
  ];
  for (const [label, xml] of cases) {
    try {
      const res = await tallyPost(U, xml, 60_000, true) as string;
      const st = /<STATUS>(-?\d+)<\/STATUS>/.exec(res)?.[1] ?? "(none)";
      const code = /<CODE>([^<]*)<\/CODE>/.exec(res)?.[1];
      const desc = /<DESC>([^<]*)<\/DESC>/.exec(res)?.[1];
      const le = /<LINEERROR>([^<]*)/.exec(res)?.[1];
      console.log(`  ${label.padEnd(18)} STATUS=${st.padEnd(4)} bytes=${String(res.length).padStart(8)}${code?`  CODE=${code}`:""}${desc?`  DESC=${desc.slice(0,50)}`:""}${le?`  LINEERROR=${le.slice(0,40)}`:""}`);
    } catch (e) {
      console.log(`  ${label.padEnd(18)} threw: ${(e as Error).message.slice(0,70)}`);
    }
  }
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });
