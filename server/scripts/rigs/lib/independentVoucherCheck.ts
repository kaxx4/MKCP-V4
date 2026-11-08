/**
 * An independent reading of a voucher's raw Tally XML, compared with the tally-shaped block the mirror holds
 * (review of thread 8, item 13).
 *
 * Why it exists: until now only the parity check looked at block values, and parity compares the block with the
 * block (the views against tally_*), both of which come out of the same mapper. If the mapper turned a debit into a
 * credit, or dropped a quantity, every comparison would still agree. This file reads the XML itself, with its own
 * small tag reader and none of the converter's or the mapper's code, and says where the block differs.
 *
 * What it compares, per voucher:
 *  - the GUID, the date and the effective date (YYYYMMDD in Tally, ISO in the block), the number, the type,
 *    cancelled and optional flags, the place of supply, the e-way transport mode and (real runs) the distance;
 *  - every ledger line: its ledger name, whether it is a debit (ISDEEMEDPOSITIVE) and its signed amount in paise, as a set
 *    (a line whose sign flipped, whose amount changed or that moved to another ledger makes the two sets differ), and that a
 *    debit carries a negative amount;
 *  - every stock line: item name, quantity, billed quantity, rate, amount in paise and the deemed-positive flag, as a set;
 *  - the e-way bill number and validity, the IRN and its acknowledgement, the buyer name and the party GSTIN:
 *      real runs: the block holds what the XML holds (a buyer the XML has and the block lacks is a difference);
 *      test runs (the dummy is an old copy of the real books): the block holds NULL wherever the XML holds a value,
 *      because a test row may carry no personal field. A value in a test block is a leak and is reported.
 * Names are not compared on test runs (they are replaced by keyed stand-ins on purpose); the count of lines is, and the
 * lines are matched on sign, amount, quantity and rate alone there. On real runs the names are part of the line's key.
 *
 * Pure: no Tally, no database. The rig feeds it the raw reply of one day's read.
 */
export interface RawLine { name: string; debit: boolean | null; cents: number | null }
export interface RawStock { name: string; qty: number | null; billed: number | null; rate: number | null; cents: number | null; deemedPositive: boolean | null }
export interface RawVoucher {
  guid: string; date: string | null; effectiveDate: string | null; number: string; type: string; cancelled: boolean; optional: boolean;
  placeOfSupply: string; transportMode: string; distance: number | null;
  ewbNumber: string; ewbValidUntil: string; irn: string; irnAckNo: string; buyerNames: string[]; partyGstin: string;
  ledger: RawLine[]; stock: RawStock[];
}
export interface Block { voucher: Record<string, any>; ledger_entries: Record<string, any>[]; inventory_entries: Record<string, any>[] }

const unesc = (s: string): string =>
  s.replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The voucher elements of a reply. */
export function splitRawVouchers(xml: string): string[] {
  return [...xml.matchAll(/<VOUCHER(?:\s[^>]*)?>[\s\S]*?<\/VOUCHER>/g)].map((m) => m[0]);
}

/** Remove every nested `<X.LIST>...</X.LIST>` (any depth) from the inside of an element, leaving only its own direct tags. */
function ownTags(inner: string): string {
  let out = "", depth = 0, last = 0;
  for (const m of inner.matchAll(/<(\/?)([A-Za-z0-9_.]+\.LIST)\b[^>]*?(\/?)>/g)) {
    const closing = m[1] === "/", selfClosing = m[3] === "/";
    if (depth === 0) out += inner.slice(last, m.index);
    if (selfClosing) { /* an empty placeholder: nothing to enter */ }
    else if (closing) depth = Math.max(0, depth - 1);
    else depth += 1;
    last = (m.index ?? 0) + m[0].length;
    if (depth === 0) { /* resume after the tag that closed the outermost list */ }
  }
  if (depth === 0) out += inner.slice(last);
  return out;
}

/** The text of the first direct `<TAG>` of an element, entities decoded, trimmed; "" when absent. */
function tag(own: string, name: string): string {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(own);
  return m ? unesc(m[1]).trim() : "";
}

/** The `<NAME>` list blocks directly inside `inner` (not those nested deeper), as their inner text. */
function listBlocks(inner: string, name: string): string[] {
  const out: string[] = [];
  let depth = 0, start = -1;
  for (const m of inner.matchAll(/<(\/?)([A-Za-z0-9_.]+\.LIST)\b[^>]*?(\/?)>/g)) {
    const closing = m[1] === "/", selfClosing = m[3] === "/";
    if (selfClosing) continue;
    if (!closing) {
      if (depth === 0 && m[2] === name) start = (m.index ?? 0) + m[0].length;
      depth += 1;
    } else {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && m[2] === name && start >= 0) { out.push(inner.slice(start, m.index)); start = -1; }
    }
  }
  return out;
}

