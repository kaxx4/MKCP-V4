import { Router } from "express";
import {
  postToTally,
  buildStockItemsRequestXml,
  buildLedgersRequestXml,
  buildVouchersRequestXml,
  stockItemsXmlToTallyJson,
  ledgersXmlToTallyJson,
  vouchersXmlToTallyJson,
  buildCompanyRequestXml,
  companyXmlToTallyJson,
} from "../tallyXml.js";

export const syncRouter = Router();

// POST /api/tally/sync – pulls EVERYTHING in one call
syncRouter.post("/sync", async (req, res) => {
  try {
    const { company, fromDate, toDate } = req.body;
    if (!company) return res.status(400).json({ success: false, error: "company required in body" });

    console.log(`[sync] Starting full sync for "${company}"...`);
    const t0 = Date.now();

    // 1. Fetch company info
    const companyXml = await postToTally(req.tallyUrl, buildCompanyRequestXml());
    const companyInfo = companyXmlToTallyJson(companyXml);
    console.log(`[sync] Company info fetched`);

    // 2. Fetch masters (parallel)
    const [stockXml, ledgerXml] = await Promise.all([
      postToTally(req.tallyUrl, buildStockItemsRequestXml(company)),
      postToTally(req.tallyUrl, buildLedgersRequestXml(company)),
    ]);
    const stockJson = stockItemsXmlToTallyJson(stockXml);
    const ledgerJson = ledgersXmlToTallyJson(ledgerXml);
    console.log(`[sync] Masters: ${stockJson.tallymessage.length} items, ${ledgerJson.tallymessage.length} ledgers`);

    // 3. Fetch ALL vouchers
    const voucherXml = await postToTally(
      req.tallyUrl,
      buildVouchersRequestXml(company, fromDate, toDate)
    );
    const voucherJson = vouchersXmlToTallyJson(voucherXml);
    console.log(`[sync] Vouchers: ${voucherJson.tallymessage.length}`);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[sync] Full sync complete in ${elapsed}s`);

    // Return masters and transactions as SEPARATE objects
    // (matching the two-file structure the frontend expects)
    const mastersJson = {
      tallymessage: [
        {
          metadata: { type: "Company", name: company },
          name: companyInfo?.name || company,
          gstin: companyInfo?.gstin || "",
          fystart: companyInfo?.fystart || 4,
        },
        ...stockJson.tallymessage,
        ...ledgerJson.tallymessage,
      ],
    };

    res.json({
      success: true,
      masters: mastersJson,
      transactions: voucherJson,
      stats: {
        stockItems: stockJson.tallymessage.length,
        ledgers: ledgerJson.tallymessage.length,
        vouchers: voucherJson.tallymessage.length,
        elapsedSeconds: parseFloat(elapsed),
      },
    });
  } catch (err: any) {
    console.error(`[sync] FAILED:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
