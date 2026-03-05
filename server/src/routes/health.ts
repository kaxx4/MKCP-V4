import { Router } from "express";
import axios from "axios";

export const healthRouter = Router();

// Quick ping – does Tally respond at all?
healthRouter.get("/health", async (req, res) => {
  try {
    const response = await axios.post(
      req.tallyUrl,
      `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>List of Companies</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>`,
      { headers: { "Content-Type": "text/xml" }, timeout: 5000 }
    );
    res.json({
      connected: true,
      status: response.status,
      tallyUrl: req.tallyUrl,
    });
  } catch (err: any) {
    res.json({
      connected: false,
      error: err.message,
      tallyUrl: req.tallyUrl,
    });
  }
});
