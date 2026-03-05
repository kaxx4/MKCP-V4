import { Router } from "express";
import { postToTally } from "../tallyXml.js";
import axios from "axios";

export const debugRouter = Router();

// POST /api/tally/debug/raw – send raw XML and see raw response
debugRouter.post("/debug/raw", async (req, res) => {
  try {
    const { xml } = req.body;
    if (!xml) return res.status(400).json({ error: "xml required in body" });

    const response = await axios.post(req.tallyUrl, xml, {
      headers: { "Content-Type": "text/xml; charset=utf-8" },
      timeout: 30000,
      responseType: "text",
    });

    res.json({
      status: response.status,
      rawXml: response.data.slice(0, 50000),
      length: response.data.length,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tally/debug/test-stock?company=... – test stock items fetch
debugRouter.get("/debug/test-stock", async (req, res) => {
  try {
    const company = String(req.query.company || "");
    if (!company) return res.status(400).json({ error: "company required" });

    // Import the builder
    const { buildStockItemsRequestXml, stockItemsXmlToTallyJson } = await import("../tallyXml.js");

    const xml = buildStockItemsRequestXml(company);
    console.log("[debug] Stock items request XML:", xml);

    const rawResponse = await axios.post(req.tallyUrl, xml, {
      headers: { "Content-Type": "text/xml; charset=utf-8" },
      timeout: 30000,
      responseType: "text",
    });

    const { XMLParser } = await import("fast-xml-parser");
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      parseTagValue: true,
      trimValues: true,
    });
    const parsed = parser.parse(rawResponse.data);

    // Show the full parsed structure for debugging
    const paths = {
      "ENVELOPE": !!parsed?.ENVELOPE,
      "ENVELOPE.BODY": !!parsed?.ENVELOPE?.BODY,
      "ENVELOPE.BODY.DATA": !!parsed?.ENVELOPE?.BODY?.DATA,
      "ENVELOPE.BODY.DATA.TALLYMESSAGE": !!parsed?.ENVELOPE?.BODY?.DATA?.TALLYMESSAGE,
      "ENVELOPE.BODY.DATA.COLLECTION": !!parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION,
      "ENVELOPE.BODY.COLLECTION": !!parsed?.ENVELOPE?.BODY?.COLLECTION,
    };

    // Try to find stock items at various paths
    const tallyMsg = parsed?.ENVELOPE?.BODY?.DATA?.TALLYMESSAGE;
    let stockItemCount = 0;
    if (tallyMsg) {
      const items = Array.isArray(tallyMsg.STOCKITEM) ? tallyMsg.STOCKITEM :
                    tallyMsg.STOCKITEM ? [tallyMsg.STOCKITEM] : [];
      stockItemCount = items.length;
    }

    res.json({
      rawXmlLength: rawResponse.data.length,
      rawXmlFirst1000: rawResponse.data.slice(0, 1000),
      parsedPaths: paths,
      stockItemsFound: stockItemCount,
      tallyMessageKeys: tallyMsg ? Object.keys(tallyMsg) : [],
      firstStockItem: tallyMsg?.STOCKITEM?.[0] || tallyMsg?.STOCKITEM || null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});
