/**
 * XML-P1 — every Tally XML builder and reader, proven offline.
 *
 * PURE — no Tally, no Supabase. The one socket opened is a throwaway HTTP
 * server on 127.0.0.1 that plays a Tally replying in UTF-16.
 *
 *   npx tsx server/scripts/test-xml-hardening.ts
 *
 * Fixtures are REAL shapes, anonymised:
 *   · fixtures/xml/on-account-payment.stored.xml — a ledger entry exactly as
 *     Tally stored it (server/data/push-fidelity-S1.stored.xml), party renamed.
 *   · the RESPONSE bodies below are copied verbatim from the archived
 *     push_queue failures (Sep-2026); they carry voucher numbers only.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  escapeXml, xmlSafeText, decodeXmlEntities, readTag, readAllTags, parseTallyAmount,
  parseImportResult, importVerdict, decodeTallyBody, tallyDate, fmtAmount, fmtQty, tdlString, TallyXmlError,
} from "../src/services/xml.ts";
import { buildVoucherImportXml, parseImportResponse } from "../src/services/voucherPusher.ts";
import { diffStored } from "../src/services/safePush.ts";
import { buildCollection, tagOf } from "../src/services/tallyRequest.ts";
import { buildCollectionXml, buildChangedVoucherXml } from "../src/services/xmlBuilder.ts";
import { money } from "../src/services/tallyReports.ts";
import { parsePriceList } from "../src/services/tallyPriceList.ts";
import { convertVouchers, convertLedgers, convertStockItems } from "../src/converters/convert.ts";
import { tallyPost } from "../src/tally.ts";
import { configureTallyLog } from "../src/services/tallyLog.ts";
import type { VoucherPayload } from "../src/types.ts";
import { join } from "node:path";

const FIXTURE = join(__dirname, "fixtures", "xml", "on-account-payment.stored.xml");

let pass = 0, fail = 0;
const ok = (what: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL  ${what}${detail ? " — " + detail : ""}`); }
};
const throwsTyped = (fn: () => unknown): boolean => { try { fn(); return false; } catch (e) { return e instanceof TallyXmlError; } };
const section = (s: string) => console.log(`\n  ${s}`);

configureTallyLog(`${process.env.TEMP ?? "/tmp"}/xml-hardening-tally-log.jsonl`);

// Deterministic PRNG so a failure reproduces.
let seed = 0x5eed1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const ALPHABET = [
  "A", "z", "0", " ", "&", "<", ">", '"', "'", ";", "#", "/", "=", "(", ")", "-", ".",
  "&amp;", "&lt;", "&#4;", "]]>", "<![CDATA[", "\t", "\n",
  "অ", "ক্ষ", "₹", "é", "中", "😀", "\u{1F6B2}", "‍",
  "\x00", "\x01", "\x04", "\x05", "\x1f", "\uFFFE", "\uD800", "\uDC00",
];
const randomString = (max = 24) => Array.from({ length: Math.floor(rnd() * max) }, () => pick(ALPHABET)).join("");

const fxp = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true, processEntities: true });

// ─────────────────────────────────────────────────────────────────────────────
section("escapeXml — every dangerous character, every type");
{
  ok("& < > \" ' all escaped", escapeXml(`A & B <c> "d" 'e'`) === "A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos;");
  ok("( Z ) survives", escapeXml("OLD PARTY ( Z )") === "OLD PARTY ( Z )");
  ok("Bengali and emoji pass through", escapeXml("অশোক 🚲") === "অশোক 🚲");
  ok("\\x04 is written as Tally writes it", escapeXml("\x04 Not Applicable") === "&#4; Not Applicable");
  ok("other control chars dropped", escapeXml("a\x00b\x01c\x1fd") === "abcd");
  ok("lone surrogate dropped (UTF-8 would turn it into U+FFFD)", escapeXml("x\uD800y") === "xy");
  ok("null/undefined → empty, never 'undefined'", escapeXml(undefined) === "" && escapeXml(null) === "");
  ok("NaN refused", throwsTyped(() => escapeXml(NaN)));
}

section("numbers and dates");
{
  ok("fmtAmount fixed 2dp", fmtAmount(1234.5) === "1234.50" && fmtAmount(-0) === "0.00");
  ok("fmtAmount refuses NaN/Infinity", throwsTyped(() => fmtAmount(NaN)) && throwsTyped(() => fmtAmount(Infinity)));
  ok("fmtQty never exponent", !/e/i.test(fmtQty(1e-7)) && fmtQty(9000) === "9000" && fmtQty(2.5) === "2.5");
  ok("date ISO → YYYYMMDD", tallyDate("2026-09-14") === "20260914" && tallyDate("20260914") === "20260914");
  ok("date '2026-9-1' refused (used to become 202691)", throwsTyped(() => tallyDate("2026-9-1")));
  ok("date 30-Feb refused", throwsTyped(() => tallyDate("2026-02-30")));
  ok("date garbage refused", throwsTyped(() => tallyDate("")) && throwsTyped(() => tallyDate("undefined")));
}

section("parseTallyAmount — every shape Tally writes");
{
  const cases: [string, number | null][] = [
    ["-1918494.24", -1918494.24], ["(-)5,000.00", -5000], ["(-) 5,000", -5000],
    ["3,79,56,526.73 Dr", -37956526.73], ["1,200.00 Cr", 1200], ["31320.00 UT = 87 PKG", 31320],
    ["8 PC =  2.00 PKG", 8], ["995.24/PC", 995.24], ["₹ 1,23,456", 123456], [" 104", 104],
    ["", null], ["abc", null], ["-", null], ["(-)", null],
  ];
  for (const [s, want] of cases) ok(`"${s}" → ${want}`, parseTallyAmount(s) === want, `got ${parseTallyAmount(s)}`);
  ok("report money(): (-) is negative (was positive)", money("(-)5,000.00") === -5000);
  ok("report money(): Cr stays negative by its own convention", money("1,200.00 Cr") === -1200 && money("1,200.00 Dr") === 1200);
}

section("decodeXmlEntities / readTag");
{
  ok("one pass: &amp;quot; is the TEXT &quot;", decodeXmlEntities("&amp;quot;") === "&quot;");
  ok("numeric + hex", decodeXmlEntities("&#65;&#x42;&#4;") === "AB\x04");
  ok("unknown entity left alone", decodeXmlEntities("&bogus; &#0;") === "&bogus; &#0;");
  ok("readTag decodes", readTag("<X><NAME>SALARY &amp; BONUS</NAME></X>", "NAME") === "SALARY & BONUS");
  ok("readTag self-closing is empty", readTag("<B><NAME/><BILLTYPE>On Account</BILLTYPE></B>", "NAME") === "");
  ok("readTag exact: NAME ≠ NAME.LIST", readTag(`<O><NAME.LIST TYPE="String"><NAME>X</NAME></NAME.LIST></O>`, "NAME") === "X");
  ok("readTag CDATA", readTag("<N><![CDATA[a<b&c]]></N>", "N") === "a<b&c");
  ok("readAllTags", readAllTags("<A><X>1</X><X/><X>2</X></A>", "X").join(",") === "1,,2");
  ok("tagOf decodes now", tagOf("<O><PARENT>A &amp; B</PARENT></O>", "PARENT") === "A & B");
}

section("decodeTallyBody — UTF-8, UTF-16LE/BE with and without BOM");
{
  const s = "<ENVELOPE><NAME>অ & ₹ 🚲</NAME></ENVELOPE>";
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(s, "utf16le").swap16()]);
  ok("UTF-8", decodeTallyBody(Buffer.from(s, "utf8")) === s);
  ok("UTF-8 BOM", decodeTallyBody(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s)])) === s);
  ok("UTF-16LE BOM", decodeTallyBody(le) === s);
  ok("UTF-16BE BOM", decodeTallyBody(be) === s);
  ok("UTF-16LE no BOM", decodeTallyBody(Buffer.from(s, "utf16le")) === s);
}

// ─────────────────────────────────────────────────────────────────────────────
section("ARCHIVED PUSH FAILURES (push_queue, Sep-2026) — each class");
const ARCHIVED = {
  duplicateNumber: "<RESPONSE>\r\n <LINEERROR>Voucher Number &apos;1920/26-27&apos; already exists!</LINEERROR>\r\n <CREATED>0</CREATED>\r\n <ALTERED>0</ALTERED>\r\n <DELETED>0</DELETED>\r\n <LASTVCHID>0</LASTVCHID>\r\n <LASTMID>0</LASTMID>\r\n <COMBINED>0</COMBINED>\r\n <IGNORED>0</IGNORED>\r\n <ERRORS>1</ERRORS>\r\n <CANCELLED>0</CANCELLED>\r\n <EXCEPTIONS>0</EXCEPTIONS>\r\n</RESPONSE>\r\n",
  silentException: "<RESPONSE>\r\n <CREATED>0</CREATED>\r\n <ALTERED>0</ALTERED>\r\n <DELETED>0</DELETED>\r\n <LASTVCHID>0</LASTVCHID>\r\n <LASTMID>0</LASTMID>\r\n <COMBINED>0</COMBINED>\r\n <IGNORED>0</IGNORED>\r\n <ERRORS>0</ERRORS>\r\n <CANCELLED>0</CANCELLED>\r\n <EXCEPTIONS>1</EXCEPTIONS>\r\n</RESPONSE>\r\n",
  alteredInPlace: "<RESPONSE>\r\n <CREATED>0</CREATED>\r\n <ALTERED>1</ALTERED>\r\n <DELETED>0</DELETED>\r\n <LASTVCHID>248296</LASTVCHID>\r\n <LASTMID>0</LASTMID>\r\n <COMBINED>0</COMBINED>\r\n <IGNORED>0</IGNORED>\r\n <ERRORS>0</ERRORS>\r\n <CANCELLED>0</CANCELLED>\r\n <EXCEPTIONS>0</EXCEPTIONS>\r\n</RESPONSE>\r\n",
  created: "<RESPONSE>\r\n <CREATED>1</CREATED>\r\n <ALTERED>0</ALTERED>\r\n <DELETED>0</DELETED>\r\n <LASTVCHID>248296</LASTVCHID>\r\n <LASTMID>0</LASTMID>\r\n <COMBINED>0</COMBINED>\r\n <IGNORED>0</IGNORED>\r\n <ERRORS>0</ERRORS>\r\n <CANCELLED>0</CANCELLED>\r\n <EXCEPTIONS>0</EXCEPTIONS>\r\n</RESPONSE>\r\n",
};
{
  const dup = parseImportResponse(ARCHIVED.duplicateNumber);
  ok("class 1 duplicate number: failure", !dup.success);
  ok("class 1 LINEERROR decoded (was 'Voucher Number &apos;1920…')", dup.lineErrors[0] === "Voucher Number '1920/26-27' already exists!", dup.lineErrors[0]);
  const exc = parseImportResponse(ARCHIVED.silentException);
  ok("class 2 EXCEPTIONS=1 with no text: failure", !exc.success && exc.exceptions === 1);
  ok("class 3 Create → altered in place: success (stable REMOTEID)", parseImportResponse(ARCHIVED.alteredInPlace, "Create").success);
  ok("class 3 Alter → altered: success", parseImportResponse(ARCHIVED.alteredInPlace, "Alter").success);
  ok("Alter → CREATED: failure (duplicate)", !parseImportResponse(ARCHIVED.created, "Alter").success);
  ok("Delete → created: failure", !parseImportResponse(ARCHIVED.created, "Delete").success);
  ok("empty body: failure, typed message", !parseImportResponse("").success && parseImportResponse("").lineErrors.length === 1);
  ok("DELETED=1 beside a LINEERROR: failure", !importVerdict(parseImportResult("<RESPONSE><DELETED>1</DELETED><LINEERROR>x</LINEERROR></RESPONSE>"), "Delete").ok);
}
{
  // Class 4 — "bill ref On Account … NOT STORED". The read-back matched the
  // allocation by NAME; Tally stores On Account with <NAME/>.
  const stored = readFileSync(FIXTURE, "utf8");
  const voucher = /<VOUCHER\b[\s\S]*<\/VOUCHER>/.exec(stored)![0];
  const payload: VoucherPayload = {
    voucherType: "Payment", date: "2026-09-17", voucherNumber: "CLAUDE-TEST/1", isInvoice: false,
    partyLedgerName: "TEST PARTY & SONS (TOWN)",
    ledgerEntries: [
      { ledgerName: "TEST PARTY & SONS (TOWN)", amount: 500, isDeemedPositive: true, isPartyLedger: true,
        billAllocations: [{ name: "On Account", amount: 500, billType: "On Account" }] },
      { ledgerName: "HDFC BANK", amount: 500, isDeemedPositive: false, isPartyLedger: false },
    ],
  } as VoucherPayload;
  const diffs = diffStored(payload, voucher);
  ok("class 4 On Account stored as <NAME/> reads back as stored", diffs.length === 0, diffs.join("; "));
  const wrongAmt = diffStored({ ...payload, ledgerEntries: [{ ...payload.ledgerEntries[0], amount: 600, billAllocations: [{ name: "On Account", amount: 600, billType: "On Account" }] }, { ...payload.ledgerEntries[1], amount: 600 }] } as VoucherPayload, voucher);
  ok("…and a wrong amount is still caught", wrongAmt.length > 0);
  const agst = diffStored({ ...payload, ledgerEntries: [{ ...payload.ledgerEntries[0], billAllocations: [{ name: "26-27/0001", amount: 500, billType: "Agst Ref" }] }, payload.ledgerEntries[1]] } as VoucherPayload, voucher);
  ok("…and an Agst Ref Tally did not store is still caught", agst.some((d) => /NOT STORED|type sent/.test(d)), agst.join("; "));
}

// ─────────────────────────────────────────────────────────────────────────────
section("builders refuse what Tally would mis-read");
const basePayload = (over: Partial<VoucherPayload> = {}): VoucherPayload => ({
  voucherType: "Payment", date: "2026-09-17", voucherNumber: "CLAUDE-TEST/2", isInvoice: false,
  partyLedgerName: "TEST PARTY", narration: "n",
  ledgerEntries: [
    { ledgerName: "TEST PARTY", amount: 500, isDeemedPositive: true, isPartyLedger: true },
    { ledgerName: "HDFC BANK", amount: 500, isDeemedPositive: false, isPartyLedger: false },
  ],
  ...over,
} as VoucherPayload);
{
  ok("NaN amount refused (was written 'NaN')", throwsTyped(() => buildVoucherImportXml("CO", basePayload({
    ledgerEntries: [{ ledgerName: "A", amount: NaN, isDeemedPositive: true, isPartyLedger: true }, { ledgerName: "B", amount: NaN, isDeemedPositive: false, isPartyLedger: false }],
  } as Partial<VoucherPayload>))));
  ok("bad date refused (was '202691')", throwsTyped(() => buildVoucherImportXml("CO", basePayload({ date: "2026-9-1" }))));
  const x = buildVoucherImportXml("CO", basePayload({ narration: undefined, reference: undefined }));
  ok("absent fields omitted, never 'undefined'", !/undefined|NaN/.test(x) && !/<NARRATION>/.test(x));
  ok("TDL literal with a quote refused", throwsTyped(() => tdlString('FRAME 22"')));
  ok("TDL literal escaped", tdlString("A & B") === '"A &amp; B"');
  let threw = false;
  try { buildCollection({ id: "X", type: "Voucher", fetch: ["Name"], filter: { kind: "compare", expr: "$Name", cmp: "eq", value: 'A "B"' } }); } catch { threw = true; }
  ok("buildCollection refuses a quoted literal", threw);
  const f = buildCollection({ id: "X", type: "Voucher", fetch: ["Name"], filter: { kind: "compare", expr: "$AlterID", cmp: "gte", value: 5 } });
  ok("filter operators escaped (&gt;=)", f.includes("&gt;= 5") && !/[^&]>=/.test(f.replace(/<[^>]*>/g, "")));
  let t1 = false; try { buildCollectionXml({ tallyCollection: "ScenarioInfo", category: "master" } as never, "CO"); } catch { t1 = true; }
  ok("xmlBuilder refuses an unverified TYPE (modal + restart)", t1);
  let t2 = false; try { buildCollectionXml({ tallyCollection: "Voucher", category: "transaction", fetch: ["Date"] } as never, "CO", "2026-04-01x", "20260430"); } catch { t2 = true; }
  ok("xmlBuilder refuses a bad date (was '&gt;= NaN' → zero rows)", t2);
  ok("changed-since cursor is an integer", buildChangedVoucherXml({ tallyCollection: "Ledger", category: "master" } as never, "CO", 12.9).includes("$AlterID &gt; 12<"));
}

// ─────────────────────────────────────────────────────────────────────────────
section("FUZZ — random strings round-trip builder → parser unchanged (2,000 vouchers)");
{
  let rt = 0, wf = 0;
  for (let i = 0; i < 2000; i++) {
    const party = randomString(30) || "P";
    const narr = randomString(60);
    const num = randomString(12) || "N";
    const p = basePayload({
      partyLedgerName: party, narration: narr, voucherNumber: num,
      ledgerEntries: [
        { ledgerName: party, amount: Math.round(rnd() * 1e9) / 100, isDeemedPositive: true, isPartyLedger: true,
          billAllocations: [{ name: randomString(10) || "B", amount: 0, billType: "Agst Ref" }] },
        { ledgerName: "HDFC BANK", amount: 0, isDeemedPositive: false, isPartyLedger: false },
      ],
    } as Partial<VoucherPayload>);
    p.ledgerEntries[0].billAllocations![0].amount = p.ledgerEntries[0].amount;
    p.ledgerEntries[1].amount = p.ledgerEntries[0].amount;
    const xml = buildVoucherImportXml("M.K. & CO \"TEST\"", p);
    const v = XMLValidator.validate(xml.replace(/&#4;/g, "&#x2404;"));   // the validator rejects &#4; by spec; Tally writes it
    if (v === true) wf++; else console.log("   not well-formed:", JSON.stringify(v).slice(0, 200));
    const want = (s: string) => xmlSafeText(s).trim();
    const same =
      readTag(xml, "NARRATION") === want(narr) &&
      readTag(xml, "PARTYLEDGERNAME") === want(party) &&
      readTag(xml, "VOUCHERNUMBER") === want(num) &&
      readTag(/<BILLALLOCATIONS\.LIST>[\s\S]*?<\/BILLALLOCATIONS\.LIST>/.exec(xml)![0], "NAME") === want(p.ledgerEntries[0].billAllocations![0].name);
    // A second, independent parser (the converters' own) must read the same text.
    // fast-xml-parser leaves numeric references undecoded, so a value holding
    // \x04 or a literal "&#" is ambiguous to IT; those are compared by readTag only.
    const parsed = fxp.parse(xml);
    const vch = parsed.ENVELOPE.BODY.IMPORTDATA.REQUESTDATA.TALLYMESSAGE.VOUCHER;
    const fx = (t: unknown) => String(typeof t === "object" && t ? (t as Record<string, unknown>)["#text"] ?? "" : t ?? "");
    const plain = (s: string) => !/[\x04]|&#/.test(want(s));
    const same2 = (!plain(party) || fx(vch.PARTYLEDGERNAME) === want(party)) &&
      (want(narr) === "" || !plain(narr) || fx(vch.NARRATION) === want(narr));
    if (same && same2) rt++;
    else if (rt + 5 > i) console.log("   mismatch:", JSON.stringify({ party, narr, num }));
  }
  ok(`2000/2000 well-formed (got ${wf})`, wf === 2000);
  ok(`2000/2000 round-trip exactly (got ${rt})`, rt === 2000);
  ok("a string without control characters round-trips byte-identical",
    readTag(buildVoucherImportXml("CO", basePayload({ narration: `A & B "C" <D> 'E' অ 🚲` })), "NARRATION") === `A & B "C" <D> 'E' অ 🚲`);
}

section("FUZZ — malformed responses never throw (5,000 bodies)");
{
  const seeds = [...Object.values(ARCHIVED), readFileSync(FIXTURE, "utf8")];
  const mutate = (s: string): string => {
    switch (Math.floor(rnd() * 7)) {
      case 0: return s.slice(0, Math.floor(rnd() * s.length));                       // truncated mid-tag
      case 1: { const i = Math.floor(rnd() * s.length); return s.slice(0, i) + randomString(40) + s.slice(i); }
      case 2: return s.replace(/</g, () => (rnd() < 0.05 ? "" : "<"));               // dropped brackets
      case 3: return s.replace(/<\/[A-Z.]+>/g, (m) => (rnd() < 0.1 ? "" : m));        // unclosed tags
      case 4: return Buffer.from(Array.from({ length: 200 }, () => Math.floor(rnd() * 256))).toString("latin1");
      case 5: return s.replace(/\d/g, () => pick(["(-)", "Dr", ",", "1e309", "NaN", "\x04"]));
      default: return "";
    }
  };
  let threw = 0;
  const pay = basePayload();
  for (let i = 0; i < 5000; i++) {
    const body = mutate(pick(seeds));
    try {
      parseImportResponse(body, pick(["Create", "Alter", "Cancel", "Delete"] as const));
      importVerdict(parseImportResult(body));
      readTag(body, "NAME"); readAllTags(body, "AMOUNT"); parseTallyAmount(body.slice(0, 30));
      decodeTallyBody(Buffer.from(body, "latin1"));
      diffStored(pay, body);
      parsePriceList(body);
      money(body.slice(0, 20));
      let obj: unknown = null;
      try { obj = fxp.parse(body); } catch { /* the parser may refuse; tallyPost turns that into a typed error */ }
      convertVouchers(obj); convertLedgers(obj); convertStockItems(obj);
    } catch (e) {
      threw++;
      if (threw < 4) console.log("   threw:", (e as Error).message, JSON.stringify(body.slice(0, 120)));
    }
  }
  ok(`no reader threw on 5,000 malformed bodies (threw ${threw})`, threw === 0);
}

