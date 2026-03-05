import { Router } from "express";
import {
  postToTally,
  buildStockItemsRequestXml,
  buildLedgersRequestXml,
  stockItemsXmlToTallyJson,
  ledgersXmlToTallyJson,
} from "../tallyXml.js";

export const mastersRouter = Router();

// GET /api/tally/masters?company=MK+CYCLES
mastersRouter.get("/masters", async (req, res) => {
  try {
    const company = String(req.query.company || "");
    if (!company) return res.status(400).json({ success: false, error: "company query param required" });

    // Fetch stock items and ledgers in parallel
    const [stockXml, ledgerXml] = await Promise.all([
      postToTally(req.tallyUrl, buildStockItemsRequestXml(company)),
      postToTally(req.tallyUrl, buildLedgersRequestXml(company)),
    ]);

    const stockJson = stockItemsXmlToTallyJson(stockXml);
    const ledgerJson = ledgersXmlToTallyJson(ledgerXml);

    // Merge into single tallymessage array (same format as Master.json)
    const combined = {
      tallymessage: [
        { metadata: { type: "Company", name: company }, name: company, fystart: 4 },
        ...stockJson.tallymessage,
        ...ledgerJson.tallymessage,
      ],
    };

    res.json({ success: true, data: combined });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Individual endpoints for partial refresh
mastersRouter.get("/stock-items", async (req, res) => {
  try {
    const company = String(req.query.company || "");
    if (!company) return res.status(400).json({ success: false, error: "company required" });
    const xml = await postToTally(req.tallyUrl, buildStockItemsRequestXml(company));
    res.json({ success: true, data: stockItemsXmlToTallyJson(xml) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

mastersRouter.get("/ledgers", async (req, res) => {
  try {
    const company = String(req.query.company || "");
    if (!company) return res.status(400).json({ success: false, error: "company required" });
    const xml = await postToTally(req.tallyUrl, buildLedgersRequestXml(company));
    res.json({ success: true, data: ledgersXmlToTallyJson(xml) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});
