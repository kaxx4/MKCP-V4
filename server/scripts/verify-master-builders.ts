/**
 * Stock item, unit and godown builders (rebuild batch 0.4).
 *
 *   npx tsx --env-file=server/.env server/scripts/verify-master-builders.ts          # shape only, no Tally
 *   npx tsx --env-file=server/.env server/scripts/verify-master-builders.ts --push   # dummy Tally: create, read back, delete
 *
 * The shape checks run first and need no Tally. The live part only runs on a
 * sandbox role against a local Tally (guardScriptWrites) and removes everything
 * it creates. Names are ZZ TEST so anything left behind is obvious.
 */
import { tallyPost, HEALTH_XML } from "../src/tally.js";
import { convertCompanies } from "../src/converters/convert.js";
import {
  buildStockItemXml, buildUnitXml, buildGodownXml,
  createStockItem, deleteStockItem, createUnit, deleteUnit, createGodown, deleteGodown,
} from "../src/services/masterPusher.js";
import { guardScriptWrites } from "../src/services/scriptWriteGuard.js";

const PUSH = process.argv.includes("--push");
if (PUSH) guardScriptWrites("verify-master-builders"); // #104

const U = process.env.TALLY_URL || "http://localhost:9000";
const STAMP = Date.now().toString().slice(-6);
let pass = 0, fail = 0;
const ok = (what: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${what}${detail ? "  — " + detail : ""}`);
  cond ? pass++ : fail++;
};

(async () => {
  console.log("\n  Shape (no Tally)");
  const item = buildStockItemXml({ name: "ZZ TEST ITEM", parent: "BICYCLE PARTS ( 87149990 )", baseUnit: "PC", gstRate: 18, hsn: "87149990" });
  ok("item GST sits inside a nested GSTDETAILS.LIST", /<GSTDETAILS\.LIST>[\s\S]*<STATEWISEDETAILS\.LIST>[\s\S]*<RATEDETAILS\.LIST>/.test(item));
  ok("item carries a dated block", /<APPLICABLEFROM>20260401<\/APPLICABLEFROM>/.test(item));
  ok("18% splits into 9 + 9 + 18", /CGST<\/GSTRATEDUTYHEAD>[\s\S]*?<GSTRATE>9</.test(item) && /IGST<\/GSTRATEDUTYHEAD>[\s\S]*?<GSTRATE>18</.test(item));
  ok("item has no flat GSTRATE outside the nested block", !/<\/GSTDETAILS\.LIST>[\s\S]*<GSTRATE>/.test(item));
  ok("unit carries its decimal places", /<DECIMALPLACES>0<\/DECIMALPLACES>/.test(buildUnitXml({ name: "ZZ U" })));
  ok("godown names itself", /<GODOWN NAME="ZZ G" ACTION="Create">/.test(buildGodownXml({ name: "ZZ G" })));
  ok("names are XML-escaped", /ZZ &amp; &lt;T&gt;/.test(buildGodownXml({ name: "ZZ & <T>" })));

  if (!PUSH) {
    console.log(`\n  ${pass} passed, ${fail} failed (live part skipped: pass --push)\n`);
    process.exit(fail ? 1 : 0);
  }

  const company = convertCompanies(await tallyPost(U, HEALTH_XML, 10_000))[0]!.name;
  console.log(`\n  Live, dummy company "${company}"`);
  const ITEM = `ZZ TEST ITEM ${STAMP}`, UNIT = `ZZUNIT${STAMP.slice(-3).replace(/\d/g, (d) => "ABCDEFGHIJ"[Number(d)])}`, GODOWN = `ZZ TEST GODOWN ${STAMP}`;

  const badUnit = await createUnit(U, company, { name: "ZZU1", decimals: 0 });
  ok("a unit name with a digit is refused before sending", !badUnit.ok && badUnit.requestXml === "", badUnit.notes.join(" "));
  const ghost = await deleteUnit(U, company, "ZZNOSUCHUNIT");
  ok("deleting a unit that is not there is not reported as a delete", !ghost.ok && ghost.requestXml === "", ghost.notes.join(" "));
  const u = await createUnit(U, company, { name: UNIT, decimals: 0 });
  ok("unit created and read back", u.ok, u.lineErrors.join("; ") || `created=${u.created}`);
  const g = await createGodown(U, company, { name: GODOWN });
  ok("godown created and read back", g.ok, g.lineErrors.join("; ") || `created=${g.created}`);
  const i = await createStockItem(U, company, { name: ITEM, parent: "BICYCLE PARTS ( 87149990 )", baseUnit: "PC", gstRate: 18, hsn: "87149990" });
  ok("stock item created, GST read back", i.ok, i.notes.join(" "));

  const di = await deleteStockItem(U, company, ITEM);
  ok("stock item deleted", di.ok, di.lineErrors.join("; "));
  const dg = await deleteGodown(U, company, GODOWN);
  ok("godown deleted", dg.ok, dg.lineErrors.join("; "));
  const du = await deleteUnit(U, company, UNIT);
  ok("unit deleted", du.ok, du.lineErrors.join("; "));

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
