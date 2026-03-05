import { Router } from "express";
import {
  postToTally,
  buildVouchersRequestXml,
  buildVouchersByTypeXml,
  vouchersXmlToTallyJson,
} from "../tallyXml.js";

export const vouchersRouter = Router();

// GET /api/tally/vouchers?company=MK+CYCLES&from=20240401&to=20250331
vouchersRouter.get("/vouchers", async (req, res) => {
  try {
    const company = String(req.query.company || "");
    if (!company) return res.status(400).json({ success: false, error: "company required" });

    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;

    const xml = await postToTally(req.tallyUrl, buildVouchersRequestXml(company, from, to));
    const json = vouchersXmlToTallyJson(xml);

    res.json({ success: true, data: json, count: json.tallymessage.length });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/tally/vouchers/:type?company=...
vouchersRouter.get("/vouchers/:type", async (req, res) => {
  try {
    const company = String(req.query.company || "");
    if (!company) return res.status(400).json({ success: false, error: "company required" });

    const voucherType = req.params.type; // "sales", "purchase", etc.
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;

    const xml = await postToTally(req.tallyUrl, buildVouchersByTypeXml(company, voucherType, from, to));
    const json = vouchersXmlToTallyJson(xml);

    res.json({ success: true, data: json, count: json.tallymessage.length });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});
