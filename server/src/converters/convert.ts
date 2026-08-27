// ─────────────────────────────────────────────────────────────────────
// Convert parsed Tally XML → { tallymessage: [...] } format
// masterParser.ts expects: { metadata: { type: "Stock Item" }, name, parent, baseunits, ... }
// transactionParser.ts expects: { metadata: { type: "Voucher" }, date, vouchertypename, ... }
// ─────────────────────────────────────────────────────────────────────

function arr(v: any): any[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

/**
 * Extract text value from a Tally typed-object or plain value.
 * Tally Collection exports return typed objects like:
 *   { "#text": "&#4; Primary", "@_TYPE": "String" }
 *   { "#text": "14 PC", "@_TYPE": "Quantity" }
 *   { "@_TYPE": "Rate" }  ← empty value
 * This function extracts the #text and strips the &#4; control char prefix.
 */
function txt(v: any, fallback = ""): string {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") return stripCtrl(v) || fallback;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object" && "#text" in v) {
    return stripCtrl(String(v["#text"] ?? "")) || fallback;
  }
  return fallback;
}

/** Strip &#4; / \x04 (EOT control char) that Tally uses as prefix for some values */
function stripCtrl(s: string): string {
  return s.replace(/&#\d+;\s*/g, "").replace(/[\x00-\x1f]\s*/g, "").trim();
}

/** Pick a node under either the bare key or Tally's `KEY.LIST` spelling. */
function listOf(obj: any, key: string): any[] {
  if (!obj || typeof obj !== "object") return [];
  return arr(obj[`${key}.LIST`] ?? obj[key]);
}

/**
 * Parse a Tally numeric that may carry padding or a unit suffix.
 * The e-way bill DISTANCE arrives as `" 104"` — leading space, sometimes an
 * empty string. Returns null rather than 0 for "absent", so a missing distance
 * is never mistaken for a zero-kilometre trip.
 */
function num(v: any): number | null {
  const t = txt(v).replace(/[^\d.\-]/g, "");
  if (!t) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

export interface VoucherTransport {
  ewb_number: string | null;
  ewb_valid_until: string | null;
  vehicle_number: string | null;
  transport_mode: string | null;
  transport_distance_km: number | null;
  consignee_pincode: string | null;
  consignee_place: string | null;
  consignee_state: string | null;
  ship_to_place: string | null;
  dispatch_from_place: string | null;
  party_gstin: string | null;
  place_of_supply: string | null;
}

/**
 * Pull the e-way bill / delivery block off a voucher.
 *
 * Tally has always exported this; the sync just never read it. Verified
 * 2026-08-27 against a real Day Book export ("MKCP SALES 2526.json", FY25-26):
 * 603 of 1,432 vouchers carry an EWAYBILLDETAILS block, each with exactly one
 * TRANSPORTDETAILS child, and no voucher carries two different vehicles — so
 * the "last vehicle wins" rule below never actually has to arbitrate. It is
 * written that way anyway because Part-B can legitimately be updated mid-transit
 * (a breakdown, a transhipment), and if that ever appears in the data the LAST
 * update is the operative vehicle, not the first.
 *
 * Everything returns null when absent. Most vouchers — counter sales, receipts,
 * journals — have no e-way bill at all, and that is not an error condition.
 */
export function extractVoucherTransport(v: any): VoucherTransport {
  const ewb = listOf(v, "EWAYBILLDETAILS").find((e) => e && typeof e === "object");

  let vehicle: string | null = null;
  let mode: string | null = null;
  let distance: number | null = null;
  for (const td of listOf(ewb, "TRANSPORTDETAILS")) {
    if (!td || typeof td !== "object") continue;
    // Last non-empty value wins — see the Part-B note above.
    vehicle = txt(td.VEHICLENUMBER) || vehicle;
    mode = txt(td.TRANSPORTMODE) || mode;
    distance = num(td.DISTANCE) ?? distance;
  }

  const s = (x: any): string | null => txt(x) || null;

  return {
    ewb_number: s(ewb?.BILLNUMBER),
    ewb_valid_until: s(ewb?.VALIDUPTO),
    vehicle_number: vehicle || null,
    transport_mode: mode || null,
    transport_distance_km: distance,
    // Prefer the e-way bill's own consignee pincode (what was actually declared
    // to the portal) over the voucher header's, falling back when there is no
    // e-way bill but the party address still carries one.
    consignee_pincode: s(ewb?.CONSIGNEEPINCODE) ?? s(v.CONSIGNEEPINCODE) ?? s(v.PARTYPINCODE),
    consignee_place: s(ewb?.CONSIGNEEPLACE) ?? s(v.CONSIGNEEMAILINGNAME),
    consignee_state: s(v.CONSIGNEESTATENAME) ?? s(ewb?.SHIPPEDTOSTATE),
    ship_to_place: s(v.SHIPTOPLACE),
    dispatch_from_place: s(v.DISPATCHFROMPLACE),
    party_gstin: s(v.PARTYGSTIN),
    place_of_supply: s(v.PLACEOFSUPPLY),
  };
}

/** Walk multiple possible paths in the parsed XML to find the data */
function dig(obj: any, ...paths: string[][]): any {
  for (const path of paths) {
    let cur = obj;
    for (const key of path) {
      if (!cur || typeof cur !== "object") { cur = null; break; }
      cur = cur[key] ?? cur[key + ".LIST"];
    }
    if (cur != null) return cur;
  }
  return null;
}

export function convertStockGroups(parsed: any): { tallymessage: any[] } {
  const root = dig(parsed,
    ["ENVELOPE", "BODY", "DATA", "COLLECTION"],
    ["ENVELOPE", "BODY", "DATA", "TALLYMESSAGE"],
    ["ENVELOPE", "BODY", "DATA"],
    ["ENVELOPE", "BODY"],
  );

  const groups = arr(root?.STOCKGROUP ?? root?.["STOCKGROUP.LIST"]);
  console.log(`[convert] Stock groups: ${groups.length}`);

  return {
    tallymessage: groups.map((g: any) => {
      const name = g["@_NAME"] || txt(g.NAME);
      if (!name) return null;
      return {
        metadata: { type: "Stock Group", name },
        name,
        parent: txt(g.PARENT, "Primary"),
        isaddable: txt(g.ISADDABLE, "Yes"),
        guid: txt(g.GUID),
      };
    }).filter(Boolean),
  };
}

export function convertUnits(parsed: any): { tallymessage: any[] } {
  const root = dig(parsed,
    ["ENVELOPE", "BODY", "DATA", "COLLECTION"],
    ["ENVELOPE", "BODY", "DATA", "TALLYMESSAGE"],
    ["ENVELOPE", "BODY", "DATA"],
    ["ENVELOPE", "BODY"],
  );

  const units = arr(root?.UNIT ?? root?.["UNIT.LIST"]);
  console.log(`[convert] Units: ${units.length}`);

  return {
    tallymessage: units.map((u: any) => {
      const name = u["@_NAME"] || txt(u.NAME);
      if (!name) return null;
      return {
        metadata: { type: "Unit", name },
        name,
        originalname: txt(u.ORIGINALNAME, name),
        baseunits: txt(u.BASEUNITS),
        additionalunits: txt(u.ADDITIONALUNITS),
        conversion: txt(u.CONVERSION),
        issimpleunit: txt(u.ISSIMPLEUNIT, "No"),
        isformallycompound: txt(u.ISFORMALLYCOMPOUND, "No"),
        guid: txt(u.GUID),
      };
    }).filter(Boolean),
  };
}

export function convertGodowns(parsed: any): { tallymessage: any[] } {
  const root = dig(parsed,
    ["ENVELOPE", "BODY", "DATA", "COLLECTION"],
    ["ENVELOPE", "BODY", "DATA", "TALLYMESSAGE"],
    ["ENVELOPE", "BODY", "DATA"],
    ["ENVELOPE", "BODY"],
  );
  const godowns = arr(root?.GODOWN ?? root?.["GODOWN.LIST"]);
  console.log(`[convert] Godowns: ${godowns.length}`);
  return {
    tallymessage: godowns.map((g: any) => {
      const name = g["@_NAME"] || txt(g.NAME);
      if (!name) return null;
      return {
        metadata: { type: "Godown", name },
        name,
        parent: txt(g.PARENT, "Main Location"),
        hasnospace: txt(g.HASNOSPACE) === "Yes",
        guid: txt(g.GUID),
      };
    }).filter(Boolean),
  };
}

export function convertCostCentres(parsed: any): { tallymessage: any[] } {
  const root = dig(parsed,
    ["ENVELOPE", "BODY", "DATA", "COLLECTION"],
    ["ENVELOPE", "BODY", "DATA", "TALLYMESSAGE"],
    ["ENVELOPE", "BODY", "DATA"],
    ["ENVELOPE", "BODY"],
  );
  const centres = arr(root?.COSTCENTRE ?? root?.["COSTCENTRE.LIST"]);
  console.log(`[convert] Cost Centres: ${centres.length}`);
  return {
    tallymessage: centres.map((c: any) => {
      const name = c["@_NAME"] || txt(c.NAME);
      if (!name) return null;
      return {
        metadata: { type: "Cost Centre", name },
        name,
        parent: txt(c.PARENT),
        category: txt(c.CATEGORY),
        guid: txt(c.GUID),
      };
    }).filter(Boolean),
  };
}

export function convertStockItems(parsed: any): { tallymessage: any[] } {
  // Tally "All Stock Items" collection response:
  //   ENVELOPE.BODY.DATA.COLLECTION.STOCKITEM[]  or  ENVELOPE.BODY.DATA.TALLYMESSAGE.STOCKITEM[]
  const root = dig(parsed,
    ["ENVELOPE", "BODY", "DATA", "COLLECTION"],
    ["ENVELOPE", "BODY", "DATA", "TALLYMESSAGE"],
    ["ENVELOPE", "BODY", "DATA"],
    ["ENVELOPE", "BODY"],
  );

  const items = arr(root?.STOCKITEM ?? root?.["STOCKITEM.LIST"]);
  console.log(`[convert] Stock items: ${items.length}`);

  // Log sample stock item data for debugging
  if (items.length > 0) {
    const sample = items[0];
    console.log(`[convert] Sample stock item: name="${sample["@_NAME"] || txt(sample.NAME)}", parent="${txt(sample.PARENT)}", baseunits="${txt(sample.BASEUNITS)}", opening="${txt(sample.OPENINGBALANCE)}", closing="${txt(sample.CLOSINGBALANCE)}"`);
    // Count groups
    const groups = new Set(items.map((s: any) => txt(s.PARENT, "Primary")));
    console.log(`[convert] Stock groups found: ${groups.size} (${[...groups].slice(0, 10).join(", ")}${groups.size > 10 ? "..." : ""})`);
  }

  return {
    tallymessage: items.map((si: any) => {
      const name = si["@_NAME"] || txt(si.NAME);
      if (!name) return null;
      return {
        metadata: { type: "Stock Item", name },
        name,
        parent: txt(si.PARENT, "Primary"),
        category: txt(si.CATEGORY),
        baseunits: txt(si.BASEUNITS, "PC"),
        additionalunits: txt(si.ADDITIONALUNITS, "Not Applicable"),
        denominator: txt(si.DENOMINATOR, "1"),
        openingbalance: txt(si.OPENINGBALANCE, "0"),
        openingrate: txt(si.OPENINGRATE, "0"),
        openingvalue: txt(si.OPENINGVALUE, "0"),
        closingbalance: txt(si.CLOSINGBALANCE, "0"),
        closingrate: txt(si.CLOSINGRATE, "0"),
        closingvalue: txt(si.CLOSINGVALUE, "0"),
        gstapplicable: txt(si.GSTAPPLICABLE),
        gsttypeofsupply: txt(si.GSTTYPEOFSUPPLY),
        costingmethod: txt(si.COSTINGMETHOD),
        valuationmethod: txt(si.VALUATIONMETHOD),
        isbatchwiseon: txt(si.ISBATCHWISEON) === "Yes",
        iscostcentreson: txt(si.ISCOSTCENTRESON) === "Yes",
        gstdetails: arr(si.GSTDETAILS ?? si["GSTDETAILS.LIST"]).map((g: any) => ({
          statewisedetails: arr(g?.STATEWISEDETAILS ?? g?.["STATEWISEDETAILS.LIST"]).map((s: any) => ({
            ratedetails: arr(s?.RATEDETAILS ?? s?.["RATEDETAILS.LIST"]).map((r: any) => ({
              gstratedutyhead: txt(r.GSTRATEDUTYHEAD),
              gstrate: txt(r.GSTRATE, "0"),
            })),
          })),
        })),
        hsndetails: arr(si.HSNDETAILS ?? si["HSNDETAILS.LIST"]).map((h: any) => ({
          hsncode: txt(h.HSNCODE) || txt(h.DESCRIPTION),
        })),
        guid: txt(si.GUID),
      };
    }).filter(Boolean),
  };
}

export function convertLedgers(parsed: any): { tallymessage: any[] } {
  // "List of Ledgers" collection response:
  //   ENVELOPE.BODY.DATA.COLLECTION.LEDGER[]  or  ENVELOPE.BODY.DATA.TALLYMESSAGE.LEDGER[]
  const root = dig(parsed,
    ["ENVELOPE", "BODY", "DATA", "COLLECTION"],
    ["ENVELOPE", "BODY", "DATA", "TALLYMESSAGE"],
    ["ENVELOPE", "BODY", "DATA"],
    ["ENVELOPE", "BODY"],
  );

  const ledgers = arr(root?.LEDGER ?? root?.["LEDGER.LIST"]);
  console.log(`[convert] Ledgers: ${ledgers.length}`);

  return {
    tallymessage: ledgers.map((l: any) => {
      const name = l["@_NAME"] || txt(l.NAME);
      if (!name) return null;
      return {
        metadata: { type: "Ledger", name },
        name,
        parent: txt(l.PARENT, "Unsorted"),
        openingbalance: txt(l.OPENINGBALANCE, "0"),
        gstin: txt(l.PARTYGSTIN) || txt(l.GSTIN) || txt(l.LEDGSTIN),
        creditperiod: txt(l.CREDITPERIOD) || txt(l.BILLCREDITPERIOD),
        guid: txt(l.GUID),
      };
    }).filter(Boolean),
  };
}

export function convertVouchers(parsed: any): { tallymessage: any[] } {
  // "Day Book" response structure:
  //   ENVELOPE.BODY.DATA.TALLYMESSAGE[] (array of messages, each containing VOUCHERs)
  const data = parsed?.ENVELOPE?.BODY?.DATA;
  if (!data) {
    console.log(`[convert] Vouchers: 0 (no DATA node)`);
    return { tallymessage: [] };
  }

  // TALLYMESSAGE can be an array (multiple messages) or single object
  let messages = arr(data.TALLYMESSAGE);

  // Fallback: Collection export returns COLLECTION.VOUCHER[] instead of TALLYMESSAGE[]
  if (messages.length === 0 && data.COLLECTION) {
    const collVouchers = arr(data.COLLECTION?.VOUCHER ?? data.COLLECTION?.["VOUCHER.LIST"]);
    if (collVouchers.length > 0) {
      console.log(`[convert] Found ${collVouchers.length} vouchers via COLLECTION path`);
      messages = [{ VOUCHER: collVouchers }];
    }
  }

  console.log(`[convert] Found ${messages.length} TALLYMESSAGE nodes`);

  // Collect all vouchers from all TALLYMESSAGE nodes
  const allVouchers: any[] = [];
  for (const msg of messages) {
    const vouchers = arr(msg?.VOUCHER ?? msg?.["VOUCHER.LIST"]);
    if (vouchers.length > 0) {
      allVouchers.push(...vouchers);
    } else if (msg && (msg.VOUCHERTYPENAME || msg.DATE || msg["@_VCHTYPE"])) {
      // Flat structure: the TALLYMESSAGE node IS the voucher directly
      allVouchers.push(msg);
    }
  }

  console.log(`[convert] Vouchers: ${allVouchers.length}`);

  // Log voucher date distribution for debugging
  if (allVouchers.length > 0) {
    const dateCounts: Record<string, number> = {};
    const typeCounts: Record<string, number> = {};
    for (const v of allVouchers) {
      const d = txt(v.DATE) || txt(v["@_DATE"]) || "unknown";
      const t = txt(v.VOUCHERTYPENAME) || txt(v["@_VCHTYPE"]) || "unknown";
      dateCounts[d] = (dateCounts[d] || 0) + 1;
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
    const dates = Object.entries(dateCounts).sort((a, b) => a[0].localeCompare(b[0]));
    console.log(`[convert] Voucher dates: ${dates.map(([d, c]) => `${d}(${c})`).join(", ")}`);
    console.log(`[convert] Voucher types: ${Object.entries(typeCounts).map(([t, c]) => `${t}: ${c}`).join(", ")}`);

    // Transport coverage. Logged because the failure mode here is SILENT: if a
    // Tally build or export path stops emitting EWAYBILLDETAILS, every field
    // just becomes null and the sync still reports success. A zero here means
    // the block is missing, not that no goods moved.
    let withEwb = 0, withVehicle = 0, withDistance = 0;
    for (const v of allVouchers) {
      const t = extractVoucherTransport(v);
      if (t.ewb_number) withEwb++;
      if (t.vehicle_number) withVehicle++;
      if (t.transport_distance_km != null) withDistance++;
    }
    console.log(`[convert] Transport: ${withEwb} e-way bills, ${withVehicle} vehicles, ${withDistance} distances (of ${allVouchers.length} vouchers)`);
  }

  return {
    tallymessage: allVouchers.map((v: any) => {
      // Use length-aware fallback: [] is not nullish, so ?? won't fall through.
      // ALLLEDGERENTRIES.LIST is used by Receipt/Payment/Journal vouchers,
      // LEDGERENTRIES.LIST is used by Sales/Purchase vouchers with inventory.
      const allLE = arr(v["ALLLEDGERENTRIES.LIST"] ?? v.ALLLEDGERENTRIES);
      const simpleLE = arr(v["LEDGERENTRIES.LIST"] ?? v.LEDGERENTRIES);
      const le = allLE.length > 0 ? allLE : simpleLE;

      const allIE = arr(v["ALLINVENTORYENTRIES.LIST"] ?? v.ALLINVENTORYENTRIES);
      const simpleIE = arr(v["INVENTORYENTRIES.LIST"] ?? v.INVENTORYENTRIES);
      const ie = allIE.length > 0 ? allIE : simpleIE;

      // Voucher-level party name — the authoritative source for party identification.
      // Individual ledger entries may BOTH have ISPARTYLEDGER=Yes (e.g. party + bank
      // in Receipt/Payment vouchers), so we use PARTYLEDGERNAME to disambiguate.
      // Use txt() for all field reads — Collection API returns typed Tally objects
      // (e.g. { "#text": "...", "@_TYPE": "String" }) not plain strings.
      const voucherPartyName = txt(v.PARTYLEDGERNAME).trim().toUpperCase();

      // Check if voucher party name matches any ledger entry name
      const hasNameMatch = voucherPartyName && le.some((e: any) =>
        txt(e.LEDGERNAME).trim().toUpperCase() === voucherPartyName
      );

      const ledgerentries = le.map((e: any, idx: number) => {
        const ledgername = txt(e.LEDGERNAME);
        const tallyIsParty = txt(e.ISPARTYLEDGER) === "Yes";

        let ispartyledger: boolean;
        if (hasNameMatch) {
          // Match by voucher-level PARTYLEDGERNAME — only the matching entry is the party line
          ispartyledger = ledgername.trim().toUpperCase() === voucherPartyName;
        } else if (voucherPartyName) {
          // PARTYLEDGERNAME set but no exact match — use first Tally-flagged entry only
          const firstFlaggedIdx = le.findIndex((x: any) => txt(x.ISPARTYLEDGER) === "Yes");
          ispartyledger = tallyIsParty && idx === firstFlaggedIdx;
        } else {
          // No voucher-level party: fall back to Tally's flag as-is
          ispartyledger = tallyIsParty;
        }

        return {
          ledgername,
          isdeemedpositive: txt(e.ISDEEMEDPOSITIVE) === "Yes",
          ispartyledger,
          amount: txt(e.AMOUNT, "0"),
          billallocations: arr(e["BILLALLOCATIONS.LIST"] ?? e.BILLALLOCATIONS).map((b: any) => ({
            name: txt(b.NAME),
            billtype: txt(b.BILLTYPE, "New Ref"),
            amount: txt(b.AMOUNT, "0"),
          })),
        };
      });

      const inventoryentries = ie.map((e: any) => ({
        stockitemname: txt(e.STOCKITEMNAME),
        actualqty: txt(e.ACTUALQTY) || txt(e.BILLEDQTY, "0"),
        billedqty: txt(e.BILLEDQTY) || txt(e.ACTUALQTY, "0"),
        rate: txt(e.RATE, "0"),
        amount: txt(e.AMOUNT, "0"),
        isdeemedpositive: txt(e.ISDEEMEDPOSITIVE) === "Yes",
      }));

      return {
        metadata: { type: "Voucher" },
        date: txt(v.DATE) || txt(v["@_DATE"]),
        guid: txt(v.GUID) || txt(v["@_GUID"]),
        vouchernumber: txt(v.VOUCHERNUMBER) || txt(v.REFERENCE),
        reference: txt(v.REFERENCE),
        vouchertypename: txt(v.VOUCHERTYPENAME) || txt(v["@_VCHTYPE"]),
        partyledgername: txt(v.PARTYLEDGERNAME),
        narration: txt(v.NARRATION),
        // Tally's monotonic alteration id — bumps whenever this voucher is edited.
        // Drives incremental "re-pull anything changed" sync (any date), so edits
        // to old vouchers propagate. 0 when Tally omits it (older builds).
        alterid: parseInt(txt(v.ALTERID) || txt(v["@_ALTERID"]) || "0", 10) || 0,
        // E-way bill / delivery block. Always present in the export, dropped by
        // this converter until 2026-08-27 — see extractVoucherTransport.
        transport: extractVoucherTransport(v),
        iscancelled: txt(v.ISCANCELLED) === "Yes",
        isoptional: txt(v.ISOPTIONAL) === "Yes",
        effectivedate: txt(v.EFFECTIVEDATE) || txt(v.DATE),
        allledgerentries: ledgerentries,
        ledgerentries: ledgerentries,
        allinventoryentries: inventoryentries,
        inventoryentries: inventoryentries,
      };
    }),
  };
}

export function convertCompanies(parsed: any): any[] {
  const root = dig(parsed,
    ["ENVELOPE", "BODY", "DATA", "COLLECTION"],
    ["ENVELOPE", "BODY", "DATA", "TALLYMESSAGE"],
    ["ENVELOPE", "BODY", "DATA"],
  );
  return arr(root?.COMPANY ?? root?.["COMPANY.LIST"]).map((c: any) => ({
    name: c["@_NAME"] || c.NAME || "",
    startDate: c.STARTINGFROM || "",
    endDate: c.ENDINGAT || "",
  }));
}