const yes = (s: string): boolean | null => (s === "" ? null : /^yes$/i.test(s));
/** A number from a Tally amount, quantity or rate: "-1,180.00", "2 nos", "500/nos", " 104". Null when there is none. */
export function numOf(s: string): number | null {
  const m = /-?\d[\d,]*(?:\.\d+)?|-?\.\d+/.exec(String(s ?? "").trim());
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
const paise = (n: number | null): number | null => (n === null ? null : Math.round(n * 100));
const isoOf = (s: string): string | null => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);

/** Read one `<VOUCHER>` element. */
export function parseRawVoucher(block: string): RawVoucher {
  const open = /^<VOUCHER(?:\s[^>]*)?>/.exec(block)?.[0] ?? "";
  const inner = block.slice(open.length, block.length - "</VOUCHER>".length);
  const own = ownTags(inner);
  const attr = (n: string) => new RegExp(`\\b${n}="([^"]*)"`).exec(open)?.[1] ?? "";
  const ewb = listBlocks(inner, "EWAYBILLDETAILS.LIST")[0] ?? "";
  const ewbOwn = ownTags(ewb);
  let mode = "", dist: number | null = null;
  for (const td of listBlocks(ewb, "TRANSPORTDETAILS.LIST")) {
    const t = ownTags(td);
    mode = tag(t, "TRANSPORTMODE") || mode;
    dist = numOf(tag(t, "DISTANCE")) ?? dist;
  }
  const lines = [...listBlocks(inner, "ALLLEDGERENTRIES.LIST"), ...listBlocks(inner, "LEDGERENTRIES.LIST")];
  const stock = [...listBlocks(inner, "ALLINVENTORYENTRIES.LIST"), ...listBlocks(inner, "INVENTORYENTRIES.LIST")];
  return {
    guid: tag(own, "GUID") || attr("GUID"),
    date: isoOf(tag(own, "DATE")), effectiveDate: isoOf(tag(own, "EFFECTIVEDATE") || tag(own, "DATE")),
    number: tag(own, "VOUCHERNUMBER"), type: tag(own, "VOUCHERTYPENAME") || attr("VCHTYPE"),
    cancelled: tag(own, "ISCANCELLED") === "Yes", optional: tag(own, "ISOPTIONAL") === "Yes",
    placeOfSupply: tag(own, "PLACEOFSUPPLY"), transportMode: mode, distance: dist,
    ewbNumber: tag(ewbOwn, "BILLNUMBER"), ewbValidUntil: tag(ewbOwn, "VALIDUPTO"),
    irn: tag(own, "IRN"), irnAckNo: tag(own, "IRNACKNO"),
    buyerNames: [tag(own, "PARTYMAILINGNAME"), tag(own, "BASICBUYERNAME")].filter(Boolean), partyGstin: tag(own, "PARTYGSTIN"),
    ledger: lines.map((l) => { const t = ownTags(l); return { name: tag(t, "LEDGERNAME"), debit: yes(tag(t, "ISDEEMEDPOSITIVE")), cents: paise(numOf(tag(t, "AMOUNT"))) }; }),
    stock: stock.map((l) => { const t = ownTags(l); return {
      name: tag(t, "STOCKITEMNAME"), qty: numOf(tag(t, "ACTUALQTY")), billed: numOf(tag(t, "BILLEDQTY")), rate: numOf(tag(t, "RATE")), cents: paise(numOf(tag(t, "AMOUNT"))), deemedPositive: yes(tag(t, "ISDEEMEDPOSITIVE")),
    }; }),
  };
}

const keyOf = (...p: unknown[]) => p.map((x) => (x === null || x === undefined ? "~" : String(x))).join("|");
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/**
 * The differences between one raw voucher and its block, as sentences (empty = they agree). `test` is true for a test
 * run, where personal fields must be null in the block.
 */
