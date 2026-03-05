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

  return {
    tallymessage: items.map((si: any) => {
      const name = si["@_NAME"] || si.NAME || "";
      if (!name) return null;
      return {
        metadata: { type: "Stock Item", name },
        name,
        parent: si.PARENT || "Primary",
        baseunits: si.BASEUNITS || "PC",
        additionalunits: si.ADDITIONALUNITS || " Not Applicable",
        denominator: si.DENOMINATOR || "1",
        openingbalance: si.OPENINGBALANCE || "0",
        openingrate: si.OPENINGRATE || "0",
        openingvalue: si.OPENINGVALUE || "0",
        gstapplicable: si.GSTAPPLICABLE || "",
        gsttypeofsupply: si.GSTTYPEOFSUPPLY || "",
        costingmethod: si.COSTINGMETHOD || "",
        valuationmethod: si.VALUATIONMETHOD || "",
        isbatchwiseon: si.ISBATCHWISEON === "Yes",
        iscostcentreson: si.ISCOSTCENTRESON === "Yes",
        gstdetails: arr(si.GSTDETAILS ?? si["GSTDETAILS.LIST"]).map((g: any) => ({
          statewisedetails: arr(g?.STATEWISEDETAILS ?? g?.["STATEWISEDETAILS.LIST"]).map((s: any) => ({
            ratedetails: arr(s?.RATEDETAILS ?? s?.["RATEDETAILS.LIST"]).map((r: any) => ({
              gstratedutyhead: r.GSTRATEDUTYHEAD || "",
              gstrate: r.GSTRATE || "0",
            })),
          })),
        })),
        hsndetails: arr(si.HSNDETAILS ?? si["HSNDETAILS.LIST"]).map((h: any) => ({
          hsncode: h.HSNCODE || h.DESCRIPTION || "",
        })),
        guid: si.GUID || "",
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
      const name = l["@_NAME"] || l.NAME || "";
      if (!name) return null;
      return {
        metadata: { type: "Ledger", name },
        name,
        parent: l.PARENT || "Unsorted",
        openingbalance: l.OPENINGBALANCE || "0",
        gstin: l.PARTYGSTIN || l.GSTIN || l.LEDGSTIN || "",
        creditperiod: l.CREDITPERIOD || l.BILLCREDITPERIOD || "",
        guid: l.GUID || "",
      };
    }).filter(Boolean),
  };
}

export function convertVouchers(parsed: any): { tallymessage: any[] } {
  // "Day Book" response:
  //   ENVELOPE.BODY.DATA.TALLYMESSAGE.VOUCHER[]
  const root = dig(parsed,
    ["ENVELOPE", "BODY", "DATA", "TALLYMESSAGE"],
    ["ENVELOPE", "BODY", "DATA"],
    ["ENVELOPE", "BODY", "TALLYMESSAGE"],
    ["ENVELOPE", "BODY"],
  );

  const vouchers = arr(root?.VOUCHER ?? root?.["VOUCHER.LIST"]);
  console.log(`[convert] Vouchers: ${vouchers.length}`);

  return {
    tallymessage: vouchers.map((v: any) => {
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
        vouchertypename: v.VOUCHERTYPENAME || "",
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
