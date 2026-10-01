/**
 * CASH-P1 — does the real buyer on a counter sale survive Tally → converter →
 * mirror row? OFFLINE: never opens a socket to Tally or Supabase.
 *
 * Responses are replayed through the MOCK transport, so they pass the same
 * tallyPost → XMLParser → convertVouchers path production uses; only the
 * socket is replaced.
 *
 * Two kinds of input, labelled because they prove different things:
 *
 *   HAND-BUILT  fixtures below. Fictitious names and towns, shaped on real
 *               voucher 26-27/0654 (tags, TYPE attributes, empty PARTYPINCODE,
 *               no BASICBUYERADDRESS). Always run.
 *   CAPTURED    server/data/native-shape/*.explicit.xml — real vouchers read
 *               from live Tally on 23-Sep-2026 by probe-native-sales-shape.ts.
 *               Gitignored (real party data), so they run only where present,
 *               and are asserted STRUCTURALLY (buyer = whatever the raw tag
 *               says) so no real name is written into this file.
 *
 *   npx tsx server/scripts/test-cash-buyer-converter.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

// Never a live client, whatever the shell carries.
delete process.env.SUPABASE_SERVICE_KEY;

import { tallyPost } from "../src/tally.js";
import { installMock, uninstallMock } from "../src/services/tallyMock.js";
import { configureTallyLog } from "../src/services/tallyLog.js";
import { convertVouchers, extractVoucherBuyer } from "../src/converters/convert.js";
import { TRANSACTION_COLLECTIONS } from "../src/config/collections.js";
import { buildCollectionXml } from "../src/services/xmlBuilder.js";
import { SupabaseSync } from "../src/services/supabaseSync.js";

const here = dirname(fileURLToPath(import.meta.url));
configureTallyLog(join(tmpdir(), "mkcp-test-cash-buyer-tally-log.jsonl"));

let passed = 0, failed = 0;
const ok = (what: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`  ok    ${what}`); }
  else { failed++; console.log(`  FAIL  ${what}${detail ? "  — " + detail : ""}`); }
};
const eq = (what: string, got: unknown, want: unknown) =>
  ok(what, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const envelope = (vouchers: string) =>
  `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DESC></DESC><DATA><COLLECTION>` +
  vouchers + `</COLLECTION></DATA></BODY></ENVELOPE>`;

/** Replay `body` as Tally's answer and run the production converter over it. */
async function convert(body: string): Promise<any[]> {
  installMock(async () => body);
  try {
    const parsed = await tallyPost("http://mock.invalid", buildCollectionXml(TRANSACTION_COLLECTIONS[0], "TEST CO", "20260905", "20260905"));
    return convertVouchers(parsed).tallymessage;
  } finally {
    uninstallMock();
  }
}

// ── HAND-BUILT fixtures (fictitious; shaped on real 26-27/0654) ─────────────
const HB_CASH_SINGLE_LINE = `<VOUCHER REMOTEID="hb-1" VCHTYPE="SALES" OBJVIEW="Invoice Voucher View">
 <ADDRESS.LIST TYPE="String"><ADDRESS>SAMPLEGRAM</ADDRESS></ADDRESS.LIST>
 <DATE TYPE="Date">20260905</DATE><GUID>hb-guid-1</GUID>
 <STATENAME TYPE="String">West Bengal</STATENAME>
 <VOUCHERTYPENAME>SALES</VOUCHERTYPENAME>
 <PARTYNAME TYPE="String">Cash</PARTYNAME><PARTYLEDGERNAME TYPE="String">Cash</PARTYLEDGERNAME>
 <VOUCHERNUMBER>HB/0001</VOUCHERNUMBER>
 <BASICBUYERNAME TYPE="String">Cash</BASICBUYERNAME>
 <PARTYMAILINGNAME TYPE="String">EXAMPLE CYCLE HOUSE</PARTYMAILINGNAME>
 <PARTYPINCODE TYPE="String"></PARTYPINCODE>
 <ALTERID> 101</ALTERID>
</VOUCHER>`;

