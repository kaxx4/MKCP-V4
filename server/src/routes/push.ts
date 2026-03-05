import { Router } from "express";
import { postToTally, buildCreateVoucherXml } from "../tallyXml.js";

export const pushRouter = Router();

// POST /api/tally/push/voucher – create a voucher in Tally
pushRouter.post("/push/voucher", async (req, res) => {
  try {
    const { company, voucherXml } = req.body;
    if (!company || !voucherXml) {
      return res.status(400).json({ success: false, error: "company and voucherXml required" });
    }
    const xml = buildCreateVoucherXml(company, voucherXml);
    const result = await postToTally(req.tallyUrl, xml);
    res.json({ success: true, result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});