section("tallyPost over a real socket — UTF-16 reply, garbage reply");
void (async () => {
  const s = `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION><LEDGER NAME="X"><NAME>অশোক &amp; Co</NAME></LEDGER></COLLECTION></DATA></BODY></ENVELOPE>`;
  let reply: Buffer = Buffer.alloc(0);
  const srv = createServer((req, res) => { req.resume(); req.on("end", () => { res.end(reply); }); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    reply = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
    const raw = await tallyPost(url, "<ENVELOPE><HEADER><ID>T</ID></HEADER></ENVELOPE>", 5000, true);
    ok("UTF-16LE reply decoded to the same text", raw === s);
    const parsed = await tallyPost(url, "<ENVELOPE><HEADER><ID>T</ID></HEADER></ENVELOPE>", 5000, false);
    ok("UTF-16LE reply parses", JSON.stringify(parsed).includes("অশোক & Co"));
    reply = Buffer.from("<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><LINEERROR>Ledger &apos;X&apos; does not exist!</LINEERROR></BODY></ENVELOPE>");
    let msg = "";
    try { await tallyPost(url, "<ENVELOPE><HEADER><ID>T</ID></HEADER></ENVELOPE>", 5000, false); } catch (e) { msg = (e as Error).message; }
    ok("LINEERROR → typed rejection, text decoded", msg.includes("Ledger 'X' does not exist!"), msg);
    reply = Buffer.from("\x00\x01garbage<<<");
    let rej = false;
    try { await tallyPost(url, "<ENVELOPE><HEADER><ID>T</ID></HEADER></ENVELOPE>", 5000, false); } catch { rej = true; }
    ok("garbage → rejection, never a crash or an empty success", rej);
  } finally { srv.close(); }
})();

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