const HB_CASH_MULTI_LINE_PIN_IN_TEXT = `<VOUCHER REMOTEID="hb-2" VCHTYPE="SALES">
 <ADDRESS.LIST TYPE="String"><ADDRESS>12 TEST BAZAR ROAD</ADDRESS><ADDRESS>DEMOPUR-700999</ADDRESS><ADDRESS>(PAN: ABCDE1234F)</ADDRESS></ADDRESS.LIST>
 <DATE TYPE="Date">20260905</DATE><GUID>hb-guid-2</GUID>
 <STATENAME TYPE="String">West Bengal</STATENAME>
 <VOUCHERTYPENAME>SALES</VOUCHERTYPENAME>
 <PARTYLEDGERNAME TYPE="String">Cash</PARTYLEDGERNAME><VOUCHERNUMBER>HB/0002</VOUCHERNUMBER>
 <BASICBUYERNAME TYPE="String">Cash</BASICBUYERNAME>
 <PARTYMAILINGNAME TYPE="String">SAMPLE &amp; SONS</PARTYMAILINGNAME>
</VOUCHER>`;

/** No mailing name at all: the buyer is unknown, NOT "Cash". */
const HB_CASH_ANONYMOUS = `<VOUCHER REMOTEID="hb-3" VCHTYPE="SALES">
 <DATE TYPE="Date">20260905</DATE><GUID>hb-guid-3</GUID>
 <VOUCHERTYPENAME>SALES</VOUCHERTYPENAME>
 <PARTYLEDGERNAME TYPE="String">Cash</PARTYLEDGERNAME><VOUCHERNUMBER>HB/0003</VOUCHERNUMBER>
 <BASICBUYERNAME TYPE="String">Cash</BASICBUYERNAME>
 <PARTYMAILINGNAME TYPE="String">Cash</PARTYMAILINGNAME>
</VOUCHER>`;

/** Registered party: PARTYPINCODE set, ship-to only in BASICBUYERADDRESS. */
const HB_PARTY_SHIPTO_ONLY = `<VOUCHER REMOTEID="hb-4" VCHTYPE="SALES">
 <BASICBUYERADDRESS.LIST TYPE="String"><BASICBUYERADDRESS>MOCKNAGAR</BASICBUYERADDRESS></BASICBUYERADDRESS.LIST>
 <DATE TYPE="Date">20260905</DATE><GUID>hb-guid-4</GUID>
 <STATENAME TYPE="String">Odisha</STATENAME>
 <VOUCHERTYPENAME>SALES</VOUCHERTYPENAME>
 <PARTYLEDGERNAME TYPE="String">FAKE TRADERS (MOCKNAGAR)</PARTYLEDGERNAME><VOUCHERNUMBER>HB/0004</VOUCHERNUMBER>
 <BASICBUYERNAME TYPE="String">FAKE TRADERS (MOCKNAGAR)</BASICBUYERNAME>
 <PARTYPINCODE TYPE="String">756000</PARTYPINCODE>
</VOUCHER>`;

/** A pre-CASH-P1 payload: none of the new tags. Everything null, nothing throws. */
const HB_NO_BUYER_TAGS = `<VOUCHER VCHTYPE="Receipt">
 <DATE TYPE="Date">20260905</DATE><GUID>hb-guid-5</GUID>
 <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>HB/0005</VOUCHERNUMBER>
</VOUCHER>`;

