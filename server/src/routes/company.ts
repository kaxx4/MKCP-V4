import { Router } from "express";
import { postToTally, buildCompanyRequestXml, companyXmlToTallyJson } from "../tallyXml.js";

export const companyRouter = Router();

companyRouter.get("/company", async (req, res) => {
  try {
    // For now, return a success response
    // Company name should be provided by user in the frontend
    // We can't reliably auto-detect it due to Tally XML variations
    res.json({
      success: true,
      data: {
        name: req.query.company || "Unknown",
        message: "Please enter company name manually in the Import page"
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});
