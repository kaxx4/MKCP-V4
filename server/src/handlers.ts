import type { Request, Response } from "express";
import {
  postToTally, HEALTH_XML, COMPANY_XML,
  stockItemsXml, ledgersXml, vouchersXml,
  convertStockItems, convertLedgers, convertVouchers, convertCompanies,
} from "./tally.js";

export async function healthHandler(req: Request, res: Response) {
  try {
    await postToTally(req.tallyUrl, HEALTH_XML);
    res.json({ connected: true, tallyUrl: req.tallyUrl });
  } catch (e: any) {
    res.json({ connected: false, error: e.message, tallyUrl: req.tallyUrl });
  }
}

export async function companyHandler(req: Request, res: Response) {
  try {
    const parsed = await postToTally(req.tallyUrl, COMPANY_XML);
    const companies = convertCompanies(parsed);
    res.json({ success: true, data: companies });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
}

export async function mastersHandler(req: Request, res: Response) {
  try {
    const company = String(req.query.company || "");
    if (!company) return res.status(400).json({ success: false, error: "?company= required" });

    const [stockParsed, ledgerParsed] = await Promise.all([
      postToTally(req.tallyUrl, stockItemsXml(company)),
      postToTally(req.tallyUrl, ledgersXml(company)),
    ]);

    const stocks = convertStockItems(stockParsed);
    const ledgers = convertLedgers(ledgerParsed);

    const combined = {
      tallymessage: [
        { metadata: { type: "Company", name: company }, name: company, fystart: 4 },
        ...stocks.tallymessage,
        ...ledgers.tallymessage,
      ],
    };
    res.json({ success: true, data: combined });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
}

export async function vouchersHandler(req: Request, res: Response) {
  try {
    const company = String(req.query.company || "");
    if (!company) return res.status(400).json({ success: false, error: "?company= required" });
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;

    const parsed = await postToTally(req.tallyUrl, vouchersXml(company, from, to));
    const result = convertVouchers(parsed);
    res.json({ success: true, data: result, count: result.tallymessage.length });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
}

export async function syncHandler(req: Request, res: Response) {
  try {
    const { company, fromDate, toDate } = req.body;
    if (!company) return res.status(400).json({ success: false, error: "company required" });

    console.log(`\n${"═".repeat(50)}`);
    console.log(`SYNC: "${company}" | ${fromDate || "all"} → ${toDate || "all"}`);
    console.log(`${"═".repeat(50)}`);
    const t0 = Date.now();

    // Fetch everything in parallel — blazing fast
    const [stockParsed, ledgerParsed, voucherParsed] = await Promise.all([
      postToTally(req.tallyUrl, stockItemsXml(company)).catch(e => { console.error("Stock fetch failed:", e.message); return null; }),
      postToTally(req.tallyUrl, ledgersXml(company)).catch(e => { console.error("Ledger fetch failed:", e.message); return null; }),
      postToTally(req.tallyUrl, vouchersXml(company, fromDate, toDate)).catch(e => { console.error("Voucher fetch failed:", e.message); return null; }),
    ]);

    const stocks = stockParsed ? convertStockItems(stockParsed) : { tallymessage: [] };
    const ledgers = ledgerParsed ? convertLedgers(ledgerParsed) : { tallymessage: [] };
    const vouchers = voucherParsed ? convertVouchers(voucherParsed) : { tallymessage: [] };

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const stats = {
      stockItems: stocks.tallymessage.length,
      ledgers: ledgers.tallymessage.length,
      vouchers: vouchers.tallymessage.length,
      elapsedSeconds: parseFloat(elapsed),
    };

    console.log(`SYNC DONE: ${stats.stockItems} items, ${stats.ledgers} ledgers, ${stats.vouchers} vouchers in ${elapsed}s\n`);

    if (stats.stockItems === 0 && stats.ledgers === 0 && stats.vouchers === 0) {
      return res.json({
        success: false,
        error: "Tally returned zero data. Check: (1) Company name matches EXACTLY (2) Company is loaded in TallyPrime (3) FY dates are within company period",
        stats,
        masters: { tallymessage: [{ metadata: { type: "Company", name: company }, name: company, fystart: 4 }] },
        transactions: { tallymessage: [] },
      });
    }

    res.json({
      success: true,
      masters: {
        tallymessage: [
          { metadata: { type: "Company", name: company }, name: company, fystart: 4 },
          ...stocks.tallymessage,
          ...ledgers.tallymessage,
        ],
      },
      transactions: vouchers,
      stats,
    });
  } catch (e: any) {
    console.error("SYNC FATAL:", e);
    res.status(500).json({ success: false, error: e.message });
  }
}

/** Debug endpoint — sends raw XML and shows raw response + parsed structure */
export async function debugHandler(req: Request, res: Response) {
  try {
    const { xml, company, test } = req.body;

    // Quick test mode: test = "stock" | "ledger" | "voucher"
    let xmlToSend = xml;
    if (!xmlToSend && company && test) {
      if (test === "stock") xmlToSend = stockItemsXml(company);
      else if (test === "ledger") xmlToSend = ledgersXml(company);
      else if (test === "voucher") xmlToSend = vouchersXml(company);
      else if (test === "health") xmlToSend = HEALTH_XML;
    }
    if (!xmlToSend) return res.status(400).json({ error: "Provide {xml} or {company, test}" });

    console.log("[debug] Sending XML:", xmlToSend.slice(0, 200));

    const rawRes = await fetch(req.tallyUrl, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8" },
      body: xmlToSend,
      signal: AbortSignal.timeout(30_000),
    });
    const rawText = await rawRes.text();

    res.json({
      status: rawRes.status,
      responseLength: rawText.length,
      responseFirst2000: rawText.slice(0, 2000),
      xmlSent: xmlToSend.slice(0, 500),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}
