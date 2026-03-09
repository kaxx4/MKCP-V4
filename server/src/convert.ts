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
  const messages = arr(data.TALLYMESSAGE);
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
      const d = v.DATE || v["@_DATE"] || "unknown";
      const t = v.VOUCHERTYPENAME || v["@_VCHTYPE"] || "unknown";
      dateCounts[d] = (dateCounts[d] || 0) + 1;
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
    const dates = Object.entries(dateCounts).sort((a, b) => a[0].localeCompare(b[0]));
    console.log(`[convert] Voucher dates: ${dates.map(([d, c]) => `${d}(${c})`).join(", ")}`);
    console.log(`[convert] Voucher types: ${Object.entries(typeCounts).map(([t, c]) => `${t}: ${c}`).join(", ")}`);
  }

  return {
    tallymessage: allVouchers.map((v: any) => {
      const le = arr(v["ALLLEDGERENTRIES.LIST"] ?? v.ALLLEDGERENTRIES ?? v["LEDGERENTRIES.LIST"] ?? v.LEDGERENTRIES);
      const ie = arr(v["ALLINVENTORYENTRIES.LIST"] ?? v.ALLINVENTORYENTRIES ?? v["INVENTORYENTRIES.LIST"] ?? v.INVENTORYENTRIES);

      const ledgerentries = le.map((e: any) => ({
        ledgername: e.LEDGERNAME || "",
        isdeemedpositive: e.ISDEEMEDPOSITIVE === "Yes",
        ispartyledger: e.ISPARTYLEDGER === "Yes",
        amount: e.AMOUNT || "0",
        billallocations: arr(e["BILLALLOCATIONS.LIST"] ?? e.BILLALLOCATIONS).map((b: any) => ({
          name: b.NAME || "",
          billtype: b.BILLTYPE || "New Ref",
          amount: b.AMOUNT || "0",
        })),
      }));

      const inventoryentries = ie.map((e: any) => ({
        stockitemname: e.STOCKITEMNAME || "",
        actualqty: e.ACTUALQTY || e.BILLEDQTY || "0",
        billedqty: e.BILLEDQTY || e.ACTUALQTY || "0",
        rate: e.RATE || "0",
        amount: e.AMOUNT || "0",
        isdeemedpositive: e.ISDEEMEDPOSITIVE === "Yes",
      }));

      return {
        metadata: { type: "Voucher" },
        date: v.DATE || v["@_DATE"] || "",
        guid: v.GUID || v["@_GUID"] || "",
        vouchernumber: v.VOUCHERNUMBER || v.REFERENCE || "",
        vouchertypename: v.VOUCHERTYPENAME || v["@_VCHTYPE"] || "",
        partyledgername: v.PARTYLEDGERNAME || "",
        narration: v.NARRATION || "",
        iscancelled: v.ISCANCELLED === "Yes",
        isoptional: v.ISOPTIONAL === "Yes",
        effectivedate: v.EFFECTIVEDATE || v.DATE || "",
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