export function compareRawToBlock(raw: RawVoucher, blk: Block | null | undefined, o: { test: boolean }): string[] {
  const d: string[] = [];
  const tag4 = `${raw.number || raw.guid}`;
  if (!blk) return [`${tag4}: the swap store holds no block for this voucher`];
  const v = blk.voucher;
  const eq = (what: string, a: unknown, b: unknown) => { if ((a ?? null) !== (b ?? null)) d.push(`${tag4}: ${what} is ${JSON.stringify(b ?? null)} in the block and ${JSON.stringify(a ?? null)} in the XML`); };
  eq("guid", raw.guid, v.guid);
  eq("date", raw.date, v.date);
  eq("effective date", raw.effectiveDate, v.effective_date);
  eq("voucher number", raw.number || null, v.voucher_number || null);
  eq("voucher type", raw.type || null, v.voucher_type || null);
  eq("is cancelled", raw.cancelled, v.is_cancelled);
  eq("is optional", raw.optional, v.is_optional);
  eq("place of supply", raw.placeOfSupply || null, v.place_of_supply || null);
  eq("transport mode", raw.transportMode || null, v.transport_mode || null);
  /* the distance is worked out from the addresses, so a test block holds none (migration 0138) */
  if (o.test) { if (v.transport_distance_km !== null && v.transport_distance_km !== undefined) d.push(`${tag4}: transport distance is filled in a TEST block (a personal field leaked)`); }
  else eq("transport distance", raw.distance, v.transport_distance_km === null || v.transport_distance_km === undefined ? null : numOf(String(v.transport_distance_km)));

  // ledger lines: a set of (ledger name on a real run, is a debit, signed paise)
  const nm = (x: unknown) => (o.test ? "" : String(x ?? "").trim());
  const rl = raw.ledger.map((l) => keyOf(nm(l.name), l.debit === true, l.cents));
  const bl = blk.ledger_entries.map((l) => keyOf(nm(l.ledger_name), l.is_debit === true, paise(numOf(String(l.amount ?? "")))));
  if (raw.ledger.length !== blk.ledger_entries.length) d.push(`${tag4}: ${blk.ledger_entries.length} ledger line(s) in the block and ${raw.ledger.length} in the XML`);
  else if (!sameSet(rl, bl)) d.push(`${tag4}: the ledger lines differ in ledger, sign or amount (block ${[...bl].sort().join(", ")}; XML ${[...rl].sort().join(", ")})`);
  for (const l of blk.ledger_entries) { const c = paise(numOf(String(l.amount ?? ""))); if (l.is_debit === true && (c ?? 0) > 0) d.push(`${tag4}: the block has a debit line with a positive amount`); }

  // stock lines: a set of (item name on a real run, qty, billed qty, rate, paise, deemed positive)
  const rs = raw.stock.map((s) => keyOf(nm(s.name), s.qty, s.billed, s.rate, s.cents, s.deemedPositive === true));
  const bs = blk.inventory_entries.map((s) => keyOf(nm(s.stock_item_name), numOf(String(s.actual_qty ?? "")), numOf(String(s.billed_qty ?? "")), numOf(String(s.rate ?? "")), paise(numOf(String(s.amount ?? ""))), s.is_deemed_positive === true));
  if (raw.stock.length !== blk.inventory_entries.length) d.push(`${tag4}: ${blk.inventory_entries.length} stock line(s) in the block and ${raw.stock.length} in the XML`);
  else if (!sameSet(rs, bs)) d.push(`${tag4}: the stock lines differ in item, quantity, rate, amount or sign (block ${[...bs].sort().join(", ")}; XML ${[...rs].sort().join(", ")})`);

  // e-way bill, IRN, buyer, party GSTIN
  const personal: [string, string, unknown][] = [
    ["e-way bill number", raw.ewbNumber, v.ewb_number], ["e-way bill validity", raw.ewbValidUntil, v.ewb_valid_until],
    ["IRN", raw.irn, v.irn], ["IRN acknowledgement number", raw.irnAckNo, v.irn_ack_no], ["party GSTIN", raw.partyGstin, v.party_gstin],
  ];
  for (const [what, xml, blockVal] of personal) {
    const has = blockVal !== null && blockVal !== undefined && String(blockVal) !== "";
    if (o.test) { if (has) d.push(`${tag4}: ${what} is filled in a TEST block (a personal field leaked)`); }
    else if (xml === "" ? has : String(blockVal ?? "").trim() !== xml) d.push(`${tag4}: ${what} is ${has ? "different" : "empty"} in the block (XML ${xml === "" ? "empty" : "has a value"})`);
  }
  const hasBuyer = v.buyer_name !== null && v.buyer_name !== undefined && String(v.buyer_name) !== "";
  if (o.test) { if (hasBuyer) d.push(`${tag4}: buyer name is filled in a TEST block (a personal field leaked)`); }
  else if (raw.buyerNames.length && !hasBuyer) d.push(`${tag4}: buyer name is empty in the block and the XML has one`);
  else if (raw.buyerNames.length && hasBuyer && !raw.buyerNames.includes(String(v.buyer_name).trim())) d.push(`${tag4}: buyer name in the block is not one the XML holds`);
  return d;
}

/** Pick up to `n` vouchers for the check: a spread across the reply, always including one with stock lines and one with several ledger lines when the reply has them. */
export function pickForCheck(raws: RawVoucher[], n: number): RawVoucher[] {
  const out: RawVoucher[] = [];
  const add = (r?: RawVoucher) => { if (r && !out.includes(r) && out.length < n) out.push(r); };
  add(raws.find((r) => r.stock.length > 0));
  add(raws.find((r) => r.ledger.length >= 3));
  add(raws.find((r) => r.cancelled));
  add(raws.find((r) => r.ewbNumber || r.irn));
  const step = Math.max(1, Math.floor(raws.length / n));
  for (let i = 0; i < raws.length && out.length < n; i += step) add(raws[i]);
  for (const r of raws) add(r);
  return out;
}