async function main(): Promise<void> {
  console.log("\n  CASH-P1 — the buyer behind a Cash bill\n  " + "─".repeat(62));

  console.log("\n  fetch list");
  const fetch = TRANSACTION_COLLECTIONS[0].fetch ?? [];
  for (const f of ["PartyMailingName", "Address", "PartyPincode", "StateName", "BasicBuyerName", "BasicBuyerAddress"]) {
    ok(`voucher fetch names ${f}`, fetch.includes(f));
  }
  ok("no wildcard crept into the voucher fetch list", !fetch.some((f) => f.includes("*")));
  const req = buildCollectionXml(TRANSACTION_COLLECTIONS[0], "TEST CO", "20260905", "20260905");
  ok("request XML carries <NATIVEMETHOD>PartyMailingName</NATIVEMETHOD>", req.includes("<NATIVEMETHOD>PartyMailingName</NATIVEMETHOD>"));

  console.log("\n  HAND-BUILT fixtures (fictitious, shaped on 26-27/0654)");
  const vs = await convert(envelope(HB_CASH_SINGLE_LINE + HB_CASH_MULTI_LINE_PIN_IN_TEXT + HB_CASH_ANONYMOUS + HB_PARTY_SHIPTO_ONLY + HB_NO_BUYER_TAGS));
  eq("five vouchers converted", vs.length, 5);
  const by = (n: string) => vs.find((v) => v.vouchernumber === n)?.buyer;

  eq("single-line Cash: name from PARTYMAILINGNAME, not BASICBUYERNAME", by("HB/0001"), {
    buyer_name: "EXAMPLE CYCLE HOUSE", buyer_address: "SAMPLEGRAM", buyer_pincode: null,
    buyer_pincode_source: null, buyer_place: "SAMPLEGRAM", buyer_state: "West Bengal",
  });
  eq("multi-line Cash: lines joined, PIN from text, PAN line skipped for place", by("HB/0002"), {
    buyer_name: "SAMPLE & SONS", buyer_address: "12 TEST BAZAR ROAD, DEMOPUR-700999, (PAN: ABCDE1234F)",
    buyer_pincode: "700999", buyer_pincode_source: "address", buyer_place: "DEMOPUR", buyer_state: "West Bengal",
  });
  eq("anonymous Cash: buyer is NULL, never \"Cash\"", by("HB/0003")?.buyer_name, null);
  eq("party ledger: ship-to used only as fallback, PARTYPINCODE wins", by("HB/0004"), {
    buyer_name: "FAKE TRADERS (MOCKNAGAR)", buyer_address: "MOCKNAGAR", buyer_pincode: "756000",
    buyer_pincode_source: "tally", buyer_place: "MOCKNAGAR", buyer_state: "Odisha",
  });
  eq("no buyer tags at all: every field null", by("HB/0005"), {
    buyer_name: null, buyer_address: null, buyer_pincode: null,
    buyer_pincode_source: null, buyer_place: null, buyer_state: null,
  });
  eq("undefined voucher does not throw", extractVoucherBuyer(undefined).buyer_name, null);
  eq("GSTIN digits are not mistaken for a PIN",
    extractVoucherBuyer({ "ADDRESS.LIST": { ADDRESS: ["GSTIN 19AADCM6953C1ZE", "TOWNPUR"] } }).buyer_pincode, null);
  eq("spaced PIN \"743 502\" is read", extractVoucherBuyer({ "ADDRESS.LIST": { ADDRESS: "TOWNPUR 743 502" } }).buyer_pincode, "743502");

  console.log("\n  mirror row (SupabaseSync.mapVoucher, no client)");
  const sync = new SupabaseSync() as any;
  const row = sync.mapVoucher(vs.find((v) => v.vouchernumber === "HB/0002"), "TEST CO");
  eq("row carries buyer_name", row.buyer_name, "SAMPLE & SONS");
  eq("row carries buyer_pincode + source", [row.buyer_pincode, row.buyer_pincode_source], ["700999", "address"]);
  const empty = sync.mapVoucher(vs.find((v) => v.vouchernumber === "HB/0005"), "TEST CO");
  const keys = ["buyer_name", "buyer_address", "buyer_pincode", "buyer_pincode_source", "buyer_place", "buyer_state"];
  ok("every buyer_* key present even when empty (one PostgREST column list per batch)",
    keys.every((k) => k in empty && empty[k] === null));
  const legacy = sync.mapVoucher({ metadata: { type: "Voucher" }, guid: "g", date: "20260905", vouchernumber: "X" }, "TEST CO");
  ok("a cached pre-CASH-P1 message (no .buyer) still maps", keys.every((k) => legacy[k] === null));

  console.log("\n  mirror predates migration 043 (fake client, PGRST204)");
  const calls: string[][] = [];
  sync.client = {
    from: () => ({
      upsert: async (rows: any[]) => {
        calls.push(Object.keys(rows[0]));
        return Object.keys(rows[0]).some((k) => k.startsWith("buyer_"))
          ? { error: { message: "Could not find the 'buyer_address' column of 'tally_vouchers' in the schema cache" } }
          : { error: null };
      },
    }),
  };
  await sync.upsertVoucherBatch([row]);
  ok("retried without buyer_* and succeeded", calls.length === 2 && !calls[1].some((k) => k.startsWith("buyer_")));
  await sync.upsertVoucherBatch([row]);
  ok("later batches skip the doomed attempt", calls.length === 3 && !calls[2].some((k) => k.startsWith("buyer_")));
  sync.buyerColumnsMissing = false;
  sync.client = { from: () => ({ upsert: async () => ({ error: { message: "duplicate key value violates unique constraint" } }) }) };
  let threw = false;
  try { await sync.upsertVoucherBatch([row]); } catch { threw = true; }
  ok("any OTHER upsert error still propagates", threw);

  // ── SYNC-P4: party GST identity + consignee, fetch → converter → row ──────
  // The 1-Oct merge named PartyGSTIN / PlaceOfSupply / Consignee* in the
  // voucher fetch list. Each must reach a tally_vouchers column (migration
  // 025); a field fetched and then dropped is the G4/G7 defect in reverse.
  console.log("\n  party GST identity + consignee (SYNC-P4)");
  for (const f of ["PartyGSTIN", "PlaceOfSupply", "ConsigneeMailingName", "ConsigneeStateName", "ConsigneePinCode", "PartyPincode"]) {
    ok(`voucher fetch names ${f}`, fetch.includes(f));
    ok(`request XML carries <NATIVEMETHOD>${f}</NATIVEMETHOD>`, req.includes(`<NATIVEMETHOD>${f}</NATIVEMETHOD>`));
  }
  const HB_GST_PARTY = `<VOUCHER REMOTEID="hb-6" VCHTYPE="SALES">
 <DATE TYPE="Date">20260905</DATE><GUID>hb-guid-6</GUID>
 <VOUCHERTYPENAME>SALES</VOUCHERTYPENAME>
 <PARTYLEDGERNAME TYPE="String">FAKE TRADERS (MOCKNAGAR)</PARTYLEDGERNAME><VOUCHERNUMBER>HB/0006</VOUCHERNUMBER>
 <PARTYGSTIN TYPE="String">21ABCDE1234F1Z5</PARTYGSTIN>
 <PLACEOFSUPPLY TYPE="String">Odisha</PLACEOFSUPPLY>
 <CONSIGNEEMAILINGNAME TYPE="String">FAKE TRADERS GODOWN</CONSIGNEEMAILINGNAME>
 <CONSIGNEESTATENAME TYPE="String">Odisha</CONSIGNEESTATENAME>
 <CONSIGNEEPINCODE TYPE="String">756001</CONSIGNEEPINCODE>
 <PARTYPINCODE TYPE="String">756000</PARTYPINCODE>
</VOUCHER>`;
  /** No consignee pincode: the header's PARTYPINCODE is the fallback. */
  const HB_GST_PIN_FALLBACK = `<VOUCHER REMOTEID="hb-7" VCHTYPE="SALES">
 <DATE TYPE="Date">20260905</DATE><GUID>hb-guid-7</GUID>
 <VOUCHERTYPENAME>SALES</VOUCHERTYPENAME>
 <PARTYLEDGERNAME TYPE="String">FAKE TRADERS (MOCKNAGAR)</PARTYLEDGERNAME><VOUCHERNUMBER>HB/0007</VOUCHERNUMBER>
 <PARTYGSTIN TYPE="String">21ABCDE1234F1Z5</PARTYGSTIN>
 <PLACEOFSUPPLY TYPE="String">Odisha</PLACEOFSUPPLY>
 <PARTYPINCODE TYPE="String">756000</PARTYPINCODE>
</VOUCHER>`;
  const gv = await convert(envelope(HB_GST_PARTY + HB_GST_PIN_FALLBACK + HB_NO_BUYER_TAGS));
  const gt = (n: string) => gv.find((v) => v.vouchernumber === n)?.transport;
  eq("converter: PARTYGSTIN → transport.party_gstin", gt("HB/0006")?.party_gstin, "21ABCDE1234F1Z5");
  eq("converter: PLACEOFSUPPLY → transport.place_of_supply", gt("HB/0006")?.place_of_supply, "Odisha");
  eq("converter: CONSIGNEEMAILINGNAME → consignee_place (no e-way bill)", gt("HB/0006")?.consignee_place, "FAKE TRADERS GODOWN");
  eq("converter: CONSIGNEESTATENAME → consignee_state", gt("HB/0006")?.consignee_state, "Odisha");
  eq("converter: CONSIGNEEPINCODE preferred over PARTYPINCODE", gt("HB/0006")?.consignee_pincode, "756001");
  eq("converter: PARTYPINCODE is the consignee_pincode fallback", gt("HB/0007")?.consignee_pincode, "756000");
  const grow = sync.mapVoucher(gv.find((v) => v.vouchernumber === "HB/0006"), "TEST CO");
  eq("mirror row: party_gstin / place_of_supply / consignee_* columns",
    [grow.party_gstin, grow.place_of_supply, grow.consignee_place, grow.consignee_state, grow.consignee_pincode],
    ["21ABCDE1234F1Z5", "Odisha", "FAKE TRADERS GODOWN", "Odisha", "756001"]);
  const gempty = sync.mapVoucher(gv.find((v) => v.vouchernumber === "HB/0005"), "TEST CO");
  ok("every GST/consignee key present (null) on a voucher without them",
    ["party_gstin", "place_of_supply", "consignee_place", "consignee_state", "consignee_pincode"].every((k) => k in gempty && gempty[k] === null));

  // ── CAPTURED real vouchers (gitignored; run where present) ────────────────
  const dir = join(here, "..", "data", "native-shape");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".explicit.xml")) : [];
  console.log(`\n  CAPTURED live vouchers (${files.length} in data/native-shape)`);
  if (files.length === 0) console.log("  skip  none on this machine — hand-built fixtures above still ran");
  const raw1 = (x: string, t: string) => new RegExp(`<${t}(?:\\s[^>]*)?>([^<]*)</${t}>`).exec(x)?.[1]?.trim() ?? "";
  const lines = (x: string, t: string) => {
    const b = [...x.matchAll(new RegExp(`<${t}\\.LIST[^>]*>([\\s\\S]*?)</${t}\\.LIST>`, "g"))]
      .map((m) => [...m[1].matchAll(new RegExp(`<${t}>([^<]*)</${t}>`, "g"))].map((l) => l[1].trim()).filter(Boolean))
      .find((l) => l.length);
    return b ?? [];
  };
  for (const f of files) {
    const xml = readFileSync(join(dir, f), "utf8");
    const [v] = await convert(envelope(xml));
    const b = v?.buyer;
    const party = raw1(xml, "PARTYLEDGERNAME");
    const mail = raw1(xml, "PARTYMAILINGNAME");
    const addr = lines(xml, "ADDRESS").length ? lines(xml, "ADDRESS") : lines(xml, "BASICBUYERADDRESS");
    const tag = `${f.replace(".explicit.xml", "")}${/^cash$/i.test(party) ? " [Cash]" : ""}`;
    ok(`${tag}: converted`, !!b);
    if (!b) continue;
    ok(`${tag}: buyer_name = raw PARTYMAILINGNAME`, b.buyer_name === (mail || null), `got ${b.buyer_name === null ? "null" : "a different value"}`);
    if (/^cash$/i.test(party)) ok(`${tag}: a Cash bill resolves to a buyer other than "Cash"`, !!b.buyer_name && !/^cash$/i.test(b.buyer_name));
    ok(`${tag}: buyer_address = raw address lines`, (b.buyer_address ?? "") === addr.join(", "));
    ok(`${tag}: buyer_state = raw STATENAME`, (b.buyer_state ?? "") === raw1(xml, "STATENAME"));
    const pin = raw1(xml, "PARTYPINCODE");
    if (pin) ok(`${tag}: buyer_pincode = raw PARTYPINCODE`, b.buyer_pincode === pin && b.buyer_pincode_source === "tally");
    // SYNC-P4: the GST identity reaches the row exactly as Tally sent it.
    const row = sync.mapVoucher(v, "TEST CO");
    const gstin = raw1(xml, "PARTYGSTIN"), pos = raw1(xml, "PLACEOFSUPPLY");
    if (gstin) ok(`${tag}: row.party_gstin = raw PARTYGSTIN`, row.party_gstin === gstin);
    if (pos) ok(`${tag}: row.place_of_supply = raw PLACEOFSUPPLY`, row.place_of_supply === pos);
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("ERR:", e); process.exit(1); });
