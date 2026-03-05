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

syncRouter.post("/sync", async (req, res) => {
  try {
    const { company, fromDate, toDate } = req.body;
    if (!company) return res.status(400).json({ success: false, error: "company required in body" });

    console.log(`\n${"=".repeat(60)}`);
    console.log(`[sync] Starting full sync for "${company}"`);
    console.log(`[sync] Date range: ${fromDate || "none"} to ${toDate || "none"}`);
    console.log(`${"=".repeat(60)}`);
    const t0 = Date.now();
    const errors: string[] = [];

    // 1. Company info (non-critical – use provided name as fallback)
    let companyInfo: any = null;
    try {
      const companyXml = await postToTally(req.tallyUrl, buildCompanyRequestXml());
      companyInfo = companyXmlToTallyJson(companyXml);
      console.log(`[sync] Company info: ${companyInfo?.name || "not found"}`);
    } catch (err: any) {
      console.warn(`[sync] Company info fetch failed (non-critical): ${err.message}`);
      errors.push(`Company info: ${err.message}`);
    }

    // 2. Masters (parallel)
    let stockJson = { tallymessage: [] as any[] };
    let ledgerJson = { tallymessage: [] as any[] };
    try {
      console.log(`[sync] Fetching masters...`);
      const [sXml, lXml] = await Promise.all([
        postToTally(req.tallyUrl, buildStockItemsRequestXml(company)),
        postToTally(req.tallyUrl, buildLedgersRequestXml(company)),
      ]);
      stockJson = stockItemsXmlToTallyJson(sXml);
      ledgerJson = ledgersXmlToTallyJson(lXml);
      console.log(`[sync] Masters: ${stockJson.tallymessage.length} items, ${ledgerJson.tallymessage.length} ledgers`);
    } catch (err: any) {
      console.error(`[sync] Masters fetch FAILED: ${err.message}`);
      errors.push(`Masters: ${err.message}`);
    }

    // 3. Vouchers
    let voucherJson = { tallymessage: [] as any[] };
    try {
      console.log(`[sync] Fetching vouchers...`);
      const vXml = await postToTally(req.tallyUrl, buildVouchersRequestXml(company, fromDate, toDate));
      voucherJson = vouchersXmlToTallyJson(vXml);
      console.log(`[sync] Vouchers: ${voucherJson.tallymessage.length}`);
    } catch (err: any) {
      console.error(`[sync] Vouchers fetch FAILED: ${err.message}`);
      errors.push(`Vouchers: ${err.message}`);
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const totalRecords = stockJson.tallymessage.length + ledgerJson.tallymessage.length + voucherJson.tallymessage.length;
    console.log(`[sync] Complete in ${elapsed}s – ${totalRecords} total records, ${errors.length} errors`);

    // Build response
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
      success: totalRecords > 0,
      errors: errors.length > 0 ? errors : undefined,
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
    console.error(`[sync] FATAL ERROR:`, err);
    res.status(500).json({ success: false, error: err.message });
  }
});
